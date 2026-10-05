// CONFORMIDADE COM A SPEC DO WHATSAPP — o que não pode falhar em produção.
//
// A figurinha é o recurso mais usado do bot: uma saída acima de 500 KB (ou fora
// de 512×512) é recusada pelo WhatsApp. Aqui ficam os casos extremos que já
// furaram a spec durante o desenvolvimento.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isAnimatedWebp, parseWebp, webpDurationMs } from '../src/util/webp.js';

const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ANIM_MAX = 500 * 1024;
const STATIC_MAX = 100 * 1024;

/** Durações de cada quadro ANMF (ms). */
function frameDurations(buf) {
  const out = [];
  let off = 12;
  while (off + 8 <= buf.length) {
    const type = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (type === 'ANMF') out.push(buf.readUIntLE(off + 8 + 12, 3));
    off += 8 + size + (size & 1);
  }
  return out;
}

test('conteúdo incompressível nunca passa de 500 KB (ruído puro)', { skip: !ffmpeg }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-noise-'));
  const src = path.join(dir, 'ruido.mp4');
  const r = spawnSync('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'nullsrc=s=512x512:r=15:d=3,geq=random(1)*255:128:128',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src
  ]);
  assert.equal(r.status, 0, r.stderr?.toString());

  const { toStickerWebp } = await import('../src/util/ffmpeg.js');
  const { buffer, animated, smart } = await toStickerWebp(fs.readFileSync(src), { animated: true, ext: '.mp4', fit: 'fill' });

  assert.ok(animated, 'ruído com movimento continua animado');
  assert.ok(buffer.length <= ANIM_MAX, `passou do limite: ${Math.round(buffer.length / 1024)} KB`);
  const info = parseWebp(buffer);
  assert.equal(info.width, 512);
  assert.equal(info.height, 512);
  assert.ok(webpDurationMs(buffer) <= 10_000);
  assert.ok(frameDurations(buffer).every((ms) => ms >= 8), 'nenhum quadro abaixo de 8 ms');
  // Quando o conteúdo não cabe de jeito nenhum, a trava final assume a decisão.
  assert.ok(smart?.emergency || buffer.length <= ANIM_MAX * 0.8, 'ou coube no orçamento ou a trava registrou');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('foto detalhada continua estática e dentro de 100 KB', { skip: !ffmpeg }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-photo-'));
  const src = path.join(dir, 'foto.png');
  const r = spawnSync('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'nullsrc=s=512x512:r=1,geq=random(1)*255:128:128',
    '-frames:v', '1', src
  ]);
  assert.equal(r.status, 0, r.stderr?.toString());

  const { toStickerWebp } = await import('../src/util/ffmpeg.js');
  const { buffer, animated } = await toStickerWebp(fs.readFileSync(src), { animated: false, ext: '.png' });
  assert.equal(animated, false);
  assert.ok(buffer.length <= STATIC_MAX, `passou do limite: ${Math.round(buffer.length / 1024)} KB`);
  const info = parseWebp(buffer);
  assert.equal(info.width, 512);
  assert.equal(info.height, 512);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('vídeo comum preserva a duração inteira e não vira estática', { skip: !ffmpeg }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-dur-'));
  const src = path.join(dir, 'v.mp4');
  const r = spawnSync('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=s=960x540:r=30:d=8',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src
  ]);
  assert.equal(r.status, 0, r.stderr?.toString());

  const { toStickerWebp } = await import('../src/util/ffmpeg.js');
  const { buffer, animated } = await toStickerWebp(fs.readFileSync(src), { animated: true, ext: '.mp4', fit: 'fill' });
  assert.ok(animated);
  assert.ok(buffer.length <= ANIM_MAX, `${Math.round(buffer.length / 1024)} KB`);
  const dur = webpDurationMs(buffer);
  assert.ok(dur >= 7_500 && dur <= 10_000, `duração preservada (${dur} ms de 8000)`);
  assert.ok(isAnimatedWebp(buffer));

  fs.rmSync(dir, { recursive: true, force: true });
});
