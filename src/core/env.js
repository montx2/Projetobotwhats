// Carregador de .env sem dependências externas (funciona em qualquer lugar).
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

export function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  const raw = fs.readFileSync(file, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

export const ROOT_DIR = ROOT;

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
