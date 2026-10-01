// 🎨 MENUS — separados em 2 versões:
// 1) ownerMenu(): menu COMPLETO que só aparece no privado do dono.
// 2) publicMenu(): menu para grupos/conversas liberadas com .ativar.
//    Mostra TUDO (figurinhas, downloads de qualquer rede, IA, voz…)
//    MENOS as duas funções 100% privadas: View Once e Anti-Delete,
//    que não são citadas em nenhum lugar e não respondem para terceiros.

import { cfg } from '../core/config.js';
import { PLATFORM, PLATFORM_LABEL } from '../core/platform.js';
import { hasYtDlp } from './downloaders/ytdlp.js';
import { SYM, header, section, cmd, footer, card, kv } from '../core/ui.js';

const STICKER_ITEMS = [
  ['.s', 'foto, vídeo ou GIF vira figurinha'],
  ['.s inteira', 'mantém a imagem inteira, sem esticar'],
  ['.s cortar', 'preenche o quadrado sem esticar'],
  ['.sfundo', 'figurinha sem fundo (IA)'],
  ['.fundo', 'remove o fundo e envia em PNG']
];

const DOWNLOAD_ITEMS = [
  ['.dl <link>', 'qualquer rede social'],
  ['.tiktok <link>', 'vídeo do TikTok  ·  `.ttmp3` só o áudio'],
  ['.insta <link>', 'Instagram  ·  `.pin` Pinterest'],
  ['.yt <link>', 'YouTube  ·  `.ytmp3` só o áudio'],
  ['.tw <link>', 'X/Twitter  ·  `.face` Facebook']
];

const AI_ITEMS = [
  ['.ia <pergunta>', 'conversa com a IA  ·  `.ia reset` limpa'],
  ['.criar <ideia>', 'gera uma imagem'],
  ['.voz <texto>', 'transforma texto em áudio'],
  ['.traduz <idioma> <texto>', 'tradução instantânea'],
  ['.resumo <texto>', 'resume textos longos']
];

/**
 * Menu público para chats/grupos liberados com .ativar.
 * Regra: ZERO menção a View Once e Anti-Delete. Todo o resto aparece.
 */
export function publicMenu() {
  const nome = cfg.get().nomeBot;
  return card([
    header(nome, 'central de comandos'),
    section('Figurinhas', STICKER_ITEMS),
    section('Downloads', DOWNLOAD_ITEMS, {
      note: 'TikTok, Instagram, YouTube, Pinterest, X, Facebook, Threads, Reddit e mais'
    }),
    section('Inteligência Artificial', AI_ITEMS),
    section('Utilidades', [
      ['.menu', 'este painel'],
      ['.ping', 'testa a velocidade'],
      ['.info', 'status do bot']
    ]),
    footer('Envie uma mídia com .s  ·  Cole um link e eu baixo')
  ]);
}

/** Menu completo do dono — exibido SOMENTE no privado do próprio dono. */
export function ownerMenu() {
  const nome = cfg.get().nomeBot;
  return card([
    header(nome, 'painel do dono'),
    section('Controle de chats', [
      ['.ativar', 'libera o bot neste chat ou grupo'],
      ['.desativar', 'bloqueia este chat ou grupo'],
      ['.desativar tudo', 'bloqueia todos de uma vez'],
      ['.ativos', 'lista os chats liberados']
    ]),
    section('View Once', [['.vo', 'status'], ['.vo on | off', 'captura automática']], {
      note: 'silencioso: tudo cai só no seu privado'
    }),
    section('Anti-Delete', [['.antidelete', 'status e filtros']], {
      note: 'silencioso: apagadas chegam só no seu privado'
    }),
    section('Figurinhas', STICKER_ITEMS),
    section('Downloads', [...DOWNLOAD_ITEMS, ['.menudl', 'guia completo']]),
    section('Inteligência Artificial', AI_ITEMS),
    section('Sistema', [
      ['.ping', 'velocidade'],
      ['.info', 'status geral'],
      ['.doctor', 'diagnóstico'],
      ['.config', 'ajustes']
    ]),
    footer(`${nome}  ·  feito com cuidado`)
  ]);
}

export function mainMenu({ isOwnerPrivate = true } = {}) {
  return isOwnerPrivate ? ownerMenu() : publicMenu();
}

export function downloadMenu() {
  const extra = hasYtDlp() ? `\n${SYM.on} yt-dlp local detectado (modo turbo ativo)` : '';
  return card([
    header('Downloads', 'cole o link ou use um comando'),
    section('Comandos', [
      ['.dl <link> [qualidade]', 'universal, qualquer rede'],
      ['.tiktok <link>', 'TikTok  ·  `.ttmp3` só a música'],
      ['.insta <link>', 'Instagram'],
      ['.pin <link>', 'Pinterest'],
      ['.yt <link>', 'YouTube  ·  `.ytmp3` só o áudio'],
      ['.tw <link>', 'X/Twitter'],
      ['.face <link>', 'Facebook']
    ]),
    section('Qualidade', [
      kvLine('melhor', 'padrão'),
      kvLine('alta', 'ótima e mais leve'),
      kvLine('media', 'equilibrada'),
      kvLine('baixa', 'economiza dados')
    ], { note: 'Exemplo: .tiktok <link> baixa' }),
    section('Redes atendidas', [
      'TikTok · Instagram · YouTube · Pinterest',
      'X/Twitter · Facebook · Threads · Reddit',
      'Twitch · Vimeo · Snapchat · SoundCloud e mais'
    ]),
    footer(`Modo universal cobre centenas de sites${extra ? `\n${extra.trim()}` : ''}`)
  ]);
}

function kvLine(name, desc) {
  return `\`${name}\`  ${SYM.detail}  ${desc}`;
}

export function stickerMenu() {
  return card([
    header('Figurinhas', 'crie em segundos'),
    section('Criar', STICKER_ITEMS),
    section('Modos de enquadramento', [
      kvLine('.s', 'preenche o quadrado todo'),
      kvLine('.s inteira', 'imagem completa, sem esticar'),
      kvLine('.s cortar', 'preenche sem esticar, corta as bordas')
    ]),
    footer('Envie a mídia com a legenda .s ou responda a ela com .s')
  ]);
}

export function antiDeleteMenu() {
  return card([
    header('Anti-Delete', 'proteção silenciosa'),
    `Tudo que apagarem chega só no seu privado.\n_Nenhum rastro no grupo ou chat._`,
    section('Comandos', [
      ['.antidelete', 'status'],
      ['.antidelete on | off', 'liga ou desliga'],
      ['.antidelete ignorar grupos', 'ignora todos os grupos'],
      ['.antidelete ignorar privado', 'ignora conversas privadas'],
      ['.antidelete ignorar aqui', 'ignora este chat'],
      ['.antidelete ignorar <número>', 'ignora um contato'],
      ['.antidelete remover <filtro>', 'volta a monitorar'],
      ['.antidelete lista', 'mostra os filtros']
    ])
  ]);
}

export function infoText({ uptime, cacheSize, bgRows, aiRows, poolRows, ownerName }) {
  const rows = (arr) => arr.map((r) => ` ${SYM.detail} ${r}`).join('\n');
  return card([
    header(cfg.get().nomeBot, 'status do sistema'),
    [
      section('Geral', []),
      kv('Online há', uptime),
      kv('Sistema', PLATFORM_LABEL[PLATFORM] || PLATFORM),
      kv('Mensagens em memória', cacheSize),
      kv('Dono', ownerName || 'conta própria')
    ].join('\n'),
    `${SYM.section} *REMOÇÃO DE FUNDO*\n${rows(bgRows)}`,
    `${SYM.section} *INTELIGÊNCIA ARTIFICIAL*\n${rows(aiRows)}`,
    `${SYM.section} *DOWNLOADERS*\n${rows(poolRows)}`
  ]);
}
