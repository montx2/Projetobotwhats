// 🎨 UI — identidade visual única para TODAS as mensagens do bot.
//
// Paleta de símbolos (todos suportados em Android/iOS/Web, sem "quadradinho"):
//   ◆ marca/título    ✦ seção        ▸ item/comando     › detalhe
//   ✓ sucesso         ✕ erro         ⚠ atenção          ◇ em andamento
//
// Estrutura padrão de um cartão:
//   ╭─ ◆ *Marca*
//   │  _subtítulo_
//   ╰──────────────
//   ✦ *SEÇÃO*
//    ▸ `.comando` › descrição

export const SYM = Object.freeze({
  brand: '◆',
  section: '✦',
  item: '▸',
  detail: '›',
  ok: '✓',
  err: '✕',
  warn: '⚠',
  wait: '◇',
  dot: '·',
  on: '●',
  off: '○'
});

export const LINE = '──────────────';

/** Cabeçalho de cartão: marca + subtítulo opcional. */
export function header(brand, subtitle = '') {
  const lines = [`╭─ ${SYM.brand} *${brand}*`];
  if (subtitle) lines.push(`│  _${subtitle}_`);
  lines.push(`╰${LINE}`);
  return lines.join('\n');
}

/** Seção com título em caixa alta e itens. `items` aceita strings ou [cmd, desc]. */
export function section(title, items = [], { note } = {}) {
  const out = [`${SYM.section} *${title.toUpperCase()}*`];
  for (const it of items) out.push(Array.isArray(it) ? cmd(it[0], it[1]) : ` ${SYM.item} ${it}`);
  if (note) out.push(`  _${note}_`);
  return out.join('\n');
}

/** Linha de comando: `.cmd` › descrição */
export function cmd(command, desc = '') {
  return ` ${SYM.item} \`${command}\`${desc ? `  ${SYM.detail}  ${desc}` : ''}`;
}

/** Rodapé discreto. */
export function footer(text) {
  return `${LINE}\n_${text}_`;
}

/** Monta um cartão completo a partir de blocos (ignora blocos vazios). */
export function card(blocks) {
  return blocks.filter(Boolean).join('\n\n');
}

// ── Mensagens de status ─────────────────────────────────────

/** Sucesso: ✓ *Título* + detalhe opcional. */
export function ok(title, detail = '') {
  return `${SYM.ok} *${title}*${detail ? `\n_${detail}_` : ''}`;
}

/** Erro: ✕ *Título* + motivo opcional. */
export function fail(title, detail = '') {
  return `${SYM.err} *${title}*${detail ? `\n_${detail}_` : ''}`;
}

/** Atenção: ⚠ *Título* + detalhe opcional. */
export function warn(title, detail = '') {
  return `${SYM.warn} *${title}*${detail ? `\n_${detail}_` : ''}`;
}

/** Em andamento: ◇ texto… */
export function wait(text) {
  return `${SYM.wait} ${text.replace(/[….]+$/, '')}…`;
}

/** Como usar um comando, com exemplo. */
export function usage(command, example, desc = '') {
  return [
    `${SYM.item} *Como usar*`,
    desc ? `  ${desc}` : '',
    `  \`${command}\``,
    example ? `  _Exemplo:_ \`${example}\`` : ''
  ]
    .filter(Boolean)
    .join('\n');
}

/** Par "rótulo › valor" para listas de status. */
export function kv(label, value) {
  return ` ${SYM.detail} ${label}: *${value}*`;
}

/** Indicador ligado/desligado. */
export function toggle(on, onText = 'ativo', offText = 'desativado') {
  return on ? `${SYM.on} ${onText}` : `${SYM.off} ${offText}`;
}
