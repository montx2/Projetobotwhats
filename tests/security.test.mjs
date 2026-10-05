import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { assertPublicHttpUrl, dnsReport, fetchBuffer, fetchText, fetchWithTimeout, nat64EmbeddedIpv4, postJson, resolveRedirect, setDnsLookupForTests, setDnsProbeForTests } from '../src/core/http.js';
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

// 🔧 REGRESSÃO do "bot não baixa nada no 4G/5G": em rede móvel IPv6-only com
// 464XLAT, o DNS64 do operador sintetiza AAAA a partir do A (pin.it vira
// 64:ff9b::9765:54). O validador recusava esse endereço e TODO download morria
// com "host resolve para endereço local/privado" — com a internet funcionando.
test('DNS64/NAT64 de rede móvel libera o host quando o IPv4 embutido é público', async () => {
  setDnsLookupForTests(async () => [{ address: '64:ff9b::9765:54', family: 6 }]); // 151.101.0.84
  try {
    assert.equal(await assertPublicHttpUrl('https://pin.it/abc123'), 'https://pin.it/abc123');
    assert.equal(nat64EmbeddedIpv4('64:ff9b::9765:54'), '151.101.0.84');
  } finally {
    setDnsLookupForTests(async () => [{ address: '8.8.8.8', family: 4 }]);
  }
});

test('NAT64 continua bloqueando quando o IPv4 embutido é local/privado', async () => {
  for (const address of ['64:ff9b::7f00:1', '64:ff9b::c0a8:1', '64:ff9b::6440:1']) {
    setDnsLookupForTests(async () => [{ address, family: 6 }]);
    try {
      await assert.rejects(assertPublicHttpUrl('https://pin.it/abc123'), /local\/privado/i);
    } finally {
      setDnsLookupForTests(async () => [{ address: '8.8.8.8', family: 4 }]);
    }
  }
  assert.equal(nat64EmbeddedIpv4('2a04:4e42:200::84'), null, 'IPv6 global não é NAT64');
});

test('NEXUS_NAT64_PREFIX aceita o prefixo DNS64 do operador', async () => {
  process.env.NEXUS_NAT64_PREFIX = '2001:db8:64::/96';
  setDnsLookupForTests(async () => [{ address: '2001:db8:64::9765:54', family: 6 }]);
  try {
    assert.equal(await assertPublicHttpUrl('https://pin.it/abc123'), 'https://pin.it/abc123');
    setDnsLookupForTests(async () => [{ address: '2001:db8:64::a9fe:1', family: 6 }]); // 169.254.0.1
    await assert.rejects(assertPublicHttpUrl('https://pin.it/abc123'), /local\/privado/i);
  } finally {
    delete process.env.NEXUS_NAT64_PREFIX;
    setDnsLookupForTests(async () => [{ address: '8.8.8.8', family: 4 }]);
  }
});

test('NEXUS_ALLOW_LOCAL_HOSTS libera só o host autorizado pelo dono', async () => {
  process.env.NEXUS_ALLOW_LOCAL_HOSTS = 'pin.it,*.pinterest.com';
  setDnsLookupForTests(async () => [{ address: '127.0.0.1', family: 4 }]);
  try {
    assert.equal(await assertPublicHttpUrl('https://pin.it/abc123'), 'https://pin.it/abc123');
    assert.equal(await assertPublicHttpUrl('https://br.pinterest.com/pin/1/'), 'https://br.pinterest.com/pin/1/');
    await assert.rejects(assertPublicHttpUrl('https://outro-exemplo.com/x'), /local\/privado/i);
    // Regras duras continuam valendo mesmo com a liberação por host.
    await assert.rejects(assertPublicHttpUrl('file://pin.it/etc/passwd'), /HTTP\/HTTPS/i);
    await assert.rejects(assertPublicHttpUrl('https://dono:senha@pin.it/x'), /credenciais/i);
    // A lista não abre a porta dos bloqueios absolutos (host local e IP literal).
    process.env.NEXUS_ALLOW_LOCAL_HOSTS = 'localhost,127.0.0.1,metadata,.internal';
    await assert.rejects(assertPublicHttpUrl('http://localhost:8080/'), /local\/privado/i);
    await assert.rejects(assertPublicHttpUrl('http://127.0.0.1:8080/'), /local\/privado/i);
    await assert.rejects(assertPublicHttpUrl('http://metadata.google.internal/'), /metadata|privado/i);
    await assert.rejects(assertPublicHttpUrl('http://impressora.internal/'), /local\/privado/i);
    process.env.NEXUS_ALLOW_LOCAL_HOSTS = 'pin.it,*.pinterest.com';
  } finally {
    delete process.env.NEXUS_ALLOW_LOCAL_HOSTS;
    setDnsLookupForTests(async () => [{ address: '8.8.8.8', family: 4 }]);
  }
});

test('bloqueio de DNS nomeia o endereço devolvido e traz dica acionável', async () => {
  setDnsLookupForTests(async () => [{ address: '127.0.0.1', family: 4 }]);
  setDnsProbeForTests(async () => ['151.101.0.84']);
  try {
    await assert.rejects(assertPublicHttpUrl('https://pin.it/abc123'), (error) => {
      assert.match(error.message, /local\/privado \(127\.0\.0\.1\)/);
      assert.match(String(error.hint), /DNS público responde 151\.101\.0\.84/);
      assert.match(String(error.hint), /NEXUS_ALLOW_LOCAL_HOSTS=pin\.it/);
      return true;
    });
  } finally {
    setDnsProbeForTests(null);
    setDnsLookupForTests(async () => [{ address: '8.8.8.8', family: 4 }]);
  }
});

test('dnsReport mostra a resolução e o que foi bloqueado (usado pelo doctor)', async () => {
  setDnsLookupForTests(async () => [
    { address: '64:ff9b::9765:54', family: 6 },
    { address: '10.0.0.12', family: 4 }
  ]);
  try {
    const report = await dnsReport('pin.it');
    assert.equal(report.host, 'pin.it');
    assert.equal(report.allowed, false);
    assert.deepEqual(report.blocked, ['10.0.0.12']);
    assert.deepEqual(report.nat64, [{ address: '64:ff9b::9765:54', ipv4: '151.101.0.84' }]);
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
