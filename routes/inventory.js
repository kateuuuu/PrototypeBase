const express = require('express');
const router = express.Router();
const QRCode = require('qrcode');

// ============ HELPER: Get expiry threshold setting ============
function getExpiryThreshold(db) {
  const row = db.prepare("SELECT value FROM system_settings WHERE key = 'expiry_threshold_days'").get();
  return row ? parseInt(row.value) || 7 : 7;
}

// ============ HELPER: FEFO deduction (First Expired, First Out) ============
function fefoDeduct(db, inventoryItemId, amountToDeduct, userId, reason, referenceId) {
  const today = new Date().toISOString().split('T')[0];
  // Get non-expired, non-disposed batches ordered by earliest expiration
  const batches = db.prepare(`
    SELECT * FROM inventory_batches 
    WHERE inventory_item_id = ? AND is_disposed = 0 AND quantity > 0 AND expiration_date > ?
    ORDER BY expiration_date ASC
  `).all(inventoryItemId, today);
  
  let remaining = amountToDeduct;
  const usedBatches = [];
  
  for (const batch of batches) {
    if (remaining <= 0) break;
    const deductFromBatch = Math.min(remaining, batch.quantity);
    db.prepare('UPDATE inventory_batches SET quantity = quantity - ? WHERE id = ?').run(deductFromBatch, batch.id);
    usedBatches.push({ batchId: batch.id, qty: deductFromBatch });
    remaining -= deductFromBatch;
  }
  
  // If remaining > 0, there wasn't enough non-expired stock (will still deduct from item total)
  return { usedBatches, shortfall: remaining > 0 ? remaining : 0 };
}

router.get('/', (req, res) => {
  const db = req.app.locals.db;
  const { category, status, search, sort } = req.query;
  
  // Get expiry info early (needed for filtering)
  const threshold = getExpiryThreshold(db);
  const today = new Date().toISOString().split('T')[0];
  const thresholdDate = new Date(Date.now() + threshold * 86400000).toISOString().split('T')[0];
  const todayMs = new Date(today).getTime();
  
  let where = 'WHERE ii.is_active = 1';
  const params = [];
  if (category) { where += ' AND ii.category = ?'; params.push(category); }
  // Standard stock status filters
  if (status === 'low') { where += ' AND ii.quantity <= ii.reorder_level AND ii.quantity > 0'; }
  else if (status === 'out') { where += ' AND ii.quantity <= 0'; }
  else if (status === 'in-stock') { where += ' AND ii.quantity > ii.reorder_level'; }
  // Expiry-based filters: filter by item IDs that have matching batches
  else if (status === 'expiring-soon') {
    where += ` AND ii.id IN (SELECT DISTINCT inventory_item_id FROM inventory_batches WHERE is_disposed = 0 AND quantity > 0 AND expiration_date > '${today}' AND expiration_date <= '${thresholdDate}')`;
  }
  else if (status === 'expired') {
    where += ` AND ii.id IN (SELECT DISTINCT inventory_item_id FROM inventory_batches WHERE is_disposed = 0 AND quantity > 0 AND expiration_date <= '${today}')`;
  }
  if (search) { where += ' AND ii.name LIKE ?'; params.push('%' + search + '%'); }
  
  // Sorting
  let orderBy = 'ORDER BY ii.name';
  if (sort === 'critical') orderBy = 'ORDER BY CASE WHEN ii.quantity <= 0 THEN 0 WHEN ii.quantity <= ii.reorder_level THEN 1 ELSE 2 END, ii.quantity ASC';
  else if (sort === 'lowest') orderBy = 'ORDER BY ii.quantity ASC';
  else if (sort === 'value') orderBy = 'ORDER BY (ii.quantity * ii.cost_per_unit) DESC';
  
  // Query with last action from audit log
  const items = db.prepare(`
    SELECT ii.*, 
      (SELECT ial.action FROM inventory_audit_log ial WHERE ial.inventory_item_id = ii.id ORDER BY ial.created_at DESC LIMIT 1) as last_action
    FROM inventory_items ii ${where} ${orderBy}
  `).all(...params);
  
  // For each tracked item, get nearest batch expiry info
  const nearestExpiryStmt = db.prepare(`
    SELECT expiration_date, quantity FROM inventory_batches 
    WHERE inventory_item_id = ? AND is_disposed = 0 AND quantity > 0 
    ORDER BY expiration_date ASC LIMIT 1
  `);
  const expiredBatchStmt = db.prepare(`
    SELECT COUNT(*) as cnt FROM inventory_batches 
    WHERE inventory_item_id = ? AND is_disposed = 0 AND quantity > 0 AND expiration_date <= ?
  `);
  
  items.forEach(item => {
    if (item.track_expiry) {
      const nearest = nearestExpiryStmt.get(item.id);
      if (nearest) {
        item.nearest_expiry = nearest.expiration_date;
        item.nearest_expiry_days = Math.ceil((new Date(nearest.expiration_date).getTime() - todayMs) / 86400000);
        if (item.nearest_expiry_days <= 0) item.expiry_status = 'expired';
        else if (item.nearest_expiry_days <= threshold) item.expiry_status = 'expiring-soon';
        else item.expiry_status = 'ok';
      }
      item.has_expired_batches = expiredBatchStmt.get(item.id, today).cnt > 0;
    }
  });
  
  // Get distinct categories from items AND from inventory_categories table
  const itemCategories = db.prepare('SELECT DISTINCT category FROM inventory_items WHERE is_active = 1 AND category IS NOT NULL ORDER BY category').all().map(r => r.category);
  const managedCategories = db.prepare('SELECT name FROM inventory_categories WHERE is_active = 1 ORDER BY name').all().map(r => r.name);
  const categories = [...new Set([...itemCategories, ...managedCategories])].sort();
  
  const summary = db.prepare(`SELECT COUNT(*) as total,
    SUM(CASE WHEN quantity > reorder_level THEN 1 ELSE 0 END) as in_stock,
    SUM(CASE WHEN quantity <= reorder_level AND quantity > 0 THEN 1 ELSE 0 END) as low_stock,
    SUM(CASE WHEN quantity <= 0 THEN 1 ELSE 0 END) as out_of_stock,
    SUM(quantity * cost_per_unit) as total_value
   FROM inventory_items WHERE is_active = 1`).get();
   
  // Get managed categories for admin
  const inventoryCategories = db.prepare('SELECT * FROM inventory_categories WHERE is_active = 1 ORDER BY name').all();
  
  // Expiry summary counts (always computed from full dataset, not filtered)
  const expiringSoon = db.prepare(`SELECT COUNT(DISTINCT inventory_item_id) as cnt FROM inventory_batches WHERE is_disposed = 0 AND quantity > 0 AND expiration_date > ? AND expiration_date <= ?`).get(today, thresholdDate).cnt;
  const expiredCount = db.prepare(`SELECT COUNT(DISTINCT inventory_item_id) as cnt FROM inventory_batches WHERE is_disposed = 0 AND quantity > 0 AND expiration_date <= ?`).get(today).cnt;
  
  res.render('inventory', { title: 'Inventory Management', items, categories, inventoryCategories, summary, query: req.query, expiringSoon, expiredCount, expiryThreshold: threshold });
});

router.post('/', (req, res) => {
  const db = req.app.locals.db;
  const { name, category, quantity, unit, cost_per_unit, reorder_level, supplier, notes, track_expiry, expiration_date } = req.body;
  const trackExp = track_expiry ? 1 : 0;
  try {
    const qty = parseFloat(quantity) || 0;
    const result = db.prepare('INSERT INTO inventory_items (name, category, quantity, unit, cost_per_unit, reorder_level, supplier, track_expiry) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(name, category || null, qty, unit || 'pcs', parseFloat(cost_per_unit) || 0, parseFloat(reorder_level) || 10, supplier || null, trackExp);
    const itemId = result.lastInsertRowid;
    let batchId = null;
    
    // If tracking expiry and has initial stock, create a batch
    if (trackExp && qty > 0 && expiration_date) {
      const batchResult = db.prepare('INSERT INTO inventory_batches (inventory_item_id, quantity, unit, expiration_date, received_by, source, reference_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(itemId, qty, unit || 'pcs', expiration_date, req.session.user.id, 'Manual Restock', 'Initial');
      batchId = batchResult.lastInsertRowid;
    }
    
    db.prepare("INSERT INTO inventory_audit_log (inventory_item_id, action, quantity_change, quantity_before, quantity_after, reason, user_id, batch_id) VALUES (?, 'initial', ?, 0, ?, ?, ?, ?)").run(itemId, qty, qty, notes || 'Initial stock', req.session.user.id, batchId);
    res.json({ success: true, id: itemId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get expiry dashboard data (for dashboard widgets)
router.get('/expiry/summary', (req, res) => {
  const db = req.app.locals.db;
  const threshold = getExpiryThreshold(db);
  const today = new Date().toISOString().split('T')[0];
  const thresholdDate = new Date(Date.now() + threshold * 86400000).toISOString().split('T')[0];
  
  const expiringSoonBatches = db.prepare(`
    SELECT b.*, ii.name as item_name, ii.unit as item_unit
    FROM inventory_batches b
    JOIN inventory_items ii ON b.inventory_item_id = ii.id
    WHERE b.is_disposed = 0 AND b.quantity > 0 AND b.expiration_date > ? AND b.expiration_date <= ?
    ORDER BY b.expiration_date ASC LIMIT 10
  `).all(today, thresholdDate);
  
  const expiredBatches = db.prepare(`
    SELECT b.*, ii.name as item_name, ii.unit as item_unit
    FROM inventory_batches b
    JOIN inventory_items ii ON b.inventory_item_id = ii.id
    WHERE b.is_disposed = 0 AND b.quantity > 0 AND b.expiration_date <= ?
    ORDER BY b.expiration_date ASC LIMIT 10
  `).all(today);
  
  const expiringSoonCount = db.prepare(`SELECT COUNT(*) as cnt FROM inventory_batches WHERE is_disposed = 0 AND quantity > 0 AND expiration_date > ? AND expiration_date <= ?`).get(today, thresholdDate).cnt;
  const expiredCount = db.prepare(`SELECT COUNT(*) as cnt FROM inventory_batches WHERE is_disposed = 0 AND quantity > 0 AND expiration_date <= ?`).get(today).cnt;
  
  const todayMs = new Date(today).getTime();
  const addDaysLeft = (batches) => batches.map(b => ({
    ...b,
    days_left: Math.ceil((new Date(b.expiration_date).getTime() - todayMs) / 86400000),
    status: new Date(b.expiration_date) <= new Date(today) ? 'Expired' : 'Expiring Soon'
  }));
  
  res.json({
    expiringSoonCount,
    expiredCount,
    expiringSoonBatches: addDaysLeft(expiringSoonBatches),
    expiredBatches: addDaysLeft(expiredBatches),
    threshold
  });
});

// Update expiry threshold setting
router.put('/expiry/settings', (req, res) => {
  const db = req.app.locals.db;
  if (req.session.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { threshold_days } = req.body;
  const days = parseInt(threshold_days);
  if (isNaN(days) || days < 1) return res.status(400).json({ error: 'Invalid threshold' });
  try {
    db.prepare("INSERT OR REPLACE INTO system_settings (key, value) VALUES ('expiry_threshold_days', ?)").run(String(days));
    res.json({ success: true, threshold_days: days });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Edit item (without quantity - use log for that)
router.put('/:id', (req, res) => {
  const db = req.app.locals.db;
  const { name, category, unit, cost_per_unit, reorder_level, supplier, track_expiry } = req.body;
  const item = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const trackExp = track_expiry !== undefined ? (track_expiry ? 1 : 0) : item.track_expiry;
  try {
    db.prepare("UPDATE inventory_items SET name=?, category=?, unit=?, cost_per_unit=?, reorder_level=?, supplier=?, track_expiry=?, updated_at=datetime('now','localtime') WHERE id=?").run(name || item.name, category || null, unit || item.unit, parseFloat(cost_per_unit) || 0, parseFloat(reorder_level) || 10, supplier || null, trackExp, req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Quick Log (Restock/Wastage/Adjustment)
router.post('/:id/log', (req, res) => {
  const db = req.app.locals.db;
  const { action, quantity, reason, expiration_date } = req.body;
  const item = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  
  const qty = parseFloat(quantity) || 0;
  let newQty = item.quantity;
  let change = 0;
  let actionLabel = action;
  let batchId = null;
  
  if (action === 'restock') {
    newQty = item.quantity + qty;
    change = qty;
    actionLabel = 'restock';
    
    // If tracking expiry, create a batch
    if (item.track_expiry) {
      if (!expiration_date) return res.status(400).json({ error: 'Expiration date is required for this item' });
      const batchResult = db.prepare('INSERT INTO inventory_batches (inventory_item_id, quantity, unit, expiration_date, received_by, source) VALUES (?, ?, ?, ?, ?, ?)').run(req.params.id, qty, item.unit, expiration_date, req.session.user.id, 'Manual Restock');
      batchId = batchResult.lastInsertRowid;
      actionLabel = 'batch_added';
    }
  } else if (action === 'wastage') {
    newQty = Math.max(0, item.quantity - qty);
    change = -(item.quantity - newQty);
    actionLabel = 'wastage';
  } else if (action === 'adjustment') {
    newQty = qty;
    change = qty - item.quantity;
    actionLabel = 'adjustment';
  }
  
  try {
    db.prepare("UPDATE inventory_items SET quantity=?, updated_at=datetime('now','localtime') WHERE id=?").run(newQty, req.params.id);
    db.prepare("INSERT INTO inventory_audit_log (inventory_item_id, action, quantity_change, quantity_before, quantity_after, reason, user_id, batch_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(req.params.id, actionLabel, change, item.quantity, newQty, reason || action, req.session.user.id, batchId);
    res.json({ success: true, newQuantity: newQty, batchId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get history for an item
router.get('/:id/history', (req, res) => {
  const db = req.app.locals.db;
  const logs = db.prepare(`
    SELECT ial.*, u.full_name as user_name
    FROM inventory_audit_log ial 
    LEFT JOIN users u ON ial.user_id = u.id
    WHERE ial.inventory_item_id = ?
    ORDER BY ial.created_at DESC LIMIT 50
  `).all(req.params.id);
  res.json({ logs });
});

router.delete('/:id', (req, res) => {
  const db = req.app.locals.db;
  // Only admin can delete
  if (req.session.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try { db.prepare('UPDATE inventory_items SET is_active = 0 WHERE id = ?').run(req.params.id); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Bulk Restock
router.post('/bulk/restock', (req, res) => {
  const db = req.app.locals.db;
  const { ids, quantity, reason } = req.body;
  if (!ids || !Array.isArray(ids)) return res.status(400).json({ error: 'Invalid ids' });
  const qty = parseFloat(quantity) || 0;
  
  const bulkRestock = db.transaction(() => {
    for (const id of ids) {
      const item = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(id);
      if (item) {
        const newQty = item.quantity + qty;
        db.prepare("UPDATE inventory_items SET quantity=?, updated_at=datetime('now','localtime') WHERE id=?").run(newQty, id);
        db.prepare("INSERT INTO inventory_audit_log (inventory_item_id, action, quantity_change, quantity_before, quantity_after, reason, user_id) VALUES (?, 'restock', ?, ?, ?, ?, ?)").run(id, qty, item.quantity, newQty, reason || 'Bulk restock', req.session.user.id);
      }
    }
  });
  
  try { bulkRestock(); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Bulk Set Reorder Level
router.post('/bulk/reorder', (req, res) => {
  const db = req.app.locals.db;
  const { ids, reorder_level, reason } = req.body;
  if (!ids || !Array.isArray(ids)) return res.status(400).json({ error: 'Invalid ids' });
  const level = parseFloat(reorder_level) || 0;
  
  const bulkReorder = db.transaction(() => {
    for (const id of ids) {
      db.prepare("UPDATE inventory_items SET reorder_level=?, updated_at=datetime('now','localtime') WHERE id=?").run(level, id);
    }
  });
  
  try { bulkReorder(); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Get items info for bulk operations (returns names, units, current stock)
router.post('/bulk/info', (req, res) => {
  const db = req.app.locals.db;
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids)) return res.status(400).json({ error: 'Invalid ids' });
  const items = db.prepare('SELECT id, name, unit, quantity, reorder_level FROM inventory_items WHERE id IN (' + ids.map(() => '?').join(',') + ')').all(...ids);
  const units = [...new Set(items.map(i => i.unit))];
  res.json({ items, units, hasMixedUnits: units.length > 1 });
});

// Export selected items as CSV
router.get('/export', (req, res) => {
  const db = req.app.locals.db;
  const { ids } = req.query;
  let items;
  if (ids) {
    const idList = ids.split(',').map(id => parseInt(id)).filter(id => !isNaN(id));
    if (idList.length === 0) items = db.prepare('SELECT * FROM inventory_items WHERE is_active = 1').all();
    else items = db.prepare('SELECT * FROM inventory_items WHERE id IN (' + idList.map(() => '?').join(',') + ') AND is_active = 1').all(...idList);
  } else {
    items = db.prepare('SELECT * FROM inventory_items WHERE is_active = 1').all();
  }
  
  let csv = 'Name,Category,Stock,Unit,Cost/Unit,Value,Reorder Level,Status,Supplier,Last Updated\n';
  items.forEach(item => {
    const value = (item.quantity * (item.cost_per_unit || 0)).toFixed(2);
    const status = item.quantity <= 0 ? 'Out of Stock' : item.quantity <= item.reorder_level ? 'Low Stock' : 'In-Stock';
    csv += '"' + (item.name || '').replace(/"/g, '""') + '","' + (item.category || '') + '",' + item.quantity.toFixed(2) + ',"' + item.unit + '",' + (item.cost_per_unit || 0).toFixed(2) + ',' + value + ',' + item.reorder_level + ',"' + status + '","' + (item.supplier || '') + '","' + (item.updated_at || '') + '"\n';
  });
  
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=inventory_export_' + new Date().toISOString().slice(0,10) + '.csv');
  res.send(csv);
});

router.get('/qr/:id', async (req, res) => {
  const db = req.app.locals.db;
  const item = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const size = parseInt(req.query.size) || 200;
  try {
    // QR code links to item's log page for quick actions
    const qrUrl = req.protocol + '://' + req.get('host') + '/inventory?item=' + item.id + '&action=log';
    const qrImage = await QRCode.toDataURL(qrUrl, { width: size, margin: 1 });
    res.json({ qr: qrImage, item, url: qrUrl });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/qr/bulk', async (req, res) => {
  const db = req.app.locals.db;
  const { ids, size, copies } = req.body;
  if (!ids || !Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'No items selected' });
  const qrSize = parseInt(size) || 200;
  const copiesPerItem = parseInt(copies) || 1;
  try {
    const results = [];
    for (const id of ids) {
      const item = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(id);
      if (item) {
        const qrUrl = req.protocol + '://' + req.get('host') + '/inventory?item=' + item.id + '&action=log';
        const qrImage = await QRCode.toDataURL(qrUrl, { width: qrSize, margin: 1 });
        for (let c = 0; c < copiesPerItem; c++) {
          results.push({ qr: qrImage, item, url: qrUrl });
        }
      }
    }
    res.json({ success: true, qrCodes: results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/valuation', (req, res) => {
  const db = req.app.locals.db;
  const { category, search, sort } = req.query;
  const userRole = req.session.user?.role || 'cashier';
  
  // Build query with filters
  let where = 'WHERE is_active = 1';
  const params = [];
  if (category && category !== 'all') { where += ' AND category = ?'; params.push(category); }
  if (search) { where += ' AND name LIKE ?'; params.push('%' + search + '%'); }
  
  // Sorting
  let orderBy = 'ORDER BY total_value DESC';
  if (sort === 'lowest_stock') orderBy = 'ORDER BY quantity ASC';
  else if (sort === 'critical') orderBy = 'ORDER BY CASE WHEN quantity <= 0 THEN 0 WHEN quantity <= reorder_level THEN 1 ELSE 2 END, quantity ASC';
  else if (sort === 'value_asc') orderBy = 'ORDER BY total_value ASC';
  
  const items = db.prepare(`SELECT *, (quantity * cost_per_unit) as total_value FROM inventory_items ${where} ${orderBy}`).all(...params);
  const totalValue = items.reduce((s, i) => s + i.total_value, 0);
  
  // Category breakdown (always use all items for chart, not filtered)
  const allItems = db.prepare('SELECT *, (quantity * cost_per_unit) as total_value FROM inventory_items WHERE is_active = 1').all();
  const allTotalValue = allItems.reduce((s, i) => s + i.total_value, 0);
  const byCategory = {};
  allItems.forEach(item => {
    const cat = item.category || 'Uncategorized';
    byCategory[cat] = (byCategory[cat] || 0) + item.total_value;
  });
  
  // Get all categories for filter dropdown
  const categories = db.prepare('SELECT DISTINCT category FROM inventory_items WHERE is_active = 1 AND category IS NOT NULL ORDER BY category').all().map(r => r.category);
  
  if (req.headers.accept?.includes('application/json')) return res.json({ items, totalValue, byCategory, allTotalValue });
  res.render('inventory-valuation', { 
    title: 'Inventory Valuation', 
    items, 
    totalValue, 
    allTotalValue,
    byCategory, 
    categories,
    query: req.query,
    userRole
  });
});

router.get('/audit', (req, res) => {
  const db = req.app.locals.db;
  const { search, item_id, action, source, user_id, date_from, date_to } = req.query;
  const page = parseInt(req.query.page) || 1;
  const limit = 50;
  const offset = (page - 1) * limit;
  
  let where = 'WHERE 1=1';
  const params = [];
  if (item_id) { where += ' AND ial.inventory_item_id = ?'; params.push(item_id); }
  if (action) { where += ' AND ial.action = ?'; params.push(action); }
  if (source) { where += ' AND ial.source = ?'; params.push(source); }
  if (user_id) { where += ' AND ial.user_id = ?'; params.push(user_id); }
  if (date_from) { where += " AND ial.created_at >= ?"; params.push(date_from + ' 00:00:00'); }
  if (date_to) { where += " AND ial.created_at <= ?"; params.push(date_to + ' 23:59:59'); }
  if (search) { where += ' AND (ii.name LIKE ? OR ial.reason LIKE ? OR ial.reference_id LIKE ?)'; params.push('%'+search+'%', '%'+search+'%', '%'+search+'%'); }
  
  const totalRow = db.prepare(`SELECT COUNT(*) as count FROM inventory_audit_log ial JOIN inventory_items ii ON ial.inventory_item_id = ii.id LEFT JOIN users u ON ial.user_id = u.id ${where}`).get(...params);
  const total = totalRow.count;
  const pages = Math.max(1, Math.ceil(total / limit));
  const logs = db.prepare(`
    SELECT ial.*, ii.name as item_name, ii.unit, u.full_name as user_name
    FROM inventory_audit_log ial 
    JOIN inventory_items ii ON ial.inventory_item_id = ii.id
    LEFT JOIN users u ON ial.user_id = u.id
    ${where}
    ORDER BY ial.created_at DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  const inventoryItems = db.prepare('SELECT id, name FROM inventory_items WHERE is_active = 1 ORDER BY name').all();
  const users = db.prepare('SELECT id, full_name FROM users ORDER BY full_name').all();
  const sources = db.prepare('SELECT DISTINCT source FROM inventory_audit_log WHERE source IS NOT NULL ORDER BY source').all().map(r => r.source);
  if (req.headers.accept?.includes('application/json')) return res.json(logs);
  res.render('audit-log', { title: 'Inventory Audit Log', logs, inventoryItems, users, sources, filters: req.query, page, pages, total });
});

// ============ INVENTORY CATEGORY MANAGEMENT (Admin Only) ============
router.get('/categories', (req, res) => {
  const db = req.app.locals.db;
  const categories = db.prepare('SELECT * FROM inventory_categories WHERE is_active = 1 ORDER BY name').all();
  res.json(categories);
});

router.post('/categories', (req, res) => {
  const db = req.app.locals.db;
  // Admin only
  if (req.session.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  try {
    const result = db.prepare('INSERT INTO inventory_categories (name) VALUES (?)').run(name.trim());
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'Category already exists' });
    res.status(500).json({ error: err.message });
  }
});

router.put('/categories/:id', (req, res) => {
  const db = req.app.locals.db;
  // Admin only
  if (req.session.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  try {
    // Also update all items using the old category name
    const oldCat = db.prepare('SELECT name FROM inventory_categories WHERE id = ?').get(req.params.id);
    if (oldCat) {
      db.prepare('UPDATE inventory_items SET category = ? WHERE category = ?').run(name.trim(), oldCat.name);
    }
    db.prepare('UPDATE inventory_categories SET name = ? WHERE id = ?').run(name.trim(), req.params.id);
    res.json({ success: true });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'Category already exists' });
    res.status(500).json({ error: err.message });
  }
});

router.delete('/categories/:id', (req, res) => {
  const db = req.app.locals.db;
  // Admin only
  if (req.session.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    db.prepare('UPDATE inventory_categories SET is_active = 0 WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============ BATCH MANAGEMENT ============

// Get batches for an inventory item
router.get('/:id/batches', (req, res) => {
  const db = req.app.locals.db;
  const { filter } = req.query; // 'all', 'expiring', 'expired'
  const threshold = getExpiryThreshold(db);
  const today = new Date().toISOString().split('T')[0];
  const thresholdDate = new Date(Date.now() + threshold * 86400000).toISOString().split('T')[0];
  
  let where = 'WHERE b.inventory_item_id = ? AND b.is_disposed = 0 AND b.quantity > 0';
  if (filter === 'expiring') {
    where += ` AND b.expiration_date > '${today}' AND b.expiration_date <= '${thresholdDate}'`;
  } else if (filter === 'expired') {
    where += ` AND b.expiration_date <= '${today}'`;
  }
  
  const batches = db.prepare(`
    SELECT b.*, u.full_name as received_by_name
    FROM inventory_batches b
    LEFT JOIN users u ON b.received_by = u.id
    ${where}
    ORDER BY b.expiration_date ASC
  `).all(req.params.id);
  
  // Add computed fields
  const todayMs = new Date(today).getTime();
  batches.forEach(b => {
    const expMs = new Date(b.expiration_date).getTime();
    b.days_left = Math.ceil((expMs - todayMs) / 86400000);
    if (b.days_left <= 0) b.status = 'Expired';
    else if (b.days_left <= threshold) b.status = 'Expiring Soon';
    else b.status = 'OK';
  });
  
  res.json({ batches, threshold });
});

// Dispose / Mark batch as wastage
router.post('/:id/batches/:batchId/dispose', (req, res) => {
  const db = req.app.locals.db;
  const { reason } = req.body;
  const batch = db.prepare('SELECT * FROM inventory_batches WHERE id = ? AND inventory_item_id = ?').get(req.params.batchId, req.params.id);
  if (!batch) return res.status(404).json({ error: 'Batch not found' });
  if (batch.is_disposed) return res.status(400).json({ error: 'Batch already disposed' });
  
  const item = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  
  const tx = db.transaction(() => {
    const qtyToRemove = batch.quantity;
    const newItemQty = Math.max(0, item.quantity - qtyToRemove);
    
    // Mark batch as disposed
    db.prepare('UPDATE inventory_batches SET quantity = 0, is_disposed = 1 WHERE id = ?').run(batch.id);
    
    // Update item total quantity
    db.prepare("UPDATE inventory_items SET quantity = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(newItemQty, req.params.id);
    
    // Audit log
    db.prepare(`INSERT INTO inventory_audit_log (inventory_item_id, action, quantity_change, quantity_before, quantity_after, reason, user_id, batch_id, source) VALUES (?, 'wastage_expired', ?, ?, ?, ?, ?, ?, 'Inventory')`).run(
      req.params.id, -qtyToRemove, item.quantity, newItemQty,
      reason || 'Expired batch disposed (Batch #' + batch.id + ')',
      req.session.user.id, batch.id
    );
    
    return { removed: qtyToRemove, newQuantity: newItemQty };
  });
  
  try {
    const result = tx();
    res.json({ success: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
