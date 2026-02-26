
document.addEventListener('DOMContentLoaded', function() {

// Sales Trend Chart

new Chart(document.getElementById('salesChart'), {
  type: 'line',
  data: {
    labels: ["2026-02-26"],
    datasets: [{
      label: 'Revenue', data: [8580],
      borderColor: '#4a2c2a', backgroundColor: 'rgba(74,44,42,0.1)', fill: true, tension: 0.3
    }, {
      label: 'Orders', data: [6],
      borderColor: '#e67e22', yAxisID: 'y1', tension: 0.3
    }]
  },
  options: {
    scales: {
      y: { beginAtZero: true, title: { display: true, text: 'Revenue (PHP)' } },
      y1: { position: 'right', beginAtZero: true, title: { display: true, text: 'Orders' }, grid: { drawOnChartArea: false } }
    }
  }
});


// 2×2 Quadrant Bubble Chart - Menu Profitability Heatmap
(function() {
  const canvas = document.getElementById('heatmapChart');
  if (!canvas) {
    console.log('Heatmap: No canvas element found (empty state shown)');
    return;
  }
  
  // Get all items from heatmap where cost is set (not missing)
  const allItems = [{"id":3,"name":"Test Item A (high profit)","price":120,"category":"Hot Coffee","volume":0,"revenue":0,"estimated_cost":20,"profit_per_item":100,"margin":83.33,"cost_status":"set","quadrant":"Promote More","quadrantKey":"promoteMore"},{"id":4,"name":"Test Item B (high profit)","price":120,"category":"Iced Coffee","volume":22,"revenue":2640,"estimated_cost":20,"profit_per_item":100,"margin":83.33,"cost_status":"set","quadrant":"Top Performers","quadrantKey":"topPerformers"},{"id":5,"name":"Test Item C (low profit)","price":80,"category":"Non-Coffee","volume":20,"revenue":1600,"estimated_cost":70,"profit_per_item":10,"margin":12.5,"cost_status":"set","quadrant":"Improve Pricing","quadrantKey":"improvePricing"},{"id":6,"name":"Test Item D (low profit)","price":80,"category":"Non-Coffee","volume":2,"revenue":160,"estimated_cost":70,"profit_per_item":10,"margin":12.5,"cost_status":"set","quadrant":"Review or Remove","quadrantKey":"reviewRemove"}];
  const hm = allItems.filter(function(h) { return h.cost_status === 'set' || h.cost_status === 'zero'; });
  
  if (hm.length === 0) {
    console.log('Heatmap: No plottable items with cost data');
    return;
  }
  
  console.log('Heatmap: Rendering', hm.length, 'items');
  
  const medProfit = 100;
  const medVolume = 20;
  
  // Quadrant colors
  const colors = { 
    topPerformers: 'rgba(25,135,84,0.75)', 
    promoteMore: 'rgba(13,202,240,0.75)', 
    improvePricing: 'rgba(255,193,7,0.75)', 
    reviewRemove: 'rgba(220,53,69,0.75)',
    missing: 'rgba(108,117,125,0.5)'
  };
  
  // Calculate bubble size based on revenue (normalize to 8-35 radius)
  const revenues = hm.map(function(i) { return i.revenue; });
  const maxRev = Math.max.apply(null, revenues.concat([1]));
  const minRev = Math.min.apply(null, revenues.concat([0]));
  
  // Group items by quadrant for datasets
  const datasets = {};
  hm.forEach(function(item) {
    var qKey = item.quadrantKey || 'reviewRemove';
    if (!datasets[qKey]) {
      datasets[qKey] = { 
        label: item.quadrant, 
        data: [], 
        backgroundColor: colors[qKey] || colors.reviewRemove,
        borderColor: (colors[qKey] || colors.reviewRemove).replace('0.75', '1'),
        borderWidth: 2,
        hoverBorderWidth: 3
      };
    }
    var normalized = maxRev > minRev ? (item.revenue - minRev) / (maxRev - minRev) : 0.5;
    var radius = 8 + normalized * 27;
    datasets[qKey].data.push({ 
      x: item.profit_per_item, 
      y: item.volume, 
      r: radius,
      name: item.name,
      id: item.id,
      revenue: item.revenue,
      cost: item.estimated_cost,
      margin: item.margin,
      quadrant: item.quadrant,
      costStatus: item.cost_status
    });
  });
  
  // Calculate axis bounds
  var profits = hm.map(function(i) { return i.profit_per_item; });
  var volumes = hm.map(function(i) { return i.volume; });
  var xMin = Math.min.apply(null, profits) - 15;
  var xMax = Math.max.apply(null, profits) + 15;
  var yMin = 0;
  var yMax = Math.max.apply(null, volumes) * 1.2 + 1;
  
  // Ensure axes have reasonable ranges
  if (xMin === xMax) { xMin -= 20; xMax += 20; }
  if (yMax <= 1) { yMax = 10; }
  
  var chart = new Chart(canvas, {
    type: 'bubble',
    data: { datasets: Object.values(datasets) },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          position: 'bottom',
          labels: { boxWidth: 12, padding: 15 }
        },
        tooltip: {
          callbacks: { 
            label: function(ctx) { 
              var d = ctx.raw;
              var lines = [
                d.name,
                'Units Sold: ' + d.y,
                'Revenue: ?' + d.revenue.toFixed(2),
                'Est. Cost: ?' + d.cost.toFixed(2),
                'Profit/Item: ?' + d.x.toFixed(2),
                'Margin: ' + d.margin.toFixed(1) + '%',
                'Quadrant: ' + d.quadrant
              ];
              if (d.costStatus === 'zero') {
                lines.push('? Cost is zero');
              }
              return lines;
            }
          }
        }
      },
      onClick: function(evt, elements) {
        if (elements.length > 0) {
          var dataIndex = elements[0].index;
          var datasetIndex = elements[0].datasetIndex;
          var itemId = chart.data.datasets[datasetIndex].data[dataIndex].id;
          highlightTableRow(itemId);
        }
      },
      scales: {
        x: { 
          title: { display: true, text: 'Profit per Item (?)', font: { weight: 'bold' } },
          min: xMin,
          max: xMax,
          grid: { color: 'rgba(0,0,0,0.05)' }
        },
        y: { 
          title: { display: true, text: 'Units Sold', font: { weight: 'bold' } },
          min: yMin,
          max: yMax,
          grid: { color: 'rgba(0,0,0,0.05)' }
        }
      }
    },
    plugins: [{
      id: 'quadrantLines',
      afterDraw: function(chart) {
        var ctx = chart.ctx;
        var xScale = chart.scales.x;
        var yScale = chart.scales.y;
        
        // Draw quadrant background shading
        var xPx = xScale.getPixelForValue(medProfit);
        var yPx = yScale.getPixelForValue(medVolume);
        
        ctx.save();
        
        // Top-right: Top Performers (green tint)
        ctx.fillStyle = 'rgba(25,135,84,0.05)';
        ctx.fillRect(xPx, yScale.top, xScale.right - xPx, yPx - yScale.top);
        
        // Top-left: Improve Pricing (yellow tint)
        ctx.fillStyle = 'rgba(255,193,7,0.05)';
        ctx.fillRect(xScale.left, yScale.top, xPx - xScale.left, yPx - yScale.top);
        
        // Bottom-right: Promote More (blue tint)
        ctx.fillStyle = 'rgba(13,202,240,0.05)';
        ctx.fillRect(xPx, yPx, xScale.right - xPx, yScale.bottom - yPx);
        
        // Bottom-left: Review/Remove (red tint)
        ctx.fillStyle = 'rgba(220,53,69,0.05)';
        ctx.fillRect(xScale.left, yPx, xPx - xScale.left, yScale.bottom - yPx);
        
        // Draw dashed median threshold lines
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = 'rgba(0,0,0,0.5)';
        ctx.lineWidth = 2;
        
        // Vertical median line (profit threshold)
        ctx.beginPath();
        ctx.moveTo(xPx, yScale.top);
        ctx.lineTo(xPx, yScale.bottom);
        ctx.stroke();
        
        // Horizontal median line (volume threshold)
        ctx.beginPath();
        ctx.moveTo(xScale.left, yPx);
        ctx.lineTo(xScale.right, yPx);
        ctx.stroke();
        
        // Add quadrant labels in corners
        ctx.setLineDash([]);
        ctx.font = 'bold 10px sans-serif';
        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        ctx.fillText('? Top Performers', xPx + 8, yScale.top + 14);
        ctx.fillText('? Promote More', xPx + 8, yPx + 14);
        ctx.fillText('?? Improve Pricing', xScale.left + 8, yScale.top + 14);
        ctx.fillText('?? Review/Remove', xScale.left + 8, yPx + 14);
        
        ctx.restore();
      }
    }]
  });
  
  console.log('Heatmap: Chart rendered successfully');
})();

// Category Chart

new Chart(document.getElementById('categoryChart'), {
  type: 'doughnut',
  data: {
    labels: ["Iced Coffee","Non-Coffee"],
    datasets: [{ 
      data: [4540,4040],
      backgroundColor: ['#4a2c2a','#e67e22','#27ae60','#3498db','#9b59b6','#e74c3c','#1abc9c','#f39c12'] 
    }]
  },
  options: {
    plugins: {
      legend: { position: 'bottom', labels: { boxWidth: 12 } }
    }
  }
});


// Hourly Chart

new Chart(document.getElementById('hourlyChart'), {
  type: 'bar',
  data: {
    labels: ["0:00"],
    datasets: [{ 
      label: 'Orders', 
      data: [6],
      backgroundColor: 'rgba(74,44,42,0.6)' 
    }]
  },
  options: { scales: { y: { beginAtZero: true } } }
});


 // End if summary.total_orders > 0
}); // End DOMContentLoaded

// Global helper functions (outside DOMContentLoaded for onclick handlers)
function highlightTableRow(itemId) {
  document.querySelectorAll('#profitabilityTable tbody tr').forEach(tr => tr.classList.remove('table-row-highlight'));
  const row = document.querySelector('#profitabilityTable tr[data-item-id="' + itemId + '"]');
  if (row) {
    row.classList.add('table-row-highlight');
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function sortTable(sortBy) {
  const tbody = document.querySelector('#profitabilityTable tbody');
  if (!tbody) return;
  const rows = Array.from(tbody.querySelectorAll('tr'));
  
  rows.sort((a, b) => {
    let aVal, bVal;
    switch(sortBy) {
      case 'revenue': aVal = parseFloat(a.dataset.revenue) || 0; bVal = parseFloat(b.dataset.revenue) || 0; return bVal - aVal;
      case 'profit': aVal = parseFloat(a.dataset.profit) || 0; bVal = parseFloat(b.dataset.profit) || 0; return bVal - aVal;
      case 'margin': aVal = parseFloat(a.dataset.margin) || 0; bVal = parseFloat(b.dataset.margin) || 0; return aVal - bVal;
      case 'volume': aVal = parseFloat(a.dataset.volume) || 0; bVal = parseFloat(b.dataset.volume) || 0; return bVal - aVal;
      default: return 0;
    }
  });
  
  rows.forEach(row => tbody.appendChild(row));
}

