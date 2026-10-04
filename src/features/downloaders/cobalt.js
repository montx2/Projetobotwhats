// 🌐 Cobalt — downloader universal (YouTube, Instagram, X/Twitter, Facebook,
// Threads, Reddit, Snapchat, Vimeo, Twitch, SoundCloud, Pinterest e centenas).
//
// Por que o Cobalt importa: ele faz TÚNEL da mídia pelo próprio servidor
// (`status: "tunnel"`), então a URL devolvida não está presa à sessão assinada
// do CDN de origem e funciona de qualquer IP (inclusive Termux/datacenter).
// É a única via que responde de forma confiável para boa parte da cauda longa.
//
// A lista de instâncias agora é auto-suficiente (cobalt-instances.js):
// descoberta nas listas públicas + verificação de saúde (sem Turnstile) +
// cache em data/ + revalidação periódica e emergencial. Este módulo só mantém
// o KeyPool (cooldown de 5 min) e a conversação com a API.

import { KeyPool } from '../../core/keypool.js';
import { ENV, cfg } from '../../core/config.js';
import { postJson, fetchBuffer, shortUrl } from '../../core/http.js';
import { log } from '../../core/logger.js';
import { resolveInitialCobaltInstances, cobaltManager } from './cobalt-instances.js';

// Modo manual (COBALT_INSTANCES no .env) tem prioridade absoluta: sem
// descoberta, e as URLs do operador são consideradas confiáveis (podem ser
// locais e usar a Api-Key do COBALT_API_KEY).
const CONFIGURED_INSTANCES = ENV.cobaltInstances;
const MANUAL_MODE = CONFIGURED_INSTANCES.length > 0;

// Boot com zero latência: manual → cache → padrão embutido. A descoberta em
// segundo plano (quando ligada) troca a lista sem derrubar nada. O attach
// registra a origem no gerenciador — em modo manual ele mesmo se recusa a
// descobrir/schedule.
const INITIAL_INSTANCES = resolveInitialCobaltInstances();
const pool = new KeyPool('cobalt', INITIAL_INSTANCES.instances, { cooldownMs: 5 * 60_000 });
cobaltManager.attach(pool, INITIAL_INSTANCES);

// Instância com Turnstile nunca vai funcionar num bot (exige desafio de
// navegador): esfria por um bom tempo em vez de gastar tentativa a cada 5 min.
const AUTH_COOLDOWN_MS = 60 * 60_000;

const QUALITY_MAP = { melhor: 'max', alta: '1080', media: '720', baixa: '480' };

const VIDEO_EXT = /\.(mp4|webm|mkv|mov|m4v|avi)(\?|$)/i;
const IMAGE_EXT = /\.(jpg|jpeg|png|webp|gif|heic|avif|bmp)(\?|$)/i;
const AUDIO_EXT = /\.(mp3|m4a|opus|ogg|wav|flac|aac)(\?|$)/i;

/** Hosts que as instâncias PÚBLICAS atendem (evita gasto de cota em recusa). */
const COBALT_SERVICE_HOSTS = [
  'bilibili.com', 'bilibili.tv', 'b23.tv', 'bsky.app', 'dailymotion.com', 'dai.ly',
  'facebook.com', 'fb.watch', 'instagram.com', 'loom.com', 'ok.ru', 'pin.it',
  'redd.it', 'reddit.com', 'rutube.ru', 'snapchat.com', 'snd.sc', 'soundcloud.com',
  'streamable.com', 'tiktok.com', 'tumblr.com', 'twitch.tv', 'twitter.com',
  'vimeo.com', 'vk.com', 'vk.ru', 'vkvideo.ru', 'x.com', 'xhslink.com',
  'xiaohongshu.com', 'youtu.be', 'youtube.com'
];

const PINTEREST_HOST = /(^|\.)pinterest\.[a-z]{2,3}(\.[a-z]{2})?$/i;

export function cobaltServes(url) {
  let hostname;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (PINTEREST_HOST.test(hostname)) return true;
  return COBALT_SERVICE_HOSTS.some((h) => hostname === h || hostname.endsWith(`.${h}`));
}

function kindFromFilename(filename) {
  const ext = String(filename || '').match(/\.([A-Za-z0-9]+)$/)?.[1];
  if (!ext) return 'unknown';
  if (VIDEO_EXT.test(`.${ext}`)) return 'video';
  if (IMAGE_EXT.test(`.${ext}`)) return 'image';
  if (AUDIO_EXT.test(`.${ext}`)) return 'audio';
  return 'unknown';
}

function kindFromUrl(url) {
  if (VIDEO_EXT.test(url)) return 'video';
  if (IMAGE_EXT.test(url)) return 'image';
  if (AUDIO_EXT.test(url)) return 'audio';
  return 'unknown';
}

/**
 * Traduz a recusa de uma instância em erro claro + cooldown.
 * Turnstile = "exige verificação de navegador": nunca vai passar num bot, e o
 * segredo era o erro genérico "HTTP 401" que não dizia nada a ninguém.
 */
function mapInstanceFailure(error) {
  const code = String(error?.data?.error?.code || '');
  const status = Number(error?.status || 0);
  const poolError = (message, extra = {}) => {
    const err = new Error(`cobalt: ${message}`);
    err.status = 429; // faz o KeyPool esfriar a instância e tentar a próxima
    err.retryAfterMs = extra.cooldownMs;
    Object.assign(err, extra.flags || {});
    return err;
  };
  if (/^error\.api\.auth\.jwt/.test(code)) {
    return poolError('instância exige verificação de navegador (Turnstile) — trocando de instância', {
      cooldownMs: AUTH_COOLDOWN_MS,
      flags: { turnstile: true }
    });
  }
  if (/^error\.api\.auth\.key/.test(code)) {
    return poolError('instância exige chave de API própria — trocando de instância', {
      cooldownMs: AUTH_COOLDOWN_MS,
      flags: { authKey: true }
    });
  }
  // 401/403 SEM corpo cobalt = challenge/bloqueio de WAF (Cloudflare): a
  // instância não serve para o bot agora. Com código cobalt, o erro é da URL
  // (conteúdo) e segue o comportamento antigo: tenta a próxima sem esfriar.
  if (!code && (status === 401 || status === 403)) {
    return poolError('instância recusou o bot (autenticação/Cloudflare) — trocando de instância', {
      cooldownMs: AUTH_COOLDOWN_MS
    });
  }
  return error;
}

/** Pool falhou por completo: mensagem honesta quando o motivo é Turnstile, e
 *  revalidação emergencial da lista quando TODO mundo entrou em cooldown. */
function handlePoolFailure(error) {
  if (error?.pool !== 'cobalt') return;
  const causes = Array.isArray(error.causes) ? error.causes : [];
  const turnstileCount = causes.filter((c) => c?.turnstile).length;
  if (causes.length && turnstileCount === causes.length) {
    error.message =
      'cobalt: todas as instâncias exigem verificação de navegador (Turnstile) — um bot não consegue resolvê-las. ' +
      'Defina COBALT_INSTANCES no .env com uma instância própria ou sem Turnstile';
  } else if (turnstileCount) {
    error.message = `${error.message} (${turnstileCount} instância(s) exigem verificação de navegador)`;
  }
  const now = Date.now();
  const allCooling =
    pool.items.length > 0 && pool.items.every((item) => (pool.cooldowns.get(item) || 0) > now);
  if (allCooling) cobaltManager.onPoolExhausted();
}

/**
 * Baixa qualquer URL suportada pelo Cobalt.
 * @returns {{platform:string,title:string,kind:string,media:Array,audioOnly:?Object}}
 */
export async function cobaltDownload(url, quality = 'melhor', { audioOnly = false, maxBytes } = {}) {
  const downloadLimit = Math.max(1, Number(maxBytes) || Number(cfg.get().maxMB || 90) * 1024 * 1024);
  const body = audioOnly
    ? { url, downloadMode: 'audio', audioFormat: 'mp3', filenameStyle: 'basic' }
    : { url, videoQuality: QUALITY_MAP[quality] || 'max', filenameStyle: 'basic' };

  let data;
  try {
    data = await pool.run(
      async (instance) => {
        const res = await postJson(`${instance.replace(/\/$/, '')}/`, body, {
          headers: {
            accept: 'application/json',
            ...(MANUAL_MODE && ENV.cobaltApiKey
              ? { Authorization: `Api-Key ${ENV.cobaltApiKey}` }
              : {})
          },
          timeoutMs: 60_000,
          allowPrivate: MANUAL_MODE
        }).catch((error) => {
          throw mapInstanceFailure(error);
        });

        if (res?.status === 'error') {
          const code = res?.error?.code || 'cobalt error';
          const err = new Error(`cobalt: ${code}`);
          // Erros de conteúdo/suporte dizem respeito à URL, não à instância:
          // esfriar a instância por causa de um link não suportado custaria a
          // próxima requisição da melhor fonte.
          if (/rate|limit|unavailable|fetch|critical|timed?\s?out/i.test(code)) err.status = 429;
          throw err;
        }

        if (['tunnel', 'redirect', 'stream'].includes(res?.status)) {
          const byName = kindFromFilename(res.filename);
          const kind = audioOnly ? 'audio' : byName !== 'unknown' ? byName : kindFromUrl(res.url);
          const title = String(res.filename || '').replace(/\.[^.]+$/, '');
          const type = audioOnly ? 'audio' : kind === 'image' ? 'image' : kind === 'audio' ? 'audio' : 'video';
          return {
            platform: 'Cobalt',
            title,
            author: '',
            duration: 0,
            thumbnail: '',
            kind: type,
            media: [{ type, url: res.url, label: title }],
            audioOnly: type === 'audio' ? { type: 'audio', url: res.url, label: title || 'áudio' } : null,
            tunnel: res.status === 'tunnel'
          };
        }

        if (res?.status === 'picker' && Array.isArray(res.picker)) {
          if (audioOnly && res.audio) {
            const title = String(res.filename || '').replace(/\.[^.]+$/, '') || 'áudio';
            return {
              platform: 'Cobalt',
              title,
              author: '',
              duration: 0,
              thumbnail: '',
              kind: 'audio',
              media: [{ type: 'audio', url: res.audio, label: title }],
              audioOnly: { type: 'audio', url: res.audio, label: title }
            };
          }
          const items = res.picker.filter((p) => p?.url);
          if (!items.length) throw new Error('cobalt: picker vazio');
          const media = items.map((p, i) => ({
            type: p.type === 'gif' ? 'gif' : /^video$/i.test(p.type || '') ? 'video' : 'image',
            url: p.url,
            label: `item ${i + 1}`,
            thumb: p.thumb || ''
          }));
          const videos = media.filter((m) => m.type === 'video');
          return {
            platform: 'Cobalt',
            title: String(res.filename || '').replace(/\.[^.]+$/, '') || 'post',
            author: '',
            duration: 0,
            thumbnail: items[0]?.thumb || '',
            kind: videos.length ? 'carrossel' : 'slideshow',
            media,
            audioOnly: res.audio ? { type: 'audio', url: res.audio, label: 'áudio' } : null
          };
        }

        const err = new Error(`cobalt: status inesperado (${res?.status})`);
        err.status = 422;
        throw err;
      },
      {
        label: url.slice(0, 60),
        isExhausted: (e) => {
          const s = Number(e?.status);
          return [429, 502, 503, 500].includes(s) || /rate|limit|unavailable|fetch|critical/i.test(String(e?.message || ''));
        }
      }
    );
  } catch (error) {
    handlePoolFailure(error);
    throw error;
  }

  // Baixa os buffers já no formato esperado pelo sendDownload
  const buffers = [];
  const totalLimit = Math.min(200 * 1024 * 1024, downloadLimit * 2);
  let totalBytes = 0;
  for (const item of (data.media || []).slice(0, 10)) {
    const remaining = totalLimit - totalBytes;
    if (remaining < 1) throw new Error('álbum excede o limite agregado de mídia');
    log.dl(`cobalt: baixando ${shortUrl(item.url)}…`);
    const buffer = await fetchBuffer(item.url, { timeoutMs: 180_000, maxBytes: Math.min(downloadLimit, remaining) });
    totalBytes += buffer.length;
    buffers.push(buffer);
  }
  let audioBuffer = null;
  if (data.audioOnly?.url && data.kind !== 'audio' && totalBytes < totalLimit) {
    try {
      audioBuffer = await fetchBuffer(data.audioOnly.url, {
        timeoutMs: 120_000,
        maxBytes: Math.min(downloadLimit, totalLimit - totalBytes)
      });
      totalBytes += audioBuffer.length;
    } catch { /* o áudio é bônus */ }
  }
  return { ...data, buffers, audioBuffer };
}

export function cobaltPool() {
  return pool;
}
