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

function redact(value) {
  return String(value)
    .replace(/\b[A-Za-z0-9._-]{1,64}(?::\d+)?@(?:s\.whatsapp\.net|g\.us|lid)\b/gi, '[JID]')
    .replace(/(Bearer|Api-Key)\s+[^\s,;]+/gi, '$1 [redacted]')
    .replace(/([?&](?:api[_-]?key|key|access[_-]?token|token|secret|password)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|authorization|password|secret|token)["']?\s*[:=]\s*["']?)[^"'&,\s}]+/gi, '$1[redacted]');
}

function fmt(extra) {
  if (extra === undefined || extra === null) return '';
  if (extra instanceof Error) return ` ${redact(extra.message)}`;
  if (typeof extra === 'string') return ` ${redact(extra)}`;
  try {
    return ` ${c('gray', redact(JSON.stringify(extra)))}`;
  } catch {
    return '';
  }
}

function write(color, icon, msg, extra) {
  console.log(`${stamp()} ${c(color, icon)} ${redact(msg)}${fmt(extra)}`);
}

export const log = {
  info: (msg, extra) => write('cyan', 'ℹ', msg, extra),
  ok: (msg, extra) => write('green', '✔', msg, extra),
  warn: (msg, extra) => write('yellow', '⚠', msg, extra),
  error: (msg, extra) => write('red', '✖', msg, extra),
  cmd: (msg, extra) => write('magenta', '⌨', msg, extra),
  dl: (msg, extra) => write('blue', '⬇', msg, extra),
  ai: (msg, extra) => write('magenta', '🧠', msg, extra),
  raw: (msg) => console.log(redact(msg))
};

/**
 * Resumo de erro para log. Antes os avisos de download levavam só
 * `{ name, status, code }` e o terminal mostrava `{"name":"HttpError"}` —
 * sem o motivo, o dono ficava sem saber por que nada baixava. A mensagem vai
 * junto (cortada) e continua passando pelo redator de segredos.
 */
export function errInfo(error, limit = 160) {
  const info = { name: error?.name };
  if (error?.status !== undefined) info.status = error.status;
  if (error?.code) info.code = error.code;
  const message = String(error?.message || '').trim();
  if (message) info.message = message.length > limit ? `${message.slice(0, limit)}…` : message;
  return info;
}

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
