// Simulação de ponta a ponta com socket fake (sem WhatsApp real).
// Verifica: modo privado exclusivo do dono, bloqueio total em grupos/terceiros
// não autorizados, .autorizar/.desautorizar, edição de progresso e anti-delete no privado.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NEXUS_DATA_DIR = new URL('./tmp-data', import.meta.url).pathname;

import { handleMessage } from '../src/features/router.js';
import { messageCache } from '../src/wa/cache.js';
import { cfg } from '../src/core/config.js';

const OWNER_JID = '5511900000000@s.whatsapp.net';

function makeSock() {
  const sent = [];
  return {
    sent,
    user: { id: '5511900000000:1@s.whatsapp.net', name: 'NEXUS' },
    sendMessage: async (jid, content, opts) => {
      const entry = { jid, content, quoted: opts?.quoted?.key?.id || null };
      sent.push(entry);
      return { key: { id: `SENT${sent.length}`, remoteJid: jid } };
    },
    updateMediaMessage: async () => {
      throw new Error('sem mídia no mock');
    }
  };
}

function makeDeps(sock, type) {
  return {
    type,
    ownerJid: OWNER_JID,
    isOwner: (jid, participant) => [jid, participant].includes(OWNER_JID) || jid === sock.user.id,
    isOwnerPrivateChat: (jid) => jid === OWNER_JID,
    sendOwner: async () => {}
  };
}

function textMsg(jid, text, { from = jid, fromMe = jid === OWNER_JID, id, quoted } = {}) {
  const msg = {
    key: {
      remoteJid: jid,
      id: id || `MSG${Math.random().toString(36).slice(2)}`,
      fromMe,
      ...(jid.endsWith('@g.us') ? { participant: from } : {})
    },
    pushName: 'Tester',
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: { conversation: text }
  };
  if (quoted) {
    msg.message = {
      extendedTextMessage: {
        text,
        contextInfo: { stanzaId: quoted.key.id, quotedMessage: quoted.message }
      }
    };
  }
  return msg;
}

test('fluxo: .menu no privado do dono responde com o menu', async () => {
  const sock = makeSock();
  await handleMessage(sock, textMsg(OWNER_JID, '.menu'), makeDeps(sock));
  assert.ok(sock.sent.some((s) => typeof s.content.text === 'string' && s.content.text.includes('MontxBOT')));
});

test('fluxo: .ping no privado do dono responde pong editando a mensagem de progresso', async () => {
  const sock = makeSock();
  await handleMessage(sock, textMsg(OWNER_JID, '.ping'), makeDeps(sock));
  assert.equal(sock.sent.length, 2);
  assert.match(sock.sent[0].content.text || '', /ping/i);
  assert.match(sock.sent[1].content.text || '', /Pong/i);
  assert.equal(sock.sent[1].content.edit?.id, 'SENT1');
});

test('fluxo: comandos no privado do dono aceitam múltiplos prefixos', async () => {
  const sock = makeSock();
  await handleMessage(sock, textMsg(OWNER_JID, '!menu'), makeDeps(sock));
  assert.ok(sock.sent.some((s) => (s.content.text || '').includes('VIEW ONCE')));
});

test('SEGURANÇA: grupo aleatório e terceiros não autorizados são 100% ignorados (foto, resposta a foto, link e comando)', async () => {
  cfg.get().autorizados = [];
  const sock = makeSock();
  const groupJid = 'grupo-aleatorio@g.us';
  const strangerJid = '5511988887777@s.whatsapp.net';
  const deps = makeDeps(sock);

  // 1) Alguém manda foto normal no grupo
  const photoMsg = {
    key: { remoteJid: groupJid, id: 'FOTO1', fromMe: false, participant: strangerJid },
    pushName: 'Membro',
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: { imageMessage: { url: 'https://mmg.whatsapp.net/foto.jpg', mimetype: 'image/jpeg' } }
  };
  await handleMessage(sock, photoMsg, deps);

  // 2) Alguém responde a foto normal no grupo
  const replyToPhoto = textMsg(groupJid, 'que foto legal', { from: strangerJid, fromMe: false, quoted: photoMsg });
  await handleMessage(sock, replyToPhoto, deps);

  // 3) Alguém manda link do TikTok/Instagram no grupo
  await handleMessage(sock, textMsg(groupJid, 'https://vm.tiktok.com/ZM123456/', { from: strangerJid, fromMe: false }), deps);

  // 4) Alguém manda comando .menu ou .s no grupo
  await handleMessage(sock, textMsg(groupJid, '.menu', { from: strangerJid, fromMe: false }), deps);
  await handleMessage(sock, textMsg(groupJid, '.s', { from: strangerJid, fromMe: false, quoted: photoMsg }), deps);

  // 5) Estranho manda comando ou link no privado do bot sem estar autorizado
  await handleMessage(sock, textMsg(strangerJid, '.menu', { fromMe: false }), deps);
  await handleMessage(sock, textMsg(strangerJid, 'https://vm.tiktok.com/ZM123456/', { fromMe: false }), deps);

  assert.equal(sock.sent.length, 0, 'O bot NÃO deve enviar absolutamente nada para grupos ou pessoas não autorizadas');
});

test('autorização: ". ativar" libera TUDO no grupo/privado, MENOS View Once e Anti-Delete (que ficam 100% invisíveis) e ". desativar" bloqueia', async () => {
  cfg.get().autorizados = [];
  const sock = makeSock();
  const groupJid = 'grupo-amigos@g.us';
  const friendJid = '5531977776666@s.whatsapp.net';
  const deps = makeDeps(sock);

  // Antes de ativar: membro do grupo manda .menu ou .s -> 100% ignorado
  await handleMessage(sock, textMsg(groupJid, '.menu', { from: friendJid, fromMe: false }), deps);
  await handleMessage(sock, textMsg(groupJid, '.s', { from: friendJid, fromMe: false }), deps);
  assert.equal(sock.sent.length, 0);

  // Dono dá ". ativar" (com espaço após o ponto) dentro do grupo
  await handleMessage(sock, textMsg(groupJid, '. ativar', { from: OWNER_JID, fromMe: true }), deps);
  assert.ok(cfg.get().autorizados.includes(groupJid));

  // Membro do grupo pede .menu -> recebe o menu PÚBLICO
  // Mostra figurinhas, downloads e IA, mas NUNCA View Once nem Anti-Delete.
  await handleMessage(sock, textMsg(groupJid, '.menu', { from: friendJid, fromMe: false }), deps);
  const publicReply = sock.sent.at(-1).content.text || '';
  assert.match(publicReply, /FIGURINHAS/i, 'menu público mostra figurinhas');
  assert.match(publicReply, /DOWNLOADS/i, 'menu público mostra downloads');
  assert.match(publicReply, /INTELIG/i, 'menu público mostra IA');
  assert.ok(!/VIEW ONCE/i.test(publicReply), 'menu público NUNCA deve mostrar View Once');
  assert.ok(!/ANTI-DELETE/i.test(publicReply), 'menu público NUNCA deve mostrar Anti-Delete');

  // Membro do grupo USA o que foi liberado (figurinha sem mídia responde instruções,
  // .ia sem pergunta responde instruções) — prova que downloads/IA estão liberados.
  const countBefore = sock.sent.length;
  await handleMessage(sock, textMsg(groupJid, '.s', { from: friendJid, fromMe: false }), deps);
  await handleMessage(sock, textMsg(groupJid, '.ia', { from: friendJid, fromMe: false }), deps);
  assert.ok(sock.sent.length > countBefore, 'figurinhas e IA devem responder no chat ativado');

  // View Once / Anti-Delete / config: 100% ignorados para terceiros (0 rastros)
  const countSecret = sock.sent.length;
  await handleMessage(sock, textMsg(groupJid, '.vo', { from: friendJid, fromMe: false }), deps);
  await handleMessage(sock, textMsg(groupJid, '.antidelete', { from: friendJid, fromMe: false }), deps);
  await handleMessage(sock, textMsg(groupJid, '.config', { from: friendJid, fromMe: false }), deps);
  assert.equal(sock.sent.length, countSecret, 'View Once, Anti-Delete e config são 100% ignorados no grupo');

  // Dono dá ". desativar" no grupo -> bloqueia novamente
  await handleMessage(sock, textMsg(groupJid, '. desativar', { from: OWNER_JID, fromMe: true }), deps);
  const afterDeactivate = sock.sent.length;
  await handleMessage(sock, textMsg(groupJid, '.menu', { from: friendJid, fromMe: false }), deps);
  assert.equal(sock.sent.length, afterDeactivate, 'Após .desativar, o grupo volta a ficar 100% silencioso');
});

test('anti-delete: envia mensagem apagada SOMENTE para o privado do dono (nunca no grupo)', async () => {
  const sock = makeSock();
  const chat = 'grupo-teste@g.us';
  const deps = makeDeps(sock);

  // mensagem original chega e é cacheada
  const original = textMsg(chat, 'mensagem secreta 🤫', { id: 'ORIG1', from: '5522@s.whatsapp.net', fromMe: false });
  original.pushName = 'Fofoqueiro';
  await handleMessage(sock, original, deps);

  assert.ok(messageCache.get(chat, 'ORIG1'), 'mensagem deve estar no cache');

  // o autor apaga a mensagem (REVOKE via protocolMessage)
  const revoke = {
    key: { remoteJid: chat, id: 'REV1', fromMe: false },
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: { protocolMessage: { type: 0, key: { remoteJid: chat, id: 'ORIG1' } } }
  };
  await handleMessage(sock, revoke, deps);

  const restored = sock.sent.find((s) => JSON.stringify(s.content).includes('mensagem secreta'));
  assert.ok(restored, 'mensagem apagada deve ser enviada ao dono');
  assert.equal(restored.jid, OWNER_JID, 'deve ir EXCLUSIVAMENTE para o privado do dono, nunca para o grupo');
  assert.ok(!sock.sent.some((s) => s.jid === chat), 'zero mensagens enviadas no grupo');
});

test('anti-delete: filtro "grupos" impede restauração em grupo', async () => {
  cfg.get().antiDelete.ignorar = ['grupos'];
  const sock = makeSock();
  const chat = 'grupo2@g.us';
  const deps = makeDeps(sock);

  const original = textMsg(chat, 'segredo do grupo', { id: 'ORIG2', fromMe: false });
  await handleMessage(sock, original, deps);

  const revoke = {
    key: { remoteJid: chat, id: 'REV2', fromMe: false },
    message: { protocolMessage: { type: 'REVOKE', key: { remoteJid: chat, id: 'ORIG2' } } }
  };
  await handleMessage(sock, revoke, deps);

  assert.ok(!sock.sent.some((s) => JSON.stringify(s.content).includes('segredo do grupo')), 'não deve restaurar em grupo ignorado');
  cfg.get().antiDelete.ignorar = [];
});

test('anti-delete: mensagem própria apagada não é reportada', async () => {
  const sock = makeSock();
  const chat = '5533@s.whatsapp.net';
  const deps = makeDeps(sock);
  const mine = textMsg(chat, 'minha msg', { id: 'ORIG3', fromMe: true });
  messageCache.put(mine);
  const revoke = {
    key: { remoteJid: chat, id: 'REV3', fromMe: true },
    message: { protocolMessage: { type: 0, key: { remoteJid: chat, id: 'ORIG3' } } }
  };
  await handleMessage(sock, revoke, deps);
  assert.ok(!sock.sent.some((s) => JSON.stringify(s.content).includes('minha msg')));
});

test('view once: responder com qualquer mensagem no privado do dono dispara captura', async () => {
  const sock = makeSock();
  const deps = makeDeps(sock);

  const replyMsg = {
    key: { remoteJid: OWNER_JID, id: 'R1', fromMe: true },
    pushName: 'Dono',
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: {
      extendedTextMessage: {
        text: 'baixa aí',
        contextInfo: {
          stanzaId: 'VO1',
          quotedMessage: { viewOnceMessageV2: { message: { imageMessage: { url: 'fake', mimetype: 'image/jpeg' } } } }
        }
      }
    }
  };
  await handleMessage(sock, replyMsg, deps);
  assert.ok(true);
});

test('view once: texto comum sem citação NÃO dispara captura', async () => {
  const sock = makeSock();
  const deps = makeDeps(sock);
  await handleMessage(sock, textMsg(OWNER_JID, 'oi tudo bem?'), deps);
  assert.equal(sock.sent.length, 0);
});

test('auto-download: só entra em ação com link conhecido no privado do dono', async () => {
  const sock = makeSock();
  const deps = makeDeps(sock);
  await handleMessage(sock, textMsg(OWNER_JID, 'olha https://example.com/arquivo'), deps);
  assert.equal(sock.sent.length, 0);
});

test('dono pode adicionar e remover filtros de ignorar', async () => {
  const sock = makeSock();
  const deps = makeDeps(sock);

  await handleMessage(sock, textMsg(OWNER_JID, '.antidelete ignorar grupos'), deps);
  assert.ok(cfg.get().antiDelete.ignorar.includes('grupos'));

  await handleMessage(sock, textMsg(OWNER_JID, '.antidelete remover grupos'), deps);
  assert.ok(!cfg.get().antiDelete.ignorar.includes('grupos'));
});

test('sticker sem mídia responde instruções no privado do dono', async () => {
  const sock = makeSock();
  await handleMessage(sock, textMsg(OWNER_JID, '.s'), makeDeps(sock));
  assert.ok(sock.sent.some((s) => (s.content.text || '').includes('imagem')));
});

test('.ia sem pergunta responde instruções no privado do dono', async () => {
  const sock = makeSock();
  await handleMessage(sock, textMsg(OWNER_JID, '.ia'), makeDeps(sock));
  assert.ok(sock.sent.some((s) => (s.content.text || '').includes('.ia <pergunta>')));
});

test('comando desconhecido não responde por padrão', async () => {
  const sock = makeSock();
  await handleMessage(sock, textMsg(OWNER_JID, '.xyzzy'), makeDeps(sock));
  assert.equal(sock.sent.length, 0);
});

test('anti-delete: revoke com a MESMA key da original (upsert) envia ao privado do dono', async () => {
  const sock = makeSock();
  const chat = '5560@s.whatsapp.net';
  const keyOfOriginal = { remoteJid: chat, id: 'REVUPD1', fromMe: false };

  await handleMessage(
    sock,
    { key: { ...keyOfOriginal }, pushName: 'Fofoqueiro', messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: 'segredo' } },
    makeDeps(sock, 'notify')
  );

  await handleMessage(
    sock,
    { key: { ...keyOfOriginal }, messageTimestamp: Date.now() / 1000, message: { protocolMessage: { type: 0, key: { ...keyOfOriginal } } } },
    makeDeps(sock, 'notify')
  );

  const restored = sock.sent.find((s) => JSON.stringify(s.content).includes('ANTI-DELETE'));
  assert.ok(restored, 'anti-delete deve restaurar mesmo com a key repetida');
  assert.equal(restored.jid, OWNER_JID);
});

test('anti-delete: revoke via messages.update (type update) envia ao privado do dono', async () => {
  const sock = makeSock();
  const chat = '5563@s.whatsapp.net';
  const keyOfOriginal = { remoteJid: chat, id: 'REVUPD2', fromMe: false };

  await handleMessage(
    sock,
    { key: { ...keyOfOriginal }, pushName: 'Fofoqueiro', messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: 'segredo 2' } },
    makeDeps(sock, 'notify')
  );
  await handleMessage(
    sock,
    { key: { ...keyOfOriginal }, messageTimestamp: Date.now() / 1000, message: { protocolMessage: { type: 0, key: { ...keyOfOriginal } } } },
    makeDeps(sock, 'update')
  );

  const restored = sock.sent.find((s) => JSON.stringify(s.content).includes('ANTI-DELETE'));
  assert.ok(restored, 'anti-delete deve restaurar o revoke vindo de messages.update');
  assert.equal(restored.jid, OWNER_JID);
});

test('backlog (append) não executa comando nem responde, mas fica no cache', async () => {
  const sock = makeSock();
  const msg = textMsg(OWNER_JID, '.menu', { id: 'APPEND1' });
  await handleMessage(sock, msg, makeDeps(sock, 'append'));

  assert.equal(sock.sent.length, 0, 'mensagem de histórico não deve disparar resposta');
  assert.ok(messageCache.get(OWNER_JID, 'APPEND1'), 'mensagem antiga deve ficar no cache do anti-delete');
});

test('reentrega da mesma mensagem ao vivo não responde duas vezes', async () => {
  const sock = makeSock();
  const msg = textMsg(OWNER_JID, '.ping', { id: 'DUP1' });
  await handleMessage(sock, msg, makeDeps(sock, 'notify'));
  const afterFirst = sock.sent.length;
  await handleMessage(sock, msg, makeDeps(sock, 'notify'));
  assert.equal(sock.sent.length, afterFirst, 'segunda entrega não deve gerar nova resposta');
});

/* ─────────────── download ponta a ponta (rede mockada) ─────────────── */

function jsonRes(body, { status = 200 } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    url: 'https://mock/',
    headers: { get: (k) => ({ 'content-type': 'application/json' })[String(k).toLowerCase()] ?? null },
    text: async () => text,
    body: null
  };
}

function bufferRes(buf) {
  return {
    status: 200,
    ok: true,
    url: 'https://mock/',
    headers: { get: (k) => ({ 'content-type': 'video/mp4', 'content-length': String(buf.length) })[String(k).toLowerCase()] ?? null },
    text: async () => buf.toString('latin1'),
    body: new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(buf));
        c.close();
      }
    })
  };
}

async function withMockedFetch(routes, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    for (const [matcher, responder] of routes) {
      if (typeof matcher === 'string' ? u.includes(matcher) : matcher.test(u)) {
        return typeof responder === 'function' ? responder(u) : responder;
      }
    }
    return jsonRes({}, { status: 404 });
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test('download em grupo ativado: link do TikTok baixa e ENVIA O VÍDEO no próprio grupo', async () => {
  cfg.get().autorizados = ['grupo-dl@g.us'];
  const sock = makeSock();
  const groupJid = 'grupo-dl@g.us';
  const friendJid = '5531977776666@s.whatsapp.net';
  const deps = makeDeps(sock);

  const tikwm = {
    code: 0,
    data: {
      id: '7106594312292453675',
      title: 'Vídeo do grupo',
      duration: 12,
      author: { unique_id: 'criador' },
      origin_cover: 'https://p16-sign.tiktokcdn.com/orig.jpg',
      play: 'https://www.tikwm.com/video/media/play/1.mp4',
      hdplay: 'https://www.tikwm.com/video/media/hdplay/1.mp4'
    }
  };

  await withMockedFetch(
    [
      ['tikwm.com/api', () => jsonRes(tikwm)],
      ['tiktok.com/oembed', () => jsonRes({ title: 'Vídeo do grupo', author_name: 'criador' })],
      [/tikwm\.com\/video\/media/, () => bufferRes(Buffer.from('...ftypisomavc1...'))],
      ['vm.tiktok.com', () => jsonRes({}, { status: 200 })]
    ],
    async () => {
      await handleMessage(
        sock,
        textMsg(groupJid, '.tiktok https://vm.tiktok.com/ZM123456/', { from: friendJid, fromMe: false }),
        deps
      );
    }
  );

  const video = sock.sent.find((s) => s.content?.video);
  assert.ok(video, 'deve enviar o vídeo baixado no grupo');
  assert.equal(video.jid, groupJid, 'a mídia vai no próprio chat onde foi pedida');
  assert.match(String(video.content.caption || ''), /TikTok/);
  assert.ok(sock.sent.some((s) => /conclu/i.test(String(s.content.text || ''))), 'avisa que concluiu');
  cfg.get().autorizados = [];
});

test('download: link de rede desconhecida não dispara nada em grupo não autorizado', async () => {
  cfg.get().autorizados = [];
  const sock = makeSock();
  const groupJid = 'grupo-fechado@g.us';
  const friendJid = '5531977776666@s.whatsapp.net';
  await handleMessage(
    sock,
    textMsg(groupJid, 'https://vm.tiktok.com/ZM999999/', { from: friendJid, fromMe: false }),
    makeDeps(sock)
  );
  assert.equal(sock.sent.length, 0, 'grupo não autorizado continua 100% silencioso');
});

test('SEGURANÇA: em chat ativado, responder uma VIEW ONCE com .s NÃO republica a mídia no grupo', async () => {
  cfg.get().autorizados = ['grupo-vo@g.us'];
  const sock = makeSock();
  const groupJid = 'grupo-vo@g.us';
  const friendJid = '5531977776666@s.whatsapp.net';
  const deps = makeDeps(sock);

  const viewOnce = {
    key: { remoteJid: groupJid, id: 'VO1', fromMe: false, participant: friendJid },
    pushName: 'Membro',
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: {
      viewOnceMessageV2: {
        message: { imageMessage: { url: 'https://mmg.whatsapp.net/vo.jpg', mimetype: 'image/jpeg', mediaKey: Buffer.alloc(32, 7) } }
      }
    }
  };

  // Membro do grupo responde a view once pedindo figurinha
  await handleMessage(
    sock,
    textMsg(groupJid, '.s', { from: friendJid, fromMe: false, quoted: viewOnce }),
    deps
  );

  // Nenhuma figurinha/mídia pode ir para o grupo
  assert.ok(!sock.sent.some((s) => s.content?.sticker), 'NUNCA envia figurinha de view once no grupo');
  assert.ok(!sock.sent.some((s) => s.content?.image && !s.content?.text), 'NUNCA reenvia a foto no grupo');

  cfg.get().autorizados = [];
});
