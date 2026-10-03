// 🧠 IA — chat, imagens, voz, tradução e resumo.
//
// Provedores de texto (rotação com limites/cooldowns respeitados):
//   AI_KEYS + AI_BASE_URL  → qualquer API compatível com OpenAI (OpenRouter, Groq, DeepSeek...)
//   GROQ_KEYS              → Groq (grátis e rápido)
//   OPENAI_KEYS            → OpenAI
//   GEMINI_KEYS            → Google Gemini
//   POLLINATIONS_KEYS      → Pollinations com chave (sobe o limite; funciona sem chave também)
//
// Imagem e voz: sempre Pollinations — com POLLINATIONS_KEYS se configurado,
// senão anônimo (limite bem menor, ~1 req/15s, e sujeito a 402 em pico de uso).

import { KeyPool } from '../core/keypool.js';
import { ENV, cfg } from '../core/config.js';
import { postJson, fetchBuffer, sleep } from '../core/http.js';
import { log } from '../core/logger.js';
import { normalizeJid } from '../util/text.js';

// ── Pools de chaves ────────────────────────────────────────
const pools = {
  ai: new KeyPool('ai-custom', ENV.aiKeys, { cooldownMs: 10 * 60_000 }),
  groq: new KeyPool('groq', ENV.groqKeys, { cooldownMs: 5 * 60_000 }),
  openai: new KeyPool('openai', ENV.openaiKeys, { cooldownMs: 10 * 60_000 }),
  gemini: new KeyPool('gemini', ENV.geminiKeys, { cooldownMs: 5 * 60_000 }),
  // Pollinations é grátis sem chave, mas sem chave o limite é ~1 req/15s por
  // IP e devolve 402 quando o uso compartilhado aperta. Com chave(s) grátis
  // (auth.pollinations.ai) o limite sobe bastante.
  pollinations: new KeyPool('pollinations', ENV.pollinationsKeys, { cooldownMs: 2 * 60_000 })
};

/** Cabeçalho de auth do Pollinations, se tivermos chave disponível (ou vazio). */
function pollinationsAuthHeaders(key) {
  return key ? { authorization: `Bearer ${key}` } : {};
}

const GEMINI_MODEL = 'gemini-2.0-flash';

// Memória curta em RAM, identificada por chat + remetente (nunca compartilhada
// por todos os membros de um grupo). Nenhum conteúdo de IA é persistido em disco.
const memory = new Map();
const MEMORY_TTL = 30 * 60_000;
const MEMORY_MAX = 8;
const MEMORY_MAX_CHARS = 6_000;
const MEMORY_MAX_ENTRIES = 500;
const MAX_AI_INPUT_CHARS = 3_000;

export function resetChatMemory(memoryKey) {
  memory.delete(memoryKey);
}

export function resetChatMemoryForChat(chatJid) {
  const prefix = `${normalizeJid(chatJid)}:`;
  for (const key of memory.keys()) {
    if (key.startsWith(prefix)) memory.delete(key);
  }
}

function pruneMemory(now = Date.now()) {
  for (const [key, value] of memory) {
    if (now - value.ts > MEMORY_TTL) memory.delete(key);
  }
  while (memory.size > MEMORY_MAX_ENTRIES) memory.delete(memory.keys().next().value);
}

function historyFor(m) {
  if (!m || Date.now() - m.ts > MEMORY_TTL) return [];
  const selected = [];
  let chars = 0;
  for (const turn of [...m.turns].reverse()) {
    const size = String(turn.content || '').length;
    if (selected.length >= MEMORY_MAX || chars + size > MEMORY_MAX_CHARS) break;
    selected.unshift(turn);
    chars += size;
  }
  return selected;
}

function remember(memoryKey, role, content) {
  const now = Date.now();
  pruneMemory(now);
  let entry = memory.get(memoryKey);
  if (!entry || now - entry.ts > MEMORY_TTL) entry = { turns: [], ts: now };
  entry.turns.push({ role, content: String(content || '').slice(0, 2_000) });
  if (entry.turns.length > MEMORY_MAX) entry.turns = entry.turns.slice(-MEMORY_MAX);
  entry.ts = now;
  memory.delete(memoryKey);
  memory.set(memoryKey, entry);
  pruneMemory(now);
}

const memorySweep = setInterval(() => pruneMemory(), 5 * 60_000);
memorySweep.unref?.();

// ── Chamadas por provedor ──────────────────────────────────
async function openAICompat(base, key, model, messages, { allowPrivate = false } = {}) {
  const data = await postJson(
    `${base.replace(/\/$/, '')}/chat/completions`,
    { model, messages, max_tokens: 1200, temperature: 0.7 },
    { headers: { authorization: `Bearer ${key}` }, timeoutMs: 90_000, allowPrivate }
  );
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('resposta vazia');
  return text.trim();
}

async function geminiCall(key, messages) {
  const system = messages.find((m) => m.role === 'system')?.content;
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const body = { contents };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const data = await postJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`,
    body,
    { timeoutMs: 90_000 }
  );
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('');
  if (!text) throw new Error('resposta vazia do gemini');
  return text.trim();
}

async function pollinationsTextOnce(messages, key) {
  // POST evita colocar prompts privados em URLs, proxies e access logs.
  const data = await postJson(
    'https://text.pollinations.ai/openai',
    { model: 'openai', messages, max_tokens: 1200, temperature: 0.7 },
    { headers: { referrer: 'nexusbot', ...pollinationsAuthHeaders(key) }, timeoutMs: 90_000 }
  );
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('resposta vazia');
  return text.trim();
}

/** Tenta com cada chave do pool (se houver); sem chave nenhuma, tenta anônimo. */
async function pollinationsText(messages) {
  if (pools.pollinations.size) {
    return pools.pollinations.run((key) => pollinationsTextOnce(messages, key));
  }
  return pollinationsTextOnce(messages, '');
}

/** Chat com fallback em cascata por todos os pools. */
export async function aiChat(memoryKey, userText) {
  const question = String(userText || '').trim();
  if (!question) throw new Error('escreva uma pergunta para a IA');
  if (question.length > MAX_AI_INPUT_CHARS) throw new Error(`texto longo demais (máximo ${MAX_AI_INPUT_CHARS} caracteres)`);
  pruneMemory();
  const system = cfg.get().ia.sistema;
  const history = historyFor(memory.get(memoryKey));
  const messages = [{ role: 'system', content: system }, ...history, { role: 'user', content: question }];

  const attempts = [];
  const model = ENV.aiModel || 'gpt-4o-mini';

  if (pools.ai.size) attempts.push(() => pools.ai.run((key) => openAICompat(ENV.aiBase || ENV.openaiBase, key, ENV.aiModel || model, messages, { allowPrivate: true })));
  if (pools.groq.size) attempts.push(() => pools.groq.run((key) => openAICompat('https://api.groq.com/openai/v1', key, 'llama-3.3-70b-versatile', messages)));
  if (pools.openai.size) attempts.push(() => pools.openai.run((key) => openAICompat('https://api.openai.com/v1', key, model, messages)));
  if (pools.gemini.size) attempts.push(() => pools.gemini.run((key) => geminiCall(key, messages)));
  attempts.push(() => pollinationsText(messages));

  const errors = [];
  for (const attempt of attempts) {
    try {
      const reply = await attempt();
      remember(memoryKey, 'user', question);
      remember(memoryKey, 'assistant', reply);
      return reply;
    } catch (error) {
      errors.push(String(error.message || error).slice(0, 100));
      log.warn('IA falhou; tentando o próximo provedor', { status: error?.status, code: error?.code });
      await sleep(300);
    }
  }
  throw new Error(`Todos os provedores de IA falharam: ${errors.join(' | ').slice(0, 300)}`);
}

// ── Geração de imagem (Pollinations) ───────────────────────
async function aiImageOnce(prompt, { width, height, model, seed }, key) {
  const url =
    `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}` +
    `?width=${width}&height=${height}&seed=${seed}&model=${model}&nologo=true&safe=true&referrer=nexusbot`;
  const buffer = await fetchBuffer(url, { timeoutMs: 180_000, maxBytes: 40 * 1024 * 1024, headers: pollinationsAuthHeaders(key) });
  if (buffer.length < 1024) throw new Error('imagem gerada vazia');
  return buffer;
}

export async function aiImage(prompt, { width = 1024, height = 1024, model } = {}) {
  prompt = String(prompt || '').trim();
  if (!prompt) throw new Error('descreva a imagem que deseja criar');
  if (prompt.length > 1_200) throw new Error('descrição longa demais (máximo 1.200 caracteres)');
  width = Math.min(1536, Math.max(256, Number(width) || 1024));
  height = Math.min(1536, Math.max(256, Number(height) || 1024));
  const m = model || cfg.get().ia.modeloImagem || 'flux';
  const seed = Math.floor(Math.random() * 1_000_000_000);
  log.ai('gerando imagem (prompt não é gravado nos logs)');
  const opts = { width, height, model: m, seed };
  if (pools.pollinations.size) {
    return pools.pollinations.run((key) => aiImageOnce(prompt, opts, key));
  }
  return aiImageOnce(prompt, opts, '');
}

// ── Voz (Pollinations audio) ───────────────────────────────
async function aiVoiceOnce(text, voice, key) {
  const url = `https://text.pollinations.ai/${encodeURIComponent(text)}?model=openai-audio&voice=${voice}&referrer=nexusbot`;
  const buffer = await fetchBuffer(url, { timeoutMs: 120_000, maxBytes: 25 * 1024 * 1024, headers: pollinationsAuthHeaders(key) });
  if (buffer.length < 2048) throw new Error('áudio vazio');
  return buffer;
}

export async function aiVoice(text, voice) {
  text = String(text || '').trim();
  if (!text) throw new Error('escreva o texto para transformar em áudio');
  if (text.length > 900) throw new Error('texto longo demais para áudio (máximo 900 caracteres)');
  const v = voice || cfg.get().ia.vozPadrao || 'nova';
  if (pools.pollinations.size) {
    return pools.pollinations.run((key) => aiVoiceOnce(text, v, key));
  }
  return aiVoiceOnce(text, v, '');
}

// ── Tradução / resumo via chat ─────────────────────────────
export async function aiTranslate(text, target = 'português do Brasil') {
  const source = String(text || '').trim();
  if (!source) throw new Error('envie ou cite um texto para traduzir');
  if (source.length > 2_500) throw new Error('texto longo demais para tradução (máximo 2.500 caracteres)');
  const language = String(target || '').trim().slice(0, 80) || 'português do Brasil';
  return aiChatRaw(
    `Você é um tradutor profissional. Traduza EXATAMENTE o texto abaixo para ${language}. ` +
      `Devolva só a tradução, nada mais.\n\nTexto:\n${source}`
  );
}

export async function aiSummary(text) {
  const source = String(text || '').trim();
  if (!source) throw new Error('envie ou cite um texto para resumir');
  if (source.length > 2_500) throw new Error('texto longo demais para resumo (máximo 2.500 caracteres)');
  return aiChatRaw(
    'Resuma o texto abaixo em português, em bullets curtos e claros, destacando o essencial. Máximo 10 linhas.\n\n' + source
  );
}

async function aiChatRaw(prompt) {
  if (String(prompt).length > 3_000) throw new Error('texto de IA longo demais');
  const messages = [{ role: 'user', content: prompt }];
  const attempts = [];
  if (pools.ai.size) attempts.push(() => pools.ai.run((key) => openAICompat(ENV.aiBase || ENV.openaiBase, key, ENV.aiModel || 'gpt-4o-mini', messages, { allowPrivate: true })));
  if (pools.groq.size) attempts.push(() => pools.groq.run((key) => openAICompat('https://api.groq.com/openai/v1', key, 'llama-3.3-70b-versatile', messages)));
  if (pools.openai.size) attempts.push(() => pools.openai.run((key) => openAICompat('https://api.openai.com/v1', key, 'gpt-4o-mini', messages)));
  if (pools.gemini.size) attempts.push(() => pools.gemini.run((key) => geminiCall(key, messages)));
  attempts.push(() => pollinationsText(messages));
  const errors = [];
  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (error) {
      errors.push(String(error.message || error).slice(0, 80));
    }
  }
  throw new Error(`IA indisponível: ${errors.join(' | ').slice(0, 200)}`);
}

export function aiStatus() {
  const rows = [];
  for (const [name, pool] of Object.entries(pools)) {
    if (name === 'pollinations') continue;
    rows.push(pool.size ? `${name}: ${pool.available}/${pool.size} chaves` : null);
  }
  rows.push(
    pools.pollinations.size
      ? `pollinations: ${pools.pollinations.available}/${pools.pollinations.size} chaves`
      : 'pollinations: grátis sem chave (limite baixo — veja POLLINATIONS_KEYS no .env)'
  );
  return rows.filter(Boolean);
}
