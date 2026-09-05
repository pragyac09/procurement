require('dotenv').config();
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { GoogleGenAI } = require('@google/genai');

const dbPath = path.resolve(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath, async (err) => {
    if (err) {
        console.error('[Classify Products] Database connection error:', err.message);
        process.exit(1);
    }
    console.log('[Classify Products] Connected to SQLite database.');
    await classifyAllProducts();
});

function getFallbackClassification(name) {
    const lower = name.toLowerCase();
    if (lower.includes('milk')) {
        return { category: 'Dairy - Perishable', shelf_life_days: 2 };
    }
    if (lower.includes('paneer')) {
        return { category: 'Dairy - Perishable', shelf_life_days: 2 };
    }
    if (lower.includes('yogurt')) {
        return { category: 'Dairy - Perishable', shelf_life_days: 6 };
    }
    if (lower.includes('chips') || lower.includes('biscuits') || lower.includes('noodles')) {
        return { category: 'Packaged Snacks - Non-Perishable', shelf_life_days: 365 };
    }
    if (lower.includes('rice')) {
        return { category: 'Grains & Staples - Non-Perishable', shelf_life_days: 365 };
    }
    if (lower.includes('shampoo') || lower.includes('toothpaste')) {
        return { category: 'Personal Care - Non-Perishable', shelf_life_days: 365 };
    }
    if (lower.includes('water')) {
        return { category: 'Beverages - Non-Perishable', shelf_life_days: 365 };
    }
    // Cold start policy: Do NOT guess a default category/shelf-life for unclassified products.
    return { category: null, shelf_life_days: null };
}

/**
 * Timezone & Expiry Policy Conventions:
 * 1. Timezone: All calendar dates ("today", date offsets) are explicitly computed in Asia/Kolkata (IST) timezone.
 * 2. Expiry Semantics: A product batch is sellable through the end of its expiry_date.
 *    A batch is only considered expired starting the following day (i.e. expiry_date < todayStr, NOT <=).
 */
function calculateExpiryDate(lastRestockedDateStr, shelfLifeDays) {
    if (!shelfLifeDays) return null;
    const baseDate = lastRestockedDateStr ? new Date(lastRestockedDateStr) : new Date();
    const validBase = isNaN(baseDate.getTime()) ? new Date() : baseDate;
    validBase.setDate(validBase.getDate() + shelfLifeDays);
    return validBase.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function ensureColumnsExist(cb) {
    db.run("ALTER TABLE products ADD COLUMN shelf_life_days INTEGER", () => {
        db.run("ALTER TABLE products ADD COLUMN avg_daily_sales_units INTEGER", () => {
            db.run("ALTER TABLE products ADD COLUMN last_restocked_date TEXT", () => {
                db.run("ALTER TABLE products ADD COLUMN expiry_date TEXT", () => {
                    db.run("ALTER TABLE products ADD COLUMN classified_by TEXT DEFAULT 'fallback'", () => {
                        cb();
                    });
                });
            });
        });
    });
}

async function classifyAllProducts() {
    ensureColumnsExist(() => {
        db.all("SELECT id, name, category, last_restocked_date FROM products", async (err, products) => {
        if (err || !products || products.length === 0) {
            console.error('[Classify Products] Failed to fetch products:', err ? err.message : 'No products found');
            db.close();
            return;
        }

        console.log(`[Classify Products] Starting classification for ${products.length} products...`);

        let llmClassifications = null;
        let llmSuccess = false;

        // Try single batch LLM call
        if (process.env.GEMINI_API_KEY) {
            try {
                const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
                const prompt = `You are a quick-commerce product classification AI. Classify these products into categories and shelf life in days.

Examples:
- "Whole Milk 1L" -> category: "Dairy - Perishable", shelf_life_days: 2
- "Basmati Rice 1kg" -> category: "Grains - Non-Perishable", shelf_life_days: 365
- "Potato Chips 52g" -> category: "Packaged Snacks - Non-Perishable", shelf_life_days: 365

Return ONLY a valid JSON array of objects with the exact schema:
[
  { "product_id": 1, "category": "Category Name", "shelf_life_days": 365 }
]

Products to classify:
${JSON.stringify(products.map(p => ({ product_id: p.id, name: p.name })))}
`;

                const response = await ai.models.generateContent({
                    model: 'gemini-2.5-flash',
                    contents: prompt,
                });

                const rawText = (response && response.text) ? String(response.text).trim() : "";
                const cleanJsonText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();

                const parsed = JSON.parse(cleanJsonText);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    llmClassifications = {};
                    parsed.forEach(item => {
                        if (item.product_id && item.category && typeof item.shelf_life_days === 'number' && item.shelf_life_days > 0) {
                            llmClassifications[item.product_id] = {
                                category: String(item.category),
                                shelf_life_days: Math.round(item.shelf_life_days)
                            };
                        }
                    });
                    if (Object.keys(llmClassifications).length > 0) {
                        llmSuccess = true;
                    }
                }
            } catch (llmErr) {
                console.warn('[Classify Products] LLM classification call failed, falling back to keyword lookup table:', llmErr.message || llmErr);
            }
        } else {
            console.warn('[Classify Products] GEMINI_API_KEY not found, using fallback keyword lookup table.');
        }

        let countLlm = 0;
        let countFallback = 0;

        const updateStmt = db.prepare("UPDATE products SET category = ?, shelf_life_days = ?, classified_by = ?, expiry_date = ? WHERE id = ?");

        products.forEach(product => {
            let cat, shelfLife, classifiedBy;

            if (llmSuccess && llmClassifications[product.id]) {
                cat = llmClassifications[product.id].category;
                shelfLife = llmClassifications[product.id].shelf_life_days;
                classifiedBy = 'llm';
                countLlm++;
            } else {
                const fb = getFallbackClassification(product.name);
                cat = fb.category;
                shelfLife = fb.shelf_life_days;
                classifiedBy = 'fallback';
                countFallback++;
            }

            const expiryDateStr = calculateExpiryDate(product.last_restocked_date, shelfLife);
            updateStmt.run(cat, shelfLife, classifiedBy, expiryDateStr, product.id);
        });

        updateStmt.finalize(() => {
            console.log(`\n======================================================`);
            console.log(`[Classify Products] Classification Complete!`);
            console.log(`  Total Products Processed: ${products.length}`);
            console.log(`  AI-Classified (LLM):       ${countLlm}`);
            console.log(`  Fallback-Classified:      ${countFallback}`);
            console.log(`======================================================\n`);
            db.close();
        });
    });
});
}
