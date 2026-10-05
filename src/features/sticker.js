// 🖼️ STICKER ENGINE — figurinhas de imagem, vídeo, GIF e outras figurinhas,
// com remoção de fundo por IA (.sfundo). O pack/autor são fixos (config.js).
//
// A mídia vem de duas origens: anexada/citada no WhatsApp (extractStickerSource)
// ou baixada de um LINK pelo `stickerlink.js` — as duas chegam aqui no mesmo
// formato `{ buffer, type, node }`, então o motor não precisa saber a diferença.

import { cfg } from '../core/config.js';
import { log } from '../core/logger.js';
import { SYM } from '../core/ui.js';
import { toStickerWebp, decodeWebpToPng, detectMediaExt, hasFfmpeg, STICKER_MAX_SECONDS, STICKER_ANIMATED_SPEC_BYTES } from '../util/ffmpeg.js';
import {
  isWebp,
  isAnimatedWebp,
  parseWebp,
  readStickerExif,
  tagSticker,
  trimAnimatedWebp,
  webpDurationMs
} from '../util/webp.js';
import { removeBackground } from './bgremoval.js';
import { formatBytes } from '../core/http.js';
import { messageCache } from '../wa/cache.js';
import { downloadWhatsAppMedia, MAX_WHATSAPP_MEDIA_BYTES } from '../wa/media.js';

const MEDIA_MAP = {
  imageMessage: 'image',
  videoMessage: 'video',
  stickerMessage: 'sticker'
};

const WRAPPERS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
  'editedMessage'
];

function unwrapMessage(message) {
  let cur = message;
  for (let i = 0; i < 6 && cur; i++) {
    let next = null;
    for (const w of WRAPPERS) {
      if (cur[w]?.message) {
        next = cur[w].message;
        break;
      }
    }
    if (!next) break;
    cur = next;
  }
  return cur;
}

function pickType(rawMessage, unwrapViewOnce) {
  const message = unwrapMessage(rawMessage);
  if (!message) return null;

  for (const [rawType, kind] of Object.entries(MEDIA_MAP)) {
    if (message[rawType]) return { type: kind, rawType, node: message[rawType] };
  }

  if (message.documentMessage) {
    const doc = message.documentMessage;
    const mime = String(doc.mimetype || '').toLowerCase();
    const name = String(doc.fileName || '').toLowerCase();
    if (mime.includes('webp') || name.endsWith('.webp')) {
      return { type: 'sticker', rawType: 'documentMessage', node: doc };
    }
    if (mime.startsWith('video/') || mime.includes('gif') || /\.(mp4|mov|webm|mkv|gif)$/i.test(name)) {
      return { type: 'video', rawType: 'documentMessage', node: doc };
    }
    if (mime.startsWith('image/') || /\.(jpe?g|png|bmp)$/i.test(name)) {
      return { type: 'image', rawType: 'documentMessage', node: doc };
    }
  }

  const vo = unwrapViewOnce(rawMessage);
  if (vo && vo.type !== 'audioMessage') {
    return {
      type: MEDIA_MAP[vo.type] || 'image',
      rawType: vo.type,
      node: vo.node
    };
  }
  return null;
}

function findContextInfo(rawMessage) {
  const m = unwrapMessage(rawMessage) || rawMessage || {};
  return (
    m.extendedTextMessage?.contextInfo ||
    m.imageMessage?.contextInfo ||
    m.videoMessage?.contextInfo ||
    m.stickerMessage?.contextInfo ||
    m.documentMessage?.contextInfo ||
    rawMessage?.extendedTextMessage?.contextInfo ||
    null
  );
}

/** A citação aponta para uma mensagem de visualização única? */
function isQuotedViewOnce(rawMessage, unwrapViewOnce) {
  const m = unwrapMessage(rawMessage) || rawMessage || {};
  const quoted =
    m.extendedTextMessage?.contextInfo?.quotedMessage ||
    m.imageMessage?.contextInfo?.quotedMessage ||
    m.videoMessage?.contextInfo?.quotedMessage ||
    m.stickerMessage?.contextInfo?.quotedMessage ||
    null;
  return Boolean(quoted && unwrapViewOnce(quoted));
}

async function downloadStickerMedia(sock, holder, picked) {
  const { rawType, node } = picked;
  const mediaKind = String(rawType || 'imageMessage').replace(/Message$/, '');
  const errors = [];
  try {
    return await downloadWhatsAppMedia(node, mediaKind, { maxBytes: MAX_WHATSAPP_MEDIA_BYTES });
  } catch (error) {
    errors.push(String(error?.message || error).slice(0, 100));
  }

  if (typeof sock?.updateMediaMessage === 'function') {
    try {
      const refreshed = await sock.updateMediaMessage(holder);
      const message = unwrapMessage(refreshed?.message);
      const refreshedNode = message?.[rawType];
      if (!refreshedNode) throw new Error('mídia não encontrada após atualizar');
      return await downloadWhatsAppMedia(refreshedNode, mediaKind, { maxBytes: MAX_WHATSAPP_MEDIA_BYTES });
    } catch (error) {
      errors.push(String(error?.message || error).slice(0, 100));
    }
  }
  throw new Error(`Não consegui baixar a mídia (${errors[0] || 'erro desconhecido'})`);
}

const ALL_MEDIA_MAP = {
  imageMessage: 'image',
  videoMessage: 'video',
  stickerMessage: 'sticker',
  audioMessage: 'audio'
};

function pickAnyType(rawMessage, unwrapViewOnce) {
  const message = unwrapMessage(rawMessage);
  if (!message) return null;

  for (const [rawType, kind] of Object.entries(ALL_MEDIA_MAP)) {
    if (message[rawType]) return { type: kind, rawType, node: message[rawType] };
  }

  if (message.documentMessage) {
    const doc = message.documentMessage;
    const mime = String(doc.mimetype || '').toLowerCase();
    const name = String(doc.fileName || '').toLowerCase();
    if (mime.includes('webp') || name.endsWith('.webp')) {
      return { type: 'sticker', rawType: 'documentMessage', node: doc };
    }
    if (mime.startsWith('audio/') || /\.(mp3|ogg|wav|m4a|aac|opus|flac)$/i.test(name)) {
      return { type: 'audio', rawType: 'documentMessage', node: doc };
    }
    if (mime.startsWith('video/') || mime.includes('gif') || /\.(mp4|mov|webm|mkv|gif)$/i.test(name)) {
      return { type: 'video', rawType: 'documentMessage', node: doc };
    }
    if (mime.startsWith('image/') || /\.(jpe?g|png|bmp)$/i.test(name)) {
      return { type: 'image', rawType: 'documentMessage', node: doc };
    }
  }

  const vo = unwrapViewOnce(rawMessage);
  if (vo) {
    return {
      type: ALL_MEDIA_MAP[vo.type] || (vo.type === 'audioMessage' ? 'audio' : 'image'),
      rawType: vo.type,
      node: vo.node
    };
  }
  return null;
}

export async function extractAnyMediaSource(sock, msg, { onProgress, allowViewOnce = false } = {}) {
  const { unwrapViewOnce } = await import('./viewonce.js');
  const m = msg.message || {};

  if (!allowViewOnce && (unwrapViewOnce(m) || isQuotedViewOnce(m, unwrapViewOnce))) {
    return null;
  }

  const direct = pickAnyType(m, unwrapViewOnce);
  if (direct) {
    await onProgress?.(`${SYM.wait} Baixando mídia…`);
    const buffer = await downloadStickerMedia(sock, msg, direct);
    return { buffer, type: direct.type, node: direct.node };
  }

  const ctx = findContextInfo(m);
  const quoted = ctx?.quotedMessage;
  if (quoted) {
    const q = pickAnyType(quoted, unwrapViewOnce);
    if (q) {
      await onProgress?.(`${SYM.wait} Baixando mídia citada…`);
      const fake = {
        key: {
          remoteJid: msg.key.remoteJid,
          id: ctx.stanzaId || msg.key.id,
          fromMe: false,
          ...(ctx.participant ? { participant: ctx.participant } : {})
        },
        message: unwrapMessage(quoted) || quoted
      };
      try {
        const buffer = await downloadStickerMedia(sock, fake, q);
        return { buffer, type: q.type, node: q.node };
      } catch (err) {
        if (ctx.stanzaId) {
          const cached = messageCache.get(msg.key.remoteJid, ctx.stanzaId);
          const cq = cached && pickAnyType(cached.message, unwrapViewOnce);
          if (cq) {
            const cachedHolder = {
              key: { remoteJid: msg.key.remoteJid, id: cached.id, fromMe: !!cached.fromMe },
              message: cached.message
            };
            const buffer = await downloadStickerMedia(sock, cachedHolder, cq);
            return { buffer, type: cq.type, node: cq.node };
          }
        }
        throw err;
      }
    }
  }

  if (ctx?.stanzaId) {
    const cached = messageCache.get(msg.key.remoteJid, ctx.stanzaId);
    const cq = cached && pickAnyType(cached.message, unwrapViewOnce);
    if (cq) {
      await onProgress?.(`${SYM.wait} Baixando mídia do histórico…`);
      const cachedHolder = {
        key: { remoteJid: msg.key.remoteJid, id: cached.id, fromMe: !!cached.fromMe },
        message: cached.message
      };
      const buffer = await downloadStickerMedia(sock, cachedHolder, cq);
      return { buffer, type: cq.type, node: cq.node };
    }
  }

  return null;
}

/**
 * Extrai a mídia citada/anexada relevante para figurinha.
 *
 * @param {object} opts
 * @param {boolean} [opts.allowViewOnce=false] Só o dono no próprio privado pode
 *   transformar uma view once em figurinha. Em grupos/chats ativados a extração
 *   de view once é BLOQUEADA, para o bot nunca republicar mídia de visualização
 *   única (0 rastros).
 */
export async function extractStickerSource(sock, msg, { onProgress, allowViewOnce = false } = {}) {
  const { unwrapViewOnce } = await import('./viewonce.js');
  const m = msg.message || {};

  // View once como origem: só no privado do dono.
  if (!allowViewOnce && (unwrapViewOnce(m) || isQuotedViewOnce(m, unwrapViewOnce))) {
    return null;
  }

  // 1) mídia anexada direto (ou anexada como view once / efêmera)
  const direct = pickType(m, unwrapViewOnce);
  if (direct) {
    await onProgress?.(`${SYM.wait} Baixando mídia…`);
    const buffer = await downloadStickerMedia(sock, msg, direct);
    return { buffer, type: direct.type, node: direct.node };
  }

  // 2) mídia citada (reply), inclusive citação de view once ou cacheada
  const ctx = findContextInfo(m);
  const quoted = ctx?.quotedMessage;
  if (quoted) {
    const q = pickType(quoted, unwrapViewOnce);
    if (q) {
      await onProgress?.(`${SYM.wait} Baixando mídia citada…`);
      const fake = {
        key: {
          remoteJid: msg.key.remoteJid,
          id: ctx.stanzaId || msg.key.id,
          fromMe: false,
          ...(ctx.participant ? { participant: ctx.participant } : {})
        },
        message: unwrapMessage(quoted) || quoted
      };
      try {
        const buffer = await downloadStickerMedia(sock, fake, q);
        return { buffer, type: q.type, node: q.node };
      } catch (err) {
        // Fallback: tenta recuperar do cache de mensagens se a citação veio incompleta
        if (ctx.stanzaId) {
          const cached = messageCache.get(msg.key.remoteJid, ctx.stanzaId);
          const cq = cached && pickType(cached.message, unwrapViewOnce);
          if (cq) {
            const cachedHolder = {
              key: { remoteJid: msg.key.remoteJid, id: cached.id, fromMe: !!cached.fromMe },
              message: cached.message
            };
            const buffer = await downloadStickerMedia(sock, cachedHolder, cq);
            return { buffer, type: cq.type, node: cq.node };
          }
        }
        throw err;
      }
    }
  }

  // 3) Citação veio como placeholder vazio — procura no messageCache pelo stanzaId
  if (ctx?.stanzaId) {
    const cached = messageCache.get(msg.key.remoteJid, ctx.stanzaId);
    const cq = cached && pickType(cached.message, unwrapViewOnce);
    if (cq) {
      await onProgress?.(`${SYM.wait} Baixando mídia do histórico…`);
      const cachedHolder = {
        key: { remoteJid: msg.key.remoteJid, id: cached.id, fromMe: !!cached.fromMe },
        message: cached.message
      };
      const buffer = await downloadStickerMedia(sock, cachedHolder, cq);
      return { buffer, type: cq.type, node: cq.node };
    }
  }

  return null;
}

/**
 * Cria figurinha a partir da mídia.
 * @returns {Promise<Buffer>} webp pronto para enviar (com VP8X + EXIF válidos)
 */
export async function makeSticker(source, { removeBg = false, pack, author, emojis, fit = 'fill', onProgress } = {}) {
  let { buffer } = source;
  const { type, node } = source;
  const mime = String(node?.mimetype || '').toLowerCase();
  const magicExt = detectMediaExt(buffer, '');
  const isStickerInput = type === 'sticker' || type === 'stickerMessage' || mime.includes('webp') || isWebp(buffer);

  if (isStickerInput) {
    if (!isWebp(buffer)) throw new Error('webp inválido');
    if (removeBg) {
      if (!hasFfmpeg()) {
        throw new Error('FFmpeg não encontrado — rode `.doctor` para ver como instalar.');
      }
      await onProgress?.(`${SYM.wait} Decodificando figurinha…`);
      const { buffer: png } = await decodeWebpToPng(buffer);
      await onProgress?.(`${SYM.wait} Removendo o fundo…`);
      const { buffer: cut, via } = await removeBackground(png);
      await onProgress?.(`${SYM.wait} Fundo removido (${via}) · criando figurinha 512×512…`);
      const { buffer: webp } = await toStickerWebp(cut, { animated: false, ext: '.png', fit, onProgress });
      await onProgress?.(`${SYM.wait} Gravando dados da figurinha…`);
      return tagSticker(webp, { pack, author, emojis });
    }

    const info = parseWebp(buffer);
    const oldExif = readStickerExif(buffer);
    const finalEmojis = emojis?.length ? emojis : oldExif?.emojis;

    // Figurinha animada vinda de fora: o WhatsApp aceita no máximo 10 s. O
    // FFmpeg não decodifica WebP animado, então o corte é feito no contêiner
    // (quadros ANMF finais fora) — sem reencode, sem perder qualidade.
    if (info.animated) {
      const durationMs = webpDurationMs(buffer);
      if (durationMs > STICKER_MAX_SECONDS * 1000) {
        const trim = trimAnimatedWebp(buffer, STICKER_MAX_SECONDS * 1000);
        if (trim.dropped > 0) {
          log.info(
            `figurinha animada de ${(durationMs / 1000).toFixed(1)} s cortada para ` +
              `${(trim.durationMs / 1000).toFixed(1)} s (${trim.dropped} quadro(s) fora do limite)`
          );
          await onProgress?.(
            `${SYM.wait} Cortando a figurinha em ${STICKER_MAX_SECONDS} s (limite do WhatsApp)…`
          );
          buffer = trim.buffer;
        }
      }
      if (buffer.length > STICKER_ANIMATED_SPEC_BYTES) {
        log.warn(
          `figurinha animada de ${formatBytes(buffer.length)} acima dos 500 KB do WhatsApp; ` +
            'reenvie como imagem/vídeo para o bot reencodar dentro do limite'
        );
      }
      await onProgress?.(`${SYM.wait} Gravando dados da figurinha…`);
      return tagSticker(buffer, { pack, author, emojis: finalEmojis });
    }

    // Se for um WebP estático fora do padrão 512x512 e tivermos FFmpeg, padroniza em 512x512
    if (!info.animated && (info.width !== 512 || info.height !== 512) && hasFfmpeg()) {
      await onProgress?.(`${SYM.wait} Ajustando figurinha para 512×512…`);
      const { buffer: webp } = await toStickerWebp(buffer, { animated: false, ext: '.webp', fit, onProgress });
      await onProgress?.(`${SYM.wait} Gravando dados da figurinha…`);
      return tagSticker(webp, { pack, author, emojis: finalEmojis });
    }

    await onProgress?.(`${SYM.wait} Gravando dados da figurinha…`);
    return tagSticker(buffer, { pack, author, emojis: finalEmojis });
  }

  if (!hasFfmpeg()) {
    throw new Error('FFmpeg não encontrado — rode `.doctor` para ver como instalar.');
  }

  const isGif = magicExt === '.gif' || mime.includes('gif') || !!node?.gifPlayback;
  const isVideo =
    type === 'video' ||
    type === 'videoMessage' ||
    mime.startsWith('video/') ||
    magicExt === '.mp4' ||
    magicExt === '.webm' ||
    isGif;

  if (removeBg && isVideo) {
    throw new Error('Remoção de fundo funciona apenas com imagens. Envie uma foto.');
  }

  if (removeBg) {
    log.info('sticker com remoção de fundo…');
    await onProgress?.(`${SYM.wait} Removendo o fundo… (pode levar alguns segundos)`);
    const { buffer: cut, via } = await removeBackground(buffer);
    log.ok(`fundo removido via ${via} (${formatBytes(cut.length)})`);
    await onProgress?.(`${SYM.wait} Fundo removido (${via}) · convertendo para figurinha 512×512…`);
    const { buffer: webp } = await toStickerWebp(cut, { animated: false, ext: '.png', fit, onProgress });
    await onProgress?.(`${SYM.wait} Gravando dados da figurinha…`);
    return tagSticker(webp, { pack, author, emojis });
  }

  await onProgress?.(
    `${SYM.wait} ${
      isVideo
        ? `Convertendo vídeo/GIF em figurinha animada (até ${STICKER_MAX_SECONDS} s)…`
        : 'Convertendo imagem em figurinha 512×512…'
    }`
  );
  const ext = magicExt || (isGif ? '.gif' : isVideo ? '.mp4' : mime.includes('png') ? '.png' : '.jpg');
  const { buffer: webp } = await toStickerWebp(buffer, { animated: isVideo, ext, fit, onProgress });
  await onProgress?.(`${SYM.wait} Gravando dados da figurinha…`);
  return tagSticker(webp, { pack, author, emojis });
}

const FIT_WORDS = {
  contain: ['inteira', 'inteiro', 'full', 'original', 'normal', 'contain', 'proporcao', 'proporção'],
  cover: ['cortar', 'corte', 'crop', 'cover', 'centro'],
  fill: ['preencher', 'esticar', 'fill']
};

/**
 * Lê o filtro de enquadramento nos argumentos do comando (.s inteira | .s cortar | .s).
 * @returns {'fill'|'contain'|'cover'} padrão 'fill' (preenche o quadrado todo)
 */
export function parseFit(args = []) {
  const words = args.map((a) => String(a).toLowerCase().replace(/^[-–—]+/, ''));
  for (const [fit, list] of Object.entries(FIT_WORDS)) {
    if (words.some((w) => list.includes(w))) return fit;
  }
  return 'fill';
}

/** Info do pack atual para comandos. */
export function packInfo() {
  const c = cfg.get();
  return { pack: c.nomePack, author: c.autorPack };
}

export { isAnimatedWebp };
