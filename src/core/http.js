// HTTP helpers: timeouts that cover response bodies, bounded reads, validated
// public destinations and redirects. Configured local service endpoints opt in
// to private networking explicitly at their call site.

import { Readable } from 'node:stream';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
];

const DNS_CACHE_MS = 30_000;
const dnsCache = new Map();
let testDnsLookup = null;
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_TEXT_LIMIT = 5 * 1024 * 1024;

export function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

/** Test-only resolver injection; production requests always use system DNS. */
export function setDnsLookupForTests(lookup) {
  if (process.env.NEXUS_TEST_MODE !== '1') throw new Error('DNS test resolver só pode ser alterado na suíte de testes');
  if (lookup !== null && typeof lookup !== 'function') throw new TypeError('lookup deve ser uma função ou null');
  testDnsLookup = lookup;
  dnsCache.clear();
}

export class HttpError extends Error {
  constructor(message, { status, url, retryAfterMs } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.retryAfterMs = retryAfterMs;
  }
}

function stripIpv6Brackets(host) {
  return String(host || '').replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
}

function publicIpv4(ip) {
  const p = String(ip).split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b, c] = p;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // shared address space
  if (a === 169 && b === 254) return false; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a === 255 && b === 255 && c === 255) return false;
  return true;
}

function ipv6AsBigInt(address) {
  let ip = stripIpv6Brackets(address);
  const dotted = ip.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dotted) {
    const octets = dotted.split('.').map(Number);
    if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    ip = ip.slice(0, ip.length - dotted.length) + `${hi}:${lo}`;
  }
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const zeros = halves.length === 2 ? 8 - left.length - right.length : 0;
  const words = [...left, ...Array(Math.max(0, zeros)).fill('0'), ...right];
  if (words.length !== 8 || words.some((word) => !/^[\da-f]{1,4}$/i.test(word))) return null;
  return words.reduce((acc, word) => (acc << 16n) | BigInt(`0x${word}`), 0n);
}

function publicIpv6(address) {
  const ip = stripIpv6Brackets(address);
  const value = ipv6AsBigInt(ip);
  if (value === null) return false;
  if (value === 0n || value === 1n) return false; // unspecified / loopback
  const prefix = (bits) => value >> BigInt(128 - bits);
  if (prefix(96) === 0xffffn) {
    const mapped = Number(value & 0xffffffffn);
    const ip4 = `${mapped >>> 24}.${(mapped >>> 16) & 255}.${(mapped >>> 8) & 255}.${mapped & 255}`;
    return publicIpv4(ip4);
  }
  // Only global-unicast space is routable for external downloads; reject
  // reserved, transition, documentation and special-purpose allocations.
  if (prefix(3) !== 0x1n) return false; // 2000::/3
  if (value >= 0x20010000000000000000000000000000n && value < 0x20010200000000000000000000000000n) return false; // IETF protocol assignments
  if (prefix(20) === 0x3fff0n) return false; // 3fff::/20 documentation
  if (prefix(32) === 0x20010db8n) return false; // 2001:db8::/32 documentation
  if (prefix(16) === 0x2002n) return false; // 6to4 can embed private IPv4
  return true;
}

function publicAddress(address) {
  const family = isIP(address);
  return family === 4 ? publicIpv4(address) : family === 6 ? publicIpv6(address) : false;
}

function parseHttpUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError('URL inválida');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new HttpError('somente URLs HTTP/HTTPS são aceitas');
  if (url.username || url.password) throw new HttpError('URL com credenciais embutidas não é aceita');
  if (!url.hostname) throw new HttpError('URL sem hostname');
  return url;
}

/** Reject local/private destinations and hostnames that resolve to non-public IPs. */
export async function assertPublicHttpUrl(value, { allowPrivate = false } = {}) {
  const url = parseHttpUrl(value);
  const host = stripIpv6Brackets(url.hostname);
  if (allowPrivate) return url.toString();

  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new HttpError('destino local/privado bloqueado');
  }
  if (host === 'metadata.google.internal' || host === 'metadata') throw new HttpError('destino de metadata bloqueado');

  const family = isIP(host);
  if (family) {
    if (!publicAddress(host)) throw new HttpError('destino IP local/privado bloqueado');
    return url.toString();
  }

  let cached = dnsCache.get(host);
  if (!cached || cached.expiresAt <= Date.now()) {
    let answers;
    try {
      answers = await (testDnsLookup || dnsLookup)(host, { all: true, verbatim: true });
    } catch {
      throw new HttpError(`não foi possível validar o host ${host}`);
    }
    if (!answers.length || answers.some((answer) => !publicAddress(answer.address))) {
      throw new HttpError('host resolve para endereço local/privado');
    }
    cached = { answers, expiresAt: Date.now() + DNS_CACHE_MS };
    dnsCache.delete(host);
    dnsCache.set(host, cached);
    while (dnsCache.size > 2_048) dnsCache.delete(dnsCache.keys().next().value);
  }
  if (cached.answers.some((answer) => !publicAddress(answer.address))) throw new HttpError('host resolve para endereço local/privado');
  return url.toString();
}

function lowerKeys(obj) {
  const out = {};
  const entries = Array.isArray(obj)
    ? obj
    : obj && typeof obj.entries === 'function'
      ? [...obj.entries()]
      : Object.entries(obj || {});
  for (const [key, value] of entries) out[String(key).toLowerCase()] = value;
  return out;
}

function retryAfterMs(headers) {
  const value = headers?.get?.('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function mergeHeaders(defaults, extra) {
  return { ...lowerKeys(defaults), ...lowerKeys(extra) };
}

function removeSensitiveHeaders(headers) {
  const next = { ...headers };
  for (const name of ['authorization', 'cookie', 'proxy-authorization']) delete next[name];
  return next;
}

function responseUrl(response, url) {
  try { Object.defineProperty(response, 'url', { configurable: true, value: url }); } catch {}
  return response;
}

function keepTimeoutForBody(response, timer, controller, url) {
  if (!(response instanceof Response)) {
    clearTimeout(timer);
    return responseUrl(response, url);
  }
  if (!response.body) {
    clearTimeout(timer);
    return responseUrl(response, url);
  }
  const reader = response.body.getReader();
  const body = new ReadableStream({
    async pull(target) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          clearTimeout(timer);
          target.close();
        } else target.enqueue(value);
      } catch (error) {
        clearTimeout(timer);
        target.error(error);
      }
    },
    async cancel(reason) {
      clearTimeout(timer);
      controller.abort(reason);
      try { await reader.cancel(reason); } catch {}
    }
  });
  const wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  return responseUrl(wrapped, url);
}

async function fetchRedirectChain(urlValue, init, { redirect = 'follow', maxRedirects = 5, allowPrivate = false } = {}) {
  const requestedRedirects = Number(maxRedirects);
  const redirectLimit = Number.isFinite(requestedRedirects)
    ? Math.min(20, Math.max(0, Math.floor(requestedRedirects)))
    : 5;
  let current = String(urlValue);
  let headers = lowerKeys(init.headers);
  let method = String(init.method || 'GET').toUpperCase();
  let body = init.body;
  let previousOrigin = null;

  for (let hop = 0; hop <= redirectLimit; hop++) {
    current = await assertPublicHttpUrl(current, { allowPrivate });
    const currentUrl = new URL(current);
    if (previousOrigin && currentUrl.origin !== previousOrigin) headers = removeSensitiveHeaders(headers);
    const response = await fetch(current, { ...init, method, body, headers, redirect: 'manual' });
    if (redirect === 'manual' || !REDIRECT_CODES.has(response.status)) return { response, url: current };
    const location = response.headers?.get?.('location');
    if (!location) return { response, url: current };
    if (hop === redirectLimit) {
      await response.body?.cancel?.().catch(() => {});
      throw new HttpError('limite de redirecionamentos excedido', { status: response.status, url: current });
    }
    let next;
    try { next = new URL(location, current).toString(); }
    catch { await response.body?.cancel?.().catch(() => {}); throw new HttpError('redirecionamento inválido', { url: current }); }
    await response.body?.cancel?.().catch(() => {});

    if ((response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) && method !== 'HEAD') {
      method = 'GET';
      body = undefined;
      delete headers['content-type'];
      delete headers['content-length'];
    } else if ((response.status === 307 || response.status === 308) && body !== undefined) {
      throw new HttpError('redirecionamento de POST não será repetido', { status: response.status, url: current });
    }
    previousOrigin = currentUrl.origin;
    current = next;
  }
  throw new HttpError('limite de redirecionamentos excedido');
}

/** fetch with URL validation, manually validated redirects and body-wide timeout. */
export async function fetchWithTimeout(url, {
  timeoutMs = 45_000,
  headers = {},
  allowPrivate = false,
  redirect = 'follow',
  maxRedirects = 5,
  ...rest
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), Math.max(1, timeoutMs));
  const customHeaders = lowerKeys(headers);
  const ua = customHeaders['user-agent'] || randomUA();
  try {
    const { response, url: finalUrl } = await fetchRedirectChain(url, {
      ...rest,
      method: rest.method || 'GET',
      headers: { 'user-agent': ua, accept: '*/*', 'accept-language': 'pt-BR,pt;q=0.9,en;q=0.8', ...customHeaders },
      body: rest.body,
      signal: controller.signal
    }, { redirect, maxRedirects, allowPrivate });
    return keepTimeoutForBody(response, timer, controller, finalUrl);
  } catch (error) {
    clearTimeout(timer);
    if (controller.signal.aborted && !String(error?.message || '').includes('timeout')) throw controller.signal.reason || error;
    throw error;
  }
}

async function readResponseBuffer(response, maxBytes, url) {
  const requestedLimit = Number(maxBytes);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.max(1, Math.floor(requestedLimit))
    : DEFAULT_TEXT_LIMIT;
  const len = Number(response.headers?.get?.('content-length') || 0);
  if (len > limit) {
    await response.body?.cancel?.().catch(() => {});
    throw new HttpError(`resposta grande demais (${formatBytes(len)} > ${formatBytes(limit)})`, {
      status: response.status, url, retryAfterMs: retryAfterMs(response.headers)
    });
  }
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  const stream = Readable.fromWeb(response.body);
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > limit) {
      stream.destroy();
      throw new HttpError(`resposta grande demais (> ${formatBytes(limit)})`, {
        status: response.status, url, retryAfterMs: retryAfterMs(response.headers)
      });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

/** GET simples retornando texto, com teto de corpo padrão de 5 MiB. */
export async function fetchText(url, { maxBytes = DEFAULT_TEXT_LIMIT, ...opts } = {}) {
  const res = await fetchWithTimeout(url, opts);
  if (!res.ok) {
    await res.body?.cancel?.().catch(() => {});
    throw new HttpError(`HTTP ${res.status} em ${shortUrl(url)}`, { status: res.status, url, retryAfterMs: retryAfterMs(res.headers) });
  }
  return (await readResponseBuffer(res, maxBytes, url)).toString('utf8');
}

/** GET retornando JSON. */
export async function fetchJson(url, opts = {}) {
  const text = await fetchText(url, { ...opts, maxBytes: opts.maxBytes || 2 * 1024 * 1024 });
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(`resposta não é JSON (${shortUrl(url)}): ${text.slice(0, 120)}`);
  }
}

/** GET retornando Buffer, com limite de tamanho aplicado durante a leitura. */
export async function fetchBuffer(url, { maxBytes = 120 * 1024 * 1024, ...opts } = {}) {
  const res = await fetchWithTimeout(url, opts);
  if (!res.ok) {
    await res.body?.cancel?.().catch(() => {});
    throw new HttpError(`HTTP ${res.status} em ${shortUrl(url)}`, { status: res.status, url, retryAfterMs: retryAfterMs(res.headers) });
  }
  return readResponseBuffer(res, maxBytes, url);
}

/** POST JSON retornando JSON, com resposta limitada a 2 MiB por padrão. */
export async function postJson(url, body, { maxResponseBytes = 2 * 1024 * 1024, ...opts } = {}) {
  const res = await fetchWithTimeout(url, {
    ...opts,
    method: 'POST',
    headers: mergeHeaders({ 'content-type': 'application/json', accept: 'application/json' }, opts.headers),
    body: JSON.stringify(body)
  });
  const raw = await readResponseBuffer(res, maxResponseBytes, url);
  const text = raw.toString('utf8');
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  if (!res.ok) {
    const err = new HttpError(
      `HTTP ${res.status} em ${shortUrl(url)}: ${(data && (data.error?.message || data.message)) || text.slice(0, 160)}`,
      { status: res.status, url, retryAfterMs: retryAfterMs(res.headers) }
    );
    err.data = data;
    throw err;
  }
  return data;
}

/** POST multipart; configurável para provedores locais explicitamente confiáveis. */
export async function postMultipart(url, fields, files, { maxResponseBytes = 12 * 1024 * 1024, ...opts } = {}) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields || {})) form.append(key, String(value));
  for (const [name, { buffer, filename, type }] of Object.entries(files || {})) {
    form.append(name, new Blob([buffer], { type: type || 'application/octet-stream' }), filename || name);
  }
  const res = await fetchWithTimeout(url, { ...opts, method: 'POST', body: form });
  const raw = await readResponseBuffer(res, maxResponseBytes, url);
  if (!res.ok) {
    const text = raw.toString('utf8').slice(0, 200);
    const err = new HttpError(`HTTP ${res.status} em ${shortUrl(url)}: ${text}`, {
      status: res.status, url, retryAfterMs: retryAfterMs(res.headers)
    });
    err.bodyText = text;
    throw err;
  }
  const ct = String(res.headers.get('content-type') || '');
  if (ct.includes('application/json')) {
    try { return { json: JSON.parse(raw.toString('utf8')), buffer: null, contentType: ct }; } catch {}
  }
  return { json: null, buffer: raw, contentType: ct };
}

/** Raw GET/HEAD response. Redirects default to follow; callers may request manual. */
export async function rawFetch(url, {
  method = 'GET', headers = {}, body, timeoutMs = 20_000,
  redirect = 'follow', maxRedirects = 5, allowPrivate = false
} = {}) {
  return fetchWithTimeout(url, { method, headers, body, timeoutMs, redirect, maxRedirects, allowPrivate });
}

/** The user-agent used by hosts for link previews. */
export const CRAWLER_AGENT = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

export const BROWSER_PAGE_HEADERS = {
  'User-Agent': randomUA(),
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1'
};

/** GET tolerant: bounded text + status + the validated final URL. */
export async function httpGet(url, { headers = {}, timeoutMs = 20_000, json = false, maxBytes = DEFAULT_TEXT_LIMIT, allowPrivate = false } = {}) {
  const res = await rawFetch(url, { method: 'GET', headers, timeoutMs, allowPrivate });
  const text = (await readResponseBuffer(res, maxBytes, res.url || url)).toString('utf8');
  const out = {
    status: res.status,
    ok: res.ok,
    headers: res.headers,
    finalUrl: res.url || url,
    contentType: String(res.headers.get('content-type') || ''),
    text
  };
  if (json) {
    try { out.data = JSON.parse(text); } catch { out.data = null; }
  }
  return out;
}

/** Resolve public redirects with a bounded hop count and validation at every hop. */
export async function resolveRedirect(url, { hops = 6, headers = {}, timeoutMs = 15_000, allowPrivate = false } = {}) {
  const requestedHops = Number(hops);
  const hopLimit = Number.isFinite(requestedHops) ? Math.min(20, Math.max(0, Math.floor(requestedHops))) : 6;
  let current = await assertPublicHttpUrl(url, { allowPrivate });
  for (let i = 0; i < hopLimit; i++) {
    let response;
    try {
      response = await rawFetch(current, { method: 'HEAD', redirect: 'manual', headers, timeoutMs, allowPrivate });
    } catch {
      response = null;
    }
    let location = response && REDIRECT_CODES.has(response.status) ? response.headers.get('location') : null;
    if (!location) {
      response?.body?.cancel?.().catch(() => {});
      try {
        response = await rawFetch(current, {
          method: 'GET', redirect: 'manual', headers: { ...BROWSER_PAGE_HEADERS, ...headers }, timeoutMs, allowPrivate
        });
        location = REDIRECT_CODES.has(response.status) ? response.headers.get('location') : null;
      } catch {
        response = null;
      }
    }
    response?.body?.cancel?.().catch(() => {});
    if (!location) break;
    try { current = await assertPublicHttpUrl(new URL(location, current).toString(), { allowPrivate }); }
    catch (error) { throw new HttpError(`redirecionamento bloqueado: ${error.message}`, { url: current }); }
  }
  return current;
}

/** Referer esperado por CDNs que restringem hotlink. */
export function mediaReferer(url) {
  const u = String(url || '');
  if (u.includes('tikwm.com')) return 'https://www.tikwm.com/';
  if (u.includes('tiktokcdn') || u.includes('tiktok')) return 'https://www.tiktok.com/';
  if (u.includes('pinimg.com')) return 'https://www.pinterest.com/';
  if (u.includes('cdninstagram') || u.includes('fbcdn.net')) return 'https://www.instagram.com/';
  if (u.includes('ytimg.com')) return 'https://www.youtube.com/';
  if (u.includes('twimg.com')) return 'https://x.com/';
  if (u.includes('fbcdn') || u.includes('facebook')) return 'https://www.facebook.com/';
  if (u.includes('redd.it')) return 'https://www.reddit.com/';
  return '';
}

export function shortUrl(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return 'URL inválida';
  }
}

export function formatBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = Number(n) || 0;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
