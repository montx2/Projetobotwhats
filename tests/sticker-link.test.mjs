// Figurinha a partir de LINK: `.s <link>` baixa pelo downloader universal e
// monta o WebP sem o usuário precisar baixar nada antes.
//
// Cobre o que quebra na vida real:
//   • link de mídia direta (i.pinimg.com/....jpg) pula a cascata e baixa direto;
//   • link de página (pin.it, widget do Pinterest) usa o extrator da rede;
//   • extrator que devolve CAPA em vez de vídeo → figurinha estática, não vídeo;
//   • link só de áudio → erro claro em vez de WebP corrompido;
//   • mídia anexada continua tendo prioridade sobre o link no texto;
//   • carrossel/slideshow → usa a primeira FOTO;
//   • `.s link` de ponta a ponta no router manda mesmo uma figurinha (com FFmpeg).

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.NEXUS_DATA_DIR ||= new URL('./tmp-data', import.meta.url).pathname;

import {
  collectStickerLinks,
  detectSourceKind,
  downloadStickerSource,
  isDirectMediaUrl,
  makeStickerFromLink,
  normalizeStickerLink,
  quotedStickerText,
  stickerSourceFromBuffer,
  stickerSourcesForCommand
} from '../src/features/stickerlink.js';
import { parseFit } from '../src/features/sticker.js';
import { publicMenu, ownerMenu, stickerMenu, downloadMenu } from '../src/features/menu.js';
import { isAnimatedWebp, isWebp, readStickerExif } from '../src/util/webp.js';
import { detectMediaExt } from '../src/util/ffmpeg.js';
import { cobaltPool } from '../src/features/downloaders/cobalt.js';
import { handleMessage } from '../src/features/router.js';
import { setDnsLookupForTests } from '../src/core/http.js';

setDnsLookupForTests(async () => [{ address: '8.8.8.8', family: 4 }]);

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

/* ───────────────────────── mock de fetch ───────────────────────── */

function jsonResponse(body, { status = 200 } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { 'content-type': 'application/json' } });
}

function htmlResponse(html, { status = 200 } = {}) {
  return new Response(html, { status, headers: { 'content-type': 'text/html' } });
}

function bufferResponse(buf, { status = 200, contentType = 'image/jpeg' } = {}) {
  return new Response(buf, {
    status,
    headers: { 'content-type': contentType, 'content-length': String(buf.length) }
  });
}

/** PNG 1x1 real — serve de "foto" baixada nos testes offline. */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

async function freshResponse(response) {
  const body = response.body ? await response.clone().arrayBuffer() : null;
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

async function withMockFetch(routes, fn) {
  const original = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url, opts = {}) => {
    const target = String(url);
    requested.push({ url: target, opts });
    for (const [matcher, reply] of routes) {
      const hit = typeof matcher === 'string' ? target.includes(matcher) : matcher.test(target);
      if (hit) {
        const response = typeof reply === 'function' ? reply(target, opts) : reply;
        return response instanceof Response ? freshResponse(response) : response;
      }
    }
    throw new Error(`fetch sem rota no mock: ${target}`);
  };
  try {
    return await fn(requested);
  } finally {
    globalThis.fetch = original;
  }
}

/* ───────────────────────── detecção de link ───────────────────────── */

test('normalizeStickerLink: aceita http, www e domínio colado sem esquema', () => {
  assert.equal(normalizeStickerLink('https://br.pinterest.com/pin/123/'), 'https://br.pinterest.com/pin/123/');
  assert.equal(normalizeStickerLink('http://pin.it/abc'), 'http://pin.it/abc');
  assert.equal(normalizeStickerLink('www.tiktok.com/@x/video/1'), 'https://www.tiktok.com/@x/video/1');
  assert.equal(normalizeStickerLink('pin.it/abc123'), 'https://pin.it/abc123');
  assert.equal(normalizeStickerLink('i.pinimg.com/originals/a/b/c.jpg'), 'https://i.pinimg.com/originals/a/b/c.jpg');
  assert.equal(normalizeStickerLink('https://exemplo.com/foto.png,'), 'https://exemplo.com/foto.png');
});

test('normalizeStickerLink: recusa palavras soltas, espaços e nomes de arquivo', () => {
  assert.equal(normalizeStickerLink('inteira'), null);
  assert.equal(normalizeStickerLink('cortar'), null);
  assert.equal(normalizeStickerLink('uma frase com espaços'), null);
  assert.equal(normalizeStickerLink('figurinha.png'), null);
  assert.equal(normalizeStickerLink(''), null);
  assert.equal(normalizeStickerLink(null), null);
});

test('isDirectMediaUrl: distingue arquivo de mídia de página de rede social', () => {
  assert.equal(isDirectMediaUrl('https://i.pinimg.com/originals/ab/cd/x.jpg'), true);
  assert.equal(isDirectMediaUrl('https://media.giphy.com/media/abc/giphy.gif'), true);
  assert.equal(isDirectMediaUrl('https://cdn.exemplo.com/video.mp4?token=1'), true);
  assert.equal(isDirectMediaUrl('https://br.pinterest.com/pin/12345/'), false);
  assert.equal(isDirectMediaUrl('https://www.tiktok.com/@user/video/123'), false);
});

test('collectStickerLinks: pega links dos argumentos e da mensagem citada, sem repetir', () => {
  const links = collectStickerLinks(
    ['olha', 'https://pin.it/abc', 'https://pin.it/abc', 'pin.it/abc'],
    'vi isso aqui https://br.pinterest.com/pin/999/'
  );
  assert.deepEqual(links, ['https://pin.it/abc', 'https://br.pinterest.com/pin/999/']);
  assert.deepEqual(collectStickerLinks(['inteira'], 'nada'), []);
});

test('quotedStickerText: lê legenda e texto da mensagem citada', () => {
  const msg = {
    message: {
      extendedTextMessage: {
        text: '.s',
        contextInfo: { quotedMessage: { imageMessage: { caption: 'olha https://pin.it/xyz' } } }
      }
    }
  };
  assert.equal(quotedStickerText(msg), 'olha https://pin.it/xyz');
  assert.equal(quotedStickerText({ message: { conversation: '.s' } }), '');
});

/* ───────────────────────── tipo real pelos bytes ───────────────────────── */

test('detectSourceKind: o conteúdo manda, não o rótulo do extrator', () => {
  // Capa JPEG devolvida no lugar do vídeo → imagem.
  assert.equal(detectSourceKind(PNG_1PX, 'video'), 'image');
  assert.equal(detectSourceKind(Buffer.from('GIF89a....'), 'image'), 'gif');
  assert.equal(detectSourceKind(Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00]), ''), 'video');
  // Áudio declarado continua áudio mesmo com cabeçalho ftyp (m4a).
  assert.equal(detectSourceKind(Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00]), 'audio'), 'audio');
});

test('stickerSourceFromBuffer: traduz o tipo para o motor de figurinhas', () => {
  const photo = stickerSourceFromBuffer(PNG_1PX, 'video');
  assert.equal(photo.type, 'image');
  assert.equal(photo.kind, 'image');
  assert.match(photo.node.mimetype, /^image\//);

  const gif = stickerSourceFromBuffer(Buffer.from('GIF89a....'), 'image');
  assert.equal(gif.type, 'video'); // GIF segue o caminho animado do makeSticker
  assert.equal(gif.kind, 'gif');
  assert.equal(gif.node.gifPlayback, true);

  const mp4 = stickerSourceFromBuffer(Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00]), 'video');
  assert.equal(mp4.type, 'video');
  assert.equal(mp4.node.mimetype, 'video/mp4');
});

/* ───────────────────────── download por link ───────────────────────── */

test('link direto de mídia: baixa o arquivo sem passar pelos extratores', async () => {
  const url = 'https://i.pinimg.com/originals/ab/cd/foto.jpg';
  await withMockFetch([[url, bufferResponse(PNG_1PX)]], async () => {
    const source = await downloadStickerSource(url, { onProgress: () => {} });
    assert.equal(source.kind, 'image');
    assert.equal(source.type, 'image');
    assert.equal(source.buffer.length, PNG_1PX.length);
    assert.match(source.via, /link direto/);
  });
});

test('link de página (Pinterest): usa o extrator da rede e baixa a imagem do pin', async () => {
  const pin = 'https://br.pinterest.com/pin/12345/';
  const image = 'https://i.pinimg.com/originals/ab/cd/ef/0123456789abcdef0123456789abcdef.jpg';
  await withMockFetch(
    [
      ['widgets.pinterest.com', jsonResponse({ data: [{ grid_title: 'Pin legal', images: { orig: { url: image, width: 1200, height: 1600 } } }] })],
      [image, bufferResponse(PNG_1PX)]
    ],
    async (requested) => {
      const source = await downloadStickerSource(pin, { onProgress: () => {} });
      assert.equal(source.kind, 'image');
      assert.equal(source.via, 'via Pinterest');
      assert.equal(source.title, 'Pin legal');
      assert.ok(requested.some((r) => r.url.includes('widgets.pinterest.com')));
    }
  );
});

test('Pinterest: link compartilhado (/sent/) NÃO vira figurinha de outro pin', async () => {
  // Caso real do bug: `.s https://pin.it/1Obiyee9V`. O Pinterest recebe o link
  // curto, manda a página de link compartilhado — que traz SÓ sugestões de busca
  // e um gradiente de marca — e o extrator antigo baixava esse asset colorido.
  const hash = 'e681f482b3f43f1e4bf0b921d7759f4e';
  const real = `https://i.pinimg.com/originals/e6/81/f4/${hash}.jpg`;
  const rendicao = `https://i.pinimg.com/564x/e6/81/f4/${hash}.jpg`;
  const marca = 'https://i.pinimg.com/originals/d5/3b/01/d53b014d86a6b6761bf649a0ed813cff.jpg';
  const outroPin = 'https://i.pinimg.com/564x/aa/bb/cc/aabbccddeeff00112233445566778899.jpg';
  const sentUrl = 'https://www.pinterest.com/pin/429530883237169819/sent/?invite_code=abc&sender=1&sfo=1';
  const paginaSent = `<html><head><meta property="og:image" content="${marca}">
    <script id="__PWS_DATA__" type="application/json">${JSON.stringify({
      props: {
        initialReduxState: {
          pins: { 111: { id: '111', images: { '564x': { url: outroPin, width: 564, height: 564 } } } }
        }
      }
    })}</script></head><body>sugestões de busca</body></html>`;
  const widget = {
    data: [
      {
        id: '429530883237169819',
        grid_title: 'Flamengo memes | Flamengo ganhou',
        pinner: { username: 'dessalobato' },
        images: {
          '236x': { url: `https://i.pinimg.com/236x/e6/81/f4/${hash}.jpg`, width: 236, height: 236 },
          '564x': { url: rendicao, width: 514, height: 514 }
        }
      }
    ]
  };
  const fotoDoPin = Buffer.concat([PNG_1PX, Buffer.from('PIN-CERTO')]);
  const fotoDeOutroPin = Buffer.concat([PNG_1PX, Buffer.from('OUTRO-PIN')]);
  const gradienteDeMarca = Buffer.concat([PNG_1PX, Buffer.from('GRADIENTE-DE-MARCA')]);

  await withMockFetch(
    [
      ['pin.it/1Obiyee9V', () => new Response('', { status: 302, headers: { location: sentUrl } })],
      ['www.pinterest.com/pin/429530883237169819', () => htmlResponse(paginaSent)],
      ['widgets.pinterest.com', () => jsonResponse(widget)],
      [real, () => bufferResponse(fotoDoPin)],
      [marca, () => bufferResponse(gradienteDeMarca)],
      [outroPin, () => bufferResponse(fotoDeOutroPin)]
    ],
    async (requested) => {
      const source = await downloadStickerSource('https://pin.it/1Obiyee9V', { onProgress: () => {} });
      assert.equal(source.buffer.equals(fotoDoPin), true, 'a figurinha sai da imagem do pin pedido');
      assert.equal(source.title, 'Flamengo memes | Flamengo ganhou');
      assert.equal(source.via, 'via Pinterest');
      assert.ok(
        requested.some((r) => r.url.includes('pin_ids=429530883237169819')),
        'consulta o widget API pelo id numérico extraído do redirect'
      );
      assert.equal(
        requested.some((r) => r.url.includes(marca) || r.url.includes(outroPin)),
        false,
        'nunca baixa o gradiente de marca nem o pin sugerido'
      );
    }
  );
});

test('Pinterest: quando só existe o gradiente de marca, recusa em vez de enganar', async () => {
  const marca = 'https://i.pinimg.com/originals/d5/3b/01/d53b014d86a6b6761bf649a0ed813cff.jpg';
  const pagina = `<html><head><meta property="og:image" content="${marca}"></head><body>login</body></html>`;
  await withMockFetch(
    [
      ['widgets.pinterest.com', () => jsonResponse({ status: 'success', code: 0, data: [] })],
      ['pin.it/', () => htmlResponse(pagina)],
      [/pinterest\.com\/pin\//, () => htmlResponse(pagina)],
      [marca, () => bufferResponse(Buffer.concat([PNG_1PX, Buffer.from('GRADIENTE')]))]
    ],
    async () => {
      await assert.rejects(
        () => downloadStickerSource('https://pin.it/1Obiyee9V', { onProgress: () => {} }),
        /não encontrei a mídia real|não consegui confirmar|Pinterest/i
      );
    }
  );
});

test('asset liso/gradiente de página genérica NÃO vira figurinha', { skip: !hasFfmpeg }, async () => {
  // O outro lado do bug: quando só existe um asset sintético (banner/gradiente
  // de marca) marcado como não confiável, a figurinha é recusada em vez de sair
  // colorida sem sentido.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stickerlink-flat-'));
  const assetPath = path.join(dir, 'asset.jpg');
  const base = ['-loglevel', 'error', '-y', '-f', 'lavfi'];
  const gradiente =
    spawnSync('ffmpeg', [...base, '-i', 'gradients=s=600x600:c0=0xff00ff:c1=0xffd400', '-frames:v', '1', assetPath]).status === 0 ||
    spawnSync('ffmpeg', [...base, '-i', 'color=c=0xff00ff:size=600x600', '-frames:v', '1', assetPath]).status === 0;
  if (!gradiente) {
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  }
  const asset = fs.readFileSync(assetPath);
  const pageUrl = 'https://exemplo.com/post/1';
  const pagina = `<html><head><meta property="og:image" content="https://cdn.exemplo.com/asset.jpg"></head></html>`;
  await withMockFetch(
    [
      [pageUrl, () => htmlResponse(pagina)],
      ['cdn.exemplo.com/asset.jpg', () => bufferResponse(asset, { contentType: 'image/jpeg' })]
    ],
    async () => {
      await assert.rejects(
        () => downloadStickerSource(pageUrl, { onProgress: () => {} }),
        /mídia real|gradiente|uma cor só|confirmar/i
      );
    }
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('extrator que devolve capa JPEG em vez do vídeo → figurinha estática', async () => {
  const tweet = 'https://x.com/user/status/12345';
  await withMockFetch(
    [
      [
        /vxtwitter|api\.fxtwitter/,
        jsonResponse({ text: 'oi', user_name: 'user', media_extended: [{ type: 'video', url: 'https://cdn.exemplo.com/vid.mp4' }] })
      ],
      ['cdn.exemplo.com/vid.mp4', bufferResponse(PNG_1PX, { contentType: 'image/jpeg' })]
    ],
    async () => {
      const source = await downloadStickerSource(tweet, { onProgress: () => {} });
      assert.equal(source.kind, 'image', 'a capa JPEG vira figurinha estática');
      assert.equal(source.type, 'image');
    }
  );
});

test('link direto que devolve HTML: erro explicativo em vez de WebP quebrado', async () => {
  const url = 'https://www.exemplo.com/foto.jpg';
  const html = Buffer.from('<!DOCTYPE html><html><body>o arquivo saiu do ar</body></html>');
  await withMockFetch([[url, bufferResponse(html, { contentType: 'text/html' })]], async () => {
    await assert.rejects(() => downloadStickerSource(url, { onProgress: () => {} }), /página/i);
  });
});

test('mais de 3 links: processa 3 e informa quantos ficaram de fora', async () => {
  const urls = [1, 2, 3, 4].map((i) => `https://i.pinimg.com/originals/ab/cd/${i}.jpg`);
  await withMockFetch(
    urls.map((u) => [u, bufferResponse(PNG_1PX)]),
    async () => {
      const { sources, skipped } = await stickerSourcesForCommand({
        sock: { updateMediaMessage: async () => {} },
        msg: { key: { remoteJid: '5511@s.whatsapp.net', id: 'A3' }, message: { conversation: `.s ${urls.join(' ')}` } },
        args: urls,
        onProgress: () => {}
      });
      assert.equal(sources.length, 3);
      assert.equal(skipped, 1);
    }
  );
});

test('link só de áudio: erro claro, sem tentar virar figurinha', async () => {
  const sound = 'https://soundcloud.com/artista/musica';
  const mp3 = 'https://cdn.exemplo.com/musica.mp3';
  const pool = cobaltPool();
  const previous = { cooldowns: pool.cooldowns, stats: pool.stats, index: pool.index };
  pool.cooldowns = new Map();
  pool.stats = new Map();
  pool.index = 0;
  try {
    await withMockFetch(
      [
        [mp3, bufferResponse(Buffer.from('ID3\x03\x00\x00\x00'), { contentType: 'audio/mpeg' })],
        [/co\.otomir23|cobalt|capi\.3kh0/, jsonResponse({ status: 'tunnel', url: mp3 })]
      ],
      async () => {
        await assert.rejects(() => downloadStickerSource(sound, { onProgress: () => {} }), /áudio/i);
      }
    );
  } finally {
    pool.cooldowns = previous.cooldowns;
    pool.stats = previous.stats;
    pool.index = previous.index;
  }
});

test('mídia anexada tem prioridade sobre o link no texto do comando', async () => {
  const pin = 'https://pin.it/nao-deve-ser-baixado';
  await withMockFetch([[() => true, bufferResponse(PNG_1PX)]], async (requested) => {
    // A mídia anexada não existe de verdade no mock: o download dela falha e o
    // erro sobe — o que NÃO pode acontecer é o bot cair no link do texto.
    await assert.rejects(() =>
      stickerSourcesForCommand({
        sock: { updateMediaMessage: async () => { throw new Error('sem mídia no mock'); } },
        msg: {
          key: { remoteJid: '5511@s.whatsapp.net', id: 'A1' },
          message: {
            imageMessage: { mimetype: 'image/jpeg', fileLength: 100 },
            extendedTextMessage: { text: `.s ${pin}` }
          }
        },
        args: [pin],
        onProgress: () => {}
      })
    );
    assert.equal(requested.some((r) => r.url.includes('pin.it')), false, 'não deve baixar o link quando há mídia anexada');
  });
});

test('vários links: um que falha não derruba os outros', async () => {
  const ok = 'https://i.pinimg.com/originals/ab/cd/ok.jpg';
  const bad = 'https://i.pinimg.com/originals/ab/cd/quebrado.jpg';
  await withMockFetch(
    [
      [ok, bufferResponse(PNG_1PX)],
      [bad, { status: 404, ok: false, url: bad, headers: { get: () => 'text/plain' }, text: async () => 'nope', body: null }]
    ],
    async () => {
      const { sources, failures } = await stickerSourcesForCommand({
        sock: { updateMediaMessage: async () => {} },
        msg: { key: { remoteJid: '5511@s.whatsapp.net', id: 'A2' }, message: { conversation: `.s ${ok} ${bad}` } },
        args: [ok, bad],
        onProgress: () => {}
      });
      assert.equal(sources.length, 1);
      assert.equal(failures.length, 1);
      assert.match(failures[0], /quebrado|404/i);
    }
  );
});

/* ───────────────────────── ponta a ponta (com FFmpeg) ───────────────────────── */

test('makeStickerFromLink: JPEG 800x400 do link vira WebP 512x512 com EXIF do pack', { skip: !hasFfmpeg }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stickerlink-'));
  const jpgPath = path.join(dir, 'fonte.jpg');
  assert.equal(
    spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:size=800x400', '-frames:v', '1', jpgPath]).status,
    0
  );
  const jpg = fs.readFileSync(jpgPath);
  const url = 'https://i.pinimg.com/originals/ab/cd/foto.jpg';

  await withMockFetch([[url, bufferResponse(jpg, { contentType: 'image/jpeg' })]], async () => {
    const { webp, source } = await makeStickerFromLink(url, {
      fit: 'fill',
      pack: 'PackTeste',
      author: 'AutorTeste',
      onProgress: () => {}
    });
    assert.equal(source.kind, 'image');
    assert.equal(isWebp(webp), true);
    const info = detectMediaExt(webp, '');
    assert.equal(info, '.webp');
    const exif = readStickerExif(webp);
    assert.equal(exif?.pack, 'PackTeste');
    assert.equal(exif?.author, 'AutorTeste');
  });

  fs.rmSync(dir, { recursive: true, force: true });
});

test('makeStickerFromLink: vídeo do link vira figurinha ANIMADA', { skip: !hasFfmpeg }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stickerlink-vid-'));
  const mp4Path = path.join(dir, 'fonte.mp4');
  assert.equal(
    spawnSync('ffmpeg', [
      '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=12:duration=2',
      '-pix_fmt', 'yuv420p', mp4Path
    ]).status,
    0
  );
  const mp4 = fs.readFileSync(mp4Path);
  const url = 'https://cdn.exemplo.com/video.mp4';

  await withMockFetch([[url, bufferResponse(mp4, { contentType: 'video/mp4' })]], async () => {
    const { webp, source } = await makeStickerFromLink(url, { pack: 'P', author: 'A', onProgress: () => {} });
    assert.equal(source.kind, 'video');
    assert.equal(isWebp(webp), true);
    assert.equal(isAnimatedWebp(webp), true);
  });

  fs.rmSync(dir, { recursive: true, force: true });
});

/* ───────────────────────── fluxo real do router (.s <link>) ───────────────────────── */

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
    key: { remoteJid: jid, id: `LINK${Math.random().toString(36).slice(2)}`, fromMe: true },
    pushName: 'Dono',
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: { conversation: text }
  };
}

test('fluxo: ".s <link>" no privado do dono baixa e envia a FIGURINHA', { skip: !hasFfmpeg }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stickerlink-e2e-'));
  const jpgPath = path.join(dir, 'pin.jpg');
  assert.equal(
    spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=green:size=600x600', '-frames:v', '1', jpgPath]).status,
    0
  );
  const jpg = fs.readFileSync(jpgPath);
  const url = 'https://i.pinimg.com/originals/ab/cd/pin.jpg';

  await withMockFetch([[url, bufferResponse(jpg, { contentType: 'image/jpeg' })]], async () => {
    const sock = makeSock();
    await handleMessage(sock, textMsg(`.s ${url}`), ownerDeps(sock));

    const sticker = sock.sent.find((s) => s.content.sticker);
    assert.ok(sticker, 'o bot enviou uma figurinha');
    assert.equal(isWebp(sticker.content.sticker), true);
    assert.equal(sticker.content.mimetype, 'image/webp');
    assert.equal(sticker.content.isAnimated, false);

    const finalText = sock.sent.at(-1).content.text || '';
    assert.match(finalText, /Figurinha pronta/);
    assert.match(finalText, /link direto/);
    assert.match(finalText, /i\.pinimg\.com/);
  });

  fs.rmSync(dir, { recursive: true, force: true });
});

test('fluxo: ".s" com link e modo de enquadramento junto (".s inteira <link>")', { skip: !hasFfmpeg }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stickerlink-e2e2-'));
  const jpgPath = path.join(dir, 'wide.jpg');
  assert.equal(
    spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:size=800x300', '-frames:v', '1', jpgPath]).status,
    0
  );
  const jpg = fs.readFileSync(jpgPath);
  const url = 'https://i.pinimg.com/originals/ab/cd/wide.jpg';

  await withMockFetch([[url, bufferResponse(jpg, { contentType: 'image/jpeg' })]], async () => {
    const sock = makeSock();
    await handleMessage(sock, textMsg(`.s inteira ${url}`), ownerDeps(sock));
    const sticker = sock.sent.find((s) => s.content.sticker);
    assert.ok(sticker, 'o bot enviou uma figurinha');
    assert.equal(readStickerExif(sticker.content.sticker)?.pack?.length > 0, true, 'EXIF com o nome do pack');
  });

  fs.rmSync(dir, { recursive: true, force: true });
});

test('menus do bot anunciam a figurinha de link (descoberta do usuário)', () => {
  for (const [nome, texto] of [
    ['público', publicMenu()],
    ['dono', ownerMenu()],
    ['figurinhas', stickerMenu()],
    ['downloads', downloadMenu()]
  ]) {
    assert.match(texto, /\.s <link>/i, `menu ${nome} deve mostrar ".s <link>"`);
  }
  assert.match(stickerMenu(), /\.sfundo <link>/i);
});

test('parseFit continua funcionando junto com o link', () => {
  assert.equal(parseFit(['https://pin.it/abc', 'inteira']), 'contain');
  assert.equal(parseFit(['https://pin.it/abc']), 'fill');
  assert.equal(parseFit(['https://pin.it/abc', 'cortar']), 'cover');
});
