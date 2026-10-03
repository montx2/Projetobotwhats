// Mantém saudável a "memória de chaves de grupo" (sender-key-memory) do Baileys.
//
// Por que existe: para falar num grupo, o Baileys manda a cada participante a
// chave do grupo UMA vez e anota isso em `sender-key-memory`. Só que, na linha
// 6.7.x, essa anotação quase nunca é apagada: se alguém troca de celular,
// reinstala o WhatsApp ou o bot entra num grupo novo e a troca de chaves falha,
// o bot "acha" que aquela pessoa já tem a chave e nunca a reenvia. Resultado:
// "Aguardando mensagem. Essa ação pode levar alguns instantes." para sempre.
//
// O que fazemos: apagamos a anotação do grupo (o Baileys então reenvia a chave a
// todos no próximo envio) quando:
//   • o bot entra num grupo novo;
//   • a lista de participantes muda;
//   • a anotação ficou "velha" (renovação periódica, 1x por hora por padrão).
// Reenviar a chave é barato em grupos pequenos; em grupos enormes só reiniciamos
// nos eventos acima, nunca no automático.

const DEFAULT_REFRESH_MS = 60 * 60_000;
const DEFAULT_MAX_PARTICIPANTS = 256;
const MAX_TRACKED_GROUPS = 1000;

const isGroupJid = (jid) => typeof jid === 'string' && jid.endsWith('@g.us');

export function createSenderKeyKeeper({
  refreshMs = DEFAULT_REFRESH_MS,
  maxParticipants = DEFAULT_MAX_PARTICIPANTS,
  now = Date.now,
  onError
} = {}) {
  const lastReset = new Map(); // jid do grupo -> quando zeramos pela última vez

  function remember(jid) {
    lastReset.delete(jid);
    lastReset.set(jid, now());
    while (lastReset.size > MAX_TRACKED_GROUPS) lastReset.delete(lastReset.keys().next().value);
  }

  /** Apaga a memória de chaves do grupo. Nunca lança. Devolve true se apagou. */
  async function reset(sock, jid) {
    if (!isGroupJid(jid)) return false;
    const keys = sock?.authState?.keys;
    if (typeof keys?.set !== 'function') return false;
    try {
      // Mesma chamada que o próprio Baileys usa ao atender um pedido de reenvio.
      await keys.set({ 'sender-key-memory': { [jid]: null } });
      remember(jid);
      return true;
    } catch (error) {
      onError?.(error);
      return false;
    }
  }

  /**
   * Renovação automática antes de enviar para um grupo. Zera se nunca zeramos
   * desde que o bot subiu ou se passou o prazo. Grupos grandes ficam de fora.
   */
  async function refreshIfStale(sock, jid, participantCount) {
    if (!refreshMs || !isGroupJid(jid)) return false;
    if (Number.isFinite(participantCount) && participantCount > maxParticipants) return false;
    const last = lastReset.get(jid);
    if (last !== undefined && now() - last < refreshMs) return false;
    return reset(sock, jid);
  }

  return {
    reset,
    refreshIfStale,
    size: () => lastReset.size,
    clear: () => lastReset.clear()
  };
}

/**
 * Contador de tentativas de reenvio com validade (interface CacheStore do Baileys).
 * Fica no módulo (não no socket), então sobrevive às reconexões e o limite de
 * tentativas por mensagem realmente vale.
 */
export function createRetryCounterCache({ ttlMs = 60 * 60_000, max = 5000, now = Date.now } = {}) {
  const entries = new Map(); // chave -> { value, at }
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (now() - entry.at > ttlMs) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, { value, at: now() });
      while (entries.size > max) entries.delete(entries.keys().next().value);
    },
    del(key) {
      entries.delete(key);
    },
    flushAll() {
      entries.clear();
    },
    size: () => entries.size
  };
}
