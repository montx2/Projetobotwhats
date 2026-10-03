// 🧪 Testes da voz (catálogo + motores) e da geração de imagem.
//
// Nada de internet aqui: o "serviço de voz" é um WebSocket falso local e as
// APIs de imagem são substituídas por um `fetch` de mentira. O que está sendo
// testado é o que costuma quebrar na vida real:
//   • o token Sec-MS-GEC (se errar, o serviço devolve 403);
//   • o protocolo do Edge TTS (quadros binários com cabeçalho de 2 bytes);
//   • a escolha de voz por nome (`.voz bob …`) e as aspas que protegem o texto;
//   • a cascata de reserva quando o motor principal não responde;
//   • os atalhos do `.criar` (--formato, --estilo, --hd, --bruto, --seed).

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

process.env.NEXUS_ENV_FILE = path.join(os.tmpdir(), 'nexus-teste-vozes-sem-env', '.env');

import { setDnsLookupForTests } from '../src/core/http.js';
import {
  buildEdgeSsml,
  edgeSocketUrl,
  edgeTimestamp,
  parseEdgeAudioFrame,
  secMsGec,
  setClockSkewMs,
  edgeSynthesize,
  EDGE_SEC_MS_GEC_VERSION
} from '../src/features/tts-edge.js';
import {
  buildPitchSpeedFilter,
  buildVoiceFxChain,
  parseCustomVoices,
  parseVoiceRequest,
  resolveVoice,
  voiceCatalogLines,
  isVoiceName
} from '../src/features/voices.js';
import { parseImageRequest, extractImageFlags, composeImagePrompt, aiImageFull } from '../src/features/ai.js';

setDnsLookupForTests(async () => [{ address: '8.8.8.8', family: 4 }]);

// ── Edge TTS: token e protocolo ────────────────────────────────────────────
test('Sec-MS-GEC bate com a implementação de referência e muda a cada 5 minutos', () => {
  setClockSkewMs(0);
  // Valores conferidos com a implementação oficial (edge-tts/drm.py).
  assert.equal(secMsGec(Date.parse('2026-10-03T19:00:00Z'), 0), '0A72A26C0917B484BF1F6AE68D5E2461170A9B6CBE558E40CAE3E650678A6586');
  assert.equal(secMsGec(Date.parse('2026-10-03T19:04:59Z'), 0), '0A72A26C0917B484BF1F6AE68D5E2461170A9B6CBE558E40CAE3E650678A6586');
  assert.equal(secMsGec(Date.parse('2026-10-03T19:05:00Z'), 0), '0D5EB8B3CB4A4432D61A3540598241E417A43CD370BF3C9FC838075ED2C46F1F');
  assert.equal(secMsGec(Date.parse('2026-01-01T00:00:00Z'), 0), '42D1947403FD94975436C65DBFCA8003073F9CB5C3F1CE25AF8961A11D7C3DFE');

  // Relógio atrasado/adiantado: a correção muda o token junto.
  assert.notEqual(secMsGec(Date.parse('2026-10-03T19:07:00Z'), 0), secMsGec(Date.parse('2026-10-03T19:07:00Z'), 60 * 60_000));
});

test('URL do WebSocket carrega o token, o ConnectionId e a versão esperada', () => {
  const url = edgeSocketUrl({ nowMs: Date.parse('2026-10-03T19:00:00Z'), connectionId: 'abc123' });
  assert.match(url, /^wss:\/\/speech\.platform\.bing\.com\/consumer\/speech\/synthesize\/readaloud\/edge\/v1\?/);
  assert.match(url, /TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4/);
  assert.match(url, /ConnectionId=abc123/);
  assert.ok(url.includes(encodeURIComponent(EDGE_SEC_MS_GEC_VERSION).replace(/%2F/gi, '')) || url.includes(EDGE_SEC_MS_GEC_VERSION));
  assert.match(url, /Sec-MS-GEC=[0-9A-F]{64}/);
});

test('SSML escapa caracteres perigosos e leva voz, tom e velocidade', () => {
  const ssml = buildEdgeSsml('5 < 6 & "aspas" \'sim\'', { voice: 'pt-BR-AntonioNeural', pitch: '+35%', rate: '+8%' });
  assert.match(ssml, /<voice name='pt-BR-AntonioNeural'>/);
  assert.match(ssml, /<prosody pitch='\+35%' rate='\+8%' volume='\+0%'>/);
  assert.match(ssml, /5 &lt; 6 &amp; &quot;aspas&quot; &apos;sim&apos;/);
  assert.doesNotMatch(ssml, /<script/);
});

test('quadro binário de áudio é lido pelo tamanho do cabeçalho e pelo separador', () => {
  const audio = Buffer.from('ID3' + 'A'.repeat(4000), 'latin1');
  const headers = Buffer.from('X-RequestId:x\r\nContent-Type:audio/mpeg\r\nPath:audio\r\n', 'utf8');
  // O prefixo conta só o texto do cabeçalho: o áudio começa em comprimento + 2.
  const prefix = Buffer.alloc(2);
  prefix.writeUInt16BE(headers.length, 0);
  const frame = Buffer.concat([prefix, headers, audio]);

  const parsed = parseEdgeAudioFrame(frame);
  assert.equal(parsed.path, 'audio');
  assert.equal(parsed.audio.length, audio.length);
  assert.equal(parsed.audio.subarray(0, 3).toString(), 'ID3');

  // Sem o prefixo de 2 bytes válido, cai no fallback por \r\n\r\n.
  const legacy = Buffer.concat([Buffer.from([0, 0]), headers, Buffer.from('\r\n'), audio]);
  const parsedLegacy = parseEdgeAudioFrame(legacy);
  assert.equal(parsedLegacy.path, 'audio');
  assert.equal(parsedLegacy.audio.length, audio.length);
});

// ── Edge TTS: conversa completa com um servidor de mentira ────────────────
function fakeEdgeServer() {
  const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
  const frame = (opcode, payload) => {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
    let header;
    if (data.length < 126) header = Buffer.from([0x80 | opcode, data.length]);
    else {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(data.length, 2);
    }
    return Buffer.concat([header, data]);
  };

  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let buffer = Buffer.alloc(0);
      let handshaken = false;
      let textFrames = 0;
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (!handshaken) {
          const end = buffer.indexOf('\r\n\r\n');
          if (end === -1) return;
          const request = buffer.subarray(0, end).toString('utf8');
          const key = /sec-websocket-key: (.+)/i.exec(request)?.[1].trim();
          socket.write(
            'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
              `Sec-WebSocket-Accept: ${crypto.createHash('sha1').update(key + GUID).digest('base64')}\r\n\r\n`
          );
          handshaken = true;
          buffer = buffer.subarray(end + 4);
          resolve({ server, request });
        }
        while (buffer.length >= 2) {
          const opcode = buffer[0] & 0x0f;
          const masked = (buffer[1] & 0x80) !== 0;
          let len = buffer[1] & 0x7f;
          let offset = 2;
          if (len === 126) {
            if (buffer.length < 4) return;
            len = buffer.readUInt16BE(2);
            offset = 4;
          }
          const maskKey = masked ? buffer.subarray(offset, offset + 4) : null;
          if (masked) offset += 4;
          if (buffer.length < offset + len) return;
          let payload = Buffer.from(buffer.subarray(offset, offset + len));
          if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
          buffer = buffer.subarray(offset + len);
          if (opcode !== 0x1) continue;
          textFrames += 1;
          if (textFrames === 1) {
            socket.write(frame(0x1, 'X-RequestId:a\r\nPath:turn.start\r\n\r\n{}'));
          } else if (textFrames === 2) {
            const audio = Buffer.from('ID3' + 'B'.repeat(5000), 'latin1');
            const headers = Buffer.from('X-RequestId:a\r\nContent-Type:audio/mpeg\r\nPath:audio\r\n', 'utf8');
            const prefix = Buffer.alloc(2);
            prefix.writeUInt16BE(headers.length, 0);
            socket.write(frame(0x2, Buffer.concat([prefix, headers, audio])));
            socket.write(frame(0x1, 'X-RequestId:a\r\nPath:turn.end\r\n\r\n{}'));
            setTimeout(() => socket.end(), 30);
          }
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

test('edgeSynthesize conversa o protocolo inteiro e devolve o MP3', async () => {
  const { server, port } = await fakeEdgeServer();
  try {
    const buffer = await edgeSynthesize('bom dia', {
      voice: 'pt-BR-AntonioNeural',
      url: `ws://127.0.0.1:${port}/edge/v1`,
      timeoutMs: 8000
    });
    assert.ok(Buffer.isBuffer(buffer));
    assert.equal(buffer.subarray(0, 3).toString(), 'ID3');
    assert.ok(buffer.length > 5000);
  } finally {
    server.close();
  }
});

test('edgeTimestamp sai no formato que o serviço exige', () => {
  const stamp = edgeTimestamp(new Date('2026-10-03T19:00:05Z'));
  assert.equal(stamp, 'Sat Oct 03 2026 19:00:05 GMT+0000 (Coordinated Universal Time)');
});

// ── Catálogo de vozes ─────────────────────────────────────────────────────
test('catálogo resolve nomes, apelidos e acentos', () => {
  assert.equal(resolveVoice('bob').id, 'bob');
  assert.equal(resolveVoice('Bob Esponja').id, 'bob');
  assert.equal(resolveVoice('BOB-ESPONJA').id, 'bob');
  assert.equal(resolveVoice('lula').id, 'lula');
  assert.equal(resolveVoice('Lula').id, 'lula');
  assert.equal(resolveVoice('antonio').id, 'antonio');
  assert.equal(resolveVoice('Antônio').id, 'antonio');
  assert.equal(resolveVoice('narrador').id, 'narrador');
  assert.equal(resolveVoice('').id, 'auto');
  // Nome técnico do motor também vale.
  assert.equal(resolveVoice('pt-BR-ThalitaNeural').voice, 'pt-BR-ThalitaNeural');
  // Voz inexistente: erro claro e com sugestão.
  assert.throws(() => resolveVoice('bobe'), /não existe/);
});

test('vozes de personagem trazem tom, velocidade e efeitos já definidos', () => {
  const bob = resolveVoice('bob');
  assert.ok(bob.pitchPct > 20, 'Bob precisa subir o tom');
  assert.ok(bob.speedPct > 0, 'Bob fala mais rápido');
  assert.ok(bob.fx.length > 0);

  const lula = resolveVoice('lula');
  assert.ok(lula.pitchPct < 0, 'Lula precisa descer o tom');
  assert.ok(lula.speedPct < 0, 'Lula fala mais devagar');

  // Toda voz do catálogo tem descrição e id utilizável no comando.
  for (const [, desc] of voiceCatalogLines()) assert.ok(desc && desc.length > 3);
});

test('VOZES_EXTRA cria vozes próprias, inclusive nos motores grátis offline', () => {
  const extra = parseCustomVoices(
    'meuvoz=pt-BR-ThalitaNeural|pitch=+25|rate=+10|fx=nasal+ecoCurto|desc=teste,' +
      'robô=espeak:pt-br+f3|fx=grave, semAspas=en-US-GuyNeural, neural=piper:voz.onnx|rate=-10'
  );
  assert.equal(extra.length, 4);
  const [meuvoz, robo, simples, piperVoice] = extra;
  assert.equal(meuvoz.id, 'meuvoz');
  assert.equal(meuvoz.pitch, 25); // campo cru do .env — o público (pitchPct) vem do resolveVoice
  assert.deepEqual(meuvoz.fx, ['nasal', 'ecoCurto']);
  // Motores locais/offline são grátis; nenhum prefixo aponta para serviço pago.
  assert.equal(robo.engine, 'espeak');
  assert.equal(robo.voice, 'pt-br+f3');
  assert.equal(simples.engine, 'edge');
  assert.equal(piperVoice.engine, 'piper');
  assert.equal(piperVoice.voice, 'voz.onnx');

  const resolved = resolveVoice('meuvoz', { extra });
  assert.equal(resolved.pitchPct, 25);
  assert.equal(resolved.speedPct, 10);
  assert.equal(resolved.fx.length, 2);

  assert.equal(isVoiceName('meuvoz', { extra }), true);
  assert.equal(isVoiceName('meuvoz'), false);
});

test('parseVoiceRequest separa voz de texto (e respeita aspas e --voz)', () => {
  const extra = parseCustomVoices('meuvoz=pt-BR-ThalitaNeural');

  assert.deepEqual(parseVoiceRequest(['bob', 'bom', 'dia']), { voice: 'bob', text: 'bom dia', explicit: true });
  assert.deepEqual(parseVoiceRequest(['bob']), { voice: 'bob', text: null, explicit: true });
  assert.deepEqual(parseVoiceRequest(['bom', 'dia', 'pessoal']), { voice: null, text: 'bom dia pessoal', explicit: false });
  // Aspas protegem um texto que começa com nome de voz.
  assert.deepEqual(parseVoiceRequest(['bob', '"lula",', 'é', 'o', 'cara']), { voice: 'bob', text: '"lula", é o cara', explicit: true });
  assert.deepEqual(parseVoiceRequest(['"lula é o cara"']), { voice: null, text: 'lula é o cara', explicit: false });
  // Marcador explícito em qualquer posição.
  assert.deepEqual(parseVoiceRequest(['olá', '--voz', 'bob', 'tudo', 'bem']), { voice: 'bob', text: 'olá tudo bem', explicit: true });
  // Voz cadastrada no .env também é reconhecida.
  assert.equal(parseVoiceRequest(['meuvoz', 'teste'], { extra }).voice, 'meuvoz');
});

test('cadeia de efeitos e correção de tom/velocidade do FFmpeg', () => {
  assert.equal(buildVoiceFxChain(['nasal', 'ecoCurto']), 'treble=g=5,bass=g=-5,aecho=0.8:0.88:45:0.28');
  assert.equal(buildVoiceFxChain(['filtro_cru=1']), 'filtro_cru=1');
  assert.equal(buildVoiceFxChain(['inventado']), '');

  const chain = buildPitchSpeedFilter({ pitchPct: 30, speedPct: 10, fx: ['brilho'] });
  assert.match(chain, /asetrate=62400/);
  assert.match(chain, /atempo=0\.846/);
  assert.match(chain, /treble=g=3/);

  assert.equal(buildPitchSpeedFilter({}), '');
});

// ── .criar: atalhos do comando ────────────────────────────────────────────
test('parseImageRequest entende estilo no começo, --formato, --seed, --sem, --hd e --bruto', () => {
  const request = parseImageRequest('anime um gato samurai na chuva --formato 9:16 --hd --seed 42 --sem texto');
  assert.equal(request.prompt, 'um gato samurai na chuva');
  assert.equal(request.style, 'anime');
  assert.equal(request.format.key, '9:16');
  assert.equal(request.format.width, 864);
  assert.equal(request.format.height, 1536);
  assert.equal(request.seed, 42);
  assert.equal(request.negative, 'texto');
  assert.equal(request.refine, true);
  assert.equal(request.hd, true);

  const bruto = parseImageRequest('realista um robô --bruto --estilo cartoon');
  assert.equal(bruto.prompt, 'um robô');
  assert.equal(bruto.style, 'cartoon');
  assert.equal(bruto.refine, false);

  const simples = parseImageRequest('um cachorro voando');
  assert.equal(simples.prompt, 'um cachorro voando');
  assert.equal(simples.style, null);
  assert.equal(simples.hd, false);
  assert.ok(simples.seed > 0 && simples.seed < 1_000_000_000);
});

test('flags com = também funcionam e somem do prompt', () => {
  const { flags, text } = extractImageFlags('um castelo --formato=16:9 --modelo=flux');
  assert.equal(flags.format, '16:9');
  assert.equal(flags.model, 'flux');
  assert.equal(text, 'um castelo');
});

test('composeImagePrompt junta pedido, estilo e o que evitar', () => {
  const prompt = composeImagePrompt({
    prompt: 'a cat astronaut',
    stylePrompt: 'photorealistic, 50mm photo',
    negative: 'texto',
    format: { label: 'vertical 9:16' }
  });
  assert.match(prompt, /a cat astronaut/);
  assert.match(prompt, /photorealistic, 50mm photo/);
  assert.match(prompt, /vertical 9:16/);
  assert.match(prompt, /avoid: texto/);
});

// ── Cascatas de reserva (com fetch de mentira) ────────────────────────────
const MP3 = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from('C'.repeat(6000), 'latin1')]);
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.from('D'.repeat(5000), 'latin1')
]);

test('sem o motor Edge, a voz cai para o provedor grátis seguinte', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  const calls = [];
  // Remove o WebSocket nativo: é o mesmo caminho de um Node antigo/offline.
  delete globalThis.WebSocket;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('streamelements.com')) {
      return new Response(MP3, { headers: { 'content-type': 'audio/mpeg' } });
    }
    throw new Error(`chamada inesperada: ${url}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
  });

  const { aiVoiceFull } = await import(`../src/features/ai.js?fallback=${Date.now()}`);
  const result = await aiVoiceFull('teste de voz', 'bob');
  assert.equal(result.engine, 'streamelements');
  assert.equal(result.fallback, true);
  assert.ok(result.buffer.length > 1000);
  assert.ok(calls.some((url) => url.includes('streamelements.com')));
});

test('imagem: usa o Pollinations quando não há chave e respeita formato e seed', async (t) => {
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    const text = String(url);
    seen.push(text);
    if (text.includes('image.pollinations.ai/models')) {
      return new Response(JSON.stringify(['flux', 'sana']), { headers: { 'content-type': 'application/json' } });
    }
    if (text.includes('image.pollinations.ai/prompt/')) {
      return new Response(JPEG, { headers: { 'content-type': 'image/jpeg' } });
    }
    throw new Error(`chamada inesperada: ${text}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const { aiImageFull } = await import(`../src/features/ai.js?imagem=${Date.now()}`);
  const result = await aiImageFull('um dragão roxo --formato 16:9 --bruto --seed 7');
  assert.equal(result.engine, 'pollinations');
  assert.equal(result.format, '16:9');
  assert.ok(result.buffer.length > 1000);

  const promptCall = seen.find((url) => url.includes('/prompt/'));
  assert.match(promptCall, /width=1536/);
  assert.match(promptCall, /height=864/);
  assert.match(promptCall, /seed=7/);
  assert.match(promptCall, /private=true/);
  assert.match(promptCall, /model=flux/);
});

test('imagem: falha em todos os modelos vira erro explicativo', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const text = String(url);
    if (text.includes('/models')) {
      return new Response(JSON.stringify(['flux']), { headers: { 'content-type': 'application/json' } });
    }
    return new Response('ocupado', { status: 402, headers: { 'content-type': 'text/plain' } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const { aiImageFull } = await import(`../src/features/ai.js?falha=${Date.now()}`);
  await assert.rejects(
    () => aiImageFull('qualquer coisa --bruto'),
    /não consegui gerar a imagem agora/
  );
});

test('motores pagos são ignorados com aviso; polly: continua funcionando (grátis)', () => {
  const extra = parseCustomVoices('antigo=eleven:abc123|fx=grave, daCasa=polly:Vitoria|fx=radio');
  // A entrada do motor pago sai do catálogo (não quebra o .voz)…
  assert.equal(extra.length, 1);
  // …e a voz da reserva grátis segue valendo, agora como motor próprio.
  assert.equal(extra[0].id, 'dacasa'); // ids são normalizados (sem acento/maiúscula)
  assert.equal(extra[0].engine, 'polly');
  assert.equal(extra[0].voice, 'Vitoria');
});
