/** Consume an async iterable without retaining more than maxBytes. */
export async function collectLimited(iterable, maxBytes) {
  const requestedLimit = Number(maxBytes);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.max(1, Math.floor(requestedLimit))
    : 1;
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of iterable) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > limit) {
        try { iterable?.destroy?.(); } catch {}
        try { await iterable?.cancel?.(); } catch {}
        throw new Error(`mídia excede o limite de ${limit} bytes`);
      }
      chunks.push(buf);
    }
    return Buffer.concat(chunks, total);
  } finally {
    if (total > limit) {
      try { await iterable?.return?.(); } catch {}
    }
  }
}
