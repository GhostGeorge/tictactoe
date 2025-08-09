// Import
const express = require('express');
const router = express.Router();
const passport = require('passport');
const ensureGuestOrLoggedIn = require('../middlewares/protection');
const { enqueuePlayer, getGame, removeGame } = require('../gamemanager/matchmaking'); // add getGame, removeGame if needed

console.log("Main routes loaded");

// Controllers
const indexController = require('../controllers/indexController');

// GET Routes
router.get('/test-error', (req, res) => {throw new Error('This is a test error!');}); // Show the errorHandler working

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
  const playerId = req.user ? req.user.id : req.sessionID;
  const guest = req.session.guest === true;
  
  // Store player info in session for later reconnection
  req.session.playerId = playerId;
  req.session.isGuest = guest;
  
  res.render('queue', { playerId, guest });
});

// Redirect to game page
router.get('/game/:gameId', ensureGuestOrLoggedIn, (req, res) => {
  const gameId = req.params.gameId;
  const game = getGame(gameId);

  if (!game) {
    console.log(`Game ${gameId} not found. Redirecting to home.`);
    return res.redirect('/home');
  }

  // Get playerId from query parameter (for dev mode) or session (for production)
  const playerId = req.query.playerId || (req.user ? req.user.id : req.sessionID);
  
  console.log(`Checking game access: gameId=${gameId}, requestedPlayerId=${playerId}`);
  console.log(`Game players:`, game.players.map(p => ({ playerId: p.playerId, socketId: p.socketId })));

  // Check if this player is actually in this game
  const isPlayerInGame = game.players.some(p => p.playerId === playerId);
  
  if (!isPlayerInGame) {
    console.log(`Player ${playerId} not found in game ${gameId}. Players:`, game.players.map(p => p.playerId));
    return res.redirect('/home');
  }

  // Store current game info in session
  req.session.currentGameId = gameId;
  req.session.currentPlayerId = playerId; // Store the actual game player ID

  res.render('game', {
    gameId,
    playerId,
    guest: req.session.guest,
  });
});

// Playing a friend - redirect to password page
router.get('/play-friend', ensureGuestOrLoggedIn, (req, res) => {
  res.render('playFriend'); // create this view next
});

// Google authentication routes
router.get("/auth/google",
  passport.authenticate("google", { scope: ["profile", "email"] }));

router.get("/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/" }),
  (req, res) => {
    res.redirect("/home");
  });

router.get("/logout", (req, res) => {
  req.logout(() => {
    req.session.guest = null;
    res.redirect("/");
  });
});

// Export
module.exports = router;