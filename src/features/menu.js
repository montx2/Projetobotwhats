// 🎨 MENUS — separados em 2 versões:
// 1) ownerMenu(): menu COMPLETO que só aparece no privado do dono.
// 2) publicMenu(): menu para grupos/conversas liberadas com .ativar.
//    Mostra comandos públicos e ferramentas de grupo (estas, só para admins)
//    MENOS View Once e Anti-Delete, que são 100% privados e não aparecem para terceiros.

import { cfg } from '../core/config.js';
import { PLATFORM, PLATFORM_LABEL } from '../core/platform.js';
import { hasYtDlp } from './downloaders/ytdlp.js';
import { SUPPORTED_PLATFORMS } from './download.js';
import { SYM, header, section, cmd, footer, card, kv } from '../core/ui.js';
import { TONE_MAX, TONE_MIN, describeRecipe, toneOptionLines, voiceOptionLines } from './voices.js';

const STICKER_ITEMS = [
  ['.s', 'foto, vídeo ou GIF vira figurinha'],
  ['.s <link>', 'baixa o link e já monta a figurinha'],
  ['.s inteira', 'mantém a imagem inteira, sem esticar'],
  ['.s cortar', 'preenche o quadrado sem esticar'],
  ['.sia <pedido>', 'peça do seu jeito e a IA monta a figurinha'],
  ['.sfundo', 'figurinha sem fundo (IA) — funciona com link também'],
  ['.fundo', 'remove o fundo e envia em PNG'],
  ['.toimg', 'transforma figurinha em foto'],
  ['.tovideo', 'transforma figurinha animada em vídeo'],
  ['.tomp3', 'transforma vídeo/áudio em MP3'],
  ['.toptt', 'transforma áudio/vídeo em nota de voz']
];

const DOWNLOAD_ITEMS = [
  ['.dl <link>', 'qualquer rede social, foto ou vídeo'],
  ['.play <nome>', 'pesquisa e baixa música do YouTube'],
  ['.yt <link>', 'YouTube  ·  `.ytmp3` só o áudio'],
  ['.tiktok <link>', 'vídeo do TikTok  ·  `.ttmp3` só o áudio'],
  ['.insta <link>', 'Instagram  ·  `.pin` Pinterest'],
  ['.tw <link>', 'X/Twitter  ·  `.face` Facebook'],
  ['.bsky <link>', 'Bluesky  ·  `.imgur` Imgur  ·  `.dm` Dailymotion'],
  ['.ch <link>', 'ComedyHub (meme, foto, vídeo) · `.chlogin` conecta a conta'],
  ['.plataformas', 'tudo que o bot baixa hoje']
];

const AI_ITEMS = [
  ['.ia <pergunta>', 'conversa natural; entra na resenha se o contexto pedir · `.ia reset` limpa'],
  ['.ia clima <cidade>', 'responde usando dados atuais do clima'],
  ['.ia cotacao <valor> <origem> <destino>', 'conversão com taxa de referência'],
  ['.ia feriados [ano] [país]', 'consulta feriados nacionais'],
  ['.criar <ideia>', 'gera imagem (prompt otimizado) · `.menucriar` para os atalhos'],
  ['.voz <texto>', 'texto em áudio · `.voz grossa oi` muda o tom'],
  ['.vozes', 'vozes, tons e como configurar (`.vozes grossa` ouve)'],
  ['.vozpadrao <voz> <tom>', 'salva a voz só neste chat'],
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
      ['.face <link>', 'Facebook'],
      ['.bsky <link>', 'Bluesky  ·  `.imgur` Imgur  ·  `.dm` Dailymotion'],
      ['.ch <link>', 'ComedyHub  ·  `.chlogin` conecta a conta uma vez'],
      ['.plataformas', 'lista completa do que é suportado']
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
      'TikTok · Douyin · Instagram · YouTube · Pinterest',
      'X/Twitter · Facebook · Threads · Reddit · Bluesky',
      'Imgur · Dailymotion · Twitch · Vimeo · ComedyHub · GIFs',
      'Kwai · Tumblr · Streamable · Snapchat · SoundCloud',
      'VK · Bilibili · Weibo · Rumble · 9GAG e mais'
    ], { note: 'Streams .m3u8 também: o bot baixa os segmentos e entrega MP4' }),
    footer(`Modo universal cobre centenas de sites${extra ? `\n${extra.trim()}` : ''}`)
  ]);
}

/** Catálogo completo do suporte a downloads (comando `.plataformas`). */
export function platformsMenu() {
  const own = SUPPORTED_PLATFORMS.filter((p) => p.dedicated);
  const universal = SUPPORTED_PLATFORMS.filter((p) => !p.dedicated).map((p) => p.name);
  return card([
    header('Downloads', 'o que o bot baixa hoje'),
    section('Extrator próprio', own.map((p) => [p.name, p.notes])),
    section('Modo universal', [
      universal.slice(0, 6).join(' · '),
      universal.slice(6, 12).join(' · '),
      universal.slice(12).join(' · ')
    ].filter(Boolean), {
      note: 'Cobalt (túnel) + leitura da própria página (og:video / og:image) — foto e vídeo'
    }),
    section('Qualquer outro site', [
      kvLine('.dl <link>', 'tenta a mídia pública da página automaticamente'),
      kvLine('.s <link>', 'a mesma mídia vira figurinha')
    ], { note: 'Link .m3u8 (HLS) ganha MP4; MPEG-TS precisa do FFmpeg instalado' }),
    footer(`Total: ${SUPPORTED_PLATFORMS.length} redes com nome conhecido + a cauda longa do modo universal`)
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
 * Card da voz: mostra exatamente o que digitar para escolher VOZ, TOM
 * (grossa ⇄ fina) e VELOCIDADE — e como salvar isso no chat.
 * Curto de propósito: tudo o que o usuário precisa está aqui, sem catálogo de
 * personagem para decorar.
 */
export function voiceMenu({ extra = [], current = 'auto' } = {}) {
  return card([
    header(cfg.get().nomeBot, 'voz · você escolhe o tom'),
    kv('Neste chat', describeRecipe(current, { extra })),
    section('Como usar', [
      ['.voz <texto>', 'fala com a voz deste chat'],
      ['.voz grossa <texto>', 'tom só nesta mensagem'],
      ['.voz feminina grossa oi', 'voz + tom na mesma frase'],
      ['.vozpadrao masculina grossa', 'salva a configuração neste chat'],
      ['.vozpadrao', 'mostra o que está salvo · `auto` volta ao padrão']
    ]),
    section('Voz', voiceOptionLines({ extra })),
    section('Tom (grossa ⇄ fina)', toneOptionLines()),
    section('Ajuste fino', [
      [`--tom ${TONE_MIN} a +${TONE_MAX}`, 'negativo = mais grossa · positivo = mais fina'],
      ['--vel -60 a +60', 'velocidade da fala'],
      ['.voz masculina --tom -35 --vel -10 oi', 'exemplo: bem grave e devagar'],
      ['--fx ecoCurto | radio | sussurro', 'efeito opcional (precisa de FFmpeg)'],
      ['.voz "grossa é o nome"', 'aspas = texto literal, sem trocar nada']
    ]),
    footer(
      'Voz 100% grátis, sem chave: edge (online) e espeak/piper (offline, sem internet). ' +
        'O tom entra na própria síntese (SSML), não é efeito por cima. ' +
        'Vozes próprias do .env: VOZES_EXTRA (veja o README).'
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
