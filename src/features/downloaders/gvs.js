// 📼 GVS — Google Video Server (`*.googlevideo.com`), o CDN que serve os
// streams do YouTube. Ele NÃO é um host HTTP comum, e tratá-lo como um é
// exatamente o motivo do `.ytmp3` morrer com 403 mesmo quando o Innertube
// respondeu "OK":
//
//   • GET aberto (sem Range) numa URL emitida pelo cliente ANDROID_VR é
//     recusado com 403 — o servidor só entrega FAIXAS limitadas (~1 MiB).
//     Era o nosso caso: o extrator achava a URL, o `fetchBuffer` fazia um GET
//     inteiro e o CDN devolvia 403 na hora (log "download de buffers falhou").
//   • Desde 2026 vários clientes (ANDROID, IOS, e o ANDROID_VR para tudo que
//     não seja o itag 18) emitem URLs "PO-token gated": o primeiro trecho
//     responde 206 e TODO o resto responde 403. Baixar sem checar entrega um
//     arquivo truncado ou um erro no meio do download.
//   • O cliente VISIONOS continua emitindo URL direta, sem cifra e sem PO
//     token, e aceita qualquer formato de requisição.
//
// Este módulo encapsula os dois cuidados: sondar a URL (início + fim) antes de
// confiar nela e baixar sempre em faixas limitadas, que é o que o player real
// faz. Tudo passa pelo `rawFetch`, então a validação de destino (SSRF) e os
// timeouts do núcleo continuam valendo.

import { Readable } from 'node:stream';
import { rawFetch, HttpError, formatBytes } from '../../core/http.js';

/** Tamanho de faixa que o GVS aceita com folga de qualquer cliente. */
export const GVS_CHUNK_BYTES = 1024 * 1024;

export function isGoogleVideoUrl(url) {
  try {
    const host = new URL(String(url)).hostname.toLowerCase();
    return host === 'googlevideo.com' || host.endsWith('.googlevideo.com');
  } catch {
    return false;
  }
}

/** Tamanho total anunciado na própria URL (`clen`) — o GVS sempre manda. */
export function declaredLength(url) {
  try {
    const clen = Number(new URL(String(url)).searchParams.get('clen'));
    return Number.isFinite(clen) && clen > 0 ? clen : 0;
  } catch {
    return 0;
  }
}

function totalFromContentRange(headers) {
  const total = headers?.get?.('content-range')?.match(/\/(\d+)\s*$/)?.[1];
  const n = Number(total);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Lê o corpo com teto rígido de bytes (o CDN pode ignorar o Range pedido). */
async function readBounded(response, limit) {
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  const stream = Readable.fromWeb(response.body);
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > limit) {
      stream.destroy();
      throw new HttpError(`resposta grande demais (> ${formatBytes(limit)})`, { status: response.status });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

const GATED_STATUS = new Set([401, 403]);

/**
 * Sonda um stream do GVS pedindo o PRIMEIRO e o ÚLTIMO byte.
 *
 * Por que o último também: URL com PO token exigido responde 206 no começo e
 * 403 no resto. Quem confia só no início baixa 1 MiB e quebra no meio.
 *
 * @returns {Promise<{verdict:'ok'|'gated'|'unknown', totalBytes:number, status?:number}>}
 *   ok      → serve bytes em faixas, do início ao fim (pode baixar)
 *   gated   → o CDN recusa (403/401): PO token, sessão de outro IP, link velho
 *   unknown → não dá para afirmar (rede instável, 404, mock de teste): siga em
 *             frente, mas sem a garantia — quem chamou decide o risco
 */
export async function probeGoogleVideo(url, { headers = {}, timeoutMs = 15_000, totalBytes = 0 } = {}) {
  const baseHeaders = { ...headers };
  let total = Number(totalBytes) || declaredLength(url);

  let head;
  try {
    head = await rawFetch(url, { headers: { ...baseHeaders, range: 'bytes=0-1' }, timeoutMs });
  } catch {
    return { verdict: 'unknown', totalBytes: total };
  }
  await head.body?.cancel?.().catch(() => {});
  if (GATED_STATUS.has(head.status)) return { verdict: 'gated', totalBytes: total, status: head.status };
  if (head.status !== 200 && head.status !== 206) return { verdict: 'unknown', totalBytes: total, status: head.status };
  total = total || totalFromContentRange(head.headers) || Number(head.headers.get('content-length')) || 0;

  // Arquivo que cabe numa faixa só já foi provado pelo teste acima.
  if (!total || total <= GVS_CHUNK_BYTES) return { verdict: 'ok', totalBytes: total, status: head.status };

  let tail;
  try {
    tail = await rawFetch(url, { headers: { ...baseHeaders, range: `bytes=${total - 2}-${total - 1}` }, timeoutMs });
  } catch {
    return { verdict: 'unknown', totalBytes: total };
  }
  await tail.body?.cancel?.().catch(() => {});
  if (GATED_STATUS.has(tail.status)) return { verdict: 'gated', totalBytes: total, status: tail.status };
  if (tail.status !== 200 && tail.status !== 206) return { verdict: 'unknown', totalBytes: total, status: tail.status };
  return { verdict: 'ok', totalBytes: total, status: tail.status };
}

/**
 * Baixa um stream do GVS em faixas de ~1 MiB (como o player faz).
 *
 * Resolve de uma vez os dois 403 clássicos: o do GET aberto (ANDROID_VR) e o
 * do throttling de conexão única. Se o servidor ignorar o Range e mandar o
 * arquivo inteiro (200 na primeira faixa), aceita o corpo completo.
 *
 * @param {string} url
 * @param {{headers?: object, maxBytes?: number, chunkBytes?: number, totalBytes?: number, timeoutMs?: number, onProgress?: Function}} opts
 * @returns {Promise<Buffer>}
 */
export async function fetchGoogleVideoBuffer(url, {
  headers = {},
  maxBytes = 90 * 1024 * 1024,
  chunkBytes = GVS_CHUNK_BYTES,
  totalBytes = 0,
  timeoutMs = 90_000,
  onProgress
} = {}) {
  const limit = Math.max(1, Math.floor(Number(maxBytes) || 1));
  const chunk = Math.max(64 * 1024, Math.floor(Number(chunkBytes) || GVS_CHUNK_BYTES));
  let total = Number(totalBytes) || declaredLength(url);
  if (total && total > limit) {
    throw new HttpError(`arquivo excede o limite de ${formatBytes(limit)} (${formatBytes(total)})`, { url });
  }

  const parts = [];
  let received = 0;
  // Teto de segurança: nunca girar para sempre se o CDN responder vazio.
  const maxLoops = Math.ceil(limit / chunk) + 4;

  for (let i = 0; i < maxLoops; i++) {
    const end = Math.min(received + chunk - 1, total ? total - 1 : received + chunk - 1);
    if (total && received >= total) break;

    const res = await rawFetch(url, { headers: { ...headers, range: `bytes=${received}-${end}` }, timeoutMs });
    if (!res.ok) {
      await res.body?.cancel?.().catch(() => {});
      throw new HttpError(`HTTP ${res.status} ao baixar faixa ${received}-${end} do YouTube`, { status: res.status, url });
    }

    // 200 na primeira faixa = o servidor ignorou o Range e mandou tudo.
    if (res.status === 200 && received === 0) {
      const body = await readBounded(res, limit);
      if (!body.length) throw new HttpError('o YouTube devolveu um corpo vazio', { url });
      return body;
    }

    total = total || totalFromContentRange(res.headers);
    const body = await readBounded(res, Math.min(limit - received, chunk * 2));
    if (!body.length) break;

    parts.push(body);
    received += body.length;
    if (received > limit) throw new HttpError(`arquivo excede o limite de ${formatBytes(limit)}`, { url });
    await onProgress?.(received, total);
    if (!total && body.length < chunk) break; // sem total conhecido: corpo curto = fim
    if (total && received >= total) break;
  }

  if (!received) throw new HttpError('o YouTube não devolveu bytes', { url });
  if (total && received < total) {
    throw new HttpError(`download incompleto (${formatBytes(received)} de ${formatBytes(total)})`, { url });
  }
  return Buffer.concat(parts, received);
}
