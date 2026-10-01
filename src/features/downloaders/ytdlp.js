// 🧰 yt-dlp nativo — o "modo turbo" opcional.
//
// Se existir um binário `yt-dlp` (ou `youtube-dl`, ou `python3 -m yt_dlp`) no
// PATH — muito comum no Termux (`pip install -U yt-dlp`) — ele é o extrator
// mais forte disponível: cobre 1.800+ sites, resolve a assinatura do YouTube e
// escolhe a melhor combinação de faixas. O bot usa quando existe e cai para as
// estratégias em JS quando não existe. Nunca é obrigatório.

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { log } from '../../core/logger.js';

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

export function hasYtDlp() {
  return Boolean(process.env.NEXUS_DISABLE_YTDLP !== 'true' && findYtdlp());
}

const VIDEO_FORMAT = 'best[ext=mp4]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best';
const AUDIO_FORMAT = 'bestaudio/best';

/**
 * Baixa (ou extrai o áudio de) uma URL usando o yt-dlp local.
 * @returns {Promise<{buffer: Buffer}>}
 */
export async function ytdlpBuffer(url, { audioOnly = false, timeoutMs = 240_000 } = {}) {
  const cmd = findYtdlp();
  if (!cmd) throw new Error('yt-dlp não instalado');

  const args = [
    ...cmd.slice(1),
    '--no-warnings',
    '--no-playlist',
    '--no-part',
    '--no-mtime',
    '-q',
    '-f',
    audioOnly ? AUDIO_FORMAT : VIDEO_FORMAT,
    ...(audioOnly ? ['-x', '--audio-format', 'mp3', '--audio-quality', '0'] : []),
    '-o',
    '-',
    url
  ];

  try {
    const { stdout } = await run(cmd[0], args, {
      encoding: 'buffer',
      maxBuffer: 260 * 1024 * 1024,
      timeout: timeoutMs,
      windowsHide: true
    });
    const buffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || '');
    if (!buffer.length) throw new Error('yt-dlp não devolveu bytes');
    return { buffer };
  } catch (error) {
    const stderr = String(error?.stderr?.toString?.('utf8') || error?.message || error).trim();
    throw new Error(`yt-dlp: ${stderr.slice(0, 220)}`);
  }
}

/** Metadados sem baixar a mídia (rápido, usado só para enriquecer). */
export async function ytdlpInfo(url, { timeoutMs = 45_000 } = {}) {
  const cmd = findYtdlp();
  if (!cmd) return null;
  try {
    const { stdout } = await run(
      cmd[0],
      [...cmd.slice(1), '--dump-single-json', '--no-warnings', '--no-playlist', '--skip-download', url],
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
