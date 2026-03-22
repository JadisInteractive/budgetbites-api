// Plan generation worker — processes queued jobs from the plan_jobs table.
// Follows the same pattern as ../grocery-scraper/src/workers/scrapeWorker.ts.
//
// Pipeline steps (to be implemented in subsequent sessions):
//   Step 3: Retrieve pricing from grocery_prices for chainId/storeId/weekOf
//   Step 4: Nutrition Rules Engine resolves healthConstraints → scored item list
//   Step 5: Recipe Matcher selects compliant meal combinations
//   Step 6: Assemble deterministic payload (prices + macros + item lists)
//   Step 7: AI Kernel receives computed payload → generates narrative layer only
//   Step 8: Validate AI output against schema → fallback if invalid → persist plan

const POLL_MS = Number(process.env.PLAN_WORKER_POLL_MS ?? 2000);

// eslint-disable-next-line no-console
const log = (...args: unknown[]) => console.log(`[plan-worker]`, ...args);

export async function processNextJob(): Promise<boolean> {
  // TODO: claim next queued job from plan_jobs using FOR UPDATE SKIP LOCKED
  // TODO: run pipeline steps 3–8
  log("processNextJob not yet implemented");
  return false;
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
