// 📺 Dailymotion — o player publica metadados abertos em
// `https://www.dailymotion.com/player/metadata/video/<id>`: título, duração,
// capa e as rendições progressivas em MP4. Sem chave, sem login, sem scraping.
//
// `dai.ly/<id>` é o encurtador oficial e precisa de resolução de redirect.

import { fetchJson, resolveRedirect, fetchText } from '../../core/http.js';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

export function isDailymotionUrl(url) {
  return /(dailymotion\.com|dai\.ly)/i.test(String(url));
}

/** `dai.ly/x8abc` · `/video/x8abc` · `/embed/video/x8abc` → `x8abc`. */
export function dailymotionId(url) {
  const u = String(url);
  return (
    u.match(/dai\.ly\/([a-zA-Z0-9]+)/)?.[1] ||
    u.match(/dailymotion\.com\/(?:embed\/)?video\/([a-zA-Z0-9]+)/)?.[1] ||
    u.match(/dailymotion\.com\/[^/]+\/video\/([a-zA-Z0-9]+)/)?.[1] ||
    null
  );
}

function base(extra = {}) {
  return {
    platform: 'Dailymotion',
    title: '',
    author: '',
    duration: 0,
    thumbnail: '',
    kind: 'video',
    media: [],
    audioOnly: null,
    ...extra
  };
}

/** Lista de MP4 progressivos, do menor para o maior (com altura quando existe). */
export function progressiveRenditions(qualities) {
  const out = [];
  for (const list of Object.values(qualities || {})) {
    for (const item of list || []) {
      if (!item?.url) continue;
      if (!/^video\/mp4/i.test(String(item.type || ''))) continue;
      if (!/\.mp4(\?|$)/i.test(item.url) && !/video\/mp4/i.test(String(item.type))) continue;
      out.push({
        url: item.url,
        height: Number(item.height) || 0,
        width: Number(item.width) || 0,
        // `auto` costuma ser o muxado pronto (com áudio) — desempate a favor dele.
        muxed: true
      });
    }
  }
  const unique = [];
  const seen = new Set();
  for (const item of out) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    unique.push(item);
  }
  return unique.sort((a, b) => a.height - b.height || a.width - b.width);
}

/**
 * @param {string} url link do Dailymotion (dailymotion.com/video/… ou dai.ly/…)
 */
export async function downloadDailymotion(url, quality = 'melhor', { maxBytes } = {}) {
  let resolved = url;
  if (/dai\.ly/i.test(String(url))) {
    resolved = await resolveRedirect(url, { headers: { 'user-agent': BROWSER_UA } }).catch(() => url);
  }
  const id = dailymotionId(resolved) || dailymotionId(url);
  if (!id) throw new Error('não encontrei o ID do vídeo do Dailymotion neste link');

  const json = await fetchJson(`https://www.dailymotion.com/player/metadata/video/${id}`, {
    headers: { 'user-agent': BROWSER_UA, referer: 'https://www.dailymotion.com/', accept: 'application/json' },
    timeoutMs: 25_000
  });

  const renditions = progressiveRenditions(json?.qualities);
  if (!renditions.length) throw new Error('Dailymotion não publicou rendição progressiva (só HLS/DASH)');

  const chosen =
    quality === 'baixa'
      ? renditions[0]
      : quality === 'media'
        ? renditions[Math.floor((renditions.length - 1) / 2)]
        : renditions[renditions.length - 1];

  return base({
    title: json?.title || 'Vídeo do Dailymotion',
    author: json?.owner?.screenname || json?.owner?.username || 'Dailymotion',
    duration: Math.round(Number(json?.duration) || 0),
    thumbnail: json?.poster || json?.thumbnail_url || '',
    media: [
      {
        type: 'video',
        url: chosen.url,
        label: chosen.height ? `${chosen.height}p` : 'mp4',
        quality: chosen.height ? undefined : quality
      }
    ]
  });
}

/** O embed público também entrega `og:video` — usado como plano B. */
export async function dailymotionEmbedFallback(url) {
  const id = dailymotionId(url);
  if (!id) return null;
  const res = await fetchText(`https://www.dailymotion.com/embed/video/${id}`, {
    headers: { 'user-agent': BROWSER_UA },
    timeoutMs: 20_000,
    maxBytes: 2 * 1024 * 1024
  }).catch(() => '');
  if (!res) return null;
  const video = res.match(/"url":"(https:\/\/[^"]+\.mp4[^"]*)"/)?.[1]?.replace(/\\\//g, '/');
  if (!video) return null;
  return base({ media: [{ type: 'video', url: video, label: 'embed' }] });
}
