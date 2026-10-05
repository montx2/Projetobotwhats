// `.s` × `.figurinha` no roteador: o que o usuário digita e o que volta.
//
//   • `.s`/`.fig`/`.figu` sem mídia → exatamente a ajuda de antes (sem liso,
//     hd, curto, 6s e sem citar o `.figurinha`);
//   • `.figurinha`/`.sticker`/`.stiker` sem mídia (com ou sem palavras) → o
//     guia curto, nunca um erro;
//   • nenhum menu mostra o `.figurinha` nem as palavras de ajuste;
//   • com FFmpeg, de ponta a ponta: o `.s` sai pelo motor clássico (estica,
//     não recorta fundo, nunca chama IA) e o `.figurinha` pelo motor
//     inteligente (recorta fundo liso, chama a IA quando pode ou quando pedem).

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
import { isAnimatedWebp, parseWebp, readStickerExif } from '../src/util/webp.js';

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

/** Figurinha enviada dentro da spec: 512×512, peso no limite, EXIF do pack. */
function assertSentSticker(sticker, { animated = false } = {}) {
  assert.ok(sticker, 'o bot enviou uma figurinha');
  const info = parseWebp(sticker.sticker);
  assert.equal(info.width, 512);
  assert.equal(info.height, 512);
  assert.equal(isAnimatedWebp(sticker.sticker), animated);
  assert.equal(sticker.isAnimated, animated);
  assert.ok(sticker.sticker.length <= (animated ? 500 : 100) * 1024, `peso ${sticker.sticker.length} B`);
  assert.ok(readStickerExif(sticker.sticker)?.pack?.length > 0, 'EXIF com o nome do pack');
}

/* ───────────────────────── sem mídia: ajuda × guia ───────────────────────── */

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
    assert.doesNotMatch(last, /liso|\bhd\b|curto|\b6s\b|10 s|\.figurinha|\.sticker|\.stiker/, cmd);
  }
});

test('sem mídia: .figurinha, .sticker e .stiker mostram o guia curto (nunca erro)', async () => {
  const pieces = [
    'Figurinha',
    'ajustes finos',
    'Responda uma mídia (ou mande um link) com',
    'automático: melhor trecho, loop fechado e assunto enquadrado',
    '.figurinha fundo',
    'remove o fundo (IA)',
    '.figurinha hd',
    '.figurinha liso',
    '.figurinha curto',
    '.figurinha 6s',
    'duração exata (2 a 10 s)',
    '.figurinha inteira',
    '.figurinha cortar',
    'pode combinar: `.figurinha fundo hd 6s`',
    '`.s` continua a figurinha simples, esticada por padrão.'
  ];
  for (const cmd of ['.figurinha', '.sticker', '.stiker', '.FIGURINHA', '.figurinha fundo', '.figurinha hd 6s', '.sticker xyz']) {
    const { texts, last, stickers } = await run(cmd);
    assert.equal(stickers.length, 0, cmd);
    assert.equal(texts.length, 1, `${cmd}: uma resposta só`);
    for (const piece of pieces) assert.ok(last.includes(piece), `${cmd}: falta "${piece}" no guia`);
    assert.equal(last.includes(SYM.err), false, `${cmd}: guia não é erro`);
    assert.doesNotMatch(last, /Como usar/, `${cmd}: guia não é a ajuda do .s`);
  }
});

test('menus: o .figurinha não aparece em nenhum; o .s voltou ao de antes', () => {
  const menus = {
    'público (grupo)': publicMenu(),
    'público (privado)': publicMenu({ isGroup: false }),
    dono: ownerMenu(),
    principal: mainMenu(),
    figurinhas: stickerMenu()
  };
  for (const [nome, texto] of Object.entries(menus)) {
    assert.doesNotMatch(texto, /\.figurinha|\.sticker|\.stiker/, `${nome}: comando escondido apareceu`);
    assert.doesNotMatch(texto, /\.s (liso|hd|curto|\d)/, `${nome}: ajuste do .figurinha no menu do .s`);
    assert.doesNotMatch(texto, /figurinha inteligente|até 10 s/, `${nome}: descrição do motor no .s`);
  }
  const figurinhas = stickerMenu();
  assert.match(figurinhas, /`\.s` {2}› {2}foto, vídeo ou GIF vira figurinha\n/);
  for (const cmd of ['.s inteira', '.s cortar', '.s <link>', '.sfundo', '.fundo', '.toimg', '.tovideo', '.tomp3', '.toptt']) {
    assert.ok(figurinhas.includes(`\`${cmd}\``), `menu de figurinhas mantém ${cmd}`);
  }
});

/* ───────────────────────── de ponta a ponta (FFmpeg) ───────────────────────── */

test('ponta a ponta: .s estica sem recortar; .figurinha recorta o fundo liso', { skip: !hasFfmpeg }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-flat-'));
  const flat = path.join(dir, 'lisa.png');
  ffmpegOk(['-f', 'lavfi', '-i', 'color=c=0x1e8c3c:s=640x640', '-vf', 'drawbox=x=220:y=220:w=200:h=200:color=0xf0f0f0:t=fill', '-frames:v', '1', flat]);
  const url = 'https://i.pinimg.com/originals/ab/cd/lisa.png';
  try {
    await withMockFetch([[url, bufferResponse(fs.readFileSync(flat))]], async () => {
      for (const cmd of [`.s ${url}`, `.fig ${url}`, `.s fundo ${url}`]) {
        const { stickers, last } = await run(cmd);
        assertSentSticker(stickers[0]);
        assert.match(last, /Figurinha pronta/);
        const alpha = await alphaCoverage(stickers[0].sticker);
        assert.ok(alpha > 0.99, `${cmd}: o .s não recorta fundo (alfa ${alpha})`);
      }
      for (const cmd of [`.figurinha ${url}`, `.sticker ${url}`]) {
        const { stickers, last } = await run(cmd);
        assertSentSticker(stickers[0]);
        assert.match(last, /Figurinha pronta/);
        const alpha = await alphaCoverage(stickers[0].sticker);
        assert.ok(alpha > 0.02 && alpha < 0.5, `${cmd}: o motor recorta o fundo liso (alfa ${alpha})`);
      }
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ponta a ponta: o .s nunca chama a IA; o .figurinha chama quando pode ou quando pedem', { skip: !hasFfmpeg }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-ai-'));
  const complex = path.join(dir, 'complexa.png');
  const cut = path.join(dir, 'recortada.png');
  // Foto com fundo de blocos coloridos (a chave de cor não resolve) e um quadrado claro.
  ffmpegOk(['-f', 'lavfi', '-i', 'testsrc2=s=640x640:r=15:d=1', '-vf', 'drawbox=x=220:y=220:w=200:h=200:color=0xf0f0f0:t=fill', '-frames:v', '1', complex]);
  // O que a "IA" devolve: o quadrado com fundo transparente.
  ffmpegOk([
    '-f', 'lavfi', '-i', 'color=c=black@0:s=640x640,format=rgba',
    '-f', 'lavfi', '-i', 'color=c=0xf0f0f0:s=200x200',
    '-filter_complex', '[0][1]overlay=x=220:y=220', '-frames:v', '1', cut
  ]);
  const url = 'https://i.pinimg.com/originals/ab/cd/complexa.png';
  const endpoint = 'https://removebg.test/api';
  let posts = 0;
  const pool = bgPools().endpoints.items;
  const previousFlag = process.env.STICKER_AI_CUT;
  pool.push(endpoint);
  process.env.STICKER_AI_CUT = '1'; // recorte automático por IA liberado
  try {
    await withMockFetch(
      [
        [url, bufferResponse(fs.readFileSync(complex))],
        [endpoint, () => (posts++, bufferResponse(fs.readFileSync(cut)))]
      ],
      async () => {
        for (const cmd of [`.s ${url}`, `.s fundo ${url}`]) {
          const { stickers } = await run(cmd);
          assertSentSticker(stickers[0]);
          assert.equal(posts, 0, `${cmd}: o .s não gasta IA`);
          assert.ok((await alphaCoverage(stickers[0].sticker)) > 0.9, `${cmd}: fundo intacto`);
        }
        const auto = await run(`.figurinha ${url}`);
        assertSentSticker(auto.stickers[0]);
        assert.equal(posts, 1, '.figurinha: fundo complexo passa pela IA (opt-in ligado)');
        const alphaAuto = await alphaCoverage(auto.stickers[0].sticker);
        assert.ok(alphaAuto > 0.04 && alphaAuto < 0.6, `recorte automático (alfa ${alphaAuto})`);

        const pedido = await run(`.figurinha fundo ${url}`);
        assertSentSticker(pedido.stickers[0]);
        assert.equal(posts, 2, '.figurinha fundo: uma chamada de remoção de fundo');
        const alphaPedido = await alphaCoverage(pedido.stickers[0].sticker);
        assert.ok(alphaPedido > 0.04 && alphaPedido < 0.6, `fundo removido (alfa ${alphaPedido})`);
      }
    );
  } finally {
    pool.splice(pool.indexOf(endpoint), 1);
    if (previousFlag === undefined) delete process.env.STICKER_AI_CUT;
    else process.env.STICKER_AI_CUT = previousFlag;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ponta a ponta: vídeo — .s avisa como antes; .figurinha anuncia os 10 s do motor', { skip: !hasFfmpeg }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-video-'));
  const clip = path.join(dir, 'clip.mp4');
  ffmpegOk(['-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=15:d=2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', clip]);
  const url = 'https://i.pinimg.com/originals/ab/cd/clip.mp4';
  try {
    await withMockFetch([[url, bufferResponse(fs.readFileSync(clip), { contentType: 'video/mp4' })]], async () => {
      const simples = await run(`.s ${url}`);
      assertSentSticker(simples.stickers[0], { animated: true });
      assert.ok(simples.texts.includes(`${SYM.wait} Convertendo vídeo/GIF em figurinha animada…`), 'aviso do .s de antes');
      assert.equal(simples.texts.some((t) => t.includes('até 10 s')), false, 'o .s não promete os 10 s do motor');

      const motor = await run(`.figurinha ${url}`);
      assertSentSticker(motor.stickers[0], { animated: true });
      assert.ok(motor.texts.includes(`${SYM.wait} Convertendo vídeo/GIF em figurinha animada (até 10 s)…`), 'aviso do motor');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
