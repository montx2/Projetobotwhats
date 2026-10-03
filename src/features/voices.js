// 🎙️ VOZ — escolha a voz, o tom (grossa ⇄ fina) e a velocidade.
//
// Sem personagem e sem imitação: são vozes brasileiras naturais mais DOIS
// controles que qualquer pessoa entende de primeira — TOM e VELOCIDADE.
// Quem usa é que decide como a voz sai:
//
//   .voz bom dia, pessoal           → fala com a voz configurada neste chat
//   .voz grossa boa noite           → tom grave só nesta mensagem
//   .voz feminina fina bom dia      → voz + tom na mesma frase
//   .voz --tom -30 --vel -10 oi     → ajuste fino, número por número
//   .vozpadrao masculina grossa     → salva a configuração neste chat
//
// ONDE O TOM É APLICADO (o áudio nunca "quebra" por falta de efeito):
//   edge    → SSML `<prosody pitch=…>` — nativo do serviço, sem FFmpeg
//   espeak  → parâmetro `-p` do próprio binário
//   piper e reservas online → FFmpeg: muda a taxa de amostragem e compensa a
//             duração com `atempo`, então só o timbre muda (não acelera).
//
// MOTORES — todos grátis, nenhum pede chave:
//   edge (online) · espeak/piper (offline) · streamelements · google · pollinations

// ── Efeitos de áudio (FFmpeg, quando instalado) ─────────────────────
// Opcionais: entram por `--fx eco` ou por `VOZES_EXTRA` no .env. Se o FFmpeg
// não estiver instalado a voz sai igual, só sem o efeito — nunca falha.
export const VOICE_FX = Object.freeze({
  vibrato: 'vibrato=f=6.5:d=0.45',
  vibratoLeve: 'vibrato=f=5:d=0.25',
  ecoCurto: 'aecho=0.8:0.88:45:0.28',
  ecoLongo: 'aecho=0.8:0.9:160:0.45',
  ecoFantasma: 'aecho=0.7:0.85:260:0.55',
  grave: 'bass=g=6',
  meioGrave: 'bass=g=3',
  nasal: 'treble=g=5,bass=g=-5',
  brilho: 'treble=g=3',
  robotico: 'aecho=0.8:0.7:28:0.35,acrusher=bits=10:mode=log:aa=1',
  radio: 'highpass=f=300,lowpass=f=3200,volume=1.15',
  teatro: 'aecho=0.8:0.88:90:0.35,bass=g=2',
  sussurro: 'treble=g=4,volume=0.85',
  distorcao: 'acrusher=bits=6:mode=lin:aa=1,volume=0.9'
});

const FX_BY_KEY = Object.freeze(
  Object.fromEntries(Object.entries(VOICE_FX).map(([key, value]) => [key.toLowerCase(), value]))
);

/** Junta os efeitos pedidos numa cadeia de filtros (`-af`). */
export function buildVoiceFxChain(fx) {
  const list = (Array.isArray(fx) ? fx : [fx])
    .map((item) => FX_BY_KEY[String(item || '').toLowerCase()] || (typeof item === 'string' && item.includes('=') ? item : null))
    .filter(Boolean);
  return list.join(',');
}

/**
 * Efeitos pedidos no comando (`--fx ecoCurto+radio`): nomes conferidos, com
 * erro claro quando o efeito não existe (efeito desconhecido seria ignorado em
 * silêncio e o usuário acharia que aplicou).
 */
export function resolveFxList(value) {
  const wanted = String(value || '')
    .split(/[+\s,]+/)
    .filter(Boolean);
  if (!wanted.length) throw new Error('escreva o nome do efeito depois de --fx (ex.: --fx ecoCurto)');
  const known = [];
  for (const item of wanted) {
    const key = String(item).toLowerCase();
    const canonical = Object.keys(VOICE_FX).find((name) => name.toLowerCase() === key);
    if (!canonical) {
      throw new Error(`efeito "${item}" não existe — disponíveis: ${Object.keys(VOICE_FX).join(', ')}`);
    }
    known.push(canonical);
  }
  return known;
}

/**
 * Cadeia "corrige tom e velocidade" para motores que NÃO aceitam SSML
 * (piper, StreamElements/Polly…). O FFmpeg muda o tom alterando a taxa de
 * amostragem e depois compensa a velocidade com `atempo`, então o resultado
 * mantém a duração original e só o timbre muda.
 * @param {{pitchPct?: number, speedPct?: number, fx?: string[]}} opts
 */
export function buildPitchSpeedFilter({ pitchPct = 0, speedPct = 0, fx = [] } = {}) {
  const parts = [];
  const pitchFactor = Math.min(2, Math.max(0.5, 1 + Number(pitchPct) / 100));
  const speedFactor = Math.min(2, Math.max(0.5, 1 + Number(speedPct) / 100));
  if (Math.abs(pitchFactor - 1) > 0.001) {
    parts.push('aresample=48000', `asetrate=${Math.round(48000 * pitchFactor)}`, 'aresample=48000');
  }
  const tempo = speedFactor / pitchFactor;
  if (Math.abs(tempo - 1) > 0.001) parts.push(`atempo=${tempo.toFixed(3)}`);
  const extra = buildVoiceFxChain(fx);
  if (extra) parts.push(extra);
  return parts.join(',');
}

/** Converte números em percentuais no formato do SSML (`+35%`, `-12%`). */
export function pct(value) {
  const n = Number(value) || 0;
  return `${n >= 0 ? '+' : ''}${Math.round(n)}%`;
}

/** " +35% " → 35 (aceita também `+35`, `35`, `-12%`). */
export function parsePct(value) {
  if (typeof value === 'number') return value;
  const match = /^\s*([+-]?\d+(?:[.,]\d+)?)\s*%?\s*$/.exec(String(value ?? ''));
  if (!match) return 0;
  return Number(match[1].replace(',', '.')) || 0;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// ── Tom: de muito grossa a muito fina ───────────────────────────────
// Percentual de pitch. Negativo = mais grossa, positivo = mais fina.
export const TONE_MIN = -60;
export const TONE_MAX = 60;
export const SPEED_MIN = -60;
export const SPEED_MAX = 60;

export const VOICE_TONES = Object.freeze([
  { id: 'muitogrossa', label: 'Muito grossa', pitch: -45, aliases: ['grossissima', 'grossao', 'grave', 'profunda', 'cavernosa'] },
  { id: 'grossa', label: 'Grossa', pitch: -25, aliases: ['meiogrossa', 'grossinha', 'baixa'] },
  { id: 'normal', label: 'Normal', pitch: 0, aliases: ['medio', 'media', 'neutro', 'natural', 'original'] },
  { id: 'fina', label: 'Fina', pitch: 25, aliases: ['meiofina', 'fininha', 'alta', 'aguda'] },
  { id: 'muitofina', label: 'Muito fina', pitch: 45, aliases: ['finissima', 'agudissima', 'muitoaguda', 'esquilo'] }
]);

// ── Vozes ───────────────────────────────────────────────────────────
// `voice` é o nome no motor (voz principal) e `alts` são as reservas usadas
// quando a principal não existe mais na lista do serviço.
const MASCULINAS = ['pt-BR-DonatoNeural', 'pt-BR-FabioNeural', 'pt-BR-HumbertoNeural'];
const FEMININAS = ['pt-BR-BrendaNeural', 'pt-BR-LeilaNeural', 'pt-BR-GiovannaNeural'];

export const VOICE_CATALOG = Object.freeze([
  { id: 'auto', label: 'Automática', voice: 'pt-BR-FranciscaNeural', alts: [...FEMININAS, 'pt-BR-AntonioNeural'],
    desc: 'o bot escolhe a melhor voz disponível', aliases: ['padrao', 'padrão', 'automatica', 'automática', 'automatico', 'automático'] },
  { id: 'masculina', label: 'Masculina', voice: 'pt-BR-AntonioNeural', alts: MASCULINAS,
    desc: 'voz de homem, natural', aliases: ['homem', 'masc', 'antonio', 'antônio'] },
  { id: 'feminina', label: 'Feminina', voice: 'pt-BR-FranciscaNeural', alts: FEMININAS,
    desc: 'voz de mulher, clara e calma', aliases: ['mulher', 'fem', 'francisca'] },
  { id: 'narrador', label: 'Narrador', voice: 'pt-BR-ValerioNeural', alts: ['pt-BR-JulioNeural', 'pt-BR-NicolauNeural'],
    desc: 'locução grave, estilo rádio', aliases: ['locutor', 'narracao', 'narração', 'valerio'] },
  { id: 'jovem', label: 'Jovem', voice: 'pt-BR-ThalitaNeural', alts: ['pt-BR-GiovannaNeural', 'pt-BR-LeticiaNeural'],
    desc: 'feminina leve e moderna', aliases: ['thalia', 'thalita', 'moderna'] }
]);

function normalizeName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9-]+/g, '');
}

/** Encontra o preset de tom pelo nome/apelido. */
export function findTone(value) {
  const wanted = normalizeName(value);
  if (!wanted) return null;
  return VOICE_TONES.find((tone) => tone.id === wanted || (tone.aliases || []).some((alias) => normalizeName(alias) === wanted)) || null;
}

/** Nome do preset que corresponde exatamente a este percentual (ou `null`). */
export function toneNameFor(pitch) {
  const preset = VOICE_TONES.find((tone) => tone.pitch === Number(pitch));
  return preset ? preset.id : null;
}

/** Rótulo curto do tom para a legenda: `-25% (grossa)`. */
export function toneLabel(pitch) {
  const id = toneNameFor(pitch);
  const preset = VOICE_TONES.find((tone) => tone.id === id);
  return preset ? preset.label.toLowerCase() : '';
}

/**
 * Tom a partir de um token solto (sem flag): nome de preset ou número COM
 * sinal (`-30`, `+20`). Devolve `null` quando o token não é um tom — assim
 * `.voz hoje foi top` continua sendo texto.
 */
export function matchTone(token) {
  const raw = String(token ?? '').trim();
  if (!raw) return null;
  if (/^[+-]\d{1,3}$/.test(raw)) {
    const value = Number(raw);
    return value >= TONE_MIN && value <= TONE_MAX ? value : null;
  }
  const preset = findTone(raw);
  return preset ? preset.pitch : null;
}

/** Tom vindo de flag (`--tom grossa`, `--tom=-30`): erro claro se inválido. */
export function resolveTone(value) {
  const direct = matchTone(value);
  if (direct !== null) return direct;
  // Número fora do intervalo não é erro: prende no limite (é o que o usuário quis).
  const number = /^[+-]?\d{1,3}$/.exec(String(value ?? '').trim());
  if (number) return clamp(Number(number[0]), TONE_MIN, TONE_MAX);
  throw new Error(
    `tom "${value}" não existe — use ${VOICE_TONES.map((tone) => tone.id).join(', ')} ` +
      `ou um número de ${TONE_MIN} a +${TONE_MAX} (ex.: --tom -30)`
  );
}

/** Velocidade vinda de flag (`--vel -10`, `--velocidade +20`). */
export function resolveSpeed(value) {
  const raw = String(value ?? '').trim();
  if (!/^[+-]?\d{1,3}\s*%?$/.test(raw)) {
    throw new Error(`velocidade "${value}" não existe — use um número de ${SPEED_MIN} a +${SPEED_MAX} (ex.: --vel -10)`);
  }
  return clamp(Math.round(parsePct(raw)), SPEED_MIN, SPEED_MAX);
}

// ── Vozes extras do .env ────────────────────────────────────────────
// Avisa uma vez por voz que ficou de fora (o catálogo é relido a cada comando).
const warnedDropped = new Set();

function warnDroppedEngine(id, value) {
  if (warnedDropped.has(id)) return;
  warnedDropped.add(id);
  console.warn(
    `[voz] VOZES_EXTRA "${id}=${String(value).split(':')[0]}:…" ignorada: ` +
      'motores pagos (ElevenLabs/OpenAI TTS) foram removidos do bot. ' +
      'Use uma voz do Edge (ex.: pt-BR-ThalitaNeural) ou um motor grátis offline: espeak:/piper:.'
  );
}

/**
 * Voz personalizada vinda do .env:
 *   VOZES_EXTRA=meuvoz=pt-BR-ThalitaNeural|pitch=+25|rate=+10|fx=nasal+ecoCurto|desc=minha voz
 * Aceita também só o nome da voz (usa a voz crua do motor Edge):
 *   VOZES_EXTRA=thalita2=pt-BR-ThalitaNeural
 * @returns {object[]} entradas no formato do catálogo
 */
export function parseCustomVoices(raw) {
  const entries = [];
  for (const item of String(raw || '').split(/[,;\n]+/)) {
    const text = item.trim();
    if (!text || !text.includes('=')) continue;
    const [namePart, ...rest] = text.split('|');
    const eq = namePart.indexOf('=');
    if (eq <= 0) continue;
    const id = normalizeName(namePart.slice(0, eq));
    let voice = namePart.slice(eq + 1).trim();
    if (!id || !voice) continue;
    // Prefixos de serviços PAGOS (ElevenLabs, OpenAI TTS) não existem mais: a
    // entrada é ignorada com um aviso, em vez de quebrar o `.voz`.
    if (/^(elevenlabs|eleven|openai)\s*:/i.test(voice)) {
      warnDroppedEngine(id, voice);
      continue;
    }
    // Prefixo de motor (todos grátis): `edge:`, `espeak:pt-br+f3`, `piper:modelo`
    // e `polly:Camila` (voz da reserva grátis StreamElements).
    let engine = 'edge';
    const prefixed = /^(espeak-ng|espeak|local|piper|polly|edge)\s*:\s*(.+)$/i.exec(voice);
    if (prefixed) {
      const raw = prefixed[1].toLowerCase();
      engine = raw === 'local' ? 'espeak' : raw === 'espeak-ng' ? 'espeak' : raw;
      voice = prefixed[2].trim();
    }
    const opts = { pitch: 0, rate: 0, volume: 0, fx: [], desc: 'voz personalizada do .env' };
    for (const chunk of rest) {
      const [key, ...valueParts] = chunk.split('=');
      const value = valueParts.join('=').trim();
      const k = normalizeName(key);
      if (k === 'pitch' || k === 'tom') opts.pitch = parsePct(value);
      else if (k === 'rate' || k === 'velocidade') opts.rate = parsePct(value);
      else if (k === 'volume') opts.volume = parsePct(value);
      else if (k === 'fx' || k === 'efeitos') opts.fx = value.split(/[+\s]+/).filter(Boolean);
      else if (k === 'desc' || k === 'descricao') opts.desc = value.slice(0, 80);
    }
    entries.push({ id, label: id, category: 'custom', engine, voice, alts: [], ...opts });
  }
  return entries;
}

// ── Resolução ───────────────────────────────────────────────────────
function decorate(entry, { tone = null, speed = null, fx = null } = {}) {
  const base = {
    engine: 'edge',
    lang: 'pt-BR',
    pitch: 0,
    rate: 0,
    volume: 0,
    fx: [],
    alts: [],
    category: 'voz',
    ...entry
  };
  // O tom/velocidade pedidos no comando têm prioridade sobre os da voz.
  const pitchPct = tone !== null && tone !== undefined ? clamp(Math.round(tone), TONE_MIN, TONE_MAX) : Number(base.pitch) || 0;
  const speedPct = speed !== null && speed !== undefined ? clamp(Math.round(speed), SPEED_MIN, SPEED_MAX) : Number(base.rate) || 0;
  return {
    ...base,
    fx: Array.isArray(fx) && fx.length ? fx : base.fx || [],
    pitchPct,
    speedPct,
    volumePct: Number(base.volume) || 0
  };
}

/**
 * Resolve o nome digitado ("masculina", "narrador") na definição completa.
 * `tone`, `speed` e `fx` vêm do comando e substituem os valores da voz.
 */
export function resolveVoice(name, { extra = [], tone = null, speed = null, fx = null } = {}) {
  const wanted = normalizeName(name);
  if (!wanted) {
    const fallback = VOICE_CATALOG.find((voice) => voice.id === 'auto');
    return { ...decorate(fallback, { tone, speed, fx }), requested: '' };
  }
  const all = [...VOICE_CATALOG, ...extra];
  for (const entry of all) {
    const names = [entry.id, ...(entry.aliases || [])].map(normalizeName);
    if (names.includes(wanted)) return { ...decorate(entry, { tone, speed, fx }), requested: wanted };
  }
  // Nome direto do motor (ex.: pt-BR-AntonioNeural ou en-US-GuyNeural):
  // quem sabe o nome técnico também pode usar.
  if (/^[a-z]{2}-[A-Z]{2}-\w+Neural$/.test(String(name).trim())) {
    return {
      ...decorate({ id: normalizeName(name), label: String(name).trim(), voice: String(name).trim(), alts: [] }, { tone, speed, fx }),
      requested: normalizeName(name)
    };
  }
  const toneHint = findTone(name);
  if (toneHint) {
    throw new Error(`"${name}" é um tom, não uma voz — use .voz ${toneHint.id} <texto> (vozes: ${voiceNameList()})`);
  }
  const similar = suggestVoice(name, { extra });
  throw new Error(
    `voz "${name}" não existe${similar ? ` — você quis dizer "${similar}"?` : ''} ` +
      `Vozes: ${voiceNameList()} · tons: ${VOICE_TONES.map((t) => t.id).join(', ')} · lista completa em .vozes`
  );
}

/** Ids/aliases válidos (para reconhecer `.voz masculina <texto>`). */
export function voiceNames({ extra = [] } = {}) {
  const names = new Set();
  for (const entry of [...VOICE_CATALOG, ...extra]) {
    names.add(normalizeName(entry.id));
    for (const alias of entry.aliases || []) names.add(normalizeName(alias));
  }
  return names;
}

export function isVoiceName(token, { extra = [] } = {}) {
  return voiceNames({ extra }).has(normalizeName(token));
}

/** Nomes para ajuda/erro: "masculina, feminina, narrador, jovem". */
export function voiceNameList({ limit = 8, extra = [] } = {}) {
  const ids = [...VOICE_CATALOG, ...extra].map((entry) => entry.id);
  return ids.length > limit ? `${ids.slice(0, limit).join(', ')}…` : ids.join(', ');
}

/** Sugestão de "nome parecido" para erro de digitação. */
export function suggestVoice(name, { extra = [] } = {}) {
  const wanted = normalizeName(name);
  if (!wanted) return null;
  let best = null;
  for (const candidate of voiceNames({ extra })) {
    if (candidate.startsWith(wanted.slice(0, 3)) || wanted.startsWith(candidate.slice(0, 3))) {
      if (!best || candidate.length < best.length) best = candidate;
    }
  }
  return best;
}

// ── Comando: separar configuração de texto ──────────────────────────
const FLAG_KEYS = Object.freeze({
  voz: 'voz', voice: 'voz',
  tom: 'tom', pitch: 'tom', ton: 'tom', altura: 'tom',
  vel: 'vel', velocidade: 'vel', rate: 'vel', speed: 'vel',
  fx: 'fx', efeito: 'fx', efeitos: 'fx'
});

function applyFlag(target, key, value) {
  const text = String(value ?? '').trim();
  if (!text) return;
  if (key === 'voz') target.voice = text;
  else if (key === 'tom') target.tone = resolveTone(text);
  else if (key === 'vel') target.speed = resolveSpeed(text);
  else if (key === 'fx') target.fx = resolveFxList(text);
}

/**
 * Receita canônica de uma configuração: o texto que pode ser guardado no
 * config e lido de volta (`masculina --tom grossa --vel -10`).
 */
export function voiceRecipe({ voice = null, tone = null, speed = null, fx = null } = {}) {
  const parts = [];
  if (voice) parts.push(String(voice));
  if (tone !== null && tone !== undefined) parts.push(`--tom ${toneNameFor(tone) || `${tone > 0 ? '+' : ''}${tone}`}`);
  if (speed !== null && speed !== undefined) parts.push(`--vel ${speed > 0 ? '+' : ''}${speed}`);
  if (Array.isArray(fx) && fx.length) parts.push(`--fx ${fx.join('+')}`);
  return parts.join(' ') || null;
}

/**
 * Decide o que é configuração e o que é texto no comando `.voz`.
 *   `.voz masculina grossa bom dia`  → voz=masculina, tom=-25, texto="bom dia"
 *   `.voz bom dia`                   → nada configurado, texto="bom dia"
 *   `.voz --tom -30 --vel -10 oi`    → ajuste fino por flags
 *   `.voz masculina`                 → voz sem texto (o bot manda uma prévia)
 *   `.voz "grossa é o nome"`         → aspas = texto literal
 */
export function parseVoiceRequest(args = [], { extra = [] } = {}) {
  const list = (Array.isArray(args) ? [...args] : String(args || '').split(/\s+/))
    .map((item) => String(item ?? ''))
    .filter((item) => item.trim() !== '');

  const result = { voice: null, tone: null, speed: null, fx: null, text: null, explicit: false, recipe: null };

  // 1) Flags em qualquer posição: `--tom -30`, `--tom=-30`, `-tom grossa`.
  const rest = [];
  for (let i = 0; i < list.length; i++) {
    const token = list[i];
    const flag = /^-{1,2}([a-z]+)(?:=([\s\S]*))?$/i.exec(token);
    const key = flag ? FLAG_KEYS[flag[1].toLowerCase()] : null;
    if (!key) {
      rest.push(token);
      continue;
    }
    if (flag[2] !== undefined) {
      applyFlag(result, key, flag[2]);
      continue;
    }
    const value = list[i + 1];
    if (value === undefined) continue; // flag sozinha no fim: ignora
    applyFlag(result, key, value);
    i += 1;
  }

  // 2) No começo, até dois tokens de configuração (voz e/ou tom, em qualquer ordem).
  let index = 0;
  for (let guard = 0; guard < 2 && index < rest.length; guard++) {
    const token = rest[index];
    if (result.voice === null && isVoiceName(token, { extra })) {
      result.voice = token;
      index += 1;
      continue;
    }
    if (result.tone === null && matchTone(token) !== null) {
      result.tone = matchTone(token);
      index += 1;
      continue;
    }
    break;
  }

  // 3) O que sobrou é o texto. Aspas protegem um texto que começa com voz/tom.
  const joined = rest.slice(index).join(' ').trim();
  const quoted = /^"([\s\S]*)"$/.exec(joined) || /^'([\s\S]*)'$/.exec(joined);
  result.text = (quoted ? quoted[1] : joined).trim() || null;
  result.explicit = result.voice !== null || result.tone !== null || result.speed !== null || result.fx !== null;
  result.recipe = result.explicit ? voiceRecipe(result) : null;
  return result;
}

/** Divide uma receita guardada (`"masculina --tom grossa"`) em tokens. */
function splitRecipe(recipe) {
  return String(recipe || '').split(/\s+/).filter(Boolean);
}

/** Receita (texto livre ou guardada no config) → especificação pronta para uso. */
export function resolveVoiceSpec(recipe, { extra = [] } = {}) {
  const parsed = parseVoiceRequest(splitRecipe(recipe), { extra });
  return resolveVoice(parsed.voice || '', { extra, tone: parsed.tone, speed: parsed.speed, fx: parsed.fx });
}

/** Descrição curta para legendas e confirmações: "Masculina · tom -25% (grossa)". */
export function describeSpec(spec = {}) {
  const bits = [String(spec.label || spec.id || 'auto')];
  const tone = Number(spec.pitchPct) || 0;
  if (tone) {
    const label = toneLabel(tone);
    bits.push(`tom ${tone > 0 ? '+' : ''}${tone}%${label ? ` (${label})` : ''}`);
  }
  const speed = Number(spec.speedPct) || 0;
  if (speed) bits.push(`velocidade ${speed > 0 ? '+' : ''}${speed}%`);
  if (Array.isArray(spec.fx) && spec.fx.length) bits.push(`efeito ${spec.fx.join('+')}`);
  return bits.join(' · ');
}

/** Descrição a partir da receita guardada no config. */
export function describeRecipe(recipe, { extra = [] } = {}) {
  try {
    return describeSpec(resolveVoiceSpec(recipe, { extra }));
  } catch {
    return String(recipe || 'auto');
  }
}

/** Linhas do card de ajuda: vozes. */
export function voiceOptionLines({ extra = [] } = {}) {
  return [...VOICE_CATALOG, ...extra].map((entry) => [`.voz ${entry.id} <texto>`, entry.desc || entry.label]);
}

/** Linhas do card de ajuda: tons. */
export function toneOptionLines() {
  return VOICE_TONES.map((tone) => [
    `.voz ${tone.id} <texto>`,
    `${tone.label.toLowerCase()} (${tone.pitch > 0 ? '+' : ''}${tone.pitch}%)`
  ]);
}
