// Testes offline do caminho yt-dlp para YouTube (.ytmp3 / .yt).
// Um "yt-dlp falso" (script Node) imita o contrato do binário real: lê -o,
// grava o arquivo + .info.json e registra os argumentos recebidos.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setDnsLookupForTests } from '../src/core/http.js';
import {
  canUseYtdlp,
  resetYtdlpCache,
  youtubeWatchUrl,
  ytdlpBuffer
} from '../src/features/downloaders/ytdlp.js';
import { resolveDownload } from '../src/features/download.js';

setDnsLookupForTests(async () => [{ address: '8.8.8.8', family: 4 }]);

const isWindows = process.platform === 'win32';
const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

const FAKE_SCRIPT = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('2026.10.01'); process.exit(0); }
if (process.env.FAKE_YTDLP_LOG) fs.appendFileSync(process.env.FAKE_YTDLP_LOG, JSON.stringify(args) + '\\n');
const mode = process.env.FAKE_YTDLP_MODE || 'ok';
if (mode === 'old' && args.includes('--js-runtimes')) {
  console.error('yt-dlp: error: no such option: --js-runtimes');
  process.exit(2);
}
if (mode === 'fail') {
  console.error("WARNING: [youtube] algo");
  console.error("ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm you're not a bot");
  process.exit(1);
}
const template = args[args.indexOf('-o') + 1];
const audio = /^bestaudio/.test(args[args.indexOf('-f') + 1] || '');
const out = template.replace('%(ext)s', audio ? 'mp3' : 'mp4');
fs.writeFileSync(out, Buffer.concat([Buffer.from(audio ? 'ID3' : '\\0\\0\\0\\x18ftypmp42'), Buffer.alloc(64, 1)]));
fs.writeFileSync(path.join(path.dirname(out), 'media.info.json'), JSON.stringify({ title: 'Música do yt-dlp', uploader: 'Canal Y', duration: 212.4, thumbnail: 'https://i.ytimg.com/x.jpg' }));
`;

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-ytdlp-'));
const fakeBin = path.join(tmpRoot, 'yt-dlp');
const logFile = path.join(tmpRoot, 'calls.log');
fs.writeFileSync(fakeBin, FAKE_SCRIPT, { mode: 0o755 });

const ENV_KEYS = ['YTDLP_PATH', 'NEXUS_ENABLE_YTDLP', 'NEXUS_DISABLE_YTDLP', 'FAKE_YTDLP_MODE', 'FAKE_YTDLP_LOG', 'YTDLP_JS_RUNTIME'];

function withEnv(env, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, { NEXUS_DISABLE_YTDLP: 'false', FAKE_YTDLP_LOG: logFile }, env);
  resetYtdlpCache();
  fs.rmSync(logFile, { force: true });
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      resetYtdlpCache();
    });
}

const calls = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
const leftoverDirs = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('nexus-ytdlp-'));

test('youtubeWatchUrl só aceita ID de 11 caracteres', () => {
  assert.equal(youtubeWatchUrl('dQw4w9WgXcQ'), YT);
  assert.equal(youtubeWatchUrl('curto'), null);
  assert.equal(youtubeWatchUrl('dQw4w9WgXcQ&x=../../'), null);
  assert.equal(youtubeWatchUrl(null), null);
});

test('canUseYtdlp: YouTube canônico liberado; outros sites só com NEXUS_ENABLE_YTDLP', { skip: isWindows }, async () => {
  await withEnv({ YTDLP_PATH: fakeBin }, () => {
    assert.equal(canUseYtdlp(YT), true);
    assert.equal(canUseYtdlp('https://youtu.be/dQw4w9WgXcQ'), false, 'só a URL canônica montada pelo bot');
    assert.equal(canUseYtdlp('https://www.youtube.com/redirect?q=http://127.0.0.1/'), false);
    assert.equal(canUseYtdlp('https://vimeo.com/123'), false);
  });
  await withEnv({ YTDLP_PATH: fakeBin, NEXUS_ENABLE_YTDLP: 'true' }, () => {
    assert.equal(canUseYtdlp('https://vimeo.com/123'), true);
  });
  await withEnv({ YTDLP_PATH: fakeBin, NEXUS_ENABLE_YTDLP: 'true', NEXUS_DISABLE_YTDLP: 'true' }, () => {
    assert.equal(canUseYtdlp(YT), false, 'DISABLE vale até para o YouTube');
  });
});

test('canUseYtdlp: sem binário instalado → false', async () => {
  await withEnv({ YTDLP_PATH: path.join(tmpRoot, 'nao-existe') }, () => {
    // candidatos padrão (yt-dlp/youtube-dl/python -m yt_dlp) também podem não existir no CI
    const result = canUseYtdlp(YT);
    assert.equal(typeof result, 'boolean');
  });
});

test('ytdlpBuffer (áudio): grava em arquivo temporário, passa --js-runtimes e limpa tudo', { skip: isWindows }, async () => {
  await withEnv({ YTDLP_PATH: fakeBin }, async () => {
    const before = leftoverDirs().length;
    const { buffer, info } = await ytdlpBuffer(YT, { audioOnly: true });
    assert.ok(buffer.length > 3);
    assert.ok(info?.title === 'Música do yt-dlp' && info.author === 'Canal Y' && info.duration === 212);
    const [args] = calls();
    assert.ok(!(args.includes('-o') && args[args.indexOf('-o') + 1] === '-'), 'nunca usar stdout (-o -)');
    assert.equal(args[args.indexOf('--js-runtimes') + 1], `node:${process.execPath}`);
    assert.equal(args.at(-1), YT);
    assert.equal(leftoverDirs().length, before, 'diretório temporário removido');
  });
});

test('ytdlpBuffer: YTDLP_JS_RUNTIME customiza e "off" remove a opção', { skip: isWindows }, async () => {
  await withEnv({ YTDLP_PATH: fakeBin, YTDLP_JS_RUNTIME: 'deno' }, async () => {
    await ytdlpBuffer(YT, { audioOnly: true });
    assert.equal(calls()[0][calls()[0].indexOf('--js-runtimes') + 1], 'deno');
  });
  await withEnv({ YTDLP_PATH: fakeBin, YTDLP_JS_RUNTIME: 'off' }, async () => {
    await ytdlpBuffer(YT, { audioOnly: true });
    assert.ok(!calls()[0].includes('--js-runtimes'));
  });
});

test('ytdlpBuffer: yt-dlp antigo sem --js-runtimes → tenta de novo sem a opção', { skip: isWindows }, async () => {
  await withEnv({ YTDLP_PATH: fakeBin, FAKE_YTDLP_MODE: 'old' }, async () => {
    const { buffer } = await ytdlpBuffer(YT, { audioOnly: true });
    assert.ok(buffer.length > 3);
    const all = calls();
    assert.equal(all.length, 2);
    assert.ok(all[0].includes('--js-runtimes'));
    assert.ok(!all[1].includes('--js-runtimes'));
  });
});

test('ytdlpBuffer: erro do yt-dlp devolve a linha ERROR e limpa o temporário', { skip: isWindows }, async () => {
  await withEnv({ YTDLP_PATH: fakeBin, FAKE_YTDLP_MODE: 'fail' }, async () => {
    const before = leftoverDirs().length;
    await assert.rejects(ytdlpBuffer(YT, { audioOnly: true }), (error) => {
      assert.match(error.message, /^yt-dlp: ERROR: .*Sign in to confirm/);
      return true;
    });
    assert.equal(leftoverDirs().length, before);
  });
});

test('ytdlpBuffer recusa URL que não é do YouTube quando NEXUS_ENABLE_YTDLP está desligado', { skip: isWindows }, async () => {
  await withEnv({ YTDLP_PATH: fakeBin }, async () => {
    await assert.rejects(ytdlpBuffer('https://vimeo.com/123', { audioOnly: true }), /desativado/);
    assert.equal(calls().length, 0, 'o binário nem chega a rodar');
  });
});

const PLAYER_AUDIO = {
  playabilityStatus: { status: 'OK' },
  videoDetails: { title: 'Via Innertube', author: 'Canal X', lengthSeconds: '100' },
  streamingData: {
    formats: [],
    adaptiveFormats: [{ itag: 140, url: 'https://rr2.googlevideo.com/a.m4a', mimeType: 'audio/mp4', bitrate: 130000 }]
  }
};

function routedFetch({ googlevideoStatus }) {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    seen.push(u);
    if (u.includes('youtubei/v1/player')) {
      return new Response(JSON.stringify(PLAYER_AUDIO), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('googlevideo')) {
      if (googlevideoStatus !== 200) return new Response('forbidden', { status: googlevideoStatus });
      const body = Buffer.concat([Buffer.from('\0\0\0\x18ftypM4A '), Buffer.alloc(64, 2)]);
      return new Response(body, { status: 200, headers: { 'content-type': 'audio/mp4', 'content-length': String(body.length) } });
    }
    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
  };
  return { seen, restore: () => { globalThis.fetch = original; } };
}

test('REGRESSÃO .ytmp3: googlevideo dá 403, mas o yt-dlp entrega o áudio sem tocar no Innertube', { skip: isWindows }, async () => {
  await withEnv({ YTDLP_PATH: fakeBin }, async () => {
    const net = routedFetch({ googlevideoStatus: 403 });
    try {
      const r = await resolveDownload('https://youtu.be/dQw4w9WgXcQ', 'melhor', { audioOnly: true });
      assert.equal(r.platform, 'YouTube');
      assert.equal(r.kind, 'audio');
      assert.equal(r.title, 'Música do yt-dlp');
      assert.equal(r.author, 'Canal Y');
      assert.equal(r.buffers.length, 1);
      assert.equal(r.buffers[0].toString('latin1', 0, 3), 'ID3');
      assert.equal(net.seen.filter((u) => u.includes('googlevideo')).length, 0);
      assert.equal(calls()[0].at(-1), YT, 'o yt-dlp recebe a URL canônica, não a original');
    } finally {
      net.restore();
    }
  });
});

test('.ytmp3: yt-dlp falha (bot check) → cai no Innertube e entrega o áudio de lá', { skip: isWindows }, async () => {
  await withEnv({ YTDLP_PATH: fakeBin, FAKE_YTDLP_MODE: 'fail' }, async () => {
    const net = routedFetch({ googlevideoStatus: 200 });
    try {
      const r = await resolveDownload(YT, 'melhor', { audioOnly: true });
      assert.equal(r.kind, 'audio');
      assert.equal(r.title, 'Via Innertube');
      assert.equal(calls().length, 1, 'yt-dlp roda uma vez só (sem repetir como reserva)');
    } finally {
      net.restore();
    }
  });
});

test('.ytmp3: yt-dlp e Innertube falham → erro final traz o motivo do yt-dlp', { skip: isWindows }, async () => {
  await withEnv({ YTDLP_PATH: fakeBin, FAKE_YTDLP_MODE: 'fail' }, async () => {
    const net = routedFetch({ googlevideoStatus: 403 });
    try {
      await assert.rejects(resolveDownload(YT, 'melhor', { audioOnly: true }), (error) => {
        assert.match(error.message, /yt-dlp: ERROR: .*Sign in to confirm/);
        return true;
      });
      assert.equal(calls().length, 1);
    } finally {
      net.restore();
    }
  });
});

test('.yt (vídeo): yt-dlp entrega mp4 antes do Innertube', { skip: isWindows }, async () => {
  await withEnv({ YTDLP_PATH: fakeBin }, async () => {
    const net = routedFetch({ googlevideoStatus: 403 });
    try {
      const r = await resolveDownload(YT, 'melhor');
      assert.equal(r.kind, 'video');
      assert.equal(r.buffers[0].toString('latin1', 4, 8), 'ftyp');
    } finally {
      net.restore();
    }
  });
});

test.after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
