// 🃏 ComedyHub (thecomedyhub.com.br) — rede social brasileira de memes.
//
// POR QUE ESTE ARQUIVO EXISTE (o bug da "foto de introdução")
// ----------------------------------------------------------
// A página do meme é uma SPA (React + Vite) e o conteúdo só é montado DEPOIS do
// login: o HTML que o servidor entrega é só o esqueleto com as metas do site —
// `og:image = /images/logos/opengrath.webp`. Sem extrator dedicado, o bot caía
// no raspador genérico, lia essas metas e mandava essa imagem (a "foto de
// introdução") no lugar do meme. Não é falta de rede nem de sorte: é o desenho
// do site, que exige sessão autenticada para liberar o post.
//
// O QUE ESTE MÓDULO FAZ
// ---------------------
//   1) reconhece o link (`/meme/<uuid>`, `/app/post/<uuid>`, `?id=<uuid>`);
//   2) pega a sessão do usuário — token do `.env` (COMEDYHUB_TOKEN) ou salvo
//      pelo `.chlogin` / `.chtoken` em `data/comedyhub.json`;
//   3) consulta a API oficial (`https://api.thecomedyhub.com.br/api/v2`) na rota
//      do post (`/memes/{id}`) e lê os campos REAIS de mídia do modelo Post:
//      `contentUrl`, `downloadUrl`, `downloadExtension`, `thumbnailUrl`;
//   4) SONDA cada candidato antes de entregar — é o mesmo cuidado dos outros
//      extratores: se o servidor devolver a capa em vez do vídeo, o bot tenta o
//      próximo candidato em vez de mandar arquivo errado;
//   5) sem sessão (ou se a API falhar) cai no CDN PÚBLICO dos memes — ver
//      abaixo.
//
// O CDN É PÚBLICO (por que dá para baixar sem login)
// --------------------------------------------------
// O player do site toca os memes pelo Bunny CDN `comedyhub-api.b-cdn.net`, em
// `/memes/<id>/…`: o arquivo original (`/memes/<id>/<id>.mp4`) e as playlists
// HLS (`/memes/<id>/playlist.m3u8` → `480p/` e `720p/`). Esse caminho NÃO pede
// token — medido em campo, com o meme de exemplo do bug:
//   GET https://comedyhub-api.b-cdn.net/memes/<id>/playlist.m3u8 → 200 (HLS)
//   GET https://comedyhub-api.b-cdn.net/memes/<id>/<id>.mp4       → 200 (MP4)
// Então o bot tenta a API (que traz título/autor e o arquivo canônico) e, se
// não houver sessão, baixa do CDN em vez de desistir. Em nenhum caminho a capa
// (`og:image`) é usada como se fosse o meme.
//
// O que é público na API (não precisa de token): `GET /api/v2/metrics/json`.
// Todo o resto do conteúdo responde 401 `"Token não fornecido."` — daí a sessão.

import { httpGet, postJson, formatBytes, sleep } from '../../core/http.js';
import { readJson, writeJsonNow } from '../../core/store.js';
import { log } from '../../core/logger.js';
import { probeStream, kindByExtension, kindByContentType } from './media.js';

export const COMEDYHUB_WEB = 'https://thecomedyhub.com.br';
export const COMEDYHUB_API = 'https://api.thecomedyhub.com.br';
export const COMEDYHUB_API_BASE = `${COMEDYHUB_API}/api/v2`;
/** CDN (Bunny) que serve as mídias dos memes — público, NÃO precisa de sessão. */
export const COMEDYHUB_CDN = 'https://comedyhub-api.b-cdn.net';
/** CDNs alternativos já vistos em campo (podem estar fora do ar; sondamos mesmo assim). */
const COMEDYHUB_CDN_ALTS = ['https://cdn.thecomedyhub.com.br/cdn', 'https://comedyhub.b-cdn.net'];

const SESSION_FILE = 'comedyhub.json';
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const MEDIA_EXT_RE = /\.(mp4|webm|mov|m4v|mkv|gif|jpg|jpeg|png|webp|avif|mp3|m4a|opus|ogg|wav|flac)(\?|$)/i;

/** Hosts do ComedyHub (site, API e os CDNs que servem os memes). */
const COMEDYHUB_HOSTS = ['comedyhub-api.b-cdn.net', 'comedyhub.b-cdn.net', 'cdn.thecomedyhub.com.br'];

export function isComedyHubUrl(url) {
  const value = String(url || '').trim();
  if (!value) return false;
  const candidates = [value, `https://${value.replace(/^\/+/, '')}`];
  for (const candidate of candidates) {
    try {
      const host = new URL(candidate).hostname.toLowerCase();
      if (host === 'thecomedyhub.com.br' || host.endsWith('.thecomedyhub.com.br')) return true;
      if (COMEDYHUB_HOSTS.includes(host)) return true;
    } catch {
      /* tenta o próximo formato */
    }
  }
  return false;
}

function isComedyHubHost(url) {
  try {
    const host = new URL(String(url)).hostname.toLowerCase();
    return host === 'thecomedyhub.com.br' || host.endsWith('.thecomedyhub.com.br');
  } catch {
    return false;
  }
}

/**
 * ID (UUID) do meme dentro de um link do ComedyHub.
 * Aceita `/meme/<id>`, `/app/post/<id>`, `/post/<id>`, `/chub/<id>` e `?id=<uuid>`.
 */
export function comedyHubPostId(url) {
  const raw = String(url || '').trim();
  if (!raw) return null;
  const path = raw.match(/(?:meme|memes|post|posts|chub|chubs|p)\/([0-9a-f-]{20,})/i)?.[1];
  if (path && UUID_RE.test(path)) return UUID_RE.exec(path)[0].toLowerCase();
  const query = raw.match(/[?&](?:id|memeId|postId)=([0-9a-f-]{20,})/i)?.[1];
  if (query && UUID_RE.test(query)) return UUID_RE.exec(query)[0].toLowerCase();
  const loose = UUID_RE.exec(raw);
  return loose ? loose[0].toLowerCase() : null;
}

/** Link canônico do post (é o que o WhatsApp/app do site mostra). */
export function comedyHubPostUrl(id) {
  return `${COMEDYHUB_WEB}/meme/${id}`;
}

/* ───────────────────────────── sessão (JWT) ───────────────────────────── */

/** Lê o `exp` (segundos) de um JWT sem validar assinatura — só para saber se venceu. */
export function decodeJwtPayload(token) {
  const parts = String(token || '').trim().split('.');
  if (parts.length < 2) return null;
  try {
    const payload = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const data = JSON.parse(payload);
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

export function jwtExpiresAt(token) {
  const payload = decodeJwtPayload(token);
  const exp = Number(payload?.exp);
  return Number.isFinite(exp) && exp > 0 ? exp * 1000 : 0;
}

export function tokenExpired(token, skewMs = 30_000) {
  const expiresAt = jwtExpiresAt(token);
  return expiresAt > 0 && expiresAt <= Date.now() + skewMs;
}

function normalizeToken(value) {
  return String(value || '').trim().replace(/^Bearer\s+/i, '').replace(/^"|"$/g, '');
}

function tokenFromEnv() {
  for (const name of ['COMEDYHUB_TOKEN', 'COMEDYHUB_JWT', 'COMEDYHUB_ACCESS_TOKEN']) {
    const token = normalizeToken(process.env[name]);
    if (token) return { token, source: name };
  }
  return null;
}

function readStoredSession() {
  const data = readJson(SESSION_FILE, null);
  const token = normalizeToken(data?.token);
  if (!token) return null;
  return { token, user: data?.user || '', savedAt: Number(data?.savedAt) || 0, source: 'data/comedyhub.json' };
}

/**
 * Sessão utilizável: variável de ambiente manda (mais fácil de trocar), depois
 * o token salvo pelo `.chlogin`/`.chtoken`. Token vencido é descartado para não
 * repetir um 498 sem explicação.
 */
export function comedyHubSession() {
  const env = tokenFromEnv();
  if (env) {
    return { ...env, expired: tokenExpired(env.token), payload: decodeJwtPayload(env.token) };
  }
  const stored = readStoredSession();
  if (!stored) return null;
  return { ...stored, expired: tokenExpired(stored.token), payload: decodeJwtPayload(stored.token) };
}

export function saveComedyHubSession(token, { user = '', payload = null } = {}) {
  const clean = normalizeToken(token);
  if (!clean) throw new Error('token vazio');
  const info = payload || decodeJwtPayload(clean) || {};
  const data = {
    token: clean,
    user: String(user || info.username || info.name || info.email || info.sub || '').slice(0, 120),
    savedAt: Date.now(),
    expiresAt: jwtExpiresAt(clean)
  };
  writeJsonNow(SESSION_FILE, data);
  return data;
}

export function clearComedyHubSession() {
  writeJsonNow(SESSION_FILE, { token: '', user: '', savedAt: 0 });
}

/** Resumo para o `.chstatus` / `.doctor` (nunca devolve o token inteiro). */
export function comedyHubSessionStatus() {
  const session = comedyHubSession();
  if (!session) return { logged: false, source: '', user: '', expiresAt: 0, expired: false };
  return {
    logged: true,
    source: session.source,
    user: session.user || '',
    expiresAt: jwtExpiresAt(session.token),
    expired: tokenExpired(session.token)
  };
}

/** Esconde o miolo do token em mensagens (mostra só o começo). */
export function maskToken(token) {
  const clean = String(token || '');
  return clean.length > 18 ? `${clean.slice(0, 12)}…${clean.slice(-6)}` : '•••';
}

/* ─────────────────────────────── login ─────────────────────────────── */

// A rota de login do site não é pública nas documentações, então o bot procura
// onde ela costuma morar (o backend é Spring Boot e o prefixo é /api/v2) e para
// na primeira que aceitar as credenciais. Se nenhuma servir, o `.chtoken` ainda
// funciona — é o caminho garantido.
const LOGIN_PATHS = [
  '/auth/login', // espelha a rota da página do site (/auth/login)
  '/login', // a documentação do projeto cita o rate limit de `/api/login`
  '/auth/sessions',
  '/sessions',
  '/auth/signin',
  '/signin',
  '/users/login',
  '/auth/token',
  '/users/sessions',
  '/authenticate'
];

// JWT: três partes em base64url separadas por ponto. A assinatura varia muito
// de tamanho entre implementações, então o teste é tolerante (só o formato).
const JWT_RE = /^eyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]{1,}$/;

/** Procura um JWT em qualquer canto da resposta (token, accessToken, data…). */
export function findJwt(value, depth = 0) {
  if (depth > 6 || value == null) return null;
  if (typeof value === 'string') {
    const clean = normalizeToken(value);
    return JWT_RE.test(clean) ? clean : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findJwt(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === 'object') {
    const preferred = ['token', 'accessToken', 'access_token', 'jwt', 'idToken', 'id_token', 'acessToken', 'bearerToken'];
    for (const key of preferred) {
      const found = findJwt(value[key], depth + 1);
      if (found) return found;
    }
    for (const item of Object.values(value)) {
      const found = findJwt(item, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function bodyVariants(identifier, password) {
  return [
    { login: identifier, password },
    { email: identifier, password },
    { username: identifier, password },
    { identifier, password }
  ];
}

function shortJson(value) {
  try {
    return JSON.stringify(value ?? null).slice(0, 140);
  } catch {
    return '';
  }
}

/**
 * Faz login na API do ComedyHub e guarda o JWT.
 *
 * Observação importante: o site pode pedir verificação por e-mail (a terceira
 * etapa do formulário). Quando isso acontece a resposta vem sem token — nesse
 * caso o caminho é entrar no site e usar `.chtoken`.
 *
 * @param {string} identifier e-mail ou nome de usuário
 * @param {string} password senha
 * @returns {Promise<{token: string, user: string, endpoint: string}>}
 */
export async function comedyHubLogin(identifier, password, { hint } = {}) {
  const login = String(identifier || '').trim();
  const secret = String(password || '');
  if (!login || !secret) throw new Error('informe login e senha: `.chlogin email senha`');

  const notes = [];
  let stop = false; // setado quando a rota respondeu algo definitivo (senha errada, 2FA…)
  let attempts = 0;
  for (const path of LOGIN_PATHS) {
    if (stop) break;
    // O site limita tentativas de login; entre uma rota e outra o bot respira
    // um pouco para não parecer ataque de força bruta.
    if (attempts++ > 0) await sleep(150);
    const url = `${COMEDYHUB_API_BASE}${path}`;
    for (const [index, body] of bodyVariants(login, secret).entries()) {
      let data;
      try {
        data = await postJson(url, body, {
          headers: { 'user-agent': BROWSER_UA, accept: 'application/json', origin: COMEDYHUB_WEB, referer: `${COMEDYHUB_WEB}/auth/login` },
          timeoutMs: 20_000,
          maxResponseBytes: 512 * 1024
        });
      } catch (error) {
        const status = Number(error?.status) || 0;
        if (status === 404 || status === 405) break; // rota não existe: tenta a próxima
        if (status === 400 || status === 422) {
          if (index < 3) continue; // payload rejeitado: tenta outro formato de corpo
          notes.push(`${path}: dados recusados (${status})`);
          break;
        }
        if (status === 401 || status === 403) {
          notes.push(`${path}: login ou senha recusados`);
          stop = true; // não adianta repetir em outras rotas
          break;
        }
        if (status === 429) {
          notes.push(`${path}: limite de tentativas do site (429) — espere 1 minuto`);
          stop = true;
          break;
        }
        notes.push(`${path}: ${status || String(error?.message || error).slice(0, 60)}`);
        break;
      }

      const token = findJwt(data);
      if (token) {
        const payload = decodeJwtPayload(token) || {};
        const saved = saveComedyHubSession(token, { payload });
        log.dl(`comedyhub: login ok via ${path}`);
        return { token, user: saved.user, endpoint: `${COMEDYHUB_API_BASE}${path}` };
      }
      // 2xx sem token: no site real isso é o desafio de verificação por e-mail.
      // Como a rota certa respondeu, parar aqui evita disparar o mesmo login
      // (com senha) em todas as outras rotas candidatas.
      notes.push(`${path}: resposta sem token ${shortJson(data)}`);
      stop = true;
      break;
    }
  }

  const detail = notes.length ? ` (${notes.join(' | ')})` : '';
  const error = new Error(
    `não consegui logar no ComedyHub${detail}. ` +
      'Se o site pede código por e-mail, entre pelo navegador e use `.chtoken <token>`.'
  );
  error.notes = notes;
  // Sempre com um caminho alternativo: o login do site pode exigir código por
  // e-mail, e nesse caso o token copiado do navegador resolve na hora.
  error.hint =
    hint ||
    'plano B garantido: entre no site, F12 → Application → Local Storage → thecomedyhub.com.br e use `.chtoken <valor que começa com eyJ>`';
  throw error;
}

// Um erro de login automático não deve virar uma tentativa a cada download:
// se as credenciais do .env falharem, o bot espera alguns minutos antes de
// tentar de novo (o site limita /login a 5 tentativas por minuto).
let autoLoginCooldownUntil = 0;
const AUTO_LOGIN_COOLDOWN_MS = 5 * 60_000;

/**
 * Sessão pronta para uso: token salvo no `.env`/`data/comedyhub.json` — ou
 * login automático, quando COMEDYHUB_LOGIN + COMEDYHUB_PASSWORD estão no .env.
 */
export async function comedyHubSessionOrLogin() {
  const session = comedyHubSession();
  if (session?.token && !session.expired) return session;

  const login = String(process.env.COMEDYHUB_LOGIN || process.env.COMEDYHUB_EMAIL || '').trim();
  const password = String(process.env.COMEDYHUB_PASSWORD || '');
  if (login && password && Date.now() > autoLoginCooldownUntil) {
    try {
      const out = await comedyHubLogin(login, password);
      return { token: out.token, user: out.user, source: 'login automático (.env)', payload: decodeJwtPayload(out.token) };
    } catch (error) {
      autoLoginCooldownUntil = Date.now() + AUTO_LOGIN_COOLDOWN_MS;
      log.warn('comedyhub: login automático falhou', {
        message: String(error?.message || error).slice(0, 160)
      });
    }
  }
  return session;
}

/* ─────────────────────────── consulta do post ─────────────────────────── */

const POST_PATHS = ['/memes/{id}', '/posts/{id}', '/memes/id/{id}', '/chubs/{id}', '/posts/id/{id}'];

function authHeaders(token) {
  return {
    'user-agent': BROWSER_UA,
    accept: 'application/json',
    authorization: `Bearer ${token}`,
    origin: COMEDYHUB_WEB,
    referer: `${COMEDYHUB_WEB}/app/feed/recents`
  };
}

function looksLikePost(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.some((key) => ['contentUrl', 'downloadUrl', 'mediaUrl', 'thumbnailUrl', 'memeUrl'].includes(key))) return true;
  return keys.includes('id') && keys.some((key) => ['type', 'title', 'status', 'createdBy'].includes(key));
}

function unwrapPost(data) {
  if (!data || typeof data !== 'object') return null;
  for (const key of ['data', 'meme', 'post', 'chub', 'result', 'content']) {
    if (looksLikePost(data[key])) return data[key];
  }
  return looksLikePost(data) ? data : null;
}

/**
 * Baixa o JSON do post na API oficial.
 * @returns {Promise<Record<string, any>>}
 */
export async function fetchComedyHubPost(id, token) {
  const cleanId = comedyHubPostId(id) || String(id || '').trim();
  if (!cleanId) throw new Error('ID do meme inválido');
  if (!token) throw new Error('sessão do ComedyHub ausente');

  const errors = [];
  for (const path of POST_PATHS) {
    const url = `${COMEDYHUB_API_BASE}${path.replace('{id}', encodeURIComponent(cleanId))}`;
    try {
      const res = await httpGet(url, { headers: authHeaders(token), json: true, timeoutMs: 25_000, maxBytes: 1024 * 1024 });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          const error = new Error('o ComedyHub recusou a sessão (401)');
          error.status = res.status;
          error.hint = 'faça login de novo: `.chlogin email senha` ou atualize com `.chtoken <token>`';
          throw error;
        }
        if (res.status === 498) {
          const error = new Error('a sessão do ComedyHub venceu (498)');
          error.status = res.status;
          error.hint = 'renove com `.chlogin email senha` ou `.chtoken <token>`';
          throw error;
        }
        if (res.status === 404) {
          errors.push(`${path}: 404`);
          continue;
        }
        errors.push(`${path}: HTTP ${res.status}`);
        continue;
      }
      const post = unwrapPost(res.data);
      if (post) return { ...post, __endpoint: url };
      errors.push(`${path}: resposta sem dados do post`);
    } catch (error) {
      if (error?.status === 401 || error?.status === 403 || error?.status === 498) throw error;
      errors.push(`${path}: ${String(error?.message || error).slice(0, 80)}`);
    }
  }

  const error = new Error(`não achei o post ${cleanId} na API do ComedyHub (${errors.join(' | ')})`);
  error.hint = 'o meme pode ter sido apagado ou está em moderação (status PENDING/REVIEW)';
  throw error;
}

/* ───────────────────────── extração dos candidatos ───────────────────────── */

function absoluteMediaUrl(raw) {
  const value = String(raw || '').trim().replace(/\\\//g, '/');
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith('/api/') || value.startsWith('/static/')) return `${COMEDYHUB_API}${value}`;
  if (value.startsWith('/')) return `${COMEDYHUB_WEB}${value}`;
  return '';
}

function kindFromPost(post, url) {
  const byExt = kindByExtension(url);
  if (byExt !== 'unknown') return byExt === 'audio' ? 'audio' : byExt;
  const type = String(post?.type || post?.mediaType || '').toLowerCase();
  if (type === 'video') return 'video';
  if (type === 'image' || type === 'photo') return 'image';
  return 'video';
}

/**
 * Lista os candidatos de mídia do post, do mais provável ao menos provável.
 *
 * `thumbnailUrl` fica por último e SÓ entra quando não existe nenhum outro
 * arquivo: usar a capa como se fosse o vídeo foi exatamente o bug que este
 * extrator veio corrigir.
 */
/**
 * Descarta links que são PÁGINA (rota do app), não arquivo: `post.url` às vezes
 * aponta para `/meme/<id>` e isso não pode virar candidato de mídia.
 */
function looksLikePageUrl(url) {
  if (/\/(?:static|files?|media|uploads?|storage|assets)\//i.test(url)) return false;
  if (MEDIA_EXT_RE.test(url)) return false;
  return /\/(?:meme|memes|post|posts|chub|chubs|app|feed|profile|perfil|auth|login|register|settings)(?:\/|$)/i.test(url);
}

export function comedyHubMediaCandidates(post) {
  if (!post || typeof post !== 'object') return [];
  const found = [];
  const push = (raw, label) => {
    const url = absoluteMediaUrl(raw);
    if (!url) return;
    if (looksLikePageUrl(url)) return;
    if (!MEDIA_EXT_RE.test(url) && !isComedyHubHost(url) && !/\/files?\//i.test(url)) return;
    if (found.some((item) => item.url === url)) return;
    found.push({ url, label, kind: kindFromPost(post, url) });
  };

  // 1) Campos oficiais do modelo Post (web app usa exatamente estes).
  push(post.downloadUrl, 'downloadUrl');
  push(post.contentUrl, 'contentUrl');
  push(post.mediaUrl, 'mediaUrl');
  push(post.videoUrl, 'videoUrl');
  push(post.imageUrl, 'imageUrl');
  push(post.fileUrl, 'fileUrl');
  push(typeof post.file === 'string' ? post.file : post.file?.url, 'file');
  push(post.media?.url, 'media');
  push(post.url, 'url');

  // 2) Varredura: qualquer URL/caminho de arquivo citado no JSON.
  const seen = new Set();
  const visit = (value, depth = 0) => {
    if (depth > 5 || value == null) return;
    if (typeof value === 'string') {
      if (MEDIA_EXT_RE.test(value) || (isComedyHubHost(value) && /\/(?:static|files?|media)\//i.test(value))) {
        if (!seen.has(value)) {
          seen.add(value);
          push(value, 'json');
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 25)) visit(item, depth + 1);
      return;
    }
    if (typeof value === 'object') for (const item of Object.values(value)) visit(item, depth + 1);
  };
  visit(post);

  // 3) A capa é o ÚLTIMO recurso, nunca um candidato comum: foi usando a capa
  //    como se fosse o vídeo que o bot mandava a "foto de introdução".
  const thumbnail = absoluteMediaUrl(post.thumbnailUrl);
  const real = thumbnail ? found.filter((item) => item.url !== thumbnail) : found;
  if (!real.length && thumbnail) {
    const cover = { url: thumbnail, label: 'thumbnailUrl', kind: kindFromPost(post, thumbnail) };
    return [cover];
  }

  const extension = String(post.downloadExtension || '').trim();
  return real.map((item) => ({
    ...item,
    label: extension && item.label === 'downloadUrl' ? `download ${extension}` : item.label
  }));
}

/** Cabeçalhos da mídia: token só vai para os hosts do próprio ComedyHub. */
export function comedyHubMediaHeaders(url, token) {
  const headers = {
    'user-agent': BROWSER_UA,
    referer: `${COMEDYHUB_WEB}/`
  };
  if (token && isComedyHubHost(url)) headers.authorization = `Bearer ${token}`;
  return headers;
}

const PROBE_EXPECT = { video: 'video', image: 'image', gif: 'image', audio: 'image' };

/**
 * Sonda os candidatos e devolve o primeiro que REALMENTE serve a mídia do tipo
 * esperado. Se nenhum passar na sonda, devolve o primeiro que não foi
 * comprovadamente do tipo errado (assim o erro real aparece na hora de baixar,
 * com mensagem, em vez de mandar a foto de capa).
 */
export async function pickComedyHubMedia(candidates, expectedKind, { token } = {}) {
  const list = candidates.filter((item) => item?.url);
  if (!list.length) return null;

  // Sondar SEMPRE (mesmo com um só candidato) é o que impede o bot de aceitar
  // uma página HTML ou a capa como se fosse o meme: a sonda lê os primeiros
  // bytes e compara com o tipo do post.
  const expect = PROBE_EXPECT[expectedKind] || 'video';
  let fallback = null;
  for (const candidate of list) {
    const probe = await probeStream(candidate.url, {
      expect,
      timeoutMs: 12_000,
      referer: `${COMEDYHUB_WEB}/`
    }).catch(() => ({ verdict: 'unreachable' }));
    if (probe.verdict === 'ok') return { ...candidate, sizeBytes: probe.sizeBytes, contentType: probe.contentType };
    if (probe.verdict !== 'wrong-type' && !fallback) fallback = candidate;
    log.dl(`comedyhub: candidato ${candidate.label} recusado (${probe.verdict}${probe.contentType ? ` · ${probe.contentType}` : ''})`);
  }
  if (fallback) return fallback;
  const error = new Error('nenhum arquivo de mídia do meme respondeu com o tipo esperado');
  error.hint =
    'o post pode estar em moderação (só com a capa, sem o arquivo) ou o vídeo pode ter sido apagado do storage; tente outro link';
  throw error;
}

/* ─────────────────── CDN público: funciona SEM sessão ─────────────────── */

const CDN_VIDEO_EXTS = ['mp4', 'webm', 'mov', 'm4v', 'mkv'];
const CDN_IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'gif'];

/**
 * Candidatos do CDN para um meme, na ordem de sondagem:
 *   1) o ARQUIVO direto (`/memes/<id>/<id>.<ext>`) — é o upload original e não
 *      precisa remuxar (o `<ext>` varia com o post, por isso tentamos vários);
 *   2) as playlists HLS do player (`playlist.m3u8`, depois `720p` e `480p`) —
 *      o motor HLS do bot baixa os segmentos e entrega MP4.
 *
 * `expectedKind` (quando o post já é conhecido) só muda a ORDEM das extensões:
 * vídeo começa por mp4/webm, imagem por jpg/png/webp.
 */
export function comedyHubCdnCandidates(id, { expectedKind } = {}) {
  const cleanId = String(id || '').trim();
  if (!cleanId) return [];
  const exts =
    expectedKind === 'image'
      ? [...CDN_IMAGE_EXTS, ...CDN_VIDEO_EXTS]
      : expectedKind === 'video'
        ? [...CDN_VIDEO_EXTS, ...CDN_IMAGE_EXTS]
        : [...CDN_VIDEO_EXTS, ...CDN_IMAGE_EXTS];

  const list = [];
  for (const base of [COMEDYHUB_CDN, ...COMEDYHUB_CDN_ALTS]) {
    const dir = `${base}/memes/${cleanId}`;
    for (const ext of exts) {
      const url = `${dir}/${cleanId}.${ext}`;
      const kind = kindByExtension(url);
      list.push({ url, label: `cdn ${ext}`, kind: kind === 'unknown' ? 'video' : kind });
    }
    list.push({ url: `${dir}/playlist.m3u8`, label: 'cdn hls', kind: 'video' });
    list.push({ url: `${dir}/720p/playlist.m3u8`, label: 'cdn hls 720p', kind: 'video' });
    list.push({ url: `${dir}/480p/playlist.m3u8`, label: 'cdn hls 480p', kind: 'video' });
  }
  return list;
}

/**
 * Escolhe o primeiro candidato do CDN que responde 200/206 COM bytes.
 *
 * Deliberadamente NÃO existe "último recurso" aqui: no bucket, chave que não
 * existe vira 404 — usar um candidato 404 só trocaria um erro claro por um
 * "não consegui baixar" no fim. Também recusa `text/html` (é o que o CDN
 * devolve quando o domínio está suspenso — não é meme).
 */
export async function pickComedyHubCdnMedia(id, { expectedKind, quality = 'melhor' } = {}) {
  const candidates = comedyHubCdnCandidates(id, { expectedKind });
  if (!candidates.length) return null;
  const expect = expectedKind === 'image' ? 'image' : expectedKind === 'video' ? 'video' : undefined;
  for (const candidate of candidates) {
    const probe = await probeStream(candidate.url, { expect, timeoutMs: 12_000 }).catch(() => null);
    if (!probe || probe.verdict !== 'ok' || /text\/html/i.test(String(probe.contentType || ''))) {
      log.dl(`comedyhub cdn: ${candidate.label} indisponível (${probe?.verdict || 'erro'})`);
      continue;
    }
    const kind = kindByContentType(probe.contentType) || candidate.kind;
    return { ...candidate, kind, sizeBytes: probe.sizeBytes, contentType: probe.contentType };
  }
  return null;
}

/* ─────────────────────────────── download ─────────────────────────────── */

function summarizeAuthor(post) {
  const user = post?.createdBy || post?.user || post?.author || post?.creator || null;
  if (!user) return '';
  if (typeof user === 'string') return user.startsWith('@') ? user : `@${user}`;
  const name = user.username || user.name || user.displayName || user.nickname || '';
  return name ? `@${String(name).replace(/^@/, '')}` : '';
}

function baseResult(extra = {}) {
  return {
    platform: 'ComedyHub',
    title: '',
    author: '',
    duration: 0,
    thumbnail: '',
    kind: 'video',
    media: [],
    alternates: [],
    ...extra
  };
}

/**
 * Extrator dedicado do ComedyHub.
 * @param {string} url link `/meme/<uuid>` (ou `/app/post/<uuid>`)
 * @param {'melhor'|'alta'|'media'|'baixa'} quality mantido por compatibilidade (o site serve o arquivo original)
 */
export async function downloadComedyHub(url, quality = 'melhor', { maxBytes } = {}) {
  const id = comedyHubPostId(url);
  if (!id) {
    const error = new Error('não achei o ID do meme nesse link do ComedyHub');
    error.hint = 'use o link completo, por exemplo https://thecomedyhub.com.br/meme/<id>';
    throw error;
  }

  const session = await comedyHubSessionOrLogin();
  const notes = [];
  let post = null;
  let chosen = null;
  let expectedKind = '';
  let apiError = null;

  // 1) Caminho preferido: API oficial com a sessão do dono (traz título, autor
  //    e o arquivo canônico do post).
  if (session?.token && !session.expired) {
    try {
      post = await fetchComedyHubPost(id, session.token);
      const candidates = comedyHubMediaCandidates(post);
      const postType = String(post.type || post.mediaType || '').toLowerCase();
      expectedKind =
        postType === 'video' ? 'video' : postType === 'image' || postType === 'photo' ? 'image' : candidates[0]?.kind || '';
      if (candidates.length) chosen = await pickComedyHubMedia(candidates, expectedKind, { token: session.token });
    } catch (error) {
      apiError = error;
      log.dl(`comedyhub: API não liberou o post (${String(error?.message || error).slice(0, 120)}) — tentando o CDN público`);
    }
  }

  // 2) Plano B (e caminho normal de quem não tem sessão): CDN público.
  let viaCdn = false;
  if (!chosen) {
    const cdn = await pickComedyHubCdnMedia(id, { expectedKind, quality });
    if (cdn) {
      chosen = cdn;
      viaCdn = true;
    }
  }

  if (!chosen) {
    // Nenhum caminho deu certo: junta o motivo da API (sessão vencida, post em
    // moderação, meme apagado…) com o fato de o CDN também não ter o arquivo —
    // é isso que faz a resposta do bot ser útil em vez de "falhou".
    const base =
      session?.token && !session.expired
        ? 'não consegui baixar esse meme do ComedyHub'
        : 'o ComedyHub só libera meme/foto de verdade para quem está logado — e o CDN público não tinha esse arquivo';
    const error = new Error(apiError?.message ? `${base}: ${String(apiError.message).slice(0, 160)}` : base);
    error.hint =
      apiError?.hint ||
      (session?.token && !session.expired
        ? 'confira a sessão com `.chstatus`; se o post está em moderação, só existe a capa'
        : 'entre uma vez com `.chlogin seu@email.com suasenha` — ou copie o token no site (F12 → Application → Local Storage → thecomedyhub.com.br) e use `.chtoken <token>`');
    if (apiError?.details) error.details = apiError.details;
    throw error;
  }

  if (viaCdn) {
    notes.push(
      session?.expired
        ? 'sessão vencida — peguei pelo CDN público (`.chlogin` renova)'
        : session?.token
          ? 'peguei pelo CDN público'
          : 'sem login — peguei pelo CDN público (`.chlogin` libera os antigos)'
    );
  }

  // O tipo do POST manda: um vídeo continua vídeo mesmo se o arquivo escolhido
  // tiver nome de imagem (a sonda usa isso para recusar capa).
  const postType = String(post?.type || post?.mediaType || '').toLowerCase();
  const kind =
    expectedKind === 'video' || postType === 'video' ? 'video' : chosen.kind === 'audio' ? 'video' : chosen.kind;
  const pending = ['PENDING', 'REVIEW'].includes(String(post?.status || '').toUpperCase());

  log.dl(`comedyhub: ${id} · ${chosen.label} · ${kind}${chosen.sizeBytes ? ` · ${formatBytes(chosen.sizeBytes)}` : ''}`);

  // Reservas: sem CDN são os outros candidatos da API; com CDN, os próximos do
  // próprio CDN (o engine só usa isso se o primeiro download falhar).
  const others = viaCdn
    ? comedyHubCdnCandidates(id, { expectedKind })
        .filter((item) => item.url !== chosen.url)
        .slice(0, 2)
    : comedyHubMediaCandidates(post).filter((item) => item.url !== chosen.url);

  return baseResult({
    kind,
    title: String(post?.title || post?.description || '').slice(0, 300) || 'Meme do ComedyHub',
    author: summarizeAuthor(post),
    thumbnail: absoluteMediaUrl(post?.thumbnailUrl) || '',
    note: notes.join(' · '),
    media: [
      {
        type: kind,
        url: chosen.url,
        label: chosen.label,
        headers: comedyHubMediaHeaders(chosen.url, session?.token),
        contentLength: chosen.sizeBytes || 0,
        quality
      }
    ],
    alternates: others.map((item) => ({
      type: item.kind,
      url: item.url,
      label: item.label,
      headers: comedyHubMediaHeaders(item.url, session?.token)
    })),
    // O site marca meme em análise: o arquivo existe, mas pode estar só com a capa.
    partial: false,
    notes: pending ? [`meme em moderação (${post.status})`] : []
  });
}
