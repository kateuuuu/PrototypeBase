const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');

// My Profile page
router.get('/', (req, res) => {
  const db = req.app.locals.db;
  const user = db.prepare('SELECT id, username, full_name, display_name, role, contact_number, email, last_login, last_password_change, last_failed_login, created_at FROM users WHERE id = ?').get(req.session.user.id);
  res.render('profile', { title: 'My Profile', user });
});

// Update display name, email & contact number (non-sensitive fields only)
router.put('/update', (req, res) => {
  const db = req.app.locals.db;
  const { display_name, email, contact_number } = req.body;
  
  try {
    db.prepare("UPDATE users SET display_name = ?, email = ?, contact_number = ?, updated_at = datetime('now','localtime') WHERE id = ?")
      .run(display_name || null, email || null, contact_number || null, req.session.user.id);
    
    // Update session display name
    if (display_name) {
      req.session.user.display_name = display_name;
    }
    
    res.json({ success: true, message: 'Profile updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Change password (with rules enforcement)
router.post('/change-password', (req, res) => {
  const db = req.app.locals.db;
  const { current_password, new_password, confirm_password } = req.body;

  // Validation
  if (!current_password) {
    return res.status(400).json({ error: 'Current password is required' });
  }
  if (!new_password || new_password.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  if (!/\d/.test(new_password)) {
    return res.status(400).json({ error: 'New password must include at least 1 number' });
  }
  if (new_password !== confirm_password) {
    return res.status(400).json({ error: 'New password and confirmation do not match' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  if (!bcrypt.compareSync(current_password, user.password)) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }

  const hash = bcrypt.hashSync(new_password, 10);
  db.prepare("UPDATE users SET password = ?, must_change_password = 0, last_password_change = datetime('now','localtime'), updated_at = datetime('now','localtime') WHERE id = ?")
    .run(hash, user.id);

  // Destroy session to force re-login
  req.session.destroy(() => {
    res.json({ success: true, message: 'Password changed. Please log in again.', logout: true });
  });
});

module.exports = router;
