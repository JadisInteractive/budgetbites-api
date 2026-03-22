import { Router } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import {
  generatePlanHandler,
  getJobHandler,
  getPlanHandler,
} from "../controllers/plansController";

const router = Router();

router.post("/plans/generations", asyncHandler(generatePlanHandler));
router.get("/jobs/:jobId", asyncHandler(getJobHandler));
router.get("/plans/:planId", asyncHandler(getPlanHandler));

export default router;
