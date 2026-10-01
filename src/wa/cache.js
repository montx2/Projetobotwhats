// Cache de mensagens recebidas — alimenta o Anti-Delete e a View Once por resposta.
// Mantém em memória + snapshot em disco (as chaves de mídia ficam salvas,
// então mesmo após reiniciar o bot ainda conseguimos baixar a mídia apagada).

import { readJson, writeJsonDebounced } from '../core/store.js';

const MAX_PER_CHAT = 250;
const MAX_TOTAL = 4000;
const FILE = 'cache/messages.json';

export class MessageCache {
  constructor() {
    this.byChat = new Map(); // jid -> Map(id -> entry)
    this.byId = new Map(); // id -> entry (atalho para revokes vindos de outros chats)
    this.total = 0;
    this.#load();
  }

  #load() {
    const saved = readJson(FILE, null);
    if (!saved || typeof saved !== 'object') return;
    for (const [jid, entries] of Object.entries(saved)) {
      const map = new Map();
      for (const e of entries || []) {
        if (!e?.id) continue;
        map.set(e.id, e);
        this.byId.set(e.id, e);
        this.total++;
      }
      if (map.size) this.byChat.set(jid, map);
    }
  }

  #persist() {
    const out = {};
    for (const [jid, map] of this.byChat) out[jid] = [...map.values()];
    writeJsonDebounced(FILE, out);
  }

  /** Guarda uma mensagem recebida. */
  put(msg) {
    const jid = msg?.key?.remoteJid;
    const id = msg?.key?.id;
    if (!jid || !id || !msg.message) return;
    const entry = {
      id,
      jid,
      fromMe: !!msg.key.fromMe,
      pushName: msg.pushName || null,
      ts: Number(msg.messageTimestamp) * 1000 || Date.now(),
      message: msg.message
    };
    let map = this.byChat.get(jid);
    if (!map) {
      map = new Map();
      this.byChat.set(jid, map);
    }
    if (!map.has(id)) this.total++;
    map.set(id, entry);
    this.byId.set(id, entry);

    // poda por chat
    if (map.size > MAX_PER_CHAT) {
      const first = map.keys().next().value;
      const old = map.get(first);
      map.delete(first);
      if (this.byId.get(first) === old) this.byId.delete(first);
      this.total--;
    }
    // poda global
    if (this.total > MAX_TOTAL) {
      outer: for (const [chatJid, m] of this.byChat) {
        for (const oldId of m.keys()) {
          const old = m.get(oldId);
          m.delete(oldId);
          if (this.byId.get(oldId) === old) this.byId.delete(oldId);
          this.total--;
          if (this.total <= MAX_TOTAL) break outer;
        }
      }
    }
    this.#persist();
  }

  /** Busca pelo id (revokes podem chegar sem o remoteJid correto). */
  getById(id) {
    return this.byId.get(id) || null;
  }

  get(jid, id) {
    return this.byChat.get(jid)?.get(id) || this.byId.get(id) || null;
  }

  size() {
    return this.total;
  }
}

export const messageCache = new MessageCache();

const sentByBot = new Set();

export function markBotSent(id) {
  if (!id) return;
  sentByBot.add(id);
  if (sentByBot.size > 5000) {
    sentByBot.delete(sentByBot.values().next().value);
  }
}

export function isBotSent(id) {
  return Boolean(id && sentByBot.has(id));
}

