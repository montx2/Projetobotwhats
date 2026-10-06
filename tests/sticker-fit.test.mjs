// Enquadramento da figurinha: padrão preenche o quadrado todo; .s inteira mantém proporção.
// E a divisão dos comandos: `.s` é a figurinha simples (motor clássico, só
// enquadramento); `.figurinha` é o motor inteligente com todos os ajustes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildStickerFilter, classicStickerSteps } from '../src/util/ffmpeg.js';
import { parseFit, parseStickerPrefs, parseSimpleSticker } from '../src/features/sticker.js';
import { parseWebp, tagSticker, webpDurationMs } from '../src/util/webp.js';

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

/* ─────────────── `.s` simples: comandos e motor clássico ─────────────── */

test('parseSimpleSticker (.s): só enquadramento, sempre no motor clássico', () => {
  assert.deepEqual(parseSimpleSticker([]), { fit: 'fill', smart: false });
  assert.deepEqual(parseSimpleSticker(['inteira']), { fit: 'contain', smart: false });
  assert.deepEqual(parseSimpleSticker(['cortar']), { fit: 'cover', smart: false });
  assert.deepEqual(parseSimpleSticker(['preencher']), { fit: 'fill', smart: false });
  // As palavras do `.figurinha` não existem no `.s`: viram palavra desconhecida.
  const ignorado = parseSimpleSticker(['liso', 'hd', 'curto', '6s', 'fundo', 'https://pin.it/abc']);
  assert.deepEqual(ignorado, { fit: 'fill', smart: false });
  for (const key of ['prefer', 'seconds', 'removeBg']) assert.equal(key in ignorado, false, `.s não tem "${key}"`);
});

test('classicStickerSteps (.s): a escada de antes do motor, intacta', () => {
  assert.deepEqual(classicStickerSteps({ animated: true }), [
    { fps: 15, q: 55, dur: 7 },
    { fps: 12, q: 42, dur: 6 },
    { fps: 10, q: 32, dur: 5 },
    { fps: 8, q: 22, dur: 4 },
    { fps: 6, q: 15, dur: 3 }
  ]);
  // Mesmo pedindo os 10 s do WhatsApp, o `.s` fica nos 7 s de antes.
  assert.deepEqual(classicStickerSteps({ animated: true, maxSeconds: 10 }).map((s) => s.dur), [7, 6, 5, 4, 3]);
  assert.deepEqual(classicStickerSteps({ animated: false }), [{ q: 82 }, { q: 68 }, { q: 52 }, { q: 36 }, { q: 22 }]);
});

/** Confere a figurinha FINAL (com EXIF do pack) contra a spec do WhatsApp. */
function assertWhatsAppSpec(raw, { animated, maxMs = 10_000 }) {
  const webp = tagSticker(raw, { pack: 'MontxBOT', author: 'montx' });
  const info = parseWebp(webp);
  assert.equal(info.width, 512, 'largura 512');
  assert.equal(info.height, 512, 'altura 512');
  assert.equal(info.animated, animated, animated ? 'animada' : 'parada');
  assert.ok(webp.length <= (animated ? 500 : 100) * 1024, `peso ${webp.length} B dentro do limite`);
  if (!animated) return { bytes: webp.length };
  const frames = info.chunks.filter((c) => c.type === 'ANMF').map((c) => c.data.readUIntLE(12, 3));
  const ms = webpDurationMs(webp);
  assert.ok(frames.length > 1, 'tem animação de verdade');
  assert.ok(Math.min(...frames) >= 8, 'nenhum quadro abaixo de 8 ms');
  assert.ok(ms > 0 && ms <= maxMs, `duração ${ms} ms ≤ ${maxMs} ms`);
  return { bytes: webp.length, ms };
}

test('toStickerWebp: smart:false é o clássico (sem plano); smart:true passa pelo motor', { skip: !ffmpeg }, async () => {
  const { toStickerWebp } = await import('../src/util/ffmpeg.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'classic-'));
  const src = path.join(dir, 'foto.png');
  spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=800x400', '-frames:v', '1', src]);
  const input = fs.readFileSync(src);
  try {
    const classic = await toStickerWebp(input, { ext: '.png', smart: false });
    const smart = await toStickerWebp(input, { ext: '.png', smart: true });
    assert.equal(classic.smart, undefined, 'o .s não passa pelo motor');
    assert.ok(smart.smart, 'o .figurinha passa pelo motor');
    assertWhatsAppSpec(classic.buffer, { animated: false });
    assertWhatsAppSpec(smart.buffer, { animated: false });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('.s clássico em vídeo de 12 s: 512×512, dentro do limite e no máximo 7 s', { skip: !ffmpeg }, async () => {
  const { toStickerWebp } = await import('../src/util/ffmpeg.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'classic-video-'));
  const src = path.join(dir, 'v.mp4');
  spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=12', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', src]);
  try {
    const out = await toStickerWebp(fs.readFileSync(src), { animated: true, ext: '.mp4', smart: false });
    assert.equal(out.smart, undefined, 'sem trecho, sem crop, sem plano');
    const { ms } = assertWhatsAppSpec(out.buffer, { animated: true, maxMs: 7_000 });
    assert.ok(ms >= 3_000, `a escada antiga desce no máximo até 3 s (saiu ${ms} ms)`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('.s clássico com conteúdo incompressível: a trava segura a spec (ruído puro)', { skip: !ffmpeg }, async () => {
  const { toStickerWebp } = await import('../src/util/ffmpeg.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'classic-noise-'));
  const video = path.join(dir, 'ruido.mp4');
  const foto = path.join(dir, 'ruido.png');
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'nullsrc=s=512x512:r=15:d=3,geq=random(1)*255:128:128', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'nullsrc=s=800x800:d=1,geq=random(1)*255:random(1)*255:random(1)*255', '-frames:v', '1', foto]);
  try {
    // A escada antiga sozinha estoura 500 KB aqui; a trava final não deixa sair.
    const anim = await toStickerWebp(fs.readFileSync(video), { animated: true, ext: '.mp4', smart: false });
    assertWhatsAppSpec(anim.buffer, { animated: true, maxMs: 7_000 });
    const still = await toStickerWebp(fs.readFileSync(foto), { ext: '.png', smart: false });
    assertWhatsAppSpec(still.buffer, { animated: false });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
