const express = require('express');
const session = require('express-session');
const ejsMate = require('ejs-mate');
const path = require('path');
const { initializeDatabase } = require('./database/init');

const app = express();
const PORT = process.env.PORT || 3000;

const db = initializeDatabase();
app.locals.db = db;

app.engine('ejs', ejsMate);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: 'senorito-cafe-secret-key-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000, httpOnly: true }
}));

const { authMiddleware, permissionCheck, getUserPermissions } = require('./middleware/auth');

app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  if (req.session.user) {
    res.locals.userPermissions = getUserPermissions(req.session.user);
  } else {
    res.locals.userPermissions = [];
  }
  next();
});

app.use('/', require('./routes/auth'));
app.use('/dashboard', authMiddleware, permissionCheck('dashboard'), require('./routes/dashboard'));
app.use('/pos', authMiddleware, permissionCheck('pos'), require('./routes/pos'));
app.use('/menu', authMiddleware, permissionCheck('menu'), require('./routes/menu'));
app.use('/inventory', authMiddleware, permissionCheck('inventory'), require('./routes/inventory'));
app.use('/employees', authMiddleware, permissionCheck('employees'), require('./routes/employees'));
app.use('/shifts', authMiddleware, permissionCheck('shifts'), require('./routes/shifts'));
app.use('/analytics', authMiddleware, permissionCheck('analytics'), require('./routes/analytics'));
app.use('/expenses', authMiddleware, permissionCheck('expenses'), require('./routes/expenses'));
app.use('/purchase-orders', authMiddleware, permissionCheck('purchase_orders'), require('./routes/purchaseOrders'));
app.use('/third-party', authMiddleware, permissionCheck('third_party'), require('./routes/thirdParty'));
app.use('/audit-log', authMiddleware, permissionCheck('audit_log'), require('./routes/auditLog'));
app.use('/api/offline', require('./routes/offline'));

app.use((req, res) => {
  res.status(404).render('error', { title: 'Page Not Found', message: 'The page you are looking for does not exist.' });
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).render('error', { title: 'Server Error', message: 'Something went wrong. Please try again.' });
});

app.listen(PORT, () => {
  console.log('\n  Senorito Cafe POS System');
  console.log('  Running on: http://localhost:' + PORT);
  console.log('  Default login: admin / admin123\n');
});

process.on('SIGINT', () => { db.close(); process.exit(0); });
