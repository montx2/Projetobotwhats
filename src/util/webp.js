// Utilitários WebP em JavaScript puro (zero dependências externas).
// O WhatsApp exige que figurinhas com metadados (pack/autor/emojis) estejam
// no formato WebP Extended (chunk VP8X no início + chunk EXIF no final,
// seguindo a especificação do libwebpmux / node-webpmux).

import crypto from 'node:crypto';

const VP8X_ICCP = 0x20;
const VP8X_ALPHA = 0x10;
const VP8X_EXIF = 0x08;
const VP8X_XMP = 0x04;
const VP8X_ANIM = 0x02;

// Cabeçalho TIFF/EXIF de 22 bytes (0x16) esperado pelo WhatsApp:
//   0..3   : "II" (little-endian) + 0x002A (TIFF magic)
//   4..7   : 0x00000008 (offset para o 1º IFD)
//   8..9   : 0x0001 (1 entrada no IFD)
//   10..11 : 0x5741 (tag "WA" em little-endian: 0x41, 0x57)
//   12..13 : 0x0007 (tipo UNDEFINED)
//   14..17 : tamanho do JSON em bytes (UInt32LE)
//   18..21 : 0x00000016 (offset 22, onde começa o JSON)
const EXIF_HEAD = Buffer.from([
  0x49, 0x49, 0x2a, 0x00,
  0x08, 0x00, 0x00, 0x00,
  0x01, 0x00,
  0x41, 0x57,
  0x07, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x16, 0x00, 0x00, 0x00
]);

export function isWebp(buf) {
  return (
    Buffer.isBuffer(buf) &&
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  );
}

export function readChunks(buf) {
  if (!isWebp(buf)) throw new Error('arquivo não é um WebP válido');
  const chunks = [];
  let off = 12;
  const riffEnd = 8 + buf.readUInt32LE(4);
  const end = riffEnd >= 12 && riffEnd <= buf.length ? riffEnd : buf.length;
  while (off + 8 <= end) {
    const type = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const dataStart = off + 8;
    if (dataStart + size > buf.length) throw new Error(`chunk ${type} truncada`);
    chunks.push({ type, data: buf.subarray(dataStart, dataStart + size) });
    off = dataStart + size + (size & 1);
  }
  return chunks;
}

export function buildRiff(chunks) {
  const parts = [Buffer.from('WEBP', 'ascii')];
  for (const c of chunks) {
    const head = Buffer.alloc(8);
    head.write(c.type, 0, 'ascii');
    head.writeUInt32LE(c.data.length, 4);
    parts.push(head, c.data);
    if (c.data.length & 1) parts.push(Buffer.alloc(1));
  }
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

function scanAnmfAlpha(anmfData) {
  let off = 16;
  while (off + 8 <= anmfData.length) {
    const type = anmfData.toString('ascii', off, off + 4);
    const size = anmfData.readUInt32LE(off + 4);
    const dataStart = off + 8;
    if (dataStart + size > anmfData.length) break;
    if (type === 'ALPH') return true;
    if (type === 'VP8L' && size >= 5 && anmfData[dataStart] === 0x2f) {
      const bits = anmfData.readUInt32LE(dataStart + 1);
      if ((bits >>> 28) & 1) return true;
    }
    off = dataStart + size + (size & 1);
  }
  return false;
}

/**
 * Extrai dimensões e flags do WebP a partir de VP8X, VP8, VP8L ou ANMF.
 */
export function parseWebp(buf) {
  const chunks = readChunks(buf);
  let width = 0;
  let height = 0;
  let hasAlpha = false;
  let animated = false;

  const vp8x = chunks.find((c) => c.type === 'VP8X');
  if (vp8x && vp8x.data.length >= 10) {
    width = vp8x.data.readUIntLE(4, 3) + 1;
    height = vp8x.data.readUIntLE(7, 3) + 1;
    hasAlpha = !!(vp8x.data[0] & VP8X_ALPHA);
    animated = !!(vp8x.data[0] & VP8X_ANIM);
  }

  for (const c of chunks) {
    if (c.type === 'ALPH') hasAlpha = true;
    if (c.type === 'ANIM' || c.type === 'ANMF') animated = true;
    if (c.type === 'VP8 ' && c.data.length >= 10) {
      const w = c.data.readUInt16LE(6) & 0x3fff;
      const h = c.data.readUInt16LE(8) & 0x3fff;
      if (!width && w) width = w;
      if (!height && h) height = h;
    } else if (c.type === 'VP8L' && c.data.length >= 5 && c.data[0] === 0x2f) {
      const bits = c.data.readUInt32LE(1);
      const w = (bits & 0x3fff) + 1;
      const h = ((bits >>> 14) & 0x3fff) + 1;
      if (!width && w) width = w;
      if (!height && h) height = h;
      if ((bits >>> 28) & 1) hasAlpha = true;
    } else if (c.type === 'ANMF' && c.data.length >= 16) {
      const w = c.data.readUIntLE(6, 3) + 1;
      const h = c.data.readUIntLE(9, 3) + 1;
      if (!width && w) width = w;
      if (!height && h) height = h;
      if (!hasAlpha && scanAnmfAlpha(c.data)) hasAlpha = true;
    }
  }

  const exif = chunks.find((c) => c.type === 'EXIF')?.data || null;
  return {
    chunks,
    exif,
    width: width || 512,
    height: height || 512,
    hasAlpha,
    animated
  };
}

export function isAnimatedWebp(buf) {
  try {
    if (!isWebp(buf)) return false;
    return parseWebp(buf).animated;
  } catch {
    return false;
  }
}

export function packId(pack = '', author = '') {
  return crypto.createHash('sha1').update(`${pack}\u0000${author}`).digest('hex').slice(0, 32);
}

/** Monta o payload EXIF de figurinha (pack/autor/id) compatível com WhatsApp. */
export function makeStickerExif({ pack = '', author = '', emojis = [], id = '' } = {}) {
  const cleanEmojis = Array.isArray(emojis) && emojis.filter(Boolean).length ? emojis.filter(Boolean) : ['🔥'];
  const json = JSON.stringify({
    'sticker-pack-id': id || packId(pack, author),
    'sticker-pack-name': String(pack ?? ''),
    'sticker-pack-publisher': String(author ?? ''),
    emojis: cleanEmojis,
    'android-app-store-link': '',
    'ios-app-store-link': ''
  });
  const jsonBuf = Buffer.from(json, 'utf8');
  const exif = Buffer.concat([EXIF_HEAD, jsonBuf]);
  exif.writeUInt32LE(jsonBuf.length, 14);
  return exif;
}

/** Lê os metadados EXIF de uma figurinha WebP. */
export function readStickerExif(buf) {
  try {
    const exif = isWebp(buf) ? parseWebp(buf).exif : buf;
    if (!exif || exif.length < 22) return null;
    const text = exif.subarray(22).toString('utf8');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end < start) return null;
    const parsed = JSON.parse(text.slice(start, end + 1));
    return {
      id: parsed['sticker-pack-id'] || '',
      pack: parsed['sticker-pack-name'] || '',
      author: parsed['sticker-pack-publisher'] || '',
      emojis: Array.isArray(parsed.emojis) ? parsed.emojis : []
    };
  } catch {
    return null;
  }
}

/**
 * Injeta/substitui a chunk EXIF de um WebP, convertendo para Extended Format
 * (criando chunk VP8X no início quando ausente) exatamente como o node-webpmux.
 */
export function setWebpExif(buf, exif) {
  const info = parseWebp(buf);
  const rest = info.chunks.filter((c) => c.type !== 'VP8X' && c.type !== 'EXIF');
  const hasICCP = rest.some((c) => c.type === 'ICCP');
  const hasXMP = rest.some((c) => c.type === 'XMP ');
  const hasEXIF = Boolean(exif && exif.length);

  const vp8xData = Buffer.alloc(10);
  vp8xData[0] =
    (hasICCP ? VP8X_ICCP : 0) |
    (info.hasAlpha ? VP8X_ALPHA : 0) |
    (hasEXIF ? VP8X_EXIF : 0) |
    (hasXMP ? VP8X_XMP : 0) |
    (info.animated ? VP8X_ANIM : 0);
  vp8xData.writeUIntLE(Math.max(1, Math.min(16777216, info.width)) - 1, 4, 3);
  vp8xData.writeUIntLE(Math.max(1, Math.min(16777216, info.height)) - 1, 7, 3);

  const knownTypes = new Set(['ICCP', 'ANIM', 'ANMF', 'ALPH', 'VP8 ', 'VP8L', 'XMP ']);
  const ordered = [
    { type: 'VP8X', data: vp8xData },
    ...rest.filter((c) => c.type === 'ICCP'),
    ...rest.filter((c) => c.type === 'ANIM' || c.type === 'ANMF'),
    ...rest.filter((c) => c.type === 'ALPH' || c.type === 'VP8 ' || c.type === 'VP8L'),
    ...rest.filter((c) => !knownTypes.has(c.type)),
    ...(hasEXIF ? [{ type: 'EXIF', data: exif }] : []),
    ...rest.filter((c) => c.type === 'XMP ')
  ];
  return buildRiff(ordered);
}

/** Aplica pack/autor em um webp já pronto. */
export function tagSticker(webp, { pack, author, emojis, id } = {}) {
  return setWebpExif(webp, makeStickerExif({ pack, author, emojis, id }));
}
