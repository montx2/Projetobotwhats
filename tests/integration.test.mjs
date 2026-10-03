// Simulação de ponta a ponta com socket fake (sem WhatsApp real).
// Verifica: modo privado exclusivo do dono, bloqueio total em grupos/terceiros
// não autorizados, .autorizar/.desautorizar, edição de progresso e anti-delete no privado.

import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { setDnsLookupForTests } from '../src/core/http.js';

process.env.NEXUS_DATA_DIR ||= new URL('./tmp-data', import.meta.url).pathname;
setDnsLookupForTests(async () => [{ address: '8.8.8.8', family: 4 }]);

const { DEFAULT_CONFIG, cfg } = await import('../src/core/config.js');
const { handleMessage } = await import('../src/features/router.js');
const { handleGroupParticipantsUpdate } = await import('../src/features/group-tools.js');
const { messageCache } = await import('../src/wa/cache.js');

beforeEach(() => {
  Object.assign(cfg.get(), structuredClone(DEFAULT_CONFIG));
  messageCache.clearAll();
});

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
    groupMetadata: async (jid) => ({ id: jid, participants: [] }),
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
  assert.match(publicReply, /\.antilink/i, 'menu público apresenta as novas ferramentas de grupo');
  assert.match(publicReply, /\.enquete/i, 'menu público apresenta enquetes');
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

test('anti-link: somente grupos autorizados e opt-in; allowlist e administradores são respeitados', async () => {
  const group = 'anti-link-seguro@g.us';
  const wrappedGroup = 'anti-link-efimero@g.us';
  const randomGroup = 'anti-link-nao-autorizado@g.us';
  const member = '5531991112222@s.whatsapp.net';
  const admin = '5531993334444@s.whatsapp.net';
  cfg.get().autorizados = [group];
  cfg.get().grupos[group] = {
    welcome: false,
    goodbye: false,
    antiLink: { enabled: true, allowlist: ['example.com'] }
  };
  cfg.get().autorizados.push(wrappedGroup);
  cfg.get().grupos[wrappedGroup] = {
    welcome: false,
    goodbye: false,
    antiLink: { enabled: true, allowlist: ['example.com'] }
  };

  const sock = makeSock();
  let metadataCalls = 0;
  sock.groupMetadata = async (jid) => {
    metadataCalls++;
    return {
      id: jid,
      participants: [
        { id: sock.user.id, admin: 'admin' },
        { id: member },
        { id: admin, admin: 'admin' }
      ]
    };
  };
  const deps = makeDeps(sock);

  await handleMessage(sock, textMsg(randomGroup, 'https://spam.example/promo', { from: member, fromMe: false }), deps);
  assert.equal(metadataCalls, 0, 'grupos não autorizados não consultam metadados nem moderam');
  assert.equal(sock.sent.length, 0);

  await handleMessage(sock, textMsg(group, 'https://sub.example.com/ok', { from: member, fromMe: false }), deps);
  assert.equal(sock.sent.length, 0, 'domínio permitido inclui subdomínios');

  const violation = textMsg(group, 'https://spam.example/promo', { from: member, fromMe: false, id: 'SPAM_LINK' });
  await handleMessage(sock, violation, deps);
  assert.equal(sock.sent.length, 1);
  assert.equal(sock.sent[0].content.delete.id, 'SPAM_LINK');

  const wrapped = textMsg(wrappedGroup, 'invólucro', { from: member, fromMe: false, id: 'WRAPPED_LINK' });
  wrapped.message = { ephemeralMessage: { message: { extendedTextMessage: { text: 'spam.example/promo' } } } };
  await handleMessage(sock, wrapped, deps);
  assert.equal(sock.sent[1].content.delete.id, 'WRAPPED_LINK', 'mensagens efêmeras também passam pelo filtro');

  const viewOnce = textMsg(wrappedGroup, 'view once', { from: member, fromMe: false, id: 'VIEW_ONCE_LINK' });
  viewOnce.message = { viewOnceMessage: { message: { extendedTextMessage: { text: 'https://spam.example/private' } } } };
  await handleMessage(sock, viewOnce, deps);
  assert.equal(sock.sent.length, 2, 'o filtro não abre conteúdo View Once');

  await handleMessage(sock, textMsg(group, 'https://spam.example/admin', { from: admin, fromMe: false }), deps);
  assert.equal(sock.sent.length, 2, 'links enviados por administradores não são apagados');
});

test('anti-link: sem admin do bot, bloqueia comandos com link sem tentar apagar', async () => {
  const group = 'anti-link-sem-admin@g.us';
  const member = '5531995556666@s.whatsapp.net';
  cfg.get().autorizados = [group];
  cfg.get().grupos[group] = {
    welcome: false,
    goodbye: false,
    antiLink: { enabled: true, allowlist: [] }
  };

  const sock = makeSock();
  sock.groupMetadata = async (jid) => ({
    id: jid,
    participants: [{ id: member }, { id: sock.user.id, admin: null }]
  });
  await handleMessage(sock, textMsg(group, '.dl https://youtube.com/watch?v=abc', { from: member, fromMe: false }), makeDeps(sock));
  assert.equal(sock.sent.length, 0, 'link não segue para o downloader quando o bot não pode moderá-lo');
});

test('anti-link: se não consegue confirmar os metadados, não processa o link', async () => {
  const group = 'grupo-metadata-indisponivel@g.us';
  const member = '5531995557777@s.whatsapp.net';
  cfg.get().autorizados = [group];
  cfg.get().grupos[group] = {
    welcome: false,
    goodbye: false,
    antiLink: { enabled: true, allowlist: [] }
  };
  const sock = makeSock();
  sock.groupMetadata = async () => { throw new Error('metadados indisponíveis'); };

  await handleMessage(sock, textMsg(group, '.dl https://youtube.com/watch?v=abc', { from: member, fromMe: false }), makeDeps(sock));
  assert.equal(sock.sent.length, 0, 'falha de verificação não libera download nem tenta excluir');
});

test('configuração de grupo: boas-vindas e anti-link exigem admin; ativar anti-link exige o bot admin', async () => {
  const group = 'grupo-config-segura@g.us';
  const admin = '5531977001122@s.whatsapp.net';
  const member = '5531977003344@s.whatsapp.net';
  cfg.get().autorizados = [group];
  const sock = makeSock();
  sock.groupMetadata = async (jid) => ({
    id: jid,
    participants: [
      { id: sock.user.id, admin: 'admin' },
      { id: admin, admin: 'admin' },
      { id: member }
    ]
  });
  const deps = makeDeps(sock);

  await handleMessage(sock, textMsg(group, '.boasvindas on', { from: admin, fromMe: false }), deps);
  await handleMessage(sock, textMsg(group, '.boasvindas saida on', { from: admin, fromMe: false }), deps);
  await handleMessage(sock, textMsg(group, '.antilink permitir example.com', { from: admin, fromMe: false }), deps);
  await handleMessage(sock, textMsg(group, '.antilink on', { from: admin, fromMe: false }), deps);

  assert.equal(cfg.get().grupos[group].welcome, true);
  assert.equal(cfg.get().grupos[group].goodbye, true);
  assert.equal(cfg.get().grupos[group].antiLink.enabled, true);
  assert.deepEqual(cfg.get().grupos[group].antiLink.allowlist, ['example.com']);

  await handleMessage(sock, textMsg(group, '.antilink off', { from: member, fromMe: false }), deps);
  assert.equal(cfg.get().grupos[group].antiLink.enabled, true, 'membro comum não pode mudar as regras');
  assert.match(sock.sent.at(-1).content.text || '', /administradores do grupo/i);
});

test('antilink não pode ser ativado antes de o bot receber permissão de administrador', async () => {
  const group = 'grupo-bot-sem-admin@g.us';
  const admin = '5531977550001@s.whatsapp.net';
  cfg.get().autorizados = [group];
  const sock = makeSock();
  sock.groupMetadata = async (jid) => ({
    id: jid,
    participants: [{ id: sock.user.id }, { id: admin, admin: 'admin' }]
  });

  await handleMessage(sock, textMsg(group, '.antilink on', { from: admin, fromMe: false }), makeDeps(sock));
  assert.equal(cfg.get().grupos[group], undefined, 'a proteção permanece desligada');
  assert.match(sock.sent.at(-1).content.text || '', /promova o bot a administrador/i);
});

test('autorização individual de participante não habilita moderação, enquetes ou ajustes do grupo', async () => {
  const group = 'grupo-nao-liberado@g.us';
  const member = '5531990001234@s.whatsapp.net';
  cfg.get().autorizados = [member];
  cfg.get().grupos[group] = {
    welcome: false,
    goodbye: false,
    antiLink: { enabled: true, allowlist: [] }
  };
  const sock = makeSock();
  let metadataCalls = 0;
  sock.groupMetadata = async () => {
    metadataCalls++;
    return { participants: [{ id: member, admin: 'admin' }, { id: sock.user.id, admin: 'admin' }] };
  };
  const deps = makeDeps(sock);

  await handleMessage(sock, textMsg(group, 'https://spam.example/promo', { from: member, fromMe: false }), deps);
  await handleMessage(sock, textMsg(group, '.enquete Pergunta? | Sim | Não', { from: member, fromMe: false }), deps);
  await handleMessage(sock, textMsg(group, '.antilink off', { from: member, fromMe: false }), deps);

  assert.equal(metadataCalls, 0, 'ferramentas de grupo exigem autorização explícita do JID do grupo');
  assert.equal(sock.sent.filter((entry) => entry.content.delete || entry.content.poll).length, 0);
  assert.equal(cfg.get().grupos[group].antiLink.enabled, true);
});

test('revogar grupo remove suas configurações opt-in locais', async () => {
  const group = 'grupo-revogado@g.us';
  cfg.get().autorizados = [group];
  cfg.get().grupos[group] = {
    welcome: true,
    goodbye: true,
    antiLink: { enabled: true, allowlist: ['example.com'] }
  };
  const sock = makeSock();

  await handleMessage(sock, textMsg(group, '.desativar', { from: OWNER_JID, fromMe: true }), makeDeps(sock));
  assert.equal(cfg.get().autorizados.includes(group), false);
  assert.equal(Object.hasOwn(cfg.get().grupos, group), false);
});

test('saudações de grupo só enviam eventos add/remove com opt-in e grupo autorizado', async () => {
  const welcomeGroup = 'welcome-opt-in@g.us';
  const goodbyeGroup = 'goodbye-opt-in@g.us';
  const closedGroup = 'welcome-fechado@g.us';
  const newcomer = '5531988880000@s.whatsapp.net';
  cfg.get().autorizados = [welcomeGroup, goodbyeGroup];
  cfg.get().grupos[welcomeGroup] = { welcome: true, goodbye: false, antiLink: { enabled: false, allowlist: [] } };
  cfg.get().grupos[goodbyeGroup] = { welcome: false, goodbye: true, antiLink: { enabled: false, allowlist: [] } };
  cfg.get().grupos[closedGroup] = { welcome: true, goodbye: false, antiLink: { enabled: false, allowlist: [] } };

  const sock = makeSock();
  await handleGroupParticipantsUpdate(sock, { id: welcomeGroup, action: 'add', participants: [newcomer] });
  await handleGroupParticipantsUpdate(sock, { id: goodbyeGroup, action: 'remove', participants: [newcomer] });
  await handleGroupParticipantsUpdate(sock, { id: closedGroup, action: 'add', participants: [newcomer] });
  await handleGroupParticipantsUpdate(sock, { id: welcomeGroup, action: 'promote', participants: [newcomer] });

  assert.equal(sock.sent.length, 2);
  assert.match(sock.sent[0].content.text, /@5531988880000/);
  assert.deepEqual(sock.sent[0].content.mentions, [newcomer]);
  assert.match(sock.sent[1].content.text, /Até mais/);
});

test('enquetes validam opções e limitam envios por usuário/grupo', async () => {
  const group = 'enquete-limitada@g.us';
  const member = '5531977554433@s.whatsapp.net';
  cfg.get().autorizados = [group];
  const sock = makeSock();
  const deps = makeDeps(sock);

  await handleMessage(sock, textMsg(group, '.enquete Pizza ou massa? | Pizza | Massa', { from: member, fromMe: false }), deps);
  await handleMessage(sock, textMsg(group, '.enquete Café? | Sim | Não', { from: member, fromMe: false }), deps);

  assert.equal(sock.sent.filter((entry) => entry.content.poll).length, 1, 'o limite silencioso bloqueia enquete repetida');
  assert.deepEqual(sock.sent[0].content.poll, {
    name: 'Pizza ou massa?',
    values: ['Pizza', 'Massa'],
    selectableCount: 1
  });
});

test('anti-delete: sem opt-in mensagens não entram no cache', async () => {
  const sock = makeSock();
  const original = textMsg(OWNER_JID, 'não reter por padrão', { id: 'NO_OPT_IN' });
  await handleMessage(sock, original, makeDeps(sock, 'notify'));
  assert.equal(messageCache.get(OWNER_JID, 'NO_OPT_IN'), null);
  assert.equal(sock.sent.length, 0);
});

test('anti-delete: opt-in por chat envia mensagem apagada SOMENTE ao privado do dono', async () => {
  const sock = makeSock();
  const chat = 'grupo-teste@g.us';
  cfg.get().autorizados = [chat];
  cfg.get().antiDelete.chats = [chat];
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
  cfg.get().autorizados = [chat];
  cfg.get().antiDelete.chats = [chat];
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
  cfg.get().autorizados = [chat];
  cfg.get().antiDelete.chats = [chat];
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

test('privacidade: responder a uma View Once com texto comum não dispara captura', async () => {
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
  assert.equal(sock.sent.length, 0, 'captura automática não é iniciada por resposta livre');
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

test('automação é habilitada e desabilitada por chat, com limpeza do cache', async () => {
  const sock = makeSock();
  const deps = makeDeps(sock);

  await handleMessage(sock, textMsg(OWNER_JID, '.vo on aqui'), deps);
  assert.deepEqual(cfg.get().viewOnce.autoChats, [OWNER_JID]);
  await handleMessage(sock, textMsg(OWNER_JID, '.vo off aqui'), deps);
  assert.deepEqual(cfg.get().viewOnce.autoChats, []);

  const cached = textMsg(OWNER_JID, 'apagável', { id: 'CLEAR1' });
  cfg.get().antiDelete.chats = [OWNER_JID];
  messageCache.put(cached, { persist: true });
  assert.ok(messageCache.get(OWNER_JID, 'CLEAR1'));
  await handleMessage(sock, textMsg(OWNER_JID, '.antidelete off aqui'), deps);
  assert.equal(messageCache.get(OWNER_JID, 'CLEAR1'), null);
  assert.deepEqual(cfg.get().antiDelete.chats, []);
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
  cfg.get().autorizados = [chat];
  cfg.get().antiDelete.chats = [chat];
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
  cfg.get().autorizados = [chat];
  cfg.get().antiDelete.chats = [chat];
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

test('backlog (append) não executa comando nem responde, mas fica no cache se Anti-Delete está opt-in', async () => {
  const sock = makeSock();
  cfg.get().antiDelete.chats = [OWNER_JID];
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
  return new Response(text, { status, headers: { 'content-type': 'application/json' } });
}

function bufferRes(buf) {
  return new Response(buf, {
    status: 200,
    headers: { 'content-type': 'video/mp4', 'content-length': String(buf.length) }
  });
}

async function freshResponse(response) {
  const body = response.body ? await response.clone().arrayBuffer() : null;
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

async function withMockedFetch(routes, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    for (const [matcher, responder] of routes) {
      if (typeof matcher === 'string' ? u.includes(matcher) : matcher.test(u)) {
        const response = typeof responder === 'function' ? responder(u) : responder;
        return response instanceof Response ? freshResponse(response) : response;
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
