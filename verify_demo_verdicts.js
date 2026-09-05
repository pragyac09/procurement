const http = require('http');

function makeRequest(options, postData = null) {
    return new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve({ statusCode: res.statusCode, body: parsed });
                } catch (e) {
                    resolve({ statusCode: res.statusCode, body: data });
                }
            });
        });
        req.on('error', reject);
        if (postData) {
            req.write(typeof postData === 'string' ? postData : JSON.stringify(postData));
        }
        req.end();
    });
}

async function runRegressionChecks() {
    console.log('====================================================');
    console.log('  DEMO VERDICT REGRESSION CHECK (POST-RESET STATE)  ');
    console.log('====================================================\n');

    // 1. Reset Demo Data to ensure clean baseline state
    console.log('[1/3] Resetting Demo Data over HTTP...');
    const resetRes = await makeRequest({
        hostname: 'localhost',
        port: 3001,
        path: '/api/reset',
        method: 'POST'
    });

    if (resetRes.statusCode !== 200) {
        console.error('FAILED to reset demo data:', resetRes.body);
        process.exit(1);
    }
    console.log('✓ Reset Demo Data successful.\n');

    // 2. Fetch live proposals
    console.log('[2/3] Fetching live procurement proposals...');
    const proposalsRes = await makeRequest({
        hostname: 'localhost',
        port: 3001,
        path: '/api/proposals',
        method: 'GET'
    });

    if (proposalsRes.statusCode !== 200 || !Array.isArray(proposalsRes.body)) {
        console.error('FAILED to fetch proposals:', proposalsRes.body);
        process.exit(1);
    }
    const proposals = proposalsRes.body;
    console.log(`✓ Retried ${proposals.length} proposals.\n`);

    // 3. Define Expected Demo Baseline Verdicts
    const expectedVerdicts = [
        { sku_id: 2, name: 'Whole Milk 1L', expectedVerdict: 'APPROVE', expectedStatus: 'APPROVED' },
        { sku_id: 6, name: 'Digestive Biscuits 100g', expectedVerdict: 'APPROVE', expectedStatus: 'APPROVED' },
        { sku_id: 10, name: 'Shampoo 200ml', expectedVerdict: 'BLOCK', expectedStatus: 'PROPOSED' }
    ];

    console.log('[3/3] Asserting Known-Good Baseline Verdicts...');
    let allPassed = true;

    for (const item of expectedVerdicts) {
        const found = proposals.find(p => p.sku_id === item.sku_id || (p.product_name && p.product_name.includes(item.name)));

        if (!found) {
            console.error(`❌ [FAIL] ${item.name} (SKU #${item.sku_id}): Proposal NOT found in restock list!`);
            allPassed = false;
            continue;
        }

        const verdictMatch = found.verdict === item.expectedVerdict;
        const statusMatch = found.status === item.expectedStatus;
        const isSuccess = verdictMatch && statusMatch;

        if (isSuccess) {
            console.log(`✓ [PASS] ${found.product_name || item.name} (SKU #${found.sku_id}):`);
            console.log(`         Verdict: ${found.verdict} (Expected: ${item.expectedVerdict})`);
            console.log(`         Status:  ${found.status} (Expected: ${item.expectedStatus})`);
            console.log(`         Reason:  ${found.verdict_reason}\n`);
        } else {
            console.error(`❌ [FAIL] ${found.product_name || item.name} (SKU #${found.sku_id}):`);
            console.error(`         Verdict: ${found.verdict} (Expected: ${item.expectedVerdict}) ${!verdictMatch ? '<< MISMATCH' : ''}`);
            console.error(`         Status:  ${found.status} (Expected: ${item.expectedStatus}) ${!statusMatch ? '<< MISMATCH' : ''}`);
            console.error(`         Reason:  ${found.verdict_reason}\n`);
            allPassed = false;
        }
    }

    console.log('====================================================');
    if (allPassed) {
        console.log('  SUCCESS: ALL DEMO VERDICT REGRESSION CHECKS PASSED  ');
        console.log('====================================================');
        process.exit(0);
    } else {
        console.error('  FAILURE: REGRESSION DETECTED IN DEMO VERDICTS  ');
        console.error('====================================================');
        process.exit(1);
    }
}

runRegressionChecks().catch(err => {
    console.error('Unexpected error during regression checks:', err);
    process.exit(1);
});
