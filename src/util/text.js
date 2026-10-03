// Formatação de mensagens: cards, datas, bytes, nomes.

export function card(title, rows, { body = '' } = {}) {
  const lines = [title, ''];
  for (const r of rows) lines.push(r);
  if (body) lines.push('', body);
  return lines.join('\n');
}

export function formatDate(ts) {
  return new Date(ts).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

export function truncate(text, max = 1500) {
  const s = String(text || '');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export function normalizeJid(jid) {
  return String(jid || '').toLowerCase().replace(/:\d+@/, '@').trim();
}

export function isGroup(jid) {
  return normalizeJid(jid).endsWith('@g.us');
}

export function chatLabel(jid) {
  if (!jid) return '?';
  if (isGroup(jid)) return 'grupo';
  if (jid.endsWith('@newsletter')) return 'canal';
  return 'privado';
}

export function numberOnly(jid) {
  return String(jid || '')
    .split('@')[0]
    .split(':')[0];
}

export function prettyJid(jid) {
  const n = numberOnly(jid);
  return n ? `+${n}` : jid;
}

export function uptimeText(startMs) {
  const s = Math.floor((Date.now() - startMs) / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}

export function extractUrls(text) {
  const matches = String(text || '').match(/https?:\/\/[^\s<>")\]]+/gi);
  return matches ? [...new Set(matches.map((u) => u.replace(/[.,;!?]+$/, '')))] : [];
}

export function parseBool(value) {
  const s = String(value ?? '').trim().toLowerCase();
  if (['on', 'true', '1', 'sim', 'ativo', 'ativado', 'yes'].includes(s)) return true;
  if (['off', 'false', '0', 'nao', 'não', 'desativado', 'no'].includes(s)) return false;
  return null;
}

/**
 * Fatia um texto em pedaços curtos respeitando a pontuação.
 * Usado pela voz (Google TTS limita ~200 caracteres, Edge aceita pedaços
 * maiores) — a pontuação entra junto para a fala não sair picada.
 * @param {string} text texto original
 * @param {number} max tamanho máximo de cada pedaço
 * @returns {string[]}
 */
export function splitForTts(text, max = 190) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const parts = [];
  let buf = '';
  for (const piece of clean.split(/(?<=[.!?,;:])\s+/)) {
    let chunk = piece;
    while (chunk.length > max) {
      const cut = chunk.lastIndexOf(' ', max);
      const at = cut > max * 0.5 ? cut : max;
      if (buf) { parts.push(buf.trim()); buf = ''; }
      parts.push(chunk.slice(0, at).trim());
      chunk = chunk.slice(at).trim();
    }
    if ((buf + ' ' + chunk).trim().length > max) {
      if (buf) parts.push(buf.trim());
      buf = chunk;
    } else {
      buf = (buf ? `${buf} ` : '') + chunk;
    }
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts.filter(Boolean);
}
