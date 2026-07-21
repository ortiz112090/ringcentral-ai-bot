import express from "express";
import { config } from "./config";
import { logger } from "./logger";
import { healthRouter } from "./routes/health";
import { webhookRouter } from "./routes/webhooks";
import { twilioVoiceRouter } from "./twilio/voiceWebhook";
import { smsRouter } from "./sms/smsRoutes";
import { dropcowboyRouter } from "./campaigns/rvmRoutes";
import { startRvmWorker } from "./campaigns/rvmWorker";
import { outboundVoiceRouter } from "./campaigns/outboundRoutes";
import { startOutboundWorker } from "./campaigns/outboundWorker";
import { attachTwilioMediaStream } from "./twilio/mediaStream";
import { provisionTextNumber, provisionTwilioNumber } from "./twilio/provisioning";
import { BOT_ID, getRemoteConfig, loadRemoteConfig } from "./db/remoteConfig";
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
  app.use(smsRouter);
  app.use(dropcowboyRouter);
  app.use(outboundVoiceRouter);

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

  // Twilio-native startup. RingCentral is retired from the hot path entirely — no
  // RC login, no RC webhook subscription (the /webhooks/ringcentral route stays
  // mounted but never answers/bridges). Instead, assert this tenant is on Twilio
  // and idempotently point its number at our webhooks.
  //
  // telephony_provider defaults to 'twilio' for new bots; a null/blank value is
  // treated as 'twilio'. If it's set to anything else, this tenant isn't Twilio-
  // native: log a clear warning and skip Twilio provisioning (don't crash — the
  // service still starts and stays healthy).
  const telephonyProvider = (getRemoteConfig().botConfig?.telephony_provider ?? "twilio")
    .trim()
    .toLowerCase();
  if (telephonyProvider !== "twilio") {
    logger.warn(
      "telephony_provider is not 'twilio' for this tenant; skipping Twilio number " +
        "provisioning (bot is Twilio-native and won't apply to this tenant)",
      { botId: BOT_ID, telephonyProvider }
    );
  } else {
    // Non-fatal by contract (provisionTwilioNumber wraps its own try/catch).
    await provisionTwilioNumber();
    // Also point the tenant's SMS number at our messaging webhook. Opt-in: an
    // unset text_number is a no-op skip. Non-fatal (wraps its own try/catch).
    await provisionTextNumber();
  }

  // Start the Drop Cowboy RVM campaign worker. Always started; it self-gates each
  // tick on the answer_and_followup role, quiet hours, and credentials (read fresh),
  // so a role/credential change applies with no redeploy. Never fatal — the tick
  // swallows its own errors and the interval is unref'd.
  startRvmWorker();

  // Start the outbound-calling campaign worker. Always started; it self-gates each
  // tick on the outbound_calls role, quiet hours, Twilio credentials, and the single
  // concurrency slot (all read fresh), so a role/credential change applies with no
  // redeploy. Never fatal — the tick swallows its own errors and the interval is
  // unref'd.
  startOutboundWorker();

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
