const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const http = require('http');

const dbPath = path.resolve(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath);

console.log('=== Payment Amount Verification Mismatch Test Suite ===');

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

async function runMismatchTest() {
    try {
        // Step 1: Create a checkout order for Whole Milk 1L (SKU #2)
        console.log('[Step 1] Creating checkout order for SKU #2 (Whole Milk 1L)...');
        const createRes = await makePostRequest('/api/checkout/create-order', {
            sku_id: 2,
            quantity: 15,
            supplier_id: 4
        });

        if (createRes.statusCode !== 200 || !createRes.data.internal_order_id) {
            console.error('Failed to create order:', createRes);
            process.exit(1);
        }

        const internalOrderId = createRes.data.internal_order_id;
        const razorpayOrderId = createRes.data.order_id;
        const expectedTotalRupees = createRes.data.amount / 100; // in Rupees

        console.log(`✓ Order created! Internal ID: ${internalOrderId}, Razorpay Order ID: ${razorpayOrderId}, Approved Total: ₹${expectedTotalRupees}`);

        // Step 2: Attempt verification with a TAMPERED / MISMATCHED payment amount (e.g. ₹5.00 instead of ₹30.00)
        console.log('[Step 2] Triggering /api/checkout/verify with TAMPERED payment amount (₹5.00)...');
        const tamperedPayId = `pay_tampered_${Date.now()}`;
        const verifyRes = await makePostRequest('/api/checkout/verify', {
            razorpay_payment_id: tamperedPayId,
            razorpay_order_id: razorpayOrderId,
            razorpay_signature: 'mock_signature',
            internal_order_id: internalOrderId,
            mock_payment_amount: 5.00 // Tampered amount
        });

        console.log(`Verify Response HTTP Status: ${verifyRes.statusCode}`);
        console.log(`Verify Response Data:`, verifyRes.data);

        if (verifyRes.statusCode !== 400) {
            console.error(`FAILED: Expected HTTP 400 on payment mismatch, got HTTP ${verifyRes.statusCode}`);
            process.exit(1);
        }

        if (!verifyRes.data.error || !verifyRes.data.error.includes('Payment amount mismatch')) {
            console.error(`FAILED: Expected mismatch error message, got:`, verifyRes.data);
            process.exit(1);
        }

        // Step 3: Check SQLite database orders table for MISMATCH Decision Log entry
        console.log('[Step 3] Checking Decision Log for MISMATCH entry in SQLite...');
        const logEntry = await new Promise((resolve) => {
            db.get(
                "SELECT * FROM orders WHERE verdict = 'MISMATCH' ORDER BY timestamp DESC LIMIT 1",
                (err, row) => resolve(row || null)
            );
        });

        if (!logEntry) {
            console.error('FAILED: No MISMATCH Decision Log entry found in orders table!');
            process.exit(1);
        }

        console.log(`✓ Found MISMATCH Decision Log Entry:`);
        console.log(`  ID: ${logEntry.id}, Verdict: ${logEntry.verdict}, Payment Status: ${logEntry.payment_status}`);
        console.log(`  Reason: "${logEntry.reason}"`);

        // Step 4: Check proposal status was transitioned to FAILED
        const proposalRow = await new Promise((resolve) => {
            db.get("SELECT status FROM proposals WHERE sku_id = 2", (err, row) => resolve(row || null));
        });

        console.log(`Proposal Status for SKU #2: ${proposalRow ? proposalRow.status : 'N/A'}`);
        if (!proposalRow || proposalRow.status !== 'FAILED') {
            console.error(`FAILED: Expected proposal status FAILED, got ${proposalRow ? proposalRow.status : 'null'}`);
            process.exit(1);
        }

        console.log('\n======================================================================');
        console.log('SUCCESS: PAYMENT AMOUNT MISMATCH VERIFICATION & LOGGING PASSED CLEANLY!');
        console.log('======================================================================\n');
        process.exit(0);
    } catch (err) {
        console.error('Test execution failed:', err);
        process.exit(1);
    }
}

runMismatchTest();
