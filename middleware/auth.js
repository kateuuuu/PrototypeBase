// Default permissions by role
const DEFAULT_PERMISSIONS = {
  admin: ['dashboard','pos','order_history','inventory','inventory_valuation','purchase_orders','audit_log','analytics','expenses','third_party','menu','employees','shifts'],
  cashier: ['dashboard','pos','order_history','shifts'],
  inventory_clerk: ['dashboard','inventory','inventory_valuation','purchase_orders','audit_log','shifts']
};

// Map URL prefixes to permission keys
const ROUTE_PERMISSION_MAP = {
  '/dashboard': 'dashboard',
  '/pos': 'pos',
  '/inventory': 'inventory',
  '/menu': 'menu',
  '/employees': 'employees',
  '/shifts': 'shifts',
  '/analytics': 'analytics',
  '/expenses': 'expenses',
  '/purchase-orders': 'purchase_orders',
  '/third-party': 'third_party',
  '/audit-log': 'audit_log'
};

function getUserPermissions(user) {
  if (user.permissions) {
    try { return JSON.parse(user.permissions); } catch(e) {}
  }
  return DEFAULT_PERMISSIONS[user.role] || [];
}

function authMiddleware(req, res, next) {
  if (req.session && req.session.user) {
    res.locals.currentUser = req.session.user;
    res.locals.userPermissions = getUserPermissions(req.session.user);
    return next();
  }
  if (req.xhr || req.headers.accept?.includes('application/json')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.redirect('/login');
}

function roleCheck(...roles) {
  return (req, res, next) => {
    if (!req.session || !req.session.user) return res.redirect('/login');
    if (roles.includes(req.session.user.role)) return next();
    // Also check custom permissions
    const perms = getUserPermissions(req.session.user);
    const routeKey = Object.entries(ROUTE_PERMISSION_MAP).find(([prefix]) => req.baseUrl.startsWith(prefix));
    if (routeKey && perms.includes(routeKey[1])) return next();
    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.status(403).json({ error: 'Forbidden: Insufficient permissions' });
    }
    res.status(403).render('error', { title: 'Access Denied', message: 'You do not have permission to access this page.' });
  };
}

function permissionCheck(permKey) {
  return (req, res, next) => {
    if (!req.session || !req.session.user) return res.redirect('/login');
    if (req.session.user.role === 'admin') return next();
    const perms = getUserPermissions(req.session.user);
    if (perms.includes(permKey)) return next();
    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.status(403).json({ error: 'Forbidden: Insufficient permissions' });
    }
    res.status(403).render('error', { title: 'Access Denied', message: 'You do not have permission to access this page.' });
  };
}

module.exports = { authMiddleware, roleCheck, permissionCheck, getUserPermissions, DEFAULT_PERMISSIONS, ROUTE_PERMISSION_MAP };
