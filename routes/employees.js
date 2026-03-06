const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { roleCheck, DEFAULT_PERMISSIONS } = require('../middleware/auth');

// Permission groupings for UI
const PERMISSION_GROUPS = {
  'Sales': ['pos', 'order_history'],
  'Inventory': ['inventory', 'inventory_valuation', 'purchase_orders', 'audit_log'],
  'Reports': ['analytics', 'expenses', 'reports'],
  'Admin': ['employees', 'shifts', 'menu', 'dashboard']
};

router.get('/', roleCheck('admin'), (req, res) => {
  const db = req.app.locals.db;
  const employees = db.prepare(`
    SELECT u.*, 
      (SELECT COUNT(*) FROM shifts s WHERE s.user_id = u.id) as total_shifts,
      (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id AND o.status = 'completed') as total_orders
    FROM users u ORDER BY u.full_name
  `).all();
  
  const activeAdminCount = db.prepare("SELECT COUNT(*) as cnt FROM users WHERE role = 'admin' AND is_active = 1").get().cnt;
  
  res.render('employees', { 
    title: 'Employee Management', 
    employees, 
    defaultPermissions: DEFAULT_PERMISSIONS,
    permissionGroups: PERMISSION_GROUPS,
    activeAdminCount
  });
});

// Check username availability
router.get('/check-username', roleCheck('admin'), (req, res) => {
  const db = req.app.locals.db;
  const { username, excludeId } = req.query;
  if (!username) return res.json({ available: false });
  
  let query = 'SELECT id FROM users WHERE username = ?';
  const params = [username];
  
  if (excludeId) {
    query += ' AND id != ?';
    params.push(excludeId);
  }
  
  const existing = db.prepare(query).get(...params);
  res.json({ available: !existing });
});

router.post('/', roleCheck('admin'), (req, res) => {
  const db = req.app.locals.db;
  const { username, password, confirm_password, full_name, role, permissions, contact_number, email } = req.body;
  
  if (!username || !username.trim()) {
    return res.status(400).json({ error: 'Username is required' });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (!/\d/.test(password)) {
    return res.status(400).json({ error: 'Password must include at least 1 number' });
  }
  if (password !== confirm_password) {
    return res.status(400).json({ error: 'Passwords do not match' });
  }
  if (!full_name || !full_name.trim()) {
    return res.status(400).json({ error: 'Full name is required' });
  }
  
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim());
  if (existing) {
    return res.status(400).json({ error: 'Username already exists' });
  }
  
  // Check email uniqueness if provided
  if (email && email.trim()) {
    const emailExists = db.prepare('SELECT id FROM users WHERE email = ?').get(email.trim());
    if (emailExists) {
      return res.status(400).json({ error: 'Email already in use' });
    }
  }
  
  try {
    const hash = bcrypt.hashSync(password, 10);
    const permsJson = permissions ? JSON.stringify(permissions) : null;
    const result = db.prepare(`
      INSERT INTO users (username, password, full_name, role, permissions, contact_number, email, must_change_password) 
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `).run(username.trim(), hash, full_name.trim(), role || 'cashier', permsJson, contact_number || null, email || null);
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'Username already exists' });
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', roleCheck('admin'), (req, res) => {
  const db = req.app.locals.db;
  const { full_name, role, is_active, password, confirm_password, permissions, contact_number, email, enable_2fa } = req.body;
  const empId = parseInt(req.params.id);
  
  const currentEmp = db.prepare('SELECT * FROM users WHERE id = ?').get(empId);
  if (!currentEmp) {
    return res.status(404).json({ error: 'Employee not found' });
  }
  
  // Lockout prevention: Don't allow disabling/demoting the last active admin
  if (currentEmp.role === 'admin' && currentEmp.is_active) {
    const activeAdminCount = db.prepare("SELECT COUNT(*) as cnt FROM users WHERE role = 'admin' AND is_active = 1").get().cnt;
    
    // Check if this would leave no active admins
    if (activeAdminCount === 1) {
      if (!is_active || role !== 'admin') {
        return res.status(400).json({ 
          error: 'Cannot demote or deactivate the last active admin account. This would lock you out of admin functions.' 
        });
      }
      
      // Also check if removing critical admin permissions
      if (permissions && Array.isArray(permissions)) {
        const criticalPerms = ['employees', 'shifts'];
        const hasCritical = criticalPerms.every(p => permissions.includes(p));
        if (!hasCritical) {
          return res.status(400).json({ 
            error: 'Cannot remove critical admin permissions (employees, shifts) from the last active admin.' 
          });
        }
      }
    }
  }
  
  // Password validation if changing
  if (password && password !== confirm_password) {
    return res.status(400).json({ error: 'Passwords do not match' });
  }
  if (password && password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (password && !/\d/.test(password)) {
    return res.status(400).json({ error: 'Password must include at least 1 number' });
  }
  
  // Check email uniqueness if changing
  if (email && email.trim()) {
    const emailExists = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email.trim(), empId);
    if (emailExists) {
      return res.status(400).json({ error: 'Email already in use by another account' });
    }
  }
  
  try {
    const permsJson = permissions ? JSON.stringify(permissions) : null;
    const twofa = enable_2fa ? 1 : 0;
    if (password) {
      const hash = bcrypt.hashSync(password, 10);
      db.prepare(`
        UPDATE users SET full_name=?, role=?, is_active=?, password=?, permissions=?, contact_number=?, email=?, enable_2fa=?, updated_at=datetime('now','localtime') 
        WHERE id=?
      `).run(full_name, role, is_active ? 1 : 0, hash, permsJson, contact_number || null, email || null, twofa, empId);
    } else {
      db.prepare(`
        UPDATE users SET full_name=?, role=?, is_active=?, permissions=?, contact_number=?, email=?, enable_2fa=?, updated_at=datetime('now','localtime') 
        WHERE id=?
      `).run(full_name, role, is_active ? 1 : 0, permsJson, contact_number || null, email || null, twofa, empId);
    }
    res.json({ success: true });
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

router.delete('/:id', roleCheck('admin'), (req, res) => {
  const db = req.app.locals.db;
  const empId = parseInt(req.params.id);
  
  if (empId === req.session.user.id) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }
  
  // Lockout prevention
  const emp = db.prepare('SELECT * FROM users WHERE id = ?').get(empId);
  if (emp && emp.role === 'admin' && emp.is_active) {
    const activeAdminCount = db.prepare("SELECT COUNT(*) as cnt FROM users WHERE role = 'admin' AND is_active = 1").get().cnt;
    if (activeAdminCount === 1) {
      return res.status(400).json({ error: 'Cannot deactivate the last active admin account.' });
    }
  }
  
  try { 
    db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(empId); 
    res.json({ success: true }); 
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

// Admin reset password for employee
router.post('/:id/reset-password', roleCheck('admin'), (req, res) => {
  const db = req.app.locals.db;
  const empId = parseInt(req.params.id);
  
  const emp = db.prepare('SELECT * FROM users WHERE id = ?').get(empId);
  if (!emp) return res.status(404).json({ error: 'Employee not found' });
  
  // Generate a temporary password
  const tempPassword = 'Temp' + crypto.randomBytes(3).toString('hex') + '1';
  const hash = bcrypt.hashSync(tempPassword, 10);
  
  db.prepare("UPDATE users SET password = ?, must_change_password = 1, updated_at = datetime('now','localtime') WHERE id = ?")
    .run(hash, empId);
  
  res.json({ 
    success: true, 
    tempPassword,
    message: 'Password reset. Employee must change password on next login.' 
  });
});

// Generate simulated set-password link for employee
router.post('/:id/send-set-password', roleCheck('admin'), (req, res) => {
  const db = req.app.locals.db;
  const empId = parseInt(req.params.id);
  
  const emp = db.prepare('SELECT * FROM users WHERE id = ?').get(empId);
  if (!emp) return res.status(404).json({ error: 'Employee not found' });
  
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare("INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, datetime('now','localtime','+24 hours'))").run(empId, token);
  
  // Mark as must change password
  db.prepare("UPDATE users SET must_change_password = 1 WHERE id = ?").run(empId);
  
  res.json({ 
    success: true, 
    link: '/reset-password/' + token,
    message: 'Set-password link generated (simulation).' 
  });
});

module.exports = router;
