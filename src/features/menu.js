// 🎨 MENUS — separados em 2 versões:
// 1) ownerMenu(): menu COMPLETO que só aparece no privado do dono.
// 2) publicMenu(): menu para grupos/conversas liberadas com .ativar.
//    Mostra comandos públicos e ferramentas de grupo (estas, só para admins)
//    MENOS View Once e Anti-Delete, que são 100% privados e não aparecem para terceiros.

import { cfg } from '../core/config.js';
import { PLATFORM, PLATFORM_LABEL } from '../core/platform.js';
import { hasYtDlp } from './downloaders/ytdlp.js';
import { SYM, header, section, cmd, footer, card, kv } from '../core/ui.js';
import { VOICE_CATEGORIES, voiceCatalogLines } from './voices.js';

const STICKER_ITEMS = [
  ['.s', 'foto, vídeo ou GIF vira figurinha'],
  ['.s <link>', 'baixa o link e já monta a figurinha'],
  ['.s inteira', 'mantém a imagem inteira, sem esticar'],
  ['.s cortar', 'preenche o quadrado sem esticar'],
  ['.sfundo', 'figurinha sem fundo (IA) — funciona com link também'],
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
  ['.ia <pergunta>', 'conversa natural; entra na resenha se o contexto pedir · `.ia reset` limpa'],
  ['.ia clima <cidade>', 'responde usando dados atuais do clima'],
  ['.ia cotacao <valor> <origem> <destino>', 'conversão com taxa de referência'],
  ['.ia feriados [ano] [país]', 'consulta feriados nacionais'],
  ['.criar <ideia>', 'gera imagem (prompt otimizado) · `.menucriar` para os atalhos'],
  ['.voz [voz] <texto>', 'texto em áudio · vozes de personagem'],
  ['.vozes', 'lista as vozes (bob, lula, narrador…) · `.vozes bob` ouve'],
  ['.vozpadrao <voz>', 'fixa a voz só neste chat'],
  ['.traduz <idioma> <texto>', 'tradução instantânea'],
  ['.resumo <texto>', 'resume textos longos']
];

const GAME_ITEMS = [
  ['.jogos', 'abre o catálogo completo'],
  ['.velha [facil|medio|dificil]', 'contra o bot · PvP com @oponente ou .velha aberto'],
  ['.termo / .forca', 'palavras em português · use dica para uma pista'],
  ['.minado', 'campo minado 5×5 · coordenadas A1–E5 · flag A1'],
  ['.anagrama / .quiz', 'palavras embaralhadas e perguntas rápidas'],
  ['.adivinhe / .ppt', 'número secreto ou Jokenpô'],
  ['.roletarussa [balas 1-5]', 'roleta russa solo · puxar ou parar · @oponente para duelar'],
  ['.dado [NdM] / .moeda / .roleta', 'rolagens rápidas'],
  ['.placar', 'ranking deste chat · .placar reset (admin/dono)'],
  ['.encerrar', 'finaliza a partida ativa neste chat']
];

/**
 * Menu público para chats/grupos liberados com .ativar.
 * Nunca menciona View Once/Anti-Delete; comandos de administração de grupo são validados no roteador.
 * Fora de um grupo, as ferramentas de grupo (boas-vindas, anti-link, enquete) ficam de fora —
 * elas só fazem sentido dentro de um grupo.
 */
export function publicMenu({ isGroup = true } = {}) {
  const nome = cfg.get().nomeBot;
  const utilidades = [
    ['.clima <cidade>', 'clima atual e resumo de hoje'],
    ['.cotacao <valor> <origem> <destino>', 'conversão de moedas'],
    ['.feriados [ano] [país]', 'próximos feriados nacionais · padrão BR'],
    ['.menu', 'este painel'],
    ['.ping', 'testa a velocidade']
  ];
  if (isGroup) utilidades.push(['.enquete pergunta | opção 1 | opção 2', 'cria enquete com IA (texto livre ou |)']);

  const blocos = [
    header(nome, isGroup ? 'central de comandos' : 'central de comandos · conversa privada'),
    section('Figurinhas', STICKER_ITEMS),
    section('Downloads', DOWNLOAD_ITEMS, {
      note: 'TikTok, Instagram, YouTube, Pinterest, X, Facebook, Threads, Reddit e mais'
    }),
    section('Inteligência Artificial', AI_ITEMS),
    section('Jogos & arcade', GAME_ITEMS),
    section('Utilidades', utilidades)
  ];

  if (isGroup) {
    blocos.push(section('Gestão do grupo', [
      ['.boasvindas on | off', 'mensagem automática ao entrar'],
      ['.boasvindas saida on | off', 'mensagem quando alguém sai'],
      ['.antilink on | off', 'proteção de links'],
      ['.antilink permitir <domínio>', 'libera um domínio e subdomínios']
    ], { note: 'Alterações por admin do grupo ou dono do bot; anti-link exige o bot como administrador.' }));
  } else {
    blocos.push('_Boas-vindas, anti-link e enquete são ferramentas de grupo: use-as dentro de um grupo liberado com `.ativar`._');
  }

  blocos.push(footer('Envie uma mídia com .s  ·  Mande .s <link> e eu já monto a figurinha'));
  return card(blocos);
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
    section('Grupo (use dentro do grupo)', [
      ['.enquete pergunta | opção 1 | opção 2', 'cria enquete com IA (texto livre ou |)'],
      ['.boasvindas on | off', 'entrada de novos membros'],
      ['.boasvindas saida on | off', 'mensagem quando alguém sai'],
      ['.antilink on | off', 'remove links fora da lista permitida'],
      ['.antilink permitir <domínio>', 'libera um domínio e subdomínios']
    ], { note: 'Boas-vindas e anti-link vêm desligados; alterações por admin do grupo ou dono do bot.' }),
    section('View Once', [['.vo', 'status'], ['.vo on | off', 'automação opt-in por chat']], {
      note: 'mídias capturadas são enviadas somente ao privado do dono'
    }),
    section('Anti-Delete', [['.antidelete', 'status e filtros']], {
      note: 'retenção opt-in; mensagens recuperáveis vão somente ao privado do dono'
    }),
    section('Figurinhas', STICKER_ITEMS),
    section('Downloads', [...DOWNLOAD_ITEMS, ['.menudl', 'guia completo']]),
    section('Inteligência Artificial', AI_ITEMS),
    section('Jogos & arcade', GAME_ITEMS),
    section('Utilidades', [
      ['.clima <cidade>', 'clima atual e resumo de hoje'],
      ['.cotacao <valor> <origem> <destino>', 'conversão de moedas'],
      ['.feriados [ano] [país]', 'próximos feriados nacionais · padrão BR']
    ]),
    section('Sistema', [
      ['.ping', 'velocidade'],
      ['.info', 'status geral'],
      ['.doctor', 'diagnóstico'],
      ['.config', 'ajustes']
    ]),
    footer(`${nome}  ·  feito com cuidado`)
  ]);
}

export function mainMenu({ isOwnerPrivate = true, isGroup = true } = {}) {
  return isOwnerPrivate ? ownerMenu() : publicMenu({ isGroup });
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
    section('Figurinha direto do link', [
      kvLine('.s <link>', 'baixa o link e já monta a figurinha'),
      kvLine('.sfundo <link>', 'baixa e remove o fundo com IA'),
      kvLine('.s <link1> <link2>', 'até 3 links de uma vez')
    ], { note: 'Vale para Pinterest, TikTok, Instagram, YouTube, GIFs e qualquer link de mídia' }),
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
  // No menu dedicado, o `.s <link>` fica na seção própria (abaixo) — evita repetir a linha.
  const createItems = STICKER_ITEMS.filter(([cmd]) => !/^\.s <link>$/i.test(cmd));
  return card([
    header('Figurinhas', 'crie em segundos'),
    section('Criar', createItems),
    section('Direto de um link (novo)', [
      kvLine('.s <link>', 'baixa e já monta a figurinha'),
      kvLine('.s inteira <link>', 'imagem completa, sem esticar'),
      kvLine('.sfundo <link>', 'baixa e remove o fundo com IA'),
      kvLine('.s <link1> <link2>', 'até 3 links de uma vez')
    ], { note: 'Pinterest, TikTok, Instagram, YouTube, X, Facebook, Threads, Reddit, GIFs e mais' }),
    section('Modos de enquadramento', [
      kvLine('.s', 'preenche o quadrado todo'),
      kvLine('.s inteira', 'imagem completa, sem esticar'),
      kvLine('.s cortar', 'preenche sem esticar, corta as bordas')
    ]),
    footer('Envie a mídia com a legenda .s, responda a ela com .s ou mande só o link')
  ]);
}

export function antiDeleteMenu() {
  return card([
    header('Anti-Delete', 'retenção local opt-in'),
    `Em chats habilitados, mensagens recuperáveis podem ser retidas por até 24 horas e enviadas somente ao privado do dono.`,
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

/**
 * Catálogo de vozes em cartão. O usuário escolhe pelo NOME (`.voz bob`), então
 * o menu mostra exatamente o que digitar — não o nome técnico da voz.
 */
export function voiceMenu({ extra = [], current = 'auto' } = {}) {
  const blocos = (categoria) =>
    section(VOICE_CATEGORIES[categoria] || categoria, voiceCatalogLines({ category: categoria, extra }));

  const categorias = ['pt', 'personagens', 'idiomas'];
  const custom = extra.length ? section('Suas vozes (VOZES_EXTRA)', voiceCatalogLines({ category: 'custom', extra })) : '';

  return card([
    header(cfg.get().nomeBot, 'vozes · escolha pelo nome'),
    kv('Voz deste chat', current),
    ...categorias.map((categoria) => blocos(categoria)),
    custom,
    section('Como usar', [
      ['.voz <texto>', 'usa a voz padrão deste chat'],
      ['.voz bob <texto>', 'fala com a voz escolhida'],
      ['.voz bob', 'manda um exemplo da voz'],
      ['.vozes bob', 'ouve o exemplo direto do catálogo'],
      ['.vozpadrao bob', 'fixa a voz neste chat (auto volta ao padrão)'],
      ['.voz "bob é o cara"', 'aspas = texto literal, sem trocar de voz']
    ]),
    footer(
      'Voz 100% grátis, sem chave: edge (online) e espeak/piper (offline, sem internet). ' +
        'Personagens são paródias por efeitos de voz, não as vozes originais. ' +
        'Crie as suas em VOZES_EXTRA no .env — veja o README.'
    )
  ]);
}

/** Cartão com os atalhos do `.criar`. */
export function imageMenu() {
  return card([
    header(cfg.get().nomeBot, 'imagem · atalhos do .criar'),
    section('Formato', [
      ['.criar --formato 1:1', 'quadrado (padrão)'],
      ['.criar --formato 9:16', 'vertical · stories'],
      ['.criar --formato 16:9', 'paisagem · cinema'],
      ['.criar --formato 3:4', 'retrato']
    ]),
    section('Estilo', [
      ['.criar anime <ideia>', 'também: realista, cartoon, 3d, pintura, aquarela'],
      ['', 'desenho, cyberpunk, pixel, logo, terror, cartoon3d, mangá'],
      ['.criar <ideia> --estilo anime', 'mesma coisa, em qualquer posição']
    ]),
    section('Qualidade', [
      ['.criar <ideia> --hd', 'amplia no final (nitidez no celular)'],
      ['.criar <ideia> --bruto', 'não reescreve o prompt na IA (mais rápido)'],
      ['.criar <ideia> --seed 1234', 'repete a mesma imagem'],
      ['.criar <ideia> --modelo flux', 'força um modelo do provedor'],
      ['.criar <ideia> --sem <coisa>', 'pede para evitar um elemento']
    ]),
    section('Como funciona', [
      '1. a IA reescreve o seu pedido em inglês, com luz, lente e detalhes',
      '2. o melhor gerador disponível desenha (Gemini → OpenAI → Pollinations)',
      '3. o bot manda a imagem com o modelo usado na legenda'
    ]),
    footer('Exemplo completo: .criar anime um gato samurai na chuva --formato 9:16 --hd')
  ]);
}

export function infoText({ uptime, cacheSize, bgRows, aiRows, imageRows = [], voiceRows = [], poolRows, ownerName }) {
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
    `${SYM.section} *IMAGEM (.criar)*\n${rows(imageRows)}`,
    `${SYM.section} *VOZ (.voz)*\n${rows(voiceRows)}`,
    `${SYM.section} *DOWNLOADERS*\n${rows(poolRows)}`
  ]);
}
