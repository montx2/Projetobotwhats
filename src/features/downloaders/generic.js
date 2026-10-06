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

import { httpGet, postJson, resolveRedirect, CRAWLER_AGENT } from '../../core/http.js';
import { cobaltDownload } from './cobalt.js';
import { downloadHls } from './hls.js';
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
/** Imagens que a página do Threads publica (capa do post, sem login). */
export function threadsImages(html) {
  const found = [];
  const push = (raw) => {
    const url = decodeEntities(String(raw || '').replace(/\\u0026/g, '&').replace(/\\\//g, '/'));
    if (!/^https?:\/\//i.test(url)) return;
    if (!/\.(?:jpg|jpeg|png|webp)(\?|$)/i.test(url) && !/scontent/i.test(url)) return;
    if (!found.includes(url)) found.push(url);
  };

  push(metaContent(html, 'og:image'));
  // Cada slide do carrossel aparece como candidato em `image_versions2`; o CDN
  // do Threads responde em scontent/fbcdn. Pega qualquer URL de imagem deles.
  for (const match of html.matchAll(/"url":"(https:\\?\/?\\?\/[^"]*?(?:scontent|cdninstagram|fbcdn)[^"]*?)"/g)) {
    push(match[1]);
  }
  for (const match of html.matchAll(/"url":"(https:\/\/[^"]+?\.(?:jpg|jpeg|png|webp)[^"]*?)"/g)) {
    push(match[1]);
  }
  return found.slice(0, 10);
}

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

  const author = String(url).match(/threads\.(?:net|com)\/@([\w.]+)/)?.[1] || 'threads';
  const title = decodeEntities(metaContent(html, 'og:title')) || `Post de @${author}`;

  if (video) {
    return base('Threads', {
      kind: 'video',
      author,
      title,
      thumbnail: metaContent(html, 'og:image'),
      media: [{ type: 'video', url: video, label: 'embed' }]
    });
  }

  // Post de foto (o Threads também é cheio deles): mesmo embed, sem vídeo.
  const images = threadsImages(html);
  if (!images.length) return null;
  return base('Threads', {
    kind: images.length > 1 ? 'slideshow' : 'image',
    author,
    title,
    thumbnail: images[0],
    media: images.map((imageUrl, i) => ({ type: 'image', url: imageUrl, label: `foto ${i + 1}` }))
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

/** Fotos do post: i.redd.it tem resolução cheia; preview.redd.it, a reduzida. */
export function redditImages(html) {
  const found = [];
  const push = (raw) => {
    let url = decodeEntities(String(raw || '').replace(/\\u0026/g, '&').replace(/\\\//g, '/'));
    if (!/^https?:\/\/[^"'\s]*redd\.it\//i.test(url)) return;
    if (!/\.(?:jpg|jpeg|png|webp|gif)(\?|$)/i.test(url)) return;
    // `preview` publica a mesma foto redimensionada: sem os parâmetros de
    // tamanho, ele entrega a original — vale mais que a miniatura.
    if (/preview\.redd\.it/i.test(url)) url = url.split('?')[0];
    if (!found.includes(url)) found.push(url);
  };

  push(metaContent(html, 'og:image'));
  // Uma varredura só mantém a ORDEM em que as imagens aparecem na página — é o
  // mais próximo da ordem do carrossel original que o embed entrega.
  for (const match of html.matchAll(
    /https:\/\/(?:i|preview)\.redd\.it\/[\w-]+\.(?:jpg|jpeg|png|webp|gif)(?:\?[^"'\s\\]*)?/gi
  )) {
    push(match[0]);
  }
  return found.slice(0, 20);
}

export async function downloadReddit(url) {
  // Link direto de imagem/animação do CDN: nem precisa da página.
  const direct = String(url).match(/^https?:\/\/i\.redd\.it\/[\w-]+\.(jpg|jpeg|png|webp|gif)$/i);
  if (direct) {
    const imageUrl = String(url);
    const isGif = /\.gif$/i.test(imageUrl);
    return base('Reddit', {
      kind: isGif ? 'gif' : 'image',
      title: 'Imagem do Reddit',
      thumbnail: imageUrl,
      media: [{ type: isGif ? 'gif' : 'image', url: imageUrl, label: isGif ? 'gif' : 'foto' }]
    });
  }

  const isPermalink = /reddit\.com\/(?:r|user|u)\/[\w.-]+\/comments\//i.test(String(url));
  const isGallery = /reddit\.com\/gallery\/[\w-]+/i.test(String(url));
  if (!isPermalink && !isGallery) return null;

  // `/gallery/<id>` é o atalho: resolve para o permalink, que traz r/<sub>/comments/…
  const resolved = isGallery && !isPermalink
    ? await resolveRedirect(url, { headers: { 'user-agent': BROWSER_UA } }).catch(() => url)
    : url;
  const path =
    String(resolved).match(/reddit\.com\/((?:r|user|u)\/[\w.-]+\/comments\/[\w]+)/i)?.[1] ||
    String(url).match(/reddit\.com\/((?:r|user|u)\/[\w.-]+\/comments\/[\w]+)/i)?.[1];
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

  const slug = String(url).match(/comments\/[\w]+\/([\w_]+)/)?.[1] || '';
  const subreddit = String(path).match(/^\w+\/([\w.-]+)\//)?.[1] || String(url).match(/\/r\/([\w.-]+)/)?.[1] || 'reddit';
  const title = slug ? slug.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : 'Post do Reddit';

  const data = packagedJson(res.text);
  const mp4s = (data?.permutations || [])
    .map((p) => ({ url: decodeEntities(p?.source?.url || ''), height: p?.source?.dimensions?.height || 0 }))
    .filter((r) => r.url)
    .sort((a, b) => a.height - b.height);

  if (mp4s.length) {
    return base('Reddit', {
      kind: 'video',
      title: slug ? title : 'Vídeo do Reddit',
      author: `r/${subreddit}`,
      duration: Math.round(data?.duration || 0),
      thumbnail: decodeEntities(
        res.text.match(/https:\/\/(?:preview|external-preview)\.redd\.it\/[^"'\s\\]+/)?.[0] || redditImages(res.text)[0] || ''
      ),
      media: [{ type: 'video', url: mp4s[mp4s.length - 1].url, label: `${mp4s[mp4s.length - 1].height}p` }]
    });
  }

  // Sem MP4: pode ser post de foto ou galeria — o embed traz as imagens.
  const images = redditImages(res.text);
  if (!images.length) return null;
  const animated = images.some((image) => /\.gif/i.test(image));
  return base('Reddit', {
    kind: animated && images.length === 1 ? 'gif' : images.length > 1 ? 'slideshow' : 'image',
    title,
    author: `r/${subreddit}`,
    thumbnail: images[0],
    media: images.map((imageUrl, i) => ({
      type: /\.gif/i.test(imageUrl) ? 'gif' : 'image',
      url: imageUrl,
      label: `imagem ${i + 1}`
    }))
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

/** VOD (`/videos/<id>`) — o mesmo token público do clipe abre o HLS no usher. */
export function parseTwitchVodId(url) {
  return String(url).match(/twitch\.tv\/videos\/(\d+)/)?.[1] || null;
}

async function twitchPlaybackToken(kind, id) {
  const query =
    kind === 'video'
      ? `{ video(id: "${id}") { title durationSeconds thumbnailURL owner { displayName } playbackAccessToken(params: {platform:"web", playerBackend:"mediaplayer", playerType:"site"}) { signature value } } }`
      : `{ clip(slug: "${id}") { title durationSeconds thumbnailURL broadcaster { displayName } videoQualities { quality sourceURL } playbackAccessToken(params: {platform:"web", playerBackend:"mediaplayer", playerType:"site"}) { signature value } } }`;
  const data = await postJson('https://gql.twitch.tv/gql', { query }, {
    headers: { 'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko' }, // id público do web player
    timeoutMs: 20_000
  });
  return kind === 'video' ? data?.data?.video : data?.data?.clip;
}

async function downloadTwitchVod(id, { maxBytes } = {}) {
  const video = await twitchPlaybackToken('video', id);
  const token = video?.playbackAccessToken;
  if (!token?.signature || !token?.value) return null;

  const hlsUrl =
    `https://usher.ttvnw.net/vod/${id}.m3u8?allow_source=true&allow_audio_only=true&player=twitchweb` +
    `&nauth=${encodeURIComponent(token.value)}&nauthsig=${token.signature}&supported_codecs=avc1&type=any`;

  const hls = await downloadHls(hlsUrl, { referer: 'https://www.twitch.tv/', maxBytes });
  return base('Twitch', {
    kind: 'video',
    title: video.title || 'VOD da Twitch',
    author: video.owner?.displayName || 'Twitch',
    duration: Math.round(video.durationSeconds || 0),
    thumbnail: video.thumbnailURL || '',
    buffers: [hls.buffer],
    // VOD longo: o teto de bytes corta o começo — o rodapé da legenda avisa.
    partial: hls.truncated || hls.live,
    media: [{ type: 'video', url: hlsUrl, label: 'vod' }]
  });
}

export async function downloadTwitch(url, { maxBytes } = {}) {
  const vodId = parseTwitchVodId(url);
  if (vodId) return downloadTwitchVod(vodId, { maxBytes });

  const slug = parseTwitchClipSlug(url);
  if (!slug) return null; // link de canal (ao vivo) não é arquivo

  const clip = await twitchPlaybackToken('clip', slug);
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

/* ──────────────── Genérico: a mídia que a própria página publica ───────── */
const VIDEO_FILE = /\.(mp4|webm|mkv|mov|m4v|m3u8)(\?|$)/i;
const IMAGE_FILE = /\.(jpg|jpeg|png|webp|gif|avif)(\?|$)/i;

/** Candidatos a vídeo, do mais explícito (metadados de player) ao mais solto. */
export function pageVideoCandidates(html) {
  const found = [];
  const push = (raw) => {
    const url = decodeEntities(String(raw || '').replace(/\\u0026/g, '&').replace(/\\\//g, '/')).trim();
    if (!/^https?:\/\//i.test(url)) return;
    if (!VIDEO_FILE.test(url) && !/\.m3u8/i.test(url)) return;
    if (/\.html?(\?|$)/i.test(url)) return; // página de embed, não o arquivo
    if (!found.includes(url)) found.push(url);
  };

  // 1) Metadados de player — a superfície mais confiável.
  for (const key of ['og:video:secure_url', 'og:video:url', 'og:video', 'twitter:player:stream']) {
    push(metaContent(html, key));
  }
  // 2) Tag <video> / <source> (muito comum em site de notícia e blog).
  for (const match of html.matchAll(/<(?:video|source)[^>]+src=["']([^"']+)["']/gi)) push(match[1]);
  for (const match of html.matchAll(/<video[^>]+data-src=["']([^"']+)["']/gi)) push(match[1]);
  // 3) JSON-LD `contentUrl` e JSON embutido `"contentUrl"`.
  for (const match of html.matchAll(/"contentUrl":\s*"([^"]+)"/gi)) push(match[1]);
  // 4) Qualquer .mp4/.m3u8 citado na página (último recurso).
  for (const match of html.matchAll(/https?:\/\/[^"'\s<>\\]+?\.(?:mp4|m3u8)(?:\?[^"'\s<>\\]*)?/gi)) push(match[0]);

  return found.slice(0, 8);
}

/** Imagem principal publicada pela página (og/twitter, com reserva no JSON-LD). */
export function pageImageCandidate(html) {
  for (const key of ['og:image:secure_url', 'og:image:url', 'og:image', 'twitter:image', 'twitter:image:src']) {
    const value = metaContent(html, key);
    if (value && IMAGE_FILE.test(value)) return value;
  }
  const jsonLd = html.match(/"image":\s*"([^"]+\.(?:jpg|jpeg|png|webp|gif))"/i)?.[1];
  return jsonLd ? decodeEntities(jsonLd.replace(/\\\//g, '/')) : '';
}

export async function downloadByPageScrape(url) {
  const u = String(url || '');
  if (/youtube\.com|youtu\.be|tiktok\.com|instagram\.com/i.test(u)) {
    return null;
  }
  const res = await httpGet(url, {
    headers: { 'user-agent': BROWSER_UA, accept: 'text/html,application/xhtml+xml' },
    timeoutMs: 20_000
  });
  if (!res.ok || !res.text) return null;
  const html = res.text;

  const title = metaContent(html, 'og:title') || metaContent(html, 'twitter:title') || '';
  const author = metaContent(html, 'og:site_name') || '';
  const video = pageVideoCandidates(html)[0];
  if (video) {
    return base('Web', {
      kind: 'video',
      title,
      author,
      thumbnail: pageImageCandidate(html),
      media: [{ type: 'video', url: video, label: /\.m3u8/i.test(video) ? 'hls' : 'página' }]
    });
  }

  const image = pageImageCandidate(html);
  if (image) {
    // `og:image` de página genérica pode ser o preview/banner do próprio site
    // (gradiente de marca, logo) em vez do post: marcado como não confiável, o
    // motor de figurinha confere o conteúdo antes de usar.
    const isGif = /\.gif(\?|$)/i.test(image);
    return base('Web', {
      kind: isGif ? 'gif' : 'image',
      title,
      author,
      thumbnail: image,
      media: [
        {
          type: isGif ? 'gif' : 'image',
          url: image,
          label: 'og:image',
          trusted: false,
          hint: 'og-image'
        }
      ]
    });
  }
  return null;
}

/** Roteia para o extrator próprio da plataforma; null se não houver. */
export async function downloadByPlatform(url, platform, opts = {}) {
  switch (platform) {
    case 'Threads':
      return downloadThreads(url);
    case 'Reddit':
      return downloadReddit(url);
    case 'Twitch':
      return downloadTwitch(url, opts);
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
