// 📼 HLS (.m3u8) — o formato que a maioria dos sites usa para servir vídeo.
//
// Sem isso o bot tinha dois buracos reais:
//   1. Links `.m3u8` (Twitch VOD, Bluesky, SoundCloud, jornais, cursos…) eram
//      baixados como se fossem um arquivo — o usuário recebia a PLAYLIST de
//      texto nomeada como vídeo.
//   2. Plataformas que só publicam HLS caiam direto no Cobalt, sem plano B.
//
// O motor é deliberadamente conservador: escolhe a melhor variante do master
// playlist, baixa os segmentos com concorrência limitada, respeita o teto de
// bytes, decifra AES-128 quando a playlist pede e entrega MP4 —
// remuxando com FFmpeg só quando o contêiner realmente precisa (MPEG-TS).

import crypto from 'node:crypto';
import { fetchBuffer, fetchText, formatBytes } from '../../core/http.js';
import { hasFfmpeg, remuxToMp4 } from '../../util/ffmpeg.js';
import { log } from '../../core/logger.js';

const PLAYLIST_LIMIT = 4 * 1024 * 1024;
const SEGMENT_CONCURRENCY = 4;
const MAX_SEGMENTS = 20000;
const MAX_SEGMENT_BYTES = 48 * 1024 * 1024;
const MAX_HLS_BYTES = 200 * 1024 * 1024;

/** URL que aponta para uma playlist HLS. */
export function isHlsUrl(url) {
  const u = String(url || '').split('#')[0];
  if (/\.m3u8(\?|$)/i.test(u)) return true;
  return /[?&](?:format|type|output)=m3u8\b/i.test(u);
}

/** O corpo baixado é uma playlist HLS (e não a mídia em si)? */
export function looksLikePlaylist(buffer) {
  if (typeof buffer === 'string') return /^\uFEFF?\s*#EXTM3U/.test(buffer);
  if (!Buffer.isBuffer(buffer) || buffer.length < 7) return false;
  const head = buffer.subarray(0, 64).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  return head.startsWith('#EXTM3U');
}

/** `CHAVE=valor,CHAVE="valor com vírgula"` → objeto. */
export function parseAttributes(line) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let match;
  while ((match = re.exec(line))) {
    out[match[1]] = match[2].startsWith('"') ? match[2].slice(1, -1) : match[2].trim();
  }
  return out;
}

function absolute(uri, baseUrl) {
  try {
    return new URL(uri, baseUrl).toString();
  } catch {
    return '';
  }
}

function resolutionOf(attrs) {
  const [w, h] = String(attrs?.RESOLUTION || '').split('x');
  return { width: Number(w) || 0, height: Number(h) || 0 };
}

/** Master playlist: variantes de vídeo + faixas de áudio separadas. */
export function parseMasterPlaylist(text, baseUrl) {
  const lines = String(text || '').split(/\r?\n/);
  const variants = [];
  const renditions = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-MEDIA:'.length));
      if (attrs.URI && absolute(attrs.URI, baseUrl)) {
        renditions.push({
          type: attrs.TYPE || '',
          group: attrs['GROUP-ID'] || '',
          name: attrs.NAME || '',
          language: attrs.LANGUAGE || '',
          default: attrs.DEFAULT === 'YES',
          url: absolute(attrs.URI, baseUrl)
        });
      }
      continue;
    }
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
    const attrs = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
    let uri = '';
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j].trim();
      if (!next || next.startsWith('#')) continue;
      uri = next;
      break;
    }
    if (!uri) continue;
    const { width, height } = resolutionOf(attrs);
    variants.push({
      url: absolute(uri, baseUrl),
      bandwidth: Number(attrs.BANDWIDTH || attrs['AVERAGE-BANDWIDTH']) || 0,
      width,
      height,
      codecs: attrs.CODECS || '',
      audioGroup: attrs.AUDIO || ''
    });
  }
  return { variants: variants.filter((v) => v.url), renditions, isMaster: variants.length > 0 };
}

/**
 * Escolhe a variante. `melhor`/`alta` = maior resolução (empate pelo bitrate),
 * `baixa` = menor, `media` = a do meio. Sem resolução, decide pelo bitrate.
 */
export function pickVariant(variants, { quality = 'melhor' } = {}) {
  const usable = [...(variants || [])].filter((v) => v?.url);
  if (!usable.length) return null;
  const rank = (v) => (v.height || 0) * 1_000_000 + (v.bandwidth || 0);
  usable.sort((a, b) => rank(a) - rank(b));
  if (quality === 'baixa') return usable[0];
  if (quality === 'media') return usable[Math.floor((usable.length - 1) / 2)];
  return usable[usable.length - 1];
}

/** Media playlist: segmentos, init (fMP4), chave de decifração e duração. */
export function parseMediaPlaylist(text, baseUrl) {
  const lines = String(text || '').split(/\r?\n/);
  const segments = [];
  let initUrl = '';
  let key = null;
  let duration = 0;
  let mediaSequence = 0;
  let ended = false;
  let pendingDuration = null;
  let pendingRange = null;
  let nextRangeOffset = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = Number(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length)) || 0;
      continue;
    }
    if (line.startsWith('#EXT-X-ENDLIST')) {
      ended = true;
      continue;
    }
    if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-MAP:'.length));
      initUrl = absolute(attrs.URI || '', baseUrl);
      continue;
    }
    if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-KEY:'.length));
      key =
        !attrs.METHOD || attrs.METHOD === 'NONE'
          ? null
          : {
              method: attrs.METHOD,
              url: absolute(attrs.URI || '', baseUrl),
              iv: attrs.IV || ''
            };
      continue;
    }
    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      const [len, off] = line.slice('#EXT-X-BYTERANGE:'.length).split('@');
      const length = Number(len) || 0;
      const offset = off !== undefined ? Number(off) : nextRangeOffset;
      if (length > 0) pendingRange = { offset, length };
      nextRangeOffset = offset + length;
      continue;
    }
    if (line.startsWith('#EXTINF:')) {
      pendingDuration = Number(line.slice('#EXTINF:'.length).split(',')[0]) || 0;
      continue;
    }
    if (line.startsWith('#')) continue;

    // Linha de URI: pertence ao EXTINF anterior (ou é uma playlist só de URI).
    const url = absolute(line, baseUrl);
    if (url) {
      segments.push({
        url,
        duration: pendingDuration || 0,
        seq: mediaSequence + segments.length,
        range: pendingRange
      });
      duration += pendingDuration || 0;
    }
    pendingDuration = null;
    pendingRange = null;
  }

  return {
    segments,
    initUrl,
    key,
    duration,
    mediaSequence,
    ended,
    encrypted: key?.method && key.method !== 'NONE' ? key.method : null,
    isLive: !ended
  };
}

function ivForSequence(key, seq) {
  if (key?.iv) {
    const hex = String(key.iv).replace(/^0x/i, '');
    if (hex.length >= 32) return Buffer.from(hex.slice(0, 32), 'hex');
  }
  const iv = Buffer.alloc(16);
  iv.writeUInt32BE(seq >>> 0, 12);
  return iv;
}

function decryptSegment(buffer, keyBytes, iv) {
  const decipher = crypto.createDecipheriv('aes-128-cbc', keyBytes, iv);
  return Buffer.concat([decipher.update(buffer), decipher.final()]);
}

function tsLike(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 2) return false;
  // MPEG-TS: pacotes de 188 bytes começando com 0x47 (o 2º pacote confirma).
  return buffer[0] === 0x47 && (buffer.length < 189 || buffer[188] === 0x47);
}

/** Codecs só de áudio (SoundCloud/HLS de rádio): o stream inteiro é áudio. */
function codecsAreAudioOnly(codecs) {
  const value = String(codecs || '').toLowerCase();
  if (!value) return false;
  if (/(avc1|avc3|hvc1|hev1|vp0[89]|av01|mp4v|dvh1)/.test(value)) return false;
  return /(mp4a|aac|opus|vorbis|ec-3|ac-3)/.test(value);
}

function isMp4(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 12 && buffer.toString('ascii', 4, 8) === 'ftyp';
}

async function downloadSegments(segments, { headers, maxBytes, key, keyBytes, onSegment }) {
  const parts = new Array(segments.length);
  let total = 0;
  let failure = '';
  let limitReached = false;
  let cursor = 0;
  let done = 0;
  const perSegment = Math.min(maxBytes, MAX_SEGMENT_BYTES);

  const worker = async () => {
    for (;;) {
      // Um segmento que falha é erro, não "parcial": devolver o vídeo com um
      // buraco no meio produziria um arquivo corrompido sem ninguém perceber.
      if (failure || limitReached) return;
      const index = cursor++;
      if (index >= segments.length) return;
      const segment = segments[index];
      const range = segment.range
        ? { Range: `bytes=${segment.range.offset}-${segment.range.offset + segment.range.length - 1}` }
        : {};
      let chunk;
      try {
        chunk = await fetchBuffer(segment.url, {
          maxBytes: Math.min(perSegment, Math.max(64 * 1024, maxBytes - total)),
          headers: { ...headers, ...range },
          timeoutMs: 60_000
        });
      } catch (error) {
        failure = failure || `segmento ${index + 1}/${segments.length} falhou: ${String(error.message).slice(0, 90)}`;
        return;
      }
      if (keyBytes) {
        try {
          chunk = decryptSegment(chunk, keyBytes, ivForSequence(key, segment.seq));
        } catch (error) {
          failure = failure || `falha ao decifrar o segmento ${index + 1}: ${String(error.message).slice(0, 80)}`;
          return;
        }
      }
      parts[index] = chunk;
      total += chunk.length;
      done += 1;
      if (onSegment && done % 10 === 0) await onSegment(done, segments.length);
      if (total >= maxBytes) {
        limitReached = true;
        return;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(SEGMENT_CONCURRENCY, segments.length) }, () => worker())
  );

  if (failure) throw new Error(failure);
  if (limitReached) log.warn(`hls: download parcial (limite de ${formatBytes(maxBytes)} atingido)`);
  return {
    parts: parts.filter(Boolean),
    total,
    truncated: limitReached,
    stopReason: limitReached ? `limite de ${formatBytes(maxBytes)} atingido` : ''
  };
}

/**
 * Monta a mídia a partir de uma media playlist já em mãos.
 * @returns {Promise<{buffer: Buffer, kind: 'video'|'audio', container: string, duration: number, segments: number, live: boolean, encryption: string|null, truncated: boolean}>}
 */
export async function assembleHls(text, baseUrl, opts = {}) {
  const {
    headers = {},
    referer,
    maxBytes = MAX_HLS_BYTES,
    audioOnly = false,
    onSegment
  } = opts;
  const budget = Math.min(MAX_HLS_BYTES, Math.max(1, Number(maxBytes) || MAX_HLS_BYTES));
  const media = parseMediaPlaylist(text, baseUrl);
  if (!media.segments.length) throw new Error('playlist HLS sem segmentos');
  if (media.segments.length > MAX_SEGMENTS) {
    throw new Error(`playlist HLS longa demais (${media.segments.length} segmentos)`);
  }
  if (media.encrypted && !/^AES-128$/i.test(media.encrypted)) {
    throw new Error(`HLS protegido com ${media.encrypted} — só AES-128 é suportado`);
  }

  const reqHeaders = referer ? { ...headers, Referer: referer, referer } : headers;
  let keyBytes = null;
  if (media.encrypted === 'AES-128' && media.key?.url) {
    keyBytes = await fetchBuffer(media.key.url, { maxBytes: 4096, headers: reqHeaders, timeoutMs: 20_000 });
    if (keyBytes.length !== 16) throw new Error('chave AES-128 do HLS com tamanho inesperado');
  }

  const parts = [];
  let total = 0;
  if (media.initUrl) {
    const init = await fetchBuffer(media.initUrl, {
      maxBytes: Math.min(8 * 1024 * 1024, budget),
      headers: reqHeaders,
      timeoutMs: 30_000
    });
    parts.push(init);
    total += init.length;
  }

  const downloaded = await downloadSegments(media.segments, {
    headers: reqHeaders,
    maxBytes: Math.max(1, budget - total),
    key: media.key,
    keyBytes,
    onSegment
  });
  parts.push(...downloaded.parts);

  let buffer = Buffer.concat(parts);
  if (!buffer.length) throw new Error('HLS não devolveu bytes');

  let container = 'mp4';
  if (!isMp4(buffer)) {
    // MPEG-TS (o caso clássico) e ADTS cru: precisa remuxar — `-c copy`, sem
    // reencodar, então a qualidade original é mantida.
    if (!hasFfmpeg()) {
      const err = new Error(
        'este stream é MPEG-TS e precisa do FFmpeg para virar MP4 — a playlist em si já foi lida com sucesso'
      );
      err.hint = 'Instale o FFmpeg e tente de novo: pkg install ffmpeg (Termux) · apt install ffmpeg · winget install ffmpeg';
      throw err;
    }
    if (!tsLike(buffer) && !audioOnly) log.warn('hls: contêiner inesperado — tentando remux mesmo assim');
    buffer = await remuxToMp4(buffer, { audioOnly, ext: audioOnly ? '.aac' : '.ts' });
    container = audioOnly ? 'm4a' : 'mp4';
    if (!buffer.length) throw new Error('FFmpeg não gerou saída para o stream HLS');
  } else if (audioOnly) {
    container = 'm4a';
  }

  return {
    buffer,
    kind: audioOnly ? 'audio' : 'video',
    container,
    duration: Math.round(media.duration),
    segments: media.segments.length,
    live: media.isLive,
    encryption: media.encrypted,
    truncated: downloaded.truncated
  };
}

/**
 * Baixa um stream HLS completo.
 * @param {string} url master playlist (.m3u8) ou media playlist
 * @returns {Promise<{buffer: Buffer, kind: string, container: string, duration: number, segments: number, live: boolean, encryption: string|null, truncated: boolean}>}
 */
export async function downloadHls(url, opts = {}) {
  const { headers = {}, referer, timeoutMs = 45_000, maxBytes = MAX_HLS_BYTES } = opts;
  const reqHeaders = referer ? { ...headers, Referer: referer, referer } : headers;
  const text = await fetchText(url, { headers: reqHeaders, timeoutMs, maxBytes: PLAYLIST_LIMIT });
  return downloadHlsFromText(text, url, opts, 0);
}

/** Igual a `downloadHls`, mas a partir do texto já baixado (usado quando o GET inicial devolveu uma playlist). */
export async function downloadHlsFromText(text, baseUrl, opts = {}, depth = 0) {
  const { headers = {}, referer, timeoutMs = 45_000, audioOnly = false } = opts;
  const reqHeaders = referer ? { ...headers, Referer: referer, referer } : headers;
  const { variants, renditions, isMaster } = parseMasterPlaylist(text, baseUrl);

  if (isMaster && depth < 3) {
    if (audioOnly) {
      const track = renditions.find((r) => r.type === 'AUDIO' && r.url) || renditions.find((r) => r.url);
      if (track) {
        log.dl('hls: faixa de áudio separada encontrada — baixando só ela');
        const audioText = await fetchText(track.url, { headers: reqHeaders, timeoutMs, maxBytes: PLAYLIST_LIMIT });
        return downloadHlsFromText(audioText, track.url, opts, depth + 1);
      }
    }
    const chosen = pickVariant(variants, opts);
    if (!chosen) throw new Error('master playlist sem variantes utilizáveis');
    log.dl(`hls: variante ${chosen.height ? `${chosen.height}p` : `${Math.round(chosen.bandwidth / 1000)} kbps`} escolhida`);
    // Master só com codecs de áudio (rádio, SoundCloud): o resultado é áudio,
    // não vídeo — evita mandar um áudio como se fosse vídeo.
    const nextOpts = !opts.audioOnly && codecsAreAudioOnly(chosen.codecs) ? { ...opts, audioOnly: true } : opts;
    const mediaText = await fetchText(chosen.url, { headers: reqHeaders, timeoutMs, maxBytes: PLAYLIST_LIMIT });
    return downloadHlsFromText(mediaText, chosen.url, nextOpts, depth + 1);
  }

  if (isMaster && !variants.length) throw new Error('master playlist sem variantes utilizáveis');
  return assembleHls(text, baseUrl, opts);
}

export { MAX_HLS_BYTES };
