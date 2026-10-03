// 👁️ VIEW ONCE — automático somente nos chats que o dono habilitou explicitamente.
// Captura por resposta livre foi removida; uma mensagem comum nunca dispara download.

import { SYM, kv } from '../core/ui.js';
import { cfg } from '../core/config.js';
import { log } from '../core/logger.js';
import { formatDate, isGroup, normalizeJid } from '../util/text.js';
import { formatBytes } from '../core/http.js';
import { downloadWhatsAppMedia, MAX_WHATSAPP_MEDIA_BYTES } from '../wa/media.js';

// Wrappers explícitos de visualização única.
const VO_WRAPPERS = [
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension'
];

// Wrappers neutros que podem conter uma viewOnceMessage lá dentro.
const OUTER_WRAPPERS = [
  'ephemeralMessage',
  'documentWithCaptionMessage',
  'editedMessage'
];

const MEDIA_TYPES = ['imageMessage', 'videoMessage', 'audioMessage'];

function plainKey(key) {
  if (!key) return null;
  try {
    if (Buffer.isBuffer(key)) return key.length ? key : null;
    if (key instanceof Uint8Array) return key.length ? Buffer.from(key) : null;
    if (typeof key === 'string') {
      const b = Buffer.from(key, 'base64');
      return b.length ? b : null;
    }
    if (key?.type === 'Buffer' && Array.isArray(key.data)) return Buffer.from(key.data);
    if (Array.isArray(key)) return Buffer.from(key);
    if (typeof key === 'object') {
      const vals = Object.keys(key)
        .filter((k) => /^\d+$/.test(k))
        .sort((a, b) => Number(a) - Number(b))
        .map((k) => key[k]);
      if (vals.length) return Buffer.from(vals);
    }
  } catch {}
  return null;
}

function normalizeNode(node) {
  if (!node || typeof node !== 'object') return node;
  const copy = { ...node };
  const k = plainKey(copy.mediaKey);
  if (k) copy.mediaKey = k;
  return copy;
}

/**
 * Desembrulha uma mensagem view once REAL.
 * Retorna { type, node } SOMENTE se estiver dentro de viewOnceMessage*
 * OU se o próprio nó de mídia tiver `viewOnce: true`.
 * Fotos, vídeos e áudios comuns retornam `null`.
 */
export function unwrapViewOnce(message, insideVoWrapper = false) {
  if (!message || typeof message !== 'object') return null;

  for (const wrapper of VO_WRAPPERS) {
    const inner = message[wrapper]?.message;
    if (inner) {
      const found = unwrapViewOnce(inner, true);
      if (found) return found;
    }
  }

  for (const wrapper of OUTER_WRAPPERS) {
    const inner = message[wrapper]?.message;
    if (inner) {
      const found = unwrapViewOnce(inner, insideVoWrapper);
      if (found) return found;
    }
  }

  for (const type of MEDIA_TYPES) {
    const node = message[type];
    if (node && (insideVoWrapper || node.viewOnce === true)) {
      return { type, node };
    }
  }
  return null;
}

export function isViewOnce(message) {
  return !!unwrapViewOnce(message);
}

function getReplyContextInfo(message) {
  if (!message || typeof message !== 'object') return null;
  return (
    message.extendedTextMessage?.contextInfo ||
    message.imageMessage?.contextInfo ||
    message.videoMessage?.contextInfo ||
    message.stickerMessage?.contextInfo ||
    message.documentMessage?.contextInfo ||
    message.ephemeralMessage?.message?.extendedTextMessage?.contextInfo ||
    null
  );
}

/** Mensagem citada (reply) contém uma view once REAL? */
export function quotedViewOnce(message) {
  const ctx = getReplyContextInfo(message);
  if (!ctx?.quotedMessage) return null;
  return unwrapViewOnce(ctx.quotedMessage);
}

/** Baixa a mídia de uma view once com múltiplas estratégias. */
export async function downloadViewOnceMedia(sock, msg) {
  const vo = unwrapViewOnce(msg.message) || quotedViewOnce(msg.message);
  if (!vo) throw new Error('não é uma mensagem de visualização única');
  const node = normalizeNode(vo.node);
  const mediaType = vo.type.replace(/Message$/, '');
  const errors = [];

  try {
    const buffer = await downloadWhatsAppMedia(node, mediaType, { maxBytes: MAX_WHATSAPP_MEDIA_BYTES });
    return { buffer, type: vo.type, node };
  } catch (error) {
    errors.push(String(error?.message || error).slice(0, 90));
  }

  // Reupload is a bounded retry: the refreshed node is still streamed through
  // the same 64 MB cap rather than materialized by downloadMediaMessage.
  if (typeof sock.updateMediaMessage === 'function') {
    try {
      const refreshed = await sock.updateMediaMessage(msg);
      const refreshedVo = unwrapViewOnce(refreshed?.message) || vo;
      const refreshedNode = normalizeNode(refreshedVo.node);
      const buffer = await downloadWhatsAppMedia(refreshedNode, refreshedVo.type.replace(/Message$/, ''), {
        maxBytes: MAX_WHATSAPP_MEDIA_BYTES
      });
      return { buffer, type: refreshedVo.type, node: refreshedNode };
    } catch (error) {
      errors.push(String(error?.message || error).slice(0, 90));
    }
  }
  throw new Error(`não consegui baixar a view once (${errors.join(' | ').slice(0, 240)})`);
}

function captionFor(source, { auto }) {
  const chatJid = source.key?.remoteJid || '';
  const who =
    source.pushName ||
    source.sender?.split('@')[0] ||
    source.key?.participant?.split('@')[0] ||
    chatJid.split('@')[0] ||
    'desconhecido';
  const where = isGroup(chatJid) ? `Grupo ${chatJid.split('@')[0]}` : `Chat ${chatJid.split('@')[0]}`;
  return [
    `${SYM.section} *VIEW ONCE*  ${SYM.detail}  _${auto ? 'capturada' : 'baixada'}_`,
    kv('De', who),
    kv('Onde', where),
    kv('Recebida', formatDate(source.ts || Date.now()))
  ].join('\n');
}


/**
 * Envia a mídia após opt-in EXCLUSIVAMENTE para o privado do dono (`ctx.ownerJid`).
 * Trava de segurança: nunca envia para grupos nem para conversas de terceiros.
 */
async function deliver(sock, ctx, source, result) {
  const dest = ctx.ownerJid;
  if (!dest || isGroup(dest)) return;
  const caption = captionFor(source, { auto: ctx.isAuto });
  const { buffer, type, node } = result;

  try {
    if (type === 'imageMessage') {
      await sock.sendMessage(dest, { image: buffer, caption });
    } else if (type === 'videoMessage') {
      await sock.sendMessage(dest, { video: buffer, caption, gifPlayback: !!node.gifPlayback });
    } else {
      await sock.sendMessage(dest, {
        audio: buffer,
        mimetype: node?.mimetype || 'audio/ogg; codecs=opus',
        ptt: !!node?.ptt
      });
      await sock.sendMessage(dest, { text: caption });
    }
    log.ok(`view once opt-in enviada ao privado do dono (${formatBytes(buffer.length)})`);
  } catch (error) {
    log.error('falha ao entregar view once pro dono', { name: error?.name, status: error?.status, code: error?.code });
  }
}

/**
 * Handler principal chamado pelo roteador para mensagens recebidas.
 * Automação opt-in: envia somente para `ownerJid` e não responde no chat de origem.
 */
export async function onViewOnceMessage(sock, msg, { ownerJid }) {
  const settings = cfg.get().viewOnce;
  const chatJid = msg?.key?.remoteJid;
  if (!Array.isArray(settings.autoChats) || !settings.autoChats.some((chat) => normalizeJid(chat) === normalizeJid(chatJid))) return false;
  if (!ownerJid || isGroup(ownerJid)) return false;
  if (msg.key.fromMe) return false;
  if (!isViewOnce(msg.message)) return false;

  const dedupeKey = `${msg.key.remoteJid}:${msg.key.id}`;
  if (recentCaptures.has(dedupeKey)) return false;
  recentCaptures.add(dedupeKey);
  if (recentCaptures.size > 500) recentCaptures.delete(recentCaptures.values().next().value);

  try {
    const result = await downloadViewOnceMedia(sock, msg);
    await deliver(sock, { msg, ownerJid, isAuto: true }, msg, result);
    return true;
  } catch (error) {
    log.warn('view once não baixada', { name: error?.name, status: error?.status, code: error?.code });
    return false;
  }
}

const recentCaptures = new Set();
