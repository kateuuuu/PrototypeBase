const express = require('express');
const router = express.Router();
const { roleCheck } = require('../middleware/auth');

router.get('/', (req, res) => {
  const db = req.app.locals.db;
  const categories = db.prepare('SELECT * FROM categories ORDER BY sort_order').all();
  const menuItems = db.prepare(`
    SELECT mi.*, c.name as category_name,
      (SELECT COUNT(*) FROM recipes r WHERE r.menu_item_id = mi.id) as recipe_count,
      (SELECT COUNT(*) FROM menu_item_variants v WHERE v.menu_item_id = mi.id) as variant_count
    FROM menu_items mi LEFT JOIN categories c ON mi.category_id = c.id ORDER BY c.sort_order, mi.name
  `).all();
  
  // Load variants for each menu item
  const getVariants = db.prepare('SELECT * FROM menu_item_variants WHERE menu_item_id = ? ORDER BY sort_order, id');
  for (const item of menuItems) {
    item.variants = getVariants.all(item.id);
    // Calculate price range for items with variants
    if (item.variants.length > 0) {
      const prices = item.variants.filter(v => v.is_available).map(v => v.price);
      item.min_price = prices.length > 0 ? Math.min(...prices) : item.price;
      item.max_price = prices.length > 0 ? Math.max(...prices) : item.price;
    }
  }
  
  const inventoryItems = db.prepare('SELECT * FROM inventory_items WHERE is_active = 1 ORDER BY name').all();
  const addons = db.prepare('SELECT a.*, c.name as category_name FROM menu_item_addons a LEFT JOIN categories c ON a.category_id = c.id WHERE a.is_active = 1 ORDER BY a.name').all();
  
  res.render('menu', { title: 'Menu Management', categories, menuItems, inventoryItems, addons });
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
  const { name, category_id, price, description, recipes, variants } = req.body;
  const hasVariants = variants && Array.isArray(variants) && variants.length > 0;
  
  const tx = db.transaction(() => {
    const result = db.prepare('INSERT INTO menu_items (name, category_id, price, description, has_variants) VALUES (?, ?, ?, ?, ?)').run(
      name, category_id || null, parseFloat(price) || 0, description || null, hasVariants ? 1 : 0
    );
    const itemId = result.lastInsertRowid;
    
    // Insert base recipes (for items without variants)
    if (!hasVariants && recipes && Array.isArray(recipes)) {
      const insertRecipe = db.prepare('INSERT INTO recipes (menu_item_id, inventory_item_id, quantity_needed, recipe_unit) VALUES (?, ?, ?, ?)');
      for (const r of recipes) {
        insertRecipe.run(itemId, r.inventory_item_id, parseFloat(r.quantity_needed) || 0, r.recipe_unit || null);
      }
    }
    
    // Insert variants with their recipes
    if (hasVariants) {
      const insertVariant = db.prepare('INSERT INTO menu_item_variants (menu_item_id, name, price, is_available, sort_order) VALUES (?, ?, ?, ?, ?)');
      const insertVariantRecipe = db.prepare('INSERT INTO variant_recipes (variant_id, inventory_item_id, quantity_needed, recipe_unit) VALUES (?, ?, ?, ?)');
      
      variants.forEach((v, idx) => {
        const vResult = insertVariant.run(itemId, v.name, parseFloat(v.price) || 0, v.is_available !== false ? 1 : 0, idx);
        const variantId = vResult.lastInsertRowid;
        
        if (v.recipes && Array.isArray(v.recipes)) {
          for (const r of v.recipes) {
            insertVariantRecipe.run(variantId, r.inventory_item_id, parseFloat(r.quantity_needed) || 0, r.recipe_unit || null);
          }
        }
      });
    }
    
    return itemId;
  });
  
  try { const id = tx(); res.json({ success: true, id }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/items/:id', roleCheck('admin'), (req, res) => {
  const db = req.app.locals.db;
  const { name, category_id, price, description, is_available, recipes, variants } = req.body;
  const hasVariants = variants && Array.isArray(variants) && variants.length > 0;
  
  const tx = db.transaction(() => {
    db.prepare("UPDATE menu_items SET name=?, category_id=?, price=?, description=?, is_available=?, has_variants=?, updated_at=datetime('now','localtime') WHERE id=?").run(
      name, category_id || null, parseFloat(price) || 0, description || null, is_available ? 1 : 0, hasVariants ? 1 : 0, req.params.id
    );
    
    // Update base recipes (for items without variants)
    if (!hasVariants && recipes && Array.isArray(recipes)) {
      db.prepare('DELETE FROM recipes WHERE menu_item_id = ?').run(req.params.id);
      const insertRecipe = db.prepare('INSERT INTO recipes (menu_item_id, inventory_item_id, quantity_needed, recipe_unit) VALUES (?, ?, ?, ?)');
      for (const r of recipes) {
        insertRecipe.run(req.params.id, r.inventory_item_id, parseFloat(r.quantity_needed) || 0, r.recipe_unit || null);
      }
    }
    
    // Update variants
    if (hasVariants) {
      // Get existing variant IDs to delete their recipes
      const existingVariants = db.prepare('SELECT id FROM menu_item_variants WHERE menu_item_id = ?').all(req.params.id);
      for (const ev of existingVariants) {
        db.prepare('DELETE FROM variant_recipes WHERE variant_id = ?').run(ev.id);
      }
      db.prepare('DELETE FROM menu_item_variants WHERE menu_item_id = ?').run(req.params.id);
      db.prepare('DELETE FROM recipes WHERE menu_item_id = ?').run(req.params.id); // Clear base recipes too
      
      const insertVariant = db.prepare('INSERT INTO menu_item_variants (menu_item_id, name, price, is_available, sort_order) VALUES (?, ?, ?, ?, ?)');
      const insertVariantRecipe = db.prepare('INSERT INTO variant_recipes (variant_id, inventory_item_id, quantity_needed, recipe_unit) VALUES (?, ?, ?, ?)');
      
      variants.forEach((v, idx) => {
        const vResult = insertVariant.run(req.params.id, v.name, parseFloat(v.price) || 0, v.is_available !== false ? 1 : 0, idx);
        const variantId = vResult.lastInsertRowid;
        
        if (v.recipes && Array.isArray(v.recipes)) {
          for (const r of v.recipes) {
            insertVariantRecipe.run(variantId, r.inventory_item_id, parseFloat(r.quantity_needed) || 0, r.recipe_unit || null);
          }
        }
      });
    } else {
      // If switching from variants to no-variants, clear variants
      const existingVariants = db.prepare('SELECT id FROM menu_item_variants WHERE menu_item_id = ?').all(req.params.id);
      for (const ev of existingVariants) {
        db.prepare('DELETE FROM variant_recipes WHERE variant_id = ?').run(ev.id);
      }
      db.prepare('DELETE FROM menu_item_variants WHERE menu_item_id = ?').run(req.params.id);
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

// Get menu item with variants and recipes
router.get('/items/:id', (req, res) => {
  const db = req.app.locals.db;
  const item = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  
  // Get base recipes (for non-variant items)
  item.recipes = db.prepare(`
    SELECT r.*, ii.name as item_name, ii.unit as inventory_unit, ii.quantity as current_stock
    FROM recipes r JOIN inventory_items ii ON r.inventory_item_id = ii.id WHERE r.menu_item_id = ?
  `).all(req.params.id);
  
  // Get variants with their recipes
  const variants = db.prepare('SELECT * FROM menu_item_variants WHERE menu_item_id = ? ORDER BY sort_order, id').all(req.params.id);
  const getVariantRecipes = db.prepare(`
    SELECT vr.*, ii.name as item_name, ii.unit as inventory_unit, ii.quantity as current_stock
    FROM variant_recipes vr JOIN inventory_items ii ON vr.inventory_item_id = ii.id WHERE vr.variant_id = ?
  `);
  for (const v of variants) {
    v.recipes = getVariantRecipes.all(v.id);
  }
  item.variants = variants;
  
  res.json(item);
});

router.get('/items/:id/recipe', (req, res) => {
  const db = req.app.locals.db;
  const recipes = db.prepare(`
    SELECT r.*, ii.name as item_name, ii.unit as inventory_unit, ii.quantity as current_stock
    FROM recipes r JOIN inventory_items ii ON r.inventory_item_id = ii.id WHERE r.menu_item_id = ?
  `).all(req.params.id);
  res.json(recipes);
});

// Get variants for a menu item
router.get('/items/:id/variants', (req, res) => {
  const db = req.app.locals.db;
  const variants = db.prepare('SELECT * FROM menu_item_variants WHERE menu_item_id = ? ORDER BY sort_order, id').all(req.params.id);
  const getVariantRecipes = db.prepare(`
    SELECT vr.*, ii.name as item_name, ii.unit as inventory_unit
    FROM variant_recipes vr JOIN inventory_items ii ON vr.inventory_item_id = ii.id WHERE vr.variant_id = ?
  `);
  for (const v of variants) {
    v.recipes = getVariantRecipes.all(v.id);
  }
  res.json(variants);
});

// Get recipe for a specific variant
router.get('/variants/:id/recipe', (req, res) => {
  const db = req.app.locals.db;
  const recipes = db.prepare(`
    SELECT vr.*, ii.name as item_name, ii.unit as inventory_unit, ii.quantity as current_stock
    FROM variant_recipes vr JOIN inventory_items ii ON vr.inventory_item_id = ii.id WHERE vr.variant_id = ?
  `).all(req.params.id);
  res.json(recipes);
});

// ========== ADD-ONS ROUTES ==========
router.get('/addons', (req, res) => {
  const db = req.app.locals.db;
  const addons = db.prepare(`
    SELECT a.*, c.name as category_name,
      (SELECT COUNT(*) FROM addon_recipes ar WHERE ar.addon_id = a.id) as recipe_count
    FROM menu_item_addons a LEFT JOIN categories c ON a.category_id = c.id
    ORDER BY a.name
  `).all();
  res.json(addons);
});

router.post('/addons', roleCheck('admin'), (req, res) => {
  const db = req.app.locals.db;
  const { name, price, category_id, recipes } = req.body;
  
  const tx = db.transaction(() => {
    const result = db.prepare('INSERT INTO menu_item_addons (name, price, category_id) VALUES (?, ?, ?)').run(
      name, parseFloat(price) || 0, category_id || null
    );
    const addonId = result.lastInsertRowid;
    
    if (recipes && Array.isArray(recipes)) {
      const insertRecipe = db.prepare('INSERT INTO addon_recipes (addon_id, inventory_item_id, quantity_needed, recipe_unit) VALUES (?, ?, ?, ?)');
      for (const r of recipes) {
        insertRecipe.run(addonId, r.inventory_item_id, parseFloat(r.quantity_needed) || 0, r.recipe_unit || null);
      }
    }
    return addonId;
  });
  
  try { const id = tx(); res.json({ success: true, id }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/addons/:id', roleCheck('admin'), (req, res) => {
  const db = req.app.locals.db;
  const { name, price, category_id, is_active, recipes } = req.body;
  
  const tx = db.transaction(() => {
    db.prepare('UPDATE menu_item_addons SET name=?, price=?, category_id=?, is_active=? WHERE id=?').run(
      name, parseFloat(price) || 0, category_id || null, is_active !== false ? 1 : 0, req.params.id
    );
    
    if (recipes && Array.isArray(recipes)) {
      db.prepare('DELETE FROM addon_recipes WHERE addon_id = ?').run(req.params.id);
      const insertRecipe = db.prepare('INSERT INTO addon_recipes (addon_id, inventory_item_id, quantity_needed, recipe_unit) VALUES (?, ?, ?, ?)');
      for (const r of recipes) {
        insertRecipe.run(req.params.id, r.inventory_item_id, parseFloat(r.quantity_needed) || 0, r.recipe_unit || null);
      }
    }
  });
  
  try { tx(); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/addons/:id', roleCheck('admin'), (req, res) => {
  const db = req.app.locals.db;
  try {
    db.prepare('UPDATE menu_item_addons SET is_active = 0 WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/addons/:id/recipe', (req, res) => {
  const db = req.app.locals.db;
  const recipes = db.prepare(`
    SELECT ar.*, ii.name as item_name, ii.unit as inventory_unit, ii.quantity as current_stock
    FROM addon_recipes ar JOIN inventory_items ii ON ar.inventory_item_id = ii.id WHERE ar.addon_id = ?
  `).all(req.params.id);
  res.json(recipes);
});

module.exports = router;
