// gameLogger.js
const supabase = require('../supabase/supabaseClient');

// ELO calculation constant
const K = 32; // adjust for faster/slower rating changes

function calculateElo(playerRating, opponentRating, score) {
  const expected = 1 / (1 + Math.pow(10, (opponentRating - playerRating) / 400));
  return Math.round(playerRating + K * (score - expected));
}

/**
 * Log a game and update player ratings
 * @param {Object} game - game object from socket.js
 * @param {string|null} winnerId - playerId of winner, null if draw
 */
async function logGameResult(game, winnerId) {
  try {
    const playerXId = game.players[0].playerId;
    const playerOId = game.players[1].playerId;

    // 1️⃣ Insert game record
    await supabase.from('games').insert([{
      player_x_id: playerXId,
      player_o_id: playerOId,
      winner_id: winnerId,
      state: JSON.stringify(game.state.board)
    }]);

    // 2️⃣ Fetch current ratings
    const { data: players, error: playersError } = await supabase
      .from('users')
      .select('id,rating')
      .in('id', [playerXId, playerOId]);

    if (playersError) throw playersError;

    const playerX = players.find(p => p.id === playerXId);
    const playerO = players.find(p => p.id === playerOId);

    // Default rating if not set
    const ratingX = playerX.rating || 1000;
    const ratingO = playerO.rating || 1000;

    // 3️⃣ Calculate new ratings
    let scoreX, scoreO;
    if (!winnerId) {
      scoreX = 0.5;
      scoreO = 0.5;
    } else if (winnerId === playerXId) {
      scoreX = 1;
      scoreO = 0;
    } else {
      scoreX = 0;
      scoreO = 1;
    }

    const newRatingX = calculateElo(ratingX, ratingO, scoreX);
    const newRatingO = calculateElo(ratingO, ratingX, scoreO);

    // 4️⃣ Update user ratings
    await supabase.from('users').update({ rating: newRatingX }).eq('id', playerXId);
    await supabase.from('users').update({ rating: newRatingO }).eq('id', playerOId);

    console.log(`Game logged. New ratings: ${playerXId}=${newRatingX}, ${playerOId}=${newRatingO}`);
  } catch (err) {
    console.error('Error logging game result:', err);
  }
}

module.exports = { logGameResult };
