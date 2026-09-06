# Agentic B2B Procurement

**Razorpay AI Buildathon — Track 01: AI Growth & Agentic Commerce**

A procurement agent for a quick-commerce dark store. It watches inventory in real time, proposes restock orders to suppliers, runs every proposal through a deterministic Fit / Policy / Risk / Decision check, and — once approved — pays the supplier through Razorpay in test mode.

The core idea: **the LLM proposes, deterministic code disposes.** Every money-moving decision (which supplier, how much to order, approve/escalate/block, whether a payment executes) is plain, explainable code — never an unsupervised call by a language model.

## Architecture

Three separate processes, not one service pretending to be three:

- **`backend/`** — Node/Express, port `3001`. Owns procurement logic, inventory, decisions, and Razorpay payments.
- **`supplier-service/`** — Node/Express, port `4001`. Stands in for an external supplier catalog the agent negotiates with over HTTP.
- **`frontend/`** — React (Vite), port `5173`. Operator dashboard + storefront.

## Where AI is used (and where it isn't)

Gemini (free tier, capped at 20 requests/day) is used in exactly two non-blocking places:

1. **One-time product classification** (`npm run classify-products`) — assigns each catalog item a category and shelf-life in days, once. On failure/quota exhaustion, falls back silently to a hardcoded keyword table. `Reset Demo Data` never re-runs this, so demos don't burn the daily quota.
2. **Cosmetic narrative notes** — a one-sentence, best-effort explanation attached to some decisions (e.g. why one supplier was chosen over another). Absent if the call fails; never blocks the pipeline.

Everything else — supplier comparison, reorder math, spoilage detection, budget/policy checks, and the final verdict — is deterministic code that runs the same way every time.

## Key features

- Multi-supplier comparison (cheapest price within a 2-day lead-time SLA) feeding a Fit/Policy/Risk/Decision pipeline → APPROVE / ESCALATE / BLOCK, each with a human-readable reason and calculation trail.
- Per-batch (FEFO) inventory — each restock is a dated batch; sales always deplete the soonest-expiring batch first.
- Dynamic reorder point and order quantity, computed from real sales history rather than fixed constants.
- Perishable order cap — for shelf life ≤ 7 days, order quantity is capped using a stable 7-day average so fresh stock is never over-ordered into guaranteed spoilage.
- Automatic spoilage write-off, logged per batch as its own audit entry.
- Zero-trust payment re-validation — immediately before a Razorpay order is created, the backend re-fetches live supplier price/stock/lead-time and re-runs the policy check, rejecting (HTTP 403) if anything material changed since the proposal was shown.
- Real Razorpay test-mode payments: order creation, checkout widget, server-side signature verification, and a distinct failure-handling path that leaves stock/revenue untouched.
- Storefront purchase flow that depletes real, FEFO-ordered stock and shows expiry/freshness badges.
- Supplier Revenue tracking scoped strictly to money actually paid out to suppliers on verified restock payments — not retail sales, not a general balance.
- Live operator UX: a "N action(s) required" counter on Proposed Orders that updates immediately after Approve/Reject/Modify, an "Analyzing catalog for restocking..." loading state during recompute, and a confirmation flow before Reset Demo Data runs.

## Edge cases handled

| Edge case | How it's handled |
|---|---|
| Expired stock sitting in inventory | Detected and written off automatically per batch, before the reorder check runs, with its own SPOILAGE audit log entry. |
| Over-ordering a fast-expiring product | Order quantity capped using a stable 7-day average, separate from the more reactive average used for reorder timing. |
| One-off demand spike vs. real trend | A reactive average drives reorder point/target stock (catches real spikes fast); a stable average is used only for the perishable cap (a single busy day can't justify over-ordering fresh stock). |
| Mixed-expiry stock of the same product | Tracked as separate dated batches; sales always draw from the soonest-expiring active batch first (FEFO). |
| "Expiring soon" being unfair across products | Threshold is 30% of each product's own shelf life (minimum 1 day) instead of one flat number for every product. |
| Order exceeding the budget cap | Hard BLOCK, no exceptions. |
| Supplier price/stock changing after a proposal was shown | Re-validated live against the supplier service immediately before payment; rejects with HTTP 403 on any material change. |
| Razorpay payment failing mid-flow | Handled on a distinct code path — a PAYMENT_FAILED log entry is written and nothing else changes; retrying is always safe since each attempt creates a fresh order. |
| An abandoned/never-completed checkout | Order creation performs no database writes, so an unfinished checkout leaves proposals, stock, and revenue completely unchanged. |
| Gemini free-tier quota exhaustion | Every LLM call site is non-blocking or one-time-only: classification runs once and never on reset; narrative notes fail silently with no effect on the decision. |
| Demo needing a clean, repeatable starting state | Reset Demo Data restores stock, batches, and sales history using dates computed relative to "today," without re-running the one-time AI classification. |
| Operator overriding the agent's recommendation | Manual reject, manual supplier choice, and manual reorder-point overrides are all supported without breaking the deterministic pipeline underneath. |

## Demo walkthrough (seed scenarios)

Two products are deliberately seeded to make the shelf-life/expiry logic visible immediately on load:

- **Whole Milk 1L (Mother Dairy)** — seeded already expired, so it shows the EXPIRED badge, a spoilage write-off, and an urgent reorder proposal at demo start.
- **Paneer 200g (Fresh Farms)** — seeded fresh but at low stock, generating a restock proposal whose quantity is visibly capped below naive reorder-point math — demonstrating the shelf-life cap distinctly from the spoilage scenario.

All seed dates are computed relative to the server's current date (not fixed calendar dates), so the demo is correct on whatever day it's actually run, and Reset Demo Data reproduces both scenarios identically every time.

Relevant product schema fields added for this: `category`, `shelf_life_days`, `avg_daily_sales_units`, `last_restocked_date`, `expiry_date`, `classified_by` (`'llm'` or `'fallback'`).
<img width="896" height="371" alt="image" src="https://github.com/user-attachments/assets/a123e2dd-8de4-4293-9d2e-71223b63acd7" />


https://github.com/user-attachments/assets/9296d737-f074-4769-9b53-a21746f792a9

<img width="835" height="394" alt="image" src="https://github.com/user-attachments/assets/858b1ac5-a088-4bca-917f-dc25c5cfcb87" />



## Setup

Each service has its own dependencies and `.env` file.

```bash
# Backend
cd backend
npm install
# create .env with: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, GEMINI_API_KEY
npm run classify-products   # one-time: classifies products via Gemini
npm run dev                 # starts on port 3001

# Supplier service
cd ../supplier-service
npm install
npm run dev                 # starts on port 4001

# Frontend
cd ../frontend
npm install
npm run dev                 # starts on port 5173
```

## Environment variables

| Variable | Used in | Purpose |
|---|---|---|
| `RAZORPAY_KEY_ID` | backend | Razorpay test-mode key ID |
| `RAZORPAY_KEY_SECRET` | backend | Razorpay test-mode secret (server-side only) |
| `GEMINI_API_KEY` | backend | Product classification + narrative notes |

`.env` files are gitignored — see `.gitignore`.

## Known limitations

- Expiry-date midnight boundary (does a batch expiring "today" count as sellable?) is not yet decided/tested.
- No confirmed guard against Razorpay webhook redelivery (idempotency).
- Concurrent Storefront purchases of the same batch are not stress-tested for race conditions.
- A previously-passing "clean APPROVE" demo scenario (Digestive Biscuits) regressed to ESCALATE during later batch/FEFO work; flagged but not yet root-caused.

  ## Demo

Short clips of the flows not shown in the pitch video (Razorpay payment gateway wasn't included as its own segment, due to time — captured here instead):

### Razorpay payment flow
![Razorpay payment flow](docs/demo/razorpay-payment.gif)
Approve → Razorpay checkout widget → server-side signature verification → payment reflected in Supplier Revenue.

### Budget-cap BLOCK (edge case)
![Budget cap block](docs/demo/budget-block.gif)
The Shampoo 200ml scenario — 505 units × ₹120 = ₹60,600 against a ₹50,000 cap — rejected with a clear Verdict Reason, no exceptions.

### Spoilage write-off (edge case)
![Spoilage write-off](docs/demo/spoilage-writeoff.gif)
An expired batch is zeroed automatically and logged as its own SPOILAGE entry in the Decision Log, without affecting any other still-valid batch of the same product.
