// 🔎 Instâncias Cobalt auto-suficientes — descoberta, verificação de saúde,
// cache e atualização periódica.
//
// O problema: a lista de instâncias era fixa no código. Quando uma instância
// caía ou passava a exigir Cloudflare Turnstile (um desafio de navegador que um
// bot JAMAIS resolve), o `.dl` parava até alguém editar o código.
//
// A solução, em camadas:
//   1. Descoberta — ler as listas públicas (instances.cobalt.best como fonte
//      principal, cobalt.directory como reserva) e filtrar candidatos: online,
//      https, versão 10+ e sem exigência de autenticação conhecida.
//   2. Verificação de saúde — testar cada candidata DE VERDADE (GET / para
//      pegar versão/turnstileSitekey + um POST real para provar que a API
//      aceita requisição sem token de navegador) e classificar:
//      ok · turnstile · auth · rate · morta · inválida.
//   3. Cache — persistir a lista boa em data/cache/cobalt-instances.json
//      (respeita NEXUS_DATA_DIR) e recarregá-la no boot com zero latência.
//   4. Atualização — revalidar a cada N horas (COBALT_DISCOVER_INTERVAL_H) e
//      também EMERGENCIALMENTE quando todas as instâncias do pool entrarem em
//      cooldown, para o bot se recuperar sozinho no meio de uma falha.
//
// Precedência (o bot NUNCA fica sem pool):
//   COBALT_INSTANCES (.env, manual — desliga a descoberta)
//     → cache local → descoberta → DEFAULT_INSTANCES embutidas.
//
// Segurança: TODA requisição sai pelo cliente HTTP do bot (src/core/http.js),
// que valida SSRF/redirecionamento e limita o corpo da resposta. Só entram
// URLs https públicas na raiz do domínio; listas são tratadas como dados não
// confiáveis (tamanho, quantidade e formato limitados).

import { ENV } from '../../core/config.js';
import { fetchJson, postJson, shortUrl } from '../../core/http.js';
import { log } from '../../core/logger.js';
import { readJson, writeJsonNow } from '../../core/store.js';

/** Último recurso: instâncias comunitárias embutidas (verificadas em out/2026
 *  nas listas públicas). Fora ficaram api.cobalt.tools e os backends oficiais
 *  *.imput.net: são protegidos por Turnstile/chave e por design nunca
 *  funcionam num bot — a descoberta os descartaria no primeiro health check. */
export const DEFAULT_INSTANCES = [
  'https://cobalt-api.meowing.de',
  'https://cobalt-backend.canine.tools',
  'https://capi.3kh0.net',
  'https://cobaltapi.cjs.nz',
  'https://co.otomir23.me'
];

export const COBALT_CACHE_FILE = 'cache/cobalt-instances.json';

const DIRECTORY_TIMEOUT_MS = 15_000;
const DIRECTORY_MAX_BYTES = 1024 * 1024;
const HEALTH_TIMEOUT_MS = 10_000;
const HEALTH_MAX_BYTES = 64 * 1024;
const MIN_VERSION_MAJOR = 10;
const MAX_CANDIDATES = 24;
const MAX_INSTANCES = 10;
const REPLACE_FLOOR = 3;
const HEALTH_CONCURRENCY = 6;
const EMERGENCY_MIN_GAP_MS = 3 * 60_000;
const EMERGENCY_FRESH_SKIP_MS = 5 * 60_000;
const DEFAULT_INTERVAL_H = 12;
const MAX_INTERVAL_H = 168;

// As listas pedem user-agent identificado (bloqueiam UAs padrão de ferramenta
// para não virarem alvo de scraping): instances.cobalt.best/api documenta isso
// explicitamente. Identificamo-nos com honestidade.
const DISCOVERER_UA = 'MontxBOT/7.0 (+https://github.com/montx2/Projetobotwhats)';

const ORIGIN_LABEL = {
  manual: 'manual (.env)',
  cache: 'cache local',
  discovery: 'descoberta automática',
  default: 'padrão embutido'
};

/* ───────────────────────── helpers puros ───────────────────────── */

/** "10.9.4" → 10 · "11.7.1" → 11 · "unknown"/"-1" → null. */
export function versionMajor(version) {
  const match = String(version || '').trim().match(/^v?(\d+)(?:\.|$)/);
  return match ? Number(match[1]) : null;
}

/** IP literal obviamente privado/reservado (checagem barata; a validação SSRF
 *  completa — incluindo DNS — é feita pelo src/core/http.js em cada requisição). */
function privateIpLiteral(host) {
  const h = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(h)) {
    const [a, b] = h.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local / metadata de nuvem
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true; // multicast/reservado
    return false;
  }
  if (h === '::' || h === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // fc00::/7 (ULA)
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true; // fe80::/10 (link-local)
  return false;
}

/**
 * Normaliza um valor de lista (hostname puro, ex. "capi.3kh0.net", ou URL
 * completa) em uma origem https válida na raiz do domínio — ou null.
 * Rejeita: http, credenciais, caminho/query/fragmento, hosts locais e
 * IPs privados literais.
 */
export function toInstanceUrl(raw, protocol = 'https') {
  const value = String(raw || '').trim().replace(/\/+$/, '');
  if (!value || value.length > 200) return null;
  const hasScheme = /^https?:\/\//i.test(value);
  if (!hasScheme && String(protocol || '').toLowerCase() !== 'https') return null;
  const candidate = hasScheme ? value : `https://${value}`;
  if (!/^https:\/\//i.test(candidate)) return null;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) return null;
  const host = url.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === 'metadata.google.internal'
  ) return null;
  if (!host.includes('.') && !host.includes(':')) return null; // sem TLD e sem IPv6
  if (privateIpLiteral(host)) return null;
  return url.origin;
}

/** "há 5min" / "há 3h" / "há 2d" / "agora" / "nunca". */
export function agoText(timestamp) {
  const ts = Number(timestamp) || 0;
  if (!ts) return 'nunca';
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return 'agora';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `há ${minutes}min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `há ${hours}h`;
  return `há ${Math.floor(hours / 24)}d`;
}

/** map com concorrência limitada (worker pool simples, sem dependências). */
async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(Number(limit) || 1, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = await mapper(items[index], index);
      } catch (error) {
        results[index] = {
          url: String(items[index]?.url || items[index] || ''),
          status: 'dead',
          reason: String(error?.message || error).slice(0, 120)
        };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/* ───────────────────────── fontes públicas ───────────────────────── */
// Formatos verificados em out/2026:
//  · instances.cobalt.best/instances.json → array com { api (host), frontend,
//    protocol, online, version, score, status, services, info:{ auth, cors } }.
//    O endpoint antigo /api/instances.json ainda existe com forma parecida.
//    (docs da própria lista em https://instances.cobalt.best/api)
//  · cobalt.directory/api/working?type=api&turnstile=0 → { lastUpdatedUTC,
//    data: { "<serviço>": ["https://host", ...] } }.
//    Reserva: /api/tests → { data: [ { api, turnstile, tests } ] }.
// Todas as fontes são "best effort": se uma cair, a seguinte assume — e a
// verificação de saúde é quem dá a palavra final.

function candidateFromEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.online === false || entry.api_online === false) return null;
  const url = toInstanceUrl(entry.api || entry.url || entry.apiUrl || entry.API, entry.protocol);
  if (!url) return null;
  if (entry.info?.auth === true) return null; // versões antigas com auth obrigatória
  if (entry.turnstile === true) return null;
  const major = versionMajor(entry.version);
  if (major !== null && major < MIN_VERSION_MAJOR) return null;
  const score = Number(entry.score);
  return { url, score: Number.isFinite(score) ? score : 0 };
}

function parseKwiatList(payload) {
  if (!Array.isArray(payload)) return [];
  const out = [];
  for (const entry of payload.slice(0, 200)) {
    const candidate = candidateFromEntry(entry);
    if (candidate) out.push(candidate);
  }
  return out;
}

function envelopeData(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && 'data' in payload) {
    return payload.data;
  }
  return payload;
}

function parseDirectoryWorking(payload) {
  const data = envelopeData(payload);
  const counts = new Map();
  const add = (raw) => {
    const url = toInstanceUrl(raw);
    if (url) counts.set(url, (counts.get(url) || 0) + 1);
  };
  if (Array.isArray(data)) {
    for (const entry of data.slice(0, 200)) {
      if (typeof entry === 'string') add(entry);
      else if (entry && typeof entry === 'object') {
        if (entry.turnstile === true || entry.online === false) continue;
        if (entry.api || entry.url) add(entry.api || entry.url);
      }
    }
  } else if (data && typeof data === 'object') {
    // mapa serviço → instâncias; o score vira a quantidade de serviços atendidos
    for (const list of Object.values(data).slice(0, 100)) {
      if (!Array.isArray(list)) continue;
      for (const item of list.slice(0, 100)) {
        if (typeof item === 'string') add(item);
        else if (item && typeof item === 'object' && (item.api || item.url)) add(item.api || item.url);
      }
    }
  }
  return [...counts.entries()].map(([url, services]) => ({ url, score: services }));
}

function parseDirectoryTests(payload) {
  const data = envelopeData(payload);
  if (!Array.isArray(data)) return [];
  const out = [];
  for (const entry of data.slice(0, 200)) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.turnstile === true || entry.online === false) continue;
    const url = toInstanceUrl(entry.api || entry.url || entry.apiUrl, entry.protocol);
    if (!url) continue;
    let score = 0;
    if (entry.tests && typeof entry.tests === 'object') {
      for (const result of Object.values(entry.tests)) {
        if (result && /working/i.test(String(result.status || result))) score += 1;
      }
    }
    out.push({ url, score });
  }
  return out;
}

const DISCOVERY_SOURCES = [
  {
    name: 'instances.cobalt.best',
    url: 'https://instances.cobalt.best/instances.json',
    parse: parseKwiatList
  },
  {
    name: 'instances.cobalt.best (formato antigo)',
    url: 'https://instances.cobalt.best/api/instances.json',
    parse: parseKwiatList
  },
  {
    name: 'cobalt.directory',
    url: 'https://cobalt.directory/api/working?type=api&turnstile=0',
    parse: parseDirectoryWorking
  },
  {
    name: 'cobalt.directory (testes)',
    url: 'https://cobalt.directory/api/tests',
    parse: parseDirectoryTests
  }
];

/* ───────────────── verificação de saúde ───────────────── */

/**
 * Testa uma candidata de verdade e classifica:
 *   ok        — responde como API cobalt aberta (GET / com objeto cobalt sem
 *               sitekey + POST aceito sem autenticação).
 *   turnstile — exige verificação de navegador (sitekey no GET / ou
 *               error.api.auth.jwt.* no POST). Inútil para um bot.
 *   auth      — exige chave de API própria (error.api.auth.key.*).
 *   rate      — viva, mas limitada no momento (429); serve como reserva.
 *   dead      — não responde / erro 5xx.
 *   invalid   — responde, mas fora do formato da API do cobalt.
 *
 * @returns {Promise<{url:string,status:string,reason?:string,version?:string}>}
 */
export async function checkInstanceHealth(url) {
  const base = String(url || '').replace(/\/+$/, '');
  const fail = (status, reason, version) => ({ url: base, status, reason, version });

  // 1) GET / — identidade, versão e sitekey do Turnstile (não consome cota:
  //    o rate limit do cobalt só se aplica aos endpoints de processamento).
  let info = null;
  try {
    info = await fetchJson(`${base}/`, {
      headers: { accept: 'application/json' },
      timeoutMs: HEALTH_TIMEOUT_MS,
      maxBytes: 256 * 1024
    });
  } catch (error) {
    const message = String(error?.message || error);
    const httpStatus = Number(error?.status || 0);
    if (httpStatus >= 500) return fail('dead', `GET /: HTTP ${httpStatus}`);
    if (httpStatus > 0 || message.includes('não é JSON')) {
      return fail('invalid', `GET /: ${message.slice(0, 100)}`);
    }
    return fail('dead', `GET /: ${message.slice(0, 100)}`);
  }
  const about = info && typeof info === 'object' && info.cobalt && typeof info.cobalt === 'object'
    ? info.cobalt
    : null;
  if (!about) return fail('invalid', 'GET / sem o objeto "cobalt" (formato inesperado)');
  if (String(about.turnstileSitekey || '').trim()) {
    return fail('turnstile', 'turnstileSitekey presente no GET /');
  }
  const major = versionMajor(about.version);
  if (major !== null && major < MIN_VERSION_MAJOR) {
    return fail('invalid', `versão antiga (${about.version})`);
  }

  // 2) POST / com corpo vazio — a instância boa responde 400 com
  //    error.api.link.missing (formato cobalt, sem pedir navegador). Quem exige
  //    Turnstile devolve 401 error.api.auth.jwt.missing.
  try {
    const res = await postJson(`${base}/`, {}, {
      headers: { accept: 'application/json' },
      timeoutMs: HEALTH_TIMEOUT_MS,
      maxResponseBytes: HEALTH_MAX_BYTES
    });
    const shaped = res && typeof res === 'object' && (typeof res.status === 'string' || res.error);
    if (shaped) return { url: base, status: 'ok', version: String(about.version || '') };
    return fail('invalid', 'POST / fora do formato cobalt');
  } catch (error) {
    const code = String(error?.data?.error?.code || '');
    const httpStatus = Number(error?.status || 0);
    if (/^error\.api\.auth\.jwt/.test(code)) return fail('turnstile', code);
    if (/^error\.api\.auth\.key/.test(code)) return fail('auth', code);
    if (code.includes('rate') || httpStatus === 429) return fail('rate', code || 'HTTP 429');
    if (code) {
      if (httpStatus >= 500) return fail('dead', `${code} (HTTP ${httpStatus})`);
      // erro cobalt bem-comportado (ex.: link.missing com 400): API viva e aberta
      return { url: base, status: 'ok', version: String(about.version || '') };
    }
    if (httpStatus >= 500) return fail('dead', `POST /: HTTP ${httpStatus}`);
    return fail('invalid', `POST /: HTTP ${httpStatus || 'sem resposta'} fora do formato cobalt`);
  }
}

/* ───────────────────────── cache ───────────────────────── */

/** Lê o cache gravado pela última descoberta (ou null se ausente/inválido). */
export function readCobaltCache() {
  const raw = readJson(COBALT_CACHE_FILE, null);
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.instances)) return null;
  // O cache é re-saneado na leitura: só URLs https na raiz do domínio, sem
  // repetições, com teto de instâncias (arquivo pode ter sido editado à mão).
  const instances = [];
  for (const item of raw.instances.slice(0, MAX_INSTANCES * 2)) {
    const url = toInstanceUrl(typeof item === 'string' ? item : item?.url);
    if (url && !instances.includes(url)) instances.push(url);
    if (instances.length >= MAX_INSTANCES) break;
  }
  if (!instances.length) return null;
  return {
    instances,
    updatedAt: Number(raw.updatedAt) || 0,
    origin: String(raw.origin || 'discovery'),
    source: String(raw.source || ''),
    counts: raw.counts && typeof raw.counts === 'object' ? raw.counts : null
  };
}

/**
 * Ordem de precedência do pool na inicialização:
 * manual (.env) → cache local → DEFAULT_INSTANCES. Nunca vazio.
 * @returns {{instances: string[], origin: string, updatedAt?: number}}
 */
export function resolveInitialCobaltInstances() {
  const manual = ENV.cobaltInstances;
  if (manual.length) return { instances: [...manual], origin: 'manual' };
  const cache = readCobaltCache();
  if (cache) return { instances: cache.instances, origin: 'cache', updatedAt: cache.updatedAt };
  return { instances: [...DEFAULT_INSTANCES], origin: 'default', updatedAt: 0 };
}

/* ───────────────────────── gerenciador ───────────────────────── */

/**
 * Orquestra descoberta + health check + cache + timers de revalidação.
 * Uma instância só (singleton `cobaltManager`); classes extras são para testes.
 */
export class CobaltInstanceManager {
  #stopped = false;
  #timer = null;
  #refreshPromise = null;
  #emergencyAt = 0;
  #lastSuccessAt = 0;

  /** @param {{testMode?: boolean}} opts testMode desliga rede/timers automáticos */
  constructor({ testMode = process.env.NEXUS_TEST_MODE === '1' } = {}) {
    this.pool = null;
    this.origin = 'default';
    this.updatedAt = 0;
    this.lastCounts = null;
    this.lastSource = null;
    this.testMode = testMode;
  }

  get scheduled() {
    return Boolean(this.#timer);
  }

  get stopped() {
    return this.#stopped;
  }

  /** Descoberta habilitada? (manual no .env ou flag desligada → false) */
  #autoDiscoverEnabled() {
    if (ENV.cobaltInstances.length) return false; // modo manual: prioridade absoluta
    return ENV.cobaltAutoDiscover === true;
  }

  #intervalMs() {
    const hours = Math.min(MAX_INTERVAL_H, Math.max(1, Math.round(Number(ENV.cobaltDiscoverIntervalH) || DEFAULT_INTERVAL_H)));
    return hours * 3_600_000;
  }

  #isStale() {
    if (this.origin !== 'cache' && this.origin !== 'discovery') return true; // sem cache: descobrir já
    if (!this.updatedAt) return true;
    return Date.now() - this.updatedAt >= this.#intervalMs();
  }

  #schedule() {
    if (this.#timer) return;
    const interval = this.#intervalMs();
    this.#timer = setInterval(() => {
      this.refresh({ reason: 'periódica' }).catch(() => {});
    }, interval);
    this.#timer.unref(); // nunca segura o processo vivo no shutdown
  }

  /**
   * Anexa o pool real e inicia a atualização em segundo plano (se cabível).
   * Devolve a promise do refresh de inicialização (ou null quando não há).
   */
  attach(pool, initial = {}) {
    if (this.pool) return null;
    this.pool = pool || null;
    this.origin = initial.origin || 'default';
    this.updatedAt = Number(initial.updatedAt) || 0;
    if (this.#stopped || this.testMode || !this.#autoDiscoverEnabled()) return null;
    this.#schedule();
    if (!this.#isStale()) return null;
    // boot com zero latência: o pool já está montado (cache/padrão); a
    // descoberta roda em segundo plano e troca a lista quando terminar.
    return this.refresh({ reason: 'inicialização' }).catch(() => {});
  }

  /** Promise da descoberta em andamento (ou null) — útil para testes. */
  pendingRefresh() {
    return this.#refreshPromise;
  }

  /**
   * Descobre, verifica e aplica a lista nova. Chamadas simultâneas viram UMA
   * só (mesma promise) — sem corrida, sem trabalho duplicado.
   */
  refresh({ reason = 'manual' } = {}) {
    if (!this.#refreshPromise) {
      this.#refreshPromise = this.#doRefresh(reason).finally(() => {
        this.#refreshPromise = null;
      });
    }
    return this.#refreshPromise;
  }

  async #doRefresh(reason) {
    if (this.#stopped) return { skipped: true };
    if (!this.#autoDiscoverEnabled()) return { skipped: true };

    // 1) listas públicas — a primeira que responder com candidatos ganha
    const failures = [];
    let candidates = null;
    let sourceUsed = null;
    for (const source of DISCOVERY_SOURCES) {
      let parsed = [];
      try {
        const payload = await fetchJson(source.url, {
          headers: { 'user-agent': DISCOVERER_UA, accept: 'application/json' },
          timeoutMs: DIRECTORY_TIMEOUT_MS,
          maxBytes: DIRECTORY_MAX_BYTES
        });
        parsed = source.parse(payload) || [];
      } catch (error) {
        failures.push(`${source.name}: ${String(error?.message || error).slice(0, 140)}`);
        continue;
      }
      if (parsed.length) {
        candidates = parsed;
        sourceUsed = source.name;
        break;
      }
      failures.push(`${source.name}: lista sem instâncias utilizáveis`);
    }
    if (!candidates) {
      const detail = failures.join(' | ') || 'nenhuma fonte disponível';
      log.warn(`cobalt: descoberta (${reason}) não conseguiu a lista pública — mantendo o pool atual`, {
        fontes: detail.slice(0, 300)
      });
      throw new Error(`cobalt: nenhuma fonte de instâncias respondeu (${detail})`);
    }

    // 2) dedupe + ranking por score + teto de candidatas verificadas
    const unique = new Map();
    for (const candidate of candidates) {
      if (candidate?.url && !unique.has(candidate.url)) unique.set(candidate.url, candidate);
    }
    const ranked = [...unique.values()]
      .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))
      .slice(0, MAX_CANDIDATES);

    // 3) verificação de saúde real, em paralelo com limite
    const results = await mapLimit(ranked, HEALTH_CONCURRENCY, (candidate) =>
      checkInstanceHealth(candidate.url)
    );
    const counts = {};
    for (const result of results) counts[result.status] = (counts[result.status] || 0) + 1;

    const turnstileHosts = results.filter((r) => r.status === 'turnstile').map((r) => shortUrl(r.url));
    if (turnstileHosts.length) {
      log.warn(
        `cobalt: ${turnstileHosts.length} instância(s) exigem verificação de navegador (Turnstile) — descartadas`,
        { hosts: turnstileHosts.join(', ').slice(0, 220) }
      );
    }

    const adopted = [
      ...results.filter((r) => r.status === 'ok').map((r) => r.url),
      ...results.filter((r) => r.status === 'rate').map((r) => r.url) // vivas, mas limitadas: reserva
    ].slice(0, MAX_INSTANCES);
    if (!adopted.length) {
      log.warn(`cobalt: descoberta (${reason}) verificou ${results.length} instância(s) e nenhuma passou`, counts);
      throw new Error('cobalt: nenhuma instância utilizável após verificação de saúde');
    }

    // 4) aplica no pool SEM recriá-lo (cooldowns de 5 min do KeyPool seguem
    //    valendo). Lista nova robusta substitui; lista escassa mescla com a
    //    atual para nunca encolher o pool à toa.
    const current = this.pool ? [...this.pool.items] : [];
    const next = adopted.length >= REPLACE_FLOOR
      ? adopted
      : [...new Set([...adopted, ...current])].slice(0, MAX_INSTANCES);
    this.pool?.replaceItems(next);
    this.origin = 'discovery';
    this.updatedAt = Date.now();
    this.#lastSuccessAt = this.updatedAt;
    this.lastCounts = counts;
    this.lastSource = sourceUsed;

    // 5) persiste o cache para o próximo boot (zero latência)
    writeJsonNow(COBALT_CACHE_FILE, {
      instances: next,
      updatedAt: this.updatedAt,
      origin: 'discovery',
      source: sourceUsed,
      counts,
      detail: results
        .slice(0, MAX_CANDIDATES)
        .map((r) => ({ url: r.url, status: r.status, version: String(r.version || '') }))
    });

    log.ok(`cobalt: descoberta (${reason}) → ${next.length} instância(s) via ${sourceUsed}`, {
      ok: counts.ok || 0,
      rate: counts.rate || 0,
      turnstile: counts.turnstile || 0,
      auth: counts.auth || 0,
      mortas: (counts.dead || 0) + (counts.invalid || 0)
    });
    return { instances: next, counts, source: sourceUsed };
  }

  /**
   * Todas as instâncias do pool entraram em cooldown? Revalida a lista em
   * segundo plano na hora (com throttle para não virar tempestade) — o bot se
   * recupera no meio da falha em vez de esperar o próximo ciclo.
   */
  onPoolExhausted() {
    if (this.#stopped || this.testMode || !this.#autoDiscoverEnabled()) return false;
    if (this.#refreshPromise) return false;
    const now = Date.now();
    if (now - this.#emergencyAt < EMERGENCY_MIN_GAP_MS) return false;
    if (this.#lastSuccessAt && now - this.#lastSuccessAt < EMERGENCY_FRESH_SKIP_MS) return false;
    this.#emergencyAt = now;
    log.info('cobalt: todas as instâncias em cooldown — revalidando a lista em segundo plano');
    this.refresh({ reason: 'emergência (pool em cooldown)' }).catch(() => {});
    return true;
  }

  /** Para timers e bloqueia novos ciclos (shutdown limpo, sem vazamento). */
  stop() {
    this.#stopped = true;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /** Retrato para .info / .doctor / logs. */
  status() {
    return {
      origin: this.origin,
      autoDiscover: this.#autoDiscoverEnabled(),
      intervalH: Math.round(this.#intervalMs() / 3_600_000),
      total: this.pool ? this.pool.size : 0,
      available: this.pool ? this.pool.available : 0,
      updatedAt: this.updatedAt,
      counts: this.lastCounts,
      source: this.lastSource
    };
  }
}

/** Instância única usada pelo bot (testes constroem as suas). */
export const cobaltManager = new CobaltInstanceManager();

/** Linha única de resumo (usada no .doctor do WhatsApp). */
export function cobaltStatusLine() {
  const s = cobaltManager.status();
  const base = `${s.available}/${s.total} instâncias · ${ORIGIN_LABEL[s.origin] || s.origin}`;
  return s.origin === 'manual' ? base : `${base} · atualizado ${agoText(s.updatedAt)}`;
}

/** Linhas do .info e do .pools (quantas ativas, origem, última atualização). */
export function cobaltInfoRows() {
  const s = cobaltManager.status();
  const rows = [`cobalt: ${s.available}/${s.total} instância(s) · origem: ${ORIGIN_LABEL[s.origin] || s.origin}`];
  if (s.origin !== 'manual') {
    rows.push(
      `cobalt: lista atualizada ${agoText(s.updatedAt)} · auto-descoberta ${s.autoDiscover ? `a cada ${s.intervalH}h` : 'desligada (COBALT_AUTO_DISCOVER=false)'}`
    );
  }
  return rows;
}

/** Shutdown: chamado pelo main.js para limpar timers. */
export function stopCobaltDiscovery() {
  cobaltManager.stop();
}
