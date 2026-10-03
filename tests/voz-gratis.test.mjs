// 🧪 Teste da promessa comercial do `.voz`: a voz é 100% GRÁTIS e sai mesmo
// quando o motor online principal não responde (internet caída, IP bloqueado,
// 403 da Microsoft…). Nada aqui toca a rede: o Edge é desligado, as reservas
// online respondem erro e quem salva é o motor local/offline (espeak de mentira).
//
// Também confere que nenhum provedor pago sobrou no status da voz.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const isWindows = process.platform === 'win32';

process.env.NEXUS_ENV_FILE = path.join(os.tmpdir(), 'nexus-teste-voz-gratis', '.env');

import { resetLocalStateForTests } from '../src/features/tts-local.js';
import { aiVoiceFull, aiVoiceStatus, resetVoiceCooldowns } from '../src/features/ai.js';

/** espeak falso: grava um WAV pequeno e sai com 0 (o texto vem por stdin). */
function fakeEspeak() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voz-gratis-'));
  const bin = path.join(dir, 'espeak-ng');
  fs.writeFileSync(
    bin,
    `#!/bin/sh
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-w" ]; then shift; out="$1"; fi
  shift
done
printf 'RIFFxxxxWAVEfmt ' > "$out"; dd if=/dev/zero bs=1024 count=6 >> "$out" 2>/dev/null
cat > /dev/null
exit 0
`
  );
  fs.chmodSync(bin, 0o755);
  return { dir, bin };
}

test('sem o motor online, o .voz cai no motor local offline (grátis) e não repete a espera', { skip: isWindows }, async (t) => {
  const fake = fakeEspeak();
  const originalPath = process.env.PATH;
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  process.env.PATH = `${fake.dir}${path.delimiter}${originalPath}`;

  const calls = [];
  // Nenhum WebSocket (Edge fora) e rede toda fora do ar.
  delete globalThis.WebSocket;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    throw new Error('rede fora do ar (teste)');
  };

  resetLocalStateForTests();
  resetVoiceCooldowns();
  t.after(() => {
    process.env.PATH = originalPath;
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
    resetLocalStateForTests();
    resetVoiceCooldowns();
    fs.rmSync(fake.dir, { recursive: true, force: true });
  });

  const first = await aiVoiceFull('bom dia, pessoal', 'antonio');
  assert.equal(first.engine, 'espeak');
  assert.equal(first.offline, true);
  assert.ok(Buffer.isBuffer(first.buffer) && first.buffer.length > 0);
  assert.ok(calls.length > 0, 'as reservas online foram tentadas antes do motor local');

  // Na segunda vez os motores que falharam estão em cooldown: o áudio sai na
  // hora pelo motor local, sem nenhuma chamada de rede.
  const callsBefore = calls.length;
  const second = await aiVoiceFull('tudo bem?', 'antonio');
  assert.equal(second.engine, 'espeak');
  assert.equal(calls.length, callsBefore, 'não deve tentar de novo provedor que acabou de falhar');
});

test('o status da voz não anuncia nenhum provedor pago', () => {
  const rows = aiVoiceStatus().join('\n').toLowerCase();
  assert.ok(!rows.includes('elevenlabs'), 'ElevenLabs é pago e não deve aparecer');
  assert.ok(!rows.includes('openai'), 'OpenAI TTS é pago e não deve aparecer');
  assert.match(rows, /grátis/);
  assert.match(rows, /offline/);
  // E os motores grátis continuam anunciados.
  for (const engine of ['edge', 'streamelements', 'google', 'pollinations', 'espeak']) {
    assert.ok(rows.includes(engine), `faltou o motor grátis ${engine} no status`);
  }
});
