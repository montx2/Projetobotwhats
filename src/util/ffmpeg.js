// FFmpeg: detecção e conversão para figurinhas (WebP 512x512).
// Sem dependência npm — chama o binário do sistema (Termux/Linux/Windows).

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { isWebp, isAnimatedWebp } from './webp.js';
import { gradeImageSamples } from './imageinfo.js';
import {
  analyzeSource,
  framesForQualityFloor,
  planSticker,
  predictQuality,
  shrinkSchedule,
  GOOD_FIT_RATIO,
  QUALITY_FLOOR
} from './stickerbrain.js';

let ffmpegPath = null;

export function findFfmpeg() {
  if (ffmpegPath !== null) return ffmpegPath;
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const candidates = [
    exe,
    path.join(process.cwd(), 'bin', exe),
    // Termux coloca os binários em $PREFIX/bin
    process.env.PREFIX ? path.join(process.env.PREFIX, 'bin', exe) : null,
    '/data/data/com.termux/files/usr/bin/ffmpeg'
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      const probe = spawnSync(c, ['-version'], { timeout: 5000 });
      if (probe.status === 0) {
        ffmpegPath = c;
        return c;
      }
    } catch {}
  }
  ffmpegPath = false;
  return false;
}

export function hasFfmpeg() {
  return !!findFfmpeg();
}

function runFfmpeg(args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const bin = findFfmpeg();
    if (!bin) {
      return reject(
        new Error('FFmpeg não encontrado. Instale com: pkg install ffmpeg (Termux) / apt install ffmpeg / winget install ffmpeg')
      );
    }
    const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg saiu com código ${code}: ${stderr.slice(-300)}`));
    });
  });
}

/** Igual ao runFfmpeg, mas devolve o stdout (usado para ler frames crus). */
function runFfmpegCapture(args, { timeoutMs = 60_000, maxBytes = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const bin = findFfmpeg();
    if (!bin) return reject(new Error('FFmpeg não encontrado'));
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let total = 0;
    let stderr = '';
    const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
    proc.stdout.on('data', (d) => {
      total += d.length;
      if (total <= maxBytes) chunks.push(d);
      else proc.kill('SIGKILL');
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg saiu com código ${code}: ${stderr.slice(-300)}`));
    });
  });
}

function tmpFile(ext) {
  const cleanExt = String(ext || '.bin').startsWith('.') ? ext : `.${ext}`;
  return path.join(os.tmpdir(), `nexus-${crypto.randomBytes(6).toString('hex')}${cleanExt}`);
}

/**
 * Converte qualquer áudio em OGG/Opus mono 48 kHz — o formato que o WhatsApp
 * espera em mensagem de voz (ptt). Enviar MP3 como ptt costuma gerar um áudio
 * que não toca em alguns aparelhos.
 * @param {Buffer} input áudio original (mp3, wav, ogg…)
 * @returns {Promise<Buffer>} áudio em ogg/opus
 */
export async function toVoiceOpus(input) {
  const inFile = tmpFile('.audio');
  const outFile = tmpFile('.ogg');
  fs.writeFileSync(inFile, input);
  try {
    await runFfmpeg([
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', inFile,
      '-vn', '-ac', '1', '-ar', '48000',
      '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip',
      '-f', 'ogg', outFile
    ], { timeoutMs: 90_000 });
    const buf = fs.readFileSync(outFile);
    if (!buf.length) throw new Error('ffmpeg não gerou áudio');
    return buf;
  } finally {
    fs.rmSync(inFile, { force: true });
    fs.rmSync(outFile, { force: true });
  }
}

/**
 * Aplica uma cadeia de filtros de áudio (tom da voz, eco, recorte…).
 * Sem FFmpeg não é erro fatal: devolve `null` e quem chamou segue sem efeito.
 *
 * @param {Buffer} input áudio original (mp3, ogg, wav…)
 * @param {{filter: string, ext?: string, bitrate?: string, timeoutMs?: number}} opts
 * @returns {Promise<Buffer|null>} áudio filtrado, ou null quando não deu
 */
export async function applyAudioFilter(input, { filter, ext = '.mp3', bitrate = '96k', timeoutMs = 90_000 } = {}) {
  if (!hasFfmpeg() || !filter) return null;
  const inFile = tmpFile('.audio-in');
  const outFile = tmpFile(ext);
  fs.writeFileSync(inFile, input);
  try {
    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', inFile, '-vn', '-af', filter];
    if (ext === '.mp3') args.push('-c:a', 'libmp3lame', '-b:a', bitrate, '-ar', '44100');
    else if (ext === '.ogg') args.push('-c:a', 'libopus', '-b:a', bitrate);
    args.push(outFile);
    await runFfmpeg(args, { timeoutMs });
    const buf = fs.readFileSync(outFile);
    if (!buf.length) throw new Error('ffmpeg não gerou áudio');
    return buf;
  } catch (error) {
    console.warn(`[ffmpeg] efeito de voz falhou (${String(error?.message || error).slice(0, 160)})`);
    return null;
  } finally {
    fs.rmSync(inFile, { force: true });
    fs.rmSync(outFile, { force: true });
  }
}

/**
 * Aumenta a imagem (e dá uma leve nitidez) para quem pediu `--hd` no .criar.
 * Melhora a leitura no celular sem depender das APIs de upscale por IA.
 *
 * @param {Buffer} input imagem original
 * @param {{factor?: number, maxSide?: number, quality?: number}} opts
 * @returns {Promise<Buffer|null>} PNG/JPEG ampliado, ou null quando não deu
 */
export async function upscaleImage(input, { factor = 2, maxSide = 3072, quality = 92 } = {}) {
  if (!hasFfmpeg()) return null;
  const realExt = detectMediaExt(input, '.jpg');
  const inFile = tmpFile(realExt);
  const outFile = tmpFile('.jpg');
  fs.writeFileSync(inFile, input);
  try {
    // `scale` com lado máximo evita estourar memória no celular (Termux).
    const filter =
      `scale=iw*${factor}:ih*${factor}:flags=lanczos,` +
      `scale='min(iw,${maxSide})':'min(ih,${maxSide})':flags=lanczos,` +
      'unsharp=5:5:0.7:5:5:0.0';
    await runFfmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-i', inFile, '-vf', filter, '-frames:v', '1',
      '-q:v', String(Math.max(2, Math.min(8, Math.round((100 - quality) / 12 + 2)))), outFile], { timeoutMs: 90_000 });
    const buf = fs.readFileSync(outFile);
    if (!buf.length) throw new Error('ffmpeg não gerou imagem');
    return buf.length > input.length * 8 ? null : buf; // resultado absurdo = descarta
  } catch (error) {
    console.warn(`[ffmpeg] upscale falhou (${String(error?.message || error).slice(0, 160)})`);
    return null;
  } finally {
    fs.rmSync(inFile, { force: true });
    fs.rmSync(outFile, { force: true });
  }
}

/** Detecta a extensão real pelo cabeçalho binário (magic bytes). */
export function detectMediaExt(buf, fallback = '.jpg') {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return fallback;
  if (isWebp(buf)) return '.webp';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf.toString('ascii', 0, 4) === 'GIF8') return '.gif';
  if (buf.length > 12 && buf.toString('ascii', 4, 8) === 'ftyp') return '.mp4';
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return '.webm';
  return fallback.startsWith('.') ? fallback : `.${fallback}`;
}

/**
 * Mimetype de áudio pelo cabeçalho binário.
 * Sem FFmpeg o `.voz` manda o arquivo como veio (o espeak, por exemplo, gera
 * WAV): anunciar o mimetype certo evita áudio que "não toca" no celular.
 */
export function detectAudioMime(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return 'audio/mpeg';
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'audio/webm';
  const head4 = buf.toString('latin1', 0, 4);
  if (head4 === 'RIFF' && buf.toString('latin1', 8, 12) === 'WAVE') return 'audio/wav';
  if (head4 === 'OggS') return 'audio/ogg; codecs=opus';
  if (head4 === 'fLaC') return 'audio/flac';
  if (buf.length >= 8 && buf.toString('latin1', 4, 8) === 'ftyp') return 'audio/mp4';
  const head3 = buf.toString('latin1', 0, 3);
  if (head3 === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  return 'audio/mpeg';
}

/**
 * Modos de enquadramento da figurinha (sempre sai 512x512):
 *  - 'fill'  (padrão): preenche TODO o quadrado, esticando se preciso (sem bordas vazias)
 *  - 'contain'       : imagem inteira, proporção original, com margem transparente
 *  - 'cover'         : preenche o quadrado SEM esticar, cortando o excesso (centralizado)
 */
export const STICKER_FITS = ['fill', 'contain', 'cover'];

/**
 * Limites oficiais da figurinha do WhatsApp (WhatsApp/stickers · Meta):
 *  - 512×512, WebP com transparência;
 *  - estática: até 100 KB;
 *  - animada: até 500 KB e 10 segundos de animação (quadros de no mínimo 8 ms).
 *
 * O teto interno de bytes sai um pouco menor que a spec para o arquivo final
 * continuar dentro do limite depois de receber VP8X + EXIF (pack/autor/emojis).
 */
export const STICKER_MAX_SECONDS = 10;
export const STICKER_ANIMATED_SPEC_BYTES = 500 * 1024;
export const STICKER_STATIC_MAX_BYTES = 100 * 1024;
export const STICKER_ANIMATED_MAX_BYTES = 480 * 1024;

/** Cor do fundo detectado em `rrggbb` (formato do colorkey do FFmpeg). */
export function cutHex(cut) {
  return [cut.color.r, cut.color.g, cut.color.b]
    .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
    .join('');
}

export function buildStickerFilter({ animated, fps = 15, simple = false, fit = 'fill', crop = null, select = null, cut = null }) {
  const flags = simple ? '' : `:flags=${animated ? 'bicubic' : 'lanczos'}`;
  const parts = [];
  if (animated) parts.push(`fps=${fps}`);
  if (select) parts.push(`select=${select}`);
  // O crop inteligente entra ANTES da escala: ele enquadra o assunto no
  // material original, então a escala 512×512 não distorce nada.
  if (crop) parts.push(`crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`);
  parts.push('format=rgba');
  // Fundo liso detectado na análise: vira transparência por chave de cor,
  // antes da escala (o alfa é suavizado junto com a imagem).
  if (cut) parts.push(`colorkey=0x${cutHex(cut)}:${cut.similarity}:0.1`);
  if (fit === 'contain') {
    parts.push(`scale=512:512:force_original_aspect_ratio=decrease${flags}`);
    parts.push('pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000');
  } else if (fit === 'cover') {
    parts.push(`scale=512:512:force_original_aspect_ratio=increase${flags}`);
    parts.push('crop=512:512');
  } else {
    parts.push(`scale=512:512:force_original_aspect_ratio=disable${flags}`);
  }
  parts.push('setsar=1');
  return parts.join(',');
}

/**
 * Expressão `select` do FFmpeg para manter um conjunto de quadros.
 *
 * Os índices são relativos ao começo do trecho recortado; quadros consecutivos
 * viram uma faixa (`between`) para a expressão ficar curta mesmo guardando 150
 * quadros. Vírgulas vão escapadas porque separam filtros dentro do filtergraph.
 *
 * @param {number[]} indexes índices a manter (0 = primeiro quadro do trecho)
 * @returns {string} ex.: "between(n\,0\,9)+eq(n\,20)"
 */
export function selectExpression(indexes) {
  const sorted = [...new Set((indexes || []).map((n) => Math.max(0, Math.round(n))))].sort((a, b) => a - b);
  const ranges = [];
  for (const n of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else ranges.push([n, n]);
  }
  return ranges
    .map(([a, b]) => (a === b ? `eq(n\\,${a})` : `between(n\\,${a}\\,${b})`))
    .join('+');
}

async function encodeStep(inFile, outFile, { animated, q, fps = 15, dur = STICKER_MAX_SECONDS, fit = 'fill', level = 4 }) {
  const buildArgs = ({ simpleFilter = false, omitVsync = false } = {}) => {
    const vf = buildStickerFilter({ animated, fps, simple: simpleFilter, fit });
    const args = ['-y'];
    if (animated) args.push('-t', String(dur));
    args.push(
      '-i',
      inFile,
      '-vf',
      vf,
      '-an',
      '-sn',
      '-c:v',
      'libwebp',
      '-lossless',
      '0',
      '-q:v',
      String(q),
      '-compression_level',
      String(level),
      '-preset',
      'default'
    );
    if (animated) {
      args.push('-loop', '0');
      if (!omitVsync) args.push('-vsync', '0');
    } else {
      args.push('-frames:v', '1');
    }
    args.push('-f', 'webp', outFile);
    return args;
  };

  try {
    await runFfmpeg(buildArgs({ simpleFilter: false, omitVsync: false }));
  } catch {
    await runFfmpeg(buildArgs({ simpleFilter: true, omitVsync: true }));
  }
}

/**
 * Encoda UM passo do plano inteligente: recorta o trecho escolhido, mantém só
 * os quadros selecionados (com os timestamps originais, o que dá durações
 * variáveis por quadro) e aplica o crop do assunto antes da escala 512×512.
 */
async function encodePlanned(inFile, outFile, { plan, q, keep, fit = 'fill', animated = true, level = 5 }) {
  const select = keep?.length ? selectExpression(keep) : null;
  const vf = buildStickerFilter({ animated, fps: plan.fps, fit, crop: plan.crop, select, cut: plan.cut });
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  if (animated) {
    if (plan.startMs > 0) args.push('-ss', (plan.startMs / 1000).toFixed(3));
    args.push('-t', (plan.durationMs / 1000).toFixed(3));
  } else if (plan.stillMs > 0) {
    args.push('-ss', (plan.stillMs / 1000).toFixed(3));
  }
  args.push('-i', inFile, '-an', '-sn', '-vf', vf, '-c:v', 'libwebp', '-lossless', '0', '-q:v', String(q),
    '-compression_level', String(level), '-preset', 'default');
  if (animated) args.push('-loop', '0', '-vsync', '0');
  else args.push('-frames:v', '1');
  args.push('-f', 'webp', outFile);
  await runFfmpeg(args, { timeoutMs: 180_000 });
  if (!fs.existsSync(outFile)) throw new Error('ffmpeg não gerou saída');
  const buf = fs.readFileSync(outFile);
  if (!buf.length || !isWebp(buf)) throw new Error('ffmpeg gerou um WebP inválido');
  return buf;
}

/**
 * TRAVA FINAL DA SPEC: nenhuma figurinha pode sair acima do limite do WhatsApp.
 *
 * O motor gasta o orçamento com previsão e a escada clássica encurta a duração;
 * mesmo assim, conteúdo incompressível (ruído de TV, Mandelbrot, areia, chuva)
 * pode não caber em 500 KB nem no piso de qualidade. Aí esta escada aperta o que
 * sobrou — mais compressão, menos quadros, qualidade menor — e só no fim encurta
 * a duração, seguindo a prioridade da casa. Melhor uma figurinha simples do que
 * uma que o WhatsApp recusa.
 */
async function enforceStickerLimit(inFile, outFile, { animated, fit, wanted, maxBytes, onProgress }) {
  const rungs = animated
    ? [
        { q: 20, fps: 6, dur: wanted, level: 6 },
        { q: 14, fps: 5, dur: wanted, level: 6 },
        { q: 10, fps: 4, dur: Math.min(wanted, 6), level: 6 },
        { q: 8, fps: 3, dur: Math.min(wanted, 4), level: 6 },
        { q: 6, fps: 3, dur: Math.min(wanted, 2.5), level: 6 },
        { q: 5, fps: 2, dur: Math.min(wanted, 2), level: 6 }
      ]
    : [
        { q: 12, fps: 1, dur: 1, level: 6 },
        { q: 8, fps: 1, dur: 1, level: 6 },
        { q: 5, fps: 1, dur: 1, level: 6 }
      ];
  let smallest = null;
  for (let i = 0; i < rungs.length; i++) {
    if (onProgress && i > 0) {
      await onProgress(`🗜️ Conteúdo pesado — apertando mais (${i + 1}/${rungs.length})…`);
    }
    try {
      await encodeStep(inFile, outFile, { animated, fit, ...rungs[i] });
    } catch {
      continue;
    }
    if (!fs.existsSync(outFile)) continue;
    const buf = fs.readFileSync(outFile);
    if (!buf.length || !isWebp(buf)) continue;
    if (!smallest || buf.length < smallest.length) smallest = buf;
    if (buf.length <= maxBytes) return buf;
  }
  return smallest;
}

/**
 * MOTOR INTELIGENTE: analisa o vídeo em quadros minúsculos, escolhe o melhor
 * trecho de até 10 s, fecha o loop, enquadra o assunto e só então encoda —
 * gastando o orçamento de 500 KB em quadros e qualidade com previsão, não com
 * uma escada fixa. Vídeo sem movimento vira figurinha parada.
 *
 * @returns {Promise<{buffer: Buffer, animated: boolean, smart: object}|null>} null quando não deu (aí a escada padrão assume)
 */
export async function smartStickerWebp(inFile, outFile, { fit = 'fill', maxSeconds = STICKER_MAX_SECONDS, onProgress, autoCrop = true, prefer = 'auto' } = {}) {
  const bin = findFfmpeg();
  if (!bin) return null;

  const analysisStart = Date.now();
  await onProgress?.(`🧠 Analisando a mídia (movimento, assunto e fundo)…`);
  const analysis = await analyzeSource(inFile, { ffmpegBin: bin });
  if (!analysis) return null;
  const analysisMs = Date.now() - analysisStart;

  let plan = planSticker(analysis, {
    maxSeconds,
    budgetBytes: STICKER_ANIMATED_MAX_BYTES,
    autoCrop,
    prefer
  });
  if (!plan) return null;
  // Rede de segurança: se o recorte não couber no quadro real (rotação/SAR
  // exóticos, metadados mentirosos), refaz o plano sem ele em vez de perder o
  // motor inteiro. O importantíssimo é entregar a figurinha.
  const withoutCut = () => {
    if (!plan.cut) return null;
    plan = { ...plan, cut: null };
    return plan;
  };
  const withoutCrop = () => {
    if (!plan.crop) return null;
    plan = planSticker(analysis, {
      maxSeconds,
      budgetBytes: STICKER_ANIMATED_MAX_BYTES,
      autoCrop: false,
      autoCut: Boolean(plan.cut),
      prefer
    });
    if (plan) plan.crop = null;
    return plan;
  };

  const report = {
    mode: plan.mode,
    startSeconds: Number((plan.startMs / 1000).toFixed(2)),
    durationSeconds: Number((plan.durationMs / 1000).toFixed(2)),
    targetFps: plan.targetFps,
    frames: plan.frames,
    crop: plan.crop ? `${plan.crop.w}x${plan.crop.h}+${plan.crop.x}+${plan.crop.y}` : null,
    cut: plan.cut ? `fundo liso 0x${cutHex(plan.cut)} · ${Math.round(plan.cut.coverage * 100)}% do quadro` : null,
    qualityFloor: plan.qualityFloor,
    prefer: plan.prefer,
    cutState: plan.cutState ?? (plan.cut ? 'flat' : 'off'),
    activity: plan.activity
      ? {
          x: Number((plan.activity.cx - plan.activity.w / 2).toFixed(2)),
          y: Number((plan.activity.cy - plan.activity.h / 2).toFixed(2)),
          w: Number(plan.activity.w.toFixed(2)),
          h: Number(plan.activity.h.toFixed(2))
        }
      : null,
    reason: plan.reason,
    probes: 0,
    tries: [],
    q: null,
    bytes: 0,
    analysisMs
  };

  // Se o filtro falhar, degrada em ordem de importância: larga o corte de fundo
  // (a figurinha sai inteira, com fundo) antes de largar o enquadramento.
  const degrade = () => {
    if (withoutCut()) {
      report.cutDropped = true;
      report.cut = null;
      return plan;
    }
    if (withoutCrop()) {
      report.cropDropped = true;
      report.crop = null;
      return plan;
    }
    return null;
  };

  // ── Vídeo sem movimento: figurinha parada em alta qualidade ─────────────
  if (plan.mode === 'static') {
    report.stillSeconds = Number((plan.stillMs / 1000).toFixed(2));
    await onProgress?.(`🧠 ${plan.reason} — montando a melhor foto…`);
    let best = null;
    let first = true;
    for (const step of [{ q: 82 }, { q: 68 }, { q: 52 }, { q: 36 }, { q: 22 }]) {
      let buf;
      try {
        buf = await encodePlanned(inFile, outFile, { plan, q: step.q, keep: null, fit, animated: false });
      } catch (error) {
        if (first && degrade()) {
          buf = await encodePlanned(inFile, outFile, { plan, q: step.q, keep: null, fit, animated: false });
        } else {
          throw error;
        }
      }
      first = false;
      report.probes++;
      if (!best || buf.length < best.length) best = { buf, q: step.q };
      if (buf.length <= STICKER_STATIC_MAX_BYTES) {
        best = { buf, q: step.q };
        break;
      }
    }
    report.q = best.q;
    report.bytes = best.buf.length;
    return { buffer: best.buf, animated: false, smart: report };
  }

  // ── Animada: muitos quadros onde há ação, qualidade aceitável ───────────
  // A figurinha é exibida pequena, então fluidez vale mais que qualidade fina.
  // O plano já distribui os quadros por movimento (ação em 15 fps, trecho
  // parado com quadros longos); o orçamento decide QUANTOS quadros cabem e a
  // qualidade se ajusta em volta disso. O tamanho por quadro é praticamente o
  // mesmo quando se cortam quadros, então uma sonda serve para prever o resto.
  const budget = STICKER_ANIMATED_MAX_BYTES;
  const minFrames = plan.minFrames;
  const seconds = Math.max(0.1, plan.durationMs / 1000);
  const samples = []; // {q, bytesPerFrame} — normalizado, vale para qualquer nº de quadros
  let best = null;

  const probe = async (qTry, keepList) => {
    report.probes++;
    if (report.probes > 1) {
      await onProgress?.(
        `🎯 Ajustando a figurinha (${keepList.length} quadros · tentativa ${report.probes})…`
      );
    }
    const buf = await encodePlanned(inFile, outFile, { plan, q: qTry, keep: keepList, fit, animated: true });
    samples.push({ q: qTry, bytesPerFrame: buf.length / keepList.length });
    report.tries.push({ q: qTry, frames: keepList.length, kb: Math.round(buf.length / 1024) });
    if (!best || buf.length < best.buf.length) best = { buf, q: qTry, keep: keepList };
    return buf;
  };

  const startQ = Math.max(8, Math.min(82, Math.round(plan.qStart ?? 45)));
  // Equilíbrio automático: vídeo com muita ação aceita qualidade menor em troca
  // de mais quadros; vídeo calmo prefere nitidez (piso alto).
  const qualityFloor = Math.max(QUALITY_FLOOR, Math.min(82, plan.qualityFloor ?? QUALITY_FLOOR));
  const maxFrames = plan.schedule.length;
  // Qualidade que faria `keep.length` quadros chegarem perto do orçamento.
  const measure = () =>
    predictQuality(samples, (budget * 0.95) / keep.length, {
      minQ: qualityFloor,
      maxQ: 82,
      sizeKey: 'bytesPerFrame'
    });

  let keep = plan.schedule;
  let q = startQ;
  let buf;
  try {
    buf = await probe(q, keep);
  } catch (error) {
    if (!degrade()) throw error;
    keep = plan.schedule;
    buf = await probe(q, keep);
  }

  if (buf.length > budget) {
    // Quantos quadros o orçamento compra no piso de qualidade?
    const fits = framesForQualityFloor({
      frames: keep.length,
      bytes: buf.length,
      q,
      floor: qualityFloor,
      budgetBytes: budget,
      minFrames
    });
    if (fits < keep.length) keep = shrinkSchedule(plan, fits);
    const predicted = Math.max(qualityFloor, measure());
    if (predicted !== q) {
      q = predicted;
      buf = await probe(q, keep);
    }
  }

  if (buf.length > budget) {
    // Ainda estourou: corta quadros na proporção do excesso, no piso, e mede.
    const fits = Math.floor(keep.length * 0.9 * (budget / buf.length));
    if (fits < keep.length) {
      keep = shrinkSchedule(plan, Math.max(minFrames, fits));
      if (qualityFloor !== q) q = qualityFloor;
      buf = await probe(q, keep);
    }
  } else if (buf.length < budget * GOOD_FIT_RATIO && keep.length >= maxFrames) {
    // Cabe mais qualidade: sobe o q até perto do orçamento.
    const predicted = predictQuality(samples, (budget * 0.95) / keep.length, {
      minQ: q + 2,
      maxQ: 82,
      sizeKey: 'bytesPerFrame'
    });
    if (predicted > q) {
      const buf2 = await probe(predicted, keep);
      if (buf2.length <= budget && buf2.length > buf.length) {
        buf = buf2;
        q = predicted;
      }
    }
  }

  // Se nada coube no orçamento, entrega o menor arquivo que o FFmpeg produziu.
  const finalBuf = buf.length <= budget ? buf : best.buf;
  const finalQ = buf.length <= budget ? q : best.q;
  const keepCount = (buf.length <= budget ? keep : best.keep).length;

  report.q = finalQ;
  report.bytes = finalBuf.length;
  report.framesKept = keepCount;
  report.effectiveFps = Number((keepCount / seconds).toFixed(1));
  return { buffer: finalBuf, animated: isAnimatedWebp(finalBuf), smart: report };
}

/**
 * Extrai um quadro do vídeo como PNG — é o que vai para a remoção de fundo por
 * IA. Reduz para no máximo 1200 px no lado maior: sobra resolução para a
 * figurinha 512 e a chamada de rede fica leve.
 *
 * @returns {Promise<Buffer|null>}
 */
export async function stillFramePng(input, { seconds = 0, ext = '.mp4' } = {}) {
  const bin = findFfmpeg();
  if (!bin) return null;
  const inFile = tmpFile(detectMediaExt(input, ext));
  const outFile = tmpFile('.png');
  fs.writeFileSync(inFile, input);
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  if (seconds > 0) args.push('-ss', seconds.toFixed(2));
  args.push(
    '-i', inFile,
    '-frames:v', '1',
    '-vf', "scale='min(1200,iw)':'min(1200,ih)':force_original_aspect_ratio=decrease",
    outFile
  );
  try {
    await runFfmpeg(args, { timeoutMs: 60_000 });
  } catch {
    return null;
  }
  return fs.existsSync(outFile) ? fs.readFileSync(outFile) : null;
}

/**
 * Fração de pixels visíveis (alfa > 40) de uma imagem, medida em 64×64.
 * Serve para checar o que a IA devolveu: recorte vazio (0) ou fundo intacto (1)
 * são resultados inúteis — melhor ficar com a figurinha original.
 *
 * @returns {Promise<number|null>} 0..1
 */
export async function alphaCoverage(input, { ext = '.png' } = {}) {
  const bin = findFfmpeg();
  if (!bin) return null;
  const inFile = tmpFile(detectMediaExt(input, ext));
  fs.writeFileSync(inFile, input);
  let raw;
  try {
    raw = await runFfmpegCapture([
      '-v', 'error',
      '-i', inFile,
      '-frames:v', '1',
      '-vf', 'scale=64:64:force_original_aspect_ratio=disable:flags=area,format=rgba',
      '-pix_fmt', 'rgba',
      '-f', 'rawvideo',
      '-'
    ]);
  } catch {
    return null;
  }
  const pixels = Math.floor(raw.length / 4);
  if (!pixels) return null;
  let visible = 0;
  for (let i = 0; i < pixels; i++) if (raw[i * 4 + 3] > 40) visible++;
  return visible / pixels;
}

/**
 * Padroniza a duração da figurinha animada dentro do limite do WhatsApp.
 * Aceita 1 s…10 s; valor ausente/inválido vira o teto (10 s).
 */
export function stickerSeconds(maxSeconds = STICKER_MAX_SECONDS) {
  const n = Number(maxSeconds);
  if (!Number.isFinite(n) || n <= 0) return STICKER_MAX_SECONDS;
  return Math.max(1, Math.min(STICKER_MAX_SECONDS, n));
}

/**
 * Escada adaptativa de FPS/qualidade/duração da figurinha animada.
 *
 * A ORDEM protege o que o WhatsApp permite de melhor: a duração cheia (até 10 s)
 * é a última coisa a cair. Primeiro caem o FPS e a qualidade, mantendo os 10 s
 * inteiros; só se nem o FPS mínimo couber no teto de 500 KB a animação é
 * encurtada (8 s, 6 s, 5 s, 4 s, 3 s), mantendo compressão forte.
 *
 * @returns {Array<{fps: number, q: number, level: number, dur: number}>}
 */
export function animatedStickerSteps(maxSeconds = STICKER_MAX_SECONDS) {
  const dur = stickerSeconds(maxSeconds);
  const keepDuration = [
    { fps: 15, q: 60, level: 4 },
    { fps: 12, q: 52, level: 5 },
    { fps: 10, q: 44, level: 5 },
    { fps: 8, q: 36, level: 6 },
    { fps: 6, q: 28, level: 6 },
    { fps: 5, q: 22, level: 6 },
    { fps: 4, q: 16, level: 6 },
    { fps: 3, q: 12, level: 6 }
  ].map((step) => ({ ...step, dur }));

  const shorten = [];
  for (const seconds of [8, 6, 5, 4, 3]) {
    if (seconds < dur) shorten.push({ fps: 6, q: 24, level: 6, dur: seconds });
  }
  return [...keepDuration, ...shorten];
}

/**
 * Converte imagem/vídeo/gif em WebP de figurinha (512x512, com transparência)
 * respeitando os limites do WhatsApp (<= 100 KB estática; <= 500 KB e <= 10 s
 * de animação na animada). A duração pedida em `maxSeconds` é preservada ao
 * máximo — a compressão come FPS/qualidade antes de cortar tempo.
 *
 * @param {Buffer} input mídia original
 * @param {{animated?: boolean, maxSeconds?: number, ext?: string, fit?: string, onProgress?: (msg: string) => Promise<any>}} opts
 * @returns {Promise<{buffer: Buffer, animated: boolean}>}
 */
export async function toStickerWebp(input, { animated = false, maxSeconds = STICKER_MAX_SECONDS, ext = '.png', fit = 'fill', onProgress, smart = true, prefer = 'auto' } = {}) {
  const realExt = detectMediaExt(input, ext);
  const inFile = tmpFile(realExt);
  const outFile = tmpFile('.webp');
  fs.writeFileSync(inFile, input);

  const maxBytes = animated ? STICKER_ANIMATED_MAX_BYTES : STICKER_STATIC_MAX_BYTES;
  const wanted = stickerSeconds(maxSeconds);
  const steps = animated
    ? animatedStickerSteps(wanted)
    : [{ q: 82 }, { q: 68 }, { q: 52 }, { q: 36 }, { q: 22 }];

  let best = null;
  try {
    // Motor inteligente: analisa, escolhe o trecho, fecha o loop, enquadra o
    // assunto e gasta o orçamento com previsão. Se qualquer coisa falhar, a
    // escada clássica logo abaixo assume — o usuário nunca fica sem figurinha.
    // O motor roda para vídeo E para foto: em foto ele decide o quadro parado e
    // recorta o fundo liso (de graça). Fundo complexo fica marcado no relatório
    // (`cutState`) para o chamador decidir se vale a IA.
    if (smart) {
      try {
        const result = await smartStickerWebp(inFile, outFile, { fit, maxSeconds: wanted, onProgress, prefer });
        if (result?.buffer?.length) {
          // Dentro do limite: pronto. Acima (conteúdo incompressível): aperta
          // mais antes de entregar — a spec vale mais que o plano. Vale para
          // animada (500 KB) e para foto (100 KB).
          const specLimit = animated ? STICKER_ANIMATED_SPEC_BYTES : STICKER_STATIC_MAX_BYTES;
          if (result.buffer.length <= specLimit) return result;
          const shrunk = await enforceStickerLimit(inFile, outFile, { animated, fit, wanted, maxBytes, onProgress });
          if (shrunk && shrunk.length <= maxBytes) {
            const kb = (n) => `${Math.round(n / 1024)} KB`;
            console.warn(`[ffmpeg] conteúdo pesado: ${kb(result.buffer.length)} → ${kb(shrunk.length)} (travado no limite do WhatsApp)`);
            return {
              buffer: shrunk,
              animated: isAnimatedWebp(shrunk),
              smart: { ...result.smart, emergency: `${kb(result.buffer.length)}→${kb(shrunk.length)}` }
            };
          }
        }
      } catch (error) {
        console.warn(`[ffmpeg] análise inteligente falhou (${String(error?.message || error).slice(0, 160)}); usando a escada padrão`);
      }
    }

    for (let i = 0; i < steps.length; ) {
      const step = steps[i];
      if (i > 0 && onProgress) {
        await onProgress(
          animated
            ? `🗜️ Ajustando a figurinha animada (até ${wanted} s · tentativa ${i + 1}/${steps.length})…`
            : `🗜️ Ajustando peso da figurinha (${i + 1}/${steps.length})…`
        );
      }
      await encodeStep(inFile, outFile, { animated, fit, ...step });
      if (!fs.existsSync(outFile)) throw new Error('ffmpeg não gerou saída');
      const buf = fs.readFileSync(outFile);
      if (!buf.length || !isWebp(buf)) throw new Error('ffmpeg gerou um WebP inválido');

      if (!best || buf.length < best.length) best = buf;
      if (buf.length <= maxBytes) {
        return { buffer: buf, animated: isAnimatedWebp(buf) };
      }
      // Se ficou muito acima do limite, pula degraus para economizar tempo
      const ratio = buf.length / maxBytes;
      const skip = ratio > 6 ? 3 : ratio > 2.2 ? 2 : 1;
      i += Math.max(1, Math.min(skip, steps.length - 1 - i));
    }

    if (!best) throw new Error('ffmpeg não gerou saída');
    // A escada também tem piso: se nem ela coube, a trava final resolve.
    if (best.length > maxBytes) {
      const shrunk = await enforceStickerLimit(inFile, outFile, { animated, fit, wanted, maxBytes, onProgress });
      if (shrunk && (shrunk.length < best.length || shrunk.length <= maxBytes)) best = shrunk;
    }
    return { buffer: best, animated: isAnimatedWebp(best) };
  } finally {
    fs.rmSync(inFile, { force: true });
    fs.rmSync(outFile, { force: true });
  }
}

/**
 * Olha o CONTEÚDO da imagem (não o rótulo do extrator) para separar foto de
 * asset sintético. Decodifica para uma amostra 32×32 crua pelo FFmpeg — o único
 * jeito de saber se aquele JPEG é o post ou um gradiente de "rascunho" da rede.
 *
 * @param {Buffer} input arquivo de imagem
 * @returns {Promise<object|null>} estatísticas de gradeImageSamples, ou null
 *   quando não dá para julgar (sem FFmpeg, imagem quebrada…).
 */
export async function analyzeImageDetail(input, { size = 32, ext = '.jpg' } = {}) {
  if (!hasFfmpeg()) return null;
  const realExt = detectMediaExt(input, ext);
  const inFile = tmpFile(realExt);
  fs.writeFileSync(inFile, input);
  try {
    const raw = await runFfmpegCapture(
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        inFile,
        '-vf',
        `scale=${size}:${size}:flags=area,format=rgb24`,
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        '-'
      ],
      { timeoutMs: 30_000 }
    );
    if (raw.length < size * size * 3) return null;
    return gradeImageSamples(raw, { width: size, height: size });
  } catch {
    return null;
  } finally {
    fs.rmSync(inFile, { force: true });
  }
}

/** Decodifica o 1º frame de um WebP para PNG (usado em .sfundo sobre figurinha ou .toimg). */
export async function decodeWebpToPng(webpBuffer) {
  const inFile = tmpFile('.webp');
  const outFile = tmpFile('.png');
  fs.writeFileSync(inFile, webpBuffer);
  try {
    await runFfmpeg(['-y', '-i', inFile, '-frames:v', '1', outFile], { timeoutMs: 60_000 });
    if (!fs.existsSync(outFile)) throw new Error('falha ao decodificar webp');
    return { buffer: fs.readFileSync(outFile) };
  } finally {
    fs.rmSync(inFile, { force: true });
    fs.rmSync(outFile, { force: true });
  }
}

/** Converte qualquer áudio ou vídeo para MP3 (.tomp3). */
export async function toAudioMp3(input, { bitrate = '192k', timeoutMs = 120_000 } = {}) {
  if (!hasFfmpeg()) {
    return input;
  }
  const realExt = detectMediaExt(input, '.bin');
  const inFile = tmpFile(realExt);
  const outFile = tmpFile('.mp3');
  fs.writeFileSync(inFile, input);
  try {
    await runFfmpeg([
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', inFile,
      '-vn',
      '-c:a', 'libmp3lame',
      '-b:a', bitrate,
      '-ar', '44100',
      '-ac', '2',
      outFile
    ], { timeoutMs });
    if (!fs.existsSync(outFile)) throw new Error('ffmpeg não gerou saída de áudio');
    const buf = fs.readFileSync(outFile);
    if (!buf.length) throw new Error('áudio convertido está vazio');
    return buf;
  } finally {
    fs.rmSync(inFile, { force: true });
    fs.rmSync(outFile, { force: true });
  }
}

/** Converte figurinha animada (WebP), GIF ou vídeo em MP4 compatível (.tovideo). */
export async function toVideoMp4(input, { timeoutMs = 120_000 } = {}) {
  if (!hasFfmpeg()) {
    throw new Error('FFmpeg é necessário para converter em vídeo. Instale no Termux com: pkg install ffmpeg');
  }
  const realExt = detectMediaExt(input, '.webp');
  const inFile = tmpFile(realExt);
  const outFile = tmpFile('.mp4');
  fs.writeFileSync(inFile, input);
  try {
    await runFfmpeg([
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', inFile,
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-movflags', '+faststart',
      '-preset', 'fast',
      outFile
    ], { timeoutMs });
    if (!fs.existsSync(outFile)) throw new Error('ffmpeg não gerou saída de vídeo');
    const buf = fs.readFileSync(outFile);
    if (!buf.length) throw new Error('vídeo convertido está vazio');
    return buf;
  } finally {
    fs.rmSync(inFile, { force: true });
    fs.rmSync(outFile, { force: true });
  }
}

/** WebP animado → GIF (para devolver figurinha como gif). */
export async function webpToGif(input) {
  const inFile = tmpFile('.webp');
  const outFile = tmpFile('.gif');
  fs.writeFileSync(inFile, input);
  try {
    await runFfmpeg(['-y', '-i', inFile, '-vf', 'fps=12', outFile]);
    return fs.readFileSync(outFile);
  } finally {
    fs.rmSync(inFile, { force: true });
    fs.rmSync(outFile, { force: true });
  }
}
