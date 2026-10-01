// 🎚️ Filtro de qualidade dos downloads.
// Padrão: SEMPRE a melhor disponível. Só reduz se o usuário pedir.

export const QUALITIES = ['melhor', 'alta', 'media', 'baixa'];

const ALIASES = {
  melhor: 'melhor', max: 'melhor', ultra: 'melhor', hd: 'melhor', '4k': 'melhor', '1080': 'melhor', otima: 'melhor', 'ótima': 'melhor', top: 'melhor', original: 'melhor',
  alta: 'alta', high: 'alta', boa: 'alta',
  media: 'media', 'média': 'media', medium: 'media', md: 'media', '720': 'media', normal: 'media',
  baixa: 'baixa', low: 'baixa', sd: 'baixa', '480': 'baixa', '360': 'baixa', leve: 'baixa', ruim: 'baixa', compacta: 'baixa'
};

/** Extrai o token de qualidade de uma lista de argumentos. Retorna {quality, rest}. */
export function parseQuality(args, fallback = 'melhor') {
  const rest = [];
  let quality = null;
  for (const arg of args || []) {
    const key = String(arg).toLowerCase().replace(/[?!]/g, '');
    if (!quality && ALIASES[key]) {
      quality = ALIASES[key];
    } else {
      rest.push(arg);
    }
  }
  return { quality: quality || fallback, rest };
}

export function qualityLabel(q) {
  return { melhor: '👑 MELHOR', alta: '🔥 Alta', media: '👌 Média', baixa: '🪶 Baixa' }[q] || q;
}
