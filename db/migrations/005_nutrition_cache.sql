-- Nutrition cache — stores USDA FoodData Central lookup results keyed by normalized
-- product name. Avoids repeated API calls for the same product across scrape runs.

CREATE TABLE IF NOT EXISTS nutrition_cache (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_key          TEXT NOT NULL UNIQUE, -- normalized product name (lowercase, trimmed)
  fdc_id               INTEGER,              -- USDA FoodData Central ID
  sodium_mg_per_100g   NUMERIC,
  carbs_g_per_100g     NUMERIC,
  energy_kcal_per_100g NUMERIC,
  source               TEXT NOT NULL DEFAULT 'usda',
  cached_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS nutrition_cache_product_key_idx ON nutrition_cache(product_key);
