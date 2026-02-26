const express = require('express');
const router = express.Router();

// Third-party sales page
router.get('/', (req, res) => {
  const db = req.app.locals.db;
  const month = req.query.month || new Date().toISOString().slice(0, 7);

  const sales = db.prepare(`
    SELECT tps.*, u.full_name as user_name 
    FROM third_party_sales tps LEFT JOIN users u ON tps.user_id = u.id
    WHERE strftime('%Y-%m', tps.date) = ?
    ORDER BY tps.date DESC
  `).all(month);

  const summary = db.prepare(`
    SELECT platform, COUNT(*) as count, COALESCE(SUM(total_amount), 0) as total, COALESCE(SUM(commission), 0) as commission, COALESCE(SUM(net_amount), 0) as net
    FROM third_party_sales WHERE strftime('%Y-%m', date) = ?
    GROUP BY platform
  `).all(month);

  res.render('third-party', { title: 'Third-Party Sales', sales, summary, month });
});

// Add third-party sale
router.post('/', (req, res) => {
  const db = req.app.locals.db;
  const { platform, reference_number, items_description, total_amount, commission, date, notes } = req.body;

  try {
    const totalAmt = parseFloat(total_amount);
    const commissionAmt = parseFloat(commission) || 0;
    const netAmount = totalAmt - commissionAmt;

    const result = db.prepare(`
      INSERT INTO third_party_sales (platform, reference_number, items_description, total_amount, commission, net_amount, date, notes, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(platform, reference_number || null, items_description || null, totalAmt, commissionAmt, netAmount,
      date || new Date().toISOString().split('T')[0], notes || null, req.session.user.id);

    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete third-party sale
router.delete('/:id', (req, res) => {
  const db = req.app.locals.db;
  try {
    db.prepare('DELETE FROM third_party_sales WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
