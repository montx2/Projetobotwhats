// 🧠 MOTOR INTELIGENTE DE FIGURINHA — o "cérebro" que decide o que cortar,
// enquadrar e comprimir ANTES de o FFmpeg encodar. É o que os grandes apps de
// figurinha fazem: em vez de encodar às cegas numa escada de qualidade, o vídeo
// é primeiro analisado em quadros minúsculos (32×32 em cinza, ~0,1 s de FFmpeg)
// e o plano sai dessa análise.
//
//   1. MELHOR TRECHO — vídeo com mais de 10 s: escolhe a janela com mais
//      movimento e emenda de loop mais suave (nem sempre é o começo).
//   2. LOOP FECHADO — encurta o fim da janela (até 0,4 s) no ponto em que o
//      último quadro mais se parece com o primeiro, para o loop não "pular".
//   3. ENQUADRAMENTO DO ASSUNTO — a área que se mexe delimita um crop quadrado,
//      então o sujeito aparece grande na figurinha (nunca menos que 55% do lado
//      menor, para não virar zoom exagerado).
//   4. QUADROS POR MOVIMENTO — o WebP animado aceita quadros com durações
//      diferentes: trecho parado fica com menos quadros (cada um durando mais)
//      e trecho de ação com mais (até 15 fps; nunca menos que ~4 fps).
//   5. ORÇAMENTO DE 500 KB — bytes ≈ e^(a + b·q), modelo ajustado com as
//      medições do próprio arquivo: o número de quadros é a alavanca grossa e a
//      qualidade (q do libwebp) é o ajuste fino.
//   6. VÍDEO SEM MOVIMENTO — vira figurinha PARADA em alta qualidade: menor,
//      mais nítida e sem o "pisca" de uma animação que não anima nada.
//
// Este módulo é offline/determinístico: as decisões não conhecem rede nem
// WhatsApp, o que as deixa testáveis sem FFmpeg.

import { spawn } from 'node:child_process';

/** Grade da análise (resolução dos quadros minúsculos). */
export const GRID = 32;
/** Assinatura de cada quadro: grade reduzida para comparar quadros distantes. */
export const SIG = 8;
/** Taxa da grade analisada/planejada (também o teto de FPS da figurinha). */
export const SAMPLE_FPS = 15;
/** Teto de vídeo analisado: em vídeo longo vira o teto do trecho (e do custo no celular). */
export const ANALYSIS_MAX_SECONDS = 60;
/** Inclinação padrão do modelo ln(bytes) ≈ a + b·q (medida no libwebp). */
export const QUALITY_SLOPE = 0.013;
/** Percentual do orçamento em que a sonda já é considerada "boa o bastante". */
export const GOOD_FIT_RATIO = 0.75;
/** Movimento (diferença média por quadro) abaixo disto = vídeo praticamente parado. */
export const STATIC_MEDIAN_DELTA = 0.0015;
export const STATIC_MAX_DELTA = 0.01;
/** Lado mínimo do crop automático, em fração do lado menor do vídeo. */
export const MIN_CROP_RATIO = 0.55;
/** A partir desta fração do lado menor o crop não compensa (o vídeo já é o assunto). */
export const CROP_SKIP_RATIO = 0.9;

// ── Análise ────────────────────────────────────────────────────────────────

/**
 * Lê largura/altura/duração do stderr do FFmpeg (funciona sem ffprobe).
 * @param {string} stderr saída de erro do `ffmpeg -i`
 */
export function parseSourceMeta(stderr) {
  const text = String(stderr || '');
  const size = /Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b/.exec(text);
  const duration = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(text);
  let durationMs = 0;
  if (duration) {
    durationMs = Math.round(
      (Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])) * 1000
    );
  }
  return {
    width: size ? Number(size[1]) : 0,
    height: size ? Number(size[2]) : 0,
    durationMs,
    durationKnown: Boolean(duration) && durationMs > 0
  };
}

/**
 * Transforma os quadros crus (32×32 cinza) na análise que o plano consome:
 * movimento entre quadros, brilho, assinaturas 8×8 e os quadros originais
 * (usados para a área de atividade e para escolher o quadro da figurinha parada).
 *
 * @param {Buffer} raw GRID*GRID bytes por quadro, em cinza
 * @param {{width?: number, height?: number, durationMs?: number, sampleFps?: number}} [meta]
 */
export function analyzeFrames(raw, { width = 0, height = 0, durationMs = 0, sampleFps = SAMPLE_FPS } = {}) {
  const cell = GRID * GRID;
  const frameCount = Math.floor(raw.length / cell);
  if (frameCount < 2) return null;

  const deltas = new Float32Array(frameCount);
  const brightness = new Float32Array(frameCount);
  const sigSize = SIG * SIG;
  const signatures = new Uint8Array(frameCount * sigSize);
  const pool = GRID / SIG;
  const poolCells = pool * pool;

  for (let f = 0; f < frameCount; f++) {
    const base = f * cell;
    let luma = 0;
    for (let i = 0; i < cell; i++) luma += raw[base + i];
    brightness[f] = luma / cell / 255;

    if (f > 0) {
      let diff = 0;
      const prev = base - cell;
      for (let i = 0; i < cell; i++) diff += Math.abs(raw[base + i] - raw[prev + i]);
      deltas[f] = diff / cell / 255;
    }

    // Assinatura 8×8: média de cada bloco 4×4 (barata e robusta a ruído).
    const sigBase = f * sigSize;
    for (let sy = 0; sy < SIG; sy++) {
      for (let sx = 0; sx < SIG; sx++) {
        let sum = 0;
        for (let y = 0; y < pool; y++) {
          const row = (sy * pool + y) * GRID + sx * pool;
          for (let x = 0; x < pool; x++) sum += raw[base + row + x];
        }
        signatures[sigBase + sy * SIG + sx] = Math.round(sum / poolCells);
      }
    }
  }

  const seconds = frameCount / sampleFps;
  return {
    sampleFps,
    frameCount,
    durationMs: durationMs || Math.round(seconds * 1000),
    analyzedMs: Math.round(seconds * 1000),
    width,
    height,
    deltas,
    brightness,
    signatures,
    gray: raw,
    grid: GRID,
    cell
  };
}

/** Diferença média entre as assinaturas de dois quadros (0..1). */
export function signatureDistance(analysis, a, b) {
  const size = SIG * SIG;
  const baseA = a * size;
  const baseB = b * size;
  let diff = 0;
  for (let i = 0; i < size; i++) diff += Math.abs(analysis.signatures[baseA + i] - analysis.signatures[baseB + i]);
  return diff / size / 255;
}

/** Movimento médio (diferença entre quadros consecutivos) da janela. */
export function windowMotion(analysis, start, end) {
  return windowMotionTotal(analysis, start, end) / Math.max(1, end - start);
}

/** Movimento acumulado da janela — "quanto aconteceu" no trecho. */
export function windowMotionTotal(analysis, start, end) {
  let sum = 0;
  for (let i = start + 1; i <= end; i++) sum += analysis.deltas[i];
  return sum;
}

function median(values) {
  if (!values?.length) return 0;
  const sorted = Array.from(values).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Vídeo praticamente parado? (mediana das diferenças quase zero e sem picos) */
export function isStaticWindow(analysis, start, end) {
  const deltas = [];
  let max = 0;
  for (let i = start + 1; i <= end; i++) {
    deltas.push(analysis.deltas[i]);
    if (analysis.deltas[i] > max) max = analysis.deltas[i];
  }
  return deltas.length > 0 && median(deltas) < STATIC_MEDIAN_DELTA && max < STATIC_MAX_DELTA;
}

// ── Escolha da janela e fechamento do loop ─────────────────────────────────

function scoreWindow(analysis, start, end) {
  const deltas = [];
  for (let i = start + 1; i <= end; i++) deltas.push(analysis.deltas[i]);
  const mean = deltas.reduce((acc, d) => acc + d, 0) / Math.max(1, deltas.length);
  let variance = 0;
  for (const d of deltas) variance += (d - mean) * (d - mean);
  const std = Math.sqrt(variance / Math.max(1, deltas.length));

  // Movimento é o sinal principal: um trecho com "história" vale mais que um
  // plano parado, e a variação (std) diferencia trechos com altos e baixos.
  const motionScore = mean + 0.6 * std;

  // A emenda do loop entra como desconto proporcional: com movimento parecido,
  // o trecho que emenda melhor ganha — mas sem atropelar a escolha da ação
  // (o ajuste fino da emenda é do `chooseLoop`, que pode encurtar o fim).
  const seam = signatureDistance(analysis, start, end);
  const seamFactor = 1 - 0.6 * Math.min(1, seam);

  // Primeiro quadro escuro (abertura em preto) estraga a prévia da figurinha.
  const windowBrightness = [];
  for (let i = start; i <= end; i++) windowBrightness.push(analysis.brightness[i]);
  const midBrightness = median(windowBrightness) || 0.5;
  const darkFactor = analysis.brightness[start] < midBrightness * 0.5 ? 0.7 : 1;

  const startSeconds = start / analysis.sampleFps;
  return motionScore * seamFactor * darkFactor - 0.0004 * startSeconds;
}

/**
 * Melhores janelas de até `maxSeconds`: movimento, variação (trecho com
 * "história", não um plano parado), emenda de loop, brilho inicial e uma leve
 * preferência pelo começo do vídeo.
 *
 * @returns {Array<{start: number, end: number, score: number}>} melhor primeiro
 */
export function chooseWindows(analysis, { maxSeconds = 10, limit = 3 } = {}) {
  const fps = analysis.sampleFps;
  const last = analysis.frameCount - 1;
  const span = Math.min(analysis.frameCount, Math.max(2, Math.round(maxSeconds * fps)));
  if (span >= analysis.frameCount) return [{ start: 0, end: last, score: 1 }];

  const step = Math.max(1, Math.round(fps / 2)); // candidatos a cada 0,5 s
  const windows = [];
  for (let start = 0; start + span - 1 <= last; start += step) {
    const end = start + span - 1;
    windows.push({ start, end, score: scoreWindow(analysis, start, end) });
  }
  const tailStart = last - span + 1;
  if (windows[windows.length - 1].start !== tailStart) {
    windows.push({ start: tailStart, end: last, score: scoreWindow(analysis, tailStart, last) });
  }
  return windows.sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * Fecha o loop: entre as melhores janelas, tenta encurtar o fim em até 0,4 s
 * (passos de 2 quadros na grade de 15 fps) buscando o ponto em que o último
 * quadro mais se parece com o primeiro. Perder 0,1 s custa pouco (0,02), então
 * um loop suave ganha de um trecho um pouco maior.
 *
 * @returns {{start: number, end: number, score: number, seam: number, lost: number}|null}
 */
export function chooseLoop(analysis, { maxSeconds = 10, candidates } = {}) {
  const span = Math.min(analysis.frameCount, Math.max(2, Math.round(maxSeconds * analysis.sampleFps)));
  const last = analysis.frameCount - 1;
  // Vídeo curto: cabe inteiro, não há o que cortar.
  if (span >= analysis.frameCount) {
    return { start: 0, end: last, score: -signatureDistance(analysis, 0, last), seam: 0, lost: 0 };
  }

  const options = candidates?.length ? candidates : chooseWindows(analysis, { maxSeconds, limit: 3 });
  let best = null;
  for (const win of options) {
    const maxEnd = Math.min(last, win.start + span - 1);
    for (const back of [0, 2, 4, 6]) {
      const end = maxEnd - back;
      if (end - win.start < 4) continue;
      const seam = signatureDistance(analysis, win.start, end);
      const lost = (maxEnd - end) / analysis.sampleFps;
      const score = -seam - 0.02 * lost;
      if (!best || score > best.score) best = { start: win.start, end, score, seam, lost };
    }
  }
  return best;
}

// ── Quadros e enquadramento ────────────────────────────────────────────────

/**
 * Escolhe QUAIS quadros entram e, com os timestamps originais preservados, a
 * duração de cada um. A amostragem é por movimento acumulado: o trecho anda até
 * juntar `total/(N-2)` de movimento e então guarda um quadro — trecho parado
 * guarda pouco, ação guarda muito. O primeiro e o último quadro nunca caem, e a
 * distância entre quadros guardados nunca passa de `maxGapMs`.
 *
 * @returns {number[]} índices absolutos na grade da análise
 */
export function planSchedule(analysis, { start = 0, end = analysis.frameCount - 1, targetFrames = 60, minGap = 1, maxGapMs = 250 } = {}) {
  if (end <= start) return [start];
  const frames = Math.max(2, Math.min(targetFrames, end - start + 1));
  const maxGap = Math.max(1, Math.round((maxGapMs / 1000) * analysis.sampleFps));
  const kept = [start];
  if (frames === 2) {
    kept.push(end);
    return kept;
  }

  // Piso no passo evita guardar todos os quadros de um trecho quase parado.
  const step = Math.max(0.0015, windowMotionTotal(analysis, start, end) / (frames - 2));
  let acc = 0;
  let lastKept = start;
  for (let i = start + 1; i < end; i++) {
    acc += analysis.deltas[i];
    const gap = i - lastKept;
    if ((acc >= step && gap >= minGap) || gap >= maxGap) {
      kept.push(i);
      lastKept = i;
      // Carrega o excedente: sem isso o acumulador "gasta" mais movimento por
      // quadro do que devia e o plano entrega bem menos quadros que o pedido.
      acc -= step;
      if (acc < 0) acc = 0;
    }
  }
  kept.push(end);
  return kept;
}

/**
 * Reduz um plano já feito para `targetFrames` quadros (a alavanca grossa do
 * orçamento) mantendo a distribuição por movimento.
 *
 * @param {object} plan plano de `planSticker`
 * @param {number} targetFrames novo teto de quadros
 * @returns {number[]} índices relativos ao início da janela
 */
export function shrinkSchedule(plan, targetFrames) {
  if (!plan?.schedule?.length) return [];
  if (targetFrames >= plan.schedule.length) return plan.schedule;
  if (plan.analysis) {
    const kept = planSchedule(plan.analysis, {
      start: plan.start,
      end: plan.end,
      targetFrames: Math.max(2, targetFrames)
    });
    return kept.map((i) => i - plan.start);
  }
  // Sem a análise (plano serializado), cai num subconjunto uniforme.
  const out = [];
  const ratio = targetFrames / plan.schedule.length;
  for (let i = 0; i < plan.schedule.length; i++) {
    if (i === 0 || i === plan.schedule.length - 1 || i / plan.schedule.length >= out.length * ratio) out.push(plan.schedule[i]);
  }
  return out.slice(0, Math.max(2, targetFrames));
}

/**
 * Mapa da área que se mexe no trecho (grade 32×32, suavizada 3×3).
 * @returns {{cx: number, cy: number, w: number, h: number}} centro e caixa da
 *   atividade em fração 0..1 da imagem (a caixa é a área com movimento)
 */
export function activityBox(analysis, { start = 0, end = analysis.frameCount - 1 } = {}) {
  const cell = GRID * GRID;
  if (end <= start) return { cx: 0.5, cy: 0.5, w: 1, h: 1 };
  const activity = new Float32Array(cell);
  for (let i = start + 1; i <= end; i++) {
    const base = i * cell;
    const prev = base - cell;
    for (let c = 0; c < cell; c++) activity[c] += Math.abs(analysis.gray[base + c] - analysis.gray[prev + c]);
  }

  const smooth = new Float32Array(cell);
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      let sum = 0;
      let count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ny = y + dy;
          const nx = x + dx;
          if (ny < 0 || nx < 0 || ny >= GRID || nx >= GRID) continue;
          sum += activity[ny * GRID + nx];
          count++;
        }
      }
      smooth[y * GRID + x] = sum / count;
    }
  }

  let total = 0;
  let max = 0;
  for (const v of smooth) {
    total += v;
    if (v > max) max = v;
  }
  const mean = total / cell;
  if (max <= 0 || mean <= 0) return { cx: 0.5, cy: 0.5, w: 1, h: 1 };

  const threshold = Math.max(mean * 1.6, max * 0.22);
  let minX = GRID;
  let minY = GRID;
  let maxX = -1;
  let maxY = -1;
  let weight = 0;
  let sumX = 0;
  let sumY = 0;
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const v = smooth[y * GRID + x];
      if (v < threshold) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      weight += v;
      sumX += x * v;
      sumY += y * v;
    }
  }
  if (maxX < 0 || weight <= 0) return { cx: 0.5, cy: 0.5, w: 1, h: 1 };

  return {
    cx: (sumX / weight + 0.5) / GRID,
    cy: (sumY / weight + 0.5) / GRID,
    w: (maxX - minX + 1) / GRID,
    h: (maxY - minY + 1) / GRID
  };
}

/**
 * Converte a caixa de atividade num crop QUADRADO em pixels (o quadrado evita
 * esticar/distorcer ao escalar para 512×512). Devolve `null` quando o crop não
 * compensa — assunto já ocupando o quadro, ou caixa pequena demais.
 */
export function cropPixels(box, width, height) {
  if (!box || !width || !height) return null;
  const minSide = Math.min(width, height);
  const wanted = Math.max(box.w * width, box.h * height) * 1.25; // margem para respirar
  const side = Math.min(minSide, Math.max(wanted, MIN_CROP_RATIO * minSide));
  if (side >= CROP_SKIP_RATIO * minSide) return null;
  const px = Math.max(16, Math.round(side));
  const x = Math.max(0, Math.min(width - px, Math.round(box.cx * width - px / 2)));
  const y = Math.max(0, Math.min(height - px, Math.round(box.cy * height - px / 2)));
  return { x, y, w: px, h: px };
}

/** FPS alvo conforme o movimento: parado fica perto de 6 fps; ação vai a 15. */
export function targetFpsFor(motionPerSecond) {
  const scale = Math.min(1, Math.max(0, motionPerSecond / 0.045));
  return Math.max(6, Math.min(SAMPLE_FPS, Math.round(6 + (SAMPLE_FPS - 6) * scale)));
}

// ── Orçamento ──────────────────────────────────────────────────────────────

/** Piso de qualidade em que uma figurinha ainda fica apresentável de perto. */
export const QUALITY_FLOOR = 22;

/**
 * Quantos quadros o orçamento compra se a qualidade descer até o piso.
 *
 * É o pulo direto da alocação: em vez de testar 15, 12, 10, 8 fps um a um,
 * extrapola o tamanho medido (bytes por quadro) para o piso de qualidade e
 * calcula quantos quadros cabem. Como a figurinha é exibida pequena, fluidez
 * vale mais que qualidade fina — então o piso segura a qualidade e os quadros
 * absorvem o resto do orçamento.
 *
 * @param {{frames: number, bytes: number, q: number, floor?: number, budgetBytes: number, minFrames?: number, slope?: number}} opts
 */
export function framesForQualityFloor({ frames, bytes, q, floor = QUALITY_FLOOR, budgetBytes, minFrames = 8, slope = QUALITY_SLOPE }) {
  if (!frames || !bytes || !(budgetBytes > 0)) return frames;
  const perFrame = bytes / frames;
  const perFrameAtFloor = perFrame * Math.exp(slope * (floor - q));
  const fit = Math.floor((budgetBytes * 0.9) / Math.max(1, perFrameAtFloor));
  return Math.max(minFrames, Math.min(frames, fit));
}

/**
 * Prevê a qualidade (q do libwebp) que faz o arquivo chegar perto de
 * `targetBytes`. Modelo log-linear ln(bytes) ≈ a + b·q: com 2+ medições o `b` é
 * ajustado pelo próprio arquivo (cada vídeo comprime diferente); com 1 medição
 * usa a inclinação padrão medida no libwebp.
 *
 * A unidade de tamanho é livre: passar `sizeKey: 'bytesPerFrame'` faz o modelo
 * valer para qualquer número de quadros (é assim que o motor troca FPS sem
 * perder o que já aprendeu sobre o arquivo).
 *
 * @param {Array<{q: number, bytes: number}>} samples medições já feitas
 * @param {number} targetBytes alvo de bytes (na mesma unidade das amostras)
 */
export function predictQuality(samples, targetBytes, { minQ = 8, maxQ = 82, slope = QUALITY_SLOPE, sizeKey = 'bytes' } = {}) {
  const clean = (samples || []).filter(
    (s) => Number.isFinite(s?.q) && Number.isFinite(s?.[sizeKey]) && s[sizeKey] > 0
  );
  if (!clean.length || !(targetBytes > 0)) return 55;
  const clampQ = (q) => Math.round(Math.max(minQ, Math.min(maxQ, q)));

  if (clean.length === 1) {
    const only = clean[0];
    return clampQ(only.q + Math.log(targetBytes / only[sizeKey]) / slope);
  }

  const n = clean.length;
  const meanQ = clean.reduce((acc, s) => acc + s.q, 0) / n;
  const meanL = clean.reduce((acc, s) => acc + Math.log(s[sizeKey]), 0) / n;
  let num = 0;
  let den = 0;
  for (const s of clean) {
    num += (s.q - meanQ) * (Math.log(s[sizeKey]) - meanL);
    den += (s.q - meanQ) ** 2;
  }
  const fitted = den > 0 ? num / den : slope;
  const b = Number.isFinite(fitted) && Math.abs(fitted) > 0.002 ? fitted : slope;
  const a = meanL - b * meanQ;
  return clampQ((Math.log(targetBytes) - a) / b);
}

// ── Plano final ────────────────────────────────────────────────────────────

/**
 * Quadro mais apresentável para a figurinha parada: brilho perto da mediana do
 * trecho e bastante detalhe (evita abrir num fade preto ou num quadro borrado).
 */
export function bestStillFrame(analysis, start, end) {
  const brightness = [];
  for (let i = start; i <= end; i++) brightness.push(analysis.brightness[i]);
  const mid = median(brightness);
  const cell = GRID * GRID;
  let best = start;
  let bestScore = -Infinity;
  for (let i = start; i <= end; i++) {
    const base = i * cell;
    let sum = 0;
    let sum2 = 0;
    for (let c = 0; c < cell; c++) {
      const v = analysis.gray[base + c];
      sum += v;
      sum2 += v * v;
    }
    const mean = sum / cell;
    const variance = sum2 / cell - mean * mean;
    const score = variance / 65025 - Math.abs(analysis.brightness[i] - mid) * 4;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

/**
 * Monta o plano completo da figurinha a partir da análise.
 *
 * @param {object} analysis saída de `analyzeFrames`
 * @param {{maxSeconds?: number, budgetBytes?: number, minFrames?: number, qStart?: number, autoCrop?: boolean}} [opts]
 * @returns {object|null} plano pronto para o FFmpeg (ou null quando não deu)
 */
export function planSticker(analysis, { maxSeconds = 10, budgetBytes = 480 * 1024, minFrames = 8, qStart = 45, autoCrop = true } = {}) {
  if (!analysis || analysis.frameCount < 2) return null;
  const loop = chooseLoop(analysis, { maxSeconds });
  if (!loop) return null;

  const fps = analysis.sampleFps;
  const { start, end } = loop;
  const frames = end - start + 1;
  const seconds = frames / fps;
  const motion = windowMotion(analysis, start, end);
  const base = {
    analysis,
    start,
    end,
    startMs: Math.round((start / fps) * 1000),
    durationMs: Math.round(seconds * 1000),
    fps,
    frames,
    motion,
    budgetBytes,
    minFrames,
    qStart
  };

  // Vídeo parado não vira "animação": vira figurinha estática, melhor e menor.
  if (isStaticWindow(analysis, start, end)) {
    const still = bestStillFrame(analysis, start, end);
    return {
      ...base,
      mode: 'static',
      stillIndex: still,
      stillMs: Math.round((still / fps) * 1000),
      targetFps: 1,
      schedule: [still],
      crop: null,
      reason: 'o vídeo não se mexe — figurinha parada em alta qualidade'
    };
  }

  const targetFps = targetFpsFor(motion * fps);
  const targetFrames = Math.max(minFrames, Math.round(seconds * targetFps));
  const kept = planSchedule(analysis, { start, end, targetFrames });
  const box = activityBox(analysis, { start, end });

  return {
    ...base,
    mode: 'animated',
    targetFps,
    schedule: kept.map((i) => i - start),
    crop: autoCrop ? cropPixels(box, analysis.width, analysis.height) : null,
    activity: box,
    reason: ''
  };
}

// ── Análise via FFmpeg ─────────────────────────────────────────────────────

/**
 * Roda o FFmpeg uma vez para extrair os quadros minúsculos e monta a análise.
 * Usa stdout (rawvideo) para os quadros e stderr para largura/altura/duração.
 *
 * @param {string} inFile arquivo de entrada (já em disco)
 * @param {{ffmpegBin: string, maxSeconds?: number, sampleFps?: number, timeoutMs?: number}} opts
 * @returns {Promise<object|null>} análise pronta para `planSticker` (null se falhar)
 */
export function analyzeSource(inFile, { ffmpegBin, maxSeconds = ANALYSIS_MAX_SECONDS, sampleFps = SAMPLE_FPS, timeoutMs = 90_000 } = {}) {
  if (!ffmpegBin || !inFile) return Promise.resolve(null);
  const cell = GRID * GRID;
  const maxFrames = Math.ceil(maxSeconds * sampleFps) + 4;
  const maxBytes = maxFrames * cell;

  return new Promise((resolve) => {
    const args = [
      '-hide_banner',
      '-nostdin',
      '-v', 'info',
      '-t', String(maxSeconds),
      '-i', inFile,
      '-vf', `fps=${sampleFps},scale=${GRID}:${GRID}:force_original_aspect_ratio=disable:flags=bilinear,format=gray`,
      '-f', 'rawvideo',
      '-'
    ];
    let proc;
    try {
      proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      return resolve(null);
    }
    const chunks = [];
    let total = 0;
    let stderr = '';
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {}
      finish(null);
    }, timeoutMs);

    proc.stdout.on('data', (d) => {
      total += d.length;
      if (total <= maxBytes) chunks.push(d);
      else {
        try {
          proc.kill('SIGKILL');
        } catch {}
      }
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
    });
    proc.on('error', () => finish(null));
    proc.on('close', () => {
      const raw = Buffer.concat(chunks);
      const meta = parseSourceMeta(stderr);
      const analysis = analyzeFrames(raw, { ...meta, sampleFps });
      finish(analysis);
    });
  });
}
