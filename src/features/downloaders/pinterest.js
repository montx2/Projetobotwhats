// 📌 Pinterest — extração em cascata:
//   1) Widget API pública (a mesma que o script de incorporação chama):
//      https://widgets.pinterest.com/v3/pidgets/pins/info/?pin_ids=<id>
//      → responde o pin como JSON, com todas as rendições de vídeo e imagem.
//      É o método que os bots reais usam hoje: a página do pin é 1 MB de
//      markup renderizado por JS e não tem a mídia dentro.
//   2) Payload SSR `__PWS_DATA__` da página do pin (quando a API falha).
//   3) savepin.app (scrape) — reserva comunitária.
//   4) Cobalt.
//
// Aceita links curtos pin.it (resolvidos antes de tudo).

import { httpGet, resolveRedirect, fetchJson } from '../../core/http.js';
import { log } from '../../core/logger.js';
import { cobaltDownload } from './cobalt.js';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

export function isPinterestUrl(url) {
  return /(pinterest\.[a-z.]+|pin\.it)/i.test(url);
}

export function extractPinId(url) {
  return String(url).match(/\/pin\/(?:[\w-]+\/)?(\d+)/i)?.[1] || String(url).match(/pin\.it\/([\w-]+)/i)?.[1] || null;
}

function baseResult(extra = {}) {
  return {
    platform: 'Pinterest',
    title: '',
    author: '',
    duration: 0,
    thumbnail: '',
    kind: 'image',
    media: [],
    audioOnly: null,
    ...extra
  };
}

/** Maior rendição que seja ARQUIVO (ignora manifestos m3u8/mpd). */
function tallestFile(list) {
  const files = Object.values(list || {}).filter(
    (r) => r?.url && !/\.(m3u8|mpd)(\?|$)/i.test(r.url)
  );
  if (!files.length) return null;
  return files.sort((a, b) => (a.height || 0) - (b.height || 0)).pop();
}

/** Ideia-pin guarda um vídeo por bloco de página; vídeo-pin guarda em `videos`. */
function bestVideo(pin) {
  const direct = tallestFile(pin.videos?.video_list);
  if (direct) return direct;
  for (const page of pin.story_pin_data?.pages || []) {
    for (const block of page.blocks || []) {
      const fromBlock = tallestFile(block.video?.video_list);
      if (fromBlock) return fromBlock;
    }
  }
  return null;
}

function bestImage(pin) {
  const images = pin.images || {};
  if (images.orig?.url) return images.orig;
  return tallestFile(images);
}

/** 1) Widget API — o caminho principal. */
async function viaWidgetApi(pinId) {
  const res = await httpGet(`https://widgets.pinterest.com/v3/pidgets/pins/info/?pin_ids=${pinId}`, {
    headers: { 'user-agent': BROWSER_UA, accept: 'application/json' },
    timeoutMs: 20_000,
    json: true
  });
  if (!res.ok || !res.data) return null;
  const pin = res.data?.data?.[0] || res.data?.data?.pins?.[0];
  if (!pin) return null;

  const video = bestVideo(pin);
  const image = bestImage(pin);
  if (!video && !image) return null;

  return baseResult({
    kind: video ? 'video' : /\.gif(\?|$)/i.test(image.url) ? 'gif' : 'image',
    title: String(pin.grid_title || pin.description || 'Pin do Pinterest').trim().slice(0, 100),
    author: pin.pinner?.username || '',
    thumbnail: image?.url || '',
    media: [
      video
        ? { type: 'video', url: video.url, label: `${video.width || ''}x${video.height || ''}`.trim() }
        : {
            type: /\.gif(\?|$)/i.test(image.url) ? 'gif' : 'image',
            url: image.url,
            label: `${image.width || ''}x${image.height || ''}`.trim()
          }
    ]
  });
}

/** 2) Payload SSR da página do pin. */
async function viaPageScrape(finalUrl) {
  const res = await httpGet(finalUrl, {
    headers: { 'user-agent': BROWSER_UA, accept: 'text/html,application/xhtml+xml' },
    timeoutMs: 25_000
  });
  if (!res.ok || !res.text) return null;
  const html = res.text;

  // __PWS_DATA__ (estado Redux server-side renderizado)
  try {
    const raw = html.match(/<script id="__PWS_DATA__" type="application\/json">(.*?)<\/script>/s)?.[1];
    if (raw) {
      const state = JSON.parse(raw)?.props?.initialReduxState;
      const pins = state?.pins && typeof state.pins === 'object' ? Object.values(state.pins) : [];
      const pin = (state?.pin && (state.pin.images || state.pin.videos) && state.pin) ||
        pins.find((p) => p && (p.images || p.videos));
      if (pin) {
        const video = bestVideo(pin);
        const image = bestImage(pin);
        if (video || image) {
          return baseResult({
            kind: video ? 'video' : /\.gif(\?|$)/i.test(image.url) ? 'gif' : 'image',
            title: String(pin.title || pin.grid_description || pin.description || '').slice(0, 100),
            author: pin.pinner?.username || '',
            thumbnail: image?.url || '',
            media: [video ? { type: 'video', url: video.url } : { type: 'image', url: image.url }]
          });
        }
      }
    }
  } catch { /* segue para as tags og */ }

  const ogVideo = html.match(/property="og:video(?::url)?"\s+content="([^"]+)"/)?.[1];
  if (ogVideo) return baseResult({ kind: 'video', media: [{ type: 'video', url: ogVideo }], thumbnail: ogVideo });

  const ogImage = html.match(/property="og:image"\s+content="([^"]+)"/)?.[1];
  if (ogImage) {
    const url = ogImage.replace(/\/\d+x\d*\//, '/originals/');
    return baseResult({ kind: 'image', thumbnail: url, media: [{ type: 'image', url }] });
  }

  const vids = [...html.matchAll(/https:\/\/v1\.pinimg\.com\/videos\/[^"\\\s]+\.mp4/g)].map((m) => m[0]);
  if (vids.length) {
    return baseResult({ kind: 'video', media: [{ type: 'video', url: vids.sort((a, b) => b.length - a.length)[0] }] });
  }
  const imgs = [...html.matchAll(/https:\/\/i\.pinimg\.com\/originals\/[^"\\\s]+\.(?:jpg|png|gif)/gi)].map((m) => m[0]);
  if (imgs.length) {
    return baseResult({ kind: 'image', thumbnail: imgs[0], media: [{ type: 'image', url: imgs[0] }] });
  }
  return null;
}

/** 3) savepin.app — reserva comunitária. */
async function viaSavePin(finalUrl) {
  const res = await httpGet(
    `https://www.savepin.app/download.php?url=${encodeURIComponent(finalUrl)}&lang=en&type=redirect`,
    {
      headers: {
        'user-agent': BROWSER_UA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        referer: 'https://www.savepin.app/'
      },
      timeoutMs: 30_000
    }
  );
  if (!res.ok || !res.text) return null;
  const html = res.text;

  const videos = [...html.matchAll(/href="([^"]*(?:pinimg\.com|media\.savepin)[^"]*\.(?:mp4)[^"]*)"/gi)]
    .map((m) => m[1].replace(/&amp;/g, '&'));
  if (videos.length) {
    return baseResult({ kind: 'video', media: [{ type: 'video', url: videos[0] }] });
  }
  const images = [...html.matchAll(/href="([^"]*pinimg\.com\/originals\/[^"]*\.(?:jpg|jpeg|png|gif)[^"]*)"/gi)]
    .map((m) => m[1].replace(/&amp;/g, '&'));
  if (images.length) {
    return baseResult({ kind: 'image', thumbnail: images[0], media: [{ type: 'image', url: images[0] }] });
  }
  return null;
}

/**
 * @param {string} url link do Pinterest (aceita pin.it)
 * @param {'melhor'|'alta'|'media'|'baixa'} quality
 */
export async function downloadPinterest(url, quality = 'melhor') {
  const errors = [];
  const finalUrl = await resolveRedirect(url).catch(() => url);
  const pinId = extractPinId(finalUrl) || extractPinId(url);

  if (pinId) {
    try {
      const found = await viaWidgetApi(pinId);
      if (found?.media?.length) return found;
      errors.push('widget api: sem mídia');
    } catch (error) {
      errors.push(`widget api: ${String(error.message).slice(0, 60)}`);
    }
  }

  try {
    const found = await viaPageScrape(finalUrl);
    if (found?.media?.length) return found;
    errors.push('scraping: sem mídia');
  } catch (error) {
    errors.push(`scraping: ${String(error.message).slice(0, 60)}`);
  }

  try {
    const found = await viaSavePin(finalUrl);
    if (found?.media?.length) return found;
  } catch (error) {
    errors.push(`savepin: ${String(error.message).slice(0, 60)}`);
  }

  log.dl('pinterest: tentando via cobalt…');
  try {
    const { buffers, audioBuffer, ...rest } = await cobaltDownload(finalUrl, quality);
    if (buffers?.length) return baseResult({ ...rest, buffers, audioBuffer });
    errors.push('cobalt: sem buffer');
  } catch (error) {
    errors.push(`cobalt: ${String(error.message).slice(0, 60)}`);
  }

  throw new Error(`Pinterest falhou em todas as estratégias: ${errors.join(' | ')}`);
}
