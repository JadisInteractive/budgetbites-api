// AI Kernel — bounded AI orchestration layer.
//
// RULES (from CLAUDE.md and BACKEND_ENGINEER.md):
// - Called at Step 7 of 8 ONLY — after all deterministic computation is complete.
// - Receives: DeterministicPayload (no identity fields, no clinical notes, no PHI).
// - Returns: narrative layer only — weeklyOverview, budgetNarrative, itemExplanations, healthHighlights.
// - NEVER invents prices, macros, quantities, or clinical guidance.
// - All AI output is schema-validated with Zod. Invalid output → deterministic fallback.
// - Every call is logged to ai_kernel_log. PHI staging gate: input column must never
//   contain patientRef, clinicId, or clinicalNotes.

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { pool } from "../db/pool";
import { AIKernelOutput, DeterministicPayload } from "../types/plans";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const MODEL = process.env.AI_KERNEL_MODEL ?? "claude-sonnet-4-6";
const MAX_TOKENS = 1024;

// ---------------------------------------------------------------------------
// Output schema — all AI responses are validated before use.
// Invalid response → FALLBACK_OUTPUT; fallbackUsed=true recorded.
// ---------------------------------------------------------------------------
const AIKernelOutputSchema = z.object({
  weeklyOverview:   z.string().min(1).max(1000),
  budgetNarrative:  z.string().min(1).max(500),
  itemExplanations: z.array(
    z.object({
      productName: z.string().min(1),
      explanation: z.string().min(1).max(300),
    })
  ).min(0),
  healthHighlights: z.array(z.string().min(1).max(200)).min(1).max(5),
});

// ---------------------------------------------------------------------------
// Deterministic fallback — used when AI output fails schema validation or
// the model is unreachable. fallbackUsed=true is always recorded in the audit.
// ---------------------------------------------------------------------------
const FALLBACK_OUTPUT: AIKernelOutput = {
  weeklyOverview:
    "Your weekly grocery plan has been prepared based on your budget and health goals. Items were selected to align with your household's nutritional needs.",
  budgetNarrative:
    "Selected items fit within your weekly budget with a 10% safety buffer applied to help manage price fluctuations.",
  itemExplanations: [],
  healthHighlights: [
    "Plan prioritizes items that fit your health constraints.",
    "Budget buffer helps account for price fluctuations at the store.",
    "Green-rated items reflect nutritionally preferred choices for your household.",
  ],
};

const SYSTEM_PROMPT = `You are the BudgetBites Meal Plan Narrator.

You receive a pre-computed weekly grocery plan and generate plain-language explanations for the household. You do NOT make any decisions about what to buy — those decisions are already made.

Rules:
- NEVER invent prices, quantities, macros, or nutritional values. All numbers in your response must come from the payload you receive.
- Explain warmly and clearly why the selected items are a good fit (health alignment, budget value, household size).
- Keep language practical and encouraging — suitable for families managing a health condition.
- Respond ONLY with valid JSON. No markdown, no extra text, only the JSON object.

Required JSON schema:
{
  "weeklyOverview": "<2-3 sentence summary of the week's plan for this household>",
  "budgetNarrative": "<1-2 sentences about how the budget was used>",
  "itemExplanations": [
    { "productName": "<exact product name from the payload>", "explanation": "<1 sentence why this item was selected>" }
  ],
  "healthHighlights": ["<bullet 1>", "<bullet 2>", "<bullet 3>"]
}`;

// ---------------------------------------------------------------------------
// PHI GUARD — only the fields listed here are forwarded to the model.
// patientRef, clinicId, and clinicalNotes must NEVER appear in this object.
// This function is the enforcement point for the PHI staging gate.
// ---------------------------------------------------------------------------
function buildUserContent(payload: DeterministicPayload): string {
  return JSON.stringify({
    weekOf:              payload.weekOf,
    householdModel:      payload.householdModel,
    budgetUsd:           payload.budgetUsd,
    effectiveBudgetUsd:  payload.effectiveBudgetUsd,
    totalCostUsd:        payload.totalCostUsd,
    resolvedConstraints: payload.resolvedConstraints,
    trafficLightSummary: payload.trafficLightSummary,
    selectedItems: payload.selectedItems.map((item) => ({
      productName:  item.productName,
      price:        item.price,
      trafficLight: item.trafficLight,
    })),
  });
}

// ---------------------------------------------------------------------------
// Audit logging — best-effort; never throws, never blocks the pipeline.
// ---------------------------------------------------------------------------
async function logKernelCall(params: {
  modelCallId: string;
  planId: string;
  traceId: string;
  model: string;
  input: DeterministicPayload;
  output: AIKernelOutput | null;
  fallbackUsed: boolean;
  latencyMs: number;
}): Promise<void> {
  await pool.query(
    `INSERT INTO ai_kernel_log
       (model_call_id, plan_id, trace_id, model, input, output, fallback_used, latency_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (model_call_id) DO NOTHING`,
    [
      params.modelCallId,
      params.planId,
      params.traceId,
      params.model,
      buildUserContent(params.input), // PHI guard applied — same field set as model call
      params.output ? JSON.stringify(params.output) : null,
      params.fallbackUsed,
      params.latencyMs,
    ]
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export async function callAIKernel(
  payload: DeterministicPayload,
  traceId: string,
  planId: string
): Promise<{ output: AIKernelOutput; modelCallId: string; fallbackUsed: boolean }> {
  const modelCallId = `kernel_${traceId}_${Date.now()}`;
  const start = Date.now();

  const returnFallback = async (): Promise<{
    output: AIKernelOutput;
    modelCallId: string;
    fallbackUsed: boolean;
  }> => {
    await logKernelCall({
      modelCallId,
      planId,
      traceId,
      model: MODEL,
      input: payload,
      output: null,
      fallbackUsed: true,
      latencyMs: Date.now() - start,
    }).catch(() => void 0);
    return { output: FALLBACK_OUTPUT, modelCallId, fallbackUsed: true };
  };

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserContent(payload) }],
    });

    const block = response.content[0];
    if (!block || block.type !== "text") return returnFallback();

    let parsed: unknown;
    try {
      parsed = JSON.parse(block.text);
    } catch {
      return returnFallback();
    }

    const validation = AIKernelOutputSchema.safeParse(parsed);
    if (!validation.success) return returnFallback();

    const output = validation.data;
    await logKernelCall({
      modelCallId,
      planId,
      traceId,
      model: MODEL,
      input: payload,
      output,
      fallbackUsed: false,
      latencyMs: Date.now() - start,
    }).catch(() => void 0);

    return { output, modelCallId, fallbackUsed: false };
  } catch {
    return returnFallback();
  }
}
