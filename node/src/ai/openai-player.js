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
      return cell.includes('google_') || cell.includes('guest_') ? 'X' : 'O';
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
      const boardString = this.boardToString(board);
      const availableMoves = board
        .map((cell, index) => cell === null ? index : null)
        .filter(index => index !== null);

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
        console.log(`AI returned invalid move: ${moveText}, falling back to random`);
        return this.getRandomMove(availableMoves);
      }

      console.log(`AI chose move: ${move} (position ${move})`);
      return move;

    } catch (error) {
      console.error('OpenAI API error:', error);
      // Fallback to random move
      const availableMoves = board
        .map((cell, index) => cell === null ? index : null)
        .filter(index => index !== null);
      return this.getRandomMove(availableMoves);
    }
  }

  // Fallback random move
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
      const move = await this.getMove(board, aiSymbol);
      callback(move);
    }, thinkingTime);
  }
}

module.exports = AIPlayer;