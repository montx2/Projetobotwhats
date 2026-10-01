// HTTP helpers: fetch com timeout, retries, User-Agent rotativo e download p/ buffer.

import { Readable } from 'node:stream';

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
];

export function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

export class HttpError extends Error {
  constructor(message, { status, url } = {}) {
    super(message);
    this.status = status;
    this.url = url;
  }
}

/**
 * fetch com timeout e User-Agent de navegador.
 */
export async function fetchWithTimeout(url, { timeoutMs = 45_000, headers = {}, ...rest } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  try {
    return await fetch(url, {
      redirect: 'follow',
      ...rest,
      headers: {
        'user-agent': randomUA(),
        accept: '*/*',
        'accept-language': 'pt-BR,pt;q=0.9,en;q=0.8',
        ...lowerKeys(headers)
      },
      signal: ctrl.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

function lowerKeys(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) out[k.toLowerCase()] = v;
  return out;
}

/** GET simples retornando texto. */
export async function fetchText(url, opts = {}) {
  const res = await fetchWithTimeout(url, opts);
  if (!res.ok) throw new HttpError(`HTTP ${res.status} em ${shortUrl(url)}`, { status: res.status, url });
  return res.text();
}

/** GET retornando JSON. */
export async function fetchJson(url, opts = {}) {
  const text = await fetchText(url, {
    ...opts,
    headers: { accept: 'application/json', ...(opts.headers || {}) }
  });
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(`resposta não é JSON (${shortUrl(url)}): ${text.slice(0, 120)}`);
  }
}

/** GET retornando Buffer, com limite de tamanho. */
export async function fetchBuffer(url, { maxBytes = 120 * 1024 * 1024, ...opts } = {}) {
  const res = await fetchWithTimeout(url, opts);
  if (!res.ok) throw new HttpError(`HTTP ${res.status} em ${shortUrl(url)}`, { status: res.status, url });
  const len = Number(res.headers.get('content-length') || 0);
  if (len && len > maxBytes) {
    throw new HttpError(`arquivo grande demais (${formatBytes(len)} > ${formatBytes(maxBytes)})`, { url });
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of Readable.fromWeb(res.body)) {
    total += chunk.length;
    if (total > maxBytes) throw new HttpError(`arquivo grande demais (> ${formatBytes(maxBytes)})`, { url });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** POST JSON retornando JSON. */
export async function postJson(url, body, opts = {}) {
  const res = await fetchWithTimeout(url, {
    ...opts,
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...(opts.headers || {}) },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = new HttpError(
      `HTTP ${res.status} em ${shortUrl(url)}: ${(data && (data.error?.message || data.message)) || text.slice(0, 160)}`,
      { status: res.status, url }
    );
    err.data = data;
    throw err;
  }
  return data;
}

/** POST multipart simples (FormData nativa do Node 20+). */
export async function postMultipart(url, fields, files, opts = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields || {})) form.append(k, String(v));
  for (const [name, { buffer, filename, type }] of Object.entries(files || {})) {
    form.append(name, new Blob([buffer], { type: type || 'application/octet-stream' }), filename || name);
  }
  const res = await fetchWithTimeout(url, { ...opts, method: 'POST', body: form });
  const raw = await res.arrayBuffer();
  if (!res.ok) {
    const text = Buffer.from(raw).toString('utf8').slice(0, 200);
    const err = new HttpError(`HTTP ${res.status} em ${shortUrl(url)}: ${text}`, { status: res.status, url });
    err.bodyText = text;
    throw err;
  }
  const ct = String(res.headers.get('content-type') || '');
  if (ct.includes('application/json')) {
    try {
      return { json: JSON.parse(Buffer.from(raw).toString('utf8')), buffer: null, contentType: ct };
    } catch {}
  }
  return { json: null, buffer: Buffer.from(raw), contentType: ct };
}

/**
 * Requisição crua e tolerante: NUNCA lança por status (o chamador decide).
 * Retorna o objeto Response do fetch já com o timeout aplicado.
 */
export async function rawFetch(url, { method = 'GET', headers = {}, body, timeoutMs = 20_000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  try {
    return await fetch(url, {
      method,
      redirect: 'follow',
      headers: {
        'user-agent': randomUA(),
        accept: '*/*',
        'accept-language': 'pt-BR,pt;q=0.9,en;q=0.8',
        ...lowerKeys(headers)
      },
      body,
      signal: ctrl.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

/** O user-agent que hosts (Threads, Instagram, Facebook) usam para link preview. */
export const CRAWLER_AGENT = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

/** Headers de navegação completa — hosts que bloqueiam fetch simples exigem estes. */
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

/** GET tolerante: devolve texto/JSON já parseado + status e url final. */
export async function httpGet(url, { headers = {}, timeoutMs = 20_000, json = false } = {}) {
  const res = await rawFetch(url, { method: 'GET', headers, timeoutMs });
  const out = {
    status: res.status,
    ok: res.ok,
    headers: res.headers,
    finalUrl: res.url || url,
    contentType: String(res.headers.get('content-type') || '')
  };
  if (json) {
    const text = await res.text();
    try {
      out.data = JSON.parse(text);
    } catch {
      out.data = null;
    }
    out.text = text;
  } else {
    out.text = await res.text();
  }
  return out;
}

/**
 * Resolve redirects e retorna a URL final (links curtos: pin.it, vm.tiktok,
 * fb.watch, instagram /share/, youtu.be…).
 * Tenta HEAD e, se o host recusar, cai para GET — vários hosts não respondem HEAD.
 */
export async function resolveRedirect(url, { hops = 6, headers = {}, timeoutMs = 15_000 } = {}) {
  let current = url;
  for (let i = 0; i < hops; i++) {
    // 1) HEAD (barato)
    let location = null;
    try {
      const res = await rawFetch(current, {
        method: 'HEAD',
        redirect: 'manual',
        headers,
        timeoutMs
      });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        location = res.headers.get('location');
      }
    } catch {
      /* ignora */
    }
    // 2) GET manual (hosts que recusam HEAD)
    if (!location) {
      try {
        const res = await rawFetch(current, {
          method: 'GET',
          redirect: 'manual',
          headers: { ...BROWSER_PAGE_HEADERS, ...headers },
          timeoutMs
        });
        if ([301, 302, 303, 307, 308].includes(res.status)) {
          location = res.headers.get('location');
        }
        res.body?.cancel?.().catch(() => {});
      } catch {
        /* ignora */
      }
    }
    if (!location) break;
    try {
      current = new URL(location, current).toString();
    } catch {
      break;
    }
  }
  return current;
}

/** Descobre o Referer correto para CDN de mídia (alguns exigem ou dão 403). */
export function mediaReferer(url) {
  const u = String(url || '');
  if (u.includes('tikwm.com')) return 'https://www.tikwm.com/';
  if (u.includes('tiktokcdn') || u.includes('tiktok')) return 'https://www.tiktok.com/';
  if (u.includes('pinimg.com')) return 'https://www.pinterest.com/';
  if (u.includes('cdninstagram') || u.includes('fbcdn.net')) return 'https://www.instagram.com/';
  if (u.includes('googlevideo.com') || u.includes('ytimg.com')) return 'https://www.youtube.com/';
  if (u.includes('twimg.com')) return 'https://x.com/';
  if (u.includes('fbcdn') || u.includes('facebook')) return 'https://www.facebook.com/';
  if (u.includes('redd.it')) return 'https://www.reddit.com/';
  return '';
}

export function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname !== '/' ? u.pathname.slice(0, 30) : '');
  } catch {
    return String(url).slice(0, 40);
  }
}

export function formatBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = Number(n) || 0;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
