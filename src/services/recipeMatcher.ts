import {
  DeterministicPayload,
  GroceryPriceEntry,
  HouseholdModel,
  MealPlanItem,
  PacketFormat,
  ResolvedConstraints,
  ScoredItem,
  TrafficLight,
} from "../types/plans";

// ---------------------------------------------------------------------------
// Traffic light keyword heuristics
// The scraper provides product names only — macros are not available per item.
// Traffic light is assigned via keyword matching as a best-effort proxy.
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
  "chip", "chips", "crisp", "crisps", "pretzel", "cheese puff",
  "candy", "chocolate", "gummy", "skittle", "m&m", "snickers", "twix",
  "cookie", "cake", "brownie", "pastry", "donut", "muffin", "cupcake",
  "ice cream", "frozen dessert", "sherbet", "sorbet",
  "hot dog", "frank", "bologna", "spam", "processed meat",
  "frozen pizza", "tv dinner", "frozen meal",
  "bacon", // high sodium — flag red for hypertension context
];

function classifyItem(productName: string): TrafficLight {
  const lower = productName.toLowerCase();
  for (const kw of RED_KEYWORDS) {
    if (lower.includes(kw)) return "red";
  }
  for (const kw of GREEN_KEYWORDS) {
    if (lower.includes(kw)) return "green";
  }
  return "yellow";
}

// ---------------------------------------------------------------------------
// Compliance score (0–100)
// ---------------------------------------------------------------------------
function complianceScore(
  entry: GroceryPriceEntry,
  trafficLight: TrafficLight,
  constraints: ResolvedConstraints
): number {
  let score = trafficLight === "green" ? 90 : trafficLight === "yellow" ? 55 : 15;

  // Penalty if item is in foodsToAvoid
  const lower = entry.product_name.toLowerCase();
  for (const food of constraints.foodsToAvoid) {
    if (lower.includes(food.toLowerCase())) {
      return 0; // excluded — should be filtered before this point
    }
  }

  // Bonus for sale items (BOGO / multi_pack = better value for budget)
  if (entry.sale_type) {
    score = Math.min(score + 5, 100);
  }

  return score;
}

// ---------------------------------------------------------------------------
// Household model → approximate weekly food-item count target
// ---------------------------------------------------------------------------
const HOUSEHOLD_ITEM_COUNT: Record<HouseholdModel, number> = {
  "1_adult": 8,
  "2_adults": 13,
  "1a_1c": 11,
  "1a_2c": 13,
  "2a_1c": 14,
  "2a_2c": 16,
  "3plus_adults": 18,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function scoreItems(
  prices: GroceryPriceEntry[],
  constraints: ResolvedConstraints
): ScoredItem[] {
  const avoidLower = constraints.foodsToAvoid.map((f) => f.toLowerCase());

  return prices
    .filter((entry) => {
      const lower = entry.product_name.toLowerCase();
      return !avoidLower.some((avoid) => lower.includes(avoid));
    })
    .map((entry) => {
      const trafficLight = classifyItem(entry.product_name);
      return {
        entry,
        trafficLight,
        complianceScore: complianceScore(entry, trafficLight, constraints),
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

  // Sort: highest compliance score first, then price ascending within same score tier
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
      price: item.entry.price,
      saleType: item.entry.sale_type ?? null,
      trafficLight: item.trafficLight,
      scrapeRunId: item.entry.scrape_run_id ?? null,
    });
    spent += item.entry.price;
  }

  return selected;
}

export function buildTrafficLightSummary(
  items: MealPlanItem[]
): DeterministicPayload["trafficLightSummary"] {
  return items.reduce(
    (acc, item) => {
      acc[item.trafficLight] += 1;
      return acc;
    },
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
    householdModel: request.householdModel,
    weekOf: request.weekOf,
    budgetUsd: request.budgetUsd,
    effectiveBudgetUsd,
    resolvedConstraints,
    selectedItems,
    totalCostUsd,
    trafficLightSummary: buildTrafficLightSummary(selectedItems),
    packetFormat: request.packetFormat ?? "standard_weekly",
  };
}
