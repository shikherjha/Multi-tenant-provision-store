/**
 * Lightweight E-Commerce Backend
 * 
 * Provides the same REST API surface as MedusaJS for the storefront:
 *   - GET  /health                        → health check
 *   - GET  /store/products                → product listing
 *   - POST /store/carts                   → create cart
 *   - GET  /store/carts/:id               → get cart
 *   - POST /store/carts/:id               → update cart
 *   - POST /store/carts/:id/line-items    → add item
 *   - DELETE /store/carts/:id/line-items/:itemId → remove item
 *   - POST /store/carts/:id/complete      → checkout
 *   - POST /store/carts/:id/payment-sessions → payment (stub)
 *   - POST /store/carts/:id/payment-session  → select payment (stub)
 *   - POST /store/carts/:id/shipping-methods → shipping (stub)
 *   - GET  /store/shipping-options/:id    → shipping options (stub)
 *   - GET  /admin/store                   → admin info
 *   - GET  /app*                          → admin panel (simple UI)
 * 
 * Uses PostgreSQL for persistence. Falls back to in-memory data if DB fails.
 */

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 9000;
const DATABASE_URL = process.env.DATABASE_URL;

// --- Database ---
const pool = new Pool({ connectionString: DATABASE_URL });
let dbReady = false;

// Sample product data
const SAMPLE_PRODUCTS = [
    {
        id: "prod_01",
        title: "Medusa T-Shirt",
        description: "A comfortable cotton t-shirt with the Medusa logo",
        thumbnail: null,
        variants: [{ id: "variant_01", title: "S", prices: [{ amount: 2500, currency_code: "usd" }], inventory_quantity: 100 }],
        handle: "medusa-tshirt",
        status: "published"
    },
    {
        id: "prod_02",
        title: "Medusa Hoodie",
        description: "A warm hoodie for developers who ship at night",
        thumbnail: null,
        variants: [{ id: "variant_02", title: "M", prices: [{ amount: 4500, currency_code: "usd" }], inventory_quantity: 50 }],
        handle: "medusa-hoodie",
        status: "published"
    },
    {
        id: "prod_03",
        title: "Medusa Mug",
        description: "Start your morning with coffee and Kubernetes",
        thumbnail: null,
        variants: [{ id: "variant_03", title: "Standard", prices: [{ amount: 1200, currency_code: "usd" }], inventory_quantity: 200 }],
        handle: "medusa-mug",
        status: "published"
    }
];

// In-memory carts & orders
const carts = new Map();
const orders = [];

// --- DB Init ---
async function initDB() {
    try {
        await pool.query(`
      CREATE TABLE IF NOT EXISTS products (
        id VARCHAR(64) PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        handle VARCHAR(255),
        status VARCHAR(32) DEFAULT 'published',
        data JSONB DEFAULT '{}'
      )
    `);
        const { rows } = await pool.query('SELECT COUNT(*) as count FROM products');
        if (parseInt(rows[0].count) === 0) {
            for (const p of SAMPLE_PRODUCTS) {
                await pool.query(
                    'INSERT INTO products (id, title, description, handle, status, data) VALUES ($1, $2, $3, $4, $5, $6)',
                    [p.id, p.title, p.description, p.handle, p.status, JSON.stringify({ variants: p.variants, thumbnail: p.thumbnail })]
                );
            }
            console.log('✓ Seeded 3 products');
        }
        dbReady = true;
        console.log('✓ Database initialized');
    } catch (err) {
        console.warn('⚠ Database init failed, using in-memory data:', err.message);
    }
}

// --- Routes ---

// Health check
app.get('/health', async (req, res) => {
    try {
        if (DATABASE_URL) await pool.query('SELECT 1');
        res.json({ status: 'ok', timestamp: new Date().toISOString() });
    } catch {
        res.status(503).json({ status: 'unhealthy' });
    }
});

// Admin store info
app.get('/admin/store', (req, res) => {
    res.json({ store: { name: 'Medusa Store', default_currency_code: 'usd' } });
});

// Admin panel UI
app.get('/app*', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Store Admin</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root { --bg:#0f0f13; --surface:#1a1a24; --border:#2a2a3e; --primary:#7c3aed; --accent:#06d6a0; --text:#e4e4e7; --muted:#9ca3af; }
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:'Inter',sans-serif; background:var(--bg); color:var(--text); min-height:100vh; }
    header { background:linear-gradient(135deg,rgba(124,58,237,0.2),rgba(6,214,160,0.1)); border-bottom:1px solid var(--border); padding:1rem 2rem; display:flex; justify-content:space-between; align-items:center; }
    .logo { font-size:1.4rem; font-weight:700; } .logo span { color:var(--primary); }
    main { max-width:1100px; margin:2rem auto; padding:0 2rem; }
    h1 { font-size:1.8rem; margin-bottom:1.5rem; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:1rem; margin-bottom:2rem; }
    .stat-card { background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:1.5rem; }
    .stat-value { font-size:2rem; font-weight:700; color:var(--accent); }
    .stat-label { color:var(--muted); font-size:0.85rem; margin-top:0.3rem; }
    table { width:100%; border-collapse:collapse; background:var(--surface); border-radius:12px; overflow:hidden; border:1px solid var(--border); }
    th { text-align:left; padding:1rem; background:rgba(124,58,237,0.1); font-weight:600; font-size:0.85rem; color:var(--muted); text-transform:uppercase; letter-spacing:0.05em; }
    td { padding:1rem; border-top:1px solid var(--border); }
    .badge { display:inline-block; padding:0.2rem 0.6rem; border-radius:20px; font-size:0.75rem; font-weight:600; }
    .badge-green { background:rgba(34,197,94,0.15); color:#22c55e; }
    .badge-blue { background:rgba(59,130,246,0.15); color:#3b82f6; }
    h2 { font-size:1.3rem; margin:2rem 0 1rem; }
    .empty { text-align:center; padding:3rem; color:var(--muted); }
  </style>
</head>
<body>
  <header>
    <div class="logo"><span>Medusa</span> Admin</div>
    <div style="color:var(--muted);font-size:0.85rem">Store Management Panel</div>
  </header>
  <main>
    <h1>Dashboard</h1>
    <div class="stats">
      <div class="stat-card"><div class="stat-value" id="product-count">-</div><div class="stat-label">Products</div></div>
      <div class="stat-card"><div class="stat-value" id="order-count">-</div><div class="stat-label">Orders</div></div>
      <div class="stat-card"><div class="stat-value" id="revenue">-</div><div class="stat-label">Revenue</div></div>
    </div>
    <h2>Products</h2>
    <table><thead><tr><th>ID</th><th>Title</th><th>Price</th><th>Status</th></tr></thead><tbody id="products-table"></tbody></table>
    <h2>Recent Orders</h2>
    <div id="orders-section"></div>
  </main>
  <script>
    async function load() {
      try {
        const { products, count } = await (await fetch('/store/products')).json();
        document.getElementById('product-count').textContent = count;
        document.getElementById('products-table').innerHTML = products.map(p =>
          '<tr><td style="font-family:monospace;font-size:0.85rem">' + p.id + '</td><td>' + p.title + '</td><td style="color:var(--accent)">$' + (p.variants[0]?.prices[0]?.amount/100).toFixed(2) + '</td><td><span class="badge badge-green">Published</span></td></tr>'
        ).join('');

        const { orders: ords, count: oc, revenue: rev } = await (await fetch('/admin/orders')).json();
        document.getElementById('order-count').textContent = oc;
        document.getElementById('revenue').textContent = '$' + (rev/100).toFixed(2);

        if (oc === 0) {
          document.getElementById('orders-section').innerHTML = '<div class="empty">No orders yet. Make a purchase from the storefront!</div>';
        } else {
          let html = '<table><thead><tr><th>Order ID</th><th>Items</th><th>Total</th><th>Status</th><th>Date</th></tr></thead><tbody>';
          ords.forEach(o => {
            html += '<tr><td style="font-family:monospace;font-size:0.85rem">' + o.id + '</td><td>' + o.items.length + ' items</td><td style="color:var(--accent)">$' + (o.total/100).toFixed(2) + '</td><td><span class="badge badge-blue">' + o.status + '</span></td><td style="color:var(--muted);font-size:0.85rem">' + new Date(o.created_at).toLocaleString() + '</td></tr>';
          });
          html += '</tbody></table>';
          document.getElementById('orders-section').innerHTML = html;
        }
      } catch(e) { console.error(e); }
    }
    load();
  </script>
</body>
</html>`);
});

// List products
app.get('/store/products', async (req, res) => {
    try {
        if (dbReady) {
            const { rows } = await pool.query('SELECT * FROM products WHERE status = $1', ['published']);
            const products = rows.map(r => ({
                id: r.id, title: r.title, description: r.description, handle: r.handle, status: r.status,
                thumbnail: r.data?.thumbnail || null, variants: r.data?.variants || []
            }));
            return res.json({ products, count: products.length });
        }
    } catch (err) {
        console.warn('DB query failed:', err.message);
    }
    res.json({ products: SAMPLE_PRODUCTS, count: SAMPLE_PRODUCTS.length });
});

// Get single product
app.get('/store/products/:id', (req, res) => {
    const product = SAMPLE_PRODUCTS.find(p => p.id === req.params.id);
    if (product) return res.json({ product });
    res.status(404).json({ message: 'Product not found' });
});

// Create cart — POST /store/carts  (note the 's' — Medusa uses /store/carts)
app.post('/store/carts', (req, res) => {
    const id = `cart_${crypto.randomUUID().slice(0, 8)}`;
    const cart = { id, items: [], region_id: 'reg_01', total: 0, subtotal: 0, created_at: new Date().toISOString() };
    carts.set(id, cart);
    res.status(201).json({ cart });
});

// Get cart — GET /store/carts/:id
app.get('/store/carts/:id', (req, res) => {
    const cart = carts.get(req.params.id);
    if (!cart) return res.status(404).json({ message: 'Cart not found' });
    res.json({ cart });
});

// Update cart — POST /store/carts/:id
app.post('/store/carts/:id', (req, res) => {
    const cart = carts.get(req.params.id);
    if (!cart) return res.status(404).json({ message: 'Cart not found' });
    // Store customer info on the cart
    if (req.body.email) cart.email = req.body.email;
    if (req.body.shipping_address) cart.shipping_address = req.body.shipping_address;
    res.json({ cart });
});

// Add line item — POST /store/carts/:id/line-items
app.post('/store/carts/:id/line-items', (req, res) => {
    const cart = carts.get(req.params.id);
    if (!cart) return res.status(404).json({ message: 'Cart not found' });

    const { variant_id, quantity = 1 } = req.body;
    const product = SAMPLE_PRODUCTS.find(p => p.variants.some(v => v.id === variant_id));
    const variant = product?.variants.find(v => v.id === variant_id);

    if (!variant) return res.status(404).json({ message: 'Variant not found' });

    const lineItem = {
        id: `item_${crypto.randomUUID().slice(0, 8)}`,
        variant_id,
        title: product.title,
        description: variant.title,
        quantity,
        unit_price: variant.prices[0].amount,
        total: variant.prices[0].amount * quantity
    };

    cart.items.push(lineItem);
    cart.subtotal = cart.items.reduce((sum, i) => sum + i.total, 0);
    cart.total = cart.subtotal;
    res.json({ cart });
});

// Remove line item — DELETE /store/carts/:id/line-items/:itemId
app.delete('/store/carts/:id/line-items/:itemId', (req, res) => {
    const cart = carts.get(req.params.id);
    if (!cart) return res.status(404).json({ message: 'Cart not found' });
    cart.items = cart.items.filter(i => i.id !== req.params.itemId);
    cart.subtotal = cart.items.reduce((sum, i) => sum + i.total, 0);
    cart.total = cart.subtotal;
    res.json({ cart });
});

// Shipping options (stub)
app.get('/store/shipping-options/:cartId', (req, res) => {
    res.json({ shipping_options: [{ id: 'so_free', name: 'Free Shipping', amount: 0 }] });
});

// Add shipping method (stub)
app.post('/store/carts/:id/shipping-methods', (req, res) => {
    const cart = carts.get(req.params.id);
    if (!cart) return res.status(404).json({ message: 'Cart not found' });
    cart.shipping_method = req.body.option_id;
    res.json({ cart });
});

// Payment sessions (stub)
app.post('/store/carts/:id/payment-sessions', (req, res) => {
    const cart = carts.get(req.params.id);
    if (!cart) return res.status(404).json({ message: 'Cart not found' });
    cart.payment_sessions = [{ provider_id: 'manual', is_selected: true }];
    res.json({ cart });
});

// Select payment session (stub)
app.post('/store/carts/:id/payment-session', (req, res) => {
    const cart = carts.get(req.params.id);
    if (!cart) return res.status(404).json({ message: 'Cart not found' });
    cart.payment_session = { provider_id: req.body.provider_id };
    res.json({ cart });
});

// Complete cart (checkout)
app.post('/store/carts/:id/complete', (req, res) => {
    const cart = carts.get(req.params.id);
    if (!cart) return res.status(404).json({ message: 'Cart not found' });

    const order = {
        id: `order_${crypto.randomUUID().slice(0, 8)}`,
        display_id: orders.length + 1,
        status: 'completed',
        items: cart.items,
        total: cart.total,
        email: cart.email || 'guest@example.com',
        shipping_address: cart.shipping_address || {},
        created_at: new Date().toISOString()
    };

    orders.push(order);
    carts.delete(req.params.id);
    res.json({ type: 'order', data: order });
});

// Admin: list orders
app.get('/admin/orders', (req, res) => {
    const revenue = orders.reduce((sum, o) => sum + o.total, 0);
    res.json({ orders: orders.slice().reverse(), count: orders.length, revenue });
});

// --- Start ---
async function main() {
    console.log('============================================');
    console.log('  E-Commerce Backend — Starting');
    console.log('============================================');

    if (DATABASE_URL) {
        console.log('Connecting to PostgreSQL...');
        await initDB();
    } else {
        console.log('No DATABASE_URL — running with in-memory data');
    }

    app.listen(PORT, '0.0.0.0', () => {
        console.log(`✓ Server listening on 0.0.0.0:${PORT}`);
        console.log('============================================');
    });
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
