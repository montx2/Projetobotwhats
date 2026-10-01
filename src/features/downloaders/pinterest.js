// 📌 Pinterest — extração em cascata, agora com uma regra dura:
// **só mídia do PIN PEDIDO**. Nunca "a primeira imagem que aparecer na página".
//
// Por que essa regra existe (bug real, corrigido aqui): quando o Pinterest não
// entrega o pin — link compartilhado `/sent/`, página de login, CAPTCHA — a
// página que chega traz só *sugestões de busca* e assets de marca. O extrator
// antigo pegava "o primeiro pin do estado" e "o primeiro /originals/ do HTML",
// então o bot baixava um gradiente colorido da Pinterest e o usuário recebia
// uma figurinha colorida sem nada a ver com o post.
//
// Cascata:
//   1) Widget API pública (a mesma do script de incorporação), consultada PELO
//      ID NUMÉRICO do pin → mídia confiável, todas as rendições.
//   2) Payload SSR `__PWS_DATA__` da página do pin — aceito SOMENTE quando o
//      pin do estado tem o mesmo id pedido.
//   3) og:video / og:image da página canônica (`/pin/<id>/`, sem o lixo de
//      `?invite_code=…`) — marcados como NÃO confiáveis: o motor de figurinha
//      confere o conteúdo antes de usar (gradiente de marca é descartado).
//   4) savepin.app (scrape) e Cobalt — últimos recursos.
//
// Aceita links curtos (`pin.it/abc`): o id numérico só aparece depois do
// redirect, e é ele que destrava o caminho confiável (1).

import { httpGet, resolveRedirect, BROWSER_PAGE_HEADERS } from '../../core/http.js';
import { log } from '../../core/logger.js';
import { cobaltDownload } from './cobalt.js';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/** URL de conteúdo do pinimg: /<tamanho>/<a>/<b>/<c>/<hash>.<ext> */
const PINIMG_CONTENT =
  /^https?:\/\/i\.pinimg\.com\/(?:originals|\d+x\d*|\d{2,4}x)\/([0-9a-f]{2})\/([0-9a-f]{2})\/([0-9a-f]{2})\/([0-9a-f]+)\.(jpe?g|png|gif|webp)/i;

/** Assets que o Pinterest usa na própria interface (nunca são o post). */
const PINIMG_ASSET = /(?:s\.pinimg\.com|\/upload\/|\/images\/|_board_thumbnail_|\/avatars?\/)/i;

export function isPinterestUrl(url) {
  return /(pinterest\.[a-z.]+|pin\.it)/i.test(url);
}

export function extractPinId(url) {
  return String(url).match(/\/pin\/(?:[\w-]+\/)?(\d+)/i)?.[1] || String(url).match(/pin\.it\/([\w-]+)/i)?.[1] || null;
}

/** Id de pin de verdade é numérico; `pin.it/<slug>` devolve um slug curto. */
export function isNumericPinId(id) {
  return /^\d{5,}$/.test(String(id || ''));
}

/** Já é uma página de pin do Pinterest (e não um link curto)? */
function isPinterestPinUrl(url) {
  return /(?:^|\.)pinterest\.[a-z.]+/i.test(String(url)) && /\/pin\//i.test(String(url));
}

/** https://…/pin/<id>/sent/?invite_code=… → https://…/pin/<id>/ */
export function canonicalPinUrl(url, pinId) {
  if (!pinId) return url;
  try {
    const u = new URL(url);
    if (!/pinterest\.[a-z.]+$/i.test(u.hostname)) throw new Error('host não é do Pinterest');
    return `${u.protocol}//${u.host}/pin/${pinId}/`;
  } catch {
    return `https://www.pinterest.com/pin/${pinId}/`;
  }
}

/** Hash do arquivo de conteúdo do pinimg (a "identidade" da imagem do pin). */
export function pinimgHash(url) {
  const m = PINIMG_CONTENT.exec(String(url || ''));
  return m ? m[4].toLowerCase() : null;
}

/** Troca o tamanho da URL do pinimg (`/564x/` → `/originals/`, `/736x/` …). */
export function pinimgWithSize(url, size) {
  const target = String(size || '').replace(/^\/|\/$/g, '');
  const s = String(url || '');
  if (!s || PINIMG_ASSET.test(s)) return s;
  if (!/^https?:\/\/i\.pinimg\.com\/(?:originals|\d+x\d*)\//i.test(s)) return s;
  return s.replace(
    /^(https?:\/\/i\.pinimg\.com\/)(?:originals|\d+x\d*|\d{2,4}x)\//i,
    `$1${target}/`
  );
}

/** URL de conteúdo do pinimg com formato esperado (e não asset de interface)? */
export function isPinContentUrl(url) {
  const s = String(url || '');
  return Boolean(PINIMG_CONTENT.test(s)) && !PINIMG_ASSET.test(s);
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
    alternates: [],
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

function dimLabel(size) {
  return size?.width && size?.height ? `${size.width}x${size.height}` : '';
}

/**
 * Todas as rendições de imagem do pin, da maior para a menor, com as versões
 * boas conhecidas (`originals`, `736x`) na frente — o Pinterest gera qualquer
 * largura a partir do arquivo original, então a família toda funciona.
 */
export function imageRenditions(pin) {
  const images = pin?.images || {};
  const list = [];
  const seenApiUrls = new Set();
  for (const value of Object.values(images)) {
    const url = typeof value === 'string' ? value : value?.url;
    if (!url || !isPinContentUrl(url) || seenApiUrls.has(url)) continue;
    seenApiUrls.add(url);
    list.push({ url, width: value?.width || 0, height: value?.height || 0 });
  }
  list.sort((a, b) => b.width * b.height - a.width * a.height);

  const out = [];
  const seenUrls = new Set();
  const push = (url, size) => {
    const hash = pinimgHash(url);
    if (!hash || !url || seenUrls.has(url)) return;
    seenUrls.add(url);
    out.push({ url, width: size?.width || 0, height: size?.height || 0, hash });
  };
  const best = list[0];
  if (best) push(pinimgWithSize(best.url, 'originals'), best);
  for (const item of list) {
    push(item.url, item); // a URL exatamente como a API entregou (existe sempre)
    push(pinimgWithSize(item.url, '736x'), item);
  }
  return out;
}

/** Converte um pin do Pinterest (widget ou SSR) no resultado do downloader. */
function pinResult(pin) {
  const video = bestVideo(pin);
  const images = imageRenditions(pin);
  if (!video && !images.length) return null;

  const media = [];
  if (video) {
    media.push({
      type: 'video',
      url: video.url,
      label: `${video.width || ''}x${video.height || ''}`.trim(),
      trusted: true,
      hint: 'video'
    });
  }
  for (const img of images) {
    media.push({
      type: /\.gif(\?|$)/i.test(img.url) ? 'gif' : 'image',
      url: img.url,
      label: dimLabel(img),
      trusted: true,
      hint: pinimgHash(img.url)
    });
  }

  const primary = media[0];
  return baseResult({
    kind: media.some((m) => m.type === 'video') ? 'video' : primary.type === 'gif' ? 'gif' : 'image',
    title: String(pin.grid_title || pin.title || pin.grid_description || pin.description || 'Pin do Pinterest')
      .trim()
      .slice(0, 100),
    author: pin.pinner?.username || '',
    thumbnail: images[0]?.url || '',
    media: [primary],
    alternates: media.slice(1)
  });
}

/** Pega o pin certo dentro do estado SSR — SÓ se o id bater com o pedido. */
export function findPinInState(html, pinId) {
  const raw = html?.match(/<script id="__PWS_DATA__" type="application\/json">(.*?)<\/script>/s)?.[1];
  if (!raw) return null;
  let state;
  try {
    state = JSON.parse(raw)?.props?.initialReduxState;
  } catch {
    return null;
  }
  if (!state) return null;

  const wanted = pinId ? String(pinId) : null;
  const pools = [];
  if (state.pin && typeof state.pin === 'object') pools.push(state.pin);
  if (Array.isArray(state.pins)) pools.push(...state.pins);
  else if (state.pins && typeof state.pins === 'object') pools.push(...Object.values(state.pins));
  if (wanted && state.pins?.[wanted]) pools.unshift(state.pins[wanted]);

  const usable = (p) => p && typeof p === 'object' && (p.images || p.videos);
  // Sem id pedido, NUNCA pega "o primeiro pin da página": em página de preview,
  // login ou CAPTCHA essa lista é de sugestões — foi assim que uma figurinha
  // colorida sem nada a ver saiu no lugar do pin do Flamengo.
  if (!wanted) return null;
  return pools.find((p) => usable(p) && String(p.id || '') === wanted) || null;
}

/** 1) Widget API — o caminho confiável (consultado pelo id do pin). */
async function viaWidgetApi(pinId) {
  const res = await httpGet(`https://widgets.pinterest.com/v3/pidgets/pins/info/?pin_ids=${pinId}`, {
    headers: { 'user-agent': BROWSER_UA, accept: 'application/json' },
    timeoutMs: 20_000,
    json: true
  });
  if (!res.ok || !res.data) return null;
  const pin = res.data?.data?.[0] || res.data?.data?.pins?.[0];
  if (!pin) return null;
  return pinResult(pin);
}

/**
 * 2/3) Página do pin: SSR do PRÓPRIO pin, senão og:video, senão og:image.
 * Tudo que não vier do pin (id conferido) sai marcado como `trusted: false`
 * para o motor de figurinha validar o conteúdo antes de usar.
 */
async function viaPageScrape(finalUrl, { pinId, html: preloadedHtml } = {}) {
  let html = preloadedHtml;
  if (!html) {
    const res = await httpGet(finalUrl, {
      headers: { 'user-agent': BROWSER_UA, accept: 'text/html,application/xhtml+xml' },
      timeoutMs: 25_000
    });
    if (!res.ok || !res.text) return null;
    html = res.text;
  }
  const pageMentionsPin = Boolean(pinId) && html.includes(String(pinId));

  const pin = findPinInState(html, pinId);
  if (pin) {
    const found = pinResult(pin);
    if (found?.media?.length) return found;
  }

  const ogVideo = html.match(/property="og:video(?::url)?"\s+content="([^"]+)"/)?.[1];
  if (ogVideo && !isPinContentUrl(ogVideo)) {
    const url = ogVideo.replace(/&amp;/g, '&');
    return baseResult({
      kind: 'video',
      title: metaTitle(html),
      thumbnail: html.match(/property="og:image"\s+content="([^"]+)"/)?.[1]?.replace(/&amp;/g, '&') || '',
      media: [{ type: 'video', url, label: 'og:video', trusted: false, hint: 'og-video' }]
    });
  }

  const ogImage = html.match(/property="og:image"\s+content="([^"]+)"/)?.[1]?.replace(/&amp;/g, '&');
  // Sem provar que a página é DO pin pedido, `og:image` é o que a Pinterest usa
  // como preview genérico (gradiente de marca). Preferimos não entregar nada.
  if (ogImage && isPinContentUrl(ogImage) && pageMentionsPin) {
    const alternates = imageRenditions({
      images: {
        a: { url: pinimgWithSize(ogImage, '736x') },
        b: { url: pinimgWithSize(ogImage, '564x') },
        c: { url: pinimgWithSize(ogImage, '236x') }
      }
    }).filter((i) => i.url !== ogImage);
    return baseResult({
      kind: 'image',
      title: metaTitle(html),
      thumbnail: ogImage,
      media: [
        {
          type: 'image',
          url: ogImage,
          label: 'og:image',
          // Asset de marca (gradiente de página de login) NUNCA entra confiável:
          // o motor de figurinha confere o conteúdo antes de usar.
          trusted: false,
          pinScoped: true,
          hint: 'og-image'
        }
      ],
      alternates
    });
  }

  const vids = [...html.matchAll(/https:\/\/v1\.pinimg\.com\/videos\/[^"\\\s]+\.mp4/g)].map((m) => m[0]);
  if (vids.length && pageMentionsPin) {
    return baseResult({
      kind: 'video',
      media: [{ type: 'video', url: vids.sort((a, b) => b.length - a.length)[0], trusted: false, hint: 'html-video' }]
    });
  }
  return null;
}

function metaTitle(html) {
  return (
    html.match(/property="og:title"\s+content="([^"]+)"/)?.[1]?.replace(/&amp;/g, '&') ||
    html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ||
    ''
  ).slice(0, 100);
}

/** 4) savepin.app — reserva comunitária (resultado não confiável, mas útil). */
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
    return baseResult({
      kind: 'video',
      media: [{ type: 'video', url: videos[0], trusted: false, hint: 'savepin' }]
    });
  }
  const images = [...html.matchAll(/href="([^"]*pinimg\.com\/(?:originals|\d+x)\/[^"]*\.(?:jpg|jpeg|png|gif)[^"]*)"/gi)]
    .map((m) => m[1].replace(/&amp;/g, '&'))
    .filter(isPinContentUrl);
  if (images.length) {
    return baseResult({
      kind: 'image',
      thumbnail: images[0],
      media: [{ type: 'image', url: images[0], trusted: false, hint: 'savepin' }],
      alternates: imageRenditions({ images: { a: { url: images[0] } } }).slice(1)
    });
  }
  return null;
}

/**
 * Descobre o id numérico do pin e a URL canônica que vale a pena raspar.
 * Links curtos (`pin.it/abc`) só revelam o id depois do redirect — e usa-se GET
 * (não HEAD): o pin.it responde 200 ao HEAD sem Location, o que já fez o bot
 * tratar um slug como id e cair na página errada.
 */
export async function resolvePinterestTarget(url) {
  const direct = extractPinId(url);
  // Id direto só vale em página de pin: `pin.it/1234567890` é um CÓDIGO curto
  // (pode ser só dígitos) e precisa do redirect para virar id de verdade.
  if (isNumericPinId(direct) && isPinterestPinUrl(url)) {
    return { id: direct, pageUrl: canonicalPinUrl(url, direct), html: null, finalUrl: url };
  }
  const res = await httpGet(url, { headers: BROWSER_PAGE_HEADERS, timeoutMs: 20_000 }).catch(() => null);
  const finalUrl = res?.finalUrl || (await resolveRedirect(url).catch(() => url));
  const id = extractPinId(finalUrl);
  if (isNumericPinId(id)) {
    return { id, pageUrl: canonicalPinUrl(finalUrl, id), html: null, finalUrl };
  }
  return { id: null, pageUrl: finalUrl || url, html: res?.text || null, finalUrl: finalUrl || url };
}

/**
 * @param {string} url link do Pinterest (aceita pin.it)
 * @param {'melhor'|'alta'|'media'|'baixa'} quality
 */
export async function downloadPinterest(url, quality = 'melhor') {
  const errors = [];
  const target = await resolvePinterestTarget(url).catch(() => ({ id: null, pageUrl: url, html: null }));
  const pinId = target.id;

  // 1) Caminho confiável: widget API pelo id numérico do pin.
  if (pinId) {
    try {
      const found = await viaWidgetApi(pinId);
      if (found?.media?.length) return found;
      errors.push('widget api: sem mídia');
    } catch (error) {
      errors.push(`widget api: ${String(error.message).slice(0, 60)}`);
    }
  } else {
    errors.push('não consegui identificar o id do pin (o link curto não resolveu)');
  }

  // 2/3) Página canônica do pin (`/pin/<id>/`, sem invite_code/sender do /sent/).
  // Se o GET do redirect já trouxe exatamente essa página, reaproveita o HTML.
  try {
    const reuse = target.html && target.finalUrl === target.pageUrl ? target.html : null;
    const found = await viaPageScrape(target.pageUrl, { pinId, html: reuse });
    if (found?.media?.length) return found;
    errors.push('página do pin: sem mídia do pin');
  } catch (error) {
    errors.push(`página do pin: ${String(error.message).slice(0, 60)}`);
  }

  // 4) Reservas.
  try {
    const found = await viaSavePin(target.pageUrl);
    if (found?.media?.length) return found;
  } catch (error) {
    errors.push(`savepin: ${String(error.message).slice(0, 60)}`);
  }

  log.dl('pinterest: tentando via cobalt…');
  try {
    const { buffers, audioBuffer, ...rest } = await cobaltDownload(target.pageUrl, quality);
    if (buffers?.length) return baseResult({ ...rest, buffers, audioBuffer });
    errors.push('cobalt: sem buffer');
  } catch (error) {
    errors.push(`cobalt: ${String(error.message).slice(0, 60)}`);
  }

  throw new Error(`Pinterest falhou em todas as estratégias: ${errors.join(' | ')}`);
}
