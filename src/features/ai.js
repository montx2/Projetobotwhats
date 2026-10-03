// 🧠 IA — chat, imagens, voz, tradução e resumo.
//
// Provedores de texto (rotação com limites/cooldowns respeitados):
//   AI_KEYS + AI_BASE_URL  → qualquer API compatível com OpenAI (OpenRouter, Groq, DeepSeek...)
//   GROQ_KEYS              → Groq (grátis e rápido)
//   OPENAI_KEYS            → OpenAI
//   GEMINI_KEYS            → Google Gemini
//   POLLINATIONS_KEYS      → Pollinations com chave (sobe o limite; funciona sem chave também)
//
// DUAS CAMADAS DE REDUNDÂNCIA (importante — provedores mudam o tempo todo):
//   1) VÁRIAS CHAVES do mesmo provedor (GROQ_KEYS=gsk_1,gsk_2,gsk_3). O pool gira
//      em rodízio e só tira de circulação a chave que estourou o limite.
//   2) VÁRIOS MODELOS por chave. Um 404 de "modelo não existe" NÃO é problema de
//      chave: o provedor descontinuou o modelo. Girar a chave não resolve nada,
//      então o bot tenta o próximo modelo com a MESMA chave antes de desistir.
//      Se todos os modelos conhecidos falharem, ele ainda pergunta ao provedor
//      quais modelos existem (GET /models) e usa um deles.
//
// Imagem e voz: sempre Pollinations — com POLLINATIONS_KEYS se configurado,
// senão anônimo (limite bem menor, ~1 req/15s, e sujeito a 402 em pico de uso).

import { KeyPool, isModelError, isModelMissingForEveryone, formatCooldown } from '../core/keypool.js';
import { ENV, cfg } from '../core/config.js';
import { loadDotEnv, ENV_FILE } from '../core/env.js';
import { postJson, fetchJson, fetchBuffer, sleep } from '../core/http.js';
import { log } from '../core/logger.js';
import { normalizeJid } from '../util/text.js';
import {
  convertCurrency,
  extractCurrencyIntent,
  extractHolidayIntent,
  extractWeatherLocation,
  formatCurrencyContext,
  formatHolidayContext,
  formatWeatherContext,
  getPublicHolidays,
  getWeatherByCity
} from './public-apis.js';

// ── Pools de chaves ────────────────────────────────────────
// Ficam em um objeto mutável (e não congelado) para que `.pools recarregar`
// possa reler o .env e remontar tudo sem reiniciar o bot.
const POOL_DEFS = {
  ai: { name: 'ai-custom', read: () => ENV.aiKeys, cooldownMs: 10 * 60_000 },
  groq: { name: 'groq', read: () => ENV.groqKeys, cooldownMs: 5 * 60_000 },
  openai: { name: 'openai', read: () => ENV.openaiKeys, cooldownMs: 10 * 60_000 },
  gemini: { name: 'gemini', read: () => ENV.geminiKeys, cooldownMs: 5 * 60_000 },
  // Pollinations é grátis sem chave, mas sem chave o limite é ~1 req/15s por
  // IP e devolve 402 quando o uso compartilhado aperta. Com chave(s) grátis
  // (auth.pollinations.ai) o limite sobe bastante.
  pollinations: { name: 'pollinations', read: () => ENV.pollinationsKeys, cooldownMs: 2 * 60_000 }
};

const pools = {};

function buildPools() {
  for (const [key, def] of Object.entries(POOL_DEFS)) {
    pools[key] = new KeyPool(def.name, def.read(), { cooldownMs: def.cooldownMs });
  }
}

buildPools();

/** Cabeçalho de auth do Pollinations, se tivermos chave disponível (ou vazio). */
function pollinationsAuthHeaders(key) {
  return key ? { authorization: `Bearer ${key}` } : {};
}

const GROQ_BASE = 'https://api.groq.com/openai/v1';
const OPENAI_BASE = 'https://api.openai.com/v1';

// ── Modelos (lista, não nome único) ─────────────────────────
// Provedores aposentam modelos com frequência. Exemplos reais que quebraram
// este bot: a Groq desligou `llama-3.3-70b-versatile` em 16/08/2026 (404
// model_not_found) e o Google desligou `gemini-2.0-flash` em 01/06/2026.
// Por isso cada provedor tem uma LISTA em ordem de preferência — o primeiro que
// responder ganha. Sobrescreva com GROQ_MODELS / GEMINI_MODELS / OPENAI_MODELS
// / AI_MODELS no .env (separados por vírgula) sem mexer no código.
const DEFAULT_GROQ_MODELS = [
  'openai/gpt-oss-120b', // substituto oficial do llama-3.3-70b-versatile
  'openai/gpt-oss-20b',
  'qwen/qwen3.8-27b',
  'qwen/qwen3.6-27b',
  'llama-3.3-70b-versatile' // último recurso (só contas enterprise)
];
const DEFAULT_GEMINI_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-2.5-flash',
  'gemini-2.0-flash'
];
const DEFAULT_OPENAI_MODELS = ['gpt-4o-mini'];
const DEFAULT_AI_MODELS = ['gpt-4o-mini'];

// Modelos que devolveram 404 ficam marcados por 30 min: evita repetir o mesmo
// erro a cada mensagem enquanto o restante da lista continua funcionando.
const MODEL_BLOCK_MS = 30 * 60_000;
// Se NENHUM modelo do provedor responder, ele fica suspenso por 1 min: as
// próximas mensagens caem direto para o próximo provedor em vez de repetir a
// bateria de tentativas. (Memória RAM — reiniciar ou `.pools reset` limpa.)
const PROVIDER_SUSPEND_MS = 60_000; // 60s
const MODEL_CACHE_MS = 10 * 60_000;
const blockedModels = new Map(); // "provedor::modelo" -> timestamp de liberação
const discoveredModels = new Map(); // "provedor::base" -> { models, expiresAt }

// Modelos que não atendem chat de texto (áudio, embeddings, moderação etc.).
const NON_CHAT_MODEL_RE =
  /(whisper|tts|text-to-speech|speech|embed|guard|moderation|rerank|transcri|audio|music|voice|live|realtime|image|imagen|nano-banana|computer-use|computer_use)/i;

function modelKey(provider, model) {
  return `${provider}::${model}`;
}

function isModelBlocked(provider, model) {
  const until = blockedModels.get(modelKey(provider, model));
  if (!until) return false;
  if (until <= Date.now()) {
    blockedModels.delete(modelKey(provider, model));
    return false;
  }
  return true;
}

function blockModel(provider, model, ms = MODEL_BLOCK_MS) {
  blockedModels.set(modelKey(provider, model), Date.now() + Math.max(1_000, ms));
}

function unblockModel(provider, model) {
  blockedModels.delete(modelKey(provider, model));
}

function suspendProvider(provider, ms = PROVIDER_SUSPEND_MS) {
  blockedModels.set(modelKey(provider, '*'), Date.now() + Math.max(1_000, ms));
}

/** Provedor sem nenhum modelo de pé, com o tempo restante (ms) ou 0 se livre. */
function providerSuspendedMs(provider) {
  const until = blockedModels.get(modelKey(provider, '*'));
  if (!until || until <= Date.now()) return 0;
  return until - Date.now();
}

/** Resumo curto do erro para as mensagens (usa o JSON do provedor quando dá). */
function errorDetail(error, max = 160) {
  const fromApi = error?.data?.error?.message || error?.data?.message;
  return String(fromApi || error?.message || error || 'sem detalhe').slice(0, max);
}

/** Lista de modelos tentados, encurtada para caber na mensagem ao usuário. */
function shortModelList(models) {
  if (models.length <= 2) return models.join(', ');
  return `${models.slice(0, 2).join(', ')} +${models.length - 2}`;
}

/**
 * Motivo curto de um provedor ter falhado, para a mensagem final.
 * O detalhe completo (JSON do provedor, status) vai para o log, não pro chat.
 */
function shortReason(error) {
  if (error?.modelError) return error?.suspended ? 'sem modelo de pé agora' : 'modelo indisponível';
  const retry = Number(error?.retryAfterMs);
  if (Number.isFinite(retry) && retry > 0) return `limite (volta em ${formatCooldown(retry)})`;
  if (Number(error?.status) === 401 || Number(error?.status) === 403) return 'chave recusada';
  const text = String(error?.message || error).replace(/^HTTP \d+ em \S+:?\s*/, '').trim().slice(0, 70);
  const status = Number(error?.status);
  return status ? `HTTP ${status} — ${text}` : text || 'falhou';
}

/** Lista efetiva: a configurada pelo operador (ou o padrão), menos os modelos marcados. */
function activeModels(provider, configured, defaults) {
  const list = Array.isArray(configured) && configured.length ? configured : defaults;
  const clean = [...new Set(list.map((m) => String(m || '').trim()).filter(Boolean))];
  const available = clean.filter((m) => !isModelBlocked(provider, m));
  // Se todos os conhecidos estiverem marcados, tenta de novo mesmo assim: a
  // lista pode ter sido toda bloqueada por uma falha temporária do provedor.
  return available.length ? available : clean;
}

/**
 * Pergunta ao próprio provedor quais modelos existem (GET /models) — usado
 * quando todos os modelos que conhecemos devolvem 404. Resultado em cache.
 */
async function discoverModels(provider, base, key, { allowPrivate = false } = {}) {
  const cacheKey = `${provider}::${base}`;
  const cached = discoveredModels.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.models;
  const fail = () => {
    discoveredModels.set(cacheKey, { models: [], expiresAt: Date.now() + MODEL_CACHE_MS });
    return [];
  };
  try {
    const data = await fetchJson(`${String(base).replace(/\/$/, '')}/models`, {
      headers: { authorization: `Bearer ${key}` },
      timeoutMs: 20_000,
      maxBytes: 2 * 1024 * 1024,
      allowPrivate
    });
    const models = (Array.isArray(data?.data) ? data.data : [])
      .map((entry) => String(entry?.id || entry?.name || '').trim())
      .filter((id) => id && !NON_CHAT_MODEL_RE.test(id) && !isModelBlocked(provider, id));
    const unique = [...new Set(models)].slice(0, 40);
    discoveredModels.set(cacheKey, { models: unique, expiresAt: Date.now() + MODEL_CACHE_MS });
    return unique;
  } catch (error) {
    log.warn('não foi possível listar os modelos do provedor', {
      provider,
      status: error?.status,
      code: error?.code
    });
    return fail();
  }
}

/**
 * Tenta os modelos em ordem, com a MESMA chave:
 *   - erro de modelo (404/descontinuado) → marca o modelo e tenta o próximo;
 *   - erro de chave/limite/rede → propaga para o pool girar a chave.
 */
async function chatWithModelFallback({ provider, base, key, models, messages, allowPrivate = false, discover = true, poolSize = 1 }) {
  // Provedor inteiro fora do ar (nenhum modelo respondeu na última tentativa):
  // não repete a bateria de chamadas em cada mensagem — cai para o próximo.
  const suspended = providerSuspendedMs(provider);
  if (suspended) {
    const err = new Error(`sem modelos disponíveis (retenta em ${Math.ceil(suspended / 1000)}s)`);
    err.modelError = true;
    err.suspended = true;
    err.fatalForPool = true; // vai falhar igual com todas as chaves
    throw err;
  }

  const errors = [];
  const tried = [];

  const attempt = async (model) => {
    tried.push(model);
    try {
      const text = await openAICompat(base, key, model, messages, { allowPrivate });
      unblockModel(provider, model);
      return text;
    } catch (error) {
      errors.push(error);
      if (isModelError(error)) {
        blockModel(provider, model);
        return null;
      }
      throw error; // chave/limite/rede — deixa o KeyPool decidir
    }
  };

  for (const model of models) {
    const text = await attempt(model);
    if (text) return text;
  }

  // Nenhum modelo conhecido respondeu: descobre os modelos que o provedor tem.
  if (discover) {
    const found = await discoverModels(provider, base, key, { allowPrivate });
    for (const model of found.filter((m) => !tried.includes(m)).slice(0, 3)) {
      const text = await attempt(model);
      if (text) return text;
    }
  }

  // Modelo aposentado para todos: errar de novo com as outras chaves só atrasa.
  const fatalForPool = errors.length > 0 && errors.every(isModelMissingForEveryone);
  // Só suspende o provedor quando a falha não é culpa desta chave específica
  // (ou quando existe uma chave só) — assim outra conta com acesso ainda é
  // tentada, mas um provedor realmente fora do ar não é martelado.
  if (fatalForPool || poolSize <= 1) suspendProvider(provider);
  const err = new Error(
    `nenhum modelo disponível${tried.length ? ` (${shortModelList(tried)})` : ''} — ${errorDetail(errors.at(-1) || 'sem detalhe')}`
  );
  err.modelError = true;
  err.status = errors.at(-1)?.status;
  err.fatalForPool = fatalForPool;
  err.causes = errors;
  throw err;
}

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
// `max_tokens` é o nome antigo e ainda é aceito pela maioria, mas provedores
// novos (OpenAI recente, alguns modelos da Groq) exigem `max_completion_tokens`.
// Se o provedor rejeitar o parâmetro, trocamos uma vez e lembramos a escolha.
const tokenParamByBase = new Map(); // base -> 'max_tokens' | 'max_completion_tokens'

function isTokenParamError(error) {
  const status = Number(error?.status || 0);
  if (status !== 400 && status !== 422) return false;
  const msg = String(error?.message || error).toLowerCase();
  return msg.includes('max_completion_tokens') || msg.includes('max_tokens');
}

async function openAICompat(base, key, model, messages, { allowPrivate = false } = {}) {
  const url = `${String(base).replace(/\/$/, '')}/chat/completions`;
  const send = (param, value) =>
    postJson(
      url,
      { model, messages, [param]: value, temperature: 0.7 },
      { headers: { authorization: `Bearer ${key}` }, timeoutMs: 90_000, allowPrivate }
    );

  const preferred = tokenParamByBase.get(base) || 'max_tokens';
  let data;
  if (preferred === 'max_completion_tokens') {
    data = await send('max_completion_tokens', 4096);
  } else {
    try {
      data = await send('max_tokens', 1200);
    } catch (error) {
      if (!isTokenParamError(error)) throw error;
      tokenParamByBase.set(base, 'max_completion_tokens');
      log.warn('provedor exige max_completion_tokens; reenviando', { base, status: error?.status });
      data = await send('max_completion_tokens', 4096);
    }
  }

  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('resposta vazia');
  return text.trim();
}

async function geminiCall(key, model, messages) {
  const system = messages.find((m) => m.role === 'system')?.content;
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const body = { contents };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const data = await postJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
    body,
    { timeoutMs: 90_000 }
  );
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('');
  if (!text) throw new Error('resposta vazia do gemini');
  return text.trim();
}

/** Gemini tem API própria (não é compatível com OpenAI), mas ganha a mesma cascata de modelos. */
async function geminiWithModelFallback(key, models, messages, poolSize = 1) {
  const suspended = providerSuspendedMs('gemini');
  if (suspended) {
    const err = new Error(`sem modelos disponíveis (retenta em ${Math.ceil(suspended / 1000)}s)`);
    err.modelError = true;
    err.suspended = true;
    err.fatalForPool = true; // vai falhar igual com todas as chaves
    throw err;
  }

  const errors = [];
  const tried = [];
  for (const model of models) {
    tried.push(model);
    try {
      const text = await geminiCall(key, model, messages);
      unblockModel('gemini', model);
      return text;
    } catch (error) {
      errors.push(error);
      if (isModelError(error)) {
        blockModel('gemini', model);
        continue;
      }
      throw error;
    }
  }
  const fatalForPool = errors.length > 0 && errors.every(isModelMissingForEveryone);
  if (fatalForPool || poolSize <= 1) suspendProvider('gemini');
  const err = new Error(
    `nenhum modelo disponível (${shortModelList(tried)}) — ${errorDetail(errors.at(-1) || 'sem detalhe')}`
  );
  err.modelError = true;
  err.status = errors.at(-1)?.status;
  err.fatalForPool = fatalForPool;
  err.causes = errors;
  throw err;
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

async function publicApiContext(question) {
  const weatherLocation = extractWeatherLocation(question);
  if (weatherLocation) {
    try {
      return formatWeatherContext(await getWeatherByCity(weatherLocation));
    } catch (error) {
      log.warn('consulta de clima para IA falhou', { name: error?.name, status: error?.status, code: error?.code });
      throw new Error('não consegui consultar o clima agora; tente novamente ou use `.clima <cidade>`');
    }
  }

  const currency = extractCurrencyIntent(question);
  if (currency) {
    try {
      return formatCurrencyContext(await convertCurrency(currency.amount, currency.from, currency.to));
    } catch (error) {
      log.warn('consulta de câmbio para IA falhou', { name: error?.name, status: error?.status, code: error?.code });
      throw new Error('não consegui consultar essa conversão agora; confira os códigos de moeda e tente novamente');
    }
  }

  const holidays = extractHolidayIntent(question);
  if (holidays) {
    try {
      const data = await getPublicHolidays(holidays.year, holidays.country);
      return formatHolidayContext(data, holidays.year, holidays.country);
    } catch (error) {
      log.warn('consulta de feriados para IA falhou', { name: error?.name, status: error?.status, code: error?.code });
      throw new Error('não consegui consultar esse calendário de feriados agora; tente novamente mais tarde');
    }
  }

  return '';
}

/** Chat com fallback em cascata por todos os pools. */
export async function aiChat(memoryKey, userText) {
  const question = String(userText || '').trim();
  if (!question) throw new Error('escreva uma pergunta para a IA');
  if (question.length > MAX_AI_INPUT_CHARS) throw new Error(`texto longo demais (máximo ${MAX_AI_INPUT_CHARS} caracteres)`);
  pruneMemory();
  const apiContext = await publicApiContext(question);
  const baseSystem = cfg.get().ia.sistema;
  const system = apiContext ? `${baseSystem}\n\n${apiContext}` : baseSystem;
  const history = historyFor(memory.get(memoryKey));
  const messages = [{ role: 'system', content: system }, ...history, { role: 'user', content: question }];

  const errors = [];
  const providers = textProviders(messages);
  for (let i = 0; i < providers.length; i++) {
    const [label, attempt] = providers[i];
    try {
      const reply = await attempt();
      remember(memoryKey, 'user', question);
      remember(memoryKey, 'assistant', reply);
      return reply;
    } catch (error) {
      errors.push(`${label}: ${shortReason(error)}`);
      log.warn('IA falhou; tentando o próximo provedor', {
        provider: label,
        status: error?.status,
        code: error?.code,
        message: String(error?.message || error).slice(0, 200)
      });
      if (i < providers.length - 1) await sleep(300);
    }
  }
  throw new Error(`Todos os provedores de IA falharam (${errors.join(' · ')})`);
}

/**
 * Provedores de texto em ordem de preferência. Cada entrada já cuida das duas
 * camadas de redundância: rodízio de CHAVES (KeyPool) e cascata de MODELOS.
 */
function textProviders(messages) {
  const providers = [];

  if (pools.ai.size) {
    const base = ENV.aiBase || ENV.openaiBase;
    const models = activeModels('ai-custom', [ENV.aiModel, ...ENV.aiModels].filter(Boolean), DEFAULT_AI_MODELS);
    providers.push([
      'custom',
      () => pools.ai.run((key) => chatWithModelFallback({ provider: 'ai-custom', base, key, models, messages, allowPrivate: true, poolSize: pools.ai.size }))
    ]);
  }

  if (pools.groq.size) {
    const models = activeModels('groq', ENV.groqModels, DEFAULT_GROQ_MODELS);
    providers.push([
      'groq',
      () => pools.groq.run((key) => chatWithModelFallback({ provider: 'groq', base: GROQ_BASE, key, models, messages, poolSize: pools.groq.size }))
    ]);
  }

  if (pools.openai.size) {
    // Mantido no endpoint público da OpenAI: quem usa endpoint alternativo
    // (OpenRouter, proxy local…) configura AI_BASE_URL + AI_KEYS, que aceita
    // endereços privados explicitamente.
    const models = activeModels('openai', ENV.openaiModels, DEFAULT_OPENAI_MODELS);
    providers.push([
      'openai',
      () =>
        pools.openai.run((key) =>
          chatWithModelFallback({ provider: 'openai', base: OPENAI_BASE, key, models, messages, poolSize: pools.openai.size })
        )
    ]);
  }

  if (pools.gemini.size) {
    const models = activeModels('gemini', ENV.geminiModels, DEFAULT_GEMINI_MODELS);
    providers.push(['gemini', () => pools.gemini.run((key) => geminiWithModelFallback(key, models, messages, pools.gemini.size))]);
  }

  providers.push(['pollinations', () => pollinationsText(messages)]);
  return providers;
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

const POLL_WORD_FIXES = [
  [/\bnao\b/gi, 'não'],
  [/\btepende\b/gi, 'depende'],
  [/\btalves\b/gi, 'talvez'],
  [/\bconcerteza\b/gi, 'com certeza'],
  [/\bsabado\b/gi, 'sábado'],
  [/\bterca\b/gi, 'terça'],
  [/\bhorario\b/gi, 'horário'],
  [/\bninguem\b/gi, 'ninguém'],
  [/\balguem\b/gi, 'alguém'],
  [/\bvoce\b/gi, 'você'],
  [/\btambem\b/gi, 'também'],
  [/\bja\b/gi, 'já'],
  [/\bso\b/gi, 'só'],
  [/\bate\b/gi, 'até']
];

function polishPollText(text, { isQuestion = false } = {}) {
  let clean = String(text || '').replace(/\s+/g, ' ').trim();
  clean = clean.replace(/^[|:;,.!?-]+\s*|\s*[|,;:-]+$/g, '').trim();
  if (!clean) return '';
  for (const [pattern, replacement] of POLL_WORD_FIXES) {
    clean = clean.replace(pattern, (match) => {
      const isUpper = match[0] === match[0].toUpperCase() && match[0] !== match[0].toLowerCase();
      return isUpper ? replacement[0].toUpperCase() + replacement.slice(1) : replacement;
    });
  }
  clean = clean[0].toUpperCase() + clean.slice(1);
  if (isQuestion && !/[?!…]$/.test(clean)) clean += '?';
  return clean.slice(0, isQuestion ? 200 : 80);
}

function dedupePollOptions(options) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(options) ? options : []) {
    const clean = polishPollText(raw, { isQuestion: false });
    if (!clean) continue;
    const key = clean.toLocaleLowerCase('pt-BR');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= 12) break;
  }
  return out;
}

function splitNaturalOptions(raw) {
  return String(raw || '')
    .split(/\s*(?:,|;|\/|\n|\bou\b)\s*/i)
    .map((item) => polishPollText(item, { isQuestion: false }))
    .filter(Boolean);
}

export function parseNaturalPollFallback(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('informe o tema ou a pergunta da enquete');

  const qMatch = raw.match(/^(.+?[?:])\s+(.+)$/s);
  if (qMatch) {
    const question = polishPollText(qMatch[1].replace(/:$/, '?'), { isQuestion: true });
    const options = dedupePollOptions(splitNaturalOptions(qMatch[2]));
    if (question && options.length >= 2) return { question, options };
  }

  const firstSplit = raw.match(/^([^,;\n]+?)\s*[,;\n]+\s*(.+)$/s);
  if (firstSplit) {
    const candidateQ = firstSplit[1].trim();
    const restOptions = dedupePollOptions(splitNaturalOptions(firstSplit[2]));
    if (!/\bou\b/i.test(candidateQ) && restOptions.length >= 2) {
      return {
        question: polishPollText(candidateQ, { isQuestion: true }),
        options: restOptions
      };
    }
  }

  const directOptions = dedupePollOptions(splitNaturalOptions(raw.replace(/[?!.]+$/, '')));
  if (directOptions.length >= 2) {
    return {
      question: polishPollText(raw, { isQuestion: true }),
      options: directOptions
    };
  }

  return {
    question: polishPollText(raw, { isQuestion: true }),
    options: ['Sim', 'Não', 'Talvez']
  };
}

function parseAiPollResponse(rawResponse) {
  const text = String(rawResponse || '').trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
  const rawQuestion = parsed?.question || parsed?.pergunta || parsed?.title || parsed?.name || '';
  const rawOptions = parsed?.options || parsed?.opcoes || parsed?.values || parsed?.choices || [];
  const question = polishPollText(rawQuestion, { isQuestion: true });
  const options = dedupePollOptions(rawOptions);
  if (!question || options.length < 2) return null;
  return { question, options };
}

/** Interpreta texto livre com IA (e fallback inteligente) para montar uma enquete. */
export async function aiPoll(text) {
  const source = String(text || '').trim();
  if (!source) throw new Error('informe o tema ou a pergunta da enquete');
  if (source.length > 500) throw new Error('o texto da enquete deve ter no máximo 500 caracteres');
  const prompt = [
    'Você transforma pedidos informais no WhatsApp em uma enquete estruturada em português do Brasil.',
    'Corrija erros de digitação/acentuação (ex.: "tepende da hora" -> "Depende da hora", "nao" -> "Não", "Hoje tem fut" -> "Hoje tem fut?") e separe a pergunta das opções.',
    'Se a pessoa escreveu apenas a pergunta ou o tema sem listar opções, crie de 2 a 4 opções curtas e naturais.',
    'Regras:',
    '- "question": pergunta clara (máximo 200 caracteres), terminada em "?".',
    '- "options": array com 2 a 12 opções distintas e curtas (máximo 80 caracteres cada).',
    '- Responda APENAS com JSON puro, sem markdown:',
    '{"question":"Pergunta?","options":["Opção 1","Opção 2"]}',
    '',
    `Pedido: ${source}`
  ].join('\n');
  try {
    const raw = await aiChatRaw(prompt);
    const parsed = parseAiPollResponse(raw);
    if (parsed) return parsed;
  } catch (error) {
    log.warn('IA para enquete falhou; usando interpretação local', { name: error?.name, status: error?.status });
  }
  return parseNaturalPollFallback(source);
}

async function aiChatRaw(prompt) {
  if (String(prompt).length > 3_000) throw new Error('texto de IA longo demais');
  const messages = [{ role: 'user', content: prompt }];
  const errors = [];
  const providers = textProviders(messages);
  for (let i = 0; i < providers.length; i++) {
    const [label, attempt] = providers[i];
    try {
      return await attempt();
    } catch (error) {
      errors.push(`${label}: ${shortReason(error)}`);
      if (i < providers.length - 1) await sleep(300);
    }
  }
  throw new Error(`IA indisponível (${errors.join(' · ')})`);
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

/** Modelos que cada provedor vai tentar, em ordem (para `.pools`). */
export function aiModelStatus() {
  const rows = [];
  const add = (label, provider, models) => {
    if (!models.length) return;
    const suspended = providerSuspendedMs(provider);
    if (suspended) {
      rows.push(`${label}: ⏳ sem modelos de pé (retenta em ${Math.ceil(suspended / 1000)}s)`);
      return;
    }
    const head = models[0];
    const rest = models.length > 1 ? ` (+${models.length - 1} reserva${models.length > 2 ? 's' : ''})` : '';
    const blocked = models.length - activeModels(provider, models, models).length;
    rows.push(`${label}: ${head}${rest}${blocked ? ` · ${blocked} fora do ar` : ''}`);
  };
  if (pools.ai.size) add('custom', 'ai-custom', activeModels('ai-custom', [ENV.aiModel, ...ENV.aiModels].filter(Boolean), DEFAULT_AI_MODELS));
  if (pools.groq.size) add('groq', 'groq', activeModels('groq', ENV.groqModels, DEFAULT_GROQ_MODELS));
  if (pools.openai.size) add('openai', 'openai', activeModels('openai', ENV.openaiModels, DEFAULT_OPENAI_MODELS));
  if (pools.gemini.size) add('gemini', 'gemini', activeModels('gemini', ENV.geminiModels, DEFAULT_GEMINI_MODELS));
  return rows;
}

/** Contagem de chaves configuradas por provedor (para `.pools`). */
export function aiPoolSizes() {
  return {
    custom: pools.ai.size,
    groq: pools.groq.size,
    openai: pools.openai.size,
    gemini: pools.gemini.size,
    pollinations: pools.pollinations.size
  };
}

/**
 * Limpa os cooldowns das chaves e as marcas de modelo fora do ar.
 * Usado por `.pools reset` quando o operador quer retentar na hora.
 */
export function resetAiPools() {
  let cleared = 0;
  for (const pool of Object.values(pools)) cleared += pool.clearCooldowns();
  const models = blockedModels.size;
  blockedModels.clear();
  discoveredModels.clear();
  return { keys: cleared, models };
}

/**
 * Relê o .env e remonta os pools — para quem acabou de colar novas chaves e
 * não quer reiniciar o bot (útil no Termux).
 */
export function reloadAiPools() {
  const load = loadDotEnv(ENV_FILE, { override: true });
  buildPools();
  blockedModels.clear();
  discoveredModels.clear();
  tokenParamByBase.clear();
  return { loaded: load.loaded, entries: load.entries, sizes: aiPoolSizes() };
}

export { isModelError, isModelMissingForEveryone };
