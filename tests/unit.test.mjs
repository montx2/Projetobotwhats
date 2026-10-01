// Testes offline das peças de lógica do NEXUS (node:test, zero deps).
import test from 'node:test';
import assert from 'node:assert/strict';

import { KeyPool } from '../src/core/keypool.js';
import { parseQuality, QUALITIES } from '../src/features/downloaders/quality.js';
import { isIgnored, normalizeIgnoreTarget } from '../src/features/antidelete.js';
import { unwrapViewOnce, isViewOnce } from '../src/features/viewonce.js';
import { detectPlatform, isKnownSocialUrl } from '../src/features/download.js';
import { isTikTokUrl } from '../src/features/downloaders/tiktok.js';
import { isPinterestUrl } from '../src/features/downloaders/pinterest.js';
import { isInstagramUrl } from '../src/features/downloaders/instagram.js';
import { extractUrls, isGroup, parseBool } from '../src/util/text.js';
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
import { DEFAULT_CONFIG } from '../src/core/config.js';

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
  }), /falharam/);
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

test('normalizeIgnoreTarget resolve "aqui" e números', () => {
  const msg = { key: { remoteJid: 'grupo@g.us' } };
  assert.equal(normalizeIgnoreTarget('aqui', msg), 'grupo@g.us');
  assert.equal(normalizeIgnoreTarget('GRUPOS', msg), 'grupos');
  assert.equal(normalizeIgnoreTarget('5511999999999', msg), '5511999999999@s.whatsapp.net');
});

test('antiDelete vem ATIVO por padrão sem filtros', () => {
  assert.equal(DEFAULT_CONFIG.antiDelete.ativo, true);
  assert.deepEqual(DEFAULT_CONFIG.antiDelete.ignorar, []);
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

test('viewOnce e modoPrivado default: exclusivo no privado do dono', () => {
  assert.equal(DEFAULT_CONFIG.modoPrivado, true);
  assert.deepEqual(DEFAULT_CONFIG.autorizados, []);
  assert.equal(DEFAULT_CONFIG.viewOnce.auto, true);
  assert.equal(DEFAULT_CONFIG.viewOnce.destinoAuto, 'dono');
  assert.equal(DEFAULT_CONFIG.viewOnce.resposta, 'dono');
  assert.equal(DEFAULT_CONFIG.antiDelete.restaurarNoChat, false);
  assert.equal(DEFAULT_CONFIG.antiDelete.avisarDono, true);
});

// ── Roteamento de plataformas ────────────────────────────────
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
