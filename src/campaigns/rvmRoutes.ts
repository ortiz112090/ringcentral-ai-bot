import { Router, Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { config } from "../config";
import { logger } from "../logger";
import { BOT_ID } from "../db/remoteConfig";
import { findContactById, setContactStatus, type ContactStatus } from "./campaignQueries";

/**
 * Drop Cowboy RVM delivery-status webhook (POST /webhooks/dropcowboy/status).
 *
 * FAIL CLOSED: the request is rejected unless the ?token query param equals the
 * DC_WEBHOOK_TOKEN env. When that env is unset we return 503 (never trust an
 * unauthenticated callback), mirroring the text-outreach endpoint's pattern.
 *
 * Body carries foreign_id (= String(contact.id)) + a delivery status. We map it to
 * the contact's completed/failed state. An unknown foreign_id is a 200 no-op (the
 * drop may belong to another tenant/campaign or a since-deleted contact).
 */
export const dropcowboyRouter = Router();

/** Constant-time compare that never throws on length mismatch. */
function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Map a Drop Cowboy delivery status string to a contact terminal status. Delivered/
 * completed-like values → 'completed'; everything else that's present → 'failed'.
 * Returns null when the status is absent so the caller can record the raw body as
 * the outcome without changing state incorrectly.
 */
export function mapDeliveryStatus(status: string | undefined | null): ContactStatus | null {
  const s = (status ?? "").trim().toLowerCase();
  if (s === "") return null;
  if (["delivered", "completed", "success", "sent", "complete"].includes(s)) {
    return "completed";
  }
  return "failed";
}

/** Parse the foreign_id field into a numeric contact id, or null when unusable. */
function parseForeignId(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return parseInt(value.trim(), 10);
  return null;
}

export async function handleDropcowboyStatus(req: Request, res: Response): Promise<Response> {
  // Auth: shared token in the query string. Fail closed when unset → 503.
  const expected = config.dcWebhookToken.trim();
  if (expected === "") {
    logger.error("Drop Cowboy status webhook hit but DC_WEBHOOK_TOKEN is unset; refusing");
    return res.status(503).json({ error: "webhook_not_configured" });
  }
  const provided = typeof req.query.token === "string" ? req.query.token : "";
  if (!provided || !tokensMatch(provided, expected)) {
    logger.warn("Rejected Drop Cowboy status webhook: bad or missing token");
    return res.status(403).json({ error: "invalid_token" });
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const contactId = parseForeignId(body.foreign_id);
  if (contactId === null) {
    logger.warn("Drop Cowboy status webhook: missing/invalid foreign_id");
    return res.status(200).json({ ok: true, ignored: "no_foreign_id" });
  }

  const contact = await findContactById(contactId);
  if (!contact) {
    // Unknown foreign_id (other tenant, deleted contact) → 200 no-op.
    logger.info("Drop Cowboy status webhook: unknown foreign_id (no-op)", { botId: BOT_ID, contactId });
    return res.status(200).json({ ok: true, ignored: "unknown_contact" });
  }

  const rawStatus =
    typeof body.status === "string"
      ? body.status
      : typeof body.delivery_status === "string"
      ? body.delivery_status
      : "";
  const mapped = mapDeliveryStatus(rawStatus);
  const outcome = rawStatus.trim() !== "" ? rawStatus : "unknown";
  await setContactStatus(contactId, mapped ?? "failed", outcome);
  logger.info("Drop Cowboy status applied to contact", {
    botId: BOT_ID,
    contactId,
    mapped: mapped ?? "failed",
  });
  return res.status(200).json({ ok: true });
}

dropcowboyRouter.post("/webhooks/dropcowboy/status", handleDropcowboyStatus);
