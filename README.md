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
