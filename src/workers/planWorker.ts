// Plan generation worker — processes queued jobs from the plan_jobs table.
// Follows the same FOR UPDATE SKIP LOCKED pattern as grocery-scraper/src/workers/scrapeWorker.ts.
//
// Pipeline:
//   Step 3: Retrieve pricing from grocery_prices for chainId/storeId/weekOf
//   Step 4: Nutrition Rules Engine resolves healthConstraints
//   Step 5: Recipe Matcher scores and selects compliant items within budget
//   Step 6: Assemble deterministic payload (prices + macros + traffic light)
//   Step 7: AI Kernel receives computed payload → generates narrative layer only
//   Step 8: Validate AI output (done inside aiKernel) → persist plan → update job

import { createHash } from "crypto";
import { callAIKernel } from "../services/aiKernel";
import {
  claimNextPlanJob,
  completePlanJob,
  updatePlanJobStatus,
} from "../services/planJobService";
import { completePlan, createPlan, failPlan } from "../services/planService";
import { getPricesForWeek } from "../services/priceService";
import {
  assembleDeterministicPayload,
  scoreItems,
  selectItems,
} from "../services/recipeMatcher";
import { resolveConstraints } from "../services/nutritionRules";
import { HealthConstraints, PlanGenerateRequest } from "../types/plans";

const POLL_MS = Number(process.env.PLAN_WORKER_POLL_MS ?? 2000);
const VERBOSE = process.env.PLAN_WORKER_VERBOSE === "true";

// eslint-disable-next-line no-console
const log = (...args: unknown[]) => console.log(`[plan-worker]`, ...args);
// eslint-disable-next-line no-console
const logError = (...args: unknown[]) => console.error(`[plan-worker]`, ...args);

export async function processNextJob(): Promise<boolean> {
  const job = await claimNextPlanJob();
  if (!job) {
    if (VERBOSE) log("no queued jobs, polling...");
    return false;
  }

  const request = job.request as PlanGenerateRequest;
  log(`▶ job ${job.id} | chain=${request.chainId} store=${request.storeId} week=${request.weekOf}`);

  const start = Date.now();
  let planId: string | undefined;

  try {
    // -----------------------------------------------------------------------
    // Step 3: Retrieve pricing data
    // -----------------------------------------------------------------------
    if (VERBOSE) log("  step 3: fetching pricing data...");
    const prices = await getPricesForWeek(
      request.chainId,
      request.storeId,
      request.weekOf
    );
    if (VERBOSE) log(`  step 3: ${prices.length} price entries retrieved`);

    const scrapeRunId = prices[0]?.scrape_run_id ?? null;

    // -----------------------------------------------------------------------
    // Step 4: Nutrition Rules Engine
    // -----------------------------------------------------------------------
    if (VERBOSE) log("  step 4: resolving health constraints...");
    const constraints: HealthConstraints = request.healthConstraints;
    const resolved = resolveConstraints(constraints);
    const constraintsHash = createHash("sha256")
      .update(JSON.stringify(constraints))
      .digest("hex");
    if (VERBOSE) log(`  step 4: constraints hash ${constraintsHash.slice(0, 8)}...`);

    // -----------------------------------------------------------------------
    // Create the plan record (status: 'generating') before pipeline continues
    // -----------------------------------------------------------------------
    planId = await createPlan(
      job.id,
      job.trace_id,
      scrapeRunId,
      constraintsHash,
      job.clinic_id,
      job.patient_ref,
      null // clinicalNotes never reach this layer — stored on job row only
    );
    if (VERBOSE) log(`  plan record created: ${planId}`);

    // -----------------------------------------------------------------------
    // Step 5: Recipe Matcher
    // -----------------------------------------------------------------------
    if (VERBOSE) log("  step 5: scoring and selecting items...");
    const scoredItems = scoreItems(prices, resolved);
    const effectiveBudget = Math.round(request.budgetUsd * 0.9 * 100) / 100;
    const selectedItems = selectItems(scoredItems, effectiveBudget, request.householdModel);
    if (VERBOSE) log(`  step 5: ${selectedItems.length} items selected`);

    // -----------------------------------------------------------------------
    // Step 6: Assemble deterministic payload
    // -----------------------------------------------------------------------
    if (VERBOSE) log("  step 6: assembling deterministic payload...");
    const deterministicPayload = assembleDeterministicPayload(
      {
        householdModel: request.householdModel,
        weekOf: request.weekOf,
        budgetUsd: request.budgetUsd,
        packetFormat: request.packetFormat,
      },
      resolved,
      selectedItems
    );

    // -----------------------------------------------------------------------
    // Step 7: AI Kernel — narrative layer only, no PHI in payload
    // -----------------------------------------------------------------------
    if (VERBOSE) log("  step 7: calling AI Kernel...");
    const { output: narrative, modelCallId, fallbackUsed } =
      await callAIKernel(deterministicPayload, job.trace_id);
    if (VERBOSE) log(`  step 7: AI Kernel complete (fallbackUsed=${fallbackUsed})`);

    // -----------------------------------------------------------------------
    // Step 8: Persist plan and update job
    // -----------------------------------------------------------------------
    if (VERBOSE) log("  step 8: persisting plan...");
    const packet = { deterministic: deterministicPayload, narrative };
    await completePlan(planId, packet, fallbackUsed, modelCallId);
    await completePlanJob(job.id, planId);

    log(
      `✔ job ${job.id} → plan ${planId} | ${Date.now() - start}ms | ` +
        `items=${selectedItems.length} fallback=${fallbackUsed}`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Plan generation failed";
    logError(`✖ job ${job.id} failed after ${Date.now() - start}ms:`, message);
    if (VERBOSE && error instanceof Error && error.stack) {
      logError(error.stack);
    }

    await updatePlanJobStatus(job.id, "failed", message);
    if (planId) {
      await failPlan(planId, message).catch(() => void 0);
    }
  }

  return true;
}

export async function runWorker(): Promise<void> {
  log("worker started");
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const didWork = await processNextJob();
    if (!didWork) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }
}
