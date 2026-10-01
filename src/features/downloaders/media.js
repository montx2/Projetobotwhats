// 🔬 Helpers compartilhados pelos extratores: sondagem de stream, detecção de
// tipo por bytes/extensão e utilitários de JSON embutido em HTML.
//
// A sondagem existe por um motivo medido em bots reais: um extrator que falha
// costuma devolver a CAPA do post (um JPEG) no lugar do vídeo, e o WhatsApp
// aceita — o usuário pede um reels e recebe uma foto nomeada .mp4.
// Verificar os primeiros bytes antes de baixar tudo evita exatamente isso.

import { rawFetch, mediaReferer } from '../../core/http.js';

const IMAGE_EXTS = /\.(jpg|jpeg|png|webp|gif|heic|avif|bmp)(\?|$)/i;
const VIDEO_EXTS = /\.(mp4|webm|mkv|mov|m4v|avi)(\?|$)/i;
const AUDIO_EXTS = /\.(mp3|m4a|opus|ogg|wav|flac|aac)(\?|$)/i;

/** Tipo inferido pela extensão da URL (barato, antes de qualquer request). */
export function kindByExtension(url) {
  const u = String(url || '').split(/[?#]/)[0];
  if (VIDEO_EXTS.test(u)) return 'video';
  if (AUDIO_EXTS.test(u)) return 'audio';
  if (IMAGE_EXTS.test(u)) return 'image';
  return 'unknown';
}

/** Assinaturas de imagem que um CDN social responde (JPEG/PNG/GIF/WebP). */
export function looksLikeImageBytes(bytes) {
  if (!bytes || bytes.length < 4) return false;
  const [a, b, c, d] = bytes;
  if (a === 0xff && b === 0xd8 && c === 0xff) return true; // JPEG
  if (a === 0x89 && b === 0x50 && c === 0x4e && d === 0x47) return true; // PNG
  if (a === 0x47 && b === 0x49 && b === 0x46 && c === 0x38) return true; // GIF8
  if (a === 0x47 && b === 0x49 && c === 0x46 && d === 0x38) return true; // GIF8
  if (bytes.length >= 12) {
    const riff = a === 0x52 && b === 0x49 && c === 0x46 && d === 0x46;
    const webp = bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
    if (riff && webp) return true;
  }
  return false;
}

/** Assinatura ISO-BMFF (mp4/m4a/mov): bytes 4..8 == "ftyp". */
export function looksLikeMp4Bytes(bytes) {
  if (!bytes || bytes.length < 12) return false;
  return String.fromCharCode(...bytes.subarray(4, 8)) === 'ftyp';
}

function totalStreamBytes(res) {
  const range = res.headers.get('content-range');
  const total = range?.match(/\/(\d+)\s*$/)?.[1];
  if (total) return Number(total);
  if (res.status === 200) {
    const len = Number(res.headers.get('content-length'));
    if (len > 0) return len;
  }
  const est = Number(res.headers.get('estimated-content-length'));
  return est > 0 ? est : undefined;
}

/**
 * Sonda um candidato a stream: lê só o 1º chunk e cancela a conexão.
 * @returns {{verdict: 'ok'|'unreachable'|'wrong-type', sizeBytes?: number}}
 *   ok          → serve bytes do tipo esperado
 *   unreachable → este host não alcança (pode funcionar em outra rede; guarde como último recurso)
 *   wrong-type  → NÃO é a mídia pedida (nunca use como fallback)
 */
export async function probeStream(url, { expect, timeoutMs = 12_000, referer } = {}) {
  try {
    const headers = { Range: 'bytes=0-1024' };
    const ref = referer ?? mediaReferer(url);
    if (ref) headers.Referer = ref;

    const res = await rawFetch(url, { headers, timeoutMs });
    const statusOk = res.status === 200 || res.status === 206;
    const ct = String(res.headers.get('content-type') || '').toLowerCase();
    const isPage = ct.includes('text/html');

    if (!statusOk || res.headers.get('content-length') === '0') {
      await res.body?.cancel?.().catch(() => {});
      return { verdict: 'unreachable' };
    }
    if (expect === 'video' && (isPage || ct.startsWith('image/'))) {
      await res.body?.cancel?.().catch(() => {});
      return { verdict: 'wrong-type' };
    }
    if (expect === 'image' && (isPage || ct.startsWith('video/'))) {
      await res.body?.cancel?.().catch(() => {});
      return { verdict: 'wrong-type' };
    }

    const sizeBytes = totalStreamBytes(res);
    if (!res.body) return { verdict: 'unreachable' };

    const reader = res.body.getReader();
    try {
      const { value, done } = await reader.read();
      if (done || (value?.byteLength ?? 0) === 0) return { verdict: 'unreachable' };
      if (expect === 'video' && looksLikeImageBytes(value)) return { verdict: 'wrong-type' };
      if (expect === 'image' && !looksLikeImageBytes(value)) return { verdict: 'wrong-type' };
      if (expect === 'video' && isPage) return { verdict: 'wrong-type' };
      return { verdict: 'ok', sizeBytes };
    } finally {
      await reader.cancel().catch(() => {});
    }
  } catch {
    return { verdict: 'unreachable' };
  }
}

/**
 * Extrai o primeiro valor de `"chave":"valor"` depois de `from`,
 * decodificando escapes de JSON (Instagram/Facebook escapam "/" e "=").
 */
export function stringAfterKey(html, key, from = 0, span = 9000) {
  if (!html) return '';
  const at = html.indexOf(key, from);
  if (at === -1) return '';
  const raw = /"url":"(https:.*?)"/.exec(html.slice(at, at + span))?.[1];
  if (!raw) return '';
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return raw.replace(/\\\//g, '/');
  }
}

/** Recorta o objeto JSON balanceado que começa em `start` (respeita strings). */
export function extractBalancedJson(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Decodifica entidades HTML básicas (&amp; &quot; &#x27; …). */
export function decodeEntities(text = '') {
  return String(text)
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&#x27;/gi, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

/** Lê <meta property="og:x" content="..."> de um HTML. */
export function metaContent(html, property) {
  if (!html) return '';
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']*)["']`,
    'i'
  );
  const alt = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${property}["']`, 'i');
  return decodeEntities(html.match(re)?.[1] || html.match(alt)?.[1] || '');
}
