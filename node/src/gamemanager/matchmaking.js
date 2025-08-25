// src/gamemanager/matchmaking.js - Updated to include player names and guest status

const { v4: uuidv4 } = require('uuid');

/**
 * Simple in-memory queue & activeGames.
 * For production move to persistent store.
 */

const queue = []; // array of socket.id entries: { socketId, playerId, isGuest, joinedAt, displayName }
const activeGames = new Map(); // gameId => game object

function enqueuePlayer({ socketId, playerId, isGuest, displayName }) {
  // prevent duplicate
  if (queue.find(p => p.playerId === playerId || p.socketId === socketId)) return null;

  const player = { 
    socketId, 
    playerId, 
    isGuest: !!isGuest, 
    displayName: displayName || (isGuest ? 'Guest' : 'Unknown'),
    joinedAt: Date.now() 
  };
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
    players: [p1, p2], // objects with socketId, playerId, isGuest, displayName
    password: password || null,
    hasGuest: p1.isGuest || p2.isGuest, // Track if game has guest
    isRated: !(p1.isGuest || p2.isGuest), // Game is rated only if no guests
    state: {
      board: Array(9).fill(null), // 0..8 cells
      turn: p1.playerId, // p1 starts (X player)
      status: 'playing', // 'playing', 'won', 'draw'
      winner: null
    },
    timers: {
      [p1.playerId]: 60000, // 60 seconds per player
      [p2.playerId]: 60000
    },
    turnStartTime: Date.now(),
    createdAt: Date.now(),
    lastActivity: Date.now()
  };
  
  console.log(`Created game ${gameId} with players:`, {
    player1: { id: p1.playerId, socket: p1.socketId, name: p1.displayName, guest: p1.isGuest },
    player2: { id: p2.playerId, socket: p2.socketId, name: p2.displayName, guest: p2.isGuest },
    isRated: game.isRated
  });
  
  return game;
}

function getGame(gameId) {
  // First check regular games
  const regularGame = activeGames.get(gameId);
  if (regularGame) {
    return regularGame;
  }
  
  // Then check AI games
  if (global.aiGames && global.aiGames.has(gameId)) {
    console.log(`Found AI game ${gameId} in global.aiGames`);
    return global.aiGames.get(gameId).game;
  }
  
  // Debug logging
  console.log(`Game ${gameId} not found in activeGames (${activeGames.size} games)`);
  if (global.aiGames) {
    console.log(`AI games available: ${global.aiGames.size} games`);
    for (const [id, data] of global.aiGames.entries()) {
      console.log(`  AI Game ${id}: ${data.difficulty} difficulty`);
    }
  } else {
    console.log('global.aiGames is not initialized');
  }
  
  return null;
}

function removeGame(gameId) {
  console.log(`Removing game ${gameId}`);
  
  // Remove from regular games
  activeGames.delete(gameId);
  
  // Remove from AI games if it exists there
  if (global.aiGames && global.aiGames.has(gameId)) {
    console.log(`Removing AI game ${gameId}`);
    global.aiGames.delete(gameId);
  }
}

function makeMove(gameId, playerId, cellIndex) {
  console.log(`makeMove called: gameId=${gameId}, playerId=${playerId}, cellIndex=${cellIndex}`);
  
  const game = getGame(gameId);
  if (!game) {
    console.log(`makeMove: Game ${gameId} not found`);
    return { ok: false, reason: 'invalid_game' };
  }
  
  console.log(`makeMove: Game ${gameId} found, status=${game.state.status}, turn=${game.state.turn}`);

  if (game.state.status !== 'playing') {
    console.log(`makeMove: Game ${gameId} is not in playing state: ${game.state.status}`);
    return { ok: false, reason: 'game_not_active' };
  }

  if (game.state.turn !== playerId) {
    console.log(`makeMove: Not player's turn. Expected: ${game.state.turn}, Got: ${playerId}`);
    return { ok: false, reason: 'not_your_turn' };
  }

  if (cellIndex < 0 || cellIndex > 8) {
    console.log(`makeMove: Invalid cell index: ${cellIndex}`);
    return { ok: false, reason: 'invalid_cell' };
  }

  if (game.state.board[cellIndex] !== null) {
    console.log(`makeMove: Cell ${cellIndex} is already taken: ${game.state.board[cellIndex]}`);
    return { ok: false, reason: 'cell_taken' };
  }

  // Make the move - store symbol (X or O) for display, but track player ID for logic
  const playerIndex = game.players.findIndex(p => p.playerId === playerId);
  const symbol = playerIndex === 0 ? 'X' : 'O';
  game.state.board[cellIndex] = symbol;
  game.lastActivity = Date.now();

  console.log(`Move made by ${playerId} at position ${cellIndex}`);
  console.log(`Board state:`, game.state.board);

  // Check for winner
  const winnerSymbol = checkWinner(game.state.board);
  if (winnerSymbol) {
    game.state.status = 'won';
    // Find the player ID that corresponds to the winning symbol
    const winnerPlayerIndex = winnerSymbol === 'X' ? 0 : 1;
    const winnerPlayerId = game.players[winnerPlayerIndex].playerId;
    game.state.winner = winnerPlayerId;
    console.log(`Game ${gameId} won by ${winnerPlayerId} (${winnerSymbol})`);
    return { ok: true, finished: true, winner: winnerPlayerId, game };
  }

  // Check for draw
  if (game.state.board.every(c => c !== null)) {
    game.state.status = 'draw';
    console.log(`Game ${gameId} ended in draw`);
    return { ok: true, finished: true, draw: true, game };
  }

  // Switch turns
  const currentPlayerIndex = game.players.findIndex(p => p.playerId === playerId);
  const nextPlayerIndex = currentPlayerIndex === 0 ? 1 : 0;
  const nextPlayer = game.players[nextPlayerIndex];
  
  game.state.turn = nextPlayer.playerId;
  console.log(`Turn switched from ${playerId} to ${nextPlayer.playerId}`);

  return { ok: true, finished: false, game };
}

function checkWinner(board) {
  const wins = [
    [0,1,2],[3,4,5],[6,7,8], // rows
    [0,3,6],[1,4,7],[2,5,8], // cols
    [0,4,8],[2,4,6]          // diagonals
  ];
  
  for (const [a,b,c] of wins) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      console.log(`Winner found: ${board[a]} with line [${a},${b},${c}]`);
      return board[a]; // Returns 'X' or 'O'
    }
  }
  return null;
}

function getAllGames() {
  // Combine regular games and AI games
  const allGames = new Map(activeGames);
  
  if (global.aiGames) {
    for (const [gameId, aiGameData] of global.aiGames.entries()) {
      allGames.set(gameId, aiGameData.game);
    }
  }
  
  return allGames;
}

// Utility function to get game stats for debugging
function getGameStats() {
  const stats = {
    totalGames: activeGames.size,
    queueLength: queue.length,
    games: []
  };
  
  // Add regular games
  for (const [gameId, game] of activeGames.entries()) {
    stats.games.push({
      id: gameId,
      type: 'regular',
      status: game.state.status,
      turn: game.state.turn,
      isRated: game.isRated,
      hasGuest: game.hasGuest,
      players: game.players.map(p => ({
        id: p.playerId,
        socket: p.socketId,
        name: p.displayName,
        guest: p.isGuest,
        disconnected: p.disconnected || false
      })),
      createdAt: new Date(game.createdAt).toISOString(),
      lastActivity: new Date(game.lastActivity).toISOString()
    });
  }
  
  // Add AI games
  if (global.aiGames) {
    for (const [gameId, aiGameData] of global.aiGames.entries()) {
      const game = aiGameData.game;
      stats.games.push({
        id: gameId,
        type: 'ai',
        status: game.state.status,
        turn: game.state.turn,
        isRated: game.isRated,
        hasGuest: game.hasGuest,
        difficulty: aiGameData.difficulty,
        players: game.players.map(p => ({
          id: p.playerId,
          socket: p.socketId,
          name: p.displayName,
          guest: p.isGuest,
          disconnected: p.disconnected || false
        })),
        createdAt: new Date(game.createdAt).toISOString(),
        lastActivity: new Date(game.lastActivity).toISOString()
      });
    }
  }
  
  stats.totalGames = stats.games.length;
  return stats;
}

// Clean up old games periodically
setInterval(() => {
  const now = Date.now();
  const maxAge = 30 * 60 * 1000; // 30 minutes
  
  for (const [gameId, game] of activeGames.entries()) {
    if (now - game.lastActivity > maxAge) {
      console.log(`Cleaning up old game ${gameId} (inactive for ${Math.floor((now - game.lastActivity) / 1000)}s)`);
      activeGames.delete(gameId);
    }
  }
}, 5 * 60 * 1000); // Run every 5 minutes

module.exports = {
  enqueuePlayer,
  removeFromQueueBySocket,
  createGame,
  getGame,
  removeGame,
  makeMove,
  getAllGames,
  getGameStats
};