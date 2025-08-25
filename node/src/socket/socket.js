const {
  enqueuePlayer,
  removeFromQueueBySocket,
  getGame,
  removeGame,
  makeMove,
  getAllGames
} = require('../gamemanager/matchmaking');
const { logGameResult } = require('./logGameResult');
const supabase = require('../supabase/supabaseClient');

const isDev = process.env.NODE_ENV === 'development';

module.exports = function(io) {
  const socketPlayerMap = new Map(); // socketId -> { playerId, gameId }
  const gameTimers = new Map(); // gameId -> intervalId
  const disconnectTimeouts = new Map(); // `${gameId}_${playerId}` -> { playerId, timeoutId }

  io.on('connection', (socket) => {
    console.log(`🔌 New client connected: ${socket.id}`);

    // --- queue handling (FIXED: consistent string ID handling) ---
    socket.on('joinQueue', async (data) => {
      let { playerId, isGuest, displayName } = data || {};
      console.log('Received joinQueue from', socket.id, 'playerId:', playerId, 'guest:', isGuest, 'displayName:', displayName);

      if (isDev) {
        // In development mode, keep the original playerId format (google_1, google_2, etc.)
        // Don't generate random IDs as they won't match existing users
        console.log(`Development mode: using original playerId ${playerId} for socket ${socket.id}`);
      } else if (!playerId) {
        io.to(socket.id).emit('queueError', { message: 'Missing playerId' });
        return;
      }

      // If displayName not provided, try to fetch it
      if (!displayName) {
        if (isGuest || (typeof playerId === 'string' && playerId.startsWith('guest_'))) {
          displayName = 'Guest';
        } else {
          // Try to get name from database
          try {
            const numericId = playerId.startsWith('google_') 
              ? parseInt(playerId.replace('google_', ''), 10)
              : parseInt(playerId, 10);
            
            const { data: user } = await supabase
              .from('users')
              .select('name')
              .eq('id', numericId)
              .single();
            
            displayName = user?.name || 'Unknown';
          } catch (error) {
            console.error('Error fetching user name for queue:', error);
            displayName = 'Unknown';
          }
        }
      }

      const result = enqueuePlayer({ socketId: socket.id, playerId, isGuest, displayName });
      if (!result) {
        io.to(socket.id).emit('queueError', { message: 'Already in queue' });
        return;
      }

      if (result.matched) {
        const { gameId, players } = result;
        console.log(`🎯 Match found! ${players[0].playerId} vs ${players[1].playerId} -> ${gameId}`);

        // store socket mapping
        players.forEach((player) => {
          socketPlayerMap.set(player.socketId, { playerId: player.playerId, gameId });
        });

        // Ensure game timers are initialized
        const game = getGame(gameId);
        if (game && !game.timers) {
          initializeTimers(game);
        }

        // start game timer monitor
        startGameTimer(gameId);

        players.forEach((player, idx) => {
          const symbol = idx === 0 ? 'X' : 'O';
          const opponent = players[idx === 0 ? 1 : 0];
          
          console.log(`Sending matchFound to ${player.socketId}: symbol=${symbol}, gameId=${gameId}, playerId=${player.playerId}`);

          io.to(player.socketId).emit('matchFound', {
            gameId,
            symbol,
            playerId: player.playerId,
            playerIndex: idx,
            opponentName: opponent.displayName,
            hasGuest: game.hasGuest,
            isRated: game.isRated
          });

          // send initial board state
          const g = getGame(gameId);
          if (g) sendBoardUpdate(g, player.socketId);
        });
      } else {
        io.to(socket.id).emit('queueUpdate', { position: result.queuePosition });
      }
    });

    // --- join existing game (reconnect or direct navigate) ---
    socket.on('joinGame', async ({ gameId, playerId }) => {
      console.log(`🎮 Player ${playerId} trying to join game ${gameId} with socket ${socket.id}`);

      const game = getGame(gameId);
      if (!game) {
        io.to(socket.id).emit('errorMessage', 'Game not found');
        return;
      }

      const playerIndex = game.players.findIndex(p => p.playerId === playerId);
      if (playerIndex === -1) {
        io.to(socket.id).emit('errorMessage', 'You are not in this game');
        return;
      }

      // Update the socket id for this player
      const oldSocketId = game.players[playerIndex].socketId;
      game.players[playerIndex].socketId = socket.id;
      game.players[playerIndex].disconnected = false;
      delete game.players[playerIndex].disconnectedAt;

      socketPlayerMap.set(socket.id, { playerId, gameId });

      // Initialize timers if missing
      if (!game.timers) initializeTimers(game);

      // Ensure the server timer monitor is running
      if (!gameTimers.has(gameId)) startGameTimer(gameId);

      const symbol = playerIndex === 0 ? 'X' : 'O';
      const opponent = game.players[playerIndex === 0 ? 1 : 0];
      
      // Get opponent name
      let opponentName = opponent.displayName || 'Unknown';

      io.to(socket.id).emit('matchFound', {
        gameId,
        symbol,
        playerId,
        playerIndex,
        opponentName: opponentName,
        hasGuest: game.hasGuest,
        isRated: game.isRated
      });

      // send current state to reconnected player
      sendBoardUpdate(game, socket.id);

      // notify opponent
      const connectedOpponent = game.players.find(p => p.playerId !== playerId && !p.disconnected);
      if (connectedOpponent) {
        io.to(connectedOpponent.socketId).emit('opponentReconnected');
      }

      // clear any disconnect timeout for this player
      const disconnectKey = `${gameId}_${playerId}`;
      if (disconnectTimeouts.has(disconnectKey)) {
        clearTimeout(disconnectTimeouts.get(disconnectKey).timeoutId);
        disconnectTimeouts.delete(disconnectKey);
        console.log(`Cleared disconnect timeout for player ${playerId} in game ${gameId}`);
      }

      // if game already finished, notify
      if (game.state.status !== 'playing') {
        const winner = convertPlayerIdToSymbol(game, game.state.winner);
        io.to(socket.id).emit('gameOver', {
          winner: winner || 'draw',
          reason: 'game_complete'
        });
      }
    });

    // --- AI Game join handling ---
    socket.on('joinAIGame', async ({ gameId, playerId }) => {
      console.log(`🤖 Player ${playerId} joining AI game ${gameId} with socket ${socket.id}`);

      global.aiGames = global.aiGames || new Map();
      const aiGameData = global.aiGames.get(gameId);
      
      if (!aiGameData) {
        io.to(socket.id).emit('errorMessage', 'AI Game not found');
        return;
      }

      const game = aiGameData.game;
      const humanPlayerId = aiGameData.humanPlayerId;
      
      if (playerId !== humanPlayerId) {
        io.to(socket.id).emit('errorMessage', 'You are not authorized for this AI game');
        return;
      }

      // Find human player in game and update socket
      const humanPlayerIndex = game.players.findIndex(p => p.playerId === humanPlayerId);
      if (humanPlayerIndex === -1) {
        io.to(socket.id).emit('errorMessage', 'Player not found in AI game');
        return;
      }

      // Update human player's socket ID
      game.players[humanPlayerIndex].socketId = socket.id;
      socketPlayerMap.set(socket.id, { playerId: humanPlayerId, gameId });

      // Initialize timers if missing
      if (!game.timers) initializeTimers(game);

      const humanSymbol = humanPlayerIndex === 0 ? 'X' : 'O';
      const aiPlayer = aiGameData.aiPlayer;

      // Send match found to human player
      io.to(socket.id).emit('matchFound', {
        gameId,
        symbol: humanSymbol,
        playerId: humanPlayerId,
        playerIndex: humanPlayerIndex,
        opponentName: aiPlayer.displayName,
        hasGuest: true, // Mark as having guest to show unrated
        isRated: false // AI games are unrated
      });

      // Send initial board state
      sendBoardUpdate(game, socket.id);

      // If it's AI's turn, trigger AI move
      if (game.state.turn === aiPlayer.playerId && game.state.status === 'playing') {
        console.log(`It's AI's turn in game ${gameId}`);
        handleAITurn(gameId);
      }
    });

    // --- make move from client ---
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

      // Calculate elapsed time for this player's turn and commit it now
      if (game.timers && game.turnStartTime) {
        const elapsed = Date.now() - game.turnStartTime;
        game.timers[player.playerId] = Math.max(0, (game.timers[player.playerId] || 0) - elapsed);
      }

      // Try to apply the move (your existing makeMove function handles move validation & game state)
      const moveResult = makeMove(gameId, player.playerId, index);
      if (!moveResult.ok) {
        io.to(socket.id).emit('errorMessage', moveResult.reason);
        return;
      }

      // If game not finished, start next player's turn
      if (game.state.status === 'playing' && !moveResult.finished) {
        game.turnStartTime = Date.now();
      }

      // Notify all connected players with fresh state (this also includes timers)
      game.players.forEach(p => {
        if (!p.disconnected) {
          sendBoardUpdate(game, p.socketId);
        }
      });

      if (moveResult.finished) {
        handleGameEnd(game, moveResult);
        // Log the game result - convert string playerId to number for database
        const winnerId = moveResult.winner ? convertPlayerIdToNumber(moveResult.winner) : null;
        logGameResult(game, winnerId);
      }
    });

    // --- AI move handling ---
    socket.on('makeAIMove', ({ gameId, index }) => {
      console.log(`AI Move attempt: gameId=${gameId}, index=${index}, socket=${socket.id}`);

      global.aiGames = global.aiGames || new Map();
      const aiGameData = global.aiGames.get(gameId);
      
      if (!aiGameData) {
        io.to(socket.id).emit('errorMessage', 'AI Game not found');
        return;
      }

      const game = aiGameData.game;
      const humanPlayerId = aiGameData.humanPlayerId;
      
      // Verify this is the human player
      const humanPlayer = game.players.find(p => p.playerId === humanPlayerId);
      if (!humanPlayer || humanPlayer.socketId !== socket.id) {
        io.to(socket.id).emit('errorMessage', 'Not authorized for this move');
        return;
      }

      if (game.state.turn !== humanPlayerId) {
        io.to(socket.id).emit('errorMessage', 'Not your turn');
        return;
      }

      // Calculate elapsed time for human player's turn
      if (game.timers && game.turnStartTime) {
        const elapsed = Date.now() - game.turnStartTime;
        game.timers[humanPlayerId] = Math.max(0, (game.timers[humanPlayerId] || 0) - elapsed);
      }

      // Make the move using existing game logic
      const moveResult = makeMove(gameId, humanPlayerId, index);
      if (!moveResult.ok) {
        io.to(socket.id).emit('errorMessage', moveResult.reason);
        return;
      }

      // Update turn start time
      if (game.state.status === 'playing' && !moveResult.finished) {
        game.turnStartTime = Date.now();
      }

      // Send board update to human player
      sendBoardUpdate(game, socket.id);

      if (moveResult.finished) {
        // Game ended
        handleGameEnd(game, moveResult);
        // Log the game result - convert string playerId to number for database
        const winnerId = moveResult.winner ? convertPlayerIdToNumber(moveResult.winner) : null;
        logGameResult(game, winnerId);
        // Clean up AI game
        global.aiGames.delete(gameId);
      } else {
        // It's now AI's turn
        const aiPlayer = aiGameData.aiPlayer;
        if (game.state.turn === aiPlayer.playerId) {
          console.log(`Triggering AI turn in game ${gameId}`);
          handleAITurn(gameId);
        }
      }
    });

    // --- disconnect handling ---
    socket.on('disconnect', () => {
      console.log(`❌ Client disconnected: ${socket.id}`);
      const mapping = socketPlayerMap.get(socket.id);
      if (mapping) {
        const { playerId, gameId } = mapping;
        
        // Check if this is an AI game
        global.aiGames = global.aiGames || new Map();
        const aiGameData = global.aiGames.get(gameId);
        
        if (aiGameData) {
          // This is an AI game - clean it up immediately
          console.log(`Cleaning up AI game ${gameId} after human disconnect`);
          const game = getGame(gameId);
          if (game) {
            // Stop any running timers
            if (gameTimers.has(gameId)) {
              clearInterval(gameTimers.get(gameId));
              gameTimers.delete(gameId);
            }
            removeGame(gameId);
          }
          global.aiGames.delete(gameId);
          socketPlayerMap.delete(socket.id);
          return;
        }
        
        // Regular multiplayer game disconnect handling
        const game = getGame(gameId);
        if (game && game.state.status === 'playing') {
          const player = game.players.find(p => p.playerId === playerId);
          if (player) {
            player.disconnected = true;
            player.disconnectedAt = Date.now();

            // notify opponent
            const opponent = game.players.find(p => p.playerId !== playerId && !p.disconnected);
            if (opponent) {
              io.to(opponent.socketId).emit('opponentDisconnected');
            }

            // determine remaining time for disconnected player to use as disconnect timeout cap
            let remainingTime = (game.timers && game.timers[playerId]) ? game.timers[playerId] : 60000;
            // if it was this player's turn, subtract elapsed so far
            if (game.state.turn === playerId && game.turnStartTime) {
              const elapsed = Date.now() - game.turnStartTime;
              remainingTime = Math.max(0, (game.timers[playerId] || 0) - elapsed);
            }

            const disconnectTimeoutDuration = Math.min(10000, remainingTime); // cap at 10s

            console.log(`Setting disconnect timeout for player ${playerId}: ${disconnectTimeoutDuration}ms`);

            const timeoutId = setTimeout(() => {
              const currentGame = getGame(gameId);
              if (currentGame && currentGame.state.status === 'playing') {
                const disconnectedPlayer = currentGame.players.find(p => p.playerId === playerId);
                if (disconnectedPlayer && disconnectedPlayer.disconnected) {
                  console.log(`Player ${playerId} failed to reconnect within ${disconnectTimeoutDuration}ms - they lose`);

                  // set to won and assign winner
                  currentGame.state.status = 'won';
                  const winner = currentGame.players.find(p => p.playerId !== playerId);
                  currentGame.state.winner = winner.playerId;

                  const winnerSymbol = convertPlayerIdToSymbol(currentGame, winner.playerId);

                  // notify remaining players
                  currentGame.players.forEach(p => {
                    if (!p.disconnected) {
                      io.to(p.socketId).emit('gameOver', {
                        winner: winnerSymbol,
                        reason: 'opponent_disconnect'
                      });
                    }
                  });

                  // Log the game result - convert string playerId to number for database
                  const winnerId = convertPlayerIdToNumber(winner.playerId);
                  logGameResult(currentGame, winnerId);

                  // clear monitor and remove game
                  if (gameTimers.has(gameId)) {
                    clearInterval(gameTimers.get(gameId));
                    gameTimers.delete(gameId);
                  }
                  removeGame(gameId);
                }
              }
              disconnectTimeouts.delete(`${gameId}_${playerId}`);
            }, disconnectTimeoutDuration);

            disconnectTimeouts.set(`${gameId}_${playerId}`, { playerId, timeoutId });
          }
        }

        socketPlayerMap.delete(socket.id);
      }

      // remove from queue if in it
      removeFromQueueBySocket(socket.id);
    });

    // ---------- AI helper functions ----------
    
    // Helper function to handle AI turns
    async function handleAITurn(gameId) {
      global.aiGames = global.aiGames || new Map();
      const aiGameData = global.aiGames.get(gameId);
      
      if (!aiGameData) return;

      const game = aiGameData.game;
      const aiPlayer = aiGameData.aiPlayer;
      const humanPlayerId = aiGameData.humanPlayerId;

      if (game.state.status !== 'playing' || game.state.turn !== aiPlayer.playerId) {
        return;
      }

      console.log(`AI is thinking in game ${gameId}...`);

      // Notify human player that AI is thinking
      const humanPlayer = game.players.find(p => p.playerId === humanPlayerId);
      if (humanPlayer && !humanPlayer.disconnected) {
        io.to(humanPlayer.socketId).emit('aiThinking', { message: `${aiPlayer.displayName} is thinking...` });
      }

      try {
        // Determine AI symbol
        const aiPlayerIndex = game.players.findIndex(p => p.playerId === aiPlayer.playerId);
        const aiSymbol = aiPlayerIndex === 0 ? 'X' : 'O';

        // Get AI move with simulated thinking delay
        aiPlayer.makeDelayedMove(game.state.board, aiSymbol, async (move) => {
          // Check if game is still active
          const currentGame = getGame(gameId);
          if (!currentGame || currentGame.state.status !== 'playing' || currentGame.state.turn !== aiPlayer.playerId) {
            console.log(`AI move cancelled - game state changed for ${gameId}`);
            return;
          }

          if (move === null) {
            console.log(`AI couldn't make a move in game ${gameId}`);
            return;
          }

          console.log(`AI chose position ${move} in game ${gameId}`);

          // Calculate elapsed time for AI's turn
          if (currentGame.timers && currentGame.turnStartTime) {
            const elapsed = Date.now() - currentGame.turnStartTime;
            currentGame.timers[aiPlayer.playerId] = Math.max(0, (currentGame.timers[aiPlayer.playerId] || 0) - elapsed);
          }

          // Make AI move using existing game logic
          const moveResult = makeMove(gameId, aiPlayer.playerId, move);
          if (!moveResult.ok) {
            console.error(`AI move failed in game ${gameId}:`, moveResult.reason);
            return;
          }

          // Update turn start time for next player
          if (currentGame.state.status === 'playing' && !moveResult.finished) {
            currentGame.turnStartTime = Date.now();
          }

          // Send board update to human player
          if (humanPlayer && !humanPlayer.disconnected) {
            sendBoardUpdate(currentGame, humanPlayer.socketId);
            
            // Clear AI thinking message
            io.to(humanPlayer.socketId).emit('aiMoveComplete', { 
              move: move,
              message: `${aiPlayer.displayName} chose position ${move}`
            });
          }

          if (moveResult.finished) {
            // Game ended
            handleGameEnd(currentGame, moveResult);
            // Log the game result
            const winnerId = moveResult.winner ? convertPlayerIdToNumber(moveResult.winner) : null;
            logGameResult(currentGame, winnerId);
            // Clean up AI game
            global.aiGames.delete(gameId);
          }
        });

      } catch (error) {
        console.error(`Error in AI turn for game ${gameId}:`, error);
        
        // Fallback: make random move
        const availableMoves = game.state.board
          .map((cell, index) => cell === null ? index : null)
          .filter(index => index !== null);
        
        if (availableMoves.length > 0) {
          const randomMove = availableMoves[Math.floor(Math.random() * availableMoves.length)];
          
          // Small delay then make the random move
          setTimeout(() => {
            const currentGame = getGame(gameId);
            if (currentGame && currentGame.state.status === 'playing') {
              const moveResult = makeMove(gameId, aiPlayer.playerId, randomMove);
              if (moveResult.ok && humanPlayer && !humanPlayer.disconnected) {
                sendBoardUpdate(currentGame, humanPlayer.socketId);
              }
            }
          }, 1000);
        }
      }
    }

    // ---------- existing helper functions ----------

    function initializeTimers(game) {
      // Start each player with 60k ms (1 minute) unless game already defines them
      game.timers = game.timers || {};
      game.players.forEach((p, idx) => {
        if (typeof game.timers[p.playerId] !== 'number') {
          game.timers[p.playerId] = 60000; // default 60s
        }
      });

      // Set initial turnStartTime if not present
      game.turnStartTime = game.turnStartTime || Date.now();
    }

    function startGameTimer(gameId) {
      // stop existing monitor for this game
      if (gameTimers.has(gameId)) {
        clearInterval(gameTimers.get(gameId));
      }

      const tickFn = () => {
        const game = getGame(gameId);
        if (!game || game.state.status !== 'playing') {
          if (gameTimers.has(gameId)) {
            clearInterval(gameTimers.get(gameId));
            gameTimers.delete(gameId);
          }
          return;
        }

        const currentPlayerId = game.state.turn;
        if (!currentPlayerId || !game.timers) return;

        // compute remaining without mutating base timers
        const elapsed = game.turnStartTime ? (Date.now() - game.turnStartTime) : 0;
        const remaining = Math.max(0, (game.timers[currentPlayerId] || 0) - elapsed);

        if (remaining <= 0) {
          // commit zero and trigger timeout handler
          game.timers[currentPlayerId] = 0;
          console.log(`⏰ Player ${currentPlayerId} timed out in game ${gameId}`);
          handleGameTimeout(game, currentPlayerId);

          //Log the game result - convert string playerId to number for database
          const winnerId = convertPlayerIdToNumber(game.state.winner);
          logGameResult(game, winnerId);

          // stop monitor for this game (handleGameTimeout will clear interval & remove game)
          if (gameTimers.has(gameId)) {
            clearInterval(gameTimers.get(gameId));
            gameTimers.delete(gameId);
          }
          return;
        }

        // otherwise, send periodic updates to any connected players (optional frequency)
        game.players.forEach(p => {
          if (!p.disconnected) sendBoardUpdate(game, p.socketId);
        });
      };

      // check every second
      const intervalId = setInterval(tickFn, 1000);
      gameTimers.set(gameId, intervalId);
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

      // cleanup
      if (gameTimers.has(game.id)) {
        clearInterval(gameTimers.get(game.id));
        gameTimers.delete(game.id);
      }
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

      // cleanup
      if (gameTimers.has(game.id)) {
        clearInterval(gameTimers.get(game.id));
        gameTimers.delete(game.id);
      }
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

    // Convert string playerId to number for database logging
    function convertPlayerIdToNumber(playerId) {
      if (!playerId) return null;
      
      // Handle development mode numeric strings
      if (/^\d+$/.test(playerId)) {
        return parseInt(playerId, 10);
      }
      
      // Handle google_X format
      if (playerId.startsWith('google_')) {
        const numericPart = playerId.replace('google_', '');
        return parseInt(numericPart, 10);
      }
      
      // Handle guest_X format or fallback
      if (playerId.startsWith('guest_')) {
        // For guest players, we might need a different approach
        // For now, return null since guests might not be stored in the users table
        return null;
      }
      
      // Fallback: try to parse as number
      const parsed = parseInt(playerId, 10);
      return isNaN(parsed) ? null : parsed;
    }

    // sendBoardUpdate: sends base timers (server stored) and currentPlayerTimer computed on-the-fly
    function sendBoardUpdate(game, socketId) {
      const displayBoard = convertBoardToSymbols(game);
      const currentTurnSymbol = convertPlayerIdToSymbol(game, game.state.turn);

      let currentPlayerTimer = null;
      if (game.timers && game.state.status === 'playing') {
        const elapsed = game.turnStartTime ? (Date.now() - game.turnStartTime) : 0;
        currentPlayerTimer = Math.max(0, (game.timers[game.state.turn] || 0) - elapsed);
      }

      // send base timers (no mutation) and the computed currentPlayerTimer + turnStartTime
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
        if (gameTimers.has(gameId)) {
          clearInterval(gameTimers.get(gameId));
          gameTimers.delete(gameId);
        }
        removeGame(gameId);
      }
    }
  });
};