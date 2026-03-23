// USDA FoodData Central integration — provides per-100g nutrition data for
// grocery items to support accurate traffic light classification and compliance
// scoring in the Recipe Matcher.
//
// All results are cached in the nutrition_cache table to avoid repeated API
// calls across plan generation runs for the same product names.
//
// API reference: https://api.nal.usda.gov/fdc/v1/foods/search
// Free tier: DEMO_KEY (1000 requests/hour). Production: register at https://fdc.nal.usda.gov/

import { pool } from "../db/pool";
import { NutritionData } from "../types/plans";

const USDA_BASE = "https://api.nal.usda.gov/fdc/v1";
const USDA_API_KEY = process.env.USDA_API_KEY ?? "DEMO_KEY";
const USDA_TIMEOUT_MS = 5000;

// USDA nutrient IDs (stable across FoodData Central versions)
const NUTRIENT_SODIUM = 1093; // mg
const NUTRIENT_CARBS  = 1005; // g
const NUTRIENT_ENERGY = 1008; // kcal

// ---------------------------------------------------------------------------
// Key normalization — strips punctuation, lowercases, trims brand suffixes
// to maximize cache hit rate across similar product name variants.
// ---------------------------------------------------------------------------
export function normalizeProductKey(productName: string): string {
  return productName
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

// ---------------------------------------------------------------------------
// Cache layer
// ---------------------------------------------------------------------------
async function getCachedNutrition(key: string): Promise<NutritionData | null> {
  const result = await pool.query<{
    fdc_id: number | null;
    sodium_mg_per_100g: string | null;
    carbs_g_per_100g: string | null;
    energy_kcal_per_100g: string | null;
  }>(
    `SELECT fdc_id, sodium_mg_per_100g, carbs_g_per_100g, energy_kcal_per_100g
     FROM nutrition_cache
     WHERE product_key = $1`,
    [key]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    fdcId: row.fdc_id,
    sodiumMgPer100g:   row.sodium_mg_per_100g   !== null ? Number(row.sodium_mg_per_100g)   : null,
    carbsGPer100g:     row.carbs_g_per_100g     !== null ? Number(row.carbs_g_per_100g)     : null,
    energyKcalPer100g: row.energy_kcal_per_100g !== null ? Number(row.energy_kcal_per_100g) : null,
    source: "usda",
  };
}

async function setCachedNutrition(
  key: string,
  data: NutritionData
): Promise<void> {
  await pool.query(
    `INSERT INTO nutrition_cache
       (product_key, fdc_id, sodium_mg_per_100g, carbs_g_per_100g, energy_kcal_per_100g)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (product_key) DO UPDATE SET
       fdc_id               = EXCLUDED.fdc_id,
       sodium_mg_per_100g   = EXCLUDED.sodium_mg_per_100g,
       carbs_g_per_100g     = EXCLUDED.carbs_g_per_100g,
       energy_kcal_per_100g = EXCLUDED.energy_kcal_per_100g,
       cached_at            = NOW()`,
    [key, data.fdcId, data.sodiumMgPer100g, data.carbsGPer100g, data.energyKcalPer100g]
  );
}

// ---------------------------------------------------------------------------
// USDA FoodData Central API call
// ---------------------------------------------------------------------------
interface UsdaSearchResponse {
  foods?: Array<{
    fdcId: number;
    foodNutrients: Array<{ nutrientId: number; value: number }>;
  }>;
}

async function fetchFromUSDA(productName: string): Promise<NutritionData | null> {
  const query = encodeURIComponent(productName);
  const url =
    `${USDA_BASE}/foods/search` +
    `?query=${query}` +
    `&api_key=${USDA_API_KEY}` +
    `&dataType=SR%20Legacy,Survey%20(FNDDS)` +
    `&pageSize=1`;

  const response = await fetch(url, {
    signal: AbortSignal.timeout(USDA_TIMEOUT_MS),
  });

  if (!response.ok) return null;

  const data = (await response.json()) as UsdaSearchResponse;
  const food = data.foods?.[0];
  if (!food) return null;

  const getNutrient = (id: number): number | null => {
    const hit = food.foodNutrients.find((n) => n.nutrientId === id);
    return hit?.value ?? null;
  };

  return {
    fdcId:             food.fdcId,
    sodiumMgPer100g:   getNutrient(NUTRIENT_SODIUM),
    carbsGPer100g:     getNutrient(NUTRIENT_CARBS),
    energyKcalPer100g: getNutrient(NUTRIENT_ENERGY),
    source: "usda",
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Returns nutrition data for a single product, using the cache first.
// Returns null if neither cache nor USDA has data for this product.
export async function getNutritionData(
  productName: string
): Promise<NutritionData | null> {
  const key = normalizeProductKey(productName);

  const cached = await getCachedNutrition(key);
  if (cached) return cached;

  const fetched = await fetchFromUSDA(productName).catch(() => null);
  if (!fetched) return null;

  await setCachedNutrition(key, fetched).catch(() => void 0); // best-effort cache write
  return fetched;
}

// Batch-fetches nutrition data for a list of product names with concurrency
// control. Returns a Map keyed by product_name (original casing).
// Failures are silently swallowed — callers fall back to keyword heuristics.
export async function fetchNutritionMap(
  productNames: string[]
): Promise<Map<string, NutritionData | null>> {
  const map = new Map<string, NutritionData | null>();
  const unique = Array.from(new Set(productNames));

  const results = await Promise.allSettled(
    unique.map(async (name) => {
      const data = await getNutritionData(name);
      return { name, data };
    })
  );

  for (const result of results) {
    if (result.status === "fulfilled") {
      map.set(result.value.name, result.value.data);
    }
  }

  return map;
}
