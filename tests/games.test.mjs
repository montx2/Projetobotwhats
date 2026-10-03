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
  toggleMinesweeperFlag,
  tryHandleDirectGameMove,
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

test('Jokenpô PvP, dados, moeda e roleta entregam respostas válidas', async () => {
  const jid = 'arcade-group-test@g.us';
  const alice = '551100000061@s.whatsapp.net';
  const bob = '551100000062@s.whatsapp.net';
  const replies = createReplyCollector();
  const challenge = makeMessage(jid, alice, {
    text: '.ppt @551100000062',
    pushName: 'Alice',
    message: { extendedTextMessage: { text: '.ppt @551100000062', contextInfo: { mentionedJid: [bob] } } }
  });
  await handleGameCommand({ sock: {}, msg: challenge, name: 'ppt', args: ['@551100000062'], reply: replies.reply });
  assert.deepEqual(replies.sent.at(-1).mentions, [bob]);
  await handleGameCommand({ sock: {}, msg: makeMessage(jid, bob), name: 'jokenpo', args: ['aceitar'], reply: replies.reply });
  await handleGameCommand({ sock: {}, msg: makeMessage(jid, alice, { pushName: 'Alice' }), name: 'ppt', args: ['pedra'], reply: replies.reply });
  assert.match(String(replies.sent.at(-1)), /Aguardando/);
  await handleGameCommand({ sock: {}, msg: makeMessage(jid, bob, { pushName: 'Bób' }), name: 'ppt', args: ['tesoura'], reply: replies.reply });
  assert.match(String(replies.sent.at(-1)), /Alice venceu/);
  assert.equal(getChatScoreboard(jid).find((row) => row.id === alice)?.wins, 1);
  assert.equal(getChatScoreboard(jid).find((row) => row.id === bob)?.losses, 1);

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
