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
import { handleGroupParticipantsUpdate } from './features/group-tools.js';
import { hasFfmpeg } from './util/ffmpeg.js';
import { bgStatus, warnIfBgUnconfigured } from './features/bgremoval.js';
import { envSummary } from './core/config.js';
import { isGroup } from './util/text.js';

ensureDirs();

banner([
  '◆ MontxBOT  ·  v7.0',
  '',
  platformBanner(),
  isTermux() ? '▸ Termux: pareamento por código (sem QR)' : '▸ Desktop: QR Code habilitado',
  '▸ Modo privado: exclusivo do dono (.ativar libera um chat)',
  '▸ Figurinha de link: .s <link> baixa e monta na hora',
  `▸ Remoção de fundo: ${bgStatus()[0]}`,
  `▸ Config .env: ${envSummary().loaded ? envSummary().file : `não encontrado em ${envSummary().file}`}`,
  hasFfmpeg() ? '▸ FFmpeg: ok' : '⚠ FFmpeg ausente (figurinhas não funcionarão)'
]);

// Avisa JÁ no boot (em vez de só quando alguém usar .fundo) se o .env não trouxe
// chave nenhuma de remoção de fundo — foi exatamente o sintoma do bug do ENV vazio.
warnIfBgUnconfigured();

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

const OWNER_LIDS_FILE = () => path.join(DATA_DIR, 'owner-lids.json');

function readSavedOwnerLids() {
  try {
    const data = JSON.parse(fs.readFileSync(OWNER_LIDS_FILE(), 'utf8'));
    return Array.isArray(data) ? data.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function saveOwnerLids(lids) {
  try {
    fs.writeFileSync(OWNER_LIDS_FILE(), JSON.stringify([...lids], null, 2));
  } catch {
    /* persistência é best-effort */
  }
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
  lids: new Set(readSavedOwnerLids()),
  /**
   * O WhatsApp passou a identificar participantes de grupo por @lid. Quando uma
   * mensagem traz o @lid junto do número real (participantPn/participantAlt),
   * aprendemos esse par para que o dono seja reconhecido também nos grupos,
   * onde só o @lid costuma chegar.
   */
  learnFromMessage(sock, msg) {
    const key = msg?.key || {};
    const ids = [
      key.participant, key.participantPn, key.participantAlt,
      key.senderLid, key.senderPn, msg?.participant,
      key.fromMe ? sock?.user?.id : null,
      key.fromMe ? sock?.user?.lid : null
    ].filter(Boolean).map(String);
    if (!ids.length) return;
    const digits = ids.map(bareDigits).filter(Boolean);
    const lids = ids.filter((id) => id.endsWith('@lid')).map(safeNormalize);
    if (!lids.length) return;
    const isOwnerMsg =
      Boolean(key.fromMe) ||
      digits.some((d) => this.numbers.has(d)) ||
      lids.some((l) => this.lids.has(l));
    if (!isOwnerMsg) return;
    let changed = false;
    for (const l of lids) {
      if (!this.lids.has(l)) {
        this.lids.add(l);
        changed = true;
      }
    }
    for (const d of digits) if (d) this.numbers.add(d);
    if (changed) saveOwnerLids(this.lids);
  },
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
      if (!this.lids.has(this.lid)) {
        this.lids.add(this.lid);
        saveOwnerLids(this.lids);
      }
    }
  },
  matchesOwnerJid(sock, candidate) {
    if (!candidate || isGroup(candidate)) return false;
    this.setFromSocket(sock);
    const norm = safeNormalize(candidate);
    const num = bareDigits(candidate);
    if (num && this.numbers.has(num)) return true;
    if (this.lids.has(norm)) return true;
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
      log.ok('MontxBOT no ar · modo privado exclusivo do dono');
    },
    onGroupParticipantsUpdate: handleGroupParticipantsUpdate,
    onMessage: async (sock, msg, type) => {
      owner.setFromSocket(sock);
      owner.learnFromMessage(sock, msg);
      const deps = {
        type, // 'notify' (ao vivo) | 'append' (histórico) | 'update'
        ownerJid: owner.jid || owner.lid,
        isOwner: (jid, participant) =>
          !!msg.key?.fromMe ||
          owner.matchesOwnerJid(sock, participant) ||
          (!isGroup(jid) && owner.matchesOwnerJid(sock, jid)),
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
  shutdown('falha no boot', 1);
});

// ── encerramento limpo ─────────────────────────────────────
let exiting = false;
function shutdown(signal, exitCode = 0) {
  if (exiting) return;
  exiting = true;
  process.exitCode = exitCode;
  log.warn(`recebido ${signal} — salvando e encerrando…`);
  stopClient();
  flushStore();
  setTimeout(() => process.exit(exitCode), 750).unref();
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (error) => {
  log.error('exceção não tratada; encerrando para evitar estado inconsistente', error);
  shutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (error) => {
  log.error('promise rejeitada sem tratamento; encerrando para evitar estado inconsistente', error);
  shutdown('unhandledRejection', 1);
});
