import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- Mutable effective config; flipped per test. ----
const cfg: any = {
  botRole: "outbound_calls",
  text: { timezone: "UTC" },
  twilio: { number: "+15550000001" },
};
vi.mock("../config", () => ({
  resolveEffectiveConfig: vi.fn(async () => cfg),
  twilioStatusCallbackUrl: vi.fn(() => "https://bot.example.com/webhooks/twilio/status"),
  twilioVoiceOutboundWebhookUrl: vi.fn(
    (contactId: number | string) =>
      `https://bot.example.com/webhooks/twilio/voice-outbound?contactId=${contactId}`
  ),
}));
vi.mock("../db/remoteConfig", () => ({
  BOT_ID: "00000000-0000-0000-0000-000000000001",
  loadRemoteConfig: vi.fn(async () => ({})),
}));

const isPhoneOptedOut = vi.fn(async () => false);
vi.mock("../sms/smsQueries", () => ({
  isPhoneOptedOut: (...a: any[]) => isPhoneOptedOut(...a),
}));

const createCall = vi.fn(async () => ({ sid: "CAxxxx" }));
const getTwilioClient = vi.fn(async () => ({ calls: { create: createCall } }));
vi.mock("../twilio/client", () => ({
  getTwilioClient: (...a: any[]) => getTwilioClient(...a),
}));

const getRunningCampaigns = vi.fn(async () => [] as any[]);
const claimPendingContacts = vi.fn(async () => [] as any[]);
const countPendingContacts = vi.fn(async () => 0);
const setContactStatus = vi.fn(async () => {});
const setContactCallOutcome = vi.fn(async () => {});
const completeCampaign = vi.fn(async () => {});
vi.mock("./campaignQueries", () => ({
  getRunningCampaigns: (...a: any[]) => getRunningCampaigns(...a),
  claimPendingContacts: (...a: any[]) => claimPendingContacts(...a),
  countPendingContacts: (...a: any[]) => countPendingContacts(...a),
  setContactStatus: (...a: any[]) => setContactStatus(...a),
  setContactCallOutcome: (...a: any[]) => setContactCallOutcome(...a),
  completeCampaign: (...a: any[]) => completeCampaign(...a),
}));

import {
  mapCallStatusToContact,
  finalizeOutboundCall,
  placeOutboundCall,
  processOutboundCampaign,
  runOutboundTick,
  MAX_CONCURRENT_OUTBOUND,
} from "./outboundWorker";
import {
  clearOutboundCalls,
  isOutboundCall,
  liveOutboundCount,
  registerOutboundCall,
  getOutboundCall,
} from "./outboundState";

const campaign = {
  id: "camp-1",
  bot_id: "00000000-0000-0000-0000-000000000001",
  name: "Outbound Blast",
  campaign_type: "outbound_calls" as const,
  status: "running" as const,
  pace_per_hour: 120,
  dc_recording_id: null,
};

function contact(id: number, phone = "+1555000" + String(1000 + id)) {
  return {
    id,
    bot_id: campaign.bot_id,
    campaign_id: campaign.id,
    phone_number: phone,
    first_name: null,
    last_name: null,
    data: {},
    status: "processing" as const,
    outcome: null,
  };
}

const ctx = {
  client: { calls: { create: createCall } } as any,
  fromNumber: "+15550000001",
  statusCallbackUrl: "https://bot.example.com/webhooks/twilio/status",
};

beforeEach(() => {
  vi.clearAllMocks();
  clearOutboundCalls();
  cfg.botRole = "outbound_calls";
  cfg.text.timezone = "UTC";
  cfg.twilio = { number: "+15550000001" };
  isPhoneOptedOut.mockResolvedValue(false);
  createCall.mockResolvedValue({ sid: "CAxxxx" });
  getTwilioClient.mockResolvedValue({ calls: { create: createCall } });
});

describe("mapCallStatusToContact", () => {
  it("maps completed to a successful contact", () => {
    expect(mapCallStatusToContact("completed")).toEqual({
      status: "completed",
      outcome: "completed",
    });
  });

  it("maps every other terminal status to failed with the raw status", () => {
    expect(mapCallStatusToContact("no-answer")).toEqual({ status: "failed", outcome: "no-answer" });
    expect(mapCallStatusToContact("busy")).toEqual({ status: "failed", outcome: "busy" });
    expect(mapCallStatusToContact("failed")).toEqual({ status: "failed", outcome: "failed" });
    expect(mapCallStatusToContact("canceled")).toEqual({ status: "failed", outcome: "canceled" });
  });

  it("maps a blank status to failed/unknown and is case-insensitive", () => {
    expect(mapCallStatusToContact("")).toEqual({ status: "failed", outcome: "unknown" });
    expect(mapCallStatusToContact("COMPLETED")).toEqual({
      status: "completed",
      outcome: "completed",
    });
  });
});

describe("finalizeOutboundCall", () => {
  it("removes the registry entry and writes the mapped outcome", async () => {
    registerOutboundCall("CA1", 42, "camp-1");
    await finalizeOutboundCall("CA1", "completed");
    expect(isOutboundCall("CA1")).toBe(false);
    expect(setContactCallOutcome).toHaveBeenCalledWith(42, "completed", "completed", "CA1");
  });

  it("no-ops for an untracked CallSid", async () => {
    await finalizeOutboundCall("nope", "completed");
    expect(setContactCallOutcome).not.toHaveBeenCalled();
  });
});

describe("placeOutboundCall", () => {
  it("dials via Twilio, registers the call, and returns true", async () => {
    const ok = await placeOutboundCall(campaign, contact(5, "+15551234567"), ctx);
    expect(ok).toBe(true);
    expect(createCall).toHaveBeenCalledTimes(1);
    const arg = createCall.mock.calls[0][0] as any;
    expect(arg.to).toBe("+15551234567");
    expect(arg.from).toBe("+15550000001");
    expect(arg.machineDetection).toBe("Enable");
    expect(arg.url).toContain("contactId=5");
    expect(isOutboundCall("CAxxxx")).toBe(true);
    expect(getOutboundCall("CAxxxx")?.contactId).toBe(5);
  });

  it("marks the contact failed and returns false when Twilio returns no SID", async () => {
    createCall.mockResolvedValueOnce({});
    const ok = await placeOutboundCall(campaign, contact(6), ctx);
    expect(ok).toBe(false);
    expect(setContactCallOutcome).toHaveBeenCalledWith(6, "failed", "no_call_sid", null);
  });

  it("marks the contact failed and returns false when the dial throws", async () => {
    createCall.mockRejectedValueOnce(new Error("twilio boom"));
    const ok = await placeOutboundCall(campaign, contact(7), ctx);
    expect(ok).toBe(false);
    expect(setContactCallOutcome).toHaveBeenCalledWith(7, "failed", "twilio boom", null);
  });
});

describe("processOutboundCampaign", () => {
  it("claims a paced batch capped by the single concurrency slot", async () => {
    claimPendingContacts.mockResolvedValueOnce([contact(1)]);
    await processOutboundCampaign(campaign, ctx);
    // pacePerTick(120)=2, but MAX_CONCURRENT_OUTBOUND=1 caps the batch size to 1.
    expect(claimPendingContacts).toHaveBeenCalledWith("camp-1", MAX_CONCURRENT_OUTBOUND);
    expect(createCall).toHaveBeenCalledTimes(1);
  });

  it("does not claim or dial while a call is already live", async () => {
    registerOutboundCall("CA_live", 99, "camp-1");
    await processOutboundCampaign(campaign, ctx);
    expect(claimPendingContacts).not.toHaveBeenCalled();
    expect(createCall).not.toHaveBeenCalled();
  });

  it("skips opted-out numbers without dialing", async () => {
    claimPendingContacts.mockResolvedValueOnce([contact(1)]);
    isPhoneOptedOut.mockResolvedValueOnce(true);
    await processOutboundCampaign(campaign, ctx);
    expect(setContactStatus).toHaveBeenCalledWith(1, "skipped", "opted_out");
    expect(createCall).not.toHaveBeenCalled();
  });

  it("completes the campaign when the batch is empty and no pending remain", async () => {
    claimPendingContacts.mockResolvedValueOnce([]);
    countPendingContacts.mockResolvedValueOnce(0);
    await processOutboundCampaign(campaign, ctx);
    expect(completeCampaign).toHaveBeenCalledWith("camp-1");
  });

  it("does NOT complete when the batch is empty but pending still remain", async () => {
    claimPendingContacts.mockResolvedValueOnce([]);
    countPendingContacts.mockResolvedValueOnce(3);
    await processOutboundCampaign(campaign, ctx);
    expect(completeCampaign).not.toHaveBeenCalled();
  });

  it("stops dialing the rest of the batch once the slot is filled", async () => {
    // Even if somehow a larger batch comes back, only one dial goes out.
    claimPendingContacts.mockResolvedValueOnce([contact(1), contact(2)]);
    await processOutboundCampaign(campaign, ctx);
    expect(createCall).toHaveBeenCalledTimes(1);
    expect(liveOutboundCount()).toBe(1);
  });
});

describe("runOutboundTick gates", () => {
  const noon = new Date("2026-07-21T12:00:00Z"); // inside 8am–9pm UTC

  it("processes running outbound_calls campaigns in-window", async () => {
    getRunningCampaigns.mockResolvedValueOnce([campaign]);
    claimPendingContacts.mockResolvedValueOnce([contact(1)]);
    await runOutboundTick(noon);
    expect(getRunningCampaigns).toHaveBeenCalledWith("outbound_calls");
    expect(createCall).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the role is not outbound_calls", async () => {
    cfg.botRole = "answer_and_followup";
    await runOutboundTick(noon);
    expect(getRunningCampaigns).not.toHaveBeenCalled();
  });

  it("skips the entire tick outside quiet hours (before 8am)", async () => {
    const early = new Date("2026-07-21T05:00:00Z");
    await runOutboundTick(early);
    expect(getRunningCampaigns).not.toHaveBeenCalled();
  });

  it("skips the tick when no Twilio number is configured", async () => {
    cfg.twilio = { number: undefined };
    await runOutboundTick(noon);
    expect(getRunningCampaigns).not.toHaveBeenCalled();
  });

  it("skips the tick when Twilio credentials are missing", async () => {
    getTwilioClient.mockResolvedValueOnce(null);
    await runOutboundTick(noon);
    expect(getRunningCampaigns).not.toHaveBeenCalled();
  });

  it("prunes stale calls and marks their contacts failed", async () => {
    registerOutboundCall("CA_stale", 77, "camp-1");
    getOutboundCall("CA_stale")!.startedAtMs = noon.getTime() - 60 * 60 * 1000;
    getRunningCampaigns.mockResolvedValueOnce([]);
    await runOutboundTick(noon);
    expect(setContactCallOutcome).toHaveBeenCalledWith(
      77,
      "failed",
      "timeout_no_status",
      "CA_stale"
    );
    expect(isOutboundCall("CA_stale")).toBe(false);
  });
});
