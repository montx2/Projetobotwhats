import test from 'node:test';
import assert from 'node:assert/strict';

import { createRetryCounterCache, createSenderKeyKeeper } from '../src/wa/sender-keys.js';

const GROUP = '120363000000000001@g.us';

function fakeSocket({ failing = false } = {}) {
  const calls = [];
  return {
    calls,
    authState: {
      keys: {
        async set(data) {
          if (failing) throw new Error('disco cheio');
          calls.push(data);
        }
      }
    }
  };
}

test('reset apaga a sender-key-memory do grupo (mesma chamada do Baileys)', async () => {
  const sock = fakeSocket();
  const keeper = createSenderKeyKeeper();
  assert.equal(await keeper.reset(sock, GROUP), true);
  assert.deepEqual(sock.calls, [{ 'sender-key-memory': { [GROUP]: null } }]);
});

test('reset ignora chats que não são grupo e sockets sem authState', async () => {
  const sock = fakeSocket();
  const keeper = createSenderKeyKeeper();
  assert.equal(await keeper.reset(sock, '5511999999999@s.whatsapp.net'), false);
  assert.equal(await keeper.reset(sock, undefined), false);
  assert.equal(await keeper.reset({}, GROUP), false);
  assert.equal(await keeper.reset(null, GROUP), false);
  assert.equal(sock.calls.length, 0);
});

test('reset nunca lança: em falha avisa onError e devolve false', async () => {
  const errors = [];
  const keeper = createSenderKeyKeeper({ onError: (e) => errors.push(e.message) });
  assert.equal(await keeper.reset(fakeSocket({ failing: true }), GROUP), false);
  assert.deepEqual(errors, ['disco cheio']);
});

test('refreshIfStale zera no 1º envio, espera o prazo e zera de novo depois', async () => {
  let clock = 0;
  const sock = fakeSocket();
  const keeper = createSenderKeyKeeper({ refreshMs: 60_000, now: () => clock });
  assert.equal(await keeper.refreshIfStale(sock, GROUP, 10), true, '1º envio desde que o bot subiu');
  clock = 59_000;
  assert.equal(await keeper.refreshIfStale(sock, GROUP, 10), false, 'ainda dentro do prazo');
  clock = 61_000;
  assert.equal(await keeper.refreshIfStale(sock, GROUP, 10), true, 'passou do prazo');
  assert.equal(sock.calls.length, 2);
});

test('um reset por evento (entrada de membro) também adia a renovação automática', async () => {
  let clock = 0;
  const sock = fakeSocket();
  const keeper = createSenderKeyKeeper({ refreshMs: 60_000, now: () => clock });
  await keeper.reset(sock, GROUP);
  clock = 30_000;
  assert.equal(await keeper.refreshIfStale(sock, GROUP, 10), false);
});

test('refreshIfStale respeita refreshMs=0 (desligado), grupos grandes e chats privados', async () => {
  const sock = fakeSocket();
  assert.equal(await createSenderKeyKeeper({ refreshMs: 0 }).refreshIfStale(sock, GROUP, 5), false);
  const keeper = createSenderKeyKeeper({ maxParticipants: 100 });
  assert.equal(await keeper.refreshIfStale(sock, GROUP, 101), false, 'grupo grande fica de fora');
  assert.equal(await keeper.refreshIfStale(sock, GROUP, 100), true);
  assert.equal(await keeper.refreshIfStale(sock, '5511@s.whatsapp.net', 2), false);
  assert.equal(await createSenderKeyKeeper().refreshIfStale(sock, GROUP, undefined), true, 'sem contagem, renova');
});

test('contador de retry segue a interface CacheStore, expira e tem teto', () => {
  let clock = 0;
  const cache = createRetryCounterCache({ ttlMs: 1_000, max: 3, now: () => clock });
  assert.equal(cache.get('a'), undefined);
  cache.set('a', 1);
  assert.equal(cache.get('a'), 1);
  clock = 1_001;
  assert.equal(cache.get('a'), undefined, 'expirou');
  for (const k of ['b', 'c', 'd', 'e']) cache.set(k, k);
  assert.equal(cache.size(), 3);
  assert.equal(cache.get('b'), undefined, 'mais antigo saiu');
  cache.del('c');
  assert.equal(cache.get('c'), undefined);
  cache.flushAll();
  assert.equal(cache.size(), 0);
});
