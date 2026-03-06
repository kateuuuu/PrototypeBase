const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

// Login page
router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  const message = req.query.message || null;
  res.render('login', { error: null, message, show2fa: false, username: '', password_hidden: '' });
});

// Login handler - supports username OR email
router.post('/login', (req, res) => {
  const { username, password, remember_me, otp_code } = req.body;
  const db = req.app.locals.db;

  // Allow login with username or email
  const user = db.prepare('SELECT * FROM users WHERE (username = ? OR email = ?) AND is_active = 1').get(username, username);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    if (user) {
      db.prepare("UPDATE users SET last_failed_login = datetime('now','localtime'), failed_login_count = failed_login_count + 1 WHERE id = ?").run(user.id);
    }
    return res.render('login', { error: 'Invalid username or password', message: null, show2fa: false, username: '', password_hidden: '' });
  }

  // 2FA check for admin accounts with 2FA enabled
  if (user.enable_2fa && !otp_code) {
    return res.render('login', { error: null, message: null, show2fa: true, username, password_hidden: password });
  }
  if (user.enable_2fa && otp_code !== '123456') {
    return res.render('login', { error: 'Invalid OTP code. Demo code is 123456.', message: null, show2fa: true, username, password_hidden: password });
  }

  // Update last login & reset failed count
  db.prepare("UPDATE users SET last_login = datetime('now','localtime'), failed_login_count = 0 WHERE id = ?").run(user.id);

  req.session.user = {
    id: user.id,
    username: user.username,
    full_name: user.full_name,
    display_name: user.display_name,
    role: user.role
  };

  // Check must_change_password flag
  if (user.must_change_password) {
    return res.redirect('/force-password-change');
  }

  res.redirect('/dashboard');
});

// Force password change page
router.get('/force-password-change', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const db = req.app.locals.db;
  const user = db.prepare('SELECT must_change_password FROM users WHERE id = ?').get(req.session.user.id);
  if (!user || !user.must_change_password) return res.redirect('/dashboard');
  res.render('force-password-change', { title: 'Change Password Required' });
});

// Force password change handler
router.post('/force-password-change', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });
  const db = req.app.locals.db;
  const { new_password, confirm_password } = req.body;

  if (!new_password || new_password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (!/\d/.test(new_password)) {
    return res.status(400).json({ error: 'Password must include at least 1 number' });
  }
  if (new_password !== confirm_password) {
    return res.status(400).json({ error: 'Passwords do not match' });
  }

  const hash = bcrypt.hashSync(new_password, 10);
  db.prepare("UPDATE users SET password = ?, must_change_password = 0, last_password_change = datetime('now','localtime'), updated_at = datetime('now','localtime') WHERE id = ?")
    .run(hash, req.session.user.id);

  req.session.destroy(() => {
    res.json({ success: true, message: 'Password changed successfully. Please log in again.' });
  });
});

// Logout
router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// Change password (legacy endpoint)
router.post('/change-password', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });
  const { current_password, new_password } = req.body;
  const db = req.app.locals.db;

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  if (!bcrypt.compareSync(current_password, user.password)) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }

  if (!new_password || new_password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (!/\d/.test(new_password)) {
    return res.status(400).json({ error: 'Password must include at least 1 number' });
  }

  const hash = bcrypt.hashSync(new_password, 10);
  db.prepare("UPDATE users SET password = ?, must_change_password = 0, last_password_change = datetime('now','localtime'), updated_at = datetime('now','localtime') WHERE id = ?")
    .run(hash, user.id);

  req.session.destroy(() => {
    res.json({ success: true, message: 'Password changed. Please log in again.', logout: true });
  });
});

// Forgot password page
router.get('/forgot-password', (req, res) => {
  res.render('forgot-password', { error: null, message: null, token: null });
});

// Forgot password handler (prototype - shows token on screen)
router.post('/forgot-password', (req, res) => {
  const { email } = req.body;
  const db = req.app.locals.db;

  const user = db.prepare('SELECT id FROM users WHERE email = ? AND is_active = 1').get(email);

  if (user) {
    // Rate limiting: check recent tokens
    const recentTokens = db.prepare("SELECT COUNT(*) as cnt FROM password_reset_tokens WHERE user_id = ? AND created_at > datetime('now','localtime','-10 minutes')").get(user.id);
    if (recentTokens.cnt >= 3) {
      return res.render('forgot-password', { error: 'Too many reset requests. Please try again in 10 minutes.', message: null, token: null });
    }

    const token = crypto.randomBytes(32).toString('hex');
    db.prepare("INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, datetime('now','localtime','+1 hour'))").run(user.id, token);

    return res.render('forgot-password', {
      error: null,
      message: 'If the email is registered, a reset link was sent.',
      token: token
    });
  }

  // Always show generic message
  res.render('forgot-password', { error: null, message: 'If the email is registered, a reset link was sent.', token: null });
});

// Reset password page
router.get('/reset-password/:token', (req, res) => {
  const db = req.app.locals.db;
  const tokenRow = db.prepare("SELECT * FROM password_reset_tokens WHERE token = ? AND used = 0 AND expires_at > datetime('now','localtime')").get(req.params.token);

  if (!tokenRow) {
    return res.render('forgot-password', { error: 'Invalid or expired reset link.', message: null, token: null });
  }
  res.render('reset-password', { token: req.params.token, error: null });
});

// Reset password handler
router.post('/reset-password/:token', (req, res) => {
  const db = req.app.locals.db;
  const { new_password, confirm_password } = req.body;

  const tokenRow = db.prepare("SELECT * FROM password_reset_tokens WHERE token = ? AND used = 0 AND expires_at > datetime('now','localtime')").get(req.params.token);
  if (!tokenRow) {
    return res.status(400).json({ error: 'Invalid or expired reset link' });
  }

  if (!new_password || new_password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (!/\d/.test(new_password)) return res.status(400).json({ error: 'Password must include at least 1 number' });
  if (new_password !== confirm_password) return res.status(400).json({ error: 'Passwords do not match' });

  const hash = bcrypt.hashSync(new_password, 10);
  db.prepare("UPDATE users SET password = ?, must_change_password = 0, last_password_change = datetime('now','localtime'), updated_at = datetime('now','localtime') WHERE id = ?")
    .run(hash, tokenRow.user_id);
  db.prepare("UPDATE password_reset_tokens SET used = 1 WHERE id = ?").run(tokenRow.id);

  res.json({ success: true, message: 'Password reset successfully. You can now log in.' });
});

// Root redirect
router.get('/', (req, res) => {
  res.redirect(req.session.user ? '/dashboard' : '/login');
});

module.exports = router;
