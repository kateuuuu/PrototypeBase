const express = require('express');
const router = express.Router();

// Audit log page with enhanced filters
router.get('/', (req, res) => {
  const db = req.app.locals.db;
  const { item_id, action, source, user_id, date_from, date_to, search, group_by, page = 1 } = req.query;
  const limit = 50;
  const offset = (parseInt(page) - 1) * limit;

  let where = 'WHERE 1=1';
  const params = [];

  if (item_id) { where += ' AND ial.inventory_item_id = ?'; params.push(item_id); }
  if (action) { where += ' AND ial.action = ?'; params.push(action); }
  if (source) { where += ' AND ial.source = ?'; params.push(source); }
  if (user_id) { where += ' AND ial.user_id = ?'; params.push(user_id); }
  if (date_from) { where += ' AND date(ial.created_at) >= ?'; params.push(date_from); }
  if (date_to) { where += ' AND date(ial.created_at) <= ?'; params.push(date_to); }
  if (search) { 
    where += ' AND (ii.name LIKE ? OR ial.reason LIKE ? OR ial.reference_id LIKE ?)'; 
    params.push('%' + search + '%', '%' + search + '%', '%' + search + '%'); 
  }

  const total = db.prepare(`
    SELECT COUNT(*) as cnt 
    FROM inventory_audit_log ial 
    JOIN inventory_items ii ON ial.inventory_item_id = ii.id 
    ${where}
  `).get(...params);
  
  const logs = db.prepare(`
    SELECT ial.*, ii.name as item_name, ii.unit, u.full_name as user_name
    FROM inventory_audit_log ial 
    JOIN inventory_items ii ON ial.inventory_item_id = ii.id
    LEFT JOIN users u ON ial.user_id = u.id
    ${where}
    ORDER BY ial.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const inventoryItems = db.prepare('SELECT id, name FROM inventory_items ORDER BY name').all();
  const users = db.prepare('SELECT id, full_name FROM users ORDER BY full_name').all();
  const actions = ['sale_deduction', 'restock', 'adjustment', 'wastage', 'initial', 'import', 'po_received', 'po_cancelled', 'platform_sale'];
  const sources = ['POS', 'Inventory', 'Purchase Orders', 'Import', 'System'];

  if (req.headers.accept?.includes('application/json')) {
    return res.json({ logs, total: total.cnt, page: parseInt(page), pages: Math.ceil(total.cnt / limit) });
  }

  res.render('audit-log', {
    title: 'Inventory Audit Log',
    logs,
    total: total.cnt,
    page: parseInt(page),
    pages: Math.ceil(total.cnt / limit),
    inventoryItems,
    users,
    actions,
    sources,
    filters: { item_id, action, source, user_id, date_from, date_to, search, group_by }
  });
});

// Export CSV
router.get('/export', (req, res) => {
  const db = req.app.locals.db;
  const { item_id, action, source, user_id, date_from, date_to, search } = req.query;

  let where = 'WHERE 1=1';
  const params = [];

  if (item_id) { where += ' AND ial.inventory_item_id = ?'; params.push(item_id); }
  if (action) { where += ' AND ial.action = ?'; params.push(action); }
  if (source) { where += ' AND ial.source = ?'; params.push(source); }
  if (user_id) { where += ' AND ial.user_id = ?'; params.push(user_id); }
  if (date_from) { where += ' AND date(ial.created_at) >= ?'; params.push(date_from); }
  if (date_to) { where += ' AND date(ial.created_at) <= ?'; params.push(date_to); }
  if (search) { 
    where += ' AND (ii.name LIKE ? OR ial.reason LIKE ? OR ial.reference_id LIKE ?)'; 
    params.push('%' + search + '%', '%' + search + '%', '%' + search + '%'); 
  }
  
  const logs = db.prepare(`
    SELECT ial.*, ii.name as item_name, ii.unit, u.full_name as user_name
    FROM inventory_audit_log ial 
    JOIN inventory_items ii ON ial.inventory_item_id = ii.id
    LEFT JOIN users u ON ial.user_id = u.id
    ${where}
    ORDER BY ial.created_at DESC
  `).all(...params);

  const actionLabels = {
    'initial': 'Initial Stock', 'restock': 'Restock', 'wastage': 'Wastage',
    'adjustment': 'Correction', 'sale_deduction': 'POS Sale', 'import': 'Import',
    'po_received': 'PO Received', 'po_cancelled': 'PO Cancelled', 'platform_sale': 'Platform Sale'
  };

  let csv = 'Date/Time,Item,Action,Source,Change,Unit,Before,After,Cost Before,Cost After,Cost Method,Reason,Reference,User\n';
  logs.forEach(log => {
    const change = (log.quantity_change >= 0 ? '+' : '') + log.quantity_change.toFixed(2);
    const row = [
      log.created_at,
      '"' + (log.item_name || '').replace(/"/g, '""') + '"',
      actionLabels[log.action] || log.action,
      log.source || 'Inventory',
      change,
      log.unit,
      log.quantity_before.toFixed(2),
      log.quantity_after.toFixed(2),
      log.cost_before !== null ? log.cost_before.toFixed(2) : '',
      log.cost_after !== null ? log.cost_after.toFixed(2) : '',
      log.cost_method || '',
      '"' + (log.reason || '').replace(/"/g, '""') + '"',
      log.reference_id || '',
      log.user_name || 'System'
    ];
    csv += row.join(',') + '\n';
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=audit_log_' + new Date().toISOString().slice(0,10) + '.csv');
  res.send(csv);
});

// Get grouped logs by reference (for recipe deductions)
router.get('/grouped', (req, res) => {
  const db = req.app.locals.db;
  const { date_from, date_to } = req.query;

  let where = "WHERE ial.action = 'sale_deduction' AND ial.reference_id IS NOT NULL";
  const params = [];

  if (date_from) { where += ' AND date(ial.created_at) >= ?'; params.push(date_from); }
  if (date_to) { where += ' AND date(ial.created_at) <= ?'; params.push(date_to); }

  const grouped = db.prepare(`
    SELECT 
      ial.reference_id,
      MIN(ial.created_at) as created_at,
      COUNT(*) as item_count,
      SUM(ABS(ial.quantity_change)) as total_deducted,
      GROUP_CONCAT(ii.name || ' ' || ial.quantity_change || ' ' || ii.unit, ', ') as items_summary
    FROM inventory_audit_log ial 
    JOIN inventory_items ii ON ial.inventory_item_id = ii.id
    ${where}
    GROUP BY ial.reference_id
    ORDER BY MIN(ial.created_at) DESC
    LIMIT 100
  `).all(...params);

  res.json({ grouped });
});

// Get logs for a specific reference
router.get('/reference/:ref', (req, res) => {
  const db = req.app.locals.db;
  const logs = db.prepare(`
    SELECT ial.*, ii.name as item_name, ii.unit, u.full_name as user_name
    FROM inventory_audit_log ial 
    JOIN inventory_items ii ON ial.inventory_item_id = ii.id
    LEFT JOIN users u ON ial.user_id = u.id
    WHERE ial.reference_id = ?
    ORDER BY ial.created_at DESC
  `).all(req.params.ref);
  res.json({ logs });
});

module.exports = router;
