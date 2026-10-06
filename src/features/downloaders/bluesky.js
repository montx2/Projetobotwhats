// 🦋 Bluesky — o atproto é aberto, então dá para extrair sem login nem chave:
//   1) resolve o handle para DID (com.atproto.identity.resolveHandle)
//   2) lê o post (app.bsky.feed.getPostThread) na API pública
//   3) fotos vêm em `fullsize`; vídeo vem como playlist HLS, que o motor de
//      `hls.js` baixa e remuxa — mesmo caminho do Twitch/Streamable.
//
// Link de imagem direta (`cdn.bsky.app/img/…`) também é aceito: vira mídia
// única em vez de passar pelo scraping genérico.

import { fetchJson, httpGet } from '../../core/http.js';
import { log } from '../../core/logger.js';

const PUBLIC_API = 'https://public.api.bsky.app/xrpc';
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

export function isBlueskyUrl(url) {
  return /(bsky\.app|bsky\.social|cdn\.bsky\.app|staging\.bsky\.app)/i.test(String(url));
}

/** `@handle.bsky.social/post/3kabc…` → { handle, rkey } (aceita DID no lugar do handle). */
export function parseBlueskyUrl(url) {
  const match = String(url).match(
    /(?:bsky\.app|bsky\.social)\/profile\/([^/?#]+)\/post\/([^/?#]+)/i
  );
  if (!match) return null;
  return { handle: decodeURIComponent(match[1]), rkey: match[2] };
}

export function isBlueskyImageUrl(url) {
  return /cdn\.bsky\.app\/img\//i.test(String(url));
}

function base(extra = {}) {
  return {
    platform: 'Bluesky',
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

/** `did:plc:xxx` já é DID; qualquer outra coisa é handle e precisa resolver. */
async function toDid(handle) {
  if (/^did:/i.test(handle)) return handle;
  const json = await fetchJson(
    `${PUBLIC_API}/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`,
    { headers: { accept: 'application/json' }, timeoutMs: 15_000 }
  );
  return json?.did || null;
}

/** Separa o embed em itens de mídia, cobrindo os 4 formatos do Bluesky. */
function mediaFromEmbed(embed, out = []) {
  if (!embed) return out;
  const type = String(embed.$type || '');

  if (type.includes('embed.images') && Array.isArray(embed.images)) {
    embed.images.forEach((image, i) => {
      const url = image?.fullsize || image?.thumb;
      if (url) out.push({ type: 'image', url, label: `foto ${i + 1}`, thumb: image?.thumb || '' });
    });
    return out;
  }

  if (type.includes('embed.video') && embed.playlist) {
    out.push({
      type: 'video',
      url: embed.playlist,
      label: 'vídeo',
      thumb: embed.thumbnail || ''
    });
    return out;
  }

  if (embed.media) mediaFromEmbed(embed.media, out);
  if (embed.record?.record?.embed) mediaFromEmbed(embed.record.record.embed, out);
  if (Array.isArray(embed.embeds)) embed.embeds.forEach((item) => mediaFromEmbed(item, out));
  return out;
}

/** Capa do post: thumbnail do vídeo, thumb da 1ª foto ou imagem única. */
function thumbnailOf(embed, media) {
  const video = media.find((m) => m.type === 'video');
  if (video?.thumb) return video.thumb;
  const image = media.find((m) => m.type === 'image');
  return image?.thumb || image?.url || '';
}

/**
 * @param {string} url link do post no Bluesky (bsky.app/profile/<handle>/post/<rkey>)
 */
export async function downloadBluesky(url, quality = 'melhor', { maxBytes } = {}) {
  // Imagem servida direto pelo CDN: não há post para consultar.
  if (isBlueskyImageUrl(url)) {
    return base({
      kind: 'image',
      title: 'Imagem do Bluesky',
      media: [{ type: 'image', url, label: 'imagem' }]
    });
  }

  const parsed = parseBlueskyUrl(url);
  if (!parsed) throw new Error('link do Bluesky não reconhecido — use bsky.app/profile/<usuário>/post/<id>');

  const did = await toDid(parsed.handle);
  if (!did) throw new Error('não consegui resolver o perfil do Bluesky');

  const uri = `at://${did}/app.bsky.feed.post/${parsed.rkey}`;
  const json = await fetchJson(
    `${PUBLIC_API}/app.bsky.feed.getPostThread?uri=${encodeURIComponent(uri)}&depth=0`,
    { headers: { accept: 'application/json' }, timeoutMs: 20_000 }
  );

  const post = json?.thread?.post;
  if (!post) {
    // Post removido/privado: ainda vale tentar o embed público da página.
    const fallback = await viaPageEmbed(url).catch(() => null);
    if (fallback?.media?.length) return fallback;
    throw new Error('post não encontrado ou indisponível');
  }

  const media = mediaFromEmbed(post.embed);
  if (!media.length) throw new Error('este post do Bluesky não tem foto nem vídeo');

  const record = post.record || {};
  const text = String(record.text || '').replace(/\s+/g, ' ').trim();
  const author = post.author?.handle || parsed.handle;
  const video = media.some((m) => m.type === 'video');

  log.dl(`bluesky: ${media.length} item(ns) em @${author}`);

  return base({
    kind: video ? 'video' : media.length > 1 ? 'slideshow' : 'image',
    title: text.slice(0, 120) || `Post de @${author}`,
    author: `@${author}`,
    thumbnail: thumbnailOf(post.embed, media),
    media
  });
}

/** Reserva: a página `/post/…` publica `og:image` e às vezes `og:video`. */
async function viaPageEmbed(url) {
  const res = await httpGet(url, {
    headers: { 'user-agent': BROWSER_UA, accept: 'text/html,application/xhtml+xml' },
    timeoutMs: 20_000
  });
  if (!res.ok || !res.text) return null;
  const html = res.text;
  const video = html.match(/property="og:video(?::url|:secure_url)?"\s+content="([^"]+)"/i)?.[1];
  const image = html.match(/property="og:image"\s+content="([^"]+)"/i)?.[1];
  const title = html.match(/property="og:title"\s+content="([^"]+)"/i)?.[1] || '';
  if (!video && !image) return null;
  return base({
    kind: video ? 'video' : 'image',
    title: title.slice(0, 120),
    thumbnail: image || '',
    media: [video ? { type: 'video', url: video, label: 'embed' } : { type: 'image', url: image, label: 'embed' }]
  });
}
