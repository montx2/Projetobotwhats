// 👥 Facebook — extração sem login:
//   1) Plugin público de vídeo: https://www.facebook.com/plugins/video.php?href=<url>
//      Foi feito para ser incorporado em sites de terceiros, então entrega o
//      stream (`browser_native_hd_url`, `hd_src`…) de qualquer vídeo público.
//   2) Scraping direto da página de watch/reels (mesmas chaves).
//   3) Cobalt.
//   4) Só para link que nomeia FOTO: og:image (com user-agent de crawler).
//
// Links curtos (fb.watch, /share/, fb.com) precisam ser resolvidos com o
// user-agent do facebookexternalhit — com UA de navegador o FB responde 400.

import { httpGet, CRAWLER_AGENT, resolveRedirect } from '../../core/http.js';
import { log } from '../../core/logger.js';
import { cobaltDownload } from './cobalt.js';
import { metaContent, decodeEntities } from './media.js';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

export function isFacebookUrl(url) {
  return /(facebook\.com|fb\.watch|fb\.com|fb\.me)/i.test(url);
}

export function isFacebookPhotoLink(url) {
  return /facebook\.com\/(?:photo(?:\.php)?\/?\?|[\w.-]+\/photos\/|photo\?fbid=)/i.test(String(url));
}

export function isFacebookStory(url) {
  return /facebook\.com\/stories\//i.test(String(url));
}

function baseResult(extra = {}) {
  return {
    platform: 'Facebook',
    title: '',
    author: 'Facebook',
    duration: 0,
    thumbnail: '',
    kind: 'video',
    media: [],
    audioOnly: null,
    ...extra
  };
}

/** O FB escapa a URL dentro do JSON (%u0025, \/, \u0026…). */
function decodeFacebookString(raw = '') {
  return String(raw)
    .replace(/\\u0025/gi, '%')
    .replace(/\\u002F/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u003D/gi, '=')
    .replace(/\\u003F/gi, '?')
    .replace(/\\u([\dA-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\/g, '');
}

const SOURCE_KEYS = [
  'browser_native_hd_url',
  'playable_url_quality_hd',
  'hd_src_no_ratelimit',
  'hd_src',
  'browser_native_sd_url',
  'playable_url',
  'sd_src_no_ratelimit',
  'sd_src'
];

function parseFacebookHtml(html, originalUrl, quality) {
  if (!html) return null;
  let downloadUrl = '';
  for (const key of SOURCE_KEYS) {
    const m = html.match(new RegExp(`"${key}":"(.*?)"(?:,|\\})`));
    if (m?.[1]) {
      const decoded = decodeFacebookString(m[1]);
      if (decoded.startsWith('http')) {
        downloadUrl = decoded;
        break;
      }
    }
  }
  if (!downloadUrl) return null;

  const ogTitle = metaContent(html, 'og:title');
  const ogDescription = metaContent(html, 'og:description');
  const pageTitle = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '';
  // A página do plugin não tem og:title e se chama só "Facebook" — isso é pior
  // que o nome genérico, então descarta.
  const cleanPageTitle = /^facebook$/i.test(pageTitle.trim()) ? '' : pageTitle;

  const poster =
    metaContent(html, 'og:image') ||
    decodeEntities(html.match(/https:\/\/[^"'\\\s]+\/t15\.[^"'\\\s]+/)?.[0] || '');

  return baseResult({
    kind: 'video',
    title: (ogTitle || cleanPageTitle || ogDescription || 'Vídeo do Facebook').slice(0, 100).replace(/\s+/g, ' ').trim(),
    thumbnail: poster,
    media: [{ type: 'video', url: downloadUrl, label: quality }]
  });
}

/** Link que nomeia foto: a única superfície aberta é a og:image. */
async function viaPhoto(resolvedUrl, originalUrl) {
  if (!isFacebookPhotoLink(originalUrl) && !isFacebookPhotoLink(resolvedUrl)) return null;
  const res = await httpGet(resolvedUrl, {
    headers: { 'user-agent': CRAWLER_AGENT, accept: 'text/html' },
    timeoutMs: 20_000
  });
  const image = metaContent(res.text, 'og:image');
  if (!image) return null;
  return baseResult({
    kind: 'image',
    title: (metaContent(res.text, 'og:title') || 'Foto do Facebook').slice(0, 100),
    thumbnail: image,
    media: [{ type: 'image', url: image, label: 'foto' }]
  });
}

/**
 * @param {string} url link do Facebook
 * @param {'melhor'|'alta'|'media'|'baixa'} quality
 */
export async function downloadFacebook(url, quality = 'melhor') {
  if (isFacebookStory(url)) {
    throw new Error('Story do Facebook: o FB só serve stories para contas logadas — não dá para baixar por aqui.');
  }

  const errors = [];
  // fb.watch e /share/ só redirecionam para o user-agent de link crawler.
  const resolved = await resolveRedirect(url, {
    headers: { 'user-agent': CRAWLER_AGENT }
  }).catch(() => url);

  // 1) Plugin público
  try {
    const res = await httpGet(
      `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(resolved)}`,
      {
        headers: {
          'user-agent': BROWSER_UA,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'en-US,en;q=0.9',
          'sec-fetch-dest': 'document',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-site': 'none'
        },
        timeoutMs: 25_000
      }
    );
    const found = parseFacebookHtml(res.text, url, quality);
    if (found) return found;
    errors.push('plugin: sem stream');
  } catch (error) {
    errors.push(`plugin: ${String(error.message).slice(0, 60)}`);
  }

  // 2) Página direta
  try {
    const res = await httpGet(resolved, {
      headers: {
        'user-agent': BROWSER_UA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'none',
        'upgrade-insecure-requests': '1'
      },
      timeoutMs: 25_000
    });
    const found = parseFacebookHtml(res.text, url, quality);
    if (found) return found;
    errors.push('scraping: sem stream');
  } catch (error) {
    errors.push(`scraping: ${String(error.message).slice(0, 60)}`);
  }

  // 3) Cobalt
  log.dl('facebook: tentando via cobalt…');
  try {
    const { buffers, audioBuffer, ...rest } = await cobaltDownload(resolved, quality);
    if (buffers?.length) return baseResult({ ...rest, buffers, audioBuffer });
    errors.push('cobalt: sem buffer');
  } catch (error) {
    errors.push(`cobalt: ${String(error.message).slice(0, 60)}`);
  }

  // 4) Foto (por último: toda página publica og:image, então rodar antes
  //    responderia um vídeo privado com a própria capa).
  try {
    const photo = await viaPhoto(resolved, url);
    if (photo) return photo;
  } catch (error) {
    errors.push(`foto: ${String(error.message).slice(0, 60)}`);
  }

  throw new Error(`Facebook falhou em todas as estratégias: ${errors.join(' | ')}`);
}
