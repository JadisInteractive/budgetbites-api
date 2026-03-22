# Claude Code Prompt — BudgetBites Central API
# Paste this entire prompt into a Claude Code session started from:
# /Users/admin/Projects/budgetbites/api

---

You are building the BudgetBites Central API — the trust layer of a health-first grocery
intelligence and meal planning platform. Before writing a single line of code, read these
three files in full:

1. ./CLAUDE.md
2. ./.agents/BACKEND_ENGINEER.md
3. ./.agents/API_DESIGN_RULES.md

Everything you need to know about design principles, type contracts, the pipeline sequence,
error codes, audit requirements, and what not to do is in those files. Do not proceed past
this point until you have read all three.

---

## Your first session goal

Scaffold the working Express + TypeScript API project and implement the first two
build targets from BACKEND_ENGINEER.md:

1. `src/types/plans.ts` — complete type definitions as specified
2. `POST /api/v1/plans/generations` stub — validates request shape, checks pricing
   availability against the grocery_prices DB, enqueues job, returns 202

The 409 PRICING_DATA_UNAVAILABLE path must work end-to-end by the end of this session.
That means the API must connect to the PostgreSQL database that the grocery-scraper
already uses, query the grocery_prices table, and return 409 if no records exist for
the requested chainId / storeId / weekOf combination.

---

## Project initialization

From /Users/admin/Projects/budgetbites/api, initialize a Node.js + TypeScript project
following these exact conventions (match the grocery-scraper's setup):

```bash
npm init -y
npm install express
npm install -D typescript @types/express @types/node ts-node nodemon
npm install pg
npm install -D @types/pg
npm install zod                    # for request validation
npm install uuid                   # for plan IDs and trace IDs
npm install -D @types/uuid
npm install -D vitest              # match scraper test runner
```

Create tsconfig.json, .env.example, .gitignore, and docker-compose.yml.
Mirror the scraper's config conventions at ../grocery-scraper/. Do not invent new patterns.

Target directory structure after scaffolding:
```
src/
  app.ts
  index.ts
  routes/
    plans.ts
  controllers/
    plansController.ts
  services/
    priceService.ts        ← queries grocery_prices for pricing availability
    nutritionRules.ts      ← resolveConstraints() — implement fully with tests
  middleware/
    auth.ts
    validation.ts
  types/
    plans.ts               ← all types from BACKEND_ENGINEER.md
  workers/
    planWorker.ts          ← stub only for now
db/
  migrations/
    001_plan_jobs.sql
docs/
  PROGRESS.md              ← document what you built and what's next
```

---

## Specific implementation requirements

### src/types/plans.ts
Implement every type exactly as specified in BACKEND_ENGINEER.md. No deviations.
No `any` types. Export everything.

### src/services/priceService.ts
Implement a `checkPricingAvailability(chainId, storeId, weekOf)` function that:
- Connects to the same PostgreSQL database as the grocery-scraper
- Queries grocery_prices WHERE chain_id = $1 AND store_id = $2
  AND start_date <= $3 AND end_date >= $3
- Returns { available: boolean, scrapeRunId: string | null, priceCount: number }
- Uses the same pool/connection pattern as ../grocery-scraper/src/db/pool.ts

The DATABASE_URL environment variable is shared with the scraper. Do not create a
separate DB connection — reuse the same connection string.

### src/services/nutritionRules.ts
Implement resolveConstraints() exactly as specified in BACKEND_ENGINEER.md.
Write unit tests covering:
- Single condition flag (hypertension → sodium 1500)
- Conflicting sodium targets (hypertension + explicit 2000 → should resolve to 1500)
- Conflicting carb targets (prediabetes + high_triglycerides → should resolve to 100)
- Gout flag → GOUT_EXCLUSIONS appended to foodsToAvoid
- Empty conditions array → all targets null, no exclusions added
- All conditions active simultaneously → all strictest values win

### POST /api/v1/plans/generations
Request: PlanGenerateRequest (from types/plans.ts)
Response (202): { jobId, status: "queued", planId: null, submittedAt }
Response (409): { error: { code: "PRICING_DATA_UNAVAILABLE", message, details, requestId } }

Validation (enforce all of these before any DB call):
- context: must be "b2c" or "b2b_clinic"
- If context === "b2b_clinic": patientRef required, must match /^[A-Z0-9\-]{3,40}$/
- If context === "b2b_clinic": clinicId required
- householdModel: must be a valid HouseholdModel enum value
- weekOf: must be a valid ISO date string AND must be a Monday
  (new Date(weekOf).getDay() === 1)
- budgetUsd: must be a number between 20 and 500
- healthConstraints: must be present; conditions must be a string array

After validation, synchronously check pricing availability.
If not available → 409 PRICING_DATA_UNAVAILABLE immediately (do not enqueue job).
If available → enqueue job to plan_jobs table → return 202.

### GET /api/v1/jobs/:jobId
For now, return a mock response:
{ jobId, status: "queued", planId: null, submittedAt }
This endpoint exists so the frontend can integrate against something real.

### db/migrations/001_plan_jobs.sql
Create the plan_jobs table matching the scraper's scrape_jobs pattern:
```sql
CREATE TABLE plan_jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'queued',
  request       JSONB NOT NULL,
  clinic_id     TEXT,
  patient_ref   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  error_message TEXT
);

CREATE INDEX plan_jobs_status_idx ON plan_jobs(status);
CREATE INDEX plan_jobs_created_at_idx ON plan_jobs(created_at);
```

---

## Environment variables needed

```
PORT=3001
DATABASE_URL=postgresql://user:password@localhost:5432/grocery
API_KEY=dev-api-key-change-in-prod
NODE_ENV=development
```

DATABASE_URL must match the grocery-scraper's database — it's the same Postgres instance.

---

## What to document in docs/PROGRESS.md

When you finish this session, write a PROGRESS.md that includes:
- What was built
- What was tested and how to run the tests
- What the next build targets are (per the ordered list in BACKEND_ENGINEER.md)
- Any open questions or decisions that need Jarvis's input
- The exact command to start the API locally

---

## What success looks like for this session

```bash
# API starts
npm run dev

# Health check works
curl http://localhost:3001/health

# 409 fires correctly when no pricing data exists
curl -X POST http://localhost:3001/api/v1/plans/generations \
  -H "Content-Type: application/json" \
  -d '{
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
    "weekOf": "2026-03-23",
    "budgetUsd": 50,
    "packetFormat": "traffic_light_family"
  }'
# Expected: 409 { error: { code: "PRICING_DATA_UNAVAILABLE", ... } }

# Nutrition rules tests pass
npm test
```

---

## Absolute rules — do not violate these

1. No `any` types anywhere
2. Do not call the AI model from any route handler, controller, or service
3. Do not compute prices, macros, or health constraints inside an AI call
4. clinicalNotes must never appear in any AI model call payload
5. All error responses must use the exact shape in API_DESIGN_RULES.md section 2
6. All route paths must use /api/v1/ prefix
7. Idempotency-Key header support is not required in this session but do not design
   it out — leave the hook in the request handler with a TODO comment

---

*Read CLAUDE.md, BACKEND_ENGINEER.md, and API_DESIGN_RULES.md before starting.*
*When in doubt about a pattern, check ../grocery-scraper/src/ first.*
