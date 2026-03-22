import { NextFunction, Request, Response } from "express";
import { ApiError } from "../utils/http";

function apiKeyAuth(req: Request, _res: Response, next: NextFunction): void {
  const configuredKey = process.env.API_KEY;
  if (!configuredKey) {
    return next();
  }

  const headerKey = req.header("x-api-key");
  if (headerKey !== configuredKey) {
    return next(new ApiError("UNAUTHORIZED", "No valid auth token or API key.", 401));
  }

  return next();
}

export { apiKeyAuth };
