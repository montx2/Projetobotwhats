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
// IMAGEM (`.criar`): o prompt é refinado pela IA (em inglês, com detalhes de
// cena/luz/lente) e depois passa pelo melhor gerador disponível —
// Gemini → OpenAI (gpt-image-1) → Pollinations (grátis, sem chave). Formatos,
// estilos, semente fixa e `--hd` (upscale com FFmpeg) são atalhos do comando.
//
// VOZ (`.voz`): 100% GRÁTIS — nenhum provedor pago, nenhuma chave obrigatória.
// Motor principal: Edge (grátis, sem chave, WebSocket nativo do Node 22) sobre
// o catálogo de vozes de `voices.js` — `.voz masculina grossa`, `.voz --tom -30`.
// Quem manda no timbre é você: voz + tom (grossa ⇄ fina) + velocidade.
// Se o Edge falhar (bloqueio de IP, 403, internet caída) a cascata segue com
// provedores grátis sem chave (StreamElements, Google, Pollinations) e, por
// último, os motores LOCAIS e OFFLINE (`tts-local.js`: piper/espeak-ng), que
// não dependem de internet e não custam nada — garantindo que o áudio sempre
// saia. Nada de ElevenLabs/OpenAI TTS: eram os únicos caminhos pagos.
// Imagem e voz seguem funcionando só com Pollinations quando não há chave
// nenhuma (limite menor, ~1 req/15s, e sujeito a 402 em pico de uso).

import { KeyPool, isModelError, isModelMissingForEveryone, formatCooldown } from '../core/keypool.js';
import { ENV, cfg } from '../core/config.js';
import { loadDotEnv, ENV_FILE } from '../core/env.js';
import { postJson, fetchJson, fetchBuffer, sleep } from '../core/http.js';
import { log } from '../core/logger.js';
import { normalizeJid, splitForTts } from '../util/text.js';
import { applyAudioFilter, upscaleImage } from '../util/ffmpeg.js';
import {
  buildPitchSpeedFilter,
  buildVoiceFxChain,
  describeSpec,
  parseCustomVoices,
  pct,
  resolveVoiceSpec
} from './voices.js';
import { edgeStatus, edgeTts, edgeVoices, isEdgeSupported } from './tts-edge.js';
import { espeakTts, isFeminineVoice, localStatus, piperTts } from './tts-local.js';
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


// ── Geração de imagem ──────────────────────────────────────
//
// TRÊS CAMADAS DE QUALIDADE (e nenhuma delas depende de chave paga):
//   1) PROMPT MELHOR: o pedido em português é reescrito pela IA em inglês, com
//      sujeito, cenário, luz, lente e nível de detalhe. Modelos de imagem são
//      treinados em inglês — é aqui que a diferença aparece mais.
//   2) MELHOR MOTOR: usa Gemini (se houver chave grátis do Google AI Studio) ou
//      OpenAI gpt-image-1 (se houver OPENAI_KEYS); sem chave nenhuma, usa o
//      Pollinations, que é grátis.
//   3) ACABAMENTO: `--hd` amplia com FFmpeg (lanczos + nitidez) para a imagem
//      não chegar borrada no celular.
//
// Formatos e estilos são atalhos: `.criar anime um gato --formato 9:16 --hd`.

const IMAGE_FORMATS = Object.freeze({
  '1:1': { width: 1024, height: 1024, label: 'quadrado 1:1' },
  '16:9': { width: 1536, height: 864, label: 'paisagem 16:9' },
  '9:16': { width: 864, height: 1536, label: 'vertical 9:16' },
  '4:3': { width: 1280, height: 960, label: 'paisagem 4:3' },
  '3:4': { width: 960, height: 1280, label: 'retrato 3:4' },
  '3:2': { width: 1536, height: 1024, label: 'foto 3:2' }
});

const IMAGE_FORMAT_ALIASES = Object.freeze({
  quadrado: '1:1',
  square: '1:1',
  paisagem: '16:9',
  horizontal: '16:9',
  wide: '16:9',
  cinema: '16:9',
  vertical: '9:16',
  retrato: '9:16',
  stories: '9:16',
  story: '9:16',
  celular: '9:16',
  foto: '3:2',
  tablet: '4:3'
});

const IMAGE_STYLES = Object.freeze({
  realista: 'photorealistic, 50mm photo, natural lighting, ultra detailed, sharp focus',
  foto: 'photorealistic, 50mm photo, natural lighting, ultra detailed, sharp focus',
  anime: 'anime style, cel shading, vibrant colors, detailed line art, studio quality',
  cartoon: 'cartoon illustration, bold clean outlines, flat vibrant colors',
  '3d': '3d render, soft studio lighting, subsurface scattering, high detail',
  pintura: 'oil painting, visible brush strokes, canvas texture, dramatic lighting',
  aquarela: 'watercolor painting, soft washes, visible paper texture',
  desenho: 'pencil sketch, hand drawn, hatching, monochrome',
  cyberpunk: 'cyberpunk, neon lights, volumetric fog, cinematic, night city',
  pixel: 'pixel art, 16-bit, crisp pixels, limited palette',
  logo: 'minimalist vector logo, flat design, centered, clean solid background',
  terror: 'dark horror atmosphere, moody lighting, film grain, unsettling',
  cartoon3d: 'cute 3d cartoon character, pixar-like, soft lighting, big expressive eyes',
  mangá: 'manga style, black and white ink, screentone shading',
  manga: 'manga style, black and white ink, screentone shading'
});

/** Reconhece `--flag valor` e `--flag=valor` e devolve o texto limpo. */
export function extractImageFlags(raw) {
  const flags = {};
  const text = String(raw || '').replace(
    // O valor só é consumido quando ele realmente existe: assim `--hd --seed 42`
    // não engole a flag seguinte e o espaço entre as duas é preservado.
    /(?:^|\s)-{1,2}(modelo|model|formato|proporcao|proporção|estilo|style|seed|semente|sem|no|bruto|rapido|rápido|hd)\b(?:=(?:"([^"]*)"|'([^']*)'|(\S+))|\s+(?:"([^"]*)"|'([^']*)'|((?!--)\S+)))?/gi,
    (match, key, dqEq, sqEq, eqValue, dqSpace, sqSpace, spaceValue) => {
      const k = String(key).toLowerCase();
      const value = String(eqValue ?? spaceValue ?? dqEq ?? dqSpace ?? sqEq ?? sqSpace ?? '')
        .replace(/^["']|["']$/g, '');
      if (['bruto', 'rapido', 'rápido'].includes(k)) flags.refine = false;
      else if (k === 'hd') flags.hd = true;
      else if (['modelo', 'model'].includes(k)) flags.model = value;
      else if (['formato', 'proporcao', 'proporção'].includes(k)) flags.format = value;
      else if (['estilo', 'style'].includes(k)) flags.style = value;
      else if (['seed', 'semente'].includes(k)) flags.seed = value;
      else if (['sem', 'no'].includes(k)) flags.negative = value;
      return ' ';
    }
  );
  return { flags, text: text.replace(/\s+/g, ' ').trim() };
}

/**
 * Interpreta o pedido inteiro do usuário: texto + atalhos.
 * @returns {{prompt: string, style: string|null, format: object, model: string|null, seed: number, refine: boolean, hd: boolean, negative: string}}
 */
export function parseImageRequest(raw, { defaultModel } = {}) {
  const { flags, text } = extractImageFlags(raw);
  let prompt = text;
  let style = null;
  let negative = flags.negative || '';

  // Estilo também pode ser pedido como primeira palavra: `.criar anime um gato`
  // — só quando a palavra é exatamente um estilo conhecido.
  const first = prompt.split(/\s+/)[0]?.toLowerCase();
  const styleKey = first ? Object.keys(IMAGE_STYLES).find((key) => key === first) : null;
  if (styleKey && prompt.length > styleKey.length) {
    style = styleKey;
    prompt = prompt.slice(first.length).trim();
  }

  if (flags.style) {
    const wanted = String(flags.style).toLowerCase();
    const found = Object.keys(IMAGE_STYLES).find((key) => key === wanted);
    style = found || style;
    if (!found) prompt = `${prompt}, ${flags.style}`.trim();
  }

  const formatKey = flags.format ? IMAGE_FORMAT_ALIASES[String(flags.format).toLowerCase()] || String(flags.format) : null;
  const format = formatKey && IMAGE_FORMATS[formatKey] ? { key: formatKey, ...IMAGE_FORMATS[formatKey] } : null;

  const seedValue = Number(flags.seed);
  const seed = Number.isFinite(seedValue) && seedValue > 0
    ? Math.floor(seedValue) % 1_000_000_000
    : Math.floor(Math.random() * 1_000_000_000);

  if (negative) negative = String(negative).slice(0, 200);
  if (!prompt) prompt = String(raw || '').trim();

  return {
    prompt: prompt.slice(0, 1_200),
    style,
    stylePrompt: style ? IMAGE_STYLES[style] : null,
    format,
    model: flags.model ? String(flags.model).slice(0, 80) : defaultModel || null,
    seed,
    refine: flags.refine !== false,
    hd: flags.hd === true,
    negative
  };
}

/** Junta o pedido do usuário + estilo + enquadramento num prompt só. */
export function composeImagePrompt({ prompt, stylePrompt, negative, format }) {
  const parts = [String(prompt || '').trim()];
  if (stylePrompt) parts.push(stylePrompt);
  if (format) parts.push(`${format.label}, composition fits the frame`);
  if (negative) parts.push(`avoid: ${negative}`);
  return parts.filter(Boolean).join(', ').slice(0, 1_500);
}

/** Promessa com tempo máximo — usada no refino do prompt. */
function withTimeout(promise, ms, message = 'tempo esgotado') {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    })
  ]);
}

/**
 * Reescreve o pedido em inglês com detalhes que os modelos de imagem gostam.
 * Falhou? Sem drama: usa o pedido original (a imagem sai do mesmo jeito).
 */
async function refineImagePrompt(prompt, { style, negative } = {}) {
  const ask = [
    'Você é um diretor de arte que escreve prompts para geradores de imagem (Flux, Gemini, DALL-E).',
    'Reescreva o pedido do usuário em INGLÊS, em UMA linha única e corrida, mantendo a intenção original.',
    'Descreva o sujeito, a ação, o cenário, a iluminação, o enquadramento e o nível de detalhe.',
    'Não use markdown, não explique, não faça perguntas e não invente texto escrito na imagem.',
    'Responda APENAS com o prompt final, com no máximo 60 palavras.',
    style ? `Estilo obrigatório: ${style}.` : null,
    negative ? `Evite aparecer: ${negative}.` : null,
    `Pedido: ${prompt}`
  ].filter(Boolean).join('\n');
  const result = await aiChatRaw(ask);
  const clean = String(result || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^[^:]{0,40}:\s*/, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean || clean.length < 8) throw new Error('prompt refinado vazio');
  return clean.slice(0, 900);
}

// ── Pollinations (grátis, sem chave) ───────────────────────
const POLLINATIONS_PREFERRED_MODELS = ['flux', 'turbo', 'kontext', 'sana'];
let pollinationsModelsCache = { at: 0, models: [] };

/** Lista os modelos de imagem que o serviço anuncia agora (cache de 30 min). */
async function pollinationsImageModels({ timeoutMs = 12_000 } = {}) {
  if (pollinationsModelsCache.at && Date.now() - pollinationsModelsCache.at < 30 * 60_000) {
    return pollinationsModelsCache.models;
  }
  try {
    const data = await fetchJson('https://image.pollinations.ai/models', { timeoutMs, maxBytes: 512 * 1024 });
    const models = (Array.isArray(data) ? data : [])
      .map((entry) => String(entry?.id || entry?.name || entry || '').trim())
      .filter(Boolean);
    pollinationsModelsCache = { at: Date.now(), models };
    return models;
  } catch {
    pollinationsModelsCache = { at: Date.now(), models: [] };
    return [];
  }
}

/** Ordem de tentativa: preferidos que existem hoje + o resto do que o serviço lista. */
async function pollinationsModelChain(requested) {
  const known = (await pollinationsImageModels()).map((model) => model.toLowerCase());
  const preferred = [requested, ...POLLINATIONS_PREFERRED_MODELS].filter(Boolean);
  const chain = [];
  for (const model of preferred) {
    if (!known.length || known.includes(String(model).toLowerCase())) chain.push(model);
  }
  for (const model of known) if (!chain.includes(model)) chain.push(model);
  return chain.length ? chain : [requested || 'flux'];
}

async function pollinationsImageOnce(prompt, { width, height, model, seed }, key) {
  const url =
    `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}` +
    `?width=${width}&height=${height}&seed=${seed}&model=${encodeURIComponent(model)}` +
    '&nologo=true&private=true&safe=true&referrer=nexusbot';
  const buffer = await fetchBuffer(url, {
    timeoutMs: 180_000,
    maxBytes: 40 * 1024 * 1024,
    headers: pollinationsAuthHeaders(key)
  });
  if (!isImageBuffer(buffer)) throw new Error('a resposta não é uma imagem');
  return buffer;
}

async function pollinationsImage(prompt, opts) {
  const chain = await pollinationsModelChain(opts.model);
  const errors = [];
  for (const model of chain) {
    try {
      // Sem chave configurada o Pollinations atende anônimo (limite bem menor);
      // com chave, o KeyPool gira as credenciais quando uma estoura o limite.
      const buffer = pools.pollinations.size
        ? await pools.pollinations.run((key) => pollinationsImageOnce(prompt, { ...opts, model }, key))
        : await pollinationsImageOnce(prompt, { ...opts, model }, '');
      return { buffer, model };
    } catch (error) {
      errors.push(`${model}: ${String(error?.message || error).slice(0, 60)}`);
      log.warn(`imagem · pollinations/${model} falhou: ${error?.message || error}`);
    }
  }
  throw new Error(`pollinations sem modelo de pé (${errors.join(' | ')})`);
}

// ── Gemini (chave grátis do Google AI Studio) ──────────────
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_GEMINI_IMAGE_MODELS = [
  'gemini-3-pro-image',
  'gemini-3-flash-image',
  'gemini-2.5-flash-image',
  'gemini-2.0-flash-preview-image-generation'
];
let geminiImageModelsCache = { at: 0, models: [] };

/** Descobre na própria API quais modelos geram imagem hoje. */
async function discoverGeminiImageModels(key, { timeoutMs = 12_000 } = {}) {
  if (geminiImageModelsCache.at && Date.now() - geminiImageModelsCache.at < 30 * 60_000) {
    return geminiImageModelsCache.models;
  }
  try {
    const data = await fetchJson(`${GEMINI_API_BASE}/models?key=${encodeURIComponent(key)}`, {
      timeoutMs,
      maxBytes: 2 * 1024 * 1024
    });
    const models = (Array.isArray(data?.models) ? data.models : [])
      .map((entry) => String(entry?.name || '').replace(/^models\//, ''))
      .filter((id) => /image/i.test(id));
    const ranked = models.sort((a, b) => Number(/pro/i.test(b)) - Number(/pro/i.test(a)));
    geminiImageModelsCache = { at: Date.now(), models: ranked };
    return ranked;
  } catch (error) {
    log.warn(`imagem · não consegui listar os modelos de imagem do Gemini: ${error?.message || error}`);
    geminiImageModelsCache = { at: Date.now(), models: [] };
    return [];
  }
}

function ratioForSize(width, height) {
  const r = Number(width) / Number(height);
  if (r > 1.6) return '16:9';
  if (r > 1.2) return '3:2';
  if (r > 0.95) return '1:1';
  if (r > 0.7) return '3:4';
  return '9:16';
}

async function geminiImageOnce(prompt, { width, height, model }, key, { allowPrivate = false } = {}) {
  const models = [model, ...DEFAULT_GEMINI_IMAGE_MODELS, ...ENV.geminiImageModels].filter(Boolean);
  const discovered = await discoverGeminiImageModels(key);
  const chain = [...new Set([...models, ...discovered])].filter((id) => !isModelBlocked('gemini-image', id));
  const errors = [];
  for (const id of chain) {
    try {
      if (/imagen/i.test(id)) {
        const data = await postJson(
          `${GEMINI_API_BASE}/models/${encodeURIComponent(id)}:predict?key=${encodeURIComponent(key)}`,
          { instances: [{ prompt }], parameters: { sampleCount: 1, aspectRatio: ratioForSize(width, height) } },
          { timeoutMs: 180_000, maxResponseBytes: 40 * 1024 * 1024, allowPrivate }
        );
        const base64 = data?.predictions?.[0]?.bytesBase64Encoded || data?.predictions?.[0]?.image?.imageBytes;
        if (!base64) throw new Error('resposta sem imagem');
        return { buffer: Buffer.from(base64, 'base64'), model: id };
      }
      const data = await postJson(
        `${GEMINI_API_BASE}/models/${encodeURIComponent(id)}:generateContent?key=${encodeURIComponent(key)}`,
        {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
        },
        { timeoutMs: 180_000, maxResponseBytes: 40 * 1024 * 1024, allowPrivate }
      );
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const inline = parts.find((part) => part?.inlineData?.data || part?.inline_data?.data);
      const base64 = inline?.inlineData?.data || inline?.inline_data?.data;
      if (!base64) throw new Error(`resposta sem imagem (${parts.map((p) => Object.keys(p).join('+')).join(',') || 'vazia'})`);
      const buffer = Buffer.from(base64, 'base64');
      if (!isImageBuffer(buffer)) throw new Error('imagem inválida');
      return { buffer, model: id };
    } catch (error) {
      const status = Number(error?.status);
      // Modelo inexistente/descontinuado: marca e tenta o próximo (mesma chave).
      if (status === 404 || isModelMissingForEveryone(error)) {
        blockModel('gemini-image', id, 30 * 60_000);
      }
      errors.push(`${id}: ${String(error?.message || error).slice(0, 70)}`);
      log.warn(`imagem · gemini/${id} falhou: ${error?.message || error}`);
      if ([401, 403, 429, 402].includes(status)) throw error; // problema de chave/cota: deixa o pool girar
    }
  }
  throw new Error(`gemini sem modelo de imagem (${errors.slice(0, 2).join(' | ')})`);
}

// ── OpenAI (gpt-image-1, quando houver OPENAI_KEYS) ─────────
async function openaiImageOnce(prompt, { width, height, model }, key) {
  const ratio = Number(width) / Number(height);
  const size = ratio > 1.2 ? '1536x1024' : ratio < 0.83 ? '1024x1536' : '1024x1024';
  const data = await postJson(
    `${OPENAI_BASE}/images/generations`,
    { model: model || 'gpt-image-1', prompt, size, n: 1 },
    { headers: { authorization: `Bearer ${key}` }, timeoutMs: 240_000, maxResponseBytes: 60 * 1024 * 1024 }
  );
  const base64 = data?.data?.[0]?.b64_json;
  if (!base64) throw new Error('resposta sem imagem');
  const buffer = Buffer.from(base64, 'base64');
  if (!isImageBuffer(buffer)) throw new Error('imagem inválida');
  return { buffer, model: model || 'gpt-image-1' };
}

/** Ordem dos geradores: Gemini → OpenAI → Pollinations (grátis, sem chave). */
function imageProviders(prompt, opts) {
  const list = [];
  if (pools.gemini.size) {
    list.push([
      'gemini',
      () => pools.gemini.run((key) => geminiImageOnce(prompt, opts, key, { allowPrivate: true }))
    ]);
  }
  if (pools.openai.size) {
    list.push(['openai', () => pools.openai.run((key) => openaiImageOnce(prompt, opts, key))]);
  }
  list.push(['pollinations', () => pollinationsImage(prompt, opts)]);
  return list;
}

function isImageBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 512) return false;
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return true; // JPEG
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return true; // PNG
  const head = buffer.subarray(0, 4).toString('latin1');
  return head === 'RIFF' || head === 'GIF8' || buffer.subarray(4, 8).toString('latin1') === 'ftyp';
}

/**
 * Gera a imagem com o melhor motor disponível e devolve os detalhes do que
 * foi usado (para a legenda do WhatsApp e para o log).
 *
 * @param {string} rawPrompt pedido do usuário (pode conter os atalhos)
 * @param {{width?: number, height?: number, model?: string, seed?: number, refine?: boolean, hd?: boolean}} options
 * @returns {Promise<{buffer: Buffer, engine: string, model: string, prompt: string, refined: boolean, hd: boolean, format: string|null}>}
 */
export async function aiImageFull(rawPrompt, options = {}) {
  const request = {
    ...parseImageRequest(rawPrompt, { defaultModel: options.model || cfg.get().ia.modeloImagem }),
    ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined))
  };
  const basePrompt = String(request.prompt || '').trim();
  if (!basePrompt) throw new Error('descreva a imagem que deseja criar');
  if (basePrompt.length > 1_200) throw new Error('descrição longa demais (máximo 1.200 caracteres)');

  // Dimensões: `--formato` manda; senão valem width/height (ou 1024x1024).
  const clampSide = (value) => Math.min(1536, Math.max(256, Number(value) || 1024));
  const format = request.format
    ? { ...request.format }
    : { key: 'custom', label: `${clampSide(request.width)}x${clampSide(request.height)}`, width: clampSide(request.width), height: clampSide(request.height) };

  let text = basePrompt;
  let refined = false;
  if (request.refine) {
    try {
      text = await withTimeout(
        refineImagePrompt(basePrompt, { style: request.style, negative: request.negative }),
        25_000,
        'refino demorou demais'
      );
      refined = true;
    } catch (error) {
      log.warn(`imagem · refino do prompt indisponível (${error?.message}) — usando o texto original`);
    }
  }

  const prompt = composeImagePrompt({
    prompt: text,
    stylePrompt: request.stylePrompt,
    negative: request.negative,
    format
  });
  const opts = { width: format.width, height: format.height, model: request.model, seed: request.seed };
  log.ai(`gerando imagem ${format.key} · ${refined ? 'prompt refinado' : 'prompt original'} (prompt não é gravado nos logs)`);

  const errors = [];
  for (const [name, run] of imageProviders(prompt, opts)) {
    try {
      const { buffer, model } = await run();
      let final = buffer;
      let hd = false;
      if (request.hd) {
        const bigger = await upscaleImage(buffer, { factor: 2 });
        if (bigger) {
          final = bigger;
          hd = true;
        }
      }
      log.ok(`imagem pronta via ${name}/${model}${hd ? ' (hd)' : ''}`);
      return { buffer: final, engine: name, model, prompt, refined, hd, format: format?.key || null, style: request.style };
    } catch (error) {
      errors.push(`${name}: ${String(error?.message || error).slice(0, 110)}`);
      log.warn(`imagem · ${name} falhou: ${error?.message || error}`);
    }
  }
  throw new Error(`não consegui gerar a imagem agora · ${errors.join(' | ')}`);
}

export async function aiImage(prompt, options = {}) {
  const result = await aiImageFull(prompt, options);
  return result.buffer;
}

export function aiImageStatus() {
  const rows = [];
  if (pools.gemini.size) rows.push(`gemini: ${pools.gemini.available}/${pools.gemini.size} chave(s) — melhor qualidade`);
  if (pools.openai.size) rows.push(`openai: ${pools.openai.available}/${pools.openai.size} chave(s) — gpt-image-1`);
  rows.push(
    pools.pollinations.size
      ? `pollinations: ${pools.pollinations.available}/${pools.pollinations.size} chave(s)`
      : 'pollinations: grátis sem chave'
  );
  return rows;
}

// ── Voz (TTS 100% grátis) ───────────────────────────────────
//
// Motor principal: Edge (o mesmo "Ler em voz alta" do Microsoft Edge) — vozes
// neurais boas, GRÁTIS e sem chave. É nele que o tom (grossa ⇄ fina), a
// velocidade e o volume são aplicados de verdade, pelo SSML:
// `<prosody pitch='-25%' rate='-10%'>`. Sem FFmpeg e sem efeito "de desenho".
//
// NENHUM provedor pago participa: sem ElevenLabs, sem OpenAI TTS, sem chave
// obrigatória em lugar nenhum.
//
// CADEIA DE RESERVA (o primeiro que entregar áudio válido ganha):
//   1) motor da voz      (Edge por padrão; espeak/piper se a voz pedir)
//   2) StreamElements    (grátis, vozes Polly pt-BR: Camila/Vitoria/Ricardo)
//   3) Google Translate  (grátis, sem chave)
//   4) espeak / piper    (LOCAL e OFFLINE — grátis, sem internet, sem chave)
//   5) Pollinations      (grátis, último recurso)
//
// Com `VOZ_LOCAL=1` no .env os motores offline vêm antes das reservas online.
// Cada motor que falha entra em cooldown: a próxima tentativa não repete a
// espera à toa.

const POLLY_VOICES = {
  feminina: 'Camila',
  camila: 'Camila',
  vitoria: 'Vitoria',
  'vitória': 'Vitoria',
  masculina: 'Ricardo',
  ricardo: 'Ricardo'
};
const GOOGLE_TTS_CHUNK = 190;
// O Pollinations (modelo openai-audio) só entende vozes no estilo OpenAI:
// traduzimos o gênero pedido para a voz mais próxima.
const POLLINATIONS_VOICES = Object.freeze({ feminina: 'nova', masculina: 'onyx' });

/** Vozes extras cadastradas no .env (VOZES_EXTRA). */
export function voiceExtraList() {
  return parseCustomVoices(ENV.vozesExtra);
}

/** Voz efetiva de um chat: escolha do chat → padrão do bot → automática. */
export function voiceForChat(jid) {
  const config = cfg.get();
  if (jid) {
    const chosen = config.ia?.vozChats?.[normalizeJid(jid)];
    if (chosen) return chosen;
  }
  return config.ia?.vozPadrao || 'auto';
}

function isMp3(buf) {
  return Buffer.isBuffer(buf) && buf.length > 2048 &&
    (buf.subarray(0, 3).toString('latin1') === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0));
}

function isAudioBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 2048) return false;
  const head = buf.subarray(0, 4).toString('latin1');
  // mp3, ogg/opus, wav, m4a/mp4
  return isMp3(buf) || head === 'OggS' || head === 'RIFF' || buf.subarray(4, 8).toString('latin1') === 'ftyp';
}

/**
 * Nome de voz do StreamElements/Polly.
 * `feminina`/`masculina` (gênero genérico) viram Camila/Ricardo; um nome
 * próprio (`VOZES_EXTRA=algo=polly:Vitoria`) é respeitado.
 */
function pollyVoiceName(voice) {
  const raw = String(voice || '').trim();
  const mapped = POLLY_VOICES[raw.toLowerCase()];
  if (mapped) return mapped;
  if (/^[a-z]{2,25}$/i.test(raw)) return raw[0].toUpperCase() + raw.slice(1).toLowerCase();
  return 'Camila';
}

async function streamElementsTts(text, voice) {
  const v = pollyVoiceName(voice);
  // A API aceita textos longos, mas fatiar reduz erro 400 e timeouts.
  const chunks = splitForTts(text, 480);
  const buffers = [];
  for (const chunk of chunks) {
    const url = `https://api.streamelements.com/kappa/v2/speech?voice=${encodeURIComponent(v)}&text=${encodeURIComponent(chunk)}`;
    const buf = await fetchBuffer(url, { timeoutMs: 45_000, maxBytes: 20 * 1024 * 1024 });
    if (!isAudioBuffer(buf)) throw new Error('áudio inválido');
    buffers.push(buf);
  }
  if (!buffers.length) throw new Error('áudio vazio');
  return Buffer.concat(buffers);
}

async function googleTts(text, lang = 'pt-BR') {
  const chunks = splitForTts(text, GOOGLE_TTS_CHUNK);
  if (!chunks.length) throw new Error('áudio vazio');
  const buffers = [];
  for (let i = 0; i < chunks.length; i++) {
    const url =
      'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob' +
      `&tl=${encodeURIComponent(lang)}&total=${chunks.length}&idx=${i}` +
      `&textlen=${chunks[i].length}&q=${encodeURIComponent(chunks[i])}`;
    const buf = await fetchBuffer(url, {
      timeoutMs: 45_000,
      maxBytes: 10 * 1024 * 1024,
      headers: { referer: 'https://translate.google.com/', accept: 'audio/mpeg,*/*' }
    });
    if (!isMp3(buf)) throw new Error('áudio inválido');
    buffers.push(buf);
    if (i < chunks.length - 1) await sleep(150); // evita bloqueio por rajada
  }
  return Buffer.concat(buffers);
}

async function pollinationsTtsOnce(text, voice, key) {
  const url = `https://text.pollinations.ai/${encodeURIComponent(text)}?model=openai-audio&voice=${encodeURIComponent(voice)}&referrer=nexusbot`;
  const buffer = await fetchBuffer(url, { timeoutMs: 60_000, maxBytes: 25 * 1024 * 1024, headers: pollinationsAuthHeaders(key) });
  if (!isAudioBuffer(buffer)) throw new Error('áudio inválido (provedor devolveu texto/erro)');
  return buffer;
}

/** Voz genérica do provedor quando a voz pedida é de outro motor. */
function fallbackVoiceFor(spec) {
  const female = /femin|fem|mulher|f$/i.test(`${spec.id} ${spec.label || ''}`) || /Francisca|Thalita|Camila|Vitoria|Emma|Ava|Ana|Nova/i.test(spec.voice || '');
  return female ? 'feminina' : 'masculina';
}

// ── Cooldown por motor ──────────────────────────────────────────────
// Um motor que acabou de falhar (serviço fora do ar, IP bloqueado, sem
// internet) não é tentado de novo a cada `.voz`: sem isso, cada comando
// repetia a mesma espera longa antes de chegar no motor que funciona.
const VOICE_PROVIDER_COOLDOWN_MS = 10 * 60_000;
const voiceCooldowns = new Map(); // nome do motor → instante em que volta a valer

// Teto de tempo para os motores online antes de partir para os offline. Sem
// isso, uma rede ruim podia prender o `.voz` por minutos a fio.
const VOICE_TOTAL_BUDGET_MS = 75_000;

/** Nome amigável do motor, usado na legenda do áudio. */
const VOICE_ENGINE_LABELS = Object.freeze({
  edge: 'edge (online, grátis)',
  streamelements: 'streamelements (grátis)',
  google: 'google tradutor (grátis)',
  pollinations: 'pollinations (grátis)',
  espeak: 'espeak local (offline, grátis)',
  piper: 'piper local (offline, grátis)'
});

function providerCooling(name) {
  const until = voiceCooldowns.get(name);
  if (!until) return false;
  if (until <= Date.now()) {
    voiceCooldowns.delete(name);
    return false;
  }
  return true;
}

function markProviderFailure(name) {
  voiceCooldowns.set(name, Date.now() + VOICE_PROVIDER_COOLDOWN_MS);
}

function markProviderSuccess(name) {
  voiceCooldowns.delete(name);
}

/** Libera os cooldowns dos motores de voz (usado por `.pools reset`). */
export function resetVoiceCooldowns() {
  const cleared = voiceCooldowns.size;
  voiceCooldowns.clear();
  return cleared;
}

/** Motores locais/offline disponíveis nesta máquina, na ordem de preferência. */
function localProviders(text, spec) {
  const list = [];
  const status = localStatus();
  if (status.piper.installed) list.push(['piper', () => piperTts(text, spec)]);
  // ESPEAK_VOICE (opcional) usa a mesma voz crua do espeak para todo o catálogo.
  if (status.espeak.installed) list.push(['espeak', () => espeakTts(text, spec, { override: ENV.espeakVoice })]);
  return list;
}

/**
 * Aplica os efeitos do catálogo no áudio já sintetizado.
 * No Edge o tom/velocidade já vão no SSML e no espeak eles são nativos: nesses
 * dois só os efeitos (`fx`) passam pelo FFmpeg. Nos demais motores (piper e
 * reservas online) o FFmpeg também corrige tom e velocidade — mudando a taxa
 * de amostragem e recompensando a duração com `atempo`.
 */
const NATIVE_PITCH_ENGINES = new Set(['edge', 'espeak']);

async function applyVoiceEffects(buffer, spec, engineName) {
  const fxChain = buildVoiceFxChain(spec.fx);
  if (NATIVE_PITCH_ENGINES.has(engineName)) {
    if (!fxChain) return { buffer, effects: false };
    const filtered = await applyAudioFilter(buffer, { filter: fxChain });
    return { buffer: filtered || buffer, effects: Boolean(filtered) };
  }
  // No piper a velocidade já saiu nativa (`length_scale`): só o tom e os
  // efeitos ficam para o FFmpeg.
  const filter = buildPitchSpeedFilter({
    pitchPct: spec.pitchPct,
    speedPct: engineName === 'piper' ? 0 : spec.speedPct,
    fx: spec.fx
  });
  if (!filter) return { buffer, effects: false };
  const filtered = await applyAudioFilter(buffer, { filter });
  return { buffer: filtered || buffer, effects: Boolean(filtered) };
}

/**
 * Voz do Edge para uma especificação do catálogo.
 *
 * A voz principal pode sumir da lista do serviço de um dia para o outro (a
 * Microsoft renomeia/aposenta vozes): por isso cada voz do catálogo tem
 * `alts`. Aqui a escolha é — na ordem — a voz pedida, a primeira reserva que o
 * serviço ainda anuncia, e por fim qualquer voz do mesmo idioma e gênero.
 * Sem lista (offline) vai a voz pedida mesmo: se ela não existir mais, o
 * próprio serviço reclama e a cascata de reserva resolve.
 *
 * ⚠️ Sem esta função o `.voz` NUNCA usava o Edge: a chamada quebrava com
 * ReferenceError e o áudio saía sempre de uma reserva (Polly/Google), que é
 * bem mais simples — e era isso que fazia o tom configurado soar estranho.
 */
export async function edgeVoiceFor(spec) {
  const wanted = String(spec.voice || '').trim();
  const alts = Array.isArray(spec.alts) ? spec.alts : [];
  let voices = [];
  try {
    voices = await edgeVoices({ timeoutMs: 8_000 });
  } catch {
    return wanted;
  }
  if (!Array.isArray(voices) || !voices.length) return wanted;
  const names = new Set(voices.map((entry) => entry.shortName));
  if (!wanted || names.has(wanted)) return wanted;
  for (const alt of alts) if (names.has(alt)) return alt;
  // Última cartada: mesma língua e mesmo gênero da voz pedida.
  const [lang, region] = String(wanted).split('-');
  const gender = /-(Ana|Brenda|Camila|Dalia|Elza|Emma|Ava|Francisca|Giovanna|Jenny|Leila|Leticia|Manuela|Thalita|Yara|Vitoria|Nova)/i.test(wanted)
    ? 'Female'
    : 'Male';
  const sameLocale = voices.find(
    (entry) => entry.locale === `${lang}-${region}` && entry.gender === gender
  );
  return sameLocale?.shortName || wanted;
}

/**
 * Lista de motores na ordem de preferência, já sabendo qual voz usar.
 * Nada aqui é pago: Edge, reservas grátis sem chave e motores locais/offline.
 */
function voiceProviders(text, spec) {
  const list = [];
  const lang = spec.lang || cfg.get().ia?.idiomaVoz || 'pt-BR';
  const edgeProvider = () => [
    'edge',
    async () =>
      edgeTts(text, {
        voice: await edgeVoiceFor(spec),
        pitch: pct(spec.pitchPct),
        rate: pct(spec.speedPct),
        volume: pct(spec.volumePct),
        lang,
        split: splitForTts,
        timeoutMs: 45_000
      })
  ];

  // 1) O motor que a própria voz pede (Edge no catálogo; espeak/piper quando a
  //    voz foi criada no .env como `espeak:…` / `piper:…`).
  if (spec.engine === 'edge') {
    if (isEdgeSupported() && !providerCooling('edge')) list.push(edgeProvider());
  } else if (spec.engine === 'polly') {
    // `VOZES_EXTRA=algo=polly:Camila` — voz da reserva grátis, mas como principal.
    if (!providerCooling('streamelements')) list.push(['streamelements', () => streamElementsTts(text, spec.voice)]);
  } else {
    list.push(...localProviders(text, spec).filter(([name]) => name === spec.engine && !providerCooling(name)));
  }

  // 2) Reservas grátis. Com VOZ_LOCAL=1 o motor offline vem primeiro (útil em
  //    rede instável: sai na hora e não depende de internet).
  const pollyVoice = spec.engine === 'polly' ? spec.voice : fallbackVoiceFor(spec);
  const online = [];
  if (!providerCooling('streamelements') && !list.some(([name]) => name === 'streamelements')) {
    online.push(['streamelements', () => streamElementsTts(text, pollyVoice)]);
  }
  if (!providerCooling('google')) online.push(['google', () => googleTts(text, lang)]);
  if (!providerCooling('pollinations')) {
    const pollinationsVoice = POLLINATIONS_VOICES[fallbackVoiceFor(spec)] || 'nova';
    online.push([
      'pollinations',
      () =>
        pools.pollinations.size
          ? pools.pollinations.run((key) => pollinationsTtsOnce(text, pollinationsVoice, key))
          : pollinationsTtsOnce(text, pollinationsVoice, '')
    ]);
  }

  const offline = localProviders(text, spec).filter(
    ([name]) => !providerCooling(name) && !list.some(([added]) => added === name)
  );

  if (ENV.vozLocal) list.push(...offline, ...online);
  else list.push(...online, ...offline);

  // 3) Edge como última cartada quando a voz veio de outro motor (ex.: a voz
  //    era do espeak e ninguém esperava que o espeak falhasse).
  if (spec.engine !== 'edge' && isEdgeSupported() && !providerCooling('edge') && !list.some(([name]) => name === 'edge')) {
    list.push(edgeProvider());
  }
  return list;
}

/**
 * Gera a voz e devolve também COMO ela foi feita (motor, voz, tom) — é o que o
 * `.voz` mostra na legenda.
 *
 * @param {string} text texto falado
 * @param {string} [recipe] configuração: nome da voz e/ou ajustes
 *   (`"masculina grossa"`, `"--tom -30 --vel -10"`). Vazio = a voz do chat.
 * @param {{jid?: string}} [options]
 */
export async function aiVoiceFull(text, recipe, { jid } = {}) {
  text = String(text || '').trim();
  if (!text) throw new Error('escreva o texto para transformar em áudio');
  if (text.length > 1_500) throw new Error('texto longo demais para áudio (máximo 1.500 caracteres)');

  const extra = voiceExtraList();
  const requested = String(recipe || '').trim() || voiceForChat(jid);
  const spec = resolveVoiceSpec(requested, { extra });
  const errors = [];
  let lastError = null;
  const startedAt = Date.now();

  for (const [name, run] of voiceProviders(text, spec)) {
    const local = name === 'espeak' || name === 'piper';
    // Os motores online têm um teto de tempo: passou disso, não vale a pena
    // fazer o usuário esperar — o motor local (quando existe) responde na hora.
    if (!local && Date.now() - startedAt > VOICE_TOTAL_BUDGET_MS) {
      errors.push(`${name}: fora do tempo`);
      continue;
    }
    try {
      const raw = await run();
      const { buffer, effects } = await applyVoiceEffects(raw, spec, name);
      markProviderSuccess(name);
      log.ai(`voz gerada via ${name} (${describeSpec(spec)})${effects ? ' + efeitos' : ''}`);
      return {
        buffer,
        engine: name,
        engineLabel: VOICE_ENGINE_LABELS[name] || name,
        offline: local,
        voiceId: spec.id,
        voiceLabel: spec.label || spec.id,
        settings: spec,
        settingsLabel: describeSpec(spec),
        effects,
        fallback: name !== spec.engine
      };
    } catch (error) {
      lastError = error;
      errors.push(`${name}: ${String(error?.message || error).slice(0, 90)}`);
      if (!local) markProviderFailure(name);
      log.warn(`voz · ${name} falhou: ${error?.message || error}`);
    }
  }
  const hint = localStatus().any
    ? ''
    : ' · para voz offline e grátis: pkg install espeak (Termux) / apt install espeak-ng (Linux)';
  throw new Error(`nenhum motor de voz respondeu · ${errors.join(' | ')}${hint}`, { cause: lastError });
}

export async function aiVoice(text, recipe) {
  const result = await aiVoiceFull(text, recipe);
  return result.buffer;
}

/** Situação das vozes para `.pools` / `.info`. Tudo grátis: nenhum item pago. */
export function aiVoiceStatus() {
  const rows = [];
  const edge = edgeStatus();
  rows.push(edge.ok ? `edge (principal, online): ${edge.detail}` : `edge (principal, online): indisponível — ${edge.detail}`);

  const local = localStatus();
  rows.push(
    local.espeak.installed
      ? `espeak (offline, grátis): pronto — ${local.espeak.bin}`
      : 'espeak (offline, grátis): não instalado — Termux: pkg install espeak · Linux: apt install espeak-ng'
  );
  rows.push(
    local.piper.installed
      ? `piper (offline, grátis): ${local.piper.model}`
      : 'piper (offline, grátis): opcional — PIPER_MODEL=/caminho/voz.onnx'
  );
  rows.push('streamelements · google · pollinations: reservas grátis, sem chave');
  rows.push('configuração: .voz <voz> <tom> <texto> · .vozpadrao salva no chat · .vozes ajuda');
  if (ENV.vozLocal) rows.push('VOZ_LOCAL=1 — o motor offline é tentado primeiro');
  return rows;
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
  const voice = resetVoiceCooldowns();
  return { keys: cleared, models, voice };
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
  pollinationsModelsCache = { at: 0, models: [] };
  geminiImageModelsCache = { at: 0, models: [] };
  return { loaded: load.loaded, entries: load.entries, sizes: aiPoolSizes() };
}

export { isModelError, isModelMissingForEveryone };
