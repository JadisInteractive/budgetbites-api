import { describe, expect, it } from "vitest";
import { classifyWithNutrition, classifyItem, scoreItems } from "../services/recipeMatcher";
import { normalizeProductKey } from "../services/nutritionService";
import { GroceryPriceEntry, NutritionData, ResolvedConstraints } from "../types/plans";

const BASE_CONSTRAINTS: ResolvedConstraints = {
  sodiumTargetMg: null,
  carbTargetG: null,
  calorieTarget: null,
  proteinEmphasis: "lean",
  foodsToAvoid: [],
};

function makeNutrition(
  sodiumMgPer100g: number | null,
  carbsGPer100g: number | null,
  energyKcalPer100g: number | null = null
): NutritionData {
  return { sodiumMgPer100g, carbsGPer100g, energyKcalPer100g, fdcId: null, source: "usda" };
}

function makeEntry(product_name: string, price = 3.99): GroceryPriceEntry {
  return {
    scrape_run_id: "run_1",
    chain_id: "publix",
    store_id: "publix_test",
    region: "ga",
    product_name,
    price,
    sale_type: null,
    start_date: "2026-03-23",
    end_date: "2026-03-29",
  };
}

// ---------------------------------------------------------------------------
// classifyWithNutrition — USDA-data-based traffic light
// ---------------------------------------------------------------------------
describe("classifyWithNutrition", () => {
  it("returns green for low sodium and low carbs", () => {
    expect(classifyWithNutrition(makeNutrition(70, 0))).toBe("green");   // chicken breast
    expect(classifyWithNutrition(makeNutrition(30, 7))).toBe("green");   // broccoli
  });

  it("returns red when sodium exceeds 500mg/100g", () => {
    expect(classifyWithNutrition(makeNutrition(550, 5))).toBe("red");    // processed deli meat
    expect(classifyWithNutrition(makeNutrition(600, 0))).toBe("red");
  });

  it("returns red when carbs exceed 45g/100g", () => {
    expect(classifyWithNutrition(makeNutrition(50, 52))).toBe("red");    // chips
    expect(classifyWithNutrition(makeNutrition(null, 60))).toBe("red");
  });

  it("returns yellow when sodium is mid-range", () => {
    expect(classifyWithNutrition(makeNutrition(300, 10))).toBe("yellow"); // canned beans
  });

  it("returns yellow when carbs are mid-range", () => {
    expect(classifyWithNutrition(makeNutrition(100, 30))).toBe("yellow"); // bread
  });

  it("classifies with only sodium data when carbs are null", () => {
    expect(classifyWithNutrition(makeNutrition(80, null))).toBe("green");
    expect(classifyWithNutrition(makeNutrition(600, null))).toBe("red");
  });

  it("classifies with only carbs data when sodium is null", () => {
    expect(classifyWithNutrition(makeNutrition(null, 10))).toBe("green");
    expect(classifyWithNutrition(makeNutrition(null, 50))).toBe("red");
  });
});

// ---------------------------------------------------------------------------
// classifyItem — keyword fallback
// ---------------------------------------------------------------------------
describe("classifyItem", () => {
  it("classifies known green items correctly", () => {
    expect(classifyItem("Chicken Breast Boneless")).toBe("green");
    expect(classifyItem("Fresh Salmon Fillet")).toBe("green");
    expect(classifyItem("Broccoli Florets")).toBe("green");
    expect(classifyItem("Greek Yogurt Plain")).toBe("green");
  });

  it("classifies known red items correctly", () => {
    expect(classifyItem("Pepsi Cola 2L")).toBe("red");
    expect(classifyItem("Lay's Potato Chips")).toBe("red");
    expect(classifyItem("Oreo Cookies")).toBe("red");
    expect(classifyItem("Häagen-Dazs Ice Cream")).toBe("red");
  });

  it("defaults to yellow for ambiguous items", () => {
    expect(classifyItem("Whole Milk")).toBe("yellow");
    expect(classifyItem("White Rice 5lb")).toBe("yellow");
    expect(classifyItem("Wonder Bread")).toBe("yellow");
  });
});

// ---------------------------------------------------------------------------
// USDA nutrition data takes priority over keyword heuristics in scoreItems
// ---------------------------------------------------------------------------
describe("scoreItems — nutrition data priority", () => {
  it("uses USDA classification when nutrition map is provided", () => {
    // "Salted Crackers" would be yellow by keyword, but red by actual sodium
    const prices = [makeEntry("Salted Crackers")];
    const nutritionMap = new Map([
      ["Salted Crackers", makeNutrition(620, 60)], // very high sodium + carbs
    ]);
    const items = scoreItems(prices, BASE_CONSTRAINTS, nutritionMap);
    expect(items[0]?.trafficLight).toBe("red");
  });

  it("falls back to keyword classification when nutrition map has no entry", () => {
    const prices = [makeEntry("Salmon Fillet")];
    const nutritionMap = new Map<string, NutritionData | null>([
      ["Salmon Fillet", null],
    ]);
    const items = scoreItems(prices, BASE_CONSTRAINTS, nutritionMap);
    expect(items[0]?.trafficLight).toBe("green"); // keyword fallback
  });

  it("uses keyword classification when no nutrition map is passed", () => {
    const prices = [makeEntry("Chicken Breast")];
    const items = scoreItems(prices, BASE_CONSTRAINTS);
    expect(items[0]?.trafficLight).toBe("green");
  });
});

// ---------------------------------------------------------------------------
// Compliance scoring with health constraints
// ---------------------------------------------------------------------------
describe("scoreItems — compliance scoring with constraints", () => {
  it("penalizes high-sodium items when patient has a sodium target", () => {
    const constraints = { ...BASE_CONSTRAINTS, sodiumTargetMg: 1500 };
    const prices = [makeEntry("High Sodium Item")];

    const withHighSodium = new Map([["High Sodium Item", makeNutrition(800, 5)]]);
    const withLowSodium  = new Map([["High Sodium Item", makeNutrition(50, 5)]]);

    const highScore = scoreItems(prices, constraints, withHighSodium)[0]?.complianceScore ?? 0;
    const lowScore  = scoreItems(prices, constraints, withLowSodium)[0]?.complianceScore  ?? 0;

    expect(lowScore).toBeGreaterThan(highScore);
  });

  it("penalizes high-carb items when patient has a carb target", () => {
    const constraints = { ...BASE_CONSTRAINTS, carbTargetG: 100 };
    const prices = [makeEntry("High Carb Item")];

    const withHighCarbs = new Map([["High Carb Item", makeNutrition(50, 80)]]);
    const withLowCarbs  = new Map([["High Carb Item", makeNutrition(50, 5)]]);

    const highScore = scoreItems(prices, constraints, withHighCarbs)[0]?.complianceScore ?? 0;
    const lowScore  = scoreItems(prices, constraints, withLowCarbs)[0]?.complianceScore  ?? 0;

    expect(lowScore).toBeGreaterThan(highScore);
  });
});

// ---------------------------------------------------------------------------
// normalizeProductKey
// ---------------------------------------------------------------------------
describe("normalizeProductKey", () => {
  it("lowercases, strips punctuation, and collapses spaces", () => {
    expect(normalizeProductKey("Chicken Breast, Boneless (Raw)")).toBe(
      "chicken breast boneless raw"
    );
  });

  it("collapses multiple spaces from the original input", () => {
    expect(normalizeProductKey("Salmon   Fillet")).toBe("salmon fillet");
  });

  it("truncates to 120 characters", () => {
    const long = "a".repeat(200);
    expect(normalizeProductKey(long)).toHaveLength(120);
  });
});
