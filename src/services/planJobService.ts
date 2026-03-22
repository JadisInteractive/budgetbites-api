import { pool } from "../db/pool";
import { PlanGenerateRequest } from "../types/plans";

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
