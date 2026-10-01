// 📸 Instagram — extração em cascata testada contra bots reais em produção.
//
//   1) Página de incorporação: https://www.instagram.com/p/<code>/embed/captioned/
//      Responde SEM login para posts públicos e carrega o `shortcode_media`
//      completo (foto, reels e carrossel) dentro de `"contextJSON":"…"`.
//      O valor é JSON-dentro-de-JSON: dois JSON.parse decodificam tudo.
//      Os headers Sec-Fetch-* são obrigatórios — sem eles o IG responde 403.
//   2) Visão de crawler: https://www.instagram.com/reel/<code>/ pedida com o
//      user-agent do facebookexternalhit. É a única superfície que entrega os
//      reels que a incorporação não entrega (ela marca is_video:true mas vem
//      SEM video_url — só a capa, e devolver a capa como se fosse o post é o
//      bug clássico de "pedi um reels e veio uma foto").
//   3) Cobalt: túnel comunitário, funciona de qualquer IP.
//
// Regra de ouro: um link /reel/ NUNCA é carrossel de fotos. Uma única imagem
// para um link que promete vídeo é sempre a capa — nunca é a resposta.

import { httpGet, CRAWLER_AGENT, resolveRedirect } from '../../core/http.js';
import { log } from '../../core/logger.js';
import { cobaltDownload } from './cobalt.js';
import { extractBalancedJson, stringAfterKey, decodeEntities, metaContent, probeStream } from './media.js';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const IG_SHORTCODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function isInstagramUrl(url) {
  return /instagram\.com|instagr\.am/i.test(url);
}

export function instagramShortcode(url) {
  return (
    String(url).match(/instagram\.com\/(?:p|reel|reels|tv|share|reels\/videos)\/([\w-]+)/i)?.[1] ||
    String(url).match(/instagr\.am\/p\/([\w-]+)/i)?.[1] ||
    null
  );
}

/** Shortcode é base64 do id numérico — conversão pura, sem request. */
export function instagramMediaId(shortcode) {
  if (!shortcode) return null;
  const base = BigInt(64);
  let id = BigInt(0);
  for (const char of shortcode) {
    const value = IG_SHORTCODE_ALPHABET.indexOf(char);
    if (value === -1) return null;
    id = id * base + BigInt(value);
  }
  return id.toString();
}

/** Só as rotas de vídeo: uma foto nunca é servida sob /reel/ ou /tv/. */
export function instagramLinkIsVideo(url) {
  return /instagram\.com\/(?:[\w.-]+\/)?(?:reel|reels|tv)\//i.test(String(url));
}

function baseResult(extra = {}) {
  return {
    platform: 'Instagram',
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

/** O `data-media-type` que a página carimba (GraphImage/GraphVideo/GraphSidecar). */
function embedMediaType(html) {
  return html.match(/data-media-type="([^"]+)"/)?.[1] || '';
}

/** Lê o `contextJSON` (JSON dentro de JSON) e devolve o shortcode_media. */
function extractContextJson(html) {
  const key = '"contextJSON":';
  let searchFrom = 0;
  while (true) {
    const idx = html.indexOf(key, searchFrom);
    if (idx === -1) return null;
    const quoteStart = html.indexOf('"', idx + key.length);
    if (quoteStart === -1) return null;

    let i = quoteStart + 1;
    let escaped = false;
    for (; i < html.length; i++) {
      const ch = html[i];
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') break;
    }
    searchFrom = i + 1;

    const token = html.slice(quoteStart, i + 1);
    try {
      const inner = JSON.parse(token); // 1º decode → texto JSON
      const obj = JSON.parse(inner); // 2º decode → objeto
      const media = obj?.gql_data?.shortcode_media || obj?.context?.media;
      if (media) return media;
    } catch {
      // não é o blob de mídia — tenta a próxima ocorrência
    }
  }
}

function extractEmbeddedMedia(html) {
  const fromContext = extractContextJson(html);
  if (fromContext) return fromContext;

  const key = '"shortcode_media":';
  const keyIdx = html.indexOf(key);
  if (keyIdx !== -1) {
    const braceStart = html.indexOf('{', keyIdx + key.length);
    if (braceStart !== -1) {
      const json = extractBalancedJson(html, braceStart);
      if (json) {
        try {
          return JSON.parse(json);
        } catch { /* cai fora */ }
      }
    }
  }
  return null;
}

/** Maior rendição de uma lista do IG (as listas nem sempre vêm maior-primeiro). */
function largest(list) {
  const usable = (list || []).filter((r) => r?.url);
  if (!usable.length) return undefined;
  const area = (r) => (r.width || 0) * (r.height || 0);
  return usable.reduce((best, r) => (area(r) > area(best) ? r : best)).url;
}

/** O IG publica a duração no parâmetro `efg` da URL (base64 JSON). */
function durationFromUrl(videoUrl) {
  if (!videoUrl) return 0;
  try {
    const efg = new URL(videoUrl).searchParams.get('efg');
    if (!efg) return 0;
    const seconds = JSON.parse(Buffer.from(efg, 'base64').toString('utf8'))?.duration_s;
    return typeof seconds === 'number' && seconds > 0 ? Math.round(seconds) : 0;
  } catch {
    return 0;
  }
}

function parseShortcodeMedia(media, shortcode, originalUrl) {
  const username = media.owner?.username || '';
  const caption = media.edge_media_to_caption?.edges?.[0]?.node?.text?.trim() || '';
  const out = baseResult({
    author: username,
    title: caption ? caption.slice(0, 80).replace(/\s+/g, ' ').trim() : `Post de @${username}`,
    thumbnail: media.display_url || media.thumbnail_src || '',
    duration: Math.round(media.video_duration || 0)
  });

  const children = media.edge_sidecar_to_children?.edges;
  if (Array.isArray(children) && children.length) {
    // Carrossel: cada slide, na ordem do post. Vídeo entra como tipo 'video'.
    children.forEach((edge, i) => {
      const node = edge?.node;
      if (!node) return;
      if (node.is_video && node.video_url) {
        out.media.push({ type: 'video', url: node.video_url, label: `vídeo ${i + 1}` });
      } else if (node.display_url) {
        out.media.push({ type: 'image', url: node.display_url, label: `foto ${i + 1}` });
      }
    });
    out.kind = out.media.some((m) => m.type === 'video') ? 'carrossel' : 'slideshow';
    if (!out.thumbnail && out.media[0]) out.thumbnail = out.media[0].url;
    if (!out.duration) out.duration = durationFromUrl(out.media.find((m) => m.type === 'video')?.url);
    return out;
  }

  if (media.is_video && media.video_url) {
    out.kind = 'video';
    out.media = [{ type: 'video', url: media.video_url, label: 'vídeo' }];
    if (!out.duration) out.duration = durationFromUrl(media.video_url);
    return out;
  }

  // Foto (ou vídeo sem URL — este último NÃO é foto, é capa: devolve vazio
  // para o chamador cair no extrator seguinte em vez de entregar a capa).
  if (!media.is_video && media.display_url) {
    out.kind = 'image';
    out.media = [{ type: 'image', url: media.display_url, label: 'foto' }];
    return out;
  }
  return null;
}

/** 1) Página de incorporação — rápida, sem login. */
async function viaEmbed(shortcode, originalUrl) {
  const res = await httpGet(`https://www.instagram.com/p/${shortcode}/embed/captioned/`, {
    headers: {
      'user-agent': BROWSER_UA,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'none'
    },
    timeoutMs: 25_000
  });
  if (!res.ok || !res.text) return { data: null, isVideo: false };

  const declared = embedMediaType(res.text);
  const isVideo = declared === 'GraphVideo';

  const media = extractEmbeddedMedia(res.text);
  if (media) {
    const parsed = parseShortcodeMedia(media, shortcode, originalUrl);
    const containsVideo =
      media.is_video ||
      (Array.isArray(media.edge_sidecar_to_children?.edges) &&
        media.edge_sidecar_to_children.edges.some((e) => e?.node?.is_video));

    // O embed marca reels como is_video:true mas NÃO manda video_url (o vídeo
    // carrega por JS). Devolver vazio aqui faz o chamador tentar a visão de
    // crawler, que é quem tem o MP4 de verdade.
    if (containsVideo && parsed && !parsed.media.some((m) => m.type === 'video')) {
      return { data: null, isVideo: true };
    }
    if (parsed?.media?.length) return { data: parsed, isVideo: isVideo || containsVideo };
  }
  return { data: null, isVideo };
}

/** 2) Visão de crawler — é quem entrega o reel de verdade. */
async function viaCrawlerView(shortcode, originalUrl) {
  const mediaId = instagramMediaId(shortcode);
  if (!mediaId) return null;

  const res = await httpGet(`https://www.instagram.com/reel/${shortcode}/`, {
    headers: {
      'user-agent': CRAWLER_AGENT,
      accept: 'text/html,application/xhtml+xml'
    },
    timeoutMs: 25_000
  });
  if (!res.ok || !res.text) return null;

  const html = res.text;
  const anchor = html.indexOf(`"pk":"${mediaId}"`);
  if (anchor === -1) return null;

  const videoUrl = stringAfterKey(html, 'video_versions', anchor, 80_000);
  const poster = stringAfterKey(html, 'image_versions2', anchor, 80_000);
  if (!videoUrl && !poster) return null;

  const ogTitle = decodeEntities(metaContent(html, 'og:title'));
  const author = ogTitle.match(/^(.+?) on Instagram/)?.[1]?.trim() || '';

  return baseResult({
    kind: videoUrl ? 'video' : 'image',
    title: (ogTitle.match(/on Instagram:\s*"([\s\S]*)"\s*$/)?.[1] || ogTitle || `Post de @${author}`)
      .slice(0, 80)
      .replace(/\s+/g, ' ')
      .trim(),
    author,
    duration: durationFromUrl(videoUrl),
    thumbnail: poster,
    media: videoUrl
      ? [{ type: 'video', url: videoUrl, label: 'reels' }]
      : [{ type: 'image', url: poster, label: 'foto' }]
  });
}

/**
 * @param {string} url link do Instagram
 * @param {'melhor'|'alta'|'media'|'baixa'} quality
 */
export async function downloadInstagram(url, quality = 'melhor') {
  const errors = [];
  let resolved = url;
  if (/\/share\/|instagr\.am/i.test(url)) {
    resolved = await resolveRedirect(url, { headers: { 'user-agent': CRAWLER_AGENT } }).catch(() => url);
  }
  const shortcode = instagramShortcode(resolved) || instagramShortcode(url);
  const expectsVideo = instagramLinkIsVideo(url) || instagramLinkIsVideo(resolved);

  // 1) Incorporação
  if (shortcode) {
    try {
      const { data } = await viaEmbed(shortcode, url);
      if (data?.media?.length) {
        if (!expectsVideo || data.media.some((m) => m.type === 'video')) return data;
        errors.push('embed: só capa');
      } else {
        errors.push('embed: sem mídia');
      }
    } catch (error) {
      errors.push(`embed: ${String(error.message).slice(0, 60)}`);
    }

    // 2) Visão de crawler
    try {
      const found = await viaCrawlerView(shortcode, url);
      if (found?.media?.length) {
        const video = found.media.find((m) => m.type === 'video');
        if (video) {
          const probe = await probeStream(video.url, { expect: 'video', timeoutMs: 10_000 });
          if (probe.verdict !== 'wrong-type') return found;
          errors.push('crawler: não é vídeo');
        } else if (!expectsVideo) {
          return found;
        }
      } else {
        errors.push('crawler: sem mídia');
      }
    } catch (error) {
      errors.push(`crawler: ${String(error.message).slice(0, 60)}`);
    }
  }

  // 3) Cobalt
  log.dl('instagram: tentando via cobalt…');
  try {
    const { buffers, audioBuffer, ...rest } = await cobaltDownload(resolved, quality);
    if (buffers?.length) {
      return baseResult({ ...rest, buffers, audioBuffer, platform: 'Instagram' });
    }
    errors.push('cobalt: sem buffer');
  } catch (error) {
    errors.push(`cobalt: ${String(error.message).slice(0, 60)}`);
  }

  throw new Error(
    `Instagram falhou em todas as estratégias: ${errors.join(' | ')}. ` +
      'O post pode ser privado, restrito ou ter sido removido.'
  );
}
