const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.SUPPLIER_SERVICE_PORT || 4001;

app.use(cors());
app.use(express.json());

const dbPath = path.resolve(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('[Supplier Service] Database connection error:', err.message);
    } else {
        console.log('[Supplier Service] Connected to SQLite database.');
        initDatabase();
    }
});

function initDatabase() {
    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS suppliers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            approved BOOLEAN NOT NULL DEFAULT 1,
            avg_historical_price REAL,
            order_count INTEGER DEFAULT 0
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS supplier_catalog (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id INTEGER,
            supplier_id INTEGER,
            unit_price REAL,
            lead_time_days INTEGER,
            in_stock INTEGER DEFAULT 1,
            FOREIGN KEY(product_id) REFERENCES products(id),
            FOREIGN KEY(supplier_id) REFERENCES suppliers(id)
        )`);

        seedCatalog();
    });
}

function seedCatalog() {
    db.get("SELECT COUNT(*) as count FROM suppliers", (err, row) => {
        if (row && row.count === 0) {
            console.log('[Supplier Service] Seeding suppliers...');
            const stmt = db.prepare("INSERT INTO suppliers (id, name, approved, avg_historical_price, order_count) VALUES (?, ?, ?, ?, ?)");
            stmt.run(1, "Acme FMCG Wholesale", true, 2.0, 10);
            stmt.run(2, "Mother Dairy", true, 2.0, 10);
            stmt.run(3, "QuickPack Distributors", true, 2.0, 0);
            stmt.run(4, "Amul", true, 2.0, 10);
            stmt.finalize();
        }
    });

    db.get("SELECT COUNT(*) as count FROM supplier_catalog", (err, row) => {
        if (row && row.count === 0) {
            console.log('[Supplier Service] Seeding supplier_catalog...');
            const stmtCat = db.prepare(`INSERT INTO supplier_catalog (product_id, supplier_id, unit_price, lead_time_days, in_stock) VALUES (?, ?, ?, ?, ?)`);
            stmtCat.run(1, 1, 1.50, 2, 1);
            
            // Whole Milk 1L: 2 suppliers (Mother Dairy @ 2.80, Amul @ 2.00)
            stmtCat.run(2, 2, 2.80, 1, 1);
            stmtCat.run(2, 4, 2.00, 1, 1);
            
            stmtCat.run(3, 1, 4.50, 3, 1);
            stmtCat.run(4, 3, 0.50, 1, 1);
            stmtCat.run(5, 3, 20.00, 1, 1);
            stmtCat.run(6, 1, 35.00, 2, 1);
            stmtCat.run(7, 2, 90.00, 1, 1);
            stmtCat.run(8, 2, 80.00, 1, 1);
            stmtCat.run(9, 1, 55.00, 3, 1);
            stmtCat.run(10, 1, 120.00, 3, 1);
            
            // Basmati Rice 1kg: 2 suppliers (Acme FMCG Wholesale @ 85.00, QuickPack Distributors @ 80.00)
            stmtCat.run(11, 1, 85.00, 2, 1);
            stmtCat.run(11, 3, 80.00, 2, 1);
            
            stmtCat.run(12, 3, 120.00, 1, 1);
            stmtCat.finalize();
        }
    });
}

// GET /api/catalog/:productId - Query supplier catalog by product ID
app.get('/api/catalog/:productId', (req, res) => {
    const productId = parseInt(req.params.productId, 10);
    console.log(`[Supplier Service] HTTP GET /api/catalog/${productId} received`);

    const query = `
        SELECT 
            sc.product_id,
            sc.supplier_id,
            s.name as supplier_name,
            sc.unit_price,
            sc.lead_time_days,
            sc.in_stock,
            s.order_count,
            s.avg_historical_price
        FROM supplier_catalog sc
        JOIN suppliers s ON sc.supplier_id = s.id
        WHERE sc.product_id = ? AND sc.in_stock = 1
    `;

    db.all(query, [productId], (err, rows) => {
        if (err) {
            console.error(`[Supplier Service] Error querying catalog for product ${productId}:`, err.message);
            return res.status(500).json({ error: 'Database query error' });
        }
        console.log(`[Supplier Service] Responded with ${rows ? rows.length : 0} catalog entries for Product ID ${productId}`);
        res.json(rows || []);
    });
});

// POST /api/catalog/update - Update supplier price / stock / lead time dynamically
app.post('/api/catalog/update', (req, res) => {
    const { product_id, supplier_id, unit_price, in_stock, lead_time_days } = req.body;
    if (!product_id || !supplier_id) {
        return res.status(400).json({ error: 'Missing product_id or supplier_id' });
    }

    const updates = [];
    const params = [];

    if (unit_price !== undefined) {
        updates.push('unit_price = ?');
        params.push(unit_price);
    }
    if (in_stock !== undefined) {
        updates.push('in_stock = ?');
        params.push(in_stock);
    }
    if (lead_time_days !== undefined) {
        updates.push('lead_time_days = ?');
        params.push(lead_time_days);
    }

    if (updates.length === 0) {
        return res.status(400).json({ error: 'No fields to update' });
    }

    params.push(product_id, supplier_id);
    const sql = `UPDATE supplier_catalog SET ${updates.join(', ')} WHERE product_id = ? AND supplier_id = ?`;

    db.run(sql, params, function (err) {
        if (err) {
            console.error('[Supplier Service] Error updating catalog entry:', err.message);
            return res.status(500).json({ error: err.message });
        }
        console.log(`[Supplier Service] Updated Product ID ${product_id}, Supplier ID ${supplier_id}: ${updates.join(', ')}`);
        res.json({ status: 'success', message: 'Catalog entry updated', changes: this.changes });
    });
});

// POST /api/reset - Re-seed catalog table
app.post('/api/reset', (req, res) => {
    console.log('[Supplier Service] Resetting supplier catalog data...');
    db.serialize(() => {
        db.run("DELETE FROM supplier_catalog", () => {
            const stmtCat = db.prepare(`INSERT INTO supplier_catalog (product_id, supplier_id, unit_price, lead_time_days, in_stock) VALUES (?, ?, ?, ?, ?)`);
            stmtCat.run(1, 1, 1.50, 2, 1);
            stmtCat.run(2, 2, 2.80, 1, 1);
            stmtCat.run(2, 4, 2.00, 1, 1);
            stmtCat.run(3, 1, 4.50, 3, 1);
            stmtCat.run(4, 3, 0.50, 1, 1);
            stmtCat.run(5, 3, 20.00, 1, 1);
            stmtCat.run(6, 1, 35.00, 2, 1);
            stmtCat.run(7, 2, 90.00, 1, 1);
            stmtCat.run(8, 2, 80.00, 1, 1);
            stmtCat.run(9, 1, 55.00, 3, 1);
            stmtCat.run(10, 1, 120.00, 3, 1);
            stmtCat.run(11, 1, 85.00, 2, 1);
            stmtCat.run(11, 3, 80.00, 2, 1);
            stmtCat.run(12, 3, 120.00, 1, 1);
            stmtCat.finalize(() => {
                console.log('[Supplier Service] Supplier catalog reset complete.');
                res.json({ status: 'success', message: 'Supplier catalog reset complete' });
            });
        });
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'supplier-service', port: PORT });
});

app.listen(PORT, () => {
    console.log(`[Supplier Service] Running on http://localhost:${PORT}`);
});
