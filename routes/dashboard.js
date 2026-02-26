const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  const db = req.app.locals.db;
  const today = new Date().toISOString().split('T')[0];

  // Today's sales
  const todaySales = db.prepare(`
    SELECT COALESCE(SUM(total), 0) as total, COUNT(*) as count 
    FROM orders WHERE date(created_at) = ? AND status = 'completed'
  `).get(today);

  // Today's expenses
  const todayExpenses = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total 
    FROM expenses WHERE date = ?
  `).get(today);

  // Low stock items count
  const lowStock = db.prepare(`
    SELECT COUNT(*) as count FROM inventory_items 
    WHERE quantity <= reorder_level AND is_active = 1
  `).get();

  // Active employees on shift
  const activeShifts = db.prepare(`
    SELECT COUNT(*) as count FROM shifts WHERE status = 'open'
  `).get();

  // Recent orders
  const recentOrders = db.prepare(`
    SELECT o.*, u.full_name as cashier_name 
    FROM orders o LEFT JOIN users u ON o.user_id = u.id 
    ORDER BY o.created_at DESC LIMIT 10
  `).all();

  // Top selling items today
  const topItems = db.prepare(`
    SELECT oi.item_name, SUM(oi.quantity) as qty, SUM(oi.total_price) as revenue
    FROM order_items oi 
    JOIN orders o ON oi.order_id = o.id 
    WHERE date(o.created_at) = ? AND o.status = 'completed'
    GROUP BY oi.item_name ORDER BY qty DESC LIMIT 5
  `).all(today);

  // Sales last 7 days for chart
  const salesChart = db.prepare(`
    SELECT date(created_at) as date, COALESCE(SUM(total), 0) as total
    FROM orders WHERE status = 'completed' AND created_at >= date('now','localtime','-7 days')
    GROUP BY date(created_at) ORDER BY date
  `).all();

  // Low stock alerts
  const lowStockItems = db.prepare(`
    SELECT * FROM inventory_items 
    WHERE quantity <= reorder_level AND is_active = 1
    ORDER BY (quantity / CASE WHEN reorder_level > 0 THEN reorder_level ELSE 1 END) ASC
    LIMIT 10
  `).all();

  res.render('dashboard', {
    title: 'Dashboard',
    todaySales,
    todayExpenses,
    lowStock,
    activeShifts,
    recentOrders,
    topItems,
    salesChart,
    lowStockItems
  });
});

module.exports = router;
