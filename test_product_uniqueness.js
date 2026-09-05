const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const http = require('http');

const dbPath = path.resolve(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath);

console.log('=== Product Name Uniqueness & Duplicate Guard Test Suite ===');

function makePostRequest(urlPath, payload) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(payload);
        const req = http.request({
            hostname: 'localhost',
            port: 3001,
            path: urlPath,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data)
            }
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    resolve({ statusCode: res.statusCode, data: JSON.parse(body) });
                } catch (e) {
                    resolve({ statusCode: res.statusCode, raw: body });
                }
            });
        });

        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

async function runUniquenessTest() {
    try {
        // Step 1: Reset demo data to ensure a known baseline
        console.log('[Step 1] Resetting demo data...');
        const resetRes = await makePostRequest('/api/reset', {});
        if (resetRes.statusCode !== 200) {
            console.error('Failed to reset demo data:', resetRes);
            process.exit(1);
        }
        console.log('✓ Demo data reset successful.');

        const productName = "Organic Matcha 50g";

        // Step 2: First attempt to create product
        console.log(`[Step 2] Adding product "${productName}" (1st attempt)...`);
        const res1 = await makePostRequest('/api/products', {
            name: productName,
            category: "Beverages",
            unit_price: 250.00,
            moq: 10,
            lead_time_days: 2,
            supplier_id: 1,
            shelf_life_days: 365
        });

        console.log(`First Attempt HTTP Status: ${res1.statusCode}`);
        console.log(`First Attempt Response:`, res1.data);

        if (res1.statusCode !== 201 || !res1.data.product) {
            console.error('FAILED: First attempt should return HTTP 201 Created!');
            process.exit(1);
        }
        const createdId = res1.data.product.id;

        // Step 3: Second attempt to create product with same name (different case: "ORGANIC MATCHA 50G")
        console.log(`[Step 3] Deliberately adding product "ORGANIC MATCHA 50G" (2nd attempt - case-insensitive duplicate check)...`);
        const res2 = await makePostRequest('/api/products', {
            name: "ORGANIC MATCHA 50G",
            category: "Beverages",
            unit_price: 250.00,
            moq: 10,
            lead_time_days: 2,
            supplier_id: 1,
            shelf_life_days: 365
        });

        console.log(`Second Attempt HTTP Status: ${res2.statusCode}`);
        console.log(`Second Attempt Response:`, res2.data);

        if (res2.statusCode !== 409) {
            console.error(`FAILED: Expected HTTP 409 Conflict on duplicate product creation, got HTTP ${res2.statusCode}`);
            process.exit(1);
        }

        if (!res2.data.error || !res2.data.error.includes('already exists')) {
            console.error(`FAILED: Expected error message stating product already exists, got:`, res2.data);
            process.exit(1);
        }
        console.log('✓ Duplicate creation attempt correctly rejected with HTTP 409 Conflict!');

        // Step 4: Verify SQLite database count for "Organic Matcha 50g"
        console.log('[Step 4] Verifying row count in SQLite database...');
        const countRow = await new Promise((resolve) => {
            db.get(
                "SELECT COUNT(*) as count FROM products WHERE LOWER(name) = LOWER(?)",
                [productName],
                (err, row) => resolve(row || null)
            );
        });

        console.log(`Matching Product Row Count in DB: ${countRow ? countRow.count : 0}`);
        if (!countRow || countRow.count !== 1) {
            console.error(`FAILED: Expected exactly 1 product row in DB, found ${countRow ? countRow.count : 0}`);
            process.exit(1);
        }

        console.log('\n======================================================================');
        console.log('SUCCESS: PRODUCT NAME UNIQUENESS & DUPLICATE GUARD VERIFIED CLEANLY!');
        console.log('======================================================================\n');
        process.exit(0);
    } catch (err) {
        console.error('Test execution failed:', err);
        process.exit(1);
    }
}

runUniquenessTest();
