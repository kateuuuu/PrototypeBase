const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, 'senorito.db');

function initializeDatabase() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    full_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'cashier' CHECK(role IN ('admin','cashier','inventory_clerk')),
    permissions TEXT DEFAULT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS shifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    start_time TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    end_time TEXT,
    starting_cash REAL NOT NULL DEFAULT 0,
    ending_cash REAL,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    description TEXT,
    sort_order INTEGER DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS menu_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    category_id INTEGER,
    price REAL NOT NULL,
    cost REAL NOT NULL DEFAULT 0,
    description TEXT,
    is_available INTEGER NOT NULL DEFAULT 1,
    image_url TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (category_id) REFERENCES categories(id)
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS inventory_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    unit TEXT NOT NULL DEFAULT 'pcs',
    quantity REAL NOT NULL DEFAULT 0,
    cost_per_unit REAL NOT NULL DEFAULT 0,
    reorder_level REAL NOT NULL DEFAULT 10,
    category TEXT DEFAULT 'Ingredient',
    supplier TEXT,
    qr_code TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS recipes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    menu_item_id INTEGER NOT NULL,
    inventory_item_id INTEGER NOT NULL,
    quantity_needed REAL NOT NULL,
    recipe_unit TEXT DEFAULT NULL,
    FOREIGN KEY (menu_item_id) REFERENCES menu_items(id) ON DELETE CASCADE,
    FOREIGN KEY (inventory_item_id) REFERENCES inventory_items(id)
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_number TEXT UNIQUE NOT NULL,
    user_id INTEGER NOT NULL,
    shift_id INTEGER,
    subtotal REAL NOT NULL DEFAULT 0,
    discount REAL NOT NULL DEFAULT 0,
    discount_type TEXT DEFAULT 'none',
    tax REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL DEFAULT 0,
    payment_method TEXT NOT NULL DEFAULT 'cash' CHECK(payment_method IN ('cash','gcash','card','platform','other')),
    amount_paid REAL NOT NULL DEFAULT 0,
    change_amount REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'completed' CHECK(status IN ('pending','completed','voided','refunded')),
    source TEXT NOT NULL DEFAULT 'in-store' CHECK(source IN ('in-store','grab','foodpanda','other')),
    notes TEXT,
    is_synced INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    menu_item_id INTEGER NOT NULL,
    item_name TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    unit_price REAL NOT NULL,
    total_price REAL NOT NULL,
    notes TEXT,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
    FOREIGN KEY (menu_item_id) REFERENCES menu_items(id)
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS inventory_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inventory_item_id INTEGER NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('sale_deduction','restock','adjustment','wastage','initial','import','po_received','po_cancelled','platform_sale')),
    quantity_change REAL NOT NULL,
    quantity_before REAL NOT NULL,
    quantity_after REAL NOT NULL,
    reason TEXT,
    reference_id TEXT,
    source TEXT DEFAULT 'Inventory' CHECK(source IN ('POS','Inventory','Purchase Orders','Import','System')),
    cost_before REAL,
    cost_after REAL,
    cost_method TEXT,
    user_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (inventory_item_id) REFERENCES inventory_items(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS purchase_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    po_number TEXT UNIQUE NOT NULL,
    supplier_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','ordered','received','cancelled')),
    total_cost REAL NOT NULL DEFAULT 0,
    notes TEXT,
    created_by INTEGER,
    order_date TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    expected_date TEXT,
    received_date TEXT,
    received_by INTEGER,
    cancelled_date TEXT,
    cancelled_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (created_by) REFERENCES users(id),
    FOREIGN KEY (received_by) REFERENCES users(id),
    FOREIGN KEY (cancelled_by) REFERENCES users(id)
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS purchase_order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    purchase_order_id INTEGER NOT NULL,
    inventory_item_id INTEGER NOT NULL,
    quantity REAL NOT NULL,
    unit_cost REAL NOT NULL,
    total_cost REAL NOT NULL,
    FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders(id) ON DELETE CASCADE,
    FOREIGN KEY (inventory_item_id) REFERENCES inventory_items(id)
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL DEFAULT 'Other',
    description TEXT NOT NULL,
    amount REAL NOT NULL,
    date TEXT NOT NULL DEFAULT (date('now','localtime')),
    receipt_ref TEXT,
    user_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS third_party_sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL CHECK(platform IN ('grab','foodpanda','other')),
    reference_number TEXT,
    items_description TEXT,
    total_amount REAL NOT NULL,
    commission REAL DEFAULT 0,
    net_amount REAL NOT NULL,
    date TEXT NOT NULL DEFAULT (date('now','localtime')),
    notes TEXT,
    user_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS offline_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','synced','failed')),
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    synced_at TEXT
  )`);

  // Migrations for existing databases
  try { db.exec("ALTER TABLE users ADD COLUMN permissions TEXT DEFAULT NULL"); } catch(e) {}
  try { db.exec("ALTER TABLE users ADD COLUMN contact_number TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE recipes ADD COLUMN recipe_unit TEXT DEFAULT NULL"); } catch(e) {}
  try { db.exec("ALTER TABLE orders ADD COLUMN discount_type TEXT DEFAULT 'none'"); } catch(e) {}
  try { db.exec("ALTER TABLE purchase_orders ADD COLUMN received_by INTEGER"); } catch(e) {}
  try { db.exec("ALTER TABLE purchase_orders ADD COLUMN cancelled_date TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE purchase_orders ADD COLUMN cancelled_by INTEGER"); } catch(e) {}
  try { db.exec("ALTER TABLE expenses ADD COLUMN po_reference TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE shifts ADD COLUMN expected_cash REAL"); } catch(e) {}
  try { db.exec("ALTER TABLE shifts ADD COLUMN cash_difference REAL"); } catch(e) {}
  // Migrate 'pending' to 'draft' and 'completed' to 'received'
  try { db.exec("UPDATE purchase_orders SET status = 'draft' WHERE status = 'pending'"); } catch(e) {}
  try { db.exec("UPDATE purchase_orders SET status = 'received' WHERE status = 'completed'"); } catch(e) {}
  // Add audit log columns for source and cost tracking
  try { db.exec("ALTER TABLE inventory_audit_log ADD COLUMN source TEXT DEFAULT 'Inventory'"); } catch(e) {}
  try { db.exec("ALTER TABLE inventory_audit_log ADD COLUMN cost_before REAL"); } catch(e) {}
  try { db.exec("ALTER TABLE inventory_audit_log ADD COLUMN cost_after REAL"); } catch(e) {}
  try { db.exec("ALTER TABLE inventory_audit_log ADD COLUMN cost_method TEXT"); } catch(e) {}

  // Inventory categories table
  db.exec(`CREATE TABLE IF NOT EXISTS inventory_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`);

  // Seed inventory categories
  const invCatCount = db.prepare('SELECT COUNT(*) as cnt FROM inventory_categories').get();
  if (invCatCount.cnt === 0) {
    const invCats = ['Ingredient', 'Packaging', 'Supplies', 'Equipment', 'Beverage Base', 'Raw Materials'];
    const insertInvCat = db.prepare('INSERT INTO inventory_categories (name) VALUES (?)');
    invCats.forEach(c => insertInvCat.run(c));
  }

  // Expense categories table
  db.exec(`CREATE TABLE IF NOT EXISTS expense_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`);

  // Seed expense categories
  const expCatCount = db.prepare('SELECT COUNT(*) as cnt FROM expense_categories').get();
  if (expCatCount.cnt === 0) {
    const expCats = ['Inventory Purchase', 'Utilities', 'Rent', 'Wages', 'Platform Fees', 'Marketing', 'Maintenance', 'Packaging', 'Misc'];
    const insertExpCat = db.prepare('INSERT INTO expense_categories (name) VALUES (?)');
    expCats.forEach(c => insertExpCat.run(c));
  }

  // Expense table migrations
  try { db.exec("ALTER TABLE expenses ADD COLUMN vendor_supplier TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE expenses ADD COLUMN payment_method TEXT DEFAULT 'Cash'"); } catch(e) {}
  try { db.exec("ALTER TABLE expenses ADD COLUMN receipt_file TEXT"); } catch(e) {}

  // Seed admin
  const adminExists = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
  if (!adminExists) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare('INSERT INTO users (username, password, full_name, role) VALUES (?, ?, ?, ?)').run('admin', hash, 'System Administrator', 'admin');
  }

  // Seed categories
  const catCount = db.prepare('SELECT COUNT(*) as cnt FROM categories').get();
  if (catCount.cnt === 0) {
    const cats = ['Hot Coffee', 'Iced Coffee', 'Non-Coffee', 'Frappe', 'Food', 'Add-Ons', 'Others'];
    const insertCat = db.prepare('INSERT INTO categories (name, sort_order) VALUES (?, ?)');
    cats.forEach((c, i) => insertCat.run(c, i));
  }

  return db;
}

module.exports = { initializeDatabase, DB_PATH };
