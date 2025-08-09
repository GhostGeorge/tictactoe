// src/gamemanager/matchmaking.js
const { v4: uuidv4 } = require('uuid');

/**
 * Simple in-memory queue & activeGames.
 * For production move to persistent store.
 */

const queue = []; // array of socket.id entries: { socketId, playerId, isGuest, joinedAt }
const activeGames = new Map(); // gameId => game object

function enqueuePlayer({ socketId, playerId, isGuest }) {
  // prevent duplicate
  if (queue.find(p => p.playerId === playerId || p.socketId === socketId)) return null;

  const player = { socketId, playerId, isGuest: !!isGuest, joinedAt: Date.now() };
  queue.push(player);

  // if at least two players, match the oldest two (FIFO)
  if (queue.length >= 2) {
    const p1 = queue.shift();
    const p2 = queue.shift();

    const gameId = uuidv4();
    const game = createGame(gameId, p1, p2);
    activeGames.set(gameId, game);
    return { matched: true, gameId, players: [p1, p2] };
  }

  return { matched: false, queuePosition: queue.length };
}

function removeFromQueueBySocket(socketId) {
  const idx = queue.findIndex(p => p.socketId === socketId);
  if (idx >= 0) queue.splice(idx, 1);
}

function createGame(gameId, p1, p2, password = null) {
  const game = {
    id: gameId,
    players: [p1, p2], // objects with socketId, playerId, isGuest
    password: password || null,
    state: {
      board: Array(9).fill(null), // 0..8 cells
      turn: p1.playerId, // p1 starts
      status: 'playing', // 'playing', 'won', 'draw'
      winner: null
    },
    createdAt: Date.now(),
    lastActivity: Date.now()
  };
  return game;
}

function getGame(gameId) {
  return activeGames.get(gameId);
}

function removeGame(gameId) {
  activeGames.delete(gameId);
}

function makeMove(gameId, playerId, cellIndex) {
  const game = getGame(gameId);
  if (!game || game.state.status !== 'playing') return { ok: false, reason: 'invalid_game' };

  if (game.state.turn !== playerId) return { ok: false, reason: 'not_your_turn' };
  if (cellIndex < 0 || cellIndex > 8) return { ok: false, reason: 'invalid_cell' };
  if (game.state.board[cellIndex] !== null) return { ok: false, reason: 'cell_taken' };

  // mark move
  game.state.board[cellIndex] = playerId;
  game.lastActivity = Date.now();

  // check win/draw
  const winner = checkWinner(game.state.board);
  if (winner) {
    game.state.status = 'won';
    game.state.winner = playerId;
    return { ok: true, finished: true, winner: playerId, game };
  }

  // draw?
  if (game.state.board.every(c => c !== null)) {
    game.state.status = 'draw';
    return { ok: true, finished: true, draw: true, game };
  }

  // switch turn
  const other = game.players.find(p => p.playerId !== playerId);
  game.state.turn = other.playerId;
  return { ok: true, finished: false, game };
}

function checkWinner(board) {
  const wins = [
    [0,1,2],[3,4,5],[6,7,8], // rows
    [0,3,6],[1,4,7],[2,5,8], // cols
    [0,4,8],[2,4,6]          // diagonals
  ];
  for (const [a,b,c] of wins) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
  }
  return null;
}

function getAllGames() {
  // Return all active games as an object or Map
  return activeGames;
}

module.exports = {
  enqueuePlayer,
  removeFromQueueBySocket,
  createGame,
  getGame,
  removeGame,
  makeMove,
  getAllGames
};