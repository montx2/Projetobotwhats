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

import { isAnimatedWebp, parseWebp, tagSticker, webpDurationMs } from '../src/util/webp.js';
import { predictQuality } from '../src/util/stickerbrain.js';

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
  const { buffer, animated, smart } = await toStickerWebp(fs.readFileSync(src), {
    animated: true,
    ext: '.mp4',
    fit: 'fill'
  });
  assert.ok(animated);
  assert.ok(buffer.length <= ANIM_MAX, `${Math.round(buffer.length / 1024)} KB`);
  const dur = webpDurationMs(buffer);
  assert.ok(dur >= 7_500 && dur <= 10_000, `duração preservada (${dur} ms de 8000)`);
  assert.ok(isAnimatedWebp(buffer));
  // O limite é uma permissão: quando o conteúdo rende bytes, a figurinha sai
  // colada no teto (é o pedido: extrair tudo que o WhatsApp permite).
  assert.ok(smart?.fill, 'o caminho inteligente reporta o aproveitamento');
  assert.ok(
    smart.fill.ratio >= 0.9,
    `aproveitou só ${Math.round(smart.fill.ratio * 100)}% do orçamento`
  );
  const tagged = tagSticker(buffer, { pack: 'MontxBOT', author: 'nexus-bot', emojis: ['🔥'] });
  assert.ok(tagged.length <= ANIM_MAX, `com EXIF passou de 500 KB: ${Math.round(tagged.length / 1024)} KB`);

  fs.rmSync(dir, { recursive: true, force: true });
});

// ── ENCHER O ORÇAMENTO: o limite do WhatsApp é uma permissão de fidelidade ──
// A decisão é pura (probe/predict injetados), então dá para testar o algoritmo
// inteiro sem FFmpeg — inclusive os casos em que encher seria ruim.

/** Codificador falso: bytes(q) = e^(a + b·q), como o libwebp de verdade. */
function fakeEncoder({ a = Math.log(3000), b = 0.06, maxBytes = Infinity } = {}) {
  const samples = [];
  const sizeAt = (q) => Math.min(maxBytes, Math.round(Math.exp(a + b * q)));
  return {
    samples,
    sizeAt,
    probe: async (q) => {
      const bytes = sizeAt(q);
      samples.push({ q, bytes });
      return Buffer.alloc(bytes);
    },
    predict: (target, state) =>
      predictQuality(samples, target, { minQ: state.q + 1, maxQ: 100, sizeKey: 'bytes' })
  };
}

test('fillStickerBudget encosta no limite sem nunca passar dele', async () => {
  const { fillStickerBudget } = await import('../src/util/ffmpeg.js');
  const budget = 496 * 1024;
  const enc = fakeEncoder();
  const filled = await fillStickerBudget({
    buf: Buffer.alloc(enc.sizeAt(45)),
    q: 45,
    budget,
    probe: enc.probe,
    predict: enc.predict
  });
  assert.ok(filled.buf.length <= budget, 'passou do limite');
  assert.ok(filled.buf.length > enc.sizeAt(45), 'não cresceu');
  assert.ok(
    filled.buf.length >= budget * 0.9,
    `aproveitou pouco: ${Math.round((filled.buf.length / budget) * 100)}%`
  );
});

test('fillStickerBudget recusa degrau acima do limite e fica com o maior válido', async () => {
  const { fillStickerBudget } = await import('../src/util/ffmpeg.js');
  const budget = 100 * 1024;
  // Modelo íngreme: q alto estoura feio o limite de 100 KB.
  const enc = fakeEncoder({ a: Math.log(2000), b: 0.09 });
  assert.ok(enc.sizeAt(30) < budget, 'o caso começa dentro do limite');
  const filled = await fillStickerBudget({
    buf: Buffer.alloc(enc.sizeAt(30)),
    q: 30,
    budget,
    probe: enc.probe,
    predict: (target, state) => predictQuality(enc.samples, target, { minQ: state.q + 1, maxQ: 100, sizeKey: 'bytes' })
  });
  assert.ok(filled.buf.length <= budget);
  for (const s of enc.samples) {
    if (s.bytes <= budget) assert.ok(filled.buf.length >= s.bytes, 'existia um degrau válido maior');
  }
});

test('sem perdas entra só quando sobra orçamento e é o maior arquivo válido', async () => {
  const { fillStickerBudget } = await import('../src/util/ffmpeg.js');
  const budget = 496 * 1024;
  const enc = fakeEncoder({ a: Math.log(2000), b: 0.002 }); // conteúdo "simples"
  let asked = 0;
  const filled = await fillStickerBudget({
    buf: Buffer.alloc(enc.sizeAt(60)),
    q: 60,
    budget,
    probe: enc.probe,
    predict: (target, state) => predictQuality(enc.samples, target, { minQ: state.q + 1, maxQ: 100, sizeKey: 'bytes' }),
    tryLossless: async () => {
      asked++;
      return Buffer.alloc(Math.round(budget * 0.7));
    }
  });
  assert.equal(asked, 1);
  assert.equal(filled.lossless, true);
  assert.equal(filled.buf.length, Math.round(budget * 0.7));
  assert.equal(filled.q, 100);
});

test('sem perdas menor que a versão com perdas ainda é o melhor resultado', async () => {
  const { fillStickerBudget } = await import('../src/util/ffmpeg.js');
  const budget = 496 * 1024;
  // Cena chapada: o sem perdas comprime MELHOR que o lossy e é pixel-perfect.
  const enc = fakeEncoder({ a: Math.log(2000), b: 0.002 });
  const filled = await fillStickerBudget({
    buf: Buffer.alloc(enc.sizeAt(60)),
    q: 60,
    budget,
    probe: enc.probe,
    predict: (target, state) => predictQuality(enc.samples, target, { minQ: Math.min(99, state.q + 1), maxQ: 100, sizeKey: 'bytes' }),
    tryLossless: async () => Buffer.alloc(30 * 1024)
  });
  assert.equal(filled.lossless, true);
  assert.equal(filled.buf.length, 30 * 1024, 'o arquivo perfeito e menor é o escolhido');
});

test('sem perdas é descartado quando não cabe no limite', async () => {
  const { fillStickerBudget } = await import('../src/util/ffmpeg.js');
  const budget = 496 * 1024;
  const enc = fakeEncoder({ a: Math.log(2000), b: 0.002 });
  const filled = await fillStickerBudget({
    buf: Buffer.alloc(enc.sizeAt(60)),
    q: 60,
    budget,
    probe: enc.probe,
    predict: (target, state) => predictQuality(enc.samples, target, { minQ: state.q + 1, maxQ: 100, sizeKey: 'bytes' }),
    tryLossless: async () => Buffer.alloc(budget + 1024)
  });
  assert.equal(filled.lossless, false);
  assert.ok(filled.buf.length <= budget);
});

test('sem perdas nem é tentado quando o conteúdo já encheu metade do orçamento', async () => {
  const { fillStickerBudget } = await import('../src/util/ffmpeg.js');
  const budget = 496 * 1024;
  const enc = fakeEncoder({ a: Math.log(3000), b: 0.06 });
  assert.ok(enc.sizeAt(75) > budget * 0.5, 'o caso começa acima da metade do orçamento');
  let asked = 0;
  const filled = await fillStickerBudget({
    buf: Buffer.alloc(enc.sizeAt(75)),
    q: 75,
    budget,
    probe: enc.probe,
    predict: enc.predict,
    tryLossless: async () => {
      asked++;
      return Buffer.alloc(budget);
    }
  });
  assert.equal(asked, 0, 'não vale gastar uma codificação enorme à toa');
  assert.ok(filled.buf.length <= budget);
});
