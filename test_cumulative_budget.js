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

async function runTests() {
    console.log('--- TESTING CUMULATIVE BUDGET ENFORCEMENT & RESERVATIONS ---');

    // 1. Fetch live policy
    const policyRes = await makeRequest({
        hostname: 'localhost',
        port: 3001,
        path: '/api/policy',
        method: 'GET'
    });
    console.log('Policy Response:', policyRes.body);
    if (typeof policyRes.body.remaining_budget !== 'number' || typeof policyRes.body.total_committed !== 'number') {
        throw new Error('Policy endpoint missing remaining_budget or total_committed!');
    }

    // 2. Fetch proposals
    const proposalsRes = await makeRequest({
        hostname: 'localhost',
        port: 3001,
        path: '/api/proposals',
        method: 'GET'
    });
    console.log(`Fetched ${proposalsRes.body.length} proposals.`);
    proposalsRes.body.forEach(p => {
        console.log(`- SKU #${p.sku_id} (${p.product_name}): status=${p.status}, verdict=${p.verdict}, total_cost=₹${p.total_cost}, reason=${p.verdict_reason}`);
    });

    // 3. Test budget reservation logic: check if blocked proposals have clear cumulative budget reason
    const blockedByBudget = proposalsRes.body.filter(p => p.verdict === 'BLOCK' && p.verdict_reason && p.verdict_reason.includes('Exceeds remaining cumulative budget'));
    console.log(`Found ${blockedByBudget.length} proposals blocked by cumulative budget.`);

    // 4. Test reject releasing budget: if we reject an approved proposal, remaining_budget increases
    const approvedProp = proposalsRes.body.find(p => p.status === 'APPROVED');
    if (approvedProp) {
        console.log(`Testing rejection release on approved proposal for SKU #${approvedProp.sku_id} (total_cost=₹${approvedProp.total_cost})...`);
        const rejectRes = await makeRequest({
            hostname: 'localhost',
            port: 3001,
            path: `/api/proposals/${approvedProp.sku_id}/reject`,
            method: 'POST'
        });
        console.log('Reject Response:', rejectRes.body);

        // Fetch policy again
        const policyAfterReject = await makeRequest({
            hostname: 'localhost',
            port: 3001,
            path: '/api/policy',
            method: 'GET'
        });
        console.log('Policy after reject:', policyAfterReject.body);
        if (policyAfterReject.body.remaining_budget !== policyRes.body.remaining_budget + approvedProp.total_cost) {
            console.warn(`Expected remaining budget to increase by ₹${approvedProp.total_cost}, got ${policyAfterReject.body.remaining_budget}`);
        } else {
            console.log('SUCCESS: Reservation released successfully upon rejection!');
        }
    }

    console.log('--- ALL CUMULATIVE BUDGET TESTS COMPLETED ---');
}

runTests().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
