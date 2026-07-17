import express from "express";
import { config } from "./config";
import { logger } from "./logger";
import { healthRouter } from "./routes/health";
import { webhookRouter } from "./routes/webhooks";
import { twilioVoiceRouter } from "./twilio/voiceWebhook";
import { attachTwilioMediaStream } from "./twilio/mediaStream";
import { ensureLogin } from "./ringcentral/client";
import { ensureWebhookSubscription } from "./ringcentral/telephony";
import { loadRemoteConfig } from "./db/remoteConfig";
import { closeStaleLiveCalls } from "./db/queries";

async function main(): Promise<void> {
  const app = express();

  // RingCentral posts JSON notifications; keep a healthy body limit for media metadata.
  app.use(express.json({ limit: "2mb" }));
  // Twilio posts application/x-www-form-urlencoded call params to its voice webhook.
  app.use(express.urlencoded({ extended: false }));

  app.use(healthRouter);
  app.use(webhookRouter);
  app.use(twilioVoiceRouter);

  // Global error handler so a thrown error in a route never takes down the process.
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      logger.error("Unhandled route error", {
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) res.status(500).json({ error: "internal_error" });
    }
  );

  const server = app.listen(config.port, () => {
    logger.info("Server listening", { port: config.port });
  });

  // Attach the Twilio Media Streams WebSocket endpoint (/twilio/media) to the same
  // HTTP server — no new port. Bridges inbound call audio to the Realtime engine.
  attachTwilioMediaStream(server);

  // Warm the Supabase-backed config cache before anything reads it. Non-fatal:
  // on failure the bot proceeds on env vars alone. Never log secret values.
  try {
    const remote = await loadRemoteConfig();
    logger.info("Remote config loaded", {
      botConfigFound: remote.botConfig !== null,
      credentialProviders: Object.keys(remote.credentials),
      compiledInstructionsPresent: Boolean(
        remote.botConfig?.compiled_instructions &&
          remote.botConfig.compiled_instructions.trim() !== ""
      ),
    });
  } catch (err) {
    logger.error("Remote config load failed (continuing on env vars)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Close out any "ghost live calls" left with ended_at NULL by a prior crash/
  // restart, so the dashboard's LIVE view isn't stuck. Non-fatal.
  await closeStaleLiveCalls();

  // Authenticate to RingCentral and (re)establish the webhook subscription.
  // Failures here are logged but non-fatal — the health check must still pass so
  // Render considers the service up, and the operator can fix creds and redeploy.
  try {
    await ensureLogin();
    if (config.publicBaseUrl) {
      await ensureWebhookSubscription(
        `${config.publicBaseUrl.replace(/\/$/, "")}/webhooks/ringcentral`
      );
    } else {
      logger.warn("PUBLIC_BASE_URL not set; skipping webhook subscription setup");
    }
  } catch (err) {
    logger.error("RingCentral startup init failed (service still running)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const shutdown = (signal: string) => {
    logger.info("Shutting down", { signal });
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Last-resort guards: log and keep running rather than crash mid-call.
  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled promise rejection", { reason: String(reason) });
  });
  process.on("uncaughtException", (err) => {
    logger.error("Uncaught exception", { error: err.message });
  });
}

main().catch((err) => {
  logger.error("Fatal startup error", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
