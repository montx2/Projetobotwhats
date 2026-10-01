// ⚡ NEXUS BOT — ponto de entrada.

import { loadDotEnv } from './core/env.js';
loadDotEnv();

import fs from 'node:fs';
import path from 'node:path';
import { jidNormalizedUser } from '@whiskeysockets/baileys';
import { ENV } from './core/config.js';
import { log, banner } from './core/logger.js';
import { DATA_DIR, ensureDirs, flushStore } from './core/store.js';
import { platformBanner, isTermux } from './core/platform.js';
import { startClient, stopClient } from './wa/client.js';
import { handleMessage } from './features/router.js';
import { hasFfmpeg } from './util/ffmpeg.js';
import { bgStatus } from './features/bgremoval.js';
import { isGroup } from './util/text.js';

ensureDirs();

banner([
  '◆ MontxBOT  ·  v7.0',
  '',
  platformBanner(),
  isTermux() ? '▸ Termux: pareamento por código (sem QR)' : '▸ Desktop: QR Code habilitado',
  '▸ Modo privado: exclusivo do dono (.ativar libera um chat)',
  `▸ Remoção de fundo: ${bgStatus()[0]}`,
  hasFfmpeg() ? '▸ FFmpeg: ok' : '⚠ FFmpeg ausente (figurinhas não funcionarão)'
]);

if (!hasFfmpeg()) {
  log.warn('Instale o FFmpeg para figurinhas: pkg install ffmpeg (Termux) · apt install ffmpeg (Linux) · winget install ffmpeg (Windows)');
}

function safeNormalize(jid) {
  if (!jid) return '';
  try {
    return jidNormalizedUser(String(jid));
  } catch {
    return String(jid).replace(/:\d+@/, '@');
  }
}

function bareDigits(jid) {
  if (!jid || isGroup(jid) || String(jid).endsWith('@lid')) return '';
  return String(jid).split('@')[0].split(':')[0].replace(/\D/g, '');
}

function readSavedPairingDigits() {
  try {
    return fs.readFileSync(path.join(DATA_DIR, 'pairing-number.txt'), 'utf8').replace(/\D/g, '');
  } catch {
    return '';
  }
}

// ── dono da conta ──────────────────────────────────────────
const owner = {
  jid: null,
  lid: null,
  numbers: new Set(
    [...ENV.ownerNumbers, ENV.pairingNumber, readSavedPairingDigits()]
      .map((n) => String(n || '').replace(/\D/g, ''))
      .filter(Boolean)
  ),
  setFromSocket(sock) {
    const savedDigits = readSavedPairingDigits();
    if (savedDigits) this.numbers.add(savedDigits);

    const rawId = sock?.user?.id || sock?.creds?.me?.id;
    const rawLid = sock?.user?.lid || sock?.creds?.me?.lid;
    if (rawId) {
      this.jid = safeNormalize(rawId);
      const num = bareDigits(rawId);
      if (num) this.numbers.add(num);
    } else if (!this.jid && this.numbers.size) {
      const firstNum = [...this.numbers][0];
      this.jid = `${firstNum}@s.whatsapp.net`;
    }
    if (rawLid) {
      this.lid = safeNormalize(rawLid);
    }
  },
  matchesOwnerJid(sock, candidate) {
    if (!candidate || isGroup(candidate)) return false;
    this.setFromSocket(sock);
    const norm = safeNormalize(candidate);
    const num = bareDigits(candidate);
    if (num && this.numbers.has(num)) return true;
    const known = [
      this.jid,
      this.lid,
      safeNormalize(sock?.user?.id),
      safeNormalize(sock?.user?.lid),
      safeNormalize(sock?.creds?.me?.id),
      safeNormalize(sock?.creds?.me?.lid)
    ].filter(Boolean);
    if (known.includes(norm)) return true;
    const candidateUser = String(candidate).split('@')[0].split(':')[0];
    return Boolean(candidateUser && known.some((k) => String(k).split('@')[0].split(':')[0] === candidateUser));
  },
  /** Verifica se o chat é ESTRITAMENTE o privado do próprio dono ("Você" / self-chat ou OWNER_NUMBERS). */
  isPrivateOwnerChat(sock, remoteJid) {
    if (!remoteJid || isGroup(remoteJid) || remoteJid === 'status@broadcast') return false;
    return this.matchesOwnerJid(sock, remoteJid);
  }
};

// ── boot ───────────────────────────────────────────────────
async function boot() {
  await startClient({
    onOpen(sock) {
      owner.setFromSocket(sock);
      log.ok(`MontxBOT no ar  ·  modo privado exclusivo (${owner.jid || 'dono'})`);
    },
    onMessage: async (sock, msg, type) => {
      owner.setFromSocket(sock);
      const deps = {
        type, // 'notify' (ao vivo) | 'append' (histórico) | 'update'
        ownerJid: owner.jid || owner.lid,
        isOwner: (jid, participant) =>
          !!msg.key?.fromMe || owner.matchesOwnerJid(sock, participant) || owner.matchesOwnerJid(sock, jid),
        isOwnerPrivateChat: (jid) => owner.isPrivateOwnerChat(sock, jid),
        sendOwner: async (content) => {
          const dest = owner.jid || owner.lid;
          if (!dest || isGroup(dest)) return;
          return sock
            .sendMessage(dest, typeof content === 'string' ? { text: content } : content)
            .catch(() => {});
        }
      };
      await handleMessage(sock, msg, deps);
    }
  });
}

boot().catch((error) => {
  log.error('falha fatal no boot', error);
  process.exit(1);
});

// ── encerramento limpo ─────────────────────────────────────
let exiting = false;
function shutdown(signal) {
  if (exiting) process.exit(0);
  exiting = true;
  log.warn(`recebido ${signal} — salvando e saindo…`);
  flushStore();
  stopClient();
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => log.error('exceção não tratada', err));
process.on('unhandledRejection', (err) => log.error('promise rejeitada', err));
