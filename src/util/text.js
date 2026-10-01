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

export function isGroup(jid) {
  return String(jid || '').endsWith('@g.us');
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
