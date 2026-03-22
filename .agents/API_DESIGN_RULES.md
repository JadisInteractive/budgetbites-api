# API Design Rules
# BudgetBites Central API — v1
# Authored by: Jarvis Addison
# Status: Active — apply to all API work from day one

---

## The short version

- External APIs are versioned from day one: `/api/v1/...`
- Resources return direct payloads. Envelopes only for jobs, batches, and workflows.
- Nested routes for ownership context. Top-level filtered routes for admin/reporting.
- One auth architecture. Different credential modes per channel. Not separate stacks.
- Tenant isolation is enforced at the query layer, not only middleware.
- PHI never enters AI model call payloads.

---

## 1. Versioning

### External API
Use URL versioning from day one for all clinic-facing and consumer-facing endpoints.

```
/api/v1/plans
/api/v1/patients/{patientRef}/plans
/api/v1/clinics/me
```

Clinics integrating against BudgetBites care about contract stability, not internal
historical naming conventions. Unversioned APIs create avoidable pain the moment mobile
clients, clinic portals, exports, or partner integrations exist.

Versioning signals maturity, documentation discipline, and rollout control — not just
breaking change management.

### Internal and operational endpoints
Internal services, scraper pipelines, and admin tools do not need to follow the external
versioning convention. Use separate namespaces:

```
/internal/circular-ingestion
/internal/price-refresh
/internal/plan-workers
/internal/ai-explanations
/ops/...
/health
/ready
/metrics
```

Do not let the scraper's existing `/api/` convention dictate clinic-facing API design.
They are separate concerns.

### Version lifecycle rules
- Keep `v1` stable and boring.
- Prefer additive changes inside `v1`.
- Reserve `v2` for true contract breaks: renamed fields, semantic changes, removed fields,
  changed auth expectations, changed pagination format.
- Additive fields are allowed in `v1`.
- Fields are never silently repurposed.
- `nullable` vs `optional` semantics must be explicit in the schema.
- Enum expansion is allowed. Clients must tolerate unknown enum values.

### Base paths

| Surface | Base path |
|---|---|
| External / clinic-facing | `/api/v1` |
| Internal services | `/internal/v1` or `/internal` |
| Health / admin / metrics | `/health`, `/ready`, `/metrics` |

---

## 2. Response shape

### Standard resource endpoints — return the resource directly

Do not wrap responses in `{ success: true, data: {...} }`.

```json
{
  "id": "plan_123",
  "patientRef": "LLB-0047",
  "status": "completed",
  "createdAt": "2026-03-21T22:10:00Z"
}
```

`{ success: true }` duplicates what 2xx/4xx/5xx already communicate. It adds noise to
every client and blurs the line between transport errors and domain errors.

### List endpoints — use a consistent pagination envelope

```json
{
  "items": [...],
  "page": 1,
  "pageSize": 20,
  "total": 87,
  "nextCursor": null
}
```

### Error responses — always this shape

```json
{
  "error": {
    "code": "PLAN_NOT_FOUND",
    "message": "No plan was found for the specified identifier.",
    "details": {
      "planId": "plan_123"
    },
    "requestId": "req_abc123"
  }
}
```

Clients must not parse freeform error messages to determine behavior. The `code` field
is the stable machine-readable signal. See the error catalog below.

### Workflow and job endpoints — use a structured envelope

Async generation, batch operations, and AI orchestration results are the exception where
an envelope is appropriate:

```json
{
  "jobId": "job_456",
  "status": "queued",
  "planId": null,
  "submittedAt": "2026-03-21T22:10:00Z"
}
```

---

## 3. Resource model

Define core resources explicitly. Do not let `/plans` become a dumping ground.

| Resource | Notes |
|---|---|
| `Clinic` | Tenant root |
| `Patient` | Scoped to a clinic |
| `Plan` | The generated meal plan packet |
| `PlanRevision` | Versioned history of a plan |
| `GenerationJob` | Async job tracking plan generation |
| `Circular` | Weekly store ad data (from scraper) |
| `PriceSnapshot` | Point-in-time pricing record |
| `Recipe` | A meal combination produced by the Recipe Matcher |
| `RecommendationExplanation` | AI-generated narrative layer |
| `AuditEvent` | Immutable audit record per plan generation |

---

## 4. Route structure and nesting

### Recommended route surface

```
/api/v1
  /auth
  /patients
  /patients/{patientRef}
  /patients/{patientRef}/plans
  /plans
  /plans/{planId}
  /plans/generations          ← async generation job submission
  /jobs/{jobId}               ← async job status polling
  /clinics/me
  /recipes
  /circulars
```

### Rule: nested routes express ownership. Top-level routes enable search.

Use nested routes when the caller is operating within the context of a specific resource:

```
GET /api/v1/patients/LLB-0047/plans?status=completed&limit=20
```

Use top-level filtered routes for admin tools, exports, reporting, and cross-cutting
queries:

```
GET /api/v1/plans?clinicId=llb&status=completed&createdAfter=2026-01-01
```

### Do not over-nest

This is brittle and must be avoided:

```
/clinics/:clinicId/patients/:patientRef/plans/:planId/revisions/...
```

Keep URLs readable. Let auth and scoping enforce tenant ownership — not URL depth.

---

## 5. Naming and semantics

Prefer nouns over verbs except for clear workflow actions:

```
POST /api/v1/plans/generations     ← correct
POST /api/v1/plans/generatePlanNow ← incorrect
```

Resource names are plural nouns. Actions on resources use HTTP method semantics.

Use `camelCase` for all JSON field names. Use `snake_case` at the database layer.
The API surface is always `camelCase`.

---

## 6. Pagination

For MVP, offset/page pagination is acceptable for modest result sets.

For anything expected to grow or sorted by recency, use cursor pagination:

```
GET /api/v1/patients/LLB-0047/plans?limit=20&cursor=eyJpZCI6...
```

Pagination rules:
- Default sort: `createdAt DESC`
- Default page size: 20
- Maximum page size: 100
- Cursor-based pagination is preferred for plan history feeds
- Include `nextCursor: null` when there are no further pages

---

## 7. Async plan generation

Plan generation must be asynchronous.

Scraping, pricing, nutrition rules, recipe matching, and AI explanation all increase
latency and failure surface. Async gives you retries, observability, and idempotency.

```
POST /api/v1/plans/generations
→ 202 Accepted
→ { jobId, status: "queued", planId: null, submittedAt }

GET /api/v1/jobs/{jobId}
→ { status: "processing" }   // poll
→ { status: "complete", planId: "plan_..." }
→ { status: "failed", error }

GET /api/v1/plans/{planId}
→ full plan resource when complete
```

Frontend poll interval: every 1500ms, max 20 attempts.

---

## 8. Idempotency

Require `Idempotency-Key` on all `POST` endpoints for plan generation and any billable
or expensive operation.

```
POST /api/v1/plans/generations
Idempotency-Key: clinic-llb-patient-0047-week-20260318
```

Behavior:
- Store the request fingerprint and result
- Replay safely on duplicate submissions — return the original result
- Clinic coordinators double-submitting or network retries must not create duplicate plans

---

## 9. Authentication and authorization

Use one auth architecture with different credential modes per channel. Not separate stacks.

### Credential modes by channel

| Channel | Credential type |
|---|---|
| B2C consumer web/mobile | Session cookie or short-lived JWT + refresh flow |
| B2B clinic portal (web) | Session cookie for portal users |
| Server-to-server / partners | API key or OAuth client credentials |
| Internal services | Service tokens / signed machine credentials |

### Shared auth model

Every authenticated principal carries:

```typescript
{
  actorType: "consumer" | "clinic_user" | "admin" | "service",
  tenantId?: string,    // clinicId for clinic actors
  scopes: string[],     // e.g. ["plans:read", "plans:write", "patients:read"]
  roles: string[]       // e.g. ["coordinator", "clinician", "admin"]
}
```

Defined scopes:
- `plans:read` · `plans:write`
- `patients:read` · `patients:write`
- `circulars:ingest`
- `admin:read` · `admin:write`

### Critical rule: never trust client-supplied tenant context

Do not rely on `clinicId` passed by clients as trusted scope. Derive tenant context from
the authenticated principal. A coordinator cannot access another clinic's data by
passing a different `clinicId` in the request body.

### Benefits of one architecture

- One authorization policy engine
- One audit trail model
- One tenant isolation model
- Fewer edge-case bugs across B2C and B2B surfaces

---

## 10. Tenant isolation

Multi-tenancy is a first-class design constraint, not a later add-on.

Rules:
- Every `Plan` belongs to a tenant
- Every `patientRef` is unique within a tenant, not assumed globally unique
- All reads and writes must enforce the tenant boundary at the **query layer**, not only
  in middleware
- A missing or mismatched `clinicId` returns `403 CLINIC_TENANT_MISMATCH`
- Tenant context is derived from the authenticated principal, not the request body

---

## 11. Patient identifiers

Prefer tenant-facing references over raw internal database IDs in API responses.

```
internal immutable ID:    pat_01jwx4...       (used internally, in foreign keys)
external clinic-visible:  LLB-0047            (used in API responses and URLs)
```

Both are supported internally. Expose the right one for the audience.

`patientRef` must match pattern `/^[A-Z0-9\-]{3,40}$/` and must never contain PHI
(names, dates of birth, SSN formats). Validated on every inbound request.

---

## 12. PHI and sensitive data discipline

Design as though regulated sensitivity may expand over time.

Rules:
- Keep minimal patient-identifying data in this service
- Prefer references over unnecessary demographics
- `clinicalNotes` is stored in the audit log only — it must never appear in any AI model
  call payload or `ai_kernel_log.input` record
- `patientRef` and `clinicId` must never appear in AI model call payloads
- Redact sensitive fields in all request/response logs
- Encrypt sensitive fields at rest
- Separate clinical notes from plan-generation payloads at the service boundary

**This is a staging gate.** A test must explicitly assert that no PHI-adjacent field
appears in any `ai_kernel_log.input` record before B2B ships.

---

## 13. Error catalog

Use this stable set of error codes. Do not invent new codes without updating this catalog.

| Code | HTTP | When it fires |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Missing required fields, invalid enum values, failed schema |
| `INVALID_PATIENT_REF` | 400 | `patientRef` matches PHI-like pattern |
| `UNAUTHORIZED` | 401 | No valid auth token or session |
| `FORBIDDEN` | 403 | Valid token, insufficient scope or role |
| `CLINIC_TENANT_MISMATCH` | 403 | Authenticated clinicId ≠ request clinicId |
| `NOT_FOUND` | 404 | Resource does not exist |
| `CONFLICT` | 409 | State conflict — e.g. duplicate idempotency key |
| `PRICING_DATA_UNAVAILABLE` | 409 | No pricing records for chainId/storeId/weekOf |
| `BUDGET_INFEASIBLE` | 422 | Budget cannot satisfy household model + constraints |
| `RATE_LIMITED` | 429 | Too many requests |
| `PLAN_GENERATION_FAILED` | 500 | Generation pipeline failure |
| `AI_SCHEMA_FAILURE` | 500 | AI output + deterministic fallback both failed |
| `DEPENDENCY_UNAVAILABLE` | 503 | Upstream dependency (DB, AI model) unreachable |
| `INTERNAL_ERROR` | 500 | Unhandled — always include `requestId` |

Clients must branch on `error.code`, not on `error.message`. Messages are for humans.

---

## 14. Validation

Validate at the edge on the way in, and validate AI outputs on the way out.

- All inbound requests are validated against a schema before reaching any service layer
- AI Kernel outputs are validated against a locked schema before being persisted
- If AI output fails schema validation, the deterministic fallback template is used
- `fallbackUsed: true` is recorded in the audit log when the fallback fires
- Use a shared DTO/schema library — do not duplicate validation logic across routes

---

## 15. Observability

From day one, every request must emit:

- Request ID (included in all responses as `requestId`)
- Structured log entry: actor, tenant, endpoint, latency, status code
- Per-endpoint latency
- Dependency timing (DB query time, AI Kernel call time, scraper data retrieval)
- Audit events for all clinic-actor writes

Store request fingerprint and result for idempotency replay.

---

## 16. BFF consideration

BudgetBites has two frontend surfaces (B2C and B2B). The recommended approach:

- One core domain API (`/api/v1`)
- Optional thin BFF (Backend for Frontend) adapters only when UI-specific aggregation
  becomes noisy enough to warrant it

Do not build separate BFF layers prematurely. Add them when the pain is real, not
anticipated.

---

## 17. Internal vs external domain separation

Three major planes — keep them separate:

| Plane | Surface |
|---|---|
| Client-facing platform | `/api/v1` |
| Domain API / business logic | Services behind the API boundary |
| Worker / integration / AI pipeline | `/internal`, background workers |

Do not let the public API call scraper or AI code directly. All pricing retrieval,
nutrition rule resolution, and AI orchestration happens in services behind the API
boundary — never in route handlers.

---

## 18. API documentation

Generate documentation from code and schema, not prose alone.

Requirements:
- OpenAPI spec maintained alongside the codebase
- Example requests and responses for every endpoint
- Auth rules documented per endpoint
- Error codes listed per endpoint
- Pagination behavior documented
- Idempotency behavior documented

---

*This document is a build contract. Apply these rules from the first line of code.*
*Update this file when a rule changes — do not let the code and the rules diverge.*
