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

// Supabase
const supabase = require('./src/supabase/supabaseClient');

// Logger setup
const logger = require('./src/middlewares/logger');
app.use(logger);

// Setup session middleware
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.SUPABASE_DB_URL, // full connection string from Supabase
    ssl: { rejectUnauthorized: false }
});

app.use(session({
    store: new pgSession({
        pool: pool,
        tableName: 'session',
        createTableIfMissing: false // table is already created above
    }),
    secret: process.env.SESSION_KEY,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false, // true if HTTPS
        sameSite: 'lax',
        maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
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
app.use(express.urlencoded({ extended: true }));
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
async (accessToken, refreshToken, profile, done) => {
  try {
    const googleId = profile.id;

    // Upsert into Supabase by google_id
    const { data, error } = await supabase
    .from('users')
    .upsert({
      google_id: profile.id,
      email: profile.emails[0].value,
      name: profile.displayName
    }, { onConflict: 'google_id' })
    .select()
    .single();


    if (error) return done(new Error(error.message));
    return done(null, data); 
  } catch (err) {
    done(err);
  }
}));

// Serialize and deserialize user
passport.serializeUser((user, done) => {
  done(null, user.google_id); // store google_id in session
});

passport.deserializeUser(async (google_id, done) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('google_id', google_id)
      .single();

    if (error) return done(new Error(error.message));
    done(null, data);
  } catch (err) {
    done(err);
  }
});

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