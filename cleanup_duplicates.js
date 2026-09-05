const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath);

console.log('=== Duplicate Product Cleanup Script ===');

db.serialize(() => {
    // 1. Find all product rows named 'Organic Matcha 50g' (case-insensitive)
    db.all("SELECT id, name FROM products WHERE LOWER(name) = 'organic matcha 50g' ORDER BY id ASC", (err, rows) => {
        if (err) {
            console.error('Error finding duplicate products:', err);
            process.exit(1);
        }

        if (!rows || rows.length <= 1) {
            console.log(`Found ${rows ? rows.length : 0} matching product(s). No duplicate cleanup needed for "Organic Matcha 50g".`);
            cleanOtherDuplicates();
            return;
        }

        const keepRow = rows[0];
        const deleteRows = rows.slice(1);
        const deleteIds = deleteRows.map(r => r.id);

        console.log(`Keeping primary product ID: #${keepRow.id} ("${keepRow.name}")`);
        console.log(`Deleting duplicate product IDs: ${deleteIds.join(', ')}`);

        // Delete associated proposals, inventory_batches, supplier_catalog, and orders for deleted IDs
        const placeholders = deleteIds.map(() => '?').join(',');

        db.run(`DELETE FROM proposals WHERE sku_id IN (${placeholders})`, deleteIds, function(err) {
            if (err) console.error('Error deleting duplicate proposals:', err);
            else console.log(`Deleted ${this.changes} duplicate proposal(s).`);
        });

        db.run(`DELETE FROM inventory_batches WHERE product_id IN (${placeholders})`, deleteIds, function(err) {
            if (err) console.error('Error deleting duplicate batches:', err);
            else console.log(`Deleted ${this.changes} duplicate batch(es).`);
        });

        db.run(`DELETE FROM supplier_catalog WHERE product_id IN (${placeholders})`, deleteIds, function(err) {
            if (err) console.error('Error deleting duplicate supplier catalog entries:', err);
            else console.log(`Deleted ${this.changes} duplicate supplier catalog entry/entries.`);
        });

        db.run(`DELETE FROM orders WHERE sku_id IN (${placeholders})`, deleteIds, function(err) {
            if (err) console.error('Error deleting duplicate order decision log entries:', err);
            else console.log(`Deleted ${this.changes} duplicate decision log order(s).`);
        });

        db.run(`DELETE FROM products WHERE id IN (${placeholders})`, deleteIds, function(err) {
            if (err) console.error('Error deleting duplicate products:', err);
            else console.log(`Deleted ${this.changes} duplicate product(s).`);
            cleanOtherDuplicates();
        });
    });
});

function cleanOtherDuplicates() {
    // Check if any other product names have duplicate entries
    db.all(`
        SELECT LOWER(name) as lower_name, COUNT(*) as count 
        FROM products 
        GROUP BY LOWER(name) 
        HAVING count > 1
    `, (err, dupGroups) => {
        if (dupGroups && dupGroups.length > 0) {
            console.warn(`Found ${dupGroups.length} duplicate group(s) in products table:`, dupGroups);
        } else {
            console.log('✓ All product names in database are now strictly unique!');
        }

        // Add a UNIQUE index on LOWER(name) if not exists
        db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_products_unique_lower_name ON products(LOWER(name))", (idxErr) => {
            if (idxErr) console.error('Index creation warning:', idxErr.message);
            else console.log('✓ UNIQUE index on LOWER(name) ensured in SQLite schema.');
            db.close();
        });
    });
}
