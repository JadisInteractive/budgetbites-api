import { NextFunction, Request, Response } from "express";
import { ApiError, sendApiError } from "../utils/http";

function notFoundHandler(req: Request, res: Response): void {
  const requestId = res.locals["requestId"] as string | undefined;
  sendApiError(res, 404, "NOT_FOUND", "The requested resource was not found.", undefined, requestId);
}

function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  void _next;

  const requestId = res.locals["requestId"] as string | undefined;

  if (err instanceof ApiError) {
    sendApiError(res, err.status, err.code, err.message, err.details, requestId);
    return;
  }

  // eslint-disable-next-line no-console
  console.error(err);
  sendApiError(
    res,
    500,
    "INTERNAL_ERROR",
    "An unexpected error occurred.",
    undefined,
    requestId
  );
}

export { errorHandler, notFoundHandler };
