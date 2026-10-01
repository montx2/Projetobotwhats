// Regressão: backlog ao reconectar não pode disparar ações.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isStale, alreadySeen } from '../src/core/freshness.js';

test('isStale: histórico e mensagens antigas são ignorados, ao vivo passa', () => {
  const now = 1_800_000_000_000;
  const boot = now - 5 * 60_000;
  const mk = (ageSec) => ({ messageTimestamp: Math.floor(now / 1000) - ageSec });
  assert.equal(isStale(mk(5), 'notify', { now, boot }), false); // ao vivo
  assert.equal(isStale(mk(3600), 'notify', { now, boot }), true); // 1h atrás (backlog)
  assert.equal(isStale(mk(400), 'notify', { now, boot }), true); // anterior ao boot
  assert.equal(isStale(mk(5), 'append', { now, boot }), true); // histórico
  assert.equal(isStale({ messageTimestamp: 1 }, 'update', { now, boot }), false); // revoke ao vivo
  assert.equal(isStale({}, 'notify', { now, boot }), false); // sem timestamp: não bloqueia
  assert.equal(isStale({ messageTimestamp: { toNumber: () => Math.floor(now / 1000) - 7200 } }, 'notify', { now, boot }), true); // Long
});

test('alreadySeen: segunda entrega da mesma mensagem é descartada', () => {
  const m = { key: { remoteJid: 'a@s.whatsapp.net', id: 'ABC123', fromMe: false } };
  assert.equal(alreadySeen(m), false);
  assert.equal(alreadySeen(m), true);
});
