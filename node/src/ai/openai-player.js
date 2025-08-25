// src/ai/openai-player.js - AI player using OpenAI API

const OpenAI = require('openai');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY // Add this to your .env file
});

class AIPlayer {
  constructor(difficulty = 'medium') {
    this.difficulty = difficulty;
    this.playerId = 'ai_player';
    this.displayName = 'ChatGPT';
    this.isGuest = true; // Mark as guest to prevent rating updates
    this.socketId = 'ai_socket'; // Virtual socket ID
  }

  // Convert board array to readable format for AI
  boardToString(board) {
    const symbols = board.map(cell => {
      if (cell === null) return ' ';
      // Board now stores symbols directly
      return cell;
    });
    
    return `
 ${symbols[0]} | ${symbols[1]} | ${symbols[2]} 
-----------
 ${symbols[3]} | ${symbols[4]} | ${symbols[5]} 
-----------
 ${symbols[6]} | ${symbols[7]} | ${symbols[8]} 
    `.trim();
  }

  // Get difficulty-based system prompt
  getSystemPrompt() {
    const prompts = {
      easy: "You are a casual tic-tac-toe player. Make reasonable moves but don't always play optimally. You might miss some winning opportunities or defensive moves occasionally.",
      medium: "You are a competent tic-tac-toe player. Play well but not perfectly. You should block obvious winning moves and take clear wins, but you can make strategic mistakes sometimes.",
      hard: "You are an expert tic-tac-toe player. Play optimally using minimax strategy. Always block opponent wins and take any winning moves immediately."
    };
    
    return prompts[this.difficulty] || prompts.medium;
  }

  // Get AI move using OpenAI API
  async getMove(board, aiSymbol) {
    try {
      // Check if API key is configured
      if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY.trim() === '') {
        console.log('OpenAI API key not configured, using fallback strategy');
        return this.getStrategicFallbackMove(board, aiSymbol);
      }

      const boardString = this.boardToString(board);
      const availableMoves = board
        .map((cell, index) => cell === null ? index : null)
        .filter(index => index !== null);

      if (availableMoves.length === 0) {
        console.log('No available moves, game is over');
        return null;
      }

      const prompt = `
You are playing tic-tac-toe. You are ${aiSymbol}.

Current board state:
${boardString}

Available moves (0-8, left to right, top to bottom): ${availableMoves.join(', ')}

Position mapping:
 0 | 1 | 2 
-----------
 3 | 4 | 5 
-----------
 6 | 7 | 8 

Choose your next move by responding with ONLY the position number (0-8). No explanation needed.
      `;

      console.log(`Requesting AI move for ${aiSymbol} with difficulty ${this.difficulty}`);
      
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini", // Fast and cost-effective for this task
        messages: [
          { role: "system", content: this.getSystemPrompt() },
          { role: "user", content: prompt }
        ],
        max_tokens: 10,
        temperature: this.difficulty === 'easy' ? 0.8 : 0.3
      });

      const moveText = response.choices[0].message.content.trim();
      const move = parseInt(moveText);

      // Validate the move
      if (isNaN(move) || move < 0 || move > 8 || board[move] !== null) {
        console.log(`AI returned invalid move: ${moveText}, falling back to strategic move`);
        return this.getStrategicFallbackMove(board, aiSymbol);
      }

      console.log(`AI chose move: ${move} (position ${move})`);
      return move;

    } catch (error) {
      console.error('OpenAI API error:', error);
      
      // Log specific error details for debugging
      if (error.status === 401) {
        console.error('OpenAI API authentication failed. Please check your API key in the .env file.');
        console.error('Make sure OPENAI_API_KEY is set to a valid API key from https://platform.openai.com/account/api-keys');
      } else if (error.status === 429) {
        console.error('OpenAI API rate limit exceeded. Using fallback strategy.');
      } else if (error.status >= 500) {
        console.error('OpenAI API server error. Using fallback strategy.');
      } else {
        console.error('OpenAI API error:', error.message);
      }
      
      // Fallback to strategic move
      return this.getStrategicFallbackMove(board, aiSymbol);
    }
  }

  // Strategic fallback move when OpenAI API is unavailable
  getStrategicFallbackMove(board, aiSymbol) {
    const availableMoves = board
      .map((cell, index) => cell === null ? index : null)
      .filter(index => index !== null);
    
    if (availableMoves.length === 0) return null;
    
    // Try to win if possible
    const winningMove = this.findWinningMove(board, aiSymbol);
    if (winningMove !== null) {
      console.log(`Fallback AI found winning move: ${winningMove}`);
      return winningMove;
    }
    
    // Try to block opponent from winning
    const opponentSymbol = aiSymbol === 'X' ? 'O' : 'X';
    const blockingMove = this.findWinningMove(board, opponentSymbol);
    if (blockingMove !== null) {
      console.log(`Fallback AI found blocking move: ${blockingMove}`);
      return blockingMove;
    }
    
    // Take center if available
    if (board[4] === null) {
      console.log('Fallback AI taking center position');
      return 4;
    }
    
    // Take corners if available
    const corners = [0, 2, 6, 8];
    const availableCorners = corners.filter(pos => board[pos] === null);
    if (availableCorners.length > 0) {
      const randomCorner = availableCorners[Math.floor(Math.random() * availableCorners.length)];
      console.log(`Fallback AI taking corner position: ${randomCorner}`);
      return randomCorner;
    }
    
    // Take edges if available
    const edges = [1, 3, 5, 7];
    const availableEdges = edges.filter(pos => board[pos] === null);
    if (availableEdges.length > 0) {
      const randomEdge = availableEdges[Math.floor(Math.random() * availableEdges.length)];
      console.log(`Fallback AI taking edge position: ${randomEdge}`);
      return randomEdge;
    }
    
    // Fallback to random move
    const randomIndex = Math.floor(Math.random() * availableMoves.length);
    const randomMove = availableMoves[randomIndex];
    console.log(`Fallback AI making random move: ${randomMove}`);
    return randomMove;
  }
  
  // Find a winning move for a given symbol
  findWinningMove(board, symbol) {
    const wins = [
      [0,1,2],[3,4,5],[6,7,8], // rows
      [0,3,6],[1,4,7],[2,5,8], // cols
      [0,4,8],[2,4,6]          // diagonals
    ];
    
    for (const [a, b, c] of wins) {
      // Check if two positions are filled with the symbol and one is empty
      if (board[a] === symbol && board[b] === symbol && board[c] === null) return c;
      if (board[a] === symbol && board[c] === symbol && board[b] === null) return b;
      if (board[b] === symbol && board[c] === symbol && board[a] === null) return a;
    }
    
    return null;
  }
  
  // Fallback random move (kept for backward compatibility)
  getRandomMove(availableMoves) {
    if (availableMoves.length === 0) return null;
    const randomIndex = Math.floor(Math.random() * availableMoves.length);
    return availableMoves[randomIndex];
  }

  // Simulate AI "thinking" delay
  async makeDelayedMove(board, aiSymbol, callback) {
    // Add a realistic delay (1-3 seconds)
    const thinkingTime = Math.random() * 2000 + 1000;
    
    setTimeout(async () => {
      try {
        const move = await this.getMove(board, aiSymbol);
        callback(move);
      } catch (error) {
        console.error('Error in makeDelayedMove:', error);
        // Use fallback strategy if there's an error
        const fallbackMove = this.getStrategicFallbackMove(board, aiSymbol);
        callback(fallbackMove);
      }
    }, thinkingTime);
  }
}

module.exports = AIPlayer;