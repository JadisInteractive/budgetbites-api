export type PlanContext = "b2c" | "b2b_clinic";

export type HouseholdModel =
  | "1_adult"
  | "2_adults"
  | "1a_1c"
  | "1a_2c"
  | "2a_1c"
  | "2a_2c"
  | "3plus_adults";

export type AgeGroup = "adult" | "senior" | "pediatric";

export type ProteinEmphasis = "lean" | "plant_forward" | "high_protein";

export type PacketFormat =
  | "traffic_light_family"
  | "traffic_light_adult"
  | "standard_weekly";

export type TrafficLight = "green" | "yellow" | "red";

export type PlanStatus = "generating" | "complete" | "failed";

export type PlanJobStatus = "queued" | "processing" | "complete" | "failed";

export interface HealthConstraints {
  conditions: string[];
  sodiumTargetMg: number | null;
  carbTargetG: number | null;
  calorieTarget: number | null;
  proteinEmphasis: ProteinEmphasis;
  foodsToAvoid: string[];
}

export interface ResolvedConstraints {
  sodiumTargetMg: number | null;
  carbTargetG: number | null;
  calorieTarget: number | null;
  proteinEmphasis: ProteinEmphasis;
  foodsToAvoid: string[];
}

export interface PlanGenerateRequest {
  // Identity
  context: PlanContext;
  userId?: string;       // B2C — from auth session
  patientRef?: string;   // B2B — required, no PHI, regex validated
  clinicId?: string;     // B2B — required, tenant isolation key

  // Household
  householdModel: HouseholdModel;
  ageGroup?: AgeGroup;
  preferredLanguage?: "en" | "es";

  // Nutrition Rules Engine input
  healthConstraints: HealthConstraints;

  // Packet config
  chainId: string;         // maps to grocery_prices.chain_id
  storeId: string;         // maps to grocery_prices.store_id
  weekOf: string;          // ISO 8601 Monday — "2026-03-18"
  budgetUsd: number;       // pre-buffer, 20–500
  packetFormat?: PacketFormat;
  clinicalNotes?: string | null;  // B2B — AUDIT LOG ONLY, never AI payload
}

export interface PricingAvailability {
  available: boolean;
  scrapeRunId: string | null;
  priceCount: number;
}

export interface PlanJobResponse {
  jobId: string;
  status: PlanJobStatus;
  planId: string | null;
  submittedAt: string;
}
