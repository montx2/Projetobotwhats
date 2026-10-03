// 🧪 Testes dos comandos de voz e imagem DENTRO do roteador.
//
// Estes testes precisam das dependências instaladas (o roteador carrega o
// cliente do WhatsApp). Em ambientes sem `npm install` eles são pulados com
// aviso, em vez de falharem por um motivo que não tem nada a ver com o código.
//
// O que é coberto:
//   • `.vozes` mostra o catálogo com os personagens;
//   • `.vozpadrao bob` grava a escolha só naquele chat e `.vozpadrao auto` limpa;
//   • `.voz bob <texto>` usa a voz pedida e envia o áudio (rede de mentira);
//   • `.voz` sem texto explica o uso em vez de gerar áudio à toa;
//   • `.criar --formato 9:16 --hd` monta a legenda com o que foi usado.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.NEXUS_ENV_FILE = path.join(os.tmpdir(), 'nexus-teste-router-voz', '.env');

import { setDnsLookupForTests } from '../src/core/http.js';

setDnsLookupForTests(async () => [{ address: '8.8.8.8', family: 4 }]);

let router = null;
let skipReason = false;
try {
  router = await import('../src/features/router.js');
} catch (error) {
  if (error?.code === 'ERR_MODULE_NOT_FOUND') {
    skipReason = `dependências não instaladas (rode npm install): ${String(error.message).split('\n')[0].slice(0, 120)}`;
  } else {
    throw error;
  }
}

const MP3 = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from('V'.repeat(6000), 'latin1')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('I'.repeat(5000), 'latin1')]);

function makeMessage(jid, sender, { text = '', pushName = 'Fulano', fromMe = false } = {}) {
  return {
    key: {
      remoteJid: jid,
      fromMe,
      id: `MSG-${Math.random().toString(36).slice(2)}`,
      participant: jid.endsWith('@g.us') ? sender : undefined
    },
    pushName,
    message: { conversation: text },
    messageTimestamp: Math.floor(Date.now() / 1000)
  };
}

function makeSock(owner) {
  const sent = [];
  return {
    sent,
    user: { id: owner },
    sendMessage: async (remoteJid, content) => {
      sent.push({ remoteJid, content });
      return { key: { id: `OUT-${sent.length}` } };
    }
  };
}

const OWNER = '5511999999999@s.whatsapp.net';
const deps = {
  ownerJid: OWNER,
  isOwner: (remoteJid, participant) => [remoteJid, participant].includes(OWNER),
  isOwnerPrivateChat: (remoteJid) => remoteJid === OWNER,
  sendOwner: async () => {}
};

const lastText = (sock) => String(sock.sent.at(-1)?.content?.text || '');

test('roteador: .vozes lista o catálogo e .vozpadrao grava a voz do chat', { skip: skipReason }, async () => {
  const { DEFAULT_CONFIG, cfg } = await import('../src/core/config.js');
  Object.assign(cfg.get(), structuredClone(DEFAULT_CONFIG));
  const jid = OWNER; // privado do dono
  const sock = makeSock(OWNER);

  await router.handleMessage(sock, makeMessage(jid, OWNER, { text: '.vozes' }), deps);
  const menu = lastText(sock);
  assert.match(menu, /PERSONAGENS E PARÓDIAS/i);
  assert.match(menu, /\.voz bob <texto>/);
  assert.match(menu, /\.voz lula <texto>/);

  await router.handleMessage(sock, makeMessage(jid, OWNER, { text: '.vozpadrao bob' }), deps);
  assert.match(lastText(sock), /Voz deste chat trocada/i);
  assert.equal(cfg.get().ia.vozChats[jid], 'bob');
  assert.equal(cfg.get().ia.vozPadrao, 'auto');

  await router.handleMessage(sock, makeMessage(jid, OWNER, { text: '.vozpadrao auto' }), deps);
  assert.match(lastText(sock), /padrão/i);
  assert.equal(cfg.get().ia.vozChats[jid], undefined);

  await router.handleMessage(sock, makeMessage(jid, OWNER, { text: '.vozpadrao vozinha_inexistente' }), deps);
  assert.match(lastText(sock), /não existe/i);
});

test('roteador: .voz sem texto explica o uso; .voz bob envia áudio', { skip: skipReason }, async (t) => {
  const { DEFAULT_CONFIG, cfg } = await import('../src/core/config.js');
  Object.assign(cfg.get(), structuredClone(DEFAULT_CONFIG));
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  const calls = [];
  // Sem WebSocket nativo o Edge sai do caminho e sobra a reserva grátis:
  // é exatamente o cenário de um Node antigo ou de rede bloqueada.
  delete globalThis.WebSocket;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('streamelements.com')) {
      return new Response(MP3, { headers: { 'content-type': 'audio/mpeg' } });
    }
    if (String(url).includes('image.pollinations.ai/prompt/')) {
      return new Response(JPEG, { headers: { 'content-type': 'image/jpeg' } });
    }
    if (String(url).includes('image.pollinations.ai/models')) {
      return new Response(JSON.stringify(['flux']), { headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`chamada inesperada: ${url}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
  });

  const jid = OWNER;
  const sock = makeSock(OWNER);

  await router.handleMessage(sock, makeMessage(jid, OWNER, { text: '.voz' }), deps);
  assert.match(lastText(sock), /\.voz \[voz\] <texto>/);

  await router.handleMessage(sock, makeMessage(jid, OWNER, { text: '.voz bob bom dia, pessoal' }), deps);
  const audio = sock.sent.find((entry) => entry.content?.audio);
  assert.ok(audio, 'o áudio precisa ter sido enviado');
  assert.ok(audio.content.audio.length > 1000);
  assert.match(lastText(sock), /Áudio pronto/);
  assert.match(lastText(sock), /Bob Esponja/);
  assert.ok(calls.some((url) => url.includes('streamelements.com')));

  // .criar com atalhos: a legenda conta o formato e o motor usados.
  await router.handleMessage(sock, makeMessage(jid, OWNER, { text: '.criar um dragão roxo --formato 9:16 --bruto --seed 5' }), deps);
  const image = sock.sent.find((entry) => entry.content?.image);
  assert.ok(image, 'a imagem precisa ter sido enviada');
  assert.match(String(image.content.caption), /pollinations/);
  assert.match(String(image.content.caption), /9:16/);
  assert.match(lastText(sock), /Imagem pronta/);
});

test('roteador: .menuvoz e .menucriar respondem os cartões de ajuda', { skip: skipReason }, async () => {
  const { DEFAULT_CONFIG, cfg } = await import('../src/core/config.js');
  Object.assign(cfg.get(), structuredClone(DEFAULT_CONFIG));
  const sock = makeSock(OWNER);
  await router.handleMessage(sock, makeMessage(OWNER, OWNER, { text: '.menuvoz' }), deps);
  assert.match(lastText(sock), /VOZES BRASILEIRAS/i);
  await router.handleMessage(sock, makeMessage(OWNER, OWNER, { text: '.menucriar' }), deps);
  assert.match(lastText(sock), /ATALHOS DO \.CRIAR/i);
});

test('quando as dependências faltam, estes testes são pulados (não é falha do código)', { skip: !skipReason }, () => {
  assert.ok(skipReason);
});
