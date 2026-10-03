// 🧪 Testes da voz (catálogo + motores) e da geração de imagem.
//
// Nada de internet aqui: o "serviço de voz" é um WebSocket falso local e as
// APIs de imagem são substituídas por um `fetch` de mentira. O que está sendo
// testado é o que costuma quebrar na vida real:
//   • o token Sec-MS-GEC (se errar, o serviço devolve 403);
//   • o protocolo do Edge TTS (quadros binários com cabeçalho de 2 bytes);
//   • a escolha de voz/tom no comando (`.voz masculina grossa …`) e as aspas
//     que protegem o texto;
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
  resetEdgeStateForTests,
  edgeSocketUrl,
  edgeTimestamp,
  parseEdgeAudioFrame,
  secMsGec,
  setClockSkewMs,
  edgeSynthesize,
  EDGE_SEC_MS_GEC_VERSION
} from '../src/features/tts-edge.js';
import {
  VOICE_TONES,
  buildPitchSpeedFilter,
  buildVoiceFxChain,
  describeRecipe,
  describeSpec,
  isVoiceName,
  parseCustomVoices,
  parseVoiceRequest,
  resolveFxList,
  resolveTone,
  resolveVoice,
  resolveVoiceSpec,
  toneOptionLines,
  voiceOptionLines,
  voiceRecipe
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

// ── Vozes e tons ────────────────────────────────────────────────────────────
test('catálogo resolve nomes, apelidos e acentos', () => {
  assert.equal(resolveVoice('masculina').voice, 'pt-BR-AntonioNeural');
  assert.equal(resolveVoice('Masculina').id, 'masculina');
  assert.equal(resolveVoice('homem').id, 'masculina');
  assert.equal(resolveVoice('feminina').id, 'feminina');
  assert.equal(resolveVoice('mulher').id, 'feminina');
  assert.equal(resolveVoice('narrador').id, 'narrador');
  assert.equal(resolveVoice('Antônio').id, 'masculina'); // apelido com acento
  assert.equal(resolveVoice('').id, 'auto');
  // Nome técnico do motor também vale.
  assert.equal(resolveVoice('pt-BR-ThalitaNeural').voice, 'pt-BR-ThalitaNeural');
  // Voz inexistente: erro claro, com as opções na mensagem.
  assert.throws(() => resolveVoice('vozinha'), /não existe/);
  assert.throws(() => resolveVoice('vozinha'), /masculina, feminina/);
  // Personagens não existem mais — e o erro ensina o caminho novo.
  assert.throws(() => resolveVoice('bob'), /não existe/);
  // Tom digitado no lugar da voz: o erro explica, em vez de falar "não existe".
  assert.throws(() => resolveVoice('grossa'), /é um tom, não uma voz/);
});

test('tom vira pitch: grossa desce, fina sobe, e o número fino também vale', () => {
  assert.equal(resolveVoice('masculina', { tone: resolveTone('grossa') }).pitchPct, -25);
  assert.equal(resolveVoice('masculina', { tone: resolveTone('muitogrossa') }).pitchPct, -45);
  assert.equal(resolveVoice('feminina', { tone: resolveTone('fina') }).pitchPct, 25);
  assert.equal(resolveVoice('feminina', { tone: resolveTone('muitofina') }).pitchPct, 45);
  assert.equal(resolveVoice('masculina', { tone: resolveTone('normal') }).pitchPct, 0);
  // Número direto, com ou sem sinal, com limite.
  assert.equal(resolveTone('-30'), -30);
  assert.equal(resolveTone('+12'), 12);
  assert.equal(resolveTone('40'), 40);
  assert.equal(resolveTone('-999'), -60, 'passou do limite: prende no mínimo');
  assert.throws(() => resolveTone('banana'), /não existe/);
  // Apelidos de tom funcionam como o nome.
  assert.equal(resolveTone('grave'), -45);
  assert.equal(resolveTone('aguda'), 25);
  // Todo tom tem uma linha de ajuda.
  assert.equal(toneOptionLines().length, VOICE_TONES.length);
  for (const [usageLine, desc] of toneOptionLines()) {
    assert.match(usageLine, /^\.voz \w+ <texto>$/);
    assert.ok(desc.length > 3);
  }
  for (const [usageLine, desc] of voiceOptionLines()) {
    assert.match(usageLine, /^\.voz \w+ <texto>$/);
    assert.ok(desc.length > 3);
  }
});

test('efeitos: nomes conferidos (sem erro, o efeito seria ignorado em silêncio)', () => {
  assert.deepEqual(resolveFxList('ecoCurto+radio'), ['ecoCurto', 'radio']);
  assert.deepEqual(resolveFxList('ECOCURTO'), ['ecoCurto']); // não liga para maiúscula
  assert.throws(() => resolveFxList('eco'), /não existe/);
  assert.throws(() => resolveFxList(''), /escreva o nome do efeito/);
});

test('parseVoiceRequest separa voz, tom e texto (aspas e flags incluídas)', () => {
  const extra = parseCustomVoices('meuvoz=pt-BR-ThalitaNeural');

  // Só texto: nada é configurado.
  assert.deepEqual(parseVoiceRequest(['bom', 'dia', 'pessoal']), {
    voice: null, tone: null, speed: null, fx: null, text: 'bom dia pessoal', explicit: false, recipe: null
  });
  // Tom no começo.
  const grossa = parseVoiceRequest(['grossa', 'boa', 'noite']);
  assert.equal(grossa.tone, -25);
  assert.equal(grossa.text, 'boa noite');
  assert.equal(grossa.recipe, '--tom grossa');
  // Voz + tom, em qualquer ordem.
  const dupla = parseVoiceRequest(['feminina', 'fina', 'bom', 'dia']);
  assert.equal(dupla.voice, 'feminina');
  assert.equal(dupla.tone, 25);
  assert.equal(dupla.text, 'bom dia');
  assert.equal(parseVoiceRequest(['fina', 'feminina', 'bom dia']).recipe, 'feminina --tom fina');
  // Flags em qualquer posição, com ou sem "=".
  const flags = parseVoiceRequest(['olá', '--tom', '-30', '--vel=-10', 'tudo', 'bem']);
  assert.equal(flags.tone, -30);
  assert.equal(flags.speed, -10);
  assert.equal(flags.text, 'olá tudo bem');
  assert.equal(flags.recipe, '--tom -30 --vel -10');
  assert.equal(parseVoiceRequest(['oi', '--voz', 'narrador', 'e', 'agora']).voice, 'narrador');
  // Número com sinal, sem flag.
  assert.equal(parseVoiceRequest(['-40', 'boa', 'noite']).tone, -40);
  // Aspas protegem um texto que começa com voz ou tom.
  assert.deepEqual(parseVoiceRequest(['grossa', '"grossa é o nome"']), {
    voice: null, tone: -25, speed: null, fx: null, text: 'grossa é o nome', explicit: true, recipe: '--tom grossa'
  });
  assert.equal(parseVoiceRequest(['\"masculina é legal\"']).text, 'masculina é legal');
  assert.equal(parseVoiceRequest(['\"masculina é legal\"']).voice, null);
  // Voz só, sem texto: prévia.
  assert.deepEqual(parseVoiceRequest(['masculina']).text, null);
  assert.equal(parseVoiceRequest(['masculina']).explicit, true);
  // Voz cadastrada no .env também é reconhecida.
  assert.equal(parseVoiceRequest(['meuvoz', 'teste'], { extra }).voice, 'meuvoz');
  // Texto comum que começa com palavra parecida NÃO vira configuração.
  assert.equal(parseVoiceRequest(['hoje', 'foi', 'top']).voice, null);
  assert.equal(parseVoiceRequest(['hoje', 'foi', 'top']).tone, null);
});

test('receita: o que o comando monta é o que o config guarda e o bot relê', () => {
  const recipe = voiceRecipe({ voice: 'masculina', tone: -25, speed: -10 });
  assert.equal(recipe, 'masculina --tom grossa --vel -10');
  const spec = resolveVoiceSpec(recipe);
  assert.equal(spec.id, 'masculina');
  assert.equal(spec.pitchPct, -25);
  assert.equal(spec.speedPct, -10);
  assert.equal(describeSpec(spec), 'Masculina · tom -25% (grossa) · velocidade -10%');
  assert.equal(describeRecipe(recipe), describeSpec(spec));
  // Receita vazia = voz padrão, sem erro.
  assert.equal(resolveVoiceSpec('').id, 'auto');
  assert.equal(resolveVoiceSpec('--tom -30').pitchPct, -30);
  // Receita que o bot não entende descreve exatamente o que ele vai fazer
  // (falar com a voz automática) — a descrição nunca mente.
  assert.equal(describeRecipe('voz-que-nao-existe'), describeSpec(resolveVoiceSpec('voz-que-nao-existe')));
  // Receita inválida de verdade não derruba a descrição: mostra como veio.
  assert.equal(describeRecipe('--tom banana'), '--tom banana');
});

test('o tom pedido substitui o tom de fábrica da voz do .env', () => {
  const extra = parseCustomVoices('meuvoz=pt-BR-ThalitaNeural|pitch=+25|rate=+10');
  assert.equal(resolveVoiceSpec('meuvoz', { extra }).pitchPct, 25);
  assert.equal(resolveVoiceSpec('meuvoz --tom grossa', { extra }).pitchPct, -25);
  assert.equal(resolveVoiceSpec('meuvoz --tom grossa', { extra }).speedPct, 10, 'a velocidade da voz continua');
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
  const result = await aiVoiceFull('teste de voz', 'masculina grossa');
  assert.equal(result.engine, 'streamelements');
  assert.equal(result.fallback, true);
  // O tom sobrevive à reserva (é o FFmpeg que corrige, não o SSML do Edge).
  assert.equal(result.settingsLabel, 'Masculina · tom -25% (grossa)');
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

// ── Motor Edge (regressão) ──────────────────────────────────────────────────
// O `.voz` usava `edgeVoiceFor(spec)`, função que NUNCA existiu: a chamada
// quebrava com ReferenceError e o áudio saía sempre de uma reserva
// (StreamElements/Google/Pollinations). Como nessas reservas o tom é feito por
// FFmpeg (chipmunk), era exatamente isso que fazia a voz "não parecer" nada.
test('o motor Edge é chamado de verdade e escolhe a voz na lista do serviço', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  const VOICES = JSON.stringify([
    { ShortName: 'pt-BR-AntonioNeural', Locale: 'pt-BR', Gender: 'Male' },
    { ShortName: 'pt-BR-FranciscaNeural', Locale: 'pt-BR', Gender: 'Female' }
  ]);
  let openedUrl = null;

  // WebSocket de mentira: abre e falha (a ideia é ver ATÉ ONDE o .voz chega).
  class StubSocket {
    constructor(url) {
      openedUrl = url;
      this.binaryType = '';
      this.handlers = {};
      setTimeout(() => this.emit('error', {}), 0);
    }
    addEventListener(type, fn) {
      (this.handlers[type] ||= []).push(fn);
    }
    emit(type, event) {
      for (const fn of this.handlers[type] || []) fn(event || {});
    }
    send() {}
    close() {}
  }

  globalThis.WebSocket = StubSocket;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/voices/list')) {
      return new Response(VOICES, { headers: { 'content-type': 'application/json' } });
    }
    throw new Error('rede fora do ar (teste)');
  };
  resetEdgeStateForTests();
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
    resetEdgeStateForTests();
  });

  const { aiVoiceFull, edgeVoiceFor, resetVoiceCooldowns } = await import(`../src/features/ai.js?edge=${Date.now()}`);
  resetVoiceCooldowns();

  // Voz do catálogo encontrada na lista; voz aposentada cai para a mesma
  // língua/gênero em vez de mandar um nome que o serviço não tem.
  assert.equal(await edgeVoiceFor({ voice: 'pt-BR-AntonioNeural', alts: ['pt-BR-DonatoNeural'] }), 'pt-BR-AntonioNeural');
  assert.equal(await edgeVoiceFor({ voice: 'pt-BR-AposentadaNeural', alts: ['pt-BR-DonatoNeural'] }), 'pt-BR-AntonioNeural');
  assert.equal(await edgeVoiceFor({ voice: 'pt-BR-FranciscaNeural', alts: [] }), 'pt-BR-FranciscaNeural');

  let message = '';
  try {
    await aiVoiceFull('bom dia', 'masculina grossa');
  } catch (error) {
    message = String(error.message);
    assert.match(message, /edge: falha de conexão com o serviço de voz/);
  }
  assert.doesNotMatch(message, /is not defined/, 'a função de voz do Edge precisa existir');
  assert.ok(String(openedUrl).startsWith('wss://speech.platform.bing.com'), 'o WebSocket do Edge precisa ser aberto');
  resetVoiceCooldowns();
});

test('o tom chega no SSML do Edge como pitch/rate (sem depender de FFmpeg)', () => {
  const spec = resolveVoiceSpec('masculina --tom grossa --vel -10');
  const ssml = buildEdgeSsml('boa noite', {
    voice: spec.voice,
    pitch: `${spec.pitchPct}%`,
    rate: `${spec.speedPct}%`,
    lang: spec.lang
  });
  assert.match(ssml, /<voice name='pt-BR-AntonioNeural'>/);
  assert.match(ssml, /<prosody pitch='-25%' rate='-10%'/);
});
