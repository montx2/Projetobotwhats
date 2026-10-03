// 🆓 TTS LOCAL — voz 100% grátis, offline, sem chave, sem conta e sem cadastro.
//
// Por que este arquivo existe: o motor principal do bot (Edge) é grátis, mas é
// um serviço online e NÃO OFICIAL — se a Microsoft mudar o protocolo, se o IP
// estiver bloqueado ou se a internet cair, o `.voz` ficaria sem resposta.
// Aqui a voz sai do próprio aparelho, então `.voz` sempre tem para onde cair
// sem custar nada e sem mandar o texto para fora.
//
// Dois motores, detectados sozinhos (nenhum é dependência npm):
//   1) piper      (MIT)   — voz neural offline, qualidade boa. Opcional:
//                           precisa do binário `piper` + um modelo .onnx.
//                           Termux/Linux: pip install piper-tts
//                           Modelos grátis: huggingface.co/rhasspy/piper-voices
//   2) espeak-ng  (GPLv3) — voz robótica, porém levinha e disponível em tudo:
//                           Termux : pkg install espeak
//                           Debian : apt install espeak-ng
//                           Fedora : dnf install espeak-ng
//                           macOS  : brew install espeak-ng
//                           Windows: winget install espeak-ng
//
// Tom, velocidade e volume saem NATIVOS no espeak (sem FFmpeg): o `--tom` do
// usuário vale aqui também. Os efeitos opcionais (`fx`: eco, rádio…) continuam
// no FFmpeg quando ele existe.

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyAudioFilter } from '../util/ffmpeg.js';

const SYNTH_TIMEOUT_MS = 90_000;
const MAX_TEXT = 1_500;

let espeakCache; // undefined = não procurado · false = ausente · string = caminho
let piperCache;
let piperModelCache;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Mesma busca do FFmpeg: PATH, ./bin, $PREFIX/bin e o caminho fixo do Termux.
 * O primeiro candidato de cada nome é o nome puro — é ele que faz o `spawnSync`
 * procurar no PATH.
 */
function probeBinary(names, versionArg = '--version') {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const dirs = [
    path.join(process.cwd(), 'bin'),
    process.env.PREFIX ? path.join(process.env.PREFIX, 'bin') : null,
    '/data/data/com.termux/files/usr/bin'
  ].filter(Boolean);

  for (const name of names) {
    const candidates = [`${name}${suffix}`, ...dirs.map((dir) => path.join(dir, `${name}${suffix}`))];
    for (const candidate of candidates) {
      if (path.isAbsolute(candidate)) {
        // Fora do PATH: confere se o arquivo existe e é executável.
        try {
          if (fs.existsSync(candidate) && (process.platform === 'win32' || fs.statSync(candidate).mode & 0o111)) return candidate;
        } catch {}
        continue;
      }
      try {
        const probe = spawnSync(candidate, [versionArg], { timeout: 5_000, stdio: 'ignore' });
        // Alguns binários respondem ao --version saindo com código 1.
        if (probe.status === 0 || probe.status === 1) return candidate;
      } catch {}
    }
  }
  return false;
}

/** Caminho do espeak-ng/espeak, ou `false` quando não está instalado. */
export function findEspeak() {
  if (espeakCache !== undefined) return espeakCache;
  espeakCache = probeBinary(['espeak-ng', 'espeak']);
  return espeakCache;
}

/** Modelo do piper: PIPER_MODEL (arquivo) ou descoberta em pastas comuns. */
export function findPiperModel() {
  if (piperModelCache !== undefined) return piperModelCache;
  const explicit = String(process.env.PIPER_MODEL || process.env.PIPER_VOICE || '').trim();
  const defaultModel = 'pt_BR-faber-medium.onnx';
  const candidates = [
    explicit || null,
    process.env.PIPER_MODEL_DIR ? path.join(process.env.PIPER_MODEL_DIR, defaultModel) : null,
    path.join(process.cwd(), 'models', defaultModel),
    path.join(os.homedir(), '.local', 'share', 'piper', defaultModel),
    process.env.PREFIX ? path.join(process.env.PREFIX, 'share', 'piper', defaultModel) : null
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        piperModelCache = candidate;
        return candidate;
      }
    } catch {}
  }
  piperModelCache = false;
  return false;
}

/** Binário do piper (PIPER_BIN, senão o PATH). */
export function findPiper() {
  if (piperCache !== undefined) return piperCache;
  const explicit = String(process.env.PIPER_BIN || '').trim();
  if (explicit) {
    try {
      if (fs.existsSync(explicit)) {
        piperCache = explicit;
        return explicit;
      }
    } catch {}
  }
  piperCache = probeBinary(['piper']);
  return piperCache;
}

export function hasLocalEngine() {
  return Boolean(findEspeak() || (findPiper() && findPiperModel()));
}

// ── Escolha da voz do espeak ────────────────────────────────────────
// O catálogo fala pt-BR; as vozes de outros idiomas (gringo, gringa, mexicano)
// são traduzidas para o idioma mais próximo que o espeak conhece.
const ESPEAK_LANGS = Object.freeze({
  'pt-br': 'pt-br',
  pt: 'pt',
  'pt-pt': 'pt',
  'en-us': 'en-us',
  en: 'en',
  'en-gb': 'en-gb',
  'es-mx': 'es-la',
  'es-es': 'es',
  es: 'es',
  'it-it': 'it',
  'fr-fr': 'fr',
  'de-de': 'de'
});

const FEMININE_HINT = /femin|fem|mulher|garota|menina/i;
const FEMININE_VOICES = /Francisca|Thalita|Leila|Yara|Brenda|Elza|Giovanna|Leticia|Manuela|Emma|Ava|Ana|Jenny|Camila|Vitoria|Dalia|Nova/i;

/** Idioma do espeak a partir do `lang`/nome técnico da voz do catálogo. */
export function espeakLangFor(spec = {}) {
  const raw = String(spec.lang || '').trim().toLowerCase();
  if (ESPEAK_LANGS[raw]) return ESPEAK_LANGS[raw];
  const fromVoice = /^([a-z]{2})-([A-Z]{2})/.exec(String(spec.voice || ''));
  if (fromVoice) {
    const key = `${fromVoice[1]}-${fromVoice[2]}`.toLowerCase();
    if (ESPEAK_LANGS[key]) return ESPEAK_LANGS[key];
  }
  return 'pt-br';
}

/** A voz pedida parece feminina? (espeak não tem gênero: subimos o tom) */
export function isFeminineVoice(spec = {}) {
  return FEMININE_HINT.test(`${spec.id || ''} ${spec.label || ''}`) || FEMININE_VOICES.test(String(spec.voice || ''));
}

/**
 * Tom/velocidade/volume do catálogo → parâmetros do espeak.
 * espeak usa `-p` 0..99 (50 = normal), `-s` palavras por minuto e `-a` 0..200.
 */
export function espeakParams({ pitchPct = 0, speedPct = 0, volumePct = 0, feminine = false } = {}) {
  return {
    pitch: clamp(Math.round(50 + Number(pitchPct) * 0.6 + (feminine ? 8 : 0)), 0, 99),
    wpm: clamp(Math.round(175 * (1 + Number(speedPct) / 100)), 80, 450),
    amp: clamp(Math.round(100 * (1 + Number(volumePct) / 100)), 0, 200)
  };
}

/**
 * Voz do espeak para uma entrada do catálogo.
 * `VOZES_EXTRA=minhavoz=espeak:pt-br+f3` fixa a voz crua do espeak.
 */
export function espeakVoiceFor(spec = {}, { override = '' } = {}) {
  const explicit = String(spec.espeakVoice || override || '').trim();
  if (spec.engine === 'espeak' && spec.voice) return String(spec.voice).trim();
  if (explicit) return explicit;
  return espeakLangFor(spec);
}

function tmpFile(ext) {
  return path.join(os.tmpdir(), `montxbot-tts-${crypto.randomBytes(6).toString('hex')}${ext}`);
}

/** Roda o binário até o fim; erros viram exceção com a mensagem do stderr. */
function runBinary(bin, args, { input = '', timeoutMs = SYNTH_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {}
      finish(new Error(`${path.basename(bin)} não respondeu a tempo`));
    }, timeoutMs);

    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ stderr });
    }

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
      if (stderr.length > 4_000) stderr = stderr.slice(-4_000);
    });
    proc.on('error', (error) => finish(error));
    proc.on('close', (code) => {
      if (code === 0) finish(null);
      else finish(new Error(`${path.basename(bin)} falhou (código ${code})${stderr ? `: ${stderr.trim().slice(0, 200)}` : ''}`));
    });
    try {
      proc.stdin.end(input);
    } catch (error) {
      finish(error);
    }
  });
}

function readAndRemove(file) {
  try {
    const buffer = fs.readFileSync(file);
    return buffer.length ? buffer : null;
  } catch {
    return null;
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/**
 * WAV → MP3 quando o FFmpeg existe (o WhatsApp lida melhor e o arquivo fica
 * menor). Sem FFmpeg devolve o WAV mesmo: ele toca, só ocupa mais espaço.
 */
async function toMp3(wav) {
  const mp3 = await applyAudioFilter(wav, { filter: 'anull', ext: '.mp3', bitrate: '96k' });
  return mp3 || wav;
}

/** Sintetiza com o espeak-ng (tom/velocidade/volume nativos, sem FFmpeg). */
export async function espeakTts(text, spec = {}, { bin = findEspeak(), override = '' } = {}) {
  if (!bin) {
    throw new Error(
      'espeak não instalado — Termux: pkg install espeak · Linux: apt install espeak-ng · Windows: winget install espeak-ng'
    );
  }
  const clean = String(text || '').trim().slice(0, MAX_TEXT);
  if (!clean) throw new Error('texto vazio para a voz');

  const voice = espeakVoiceFor(spec, { override });
  const { pitch, wpm, amp } = espeakParams({
    pitchPct: spec.pitchPct,
    speedPct: spec.speedPct,
    volumePct: spec.volumePct,
    feminine: isFeminineVoice(spec)
  });
  const out = tmpFile('.wav');
  try {
    await runBinary(bin, ['-v', voice, '-p', String(pitch), '-s', String(wpm), '-a', String(amp), '-w', out], { input: clean });
    const wav = readAndRemove(out);
    if (!wav) throw new Error('espeak não gerou áudio');
    return await toMp3(wav);
  } finally {
    fs.rmSync(out, { force: true });
  }
}

/** Sintetiza com o piper (voz neural offline); precisa de binário + modelo. */
export async function piperTts(text, spec = {}, { bin = findPiper(), model = findPiperModel() } = {}) {
  if (!bin || !model) {
    throw new Error('piper precisa do binário `piper` e de um modelo .onnx (PIPER_MODEL=/caminho/voz.onnx)');
  }
  const clean = String(text || '').trim().slice(0, MAX_TEXT);
  if (!clean) throw new Error('texto vazio para a voz');

  // No piper a velocidade é `length_scale` (1 = normal; maior = mais lento).
  const lengthScale = clamp(1 / clamp(1 + Number(spec.speedPct || 0) / 100, 0.5, 2), 0.5, 2);
  const out = tmpFile('.wav');
  try {
    await runBinary(bin, ['--model', model, '--output_file', out, '--length_scale', lengthScale.toFixed(2)], { input: clean });
    const wav = readAndRemove(out);
    if (!wav) throw new Error('piper não gerou áudio');
    return await toMp3(wav);
  } finally {
    fs.rmSync(out, { force: true });
  }
}

/** Motor local pedido pela própria voz (`espeak:` / `piper:` no VOZES_EXTRA). */
export function localEngineFor(spec = {}) {
  if (spec.engine === 'espeak') return 'espeak';
  if (spec.engine === 'piper') return 'piper';
  return null;
}

/** Status dos motores locais para `.pools` / `.info`. */
export function localStatus() {
  const espeak = findEspeak();
  const piper = findPiper();
  const model = findPiperModel();
  return {
    espeak: { installed: Boolean(espeak), bin: espeak || null },
    piper: { installed: Boolean(piper && model), bin: piper || null, model: model || null },
    any: Boolean(espeak || (piper && model))
  };
}

/** Só para os testes: esquece o que foi detectado no PATH. */
export function resetLocalStateForTests() {
  espeakCache = undefined;
  piperCache = undefined;
  piperModelCache = undefined;
}
