// ▶️ YouTube — extração pela Innertube (a API privada do player do próprio
// YouTube), o método que os bots reais usam hoje.
//
// Por que Innertube e não só Cobalt:
//   • É UM POST JSON. Não precisa de yt-dlp, Python nem ffmpeg.
//   • O cliente ANDROID_VR (app do Oculus) é o ÚNICO que ainda publica um
//     stream "muxado" (vídeo+áudio num arquivo só, itag 18) com URL não
//     assinada. O cliente WEB devolve `signatureCipher`, que só se resolve
//     baixando e interpretando o JS do player — caro e frágil.
//   • IOS entra como reserva: é adaptativo (sem muxado), mas ainda responde
//     áudio não assinado quando o ANDROID_VR é bloqueado por "bot".
//
// Teto honesto: 360p para vídeo (o YouTube só publica um stream muxado).
// Áudio sai em qualidade cheia, porque stream só de áudio não precisa muxar.
//
// Reservas: Cobalt (túnel) → e, se houver binário, yt-dlp.

import { postJson, fetchJson } from '../../core/http.js';
import { log } from '../../core/logger.js';
import { cobaltDownload } from './cobalt.js';

const PLAYER_ENDPOINT = 'https://www.youtube.com/youtubei/v1/player';

/** Clientes impersonados: versões reais — o YouTube recusa cliente inventado. */
const CLIENTS = [
  {
    name: 'ANDROID_VR',
    context: {
      clientName: 'ANDROID_VR',
      clientVersion: '1.62.27',
      androidSdkVersion: 32,
      deviceMake: 'Oculus',
      deviceModel: 'Quest 3',
      osName: 'Android',
      osVersion: '12',
      hl: 'en',
      gl: 'US'
    },
    userAgent: 'com.google.android.apps.youtube.vr.oculus/1.62.27 (Linux; U; Android 12; GB) gzip'
  },
  {
    name: 'IOS',
    context: {
      clientName: 'IOS',
      clientVersion: '20.10.4',
      deviceMake: 'Apple',
      deviceModel: 'iPhone16,2',
      osName: 'iPhone',
      osVersion: '18.3.2.22D82',
      hl: 'en',
      gl: 'US'
    },
    userAgent: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X; en_US)'
  }
];

export function isYouTubeUrl(url) {
  return /(youtube\.com|youtu\.be)/i.test(url);
}

export function parseYouTubeId(url) {
  const u = String(url || '').trim();
  if (!u) return null;
  if (/^[\w-]{11}$/.test(u)) return u;
  try {
    const parsed = new URL(u.startsWith('http') ? u : `https://${u}`);
    if (parsed.hostname.includes('youtu.be')) {
      const id = parsed.pathname.slice(1).split(/[/?#]/)[0];
      if (/^[\w-]{11}$/.test(id)) return id;
    }
    const v = parsed.searchParams.get('v');
    if (v && /^[\w-]{11}$/.test(v)) return v;
    const pathSegments = parsed.pathname.split('/').filter(Boolean);
    for (const key of ['shorts', 'embed', 'live', 'v', 'e']) {
      const idx = pathSegments.indexOf(key);
      if (idx !== -1 && pathSegments[idx + 1] && /^[\w-]{11}$/.test(pathSegments[idx + 1])) {
        return pathSegments[idx + 1];
      }
    }
  } catch {}
  return (
    u.match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/|v\/|e\/)([\w-]{11})/)?.[1] ||
    u.match(/^[\w-]{11}$/)?.[0] ||
    null
  );
}

function baseResult(extra = {}) {
  return {
    platform: 'YouTube',
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

const byBitrateDesc = (a, b) => (b.bitrate || 0) - (a.bitrate || 0);

/** Melhor stream MUXADO (vídeo+áudio juntos): só `streamingData.formats`. */
function pickProgressive(data) {
  const formats = (data.streamingData?.formats || []).filter((f) => f.url && !f.signatureCipher);
  return formats.sort(byBitrateDesc)[0];
}

/** Melhor stream só de áudio, preferindo MP4/AAC (WebM não toca em iOS). */
function pickAudio(data) {
  const audio = (data.streamingData?.adaptiveFormats || []).filter(
    (f) => f.url && !f.signatureCipher && String(f.mimeType || '').startsWith('audio/')
  );
  const mp4 = audio.filter((f) => String(f.mimeType || '').includes('mp4'));
  return (mp4.length ? mp4 : audio).sort(byBitrateDesc)[0];
}

function pickThumbnail(data, videoId) {
  const thumbs = data.videoDetails?.thumbnail?.thumbnails || [];
  let best = '';
  let bestWidth = -1;
  for (const t of thumbs) {
    if (t.url && (t.width || 0) > bestWidth) {
      best = t.url;
      bestWidth = t.width || 0;
    }
  }
  return best || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

async function askClient(client, videoId) {
  const data = await postJson(
    PLAYER_ENDPOINT,
    {
      videoId,
      // Sem estes, vídeos com restrição de idade/"pode ser inadequado"
      // voltam como UNPLAYABLE mesmo estando disponíveis.
      contentCheckOk: true,
      racyCheckOk: true,
      context: { client: client.context }
    },
    {
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': client.userAgent
      },
      timeoutMs: 20_000
    }
  );
  if (data?.playabilityStatus?.status !== 'OK') return null;
  return data;
}

/** Metadados públicos (título/autor/capa) para enriquecer respostas pobres. */
async function oembedMeta(canonical, videoId) {
  try {
    const json = await fetchJson(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(canonical)}&format=json`,
      { timeoutMs: 12_000 }
    );
    return {
      title: json?.title,
      author: json?.author_name,
      thumbnail: json?.thumbnail_url || (videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : '')
    };
  } catch {
    return { thumbnail: videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : '' };
  }
}

/**
 * @param {string} url link do YouTube
 * @param {'melhor'|'alta'|'media'|'baixa'} quality
 * @param {{audioOnly?: boolean}} opts
 */
export async function downloadYouTube(url, quality = 'melhor', { audioOnly = false, maxBytes } = {}) {
  const videoId = parseYouTubeId(url);
  const canonical = videoId ? `https://www.youtube.com/watch?v=${videoId}` : url;
  const errors = [];
  let innertubeAudio = null;
  let innertubeBase = null;

  // 1) Innertube — tenta cada cliente até algum responder utilizável
  if (videoId) {
    for (const client of CLIENTS) {
      try {
        const data = await askClient(client, videoId);
        if (!data) {
          errors.push(`${client.name}: ${data === null ? 'bloqueado' : 'sem stream'}`);
          continue;
        }
        const details = data.videoDetails || {};
        const base = {
          title: details.title || '',
          author: details.author || '',
          duration: Number(details.lengthSeconds) || 0,
          thumbnail: pickThumbnail(data, videoId)
        };
        const audio = pickAudio(data);

        if (audioOnly && audio?.url) {
          return baseResult({ ...base, kind: 'audio', media: [{ type: 'audio', url: audio.url, label: 'áudio' }] });
        }

        const progressive = pickProgressive(data);
        if (progressive?.url) {
          return baseResult({
            ...base,
            kind: 'video',
            media: [{ type: 'video', url: progressive.url, label: progressive.qualityLabel || 'vídeo' }],
            audioOnly: audio ? { type: 'audio', url: audio.url, label: 'áudio' } : null
          });
        }

        // Sem muxado: guarda a faixa de áudio como reserva se Cobalt não tiver vídeo
        if (audio?.url && !innertubeAudio) {
          innertubeAudio = audio;
          innertubeBase = base;
        }
        errors.push(`${client.name}: sem stream muxado`);
      } catch (error) {
        errors.push(`${client.name}: ${String(error.message).slice(0, 60)}`);
      }
    }
  }

  // 2) Cobalt (túnel comunitário — faz remux de vídeo/áudio ou baixa MP3)
  log.dl('youtube: tentando via cobalt…');
  try {
    const { buffers, audioBuffer, ...rest } = await cobaltDownload(canonical, quality, { audioOnly, maxBytes });
    if (buffers?.length) {
      const meta = await oembedMeta(canonical, videoId);
      const isAudio = audioOnly || rest.kind === 'audio';
      return baseResult({
        ...rest,
        platform: 'YouTube',
        kind: isAudio ? 'audio' : (rest.kind || 'video'),
        media: (rest.media?.length ? rest.media : [{ url: canonical, label: isAudio ? 'áudio' : 'vídeo' }]).map((m) =>
          isAudio ? { ...m, type: 'audio' } : m
        ),
        title: meta.title || rest.title || '',
        author: meta.author || rest.author || '',
        thumbnail: meta.thumbnail || rest.thumbnail || '',
        buffers,
        audioBuffer
      });
    }
    errors.push('cobalt: sem buffer');
  } catch (error) {
    errors.push(`cobalt: ${String(error.message).slice(0, 60)}`);
  }

  // 3) Se o usuário pediu vídeo e o Cobalt falhou, mas temos a faixa de áudio do Innertube, entrega áudio
  if (innertubeAudio?.url) {
    log.dl('youtube: sem stream muxado — entregando a faixa de áudio');
    return baseResult({
      ...innertubeBase,
      kind: 'audio',
      media: [{ type: 'audio', url: innertubeAudio.url, label: 'áudio' }]
    });
  }

  throw new Error(
    `YouTube falhou em todas as estratégias: ${errors.join(' | ')}. ` +
      'O vídeo pode ser privado, com restrição de idade/região, ao vivo ou removido.'
  );
}
