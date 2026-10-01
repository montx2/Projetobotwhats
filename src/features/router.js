// 🧭 ROUTER — despacha comandos, captura view once real em silêncio,
// aplica anti-delete silencioso (somente para o privado do dono) e controla acesso.
//
// REGRAS DE OURO:
// 1) View Once e Anti-Delete enviam EXCLUSIVAMENTE para o privado do dono
//    (0 rastros nos chats/grupos) e são as ÚNICAS funções invisíveis para os outros.
// 2) Por padrão, o bot SÓ funciona no privado do próprio dono.
// 3) Quando o dono dá `.ativar` (ou `. ativar`) em um grupo ou chat privado,
//    aquele chat ganha acesso a TUDO — figurinhas, downloads de qualquer rede,
//    IA e afins. As duas únicas coisas que nunca aparecem nem respondem para
//    terceiros são View Once e Anti-Delete.

import { isStale, alreadySeen } from '../core/freshness.js';
import { cfg } from '../core/config.js';
import { log } from '../core/logger.js';
import { messageCache, isBotSent, markBotSent } from '../wa/cache.js';
import { extractAnyText, isIgnored, normalizeIgnoreTarget, handleDelete, statusText } from './antidelete.js';
import { SYM, header, section, card, footer, ok, fail, warn, wait, usage, kv, toggle } from '../core/ui.js';
import { isViewOnce, onViewOnceMessage, onViewOnceReply, unwrapViewOnce } from './viewonce.js';
import { extractStickerSource, makeSticker, packInfo, isAnimatedWebp, parseFit } from './sticker.js';
import { removeBackground, bgStatus, bgPools } from './bgremoval.js';
import { aiChat, aiImage, aiVoice, aiTranslate, aiSummary, resetChatMemory, aiStatus } from './ai.js';
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
import { extractUrls, truncate, prettyJid, uptimeText, isGroup } from '../util/text.js';
import { hasFfmpeg } from '../util/ffmpeg.js';
import { cobaltPool } from './downloaders/cobalt.js';
import { hasYtDlp } from './downloaders/ytdlp.js';

const STARTED_AT = Date.now();

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
  '╭━━'
];

function isBotGeneratedText(text) {
  if (!text) return false;
  return BOT_OUTPUT_PREFIXES.some((p) => text.startsWith(p));
}

function bareId(jid) {
  return String(jid || '')
    .toLowerCase()
    .replace(/:\d+@/, '@')
    .trim();
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

  // 0) Anti-delete: armazena tudo em memória (100% em silêncio)
  messageCache.put(msg);

  // 0.1) Backlog/histórico/reentrega: guarda no cache mas NÃO age.
  const revoke = isRevokeMessage(msg);
  if (isStale(msg, deps.type) || (!revoke && alreadySeen(msg))) {
    noteStale();
    return;
  }

  // 1) Mensagem apagada (REVOKE) → envia 100% EM SILÊNCIO SOMENTE para o privado do dono (0 rastros no grupo/chat)
  if (revoke) {
    await handleDelete(sock, msg, { ownerJid }).catch((e) => log.warn(`antidelete: ${e.message}`));
    return;
  }

  // 2) View once REAL recebida → baixa 100% EM SILÊNCIO e envia SOMENTE para o privado do dono (0 rastros)
  if (!msg.key.fromMe && isViewOnce(msg.message)) {
    await onViewOnceMessage(sock, msg, { ownerJid }).catch((e) => log.warn(`view once: ${e.message}`));
  }

  const senderIsOwner = Boolean(msg.key?.fromMe || isOwner?.(jid, msg.key.participant));
  const inOwnerPrivate =
    typeof deps.isOwnerPrivateChat === 'function'
      ? deps.isOwnerPrivateChat(jid, msg)
      : !isGroup(jid) && Boolean(isOwner?.(jid));
  const authorized = isAuthorizedTarget(jid, msg.key.participant);

  // 3) O dono respondeu uma View Once REAL em QUALQUER chat/grupo →
  //    baixa em silêncio e manda SOMENTE pro privado do dono (0 rastros na conversa da pessoa/grupo!)
  if (senderIsOwner) {
    const captured = await onViewOnceReply(sock, msg, {
      ownerJid,
      senderIsOwner: true
    }).catch((e) => {
      log.warn(`view once resposta: ${e.message}`);
      return false;
    });
    // Se a resposta foi em outro chat e não é um comando, termina aqui em silêncio absoluto
    if (captured && !inOwnerPrivate) return;
  }

  const prefixes = cfg.get().prefixos;
  const command = parseCommand(text, prefixes);
  const isAuthCmd = Boolean(command && AUTH_COMMANDS.has(command.name));

  // 4) CONTROLE DE ACESSO:
  // • No privado do dono (inOwnerPrivate): acesso TOTAL, inclusive View Once e Anti-Delete.
  // • Dono digitou .ativar / .desativar / .ativos em qualquer chat: executa.
  // • Chat/grupo ativado com .ativar (authorized): TUDO liberado, MENOS
  //   View Once e Anti-Delete (que somem do menu e não respondem).
  // • Caso contrário: silêncio absoluto (0 mensagens).
  if (command) {
    if (isAuthCmd) {
      if (!senderIsOwner) return; // estranhos tentando dar .ativar são ignorados em silêncio
    } else if (!inOwnerPrivate) {
      // Fora do privado do dono: precisa estar ativado e não ser comando exclusivo do dono
      if (!authorized) return;
      if (OWNER_ONLY_COMMANDS.has(command.name)) return; // View Once / Anti-Delete: 0 traços
    }

    log.cmd(`${command.name} ${command.args.join(' ')} ← ${msg.pushName || prettyJid(jid)}`);
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
      log.error(`comando .${command.name} falhou`, error);
      await reply(fail('Não foi possível concluir', String(error.message || error).slice(0, 220))).catch(() => {});
    }
    return;
  }

  // 5) Auto-download de links soltos: no privado do dono e nos chats/grupos ativados.
  //    (Nunca em grupos aleatórios não autorizados — o bot fica mudo neles.)
  if (inOwnerPrivate || authorized) {
    const urls = extractUrls(text);
    if (urls.length && cfg.get().autoDownload && urls.some(isKnownSocialUrl)) {
      const progress = createProgress(sock, jid, msg);
      const reply = async (t) => progress.update(t);
      await autoDownload(sock, msg, urls.filter(isKnownSocialUrl), { reply });
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

async function runCommand(sock, msg, cmd, ctx) {
  const { name, args } = cmd;
  const { reply, isOwner, inOwnerPrivate } = ctx;
  const jid = msg.key.remoteJid;
  const owner = isOwner(jid, msg.key.participant);
  const argText = args.join(' ');

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
        cfg.get().autorizados = [];
        cfg.save();
        return reply(ok('Todos os chats foram bloqueados', 'o bot responde somente no seu privado'));
      }
      const target = normalizeAuthTarget(argText, msg);
      const tDigits = bareDigits(target);
      cfg.get().autorizados = (cfg.get().autorizados || []).filter(
        (item) => bareId(item) !== target && (!tDigits || bareDigits(item) !== tDigits)
      );
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
            `yt-dlp: ${hasYtDlp() ? 'instalado (modo turbo)' : 'não instalado'}`,
            `auto-dl: ${cfg.get().autoDownload ? 'ligado' : 'desligado'}`
          ],
          ownerName: owner ? 'você 👑' : undefined
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

    // ── VIEW ONCE (100% privado: só no privado do dono, nunca em grupo/chat) ──
    case 'vo':
    case 'visu':
    case 'viewonce': {
      if (!inOwnerPrivate) return;
      if (!args.length) {
        const v = cfg.get().viewOnce;
        return reply(
          card([
            header('View Once', 'captura silenciosa'),
            [
              kv('Captura automática', toggle(v.auto, 'ligada', 'desligada')),
              kv('Destino', 'somente o seu privado')
            ].join('\n'),
            usage('.vo on | off', null, 'Ou responda a qualquer view once para receber aqui.')
          ])
        );
      }
      requireOwner(ctx, msg);
      const [sub, val] = args.map((a) => a.toLowerCase());
      const v = cfg.get().viewOnce;
      if (sub === 'auto') v.auto = ['on', 'true', '1', 'sim'].includes(val);
      else if (sub === 'on' || sub === 'off') v.auto = sub === 'on';
      else throw new Error('uso: .vo on | off');
      cfg.save();
      return reply(ok('View Once atualizado'));
    }

    // ── FIGURINHAS ──────────────────────────────────────
    case 's':
    case 'fig':
    case 'figu':
    case 'sticker':
    case 'stiker':
    case 'figurinha': {
      const source = await extractStickerSource(sock, msg, { onProgress: reply, allowViewOnce: inOwnerPrivate });
      if (!source) return reply(usage('.s', null, 'Envie ou responda uma imagem, vídeo ou GIF com o comando.'));
      const webp = await makeSticker(source, { ...packInfo(), fit: parseFit(args), onProgress: reply });
      await reply(wait('Enviando figurinha'));
      await sendStickerMessage(sock, jid, webp, msg);
      return reply(ok('Figurinha pronta'));
    }

    case 'sfundo':
    case 'stickerfundo':
    case 'sfundinho': {
      const source = await extractStickerSource(sock, msg, { onProgress: reply, allowViewOnce: inOwnerPrivate });
      if (!source) return reply(usage('.sfundo', null, 'Envie ou responda uma imagem com o comando.'));
      const webp = await makeSticker(source, { ...packInfo(), removeBg: true, fit: parseFit(args), onProgress: reply });
      await reply(wait('Enviando figurinha sem fundo'));
      await sendStickerMessage(sock, jid, webp, msg);
      return reply(ok('Figurinha sem fundo pronta'));
    }

    case 'fundo':
    case 'removefundo':
    case 'rmbg':
    case 'removebg': {
      const source = await extractStickerSource(sock, msg, { onProgress: reply, allowViewOnce: inOwnerPrivate });
      if (!source) return reply(usage('.fundo', null, 'Envie ou responda uma imagem com o comando.'));
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
      if (args[0]?.toLowerCase() === 'reset') {
        resetChatMemory(jid);
        return reply(ok('Conversa reiniciada', 'memória da IA limpa'));
      }
      const question = argText || extractAnyText(msg.message?.extendedTextMessage?.contextInfo?.quotedMessage || {});
      if (!question) return reply(usage('.ia <pergunta>', '.ia qual a capital do Japão?'));
      await reply(wait('Pensando'));
      const answer = await aiChat(jid, question);
      return reply(truncate(answer, 3800));
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
      const sent = await sock.sendMessage(jid, { image: buffer, caption: `🎨 "${truncate(argText, 200)}"` }, { quoted: msg });
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
              kv('View Once automático', toggle(c.viewOnce.auto, 'ligado', 'desligado')),
              kv('Anti-Delete', toggle(c.antiDelete.ativo, 'ativo', 'desativado')),
              kv('Filtros do Anti-Delete', c.antiDelete.ignorar.length ? c.antiDelete.ignorar.join(', ') : 'nenhum')
            ].join('\n'),
            usage('.config <chave> <valor>', '.config autoDownload false')
          ])
        );
      }
      const [key, ...restArr] = args;
      const valueRaw = restArr.join(' ');
      const map = {
        autodownload: ['autoDownload', (v) => v === 'true'],
        qualidadepadrao: ['qualidadePadrao', (v) => v],
        maxmb: ['maxMB', (v) => Number(v) || 90]
      };
      const entry = map[key.toLowerCase()];
      if (!entry) throw new Error('chaves válidas: autoDownload, qualidadePadrao, maxMB');
      cfg.set(entry[0], entry[1](valueRaw.toLowerCase()));
      return reply(ok('Ajuste salvo', `${entry[0]} = ${cfg.get()[entry[0]]}`));
    }

    case 'pools': {
      requireOwner(ctx, msg);
      const lines = [header('Pools de APIs', 'chaves e provedores'), ''];
      const { removebg, endpoints } = bgPools();
      lines.push(
        `${SYM.section} *REMOVE.BG*`,
        ...removebg.summary().map((s) => ` ${SYM.detail} ${s}`),
        '',
        `${SYM.section} *ENDPOINTS*`,
        ...endpoints.summary().map((s) => ` ${SYM.detail} ${s}`)
      );
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
    log.warn(`download falhou (${url.slice(0, 60)}): ${error.message}`);
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
  const [sub, ...restArr] = args.map((a, i) => (i === 0 ? a.toLowerCase() : a));

  if (!sub) return reply(statusText(jid));

  if (['on', 'off'].includes(sub)) {
    if (!owner) throw new Error('somente o dono pode ligar ou desligar');
    settings.ativo = sub === 'on';
    cfg.save();
    return reply(settings.ativo ? ok('Anti-Delete ativado', 'silencioso, chega só no seu privado') : warn('Anti-Delete desativado'));
  }

  if (sub === 'lista') {
    return reply(
      section('Filtros do Anti-Delete', settings.ignorar.length ? settings.ignorar : ['nenhum, monitorando tudo'])
    );
  }

  if (['ignorar', 'add', 'addignorar'].includes(sub)) {
    if (!owner) throw new Error('somente o dono pode alterar filtros');
    const target = normalizeIgnoreTarget(restArr.join(' '), msg);
    if (settings.ignorar.includes(target)) return reply(warn('Esse filtro já existe', target));
    settings.ignorar.push(target);
    cfg.save();
    return reply(ok('Filtro adicionado', `ignorando ${target}  ·  para voltar: .antidelete remover ${target}`));
  }

  if (['remover', 'rm', 'tirar', 'parar'].includes(sub)) {
    if (!owner) throw new Error('somente o dono pode alterar filtros');
    const target = normalizeIgnoreTarget(restArr.join(' '), msg);
    settings.ignorar = settings.ignorar.filter((r) => r !== target);
    cfg.save();
    return reply(ok('Filtro removido', `${target} volta a ser monitorado`));
  }

  return reply(antiDeleteMenu());
}

function doctorText() {
  const nodeOk = Number(process.versions.node.split('.')[0]) >= 20;
  const ff = hasFfmpeg();
  const yt = hasYtDlp();
  const cb = cobaltPool();
  return card([
    header('Diagnóstico', 'saúde do sistema'),
    [
      `${SYM.section} *AMBIENTE*`,
      kv('Node', `${process.version} ${nodeOk ? SYM.ok : `${SYM.warn} use 20+`}`),
      kv('FFmpeg', ff ? `${SYM.ok} instalado` : `${SYM.err} ausente (figurinhas precisam dele)`),
      kv('yt-dlp', yt ? `${SYM.ok} instalado (modo turbo)` : 'opcional'),
      kv('Plataforma', process.platform),
      kv('Memória', `${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB`)
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
