import { pool } from "../db/pool";
import { PlanGenerateRequest, PlanJobStatus } from "../types/plans";

// ---------------------------------------------------------------------------
// Row type for plan_jobs (internal — not exported as an API type)
// ---------------------------------------------------------------------------
interface PlanJobRow {
  id: string;
  trace_id: string;
  status: PlanJobStatus;
  request: PlanGenerateRequest;
  clinic_id: string | null;
  patient_ref: string | null;
  plan_id: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error_message: string | null;
}

export async function enqueueJob(
  request: PlanGenerateRequest,
  traceId: string
): Promise<string> {
  // clinicId and patientRef are stored in their own audit columns,
  // NOT embedded in the request JSONB, to enforce the PHI boundary.
  const { clinicId, patientRef, clinicalNotes: _clinicalNotes, ...safeRequest } = request;

  const result = await pool.query<{ id: string }>(
    `INSERT INTO plan_jobs (trace_id, status, request, clinic_id, patient_ref)
     VALUES ($1, 'queued', $2, $3, $4)
     RETURNING id`,
    [
      traceId,
      JSON.stringify(safeRequest),
      clinicId ?? null,
      patientRef ?? null,
    ]
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error("Failed to insert plan job — no row returned.");
  }

  return row.id;
}

// Claims the next queued job atomically using FOR UPDATE SKIP LOCKED.
// Mirrors claimNextScrapeJob() in grocery-scraper/src/services/dataService.ts.
export async function claimNextPlanJob(): Promise<PlanJobRow | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<PlanJobRow>(
      `SELECT id, trace_id, status, request, clinic_id, patient_ref, plan_id,
              created_at, started_at, finished_at, error_message
       FROM plan_jobs
       WHERE status = 'queued'
       ORDER BY created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1`
    );

    const job = result.rows[0];
    if (!job) {
      await client.query("COMMIT");
      return null;
    }

    await client.query(
      `UPDATE plan_jobs
       SET status = 'processing', started_at = NOW()
       WHERE id = $1`,
      [job.id]
    );

    await client.query("COMMIT");
    return { ...job, status: "processing" };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getPlanJob(jobId: string): Promise<PlanJobRow | null> {
  const result = await pool.query<PlanJobRow>(
    `SELECT id, trace_id, status, request, clinic_id, patient_ref, plan_id,
            created_at, started_at, finished_at, error_message
     FROM plan_jobs
     WHERE id = $1`,
    [jobId]
  );
  return result.rows[0] ?? null;
}

export async function updatePlanJobStatus(
  jobId: string,
  status: Exclude<PlanJobStatus, "queued" | "processing">,
  errorMessage?: string
): Promise<void> {
  await pool.query(
    `UPDATE plan_jobs
     SET status = $1,
         finished_at = NOW(),
         error_message = $2
     WHERE id = $3`,
    [status, errorMessage ?? null, jobId]
  );
}

export async function completePlanJob(
  jobId: string,
  planId: string
): Promise<void> {
  await pool.query(
    `UPDATE plan_jobs
     SET status = 'complete',
         finished_at = NOW(),
         plan_id = $1
     WHERE id = $2`,
    [planId, jobId]
  );
}
