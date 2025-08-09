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
// Enter matchmaking queue - currently just a placeholder
/*
router.post('/queue', ensureGuestOrLoggedIn, (req, res) => {
  const playerId = req.user ? req.user.id : req.sessionID; // use session ID for guests
  const isGuest = req.session.guest === true;

  const result = enqueuePlayer({ playerId, isGuest });

  if (!result) {
    return res.status(400).send('Already in queue');
  }

  if (result.matched) {
    const { gameId } = result;
    return res.redirect(`/game/${gameId}`);
  } else {
    return res.send('Waiting for opponent...');
  }
});
*/

router.get('/queue', ensureGuestOrLoggedIn, (req, res) => {
  const playerId = req.user ? req.user.id : req.sessionID;
  const guest = req.session.guest === true;
  res.render('queue', { playerId, guest });
});


// Redirect to game page
router.get('/game/:gameId', ensureGuestOrLoggedIn, (req, res) => {
  const gameId = req.params.gameId;
  const game = getGame(gameId);

  if (!game) {
    return res.status(404).send('Game not found');
  }

  // Optionally verify the current user is a participant here...

  res.render('game', {
    gameId,
    playerId: req.user ? req.user.id : req.sessionID,
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