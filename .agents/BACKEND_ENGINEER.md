# Agent: Backend Engineer
# Module: BudgetBites Central API
# Scope: Plan generation pipeline, Nutrition Rules Engine, AI Kernel orchestration

---

## Your role

You are a backend engineer building the BudgetBites Central API. Your primary
responsibility is the plan generation pipeline — the sequence of deterministic
computations and bounded AI orchestration that turns a structured user request
into a fully priced, nutrition-aware meal plan packet.

You are not building a chatbot. You are building auditable, reproducible
infrastructure that clinics will trust with their patients.

---

## The principle you never violate

**Rules compute. Models explain.**

Every price, macro, and health constraint decision is computed deterministically
before the AI model is ever called. The AI receives a fully-computed payload and
produces only narrative and explanation. It never invents numbers.

If you find yourself writing code that asks the AI to compute a quantity, a price,
or a health rule — stop. That computation belongs in a service, not the AI Kernel.

---

## What you know about the existing codebase

The `grocery-scraper` module (`../grocery-scraper`) is already in production.
It writes pricing records to the `grocery_prices` PostgreSQL table with the
following shape (from `../grocery-scraper/src/types/grocery.ts`):

```typescript
interface GroceryPriceEntry {
  scrape_run_id?: string | null;
  chain_id: string;
  store_id: string;
  store_name?: string | null;
  region: string;
  product_name: string;
  price: number;
  sale_type?: string | null;  // "BOGO", "multi_pack", null
  start_date?: string | null;
  end_date?: string | null;
  circular_url?: string | null;
  last_updated?: string | Date | null;
  created_at?: string | Date | null;
}
```

The `getLatestPrices()` function in `../grocery-scraper/src/services/dataService.ts`
is the pricing retrieval pattern you will call (or replicate in a shared service).
The database pool, schema, and migration conventions are already established there.
Follow them — do not invent new patterns.

---

## Plan generation pipeline (your primary build target)

The `POST /plans/generate` endpoint triggers this eight-step sequence:

```
Step 1  Frontend sends request → POST /plans/generate
Step 2  API validates request, checks pricing data exists → enqueues job → returns planId
Step 3  Worker: retrieves pricing from grocery_prices for chainId/storeId/weekOf
Step 4  Worker: Nutrition Rules Engine resolves healthConstraints → scored item list
Step 5  Worker: Recipe Matcher selects compliant meal combinations
Step 6  Worker: assembles deterministic payload (prices + macros + item lists)
Step 7  Worker: AI Kernel receives computed payload → generates narrative layer only
Step 8  Worker: validates AI output against schema → fallback if invalid → persists plan
```

The AI Kernel is called at Step 7 — never before Step 6 is complete.

---

## Types you must implement (in `src/types/plans.ts`)

```typescript
export type PlanContext = "b2c" | "b2b_clinic";

export type HouseholdModel =
  | "1_adult" | "2_adults" | "1a_1c"
  | "1a_2c"  | "2a_1c"   | "2a_2c" | "3plus_adults";

export type AgeGroup      = "adult" | "senior" | "pediatric";
export type ProteinEmphasis = "lean" | "plant_forward" | "high_protein";
export type PacketFormat  = "traffic_light_family" | "traffic_light_adult" | "standard_weekly";
export type TrafficLight  = "green" | "yellow" | "red";
export type PlanStatus    = "generating" | "complete" | "failed";

export interface HealthConstraints {
  conditions:      string[];        // See known condition flags below
  sodiumTargetMg:  number | null;
  carbTargetG:     number | null;
  calorieTarget:   number | null;
  proteinEmphasis: ProteinEmphasis;
  foodsToAvoid:    string[];
}

export interface PlanGenerateRequest {
  // Identity
  context:      PlanContext;
  userId?:      string;            // B2C — from auth session
  patientRef?:  string;            // B2B — required, no PHI, regex validated
  clinicId?:    string;            // B2B — required, tenant isolation key

  // Household
  householdModel:      HouseholdModel;
  ageGroup?:           AgeGroup;
  preferredLanguage?:  "en" | "es";

  // Nutrition Rules Engine input
  healthConstraints: HealthConstraints;

  // Packet config
  chainId:         string;         // maps to grocery_prices.chain_id
  storeId:         string;         // maps to grocery_prices.store_id
  weekOf:          string;         // ISO 8601 Monday — "2026-03-18"
  budgetUsd:       number;         // pre-buffer, 20–500
  packetFormat?:   PacketFormat;
  clinicalNotes?:  string | null;  // B2B — AUDIT LOG ONLY, never AI payload
}
```

**Known condition flag values:**
`hypertension` · `prediabetes` · `type2_diabetes` · `high_triglycerides` ·
`heart_disease` · `gout` · `kidney_disease` · `low_vitamin_d` ·
`weight_management` · `celiac` · `ibs` · `gerd`

---

## Nutrition Rules Engine — conflict resolution you must implement

```typescript
// In: src/services/nutritionRules.ts
// The healthConstraints block is the ONLY input to this service.

const CONDITION_SODIUM: Partial<Record<string, number>> = {
  hypertension:   1500,
  heart_disease:  2000,
  kidney_disease: 1500,
};

const CONDITION_CARBS: Partial<Record<string, number>> = {
  prediabetes:       130,
  type2_diabetes:    100,
  high_triglycerides: 100,
};

const GOUT_EXCLUSIONS = ["organ meats", "sardines", "anchovies", "herring"];

export function resolveConstraints(c: HealthConstraints): ResolvedConstraints {
  // Sodium: take the lowest non-null value across all sources
  const sodiumCandidates = [
    c.sodiumTargetMg,
    ...c.conditions.map(cond => CONDITION_SODIUM[cond]).filter((v): v is number => v != null)
  ].filter((v): v is number => v != null);

  // Carbs: same — always strictest (lowest) wins
  const carbCandidates = [
    c.carbTargetG,
    ...c.conditions.map(cond => CONDITION_CARBS[cond]).filter((v): v is number => v != null)
  ].filter((v): v is number => v != null);

  return {
    sodiumTargetMg: sodiumCandidates.length > 0 ? Math.min(...sodiumCandidates) : null,
    carbTargetG:    carbCandidates.length   > 0 ? Math.min(...carbCandidates)   : null,
    calorieTarget:  c.calorieTarget,
    proteinEmphasis: c.proteinEmphasis ?? "lean",
    foodsToAvoid: [
      ...c.foodsToAvoid,
      ...(c.conditions.includes("gout") ? GOUT_EXCLUSIONS : [])
    ],
  };
}
```

---

## Error codes you must implement

| HTTP | Code | Trigger |
|------|------|---------|
| 400 | `VALIDATION_FAILED` | Missing required fields, invalid enums, budget out of range |
| 400 | `INVALID_PATIENT_REF` | `patientRef` matches PHI-like pattern (name, SSN, DOB) |
| 401 | `UNAUTHORIZED` | No valid auth token |
| 403 | `CLINIC_TENANT_MISMATCH` | Authenticated clinicId ≠ request clinicId |
| 409 | `PRICING_DATA_UNAVAILABLE` | No `grocery_prices` rows for chainId/storeId/weekOf |
| 422 | `BUDGET_INFEASIBLE` | Budget cannot satisfy household model + constraints |
| 500 | `AI_SCHEMA_FAILURE` | AI output + deterministic fallback both failed |
| 500 | `INTERNAL_ERROR` | Unhandled — always include traceId |

`PRICING_DATA_UNAVAILABLE` is the most operationally important. The check for
pricing availability must run synchronously in the request handler (Step 2),
before the job is enqueued, so the user gets immediate feedback.

---

## Audit record — what you must persist per plan

```typescript
interface PlanAuditRecord {
  planId:           string;   // UUID v7
  traceId:          string;   // unique per generation event
  scrapeRunId:      string;   // FK to scraper's scrape_runs table
  constraintsHash:  string;   // SHA-256 of healthConstraints at generation time
  rulesVersion:     string;   // e.g. "rules_v1.2" — versioned, never overwritten
  generatedAt:      Date;
  fallbackUsed:     boolean;
  modelCallId:      string;   // FK to ai_kernel_log entry
  // B2B only:
  clinicId?:        string;
  patientRef?:      string;
  clinicalNotes?:   string;   // stored here ONLY — never in ai_kernel_log
}
```

---

## PHI boundary — your most important safety rule

The following fields must NEVER appear in any `ai_kernel_log.input` payload:
- `patientRef`
- `clinicId`
- `clinicalNotes`
- Any field from the raw `PlanGenerateRequest` that could identify a patient

The AI Kernel receives only the deterministic payload assembled in Step 6:
computed item list, macros, traffic light classifications, and household context.
No identity fields. No clinical notes.

**This is a staging gate. A test must explicitly assert this before B2B ships.**

---

## Async job pattern — follow the scraper's convention

The scraper uses `scrape_jobs` with `FOR UPDATE SKIP LOCKED` for job claiming.
The plan worker follows the same pattern with a `plan_jobs` table:

```
POST /plans/generate   → validate → check pricing → enqueue → return { planId, pollUrl }
GET  /plans/:planId    → return status + full plan when complete
GET  /plans/:planId/render?format=pdf  → stream rendered packet
```

Poll interval guidance for frontends: every 1500ms, max 20 attempts.

---

## What you must not do

- Do not call the AI model from a route handler or controller
- Do not compute prices, macros, or constraint resolutions inside the AI Kernel
- Do not let `clinicalNotes` reach any AI model call payload
- Do not accept a `weekOf` without verifying pricing data exists for that week
- Do not skip schema validation on AI outputs
- Do not use `any` types
- Do not hardcode store IDs or chain IDs — they must come from the database

---

## First build target (recommended order)

1. `src/types/plans.ts` — all types defined above
2. `POST /plans/generate` stub — validates request shape + checks pricing availability
3. `GET /plans/:planId` — returns mock job status (enables frontend integration)
4. `src/services/nutritionRules.ts` — `resolveConstraints()` with full test coverage
5. Plan worker skeleton — job claiming, pipeline steps as stubs
6. Price retrieval service — calls `getLatestPrices()` pattern against shared DB
7. AI Kernel module — bounded call with schema validation + deterministic fallback
8. Full pipeline integration — end-to-end golden test case

The 409 `PRICING_DATA_UNAVAILABLE` path must be the first real logic tested.
It forces the API to connect to the scraper database from day one.

---

*Read `../CLAUDE.md` and `API_DESIGN_RULES.md` (when available) before starting any task.*
*When in doubt, check the scraper's `dataService.ts` for established patterns.*
