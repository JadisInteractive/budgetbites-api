import { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { sendApiError, sendJobAccepted } from "../utils/http";
import { checkPricingAvailability } from "../services/priceService";
import { enqueueJob } from "../services/planJobService";
import {
  HouseholdModel,
  PacketFormat,
  PlanContext,
  ProteinEmphasis,
} from "../types/plans";

const PLAN_CONTEXTS: PlanContext[] = ["b2c", "b2b_clinic"];
const HOUSEHOLD_MODELS: HouseholdModel[] = [
  "1_adult", "2_adults", "1a_1c", "1a_2c", "2a_1c", "2a_2c", "3plus_adults",
];
const PROTEIN_EMPHASES: ProteinEmphasis[] = ["lean", "plant_forward", "high_protein"];
const PACKET_FORMATS: PacketFormat[] = [
  "traffic_light_family", "traffic_light_adult", "standard_weekly",
];
const PATIENT_REF_PATTERN = /^[A-Z0-9\-]{3,40}$/;

const HealthConstraintsSchema = z.object({
  conditions: z.array(z.string()),
  sodiumTargetMg: z.number().nullable(),
  carbTargetG: z.number().nullable(),
  calorieTarget: z.number().nullable(),
  proteinEmphasis: z.enum(["lean", "plant_forward", "high_protein"] as [ProteinEmphasis, ...ProteinEmphasis[]]),
  foodsToAvoid: z.array(z.string()),
});

const PlanGenerateRequestSchema = z.object({
  context: z.enum(["b2c", "b2b_clinic"] as [PlanContext, ...PlanContext[]]),
  userId: z.string().optional(),
  patientRef: z.string().optional(),
  clinicId: z.string().optional(),
  householdModel: z.enum(HOUSEHOLD_MODELS as [HouseholdModel, ...HouseholdModel[]]),
  ageGroup: z.enum(["adult", "senior", "pediatric"]).optional(),
  preferredLanguage: z.enum(["en", "es"]).optional(),
  healthConstraints: HealthConstraintsSchema,
  chainId: z.string().min(1),
  storeId: z.string().min(1),
  weekOf: z.string().min(1),
  budgetUsd: z.number().min(20).max(500),
  packetFormat: z.enum(PACKET_FORMATS as [PacketFormat, ...PacketFormat[]]).optional(),
  clinicalNotes: z.string().nullable().optional(),
});

export async function generatePlanHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const requestId = res.locals["requestId"] as string;

  // TODO: check Idempotency-Key header and replay if duplicate
  // const idempotencyKey = req.header("Idempotency-Key");

  // 1. Parse and validate request shape
  const parseResult = PlanGenerateRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    const details: Record<string, unknown> = {};
    for (const issue of parseResult.error.issues) {
      details[issue.path.join(".") || "body"] = issue.message;
    }
    sendApiError(
      res,
      400,
      "VALIDATION_ERROR",
      "Request validation failed.",
      details,
      requestId
    );
    return;
  }

  const body = parseResult.data;

  // 2. B2B-specific field requirements
  if (body.context === "b2b_clinic") {
    if (!body.patientRef) {
      sendApiError(
        res,
        400,
        "VALIDATION_ERROR",
        "patientRef is required for b2b_clinic context.",
        { patientRef: "required" },
        requestId
      );
      return;
    }
    if (!PATIENT_REF_PATTERN.test(body.patientRef)) {
      sendApiError(
        res,
        400,
        "INVALID_PATIENT_REF",
        "patientRef must match pattern /^[A-Z0-9\\-]{3,40}$/ and must not contain PHI.",
        { patientRef: body.patientRef },
        requestId
      );
      return;
    }
    if (!body.clinicId) {
      sendApiError(
        res,
        400,
        "VALIDATION_ERROR",
        "clinicId is required for b2b_clinic context.",
        { clinicId: "required" },
        requestId
      );
      return;
    }
  }

  // 3. weekOf must be a valid ISO date and must be a Monday
  const weekOfDate = new Date(body.weekOf);
  if (isNaN(weekOfDate.getTime())) {
    sendApiError(
      res,
      400,
      "VALIDATION_ERROR",
      "weekOf must be a valid ISO date string.",
      { weekOf: body.weekOf },
      requestId
    );
    return;
  }
  if (weekOfDate.getUTCDay() !== 1) {
    sendApiError(
      res,
      400,
      "VALIDATION_ERROR",
      "weekOf must be a Monday (ISO 8601 week start).",
      { weekOf: body.weekOf },
      requestId
    );
    return;
  }

  // 4. Check pricing availability synchronously — must happen before job is enqueued
  let pricing;
  try {
    pricing = await checkPricingAvailability(body.chainId, body.storeId, body.weekOf);
  } catch (err) {
    return next(err);
  }

  if (!pricing.available) {
    sendApiError(
      res,
      409,
      "PRICING_DATA_UNAVAILABLE",
      "No pricing records found for the requested chain, store, and week.",
      {
        chainId: body.chainId,
        storeId: body.storeId,
        weekOf: body.weekOf,
      },
      requestId
    );
    return;
  }

  // 5. Enqueue the job
  const traceId = uuidv4();
  let jobId: string;
  try {
    jobId = await enqueueJob(body, traceId);
  } catch (err) {
    return next(err);
  }

  sendJobAccepted(res, {
    jobId,
    status: "queued",
    planId: null,
    submittedAt: new Date().toISOString(),
  });
}

export async function getJobHandler(
  req: Request,
  res: Response,
  _next: NextFunction
): Promise<void> {
  // Stub: returns a mock queued status so the frontend can integrate
  res.json({
    jobId: req.params["jobId"],
    status: "queued",
    planId: null,
    submittedAt: new Date().toISOString(),
  });
}
