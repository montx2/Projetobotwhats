// Filtro de mensagens antigas.
//
// Quando o bot (re)conecta, o WhatsApp entrega o backlog do que chegou enquanto ele
// estava offline (e sincroniza histórico em contas recém-pareadas). Sem filtro, o bot
// tratava cada mensagem velha como nova: reexecutava comandos, recapturava view once
// e reavisava apagamentos — dezenas de mensagens no privado do dono de uma vez.

export const BOOT_TS = Date.now();
const BOOT_GRACE_MS = 20_000; // tolerância para relógio do celular x bot
const MAX_AGE_MS = 120_000; // mensagem com mais de 2 min não é "ao vivo"

function timestampMs(msg) {
  const raw = msg?.messageTimestamp;
  const n = Number(raw?.toNumber ? raw.toNumber() : raw);
  return Number.isFinite(n) && n > 0 ? n * 1000 : null;
}

/**
 * true = mensagem antiga/histórico: só guardar no cache, NÃO agir.
 * @param {object} msg mensagem do Baileys
 * @param {string} [type] tipo do upsert: 'notify' (ao vivo) | 'append' (histórico) | 'update'
 */
export function isStale(msg, type, { now = Date.now(), boot = BOOT_TS } = {}) {
  if (type === 'update') return false; // revoke vindo de messages.update é sempre do momento
  if (type === 'append') return true;
  const ts = timestampMs(msg);
  if (ts === null) return false;
  return ts < boot - BOOT_GRACE_MS || now - ts > MAX_AGE_MS;
}

// Evita processar duas vezes a mesma mensagem (reentrega ao reconectar).
// Atenção: revokes reaproveitam a key da mensagem original e por isso NÃO passam
// por aqui (o router os isenta) — deduplicá-los mataria o anti-delete.
const seen = new Set();
export function alreadySeen(msg) {
  const id = msg?.key?.id;
  if (!id) return false;
  const k = `${msg.key.remoteJid}:${id}:${msg.key.fromMe ? 1 : 0}`;
  if (seen.has(k)) return true;
  seen.add(k);
  if (seen.size > 3000) seen.delete(seen.values().next().value);
  return false;
}
