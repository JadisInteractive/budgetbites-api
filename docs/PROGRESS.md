# BudgetBites API — Session 1 Progress

## What was built

### Project scaffold
- `package.json`, `tsconfig.json`, `.env.example`, `.gitignore`, `docker-compose.yml`
- Full Express + TypeScript project mirroring the grocery-scraper conventions
- `scripts/db-migrate.ts` — applies SQL migrations idempotently via `schema_migrations` table

### Type system (`src/types/plans.ts`)
Complete type definitions as specified in BACKEND_ENGINEER.md:
- `PlanContext`, `HouseholdModel`, `AgeGroup`, `ProteinEmphasis`, `PacketFormat`, `TrafficLight`, `PlanStatus`
- `HealthConstraints`, `ResolvedConstraints`
- `PlanGenerateRequest` (full B2C + B2B shape)
- `PricingAvailability`, `PlanJobStatus`, `PlanJobResponse`

### Database
- `db/migrations/001_plan_jobs.sql` — `plan_jobs` table with audit columns, status index, created_at index
- Migration script applies against the shared scraper PostgreSQL instance

### Services
- `src/services/priceService.ts` — `checkPricingAvailability(chainId, storeId, weekOf)` queries `grocery_prices`
- `src/services/nutritionRules.ts` — `resolveConstraints()` with full conflict resolution (strictest wins)
- `src/services/planJobService.ts` — `enqueueJob()` inserts into `plan_jobs`; `clinicalNotes` stripped, `clinicId`/`patientRef` stored in audit columns

### API endpoints
- `POST /api/v1/plans/generations` — validates request, checks pricing availability, enqueues job, returns 202
- `GET /api/v1/jobs/:jobId` — stub returning mock queued status
- `GET /health` — health check

### Middleware
- `requestId` — generates UUID per request, sets `X-Request-Id` header, attaches to `res.locals`
- `auth` — `x-api-key` header validation (pass-through in dev when `API_KEY` unset)
- `errorHandlers` — standard error shape `{ error: { code, message, details, requestId } }`

### Workers
- `src/workers/planWorker.ts` — stub skeleton, pipeline steps documented as TODOs

---

## Tests

```bash
npm test
```

6 tests, all passing — covers `src/services/nutritionRules.ts`:
1. Single condition flag: `hypertension` → sodium 1500
2. Conflicting sodium: `hypertension` + explicit 2000 → 1500 (strictest wins)
3. Conflicting carbs: `prediabetes` + `high_triglycerides` → 100
4. Gout flag → `GOUT_EXCLUSIONS` appended to `foodsToAvoid`
5. Empty conditions array → all targets null, no exclusions
6. All conditions simultaneously → all strictest values win

TypeScript: `npx tsc --noEmit` — zero errors.

---

## How to start the API locally

```bash
# 1. Copy and fill in environment variables
cp .env.example .env
# Edit DATABASE_URL to point at the shared scraper postgres instance

# 2. Run the migration (requires postgres running)
cd ../grocery-scraper && docker compose up -d  # start postgres if not running
cd ../api
npm run db:migrate

# 3. Start the API
npm run dev
# → BudgetBites API listening on port 3001

# 4. Health check
curl http://localhost:3001/health
# → {"status":"ok"}

# 5. Test the 409 path (no pricing data for this store/week)
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
# → 409 { "error": { "code": "PRICING_DATA_UNAVAILABLE", ... } }
```

---

## Next build targets (from BACKEND_ENGINEER.md ordered list)

3. `GET /api/v1/plans/:planId` — real job status from `plan_jobs` table
4. Plan worker skeleton — job claiming with `FOR UPDATE SKIP LOCKED`, pipeline steps as stubs
5. Price retrieval service — full `getLatestPrices()` equivalent for plan generation
6. Recipe Matcher — compliant meal combination selection
7. AI Kernel module — bounded call with schema validation + deterministic fallback
8. Full pipeline integration — end-to-end golden test case

---

## Open questions / decisions for Jarvis

1. **Auth implementation**: The current `x-api-key` middleware is a dev placeholder. The full
   auth architecture (session cookies for B2C/B2B portal, API keys for server-to-server) needs
   a concrete implementation decision before B2B ships.

2. **`weekOf` date handling**: The controller validates `weekOf` using `getUTCDay()`. If
   frontend sends a date without timezone context (e.g. `"2026-03-23"`) this is interpreted
   as UTC midnight. Should we document this assumption or normalize at the edge?

3. **Tenant isolation**: The current implementation accepts `clinicId` from the request body.
   Per API_DESIGN_RULES.md §9, tenant context should be derived from the authenticated
   principal, not the request body. This needs the auth layer before B2B can go to production.

4. **Idempotency-Key**: Hook point is in `plansController.ts` (TODO comment). Needs a
   decision on storage (DB table vs Redis) before implementation.

5. **`schema_migrations` table**: The migration script creates its own `schema_migrations`
   tracking table. The scraper uses the same table name — if both modules share the same DB,
   migration filenames must stay unique across both modules (they currently do: scraper uses
   `001_grocery_prices.sql` etc., API uses `001_plan_jobs.sql`).
