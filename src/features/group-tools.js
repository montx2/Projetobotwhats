// Ferramentas opt-in de grupo: moderação leve e mensagens de entrada/saída.
// Não retém mensagens nem aplica punições automáticas a participantes.

import { cfg } from '../core/config.js';
import { SlidingWindowLimiter } from '../core/limiter.js';
import { log } from '../core/logger.js';
import { header, footer } from '../core/ui.js';
import { isGroup, normalizeJid, numberOnly } from '../util/text.js';
import { markBotSent } from '../wa/cache.js';

const MAX_GROUPS = 500;
const MAX_ALLOWLIST = 50;
const MAX_TEXT_LENGTH = 16_000;
const MAX_URLS_PER_MESSAGE = 16;
const METADATA_TTL_MS = 30_000;
const WELCOME_MAX_MENTIONS = 5;
const participantCaches = new WeakMap();
const blockedMessageLimiter = new SlidingWindowLimiter({
  limit: 20,
  windowMs: 60_000,
  minIntervalMs: 250,
  maxKeys: 1024
});
const groupNoticeLimiter = new SlidingWindowLimiter({
  limit: 5,
  windowMs: 60_000,
  minIntervalMs: 1_000,
  maxKeys: 1024
});

const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DOMAIN_TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/;
const GROUP_LINK_PATTERN = /(?:https?:\/\/|www\.)[^\s<>"']+|(?<![@a-z0-9_])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::\d{1,5})?(?:\/[^\s<>"']*)?/gi;

/**
 * Normaliza um domínio digitado por um administrador. Aceita domínio, não URL,
 * caminho, curinga, IP ou porta; a regra vale também para subdomínios.
 */
export function normalizeAllowDomain(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || raw.length > 253 || /[\s/@?#:\\]/.test(raw)) return null;
  const domain = raw.replace(/^www\./, '').replace(/\.$/, '');
  if (domain.includes('/')) return null;
  const labels = domain.split('.');
  if (labels.length < 2 || labels.some((label) => !DOMAIN_LABEL.test(label))) return null;
  if (!DOMAIN_TLD.test(labels.at(-1))) return null;
  return domain;
}

function normalizeHost(value) {
  return String(value || '').trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
}

function extractWrappedText(message, depth = 0) {
  if (!message || typeof message !== 'object' || depth > 8) return '';
  const direct =
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    message.documentWithCaptionMessage?.message?.documentMessage?.caption ||
    message.buttonsResponseMessage?.selectedDisplayText ||
    message.listResponseMessage?.title ||
    message.templateButtonReplyMessage?.selectedDisplayText ||
    message.pollCreationMessage?.name ||
    message.pollCreationMessageV3?.name;
  if (typeof direct === 'string' && direct) return direct;
  for (const wrapper of ['ephemeralMessage', 'deviceSentMessage', 'documentWithCaptionMessage', 'editedMessage']) {
    const nested = extractWrappedText(message[wrapper]?.message, depth + 1);
    if (nested) return nested;
  }
  return '';
}

function extractGroupUrls(text) {
  const matches = String(text || '').slice(0, MAX_TEXT_LENGTH).match(GROUP_LINK_PATTERN) || [];
  return [...new Set(matches.map((item) => item.replace(/[.,;!?]+$/, '')))];
}

function urlHost(value) {
  try {
    const raw = String(value || '');
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    return normalizeHost(url.hostname);
  } catch {
    return '';
  }
}

function hostIsAllowed(host, allowlist) {
  const candidate = normalizeHost(host);
  if (!candidate) return false;
  return (Array.isArray(allowlist) ? allowlist : []).some((item) => {
    const domain = normalizeAllowDomain(item);
    return domain && (candidate === domain || candidate.endsWith(`.${domain}`));
  });
}

/** Links HTTP(S), www e domínios simples que não pertencem à allowlist do grupo. */
export function findDisallowedLinks(text, allowlist = []) {
  const urls = extractGroupUrls(text);
  const disallowed = urls.slice(0, MAX_URLS_PER_MESSAGE).filter((url) => !hostIsAllowed(urlHost(url), allowlist));
  if (urls.length > MAX_URLS_PER_MESSAGE) disallowed.push('[excesso de links]');
  return disallowed;
}

export function isGroupAuthorized(jid) {
  const groupJid = normalizeJid(jid);
  return isGroup(groupJid) && cfg.get().autorizados?.some((item) => normalizeJid(item) === groupJid) === true;
}

export function requireAuthorizedGroup(jid) {
  const groupJid = normalizeJid(jid);
  if (!isGroup(groupJid)) throw new Error('este comando só funciona dentro de um grupo');
  if (!isGroupAuthorized(groupJid)) throw new Error('o dono do bot precisa liberar este grupo com `.ativar`');
  return groupJid;
}

export function getGroupSettings(jid) {
  const groupJid = normalizeJid(jid);
  if (!isGroup(groupJid)) return null;
  return cfg.get().grupos?.[groupJid] || null;
}

export function ensureGroupSettings(jid) {
  const groupJid = normalizeJid(jid);
  if (!isGroup(groupJid)) throw new Error('este comando só funciona em grupos');
  const groups = cfg.get().grupos || (cfg.get().grupos = {});
  let settings = groups[groupJid];
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    if (Object.keys(groups).length >= MAX_GROUPS && !Object.hasOwn(groups, groupJid)) {
      throw new Error('limite local de grupos atingido');
    }
    settings = groups[groupJid] = {
      welcome: false,
      goodbye: false,
      antiLink: { enabled: false, allowlist: [] }
    };
  }
  settings.welcome = settings.welcome === true;
  settings.goodbye = settings.goodbye === true;
  if (!settings.antiLink || typeof settings.antiLink !== 'object' || Array.isArray(settings.antiLink)) {
    settings.antiLink = { enabled: false, allowlist: [] };
  }
  const allowlist = Array.isArray(settings.antiLink.allowlist) ? settings.antiLink.allowlist : [];
  settings.antiLink = {
    enabled: settings.antiLink.enabled === true,
    allowlist: [...new Set(allowlist.map(normalizeAllowDomain).filter(Boolean))].slice(0, MAX_ALLOWLIST)
  };
  return settings;
}

export function clearGroupSettings(jid) {
  const groupJid = normalizeJid(jid);
  if (!isGroup(groupJid) || !cfg.get().grupos) return false;
  const removed = Object.hasOwn(cfg.get().grupos, groupJid);
  delete cfg.get().grupos[groupJid];
  return removed;
}

function cacheFor(sock) {
  if (!sock || (typeof sock !== 'object' && typeof sock !== 'function')) return null;
  let cache = participantCaches.get(sock);
  if (!cache) {
    cache = new Map();
    participantCaches.set(sock, cache);
  }
  return cache;
}

/** Baileys metadata fica em cache curto e por socket; mudanças de participantes invalidam. */
export async function getGroupMetadata(sock, jid) {
  const groupJid = normalizeJid(jid);
  if (!isGroup(groupJid) || typeof sock?.groupMetadata !== 'function') {
    throw new Error('metadados do grupo indisponíveis');
  }
  const cache = cacheFor(sock);
  const existing = cache?.get(groupJid);
  if (existing && existing.expiresAt > Date.now()) return existing.promise;

  const entry = {
    expiresAt: Date.now() + METADATA_TTL_MS,
    promise: Promise.resolve().then(() => sock.groupMetadata(groupJid)).then((metadata) => {
      if (!metadata || !Array.isArray(metadata.participants)) throw new Error('metadados do grupo inválidos');
      return metadata;
    })
  };
  cache?.set(groupJid, entry);
  while (cache?.size > MAX_GROUPS) cache.delete(cache.keys().next().value);
  try {
    return await entry.promise;
  } catch (error) {
    if (cache?.get(groupJid) === entry) cache.delete(groupJid);
    throw error;
  }
}

export function invalidateGroupMetadata(sock, jid) {
  cacheFor(sock)?.delete(normalizeJid(jid));
}

function identityValues(value, result = []) {
  if (typeof value === 'string') {
    const normalized = normalizeJid(value);
    if (['@s.whatsapp.net', '@lid', '@c.us'].some((suffix) => normalized.endsWith(suffix))) result.push(normalized);
    return result;
  }
  if (Array.isArray(value)) {
    for (const item of value) identityValues(item, result);
    return result;
  }
  if (!value || typeof value !== 'object') return result;
  for (const key of [
    'id', 'jid', 'lid', 'pn', 'phoneNumber', 'phone_number', 'participant', 'participantAlt',
    'participantLid', 'participantPn', 'senderLid', 'senderPn'
  ]) {
    if (value[key]) identityValues(value[key], result);
  }
  return result;
}

function matchingParticipant(metadata, identities) {
  const wanted = new Set(identityValues(identities));
  if (!wanted.size) return null;
  for (const participant of metadata?.participants || []) {
    if (identityValues(participant).some((id) => wanted.has(id))) return participant;
  }
  return null;
}

function isAdmin(participant) {
  return participant?.admin === 'admin' || participant?.admin === 'superadmin' ||
    participant?.isAdmin === true || participant?.isSuperAdmin === true;
}

export function isGroupAdministrator(metadata, identities) {
  return isAdmin(matchingParticipant(metadata, identities));
}

export function isBotGroupAdministrator(metadata, sock) {
  return isGroupAdministrator(metadata, [sock?.user, sock?.authState?.creds?.me, sock?.creds?.me]);
}

/** Só administradores do grupo (ou o dono confiável do bot) alteram configurações. */
export async function requireGroupAdministrator(sock, msg, { owner = false } = {}) {
  const jid = requireAuthorizedGroup(msg?.key?.remoteJid);
  if (owner) return null;
  let metadata;
  try {
    metadata = await getGroupMetadata(sock, jid);
  } catch {
    throw new Error('não consegui confirmar os administradores do grupo; tente novamente');
  }
  if (!isGroupAdministrator(metadata, msg?.key)) {
    throw new Error('somente administradores do grupo podem alterar esta configuração');
  }
  return metadata;
}

/**
 * Filtra links somente nos grupos autorizados e com a proteção ligada.
 * Retorna true quando a mensagem deve parar no roteador, mesmo se a exclusão
 * falhar (por exemplo, se o bot perdeu a permissão de administrador).
 */
export async function moderateIncomingGroupLinks(sock, msg, text, { owner = false } = {}) {
  const jid = normalizeJid(msg?.key?.remoteJid);
  if (!isGroupAuthorized(jid) || msg?.key?.fromMe || owner) return false;
  const settings = getGroupSettings(jid);
  if (settings?.antiLink?.enabled !== true) return false;
  const messageText = typeof text === 'string' && text ? text : extractWrappedText(msg?.message);
  const blockedLinks = findDisallowedLinks(messageText, settings.antiLink.allowlist);
  if (!blockedLinks.length) return false;

  let metadata;
  try {
    metadata = await getGroupMetadata(sock, jid);
  } catch {
    // Fail closed para comandos/downloads com link; não tenta agir sem metadados confiáveis.
    return true;
  }
  if (isGroupAdministrator(metadata, msg?.key)) return false;
  if (!isBotGroupAdministrator(metadata, sock)) return true;
  if (!blockedMessageLimiter.consume(jid).allowed) return true;

  try {
    const sent = await sock.sendMessage(jid, { delete: msg.key });
    if (sent?.key?.id) markBotSent(sent.key.id);
  } catch (error) {
    log.warn('anti-link: exclusão não concluída', { name: error?.name });
  }
  return true;
}

/** Recebe somente eventos add/remove; sem armazenar os JIDs dos participantes. */
export async function handleGroupParticipantsUpdate(sock, update) {
  const jid = normalizeJid(update?.id);
  invalidateGroupMetadata(sock, jid);
  if (!isGroupAuthorized(jid)) return;

  const action = String(update?.action || '').toLowerCase();
  if (action !== 'add' && action !== 'remove') return;
  const settings = getGroupSettings(jid);
  const enabled = action === 'add' ? settings?.welcome === true : settings?.goodbye === true;
  if (!enabled) return;

  const participants = [...new Set(identityValues(update?.participants))].slice(0, WELCOME_MAX_MENTIONS);
  if (!participants.length || !groupNoticeLimiter.consume(jid).allowed) return;

  const isWelcome = action === 'add';
  let subject = '';
  let total = 0;
  try {
    const metadata = await getGroupMetadata(sock, jid);
    subject = String(metadata?.subject || '').trim().slice(0, 60);
    total = Array.isArray(metadata?.participants) ? metadata.participants.length : 0;
  } catch {
    // Sem metadados a saudação segue, apenas sem o nome do grupo e a contagem.
  }

  const mentions = participants;
  const tags = mentions.map((id) => `@${numberOnly(id)}`).filter((tag) => tag !== '@');
  if (!tags.length) return;
  const plural = tags.length > 1;
  const names = tags.join(', ');
  const grupo = subject || 'este grupo';

  const lines = [header(isWelcome ? 'Bem-vindo(a)!' : 'Até mais!', `${isWelcome ? 'entrou no' : 'saiu do'} ${grupo}`)];
  if (isWelcome) {
    lines.push(`✧ *${names}*, ${plural ? 'sejam' : 'seja'} muito bem-vindo${plural ? 's' : '(a)'}!`);
    if (!plural && total > 0) lines.push(`▸ Você é o ${total}º membro do grupo.`);
    lines.push('▸ Leia as regras fixadas e respeite a galera.');
    lines.push('▸ Dúvidas? Chame um administrador.');
  } else {
    lines.push(`✧ *${names}* ${plural ? 'deixaram' : 'deixou'} o grupo.`);
    if (total > 0) lines.push(`▸ Restam ${total} ${total === 1 ? 'membro' : 'membros'}.`);
  }
  if (subject) {
    lines.push(footer(`${subject}${total ? ` · ${total} ${total === 1 ? 'membro' : 'membros'}` : ''}`));
  }
  const text = lines.join('\n\n');

  try {
    const sent = await sock.sendMessage(jid, { text, mentions });
    if (sent?.key?.id) markBotSent(sent.key.id);
  } catch (error) {
    log.warn('saudação do grupo não enviada', { name: error?.name });
  }
}
