// Require
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: '../.env' }); // The .env file is outside the ./server.js folder root.
require('colors');
const favicon = require('serve-favicon');

// Express setup
const app = express();

// Logger setup
const logger = require('./src/middlewares/logger');
app.use(logger);

// Setup session middleware
app.use(session({
    secret: process.env.SESSION_KEY,
    resave: false,
    saveUninitialized: true,
    //cookie: { secure: process.env.NODE_ENV === 'production' } // For HTTP, set to true for HTTPS
    cookie: {
        secure: false, // allow over HTTP
        sameSite: 'lax' // helps prevent OAuth issues
    }
}));

// Serve favicon
app.use(favicon(path.join(__dirname, 'public', 'images', 'icon.png')));

// Set cache control for static files
app.use(express.static('public', {
    setHeaders: (res, filePath) => {
        res.setHeader('Cache-Control', 'no-store');
    }
}));

app.use(express.json());
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Google passport setup
app.use(passport.initialize());
app.use(passport.session());

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: "/auth/google/callback"
},
(accessToken, refreshToken, profile, done) => {
  return done(null, profile);
}));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

// Protection middleware
const protection = require('./src/middlewares/protection');
//app.use(protection); ---> leads to redirect loop, so we apply it only to specific routes

// Routes
const mainRoutes = require('./src/routes/mainRoutes');
app.use(mainRoutes);

// Handle 404
app.use((req, res) => {
    res.status(404).sendFile(path.join(__dirname, 'public/404.html'));
});

// Error handler should be the last middleware added.
const errorHandler = require('./src/middlewares/errorHandler');
app.use(errorHandler);

module.exports = app;