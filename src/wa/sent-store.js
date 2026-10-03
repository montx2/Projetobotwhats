// Memória curta das mensagens que o PRÓPRIO BOT enviou.
//
// Por que existe: quando o WhatsApp de alguém não consegue abrir uma mensagem
// (sessão de criptografia desatualizada, aparelho novo, grupo grande…), ele pede
// um reenvio ("retry receipt"). O Baileys atende esse pedido chamando
// `getMessage(key)` para recuperar o conteúdo original. Se ele devolver
// `undefined` (o padrão), o reenvio nunca acontece e a pessoa fica olhando para:
//   "Aguardando mensagem. Essa ação pode levar alguns instantes."
//
// Guardamos só em memória (nada vai para o disco), com limite de quantidade e de
// tempo — o WhatsApp só pede reenvio nos minutos seguintes ao envio.

const TTL_MS = 60 * 60_000;
const MAX_ENTRIES = 500;

const store = new Map();

/** Guarda o conteúdo (proto `message`) devolvido por sendMessage, indexado pelo ID. */
export function rememberSent(id, message, now = Date.now()) {
  if (!id || !message || typeof message !== 'object') return;
  store.delete(id); // reinsere no fim (mais recente)
  store.set(id, { message, at: now });
  while (store.size > MAX_ENTRIES) store.delete(store.keys().next().value);
}

/** Conteúdo original de uma mensagem enviada pelo bot, ou undefined se expirou/desconhecida. */
export function getSentMessage(id, now = Date.now()) {
  if (!id) return undefined;
  const entry = store.get(id);
  if (!entry) return undefined;
  if (now - entry.at > TTL_MS) {
    store.delete(id);
    return undefined;
  }
  return entry.message;
}

export function sentStoreSize() {
  return store.size;
}

export function clearSentStore() {
  store.clear();
}
