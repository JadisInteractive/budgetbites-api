import { Router } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { generatePlanHandler, getJobHandler } from "../controllers/plansController";

const router = Router();

router.post("/plans/generations", asyncHandler(generatePlanHandler));
router.get("/jobs/:jobId", asyncHandler(getJobHandler));

export default router;
