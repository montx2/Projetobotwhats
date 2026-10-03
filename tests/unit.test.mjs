// Testes offline das peças de lógica do NEXUS (node:test, zero deps).
import test from 'node:test';
import assert from 'node:assert/strict';

import { KeyPool } from '../src/core/keypool.js';
import { SlidingWindowLimiter } from '../src/core/limiter.js';
import { log } from '../src/core/logger.js';
import { parseQuality, QUALITIES } from '../src/features/downloaders/quality.js';
import { isIgnored, normalizeIgnoreTarget } from '../src/features/antidelete.js';
import { unwrapViewOnce, isViewOnce } from '../src/features/viewonce.js';
import { detectPlatform, isKnownSocialUrl } from '../src/features/download.js';
import { isTikTokUrl } from '../src/features/downloaders/tiktok.js';
import { isPinterestUrl } from '../src/features/downloaders/pinterest.js';
import { isInstagramUrl } from '../src/features/downloaders/instagram.js';
import { extractUrls, isGroup, normalizeJid, parseBool } from '../src/util/text.js';
import {
  isWebp,
  isAnimatedWebp,
  makeStickerExif,
  readStickerExif,
  setWebpExif,
  tagSticker,
  parseWebp,
  readChunks,
  buildRiff
} from '../src/util/webp.js';
import { makeSticker } from '../src/features/sticker.js';
import {
  gradeImageSamples,
  isRealImage,
  isUsableImageSize,
  looksLikeServerError,
  sniffImage
} from '../src/util/imageinfo.js';
import { DEFAULT_CONFIG, normalizeConfig } from '../src/core/config.js';
import {
  findDisallowedLinks,
  isBotGroupAdministrator,
  isGroupAdministrator,
  normalizeAllowDomain
} from '../src/features/group-tools.js';

test('logger oculta JIDs e valores de credenciais', () => {
  const originalLog = console.log;
  let output = '';
  console.log = (line) => { output = String(line); };
  try {
    log.warn('erro em 5511999999999:3@s.whatsapp.net grupo@g.us', {
      authorization: 'Bearer segredo-privado',
      token: 'token-privado'
    });
  } finally {
    console.log = originalLog;
  }
  assert.match(output, /\[JID\]/);
  assert.doesNotMatch(output, /5511999999999|grupo@g\.us|segredo-privado|token-privado/);
});

test('SlidingWindowLimiter respeita intervalo, janela e separação por ator', () => {
  const limiter = new SlidingWindowLimiter({ limit: 2, windowMs: 100, minIntervalMs: 20 });
  assert.equal(limiter.consume('alice', 100).allowed, true);
  assert.deepEqual(limiter.consume('alice', 110), { allowed: false, retryAfterMs: 10, reason: 'interval' });
  assert.equal(limiter.consume('alice', 120).allowed, true);
  assert.deepEqual(limiter.consume('alice', 150), { allowed: false, retryAfterMs: 50, reason: 'window' });
  assert.equal(limiter.consume('bob', 150).allowed, true, 'um remetente não consome a cota de outro');
  assert.equal(limiter.consume('alice', 200).allowed, true, 'eventos antigos expiram da janela');
});

// ── inspeção de imagem (cabeçalho + conteúdo) ────────────────

test('sniffImage lê formato e dimensões dos cabeçalhos (PNG/JPEG/GIF/WebP)', () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const pngFull = Buffer.concat([png, Buffer.from([0, 0, 1, 44, 0, 0, 2, 88, 8, 6, 0, 0, 0])]);
  assert.deepEqual(sniffImage(pngFull), { format: 'png', width: 300, height: 600, animated: false });

  // SOI + APP0 (16 bytes) + SOF0 com 480x640
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
    Buffer.from('JFIF\0', 'ascii'),
    Buffer.from([0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01])
  ]);
  const jpegInfo = sniffImage(jpeg);
  assert.equal(jpegInfo.format, 'jpeg');
  assert.equal(jpegInfo.width, 640);
  assert.equal(jpegInfo.height, 480);

  const gif = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.from([0x40, 0x01, 0xf0, 0x00, 0x00])]);
  assert.deepEqual(sniffImage(gif), { format: 'gif', width: 320, height: 240, animated: true });

  const webp = Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.from([0x24, 0x00, 0x00, 0x00]),
    Buffer.from('WEBPVP8X', 'ascii'),
    Buffer.from([0x0a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0x01, 0x00, 0xff, 0x01, 0x00])
  ]);
  assert.deepEqual(sniffImage(webp), { format: 'webp', width: 512, height: 512, animated: false });

  assert.equal(sniffImage(Buffer.from('<!DOCTYPE html>')), null);
  assert.equal(isRealImage(Buffer.from('nao sou imagem')), false);
});

test('isUsableImageSize barra miniatura e aceita o que serve de figurinha', () => {
  assert.equal(isUsableImageSize({ width: 1200, height: 630 }), true);
  assert.equal(isUsableImageSize({ width: 30, height: 30 }), false);
  assert.equal(isUsableImageSize({ width: 600, height: 40 }), false);
  assert.equal(isUsableImageSize(null), false);
});

test('looksLikeServerError reconhece XML de erro do CDN e HTML', () => {
  const xml = Buffer.from('<?xml version="1.0"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>');
  assert.equal(looksLikeServerError(xml), true);
  assert.equal(looksLikeServerError(Buffer.from('<!DOCTYPE html><html><body>oi</body></html>')), true);
  assert.equal(looksLikeServerError(Buffer.from('{"erro":"x"}')), true);
  // PNG de verdade nunca é "erro de servidor"
  assert.equal(looksLikeServerError(Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')), false);
});

test('gradeImageSamples: gradiente/chapado reprovam, conteúdo com detalhe aprova', () => {
  const W = 32;
  const H = 32;
  const make = (fn) => {
    const buf = Buffer.alloc(W * H * 3);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const [r, g, b] = fn(x, y);
        const i = (y * W + x) * 3;
        buf[i] = r;
        buf[i + 1] = g;
        buf[i + 2] = b;
      }
    }
    return buf;
  };

  // Gradiente diagonal perfeito — o "asset de marca" que aparecia como figurinha.
  const gradient = gradeImageSamples(make((x, y) => [x * 8, y * 8, 128]), { width: W, height: H });
  assert.equal(gradient.verdict, 'smooth');
  assert.equal(gradient.smooth, true);
  assert.ok(gradient.edge < 0.012, `borda baixa (${gradient.edge})`);

  // Cor chapada — placeholder de "carregando".
  const solid = gradeImageSamples(make(() => [40, 120, 40]), { width: W, height: H });
  assert.equal(solid.verdict, 'solid');
  assert.equal(solid.solid, true);

  // Padrão com estrutura (xadrez + ruído) — tem cara de imagem de verdade.
  const detailed = gradeImageSamples(
    make((x, y) => {
      const checker = (x >> 1) % 2 === (y >> 1) % 2 ? 200 : 30;
      const noise = ((x * 7 + y * 13) % 17) * 4;
      return [Math.min(255, checker + noise), (checker + noise) % 200, 90];
    }),
    { width: W, height: H }
  );
  assert.equal(detailed.verdict, 'detail');
  assert.equal(detailed.smooth, false);
  assert.equal(detailed.solid, false);
  assert.ok(detailed.edge > 0.05, `borda alta (${detailed.edge})`);
});

// ── KeyPool ──────────────────────────────────────────────────
test('KeyPool gira em round-robin', () => {
  const pool = new KeyPool('t', ['a', 'b', 'c']);
  assert.equal(pool.next(), 'a');
  assert.equal(pool.next(), 'b');
  assert.equal(pool.next(), 'c');
  assert.equal(pool.next(), 'a');
});

test('KeyPool pula chave em cooldown', () => {
  const pool = new KeyPool('t', ['a', 'b'], { cooldownMs: 60_000 });
  pool.reportFailure('a', { reason: 'limite' });
  assert.equal(pool.available, 1);
  assert.equal(pool.next(), 'b');
  assert.equal(pool.next(), 'b');
});

test('KeyPool.run gira até ter sucesso', async () => {
  const pool = new KeyPool('t', ['bad', 'good']);
  let calls = 0;
  const result = await pool.run((key) => {
    calls++;
    if (key === 'bad') {
      const e = new Error('rate limit exceeded');
      throw e;
    }
    return `ok-${key}`;
  });
  assert.equal(result, 'ok-good');
  assert.equal(calls, 2);
});

test('KeyPool.run falha quando todos falham', async () => {
  const pool = new KeyPool('t', ['x']);
  await assert.rejects(() => pool.run(() => {
    const e = new Error('quota exceeded');
    throw e;
  }), /falharam|cooldown/);
});

test('KeyPool não reutiliza itens em cooldown e retorna retry-after', async () => {
  const pool = new KeyPool('limited', ['x'], { cooldownMs: 60_000 });
  pool.reportFailure('x', { cooldownMs: 45_000 });
  let called = false;
  await assert.rejects(
    () => pool.run(() => { called = true; }),
    (error) => error.pool === 'limited' && error.retryAfterMs > 0
  );
  assert.equal(called, false);
});

// ── Qualidade ────────────────────────────────────────────────
test('parseQuality padrão é melhor', () => {
  const { quality, rest } = parseQuality(['https://x.com']);
  assert.equal(quality, 'melhor');
  assert.deepEqual(rest, ['https://x.com']);
});

test('parseQuality entende apelidos', () => {
  assert.equal(parseQuality(['baixa']).quality, 'baixa');
  assert.equal(parseQuality(['sd']).quality, 'baixa');
  assert.equal(parseQuality(['hd']).quality, 'melhor');
  assert.equal(parseQuality(['média']).quality, 'media');
  assert.equal(parseQuality(['720']).quality, 'media');
  assert.equal(parseQuality(['leve']).quality, 'baixa');
});

test('parseQuality preserva os demais argumentos', () => {
  const { quality, rest } = parseQuality(['link', 'alta', 'extra']);
  assert.equal(quality, 'alta');
  assert.deepEqual(rest, ['link', 'extra']);
});

test('todas as qualidades conhecidas existem', () => {
  assert.deepEqual(QUALITIES, ['melhor', 'alta', 'media', 'baixa']);
});

// ── Anti-delete ──────────────────────────────────────────────
test('antiDelete ignora grupos quando filtrado', () => {
  assert.equal(isIgnored('123@g.us', ['grupos']), true);
  assert.equal(isIgnored('5511@s.whatsapp.net', ['grupos']), false);
});

test('antiDelete ignora privado quando filtrado', () => {
  assert.equal(isIgnored('55119@s.whatsapp.net', ['privado']), true);
  assert.equal(isIgnored('123@g.us', ['privado']), false);
});

test('antiDelete ignora jid específico', () => {
  assert.equal(isIgnored('55119@s.whatsapp.net', ['55119@s.whatsapp.net']), true);
  assert.equal(isIgnored('55118@s.whatsapp.net', ['55119@s.whatsapp.net']), false);
});

test('antiDelete lista vazia protege tudo', () => {
  assert.equal(isIgnored('123@g.us', []), false);
  assert.equal(isIgnored('55@s.whatsapp.net', []), false);
});

test('normalizeJid remove o sufixo de dispositivo sem mudar o domínio', () => {
  assert.equal(normalizeJid('55119999:23@s.whatsapp.net'), '55119999@s.whatsapp.net');
  assert.equal(normalizeJid('ABC@g.us'), 'abc@g.us');
});

test('normalizeIgnoreTarget resolve "aqui" e números', () => {
  const msg = { key: { remoteJid: 'grupo@g.us' } };
  assert.equal(normalizeIgnoreTarget('aqui', msg), 'grupo@g.us');
  assert.equal(normalizeIgnoreTarget('GRUPOS', msg), 'grupos');
  assert.equal(normalizeIgnoreTarget('5511999999999', msg), '5511999999999@s.whatsapp.net');
});

test('antiDelete é opt-in por chat e começa desativado', () => {
  assert.deepEqual(DEFAULT_CONFIG.antiDelete.chats, []);
  assert.deepEqual(DEFAULT_CONFIG.antiDelete.ignorar, []);
  assert.equal(DEFAULT_CONFIG.autoDownload, false);
});

// ── View Once ────────────────────────────────────────────────
test('unwrapViewOnce desembrulha todos os wrappers', () => {
  const cases = [
    { viewOnceMessage: { message: { imageMessage: { url: 'x' } } } },
    { viewOnceMessageV2: { message: { videoMessage: { url: 'x' } } } },
    { viewOnceMessageV2Extension: { message: { audioMessage: { url: 'x' } } } }
  ];
  const expected = ['imageMessage', 'videoMessage', 'audioMessage'];
  cases.forEach((msg, i) => {
    const vo = unwrapViewOnce(msg);
    assert.ok(vo, `caso ${i}`);
    assert.equal(vo.type, expected[i]);
  });
});

test('unwrapViewOnce retorna null para mensagens e mídias comuns (foto, vídeo, áudio normais)', () => {
  assert.equal(unwrapViewOnce({ conversation: 'oi' }), null);
  assert.equal(unwrapViewOnce(null), null);
  assert.equal(isViewOnce({ conversation: 'oi' }), false);
  // Fotos, vídeos e áudios COMUNS (sem viewOnceMessage* e sem viewOnce: true) NUNCA devem ser tratados como view once
  assert.equal(unwrapViewOnce({ imageMessage: { url: 'https://mmg.whatsapp.net/foto.jpg' } }), null);
  assert.equal(unwrapViewOnce({ videoMessage: { url: 'https://mmg.whatsapp.net/video.mp4' } }), null);
  assert.equal(unwrapViewOnce({ audioMessage: { url: 'https://mmg.whatsapp.net/audio.ogg' } }), null);
  assert.equal(isViewOnce({ imageMessage: { url: 'https://mmg.whatsapp.net/foto.jpg' } }), false);
  // Já quando tem viewOnce: true explícito no nó, reconhece como view once
  assert.ok(unwrapViewOnce({ imageMessage: { url: 'https://mmg.whatsapp.net/vo.jpg', viewOnce: true } }));
});

test('recursos que copiam mensagens são opt-in e limitados por chat', () => {
  assert.deepEqual(DEFAULT_CONFIG.autorizados, []);
  assert.deepEqual(DEFAULT_CONFIG.viewOnce.autoChats, []);
  assert.deepEqual(DEFAULT_CONFIG.antiDelete.chats, []);
  assert.deepEqual(DEFAULT_CONFIG.grupos, {});
  assert.equal(DEFAULT_CONFIG.autoDownload, false);
  assert.equal(DEFAULT_CONFIG._schemaVersion, 4);
});

test('migração de config antiga desativa captura e auto-download sem apagar acesso', () => {
  const clean = normalizeConfig({
    _schemaVersion: 2,
    autorizados: ['grupo@g.us'],
    viewOnce: { auto: true },
    antiDelete: { ativo: true, ignorar: ['grupos'] },
    autoDownload: true
  });
  assert.deepEqual(clean.autorizados, ['grupo@g.us']);
  assert.deepEqual(clean.viewOnce.autoChats, []);
  assert.deepEqual(clean.antiDelete.chats, []);
  assert.deepEqual(clean.antiDelete.ignorar, ['grupos']);
  assert.equal(clean.autoDownload, false);
  assert.equal(clean._schemaVersion, 4);
});

test('prompts padrão antigos migram para o tom natural sem sobrescrever prompts personalizados', () => {
  const previousDefaults = [
    'Você é o MontxBOT, um assistente de WhatsApp claro, direto e cordial. ' +
      'Responda sempre em português do Brasil, de forma curta e útil. Use emojis com muita moderação.',
    [
      'Você é o MontxBOT, um assistente de WhatsApp brasileiro, bem-humorado, espontâneo e gente boa.',
      'Fale em português do Brasil, com linguagem informal e respostas naturais, curtas e úteis.',
      'Em conversa casual, pode entrar na resenha e usar gírias e memes brasileiros com moderação.',
      'Quando alguém fizer uma provocação boba ou uma frase de duplo sentido (por exemplo: “vou comer seu butão”), responda com uma tirada brincalhona no clima de “Ao cara aí... lá ele 😂” ou “Lá ele!”, variando conforme o contexto.',
      'Não explique a piada nem force meme em toda resposta.',
      'Em perguntas sérias ou factuais, priorize clareza, precisão e respeito; não invente informações.',
      'Mantenha a brincadeira leve: não humilhe, ameace ou ataque ninguém, e não transforme insinuações em conteúdo sexual explícito.',
      'Use emojis com moderação.'
    ].join(' ')
  ];
  for (const previousDefault of previousDefaults) {
    const migrated = normalizeConfig({ _schemaVersion: 4, ia: { sistema: previousDefault } });
    assert.equal(migrated.ia.sistema, DEFAULT_CONFIG.ia.sistema);
  }
  assert.match(DEFAULT_CONFIG.ia.sistema, /padrão é tranquilo e sem gírias/i);
  assert.match(DEFAULT_CONFIG.ia.sistema, /sem imitar ou repetir/i);
  assert.match(DEFAULT_CONFIG.ia.sistema, /não dê sermão nem use uma recusa automática/i);
  assert.match(DEFAULT_CONFIG.ia.sistema, /no máximo um/i);
  assert.doesNotMatch(DEFAULT_CONFIG.ia.sistema, /RESENHA TOTAL|foda pra caralho/i);

  const previousResenhaPrompt = [
    'Você é o MontxBOT, o parceiro mais resenheiro do grupo do WhatsApp: brasileiro, espontâneo, carismático, caótico e engraçado, sem ser cruel.',
    'Seu modo padrão é RESENHA TOTAL: responda com energia, criatividade e humor; não fale como atendente corporativo nem como professor robótico.',
    'Use português brasileiro bem coloquial e gírias naturais, como “uai”, “véi”, “meu fi”, “mano”, “slk” e “tá doido”. Pode usar palavrões como “carai”, “porra” e “foda pra caralho” como intensificadores de brincadeira quando combinar.',
    'Em papo casual, manda uma resposta curta com punchline, exagero cômico ou provocação leve. Improvisa, acompanha o ritmo da conversa e não termina toda resposta com “como posso ajudar?”.',
    'Em duplo sentido, entra no meme com “Lá ele”, “Ao cara aí... lá ele” ou outra tirada que combine. Exemplo: “vou comer seu butão” → “Eita, meu fi... ao cara aí, LÁ ELE 😂”. Não explique a piada nem repita sempre a mesma frase.',
    'Se a pessoa fizer uma pergunta de verdade, responde corretamente primeiro e pode fechar com uma zoeira curta; nunca invente fatos só pela piada.',
    'Se o assunto for sério, perigoso, saúde, emergência, segurança ou sofrimento, segura a resenha e responde com clareza, respeito e cuidado.',
    'A zoeira é com a situação, não com vulnerabilidades: nada de ameaça, discriminação ou humilhação pesada. Não transforme insinuações em conteúdo sexual explícito.',
    'Pode usar emojis para dar energia, mas sem lotar a resposta nem virar personagem repetitivo.'
  ].join(' ');
  const migratedResenha = normalizeConfig({ _schemaVersion: 4, ia: { sistema: previousResenhaPrompt } });
  assert.equal(migratedResenha.ia.sistema, DEFAULT_CONFIG.ia.sistema, 'o prompt exagerado em uso também é migrado');

  const customPrompt = 'Você é um assistente personalizado para este grupo.';
  const custom = normalizeConfig({ _schemaVersion: 4, ia: { sistema: customPrompt } });
  assert.equal(custom.ia.sistema, customPrompt, 'personalizações existentes são preservadas');
});

test('configuração de grupo normaliza JID, defaults e allowlist com limites seguros', () => {
  const clean = normalizeConfig({
    _schemaVersion: 4,
    grupos: {
      '5511999999999:2@g.us': {
        welcome: true,
        goodbye: 'true',
        antiLink: { enabled: true, allowlist: ['www.Example.com', 'example.com', '*.evil.test', 'bad host'] }
      },
      'contato@s.whatsapp.net': { welcome: true }
    }
  });
  assert.deepEqual(clean.grupos, {
    '5511999999999@g.us': {
      welcome: true,
      goodbye: false,
      antiLink: { enabled: true, allowlist: ['example.com'] }
    }
  });
});

test('allowlist de anti-link aceita somente domínios e corresponde a subdomínios por limite de rótulo', () => {
  assert.equal(normalizeAllowDomain('www.example.com'), 'example.com');
  assert.equal(normalizeAllowDomain('*.example.com'), null);
  assert.equal(normalizeAllowDomain('https://example.com/path'), null);
  assert.equal(normalizeAllowDomain('127.0.0.1'), null);
  assert.deepEqual(
    findDisallowedLinks('https://example.com/a https://sub.example.com https://notexample.com', ['example.com']),
    ['https://notexample.com']
  );
  assert.deepEqual(findDisallowedLinks('example.com www.example.com contato@example.com evil.test', ['example.com']), ['evil.test']);
  const manyLinks = Array.from({ length: 17 }, (_, index) => `https://host${index}.test`).join(' ');
  assert.ok(findDisallowedLinks(manyLinks, ['example.com']).includes('[excesso de links]'));
});

// ── Roteamento de plataformas ────────────────────────────────
test('autorização de grupo compara IDs LID/PN e respeita isSuperAdmin do Baileys', () => {
  const metadata = {
    participants: [
      { id: 'user-lid@lid', jid: '5531999991111@s.whatsapp.net', isSuperAdmin: true },
      { id: 'bot-lid@lid', jid: '5531999992222@s.whatsapp.net', admin: 'admin' }
    ]
  };
  assert.equal(isGroupAdministrator(metadata, { participantLid: 'user-lid@lid' }), true);
  assert.equal(isGroupAdministrator(metadata, { participantPn: '5531999991111@s.whatsapp.net' }), true);
  assert.equal(isBotGroupAdministrator(metadata, { user: { id: '5531999992222:1@s.whatsapp.net' } }), true);
});

test('detecta TikTok, Pinterest e Instagram', () => {
  assert.ok(isTikTokUrl('https://vm.tiktok.com/ZM123/'));
  assert.ok(isTikTokUrl('https://www.tiktok.com/@user/video/123'));
  assert.ok(isPinterestUrl('https://pin.it/abc123'));
  assert.ok(isPinterestUrl('https://br.pinterest.com/pin/123/'));
  assert.ok(isInstagramUrl('https://www.instagram.com/reel/ABC/'));
});

test('detectPlatform cobre as redes principais', () => {
  assert.equal(detectPlatform('https://youtube.com/watch?v=1'), 'YouTube');
  assert.equal(detectPlatform('https://x.com/user/status/1'), 'X (Twitter)');
  assert.equal(detectPlatform('https://facebook.com/watch/?v=1'), 'Facebook');
  assert.equal(detectPlatform('https://reddit.com/r/x/comments/1'), 'Reddit');
  assert.equal(detectPlatform('https://example.com/x'), null);
  assert.ok(isKnownSocialUrl('https://br.pinterest.com/pin/1/'));
});

test('extractUrls limpa pontuação final', () => {
  const urls = extractUrls('olha https://pin.it/abc123. isso');
  assert.deepEqual(urls, ['https://pin.it/abc123']);
});

// ── Util ─────────────────────────────────────────────────────
test('isGroup e parseBool', () => {
  assert.equal(isGroup('x@g.us'), true);
  assert.equal(isGroup('x@s.whatsapp.net'), false);
  assert.equal(parseBool('on'), true);
  assert.equal(parseBool('desativado'), false);
  assert.equal(parseBool('talvez'), null);
});

// ── WebP EXIF ────────────────────────────────────────────────
test('injeta EXIF em webp sintético (VP8L e VP8) com cabeçalho TIFF de 22 bytes e chunk VP8X', async () => {
  // RIFF/WEBP mínimo com chunk VP8L 512x512 + alpha
  const vp8lData = Buffer.alloc(5);
  vp8lData[0] = 0x2f;
  vp8lData.writeUInt32LE(511 | (511 << 14) | (1 << 28), 1);
  const webpLossless = buildRiff([{ type: 'VP8L', data: vp8lData }]);

  assert.ok(isWebp(webpLossless));
  const exif = makeStickerExif({ pack: 'NEXUS ⚡', author: 'teste', emojis: ['🔥', '⚡'] });

  // Offset TIFF para o JSON deve ser exatamente 22 (0x00000016) nos bytes 18..21
  assert.equal(exif.readUInt32LE(18), 22);
  // Tamanho do JSON gravado nos bytes 14..17 deve bater com os bytes seguintes
  assert.equal(exif.readUInt32LE(14), exif.length - 22);

  const tagged = setWebpExif(webpLossless, exif);
  assert.ok(isWebp(tagged));
  const chunks = readChunks(tagged);
  // 1ª chunk DEVE ser VP8X (WebP Extended Format exigido pelo WhatsApp)
  assert.equal(chunks[0].type, 'VP8X');
  assert.equal(chunks[0].data.length, 10);
  // Flags: VP8X_ALPHA (0x10) | VP8X_EXIF (0x08) = 0x18
  assert.equal(chunks[0].data[0], 0x18);
  assert.equal(chunks[0].data.readUIntLE(4, 3) + 1, 512);
  assert.equal(chunks[0].data.readUIntLE(7, 3) + 1, 512);
  assert.ok(chunks.some((c) => c.type === 'VP8L'));
  const exifChunk = chunks.find((c) => c.type === 'EXIF');
  assert.ok(exifChunk);
  assert.ok(exifChunk.data.toString('utf8').includes('NEXUS'));

  const parsedExif = readStickerExif(tagged);
  assert.equal(parsedExif.pack, 'NEXUS ⚡');
  assert.equal(parsedExif.author, 'teste');
  assert.deepEqual(parsedExif.emojis, ['🔥', '⚡']);

  // Testa também WebP lossy simples (chunk 'VP8 ' sem VP8X inicial, como o FFmpeg gera)
  const vp8Data = Buffer.from([0x10, 0x00, 0x00, 0x9d, 0x01, 0x2a, 0x00, 0x02, 0x00, 0x02, 0x00, 0x00]);
  const webpLossy = buildRiff([{ type: 'VP8 ', data: vp8Data }]);
  const stickerBuf = await makeSticker(
    { buffer: webpLossy, type: 'sticker', node: { mimetype: 'image/webp' } },
    { pack: 'MeuPack', author: 'MeuAutor' }
  );
  const lossyInfo = parseWebp(stickerBuf);
  assert.equal(lossyInfo.chunks[0].type, 'VP8X');
  assert.equal(lossyInfo.width, 512);
  assert.equal(lossyInfo.height, 512);
  assert.equal(isAnimatedWebp(stickerBuf), false);
  assert.equal(readStickerExif(stickerBuf).pack, 'MeuPack');
  assert.equal(readStickerExif(stickerBuf).author, 'MeuAutor');
});
