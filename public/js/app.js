// ─── Señorito Cafe POS - Main App JavaScript ───

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const main = document.getElementById('mainContent');
  sidebar.classList.toggle('collapsed');
  sidebar.classList.toggle('show');
  main.classList.toggle('expanded');
}

function updateDateTime() {
  const el = document.getElementById('currentDateTime');
  if (el) {
    const now = new Date();
    el.textContent = now.toLocaleDateString('en-PH', {
      weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  }
}

// ─── Online Status: Always Synced ───
function updateOnlineStatus() {
  const statusEl = document.getElementById('onlineStatus');
  const iconEl = document.getElementById('statusIcon');
  const textEl = document.getElementById('statusText');
  if (!statusEl) return;
  statusEl.className = 'online-status synced';
  if (iconEl) iconEl.className = 'bi bi-wifi';
  if (textEl) textEl.textContent = 'Synced';
}

// ─── Toast Notifications ───
function showToast(message, type) {
  type = type || 'info';
  const container = document.getElementById('toastContainer') || createToastContainer();
  const toast = document.createElement('div');
  toast.className = 'toast-notification toast-' + type;
  const icon = type === 'success' ? 'check-circle' : type === 'error' ? 'x-circle' : type === 'warning' ? 'exclamation-triangle' : 'info-circle';
  toast.innerHTML = '<i class="bi bi-' + icon + '"></i> <span>' + message + '</span>';
  container.appendChild(toast);
  setTimeout(function() { toast.style.opacity = '0'; setTimeout(function() { toast.remove(); }, 300); }, 3000);
}

function createToastContainer() {
  const container = document.createElement('div');
  container.id = 'toastContainer';
  container.style.cssText = 'position:fixed;top:70px;right:20px;z-index:9999;display:flex;flex-direction:column;gap:8px;';
  document.body.appendChild(container);
  return container;
}

// Toast styles
var toastStyle = document.createElement('style');
toastStyle.textContent = '.toast-notification{display:flex;align-items:center;gap:8px;padding:12px 18px;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.15);font-size:0.9rem;transition:opacity 0.3s;min-width:250px;} .toast-success{background:#d4edda;color:#155724;} .toast-error{background:#f8d7da;color:#721c24;} .toast-info{background:#d1ecf1;color:#0c5460;} .toast-warning{background:#fff3cd;color:#856404;}';
document.head.appendChild(toastStyle);

// ─── Init ───
document.addEventListener('DOMContentLoaded', function() {
  updateDateTime();
  setInterval(updateDateTime, 30000);
  updateOnlineStatus();
});

function formatPHP(amount) {
  return '₱' + parseFloat(amount || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
