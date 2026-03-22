import { pool } from "../db/pool";
import { GroceryPriceEntry, PricingAvailability } from "../types/plans";

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

// Retrieves all price records for a given chain/store/weekOf combination.
// Mirrors the getLatestPrices() pattern from ../grocery-scraper/src/services/dataService.ts
// but scoped to a specific week (start_date <= weekOf AND end_date >= weekOf).
export async function getPricesForWeek(
  chainId: string,
  storeId: string,
  weekOf: string
): Promise<GroceryPriceEntry[]> {
  const result = await pool.query<GroceryPriceEntry>(
    `SELECT
       gp.scrape_run_id,
       gp.chain_id,
       gp.store_id,
       gs.store_name,
       gs.region,
       gp.product_name,
       gp.price,
       gp.sale_type,
       gp.start_date,
       gp.end_date,
       gp.circular_url,
       gp.last_updated,
       gp.created_at
     FROM grocery_prices gp
     JOIN grocery_stores gs
       ON gs.chain_id = gp.chain_id AND gs.store_id = gp.store_id
     JOIN (
       SELECT chain_id, store_id, product_name, MAX(last_updated) AS max_last_updated
       FROM grocery_prices
       WHERE chain_id = $1
         AND store_id = $2
         AND start_date <= $3
         AND end_date   >= $3
       GROUP BY chain_id, store_id, product_name
     ) latest
       ON  latest.chain_id       = gp.chain_id
       AND latest.store_id       = gp.store_id
       AND latest.product_name   = gp.product_name
       AND latest.max_last_updated = gp.last_updated
     WHERE gp.chain_id = $1
       AND gp.store_id = $2
       AND gp.start_date <= $3
       AND gp.end_date   >= $3
     ORDER BY gp.price ASC`,
    [chainId, storeId, weekOf]
  );

  return result.rows.map((row) => ({
    ...row,
    price: Number(row.price),
  }));
}
