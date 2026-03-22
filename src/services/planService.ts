import { pool } from "../db/pool";
import { MealPlanPacket, PlanRecord, PlanStatus } from "../types/plans";

// ---------------------------------------------------------------------------
// DB row shape (snake_case) — mapped to PlanRecord (camelCase) on read
// ---------------------------------------------------------------------------
interface PlanRow {
  id: string;
  job_id: string;
  trace_id: string;
  scrape_run_id: string | null;
  constraints_hash: string;
  rules_version: string;
  status: PlanStatus;
  packet: MealPlanPacket | null;
  fallback_used: boolean;
  model_call_id: string | null;
  generated_at: string | null;
  created_at: string;
}

function mapRow(row: PlanRow): PlanRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    traceId: row.trace_id,
    scrapeRunId: row.scrape_run_id,
    constraintsHash: row.constraints_hash,
    rulesVersion: row.rules_version,
    status: row.status,
    packet: row.packet,
    fallbackUsed: row.fallback_used,
    modelCallId: row.model_call_id,
    generatedAt: row.generated_at,
    createdAt: row.created_at,
  };
}

// Creates a plan record in 'generating' status when the worker begins processing.
export async function createPlan(
  jobId: string,
  traceId: string,
  scrapeRunId: string | null,
  constraintsHash: string,
  clinicId: string | null,
  patientRef: string | null,
  clinicalNotes: string | null
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO plans
       (job_id, trace_id, scrape_run_id, constraints_hash, status,
        clinic_id, patient_ref, clinical_notes)
     VALUES ($1, $2, $3, $4, 'generating', $5, $6, $7)
     RETURNING id`,
    [jobId, traceId, scrapeRunId, constraintsHash, clinicId, patientRef, clinicalNotes]
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error("Failed to create plan record — no row returned.");
  }
  return row.id;
}

// Persists the completed packet and marks the plan as 'complete'.
export async function completePlan(
  planId: string,
  packet: MealPlanPacket,
  fallbackUsed: boolean,
  modelCallId: string
): Promise<void> {
  await pool.query(
    `UPDATE plans
     SET status         = 'complete',
         packet         = $1,
         fallback_used  = $2,
         model_call_id  = $3,
         generated_at   = NOW()
     WHERE id = $4`,
    [JSON.stringify(packet), fallbackUsed, modelCallId, planId]
  );
}

// Marks a plan as 'failed' with an error message.
export async function failPlan(
  planId: string,
  errorMessage: string
): Promise<void> {
  await pool.query(
    `UPDATE plans
     SET status = 'failed',
         generated_at = NOW()
     WHERE id = $1`,
    [planId]
  );
  // Store error on the job row (plan row has no error_message column)
  void errorMessage; // surfaced on plan_jobs.error_message instead
}

export async function getPlan(planId: string): Promise<PlanRecord | null> {
  const result = await pool.query<PlanRow>(
    `SELECT id, job_id, trace_id, scrape_run_id, constraints_hash, rules_version,
            status, packet, fallback_used, model_call_id, generated_at, created_at
     FROM plans
     WHERE id = $1`,
    [planId]
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}
