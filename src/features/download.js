// ⬇️ DOWNLOAD UNIVERSAL — o coração do NEXUS para mídias.
//
// Detecta a rede pelo link e roteia para o extrator certo, em cascata:
//   estratégia própria da rede → Cobalt (túnel) → yt-dlp (se houver binário)
//   → scraping de og:video/og:image do próprio link.
//
// Redes com extrator dedicado (métodos reais, comparados com bots em produção):
//   TikTok · Instagram · Pinterest · YouTube · X/Twitter · Facebook
//   Threads · Reddit · Twitch · Vimeo

import { SYM, ok, warn, fail, wait } from '../core/ui.js';
import { cfg } from '../core/config.js';
import { log } from '../core/logger.js';
import { fetchBuffer, formatBytes, mediaReferer } from '../core/http.js';
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

export { parseQuality };

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

/** Baixa uma URL de mídia aplicando o Referer que o CDN costuma exigir. */
async function downloadMedia(url, onProgress) {
  const referer = mediaReferer(url);
  log.dl(`baixando ${String(url).slice(0, 70)}…`);
  return fetchBuffer(url, {
    timeoutMs: 180_000,
    maxBytes: 200 * 1024 * 1024,
    headers: referer ? { Referer: referer, referer: referer } : {}
  });
}

/** Extrator dedicado por plataforma (null = usa o caminho genérico). */
async function byPlatform(url, platform, quality, audioOnly) {
  switch (platform) {
    case 'TikTok':
      return audioOnly ? tiktokAudio(url) : downloadTikTok(url, quality);
    case 'Instagram':
      return downloadInstagram(url, quality);
    case 'Pinterest':
      return downloadPinterest(url, quality);
    case 'YouTube':
      return downloadYouTube(url, quality, { audioOnly });
    case 'X (Twitter)':
      return downloadTwitter(url, quality);
    case 'Facebook':
      return downloadFacebook(url, quality);
    default:
      return null;
  }
}

/** Baixa os buffers de resultados que vieram só com URLs. */
async function withBuffers(result, onProgress) {
  if (result.buffers?.length) return result;
  const items = (result.media || []).slice(0, 10);
  if (!items.length) throw new Error('o extrator não devolveu mídia');
  const buffers = [];
  for (let i = 0; i < items.length; i++) {
    if (items.length > 1) {
      await onProgress?.(wait(`Baixando mídia ${i + 1}/${items.length}`));
    }
    buffers.push(await downloadMedia(items[i].url, onProgress));
  }
  return { ...result, buffers };
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
      log.warn(`${label} falhou: ${error.message}`);
    }
  }
  const err = new Error(errors.join(' | ') || 'nenhum extrator disponível');
  err.details = errors;
  throw err;
}

/**
 * Resolve uma URL para um resultado pronto de download.
 * @returns {Promise<{platform,title,author,duration,kind,buffers,audioBuffer,media}>}
 */
export async function resolveDownload(url, quality = 'melhor', { audioOnly = false, onProgress } = {}) {
  const platform = detectPlatform(url) || 'Web';
  const qLabel = qualityLabel(quality);
  await onProgress?.(wait(`Buscando em ${platform} · ${qLabel}`));

  const strategies = [];

  const dedicated = await byPlatform(url, platform, quality, audioOnly).catch((error) => {
    log.warn(`${platform} (dedicado): ${error.message}`);
    return null;
  });
  if (dedicated?.media?.length || dedicated?.buffers?.length) {
    const enriched = dedicated;
    const out = await withBuffers(enriched, onProgress).catch(async (error) => {
      log.warn(`download de buffers falhou (${error.message}) — tentando reservas`);
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
        const { buffers, audioBuffer, ...rest } = await cobaltDownload(url, quality, { audioOnly });
        return buffers?.length ? { ...rest, buffers, audioBuffer } : null;
      }
    ]);
  }

  if (hasYtDlp()) {
    strategies.push([
      'yt-dlp',
      async () => {
        await onProgress?.(wait('Usando yt-dlp local'));
        const { buffer } = await ytdlpBuffer(url, { audioOnly });
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
      return await withBuffers(found, onProgress);
    }
  ]);

  const result = await firstOf(strategies);
  return normalize(result, platform);
}

function normalize(result, platform) {
  return {
    platform: result.platform && result.platform !== 'Cobalt' ? result.platform : platform,
    title: result.title || '',
    author: result.author || '',
    duration: result.duration || 0,
    thumbnail: result.thumbnail || '',
    kind: result.kind || (result.media?.[0]?.type === 'image' ? 'image' : 'video'),
    media: result.media || [],
    buffers: result.buffers || [],
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
    const buffer = buffers[i];
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
    if (type === 'audio' || result.kind === 'audio') {
      await sock.sendMessage(
        jid,
        { audio: buffer, mimetype: 'audio/mpeg', fileName: 'nexus-audio.mp3' },
        sendOpts
      );
    } else if (type === 'video' || result.kind === 'video' || result.kind === 'carrossel' || detectVideo(buffer)) {
      await sock.sendMessage(jid, { video: buffer, caption, mimetype: 'video/mp4' }, sendOpts);
    } else if (type === 'gif') {
      await sock.sendMessage(jid, { video: buffer, caption, gifPlayback: true }, sendOpts);
    } else {
      await sock.sendMessage(jid, { image: buffer, caption }, sendOpts);
    }
    sent++;
  }
  if (result.audioBuffer && result.kind !== 'audio') {
    await sock.sendMessage(jid, { audio: result.audioBuffer, mimetype: 'audio/mpeg' }, sendOpts).catch(() => {});
  }
  if (sent > 0) {
    await onProgress?.(ok('Download concluído', result.platform || 'mídia'));
  } else {
    await onProgress?.(warn('Nada foi enviado', 'o arquivo pode ser grande demais'));
  }
  return sent;
}

function detectVideo(buffer) {
  // assinatura mp4: "ftyp" no offset 4
  return buffer.length > 12 && buffer.toString('ascii', 4, 8) === 'ftyp';
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
      log.dl(`auto-download ${platform}: ${url.slice(0, 80)}`);
      await reply(wait(`Baixando de ${platform}`));
      const result = await resolveDownload(url, quality, { onProgress: reply });
      await sendDownload(sock, msg.key.remoteJid, result, { quality, url, onProgress: reply, quoted: msg });
    } catch (error) {
      log.warn(`auto-download falhou: ${error.message}`);
      await reply(fail(`Não consegui baixar (${platform})`, String(error.message).slice(0, 160))).catch(
        () => {}
      );
    }
  }
}

export { probeStream };
