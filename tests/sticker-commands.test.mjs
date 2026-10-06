// `.s` permanece simples; `.sia` e seus apelidos usam o planejador natural de figurinha.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.NEXUS_DATA_DIR ||= new URL('./tmp-data', import.meta.url).pathname;

import { handleMessage } from '../src/features/router.js';
import { publicMenu, ownerMenu, stickerMenu, mainMenu } from '../src/features/menu.js';
import { bgPools } from '../src/features/bgremoval.js';
import { SYM, usage } from '../src/core/ui.js';
import { setDnsLookupForTests } from '../src/core/http.js';
import { alphaCoverage } from '../src/util/ffmpeg.js';
import { isAnimatedWebp, parseWebp, readStickerExif, webpDurationMs } from '../src/util/webp.js';

setDnsLookupForTests(async () => [{ address: '8.8.8.8', family: 4 }]);

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

/* ───────────────────────── harness do roteador ───────────────────────── */

const OWNER_JID = '5511900000000@s.whatsapp.net';

function makeSock() {
  const sent = [];
  return {
    sent,
    user: { id: '5511900000000:1@s.whatsapp.net', name: 'NEXUS' },
    sendMessage: async (jid, content, opts) => {
      sent.push({ jid, content, quoted: opts?.quoted?.key?.id || null });
      return { key: { id: `SENT${sent.length}`, remoteJid: jid } };
    },
    updateMediaMessage: async () => {
      throw new Error('sem mídia no mock');
    }
  };
}

function ownerDeps(sock) {
  return {
    type: 'notify',
    ownerJid: OWNER_JID,
    isOwner: (jid, participant) => [jid, participant].includes(OWNER_JID) || jid === sock.user.id,
    isOwnerPrivateChat: (jid) => jid === OWNER_JID,
    sendOwner: async () => {}
  };
}

function textMsg(text, jid = OWNER_JID) {
  return {
    key: { remoteJid: jid, id: `CMD${Math.random().toString(36).slice(2)}`, fromMe: true },
    pushName: 'Dono',
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: { conversation: text }
  };
}

/** Manda um comando no privado do dono e devolve o que o bot respondeu. */
async function run(text) {
  const sock = makeSock();
  await handleMessage(sock, textMsg(text), ownerDeps(sock));
  const texts = sock.sent.map((s) => s.content.text).filter((t) => typeof t === 'string');
  const stickers = sock.sent.filter((s) => s.content.sticker).map((s) => s.content);
  return { texts, stickers, last: texts.at(-1) || '' };
}

function bufferResponse(buf, { status = 200, contentType = 'image/png' } = {}) {
  return new Response(buf, { status, headers: { 'content-type': contentType, 'content-length': String(buf.length) } });
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

async function withMockFetch(routes, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const target = String(url);
    for (const [matcher, reply] of routes) {
      if (target.includes(matcher)) {
        const response = typeof reply === 'function' ? reply(target, opts) : reply;
        if (!(response instanceof Response)) return response;
        const body = response.body ? await response.clone().arrayBuffer() : null;
        return new Response(body, { status: response.status, headers: response.headers });
      }
    }
    throw new Error(`fetch sem rota no mock: ${target}`);
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function ffmpegOk(args) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args]);
  assert.equal(r.status, 0, String(r.stderr || ''));
}

/** Confere a figurinha FINAL (com EXIF do pack) contra os limites do WhatsApp. */
function assertSentSticker(sticker, { animated = false } = {}) {
  assert.ok(sticker, 'o bot enviou uma figurinha');
  const info = parseWebp(sticker.sticker);
  assert.equal(info.width, 512);
  assert.equal(info.height, 512);
  assert.equal(isAnimatedWebp(sticker.sticker), animated);
  assert.equal(sticker.isAnimated, animated);
  assert.ok(sticker.sticker.length <= (animated ? 500 : 100) * 1024, `peso ${sticker.sticker.length} B`);
  assert.ok(readStickerExif(sticker.sticker)?.pack?.length > 0, 'EXIF com o nome do pack');
  if (animated) {
    const frames = info.chunks.filter((chunk) => chunk.type === 'ANMF').map((chunk) => chunk.data.readUIntLE(12, 3));
    assert.ok(frames.length > 1, 'animação tem mais de um quadro');
    assert.ok(Math.min(...frames) >= 8, 'nenhum quadro abaixo de 8 ms');
    assert.ok(webpDurationMs(sticker.sticker) <= 10_000, 'animação dentro do teto de 10 s');
  }
}

/* ───────────────────────── `.s` e guia do `.sia` ───────────────────────── */

const OLD_S_HELP = usage(
  '.s',
  '.s https://br.pinterest.com/pin/123/',
  'Envie/responda uma imagem, vídeo ou GIF — ou mande o link que eu baixo e monto a figurinha.'
);

test('sem mídia: .s, .fig e .figu respondem exatamente a ajuda de antes', async () => {
  for (const cmd of ['.s', '.fig', '.figu', '.s liso', '.s hd 6s', '.s curto']) {
    const { last, stickers } = await run(cmd);
    assert.equal(stickers.length, 0, cmd);
    assert.equal(last, OLD_S_HELP, `${cmd}: a ajuda do .s é a de antes`);
    assert.doesNotMatch(last, /liso|\bhd\b|curto|\b6s\b|10 s|\.sia|\.figurinha|\.sticker|\.stiker/, cmd);
  }
});

test('sem mídia: .sia e os apelidos antigos mostram o novo guia, sem erro e sem chamar IA', async (t) => {
  const originalFetch = globalThis.fetch;
  let pollinations = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes('text.pollinations.ai')) pollinations++;
    throw new Error(`não deveria chamar ${url}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const pieces = [
    'Figurinha com IA',
    'peça do seu jeito',
    'Responda uma foto, vídeo, GIF ou figurinha (ou mande um link) com:',
    '.sia',
    'automático: melhor trecho, loop fechado e assunto enquadrado',
    '.sia sem fundo, 10 segundos, bem fluida',
    '.sia nítida e sem esticar',
    '.sia só tira o fundo',
    '`.s` continua a figurinha simples e rápida, sem IA.'
  ];
  for (const cmd of ['.sia', '.figurinha', '.sticker', '.stiker', '.SIA sem fundo', '.figurinha quero um gato']) {
    const { texts, last, stickers } = await run(cmd);
    assert.equal(stickers.length, 0, cmd);
    assert.equal(texts.length, 1, `${cmd}: uma resposta só`);
    for (const piece of pieces) assert.ok(last.includes(piece), `${cmd}: falta "${piece}" no guia`);
    assert.equal(last.includes(SYM.err), false, `${cmd}: guia não é erro`);
    assert.doesNotMatch(last, /Como usar/, `${cmd}: guia não é a ajuda do .s`);
  }
  assert.equal(pollinations, 0, 'guia sem fonte não pede plano à IA');
});

test('menus anunciam .sia depois das linhas do .s, sem expor os apelidos ou os atalhos antigos', () => {
  const menus = {
    'público (grupo)': publicMenu(),
    'público (privado)': publicMenu({ isGroup: false }),
    dono: ownerMenu(),
    principal: mainMenu(),
    figurinhas: stickerMenu()
  };
  for (const [nome, texto] of Object.entries(menus)) {
    assert.match(texto, /`\.sia <pedido>` {2}› {2}peça do seu jeito e a IA monta a figurinha/, `${nome}: linha do .sia`);
    assert.doesNotMatch(texto, /\.figurinha|\.sticker|\.stiker/, `${nome}: apelido antigo não aparece`);
    assert.doesNotMatch(texto, /\.sia (?:fundo|hd|liso|curto|\d)/i, `${nome}: sem palavras manuais do comando antigo`);
  }
  const figurinhas = stickerMenu();
  assert.ok(figurinhas.indexOf('`.s cortar`') < figurinhas.indexOf('`.sia <pedido>`'));
  assert.ok(figurinhas.indexOf('`.sia <pedido>`') < figurinhas.indexOf('`.sfundo`'));
  for (const cmd of ['.s inteira', '.s cortar', '.s <link>', '.sia <pedido>', '.sfundo', '.fundo', '.toimg', '.tovideo', '.tomp3', '.toptt']) {
    assert.ok(figurinhas.includes(`\`${cmd}\``), `menu de figurinhas mantém ${cmd}`);
  }
});

test('.s não faz chamadas de IA em .s, .s fundo nem .s 10 segundos', async (t) => {
  const originalFetch = globalThis.fetch;
  let pollinations = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes('text.pollinations.ai')) pollinations++;
    throw new Error(`rede inesperada: ${url}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  for (const cmd of ['.s', '.s fundo', '.s 10 segundos']) await run(cmd);
  assert.equal(pollinations, 0);
});

/* ───────────────────────── ponta a ponta (FFmpeg, quando instalado) ───────────────────────── */

test('ponta a ponta: .s clássico não recorta nem chama IA; .sia e apelidos recortam o fundo liso', { skip: !hasFfmpeg }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sia-flat-'));
  const flat = path.join(dir, 'lisa.png');
  ffmpegOk(['-f', 'lavfi', '-i', 'color=c=0x1e8c3c:s=640x640', '-vf', 'drawbox=x=220:y=220:w=200:h=200:color=0xf0f0f0:t=fill', '-frames:v', '1', flat]);
  const url = 'https://i.pinimg.com/originals/ab/cd/lisa.png';
  let pollinations = 0;
  try {
    await withMockFetch([
      [url, bufferResponse(fs.readFileSync(flat))],
      ['text.pollinations.ai', () => (pollinations++, jsonResponse({ choices: [{ message: { content: '{"fundo":"auto","duracao":0,"estilo":"auto","enquadramento":"auto","avisos":[]}' } }] }))]
    ], async () => {
      for (const cmd of [`.s ${url}`, `.fig ${url}`, `.s fundo ${url}`, `.s 10 segundos ${url}`]) {
        const { stickers, last } = await run(cmd);
        assertSentSticker(stickers[0]);
        assert.match(last, /Figurinha pronta/);
        const alpha = await alphaCoverage(stickers[0].sticker);
        assert.ok(alpha > 0.99, `${cmd}: o .s não recorta fundo (alfa ${alpha})`);
      }
      assert.equal(pollinations, 0, 'as variantes do .s nunca chamam a IA');

      for (const cmd of [`.sia ${url}`, `.figurinha ${url}`, `.sticker ${url}`, `.stiker ${url}`]) {
        const { stickers, last } = await run(cmd);
        assertSentSticker(stickers[0]);
        assert.match(last, /Figurinha pronta/);
        const alpha = await alphaCoverage(stickers[0].sticker);
        assert.ok(alpha > 0.02 && alpha < 0.5, `${cmd}: o motor recorta o fundo liso (alfa ${alpha})`);
      }
      assert.equal(pollinations, 0, 'pedido vazio com link usa o plano automático sem IA');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ponta a ponta: foto complexa usa provedor quando disponível; vídeo, GIF e figurinha animada nunca usam rembg', { skip: !hasFfmpeg }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sia-bg-'));
  const complex = path.join(dir, 'complexa.png');
  const cut = path.join(dir, 'recortada.png');
  const clip = path.join(dir, 'complexo.mp4');
  const staticClip = path.join(dir, 'parado.mp4');
  const gif = path.join(dir, 'complexo.gif');
  ffmpegOk(['-f', 'lavfi', '-i', 'testsrc2=s=640x640:r=15:d=1', '-vf', 'drawbox=x=220:y=220:w=200:h=200:color=0xf0f0f0:t=fill', '-frames:v', '1', complex]);
  ffmpegOk([
    '-f', 'lavfi', '-i', 'color=c=black@0:s=640x640,format=rgba',
    '-f', 'lavfi', '-i', 'color=c=0xf0f0f0:s=200x200',
    '-filter_complex', '[0][1]overlay=x=220:y=220', '-frames:v', '1', cut
  ]);
  ffmpegOk(['-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=15:d=2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', clip]);
  ffmpegOk(['-loop', '1', '-i', complex, '-t', '2', '-vf', 'fps=15', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', staticClip]);
  ffmpegOk(['-i', clip, '-vf', 'fps=10,scale=320:-1:flags=lanczos', '-loop', '0', gif]);

  const photoUrl = 'https://i.pinimg.com/originals/ab/cd/complexa.png';
  const videoUrl = 'https://i.pinimg.com/originals/ab/cd/complexo.mp4';
  const gifUrl = 'https://i.pinimg.com/originals/ab/cd/complexo.gif';
  const staticVideoUrl = 'https://i.pinimg.com/originals/ab/cd/parado.mp4';
  const animatedStickerUrl = 'https://i.pinimg.com/originals/ab/cd/animada.webp';
  const endpoint = 'https://removebg.test/api';
  const pool = bgPools().endpoints.items;
  const previousFlag = process.env.STICKER_AI_CUT;
  delete process.env.STICKER_AI_CUT;
  let posts = 0;
  let plans = 0;
  let animatedSticker = null;
  const routes = [
    [photoUrl, bufferResponse(fs.readFileSync(complex))],
    [videoUrl, bufferResponse(fs.readFileSync(clip), { contentType: 'video/mp4' })],
    [staticVideoUrl, bufferResponse(fs.readFileSync(staticClip), { contentType: 'video/mp4' })],
    [gifUrl, bufferResponse(fs.readFileSync(gif), { contentType: 'image/gif' })],
    [animatedStickerUrl, () => bufferResponse(animatedSticker, { contentType: 'image/webp' })],
    ['text.pollinations.ai', (_target, opts) => {
      plans++;
      const request = JSON.parse(opts.body).messages[0].content;
      assert.doesNotMatch(request, new RegExp(photoUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.doesNotMatch(request, new RegExp(videoUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      return jsonResponse({ choices: [{ message: { content: '{"fundo":"remover","duracao":0,"estilo":"auto","enquadramento":"auto","avisos":[]}' } }] });
    }],
    [endpoint, () => (posts++, bufferResponse(fs.readFileSync(cut)))]
  ];

  try {
    await withMockFetch(routes, async () => {
      const noProvider = await run(`.sia sem fundo ${photoUrl}`);
      assertSentSticker(noProvider.stickers[0]);
      assert.match(noProvider.last, /Fundo mantido/);
      assert.match(noProvider.last, /não há provedor de remoção de fundo configurado/);
      assert.equal(posts, 0, 'sem provedor, não há chamada de recorte');

      pool.push(endpoint);
      const photo = await run(`.sia sem fundo ${photoUrl}`);
      assertSentSticker(photo.stickers[0]);
      assert.equal(posts, 1, 'a foto com fundo complexo usa exatamente uma chamada de remoção');
      const alpha = await alphaCoverage(photo.stickers[0].sticker);
      assert.ok(alpha > 0.02 && alpha < 0.6, `o fundo da foto foi recortado (alfa ${alpha})`);

      const video = await run(`.sia sem fundo ${videoUrl}`);
      assertSentSticker(video.stickers[0], { animated: true });
      assert.match(video.last, /Fundo mantido/);
      assert.match(video.last, /em vídeo, GIF ou figurinha animada, só removo fundo liso/);
      assert.equal(posts, 1, 'vídeo complexo nunca recebe removeBg nem chama um provedor por quadro');

      const gifResult = await run(`.sia sem fundo ${gifUrl}`);
      assertSentSticker(gifResult.stickers[0], { animated: true });
      assert.match(gifResult.last, /em vídeo, GIF ou figurinha animada, só removo fundo liso/);
      assert.equal(posts, 1, 'GIF complexo nunca recebe removeBg nem chama um provedor por quadro');

      process.env.STICKER_AI_CUT = '1';
      const staticVideo = await run(`.sia sem fundo ${staticVideoUrl}`);
      assertSentSticker(staticVideo.stickers[0]);
      assert.match(staticVideo.last, /parada/);
      assert.equal(posts, 1, 'nem um vídeo estático pode enviar um quadro ao provedor pela rota .sia');

      animatedSticker = video.stickers[0].sticker;
      const animated = await run(`.sia sem fundo ${animatedStickerUrl}`);
      assertSentSticker(animated.stickers[0], { animated: true });
      assert.match(animated.last, /em vídeo, GIF ou figurinha animada, só removo fundo liso/);
      assert.equal(posts, 1, 'figurinha animada nunca recebe removeBg nem chama um provedor por quadro');
      assert.equal(plans, 6, 'cada pedido natural gera um plano, não uma chamada por fonte');
    });
  } finally {
    const index = pool.indexOf(endpoint);
    if (index >= 0) pool.splice(index, 1);
    if (previousFlag === undefined) delete process.env.STICKER_AI_CUT;
    else process.env.STICKER_AI_CUT = previousFlag;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
