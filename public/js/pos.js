// ─── POS Module JavaScript ───
let cart = [];

document.addEventListener('DOMContentLoaded', () => {
  // Category filtering
  document.querySelectorAll('.cat-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.cat-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      filterMenuItems();
    });
  });

  const searchInput = document.getElementById('menuSearch');
  if (searchInput) searchInput.addEventListener('input', filterMenuItems);

  document.querySelectorAll('.pos-item-card').forEach(card => {
    card.addEventListener('click', () => {
      addToCart(parseInt(card.dataset.id), card.dataset.name, parseFloat(card.dataset.price));
    });
  });

  // Discount type change
  const discountType = document.getElementById('discountType');
  if (discountType) discountType.addEventListener('change', updateCartTotals);

  // Amount paid change
  const amountPaid = document.getElementById('amountPaid');
  if (amountPaid) amountPaid.addEventListener('input', updateChange);

  // Order source change - auto-select platform payment for Grab/Foodpanda
  document.querySelectorAll('input[name="orderSource"]').forEach(radio => {
    radio.addEventListener('change', () => {
      const src = radio.value;
      if (src === 'grab' || src === 'foodpanda') {
        document.getElementById('payPlatform').checked = true;
      } else {
        document.getElementById('payCash').checked = true;
      }
    });
  });

  const processBtn = document.getElementById('processOrderBtn');
  if (processBtn) processBtn.addEventListener('click', processOrder);

  const clearBtn = document.getElementById('clearCartBtn');
  if (clearBtn) clearBtn.addEventListener('click', clearCart);
});

function filterMenuItems() {
  const activeTab = document.querySelector('.cat-tab.active');
  const category = activeTab ? activeTab.dataset.category : 'all';
  const search = (document.getElementById('menuSearch')?.value || '').toLowerCase();
  document.querySelectorAll('.pos-item-card').forEach(card => {
    const matchCat = category === 'all' || card.dataset.category === category;
    const matchSearch = !search || card.dataset.name.toLowerCase().includes(search);
    card.style.display = matchCat && matchSearch ? '' : 'none';
  });
}

function addToCart(id, name, price) {
  const existing = cart.find(item => item.menu_item_id === id);
  if (existing) existing.quantity++;
  else cart.push({ menu_item_id: id, name, price, quantity: 1 });
  renderCart();
}

function updateCartItemQty(index, delta) {
  cart[index].quantity += delta;
  if (cart[index].quantity <= 0) cart.splice(index, 1);
  renderCart();
}

function removeCartItem(index) {
  cart.splice(index, 1);
  renderCart();
}

function renderCart() {
  const container = document.getElementById('cartItems');
  const processBtn = document.getElementById('processOrderBtn');
  if (cart.length === 0) {
    container.innerHTML = '<p class="text-muted text-center py-3" id="emptyCart">Tap items to add to order</p>';
    processBtn.disabled = true;
  } else {
    let html = '';
    cart.forEach((item, i) => {
      const total = item.price * item.quantity;
      html += '<div class="cart-item">' +
        '<div class="cart-item-info"><div class="cart-item-name">' + item.name + '</div>' +
        '<div class="cart-item-price">₱' + item.price.toFixed(2) + '</div></div>' +
        '<div class="cart-item-qty">' +
        '<button onclick="updateCartItemQty(' + i + ', -1)">-</button>' +
        '<span>' + item.quantity + '</span>' +
        '<button onclick="updateCartItemQty(' + i + ', 1)">+</button></div>' +
        '<div class="cart-item-total">₱' + total.toFixed(2) + '</div>' +
        '<button class="cart-item-remove" onclick="removeCartItem(' + i + ')">' +
        '<i class="bi bi-x-lg"></i></button></div>';
    });
    container.innerHTML = html;
    processBtn.disabled = false;
  }
  updateCartTotals();
}

function getDiscountAmount(subtotal) {
  const discountType = document.getElementById('discountType')?.value || 'none';
  if (discountType === 'senior' || discountType === 'pwd') {
    return subtotal * 0.20;
  }
  return 0;
}

function updateCartTotals() {
  const subtotal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
  const discountAmt = getDiscountAmount(subtotal);
  const total = Math.max(0, subtotal - discountAmt);

  document.getElementById('subtotal').textContent = '₱' + subtotal.toFixed(2);
  document.getElementById('discountAmount').textContent = '-₱' + discountAmt.toFixed(2);
  document.getElementById('totalAmount').textContent = '₱' + total.toFixed(2);

  const amountPaid = document.getElementById('amountPaid');
  if (amountPaid && !amountPaid.value) amountPaid.placeholder = total.toFixed(2);
  updateChange();
}

function updateChange() {
  const subtotal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
  const discountAmt = getDiscountAmount(subtotal);
  const total = Math.max(0, subtotal - discountAmt);
  const paid = parseFloat(document.getElementById('amountPaid')?.value || 0);
  const change = Math.max(0, paid - total);
  document.getElementById('changeAmount').textContent = '₱' + change.toFixed(2);
}

async function processOrder() {
  if (cart.length === 0) return;
  const subtotal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
  const discountType = document.getElementById('discountType')?.value || 'none';
  const discountAmt = getDiscountAmount(subtotal);
  const total = Math.max(0, subtotal - discountAmt);
  const amountPaid = parseFloat(document.getElementById('amountPaid')?.value) || total;

  if (amountPaid < total) { alert('Amount paid is less than total!'); return; }

  const paymentMethod = document.querySelector('input[name="paymentMethod"]:checked')?.value || 'cash';
  const source = document.querySelector('input[name="orderSource"]:checked')?.value || 'in-store';
  const notes = document.getElementById('orderNotes')?.value || '';

  const orderData = {
    items: cart.map(item => ({ menu_item_id: item.menu_item_id, quantity: item.quantity })),
    payment_method: paymentMethod,
    amount_paid: amountPaid,
    discount: discountAmt,
    discount_type: discountType,
    notes: notes,
    source: source
  };

  try {
    const res = await fetch('/pos/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(orderData)
    });
    if (res.ok) {
      const data = await res.json();
      showReceipt(data.order);
      clearCart();
    } else {
      const err = await res.json();
      if (err.requireShift) {
        // Show shift requirement modal or redirect
        if (confirm('No open shift. You must start a shift before processing orders.\n\nGo to Shift Management now?')) {
          window.location.href = '/shifts';
        }
      } else {
        alert('Error: ' + (err.error || 'Failed to process order'));
      }
    }
  } catch (err) {
    alert('Network error. Please try again.');
  }
}

function showReceipt(order) {
  const receiptBody = document.getElementById('receiptBody');
  if (!receiptBody) return;

  const discountLabel = order.discount_type === 'senior' ? 'Senior Citizen (20%)' : order.discount_type === 'pwd' ? 'PWD (20%)' : '';

  let html = '<div class="receipt-content" id="receiptContent">' +
    '<div class="text-center mb-3"><h4>Señorito Cafe</h4><small class="text-muted">Official Receipt</small></div><hr>' +
    '<p><strong>Order #:</strong> ' + order.orderNumber + '</p>' +
    '<p><strong>Cashier:</strong> ' + (order.cashier || '') + '</p>' +
    '<p><strong>Date:</strong> ' + (order.date || new Date().toLocaleString()) + '</p>' +
    '<p><strong>Payment:</strong> ' + order.payment_method.toUpperCase() + '</p><hr>' +
    '<table class="table table-sm"><thead><tr><th>Item</th><th>Qty</th><th>Price</th><th>Total</th></tr></thead><tbody>';

  order.items.forEach(function(item) {
    html += '<tr><td>' + item.item_name + '</td><td>' + item.quantity + '</td><td>₱' + item.unit_price.toFixed(2) + '</td><td>₱' + item.total_price.toFixed(2) + '</td></tr>';
  });

  html += '</tbody></table><hr>' +
    '<div class="d-flex justify-content-between"><span>Subtotal:</span><span>₱' + order.subtotal.toFixed(2) + '</span></div>';
  if (order.discount > 0) {
    html += '<div class="d-flex justify-content-between text-danger"><span>Discount' + (discountLabel ? ' (' + discountLabel + ')' : '') + ':</span><span>-₱' + order.discount.toFixed(2) + '</span></div>';
  }
  html += '<div class="d-flex justify-content-between fs-5 fw-bold"><span>Total:</span><span>₱' + order.total.toFixed(2) + '</span></div>' +
    '<div class="d-flex justify-content-between"><span>Paid:</span><span>₱' + order.amountPaid.toFixed(2) + '</span></div>' +
    '<div class="d-flex justify-content-between fw-bold text-success"><span>Change:</span><span>₱' + order.change.toFixed(2) + '</span></div>' +
    '<hr><div class="text-center"><small>Thank you for visiting Señorito Cafe!</small></div></div>';

  receiptBody.innerHTML = html;
  new bootstrap.Modal(document.getElementById('receiptModal')).show();
}

function printReceipt() {
  const content = document.getElementById('receiptContent');
  if (!content) { window.print(); return; }
  const w = window.open('', '', 'width=300,height=600');
  w.document.write('<html><head><title>Receipt</title><style>body{font-family:monospace;font-size:12px;padding:10px;} table{width:100%;border-collapse:collapse;} th,td{text-align:left;padding:2px;} .text-center{text-align:center;} .fw-bold{font-weight:bold;} .fs-5{font-size:14px;} hr{border:1px dashed #000;} .d-flex{display:flex;} .justify-content-between{justify-content:space-between;} .text-danger{color:red;} .text-success{color:green;}</style></head><body>');
  w.document.write(content.innerHTML);
  w.document.write('</body></html>');
  w.document.close();
  w.print();
  w.close();
}

function clearCart() {
  cart = [];
  renderCart();
  if (document.getElementById('discountType')) document.getElementById('discountType').value = 'none';
  if (document.getElementById('amountPaid')) document.getElementById('amountPaid').value = '';
  if (document.getElementById('orderNotes')) document.getElementById('orderNotes').value = '';
  if (document.getElementById('srcInStore')) document.getElementById('srcInStore').checked = true;
  if (document.getElementById('payCash')) document.getElementById('payCash').checked = true;
}

window.updateCartItemQty = updateCartItemQty;
window.removeCartItem = removeCartItem;
window.printReceipt = printReceipt;
