import { Response } from "express";
import { PlanJobResponse } from "../types/plans";

class ApiError extends Error {
  status: number;
  code: string;
  details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    status = 400,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function sendApiError(
  res: Response,
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
  requestId?: string
): void {
  res.status(status).json({
    error: {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
      requestId: requestId ?? null,
    },
  });
}

function sendJobAccepted(res: Response, payload: PlanJobResponse): void {
  res.status(202).json(payload);
}

export { ApiError, sendApiError, sendJobAccepted };
