// 🎭 VOZES — catálogo com NOME em português para cada voz do bot.
//
// Ideia: em vez de decorar `pt-BR-AntonioNeural` ou `en-US-EmmaMultilingualNeural`,
// você escreve o que quer:
//
//     .voz bob querido diário, hoje eu descobri uma coisa
//     .voz lula o povo brasileiro merece respeito
//     .voz narrador e no episódio de hoje...
//     .voz antonio boa tarde, pessoal
//
// TRÊS FAMÍLIAS DE VOZ:
//  1. `pt`          vozes brasileiras naturais (motor grátis Edge, sem chave).
//  2. `personagens` vozes de personagem/paródia: a voz base + tom (pitch) e
//     velocidade (rate) no SSML — e, quando o FFmpeg está instalado, também
//     efeitos (eco, vibrato, grave, "robô").
//  3. `idiomas`     vozes de fora falando português (gringo, gringa, mexicano).
//
// SOBRE OS PERSONAGENS: são IMITAÇÕES/paródias feitas com efeitos de voz, não as
// vozes originais de ninguém (nenhum serviço dá essas vozes de graça, e clonar
// voz de pessoa real exige autorização). Servem para zoeira no grupo.

// ── Efeitos de áudio (aplicados pelo FFmpeg, quando instalado) ────────
// Cada efeito é um pedaço de filtro do FFmpeg. Se o FFmpeg não estiver
// instalado, a voz sai igual, só sem o efeito — nunca falha por causa disso.
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

/** Junta os efeitos pedidos numa cadeia de filtros (`-af`). */
export function buildVoiceFxChain(fx) {
  const list = (Array.isArray(fx) ? fx : [fx])
    .map((item) => VOICE_FX[item] || (typeof item === 'string' && item.includes('=') ? item : null))
    .filter(Boolean);
  return list.join(',');
}

/**
 * Cadeia "corrige tom e velocidade" para motores que NÃO aceitam SSML
 * (OpenAI, ElevenLabs, Polly…). O FFmpeg muda o tom alterando a taxa de
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

/** " +35% " → 35 (aceita também `+0.3st`? não — só porcentagem). */
export function parsePct(value) {
  if (typeof value === 'number') return value;
  const match = /^\s*([+-]?\d+(?:[.,]\d+)?)\s*%?\s*$/.exec(String(value ?? ''));
  if (!match) return 0;
  return Number(match[1].replace(',', '.')) || 0;
}

// ── Catálogo ────────────────────────────────────────────────────────
// `voice` é o nome no motor (voz principal) e `alts` são as reservas usadas
// quando a principal não existe mais na lista do serviço.
const PT_BR = {
  masculina: { voice: 'pt-BR-AntonioNeural', alts: ['pt-BR-DonatoNeural', 'pt-BR-ValerioNeural'] },
  feminina: { voice: 'pt-BR-FranciscaNeural', alts: ['pt-BR-ThalitaNeural', 'pt-BR-LeilaNeural'] }
};

export const VOICE_CATALOG = Object.freeze([
  // ── Brasileiras naturais ──────────────────────────────────────────
  { id: 'auto', label: 'Automática', category: 'pt', voice: PT_BR.feminina.voice, alts: [...PT_BR.feminina.alts, PT_BR.masculina.voice],
    desc: 'o bot escolhe a melhor voz disponível', aliases: ['padrao', 'padrão', 'automatico', 'automático'] },
  { id: 'antonio', label: 'Antônio (masculina)', category: 'pt', voice: 'pt-BR-AntonioNeural',
    alts: PT_BR.masculina.alts, desc: 'voz brasileira natural, boa para recados', aliases: ['masculina', 'masc', 'homem'] },
  { id: 'francisca', label: 'Francisca (feminina)', category: 'pt', voice: 'pt-BR-FranciscaNeural',
    alts: PT_BR.feminina.alts, desc: 'voz brasileira natural, clara e calma', aliases: ['feminina', 'fem', 'mulher'] },
  { id: 'thalita', label: 'Thalita (feminina jovem)', category: 'pt', voice: 'pt-BR-ThalitaNeural',
    alts: PT_BR.feminina.alts, desc: 'mais leve e moderna', aliases: ['thalia', 'jovem'] },
  { id: 'leila', label: 'Leila (feminina madura)', category: 'pt', voice: 'pt-BR-LeilaNeural',
    alts: PT_BR.feminina.alts, desc: 'mais séria e experiente' },
  { id: 'yara', label: 'Yara (feminina narradora)', category: 'pt', voice: 'pt-BR-YaraNeural',
    alts: PT_BR.feminina.alts, desc: 'boa para leitura de textos' },
  { id: 'julio', label: 'Júlio (masculino narrador)', category: 'pt', voice: 'pt-BR-JulioNeural',
    alts: PT_BR.masculina.alts, desc: 'locução limpa, estilo rádio' },
  { id: 'valerio', label: 'Valério (masculino grave)', category: 'pt', voice: 'pt-BR-ValerioNeural',
    alts: PT_BR.masculina.alts, desc: 'mais grave e imponente' },
  { id: 'nicolau', label: 'Nicolau (masculino calmo)', category: 'pt', voice: 'pt-BR-NicolauNeural',
    alts: PT_BR.masculina.alts, desc: 'tom tranquilo, bom para explicações' },

  // ── Personagens e paródias (voz base + efeitos) ───────────────────
  { id: 'bob', label: 'Bob Esponja (paródia)', category: 'personagens',
    voice: 'en-US-EmmaMultilingualNeural', alts: ['pt-BR-FranciscaNeural', 'pt-BR-ThalitaNeural'],
    pitch: 38, rate: 8, fx: ['nasal', 'vibratoLeve'],
    desc: 'fininha, acelerada e irritante do jeito certo', aliases: ['bobesponja', 'bob-esponja', 'esponja', 'calcaquadrada'] },
  { id: 'lula', label: 'Lula (paródia)', category: 'personagens',
    voice: 'pt-BR-AntonioNeural', alts: PT_BR.masculina.alts,
    pitch: -14, rate: -8, fx: ['meioGrave', 'ecoCurto'],
    desc: 'grave, pausada e de palanque', aliases: ['presidente', 'politico', 'político'] },
  { id: 'pato', label: 'Pato Donald (paródia)', category: 'personagens',
    voice: 'en-US-GuyNeural', alts: PT_BR.masculina.alts,
    pitch: 26, rate: 6, fx: ['nasal', 'vibrato'],
    desc: 'patinho nervoso e engasgado', aliases: ['donald', 'pato-donald'] },
  { id: 'robo', label: 'Robô', category: 'personagens',
    voice: PT_BR.masculina.voice, alts: PT_BR.masculina.alts,
    pitch: -6, rate: -4, fx: ['robotico', 'radio'],
    desc: 'metálico, com eco de máquina' },
  { id: 'monstro', label: 'Monstro', category: 'personagens',
    voice: PT_BR.masculina.voice, alts: PT_BR.masculina.alts,
    pitch: -32, rate: -14, fx: ['grave', 'ecoLongo'],
    desc: 'voz cavernosa de vilão' },
  { id: 'bebe', label: 'Bebê', category: 'personagens',
    voice: 'en-US-AnaNeural', alts: ['pt-BR-ThalitaNeural', 'pt-BR-FranciscaNeural'],
    pitch: 50, rate: -6, fx: ['brilho'],
    desc: 'agudinha, fofa e um pouco boba' },
  { id: 'anime', label: 'Anime', category: 'personagens',
    voice: 'pt-BR-ThalitaNeural', alts: PT_BR.feminina.alts,
    pitch: 20, rate: 6, fx: ['brilho'],
    desc: 'dublagem alegre de desenho japonês' },
  { id: 'narrador', label: 'Narrador de trailer', category: 'personagens',
    voice: 'pt-BR-ValerioNeural', alts: PT_BR.masculina.alts,
    pitch: -18, rate: -16, fx: ['teatro', 'meioGrave'],
    desc: 'aquele "em um mundo..." épico' },
  { id: 'velho', label: 'Velhinho', category: 'personagens',
    voice: PT_BR.masculina.voice, alts: PT_BR.masculina.alts,
    pitch: -10, rate: -22, fx: ['vibrato', 'radio'],
    desc: 'lento, cansado e trêmulo' },
  { id: 'fantasma', label: 'Fantasma', category: 'personagens',
    voice: PT_BR.feminina.voice, alts: PT_BR.feminina.alts,
    pitch: -8, rate: -18, fx: ['ecoFantasma', 'sussurro'],
    desc: 'assombração com eco distante' },
  { id: 'alien', label: 'Alienígena', category: 'personagens',
    voice: PT_BR.masculina.voice, alts: PT_BR.masculina.alts,
    pitch: -40, rate: -20, fx: ['robotico', 'ecoLongo'],
    desc: 'gravíssimo e espacial' },
  { id: 'tiktok', label: 'Voz de TikTok', category: 'personagens',
    voice: 'en-US-AvaMultilingualNeural', alts: ['pt-BR-ThalitaNeural', 'pt-BR-FranciscaNeural'],
    pitch: 14, rate: 12, fx: ['brilho'],
    desc: 'animada e apressada, estilo vídeo curto' },
  { id: 'dramatico', label: 'Dramático', category: 'personagens',
    voice: PT_BR.masculina.voice, alts: PT_BR.masculina.alts,
    pitch: -6, rate: -10, fx: ['teatro'],
    desc: 'novela mexicana, com sofrimento' },
  { id: 'bravo', label: 'Bravo', category: 'personagens',
    voice: PT_BR.masculina.voice, alts: PT_BR.masculina.alts,
    pitch: -4, rate: 14, fx: ['distorcao'],
    desc: 'gritando, meio rouco' },
  { id: 'anjo', label: 'Anjo / etéreo', category: 'personagens',
    voice: PT_BR.feminina.voice, alts: PT_BR.feminina.alts,
    pitch: 8, rate: -12, fx: ['ecoLongo', 'brilho'],
    desc: 'suave, com eco celestial' },
  { id: 'apresentador', label: 'Apresentador de TV', category: 'personagens',
    voice: PT_BR.masculina.voice, alts: PT_BR.masculina.alts,
    pitch: 4, rate: 8, fx: ['radio'],
    desc: 'energia de auditório' },

  // ── Outros idiomas falando português ─────────────────────────────
  { id: 'gringo', label: 'Gringo', category: 'idiomas',
    voice: 'en-US-BrianMultilingualNeural', alts: ['en-US-AndrewMultilingualNeural', PT_BR.masculina.voice],
    rate: -4, desc: 'inglês tentando falar português', aliases: ['americano'] },
  { id: 'gringa', label: 'Gringa', category: 'idiomas',
    voice: 'en-US-EmmaMultilingualNeural', alts: ['en-US-AvaMultilingualNeural', PT_BR.feminina.voice],
    rate: -4, desc: 'sotaque de fora, bem claro', aliases: ['americana'] },
  { id: 'mexicano', label: 'Mexicano', category: 'idiomas',
    voice: 'es-MX-JorgeNeural', alts: ['es-MX-DaliaNeural', PT_BR.masculina.voice],
    rate: -6, desc: 'espanhol com jeitinho mexicano', aliases: ['espanhol', 'hermano'] }
]);

export const VOICE_CATEGORIES = Object.freeze({
  pt: 'Vozes brasileiras',
  personagens: 'Personagens e paródias',
  idiomas: 'Outros idiomas'
});

function normalizeName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9-]+/g, '');
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
    // Prefixo de motor: `eleven:<voiceId>`, `openai:nova`, `polly:Camila`.
    let engine = 'edge';
    const prefixed = /^(elevenlabs|eleven|polly|openai|edge)\s*:\s*(.+)$/i.exec(voice);
    if (prefixed) {
      engine = prefixed[1].toLowerCase().startsWith('eleven') ? 'elevenlabs' : prefixed[1].toLowerCase();
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

/**
 * Resolve o nome digitado ("bob", "Bob Esponja", "lula") na definição completa.
 * Sempre devolve algo utilizável: nome desconhecido = erro claro.
 */
export function resolveVoice(name, { extra = [] } = {}) {
  const wanted = normalizeName(name);
  if (!wanted) {
    const fallback = VOICE_CATALOG.find((voice) => voice.id === 'auto');
    return { ...fallback, pitch: 0, rate: 0, volume: 0, fx: [], engine: 'edge', lang: 'pt-BR', requested: '' };
  }
  const all = [...VOICE_CATALOG, ...extra];
  for (const entry of all) {
    const names = [entry.id, ...(entry.aliases || [])].map(normalizeName);
    if (names.includes(wanted)) return decorate(entry);
  }
  // Nome direto do motor (ex.: pt-BR-AntonioNeural ou en-US-GuyNeural):
  // quem sabe o nome técnico também pode usar.
  if (/^[a-z]{2}-[A-Z]{2}-\w+Neural$/.test(String(name).trim())) {
    return decorate({ id: normalizeName(name), label: String(name).trim(), category: 'custom', voice: String(name).trim(), alts: [] });
  }
  const similar = suggestVoice(name, { extra });
  throw new Error(
    `voz "${name}" não existe${similar ? ` — você quis dizer "${similar}"?` : ''} ` +
      'Use .vozes para ver a lista (ex.: bob, lula, antonio, narrador, gringo) ' +
      'ou cadastre a sua em VOZES_EXTRA no .env.'
  );
}

function decorate(entry) {
  return {
    engine: 'edge',
    lang: 'pt-BR',
    pitch: 0,
    rate: 0,
    volume: 0,
    fx: [],
    alts: [],
    category: 'pt',
    ...entry,
    pitchPct: Number(entry.pitch) || 0,
    speedPct: Number(entry.rate) || 0,
    volumePct: Number(entry.volume) || 0
  };
}

/** Ids/aliases válidos (para reconhecer `.voz bob <texto>`). */
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

/**
 * Decide o que é voz e o que é texto no comando `.voz`.
 *   `.voz bob bom dia`        → voz=bob, texto="bom dia"
 *   `.voz bom dia`            → voz=null (usa a padrão), texto="bom dia"
 *   `.voz bob`                → voz=bob, texto=null (o bot manda uma amostra)
 *   `.voz "lula é o cara"`    → texto literal entre aspas
 *   `.voz olá --voz bob`      → voz=bob pelo marcador
 */
export function parseVoiceRequest(args = [], { extra = [] } = {}) {
  const list = Array.isArray(args) ? [...args] : String(args || '').split(/\s+/).filter(Boolean);
  const joined = list.join(' ').trim();
  let voice = null;

  const flagMatch = /(?:^|\s)-{1,2}(?:voz|voice)\s*=?\s*(\S+)/i.exec(joined);
  if (flagMatch) {
    voice = flagMatch[1];
    const cleaned = joined.replace(flagMatch[0], ' ').replace(/\s+/g, ' ').trim();
    return { voice, text: cleaned || null, explicit: true };
  }

  if (list.length && isVoiceName(list[0], { extra })) {
    voice = list[0];
    const rest = list.slice(1).join(' ').trim();
    if (!rest) return { voice, text: null, explicit: true };
    // Aspas protegem um texto que começa com nome de voz.
    const quoted = /^"([\s\S]*)"$/.exec(rest) || /^'([\s\S]*)'$/.exec(rest);
    return { voice, text: quoted ? quoted[1].trim() : rest, explicit: true };
  }

  const quoted = /^"([\s\S]*)"$/.exec(joined) || /^'([\s\S]*)'$/.exec(joined);
  return { voice: null, text: (quoted ? quoted[1] : joined).trim() || null, explicit: false };
}

/** Linhas do catálogo para o menu `.vozes`. */
export function voiceCatalogLines({ category, extra = [] } = {}) {
  const entries = [...VOICE_CATALOG, ...extra].filter((entry) => !category || entry.category === category);
  return entries.map((entry) => [`.voz ${entry.id} <texto>`, entry.desc || entry.label]);
}

/** Nomes para preview/erro: "bob, lula, antonio…". */
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
