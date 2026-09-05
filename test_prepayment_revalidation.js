const http = require('http');
const sqlite3 = require('sqlite3');
const path = require('path');

function makePostRequest(pathStr, data) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify(data);
        const req = http.request({
            hostname: 'localhost',
            port: 3001,
            path: pathStr,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    resolve({ statusCode: res.statusCode, body: JSON.parse(body) });
                } catch (e) {
                    resolve({ statusCode: res.statusCode, body: body });
                }
            });
        });

        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

function makeGetRequest(pathStr) {
    return new Promise((resolve, reject) => {
        http.get(`http://localhost:3001${pathStr}`, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    resolve({ statusCode: res.statusCode, body: JSON.parse(body) });
                } catch (e) {
                    resolve({ statusCode: res.statusCode, body: body });
                }
            });
        }).on('error', reject);
    });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runPrepaymentRevalidationTest() {
    console.log('=== PRE-PAYMENT RE-VALIDATION TEST SUITE ===');

    // 1. Reset Demo Data
    console.log('\n--- Resetting Demo Data ---');
    const resetRes = await makePostRequest('/api/reset', {});
    console.log('Reset response:', resetRes.statusCode);

    // 2. Fetch proposals
    const propsRes = await makeGetRequest('/api/proposals');
    const proposals = propsRes.body;
    console.log(`Proposals fetched: ${proposals.length} proposals`);

    const milkProposal = proposals.find(p => p.sku_id === 2);
    if (!milkProposal) {
        console.error('Milk proposal not found!');
        process.exit(1);
    }
    console.log(`Target Proposal: SKU #${milkProposal.sku_id} (${milkProposal.product_name}), Proposal ID: ${milkProposal.id}, Quantity: ${milkProposal.quantity}`);

    // --- TEST 1: Inventory Restocked Revalidation Failure ---
    console.log('\n--- TEST 1: Simulating Inventory Already Restocked (Stock > Reorder Point) ---');
    const dbPath = path.resolve(__dirname, 'database.sqlite');
    const db = new sqlite3.Database(dbPath);

    await new Promise((resolve) => {
        const todayStr = new Date().toISOString().split('T')[0];
        // Insert 200 units into inventory_batches for SKU #2 (Whole Milk 1L)
        db.run("INSERT INTO inventory_batches (product_id, quantity, received_date, expiry_date) VALUES (2, 200, ?, ?)", [todayStr, '2027-01-01'], () => {
            resolve();
        });
    });

    console.log('Inserted 200 units into inventory_batches for SKU #2 to bring stock above reorder point.');
    console.log('Sending /api/checkout/create-order for SKU #2...');

    const res1 = await makePostRequest('/api/checkout/create-order', {
        sku_id: 2,
        proposal_id: milkProposal.id
    });

    console.log('Create Order Response Status:', res1.statusCode);
    console.log('Create Order Response Body:', res1.body);

    if (res1.statusCode !== 409) {
        console.error(`FAILURE: Expected HTTP 409 Conflict, got HTTP ${res1.statusCode}`);
        process.exit(1);
    }

    if (!res1.body.error || !res1.body.error.includes('Revalidation failed')) {
        console.error(`FAILURE: Response error message does not contain 'Revalidation failed': ${res1.body.error}`);
        process.exit(1);
    }
    console.log('SUCCESS: Inventory condition revalidation blocked payment with HTTP 409!');

    await sleep(200);

    // Verify REVALIDATION_FAILED Decision Log entry in DB
    const logEntry1 = await new Promise((resolve) => {
        db.get("SELECT * FROM orders WHERE sku_id = 2 AND verdict = 'REVALIDATION_FAILED' ORDER BY id DESC LIMIT 1", (err, row) => {
            resolve(row);
        });
    });

    if (!logEntry1) {
        console.error('FAILURE: REVALIDATION_FAILED Decision Log entry not found in DB!');
        process.exit(1);
    }
    console.log('SUCCESS: Found REVALIDATION_FAILED entry in Decision Log:');
    console.log(`Verdict: ${logEntry1.verdict}`);
    console.log(`Reason: ${logEntry1.reason}`);

    // --- TEST 2: Remaining Budget Exceeded Revalidation Failure ---
    console.log('\n--- TEST 2: Simulating Budget Depleted by Other Orders ---');
    // Reset DB state
    await makePostRequest('/api/reset', {});
    // Set SKU #2 batch quantity to 0 so live stock (0) <= reorder point (10), allowing budget check to run
    await new Promise((resolve) => {
        db.run("UPDATE inventory_batches SET quantity = 0 WHERE product_id = 2", () => resolve());
    });

    // Insert a large mock paid order consuming ₹49,990 of ₹50,000 budget (leaving ₹10 remaining vs proposal cost ₹30)
    await new Promise((resolve, reject) => {
        db.run(
            `INSERT INTO orders (sku_id, quantity, supplier_id, price, verdict, reason, payment_status)
             VALUES (1, 100, 1, 49990.0, 'APPROVE', 'Mock large order consuming budget', 'PAID')`,
            (err) => {
                if (err) reject(err); else resolve();
            }
        );
    });

    // Close db connection in test script so SQLite flushes to disk for server.js
    await new Promise(resolve => db.close(resolve));

    const checkDb = new sqlite3.Database(dbPath);
    const checkRow = await new Promise(resolve => {
        checkDb.get("SELECT COALESCE(SUM(price), 0) AS total_spent FROM orders WHERE payment_status = 'PAID'", (e, r) => resolve(r));
    });
    console.log('Test script verified total_spent in DB:', checkRow);

    console.log('Inserted mock paid order of ₹49,500 into DB (remaining budget: ₹500 vs proposal cost ₹2,400).');
    await sleep(300);
    const freshPropsRes = await makeGetRequest('/api/proposals');
    const freshMilkProp = freshPropsRes.body.find(p => p.sku_id === 2);

    const res2 = await makePostRequest('/api/checkout/create-order', {
        sku_id: 2,
        proposal_id: freshMilkProp ? freshMilkProp.id : null
    });

    console.log('Create Order Response Status:', res2.statusCode);
    console.log('Create Order Response Body:', res2.body);

    if (res2.statusCode !== 409) {
        console.error(`FAILURE: Expected HTTP 409 Conflict for budget revalidation, got HTTP ${res2.statusCode}`);
        process.exit(1);
    }

    if (!res2.body.error || !res2.body.error.includes('exceeds current remaining budget')) {
        console.error(`FAILURE: Error message does not mention remaining budget: ${res2.body.error}`);
        process.exit(1);
    }
    console.log('SUCCESS: Remaining budget revalidation blocked payment with HTTP 409!');

    await sleep(200);

    const logEntry2 = await new Promise((resolve) => {
        checkDb.get("SELECT * FROM orders WHERE sku_id = 2 AND verdict = 'REVALIDATION_FAILED' ORDER BY id DESC LIMIT 1", (err, row) => {
            resolve(row);
        });
    });

    if (!logEntry2) {
        console.error('FAILURE: REVALIDATION_FAILED Decision Log entry for budget failure not found in DB!');
        process.exit(1);
    }
    console.log('SUCCESS: Found REVALIDATION_FAILED budget entry in Decision Log:');
    console.log(`Verdict: ${logEntry2.verdict}`);
    console.log(`Reason: ${logEntry2.reason}`);

    // Cleanup: Reset demo data back to clean state
    await makePostRequest('/api/reset', {});
    checkDb.close();

    console.log('\n=== PRE-PAYMENT RE-VALIDATION TEST PASSED PERFECTLY! ===');
}

runPrepaymentRevalidationTest().catch(err => {
    console.error('Test crashed:', err);
    process.exit(1);
});
