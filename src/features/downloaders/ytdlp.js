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
import { envBool, envNumber } from '../../core/env.js';
import { hasFfmpeg } from '../../util/ffmpeg.js';

const run = promisify(execFile);

let cachedBinary = null;
let cachedVersion = '';
let checked = false;

/** Versão do binário encontrado ("2026.08.19"), vazio se não houver. */
export function ytdlpVersion() {
  findYtdlp();
  return cachedVersion;
}

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
        cachedVersion = String(stdout).trim().split('\n').pop() || '';
        log.ok(`yt-dlp encontrado: ${cmd.join(' ')} (${cachedVersion})`);
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

/** Dica acionável para o muro de "confirme que você não é um robô". */
export const BOT_WALL_HINT =
  'O YouTube pediu verificação para este IP. Atualize o extrator (pip install -U yt-dlp) e, ' +
  'se continuar, exporte cookies de uma aba anônima logada e aponte YTDLP_COOKIES=/caminho/cookies.txt no .env.';

/** Erros que mudam de resultado se a tentativa for repetida com outro cliente. */
const RETRYABLE_ERROR =
  /sign in to confirm|not a bot|login_required|confirm your age|po token|http error 40[39]|forbidden|requested format is not available|unable to download api page|failed to extract any player response|content isn'?t available|player response|nsig|n-?sig|unable to extract/i;

/** Erros em que insistir é só perder tempo (o vídeo realmente não está lá). */
const FATAL_ERROR =
  /private video|video unavailable|removed by the (uploader|user)|has been terminated|copyright|does not exist|is not available in your country|members-only|requires payment/i;

/** `true` quando o stderr veio do muro de verificação do YouTube. */
export function isBotWallError(message) {
  return /sign in to confirm|not a bot|login_required/i.test(String(message || ''));
}

/**
 * Cookies do YouTube, quando o operador configurou.
 *  • YTDLP_COOKIES              → arquivo no formato Netscape (cookies.txt)
 *  • YTDLP_COOKIES_FROM_BROWSER → "chrome", "firefox:perfil" etc. (PC com navegador)
 * É o único remédio real quando o IP já está marcado pelo YouTube.
 */
export function cookieArgs() {
  const file = process.env.YTDLP_COOKIES?.trim();
  if (file) {
    if (fs.existsSync(file)) return ['--cookies', file];
    log.warn(`YTDLP_COOKIES aponta para um arquivo inexistente: ${file}`);
  }
  const browser = process.env.YTDLP_COOKIES_FROM_BROWSER?.trim();
  // Formato aceito pelo yt-dlp: BROWSER[+KEYRING][:PERFIL][::CONTAINER]
  if (browser && /^[A-Za-z0-9+:._~\\/\- ]{1,120}$/.test(browser)) return ['--cookies-from-browser', browser];
  if (browser) log.warn('YTDLP_COOKIES_FROM_BROWSER tem caracteres inválidos; ignorando');
  return [];
}

export function hasCookies() {
  return cookieArgs().length > 0;
}

/**
 * Planos de tentativa, do mais provável ao mais teimoso.
 *
 * Cada plano é uma combinação de clientes do player. A lista padrão do yt-dlp
 * (`default`) é sempre a primeira: fixar clientes "na mão" é o erro clássico —
 * quando o YouTube aposenta um deles, TODO download passa a dar bot check.
 * As reservas existem porque os clientes não são checados com o mesmo rigor:
 * trocar de cliente é, na prática, o que destrava a maioria dos bloqueios.
 *
 * Detalhe contraintuitivo e documentado pelo próprio yt-dlp: com cookies ele
 * PULA os clientes que não os suportam (android_vr, tv_simply, ios) — que são
 * justamente os que dispensam PO token. Por isso existe um plano SEM cookies.
 */
function attemptPlans({ youtube, withCookies }) {
  if (!youtube) return [{ label: 'padrão', extra: [], cookies: true }];

  const configured = process.env.YTDLP_PLAYER_CLIENTS?.trim();
  const clientArg = (clients) => ['--extractor-args', `youtube:player_client=${clients}`];

  const plans = [
    { label: 'clientes padrão', extra: configured ? clientArg(configured) : [], cookies: true },
    { label: 'clientes alternativos', extra: clientArg('default,-visionos,tv_simply,mweb,web_embedded'), cookies: true }
  ];
  if (withCookies) {
    // Sem cookies voltam a existir os clientes que não precisam de PO token.
    plans.push({ label: 'sem cookies', extra: clientArg('android_vr,visionos,tv_simply'), cookies: false });
  } else {
    plans.push({ label: 'IPv4', extra: ['-4'], cookies: true });
  }
  const max = Math.max(1, Math.min(plans.length, envNumber('YTDLP_MAX_ATTEMPTS', 3)));
  return plans.slice(0, max);
}

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
  const youtube = /(^|\.)youtube\.com|(^|\.)youtu\.be/i.test(safeHost(url));
  const cookies = cookieArgs();
  const plans = attemptPlans({ youtube, withCookies: cookies.length > 0 });
  let lastError = null;
  // Orçamento ÚNICO para toda a cascata: quem está no WhatsApp espera resposta,
  // então três tentativas não podem virar três vezes o tempo de espera.
  const deadline = Date.now() + timeoutMs;

  for (let attempt = 0; attempt < plans.length; attempt++) {
    const plan = plans[attempt];
    const remaining = deadline - Date.now();
    if (attempt > 0 && remaining < 20_000) {
      log.warn('yt-dlp: tempo esgotado para novas tentativas; passando para as reservas');
      break;
    }
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
      ...(plan.cookies ? cookies : []),
      ...plan.extra,
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
        timeout: Math.max(20_000, deadline - Date.now()),
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
      const reason = /^yt-dlp/.test(String(error?.message)) ? String(error.message) : `yt-dlp: ${ytdlpErrorLine(error)}`;
      lastError = new Error(reason);
      if (isBotWallError(reason)) lastError.hint = BOT_WALL_HINT;

      const isLast = attempt === plans.length - 1;
      if (isLast || FATAL_ERROR.test(reason) || !RETRYABLE_ERROR.test(reason)) break;
      log.warn(`yt-dlp (${plan.label}) falhou; tentando "${plans[attempt + 1].label}"`, { message: reason.slice(0, 140) });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  if (lastError?.hint) warnStaleVersion();
  throw lastError || new Error('yt-dlp: erro desconhecido');
}

function safeHost(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Versão velha é a causa nº 1 de "bot check" que parece bloqueio de IP: o
 * YouTube muda o desafio a cada poucas semanas e o yt-dlp solta a correção em
 * dias. Avisa uma vez por execução, sem transformar isso em erro.
 */
let staleWarned = false;
function warnStaleVersion() {
  if (staleWarned) return;
  staleWarned = true;
  const parts = String(cachedVersion || '').match(/^(\d{4})\.(\d{2})\.(\d{2})/);
  if (!parts) return;
  const released = Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
  const days = Math.floor((Date.now() - released) / 86_400_000);
  if (days >= 30) {
    log.warn(`yt-dlp tem ${days} dias (${cachedVersion}) — o YouTube muda o desafio a cada poucas semanas: pip install -U yt-dlp`);
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
      [
        ...cmd.slice(1),
        '--dump-single-json',
        '--no-warnings',
        '--no-playlist',
        '--skip-download',
        ...jsRuntimeArgs(),
        ...cookieArgs(),
        url
      ],
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
  cachedVersion = '';
  checked = false;
  staleWarned = false;
}
