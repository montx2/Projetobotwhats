// Logger de console bonito e leve (zero dependências).

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m'
};

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (color, text) => (useColor ? `${COLORS[color]}${text}${COLORS.reset}` : text);

function stamp() {
  return c('gray', new Date().toLocaleTimeString('pt-BR', { hour12: false }));
}

function fmt(extra) {
  if (extra === undefined || extra === null) return '';
  if (typeof extra === 'string') return ` ${extra}`;
  if (extra instanceof Error) return ` ${extra.message}`;
  try {
    return ` ${c('gray', JSON.stringify(extra))}`;
  } catch {
    return '';
  }
}

export const log = {
  info: (msg, extra) => console.log(`${stamp()} ${c('cyan', 'ℹ')} ${msg}${fmt(extra)}`),
  ok: (msg, extra) => console.log(`${stamp()} ${c('green', '✔')} ${msg}${fmt(extra)}`),
  warn: (msg, extra) => console.log(`${stamp()} ${c('yellow', '⚠')} ${msg}${fmt(extra)}`),
  error: (msg, extra) => console.log(`${stamp()} ${c('red', '✖')} ${msg}${fmt(extra)}`),
  cmd: (msg, extra) => console.log(`${stamp()} ${c('magenta', '⌨')} ${msg}${fmt(extra)}`),
  dl: (msg, extra) => console.log(`${stamp()} ${c('blue', '⬇')} ${msg}${fmt(extra)}`),
  ai: (msg, extra) => console.log(`${stamp()} ${c('magenta', '🧠')} ${msg}${fmt(extra)}`),
  raw: (msg) => console.log(msg)
};

export function banner(lines) {
  // Só borda esquerda: sem borda direita nada desalinha quando há símbolos largos.
  const rule = '─'.repeat(44);
  console.log(c('cyan', '╭' + rule));
  for (const line of lines) console.log(c('cyan', '│ ') + line);
  console.log(c('cyan', '╰' + rule));
}

function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Logger silencioso compatível com pino — para entregar ao Baileys sem
 * despejar logs internos no terminal (o NEXUS loga o que importa).
 */
export const baileysLogger = (() => {
  const noop = () => {};
  const self = {
    level: 'silent',
    child: () => self,
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop
  };
  return self;
})();
