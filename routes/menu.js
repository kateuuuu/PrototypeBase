const express = require('express');
const router = express.Router();
const { roleCheck } = require('../middleware/auth');

router.get('/', (req, res) => {
  const db = req.app.locals.db;
  const categories = db.prepare('SELECT * FROM categories ORDER BY sort_order').all();
  const menuItems = db.prepare(`
    SELECT mi.*, c.name as category_name,
      (SELECT COUNT(*) FROM recipes r WHERE r.menu_item_id = mi.id) as recipe_count
    FROM menu_items mi LEFT JOIN categories c ON mi.category_id = c.id ORDER BY c.sort_order, mi.name
  `).all();
  const inventoryItems = db.prepare('SELECT * FROM inventory_items WHERE is_active = 1 ORDER BY name').all();
  res.render('menu', { title: 'Menu Management', categories, menuItems, inventoryItems });
});

router.post('/categories', roleCheck('admin'), (req, res) => {
  const db = req.app.locals.db;
  const { name, sort_order } = req.body;
  try {
    const result = db.prepare('INSERT INTO categories (name, sort_order) VALUES (?, ?)').run(name, parseInt(sort_order) || 0);
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/categories/:id', roleCheck('admin'), (req, res) => {
  const db = req.app.locals.db;
  const { name, sort_order, is_active } = req.body;
  try {
    db.prepare('UPDATE categories SET name=?, sort_order=?, is_active=? WHERE id=?').run(name, parseInt(sort_order) || 0, is_active ? 1 : 0, req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/items', roleCheck('admin'), (req, res) => {
  const db = req.app.locals.db;
  const { name, category_id, price, description, recipes } = req.body;
  const tx = db.transaction(() => {
    const result = db.prepare('INSERT INTO menu_items (name, category_id, price, description) VALUES (?, ?, ?, ?)').run(name, category_id || null, parseFloat(price) || 0, description || null);
    const itemId = result.lastInsertRowid;
    if (recipes && Array.isArray(recipes)) {
      const insertRecipe = db.prepare('INSERT INTO recipes (menu_item_id, inventory_item_id, quantity_needed, recipe_unit) VALUES (?, ?, ?, ?)');
      for (const r of recipes) {
        insertRecipe.run(itemId, r.inventory_item_id, parseFloat(r.quantity_needed) || 0, r.recipe_unit || null);
      }
    }
    return itemId;
  });
  try { const id = tx(); res.json({ success: true, id }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/items/:id', roleCheck('admin'), (req, res) => {
  const db = req.app.locals.db;
  const { name, category_id, price, description, is_available, recipes } = req.body;
  const tx = db.transaction(() => {
    db.prepare("UPDATE menu_items SET name=?, category_id=?, price=?, description=?, is_available=?, updated_at=datetime('now','localtime') WHERE id=?").run(name, category_id || null, parseFloat(price) || 0, description || null, is_available ? 1 : 0, req.params.id);
    if (recipes && Array.isArray(recipes)) {
      db.prepare('DELETE FROM recipes WHERE menu_item_id = ?').run(req.params.id);
      const insertRecipe = db.prepare('INSERT INTO recipes (menu_item_id, inventory_item_id, quantity_needed, recipe_unit) VALUES (?, ?, ?, ?)');
      for (const r of recipes) {
        insertRecipe.run(req.params.id, r.inventory_item_id, parseFloat(r.quantity_needed) || 0, r.recipe_unit || null);
      }
    }
  });
  try { tx(); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/items/:id', roleCheck('admin'), (req, res) => {
  const db = req.app.locals.db;
  try { db.prepare('UPDATE menu_items SET is_available = 0 WHERE id = ?').run(req.params.id); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/items/:id/recipe', (req, res) => {
  const db = req.app.locals.db;
  const recipes = db.prepare(`
    SELECT r.*, ii.name as item_name, ii.unit as inventory_unit, ii.quantity as current_stock
    FROM recipes r JOIN inventory_items ii ON r.inventory_item_id = ii.id WHERE r.menu_item_id = ?
  `).all(req.params.id);
  res.json(recipes);
});

module.exports = router;
