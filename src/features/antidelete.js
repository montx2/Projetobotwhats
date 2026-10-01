// 🛡️ ANTI-DELETE — nada some.
// Quando alguém apaga uma mensagem, o bot envia o conteúdo recuperado
// EXCLUSIVAMENTE para o privado do dono (nunca vaza no grupo ou no chat alheio).
// Filtros de ignorar configuráveis:
//   .antidelete ignorar grupos | privado | <jid> | aqui

import { SYM, header as uiHeader, section as uiSection, kv, toggle } from '../core/ui.js';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { cfg } from '../core/config.js';
import { log, baileysLogger } from '../core/logger.js';
import { messageCache } from '../wa/cache.js';
import { formatDate, truncate, isGroup } from '../util/text.js';
import { isAnimatedWebp } from '../util/webp.js';

/** O chat atual está na lista de ignorados? */
export function isIgnored(jid, list = cfg.get().antiDelete.ignorar) {
  for (const rule of list) {
    const r = String(rule).toLowerCase();
    if (r === 'grupos' || r === 'groups') {
      if (isGroup(jid)) return true;
    } else if (r === 'privado' || r === 'private' || r === 'pv') {
      if (!isGroup(jid)) return true;
    } else if (r === jid.toLowerCase()) {
      return true;
    } else if (jid.toLowerCase().startsWith(r.replace(/@.*/, '')) && r.includes('@')) {
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

function findMedia(message) {
  if (!message) return null;
  for (const k of MEDIA_KEYS) {
    if (message[k]) return { type: k, node: message[k] };
  }
  return null;
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
  if (!settings.ativo) return false;
  if (!ownerJid || isGroup(ownerJid)) return false;

  const proto = revokeMsg.message?.protocolMessage;
  const targetKey = proto?.key;
  if (!targetKey?.id) return false;

  const chatJid = targetKey.remoteJid || revokeMsg.key.remoteJid;
  if (isIgnored(chatJid, settings.ignorar)) return false;

  const entry = messageCache.get(chatJid, targetKey.id) || messageCache.getById(targetKey.id);
  if (!entry) return false;
  if (entry.fromMe) return false; // ignora apagadas pelo próprio bot/dono

  const caption = header(entry, chatJid);
  log.warn(`anti-delete: mensagem apagada em ${chatJid} (${targetKey.id}) → enviando ao dono`);

  const media = findMedia(entry.message);
  let sentMedia = false;

  if (media) {
    try {
      const buffer = await downloadMediaMessage(
        { key: { remoteJid: chatJid, id: entry.id, fromMe: false }, message: entry.message },
        'buffer',
        {},
        { logger: baileysLogger, reuploadRequest: sock.updateMediaMessage }
      );
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
      log.warn(`anti-delete: mídia irrecuperável (${error.message})`);
    }
  }

  if (!sentMedia) {
    const text = extractAnyText(entry.message);
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

/** Texto de status do anti-delete para o comando .antidelete */
export function statusText(jid) {
  const s = cfg.get().antiDelete;
  const ignoredHere = isIgnored(jid, s.ignorar);
  return [
    uiHeader('Anti-Delete', 'proteção silenciosa'),
    '',
    [
      kv('Status', toggle(s.ativo, 'ativo', 'desativado')),
      kv('Destino', 'somente o seu privado'),
      kv('Neste chat', ignoredHere ? `${SYM.off} ignorado` : `${SYM.on} monitorado`)
    ].join('\n'),
    '',
    uiSection('Filtros', s.ignorar.length ? s.ignorar : ['nenhum, protegendo tudo']),
    '',
    '_Adicione com_ `.antidelete ignorar grupos`'
  ].join('\n');
}
