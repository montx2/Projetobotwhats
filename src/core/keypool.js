// KeyPool — o motor de "contas ilimitadas" do NEXUS.
//
// A ideia: vários provedores gratuitos cobram por chave/conta. Em vez de UMA
// chave, você configura VÁRIAS (de contas diferentes) e o pool gira entre elas
// em round-robin. Quando uma chave estoura o limite (HTTP 402/403/429), ela
// entra em "geladeira" (cooldown) e o pool passa para a próxima. Resultado:
// praticamente requisições ilimitadas, igual você já fazia. 🚀

export class KeyPool {
  /**
   * @param {string} name nome para logs (ex: "remove.bg")
   * @param {string[]} items chaves, URLs ou instâncias
   * @param {{cooldownMs?: number}} opts
   */
  constructor(name, items = [], { cooldownMs = 5 * 60_000 } = {}) {
    this.name = name;
    this.items = [...new Set(items.filter(Boolean).map((i) => String(i).trim()).filter(Boolean))];
    this.cooldownMs = cooldownMs;
    this.index = 0;
    this.cooldowns = new Map(); // item -> timestamp de liberação
    this.stats = new Map(); // item -> { ok, fail }
  }

  get size() {
    return this.items.length;
  }

  get available() {
    const now = Date.now();
    return this.items.filter((i) => !this.cooldowns.has(i) || this.cooldowns.get(i) <= now).length;
  }

  #touch(item, field) {
    const s = this.stats.get(item) || { ok: 0, fail: 0 };
    s[field] += 1;
    this.stats.set(item, s);
  }

  /** Próximo item saudável (round-robin). Retorna null se não houver nenhum. */
  next(skip = new Set()) {
    if (!this.items.length) return null;
    const now = Date.now();
    for (let i = 0; i < this.items.length; i++) {
      const idx = (this.index + i) % this.items.length;
      const item = this.items[idx];
      if (skip.has(item)) continue;
      const blockedUntil = this.cooldowns.get(item);
      if (!blockedUntil || blockedUntil <= now) {
        this.index = (idx + 1) % this.items.length;
        return item;
      }
    }
    // Todos em cooldown: devolve o que libera antes (melhor que nada).
    const fallback = [...this.items].filter((i) => !skip.has(i))
      .sort((a, b) => (this.cooldowns.get(a) || 0) - (this.cooldowns.get(b) || 0))[0];
    return fallback ?? null;
  }

  /** Marca sucesso (tira da geladeira). */
  reportSuccess(item) {
    this.cooldowns.delete(item);
    this.#touch(item, 'ok');
  }

  /** Marca falha: item entra em cooldown. */
  reportFailure(item, { cooldownMs = this.cooldownMs, reason = '' } = {}) {
    this.cooldowns.set(item, Date.now() + cooldownMs);
    this.#touch(item, 'fail');
    return reason;
  }

  /**
   * Executa `fn(item)` girando pelo pool até alguém ter sucesso.
   * `isExhausted(error)` decide se o erro é de limite (cooldown) ou fatal.
   */
  async run(fn, { isExhausted = defaultIsExhausted, label = '' } = {}) {
    if (!this.items.length) throw new Error(`Pool "${this.name}" vazio: configure pelo menos 1 item.`);
    const tried = new Set();
    const errors = [];
    while (tried.size < this.items.length) {
      const item = this.next(tried);
      if (!item) break;
      tried.add(item);
      try {
        const result = await fn(item);
        this.reportSuccess(item);
        return result;
      } catch (error) {
        errors.push(error);
        if (isExhausted(error)) {
          this.reportFailure(item, { reason: error?.message || 'limite' });
        } else {
          this.#touch(item, 'fail');
          // Erro não-limite: não esfria a chave, mas tenta a próxima mesmo assim.
        }
      }
    }
    const err = new Error(
      `Todos os ${this.items.length} itens do pool "${this.name}" falharam${label ? ` (${label})` : ''}: ` +
        errors.map((e) => String(e?.message || e).slice(0, 120)).join(' | ')
    );
    err.pool = this.name;
    err.causes = errors;
    throw err;
  }

  summary() {
    const now = Date.now();
    return this.items.map((item, i) => {
      const s = this.stats.get(item) || { ok: 0, fail: 0 };
      const cd = this.cooldowns.get(item);
      const status = cd && cd > now ? `⏳ volta em ${Math.ceil((cd - now) / 60000)}min` : '✅ ativa';
      return `${i + 1}. ${mask(item)} — ${status} · ${s.ok} ok / ${s.fail} falhas`;
    });
  }
}

/** Erros que indicam limite esgotado / chave inválida. */
export function defaultIsExhausted(error) {
  const status = error?.status || error?.statusCode || error?.response?.status;
  if ([402, 403, 429, 401].includes(Number(status))) return true;
  const msg = String(error?.message || error).toLowerCase();
  return [
    'rate limit',
    'rate_limit',
    'too many requests',
    'quota',
    'insufficient',
    'payment required',
    'api key',
    'apikey',
    'unauthorized',
    'forbidden',
    'credits',
    'exceeded'
  ].some((t) => msg.includes(t));
}

/** Mascarar chave/URL para não vazar em logs/mensagens. */
export function mask(value) {
  const s = String(value || '');
  if (s.startsWith('http')) {
    try {
      const u = new URL(s);
      return u.origin;
    } catch {
      return s.slice(0, 24);
    }
  }
  if (s.length <= 8) return '****';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}
