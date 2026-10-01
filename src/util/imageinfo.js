// 🔎 Cabeçalhos de imagem em JavaScript puro (zero dependências).
//
// Serve para responder à pergunta que evita figurinha errada: "esse buffer é
// mesmo uma imagem, e de que tamanho?". O extrator pode mentir (devolver um
// XML de erro do CDN, uma página HTML ou um asset de marca da rede social); os
// primeiros bytes, não.
//
// Nada aqui decodifica pixels — só lê os cabeçalhos (PNG/JPEG/GIF/WebP/BMP).
// A análise de conteúdo (imagem "lisa"/gradiente, típica de asset de marca) fica
// em ffmpeg.js, porque exige decodificar de verdade.

/** Assinatura ISO-BMFF (mp4/mov/heic/avif): bytes 4..8 == "ftyp". */
export function isIsoBmff(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp';
}

/** Marca do container ISO-BMFF (ex.: 'isom', 'mp42', 'avif', 'heic'). */
export function isoBmffBrand(buf) {
  return isIsoBmff(buf) ? buf.toString('ascii', 8, 12).trim().toLowerCase() : '';
}

function isPng(buf) {
  return buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
}

function isJpeg(buf) {
  return buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

function isGif(buf) {
  return buf.length >= 10 && buf.toString('ascii', 0, 4) === 'GIF8';
}

function isWebp(buf) {
  return (
    buf.length >= 16 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  );
}

function isBmp(buf) {
  return buf.length >= 26 && buf.toString('ascii', 0, 2) === 'BM';
}

/** PNG: largura/altura no IHDR (offsets 16 e 20, big-endian). */
function pngSize(buf) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** GIF: largura/altura no Logical Screen Descriptor (offsets 6 e 8, LE). */
function gifSize(buf) {
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

/** BMP: largura/altura no DIB header (offset 18/22, LE, altura pode ser negativa). */
function bmpSize(buf) {
  return { width: Math.abs(buf.readInt32LE(18)), height: Math.abs(buf.readInt32LE(22)) };
}

/**
 * WebP: VP8X (canvas estendido), VP8L (lossless) ou VP8 (lossy).
 * Varre as chunks porque a ordem não é fixa.
 */
function webpSize(buf) {
  let off = 12;
  const end = Math.min(buf.length, 8 + buf.readUInt32LE(4));
  while (off + 8 <= end) {
    const type = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const data = off + 8;
    if (data + size > buf.length) break;
    if (type === 'VP8X' && size >= 10) {
      return {
        width: buf.readUIntLE(data + 4, 3) + 1,
        height: buf.readUIntLE(data + 7, 3) + 1
      };
    }
    if (type === 'VP8L' && size >= 5 && buf[data] === 0x2f) {
      const bits = buf.readUInt32LE(data + 1);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (type === 'VP8 ' && size >= 10) {
      return { width: buf.readUInt16LE(data + 6) & 0x3fff, height: buf.readUInt16LE(data + 8) & 0x3fff };
    }
    off = data + size + (size & 1);
  }
  return { width: 0, height: 0 };
}

/**
 * JPEG: caminha pelos segmentos até achar um SOF (início de quadro) com as
 * dimensões. Ignora APPn/COM/DHT/DQT etc.
 */
function jpegSize(buf) {
  let off = 2;
  while (off + 9 < buf.length) {
    if (buf[off] !== 0xff) {
      off++;
      continue;
    }
    const marker = buf[off + 1];
    if (marker === 0xff) {
      off++;
      continue;
    }
    // Marcadores sem payload
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
      off += 2;
      continue;
    }
    const len = buf.readUInt16BE(off + 2);
    if (len < 2) break;
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isSof) {
      return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
    }
    off += 2 + len;
  }
  return { width: 0, height: 0 };
}

/**
 * Identifica o formato e as dimensões reais de um buffer de imagem.
 * @param {Buffer} buf
 * @returns {{format: string, width: number, height: number, animated: boolean}|null}
 *   null quando não é imagem (HTML, XML do CDN, JSON, áudio, vídeo…).
 */
export function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 10) return null;
  if (isPng(buf)) {
    const { width, height } = pngSize(buf);
    if (!width || !height) return null;
    return { format: 'png', width, height, animated: false };
  }
  if (isJpeg(buf)) {
    const { width, height } = jpegSize(buf);
    if (!width || !height) return null;
    return { format: 'jpeg', width, height, animated: false };
  }
  if (isGif(buf)) {
    const { width, height } = gifSize(buf);
    if (!width || !height) return null;
    return { format: 'gif', width, height, animated: true };
  }
  if (isWebp(buf)) {
    const { width, height } = webpSize(buf);
    if (!width || !height) return null;
    const animated = /ANIM|ANMF/.test(buf.toString('ascii', 12, Math.min(buf.length, 64)));
    return { format: 'webp', width, height, animated };
  }
  if (isBmp(buf)) {
    const { width, height } = bmpSize(buf);
    if (!width || !height) return null;
    return { format: 'bmp', width, height, animated: false };
  }
  const brand = isoBmffBrand(buf);
  if (brand.startsWith('avif') || brand.startsWith('heic') || brand.startsWith('heix') || brand.startsWith('mif1')) {
    return { format: brand.startsWith('avif') ? 'avif' : 'heic', width: 0, height: 0, animated: false };
  }
  return null;
}

/** É imagem de verdade? (e, quando o cabeçalho traz, com as dimensões) */
export function isRealImage(buf) {
  return sniffImage(buf) !== null;
}

/** É imagem grande o bastante para virar figurinha de 512×512 sem borrar tudo? */
export function isUsableImageSize(info, { min = 64 } = {}) {
  if (!info) return false;
  if (!info.width || !info.height) return true; // formato sem cabeçalho lido (avif/heic): não julga
  return info.width >= min && info.height >= min;
}

/**
 * Avalia uma amostra crua RGB (ex.: 32×32 vinda do ffmpeg) e diz se ela tem
 * "cara de foto" ou de asset sintético (gradiente/chapado de marca).
 *
 * Por que existe: quando o Pinterest não entrega o pin, ele manda a página de
 * login/preview — e o asset mais comum ali é um **gradiente colorido da própria
 * Pinterest**. Isso passava por "imagem válida" e virava figurinha colorida sem
 * sentido nenhum. Medir o conteúdo é a única forma de barrar isso sem depender
 * do que o extrator diz.
 *
 * @param {Buffer|Uint8Array} rgb amostras RGB entrelaçadas (width*height*3)
 * @param {{width: number, height: number}} opts
 * @returns {{width,height,distinct:number,edge:number,stddev:number[],linearity:number[],
 *            smooth:boolean,solid:boolean,verdict:'detail'|'smooth'|'solid'}|null}
 */
export function gradeImageSamples(rgb, { width, height } = {}) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  if (!rgb || !w || !h || rgb.length < w * h * 3) return null;
  const n = w * h;
  const channels = [[], [], []];
  const buckets = new Set();

  for (let i = 0; i < n; i++) {
    const r = rgb[i * 3];
    const g = rgb[i * 3 + 1];
    const b = rgb[i * 3 + 2];
    channels[0].push(r);
    channels[1].push(g);
    channels[2].push(b);
    // Quantização de 5 bits por canal: cor "distinta" em termos visuais.
    buckets.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
  }

  // Energia de borda: diferença média entre pixels vizinhos (estrutura local).
  let edgeSum = 0;
  let edgeCount = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      if (x + 1 < w) {
        const r = (y * w + x + 1) * 3;
        edgeSum += Math.abs(rgb[i] - rgb[r]) + Math.abs(rgb[i + 1] - rgb[r + 1]) + Math.abs(rgb[i + 2] - rgb[r + 2]);
        edgeCount += 3;
      }
      if (y + 1 < h) {
        const d = ((y + 1) * w + x) * 3;
        edgeSum += Math.abs(rgb[i] - rgb[d]) + Math.abs(rgb[i + 1] - rgb[d + 1]) + Math.abs(rgb[i + 2] - rgb[d + 2]);
        edgeCount += 3;
      }
    }
  }
  const edge = edgeCount ? edgeSum / edgeCount / 255 : 1;

  // Linearidade: um gradiente "puro" é praticamente um plano v = a + b·x + c·y.
  const stddev = [];
  const linearity = [];
  for (const values of channels) {
    const mean = values.reduce((a, v) => a + v, 0) / n;
    const sd = Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / n);
    stddev.push(sd);
    if (sd < 1.5) {
      linearity.push(1); // cor praticamente chapada também "cabe" num plano
      continue;
    }
    const { a, b, c } = fitPlane(values, w, h);
    let residual = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const fit = a + b * (x / (w - 1 || 1)) + c * (y / (h - 1 || 1));
        residual += (values[y * w + x] - fit) ** 2;
      }
    }
    const rms = Math.sqrt(residual / n);
    linearity.push(Math.max(0, Math.min(1, 1 - rms / sd)));
  }

  const distinct = buckets.size;
  const linearityMin = Math.min(...linearity);
  const stddevMax = Math.max(...stddev);
  const solid = stddevMax < 3;
  // Gradiente/chapado: quase nenhuma estrutura local + encaixe perfeito num plano.
  const smooth = !solid && edge < 0.012 && linearityMin > 0.75;

  return {
    width: w,
    height: h,
    distinct,
    edge,
    stddev,
    linearity,
    smooth,
    solid,
    verdict: solid ? 'solid' : smooth ? 'smooth' : 'detail'
  };
}

/** Ajuste de plano por mínimos quadrados (equações normais 3×3). */
function fitPlane(values, w, h) {
  const xs = w - 1 || 1;
  const ys = h - 1 || 1;
  let s1 = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  let sv = 0;
  let sxv = 0;
  let syv = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = x / xs;
      const t = y / ys;
      const v = values[y * w + x];
      s1 += 1;
      sx += u;
      sy += t;
      sxx += u * u;
      sxy += u * t;
      syy += t * t;
      sv += v;
      sxv += u * v;
      syv += t * v;
    }
  }
  const det = s1 * (sxx * syy - sxy * sxy) - sx * (sx * syy - sxy * sy) + sy * (sx * sxy - sxx * sy);
  if (!det) return { a: sv / s1, b: 0, c: 0 };
  const detA = sv * (sxx * syy - sxy * sxy) - sx * (sxv * syy - sxy * syv) + sy * (sxv * sxy - sxx * syv);
  const detB = s1 * (sxv * syy - sxy * syv) - sv * (sx * syy - sxy * sy) + sy * (sx * syv - sxv * sy);
  const detC = s1 * (sxx * syv - sxv * sxy) - sx * (sx * syv - sxv * sy) + sv * (sx * sxy - sxx * sy);
  return { a: detA / det, b: detB / det, c: detC / det };
}

/**
 * Buffer que é claramente um erro de servidor (XML do S3/CDN, HTML, JSON).
 * O caso clássico: pinimg responde `AccessDenied` quando o arquivo não existe.
 */
export function looksLikeServerError(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return false;
  if (isRealImage(buf)) return false;
  const head = buf.subarray(0, 300).toString('utf8').trimStart().toLowerCase();
  return (
    head.startsWith('<?xml') ||
    head.startsWith('<error') ||
    head.startsWith('<!doctype html') ||
    head.startsWith('<html') ||
    head.startsWith('{"') ||
    head.startsWith('{"error')
  );
}
