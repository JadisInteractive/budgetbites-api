import "dotenv/config";
import { promises as fs } from "fs";
import path from "path";
import { Pool } from "pg";

const migrationsDir = path.resolve(process.cwd(), "db", "migrations");

function buildPool(): Pool {
  const useSsl = process.env.DATABASE_SSL === "true";
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required to run migrations.");
  }
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
  });
}

async function ensureMigrationsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id BIGSERIAL PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function loadMigrationFiles(): Promise<string[]> {
  const entries = await fs.readdir(migrationsDir);
  return entries
    .filter((file) => file.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));
}

async function getAppliedMigrations(pool: Pool): Promise<Set<string>> {
  const result = await pool.query(`SELECT filename FROM schema_migrations`);
  return new Set(result.rows.map((row: { filename: string }) => row.filename));
}

async function runMigration(pool: Pool, filename: string): Promise<void> {
  const fullPath = path.join(migrationsDir, filename);
  const sql = await fs.readFile(fullPath, "utf8");
  await pool.query("BEGIN");
  try {
    await pool.query(sql);
    await pool.query(
      `INSERT INTO schema_migrations (filename) VALUES ($1)`,
      [filename]
    );
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
}

async function main(): Promise<void> {
  const pool = buildPool();
  try {
    await ensureMigrationsTable(pool);
    const migrationFiles = await loadMigrationFiles();
    const applied = await getAppliedMigrations(pool);
    const pending = migrationFiles.filter((file) => !applied.has(file));

    if (pending.length === 0) {
      console.log("No pending migrations.");
      return;
    }

    for (const file of pending) {
      console.log(`Applying migration: ${file}`);
      await runMigration(pool, file);
    }

    console.log(`Applied ${pending.length} migration(s).`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Migration failed:", error);
  process.exitCode = 1;
});
