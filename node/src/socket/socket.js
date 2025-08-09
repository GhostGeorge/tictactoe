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
          console.log(`Sending matchFound to ${player.socketId}: symbol=${symbol}, gameId=${gameId}, playerId=${player.playerId}`);
          
          // Send match found with the actual playerId that will be used in the game
          io.to(player.socketId).emit('matchFound', { 
            gameId, 
            symbol, 
            playerId: player.playerId // Include the actual playerId used in the game
          });
          
          // Also send initial board state
          const game = getGame(gameId);
          if (game) {
            io.to(player.socketId).emit('boardUpdate', { 
              board: game.state.board, 
              turn: game.state.turn 
            });
          }
        });
      } else {
        io.to(socket.id).emit('queueUpdate', { position: result.queuePosition });
      }
    });

    // Handle player joining an existing game (for reconnection)
    socket.on('joinGame', ({ gameId, playerId }) => {
      console.log(`🎮 Player ${playerId} trying to join game ${gameId} with socket ${socket.id}`);
      
      const game = getGame(gameId);
      if (!game) {
        console.log(`❌ Game ${gameId} not found. Available games:`, Array.from(getAllGames().keys()));
        io.to(socket.id).emit('errorMessage', 'Game not found');
        return;
      }

      console.log(`✅ Game found. Players in game:`, game.players.map(p => ({ playerId: p.playerId, socketId: p.socketId, disconnected: p.disconnected })));

      // Find the player in the game and update their socket ID
      const playerIndex = game.players.findIndex(p => p.playerId === playerId);
      
      if (playerIndex === -1) {
        console.log(`❌ Player ${playerId} not found in game ${gameId}. Valid players:`, game.players.map(p => p.playerId));
        io.to(socket.id).emit('errorMessage', 'You are not in this game');
        return;
      }

      // Update the player's socket ID and mark as reconnected
      const oldSocketId = game.players[playerIndex].socketId;
      game.players[playerIndex].socketId = socket.id;
      game.players[playerIndex].disconnected = false;
      delete game.players[playerIndex].disconnectedAt;
      console.log(`🔄 Updated socket ID for player ${playerId}: ${oldSocketId} → ${socket.id}`);

      // Initialize or update timers
      if (!game.timers) {
        game.timers = {};
        game.players.forEach(p => {
          game.timers[p.playerId] = 60000; // 1 minute per player
        });
        game.turnStartTime = Date.now();
      }

      // Send current game state
      const symbol = playerIndex === 0 ? 'X' : 'O';
      
      // Calculate remaining time for current player
      const currentTime = Date.now();
      const elapsedTime = currentTime - (game.turnStartTime || currentTime);
      const currentPlayerTimer = Math.max(0, game.timers[game.state.turn] - elapsedTime);
      
      console.log(`📡 Sending game state to ${socket.id}: symbol=${symbol}, turn=${game.state.turn}, timer=${currentPlayerTimer}`);
      
      io.to(socket.id).emit('matchFound', { gameId, symbol });
      io.to(socket.id).emit('boardUpdate', { 
        board: game.state.board, 
        turn: game.state.turn,
        timers: game.timers,
        currentPlayerTimer: currentPlayerTimer
      });

      // Notify opponent that player reconnected
      const opponent = game.players.find(p => p.playerId !== playerId && !p.disconnected);
      if (opponent) {
        io.to(opponent.socketId).emit('opponentReconnected');
      }

      if (game.state.status !== 'playing') {
        io.to(socket.id).emit('gameOver', {
          winner: game.state.winner || 'draw',
        });
      }
    });

    // Handle requests for current game state (legacy support)
    socket.on('getGameState', ({ gameId }) => {
      console.log(`Legacy getGameState called for ${gameId} from ${socket.id}`);
      io.to(socket.id).emit('errorMessage', 'Please refresh the page to reconnect');
    });

    socket.on('makeMove', ({ gameId, index }) => {
      console.log(`Move attempt: gameId=${gameId}, index=${index}, socket=${socket.id}`);
      
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

      // Check if it's the player's turn
      if (game.state.turn !== player.playerId) {
        io.to(socket.id).emit('errorMessage', 'Not your turn');
        return;
      }

      // Check timer
      if (game.timers) {
        const currentTime = Date.now();
        const elapsedTime = currentTime - game.turnStartTime;
        const remainingTime = game.timers[player.playerId] - elapsedTime;
        
        if (remainingTime <= 0) {
          // Player ran out of time
          game.state.status = 'won';
          const opponent = game.players.find(p => p.playerId !== player.playerId);
          game.state.winner = opponent.playerId;
          
          game.players.forEach(p => {
            if (!p.disconnected) {
              io.to(p.socketId).emit('gameOver', {
                winner: opponent.playerId,
                reason: 'timeout'
              });
            }
          });
          removeGame(gameId);
          return;
        }
        
        // Update remaining time for current player
        game.timers[player.playerId] = remainingTime;
      }

      console.log(`Player making move: ${player.playerId}, current turn: ${game.state.turn}`);

      const moveResult = makeMove(gameId, player.playerId, index);
      if (!moveResult.ok) {
        console.log(`Move failed: ${moveResult.reason}`);
        io.to(socket.id).emit('errorMessage', moveResult.reason);
        return;
      }

      console.log(`Move successful! New board:`, game.state.board);

      // Convert player IDs to symbols for display
      const displayBoard = game.state.board.map(cell => {
        if (!cell) return null;
        const playerIndex = game.players.findIndex(p => p.playerId === cell);
        return playerIndex === 0 ? 'X' : 'O';
      });

      // Reset timer for next player's turn
      if (game.timers && !moveResult.finished) {
        game.turnStartTime = Date.now();
      }

      // Send board update to both players with symbols instead of player IDs
      game.players.forEach(p => {
        if (!p.disconnected) {
          io.to(p.socketId).emit('boardUpdate', { 
            board: displayBoard, // Show X/O instead of player IDs
            turn: game.state.turn,
            timers: game.timers,
            turnStartTime: game.turnStartTime
          });
        }
      });

      if (moveResult.finished) {
        console.log(`Game finished! Winner: ${moveResult.winner || 'draw'}`);
        
        let displayWinner = 'draw';
        if (moveResult.winner) {
          const winnerIndex = game.players.findIndex(p => p.playerId === moveResult.winner);
          displayWinner = winnerIndex === 0 ? 'X' : 'O';
        }
        
        game.players.forEach(p => {
          if (!p.disconnected) {
            io.to(p.socketId).emit('gameOver', {
              winner: displayWinner,
              reason: 'game_complete'
            });
          }
        });
        removeGame(gameId);
      }
    });

    socket.on('disconnect', () => {
      console.log(`❌ Client disconnected: ${socket.id}`);

      removeFromQueueBySocket(socket.id);

      // Mark the player as disconnected but don't remove the game immediately
      const games = getAllGames();
      for (const [gameId, game] of games.entries()) {
        const player = game.players.find(p => p.socketId === socket.id);
        if (player) {
          console.log(`Player ${player.playerId} disconnected from game ${gameId} - marking as disconnected`);
          
          // Mark player as disconnected instead of removing game
          player.disconnected = true;
          player.disconnectedAt = Date.now();
          
          const opponent = game.players.find(p => p.socketId !== socket.id);
          if (opponent && !opponent.disconnected) {
            io.to(opponent.socketId).emit('opponentDisconnected');
          }
          
          // Only remove game if both players are disconnected for 5 minutes
          const bothDisconnected = game.players.every(p => p.disconnected);
          if (bothDisconnected) {
            setTimeout(() => {
              const currentGame = getGame(gameId);
              if (currentGame && currentGame.players.every(p => p.disconnected)) {
                console.log(`Removing abandoned game ${gameId} - both players disconnected`);
                removeGame(gameId);
              }
            }, 300000); // 5 minutes
          }
        }
      }
    });
  });
};