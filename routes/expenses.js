const express = require('express');
const router = express.Router();
const { roleCheck } = require('../middleware/auth');

// Helper: Get date range for quick filters
function getDateRange(quickFilter) {
  const today = new Date();
  const startOfWeek = new Date(today);
  startOfWeek.setDate(today.getDate() - today.getDay());
  
  switch (quickFilter) {
    case 'this_week':
      return {
        from: startOfWeek.toISOString().split('T')[0],
        to: today.toISOString().split('T')[0]
      };
    case 'this_month':
      return {
        from: new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0],
        to: today.toISOString().split('T')[0]
      };
    case 'last_month':
      const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const lastMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0);
      return {
        from: lastMonth.toISOString().split('T')[0],
        to: lastMonthEnd.toISOString().split('T')[0]
      };
    default:
      return null;
  }
}

// GET Expenses page with filters
router.get('/', (req, res) => {
  const db = req.app.locals.db;
  const userRole = req.session.user.role;
  
  // Parse filters
  let { search, category, from, to, quickFilter } = req.query;
  
  // Apply quick filter if set
  if (quickFilter && quickFilter !== 'custom') {
    const range = getDateRange(quickFilter);
    if (range) {
      from = range.from;
      to = range.to;
    }
  }
  
  // Default date range: this month
  if (!from && !to && !quickFilter) {
    const today = new Date();
    from = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0];
    to = today.toISOString().split('T')[0];
    quickFilter = 'this_month';
  }
  
  // Build query
  let sql = `
    SELECT e.*, u.full_name as user_name,
      CASE WHEN e.po_reference IS NOT NULL THEN 
        (SELECT po.id FROM purchase_orders po WHERE po.po_number = e.po_reference LIMIT 1)
      ELSE NULL END as linked_po_id
    FROM expenses e 
    LEFT JOIN users u ON e.user_id = u.id
    WHERE 1=1
  `;
  const params = [];
  
  // Date range filter
  if (from) {
    sql += ` AND e.date >= ?`;
    params.push(from);
  }
  if (to) {
    sql += ` AND e.date <= ?`;
    params.push(to);
  }
  
  // Search filter (description, receipt_ref, vendor_supplier)
  if (search && search.trim()) {
    sql += ` AND (e.description LIKE ? OR e.receipt_ref LIKE ? OR e.vendor_supplier LIKE ?)`;
    const searchTerm = '%' + search.trim() + '%';
    params.push(searchTerm, searchTerm, searchTerm);
  }
  
  // Category filter
  if (category && category !== 'all') {
    sql += ` AND e.category = ?`;
    params.push(category);
  }
  
  sql += ` ORDER BY e.date DESC, e.created_at DESC`;
  
  const expenses = db.prepare(sql).all(...params);
  
  // Summary by category (filtered)
  let summarySql = `
    SELECT category, COALESCE(SUM(amount), 0) as total, COUNT(*) as count
    FROM expenses WHERE 1=1
  `;
  const summaryParams = [];
  if (from) { summarySql += ` AND date >= ?`; summaryParams.push(from); }
  if (to) { summarySql += ` AND date <= ?`; summaryParams.push(to); }
  if (search && search.trim()) {
    summarySql += ` AND (description LIKE ? OR receipt_ref LIKE ? OR vendor_supplier LIKE ?)`;
    const searchTerm = '%' + search.trim() + '%';
    summaryParams.push(searchTerm, searchTerm, searchTerm);
  }
  if (category && category !== 'all') {
    summarySql += ` AND category = ?`;
    summaryParams.push(category);
  }
  summarySql += ` GROUP BY category ORDER BY total DESC`;
  
  const summary = db.prepare(summarySql).all(...summaryParams);
  
  // Calculate totals
  const totalExpenses = expenses.reduce((s, e) => s + e.amount, 0);
  const topCategory = summary.length > 0 ? summary[0] : null;
  
  // Calculate average per day (filtered range)
  let avgPerDay = 0;
  if (from && to && totalExpenses > 0) {
    const dayCount = Math.ceil((new Date(to) - new Date(from)) / (1000 * 60 * 60 * 24)) + 1;
    avgPerDay = totalExpenses / dayCount;
  }
  
  // Get this month total (always calculate for header card)
  const thisMonthStart = new Date().toISOString().slice(0, 7) + '-01';
  const thisMonthTotal = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE date >= ?
  `).get(thisMonthStart).total;
  
  // Get all expense categories (for dropdown)
  let categories = [];
  try {
    categories = db.prepare('SELECT * FROM expense_categories WHERE is_active = 1 ORDER BY name').all();
  } catch (e) {
    // Fallback to default categories if table doesn't exist
    categories = [
      { name: 'Inventory Purchase' }, { name: 'Utilities' }, { name: 'Rent' },
      { name: 'Wages' }, { name: 'Platform Fees' }, { name: 'Marketing' },
      { name: 'Maintenance' }, { name: 'Packaging' }, { name: 'Misc' }
    ];
  }
  
  // Get received POs for linking dropdown
  const receivedPOs = db.prepare(`
    SELECT id, po_number, supplier_name, total_cost, received_date 
    FROM purchase_orders 
    WHERE status = 'received' 
    ORDER BY received_date DESC 
    LIMIT 100
  `).all();
  
  res.render('expenses', { 
    title: 'Expense Tracking', 
    expenses, 
    summary, 
    totalExpenses,
    topCategory,
    avgPerDay,
    thisMonthTotal,
    categories,
    receivedPOs,
    filters: { search, category, from, to, quickFilter },
    userRole,
    canEdit: userRole === 'admin',
    canAdd: userRole === 'admin' || userRole === 'inventory_clerk',
    canDelete: userRole === 'admin'
  });
});

// GET CSV Export
router.get('/export', (req, res) => {
  const db = req.app.locals.db;
  let { search, category, from, to, quickFilter } = req.query;
  
  // Apply quick filter
  if (quickFilter && quickFilter !== 'custom') {
    const range = getDateRange(quickFilter);
    if (range) { from = range.from; to = range.to; }
  }
  
  // Build query
  let sql = `
    SELECT e.date, e.category, e.description, e.amount, e.receipt_ref, 
           e.vendor_supplier, e.po_reference, u.full_name as created_by
    FROM expenses e 
    LEFT JOIN users u ON e.user_id = u.id
    WHERE 1=1
  `;
  const params = [];
  
  if (from) { sql += ` AND e.date >= ?`; params.push(from); }
  if (to) { sql += ` AND e.date <= ?`; params.push(to); }
  if (search && search.trim()) {
    sql += ` AND (e.description LIKE ? OR e.receipt_ref LIKE ? OR e.vendor_supplier LIKE ?)`;
    const searchTerm = '%' + search.trim() + '%';
    params.push(searchTerm, searchTerm, searchTerm);
  }
  if (category && category !== 'all') { sql += ` AND e.category = ?`; params.push(category); }
  sql += ` ORDER BY e.date DESC`;
  
  const rows = db.prepare(sql).all(...params);
  
  // Build CSV
  const headers = ['Date', 'Category', 'Description', 'Amount', 'Receipt Ref', 'Vendor/Supplier', 'Linked PO', 'Created By'];
  let csv = headers.join(',') + '\n';
  
  rows.forEach(r => {
    csv += [
      r.date,
      '"' + (r.category || '').replace(/"/g, '""') + '"',
      '"' + (r.description || '').replace(/"/g, '""') + '"',
      r.amount.toFixed(2),
      '"' + (r.receipt_ref || '').replace(/"/g, '""') + '"',
      '"' + (r.vendor_supplier || '').replace(/"/g, '""') + '"',
      r.po_reference || '',
      '"' + (r.created_by || '').replace(/"/g, '""') + '"'
    ].join(',') + '\n';
  });
  
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="expenses_' + (from || 'all') + '_' + (to || 'all') + '.csv"');
  res.send(csv);
});

// GET expense categories (Admin)
router.get('/categories', roleCheck('admin'), (req, res) => {
  const db = req.app.locals.db;
  let categories = [];
  try {
    categories = db.prepare('SELECT * FROM expense_categories ORDER BY name').all();
  } catch (e) {
    categories = [];
  }
  res.render('expense-categories', { title: 'Manage Expense Categories', categories });
});

// POST create expense category (Admin)
router.post('/categories', roleCheck('admin'), (req, res) => {
  const db = req.app.locals.db;
  const { name } = req.body;
  
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Category name is required' });
  }
  
  try {
    const result = db.prepare('INSERT INTO expense_categories (name) VALUES (?)').run(name.trim());
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(400).json({ error: 'Category already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// PUT update expense category (Admin)
router.put('/categories/:id', roleCheck('admin'), (req, res) => {
  const db = req.app.locals.db;
  const { name, is_active } = req.body;
  
  try {
    if (name !== undefined) {
      const existing = db.prepare('SELECT id FROM expense_categories WHERE name = ? AND id != ?').get(name.trim(), req.params.id);
      if (existing) {
        return res.status(400).json({ error: 'Category name already exists' });
      }
      db.prepare('UPDATE expense_categories SET name = ? WHERE id = ?').run(name.trim(), req.params.id);
    }
    if (is_active !== undefined) {
      db.prepare('UPDATE expense_categories SET is_active = ? WHERE id = ?').run(is_active ? 1 : 0, req.params.id);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE expense category (Admin) - soft delete
router.delete('/categories/:id', roleCheck('admin'), (req, res) => {
  const db = req.app.locals.db;
  try {
    // Check if category is in use
    const cat = db.prepare('SELECT name FROM expense_categories WHERE id = ?').get(req.params.id);
    if (cat) {
      const usageCount = db.prepare('SELECT COUNT(*) as cnt FROM expenses WHERE category = ?').get(cat.name).cnt;
      if (usageCount > 0) {
        // Soft delete - just disable
        db.prepare('UPDATE expense_categories SET is_active = 0 WHERE id = ?').run(req.params.id);
        return res.json({ success: true, message: 'Category disabled (has existing expenses)' });
      }
    }
    db.prepare('DELETE FROM expense_categories WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST Add expense
router.post('/', (req, res) => {
  const db = req.app.locals.db;
  const userRole = req.session.user.role;
  
  // Role check: admin and inventory_clerk can add
  if (userRole !== 'admin' && userRole !== 'inventory_clerk') {
    return res.status(403).json({ error: 'Permission denied' });
  }
  
  const { category, description, amount, date, receipt_ref, vendor_supplier, payment_method, po_reference, receipt_file } = req.body;
  
  // Validation
  if (!category || !category.trim()) {
    return res.status(400).json({ error: 'Category is required' });
  }
  if (!description || !description.trim()) {
    return res.status(400).json({ error: 'Description is required' });
  }
  if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
    return res.status(400).json({ error: 'Valid amount is required' });
  }
  if (!date) {
    return res.status(400).json({ error: 'Date is required' });
  }

  try {
    const result = db.prepare(`
      INSERT INTO expenses (category, description, amount, date, receipt_ref, vendor_supplier, payment_method, po_reference, receipt_file, user_id) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      category.trim(),
      description.trim(),
      parseFloat(amount),
      date,
      receipt_ref || null,
      vendor_supplier || null,
      payment_method || 'Cash',
      po_reference || null,
      receipt_file || null,
      req.session.user.id
    );
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT Update expense
router.put('/:id', (req, res) => {
  const db = req.app.locals.db;
  const userRole = req.session.user.role;
  
  // Only admin can edit
  if (userRole !== 'admin') {
    return res.status(403).json({ error: 'Only admin can edit expenses' });
  }
  
  const { category, description, amount, date, receipt_ref, vendor_supplier, payment_method, po_reference, receipt_file } = req.body;
  
  // Validation
  if (!category || !category.trim()) {
    return res.status(400).json({ error: 'Category is required' });
  }
  if (!description || !description.trim()) {
    return res.status(400).json({ error: 'Description is required' });
  }
  if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
    return res.status(400).json({ error: 'Valid amount is required' });
  }
  if (!date) {
    return res.status(400).json({ error: 'Date is required' });
  }

  try {
    db.prepare(`
      UPDATE expenses 
      SET category=?, description=?, amount=?, date=?, receipt_ref=?, vendor_supplier=?, payment_method=?, po_reference=?, receipt_file=?
      WHERE id=?
    `).run(
      category.trim(),
      description.trim(),
      parseFloat(amount),
      date,
      receipt_ref || null,
      vendor_supplier || null,
      payment_method || 'Cash',
      po_reference || null,
      receipt_file || null,
      req.params.id
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE expense
router.delete('/:id', roleCheck('admin'), (req, res) => {
  const db = req.app.locals.db;
  try {
    db.prepare('DELETE FROM expenses WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET PO details for auto-fill
router.get('/po/:poNumber', (req, res) => {
  const db = req.app.locals.db;
  const po = db.prepare(`
    SELECT id, po_number, supplier_name, total_cost, received_date 
    FROM purchase_orders 
    WHERE po_number = ? AND status = 'received'
  `).get(req.params.poNumber);
  
  if (!po) {
    return res.status(404).json({ error: 'PO not found' });
  }
  
  res.json({
    po_number: po.po_number,
    supplier_name: po.supplier_name,
    total_cost: po.total_cost,
    received_date: po.received_date
  });
});

module.exports = router;
