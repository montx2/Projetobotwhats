// Testes do extrator do ComedyHub (thecomedyhub.com.br) — offline, com fetch mockado.
//
// Contexto real: o `.dl` de um link `/meme/<uuid>` baixava a FOTO DE INTRODUÇÃO
// do site (o `og:image` da página de login). A causa era dupla:
//   • a página é uma SPA e só mostra o post para quem está logado;
//   • o raspador genérico caía na página e lia as metas do próprio site.
// Aqui ficam travados: a leitura do ID, a escolha da mídia real do JSON da API,
// a sonda que recusa capa quando o post é vídeo e a garantia de que o ComedyHub
// NUNCA volta para o scraping de página (nem entrega imagem no lugar do vídeo).

import test from 'node:test';
import assert from 'node:assert/strict';
import { setDnsLookupForTests } from '../src/core/http.js';

import {
  comedyHubPostId,
  comedyHubPostUrl,
  comedyHubMediaCandidates,
  comedyHubMediaHeaders,
  pickComedyHubMedia,
  comedyHubLogin,
  comedyHubSession,
  comedyHubSessionStatus,
  clearComedyHubSession,
  saveComedyHubSession,
  decodeJwtPayload,
  jwtExpiresAt,
  tokenExpired,
  maskToken,
  isComedyHubUrl,
  findJwt,
  downloadComedyHub
} from '../src/features/downloaders/comedyhub.js';
import { detectPlatform, resolveDownload } from '../src/features/download.js';

setDnsLookupForTests(async () => [{ address: '8.8.8.8', family: 4 }]);

const MEME_ID = '01a112f9-a026-748e-856c-fd44fe04bb09';
const POST_PAGE = `https://thecomedyhub.com.br/meme/${MEME_ID}`;
const API_POST = `https://api.thecomedyhub.com.br/api/v2/memes/${MEME_ID}`;
const VIDEO_URL = 'https://api.thecomedyhub.com.br/api/static/memes/abc123.mp4';
const OTHER_VIDEO = 'https://api.thecomedyhub.com.br/api/static/memes/abc123-hd.mp4';
const COVER_URL = 'https://thecomedyhub.com.br/images/logos/opengrath.webp';
const LOGIN_PAGE = `<!doctype html><html><head><meta property="og:image" content="${COVER_URL}"></head><body>login</body></html>`;

/** JWT sintético (só o formato importa: 3 partes separadas por ponto). */
function fakeJwt(expSeconds = Math.floor(Date.now() / 1000) + 3600) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: 'user-1', username: 'montx2', exp: expSeconds })).toString('base64url');
  return `${header}.${payload}.assinatura-fake`;
}

const MP4_BYTES = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypmp42', 'ascii'),
  Buffer.alloc(120, 7)
]);
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(80, 3)]);

function jsonResponse(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function mediaResponse(buffer) {
  const isImage = buffer[0] === 0xff && buffer[1] === 0xd8;
  return new Response(buffer, {
    status: 200,
    headers: {
      'content-type': isImage ? 'image/jpeg' : 'video/mp4',
      'content-length': String(buffer.length)
    }
  });
}

async function cloneResponse(response) {
  const body = response.body ? await response.clone().arrayBuffer() : null;
  return new Response(body, { status: response.status, headers: response.headers });
}

/** Roteador de fetch: pares [matcher, handler]; devolve as chamadas feitas. */
function mockFetch(routes) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    calls.push({ url: href, method: (init.method || 'GET').toUpperCase(), headers: init.headers || {} });
    for (const [matcher, handler] of routes) {
      const matched = typeof matcher === 'string' ? href.includes(matcher) : matcher.test(href);
      if (matched) {
        const response = handler(href, init) ?? jsonResponse({});
        return response instanceof Response ? cloneResponse(await response) : mediaResponse(response);
      }
    }
    throw new Error(`rota não mockada: ${href}`);
  };
  return {
    calls,
    urls: () => calls.map((call) => call.url),
    restore() {
      globalThis.fetch = original;
    }
  };
}

function clearComedyHubEnv() {
  for (const key of ['COMEDYHUB_TOKEN', 'COMEDYHUB_JWT', 'COMEDYHUB_ACCESS_TOKEN', 'COMEDYHUB_LOGIN', 'COMEDYHUB_PASSWORD', 'COMEDYHUB_EMAIL']) {
    delete process.env[key];
  }
}

const postFixture = (extra = {}) => ({
  data: {
    id: MEME_ID,
    title: 'Gato dançando',
    description: 'memezinho',
    type: 'video',
    status: 'OK',
    contentUrl: VIDEO_URL,
    downloadUrl: OTHER_VIDEO,
    downloadExtension: 'mp4',
    thumbnailUrl: COVER_URL,
    width: 720,
    height: 1280,
    createdBy: { username: 'montx2' },
    ...extra
  }
});

/* ───────────────────────── identificação do link ───────────────────────── */

test('comedyHubPostId lê todas as formas de link do ComedyHub', () => {
  assert.equal(comedyHubPostId(POST_PAGE), MEME_ID);
  assert.equal(comedyHubPostId(`https://thecomedyhub.com.br/app/post/${MEME_ID}`), MEME_ID);
  assert.equal(comedyHubPostId(`https://thecomedyhub.com.br/app/post/${MEME_ID}?comment=1`), MEME_ID);
  assert.equal(comedyHubPostId(`https://thecomedyhub.com.br/post/${MEME_ID.toUpperCase()}`), MEME_ID);
  assert.equal(comedyHubPostId(`https://thecomedyhub.com.br/x?memeId=${MEME_ID}`), MEME_ID);
  assert.equal(comedyHubPostId('https://thecomedyhub.com.br/app/feed/recents'), null);
  assert.equal(comedyHubPostId(''), null);
  assert.equal(comedyHubPostUrl(MEME_ID), POST_PAGE);
});

test('isComedyHubUrl reconhece site, API e recusa parecidos', () => {
  assert.ok(isComedyHubUrl(POST_PAGE));
  assert.ok(isComedyHubUrl('https://api.thecomedyhub.com.br/api/v2/memes/1'));
  assert.ok(!isComedyHubUrl('https://thecomedyhub.com.br.evil.example/meme/1'));
  assert.ok(!isComedyHubUrl('https://outrohub.com.br/meme/1'));
});

test('detectPlatform nomeia o ComedyHub', () => {
  assert.equal(detectPlatform(POST_PAGE), 'ComedyHub');
});

/* ─────────────────────────────── sessão ─────────────────────────────── */

test('token: leitura do JWT, validade e máscara', () => {
  const token = fakeJwt();
  const payload = decodeJwtPayload(token);
  assert.equal(payload.username, 'montx2');
  assert.ok(jwtExpiresAt(token) > Date.now());
  assert.equal(tokenExpired(token), false);
  assert.equal(tokenExpired(fakeJwt(Math.floor(Date.now() / 1000) - 10)), true);
  assert.ok(maskToken(token).startsWith(token.slice(0, 12)));
  assert.ok(!maskToken(token).includes(token.slice(12, -6)));
});

test('sessão usa o .env quando existe e cai para o arquivo salvo', () => {
  clearComedyHubEnv();
  clearComedyHubSession();
  assert.equal(comedyHubSession(), null);

  const token = fakeJwt();
  saveComedyHubSession(token, { user: 'montx2' });
  const stored = comedyHubSession();
  assert.equal(stored.source, 'data/comedyhub.json');
  assert.equal(stored.expired, false);
  assert.equal(comedyHubSessionStatus().logged, true);

  process.env.COMEDYHUB_TOKEN = `Bearer ${token}`;
  const fromEnv = comedyHubSession();
  assert.equal(fromEnv.source, 'COMEDYHUB_TOKEN');
  assert.equal(fromEnv.token, token, 'o prefixo Bearer é removido');

  clearComedyHubEnv();
  clearComedyHubSession();
});

test('findJwt encontra token em respostas aninhadas', () => {
  const token = fakeJwt();
  assert.equal(findJwt({ data: { access_token: token } }), token);
  assert.equal(findJwt({ erro: 'sem token' }), null);
});

/* ─────────────────────── candidatos de mídia ─────────────────────── */

test('candidatos: downloadUrl e contentUrl vêm antes e a capa fica fora', () => {
  const candidates = comedyHubMediaCandidates(postFixture().data);
  assert.deepEqual(candidates.map((item) => item.url).slice(0, 2), [OTHER_VIDEO, VIDEO_URL]);
  assert.ok(candidates.every((item) => item.url !== COVER_URL), 'capa não entra quando existe arquivo do meme');
  assert.equal(candidates[0].kind, 'video');
});

test('candidatos: sem nenhum arquivo, a capa é o último recurso', () => {
  const candidates = comedyHubMediaCandidates({ id: MEME_ID, type: 'image', thumbnailUrl: COVER_URL });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].url, COVER_URL);
});

test('candidatos: caminho relativo é resolvido para o host certo', () => {
  const apiRelative = comedyHubMediaCandidates({ id: MEME_ID, type: 'video', contentUrl: '/api/static/x.mp4' });
  assert.equal(apiRelative[0].url, 'https://api.thecomedyhub.com.br/api/static/x.mp4');
  const webRelative = comedyHubMediaCandidates({ id: MEME_ID, type: 'image', contentUrl: '/images/memes/x.webp' });
  assert.equal(webRelative[0].url, 'https://thecomedyhub.com.br/images/memes/x.webp');
});

test('candidatos: link da PÁGINA do post nunca entra como mídia', () => {
  const candidates = comedyHubMediaCandidates({
    id: MEME_ID,
    type: 'video',
    url: POST_PAGE, // rota do app (`/meme/<uuid>`), não arquivo
    thumbnailUrl: COVER_URL
  });
  assert.deepEqual(candidates.map((item) => item.url), [COVER_URL], 'só restou a capa como último recurso');
});

test('sonda: candidato único que é página HTML é RECUSADO, não entregue como vídeo', async () => {
  const mock = mockFetch([
    [/api\/static\/memes\/sem-extensao/, () => new Response('<html>login</html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'content-length': '20' }
    })]
  ]);
  try {
    await assert.rejects(
      () => pickComedyHubMedia(
        [{ url: 'https://api.thecomedyhub.com.br/api/static/memes/sem-extensao', label: 'contentUrl', kind: 'video' }],
        'video',
        { token: fakeJwt() }
      ),
      /tipo esperado/
    );
  } finally {
    mock.restore();
  }
});

test('cabeçalhos: token só acompanha os hosts do ComedyHub', () => {
  const token = fakeJwt();
  assert.equal(comedyHubMediaHeaders(VIDEO_URL, token).authorization, `Bearer ${token}`);
  const external = comedyHubMediaHeaders('https://cdn.exemplo.com/x.mp4', token);
  assert.equal(external.authorization, undefined, 'não vaza o token para terceiros');
});

/* ────────────────────────────── login ────────────────────────────── */

test('login: acha a rota certa e guarda o token', async () => {
  clearComedyHubEnv();
  clearComedyHubSession();
  const token = fakeJwt();
  const mock = mockFetch([
    ['/auth/login', () => jsonResponse({ token })],
    ['/memes/visualize/', () => jsonResponse({ ok: true })]
  ]);
  try {
    const out = await comedyHubLogin('eu@email.com', 'senha');
    assert.equal(out.token, token);
    assert.equal(out.endpoint, 'https://api.thecomedyhub.com.br/api/v2/auth/login');
    assert.equal(comedyHubSession().token, token);
    assert.ok(mock.urls().some((url) => url.includes('/auth/login')), 'bateu na rota de login');
  } finally {
    mock.restore();
    clearComedyHubSession();
  }
});

test('login: credenciais erradas devolvem erro claro (sem ficar tentando)', async () => {
  clearComedyHubEnv();
  clearComedyHubSession();
  const mock = mockFetch([[/(auth\/login|login|sessions|signin)/, () => jsonResponse({ message: 'senha inválida' }, { status: 401 })]]);
  try {
    await assert.rejects(() => comedyHubLogin('eu@email.com', 'errada'), /recusados|não consegui logar/);
  } finally {
    mock.restore();
    clearComedyHubSession();
  }
});

/* ─────────────────────── download completo (mock) ─────────────────────── */

test('downloadComedyHub: pega o arquivo do meme com o token do .env', async () => {
  clearComedyHubEnv();
  process.env.COMEDYHUB_TOKEN = fakeJwt();
  const mock = mockFetch([
    ['/api/v2/memes/', () => jsonResponse(postFixture())],
    [/api\/static\/.*\.mp4/, () => mediaResponse(MP4_BYTES)]
  ]);
  try {
    const result = await downloadComedyHub(POST_PAGE, 'melhor', {});
    assert.equal(result.platform, 'ComedyHub');
    assert.equal(result.kind, 'video');
    assert.equal(result.media[0].url, OTHER_VIDEO, 'downloadUrl é a primeira escolha');
    assert.equal(result.media[0].headers.authorization, `Bearer ${process.env.COMEDYHUB_TOKEN}`);
    assert.equal(result.author, '@montx2');
    assert.equal(result.title, 'Gato dançando');
    assert.equal(result.thumbnail, COVER_URL);
    assert.ok(result.media[0].url !== COVER_URL);
  } finally {
    mock.restore();
    clearComedyHubEnv();
  }
});

test('downloadComedyHub: capa em primeiro lugar é recusada pela sonda', async () => {
  clearComedyHubEnv();
  process.env.COMEDYHUB_TOKEN = fakeJwt();
  const post = postFixture().data;
  // Pior cenário: o downloadUrl serve a CAPA (imagem) e o contentUrl serve o vídeo.
  post.downloadUrl = COVER_URL;
  const mock = mockFetch([
    ['/api/v2/memes/', () => jsonResponse({ data: post })],
    [/opengrath\.webp/, () => mediaResponse(JPEG_BYTES)],
    [/abc123\.mp4/, () => mediaResponse(MP4_BYTES)]
  ]);
  try {
    const result = await downloadComedyHub(POST_PAGE, 'melhor', {});
    assert.equal(result.kind, 'video');
    assert.equal(result.media[0].url, VIDEO_URL, 'trocou a capa pelo vídeo de verdade');
  } finally {
    mock.restore();
    clearComedyHubEnv();
  }
});

test('downloadComedyHub: sessão recusada (401) explica como renovar', async () => {
  clearComedyHubEnv();
  process.env.COMEDYHUB_TOKEN = fakeJwt();
  const mock = mockFetch([['/api/v2/memes/', () => jsonResponse({ message: 'Token inválido ou expirado', statusCode: 498 }, { status: 498 })]]);
  try {
    await assert.rejects(
      () => downloadComedyHub(POST_PAGE, 'melhor', {}),
      (error) => /venceu|recusou/.test(error.message) && /chlogin|chtoken/.test(error.hint || '')
    );
  } finally {
    mock.restore();
    clearComedyHubEnv();
  }
});

/* ─────────── o bug do usuário: nunca entregar a foto de introdução ─────────── */

test('resolveDownload (ComedyHub sem sessão): falha com instrução e NÃO manda a capa', async () => {
  clearComedyHubEnv();
  clearComedyHubSession();
  const mock = mockFetch([
    // Se o bot voltasse ao scraping genérico, acharia a capa aqui:
    ['thecomedyhub.com.br/meme/', () => new Response(LOGIN_PAGE, { status: 200, headers: { 'content-type': 'text/html' } })],
    [/opengrath\.webp/, () => mediaResponse(JPEG_BYTES)]
  ]);
  try {
    await assert.rejects(
      () => resolveDownload(POST_PAGE, 'melhor', {}),
      (error) => {
        assert.match(String(error.message), /logado|login/i);
        assert.match(String(error.hint || ''), /chlogin|chtoken/);
        return true;
      }
    );
    assert.ok(
      !mock.urls().some((url) => url.includes('opengrath.webp')),
      'a foto de introdução do site nunca deve ser baixada'
    );
  } finally {
    mock.restore();
    clearComedyHubEnv();
  }
});

/* ──────────────────── comandos do router (.ch / .chlogin) ──────────────────── */

const { handleMessage } = await import('../src/features/router.js');
const OWNER_JID = '5511900000000@s.whatsapp.net';

function makeSock() {
  const sent = [];
  return {
    sent,
    user: { id: '5511900000000:1@s.whatsapp.net', name: 'MontxBOT' },
    sendMessage: async (jid, content) => {
      sent.push({ jid, content });
      return { key: { id: `S${sent.length}`, remoteJid: jid } };
    },
    groupMetadata: async (jid) => ({ id: jid, participants: [] }),
    updateMediaMessage: async () => {
      throw new Error('sem mídia no mock');
    }
  };
}

function makeDeps(sock) {
  return {
    type: 'notify',
    ownerJid: OWNER_JID,
    isOwner: (jid, participant) => [jid, participant].includes(OWNER_JID) || jid === sock.user.id,
    isOwnerPrivateChat: (jid) => jid === OWNER_JID,
    sendOwner: async () => {}
  };
}

function ownerMessage(text) {
  return {
    key: { remoteJid: OWNER_JID, id: `M${Math.random().toString(36).slice(2)}`, fromMe: true },
    pushName: 'Dono',
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: { conversation: text }
  };
}

const replyText = (sock) => sock.sent.map((item) => String(item.content.text || JSON.stringify(item.content))).join('\n');

test('router: .chstatus sem sessão explica o .chlogin', async () => {
  clearComedyHubEnv();
  clearComedyHubSession();
  const sock = makeSock();
  await handleMessage(sock, ownerMessage('.chstatus'), makeDeps(sock));
  const text = replyText(sock);
  assert.match(text, /ComedyHub/);
  assert.match(text, /\.chlogin/);
  assert.match(text, /\.chtoken/);
});

test('router: .chlogin sem argumentos mostra o modo de usar', async () => {
  clearComedyHubEnv();
  clearComedyHubSession();
  const sock = makeSock();
  await handleMessage(sock, ownerMessage('.chlogin'), makeDeps(sock));
  assert.match(replyText(sock), /\.chlogin/);
});

test('router: .chtoken guarda o token e .chstatus confirma a conta', async () => {
  clearComedyHubEnv();
  clearComedyHubSession();
  const token = fakeJwt();
  const sock = makeSock();
  await handleMessage(sock, ownerMessage(`.chtoken ${token}`), makeDeps(sock));
  assert.match(replyText(sock), /Token do ComedyHub salvo/);
  assert.equal(comedyHubSession().token, token, 'token salvo no disco');

  const sock2 = makeSock();
  await handleMessage(sock2, ownerMessage('.chstatus'), makeDeps(sock2));
  assert.match(replyText(sock2), /sessão ativa/);

  const sock3 = makeSock();
  await handleMessage(sock3, ownerMessage('.chsair'), makeDeps(sock3));
  assert.match(replyText(sock3), /desconectado/);
  assert.equal(comedyHubSession(), null);
  clearComedyHubSession();
});

test('router: .ch sem sessão responde o motivo em vez de mandar a capa', async () => {
  clearComedyHubEnv();
  clearComedyHubSession();
  const mock = mockFetch([
    ['thecomedyhub.com.br/meme/', () => new Response(LOGIN_PAGE, { status: 200, headers: { 'content-type': 'text/html' } })],
    [/opengrath\.webp/, () => mediaResponse(JPEG_BYTES)]
  ]);
  try {
    const sock = makeSock();
    await handleMessage(sock, ownerMessage(`.ch ${POST_PAGE}`), makeDeps(sock));
    const text = replyText(sock);
    assert.match(text, /logado|chlogin/);
    assert.ok(!sock.sent.some((item) => String(item.content.text || '').includes('Download concluído')));
    assert.ok(!mock.urls().some((url) => url.includes('opengrath.webp')), 'a capa do site nunca é baixada');
  } finally {
    mock.restore();
  }
});

test('router: .info do dono mostra o estado da sessão do ComedyHub', async () => {
  clearComedyHubEnv();
  clearComedyHubSession();
  const withoutSession = makeSock();
  await handleMessage(withoutSession, ownerMessage('.info'), makeDeps(withoutSession));
  assert.match(replyText(withoutSession), /comedyhub: sem login \(\.chlogin\)/);

  saveComedyHubSession(fakeJwt());
  const withSession = makeSock();
  await handleMessage(withSession, ownerMessage('.info'), makeDeps(withSession));
  assert.match(replyText(withSession), /comedyhub: sessão ativa \(\.ch\)/);

  saveComedyHubSession(fakeJwt(Math.floor(Date.now() / 1000) - 60));
  const expired = makeSock();
  await handleMessage(expired, ownerMessage('.info'), makeDeps(expired));
  assert.match(replyText(expired), /comedyhub: sessão vencida \(rode \.chlogin\)/);

  clearComedyHubSession();
});

test('resolveDownload (ComedyHub com sessão): entrega o MP4 do meme', async () => {
  clearComedyHubEnv();
  clearComedyHubSession();
  process.env.COMEDYHUB_TOKEN = fakeJwt();
  const mock = mockFetch([
    ['/api/v2/memes/', () => jsonResponse(postFixture())],
    [/abc123(-hd)?\.mp4/, () => mediaResponse(MP4_BYTES)]
  ]);
  try {
    const result = await resolveDownload(POST_PAGE, 'melhor', {});
    assert.equal(result.platform, 'ComedyHub');
    assert.equal(result.kind, 'video');
    assert.equal(result.buffers.length, 1);
    assert.equal(result.buffers[0].toString('ascii', 4, 8), 'ftyp', 'buffer é um MP4, não a capa');
  } finally {
    mock.restore();
    clearComedyHubEnv();
  }
});
