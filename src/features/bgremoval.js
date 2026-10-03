// 🎭 REMOÇÃO DE FUNDO — provedores configurados pelo operador, com cooldown.
//
// Provedores, em ordem de tentativa:
//   1. remove.bg   → REMOVE_BG_KEYS=key1,key2,key3 (respeita limites do serviço)
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
import { ENV, envSummary } from '../core/config.js';
import { postMultipart } from '../core/http.js';
import { log } from '../core/logger.js';

const REMOVE_BG_URL = 'https://api.remove.bg/v1.0/removebg';
const MAX_BG_INPUT_BYTES = 20 * 1024 * 1024;

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
  let resposta;
  try {
    resposta = await postMultipart(
      REMOVE_BG_URL,
      { size: 'auto', type: 'auto' },
      { image_file: { buffer: imageBuffer, filename: 'foto.jpg', type: 'image/jpeg' } },
      { headers: { 'x-api-key': apiKey }, timeoutMs: 90_000 }
    );
  } catch (error) {
    // O remove.bg explica o motivo em JSON (chave inválida, créditos esgotados,
    // limite por minuto...). Traduzimos para uma mensagem legível e mantemos o
    // status HTTP para o pool saber se a chave deve ir para a geladeira.
    const detalhe = detalheRemoveBg(error);
    const err = new Error(detalhe || error.message);
    err.status = error.status;
    err.retryAfterMs = error.retryAfterMs;
    throw err;
  }
  const { json, buffer } = resposta;
  if (json) {
    const code = json?.errors?.[0]?.code;
    const title = json?.errors?.[0]?.title || 'erro remove.bg';
    const err = new Error(traduzirErroRemoveBg(code, title));
    if (['credits_depleted', 'api_key_reached_calls_per_min_limit', 'api_key_invalid', 'api_key_blocked'].includes(code)) {
      err.status = code === 'credits_depleted' ? 402 : 429;
    }
    throw err;
  }
  if (!looksLikePng(buffer)) throw new Error('remove.bg não devolveu um PNG');
  return buffer;
}

/** Extrai a mensagem real do erro do remove.bg (o corpo vem em JSON). */
function detalheRemoveBg(error) {
  const texto = String(error?.bodyText || error?.message || '');
  const jsonStart = texto.indexOf('{');
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(texto.slice(jsonStart));
      const first = parsed?.errors?.[0];
      if (first) return traduzirErroRemoveBg(first.code, first.title || '');
    } catch {
      /* corpo não era JSON — segue com o texto cru */
    }
  }
  return '';
}

/** Mensagens do remove.bg em português, com o que fazer. */
function traduzirErroRemoveBg(code, title = '') {
  const map = {
    api_key_invalid: 'chave da API inválida (confira se copiou a chave do painel remove.bg, sem espaços)',
    api_key_blocked: 'chave bloqueada no remove.bg',
    api_key_reached_calls_per_min_limit: 'limite de chamadas por minuto da chave — o pool gira para a próxima',
    credits_depleted: 'créditos do remove.bg esgotados (o plano grátis dá 50/mês por conta) — use outra chave',
    insufficient_credits: 'créditos insuficientes no remove.bg (plano grátis: 50/mês por conta)',
    image_too_large: 'imagem grande demais para o remove.bg (máx. 12 MB / 25 megapixels)',
    image_file_invalid: 'arquivo enviado não é uma imagem válida'
  };
  return map[code] || title || code || 'erro remove.bg';
}

/** Endpoint genérico configurado em REMOVE_BG_URLS. */
async function customEndpoint(url, imageBuffer) {
  const { json, buffer } = await postMultipart(
    url,
    {},
    { image: { buffer: imageBuffer, filename: 'foto.jpg', type: 'image/jpeg' } },
    { timeoutMs: 90_000, allowPrivate: true }
  );
  if (buffer && looksLikePng(buffer)) return buffer;
  // algumas APIs devolvem JSON com a URL do resultado
  const candidate = json?.result || json?.url || json?.image || json?.data?.url;
  if (typeof candidate === 'string' && candidate.startsWith('http')) {
    const { fetchBuffer } = await import('../core/http.js');
    const dl = await fetchBuffer(candidate, { timeoutMs: 60_000, allowPrivate: true });
    if (looksLikePng(dl)) return dl;
  }
  throw new Error('endpoint não devolveu PNG');
}

/** Fallback local: `rembg i entrada saida` (pip install rembg). */
function localRembg(imageBuffer) {
  return new Promise((resolve, reject) => {
    const inFile = path.join(os.tmpdir(), `nexus-bg-${crypto.randomBytes(4).toString('hex')}.jpg`);
    const outFile = inFile.replace('.jpg', '.png');
    const cleanup = () => {
      fs.rmSync(inFile, { force: true });
      fs.rmSync(outFile, { force: true });
    };
    try { fs.writeFileSync(inFile, imageBuffer); }
    catch (error) { cleanup(); reject(new Error(`não consegui preparar a imagem local (${error.message})`)); return; }
    const proc = spawn('rembg', ['i', inFile, outFile], { stdio: 'ignore' });
    const timer = setTimeout(() => proc.kill('SIGKILL'), 180_000);
    timer.unref?.();
    proc.on('error', (error) => {
      clearTimeout(timer);
      cleanup();
      reject(new Error(`rembg indisponível (${error.message}). Instale com: pip install rembg`));
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      try {
        if (code === 0 && fs.existsSync(outFile)) resolve(fs.readFileSync(outFile));
        else reject(new Error(`rembg saiu com código ${code}`));
      } catch (error) {
        reject(new Error(`não consegui ler o resultado local (${error.message})`));
      } finally {
        cleanup();
      }
    });
  });
}

/**
 * Remove o fundo de uma imagem, girando por todos os provedores disponíveis.
 * @returns {Promise<{buffer: Buffer, via: string}>}
 */
export async function removeBackground(imageBuffer) {
  if (!Buffer.isBuffer(imageBuffer) || !imageBuffer.length) throw new Error('imagem inválida');
  if (imageBuffer.length > MAX_BG_INPUT_BYTES) throw new Error('imagem excede o limite de 20 MB para remoção de fundo');
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
    throw new Error(noProviderMessage());
  }
  throw new Error(`Remoção de fundo falhou em todos os provedores: ${errors.join(' | ')}`);
}

/**
 * Mensagem de erro/diagnóstico quando não há nenhum provedor configurado.
 * Inclui O CAMINHO do .env — é o que resolve 90% dos casos (arquivo no lugar
 * errado, criado fora da pasta do bot ou com o nome da variável trocado).
 */
export function noProviderMessage() {
  const s = envSummary();
  return (
    'Nenhum provedor de remoção de fundo configurado.\n' +
    `• .env procurado em: ${s.file} ${s.loaded ? '(arquivo encontrado)' : '(ARQUIVO NÃO ENCONTRADO — crie o .env na raiz do bot)'}\n` +
    '• Esperado: REMOVE_BG_KEYS=chave1,chave2  (contas grátis em remove.bg)\n' +
    '• Alternativas: REMOVE_BG_URLS=https://sua-api/removebg  ou  LOCAL_REMBG=1 (pip install rembg)\n' +
    '• Depois de salvar o .env, REINICIE o bot e confira com .pools 💡'
  );
}

/** Avisa no boot quando a remoção de fundo está sem provedor (evita erro só na hora do uso). */
export function warnIfBgUnconfigured() {
  if (keyPool.size || urlPool.size || ENV.localRembg) return false;
  log.warn(
    'Remoção de fundo DESLIGADA: nenhuma chave no .env (REMOVE_BG_KEYS=...) e LOCAL_REMBG não está ligado. ' +
      `.fundo/.sfundo vão falhar até configurar — veja .env.example`
  );
  return true;
}

/** Status dos pools para .info */
export function bgStatus() {
  const parts = [];
  parts.push(keyPool.size ? `remove.bg: ${keyPool.available}/${keyPool.size} chaves ativas` : 'remove.bg: sem chaves no .env');
  parts.push(urlPool.size ? `endpoints: ${urlPool.available}/${urlPool.size}` : 'endpoints: nenhum');
  parts.push(ENV.localRembg ? 'rembg local: ativo' : 'rembg local: off');
  return parts;
}
