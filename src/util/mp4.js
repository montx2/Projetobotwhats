// 🎞️ Inspetor de contêiner de vídeo (ISO-BMFF/MP4) em JS puro — sem ffprobe.
//
// Por que isto existe (bug real): o Pinterest (e o HLS em geral) entrega parte
// dos vídeos em formatos que o navegador/VLC tocam, mas o WhatsApp no Android
// NÃO: MP4 fragmentado (CMAF, com `moof`), codec HEVC/AV1/VP9 dentro do MP4,
// ou arquivo sem `moov` (truncado). O bot baixava esses bytes, rotulava de
// `video/mp4` e enviava — o usuário recebia um vídeo que "não abre de jeito
// nenhum" ("há algo errado com o arquivo de vídeo").
//
// Este módulo lê só os BOXES do arquivo (cabeçalhos, nunca o miolo) e responde:
// é MP4? está fragmentado? qual o codec de vídeo/áudio? o WhatsApp reproduz?
// Com isso o download decide entre enviar direto, remuxar, transcodar ou
// tentar outra rendição — em vez de entregar arquivo quebrado em silêncio.

/** Codecs de vídeo que o WhatsApp/Android não reproduz de forma confiável em MP4. */
const UNPLAYABLE_VIDEO_CODECS = new Set(['hvc1', 'hev1', 'dvh1', 'dvhe', 'av01', 'vp08', 'vp09', 'vp10']);

/** Codecs de áudio que o WhatsApp costuma rejeitar dentro de vídeo. */
const UNPLAYABLE_AUDIO_CODECS = new Set(['ac-3', 'ec-3', 'ac-4']);

/** Boxes que contêm outros boxes e valem a descida na inspeção. */
const CONTAINER_BOXES = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'mvex']);

function boxType(buffer, offset) {
  return buffer.toString('ascii', offset + 4, offset + 8);
}

/**
 * Itera os boxes de um intervalo. Devolve [{type, start, header, size, end}].
 * Para em qualquer inconsistência (tamanho impossível, além do fim) — arquivo
 * truncado não é exceção, é só um arquivo que não dá para confiar.
 */
function readBoxes(buffer, start, end) {
  const boxes = [];
  let offset = start;
  while (offset + 8 <= end && offset + 8 <= buffer.length) {
    let size = buffer.readUInt32BE(offset);
    const type = boxType(buffer, offset);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > buffer.length) break;
      const big = buffer.readBigUInt64BE(offset + 8);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) break;
      size = Number(big);
      header = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < header || offset + size > end) break;
    boxes.push({ type, start: offset, header, size, end: offset + size });
    offset += size;
  }
  return boxes;
}

/** Primeiro tipo de entrada do `stsd` (o fourcc do codec: avc1, hvc1, mp4a…). */
function stsdCodec(buffer, box) {
  const at = box.start + box.header;
  // stsd: version/flags (4) + entry_count (4) + primeira entrada (size+type…)
  if (at + 16 > box.end || at + 16 > buffer.length) return null;
  const entrySize = buffer.readUInt32BE(at + 8);
  if (entrySize < 8) return null;
  return buffer.toString('ascii', at + 12, at + 16).trim().toLowerCase();
}

/** handler_type do `hdlr` ('vide', 'soun', 'hint'…). */
function hdlrKind(buffer, box) {
  const at = box.start + box.header;
  // hdlr: version/flags (4) + pre_defined (4) + handler_type (4)
  if (at + 12 > box.end || at + 12 > buffer.length) return null;
  return buffer.toString('ascii', at + 8, at + 12).trim().toLowerCase();
}

/**
 * Desce a árvore do `moov` coletando, por trilha, o codec declarado no `stsd`.
 * @returns {{videoCodec: string|null, audioCodec: string|null, hasVideo: boolean, fragmented: boolean}}
 */
function inspectMoov(buffer, moov) {
  let videoCodec = null;
  let audioCodec = null;
  let hasVideo = false;
  let fragmented = false;

  const walkTrak = (trak) => {
    let kind = null;
    let codec = null;
    const visit = (box, depth) => {
      if (box.type === 'hdlr') kind = hdlrKind(buffer, box) || kind;
      if (box.type === 'stsd') codec = stsdCodec(buffer, box) || codec;
      if (depth < 8 && CONTAINER_BOXES.has(box.type)) {
        for (const child of readBoxes(buffer, box.start + box.header, box.end)) visit(child, depth + 1);
      }
    };
    for (const child of readBoxes(buffer, trak.start + trak.header, trak.end)) visit(child, 1);
    // Sem `hdlr` legível, o fourcc decide: avc1/hvc1… é vídeo, mp4a é áudio.
    const isVideo = kind === 'vide' || (kind === null && codec !== null && isVideoCodec(codec));
    const isAudio = kind === 'soun' || (kind === null && codec !== null && !isVideo);
    if (isVideo) {
      hasVideo = true;
      if (codec && !videoCodec) videoCodec = codec;
    } else if (isAudio && codec && !audioCodec) {
      audioCodec = codec;
    }
  };

  for (const child of readBoxes(buffer, moov.start + moov.header, moov.end)) {
    if (child.type === 'mvex') fragmented = true;
    if (child.type === 'trak') walkTrak(child);
  }
  return { videoCodec, audioCodec, hasVideo, fragmented };
}

function isVideoCodec(codec) {
  return /^(avc|hvc|hev|dvh|dve|av0|vp0|mp4v|encv|h264)/.test(String(codec || ''));
}

/**
 * Inspeciona os bytes de um suposto vídeo.
 * @param {Buffer} buffer
 * @returns {{
 *   format: 'mp4'|'webm'|'mpegts'|'unknown',
 *   isMp4: boolean, majorBrand: string, fragmented: boolean,
 *   hasMoov: boolean, hasMdat: boolean,
 *   hasVideo: boolean, videoCodec: string|null, audioCodec: string|null,
 *   playable: boolean, problems: string[]
 * }}
 * `playable` = "o WhatsApp/Android reproduz isto como veio": MP4 progressivo
 * (não fragmentado), com `moov`, trilha de vídeo em codec suportado e áudio
 * ausente ou suportado. Codec desconhecido (stsd ilegível) NÃO reprova: é o
 * mesmo critério do TikTok — na dúvida, assume que está bom.
 */
export function inspectVideoFile(buffer) {
  const out = {
    format: 'unknown',
    isMp4: false,
    majorBrand: '',
    fragmented: false,
    hasMoov: false,
    hasMdat: false,
    hasVideo: false,
    videoCodec: null,
    audioCodec: null,
    playable: false,
    problems: []
  };
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) {
    out.problems.push('arquivo vazio ou curto demais');
    return out;
  }

  // Contêineres que nem MP4 são (chegam disfarçados de .mp4 de alguns CDNs).
  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
    out.format = 'webm';
    out.problems.push('contêiner WebM/MKV rotulado de MP4');
    return out;
  }
  if (buffer[0] === 0x47 && (buffer.length < 189 || buffer[188] === 0x47)) {
    out.format = 'mpegts';
    out.problems.push('contêiner MPEG-TS rotulado de MP4');
    return out;
  }

  const top = readBoxes(buffer, 0, buffer.length);
  const ftyp = top.find((b) => b.type === 'ftyp');
  if (!ftyp) {
    out.problems.push('sem caixa ftyp (não é MP4)');
    return out;
  }
  out.format = 'mp4';
  out.isMp4 = true;
  out.majorBrand = buffer.toString('ascii', ftyp.start + ftyp.header, ftyp.start + ftyp.header + 4).trim().toLowerCase();
  out.hasMdat = top.some((b) => b.type === 'mdat');
  out.fragmented = top.some((b) => b.type === 'moof');

  const moov = top.find((b) => b.type === 'moov');
  if (!moov) {
    out.problems.push('sem caixa moov (arquivo truncado ou só o segmento inicial)');
    return out;
  }
  out.hasMoov = true;

  const inner = inspectMoov(buffer, moov);
  out.videoCodec = inner.videoCodec;
  out.audioCodec = inner.audioCodec;
  out.hasVideo = inner.hasVideo;
  out.fragmented = out.fragmented || inner.fragmented;

  if (out.fragmented) out.problems.push('MP4 fragmentado (CMAF) — o WhatsApp não reproduz');
  if (!out.hasVideo) out.problems.push('nenhuma trilha de vídeo no MP4');
  if (out.videoCodec && UNPLAYABLE_VIDEO_CODECS.has(out.videoCodec)) {
    out.problems.push(`codec de vídeo ${out.videoCodec} sem suporte no WhatsApp`);
  }
  if (out.audioCodec && UNPLAYABLE_AUDIO_CODECS.has(out.audioCodec)) {
    out.problems.push(`codec de áudio ${out.audioCodec} sem suporte no WhatsApp`);
  }

  out.playable = out.problems.length === 0;
  return out;
}

/** O buffer já é um vídeo que o WhatsApp reproduz como veio? */
export function isWhatsAppPlayableVideo(buffer) {
  return inspectVideoFile(buffer).playable;
}

/** Codec de vídeo (fourcc do `stsd`) que o WhatsApp não reproduz em MP4? */
export function isUnplayableVideoCodec(codec) {
  return UNPLAYABLE_VIDEO_CODECS.has(String(codec || '').trim().toLowerCase());
}

/** Codec de áudio (fourcc do `stsd`) que o WhatsApp não reproduz em vídeo? */
export function isUnplayableAudioCodec(codec) {
  return UNPLAYABLE_AUDIO_CODECS.has(String(codec || '').trim().toLowerCase());
}
