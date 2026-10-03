// Cache de metadados de grupo (lista de participantes).
//
// Sem isso, o Baileys faz uma consulta ao servidor do WhatsApp a CADA mensagem
// enviada em um grupo. Em jogos, que respondem várias vezes seguidas, isso deixa
// tudo mais lento e aumenta o risco de limitação de taxa. Com o cache, só a
// primeira mensagem consulta; as demais reaproveitam por alguns minutos.
//
// O cache é invalidado quando alguém entra/sai/é promovido (eventos do Baileys),
// então a lista de destinatários não fica velha.

export function createGroupMetadataCache({ fetch, ttlMs = 5 * 60_000, max = 300, now = Date.now } = {}) {
  const entries = new Map(); // jid -> { meta, at }
  const inflight = new Map(); // jid -> Promise (evita consultas duplicadas simultâneas)

  function fresh(jid) {
    const entry = entries.get(jid);
    if (!entry) return undefined;
    if (now() - entry.at > ttlMs) {
      entries.delete(jid);
      return undefined;
    }
    return entry.meta;
  }

  function set(jid, meta) {
    if (!jid || !meta) return;
    entries.delete(jid);
    entries.set(jid, { meta, at: now() });
    while (entries.size > max) entries.delete(entries.keys().next().value);
  }

  return {
    /** Usado como `cachedGroupMetadata` do Baileys. Nunca lança: em falha devolve undefined e o Baileys consulta sozinho. */
    async get(jid) {
      if (!jid) return undefined;
      const cached = fresh(jid);
      if (cached) return cached;
      if (typeof fetch !== 'function') return undefined;
      if (inflight.has(jid)) return inflight.get(jid);
      const pending = (async () => {
        try {
          const meta = await fetch(jid);
          if (meta && Array.isArray(meta.participants)) set(jid, meta);
          return meta || undefined;
        } catch {
          return undefined;
        } finally {
          inflight.delete(jid);
        }
      })();
      inflight.set(jid, pending);
      return pending;
    },
    set,
    invalidate(jid) {
      entries.delete(jid);
    },
    clear() {
      entries.clear();
    },
    size() {
      return entries.size;
    }
  };
}
