// BATERIA DE FIGURINHAS — auditoria de conformidade com a spec do WhatsApp.
//
// Gera entradas sintéticas de vários tipos (rotação de celular, 16:9, vertical,
// quadrado, GIF, WebM/VP9, 10 fps, 60 fps, abertura preta, vídeo de 90 s, clipe
// de 0,4 s, cena escura/clara, fundo liso, ruído puro, detalhe extremo, foto) e
// confere CADA saída contra o que o WhatsApp aceita:
//
//   • exatamente 512×512;
//   • estática ≤ 100 KB, animada ≤ 500 KB;
//   • animação ≤ 10 s e nenhum quadro abaixo de 8 ms;
//   • duração preservada (só encurta para tirar abertura morta ou quando o
//     conteúdo é incompressível — aí o relatório marca `emergency`);
//   • vídeo que se mexe não vira figurinha parada.
//
// Uso:  node scripts/sticker-battery.mjs [filtro]
//   filtro é opcional (substring do nome do caso), ex.: node scripts/sticker-battery.mjs gif
//
// Sai com código 1 se qualquer caso violar a spec.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { toStickerWebp } from '../src/util/ffmpeg.js';
import { isAnimatedWebp, parseWebp, tagSticker, webpDurationMs } from '../src/util/webp.js';
import { analyzeSource, deadLeadFrames, windowMotion } from '../src/util/stickerbrain.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const filter = process.argv[2] || '';
const STATIC_MAX = 100 * 1024;
const ANIM_MAX = 500 * 1024;
const MAX_SECONDS = 10;

const FF = process.env.FFMPEG_BIN || 'ffmpeg';
if (spawnSync(FF, ['-version']).status !== 0) {
  console.error('FFmpeg não encontrado no PATH — a bateria precisa dele para gerar as entradas.');
  process.exit(1);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sticker-battery-'));
const ff = (args) => {
  const r = spawnSync(FF, ['-v', 'error', '-y', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg falhou: ${args.join(' ')}\n${(r.stderr || '').slice(0, 300)}`);
};

/** Matriz de exibição 90° no tkhd: é o que um celular grava em vídeo deitado. */
function rotateMp4(file) {
  const src = fs.readFileSync(file);
  const idx = src.indexOf(Buffer.from('tkhd'));
  if (idx < 0) throw new Error('tkhd não encontrado para rotacionar');
  const payload = idx + 4;
  const matrix = [0, 0x00010000, 0, -0x10000, 0, 0, 0, 0, 0x00010000];
  const out = Buffer.from(src);
  matrix.forEach((v, i) => out.writeUInt32BE(v >>> 0, payload + 40 + i * 4));
  const w = Buffer.from(out.subarray(payload + 76, payload + 80));
  const h = Buffer.from(out.subarray(payload + 80, payload + 84));
  w.copy(out, payload + 80);
  h.copy(out, payload + 76);
  fs.writeFileSync(file, out);
}

/** Duração de cada quadro ANMF (ms) do WebP animado. */
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

function buildFixtures() {
  const f = (name) => path.join(dir, name);

  // Celular: grava em retrato, codifica deitado e marca a rotação na matriz.
  ff(['-f', 'lavfi', '-i', 'color=c=0x101820:s=480x640:d=4:r=15',
    '-f', 'lavfi', '-i', 'color=c=0xff8c00:s=200x200:d=4:r=15',
    '-filter_complex', "[0][1]overlay=x='140+60*sin(3*t)':y='380+40*sin(2*t)'",
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f('tmp-portrait.mp4')]);
  ff(['-i', f('tmp-portrait.mp4'), '-vf', 'transpose=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f('rot-celular.mp4')]);
  rotateMp4(f('rot-celular.mp4'));
  fs.rmSync(f('tmp-portrait.mp4'), { force: true });

  ff(['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f('land-720p.mp4')]);
  ff(['-f', 'lavfi', '-i', 'color=c=0x203040:s=608x1080:d=8:r=30',
    '-f', 'lavfi', '-i', 'color=c=0xffcc33:s=220x220:d=8:r=30',
    '-filter_complex', "[0][1]overlay=x='100+180*sin(1.7*t)':y='400+260*sin(1.1*t)'",
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f('port-1080p.mp4')]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=600x600:r=15:d=5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f('square-600.mp4')]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=640x480:r=25:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f('four-three.mp4')]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=720x1280:r=10:d=7', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f('fps10.mp4')]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=60:d=5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f('fps60.mp4')]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=480x480:r=12:d=4',
    '-vf', 'split[a][b];[a]palettegen=max_colors=64[p];[b][p]paletteuse=dither=bayer', f('anim.gif')]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=640x640:r=15:d=6', '-c:v', 'libvpx-vp9', '-crf', '34', '-b:v', '0', '-pix_fmt', 'yuv420p', f('video.webm')]);
  ff(['-f', 'lavfi', '-i', 'color=c=0x2a4a2a:s=640x640:d=5:r=15',
    '-vf', 'drawbox=x=200:y=200:w=240:h=240:color=0xf2f2f2:t=fill', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f('parado.mp4')]);
  ff(['-f', 'lavfi', '-i', 'color=c=black:s=640x640:d=2:r=15',
    '-f', 'lavfi', '-i', 'color=c=0x2a4a2a:s=640x640:d=5:r=15',
    '-f', 'lavfi', '-i', 'color=c=0xf2f2f2:s=200x200:d=5:r=15',
    '-filter_complex', "[1][2]overlay=x='180+120*sin(2*t)':y='220+80*sin(1.5*t)'[v];[0][v]concat=n=2:v=1:a=0",
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f('preto-intro.mp4')]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=480x270:r=15:d=90', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f('longo-90.mp4')]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=480x480:r=15:d=0.4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f('curto-04.mp4')]);
  ff(['-f', 'lavfi', '-i', 'color=c=0x050608:s=640x640:d=5:r=15',
    '-f', 'lavfi', '-i', 'color=c=0x30507a:s=180x180:d=5:r=15',
    '-filter_complex', "[0][1]overlay=x='230+60*sin(2*t)':y='230+60*cos(2*t)'",
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f('escuro.mp4')]);
  ff(['-f', 'lavfi', '-i', 'color=c=0xf0f0f0:s=640x640:d=5:r=15',
    '-f', 'lavfi', '-i', 'color=c=0x202020:s=200x200:d=5:r=15',
    '-filter_complex', "[0][1]overlay=x='220+90*sin(2.2*t)':y='220+90*cos(1.8*t)'",
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f('claro.mp4')]);
  ff(['-f', 'lavfi', '-i', 'color=c=0x1e8c3c:s=640x640:d=6:r=15',
    '-f', 'lavfi', '-i', 'color=c=0xf2f2f2:s=240x240:d=6:r=15',
    '-filter_complex', "[0][1]overlay=x='180+160*sin(2.4*t)':y='200+120*sin(1.9*t)'",
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f('fundo-liso.mp4')]);
  ff(['-f', 'lavfi', '-i', 'nullsrc=s=512x512:r=15:d=6,geq=random(1)*255:128:128', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f('ruido.mp4')]);
  ff(['-f', 'lavfi', '-i', 'mandelbrot=s=512x512:r=15', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f('detalhe.mp4')]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=512x512:r=15:d=5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f('ja512.mp4')]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=900x900:r=15:d=1', '-frames:v', '1', f('foto.jpg')]);
  return f;
}

const cases = [
  ['rot-celular.mp4', 'video', 'celular com rotação (retrato)'],
  ['land-720p.mp4', 'video', '16:9 720p 30 fps'],
  ['port-1080p.mp4', 'video', 'vertical 1080p'],
  ['square-600.mp4', 'video', 'quadrado 600'],
  ['four-three.mp4', 'video', '4:3 25 fps'],
  ['fps10.mp4', 'video', 'fonte 10 fps'],
  ['fps60.mp4', 'video', 'fonte 60 fps'],
  ['anim.gif', 'gif', 'GIF'],
  ['video.webm', 'video', 'WebM VP9'],
  ['parado.mp4', 'video', 'sem movimento → estática'],
  ['preto-intro.mp4', 'video', 'abertura preta'],
  ['longo-90.mp4', 'video', '90 s (analisa até 60 s)'],
  ['curto-04.mp4', 'video', '0,4 s'],
  ['escuro.mp4', 'video', 'cena escura'],
  ['claro.mp4', 'video', 'cena clara'],
  ['fundo-liso.mp4', 'video', 'fundo liso (recorte)'],
  ['ruido.mp4', 'video', 'ruído puro (incompressível)'],
  ['detalhe.mp4', 'video', 'Mandelbrot (detalhe extremo)'],
  ['ja512.mp4', 'video', 'fonte já 512×512'],
  ['foto.jpg', 'image', 'foto JPEG (estática)']
].filter(([, , label]) => !filter || label.includes(filter) || label.toLowerCase().includes(filter.toLowerCase()));

console.log(`Gerando ${cases.length} entradas em ${dir} …`);
buildFixtures();

const rows = [];
let fails = 0;
for (const [file, type, label] of cases) {
  const input = fs.readFileSync(path.join(dir, file));
  const isImage = type === 'image';
  const t0 = Date.now();
  let out = null;
  let error = null;
  try {
    out = await toStickerWebp(input, { animated: !isImage, ext: path.extname(file), fit: 'fill', onProgress: async () => {} });
  } catch (e) {
    error = String(e?.message || e).slice(0, 90);
  }
  const ms = Date.now() - t0;
  const problems = [];
  const row = { label, mode: '—', out: '—', decision: '—', fill: '—', ms, problems };
  if (error) problems.push(`erro: ${error}`);
  if (out) {
    const { buffer: raw, animated, smart } = out;
    // A auditoria mede o arquivo COMO ELE SAI para o WhatsApp: com VP8X + EXIF
    // do pack (é esse tamanho que o WhatsApp valida contra os 500 KB).
    const webp = tagSticker(raw, { pack: 'MontxBOT', author: 'nexus-bot', emojis: ['🔥'] });
    const info = parseWebp(webp);
    const anim = isAnimatedWebp(webp);
    const kb = Math.round(webp.length / 1024);
    const dur = anim ? webpDurationMs(webp) : 0;
    const frames = anim ? frameDurations(webp) : [];
    row.mode = smart ? (smart.mode === 'static' ? 'estática' : 'animada') : anim ? 'animada (escada)' : 'estática (escada)';
    row.out = `512×512${anim ? ` · ${frames.length}q · ${(dur / 1000).toFixed(2)}s` : ''} · ${kb} KB`;
    row.decision = smart
      ? `${smart.startSeconds}s · q${smart.q}${smart.crop ? ` · crop ${smart.crop}` : ''}${smart.cut ? ' · fundo liso' : ''}${smart.emergency ? ` · trava ${smart.emergency}` : ''}`
      : '—';
    // Aproveitamento do limite: o motor enche o orçamento com fidelidade
    // (qualidade até 100 e sem perdas quando cabe), então isto mostra se sobrou
    // espaço que o conteúdo simplesmente não tem como usar.
    row.fillInfo = smart?.fill || null;
    if (smart?.fill) {
      row.fill = `${Math.round(smart.fill.ratio * 100)}%${smart.fill.lossless ? ' sem perdas' : ''}${smart.fill.emergency ? ' (trava)' : ''}`;
    }

    if (info.width !== 512 || info.height !== 512) problems.push(`dimensões ${info.width}×${info.height}`);
    if (anim && webp.length > ANIM_MAX) problems.push(`${kb} KB > 500 KB`);
    if (!anim && webp.length > STATIC_MAX) problems.push(`${kb} KB > 100 KB`);
    if (anim && dur > MAX_SECONDS * 1000) problems.push(`duração ${dur} ms > 10 s`);
    if (anim && frames.some((f) => f < 8)) problems.push('quadro abaixo de 8 ms');
    if (anim && frames.length < 2) problems.push('animada com 1 quadro');

    let src = null;
    try {
      src = await analyzeSource(path.join(dir, file), { ffmpegBin: FF });
    } catch {}
    const srcMs = src?.durationMs ?? 0;
    const dead = src ? deadLeadFrames(src, { start: 0, end: src.frameCount - 1 }) : 0;
    if (anim && srcMs > 800 && srcMs <= MAX_SECONDS * 1000 && dur < srcMs * 0.85 && webp.length < ANIM_MAX * 0.8 && dead === 0 && !smart?.emergency) {
      problems.push(`perdeu duração sem precisar (${dur} de ${srcMs} ms)`);
    }
    if (smart?.startSeconds > 1.2 && dead === 0 && !smart?.emergency) problems.push(`começou em ${smart.startSeconds}s sem abertura morta`);
    if (!isImage && src && windowMotion(src, 0, src.frameCount - 1) > 0.02 && !anim) problems.push('tinha movimento e saiu estática');
  }
  if (problems.length) fails++;
  rows.push(row);
}

console.log('\n| Caso | Modo | Saída | Decisão | Limite | Tempo | Veredito |');
console.log('| --- | --- | --- | --- | --- | --- | --- |');
for (const r of rows) {
  console.log(`| ${r.label} | ${r.mode} | ${r.out} | ${r.decision} | ${r.fill} | ${(r.ms / 1000).toFixed(1)}s | ${r.problems.length ? `❌ ${r.problems.join('; ')}` : '✅'} |`);
}
const animRows = rows.filter((r) => r.mode === 'animada' && r.fillInfo);
if (animRows.length) {
  const comPerdas = animRows.filter((r) => !r.fillInfo.lossless && !r.fillInfo.emergency);
  const ratios = comPerdas.map((r) => r.fillInfo.ratio);
  const media = ratios.length ? Math.round((ratios.reduce((a, b) => a + b, 0) / ratios.length) * 100) : 0;
  const semPerdas = animRows.filter((r) => r.fillInfo.lossless).length;
  const travadas = animRows.filter((r) => r.fillInfo.emergency).length;
  console.log(
    `\nAproveitamento do limite (arquivo final, com EXIF): ${media}% nas ${comPerdas.length} animadas com perdas` +
      `${semPerdas ? ` · ${semPerdas} saíram SEM PERDAS (pixel-perfect, o máximo que o WebP entrega)` : ''}` +
      `${travadas ? ` · ${travadas} travada(s) pela spec (conteúdo incompressível)` : ''}.`
  );
}
console.log(`\n${rows.length - fails}/${rows.length} casos dentro da spec do WhatsApp.`);
if (fails) console.log('Saídas fora do padrão seriam recusadas pelo WhatsApp — corrija antes de subir.');
fs.rmSync(dir, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
