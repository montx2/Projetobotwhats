// Persistência JSON simples e atômica (sem banco externo — perfeito p/ Termux).

import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from './env.js';

export const DATA_DIR = process.env.NEXUS_DATA_DIR || path.join(ROOT_DIR, 'data');
export const TMP_DIR = path.join(DATA_DIR, 'tmp');

export function ensureDirs() {
  for (const dir of [DATA_DIR, TMP_DIR, path.join(DATA_DIR, 'cache')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function dataFile(name) {
  return path.join(DATA_DIR, name);
}

export function readJson(name, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(dataFile(name), 'utf8'));
  } catch {
    return fallback;
  }
}

let pendingWrites = new Map();
let flushTimer = null;

/** Escrita com debounce (várias gravações rápidas = 1 I/O no disco). */
export function writeJsonDebounced(name, data, delayMs = 1500) {
  pendingWrites.set(name, data);
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const entries = [...pendingWrites.entries()];
    pendingWrites = new Map();
    for (const [file, payload] of entries) {
      writeJsonNow(file, payload);
    }
  }, delayMs);
}

export function writeJsonNow(name, data) {
  try {
    ensureDirs();
    const file = dataFile(name);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  } catch (error) {
    console.error(`[store] falha ao gravar ${name}:`, error.message);
  }
}

export function flushStore() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const entries = [...pendingWrites.entries()];
  pendingWrites = new Map();
  for (const [file, payload] of entries) writeJsonNow(file, payload);
}
