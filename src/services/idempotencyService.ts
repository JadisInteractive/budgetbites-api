import { createHash } from "crypto";
import { pool } from "../db/pool";

interface IdempotencyRow {
  key: string;
  request_hash: string;
  response_status: number;
  response_body: unknown;
}

export function hashRequestBody(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

// Returns a stored record if the key exists and has not expired.
export async function getIdempotencyRecord(
  key: string
): Promise<IdempotencyRow | null> {
  const result = await pool.query<IdempotencyRow>(
    `SELECT key, request_hash, response_status, response_body
     FROM idempotency_keys
     WHERE key = $1 AND expires_at > NOW()`,
    [key]
  );
  return result.rows[0] ?? null;
}

// Saves a record. Uses ON CONFLICT DO NOTHING — if a concurrent request already
// saved the key, this is a no-op (the first writer wins).
export async function saveIdempotencyRecord(
  key: string,
  requestHash: string,
  responseStatus: number,
  responseBody: unknown
): Promise<void> {
  await pool.query(
    `INSERT INTO idempotency_keys (key, request_hash, response_status, response_body)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (key) DO NOTHING`,
    [key, requestHash, responseStatus, JSON.stringify(responseBody)]
  );
}
