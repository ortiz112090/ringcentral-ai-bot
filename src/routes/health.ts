import { Router } from "express";

/** Health check used by Render (health check path = /health). */
export const healthRouter = Router();

healthRouter.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", ts: new Date().toISOString() });
});
