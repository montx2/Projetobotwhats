// Duração da figurinha: o WhatsApp aceita até 10 s de animação e o bot deve
// entregar os 10 s quando a mídia permite — qualidade/FPS caem antes do tempo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  animatedStickerSteps,
  stickerSeconds,
  toStickerWebp,
  STICKER_MAX_SECONDS
} from '../src/util/ffmpeg.js';
import { buildRiff, isAnimatedWebp, parseWebp, readStickerExif, trimAnimatedWebp, webpDurationMs } from '../src/util/webp.js';
import { makeSticker } from '../src/features/sticker.js';

/** WebP animado sintético: `count` quadros de `frameMs` (sem FFmpeg). */
function animatedWebp(count, frameMs, { width = 512, height = 512 } = {}) {
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x02 | 0x10; // VP8X_ANIM | VP8X_ALPHA
  vp8x.writeUIntLE(width - 1, 4, 3);
  vp8x.writeUIntLE(height - 1, 7, 3);
  const frames = [];
  for (let i = 0; i < count; i++) {
    const anmf = Buffer.alloc(29);
    anmf.writeUIntLE(width - 1, 6, 3);
    anmf.writeUIntLE(height - 1, 9, 3);
    anmf.writeUIntLE(frameMs, 12, 3);
    anmf.write('VP8L', 16, 'ascii');
    anmf.writeUInt32LE(5, 20);
    anmf[24] = 0x2f; // bitstream VP8L mínimo, com alpha
    frames.push({ type: 'ANMF', data: anmf });
  }
  return buildRiff([{ type: 'VP8X', data: vp8x }, { type: 'ANIM', data: Buffer.alloc(6) }, ...frames]);
}

test('stickerSeconds: teto de 10 s do WhatsApp (padrão e corte)', () => {
  assert.equal(STICKER_MAX_SECONDS, 10);
  assert.equal(stickerSeconds(), 10);
  assert.equal(stickerSeconds(30), 10);
  assert.equal(stickerSeconds(10), 10);
  assert.equal(stickerSeconds('4'), 4);
  for (const bad of [0, -3, NaN, null, undefined, 'abc']) assert.equal(stickerSeconds(bad), 10);
});

test('animatedStickerSteps: mantém a duração cheia e só depois encurta', () => {
  const steps = animatedStickerSteps(10);
  assert.ok(steps.length >= 8);
  assert.ok(steps.every((s) => s.dur <= 10 && s.dur >= 1));

  const full = steps.filter((s) => s.dur === 10);
  const short = steps.filter((s) => s.dur < 10);
  assert.ok(full.length >= 5, `deve tentar vários ajustes com os 10 s inteiros (${full.length})`);
  assert.ok(short.length >= 1, 'deve ter o encurtamento como último recurso');
  // A ordem é: primeiro os 10 s (FPS/qualidade caindo), depois o tempo encurtando.
  assert.equal(steps[0].dur, 10);
  assert.ok(steps.findIndex((s) => s.dur < 10) > full.length - 1);
  // O FPS cai ao longo da fase que preserva a duração.
  assert.ok(full[0].fps > full[full.length - 1].fps);
  // Nunca passa do teto, mesmo pedindo mais.
  assert.ok(animatedStickerSteps(60).every((s) => s.dur <= 10));
  // Pedido menor continua sendo respeitado.
  assert.ok(animatedStickerSteps(4).every((s) => s.dur <= 4));
});

test('webpDurationMs soma os quadros ANMF e ignora WebP estático', () => {
  assert.equal(webpDurationMs(animatedWebp(12, 1000)), 12_000);
  assert.equal(webpDurationMs(animatedWebp(5, 40)), 200);
  const vp8l = Buffer.alloc(5);
  vp8l[0] = 0x2f;
  vp8l.writeUInt32LE(511 | (511 << 14) | (1 << 28), 1);
  assert.equal(webpDurationMs(buildRiff([{ type: 'VP8L', data: vp8l }])), 0);
  assert.equal(webpDurationMs(Buffer.from('nada')), 0);
});

test('trimAnimatedWebp corta só os quadros finais e preserva o WebP', () => {
  const long = animatedWebp(12, 1000);
  const trimmed = trimAnimatedWebp(long, 10_000);
  assert.equal(trimmed.dropped, 2);
  assert.equal(trimmed.frames, 10);
  assert.equal(trimmed.durationMs, 10_000);
  assert.ok(trimmed.buffer.length < long.length);
  assert.ok(isAnimatedWebp(trimmed.buffer));
  assert.equal(webpDurationMs(trimmed.buffer), 10_000);
  const chunks = parseWebp(trimmed.buffer).chunks;
  assert.equal(chunks[0].type, 'VP8X');
  assert.equal(chunks.filter((c) => c.type === 'ANMF').length, 10);

  // Dentro do limite, nada muda.
  const short = animatedWebp(4, 500);
  const same = trimAnimatedWebp(short, 10_000);
  assert.equal(same.dropped, 0);
  assert.equal(same.buffer, short);
  assert.equal(webpDurationMs(same.buffer), 2000);
});

test('makeSticker corta figurinha animada de 12 s para 10 s (sem FFmpeg)', async () => {
  const source = animatedWebp(12, 1000);
  const out = await makeSticker(
    { buffer: source, type: 'sticker', node: { mimetype: 'image/webp' } },
    { pack: 'Duração', author: 'teste' }
  );
  assert.ok(isAnimatedWebp(out), 'continua animada');
  assert.equal(webpDurationMs(out), 10_000);
  assert.equal(readStickerExif(out).pack, 'Duração');

  // Animada dentro do limite passa intacta (só ganha EXIF).
  const okSource = animatedWebp(6, 500);
  const okOut = await makeSticker(
    { buffer: okSource, type: 'sticker', node: { mimetype: 'image/webp' } },
    { pack: 'Duração', author: 'teste' }
  );
  assert.equal(webpDurationMs(okOut), 3000);
  const countFrames = (buf) => parseWebp(buf).chunks.filter((c) => c.type === 'ANMF').length;
  assert.equal(countFrames(okOut), countFrames(okSource));
});

const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
test('vídeo de 12 s vira figurinha de 10 s dentro de 500 KB', { skip: !ffmpeg }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dur-'));
  const src = path.join(dir, 'long.mp4');
  spawnSync('ffmpeg', [
    '-y', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'testsrc2=size=480x320:rate=15:duration=12', '-pix_fmt', 'yuv420p', src
  ]);
  const input = fs.readFileSync(src);

  const { buffer, animated } = await toStickerWebp(input, { animated: true, ext: '.mp4' });
  const info = parseWebp(buffer);
  const seconds = webpDurationMs(buffer) / 1000;
  assert.equal(animated, true);
  assert.equal(info.width, 512);
  assert.equal(info.height, 512);
  assert.ok(seconds > 9.5 && seconds <= 10, `duração ficou em ${seconds} s`);
  assert.ok(buffer.length <= 500 * 1024, `arquivo ficou com ${Math.round(buffer.length / 1024)} KB`);

  // Vídeo curto não é encurtado para caber: os 6 s continuam inteiros.
  const shortSrc = path.join(dir, 'short.mp4');
  spawnSync('ffmpeg', [
    '-y', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'testsrc2=size=480x320:rate=15:duration=6', '-pix_fmt', 'yuv420p', shortSrc
  ]);
  const short = await toStickerWebp(fs.readFileSync(shortSrc), { animated: true, ext: '.mp4' });
  const shortSeconds = webpDurationMs(short.buffer) / 1000;
  assert.ok(shortSeconds > 5.8 && shortSeconds <= 6.05, `vídeo de 6 s virou ${shortSeconds} s`);

  fs.rmSync(dir, { recursive: true, force: true });
});
