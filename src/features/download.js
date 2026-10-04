// ⬇️ DOWNLOAD UNIVERSAL — o coração do NEXUS para mídias.
//
// Detecta a rede pelo link e roteia para o extrator certo, em cascata:
//   estratégia própria da rede → Cobalt (túnel) → yt-dlp (se houver binário)
//   → scraping de og:video/og:image do próprio link.
//
// Redes com extrator dedicado (métodos reais, comparados com bots em produção):
//   TikTok · Instagram · Pinterest · YouTube · X/Twitter · Facebook
//   Threads · Reddit · Twitch · Vimeo
//
// Quem consome isto além do `.dl`: o `.s <link>` (stickerlink.js), que usa o
// mesmo `resolveDownload` para transformar um link em figurinha pronta.

import { SYM, ok, warn, fail, wait } from '../core/ui.js';
import { cfg } from '../core/config.js';
import { log } from '../core/logger.js';
import { assertPublicHttpUrl, fetchBuffer, formatBytes, mediaReferer, shortUrl } from '../core/http.js';
import { truncate } from '../util/text.js';
import { parseQuality, qualityLabel } from './downloaders/quality.js';
import { isTikTokUrl, downloadTikTok, tiktokAudio } from './downloaders/tiktok.js';
import { isPinterestUrl, downloadPinterest } from './downloaders/pinterest.js';
import { isInstagramUrl, downloadInstagram } from './downloaders/instagram.js';
import { isYouTubeUrl, downloadYouTube } from './downloaders/youtube.js';
import { isTwitterUrl, downloadTwitter } from './downloaders/twitter.js';
import { isFacebookUrl, downloadFacebook } from './downloaders/facebook.js';
import { isThreadsUrl, isRedditUrl, isTwitchUrl, isVimeoUrl, downloadGeneric } from './downloaders/generic.js';
import { cobaltDownload } from './downloaders/cobalt.js';
import { hasYtDlp, ytdlpBuffer, ytdlpInfo } from './downloaders/ytdlp.js';
import { probeStream } from './downloaders/media.js';
import { detectAudioMime, hasFfmpeg, applyAudioFilter } from '../util/ffmpeg.js';

export { parseQuality };

const HARD_DOWNLOAD_LIMIT = 200 * 1024 * 1024;

const PLATFORM_DETECT = [
  { test: isTikTokUrl, name: 'TikTok' },
  { test: isInstagramUrl, name: 'Instagram' },
  { test: isPinterestUrl, name: 'Pinterest' },
  { test: isYouTubeUrl, name: 'YouTube' },
  { test: isTwitterUrl, name: 'X (Twitter)' },
  { test: isFacebookUrl, name: 'Facebook' },
  { test: isThreadsUrl, name: 'Threads' },
  { test: isRedditUrl, name: 'Reddit' },
  { test: isTwitchUrl, name: 'Twitch' },
  { test: isVimeoUrl, name: 'Vimeo' },
  { test: (u) => /snapchat\.com/i.test(u), name: 'Snapchat' },
  { test: (u) => /soundcloud\.com/i.test(u), name: 'SoundCloud' },
  { test: (u) => /dailymotion\.com|dai\.ly/i.test(u), name: 'Dailymotion' },
  { test: (u) => /tiktok\.com\/@[^/]+\/photo|douyin\.com/i.test(u), name: 'Douyin' },
  { test: (u) => /(giphy\.com|tenor\.com)/i.test(u), name: 'GIF' }
];

export function detectPlatform(url) {
  return PLATFORM_DETECT.find((p) => p.test(url))?.name || null;
}

export function isKnownSocialUrl(url) {
  return !!detectPlatform(url);
}

/** Baixa uma URL de mídia aplicando os cabeçalhos esperados (Referer, User-Agent específico etc.). */
async function downloadMedia(itemOrUrl, onProgress, maxBytes = 200 * 1024 * 1024) {
  const url = typeof itemOrUrl === 'string' ? itemOrUrl : itemOrUrl?.url;
  const customHeaders = typeof itemOrUrl === 'object' && itemOrUrl?.headers ? itemOrUrl.headers : {};
  const referer = customHeaders.referer || customHeaders.Referer || mediaReferer(url);
  log.dl(`baixando ${shortUrl(url)}…`);
  return fetchBuffer(url, {
    timeoutMs: 180_000,
    maxBytes,
    headers: {
      ...(referer ? { Referer: referer, referer } : {}),
      ...customHeaders
    }
  });
}

/** Extrator dedicado por plataforma (null = usa o caminho genérico). */
async function byPlatform(url, platform, quality, audioOnly, maxBytes) {
  switch (platform) {
    case 'TikTok':
      return audioOnly ? tiktokAudio(url, { maxBytes }) : downloadTikTok(url, quality, { maxBytes });
    case 'Instagram':
      return downloadInstagram(url, quality, { maxBytes });
    case 'Pinterest':
      return downloadPinterest(url, quality, { maxBytes });
    case 'YouTube':
      return downloadYouTube(url, quality, { audioOnly, maxBytes });
    case 'X (Twitter)':
      return downloadTwitter(url, quality, { maxBytes });
    case 'Facebook':
      return downloadFacebook(url, quality, { maxBytes });
    default:
      return null;
  }
}

/**
 * Baixa a mídia de um item; se a rendição escolhida não existir mais (clássico
 * em `/originals/` de pin antigo), tenta as alternativas do extrator antes de
 * desistir — é o mesmo cuidado que o `.s <link>` usa para não devolver nada.
 */
async function downloadItemWithAlternates(item, alternates, onProgress, maxBytes) {
  try {
    return await downloadMedia(item, onProgress, maxBytes);
  } catch (error) {
    for (const alt of alternates || []) {
      if (!alt?.url && typeof alt !== 'string') continue;
      try {
        await onProgress?.(wait('Essa versão não está mais no ar — tentando outra'));
        return await downloadMedia(alt, onProgress, maxBytes);
      } catch {
        /* tenta a próxima */
      }
    }
    throw error;
  }
}

function isCorruptedHtmlBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return false;
  const head = buffer.subarray(0, 50).toString('utf8').trim().toLowerCase();
  return head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml') || head.startsWith('{"error"');
}

/** Baixa os buffers de resultados que vieram só com URLs. */
async function withBuffers(result, onProgress, maxBytes) {
  if (result.buffers?.length) return validateResultBufferLimits(result, maxBytes);
  const items = (result.media || []).slice(0, 10);
  if (!items.length) throw new Error('o extrator não devolveu mídia');
  const perFileLimit = Math.min(HARD_DOWNLOAD_LIMIT, Math.max(1, Number(maxBytes) || 1));
  const totalLimit = Math.min(HARD_DOWNLOAD_LIMIT, perFileLimit * 2);
  const buffers = [];
  let total = 0;
  for (let i = 0; i < items.length; i++) {
    const remaining = totalLimit - total;
    if (remaining < 1) throw new Error(`lote excede o limite agregado de ${formatBytes(totalLimit)}`);
    if (items.length > 1) {
      await onProgress?.(wait(`Baixando mídia ${i + 1}/${items.length}`));
    }
    const limit = Math.min(perFileLimit, remaining);
    const buffer = i === 0
      ? await downloadItemWithAlternates(items[i], result.alternates, onProgress, limit)
      : await downloadMedia(items[i], onProgress, limit);
    if (isCorruptedHtmlBuffer(buffer)) {
      throw new Error('arquivo baixado é inválido (resposta HTML em vez de mídia)');
    }
    total += buffer.length;
    buffers.push(buffer);
  }
  return validateResultBufferLimits({ ...result, buffers }, perFileLimit);
}

/**
 * Roda estratégias em ordem e devolve a primeira que funcionar.
 * Cada estratégia pode lançar; só a última mensagem é preservada pro erro.
 */
async function firstOf(strategies) {
  const errors = [];
  for (const [label, fn] of strategies) {
    try {
      const out = await fn();
      if (out) return out;
      errors.push(`${label}: sem mídia`);
    } catch (error) {
      errors.push(`${label}: ${String(error.message || error).slice(0, 110)}`);
      log.warn(`${label} falhou`, { name: error?.name, status: error?.status, code: error?.code });
    }
  }
  const err = new Error(errors.join(' | ') || 'nenhum extrator disponível');
  err.details = errors;
  throw err;
}

function validateResultBufferLimits(result, maxBytes) {
  const buffers = [...(result?.buffers || []), ...(result?.audioBuffer ? [result.audioBuffer] : [])];
  const perFileLimit = Math.min(HARD_DOWNLOAD_LIMIT, Math.max(1, Number(maxBytes) || 1));
  const totalLimit = Math.min(HARD_DOWNLOAD_LIMIT, perFileLimit * 2);
  let total = 0;
  for (const buffer of buffers) {
    if (isCorruptedHtmlBuffer(buffer)) {
      throw new Error('arquivo baixado é inválido (resposta HTML em vez de mídia)');
    }
    total += buffer?.length || 0;
    if ((buffer?.length || 0) > perFileLimit) throw new Error(`arquivo excede o limite de ${formatBytes(perFileLimit)}`);
  }
  if (total > totalLimit) throw new Error(`lote excede o limite agregado de ${formatBytes(totalLimit)}`);
  return result;
}

/**
 * Resolve uma URL para um resultado pronto de download.
 * @param {string} url
 * @param {'melhor'|'alta'|'media'|'baixa'} quality
 * @param {{audioOnly?: boolean, onProgress?: Function, maxBytes?: number}} [opts]
 *   `maxBytes` limita o tamanho de cada arquivo baixado (o `.s <link>` usa um
 *   teto menor: não faz sentido baixar 200 MB para uma figurinha de 7 s).
 * @returns {Promise<{platform,title,author,duration,kind,buffers,audioBuffer,media}>}
 */
export async function resolveDownload(url, quality = 'melhor', { audioOnly = false, onProgress, maxBytes } = {}) {
  const requestedUrl = String(url || '').trim();
  if (!requestedUrl) throw new Error('informe uma URL para baixar');
  url = await assertPublicHttpUrl(requestedUrl);
  const configuredLimit = Math.min(HARD_DOWNLOAD_LIMIT, Math.max(1, Number(cfg.get().maxMB || 90) * 1024 * 1024));
  const requestedLimit = Number(maxBytes);
  maxBytes = Math.min(HARD_DOWNLOAD_LIMIT, Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.max(1, Math.floor(requestedLimit)) : configuredLimit);
  const platform = detectPlatform(url) || 'Web';
  const qLabel = qualityLabel(quality);
  await onProgress?.(wait(`Buscando em ${platform} · ${qLabel}`));

  const strategies = [];

  const dedicated = await byPlatform(url, platform, quality, audioOnly, maxBytes).catch((error) => {
    log.warn(`${platform} (dedicado) falhou`, { name: error?.name, status: error?.status, code: error?.code });
    return null;
  });
  if (dedicated?.media?.length || dedicated?.buffers?.length) {
    const enriched = dedicated;
    const out = await withBuffers(enriched, onProgress, maxBytes).catch(async (error) => {
      log.warn('download de buffers falhou; tentando reservas', { name: error?.name, status: error?.status, code: error?.code });
      return null;
    });
    if (out?.buffers?.length) return normalize(out, platform);
  }

  // Reservas em cascata.
  // Os extratores dedicados já tentam o Cobalt por conta própria, então só
  // vale chamá-lo de novo quando NÃO houve extrator dedicado (cauda longa) —
  // repetir a chamada dobraria a espera sem mudar o que pode ser alcançado.
  const dedicatedTriesCobalt =
    platform === 'TikTok' ||
    platform === 'Instagram' ||
    platform === 'Pinterest' ||
    platform === 'YouTube' ||
    platform === 'X (Twitter)' ||
    platform === 'Facebook';

  if (!dedicatedTriesCobalt) {
    strategies.push([
      'cobalt',
      async () => {
        const { buffers, audioBuffer, ...rest } = await cobaltDownload(url, quality, { audioOnly, maxBytes });
        return buffers?.length ? { ...rest, buffers, audioBuffer } : null;
      }
    ]);
  }

  if (hasYtDlp()) {
    strategies.push([
      'yt-dlp',
      async () => {
        await onProgress?.(wait('Usando yt-dlp local'));
        const { buffer } = await ytdlpBuffer(url, { audioOnly, maxBytes });
        const info = await ytdlpInfo(url).catch(() => null);
        return {
          platform,
          title: info?.title || '',
          author: info?.author || '',
          duration: info?.duration || 0,
          kind: audioOnly ? 'audio' : 'video',
          buffers: [buffer],
          media: [{ type: audioOnly ? 'audio' : 'video', url }]
        };
      }
    ]);
  }

  strategies.push([
    'scraping',
    async () => {
      const { downloadByPageScrape } = await import('./downloaders/generic.js');
      const found = await downloadByPageScrape(url);
      if (!found?.media?.length) return null;
      return await withBuffers(found, onProgress, maxBytes);
    }
  ]);

  const result = await firstOf(strategies);
  return normalize(result, platform);
}

function normalize(result, platform) {
  const isAudio = result.kind === 'audio' || result.media?.[0]?.type === 'audio' || result.audioOnly === true;
  const kind = isAudio ? 'audio' : result.kind || (result.media?.[0]?.type === 'image' ? 'image' : 'video');
  return {
    platform: result.platform && result.platform !== 'Cobalt' ? result.platform : platform,
    title: result.title || '',
    author: result.author || '',
    duration: result.duration || 0,
    thumbnail: result.thumbnail || '',
    kind,
    media: (result.media || []).map((m) => (isAudio ? { ...m, type: 'audio' } : m)),
    buffers: result.buffers || [],
    // Rendições extras (mesma mídia em outro tamanho) e flags de confiança que
    // o extrator marcou: o `.s <link>` usa isso para tentar outra versão quando
    // a primeira não passa na validação de conteúdo.
    alternates: result.alternates || [],
    audioBuffer: result.audioBuffer || null
  };
}

/** Envia o resultado para o chat, respeitando o limite de tamanho configurado. */
export async function sendDownload(sock, jid, result, { quality, url, onProgress, quoted } = {}) {
  const maxMB = Number(cfg.get().maxMB) || 90;
  const qLabel = qualityLabel(quality);
  const header = [
    `${SYM.section} *${result.platform || 'Download'}*  ${SYM.detail}  _${qLabel}_`,
    result.title ? ` ${SYM.detail} ${truncate(result.title, 300)}` : null,
    result.author ? ` ${SYM.detail} ${result.author}` : null,
    result.duration
      ? ` ${SYM.detail} ${Math.floor(result.duration / 60)}:${String(Math.floor(result.duration % 60)).padStart(2, '0')}`
      : null
  ]
    .filter(Boolean)
    .join('\n');

  const buffers = result.buffers || [];
  if (!buffers.length) throw new Error('nada para enviar');

  let sent = 0;
  const sendOpts = quoted ? { quoted } : undefined;
  for (let i = 0; i < buffers.length; i++) {
    let buffer = buffers[i];
    const mb = buffer.length / (1024 * 1024);
    if (mb > maxMB) {
      const warnMsg = warn(
        `Arquivo ${i + 1} excede o limite (${formatBytes(buffer.length)} > ${maxMB} MB)`,
        'tente a qualidade baixa ou aumente com .config maxMB 120'
      );
      if (onProgress) await onProgress(warnMsg);
      else await sock.sendMessage(jid, { text: warnMsg }, sendOpts);
      continue;
    }
    await onProgress?.(
      buffers.length > 1
        ? wait(`Enviando mídia ${i + 1}/${buffers.length} · ${formatBytes(buffer.length)}`)
        : wait(`Enviando mídia · ${formatBytes(buffer.length)}`)
    );
    const caption = buffers.length > 1 ? `${header}\n(${i + 1}/${buffers.length})` : header;
    const type = result.media?.[i]?.type || result.kind;
    const isAudio = result.kind === 'audio' || type === 'audio';

    if (isAudio) {
      let mime = detectAudioMime(buffer);
      if (mime === 'audio/webm' || (buffer.length > 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3)) {
        if (hasFfmpeg()) {
          try {
            const converted = await applyAudioFilter(buffer, { filter: 'anull', ext: '.mp3', bitrate: '128k' });
            if (converted?.length) {
              buffer = converted;
              mime = 'audio/mpeg';
            }
          } catch {}
        }
      }

      const ext = mime === 'audio/mp4' ? 'm4a' : mime.includes('ogg') ? 'ogg' : mime === 'audio/wav' ? 'wav' : 'mp3';
      const cleanTitle = (result.title || 'nexus-audio').replace(/[/\\?%*:|"<>]/g, '_').slice(0, 80);
      const fileName = `${cleanTitle}.${ext}`;

      await sock.sendMessage(
        jid,
        {
          audio: buffer,
          mimetype: mime,
          fileName,
          ptt: false
        },
        sendOpts
      );
    } else if (type === 'video' || result.kind === 'video' || result.kind === 'carrossel' || (!isAudio && detectVideo(buffer))) {
      await sock.sendMessage(jid, { video: buffer, caption, mimetype: 'video/mp4' }, sendOpts);
    } else if (type === 'gif') {
      await sock.sendMessage(jid, { video: buffer, caption, gifPlayback: true }, sendOpts);
    } else {
      await sock.sendMessage(jid, { image: buffer, caption }, sendOpts);
    }
    sent++;
  }
  if (result.audioBuffer && result.kind !== 'audio') {
    const aMime = detectAudioMime(result.audioBuffer);
    await sock.sendMessage(jid, { audio: result.audioBuffer, mimetype: aMime, ptt: false }, sendOpts).catch(() => {});
  }
  if (sent > 0) {
    await onProgress?.(ok('Download concluído', result.platform || 'mídia'));
  } else {
    await onProgress?.(warn('Nada foi enviado', 'o arquivo pode ser grande demais'));
  }
  return sent;
}

function detectVideo(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) return false;
  // WebM / MKV
  if (buffer.length > 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return true;
  // MP4
  if (buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buffer.toString('ascii', 8, 12).toLowerCase();
    if (brand.startsWith('m4a') || brand.startsWith('m4b') || brand.startsWith('f4a')) {
      return false;
    }
    return true;
  }
  return false;
}

/** Auto-download de links soltos: funciona no privado do dono e nos chats ativados. */
export async function autoDownload(sock, msg, urls, { reply }) {
  const { quality } = parseQuality(
    String(msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').split(/\s+/).slice(1),
    cfg.get().qualidadePadrao
  );
  for (const url of urls.slice(0, 3)) {
    const platform = detectPlatform(url) || 'Web';
    try {
      log.dl(`auto-download ${platform}: ${shortUrl(url)}`);
      await reply(wait(`Baixando de ${platform}`));
      const result = await resolveDownload(url, quality, { onProgress: reply });
      await sendDownload(sock, msg.key.remoteJid, result, { quality, url, onProgress: reply, quoted: msg });
    } catch (error) {
      log.warn('auto-download falhou', { name: error?.name, status: error?.status, code: error?.code });
      await reply(fail(`Não consegui baixar (${platform})`, String(error.message).slice(0, 160))).catch(
        () => {}
      );
    }
  }
}

export { probeStream };
