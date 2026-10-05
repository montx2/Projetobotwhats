import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { assertPublicHttpUrl, fetchBuffer, fetchText, fetchWithTimeout, postJson, resolveRedirect, setDnsLookupForTests } from '../src/core/http.js';
import { MessageCache } from '../src/wa/cache.js';
import { cfg } from '../src/core/config.js';
import { flushStore, readJson, writeJsonNow } from '../src/core/store.js';
import { collectLimited } from '../src/util/stream.js';

setDnsLookupForTests(async () => [{ address: '8.8.8.8', family: 4 }]);

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

test('URL validation rejects private IPs, credentials and non-HTTP schemes', async () => {
  await assert.rejects(assertPublicHttpUrl('http://127.0.0.1:8080/'), /privado/i);
  await assert.rejects(assertPublicHttpUrl('http://10.2.3.4/'), /privado/i);
  await assert.rejects(assertPublicHttpUrl('http://[::1]/'), /privado/i);
  await assert.rejects(assertPublicHttpUrl('http://[::ffff:7f00:1]/'), /privado/i);
  await assert.rejects(assertPublicHttpUrl('http://[::192.168.1.1]/'), /privado/i);
  await assert.rejects(assertPublicHttpUrl('http://[64:ff9b::7f00:1]/'), /privado/i);
  await assert.rejects(assertPublicHttpUrl('http://[fec0::1]/'), /privado/i);
  await assert.rejects(assertPublicHttpUrl('http://[2001:20::1]/'), /privado/i);
  await assert.rejects(assertPublicHttpUrl('http://[3fff::1]/'), /privado/i);
  await assert.rejects(assertPublicHttpUrl('http://metadata.google.internal/'), /metadata|privado/i);
  await assert.rejects(assertPublicHttpUrl('https://user:secret@example.com/'), /credenciais/i);
  await assert.rejects(assertPublicHttpUrl('file:///etc/passwd'), /HTTP\/HTTPS/i);
  assert.equal(await assertPublicHttpUrl('https://8.8.8.8/path'), 'https://8.8.8.8/path');
  assert.equal(await assertPublicHttpUrl('https://[2001:4860:4860::8888]/'), 'https://[2001:4860:4860::8888]/');
});

test('DNS misto com endereço privado é rejeitado antes da requisição', async () => {
  setDnsLookupForTests(async () => [
    { address: '8.8.8.8', family: 4 },
    { address: '10.0.0.12', family: 4 }
  ]);
  try {
    await assert.rejects(assertPublicHttpUrl('https://mixed-dns.example/resource'), /local\/privado/i);
  } finally {
    setDnsLookupForTests(async () => [{ address: '8.8.8.8', family: 4 }]);
  }
});

test('DNS64 de rede móvel valida o IPv4 embutido sem abrir acesso a destinos privados', async () => {
  try {
    // 64:ff9b::/96 é o prefixo NAT64 padrão: este AAAA representa 8.8.8.8.
    setDnsLookupForTests(async () => [{ address: '64:ff9b::808:808', family: 6 }]);
    assert.equal(
      await assertPublicHttpUrl('https://pin.it/abc123'),
      'https://pin.it/abc123'
    );

    // O mesmo mecanismo não pode transformar um IPv4 privado em destino válido.
    setDnsLookupForTests(async () => [{ address: '64:ff9b::a00:1', family: 6 }]);
    await assert.rejects(
      assertPublicHttpUrl('https://nat64-private.example/resource'),
      /local\/privado/i
    );
  } finally {
    setDnsLookupForTests(async () => [{ address: '8.8.8.8', family: 4 }]);
  }
});

test('cada salto de redirecionamento é validado antes de acessar destino local', async (t) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response('', { status: 302, headers: { location: 'http://127.0.0.1:8123/admin' } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(fetchWithTimeout('https://8.8.8.8/start'), /privado/i);
  assert.equal(calls, 1, 'o destino privado não deve receber uma requisição');
});

test('POST não encaminha Authorization para outra origem após redirect', async (t) => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), headers: init.headers });
    if (requests.length === 1) return new Response('', { status: 302, headers: { location: 'https://1.1.1.1/result' } });
    return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await postJson('https://8.8.8.8/api', { hello: 'world' }, { headers: [['Authorization', 'Bearer secret']] });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].headers.authorization, 'Bearer secret');
  assert.equal(requests[1].headers.authorization, undefined);
});

test('HTTP texto e redirect chegam à URL final; timeout cobre a leitura do corpo', async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === '/short') {
      res.writeHead(302, { location: '/final' });
      res.end();
      return;
    }
    if (req.url === '/slow') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '5' });
      res.flushHeaders();
      setTimeout(() => res.end('hello'), 250);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('final');
  });
  const base = await listen(server);
  t.after(() => close(server));

  assert.equal(await resolveRedirect(`${base}/short`, { allowPrivate: true }), `${base}/final`);
  assert.equal(await fetchText(`${base}/short`, { allowPrivate: true }), 'final');
  await assert.rejects(fetchText(`${base}/slow`, { timeoutMs: 40, allowPrivate: true }), /abort|timeout|terminated/i);
});

test('bounded HTTP reads stop after the configured number of bytes', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(Buffer.alloc(32, 1));
  t.after(() => { globalThis.fetch = originalFetch; });
  await assert.rejects(fetchBuffer('https://8.8.8.8/file', { maxBytes: 8 }), /grande demais/i);
});

test('media stream collector interrompe leitura assim que excede o limite', async () => {
  let chunksRead = 0;
  async function* chunks() {
    chunksRead++;
    yield Buffer.alloc(4);
    chunksRead++;
    yield Buffer.alloc(5);
    chunksRead++;
    yield Buffer.alloc(1);
  }
  await assert.rejects(collectLimited(chunks(), 8), /excede o limite/i);
  assert.equal(chunksRead, 2, 'não lê chunks restantes após exceder o teto');
});

test('message cache é separado por chat e respeita o limite por chat', () => {
  const cache = new MessageCache({ ttlMs: 60_000, maxPerChat: 1, maxTotal: 2 });
  const message = (jid, id) => ({ key: { remoteJid: jid, id, fromMe: false }, message: { conversation: id } });
  cache.put(message('a@s.whatsapp.net', 'A1'));
  cache.put(message('b@s.whatsapp.net', 'B1'));
  cache.put(message('a@s.whatsapp.net', 'A2'));
  assert.equal(cache.get('a@s.whatsapp.net', 'A1'), null);
  assert.equal(cache.get('a@s.whatsapp.net', 'A2')?.id, 'A2');
  assert.equal(cache.get('b@s.whatsapp.net', 'A1'), null);
  assert.equal(cache.get('b@s.whatsapp.net', 'B1')?.id, 'B1');
  const sensitive = { key: { remoteJid: 'a@s.whatsapp.net', id: 'VO1' }, message: { viewOnceMessageV2: { message: { imageMessage: { url: 'encrypted' } } } } };
  cache.put(sensitive, { persist: true });
  assert.equal(cache.get('a@s.whatsapp.net', 'VO1')?.persisted, false, 'View Once nunca é persistida');
  cache.clearAll();
});

test('ao reiniciar, cache remove chats sem opt-in e respeita limites de retenção', () => {
  const optedIn = '5511000000001@s.whatsapp.net';
  const optedOut = '5511000000002@s.whatsapp.net';
  const previous = cfg.get().antiDelete.chats;
  const now = Date.now();
  const savedEntry = (id, ts) => ({ id, ts, fromMe: false, message: { conversation: id }, persisted: true });

  flushStore();
  writeJsonNow('cache/messages.json', {
    [optedIn]: [savedEntry('old', now - 10_000), savedEntry('new', now - 5_000)],
    [optedOut]: [savedEntry('private', now - 1_000)]
  });
  cfg.get().antiDelete.chats = [optedIn];
  cfg.get().antiDelete.ignorar = [];

  try {
    const cache = new MessageCache({ ttlMs: 60_000, maxPerChat: 1, maxTotal: 1 });
    assert.equal(cache.get(optedIn, 'old'), null, 'a entrada mais antiga é descartada pelo limite por chat');
    assert.equal(cache.get(optedIn, 'new')?.id, 'new');
    assert.equal(cache.get(optedOut, 'private'), null, 'conteúdo sem opt-in não é carregado');

    flushStore();
    const persisted = readJson('cache/messages.json', null);
    assert.deepEqual(Object.keys(persisted), [optedIn]);
    assert.deepEqual(persisted[optedIn].map((entry) => entry.id), ['new']);
    cache.clearAll();
    flushStore();
  } finally {
    cfg.get().antiDelete.chats = previous;
  }
});
