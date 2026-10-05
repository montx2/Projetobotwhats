// Recorte automático de fundo COMPLEXO por IA (opt-in) em figurinha.
//
// O teste é hermético: um servidor local imita o contrato aceito pelo bot
// (POST multipart → JSON com a URL do PNG recortado), então dá para validar a
// fiação inteira — decisão do motor, chamada, validação do alfa e re-encode —
// sem tocar no remove.bg e sem gastar crédito.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  GRID,
  aiCutCouldHelp,
  analyzeFrames,
  backgroundVerdict,
  planSticker
} from '../src/util/stickerbrain.js';

const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

/** Quadros RGBA sintéticos: fundo de uma cor (ou de quatro cores) e um bloco. */
function frames({ frames: count, block = 8, bg = [40, 40, 40], fg = [235, 235, 235], place = null, quadrants = false, hideBg = false }) {
  const raw = Buffer.alloc(count * GRID * GRID * 4);
  for (let f = 0; f < count; f++) {
    const base = f * GRID * GRID * 4;
    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        const p = base + (y * GRID + x) * 4;
        let color = bg;
        if (quadrants) {
          const q = (x < GRID / 2 ? 0 : 1) + (y < GRID / 2 ? 0 : 2);
          color = [[200, 40, 40], [40, 200, 40], [40, 40, 200], [220, 200, 40]][q];
        }
        raw[p] = color[0];
        raw[p + 1] = color[1];
        raw[p + 2] = color[2];
        raw[p + 3] = hideBg ? 0 : 255;
      }
    }
    const pos = place?.(f);
    if (!pos) continue;
    for (let y = pos.y; y < Math.min(GRID, pos.y + block); y++) {
      for (let x = pos.x; x < Math.min(GRID, pos.x + block); x++) {
        const p = base + (y * GRID + x) * 4;
        raw[p] = fg[0];
        raw[p + 1] = fg[1];
        raw[p + 2] = fg[2];
        raw[p + 3] = 255;
      }
    }
  }
  return raw;
}

test('backgroundVerdict diz POR QUE não recortou', () => {
  const flat = analyzeFrames(frames({ frames: 30, place: (f) => ({ x: 2 + f, y: 10 }) }), { sampleFps: 15 });
  const verdict = backgroundVerdict(flat, { start: 0, end: 29 });
  assert.equal(verdict.state, 'flat');
  assert.ok(verdict.cut, 'fundo liso devolve o corte');

  // Cenário: quatro cores nos cantos → fundo complexo.
  const busy = analyzeFrames(frames({ frames: 20, quadrants: true, place: () => ({ x: 12, y: 12 }) }), { sampleFps: 15 });
  assert.equal(backgroundVerdict(busy, { start: 0, end: 19 }).state, 'complex');

  // Câmera andando: a cor do anel muda entre quadros → complexo.
  const moving = analyzeFrames(
    frames({ frames: 30, place: (f) => ({ x: 2 + f, y: 10 }) }),
    { sampleFps: 15 }
  );
  for (let f = 0; f < 30; f++) {
    const base = f * GRID * GRID * 4;
    for (let i = 0; i < GRID * GRID; i++) moving.rgba[base + i * 4 + 2] = Math.min(255, 30 + f * 6);
  }
  assert.equal(backgroundVerdict(moving, { start: 0, end: 29 }).state, 'complex');

  // Fundo já transparente: não há o que recortar (e não pode chavear o preto).
  const alpha = analyzeFrames(frames({ frames: 20, place: () => ({ x: 8, y: 8 }), hideBg: true }), { sampleFps: 15 });
  assert.equal(backgroundVerdict(alpha, { start: 0, end: 19 }).state, 'transparent');

  // Sujeito sem contraste com o fundo (cenário chapado, sem assunto).
  const plain = analyzeFrames(frames({ frames: 20, block: 0, place: null, bg: [90, 90, 90] }), { sampleFps: 15 });
  assert.equal(backgroundVerdict(plain, { start: 0, end: 19 }).state, 'lowcontrast');
});

test('aiCutCouldHelp só manda para a IA o que a chave de cor não resolveu', () => {
  assert.equal(aiCutCouldHelp('complex'), true);
  assert.equal(aiCutCouldHelp('lowcontrast'), true);
  assert.equal(aiCutCouldHelp('flat'), false, 'fundo liso é resolvido de graça');
  assert.equal(aiCutCouldHelp('transparent'), false, 'já veio transparente');
  assert.equal(aiCutCouldHelp('off'), false);
  assert.equal(aiCutCouldHelp(undefined), false);
});

test('foto (um quadro só) vira plano estático e ainda recorta fundo liso', () => {
  const photo = analyzeFrames(frames({ frames: 1, block: 10, place: () => ({ x: 11, y: 11 }) }), {
    sampleFps: 15,
    width: 800,
    height: 800
  });
  assert.equal(photo.frameCount, 1);
  const plan = planSticker(photo, {});
  assert.equal(plan.mode, 'static');
  assert.equal(plan.stillMs, 0);
  assert.equal(plan.cutState, 'flat');
  assert.ok(plan.cut);
  assert.match(plan.reason, /foto/);

  // Foto de cenário: plano estático, mas sem corte e marcada como complexa.
  const busyPhoto = analyzeFrames(frames({ frames: 1, quadrants: true, place: () => ({ x: 12, y: 12 }) }), {
    sampleFps: 15,
    width: 800,
    height: 800
  });
  const busyPlan = planSticker(busyPhoto, {});
  assert.equal(busyPlan.mode, 'static');
  assert.equal(busyPlan.cut, null);
  assert.equal(busyPlan.cutState, 'complex');
  assert.equal(aiCutCouldHelp(busyPlan.cutState), true);
});

test('gating: IA automática exige provedor e permissão explícita', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicut-env-'));
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, '');
  process.env.NEXUS_ENV_FILE = envFile; // nada de .env real no meio do teste
  delete process.env.REMOVE_BG_URLS;
  process.env.LOCAL_REMBG = 'false';
  process.env.STICKER_AI_CUT = 'false';

  const { bgAvailable, bgAutoAllowed } = await import('../src/features/bgremoval.js');
  assert.equal(bgAvailable(), false, 'sem provedor configurado');
  assert.equal(bgAutoAllowed(), false, 'sem provedor não há recorte automático');
  assert.equal(bgAutoAllowed(), false, 'flag sozinha não inventa provedor');

  // rembg local: offline e de graça → pode rodar sozinho.
  process.env.LOCAL_REMBG = 'true';
  assert.equal(bgAvailable(), true);
  assert.equal(bgAutoAllowed(), true);
  process.env.LOCAL_REMBG = 'false';
});

test('fundo complexo: IA recorta a foto e o vídeo parado (endpoint falso)', { skip: !ffmpeg }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicut-'));
  const complex = path.join(dir, 'complexa.png');
  const flat = path.join(dir, 'lisa.png');
  const cut = path.join(dir, 'recortada.png');
  const video = path.join(dir, 'parado.mp4');

  // Foto com fundo de blocos coloridos (complexo) e um quadrado claro no meio.
  assert.equal(
    spawnSync('ffmpeg', [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=s=640x640:r=15:d=1',
      '-vf', "drawbox=x=220:y=220:w=200:h=200:color=0xf0f0f0:t=fill,scale=640:640",
      '-frames:v', '1', complex
    ]).status,
    0
  );
  assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-y', '-loop', '1', '-i', complex, '-t', '4', '-r', '15', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', video]).status, 0);

  // Foto com fundo LISO: o recorte sai de graça, sem tocar na IA.
  assert.equal(
    spawnSync('ffmpeg', [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=0x1e8c3c:s=640x640',
      '-vf', "drawbox=x=220:y=220:w=200:h=200:color=0xf0f0f0:t=fill",
      '-frames:v', '1', flat
    ]).status,
    0
  );

  // O que a "IA" devolve: o sujeito com fundo transparente.
  assert.equal(
    spawnSync('ffmpeg', [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=black@0:s=640x640,format=rgba',
      '-f', 'lavfi', '-i', 'color=c=0xf0f0f0:s=200x200',
      '-filter_complex', '[0][1]overlay=x=220:y=220',
      '-frames:v', '1', cut
    ]).status,
    0
  );

  let posts = 0;
  const server = http.createServer((req, res) => {
    if (req.method === 'POST') {
      posts++;
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ result: `http://127.0.0.1:${server.address().port}/cut.png` }));
      });
      return;
    }
    if (req.url === '/cut.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(fs.readFileSync(cut));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    // O pool é montado no import do módulo, então o endpoint falso entra nele
    // direto (mesmo lugar de onde o remove.bg/endpoints reais sairiam).
    const { bgAvailable, bgAutoAllowed, bgPools } = await import('../src/features/bgremoval.js');
    const { makeSticker } = await import('../src/features/sticker.js');
    const { alphaCoverage } = await import('../src/util/ffmpeg.js');
    bgPools().endpoints.items.push(`http://127.0.0.1:${server.address().port}/removebg`);
    assert.equal(bgAvailable(), true, 'endpoint configurado');

    const sticker = async (file, type, mime) =>
      makeSticker(
        { buffer: fs.readFileSync(file), type, node: { mimetype: mime } },
        { pack: 'MontxBOT', author: 'montx', onProgress: async () => {} }
      );

    // Sem a flag, a IA não é chamada: a figurinha sai com o fundo intacto.
    process.env.STICKER_AI_CUT = '';
    assert.equal(bgAutoAllowed(), false);
    const semIa = await sticker(complex, 'image', 'image/png');
    assert.equal(posts, 0, 'não pode chamar a IA sem permissão');
    assert.ok((await alphaCoverage(semIa)) > 0.9, 'fundo preservado');

    // Com a flag, a foto e o vídeo parado passam pela IA e saem recortados.
    process.env.STICKER_AI_CUT = '1';
    assert.equal(bgAutoAllowed(), true);
    const comIa = await sticker(complex, 'image', 'image/png');
    assert.equal(posts, 1, 'uma chamada por figurinha parada');
    const alfaFoto = await alphaCoverage(comIa);
    assert.ok(alfaFoto > 0.04 && alfaFoto < 0.6, `sujeito visível e fundo fora (alfa ${alfaFoto})`);

    const comIaVideo = await sticker(video, 'video', 'video/mp4');
    assert.equal(posts, 2, 'vídeo parado também passa pela IA (um quadro só)');
    const alfaVideo = await alphaCoverage(comIaVideo);
    assert.ok(alfaVideo > 0.04 && alfaVideo < 0.6, `alfa do vídeo: ${alfaVideo}`);

    // Fundo liso continua resolvido sem IA nenhuma (nem com a flag ligada).
    const lisa = await sticker(flat, 'image', 'image/png');
    assert.equal(posts, 2, 'fundo liso não gasta chamada de IA');
    const alfaLisa = await alphaCoverage(lisa);
    assert.ok(alfaLisa > 0.02 && alfaLisa < 0.5, `fundo liso recortado de graça (alfa ${alfaLisa})`);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
