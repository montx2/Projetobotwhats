// Carregador de .env sem dependências externas (funciona em qualquer lugar).
//
// ⚠️ CORREÇÃO IMPORTANTE (bug do "meu remove.bg não funciona mesmo com a API certa"):
// em ESM todos os `import` são avaliados ANTES de qualquer linha de código do
// arquivo que os importa. O main.js antigo fazia:
//
//     import { loadDotEnv } from './core/env.js';
//     loadDotEnv();                 // ← só roda DEPOIS dos imports
//     import { ENV } from './core/config.js';   // ← ENV já foi montado VAZIO
//
// Resultado: o objeto ENV (remove.bg, IA, Cobalt, TikTok, versão do WA…) era
// montado lendo process.env ANTES do .env ser carregado. Ou seja: o .env era
// lido, mas TARDE DEMAIS — o bot sempre respondia "Nenhum provedor de remoção
// de fundo configurado" e o `.pools`/`.doctor` sempre mostravam "sem chaves".
//
// Agora o .env é carregado no MOMENTO DO IMPORT deste módulo (efeito colateral
// abaixo), então qualquer módulo que dependa de ENV já encontra as variáveis
// carregadas. Também é possível apontar outro arquivo com NEXUS_ENV_FILE.
import fs from 'node:fs';
import path from 'node:path';

export const ROOT_DIR = path.resolve(import.meta.dirname, '..', '..');

/** Caminho do .env (padrão: raiz do projeto; NEXUS_ENV_FILE sobrescreve). */
export const ENV_FILE = process.env.NEXUS_ENV_FILE || path.join(ROOT_DIR, '.env');

/**
 * Converte o texto do .env em pares chave/valor.
 * Aceita: `CHAVE=valor`, `export CHAVE=valor`, aspas simples/duplas, comentários
 * com #, BOM do Windows, CRLF e linhas em branco.
 * @returns {[string, string][]}
 */
export function parseDotEnv(text) {
  const pairs = [];
  const clean = String(text || '').replace(/^\uFEFF/, ''); // BOM (bloco de notas/Windows)
  for (const line of clean.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const body = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const eq = body.indexOf('=');
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim().replace(/^["']|["']$/g, '');
    if (!key) continue;
    let value = body.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    pairs.push([key, value]);
  }
  return pairs;
}

/**
 * Carrega o .env para process.env.
 *
 * Regra de precedência: variável REAL do sistema ganha do .env — mas só se
 * tiver valor. Variável definida só como string vazia (acontece em painéis de
 * hospedagem e em `export X=` no .bashrc) NÃO bloqueia mais o .env.
 *
 * @param {string} [file] caminho do arquivo .env
 * @returns {{file: string, loaded: boolean, entries: number, applied: number}}
 */
export function loadDotEnv(file = ENV_FILE) {
  const result = { file, loaded: false, entries: 0, applied: 0 };
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return result; // sem .env: segue com as variáveis do sistema
  }
  result.loaded = true;
  const pairs = parseDotEnv(raw);
  result.entries = pairs.length;
  for (const [key, value] of pairs) {
    const existing = process.env[key];
    if (existing === undefined || existing === '') {
      process.env[key] = value;
      result.applied += 1;
    }
  }
  return result;
}

// ── Efeito colateral proposital: carrega o .env assim que este módulo é
// importado (ver comentário no topo). Idempotente. ──────────────────────────
loadDotEnv();

/** Lê uma variável como lista (separada por vírgula/espaço), ignorando vazios. */
export function envList(name) {
  const raw = process.env[name];
  if (!raw) return [];
  return String(raw)
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function envBool(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'on', 'yes', 'sim'].includes(String(raw).toLowerCase());
}

export function envNumber(name, fallback = 0) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
