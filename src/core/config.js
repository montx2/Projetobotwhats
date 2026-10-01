// Configuração persistente do NEXUS (data/config.json).
// Tudo que o usuário pode ligar/desligar em tempo real fica aqui.
// MODO PRIVADO ESTRITO POR PADRÃO: o bot só funciona no privado do dono
// e ninguém mais tem acesso a menos que o dono autorize explicitamente (.autorizar).

import { readJson, writeJsonNow, writeJsonDebounced } from './store.js';
import { envList, envBool } from './env.js';

export const DEFAULT_CONFIG = {
  nomeBot: 'MontxBOT',
  nomePack: 'MontxBOT',
  autorPack: '×by ꧁montx2_꧂',
  prefixos: ['.', '!', '/', '#'],

  // ── Controle de Acesso (Modo Privado) ─────────────────────
  modoPrivado: true, // SÓ funciona no privado do dono (e para quem estiver em autorizados)
  autorizados: [], // JIDs de usuários ou grupos autorizados pelo dono via .autorizar

  // ── View Once ─────────────────────────────────────────────
  viewOnce: {
    auto: true, // captura automática e envia SOMENTE para o privado do dono
    destinoAuto: 'dono', // SEMPRE envia para o dono (nunca vaza no grupo/chat)
    resposta: 'dono' // SÓ o dono pode baixar respondendo a uma view once
  },

  // ── Anti-Delete ───────────────────────────────────────────
  antiDelete: {
    ativo: true, // captura mensagens apagadas
    restaurarNoChat: false, // NUNCA manda no grupo/chat alheio por padrão
    avisarDono: true, // envia silenciosamente apenas no privado do dono
    ignorar: [] // filtros: 'grupos', 'privado' ou JIDs específicos
  },

  // ── Downloads ─────────────────────────────────────────────
  autoDownload: true, // link solto baixa sozinho APENAS no privado do dono (ou chat autorizado)
  qualidadePadrao: 'melhor', // melhor | alta | media | baixa
  maxMB: 90, // limite de tamanho para envio

  // ── IA ────────────────────────────────────────────────────
  ia: {
    modeloImagem: 'flux', // flux | turbo
    vozPadrao: 'nova', // alloy echo fable onyx nova shimmer
    sistema:
      'Você é o MontxBOT, um assistente de WhatsApp claro, direto e cordial. ' +
      'Responda sempre em português do Brasil, de forma curta e útil. Use emojis com muita moderação.'
  },

  // ── Comportamento ─────────────────────────────────────────
  soDonoConfigura: true, // só o dono muda configurações
  responderDesconhecido: false // responde quando não entende um prefixo
};

const FILE = 'config.json';

class Config {
  constructor() {
    this.data = this.#load();
  }

  #load() {
    const saved = readJson(FILE, null);
    const merged = deepMerge(structuredClone(DEFAULT_CONFIG), saved || {});
    // Saneamento básico e migração de segurança (garante que nunca vaze em grupos/chats)
    if (!Array.isArray(merged.prefixos) || !merged.prefixos.length) merged.prefixos = DEFAULT_CONFIG.prefixos;
    if (!Array.isArray(merged.antiDelete.ignorar)) merged.antiDelete.ignorar = [];
    if (!Array.isArray(merged.autorizados)) merged.autorizados = [];
    if (typeof merged.modoPrivado !== 'boolean') merged.modoPrivado = true;

    // Nome do bot: quem ainda tem o nome padrão antigo passa para o novo.
    if (merged.nomeBot === '⚡ NEXUS' || merged.nomeBot === 'NEXUS') {
      merged.nomeBot = DEFAULT_CONFIG.nomeBot;
      if (saved) writeJsonNow(FILE, merged);
    }

    // Persona da IA: troca o nome antigo, mantendo prompts personalizados.
    if (typeof merged.ia?.sistema === 'string' && merged.ia.sistema.startsWith('Você é o NEXUS, um assistente de WhatsApp esperto')) {
      merged.ia.sistema = DEFAULT_CONFIG.ia.sistema;
      if (saved) writeJsonNow(FILE, merged);
    }

    // Assinatura: quem ainda tem a assinatura padrão antiga passa para a nova
    // (se você personalizou o nome/autor, o seu valor é mantido).
    if (merged.nomePack === 'NEXUS ⚡' && merged.autorPack === 'feito com amor') {
      merged.nomePack = DEFAULT_CONFIG.nomePack;
      merged.autorPack = DEFAULT_CONFIG.autorPack;
      if (saved) writeJsonNow(FILE, merged);
    }

    // Migração obrigatória da versão antiga que vazava em grupos:
    if (!saved || saved._schemaVersion !== 2) {
      merged.modoPrivado = true;
      merged.viewOnce.destinoAuto = 'dono';
      merged.viewOnce.resposta = 'dono';
      merged.antiDelete.restaurarNoChat = false;
      merged.antiDelete.avisarDono = true;
      merged._schemaVersion = 2;
      writeJsonNow(FILE, merged);
    }
    return merged;
  }

  get() {
    return this.data;
  }

  /** Lê um valor por caminho: cfg.get('antiDelete.ativo') */
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
    this.data._schemaVersion = 2;
    writeJsonNow(FILE, this.data);
  }

  saveDebounced() {
    this.data._schemaVersion = 2;
    writeJsonDebounced(FILE, this.data);
  }

  reset() {
    this.data = structuredClone(DEFAULT_CONFIG);
    this.save();
  }
}

function deepMerge(base, extra) {
  for (const [key, value] of Object.entries(extra || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object') {
      deepMerge(base[key], value);
    } else if (value !== undefined) {
      base[key] = value;
    }
  }
  return base;
}

export const cfg = new Config();

/** Configurações vindas do ambiente (.env). */
export const ENV = {
  ownerNumbers: envList('OWNER_NUMBERS'),
  pairingNumber: (process.env.PAIRING_NUMBER || '').replace(/\D/g, ''),
  removeBgKeys: envList('REMOVE_BG_KEYS'),
  removeBgUrls: envList('REMOVE_BG_URLS'),
  localRembg: envBool('LOCAL_REMBG', false),
  geminiKeys: envList('GEMINI_KEYS'),
  openaiKeys: envList('OPENAI_KEYS'),
  openaiBase: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  groqKeys: envList('GROQ_KEYS'),
  aiBase: process.env.AI_BASE_URL || '',
  aiKeys: envList('AI_KEYS'),
  aiModel: process.env.AI_MODEL || '',
  pollinationsKeys: envList('POLLINATIONS_KEYS'),
  cobaltInstances: envList('COBALT_INSTANCES'),
  tiktokApi: envList('TIKTOK_API'),
  waVersionOverride: process.env.WA_VERSION_OVERRIDE || ''
};
