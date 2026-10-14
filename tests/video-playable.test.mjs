// Testes da garantia "o vídeo TEM que tocar no WhatsApp" (bug real relatado:
// vídeo do Pinterest chegava ao chat e o WhatsApp dizia "há algo errado com
// o arquivo de vídeo" — a rendição vinha em MP4 fragmentado/HEVC e o bot
// mandava os bytes crus). Cobre o inspetor de contêiner (util/mp4.js), a
// normalização (util/ffmpeg.js) e o fluxo do Pinterest com rendição ruim
// caindo para a próxima (features/download.js + downloaders/pinterest.js).

import test from 'node:test';
import assert from 'node:assert/strict';
import { setDnsLookupForTests } from '../src/core/http.js';

import { inspectVideoFile, isWhatsAppPlayableVideo } from '../src/util/mp4.js';
import { normalizeVideoForWhatsApp } from '../src/util/ffmpeg.js';
import { downloadPinterest, videoRenditions } from '../src/features/downloaders/pinterest.js';
import { resolveDownload } from '../src/features/download.js';

setDnsLookupForTests(async () => [{ address: '8.8.8.8', family: 4 }]);

/* ───────────────────────── mock de fetch ───────────────────────── */

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { 'content-type': 'application/json', ...headers } });
}

function bufferResponse(buf, { status = 200, contentType = 'video/mp4' } = {}) {
  return new Response(buf, { status, headers: { 'content-type': contentType, 'content-length': String(buf.length) } });
}

function textResponse(text, { status = 200, contentType = 'application/vnd.apple.mpegurl' } = {}) {
  return new Response(text, { status, headers: { 'content-type': contentType } });
}

async function freshResponse(response) {
  const body = response.body ? await response.clone().arrayBuffer() : null;
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function mockFetch(routes, fn) {
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

/* ───────────────────── construtor de MP4 falso ───────────────────── */

function mp4Box(type, payload = Buffer.alloc(0)) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, 'ascii');
  return Buffer.concat([head, payload]);
}

function stsd(codec) {
  return mp4Box(
    'stsd',
    Buffer.concat([Buffer.alloc(4), Buffer.from([0, 0, 0, 1]), mp4Box(codec, Buffer.alloc(16))])
  );
}

function trak(kind, codec) {
  const hdlr = mp4Box('hdlr', Buffer.concat([Buffer.alloc(8), Buffer.from(kind, 'ascii')]));
  return mp4Box('trak', mp4Box('mdia', Buffer.concat([hdlr, mp4Box('minf', mp4Box('stbl', stsd(codec)))])));
}

/**
 * MP4 sintético com a estrutura que o inspetor lê.
 * fragmented: moov com `mvex` + `moof` no topo (o CMAF que sai do HLS).
 * moov: false simula arquivo truncado (só ftyp + mdat).
 */
function fakeMp4({ videoCodec = 'avc1', audioCodec = 'mp4a', fragmented = false, moov = true } = {}) {
  const parts = [mp4Box('ftyp', Buffer.from('isomiso2', 'ascii'))];
  if (moov) {
    const traks = [trak('vide', videoCodec)];
    if (audioCodec) traks.push(trak('soun', audioCodec));
    const moovParts = fragmented ? [mp4Box('mvex', Buffer.alloc(8)), ...traks] : traks;
    parts.push(mp4Box('moov', Buffer.concat(moovParts)));
  }
  if (fragmented) parts.push(mp4Box('moof', Buffer.alloc(24)));
  parts.push(mp4Box('mdat', Buffer.alloc(64, 3)));
  return Buffer.concat(parts);
}

/**
 * Download cortado no meio do mdat com `moov` faststart intacto — o caso real
 * do print: ffmpeg avisa "partial file", mas moov/codec estão perfeitos e o
 * WhatsApp recusa o arquivo. O mdat declara 5000 bytes e só 100 chegam.
 */
function truncatedFaststartMp4() {
  const traks = [trak('vide', 'avc1'), trak('soun', 'mp4a')];
  const mdatHead = Buffer.alloc(8);
  mdatHead.writeUInt32BE(8 + 5000, 0);
  mdatHead.write('mdat', 4, 'ascii');
  return Buffer.concat([
    mp4Box('ftyp', Buffer.from('isomiso2', 'ascii')),
    mp4Box('moov', Buffer.concat(traks)),
    mdatHead,
    Buffer.alloc(100, 3)
  ]);
}

/** MP4 completo sem nenhum mdat (só metadados — não há o que reproduzir). */
function mp4WithoutMdat() {
  const traks = [trak('vide', 'avc1'), trak('soun', 'mp4a')];
  return Buffer.concat([
    mp4Box('ftyp', Buffer.from('isomiso2', 'ascii')),
    mp4Box('moov', Buffer.concat(traks))
  ]);
}

/** Arquivo completo com rabo de encoder (12 bytes que não formam caixa). */
function mp4WithJunkTail() {
  const junk = Buffer.alloc(12, 0);
  junk.writeUInt32BE(4, 0); // tamanho 4 < cabeçalho de 8: caixa inválida, não truncamento
  return Buffer.concat([fakeMp4(), junk]);
}

/* ───────────────────────── inspetor ───────────────────────── */

test('inspetor: MP4 progressivo H.264 + AAC é reproduzível', () => {
  const info = inspectVideoFile(fakeMp4());
  assert.equal(info.isMp4, true);
  assert.equal(info.videoCodec, 'avc1');
  assert.equal(info.audioCodec, 'mp4a');
  assert.equal(info.fragmented, false);
  assert.equal(info.playable, true);
  assert.deepEqual(info.problems, []);
  assert.equal(isWhatsAppPlayableVideo(fakeMp4()), true);
});

test('inspetor: HEVC/AV1/VP9 dentro do MP4 são reprovados', () => {
  for (const codec of ['hvc1', 'hev1', 'av01', 'vp09']) {
    const info = inspectVideoFile(fakeMp4({ videoCodec: codec }));
    assert.equal(info.videoCodec, codec);
    assert.equal(info.playable, false, `${codec} não devia passar`);
    assert.match(info.problems.join(' '), /sem suporte no WhatsApp/);
  }
});

test('inspetor: MP4 fragmentado (CMAF do HLS/Pinterest) é reprovado', () => {
  const info = inspectVideoFile(fakeMp4({ fragmented: true }));
  assert.equal(info.fragmented, true);
  assert.equal(info.playable, false);
  assert.match(info.problems.join(' '), /fragmentado/);
});

test('inspetor: sem moov (truncado) e WebM disfarçado são reprovados', () => {
  const truncated = inspectVideoFile(fakeMp4({ moov: false }));
  assert.equal(truncated.hasMoov, false);
  assert.equal(truncated.playable, false);

  const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64, 1)]);
  const disguised = inspectVideoFile(webm);
  assert.equal(disguised.format, 'webm');
  assert.equal(disguised.playable, false);

  const ts = Buffer.alloc(188 * 2, 0x47);
  assert.equal(inspectVideoFile(ts).format, 'mpegts');
  assert.equal(inspectVideoFile(ts).playable, false);
});

test('inspetor: download truncado no mdat (faststart) é REPROVADO — era o que passava em silêncio', () => {
  const info = inspectVideoFile(truncatedFaststartMp4());
  assert.equal(info.truncated, true);
  assert.equal(info.playable, false, 'arquivo cortado não pode ser entregue');
  assert.match(info.problems.join(' '), /truncado/);
});

test('inspetor: MP4 sem mdat (só metadados) não é reproduzível', () => {
  const info = inspectVideoFile(mp4WithoutMdat());
  assert.equal(info.hasMdat, false);
  assert.equal(info.hasVideo, true);
  assert.equal(info.playable, false);
  assert.match(info.problems.join(' '), /sem caixa mdat/);
});

test('inspetor: rabo de encoder (caixa inválida depois do fim) NÃO é acusado de truncamento', () => {
  const info = inspectVideoFile(mp4WithJunkTail());
  assert.equal(info.truncated, false);
  assert.equal(info.playable, true, 'arquivo completo com lixo no fim continua válido');
});

test('inspetor: MP4 só de áudio não é vídeo reproduzível; lixo também não', () => {
  const audioOnly = (() => {
    const parts = [mp4Box('ftyp', Buffer.from('M4A ', 'ascii')), mp4Box('moov', trak('soun', 'mp4a')), mp4Box('mdat', Buffer.alloc(16))];
    return Buffer.concat(parts);
  })();
  const info = inspectVideoFile(audioOnly);
  assert.equal(info.hasVideo, false);
  assert.equal(info.playable, false);

  assert.equal(inspectVideoFile(Buffer.from('not a video at all, just text')).playable, false);
  assert.equal(inspectVideoFile(Buffer.alloc(0)).playable, false);
});

/* ─────────────────────── normalização ─────────────────────── */

test('normalize: vídeo que já reproduz volta intocado (mesmos bytes)', async () => {
  const good = fakeMp4();
  assert.equal(await normalizeVideoForWhatsApp(good), good);
});

test('normalize: vídeo que o WhatsApp não toca e não dá p/ consertar é rejeitado', async () => {
  // Bytes sintéticos: com FFmpeg ele não decodifica isto; sem FFmpeg nem tenta.
  // Nos dois mundos o chamador recebe erro (e tenta outra rendição) em vez de
  // um arquivo quebrado silencioso.
  await assert.rejects(() => normalizeVideoForWhatsApp(fakeMp4({ videoCodec: 'hvc1' })));
  await assert.rejects(() => normalizeVideoForWhatsApp(fakeMp4({ fragmented: true })));
});

/* ─────────────────── Pinterest: rendições ─────────────────── */

const WIDGET_PIN = {
  data: [
    {
      id: '687159481848754665',
      grid_title: 'Vídeo qualquer',
      pinner: { username: 'ana' },
      images: { orig: { url: 'https://i.pinimg.com/originals/aa/bb/cc/aabbccddeeff00112233445566778899.jpg', width: 720, height: 1280 } },
      videos: {
        video_list: {
          V_360P: { url: 'https://v1.pinimg.com/videos/iht/expMp4/aa/360w.mp4', width: 360, height: 640, duration: 20500 },
          V_720P: { url: 'https://v1.pinimg.com/videos/iht/expMp4/aa/720w.mp4', width: 720, height: 1280, duration: 20500 },
          V_HLSV4: { url: 'https://v1.pinimg.com/videos/iht/hls/aa/pin.m3u8', width: 720, height: 1280, duration: 20500 },
          V_HLSV3_MOBILE: { url: 'https://v1.pinimg.com/videos/iht/hls/aa/pin_mobile.m3u8', width: 480, height: 854, duration: 20500 }
        }
      }
    }
  ]
};

test('Pinterest: videoRenditions ordena progressiva (maior→menor) antes do HLS', () => {
  const list = videoRenditions(WIDGET_PIN.data[0]);
  assert.deepEqual(
    list.map((r) => r.url.split('/').pop()),
    ['720w.mp4', '360w.mp4', 'pin.m3u8', 'pin_mobile.m3u8']
  );
  assert.equal(list[0].hint, 'video');
  assert.equal(list[2].hint, 'hls');
});

test('Pinterest: pin de vídeo expõe as outras rendições como alternativas (antes das imagens)', async () => {
  await mockFetch([['widgets.pinterest.com', () => jsonResponse(WIDGET_PIN)]], async () => {
    const r = await downloadPinterest('https://www.pinterest.com/pin/687159481848754665/', 'melhor');
    assert.equal(r.kind, 'video');
    assert.equal(r.media[0].url, 'https://v1.pinimg.com/videos/iht/expMp4/aa/720w.mp4');
    assert.equal(r.duration, 21, 'duração vem do duration (ms) da rendição');
    const altUrls = r.alternates.map((a) => a.url);
    assert.ok(altUrls[0].endsWith('360w.mp4'), '1ª alternativa é outra rendição de vídeo');
    assert.ok(altUrls.some((u) => u.endsWith('.m3u8')), 'HLS entra como alternativa de vídeo');
    assert.ok(altUrls[altUrls.length - 1].includes('pinimg.com'), 'imagem só depois de todos os vídeos');
  });
});

test('Pinterest: pin só com HLS entrega o manifesto como mídia (motor HLS assume)', async () => {
  const pin = {
    data: [
      {
        id: '687159481848754665',
        videos: {
          video_list: {
            V_HLSV4: { url: 'https://v1.pinimg.com/videos/iht/hls/aa/pin.m3u8', width: 720, height: 1280, duration: 9000 }
          }
        }
      }
    ]
  };
  await mockFetch([['widgets.pinterest.com', () => jsonResponse(pin)]], async () => {
    const r = await downloadPinterest('https://www.pinterest.com/pin/687159481848754665/', 'melhor');
    assert.equal(r.kind, 'video');
    assert.equal(r.media[0].hint, 'hls');
    assert.ok(r.media[0].url.endsWith('.m3u8'));
  });
});

/* ─────────── integração: o .dl não entrega vídeo quebrado ─────────── */

const PIN_URL = 'https://www.pinterest.com/pin/687159481848754665/';

test('resolveDownload: rendição em HEVC cai para a próxima rendição (H.264) do mesmo pin', async () => {
  const broken = fakeMp4({ videoCodec: 'hvc1' });
  const good = fakeMp4({ videoCodec: 'avc1' });
  await mockFetch(
    [
      ['widgets.pinterest.com', () => jsonResponse(WIDGET_PIN)],
      ['720w.mp4', () => bufferResponse(broken)],
      ['360w.mp4', () => bufferResponse(good)]
    ],
    async () => {
      const result = await resolveDownload(PIN_URL, 'melhor');
      assert.equal(result.platform, 'Pinterest');
      assert.equal(result.kind, 'video');
      assert.deepEqual(result.buffers[0], good, 'quem vai ao chat é a rendição que toca');
    }
  );
});

test('resolveDownload: pin só com rendição que o WhatsApp não toca NÃO vira envio quebrado', async () => {
  const pin = {
    data: [
      {
        id: '687159481848754665',
        grid_title: 'Só HEVC',
        videos: {
          video_list: {
            V_720P: { url: 'https://v1.pinimg.com/videos/iht/expMp4/aa/720w.mp4', width: 720, height: 1280, duration: 5000 }
          }
        }
      }
    ]
  };
  await mockFetch(
    [
      ['widgets.pinterest.com', () => jsonResponse(pin)],
      ['720w.mp4', () => bufferResponse(fakeMp4({ videoCodec: 'hvc1' }))]
    ],
    async () => {
      await assert.rejects(
        () => resolveDownload(PIN_URL, 'melhor'),
        (error) => {
          assert.match(error.message, /WhatsApp não reproduz/);
          return true;
        }
      );
    }
  );
});

test('resolveDownload: rendição TRUNCADA cai para a próxima rendição (H.264) do mesmo pin', async () => {
  // Caso do print: o CDN cortou o corpo no meio do mdat; o inspetor tem que
  // reprovar e a cascata buscar a próxima rendição em vez de mandar o corte.
  const truncated = truncatedFaststartMp4();
  const good = fakeMp4({ videoCodec: 'avc1' });
  await mockFetch(
    [
      ['widgets.pinterest.com', () => jsonResponse(WIDGET_PIN)],
      ['720w.mp4', () => bufferResponse(truncated)],
      ['360w.mp4', () => bufferResponse(good)]
    ],
    async () => {
      const result = await resolveDownload(PIN_URL, 'melhor');
      assert.equal(result.platform, 'Pinterest');
      assert.equal(result.kind, 'video');
      assert.deepEqual(result.buffers[0], good, 'quem vai ao chat é a rendição inteira');
    }
  );
});

test('resolveDownload: pin cuja ÚNICA rendição veio truncada NÃO vira envio quebrado', async () => {
  const pin = {
    data: [
      {
        id: '687159481848754665',
        grid_title: 'Só truncado',
        videos: {
          video_list: {
            V_720P: { url: 'https://v1.pinimg.com/videos/iht/expMp4/aa/720w.mp4', width: 720, height: 1280, duration: 5000 }
          }
        }
      }
    ]
  };
  await mockFetch(
    [
      ['widgets.pinterest.com', () => jsonResponse(pin)],
      ['720w.mp4', () => bufferResponse(truncatedFaststartMp4())]
    ],
    async () => {
      await assert.rejects(
        () => resolveDownload(PIN_URL, 'melhor'),
        (error) => {
          assert.match(error.message, /incompleto|truncado|cortado/);
          return true;
        }
      );
    }
  );
});

test('resolveDownload: pin só-HLS fragmentado não é entregue cru ao WhatsApp', async () => {
  const pin = {
    data: [
      {
        id: '687159481848754665',
        videos: {
          video_list: {
            V_HLSV4: { url: 'https://v1.pinimg.com/videos/iht/hls/aa/pin.m3u8', width: 720, height: 1280, duration: 8000 }
          }
        }
      }
    ]
  };
  const playlist = `#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4.0,\nseg1.m4s\n#EXT-X-ENDLIST\n`;
  const init = (() => {
    const traks = [trak('vide', 'avc1'), trak('soun', 'mp4a')];
    return Buffer.concat([
      mp4Box('ftyp', Buffer.from('isomiso2', 'ascii')),
      mp4Box('moov', Buffer.concat([mp4Box('mvex', Buffer.alloc(8)), ...traks]))
    ]);
  })();
  const seg = Buffer.concat([mp4Box('moof', Buffer.alloc(16)), mp4Box('mdat', Buffer.alloc(32, 5))]);
  await mockFetch(
    [
      ['widgets.pinterest.com', () => jsonResponse(pin)],
      ['hls/aa/pin.m3u8', () => textResponse(playlist)],
      ['hls/aa/init.mp4', () => bufferResponse(init)],
      ['hls/aa/seg1.m4s', () => bufferResponse(seg)]
    ],
    async () => {
      // Sem conserto possível (bytes sintéticos), o resultado tem que ser ERRO
      // explicado — nunca o fMP4 cru que o WhatsApp recusa.
      await assert.rejects(
        () => resolveDownload(PIN_URL, 'melhor'),
        (error) => {
          assert.match(error.message, /WhatsApp não reproduz|fragmentado/);
          return true;
        }
      );
    }
  );
});
