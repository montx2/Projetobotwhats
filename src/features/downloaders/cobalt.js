// 🌐 Cobalt — downloader universal (YouTube, Instagram, X/Twitter, Facebook,
// Threads, Reddit, Snapchat, Vimeo, Twitch, SoundCloud, Pinterest e centenas).
//
// Por que o Cobalt importa: ele faz TÚNEL da mídia pelo próprio servidor
// (`status: "tunnel"`), então a URL devolvida não está presa à sessão assinada
// do CDN de origem e funciona de qualquer IP (inclusive Termux/datacenter).
// É a única via que responde de forma confiável para boa parte da cauda longa.
//
// Fontes reais: lista pública + verificação comunitária
// (https://instances.cobalt.best e o projeto Vette1123/social-media-downloader,
// que mediu as instâncias a partir de produção em 2026-08).

import { KeyPool } from '../../core/keypool.js';
import { ENV } from '../../core/config.js';
import { postJson, fetchBuffer } from '../../core/http.js';
import { log } from '../../core/logger.js';

// Ordem: instâncias verificadas primeiro; as demais entram como reserva.
// Uma instância morta só custa um timeout — mas UMA entrada é pouco, porque
// significa uma única cota de rate limit, então mantemos várias.
const DEFAULT_INSTANCES = [
  'https://co.otomir23.me',
  'https://cobaltapi.cjs.nz',
  'https://cobalt-api.meowing.de',
  'https://cobalt-backend.canine.tools',
  'https://capi.3kh0.net'
];

const pool = new KeyPool(
  'cobalt',
  ENV.cobaltInstances.length ? ENV.cobaltInstances : DEFAULT_INSTANCES,
  { cooldownMs: 5 * 60_000 }
);

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
 * Baixa qualquer URL suportada pelo Cobalt.
 * @returns {{platform:string,title:string,kind:string,media:Array,audioOnly:?Object}}
 */
export async function cobaltDownload(url, quality = 'melhor', { audioOnly = false } = {}) {
  const body = audioOnly
    ? { url, downloadMode: 'audio', audioFormat: 'mp3', filenameStyle: 'basic' }
    : { url, videoQuality: QUALITY_MAP[quality] || 'max', filenameStyle: 'basic' };

  const data = await pool.run(
    async (instance) => {
      const res = await postJson(`${instance.replace(/\/$/, '')}/`, body, {
        headers: {
          accept: 'application/json',
          ...(process.env.COBALT_API_KEY ? { Authorization: `Api-Key ${process.env.COBALT_API_KEY}` } : {})
        },
        timeoutMs: 60_000
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
        const kind = byName !== 'unknown' ? byName : kindFromUrl(res.url);
        const title = String(res.filename || '').replace(/\.[^.]+$/, '');
        const type = kind === 'image' ? 'image' : kind === 'audio' ? 'audio' : 'video';
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

  // Baixa os buffers já no formato esperado pelo sendDownload
  const buffers = [];
  for (const item of (data.media || []).slice(0, 10)) {
    log.dl(`cobalt: baixando ${String(item.url).slice(0, 60)}…`);
    buffers.push(await fetchBuffer(item.url, { timeoutMs: 180_000, maxBytes: 200 * 1024 * 1024 }));
  }
  let audioBuffer = null;
  if (data.audioOnly?.url && data.kind !== 'audio') {
    try {
      audioBuffer = await fetchBuffer(data.audioOnly.url, { timeoutMs: 120_000 });
    } catch { /* o áudio é bônus */ }
  }
  return { ...data, buffers, audioBuffer };
}

export function cobaltPool() {
  return pool;
}
