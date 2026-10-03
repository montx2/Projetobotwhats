import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { clearSentStore, getSentMessage, rememberSent, sentStoreSize } from '../src/wa/sent-store.js';
import { createGroupMetadataCache } from '../src/wa/group-cache.js';

test('sent-store devolve o conteúdo enviado (para o reenvio do Baileys) e esquece depois de 1 hora', () => {
  clearSentStore();
  const message = { conversation: 'oi' };
  rememberSent('ABC', message, 1_000);
  assert.equal(getSentMessage('ABC', 1_000 + 59 * 60_000), message);
  assert.equal(getSentMessage('ABC', 1_000 + 61 * 60_000), undefined, 'expirou');
  assert.equal(getSentMessage('ABC'), undefined, 'e foi removida');
  assert.equal(getSentMessage('NUNCA-ENVIADA'), undefined);
  rememberSent('', message);
  rememberSent('X', null);
  rememberSent('Y', 'texto solto');
  assert.equal(sentStoreSize(), 0, 'entradas inválidas são ignoradas');
});

test('sent-store tem teto de memória e descarta as mais antigas primeiro', () => {
  clearSentStore();
  for (let i = 0; i < 700; i += 1) rememberSent(`ID-${i}`, { conversation: String(i) }, 5_000);
  assert.equal(sentStoreSize(), 500);
  assert.equal(getSentMessage('ID-0', 5_000), undefined);
  assert.equal(getSentMessage('ID-199', 5_000), undefined);
  assert.deepEqual(getSentMessage('ID-200', 5_000), { conversation: '200' });
  assert.deepEqual(getSentMessage('ID-699', 5_000), { conversation: '699' });
  clearSentStore();
});

test('cache de grupo consulta o servidor uma vez, junta chamadas simultâneas e respeita TTL e invalidação', async () => {
  let clock = 0;
  let calls = 0;
  const cache = createGroupMetadataCache({
    ttlMs: 1_000,
    now: () => clock,
    fetch: async (jid) => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { id: jid, participants: [{ id: 'a@s.whatsapp.net' }] };
    }
  });
  const [a, b, c] = await Promise.all([cache.get('g@g.us'), cache.get('g@g.us'), cache.get('g@g.us')]);
  assert.equal(calls, 1, 'três envios simultâneos = uma consulta');
  assert.equal(a, b);
  assert.equal(b, c);
  await cache.get('g@g.us');
  assert.equal(calls, 1, 'dentro do TTL reaproveita');
  cache.invalidate('g@g.us'); // alguém entrou/saiu
  await cache.get('g@g.us');
  assert.equal(calls, 2);
  clock = 5_000;
  await cache.get('g@g.us');
  assert.equal(calls, 3, 'passou do TTL: consulta de novo');
});

test('cache de grupo nunca lança, não guarda falhas nem metadados sem participantes e tem teto', async () => {
  let fail = true;
  const cache = createGroupMetadataCache({
    max: 2,
    fetch: async (jid) => {
      if (fail) throw new Error('rate-overlimit');
      return jid === 'vazio@g.us' ? { id: jid } : { id: jid, participants: [] };
    }
  });
  assert.equal(await cache.get('g@g.us'), undefined, 'falha vira undefined (o Baileys consulta sozinho)');
  assert.equal(cache.size(), 0);
  fail = false;
  await cache.get('vazio@g.us');
  assert.equal(cache.size(), 0, 'resposta sem lista de participantes não entra no cache');
  await cache.get('1@g.us');
  await cache.get('2@g.us');
  await cache.get('3@g.us');
  assert.equal(cache.size(), 2);
  assert.equal(await createGroupMetadataCache({}).get('x@g.us'), undefined, 'sem fetch configurado também não lança');
});

test('o cliente liga getMessage e cachedGroupMetadata no socket e guarda o que envia', () => {
  // Regressão do "Aguardando mensagem": sem estes três pontos o reenvio nunca acontece.
  const source = fs.readFileSync(new URL('../src/wa/client.js', import.meta.url), 'utf8');
  assert.match(source, /getMessage:\s*async\s*\(key\)\s*=>\s*getSentMessage\(key\?\.id\)/);
  assert.match(source, /cachedGroupMetadata:\s*\(jid\)\s*=>\s*groupCache\.get\(jid\)/);
  assert.match(source, /rememberSent\(res\.key\.id,\s*res\.message\)/);
  assert.match(source, /groupCache\.invalidate\(update\.id\)/);
});
