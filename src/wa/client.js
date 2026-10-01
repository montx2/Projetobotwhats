// 📡 CONEXÃO WhatsApp (Baileys) — resiliente e multiplataforma.
//
//   • Termux  → SEMPRE código de pareamento (nunca QR Code)
//   • Linux / Windows / macOS → QR Code no terminal (ou código, se preferir)
//
// Guarda a versão atual do WhatsApp Web em cache para evitar o loop do 405
// quando a versão embutida do Baileys fica velha.

import makeWASocket, {
  fetchLatestWaWebVersion,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  generateMessageIDV2,
  DisconnectReason,
  Browsers
} from '@whiskeysockets/baileys';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { ENV } from '../core/config.js';
import { log, banner, baileysLogger } from '../core/logger.js';
import { DATA_DIR, ensureDirs, readJson, writeJsonNow } from '../core/store.js';
import { isTermux, platformBanner } from '../core/platform.js';
import { markBotSent, isBotSent } from './cache.js';

export { markBotSent, isBotSent };

const AUTH_DIR = path.join(DATA_DIR, 'auth');
const PAIR_FILE = path.join(DATA_DIR, 'pairing-number.txt');
const PAIR_CODE_FILE = path.join(DATA_DIR, 'pairing-code.txt');
const VERSION_CACHE = path.join(DATA_DIR, 'wa-web-version.json');

let socket = null;
let stopping = false;
let reconnectTimer = null;

export function getSocket() {
  return socket;
}

function isValidVersion(v) {
  return Array.isArray(v) && v.length === 3 && v.every((n) => Number.isInteger(n) && n > 0);
}

function parseOverride(raw) {
  if (!raw) return null;
  const parts = String(raw)
    .split(/[,.]/)
    .map((n) => Number(n.trim()));
  return isValidVersion(parts) ? parts : null;
}

/** Resolve a versão do WA Web: override → ao vivo → cache → repositório Baileys. */
async function resolveWaVersion() {
  const override = parseOverride(ENV.waVersionOverride);
  if (override) return { version: override, source: 'override' };

  try {
    const live = await fetchLatestWaWebVersion({ timeout: 15_000 });
    if (live?.isLatest && isValidVersion(live.version)) {
      writeJsonNow('wa-web-version.json', { version: live.version, at: new Date().toISOString() });
      return { version: live.version, source: 'whatsapp-web' };
    }
  } catch (error) {
    log.warn(`versão WA ao vivo falhou: ${error.message}`);
  }

  const cached = readJson('wa-web-version.json', null);
  if (isValidVersion(cached?.version)) {
    return { version: cached.version, source: 'cache' };
  }

  try {
    const repo = await fetchLatestBaileysVersion({ timeout: 15_000 });
    if (repo?.isLatest && isValidVersion(repo.version)) {
      return { version: repo.version, source: 'baileys-repo' };
    }
  } catch {}

  return { version: undefined, source: 'padrão do Baileys' };
}

/** Número de pareamento: env → arquivo salvo → pergunta no terminal. */
async function getPairingNumber(creds) {
  if (creds.registered) return null;
  if (ENV.pairingNumber) return ENV.pairingNumber;
  try {
    const saved = fs.readFileSync(PAIR_FILE, 'utf8').trim();
    if (saved) return saved;
  } catch {}

  if (isTermux()) {
    // No Termux não existe QR: precisamos do número.
    const number = await askInTerminal(
      '📱 Digite seu número (DDI+DDD+número, só dígitos. Ex.: 5511999999999): '
    );
    const digits = String(number).replace(/\D/g, '');
    if (/^\d{10,15}$/.test(digits)) {
      savePairingNumber(digits);
      return digits;
    }
    throw new Error('Número inválido para pareamento. Use DDI+DDD+número. Ex.: ./pair 5511999999999');
  }
  return null; // desktop pode usar QR
}

function askInTerminal(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

export function savePairingNumber(digits) {
  ensureDirs();
  fs.writeFileSync(PAIR_FILE, digits + '\n', { mode: 0o600 });
}

function printQR(qr) {
  // import dinâmico para não pesar o boot
  import('qrcode-terminal')
    .then((mod) => {
      const qrcode = mod.default || mod;
      banner([
        '◆ ESCANEIE O QR CODE',
        '',
        'WhatsApp › Dispositivos conectados',
        '› Conectar um dispositivo'
      ]);
      qrcode.generate(qr, { small: true });
    })
    .catch(() => {
      log.warn('QR recebido (instale qrcode-terminal para desenhar):');
      log.raw(qr);
    });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const maskNumber = (n) => `+${n.slice(0, 4)}${'*'.repeat(Math.max(0, n.length - 8))}${n.slice(-4)}`;

/**
 * Inicia (ou reinicia) o socket do Baileys.
 * @param {object} handlers { onOpen, onMessage, onClosing }
 */
export async function startClient(handlers = {}) {
  ensureDirs();
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  // IMPORTANTE: requestPairingCode() grava creds.me (seu número) no disco. Se a
  // conexão cair antes de você digitar o código, o Baileys reconecta fazendo
  // LOGIN (porque creds.me existe) em vez de REGISTRO, o servidor recusa e o
  // código antigo fica morto. Sem pareamento concluído, sempre começamos limpo.
  if (!state.creds.registered && (state.creds.me || state.creds.pairingCode)) {
    state.creds.me = undefined;
    state.creds.pairingCode = undefined;
    await saveCreds();
  }
  try {
    fs.rmSync(PAIR_CODE_FILE, { force: true });
  } catch {}

  const { version, source } = await resolveWaVersion();
  log.info(`versão WA Web: ${version ? version.join('.') : 'padrão'} (${source})`);

  const pairingNumber = await getPairingNumber(state.creds);

  const clientSocket = makeWASocket({
    version,
    // sem sessão ainda: dá tempo para o pareamento antes de reconectar
    connectTimeoutMs: state.creds.registered ? 45_000 : 150_000,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, undefined)
    },
    browser: isTermux() ? Browsers.ubuntu('Chrome') : Browsers.windows('Chrome'),
    printQRInTerminal: false, // nós controlamos o QR
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: true,
    syncFullHistory: false,
    // Essencial para bot pessoal: o dono comanda o bot a partir da própria
    // conta, então precisamos receber as mensagens fromMe. (Os próprios envios
    // do bot nunca começam com prefixo de comando, então não há loop.)
    emitOwnEvents: true,
    logger: baileysLogger
  });
  clientSocket.creds = state.creds;

  // Envolve sendMessage para registrar o ID ANTES que o Baileys dispare messages.upsert
  // (evita que o próprio envio do bot acione auto-download, view once por resposta, etc.)
  const origSendMessage = clientSocket.sendMessage.bind(clientSocket);
  clientSocket.sendMessage = async (jid, content, options = {}) => {
    const msgId =
      options?.messageId ||
      (typeof generateMessageIDV2 === 'function' ? generateMessageIDV2(clientSocket.user?.id) : undefined);
    if (msgId) markBotSent(msgId);
    const res = await origSendMessage(jid, content, msgId ? { ...options, messageId: msgId } : options);
    if (res?.key?.id) markBotSent(res.key.id);
    return res;
  };

  socket = clientSocket;

  clientSocket.ev.on('creds.update', saveCreds);

  clientSocket.ev.on('connection.update', (update) => {
    if (socket !== clientSocket) return;
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // O 1º evento 'qr' significa: handshake concluído e servidor pronto para
      // parear. É o momento certo de pedir o código (1 vez por socket).
      if (pairingNumber) triggerPairing();
      if (isTermux() || pairingNumber) return;
      printQR(qr);
    }

    if (connection === 'open') {
      const user = clientSocket.user;
      try {
        fs.rmSync(PAIR_CODE_FILE, { force: true });
      } catch {}
      banner([
        '◆ MontxBOT',
        '',
        `✓ Conectado como ${user?.name || ''} (${user?.id?.split('@')[0] || '?'})`,
        platformBanner(),
        '▸ Digite .menu no WhatsApp para começar'
      ]);
      handlers.onOpen?.(clientSocket);
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      log.warn(`conexão fechada (código ${code ?? '?'})${loggedOut ? ' — sessão expirada' : ''}`);

      if (stopping) return;

      if (loggedOut) {
        // sessão morta: limpa credenciais e repareia na próxima subida
        try {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        } catch {}
        log.warn('credenciais removidas — iniciando novo pareamento…');
      }

      scheduleReconnect(handlers, code === DisconnectReason.restartRequired ? 500 : loggedOut ? 2000 : 4000, code);
    }
  });

  clientSocket.ev.on('messages.upsert', async ({ messages, type }) => {
    if (socket !== clientSocket) return;
    for (const msg of messages) {
      if (msg?.key?.id && isBotSent(msg.key.id)) continue;
      try {
        await handlers.onMessage?.(clientSocket, msg, type);
      } catch (error) {
        log.error('erro no handler de mensagem', error);
      }
    }
  });

  // pedidos de mídia antiga (placeholders etc.)
  clientSocket.ev.on('messages.update', async (updates) => {
    if (socket !== clientSocket) return;
    for (const { key, update } of updates || []) {
      const proto = update?.message?.protocolMessage;
      if (proto && (proto.type === 0 || proto.type === 'REVOKE')) {
        try {
          await handlers.onMessage?.(clientSocket, { key, message: { protocolMessage: proto }, messageTimestamp: Date.now() / 1000 }, 'update');
        } catch {}
      }
    }
  });

  // Pareamento por código (Termux sempre; desktop opcional).
  // Cada socket novo gera um código NOVO; o anterior morre junto com o socket.
  let pairingStarted = false;
  function triggerPairing() {
    if (pairingStarted || state.creds.registered) return;
    pairingStarted = true;
    (async () => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        if (stopping || socket !== clientSocket || state.creds.registered) return;
        try {
          const code = await clientSocket.requestPairingCode(pairingNumber);
          if (stopping || socket !== clientSocket) return;
          const pretty = /^[A-Z0-9]{8}$/.test(code) ? `${code.slice(0, 4)}-${code.slice(4)}` : code;

          try {
            fs.writeFileSync(PAIR_CODE_FILE, `${pretty}\n`, { mode: 0o600 });
          } catch {}

          banner([
            '◆ CÓDIGO DE PAREAMENTO',
            '',
            `    ${pretty}`,
            '',
            `Número: ${maskNumber(pairingNumber)}  (deve ser o MESMO do WhatsApp)`,
            '⚠ Digite agora. Não feche o Termux nem deixe a rede cair.',
            'Se surgir outro código, use somente o mais novo.',
            '',
            'WhatsApp › Dispositivos conectados',
            '› Conectar com número de telefone'
          ]);
          return;
        } catch (error) {
          log.warn(`pareamento (tentativa ${attempt}/3): ${String(error?.message || error).slice(0, 120)}`);
          if (stopping || socket !== clientSocket) return;
          if (attempt < 3) await sleep(3000);
        }
      }
      log.error('não consegui gerar o código de pareamento após 3 tentativas. Verifique a internet e tente novamente.');
    })();
  }

  if (!state.creds.registered && pairingNumber) {
    // plano B: se o 'qr' demorar, avisa em vez de ficar mudo
    setTimeout(() => {
      if (!pairingStarted && socket === clientSocket && !stopping) {
        log.warn('ainda aguardando o servidor do WhatsApp liberar o pareamento… confira a internet.');
      }
    }, 30_000).unref();
  }

  return clientSocket;
}

function scheduleReconnect(handlers, delayMs, code) {
  if (stopping || reconnectTimer) return;
  log.info(`reconectando em ${delayMs / 1000}s…`);
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      await startClient(handlers);
    } catch (error) {
      log.error(`falha ao reconectar: ${error.message}`);
      scheduleReconnect(handlers, 15_000, code);
    }
  }, delayMs);
}

export function stopClient() {
  stopping = true;
  try {
    socket?.end(undefined);
  } catch {}
}
