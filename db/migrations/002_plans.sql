-- Plans table: persists the completed meal plan packet for each generation job.
-- clinical_notes are stored here ONLY — never in ai_kernel_log or the packet JSONB.

CREATE TABLE IF NOT EXISTS plans (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id           UUID NOT NULL REFERENCES plan_jobs(id),
  trace_id         TEXT NOT NULL,
  scrape_run_id    TEXT,
  constraints_hash TEXT NOT NULL,
  rules_version    TEXT NOT NULL DEFAULT 'rules_v1.0',
  status           TEXT NOT NULL DEFAULT 'generating',
  packet           JSONB,
  fallback_used    BOOLEAN NOT NULL DEFAULT FALSE,
  model_call_id    TEXT,
  generated_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- B2B audit columns — never surfaced through the API or AI Kernel
  clinic_id        TEXT,
  patient_ref      TEXT,
  clinical_notes   TEXT
);

CREATE INDEX IF NOT EXISTS plans_job_id_idx ON plans(job_id);
CREATE INDEX IF NOT EXISTS plans_status_idx  ON plans(status);

-- Add plan_id back-reference to plan_jobs so the job status poll can return the planId.
ALTER TABLE plan_jobs ADD COLUMN IF NOT EXISTS plan_id UUID;
