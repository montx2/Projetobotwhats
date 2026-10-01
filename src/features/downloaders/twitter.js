// 𝕏 / Twitter — extração:
//   1) vxtwitter (api.vxtwitter.com) — API aberta, sem chave nem login,
//      devolve `media_extended` com todos os anexos (vídeo, GIF e fotos) na
//      ordem em que o tweet mostra. É o que os bots reais usam.
//   2) Cobalt (túnel).
//   3) fxtwitter (api.fxtwitter.com) — espelho da mesma ideia.

import { httpGet } from '../../core/http.js';
import { log } from '../../core/logger.js';
import { cobaltDownload } from './cobalt.js';

export function isTwitterUrl(url) {
  return /(twitter\.com|x\.com|nitter\.[a-z.]+)/i.test(url);
}

export function parseTweet(url) {
  const m = String(url).match(/(?:twitter|x)\.com\/(?:i\/web\/status\/)?([^/]+)\/status(?:es)?\/(\d+)/i);
  return m ? { username: m[1], tweetId: m[2] } : null;
}

function baseResult(extra = {}) {
  return {
    platform: 'X (Twitter)',
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

function fromApi(data, parsed, url) {
  const items = Array.isArray(data.media_extended) ? data.media_extended : data.media || [];
  if (!items.length) return null;

  const isVideo = (m) => m.type === 'video' || m.type === 'gif';
  const media = items
    .filter((m) => isVideo(m) || m.type === 'image')
    .map((m, i) => ({
      type: m.type === 'gif' ? 'gif' : isVideo(m) ? 'video' : 'image',
      url: m.url,
      label: `mídia ${i + 1}`,
      thumb: m.thumbnail_url || ''
    }));
  if (!media.length) return null;

  const videoItem = media.find((m) => m.type === 'video' || m.type === 'gif');
  const photoItems = media.filter((m) => m.type === 'image');

  return baseResult({
    // Um único clipe sozinho não é galeria — é o próprio tweet.
    kind: videoItem ? (videoItem.type === 'gif' ? 'gif' : 'video') : 'image',
    title: String(data.text || `Tweet de @${parsed?.username || ''}`).slice(0, 80).replace(/\s+/g, ' ').trim(),
    author: data.user_name || parsed?.username || '',
    thumbnail: videoItem?.thumb || photoItems[0]?.url || '',
    media: media.length === 1 && videoItem ? [videoItem] : media
  });
}

/**
 * @param {string} url link do tweet (twitter.com ou x.com)
 * @param {'melhor'|'alta'|'media'|'baixa'} quality
 */
export async function downloadTwitter(url, quality = 'melhor') {
  const errors = [];
  const parsed = parseTweet(url);

  if (parsed) {
    for (const host of ['https://api.vxtwitter.com', 'https://api.fxtwitter.com']) {
      try {
        const res = await httpGet(`${host}/${parsed.username}/status/${parsed.tweetId}`, {
          headers: { 'user-agent': 'NexusBot/7.0', accept: 'application/json' },
          timeoutMs: 20_000,
          json: true
        });
        if (res.ok && res.data) {
          const found = fromApi(res.data, parsed, url);
          if (found) return found;
          errors.push(`${host}: sem mídia`);
        }
      } catch (error) {
        errors.push(`${host}: ${String(error.message).slice(0, 60)}`);
      }
    }
  }

  log.dl('twitter: tentando via cobalt…');
  try {
    const { buffers, audioBuffer, ...rest } = await cobaltDownload(url, quality);
    if (buffers?.length) return baseResult({ ...rest, buffers, audioBuffer });
    errors.push('cobalt: sem buffer');
  } catch (error) {
    errors.push(`cobalt: ${String(error.message).slice(0, 60)}`);
  }

  throw new Error(
    `X/Twitter falhou em todas as estratégias: ${errors.join(' | ')}. ` +
      'O tweet pode ser privado, de conta protegida ou não ter mídia baixável.'
  );
}
