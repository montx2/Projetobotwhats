// 🛡️ ANTI-DELETE — retenção opt-in, por chat, com TTL e limites de mídia.
// O conteúdo recuperado é enviado apenas ao privado do dono; View Once nunca é
// incluída, e os filtros podem excluir grupos, privados ou JIDs específicos.

import { SYM, header as uiHeader, section as uiSection, kv, toggle } from '../core/ui.js';
import { cfg } from '../core/config.js';
import { log } from '../core/logger.js';
import { messageCache } from '../wa/cache.js';
import { formatDate, truncate, isGroup, normalizeJid } from '../util/text.js';
import { isAnimatedWebp } from '../util/webp.js';
import { downloadWhatsAppMedia, MAX_WHATSAPP_MEDIA_BYTES } from '../wa/media.js';
import { isViewOnce } from './viewonce.js';

/** O chat atual está na lista de ignorados? */
export function isIgnored(jid, list = cfg.get().antiDelete.ignorar) {
  for (const rule of list) {
    const r = String(rule).toLowerCase();
    if (r === 'grupos' || r === 'groups') {
      if (isGroup(jid)) return true;
    } else if (r === 'privado' || r === 'private' || r === 'pv') {
      if (!isGroup(jid)) return true;
    } else if (normalizeJid(r) === normalizeJid(jid)) {
      return true;
    } else if (r.includes('@') && normalizeJid(jid).startsWith(normalizeJid(r).replace(/@.*/, ''))) {
      return true;
    }
  }
  return false;
}

/** Normaliza alvo digitado pelo usuário. */
export function normalizeIgnoreTarget(arg, msg) {
  const a = String(arg || '').trim().toLowerCase();
  if (!a || ['aqui', 'este chat', 'esse chat'].includes(a)) return msg.key.remoteJid;
  if (['grupos', 'grupo', 'groups'].includes(a)) return 'grupos';
  if (['privado', 'pv', 'private', 'dm'].includes(a)) return 'privado';
  if (a.includes('@')) return a;
  if (/^\d{8,20}$/.test(a)) return `${a}@s.whatsapp.net`;
  return a;
}

const MEDIA_KEYS = ['imageMessage', 'videoMessage', 'audioMessage', 'stickerMessage', 'documentMessage'];

function unwrapMessage(message) {
  let current = message;
  const wrappers = ['ephemeralMessage', 'deviceSentMessage', 'documentWithCaptionMessage', 'editedMessage'];
  for (let i = 0; i < 6 && current; i++) {
    const wrapper = wrappers.find((key) => current[key]?.message);
    if (!wrapper) break;
    current = current[wrapper].message;
  }
  return current;
}

function findMedia(message) {
  const content = unwrapMessage(message);
  if (!content) return null;
  for (const k of MEDIA_KEYS) {
    if (content[k]) return { type: k, node: content[k] };
  }
  return null;
}

async function downloadDeletedMedia(sock, entry, chatJid, media) {
  const download = (node) => downloadWhatsAppMedia(node, String(media.type).replace(/Message$/, ''), {
    maxBytes: MAX_WHATSAPP_MEDIA_BYTES
  });
  try {
    return await download(media.node);
  } catch (firstError) {
    if (typeof sock?.updateMediaMessage !== 'function') throw firstError;
    const holder = {
      key: { remoteJid: chatJid, id: entry.id, fromMe: entry.fromMe },
      message: entry.message
    };
    const refreshed = await sock.updateMediaMessage(holder);
    const refreshedContent = unwrapMessage(refreshed?.message || refreshed);
    const node = refreshedContent?.[media.type] || media.node;
    return download(node);
  }
}

function header(entry, chatJid) {
  const who = entry.pushName || entry.sender?.split('@')[0] || 'Alguém';
  const where = isGroup(chatJid) ? `Grupo ${chatJid.split('@')[0]}` : `Chat ${chatJid.split('@')[0]}`;
  return [
    `${SYM.section} *ANTI-DELETE*  ${SYM.detail}  _mensagem apagada_`,
    kv('Autor', who),
    kv('Onde', where),
    kv('Enviada', formatDate(entry.ts))
  ].join('\n');
}

/**
 * Trata evento de mensagem apagada (protocolMessage REVOKE).
 * Envia SEMPRE apenas para o privado do dono (`ownerJid`), nunca para o grupo/chat original.
 */
export async function handleDelete(sock, revokeMsg, { ownerJid }) {
  const settings = cfg.get().antiDelete;
  if (!ownerJid || isGroup(ownerJid)) return false;

  const proto = revokeMsg.message?.protocolMessage;
  const targetKey = proto?.key;
  if (!targetKey?.id) return false;

  const chatJid = targetKey.remoteJid || revokeMsg.key.remoteJid;
  if (!Array.isArray(settings.chats) || !settings.chats.some((chat) => normalizeJid(chat) === normalizeJid(chatJid))) return false;
  if (isIgnored(chatJid, settings.ignorar)) return false;

  const entry = messageCache.get(chatJid, targetKey.id);
  if (!entry) return false;
  if (entry.fromMe) return false; // ignora apagadas pelo próprio bot/dono
  if (isViewOnce(entry.message)) return false; // não converte revogação em captura de View Once

  const caption = header(entry, chatJid);
  log.warn('anti-delete: mensagem apagada em chat habilitado; enviando ao privado do dono');

  const media = findMedia(entry.message);
  let sentMedia = false;

  if (media) {
    try {
      const buffer = await downloadDeletedMedia(sock, entry, chatJid, media);
      if (buffer?.length) {
        const payload =
          media.type === 'imageMessage'
            ? { image: buffer, caption }
            : media.type === 'videoMessage'
              ? { video: buffer, caption, gifPlayback: !!media.node.gifPlayback }
              : media.type === 'audioMessage'
                ? { audio: buffer, mimetype: media.node.mimetype || 'audio/ogg; codecs=opus', ptt: !!media.node.ptt }
                : media.type === 'stickerMessage'
                  ? {
                      sticker: buffer,
                      mimetype: 'image/webp',
                      width: 512,
                      height: 512,
                      isAnimated: isAnimatedWebp(buffer)
                    }
                  : {
                      document: buffer,
                      fileName: media.node.fileName || `apagado-${entry.id}.bin`,
                      mimetype: media.node.mimetype || 'application/octet-stream',
                      caption
                    };
        await sock.sendMessage(ownerJid, payload);
        if (media.type === 'audioMessage' || media.type === 'stickerMessage') {
          await sock.sendMessage(ownerJid, { text: caption });
        }
        sentMedia = true;
      }
    } catch (error) {
      log.warn('anti-delete: mídia irrecuperável', { name: error?.name, status: error?.status, code: error?.code });
    }
  }

  if (!sentMedia) {
    const text = extractAnyText(unwrapMessage(entry.message));
    await sock.sendMessage(ownerJid, {
      text: `${caption}\n\n${text ? `💬 "${truncate(text, 1800)}"` : '📎 [conteúdo de mídia não recuperável]'}`
    });
  }

  return true;
}

export function extractAnyText(message) {
  return (
    message?.conversation ||
    message?.extendedTextMessage?.text ||
    message?.imageMessage?.caption ||
    message?.videoMessage?.caption ||
    message?.documentMessage?.caption ||
    message?.documentWithCaptionMessage?.message?.documentMessage?.caption ||
    message?.buttonsResponseMessage?.selectedDisplayText ||
    message?.listResponseMessage?.title ||
    message?.templateButtonReplyMessage?.selectedDisplayText ||
    message?.pollCreationMessage?.name ||
    message?.pollCreationMessageV3?.name ||
    message?.contactMessage?.displayName ||
    message?.locationMessage?.name ||
    ''
  );
}

/** Texto de status do Anti-Delete no chat que o dono consultou. */
export function statusText(jid) {
  const s = cfg.get().antiDelete;
  const enabled = Array.isArray(s.chats) && s.chats.some((chat) => normalizeJid(chat) === normalizeJid(jid)) && !isIgnored(jid, s.ignorar);
  return [
    uiHeader('Anti-Delete', 'retenção opt-in por chat'),
    '',
    [
      kv('Neste chat', toggle(enabled, 'ativo', 'desativado')),
      kv('Chats habilitados', String(s.chats?.length || 0)),
      kv('Destino', 'somente o privado do dono'),
      kv('Retenção', 'até 24 horas; mídia limitada a 64 MB')
    ].join('\n'),
    '',
    uiSection('Filtros', s.ignorar.length ? s.ignorar : ['nenhum']),
    '',
    '_Use_ `.antidelete on aqui` _ou_ `.antidelete on <JID>` _para habilitar um chat._'
  ].join('\n');
}
