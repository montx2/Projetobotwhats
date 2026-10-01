// 🎵 TikTok — extração em cascata, igual aos bots reais que ainda funcionam:
//   1) TikWM (POST /api/ com {url, hd:1} — SEM `web:1`) → melhor qualidade, sem marca
//   2) Cobalt (túnel) → funciona quando a tikwm cai ou limita
//   3) Scraping direto do `webapp.video-detail` (playAddr/downloadAddr)
//   4) oEmbed público do TikTok para título/autor/capa
//
// Detalhes que quebram os bots ingênuos:
//   • `web:1` faz a tikwm devolver URLs no próprio host (capa 403 para todos).
//   • hdplay às vezes vem em bvc2 (codec próprio da ByteDance) — aí cai pro play.
//   • Em slideshow, `play` aponta para um MP4 só de áudio; as fotos vêm em `images`.

import { KeyPool } from '../../core/keypool.js';
import { ENV } from '../../core/config.js';
import { fetchJson, postJson, httpGet, fetchBuffer, resolveRedirect } from '../../core/http.js';
import { log } from '../../core/logger.js';
import { cobaltDownload } from './cobalt.js';
import { probeStream } from './media.js';

const DEFAULT_ENDPOINTS = ['https://www.tikwm.com/api/', 'https://tikwm.com/api/'];
const pool = new KeyPool('tikwm', ENV.tiktokApi.length ? ENV.tiktokApi : DEFAULT_ENDPOINTS, {
  cooldownMs: 10 * 60_000
});

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

export function isTikTokUrl(url) {
  return /tiktok\.com|vm\.tiktok|vt\.tiktok/i.test(url);
}

/** A tikwm devolve alguns caminhos relativos (/video/media/…). */
function absolute(path) {
  if (!path) return undefined;
  if (!String(path).startsWith('/')) return path;
  return `https://www.tikwm.com${path}`;
}

/**
 * Capa que o navegador consegue abrir: as hospedadas na tikwm dão 403 para
 * todo mundo (hotlink travado); as originais do tiktokcdn abrem direto.
 */
function pickCover(data) {
  for (const candidate of [data.origin_cover, data.cover, data.ai_dynamic_cover]) {
    const url = absolute(candidate);
    if (url && !url.includes('tikwm.com')) return url;
  }
  return absolute(data.cover) || '';
}

/** ID numérico do vídeo (serve de chave estável p/ o fallback). */
export function tiktokVideoId(url) {
  return (
    String(url).match(/\/video\/(\d+)/)?.[1] ||
    String(url).match(/\/photo\/(\d+)/)?.[1] ||
    String(url).match(/(?:^|\/)(\d{15,})(?:\D|$)/)?.[1] ||
    null
  );
}

/** Confere se o MP4 usa um codec que o WhatsApp/celular renderiza. */
async function codecIsPlayable(url) {
  try {
    const res = await fetchBuffer(url, {
      timeoutMs: 8_000,
      maxBytes: 96 * 1024,
      headers: { Range: 'bytes=0-65535', Referer: 'https://www.tiktok.com/' }
    });
    const head = res.subarray(0, 96 * 1024).toString('latin1');
    return ['avc1', 'avc2', 'avc3', 'hvc1', 'hev1', 'vp08', 'vp09', 'av01'].some((c) => head.includes(c));
  } catch {
    // Falhou a sondagem: assume que está bom em vez de perder o vídeo.
    return true;
  }
}

/** Metadata pública (título/autor/capa) sem login nem chave. */
async function oembedMeta(url) {
  try {
    const json = await fetchJson(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`, {
      timeoutMs: 12_000
    });
    return { title: json?.title, author: json?.author_name, thumbnail: json?.thumbnail_url };
  } catch {
    return {};
  }
}

function normalizeResult(out) {
  return { platform: 'TikTok', author: '', title: '', duration: 0, thumbnail: '', ...out };
}

/** 1) TikWM — a fonte mais rica quando responde. */
async function viaTikwm(url, quality) {
  return pool.run(
    async (endpoint) => {
      const json = await postJson(
        endpoint,
        { url, count: 12, cursor: 0, hd: quality === 'baixa' || quality === 'media' ? 0 : 1 },
        {
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/plain, */*',
            'user-agent': BROWSER_UA,
            origin: 'https://www.tikwm.com',
            referer: 'https://www.tikwm.com/'
          },
          timeoutMs: 45_000
        }
      );
      if (!json || json.code !== 0 || !json.data) {
        const err = new Error(json?.msg || 'tikwm não retornou dados');
        err.status = 422;
        throw err;
      }
      return json.data;
    },
    { label: url.slice(0, 60) }
  );
}

function buildFromTikwmData(data, url, quality) {
  const id = tiktokVideoId(url) || data.id || '';
  const out = normalizeResult({
    title: data.title || '',
    author: data.author?.nickname || data.author?.unique_id || '',
    duration: Number(data.duration) || 0,
    thumbnail: pickCover(data),
    audioOnly: null
  });

  // Slideshow (carrossel de fotos)
  if (Array.isArray(data.images) && data.images.length) {
    out.kind = 'slideshow';
    out.media = data.images.slice(0, 10).map((u, i) => ({ type: 'image', url: u, label: `foto ${i + 1}` }));
    const music = absolute(data.music_info?.play) || absolute(data.music);
    if (music) {
      out.audioOnly = { type: 'audio', url: music, label: data.music_info?.title || 'música' };
    }
    return out;
  }

  const hdplay = absolute(data.hdplay);
  const play = absolute(data.play);
  const wmplay = absolute(data.wmplay);

  const options = [];
  if (hdplay) options.push({ type: 'video', url: hdplay, quality: 'melhor', label: 'HD sem marca' });
  if (play) options.push({ type: 'video', url: play, quality: 'media', label: 'sem marca' });
  if (wmplay) options.push({ type: 'video', url: wmplay, quality: 'baixa', label: 'com marca' });
  if (!options.length) return null;

  out.kind = 'video';
  const music = absolute(data.music_info?.play) || absolute(data.music);
  if (music) out.audioOnly = { type: 'audio', url: music, label: data.music_info?.title || 'música' };

  if (quality === 'baixa') out.media = [options[options.length - 1]];
  else if (quality === 'media') out.media = [options.find((o) => o.quality === 'media') || options[0]];
  else out.media = [options[0]];

  out._alternatives = options.map((o) => o.url);
  return out;
}

/** 3) Scraping direto da página (último recurso antes do Cobalt). */
async function viaDirectScrape(url) {
  const resolved = await resolveRedirect(url).catch(() => url);
  const res = await httpGet(resolved, {
    headers: {
      'user-agent': BROWSER_UA,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
    },
    timeoutMs: 30_000
  });
  if (!res.ok) return null;
  const marker = 'webapp.video-detail';
  const idx = res.text.indexOf(marker);
  if (idx === -1) return null;
  const slice = res.text.slice(Math.max(0, idx - 200_000), idx + 200_000);
  const playAddr = slice.match(/"playAddr":"([^"]+)"/)?.[1];
  const downloadAddr = slice.match(/"downloadAddr":"([^"]+)"/)?.[1];
  const raw = downloadAddr || playAddr;
  if (!raw) return null;
  return normalizeResult({
    kind: 'video',
    title: '',
    duration: 0,
    media: [{ type: 'video', url: raw.replace(/\\u002F/gi, '/'), label: 'direto' }]
  });
}

/**
 * @param {string} url link do TikTok (vm.tiktok, vt.tiktok, /t/…)
 * @param {'melhor'|'alta'|'media'|'baixa'} quality
 */
export async function downloadTikTok(url, quality = 'melhor') {
  const canonical = await resolveRedirect(url).catch(() => url);
  const errors = [];

  // 1) TikWM
  try {
    const data = await viaTikwm(canonical, quality);
      let built = buildFromTikwmData(data, canonical, quality);
      if (built) {
        // hdplay às vezes vem em bvc2 (codec próprio da ByteDance) que nenhum
        // player renderiza — nesse caso cai para o play (H.264).
        if (built.kind === 'video') {
        const hd = built.media[0].url;
        const alt = built._alternatives?.find((u) => u && u !== hd);
        if (!(await codecIsPlayable(hd)) && alt) {
          log.dl('tiktok: hdplay em codec não suportado — usando play (H.264)');
          built.media = [{ type: 'video', url: alt, label: 'sem marca' }];
        }
      }
      delete built._alternatives;

      // Enriquece metadados com o oEmbed público
      const id = tiktokVideoId(canonical);
      const author = built.author || data.author?.unique_id;
      const meta = await oembedMeta(
        author && id ? `https://www.tiktok.com/@${author}/video/${id}` : canonical
      );
      if (meta.title) built.title = built.title || meta.title;
      if (meta.author) built.author = built.author || meta.author;
      if (meta.thumbnail) built.thumbnail = built.thumbnail || meta.thumbnail;
      return built;
    }
    errors.push('tikwm sem mídia');
  } catch (error) {
    errors.push(`tikwm: ${String(error.message).slice(0, 70)}`);
  }

  // 2) Cobalt (túnel — serve de qualquer IP)
  try {
    log.dl('tiktok: tentando via cobalt…');
    const { buffers, audioBuffer, ...rest } = await cobaltDownload(canonical, quality);
    const meta = await oembedMeta(canonical);
    return normalizeResult({
      ...rest,
      platform: 'TikTok',
      kind: rest.kind === 'audio' ? 'audio' : rest.kind,
      title: meta.title || rest.title || '',
      author: meta.author || rest.author || '',
      thumbnail: meta.thumbnail || rest.thumbnail || '',
      buffers,
      audioBuffer
    });
  } catch (error) {
    errors.push(`cobalt: ${String(error.message).slice(0, 70)}`);
  }

  // 3) Scraping direto
  try {
    const scraped = await viaDirectScrape(canonical);
    if (scraped) return scraped;
    errors.push('scraping sem mídia');
  } catch (error) {
    errors.push(`scraping: ${String(error.message).slice(0, 70)}`);
  }

  throw new Error(`TikTok falhou em todas as estratégias: ${errors.join(' | ')}`);
}

/** Só a música do vídeo (para .ttmp3). */
export async function tiktokAudio(url) {
  const result = await downloadTikTok(url, 'melhor');
  if (result.audioOnly) return { ...result, kind: 'audio', media: [{ ...result.audioOnly }] };
  // Sem faixa separada: devolve o próprio vídeo (o caller extrai o áudio).
  return { ...result, kind: 'audio' };
}

export function tiktokPool() {
  return pool;
}
