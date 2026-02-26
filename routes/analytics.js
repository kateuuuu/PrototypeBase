const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  const db = req.app.locals.db;
  const { period, from, to, source, category, includeMissingCost } = req.query;
  
  // Build date filter
  let dateFilter = '';
  const params = [];
  if (from && to) { dateFilter = "AND date(o.created_at) BETWEEN ? AND ?"; params.push(from, to); }
  else if (period === 'today') { dateFilter = "AND date(o.created_at) = date('now','localtime')"; }
  else if (period === 'week') { dateFilter = "AND o.created_at >= datetime('now','localtime','-7 days')"; }
  else if (period === 'month') { dateFilter = "AND o.created_at >= datetime('now','localtime','-30 days')"; }

  // Source filter
  let sourceFilter = '';
  if (source && source !== 'all') {
    sourceFilter = " AND o.source = ?";
    params.push(source);
  }

  // Determine if we should show hourly (for today/short range) or daily
  const isShortRange = period === 'today' || (from && to && from === to);

  // Summary with source filter
  const summaryParams = [...params];
  const summary = db.prepare(`SELECT COUNT(*) as total_orders,
    COALESCE(SUM(total), 0) as total_revenue,
    COALESCE(AVG(total), 0) as avg_order_value,
    COALESCE(SUM(CASE WHEN payment_method = 'cash' THEN total ELSE 0 END), 0) as cash_sales,
    COALESCE(SUM(CASE WHEN payment_method = 'gcash' THEN total ELSE 0 END), 0) as gcash_sales,
    COALESCE(SUM(CASE WHEN payment_method = 'card' THEN total ELSE 0 END), 0) as card_sales,
    COALESCE(SUM(CASE WHEN payment_method = 'platform' THEN total ELSE 0 END), 0) as platform_sales,
    COALESCE(SUM(CASE WHEN source = 'in-store' THEN total ELSE 0 END), 0) as instore_sales,
    COALESCE(SUM(CASE WHEN source = 'grab' THEN total ELSE 0 END), 0) as grab_sales,
    COALESCE(SUM(CASE WHEN source = 'foodpanda' THEN total ELSE 0 END), 0) as foodpanda_sales
   FROM orders o WHERE status = 'completed' ` + dateFilter + sourceFilter).get(...summaryParams);

  // Daily or hourly sales for chart
  let salesTrend = [];
  if (isShortRange) {
    // Hourly for today/single day
    salesTrend = db.prepare(`SELECT strftime('%H:00', created_at) as label, COUNT(*) as orders, SUM(total) as revenue
     FROM orders o WHERE status = 'completed' ` + dateFilter + sourceFilter + ` GROUP BY strftime('%H', created_at) ORDER BY label`).all(...params);
  } else {
    // Daily for ranges
    salesTrend = db.prepare(`SELECT date(created_at) as label, COUNT(*) as orders, SUM(total) as revenue
     FROM orders o WHERE status = 'completed' ` + dateFilter + sourceFilter + ` GROUP BY date(created_at) ORDER BY label`).all(...params);
  }

  // Get all categories for filter dropdown
  const categories = db.prepare('SELECT id, name FROM categories ORDER BY name').all();

  // Category filter for menu items
  let categoryFilter = '';
  const categoryParams = [];
  if (category && category !== 'all') {
    categoryFilter = " AND mi.category_id = ?";
    categoryParams.push(parseInt(category));
  }

  // Calculate recipe costs with missing cost tracking
  const recipeCosts = {};
  const itemsWithRecipe = new Set();
  const recipes = db.prepare(`
    SELECT r.menu_item_id, r.quantity_needed, r.recipe_unit, ii.cost_per_unit, ii.unit as inventory_unit
    FROM recipes r JOIN inventory_items ii ON r.inventory_item_id = ii.id
  `).all();
  
  const { convertUnit } = require('./unitConvert');
  for (const r of recipes) {
    itemsWithRecipe.add(r.menu_item_id);
    if (!recipeCosts[r.menu_item_id]) recipeCosts[r.menu_item_id] = 0;
    const qtyInInvUnit = convertUnit(r.quantity_needed, r.recipe_unit || r.inventory_unit, r.inventory_unit);
    recipeCosts[r.menu_item_id] += qtyInInvUnit * r.cost_per_unit;
  }

  // Heatmap data with all filters
  const heatmapQuery = `
    SELECT mi.id, mi.name, mi.price, mi.category_id, c.name as category_name,
      COALESCE(SUM(CASE WHEN o.id IS NOT NULL THEN oi.quantity ELSE 0 END), 0) as volume,
      COALESCE(SUM(CASE WHEN o.id IS NOT NULL THEN oi.total_price ELSE 0 END), 0) as revenue
    FROM menu_items mi
    LEFT JOIN categories c ON mi.category_id = c.id
    LEFT JOIN order_items oi ON oi.menu_item_id = mi.id
    LEFT JOIN orders o ON oi.order_id = o.id AND o.status = 'completed' ${dateFilter.replace(/o\./g, 'o.')}${sourceFilter}
    WHERE mi.is_available = 1 ${categoryFilter}
    GROUP BY mi.id
  `;
  const heatmapParams = [...params, ...categoryParams];
  const heatmapData = db.prepare(heatmapQuery).all(...heatmapParams);

  // Build heatmap with cost status
  const heatmap = [];
  let missingCostCount = 0;
  const missingCostItems = [];

  for (const item of heatmapData) {
    const hasRecipe = itemsWithRecipe.has(item.id);
    const cost = recipeCosts[item.id] || 0;
    const costStatus = hasRecipe ? (cost > 0 ? 'set' : 'zero') : 'missing';
    
    if (costStatus === 'missing') {
      missingCostCount++;
      missingCostItems.push(item.name);
    }
    
    // Skip missing cost items unless toggle is on
    if (costStatus === 'missing' && includeMissingCost !== 'on') {
      continue;
    }
    
    const profitPerItem = item.price - cost;
    heatmap.push({
      id: item.id, 
      name: item.name, 
      price: item.price, 
      category: item.category_name || 'Uncategorized',
      volume: item.volume, 
      revenue: item.revenue, 
      estimated_cost: Math.round(cost * 100) / 100,
      profit_per_item: Math.round(profitPerItem * 100) / 100,
      margin: item.price > 0 ? Math.round((profitPerItem / item.price) * 10000) / 100 : 0,
      cost_status: costStatus
    });
  }

  // Determine medians for quadrant thresholds (only from items with valid data)
  const validItems = heatmap.filter(h => h.cost_status !== 'missing');
  const profits = validItems.map(h => h.profit_per_item).sort((a, b) => a - b);
  const volumes = validItems.map(h => h.volume).sort((a, b) => a - b);
  const medianProfit = profits.length > 0 ? profits[Math.floor(profits.length / 2)] : 0;
  const medianVolume = volumes.length > 0 ? volumes[Math.floor(volumes.length / 2)] : 0;

  // Classify quadrants with new labels
  const quadrantLabels = {
    topPerformers: 'Top Performers',
    promoteMore: 'Promote More',
    improvePricing: 'Improve Pricing',
    reviewRemove: 'Review or Remove'
  };
  
  for (const item of heatmap) {
    if (item.cost_status === 'missing') {
      item.quadrant = 'Cost Not Set';
      item.quadrantKey = 'missing';
    } else {
      const hp = item.profit_per_item >= medianProfit;
      const hv = item.volume >= medianVolume;
      if (hp && hv) { item.quadrant = quadrantLabels.topPerformers; item.quadrantKey = 'topPerformers'; }
      else if (hp && !hv) { item.quadrant = quadrantLabels.promoteMore; item.quadrantKey = 'promoteMore'; }
      else if (!hp && hv) { item.quadrant = quadrantLabels.improvePricing; item.quadrantKey = 'improvePricing'; }
      else { item.quadrant = quadrantLabels.reviewRemove; item.quadrantKey = 'reviewRemove'; }
    }
  }

  // Top items with profit calculation
  const topItemsQuery = `
    SELECT oi.menu_item_id, oi.item_name, SUM(oi.quantity) as total_qty, SUM(oi.total_price) as total_revenue, oi.unit_price
    FROM order_items oi JOIN orders o ON oi.order_id = o.id
    WHERE o.status = 'completed' ${dateFilter}${sourceFilter}
    GROUP BY oi.menu_item_id ORDER BY total_revenue DESC LIMIT 10
  `;
  const topItemsRaw = db.prepare(topItemsQuery).all(...params);
  
  const topItems = topItemsRaw.map(item => {
    const cost = recipeCosts[item.menu_item_id] || 0;
    const totalCost = cost * item.total_qty;
    const profit = item.total_revenue - totalCost;
    return {
      ...item,
      estimated_cost: cost,
      total_cost: Math.round(totalCost * 100) / 100,
      profit: Math.round(profit * 100) / 100,
      has_cost: itemsWithRecipe.has(item.menu_item_id)
    };
  });

  // Category breakdown with cost data
  const categoryBreakdown = db.prepare(`
    SELECT c.id, c.name, COUNT(DISTINCT o.id) as orders, 
           SUM(oi.quantity) as units_sold,
           SUM(oi.total_price) as revenue
    FROM order_items oi 
    JOIN orders o ON oi.order_id = o.id
    JOIN menu_items mi ON oi.menu_item_id = mi.id
    JOIN categories c ON mi.category_id = c.id
    WHERE o.status = 'completed' ${dateFilter}${sourceFilter}
    GROUP BY c.id ORDER BY revenue DESC
  `).all(...params);

  // Hourly pattern
  const hourlyPattern = db.prepare(`
    SELECT CAST(strftime('%H', created_at) AS INTEGER) as hour, COUNT(*) as orders, SUM(total) as revenue
    FROM orders o WHERE status = 'completed' ${dateFilter}${sourceFilter}
    GROUP BY hour ORDER BY hour
  `).all(...params);

  // Quadrant counts for legend
  const quadrantCounts = {
    topPerformers: heatmap.filter(h => h.quadrantKey === 'topPerformers').length,
    promoteMore: heatmap.filter(h => h.quadrantKey === 'promoteMore').length,
    improvePricing: heatmap.filter(h => h.quadrantKey === 'improvePricing').length,
    reviewRemove: heatmap.filter(h => h.quadrantKey === 'reviewRemove').length,
    missing: heatmap.filter(h => h.quadrantKey === 'missing').length
  };

  res.render('analytics', { 
    title: 'Analytics Dashboard', 
    summary, 
    salesTrend, 
    isShortRange,
    topItems, 
    heatmap, 
    medianProfit, 
    medianVolume, 
    categoryBreakdown, 
    hourlyPattern, 
    categories,
    quadrantCounts,
    missingCostCount,
    missingCostItems,
    query: req.query 
  });
});

module.exports = router;
