// Testes offline do suporte AMPLIADO de downloads (node:test, fetch mockado):
// motor HLS (.m3u8 com AES-128 e byte-range), Bluesky, Imgur, Dailymotion,
// Reddit (foto/galeria), Threads (foto), Twitch VOD, link direto de mídia,
// reserva de "mídia servida" e catálogo de plataformas.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { setDnsLookupForTests } from '../src/core/http.js';

import {
  isHlsUrl,
  looksLikePlaylist,
  parseAttributes,
  parseMasterPlaylist,
  parseMediaPlaylist,
  pickVariant,
  downloadHls
} from '../src/features/downloaders/hls.js';
import { downloadBluesky, parseBlueskyUrl } from '../src/features/downloaders/bluesky.js';
import { downloadImgur, parseImgurUrl } from '../src/features/downloaders/imgur.js';
import { downloadDailymotion, dailymotionId } from '../src/features/downloaders/dailymotion.js';
import {
  downloadReddit,
  downloadThreads,
  downloadTwitch,
  pageVideoCandidates,
  redditImages,
  parseTwitchVodId
} from '../src/features/downloaders/generic.js';
import { kindByContentType } from '../src/features/downloaders/media.js';
import {
  detectPlatform,
  resolveDownload,
  sendDownload,
  SUPPORTED_PLATFORMS,
  dedicatedPlatformNames,
  isDouyinUrl
} from '../src/features/download.js';
import { hasFfmpeg } from '../src/util/ffmpeg.js';

setDnsLookupForTests(async () => [{ address: '8.8.8.8', family: 4 }]);

/* ───────────────────────── mock de fetch ───────────────────────── */

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { 'content-type': 'application/json', ...headers } });
}

function htmlResponse(html, { status = 200, headers = {} } = {}) {
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
}

function textResponse(text, { status = 200, contentType = 'application/vnd.apple.mpegurl' } = {}) {
  return new Response(text, { status, headers: { 'content-type': contentType } });
}

function bufferResponse(buffer, { status = 200, contentType = 'video/mp4' } = {}) {
  return new Response(buffer, {
    status,
    headers: { 'content-type': contentType, 'content-length': String(buffer.length) }
  });
}

async function freshResponse(response) {
  const body = response.body ? await response.clone().arrayBuffer() : null;
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/** Roteador de fetch: matcher (string includes ou RegExp) → resposta/função. */
export function mockFetch(routes, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    for (const [matcher, responder] of routes) {
      const hit = typeof matcher === 'string' ? u.includes(matcher) : matcher.test(u);
      if (hit) {
        const res = typeof responder === 'function' ? responder(u, opts) : responder;
        const response = res ?? jsonResponse({});
        return response instanceof Response ? freshResponse(response) : response;
      }
    }
    return jsonResponse({}, { status: 404 });
  };
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      globalThis.fetch = original;
    });
}

/* ─────────────────────────── utilidades ─────────────────────────── */

/** Caixa ISO-BMFF (o que faz o buffer ser reconhecido como MP4). */
function box(tag, { fill = 'x', size = 24 } = {}) {
  const body = Buffer.from(`${tag}${String(fill).repeat(Math.max(1, size - 8 - tag.length))}`);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write('ftyp', 4, 'ascii');
  return Buffer.concat([head, body]);
}

/* ─────────────────────────── parsers HLS ─────────────────────────── */

test('isHlsUrl reconhece .m3u8, query de formato e ignora página comum', () => {
  assert.equal(isHlsUrl('https://cdn.example.com/hls/master.m3u8'), true);
  assert.equal(isHlsUrl('https://cdn.example.com/hls/master.m3u8?token=abc'), true);
  assert.equal(isHlsUrl('https://cdn.example.com/play?format=m3u8'), true);
  assert.equal(isHlsUrl('https://cdn.example.com/video.mp4'), false);
  assert.equal(isHlsUrl('https://bsky.app/profile/ana/post/3k'), false);
});

test('looksLikePlaylist aceita texto e Buffer, e rejeita mídia', () => {
  assert.equal(looksLikePlaylist('#EXTM3U\n#EXT-X-VERSION:3'), true);
  assert.equal(looksLikePlaylist(Buffer.from('\uFEFF#EXTM3U\n')), true);
  assert.equal(looksLikePlaylist(box('init')), false);
  assert.equal(looksLikePlaylist(Buffer.from('{"error":"x"}')), false);
});

test('parseAttributes lê chaves e valores com vírgula entre aspas', () => {
  const attrs = parseAttributes('BANDWIDTH=2400000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"');
  assert.equal(attrs.BANDWIDTH, '2400000');
  assert.equal(attrs.RESOLUTION, '1280x720');
  assert.equal(attrs.CODECS, 'avc1.4d401f,mp4a.40.2');
});

const MASTER = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="Português",URI="audio/index.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401f,mp4a.40.2"
360p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"
720p/index.m3u8
`;

test('parseMasterPlaylist resolve variantes e faixa de áudio separada', () => {
  const { variants, renditions, isMaster } = parseMasterPlaylist(MASTER, 'https://cdn.example.com/hls/master.m3u8');
  assert.equal(isMaster, true);
  assert.equal(variants.length, 2);
  assert.equal(variants[1].url, 'https://cdn.example.com/hls/720p/index.m3u8');
  assert.equal(variants[1].height, 720);
  assert.equal(renditions[0].url, 'https://cdn.example.com/hls/audio/index.m3u8');
  assert.equal(renditions[0].type, 'AUDIO');
});

test('pickVariant escolhe por qualidade: melhor, media e baixa', () => {
  const { variants } = parseMasterPlaylist(MASTER, 'https://cdn.example.com/hls/master.m3u8');
  assert.equal(pickVariant(variants, { quality: 'melhor' }).height, 720);
  assert.equal(pickVariant(variants, { quality: 'baixa' }).height, 360);
  assert.equal(pickVariant(variants, { quality: 'media' }).height, 360);
});

test('parseMediaPlaylist extrai segmentos, init, duração, live e byte-range', () => {
  const text = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:10
#EXT-X-MAP:URI="init.mp4"
#EXTINF:4.0,
seg1.m4s
#EXTINF:4.0,
seg2.m4s
#EXT-X-BYTERANGE:2048@0
#EXTINF:4.0,
seg3.m4s
#EXT-X-ENDLIST
`;
  const media = parseMediaPlaylist(text, 'https://cdn.example.com/hls/720p/index.m3u8');
  assert.equal(media.segments.length, 3);
  assert.equal(media.initUrl, 'https://cdn.example.com/hls/720p/init.mp4');
  assert.equal(media.segments[0].url, 'https://cdn.example.com/hls/720p/seg1.m4s');
  assert.equal(media.segments[0].seq, 10);
  assert.equal(media.segments[2].range.offset, 0);
  assert.equal(media.segments[2].range.length, 2048);
  assert.equal(media.duration, 12);
  assert.equal(media.isLive, false);
  assert.equal(media.encrypted, null);
});

/* ─────────────────────────── download HLS ─────────────────────────── */

const MEDIA_PLAYLIST = `#EXTM3U
#EXT-X-TARGETDURATION:4
#EXT-X-MAP:URI="init.mp4"
#EXTINF:4.0,
seg1.m4s
#EXTINF:4.0,
seg2.m4s
#EXT-X-ENDLIST
`;

function hlsRoutes() {
  return [
    ['hls/master.m3u8', () => textResponse(MASTER)],
    ['720p/index.m3u8', () => textResponse(MEDIA_PLAYLIST)],
    ['720p/init.mp4', () => bufferResponse(box('init'))],
    ['720p/seg1.m4s', () => bufferResponse(box('seg1'))],
    ['720p/seg2.m4s', () => bufferResponse(box('seg2'))]
  ];
}

test('downloadHls: master → melhor variante → fMP4 montado sem FFmpeg', async () => {
  await mockFetch(hlsRoutes(), async () => {
    const hls = await downloadHls('https://cdn.example.com/hls/master.m3u8', { maxBytes: 10 * 1024 * 1024 });
    assert.equal(hls.kind, 'video');
    assert.equal(hls.container, 'mp4');
    assert.equal(hls.segments, 2);
    assert.equal(hls.duration, 8);
    assert.equal(hls.live, false);
    const text = hls.buffer.toString('latin1');
    assert.ok(text.includes('init'), 'deve começar pelo EXT-X-MAP');
    assert.ok(text.includes('seg1') && text.includes('seg2'), 'deve conter os dois segmentos');
  });
});

test('downloadHls: respeita o teto de bytes e marca o resultado como parcial', async () => {
  const entries = Array.from({ length: 10 }, (_, i) => `#EXTINF:4.0,\ns${i}.m4s`).join('\n');
  const media = `#EXTM3U\n${entries}\n#EXT-X-ENDLIST\n`;
  const seg = box('segX', { size: 4096 });
  await mockFetch(
    [
      ['list.m3u8', () => textResponse(media)],
      [/\/s\d+\.m4s$/, () => bufferResponse(seg)]
    ],
    async () => {
      const hls = await downloadHls('https://cdn.example.com/list.m3u8', { maxBytes: 5000 });
      assert.equal(hls.truncated, true, 'deve avisar que cortou pelo limite');
      // Teto de 5 KB com blocos de 4 KB: para muito antes dos 10 segmentos (os
      // que já estavam em voo terminam, o resto nem é pedido).
      assert.ok(hls.buffer.length < seg.length * 10, 'não deve baixar a playlist inteira');
      assert.ok(hls.buffer.length <= seg.length * 6, 'concorrência limita o excesso');
    }
  );
});

test('downloadHls: AES-128 é decifrado com a IV da playlist', async () => {
  const key = crypto.randomBytes(16);
  const iv = crypto.randomBytes(16);
  const plaintexts = [box('enc1'), box('enc2')];
  const ciphertexts = plaintexts.map((plain) => {
    const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
    return Buffer.concat([cipher.update(plain), cipher.final()]);
  });

  const media = `#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x${iv.toString('hex')}
#EXTINF:4.0,
enc1.m4s
#EXTINF:4.0,
enc2.m4s
#EXT-X-ENDLIST
`;
  await mockFetch(
    [
      ['enc/playlist.m3u8', () => textResponse(media)],
      ['enc/key.bin', () => bufferResponse(key, { contentType: 'application/octet-stream' })],
      ['enc/enc1.m4s', () => bufferResponse(ciphertexts[0], { contentType: 'video/mp2t' })],
      ['enc/enc2.m4s', () => bufferResponse(ciphertexts[1], { contentType: 'video/mp2t' })]
    ],
    async () => {
      const hls = await downloadHls('https://cdn.example.com/enc/playlist.m3u8');
      assert.equal(hls.encryption, 'AES-128');
      assert.deepEqual(hls.buffer, Buffer.concat(plaintexts), 'o conteúdo decifrado bate com o original');
    }
  );
});

test('downloadHls: MPEG-TS sem FFmpeg falha com dica acionável', { skip: hasFfmpeg() ? 'FFmpeg presente nesta máquina' : false }, async () => {
  // Pacote TS falso: 0x47 no começo (sync) e nada de `ftyp`.
  const ts = Buffer.alloc(188, 0x47);
  const media = `#EXTM3U
#EXTINF:4.0,
p1.ts
#EXT-X-ENDLIST
`;
  await mockFetch(
    [
      ['ts/playlist.m3u8', () => textResponse(media)],
      ['ts/p1.ts', () => bufferResponse(ts, { contentType: 'video/mp2t' })]
    ],
    async () => {
      await assert.rejects(
        () => downloadHls('https://cdn.example.com/ts/playlist.m3u8'),
        (error) => {
          assert.match(String(error.message), /MPEG-TS|FFmpeg/i);
          assert.match(String(error.hint || ''), /ffmpeg/i);
          return true;
        }
      );
    }
  );
});

test('downloadHls: master só com codecs de áudio devolve áudio, não vídeo', async () => {
  const master = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="mp4a.40.2"
audio/index.m3u8
`;
  const media = `#EXTM3U
#EXT-X-MAP:URI="init.mp4"
#EXTINF:4.0,
a1.m4s
#EXT-X-ENDLIST
`;
  await mockFetch(
    [
      ['radio/master.m3u8', () => textResponse(master)],
      ['radio/audio/index.m3u8', () => textResponse(media)],
      ['radio/audio/init.mp4', () => bufferResponse(box('init'))],
      ['radio/audio/a1.m4s', () => bufferResponse(box('a1'))]
    ],
    async () => {
      const hls = await downloadHls('https://cdn.example.com/radio/master.m3u8');
      assert.equal(hls.kind, 'audio');
      assert.equal(hls.container, 'm4a');
    }
  );
});

test('downloadHls: segmento que falha rejeita em vez de montar vídeo furado', async () => {
  const media = `#EXTM3U
#EXTINF:4.0,
ok1.m4s
#EXTINF:4.0,
quebrado.m4s
#EXT-X-ENDLIST
`;
  await mockFetch(
    [
      ['falha/playlist.m3u8', () => textResponse(media)],
      ['falha/ok1.m4s', () => bufferResponse(box('ok1'))],
      ['falha/quebrado.m4s', () => new Response('nope', { status: 500, headers: { 'content-type': 'text/plain' } })]
    ],
    async () => {
      await assert.rejects(
        () => downloadHls('https://cdn.example.com/falha/playlist.m3u8'),
        /segmento 2\/2 falhou/
      );
    }
  );
});

test('resolveDownload: link direto de imagem não depende do Cobalt', async () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 0x7a)]);
  await mockFetch([['cdn.example.com/foto.jpg', () => bufferResponse(jpeg, { contentType: 'image/jpeg' })]], async () => {
    const result = await resolveDownload('https://cdn.example.com/foto.jpg', 'melhor');
    assert.equal(result.platform, 'Link direto');
    assert.equal(result.kind, 'image');
    assert.deepEqual(result.buffers[0], jpeg);
  });
});

test('resolveDownload: URL sem extensão que serve imagem é reconhecida pela sondagem', async () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(48, 0x42)]);
  await mockFetch(
    [
      ['cdn.example.com/attachment?id=9', () => bufferResponse(jpeg, { contentType: 'image/jpeg' })],
      ['api.vxtwitter.com', () => jsonResponse({}, { status: 404 })],
      ['instances.cobalt.best', () => jsonResponse({}, { status: 404 })],
      ['cobalt.directory', () => jsonResponse({}, { status: 404 })]
    ],
    async () => {
      const result = await resolveDownload('https://cdn.example.com/attachment?id=9', 'melhor');
      assert.equal(result.kind, 'image');
      assert.deepEqual(result.buffers[0], jpeg);
    }
  );
});

test('resolveDownload: link .m3u8 colado pelo usuário entrega MP4', async () => {
  await mockFetch(hlsRoutes(), async () => {
    const result = await resolveDownload('https://cdn.example.com/hls/master.m3u8', 'melhor');
    assert.equal(result.platform, 'Stream HLS');
    assert.equal(result.kind, 'video');
    assert.equal(result.buffers.length, 1);
    assert.equal(result.partial, false);
    assert.equal(result.media[0].type, 'video');
  });
});

/* ───────────────────────────── Bluesky ───────────────────────────── */

test('parseBlueskyUrl extrai handle e rkey', () => {
  assert.deepEqual(parseBlueskyUrl('https://bsky.app/profile/ana.bsky.social/post/3kabc'), {
    handle: 'ana.bsky.social',
    rkey: '3kabc'
  });
  assert.equal(parseBlueskyUrl('https://bsky.app/profile/ana.bsky.social'), null);
});

test('Bluesky: post com 3 fotos vira slideshow com título e autor', async () => {
  const thread = {
    thread: {
      post: {
        author: { handle: 'ana.bsky.social' },
        record: { text: 'Praia hoje 🌊' },
        embed: {
          $type: 'app.bsky.embed.images#view',
          images: [
            { fullsize: 'https://cdn.bsky.app/img/full/1.jpg', thumb: 'https://cdn.bsky.app/img/thumb/1.jpg' },
            { fullsize: 'https://cdn.bsky.app/img/full/2.jpg', thumb: 'https://cdn.bsky.app/img/thumb/2.jpg' },
            { fullsize: 'https://cdn.bsky.app/img/full/3.jpg', thumb: 'https://cdn.bsky.app/img/thumb/3.jpg' }
          ]
        }
      }
    }
  };
  await mockFetch(
    [
      ['com.atproto.identity.resolveHandle', () => jsonResponse({ did: 'did:plc:abc' })],
      ['app.bsky.feed.getPostThread', () => jsonResponse(thread)]
    ],
    async () => {
      const result = await downloadBluesky('https://bsky.app/profile/ana.bsky.social/post/3kabc');
      assert.equal(result.platform, 'Bluesky');
      assert.equal(result.kind, 'slideshow');
      assert.equal(result.media.length, 3);
      assert.equal(result.media[0].url, 'https://cdn.bsky.app/img/full/1.jpg');
      assert.equal(result.author, '@ana.bsky.social');
      assert.equal(result.title, 'Praia hoje 🌊');
      assert.equal(result.thumbnail, 'https://cdn.bsky.app/img/thumb/1.jpg');
    }
  );
});

test('Bluesky: post de vídeo devolve a playlist HLS e a capa', async () => {
  const thread = {
    thread: {
      post: {
        author: { handle: 'video.bsky.social' },
        record: { text: 'Clipe' },
        embed: {
          $type: 'app.bsky.embed.video#view',
          playlist: 'https://video.bsky.app/watch/did:plc:abc/cid/playlist.m3u8',
          thumbnail: 'https://cdn.bsky.app/img/thumb/video.jpg'
        }
      }
    }
  };
  await mockFetch(
    [
      ['resolveHandle', () => jsonResponse({ did: 'did:plc:abc' })],
      ['getPostThread', () => jsonResponse(thread)]
    ],
    async () => {
      const result = await downloadBluesky('https://bsky.app/profile/video.bsky.social/post/3kvid');
      assert.equal(result.kind, 'video');
      assert.equal(result.media[0].type, 'video');
      assert.match(result.media[0].url, /playlist\.m3u8$/);
      assert.equal(result.thumbnail, 'https://cdn.bsky.app/img/thumb/video.jpg');
    }
  );
});

/* ───────────────────────────── Hungry Imgur ───────────────────────────── */

test('parseImgurUrl separa álbum, galeria e post único', () => {
  assert.deepEqual(parseImgurUrl('https://imgur.com/a/abc12'), { id: 'abc12', album: true });
  assert.deepEqual(parseImgurUrl('https://imgur.com/gallery/xyz9/'), { id: 'xyz9', album: true });
  assert.deepEqual(parseImgurUrl('https://imgur.com/QwErTy'), { id: 'QwErTy', album: false });
});

test('Imgur: álbum lista fotos e converte GIF animado em MP4', async () => {
  const album = {
    data: {
      title: 'Viagem',
      images: [
        { hash: 'aaa111', ext: '.jpg', animated: false },
        { hash: 'bbb222', ext: '.gif', animated: true }
      ]
    }
  };
  await mockFetch([['ajaxalbums/getimages/abc12', () => jsonResponse(album)]], async () => {
    const result = await downloadImgur('https://imgur.com/a/abc12');
    assert.equal(result.platform, 'Imgur');
    assert.equal(result.kind, 'slideshow');
    assert.equal(result.media[0].url, 'https://i.imgur.com/aaa111.jpg');
    assert.equal(result.media[1].type, 'gif');
    assert.equal(result.media[1].url, 'https://i.imgur.com/bbb222.mp4');
  });
});

test('Imgur: link direto do CDN vira item único', async () => {
  const result = await downloadImgur('https://i.imgur.com/ZzZ999.gif');
  assert.equal(result.kind, 'gif');
  assert.equal(result.media[0].url, 'https://i.imgur.com/ZzZ999.gif');
});

/* ─────────────────────────── Dailymotion ─────────────────────────── */

test('dailymotionId cobre dai.ly, /video/ e embed', () => {
  assert.equal(dailymotionId('https://dai.ly/x8abc'), 'x8abc');
  assert.equal(dailymotionId('https://www.dailymotion.com/video/x8abc_titulo'), 'x8abc');
  assert.equal(dailymotionId('https://www.dailymotion.com/embed/video/x8abc'), 'x8abc');
  assert.equal(dailymotionId('https://example.com/video/x8abc'), null);
});

test('Dailymotion: metadados abertos e melhor rendição progressiva', async () => {
  const metadata = {
    title: 'Documentário',
    duration: 754,
    poster: 'https://s1.dmcdn.net/xyz.jpg',
    owner: { screenname: 'Canal BOM' },
    qualities: {
      auto: [
        { type: 'video/mp4', url: 'https://cdn.dmcdn.net/240.mp4', height: 240 },
        { type: 'video/mp4', url: 'https://cdn.dmcdn.net/720.mp4', height: 720 }
      ]
    }
  };
  await mockFetch([['player/metadata/video/x8abc', () => jsonResponse(metadata)]], async () => {
    const best = await downloadDailymotion('https://www.dailymotion.com/video/x8abc', 'melhor');
    assert.equal(best.media[0].url, 'https://cdn.dmcdn.net/720.mp4');
    assert.equal(best.title, 'Documentário');
    assert.equal(best.duration, 754);
    assert.equal(best.author, 'Canal BOM');

    const low = await downloadDailymotion('https://www.dailymotion.com/video/x8abc', 'baixa');
    assert.equal(low.media[0].url, 'https://cdn.dmcdn.net/240.mp4');
  });
});

/* ───────────────────────── Reddit e Threads ───────────────────────── */

test('Reddit: embed com MP4 entrega o vídeo muxado', async () => {
  const packaged = JSON.stringify({
    playbackMp4s: {
      permutations: [
        { source: { url: 'https://v.redd.it/abc/480.mp4', dimensions: { height: 480 } } },
        { source: { url: 'https://v.redd.it/abc/720.mp4', dimensions: { height: 720 } } }
      ],
      duration: 42
    }
  }).replace(/"/g, '&quot;');
  const html = `<html><body><div packaged-media-json="${packaged}"></div>
    <meta property="og:image" content="https://preview.redd.it/poster.jpg"></body></html>`;

  await mockFetch([[/embed\.reddit\.com\/r\/gatos\/comments\/abc123/, () => htmlResponse(html)]], async () => {
    const result = await downloadReddit('https://www.reddit.com/r/gatos/comments/abc123/post_legais/');
    assert.equal(result.platform, 'Reddit');
    assert.equal(result.kind, 'video');
    assert.equal(result.media[0].url, 'https://v.redd.it/abc/720.mp4');
    assert.equal(result.author, 'r/gatos');
  });
});

test('Reddit: post de fotos/galeria vira slideshow com URLs sem query', async () => {
  const html = `<html><head>
    <meta property="og:image" content="https://preview.redd.it/foto1.jpg?width=640&amp;format=pjpg">
    </head><body>
    <img src="https://preview.redd.it/foto2.jpg?width=640">
    <img src="https://i.redd.it/foto3.png">
    </body></html>`;

  await mockFetch([[/embed\.reddit\.com\/r\/fotos\/comments\/zzz999/, () => htmlResponse(html)]], async () => {
    const result = await downloadReddit('https://www.reddit.com/r/fotos/comments/zzz999/galeria/');
    assert.equal(result.kind, 'slideshow');
    assert.deepEqual(
      result.media.map((m) => m.url),
      ['https://preview.redd.it/foto1.jpg', 'https://preview.redd.it/foto2.jpg', 'https://i.redd.it/foto3.png']
    );
  });
});

test('Threads: post só de fotos (sem vídeo no embed)', async () => {
  const html = `<html><head><meta property="og:title" content="Ana no Threads"></head><body>
    <script>{"image_versions2":{"candidates":[{"height":1920,"url":"https:\\/\\/scontent.cdninstagram.com\\/v\\/t51.2885-15\\/foto.jpg"}]}}</script>
    </body></html>`;
  await mockFetch([[/threads\.net\/@ana\/post\/ABC\/embed/, () => htmlResponse(html)]], async () => {
    const result = await downloadThreads('https://www.threads.net/@ana/post/ABC');
    assert.equal(result.platform, 'Threads');
    assert.equal(result.kind, 'image');
    assert.equal(result.author, 'ana');
    assert.deepEqual(result.media.map((m) => m.url), ['https://scontent.cdninstagram.com/v/t51.2885-15/foto.jpg']);
  });
});

/* ───────────────────────────── Twitch ───────────────────────────── */

test('parseTwitchVodId lê /videos/<id>', () => {
  assert.equal(parseTwitchVodId('https://www.twitch.tv/videos/1234567890'), '1234567890');
  assert.equal(parseTwitchVodId('https://www.twitch.tv/canal'), null);
});

test('Twitch VOD: token público → HLS → MP4 montado', async () => {
  const gql = {
    data: {
      video: {
        title: 'Live de ontem',
        durationSeconds: 3600,
        thumbnailURL: 'https://static-cdn.jtvnw.net/cf_vods/preview.jpg',
        owner: { displayName: 'Streamer' },
        playbackAccessToken: { signature: 'sig123', value: 'token456' }
      }
    }
  };
  const media = `#EXTM3U
#EXT-X-MAP:URI="https://vodsegs.example/init.mp4"
#EXTINF:4.0,
https://vodsegs.example/v1.m4s
#EXTINF:4.0,
https://vodsegs.example/v2.m4s
#EXT-X-ENDLIST
`;
  await mockFetch(
    [
      ['gql.twitch.tv', () => jsonResponse(gql)],
      ['usher.ttvnw.net/vod/1234567890.m3u8', () => textResponse(media)],
      ['vodsegs.example/init.mp4', () => bufferResponse(box('init'))],
      ['vodsegs.example/v1.m4s', () => bufferResponse(box('v1'))],
      ['vodsegs.example/v2.m4s', () => bufferResponse(box('v2'))]
    ],
    async () => {
      const result = await downloadTwitch('https://www.twitch.tv/videos/1234567890', { maxBytes: 50 * 1024 * 1024 });
      assert.equal(result.platform, 'Twitch');
      assert.equal(result.title, 'Live de ontem');
      assert.equal(result.buffers.length, 1);
      assert.ok(result.buffers[0].length > 0);
      assert.equal(result.partial, false);
    }
  );
});

/* ─────────────────────── scraping genérico de página ─────────────────────── */

test('pageVideoCandidates prefere metadados e aceita <video> e HLS', () => {
  const html = `
    <meta property="og:video" content="https://site.com/player/embed/123">
    <meta property="twitter:player:stream" content="https://cdn.site.com/stream.mp4">
    <video src="https://cdn.site.com/outro.webm"></video>
    <script type="application/ld+json">{"contentUrl":"https://cdn.site.com/terceiro.mp4"}</script>
    <script>var hls = "https://cdn.site.com/ao-vivo.m3u8";</script>
  `;
  const candidates = pageVideoCandidates(html);
  assert.equal(candidates[0], 'https://cdn.site.com/stream.mp4', 'metadado de player vem primeiro');
  assert.ok(candidates.includes('https://cdn.site.com/outro.webm'));
  assert.ok(candidates.includes('https://cdn.site.com/ao-vivo.m3u8'));
});

test('redditImages ignora hosts que não são do Reddit', () => {
  const html = `
    <meta property="og:image" content="https://preview.redd.it/ok.jpg?width=640">
    <img src="https://i.redd.it/direto.png">
    <img src="https://i.imgur.com/nao-e-reddit.jpg">
  `;
  assert.deepEqual(redditImages(html), [
    'https://preview.redd.it/ok.jpg',
    'https://i.redd.it/direto.png'
  ]);
});

/* ──────────────────────── roteamento e catálogo ──────────────────────── */

test('detectPlatform nomeia as redes novas (e o stream HLS)', () => {
  assert.equal(detectPlatform('https://bsky.app/profile/ana/post/1'), 'Bluesky');
  assert.equal(detectPlatform('https://imgur.com/a/abc'), 'Imgur');
  assert.equal(detectPlatform('https://dai.ly/x8abc'), 'Dailymotion');
  assert.equal(detectPlatform('https://www.douyin.com/video/123'), 'Douyin');
  assert.equal(detectPlatform('https://www.kwai.com/@x/video/1'), 'Kwai');
  assert.equal(detectPlatform('https://cdn.example.com/master.m3u8'), 'Stream HLS');
  assert.equal(detectPlatform('https://exemplo.com/pagina'), null);
});

test('isDouyinUrl separa Douyin de TikTok', () => {
  assert.equal(isDouyinUrl('https://www.douyin.com/video/730000000000'), true);
  assert.equal(isDouyinUrl('https://www.tiktok.com/@x/video/1'), false);
});

test('catálogo inclui as plataformas novas com extrator próprio', () => {
  const names = dedicatedPlatformNames();
  for (const expected of ['Bluesky', 'Imgur', 'Dailymotion', 'Douyin', 'Stream HLS']) {
    assert.ok(names.includes(expected), `${expected} deve ter extrator próprio`);
  }
  assert.ok(SUPPORTED_PLATFORMS.length >= 25, 'catálogo deve listar pelo menos 25 redes');
});

test('kindByContentType mapeia os content-types de mídia', () => {
  assert.equal(kindByContentType('image/gif'), 'gif');
  assert.equal(kindByContentType('image/jpeg'), 'image');
  assert.equal(kindByContentType('video/mp4'), 'video');
  assert.equal(kindByContentType('audio/mpeg'), 'audio');
  assert.equal(kindByContentType('text/html'), null);
});

test('sendDownload avisa quando o stream foi cortado pelo limite', async () => {
  const sent = [];
  const sock = {
    sendMessage: async (jid, content, opts) => {
      sent.push({ content, opts });
      return { key: { id: 'S1' } };
    }
  };
  const result = {
    platform: 'Twitch',
    title: 'VOD gigante',
    kind: 'video',
    media: [{ type: 'video', url: 'https://usher.ttvnw.net/vod/1.m3u8' }],
    buffers: [box('vod')],
    partial: true
  };
  await sendDownload(sock, '123@s.whatsapp.net', result, { quality: 'melhor' });
  assert.equal(sent.length, 2, 'vídeo + aviso');
  assert.match(JSON.stringify(sent[1].content), /trecho inicial/);
});
