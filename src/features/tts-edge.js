// 🎙️ EDGE TTS — vozes neurais GRÁTIS, sem chave e sem cadastro.
//
// É o motor por trás do "Ler em voz alta" do Microsoft Edge. Não é uma API
// oficial da Microsoft (não tem SLA nem suporte): por isso o bot SEMPRE tem os
// provedores antigos como reserva — se este falhar, a voz ainda sai.
//
// Detalhes que importam para não quebrar no futuro:
//   1) A conexão é um WebSocket (o Node 22 tem WebSocket nativo — nenhuma
//      dependência npm foi adicionada por causa disso).
//   2) O handshake exige o token antiabuso `Sec-MS-GEC`: SHA-256 dos "ticks" do
//      Windows (epoch 1601) arredondados para baixo em blocos de 5 minutos,
//      concatenados com o token público do cliente Edge.
//   3) Se o relógio da máquina estiver fora de sincronia, o servidor devolve
//      403. Nesse caso lemos o cabeçalho `Date` do próprio serviço e refazemos a
//      tentativa com a diferença corrigida (é o mesmo truque do edge-tts).
//   4) O texto vai dentro de SSML — é isso que permite pedir voz, tom (pitch),
//      velocidade (rate) e volume sem precisar de FFmpeg.

import crypto from 'node:crypto';
import { fetchJson } from '../core/http.js';
import { log } from '../core/logger.js';

export const EDGE_TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
// Versão do Chromium usada apenas para casar com o token (o servidor confere o formato).
export const EDGE_CHROMIUM_VERSION = '143.0.3650.75';
export const EDGE_SEC_MS_GEC_VERSION = `1-${EDGE_CHROMIUM_VERSION}`;

const EDGE_ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold';
const EDGE_HOST = 'speech.platform.bing.com';
const EDGE_READALOUD = `${EDGE_HOST}/consumer/speech/synthesize/readaloud`;
export const EDGE_WSS_URL = `wss://${EDGE_READALOUD}/edge/v1?TrustedClientToken=${EDGE_TRUSTED_CLIENT_TOKEN}`;
export const EDGE_VOICE_LIST_URL = `https://${EDGE_READALOUD}/voices/list?trustedclienttoken=${EDGE_TRUSTED_CLIENT_TOKEN}`;

// 48 kbps é o formato que o serviço documenta em todos os exemplos; é também o
// que o WhatsApp reaproveita bem depois da conversão para Opus.
export const EDGE_OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

const WIN_EPOCH_SECONDS = 11_644_473_600; // 1601 → 1970
const TICKS_PER_SECOND = 10_000_000n;
const GEC_BLOCK_SECONDS = 300; // 5 minutos
const VOICE_CACHE_MS = 6 * 60 * 60_000;
const VOICE_CACHE_FAIL_MS = 5 * 60_000;
const WS_HEADERS = {
  origin: EDGE_ORIGIN,
  pragma: 'no-cache',
  'cache-control': 'no-cache',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    `Chrome/${EDGE_CHROMIUM_VERSION.split('.')[0]}.0.0.0 Safari/537.36 Edg/${EDGE_CHROMIUM_VERSION.split('.')[0]}.0.0.0`
};

/**
 * Lista de reserva: se o serviço não responder (offline, 403, bloqueio de rede),
 * o catálogo continua funcionando com estas vozes conhecidas.
 */
export const EDGE_FALLBACK_VOICES = Object.freeze([
  { ShortName: 'pt-BR-AntonioNeural', Locale: 'pt-BR', Gender: 'Male' },
  { ShortName: 'pt-BR-FranciscaNeural', Locale: 'pt-BR', Gender: 'Female' },
  { ShortName: 'pt-BR-ThalitaNeural', Locale: 'pt-BR', Gender: 'Female' },
  { ShortName: 'pt-BR-BrendaNeural', Locale: 'pt-BR', Gender: 'Female' },
  { ShortName: 'pt-BR-DonatoNeural', Locale: 'pt-BR', Gender: 'Male' },
  { ShortName: 'pt-BR-ElzaNeural', Locale: 'pt-BR', Gender: 'Female' },
  { ShortName: 'pt-BR-FabioNeural', Locale: 'pt-BR', Gender: 'Male' },
  { ShortName: 'pt-BR-GiovannaNeural', Locale: 'pt-BR', Gender: 'Female' },
  { ShortName: 'pt-BR-HumbertoNeural', Locale: 'pt-BR', Gender: 'Male' },
  { ShortName: 'pt-BR-JulioNeural', Locale: 'pt-BR', Gender: 'Male' },
  { ShortName: 'pt-BR-LeilaNeural', Locale: 'pt-BR', Gender: 'Female' },
  { ShortName: 'pt-BR-LeticiaNeural', Locale: 'pt-BR', Gender: 'Female' },
  { ShortName: 'pt-BR-ManuelaNeural', Locale: 'pt-BR', Gender: 'Female' },
  { ShortName: 'pt-BR-NicolauNeural', Locale: 'pt-BR', Gender: 'Male' },
  { ShortName: 'pt-BR-ValerioNeural', Locale: 'pt-BR', Gender: 'Male' },
  { ShortName: 'pt-BR-YaraNeural', Locale: 'pt-BR', Gender: 'Female' },
  { ShortName: 'en-US-EmmaMultilingualNeural', Locale: 'en-US', Gender: 'Female' },
  { ShortName: 'en-US-AvaMultilingualNeural', Locale: 'en-US', Gender: 'Female' },
  { ShortName: 'en-US-AndrewMultilingualNeural', Locale: 'en-US', Gender: 'Male' },
  { ShortName: 'en-US-BrianMultilingualNeural', Locale: 'en-US', Gender: 'Male' },
  { ShortName: 'en-US-AnaNeural', Locale: 'en-US', Gender: 'Female' },
  { ShortName: 'en-US-GuyNeural', Locale: 'en-US', Gender: 'Male' },
  { ShortName: 'en-US-JennyNeural', Locale: 'en-US', Gender: 'Female' },
  { ShortName: 'es-MX-JorgeNeural', Locale: 'es-MX', Gender: 'Male' },
  { ShortName: 'es-MX-DaliaNeural', Locale: 'es-MX', Gender: 'Female' }
]);

let clockSkewMs = 0;
let voiceCache = null; // { at, expiresAt, voices, source }

/** Relógio local + correção detectada (ms). Exposto para os testes. */
export function getClockSkewMs() {
  return clockSkewMs;
}

export function setClockSkewMs(ms) {
  clockSkewMs = Number.isFinite(ms) ? ms : 0;
  return clockSkewMs;
}

/**
 * O serviço só tem WebSocket nativo no Node 22+ (global `WebSocket`). Em versões
 * antigas a voz continua funcionando pelos provedores de reserva.
 */
export function isEdgeSupported() {
  return typeof globalThis.WebSocket === 'function';
}

/**
 * Token antiabuso `Sec-MS-GEC` (SHA-256, hexadecimal maiúsculo).
 * @param {number} nowMs instante em ms (padrão: agora)
 * @param {number} skewMs correção de relógio em ms
 */
export function secMsGec(nowMs = Date.now(), skewMs = clockSkewMs) {
  let seconds = Math.floor((Number(nowMs) + Number(skewMs)) / 1000) + WIN_EPOCH_SECONDS;
  seconds -= seconds % GEC_BLOCK_SECONDS;
  const ticks = BigInt(seconds) * TICKS_PER_SECOND;
  return crypto
    .createHash('sha256')
    .update(`${ticks}${EDGE_TRUSTED_CLIENT_TOKEN}`)
    .digest('hex')
    .toUpperCase();
}

/** URL completa do WebSocket (com ConnectionId novo e token do momento). */
export function edgeSocketUrl({ nowMs = Date.now(), skewMs = clockSkewMs, connectionId } = {}) {
  const id = connectionId || crypto.randomUUID().replace(/-/g, '');
  return (
    `${EDGE_WSS_URL}&ConnectionId=${id}` +
    `&Sec-MS-GEC=${secMsGec(nowMs, skewMs)}&Sec-MS-GEC-Version=${EDGE_SEC_MS_GEC_VERSION}`
  );
}

/** Data no formato que o serviço espera (o "GMT+0000 (…)" é exigência dele). */
export function edgeTimestamp(date = new Date()) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${days[date.getUTCDay()]} ${months[date.getUTCMonth()]} ${p(date.getUTCDate())} ${date.getUTCFullYear()} ` +
    `${p(date.getUTCHours())}:${p(date.getUTCMinutes())}:${p(date.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`
  );
}

function escapeXml(text) {
  return String(text).replace(/[<>&'"]/g, (char) => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    "'": '&apos;',
    '"': '&quot;'
  })[char]);
}

/** Caracteres de controle derrubam a síntese — trocados por espaço. */
function sanitizeText(text) {
  return String(text || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Monta o SSML (voz + prosódia). Exportado para os testes. */
export function buildEdgeSsml(text, { voice, pitch = '+0Hz', rate = '+0%', volume = '+0%', lang = 'pt-BR' } = {}) {
  return (
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${lang}'>` +
    `<voice name='${voice}'>` +
    `<prosody pitch='${pitch}' rate='${rate}' volume='${volume}'>` +
    escapeXml(sanitizeText(text)) +
    '</prosody></voice></speak>'
  );
}

/** Cabeçalho + corpo de um quadro de texto do protocolo. */
function textFrame(path, { requestId, timestamp, contentType, body }) {
  return (
    `X-RequestId:${requestId}\r\n` +
    `Content-Type:${contentType}\r\n` +
    `X-Timestamp:${timestamp}\r\n` +
    `Path:${path}\r\n\r\n` +
    `${body}`
  );
}

/**
 * Extrai o áudio de um quadro binário.
 *
 * Formato: 2 bytes big-endian com o tamanho do TEXTO do cabeçalho, depois o
 * texto (`Path:audio`, `Content-Type:`…) e por fim o MP3 — ou seja, o áudio
 * começa em `comprimento + 2`. Há um fallback por `\r\n\r\n` para o caso do
 * serviço mudar esse prefixo.
 */
export function parseEdgeAudioFrame(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 2) return { path: '', audio: Buffer.alloc(0) };
  const headerLength = buffer.readUInt16BE(0);
  let headers;
  let audio;
  if (headerLength > 0 && headerLength + 2 <= buffer.length) {
    headers = buffer.subarray(2, headerLength + 2).toString('latin1');
    audio = buffer.subarray(headerLength + 2);
  } else {
    const sep = buffer.indexOf('\r\n\r\n');
    headers = sep === -1 ? buffer.toString('latin1') : buffer.subarray(0, sep).toString('latin1');
    audio = sep === -1 ? Buffer.alloc(0) : buffer.subarray(sep + 4);
  }
  const path = /Path:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim() || '';
  return { path, audio };
}

/**
 * Uma síntese (um pedaço de texto) via WebSocket.
 * @returns {Promise<Buffer>} MP3
 */
export function edgeSynthesize(text, {
  voice,
  pitch = '+0Hz',
  rate = '+0%',
  volume = '+0%',
  lang = 'pt-BR',
  url,
  timeoutMs = 45_000
} = {}) {
  return new Promise((resolve, reject) => {
    if (!isEdgeSupported()) {
      reject(new Error('WebSocket nativo indisponível (precisa de Node 22+)'));
      return;
    }
    if (!voice) {
      reject(new Error('voz do Edge não informada'));
      return;
    }

    let socket;
    try {
      socket = new WebSocket(url || edgeSocketUrl(), { headers: WS_HEADERS });
    } catch (error) {
      // Alguns runtimes aceitam o construtor mas não o objeto de opções.
      try {
        socket = new WebSocket(url || edgeSocketUrl());
      } catch (inner) {
        reject(new Error(`não foi possível abrir o WebSocket: ${inner?.message || error?.message}`));
        return;
      }
    }
    if ('binaryType' in socket) socket.binaryType = 'arraybuffer';

    const chunks = [];
    let settled = false;
    let sawTurnEnd = false;

    const finish = (error, buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {}
      if (error) reject(error);
      else resolve(buffer);
    };

    const timer = setTimeout(() => finish(new Error('o serviço de voz não respondeu a tempo')), timeoutMs);

    socket.addEventListener('open', () => {
      try {
        const timestamp = edgeTimestamp();
        const requestId = crypto.randomUUID().replace(/-/g, '');
        socket.send(
          textFrame('speech.config', {
            requestId,
            timestamp,
            contentType: 'application/json; charset=utf-8',
            body:
              '{"context":{"synthesis":{"audio":{"metadataoptions":' +
              '{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},' +
              `"outputFormat":"${EDGE_OUTPUT_FORMAT}"}}}}\r\n`
          })
        );
        // O "Z" no fim do X-Timestamp do SSML não é erro nosso: é bug conhecido
        // do próprio Edge (o edge-tts faz igual).
        socket.send(
          textFrame('ssml', {
            requestId,
            timestamp: `${timestamp}Z`,
            contentType: 'application/ssml+xml',
            body: buildEdgeSsml(text, { voice, pitch, rate, volume, lang })
          })
        );
      } catch (error) {
        finish(error);
      }
    });

    socket.addEventListener('message', (event) => {
      const data = event?.data;
      if (typeof data === 'string') {
        if (data.includes('Path:turn.end')) {
          sawTurnEnd = true;
          if (!chunks.length) finish(new Error('o serviço encerrou sem enviar áudio'));
          else finish(null, Buffer.concat(chunks));
        }
        return;
      }
      if (!data) return;
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const { path, audio } = parseEdgeAudioFrame(buffer);
      if (path.toLowerCase().startsWith('audio') && audio.length) chunks.push(audio);
    });

    socket.addEventListener('error', () => {
      if (!settled && !sawTurnEnd) finish(new Error('falha de conexão com o serviço de voz'));
    });

    socket.addEventListener('close', (event) => {
      if (settled) return;
      if (chunks.length) finish(null, Buffer.concat(chunks));
      else finish(new Error(`conexão de voz encerrada sem áudio${event?.code ? ` (código ${event.code})` : ''}`));
    });
  });
}

/**
 * Lê o `Date` do serviço para descobrir se o relógio local está adiantado ou
 * atrasado. É o que explica (e conserta) os 403 "Invalid response status".
 */
export async function refreshClockSkew({ timeoutMs = 8_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(EDGE_VOICE_LIST_URL, {
      method: 'HEAD',
      headers: { 'user-agent': WS_HEADERS['user-agent'] },
      signal: controller.signal
    });
    const serverDate = res.headers.get('date');
    if (!serverDate) return null;
    const parsed = Date.parse(serverDate);
    if (!Number.isFinite(parsed)) return null;
    const skew = parsed - Date.now();
    if (Math.abs(skew) > 30_000) {
      log.warn(`voz · relógio do sistema fora de sincronia em ${Math.round(skew / 1000)}s — corrigindo o token`);
      clockSkewMs = skew;
    }
    return skew;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sintetiza um texto com o Edge, fatiando pedaços grandes e refazendo a
 * tentativa com o relógio corrigido quando o serviço recusa (403).
 * @returns {Promise<Buffer>} MP3 (pode ser a concatenação de vários pedaços)
 */
export async function edgeTts(text, options = {}) {
  const {
    voice,
    pitch = '+0Hz',
    rate = '+0%',
    volume = '+0%',
    lang = 'pt-BR',
    maxChunkChars = 1_200,
    timeoutMs = 45_000,
    split,
    attempts = 2
  } = options;

  const clean = sanitizeText(text);
  if (!clean) throw new Error('texto vazio para a voz');
  const pieces = split ? split(clean, maxChunkChars) : [clean];
  const parts = [];
  for (const piece of pieces) {
    let buffer = null;
    let lastError = null;
    for (let attempt = 0; attempt < attempts && !buffer; attempt++) {
      try {
        buffer = await edgeSynthesize(piece, { ...options, voice, pitch, rate, volume, lang, timeoutMs });
      } catch (error) {
        lastError = error;
        if (attempt === 0) {
          // Recusa do serviço costuma ser relógio fora de sincronia: mede o
          // relógio no próprio serviço e tenta de novo já corrigido. Se nem
          // isso responder, não insiste — o bot cai para o próximo provedor.
          const skew = await refreshClockSkew();
          if (skew === null) break;
        }
      }
    }
    if (!buffer) throw lastError || new Error('falha ao gerar a voz');
    parts.push(buffer);
  }
  return Buffer.concat(parts);
}

// ── Catálogo de vozes do serviço ─────────────────────────────
/**
 * Lista as vozes disponíveis (com cache de 6h). Se a rede falhar, devolve a
 * lista de reserva — o catálogo do bot nunca fica vazio.
 */
export async function edgeVoices({ force = false, timeoutMs = 15_000 } = {}) {
  const now = Date.now();
  if (!force && voiceCache && voiceCache.expiresAt > now) return voiceCache.voices;
  try {
    const data = await fetchJson(EDGE_VOICE_LIST_URL, {
      timeoutMs,
      maxBytes: 4 * 1024 * 1024,
      headers: { 'user-agent': WS_HEADERS['user-agent'], accept: 'application/json' }
    });
    const voices = (Array.isArray(data) ? data : [])
      .map((entry) => ({
        shortName: String(entry?.ShortName || entry?.shortName || '').trim(),
        locale: String(entry?.Locale || entry?.locale || '').trim(),
        gender: String(entry?.Gender || entry?.gender || '').trim(),
        personalities: Array.isArray(entry?.VoiceTag?.VoicePersonalities) ? entry.VoiceTag.VoicePersonalities : []
      }))
      .filter((entry) => entry.shortName);
    if (!voices.length) throw new Error('lista de vozes vazia');
    voiceCache = { at: now, expiresAt: now + VOICE_CACHE_MS, voices, source: 'servico' };
    return voices;
  } catch (error) {
    log.warn(`voz · não foi possível listar as vozes do Edge (${error?.message}) — usando a lista local`);
    voiceCache = { at: now, expiresAt: now + VOICE_CACHE_FAIL_MS, voices: EDGE_FALLBACK_VOICES.map(normalizeFallback), source: 'local' };
    return voiceCache.voices;
  }
}

function normalizeFallback(entry) {
  return { shortName: entry.ShortName, locale: entry.Locale, gender: entry.Gender, personalities: [] };
}

/** Situação do motor para `.pools` / `.info`. */
export function edgeStatus() {
  if (!isEdgeSupported()) return { ok: false, detail: 'Node 22+ necessário para o WebSocket nativo' };
  if (voiceCache?.source === 'local') return { ok: true, detail: `offline no momento · ${voiceCache.voices.length} vozes locais` };
  return { ok: true, detail: `grátis, sem chave · ${voiceCache ? `${voiceCache.voices.length} vozes` : 'lista sob demanda'}` };
}

/** Só para os testes: limpa cache e correção de relógio. */
export function resetEdgeStateForTests() {
  voiceCache = null;
  clockSkewMs = 0;
}
