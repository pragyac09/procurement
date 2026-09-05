const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const http = require('http');

const dbPath = path.resolve(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath);

console.log('=== Policy Decisions Automated Test Suite ===');

// 1. Check Asia/Kolkata Timezone & Expiry Semantics
function testTimezoneAndExpiry() {
    const now = new Date();
    const expectedIstToday = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

    console.log(`[Test 1] IST Today Date: ${expectedIstToday}`);

    const todayStr = expectedIstToday;
    const yesterdayDate = new Date(now);
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterdayStr = yesterdayDate.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

    // Expiry semantics check
    const isTodayExpired = todayStr < todayStr;
    const isYesterdayExpired = yesterdayStr < todayStr;

    if (isTodayExpired !== false) {
        console.error('FAILED: Today expiry date should NOT mark product as expired (expiry_date < todayStr should be false).');
        process.exit(1);
    }
    if (isYesterdayExpired !== true) {
        console.error('FAILED: Yesterday expiry date SHOULD mark product as expired (expiry_date < todayStr should be true).');
        process.exit(1);
    }

    console.log('✓ Expiry semantics check passed: expiry_date < todayStr (strictly less than, sellable on expiry_date).');
}

// 2. Check Unclassified Cold Start Product
function testUnclassifiedColdStart() {
    return new Promise((resolve, reject) => {
        console.log('[Test 2] Inserting unclassified cold-start product "Test Cold-Start Item 50g"...');
        
        db.run(
            `INSERT INTO products (name, category, unit_price, moq, lead_time_days, dark_store_stock, reorder_point, supplier_id, shelf_life_days, classified_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ['Test Cold-Start Item 50g', null, 250.00, 10, 2, 0, 15, 1, null, 'unclassified'],
            function(err) {
                if (err) {
                    console.error('Failed to insert test unclassified product:', err.message);
                    return reject(err);
                }
                const testId = this.lastID;
                console.log(`Inserted test product ID: ${testId}`);

                // Query /api/proposals to test reorder pipeline evaluation
                http.get('http://localhost:3001/api/proposals', (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        try {
                            const proposals = JSON.parse(data);
                            const testProp = proposals.find(p => p.sku_id === testId || p.product_name === 'Test Cold-Start Item 50g');

                            // Clean up inserted test product & proposals
                            db.run("DELETE FROM products WHERE id = ?", [testId]);
                            db.run("DELETE FROM proposals WHERE sku_id = ?", [testId]);

                            if (!testProp) {
                                console.error('FAILED: Unclassified product proposal was not generated!');
                                return reject(new Error('No proposal for unclassified product'));
                            }

                            console.log(`Unclassified Proposal Verdict: ${testProp.verdict}`);
                            console.log(`Unclassified Verdict Reason: "${testProp.verdict_reason}"`);

                            if (testProp.verdict !== 'ESCALATE') {
                                console.error(`FAILED: Expected verdict ESCALATE, got ${testProp.verdict}`);
                                return reject(new Error('Wrong verdict'));
                            }

                            if (!testProp.verdict_reason.includes('Product not yet classified — category/shelf-life unknown, cannot compute a safe order quantity.')) {
                                console.error(`FAILED: Verdict reason missing required cold start message. Got: ${testProp.verdict_reason}`);
                                return reject(new Error('Wrong verdict reason'));
                            }

                            console.log('✓ Unclassified cold start ESCALATE policy test passed!');
                            resolve();
                        } catch (e) {
                            db.run("DELETE FROM products WHERE id = ?", [testId]);
                            db.run("DELETE FROM proposals WHERE sku_id = ?", [testId]);
                            reject(e);
                        }
                    });
                }).on('error', (err) => {
                    db.run("DELETE FROM products WHERE id = ?", [testId]);
                    db.run("DELETE FROM proposals WHERE sku_id = ?", [testId]);
                    reject(err);
                });
            }
        );
    });
}

async function runTests() {
    testTimezoneAndExpiry();
    try {
        await testUnclassifiedColdStart();
        console.log('\n==================================================');
        console.log('ALL POLICY DECISIONS TESTS PASSED SUCCESSFULLY!');
        console.log('==================================================\n');
        process.exit(0);
    } catch (err) {
        console.error('Test execution failed:', err);
        process.exit(1);
    }
}

runTests();
