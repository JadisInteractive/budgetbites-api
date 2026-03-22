import { pool } from "../db/pool";
import { PricingAvailability } from "../types/plans";

export async function checkPricingAvailability(
  chainId: string,
  storeId: string,
  weekOf: string
): Promise<PricingAvailability> {
  const result = await pool.query<{
    price_count: string;
    scrape_run_id: string | null;
  }>(
    `SELECT COUNT(*) AS price_count, MAX(scrape_run_id) AS scrape_run_id
     FROM grocery_prices
     WHERE chain_id = $1
       AND store_id = $2
       AND start_date <= $3
       AND end_date >= $3`,
    [chainId, storeId, weekOf]
  );

  const row = result.rows[0];
  const priceCount = parseInt(row?.price_count ?? "0", 10);

  return {
    available: priceCount > 0,
    scrapeRunId: row?.scrape_run_id ?? null,
    priceCount,
  };
}
