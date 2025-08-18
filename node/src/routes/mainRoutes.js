// Import
const express = require('express');
const router = express.Router();
const passport = require('passport');
const ensureGuestOrLoggedIn = require('../middlewares/protection');
const { enqueuePlayer, getGame, removeGame, getGameStats } = require('../gamemanager/matchmaking');

console.log("Main routes loaded");

// Controllers
const indexController = require('../controllers/indexController');

// GET Routes
router.get('/test-error', (req, res) => {throw new Error('This is a test error!');}); // Show the errorHandler working

// Initialise Supabase client
const supabase = require('../supabase/supabaseClient');

// Debug route for development
if (process.env.NODE_ENV === 'development') {
  router.get('/debug/games', (req, res) => {
    res.json(getGameStats());
  });
}

// Landing page - shows login or guest options
router.get('/', (req, res) => {
  console.log('GET /', {
    isAuthenticated: req.isAuthenticated(),
    guest: req.session.guest
  });
  if (req.isAuthenticated()) {
    return res.redirect('/home');
  }
  if (req.session.guest) {
    return res.redirect('/home');
  }
  res.render('landing');
});

// Home page - shows after login or guest
router.get('/home', ensureGuestOrLoggedIn, async (req, res) => {
  console.log('GET /home', {
    isAuthenticated: req.isAuthenticated(),
    guest: req.session.guest
  });

  try {
    // Fetch leaderboard data
    const leaderboardData = await getLeaderboardData();
    
    res.render('home', {
      user: req.user,
      guest: req.session.guest,
      leaderboard: leaderboardData
    });
  } catch (error) {
    console.error('Error fetching leaderboard data:', error);
    // Render without leaderboard data if there's an error
    res.render('home', {
      user: req.user,
      guest: req.session.guest,
      leaderboard: null
    });
  }
});

// Guest route
router.post('/guest', (req, res) => {
  req.session.guest = true;
  req.session.save(err => {
    if (err) {
      console.error('Session save error:', err);
      return res.redirect('/');
    }
    res.redirect('/home');
  });
});

// Game routes - Updated queue route to include player name
router.get('/queue', ensureGuestOrLoggedIn, (req, res) => {
  // Generate consistent player ID based on authentication status
  let playerId, playerName;
  if (req.user && req.user.id) {
    playerId = `google_${req.user.id}`;
    playerName = req.user.name || 'Unknown User';
  } else {
    playerId = `guest_${req.sessionID}`;
    playerName = 'Guest';
  }
  
  const guest = req.session.guest === true;
  
  // Store player info in session for consistency
  req.session.playerId = playerId;
  req.session.playerName = playerName;
  req.session.isGuest = guest;
  
  console.log(`Queue route: playerId=${playerId}, name=${playerName}, guest=${guest}, sessionID=${req.sessionID}`);
  
  res.render('queue', { playerId, playerName, guest });
});

// Game page route - Updated to pass player name
router.get('/game/:gameId', ensureGuestOrLoggedIn, (req, res) => {
  const gameId = req.params.gameId;
  const game = getGame(gameId);

  if (!game) {
    console.log(`Game ${gameId} not found. Redirecting to home.`);
    return res.redirect('/home?error=game_not_found');
  }

  // Determine player ID and name consistently
  let playerId, playerName;
  if (req.query.playerId) {
    // Use query parameter if provided (from queue redirect)
    playerId = req.query.playerId;
    // Try to get name from session or derive it
    if (req.session.playerName) {
      playerName = req.session.playerName;
    } else if (req.user && req.user.name) {
      playerName = req.user.name;
    } else if (playerId.startsWith('guest_')) {
      playerName = 'Guest';
    } else {
      playerName = 'Unknown';
    }
  } else if (req.user && req.user.id) {
    // Generate from Google auth
    playerId = `google_${req.user.id}`;
    playerName = req.user.name || 'Unknown User';
  } else {
    // Generate from session ID for guests
    playerId = `guest_${req.sessionID}`;
    playerName = 'Guest';
  }
  
  console.log(`Game route: gameId=${gameId}, playerId=${playerId}, name=${playerName}, sessionID=${req.sessionID}`);
  console.log(`Game players:`, game.players.map(p => ({ 
    playerId: p.playerId, 
    socketId: p.socketId,
    displayName: p.displayName,
    isGuest: p.isGuest,
    disconnected: p.disconnected || false
  })));

  // Check if this player is actually in this game
  const isPlayerInGame = game.players.some(p => p.playerId === playerId);
  
  if (!isPlayerInGame) {
    console.log(`Player ${playerId} not authorized for game ${gameId}`);
    console.log(`Valid players:`, game.players.map(p => p.playerId));
    return res.redirect('/home?error=not_in_game');
  }

  // Store current game info in session
  req.session.currentGameId = gameId;
  req.session.currentPlayerId = playerId;
  req.session.currentPlayerName = playerName;

  res.render('game', {
    gameId,
    playerId,
    playerName,
    guest: req.session.guest || false,
  });
});

// Playing a friend - redirect to password page
router.get('/play-friend', ensureGuestOrLoggedIn, (req, res) => {
  res.render('playFriend');
});

// Handle friend game creation/joining (placeholder for now)
router.post('/play-friend', ensureGuestOrLoggedIn, (req, res) => {
  const { gamePassword } = req.body;
  
  if (!gamePassword) {
    return res.redirect('/play-friend?error=missing_password');
  }
  
  // TODO: Implement password-protected games
  res.redirect('/home?message=friend_games_coming_soon');
});

// Google authentication routes
router.get("/auth/google",
  passport.authenticate("google", { scope: ["profile", "email"] }));

router.get("/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/?error=auth_failed" }),
  async (req, res) => {
    try {
      const { id, displayName } = req.user; // Google info
      const email = req.user.emails?.[0]?.value || req.user._json?.email;

      console.log('Google auth successful for user:', id);

      // Check if user exists
      const { data: existingUser, error: selectError } = await supabase
        .from('users')
        .select('*')
        .eq('id', id)
        .single();

      if (selectError && selectError.code !== 'PGRST116') { // 116 = no rows found
        console.error('Supabase select error:', selectError);
      }

      if (!existingUser) {
        // Insert new user with default elo
        const { data: insertedUser, error: insertError } = await supabase
          .from('users')
          .insert([{ id, email, name: displayName, elo: 1000 }])
          .select(); // fetch inserted row

        if (insertError) console.error('Supabase insert error:', insertError);
        else console.log('New user inserted:', insertedUser);
      } else {
        console.log('User already exists:', existingUser);

        // Update email and name if they changed
        const updates = {};
        if (existingUser.email !== email) updates.email = email;
        if (existingUser.name !== displayName) updates.name = displayName;

        if (Object.keys(updates).length > 0) {
          const { data: updatedUser, error: updateError } = await supabase
            .from('users')
            .update(updates)
            .eq('id', id)
            .select();

          if (updateError) console.error('Supabase update error:', updateError);
          else console.log('User updated:', updatedUser);
        }
      }

      // Save in session
      req.session.userId = id;
      req.session.email = email;

      res.redirect("/home");
    } catch (err) {
      console.error('Error handling Google login:', err);
      res.redirect("/?error=internal_error");
    }

    console.log('Google profile object:', req.user);
  });

router.get("/logout", (req, res) => {
  const wasGuest = req.session.guest;
  const userId = req.user ? req.user.id : 'guest';
  
  req.logout(() => {
    req.session.destroy((err) => {
      if (err) {
        console.error('Session destruction error:', err);
      }
      console.log(`User ${userId} logged out${wasGuest ? ' (was guest)' : ''}`);
      res.redirect("/");
    });
  });
});

// Helper method for fetching leaderboard data
// More efficient leaderboard data fetching
async function getLeaderboardData() {
  const supabase = require('../supabase/supabaseClient');

  try {
    // 1. Top 5 players by rating
    const { data: topRated, error: ratingError } = await supabase
      .from('users')
      .select('id, name, rating')
      .order('rating', { ascending: false })
      .limit(5);

    if (ratingError) throw ratingError;

    // 2. Get all games to calculate statistics
    const { data: allGames, error: gamesError } = await supabase
      .from('games')
      .select('player_x_id, player_o_id, winner_id, created_at');

    if (gamesError) throw gamesError;

    // 3. Get all users for name mapping
    const { data: allUsers, error: usersError } = await supabase
      .from('users')
      .select('id, name');

    if (usersError) throw usersError;

    // Create user name mapping
    const userMap = {};
    allUsers.forEach(user => {
      userMap[user.id] = user.name;
    });

    // Calculate game statistics
    const playerStats = {};
    
    allGames.forEach(game => {
      // Count games for player X
      if (!playerStats[game.player_x_id]) {
        playerStats[game.player_x_id] = { 
          games: 0, 
          wins: 0, 
          name: userMap[game.player_x_id] || 'Unknown'
        };
      }
      playerStats[game.player_x_id].games++;
      
      // Count games for player O
      if (!playerStats[game.player_o_id]) {
        playerStats[game.player_o_id] = { 
          games: 0, 
          wins: 0, 
          name: userMap[game.player_o_id] || 'Unknown'
        };
      }
      playerStats[game.player_o_id].games++;

      // Count wins
      if (game.winner_id) {
        if (!playerStats[game.winner_id]) {
          playerStats[game.winner_id] = { 
            games: 0, 
            wins: 0, 
            name: userMap[game.winner_id] || 'Unknown'
          };
        }
        playerStats[game.winner_id].wins++;
      }
    });

    // Calculate win rates and sort
    Object.keys(playerStats).forEach(playerId => {
      const stats = playerStats[playerId];
      stats.winRate = stats.games > 0 ? (stats.wins / stats.games * 100).toFixed(1) : 0;
      stats.losses = stats.games - stats.wins;
    });

    // Top 5 by games played
    const topGameCounts = Object.entries(playerStats)
      .sort((a, b) => b[1].games - a[1].games)
      .slice(0, 5)
      .map(([id, stats]) => ({
        id,
        name: stats.name,
        games: stats.games,
        wins: stats.wins,
        losses: stats.losses,
        winRate: stats.winRate
      }));

    // Top 5 by win rate (minimum 3 games)
    const topWinRates = Object.entries(playerStats)
      .filter(([id, stats]) => stats.games >= 3)
      .sort((a, b) => parseFloat(b[1].winRate) - parseFloat(a[1].winRate))
      .slice(0, 5)
      .map(([id, stats]) => ({
        id,
        name: stats.name,
        games: stats.games,
        wins: stats.wins,
        winRate: stats.winRate
      }));

    // Recent games with proper names
    const recentGames = allGames
      .slice(-5)
      .reverse()
      .map(game => ({
        playerX: userMap[game.player_x_id] || 'Unknown',
        playerO: userMap[game.player_o_id] || 'Unknown',
        winner: game.winner_id ? userMap[game.winner_id] : 'Draw',
        createdAt: game.created_at
      }));

    return {
      topRated: topRated || [],
      topGameCounts: topGameCounts || [],
      topWinRates: topWinRates || [],
      recentGames: recentGames || [],
      totalGames: allGames.length,
      totalUsers: allUsers.length,
      activePlayersCount: Object.keys(playerStats).length
    };

  } catch (error) {
    console.error('Error in getLeaderboardData:', error);
    return {
      topRated: [],
      topGameCounts: [],
      topWinRates: [],
      recentGames: [],
      totalGames: 0,
      totalUsers: 0,
      activePlayersCount: 0
    };
  }
}

// Export
module.exports = router;