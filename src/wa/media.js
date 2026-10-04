import { collectLimited } from '../util/stream.js';

export const MAX_WHATSAPP_MEDIA_BYTES = 64 * 1024 * 1024;

let baileysPromise = null;
async function getBaileys() {
  if (!baileysPromise) {
    baileysPromise = import('@whiskeysockets/baileys');
  }
  return baileysPromise;
}

function declaredLength(node) {
  const value = node?.fileLength;
  try {
    if (value && typeof value.toNumber === 'function') return value.toNumber();
    if (typeof value === 'bigint') return Number(value);
    return Number(value) || 0;
  } catch {
    return 0;
  }
}

export async function downloadWhatsAppMedia(node, mediaType, { maxBytes = MAX_WHATSAPP_MEDIA_BYTES } = {}) {
  const requestedLimit = Number(maxBytes);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.max(1, Math.floor(requestedLimit))
    : MAX_WHATSAPP_MEDIA_BYTES;
  const length = declaredLength(node);
  if (length > limit) throw new Error(`mídia excede o limite de ${Math.floor(limit / 1024 / 1024)} MB`);
  const { downloadContentFromMessage } = await getBaileys();
  const stream = await downloadContentFromMessage(node, mediaType);
  const buffer = await collectLimited(stream, limit);
  if (!buffer.length) throw new Error('mídia vazia');
  return buffer;
}

export function getDeclaredMediaLength(node) {
  return declaredLength(node);
}
