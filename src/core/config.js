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
    vozPadrao: 'nova',
    sistema:
      'Você é o MontxBOT, um assistente de WhatsApp claro, direto e cordial. ' +
      'Responda sempre em português do Brasil, de forma curta e útil. Use emojis com muita moderação.'
  },
  responderDesconhecido: false,
  _schemaVersion: 4
};

const FILE = 'config.json';

export function normalizeConfig(saved) {
  const oldVersion = Number(saved?._schemaVersion) || 0;
  const base = structuredClone(DEFAULT_CONFIG);
  const source = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  // Older installs captured content by default. Migration permanently turns
  // those settings off; owners must opt each chat back in explicitly.
  const migrated = oldVersion < 3;
  const name = ['NEXUS', '⚡ NEXUS'].includes(source.nomeBot) ? base.nomeBot : source.nomeBot;
  const iaSystem = typeof source.ia?.sistema === 'string' && source.ia.sistema.startsWith('Você é o NEXUS, um assistente de WhatsApp esperto')
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
      vozPadrao: typeof source.ia?.vozPadrao === 'string' ? source.ia.vozPadrao.slice(0, 40) : base.ia.vozPadrao,
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
    cobaltInstances: ENV.cobaltInstances.length
  };
}
