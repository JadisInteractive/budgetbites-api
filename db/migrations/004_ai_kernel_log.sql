-- AI Kernel audit log — records every model call for observability and PHI compliance.
--
-- PHI STAGING GATE: input column must NEVER contain patientRef, clinicId, or
-- clinicalNotes. This is asserted by a test before B2B goes to production.
-- The AI Kernel's buildUserContent() function is the enforcement point.

CREATE TABLE IF NOT EXISTS ai_kernel_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_call_id TEXT NOT NULL UNIQUE,
  plan_id       UUID,           -- no FK constraint: plan may not exist if pipeline failed early
  trace_id      TEXT NOT NULL,
  model         TEXT NOT NULL,
  input         JSONB NOT NULL, -- deterministic payload only — PHI staging gate column
  output        JSONB,          -- AI output, or null if fallback used
  fallback_used BOOLEAN NOT NULL DEFAULT FALSE,
  latency_ms    INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_kernel_log_trace_id_idx ON ai_kernel_log(trace_id);
CREATE INDEX IF NOT EXISTS ai_kernel_log_plan_id_idx  ON ai_kernel_log(plan_id);
