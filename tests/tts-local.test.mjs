// 🧪 Testes do motor de voz LOCAL e OFFLINE (`tts-local.js`) — o caminho grátis
// que não depende de internet, de chave ou de conta.
//
// Nada de rede aqui: os binários são scripts de mentira criados na hora, que
// fingem ser o espeak-ng e o piper e gravam os argumentos recebidos. O que
// interessa testar é:
//   • a detecção do binário no PATH (e o cache, que precisa poder ser limpo);
//   • a tradução de tom/velocidade do catálogo para os parâmetros do espeak;
//   • a escolha do idioma (pt-BR, en-US, es-MX…) e do gênero pelo tom;
//   • o `length_scale` do piper;
//   • o texto indo por stdin e o áudio saindo como WAV (sem FFmpeg) — nunca
//     quebrando por causa de acento, aspas ou emoji.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  espeakLangFor,
  espeakParams,
  espeakVoiceFor,
  espeakTts,
  findEspeak,
  hasLocalEngine,
  isFeminineVoice,
  localEngineFor,
  localStatus,
  piperTts,
  resetLocalStateForTests
} from '../src/features/tts-local.js';
import { detectAudioMime } from '../src/util/ffmpeg.js';

const isWindows = process.platform === 'win32';

/** Cria um "espeak" falso que grava os argumentos e um WAV pequeno. */
function fakeBinary(name, { writeAudio = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-local-teste-'));
  const bin = path.join(dir, name);
  const argsFile = path.join(dir, 'args.txt');
  const script = `#!/bin/sh
echo "$@" > "${argsFile}"
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-w" ]; then shift; out="$1"; fi
  if [ "$1" = "--output_file" ]; then shift; out="$1"; fi
  shift
done
${writeAudio ? `printf 'RIFFxxxxWAVEfmt ' > "$out"; dd if=/dev/zero bs=1024 count=4 >> "$out" 2>/dev/null` : 'exit 7'}
exit 0
`;
  fs.writeFileSync(bin, script);
  fs.chmodSync(bin, 0o755);
  return { dir, bin, argsFile };
}

const readArgs = (file) => {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
};

test('espeakParams traduz tom/velocidade/volume do catálogo (e respeita os limites)', () => {
  const neutro = espeakParams({});
  assert.equal(neutro.pitch, 50);
  assert.equal(neutro.wpm, 175);
  assert.equal(neutro.amp, 100);

  // Bob: tom alto e fala rápida.
  const bob = espeakParams({ pitchPct: 38, speedPct: 8 });
  assert.ok(bob.pitch > 60, 'tom acima do normal');
  assert.ok(bob.wpm > 175, 'mais palavras por minuto');

  // Monstro: grave e lento.
  const monstro = espeakParams({ pitchPct: -32, speedPct: -14 });
  assert.ok(monstro.pitch < 40);
  assert.ok(monstro.wpm < 175);

  // Nada estoura o que o espeak aceita.
  const extremo = espeakParams({ pitchPct: 999, speedPct: 999, volumePct: 999 });
  assert.equal(extremo.pitch, 99);
  assert.equal(extremo.wpm, 450);
  assert.equal(extremo.amp, 200);
  const baixo = espeakParams({ pitchPct: -999, speedPct: -999, volumePct: -999 });
  assert.equal(baixo.pitch, 0);
  assert.equal(baixo.wpm, 80);
  assert.equal(baixo.amp, 0);

  // Voz feminina sem tom pedido sobe um pouco (o espeak não tem gênero).
  assert.ok(espeakParams({ feminine: true }).pitch > espeakParams({}).pitch);
});

test('idioma e voz do espeak seguem o catálogo (e o VOZES_EXTRA espeak:)', () => {
  assert.equal(espeakLangFor({ lang: 'pt-BR' }), 'pt-br');
  assert.equal(espeakLangFor({ voice: 'en-US-BrianMultilingualNeural' }), 'en-us');
  assert.equal(espeakLangFor({ voice: 'es-MX-JorgeNeural' }), 'es-la');
  assert.equal(espeakLangFor({}), 'pt-br'); // padrão do bot

  assert.equal(espeakVoiceFor({ lang: 'pt-BR' }), 'pt-br');
  assert.equal(espeakVoiceFor({ engine: 'espeak', voice: 'pt-br+f3' }), 'pt-br+f3');
  assert.equal(espeakVoiceFor({ lang: 'en-US' }, { override: 'pt-br+f4' }), 'pt-br+f4');

  assert.equal(isFeminineVoice({ id: 'francisca', voice: 'pt-BR-FranciscaNeural' }), true);
  assert.equal(isFeminineVoice({ id: 'antonio', voice: 'pt-BR-AntonioNeural' }), false);

  assert.equal(localEngineFor({ engine: 'espeak' }), 'espeak');
  assert.equal(localEngineFor({ engine: 'piper' }), 'piper');
  assert.equal(localEngineFor({ engine: 'edge' }), null);
});

test('espeak é detectado no PATH, sintetiza por stdin e limpa o cache', { skip: isWindows }, async (t) => {
  const fake = fakeBinary('espeak-ng');
  const originalPath = process.env.PATH;
  process.env.PATH = `${fake.dir}${path.delimiter}${originalPath}`;
  resetLocalStateForTests();
  t.after(() => {
    process.env.PATH = originalPath;
    resetLocalStateForTests();
    fs.rmSync(fake.dir, { recursive: true, force: true });
  });

  assert.equal(findEspeak(), 'espeak-ng');
  assert.equal(hasLocalEngine(), true);
  assert.equal(localStatus().espeak.installed, true);

  const buffer = await espeakTts('Bom dia! Acentuação, "aspas" e 😀 — teste.', {
    pitchPct: 20,
    speedPct: 10,
    volumePct: 0,
    lang: 'pt-BR'
  });
  assert.ok(Buffer.isBuffer(buffer) && buffer.length > 0);

  const args = readArgs(fake.argsFile);
  assert.match(args, /-v pt-br/);
  assert.match(args, /-p \d+/);
  assert.match(args, /-s \d+/);
  // O texto vai por stdin (não como argumento): acentos e emoji não quebram.
  assert.ok(!args.includes('Bom dia'), 'o texto não deve ir na linha de comando');
});

test('espeak respeita a voz pedida no VOZES_EXTRA (espeak:pt-br+f3)', { skip: isWindows }, async (t) => {
  const fake = fakeBinary('espeak');
  const originalPath = process.env.PATH;
  process.env.PATH = `${fake.dir}${path.delimiter}${originalPath}`;
  resetLocalStateForTests();
  t.after(() => {
    process.env.PATH = originalPath;
    resetLocalStateForTests();
    fs.rmSync(fake.dir, { recursive: true, force: true });
  });

  await espeakTts('olá', { engine: 'espeak', voice: 'pt-br+f3' });
  assert.match(readArgs(fake.argsFile), /-v pt-br\+f3/);
});

test('sem o binário, a falha explica como instalar (nunca trava)', { skip: isWindows }, async () => {
  await assert.rejects(
    () => espeakTts('oi', {}, { bin: false }),
    /Termux: pkg install espeak/
  );
  await assert.rejects(() => piperTts('oi', {}, { bin: false, model: false }), /PIPER_MODEL/);
});

test('sem FFmpeg, o áudio do motor local sai com o mimetype certo', () => {
  const wav = Buffer.concat([Buffer.from('RIFF____WAVE'), Buffer.alloc(64)]);
  assert.equal(detectAudioMime(wav), 'audio/wav');
  const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(64)]);
  assert.equal(detectAudioMime(mp3), 'audio/mpeg');
  const ogg = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(64)]);
  assert.match(detectAudioMime(ogg), /audio\/ogg/);
});

test('piper usa o modelo e a velocidade viram length_scale', { skip: isWindows }, async (t) => {
  const fake = fakeBinary('piper');
  const modelFile = path.join(fake.dir, 'pt_BR-faber-medium.onnx');
  fs.writeFileSync(modelFile, 'modelo-de-mentira');
  t.after(() => fs.rmSync(fake.dir, { recursive: true, force: true }));

  const buffer = await piperTts('bom dia, pessoal', { speedPct: -20 }, { bin: fake.bin, model: modelFile });
  assert.ok(Buffer.isBuffer(buffer) && buffer.length > 0);

  const args = readArgs(fake.argsFile);
  assert.match(args, /--model .*pt_BR-faber-medium\.onnx/);
  // speedPct -20% → fala 20% mais devagar → length_scale > 1.
  const scale = Number(/--length_scale ([\d.]+)/.exec(args)?.[1]);
  assert.ok(scale > 1, `length_scale deveria ser > 1, veio ${scale}`);
});
