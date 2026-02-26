const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
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
  
  // Get count of active admins for lockout prevention
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
  const { username, password, confirm_password, full_name, role, permissions, contact_number } = req.body;
  
  // Validation
  if (!username || !username.trim()) {
    return res.status(400).json({ error: 'Username is required' });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  if (password !== confirm_password) {
    return res.status(400).json({ error: 'Passwords do not match' });
  }
  if (!full_name || !full_name.trim()) {
    return res.status(400).json({ error: 'Full name is required' });
  }
  
  // Check username uniqueness
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim());
  if (existing) {
    return res.status(400).json({ error: 'Username already exists' });
  }
  
  try {
    const hash = bcrypt.hashSync(password, 10);
    const permsJson = permissions ? JSON.stringify(permissions) : null;
    const result = db.prepare(`
      INSERT INTO users (username, password, full_name, role, permissions, contact_number) 
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(username.trim(), hash, full_name.trim(), role || 'cashier', permsJson, contact_number || null);
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'Username already exists' });
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', roleCheck('admin'), (req, res) => {
  const db = req.app.locals.db;
  const { full_name, role, is_active, password, confirm_password, permissions, contact_number } = req.body;
  const empId = parseInt(req.params.id);
  
  // Get current employee data
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
  if (password && password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  
  try {
    const permsJson = permissions ? JSON.stringify(permissions) : null;
    if (password) {
      const hash = bcrypt.hashSync(password, 10);
      db.prepare(`
        UPDATE users SET full_name=?, role=?, is_active=?, password=?, permissions=?, contact_number=?, updated_at=datetime('now','localtime') 
        WHERE id=?
      `).run(full_name, role, is_active ? 1 : 0, hash, permsJson, contact_number || null, empId);
    } else {
      db.prepare(`
        UPDATE users SET full_name=?, role=?, is_active=?, permissions=?, contact_number=?, updated_at=datetime('now','localtime') 
        WHERE id=?
      `).run(full_name, role, is_active ? 1 : 0, permsJson, contact_number || null, empId);
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

module.exports = router;
