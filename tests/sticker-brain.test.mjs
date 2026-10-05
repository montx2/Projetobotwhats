// Motor inteligente de figurinha: análise, escolha de trecho, loop, crop,
// agendamento por movimento e orçamento de 500 KB.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  GRID,
  analyzeFrames,
  activityBox,
  bestStillFrame,
  chooseLoop,
  chooseWindows,
  cropPixels,
  framesForQualityFloor,
  isStaticWindow,
  parseSourceMeta,
  planSchedule,
  planSticker,
  predictQuality,
  shrinkSchedule,
  targetFpsFor,
  windowMotion
} from '../src/util/stickerbrain.js';
import { selectExpression, toStickerWebp } from '../src/util/ffmpeg.js';
import { isAnimatedWebp, parseWebp, webpDurationMs } from '../src/util/webp.js';

/**
 * Vídeo sintético: fundo cinza e um bloco claro de `block` pixels que se move.
 * `place(frame)` devolve {x, y} do bloco no quadro (índices de célula).
 */
function synthVideo({ frames, place = null, block = 8, bg = 40, fg = 220 }) {
  const raw = Buffer.alloc(frames * GRID * GRID, bg);
  for (let f = 0; f < frames; f++) {
    const pos = place?.(f);
    if (!pos) continue;
    const base = f * GRID * GRID;
    for (let y = pos.y; y < Math.min(GRID, pos.y + block); y++) {
      for (let x = pos.x; x < Math.min(GRID, pos.x + block); x++) raw[base + y * GRID + x] = fg;
    }
  }
  return raw;
}

test('parseSourceMeta lê tamanho e duração do stderr do FFmpeg', () => {
  const stderr = `ffmpeg version 7.0.2\n  Duration: 00:00:14.03, start: 0.000000, bitrate: 512 kb/s\n` +
    `  Stream #0:0(und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 720x1280 [SAR 1:1 DAR 9:16], 30 fps\n`;
  const meta = parseSourceMeta(stderr);
  assert.equal(meta.width, 720);
  assert.equal(meta.height, 1280);
  assert.equal(meta.durationMs, 14_030);
  assert.equal(meta.durationKnown, true);
  assert.deepEqual(parseSourceMeta('nada'), { width: 0, height: 0, durationMs: 0, durationKnown: false });
});

test('analyzeFrames mede movimento e brilho quadro a quadro', () => {
  const still = analyzeFrames(synthVideo({ frames: 20, place: () => ({ x: 4, y: 4 }) }), { sampleFps: 15 });
  assert.equal(still.frameCount, 20);
  assert.equal(still.deltas[1], 0);
  assert.ok(windowMotion(still, 0, 19) === 0);
  assert.equal(isStaticWindow(still, 0, 19), true);

  const moving = analyzeFrames(
    synthVideo({ frames: 20, place: (f) => ({ x: 2 + f, y: 10 }) }),
    { sampleFps: 15 }
  );
  assert.ok(moving.deltas[1] > 0.01, `movimento detectado (${moving.deltas[1]})`);
  assert.equal(isStaticWindow(moving, 0, 19), false);
  // Quadros sem relação retornam null (não dá para decidir nada).
  assert.equal(analyzeFrames(Buffer.alloc(GRID * GRID), { sampleFps: 15 }), null);
});

test('chooseWindows prefere o trecho com mais ação, não o começo', () => {
  // Primeira metade parada; segunda metade com o bloco andando a cada quadro.
  const raw = synthVideo({
    frames: 200, // 13,3 s
    place: (f) => (f < 100 ? { x: 12, y: 12 } : { x: 2 + ((f - 100) % 20), y: 20 })
  });
  const analysis = analyzeFrames(raw, { sampleFps: 15, width: 720, height: 1280 });
  const best = chooseWindows(analysis, { maxSeconds: 10, limit: 3 })[0];
  assert.ok(best.start >= 10, `janela escolhida começou em ${best.start} (esperado longe do início)`);
  assert.equal(best.end - best.start + 1, 150);
  assert.ok(windowMotion(analysis, best.start, best.end) > windowMotion(analysis, 0, 149));
});

test('chooseLoop fecha o loop num ponto em que o quadro final parece o inicial', () => {
  // Bloco indo e voltando num ciclo curto: os quadros múltiplos do período
  // repetem a posição do primeiro, então existe emenda perfeita a poucos
  // quadros do fim (é isso que o chooseLoop procura).
  const period = 5;
  const raw = synthVideo({ frames: 300, place: (f) => ({ x: 2 + 2 * (f % period), y: 8 }) });
  const analysis = analyzeFrames(raw, { sampleFps: 15, width: 720, height: 1280 });
  const loop = chooseLoop(analysis, { maxSeconds: 10 });
  assert.ok(loop.end - loop.start + 1 < 150, 'pode encurtar o fim para fechar o loop');
  const seam = analysis.signatures;
  const first = loop.start * 64;
  const last = loop.end * 64;
  let diff = 0;
  for (let i = 0; i < 64; i++) diff += Math.abs(seam[first + i] - seam[last + i]);
  assert.ok(diff / 64 / 255 < 0.02, `emenda suave (${diff / 64 / 255})`);
});

test('planSchedule guarda mais quadros onde há movimento', () => {
  // 4 s parados seguidos de 2 s de ação: a ação precisa de mais quadros.
  const raw = synthVideo({
    frames: 90,
    place: (f) => (f < 60 ? { x: 12, y: 12 } : { x: 2 + ((f - 60) % 18), y: 20 })
  });
  const analysis = analyzeFrames(raw, { sampleFps: 15, width: 720, height: 1280 });
  const kept = planSchedule(analysis, { start: 0, end: 89, targetFrames: 40 });
  assert.equal(kept[0], 0);
  assert.equal(kept[kept.length - 1], 89);
  const calm = kept.filter((i) => i < 60).length;
  const action = kept.filter((i) => i >= 60).length;
  assert.ok(action > calm / 2, `ação guardou ${action} quadros, calmaria ${calm}`);
  // Nenhum buraco maior que 250 ms (o movimento entre quadros fica suave).
  for (let i = 1; i < kept.length; i++) {
    assert.ok(kept[i] - kept[i - 1] <= 4, `buraco de ${kept[i] - kept[i - 1]} quadros`);
  }
});

test('activityBox + cropPixels enquadram o assunto num quadrado', () => {
  const raw = synthVideo({ frames: 60, place: (f) => ({ x: 2 + (f % 6), y: 12 }) });
  const analysis = analyzeFrames(raw, { sampleFps: 15, width: 720, height: 720 });
  const box = activityBox(analysis, { start: 0, end: 59 });
  assert.ok(box.cx < 0.5, `atividade à esquerda (cx=${box.cx.toFixed(2)})`);
  const crop = cropPixels(box, 720, 720);
  assert.ok(crop, 'deve recortar quando o assunto ocupa uma parte do quadro');
  assert.equal(crop.w, crop.h, 'crop quadrado não distorce');
  assert.ok(crop.w >= 0.55 * 720 && crop.w < 0.9 * 720, `lado do crop: ${crop?.w}`);
  assert.ok(crop.x >= 0 && crop.x + crop.w <= 720);
  assert.ok(crop.y >= 0 && crop.y + crop.h <= 720);
  // Assunto ocupando o quadro inteiro: não há o que recortar.
  assert.equal(cropPixels({ cx: 0.5, cy: 0.5, w: 1, h: 1 }, 720, 720), null);
  // Sujeito pequeno e no canto: o crop gruda na borda sem sair do quadro.
  const corner = cropPixels({ cx: 0.02, cy: 0.02, w: 0.1, h: 0.1 }, 720, 720);
  assert.deepEqual(corner, { x: 0, y: 0, w: 396, h: 396 });
});

test('predictQuality acha a qualidade pelo modelo ln(bytes) ≈ a + b·q', () => {
  // Modelo conhecido: bytes = e^(9 + 0.013q)
  const bytes = (q) => Math.exp(9 + 0.013 * q);
  const samples = [{ q: 20, bytes: bytes(20) }, { q: 60, bytes: bytes(60) }];
  const q = predictQuality(samples, bytes(45));
  assert.ok(Math.abs(q - 45) <= 2, `previu q=${q} para o alvo de q=45`);
  // Mais qualidade pedida = q maior; limites respeitados.
  assert.ok(predictQuality(samples, bytes(80)) > predictQuality(samples, bytes(30)));
  assert.equal(predictQuality(samples, 1e12), 82);
  assert.equal(predictQuality(samples, 1), 8);
  // Com uma medição só, usa a inclinação padrão do libwebp (≈0,013).
  const one = predictQuality([{ q: 40, bytes: 100_000 }], 200_000);
  assert.ok(one > 40 && one < 100, `subiu a qualidade (${one})`);

  // Normalizado por quadro: medindo 100 quadros e mirando um total para 30, a
  // previsão continua valendo (é assim que o motor corta quadros sem perder o
  // que aprendeu sobre o arquivo).
  const perFrame = [{ q: 20, bytesPerFrame: bytes(20) / 100 }, { q: 60, bytesPerFrame: bytes(60) / 100 }];
  const target30 = 30 * (bytes(45) / 100);
  assert.equal(predictQuality(perFrame, target30 / 30, { sizeKey: 'bytesPerFrame' }), 45);
});

test('framesForQualityFloor e shrinkSchedule usam os quadros como alavanca grossa', () => {
  // 100 quadros custando 1 MB em q=75: no piso (22) cada quadro fica ~2× menor,
  // então o orçamento de 500 KB compra ~92 quadros.
  const fits = framesForQualityFloor({ frames: 100, bytes: 1_000_000, q: 75, budgetBytes: 500_000 });
  assert.ok(fits > 60 && fits < 100, `quadros que cabem no piso: ${fits}`);
  // Piso mais alto (qualidade melhor) compra menos quadros.
  assert.ok(
    framesForQualityFloor({ frames: 100, bytes: 1_000_000, q: 75, floor: 40, budgetBytes: 500_000 }) < fits
  );
  assert.equal(framesForQualityFloor({ frames: 100, bytes: 1_000_000, q: 75, budgetBytes: 5_000_000 }), 100);
  assert.equal(framesForQualityFloor({ frames: 0, bytes: 0, q: 50, budgetBytes: 500_000 }), 0);

  const plan = { start: 0, end: 149, schedule: Array.from({ length: 100 }, (_, i) => i) };
  const shrunk = shrinkSchedule(plan, 40);
  assert.ok(shrunk.length <= 42 && shrunk.length >= 2, `reduziu para ${shrunk.length}`);
  assert.equal(shrunk[0], 0);
  assert.equal(shrunk[shrunk.length - 1], 99);
});

test('targetFpsFor vai de 6 fps (parado) a 15 fps (ação)', () => {
  assert.equal(targetFpsFor(0), 6);
  assert.equal(targetFpsFor(0.01), 8);
  assert.equal(targetFpsFor(0.05), 15);
  assert.equal(targetFpsFor(1), 15);
});

test('bestStillFrame evita abrir num quadro preto', () => {
  const raw = synthVideo({
    frames: 30,
    place: (f) => (f < 5 ? null : { x: 4 + (f % 10), y: 12 }) // 5 quadros pretos no começo
  });
  const analysis = analyzeFrames(raw, { sampleFps: 15, width: 720, height: 1280 });
  const still = bestStillFrame(analysis, 0, 29);
  assert.ok(still >= 5, `escolheu o quadro ${still} (evitou o fade preto)`);
});

test('planSticker decide animada x parada e monta o plano', () => {
  const moving = analyzeFrames(
    synthVideo({ frames: 180, place: (f) => ({ x: 2 + ((f * 3) % 24), y: 10 }) }),
    { sampleFps: 15, width: 720, height: 1280 }
  );
  const plan = planSticker(moving, { maxSeconds: 10, budgetBytes: 480 * 1024 });
  assert.equal(plan.mode, 'animated');
  assert.ok(plan.durationMs <= 10_000);
  assert.ok(plan.schedule.length >= 2);
  assert.equal(plan.schedule[0], 0);
  assert.equal(plan.schedule[plan.schedule.length - 1], plan.end - plan.start);
  assert.ok(plan.targetFps >= 6 && plan.targetFps <= 15);
  assert.ok(plan.crop === null || (plan.crop.w === plan.crop.h && plan.crop.w > 0));

  const stillPlan = planSticker(analyzeFrames(synthVideo({ frames: 60, place: () => ({ x: 8, y: 8 }) }), { sampleFps: 15, width: 720, height: 1280 }));
  assert.equal(stillPlan.mode, 'static');
  assert.equal(stillPlan.schedule.length, 1);
  assert.equal(stillPlan.crop, null);
  assert.match(stillPlan.reason, /não se mexe/);
  assert.equal(planSticker(null), null);
});

test('selectExpression compacta quadros consecutivos em faixas', () => {
  assert.equal(selectExpression([0, 1, 2, 3, 5, 7, 8]), 'between(n\\,0\\,3)+eq(n\\,5)+between(n\\,7\\,8)');
  assert.equal(selectExpression([4]), 'eq(n\\,4)');
  assert.equal(selectExpression([3, 1, 1, 2]), 'between(n\\,1\\,3)');
});

const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
test('motor inteligente converte vídeo de verdade (janela, loop e orçamento)', { skip: !ffmpeg }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-'));
  const src = path.join(dir, 'v.mp4');
  // 14 s: bloco laranja passeando sobre fundo escuro (720x1280).
  const built = spawnSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=0x102040:size=720x1280:rate=30:duration=14',
    '-f', 'lavfi', '-i', 'color=c=0xff8c00:size=240x240:rate=30:duration=14',
    '-filter_complex',
    "[1:v]format=rgba[box];[0:v][box]overlay=x='120+320*sin(2*PI*t/2.8)':y='420+240*cos(2*PI*t/2.2)'",
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-crf', '20', src
  ]);
  assert.equal(built.status, 0, 'ffmpeg precisa gerar o vídeo de teste');

  const { buffer, smart } = await toStickerWebp(fs.readFileSync(src), { animated: true, ext: '.mp4' });
  const info = parseWebp(buffer);
  assert.equal(smart?.mode, 'animated', 'vídeo com movimento continua animado');
  assert.equal(info.width, 512);
  assert.equal(info.height, 512);
  const seconds = webpDurationMs(buffer) / 1000;
  assert.ok(seconds > 9 && seconds <= 10, `duração ${seconds}s`);
  assert.ok(buffer.length <= 500 * 1024, `${Math.round(buffer.length / 1024)} KB`);
  assert.ok(smart.framesKept && smart.framesKept >= 8, `quadros guardados: ${smart.framesKept}`);
  assert.ok(smart.probes >= 1 && smart.probes <= 4, `sondas: ${smart.probes}`);
  assert.ok(smart.startSeconds >= 0);

  // Vídeo parado (uma foto repetida) vira figurinha PARADA.
  const still = path.join(dir, 'still.mp4');
  spawnSync('ffmpeg', [
    '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=15:duration=3',
    '-frames:v', '1', path.join(dir, 'foto.png')
  ]);
  spawnSync('ffmpeg', [
    '-y', '-loglevel', 'error', '-loop', '1', '-i', path.join(dir, 'foto.png'), '-t', '3',
    '-r', '15', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-crf', '20', still
  ]);
  const stillOut = await toStickerWebp(fs.readFileSync(still), { animated: true, ext: '.mp4' });
  assert.equal(stillOut.smart?.mode, 'static');
  assert.equal(isAnimatedWebp(stillOut.buffer), false);
  assert.equal(parseWebp(stillOut.buffer).width, 512);

  fs.rmSync(dir, { recursive: true, force: true });
});
