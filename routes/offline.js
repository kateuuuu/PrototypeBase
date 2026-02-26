const express = require('express');
const router = express.Router();

// Store offline transactions
router.post('/sync', (req, res) => {
  const db = req.app.locals.db;
  const { transactions } = req.body;

  if (!transactions || !Array.isArray(transactions)) {
    return res.status(400).json({ error: 'No transactions provided' });
  }

  const results = [];
  for (const tx of transactions) {
    try {
      db.prepare(`
        INSERT INTO offline_queue (action_type, payload, status) VALUES (?, ?, 'pending')
      `).run(tx.type || 'order', JSON.stringify(tx.data));
      results.push({ success: true });
    } catch (err) {
      results.push({ success: false, error: err.message });
    }
  }

  // Process pending transactions
  const pending = db.prepare("SELECT * FROM offline_queue WHERE status = 'pending' ORDER BY created_at").all();
  for (const item of pending) {
    try {
      // Mark as synced (actual processing would happen based on action_type)
      db.prepare("UPDATE offline_queue SET status = 'synced', synced_at = datetime('now','localtime') WHERE id = ?").run(item.id);
    } catch (err) {
      db.prepare("UPDATE offline_queue SET status = 'failed' WHERE id = ?").run(item.id);
    }
  }

  res.json({ success: true, processed: results.length });
});

// Check sync status
router.get('/status', (req, res) => {
  const db = req.app.locals.db;
  const pending = db.prepare("SELECT COUNT(*) as count FROM offline_queue WHERE status = 'pending'").get();
  const failed = db.prepare("SELECT COUNT(*) as count FROM offline_queue WHERE status = 'failed'").get();
  res.json({ pending: pending.count, failed: failed.count, online: true });
});

module.exports = router;
