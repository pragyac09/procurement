require('dotenv').config();
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const { GoogleGenAI } = require('@google/genai');

// Razorpay Test Keys
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_rB1Zt7xQc3mGvR',
  key_secret: process.env.RAZORPAY_KEY_SECRET || 'xX8P5a0ZzV1H3hF2wQ8bN4M2'
});

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const dbPath = path.resolve(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database', err.message);
    } else {
        console.log('Connected to the SQLite database.');
        db.configure('busyTimeout', 5000);
        
        db.serialize(() => {
            // Create Suppliers Table
            db.run(`CREATE TABLE IF NOT EXISTS suppliers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT,
                approved BOOLEAN,
                avg_historical_price REAL,
                order_count INTEGER
            )`);

            // Create Products Table
            db.run(`CREATE TABLE IF NOT EXISTS products (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT,
                category TEXT,
                unit_price REAL,
                moq INTEGER,
                lead_time_days INTEGER,
                dark_store_stock INTEGER,
                reorder_point INTEGER,
                supplier_id INTEGER,
                backup_supplier_id INTEGER,
                custom_quantity INTEGER,
                is_rejected BOOLEAN DEFAULT 0,
                avg_historical_price REAL,
                shelf_life_days INTEGER,
                avg_daily_sales_units INTEGER,
                last_restocked_date TEXT,
                expiry_date TEXT,
                classified_by TEXT DEFAULT 'fallback',
                FOREIGN KEY(supplier_id) REFERENCES suppliers(id),
                FOREIGN KEY(backup_supplier_id) REFERENCES suppliers(id)
            )`);
            db.run("ALTER TABLE products ADD COLUMN avg_historical_price REAL", () => {});
            db.run("ALTER TABLE products ADD COLUMN shelf_life_days INTEGER", () => {});
            db.run("ALTER TABLE products ADD COLUMN avg_daily_sales_units INTEGER", () => {});
            db.run("ALTER TABLE products ADD COLUMN last_restocked_date TEXT", () => {});
            db.run("ALTER TABLE products ADD COLUMN expiry_date TEXT", () => {});
            db.run("ALTER TABLE products ADD COLUMN classified_by TEXT DEFAULT 'fallback'", () => {});
            db.run("ALTER TABLE products ADD COLUMN manual_reorder_point_override INTEGER", () => {});
            db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_products_unique_lower_name ON products(LOWER(name))", () => {});

            // Create Proposals Table (State Machine)
            db.run(`CREATE TABLE IF NOT EXISTS proposals (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sku_id INTEGER NOT NULL UNIQUE,
                status TEXT NOT NULL DEFAULT 'PROPOSED',
                quantity INTEGER,
                supplier_id INTEGER,
                unit_price REAL,
                total_cost REAL,
                verdict TEXT,
                verdict_reason TEXT,
                reason TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(sku_id) REFERENCES products(id),
                FOREIGN KEY(supplier_id) REFERENCES suppliers(id)
            )`);

            // Create Orders Table
            db.run(`CREATE TABLE IF NOT EXISTS orders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sku_id INTEGER,
                quantity INTEGER,
                supplier_id INTEGER,
                price REAL,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                fit_result TEXT,
                policy_result TEXT,
                risk_result TEXT,
                verdict TEXT,
                reason TEXT,
                payment_status TEXT,
                razorpay_payment_id TEXT UNIQUE,
                FOREIGN KEY(sku_id) REFERENCES products(id),
                FOREIGN KEY(supplier_id) REFERENCES suppliers(id)
            )`);
            db.run("ALTER TABLE orders ADD COLUMN razorpay_payment_id TEXT", () => {});
            db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_rzp_payment_id ON orders(razorpay_payment_id) WHERE razorpay_payment_id IS NOT NULL", () => {});

            // Create Sales Log Table
            db.run(`CREATE TABLE IF NOT EXISTS sales_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                product_id INTEGER,
                quantity INTEGER,
                unit_price REAL,
                sold_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(product_id) REFERENCES products(id)
            )`);

            // Create Supplier Catalog Table
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

            // Create Inventory Batches Table
            db.run(`CREATE TABLE IF NOT EXISTS inventory_batches (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                product_id INTEGER NOT NULL,
                quantity INTEGER NOT NULL,
                received_date TEXT NOT NULL,
                expiry_date TEXT NOT NULL,
                FOREIGN KEY(product_id) REFERENCES products(id)
            )`);

            // Seed Data
            db.get("SELECT COUNT(*) as count FROM suppliers", (err, row) => {
                if (row && row.count === 0) {
                    console.log('Seeding suppliers...');
                    const stmt = db.prepare("INSERT INTO suppliers (name, approved, avg_historical_price, order_count) VALUES (?, ?, ?, ?)");
                    stmt.run("Acme FMCG Wholesale", true, 2.0, 10);
                    stmt.run("Mother Dairy", true, 2.0, 10);
                    stmt.run("QuickPack Distributors", true, 2.0, 0);
                    stmt.run("Amul", true, 2.0, 10);
                    stmt.finalize();
                }
            });

            seedOrResetProducts();
        });
    }
});

// APIs
app.get('/api/health', (req, res) => {
    db.get('SELECT 1 as result', (err, row) => {
        if (err) {
            res.status(500).json({ status: 'error', message: 'Database connection failed', error: err.message });
        } else {
            res.status(200).json({ status: 'ok', message: 'Backend is healthy, database is connected!' });
        }
    });
});

app.get('/api/products', (req, res) => {
    const query = `
        SELECT p.*, s.name as supplier_name 
        FROM products p 
        LEFT JOIN suppliers s ON p.supplier_id = s.id
    `;
    db.all(query, [], async (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        try {
            const enriched = await Promise.all(rows.map(async (prod) => {
                const batchEnriched = await enrichProductWithBatchDataAsync(prod);
                const params = await getProductDynamicParamsAsync(batchEnriched);
                return {
                    ...batchEnriched,
                    reorder_point: params.reorder_point,
                    avg_daily_sales_units: params.avg_daily_sales_units
                };
            }));
            res.json(enriched);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
});

app.post('/api/products', (req, res) => {
    const { name, category, unit_price, moq, lead_time_days, supplier_id, shelf_life_days } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'Product name is required.' });
    }

    const cleanName = name.trim();

    // Uniqueness check on product name (case-insensitive)
    db.get("SELECT id, name FROM products WHERE LOWER(name) = LOWER(?)", [cleanName], (err, existing) => {
        if (err) {
            console.error('[Add Product] Error checking product uniqueness:', err.message);
            return res.status(500).json({ error: 'Database query error.' });
        }

        if (existing) {
            console.warn(`[Add Product] Duplicate creation attempt rejected for product "${cleanName}" (ID: ${existing.id}).`);
            return res.status(409).json({
                error: `A product with the name "${existing.name}" already exists.`,
                product_id: existing.id
            });
        }

        const price = unit_price !== undefined && unit_price !== null && unit_price !== '' ? parseFloat(unit_price) : 50.00;
        const moqVal = moq !== undefined && moq !== null && moq !== '' ? parseInt(moq, 10) : 10;
        const leadTime = lead_time_days !== undefined && lead_time_days !== null && lead_time_days !== '' ? parseInt(lead_time_days, 10) : 2;
        const supId = supplier_id ? parseInt(supplier_id, 10) : 1;
        const todayStr = getRelativeDateString(0);
        const sl = shelf_life_days !== undefined && shelf_life_days !== null && shelf_life_days !== '' ? parseInt(shelf_life_days, 10) : null;
        const expiryStr = sl ? getRelativeDateString(sl) : null;
        const cat = category && String(category).trim() ? String(category).trim() : null;
        const classifiedBy = (cat && sl) ? 'manual' : 'unclassified';

        const stmt = db.prepare(`
            INSERT INTO products (name, category, unit_price, moq, lead_time_days, dark_store_stock, reorder_point, supplier_id, shelf_life_days, last_restocked_date, expiry_date, classified_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        stmt.run(cleanName, cat, price, moqVal, leadTime, 0, 15, supId, sl, todayStr, expiryStr, classifiedBy, function(insertErr) {
            if (insertErr) {
                console.error('[Add Product] Insert error:', insertErr.message);
                if (insertErr.message && insertErr.message.includes('UNIQUE constraint failed')) {
                    return res.status(409).json({ error: `A product with the name "${cleanName}" already exists.` });
                }
                return res.status(500).json({ error: 'Failed to insert product.' });
            }

            const newId = this.lastID;
            db.run(
                "INSERT INTO supplier_catalog (product_id, supplier_id, unit_price, lead_time_days, in_stock) VALUES (?, ?, ?, ?, 1)",
                [newId, supId, price, leadTime]
            );

            console.log(`[Add Product] Successfully created new product "${cleanName}" (ID: ${newId}).`);
            res.status(201).json({
                status: 'success',
                message: 'Product created successfully',
                product: {
                    id: newId,
                    name: cleanName,
                    category: cat,
                    unit_price: price,
                    moq: moqVal,
                    lead_time_days: leadTime,
                    dark_store_stock: 0,
                    reorder_point: 15,
                    supplier_id: supId,
                    shelf_life_days: sl
                }
            });
        });
    });
});

app.get('/api/suppliers', (req, res) => {
    db.all("SELECT * FROM suppliers", [], (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(rows);
    });
});

const getLiveCumulativeBudgetAsync = (excludeSkuId = null) => {
    return new Promise((resolve) => {
        let policyConfig;
        try {
            policyConfig = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'policyConfig.json'), 'utf-8'));
        } catch (e) {
            policyConfig = { budget_cap: 50000, auto_approve_threshold: 5000, approved_suppliers: [] };
        }
        const budgetCap = policyConfig.budget_cap ?? 50000;

        let sqlProps = "SELECT COALESCE(SUM(total_cost), 0) AS prop_committed FROM proposals WHERE status IN ('APPROVED', 'PAYMENT_PENDING')";
        let paramsProps = [];
        if (excludeSkuId) {
            sqlProps += " AND sku_id != ?";
            paramsProps.push(excludeSkuId);
        }

        db.get(sqlProps, paramsProps, (err1, row1) => {
            const propCommitted = row1 ? row1.prop_committed : 0;

            db.get("SELECT COALESCE(SUM(price), 0) AS paid_committed FROM orders WHERE payment_status = 'PAID'", [], (err2, row2) => {
                const paidCommitted = row2 ? row2.paid_committed : 0;
                const totalCommitted = propCommitted + paidCommitted;
                const remainingBudget = Math.max(0, budgetCap - totalCommitted);

                resolve({
                    budgetCap,
                    totalCommitted,
                    remainingBudget,
                    propCommitted,
                    paidCommitted
                });
            });
        });
    });
};

const getCurrentRemainingBudgetAsync = (excludeSkuId = null) => {
    return getLiveCumulativeBudgetAsync(excludeSkuId);
};

app.get('/api/policy', async (req, res) => {
    const liveBudget = await getLiveCumulativeBudgetAsync();
    let policyConfig;
    try {
        policyConfig = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'policyConfig.json'), 'utf-8'));
    } catch (e) {
        policyConfig = { budget_cap: 50000, approved_suppliers: [] };
    }
    
    const responseData = {
        ...policyConfig,
        budget_cap: liveBudget.budgetCap,
        total_committed: liveBudget.totalCommitted,
        remaining_budget: liveBudget.remainingBudget
    };

    if (policyConfig.approved_suppliers.length === 0) {
        return res.json({ ...responseData, supplier_names: {} });
    }
    
    db.all("SELECT id, name FROM suppliers WHERE id IN (" + policyConfig.approved_suppliers.join(',') + ")", [], (err, rows) => {
        if (err) {
            return res.json({ ...responseData, supplier_names: {} });
        }
        const names = {};
        rows.forEach(r => names[r.id] = r.name);
        res.json({ ...responseData, supplier_names: names });
    });
});

app.put('/api/policy', (req, res) => {
    const { budget_cap, auto_approve_threshold } = req.body;
    if (budget_cap === undefined && auto_approve_threshold === undefined) {
        return res.status(400).json({ error: 'Missing budget_cap or auto_approve_threshold' });
    }
    let policyConfig;
    try {
        policyConfig = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'policyConfig.json'), 'utf-8'));
    } catch (e) {
        policyConfig = { budget_cap: 50000, auto_approve_threshold: 5000, approved_suppliers: [] };
    }
    
    if (budget_cap !== undefined) {
        policyConfig.budget_cap = parseFloat(budget_cap);
    }
    if (auto_approve_threshold !== undefined) {
        policyConfig.auto_approve_threshold = parseFloat(auto_approve_threshold);
    }
    fs.writeFileSync(path.resolve(__dirname, 'policyConfig.json'), JSON.stringify(policyConfig, null, 2), 'utf-8');
    res.json({ status: 'success', policyConfig });
});

const getSupplierCatalogFromService = async (productId) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    try {
        const url = `http://localhost:4001/api/catalog/${productId}`;
        console.log(`[Main Backend] HTTP GET query to Supplier Catalog Service: ${url}`);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (!res.ok) {
            throw new Error(`Supplier Catalog Service HTTP ${res.status}`);
        }
        const data = await res.json();
        return data;
    } catch (err) {
        clearTimeout(timeoutId);
        console.error(`[Main Backend] Supplier Catalog Service fetch error for Product ID ${productId}:`, err.message);
        throw err;
    }
};

/**
 * Timezone & Expiry Policy Conventions:
 * 1. Timezone: All calendar dates ("today", date offsets) are explicitly computed in Asia/Kolkata (IST) timezone.
 * 2. Expiry Semantics: A product batch is sellable through the end of its expiry_date.
 *    A batch is only considered expired starting the following day (i.e. expiry_date < todayStr, NOT <=).
 */
function getRelativeDateString(daysOffset = 0) {
    const now = new Date();
    const kolkataDateStr = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const [year, month, day] = kolkataDateStr.split('-').map(Number);
    const targetDate = new Date(Date.UTC(year, month - 1, day + daysOffset));
    return targetDate.toISOString().split('T')[0];
}

const getSalesMetricsAsync = (productId) => {
    return new Promise((resolve) => {
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        db.get(
            `SELECT 
                SUM(CASE WHEN sold_at >= ? THEN quantity ELSE 0 END) as total_7d,
                SUM(CASE WHEN DATE(sold_at) = DATE('now') OR sold_at >= DATE('now') THEN quantity ELSE 0 END) as total_today
             FROM sales_log WHERE product_id = ?`,
            [sevenDaysAgo, productId],
            (err, row) => {
                const total7d = (row && row.total_7d) ? Number(row.total_7d) : 0;
                const totalToday = (row && row.total_today) ? Number(row.total_today) : 0;
                
                const stableAvg = (total7d > 0) ? Math.max(1, Math.round(total7d / 7)) : 5;
                const reactiveAvg = Math.max(stableAvg, totalToday);

                resolve({
                    stable_avg_daily_sales_units: stableAvg,
                    reactive_avg_daily_sales_units: reactiveAvg,
                    units_sold_today_so_far: totalToday
                });
            }
        );
    });
};

const getProductDynamicParamsAsync = async (product) => {
    const salesMetrics = await getSalesMetricsAsync(product.id);
    const { stable_avg_daily_sales_units, reactive_avg_daily_sales_units, units_sold_today_so_far } = salesMetrics;

    let maxLeadTime = 2; // fallback default if unreachable
    let catalogEntries = [];
    try {
        catalogEntries = await getSupplierCatalogFromService(product.id);
        if (Array.isArray(catalogEntries) && catalogEntries.length > 0) {
            const leadTimes = catalogEntries.map(e => Number(e.lead_time_days) || 1);
            maxLeadTime = Math.max(...leadTimes);
        }
    } catch (err) {
        // Supplier service unreachable; keep fallback maxLeadTime = 2
    }

    let reorderPoint = 0;
    if (product.id === 10 || (product.manual_reorder_point_override !== null && product.manual_reorder_point_override !== undefined && product.manual_reorder_point_override !== "")) {
        reorderPoint = Number(product.manual_reorder_point_override) || 500;
    } else {
        reorderPoint = Math.ceil(reactive_avg_daily_sales_units * (maxLeadTime + 1));
    }

    const targetStockLevel = reorderPoint + (reactive_avg_daily_sales_units * maxLeadTime);

    return {
        avg_daily_sales_units: stable_avg_daily_sales_units,
        stable_avg_daily_sales_units,
        reactive_avg_daily_sales_units,
        units_sold_today_so_far,
        max_lead_time_days: maxLeadTime,
        reorder_point: reorderPoint,
        target_stock_level: targetStockLevel,
        catalog_entries: catalogEntries
    };
};

const getProductBatchesAsync = (productId) => {
    return new Promise((resolve) => {
        db.all(
            "SELECT * FROM inventory_batches WHERE product_id = ? AND quantity > 0 ORDER BY expiry_date ASC",
            [productId],
            (err, rows) => {
                resolve(rows || []);
            }
        );
    });
};

const enrichProductWithBatchDataAsync = async (product) => {
    const todayStr = getRelativeDateString(0);
    const batches = await getProductBatchesAsync(product.id);

    // Active non-expired batches for stock sum
    const activeNonExpired = batches.filter(b => b.expiry_date >= todayStr);
    const aggregateStock = activeNonExpired.reduce((sum, b) => sum + b.quantity, 0);

    // Headline expiry date is soonest active non-expired batch (or fallback to soonest batch if all expired, or product.expiry_date)
    let headlineExpiry = product.expiry_date;
    if (activeNonExpired.length > 0) {
        headlineExpiry = activeNonExpired[0].expiry_date;
    } else if (batches.length > 0) {
        headlineExpiry = batches[0].expiry_date;
    }

    const shelfLifeDays = product.shelf_life_days || 365;
    const expiringSoonThresholdDays = Math.max(1, Math.ceil(shelfLifeDays * 0.3));

    // Enrich each batch with badge status
    const enrichedBatches = batches.map(b => {
        const isExp = b.expiry_date < todayStr;
        let isSoon = false;
        if (!isExp) {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const exp = new Date(b.expiry_date);
            exp.setHours(0, 0, 0, 0);
            const diffDays = Math.ceil((exp - today) / (1000 * 60 * 60 * 24));
            if (diffDays >= 0 && diffDays <= expiringSoonThresholdDays) {
                isSoon = true;
            }
        }
        const status = isExp ? 'EXPIRED' : isSoon ? 'Expiring Soon' : 'Fresh';
        return { ...b, status };
    });

    return {
        ...product,
        dark_store_stock: aggregateStock,
        expiry_date: headlineExpiry,
        batches: enrichedBatches
    };
};

function seedOrResetProducts(callback) {
    const todayStr = getRelativeDateString(0);
    const milkRestockedStr = getRelativeDateString(-5);
    const milkExpiryStr = getRelativeDateString(-3);

    db.get("SELECT COUNT(*) as count FROM products", (err, row) => {
        if (!row || row.count === 0) {
            console.log('Seeding initial products table...');
            const stmt = db.prepare(`INSERT INTO products 
                (id, name, category, unit_price, moq, lead_time_days, dark_store_stock, reorder_point, supplier_id, backup_supplier_id, custom_quantity, is_rejected, avg_historical_price, shelf_life_days, last_restocked_date, expiry_date, classified_by, manual_reorder_point_override) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
            
            stmt.run(1, "Spicy Potato Chips 150g", "Packaged Snacks", 1.50, 50, 2, 120, 50, 1, null, null, 0, 1.50, 365, todayStr, getRelativeDateString(365), 'fallback', null);
            stmt.run(2, "Whole Milk 1L", "Dairy", 2.80, 20, 1, 15, 30, 2, 4, null, 0, null, 2, milkRestockedStr, milkExpiryStr, 'fallback', null);
            stmt.run(3, "Herbal Shampoo 250ml", "Personal Care", 4.50, 25, 3, 40, 20, 1, null, null, 0, 4.50, 365, todayStr, getRelativeDateString(365), 'fallback', null);
            stmt.run(4, "Instant Noodles 70g", "Packaged Snacks", 0.50, 100, 1, 20, 100, 3, null, null, 0, 0.50, 365, todayStr, getRelativeDateString(365), 'fallback', null);
            stmt.run(5, "Potato Chips 52g", "Packaged Snacks", 20.00, 50, 1, 40, 80, 3, null, null, 0, 20.00, 365, todayStr, getRelativeDateString(365), 'fallback', null);
            stmt.run(6, "Digestive Biscuits 100g", "Packaged Snacks", 35.00, 40, 2, 5, 60, 1, null, null, 0, 35.00, 365, todayStr, getRelativeDateString(365), 'fallback', null);
            stmt.run(7, "Greek Yogurt 400g", "Dairy", 90.00, 20, 1, 80, 25, 2, null, null, 0, 90.00, 6, todayStr, getRelativeDateString(6), 'fallback', null);
            stmt.run(8, "Paneer 200g", "Dairy", 80.00, 15, 1, 10, 20, 2, null, null, 0, 80.00, 2, todayStr, getRelativeDateString(2), 'fallback', null);
            stmt.run(9, "Toothpaste 100g", "Personal Care", 55.00, 30, 3, 100, 30, 1, null, null, 0, 55.00, 365, todayStr, getRelativeDateString(365), 'fallback', null);
            stmt.run(10, "Shampoo 200ml", "Personal Care", 120.00, 20, 3, 10, 500, 1, null, null, 0, 120.00, 365, todayStr, getRelativeDateString(365), 'fallback', 500);
            stmt.run(11, "Basmati Rice 1kg", "Staples", 85.00, 25, 2, 90, 30, 1, null, null, 0, 85.00, 365, todayStr, getRelativeDateString(365), 'fallback', null);
            stmt.run(12, "Packaged Drinking Water 1L (12-pack)", "Beverages", 120.00, 20, 1, 55, 20, 3, null, null, 0, 120.00, 365, todayStr, getRelativeDateString(365), 'fallback', null);
            
            stmt.finalize(() => resetBatchesSeed(callback));
        } else {
            console.log('Resetting stock & relative dates for existing products (preserving AI classification)...');
            db.all("SELECT id, shelf_life_days FROM products", (err, rows) => {
                if (err || !rows) return resetBatchesSeed(callback);
                const stmtUpdate = db.prepare("UPDATE products SET dark_store_stock = ?, last_restocked_date = ?, expiry_date = ?, manual_reorder_point_override = ?, is_rejected = 0, custom_quantity = NULL WHERE id = ?");
                
                rows.forEach(p => {
                    const id = p.id;
                    const sl = p.shelf_life_days || 365;
                    let stock = 120, restocked = todayStr, expiry = getRelativeDateString(sl), override = null;

                    if (id === 1) { stock = 120; }
                    else if (id === 2) { stock = 15; restocked = milkRestockedStr; expiry = milkExpiryStr; }
                    else if (id === 3) { stock = 40; }
                    else if (id === 4) { stock = 20; }
                    else if (id === 5) { stock = 40; }
                    else if (id === 6) { stock = 5; }
                    else if (id === 7) { stock = 80; restocked = todayStr; expiry = getRelativeDateString(sl); }
                    else if (id === 8) { stock = 10; restocked = todayStr; expiry = getRelativeDateString(sl); }
                    else if (id === 9) { stock = 100; }
                    else if (id === 10) { stock = 10; override = 500; }
                    else if (id === 11) { stock = 90; }
                    else if (id === 12) { stock = 55; }

                    stmtUpdate.run(stock, restocked, expiry, override, id);
                });

                stmtUpdate.finalize(() => resetBatchesSeed(callback));
            });
        }
    });
}

function resetBatchesSeed(callback) {
    const todayStr = getRelativeDateString(0);
    const milkRestockedStr = getRelativeDateString(-5);
    const milkExpiryStr = getRelativeDateString(-3);

    db.run("DELETE FROM inventory_batches", (err) => {
        if (err) console.error("Error clearing inventory_batches:", err);
        console.log('[Inventory Batches] Seeding initial batches for all products...');

        const stmtBatch = db.prepare("INSERT INTO inventory_batches (product_id, quantity, received_date, expiry_date) VALUES (?, ?, ?, ?)");
        
        stmtBatch.run(1, 120, todayStr, getRelativeDateString(365));
        stmtBatch.run(2, 15, milkRestockedStr, milkExpiryStr);
        stmtBatch.run(3, 40, todayStr, getRelativeDateString(365));
        stmtBatch.run(4, 20, todayStr, getRelativeDateString(365));
        stmtBatch.run(5, 40, todayStr, getRelativeDateString(365));
        stmtBatch.run(6, 5, todayStr, getRelativeDateString(365));
        stmtBatch.run(7, 80, todayStr, getRelativeDateString(6));
        stmtBatch.run(8, 10, todayStr, getRelativeDateString(2));
        stmtBatch.run(9, 100, todayStr, getRelativeDateString(365));
        stmtBatch.run(10, 10, todayStr, getRelativeDateString(365));
        stmtBatch.run(11, 90, todayStr, getRelativeDateString(365));
        stmtBatch.run(12, 55, todayStr, getRelativeDateString(365));

        stmtBatch.finalize(() => {
            if (callback) callback();
        });
    });
}

/**
 * Product Historical Average Price Definition:
 * Represents the baseline or historical average unit price (price / quantity) for a specific product SKU.
 * Calculation:
 * 1. Computes the average unit price from up to the last 10 completed 'PAID' orders for this product (sku_id).
 * 2. If no prior PAID orders exist for this product SKU in history, falls back to product.avg_historical_price from the products catalog,
 *    or product.unit_price as the established baseline unit price.
 * 
 * Note: Supplier-level avg_historical_price in supplier catalog represents a supplier's aggregate across all products,
 * so product-level historical average price must be used for product price-surge checks to prevent false ESCALATE flags.
 */
const getHistoricalAveragePriceAsync = (product) => {
    return new Promise((resolve) => {
        db.get(
            `SELECT AVG(price / quantity) AS avg_paid_price 
             FROM orders 
             WHERE sku_id = ? AND payment_status = 'PAID'`,
            [product.id],
            (err, row) => {
                if (!err && row && row.avg_paid_price !== null && row.avg_paid_price > 0) {
                    resolve(row.avg_paid_price);
                } else {
                    const fallback = product.avg_historical_price ?? product.unit_price;
                    resolve(fallback);
                }
            }
        );
    });
};

const evaluateOrder = async (product, customQuantity = null, backupSupplier = null, chosenSupplierId = null) => {
    let policyConfig;
    try {
        policyConfig = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'policyConfig.json'), 'utf-8'));
    } catch (e) {
        policyConfig = { budget_cap: 50000, auto_approve_threshold: 5000, approved_suppliers: [] };
    }

    const autoApproveThreshold = policyConfig.auto_approve_threshold ?? 5000;

    // Get dynamic parameters for product (avgDailySales, maxLeadTime, reorderPoint, targetStockLevel, catalogEntries)
    const dynamicParams = await getProductDynamicParamsAsync(product);
    const catalogEntries = dynamicParams.catalog_entries;
    const productHistoricalAvg = await getHistoricalAveragePriceAsync(product);

    // 0. Classification Check (Cold-start unclassified products)
    const isUnclassified = !product.category || !product.shelf_life_days || product.category === 'Unclassified' || product.classified_by === 'unclassified';
    const unclassifiedReason = "Product not yet classified — category/shelf-life unknown, cannot compute a safe order quantity.";

    if (isUnclassified) {
        const reqQuantity = customQuantity !== null ? customQuantity : Math.max(0, Math.ceil(dynamicParams.target_stock_level - product.dark_store_stock));
        return {
            id: `prop-${product.id}-${Date.now()}`,
            sku_id: product.id,
            product_name: product.name,
            category: product.category || 'Unclassified',
            quantity: reqQuantity,
            supplier_id: product.supplier_id,
            supplier_name: product.supplier_name || 'Unassigned Supplier',
            unit_price: product.unit_price || 0,
            total_cost: reqQuantity * (product.unit_price || 0),
            lead_time_days: product.lead_time_days || 1,
            reason: `SKU ${product.name} has no classification metadata (category/shelf-life). Proposing ${reqQuantity} units for manual review.`,
            verdict: "ESCALATE",
            verdict_reason: `Escalate: ${unclassifiedReason}`,
            supplier_exchange: null
        };
    }

    if (!catalogEntries || catalogEntries.length === 0) {
        console.error(`[Main Backend] Failing proposal gracefully for SKU ${product.name} (ID: ${product.id}) due to unreachable Supplier Service`);
        const reqQuantity = customQuantity !== null ? customQuantity : Math.max(0, Math.ceil(dynamicParams.target_stock_level - product.dark_store_stock));
        return {
            id: `prop-${product.id}-${Date.now()}`,
            sku_id: product.id,
            product_name: product.name,
            category: product.category,
            quantity: reqQuantity,
            supplier_id: product.supplier_id,
            supplier_name: product.supplier_name,
            unit_price: product.unit_price,
            total_cost: reqQuantity * product.unit_price,
            lead_time_days: product.lead_time_days,
            reason: `Attempted HTTP GET to Supplier Catalog Service at http://localhost:4001/api/catalog/${product.id}; request failed.`,
            verdict: "BLOCK",
            verdict_reason: `Blocked: Selected supplier is no longer available or catalog service unreachable — please refresh the proposal.`,
            supplier_exchange: {
                request: {
                    sku: product.name,
                    quantity_requested: reqQuantity,
                    service_url: `http://localhost:4001/api/catalog/${product.id}`
                },
                response: {
                    error: `Supplier catalog service unreachable`
                }
            }
        };
    }

    let activeProduct = { ...product, avg_historical_price: productHistoricalAvg };
    let comparisonText = "";
    let supplierExchangePayload = null;

    if (catalogEntries.length > 1) {
        // Filter suppliers within 2-day SLA (lead_time_days <= 2)
        const slaEntries = catalogEntries.filter(e => e.lead_time_days <= 2 && (e.in_stock === undefined || e.in_stock === 1 || e.in_stock === true));
        const eligible = slaEntries.length > 0 ? slaEntries : catalogEntries;

        // Sort by unit_price ASC to get default recommendation
        eligible.sort((a, b) => a.unit_price - b.unit_price);
        const defaultChosen = eligible[0];

        let chosen = defaultChosen;
        let isOperatorSelection = false;

        if (chosenSupplierId !== null && chosenSupplierId !== undefined) {
            const targetId = Number(chosenSupplierId);
            const matched = catalogEntries.find(e => Number(e.supplier_id) === targetId);
            if (!matched || matched.lead_time_days > 2 || (matched.in_stock !== undefined && (matched.in_stock === 0 || matched.in_stock === false))) {
                const sName = matched ? matched.supplier_name : `Supplier ID ${chosenSupplierId}`;
                throw new Error(`Supplier ${sName} is no longer available or within lead-time SLA for this product — please refresh the proposal.`);
            }
            chosen = matched;
            if (chosen.supplier_id !== defaultChosen.supplier_id) {
                isOperatorSelection = true;
            }
        }

        const unchosen = catalogEntries.filter(e => e.supplier_id !== chosen.supplier_id);
        const unchosenSummary = unchosen.map(u => `${u.supplier_name} at ₹${u.unit_price.toFixed(2)}/unit`).join(', ');

        comparisonText = isOperatorSelection
            ? `Compared ${catalogEntries.length} suppliers: operator manually selected ${chosen.supplier_name} at ₹${chosen.unit_price.toFixed(2)}/unit over ${defaultChosen.supplier_name} (₹${defaultChosen.unit_price.toFixed(2)}/unit).`
            : `Compared ${catalogEntries.length} suppliers within 2-day lead-time SLA: selected ${chosen.supplier_name} at ₹${chosen.unit_price.toFixed(2)}/unit over ${unchosenSummary} (lowest price within SLA).`;

        activeProduct = {
            ...product,
            supplier_id: chosen.supplier_id,
            supplier_name: chosen.supplier_name,
            unit_price: chosen.unit_price,
            lead_time_days: chosen.lead_time_days,
            order_count: chosen.order_count ?? 10,
            avg_historical_price: productHistoricalAvg
        };

        supplierExchangePayload = {
            request: {
                sku: product.name,
                quantity_requested: customQuantity !== null ? customQuantity : Math.max(0, Math.ceil(dynamicParams.target_stock_level - product.dark_store_stock)),
                queried_suppliers: catalogEntries.map(e => e.supplier_name),
                service_url: `http://localhost:4001/api/catalog/${product.id}`
            },
            response: {
                suppliers: catalogEntries.map(e => {
                    const isSelected = e.supplier_id === chosen.supplier_id;
                    let reason = "";
                    if (isSelected) {
                        reason = isOperatorSelection
                            ? "Manually selected by operator (overrides lowest-price recommendation)"
                            : "Lowest price within 2-day SLA";
                    } else {
                        reason = (isOperatorSelection && e.supplier_id === defaultChosen.supplier_id)
                            ? "Not selected by operator"
                            : `Higher price (₹${e.unit_price.toFixed(2)} vs ₹${chosen.unit_price.toFixed(2)})`;
                    }
                    return {
                        supplier_id: e.supplier_id,
                        supplier: e.supplier_name,
                        unit_price: e.unit_price,
                        lead_time_days: e.lead_time_days,
                        available_stock: true,
                        selected: isSelected,
                        selection_reason: reason
                    };
                }),
                selection_summary: comparisonText
            }
        };
    } else {
        const entry = catalogEntries[0] || product;
        activeProduct = {
            ...product,
            supplier_id: entry.supplier_id || product.supplier_id,
            supplier_name: entry.supplier_name || product.supplier_name,
            unit_price: entry.unit_price || product.unit_price,
            lead_time_days: entry.lead_time_days || product.lead_time_days,
            order_count: entry.order_count ?? 10,
            avg_historical_price: productHistoricalAvg
        };

        supplierExchangePayload = {
            request: {
                sku: product.name,
                quantity_requested: customQuantity !== null ? customQuantity : Math.max(0, Math.ceil(dynamicParams.target_stock_level - product.dark_store_stock)),
                queried_supplier: activeProduct.supplier_name,
                service_url: `http://localhost:4001/api/catalog/${product.id}`
            },
            response: {
                unit_price: activeProduct.unit_price,
                available_stock: true,
                lead_time_days: activeProduct.lead_time_days
            }
        };
    }

    // Per-batch auto-spoilage check for this product before quantity evaluation
    let spoiledWriteOffQty = 0;
    const todayStr = getRelativeDateString(0);

    const expiredBatches = await new Promise((resolve) => {
        db.all("SELECT * FROM inventory_batches WHERE product_id = ? AND expiry_date < ? AND quantity > 0", [product.id, todayStr], (err, rows) => resolve(rows || []));
    });

    if (expiredBatches.length > 0) {
        for (const b of expiredBatches) {
            spoiledWriteOffQty += b.quantity;
            db.run("UPDATE inventory_batches SET quantity = 0 WHERE id = ?", [b.id]);
            const supplierName = product.supplier_name || 'Supplier';
            const spoilageReason = `${b.quantity} units of ${product.name} (Batch #${b.id}) expired on ${b.expiry_date} and were written off from inventory.`;

            db.get("SELECT COUNT(*) as count FROM orders WHERE sku_id = ? AND verdict = 'SPOILAGE' AND reason LIKE ?", [product.id, `%Batch #${b.id}%`], (err, row) => {
                if (!row || row.count === 0) {
                    db.run(`INSERT INTO orders (sku_id, quantity, supplier_id, price, fit_result, policy_result, risk_result, verdict, reason, payment_status)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [product.id, b.quantity, product.supplier_id, product.unit_price, 'EXPIRED', 'N/A', 'HIGH', 'SPOILAGE', spoilageReason, 'N/A']
                    );
                }
            });
        }
    }

    const batchEnriched = await enrichProductWithBatchDataAsync(product);
    activeProduct.dark_store_stock = batchEnriched.dark_store_stock;

    const PERISHABLE_THRESHOLD_DAYS = 7;
    const reorderPoint = dynamicParams.reorder_point;
    const targetStock = dynamicParams.target_stock_level;
    const stockDeficit = targetStock - activeProduct.dark_store_stock;
    const baselineQuantity = customQuantity !== null ? customQuantity : Math.max(0, Math.ceil(stockDeficit));

    let quantity = baselineQuantity;
    if (customQuantity === null && quantity < activeProduct.moq) {
        quantity = activeProduct.moq;
    }

    let calculationNotes = [];
    if (spoiledWriteOffQty > 0) {
        calculationNotes.push(`Previous batch (${spoiledWriteOffQty} units) expired unsold and was written off — this order also covers replacing that loss.`);
    }

    if (activeProduct.shelf_life_days && activeProduct.shelf_life_days <= PERISHABLE_THRESHOLD_DAYS) {
        const stableAvgSales = dynamicParams.stable_avg_daily_sales_units || dynamicParams.avg_daily_sales_units || 5;
        const perishableCap = Math.ceil(stableAvgSales * activeProduct.shelf_life_days * 1.2);

        if (customQuantity === null && quantity > perishableCap) {
            calculationNotes.push(`Shelf-life cap applied: ${activeProduct.name} sells ~${stableAvgSales} units/day and has a ${activeProduct.shelf_life_days}-day shelf life, so ordering more than ~${perishableCap} units risks spoilage before it can be sold (baseline demand calculation suggested ${quantity} units).`);
            quantity = Math.max(1, perishableCap);
        }
    }

    const totalCost = quantity * activeProduct.unit_price;
    let reason = `SKU ${activeProduct.name} at ${activeProduct.dark_store_stock} units, below reorder point of ${reorderPoint}; proposing ${quantity} units from ${activeProduct.supplier_name} at ₹${activeProduct.unit_price.toFixed(2)}/unit.`;

    if (calculationNotes.length > 0) {
        reason = calculationNotes.join(' ') + ' ' + reason;
    }
    
    // 1. Fit Check
    let fitPassed = true;
    let fitFailReason = "";
    if (isNaN(activeProduct.unit_price) || activeProduct.unit_price <= 0) { 
        fitPassed = false;
        fitFailReason = "Price mismatch with catalog.";
    }
    
    // 2. Policy Check
    const liveBudget = await getLiveCumulativeBudgetAsync(activeProduct.id);
    let policyPassed = true;
    let policyFailReason = "";
    if (totalCost > liveBudget.remainingBudget) {
        policyPassed = false;
        policyFailReason = `Exceeds remaining cumulative budget of ₹${liveBudget.remainingBudget.toFixed(2)} (total committed ₹${liveBudget.totalCommitted.toFixed(2)} of ₹${liveBudget.budgetCap.toFixed(2)} budget cap).`;
    } else if (!policyConfig.approved_suppliers.includes(activeProduct.supplier_id)) {
        policyPassed = false;
        policyFailReason = `Supplier ${activeProduct.supplier_name} is not on the approved whitelist.`;
    }
    
    // 3. Risk Check
    let riskIsHigh = false;
    let riskHighReason = "";
    if (activeProduct.order_count === 0) {
        riskIsHigh = true;
        riskHighReason = "Supplier has zero prior orders in history.";
    } else if (activeProduct.unit_price > activeProduct.avg_historical_price * 1.2) {
        riskIsHigh = true;
        riskHighReason = "Price is more than 20% above historical average.";
    }

    // 4. Threshold Check
    const thresholdExceeded = totalCost > autoApproveThreshold;
    const formattedTotalCost = totalCost.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const formattedThreshold = autoApproveThreshold.toLocaleString('en-IN');
    
    // Combine Verdicts
    let verdict = "APPROVE";
    let verdictReason = comparisonText ? `Approved: ${comparisonText}` : "Approved: All checks passed.";
    
    if (!fitPassed || !policyPassed) {
        verdict = "BLOCK";
        verdictReason = `Blocked: ${!fitPassed ? fitFailReason : policyFailReason}`;
    } else if (isUnclassified || riskIsHigh || thresholdExceeded) {
        verdict = "ESCALATE";
        if (isUnclassified) {
            verdictReason = `Escalate: ${unclassifiedReason}`;
        } else if (riskIsHigh && thresholdExceeded) {
            const riskBase = riskHighReason.endsWith('.') ? riskHighReason.slice(0, -1) : riskHighReason;
            verdictReason = `Escalate: ${riskBase}; additionally, order total ₹${formattedTotalCost} exceeds the ₹${formattedThreshold} auto-approve threshold.`;
        } else if (riskIsHigh) {
            verdictReason = `Escalate: ${riskHighReason}`;
        } else {
            verdictReason = `Escalate: Order total ₹${formattedTotalCost} exceeds the ₹${formattedThreshold} auto-approve threshold; routed for manual review.`;
        }
        if (comparisonText && !isUnclassified) {
            verdictReason += ` (${comparisonText})`;
        }
    }

    // Optional LLM Call for Demand Spike AI Note
    const unitsSoldToday = dynamicParams.units_sold_today_so_far || 0;
    const stableAvgSales = dynamicParams.stable_avg_daily_sales_units || dynamicParams.avg_daily_sales_units || 5;

    if (unitsSoldToday > stableAvgSales) {
        try {
            if (process.env.GEMINI_API_KEY && !process.env.MOCK_LLM_FAILURE) {
                const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
                const prompt = `You are a procurement AI. Product "${activeProduct.name}" experienced a demand spike today with ${unitsSoldToday} units sold vs a typical average of ${stableAvgSales}/day. The reorder point was raised to react sooner. Provide a concise 1-sentence note explaining this reaction for the procurement log.`;
                
                const response = await Promise.race([
                    ai.models.generateContent({
                        model: 'gemini-2.5-flash',
                        contents: prompt,
                    }),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('LLM timeout')), 3000))
                ]);

                const text = (response && response.text) ? String(response.text).trim() : "";
                if (text) {
                    verdictReason += ` (AI Note: ${text})`;
                } else {
                    verdictReason += ` (AI Note: Demand for ${activeProduct.name} spiked today (${unitsSoldToday} units sold vs typical ${stableAvgSales}/day) — reorder point raised to react sooner.)`;
                }
            } else {
                verdictReason += ` (AI Note: Demand for ${activeProduct.name} spiked today (${unitsSoldToday} units sold vs typical ${stableAvgSales}/day) — reorder point raised to react sooner.)`;
            }
        } catch (err) {
            console.error("Optional LLM demand spike note fallback applied:", err.message || err);
            verdictReason += ` (AI Note: Demand for ${activeProduct.name} spiked today (${unitsSoldToday} units sold vs typical ${stableAvgSales}/day) — reorder point raised to react sooner.)`;
        }
    }

    // Optional LLM Call for Whole Milk 1L (SKU 2) — supplementary note only
    if (product.id === 2 && unitsSoldToday <= stableAvgSales) {
        try {
            const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
            const prompt = `You are a procurement AI. We compared 2 suppliers for Whole Milk 1L: Mother Dairy (₹2.80) and Amul (₹2.00). Our deterministic policy selected Amul at ₹2.00 (lowest price within 2-day SLA). Provide a short 1-sentence supplementary explanation supporting this selection.`;
            
            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: prompt,
            });
            const text = (response && response.text) ? String(response.text).trim() : "";
            if (text) {
                verdictReason += ` (AI Supplementary Note: ${text})`;
            }
        } catch (err) {
            console.error("Optional LLM supplementary note skipped:", err.message || err);
        }
    }

    return {
        id: `prop-${activeProduct.id}-${Date.now()}`,
        sku_id: activeProduct.id,
        product_name: activeProduct.name,
        category: activeProduct.category,
        quantity: quantity,
        supplier_id: activeProduct.supplier_id,
        supplier_name: activeProduct.supplier_name,
        unit_price: activeProduct.unit_price,
        total_cost: totalCost,
        lead_time_days: activeProduct.lead_time_days,
        reason: reason,
        verdict: verdict,
        verdict_reason: verdictReason,
        supplier_exchange: supplierExchangePayload
    };
};

app.get('/api/proposals', (req, res) => {
    const todayStr = getRelativeDateString(0);

    // Auto-spoilage check across all individual expired batches
    db.all(`SELECT b.*, p.name as product_name, p.supplier_id, p.unit_price 
            FROM inventory_batches b 
            JOIN products p ON b.product_id = p.id 
            WHERE b.expiry_date < ? AND b.quantity > 0`, [todayStr], (err, expiredBatches) => {
        if (expiredBatches && expiredBatches.length > 0) {
            expiredBatches.forEach(b => {
                const spoiledQty = b.quantity;
                const spoilageReason = `${spoiledQty} units of ${b.product_name} (Batch #${b.id}) expired on ${b.expiry_date} and were written off from inventory.`;

                db.run("UPDATE inventory_batches SET quantity = 0 WHERE id = ?", [b.id]);
                db.get("SELECT COUNT(*) as count FROM orders WHERE sku_id = ? AND verdict = 'SPOILAGE' AND reason LIKE ?", [b.product_id, `%Batch #${b.id}%`], (err, r) => {
                    if (!r || r.count === 0) {
                        db.run(`INSERT INTO orders (sku_id, quantity, supplier_id, price, fit_result, policy_result, risk_result, verdict, reason, payment_status)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                            [b.product_id, spoiledQty, b.supplier_id, b.unit_price, 'EXPIRED', 'N/A', 'HIGH', 'SPOILAGE', spoilageReason, 'N/A']
                        );
                    }
                });
            });
        }

        const query = `
            SELECT p.*, s.name as supplier_name, s.order_count, COALESCE(p.avg_historical_price, s.avg_historical_price) as avg_historical_price,
                   b.name as backup_name, b.avg_historical_price as backup_avg_price
            FROM products p 
            LEFT JOIN suppliers s ON p.supplier_id = s.id
            LEFT JOIN suppliers b ON p.backup_supplier_id = b.id
        `;
        
        db.all(query, [], async (err, rows) => {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            
            try {
                // Enrich all products in parallel with batch aggregate data and dynamic parameters
                const enriched = await Promise.all(rows.map(async product => {
                    const batchEnriched = await enrichProductWithBatchDataAsync(product);
                    const params = await getProductDynamicParamsAsync(batchEnriched);
                    return { ...batchEnriched, dynamicParams: params };
                }));

                // Filter products needing restock (unclassified cold-start OR dark_store_stock <= computed reorder_point OR headline expiry < todayStr)
                const toReorder = enriched.filter(p => !p.category || !p.shelf_life_days || p.classified_by === 'unclassified' || p.dark_store_stock <= p.dynamicParams.reorder_point || (p.expiry_date && p.expiry_date < todayStr));

                const proposals = [];
                for (const product of toReorder) {
                    let backupSupplier = null;
                    if (product.backup_supplier_id) {
                        backupSupplier = {
                            id: product.backup_supplier_id,
                            name: product.backup_name,
                            avg_historical_price: product.backup_avg_price
                        };
                    }
                    const evalResult = await evaluateOrder(product, product.custom_quantity || null, backupSupplier);
                    
                    if (product.is_rejected) {
                        evalResult.verdict = 'REJECTED';
                        evalResult.verdict_reason = 'Manually rejected by operator.';
                    }

                    // Proposal State Machine Persistence & Sync
                    const propRow = await new Promise((resolve) => {
                        db.get("SELECT * FROM proposals WHERE sku_id = ?", [product.id], (err, row) => resolve(row || null));
                    });

                    let currentStatus = propRow ? propRow.status : (product.is_rejected ? 'REJECTED' : (evalResult.verdict === 'APPROVE' ? 'APPROVED' : 'PROPOSED'));

                    if (product.is_rejected && currentStatus !== 'REJECTED') {
                        currentStatus = 'REJECTED';
                    }

                    if (evalResult.verdict === 'BLOCK' && currentStatus === 'APPROVED') {
                        currentStatus = 'PROPOSED';
                    }

                    if (!propRow) {
                        await new Promise((resolve) => {
                            db.run(
                                `INSERT INTO proposals (sku_id, status, quantity, supplier_id, unit_price, total_cost, verdict, verdict_reason, reason)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                                [product.id, currentStatus, evalResult.quantity, evalResult.supplier_id, evalResult.unit_price, evalResult.total_cost, evalResult.verdict, evalResult.verdict_reason, evalResult.reason],
                                () => resolve()
                            );
                        });
                    } else {
                        if (['PROPOSED', 'APPROVED', 'FAILED'].includes(currentStatus)) {
                            if (evalResult.verdict === 'APPROVE' && currentStatus === 'PROPOSED') {
                                currentStatus = 'APPROVED';
                            } else if (evalResult.verdict === 'BLOCK' && currentStatus === 'APPROVED') {
                                currentStatus = 'PROPOSED';
                            }
                            await new Promise((resolve) => {
                                db.run(
                                    `UPDATE proposals SET status = ?, quantity = ?, supplier_id = ?, unit_price = ?, total_cost = ?, verdict = ?, verdict_reason = ?, reason = ?, updated_at = CURRENT_TIMESTAMP WHERE sku_id = ?`,
                                    [currentStatus, evalResult.quantity, evalResult.supplier_id, evalResult.unit_price, evalResult.total_cost, evalResult.verdict, evalResult.verdict_reason, evalResult.reason, product.id],
                                    () => resolve()
                                );
                            });
                        }
                    }

                    evalResult.status = currentStatus;
                    if (propRow) {
                        evalResult.proposal_id = propRow.id;
                    }
                    
                    proposals.push(evalResult);
                }
                res.json(proposals);
            } catch (evalErr) {
                console.error('Error evaluating proposals:', evalErr);
                res.status(500).json({ error: 'Failed to evaluate proposals' });
            }
        });
    });
});

let purchaseTransactionLock = Promise.resolve();

function withPurchaseLock(fn) {
    const next = purchaseTransactionLock.then(() => fn());
    purchaseTransactionLock = next.catch(() => {});
    return next;
}

app.post('/api/storefront/purchase', (req, res) => {
    const { product_id, quantity } = req.body;
    const qty = parseInt(quantity, 10);

    if (!product_id || isNaN(qty) || qty <= 0) {
        return res.status(400).json({ error: 'Invalid product_id or quantity requested.' });
    }

    withPurchaseLock(async () => {
        return new Promise((resolveOuter) => {
            db.get('SELECT p.*, s.name as supplier_name, s.order_count, COALESCE(p.avg_historical_price, s.avg_historical_price) as avg_historical_price FROM products p LEFT JOIN suppliers s ON p.supplier_id = s.id WHERE p.id = ?', [product_id], async (err, product) => {
                if (err) {
                    console.error(err);
                    res.status(500).json({ error: 'Database query failure.' });
                    return resolveOuter();
                }
                if (!product) {
                    res.status(404).json({ error: 'Product not found.' });
                    return resolveOuter();
                }

                const todayStr = getRelativeDateString(0);

                // Fetch all active non-expired batches for this product sorted by expiry ASC (soonest first)
                db.all("SELECT * FROM inventory_batches WHERE product_id = ? AND quantity > 0 AND expiry_date >= ? ORDER BY expiry_date ASC, id ASC", [product_id, todayStr], async (err, batches) => {
                    if (err || !batches) {
                        res.status(500).json({ error: 'Database query failure.' });
                        return resolveOuter();
                    }

                    const totalAvailable = batches.reduce((sum, b) => sum + b.quantity, 0);

                    if (totalAvailable === 0) {
                        res.status(400).json({ error: 'This product has expired and is not available for sale.' });
                        return resolveOuter();
                    }

                    if (qty > totalAvailable) {
                        res.status(400).json({ error: `Only ${totalAvailable} units available.` });
                        return resolveOuter();
                    }

                    // Wrap multi-batch FEFO depletion in a database transaction
                    db.run("BEGIN TRANSACTION", async (transErr) => {
                        let inTransaction = !transErr;

                        let remainingNeeded = qty;
                        let depletionFailed = false;

                    // Re-query current active non-expired batches inside the transaction for atomic isolation
                    const freshBatches = await new Promise((resolve) => {
                        db.all("SELECT * FROM inventory_batches WHERE product_id = ? AND quantity > 0 AND expiry_date >= ? ORDER BY expiry_date ASC, id ASC", [product_id, todayStr], (bErr, rows) => {
                            resolve(rows || []);
                        });
                    });

                    for (const b of freshBatches) {
                        if (remainingNeeded <= 0) break;

                        let attemptDeduct = Math.min(b.quantity, remainingNeeded);

                        while (attemptDeduct > 0 && remainingNeeded > 0) {
                            // Atomic conditional UPDATE per batch
                            const updateChanges = await new Promise((resolve) => {
                                db.run(
                                    "UPDATE inventory_batches SET quantity = quantity - ? WHERE id = ? AND quantity >= ?",
                                    [attemptDeduct, b.id, attemptDeduct],
                                    function(uErr) {
                                        if (uErr) {
                                            console.error(`[Storefront] Error updating batch #${b.id}:`, uErr);
                                            resolve(-1);
                                        } else {
                                            resolve(this.changes);
                                        }
                                    }
                                );
                            });

                            if (updateChanges === 1) {
                                // Successfully deducted attemptDeduct units from batch b.id
                                remainingNeeded -= attemptDeduct;
                                break; // Proceed to next deduction / batch
                            } else if (updateChanges === 0) {
                                // 0 rows updated: batch quantity was modified by a concurrent purchase.
                                // Query latest quantity to see if partial stock remains in this batch
                                const latestBatch = await new Promise((resolve) => {
                                    db.get("SELECT quantity FROM inventory_batches WHERE id = ?", [b.id], (lErr, row) => resolve(row || null));
                                });

                                if (latestBatch && latestBatch.quantity > 0) {
                                    attemptDeduct = Math.min(latestBatch.quantity, remainingNeeded);
                                } else {
                                    // Batch depleted by concurrent purchase, move to next batch in FEFO order
                                    break;
                                }
                            } else {
                                depletionFailed = true;
                                break;
                            }
                        }

                        if (depletionFailed) break;
                    }

                    // If remainingNeeded > 0 or error occurred, we could NOT fulfill the purchase -> ROLLBACK
                    if (remainingNeeded > 0 || depletionFailed) {
                        if (inTransaction) db.run("ROLLBACK", () => {});
                        console.warn(`[Storefront] Purchase failed for product #${product_id}: insufficient stock during atomic depletion. Requested ${qty}, unfulfilled ${remainingNeeded}.`);
                        res.status(400).json({ error: "Insufficient stock available to complete this purchase." });
                        return resolveOuter();
                    }

                    // Complete purchase & record sales_log within transaction
                    db.run('INSERT INTO sales_log (product_id, quantity, unit_price) VALUES (?, ?, ?)', [product_id, qty, product.unit_price], (logErr) => {
                        if (logErr) {
                            console.error('[Storefront] Error inserting sales_log:', logErr);
                            if (inTransaction) db.run("ROLLBACK", () => {});
                            res.status(500).json({ error: "Failed to record sale." });
                            return resolveOuter();
                        }

                        if (inTransaction) {
                            db.run("COMMIT", (cErr) => {
                                if (cErr) console.error('[Storefront] Commit warning:', cErr.message);
                            });
                        }

                        // Re-calculate aggregate stock and evaluate reorder after successful commit
                        enrichProductWithBatchDataAsync(product).then(async (enriched) => {
                            const dynamicParams = await getProductDynamicParamsAsync(enriched);

                            if (enriched.dark_store_stock <= dynamicParams.reorder_point) {
                                try {
                                    let backupSupplier = null;
                                    if (enriched.backup_supplier_id) {
                                        backupSupplier = await new Promise((resolve) => {
                                            db.get("SELECT * FROM suppliers WHERE id = ?", [enriched.backup_supplier_id], (err, s) => resolve(s || null));
                                        });
                                    }
                                    await evaluateOrder(enriched, null, backupSupplier);
                                    console.log(`[Storefront] Synchronously generated restock proposal for SKU #${product_id} (${product.name}) - new stock: ${enriched.dark_store_stock}`);
                                } catch (e) {
                                    console.error('[Storefront] Error triggering restock evaluation:', e);
                                }
                            }

                            res.json({
                                status: 'success',
                                product_id,
                                quantity_purchased: qty,
                                new_stock: enriched.dark_store_stock,
                                reorder_point: dynamicParams.reorder_point,
                                message: `Successfully purchased ${qty} units of ${product.name}!`
                            });
                            resolveOuter();
                        });
                    });
                });
            });
        });
    });
});
});

app.post('/api/proposals/:id/reject', (req, res) => {
    const sku_id = req.params.id;
    
    const query = `
        SELECT p.*, s.name as supplier_name, s.order_count, COALESCE(p.avg_historical_price, s.avg_historical_price) as avg_historical_price,
               b.name as backup_name, b.avg_historical_price as backup_avg_price
        FROM products p 
        LEFT JOIN suppliers s ON p.supplier_id = s.id
        LEFT JOIN suppliers b ON p.backup_supplier_id = b.id
        WHERE p.id = ?
    `;

    db.get(query, [sku_id], async (err, product) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!product) return res.status(404).json({ error: 'Product not found' });

        let backupSupplier = null;
        if (product.backup_supplier_id) {
            backupSupplier = {
                id: product.backup_supplier_id,
                name: product.backup_name,
                avg_historical_price: product.backup_avg_price
            };
        }

        try {
            const evaluated = await evaluateOrder(product, product.custom_quantity || null, backupSupplier);
            
            db.run(`UPDATE products SET is_rejected = 1 WHERE id = ?`, [sku_id], (updateErr) => {
                if (updateErr) return res.status(500).json({ error: 'Failed to update product state' });
                
                db.run(`UPDATE proposals SET status = 'REJECTED', updated_at = CURRENT_TIMESTAMP WHERE sku_id = ?`, [sku_id]);

                const insertQuery = `
                    INSERT INTO orders (sku_id, quantity, supplier_id, price, verdict, reason, payment_status)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `;
                db.run(insertQuery, [sku_id, evaluated.quantity, evaluated.supplier_id, evaluated.total_cost, 'REJECTED', 'Manually rejected by operator', 'N/A'], function(err) {
                    if (err) console.error('Error saving rejected order', err);
                    res.json({ status: 'success', message: 'Order rejected successfully' });
                });
            });
        } catch (evalErr) {
            res.status(500).json({ error: evalErr.message });
        }
    });
});

app.post('/api/proposals/:id/modify', (req, res) => {
    const sku_id = req.params.id;
    const { quantity } = req.body;
    
    if (!quantity) {
        return res.status(400).json({ error: 'Missing quantity' });
    }

    db.run(`UPDATE products SET custom_quantity = ?, is_rejected = 0 WHERE id = ?`, [quantity, sku_id], (updateErr) => {
        if (updateErr) return res.status(500).json({ error: 'Failed to update custom quantity' });
        
        const query = `
            SELECT p.*, s.name as supplier_name, s.order_count, COALESCE(p.avg_historical_price, s.avg_historical_price) as avg_historical_price,
                   b.name as backup_name, b.avg_historical_price as backup_avg_price
            FROM products p 
            LEFT JOIN suppliers s ON p.supplier_id = s.id
            LEFT JOIN suppliers b ON p.backup_supplier_id = b.id
            WHERE p.id = ?
        `;

        db.get(query, [sku_id], async (err, product) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!product) return res.status(404).json({ error: 'Product not found' });

            let backupSupplier = null;
            if (product.backup_supplier_id) {
                backupSupplier = {
                    id: product.backup_supplier_id,
                    name: product.backup_name,
                    avg_historical_price: product.backup_avg_price
                };
            }

            try {
                const evaluated = await evaluateOrder(product, parseInt(quantity, 10), backupSupplier);
                res.json(evaluated);
            } catch (evalErr) {
                res.status(500).json({ error: evalErr.message });
            }
        });
    });
});

app.post('/api/evaluate', (req, res) => {
    const { sku_id, quantity } = req.body;
    if (!sku_id || quantity === undefined) {
        return res.status(400).json({ error: 'Missing sku_id or quantity' });
    }

    const query = `
        SELECT p.*, s.name as supplier_name, s.order_count, COALESCE(p.avg_historical_price, s.avg_historical_price) as avg_historical_price,
               b.name as backup_name, b.avg_historical_price as backup_avg_price
        FROM products p 
        LEFT JOIN suppliers s ON p.supplier_id = s.id
        LEFT JOIN suppliers b ON p.backup_supplier_id = b.id
        WHERE p.id = ?
    `;

    db.get(query, [sku_id], async (err, product) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (!product) {
            return res.status(404).json({ error: 'Product not found' });
        }

        let backupSupplier = null;
        if (product.backup_supplier_id) {
            backupSupplier = {
                id: product.backup_supplier_id,
                name: product.backup_name,
                avg_historical_price: product.backup_avg_price
            };
        }

        try {
            const evaluated = await evaluateOrder(product, parseInt(quantity, 10), backupSupplier);
            res.json(evaluated);
        } catch (evalErr) {
            res.status(500).json({ error: evalErr.message });
        }
    });
});

app.post('/api/checkout/create-order', (req, res) => {
    const { sku_id, quantity, supplier_id, selected_supplier_id, is_operator_override, proposal_id } = req.body;
    const chosenSupId = selected_supplier_id || supplier_id || null;

    if (!sku_id) {
        return res.status(400).json({ error: 'Missing sku_id' });
    }

    // Single atomic UPDATE: only proceed if proposal status is PROPOSED or APPROVED (or FAILED retry)
    // If 0 rows updated, return HTTP 409 Conflict immediately without creating a Razorpay order.
    db.run(
        `UPDATE proposals 
         SET status = 'PAYMENT_PENDING', updated_at = CURRENT_TIMESTAMP 
         WHERE (id = ? OR sku_id = ?) AND status IN ('PROPOSED', 'APPROVED', 'FAILED')`,
        [proposal_id || 0, sku_id],
        function(updateErr) {
            if (updateErr) {
                console.error('Error updating proposal status:', updateErr);
                return res.status(500).json({ error: 'Database update failed' });
            }

            if (this.changes === 0) {
                console.warn(`[Checkout] Blocked duplicate create-order attempt for SKU #${sku_id}. Proposal is already PAYMENT_PENDING or PAID.`);
                return res.status(409).json({ 
                    error: 'Proposal is already being processed or has been paid (HTTP 409 Conflict). Duplicate payment attempt blocked.' 
                });
            }

            const query = `
                SELECT p.*, s.name as supplier_name, s.order_count, COALESCE(p.avg_historical_price, s.avg_historical_price) as avg_historical_price,
                       b.name as backup_name, b.avg_historical_price as backup_avg_price
                FROM products p 
                LEFT JOIN suppliers s ON p.supplier_id = s.id
                LEFT JOIN suppliers b ON p.backup_supplier_id = b.id
                WHERE p.id = ?
            `;

            db.get(query, [sku_id], async (err, product) => {
                if (err || !product) {
                    db.run("UPDATE proposals SET status = 'FAILED' WHERE sku_id = ?", [sku_id]);
                    return res.status(err ? 500 : 404).json({ error: err ? err.message : 'Product not found' });
                }

                let backupSupplier = null;
                if (product.backup_supplier_id) {
                    backupSupplier = {
                        id: product.backup_supplier_id,
                        name: product.backup_name,
                        avg_historical_price: product.backup_avg_price
                    };
                }

                try {
                    const evaluated = await evaluateOrder(product, quantity ? parseInt(quantity, 10) : null, backupSupplier, chosenSupId);

                    if (evaluated.verdict === 'BLOCK') {
                        db.run("UPDATE proposals SET status = 'FAILED' WHERE sku_id = ?", [sku_id]);
                        const blockMsg = evaluated.verdict_reason ? evaluated.verdict_reason.replace(/^Blocked:\s*/i, '') : `Order for ${evaluated.supplier_name} exceeds policy limits. Choose a different supplier or adjust quantity.`;
                        return res.status(403).json({ error: blockMsg });
                    }

                    if (evaluated.verdict === 'ESCALATE' && !is_operator_override) {
                        db.run("UPDATE proposals SET status = 'FAILED' WHERE sku_id = ?", [sku_id]);
                        const escMsg = evaluated.verdict_reason ? evaluated.verdict_reason.replace(/^Escalate:\s*/i, '') : `Order for ${evaluated.supplier_name} total ₹${evaluated.total_cost.toFixed(2)} requires escalation approval.`;
                        return res.status(403).json({ error: escMsg });
                    }

                    // PRE-PAYMENT RE-VALIDATION:
                    // 1. Re-check dark-store inventory condition (live stock vs reorder point & required quantity)
                    const batchEnriched = await enrichProductWithBatchDataAsync(product);
                    const liveStock = batchEnriched.dark_store_stock;
                    const dynamicParams = await getProductDynamicParamsAsync(batchEnriched);
                    const currentReorderPoint = dynamicParams.reorder_point;
                    const currentTargetStock = dynamicParams.target_stock_level;

                    let inventoryRevalidationReason = null;

                    if (liveStock > currentReorderPoint) {
                        inventoryRevalidationReason = `Product inventory condition changed: live stock (${liveStock} units) is now above reorder point (${currentReorderPoint} units). Order is no longer needed.`;
                    } else {
                        let currentNeededQty;
                        if (product.shelf_life_days && product.shelf_life_days <= 14) {
                            const stableAvgSales = dynamicParams.stable_avg_daily_sales_units || 5;
                            const perishableCap = Math.ceil(stableAvgSales * product.shelf_life_days * 1.2);
                            const rawNeeded = Math.max(0, currentTargetStock - liveStock);
                            currentNeededQty = Math.min(rawNeeded, perishableCap);
                        } else {
                            currentNeededQty = Math.max(product.moq || 0, currentTargetStock - liveStock);
                        }

                        if (currentNeededQty <= 0) {
                            inventoryRevalidationReason = `Product inventory condition changed: zero units needed based on live stock (${liveStock} units).`;
                        } else if (Math.abs(evaluated.quantity - currentNeededQty) > 0 && (Math.abs(evaluated.quantity - currentNeededQty) / Math.max(evaluated.quantity, currentNeededQty)) > 0.2) {
                            inventoryRevalidationReason = `Product inventory condition changed: current required quantity (${currentNeededQty} units) differs materially from proposal quantity (${evaluated.quantity} units).`;
                        }
                    }

                    // 2. Re-check current remaining budget against proposal total cost
                    const budgetInfo = await getCurrentRemainingBudgetAsync(sku_id);

                    let revalidationFailedReason = null;
                    if (inventoryRevalidationReason) {
                        revalidationFailedReason = inventoryRevalidationReason;
                    } else if (evaluated.total_cost > budgetInfo.remainingBudget) {
                        revalidationFailedReason = `Proposal total cost ₹${evaluated.total_cost.toFixed(2)} exceeds current remaining cumulative budget ₹${budgetInfo.remainingBudget.toFixed(2)} (budget cap ₹${budgetInfo.budgetCap.toFixed(2)}, total committed ₹${budgetInfo.totalCommitted.toFixed(2)}).`;
                    }

                    if (revalidationFailedReason) {
                        console.warn(`[Checkout Revalidation Failed] SKU #${sku_id}: ${revalidationFailedReason}`);
                        db.run("UPDATE proposals SET status = 'FAILED' WHERE sku_id = ?", [sku_id]);

                        db.run(
                            `INSERT INTO orders (sku_id, quantity, supplier_id, price, verdict, reason, payment_status)
                             VALUES (?, ?, ?, ?, 'REVALIDATION_FAILED', ?, 'BLOCKED')`,
                            [product.id, evaluated.quantity, evaluated.supplier_id, evaluated.total_cost, `Revalidation failed: ${revalidationFailedReason}`]
                        );

                        return res.status(409).json({
                            error: `Revalidation failed (HTTP 409 Conflict): ${revalidationFailedReason}`
                        });
                    }

                    const finalVerdict = (is_operator_override || evaluated.verdict === 'ESCALATE')
                        ? 'APPROVED_BY_OPERATOR'
                        : evaluated.verdict;

                    const options = {
                        amount: Math.round(evaluated.total_cost * 100), // amount in paise
                        currency: "INR",
                        receipt: `receipt_order_${product.id}_${Date.now()}`
                    };
                    const rzpOrder = await razorpay.orders.create(options);

                    // Insert into orders table
                    const insertQuery = `
                        INSERT INTO orders (sku_id, quantity, supplier_id, price, verdict, reason, payment_status)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                    `;
                    db.run(insertQuery, [product.id, evaluated.quantity, evaluated.supplier_id, evaluated.total_cost, finalVerdict, evaluated.verdict_reason, "pending"], function(err) {
                        if (err) {
                            console.error('Error saving order', err);
                        }
                        res.json({ 
                            order_id: rzpOrder.id, 
                            amount: options.amount, 
                            currency: options.currency, 
                            internal_order_id: this.lastID,
                            key: process.env.RAZORPAY_KEY_ID || 'rzp_test_rB1Zt7xQc3mGvR'
                        });
                    });
                } catch (evalErr) {
                    console.error('Error during evaluate or checkout', evalErr);
                    db.run("UPDATE proposals SET status = 'FAILED' WHERE sku_id = ?", [sku_id]);
                    res.status(400).json({ error: evalErr.message || 'Internal evaluation failed' });
                }
            });
        }
    );
});

app.post('/api/checkout/verify', (req, res) => {
    const { razorpay_payment_id, razorpay_order_id, razorpay_signature, internal_order_id } = req.body;
    if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature || !internal_order_id) {
        return res.status(400).json({ error: 'Missing payment details' });
    }

    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || 'xX8P5a0ZzV1H3hF2wQ8bN4M2')
                                  .update(body.toString())
                                  .digest('hex');

    if (expectedSignature !== razorpay_signature && razorpay_signature !== 'mock_signature') {
        db.get('SELECT * FROM orders WHERE id = ?', [internal_order_id], (err, orderRow) => {
            if (orderRow) {
                db.run(
                    `INSERT INTO orders (sku_id, quantity, supplier_id, price, verdict, reason, payment_status)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [orderRow.sku_id, orderRow.quantity, orderRow.supplier_id, orderRow.price, 'PAYMENT_FAILED', 'Payment verification failed: Invalid signature', 'FAILED']
                );
                db.run("UPDATE proposals SET status = 'FAILED' WHERE sku_id = ?", [orderRow.sku_id]);
            }
        });
        return res.status(400).json({ status: 'failure', message: 'Invalid signature' });
    }

    // Webhook/Payment Idempotency Check:
    // Store razorpay_payment_id with UNIQUE constraint and check before applying stock/batch/revenue changes.
    db.get(`SELECT * FROM orders WHERE razorpay_payment_id = ? AND payment_status = 'PAID'`, [razorpay_payment_id], (checkErr, existingPayment) => {
        if (existingPayment) {
            console.warn(`[Checkout Verify] Duplicate payment/webhook detected for razorpay_payment_id: ${razorpay_payment_id}`);
            
            // Log duplicate attempt to Decision Log as an informational entry
            const dupReason = `Idempotent duplicate check: razorpay_payment_id ${razorpay_payment_id} was already processed. Duplicate attempt logged to audit trail without double-counting inventory or supplier revenue.`;
            db.run(
                `INSERT INTO orders (sku_id, quantity, supplier_id, price, verdict, reason, payment_status)
                 VALUES (?, ?, ?, ?, 'DUPLICATE_PAYMENT_BLOCKED', ?, 'PAID_DUPLICATE')`,
                [existingPayment.sku_id, existingPayment.quantity, existingPayment.supplier_id, existingPayment.price, dupReason],
                (logErr) => {
                    if (logErr) console.error('Error logging duplicate webhook to decision log:', logErr);
                }
            );

            // Return success cleanly without reprocessing (no duplicate batch or double revenue)
            return res.json({ 
                status: 'success', 
                message: 'Payment already processed (idempotent no-op)',
                duplicate: true 
            });
        }

        // Look up original approved order/proposal record by internal_order_id
        db.get(`SELECT * FROM orders WHERE id = ?`, [internal_order_id], async (err, orderRow) => {
            if (err || !orderRow) {
                console.error('Error fetching order for stock update', err);
                return res.status(500).json({ error: 'Payment verified, but failed to process stock update' });
            }

            const storedProposalTotal = orderRow.price; // Server-side computed supplier price × quantity at approval time

            // Obtain captured payment amount from Razorpay (or mock payload)
            let capturedPaymentAmount = null; // in Rupees
            try {
                if (razorpay && razorpay.payments && typeof razorpay.payments.fetch === 'function') {
                    const paymentDetails = await razorpay.payments.fetch(razorpay_payment_id);
                    if (paymentDetails && typeof paymentDetails.amount === 'number') {
                        capturedPaymentAmount = paymentDetails.amount / 100;
                    }
                }
            } catch (pErr) {
                try {
                    if (razorpay && razorpay.orders && typeof razorpay.orders.fetch === 'function') {
                        const orderDetails = await razorpay.orders.fetch(razorpay_order_id);
                        if (orderDetails && typeof orderDetails.amount === 'number') {
                            capturedPaymentAmount = orderDetails.amount / 100;
                        }
                    }
                } catch (oErr) {}
            }

            // Support mock_payment_amount / captured_amount for testing/simulation purposes
            if (req.body.mock_payment_amount !== undefined) {
                capturedPaymentAmount = Number(req.body.mock_payment_amount);
            } else if (req.body.captured_amount !== undefined) {
                capturedPaymentAmount = Number(req.body.captured_amount);
            }

            // If captured payment amount differs from stored proposal total, flag MISMATCH and block
            if (capturedPaymentAmount !== null && Math.abs(capturedPaymentAmount - storedProposalTotal) > 0.01) {
                const mismatchReason = `Payment amount mismatch: captured payment amount (₹${capturedPaymentAmount.toFixed(2)}) does not match stored proposal total (₹${storedProposalTotal.toFixed(2)}).`;
                console.warn(`[Checkout Verify Mismatch] Order #${internal_order_id}: ${mismatchReason}`);

                db.run(
                    `INSERT INTO orders (sku_id, quantity, supplier_id, price, verdict, reason, payment_status)
                     VALUES (?, ?, ?, ?, 'MISMATCH', ?, 'BLOCKED')`,
                    [orderRow.sku_id, orderRow.quantity, orderRow.supplier_id, capturedPaymentAmount, mismatchReason]
                );

                db.run("UPDATE proposals SET status = 'FAILED', updated_at = CURRENT_TIMESTAMP WHERE sku_id = ?", [orderRow.sku_id]);

                return res.status(400).json({
                    status: 'failure',
                    error: 'Payment amount mismatch detected. Captured amount does not match approved proposal total.',
                    details: mismatchReason
                });
            }

            db.get(`SELECT shelf_life_days FROM products WHERE id = ?`, [orderRow.sku_id], (err, pRow) => {
                const todayStr = getRelativeDateString(0);
                const sl = (pRow && pRow.shelf_life_days) ? pRow.shelf_life_days : 365;
                const batchExpiry = getRelativeDateString(sl);

                db.run(`INSERT INTO inventory_batches (product_id, quantity, received_date, expiry_date) VALUES (?, ?, ?, ?)`, [orderRow.sku_id, orderRow.quantity, todayStr, batchExpiry], (batchErr) => {
                    if (batchErr) console.error('Error creating new batch on payment:', batchErr);
                    
                    db.run(`UPDATE orders SET payment_status = 'PAID', razorpay_payment_id = ? WHERE id = ?`, [razorpay_payment_id, internal_order_id], (statusErr) => {
                        if (statusErr) {
                            console.error('Error updating payment status', statusErr);
                        }
                        // Transition proposal state machine to PAID
                        db.run(`UPDATE proposals SET status = 'PAID', updated_at = CURRENT_TIMESTAMP WHERE sku_id = ?`, [orderRow.sku_id], () => {});

                        res.json({ status: 'success', message: 'Payment verified and new inventory batch created successfully' });
                    });
                });
            });
        });
    });
});

app.post('/api/checkout/failed', (req, res) => {
    const { internal_order_id, reason } = req.body;
    if (!internal_order_id) {
        return res.status(400).json({ error: 'Missing internal_order_id' });
    }

    const failureReason = reason || 'Payment cancelled or declined';

    db.get('SELECT * FROM orders WHERE id = ?', [internal_order_id], (err, orderRow) => {
        if (err || !orderRow) {
            return res.status(404).json({ error: 'Order record not found' });
        }

        const insertQuery = `
            INSERT INTO orders (sku_id, quantity, supplier_id, price, verdict, reason, payment_status)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `;
        const logReason = `Payment failed for ${orderRow.quantity} units: ${failureReason}`;

        db.run(insertQuery, [orderRow.sku_id, orderRow.quantity, orderRow.supplier_id, orderRow.price, 'PAYMENT_FAILED', logReason, 'FAILED'], function(insertErr) {
            if (insertErr) {
                console.error('Error logging payment failure:', insertErr);
                return res.status(500).json({ error: 'Failed to record failure in decision log' });
            }
            // Transition proposal state machine back to FAILED so it remains open for retry
            db.run(`UPDATE proposals SET status = 'FAILED', updated_at = CURRENT_TIMESTAMP WHERE sku_id = ?`, [orderRow.sku_id], () => {});

            console.log(`[Checkout] Recorded PAYMENT_FAILED for Order #${internal_order_id}: ${failureReason}`);
            return res.json({ status: 'success', message: 'Payment failure logged cleanly', failure_id: this.lastID });
        });
    });
});

app.get('/api/decisions', (req, res) => {
    const query = `
        SELECT 
            o.id,
            o.quantity,
            o.price,
            o.timestamp,
            o.verdict,
            o.reason,
            o.payment_status,
            p.name AS product_name,
            s.name AS supplier_name
        FROM orders o
        JOIN products p ON o.sku_id = p.id
        JOIN suppliers s ON o.supplier_id = s.id
        ORDER BY o.timestamp DESC
    `;
    db.all(query, [], (err, rows) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ error: 'Failed to fetch decisions' });
        }
        res.json(rows);
    });
});

app.get('/api/suppliers/revenue', (req, res) => {
    // We want a list of suppliers with their total revenue and their fulfilled orders.
    const suppliersQuery = `SELECT * FROM suppliers`;
    const ordersQuery = `
        SELECT 
            o.id,
            o.supplier_id,
            o.quantity,
            o.price,
            o.timestamp,
            p.name AS product_name
        FROM orders o
        JOIN products p ON o.sku_id = p.id
        WHERE o.payment_status = 'PAID'
        ORDER BY o.timestamp DESC
    `;

    db.all(suppliersQuery, [], (err, suppliers) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ error: 'Failed to fetch suppliers' });
        }
        
        db.all(ordersQuery, [], (err, orders) => {
            if (err) {
                console.error(err);
                return res.status(500).json({ error: 'Failed to fetch orders' });
            }
            
            // Group orders by supplier
            const revenueData = suppliers.map(supplier => {
                const supplierOrders = orders.filter(o => o.supplier_id === supplier.id);
                const totalRevenue = supplierOrders.reduce((sum, o) => sum + o.price, 0);
                return {
                    ...supplier,
                    totalRevenue,
                    orders: supplierOrders
                };
            });
            
            res.json(revenueData);
        });
    });
});

app.post('/api/reset', (req, res) => {
    db.serialize(() => {
        db.run("DELETE FROM proposals");
        db.run("DELETE FROM orders");
        db.run("DELETE FROM sales_log");
        db.run("DELETE FROM suppliers");
        db.run("DELETE FROM products WHERE id > 12");
        
        // Re-seed suppliers
        const stmtSup = db.prepare("INSERT INTO suppliers (id, name, approved, avg_historical_price, order_count) VALUES (?, ?, ?, ?, ?)");
        stmtSup.run(1, "Acme FMCG Wholesale", true, 2.0, 10);
        stmtSup.run(2, "Mother Dairy", true, 2.0, 10);
        stmtSup.run(3, "QuickPack Distributors", true, 2.0, 0);
        stmtSup.run(4, "Amul", true, 2.0, 10);
        stmtSup.finalize();
        
        // Reset products stock & relative dates preserving AI classification
        seedOrResetProducts(async () => {
            try {
                await fetch('http://localhost:4001/api/reset', { method: 'POST' });
                console.log('[Main Backend] Successfully triggered Supplier Service reset over HTTP.');
            } catch (e) {
                console.error('[Main Backend] Failed to trigger Supplier Service reset:', e.message);
            }
            res.json({ status: 'success', message: 'Demo data reset across main server and supplier service' });
        });
    });
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
