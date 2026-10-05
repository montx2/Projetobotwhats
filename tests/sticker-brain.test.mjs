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
  backgroundCut,
  activityBox,
  bestStillFrame,
  chooseLoop,
  chooseWindows,
  cropPixels,
  deadLeadFrames,
  framesForQualityFloor,
  isStaticWindow,
  parseSourceMeta,
  planSchedule,
  planSticker,
  predictQuality,
  qualityFloorFor,
  shrinkSchedule,
  subjectBox,
  targetFpsFor,
  windowMotion
} from '../src/util/stickerbrain.js';
import { buildStickerFilter, selectExpression, toStickerWebp } from '../src/util/ffmpeg.js';
import { isAnimatedWebp, parseWebp, webpDurationMs } from '../src/util/webp.js';

/**
 * Vídeo sintético em RGBA: fundo de uma cor e um bloco de outra que se move.
 * `place(frame)` devolve {x, y} do bloco no quadro (índices de célula).
 * Cores podem ser números (cinza) ou [r, g, b].
 */
const rgb = (v) => (Array.isArray(v) ? v : [v, v, v]);
function synthVideo({ frames, place = null, block = 8, bg = 40, fg = 220 }) {
  const [br, bgc, bb] = rgb(bg);
  const [fr, fgc, fb] = rgb(fg);
  const raw = Buffer.alloc(frames * GRID * GRID * 4);
  for (let f = 0; f < frames; f++) {
    const base = f * GRID * GRID * 4;
    for (let i = 0; i < GRID * GRID; i++) {
      raw[base + i * 4] = br;
      raw[base + i * 4 + 1] = bgc;
      raw[base + i * 4 + 2] = bb;
      raw[base + i * 4 + 3] = 255;
    }
    const pos = place?.(f);
    if (!pos) continue;
    for (let y = pos.y; y < Math.min(GRID, pos.y + block); y++) {
      for (let x = pos.x; x < Math.min(GRID, pos.x + block); x++) {
        const p = base + (y * GRID + x) * 4;
        raw[p] = fr;
        raw[p + 1] = fgc;
        raw[p + 2] = fb;
        raw[p + 3] = 255;
      }
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
  assert.equal(meta.rotation, 0);
  assert.equal(meta.durationMs, 14_030);
  assert.equal(meta.durationKnown, true);
  assert.deepEqual(parseSourceMeta('nada'), {
    width: 0,
    height: 0,
    rotation: 0,
    durationMs: 0,
    durationKnown: false
  });
});

test('parseSourceMeta troca as dimensões em vídeo rotacionado (celular em pé)', () => {
  // stderr real do FFmpeg 7 com um MP4 de celular: codificado 1280x720 com
  // matriz de exibição -90°, e o FFmpeg autorrota para 720x1280 na decodificação.
  const rotated = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'VID_20260101.mp4':
  Duration: 00:00:08.00, start: 0.000000, bitrate: 1500 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 1280x720 [SAR 1:1 DAR 16:9], 30 fps
    Side data:
      displaymatrix: rotation of -90.00 degrees
        displaymatrix: rotation of -0.00 degrees
`;
  const meta = parseSourceMeta(rotated);
  assert.equal(meta.rotation, -90);
  assert.equal(meta.width, 720, 'o quadro decodificado é 720 de largura');
  assert.equal(meta.height, 1280);

  // Metadados antigos ('rotate: 90') também contam.
  const legacy = '  Duration: 00:00:05.00, start: 0.0\n  Stream #0:0: Video: h264, yuv420p, 1920x1080, 25 fps\n    rotate          : 90\n';
  const legacyMeta = parseSourceMeta(legacy);
  assert.equal(legacyMeta.rotation, 90);
  assert.equal(legacyMeta.width, 1080);
  assert.equal(legacyMeta.height, 1920);

  // E o crop calculado com essas dimensões precisa caber no quadro de verdade.
  const analysis = analyzeFrames(synthVideo({ frames: 60, place: (f) => ({ x: 2 + (f % 6), y: 24 }) }), {
    sampleFps: 15,
    width: meta.width,
    height: meta.height
  });
  const crop = cropPixels(activityBox(analysis, { start: 0, end: 59 }), meta.width, meta.height);
  assert.ok(crop, 'deve enquadrar o assunto');
  assert.ok(crop.x + crop.w <= 720 && crop.y + crop.h <= 1280, 'crop dentro do quadro rotacionado');
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

test('deadLeadFrames poda abertura preta e respeita o teto de 40%', () => {
  // 30 quadros pretos + 60 quadros de bloco em movimento.
  const frames = 90;
  const raw = Buffer.alloc(frames * GRID * GRID * 4, 0);
  for (let f = 0; f < frames; f++) {
    const base = f * GRID * GRID * 4;
    const level = f < 30 ? 0 : 40;
    for (let i = 0; i < GRID * GRID; i++) {
      raw[base + i * 4] = level;
      raw[base + i * 4 + 1] = level;
      raw[base + i * 4 + 2] = level;
      raw[base + i * 4 + 3] = 255;
    }
    if (f < 30) continue;
    const x = 2 + ((f - 30) % 12);
    for (let y = 12; y < 20; y++) {
      for (let px = x; px < x + 8; px++) {
        const q = base + (y * GRID + px) * 4;
        raw[q] = 220;
        raw[q + 1] = 220;
        raw[q + 2] = 220;
      }
    }
  }
  const analysis = analyzeFrames(raw, { sampleFps: 15, width: 720, height: 1280 });
  assert.equal(deadLeadFrames(analysis, { start: 0, end: 89 }), 30);

  // Vídeo curto com abertura morta: a janela escolhida pula o preto.
  const windows = chooseWindows(analysis, { maxSeconds: 10, limit: 3 });
  assert.ok(windows[0].start >= 28, `começou em ${windows[0].start} (o preto foi deixado de fora)`);
  assert.equal(windows[0].end, 89, 'o resto da duração é preservado');

  // Sem abertura morta, nada é podado.
  const clean = analyzeFrames(synthVideo({ frames: 60, place: (f) => ({ x: 2 + (f % 8), y: 12 }) }), {
    sampleFps: 15,
    width: 720,
    height: 1280
  });
  assert.equal(deadLeadFrames(clean, { start: 0, end: 59 }), 0);
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

test('backgroundCut acha o fundo liso e recusa cenário', () => {
  // Fundo azul chapado + sujeito que anda: o fundo é recortável.
  const flat = analyzeFrames(
    synthVideo({ frames: 60, place: (f) => ({ x: 4 + (f % 8), y: 10 }), bg: [30, 60, 140], fg: [235, 235, 235] }),
    { sampleFps: 15, width: 720, height: 1280 }
  );
  const cut = backgroundCut(flat, { start: 0, end: 59 });
  assert.ok(cut, 'fundo liso deve ser detectado');
  assert.ok(Math.abs(cut.color.r - 30) <= 2 && Math.abs(cut.color.g - 60) <= 2 && Math.abs(cut.color.b - 140) <= 2);
  assert.ok(cut.coverage > 0.8, `cobertura: ${cut.coverage}`);
  assert.ok(cut.similarity > 0 && cut.similarity <= 0.32);

  // Cenário: cada canto de uma cor → não recorta (melhor intacto que errado).
  const busy = analyzeFrames(
    synthVideo({ frames: 30, place: null, bg: 40, fg: 40 }),
    { sampleFps: 15 }
  );
  for (let f = 0; f < 30; f++) {
    const base = f * GRID * GRID * 4;
    const paint = (x0, y0, c) => {
      for (let y = y0; y < y0 + 8; y++) {
        for (let x = x0; x < x0 + 8; x++) {
          const p = base + (y * GRID + x) * 4;
          busy.rgba[p] = c[0];
          busy.rgba[p + 1] = c[1];
          busy.rgba[p + 2] = c[2];
        }
      }
    };
    paint(0, 0, [200, 30, 30]);
    paint(24, 0, [30, 200, 30]);
    paint(0, 24, [30, 30, 200]);
    paint(24, 24, [220, 210, 30]);
  }
  assert.equal(backgroundCut(busy, { start: 0, end: 29 }), null);
});

test('recorte: aguenta sujeito encostando na borda e respeita alfa existente', () => {
  // Bloco grande que às vezes cobre um canto: o anel ainda mostra o fundo.
  const raw = synthVideo({
    frames: 60,
    block: 16,
    bg: [25, 110, 70],
    fg: [245, 245, 245],
    place: (f) => (f % 2 ? { x: 0, y: 0 } : { x: 8, y: 8 })
  });
  const analysis = analyzeFrames(raw, { sampleFps: 15, width: 1280, height: 1280 });
  const cut = backgroundCut(analysis, { start: 0, end: 59 });
  assert.ok(cut, 'sujeito na borda não pode derrubar o recorte');
  assert.ok(cut.coverage > 0.3 && cut.contrast > 0.15);

  // Figurinha que já veio transparente (PNG/GIF com alfa): não recorta de novo.
  const transparent = Buffer.from(raw);
  for (let i = 0; i < transparent.length; i += 4) {
    if (Math.abs(transparent[i] - 25) <= 6 && Math.abs(transparent[i + 1] - 110) <= 6) transparent[i + 3] = 0;
  }
  const already = analyzeFrames(transparent, { sampleFps: 15 });
  assert.equal(backgroundCut(already, { start: 0, end: 59 }), null);
});

test('fundo liso também enquadra o sujeito (sem esticar demais)', () => {
  // Sujeito grande (metade do quadro) sobre fundo chapado numa fonte 1280².
  const analysis = analyzeFrames(
    synthVideo({ frames: 60, place: (f) => ({ x: 8, y: 8 + (f % 3) }), block: 16, bg: [20, 90, 60], fg: [240, 210, 120] }),
    { sampleFps: 15, width: 1280, height: 1280 }
  );
  const cut = backgroundCut(analysis, { start: 0, end: 59 });
  assert.ok(cut, 'fundo chapado detectado');
  const box = subjectBox(analysis, cut, { start: 0, end: 59 });
  assert.ok(box && box.w > 0.4 && box.w <= 1, `caixa do sujeito: ${JSON.stringify(box)}`);
  const plan = planSticker(analysis, { maxSeconds: 10 });
  assert.equal(plan.mode, 'animated');
  assert.ok(plan.cut, 'o plano leva o corte para o FFmpeg');
  assert.ok(plan.crop, 'enquadra o sujeito quando o recorte não estica');
  assert.ok(plan.crop.w >= 384 && plan.crop.w < 1280, `lado: ${plan.crop.w}`);
  assert.equal(plan.crop.w, plan.crop.h);

  // Fonte pequena: enquadrar esticaria → mantém o quadro inteiro, só com o corte.
  const small = analyzeFrames(
    synthVideo({ frames: 60, place: () => ({ x: 8, y: 8 }), block: 16, bg: [20, 90, 60], fg: [240, 210, 120] }),
    { sampleFps: 15, width: 360, height: 360 }
  );
  const smallPlan = planSticker(small, { maxSeconds: 10 });
  assert.ok(smallPlan.cut, 'fundo liso continua recortado');
  assert.equal(smallPlan.crop, null, 'sem upscale feio');
});

test('equilíbrio automático: ação vira fluidez, calma vira nitidez', () => {
  assert.equal(qualityFloorFor(0), 50);
  assert.equal(qualityFloorFor(0.02), 38);
  assert.equal(qualityFloorFor(0.045), 22);
  assert.equal(qualityFloorFor(1), 22);

  const action = planSticker(
    analyzeFrames(synthVideo({ frames: 120, place: (f) => ({ x: 2 + ((f * 5) % 22), y: 12 }) }), { sampleFps: 15 }),
    {}
  );
  const calm = planSticker(
    analyzeFrames(synthVideo({ frames: 120, place: () => ({ x: 8, y: 8 }) }), { sampleFps: 15 }),
    {}
  );
  assert.equal(action.qualityFloor, 22, 'muito movimento → aceita q menor por mais fluidez');
  assert.ok(calm.qualityFloor >= 40, `pouca ação → nitidez (piso ${calm.qualityFloor})`);
});

test('modos do usuário: liso rende fluidez, nítido rende qualidade', () => {
  // Vídeo calmo: o automático já prefere nitidez; os modos forçam os extremos.
  const calm = analyzeFrames(synthVideo({ frames: 120, place: (f) => ({ x: 8 + (f % 3), y: 10 }) }), {
    sampleFps: 15,
    width: 1280,
    height: 720
  });
  const auto = planSticker(calm, {});
  const smooth = planSticker(calm, { prefer: 'smooth' });
  const sharp = planSticker(calm, { prefer: 'sharp' });
  assert.equal(smooth.targetFps, 15, 'liso usa o teto de fps');
  assert.equal(smooth.qualityFloor, 22, 'liso aceita qualidade menor para ter mais quadros');
  assert.ok(sharp.targetFps <= 8, `nítido reduz quadros (${sharp.targetFps})`);
  assert.ok(sharp.qualityFloor >= 62, `nítido exige qualidade (${sharp.qualityFloor})`);
  assert.ok(sharp.qualityFloor > auto.qualityFloor);
  assert.ok(smooth.schedule.length >= sharp.schedule.length, 'liso guarda mais quadros que nítido');
  assert.equal(planSticker(calm, { prefer: 'inventado' }).prefer, 'auto', 'modo inválido cai no automático');
});

test('buildStickerFilter aplica o colorkey do fundo antes da escala', () => {
  const cut = { color: { r: 30, g: 60, b: 140 }, similarity: 0.15, coverage: 0.9, contrast: 0.3 };
  const vf = buildStickerFilter({ animated: true, fps: 15, fit: 'fill', crop: null, select: null, cut });
  assert.match(vf, /colorkey=0x1e3c8c:0\.15:0\.1/, vf);
  assert.ok(vf.indexOf('colorkey') < vf.indexOf('scale=512'), 'recorte antes da escala');
  const plain = buildStickerFilter({ animated: true, fps: 15, fit: 'fill' });
  assert.ok(!plain.includes('colorkey'));
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
