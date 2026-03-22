import { HealthConstraints, ResolvedConstraints } from "../types/plans";

const CONDITION_SODIUM: Partial<Record<string, number>> = {
  hypertension: 1500,
  heart_disease: 2000,
  kidney_disease: 1500,
};

const CONDITION_CARBS: Partial<Record<string, number>> = {
  prediabetes: 130,
  type2_diabetes: 100,
  high_triglycerides: 100,
};

const GOUT_EXCLUSIONS = ["organ meats", "sardines", "anchovies", "herring"];

export function resolveConstraints(c: HealthConstraints): ResolvedConstraints {
  // Sodium: take the lowest non-null value across all sources — strictest wins
  const sodiumCandidates = [
    c.sodiumTargetMg,
    ...c.conditions
      .map((cond) => CONDITION_SODIUM[cond])
      .filter((v): v is number => v != null),
  ].filter((v): v is number => v != null);

  // Carbs: same — always strictest (lowest) wins
  const carbCandidates = [
    c.carbTargetG,
    ...c.conditions
      .map((cond) => CONDITION_CARBS[cond])
      .filter((v): v is number => v != null),
  ].filter((v): v is number => v != null);

  return {
    sodiumTargetMg: sodiumCandidates.length > 0 ? Math.min(...sodiumCandidates) : null,
    carbTargetG: carbCandidates.length > 0 ? Math.min(...carbCandidates) : null,
    calorieTarget: c.calorieTarget,
    proteinEmphasis: c.proteinEmphasis ?? "lean",
    foodsToAvoid: [
      ...c.foodsToAvoid,
      ...(c.conditions.includes("gout") ? GOUT_EXCLUSIONS : []),
    ],
  };
}
