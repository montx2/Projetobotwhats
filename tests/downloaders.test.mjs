// Testes offline dos extratores de redes sociais (node:test, fetch mockado).
// Cada teste simula a resposta REAL que o serviço devolve (tikwm, Innertube,
// vxtwitter, widget do Pinterest, embed do Instagram, plugin do Facebook) e
// confere que o bot extrai a mídia certa — inclusive nos casos que quebram os
// bots ingênuos (reels sem video_url no embed, codec próprio do TikTok, etc).

import test from 'node:test';
import assert from 'node:assert/strict';
import { setDnsLookupForTests } from '../src/core/http.js';

import { parseYouTubeId, downloadYouTube, searchYouTube } from '../src/features/downloaders/youtube.js';
import { downloadTikTok, tiktokVideoId } from '../src/features/downloaders/tiktok.js';
import {
  canonicalPinUrl,
  downloadPinterest,
  extractPinId,
  findPinInState,
  imageRenditions
} from '../src/features/downloaders/pinterest.js';
import {
  downloadInstagram,
  instagramShortcode,
  instagramMediaId,
  instagramLinkIsVideo
} from '../src/features/downloaders/instagram.js';
import { downloadTwitter, parseTweet } from '../src/features/downloaders/twitter.js';
import { downloadFacebook } from '../src/features/downloaders/facebook.js';
import { parseTwitchClipSlug } from '../src/features/downloaders/generic.js';
import { cobaltDownload, cobaltPool } from '../src/features/downloaders/cobalt.js';
import { detectPlatform, resolveDownload, sendDownload } from '../src/features/download.js';
import {
  kindByExtension,
  looksLikeImageBytes,
  decodeEntities,
  metaContent,
  stringAfterKey
} from '../src/features/downloaders/media.js';

setDnsLookupForTests(async () => [{ address: '8.8.8.8', family: 4 }]);

/* ───────────────────────── mock de fetch ───────────────────────── */

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });
}

function htmlResponse(html, { status = 200 } = {}) {
  return new Response(html, { status, headers: { 'content-type': 'text/html' } });
}

function bufferResponse(buf, { status = 200, contentType = 'video/mp4' } = {}) {
  return new Response(buf, {
    status,
    headers: { 'content-type': contentType, 'content-length': String(buf.length) }
  });
}

async function freshResponse(response) {
  const body = response.body ? await response.clone().arrayBuffer() : null;
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/**
 * Substitui o fetch global por um roteador: cada rota é [teste, resposta].
 * `teste` pode ser string (includes) ou RegExp.
 */
export function mockFetch(routes, fn) {
  const original = globalThis.fetch;
  let lastBody = null;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (opts.body) lastBody = opts.body;
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

/* ───────────────────────── parsers ───────────────────────── */

test('parseYouTubeId cobre watch, shorts, youtu.be e embed', () => {
  assert.equal(parseYouTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(parseYouTubeId('https://youtu.be/dQw4w9WgXcQ?t=30'), 'dQw4w9WgXcQ');
  assert.equal(parseYouTubeId('https://youtu.be/RS4ZzYjFZcE?is=Jl8YxIYMyy-iEeqd'), 'RS4ZzYjFZcE');
  assert.equal(parseYouTubeId('https://www.youtube.com/watch?feature=share&v=RS4ZzYjFZcE'), 'RS4ZzYjFZcE');
  assert.equal(parseYouTubeId('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(parseYouTubeId('https://www.youtube.com/embed/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(parseYouTubeId('https://www.tiktok.com/@a/video/1'), null);
});

test('instagramShortcode + instagramMediaId (shortcode é base64 do id)', () => {
  assert.equal(instagramShortcode('https://www.instagram.com/reel/ABCdefGHIjk/?igsh=x'), 'ABCdefGHIjk');
  assert.equal(instagramShortcode('https://www.instagram.com/p/DF8R2ybPmNF/'), 'DF8R2ybPmNF');
  assert.equal(instagramShortcode('https://instagr.am/p/DF8R2ybPmNF/'), 'DF8R2ybPmNF');
  // id conhecido do Instagram: shortcode C blends não existe, mas o round-trip é válido
  const id = instagramMediaId('DF8R2ybPmNF');
  assert.match(id, /^\d+$/);
  assert.equal(instagramMediaId('!!invalid!!'), null);
  assert.equal(instagramLinkIsVideo('https://www.instagram.com/reel/ABC/'), true);
  assert.equal(instagramLinkIsVideo('https://www.instagram.com/p/ABC/'), false);
});

test('parseTweet extrai usuário e id de twitter.com e x.com', () => {
  assert.deepEqual(parseTweet('https://twitter.com/nasa/status/1580661436132757504'), {
    username: 'nasa',
    tweetId: '1580661436132757504'
  });
  assert.deepEqual(parseTweet('https://x.com/nasa/status/1580661436132757504?s=20'), {
    username: 'nasa',
    tweetId: '1580661436132757504'
  });
});

test('extractPinId e parseTwitchClipSlug', () => {
  assert.equal(extractPinId('https://www.pinterest.com/pin/687159481848754665/'), '687159481848754665');
  assert.equal(extractPinId('https://pin.it/abc123'), 'abc123');
  assert.equal(parseTwitchClipSlug('https://clips.twitch.tv/AwesomeClip'), 'AwesomeClip');
  assert.equal(parseTwitchClipSlug('https://www.twitch.tv/streamer/clip/AwesomeClip'), 'AwesomeClip');
  assert.equal(parseTwitchClipSlug('https://www.twitch.tv/videos/123'), null);
});

test('detectPlatform reconhece todas as redes atendidas', () => {
  const cases = [
    ['https://vm.tiktok.com/ZM123/', 'TikTok'],
    ['https://www.instagram.com/reel/ABC/', 'Instagram'],
    ['https://pin.it/abc', 'Pinterest'],
    ['https://www.pinterest.com/pin/123/', 'Pinterest'],
    ['https://youtu.be/dQw4w9WgXcQ', 'YouTube'],
    ['https://x.com/nasa/status/1', 'X (Twitter)'],
    ['https://twitter.com/nasa/status/1', 'X (Twitter)'],
    ['https://www.facebook.com/reel/123', 'Facebook'],
    ['https://fb.watch/abc', 'Facebook'],
    ['https://www.threads.net/@user/post/abc', 'Threads'],
    ['https://www.reddit.com/r/x/comments/y/z/', 'Reddit'],
    ['https://clips.twitch.tv/abc', 'Twitch'],
    ['https://vimeo.com/123456', 'Vimeo'],
    ['https://soundcloud.com/a/b', 'SoundCloud']
  ];
  for (const [url, expected] of cases) {
    assert.equal(detectPlatform(url), expected, `detectPlatform(${url})`);
  }
  assert.equal(detectPlatform('https://example.com/video'), null);
});

test('helpers de mídia: extensão, bytes de imagem, entidades e meta tags', () => {
  assert.equal(kindByExtension('https://x/a.mp4?token=1'), 'video');
  assert.equal(kindByExtension('https://x/a.jpg'), 'image');
  assert.equal(kindByExtension('https://x/a.mp3'), 'audio');

  assert.equal(looksLikeImageBytes(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), true);
  assert.equal(looksLikeImageBytes(Buffer.from([0x89, 0x50, 0x4e, 0x47])), true);
  assert.equal(looksLikeImageBytes(Buffer.from('ftypisom')), false);

  assert.equal(decodeEntities('a &amp; b &quot;c&quot; &#x27;d&#x27;'), `a & b "c" 'd'`);
  assert.equal(metaContent('<meta property="og:title" content="Ol&#225; mundo">', 'og:title'), 'Olá mundo');

  const html = '{"pk":"123","video_versions":[{"url":"https:\/\/cdn\/a.mp4"}]}';
  assert.equal(stringAfterKey(html, 'video_versions'), 'https://cdn/a.mp4');
});

/* ───────────────────── YouTube (Innertube) ───────────────────── */

const PLAYER_OK = {
  playabilityStatus: { status: 'OK' },
  videoDetails: { title: 'Música boa', author: 'Canal X', lengthSeconds: '212', thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/vi/v1/maxresdefault.jpg', width: 1280 }] } },
  streamingData: {
    formats: [{ itag: 18, url: 'https://rr1.googlevideo.com/muxado.mp4', mimeType: 'video/mp4', bitrate: 500000, qualityLabel: '360p' }],
    adaptiveFormats: [
      { itag: 140, url: 'https://rr1.googlevideo.com/audio.m4a', mimeType: 'audio/mp4', bitrate: 130000 },
      { itag: 251, url: 'https://rr1.googlevideo.com/audio.webm', mimeType: 'audio/webm', bitrate: 160000 }
    ]
  }
};

test('YouTube: Innertube ANDROID_VR devolve stream muxado + faixa de áudio mp4', async () => {
  await mockFetch(
    [
      ['youtubei/v1/player', () => jsonResponse(PLAYER_OK)],
      [/\.mp4$|googlevideo/, () => bufferResponse(Buffer.from('MP4DATA'))]
    ],
    async () => {
      const r = await downloadYouTube('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'melhor');
      assert.equal(r.platform, 'YouTube');
      assert.equal(r.kind, 'video');
      assert.equal(r.title, 'Música boa');
      assert.equal(r.author, 'Canal X');
      assert.equal(r.duration, 212);
      assert.equal(r.thumbnail, 'https://i.ytimg.com/vi/v1/maxresdefault.jpg');
      assert.equal(r.media[0].url, 'https://rr1.googlevideo.com/muxado.mp4');
      // prefere MP4/AAC em vez de WebM/Opus (compatibilidade com iOS)
      assert.equal(r.audioOnly.url, 'https://rr1.googlevideo.com/audio.m4a');
    }
  );
});

test('YouTube: ANDROID_VR bloqueado → IOS devolve pelo menos o áudio', async () => {
  const blocked = { playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm you are not a bot' } };
  const ios = {
    playabilityStatus: { status: 'OK' },
    videoDetails: { title: 'Vídeo', author: 'Canal', lengthSeconds: '100' },
    streamingData: {
      formats: [],
      adaptiveFormats: [{ itag: 140, url: 'https://rr2.googlevideo.com/only-audio.m4a', mimeType: 'audio/mp4', bitrate: 130000 }]
    }
  };
  let call = 0;
  await mockFetch(
    [
      [
        'youtubei/v1/player',
        () => {
          call += 1;
          return jsonResponse(call === 1 ? blocked : ios);
        }
      ]
    ],
    async () => {
      const r = await downloadYouTube('https://youtu.be/dQw4w9WgXcQ', 'melhor');
      assert.equal(call, 2, 'deve tentar o 2º cliente');
      assert.equal(r.kind, 'audio');
      assert.equal(r.media[0].url, 'https://rr2.googlevideo.com/only-audio.m4a');
    }
  );
});

test('YouTube: modo audioOnly pega só a faixa de áudio', async () => {
  await mockFetch([['youtubei/v1/player', () => jsonResponse(PLAYER_OK)]], async () => {
    const r = await downloadYouTube('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'melhor', { audioOnly: true });
    assert.equal(r.kind, 'audio');
    assert.equal(r.media[0].type, 'audio');
    assert.equal(r.media[0].url, 'https://rr1.googlevideo.com/audio.m4a');
  });
});

/* ───────────────────── TikTok (tikwm) ───────────────────── */

const TIKWM_VIDEO = {
  code: 0,
  data: {
    id: '7106594312292453675',
    title: 'Vídeo engraçado',
    duration: 15,
    author: { nickname: 'criador', unique_id: 'criador' },
    cover: 'https://www.tikwm.com/video/cover/x.webp',
    origin_cover: 'https://p16-sign.tiktokcdn.com/orig.jpg',
    hdplay: 'https://www.tikwm.com/video/media/hdplay/1.mp4',
    play: 'https://www.tikwm.com/video/media/play/1.mp4',
    wmplay: 'https://www.tikwm.com/video/media/wmplay/1.mp4',
    music: 'https://www.tikwm.com/video/music/1.mp3',
    music_info: { title: 'Trilha', play: 'https://www.tikwm.com/video/music/1.mp3' }
  }
};

test('TikTok: tikwm devolve vídeo HD + música, com capa do tiktokcdn', async () => {
  await mockFetch(
    [
      ['tikwm.com/api', () => jsonResponse(TIKWM_VIDEO)],
      ['tiktok.com/oembed', () => jsonResponse({ title: 'Vídeo engraçado', author_name: 'criador', thumbnail_url: 'https://p16.tiktokcdn.com/thumb.jpg' })],
      // sonda de codec: precisa conter um codec suportado
      [/tikwm\.com\/video\/media/, () => bufferResponse(Buffer.from('....ftypisomavc1....'))],
      ['vm.tiktok.com', () => jsonResponse({}, { status: 200 })]
    ],
    async () => {
      const r = await downloadTikTok('https://vm.tiktok.com/ZM123456/', 'melhor');
      assert.equal(r.platform, 'TikTok');
      assert.equal(r.kind, 'video');
      assert.equal(r.title, 'Vídeo engraçado');
      assert.equal(r.author, 'criador');
      assert.equal(r.duration, 15);
      assert.equal(r.media[0].url, 'https://www.tikwm.com/video/media/hdplay/1.mp4');
      assert.equal(r.audioOnly.url, 'https://www.tikwm.com/video/music/1.mp3');
      // a capa da tikwm dá 403 para todo mundo: prefere a original do tiktokcdn
      assert.ok(!r.thumbnail.includes('tikwm.com'), 'capa não deve ser hospedada na tikwm');
    }
  );
});

test('TikTok: slideshow (carrossel de fotos) vira galeria + música', async () => {
  const slideshow = {
    code: 0,
    data: {
      id: '999',
      title: 'Fotos',
      images: ['https://p16.tiktokcdn.com/1.jpeg', 'https://p16.tiktokcdn.com/2.jpeg'],
      music_info: { title: 'Trilha', play: 'https://www.tikwm.com/video/music/2.mp3' }
    }
  };
  await mockFetch(
    [
      ['tikwm.com/api', () => jsonResponse(slideshow)],
      ['tiktok.com/oembed', () => jsonResponse({})]
    ],
    async () => {
      const r = await downloadTikTok('https://www.tiktok.com/@a/photo/999', 'melhor');
      assert.equal(r.kind, 'slideshow');
      assert.equal(r.media.length, 2);
      assert.equal(r.media[0].type, 'image');
      assert.equal(r.audioOnly.url, 'https://www.tikwm.com/video/music/2.mp3');
    }
  );
});

test('TikTok: lote para figurinha para de baixar ao atingir o teto agregado', async () => {
  const slideshow = {
    code: 0,
    data: {
      id: '999',
      images: [
        'https://p16.tiktokcdn.com/image-1.jpg',
        'https://p16.tiktokcdn.com/image-2.jpg',
        'https://p16.tiktokcdn.com/image-3.jpg'
      ]
    }
  };
  let imageDownloads = 0;
  await mockFetch(
    [
      ['tikwm.com/api', () => jsonResponse(slideshow)],
      ['tiktok.com/oembed', () => jsonResponse({})],
      [/p16\.tiktokcdn\.com\/image-/, () => { imageDownloads++; return bufferResponse(Buffer.alloc(2)); }]
    ],
    async () => {
      await assert.rejects(
        resolveDownload('https://www.tiktok.com/@a/photo/999', 'melhor', { maxBytes: 2 }),
        /scraping|nenhum extrator/i
      );
      assert.equal(imageDownloads, 2, 'o terceiro arquivo não é baixado quando o agregado já atingiu 4 bytes');
    }
  );
});

test('TikTok: tikwm fora do ar → cai no Cobalt (túnel)', async () => {
  await mockFetch(
    [
      ['tikwm.com/api', () => jsonResponse({ code: -1, msg: 'free limit' })],
      ['tiktok.com/oembed', () => jsonResponse({ title: 'Do Cobalt', author_name: 'criador' })],
      ['tunnel.cobalt', () => bufferResponse(Buffer.from('MP4DATA'))],
      [/co\.otomir23|cobaltapi|cjs\.nz|meowing|canine|3kh0/, () =>
        jsonResponse({ status: 'tunnel', url: 'https://tunnel.cobalt/tiktok.mp4', filename: 'tiktok_criador_7106594312292453675.mp4' })],
      ['www.tiktok.com', () => htmlResponse('sem estado')]
    ],
    async () => {
      const r = await downloadTikTok('https://vm.tiktok.com/ZM123456/', 'melhor');
      assert.equal(r.platform, 'TikTok');
      assert.equal(r.kind, 'video');
      assert.equal(r.title, 'Do Cobalt');
      assert.ok(r.buffers?.[0]?.length, 'deve baixar o buffer do túnel');
    }
  );
});

test('tiktokVideoId extrai o id numérico', () => {
  assert.equal(tiktokVideoId('https://www.tiktok.com/@user/video/7106594312292453675'), '7106594312292453675');
  assert.equal(tiktokVideoId('https://www.tiktok.com/@user/photo/7106594312292453675'), '7106594312292453675');
});

/* ───────────────────── Pinterest ───────────────────── */

test('Pinterest: widget API devolve o vídeo na maior rendição', async () => {
  const pin = {
    data: [
      {
        grid_title: 'Ideia legal',
        description: 'descrição',
        pinner: { username: 'ana' },
        images: { orig: { url: 'https://i.pinimg.com/originals/a.jpg', width: 1000, height: 1500 } },
        videos: {
          video_list: {
            V_360P: { url: 'https://v1.pinimg.com/videos/360p.mp4', width: 480, height: 640 },
            V_720P: { url: 'https://v1.pinimg.com/videos/720p.mp4', width: 720, height: 1280 }
          }
        }
      }
    ]
  };
  await mockFetch([['widgets.pinterest.com', () => jsonResponse(pin)]], async () => {
    const r = await downloadPinterest('https://www.pinterest.com/pin/687159481848754665/', 'melhor');
    assert.equal(r.platform, 'Pinterest');
    assert.equal(r.kind, 'video');
    assert.equal(r.media[0].url, 'https://v1.pinimg.com/videos/720p.mp4');
    assert.equal(r.author, 'ana');
    assert.equal(r.title, 'Ideia legal');
  });
});

test('Pinterest: link curto (pin.it) resolve o id e consulta o widget pelo id NUMÉRICO', async () => {
  // Caso real: `.s https://pin.it/1Obiyee9V` → /pin/429530883237169819/sent/…
  const hash = 'e681f482b3f43f1e4bf0b921d7759f4e';
  const pin = {
    data: [
      {
        id: '429530883237169819',
        grid_title: 'Flamengo memes',
        pinner: { username: 'dessalobato' },
        images: {
          '236x': { url: `https://i.pinimg.com/236x/e6/81/f4/${hash}.jpg`, width: 236, height: 236 },
          '564x': { url: `https://i.pinimg.com/564x/e6/81/f4/${hash}.jpg`, width: 514, height: 514 }
        }
      }
    ]
  };
  const sentUrl =
    'https://www.pinterest.com/pin/429530883237169819/sent/?invite_code=abc&sender=1&sfo=1';
  const consulted = [];
  await mockFetch(
    [
      [
        'pin.it/1Obiyee9V',
        () => new Response('', { status: 302, headers: { location: sentUrl } })
      ],
      ['www.pinterest.com/pin/429530883237169819', () => htmlResponse('<html><body>preview</body></html>')],
      [
        'widgets.pinterest.com',
        (u) => {
          consulted.push(u);
          // Só o id numérico tem dados: com o slug, a API devolve vazio.
          return jsonResponse(u.includes('429530883237169819') ? pin : { status: 'success', data: [] });
        }
      ],
      [/i\.pinimg\.com/, () => bufferResponse(Buffer.from('IMG'))]
    ],
    async () => {
      const r = await downloadPinterest('https://pin.it/1Obiyee9V', 'melhor');
      assert.equal(consulted.length, 1);
      assert.match(consulted[0], /pin_ids=429530883237169819/);
      assert.match(consulted[0], /pin_ids=\d{5,}/, 'nunca consulta a API com o slug do link curto');
      // A maior rendição vira a versão original (mesmo hash do pin).
      assert.equal(r.kind, 'image');
      assert.equal(r.media[0].url, `https://i.pinimg.com/originals/e6/81/f4/${hash}.jpg`);
      assert.equal(r.media[0].trusted, true);
      assert.ok(
        r.alternates.some((a) => a.url === `https://i.pinimg.com/564x/e6/81/f4/${hash}.jpg`),
        'guarda as rendições menores como alternativa'
      );
    }
  );
});

test('canonicalPinUrl: link compartilhado vira a página do pin e host curto cai no pinterest.com', () => {
  assert.equal(
    canonicalPinUrl(
      'https://www.pinterest.com/pin/429530883237169819/sent/?invite_code=abc&sender=1&sfo=1',
      '429530883237169819'
    ),
    'https://www.pinterest.com/pin/429530883237169819/'
  );
  assert.equal(canonicalPinUrl('https://br.pinterest.com/pin/123/qualquer', '123'), 'https://br.pinterest.com/pin/123/');
  assert.equal(canonicalPinUrl('https://pin.it/abc', '123'), 'https://www.pinterest.com/pin/123/');
});

test('Pinterest: código curto só de dígitos é resolvido, não confundido com id', async () => {
  const hash = 'e681f482b3f43f1e4bf0b921d7759f4e';
  const consultas = [];
  await mockFetch(
    [
      [
        'pin.it/1234567890',
        () => new Response('', {
          status: 302,
          headers: { location: 'https://www.pinterest.com/pin/429530883237169819/' }
        })
      ],
      ['www.pinterest.com/pin/429530883237169819', () => htmlResponse('<html><body>preview</body></html>')],
      [
        'widgets.pinterest.com',
        (u) => {
          consultas.push(u);
          return jsonResponse({
            data: [
              {
                id: '429530883237169819',
                grid_title: 'Flamengo memes',
                pinner: { username: 'dessalobato' },
                images: { '564x': { url: `https://i.pinimg.com/564x/e6/81/f4/${hash}.jpg`, width: 514, height: 514 } }
              }
            ]
          });
        }
      ],
      [/i\.pinimg\.com/, () => bufferResponse(Buffer.from('IMG'), { contentType: 'image/jpeg' })]
    ],
    async () => {
      const r = await downloadPinterest('https://pin.it/1234567890', 'melhor');
      assert.match(consultas[0], /pin_ids=429530883237169819/);
      assert.doesNotMatch(consultas[0], /pin_ids=1234567890/);
      assert.equal(r.media[0].url, `https://i.pinimg.com/originals/e6/81/f4/${hash}.jpg`);
    }
  );
});

test('Pinterest: página sem o pin (link compartilhado /sent/) não entrega mídia', async () => {
  const outro = 'https://i.pinimg.com/564x/aa/bb/cc/aabbccddeeff00112233445566778899.jpg';
  const marca = 'https://i.pinimg.com/originals/d5/3b/01/d53b014d86a6b6761bf649a0ed813cff.jpg';
  const sentHtml = `<html><head>
    <meta property="og:title" content="Pinterest">
    <meta property="og:image" content="${marca}">
    <script id="__PWS_DATA__" type="application/json">${JSON.stringify({
      props: {
        initialReduxState: {
          pins: {
            111: { id: '111', images: { '564x': { url: outro, width: 564, height: 564 } } }
          }
        }
      }
    })}</script></head><body>sugestões de busca</body></html>`;
  await mockFetch(
    [
      ['widgets.pinterest.com', () => jsonResponse({ status: 'success', code: 0, data: [] })],
      [/pinterest\.com\/pin\/429530883237169819/, () => htmlResponse(sentHtml)],
      ['pin.it/', () => htmlResponse(sentHtml)],
      [/./, () => jsonResponse({ status: 'error', error: { code: 'error.api.link.invalid' } }, { status: 400 })]
    ],
    async () => {
      const erro = await downloadPinterest('https://pin.it/1Obiyee9V', 'melhor').then(
        () => null,
        (e) => e
      );
      assert.ok(erro, 'deve falhar em vez de devolver asset de marca/pin de outro assunto');
      assert.doesNotMatch(String(erro.message), /d53b014d|aabbccdd/);
    }
  );
});

test('findPinInState: só aceita o pin dono do id pedido', () => {
  const html = `<script id="__PWS_DATA__" type="application/json">${JSON.stringify({
    props: {
      initialReduxState: {
        pins: {
          111: { id: '111', images: { '564x': { url: 'https://i.pinimg.com/564x/aa/bb/cc/aabbccddeeff00112233445566778899.jpg' } } },
          429530883237169819: { id: '429530883237169819', images: { orig: { url: 'https://i.pinimg.com/originals/e6/81/f4/e681f482b3f43f1e4bf0b921d7759f4e.jpg' } } }
        }
      }
    }
  })}</script>`;
  assert.equal(findPinInState(html, '999'), null, 'pin de outro id nunca é aceito');
  assert.equal(findPinInState(html, null), null, 'sem id pedido não escolhe "o primeiro pin da página"');
  assert.equal(findPinInState(html, '429530883237169819').id, '429530883237169819');
});

test('imageRenditions: original na frente, rendições exatas depois, sem duplicar hash', () => {
  const hash = 'e681f482b3f43f1e4bf0b921d7759f4e';
  const list = imageRenditions({
    images: {
      '236x': { url: `https://i.pinimg.com/236x/e6/81/f4/${hash}.jpg`, width: 236, height: 236 },
      '564x': { url: `https://i.pinimg.com/564x/e6/81/f4/${hash}.jpg`, width: 514, height: 514 },
      // Sem hash de conteúdo: é asset de interface, não entra.
      banner: { url: 'https://i.pinimg.com/upload/123_board_thumbnail_2026.jpg' }
    }
  });
  assert.equal(list[0].url, `https://i.pinimg.com/originals/e6/81/f4/${hash}.jpg`);
  assert.equal(list[1].url, `https://i.pinimg.com/564x/e6/81/f4/${hash}.jpg`);
  assert.equal(new Set(list.map((i) => i.hash)).size, 1, 'mesma imagem, um hash só');
  assert.equal(list.some((i) => i.url.includes('_board_thumbnail_')), false);
});

test('Pinterest: widget fora do ar → cai no scraping do HTML (og:video)', async () => {
  const html =
    '<html><head><meta property="og:image" content="https://i.pinimg.com/736x/a.jpg">' +
    '<meta property="og:video" content="https://v1.pinimg.com/videos/x.mp4"></head></html>';
  await mockFetch(
    [
      ['widgets.pinterest.com', () => jsonResponse({ status: 404 }, { status: 404 })],
      [/pinterest\.com\/pin\//, () => htmlResponse(html)]
    ],
    async () => {
      const r = await downloadPinterest('https://www.pinterest.com/pin/123/', 'melhor');
      assert.equal(r.kind, 'video');
      assert.equal(r.media[0].url, 'https://v1.pinimg.com/videos/x.mp4');
    }
  );
});

/* ───────────────────── Instagram ───────────────────── */

function embedHtml(media, mediaType = 'GraphVideo') {
  // A página real embute o shortcode_media dentro de "contextJSON" como
  // JSON-dentro-de-JSON (com as barras escapadas).
  const inner = JSON.stringify({ gql_data: { shortcode_media: media } });
  return `<html><body><div data-media-type="${mediaType}"></div>
  <script>window.__x = {"contextJSON":${JSON.stringify(inner)}}</script></body></html>`;
}

test('Instagram: embed com video_url resolve direto (reels)', async () => {
  const media = {
    is_video: true,
    video_url: 'https://scontent.cdninstagram.com/v/reel.mp4',
    display_url: 'https://scontent.cdninstagram.com/v/poster.jpg',
    video_duration: 30,
    owner: { username: 'loja' },
    edge_media_to_caption: { edges: [{ node: { text: 'olha isso' } }] }
  };
  await mockFetch([['instagram.com/p/', () => htmlResponse(embedHtml(media))]], async () => {
    const r = await downloadInstagram('https://www.instagram.com/reel/ABCdefGHIjk/', 'melhor');
    assert.equal(r.platform, 'Instagram');
    assert.equal(r.kind, 'video');
    assert.equal(r.media[0].url, 'https://scontent.cdninstagram.com/v/reel.mp4');
    assert.equal(r.author, 'loja');
    assert.equal(r.title, 'olha isso');
    assert.equal(r.duration, 30);
  });
});

test('Instagram: embed marca is_video SEM video_url → usa a visão de crawler (o MP4 real)', async () => {
  // Este é o caso que faz bot ingênuo entregar a CAPA do reel como se fosse foto.
  const shell = { is_video: true, display_url: 'https://scontent.cdninstagram.com/v/poster.jpg', owner: { username: 'loja' } };
  const shortcode = 'ABCdefGHIjk';
  const mediaId = instagramMediaId(shortcode);
  const crawlerHtml =
    `<html><head><meta property="og:title" content="Loja on Instagram: &quot;olha o reel&quot;"></head><body>` +
    `{"pk":"${mediaId}","image_versions2":{"candidates":[{"url":"https:\/\/scontent\/poster.jpg"}]},` +
    `"video_versions":[{"url":"https:\/\/scontent.cdninstagram.com\/v\/REAL.mp4"}]}</body></html>`;

  await mockFetch(
    [
      ['/embed/captioned/', () => htmlResponse(embedHtml(shell, 'GraphVideo'))],
      ['instagram.com/reel/', () => htmlResponse(crawlerHtml)]
    ],
    async () => {
      const r = await downloadInstagram(`https://www.instagram.com/reel/${shortcode}/`, 'melhor');
      assert.equal(r.kind, 'video', 'não deve devolver a capa como imagem');
      assert.equal(r.media[0].url, 'https://scontent.cdninstagram.com/v/REAL.mp4');
      assert.equal(r.author, 'Loja');
    }
  );
});

test('Instagram: carrossel de fotos vira galeria', async () => {
  const media = {
    is_video: false,
    owner: { username: 'loja' },
    edge_sidecar_to_children: {
      edges: [
        { node: { is_video: false, display_url: 'https://scontent/1.jpg' } },
        { node: { is_video: false, display_url: 'https://scontent/2.jpg' } }
      ]
    }
  };
  await mockFetch([['instagram.com/p/', () => htmlResponse(embedHtml(media, 'GraphSidecar'))]], async () => {
    const r = await downloadInstagram('https://www.instagram.com/p/ABCdefGHIjk/', 'melhor');
    assert.equal(r.kind, 'slideshow');
    assert.equal(r.media.length, 2);
    assert.equal(r.media.every((m) => m.type === 'image'), true);
  });
});

/* ───────────────────── X / Twitter ───────────────────── */

test('X/Twitter: vxtwitter devolve vídeo e galeria de fotos', async () => {
  const payload = {
    text: 'olha o vídeo',
    user_name: 'NASA',
    media_extended: [
      { type: 'video', url: 'https://video.twimg.com/x.mp4', thumbnail_url: 'https://pbs.twimg.com/thumb.jpg' }
    ]
  };
  await mockFetch([['api.vxtwitter.com', () => jsonResponse(payload)]], async () => {
    const r = await downloadTwitter('https://x.com/nasa/status/1580661436132757504', 'melhor');
    assert.equal(r.platform, 'X (Twitter)');
    assert.equal(r.kind, 'video');
    assert.equal(r.media[0].url, 'https://video.twimg.com/x.mp4');
    assert.equal(r.author, 'NASA');
    assert.equal(r.thumbnail, 'https://pbs.twimg.com/thumb.jpg');
  });
});

test('X/Twitter: tweet com 4 fotos vira galeria (não perde anexos)', async () => {
  const payload = {
    text: 'fotos',
    user_name: 'NASA',
    media_extended: [1, 2, 3, 4].map((i) => ({ type: 'image', url: `https://pbs.twimg.com/${i}.jpg` }))
  };
  await mockFetch([['api.vxtwitter.com', () => jsonResponse(payload)]], async () => {
    const r = await downloadTwitter('https://twitter.com/nasa/status/1580661436132757504', 'melhor');
    assert.equal(r.media.length, 4);
    assert.equal(r.media.every((m) => m.type === 'image'), true);
  });
});

/* ───────────────────── Facebook ───────────────────── */

test('Facebook: plugin público entrega o stream HD (com escapes decodificados)', async () => {
  const html =
    '<html><head><meta property="og:title" content="Vídeo bom"></head>' +
    '<body>{"browser_native_hd_url":"https:\\/\\/video.xx.fbcdn.net\\/v\\/hd.mp4?efg=eyJ4IjoxfQ","foo":1}</body></html>';
  await mockFetch([['plugins/video.php', () => htmlResponse(html)]], async () => {
    const r = await downloadFacebook('https://www.facebook.com/reel/123456789/', 'melhor');
    assert.equal(r.platform, 'Facebook');
    assert.equal(r.kind, 'video');
    assert.equal(r.media[0].url, 'https://video.xx.fbcdn.net/v/hd.mp4?efg=eyJ4IjoxfQ');
    assert.equal(r.title, 'Vídeo bom');
  });
});

test('Facebook: story avisa que não dá para baixar', async () => {
  await mockFetch([], async () => {
    await assert.rejects(
      () => downloadFacebook('https://www.facebook.com/stories/123/'),
      /story/i
    );
  });
});

/* ───────────────────── Cobalt ───────────────────── */

test('Cobalt: tunnel devolve buffer e escolhe o tipo pelo nome do arquivo', async () => {
  await mockFetch(
    [
      [
        /cobalt|otomir23|cjs\.nz|meowing|canine|3kh0/,
        () => jsonResponse({ status: 'tunnel', url: 'https://tun.co/video.mp4', filename: 'youtube_video_abc.mp4' })
      ],
      ['tun.co', () => bufferResponse(Buffer.from('MP4BYTES'))]
    ],
    async () => {
      const r = await cobaltDownload('https://www.youtube.com/watch?v=abc', 'melhor');
      assert.equal(r.kind, 'video');
      assert.equal(r.media[0].type, 'video');
      assert.equal(r.buffers[0].toString(), 'MP4BYTES');
    }
  );
});

test('Cobalt: picker de carrossel devolve todos os itens', async () => {
  const picker = {
    status: 'picker',
    picker: [
      { type: 'photo', url: 'https://cdn/1.jpg', thumb: 'https://cdn/1t.jpg' },
      { type: 'photo', url: 'https://cdn/2.jpg', thumb: 'https://cdn/2t.jpg' }
    ]
  };
  await mockFetch(
    [
      [/cobalt|otomir23|cjs\.nz|meowing|canine|3kh0/, () => jsonResponse(picker)],
      [/cdn\/\d\.jpg/, () => bufferResponse(Buffer.from('IMG'))]
    ],
    async () => {
      const r = await cobaltDownload('https://www.instagram.com/p/ABC/', 'melhor');
      assert.equal(r.kind, 'slideshow');
      assert.equal(r.media.length, 2);
      assert.equal(r.buffers.length, 2);
    }
  );
});

test('Cobalt: instância que responde erro transiente é trocada pela próxima', async () => {
  // Só UMA instância responde bem; as demais devolvem 429 do Cobalt.
  // Independentemente da ordem do pool, o resultado precisa chegar.
  // (Estado do pool zerado para o teste ser determinístico: sem cooldown
  // herdado de testes anteriores e rotação começando do início.)
  const pool = cobaltPool();
  const previous = { cooldowns: pool.cooldowns, stats: pool.stats, index: pool.index };
  pool.cooldowns = new Map();
  pool.stats = new Map();
  pool.index = 0;
  let refused = 0;
  await mockFetch(
    [
      ['tun2.co', () => bufferResponse(Buffer.from('OK'))],
      [
        'cobaltapi.cjs.nz',
        () => jsonResponse({ status: 'tunnel', url: 'https://tun2.co/a.mp4', filename: 'a.mp4' })
      ],
      [
        /./,
        () => {
          refused += 1;
          return jsonResponse({ status: 'error', error: { code: 'error.api.too_many_requests' } });
        }
      ]
    ],
    async () => {
      try {
        const r = await cobaltDownload('https://www.tiktok.com/@a/video/1', 'melhor');
        assert.equal(r.buffers[0].toString(), 'OK');
        assert.ok(refused >= 1, 'deve ter recusado pelo menos uma instância antes de acertar');
      } finally {
        pool.cooldowns = previous.cooldowns;
        pool.stats = previous.stats;
        pool.index = previous.index;
      }
    }
  );
});

test('YouTube audioOnly via Cobalt entrega resultado com kind audio e media audio', async () => {
  const cobaltAudio = {
    status: 'tunnel',
    url: 'https://tun.co/audio.mp3',
    filename: 'musica_top.mp3'
  };
  await mockFetch(
    [
      ['youtubei/v1/player', () => jsonResponse({ playabilityStatus: { status: 'UNPLAYABLE' } })],
      ['youtube.com/oembed', () => jsonResponse({ title: 'Música Top', author_name: 'Artista' })],
      [/cobalt|otomir23|cjs\.nz|meowing|canine|3kh0/, () => jsonResponse(cobaltAudio)],
      ['tun.co', () => bufferResponse(Buffer.from('ID3...AUDIOBYTES'), { contentType: 'audio/mpeg' })]
    ],
    async () => {
      const r = await downloadYouTube('https://youtu.be/RS4ZzYjFZcE?is=Jl8YxIYMyy-iEeqd', 'melhor', { audioOnly: true });
      assert.equal(r.kind, 'audio');
      assert.equal(r.platform, 'YouTube');
      assert.equal(r.title, 'Música Top');
      assert.equal(r.media[0].type, 'audio');
      assert.ok(r.buffers[0].length > 0);
    }
  );
});

test('YouTube video tenta Cobalt para obter vídeo quando Innertube não tem stream muxado', async () => {
  const innertubeNoMux = {
    playabilityStatus: { status: 'OK' },
    videoDetails: { title: 'Clipe', author: 'Canal', lengthSeconds: '180' },
    streamingData: {
      formats: [],
      adaptiveFormats: [{ itag: 140, url: 'https://rr2.googlevideo.com/audio.m4a', mimeType: 'audio/mp4' }]
    }
  };
  const cobaltVideo = {
    status: 'tunnel',
    url: 'https://tun.co/video.mp4',
    filename: 'clipe_hd.mp4'
  };
  await mockFetch(
    [
      ['youtubei/v1/player', () => jsonResponse(innertubeNoMux)],
      ['youtube.com/oembed', () => jsonResponse({ title: 'Clipe Oficial', author_name: 'Canal' })],
      [/cobalt|otomir23|cjs\.nz|meowing|canine|3kh0/, () => jsonResponse(cobaltVideo)],
      ['tun.co', () => bufferResponse(Buffer.from('....ftypisom...VIDEODATA'), { contentType: 'video/mp4' })]
    ],
    async () => {
      const r = await downloadYouTube('https://www.youtube.com/watch?v=RS4ZzYjFZcE', 'melhor', { audioOnly: false });
      assert.equal(r.kind, 'video');
      assert.equal(r.title, 'Clipe Oficial');
      assert.equal(r.media[0].type, 'video');
    }
  );
});

test('sendDownload envia áudio MP4/M4A com mimetype audio/mp4 e extensão .m4a', async () => {
  const sent = [];
  const sock = {
    sendMessage: async (jid, content, opts) => {
      sent.push({ jid, content, opts });
      return { key: { id: 'SENT1' } };
    }
  };
  // Buffer com magic bytes de container MP4 (M4A)
  const m4aBuffer = Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]);
  const result = {
    platform: 'YouTube',
    title: 'Musica Legal',
    author: 'Banda',
    kind: 'audio',
    media: [{ type: 'audio', url: 'https://example.com/audio.m4a' }],
    buffers: [m4aBuffer]
  };

  await sendDownload(sock, '123@s.whatsapp.net', result, { quality: 'melhor' });
  assert.equal(sent.length, 1);
  assert.ok(sent[0].content.audio, 'deve enviar como áudio');
  assert.equal(sent[0].content.mimetype, 'audio/mp4');
  assert.equal(sent[0].content.fileName, 'Musica Legal.m4a');
  assert.equal(sent[0].content.video, undefined, 'NÃO deve enviar como vídeo');
});

test('sendDownload envia áudio MP3 com mimetype audio/mpeg e extensão .mp3', async () => {
  const sent = [];
  const sock = {
    sendMessage: async (jid, content, opts) => {
      sent.push({ jid, content, opts });
      return { key: { id: 'SENT1' } };
    }
  };
  const mp3Buffer = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00]);
  const result = {
    platform: 'YouTube',
    title: 'Musica MP3',
    kind: 'audio',
    media: [{ type: 'audio', url: 'https://example.com/audio.mp3' }],
    buffers: [mp3Buffer]
  };

  await sendDownload(sock, '123@s.whatsapp.net', result, { quality: 'melhor' });
  assert.equal(sent.length, 1);
  assert.ok(sent[0].content.audio, 'deve enviar como áudio');
  assert.equal(sent[0].content.mimetype, 'audio/mpeg');
  assert.equal(sent[0].content.fileName, 'Musica MP3.mp3');
});

test('searchYouTube encontra video por termo de busca', async () => {
  const searchMock = {
    contents: {
      twoColumnSearchResultsRenderer: {
        primaryContents: {
          sectionListRenderer: {
            contents: [
              {
                itemSectionRenderer: {
                  contents: [
                    {
                      videoRenderer: {
                        videoId: 'RS4ZzYjFZcE',
                        title: { simpleText: 'Hino do Vasco da Gama' },
                        ownerText: { runs: [{ text: 'Canal Vasco' }] }
                      }
                    }
                  ]
                }
              }
            ]
          }
        }
      }
    }
  };

  await mockFetch([['youtubei/v1/search', () => jsonResponse(searchMock)]], async () => {
    const res = await searchYouTube('hino do vasco');
    assert.equal(res?.videoId, 'RS4ZzYjFZcE');
    assert.equal(res?.title, 'Hino do Vasco da Gama');
    assert.equal(res?.url, 'https://www.youtube.com/watch?v=RS4ZzYjFZcE');
  });
});

test('downloadYouTube inclui headers com user-agent correto para evitar 403', async () => {
  await mockFetch([['youtubei/v1/player', () => jsonResponse(PLAYER_OK)]], async () => {
    const r = await downloadYouTube('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'melhor', { audioOnly: true });
    assert.equal(r.kind, 'audio');
    assert.ok(r.media[0].headers?.['user-agent']?.includes('com.google.android.apps.youtube.vr.oculus'));
  });
});
