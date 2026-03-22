import "dotenv/config";
import express from "express";
import { requestIdMiddleware } from "./middleware/requestId";
import { apiKeyAuth } from "./middleware/auth";
import { errorHandler, notFoundHandler } from "./middleware/errorHandlers";
import plansRouter from "./routes/plans";

const app = express();

app.use(express.json());
app.use(requestIdMiddleware);
app.use(apiKeyAuth);

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api/v1", plansRouter);

app.use(notFoundHandler);
app.use(errorHandler);

export { app };
