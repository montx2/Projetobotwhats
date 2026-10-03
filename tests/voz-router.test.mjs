// 🧪 Testes dos comandos de voz e imagem DENTRO do roteador.
//
// Estes testes precisam das dependências instaladas (o roteador carrega o
// cliente do WhatsApp). Em ambientes sem `npm install` eles são pulados com
// aviso, em vez de falharem por um motivo que não tem nada a ver com o código.
//
// O que é coberto:
//   • `.vozes` mostra o card com vozes, tons e como configurar;
//   • `.vozpadrao masculina grossa` grava a escolha só naquele chat e
//     `.vozpadrao auto` limpa;
//   • `.voz masculina grossa <texto>` usa o que foi pedido e envia o áudio;
//   • `.voz` sem texto mostra a ajuda em vez de gerar áudio à toa;
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

test('roteador: .vozes explica a configuração e .vozpadrao salva voz + tom', { skip: skipReason }, async () => {
  const { DEFAULT_CONFIG, cfg } = await import('../src/core/config.js');
  Object.assign(cfg.get(), structuredClone(DEFAULT_CONFIG));
  const jid = OWNER; // privado do dono
  const sock = makeSock(OWNER);

  await router.handleMessage(sock, makeMessage(jid, OWNER, { text: '.vozes' }), deps);
  const menu = lastText(sock);
  // O card ensina o caminho inteiro: voz, tom e ajuste fino.
  assert.match(menu, /TOM \(GROSSA ⇄ FINA\)/i);
  assert.match(menu, /\.voz masculina <texto>/);
  assert.match(menu, /\.voz grossa <texto>/);
  assert.match(menu, /--tom -60 a \+60/);
  assert.match(menu, /\.vozpadrao masculina grossa/);
  assert.doesNotMatch(menu, /personagem/i);
  assert.doesNotMatch(menu, /\.voz bob/);

  await router.handleMessage(sock, makeMessage(jid, OWNER, { text: '.vozpadrao masculina grossa' }), deps);
  assert.match(lastText(sock), /Voz deste chat salva/i);
  assert.match(lastText(sock), /tom -25% \(grossa\)/);
  assert.equal(cfg.get().ia.vozChats[jid], 'masculina --tom grossa');
  assert.equal(cfg.get().ia.vozPadrao, 'auto');

  // Ajustar só o tom mantém a voz que já estava salva.
  await router.handleMessage(sock, makeMessage(jid, OWNER, { text: '.vozpadrao --tom -40' }), deps);
  assert.equal(cfg.get().ia.vozChats[jid], 'masculina --tom -40');

  // Sem argumento, mostra o que está salvo.
  await router.handleMessage(sock, makeMessage(jid, OWNER, { text: '.vozpadrao' }), deps);
  assert.match(lastText(sock), /Configuração atual/i);
  assert.match(lastText(sock), /tom -40%/);

  await router.handleMessage(sock, makeMessage(jid, OWNER, { text: '.vozpadrao auto' }), deps);
  assert.match(lastText(sock), /padrão/i);
  assert.equal(cfg.get().ia.vozChats[jid], undefined);

  await router.handleMessage(sock, makeMessage(jid, OWNER, { text: '.vozpadrao vozinha_inexistente' }), deps);
  assert.match(lastText(sock), /não existe/i);
});

test('roteador: .voz sem texto mostra a ajuda; .voz masculina grossa envia áudio', { skip: skipReason }, async (t) => {
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
  assert.match(lastText(sock), /COMO USAR/i);
  assert.match(lastText(sock), /\.voz grossa <texto>/);

  await router.handleMessage(sock, makeMessage(jid, OWNER, { text: '.voz masculina grossa bom dia, pessoal' }), deps);
  const audio = sock.sent.find((entry) => entry.content?.audio);
  assert.ok(audio, 'o áudio precisa ter sido enviado');
  assert.ok(audio.content.audio.length > 1000);
  assert.match(lastText(sock), /Áudio pronto/);
  // A legenda conta a configuração usada — é assim que o usuário confere o tom.
  assert.match(lastText(sock), /Masculina · tom -25% \(grossa\)/);
  assert.ok(calls.some((url) => url.includes('streamelements.com')));

  // Só o tom, sem trocar de voz e sem escrever texto: sai a prévia.
  await router.handleMessage(sock, makeMessage(jid, OWNER, { text: '.voz fina' }), deps);
  assert.match(lastText(sock), /tom \+25% \(fina\)/);

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
  assert.match(lastText(sock), /AJUSTE FINO/i);
  assert.match(lastText(sock), /\.voz feminina grossa oi/);
  await router.handleMessage(sock, makeMessage(OWNER, OWNER, { text: '.menucriar' }), deps);
  assert.match(lastText(sock), /ATALHOS DO \.CRIAR/i);
});

test('quando as dependências faltam, estes testes são pulados (não é falha do código)', { skip: !skipReason }, () => {
  assert.ok(skipReason);
});
