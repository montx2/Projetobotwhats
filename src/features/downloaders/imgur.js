// 🖼️ Imgur — fotos, GIFs animados e MP4 avulsos ou em álbum.
//
//   1) imagem/vídeo direto (`i.imgur.com/<hash>.jpg|png|gif|mp4`) → um item só;
//   2) álbum/capa (`/a/<id>`, `/gallery/<id>`) → endpoint aberto que o próprio
//      site usa (`ajaxalbums/getimages`) devolve hash + tipo de cada imagem;
//   3) plano B: a página publica `og:video` (MP4) e `og:image` para post único.
//
// GIF animado: o Imgur publica a mesma animação em `.gif` e em `.mp4`. O bot
// prefere o MP4 (mesma imagem, uma fração do tamanho) e o envia como GIF.

import { fetchJson, httpGet } from '../../core/http.js';
import { kindByExtension } from './media.js';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

export function isImgurUrl(url) {
  return /(^https?:\/\/)?(i\.|www\.)?imgur\.com\//i.test(String(url));
}

/** Imagem/vídeo servido direto pelo CDN — não precisa consultar nada. */
export function isImgurDirectUrl(url) {
  return /^https?:\/\/i\.imgur\.com\/[\w-]+\.(jpg|jpeg|png|gif|mp4|webm|webp)(\?|$)/i.test(String(url));
}

/** `imgur.com/a/<id>`, `/gallery/<id>`, `/t/<tag>/<id>` ou `/<id>` → { id, album }. */
export function parseImgurUrl(url) {
  const u = String(url).split(/[?#]/)[0].replace(/\/+$/, '');
  const album = u.match(/imgur\.com\/(?:a|gallery)\/([\w-]+)/i);
  if (album) return { id: album[1], album: true };
  const short = u.match(/imgur\.com\/t\/[\w-]+\/([\w-]+)/i);
  if (short) return { id: short[1], album: true };
  const single = u.match(/imgur\.com\/([\w-]+)$/i);
  if (single && !['a', 'gallery', 't', 'user', 'search'].includes(single[1])) {
    return { id: single[1], album: false };
  }
  return null;
}

function base(extra = {}) {
  return {
    platform: 'Imgur',
    title: '',
    author: 'Imgur',
    duration: 0,
    thumbnail: '',
    kind: 'image',
    media: [],
    audioOnly: null,
    ...extra
  };
}

/** Item do álbum/animação → mídia do bot (GIF animado vira MP4). */
function itemToMedia(image, index) {
  const hash = image?.hash || image?.id;
  if (!hash) return null;
  const animated = image?.animated === true || image?.animated === 1;
  const ext = String(image?.ext || image?.extension || '.jpg').toLowerCase();
  if (animated) {
    return {
      type: 'gif',
      url: `https://i.imgur.com/${hash}.mp4`,
      label: `gif ${index + 1}`,
      thumb: `https://i.imgur.com/${hash}h.jpg`
    };
  }
  const clean = ext === '.jpeg' ? '.jpg' : ext;
  return {
    type: 'image',
    url: `https://i.imgur.com/${hash}${clean}`,
    label: `foto ${index + 1}`,
    thumb: `https://i.imgur.com/${hash}b.jpg`
  };
}

/** Endpoint aberto que o próprio site usa para montar álbuns. */
async function viaAlbumEndpoint(id) {
  const json = await fetchJson(`https://imgur.com/ajaxalbums/getimages/${id}/hit.json`, {
    headers: { 'user-agent': BROWSER_UA, accept: 'application/json', referer: `https://imgur.com/a/${id}` },
    timeoutMs: 20_000
  });
  const images = json?.data?.images;
  if (!Array.isArray(images) || !images.length) return null;
  const media = images.map(itemToMedia).filter(Boolean).slice(0, 20);
  if (!media.length) return null;
  const video = media.find((m) => m.type === 'gif');
  return base({
    kind: video ? (media.length > 1 ? 'slideshow' : 'gif') : media.length > 1 ? 'slideshow' : 'image',
    title: json?.data?.title || `Álbum do Imgur`,
    thumbnail: media[0].thumb || media[0].url,
    media
  });
}

/** Página pública: `og:video` (MP4) e `og:image` do post. */
async function viaPage(id, url) {
  const res = await httpGet(`https://imgur.com/${id}`, {
    headers: { 'user-agent': BROWSER_UA, accept: 'text/html,application/xhtml+xml' },
    timeoutMs: 20_000
  });
  if (!res.ok || !res.text) return null;
  const html = res.text;
  const video = html.match(/property="og:video"\s+content="([^"]+\.mp4[^"]*)"/i)?.[1]
    || html.match(/<meta[^>]+content="([^"]+\.mp4[^"]*)"[^>]+property="og:video"/i)?.[1]
    || html.match(/"contentUrl":"([^"]+\.mp4[^"]*)"/i)?.[1]?.replace(/\\\//g, '/');
  const image = html.match(/property="og:image"\s+content="([^"]+)"/i)?.[1]
    || html.match(/"contentUrl":"([^"]+\.(?:jpg|jpeg|png|gif)[^"]*)"/i)?.[1]?.replace(/\\\//g, '/');
  const title = (html.match(/property="og:title"\s+content="([^"]+)"/i)?.[1] || '').trim();
  if (video) {
    return base({
      kind: 'gif',
      title: title || 'Imgur',
      thumbnail: image || '',
      media: [{ type: 'gif', url: video, label: 'gif' }]
    });
  }
  const imageUrl = image || `https://i.imgur.com/${id}.jpg`;
  const isGif = /\.gif(\?|$)/i.test(imageUrl);
  return base({
    kind: isGif ? 'gif' : 'image',
    title: title || 'Imgur',
    thumbnail: imageUrl,
    media: [{ type: isGif ? 'gif' : 'image', url: imageUrl, label: isGif ? 'gif' : 'imagem' }]
  });
}

/**
 * @param {string} url link do Imgur (direto, álbum ou post)
 */
export async function downloadImgur(url, quality = 'melhor', { maxBytes } = {}) {
  if (isImgurDirectUrl(url)) {
    // `.gif` do Imgur pode ser animação: trata como GIF (envio com gifPlayback).
    const kind = /\.gif(\?|$)/i.test(url) ? 'gif' : kindByExtension(url);
    return base({
      kind: kind === 'image' ? 'image' : kind,
      title: 'Imgur',
      thumbnail: kind === 'image' ? url : '',
      media: [{ type: kind === 'gif' ? 'gif' : kind, url, label: kind }]
    });
  }

  const parsed = parseImgurUrl(url);
  if (!parsed) throw new Error('link do Imgur não reconhecido');

  const errors = [];
  if (parsed.album) {
    try {
      const album = await viaAlbumEndpoint(parsed.id);
      if (album) return album;
      errors.push('álbum: endpoint sem imagens');
    } catch (error) {
      errors.push(`álbum: ${String(error.message).slice(0, 60)}`);
    }
  }

  try {
    const page = await viaPage(parsed.id, url);
    if (page) return page;
    errors.push('página: sem og:image/og:video');
  } catch (error) {
    errors.push(`página: ${String(error.message).slice(0, 60)}`);
  }

  throw new Error(`Imgur falhou: ${errors.join(' | ')}`);
}
