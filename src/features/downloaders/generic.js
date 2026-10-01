// 🌍 Extratores genéricos para plataformas sem downloader dedicado.
// Todos lêem a superfície que o próprio site publica para quem incorpora
// (embed) — é aberta de um jeito que a shell do app nunca é.
//
//   Threads → /embed com user-agent de crawler (a página normal é só JS)
//   Reddit  → embed.reddit.com, atributo `packaged-media-json` (MP4 já muxado;
//             as rendições v.redd.it são DASH e precisariam de ffmpeg)
//   Twitch  → clipe via GQL público (VOD é HLS — não dá para salvar sem muxar)
//   Vimeo   → player.vimeo.com/video/<id>/config (rendições progressivas)
//   Genérico→ og:video / og:image do próprio link

import { httpGet, postJson, CRAWLER_AGENT } from '../../core/http.js';
import { cobaltDownload } from './cobalt.js';
import { metaContent, decodeEntities, kindByExtension } from './media.js';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

export function isThreadsUrl(url) {
  return /threads\.(net|com)/i.test(url);
}
export function isRedditUrl(url) {
  return /(reddit\.com|redd\.it|v\.redd\.it)/i.test(url);
}
export function isTwitchUrl(url) {
  return /twitch\.tv/i.test(url);
}
export function isVimeoUrl(url) {
  return /vimeo\.com/i.test(url);
}

function base(platform, extra = {}) {
  return {
    platform,
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

/* ────────────────────────────── Threads ────────────────────────────── */
export async function downloadThreads(url) {
  const embedUrl = `${String(url).split(/[?#]/)[0].replace(/\/$/, '')}/embed`;
  const res = await httpGet(embedUrl, {
    headers: { 'user-agent': CRAWLER_AGENT, accept: 'text/html,application/xhtml+xml' },
    timeoutMs: 20_000
  });
  if (!res.ok || !res.text) return null;

  const html = res.text;
  const video =
    decodeEntities(html.match(/property="og:video(?::url)?"\s+content="([^"]+)"/)?.[1] || '') ||
    html.match(/<video[^>]+src="([^"]+)"/)?.[1] ||
    [...html.matchAll(/"(?:video_url|url)":"(https:[^"]+?\.mp4[^"]*?)"/g)][0]?.[1]?.replace(/\\u0026/g, '&');

  if (!video) return null;
  const author = String(url).match(/threads\.(?:net|com)\/@([\w.]+)/)?.[1] || 'threads';
  return base('Threads', {
    kind: 'video',
    author,
    title: decodeEntities(metaContent(html, 'og:title')) || `Post de @${author}`,
    thumbnail: metaContent(html, 'og:image'),
    media: [{ type: 'video', url: video, label: 'embed' }]
  });
}

/* ─────────────────────────────── Reddit ─────────────────────────────── */
function packagedJson(html) {
  const marker = 'packaged-media-json="';
  const start = html.indexOf(marker);
  if (start === -1) return null;
  const end = html.indexOf('"', start + marker.length);
  if (end === -1) return null;
  try {
    return JSON.parse(decodeEntities(html.slice(start + marker.length, end)))?.playbackMp4s ?? null;
  } catch {
    return null;
  }
}

export async function downloadReddit(url) {
  const isPermalink = /reddit\.com\/(?:r|user|u)\/[\w.-]+\/comments\//i.test(String(url));
  if (!isPermalink) return null;
  const path = String(url).match(/reddit\.com\/((?:r|user|u)\/[\w.-]+\/comments\/[\w]+)/i)?.[1];
  if (!path) return null;

  const res = await httpGet(`https://embed.reddit.com/${path}/`, {
    headers: {
      'user-agent': BROWSER_UA,
      accept: 'text/html,application/xhtml+xml',
      referer: 'https://www.reddit.com/'
    },
    timeoutMs: 25_000
  });
  if (!res.ok || !res.text) return null;

  const data = packagedJson(res.text);
  const mp4s = (data?.permutations || [])
    .map((p) => ({ url: decodeEntities(p?.source?.url || ''), height: p?.source?.dimensions?.height || 0 }))
    .filter((r) => r.url)
    .sort((a, b) => a.height - b.height);
  if (!mp4s.length) return null;

  const slug = String(url).match(/comments\/[\w]+\/([\w_]+)/)?.[1] || '';
  const subreddit = String(url).match(/\/r\/([\w.-]+)/)?.[1] || 'reddit';
  return base('Reddit', {
    kind: 'video',
    title: slug ? slug.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : 'Vídeo do Reddit',
    author: `r/${subreddit}`,
    duration: Math.round(data?.duration || 0),
    thumbnail: decodeEntities(
      res.text.match(/https:\/\/(?:preview|external-preview)\.redd\.it\/[^"'\s\\]+/)?.[0] || ''
    ),
    media: [{ type: 'video', url: mp4s[mp4s.length - 1].url, label: `${mp4s[mp4s.length - 1].height}p` }]
  });
}

/* ─────────────────────────────── Twitch ─────────────────────────────── */
export function parseTwitchClipSlug(url) {
  return (
    String(url).match(/clips\.twitch\.tv\/([\w-]+)/)?.[1] ||
    String(url).match(/twitch\.tv\/(?:[\w-]+\/)?clip\/([\w-]+)/)?.[1] ||
    null
  );
}

export async function downloadTwitch(url) {
  const slug = parseTwitchClipSlug(url);
  if (!slug) return null; // VOD/canal é HLS — não dá para salvar sem ffmpeg

  const data = await postJson(
    'https://gql.twitch.tv/gql',
    {
      query: `{ clip(slug: "${slug}") { title durationSeconds thumbnailURL broadcaster { displayName } videoQualities { quality sourceURL } playbackAccessToken(params: {platform:"web", playerBackend:"mediaplayer", playerType:"site"}) { signature value } } }`
    },
    {
      headers: { 'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko' }, // id público do web player
      timeoutMs: 20_000
    }
  );
  const clip = data?.data?.clip;
  const renditions = (clip?.videoQualities || [])
    .filter((q) => q?.sourceURL)
    .sort((a, b) => parseInt(a.quality, 10) - parseInt(b.quality, 10));
  const token = clip?.playbackAccessToken;
  if (!renditions.length || !token?.signature || !token?.value) return null;

  const chosen = renditions[renditions.length - 1];
  // O sourceURL sozinho responde 401: precisa levar a assinatura junto.
  return base('Twitch', {
    kind: 'video',
    title: clip.title || 'Clipe da Twitch',
    author: clip.broadcaster?.displayName || 'Twitch',
    duration: Math.round(clip.durationSeconds || 0),
    thumbnail: clip.thumbnailURL || '',
    media: [
      {
        type: 'video',
        url: `${chosen.sourceURL}?sig=${token.signature}&token=${encodeURIComponent(token.value)}`,
        label: `${chosen.quality}p`
      }
    ]
  });
}

/* ──────────────────────────────── Vimeo ─────────────────────────────── */
export async function downloadVimeo(url) {
  const id = String(url).match(/vimeo\.com\/(?:video\/)?(\d+)/)?.[1];
  if (!id) return null;
  const res = await httpGet(`https://player.vimeo.com/video/${id}/config`, {
    headers: { 'user-agent': BROWSER_UA, referer: 'https://vimeo.com/' },
    timeoutMs: 20_000,
    json: true
  });
  if (!res.ok || !res.data) return null;

  const v0 = res.data.video || {};
  const progressive = (res.data.request?.files?.progressive || []).filter((f) => f?.url);
  if (!progressive.length) return null; // só DASH/HLS: precisa de ffmpeg

  const chosen = progressive.sort((a, b) => (a.height || 0) - (b.height || 0)).pop();
  const thumbs = v0.thumbs || {};
  return base('Vimeo', {
    kind: 'video',
    title: v0.title || 'Vídeo do Vimeo',
    author: v0.owner?.name || 'Vimeo',
    duration: Math.round(v0.duration || 0),
    thumbnail: thumbs.base || thumbs['1280'] || thumbs['960'] || thumbs['640'] || '',
    media: [{ type: 'video', url: chosen.url, label: `${chosen.height || ''}p` }]
  });
}

/* ──────────────── Genérico: og:video / og:image do próprio link ───────── */
export async function downloadByPageScrape(url) {
  const res = await httpGet(url, {
    headers: { 'user-agent': BROWSER_UA, accept: 'text/html,application/xhtml+xml' },
    timeoutMs: 20_000
  });
  if (!res.ok || !res.text) return null;
  const html = res.text;

  const video = metaContent(html, 'og:video') || metaContent(html, 'og:video:url');
  if (video && kindByExtension(video) !== 'image') {
    return base('Web', {
      kind: 'video',
      title: metaContent(html, 'og:title') || '',
      author: metaContent(html, 'og:site_name') || '',
      thumbnail: metaContent(html, 'og:image'),
      media: [{ type: 'video', url: video, label: 'og:video' }]
    });
  }
  const image = metaContent(html, 'og:image');
  if (image) {
    return base('Web', {
      kind: /\.gif(\?|$)/i.test(image) ? 'gif' : 'image',
      title: metaContent(html, 'og:title') || '',
      author: metaContent(html, 'og:site_name') || '',
      thumbnail: image,
      media: [{ type: /\.gif(\?|$)/i.test(image) ? 'gif' : 'image', url: image, label: 'og:image' }]
    });
  }
  return null;
}

/** Roteia para o extrator próprio da plataforma; null se não houver. */
export async function downloadByPlatform(url, platform) {
  switch (platform) {
    case 'Threads':
      return downloadThreads(url);
    case 'Reddit':
      return downloadReddit(url);
    case 'Twitch':
      return downloadTwitch(url);
    case 'Vimeo':
      return downloadVimeo(url);
    default:
      return null;
  }
}

/* ─────────────────── Cauda longa: cobalt → scraping ─────────────────── */
export async function downloadGeneric(url, quality = 'melhor') {
  const own = await downloadByPlatform(url, detectOwnPlatform(url)).catch(() => null);
  if (own?.media?.length) return own;

  try {
    const { buffers, audioBuffer, ...rest } = await cobaltDownload(url, quality);
    if (buffers?.length) return base(rest.platform || 'Web', { ...rest, buffers, audioBuffer });
  } catch { /* segue */ }

  const scraped = await downloadByPageScrape(url).catch(() => null);
  if (scraped?.media?.length) return scraped;

  throw new Error('Não consegui extrair mídia desse link. Ele pode ser privado, estar fora do ar ou não ser suportado.');
}

function detectOwnPlatform(url) {
  if (isThreadsUrl(url)) return 'Threads';
  if (isRedditUrl(url)) return 'Reddit';
  if (isTwitchUrl(url)) return 'Twitch';
  if (isVimeoUrl(url)) return 'Vimeo';
  return null;
}
