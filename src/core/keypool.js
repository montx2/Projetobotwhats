// KeyPool — rotação justa de credenciais/instâncias configuradas pelo operador.
// Limites e cooldowns são respeitados; pools não tornam cotas ilimitadas nem
// devem ser usados para contornar políticas do provedor.

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
    // Não reutilize uma chave que ainda está limitada só porque as demais
    // também estão em cooldown; o chamador pode usar outro provedor/fallback.
    return null;
  }

  /** Marca sucesso (tira da geladeira). */
  reportSuccess(item) {
    this.cooldowns.delete(item);
    this.#touch(item, 'ok');
  }

  /**
   * Troca a lista de itens sem recriar o pool (usado pela descoberta automática
   * de instâncias Cobalt: cooldown de 5 min e estatísticas seguem valendo para
   * quem permanece; quem sai leva cooldown/stats embora).
   */
  replaceItems(items) {
    const next = [...new Set((items || []).map((i) => String(i || '').trim()).filter(Boolean))];
    for (const item of this.items) {
      if (!next.includes(item)) {
        this.cooldowns.delete(item);
        this.stats.delete(item);
      }
    }
    this.items = next;
    if (this.index >= next.length) this.index = 0;
    return next.length;
  }

  /** Marca falha: item entra em cooldown. */
  reportFailure(item, { cooldownMs = this.cooldownMs, reason = '' } = {}) {
    const duration = Math.max(1_000, Math.min(60 * 60_000, Number(cooldownMs) || this.cooldownMs));
    this.cooldowns.set(item, Date.now() + duration);
    this.#touch(item, 'fail');
    return reason;
  }

  /** Libera todos os itens na hora (usado por `.pools reset`). */
  clearCooldowns() {
    const cleared = this.cooldowns.size;
    this.cooldowns.clear();
    return cleared;
  }

  /** Menor tempo restante de cooldown do pool, em ms (0 se algum já está livre). */
  nextRetryMs() {
    const now = Date.now();
    const pending = this.items.map((item) => (this.cooldowns.get(item) || 0) - now).filter((ms) => ms > 0);
    if (!pending.length || pending.length < this.items.length) return 0;
    return Math.min(...pending);
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
        // `fatalForPool`: falha que vai se repetir em TODAS as chaves (ex.: modelo
        // descontinuado pelo provedor). Não faz sentido gastar as outras chaves.
        if (error?.fatalForPool) {
          const err = new Error(
            `${label ? `${label}: ` : ''}${String(error?.message || error).slice(0, 300)}`
          );
          err.pool = this.name;
          err.causes = errors;
          err.modelError = true;
          throw err;
        }
        if (isExhausted(error)) {
          const requestedCooldown = Number(error?.retryAfterMs);
          this.reportFailure(item, {
            cooldownMs: Number.isFinite(requestedCooldown) && requestedCooldown > 0 ? requestedCooldown : this.cooldownMs,
            reason: error?.message || 'limite'
          });
        } else {
          this.#touch(item, 'fail');
          // Erro não-limite: não esfria a chave, mas tenta a próxima mesmo assim.
        }
      }
    }
    const now = Date.now();
    const available = this.items.filter((item) => !this.cooldowns.has(item) || this.cooldowns.get(item) <= now);
    const retryAfterMs = this.nextRetryMs();
    const detail = errors.map((error) => String(error?.message || error).slice(0, 120)).join(' | ');
    const wait = retryAfterMs ? ` (volta em ${formatCooldown(retryAfterMs)})` : '';
    const err = new Error(
      `${available.length ? `Todos os ${this.items.length} itens do pool "${this.name}" falharam` : `Pool "${this.name}" em cooldown${wait}`}` +
        `${label ? ` (${label})` : ''}${detail ? `: ${detail}` : ''}`
    );
    err.pool = this.name;
    err.causes = errors;
    if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) err.retryAfterMs = retryAfterMs;
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

/**
 * Erros de MODELO, e não de chave: o provedor descontinuou/removeu o modelo
 * (ex.: a Groq aposentou `llama-3.3-70b-versatile` em 16/08/2026 e o Google
 * aposentou `gemini-2.0-flash` em 01/06/2026 — ambos passaram a devolver 404).
 * Girar a chave NÃO resolve: é preciso tentar outro modelo com a MESMA chave.
 */
export function isModelError(error) {
  const status = Number(error?.status || error?.statusCode || error?.response?.status || 0);
  if (status === 404) return true;
  const msg = String(error?.message || error).toLowerCase();
  if (!msg.includes('model')) return false;
  return [
    'model_not_found',
    'model not found',
    'does not exist',
    'do not have access',
    'unknown model',
    'invalid model',
    'decommissioned',
    'deprecated',
    'no longer',
    'not supported',
    'unsupported'
  ].some((t) => msg.includes(t));
}

/**
 * Modelo morto para TODO MUNDO (não é falta de acesso da conta): não adianta
 * gastar as outras chaves do pool — o erro vai se repetir em todas elas.
 */
export function isModelMissingForEveryone(error) {
  if (!isModelError(error)) return false;
  const msg = String(error?.message || error).toLowerCase();
  if (['do not have access', 'permission', 'not enabled', 'allowlist', 'your account'].some((t) => msg.includes(t))) return false;
  return ['does not exist', 'model_not_found', 'model not found', 'unknown model', 'invalid model', 'decommissioned', 'no longer'].some((t) =>
    msg.includes(t)
  );
}

/** Tempo restante legível ("45s", "3min", "1h05"). */
export function formatCooldown(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000));
  if (total < 60) return `${total}s`;
  const min = Math.floor(total / 60);
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  return `${h}h${String(min % 60).padStart(2, '0')}`;
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
