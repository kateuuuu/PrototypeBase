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
  
  // Load variants for each menu item
  const getVariants = db.prepare('SELECT * FROM menu_item_variants WHERE menu_item_id = ? AND is_available = 1 ORDER BY sort_order, id');
  for (const item of menuItems) {
    item.variants = getVariants.all(item.id);
    if (item.variants.length > 0) {
      const prices = item.variants.map(v => v.price);
      item.min_price = Math.min(...prices);
      item.max_price = Math.max(...prices);
    }
  }
  
  // Load add-ons
  const addons = db.prepare(`
    SELECT a.*, c.name as category_name 
    FROM menu_item_addons a 
    LEFT JOIN categories c ON a.category_id = c.id 
    WHERE a.is_active = 1 ORDER BY a.name
  `).all();
  
  const openShift = db.prepare("SELECT * FROM shifts WHERE user_id = ? AND status = 'open'").get(req.session.user.id);
  res.render('pos', { title: 'Point of Sale', categories, menuItems, addons, openShift });
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
    const openShift = openShiftCheck;

    let subtotal = 0;
    const orderItems = [];
    
    for (const item of items) {
      const menuItem = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(item.menu_item_id);
      if (!menuItem) throw new Error('Menu item ' + item.menu_item_id + ' not found');
      
      const qty = parseInt(item.quantity) || 1;
      let unitPrice = menuItem.price;
      let variantId = null;
      let variantName = null;
      let itemDisplayName = menuItem.name;
      
      // Check if variant is specified
      if (item.variant_id) {
        const variant = db.prepare('SELECT * FROM menu_item_variants WHERE id = ? AND menu_item_id = ?').get(item.variant_id, item.menu_item_id);
        if (variant) {
          unitPrice = variant.price;
          variantId = variant.id;
          variantName = variant.name;
          itemDisplayName = menuItem.name + ' (' + variant.name + ')';
        }
      }
      
      // Calculate add-ons price
      let addonsTotal = 0;
      const selectedAddons = [];
      if (item.addons && Array.isArray(item.addons)) {
        for (const addonId of item.addons) {
          const addon = db.prepare('SELECT * FROM menu_item_addons WHERE id = ?').get(addonId);
          if (addon) {
            addonsTotal += addon.price;
            selectedAddons.push({ id: addon.id, name: addon.name, price: addon.price });
          }
        }
      }
      
      const linePrice = unitPrice + addonsTotal;
      const totalPrice = linePrice * qty;
      subtotal += totalPrice;
      
      orderItems.push({ 
        menu_item_id: menuItem.id, 
        item_name: itemDisplayName, 
        variant_id: variantId,
        variant_name: variantName,
        quantity: qty, 
        unit_price: linePrice, 
        total_price: totalPrice, 
        notes: item.notes || null,
        addons: selectedAddons
      });
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

    const insertItem = db.prepare('INSERT INTO order_items (order_id, menu_item_id, item_name, variant_id, variant_name, quantity, unit_price, total_price, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const insertAddon = db.prepare('INSERT INTO order_item_addons (order_item_id, addon_id, addon_name, addon_price) VALUES (?, ?, ?, ?)');
    
    for (const oi of orderItems) {
      const itemResult = insertItem.run(orderId, oi.menu_item_id, oi.item_name, oi.variant_id, oi.variant_name, oi.quantity, oi.unit_price, oi.total_price, oi.notes);
      const orderItemId = itemResult.lastInsertRowid;
      
      // Insert add-ons
      for (const addon of oi.addons) {
        insertAddon.run(orderItemId, addon.id, addon.name, addon.price);
      }
      
      // Determine which recipes to use (variant-specific or base)
      let recipes = [];
      if (oi.variant_id) {
        // Use variant recipes
        recipes = db.prepare(`
          SELECT vr.inventory_item_id, vr.quantity_needed, vr.recipe_unit, 
                 ii.quantity as current_stock, ii.name as ingredient_name, ii.unit as inventory_unit
          FROM variant_recipes vr 
          JOIN inventory_items ii ON vr.inventory_item_id = ii.id 
          WHERE vr.variant_id = ?
        `).all(oi.variant_id);
      } else {
        // Use base recipes
        recipes = db.prepare(`
          SELECT r.inventory_item_id, r.quantity_needed, r.recipe_unit, 
                 ii.quantity as current_stock, ii.name as ingredient_name, ii.unit as inventory_unit
          FROM recipes r 
          JOIN inventory_items ii ON r.inventory_item_id = ii.id 
          WHERE r.menu_item_id = ?
        `).all(oi.menu_item_id);
      }
      
      // Deduct ingredients
      for (const recipe of recipes) {
        const recipeUnit = recipe.recipe_unit || recipe.inventory_unit;
        const neededInRecipeUnit = recipe.quantity_needed * oi.quantity;
        const deduction = convertUnit(neededInRecipeUnit, recipeUnit, recipe.inventory_unit);
        const newQty = Math.max(0, recipe.current_stock - deduction);
        
        // FEFO: Deduct from batches if item tracks expiry
        const invItem = db.prepare('SELECT track_expiry FROM inventory_items WHERE id = ?').get(recipe.inventory_item_id);
        const batchDeductions = [];
        if (invItem && invItem.track_expiry) {
          const batches = db.prepare(`SELECT * FROM inventory_batches WHERE inventory_item_id = ? AND is_disposed = 0 AND quantity > 0 ORDER BY expiration_date ASC`).all(recipe.inventory_item_id);
          let remaining = deduction;
          for (const batch of batches) {
            if (remaining <= 0) break;
            const deductFromBatch = Math.min(remaining, batch.quantity);
            db.prepare('UPDATE inventory_batches SET quantity = quantity - ? WHERE id = ?').run(deductFromBatch, batch.id);
            batchDeductions.push({ batchId: batch.id, qty: deductFromBatch, expiration_date: batch.expiration_date });
            remaining -= deductFromBatch;
          }
          if (remaining > 0) batchDeductions.push({ batchId: null, qty: remaining, note: 'insufficient batch stock' });
        }
        
        db.prepare("UPDATE inventory_items SET quantity = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(newQty, recipe.inventory_item_id);
        
        // Write audit log entries
        if (batchDeductions.length > 0) {
          let runningBefore = recipe.current_stock;
          for (const bd of batchDeductions) {
            const runningAfter = Math.max(0, runningBefore - bd.qty);
            const expiryInfo = bd.expiration_date ? ' | Batch #' + bd.batchId + ' exp ' + new Date(bd.expiration_date).toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'}) : (bd.note ? ' (' + bd.note + ')' : '');
            db.prepare("INSERT INTO inventory_audit_log (inventory_item_id, action, quantity_change, quantity_before, quantity_after, reason, reference_id, user_id, batch_id, source) VALUES (?, 'sale_deduction', ?, ?, ?, ?, ?, ?, ?, 'POS')").run(
              recipe.inventory_item_id, -bd.qty, runningBefore, runningAfter,
              'Sold ' + oi.quantity + 'x ' + oi.item_name + expiryInfo,
              orderNumber, req.session.user.id, bd.batchId
            );
            runningBefore = runningAfter;
          }
        } else {
          db.prepare("INSERT INTO inventory_audit_log (inventory_item_id, action, quantity_change, quantity_before, quantity_after, reason, reference_id, user_id, source) VALUES (?, 'sale_deduction', ?, ?, ?, ?, ?, ?, 'POS')").run(
            recipe.inventory_item_id, -deduction, recipe.current_stock, newQty, 
            'Sold ' + oi.quantity + 'x ' + oi.item_name, orderNumber, req.session.user.id
          );
        }
      }
      
      // Deduct add-on ingredients
      for (const addon of oi.addons) {
        const addonRecipes = db.prepare(`
          SELECT ar.inventory_item_id, ar.quantity_needed, ar.recipe_unit,
                 ii.quantity as current_stock, ii.name as ingredient_name, ii.unit as inventory_unit
          FROM addon_recipes ar
          JOIN inventory_items ii ON ar.inventory_item_id = ii.id
          WHERE ar.addon_id = ?
        `).all(addon.id);
        
        for (const recipe of addonRecipes) {
          const recipeUnit = recipe.recipe_unit || recipe.inventory_unit;
          const neededInRecipeUnit = recipe.quantity_needed * oi.quantity;
          const deduction = convertUnit(neededInRecipeUnit, recipeUnit, recipe.inventory_unit);
          const currentStock = db.prepare('SELECT quantity FROM inventory_items WHERE id = ?').get(recipe.inventory_item_id).quantity;
          const newQty = Math.max(0, currentStock - deduction);
          
          db.prepare("UPDATE inventory_items SET quantity = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(newQty, recipe.inventory_item_id);
          db.prepare("INSERT INTO inventory_audit_log (inventory_item_id, action, quantity_change, quantity_before, quantity_after, reason, reference_id, user_id, source) VALUES (?, 'sale_deduction', ?, ?, ?, ?, ?, ?, 'POS')").run(
            recipe.inventory_item_id, -deduction, currentStock, newQty,
            'Add-on: ' + addon.name + ' for ' + oi.item_name, orderNumber, req.session.user.id
          );
        }
      }
    }
    
    return { 
      orderId, 
      orderNumber, 
      subtotal, 
      discount: discountAmt, 
      discount_type: dType, 
      total, 
      amountPaid: amountPaidVal, 
      change: changeAmount, 
      payment_method: pMethod, 
      items: orderItems, 
      cashier: req.session.user.full_name, 
      date: new Date().toLocaleString() 
    };
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
      // Determine which recipes to use (variant-specific or base)
      let recipes = [];
      if (oi.variant_id) {
        recipes = db.prepare(`
          SELECT vr.inventory_item_id, vr.quantity_needed, vr.recipe_unit, 
                 ii.quantity as current_stock, ii.unit as inventory_unit
          FROM variant_recipes vr 
          JOIN inventory_items ii ON vr.inventory_item_id = ii.id 
          WHERE vr.variant_id = ?
        `).all(oi.variant_id);
      } else {
        recipes = db.prepare(`
          SELECT r.inventory_item_id, r.quantity_needed, r.recipe_unit, 
                 ii.quantity as current_stock, ii.unit as inventory_unit
          FROM recipes r 
          JOIN inventory_items ii ON r.inventory_item_id = ii.id 
          WHERE r.menu_item_id = ?
        `).all(oi.menu_item_id);
      }
      
      for (const recipe of recipes) {
        const recipeUnit = recipe.recipe_unit || recipe.inventory_unit;
        const restore = convertUnit(recipe.quantity_needed * oi.quantity, recipeUnit, recipe.inventory_unit);
        const newQty = recipe.current_stock + restore;
        db.prepare("UPDATE inventory_items SET quantity = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(newQty, recipe.inventory_item_id);
        db.prepare("INSERT INTO inventory_audit_log (inventory_item_id, action, quantity_change, quantity_before, quantity_after, reason, reference_id, user_id) VALUES (?, 'adjustment', ?, ?, ?, ?, ?, ?)").run(
          recipe.inventory_item_id, restore, recipe.current_stock, newQty, 
          'Voided order ' + order.order_number, order.order_number, req.session.user.id
        );
      }
      
      // Also restore add-on ingredients
      const orderItemAddons = db.prepare('SELECT * FROM order_item_addons WHERE order_item_id = ?').all(oi.id);
      for (const addon of orderItemAddons) {
        const addonRecipes = db.prepare(`
          SELECT ar.inventory_item_id, ar.quantity_needed, ar.recipe_unit,
                 ii.quantity as current_stock, ii.unit as inventory_unit
          FROM addon_recipes ar
          JOIN inventory_items ii ON ar.inventory_item_id = ii.id
          WHERE ar.addon_id = ?
        `).all(addon.addon_id);
        
        for (const recipe of addonRecipes) {
          const recipeUnit = recipe.recipe_unit || recipe.inventory_unit;
          const restore = convertUnit(recipe.quantity_needed * oi.quantity, recipeUnit, recipe.inventory_unit);
          const newQty = recipe.current_stock + restore;
          db.prepare("UPDATE inventory_items SET quantity = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(newQty, recipe.inventory_item_id);
          db.prepare("INSERT INTO inventory_audit_log (inventory_item_id, action, quantity_change, quantity_before, quantity_after, reason, reference_id, user_id) VALUES (?, 'adjustment', ?, ?, ?, ?, ?, ?)").run(
            recipe.inventory_item_id, restore, recipe.current_stock, newQty,
            'Voided order ' + order.order_number + ' (addon)', order.order_number, req.session.user.id
          );
        }
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
