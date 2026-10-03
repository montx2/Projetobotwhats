// Configuração persistente do NEXUS (data/config.json).
// Tudo que o usuário pode ligar/desligar em tempo real fica aqui.
// MODO PRIVADO ESTRITO POR PADRÃO: o bot só funciona no privado do dono
// e ninguém mais tem acesso a menos que o dono autorize explicitamente (.autorizar).

import fs from 'node:fs';
import { readJson, writeJsonNow, writeJsonDebounced } from './store.js';
import { envList, envListAny, envListNumbered, envBool, loadDotEnv, ENV_FILE } from './env.js';

// Garante o .env carregado ANTES de qualquer leitura de process.env abaixo.
// (src/core/env.js já carrega no import — isto é reforço extra e idempotente.)
loadDotEnv();

const PREVIOUS_DEFAULT_IA_SYSTEMS = new Set([
  'Você é o MontxBOT, um assistente de WhatsApp claro, direto e cordial. ' +
    'Responda sempre em português do Brasil, de forma curta e útil. Use emojis com muita moderação.',
  [
    'Você é o MontxBOT, um assistente de WhatsApp brasileiro, bem-humorado, espontâneo e gente boa.',
    'Fale em português do Brasil, com linguagem informal e respostas naturais, curtas e úteis.',
    'Em conversa casual, pode entrar na resenha e usar gírias e memes brasileiros com moderação.',
    'Quando alguém fizer uma provocação boba ou uma frase de duplo sentido (por exemplo: “vou comer seu butão”), responda com uma tirada brincalhona no clima de “Ao cara aí... lá ele 😂” ou “Lá ele!”, variando conforme o contexto.',
    'Não explique a piada nem force meme em toda resposta.',
    'Em perguntas sérias ou factuais, priorize clareza, precisão e respeito; não invente informações.',
    'Mantenha a brincadeira leve: não humilhe, ameace ou ataque ninguém, e não transforme insinuações em conteúdo sexual explícito.',
    'Use emojis com moderação.'
  ].join(' '),
  [
    'Você é o MontxBOT, o parceiro mais resenheiro do grupo do WhatsApp: brasileiro, espontâneo, carismático, caótico e engraçado, sem ser cruel.',
    'Seu modo padrão é RESENHA TOTAL: responda com energia, criatividade e humor; não fale como atendente corporativo nem como professor robótico.',
    'Use português brasileiro bem coloquial e gírias naturais, como “uai”, “véi”, “meu fi”, “mano”, “slk” e “tá doido”. Pode usar palavrões como “carai”, “porra” e “foda pra caralho” como intensificadores de brincadeira quando combinar.',
    'Em papo casual, manda uma resposta curta com punchline, exagero cômico ou provocação leve. Improvisa, acompanha o ritmo da conversa e não termina toda resposta com “como posso ajudar?”.',
    'Em duplo sentido, entra no meme com “Lá ele”, “Ao cara aí... lá ele” ou outra tirada que combine. Exemplo: “vou comer seu butão” → “Eita, meu fi... ao cara aí, LÁ ELE 😂”. Não explique a piada nem repita sempre a mesma frase.',
    'Se a pessoa fizer uma pergunta de verdade, responde corretamente primeiro e pode fechar com uma zoeira curta; nunca invente fatos só pela piada.',
    'Se o assunto for sério, perigoso, saúde, emergência, segurança ou sofrimento, segura a resenha e responde com clareza, respeito e cuidado.',
    'A zoeira é com a situação, não com vulnerabilidades: nada de ameaça, discriminação ou humilhação pesada. Não transforme insinuações em conteúdo sexual explícito.',
    'Pode usar emojis para dar energia, mas sem lotar a resposta nem virar personagem repetitivo.'
  ].join(' ')
]);

const DEFAULT_IA_SYSTEM = [
  'Você é o MontxBOT, um assistente de WhatsApp brasileiro, natural, bem-humorado e atento ao contexto.',
  'Fale em português do Brasil, com respostas claras, curtas e naturais. Seu padrão é tranquilo e sem gírias: não force uma persona, memes, palavrões ou bordões.',
  'Acompanhe de leve o tom da pessoa sem imitar ou repetir as palavras dela. Se ela vier descontraída ou na resenha, pode responder com humor e uma tirada esperta, mas sem empilhar gírias. Se ela conversar normalmente, responda normalmente.',
  'Quando a pessoa fizer uma provocação claramente brincalhona, inclusive uma frase vulgar ou de duplo sentido como “.ia come meu cu”, entenda como resenha e responda com uma tirada curta, divertida e natural. Exemplo de tom, não uma frase fixa: “Calma, nem um café antes? Você já pulou todas as etapas.” Não dê sermão nem use uma recusa automática do tipo “Desculpe, mas não posso ajudar com isso” para uma brincadeira inofensiva. Varie a resposta; não repita sempre “Lá ele” nem explique a piada. Não precisa usar palavrão ou emoji para a resposta ser engraçada.',
  'Não transforme a brincadeira em descrição sexual explícita, ameaça, humilhação ou ataque a alguém. Se a intenção for séria ou houver risco real, estabeleça limites com respeito.',
  'Em perguntas factuais, responda com precisão e sem inventar. Em assuntos delicados, de saúde, segurança ou sofrimento, deixe o humor de lado e seja cuidadoso.',
  'Use emoji só se combinar muito com o contexto ou se a pessoa também estiver usando; no máximo um e, normalmente, nenhum. Evite terminar respostas com perguntas ou ofertas genéricas quando não forem necessárias.'
].join(' ');

export const DEFAULT_CONFIG = {
  nomeBot: 'MontxBOT',
  nomePack: 'MontxBOT',
  autorPack: '×by ꧁montx2_꧂',
  prefixos: ['.', '!', '/', '#'],
  autorizados: [], // JIDs explicitamente autorizados pelo dono

  // Recursos que copiam mensagens começam desativados e são autorizados por chat.
  viewOnce: { autoChats: [] },
  antiDelete: { chats: [], ignorar: [] },

  // Ferramentas de grupo são sempre opt-in e armazenadas separadas por JID.
  grupos: {},

  autoDownload: false,
  qualidadePadrao: 'melhor',
  maxMB: 90,
  ia: {
    modeloImagem: 'flux',
    // Configuração padrão de voz: voz + tom + velocidade (`auto` = voz padrão).
    vozPadrao: 'auto',
    idiomaVoz: 'pt-BR',
    // Voz de cada chat: { "5511...@s.whatsapp.net": "masculina --tom grossa" }.
    vozChats: {},
    sistema: DEFAULT_IA_SYSTEM
  },
  responderDesconhecido: false,
  _schemaVersion: 4
};

/** Voz pode ser trocada por chat — a chave é o JID normalizado. */
function normalizeVoiceChats(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const [rawJid, rawVoice] of Object.entries(value).slice(0, 500)) {
    const jid = String(rawJid || '').trim().toLowerCase().replace(/:\d+@/, '@');
    // É uma receita de voz ("masculina --tom grossa --vel -10"), não só um nome.
    const voice = String(rawVoice || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 120);
    if (!jid || !voice || jid.length > 180) continue;
    result[jid] = voice;
  }
  return result;
}

const FILE = 'config.json';

export function normalizeConfig(saved) {
  const oldVersion = Number(saved?._schemaVersion) || 0;
  const base = structuredClone(DEFAULT_CONFIG);
  const source = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  // Older installs captured content by default. Migration permanently turns
  // those settings off; owners must opt each chat back in explicitly.
  const migrated = oldVersion < 3;
  const name = ['NEXUS', '⚡ NEXUS'].includes(source.nomeBot) ? base.nomeBot : source.nomeBot;
  const iaSystem = typeof source.ia?.sistema === 'string' && (
    PREVIOUS_DEFAULT_IA_SYSTEMS.has(source.ia.sistema) ||
    source.ia.sistema.startsWith('Você é o NEXUS, um assistente de WhatsApp esperto')
  )
    ? base.ia.sistema
    : source.ia?.sistema;
  const prefixos = Array.isArray(source.prefixos) ? source.prefixos.map(String).filter(Boolean).slice(0, 8) : [];

  return {
    ...base,
    ...(typeof name === 'string' ? { nomeBot: name.slice(0, 80) } : {}),
    ...(typeof source.nomePack === 'string' ? { nomePack: source.nomePack.slice(0, 120) } : {}),
    ...(typeof source.autorPack === 'string' ? { autorPack: source.autorPack.slice(0, 120) } : {}),
    prefixos: prefixos.length ? prefixos : base.prefixos,
    autorizados: stringList(source.autorizados),
    viewOnce: { autoChats: migrated ? [] : stringList(source.viewOnce?.autoChats) },
    antiDelete: {
      chats: migrated ? [] : stringList(source.antiDelete?.chats),
      ignorar: stringList(source.antiDelete?.ignorar)
    },
    grupos: normalizeGroupSettings(source.grupos),
    autoDownload: migrated ? false : source.autoDownload === true,
    qualidadePadrao: ['melhor', 'alta', 'media', 'baixa'].includes(source.qualidadePadrao)
      ? source.qualidadePadrao
      : base.qualidadePadrao,
    maxMB: clampNumber(source.maxMB, 1, 200, base.maxMB),
    ia: {
      modeloImagem: typeof source.ia?.modeloImagem === 'string' ? source.ia.modeloImagem.slice(0, 80) : base.ia.modeloImagem,
      vozPadrao: typeof source.ia?.vozPadrao === 'string' && source.ia.vozPadrao.trim()
        ? source.ia.vozPadrao.trim().replace(/\s+/g, ' ').slice(0, 120)
        : base.ia.vozPadrao,
      idiomaVoz: typeof source.ia?.idiomaVoz === 'string' ? source.ia.idiomaVoz.slice(0, 20) : base.ia.idiomaVoz,
      vozChats: normalizeVoiceChats(source.ia?.vozChats),
      sistema: typeof iaSystem === 'string' ? iaSystem.slice(0, 4000) : base.ia.sistema
    },
    responderDesconhecido: source.responderDesconhecido === true,
    _schemaVersion: 4
  };
}

class Config {
  constructor() {
    this.data = this.#load();
  }

  #load() {
    const saved = readJson(FILE, null);
    const clean = normalizeConfig(saved);
    if (!saved || JSON.stringify(clean) !== JSON.stringify(saved)) writeJsonNow(FILE, clean);
    return clean;
  }

  get() {
    return this.data;
  }

  /** Lê um valor por caminho, por exemplo cfg.at('antiDelete.chats'). */
  at(pathStr) {
    return pathStr.split('.').reduce((acc, part) => (acc == null ? undefined : acc[part]), this.data);
  }

  /** Define um valor por caminho e persiste. */
  set(pathStr, value) {
    const parts = pathStr.split('.');
    const last = parts.pop();
    const target = parts.reduce((acc, part) => {
      if (typeof acc[part] !== 'object' || acc[part] === null) acc[part] = {};
      return acc[part];
    }, this.data);
    target[last] = value;
    this.save();
    return value;
  }

  save() {
    this.data._schemaVersion = 4;
    writeJsonNow(FILE, this.data);
  }

  saveDebounced() {
    this.data._schemaVersion = 4;
    writeJsonDebounced(FILE, this.data);
  }

  reset() {
    this.data = structuredClone(DEFAULT_CONFIG);
    this.save();
  }
}

function stringList(value) {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))].slice(0, 500)
    : [];
}

function normalizeGroupSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const [rawJid, rawSettings] of Object.entries(value).slice(0, 500)) {
    const jid = String(rawJid || '').trim().toLowerCase().replace(/:\d+@/, '@');
    if (!jid.endsWith('@g.us') || jid.length > 180) continue;
    const settings = rawSettings && typeof rawSettings === 'object' && !Array.isArray(rawSettings) ? rawSettings : {};
    const antiLink = settings.antiLink && typeof settings.antiLink === 'object' && !Array.isArray(settings.antiLink)
      ? settings.antiLink
      : {};
    result[jid] = {
      welcome: settings.welcome === true,
      goodbye: settings.goodbye === true,
      antiLink: {
        enabled: antiLink.enabled === true,
        allowlist: normalizeDomainList(antiLink.allowlist)
      }
    };
  }
  return result;
}

function normalizeDomainList(value) {
  if (!Array.isArray(value)) return [];
  const domains = [];
  for (const item of value) {
    const domain = String(item || '').trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
    const labels = domain.split('.');
    const validLabel = (label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label);
    const validTld = /^[a-z]{2,63}$|^xn--[a-z0-9-]{2,59}$/.test(labels.at(-1) || '');
    if (labels.length < 2 || labels.some((label) => !validLabel(label)) || !validTld) continue;
    if (!domains.includes(domain)) domains.push(domain);
    if (domains.length >= 50) break;
  }
  return domains;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export const cfg = new Config();

/**
 * Configurações vindas do ambiente (.env).
 *
 * ATENÇÃO: isto é um Proxy LAZY de propósito. Cada acesso (ENV.removeBgKeys,
 * ENV.cobaltInstances…) lê o process.env naquele instante. Antes era um objeto
 * "congelado" no carregamento do módulo — como os `import` do ESM rodam antes
 * do corpo do main.js, o ENV saía VAZIO e o .env era ignorado (bug do
 * "remove.bg sem chaves"). Se você criar um pool dentro de uma função ou quiser
 * recarregar o .env em runtime, agora funciona.
 */
const ENV_SCHEMA = {
  ownerNumbers: () => envList('OWNER_NUMBERS'),
  pairingNumber: () => (process.env.PAIRING_NUMBER || '').replace(/\D/g, ''),
  removeBgKeys: () => envList('REMOVE_BG_KEYS'),
  removeBgUrls: () => envList('REMOVE_BG_URLS'),
  localRembg: () => envBool('LOCAL_REMBG', false),
  geminiKeys: () => envList('GEMINI_KEYS'),
  geminiModels: () => envList('GEMINI_MODELS'),
  openaiKeys: () => envList('OPENAI_KEYS'),
  openaiModels: () => envList('OPENAI_MODELS'),
  openaiBase: () => process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  // Várias chaves do mesmo provedor podem vir de uma lista (GROQ_KEYS=a,b,c) ou
  // de variáveis avulsas (GROQ_API_KEY, GROQ_KEY_1, GROQ_KEY_2…) — todas vão
  // para o mesmo pool e giram em rodízio.
  groqKeys: () => envListNumbered('GROQ_KEYS', { aliases: ['GROQ_API_KEYS', 'GROQ_API_KEY', 'GROQ_KEY'] }),
  groqModels: () => envList('GROQ_MODELS'),
  aiBase: () => process.env.AI_BASE_URL || '',
  aiKeys: () => envListAny('AI_KEYS', 'AI_API_KEYS', 'AI_API_KEY'),
  aiModel: () => process.env.AI_MODEL || '',
  aiModels: () => envList('AI_MODELS'),
  pollinationsKeys: () => envList('POLLINATIONS_KEYS'),
  // Modelo padrão de imagem (o serviço muda a lista com o tempo: o bot também
  // descobre sozinho e cai para o próximo quando um deles sai do ar).
  imageModel: () => process.env.IMAGE_MODEL || '',
  imageModels: () => envList('IMAGE_MODELS'),
  geminiImageModels: () => envList('GEMINI_IMAGE_MODELS'),
  // Voz: tudo grátis — sem chave de serviço pago. `VOZES_EXTRA` cria vozes no
  // formato nome=voz|pitch=+30|rate=+5|fx=nasal; `VOZ_LOCAL=1` prefere os
  // motores offline (espeak/piper) antes das reservas online.
  vozesExtra: () => process.env.VOZES_EXTRA || '',
  vozLocal: () => envBool('VOZ_LOCAL', false),
  // Voz crua do espeak para todo o catálogo (ex.: `pt-br+f4`). O piper lê
  // PIPER_BIN/PIPER_MODEL direto em tts-local.js, junto da detecção dele.
  espeakVoice: () => process.env.ESPEAK_VOICE || '',
  cobaltInstances: () => envList('COBALT_INSTANCES'),
  cobaltApiKey: () => process.env.COBALT_API_KEY || '',
  tiktokApi: () => envList('TIKTOK_API'),
  waVersionOverride: () => process.env.WA_VERSION_OVERRIDE || ''
};

export const ENV = new Proxy(
  {},
  {
    get(_target, prop) {
      const getter = ENV_SCHEMA[prop];
      return getter ? getter() : undefined;
    },
    has: (_target, prop) => prop in ENV_SCHEMA,
    ownKeys: () => Object.keys(ENV_SCHEMA),
    getOwnPropertyDescriptor: (_target, prop) =>
      prop in ENV_SCHEMA ? { enumerable: true, configurable: true, value: undefined } : undefined
  }
);

/**
 * Resumo do .env para diagnóstico (usado no boot, no .doctor e no .pools).
 * Mostra ONDE o bot procurou o arquivo e QUANTAS chaves de cada tipo achou —
 * é isso que denuncia ".env no lugar errado" ou "variável com nome errado".
 */
export function envSummary() {
  return {
    file: ENV_FILE,
    loaded: fs.existsSync(ENV_FILE),
    removeBgKeys: ENV.removeBgKeys.length,
    removeBgUrls: ENV.removeBgUrls.length,
    localRembg: ENV.localRembg,
    geminiKeys: ENV.geminiKeys.length,
    geminiModels: ENV.geminiModels.length,
    openaiKeys: ENV.openaiKeys.length,
    groqKeys: ENV.groqKeys.length,
    groqModels: ENV.groqModels.length,
    aiKeys: ENV.aiKeys.length,
    aiModel: ENV.aiModel,
    aiModels: ENV.aiModels.length,
    pollinationsKeys: ENV.pollinationsKeys.length,
    imageModel: ENV.imageModel,
    imageModels: ENV.imageModels.length,
    geminiImageModels: ENV.geminiImageModels.length,
    vozesExtra: ENV.vozesExtra ? ENV.vozesExtra.split(/[,;\n]+/).filter((item) => item.includes('=')).length : 0,
    vozLocal: ENV.vozLocal,
    cobaltInstances: ENV.cobaltInstances.length
  };
}
