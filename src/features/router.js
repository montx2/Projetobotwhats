// 🧭 ROUTER — despacha comandos, aplica controles explícitos por chat e acesso.
//
// REGRAS DE OURO:
// 1) View Once e Anti-Delete enviam EXCLUSIVAMENTE para o privado do dono
//    (0 rastros nos chats/grupos) e são as ÚNICAS funções invisíveis para os outros.
// 2) Por padrão, o bot SÓ funciona no privado do próprio dono.
// 3) Quando o dono dá `.ativar` (ou `. ativar`) em um grupo ou chat privado,
//    aquele chat ganha acesso aos comandos públicos. View Once e Anti-Delete
//    continuam privados; configurações de grupo exigem administrador do grupo.

import { isStale, alreadySeen } from '../core/freshness.js';
import { cfg, envSummary } from '../core/config.js';
import { shortUrl } from '../core/http.js';
import { log } from '../core/logger.js';
import { messageCache, isBotSent, markBotSent, containsViewOnce } from '../wa/cache.js';
import { extractAnyText, isIgnored, normalizeIgnoreTarget, handleDelete, statusText } from './antidelete.js';
import { SYM, header, section, card, footer, ok, fail, warn, wait, usage, kv, toggle } from '../core/ui.js';
import { isViewOnce, onViewOnceMessage, unwrapViewOnce } from './viewonce.js';
import { makeSticker, packInfo, isAnimatedWebp, parseFit } from './sticker.js';
import { stickerSourcesForCommand } from './stickerlink.js';
import { removeBackground, bgStatus, bgPools } from './bgremoval.js';
import { aiChat, aiImage, aiVoice, aiTranslate, aiSummary, resetChatMemory, resetChatMemoryForChat, aiStatus } from './ai.js';
import { resolveDownload, sendDownload, parseQuality, autoDownload, isKnownSocialUrl } from './download.js';
import {
  ownerMenu,
  publicMenu,
  mainMenu,
  downloadMenu,
  stickerMenu,
  antiDeleteMenu,
  infoText
} from './menu.js';
import { extractUrls, truncate, uptimeText, isGroup, normalizeJid, parseBool } from '../util/text.js';
import {
  clearGroupSettings,
  ensureGroupSettings,
  getGroupMetadata,
  getGroupSettings,
  isBotGroupAdministrator,
  moderateIncomingGroupLinks,
  normalizeAllowDomain,
  requireAuthorizedGroup,
  requireGroupAdministrator
} from './group-tools.js';
import { hasFfmpeg } from '../util/ffmpeg.js';
import { cobaltPool } from './downloaders/cobalt.js';
import { hasYtDlp, isYtdlpEnabled, findYtdlp } from './downloaders/ytdlp.js';
import { SlidingWindowLimiter } from '../core/limiter.js';
import {
  convertCurrency,
  formatCurrencyMessage,
  formatPublicHolidaysMessage,
  formatWeatherMessage,
  getPublicHolidays,
  getWeatherByCity
} from './public-apis.js';
import { clearChatGames, handleGameCommand, isGameCommand, tryHandleDirectGameMove } from './games.js';

const STARTED_AT = Date.now();
const expensiveLimiter = new SlidingWindowLimiter({ limit: 6, windowMs: 60_000, minIntervalMs: 2_000 });
const pollUserLimiter = new SlidingWindowLimiter({ limit: 2, windowMs: 5 * 60_000, minIntervalMs: 30_000, maxKeys: 5000 });
const pollGroupLimiter = new SlidingWindowLimiter({ limit: 20, windowMs: 60 * 60_000, minIntervalMs: 5_000, maxKeys: 1024 });
const groupControlLimiter = new SlidingWindowLimiter({ limit: 10, windowMs: 60_000, minIntervalMs: 0, maxKeys: 5000 });
const GROUP_CONTROL_COMMANDS = new Set(['boasvindas', 'bemvindo', 'welcome', 'antilink', 'anti-link']);
const MAX_CONCURRENT_EXPENSIVE = 3;
let activeExpensive = 0;
const EXPENSIVE_COMMANDS = new Set([
  's', 'fig', 'figu', 'sticker', 'stiker', 'figurinha', 'sfundo', 'stickerfundo', 'sfundinho',
  'fundo', 'removefundo', 'rmbg', 'removebg', 'ia', 'ai', 'gpt', 'chat',
  'clima', 'tempo', 'previsao', 'previsão', 'cotacao', 'cotação', 'cambio', 'câmbio', 'feriados',
  'criar', 'img',
  'gerar', 'imagine', 'desenhar', 'voz', 'tts', 'falar', 'traduz', 'traduzir', 'resumo', 'resumir',
  'dl', 'download', 'baixar', 'tt', 'tiktok', 'tiktokdl', 'ttmp3', 'tiktokmp3', 'ttaudio',
  'pin', 'pinterest', 'pint', 'insta', 'instagram', 'ig', 'reels', 'yt', 'youtube', 'ytb',
  'video', 'ytmp3', 'youtubemp3', 'ytaudio', 'mp3', 'tw', 'twitter', 'x', 'tweet', 'face', 'facebook', 'fb'
]);
const MEDIA_KEYS = new Set(['imageMessage', 'videoMessage', 'audioMessage', 'stickerMessage', 'documentMessage']);
const MESSAGE_WRAPPERS = new Set([
  'ephemeralMessage', 'deviceSentMessage', 'documentWithCaptionMessage', 'editedMessage',
  'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension'
]);

function hasNestedMedia(message, depth = 0) {
  if (!message || typeof message !== 'object' || depth > 8) return false;
  if (Object.keys(message).some((key) => MEDIA_KEYS.has(key))) return true;
  return [...MESSAGE_WRAPPERS].some((wrapper) => hasNestedMedia(message[wrapper]?.message, depth + 1));
}

function hasQuotedMessage(message, depth = 0) {
  if (!message || typeof message !== 'object' || depth > 8) return false;
  for (const [key, value] of Object.entries(message)) {
    if (value?.contextInfo?.quotedMessage) return true;
    if (MESSAGE_WRAPPERS.has(key) && hasQuotedMessage(value?.message, depth + 1)) return true;
  }
  return false;
}

function isExpensiveRequest(command, msg) {
  if (!EXPENSIVE_COMMANDS.has(command.name)) return false;
  const name = command.name;
  const args = command.args || [];
  const quoted = hasQuotedMessage(msg.message);
  const hasAttachment = hasNestedMedia(msg.message);
  if (['s', 'fig', 'figu', 'sticker', 'stiker', 'figurinha', 'sfundo', 'stickerfundo', 'sfundinho', 'fundo', 'removefundo', 'rmbg', 'removebg'].includes(name)) {
    return Boolean(args.length || hasAttachment || quoted);
  }
  if (['dl', 'download', 'baixar', 'tt', 'tiktok', 'tiktokdl', 'ttmp3', 'tiktokmp3', 'ttaudio', 'pin', 'pinterest', 'pint', 'insta', 'instagram', 'ig', 'reels', 'yt', 'youtube', 'ytb', 'video', 'ytmp3', 'youtubemp3', 'ytaudio', 'mp3', 'tw', 'twitter', 'x', 'tweet', 'face', 'facebook', 'fb'].includes(name)) {
    return Boolean(pickUrl(args));
  }
  if (['ia', 'ai', 'gpt', 'chat'].includes(name)) {
    if (args[0]?.toLowerCase() === 'reset') return false;
    return Boolean(args.length || quoted);
  }
  return Boolean(args.length || quoted);
}

export { isViewOnce, unwrapViewOnce };

// Comandos do dono para ativar/desativar chats ou grupos
const AUTH_COMMANDS = new Set([
  'ativar',
  'desativar',
  'ativos',
  'autorizar',
  'permitir',
  'liberar',
  'desautorizar',
  'revogar',
  'bloquear',
  'autorizados'
]);

// Comandos BLOQUEADOS para terceiros nos chats/grupos ativados com .ativar.
// São exatamente as duas funções 100% privadas (View Once e Anti-Delete) mais
// os comandos que mudam o comportamento do bot (só o dono mexe neles).
// TODO O RESTO — figurinhas, downloads de qualquer rede, IA, voz, tradução —
// fica liberado para quem o dono autorizou.
const OWNER_ONLY_COMMANDS = new Set([
  // 👁️ View Once (nunca aparece nem responde para terceiros)
  'vo',
  'visu',
  'viewonce',
  'verdepois',
  // 🛡️ Anti-Delete (nunca aparece nem responde para terceiros)
  'antidelete',
  'antidel',
  'ad',
  'apagadas',
  'deletadas',
  // ⚙️ Configuração e diagnóstico do bot
  'config',
  'pools',
  'doctor'
]);

const BOT_OUTPUT_PREFIXES = [
  '⏳ ',
  '⬇️ ',
  '📤 ',
  '✅ ',
  '❌ ',
  '😕 ',
  '🏓 ',
  '👁️ ',
  '🛡️ ',
  '🎭 ',
  '🖌️ ',
  '🎬 ',
  '🏷️ ',
  '🗜️ ',
  '🧠 ',
  '🎨 ',
  '🔊 ',
  '🌍 ',
  '📄 ',
  '🎵 ',
  '🎶 ',
  '📌 ',
  '📸 ',
  '⚙️ ',
  '🔑 ',
  '🩺 ',
  '🔒 ',
  '🔓 ',
  '🖼️ ',
  '🤔 ',
  '╭━━',
  '╭─ ◆',
  '✦ '
];

function isBotGeneratedText(text) {
  if (!text) return false;
  return BOT_OUTPUT_PREFIXES.some((p) => text.startsWith(p));
}

function bareId(jid) {
  return normalizeJid(jid);
}

function bareDigits(jid) {
  if (!jid || isGroup(jid)) return '';
  return String(jid).split('@')[0].split(':')[0].replace(/\D/g, '');
}

/** Verifica se o chat ou remetente foi ativado/autorizado explicitamente pelo dono. */
export function isAuthorizedTarget(jid, participant, list = cfg.get().autorizados) {
  if (!Array.isArray(list) || !list.length) return false;
  const candidates = [jid, participant].filter(Boolean);
  for (const rule of list) {
    const r = bareId(rule);
    const rDigits = bareDigits(rule);
    for (const c of candidates) {
      if (bareId(c) === r) return true;
      const cDigits = bareDigits(c);
      if (rDigits && cDigits && rDigits === cDigits) return true;
    }
  }
  return false;
}

/** Normaliza o alvo para .ativar / .desativar / .autorizar / .desautorizar */
export function normalizeAuthTarget(arg, msg) {
  const quotedParticipant = msg?.message?.extendedTextMessage?.contextInfo?.participant;
  const a = String(arg || '').trim().toLowerCase();
  if (!a && quotedParticipant && !isGroup(msg.key.remoteJid)) return bareId(quotedParticipant);
  if (!a || ['aqui', 'este chat', 'esse chat', 'grupo'].includes(a)) return bareId(msg.key.remoteJid);
  const cleanNum = a.replace(/\D/g, '');
  if (!a.includes('@') && cleanNum.length >= 8 && cleanNum.length <= 20) {
    return `${cleanNum}@s.whatsapp.net`;
  }
  return bareId(a);
}

/** Revoke = protocolMessage de apagar para todos (upsert ou messages.update). */
function isRevokeMessage(msg) {
  const proto = msg?.message?.protocolMessage;
  return !!proto && (proto.type === 0 || proto.type === 'REVOKE');
}

let staleCount = 0;
let staleTimer = null;
function noteStale() {
  staleCount += 1;
  if (staleTimer) return;
  staleTimer = setTimeout(() => {
    log.info(`🕰️ ${staleCount} mensagem(ns) antiga(s) ignorada(s) (backlog do WhatsApp ao conectar)`);
    staleCount = 0;
    staleTimer = null;
  }, 3000);
  staleTimer.unref?.();
}

/**
 * Controlador de progresso por edição:
 * a 1ª mensagem de texto é enviada citando o usuário; todas as atualizações
 * seguintes EDITAM a mesma mensagem (`{ text, edit: sentKey }`), evitando
 * várias mensagens soltas no chat.
 */
export function createProgress(sock, jid, quotedMsg) {
  let sentKey = null;
  let lastText = null;
  let chain = Promise.resolve(null);

  const update = (content) => {
    const payload = typeof content === 'string' ? { text: content } : { ...content };
    const text = payload.text;
    if (typeof text === 'string' && text === lastText && sentKey) {
      return chain;
    }
    if (typeof text === 'string') {
      lastText = text;
    }

    chain = chain.then(async () => {
      if (sentKey && typeof text === 'string') {
        try {
          const edited = await sock.sendMessage(jid, { text, edit: sentKey });
          if (edited?.key?.id) {
            markBotSent(edited.key.id);
            if (!sentKey.id) sentKey = edited.key;
          }
          return edited;
        } catch (err) {
          log.warn(`edição de progresso falhou, enviando nova: ${err.message}`);
        }
      }
      try {
        const sent = await sock.sendMessage(
          jid,
          { ...payload, ...(quotedMsg ? { quoted: quotedMsg } : {}) },
          quotedMsg ? { quoted: quotedMsg } : undefined
        );
        if (sent?.key) {
          sentKey = sent.key;
          markBotSent(sent.key.id);
        }
        return sent;
      } catch (err) {
        log.warn(`envio falhou: ${err.message}`);
        return null;
      }
    });

    return chain;
  };

  return {
    update,
    get key() {
      return sentKey;
    },
    get hasSent() {
      return !!sentKey;
    }
  };
}

/** Envia uma figurinha WebP com todos os atributos esperados pelo WhatsApp/Baileys. */
async function sendStickerMessage(sock, jid, webp, quotedMsg) {
  const animated = isAnimatedWebp(webp);
  const sent = await sock.sendMessage(
    jid,
    {
      sticker: webp,
      mimetype: 'image/webp',
      width: 512,
      height: 512,
      isAnimated: animated
    },
    quotedMsg ? { quoted: quotedMsg } : undefined
  );
  if (sent?.key?.id) markBotSent(sent.key.id);
  return sent;
}

/**
 * Fontes da figurinha do comando: mídia anexada/citada OU — novidade — um link
 * no próprio comando (ou na mensagem citada), baixado pelo downloader universal.
 * Se nada for encontrado devolve listas vazias; se o link falhar, avisa e devolve null.
 *
 * @returns {Promise<{sources: Array, failures: string[], skipped: number}|null>}
 */
async function stickerSourcesOrReply({ sock, msg, args, allowViewOnce, reply }) {
  try {
    return await stickerSourcesForCommand({ sock, msg, args, allowViewOnce, onProgress: reply });
  } catch (error) {
    log.warn('figurinha por link falhou', { name: error?.name, status: error?.status, code: error?.code });
    await reply(
      fail(
        'Não consegui criar a figurinha',
        `${String(error.message || error).slice(0, 260)}\n` +
          `${SYM.item} Confira se o link abre no navegador  ${SYM.detail}  ou baixe antes com \`.dl <link>\``
      )
    );
    return null;
  }
}

/** Rodapé discreto do "figurinha pronta": de onde veio, o que falhou e o que sobrou. */
function stickerSourceNote(sources, failures = [], skipped = 0) {
  const origins = [...new Set(sources.map((s) => s.via).filter(Boolean))];
  const note = [];
  if (origins.length) note.push(origins.join(' · '));
  if (failures.length) note.push(`${SYM.warn} ${truncate(failures[0], 140)}${failures.length > 1 ? ` (+${failures.length - 1})` : ''}`);
  if (skipped > 0) note.push(`_+${skipped} link(s) ignorado(s) — envio até 3 por vez_`);
  return truncate(note.join('\n'), 300);
}

/**
 * Ponto de entrada para TODA mensagem recebida.
 */
export async function handleMessage(sock, msg, deps) {
  const { ownerJid, isOwner, sendOwner } = deps;
  if (!msg?.message) return;
  const jid = msg.key?.remoteJid;
  if (!jid || jid === 'status@broadcast') return;

  // Ignora imediatamente mensagens enviadas pelo próprio bot (evita loop com emitOwnEvents)
  if (msg.key?.id && isBotSent(msg.key.id)) return;
  const text = extractAnyText(msg.message).trim();
  if (msg.key?.fromMe && isBotGeneratedText(text)) return;

  const senderIsOwner = Boolean(msg.key?.fromMe || isOwner?.(jid, msg.key.participant));
  const inOwnerPrivate =
    typeof deps.isOwnerPrivateChat === 'function'
      ? deps.isOwnerPrivateChat(jid, msg)
      : !isGroup(jid) && Boolean(isOwner?.(jid));
  const authorized = isAuthorizedTarget(jid, msg.key.participant);
  const allowedChat = inOwnerPrivate || authorized;
  const revoke = isRevokeMessage(msg);
  const viewOnce = isViewOnce(msg.message);
  const containsViewOncePayload = containsViewOnce(msg.message);

  // Nenhum histórico é armazenado por padrão. Só chats autorizados com
  // Anti-Delete explicitamente habilitado entram no cache persistente; View Once
  // (inclusive citada) nunca é retida e revogações não substituem a original.
  const antiDelete = cfg.get().antiDelete;
  const antiDeleteEnabled = Array.isArray(antiDelete.chats) &&
    antiDelete.chats.some((chat) => bareId(chat) === bareId(jid)) &&
    !isIgnored(jid, antiDelete.ignorar);
  if (!revoke && allowedChat && antiDeleteEnabled && !containsViewOncePayload) {
    messageCache.put(msg, { persist: true, ttlMs: 24 * 60 * 60_000 });
  }

  // Histórico/backlog não executa ações; cache somente existe nos chats com
  // Anti-Delete opt-in, e nunca se armazena conteúdo de chats alheios.
  if (isStale(msg, deps.type) || (!revoke && alreadySeen(msg))) {
    noteStale();
    return;
  }

  if (revoke) {
    if (allowedChat) await handleDelete(sock, msg, { ownerJid }).catch((e) => log.warn(`antidelete: ${e.message}`));
    return;
  }

  // Moderação de links só roda em grupos autorizados e com opt-in explícito.
  // Se houver violação, a mensagem não segue para comandos nem auto-download.
  if (authorized && isGroup(jid) && await moderateIncomingGroupLinks(sock, msg, text, { owner: senderIsOwner })) return;

  // Automação View Once requer habilitação explícita para este JID.
  const autoViewOnce = cfg.get().viewOnce.autoChats || [];
  if (!msg.key.fromMe && allowedChat && autoViewOnce.some((chat) => bareId(chat) === bareId(jid)) && viewOnce) {
    await onViewOnceMessage(sock, msg, { ownerJid }).catch((e) => log.warn(`view once: ${e.message}`));
  }

  const prefixes = cfg.get().prefixos;
  const command = parseCommand(text, prefixes);
  const isAuthCmd = Boolean(command && AUTH_COMMANDS.has(command.name));

  // 4) CONTROLE DE ACESSO:
  // • No privado do dono (inOwnerPrivate): acesso TOTAL, inclusive View Once e Anti-Delete.
  // • Dono digitou .ativar / .desativar / .ativos em qualquer chat: executa.
  // • Chat/grupo ativado com .ativar (authorized): comandos públicos liberados;
  //   recursos privados/de configuração seguem bloqueados ou exigem admin de grupo.
  // • Caso contrário: silêncio absoluto (0 mensagens).
  if (command) {
    if (isAuthCmd) {
      if (!senderIsOwner) return; // estranhos tentando dar .ativar são ignorados em silêncio
    } else if (!inOwnerPrivate) {
      // Fora do privado do dono: precisa estar ativado e não ser comando exclusivo do dono
      if (!authorized) return;
      if (OWNER_ONLY_COMMANDS.has(command.name)) return; // View Once / Anti-Delete: 0 traços
    }
    if (isGroup(jid) && GROUP_CONTROL_COMMANDS.has(command.name)) {
      const actor = bareId(msg.key?.participant || jid);
      if (!groupControlLimiter.consume(`${bareId(jid)}:${actor}`).allowed) return;
    }

    log.cmd(`${command.name}${command.args.length ? ` (${command.args.length} argumento(s))` : ''} · ${isGroup(jid) ? 'grupo' : 'privado'}`);
    const progress = createProgress(sock, jid, msg);
    const reply = async (content) => {
      if (typeof content === 'string') return progress.update(content);
      if (content && typeof content === 'object' && 'text' in content && !('edit' in content)) {
        return progress.update(content);
      }
      const sent = await sock
        .sendMessage(jid, { ...content, quoted: msg }, { quoted: msg })
        .catch((e) => {
          log.warn(`envio falhou: ${e.message}`);
          return null;
        });
      if (sent?.key?.id) markBotSent(sent.key.id);
      return sent;
    };
    const expensive = isExpensiveRequest(command, msg);
    if (expensive) {
      // Privado do dono: o operador não precisa de janela de silêncio entre
      // comandos — duas figurinhas seguidas (`.s <link>` e `.s inteira <link>`)
      // são uso normal, e o descarte silencioso parecia bot quebrado.
      // O limitador anti-spam segue valendo para os demais chats; o teto de
      // concorrência vale para todos.
      if (!inOwnerPrivate) {
        const actor = msg.key?.participant || jid;
        const rate = expensiveLimiter.consume(`${jid}:${actor}`);
        if (!rate.allowed) return; // silencioso para não transformar o limitador em fonte de spam
      }
      if (activeExpensive >= MAX_CONCURRENT_EXPENSIVE) {
        await reply(warn('Bot ocupado', 'aguarde um pouco antes de iniciar outra tarefa pesada'));
        return;
      }
      activeExpensive++;
    }
    try {
      await runCommand(sock, msg, command, {
        ownerJid,
        inOwnerPrivate,
        isOwner: () => senderIsOwner,
        reply,
        progress,
        sendOwner
      });
    } catch (error) {
      log.error(`comando .${command.name} falhou`, { name: error?.name, status: error?.status, code: error?.code });
      // 600 em vez de 220: as mensagens de diagnóstico (ex.: remoção de fundo sem
      // chave, com o caminho do .env) precisam chegar inteiras ao usuário.
      await reply(fail('Não foi possível concluir', String(error.message || error).slice(0, 600))).catch(() => {});
    } finally {
      if (expensive) activeExpensive = Math.max(0, activeExpensive - 1);
    }
    return;
  }

  // 5) Movimentos sem prefixo: somente em chats liberados ou no privado do dono.
  if (inOwnerPrivate || authorized) {
    const progress = createProgress(sock, jid, msg);
    const directReply = async (content) => progress.update(content);
    const handledGameMove = await tryHandleDirectGameMove(sock, msg, text, {
      reply: directReply,
      authorized,
      owner: inOwnerPrivate && senderIsOwner
    });
    if (handledGameMove) return;
  }

  // 6) Auto-download de links soltos no privado do dono e nos chats/grupos ativados.
  //    Grupos não autorizados permanecem silenciosos.
  if (inOwnerPrivate || authorized) {
    const urls = extractUrls(text);
    if (urls.length && cfg.get().autoDownload && urls.some(isKnownSocialUrl)) {
      if (!inOwnerPrivate) {
        const actor = msg.key?.participant || jid;
        const rate = expensiveLimiter.consume(`${jid}:${actor}`);
        if (!rate.allowed) return;
      }
      const progress = createProgress(sock, jid, msg);
      const reply = async (t) => progress.update(t);
      if (activeExpensive >= MAX_CONCURRENT_EXPENSIVE) {
        await reply(warn('Bot ocupado', 'aguarde um pouco antes de iniciar outra tarefa pesada'));
        return;
      }
      activeExpensive++;
      try {
        await autoDownload(sock, msg, urls.filter(isKnownSocialUrl).slice(0, 3), { reply });
      } finally {
        activeExpensive = Math.max(0, activeExpensive - 1);
      }
    }
  }
}

/** Acha a primeira URL nos argumentos (funciona com a qualidade em qualquer posição). */
function pickUrl(args) {
  const url = (args || []).find((a) => /^https?:\/\//i.test(a));
  return url || null;
}

/**
 * Faz o parse de comandos aceitando tanto `.ativar` quanto `. ativar` (com espaço após o ponto),
 * mas ignorando reticências (`...`) ou números (`.5`).
 */
function parseCommand(text, prefixes) {
  if (!text) return null;
  for (const prefix of prefixes) {
    if (text.startsWith(prefix)) {
      const body = text.slice(prefix.length).trim();
      if (!body) return null;
      const [name, ...args] = body.split(/\s+/);
      if (!/^[a-zA-ZÀ-ÿ]/.test(name)) return null;
      return { name: name.toLowerCase(), args, raw: body };
    }
  }
  return null;
}

function requireOwner(ctx, msg) {
  if (!ctx.isOwner(msg.key.remoteJid, msg.key.participant)) {
    throw new Error('este comando é exclusivo do dono');
  }
}

function groupFeatureStatus(jid) {
  const settings = getGroupSettings(jid) || {};
  const antiLink = settings.antiLink && typeof settings.antiLink === 'object' && !Array.isArray(settings.antiLink)
    ? settings.antiLink
    : {};
  return {
    welcome: settings.welcome === true,
    goodbye: settings.goodbye === true,
    antiLink: {
      enabled: antiLink.enabled === true,
      allowlist: Array.isArray(antiLink.allowlist)
        ? [...new Set(antiLink.allowlist.map(normalizeAllowDomain).filter(Boolean))].slice(0, 50)
        : []
    }
  };
}

async function welcomeCommand(sock, msg, args, ctx, owner) {
  const jid = requireAuthorizedGroup(msg.key.remoteJid);

  const first = String(args[0] || '').toLowerCase();
  const isGoodbye = ['saida', 'saída', 'despedida', 'tchau', 'goodbye'].includes(first);
  const mode = isGoodbye ? 'goodbye' : 'welcome';
  const value = isGoodbye ? args[1] : args[0];
  const settings = groupFeatureStatus(jid);
  if (!value || ['status', 'lista'].includes(String(value).toLowerCase())) {
    return ctx.reply(card([
      header('Boas-vindas', 'configuração por grupo · desativada por padrão'),
      kv('Entrada de novos membros', toggle(settings.welcome, 'ligada', 'desligada')),
      kv('Mensagem de saída', toggle(settings.goodbye, 'ligada', 'desligada')),
      usage('.boasvindas on|off', '.boasvindas saida on', 'Somente administradores do grupo (ou o dono do bot) podem alterar.')
    ]));
  }

  const enabled = parseBool(value);
  if (enabled === null) throw new Error('uso: .boasvindas on|off ou .boasvindas saida on|off');
  await requireGroupAdministrator(sock, msg, { owner });
  const current = ensureGroupSettings(jid);
  current[mode] = enabled;
  cfg.save();
  return ctx.reply(ok(
    mode === 'welcome'
      ? enabled ? 'Boas-vindas ativadas' : 'Boas-vindas desativadas'
      : enabled ? 'Mensagem de saída ativada' : 'Mensagem de saída desativada',
    'a configuração vale somente para este grupo'
  ));
}

async function antiLinkCommand(sock, msg, args, ctx, owner) {
  const jid = requireAuthorizedGroup(msg.key.remoteJid);
  const sub = String(args[0] || 'status').toLowerCase();
  const rest = args.slice(1).join(' ').trim();
  const settings = groupFeatureStatus(jid).antiLink;

  if (['status', 'lista', 'list'].includes(sub)) {
    let botAdmin = 'necessário para ativar';
    if (settings.enabled) {
      try {
        botAdmin = isBotGroupAdministrator(await getGroupMetadata(sock, jid), sock) ? 'sim' : 'não — sem permissão de remoção';
      } catch {
        botAdmin = 'não foi possível confirmar';
      }
    }
    return ctx.reply(card([
      header('Proteção de links', settings.enabled ? 'ativa' : 'desativada'),
      kv('Bot administrador', botAdmin),
      kv('Domínios permitidos', settings.allowlist.length ? settings.allowlist : ['nenhum']),
      '_Links HTTP(S), www e domínios simples fora da lista podem ser removidos. Administradores do grupo são excluídos do filtro._',
      usage('.antilink on|off', '.antilink permitir exemplo.com', 'Ativação exige que o bot também seja administrador.')
    ]));
  }

  if (['on', 'ligar', 'ativar', 'off', 'desligar', 'desativar'].includes(sub)) {
    if (args.length > 1) throw new Error('uso: .antilink on ou .antilink off');
    await requireGroupAdministrator(sock, msg, { owner });
    const enabled = ['on', 'ligar', 'ativar'].includes(sub);
    if (enabled) {
      let metadata;
      try {
        metadata = await getGroupMetadata(sock, jid);
      } catch {
        throw new Error('não consegui verificar o grupo; tente novamente');
      }
      if (!isBotGroupAdministrator(metadata, sock)) {
        throw new Error('promova o bot a administrador antes de ativar a remoção de links');
      }
    }
    ensureGroupSettings(jid).antiLink.enabled = enabled;
    cfg.save();
    return ctx.reply(ok(enabled ? 'Proteção de links ativada' : 'Proteção de links desativada'));
  }

  if (['permitir', 'allow', 'liberar'].includes(sub)) {
    if (!rest) throw new Error('uso: .antilink permitir exemplo.com');
    await requireGroupAdministrator(sock, msg, { owner });
    const domain = normalizeAllowDomain(rest);
    if (!domain) throw new Error('informe apenas um domínio válido, sem URL, caminho, porta ou curinga');
    const allowlist = ensureGroupSettings(jid).antiLink.allowlist;
    if (allowlist.includes(domain)) return ctx.reply(ok('Domínio já permitido', domain));
    if (allowlist.length >= 50) throw new Error('a lista deste grupo já atingiu o limite de 50 domínios');
    allowlist.push(domain);
    cfg.save();
    return ctx.reply(ok('Domínio permitido', `${domain} e seus subdomínios`));
  }

  if (['remover', 'remove', 'del'].includes(sub)) {
    if (!rest) throw new Error('uso: .antilink remover exemplo.com');
    await requireGroupAdministrator(sock, msg, { owner });
    const domain = normalizeAllowDomain(rest);
    if (!domain) throw new Error('informe apenas um domínio válido, sem URL, caminho, porta ou curinga');
    const allowlist = ensureGroupSettings(jid).antiLink.allowlist;
    const filtered = allowlist.filter((item) => item !== domain);
    if (filtered.length === allowlist.length) return ctx.reply(warn('Domínio não estava na lista', domain));
    ensureGroupSettings(jid).antiLink.allowlist = filtered;
    cfg.save();
    return ctx.reply(ok('Domínio removido da lista', domain));
  }

  throw new Error('uso: .antilink status | on | off | permitir <domínio> | remover <domínio>');
}

function revokeChatFeatures(jid) {
  const target = bareId(jid);
  messageCache.clearChat(jid);
  clearChatGames(jid);
  resetChatMemoryForChat(jid);
  cfg.get().autorizados = cfg.get().autorizados.filter((item) => bareId(item) !== target);
  cfg.get().antiDelete.chats = cfg.get().antiDelete.chats.filter((item) => bareId(item) !== target);
  cfg.get().viewOnce.autoChats = cfg.get().viewOnce.autoChats.filter((item) => bareId(item) !== target);
  clearGroupSettings(jid);
}

async function runCommand(sock, msg, cmd, ctx) {
  const { name, args } = cmd;
  const { reply, isOwner, inOwnerPrivate } = ctx;
  const jid = msg.key.remoteJid;
  const owner = isOwner(jid, msg.key.participant);
  const argText = args.join(' ');

  if (isGameCommand(name)) return handleGameCommand({ sock, msg, name, args, reply, owner });

  switch (name) {
    // ── ATIVAR / DESATIVAR (.ativar / .desativar) ───────
    case 'ativar':
    case 'autorizar':
    case 'permitir':
    case 'liberar': {
      requireOwner(ctx, msg);
      const target = normalizeAuthTarget(argText, msg);
      const list = cfg.get().autorizados;
      if (!list.includes(target)) {
        list.push(target);
        cfg.save();
      }
      if (!inOwnerPrivate && target === bareId(jid)) {
        return reply(ok('Bot ativado neste chat', 'digite .menu para ver os comandos'));
      }
      return reply(ok('Acesso liberado', `${target}  ·  para desativar: .desativar ${target}`));
    }

    case 'desativar':
    case 'desautorizar':
    case 'revogar':
    case 'bloquear': {
      requireOwner(ctx, msg);
      if (['tudo', 'todos', 'all'].includes(argText.trim().toLowerCase())) {
        const ownerChat = bareId(ctx.ownerJid);
        const revoke = new Set([
          ...cfg.get().autorizados,
          ...cfg.get().antiDelete.chats,
          ...cfg.get().viewOnce.autoChats,
          ...Object.keys(cfg.get().grupos || {})
        ].map(bareId).filter((chat) => chat && chat !== ownerChat));
        for (const chat of revoke) revokeChatFeatures(chat);
        cfg.get().autorizados = [];
        cfg.get().antiDelete.chats = cfg.get().antiDelete.chats.filter((chat) => bareId(chat) === ownerChat);
        cfg.get().viewOnce.autoChats = cfg.get().viewOnce.autoChats.filter((chat) => bareId(chat) === ownerChat);
        cfg.save();
        return reply(ok('Todos os outros chats foram bloqueados', 'acessos e caches locais removidos'));
      }
      const target = normalizeAuthTarget(argText, msg);
      const tDigits = bareDigits(target);
      revokeChatFeatures(target);
      if (tDigits) cfg.get().autorizados = cfg.get().autorizados.filter((item) => bareDigits(item) !== tDigits);
      cfg.save();
      if (!inOwnerPrivate && target === bareId(jid)) {
        return reply(ok('Bot desativado neste chat'));
      }
      return reply(ok('Acesso removido', target));
    }

    case 'ativos':
    case 'autorizados': {
      requireOwner(ctx, msg);
      if (!inOwnerPrivate) return; // nunca exibe lista fora do privado do dono
      const list = cfg.get().autorizados || [];
      if (!list.length) {
        return reply(
          card([
            header('Chats liberados', 'modo privado'),
            'Nenhum chat ou grupo liberado além do seu privado.',
            usage('.ativar', '.ativar 5531999999999', 'Use dentro do chat/grupo, ou informe um número.')
          ])
        );
      }
      return reply(
        card([
          header('Chats liberados', `${list.length} ativo(s)`),
          section('Lista', list),
          footer('Bloqueie com .desativar <número|aqui> ou .desativar tudo')
        ])
      );
    }

    // ── MENU (separado: completo no privado do dono / só figurinhas nos demais) ──
    case 'menu':
    case 'help':
    case 'ajuda':
    case 'comandos':
      return reply(inOwnerPrivate ? ownerMenu() : publicMenu());

    case 'boasvindas':
    case 'bemvindo':
    case 'welcome':
      return welcomeCommand(sock, msg, args, ctx, owner);

    case 'antilink':
    case 'anti-link':
      return antiLinkCommand(sock, msg, args, ctx, owner);

    case 'enquete':
    case 'poll': {
      requireAuthorizedGroup(jid);
      const parts = argText.split('|').map((part) => part.trim());
      if (parts.length < 3 || parts.some((part) => !part)) {
        throw new Error('uso: .enquete pergunta | opção 1 | opção 2');
      }
      const question = parts.shift();
      const options = parts;
      if (question.length > 200) throw new Error('a pergunta deve ter no máximo 200 caracteres');
      if (options.length > 12) throw new Error('a enquete aceita no máximo 12 opções');
      if (options.some((option) => option.length > 80)) throw new Error('cada opção deve ter no máximo 80 caracteres');
      if (new Set(options.map((option) => option.toLocaleLowerCase('pt-BR'))).size !== options.length) {
        throw new Error('as opções da enquete devem ser diferentes');
      }
      const actor = bareId(msg.key.participant || jid);
      const groupKey = bareId(jid);
      if (!pollUserLimiter.consume(`${groupKey}:${actor}`).allowed) return; // silêncio para não amplificar spam
      if (!pollGroupLimiter.consume(groupKey).allowed) return;
      return reply({ poll: { name: question, values: options, selectableCount: 1 } });
    }

    case 'menudl':
    case 'downloadmenu':
      return reply(downloadMenu());

    case 'menufig':
    case 'stickerhelp':
    case 'figurinhas':
      return reply(stickerMenu());

    case 'ping': {
      const t0 = Date.now();
      await reply(wait('Testando ping'));
      const ms = Date.now() - t0;
      return reply(`${SYM.ok} *Pong*  ${SYM.detail}  ${ms} ms`);
    }

    case 'info':
    case 'status':
      return reply(
        infoText({
          uptime: uptimeText(STARTED_AT),
          cacheSize: messageCache.size(),
          bgRows: bgStatus(),
          aiRows: aiStatus(),
          poolRows: [
            'tikwm: ativo (TikTok)',
            'innertube: ativo (YouTube)',
            'vxtwitter: ativo (X)',
            'pinterest widget: ativo',
            `cobalt: ${cobaltPool().available}/${cobaltPool().size} instâncias`,
            `yt-dlp: ${!isYtdlpEnabled() ? 'desativado por padrão' : hasYtDlp() ? 'habilitado' : 'habilitado, mas não instalado'}`,
            `auto-dl: ${cfg.get().autoDownload ? 'ligado' : 'desligado'}`
          ],
          ownerName: owner ? 'você' : undefined
        })
      );

    case 'doctor':
      return reply(doctorText());

    // ── ANTI-DELETE (100% privado: só no privado do dono, nunca em grupo/chat) ──
    case 'antidelete':
    case 'antidel':
    case 'ad':
    case 'apagadas':
    case 'deletadas':
      // Defesa em profundidade: mesmo o dono não vê nada disso fora do privado,
      // para não deixar NENHUM traço de anti-delete em grupo ou chat alheio.
      if (!inOwnerPrivate) return;
      return antiDeleteCommand(sock, msg, args, ctx);

    // ── VIEW ONCE: opt-in explícito por chat ─────────────────
    case 'vo':
    case 'visu':
    case 'viewonce': {
      if (!inOwnerPrivate) return;
      requireOwner(ctx, msg);
      const settings = cfg.get().viewOnce;
      settings.autoChats ||= [];
      const [sub, ...targetParts] = args;
      const targetArg = targetParts.join(' ');
      if (!sub) {
        const enabled = settings.autoChats.some((chat) => bareId(chat) === bareId(jid));
        return reply(card([
          header('View Once', 'automação opt-in por chat'),
          kv('Captura automática neste chat', toggle(enabled, 'ligada', 'desligada')),
          kv('Chats habilitados', String(settings.autoChats.length)),
          '_Uma resposta comum não baixa mídia. Para uso manual, responda com `.s` no privado do dono._',
          usage('.vo on|off [JID|aqui]', '.vo on aqui', 'Para grupo, autorize primeiro com `.ativar` e informe o JID.')
        ]));
      }
      if (sub.toLowerCase() === 'off' && ['todos', 'tudo', 'all'].includes(targetArg.toLowerCase())) {
        settings.autoChats = [];
        cfg.save();
        return reply(warn('Captura automática desligada em todos os chats'));
      }
      if (!['on', 'off'].includes(sub.toLowerCase())) throw new Error('uso: .vo on|off [JID|aqui]');
      const target = normalizeAuthTarget(targetArg || 'aqui', msg);
      if (sub.toLowerCase() === 'on') {
        const authorizedTarget = target === bareId(jid) || cfg.get().autorizados.some((item) => bareId(item) === target);
        if (!authorizedTarget) throw new Error('autorize esse chat primeiro com `.ativar <JID>`');
        if (!settings.autoChats.some((chat) => bareId(chat) === target)) settings.autoChats.push(target);
      } else {
        settings.autoChats = settings.autoChats.filter((item) => bareId(item) !== target);
      }
      cfg.save();
      return reply(ok(sub.toLowerCase() === 'on' ? 'Captura automática habilitada' : 'Captura automática desabilitada', target));
    }

    // ── FIGURINHAS ──────────────────────────────────────
    case 's':
    case 'fig':
    case 'figu':
    case 'sticker':
    case 'stiker':
    case 'figurinha': {
      // Mídia anexada/citada tem prioridade; sem mídia, os links do texto viram figurinha.
      const got = await stickerSourcesOrReply({ sock, msg, args, allowViewOnce: inOwnerPrivate, reply });
      if (!got) return;
      const { sources, failures, skipped } = got;
      if (!sources.length) {
        return reply(usage('.s', '.s https://br.pinterest.com/pin/123/', 'Envie/responda uma imagem, vídeo ou GIF — ou mande o link que eu baixo e monto a figurinha.'));
      }
      let done = 0;
      for (let i = 0; i < sources.length; i++) {
        const webp = await makeSticker(sources[i], { ...packInfo(), fit: parseFit(args), onProgress: reply });
        await reply(wait(sources.length > 1 ? `Enviando figurinha ${i + 1}/${sources.length}` : 'Enviando figurinha'));
        await sendStickerMessage(sock, jid, webp, msg);
        done++;
      }
      return reply(
        ok(done > 1 ? `${done} figurinhas prontas` : 'Figurinha pronta', stickerSourceNote(sources, failures, skipped))
      );
    }

    case 'sfundo':
    case 'stickerfundo':
    case 'sfundinho': {
      const got = await stickerSourcesOrReply({ sock, msg, args, allowViewOnce: inOwnerPrivate, reply });
      if (!got) return;
      const { sources, failures, skipped } = got;
      if (!sources.length) {
        return reply(usage('.sfundo', '.sfundo https://br.pinterest.com/pin/123/', 'Envie/responda uma imagem — ou mande o link — que eu removo o fundo.'));
      }
      let done = 0;
      for (let i = 0; i < sources.length; i++) {
        const webp = await makeSticker(sources[i], { ...packInfo(), removeBg: true, fit: parseFit(args), onProgress: reply });
        await reply(wait(sources.length > 1 ? `Enviando figurinha sem fundo ${i + 1}/${sources.length}` : 'Enviando figurinha sem fundo'));
        await sendStickerMessage(sock, jid, webp, msg);
        done++;
      }
      return reply(
        ok(done > 1 ? `${done} figurinhas sem fundo prontas` : 'Figurinha sem fundo pronta', stickerSourceNote(sources, failures, skipped))
      );
    }

    case 'fundo':
    case 'removefundo':
    case 'rmbg':
    case 'removebg': {
      const got = await stickerSourcesOrReply({ sock, msg, args, allowViewOnce: inOwnerPrivate, reply });
      if (!got) return;
      const source = got.sources[0];
      if (!source) return reply(usage('.fundo', '.fundo https://br.pinterest.com/pin/123/', 'Envie/responda uma imagem — ou mande o link — que eu removo o fundo.'));
      if (source.kind && source.kind !== 'image') {
        throw new Error('Remoção de fundo funciona só com *imagens* — o link que você mandou é de vídeo/animação.');
      }
      await reply(wait('Removendo o fundo com IA'));
      const { buffer, via } = await removeBackground(source.buffer);
      await reply(wait('Enviando PNG sem fundo'));
      const sent = await sock.sendMessage(
        jid,
        { image: buffer, caption: `${SYM.ok} *Fundo removido*  ${SYM.detail}  _${via}_`, mimetype: 'image/png' },
        { quoted: msg }
      );
      if (sent?.key?.id) markBotSent(sent.key.id);
      return reply(ok('Fundo removido', `via ${via}`));
    }

    // ── IA ──────────────────────────────────────────────
    case 'ia':
    case 'ai':
    case 'gpt':
    case 'chat': {
      const senderId = msg.key?.participant || msg.key?.participantAlt || msg.key?.senderPn ||
        (isGroup(jid) ? `unresolved:${msg.key?.id || Date.now()}` : jid);
      const memoryKey = `${normalizeJid(jid)}:${normalizeJid(senderId)}`;
      if (args[0]?.toLowerCase() === 'reset') {
        resetChatMemory(memoryKey);
        return reply(ok('Sua conversa com a IA foi reiniciada', 'memória isolada deste remetente limpa'));
      }
      const question = argText || extractAnyText(msg.message?.extendedTextMessage?.contextInfo?.quotedMessage || {});
      if (!question) return reply(usage('.ia <pergunta>', '.ia qual a capital do Japão?'));
      await reply(wait('Pensando'));
      const answer = await aiChat(memoryKey, question);
      return reply(truncate(answer, 3800));
    }

    case 'clima':
    case 'tempo':
    case 'previsao':
    case 'previsão': {
      if (!argText) return reply(usage('.clima <cidade>', '.clima Itaúna, MG', 'Também aceita cidade, estado e país para reduzir ambiguidades.'));
      await reply(wait('Consultando o clima'));
      const weather = await getWeatherByCity(argText);
      return reply(formatWeatherMessage(weather));
    }

    case 'cotacao':
    case 'cotação':
    case 'cambio':
    case 'câmbio': {
      if (args.length !== 3) {
        return reply(usage('.cotacao <valor> <origem> <destino>', '.cotacao 100 USD BRL', 'Aceita decimal com vírgula: `.cotacao 50,75 EUR BRL`.'));
      }
      await reply(wait('Consultando a taxa de referência'));
      const conversion = await convertCurrency(args[0], args[1], args[2]);
      return reply(formatCurrencyMessage(conversion));
    }

    case 'feriados': {
      const yearTokens = args.filter((arg) => /^\d{4}$/.test(arg));
      const countryTokens = args.filter((arg) => /^[a-z]{2}$/i.test(arg));
      if (args.length > 2 || yearTokens.length > 1 || countryTokens.length > 1 || yearTokens.length + countryTokens.length !== args.length) {
        return reply(usage('.feriados [ano] [país]', '.feriados 2027 BR', 'O país usa código ISO de 2 letras; sem argumentos, consulta o Brasil no ano atual.'));
      }
      const year = Number(yearTokens[0] || new Date().getUTCFullYear());
      const country = (countryTokens[0] || 'BR').toUpperCase();
      await reply(wait('Consultando o calendário de feriados'));
      const holidays = await getPublicHolidays(year, country);
      return reply(formatPublicHolidaysMessage(holidays, year, country));
    }

    case 'criar':
    case 'img':
    case 'gerar':
    case 'imagine':
    case 'desenhar': {
      if (!argText) return reply(usage('.criar <ideia>', '.criar um gato astronauta em marte, realista'));
      await reply(wait('Gerando sua imagem · pode levar até 1 min'));
      const buffer = await aiImage(argText);
      await reply(wait('Enviando imagem'));
      const sent = await sock.sendMessage(jid, { image: buffer, caption: `${SYM.section} Imagem criada · "${truncate(argText, 200)}"` }, { quoted: msg });
      if (sent?.key?.id) markBotSent(sent.key.id);
      return reply(ok('Imagem pronta'));
    }

    case 'voz':
    case 'tts':
    case 'falar': {
      const text2 = argText || extractAnyText(msg.message?.extendedTextMessage?.contextInfo?.quotedMessage || {});
      if (!text2) return reply(usage('.voz <texto>', '.voz bom dia, pessoal'));
      await reply(wait('Gerando áudio'));
      const buffer = await aiVoice(truncate(text2, 900));
      await reply(wait('Enviando áudio'));
      const sent = await sock.sendMessage(jid, { audio: buffer, mimetype: 'audio/mpeg', ptt: true }, { quoted: msg });
      if (sent?.key?.id) markBotSent(sent.key.id);
      return reply(ok('Áudio pronto'));
    }

    case 'traduz':
    case 'traduzir': {
      const [target, ...restArr] = args;
      let text3 = restArr.join(' ');
      if (!text3) text3 = extractAnyText(msg.message?.extendedTextMessage?.contextInfo?.quotedMessage || {});
      if (!target || !text3) return reply(usage('.traduz <idioma> <texto>', '.traduz inglês boa tarde', 'Ou responda a um texto com o comando.'));
      await reply(wait(`Traduzindo para ${target}`));
      const result = await aiTranslate(truncate(text3, 3000), target);
      return reply(`${SYM.section} *TRADUÇÃO*  ${SYM.detail}  _${target}_\n\n${truncate(result, 3800)}`);
    }

    case 'resumo':
    case 'resumir': {
      let text4 = argText;
      if (!text4) text4 = extractAnyText(msg.message?.extendedTextMessage?.contextInfo?.quotedMessage || {});
      if (!text4) return reply(usage('.resumo <texto>', null, 'Envie ou responda a um texto longo com o comando.'));
      await reply(wait('Resumindo'));
      const result = await aiSummary(truncate(text4, 6000));
      return reply(`${SYM.section} *RESUMO*\n\n${truncate(result, 3800)}`);
    }

    // ── DOWNLOADS (qualquer rede social) ────────────────
    case 'dl':
    case 'download':
    case 'baixar':
      return downloadCommand({ sock, msg, args, ctx, url: pickUrl(args), fallback: downloadMenu() });

    case 'tiktok':
    case 'tt':
    case 'tiktokdl':
      return downloadCommand({
        sock, msg, args, ctx,
        url: pickUrl(args),
        fallback: usage('.tiktok <link>', '.tiktok https://vm.tiktok.com/…')
      });

    case 'ttmp3':
    case 'tiktokmp3':
    case 'ttaudio':
      return downloadCommand({
        sock, msg, args, ctx,
        url: pickUrl(args),
        audioOnly: true,
        fallback: usage('.ttmp3 <link>', null, 'Envie o link do TikTok para receber só o áudio.')
      });

    case 'pin':
    case 'pinterest':
    case 'pint':
      return downloadCommand({
        sock, msg, args, ctx,
        url: pickUrl(args),
        fallback: usage('.pin <link>', null, 'Envie o link do Pinterest (aceita pin.it).')
      });

    case 'insta':
    case 'instagram':
    case 'ig':
    case 'reels':
      return downloadCommand({
        sock, msg, args, ctx,
        url: pickUrl(args),
        fallback: usage('.insta <link>', null, 'Envie o link do post, reel ou story.')
      });

    case 'yt':
    case 'youtube':
    case 'ytb':
    case 'video':
      return downloadCommand({
        sock, msg, args, ctx,
        url: pickUrl(args),
        fallback: usage('.yt <link>', null, 'Envie o link do vídeo do YouTube.')
      });

    case 'ytmp3':
    case 'youtubemp3':
    case 'ytaudio':
    case 'mp3':
      return downloadCommand({
        sock, msg, args, ctx,
        url: pickUrl(args),
        audioOnly: true,
        fallback: usage('.ytmp3 <link>', null, 'Envie o link do YouTube (ou de qualquer rede) para receber só o áudio.')
      });

    case 'tw':
    case 'twitter':
    case 'x':
    case 'tweet':
      return downloadCommand({
        sock, msg, args, ctx,
        url: pickUrl(args),
        fallback: usage('.tw <link>', null, 'Envie o link do post no X/Twitter.')
      });

    case 'face':
    case 'facebook':
    case 'fb':
      return downloadCommand({
        sock, msg, args, ctx,
        url: pickUrl(args),
        fallback: usage('.face <link>', null, 'Envie o link do vídeo do Facebook.')
      });

    // ── CONFIGURAÇÃO ────────────────────────────────────
    case 'config': {
      requireOwner(ctx, msg);
      if (!args.length) {
        const c = cfg.get();
        return reply(
          card([
            header('Configuração', 'ajustes atuais'),
            [
              `${SYM.section} *GERAL*`,
              kv('Chats liberados', `${c.autorizados?.length || 0}${c.autorizados?.length ? ` (${c.autorizados.join(', ')})` : ''}`),
              kv('Download automático', toggle(c.autoDownload, 'ligado', 'desligado')),
              kv('Qualidade padrão', c.qualidadePadrao),
              kv('Tamanho máximo', `${c.maxMB} MB`)
            ].join('\n'),
            [
              `${SYM.section} *PRIVADO DO DONO*`,
              kv('Chats com View Once automático', String(c.viewOnce.autoChats.length)),
              kv('Chats com Anti-Delete', String(c.antiDelete.chats.length)),
              kv('Filtros do Anti-Delete', c.antiDelete.ignorar.length ? c.antiDelete.ignorar.join(', ') : 'nenhum')
            ].join('\n'),
            usage('.config <chave> <valor>', '.config autoDownload false')
          ])
        );
      }
      const [key, ...restArr] = args;
      const valueRaw = restArr.join(' ');
      const keyName = key.toLowerCase();
      if (keyName === 'autodownload') {
        if (!['true', 'false', 'on', 'off', 'sim', 'nao', 'não'].includes(valueRaw.toLowerCase())) {
          throw new Error('use .config autoDownload true|false');
        }
        cfg.set('autoDownload', ['true', 'on', 'sim'].includes(valueRaw.toLowerCase()));
      } else if (keyName === 'qualidadepadrao') {
        if (!['melhor', 'alta', 'media', 'média', 'baixa'].includes(valueRaw.toLowerCase())) {
          throw new Error('qualidade válida: melhor, alta, média ou baixa');
        }
        cfg.set('qualidadePadrao', valueRaw.toLowerCase().replace('média', 'media'));
      } else if (keyName === 'maxmb') {
        const maxMB = Number(valueRaw);
        if (!Number.isFinite(maxMB) || maxMB < 1 || maxMB > 200) throw new Error('maxMB deve ficar entre 1 e 200');
        cfg.set('maxMB', Math.round(maxMB));
      } else {
        throw new Error('chaves válidas: autoDownload, qualidadePadrao, maxMB');
      }
      return reply(ok('Ajuste salvo', `${key} = ${cfg.get()[keyName === 'qualidadepadrao' ? 'qualidadePadrao' : keyName === 'autodownload' ? 'autoDownload' : 'maxMB']}`));
    }

    case 'pools': {
      requireOwner(ctx, msg);
      const env = envSummary();
      const { removebg, endpoints } = bgPools();
      const lines = [
        header('Pools de APIs', 'chaves e provedores'),
        '',
        `${SYM.section} *ARQUIVO .ENV*`,
        ` ${SYM.detail} ${env.file}`,
        ` ${SYM.detail} ${env.loaded ? 'arquivo encontrado' : 'ARQUIVO NÃO ENCONTRADO (crie na raiz do bot)'}`,
        '',
        `${SYM.section} *REMOVE.BG*`,
        ...(removebg.size
          ? removebg.summary().map((s) => ` ${SYM.detail} ${s}`)
          : [` ${SYM.detail} nenhuma chave — coloque REMOVE_BG_KEYS=chave1,chave2 no .env e reinicie`]),
        '',
        `${SYM.section} *ENDPOINTS*`,
        ...(endpoints.size
          ? endpoints.summary().map((s) => ` ${SYM.detail} ${s}`)
          : [` ${SYM.detail} nenhum — opcional: REMOVE_BG_URLS=https://sua-api/removebg`]),
        '',
        `${SYM.section} *REMBG LOCAL*`,
        ` ${SYM.detail} ${env.localRembg ? 'ativo (LOCAL_REMBG=1)' : 'desligado — opcional: LOCAL_REMBG=1'}`,
        '',
        `${SYM.section} *OUTRAS CHAVES*`,
        ` ${SYM.detail} IA: gemini ${env.geminiKeys} · groq ${env.groqKeys} · openai ${env.openaiKeys} · pollinations ${env.pollinationsKeys}`,
        ` ${SYM.detail} downloads: cobalt ${env.cobaltInstances}`
      ];
      return reply(lines.join('\n'));
    }

    default:
      if (inOwnerPrivate && cfg.get().responderDesconhecido) {
        return reply(warn('Comando não reconhecido', `.${name}  ·  digite .menu para ver as opções`));
      }
      return;
  }
}

/**
 * Handler único de download: resolve a URL, baixa e envia tudo em cascata
 * (extrator da rede → Cobalt → yt-dlp → scraping), editando a mesma mensagem
 * de progresso em vez de disparar várias.
 */
async function downloadCommand({ sock, msg, args, ctx, url, audioOnly = false, fallback }) {
  const { reply } = ctx;
  if (!url) return reply(fallback);
  const { quality } = parseQuality(args, cfg.get().qualidadePadrao);
  const jid = msg.key.remoteJid;
  try {
    const result = await resolveDownload(url, quality, { audioOnly, onProgress: reply });
    return await sendDownload(sock, jid, result, { quality, url, onProgress: reply, quoted: msg });
  } catch (error) {
    log.warn(`download falhou (${shortUrl(url)})`, { name: error?.name, status: error?.status, code: error?.code });
    const detail = String(error.message || error).slice(0, 260);
    return reply(
      fail('Não consegui baixar este link', detail) +
        '\n\n' +
        `${SYM.item} Tente novamente em instantes, envie o link direto do app\n` +
        `${SYM.item} Ou use \`.dl <link> baixa\``
    );
  }
}

async function antiDeleteCommand(sock, msg, args, ctx) {
  const { reply, isOwner } = ctx;
  const jid = msg.key.remoteJid;
  const owner = isOwner(jid, msg.key.participant);
  const settings = cfg.get().antiDelete;
  settings.chats ||= [];
  const [sub, ...restArr] = args.map((a, i) => (i === 0 ? a.toLowerCase() : a));
  const rest = restArr.join(' ');

  if (!sub) return reply(statusText(jid));
  if (!owner) throw new Error('somente o dono pode alterar o Anti-Delete');

  if (['on', 'off'].includes(sub)) {
    if (sub === 'off' && ['todos', 'tudo', 'all'].includes(rest.toLowerCase())) {
      const oldChats = [...settings.chats];
      settings.chats = [];
      for (const chat of oldChats) messageCache.clearChat(chat);
      cfg.save();
      return reply(warn('Anti-Delete desativado em todos os chats'));
    }
    const target = normalizeAuthTarget(rest || 'aqui', msg);
    if (sub === 'on') {
      const authorizedTarget = target === bareId(jid) || cfg.get().autorizados.some((item) => bareId(item) === target);
      if (!authorizedTarget) throw new Error('autorize esse chat primeiro com `.ativar <JID>`');
      if (!settings.chats.some((chat) => bareId(chat) === target)) settings.chats.push(target);
      cfg.save();
      return reply(ok('Anti-Delete habilitado neste chat', 'conteúdo será retido por até 24 horas e enviado só ao seu privado'));
    }
    settings.chats = settings.chats.filter((item) => bareId(item) !== target);
    messageCache.clearChat(target);
    cfg.save();
    return reply(warn('Anti-Delete desativado neste chat', 'o cache local desse chat foi limpo'));
  }

  if (sub === 'lista') {
    return reply(card([
      header('Anti-Delete', 'configuração local'),
      section('Chats habilitados', settings.chats.length ? settings.chats : ['nenhum']),
      section('Filtros de exclusão', settings.ignorar.length ? settings.ignorar : ['nenhum'])
    ]));
  }

  if (['ignorar', 'add', 'addignorar'].includes(sub)) {
    const target = normalizeIgnoreTarget(rest, msg);
    if (settings.ignorar.includes(target)) return reply(warn('Esse filtro já existe', target));
    settings.ignorar.push(target);
    if (['grupos', 'groups', 'grupo'].includes(target)) messageCache.clearWhere(isGroup);
    else if (['privado', 'private', 'pv', 'dm'].includes(target)) messageCache.clearWhere((chat) => !isGroup(chat));
    else messageCache.clearChat(target === jid ? jid : target);
    cfg.save();
    return reply(ok('Filtro adicionado', `o chat será excluído do cache e da recuperação: ${target}`));
  }

  if (['remover', 'rm', 'tirar', 'parar'].includes(sub)) {
    const target = normalizeIgnoreTarget(rest, msg);
    settings.ignorar = settings.ignorar.filter((rule) => rule !== target);
    cfg.save();
    return reply(ok('Filtro removido', `${target} poderá ser habilitado novamente`));
  }

  return reply(antiDeleteMenu());
}

function doctorText() {
  const nodeOk = Number(process.versions.node.split('.')[0]) >= 22;
  const ff = hasFfmpeg();
  const ytdlpEnabled = isYtdlpEnabled();
  const ytdlpBinary = ytdlpEnabled ? findYtdlp() : null;
  const cb = cobaltPool();
  const env = envSummary();
  return card([
    header('Diagnóstico', 'saúde do sistema'),
    [
      `${SYM.section} *AMBIENTE*`,
      kv('Node', `${process.version} ${nodeOk ? SYM.ok : `${SYM.warn} use 22+`}`),
      kv('FFmpeg', ff ? `${SYM.ok} instalado` : `${SYM.err} ausente (figurinhas precisam dele)`),
      kv('yt-dlp', !ytdlpEnabled ? 'desativado por padrão' : ytdlpBinary ? `${SYM.ok} habilitado` : 'habilitado, mas binário ausente'),
      kv('Plataforma', process.platform),
      kv('Memória', `${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB`)
    ].join('\n'),
    [
      `${SYM.section} *ARQUIVO .ENV*`,
      kv('Caminho', env.file),
      kv('Status', env.loaded ? `${SYM.ok} lido pelo bot` : `${SYM.err} não encontrado`),
      kv('REMOVE_BG_KEYS', `${env.removeBgKeys} chave(s)`),
      kv('REMOVE_BG_URLS', `${env.removeBgUrls} endpoint(s)`),
      kv('LOCAL_REMBG', env.localRembg ? 'ligado' : 'desligado')
    ].join('\n'),
    [
      `${SYM.section} *SERVIÇOS*`,
      kv('Remoção de fundo', bgStatus().join(' · ')),
      kv('IA', aiStatus().join(' · ')),
      kv('Cobalt', `${cb.available}/${cb.size} instâncias saudáveis`)
    ].join('\n'),
    ff ? ok('Tudo certo por aqui') : warn('Instale o FFmpeg', 'Termux: pkg install ffmpeg  ·  Linux: apt install ffmpeg')
  ]);
}
