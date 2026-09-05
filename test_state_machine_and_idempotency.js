const http = require('http');

function makePostRequest(path, data) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify(data);
        const req = http.request({
            hostname: 'localhost',
            port: 3001,
            path: path,
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

function makeGetRequest(path) {
    return new Promise((resolve, reject) => {
        http.get(`http://localhost:3001${path}`, (res) => {
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

async function runTests() {
    console.log('=== STARTING STATE MACHINE AND IDEMPOTENCY TEST SUITE ===');

    // 1. Trigger Reset to get clean baseline data
    console.log('\n--- Resetting Demo Data ---');
    const resetRes = await makePostRequest('/api/reset', {});
    console.log('Reset response:', resetRes.statusCode, resetRes.body);

    // 2. Fetch Proposals to populate proposals table
    console.log('\n--- Fetching proposals ---');
    const proposalsRes = await makeGetRequest('/api/proposals');
    console.log('Proposals fetched:', proposalsRes.statusCode, proposalsRes.body.length, 'proposals');
    
    if (proposalsRes.body.length === 0) {
        console.error('No proposals available to test!');
        process.exit(1);
    }

    const testProp = proposalsRes.body[0];
    console.log(`Testing with SKU #${testProp.sku_id} (${testProp.product_name}), Proposal Status: ${testProp.status}`);

    // 3. Test Atomic Check & 409 Conflict: send FIRST create-order
    console.log('\n--- Sending FIRST /api/checkout/create-order ---');
    const createOrder1 = await makePostRequest('/api/checkout/create-order', {
        sku_id: testProp.sku_id,
        quantity: testProp.quantity,
        supplier_id: testProp.supplier_id,
        proposal_id: testProp.proposal_id || testProp.id
    });
    console.log('Create Order 1 Status:', createOrder1.statusCode);
    console.log('Create Order 1 Body:', createOrder1.body);

    if (createOrder1.statusCode !== 200) {
        console.error('First create-order failed unexpectedly!');
        process.exit(1);
    }

    // 4. Test Atomic Check & 409 Conflict: send SECOND create-order for the SAME proposal
    console.log('\n--- Sending SECOND /api/checkout/create-order for SAME proposal (expecting 409 Conflict) ---');
    const createOrder2 = await makePostRequest('/api/checkout/create-order', {
        sku_id: testProp.sku_id,
        quantity: testProp.quantity,
        supplier_id: testProp.supplier_id,
        proposal_id: testProp.proposal_id || testProp.id
    });
    console.log('Create Order 2 Status:', createOrder2.statusCode);
    console.log('Create Order 2 Body:', createOrder2.body);

    if (createOrder2.statusCode === 409) {
        console.log('SUCCESS: Second create-order attempt was rejected with HTTP 409 Conflict!');
    } else {
        console.error('FAILURE: Expected HTTP 409 Conflict on second create-order, got:', createOrder2.statusCode);
        process.exit(1);
    }

    // 5. Test Webhook / Payment Idempotency: verify FIRST payment call
    const paymentId = `rzp_test_mock_${Date.now()}`;
    console.log(`\n--- Sending FIRST /api/checkout/verify with payment ID ${paymentId} ---`);
    const verify1 = await makePostRequest('/api/checkout/verify', {
        razorpay_payment_id: paymentId,
        razorpay_order_id: createOrder1.body.order_id,
        razorpay_signature: 'mock_signature',
        internal_order_id: createOrder1.body.internal_order_id
    });
    console.log('Verify 1 Status:', verify1.statusCode);
    console.log('Verify 1 Body:', verify1.body);

    if (verify1.statusCode !== 200 || verify1.body.status !== 'success') {
        console.error('First payment verify failed unexpectedly!');
        process.exit(1);
    }

    // 6. Test Webhook / Payment Idempotency: send DUPLICATE /api/checkout/verify call with SAME payment ID
    console.log(`\n--- Sending DUPLICATE /api/checkout/verify with SAME payment ID ${paymentId} ---`);
    const verify2 = await makePostRequest('/api/checkout/verify', {
        razorpay_payment_id: paymentId,
        razorpay_order_id: createOrder1.body.order_id,
        razorpay_signature: 'mock_signature',
        internal_order_id: createOrder1.body.internal_order_id
    });
    console.log('Verify 2 Status:', verify2.statusCode);
    console.log('Verify 2 Body:', verify2.body);

    if (verify2.statusCode === 200 && verify2.body.duplicate === true) {
        console.log('SUCCESS: Duplicate payment verify was handled idempotently (no-op success returned)!');
    } else {
        console.error('FAILURE: Expected idempotent duplicate response, got:', verify2);
        process.exit(1);
    }

    // 7. Check Decision Log to verify duplicate attempt was recorded as an informational audit entry
    console.log('\n--- Checking Decision Log for DUPLICATE_PAYMENT_BLOCKED entry ---');
    const decisionsRes = await makeGetRequest('/api/decisions');
    const duplicateEntry = decisionsRes.body.find(d => d.verdict === 'DUPLICATE_PAYMENT_BLOCKED');
    
    if (duplicateEntry) {
        console.log('SUCCESS: Found DUPLICATE_PAYMENT_BLOCKED entry in Decision Log:');
        console.log('Verdict:', duplicateEntry.verdict);
        console.log('Reason:', duplicateEntry.reason);
    } else {
        console.error('FAILURE: DUPLICATE_PAYMENT_BLOCKED entry not found in Decision Log!');
        process.exit(1);
    }

    console.log('\n=== ALL TESTS PASSED SUCCESSFULLY! ===');
}

runTests().catch(err => {
    console.error('Test script crashed:', err);
    process.exit(1);
});
