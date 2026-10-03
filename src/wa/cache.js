// Cache de mensagens com retenção curta. Mensagens só são persistidas quando o
// dono habilita Anti-Delete para aquele chat; o restante fica apenas em memória.
import fs from 'node:fs';
import { dataFile, readJson, writeJsonNow, writeJsonDebounced } from '../core/store.js';
import { cfg } from '../core/config.js';

const MAX_PER_CHAT = 100;
const MAX_TOTAL = 1000;
const DEFAULT_TTL_MS = 24 * 60 * 60_000;
const FILE = 'cache/messages.json';
const MAX_CACHE_FILE_BYTES = 32 * 1024 * 1024;
const cacheKey = (jid, id) => `${jid}\u0000${id}`;
const normalizeJid = (jid) => String(jid || '').toLowerCase().replace(/:\d+@/, '@').trim();
const isIgnoredChat = (jid, rules = []) => rules.some((rule) => {
  const target = normalizeJid(rule);
  if (['grupos', 'grupo', 'groups'].includes(target)) return normalizeJid(jid).endsWith('@g.us');
  if (['privado', 'private', 'pv', 'dm'].includes(target)) return !normalizeJid(jid).endsWith('@g.us');
  return target === normalizeJid(jid) || (target.includes('@') && normalizeJid(jid).startsWith(target.replace(/@.*/, '')));
});
const VIEW_ONCE_WRAPPERS = new Set(['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension']);
export function containsViewOnce(value, depth = 0, seen = new Set()) {
  if (!value || typeof value !== 'object' || depth > 12 || seen.has(value)) return false;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return false;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (VIEW_ONCE_WRAPPERS.has(key) || child?.viewOnce === true) return true;
    if (containsViewOnce(child, depth + 1, seen)) return true;
  }
  return false;
}

export class MessageCache {
  constructor({ ttlMs = DEFAULT_TTL_MS, maxPerChat = MAX_PER_CHAT, maxTotal = MAX_TOTAL } = {}) {
    this.byChat = new Map();
    this.byId = new Map();
    this.total = 0;
    const requestedTtl = Number(ttlMs);
    const requestedPerChat = Number(maxPerChat);
    const requestedTotal = Number(maxTotal);
    this.ttlMs = Math.min(DEFAULT_TTL_MS, Number.isFinite(requestedTtl) && requestedTtl > 0 ? Math.max(1_000, requestedTtl) : DEFAULT_TTL_MS);
    this.maxPerChat = Math.min(MAX_PER_CHAT, Math.max(1, Number.isFinite(requestedPerChat) ? Math.floor(requestedPerChat) : MAX_PER_CHAT));
    this.maxTotal = Math.min(MAX_TOTAL, Math.max(1, Number.isFinite(requestedTotal) ? Math.floor(requestedTotal) : MAX_TOTAL));
    this.#load();
  }

  #remove(jid, id) {
    const map = this.byChat.get(jid);
    const entry = map?.get(id);
    if (!entry) return false;
    map.delete(id);
    if (!map.size) this.byChat.delete(jid);
    const key = cacheKey(jid, id);
    if (this.byId.get(key) === entry) this.byId.delete(key);
    this.total = Math.max(0, this.total - 1);
    return true;
  }

  #load() {
    try {
      if (fs.statSync(dataFile(FILE)).size > MAX_CACHE_FILE_BYTES) {
        // A corrupt/oversized local cache must not trigger an unbounded JSON parse.
        writeJsonNow(FILE, {});
        return;
      }
    } catch {}
    const saved = readJson(FILE, null);
    if (!saved || typeof saved !== 'object') return;
    const now = Date.now();
    const settings = cfg.get().antiDelete;
    let discarded = false;
    const savedCount = Object.values(saved).reduce((total, entries) => total + (Array.isArray(entries) ? entries.length : 0), 0);
    for (const [jid, entries] of Object.entries(saved)) {
      const optedIn = Array.isArray(settings.chats) && settings.chats.some((chat) => normalizeJid(chat) === normalizeJid(jid));
      if (!optedIn || isIgnoredChat(jid, settings.ignorar)) { discarded = true; continue; }
      if (!Array.isArray(entries)) { discarded = true; continue; }
      for (const raw of entries) {
        const ts = Number(raw?.ts);
        if (!raw?.id || !raw?.message || containsViewOnce(raw.message) || !Number.isFinite(ts) || ts <= 0 || ts > now || now - ts > this.ttlMs) {
          discarded = true;
          continue;
        }
        this.#insert({ ...raw, jid, ts, persisted: true }, true);
      }
    }
    this.prune();
    // Remove stale, oversized, private/legacy or no-longer-opted-in data.
    if (discarded || this.total < savedCount) this.#persist();
  }

  #insert(entry, enforceLimits = true) {
    let map = this.byChat.get(entry.jid);
    if (!map) {
      map = new Map();
      this.byChat.set(entry.jid, map);
    }
    const previous = map.get(entry.id);
    const key = cacheKey(entry.jid, entry.id);
    if (previous && this.byId.get(key) === previous) this.byId.delete(key);
    else if (!previous) this.total++;
    map.set(entry.id, entry);
    this.byId.set(key, entry);

    if (!enforceLimits) return;
    while (map.size > this.maxPerChat) this.#remove(entry.jid, map.keys().next().value);
    while (this.total > this.maxTotal) {
      const firstChat = this.byChat.keys().next().value;
      const firstId = this.byChat.get(firstChat)?.keys().next().value;
      if (!firstId) break;
      this.#remove(firstChat, firstId);
    }
  }

  #persist() {
    const out = {};
    for (const [jid, map] of this.byChat) {
      const persistent = [...map.values()].filter((entry) => entry.persisted);
      if (persistent.length) out[jid] = persistent;
    }
    writeJsonDebounced(FILE, out);
  }

  prune(now = Date.now()) {
    let changed = false;
    for (const [jid, map] of [...this.byChat]) {
      for (const [id, entry] of [...map]) {
        const requestedTtl = Number(entry.ttlMs);
        const ttl = Math.min(this.ttlMs, Number.isFinite(requestedTtl) && requestedTtl > 0 ? requestedTtl : this.ttlMs);
        const ts = Number(entry.ts);
        if (!Number.isFinite(ts) || ts <= 0 || ts > now || now - ts > ttl) changed = this.#remove(jid, id) || changed;
      }
    }
    if (changed) this.#persist();
    return changed;
  }

  /** Guarda uma mensagem autorizada. `persist` só deve ser true com Anti-Delete opt-in. */
  put(msg, { persist = false, ttlMs = this.ttlMs } = {}) {
    const jid = msg?.key?.remoteJid;
    const id = msg?.key?.id;
    if (!jid || !id || !msg.message) return;
    this.prune();
    const now = Date.now();
    const messageTs = Number(msg.messageTimestamp) * 1000;
    const ts = Number.isFinite(messageTs) && messageTs > 0 && messageTs <= now ? messageTs : now;
    const entry = {
      id,
      jid,
      fromMe: !!msg.key.fromMe,
      pushName: msg.pushName || null,
      ts,
      message: msg.message,
      persisted: Boolean(persist && !containsViewOnce(msg.message)),
      ttlMs: Math.min(this.ttlMs, Math.max(1_000, Number(ttlMs) || this.ttlMs))
    };
    this.#insert(entry);
    if (entry.persisted) this.#persist();
  }

  get(jid, id) {
    this.prune();
    const exact = this.byChat.get(jid)?.get(id);
    if (exact) return exact;
    const wanted = normalizeJid(jid);
    for (const [chat, map] of this.byChat) {
      if (normalizeJid(chat) === wanted && map.has(id)) return map.get(id);
    }
    return null;
  }

  clearChat(jid) {
    const wanted = normalizeJid(jid);
    const matches = [...this.byChat.keys()].filter((chat) => chat === jid || normalizeJid(chat) === wanted);
    if (!matches.length) return false;
    for (const chat of matches) {
      for (const id of [...(this.byChat.get(chat)?.keys() || [])]) this.#remove(chat, id);
    }
    this.#persist();
    return true;
  }

  clearWhere(predicate) {
    let removed = false;
    for (const jid of [...this.byChat.keys()]) {
      if (predicate(jid)) removed = this.clearChat(jid) || removed;
    }
    return removed;
  }

  clearAll() {
    this.byChat.clear();
    this.byId.clear();
    this.total = 0;
    this.#persist();
  }

  size() {
    this.prune();
    return this.total;
  }
}

export const messageCache = new MessageCache();
const pruneTimer = setInterval(() => messageCache.prune(), 15 * 60_000);
pruneTimer.unref?.();

const sentByBot = new Set();

export function markBotSent(id) {
  if (!id) return;
  sentByBot.add(id);
  if (sentByBot.size > 5000) sentByBot.delete(sentByBot.values().next().value);
}

export function isBotSent(id) {
  return Boolean(id && sentByBot.has(id));
}
