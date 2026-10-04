// 🧰 yt-dlp nativo — o "modo turbo" opcional.
//
// Se existir um binário `yt-dlp` (ou `youtube-dl`, ou `python3 -m yt_dlp`) no
// PATH — muito comum no Termux (`pip install -U yt-dlp`) — ele é o extrator
// mais forte disponível: cobre 1.800+ sites, resolve a assinatura do YouTube e
// escolhe a melhor combinação de faixas. O bot usa quando existe e cai para as
// estratégias em JS quando não existe. Nunca é obrigatório.

import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { log } from '../../core/logger.js';
import { envBool } from '../../core/env.js';
import { hasFfmpeg } from '../../util/ffmpeg.js';

const run = promisify(execFile);

let cachedBinary = null;
let checked = false;

/** Procura um extrator nativo utilizável. @returns {string[]|null} comando base */
export function findYtdlp() {
  if (checked) return cachedBinary;
  checked = true;

  const configured = process.env.YTDLP_PATH?.trim();
  const candidates = [
    configured ? [configured] : null,
    ['yt-dlp'],
    ['youtube-dl'],
    ['python3', '-m', 'yt_dlp'],
    ['python', '-m', 'yt_dlp']
  ].filter(Boolean);

  for (const cmd of candidates) {
    try {
      const stdout = execFileSync(cmd[0], [...cmd.slice(1), '--version'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 8000,
        windowsHide: true
      });
      if (stdout) {
        cachedBinary = cmd;
        log.ok(`yt-dlp encontrado: ${cmd.join(' ')} (${String(stdout).trim().split('\n').pop()})`);
        return cachedBinary;
      }
    } catch {
      /* tenta o próximo candidato */
    }
  }
  cachedBinary = null;
  return null;
}

export function isYtdlpEnabled() {
  return !envBool('NEXUS_DISABLE_YTDLP', false) && envBool('NEXUS_ENABLE_YTDLP', false);
}

export function hasYtDlp() {
  return Boolean(isYtdlpEnabled() && findYtdlp());
}

/**
 * URL canônica de vídeo do YouTube montada a partir de um ID de 11 caracteres.
 * É a única forma de URL que o bot entrega ao yt-dlp sem NEXUS_ENABLE_YTDLP:
 * host fixo (www.youtube.com), sem redirecionamento controlado pelo usuário.
 */
export function youtubeWatchUrl(videoId) {
  return /^[\w-]{11}$/.test(String(videoId || '')) ? `https://www.youtube.com/watch?v=${videoId}` : null;
}

function isCanonicalYouTubeUrl(url) {
  return /^https:\/\/www\.youtube\.com\/watch\?v=[\w-]{11}$/.test(String(url || ''));
}

/**
 * O yt-dlp pode rodar para ESTA URL?
 *  • NEXUS_DISABLE_YTDLP=true → nunca (desligamento de emergência);
 *  • NEXUS_ENABLE_YTDLP=true  → qualquer URL já validada pelo bot;
 *  • caso contrário           → só a URL canônica do YouTube (youtubeWatchUrl).
 * Sem binário instalado → false.
 */
export function canUseYtdlp(url) {
  if (envBool('NEXUS_DISABLE_YTDLP', false)) return false;
  if (!envBool('NEXUS_ENABLE_YTDLP', false) && !isCanonicalYouTubeUrl(url)) return false;
  return Boolean(findYtdlp());
}

const VIDEO_FORMAT = 'best[ext=mp4]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best';
// Sem ffmpeg não dá para converter: prefere m4a (toca em iOS/Android); com ffmpeg vira mp3.
const AUDIO_FORMAT = 'bestaudio/best';
const AUDIO_FORMAT_NO_FFMPEG = 'bestaudio[ext=m4a]/bestaudio/best';

/**
 * Desde 2025 o yt-dlp precisa de um runtime JavaScript para resolver os desafios
 * do YouTube (só o deno vem habilitado por padrão). O bot já roda em Node, então
 * aponta o yt-dlp para o mesmo Node. YTDLP_JS_RUNTIME sobrescreve
 * (ex.: `deno`, `node:/caminho/node`) e `off` não passa nada.
 */
function jsRuntimeArgs() {
  const configured = process.env.YTDLP_JS_RUNTIME?.trim();
  if (configured && /^(off|none|false|0)$/i.test(configured)) return [];
  return ['--js-runtimes', configured || `node:${process.execPath}`];
}

/** Último "ERROR:" do stderr do yt-dlp (é a linha que diz o motivo real). */
function ytdlpErrorLine(error) {
  const stderr = String(error?.stderr?.toString?.('utf8') || error?.message || error).trim();
  const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean);
  const errLine = [...lines].reverse().find((l) => /^ERROR:/i.test(l));
  return (errLine || lines[lines.length - 1] || 'erro desconhecido').slice(0, 220);
}

function readInfoJson(file) {
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      title: json?.title,
      author: json?.uploader || json?.channel,
      thumbnail: json?.thumbnail,
      duration: Math.round(Number(json?.duration) || 0)
    };
  } catch {
    return null;
  }
}

/**
 * Baixa (ou extrai o áudio de) uma URL usando o yt-dlp local.
 *
 * Grava num diretório temporário em vez de stdout: o yt-dlp NÃO consegue
 * pós-processar (-x → mp3, juntar vídeo+áudio) quando a saída é `-o -`.
 * @returns {Promise<{buffer: Buffer, info: {title?: string, author?: string, thumbnail?: string, duration: number}|null}>}
 */
export async function ytdlpBuffer(url, { audioOnly = false, timeoutMs = 240_000, maxBytes = 90 * 1024 * 1024 } = {}) {
  if (!canUseYtdlp(url)) {
    throw new Error('yt-dlp local está desativado para este link; habilite NEXUS_ENABLE_YTDLP somente se confiar nos links usados');
  }
  const limit = Math.min(200 * 1024 * 1024, Math.max(1, Number(maxBytes) || 90 * 1024 * 1024));
  const cmd = findYtdlp();
  if (!cmd) throw new Error('yt-dlp não instalado');

  const ffmpeg = hasFfmpeg();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ytdlp-'));
  const buildArgs = (withRuntime) => [
    ...cmd.slice(1),
    '--no-warnings',
    '--no-playlist',
    '--no-part',
    '--no-mtime',
    '--max-filesize',
    `${Math.ceil(limit / (1024 * 1024))}M`,
    '-q',
    '--write-info-json',
    ...(withRuntime ? jsRuntimeArgs() : []),
    '-f',
    audioOnly ? (ffmpeg ? AUDIO_FORMAT : AUDIO_FORMAT_NO_FFMPEG) : VIDEO_FORMAT,
    ...(audioOnly && ffmpeg ? ['-x', '--audio-format', 'mp3', '--audio-quality', '0'] : []),
    ...(!audioOnly && ffmpeg ? ['--merge-output-format', 'mp4'] : []),
    '-o',
    path.join(dir, 'media.%(ext)s'),
    url
  ];
  const exec = (withRuntime) =>
    run(cmd[0], buildArgs(withRuntime), {
      encoding: 'buffer',
      maxBuffer: 4 * 1024 * 1024,
      timeout: timeoutMs,
      windowsHide: true
    });

  try {
    try {
      await exec(true);
    } catch (error) {
      // yt-dlp antigo não conhece --js-runtimes: tenta de novo sem a opção.
      const stderr = String(error?.stderr?.toString?.('utf8') || '');
      if (!/no such option|unrecognized arguments|unknown option/i.test(stderr)) throw error;
      log.warn('yt-dlp sem suporte a --js-runtimes; atualize: pip install -U yt-dlp');
      await exec(false);
    }
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('media.') && !f.endsWith('.info.json'))
      .map((f) => ({ file: path.join(dir, f), size: fs.statSync(path.join(dir, f)).size }))
      .sort((a, b) => b.size - a.size);
    if (!files.length || !files[0].size) throw new Error('yt-dlp não devolveu bytes');
    if (files[0].size > limit) throw new Error(`yt-dlp excedeu o limite de ${Math.floor(limit / (1024 * 1024))} MB`);
    const buffer = fs.readFileSync(files[0].file);
    const info = readInfoJson(path.join(dir, 'media.info.json'));
    return { buffer, info };
  } catch (error) {
    if (/^yt-dlp/.test(String(error?.message))) throw error;
    throw new Error(`yt-dlp: ${ytdlpErrorLine(error)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Metadados sem baixar a mídia (rápido, usado só para enriquecer). */
export async function ytdlpInfo(url, { timeoutMs = 45_000 } = {}) {
  if (!canUseYtdlp(url)) return null;
  const cmd = findYtdlp();
  if (!cmd) return null;
  try {
    const { stdout } = await run(
      cmd[0],
      [...cmd.slice(1), '--dump-single-json', '--no-warnings', '--no-playlist', '--skip-download', ...jsRuntimeArgs(), url],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs, windowsHide: true }
    );
    const json = JSON.parse(String(stdout));
    return {
      title: json?.title,
      author: json?.uploader || json?.channel,
      thumbnail: json?.thumbnail,
      duration: Math.round(Number(json?.duration) || 0)
    };
  } catch {
    return null;
  }
}

/** Reseta o cache de descoberta (usado nos testes). */
export function resetYtdlpCache() {
  cachedBinary = null;
  checked = false;
}
