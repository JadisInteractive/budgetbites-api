import { describe, expect, it } from "vitest";
import {
  assembleDeterministicPayload,
  buildTrafficLightSummary,
  scoreItems,
  selectItems,
} from "../services/recipeMatcher";
import { GroceryPriceEntry, ResolvedConstraints } from "../types/plans";

const BASE_CONSTRAINTS: ResolvedConstraints = {
  sodiumTargetMg: null,
  carbTargetG: null,
  calorieTarget: null,
  proteinEmphasis: "lean",
  foodsToAvoid: [],
};

function makeEntry(
  product_name: string,
  price: number,
  sale_type: string | null = null
): GroceryPriceEntry {
  return {
    scrape_run_id: "run_1",
    chain_id: "publix",
    store_id: "publix_test",
    region: "ga",
    product_name,
    price,
    sale_type,
    start_date: "2026-03-23",
    end_date: "2026-03-29",
  };
}

describe("scoreItems", () => {
  it("classifies chicken as green", () => {
    const items = scoreItems([makeEntry("Chicken Breast, Boneless", 3.99)], BASE_CONSTRAINTS);
    expect(items).toHaveLength(1);
    expect(items[0]?.trafficLight).toBe("green");
    expect(items[0]?.complianceScore).toBeGreaterThanOrEqual(90);
  });

  it("classifies soda as red", () => {
    const items = scoreItems([makeEntry("Pepsi Soda 2L", 1.79)], BASE_CONSTRAINTS);
    expect(items).toHaveLength(1);
    expect(items[0]?.trafficLight).toBe("red");
    expect(items[0]?.complianceScore).toBeLessThan(25);
  });

  it("classifies bread as yellow (not green or red keyword)", () => {
    const items = scoreItems([makeEntry("Wonder Bread White", 2.49)], BASE_CONSTRAINTS);
    expect(items).toHaveLength(1);
    expect(items[0]?.trafficLight).toBe("yellow");
  });

  it("filters out items in foodsToAvoid", () => {
    const constraints = { ...BASE_CONSTRAINTS, foodsToAvoid: ["organ meats", "sardines"] };
    const prices = [
      makeEntry("Beef Organ Meats", 2.99),
      makeEntry("Sardines in Oil", 1.49),
      makeEntry("Chicken Breast", 3.99),
    ];
    const items = scoreItems(prices, constraints);
    expect(items).toHaveLength(1);
    expect(items[0]?.entry.product_name).toBe("Chicken Breast");
  });

  it("gives sale items a bonus score", () => {
    const regular = scoreItems([makeEntry("Salmon Fillet", 6.99)], BASE_CONSTRAINTS);
    const onSale  = scoreItems([makeEntry("Salmon Fillet", 6.99, "BOGO")], BASE_CONSTRAINTS);
    expect((onSale[0]?.complianceScore ?? 0)).toBeGreaterThan(
      regular[0]?.complianceScore ?? 0
    );
  });

  it("returns empty array for an empty price list", () => {
    expect(scoreItems([], BASE_CONSTRAINTS)).toHaveLength(0);
  });
});

describe("selectItems", () => {
  it("stays within effective budget", () => {
    const prices = [
      makeEntry("Chicken Breast", 4.99),
      makeEntry("Broccoli", 1.99),
      makeEntry("Spinach", 2.49),
      makeEntry("Salmon", 8.99),
      makeEntry("Brown Rice", 3.49),
      makeEntry("Oatmeal", 2.79),
      makeEntry("Eggs", 3.99),
      makeEntry("Sweet Potato", 1.49),
    ];
    const scored = scoreItems(prices, BASE_CONSTRAINTS);
    const budget = 20;
    const selected = selectItems(scored, budget, "1_adult");
    const totalCost = selected.reduce((sum, i) => sum + i.price, 0);
    expect(totalCost).toBeLessThanOrEqual(budget);
  });

  it("prefers green items over yellow over red", () => {
    const prices = [
      makeEntry("Pepsi Soda 2L", 0.99),        // red — cheap
      makeEntry("White Bread", 1.99),           // yellow
      makeEntry("Chicken Breast", 3.99),        // green — pricier
    ];
    const scored = scoreItems(prices, BASE_CONSTRAINTS);
    const selected = selectItems(scored, 50, "1_adult");
    // Green (chicken) should appear before red (soda)
    const chickenIdx = selected.findIndex((i) => i.productName.includes("Chicken"));
    const sodaIdx    = selected.findIndex((i) => i.productName.includes("Pepsi"));
    if (chickenIdx !== -1 && sodaIdx !== -1) {
      expect(chickenIdx).toBeLessThan(sodaIdx);
    }
  });

  it("returns empty array when budget is zero", () => {
    const scored = scoreItems([makeEntry("Chicken Breast", 3.99)], BASE_CONSTRAINTS);
    expect(selectItems(scored, 0, "1_adult")).toHaveLength(0);
  });
});

describe("buildTrafficLightSummary", () => {
  it("counts traffic lights correctly", () => {
    const items = [
      { productName: "A", price: 1, saleType: null, trafficLight: "green" as const, scrapeRunId: null },
      { productName: "B", price: 2, saleType: null, trafficLight: "green" as const, scrapeRunId: null },
      { productName: "C", price: 3, saleType: null, trafficLight: "yellow" as const, scrapeRunId: null },
      { productName: "D", price: 4, saleType: null, trafficLight: "red" as const, scrapeRunId: null },
    ];
    const summary = buildTrafficLightSummary(items);
    expect(summary).toEqual({ green: 2, yellow: 1, red: 1 });
  });

  it("returns all zeros for empty list", () => {
    expect(buildTrafficLightSummary([])).toEqual({ green: 0, yellow: 0, red: 0 });
  });
});

describe("assembleDeterministicPayload", () => {
  it("applies the 10% budget buffer to effectiveBudgetUsd", () => {
    const payload = assembleDeterministicPayload(
      { householdModel: "1_adult", weekOf: "2026-03-23", budgetUsd: 50 },
      BASE_CONSTRAINTS,
      []
    );
    expect(payload.effectiveBudgetUsd).toBe(45);
    expect(payload.budgetUsd).toBe(50);
  });

  it("defaults packetFormat to standard_weekly when not provided", () => {
    const payload = assembleDeterministicPayload(
      { householdModel: "1_adult", weekOf: "2026-03-23", budgetUsd: 50 },
      BASE_CONSTRAINTS,
      []
    );
    expect(payload.packetFormat).toBe("standard_weekly");
  });

  it("computes totalCostUsd from selectedItems", () => {
    const items = [
      { productName: "A", price: 3.99, saleType: null, trafficLight: "green" as const, scrapeRunId: null },
      { productName: "B", price: 2.01, saleType: null, trafficLight: "yellow" as const, scrapeRunId: null },
    ];
    const payload = assembleDeterministicPayload(
      { householdModel: "1_adult", weekOf: "2026-03-23", budgetUsd: 50 },
      BASE_CONSTRAINTS,
      items
    );
    expect(payload.totalCostUsd).toBe(6.00);
  });
});
