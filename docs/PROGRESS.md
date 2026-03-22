# BudgetBites API — Progress Log

---

## Session 2 (2026-03-22)

### What was built

#### Target 3 — Real `GET /api/v1/jobs/:jobId`
- `getPlanJob(jobId)` added to `planJobService.ts` — queries `plan_jobs` by ID
- `getJobHandler` updated from stub to DB-backed; returns `{ jobId, status, planId, submittedAt }`
- Returns 404 `NOT_FOUND` if job does not exist

#### Target 3 — `GET /api/v1/plans/:planId`
- New `getPlanHandler` in `plansController.ts`
- Returns full `PlanRecord` directly (no envelope — per API_DESIGN_RULES.md §2)
- Returns 404 `NOT_FOUND` if plan does not exist
- Route added: `GET /api/v1/plans/:planId`

#### Target 4 — Plan worker with real job claiming
- `claimNextPlanJob()` — `FOR UPDATE SKIP LOCKED` (mirrors scraper's `claimNextScrapeJob()`)
- `updatePlanJobStatus()` — marks job failed with error message
- `completePlanJob(jobId, planId)` — marks job complete, sets `plan_id` back-reference
- `planWorker.ts` — full 8-step pipeline implemented

#### Target 5 — Price retrieval service
- `getPricesForWeek(chainId, storeId, weekOf)` in `priceService.ts`
- Mirrors `getLatestPrices()` from the scraper: dedup by `MAX(last_updated)` per product
- Filtered to `start_date <= weekOf AND end_date >= weekOf`

#### Target 6 — Recipe Matcher (`src/services/recipeMatcher.ts`)
- `scoreItems(prices, constraints)` — keyword-based traffic light classification (green/yellow/red) + compliance scoring
- `selectItems(scoredItems, effectiveBudget, householdModel)` — greedy selection by compliance score, stays within effective budget (budgetUsd × 0.9)
- `buildTrafficLightSummary(items)` — counts per traffic light color
- `assembleDeterministicPayload(...)` — builds the Step 6 payload passed to the AI Kernel
- 14 unit tests, all passing

#### Target 7 — AI Kernel (`src/services/aiKernel.ts`)
- Bounded `callAIKernel(payload, traceId)` — calls `claude-sonnet-4-6` via `@anthropic-ai/sdk`
- PHI guard: `buildUserContent()` explicitly lists forwarded fields — `patientRef`, `clinicId`, `clinicalNotes` never forwarded
- Zod schema validation on AI output (`AIKernelOutputSchema`)
- Deterministic fallback (`FALLBACK_OUTPUT`) used when: model unreachable, response not text, JSON parse fails, or schema validation fails
- `fallbackUsed` boolean always recorded in plan audit record

#### Target 8 — Full pipeline integration
- `planWorker.ts` wires Steps 3–8 end-to-end
- SHA-256 `constraintsHash` computed from `HealthConstraints` at generation time
- Plan created in `'generating'` status before pipeline runs; completed/failed after
- `db/migrations/002_plans.sql` — `plans` table + `plan_jobs.plan_id` column

#### New types in `src/types/plans.ts`
- `GroceryPriceEntry` — mirror of scraper type (avoids cross-module import)
- `ScoredItem`, `MealPlanItem`
- `DeterministicPayload`, `AIKernelOutput`, `MealPlanPacket`
- `PlanRecord`

---

### Tests

```bash
npm test
```

**20 tests, all passing:**
- `nutritionRules.test.ts` — 6 tests (unchanged from Session 1)
- `recipeMatcher.test.ts` — 14 tests:
  - Traffic light classification (green/yellow/red keyword matching)
  - `foodsToAvoid` filtering
  - Sale item bonus scoring
  - Budget enforcement in `selectItems`
  - Priority ordering (green before yellow before red)
  - Zero-budget edge case
  - Traffic light summary counting
  - 10% budget buffer in `assembleDeterministicPayload`
  - `packetFormat` default
  - `totalCostUsd` calculation

TypeScript: `npx tsc --noEmit` — zero errors.

---

### How to start the API locally

```bash
# 1. Copy and fill in environment variables
cp .env.example .env
# Required: DATABASE_URL (shared scraper postgres), ANTHROPIC_API_KEY

# 2. Start postgres (from grocery-scraper dir)
cd ../grocery-scraper && docker compose up -d && cd ../api

# 3. Run migrations
npm run db:migrate
# Applies: 001_plan_jobs.sql, 002_plans.sql

# 4. Start the API
npm run dev
# → BudgetBites API listening on port 3001

# 5. Health check
curl http://localhost:3001/health

# 6. Submit a generation job (expect 409 if no pricing data exists)
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
    "weekOf": "2026-03-24",
    "budgetUsd": 50,
    "packetFormat": "traffic_light_family"
  }'

# 7. Poll job status
curl http://localhost:3001/api/v1/jobs/<jobId>

# 8. Retrieve completed plan
curl http://localhost:3001/api/v1/plans/<planId>
```

---

## Next build targets (Session 3)

These are the remaining staging gates from CLAUDE.md before production:

1. **Idempotency-Key** — implement replay logic for duplicate POST submissions (storage TBD: DB table vs Redis — needs Jarvis's input)
2. **Tenant isolation enforcement** — `clinicId` must be derived from the authenticated principal, not the request body (blocked on auth layer decision)
3. **Auth layer** — session cookies (B2C/B2B portal) + API key scoped by `clinicId` (server-to-server); see API_DESIGN_RULES.md §9
4. **`GET /api/v1/patients/:patientRef/plans`** — list plans for a patient within a clinic
5. **PHI staging gate test** — assert `clinicalNotes`, `patientRef`, `clinicId` never appear in `ai_kernel_log.input` (no `ai_kernel_log` table yet — log to structured stdout for now)
6. **Schema validation golden tests** — run the full pipeline against a seeded golden dataset; assert 3 AI output schemas pass
7. **`BUDGET_INFEASIBLE` (422)** — fire when `selectedItems` is empty after recipe matching (budget cannot satisfy household model + constraints)

---

## Open questions for Jarvis

1. **Idempotency storage**: DB table (simpler, no new infra) vs Redis (faster replay but new dependency)? Current hook is a TODO comment in `plansController.ts`.

2. **Auth implementation**: The `x-api-key` middleware is a dev placeholder. Full auth architecture (session cookies B2C/B2B, API keys server-to-server) needs a concrete decision before B2B goes to production.

3. **`weekOf` UTC assumption**: `weekOf` is parsed as UTC midnight. If the frontend sends `"2026-03-23"` from a US timezone, this is correct Monday detection only because the scraper uses the same convention. Should we document this explicitly or normalize at the edge?

4. **Tenant isolation**: Currently `clinicId` is trusted from the request body. Per API_DESIGN_RULES.md §9, it must be derived from the authenticated principal. This is blocked on the auth layer.

5. **`ai_kernel_log` table**: The PHI staging gate requires asserting `clinicalNotes` never appears in AI call logs. Currently logged to structured stdout. Should we create an `ai_kernel_log` DB table now or defer until the auth layer is in?

6. **Recipe Matcher — serving sizes**: The matcher selects one of each item per week. A more accurate model would multiply by serving quantities per household member. Is a serving-size data source planned (e.g., USDA FoodData Central)?

---

## Session 1 (2026-03-22)

### What was built

- Project scaffold (package.json, tsconfig.json, .env.example, .gitignore, docker-compose.yml)
- `src/types/plans.ts` — all core types (PlanGenerateRequest, HealthConstraints, enums, etc.)
- `POST /api/v1/plans/generations` — validates request shape, checks pricing availability, enqueues job, returns 202 or 409
- `GET /api/v1/jobs/:jobId` — stub (now replaced by real DB-backed handler in Session 2)
- `src/services/nutritionRules.ts` — `resolveConstraints()` with full conflict resolution
- `src/services/priceService.ts` — `checkPricingAvailability()`
- `src/services/planJobService.ts` — `enqueueJob()`
- `db/migrations/001_plan_jobs.sql` + idempotent migration runner
- 6 nutrition rules unit tests, all passing
