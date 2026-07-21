import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- Mutable effective config; flipped per test. ----
const cfg: any = {
  botRole: "answer_and_followup",
  text: { timezone: "UTC" },
  dropcowboy: { teamId: "team-1", secret: "sekret", brandId: "brand-9" },
  twilio: { number: "+15550000001" },
};
vi.mock("../config", () => ({
  resolveEffectiveConfig: vi.fn(async () => cfg),
  dropCowboyStatusCallbackUrl: vi.fn(
    () => "https://bot.example.com/webhooks/dropcowboy/status?token=abc"
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

const getRunningCampaigns = vi.fn(async () => [] as any[]);
const claimPendingContacts = vi.fn(async () => [] as any[]);
const countPendingContacts = vi.fn(async () => 0);
const setContactStatus = vi.fn(async () => {});
const completeCampaign = vi.fn(async () => {});
vi.mock("./campaignQueries", () => ({
  getRunningCampaigns: (...a: any[]) => getRunningCampaigns(...a),
  claimPendingContacts: (...a: any[]) => claimPendingContacts(...a),
  countPendingContacts: (...a: any[]) => countPendingContacts(...a),
  setContactStatus: (...a: any[]) => setContactStatus(...a),
  completeCampaign: (...a: any[]) => completeCampaign(...a),
}));

const sendRvm = vi.fn(async () => ({ ok: true, status: 200, body: "OK" }));
vi.mock("./dropcowboy", async () => {
  const actual = await vi.importActual<typeof import("./dropcowboy")>("./dropcowboy");
  return { ...actual, sendRvm: (...a: any[]) => sendRvm(...a) };
});

import { pacePerTick, processRvmCampaign, runRvmTick } from "./rvmWorker";

const campaign = {
  id: "camp-1",
  bot_id: "00000000-0000-0000-0000-000000000001",
  name: "RVM Blast",
  campaign_type: "voicemail_drops" as const,
  status: "running" as const,
  pace_per_hour: 120,
  dc_recording_id: "rec-guid-123",
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
  credentials: cfg.dropcowboy,
  forwardingNumber: cfg.twilio.number,
  callbackUrl: "https://bot.example.com/webhooks/dropcowboy/status?token=abc",
};

beforeEach(() => {
  vi.clearAllMocks();
  cfg.botRole = "answer_and_followup";
  cfg.text.timezone = "UTC";
  cfg.dropcowboy = { teamId: "team-1", secret: "sekret", brandId: "brand-9" };
  isPhoneOptedOut.mockResolvedValue(false);
  sendRvm.mockResolvedValue({ ok: true, status: 200, body: "OK" });
});

describe("pacePerTick", () => {
  it("is ceil(pace/60), minimum 1", () => {
    expect(pacePerTick(120)).toBe(2);
    expect(pacePerTick(100)).toBe(2); // ceil(1.66)
    expect(pacePerTick(60)).toBe(1);
    expect(pacePerTick(1)).toBe(1);
    expect(pacePerTick(0)).toBe(1);
    expect(pacePerTick(-5)).toBe(1);
    expect(pacePerTick(NaN)).toBe(1);
  });
});

describe("processRvmCampaign", () => {
  it("claims a paced batch and marks each sent on a 200", async () => {
    claimPendingContacts.mockResolvedValueOnce([contact(1), contact(2)]);
    await processRvmCampaign(campaign, ctx);
    expect(claimPendingContacts).toHaveBeenCalledWith("camp-1", 2); // ceil(120/60)
    expect(sendRvm).toHaveBeenCalledTimes(2);
    expect(setContactStatus).toHaveBeenCalledWith(1, "sent");
    expect(setContactStatus).toHaveBeenCalledWith(2, "sent");
  });

  it("builds the RVM payload with foreign_id + digits-only phone", async () => {
    claimPendingContacts.mockResolvedValueOnce([contact(7, "+15551234567")]);
    await processRvmCampaign(campaign, ctx);
    const payload = sendRvm.mock.calls[0][0] as any;
    expect(payload.foreign_id).toBe("7");
    expect(payload.phone_number).toBe("15551234567");
    expect(payload.recording_id).toBe("rec-guid-123");
    expect(payload.forwarding_number).toBe("+15550000001");
  });

  it("skips opted-out numbers as skipped/opted_out without sending", async () => {
    claimPendingContacts.mockResolvedValueOnce([contact(1), contact(2)]);
    isPhoneOptedOut.mockImplementation(async (phone: string) => phone === contact(1).phone_number);
    await processRvmCampaign(campaign, ctx);
    expect(setContactStatus).toHaveBeenCalledWith(1, "skipped", "opted_out");
    expect(sendRvm).toHaveBeenCalledTimes(1); // only contact 2 was dropped
    expect(setContactStatus).toHaveBeenCalledWith(2, "sent");
  });

  it("marks failed with the response text on a non-200", async () => {
    claimPendingContacts.mockResolvedValueOnce([contact(1)]);
    sendRvm.mockResolvedValueOnce({ ok: false, status: 422, body: "bad recording" });
    await processRvmCampaign(campaign, ctx);
    expect(setContactStatus).toHaveBeenCalledWith(1, "failed", "bad recording");
  });

  it("isolates a throwing contact so the rest of the batch proceeds", async () => {
    claimPendingContacts.mockResolvedValueOnce([contact(1), contact(2)]);
    sendRvm.mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    await processRvmCampaign(campaign, ctx);
    expect(setContactStatus).toHaveBeenCalledWith(1, "failed", "boom");
    expect(setContactStatus).toHaveBeenCalledWith(2, "sent");
  });

  it("completes the campaign when no pending contacts remain", async () => {
    claimPendingContacts.mockResolvedValueOnce([]);
    countPendingContacts.mockResolvedValueOnce(0);
    await processRvmCampaign(campaign, ctx);
    expect(completeCampaign).toHaveBeenCalledWith("camp-1");
  });

  it("does NOT complete when the batch is empty but pending still remain", async () => {
    claimPendingContacts.mockResolvedValueOnce([]);
    countPendingContacts.mockResolvedValueOnce(5);
    await processRvmCampaign(campaign, ctx);
    expect(completeCampaign).not.toHaveBeenCalled();
  });

  it("skips a campaign with no dc_recording_id (never sends)", async () => {
    await processRvmCampaign({ ...campaign, dc_recording_id: null }, ctx);
    expect(claimPendingContacts).not.toHaveBeenCalled();
    expect(sendRvm).not.toHaveBeenCalled();
  });
});

describe("runRvmTick gates", () => {
  const noon = new Date("2026-07-21T12:00:00Z"); // inside 8am–9pm UTC

  it("processes running campaigns for the answer_and_followup role in-window", async () => {
    getRunningCampaigns.mockResolvedValueOnce([campaign]);
    claimPendingContacts.mockResolvedValueOnce([contact(1)]);
    await runRvmTick(noon);
    expect(getRunningCampaigns).toHaveBeenCalledWith("voicemail_drops");
    expect(sendRvm).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the role is not answer_and_followup", async () => {
    cfg.botRole = "answer_calls";
    await runRvmTick(noon);
    expect(getRunningCampaigns).not.toHaveBeenCalled();
  });

  it("skips the entire tick outside quiet hours (before 8am)", async () => {
    const early = new Date("2026-07-21T05:00:00Z");
    await runRvmTick(early);
    expect(getRunningCampaigns).not.toHaveBeenCalled();
  });

  it("skips the tick when Drop Cowboy credentials are missing", async () => {
    cfg.dropcowboy = { teamId: undefined, secret: undefined, brandId: undefined };
    await runRvmTick(noon);
    expect(getRunningCampaigns).not.toHaveBeenCalled();
  });
});
