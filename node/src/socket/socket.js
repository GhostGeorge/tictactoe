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
  // Store socket-to-player mappings for better tracking
  const socketPlayerMap = new Map(); // socketId -> { playerId, gameId }
  
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

        // Store socket mappings
        players.forEach((player) => {
          socketPlayerMap.set(player.socketId, { playerId: player.playerId, gameId });
        });

        players.forEach((player, idx) => {
          const symbol = idx === 0 ? 'X' : 'O';
          console.log(`Sending matchFound to ${player.socketId}: symbol=${symbol}, gameId=${gameId}, playerId=${player.playerId}`);
          
          io.to(player.socketId).emit('matchFound', { 
            gameId, 
            symbol, 
            playerId: player.playerId,
            playerIndex: idx
          });
          
          // Send initial board state with proper symbols
          const game = getGame(gameId);
          if (game) {
            sendBoardUpdate(game, player.socketId);
          }
        });
      } else {
        io.to(socket.id).emit('queueUpdate', { position: result.queuePosition });
      }
    });

    socket.on('joinGame', ({ gameId, playerId }) => {
      console.log(`🎮 Player ${playerId} trying to join game ${gameId} with socket ${socket.id}`);
      
      const game = getGame(gameId);
      if (!game) {
        console.log(`❌ Game ${gameId} not found`);
        io.to(socket.id).emit('errorMessage', 'Game not found');
        return;
      }

      const playerIndex = game.players.findIndex(p => p.playerId === playerId);
      if (playerIndex === -1) {
        console.log(`❌ Player ${playerId} not found in game ${gameId}`);
        io.to(socket.id).emit('errorMessage', 'You are not in this game');
        return;
      }

      // Update socket mapping and player connection status
      const oldSocketId = game.players[playerIndex].socketId;
      game.players[playerIndex].socketId = socket.id;
      game.players[playerIndex].disconnected = false;
      delete game.players[playerIndex].disconnectedAt;
      
      socketPlayerMap.set(socket.id, { playerId, gameId });
      
      console.log(`🔄 Updated socket ID for player ${playerId}: ${oldSocketId} → ${socket.id}`);

      // Initialize timers if not already done
      if (!game.timers) {
        initializeTimers(game);
      }

      const symbol = playerIndex === 0 ? 'X' : 'O';
      console.log(`📡 Sending game state to ${socket.id}: symbol=${symbol}`);
      
      io.to(socket.id).emit('matchFound', { 
        gameId, 
        symbol, 
        playerId,
        playerIndex
      });
      
      sendBoardUpdate(game, socket.id);

      // Notify opponent of reconnection
      const opponent = game.players.find(p => p.playerId !== playerId && !p.disconnected);
      if (opponent) {
        io.to(opponent.socketId).emit('opponentReconnected');
      }

      // Handle finished games
      if (game.state.status !== 'playing') {
        const winner = convertPlayerIdToSymbol(game, game.state.winner);
        io.to(socket.id).emit('gameOver', {
          winner: winner || 'draw',
          reason: 'game_complete'
        });
      }
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

      if (game.state.turn !== player.playerId) {
        io.to(socket.id).emit('errorMessage', 'Not your turn');
        return;
      }

      // Check and update timer
      if (game.timers) {
        const timeoutResult = updatePlayerTimer(game, player.playerId);
        if (timeoutResult.timeout) {
          handleGameTimeout(game, player.playerId);
          return;
        }
      }

      const moveResult = makeMove(gameId, player.playerId, index);
      if (!moveResult.ok) {
        console.log(`Move failed: ${moveResult.reason}`);
        io.to(socket.id).emit('errorMessage', moveResult.reason);
        return;
      }

      console.log(`Move successful! New turn: ${game.state.turn}`);

      // Reset timer for next turn
      if (game.timers && !moveResult.finished) {
        game.turnStartTime = Date.now();
      }

      // Send updates to all connected players
      game.players.forEach(p => {
        if (!p.disconnected) {
          sendBoardUpdate(game, p.socketId);
        }
      });

      if (moveResult.finished) {
        handleGameEnd(game, moveResult);
      }
    });

    socket.on('disconnect', () => {
      console.log(`❌ Client disconnected: ${socket.id}`);
      
      const mapping = socketPlayerMap.get(socket.id);
      if (mapping) {
        const { playerId, gameId } = mapping;
        const game = getGame(gameId);
        
        if (game) {
          const player = game.players.find(p => p.playerId === playerId);
          if (player) {
            console.log(`Player ${playerId} disconnected from game ${gameId}`);
            player.disconnected = true;
            player.disconnectedAt = Date.now();
            
            // Notify opponent
            const opponent = game.players.find(p => p.playerId !== playerId && !p.disconnected);
            if (opponent) {
              io.to(opponent.socketId).emit('opponentDisconnected');
            }
            
            // Clean up abandoned games after 5 minutes
            setTimeout(() => {
              cleanupAbandonedGame(gameId);
            }, 300000);
          }
        }
        
        socketPlayerMap.delete(socket.id);
      }

      // Remove from queue if they were waiting
      removeFromQueueBySocket(socket.id);
    });

    // Helper functions
    function initializeTimers(game) {
      game.timers = {};
      game.players.forEach(p => {
        game.timers[p.playerId] = 60000; // 60 seconds
      });
      game.turnStartTime = Date.now();
    }

    function updatePlayerTimer(game, playerId) {
      const currentTime = Date.now();
      const elapsedTime = currentTime - (game.turnStartTime || currentTime);
      const remainingTime = game.timers[playerId] - elapsedTime;
      
      if (remainingTime <= 0) {
        return { timeout: true, remainingTime: 0 };
      }
      
      game.timers[playerId] = remainingTime;
      return { timeout: false, remainingTime };
    }

    function handleGameTimeout(game, timedOutPlayerId) {
      console.log(`Player ${timedOutPlayerId} timed out`);
      
      game.state.status = 'won';
      const opponent = game.players.find(p => p.playerId !== timedOutPlayerId);
      game.state.winner = opponent.playerId;
      
      const winnerSymbol = convertPlayerIdToSymbol(game, opponent.playerId);
      
      game.players.forEach(p => {
        if (!p.disconnected) {
          io.to(p.socketId).emit('gameOver', {
            winner: winnerSymbol,
            reason: 'timeout'
          });
        }
      });
      
      removeGame(game.id);
    }

    function handleGameEnd(game, moveResult) {
      console.log(`Game finished! Winner: ${moveResult.winner || 'draw'}`);
      
      let displayWinner = 'draw';
      if (moveResult.winner) {
        displayWinner = convertPlayerIdToSymbol(game, moveResult.winner);
      }
      
      game.players.forEach(p => {
        if (!p.disconnected) {
          io.to(p.socketId).emit('gameOver', {
            winner: displayWinner,
            reason: 'game_complete'
          });
        }
      });
      
      removeGame(game.id);
    }

    function convertPlayerIdToSymbol(game, playerId) {
      if (!playerId) return null;
      const playerIndex = game.players.findIndex(p => p.playerId === playerId);
      return playerIndex === 0 ? 'X' : 'O';
    }

    function convertBoardToSymbols(game) {
      return game.state.board.map(cell => {
        if (!cell) return null;
        return convertPlayerIdToSymbol(game, cell);
      });
    }

    function sendBoardUpdate(game, socketId) {
      const displayBoard = convertBoardToSymbols(game);
      const currentTurnSymbol = convertPlayerIdToSymbol(game, game.state.turn);
      
      // Calculate current timer state
      let currentPlayerTimer = null;
      if (game.timers && game.state.status === 'playing') {
        const currentTime = Date.now();
        const elapsedTime = currentTime - (game.turnStartTime || currentTime);
        currentPlayerTimer = Math.max(0, game.timers[game.state.turn] - elapsedTime);
      }
      
      io.to(socketId).emit('boardUpdate', {
        board: displayBoard,
        turn: currentTurnSymbol,
        timers: game.timers ? {
          [game.players[0].playerId]: game.timers[game.players[0].playerId],
          [game.players[1].playerId]: game.timers[game.players[1].playerId]
        } : null,
        currentPlayerTimer,
        turnStartTime: game.turnStartTime
      });
    }

    function cleanupAbandonedGame(gameId) {
      const game = getGame(gameId);
      if (game && game.players.every(p => p.disconnected)) {
        console.log(`Removing abandoned game ${gameId}`);
        removeGame(gameId);
      }
    }
  });
};