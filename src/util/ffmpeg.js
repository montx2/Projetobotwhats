// FFmpeg: detecção e conversão para figurinhas (WebP 512x512).
// Sem dependência npm — chama o binário do sistema (Termux/Linux/Windows).

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { isWebp, isAnimatedWebp } from './webp.js';
import { gradeImageSamples } from './imageinfo.js';

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

export function buildStickerFilter({ animated, fps = 15, simple = false, fit = 'fill' }) {
  const flags = simple ? '' : `:flags=${animated ? 'bicubic' : 'lanczos'}`;
  const parts = [];
  if (animated) parts.push(`fps=${fps}`);
  parts.push('format=rgba');
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

async function encodeStep(inFile, outFile, { animated, q, fps = 15, dur = 7, fit = 'fill' }) {
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
      '4',
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
 * Converte imagem/vídeo/gif em WebP de figurinha (512x512, com transparência)
 * respeitando os limites de tamanho do WhatsApp (<= 100 KB estática, <= 500 KB animada).
 * @param {Buffer} input mídia original
 * @param {{animated?: boolean, maxSeconds?: number, ext?: string, onProgress?: (msg: string) => Promise<any>}} opts
 * @returns {Promise<{buffer: Buffer, animated: boolean}>}
 */
export async function toStickerWebp(input, { animated = false, maxSeconds = 8, ext = '.png', fit = 'fill', onProgress } = {}) {
  const realExt = detectMediaExt(input, ext);
  const inFile = tmpFile(realExt);
  const outFile = tmpFile('.webp');
  fs.writeFileSync(inFile, input);

  // Escada adaptativa de qualidade/FPS/duração para nunca estourar o limite do WhatsApp
  const maxBytes = animated ? 480 * 1024 : 100 * 1024;
  const steps = animated
    ? [
        { fps: 15, q: 55, dur: Math.min(maxSeconds, 7) },
        { fps: 12, q: 42, dur: Math.min(maxSeconds, 6) },
        { fps: 10, q: 32, dur: Math.min(maxSeconds, 5) },
        { fps: 8, q: 22, dur: Math.min(maxSeconds, 4) },
        { fps: 6, q: 15, dur: Math.min(maxSeconds, 3) }
      ]
    : [{ q: 82 }, { q: 68 }, { q: 52 }, { q: 36 }, { q: 22 }];

  let best = null;
  try {
    for (let i = 0; i < steps.length; ) {
      const step = steps[i];
      if (i > 0 && onProgress) {
        await onProgress(
          animated
            ? `🗜️ Otimizando figurinha animada para o WhatsApp (tentativa ${i + 1}/${steps.length})…`
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
      // Se ficou muito acima do limite, pula direto 2 degraus para economizar tempo
      i += buf.length > maxBytes * 2.2 && i + 2 < steps.length ? 2 : 1;
    }

    if (!best) throw new Error('ffmpeg não gerou saída');
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
