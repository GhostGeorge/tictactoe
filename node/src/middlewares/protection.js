const path = require('path');
const express = require('express');
require('colors');


function ensureGuestOrLoggedIn(req, res, next) {
  console.log('Middleware check:', {
    isAuthenticated: req.isAuthenticated(),
    guest: req.session.guest
  });

  if (req.isAuthenticated() || req.session.guest) {
    return next();
  }

  return res.redirect('/');
}

module.exports = ensureGuestOrLoggedIn;