// 🔗➡️🖼️ FIGURINHA A PARTIR DE LINK — `.s <link>` do começo ao fim.
//
// Antes o `.s` só aceitava mídia anexada ou citada. Agora, se o comando (ou a
// mensagem citada) trouxer um link, o bot baixa pelo MESMO downloader universal
// do `.dl` e entrega a figurinha pronta: Pinterest, TikTok, Instagram, YouTube,
// X/Twitter, Facebook, Threads, Reddit, Giphy/Tenor e o que mais o extrator
// alcançar — sem o usuário precisar baixar nada antes.
//
// Quatro cuidados que fazem a figurinha sair certa de primeira:
//   0) CONTEÚDO CONFERIDO: extrator que devolve asset de marca (o gradiente que
//      o Pinterest serve na página de login) não passa — a imagem é medida
//      antes de virar figurinha (ver `inspectCandidate`).
//   1) LINK DIRETO DE MÍDIA (termina em .jpg/.png/.gif/.webp/.mp4…) pula toda a
//      cascata de extratores: baixa o arquivo e pronto. É o caso de boa parte
//      dos links de Pinterest/Giphy/Tenor copiados no celular.
//   2) TIPO REAL PELO CONTEÚDO: extrator que falha costuma devolver a CAPA
//      (um JPEG) no lugar do vídeo. Aqui os primeiros bytes mandam — vira
//      figurinha estática em vez de um "vídeo" que o WhatsApp recusa.
//   3) TETO DE TAMANHO: ninguém precisa baixar 200 MB para uma figurinha de 10 s.

import { fetchBuffer, formatBytes, mediaReferer, shortUrl } from '../core/http.js';
import { wait } from '../core/ui.js';
import { log } from '../core/logger.js';
import { analyzeImageDetail, detectMediaExt } from '../util/ffmpeg.js';
import { isUsableImageSize, sniffImage } from '../util/imageinfo.js';
import { isWebp, isAnimatedWebp } from '../util/webp.js';
import { extractUrls } from '../util/text.js';
import { extractAnyText } from './antidelete.js';
import { kindByExtension } from './downloaders/media.js';
import { resolveDownload } from './download.js';
import { extractStickerSource, makeSticker } from './sticker.js';

/** Teto do download quando o destino é figurinha (10 s de WebP nunca precisa mais). */
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
 * Ordem em que os candidatos do extrator são considerados.
 * Carrossel/slideshow: prefere a primeira FOTO (um story de 1 s como figurinha
 * quase sempre decepciona); nos demais, a mídia principal e depois as rendições
 * alternativas (mesma imagem em outro tamanho).
 */
function candidateList(result) {
  const media = result.media || [];
  const buffers = result.buffers || [];
  const order = media.map((_, i) => i);
  if (result.kind === 'carrossel' || result.kind === 'slideshow') {
    order.sort((a, b) => {
      const photo = (i) => (media[i]?.type === 'image' || media[i]?.type === 'gif' ? 0 : 1);
      return photo(a) - photo(b) || a - b;
    });
  }
  const out = order.map((i) => ({
    item: media[i] || {},
    buffer: buffers[i] || null,
    url: media[i]?.url || '',
    // Mídia que o extrator marcou como NÃO confiável (og:image de página que
    // pode não ser o post, scrape genérico) precisa passar na validação de
    // conteúdo antes de virar figurinha.
    trusted: media[i]?.trusted !== false
  }));
  for (const alt of result.alternates || []) {
    if (!alt?.url) continue;
    out.push({ item: alt, buffer: null, url: alt.url, trusted: alt.trusted !== false });
  }
  if (!out.some((c) => c.buffer?.length || c.url) && buffers[0]?.length) {
    out.push({ item: { type: result.kind }, buffer: buffers[0], url: '', trusted: true });
  }
  return out;
}

/**
 * O buffer é mesmo a mídia do post?
 *
 * Confiança declarada pelo extrator passa direto (ele consultou o post pelo id);
 * o que veio de página/scrape precisa de prova: ser imagem de verdade, ter
 * tamanho de imagem e CONTEÚDO de imagem — gradiente/chapado é o asset de
 * "rascunho" que as redes servem quando escondem o post do bot (foi assim que
 * uma figurinha colorida sem sentido saiu no lugar do pin do Flamengo).
 */
async function inspectCandidate(candidate) {
  const { buffer, item } = candidate;
  const kind = detectSourceKind(buffer, item?.type || '');
  // Áudio tem erro próprio (o link é só som, não é asset errado).
  if (kind === 'audio') return { ok: true, kind, reason: '' };

  if (kind === 'image') {
    const info = sniffImage(buffer);
    if (!info) {
      return { ok: false, kind, info: null, reason: 'não é uma imagem (o servidor devolveu outra coisa)' };
    }
    if (candidate.trusted) return { ok: true, kind, info, reason: '' };

    if (!isUsableImageSize(info, { min: 64 })) {
      return {
        ok: false,
        kind,
        info,
        reason: `imagem pequena demais (${info.width}x${info.height}) para ser o post`
      };
    }
    const grade = await analyzeImageDetail(buffer).catch(() => null);
    if (!grade) {
      // Sem FFmpeg não há como olhar o conteúdo — e sem ele o motor de figurinha
      // não roda de qualquer forma. Melhor recusar do que mandar asset de marca.
      return {
        ok: false,
        kind,
        info,
        reason: 'não consegui confirmar que a imagem é do post (FFmpeg indisponível — veja `.doctor`)'
      };
    }
    if (grade.smooth || grade.solid) {
      return {
        ok: false,
        kind,
        info,
        grade,
        reason: grade.solid
          ? 'imagem de uma cor só (placeholder da rede social, não o post)'
          : 'imagem lisa/gradiente (asset de marca da rede social, não o post)'
      };
    }
    return { ok: true, kind, info, grade, reason: '' };
  }

  // Vídeo/GIF que o extrator NÃO garantiu ser do post: confere o 1º quadro
  // (o FFmpeg decodifica igual) para não entregar vídeo de anúncio/banner.
  if (!candidate.trusted) {
    const grade = await analyzeImageDetail(buffer).catch(() => null);
    if (grade?.smooth || grade?.solid) {
      return {
        ok: false,
        kind,
        grade,
        reason: 'vídeo sem conteúdo de post (primeiro quadro é liso/chapado — asset de marca)'
      };
    }
  }
  return { ok: true, kind, reason: '' };
}

/**
 * Escolhe o melhor candidato válido: usa o buffer já baixado pelo downloader ou
 * baixa o da rendição alternativa. Candidato reprovado não derruba o processo —
 * vai para a lista de recusas, que explica o erro quando nada sobra.
 */
async function pickStickerCandidate(result, { onProgress, maxBytes = MAX_STICKER_BYTES } = {}) {
  const candidates = candidateList(result);
  const rejections = [];
  for (const candidate of candidates) {
    let buffer = candidate.buffer;
    if (!buffer?.length) {
      if (!candidate.url) continue;
      try {
        const referer = mediaReferer(candidate.url);
        buffer = await fetchBuffer(candidate.url, {
          timeoutMs: 120_000,
          maxBytes,
          headers: referer ? { Referer: referer, referer } : {}
        });
      } catch (error) {
        rejections.push({ url: candidate.url, reason: String(error.message || error).slice(0, 90) });
        continue;
      }
    }
    if (looksLikeHtml(buffer)) {
      rejections.push({ url: candidate.url || '(buffer)', reason: 'o servidor devolveu uma página em vez da mídia' });
      continue;
    }
    const verdict = await inspectCandidate({ ...candidate, buffer });
    if (verdict.ok) return { ...verdict, buffer, candidate };
    log.warn(`figurinha: candidato recusado (${shortUrl(candidate.url || 'buffer')}): ${verdict.reason}`);
    rejections.push({ url: candidate.url || '(buffer)', reason: verdict.reason });
  }
  return { ok: false, rejections };
}

/** Erro final explicado: o que foi recusado e o que fazer. */
function noUsableMediaError(url, rejections = []) {
  const first = rejections[0];
  const detail = first ? `${shortUrl(first.url)}: ${first.reason}` : 'nenhum candidato utilizável';
  const pinterest = /pinterest|pin\.it/i.test(String(url));
  const err = new Error(
    `não encontrei a mídia real desse link — ${detail}. ` +
      (pinterest
        ? 'O Pinterest costuma devolver só a página de login (com um gradiente da própria Pinterest) ' +
          'quando esconde o pin; tente de novo em alguns segundos.'
        : 'Tente de novo ou baixe antes com `.dl <link>` para ver o que o link devolve.')
  );
  err.rejections = rejections;
  return err;
}

/**
 * Erro do downloader explicado para quem só quer uma figurinha.
 * O caso clássico: link de vídeo longo estoura o teto de tamanho do `.s`.
 */
function rewordDownloadError(error, maxBytes) {
  const message = String(error?.message || error);
  if (!/grande demais|maxBytes/i.test(message)) return error;
  return new Error(
    `o arquivo desse link passa de ${formatBytes(maxBytes)} — grande demais para uma figurinha de 10 s. ` +
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

  const picked = await pickStickerCandidate(result, { onProgress, maxBytes });
  if (!picked.ok) throw noUsableMediaError(url, picked.rejections);

  const buffer = picked.buffer;
  const info = stickerSourceFromBuffer(buffer, picked.kind);
  if (info.kind === 'audio') {
    throw new Error('esse link é só áudio — não dá para virar figurinha. Para baixar o áudio use `.dl <link>`.');
  }

  const platform = result.platform || hostOf(url);
  const check = picked.grade ? ` · conferido (${picked.grade.verdict})` : '';
  log.dl(`figurinha de link: ${shortUrl(url)} → ${platform} (${formatBytes(buffer.length)}, ${info.kind}${check})`);
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
      log.warn(`figurinha do link ${shortUrl(targets[i])} falhou`, { name: error?.name, status: error?.status, code: error?.code });
      failures.push(`${shortUrl(targets[i])}: ${String(error.message || error).slice(0, 200)}`);
    }
  }

  if (!sources.length) {
    const err = new Error(failures[0] || 'não consegui baixar esse link');
    err.failures = failures;
    throw err;
  }
  return { sources, failures, skipped: Math.max(0, links.length - targets.length) };
}
