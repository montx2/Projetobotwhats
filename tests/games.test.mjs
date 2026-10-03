import test from 'node:test';
import assert from 'node:assert/strict';

import { mono } from '../src/core/ui.js';
import { readJson } from '../src/core/store.js';
import {
  HANGMAN_WORDS,
  chooseTicTacToeBotMove,
  clearChatGames,
  createMinesweeperGame,
  evaluateWordGuess,
  getChatScoreboard,
  handleGameCommand,
  isGameCommand,
  normalizeGameGuess,
  renderDiceFace,
  renderHangmanBoard,
  renderMinesweeperBoard,
  renderNumberHistory,
  renderTermoBoard,
  renderTicTacToeBoard,
  revealMinesweeperCell,
  setPptTimingForTests,
  toggleMinesweeperFlag,
  tryHandleDirectGameMove,
  tryHandlePrivateGameChoice,
  verifyMonospaceBlock
} from '../src/features/games.js';

const BOX_DRAWING = /[┌─┬┐│├┼┤└┴┘╭╮╰╯]/u;

/** Grade de emoji: cada linha tem o mesmo número de células separadas por espaço e nenhum caractere de caixa. */
function assertEmojiGrid(lines, { rows, cells }) {
  assert.equal(lines.length, rows);
  for (const line of lines) {
    assert.equal(line.split(' ').length, cells, `linha com ${cells} células: "${line}"`);
    assert.doesNotMatch(line, BOX_DRAWING, 'sem caracteres de desenho de caixa');
  }
}

/** Bloco ASCII monoespaçado: todas as linhas com a mesma largura. */
function assertAsciiBlock(lines, { rows, columns }) {
  assert.equal(lines.length, rows);
  assert.ok(lines.every((line) => [...line].length === columns), 'todas as linhas têm a largura esperada');
  assert.equal(verifyMonospaceBlock(mono(lines)), true, 'o bloco passa pelo verificador estrito');
}

function makeMessage(jid, participant, { text = '', pushName = 'Teste', fromMe = false, message = null } = {}) {
  return {
    key: {
      remoteJid: jid,
      participant,
      id: `TEST-${Math.random().toString(36).slice(2)}`,
      fromMe
    },
    pushName,
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: message || { conversation: text }
  };
}

function createReplyCollector() {
  const sent = [];
  return {
    sent,
    reply: async (value) => { sent.push(value); }
  };
}

test('o validador aceita blocos ASCII alinhados e rejeita desalinhamento, emoji e caracteres de caixa', () => {
  assert.equal(verifyMonospaceBlock(mono(['  +---+', '  | O |', ' =+===='])), true);
  assert.equal(verifyMonospaceBlock('```\n+---+\n| 1 |\n+--+\n```'), false, 'larguras diferentes são rejeitadas');
  assert.equal(verifyMonospaceBlock('```\n+---+\n|😀 |\n+---+\n```'), false, 'emoji dentro do bloco é rejeitado');
  assert.equal(verifyMonospaceBlock('```\n┌───┐\n│ 1 │\n└───┘\n```'), false, 'caracteres de caixa são rejeitados');
  assert.equal(verifyMonospaceBlock('```\n+-+\n|x|\n+-+\n```\n```\n+--+\n|ab|\n+--+\n```'), true, 'cada bloco é validado separadamente');
});

test('Jogo da velha usa grade 3×3 em emoji (❌ e ⭕, nunca "O" ou "0") e o Minimax vence ou bloqueia', () => {
  const empty = renderTicTacToeBoard(Array(9).fill(''));
  assertEmojiGrid(empty, { rows: 3, cells: 3 });
  assert.deepEqual(empty, ['1️⃣ 2️⃣ 3️⃣', '4️⃣ 5️⃣ 6️⃣', '7️⃣ 8️⃣ 9️⃣']);
  const played = renderTicTacToeBoard(['', '', 'X', '', '', '', 'O', '', '']);
  assertEmojiGrid(played, { rows: 3, cells: 3 });
  assert.equal(played[0].split(' ')[2], '❌');
  assert.equal(played[2].split(' ')[0], '⭕');
  assert.doesNotMatch(played.join('\n'), /[OX0]/, 'nenhuma letra O/X nem zero ASCII na grade');
  assert.equal(chooseTicTacToeBotMove(['X', 'X', '', 'O', '', '', '', '', ''], 'dificil'), 2, 'vence se possível');
  assert.equal(chooseTicTacToeBotMove(['X', 'X', '', '', 'O', '', '', '', ''], 'dificil'), 2, 'bloqueia a vitória do adversário');
  const board = ['X', '', '', '', '', '', '', '', ''];
  const move = chooseTicTacToeBotMove(board, 'dificil');
  assert.ok(move >= 0 && !board[move], 'Minimax escolhe uma casa livre');
});

test('Termo usa quadrados 🟩🟨⬛, normaliza acentos e avalia letras repetidas em duas passagens', () => {
  const empty = renderTermoBoard([]);
  assert.equal(empty.length, 6);
  assert.ok(empty.every((line) => line === '⬜⬜⬜⬜⬜'));
  assert.equal(normalizeGameGuess('ÁRVORE'), 'arvore');
  assert.deepEqual(evaluateWordGuess('salsa', 'saias'), ['exact', 'exact', 'absent', 'present', 'present']);
  const lines = renderTermoBoard([{ guess: 'saias', marks: evaluateWordGuess('salsa', 'saias') }]);
  assert.equal(lines[0], '🟩🟩⬛🟨🟨  *SAIAS*');
  assert.equal(lines[1], '⬜⬜⬜⬜⬜');
  assert.doesNotMatch(lines.join('\n'), BOX_DRAWING);
});

test('Forca oferece mais de 100 palavras categorizadas e forca ASCII 7×10 sem moldura', () => {
  assert.ok(HANGMAN_WORDS.length >= 100);
  assert.ok(HANGMAN_WORDS.every((entry) => entry.category && /^[a-z]+$/.test(entry.word)));
  assertAsciiBlock(renderHangmanBoard(0), { rows: 7, columns: 10 });
  assertAsciiBlock(renderHangmanBoard(6), { rows: 7, columns: 10 });
  assert.doesNotMatch(renderHangmanBoard(0).join('\n'), /[O/\\]/, 'sem boneco no começo');
  assert.match(renderHangmanBoard(6).join('\n'), /O[\s\S]*\/\|\\[\s\S]*\/ \\/, 'boneco completo no sexto erro');
});

test('Campo minado usa grade 5×5 em emoji, primeira jogada segura, bandeira e flood-fill', () => {
  const player = { id: 'mines@test', name: 'Mines' };
  const game = createMinesweeperGame(player, () => 0);
  const fresh = renderMinesweeperBoard(game);
  assertEmojiGrid(fresh, { rows: 6, cells: 6 });
  assert.equal(fresh[0], '⬛ 🇦 🇧 🇨 🇩 🇪');
  assert.equal(fresh.slice(1).join(' ').split('🟦').length - 1, 25, 'todas as 25 casas começam cobertas');

  assert.equal(toggleMinesweeperFlag(game, 0), true);
  assert.match(renderMinesweeperBoard(game)[1], /^1️⃣ 🚩 /);
  assert.equal(revealMinesweeperCell(game, 0).status, 'flagged');
  assert.equal(toggleMinesweeperFlag(game, 0), false);

  const first = revealMinesweeperCell(game, 0);
  assert.notEqual(first.status, 'mine');
  assert.equal(game.mines[0], false, 'a primeira casa nunca recebe uma mina');

  let floodFound = first.revealed.length > 1;
  for (let index = 1; index < 25 && !floodFound; index++) {
    const candidate = createMinesweeperGame(player, () => 0);
    const opened = revealMinesweeperCell(candidate, index, () => 0);
    floodFound = opened.revealed.length > 1;
  }
  assert.equal(floodFound, true, 'casas vazias abrem vizinhas por busca em largura');
});

test('histórico de palpites usa ícones 🔼/🔽 e o D6 é uma grade 3×3 com pontos 🔴', () => {
  const history = renderNumberHistory([{ guess: 42, hint: 'MAIOR' }, { guess: 70, hint: 'MENOR' }]);
  assert.deepEqual(history, ['1️⃣ 🔼 *42*  ·  maior', '2️⃣ 🔽 *70*  ·  menor']);
  assert.deepEqual(renderNumberHistory([]), ['_Sem palpites ainda._']);
  for (let value = 1; value <= 6; value++) {
    const face = renderDiceFace(value);
    assertEmojiGrid(face, { rows: 3, cells: 3 });
    assert.equal(face.join('').split('🔴').length - 1, value, `a face ${value} tem ${value} pontos`);
  }
});

test('movimentos sem prefixo ficam limitados a chats autorizados e respeitam o turno', async () => {
  const jid = 'ttt-direct-test@s.whatsapp.net';
  const player = '551100000001@s.whatsapp.net';
  const outsider = '551100000002@s.whatsapp.net';
  const start = createReplyCollector();
  const startMsg = makeMessage(jid, player);
  await handleGameCommand({ sock: {}, msg: startMsg, name: 'velha', args: ['dificil'], reply: start.reply });
  assert.match(String(start.sent.at(-1)), /Jogo da velha/);
  assert.equal(verifyMonospaceBlock(String(start.sent.at(-1))), true);

  const outsiderReply = createReplyCollector();
  const ignored = await tryHandleDirectGameMove({}, makeMessage(jid, outsider, { text: '5' }), '5', {
    reply: outsiderReply.reply,
    authorized: false
  });
  assert.equal(ignored, false);
  assert.equal(outsiderReply.sent.length, 0);

  const moveReply = createReplyCollector();
  const handled = await tryHandleDirectGameMove({}, makeMessage(jid, player, { text: '5' }), '5', {
    reply: moveReply.reply,
    authorized: true
  });
  assert.equal(handled, true);
  assert.equal(verifyMonospaceBlock(String(moveReply.sent.at(-1))), true);
  clearChatGames(jid);
});

test('partida aberta de velha aceita um segundo jogador por movimento direto', async () => {
  const jid = 'ttt-open-test@g.us';
  const creator = '551100000011@s.whatsapp.net';
  const entrant = '551100000012@s.whatsapp.net';
  const opened = createReplyCollector();
  await handleGameCommand({ sock: {}, msg: makeMessage(jid, creator), name: 'velha', args: ['aberto'], reply: opened.reply });
  assert.match(String(opened.sent.at(-1)), /partida aberta/i);

  const joined = createReplyCollector();
  assert.equal(await tryHandleDirectGameMove({}, makeMessage(jid, entrant, { text: 'entrar' }), 'entrar', {
    reply: joined.reply,
    authorized: true
  }), true);
  assert.match(String(joined.sent.at(-1)), /entrou/);
  clearChatGames(jid);
});

test('desafio de velha por resposta respeita o turno e grava a partida PvP', async () => {
  const jid = 'ttt-reply-test@g.us';
  const creator = '551100000013@s.whatsapp.net';
  const target = '551100000014@s.whatsapp.net';
  const replies = createReplyCollector();
  const challenge = makeMessage(jid, creator, {
    text: '.velha',
    pushName: 'Desafiante',
    message: { extendedTextMessage: { text: '.velha', contextInfo: {
      stanzaId: 'quoted-original', participant: target, quotedMessage: { conversation: 'vamos jogar?' }
    } } }
  });
  await handleGameCommand({ sock: {}, msg: challenge, name: 'velha', args: [], reply: replies.reply });
  assert.deepEqual(replies.sent.at(-1).mentions, [target]);
  await handleGameCommand({ sock: {}, msg: makeMessage(jid, target, { pushName: 'Convidado' }), name: 'ttt', args: ['aceitar'], reply: replies.reply });
  assert.equal(verifyMonospaceBlock(String(replies.sent.at(-1))), true);

  const outOfTurn = createReplyCollector();
  assert.equal(await tryHandleDirectGameMove({}, makeMessage(jid, target, { text: '1' }), '1', {
    reply: outOfTurn.reply,
    authorized: true
  }), true);
  assert.match(String(outOfTurn.sent.at(-1)), /Ainda não é a sua vez/);

  await tryHandleDirectGameMove({}, makeMessage(jid, creator, { text: '1' }), '1', { reply: replies.reply, authorized: true });
  await tryHandleDirectGameMove({}, makeMessage(jid, target, { text: '5' }), '5', { reply: replies.reply, authorized: true });
  assert.equal(verifyMonospaceBlock(String(replies.sent.at(-1))), true);
  clearChatGames(jid);
});

test('placar persiste nomes em ASCII e clearChatGames remove os dados do chat', async () => {
  const jid = 'score-reset-test@s.whatsapp.net';
  const player = { id: '551100000021@s.whatsapp.net', name: 'Zóë 👑_!*' };
  const played = createReplyCollector();
  await handleGameCommand({
    sock: {},
    msg: makeMessage(jid, player.id, { pushName: player.name }),
    name: 'ppt',
    args: ['pedra'],
    reply: played.reply
  });
  const rows = getChatScoreboard(jid);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Zoe');
  assert.equal(rows[0].played, 1);
  assert.equal(rows[0].wins + rows[0].losses + rows[0].draws, 1);
  assert.equal(readJson('games-score.json').chats[jid].players[player.id].played, 1, 'o placar foi escrito no arquivo persistente');

  const boardReply = createReplyCollector();
  await handleGameCommand({ sock: {}, msg: makeMessage(jid, player.id), name: 'placar', args: [], reply: boardReply.reply });
  const board = String(boardReply.sent.at(-1));
  assert.equal(verifyMonospaceBlock(board), true);
  assert.match(board, /🥇 \*Zoe\*/, 'o líder recebe medalha e o nome sai em ASCII');
  assert.doesNotMatch(board, /👑|Zoë|[┌┬┐├┼┤└┴┘]/u, 'sem tabela de caixa nem nome com emoji/acento');

  const resetReply = createReplyCollector();
  await handleGameCommand({ sock: {}, msg: makeMessage(jid, player.id), name: 'placar', args: ['reset'], reply: resetReply.reply, owner: true });
  assert.match(String(resetReply.sent.at(-1)), /Placar zerado/);
  assert.deepEqual(getChatScoreboard(jid), []);
  clearChatGames(jid);
});

test('Anagrama e Quiz aceitam palpites, dicas e respostas acentuadas', async () => {
  const jid = 'word-rounds-test@s.whatsapp.net';
  const player = '551100000041@s.whatsapp.net';
  const anagram = createReplyCollector();
  await handleGameCommand({ sock: {}, msg: makeMessage(jid, player), name: 'embaralhada', args: [], reply: anagram.reply });
  const prompt = String(anagram.sent.at(-1));
  assert.match(prompt, /Anagrama/);
  const scrambled = prompt.match(/▸ \*([A-Z]+)\*/)?.[1]?.toLowerCase();
  assert.ok(scrambled, 'a palavra embaralhada é apresentada sem revelar a resposta');
  assert.ok(scrambled.length >= 5);
  await handleGameCommand({ sock: {}, msg: makeMessage(jid, player), name: 'anagrama', args: ['dica'], reply: anagram.reply });
  assert.match(String(anagram.sent.at(-1)), /Dica:/);

  const candidates = [...HANGMAN_WORDS.map((entry) => entry.word), 'amizade', 'brasileiro', 'coragem']
    .filter((word) => word.length === scrambled.length && word.split('').sort().join('') === scrambled.split('').sort().join(''));
  assert.ok(candidates.length > 0, 'a palavra embaralhada existe no banco categorizado');
  let solved = false;
  for (const candidate of candidates) {
    await handleGameCommand({ sock: {}, msg: makeMessage(jid, player), name: 'anagrama', args: [candidate], reply: anagram.reply });
    if (/vitória/i.test(String(anagram.sent.at(-1)))) { solved = true; break; }
  }
  assert.equal(solved, true, 'um palpite correto encerra a rodada');

  const quiz = createReplyCollector();
  await handleGameCommand({ sock: {}, msg: makeMessage(jid, player), name: 'trivia', args: [], reply: quiz.reply });
  const question = String(quiz.sent.at(-1));
  const knownAnswers = [
    ['maior planeta', 'jupiter'], ['lados tem um hexagono', 'seis'], ['capital do brasil', 'brasilia'],
    ['rei da selva', 'leao'], ['resultado de 9', '63'], ['continente fica o egito', 'africa'],
    ['oceano entre a america', 'atlantico'], ['cores ha no arco-iris', 'sete'],
    ['satélite natural da terra', 'lua'], ['instrumento mede a temperatura', 'termometro'],
    ['idioma oficial do brasil', 'portugues'], ['menor numero primo', '2'], ['gas as plantas absorvem', 'co2'],
    ['processo em que a agua vira vapor', 'evaporacao'], ['minutos ha em uma hora', '60'],
    ['pais tem formato aproximado', 'italia'], ['simbolo quimico da agua', 'h2o'],
    ['orgao bombeia o sangue', 'coracao'], ['maior mamifero do mundo', 'baleia azul'],
    ['dias tem um ano bissexto', '366']
  ];
  const fold = (value) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const answer = knownAnswers.find(([fragment]) => fold(question).includes(fold(fragment)))?.[1];
  assert.ok(answer, `pergunta reconhecida para testar a resposta: ${question}`);
  await handleGameCommand({ sock: {}, msg: makeMessage(jid, player), name: 'quiz', args: ['resposta', 'incorreta'], reply: quiz.reply });
  assert.match(String(quiz.sent.at(-1)), /tentativa\(s\) restante\(s\)/i);
  await handleGameCommand({ sock: {}, msg: makeMessage(jid, player), name: 'quiz', args: ['dica'], reply: quiz.reply });
  assert.match(String(quiz.sent.at(-1)), /Dica:/);
  await handleGameCommand({ sock: {}, msg: makeMessage(jid, player), name: 'quiz', args: [answer], reply: quiz.reply });
  assert.match(String(quiz.sent.at(-1)), /resposta certa/i);
  clearChatGames(jid);
});

test('Adivinhe usa histórico de 35 colunas e resolve o intervalo por palpites', async () => {
  const jid = 'number-game-test@s.whatsapp.net';
  const player = '551100000051@s.whatsapp.net';
  const replies = createReplyCollector();
  assert.equal(isGameCommand('guess'), true);
  await handleGameCommand({ sock: {}, msg: makeMessage(jid, player), name: 'guess', args: [], reply: replies.reply });
  assert.equal(verifyMonospaceBlock(String(replies.sent.at(-1))), true);

  let low = 1;
  let high = 100;
  let won = false;
  for (let attempt = 0; attempt < 8 && !won; attempt++) {
    const guess = Math.floor((low + high) / 2);
    await handleGameCommand({ sock: {}, msg: makeMessage(jid, player), name: 'adivinhe', args: [String(guess)], reply: replies.reply });
    const response = String(replies.sent.at(-1));
    assert.equal(verifyMonospaceBlock(response), true);
    if (/vitória/i.test(response)) {
      won = true;
      break;
    }
    if (/número maior/i.test(response)) low = guess + 1;
    else if (/número menor/i.test(response)) high = guess - 1;
    else assert.fail(`resposta inesperada para o palpite ${guess}: ${response}`);
  }
  assert.equal(won, true, 'a busca binária encontra qualquer valor entre 1 e 100 em até 7 palpites');
  clearChatGames(jid);
});

/** Socket falso: guarda tudo que o bot enviaria e permite simular PV bloqueado. */
function makeSock({ owner = '5511999999999@s.whatsapp.net', failFor = [] } = {}) {
  const sent = [];
  return {
    user: { id: `${owner.split('@')[0]}:7@s.whatsapp.net` },
    sent,
    sendMessage: async (jid, content) => {
      if (failFor.includes(jid)) throw new Error('não entregue');
      sent.push({ jid, text: content?.text ?? '', content });
      return { key: { id: `OUT-${sent.length}` } };
    },
    to: (jid) => sent.filter((item) => item.jid === jid),
    texts: (jid) => sent.filter((item) => item.jid === jid).map((item) => item.text)
  };
}

const GROUP_MENTION = (jid, participant, mention, text, extra = {}) => makeMessage(jid, participant, {
  text,
  pushName: extra.pushName || 'Alice',
  fromMe: extra.fromMe || false,
  message: { extendedTextMessage: { text, contextInfo: { mentionedJid: [mention] } } }
});

/** Abre uma série PvP já aceita entre os dois e devolve o socket usado. */
async function startSecretSeries({ jid, alice, bob, args = [], sock = makeSock() }) {
  const replies = createReplyCollector();
  await handleGameCommand({ sock, msg: GROUP_MENTION(jid, alice, bob, `.ppt @${bob.split('@')[0]}`), name: 'ppt', args: [`@${bob.split('@')[0]}`, ...args], reply: replies.reply });
  await handleGameCommand({ sock, msg: makeMessage(jid, bob, { pushName: 'Bob' }), name: 'jokenpo', args: ['aceitar'], reply: replies.reply });
  return { sock, replies };
}

const dm = (jid, text, extra = {}) => makeMessage(jid, undefined, { text, pushName: extra.pushName || 'Teste', fromMe: extra.fromMe || false });

test('Jokenpô PvP é SECRETO: jogada no grupo não vale, as escolhas vêm pelo privado e só depois são reveladas', async () => {
  setPptTimingForTests({ revealMs: 0 });
  const jid = 'ppt-secret@g.us';
  const alice = '551100000061@s.whatsapp.net';
  const bob = '551100000062@s.whatsapp.net';
  const { sock, replies } = await startSecretSeries({ jid, alice, bob });
  assert.deepEqual(replies.sent[0].mentions, [bob]);
  assert.match(replies.sent[0].text, /melhor de 3/);

  // aceitar chama OS DOIS no privado
  assert.match(sock.texts(alice)[0], /JOKENPÔ SECRETO/);
  assert.match(sock.texts(bob)[0], /JOKENPÔ SECRETO/);

  // o bug original: jogar no grupo deixava o outro ver. Agora não registra e avisa.
  await handleGameCommand({ sock, msg: makeMessage(jid, alice, { pushName: 'Alice' }), name: 'ppt', args: ['pedra'], reply: replies.reply });
  assert.match(String(replies.sent.at(-1)), /secreta/i);
  assert.equal(await tryHandleDirectGameMove(sock, makeMessage(jid, alice, { text: 'pedra' }), 'pedra', { reply: replies.reply, authorized: true }), false);
  assert.deepEqual(sock.to(jid), [], 'nada foi anunciado no grupo');

  // R1: Alice pedra × Bob tesoura (privado)
  assert.equal(await tryHandlePrivateGameChoice(sock, dm(alice, 'pedra', { pushName: 'Alice' }), 'pedra'), true);
  assert.match(sock.texts(alice).at(-1), /Jogada travada/);
  assert.match(sock.texts(jid).at(-1), /Alice.* já escolheu/);
  assert.doesNotMatch(sock.texts(jid).join('\n'), /PEDRA|TESOURA|PAPEL/, 'a escolha NUNCA vaza antes da revelação');
  assert.equal(await tryHandlePrivateGameChoice(sock, dm(alice, 'papel'), 'papel'), true);
  assert.match(sock.texts(alice).at(-1), /já travou/, 'não dá para trocar de jogada depois de travar');
  assert.equal(await tryHandlePrivateGameChoice(sock, dm(bob, '3', { pushName: 'Bob' }), '3'), true);
  const reveal = sock.texts(jid).join('\n');
  assert.match(reveal, /JO\.\.\. KEN\.\.\. PÔ/);
  assert.match(reveal, /Alice: 🪨 PEDRA/);
  assert.match(reveal, /Bob: ✂️ TESOURA/);
  assert.match(reveal, /Placar: Alice 1 x 0 Bob/);
  assert.equal(sock.texts(alice).filter((t) => /rodada 2/.test(t)).length, 1, 'rodada 2 abriu no privado');

  // R2: Alice papel × Bob tesoura → ponto do Bob
  await tryHandlePrivateGameChoice(sock, dm(alice, '2'), '2');
  await tryHandlePrivateGameChoice(sock, dm(bob, 'tesoura'), 'tesoura');
  assert.match(sock.texts(jid).join('\n'), /Placar: Alice 1 x 1 Bob/);

  // R3: Alice pedra × Bob tesoura → Alice leva a melhor de 3
  await tryHandlePrivateGameChoice(sock, dm(alice, '.ppt pedra'), '.ppt pedra');
  await tryHandlePrivateGameChoice(sock, dm(bob, '✂️'), '✂️');
  const final = sock.texts(jid).at(-1);
  assert.match(final, /Alice\* leva a melhor de 3/);
  assert.match(final, /\+3 pontos/);
  assert.equal(getChatScoreboard(jid).find((row) => row.id === alice)?.wins, 1);
  assert.equal(getChatScoreboard(jid).find((row) => row.id === bob)?.losses, 1);
  assert.equal(await tryHandlePrivateGameChoice(sock, dm(alice, 'pedra'), 'pedra'), false, 'série acabou: privado volta a ser ignorado');
  clearChatGames(jid);
});

test('Jokenpô PvP: empate não conta e repete a rodada; melhor de 1 termina na hora', async () => {
  setPptTimingForTests({ revealMs: 0 });
  const jid = 'ppt-draw@g.us';
  const alice = '551100000063@s.whatsapp.net';
  const bob = '551100000064@s.whatsapp.net';
  const { sock } = await startSecretSeries({ jid, alice, bob, args: ['1'] });
  assert.match(sock.texts(alice)[0], /rodada 1/);
  await tryHandlePrivateGameChoice(sock, dm(alice, 'papel'), 'papel');
  await tryHandlePrivateGameChoice(sock, dm(bob, 'papel'), 'papel');
  assert.match(sock.texts(jid).join('\n'), /Empate!.*não conta/);
  assert.match(sock.texts(bob).at(-1), /rodada 2/, 'repetiu a rodada');
  await tryHandlePrivateGameChoice(sock, dm(alice, 'tesoura'), 'tesoura');
  await tryHandlePrivateGameChoice(sock, dm(bob, 'pedra'), 'pedra');
  assert.match(sock.texts(jid).at(-1), /Bob\* leva a melhor de 1/);
  clearChatGames(jid);
});

test('Jokenpô PvP: só quem está na série joga; privado alheio e dono falando com outra pessoa são ignorados', async () => {
  setPptTimingForTests({ revealMs: 0 });
  const jid = 'ppt-intruder@g.us';
  const alice = '551100000065@s.whatsapp.net';
  const bob = '551100000066@s.whatsapp.net';
  const carol = '551100000067@s.whatsapp.net';
  const { sock } = await startSecretSeries({ jid, alice, bob });
  const before = sock.sent.length;
  assert.equal(await tryHandlePrivateGameChoice(sock, dm(carol, 'pedra'), 'pedra'), false, 'estranho não joga');
  assert.equal(await tryHandlePrivateGameChoice(sock, dm(bob, 'pedra', { fromMe: true }), 'pedra'), false, 'mensagem DO dono NO chat do Bob não é jogada do Bob');
  assert.equal(await tryHandlePrivateGameChoice(sock, makeMessage(jid, alice, { text: 'pedra' }), 'pedra'), false, 'grupo nunca é canal de jogada');
  assert.equal(sock.sent.length, before, 'nenhuma resposta para quem está de fora');

  // texto solto de quem joga ganha uma dica (e só uma por 15 s)
  assert.equal(await tryHandlePrivateGameChoice(sock, dm(alice, 'oi'), 'oi'), true);
  assert.equal(await tryHandlePrivateGameChoice(sock, dm(alice, 'oi?'), 'oi?'), true);
  assert.equal(sock.texts(alice).filter((t) => /responda com \*1\*/i.test(t)).length, 1);
  clearChatGames(jid);
});

test('Jokenpô PvP reconhece a mesma pessoa no grupo (LID) e no privado (número) e envia o convite ao número', async () => {
  setPptTimingForTests({ revealMs: 0 });
  const jid = 'ppt-lid@g.us';
  const aliceLid = '99887766@lid';
  const alicePn = '551100000068@s.whatsapp.net';
  const bobPn = '551100000069@s.whatsapp.net';
  const bobLid = '55443322@lid';
  const sock = makeSock();
  const replies = createReplyCollector();
  const challenge = GROUP_MENTION(jid, aliceLid, bobPn, '.ppt @bob');
  challenge.key.participantPn = alicePn;
  await handleGameCommand({ sock, msg: challenge, name: 'ppt', args: ['@bob'], reply: replies.reply });
  const accept = makeMessage(jid, bobLid, { pushName: 'Bob' });
  accept.key.participantPn = bobPn; // mencionado por número, fala no grupo por LID
  await handleGameCommand({ sock, msg: accept, name: 'ppt', args: ['aceitar'], reply: replies.reply });
  assert.match(String(replies.sent.at(-1)), /melhor de 3/, 'aceitar funcionou apesar de LID × número');
  assert.equal(sock.to(alicePn).length, 1, 'convite foi para o NÚMERO da Alice, não para o LID');
  assert.equal(sock.to(bobPn).length, 1);

  const aliceDm = dm(alicePn, 'papel');
  assert.equal(await tryHandlePrivateGameChoice(sock, aliceDm, 'papel'), true, 'privado pelo número casa com quem jogou pelo LID');
  const bobDm = dm(bobLid, 'pedra');
  bobDm.key.senderPn = bobPn;
  assert.equal(await tryHandlePrivateGameChoice(sock, bobDm, 'pedra'), true);
  assert.match(sock.texts(jid).join('\n'), /Placar: .* 1 x 0 .*/);
  clearChatGames(jid);
});

test('Jokenpô PvP com o dono do bot: ele joga pelo chat "Você" e é reconhecido no grupo', async () => {
  setPptTimingForTests({ revealMs: 0 });
  const owner = '5511999999999@s.whatsapp.net';
  const jid = 'ppt-owner@g.us';
  const bob = '551100000070@s.whatsapp.net';
  const sock = makeSock({ owner });
  const replies = createReplyCollector();
  await handleGameCommand({ sock, msg: GROUP_MENTION(jid, owner, bob, '.ppt @bob', { fromMe: true, pushName: 'Dono' }), name: 'ppt', args: ['@bob', '1'], reply: replies.reply });
  await handleGameCommand({ sock, msg: makeMessage(jid, bob, { pushName: 'Bob' }), name: 'ppt', args: ['aceitar'], reply: replies.reply });
  assert.equal(sock.to(owner).length, 1, 'o dono recebe o convite no próprio chat');

  const selfDm = { ...dm(owner, 'pedra', { fromMe: true }), pushName: 'Dono' };
  assert.equal(await tryHandlePrivateGameChoice(sock, selfDm, 'pedra', { selfChat: true }), true);
  // texto solto do dono no "Você" depois de jogar NÃO é sequestrado
  assert.equal(await tryHandlePrivateGameChoice(sock, dm(owner, 'lembrar de comprar pão', { fromMe: true }), 'lembrar de comprar pão', { selfChat: true }), false);
  assert.equal(await tryHandlePrivateGameChoice(sock, dm(owner, '2', { fromMe: true }), '2', { selfChat: true }), false, 'já jogou: "2" solto não vira nova jogada');
  await tryHandlePrivateGameChoice(sock, dm(bob, 'tesoura'), 'tesoura');
  assert.match(sock.texts(jid).at(-1), /Dono\* leva a melhor de 1/);
  clearChatGames(jid);
});

test('Jokenpô PvP: se o privado de alguém falha, o grupo recebe a orientação de chamar o bot', async () => {
  setPptTimingForTests({ revealMs: 0 });
  const jid = 'ppt-unreachable@g.us';
  const alice = '551100000071@s.whatsapp.net';
  const bob = '551100000072@s.whatsapp.net';
  const { sock } = await startSecretSeries({ jid, alice, bob, sock: makeSock({ failFor: ['551100000072@s.whatsapp.net'] }) });
  const warning = sock.to(jid).find((item) => /Não consegui chamar/.test(item.text));
  assert.ok(warning, 'avisou no grupo');
  assert.deepEqual(warning.content.mentions, [bob]);
  // mesmo assim, Bob pode chamar o bot por conta própria e jogar
  assert.equal(await tryHandlePrivateGameChoice(sock, dm(bob, 'papel'), 'papel'), true);
  clearChatGames(jid);
});

test('Jokenpô PvP: W.O. por tempo, convite que expira e desafio fora de grupo', async () => {
  const alice = '551100000073@s.whatsapp.net';
  const bob = '551100000074@s.whatsapp.net';
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // quem jogou leva por W.O.
  setPptTimingForTests({ revealMs: 0, pickMs: 40 });
  const woChat = 'ppt-wo@g.us';
  const wo = await startSecretSeries({ jid: woChat, alice, bob });
  await tryHandlePrivateGameChoice(wo.sock, dm(alice, 'pedra'), 'pedra');
  await wait(120);
  assert.match(wo.sock.texts(woChat).at(-1), /Bob não jogou a tempo.*W\.O\..*Alice/);
  assert.equal(getChatScoreboard(woChat).find((row) => row.id === alice)?.wins, 1);

  // ninguém jogou: encerra sem pontos
  const noneChat = 'ppt-none@g.us';
  const none = await startSecretSeries({ jid: noneChat, alice, bob });
  await wait(120);
  assert.match(none.sock.texts(noneChat).at(-1), /Ninguém jogou a tempo/);
  assert.deepEqual(getChatScoreboard(noneChat), []);

  // convite sem resposta expira
  setPptTimingForTests({ pendingMs: 40 });
  const inviteChat = 'ppt-invite@g.us';
  const sock = makeSock();
  const replies = createReplyCollector();
  await handleGameCommand({ sock, msg: GROUP_MENTION(inviteChat, alice, bob, '.ppt @bob'), name: 'ppt', args: ['@bob'], reply: replies.reply });
  await wait(120);
  assert.match(sock.texts(inviteChat).at(-1), /convite de Jokenpô expirou/);
  await handleGameCommand({ sock, msg: makeMessage(inviteChat, bob), name: 'ppt', args: ['aceitar'], reply: replies.reply });
  assert.match(String(replies.sent.at(-1)), /Nenhum convite seu/);

  // PvP precisa de grupo
  const priv = createReplyCollector();
  await handleGameCommand({ sock, msg: GROUP_MENTION('551100000075@s.whatsapp.net', alice, bob, '.ppt @bob'), name: 'ppt', args: ['@bob'], reply: priv.reply });
  assert.match(String(priv.sent.at(-1)), /Desafio só em grupo/);
  setPptTimingForTests({ revealMs: 0, pickMs: 120_000, pendingMs: 180_000 });
});

test('Jokenpô PvP: ninguém joga duas séries ao mesmo tempo e .jogos cancelar encerra no meio do suspense', async () => {
  setPptTimingForTests({ revealMs: 60 });
  const alice = '551100000076@s.whatsapp.net';
  const bob = '551100000077@s.whatsapp.net';
  const dave = '551100000078@s.whatsapp.net';
  const chatA = 'ppt-multi-a@g.us';
  const chatB = 'ppt-multi-b@g.us';
  const first = await startSecretSeries({ jid: chatA, alice, bob });
  // Alice tenta jogar outra em outro grupo
  const replies = createReplyCollector();
  await handleGameCommand({ sock: first.sock, msg: GROUP_MENTION(chatB, dave, alice, '.ppt @alice'), name: 'ppt', args: ['@alice'], reply: replies.reply });
  await handleGameCommand({ sock: first.sock, msg: makeMessage(chatB, alice, { pushName: 'Alice' }), name: 'ppt', args: ['aceitar'], reply: replies.reply });
  assert.match(String(replies.sent.at(-1)), /Já existe um Jokenpô em andamento/);
  clearChatGames(chatB);

  // cancelar durante a contagem "JO... KEN... PÔ" não revela nem pontua
  await tryHandlePrivateGameChoice(first.sock, dm(alice, 'pedra'), 'pedra');
  const resolving = tryHandlePrivateGameChoice(first.sock, dm(bob, 'tesoura'), 'tesoura');
  await handleGameCommand({ sock: first.sock, msg: makeMessage(chatA, alice), name: 'jogos', args: ['cancelar'], reply: replies.reply });
  await resolving;
  assert.doesNotMatch(first.sock.texts(chatA).join('\n'), /Rodada 1\*/);
  assert.deepEqual(getChatScoreboard(chatA), []);
  setPptTimingForTests({ revealMs: 0 });
});

test('Jokenpô contra o bot mostra o duelo com emoji e conta sequência de vitórias', async () => {
  const jid = 'ppt-bot-streak@g.us';
  const player = '551100000079@s.whatsapp.net';
  const replies = createReplyCollector();
  const realRandom = Math.random;
  try {
    Math.random = () => 0.9; // bot sempre joga "tesoura" (último índice)
    for (let i = 0; i < 3; i += 1) {
      await handleGameCommand({ sock: {}, msg: makeMessage(jid, player, { pushName: 'Duda' }), name: 'ppt', args: ['pedra'], reply: replies.reply });
    }
    const last = String(replies.sent.at(-1));
    assert.match(last, /Você: 🪨 PEDRA/);
    assert.match(last, /Bot: ✂️ TESOURA/);
    assert.match(last, /amassa/);
    assert.match(last, /🔥 3 vitórias seguidas/);
    await handleGameCommand({ sock: {}, msg: makeMessage(jid, player, { pushName: 'Duda' }), name: 'ppt', args: ['papel'], reply: replies.reply });
    assert.match(String(replies.sent.at(-1)), /corta/);
    assert.match(String(replies.sent.at(-1)), /Fim da sequência de 3/);
  } finally {
    Math.random = realRandom;
  }
  assert.equal(getChatScoreboard(jid)[0].wins, 3);
  clearChatGames(jid);
});

test('dados, moeda e roleta entregam respostas válidas', async () => {
  const jid = 'arcade-group-test@g.us';
  const alice = '551100000061@s.whatsapp.net';
  const arcade = createReplyCollector();
  await handleGameCommand({ sock: {}, msg: makeMessage(jid, alice), name: 'dado', args: [], reply: arcade.reply });
  assert.equal(verifyMonospaceBlock(String(arcade.sent.at(-1))), true);
  await handleGameCommand({ sock: {}, msg: makeMessage(jid, alice), name: 'dado', args: ['3d20'], reply: arcade.reply });
  assert.match(String(arcade.sent.at(-1)), /3d20.*total/i);
  await handleGameCommand({ sock: {}, msg: makeMessage(jid, alice), name: 'caraoucoroa', args: [], reply: arcade.reply });
  assert.match(String(arcade.sent.at(-1)), /CARA|COROA/);
  await handleGameCommand({ sock: {}, msg: makeMessage(jid, alice), name: 'roleta', args: ['pizza', '|', 'sushi', '|', 'massa'], reply: arcade.reply });
  assert.match(String(arcade.sent.at(-1)), /pizza|sushi|massa/i);
  clearChatGames(jid);
});

test('os comandos de Termo, Forca e Campo minado mostram tabuleiros validados e aceitam dicas/bandeiras', async () => {
  const jid = 'boards-route-test@s.whatsapp.net';
  const player = '551100000071@s.whatsapp.net';
  const replies = createReplyCollector();
  await handleGameCommand({ sock: {}, msg: makeMessage(jid, player), name: 'wordle', args: [], reply: replies.reply });
  assert.equal(verifyMonospaceBlock(String(replies.sent.at(-1))), true);
  await handleGameCommand({ sock: {}, msg: makeMessage(jid, player), name: 'termo', args: ['dica'], reply: replies.reply });
  assert.match(String(replies.sent.at(-1)), /Dica: começa com/);
  clearChatGames(jid);

  await handleGameCommand({ sock: {}, msg: makeMessage(jid, player), name: 'hangman', args: [], reply: replies.reply });
  assert.equal(verifyMonospaceBlock(String(replies.sent.at(-1))), true);
  await handleGameCommand({ sock: {}, msg: makeMessage(jid, player), name: 'forca', args: ['dica'], reply: replies.reply });
  assert.match(String(replies.sent.at(-1)), /categoria/i);
  clearChatGames(jid);

  await handleGameCommand({ sock: {}, msg: makeMessage(jid, player), name: 'mines', args: [], reply: replies.reply });
  assert.equal(verifyMonospaceBlock(String(replies.sent.at(-1))), true);
  await handleGameCommand({ sock: {}, msg: makeMessage(jid, player), name: 'minado', args: ['flag', 'A1'], reply: replies.reply });
  assert.match(String(replies.sent.at(-1)), /bandeira em A1/i);
  assert.equal(verifyMonospaceBlock(String(replies.sent.at(-1))), true);
  clearChatGames(jid);
});

test('o roteador limpa o ranking quando o dono desativa o chat', async () => {
  const [{ DEFAULT_CONFIG, cfg }, { handleMessage }] = await Promise.all([
    import('../src/core/config.js'),
    import('../src/features/router.js')
  ]);
  Object.assign(cfg.get(), structuredClone(DEFAULT_CONFIG));
  const jid = 'deactivate-games-test@g.us';
  const owner = '5511999999999@s.whatsapp.net';
  const player = '551100000031@s.whatsapp.net';
  cfg.get().autorizados = [jid];
  const sent = [];
  const sock = {
    user: { id: owner },
    sendMessage: async (remoteJid, content) => {
      sent.push({ remoteJid, content });
      return { key: { id: `OUT-${sent.length}` } };
    }
  };
  const deps = {
    ownerJid: owner,
    isOwner: (remoteJid, participant) => [remoteJid, participant].includes(owner),
    isOwnerPrivateChat: (remoteJid) => remoteJid === owner,
    sendOwner: async () => {}
  };
  await handleMessage(sock, makeMessage(jid, player, { text: '.ppt pedra', pushName: 'Pessoa' }), deps);
  assert.equal(getChatScoreboard(jid).length, 1);
  await handleMessage(sock, makeMessage(jid, owner, { text: '.desativar', fromMe: true }), deps);
  assert.deepEqual(getChatScoreboard(jid), []);
  assert.ok(sent.length >= 2);
});

test('o roteador entrega a jogada secreta vinda do privado (mesmo de quem não foi liberado) e segue calado para o resto', async () => {
  setPptTimingForTests({ revealMs: 0 });
  const [{ DEFAULT_CONFIG, cfg }, { handleMessage }] = await Promise.all([
    import('../src/core/config.js'),
    import('../src/features/router.js')
  ]);
  Object.assign(cfg.get(), structuredClone(DEFAULT_CONFIG));
  const jid = 'router-secret-ppt@g.us';
  const owner = '5511999999999@s.whatsapp.net';
  const alice = '551100000081@s.whatsapp.net';
  const bob = '551100000082@s.whatsapp.net';
  const stranger = '551100000083@s.whatsapp.net';
  cfg.get().autorizados = [jid]; // só o GRUPO foi liberado; os privados de Alice/Bob não
  const sock = makeSock({ owner });
  const deps = {
    ownerJid: owner,
    isOwner: (remoteJid, participant) => [remoteJid, participant].includes(owner),
    isOwnerPrivateChat: (remoteJid) => remoteJid === owner,
    sendOwner: async () => {}
  };

  await handleMessage(sock, GROUP_MENTION(jid, alice, bob, '.ppt @bob 1'), deps);
  await handleMessage(sock, makeMessage(jid, bob, { text: '.ppt aceitar', pushName: 'Bob' }), deps);
  assert.match(sock.texts(alice).at(-1), /JOKENPÔ SECRETO/, 'convite no privado da Alice');
  assert.match(sock.texts(bob).at(-1), /JOKENPÔ SECRETO/, 'convite no privado do Bob');

  const quiet = sock.sent.length;
  await handleMessage(sock, dm(stranger, 'pedra'), deps);
  await handleMessage(sock, dm(stranger, '.menu'), deps);
  await handleMessage(sock, dm(alice, '.menu'), deps); // Alice ainda não é "liberada": comando comum segue bloqueado
  assert.equal(sock.sent.length - quiet, 1, 'só a dica do jogo para quem joga; estranhos e comandos comuns: silêncio');
  assert.match(sock.texts(alice).at(-1), /responda com \*1\*/i);

  await handleMessage(sock, dm(alice, 'papel', { pushName: 'Alice' }), deps);
  await handleMessage(sock, dm(bob, 'pedra', { pushName: 'Bob' }), deps);
  assert.match(sock.texts(jid).at(-1), /Alice\* leva a melhor de 1/);
  assert.equal(getChatScoreboard(jid).find((row) => row.id === alice)?.wins, 1);
  clearChatGames(jid);
});
