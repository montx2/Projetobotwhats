// 🔗➡️🖼️ FIGURINHA A PARTIR DE LINK — `.s <link>` do começo ao fim.
//
// Antes o `.s` só aceitava mídia anexada ou citada. Agora, se o comando (ou a
// mensagem citada) trouxer um link, o bot baixa pelo MESMO downloader universal
// do `.dl` e entrega a figurinha pronta: Pinterest, TikTok, Instagram, YouTube,
// X/Twitter, Facebook, Threads, Reddit, Giphy/Tenor e o que mais o extrator
// alcançar — sem o usuário precisar baixar nada antes.
//
// Três cuidados que fazem a figurinha sair certa de primeira:
//   1) LINK DIRETO DE MÍDIA (termina em .jpg/.png/.gif/.webp/.mp4…) pula toda a
//      cascata de extratores: baixa o arquivo e pronto. É o caso de boa parte
//      dos links de Pinterest/Giphy/Tenor copiados no celular.
//   2) TIPO REAL PELO CONTEÚDO: extrator que falha costuma devolver a CAPA
//      (um JPEG) no lugar do vídeo. Aqui os primeiros bytes mandam — vira
//      figurinha estática em vez de um "vídeo" que o WhatsApp recusa.
//   3) TETO DE TAMANHO: ninguém precisa baixar 200 MB para uma figurinha de 7 s.

import { fetchBuffer, formatBytes, mediaReferer, shortUrl } from '../core/http.js';
import { wait } from '../core/ui.js';
import { log } from '../core/logger.js';
import { detectMediaExt } from '../util/ffmpeg.js';
import { isWebp, isAnimatedWebp } from '../util/webp.js';
import { extractUrls } from '../util/text.js';
import { extractAnyText } from './antidelete.js';
import { kindByExtension } from './downloaders/media.js';
import { resolveDownload } from './download.js';
import { extractStickerSource, makeSticker } from './sticker.js';

/** Teto do download quando o destino é figurinha (7 s de WebP nunca precisa mais). */
export const MAX_STICKER_BYTES = 64 * 1024 * 1024;

/** Quantos links um único comando aceita (`.s link1 link2 link3`). */
export const MAX_STICKER_LINKS = 3;

const VIDEO_EXT = new Set(['.mp4', '.webm', '.mkv', '.mov', '.m4v', '.avi']);
const AUDIO_EXT = new Set(['.mp3', '.ogg', '.m4a', '.wav', '.aac', '.opus']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.webp', '.tif', '.tiff']);

/** Extensões de mídia que NÃO valem como domínio (evita ler "foto.png" como site). */
const MEDIA_TLDS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4', 'webm', 'mp3', 'mov', 'm4a', 'wav']);

const MIME_BY_KIND = {
  image: 'image/jpeg',
  video: 'video/mp4',
  gif: 'image/gif',
  animated: 'image/webp',
  audio: 'audio/mpeg'
};

/** O link aponta direto para um arquivo de mídia (não para uma página)? */
export function isDirectMediaUrl(url) {
  return kindByExtension(url) !== 'unknown';
}

/**
 * Tipo real da mídia olhando os bytes (o extrator mente; o arquivo não).
 * @returns {'image'|'video'|'gif'|'animated'|'audio'}
 */
export function detectSourceKind(buffer, declared = '') {
  if (declared === 'audio') return 'audio';
  const ext = String(detectMediaExt(buffer, '.bin')).toLowerCase();
  if (ext === '.gif') return 'gif';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (ext === '.webp') return isWebp(buffer) && isAnimatedWebp(buffer) ? 'animated' : 'image';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (declared === 'video' || declared === 'gif' || declared === 'animated') return declared;
  return 'image';
}

/**
 * Traduz um buffer baixado para o formato que o motor de figurinhas entende:
 * `{ buffer, type, node }` — o mesmo que vem de uma mídia do WhatsApp.
 */
export function stickerSourceFromBuffer(buffer, declared = '') {
  const kind = detectSourceKind(buffer, declared);
  const type = kind === 'video' || kind === 'gif' || kind === 'animated' ? 'video' : kind === 'audio' ? 'audio' : 'image';
  const node = { mimetype: MIME_BY_KIND[kind] || 'image/jpeg' };
  if (kind === 'gif') node.gifPlayback = true;
  return { buffer, kind, type, node, mime: node.mimetype };
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return 'link';
  }
}

/** O servidor devolveu a página em vez do arquivo (link de CDN expirado, "baixe aqui"…). */
function looksLikeHtml(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 15) return false;
  const head = buffer.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<?xml');
}

/**
 * Aceita `https://…`, `www.…` e até o domínio colado sem esquema (`pin.it/abc`).
 * @returns {string|null} URL utilizável ou null se o token não for link.
 */
export function normalizeStickerLink(raw) {
  const cleaned = String(raw || '')
    .trim()
    .replace(/[.,;!?]+$/, '');
  if (!cleaned || /\s/.test(cleaned)) return null;
  if (/^https?:\/\//i.test(cleaned)) return cleaned;
  if (!/^(?:[\w-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#][^\s]*)?$/i.test(cleaned)) return null;
  const tld = cleaned.split(/[/?#]/)[0].split('.').pop().toLowerCase();
  if (MEDIA_TLDS.has(tld)) return null;
  return `https://${cleaned}`;
}

/** Links do comando (e da mensagem citada), na ordem, sem repetir. */
export function collectStickerLinks(args = [], quotedText = '') {
  const found = [];
  const push = (candidate) => {
    const url = normalizeStickerLink(candidate);
    if (url && !found.includes(url)) found.push(url);
  };
  for (const url of extractUrls(args.join(' '))) push(url);
  for (const arg of args) push(arg);
  for (const url of extractUrls(String(quotedText || ''))) push(url);
  return found;
}

/** Texto da mensagem citada — um link citado também vira figurinha. */
export function quotedStickerText(msg) {
  const m = msg?.message || {};
  const quoted =
    m.extendedTextMessage?.contextInfo?.quotedMessage ||
    m.imageMessage?.contextInfo?.quotedMessage ||
    m.videoMessage?.contextInfo?.quotedMessage ||
    m.documentMessage?.contextInfo?.quotedMessage ||
    m.stickerMessage?.contextInfo?.quotedMessage ||
    null;
  return quoted ? extractAnyText(quoted) : '';
}

/**
 * Qual mídia do resultado vira figurinha.
 * Carrossel/slideshow: prefere a primeira FOTO (um story de 1 s como figurinha
 * quase sempre decepciona); nos demais, a mídia principal.
 */
function pickMediaIndex(result) {
  const media = result.media || [];
  if (!media.length) return 0;
  if (result.kind === 'carrossel' || result.kind === 'slideshow') {
    const i = media.findIndex((m) => m?.type === 'image' || m?.type === 'gif');
    if (i >= 0) return i;
  }
  return 0;
}

/**
 * Erro do downloader explicado para quem só quer uma figurinha.
 * O caso clássico: link de vídeo longo estoura o teto de tamanho do `.s`.
 */
function rewordDownloadError(error, maxBytes) {
  const message = String(error?.message || error);
  if (!/grande demais|maxBytes/i.test(message)) return error;
  return new Error(
    `o arquivo desse link passa de ${formatBytes(maxBytes)} — grande demais para uma figurinha de 7 s. ` +
      'Use um link de vídeo curto (TikTok, Reels, Pin) ou baixe tudo com `.dl <link>`.'
  );
}

/**
 * Baixa a mídia de um link já pronta para o motor de figurinhas.
 * @param {string} url
 * @param {{onProgress?: Function, maxBytes?: number}} [opts]
 * @returns {Promise<{buffer: Buffer, kind: string, type: string, node: object, mime: string, via: string, title: string, author: string, platform: string}>}
 */
export async function downloadStickerSource(url, { onProgress, maxBytes = MAX_STICKER_BYTES } = {}) {
  // 1) Atalho: o link JÁ é o arquivo de mídia.
  if (isDirectMediaUrl(url)) {
    await onProgress?.(wait(`Baixando a mídia de ${hostOf(url)}`));
    const referer = mediaReferer(url);
    const buffer = await fetchBuffer(url, {
      timeoutMs: 120_000,
      maxBytes,
      headers: referer ? { Referer: referer, referer } : {}
    });
    if (looksLikeHtml(buffer)) {
      throw new Error(
        'esse endereço devolveu uma PÁGINA, não a mídia. Copie o link direto do arquivo (normalmente termina em .jpg, .png, .gif ou .mp4) ou mande o link da publicação com `.s <link>`.'
      );
    }
    const info = stickerSourceFromBuffer(buffer, kindByExtension(url));
    log.dl(`figurinha de link direto: ${shortUrl(url)} (${formatBytes(buffer.length)}, ${info.kind})`);
    return { ...info, platform: hostOf(url), title: '', author: '', via: `link direto · ${hostOf(url)}` };
  }

  // 2) Caminho completo: o downloader universal (.dl) resolve a rede e já
  //    publica o progresso dele ("Buscando em Pinterest · Melhor…" etc).
  const result = await resolveDownload(url, 'melhor', { onProgress, maxBytes }).catch((error) => {
    throw rewordDownloadError(error, maxBytes);
  });
  const index = pickMediaIndex(result);
  const buffer = result.buffers?.[index] || result.buffers?.[0];
  if (!buffer?.length) throw new Error('o link não devolveu mídia para a figurinha');

  const declared = result.media?.[index]?.type || result.kind;
  const info = stickerSourceFromBuffer(buffer, declared === 'carrossel' || declared === 'slideshow' ? 'image' : declared);
  if (info.kind === 'audio') {
    throw new Error('esse link é só áudio — não dá para virar figurinha. Para baixar o áudio use `.dl <link>`.');
  }

  const platform = result.platform || hostOf(url);
  log.dl(`figurinha de link: ${shortUrl(url)} → ${platform} (${formatBytes(buffer.length)}, ${info.kind})`);
  return {
    ...info,
    platform,
    title: result.title || '',
    author: result.author || '',
    via: `via ${platform}`
  };
}

/**
 * Baixa o link e devolve o WebP final, já com pack/autor/EXIF do bot.
 * @returns {Promise<{webp: Buffer, source: object}>}
 */
export async function makeStickerFromLink(url, { fit = 'fill', removeBg = false, pack, author, emojis, onProgress, maxBytes } = {}) {
  const source = await downloadStickerSource(url, { onProgress, maxBytes });
  await onProgress?.(wait('Montando a figurinha'));
  const webp = await makeSticker(source, { removeBg, pack, author, emojis, fit, onProgress });
  return { webp, source };
}

/**
 * Descobre de onde sai a figurinha do comando:
 *   1) mídia anexada ou citada (comportamento original do `.s`);
 *   2) sem mídia, os links do próprio comando ou da mensagem citada.
 * Cada link que falhar não derruba os outros: só o erro de todos é fatal.
 *
 * @returns {Promise<{sources: Array<{buffer: Buffer, type: string, node: object, via: string|null, link?: string}>, failures: string[], skipped: number}>}
 */
export async function stickerSourcesForCommand({
  sock,
  msg,
  args = [],
  quotedText,
  allowViewOnce = false,
  onProgress,
  maxLinks = MAX_STICKER_LINKS
} = {}) {
  // Anexo/citação tem prioridade absoluta sobre qualquer link no texto.
  const media = await extractStickerSource(sock, msg, { onProgress, allowViewOnce });
  if (media) return { sources: [{ ...media, via: null }], failures: [], skipped: 0 };

  const links = collectStickerLinks(args, quotedText ?? quotedStickerText(msg));
  if (!links.length) return { sources: [], failures: [], skipped: 0 };

  const targets = links.slice(0, maxLinks);
  const sources = [];
  const failures = [];

  for (let i = 0; i < targets.length; i++) {
    if (targets.length > 1) await onProgress?.(wait(`Baixando link ${i + 1}/${targets.length}`));
    try {
      const source = await downloadStickerSource(targets[i], { onProgress });
      sources.push({ ...source, link: targets[i] });
    } catch (error) {
      log.warn(`figurinha do link ${shortUrl(targets[i])} falhou: ${error.message}`);
      failures.push(`${shortUrl(targets[i])}: ${String(error.message || error).slice(0, 120)}`);
    }
  }

  if (!sources.length) {
    const err = new Error(failures[0] || 'não consegui baixar esse link');
    err.failures = failures;
    throw err;
  }
  return { sources, failures, skipped: Math.max(0, links.length - targets.length) };
}
