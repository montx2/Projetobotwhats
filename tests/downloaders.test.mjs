// Testes offline dos extratores de redes sociais (node:test, fetch mockado).
// Cada teste simula a resposta REAL que o serviço devolve (tikwm, Innertube,
// vxtwitter, widget do Pinterest, embed do Instagram, plugin do Facebook) e
// confere que o bot extrai a mídia certa — inclusive nos casos que quebram os
// bots ingênuos (reels sem video_url no embed, codec próprio do TikTok, etc).

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseYouTubeId, downloadYouTube } from '../src/features/downloaders/youtube.js';
import { downloadTikTok, tiktokVideoId } from '../src/features/downloaders/tiktok.js';
import { downloadPinterest, extractPinId } from '../src/features/downloaders/pinterest.js';
import {
  downloadInstagram,
  instagramShortcode,
  instagramMediaId,
  instagramLinkIsVideo
} from '../src/features/downloaders/instagram.js';
import { downloadTwitter, parseTweet } from '../src/features/downloaders/twitter.js';
import { downloadFacebook } from '../src/features/downloaders/facebook.js';
import { parseTwitchClipSlug } from '../src/features/downloaders/generic.js';
import { cobaltDownload } from '../src/features/downloaders/cobalt.js';
import { detectPlatform } from '../src/features/download.js';
import {
  kindByExtension,
  looksLikeImageBytes,
  decodeEntities,
  metaContent,
  stringAfterKey
} from '../src/features/downloaders/media.js';

/* ───────────────────────── mock de fetch ───────────────────────── */

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    url: 'https://mock/',
    headers: { get: (k) => ({ 'content-type': 'application/json', ...headers })[String(k).toLowerCase()] ?? null },
    text: async () => text,
    body: null
  };
}

function htmlResponse(html, { status = 200 } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    url: 'https://mock/',
    headers: { get: (k) => ({ 'content-type': 'text/html' })[String(k).toLowerCase()] ?? null },
    text: async () => html,
    body: null
  };
}

function bufferResponse(buf, { status = 200, contentType = 'video/mp4' } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    url: 'https://mock/',
    headers: { get: (k) => ({ 'content-type': contentType, 'content-length': String(buf.length) })[String(k).toLowerCase()] ?? null },
    text: async () => buf.toString('latin1'),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(buf));
        controller.close();
      }
    })
  };
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
        return res ?? jsonResponse({});
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
  // Só UMA instância responde bem; as outras 4 devolvem 429 do Cobalt.
  // Independentemente da ordem do pool, o resultado precisa chegar.
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
      const r = await cobaltDownload('https://www.tiktok.com/@a/video/1', 'melhor');
      assert.equal(r.buffers[0].toString(), 'OK');
      assert.ok(refused >= 1, 'deve ter recusado pelo menos uma instância antes de acertar');
    }
  );
});
