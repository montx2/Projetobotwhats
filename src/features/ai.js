// 🧠 IA — chat, imagens, voz, tradução e resumo.
//
// Provedores de texto (pool com rotação de chaves, igual você gosta):
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
import { postJson, fetchBuffer, fetchText, sleep } from '../core/http.js';
import { log } from '../core/logger.js';

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

// Memória curta por chat para .ia
const memory = new Map(); // jid -> { turns: [], ts }
const MEMORY_TTL = 30 * 60_000;
const MEMORY_MAX = 10;

export function resetChatMemory(jid) {
  memory.delete(jid);
}

function remember(jid, role, content) {
  let m = memory.get(jid);
  if (!m || Date.now() - m.ts > MEMORY_TTL) m = { turns: [], ts: Date.now() };
  m.turns.push({ role, content });
  if (m.turns.length > MEMORY_MAX) m.turns = m.turns.slice(-MEMORY_MAX);
  m.ts = Date.now();
  memory.set(jid, m);
}

// ── Chamadas por provedor ──────────────────────────────────
async function openAICompat(base, key, model, messages) {
  const data = await postJson(
    `${base.replace(/\/$/, '')}/chat/completions`,
    { model, messages, max_tokens: 1200, temperature: 0.7 },
    { headers: { authorization: `Bearer ${key}` }, timeoutMs: 90_000 }
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
  // Pollinations é compatível com OpenAI e funciona sem chave (com chave, o
  // limite de requisições sobe bastante e os 402 somem na maioria dos casos).
  try {
    const data = await postJson(
      'https://text.pollinations.ai/openai',
      { model: 'openai', messages, max_tokens: 1200, temperature: 0.7 },
      { headers: { referrer: 'nexusbot', ...pollinationsAuthHeaders(key) }, timeoutMs: 90_000 }
    );
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new Error('resposta vazia');
    return text.trim();
  } catch (error) {
    // fallback GET simples
    const user = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
    const system = messages.find((m) => m.role === 'system')?.content || '';
    const url =
      `https://text.pollinations.ai/${encodeURIComponent(user)}?model=openai&referrer=nexusbot` +
      (system ? `&system=${encodeURIComponent(system)}` : '');
    const text = await fetchText(url, { timeoutMs: 90_000, headers: pollinationsAuthHeaders(key) });
    if (!text || text.length < 2) throw new Error('pollinations vazio');
    return text.trim();
  }
}

/** Tenta com cada chave do pool (se houver); sem chave nenhuma, tenta anônimo. */
async function pollinationsText(messages) {
  if (pools.pollinations.size) {
    return pools.pollinations.run((key) => pollinationsTextOnce(messages, key));
  }
  return pollinationsTextOnce(messages, '');
}

/** Chat com fallback em cascata por todos os pools. */
export async function aiChat(jid, userText) {
  const system = cfg.get().ia.sistema;
  const m = memory.get(jid);
  const history = m && Date.now() - m.ts <= MEMORY_TTL ? m.turns : [];
  const messages = [{ role: 'system', content: system }, ...history, { role: 'user', content: userText }];

  const attempts = [];
  const model = ENV.aiModel || 'gpt-4o-mini';

  if (pools.ai.size) attempts.push(() => pools.ai.run((key) => openAICompat(ENV.aiBase || ENV.openaiBase, key, ENV.aiModel || model, messages)));
  if (pools.groq.size) attempts.push(() => pools.groq.run((key) => openAICompat('https://api.groq.com/openai/v1', key, 'llama-3.3-70b-versatile', messages)));
  if (pools.openai.size) attempts.push(() => pools.openai.run((key) => openAICompat('https://api.openai.com/v1', key, model, messages)));
  if (pools.gemini.size) attempts.push(() => pools.gemini.run((key) => geminiCall(key, messages)));
  attempts.push(() => pollinationsText(messages));

  const errors = [];
  for (const attempt of attempts) {
    try {
      const reply = await attempt();
      remember(jid, 'user', userText);
      remember(jid, 'assistant', reply);
      return reply;
    } catch (error) {
      errors.push(String(error.message || error).slice(0, 100));
      log.warn(`IA falhou, tentando próximo provedor: ${String(error.message || error).slice(0, 100)}`);
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
  const m = model || cfg.get().ia.modeloImagem || 'flux';
  const seed = Math.floor(Math.random() * 1_000_000_000);
  log.ai(`gerando imagem: "${prompt.slice(0, 60)}"`);
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
  const v = voice || cfg.get().ia.vozPadrao || 'nova';
  if (pools.pollinations.size) {
    return pools.pollinations.run((key) => aiVoiceOnce(text, v, key));
  }
  return aiVoiceOnce(text, v, '');
}

// ── Tradução / resumo via chat ─────────────────────────────
export async function aiTranslate(text, target = 'português do Brasil') {
  return aiChatRaw(
    `Você é um tradutor profissional. Traduza EXATAMENTE o texto abaixo para ${target}. ` +
      `Devolve só a tradução, nada mais.\n\nTexto:\n${text}`
  );
}

export async function aiSummary(text) {
  return aiChatRaw(
    'Resuma o texto abaixo em português, em bullets curtos e claros, destacando o essencial. Máximo 10 linhas.\n\n' + text
  );
}

async function aiChatRaw(prompt) {
  const messages = [{ role: 'user', content: prompt }];
  const attempts = [];
  if (pools.ai.size) attempts.push(() => pools.ai.run((key) => openAICompat(ENV.aiBase || ENV.openaiBase, key, ENV.aiModel || 'gpt-4o-mini', messages)));
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
