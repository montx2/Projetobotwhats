// 👁️ VIEW ONCE — captura 100% silenciosa de mensagens de visualização única.
//
// 1) AUTO: toda view once REAL recebida é baixada em silêncio e enviada SOMENTE para o privado do dono.
// 2) RESPOSTA: se o dono responder uma view once REAL em qualquer chat, o bot baixa em silêncio
//    e envia SOMENTE para o privado do dono (0 rastros na conversa ou no grupo).

import { SYM, kv } from '../core/ui.js';
import { downloadMediaMessage, downloadContentFromMessage } from '@whiskeysockets/baileys';
import { cfg } from '../core/config.js';
import { log, baileysLogger } from '../core/logger.js';
import { formatDate, isGroup } from '../util/text.js';
import { formatBytes } from '../core/http.js';
import { messageCache } from '../wa/cache.js';

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

  const errors = [];
  const strategies = [
    () =>
      downloadMediaMessage(
        { key: msg.key, message: { [vo.type]: node } },
        'buffer',
        {},
        { logger: baileysLogger, reuploadRequest: sock.updateMediaMessage }
      ),
    () => downloadMediaMessage(msg, 'buffer', {}, { logger: baileysLogger, reuploadRequest: sock.updateMediaMessage }),
    async () => {
      const stream = await downloadContentFromMessage(node, vo.type.replace(/Message$/, ''));
      const chunks = [];
      for await (const c of stream) chunks.push(c);
      return Buffer.concat(chunks);
    },
    async () => {
      if (typeof sock.updateMediaMessage !== 'function') throw new Error('reupload indisponível');
      const refreshed = await sock.updateMediaMessage(msg);
      return downloadMediaMessage(refreshed, 'buffer', {}, { logger: baileysLogger, reuploadRequest: sock.updateMediaMessage });
    }
  ];

  for (const strategy of strategies) {
    try {
      const buffer = await strategy();
      if (buffer?.length) return { buffer, type: vo.type, node };
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
 * Envia a mídia capturada EXCLUSIVAMENTE para o privado do dono (`ctx.ownerJid`).
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
    log.ok(`view once capturada em silêncio (${formatBytes(buffer.length)}) → ${dest}`);
  } catch (error) {
    log.error('falha ao entregar view once pro dono', error);
  }
}

/**
 * Handler principal chamado pelo roteador para mensagens recebidas.
 * 100% silencioso: envia somente para `ownerJid`, zero rastro no chat de origem.
 */
export async function onViewOnceMessage(sock, msg, { ownerJid }) {
  const settings = cfg.get().viewOnce;
  if (!settings.auto) return false;
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
    log.warn(`view once não baixada: ${error.message}`);
    return false;
  }
}

const recentCaptures = new Set();

/**
 * Captura via resposta: quando o DONO responde uma view once REAL em qualquer conversa/grupo.
 * Baixa em silêncio e envia SOMENTE para o privado do dono (0 rastros no chat original).
 */
export async function onViewOnceReply(sock, msg, { ownerJid, senderIsOwner }) {
  if (!senderIsOwner || !ownerJid || isGroup(ownerJid)) return false;

  const ctx = getReplyContextInfo(msg.message);
  if (!ctx) return false;

  // Caso A: a citação carrega o conteúdo view once completo.
  if (quotedViewOnce(msg.message)) {
    try {
      const fake = {
        key: {
          remoteJid: msg.key.remoteJid,
          id: ctx.stanzaId || msg.key.id,
          fromMe: false,
          ...(ctx.participant ? { participant: ctx.participant } : {})
        },
        message: ctx.quotedMessage
      };
      const result = await downloadViewOnceMedia(sock, fake);
      await deliver(
        sock,
        { msg, ownerJid, isAuto: false },
        { pushName: msg.pushName, key: fake.key, ts: Date.now() },
        result
      );
      return true;
    } catch (error) {
      log.warn(`view once por resposta falhou na citação: ${error.message}`);
    }
  }

  // Caso B: citação chegou como placeholder ou sem mediaKey — procura no cache se a original era view once REAL.
  const quotedId = ctx.stanzaId;
  if (!quotedId) return false;
  const cached = messageCache.get(msg.key.remoteJid, quotedId) || messageCache.getById(quotedId);
  if (!cached || !isViewOnce(cached.message)) return false;

  try {
    const fake = { key: { remoteJid: msg.key.remoteJid, id: quotedId, fromMe: false }, message: cached.message };
    const result = await downloadViewOnceMedia(sock, fake);
    await deliver(sock, { msg, ownerJid, isAuto: false }, cached, result);
    return true;
  } catch (error) {
    log.warn(`view once por resposta falhou no cache: ${error.message}`);
    return false;
  }
}
