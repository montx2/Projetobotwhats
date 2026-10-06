// ⬇️ DOWNLOAD UNIVERSAL — o coração do NEXUS para mídias.
//
// Detecta a rede pelo link e roteia para o extrator certo, em cascata:
//   estratégia própria da rede → Cobalt (túnel) → yt-dlp (se houver binário)
//   → scraping de og:video/og:image do próprio link.
//
// Redes com extrator dedicado (métodos reais, comparados com bots em produção):
//   TikTok · Douyin · Instagram · Pinterest · YouTube · X/Twitter · Facebook
//   Threads · Reddit · Twitch · Vimeo · Bluesky · Imgur · Dailymotion
//   ComedyHub (SPA com login: usa a sessão do dono — `.chlogin`)
//   + HLS genérico (.m3u8) e scraping de página para a cauda longa.
//
// Rede com login NÃO cai no scraping: quando o extrator dedicado do ComedyHub
// falha, o bot para e explica o motivo em vez de entregar o `og:image` da
// página (era exatamente isso que fazia o `.dl` mandar só a foto de introdução).
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
import { isYouTubeUrl, downloadYouTube, parseYouTubeId } from './downloaders/youtube.js';
import { isTwitterUrl, downloadTwitter } from './downloaders/twitter.js';
import { isFacebookUrl, downloadFacebook } from './downloaders/facebook.js';
import {
  isThreadsUrl,
  isRedditUrl,
  isTwitchUrl,
  isVimeoUrl,
  downloadByPlatform
} from './downloaders/generic.js';
import { isBlueskyUrl, downloadBluesky } from './downloaders/bluesky.js';
import { isImgurUrl, downloadImgur } from './downloaders/imgur.js';
import { isDailymotionUrl, downloadDailymotion } from './downloaders/dailymotion.js';
import { isComedyHubUrl, downloadComedyHub } from './downloaders/comedyhub.js';
import { cobaltDownload } from './downloaders/cobalt.js';
import { canUseYtdlp, ytdlpBuffer, ytdlpInfo, youtubeWatchUrl } from './downloaders/ytdlp.js';
import { isGoogleVideoUrl, fetchGoogleVideoBuffer } from './downloaders/gvs.js';
import { probeStream, kindByContentType } from './downloaders/media.js';
import { isHlsUrl, looksLikePlaylist, downloadHls, downloadHlsFromText } from './downloaders/hls.js';
import { detectAudioMime, hasFfmpeg, applyAudioFilter } from '../util/ffmpeg.js';

export { parseQuality };

const HARD_DOWNLOAD_LIMIT = 200 * 1024 * 1024;

export function isDouyinUrl(url) {
  return /(douyin\.com|iesdouyin\.com)/i.test(String(url));
}

const PLATFORM_DETECT = [
  { test: isTikTokUrl, name: 'TikTok' },
  { test: isDouyinUrl, name: 'Douyin' },
  { test: isInstagramUrl, name: 'Instagram' },
  { test: isPinterestUrl, name: 'Pinterest' },
  { test: isYouTubeUrl, name: 'YouTube' },
  { test: isTwitterUrl, name: 'X (Twitter)' },
  { test: isFacebookUrl, name: 'Facebook' },
  { test: isThreadsUrl, name: 'Threads' },
  { test: isRedditUrl, name: 'Reddit' },
  { test: isTwitchUrl, name: 'Twitch' },
  { test: isVimeoUrl, name: 'Vimeo' },
  { test: isBlueskyUrl, name: 'Bluesky' },
  { test: isImgurUrl, name: 'Imgur' },
  { test: isDailymotionUrl, name: 'Dailymotion' },
  { test: isComedyHubUrl, name: 'ComedyHub' },
  { test: (u) => /snapchat\.com/i.test(u), name: 'Snapchat' },
  { test: (u) => /soundcloud\.com/i.test(u), name: 'SoundCloud' },
  { test: (u) => /(giphy\.com|tenor\.com)/i.test(u), name: 'GIF' },
  // Cauda longa que o modo universal (Cobalt + scraping da página) atende: o
  // nome aqui é só para a mensagem dizer de onde está baixando.
  { test: (u) => /kwai\.com|kwai-video\.com/i.test(u), name: 'Kwai' },
  { test: (u) => /tumblr\.com/i.test(u), name: 'Tumblr' },
  { test: (u) => /streamable\.com/i.test(u), name: 'Streamable' },
  { test: (u) => /(vk\.com|vkvideo\.ru)/i.test(u), name: 'VK' },
  { test: (u) => /bilibili\.com/i.test(u), name: 'Bilibili' },
  { test: (u) => /weibo\.(com|cn)/i.test(u), name: 'Weibo' },
  { test: (u) => /rumble\.com/i.test(u), name: 'Rumble' },
  { test: (u) => /9gag\.com/i.test(u), name: '9GAG' },
  { test: (u) => /linkedin\.com/i.test(u), name: 'LinkedIn' },
  { test: (u) => /redgifs\.com/i.test(u), name: 'RedGifs' },
  { test: (u) => /ok\.ru/i.test(u), name: 'OK.ru' },
  { test: (u) => /ifunny\.co/i.test(u), name: 'iFunny' },
  { test: isHlsUrl, name: 'Stream HLS' }
];

export function detectPlatform(url) {
  return PLATFORM_DETECT.find((p) => p.test(url))?.name || null;
}

/**
 * Catálogo do suporte a downloads — fonte única para o `.plataformas`, para o
 * `.menudl` e para o README. `dedicated: true` = extrator próprio do bot (não
 * depende de ninguém); `false` = rota universal (Cobalt + página).
 */
export const SUPPORTED_PLATFORMS = [
  { name: 'TikTok', dedicated: true, notes: 'vídeo sem marca, álbum de fotos e áudio' },
  { name: 'Douyin', dedicated: true, notes: 'mesma cascata do TikTok' },
  { name: 'Instagram', dedicated: true, notes: 'post, foto, reel e carrossel' },
  { name: 'Pinterest', dedicated: true, notes: 'imagem em resolução original e vídeo' },
  { name: 'YouTube', dedicated: true, notes: 'vídeo e áudio · yt-dlp → Innertube → Invidious' },
  { name: 'X (Twitter)', dedicated: true, notes: 'vídeo, GIF e fotos do tweet' },
  { name: 'Facebook', dedicated: true, notes: 'vídeo, reels e foto' },
  { name: 'Threads', dedicated: true, notes: 'vídeo e fotos' },
  { name: 'Reddit', dedicated: true, notes: 'vídeo, foto e galeria' },
  { name: 'Twitch', dedicated: true, notes: 'clipes (VOD é HLS — usa o motor de stream)' },
  { name: 'Vimeo', dedicated: true, notes: 'vídeo em MP4 progressivo' },
  { name: 'Bluesky', dedicated: true, notes: 'fotos e vídeo do post' },
  { name: 'Imgur', dedicated: true, notes: 'foto, GIF/MP4 e álbum' },
  { name: 'Dailymotion', dedicated: true, notes: 'vídeo em MP4, até a maior resolução' },
  { name: 'ComedyHub', dedicated: true, notes: 'meme, foto e vídeo · pede login uma vez (.chlogin)' },
  { name: 'Stream HLS', dedicated: true, notes: 'qualquer link .m3u8 (segmentos → MP4)' },
  { name: 'GIF', dedicated: false, notes: 'Giphy e Tenor viram MP4/GIF' },
  { name: 'Kwai', dedicated: false, notes: 'modo universal' },
  { name: 'Tumblr', dedicated: false, notes: 'modo universal' },
  { name: 'Streamable', dedicated: false, notes: 'modo universal' },
  { name: 'Snapchat', dedicated: false, notes: 'Spotlight público' },
  { name: 'SoundCloud', dedicated: false, notes: 'áudio' },
  { name: 'VK', dedicated: false, notes: 'modo universal' },
  { name: 'Bilibili', dedicated: false, notes: 'modo universal' },
  { name: 'Weibo', dedicated: false, notes: 'modo universal' },
  { name: 'Rumble', dedicated: false, notes: 'modo universal' },
  { name: 'OK.ru', dedicated: false, notes: 'modo universal' },
  { name: 'RedGifs', dedicated: false, notes: 'modo universal' },
  { name: '9GAG', dedicated: false, notes: 'modo universal' },
  { name: 'iFunny', dedicated: false, notes: 'modo universal' },
  { name: 'LinkedIn', dedicated: false, notes: 'modo universal' }
];

/** Nomes com extrator próprio — usados pelo `.info` e pelo menu. */
export function dedicatedPlatformNames() {
  return SUPPORTED_PLATFORMS.filter((p) => p.dedicated).map((p) => p.name);
}

export function isKnownSocialUrl(url) {
  return !!detectPlatform(url);
}

/** Baixa uma URL de mídia aplicando os cabeçalhos esperados (Referer, User-Agent específico etc.). */
async function downloadMedia(itemOrUrl, onProgress, maxBytes = 200 * 1024 * 1024) {
  const url = typeof itemOrUrl === 'string' ? itemOrUrl : itemOrUrl?.url;
  const item = typeof itemOrUrl === 'object' && itemOrUrl ? itemOrUrl : {};
  const customHeaders = item.headers || {};
  const referer = customHeaders.referer || customHeaders.Referer || mediaReferer(url);
  log.dl(`baixando ${shortUrl(url)}…`);

  // CDN do YouTube: GET aberto é recusado com 403 em parte das URLs (e o resto
  // é estrangulado). O player real pede FAIXAS — então o bot faz igual.
  if (item.ranged || isGoogleVideoUrl(url)) {
    return fetchGoogleVideoBuffer(url, {
      headers: { ...(referer ? { referer } : {}), ...customHeaders },
      maxBytes,
      totalBytes: Number(item.contentLength) || 0
    });
  }

  // HLS: `.m3u8` é uma playlist de texto, não o vídeo. Baixar direto entregaria
  // um arquivo de texto nomeado como mídia — este é o desvio certo.
  if (isHlsUrl(url)) return (await hlsBuffer(url, { item, referer, headers: customHeaders, onProgress, maxBytes })).buffer;

  const buffer = await fetchBuffer(url, {
    timeoutMs: 180_000,
    maxBytes,
    headers: {
      ...(referer ? { Referer: referer, referer } : {}),
      ...customHeaders
    }
  });

  // Servidor que devolveu a playlist mesmo sem `.m3u8` na URL (comum em CDN
  // com query string): aproveita o texto já baixado em vez de falhar.
  if (looksLikePlaylist(buffer)) {
    return (await downloadHlsFromText(buffer.toString('utf8'), url, {
      headers: customHeaders,
      referer,
      audioOnly: item.type === 'audio',
      quality: item.quality,
      maxBytes,
      onSegment: (done, total) => onProgress?.(wait(`Baixando stream HLS · ${done}/${total} segmentos`))
    })).buffer;
  }

  return buffer;
}

/** URL que já É o arquivo (foto, vídeo, GIF, áudio) — não é página nem player. */
const DIRECT_MEDIA_RE = /\.(jpg|jpeg|png|webp|avif|gif|mp4|webm|mov|m4v|mkv|mp3|m4a|opus|ogg|wav|flac)(\?|$)/i;
const DIRECT_VIDEO_RE = /\.(mp4|webm|mov|m4v|mkv)(\?|$)/i;

function directMediaKind(url) {
  if (/\.gif(\?|$)/i.test(url)) return 'gif';
  if (DIRECT_VIDEO_RE.test(url)) return 'video';
  if (/\.(mp3|m4a|opus|ogg|wav|flac)(\?|$)/i.test(url)) return 'audio';
  return 'image';
}

/**
 * Estratégia de link direto: `https://site/foto.jpg`, `/video.mp4`, `/anim.gif`.
 * Antes disso o bot só entregava esses links se o Cobalt os aceitasse — e o
 * Cobalt é um túnel para páginas, não para arquivos soltos.
 */
async function viaDirectMedia(url, { platform, audioOnly, maxBytes, onProgress }) {
  const kind = directMediaKind(url);
  if (kind === 'audio') {
    return { platform, kind: 'audio', buffers: [await downloadMedia({ url, type: 'audio' }, onProgress, maxBytes)], media: [{ type: 'audio', url }] };
  }
  if (audioOnly) {
    if (kind !== 'video') throw new Error('este link é uma imagem — não dá para extrair áudio dele');
    const buffer = await downloadMedia({ url, type: 'video' }, onProgress, maxBytes);
    if (!hasFfmpeg()) {
      const err = new Error('este link é um vídeo e o `.mp3` precisa do FFmpeg para extrair o áudio');
      err.hint = 'Instale com: pkg install ffmpeg (Termux) · apt install ffmpeg · winget install ffmpeg';
      throw err;
    }
    return {
      platform,
      kind: 'audio',
      buffers: [await applyAudioFilter(buffer, { filter: 'anull', ext: '.mp3', bitrate: '128k' })],
      media: [{ type: 'audio', url }]
    };
  }
  const type = kind === 'gif' ? 'gif' : kind;
  return {
    platform,
    kind: type,
    buffers: [await downloadMedia({ url, type }, onProgress, maxBytes)],
    media: [{ type, url }]
  };
}

/** Baixa um stream HLS e avisa o chat conforme os segmentos chegam. */
function hlsBuffer(url, { item = {}, referer, headers = {}, onProgress, maxBytes }) {
  log.dl(`hls: ${shortUrl(url)}…`);
  return downloadHls(url, {
    headers,
    referer,
    audioOnly: item.type === 'audio',
    quality: item.quality,
    maxBytes,
    onSegment: (done, total) => onProgress?.(wait(`Baixando stream HLS · ${done}/${total} segmentos`))
  });
}

/** Extrator dedicado por plataforma (null = usa o caminho genérico). */
async function byPlatform(url, platform, quality, audioOnly, maxBytes) {
  switch (platform) {
    case 'TikTok':
    case 'Douyin':
      // A tikwm atende o Douyin também: mesma cascata, mesmas reservas.
      return audioOnly ? tiktokAudio(url, { maxBytes }) : downloadTikTok(url, quality, { maxBytes });
    case 'Bluesky':
      return downloadBluesky(url, quality, { maxBytes });
    case 'Imgur':
      return downloadImgur(url, quality, { maxBytes });
    case 'Dailymotion':
      return downloadDailymotion(url, quality, { maxBytes });
    case 'ComedyHub':
      return downloadComedyHub(url, quality, { maxBytes });
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
    // Extratores próprios de Threads/Reddit/Twitch/Vimeo vivem em generic.js e
    // precisam ser chamados aqui: sem esta rota eles existiam mas nunca rodavam,
    // e o link caía direto no Cobalt (ou falhava) mesmo tendo extrator dedicado.
    case 'Threads':
    case 'Reddit':
    case 'Twitch':
    case 'Vimeo':
      return downloadByPlatform(url, platform, { maxBytes });
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

/** Baixa pelo yt-dlp local e devolve no formato dos demais extratores. */
async function viaYtdlp(url, platform, { audioOnly, maxBytes, onProgress }) {
  await onProgress?.(wait('Usando yt-dlp local'));
  const { buffer, info: ytInfo } = await ytdlpBuffer(url, { audioOnly, maxBytes });
  const info = ytInfo || (await ytdlpInfo(url).catch(() => null));
  return {
    platform,
    title: info?.title || '',
    author: info?.author || '',
    thumbnail: info?.thumbnail || '',
    duration: info?.duration || 0,
    kind: audioOnly ? 'audio' : 'video',
    buffers: [buffer],
    media: [{ type: audioOnly ? 'audio' : 'video', url }]
  };
}

/**
 * Resolve uma URL para um resultado pronto de download.
 * @param {string} url
 * @param {'melhor'|'alta'|'media'|'baixa'} quality
 * @param {{audioOnly?: boolean, onProgress?: Function, maxBytes?: number}} [opts]
 *   `maxBytes` limita o tamanho de cada arquivo baixado (o `.s <link>` usa um
 *   teto menor: não faz sentido baixar 200 MB para uma figurinha de 10 s).
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
  const preErrors = [];
  // Dica acionável (ex.: "o YouTube pediu verificação") que sobrevive à cascata
  // e chega ao usuário em vez de morrer no log.
  let failureHint = '';

  // Link `.m3u8` colado direto: o stream É o arquivo — o motor HLS baixa os
  // segmentos e entrega MP4 sem depender de Cobalt/yt-dlp.
  if (isHlsUrl(url)) {
    strategies.push([
      'hls',
      async () => {
        const hls = await downloadHls(url, {
          audioOnly,
          quality,
          maxBytes,
          onSegment: (done, total) => onProgress?.(wait(`Baixando stream HLS · ${done}/${total} segmentos`))
        });
        return {
          platform: 'Stream HLS',
          kind: hls.kind,
          duration: hls.duration,
          buffers: [hls.buffer],
          media: [{ type: hls.kind, url }],
          partial: hls.truncated || hls.live
        };
      }
    ]);
  } else if (DIRECT_MEDIA_RE.test(url)) {
    // Arquivo solto: baixa direto, sem depender de terceiros.
    strategies.push([
      'link direto',
      () => viaDirectMedia(url, { platform: platform === 'Web' ? 'Link direto' : platform, audioOnly, maxBytes, onProgress })
    ]);
  }

  // YouTube: o yt-dlp (com runtime JS) continua sendo o extrator mais forte —
  // resolve cifra, escolhe formato e cobre casos que a Innertube não alcança —
  // então vai PRIMEIRO. Quando ele cai no muro de verificação, a Innertube
  // (agora com URLs sondadas antes de usar) e o Cobalt assumem logo em seguida.
  // Só recebe a URL canônica montada a partir do ID, nunca a URL do usuário.
  const ytWatchUrl = platform === 'YouTube' ? youtubeWatchUrl(parseYouTubeId(url)) : null;
  let ytdlpTried = false;
  if (ytWatchUrl && canUseYtdlp(ytWatchUrl)) {
    ytdlpTried = true;
    try {
      const out = await viaYtdlp(ytWatchUrl, platform, { audioOnly, maxBytes, onProgress });
      if (out?.buffers?.length) return normalize(validateResultBufferLimits(out, maxBytes), platform);
    } catch (error) {
      const message = String(error?.message || error).slice(0, 200);
      preErrors.push(message);
      if (error?.hint) failureHint ||= error.hint;
      log.warn('yt-dlp (YouTube) falhou; tentando Innertube', { message });
    }
  }

  // `cobaltTried` sai true quando o extrator dedicado JÁ esgotou o Cobalt por
  // conta própria (inclusive ao lançar erro, que só acontece no fim da cascata
  // interna dele). Se ele devolveu uma URL cedo — Innertube, embed, oEmbed — o
  // Cobalt NÃO foi tentado, e repetir aqui é a diferença entre entregar a mídia
  // e responder "download falhou".
  let dedicatedCobaltTried = false;
  let dedicatedError = null;
  const dedicated = await byPlatform(url, platform, quality, audioOnly, maxBytes).catch((error) => {
    log.warn(`${platform} (dedicado) falhou`, { name: error?.name, status: error?.status, code: error?.code });
    dedicatedCobaltTried = error?.cobaltTried === true;
    dedicatedError = error;
    if (error?.hint) failureHint ||= error.hint;
    return null;
  });
  if (dedicated?.media?.length || dedicated?.buffers?.length) {
    const enriched = dedicated;
    const out = await withBuffers(enriched, onProgress, maxBytes).catch(async (error) => {
      log.warn('download de buffers falhou; tentando reservas', { name: error?.name, status: error?.status, code: error?.code });
      preErrors.push(`${platform}: ${String(error?.message || error).slice(0, 110)}`);
      return null;
    });
    if (out?.buffers?.length) return normalize(out, platform);
    dedicatedCobaltTried = dedicated.cobaltTried === true;
  }

  // ComedyHub: a página do meme é uma SPA e só monta o conteúdo DEPOIS do
  // login — as reservas genéricas (Cobalt, yt-dlp, scraping) não têm o que ler
  // e acabam devolvendo o `og:image` da página, que é a "foto de introdução" do
  // site. Melhor parar aqui, com o motivo real, do que entregar arquivo errado.
  if (platform === 'ComedyHub') {
    const error =
      dedicatedError ||
      new Error(preErrors[preErrors.length - 1] || 'não consegui extrair esse meme do ComedyHub');
    if (failureHint && !error.hint) error.hint = failureHint;
    error.details = [...(error.details || []), ...preErrors];
    throw error;
  }

  // Reservas em cascata.
  // Os extratores dedicados tentam o Cobalt por conta própria, então só vale
  // chamá-lo de novo quando ele NÃO chegou a rodar lá dentro (cauda longa, ou
  // extrator que devolveu uma URL que depois não baixou).
  const dedicatedTriesCobalt =
    dedicatedCobaltTried ||
    ((platform === 'TikTok' ||
      platform === 'Douyin' ||
      platform === 'Instagram' ||
      platform === 'Pinterest' ||
      platform === 'YouTube' ||
      platform === 'X (Twitter)' ||
      platform === 'Facebook') &&
      !dedicated);

  if (!dedicatedTriesCobalt) {
    strategies.push([
      'cobalt',
      async () => {
        const { buffers, audioBuffer, ...rest } = await cobaltDownload(url, quality, { audioOnly, maxBytes });
        return buffers?.length ? { ...rest, buffers, audioBuffer } : null;
      }
    ]);
  }

  const ytdlpUrl = ytWatchUrl || url;
  if (!ytdlpTried && canUseYtdlp(ytdlpUrl)) {
    strategies.push([
      'yt-dlp',
      async () => {
        const out = await viaYtdlp(ytdlpUrl, platform, { audioOnly, maxBytes, onProgress });
        return out?.buffers?.length ? out : null;
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

  // Última reserva: a URL não tem extensão nem extrator, mas o servidor pode
  // simplesmente servir um arquivo de mídia (anexo, CDN com query string,
  // imagem de fórum). Sonda os primeiros bytes e, se for mídia, baixa.
  strategies.push([
    'mídia servida',
    async () => {
      const probe = await probeStream(url, { timeoutMs: 12_000 });
      if (probe.verdict !== 'ok') return null;
      const type = kindByContentType(probe.contentType);
      if (!type && /mpegurl|vnd\.apple/i.test(String(probe.contentType))) {
        // HLS servido sem `.m3u8` na URL (CDN com query string, por exemplo).
        const hls = await downloadHls(url, {
          audioOnly,
          quality,
          maxBytes,
          onSegment: (done, total) => onProgress?.(wait(`Baixando stream HLS · ${done}/${total} segmentos`))
        });
        return {
          platform: 'Stream HLS',
          kind: hls.kind,
          duration: hls.duration,
          buffers: [hls.buffer],
          media: [{ type: hls.kind, url }],
          partial: hls.truncated || hls.live
        };
      }
      if (!type) return null;
      return {
        platform: platform === 'Web' ? 'Link direto' : platform,
        kind: audioOnly && type === 'video' ? 'video' : type,
        buffers: [await downloadMedia({ url, type, contentLength: probe.sizeBytes, ranged: false }, onProgress, maxBytes)],
        media: [{ type, url }]
      };
    }
  ]);

  let result;
  try {
    result = await firstOf(strategies);
  } catch (error) {
    if (preErrors.length) error.message = `${preErrors.join(' | ')} | ${error.message}`;
    if (failureHint && !error.hint) error.hint = failureHint;
    throw error;
  }
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
    audioBuffer: result.audioBuffer || null,
    // Stream cortado pelo teto de bytes (VOD de horas, HLS ao vivo): o envio
    // avisa o usuário em vez de entregar um arquivo incompleto em silêncio.
    partial: result.partial === true
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
    if (result.partial) {
      const note = warn(
        'Stream longo: enviei o trecho inicial',
        `o teto de ${maxMB} MB cortou o resto — ajuste com .config maxMB 200`
      );
      if (onProgress) await onProgress(note);
      else await sock.sendMessage(jid, { text: note }, sendOpts);
    }
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
