const express = require('express');
const router = express.Router();
const { convertUnit } = require('./unitConvert');

router.get('/', (req, res) => {
  const db = req.app.locals.db;
  const categories = db.prepare('SELECT * FROM categories WHERE is_active = 1 ORDER BY sort_order').all();
  const menuItems = db.prepare(`
    SELECT mi.*, c.name as category_name 
    FROM menu_items mi 
    LEFT JOIN categories c ON mi.category_id = c.id 
    WHERE mi.is_available = 1 ORDER BY c.sort_order, mi.name
  `).all();
  const openShift = db.prepare("SELECT * FROM shifts WHERE user_id = ? AND status = 'open'").get(req.session.user.id);
  res.render('pos', { title: 'Point of Sale', categories, menuItems, openShift });
});

router.post('/order', (req, res) => {
  const db = req.app.locals.db;
  const { items, payment_method, amount_paid, discount, discount_type, notes, source } = req.body;
  if (!items || items.length === 0) return res.status(400).json({ error: 'No items in order' });

  // Check if user has an open shift before processing order
  const openShiftCheck = db.prepare("SELECT id FROM shifts WHERE user_id = ? AND status = 'open'").get(req.session.user.id);
  if (!openShiftCheck) {
    return res.status(400).json({ error: 'No open shift. Please start a shift before processing orders.', requireShift: true });
  }

  const processOrder = db.transaction(() => {
    const today = new Date();
    const dateStr = today.toISOString().split('T')[0].replace(/-/g, '');
    const lastOrder = db.prepare("SELECT order_number FROM orders WHERE order_number LIKE ? ORDER BY id DESC LIMIT 1").get('SC-' + dateStr + '-%');
    let seq = 1;
    if (lastOrder) seq = parseInt(lastOrder.order_number.split('-')[2]) + 1;
    const orderNumber = 'SC-' + dateStr + '-' + String(seq).padStart(4, '0');
    const openShift = openShiftCheck; // Reuse the check result

    let subtotal = 0;
    const orderItems = [];
    for (const item of items) {
      const menuItem = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(item.menu_item_id);
      if (!menuItem) throw new Error('Menu item ' + item.menu_item_id + ' not found');
      const qty = parseInt(item.quantity) || 1;
      const totalPrice = menuItem.price * qty;
      subtotal += totalPrice;
      orderItems.push({ menu_item_id: menuItem.id, item_name: menuItem.name, quantity: qty, unit_price: menuItem.price, total_price: totalPrice, notes: item.notes || null });
    }

    // Calculate discount
    let discountAmt = 0;
    const dType = discount_type || 'none';
    if (dType === 'senior' || dType === 'pwd') {
      discountAmt = subtotal * 0.20;
    } else {
      discountAmt = parseFloat(discount) || 0;
    }

    const total = Math.max(0, subtotal - discountAmt);
    const amountPaidVal = parseFloat(amount_paid) || total;
    const changeAmount = Math.max(0, amountPaidVal - total);
    const pMethod = payment_method || 'cash';

    const orderResult = db.prepare(`
      INSERT INTO orders (order_number, user_id, shift_id, subtotal, discount, discount_type, total, payment_method, amount_paid, change_amount, status, source, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?)
    `).run(orderNumber, req.session.user.id, openShift?.id || null, subtotal, discountAmt, dType, total, pMethod, amountPaidVal, changeAmount, source || 'in-store', notes || null);
    const orderId = orderResult.lastInsertRowid;

    const insertItem = db.prepare('INSERT INTO order_items (order_id, menu_item_id, item_name, quantity, unit_price, total_price, notes) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const oi of orderItems) {
      insertItem.run(orderId, oi.menu_item_id, oi.item_name, oi.quantity, oi.unit_price, oi.total_price, oi.notes);
      // Deduct ingredients with unit conversion
      const recipes = db.prepare(`
        SELECT r.*, ii.quantity as current_stock, ii.name as ingredient_name, ii.unit as inventory_unit
        FROM recipes r JOIN inventory_items ii ON r.inventory_item_id = ii.id WHERE r.menu_item_id = ?
      `).all(oi.menu_item_id);
      for (const recipe of recipes) {
        const recipeUnit = recipe.recipe_unit || recipe.inventory_unit;
        const neededInRecipeUnit = recipe.quantity_needed * oi.quantity;
        const deduction = convertUnit(neededInRecipeUnit, recipeUnit, recipe.inventory_unit);
        const newQty = Math.max(0, recipe.current_stock - deduction);
        db.prepare("UPDATE inventory_items SET quantity = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(newQty, recipe.inventory_item_id);
        db.prepare("INSERT INTO inventory_audit_log (inventory_item_id, action, quantity_change, quantity_before, quantity_after, reason, reference_id, user_id) VALUES (?, 'sale_deduction', ?, ?, ?, ?, ?, ?)").run(recipe.inventory_item_id, -deduction, recipe.current_stock, newQty, 'Sold ' + oi.quantity + 'x ' + oi.item_name, orderNumber, req.session.user.id);
      }
    }
    return { orderId, orderNumber, subtotal, discount: discountAmt, discount_type: dType, total, amountPaid: amountPaidVal, change: changeAmount, payment_method: pMethod, items: orderItems, cashier: req.session.user.full_name, date: new Date().toLocaleString() };
  });

  try {
    const result = processOrder();
    res.json({ success: true, order: result });
  } catch (err) {
    console.error('Order error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/void/:id', (req, res) => {
  const db = req.app.locals.db;
  if (req.session.user.role !== 'admin') return res.status(403).json({ error: 'Only admins can void orders' });
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status === 'voided') return res.status(400).json({ error: 'Order already voided' });

  const voidOrder = db.transaction(() => {
    db.prepare("UPDATE orders SET status = 'voided' WHERE id = ?").run(order.id);
    const orderItems = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
    for (const oi of orderItems) {
      const recipes = db.prepare('SELECT r.*, ii.quantity as current_stock, ii.unit as inventory_unit FROM recipes r JOIN inventory_items ii ON r.inventory_item_id = ii.id WHERE r.menu_item_id = ?').all(oi.menu_item_id);
      for (const recipe of recipes) {
        const recipeUnit = recipe.recipe_unit || recipe.inventory_unit;
        const restore = convertUnit(recipe.quantity_needed * oi.quantity, recipeUnit, recipe.inventory_unit);
        const newQty = recipe.current_stock + restore;
        db.prepare("UPDATE inventory_items SET quantity = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(newQty, recipe.inventory_item_id);
        db.prepare("INSERT INTO inventory_audit_log (inventory_item_id, action, quantity_change, quantity_before, quantity_after, reason, reference_id, user_id) VALUES (?, 'adjustment', ?, ?, ?, ?, ?, ?)").run(recipe.inventory_item_id, restore, recipe.current_stock, newQty, 'Voided order ' + order.order_number, order.order_number, req.session.user.id);
      }
    }
  });
  try { voidOrder(); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/order/:id', (req, res) => {
  const db = req.app.locals.db;
  const order = db.prepare('SELECT o.*, u.full_name as cashier_name FROM orders o LEFT JOIN users u ON o.user_id = u.id WHERE o.id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
  res.json({ order, items });
});

router.get('/history', (req, res) => {
  const db = req.app.locals.db;
  const { date, page = 1 } = req.query;
  const limit = 50;
  const offset = (page - 1) * limit;
  let whereClause = 'WHERE 1=1';
  const params = [];
  if (date) { whereClause += ' AND date(o.created_at) = ?'; params.push(date); }
  const total = db.prepare('SELECT COUNT(*) as cnt FROM orders o ' + whereClause).get(...params);
  const orders = db.prepare('SELECT o.*, u.full_name as cashier_name FROM orders o LEFT JOIN users u ON o.user_id = u.id ' + whereClause + ' ORDER BY o.created_at DESC LIMIT ? OFFSET ?').all(...params, limit, offset);
  if (req.headers.accept?.includes('application/json')) {
    return res.json({ orders, total: total.cnt, page: parseInt(page), pages: Math.ceil(total.cnt / limit) });
  }
  res.render('order-history', { title: 'Order History', orders, total: total.cnt, page: parseInt(page), pages: Math.ceil(total.cnt / limit), date });
});

module.exports = router;
