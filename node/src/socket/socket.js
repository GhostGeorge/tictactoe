const {
  enqueuePlayer,
  removeFromQueueBySocket,
  getGame,
  removeGame,
  makeMove,
  getAllGames
} = require('../gamemanager/matchmaking');

const isDev = process.env.NODE_ENV === 'development';

module.exports = function(io) {
  io.on('connection', (socket) => {
    console.log(`🔌 New client connected: ${socket.id}`);

    socket.on('joinQueue', (data) => {
      let { playerId, isGuest } = data || {};
      console.log('Received joinQueue from', socket.id, 'playerId:', playerId, 'guest:', isGuest);

      if (isDev) {
        playerId = 'dev_' + Math.random().toString(36).substring(2, 10);
        console.log(`Development mode: assigned random playerId ${playerId} for socket ${socket.id}`);
      } else if (!playerId) {
        io.to(socket.id).emit('queueError', { message: 'Missing playerId' });
        return;
      }

      const result = enqueuePlayer({ socketId: socket.id, playerId, isGuest });
      if (!result) {
        io.to(socket.id).emit('queueError', { message: 'Already in queue' });
        return;
      }

      if (result.matched) {
        const { gameId, players } = result;
        console.log(`🎯 Match found! ${players[0].playerId} vs ${players[1].playerId} -> ${gameId}`);

        players.forEach((player, idx) => {
          const symbol = idx === 0 ? 'X' : 'O';
          io.to(player.socketId).emit('matchFound', { gameId, symbol });
        });
      } else {
        io.to(socket.id).emit('queueUpdate', { position: result.queuePosition });
      }
    });

    socket.on('makeMove', ({ gameId, index }) => {
      const game = getGame(gameId);
      if (!game) {
        io.to(socket.id).emit('errorMessage', 'Game not found');
        return;
      }

      const player = game.players.find(p => p.socketId === socket.id);
      if (!player) {
        io.to(socket.id).emit('errorMessage', 'You are not in this game');
        return;
      }

      const moveResult = makeMove(gameId, player.playerId, index);
      if (!moveResult.ok) {
        io.to(socket.id).emit('errorMessage', moveResult.reason);
        return;
      }

      game.players.forEach(p => {
        io.to(p.socketId).emit('boardUpdate', { board: game.state.board, turn: game.state.turn });
      });

      if (moveResult.finished) {
        game.players.forEach(p => {
          io.to(p.socketId).emit('gameOver', {
            winner: moveResult.winner || 'draw',
          });
        });
        removeGame(gameId);
      }
    });

    socket.on('disconnect', () => {
      console.log(`❌ Client disconnected: ${socket.id}`);

      removeFromQueueBySocket(socket.id);

      const games = getAllGames();
      for (const [gameId, game] of games.entries()) {
        const player = game.players.find(p => p.socketId === socket.id);
        if (player) {
          const opponent = game.players.find(p => p.socketId !== socket.id);
          if (opponent) {
            io.to(opponent.socketId).emit('opponentDisconnected');
          }
          removeGame(gameId);
        }
      }
    });
  });
};