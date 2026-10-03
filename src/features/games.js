// Mini arcade do MontxBOT: jogos de texto pensados para a largura fixa do WhatsApp.
// As partidas vivem por chat; o placar é persistido em data/games-score.json.

import { readJson, writeJsonNow } from '../core/store.js';
import { SYM, header, section, card, footer, mono as wrapMonospace, ok, fail, warn, usage } from '../core/ui.js';
import { isGroup, normalizeJid } from '../util/text.js';
import { requireGroupAdministrator } from './group-tools.js';

const SCORE_FILE = 'games-score.json';
const MAX_SCORE_PLAYERS = 1_000;
const sessions = new Map();
const BOX_CHARS = new Set(Array.from('┌─┬┐│├┼┤└┴┘'));
const BOX_STARTS = new Set(Array.from('┌│├└'));
const BOX_ENDS = new Set(Array.from('┐│┤┘'));

/**
 * Valida cada bloco ```...``` enviado pelos jogos.
 * Cada linha deve ter a mesma largura, começar/terminar em uma borda e usar
 * somente ASCII imprimível ou caracteres de desenho de caixa de uma coluna.
 */
export function verifyMonospaceBlock(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  let inside = false;
  let block = [];
  let found = false;

  const validBlock = (rows) => {
    if (!rows.length || rows.some((row) => !row.length)) return false;
    const width = Array.from(rows[0]).length;
    if (!width) return false;
    return rows.every((row) => {
      const chars = Array.from(row);
      return chars.length === width &&
        BOX_STARTS.has(chars[0]) &&
        BOX_ENDS.has(chars.at(-1)) &&
        chars.every((char) => (char.codePointAt(0) >= 0x20 && char.codePointAt(0) <= 0x7e) || BOX_CHARS.has(char));
    });
  };

  for (const line of lines) {
    if (line.trim() === '```') {
      if (!inside) {
        inside = true;
        block = [];
        found = true;
      } else {
        if (!validBlock(block)) return false;
        inside = false;
      }
    } else if (inside) {
      block.push(line);
    }
  }
  return !inside && (found || !String(text ?? '').includes('```'));
}

function mono(lines) {
  const block = wrapMonospace(lines);
  if (!verifyMonospaceBlock(block)) throw new Error('tabuleiro fora do padrão monoespaçado seguro');
  return block;
}

function chatKey(jid) {
  return normalizeJid(jid);
}

function asciiName(value, fallback = 'Jogador', maxLength = 14) {
  const clean = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]/g, ' ')
    .replace(/[^A-Za-z0-9 _-]/g, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
    .trim();
  return clean || String(fallback).replace(/[^A-Za-z0-9 _-]/g, '').slice(0, maxLength) || 'Jogador';
}

function actorFor(msg) {
  const id = chatKey(msg?.key?.participant || msg?.key?.remoteJid || 'jogador');
  const fallback = String(id).split('@')[0].replace(/\D/g, '').slice(-6) || 'Jogador';
  return { id, name: asciiName(msg?.pushName || msg?.verifiedBizName, fallback) };
}

function normalizeLetters(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .replace(/[^a-z]/g, '');
}

/** Normalização pública para palpites com acentos, pontuação ou espaços. */
export function normalizeGameGuess(value) {
  return normalizeLetters(value);
}

function normalizePhrase(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .replace(/[^a-z0-9]/g, '');
}

function randomIndex(length, rng = Math.random) {
  return Math.min(length - 1, Math.max(0, Math.floor(rng() * length)));
}

function chooseOne(items, rng = Math.random) {
  return items[randomIndex(items.length, rng)];
}

function loadScoreData() {
  const raw = readJson(SCORE_FILE, null);
  if (!raw || typeof raw !== 'object' || !raw.chats || typeof raw.chats !== 'object' || Array.isArray(raw.chats)) {
    return { version: 1, chats: {} };
  }
  return { version: 1, chats: raw.chats };
}

let scoreData;
function scores() {
  scoreData ||= loadScoreData();
  return scoreData;
}

function persistScores() {
  writeJsonNow(SCORE_FILE, scores());
}

function ensurePlayerScore(chat, player) {
  const data = scores();
  data.chats[chat] ||= { players: {} };
  const chatData = data.chats[chat];
  if (!chatData.players || typeof chatData.players !== 'object' || Array.isArray(chatData.players)) {
    chatData.players = {};
  }
  let record = chatData.players[player.id];
  if (!record || typeof record !== 'object') {
    record = chatData.players[player.id] = { name: asciiName(player.name), wins: 0, losses: 0, draws: 0, played: 0, points: 0 };
  }
  record.name = asciiName(player.name || record.name);
  for (const field of ['wins', 'losses', 'draws', 'played', 'points']) {
    record[field] = Number.isFinite(Number(record[field])) ? Math.max(0, Number(record[field])) : 0;
  }
  return record;
}

function recordGameResult(jid, players, winnerId = null) {
  const chat = chatKey(jid);
  let changed = false;
  for (const player of players.filter(Boolean)) {
    if (player.bot || player.id === 'bot') continue;
    const record = ensurePlayerScore(chat, player);
    record.played += 1;
    if (winnerId === null) {
      record.draws += 1;
      record.points += 1;
    } else if (winnerId === 'loss') {
      record.losses += 1;
    } else if (player.id === winnerId) {
      record.wins += 1;
      record.points += 3;
    } else {
      record.losses += 1;
    }
    changed = true;
  }
  const table = scores().chats[chat]?.players || {};
  const ids = Object.keys(table);
  if (ids.length > MAX_SCORE_PLAYERS) {
    ids.sort((a, b) => Number(table[a]?.points || 0) - Number(table[b]?.points || 0));
    for (const id of ids.slice(0, ids.length - MAX_SCORE_PLAYERS)) delete table[id];
  }
  if (changed) persistScores();
}

export function getChatScoreboard(jid) {
  const players = scores().chats[chatKey(jid)]?.players || {};
  return Object.entries(players)
    .map(([id, row]) => ({
      id,
      name: asciiName(row?.name),
      wins: Math.max(0, Number(row?.wins) || 0),
      losses: Math.max(0, Number(row?.losses) || 0),
      draws: Math.max(0, Number(row?.draws) || 0),
      played: Math.max(0, Number(row?.played) || 0),
      points: Math.max(0, Number(row?.points) || 0)
    }))
    .sort((a, b) => b.points - a.points || b.wins - a.wins || a.name.localeCompare(b.name, 'pt-BR'));
}

export function clearChatGames(jid) {
  const key = chatKey(jid);
  sessions.delete(key);
  const data = scores();
  if (Object.hasOwn(data.chats, key)) {
    delete data.chats[key];
    persistScores();
  }
}

function resetChatScoreboard(jid) {
  const key = chatKey(jid);
  if (Object.hasOwn(scores().chats, key)) {
    delete scores().chats[key];
    persistScores();
  }
}

function activeFor(jid) {
  return sessions.get(chatKey(jid)) || null;
}

function sessionPlayers(state) {
  if (state.players) return Object.values(state.players).filter(Boolean);
  if (state.player) return [state.player];
  return [];
}

function isPlayer(state, id) {
  return sessionPlayers(state).some((player) => player.id === id);
}

function canStart(jid, type, reply) {
  const current = activeFor(jid);
  if (!current) return true;
  const stateName = GAME_LABELS[current.type] || 'jogo';
  const detail = current.type === type
    ? `A partida de ${stateName} já está aberta neste chat. Use os comandos dela ou .jogos cancelar.`
    : `Finalize a partida de ${stateName} com .jogos cancelar antes de abrir outra.`;
  Promise.resolve(reply(warn('Já existe uma partida ativa', detail))).catch(() => {});
  return false;
}

function setSession(jid, state) {
  state.chat = chatKey(jid);
  sessions.set(state.chat, state);
}

function finishSession(state, winnerId = null) {
  if (state.finished) return;
  state.finished = true;
  recordGameResult(state.chat, sessionPlayers(state), winnerId);
  sessions.delete(state.chat);
}

const GAME_LABELS = Object.freeze({
  ttt: 'Jogo da velha',
  termo: 'Termo',
  forca: 'Forca',
  minado: 'Campo minado',
  anagrama: 'Anagrama',
  quiz: 'Quiz',
  numero: 'Adivinhe o número',
  ppt: 'Jokenpô'
});

const ALIASES = new Map([
  ['jogos', 'jogos'], ['velha', 'velha'], ['jogodavelha', 'velha'], ['jv', 'velha'], ['ttt', 'velha'],
  ['termo', 'termo'], ['wordle', 'termo'], ['forca', 'forca'], ['hangman', 'forca'],
  ['minado', 'minado'], ['campominado', 'minado'], ['minas', 'minado'], ['mines', 'minado'],
  ['anagrama', 'anagrama'], ['embaralhada', 'anagrama'],
  ['quiz', 'quiz'], ['trivia', 'quiz'], ['pergunta', 'quiz'],
  ['adivinhe', 'numero'], ['numero', 'numero'], ['guess', 'numero'],
  ['ppt', 'ppt'], ['jokenpo', 'ppt'],
  ['dado', 'dado'], ['moeda', 'moeda'], ['caraoucoroa', 'moeda'], ['roleta', 'roleta'],
  ['placar', 'placar'], ['ranking', 'placar'], ['rank', 'placar'], ['score', 'placar']
]);
const GAME_COMMANDS = new Set(ALIASES.keys());

export function isGameCommand(name) {
  return GAME_COMMANDS.has(String(name || '').toLocaleLowerCase('pt-BR'));
}

function renderScoreTable(players) {
  const width = 33;
  const top = `┌${'─'.repeat(width)}┐`;
  const divider = `├${'─'.repeat(width)}┤`;
  const row = (text) => `│${String(text).slice(0, width).padEnd(width)}│`;
  const headerRow = ['NOME'.padEnd(11), 'V'.padStart(2), 'D'.padStart(2), 'E'.padStart(2), 'PTS'.padStart(4)].join(' | ');
  const count = (value, digits) => String(Math.min(10 ** digits - 1, Math.max(0, Math.floor(Number(value) || 0)))).padStart(digits);
  const rows = players.slice(0, 10).map((player) =>
    [
      asciiName(player.name, 'Jogador', 11).padEnd(11),
      count(player.wins, 2),
      count(player.losses, 2),
      count(player.draws, 2),
      count(player.points, 4)
    ].join(' | ')
  );
  return mono([top, row(headerRow), divider, ...(rows.length ? rows.map(row) : [row('Sem partidas registradas ainda.')]), `└${'─'.repeat(width)}┘`]);
}

async function handleScoreboard({ sock, msg, args, reply, owner }) {
  const jid = msg.key.remoteJid;
  if (String(args[0] || '').toLowerCase() === 'reset') {
    if (!owner) {
      if (isGroup(jid)) await requireGroupAdministrator(sock, msg, { owner: false });
      else throw new Error('somente o dono do bot pode zerar o placar deste chat');
    }
    resetChatScoreboard(jid);
    return reply(ok('Placar zerado', 'o ranking deste chat foi reiniciado'));
  }
  const players = getChatScoreboard(jid);
  return reply(card([
    header('Placar', `${players.length} jogador(es) · pontuação por chat`),
    renderScoreTable(players),
    footer('Vitória: 3 pontos  ·  empate: 1 ponto  ·  .placar reset (admin/dono)')
  ]));
}

function gameMenu() {
  return card([
    header('Jogos', 'mini arcade do MontxBOT'),
    section('Tabuleiros', [
      ['.velha [facil|medio|dificil]', 'Jogo da velha contra o bot'],
      ['.velha @oponente | aberto', 'desafio PvP ou partida aberta no grupo'],
      ['.termo', 'Wordle em português · .termo dica'],
      ['.forca', 'forca com categorias · .forca dica'],
      ['.minado', 'campo minado 5×5 · A1–E5 · flag A1']
    ]),
    section('Palavras e raciocínio', [
      ['.anagrama', 'descubra a palavra embaralhada'],
      ['.quiz', 'perguntas rápidas de conhecimentos gerais'],
      ['.adivinhe', 'número secreto de 1 a 100']
    ]),
    section('Arcade', [
      ['.ppt pedra|papel|tesoura', 'Jokenpô contra o bot ou .ppt @oponente'],
      ['.dado [NdM]', 'dado D6 ou rolagem, por exemplo 3d20'],
      ['.moeda', 'cara ou coroa'],
      ['.roleta opção | opção', 'sorteia entre duas ou mais opções']
    ]),
    section('Ranking', [
      ['.placar', 'placar deste chat'],
      ['.placar reset', 'zera o ranking (admin/dono)'],
      ['.jogos cancelar', 'encerra a partida ativa neste chat']
    ]),
    footer('Uma partida de tabuleiro por chat · movimentos também funcionam sem prefixo')
  ]);
}

function getMessageContext(msg) {
  const message = msg?.message || {};
  for (const node of [
    message.extendedTextMessage,
    message.imageMessage,
    message.videoMessage,
    message.documentMessage,
    message.ephemeralMessage?.message?.extendedTextMessage
  ]) {
    if (node?.contextInfo) return node.contextInfo;
  }
  return {};
}

function opponentFromMessage(msg, actor) {
  const context = getMessageContext(msg);
  const mentioned = Array.isArray(context.mentionedJid) ? context.mentionedJid.find(Boolean) : null;
  const replied = context.quotedMessage ? context.participant : null;
  const id = chatKey(mentioned || replied || '');
  if (!id || id === actor.id) return null;
  return { id, name: 'Oponente' };
}

function mentionTag(id) {
  const digits = String(id || '').split('@')[0].split(':')[0].replace(/\D/g, '');
  return digits ? `@${digits}` : 'oponente';
}

function tttWinner(board) {
  const lines = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
  for (const [a, b, c] of lines) if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
  return null;
}

export function renderTicTacToeBoard(board) {
  const cells = Array.from({ length: 9 }, (_, index) => {
    const value = Array.isArray(board) ? board[index] : '';
    return value === 'X' || value === 'O' ? value : String(index + 1);
  });
  return [
    '┌───┬───┬───┐',
    `│ ${cells[0]} │ ${cells[1]} │ ${cells[2]} │`,
    '├───┼───┼───┤',
    `│ ${cells[3]} │ ${cells[4]} │ ${cells[5]} │`,
    '├───┼───┼───┤',
    `│ ${cells[6]} │ ${cells[7]} │ ${cells[8]} │`,
    '└───┴───┴───┘'
  ];
}

function chooseRandomMove(board, rng = Math.random) {
  const empty = board.map((cell, index) => cell ? -1 : index).filter((index) => index >= 0);
  return empty.length ? empty[randomIndex(empty.length, rng)] : -1;
}

function minimax(board, symbol, botSymbol, humanSymbol, depth) {
  const winner = tttWinner(board);
  if (winner === botSymbol) return 10 - depth;
  if (winner === humanSymbol) return depth - 10;
  if (board.every(Boolean)) return 0;
  const available = board.map((cell, index) => cell ? -1 : index).filter((index) => index >= 0);
  const maximizing = symbol === botSymbol;
  let best = maximizing ? -Infinity : Infinity;
  for (const index of available) {
    board[index] = symbol;
    const score = minimax(board, maximizing ? humanSymbol : botSymbol, botSymbol, humanSymbol, depth + 1);
    board[index] = '';
    best = maximizing ? Math.max(best, score) : Math.min(best, score);
  }
  return best;
}

export function chooseTicTacToeBotMove(board, difficulty = 'dificil', rng = Math.random) {
  const empty = board.map((cell, index) => cell ? -1 : index).filter((index) => index >= 0);
  if (!empty.length) return -1;
  const level = normalizeDifficulty(difficulty);
  if (level === 'facil') return chooseRandomMove(board, rng);

  const immediate = (symbol) => empty.find((index) => {
    board[index] = symbol;
    const wins = tttWinner(board) === symbol;
    board[index] = '';
    return wins;
  });
  const winningMove = immediate('O');
  if (winningMove !== undefined) return winningMove;
  const blockingMove = immediate('X');
  if (blockingMove !== undefined) return blockingMove;
  if (level === 'medio' && rng() < 0.35) return chooseRandomMove(board, rng);

  let bestScore = -Infinity;
  let bestMoves = [];
  for (const index of empty) {
    board[index] = 'O';
    const score = minimax(board, 'X', 'O', 'X', 1);
    board[index] = '';
    if (score > bestScore) {
      bestScore = score;
      bestMoves = [index];
    } else if (score === bestScore) {
      bestMoves.push(index);
    }
  }
  return bestMoves[randomIndex(bestMoves.length, rng)];
}

function normalizeDifficulty(value) {
  const key = normalizePhrase(value);
  if (['facil', 'easy'].includes(key)) return 'facil';
  if (['dificil', 'hard'].includes(key)) return 'dificil';
  return 'medio';
}

function tttText(state, detail = '') {
  const x = state.players.X?.name || 'Jogador X';
  const o = state.players.O?.name || (state.status === 'open' ? 'aguardando...' : 'Oponente');
  const mode = state.mode === 'bot' ? `bot ${state.difficulty}` : state.status === 'open' ? 'partida aberta' : 'PvP';
  const turn = state.status === 'playing'
    ? `Vez de ${state.turn} · ${state.players[state.turn]?.name || 'jogador'}`
    : state.status === 'pending' ? 'Aguardando aceite do desafio.' : 'Aguardando outro jogador entrar.';
  return card([
    header('Jogo da velha', mode),
    detail || turn,
    mono(renderTicTacToeBoard(state.board)),
    `X · ${x}   /   O · ${o}`,
    state.status === 'playing' ? '_Escolha uma casa de 1 a 9 com `.velha 5` ou envie apenas o número._' : ''
  ]);
}

async function tttPlayerAction(state, player, position, reply) {
  if (state.status !== 'playing') {
    await reply(warn('A partida ainda não começou', 'aguarde o aceite do desafio ou alguém entrar na partida aberta'));
    return false;
  }
  const symbol = state.turn;
  const expected = state.players[symbol];
  if (!expected || expected.id !== player.id) {
    await reply(warn('Ainda não é a sua vez', `jogada de ${symbol} pendente`));
    return false;
  }
  if (!Number.isInteger(position) || position < 1 || position > 9) {
    await reply(usage('.velha <1-9>', '.velha 5', 'Escolha uma casa livre do tabuleiro.'));
    return false;
  }
  if (state.board[position - 1]) {
    await reply(warn('Casa ocupada', 'escolha outro número livre no tabuleiro'));
    return false;
  }
  state.board[position - 1] = symbol;
  let winner = tttWinner(state.board);
  if (winner) {
    const winnerPlayer = state.players[winner];
    finishSession(state, winnerPlayer?.bot ? 'loss' : winnerPlayer?.id || null);
    await reply(card([header('Jogo da velha', 'fim de partida'), `${winnerPlayer?.name || winner} venceu.`, mono(renderTicTacToeBoard(state.board)), '_Próxima: `.velha` · placar: `.placar`_']));
    return true;
  }
  if (state.board.every(Boolean)) {
    finishSession(state, null);
    await reply(card([header('Jogo da velha', 'empate'), 'Deu velha. Boa partida.', mono(renderTicTacToeBoard(state.board)), '_Próxima: `.velha` · placar: `.placar`_']));
    return true;
  }

  if (state.mode === 'bot') {
    const move = chooseTicTacToeBotMove(state.board, state.difficulty);
    if (move >= 0) state.board[move] = 'O';
    winner = tttWinner(state.board);
    if (winner) {
      finishSession(state, 'loss');
      await reply(card([header('Jogo da velha', 'fim de partida'), 'O bot venceu desta vez. Tente outra estratégia.', mono(renderTicTacToeBoard(state.board)), '_Próxima: `.velha` · placar: `.placar`_']));
      return true;
    }
    if (state.board.every(Boolean)) {
      finishSession(state, null);
      await reply(card([header('Jogo da velha', 'empate'), 'Deu velha. Boa partida.', mono(renderTicTacToeBoard(state.board)), '_Próxima: `.velha` · placar: `.placar`_']));
      return true;
    }
    state.turn = 'X';
    await reply(tttText(state, `Você marcou X; o bot respondeu em ${move + 1}.`));
    return true;
  }
  state.turn = symbol === 'X' ? 'O' : 'X';
  await reply(tttText(state));
  return true;
}

async function handleTicTacToe({ sock, msg, args, reply, actor }) {
  const jid = msg.key.remoteJid;
  const first = String(args[0] || '').toLowerCase();
  const state = activeFor(jid);

  if (['aceitar', 'aceito', 'accept', 'entrar', 'join'].includes(first)) {
    if (!state || state.type !== 'ttt') return reply(warn('Nenhum desafio aberto', 'use `.velha @oponente` ou `.velha aberto` para começar'));
    if (state.status === 'open' && ['entrar', 'join', 'aceitar', 'aceito'].includes(first)) {
      if (state.players.X.id === actor.id) return reply(warn('Você já criou a partida', 'outra pessoa precisa entrar com `.velha entrar`'));
      state.players.O = actor;
      state.status = 'playing';
      state.turn = 'X';
      return reply(tttText(state, `${actor.name} entrou. ${state.players.X.name} começa como X.`));
    }
    if (state.status === 'pending' && state.players.O?.id === actor.id) {
      state.players.O = actor;
      state.status = 'playing';
      state.turn = 'X';
      return reply(tttText(state, `${actor.name} aceitou. ${state.players.X.name} começa como X.`));
    }
    return reply(warn('Este convite não é para você', 'somente a pessoa desafiada pode aceitar'));
  }

  if (['recusar', 'recuso', 'declinar'].includes(first)) {
    if (!state || state.type !== 'ttt' || state.status !== 'pending' || state.players.O?.id !== actor.id) {
      return reply(warn('Nenhum convite seu para recusar'));
    }
    sessions.delete(chatKey(jid));
    return reply(warn('Convite recusado', 'a partida não foi iniciada'));
  }

  if (first === 'aberto' || first === 'open') {
    if (!isGroup(jid)) return reply(fail('Use em um grupo', 'partidas abertas ficam disponíveis para o grupo entrar'));
    if (!canStart(jid, 'ttt', reply)) return;
    const game = {
      type: 'ttt', mode: 'pvp', status: 'open', board: Array(9).fill(''), turn: 'X',
      players: { X: actor, O: null }, creatorId: actor.id, finished: false
    };
    setSession(jid, game);
    return reply(tttText(game, 'Partida aberta: outra pessoa pode entrar com `.velha entrar`.'));
  }

  if (first === 'cancelar' || first === 'sair') return cancelCurrentGame({ jid, actor, reply, owner: false });
  if (first === 'status' && state?.type === 'ttt') return reply(tttText(state));

  const opponent = opponentFromMessage(msg, actor);
  if (opponent) {
    if (!canStart(jid, 'ttt', reply)) return;
    const game = {
      type: 'ttt', mode: 'pvp', status: 'pending', board: Array(9).fill(''), turn: 'X',
      players: { X: actor, O: opponent }, creatorId: actor.id, finished: false
    };
    setSession(jid, game);
    const text = `${tttText(game, `Desafio enviado para ${mentionTag(opponent.id)}. A pessoa aceita com ".velha aceitar".`)}`;
    return reply({ text, mentions: [opponent.id] });
  }

  if (/^[1-9]$/.test(first)) {
    if (!state || state.type !== 'ttt') return reply(warn('Nenhuma partida ativa', 'inicie com `.velha`'));
    return tttPlayerAction(state, actor, Number(first), reply);
  }

  if (!first || ['facil', 'fácil', 'medio', 'médio', 'dificil', 'difícil', 'easy', 'hard'].includes(first)) {
    if (state?.type === 'ttt') return reply(tttText(state));
    if (!canStart(jid, 'ttt', reply)) return;
    const difficulty = normalizeDifficulty(first || 'medio');
    const game = {
      type: 'ttt', mode: 'bot', status: 'playing', board: Array(9).fill(''), turn: 'X',
      difficulty, players: { X: actor, O: { id: 'bot', name: 'MontxBOT', bot: true } },
      creatorId: actor.id, finished: false
    };
    setSession(jid, game);
    return reply(tttText(game, `Você é X · nível ${difficulty}.`));
  }
  return reply(usage('.velha [facil|medio|dificil] | @oponente | aberto', '.velha dificil', 'No modo PvP, use `.velha entrar` em partidas abertas ou `.velha aceitar` no desafio.'));
}

function evaluateWordGuess(target, guess) {
  const answer = normalizeLetters(target);
  const attempt = normalizeLetters(guess);
  const marks = Array(answer.length).fill('absent');
  if (answer.length !== attempt.length) return marks;
  const remaining = new Map();
  for (let index = 0; index < answer.length; index++) {
    if (attempt[index] === answer[index]) marks[index] = 'exact';
    else remaining.set(answer[index], (remaining.get(answer[index]) || 0) + 1);
  }
  for (let index = 0; index < answer.length; index++) {
    if (marks[index] === 'exact') continue;
    const count = remaining.get(attempt[index]) || 0;
    if (count > 0) {
      marks[index] = 'present';
      remaining.set(attempt[index], count - 1);
    }
  }
  return marks;
}

export { evaluateWordGuess };

export function renderTermoBoard(attempts = []) {
  const top = `┌${'─'.repeat(25)}┐`;
  const bottom = `└${'─'.repeat(25)}┘`;
  const empty = '...';
  const rows = Array.from({ length: 6 }, (_, rowIndex) => {
    const attempt = attempts[rowIndex];
    const letters = attempt ? normalizeLetters(attempt.guess).slice(0, 5) : '';
    const marks = attempt?.marks || [];
    const tiles = Array.from({ length: 5 }, (_, index) => {
      const letter = letters[index] || ' ';
      if (!attempt) return empty;
      const mark = marks[index] || 'absent';
      return mark === 'exact' ? `[${letter.toUpperCase()}]` : mark === 'present' ? `(${letter.toUpperCase()})` : `-${letter.toUpperCase()}-`;
    });
    return `│   ${tiles.join(' ')}   │`;
  });
  return [top, ...rows, bottom];
}

const TERMO_WORDS = Object.freeze([
  'abriu', 'acaso', 'acima', 'acude', 'adeus', 'agora', 'ajuda', 'alado', 'aluno', 'amigo', 'amora', 'anexo',
  'areia', 'aroma', 'astro', 'atras', 'audio', 'aviao', 'baixa', 'banco', 'barco', 'beijo', 'bicho', 'bolsa',
  'bravo', 'brisa', 'cabra', 'calma', 'calor', 'campo', 'canto', 'carro', 'carta', 'casal', 'causa', 'cerca',
  'certo', 'chave', 'cheio', 'chuva', 'ciclo', 'cinza', 'claro', 'cobra', 'coisa', 'conto', 'corpo', 'couro',
  'creme', 'crime', 'dança'.normalize('NFD').replace(/[\u0300-\u036f]/g, ''), 'dente', 'digno', 'disco', 'doido', 'dolar',
  'duque', 'etapa', 'falar', 'fardo', 'farol', 'festa', 'filho', 'final', 'firme', 'folha', 'forca', 'frase',
  'frevo', 'fruta', 'fugir', 'fundo', 'gente', 'gosto', 'grato', 'grupo', 'gueto', 'horta', 'hotel', 'humor',
  'ideia', 'igual', 'jogar', 'jovem', 'julho', 'justo', 'lacre', 'lapis', 'leite', 'lenda', 'lindo', 'livro',
  'longe', 'lugar', 'magia', 'magro', 'maior', 'manga', 'manha', 'manso', 'marca', 'massa', 'medir', 'melro',
  'mente', 'mesmo', 'metro', 'milho', 'minha', 'moeda', 'monte', 'moral', 'morro', 'mundo', 'nadar', 'natal',
  'navio', 'negro', 'ninho', 'noite', 'norte', 'nuvem', 'olhar', 'oncas', 'ordem', 'orgao', 'outro', 'padre',
  'pacto', 'pague', 'papel', 'parar', 'parte', 'passe', 'pasta', 'pedra', 'peixe', 'perto', 'piano', 'pilha',
  'pista', 'plano', 'pobre', 'poder', 'ponto', 'porta', 'prato', 'preto', 'prosa', 'pulso', 'punho', 'quase',
  'queda', 'quero', 'raiva', 'ramal', 'ramos', 'rasgo', 'regra', 'reino', 'risco', 'ritmo', 'rocha', 'roubo',
  'sabia', 'sabor', 'salto', 'santo', 'saude', 'selva', 'senso', 'sinal', 'sonho', 'sorte', 'suave', 'tarde',
  'tecla', 'tempo', 'tenis', 'terra', 'teste', 'tigre', 'tinta', 'toque', 'trama', 'trevo', 'trigo', 'turma',
  'valer', 'vapor', 'verde', 'verao', 'vigor', 'volta', 'zebra'
]);

function termoText(state, detail = '') {
  return card([
    header('Termo', `${state.attempts.length}/6 tentativas`),
    detail || 'Adivinhe a palavra de cinco letras. Acentos não mudam o palpite.',
    mono(renderTermoBoard(state.attempts)),
    '_[L] na posição certa · (L) existe em outra posição · -L- não aparece_'
  ]);
}

async function handleTermo({ msg, args, reply, actor }) {
  const jid = msg.key.remoteJid;
  const state = activeFor(jid);
  const first = String(args[0] || '').toLowerCase();
  if (first === 'dica') {
    if (!state || state.type !== 'termo') return reply(warn('Nenhuma partida de Termo ativa', 'inicie com `.termo`'));
    return reply(termoText(state, `Dica: começa com ${state.word[0].toUpperCase()} e tem cinco letras.`));
  }
  if (['desistir', 'sair', 'cancelar'].includes(first)) return cancelCurrentGame({ jid, actor, reply, owner: false });
  if (state?.type !== 'termo') {
    if (args.length) return reply(usage('.termo', '.termo', 'Comece uma partida antes de enviar um palpite.'));
    if (!canStart(jid, 'termo', reply)) return;
    const game = { type: 'termo', player: actor, creatorId: actor.id, word: chooseOne(TERMO_WORDS), attempts: [], finished: false };
    setSession(jid, game);
    return reply(termoText(game));
  }
  if (state.player.id !== actor.id) return reply(warn('Partida individual', 'quem iniciou este Termo deve enviar os palpites'));
  if (!args.length) return reply(termoText(state));
  const guess = normalizeLetters(args.join(' '));
  return applyTermoGuess(state, guess, reply);
}

async function applyTermoGuess(state, rawGuess, reply) {
  const guess = normalizeLetters(rawGuess);
  if (guess.length !== 5) return reply(warn('Palpite inválido', 'envie uma palavra com cinco letras; acentos são aceitos'));
  if (state.attempts.some((attempt) => attempt.guess === guess)) return reply(warn('Palpite repetido', 'tente uma palavra diferente'));
  const marks = evaluateWordGuess(state.word, guess);
  state.attempts.push({ guess, marks });
  const solved = guess === state.word;
  if (solved) {
    finishSession(state, state.player.id);
    return reply(card([header('Termo', 'vitória'), 'Você encontrou a palavra.', mono(renderTermoBoard(state.attempts)), '_+3 pontos no placar deste chat._']));
  }
  if (state.attempts.length >= 6) {
    finishSession(state, 'loss');
    return reply(card([header('Termo', 'fim de jogo'), `A palavra era ${state.word.toUpperCase()}.`, mono(renderTermoBoard(state.attempts))]));
  }
  return reply(termoText(state, `Palpite ${state.attempts.length}/6 registrado.`));
}

const WORD_CATEGORIES = Object.freeze({
  Animais: [
    'abelha', 'aguia', 'arara', 'baleia', 'beijaflor', 'besouro', 'cachorro', 'camelo', 'cavalo', 'capivara',
    'coelho', 'coruja', 'elefante', 'formiga', 'girafa', 'golfinho', 'hipopotamo', 'jacare', 'lagarto', 'leopardo',
    'morcego', 'onca', 'ovelha', 'papagaio', 'pinguim', 'raposa', 'tartaruga', 'tubarao', 'urubu', 'zebra'
  ],
  Alimentos: [
    'abacate', 'abacaxi', 'acerola', 'alface', 'amendoim', 'banana', 'batata', 'beterraba', 'biscoito', 'brigadeiro',
    'canjica', 'cenoura', 'chocolate', 'churrasco', 'couve', 'farinha', 'feijao', 'goiaba', 'laranja', 'macarrao',
    'mandioca', 'melancia', 'morango', 'pastel', 'pipoca', 'queijo', 'tapioca', 'tomate', 'torresmo', 'iogurte'
  ],
  Objetos: [
    'abajur', 'almofada', 'anel', 'armario', 'balde', 'bandeja', 'bateria', 'cadeira', 'caderno', 'caneta',
    'chinelo', 'cobertor', 'colher', 'computador', 'cortina', 'espelho', 'escova', 'faca', 'garrafa', 'mochila',
    'panela', 'pente', 'perfume', 'porta', 'quadro', 'relogio', 'sapato', 'tesoura', 'travesseiro', 'vassoura'
  ],
  Natureza: [
    'arvore', 'bosque', 'brisa', 'cascata', 'cerrado', 'cometa', 'deserto', 'estrela', 'floresta', 'granito',
    'horizonte', 'inverno', 'lagoa', 'montanha', 'neblina', 'oceano', 'planeta', 'relampago', 'riacho', 'sereno',
    'vulcao', 'cachoeira', 'praia', 'sombra', 'tempestade', 'terremoto', 'tornado', 'trovao', 'universo', 'outono'
  ],
  Lugares: [
    'aeroporto', 'avenida', 'biblioteca', 'castelo', 'cidade', 'cozinha', 'escola', 'estadio', 'fazenda', 'hospital',
    'mercado', 'museu', 'padaria', 'parque', 'piscina', 'praca', 'restaurante', 'shopping', 'teatro', 'rodoviaria',
    'zoologico', 'cartorio', 'igreja', 'oficina', 'quintal', 'terminal', 'farmacia', 'estacao', 'garagem', 'mirante'
  ],
  Esportes: [
    'basquete', 'futebol', 'volei', 'natacao', 'corrida', 'ciclismo', 'ginastica', 'handebol', 'judo', 'karate',
    'surf', 'tenis', 'skate', 'xadrez', 'atletismo', 'remo', 'esgrima', 'patins', 'golfe', 'boxe', 'escalada',
    'beisebol', 'hoquei', 'rugby', 'capoeira', 'badminton', 'canoagem', 'maratona', 'triatlo', 'polo'
  ],
  Tecnologia: [
    'algoritmo', 'aplicativo', 'bluetooth', 'camera', 'carregador', 'celular', 'controle', 'teclado', 'monitor',
    'notebook', 'memoria', 'microfone', 'processador', 'roteador', 'servidor', 'software', 'telefone', 'webcam',
    'arquivo', 'planilha', 'mensagem', 'programa', 'digital', 'senha', 'tablet', 'internet', 'sistema', 'download',
    'bateria', 'painel'
  ],
  Profissoes: [
    'advogado', 'arquiteto', 'dentista', 'enfermeiro', 'engenheiro', 'escritor', 'fotografo', 'jornalista', 'medico',
    'padeiro', 'professor', 'psicologo', 'soldado', 'cozinheiro', 'veterinario', 'bombeiro', 'motorista', 'cientista',
    'artista', 'cantor', 'pintor', 'designer', 'eletricista', 'jardineiro', 'mecanico', 'ator', 'barbeiro', 'garcom',
    'juiz', 'piloto'
  ]
});

export const HANGMAN_WORDS = Object.freeze(Object.entries(WORD_CATEGORIES).flatMap(([category, words]) =>
  words.map((word) => Object.freeze({ word: normalizeLetters(word), category }))
));

function renderHangmanRows(wrong = 0) {
  const miss = Math.max(0, Math.min(6, Number(wrong) || 0));
  const line = (text) => `│${String(text).slice(0, 17).padEnd(17)}│`;
  const head = miss >= 1 ? 'O' : ' ';
  const torso = miss >= 2 ? '|' : ' ';
  const leftArm = miss >= 3 ? '/' : ' ';
  const rightArm = miss >= 4 ? '\\' : ' ';
  const leftLeg = miss >= 5 ? '/' : ' ';
  const rightLeg = miss >= 6 ? '\\' : ' ';
  const lives = `[${'#'.repeat(6 - miss)}${'-'.repeat(miss)}]`;
  return [
    `┌${'─'.repeat(17)}┐`,
    line('      +---+'),
    line('      |   |'),
    line(`      ${head}   |`),
    line(`      ${leftArm}${torso}${rightArm}  |`),
    line(`      ${leftLeg} ${rightLeg}   |`),
    line('     _____|'),
    line(` VIDAS ${lives}`),
    `└${'─'.repeat(17)}┘`
  ];
}

export function renderHangmanBoard(wrong = 0) {
  return renderHangmanRows(wrong);
}

function hangmanText(state, detail = '') {
  const masked = Array.from(state.word, (letter) => state.guessed.includes(letter) ? letter.toUpperCase() : '_').join(' ');
  return card([
    header('Forca', `${state.wrong}/6 erros`),
    detail || `Categoria: ${state.category}.`,
    mono(renderHangmanBoard(state.wrong)),
    `Palavra · ${masked}`,
    state.guessed.length ? `Letras tentadas · ${state.guessed.map((letter) => letter.toUpperCase()).join(' ')}` : '',
    '_Envie uma letra ou tente a palavra inteira. Use `.forca dica` para a categoria._'
  ]);
}

async function handleHangman({ msg, args, reply, actor }) {
  const jid = msg.key.remoteJid;
  const state = activeFor(jid);
  const first = String(args[0] || '').toLowerCase();
  if (first === 'dica') {
    if (!state || state.type !== 'forca') return reply(warn('Nenhuma partida de Forca ativa', 'inicie com `.forca`'));
    return reply(hangmanText(state, `Dica: a palavra pertence à categoria ${state.category.toLocaleLowerCase('pt-BR')}.`));
  }
  if (['desistir', 'sair', 'cancelar'].includes(first)) return cancelCurrentGame({ jid, actor, reply, owner: false });
  if (state?.type !== 'forca') {
    if (args.length) return reply(usage('.forca', '.forca', 'Comece uma partida antes de enviar um palpite.'));
    if (!canStart(jid, 'forca', reply)) return;
    const entry = chooseOne(HANGMAN_WORDS);
    const game = { type: 'forca', player: actor, creatorId: actor.id, word: entry.word, category: entry.category, guessed: [], wrong: 0, finished: false };
    setSession(jid, game);
    return reply(hangmanText(game));
  }
  if (state.player.id !== actor.id) return reply(warn('Partida individual', 'quem iniciou esta Forca deve enviar os palpites'));
  if (!args.length) return reply(hangmanText(state));
  return applyHangmanGuess(state, args.join(' '), reply);
}

async function applyHangmanGuess(state, rawGuess, reply) {
  const guess = normalizeLetters(rawGuess);
  if (!guess || guess.length > 30) return reply(warn('Palpite inválido', 'envie uma letra ou uma palavra curta'));
  if (guess.length === 1) {
    if (state.guessed.includes(guess)) return reply(warn('Letra repetida', 'tente uma letra que ainda não apareceu'));
    state.guessed.push(guess);
    if (!state.word.includes(guess)) state.wrong += 1;
  } else if (guess === state.word) {
    finishSession(state, state.player.id);
    return reply(card([header('Forca', 'vitória'), `A palavra era ${state.word.toUpperCase()}.`, mono(renderHangmanBoard(state.wrong)), '_+3 pontos no placar deste chat._']));
  } else {
    state.wrong += 1;
  }
  const solved = Array.from(state.word).every((letter) => state.guessed.includes(letter));
  if (solved) {
    finishSession(state, state.player.id);
    return reply(card([header('Forca', 'vitória'), 'Você encontrou todas as letras.', mono(renderHangmanBoard(state.wrong)), `Palavra · ${state.word.toUpperCase()}`]));
  }
  if (state.wrong >= 6) {
    finishSession(state, 'loss');
    return reply(card([header('Forca', 'fim de jogo'), `A palavra era ${state.word.toUpperCase()}.`, mono(renderHangmanBoard(state.wrong))]));
  }
  return reply(hangmanText(state, guess.length === 1 ? `Palpite registrado: ${guess.toUpperCase()}.` : 'Palavra incorreta: uma vida a menos.'));
}

function coordinateIndex(value) {
  const match = String(value || '').trim().toUpperCase().match(/^([A-E])([1-5])$/);
  if (!match) return -1;
  return (Number(match[2]) - 1) * 5 + match[1].charCodeAt(0) - 65;
}

function coordinateName(index) {
  return `${String.fromCharCode(65 + (index % 5))}${Math.floor(index / 5) + 1}`;
}

function mineNeighbors(index) {
  const row = Math.floor(index / 5);
  const col = index % 5;
  const out = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const y = row + dy;
      const x = col + dx;
      if (y >= 0 && y < 5 && x >= 0 && x < 5) out.push(y * 5 + x);
    }
  }
  return out;
}

function initializeMines(state, safeIndex, rng = Math.random) {
  if (state.initialized) return;
  const candidates = Array.from({ length: 25 }, (_, index) => index).filter((index) => index !== safeIndex);
  for (let index = candidates.length - 1; index > 0; index--) {
    const other = randomIndex(index + 1, rng);
    [candidates[index], candidates[other]] = [candidates[other], candidates[index]];
  }
  state.mines = Array(25).fill(false);
  for (const index of candidates.slice(0, state.mineCount || 5)) state.mines[index] = true;
  state.initialized = true;
}

function adjacentMineCount(state, index) {
  return mineNeighbors(index).filter((neighbor) => state.mines[neighbor]).length;
}

export function createMinesweeperGame(player, rng = Math.random) {
  return {
    type: 'minado', player, creatorId: player.id, mineCount: 5, mines: Array(25).fill(false),
    initialized: false, revealed: Array(25).fill(false), flags: Array(25).fill(false), finished: false,
    rng
  };
}

export function toggleMinesweeperFlag(state, index) {
  if (!Number.isInteger(index) || index < 0 || index >= 25 || state.revealed[index]) return false;
  state.flags[index] = !state.flags[index];
  return state.flags[index];
}

export function revealMinesweeperCell(state, index, rng = state.rng || Math.random) {
  if (!Number.isInteger(index) || index < 0 || index >= 25) return { status: 'invalid', revealed: [] };
  if (state.flags[index]) return { status: 'flagged', revealed: [] };
  if (state.revealed[index]) return { status: 'already', revealed: [] };
  initializeMines(state, index, rng);
  if (state.mines[index]) {
    state.revealed[index] = true;
    return { status: 'mine', revealed: [index] };
  }
  const queue = [index];
  const opened = [];
  const seen = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (seen.has(current) || state.revealed[current] || state.flags[current] || state.mines[current]) continue;
    seen.add(current);
    state.revealed[current] = true;
    opened.push(current);
    if (adjacentMineCount(state, current) === 0) queue.push(...mineNeighbors(current));
  }
  const safeSquares = 25 - state.mineCount;
  const revealedSafe = state.revealed.reduce((sum, isRevealed, cell) => sum + (isRevealed && !state.mines[cell] ? 1 : 0), 0);
  return { status: revealedSafe >= safeSquares ? 'won' : 'safe', revealed: opened };
}

export function renderMinesweeperBoard(state) {
  const width = 23;
  const top = `┌${'─'.repeat(width)}┐`;
  const divider = `├${'─'.repeat(width)}┤`;
  const headerRow = `│${'   A   B   C   D   E   '}│`;
  const rows = [];
  for (let row = 0; row < 5; row++) {
    const cells = Array.from({ length: 5 }, (_, col) => {
      const index = row * 5 + col;
      if (state.flags[index]) return '[F]';
      if (!state.revealed[index]) return '[?]';
      if (state.mines[index]) return '[*]';
      const count = state.initialized ? adjacentMineCount(state, index) : 0;
      return count ? `[${count}]` : '[ ]';
    });
    rows.push(`│${`${row + 1} ${cells.join(' ')}`.padEnd(width)}│`);
    if (row < 4) rows.push(divider);
  }
  return [top, headerRow, divider, ...rows, `└${'─'.repeat(width)}┘`];
}

async function handleMinesweeper({ msg, args, reply, actor }) {
  const jid = msg.key.remoteJid;
  const state = activeFor(jid);
  const sub = String(args[0] || '').toLowerCase();
  if (['dica', 'ajuda', 'help'].includes(sub)) {
    if (!state || state.type !== 'minado') return reply(warn('Nenhuma partida de Campo minado ativa', 'inicie com `.minado`'));
    return reply(card([header('Campo minado', 'controles'), mono(renderMinesweeperBoard(state)), 'Revele A1–E5 com `.minado A1` ou envie a coordenada. Marque com `flag A1`.']));
  }
  if (['sair', 'cancelar', 'desistir'].includes(sub)) return cancelCurrentGame({ jid, actor, reply, owner: false });
  if (state?.type !== 'minado') {
    if (args.length) return reply(usage('.minado', '.minado', 'Comece uma partida antes de escolher uma casa.'));
    if (!canStart(jid, 'minado', reply)) return;
    const game = createMinesweeperGame(actor);
    setSession(jid, game);
    return reply(card([header('Campo minado', '5×5 · primeira casa segura'), mono(renderMinesweeperBoard(game)), '_Coordenadas A1–E5 · `.minado flag A1` marca uma casa._']));
  }
  if (state.player.id !== actor.id) return reply(warn('Partida individual', 'quem iniciou este Campo minado deve jogar'));
  if (!args.length) return reply(card([header('Campo minado', '5×5 · primeira casa segura'), mono(renderMinesweeperBoard(state)), '_Coordenadas A1–E5 · marque com `flag A1`._']));
  let action = 'reveal';
  let coordinate = args[0] || '';
  if (['flag', 'bandeira', 'marcar'].includes(sub)) {
    action = 'flag';
    coordinate = args[1] || '';
  } else if (['revelar', 'abrir', 'open'].includes(sub)) {
    coordinate = args[1] || '';
  }
  const index = coordinateIndex(coordinate);
  if (index < 0) return reply(usage('.minado <A1-E5> | .minado flag <A1-E5>', '.minado A1', 'A letra identifica a coluna; o número, a linha.'));
  if (action === 'flag') {
    const flagged = toggleMinesweeperFlag(state, index);
    if (flagged === false && state.revealed[index]) return reply(warn('Casa já revelada', 'não é possível marcar uma casa aberta'));
    return reply(card([header('Campo minado', flagged ? `bandeira em ${coordinateName(index)}` : `bandeira removida de ${coordinateName(index)}`), mono(renderMinesweeperBoard(state))]));
  }
  return applyMineReveal(state, index, reply);
}

async function applyMineReveal(state, index, reply) {
  const result = revealMinesweeperCell(state, index);
  if (result.status === 'already') return reply(warn('Casa já aberta', 'escolha uma casa ainda coberta'));
  if (result.status === 'flagged') return reply(warn('Casa marcada', 'retire a bandeira antes de revelar'));
  if (result.status === 'mine') {
    for (let cell = 0; cell < 25; cell++) if (state.mines[cell]) state.revealed[cell] = true;
    finishSession(state, 'loss');
    return reply(card([header('Campo minado', 'mina encontrada'), `A casa ${coordinateName(index)} tinha uma mina.`, mono(renderMinesweeperBoard(state))]));
  }
  if (result.status === 'won') {
    finishSession(state, state.player.id);
    return reply(card([header('Campo minado', 'vitória'), 'Todas as casas seguras foram abertas.', mono(renderMinesweeperBoard(state)), '_+3 pontos no placar deste chat._']));
  }
  const count = adjacentMineCount(state, index);
  return reply(card([header('Campo minado', 'jogada segura'), `${coordinateName(index)} · ${count ? `${count} mina(s) por perto` : 'área livre aberta'}.`, mono(renderMinesweeperBoard(state))]));
}

const ANAGRAM_WORDS = Object.freeze([
  ...HANGMAN_WORDS.filter(({ word }) => word.length >= 5 && word.length <= 10).map(({ word, category }) => ({ word, category })),
  { word: 'abacaxi', category: 'Alimentos' }, { word: 'amizade', category: 'Cotidiano' },
  { word: 'brasileiro', category: 'Cotidiano' }, { word: 'coragem', category: 'Cotidiano' }
]);

function scrambleWord(word, rng = Math.random) {
  const letters = Array.from(word);
  let result = word;
  for (let attempt = 0; attempt < 12 && result === word; attempt++) {
    for (let index = letters.length - 1; index > 0; index--) {
      const other = randomIndex(index + 1, rng);
      [letters[index], letters[other]] = [letters[other], letters[index]];
    }
    result = letters.join('');
  }
  if (result === word && word.length > 1) result = `${word.slice(1)}${word[0]}`;
  return result;
}

function anagramText(state, detail = '') {
  return card([
    header('Anagrama', state.category),
    detail || 'Descubra a palavra com as letras embaralhadas.',
    `▸ *${state.scrambled.toUpperCase()}*`,
    '_Responda com a palavra ou use `.anagrama dica`._'
  ]);
}

async function handleAnagram({ msg, args, reply, actor }) {
  const jid = msg.key.remoteJid;
  const state = activeFor(jid);
  const first = String(args[0] || '').toLowerCase();
  if (first === 'dica') {
    if (!state || state.type !== 'anagrama') return reply(warn('Nenhum Anagrama ativo', 'inicie com `.anagrama`'));
    return reply(anagramText(state, `Dica: categoria ${state.category.toLocaleLowerCase('pt-BR')}; começa com ${state.word[0].toUpperCase()}.`));
  }
  if (['desistir', 'sair', 'cancelar'].includes(first)) return cancelCurrentGame({ jid, actor, reply, owner: false });
  if (state?.type !== 'anagrama') {
    if (args.length) return reply(usage('.anagrama', '.anagrama', 'Comece uma rodada antes de enviar o palpite.'));
    if (!canStart(jid, 'anagrama', reply)) return;
    const entry = chooseOne(ANAGRAM_WORDS);
    const game = { type: 'anagrama', player: actor, creatorId: actor.id, word: entry.word, category: entry.category, scrambled: scrambleWord(entry.word), finished: false };
    setSession(jid, game);
    return reply(anagramText(game));
  }
  if (state.player.id !== actor.id) return reply(warn('Partida individual', 'quem iniciou este Anagrama deve responder'));
  if (!args.length) return reply(anagramText(state));
  return applyAnagramGuess(state, args.join(' '), reply);
}

async function applyAnagramGuess(state, rawGuess, reply) {
  const guess = normalizeLetters(rawGuess);
  if (!guess) return reply(warn('Palpite vazio', 'envie a palavra descoberta'));
  if (guess === state.word) {
    finishSession(state, state.player.id);
    return reply(card([header('Anagrama', 'vitória'), `A palavra era ${state.word.toUpperCase()}.`, '_+3 pontos no placar deste chat._']));
  }
  return reply(anagramText(state, 'Ainda não. Tente outra combinação.'));
}

const QUIZ_QUESTIONS = Object.freeze([
  { question: 'Qual é o maior planeta do Sistema Solar?', answers: ['jupiter'], hint: 'É um gigante gasoso.' },
  { question: 'Quantos lados tem um hexágono?', answers: ['6', 'seis'], hint: 'É um número par entre quatro e oito.' },
  { question: 'Qual é a capital do Brasil?', answers: ['brasilia'], hint: 'Fica no Distrito Federal.' },
  { question: 'Qual animal é conhecido como rei da selva?', answers: ['leao'], hint: 'É um felino de juba.' },
  { question: 'Qual é o resultado de 9 × 7?', answers: ['63', 'sessenta e tres'], hint: 'É três a menos que 66.' },
  { question: 'Em qual continente fica o Egito?', answers: ['africa'], hint: 'É o segundo maior continente.' },
  { question: 'Qual é o oceano entre a América e a Europa?', answers: ['atlantico', 'oceano atlantico'], hint: 'Seu nome começa com A.' },
  { question: 'Quantas cores há no arco-íris tradicional?', answers: ['7', 'sete'], hint: 'É um número primo.' },
  { question: 'Qual é o satélite natural da Terra?', answers: ['lua'], hint: 'É visível à noite.' },
  { question: 'Qual instrumento mede a temperatura?', answers: ['termometro'], hint: 'O nome termina com “metro”.' },
  { question: 'Qual é o idioma oficial do Brasil?', answers: ['portugues', 'lingua portuguesa'], hint: 'É uma língua românica.' },
  { question: 'Qual é o menor número primo?', answers: ['2', 'dois'], hint: 'É o único primo par.' },
  { question: 'Que gás as plantas absorvem na fotossíntese?', answers: ['dioxido de carbono', 'gas carbonico', 'co2'], hint: 'A fórmula é CO2.' },
  { question: 'Qual é o nome do processo em que a água vira vapor?', answers: ['evaporacao'], hint: 'Acontece com o calor.' },
  { question: 'Quantos minutos há em uma hora?', answers: ['60', 'sessenta'], hint: 'Seis dezenas.' },
  { question: 'Qual país tem formato aproximado de uma bota?', answers: ['italia'], hint: 'Sua capital é Roma.' },
  { question: 'Qual é o símbolo químico da água?', answers: ['h2o'], hint: 'Tem dois H e um O.' },
  { question: 'Qual órgão bombeia o sangue?', answers: ['coracao'], hint: 'Bate no peito.' },
  { question: 'Qual é o maior mamífero do mundo?', answers: ['baleia azul'], hint: 'Vive no oceano.' },
  { question: 'Quantos dias tem um ano bissexto?', answers: ['366', 'trezentos e sessenta e seis'], hint: 'Tem um dia a mais que o comum.' }
]);

function quizText(state, detail = '') {
  return card([
    header('Quiz', `pergunta ${state.number}`),
    state.question,
    detail || 'Responda diretamente ou use `.quiz <resposta>`.',
    '_Use `.quiz dica` para uma pista. Você tem até 3 tentativas._'
  ]);
}

async function handleQuiz({ msg, args, reply, actor }) {
  const jid = msg.key.remoteJid;
  const state = activeFor(jid);
  const first = String(args[0] || '').toLowerCase();
  if (first === 'dica') {
    if (!state || state.type !== 'quiz') return reply(warn('Nenhum Quiz ativo', 'inicie com `.quiz`'));
    return reply(quizText(state, `Dica: ${state.hint}`));
  }
  if (['passar', 'pular', 'desistir'].includes(first)) {
    if (!state || state.type !== 'quiz') return reply(warn('Nenhum Quiz ativo'));
    if (state.player.id !== actor.id) return reply(warn('Partida individual', 'quem iniciou o Quiz deve responder'));
    const answer = state.answers[0].toUpperCase();
    finishSession(state, 'loss');
    return reply(card([header('Quiz', 'rodada encerrada'), `Resposta: ${answer}.`]));
  }
  if (state?.type !== 'quiz') {
    if (args.length) return reply(usage('.quiz', '.quiz', 'Comece uma pergunta antes de enviar a resposta.'));
    if (!canStart(jid, 'quiz', reply)) return;
    const item = chooseOne(QUIZ_QUESTIONS);
    const game = { type: 'quiz', player: actor, creatorId: actor.id, question: item.question, answers: item.answers.map(normalizePhrase), hint: item.hint, number: 1, attempts: 0, finished: false };
    setSession(jid, game);
    return reply(quizText(game));
  }
  if (state.player.id !== actor.id) return reply(warn('Partida individual', 'quem iniciou este Quiz deve responder'));
  if (!args.length) return reply(quizText(state));
  return applyQuizGuess(state, args.join(' '), reply);
}

async function applyQuizGuess(state, rawGuess, reply) {
  const guess = normalizePhrase(rawGuess);
  if (!guess) return reply(warn('Resposta vazia', 'envie uma resposta curta'));
  if (state.answers.includes(guess)) {
    finishSession(state, state.player.id);
    return reply(card([header('Quiz', 'resposta certa'), 'Acertou! +3 pontos no placar deste chat.']));
  }
  state.attempts += 1;
  if (state.attempts >= 3) {
    finishSession(state, 'loss');
    return reply(card([header('Quiz', 'fim da rodada'), `A resposta era ${state.answers[0].toUpperCase()}.`]));
  }
  return reply(quizText(state, `Ainda não · ${3 - state.attempts} tentativa(s) restante(s).`));
}

function renderNumberHistoryTable(history = []) {
  const width = 33;
  const top = `┌${'─'.repeat(width)}┐`;
  const divider = `├${'─'.repeat(width)}┤`;
  const row = (text) => `│${String(text).slice(0, width).padEnd(width)}│`;
  const rows = history.slice(-8).map((entry, index) =>
    `${String(index + 1).padStart(2, '0')} | ${String(entry.guess).padStart(3, ' ')}   | ${String(entry.hint).toUpperCase()}`
  );
  return mono([top, row('N  | PALPITE | PISTA'), divider, ...(rows.length ? rows.map(row) : [row('Sem palpites ainda.')]), `└${'─'.repeat(width)}┘`]);
}

export { renderNumberHistoryTable };

function numberText(state, detail = '') {
  const remaining = Math.max(0, 8 - state.history.length);
  return card([
    header('Adivinhe o número', `${state.history.length}/8 palpites`),
    detail || `Pensei em um número de 1 a 100. Restam ${remaining} tentativa(s).`,
    renderNumberHistoryTable(state.history),
    '_Envie apenas o número ou use `.adivinhe <número>`._'
  ]);
}

async function handleNumberGame({ msg, args, reply, actor }) {
  const jid = msg.key.remoteJid;
  const state = activeFor(jid);
  const first = String(args[0] || '').toLowerCase();
  if (first === 'dica') {
    if (!state || state.type !== 'numero') return reply(warn('Nenhuma partida ativa', 'inicie com `.adivinhe`'));
    return reply(numberText(state, `O número está entre ${state.low} e ${state.high}.`));
  }
  if (['desistir', 'sair', 'cancelar'].includes(first)) return cancelCurrentGame({ jid, actor, reply, owner: false });
  if (state?.type !== 'numero') {
    if (args.length) return reply(usage('.adivinhe', '.adivinhe', 'Comece uma rodada antes de enviar um palpite.'));
    if (!canStart(jid, 'numero', reply)) return;
    const game = { type: 'numero', player: actor, creatorId: actor.id, secret: 1 + randomIndex(100), low: 1, high: 100, history: [], finished: false };
    setSession(jid, game);
    return reply(numberText(game));
  }
  if (state.player.id !== actor.id) return reply(warn('Partida individual', 'quem iniciou esta rodada deve enviar os palpites'));
  if (!args.length) return reply(numberText(state));
  return applyNumberGuess(state, args.join(' '), reply);
}

async function applyNumberGuess(state, rawGuess, reply) {
  const text = String(rawGuess ?? '').trim();
  if (!/^\d{1,3}$/.test(text)) return reply(warn('Palpite inválido', 'escolha um número inteiro entre 1 e 100'));
  const guess = Number(text);
  if (guess < 1 || guess > 100) return reply(warn('Fora do intervalo', 'o número secreto fica entre 1 e 100'));
  if (state.history.some((entry) => entry.guess === guess)) return reply(warn('Palpite repetido', 'tente um número diferente'));
  const hint = guess === state.secret ? 'ACERTO' : guess < state.secret ? 'MAIOR' : 'MENOR';
  state.history.push({ guess, hint });
  if (hint === 'ACERTO') {
    finishSession(state, state.player.id);
    return reply(card([header('Adivinhe o número', 'vitória'), `O número era ${guess}.`, renderNumberHistoryTable(state.history), '_+3 pontos no placar deste chat._']));
  }
  if (guess < state.secret) state.low = Math.max(state.low, guess + 1);
  else state.high = Math.min(state.high, guess - 1);
  if (state.history.length >= 8) {
    finishSession(state, 'loss');
    return reply(card([header('Adivinhe o número', 'fim de jogo'), `O número era ${state.secret}.`, renderNumberHistoryTable(state.history)]));
  }
  return reply(numberText(state, `Tente um número ${hint === 'MAIOR' ? 'maior' : 'menor'}.`));
}

const PPT_CHOICES = Object.freeze(['pedra', 'papel', 'tesoura']);

function normalizePptChoice(value) {
  const choice = normalizePhrase(value);
  if (['pedra', 'rocha'].includes(choice)) return 'pedra';
  if (choice === 'papel') return 'papel';
  if (['tesoura', 'tesouras'].includes(choice)) return 'tesoura';
  return null;
}

function pptWinner(first, second) {
  if (first === second) return null;
  if ((first === 'pedra' && second === 'tesoura') || (first === 'papel' && second === 'pedra') || (first === 'tesoura' && second === 'papel')) return 'first';
  return 'second';
}

async function handlePpt({ msg, args, reply, actor }) {
  const jid = msg.key.remoteJid;
  const state = activeFor(jid);
  const first = String(args[0] || '').toLowerCase();
  if (['aceitar', 'aceito', 'accept'].includes(first)) {
    if (!state || state.type !== 'ppt' || state.status !== 'pending' || state.players.O?.id !== actor.id) {
      return reply(warn('Nenhum convite seu para aceitar'));
    }
    state.status = 'playing';
    state.players.O = actor;
    return reply(card([header('Jokenpô', 'desafio aceito'), `${state.players.X.name} e ${state.players.O.name}: enviem .ppt pedra, .ppt papel ou .ppt tesoura para registrar a escolha.`]));
  }
  if (['recusar', 'recuso'].includes(first)) {
    if (!state || state.type !== 'ppt' || state.status !== 'pending' || state.players.O?.id !== actor.id) return reply(warn('Nenhum convite seu para recusar'));
    sessions.delete(chatKey(jid));
    return reply(warn('Convite recusado', 'a partida não foi iniciada'));
  }
  const opponent = opponentFromMessage(msg, actor);
  if (opponent) {
    if (!canStart(jid, 'ppt', reply)) return;
    const game = { type: 'ppt', mode: 'pvp', status: 'pending', players: { X: actor, O: opponent }, choices: {}, creatorId: actor.id, finished: false };
    setSession(jid, game);
    return reply({ text: `Desafio de Jokenpô para ${mentionTag(opponent.id)}. Aceite com .ppt aceitar.`, mentions: [opponent.id] });
  }

  const choice = normalizePptChoice(args.join(' '));
  if (!choice) return reply(usage('.ppt pedra|papel|tesoura', '.ppt pedra', 'Contra o bot; para PvP, marque alguém com `.ppt @oponente`.'));
  if (state?.type === 'ppt' && state.status === 'playing') return applyPptChoice(state, actor, choice, reply);
  if (state) return reply(warn('Há uma partida em andamento', 'resolva ou cancele a partida ativa antes de começar Jokenpô'));
  const botChoice = chooseOne(PPT_CHOICES);
  const outcome = pptWinner(choice, botChoice);
  if (outcome === 'first') {
    recordGameResult(jid, [actor], actor.id);
    return reply(card([header('Jokenpô', 'vitória'), `${choice.toUpperCase()} vence ${botChoice.toUpperCase()}. +3 pontos.`]));
  }
  if (outcome === 'second') {
    recordGameResult(jid, [actor], 'loss');
    return reply(card([header('Jokenpô', 'desta vez não'), `${botChoice.toUpperCase()} vence ${choice.toUpperCase()}. Tente de novo.`]));
  }
  recordGameResult(jid, [actor], null);
  return reply(card([header('Jokenpô', 'empate'), `Os dois escolheram ${choice.toUpperCase()}. +1 ponto.`]));
}

async function applyPptChoice(state, actor, choice, reply) {
  const playerKey = Object.keys(state.players).find((key) => state.players[key]?.id === actor.id);
  if (!playerKey) return reply(warn('Você não participa deste desafio'));
  if (state.choices[actor.id]) return reply(warn('Escolha já registrada', 'aguarde a escolha da outra pessoa'));
  state.choices[actor.id] = choice;
  const opponentKey = playerKey === 'X' ? 'O' : 'X';
  const opponent = state.players[opponentKey];
  if (!state.choices[opponent?.id]) return reply(`${SYM.wait} Escolha registrada. Aguardando ${opponent?.name || 'a outra pessoa'}.`);
  const first = state.choices[state.players.X.id];
  const second = state.choices[state.players.O.id];
  const outcome = pptWinner(first, second);
  finishSession(state, outcome === null ? null : outcome === 'first' ? state.players.X.id : state.players.O.id);
  const summary = `${state.players.X.name}: ${first.toUpperCase()} · ${state.players.O.name}: ${second.toUpperCase()}`;
  return reply(card([header('Jokenpô', outcome === null ? 'empate' : 'fim da rodada'), summary, outcome === null ? 'Cada pessoa recebe 1 ponto.' : `${outcome === 'first' ? state.players.X.name : state.players.O.name} venceu. +3 pontos.`]));
}

function renderDiceFace(value) {
  const patterns = {
    1: ['     ', '     ', '  *  ', '     ', '     '],
    2: ['*    ', '     ', '     ', '     ', '    *'],
    3: ['*    ', '     ', '  *  ', '     ', '    *'],
    4: ['*   *', '     ', '     ', '     ', '*   *'],
    5: ['*   *', '     ', '  *  ', '     ', '*   *'],
    6: ['*   *', '     ', '*   *', '     ', '*   *']
  };
  const face = patterns[value] || patterns[1];
  return [`┌${'─'.repeat(5)}┐`, ...face.map((row) => `│${row}│`), `└${'─'.repeat(5)}┘`];
}

export { renderDiceFace };

async function handleDice({ args, reply }) {
  const notation = String(args[0] || '').trim().toLowerCase();
  if (!notation) {
    const value = 1 + randomIndex(6);
    return reply(card([header('Dado', 'D6'), `Resultado · ${value}`, mono(renderDiceFace(value))]));
  }
  const match = notation.match(/^(\d{0,2})d(\d{1,4})$/);
  if (!match) return reply(usage('.dado [NdM]', '.dado 3d20', 'Até 20 dados por rolagem e 1.000 lados por dado.'));
  const count = Number(match[1] || 1);
  const sides = Number(match[2]);
  if (count < 1 || count > 20 || sides < 2 || sides > 1_000) return reply(fail('Rolagem fora do limite', 'use de 1 a 20 dados, com 2 a 1.000 lados'));
  const results = Array.from({ length: count }, () => 1 + randomIndex(sides));
  const total = results.reduce((sum, value) => sum + value, 0);
  const detail = `${count}d${sides} · [${results.join(', ')}] · total ${total}`;
  return reply(card([header('Dado', `${count}d${sides}`), detail, count === 1 && sides === 6 ? mono(renderDiceFace(results[0])) : '']));
}

async function handleCoin({ reply }) {
  const side = Math.random() < 0.5 ? 'CARA' : 'COROA';
  return reply(card([header('Moeda', 'cara ou coroa'), `Resultado · *${side}*`]));
}

async function handleRoulette({ args, reply }) {
  const raw = args.join(' ').trim();
  if (!raw) return reply(usage('.roleta opção 1 | opção 2 | ...', '.roleta pizza | sushi | massa', 'Informe de 2 a 20 opções separadas por |.'));
  const options = raw.split('|').map((item) => item.trim().replace(/[\r\n\u0000-\u001f*_~`]/g, '').slice(0, 60)).filter(Boolean);
  if (options.length < 2 || options.length > 20) return reply(fail('Opções inválidas', 'a roleta precisa de 2 a 20 opções separadas por |'));
  const selected = chooseOne(options);
  return reply(card([header('Roleta', `${options.length} opções`), `▸ Resultado · *${selected}*`]));
}

async function cancelCurrentGame({ jid, actor, reply, owner }) {
  const state = activeFor(jid);
  if (!state) return reply(warn('Nenhuma partida ativa neste chat'));
  if (!owner && !isPlayer(state, actor.id) && state.creatorId !== actor.id) return reply(warn('Somente quem participa pode encerrar esta partida'));
  sessions.delete(chatKey(jid));
  return reply(ok('Partida encerrada', 'o placar registrado permanece salvo'));
}

async function handleGameCommand(context) {
  const { sock, msg, name, args, reply, owner = false } = context;
  const actor = actorFor(msg);
  const game = ALIASES.get(String(name || '').toLocaleLowerCase('pt-BR'));
  if (game === 'jogos') {
    const action = String(args[0] || '').toLowerCase();
    if (['cancelar', 'parar', 'sair', 'stop'].includes(action)) return cancelCurrentGame({ jid: msg.key.remoteJid, actor, reply, owner });
    return reply(gameMenu());
  }
  if (game === 'placar') return handleScoreboard({ sock, msg, args, reply, owner });
  if (game === 'velha') return handleTicTacToe({ sock, msg, args, reply, actor });
  if (game === 'termo') return handleTermo({ msg, args, reply, actor });
  if (game === 'forca') return handleHangman({ msg, args, reply, actor });
  if (game === 'minado') return handleMinesweeper({ msg, args, reply, actor });
  if (game === 'anagrama') return handleAnagram({ msg, args, reply, actor });
  if (game === 'quiz') return handleQuiz({ msg, args, reply, actor });
  if (game === 'numero') return handleNumberGame({ msg, args, reply, actor });
  if (game === 'ppt') return handlePpt({ msg, args, reply, actor });
  if (game === 'dado') return handleDice({ args, reply });
  if (game === 'moeda') return handleCoin({ reply });
  if (game === 'roleta') return handleRoulette({ args, reply });
}

export { handleGameCommand };

/** Processa palpites sem prefixo, sempre limitado ao chat autorizado no roteador. */
export async function tryHandleDirectGameMove(sock, msg, text, { reply, authorized = false, owner = false } = {}) {
  if (!authorized && !owner) return false;
  const state = activeFor(msg?.key?.remoteJid);
  if (!state || state.finished) return false;
  const actor = actorFor(msg);
  const value = String(text || '').trim();
  if (!value || /^[.!/#]/.test(value)) return false;
  if (state.player && state.player.id !== actor.id) return false;

  if (state.type === 'ttt') {
    if (!isPlayer(state, actor.id) && !(state.status === 'open' && /^(entrar|entro|join)$/i.test(value))) return false;
    if (state.status === 'open' && /^(entrar|entro|join)$/i.test(value)) {
      await handleTicTacToe({ sock, msg, args: ['entrar'], reply, actor });
      return true;
    }
    if (/^[1-9]$/.test(value)) {
      await tttPlayerAction(state, actor, Number(value), reply);
      return true;
    }
    return false;
  }
  if (state.type === 'termo' && /^[A-Za-zÀ-ÿ]{5}$/.test(value)) {
    await applyTermoGuess(state, value, reply);
    return true;
  }
  if (state.type === 'forca' && /^[A-Za-zÀ-ÿ]{1,30}$/.test(value)) {
    await applyHangmanGuess(state, value, reply);
    return true;
  }
  if (state.type === 'minado') {
    const flag = value.match(/^flag\s+([A-E][1-5])$/i);
    const coord = value.match(/^([A-E][1-5])$/i);
    if (flag) {
      const index = coordinateIndex(flag[1]);
      if (state.player.id !== actor.id) await reply(warn('Partida individual', 'quem iniciou este Campo minado deve jogar'));
      else {
        const flagged = toggleMinesweeperFlag(state, index);
        if (flagged === false && state.revealed[index]) await reply(warn('Casa já revelada', 'não é possível marcar uma casa aberta'));
        else await reply(card([header('Campo minado', flagged ? `bandeira em ${coordinateName(index)}` : `bandeira removida de ${coordinateName(index)}`), mono(renderMinesweeperBoard(state))]));
      }
      return true;
    }
    if (coord) {
      if (state.player.id !== actor.id) await reply(warn('Partida individual', 'quem iniciou este Campo minado deve jogar'));
      else await applyMineReveal(state, coordinateIndex(coord[1]), reply);
      return true;
    }
    return false;
  }
  if (state.type === 'anagrama' && /^[A-Za-zÀ-ÿ]{2,30}$/.test(value)) {
    if (state.player.id !== actor.id) await reply(warn('Partida individual', 'quem iniciou este Anagrama deve responder'));
    else await applyAnagramGuess(state, value, reply);
    return true;
  }
  if (state.type === 'quiz' && value.length <= 100) {
    if (state.player.id !== actor.id) await reply(warn('Partida individual', 'quem iniciou o Quiz deve responder'));
    else await applyQuizGuess(state, value, reply);
    return true;
  }
  if (state.type === 'numero' && /^\d{1,3}$/.test(value)) {
    if (state.player.id !== actor.id) await reply(warn('Partida individual', 'quem iniciou esta rodada deve jogar'));
    else await applyNumberGuess(state, value, reply);
    return true;
  }
  if (state.type === 'ppt' && state.status === 'playing') {
    const choice = normalizePptChoice(value);
    if (!choice) return false;
    await applyPptChoice(state, actor, choice, reply);
    return true;
  }
  return false;
}
