import {
  DeterministicPayload,
  GroceryPriceEntry,
  HouseholdModel,
  MealPlanItem,
  NutritionData,
  PacketFormat,
  ResolvedConstraints,
  ScoredItem,
  TrafficLight,
} from "../types/plans";

// ---------------------------------------------------------------------------
// Traffic light — USDA-data-based classification (primary)
//
// Thresholds are per 100g and calibrated to common clinical nutrition guidance:
//   Sodium: ≤150mg = green, 151–500mg = yellow, >500mg = red
//   Carbs:  ≤15g   = green, 16–45g    = yellow, >45g   = red
//
// The strictest metric wins — e.g., low sodium but high carbs = yellow.
// ---------------------------------------------------------------------------
export function classifyWithNutrition(nutrition: NutritionData): TrafficLight {
  const { sodiumMgPer100g, carbsGPer100g } = nutrition;

  // Red if either metric exceeds threshold
  if (sodiumMgPer100g !== null && sodiumMgPer100g > 500) return "red";
  if (carbsGPer100g   !== null && carbsGPer100g   > 45)  return "red";

  // Green only when all available metrics are within green bounds
  const sodiumGreen = sodiumMgPer100g === null || sodiumMgPer100g <= 150;
  const carbsGreen  = carbsGPer100g   === null || carbsGPer100g   <= 15;
  if (sodiumGreen && carbsGreen) return "green";

  return "yellow";
}

// ---------------------------------------------------------------------------
// Traffic light — keyword-based fallback (used when USDA data unavailable)
// ---------------------------------------------------------------------------
const GREEN_KEYWORDS = [
  "chicken", "turkey", "fish", "salmon", "tuna", "tilapia", "shrimp", "cod",
  "egg", "bean", "lentil", "chickpea", "black bean", "pinto bean",
  "broccoli", "spinach", "kale", "lettuce", "cabbage", "carrot", "celery",
  "onion", "garlic", "tomato", "pepper", "squash", "zucchini", "cucumber",
  "mushroom", "sweet potato",
  "apple", "banana", "orange", "berry", "blueberry", "strawberry", "grape",
  "melon", "watermelon", "peach", "pear",
  "oat", "oatmeal", "brown rice", "whole grain", "whole wheat", "quinoa",
  "greek yogurt", "cottage cheese",
];

const RED_KEYWORDS = [
  "soda", "cola", "pepsi", "sprite", "mountain dew", "dr pepper",
  "energy drink", "red bull", "monster",
  "chip", "chips", "crisp", "pretzel", "cheese puff",
  "candy", "chocolate", "gummy", "skittle", "m&m", "snickers", "twix",
  "cookie", "cake", "brownie", "pastry", "donut", "muffin", "cupcake",
  "ice cream", "frozen dessert", "sherbet",
  "hot dog", "frank", "bologna", "spam",
  "frozen pizza", "tv dinner", "frozen meal",
  "bacon",
];

export function classifyItem(productName: string): TrafficLight {
  const lower = productName.toLowerCase();
  for (const kw of RED_KEYWORDS)   { if (lower.includes(kw)) return "red"; }
  for (const kw of GREEN_KEYWORDS) { if (lower.includes(kw)) return "green"; }
  return "yellow";
}

// ---------------------------------------------------------------------------
// Compliance scoring (0–100)
//
// Factors:
// 1. Base score from traffic light
// 2. Penalty when item's per-serving sodium/carbs exceeds the patient's daily limit
//    (per-item budget = daily limit ÷ 5 main food items per day × estimated 200g serving)
// 3. Bonus for sale items (better budget value)
// ---------------------------------------------------------------------------
const ESTIMATED_SERVING_G = 200; // conservative estimate without actual serving data

function complianceScore(
  entry: GroceryPriceEntry,
  trafficLight: TrafficLight,
  constraints: ResolvedConstraints,
  nutrition: NutritionData | null
): number {
  let score = trafficLight === "green" ? 90 : trafficLight === "yellow" ? 55 : 15;

  if (nutrition) {
    const servingFactor = ESTIMATED_SERVING_G / 100;

    // Sodium penalty: item's estimated serving sodium vs. per-item daily budget
    if (constraints.sodiumTargetMg !== null && nutrition.sodiumMgPer100g !== null) {
      const servingSodium      = nutrition.sodiumMgPer100g * servingFactor;
      const dailyBudgetPerItem = constraints.sodiumTargetMg / 5;
      if (servingSodium > dailyBudgetPerItem) {
        score = Math.max(0, score - 35);
      }
    }

    // Carb penalty: item's estimated serving carbs vs. per-item daily budget
    if (constraints.carbTargetG !== null && nutrition.carbsGPer100g !== null) {
      const servingCarbs       = nutrition.carbsGPer100g * servingFactor;
      const dailyBudgetPerItem = constraints.carbTargetG / 5;
      if (servingCarbs > dailyBudgetPerItem) {
        score = Math.max(0, score - 35);
      }
    }
  }

  // Bonus for sale items — better value within budget
  if (entry.sale_type) {
    score = Math.min(score + 5, 100);
  }

  return score;
}

// ---------------------------------------------------------------------------
// Household model → approximate weekly grocery item count target
// ---------------------------------------------------------------------------
const HOUSEHOLD_ITEM_COUNT: Record<HouseholdModel, number> = {
  "1_adult":       8,
  "2_adults":     13,
  "1a_1c":        11,
  "1a_2c":        13,
  "2a_1c":        14,
  "2a_2c":        16,
  "3plus_adults": 18,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Scores a list of price entries against the resolved health constraints.
// Pass nutritionMap (from nutritionService.fetchNutritionMap) for USDA-backed
// classification. When data is unavailable for an item, keyword heuristics are
// used as fallback — classification is always deterministic.
export function scoreItems(
  prices: GroceryPriceEntry[],
  constraints: ResolvedConstraints,
  nutritionMap?: Map<string, NutritionData | null>
): ScoredItem[] {
  const avoidLower = constraints.foodsToAvoid.map((f) => f.toLowerCase());

  return prices
    .filter((entry) => {
      const lower = entry.product_name.toLowerCase();
      return !avoidLower.some((avoid) => lower.includes(avoid));
    })
    .map((entry) => {
      const nutrition = nutritionMap?.get(entry.product_name) ?? null;
      const trafficLight =
        nutrition !== null
          ? classifyWithNutrition(nutrition)
          : classifyItem(entry.product_name);

      return {
        entry,
        trafficLight,
        complianceScore: complianceScore(entry, trafficLight, constraints, nutrition),
      };
    })
    .filter((item) => item.complianceScore > 0);
}

export function selectItems(
  scoredItems: ScoredItem[],
  effectiveBudget: number,
  householdModel: HouseholdModel
): MealPlanItem[] {
  const targetCount = HOUSEHOLD_ITEM_COUNT[householdModel];

  // Sort: highest compliance score first, then price ascending within same tier
  const sorted = [...scoredItems].sort((a, b) => {
    if (b.complianceScore !== a.complianceScore) {
      return b.complianceScore - a.complianceScore;
    }
    return a.entry.price - b.entry.price;
  });

  const selected: MealPlanItem[] = [];
  let spent = 0;

  for (const item of sorted) {
    if (selected.length >= targetCount) break;
    if (spent + item.entry.price > effectiveBudget) continue;

    selected.push({
      productName: item.entry.product_name,
      price:        item.entry.price,
      saleType:     item.entry.sale_type ?? null,
      trafficLight: item.trafficLight,
      scrapeRunId:  item.entry.scrape_run_id ?? null,
    });
    spent += item.entry.price;
  }

  return selected;
}

export function buildTrafficLightSummary(
  items: MealPlanItem[]
): DeterministicPayload["trafficLightSummary"] {
  return items.reduce(
    (acc, item) => { acc[item.trafficLight] += 1; return acc; },
    { green: 0, yellow: 0, red: 0 }
  );
}

export function assembleDeterministicPayload(
  request: {
    householdModel: HouseholdModel;
    weekOf: string;
    budgetUsd: number;
    packetFormat?: PacketFormat;
  },
  resolvedConstraints: ResolvedConstraints,
  selectedItems: MealPlanItem[]
): DeterministicPayload {
  const effectiveBudgetUsd = Math.round(request.budgetUsd * 0.9 * 100) / 100;
  const totalCostUsd =
    Math.round(selectedItems.reduce((sum, i) => sum + i.price, 0) * 100) / 100;

  return {
    householdModel:     request.householdModel,
    weekOf:             request.weekOf,
    budgetUsd:          request.budgetUsd,
    effectiveBudgetUsd,
    resolvedConstraints,
    selectedItems,
    totalCostUsd,
    trafficLightSummary: buildTrafficLightSummary(selectedItems),
    packetFormat:       request.packetFormat ?? "standard_weekly",
  };
}
