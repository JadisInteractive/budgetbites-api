# BudgetBites — Central API

The Central API is the trust layer of the BudgetBites platform. All frontend portals and
external integrations communicate exclusively through this service — nothing reaches the
database, the AI Kernel, or the Circular Scraper directly.

**Stack:** Node.js · TypeScript · Express · PostgreSQL · Zod · Vitest

---

## Core principle

**Rules compute. Models explain.**

Prices, macros, and health constraint resolutions are always computed deterministically.
The AI Kernel is called at Step 6 of 8 in the generation pipeline — after all deterministic
work is done — and may never invent prices, quantities, basket totals, or clinical guidance.

---

## Module relationships

```
grocery-scraper  →  grocery_prices DB  →  Central API  →  Frontend portals
                                          ↓
                                      AI Kernel (bounded)
```

The `grocery-scraper` writes pricing records. This API reads them. The scraper's PostgreSQL
instance is shared — this service does not run its own database.

---

## Getting started

### Prerequisites

- Node.js 20+
- PostgreSQL running via the grocery-scraper's `docker-compose.yml`

### Install

```bash
npm install
```

### Configure

```bash
cp .env.example .env
# Edit DATABASE_URL to point at the shared scraper postgres instance
```

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | Port the API listens on |
| `DATABASE_URL` | — | Shared postgres connection string (same as grocery-scraper) |
| `DATABASE_SSL` | `false` | Set `true` for RDS/managed postgres |
| `API_KEY` | — | API key for `x-api-key` header auth (leave unset to bypass in dev) |
| `NODE_ENV` | `development` | `development` or `production` |

### Run migrations

```bash
# Start postgres first (from grocery-scraper dir)
cd ../grocery-scraper && docker compose up -d && cd ../api

npm run db:migrate
```

### Start

```bash
npm run dev
```

### Health check

```bash
curl http://localhost:3001/health
# {"status":"ok"}
```

---

## API

All routes are prefixed with `/api/v1`.

### `POST /api/v1/plans/generations`

Submit a meal plan generation request. Returns a job ID immediately — generation is
asynchronous.

**Request body**

```json
{
  "context": "b2b_clinic",
  "patientRef": "LLB-0047",
  "clinicId": "llb",
  "householdModel": "1a_2c",
  "healthConstraints": {
    "conditions": ["hypertension"],
    "sodiumTargetMg": null,
    "carbTargetG": null,
    "calorieTarget": null,
    "proteinEmphasis": "lean",
    "foodsToAvoid": []
  },
  "chainId": "publix",
  "storeId": "publix_covington_ga",
  "weekOf": "2026-03-24",
  "budgetUsd": 50,
  "packetFormat": "traffic_light_family"
}
```

| Field | Notes |
|---|---|
| `context` | `"b2c"` or `"b2b_clinic"` |
| `patientRef` | Required when `context` is `b2b_clinic`. Pattern: `/^[A-Z0-9\-]{3,40}$/` |
| `clinicId` | Required when `context` is `b2b_clinic` |
| `householdModel` | Enum — see `src/types/plans.ts` |
| `weekOf` | ISO date string; must be a Monday |
| `budgetUsd` | Number between 20 and 500 (pre-buffer; Price Engine applies 10% buffer) |

**Responses**

| Status | Meaning |
|---|---|
| `202` | Job accepted — `{ jobId, status: "queued", planId: null, submittedAt }` |
| `400` | Validation error — `{ error: { code: "VALIDATION_ERROR", message, details, requestId } }` |
| `409` | No pricing data for the requested `chainId`/`storeId`/`weekOf` — `{ error: { code: "PRICING_DATA_UNAVAILABLE", ... } }` |

### `GET /api/v1/jobs/:jobId`

Poll job status. Returns `{ jobId, status, planId, submittedAt }`.

> Currently returns a stub response. Real DB-backed status is the next build target.

---

## Tests

```bash
npm test
```

6 unit tests covering the Nutrition Rules Engine (`src/services/nutritionRules.ts`):
conflict resolution between conditions, sodium/carb strictest-wins logic, gout exclusions,
and empty condition sets. No database required.

```bash
npx tsc --noEmit  # type-check — zero errors expected
```

---

## Project structure

```
src/
  app.ts                      Express app setup
  index.ts                    Server entry point
  routes/
    plans.ts                  Route definitions
  controllers/
    plansController.ts        Request handlers
  services/
    priceService.ts           Queries grocery_prices for availability
    nutritionRules.ts         Nutrition Rules Engine (resolveConstraints)
    planJobService.ts         Enqueues jobs to plan_jobs
    aiKernel.ts               Bounded AI orchestration (not yet implemented)
  middleware/
    auth.ts                   x-api-key validation
    requestId.ts              UUID per request, X-Request-Id header
    errorHandlers.ts          Standard error shape
  types/
    plans.ts                  All request/response types
  workers/
    planWorker.ts             Background job processor (stub)
db/
  migrations/
    001_plan_jobs.sql         plan_jobs table
scripts/
  db-migrate.ts               Idempotent migration runner
docs/
  PROGRESS.md                 Session 1 build log and open questions
```

---

## Related modules

| Module | Role |
|---|---|
| `../grocery-scraper` | Writes pricing records to `grocery_prices` (shared DB) |
| `../clinic-front-end` | B2B multi-tenant clinic portal — Lively Live Better is the pilot clinic |
| `../front-end` | B2C consumer frontend |
| `../admin-dashboard` | Product Owner Portal |
