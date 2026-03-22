import { describe, expect, it } from "vitest";
import { resolveConstraints } from "../services/nutritionRules";
import { HealthConstraints } from "../types/plans";

const base: HealthConstraints = {
  conditions: [],
  sodiumTargetMg: null,
  carbTargetG: null,
  calorieTarget: null,
  proteinEmphasis: "lean",
  foodsToAvoid: [],
};

describe("resolveConstraints", () => {
  it("single condition flag: hypertension → sodium 1500", () => {
    const result = resolveConstraints({
      ...base,
      conditions: ["hypertension"],
    });
    expect(result.sodiumTargetMg).toBe(1500);
    expect(result.carbTargetG).toBeNull();
  });

  it("conflicting sodium: hypertension (1500) + explicit 2000 → resolves to 1500 (strictest wins)", () => {
    const result = resolveConstraints({
      ...base,
      conditions: ["hypertension"],
      sodiumTargetMg: 2000,
    });
    expect(result.sodiumTargetMg).toBe(1500);
  });

  it("conflicting carbs: prediabetes (130) + high_triglycerides (100) → resolves to 100", () => {
    const result = resolveConstraints({
      ...base,
      conditions: ["prediabetes", "high_triglycerides"],
    });
    expect(result.carbTargetG).toBe(100);
  });

  it("gout flag → GOUT_EXCLUSIONS appended to foodsToAvoid", () => {
    const result = resolveConstraints({
      ...base,
      conditions: ["gout"],
      foodsToAvoid: ["shellfish"],
    });
    expect(result.foodsToAvoid).toContain("shellfish");
    expect(result.foodsToAvoid).toContain("organ meats");
    expect(result.foodsToAvoid).toContain("sardines");
    expect(result.foodsToAvoid).toContain("anchovies");
    expect(result.foodsToAvoid).toContain("herring");
  });

  it("empty conditions array → all targets null, no exclusions added", () => {
    const result = resolveConstraints({
      ...base,
      conditions: [],
      foodsToAvoid: [],
    });
    expect(result.sodiumTargetMg).toBeNull();
    expect(result.carbTargetG).toBeNull();
    expect(result.calorieTarget).toBeNull();
    expect(result.foodsToAvoid).toHaveLength(0);
  });

  it("all conditions simultaneously → all strictest values win", () => {
    const result = resolveConstraints({
      ...base,
      conditions: [
        "hypertension",     // sodium 1500
        "heart_disease",    // sodium 2000 (1500 wins)
        "kidney_disease",   // sodium 1500
        "prediabetes",      // carbs 130
        "type2_diabetes",   // carbs 100 (wins)
        "high_triglycerides", // carbs 100
        "gout",
      ],
      sodiumTargetMg: 1800, // explicit 1800, but 1500 from conditions wins
      carbTargetG: 200,     // explicit 200, but 100 from conditions wins
    });
    expect(result.sodiumTargetMg).toBe(1500);
    expect(result.carbTargetG).toBe(100);
    expect(result.foodsToAvoid).toContain("organ meats");
  });
});
