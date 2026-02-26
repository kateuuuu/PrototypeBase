const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  const db = req.app.locals.db;
  
  // Get shifts with computed expected cash and difference
  const shifts = db.prepare(`
    SELECT s.*, u.full_name as user_name,
      (SELECT COUNT(*) FROM orders o WHERE o.shift_id = s.id AND o.status = 'completed') as order_count,
      (SELECT COALESCE(SUM(o.total), 0) FROM orders o WHERE o.shift_id = s.id AND o.status = 'completed') as shift_sales,
      (SELECT COALESCE(SUM(CASE WHEN o.payment_method = 'cash' THEN o.total ELSE 0 END), 0) 
       FROM orders o WHERE o.shift_id = s.id AND o.status = 'completed') as cash_sales
    FROM shifts s JOIN users u ON s.user_id = u.id ORDER BY s.start_time DESC LIMIT 50
  `).all();
  
  // Get my open shift
  const myOpenShift = db.prepare("SELECT * FROM shifts WHERE user_id = ? AND status = 'open'").get(req.session.user.id);
  
  // Get last closed shift's ending cash for default starting cash
  const lastShift = db.prepare(`
    SELECT ending_cash FROM shifts 
    WHERE status = 'closed' 
    ORDER BY end_time DESC LIMIT 1
  `).get();
  const defaultStartingCash = lastShift ? lastShift.ending_cash : 0;
  
  // If there's an open shift, get its cash sales for the end shift modal
  let openShiftCashSales = 0;
  if (myOpenShift) {
    const cashSalesResult = db.prepare(`
      SELECT COALESCE(SUM(total), 0) as cash_sales 
      FROM orders 
      WHERE shift_id = ? AND status = 'completed' AND payment_method = 'cash'
    `).get(myOpenShift.id);
    openShiftCashSales = cashSalesResult ? cashSalesResult.cash_sales : 0;
  }
  
  res.render('shifts', { 
    title: 'Shift Management', 
    shifts, 
    myOpenShift, 
    defaultStartingCash,
    openShiftCashSales
  });
});

// Get shift info (for end shift modal)
router.get('/info/:id', (req, res) => {
  const db = req.app.locals.db;
  const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(req.params.id);
  if (!shift) return res.status(404).json({ error: 'Shift not found' });
  
  const summary = db.prepare(`
    SELECT 
      COALESCE(SUM(CASE WHEN payment_method = 'cash' THEN total ELSE 0 END), 0) as cash_sales,
      COALESCE(SUM(total), 0) as total_sales,
      COUNT(*) as order_count
    FROM orders WHERE shift_id = ? AND status = 'completed'
  `).get(req.params.id);
  
  const expectedCash = (shift.starting_cash || 0) + (summary.cash_sales || 0);
  
  res.json({
    shift,
    cash_sales: summary.cash_sales,
    total_sales: summary.total_sales,
    order_count: summary.order_count,
    expected_cash: expectedCash
  });
});

router.post('/start', (req, res) => {
  const db = req.app.locals.db;
  const { starting_cash } = req.body;
  
  // Validate starting cash
  const startCash = parseFloat(starting_cash) || 0;
  if (startCash < 0) {
    return res.status(400).json({ error: 'Starting cash cannot be negative' });
  }
  
  const existing = db.prepare("SELECT * FROM shifts WHERE user_id = ? AND status = 'open'").get(req.session.user.id);
  if (existing) {
    return res.status(400).json({ error: 'You already have an open shift. Please end it first.' });
  }
  
  try {
    const result = db.prepare('INSERT INTO shifts (user_id, starting_cash) VALUES (?, ?)').run(req.session.user.id, startCash);
    res.json({ success: true, shift_id: result.lastInsertRowid });
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

router.post('/end/:id', (req, res) => {
  const db = req.app.locals.db;
  const { ending_cash, notes, difference_reason } = req.body;
  
  const shift = db.prepare("SELECT * FROM shifts WHERE id = ? AND status = 'open'").get(req.params.id);
  if (!shift) return res.status(404).json({ error: 'Open shift not found' });
  if (shift.user_id !== req.session.user.id && req.session.user.role !== 'admin') {
    return res.status(403).json({ error: 'You can only end your own shift' });
  }
  
  // Validate ending cash
  const endCash = parseFloat(ending_cash);
  if (isNaN(endCash)) {
    return res.status(400).json({ error: 'Actual ending cash is required' });
  }
  if (endCash < 0) {
    return res.status(400).json({ error: 'Ending cash cannot be negative' });
  }
  
  try {
    // Calculate expected cash
    const cashSalesResult = db.prepare(`
      SELECT COALESCE(SUM(total), 0) as cash_sales 
      FROM orders WHERE shift_id = ? AND status = 'completed' AND payment_method = 'cash'
    `).get(req.params.id);
    const cashSales = cashSalesResult.cash_sales || 0;
    const expectedCash = (shift.starting_cash || 0) + cashSales;
    const difference = endCash - expectedCash;
    
    // Build notes with difference reason if provided
    let finalNotes = notes || '';
    if (difference !== 0 && difference_reason) {
      finalNotes += (finalNotes ? '\n' : '') + '[Cash Difference Reason: ' + difference_reason + ']';
    }
    
    db.prepare(`
      UPDATE shifts 
      SET end_time = datetime('now','localtime'), 
          ending_cash = ?, 
          expected_cash = ?,
          cash_difference = ?,
          notes = ?, 
          status = 'closed' 
      WHERE id = ?
    `).run(endCash, expectedCash, difference, finalNotes || null, req.params.id);
    
    const summary = db.prepare(`
      SELECT COUNT(*) as total_orders, COALESCE(SUM(total), 0) as total_sales,
        COALESCE(SUM(CASE WHEN payment_method = 'cash' THEN total ELSE 0 END), 0) as cash_sales,
        COALESCE(SUM(CASE WHEN payment_method = 'gcash' THEN total ELSE 0 END), 0) as gcash_sales,
        COALESCE(SUM(CASE WHEN payment_method = 'card' THEN total ELSE 0 END), 0) as card_sales,
        COALESCE(SUM(CASE WHEN payment_method = 'platform' THEN total ELSE 0 END), 0) as platform_sales,
        COALESCE(SUM(CASE WHEN source = 'in-store' OR source IS NULL THEN total ELSE 0 END), 0) as instore_sales,
        COALESCE(SUM(CASE WHEN source = 'grab' THEN total ELSE 0 END), 0) as grab_sales,
        COALESCE(SUM(CASE WHEN source = 'foodpanda' THEN total ELSE 0 END), 0) as foodpanda_sales
      FROM orders WHERE shift_id = ? AND status = 'completed'
    `).get(req.params.id);
    
    summary.expected_cash = expectedCash;
    summary.cash_difference = difference;
    
    res.json({ success: true, summary });
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

router.get('/summary/:id', (req, res) => {
  const db = req.app.locals.db;
  const shift = db.prepare('SELECT s.*, u.full_name as user_name FROM shifts s JOIN users u ON s.user_id = u.id WHERE s.id = ?').get(req.params.id);
  if (!shift) return res.status(404).json({ error: 'Shift not found' });
  
  const orders = db.prepare('SELECT * FROM orders WHERE shift_id = ? ORDER BY created_at').all(req.params.id);
  
  const summary = db.prepare(`
    SELECT COUNT(*) as total_orders, COALESCE(SUM(total), 0) as total_sales,
      COALESCE(SUM(CASE WHEN payment_method = 'cash' THEN total ELSE 0 END), 0) as cash_sales,
      COALESCE(SUM(CASE WHEN payment_method = 'gcash' THEN total ELSE 0 END), 0) as gcash_sales,
      COALESCE(SUM(CASE WHEN payment_method = 'card' THEN total ELSE 0 END), 0) as card_sales,
      COALESCE(SUM(CASE WHEN payment_method = 'platform' THEN total ELSE 0 END), 0) as platform_sales,
      COALESCE(SUM(CASE WHEN source = 'in-store' OR source IS NULL THEN total ELSE 0 END), 0) as instore_sales,
      COALESCE(SUM(CASE WHEN source = 'grab' THEN total ELSE 0 END), 0) as grab_sales,
      COALESCE(SUM(CASE WHEN source = 'foodpanda' THEN total ELSE 0 END), 0) as foodpanda_sales,
      COALESCE(SUM(discount), 0) as total_discounts,
      COALESCE(SUM(CASE WHEN status = 'voided' THEN total ELSE 0 END), 0) as voided_total,
      COUNT(CASE WHEN source = 'in-store' OR source IS NULL THEN 1 END) as instore_count,
      COUNT(CASE WHEN source = 'grab' THEN 1 END) as grab_count,
      COUNT(CASE WHEN source = 'foodpanda' THEN 1 END) as foodpanda_count
    FROM orders WHERE shift_id = ?
  `).get(req.params.id);
  
  const topItems = db.prepare(`
    SELECT oi.item_name, SUM(oi.quantity) as qty, SUM(oi.total_price) as revenue
    FROM order_items oi JOIN orders o ON oi.order_id = o.id 
    WHERE o.shift_id = ? AND o.status = 'completed'
    GROUP BY oi.item_name ORDER BY qty DESC LIMIT 10
  `).all(req.params.id);
  
  res.json({ shift, orders, summary, topItems });
});

// Check if user has open shift (for POS blocking)
router.get('/check', (req, res) => {
  const db = req.app.locals.db;
  const openShift = db.prepare("SELECT id FROM shifts WHERE user_id = ? AND status = 'open'").get(req.session.user.id);
  res.json({ hasOpenShift: !!openShift, shiftId: openShift?.id || null });
});

module.exports = router;
