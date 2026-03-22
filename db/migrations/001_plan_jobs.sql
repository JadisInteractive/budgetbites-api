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
