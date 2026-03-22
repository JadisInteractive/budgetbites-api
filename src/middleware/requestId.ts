import { NextFunction, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";

function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = uuidv4();
  res.locals["requestId"] = requestId;
  res.setHeader("X-Request-Id", requestId);
  next();
}

export { requestIdMiddleware };
