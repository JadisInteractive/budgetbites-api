# BudgetBites — Central API

**Product:** BudgetBites  
**Module:** Central API (`/api`)  
**Owner:** Jarvis Addison, Founder  
**Status:** Active development — MVP sprint

---

## What this module is

The Central API is the single gateway through which all BudgetBites frontend portals and
external integrations communicate with the backend. Nothing reaches the database, the AI
Kernel, or the Circular Scraper directly — everything passes through this API.

This module is the trust layer of the platform.

---

## Non-negotiable operating principle

**Rules compute. Models explain.**

- Prices must originate from verified store data in `grocery_prices` (written by the scraper)
- Macros must come from nutrition databases and explicit calculations
- Health constraints must derive from defined rules and verified user profiles
- The AI Kernel may categorize, summarize, explain tradeoffs, and assemble narratives
- The AI Kernel must never invent prices, macros, basket totals, ingredient quantities, or
  clinical guidance

If you are ever unsure whether a computation belongs in the AI layer or the deterministic
layer, it belongs in the deterministic layer.

---

## Stack

- **Runtime:** Node.js + TypeScript
- **Framework:** Express
- **Database:** PostgreSQL (shared with `grocery-scraper`)
- **AI integration:** AI Kernel module (bounded, called by API only — never directly from
  frontend or other services)
- **Auth:** Session-based (B2C) + API key scoped by clinicId (B2B)
- **Deployment:** Local → AWS ECS (Phase 3)

---

## Module relationships

```
grocery-scraper   →   grocery_prices DB   →   Central API   →   Frontend portals
                                           ↓
                                       AI Kernel (bounded)
```

The `grocery-scraper` writes pricing records. The Central API reads them.
The scraper's `GroceryPriceEntry` type is the canonical data shape for all pricing data.
Do not redefine it here — import or mirror it from the shared types layer.

---

## Directory structure (target)

```
api/
├── CLAUDE.md                  ← you are here
├── .agents/
│   ├── BACKEND_ENGINEER.md    ← agent instructions for backend build tasks
│   └── API_DESIGN_RULES.md    ← design rules (in progress — do not create without review)
├── src/
│   ├── app.ts
│   ├── index.ts
│   ├── routes/
│   │   └── plans.ts
│   ├── controllers/
│   ├── services/
│   │   ├── priceService.ts     ← reads from grocery_prices via scraper DB
│   │   ├── nutritionRules.ts   ← Nutrition Rules Engine
│   │   ├── recipeMatcher.ts
│   │   └── aiKernel.ts         ← bounded AI orchestration layer
│   ├── middleware/
│   ├── types/
│   │   └── plans.ts            ← PlanGenerateRequest, HealthConstraints, etc.
│   └── workers/
│       └── planWorker.ts       ← background job processor
├── db/
│   └── migrations/
├── docs/
└── package.json
```

---

## Primary endpoint (MVP)

### `POST /plans/generate`

Accepts a plan generation request from either the B2C or B2B portal.
Returns a job ID immediately — generation is asynchronous.

**Request shape:** See `src/types/plans.ts` and `.agents/BACKEND_ENGINEER.md`  
**Full spec:** See `.agents/API_DESIGN_RULES.md` (pending conversation with Jarvis)

Key fields:
- `context`: `"b2c"` or `"b2b_clinic"` — controls audit depth and AI tone
- `healthConstraints`: nested object — complete input contract for the Nutrition Rules Engine
- `chainId` / `storeId` / `weekOf`: must match existing records in `grocery_prices`
- `budgetUsd`: pre-buffer subtotal target (Price Engine applies 10% buffer internally)

**The AI Kernel is called at Step 6 of 8 in the generation pipeline — after all deterministic
computations are complete. Never before.**

---

## Audit requirements

Every generated plan must include:
- `traceId` — unique per generation event, present in all logs
- `scrapeRunId` — links every price to the scraper run that sourced it
- `constraintsHash` — SHA-256 of the `healthConstraints` object at generation time
- `rulesVersion` — which version of the Nutrition Rules Engine was active
- `fallbackUsed` — boolean, true if AI output failed schema validation

**B2B additional requirement:** `clinicalNotes` must be stored in the audit log only.
It must never appear in any AI Kernel call payload. This boundary is a staging gate —
it must be tested before B2B goes to production.

---

## Staging gates (must pass before production)

1. Schema validation passes for all three AI output schemas on golden test cases
2. Deterministic fallback logic confirmed for all AI failure modes
3. Idempotent plan generation: identical inputs → identical deterministic outputs
4. `clinicalNotes` confirmed absent from all `ai_kernel_log.input` records
5. `PRICING_DATA_UNAVAILABLE` (409) fires correctly when no scraper data exists for
   the requested `chainId` / `storeId` / `weekOf`
6. Tenant isolation confirmed: one `clinicId` cannot retrieve plans from another

---

## What NOT to do

- Do not call the AI model directly from a route handler or controller
- Do not compute prices, macros, or health constraint resolutions inside the AI Kernel
- Do not expose `patientRef`, `clinicId`, or `clinicalNotes` in any AI model call payload
- Do not allow a `weekOf` value to be accepted if no pricing data exists for that week
- Do not skip schema validation on AI outputs — use the deterministic fallback instead
- Do not use `any` types — this is a clinically auditable system

---

## Related modules

| Module | Location | Role |
|---|---|---|
| Grocery Scraper | `../grocery-scraper` | Writes pricing records to `grocery_prices` |
| B2B Portal (LLB) | `../budgetbite-llb` | Pilot clinic frontend — Lively Live Better |
| B2C Platform | `../front-end` | Consumer mobile-friendly frontend |
| Admin Dashboard | `../admin-dashboard` | Product Owner Portal |

---

*This file is the authoritative context document for any AI agent or engineer working in
this module. Read it before writing a single line of code.*
