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
router.get('/home', ensureGuestOrLoggedIn, (req, res) => {
  console.log('GET /home', {
    isAuthenticated: req.isAuthenticated(),
    guest: req.session.guest
  });
  res.render('home', {
    user: req.user,
    guest: req.session.guest
  });
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

// Game routes
router.get('/queue', ensureGuestOrLoggedIn, (req, res) => {
  // Generate consistent player ID based on authentication status
  let playerId;
  if (req.user && req.user.id) {
    playerId = `google_${req.user.id}`;
  } else {
    playerId = `guest_${req.sessionID}`;
  }
  
  const guest = req.session.guest === true;
  
  // Store player info in session for consistency
  req.session.playerId = playerId;
  req.session.isGuest = guest;
  
  console.log(`Queue route: playerId=${playerId}, guest=${guest}, sessionID=${req.sessionID}`);
  
  res.render('queue', { playerId, guest });
});

// Game page route
router.get('/game/:gameId', ensureGuestOrLoggedIn, (req, res) => {
  const gameId = req.params.gameId;
  const game = getGame(gameId);

  if (!game) {
    console.log(`Game ${gameId} not found. Redirecting to home.`);
    return res.redirect('/home?error=game_not_found');
  }

  // Determine player ID consistently
  let playerId;
  if (req.query.playerId) {
    // Use query parameter if provided (from queue redirect)
    playerId = req.query.playerId;
  } else if (req.user && req.user.id) {
    // Generate from Google auth
    playerId = `google_${req.user.id}`;
  } else {
    // Generate from session ID for guests
    playerId = `guest_${req.sessionID}`;
  }
  
  console.log(`Game route: gameId=${gameId}, playerId=${playerId}, sessionID=${req.sessionID}`);
  console.log(`Game players:`, game.players.map(p => ({ 
    playerId: p.playerId, 
    socketId: p.socketId,
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

  res.render('game', {
    gameId,
    playerId,
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

// Export
module.exports = router;