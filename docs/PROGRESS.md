# BudgetBites API — Progress Log

---

## Session 3 (2026-03-22) — Answers to Open Questions + Implementations

### Answers to open questions

---

#### Q1 — Idempotency storage: **DB table** ✅ Implemented

Decision: PostgreSQL `idempotency_keys` table.

**What was built:**
- `db/migrations/003_idempotency.sql` — `idempotency_keys` table with 24-hour TTL via `expires_at`
- `src/services/idempotencyService.ts` — `getIdempotencyRecord()`, `saveIdempotencyRecord()`, `hashRequestBody()`
- `src/controllers/plansController.ts` — full Idempotency-Key implementation:
  - Extracts `Idempotency-Key` header
  - SHA-256 hashes the request body
  - On cache hit with same hash → replays stored 202 response
  - On cache hit with different hash → returns 422 `CONFLICT` (key reused with different body)
  - On cache miss → proceeds normally, stores response after successful enqueue (best-effort)

---

#### Q2 — Auth architecture: **Presented below** (not yet implemented — needs session)

**B2C — Recommendation: Clerk**

Clerk is the fastest path to subscription-gated consumer auth with Stripe integration.

| | Clerk | Supabase Auth | Auth0 |
|---|---|---|---|
| Stripe integration | Native SDK + webhooks | Edge Functions | Custom |
| Developer experience | Excellent | Good | Complex |
| Social login / passwordless | Built-in | Built-in | Built-in |
| GDPR / CCPA | Ready | Ready | Ready |
| HIPAA BAA | No | No | Yes (at cost) |
| Pricing | Per MAU | Free tier + self-host | Expensive at scale |

B2C users are consumers — they are not patients in our system. `clinicalNotes` and `patientRef` never enter B2C flows. No HIPAA BAA is required for B2C auth.

Integration plan:
1. Clerk issues a short-lived JWT per session
2. Central API verifies JWT via Clerk's JWKS endpoint (middleware)
3. Stripe customer is created/synced on Clerk's `user.created` webhook
4. API gates plan generation on active Stripe subscription (scope: `plans:write`)

---

**B2B — Recommendation: Auth0 (Okta) with HIPAA BAA + custom API keys**

Clinics handle patient data. Any auth provider that touches B2B sessions must sign a Business Associate Agreement (BAA). Auth0 (via Okta) is the most mature option with a documented HIPAA compliance path.

**Architecture:**

```
Clinic portal user  →  Auth0 (HIPAA BAA)  →  JWT (RS256, 15min TTL)
                                                   ↓
                                           Central API middleware
                                                   ↓
                                         res.locals.principal = {
                                           actorType: "clinic_user",
                                           tenantId: "llb",          ← clinicId
                                           scopes: ["plans:write"],
                                           roles: ["coordinator"]
                                         }
```

For server-to-server (clinic EHR integrations):
- API keys issued per clinic, stored as `SHA-256(key)` in DB
- Scoped to `clinicId` — a key for LLB cannot touch another clinic's data
- Revocable without disrupting other clinic keys
- IP whitelisting optional per clinic

**Compliance requirements that cannot be ignored:**

| Requirement | What it means for us |
|---|---|
| **HIPAA BAA** | Must be signed with Auth0 (and any other vendor touching B2B sessions) before clinic go-live |
| **HIPAA Audit log** | Every access to PHI-adjacent data must be logged with timestamp, actor, action. 6-year retention. |
| **HIPAA MFA** | Required for all clinic portal users. Cannot be optional. Auth0 Adaptive MFA covers this. |
| **HIPAA Session timeout** | 15-minute inactivity auto-logout for clinic portal. Configurable in Auth0. |
| **HIPAA Encryption** | PHI at rest (AES-256 — Postgres encryption or field-level). In transit: TLS 1.2+. Already satisfied for transit. |
| **HITECH Act** | Strengthens HIPAA breach notification rules — 60-day breach notification requirement. |
| **SOC 2 Type II** | Enterprise clinics will require a SOC 2 report before procurement. Auth0 is SOC 2 certified. We will need our own SOC 2 eventually. |
| **GDPR Article 28** | Data Processing Agreements must be signed with Auth0 for any EU clinic users. |
| **21st Century Cures Act** | If clinics want to export plan data to EHR systems, HL7 FHIR compatibility may be required. Flag this before any EHR integration. |

**Next steps for auth implementation:**
- Jarvis signs Auth0 (HIPAA-eligible) agreement
- Define scope catalog and role taxonomy (`coordinator`, `clinician`, `admin`)
- Implement `tenantContextMiddleware` (see Q4 below)
- Replace `x-api-key` dev placeholder with real JWT verification middleware

---

#### Q3 — `weekOf` UTC assumption: **UTC, documented explicitly** ✅ Decision made

**Decision:** All `weekOf` date-only strings are interpreted as UTC midnight. This is consistent with how the grocery scraper writes `start_date`/`end_date` (UTC date strings). The existing `getUTCDay() === 1` Monday check is correct and intentional.

**What this means for clients:**
- Frontend must send `weekOf` as an ISO 8601 date string (`YYYY-MM-DD`)
- The string is parsed as UTC midnight — e.g., `"2026-03-23"` → `2026-03-23T00:00:00Z`
- For US-based clients this is always safe since grocery week boundaries (Monday) are calendar-day concepts, not time-of-day concepts
- This assumption is documented in the API contract and will be enforced by the OpenAPI spec

**No code change required.** `getUTCDay() === 1` in `plansController.ts` is the correct check.

---

#### Q4 — Tenant isolation: **Solution designed below** (implementation blocked on auth layer)

**The problem:** Currently `clinicId` is trusted from the request body. Per API_DESIGN_RULES.md §9, tenant context must be derived from the authenticated principal.

**Solution design:**

```typescript
// src/middleware/tenantContext.ts (to be implemented with auth layer)

export function tenantContextMiddleware(
  req: Request, res: Response, next: NextFunction
): void {
  const principal = res.locals.principal as AuthPrincipal | undefined;

  // B2B clinic actors: derive clinicId from the verified JWT, never from request body
  if (principal?.actorType === "clinic_user" || principal?.actorType === "service") {
    res.locals.clinicId = principal.tenantId;
  }

  next();
}
```

In `generatePlanHandler`, after auth middleware runs:
```typescript
const authenticatedClinicId = res.locals.clinicId as string | undefined;

if (body.context === "b2b_clinic") {
  // If client supplied a clinicId in the body, it must match the authenticated principal.
  // Mismatch → 403 CLINIC_TENANT_MISMATCH. Trust the JWT, not the body.
  if (body.clinicId && authenticatedClinicId && body.clinicId !== authenticatedClinicId) {
    return sendApiError(res, 403, "CLINIC_TENANT_MISMATCH", ...);
  }
  const effectiveClinicId = authenticatedClinicId ?? body.clinicId;
  // Use effectiveClinicId for all DB writes
}
```

All DB queries in the plans layer will add `AND clinic_id = $clinicId` enforced at the query layer, not only in middleware.

**Status:** Blocked on Q2 (auth layer). The current placeholder `x-api-key` middleware will be replaced when Auth0 integration is complete.

---

#### Q5 — `ai_kernel_log` table: ✅ Implemented

**What was built:**
- `db/migrations/004_ai_kernel_log.sql` — `ai_kernel_log` table
- `src/services/aiKernel.ts` — updated to accept `planId` and log every call (success and fallback) to `ai_kernel_log`
- PHI guard: `buildUserContent()` is the enforcement point — same field set is used for both the model call and the `input` column in the log. `patientRef`, `clinicId`, and `clinicalNotes` can never appear in this function.
- Logging is best-effort: `logKernelCall` failures are swallowed so a DB issue never fails a plan generation.

**PHI staging gate test** (to be written before B2B production):
```sql
-- Assert no PHI-adjacent fields exist in any ai_kernel_log.input record
SELECT COUNT(*) FROM ai_kernel_log
WHERE input::text ILIKE '%patientRef%'
   OR input::text ILIKE '%clinicId%'
   OR input::text ILIKE '%clinicalNotes%';
-- Expected: 0
```

---

#### Q6 — Recipe Matcher accuracy: **USDA FoodData Central integration** ✅ Implemented

**What was built:**
- `db/migrations/005_nutrition_cache.sql` — caches USDA lookups keyed by normalized product name
- `src/services/nutritionService.ts`:
  - `getNutritionData(productName)` — cache-first lookup with 5s timeout on USDA API
  - `fetchNutritionMap(productNames[])` — batch lookup with `Promise.allSettled` (failures silently fall back to keyword heuristics)
  - `normalizeProductKey()` — strips punctuation, lowercases, collapses spaces for cache hit maximization
- `src/services/recipeMatcher.ts`:
  - `classifyWithNutrition(nutrition)` — USDA-data-based traffic light (sodium ≤150mg + carbs ≤15g = green; sodium >500mg or carbs >45g = red)
  - `classifyItem(productName)` — keyword fallback (unchanged from Session 2)
  - `scoreItems()` now accepts optional `nutritionMap` — uses USDA data when available, keywords when not
  - Compliance score now penalizes items where estimated serving sodium/carbs exceeds the patient's daily budget (per resolved health constraints)
- `src/workers/planWorker.ts` — batch-fetches nutrition data for all price entries at Step 4, passes `nutritionMap` to Recipe Matcher at Step 5

**USDA API setup:**
- Register at https://fdc.nal.usda.gov/ for a free API key
- `DEMO_KEY` works for development (1,000 req/hr limit)
- Set `USDA_API_KEY` in `.env`

**18 unit tests** covering USDA-based classification, keyword fallback, compliance scoring with health constraints, and `normalizeProductKey`.

---

### What was built (Session 3 summary)

| File | Change |
|---|---|
| `db/migrations/003_idempotency.sql` | New — idempotency_keys table |
| `db/migrations/004_ai_kernel_log.sql` | New — ai_kernel_log table |
| `db/migrations/005_nutrition_cache.sql` | New — nutrition_cache table |
| `src/services/idempotencyService.ts` | New — DB-backed idempotency |
| `src/services/nutritionService.ts` | New — USDA lookup + cache |
| `src/services/aiKernel.ts` | Updated — accepts planId, logs to ai_kernel_log |
| `src/services/recipeMatcher.ts` | Updated — USDA-backed classification + constraint-aware scoring |
| `src/workers/planWorker.ts` | Updated — batch nutrition fetch + planId threading |
| `src/controllers/plansController.ts` | Updated — Idempotency-Key fully implemented |
| `src/types/plans.ts` | Updated — NutritionData type added |
| `.env.example` | Updated — USDA_API_KEY added |

**38/38 tests passing. 0 TypeScript errors.**

---

### How to start the API locally

```bash
# 1. Copy and fill in environment variables
cp .env.example .env
# Required: DATABASE_URL, ANTHROPIC_API_KEY
# Optional but recommended: USDA_API_KEY (register free at https://fdc.nal.usda.gov/)

# 2. Start postgres (from grocery-scraper dir)
cd ../grocery-scraper && docker compose up -d && cd ../api

# 3. Run migrations
npm run db:migrate
# Applies: 001_plan_jobs, 002_plans, 003_idempotency, 004_ai_kernel_log, 005_nutrition_cache

# 4. Start the API
npm run dev

# 5. Health check
curl http://localhost:3001/health

# 6. Submit a generation job (with Idempotency-Key)
curl -X POST http://localhost:3001/api/v1/plans/generations \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: llb-LLB-0047-2026-03-24" \
  -d '{ ... }'

# 7. Replay the same request (returns original 202, not a duplicate job)
curl -X POST http://localhost:3001/api/v1/plans/generations \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: llb-LLB-0047-2026-03-24" \
  -d '{ ... }'
```

---

## Remaining staging gates before production

1. **Auth layer** — Clerk (B2C) + Auth0 with HIPAA BAA (B2B). Blocked on Jarvis signing Auth0 agreement.
2. **Tenant isolation enforcement** — `tenantContextMiddleware` derives `clinicId` from JWT. Blocked on auth layer.
3. **`BUDGET_INFEASIBLE` (422)** — fire when `selectedItems` is empty after recipe matching.
4. **PHI staging gate test** — assert `ai_kernel_log.input` contains zero PHI-adjacent fields.
5. **Schema validation golden tests** — full pipeline against seeded golden dataset.
6. **`GET /api/v1/patients/:patientRef/plans`** — list plans for a patient within a clinic.
7. **OpenAPI spec** — per API_DESIGN_RULES.md §18; required before any external integrations.

---

## Session 2 (2026-03-22)

### What was built

- Target 3: Real `GET /api/v1/jobs/:jobId` + `GET /api/v1/plans/:planId`
- Target 4: Plan worker with `FOR UPDATE SKIP LOCKED` job claiming
- Target 5: `getPricesForWeek()` — deduped pricing query
- Target 6: Recipe Matcher — keyword traffic light + budget selection (upgraded in Session 3)
- Target 7: AI Kernel — bounded call + Zod schema validation + deterministic fallback
- Target 8: Full 8-step pipeline wired; `plans` table + `002_plans.sql` migration
- 20/20 tests passing

---

## Session 1 (2026-03-22)

### What was built

- Project scaffold (package.json, tsconfig.json, .env.example, .gitignore, docker-compose.yml)
- `src/types/plans.ts` — all core types
- `POST /api/v1/plans/generations` — validates request shape, checks pricing availability, enqueues job
- `src/services/nutritionRules.ts` — `resolveConstraints()` with full conflict resolution
- `db/migrations/001_plan_jobs.sql` + idempotent migration runner
- 6/6 nutrition rules tests passing
