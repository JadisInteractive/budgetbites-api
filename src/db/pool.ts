import "dotenv/config";
import { Pool } from "pg";

const useSsl = process.env.DATABASE_SSL === "true";

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: useSsl ? { rejectUnauthorized: false } : undefined,
    })
  : new Pool();

export { pool };
