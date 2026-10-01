// 🎭 REMOÇÃO DE FUNDO — pool de provedores estilo "contas ilimitadas".
//
// Provedores, em ordem de tentativa:
//   1. remove.bg   → REMOVE_BG_KEYS=key1,key2,key3  (varias contas = ilimitado)
//   2. endpoints   → REMOVE_BG_URLS=https://sua-api/removebg (POST multipart campo "image")
//   3. local       → LOCAL_REMBG=1 usa o CLI `rembg` instalado via pip (offline)
//
// Chaves que estouram limite entram em cooldown automático e o pool gira.

import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

import { KeyPool } from '../core/keypool.js';
import { ENV } from '../core/config.js';
import { postMultipart } from '../core/http.js';
import { log } from '../core/logger.js';

const REMOVE_BG_URL = 'https://api.remove.bg/v1.0/removebg';

const keyPool = new KeyPool('remove.bg', ENV.removeBgKeys, { cooldownMs: 10 * 60_000 });
const urlPool = new KeyPool('removebg-urls', ENV.removeBgUrls, { cooldownMs: 5 * 60_000 });

export function bgPools() {
  return { removebg: keyPool, endpoints: urlPool };
}

function looksLikePng(buffer) {
  return buffer && buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50;
}

/** remove.bg com UMA chave específica. */
async function removeBgWithKey(apiKey, imageBuffer) {
  const { json, buffer } = await postMultipart(
    REMOVE_BG_URL,
    { size: 'auto', type: 'auto' },
    { image_file: { buffer: imageBuffer, filename: 'foto.jpg', type: 'image/jpeg' } },
    { headers: { 'x-api-key': apiKey }, timeoutMs: 90_000 }
  );
  if (json) {
    const title = json?.errors?.[0]?.title || 'erro remove.bg';
    const err = new Error(title);
    const code = json?.errors?.[0]?.code;
    if (['credits_depleted', 'api_key_reached_calls_per_min_limit', 'api_key_invalid', 'api_key_blocked'].includes(code)) {
      err.status = code === 'credits_depleted' ? 402 : 429;
    }
    throw err;
  }
  if (!looksLikePng(buffer)) throw new Error('remove.bg não devolveu um PNG');
  return buffer;
}

/** Endpoint genérico configurado em REMOVE_BG_URLS. */
async function customEndpoint(url, imageBuffer) {
  const { json, buffer } = await postMultipart(
    url,
    {},
    { image: { buffer: imageBuffer, filename: 'foto.jpg', type: 'image/jpeg' } },
    { timeoutMs: 90_000 }
  );
  if (buffer && looksLikePng(buffer)) return buffer;
  // algumas APIs devolvem JSON com a URL do resultado
  const candidate = json?.result || json?.url || json?.image || json?.data?.url;
  if (typeof candidate === 'string' && candidate.startsWith('http')) {
    const { fetchBuffer } = await import('../core/http.js');
    const dl = await fetchBuffer(candidate, { timeoutMs: 60_000 });
    if (looksLikePng(dl)) return dl;
  }
  throw new Error('endpoint não devolveu PNG');
}

/** Fallback local: `rembg i entrada saida` (pip install rembg). */
function localRembg(imageBuffer) {
  return new Promise((resolve, reject) => {
    const inFile = path.join(os.tmpdir(), `nexus-bg-${crypto.randomBytes(4).toString('hex')}.jpg`);
    const outFile = inFile.replace('.jpg', '.png');
    fs.writeFileSync(inFile, imageBuffer);
    const proc = spawn('rembg', ['i', inFile, outFile], { stdio: 'ignore' });
    const timer = setTimeout(() => proc.kill('SIGKILL'), 180_000);
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`rembg indisponível (${e.message}). Instale com: pip install rembg`));
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      try {
        if (code === 0 && fs.existsSync(outFile)) {
          resolve(fs.readFileSync(outFile));
        } else {
          reject(new Error(`rembg saiu com código ${code}`));
        }
      } finally {
        fs.rmSync(inFile, { force: true });
        fs.rmSync(outFile, { force: true });
      }
    });
  });
}

/**
 * Remove o fundo de uma imagem, girando por todos os provedores disponíveis.
 * @returns {Promise<{buffer: Buffer, via: string}>}
 */
export async function removeBackground(imageBuffer) {
  const errors = [];

  // 1) pool remove.bg (várias contas)
  if (keyPool.size) {
    try {
      const buffer = await keyPool.run((key) => removeBgWithKey(key, imageBuffer), { label: 'remove.bg' });
      return { buffer, via: 'remove.bg' };
    } catch (error) {
      errors.push(`remove.bg: ${error.message.slice(0, 120)}`);
    }
  }

  // 2) endpoints customizados
  if (urlPool.size) {
    try {
      const buffer = await urlPool.run((url) => customEndpoint(url, imageBuffer), { label: 'endpoint custom' });
      return { buffer, via: 'endpoint' };
    } catch (error) {
      errors.push(`endpoints: ${error.message.slice(0, 120)}`);
    }
  }

  // 3) rembg local
  if (ENV.localRembg) {
    try {
      return { buffer: await localRembg(imageBuffer), via: 'rembg local' };
    } catch (error) {
      errors.push(`local: ${error.message.slice(0, 120)}`);
    }
  }

  if (!keyPool.size && !urlPool.size && !ENV.localRembg) {
    throw new Error(
      'Nenhum provedor de remoção de fundo configurado. ' +
        'Coloque chaves no .env: REMOVE_BG_KEYS=chave1,chave2 (contas grátis em remove.bg) ' +
        'ou REMOVE_BG_URLS / LOCAL_REMBG=1. Veja o README. 💡'
    );
  }
  throw new Error(`Remoção de fundo falhou em todos os provedores: ${errors.join(' | ')}`);
}

/** Status dos pools para .info */
export function bgStatus() {
  const parts = [];
  parts.push(keyPool.size ? `remove.bg: ${keyPool.available}/${keyPool.size} chaves ativas` : 'remove.bg: sem chaves');
  parts.push(urlPool.size ? `endpoints: ${urlPool.available}/${urlPool.size}` : 'endpoints: nenhum');
  parts.push(ENV.localRembg ? 'rembg local: ativo' : 'rembg local: off');
  return parts;
}
