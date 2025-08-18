// src/socket/logGameResult.js - Updated to properly handle guest games
const supabase = require('../supabase/supabaseClient');

// ELO calculation constant
const K = 32; // adjust for faster/slower rating changes

const isDev = process.env.NODE_ENV === 'development';

function calculateElo(playerRating, opponentRating, score) {
  const expected = 1 / (1 + Math.pow(10, (opponentRating - playerRating) / 400));
  return Math.round(playerRating + K * (score - expected));
}

/**
 * Get the actual users.id and rating
 */
async function getUserId(playerId) {
  if (!playerId) return null;

  // Handle guest players
  if (typeof playerId === 'string' && playerId.startsWith('guest_')) {
    return null; // Don't log guest games
  }

  // Extract the numeric ID from playerId format
  let userId;
  if (typeof playerId === 'string' && playerId.startsWith('google_')) {
    userId = parseInt(playerId.replace('google_', ''), 10);
  } else if (typeof playerId === 'number') {
    // Handle case where winner ID was converted to number
    userId = playerId;
  } else {
    console.error('Unknown playerId format:', playerId, 'Expected google_X format or number');
    return null;
  }

  // Look up user by id (primary key)
  const { data: existingUser, error: selectError } = await supabase
    .from('users')
    .select('id, rating')
    .eq('id', userId)
    .single();

  if (selectError) {
    if (selectError.code === 'PGRST116') {
      console.log(`No user found with id: ${userId}`);
    } else {
      console.error('Error looking up user by id:', userId, selectError);
    }
    return null;
  }

  return existingUser;
}

/**
 * Log a game and update player ratings
 * @param {Object} game - game object from socket.js
 * @param {string|number|null} winnerId - playerId of winner, null if draw
 */
async function logGameResult(game, winnerId) {
  try {
    console.log('Logging game result. Game info:', {
      gameId: game.id,
      hasGuest: game.hasGuest,
      isRated: game.isRated,
      player1: game.players[0].playerId,
      player2: game.players[1].playerId,
      winner: winnerId
    });

    // Skip logging if game has guests (not rated)
    if (game.hasGuest || !game.isRated) {
      console.log('Skipping game log - game includes guest player(s) and is not rated');
      return;
    }

    // Get actual user database IDs
    const playerX = await getUserId(game.players[0].playerId);
    const playerO = await getUserId(game.players[1].playerId);
    const winner = winnerId ? await getUserId(winnerId) : null;

    console.log('Resolved users:', {
      playerX: playerX?.id,
      playerO: playerO?.id,
      winner: winner?.id
    });

    // Skip logging if any player is missing (guest or lookup failed)
    if (!playerX || !playerO) {
      console.log('Skipping game log - could not resolve all players');
      return;
    }

    // 1️⃣ Insert game record
    const gameInsert = await supabase.from('games').insert([{
      player_x_id: playerX.id,
      player_o_id: playerO.id,
      winner_id: winner?.id || null,
      state: JSON.stringify(game.state.board)
    }]);

    if (gameInsert.error) {
      console.error('Error inserting game record:', gameInsert.error);
      return;
    }

    console.log('Game record inserted successfully');

    // 2️⃣ Calculate new ratings using the data we already have
    const ratingX = playerX.rating || 1000;
    const ratingO = playerO.rating || 1000;

    console.log('Current ratings:', { playerX: ratingX, playerO: ratingO });

    // 3️⃣ Calculate new ratings
    let scoreX, scoreO;
    if (!winner) {
      scoreX = 0.5;
      scoreO = 0.5;
    } else if (winner.id === playerX.id) {
      scoreX = 1;
      scoreO = 0;
    } else {
      scoreX = 0;
      scoreO = 1;
    }

    const newRatingX = calculateElo(ratingX, ratingO, scoreX);
    const newRatingO = calculateElo(ratingO, ratingX, scoreO);

    console.log('New ratings calculated:', { newRatingX, newRatingO });

    // 4️⃣ Update user ratings
    const updateX = await supabase.from('users').update({ rating: newRatingX }).eq('id', playerX.id);
    const updateO = await supabase.from('users').update({ rating: newRatingO }).eq('id', playerO.id);

    if (updateX.error) console.error('Error updating player X rating:', updateX.error);
    if (updateO.error) console.error('Error updating player O rating:', updateO.error);

    console.log(`Rated game logged successfully. New ratings: ${playerX.id}=${newRatingX}, ${playerO.id}=${newRatingO}`);
  } catch (err) {
    console.error('Error logging game result:', err);
  }
}

module.exports = { logGameResult };