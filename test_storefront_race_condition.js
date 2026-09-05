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

async function runStorefrontRaceConditionTest() {
    console.log('=== STOREFRONT CONCURRENT PURCHASE RACE CONDITION TEST ===');

    // 1. Reset Demo Data
    console.log('\n--- Resetting Demo Data ---');
    await makePostRequest('/api/reset', {});

    // 2. Query products to find a product with limited stock
    const productsRes = await makeGetRequest('/api/products');
    const products = productsRes.body;
    
    // Pick Whole Milk 1L (id = 2) or any perishable item with initial stock = 5
    const targetProduct = products.find(p => p.id === 5);
    console.log(`Target Product: SKU #${targetProduct.id} (${targetProduct.name}), Initial Stock: ${targetProduct.dark_store_stock} units`);

    // Pre-purchase to bring stock down to 5 units
    const setupPurchaseQty = targetProduct.dark_store_stock - 5;
    if (setupPurchaseQty > 0) {
        console.log(`Pre-purchasing ${setupPurchaseQty} units to leave exactly 5 units in stock...`);
        const setupRes = await makePostRequest('/api/storefront/purchase', { product_id: targetProduct.id, quantity: setupPurchaseQty });
        console.log('Setup purchase response:', setupRes.statusCode, setupRes.body);
    }

    const preTestProductsRes = await makeGetRequest('/api/products');
    const preparedProduct = preTestProductsRes.body.find(p => p.id === targetProduct.id);
    const initialStock = preparedProduct.dark_store_stock;
    console.log(`Stock before concurrent requests: ${initialStock}`);

    const req1Qty = 4;
    const req2Qty = 3;
    console.log(`Sending TWO CONCURRENT PURCHASES: Request A (qty ${req1Qty}) and Request B (qty ${req2Qty}). Total requested: ${req1Qty + req2Qty} units vs ${initialStock} available.`);

    // Fire dual concurrent purchase requests at the exact same millisecond
    const p1 = makePostRequest('/api/storefront/purchase', { product_id: targetProduct.id, quantity: req1Qty });
    const p2 = makePostRequest('/api/storefront/purchase', { product_id: targetProduct.id, quantity: req2Qty });

    const [res1, res2] = await Promise.all([p1, p2]);

    console.log('\n--- Concurrent Purchase Results ---');
    console.log('Request A Response:', res1.statusCode, res1.body);
    console.log('Request B Response:', res2.statusCode, res2.body);

    const successCount = (res1.statusCode === 200 ? 1 : 0) + (res2.statusCode === 200 ? 1 : 0);
    const failureCount = (res1.statusCode === 400 ? 1 : 0) + (res2.statusCode === 400 ? 1 : 0);

    console.log(`\nSuccesses: ${successCount}, Rejections (HTTP 400): ${failureCount}`);

    if (successCount !== 1 || failureCount !== 1) {
        console.error(`FAILURE: Expected exactly 1 success and 1 rejection due to insufficient stock, got ${successCount} successes and ${failureCount} failures!`);
        process.exit(1);
    }

    const successfulRes = res1.statusCode === 200 ? res1 : res2;
    const failedRes = res1.statusCode === 400 ? res1 : res2;
    const purchasedQty = res1.statusCode === 200 ? req1Qty : req2Qty;

    console.log(`\nSUCCESS: 1 purchase succeeded (${purchasedQty} units) and 1 purchase was rejected cleanly: "${failedRes.body.error}"`);

    // 4. Verify Final Stock & Batch Quantities in DB
    const finalProductsRes = await makeGetRequest('/api/products');
    const updatedProduct = finalProductsRes.body.find(p => p.id === targetProduct.id);

    console.log(`Final Aggregate Stock in DB: ${updatedProduct.dark_store_stock} units`);
    const expectedStock = successfulRes.body.new_stock;

    if (updatedProduct.dark_store_stock === expectedStock) {
        console.log(`SUCCESS: Aggregate stock matches expected remaining stock (${expectedStock} units)! Zero overselling!`);
    } else {
        console.error(`FAILURE: Expected final stock ${expectedStock}, but found ${updatedProduct.dark_store_stock}!`);
        process.exit(1);
    }

    if (updatedProduct.dark_store_stock < 0) {
        console.error('FAILURE: Stock went negative!');
        process.exit(1);
    }

    console.log('\n=== STOREFRONT RACE CONDITION TEST PASSED PERFECTLY! ===');
}

runStorefrontRaceConditionTest().catch(err => {
    console.error('Test crashed:', err);
    process.exit(1);
});
