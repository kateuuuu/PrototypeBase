const express = require('express');
const router = express.Router();
const { roleCheck } = require('../middleware/auth');

// GET all POs with search and filter
router.get('/', (req, res) => {
  const db = req.app.locals.db;
  const { search, status } = req.query;
  
  let sql = `
    SELECT po.*, u.full_name as created_by_name, ru.full_name as received_by_name, cu.full_name as cancelled_by_name,
      (SELECT COUNT(*) FROM purchase_order_items poi WHERE poi.purchase_order_id = po.id) as item_count
    FROM purchase_orders po 
    LEFT JOIN users u ON po.created_by = u.id 
    LEFT JOIN users ru ON po.received_by = ru.id
    LEFT JOIN users cu ON po.cancelled_by = cu.id
    WHERE 1=1
  `;
  const params = [];
  
  if (search) {
    sql += ` AND (po.po_number LIKE ? OR po.supplier_name LIKE ?)`;
    params.push('%' + search + '%', '%' + search + '%');
  }
  if (status && status !== 'all') {
    sql += ` AND po.status = ?`;
    params.push(status);
  }
  sql += ` ORDER BY po.created_at DESC`;
  
  const orders = db.prepare(sql).all(...params);
  const inventoryItems = db.prepare('SELECT * FROM inventory_items WHERE is_active = 1 ORDER BY name').all();
  
  res.render('purchase-orders', { 
    title: 'Purchase Orders', 
    orders, 
    inventoryItems,
    query: req.query,
    userRole: req.session.user.role
  });
});

// GET single PO details
router.get('/:id', (req, res) => {
  const db = req.app.locals.db;
  const po = db.prepare(`
    SELECT po.*, u.full_name as created_by_name, ru.full_name as received_by_name, cu.full_name as cancelled_by_name
    FROM purchase_orders po 
    LEFT JOIN users u ON po.created_by = u.id 
    LEFT JOIN users ru ON po.received_by = ru.id
    LEFT JOIN users cu ON po.cancelled_by = cu.id
    WHERE po.id = ?
  `).get(req.params.id);
  if (!po) return res.status(404).json({ error: 'Not found' });
  const items = db.prepare(`
    SELECT poi.*, ii.name as item_name, ii.unit, ii.track_expiry
    FROM purchase_order_items poi 
    JOIN inventory_items ii ON poi.inventory_item_id = ii.id 
    WHERE poi.purchase_order_id = ?
  `).all(req.params.id);

  // If PO is received, attach batch info per line item
  let batchesByItem = {};
  if (po.status === 'received') {
    const batches = db.prepare(`
      SELECT b.*, ii.name as item_name
      FROM inventory_batches b
      JOIN inventory_items ii ON b.inventory_item_id = ii.id
      WHERE b.reference_id = ? AND b.source = 'PO Received'
      ORDER BY b.expiration_date ASC
    `).all(po.po_number);
    const today = new Date().toISOString().split('T')[0];
    const thresholdRow = db.prepare("SELECT value FROM system_settings WHERE key = 'expiry_threshold_days'").get();
    const threshold = thresholdRow ? parseInt(thresholdRow.value) || 7 : 7;
    const thresholdDate = new Date(Date.now() + threshold * 86400000).toISOString().split('T')[0];
    batches.forEach(b => {
      b.days_left = Math.ceil((new Date(b.expiration_date).getTime() - new Date(today).getTime()) / 86400000);
      b.status = b.is_disposed ? 'Disposed' : b.days_left <= 0 ? 'Expired' : b.expiration_date <= thresholdDate ? 'Expiring Soon' : 'OK';
      if (!batchesByItem[b.inventory_item_id]) batchesByItem[b.inventory_item_id] = [];
      batchesByItem[b.inventory_item_id].push(b);
    });
  }

  res.json({ po, items, batchesByItem });
});

// CREATE new PO
router.post('/', roleCheck('admin', 'inventory_clerk'), (req, res) => {
  const db = req.app.locals.db;
  const { supplier_name, items, notes, expected_date } = req.body;
  
  // Validation
  if (!supplier_name || !supplier_name.trim()) {
    return res.status(400).json({ error: 'Supplier name is required' });
  }
  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'At least one item is required' });
  }
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item.inventory_item_id) {
      return res.status(400).json({ error: `Line ${i + 1}: Item selection is required` });
    }
    if (!item.quantity || parseFloat(item.quantity) <= 0) {
      return res.status(400).json({ error: `Line ${i + 1}: Quantity must be greater than 0` });
    }
    if (!item.unit_cost || parseFloat(item.unit_cost) <= 0) {
      return res.status(400).json({ error: `Line ${i + 1}: Unit cost must be greater than 0` });
    }
  }
  
  const tx = db.transaction(() => {
    const today = new Date().toISOString().split('T')[0].replace(/-/g, '');
    const lastPO = db.prepare("SELECT po_number FROM purchase_orders WHERE po_number LIKE ? ORDER BY id DESC LIMIT 1").get('PO-' + today + '-%');
    let seq = 1;
    if (lastPO) seq = parseInt(lastPO.po_number.split('-')[2]) + 1;
    const poNumber = 'PO-' + today + '-' + String(seq).padStart(3, '0');
    
    let totalCost = 0;
    items.forEach(i => { totalCost += (parseFloat(i.quantity) || 0) * (parseFloat(i.unit_cost) || 0); });
    
    const result = db.prepare(`
      INSERT INTO purchase_orders (po_number, supplier_name, total_cost, notes, expected_date, created_by, status) 
      VALUES (?, ?, ?, ?, ?, ?, 'draft')
    `).run(poNumber, supplier_name.trim(), totalCost, notes || null, expected_date || null, req.session.user.id);
    
    const poId = result.lastInsertRowid;
    const insertItem = db.prepare('INSERT INTO purchase_order_items (purchase_order_id, inventory_item_id, quantity, unit_cost, total_cost) VALUES (?, ?, ?, ?, ?)');
    for (const i of items) {
      const qty = parseFloat(i.quantity);
      const cost = parseFloat(i.unit_cost);
      insertItem.run(poId, i.inventory_item_id, qty, cost, qty * cost);
    }
    return { id: poId, po_number: poNumber };
  });
  
  try { 
    const result = tx(); 
    res.json({ success: true, message: 'Purchase Order ' + result.po_number + ' created successfully', ...result }); 
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

// UPDATE PO status - Mark as Ordered
router.put('/:id/order', roleCheck('admin', 'inventory_clerk'), (req, res) => {
  const db = req.app.locals.db;
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
  if (!po) return res.status(404).json({ error: 'PO not found' });
  if (po.status !== 'draft') return res.status(400).json({ error: 'Only draft POs can be marked as ordered' });
  
  db.prepare("UPDATE purchase_orders SET status = 'ordered', order_date = datetime('now','localtime') WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// RECEIVE PO - Updates inventory and audit log (supports per-line-item qty, expiry dates, split batches)
router.put('/:id/receive', roleCheck('admin', 'inventory_clerk'), (req, res) => {
  const db = req.app.locals.db;
  const { costMethod, lineItems } = req.body;
  // lineItems: [{ poi_id, received_qty, expiration_date?, batches?: [{ qty, expiration_date }] }]
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
  
  if (!po) return res.status(404).json({ error: 'PO not found' });
  if (po.status === 'received') return res.status(400).json({ error: 'PO already received' });
  if (po.status === 'cancelled') return res.status(400).json({ error: 'Cannot receive a cancelled PO' });

  // Fetch PO items with inventory info
  const poItems = db.prepare(`
    SELECT poi.*, ii.quantity as current_stock, ii.name as item_name, ii.cost_per_unit as current_cost, ii.track_expiry, ii.unit as inv_unit
    FROM purchase_order_items poi 
    JOIN inventory_items ii ON poi.inventory_item_id = ii.id 
    WHERE poi.purchase_order_id = ?
  `).all(req.params.id);

  // Build a lookup of submitted line data keyed by poi.id
  const lineMap = {};
  if (lineItems && Array.isArray(lineItems)) {
    for (const li of lineItems) { lineMap[li.poi_id] = li; }
  }

  // --- Validation ---
  for (const item of poItems) {
    const li = lineMap[item.id];
    const receivedQty = li ? parseFloat(li.received_qty) : item.quantity;
    if (!receivedQty || receivedQty <= 0) {
      return res.status(400).json({ error: `${item.item_name}: Received quantity must be > 0` });
    }
    if (item.track_expiry) {
      if (li && li.batches && Array.isArray(li.batches) && li.batches.length > 0) {
        // Split batch mode — validate each sub-row
        let batchSum = 0;
        for (let bi = 0; bi < li.batches.length; bi++) {
          const b = li.batches[bi];
          const bQty = parseFloat(b.qty) || 0;
          if (bQty <= 0) return res.status(400).json({ error: `${item.item_name} Batch ${bi + 1}: Quantity must be > 0` });
          if (!b.expiration_date) return res.status(400).json({ error: `${item.item_name} Batch ${bi + 1}: Expiration date is required` });
          batchSum += bQty;
        }
        const diff = Math.abs(batchSum - receivedQty);
        if (diff > 0.01) {
          return res.status(400).json({ error: `${item.item_name}: Sum of batch quantities (${batchSum}) must equal received quantity (${receivedQty})` });
        }
      } else {
        // Single batch mode — expiration date required
        const expDate = li ? li.expiration_date : null;
        if (!expDate) return res.status(400).json({ error: `${item.item_name}: Expiration date is required for perishable items` });
      }
    }
  }

  const tx = db.transaction(() => {
    // Update PO status
    db.prepare(`
      UPDATE purchase_orders 
      SET status = 'received', received_date = datetime('now','localtime'), received_by = ? 
      WHERE id = ?
    `).run(req.session.user.id, req.params.id);

    let totalBatchesCreated = 0;
    
    for (const item of poItems) {
      const li = lineMap[item.id];
      const receivedQty = li ? parseFloat(li.received_qty) || item.quantity : item.quantity;
      const newQty = item.current_stock + receivedQty;
      
      // Calculate new cost
      let newCost = item.unit_cost;
      if (costMethod === 'weighted' && item.current_stock > 0) {
        const totalOldValue = item.current_stock * item.current_cost;
        const totalNewValue = receivedQty * item.unit_cost;
        newCost = (totalOldValue + totalNewValue) / newQty;
      }
      
      // Update inventory
      db.prepare(`
        UPDATE inventory_items 
        SET quantity = ?, cost_per_unit = ?, updated_at = datetime('now','localtime') 
        WHERE id = ?
      `).run(newQty, newCost, item.inventory_item_id);
      
      // Create batches for expiry-tracked items
      let firstBatchId = null;
      if (item.track_expiry) {
        if (li && li.batches && Array.isArray(li.batches) && li.batches.length > 0) {
          // Split batches
          for (const b of li.batches) {
            const bResult = db.prepare('INSERT INTO inventory_batches (inventory_item_id, quantity, unit, expiration_date, received_by, source, reference_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
              item.inventory_item_id, parseFloat(b.qty), item.inv_unit || 'pcs', b.expiration_date, req.session.user.id, 'PO Received', po.po_number
            );
            if (!firstBatchId) firstBatchId = bResult.lastInsertRowid;
            totalBatchesCreated++;
          }
        } else {
          // Single batch
          const expDate = li ? li.expiration_date : null;
          if (expDate) {
            const bResult = db.prepare('INSERT INTO inventory_batches (inventory_item_id, quantity, unit, expiration_date, received_by, source, reference_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
              item.inventory_item_id, receivedQty, item.inv_unit || 'pcs', expDate, req.session.user.id, 'PO Received', po.po_number
            );
            firstBatchId = bResult.lastInsertRowid;
            totalBatchesCreated++;
          }
        }
      }
      
      // Audit log
      db.prepare(`
        INSERT INTO inventory_audit_log 
        (inventory_item_id, action, quantity_change, quantity_before, quantity_after, reason, reference_id, user_id, source, cost_before, cost_after, cost_method, batch_id) 
        VALUES (?, 'po_received', ?, ?, ?, ?, ?, ?, 'Purchase Orders', ?, ?, ?, ?)
      `).run(
        item.inventory_item_id, receivedQty, item.current_stock, newQty,
        'Received from ' + po.po_number,
        po.po_number, req.session.user.id,
        item.current_cost, newCost,
        costMethod === 'weighted' ? 'Weighted Average' : 'Latest Cost',
        firstBatchId
      );
    }
    
    return { itemsReceived: poItems.length, batchesCreated: totalBatchesCreated };
  });
  
  try { 
    const result = tx(); 
    res.json({ 
      success: true, 
      message: `PO received. ${result.itemsReceived} items added to inventory.${result.batchesCreated ? ' ' + result.batchesCreated + ' batch(es) created.' : ''}`,
      po_number: po.po_number, 
      total: po.total_cost,
      batchesCreated: result.batchesCreated
    }); 
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

// CANCEL PO
router.put('/:id/cancel', roleCheck('admin', 'inventory_clerk'), (req, res) => {
  const db = req.app.locals.db;
  const { reason } = req.body;
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
  
  if (!po) return res.status(404).json({ error: 'PO not found' });
  if (po.status === 'received') return res.status(400).json({ error: 'Cannot cancel a received PO' });
  if (po.status === 'cancelled') return res.status(400).json({ error: 'PO already cancelled' });
  
  const cancelNote = reason ? (po.notes ? po.notes + '\n[CANCELLED: ' + reason + ']' : '[CANCELLED: ' + reason + ']') : po.notes;
  
  db.prepare(`
    UPDATE purchase_orders 
    SET status = 'cancelled', cancelled_date = datetime('now','localtime'), cancelled_by = ?, notes = ?
    WHERE id = ?
  `).run(req.session.user.id, cancelNote, req.params.id);
  
  res.json({ success: true, message: 'PO cancelled' });
});

// CREATE expense from received PO
router.post('/:id/expense', roleCheck('admin'), (req, res) => {
  const db = req.app.locals.db;
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
  
  if (!po) return res.status(404).json({ error: 'PO not found' });
  if (po.status !== 'received') return res.status(400).json({ error: 'Only received POs can create expense entries' });
  
  // Check if expense already exists
  const existing = db.prepare('SELECT id FROM expenses WHERE po_reference = ?').get(po.po_number);
  if (existing) return res.status(400).json({ error: 'Expense already exists for this PO' });
  
  const expenseDate = po.received_date ? po.received_date.split(' ')[0] : new Date().toISOString().split('T')[0];
  
  const result = db.prepare(`
    INSERT INTO expenses (category, description, amount, date, po_reference, user_id) 
    VALUES ('Inventory Purchase', ?, ?, ?, ?, ?)
  `).run(
    po.po_number + ' - ' + po.supplier_name,
    po.total_cost,
    expenseDate,
    po.po_number,
    req.session.user.id
  );
  
  res.json({ success: true, expense_id: result.lastInsertRowid });
});

// Legacy status update endpoint (for backwards compatibility)
router.put('/:id/status', roleCheck('admin', 'inventory_clerk'), (req, res) => {
  const { status } = req.body;
  
  if (status === 'ordered') {
    return res.redirect(307, `/purchase-orders/${req.params.id}/order`);
  } else if (status === 'received') {
    return res.redirect(307, `/purchase-orders/${req.params.id}/receive`);
  } else if (status === 'cancelled') {
    return res.redirect(307, `/purchase-orders/${req.params.id}/cancel`);
  }
  
  res.status(400).json({ error: 'Invalid status' });
});

module.exports = router;
