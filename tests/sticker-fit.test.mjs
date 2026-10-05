// Enquadramento da figurinha: padrão preenche o quadrado todo; .s inteira mantém proporção.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildStickerFilter } from '../src/util/ffmpeg.js';
import { parseFit, parseStickerPrefs } from '../src/features/sticker.js';

test('parseFit: padrão preenche; flags escolhem outros modos', () => {
  assert.equal(parseFit([]), 'fill');
  assert.equal(parseFit(['qualquer', 'coisa']), 'fill');
  for (const w of ['inteira', 'INTEIRA', 'full', 'original', '-inteira']) assert.equal(parseFit([w]), 'contain');
  for (const w of ['cortar', 'crop', 'corte']) assert.equal(parseFit([w]), 'cover');
});

test('parseStickerPrefs: liso/hd/curto e duração exata, sem conflito com enquadramento', () => {
  assert.deepEqual(parseStickerPrefs([]), { prefer: 'auto', seconds: 0 });
  assert.deepEqual(parseStickerPrefs(['qualquer']), { prefer: 'auto', seconds: 0 });
  for (const w of ['liso', 'LISO', '-fluido', 'fluidez']) assert.equal(parseStickerPrefs([w]).prefer, 'smooth', w);
  for (const w of ['nitido', 'nítido', 'hd', 'qualidade']) assert.equal(parseStickerPrefs([w]).prefer, 'sharp', w);
  assert.equal(parseStickerPrefs(['curto']).seconds, 5);
  assert.equal(parseStickerPrefs(['6s']).seconds, 6);
  assert.equal(parseStickerPrefs(['8,5s']).seconds, 8.5);
  assert.equal(parseStickerPrefs(['20s']).seconds, 10, 'não passa do teto do WhatsApp');
  assert.equal(parseStickerPrefs(['1s']).seconds, 2, 'nem abaixo do mínimo útil');
  const junto = parseStickerPrefs(['inteira', 'hd', '7s']);
  assert.deepEqual(junto, { prefer: 'sharp', seconds: 7 });
  assert.equal(parseFit(['inteira', 'hd', '7s']), 'contain', 'enquadramento continua funcionando junto');
});

test('buildStickerFilter: fill não usa pad; contain usa pad; cover usa crop', () => {
  const fill = buildStickerFilter({ animated: false, fit: 'fill' });
  assert.match(fill, /scale=512:512:force_original_aspect_ratio=disable/);
  assert.doesNotMatch(fill, /pad=/);
  assert.doesNotMatch(fill, /crop=/);
  assert.match(buildStickerFilter({ animated: false }), /disable/); // padrão = fill
  assert.match(buildStickerFilter({ animated: false, fit: 'contain' }), /decrease.*pad=512:512/);
  assert.match(buildStickerFilter({ animated: true, fit: 'cover', fps: 12 }), /^fps=12,.*increase.*crop=512:512/);
});

const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
test('figurinha real: fill ocupa 100% do quadrado, contain deixa margem transparente', { skip: !ffmpeg }, async () => {
  const { toStickerWebp } = await import('../src/util/ffmpeg.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fit-'));
  const src = path.join(dir, 'w.png');
  spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:size=800x400', '-frames:v', '1', src]);
  const input = fs.readFileSync(src);
  const alphaTopLeft = (webp) => {
    const f = path.join(dir, 'o.webp');
    fs.writeFileSync(f, webp);
    const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-i', f, '-vf', 'format=rgba,crop=1:1:256:2', '-f', 'rawvideo', '-']);
    return r.stdout[3]; // canal alpha do pixel (256, 2): meio da borda de cima
  };
  const fill = await toStickerWebp(input, { ext: '.png', fit: 'fill' });
  const contain = await toStickerWebp(input, { ext: '.png', fit: 'contain' });
  assert.equal(alphaTopLeft(fill.buffer) > 240, true, 'fill deve cobrir a borda de cima');
  assert.equal(alphaTopLeft(contain.buffer) < 15, true, 'contain deve ter margem transparente em cima');
  fs.rmSync(dir, { recursive: true, force: true });
});
