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
 * Lê largura/altura/duração/rotação do stderr do FFmpeg (funciona sem ffprobe).
 *
 * ATENÇÃO À ROTAÇÃO: vídeo de celular em pé costuma ser gravado deitado e
 * marcado com uma matriz de exibição (displaymatrix). O FFmpeg autorrota na
 * decodificação, então o filtro recebe as dimensões TROCADAS em relação ao
 * cabeçalho do stream. Sem corrigir isso, o enquadramento automático seria
 * calculado para um quadro que não existe — e o crop sairia errado ou fora dos
 * limites (derrubando a conversão inteligente inteira).
 *
 * @param {string} stderr saída de erro do `ffmpeg -i`
 * @returns {{width: number, height: number, rotation: number, durationMs: number, durationKnown: boolean}}
 */
export function parseSourceMeta(stderr) {
  const text = String(stderr || '');
  const size = /Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b/.exec(text);
  const duration = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(text);
  // A primeira matriz do dump é a do stream de entrada (as seguintes são da saída).
  const matrix = /displaymatrix:\s*rotation of (-?\d+(?:\.\d+)?) degrees/.exec(text);
  const legacy = /rotate\s*:\s*(-?\d+(?:\.\d+)?)/.exec(text);
  const rotation = Number(matrix?.[1] ?? legacy?.[1] ?? 0) || 0;

  let width = size ? Number(size[1]) : 0;
  let height = size ? Number(size[2]) : 0;
  // Rotação de 90°/270° significa que o quadro decodificado está deitado/de pé
  // ao contrário: as dimensões usadas nos cálculos precisam ser trocadas.
  const swapped = Math.abs(Math.round(rotation)) % 180 === 90;
  if (swapped) [width, height] = [height, width];

  let durationMs = 0;
  if (duration) {
    durationMs = Math.round(
      (Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])) * 1000
    );
  }
  return { width, height, rotation, durationMs, durationKnown: Boolean(duration) && durationMs > 0 };
}

/**
 * Transforma os quadros crus (32×32 RGBA) na análise que o plano consome:
 * movimento entre quadros, brilho, assinaturas 8×8, os quadros em cinza
 * (derivados) e a cor original — que é o que permite achar o fundo liso e
 * recortar o sujeito sem IA.
 *
 * @param {Buffer} raw GRID*GRID*4 bytes por quadro (RGBA)
 * @param {{width?: number, height?: number, durationMs?: number, sampleFps?: number}} [meta]
 */
export function analyzeFrames(raw, { width = 0, height = 0, durationMs = 0, sampleFps = SAMPLE_FPS } = {}) {
  const cell = GRID * GRID;
  const frameCount = Math.floor(raw.length / (cell * 4));
  if (frameCount < 1) return null; // 1 quadro = foto: plano estático

  const deltas = new Float32Array(frameCount);
  const brightness = new Float32Array(frameCount);
  const sigSize = SIG * SIG;
  const signatures = new Uint8Array(frameCount * sigSize);
  const pool = GRID / SIG;
  const poolCells = pool * pool;
  // Cinza derivado do RGB (luma Rec.601): o resto do motor continua com um byte
  // por pixel; a cor fica guardada para o recorte de fundo.
  const gray = new Uint8Array(frameCount * cell);

  for (let f = 0; f < frameCount; f++) {
    const base = f * cell * 4;
    const grayBase = f * cell;
    let luma = 0;
    for (let i = 0; i < cell; i++) {
      const p = base + i * 4;
      const v = Math.round((raw[p] * 299 + raw[p + 1] * 587 + raw[p + 2] * 114) / 1000);
      gray[grayBase + i] = v;
      luma += v;
    }
    brightness[f] = luma / cell / 255;

    if (f > 0) {
      let diff = 0;
      for (let i = 0; i < cell; i++) diff += Math.abs(gray[grayBase + i] - gray[grayBase - cell + i]);
      deltas[f] = diff / cell / 255;
    }

    // Assinatura 8×8: média de cada bloco 4×4 (barata e robusta a ruído).
    const sigBase = f * sigSize;
    for (let sy = 0; sy < SIG; sy++) {
      for (let sx = 0; sx < SIG; sx++) {
        let sum = 0;
        for (let y = 0; y < pool; y++) {
          const row = (sy * pool + y) * GRID + sx * pool;
          for (let x = 0; x < pool; x++) sum += gray[grayBase + row + x];
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
    gray,
    rgba: raw,
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
  const midBrightness = median(windowBrightness) || 0;
  const darkThreshold = Math.max(0.06, midBrightness * 0.5);
  const darkFactor = analysis.brightness[start] < darkThreshold ? 0.7 : 1;

  const startSeconds = start / analysis.sampleFps;
  return motionScore * seamFactor * darkFactor - 0.0004 * startSeconds;
}

/**
 * Quantos quadros do começo são "nada para ver": fade de abertura, tela preta,
 * cartela escura. Só conta quadros ESCUROS de propósito — trecho claro e parado
 * pode ser conteúdo (a pessoa segurando uma pose) e não é podado.
 *
 * @returns {number} quadros a pular no início (0 quando não há o que podar)
 */
export function deadLeadFrames(analysis, { start = 0, end = analysis.frameCount - 1, maxSeconds = 4 } = {}) {
  const windowBrightness = [];
  for (let i = start; i <= end; i++) windowBrightness.push(analysis.brightness[i]);
  // Vídeo quase todo escuro (fade longo, cena noturna) tem mediana ~0: o
  // limiar fixo abaixo ainda enxerga o que é "nada" no começo, e o teto de
  // 40% impede que a poda coma o vídeo inteiro.
  const mid = median(windowBrightness) || 0;
  const limit = Math.max(1, Math.round(maxSeconds * analysis.sampleFps));
  const maxTrim = Math.floor((end - start + 1) * 0.4); // nunca come 40% da figurinha
  const threshold = Math.max(0.06, mid * 0.4);
  let n = 0;
  while (n < Math.min(limit, maxTrim) && start + n < end - 1) {
    if (analysis.brightness[start + n] >= threshold) break;
    n++;
  }
  return n;
}

/**
 * Melhores janelas de até `maxSeconds`: movimento, variação (trecho com
 * "história", não um plano parado), emenda de loop, brilho inicial e uma leve
 * preferência pelo começo do vídeo.
 *
 * Vídeo curto (cabe inteiro) tem uma escolha a mais: onde COMEÇAR. É assim que
 * uma abertura preta/fade sai da figurinha — o resto da duração é preservado,
 * só o "nada acontecendo" da frente é que fica de fora.
 *
 * @returns {Array<{start: number, end: number, score: number}>} melhor primeiro
 */
export function chooseWindows(analysis, { maxSeconds = 10, limit = 3 } = {}) {
  const fps = analysis.sampleFps;
  const last = analysis.frameCount - 1;
  const span = Math.min(analysis.frameCount, Math.max(2, Math.round(maxSeconds * fps)));

  if (span >= analysis.frameCount) {
    const deadLead = deadLeadFrames(analysis, { start: 0, end: last });
    const candidates = [0];
    if (deadLead > 1) {
      candidates.push(deadLead);
      // Um pouco antes do fim do trecho morto: evita abrir em cima do 1º quadro
      // "de verdade", que ainda costuma estar no meio do fade.
      candidates.push(Math.max(0, deadLead - 2));
    }
    return candidates
      .map((start) => ({ start, end: last, score: scoreWindow(analysis, start, last) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, limit));
  }

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
  const options = candidates?.length ? candidates : chooseWindows(analysis, { maxSeconds, limit: 3 });
  if (!options.length) return null;

  // 1) A janela é escolhida pela pontuação dela (movimento, variação, brilho do
  //    primeiro quadro) — é isso que mantém a poda de abertura preta valendo.
  const chosen = [...options].sort((a, b) => b.score - a.score)[0];
  const maxEnd = Math.min(last, chosen.start + span - 1);

  // 2) Só então fecha o loop: encurtar o fim só compensa se a emenda melhorar
  //    bastante (senão o trecho maior vale mais que a emenda perfeita).
  const seamAtMax = signatureDistance(analysis, chosen.start, maxEnd);
  let end = maxEnd;
  let seam = seamAtMax;
  for (const back of [2, 4, 6]) {
    const candidate = maxEnd - back;
    if (candidate - chosen.start < 4) continue;
    const candidateSeam = signatureDistance(analysis, chosen.start, candidate);
    if (candidateSeam < seam) {
      end = candidate;
      seam = candidateSeam;
    }
  }
  if (seam > seamAtMax * 0.7) {
    end = maxEnd;
    seam = seamAtMax;
  }
  return { start: chosen.start, end, score: chosen.score, seam, lost: (maxEnd - end) / analysis.sampleFps };
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
export function cropPixels(box, width, height, { minRatio = MIN_CROP_RATIO } = {}) {
  if (!box || !width || !height) return null;
  const minSide = Math.min(width, height);
  const wanted = Math.max(box.w * width, box.h * height) * 1.25; // margem para respirar
  const side = Math.min(minSide, Math.max(wanted, minRatio * minSide));
  if (side >= CROP_SKIP_RATIO * minSide) return null;
  const px = Math.max(16, Math.round(side));
  const x = Math.max(0, Math.min(width - px, Math.round(box.cx * width - px / 2)));
  const y = Math.max(0, Math.min(height - px, Math.round(box.cy * height - px / 2)));
  return { x, y, w: px, h: px };
}

/** FPS alvo conforme o movimento: parado fica perto de 6 fps; ação vai a 15. */
export function targetFpsFor(motionPerSecond) {
  const scale = Math.min(1, Math.max(0, (Number(motionPerSecond) || 0) / MOTION_REFERENCE));
  return Math.max(6, Math.min(SAMPLE_FPS, Math.round(6 + (SAMPLE_FPS - 6) * scale)));
}

// ── Orçamento ──────────────────────────────────────────────────────────────

/** Piso de qualidade em que uma figurinha ainda fica apresentável de perto. */
export const QUALITY_FLOOR = 22;
/**
 * Equilíbrio automático entre fluidez e nitidez, medido pelo movimento:
 *  - vídeo com muita ação: piso baixo (22) → o orçamento vira QUADROS, porque
 *    movimento travado incomoda mais que detalhe fino numa figurinha pequena;
 *  - vídeo com pouca ação: piso alto (50) → o orçamento vira NITIDEZ, porque
 *    poucos quadros já contam a história e o arquivo sobra.
 */
export const QUALITY_FLOOR_MOTION_LOW = 50;
export const MOTION_REFERENCE = 0.045;

/**
 * Modos que o usuário pode pedir (em cima do equilíbrio automático):
 *  - `smooth` (liso): fluidez máxima — 15 fps, aceitando qualidade menor;
 *  - `sharp` (nítido): imagem mais nítida — menos quadros, piso de qualidade alto;
 *  - `auto`: o motor decide pelo movimento (padrão).
 */
export const STICKER_PREFERENCES = ['auto', 'smooth', 'sharp'];
/** FPS máximo do modo fluidez (o mesmo teto da análise). */
export const SMOOTH_FPS = SAMPLE_FPS;
/** FPS máximo do modo nítido: poucos quadros, cada um mais limpo. */
export const SHARP_FPS = 8;
/** Piso de qualidade do modo nítido (o orçamento vira nitidez, não quadros). */
export const SHARP_QUALITY_FLOOR = 62;

export function qualityFloorFor(motionPerSecond) {
  const level = Math.min(1, Math.max(0, (Number(motionPerSecond) || 0) / MOTION_REFERENCE));
  return Math.round(QUALITY_FLOOR_MOTION_LOW - (QUALITY_FLOOR_MOTION_LOW - QUALITY_FLOOR) * level);
}

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
export function planSticker(analysis, { maxSeconds = 10, budgetBytes = 480 * 1024, minFrames = 8, qStart = 45, autoCrop = true, autoCut = true, prefer = 'auto' } = {}) {
  if (!analysis) return null;
  const mode = STICKER_PREFERENCES.includes(prefer) ? prefer : 'auto';
  // Foto: um quadro só. Vira figurinha parada — e o fundo liso ainda é recortado.
  if (analysis.frameCount === 1) {
    const { state, cut } = autoCut ? backgroundVerdict(analysis) : { state: 'off', cut: null };
    return {
      analysis,
      start: 0,
      end: 0,
      startMs: 0,
      durationMs: 0,
      fps: analysis.sampleFps,
      frames: 1,
      motion: 0,
      budgetBytes,
      minFrames,
      qStart,
      qualityFloor: qualityFloorFor(0),
      prefer: mode,
      cut,
      cutState: state,
      mode: 'static',
      stillIndex: 0,
      stillMs: 0,
      targetFps: 1,
      schedule: [0],
      crop: null,
      reason: 'é uma foto — figurinha parada em alta qualidade'
    };
  }
  const loop = chooseLoop(analysis, { maxSeconds });
  if (!loop) return null;

  const fps = analysis.sampleFps;
  const { start, end } = loop;
  const frames = end - start + 1;
  const seconds = frames / fps;
  const motion = windowMotion(analysis, start, end);
  // Fundo liso → recorte automático sem IA (chave de cor). Vale para figurinha
  // parada e animada: fundo chapado em volta do sujeito fica transparente.
  const verdict = autoCut ? backgroundVerdict(analysis, { start, end }) : { state: 'off', cut: null };
  const cut = verdict.cut;
  // O usuário pode mandar: liso (fluidez) ou nítido (imagem). O automático
  // segue o movimento medido.
  const autoFps = targetFpsFor(motion * fps);
  const targetFps =
    mode === 'smooth' ? SMOOTH_FPS : mode === 'sharp' ? Math.min(SHARP_FPS, Math.max(5, autoFps)) : autoFps;
  const autoFloor = qualityFloorFor(motion * fps);
  const qualityFloor =
    mode === 'smooth' ? QUALITY_FLOOR : mode === 'sharp' ? Math.max(autoFloor, SHARP_QUALITY_FLOOR) : autoFloor;
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
    qStart,
    qualityFloor,
    prefer: mode,
    cut,
    cutState: verdict.state
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

  const targetFrames = Math.max(minFrames, Math.round(seconds * targetFps));
  const kept = planSchedule(analysis, { start, end, targetFrames });
  const box = activityBox(analysis, { start, end });

  // Com o fundo removido, enquadrar o sujeito é o que dá cara de figurinha de
  // app — mas só quando o recorte não estica demais (upscale feio).
  const subjectCrop = cut ? cropPixels(subjectBox(analysis, cut, { start, end }), analysis.width, analysis.height, { minRatio: CUT_CROP_MIN_RATIO }) : null;
  const crop = autoCrop
    ? (subjectCrop && subjectCrop.w >= CUT_CROP_MIN_SOURCE_PX ? subjectCrop : cropPixels(box, analysis.width, analysis.height)) ?? null
    : null;

  return {
    ...base,
    mode: 'animated',
    targetFps,
    schedule: kept.map((i) => i - start),
    crop,
    activity: box,
    reason: ''
  };
}

// ── Fundo liso → recorte automático (sem IA) ───────────────────────────────

/** Fração mínima do quadro que o fundo precisa ocupar para valer o recorte. */
export const CUT_MIN_COVERAGE = 0.3;
/** Diferença mínima entre o sujeito e o fundo (0..1) para o recorte valer. */
export const CUT_MIN_CONTRAST = 0.12;
/** Menor recorte aceitável sobre o sujeito, em fração do lado menor. */
export const CUT_CROP_MIN_RATIO = 0.3;
/** Abaixo disso (px na fonte) enquadrar o sujeito esticaria demais a imagem. */
export const CUT_CROP_MIN_SOURCE_PX = 384;

function cellColor(analysis, frame, cx, cy) {
  const base = frame * analysis.cell * 4;
  const p = base + (cy * GRID + cx) * 4;
  return [analysis.rgba[p], analysis.rgba[p + 1], analysis.rgba[p + 2]];
}

/**
 * Procura um fundo liso para recortar o sujeito SEM IA (chave de cor).
 *
 * A ideia: se os quatro cantos (blocos de 6×6 células) têm a mesma cor, essa cor
 * se mantém estável no tempo e ela ocupa boa parte do quadro, então o fundo é
 * liso e dá para removê-lo. Se qualquer canto destoar, está em movimento ou o
 * fundo aparece pouco, a resposta é `null` — a figurinha sai inteira, como
 * sempre. Melhor não recortar do que recortar errado.
 *
 * @returns {{color: {r: number, g: number, b: number}, similarity: number, coverage: number, contrast: number}|null}
 */
export function backgroundVerdict(analysis, { start = 0, end = (analysis?.frameCount ?? 1) - 1 } = {}) {
  if (!analysis?.rgba || end < start) return { state: 'off', cut: null };
  const frames = [];
  // Amostra até 24 quadros do trecho: fundo chapado não muda de um para o outro.
  const step = Math.max(1, Math.floor((end - start) / 24));
  for (let f = start; f <= end; f += step) frames.push(f);

  // O fundo é procurado no ANEL EXTERNO (2 células de espessura), não só nos
  // cantos: assim um sujeito que encosta numa borda ainda deixa o resto do
  // fundo visível, como nos apps comerciais.
  const RING = 2;
  const ringCells = [];
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      if (x < RING || y < RING || x >= GRID - RING || y >= GRID - RING) ringCells.push(y * GRID + x);
    }
  }

  // A cor do fundo é a MEDIANA do anel: se o sujeito cobre parte da borda em
  // alguns quadros, a mediana continua sendo o fundo.
  const samples = [];
  const ringAlpha = [];
  for (const f of frames) {
    const base = f * analysis.cell * 4;
    for (const c of ringCells) {
      const p = base + c * 4;
      samples.push([analysis.rgba[p], analysis.rgba[p + 1], analysis.rgba[p + 2]]);
      ringAlpha.push(analysis.rgba[p + 3]);
    }
  }
  // Já veio transparente (figurinha repassada, PNG/GIF com alfa): não há fundo
  // liso para tirar, e chavear cor no preto das áreas vazias estragaria o desenho.
  ringAlpha.sort((a, b) => a - b);
  if (ringAlpha[Math.floor(ringAlpha.length / 2)] < 20) return { state: 'transparent', cut: null };
  const channelMedian = (k) => {
    const values = samples.map((s) => s[k]).sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
  };
  const mean = [channelMedian(0), channelMedian(1), channelMedian(2)];
  const distances = samples.map((s) => Math.hypot(s[0] - mean[0], s[1] - mean[1], s[2] - mean[2])).sort((a, b) => a - b);
  const d50 = distances[Math.floor(distances.length / 2)];
  // Metade do anel precisa estar a menos de ~9% da cor dominante (senão é cenário).
  if (d50 > 0.09 * 441.67) return { state: 'complex', cut: null };

  const color = { r: Math.round(mean[0]), g: Math.round(mean[1]), b: Math.round(mean[2]) };
  // Cores do mesmo fundo ficam dentro de 3σ (a compressão do vídeo mexe um pouco).
  const inner = samples.filter((s) => Math.hypot(s[0] - color.r, s[1] - color.g, s[2] - color.b) <= d50 * 2);
  const variance = inner.length
    ? inner.reduce((acc, s) => acc + (s[0] - color.r) ** 2 + (s[1] - color.g) ** 2 + (s[2] - color.b) ** 2, 0) /
      (inner.length * 3)
    : 0;
  const sigma = Math.sqrt(variance);
  const tol = Math.max(20, sigma * 3 + 6);
  const near = (r, g, b) => Math.hypot(r - color.r, g - color.g, b - color.b) <= tol;

  // 1) O anel precisa continuar sendo fundo na maior parte dos quadros
  //    (câmera andando muda a cor da borda e derruba isto).
  let ringOk = 0;
  for (const f of frames) {
    const base = f * analysis.cell * 4;
    let hits = 0;
    for (const c of ringCells) {
      const p = base + c * 4;
      if (near(analysis.rgba[p], analysis.rgba[p + 1], analysis.rgba[p + 2])) hits++;
    }
    if (hits / ringCells.length >= 0.55) ringOk++;
  }
  if (ringOk / frames.length < 0.75) return { state: 'complex', cut: null };

  // 2) O fundo precisa ocupar boa parte do quadro e o miolo destoar dele
  //    (senão é um cenário, não um sujeito sobre fundo liso).
  let background = 0;
  let totalCells = 0;
  let centerDiff = 0;
  let centerCells = 0;
  const c0 = GRID * 0.35;
  const c1 = GRID * 0.65;
  for (const f of frames) {
    const base = f * analysis.cell * 4;
    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        const p = base + (y * GRID + x) * 4;
        const r = analysis.rgba[p];
        const g = analysis.rgba[p + 1];
        const b = analysis.rgba[p + 2];
        const isNear = near(r, g, b);
        totalCells++;
        if (isNear) background++;
        if (x >= c0 && x <= c1 && y >= c0 && y <= c1) {
          centerCells++;
          if (!isNear) centerDiff += Math.hypot(r - color.r, g - color.g, b - color.b) / 441.67;
        }
      }
    }
  }
  const coverage = background / totalCells;
  const contrast = centerCells ? centerDiff / centerCells : 0;
  if (coverage < CUT_MIN_COVERAGE || contrast < CUT_MIN_CONTRAST) return { state: 'lowcontrast', cut: null };

  // Tolerância do colorkey: cobre o ruído medido com folga, sem comer o sujeito.
  const similarity = Math.max(0.07, Math.min(0.3, 0.05 + (sigma / 255) * 3));
  return {
    state: 'flat',
    cut: {
      color,
      similarity: Number(similarity.toFixed(3)),
      coverage: Number(coverage.toFixed(2)),
      contrast: Number(contrast.toFixed(2))
    }
  };
}

/** Recorta o fundo liso (ou `null` quando não é o caso). Atalho de `backgroundVerdict`. */
export function backgroundCut(analysis, opts) {
  return backgroundVerdict(analysis, opts).cut;
}

/**
 * Vale chamar a IA (remove.bg/rembg)? Sim quando o fundo não é liso mas existe
 * sujeito para separar. Fundo já transparente ou foto sem contraste não pagam
 * uma chamada de rede.
 */
export function aiCutCouldHelp(state) {
  return state === 'complex' || state === 'lowcontrast';
}

/**
 * Caixa quadrada do SUJEITO (o que não é a cor do fundo), normalizada 0..1.
 * Uma célula conta como sujeito quando fica longe da cor do fundo na maior
 * parte do trecho — assim movimento de câmera e ruído não inflam a caixa.
 *
 * @returns {{cx: number, cy: number, w: number, h: number}|null}
 */
export function subjectBox(analysis, cut, { start = 0, end = (analysis?.frameCount ?? 1) - 1, pad = 0.15 } = {}) {
  if (!analysis?.rgba || !cut || end < start) return null;
  const frames = [];
  const step = Math.max(1, Math.floor((end - start) / 24));
  for (let f = start; f <= end; f += step) frames.push(f);
  const tol = Math.max(24, cut.similarity * 441.67 * 0.8);
  const hits = new Uint16Array(GRID * GRID);
  for (const f of frames) {
    const base = f * analysis.cell * 4;
    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        const p = base + (y * GRID + x) * 4;
        const d = Math.hypot(
          analysis.rgba[p] - cut.color.r,
          analysis.rgba[p + 1] - cut.color.g,
          analysis.rgba[p + 2] - cut.color.b
        );
        if (d > tol) hits[y * GRID + x]++;
      }
    }
  }
  const need = Math.max(1, Math.round(frames.length * 0.3));
  let minX = GRID;
  let minY = GRID;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      if (hits[y * GRID + x] < need) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  const side = Math.min(1, ((Math.max(maxX - minX + 1, maxY - minY + 1) / GRID) * (1 + pad * 2)));
  return {
    cx: (minX + maxX + 1) / 2 / GRID,
    cy: (minY + maxY + 1) / 2 / GRID,
    w: side,
    h: side
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
  const cell = GRID * GRID * 4; // RGBA: a cor é o que permite achar o fundo liso
  const maxFrames = Math.ceil(maxSeconds * sampleFps) + 4;
  const maxBytes = maxFrames * cell;

  return new Promise((resolve) => {
    const args = [
      '-hide_banner',
      '-nostdin',
      '-v', 'info',
      '-t', String(maxSeconds),
      '-i', inFile,
      '-vf', `fps=${sampleFps},scale=${GRID}:${GRID}:force_original_aspect_ratio=disable:flags=bilinear,format=rgba`,
      '-pix_fmt', 'rgba',
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
