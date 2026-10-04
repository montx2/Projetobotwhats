// ▶️ YouTube — extração pela Innertube (a API privada do player do próprio
// YouTube), com reservas em Invidious, Cobalt e yt-dlp.
//
// Por que Innertube e não só Cobalt:
//   • É UM POST JSON. Não precisa de yt-dlp, Python nem ffmpeg.
//   • Alguns clientes oficiais ainda publicam URL DIRETA (sem `signatureCipher`,
//     que só se resolve interpretando o JS do player — caro e frágil).
//
// 🩹 Correção 2026 (o `.ytmp3` que respondia "download falhou … 403"):
//   O YouTube passou a exigir PO token no CDN (GVS) para quase todos os
//   clientes. O ANDROID_VR, que era o nosso primeiro, hoje só entrega o itag 18
//   sem token — a faixa de áudio dele responde 403 no download. Como o extrator
//   devolvia essa URL sem testar, o bot "achava" a mídia e só quebrava na hora
//   de baixar, e aí nem o Cobalt era tentado.
//
//   Agora: VISIONOS (Apple Vision Pro) vai primeiro — continua emitindo URL
//   direta, sem cifra e sem PO token —, e TODA URL escolhida é sondada (início
//   e fim) antes de ser devolvida. URL recusada pelo CDN é descartada na hora,
//   e a cascata segue para o próximo cliente / Invidious / Cobalt.
//
// Teto honesto: 360p quando só há stream muxado (itag 18); com VISIONOS o vídeo
// adaptativo existe, mas sem ffmpeg não dá para juntar faixas, então o muxado
// continua sendo o alvo para vídeo. Áudio sai em qualidade cheia.
//
// Reservas: Invidious API → Cobalt (túnel) → e, se houver binário, yt-dlp.

import { postJson, fetchJson, httpGet, randomUA } from '../../core/http.js';
import { log } from '../../core/logger.js';
import { cobaltDownload } from './cobalt.js';
import { isGoogleVideoUrl, probeGoogleVideo } from './gvs.js';

const PLAYER_ENDPOINT = 'https://www.youtube.com/youtubei/v1/player';
const YT_ORIGIN = 'https://www.youtube.com';

/** Dica mostrada quando o YouTube responde com o muro de "confirme que não é um robô". */
export const YT_BOT_WALL_HINT =
  'O YouTube exigiu verificação para este IP. Atualize o extrator (pip install -U yt-dlp) ' +
  'e, se persistir, aponte YTDLP_COOKIES=/caminho/cookies.txt no .env (cookies exportados de uma aba anônima logada).';

/**
 * Clientes impersonados: versões reais — o YouTube recusa cliente inventado.
 * A ordem é a parte que importa, e ela vale por um motivo medido:
 *   1. VISIONOS  → URL direta, sem PO token, aceita Range em qualquer faixa.
 *   2. ANDROID_VR→ ainda útil para o muxado (itag 18); o áudio costuma dar 403.
 *   3. IOS       → reserva quando os dois acima caem no muro de "bot".
 *   4. ANDROID (sem androidSdkVersion) → variante que não dispara PO token.
 * Quando o YouTube aposentar uma versão, é só bumpar `clientVersion` aqui.
 */
const CLIENTS = [
  {
    name: 'VISIONOS',
    context: {
      clientName: 'VISIONOS',
      clientVersion: '1.02',
      deviceMake: 'Apple',
      deviceModel: 'RealityDevice17,1',
      osName: 'visionOS',
      osVersion: '26.5.23O471',
      hl: 'en',
      gl: 'US'
    },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
  },
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
  },
  {
    // Sem `androidSdkVersion` o YouTube não exige PO token deste cliente.
    name: 'ANDROID',
    context: {
      clientName: 'ANDROID',
      clientVersion: '20.10.38',
      osName: 'Android',
      osVersion: '11',
      hl: 'en',
      gl: 'US'
    },
    userAgent: 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip'
  }
];

const INVIDIOUS_INSTANCES = [
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://invidious.private.coffee',
  'https://vid.priv.au',
  'https://invidious.drgns.space'
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

/** Streams MUXADOS (vídeo+áudio no mesmo arquivo), do melhor para o pior. */
function progressiveFormats(data) {
  return (data.streamingData?.formats || []).filter((f) => f.url && !f.signatureCipher).sort(byBitrateDesc);
}

/** Streams só de áudio, preferindo MP4/AAC (WebM não toca em iOS). */
function audioFormats(data) {
  const audio = (data.streamingData?.adaptiveFormats || []).filter(
    (f) => f.url && !f.signatureCipher && String(f.mimeType || '').startsWith('audio/')
  );
  const mp4 = audio.filter((f) => String(f.mimeType || '').includes('mp4')).sort(byBitrateDesc);
  const rest = audio.filter((f) => !String(f.mimeType || '').includes('mp4')).sort(byBitrateDesc);
  return [...mp4, ...rest];
}

/** Melhor stream só de áudio (sem sondagem — usado como faixa extra do vídeo). */
function pickAudio(data) {
  return audioFormats(data)[0];
}

/**
 * Transforma um formato da Innertube no item de mídia que o downloader usa.
 * `ranged` avisa o baixador para pedir faixas (o GVS recusa GET aberto em
 * algumas URLs) e `contentLength` evita uma sondagem extra.
 */
function toMediaItem(format, type, client, label) {
  const size = Number(format?.contentLength) || 0;
  return {
    type,
    url: format.url,
    label: label || format.qualityLabel || (type === 'audio' ? 'áudio' : 'vídeo'),
    headers: client?.userAgent ? { 'user-agent': client.userAgent } : undefined,
    ranged: isGoogleVideoUrl(format.url),
    ...(size ? { contentLength: size } : {})
  };
}

/**
 * Devolve o PRIMEIRO formato que o CDN realmente entrega.
 *
 * É a correção central do 403: antes o extrator devolvia a primeira URL que
 * aparecia no JSON e o download morria depois, longe da cascata de reservas.
 * Agora a URL recusada (403/401 = PO token exigido) é descartada aqui, com o
 * motivo registrado, e a busca continua.
 *
 * Uma URL "unknown" (rede instável, resposta estranha) é aceita: não dá para
 * provar que está quebrada, e o baixador ainda tem as reservas se falhar.
 */
async function firstPlayableFormat(formats, client, { errors, videoId, limit = 2 } = {}) {
  let fallback = null;
  for (const format of (formats || []).slice(0, limit)) {
    if (!format?.url) continue;
    if (!isGoogleVideoUrl(format.url)) return format; // Invidious/proxy: sem sondagem
    const probe = await probeGoogleVideo(format.url, {
      headers: client?.userAgent ? { 'user-agent': client.userAgent } : {},
      totalBytes: Number(format.contentLength) || 0
    });
    if (probe.verdict === 'ok') return format;
    if (probe.verdict === 'gated') {
      errors?.push(`${client?.name || 'innertube'}: itag ${format.itag} recusado pelo CDN (${probe.status})`);
      log.warn(`youtube: ${client?.name || 'innertube'} itag ${format.itag} exige PO token (HTTP ${probe.status}) — descartando`, { videoId });
      continue;
    }
    fallback ||= format; // não deu para confirmar; guarda como última opção
  }
  return fallback;
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

/**
 * Pergunta ao player da Innertube por um cliente específico.
 * `visitorData` (quando um cliente anterior já devolveu um) faz o YouTube
 * tratar as chamadas como a MESMA sessão — reduz muito o muro de "bot".
 * @returns {Promise<{data?: object, reason?: string, visitorData?: string}>}
 */
async function askClient(client, videoId, { visitorData } = {}) {
  const context = { client: { ...client.context } };
  if (visitorData) context.client.visitorData = visitorData;

  const data = await postJson(
    PLAYER_ENDPOINT,
    {
      videoId,
      // Sem estes, vídeos com restrição de idade/"pode ser inadequado"
      // voltam como UNPLAYABLE mesmo estando disponíveis.
      contentCheckOk: true,
      racyCheckOk: true,
      context
    },
    {
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': client.userAgent,
        origin: YT_ORIGIN,
        referer: `${YT_ORIGIN}/watch?v=${videoId}`,
        ...(visitorData ? { 'x-goog-visitor-id': visitorData } : {})
      },
      timeoutMs: 20_000
    }
  );

  const nextVisitor = data?.responseContext?.visitorData || visitorData || '';
  const status = data?.playabilityStatus?.status;
  if (status !== 'OK') {
    const reason =
      data?.playabilityStatus?.reason ||
      data?.playabilityStatus?.messages?.[0] ||
      status ||
      'sem resposta';
    return { reason: `${status || 'FALHA'}: ${String(reason).slice(0, 80)}`, visitorData: nextVisitor };
  }
  return { data, visitorData: nextVisitor };
}

/** Invidious fallback extractor */
async function askInvidious(videoId) {
  for (const inst of INVIDIOUS_INSTANCES) {
    try {
      const data = await fetchJson(`${inst}/api/v1/videos/${videoId}`, { timeoutMs: 12_000 });
      if (data && (data.formatStreams?.length || data.adaptiveFormats?.length)) {
        return { inst, data };
      }
    } catch {}
  }
  return null;
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

/** Pesquisa vídeo ou música no YouTube e devolve o vídeo correspondente */
export async function searchYouTube(query) {
  const q = String(query || '').trim();
  if (!q) return null;
  const existingId = parseYouTubeId(q);
  if (existingId) return { videoId: existingId, title: q, url: `https://www.youtube.com/watch?v=${existingId}` };

  for (const inst of INVIDIOUS_INSTANCES) {
    try {
      const results = await fetchJson(`${inst}/api/v1/search?q=${encodeURIComponent(q)}&type=video`, { timeoutMs: 10_000 });
      if (Array.isArray(results) && results.length) {
        const first = results.find((r) => r.type === 'video' || r.videoId) || results[0];
        if (first?.videoId) {
          return {
            videoId: first.videoId,
            title: first.title || q,
            author: first.author || '',
            duration: Number(first.lengthSeconds) || 0,
            url: `https://www.youtube.com/watch?v=${first.videoId}`
          };
        }
      }
    } catch {}
  }

  try {
    const data = await postJson('https://www.youtube.com/youtubei/v1/search', {
      query: q,
      context: {
        client: {
          clientName: 'WEB',
          clientVersion: '2.20240101.00.00',
          hl: 'pt-BR',
          gl: 'BR'
        }
      }
    }, { timeoutMs: 12_000 });
    const contents =
      data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents?.[0]
        ?.itemSectionRenderer?.contents || [];
    for (const item of contents) {
      const renderer = item?.videoRenderer;
      if (renderer?.videoId) {
        const title = renderer.title?.runs?.[0]?.text || renderer.title?.simpleText || q;
        const author = renderer.ownerText?.runs?.[0]?.text || '';
        return {
          videoId: renderer.videoId,
          title,
          author,
          url: `https://www.youtube.com/watch?v=${renderer.videoId}`
        };
      }
    }
  } catch {}

  try {
    const res = await httpGet(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`, {
      headers: { 'user-agent': randomUA(), accept: 'text/html' },
      timeoutMs: 12_000
    });
    if (res.ok && res.text) {
      const match = res.text.match(/"videoId":"([\w-]{11})"/);
      if (match?.[1]) {
        return {
          videoId: match[1],
          title: q,
          url: `https://www.youtube.com/watch?v=${match[1]}`
        };
      }
    }
  } catch {}

  return null;
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

  // 1) Innertube — tenta cada cliente até algum responder stream que o CDN
  //    realmente entregue (URL só é aceita depois de sondada).
  let visitorData = '';
  let botWall = false;
  if (videoId) {
    for (const client of CLIENTS) {
      try {
        const { data, reason, visitorData: nextVisitor } = await askClient(client, videoId, { visitorData });
        if (nextVisitor) visitorData = nextVisitor;
        if (!data) {
          if (/not a bot|LOGIN_REQUIRED|Sign in/i.test(reason || '')) botWall = true;
          errors.push(`${client.name}: ${reason || 'bloqueado'}`);
          continue;
        }
        const details = data.videoDetails || {};
        const base = {
          title: details.title || '',
          author: details.author || '',
          duration: Number(details.lengthSeconds) || 0,
          thumbnail: pickThumbnail(data, videoId)
        };

        if (audioOnly) {
          const audio = await firstPlayableFormat(audioFormats(data), client, { errors, videoId });
          if (audio?.url) {
            return baseResult({
              ...base,
              kind: 'audio',
              media: [toMediaItem(audio, 'audio', client, 'áudio')]
            });
          }
          errors.push(`${client.name}: sem faixa de áudio utilizável`);
          continue;
        }

        const progressive = await firstPlayableFormat(progressiveFormats(data), client, { errors, videoId });
        if (progressive?.url) {
          const audio = pickAudio(data);
          return baseResult({
            ...base,
            kind: 'video',
            media: [toMediaItem(progressive, 'video', client)],
            audioOnly: audio ? toMediaItem(audio, 'audio', client, 'áudio') : null
          });
        }

        // Sem muxado: guarda uma faixa de áudio VALIDADA como reserva, para o
        // caso de o Cobalt também não ter vídeo.
        if (!innertubeAudio) {
          const audio = await firstPlayableFormat(audioFormats(data), client, { errors, videoId, limit: 1 });
          if (audio?.url) {
            innertubeAudio = toMediaItem(audio, 'audio', client, 'áudio');
            innertubeBase = base;
          }
        }
        errors.push(`${client.name}: sem stream muxado`);
      } catch (error) {
        errors.push(`${client.name}: ${String(error.message).slice(0, 60)}`);
      }
    }
  }

  // 2) Invidious API
  if (videoId) {
    try {
      const inv = await askInvidious(videoId);
      if (inv) {
        const { inst, data } = inv;
        const base = {
          title: data.title || '',
          author: data.author || '',
          duration: Number(data.lengthSeconds) || 0,
          thumbnail: data.videoThumbnails?.[0]?.url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
        };
        const audios = (data.adaptiveFormats || []).filter((f) => String(f.type || '').startsWith('audio/'));
        const resolveUrl = (streamUrl) => (streamUrl.startsWith('http') ? streamUrl : `${inst}${streamUrl}`);
        const withResolvedUrl = (f) => (f?.url ? { ...f, url: resolveUrl(f.url) } : f);

        const bestAudio = withResolvedUrl(
          await firstPlayableFormat(audios.sort(byBitrateDesc).map(withResolvedUrl), null, { errors, videoId })
        );
        const progressive = withResolvedUrl(
          await firstPlayableFormat((data.formatStreams || []).sort(byBitrateDesc).map(withResolvedUrl), null, { errors, videoId })
        );

        if (audioOnly && bestAudio?.url) {
          return baseResult({
            ...base,
            kind: 'audio',
            media: [toMediaItem(bestAudio, 'audio', null, 'áudio')]
          });
        }
        if (progressive?.url) {
          return baseResult({
            ...base,
            kind: 'video',
            media: [toMediaItem(progressive, 'video', null)],
            audioOnly: bestAudio ? toMediaItem(bestAudio, 'audio', null, 'áudio') : null
          });
        }
        if (bestAudio?.url && !innertubeAudio) {
          innertubeAudio = toMediaItem(bestAudio, 'audio', null, 'áudio');
          innertubeBase = base;
        }
      }
    } catch (error) {
      errors.push(`invidious: ${String(error.message).slice(0, 60)}`);
    }
  }

  // 3) Cobalt (túnel comunitário — faz remux de vídeo/áudio ou baixa MP3)
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
        audioBuffer,
        cobaltTried: true
      });
    }
    errors.push('cobalt: sem buffer');
  } catch (error) {
    errors.push(`cobalt: ${String(error.message).slice(0, 60)}`);
  }

  // 4) Se o usuário pediu vídeo e o Cobalt falhou, mas temos a faixa de áudio do Innertube, entrega áudio
  if (innertubeAudio?.url) {
    log.dl('youtube: sem stream muxado — entregando a faixa de áudio');
    return baseResult({
      ...innertubeBase,
      kind: 'audio',
      media: [innertubeAudio],
      cobaltTried: true
    });
  }

  const error = new Error(
    `YouTube falhou em todas as estratégias: ${errors.join(' | ')}. ` +
      'O vídeo pode ser privado, com restrição de idade/região, ao vivo ou removido.'
  );
  error.cobaltTried = true;
  if (botWall) error.hint = YT_BOT_WALL_HINT;
  throw error;
}
