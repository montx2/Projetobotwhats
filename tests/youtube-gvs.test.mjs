// Testes do CDN do YouTube (googlevideo / "GVS") e das regressões do `.ytmp3`.
//
// O caso real que originou este arquivo (log do usuário):
//   ⚠️ yt-dlp (YouTube) falhou; tentando Innertube {"Sign in to confirm you're not a bot"}
//   ⬇️ baixando rr2---sn-….googlevideo.com…
//   ⚠️ download de buffers falhou; tentando reservas {"status":403}
//   ⚠️ download falhou (youtu.be)
//
// Três defeitos somados: (1) GET aberto no GVS é recusado com 403, (2) a URL
// era devolvida sem ser testada, e (3) quando o download dela falhava, o
// Cobalt — a reserva que funciona de qualquer IP — era pulado. Cada teste
// abaixo trava um desses pontos.

import test from 'node:test';
import assert from 'node:assert/strict';
import { setDnsLookupForTests } from '../src/core/http.js';
import { isGoogleVideoUrl, declaredLength, probeGoogleVideo, fetchGoogleVideoBuffer } from '../src/features/downloaders/gvs.js';
import { downloadYouTube } from '../src/features/downloaders/youtube.js';
import { resolveDownload } from '../src/features/download.js';

setDnsLookupForTests(async () => [{ address: '8.8.8.8', family: 4 }]);

const AUDIO_URL = 'https://rr2---sn-vgnpoxxnv015-jo4e.googlevideo.com/videoplayback?itag=140&clen=4096';
const VIDEO_ID = 'RS4ZzYjFZcE';

function parseRange(headers) {
  const raw = new Headers(headers || {}).get('range');
  const m = String(raw || '').match(/bytes=(\d+)-(\d*)/);
  if (!m) return null;
  return { start: Number(m[1]), end: m[2] === '' ? null : Number(m[2]) };
}

/** Corpo falso de áudio, determinístico, para conferir a montagem das faixas. */
function fakeAudio(size) {
  const buf = Buffer.alloc(size);
  buf.write('ID3');
  for (let i = 3; i < size; i++) buf[i] = i % 251;
  return buf;
}

/**
 * CDN simulado com os comportamentos REAIS do googlevideo.
 * @param {{total?: number, openGet?: number, tailStatus?: number}} opts
 *   openGet    → status de um GET sem Range (403 no ANDROID_VR)
 *   tailStatus → status das faixas além da primeira (403 = exige PO token)
 */
function gvsServer({ total = 4096, openGet = 403, tailStatus = 206, chunkLimit = Infinity } = {}) {
  const body = fakeAudio(total);
  const requests = [];
  return {
    body,
    requests,
    handle(url, opts = {}) {
      const range = parseRange(opts.headers);
      requests.push({ url: String(url), range });
      if (!range) {
        if (openGet !== 200) return new Response('forbidden', { status: openGet });
        return new Response(body, { status: 200, headers: { 'content-length': String(total), 'content-type': 'audio/mp4' } });
      }
      const isFirst = range.start === 0;
      if (!isFirst && tailStatus !== 206) return new Response('forbidden', { status: tailStatus });
      const end = Math.min(range.end ?? total - 1, total - 1, range.start + chunkLimit - 1);
      const slice = body.subarray(range.start, end + 1);
      return new Response(slice, {
        status: 206,
        headers: {
          'content-type': 'audio/mp4',
          'content-length': String(slice.length),
          'content-range': `bytes ${range.start}-${end}/${total}`
        }
      });
    }
  };
}

function withFetch(router, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => router(String(url), opts);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      globalThis.fetch = original;
    });
}

function playerResponse({ audioUrl = AUDIO_URL, clen = 4096, progressive = [] } = {}) {
  return {
    playabilityStatus: { status: 'OK' },
    videoDetails: { title: 'Faixa de teste', author: 'Canal', lengthSeconds: '180' },
    streamingData: {
      formats: progressive,
      adaptiveFormats: [{ itag: 140, url: audioUrl, mimeType: 'audio/mp4', bitrate: 130000, contentLength: String(clen) }]
    }
  };
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/* ─────────────────────────── unidade: gvs.js ─────────────────────────── */

test('isGoogleVideoUrl reconhece o CDN (e não cai em host parecido)', () => {
  assert.equal(isGoogleVideoUrl(AUDIO_URL), true);
  assert.equal(isGoogleVideoUrl('https://googlevideo.com/x'), true);
  assert.equal(isGoogleVideoUrl('https://googlevideo.com.evil.net/x'), false);
  assert.equal(isGoogleVideoUrl('https://www.youtube.com/watch?v=x'), false);
  assert.equal(isGoogleVideoUrl('nao-e-url'), false);
});

test('declaredLength lê o tamanho que o próprio GVS anuncia em clen', () => {
  assert.equal(declaredLength(AUDIO_URL), 4096);
  assert.equal(declaredLength('https://rr1.googlevideo.com/v?clen=abc'), 0);
  assert.equal(declaredLength('https://rr1.googlevideo.com/v'), 0);
});

test('probeGoogleVideo: início 206 e fim 206 → ok', async () => {
  const server = gvsServer({ total: 4 * 1024 * 1024 });
  await withFetch((url, opts) => server.handle(url, opts), async () => {
    const probe = await probeGoogleVideo('https://rr1.googlevideo.com/v?clen=4194304');
    assert.equal(probe.verdict, 'ok');
    assert.equal(probe.totalBytes, 4 * 1024 * 1024);
  });
});

test('probeGoogleVideo: início 206 e fim 403 (PO token) → gated', async () => {
  const server = gvsServer({ total: 4 * 1024 * 1024, tailStatus: 403 });
  await withFetch((url, opts) => server.handle(url, opts), async () => {
    const probe = await probeGoogleVideo('https://rr1.googlevideo.com/v?clen=4194304');
    assert.equal(probe.verdict, 'gated', 'URL que só serve o começo não pode ser usada');
    assert.equal(probe.status, 403);
  });
});

test('probeGoogleVideo: 403 logo na primeira faixa → gated; rede caída → unknown', async () => {
  await withFetch(() => new Response('no', { status: 403 }), async () => {
    assert.equal((await probeGoogleVideo(AUDIO_URL)).verdict, 'gated');
  });
  await withFetch(() => Promise.reject(new Error('ECONNRESET')), async () => {
    assert.equal((await probeGoogleVideo(AUDIO_URL)).verdict, 'unknown', 'sem prova de defeito, não descarta');
  });
});

test('fetchGoogleVideoBuffer monta o arquivo em faixas quando o GET aberto é 403', async () => {
  const total = 3 * 1024 * 1024 + 777;
  const server = gvsServer({ total, openGet: 403 });
  await withFetch((url, opts) => server.handle(url, opts), async () => {
    const buffer = await fetchGoogleVideoBuffer('https://rr1.googlevideo.com/v', { maxBytes: 10 * 1024 * 1024 });
    assert.equal(buffer.length, total);
    assert.ok(buffer.equals(server.body), 'as faixas remontam o arquivo byte a byte');
    assert.ok(server.requests.length >= 3, 'baixou em várias faixas, como o player faz');
    assert.ok(server.requests.every((r) => r.range), 'nenhum GET aberto (é o que o CDN recusa)');
  });
});

test('fetchGoogleVideoBuffer respeita o teto de tamanho e propaga 403 no meio', async () => {
  await withFetch((url, opts) => gvsServer({ total: 50 * 1024 * 1024 }).handle(url, opts), async () => {
    await assert.rejects(
      fetchGoogleVideoBuffer('https://rr1.googlevideo.com/v?clen=52428800', { maxBytes: 1024 * 1024 }),
      /excede o limite/
    );
  });
  const gated = gvsServer({ total: 8 * 1024 * 1024, tailStatus: 403 });
  await withFetch((url, opts) => gated.handle(url, opts), async () => {
    await assert.rejects(fetchGoogleVideoBuffer('https://rr1.googlevideo.com/v?clen=8388608'), /HTTP 403/);
  });
});

/* ──────────────────── regressões ponta a ponta do .ytmp3 ──────────────── */

test('REGRESSÃO .ytmp3: GVS recusa GET aberto (403) mas serve faixas → o áudio chega', async () => {
  const server = gvsServer({ total: 2 * 1024 * 1024, openGet: 403 });
  const router = (url, opts) => {
    if (url.includes('youtubei/v1/player')) return json(playerResponse({ clen: 2 * 1024 * 1024 }));
    if (url.includes('googlevideo')) return server.handle(url, opts);
    return json({}, 404);
  };
  await withFetch(router, async () => {
    const result = await resolveDownload(`https://youtu.be/${VIDEO_ID}`, 'melhor', { audioOnly: true });
    assert.equal(result.kind, 'audio');
    assert.equal(result.platform, 'YouTube');
    assert.equal(result.buffers.length, 1);
    assert.equal(result.buffers[0].length, 2 * 1024 * 1024, 'arquivo completo, não truncado');
    assert.equal(result.buffers[0].toString('latin1', 0, 3), 'ID3');
  });
});

test('REGRESSÃO .ytmp3: URL com PO token (fim 403) é descartada e o Cobalt assume', async () => {
  const gated = gvsServer({ total: 8 * 1024 * 1024, tailStatus: 403 });
  const tunnelBody = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(2048, 7)]);
  let cobaltCalls = 0;
  const router = (url, opts) => {
    if (url.includes('youtubei/v1/player')) return json(playerResponse({ clen: 8 * 1024 * 1024 }));
    if (url.includes('googlevideo')) return gated.handle(url, opts);
    if (url.includes('oembed')) return json({ title: 'Música Boa', author_name: 'Artista' });
    if (/cobalt|otomir23|cjs\.nz|meowing|canine|3kh0|imput/.test(url)) {
      cobaltCalls++;
      return json({ status: 'tunnel', url: 'https://tun.co/audio.mp3', filename: 'musica.mp3' });
    }
    if (url.includes('tun.co')) {
      return new Response(tunnelBody, { status: 200, headers: { 'content-type': 'audio/mpeg', 'content-length': String(tunnelBody.length) } });
    }
    return json({}, 404);
  };
  await withFetch(router, async () => {
    const result = await downloadYouTube(`https://youtu.be/${VIDEO_ID}`, 'melhor', { audioOnly: true });
    assert.ok(cobaltCalls > 0, 'o Cobalt precisa ser acionado quando o CDN recusa a URL');
    assert.equal(result.kind, 'audio');
    assert.equal(result.title, 'Música Boa');
    assert.equal(result.buffers[0].toString('latin1', 0, 3), 'ID3');
    assert.equal(result.cobaltTried, true);
  });
});

test('REGRESSÃO: extrator dedicado devolve URL que não baixa → o Cobalt deixa de ser pulado', async () => {
  // Antes, `resolveDownload` assumia que o extrator dedicado "já tinha tentado
  // o Cobalt" só por ser YouTube — e, como o Innertube devolvia a URL cedo, a
  // reserva nunca rodava: o usuário recebia "download falhou".
  const tunnelBody = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(4096, 3)]);
  let cobaltCalls = 0;
  const router = (url, opts) => {
    if (url.includes('youtubei/v1/player')) return json(playerResponse({ clen: 1024 }));
    // Sondagem passa (unknown/ok), download real explode: o pior caso possível.
    if (url.includes('googlevideo')) {
      const range = parseRange(opts.headers);
      if (range && range.start === 0 && range.end === 1) return new Response(Buffer.alloc(2), { status: 206, headers: { 'content-range': 'bytes 0-1/1024' } });
      return new Response('forbidden', { status: 403 });
    }
    if (url.includes('oembed')) return json({ title: 'Faixa', author_name: 'Canal' });
    if (/cobalt|otomir23|cjs\.nz|meowing|canine|3kh0|imput/.test(url)) {
      cobaltCalls++;
      return json({ status: 'tunnel', url: 'https://tun.co/a.mp3', filename: 'a.mp3' });
    }
    if (url.includes('tun.co')) {
      return new Response(tunnelBody, { status: 200, headers: { 'content-type': 'audio/mpeg', 'content-length': String(tunnelBody.length) } });
    }
    return json({}, 404);
  };
  await withFetch(router, async () => {
    const result = await resolveDownload(`https://youtu.be/${VIDEO_ID}`, 'melhor', { audioOnly: true });
    assert.ok(cobaltCalls > 0, 'a reserva tem que rodar quando o download da URL dedicada falha');
    assert.equal(result.kind, 'audio');
    assert.ok(result.buffers[0].length > 0);
  });
});

test('.ytmp3: tudo falha → o erro explica o motivo e traz a dica de cookies', async () => {
  const router = (url) => {
    if (url.includes('youtubei/v1/player')) {
      return json({ playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm you’re not a bot' } });
    }
    return json({}, 404);
  };
  await withFetch(router, async () => {
    await assert.rejects(downloadYouTube(`https://youtu.be/${VIDEO_ID}`, 'melhor', { audioOnly: true }), (error) => {
      assert.match(error.message, /Sign in to confirm/);
      assert.match(String(error.hint || ''), /YTDLP_COOKIES/);
      assert.equal(error.cobaltTried, true);
      return true;
    });
  });
});
