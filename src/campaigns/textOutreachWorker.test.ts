import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- Mutable effective config; flipped per test. ----
const cfg: any = {
  botRole: "texting",
  text: {
    timezone: "UTC",
    rcSmsNumber: undefined as string | undefined,
    number: "+15550000001" as string | undefined,
  },
};
vi.mock("../config", () => ({
  resolveEffectiveConfig: vi.fn(async () => cfg),
}));
vi.mock("../db/remoteConfig", () => ({
  BOT_ID: "00000000-0000-0000-0000-000000000001",
  loadRemoteConfig: vi.fn(async () => ({})),
}));

const isPhoneOptedOut = vi.fn(async () => false);
const isPhoneDeclined = vi.fn(async () => false);
const isPhoneHandedOff = vi.fn(async () => false);
const getActiveOutreachTemplates = vi.fn(async () => [
  { id: "tmpl-1", template_text: "Hi {first_name}, following up!" },
]);
const findConversationByPhone = vi.fn(async () => null as any);
const createConversation = vi.fn(async (input: any) => ({
  id: "conv-" + input.phone_number,
  bot_id: "00000000-0000-0000-0000-000000000001",
  phone_number: input.phone_number,
  status: "active",
  trigger: input.trigger,
  channel: input.channel,
  captured_data: {},
  last_message_at: null,
  created_at: null,
}));
vi.mock("../sms/smsQueries", () => ({
  isPhoneOptedOut: (...a: any[]) => isPhoneOptedOut(...a),
  isPhoneDeclined: (...a: any[]) => isPhoneDeclined(...a),
  isPhoneHandedOff: (...a: any[]) => isPhoneHandedOff(...a),
  getActiveOutreachTemplates: (...a: any[]) => getActiveOutreachTemplates(...a),
  findConversationByPhone: (...a: any[]) => findConversationByPhone(...a),
  createConversation: (...a: any[]) => createConversation(...a),
}));

const sendSms = vi.fn(async () => ({ sent: true }) as { sent: boolean; reason?: string });
vi.mock("../sms/smsSend", async () => {
  const actual = await vi.importActual<typeof import("../sms/smsSend")>("../sms/smsSend");
  return { ...actual, sendSms: (...a: any[]) => sendSms(...a) };
});

const getRunningCampaigns = vi.fn(async () => [] as any[]);
const claimPendingContacts = vi.fn(async () => [] as any[]);
const countPendingContacts = vi.fn(async () => 0);
const setContactStatus = vi.fn(async () => {});
const completeCampaign = vi.fn(async () => {});
const getNewestAttemptedAt = vi.fn(async () => null as Date | null);
vi.mock("./campaignQueries", () => ({
  getRunningCampaigns: (...a: any[]) => getRunningCampaigns(...a),
  claimPendingContacts: (...a: any[]) => claimPendingContacts(...a),
  countPendingContacts: (...a: any[]) => countPendingContacts(...a),
  setContactStatus: (...a: any[]) => setContactStatus(...a),
  completeCampaign: (...a: any[]) => completeCampaign(...a),
  getNewestAttemptedAt: (...a: any[]) => getNewestAttemptedAt(...a),
}));

const runSync = vi.fn(async () => ({ accepted: true }) as any);
const isVelocifySyncDue = vi.fn(() => false);
vi.mock("./velocifySync", () => ({
  runSync: (...a: any[]) => runSync(...a),
  isVelocifySyncDue: (...a: any[]) => isVelocifySyncDue(...a),
}));

import {
  buildFirstMessage,
  personalizeTemplate,
  pickChannel,
  pickTemplate,
  processTextOutreachCampaign,
  runTextOutreachTick,
} from "./textOutreachWorker";

const campaign = {
  id: "camp-1",
  bot_id: "00000000-0000-0000-0000-000000000001",
  name: "Follow-up Blast",
  campaign_type: "text_outreach" as const,
  status: "running" as const,
  pace_per_hour: 120,
  dc_recording_id: null,
  send_delay_minutes: null as number | null,
};

function contact(id: number, firstName: string | null = "Ann", phone = "+1555000" + String(1000 + id)) {
  return {
    id,
    bot_id: campaign.bot_id,
    campaign_id: campaign.id,
    phone_number: phone,
    first_name: firstName,
    last_name: null,
    data: {},
    status: "processing" as const,
    outcome: null,
  };
}

const templates = [{ id: "tmpl-1", template_text: "Hi {first_name}, following up!" }];

beforeEach(() => {
  vi.clearAllMocks();
  cfg.botRole = "texting";
  cfg.text.timezone = "UTC";
  cfg.text.rcSmsNumber = undefined;
  cfg.text.number = "+15550000001";
  isPhoneOptedOut.mockResolvedValue(false);
  isPhoneDeclined.mockResolvedValue(false);
  isPhoneHandedOff.mockResolvedValue(false);
  getActiveOutreachTemplates.mockResolvedValue([...templates]);
  findConversationByPhone.mockResolvedValue(null);
  sendSms.mockResolvedValue({ sent: true });
  getNewestAttemptedAt.mockResolvedValue(null);
  isVelocifySyncDue.mockReturnValue(false);
  runSync.mockResolvedValue({ accepted: true });
});

describe("personalizeTemplate", () => {
  it("replaces {first_name} with the contact first name", () => {
    expect(personalizeTemplate("Hi {first_name}!", "Ann")).toBe("Hi Ann!");
  });

  it("is case-insensitive and tolerates the {firstname} variant", () => {
    expect(personalizeTemplate("Yo {First_Name} / {firstname}", "Bo")).toBe("Yo Bo / Bo");
  });

  it("falls back to 'there' when the first name is null/blank", () => {
    expect(personalizeTemplate("Hi {first_name}!", null)).toBe("Hi there!");
    expect(personalizeTemplate("Hi {first_name}!", "   ")).toBe("Hi there!");
  });
});

describe("buildFirstMessage", () => {
  it("personalizes and sends the template VERBATIM (no opt-out suffix appended)", () => {
    expect(buildFirstMessage("Hi {first_name}!", "Ann")).toBe("Hi Ann!");
  });

  it("leaves a template that already mentions STOP untouched", () => {
    const msg = buildFirstMessage("Hi {first_name}, reply STOP to end.", "Ann");
    expect(msg).toBe("Hi Ann, reply STOP to end.");
    expect(msg.match(/stop/gi)?.length).toBe(1);
  });
});

describe("pickTemplate", () => {
  it("selects uniformly by the injected rng", () => {
    const list = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(pickTemplate(list, () => 0).id).toBe("a");
    expect(pickTemplate(list, () => 0.5).id).toBe("b");
    expect(pickTemplate(list, () => 0.999).id).toBe("c");
  });
});

describe("pickChannel", () => {
  it("prefers RingCentral when rc_sms_number is set", () => {
    expect(pickChannel({ text: { rcSmsNumber: "+15550009999", number: "+15550000001" } })).toBe(
      "ringcentral"
    );
  });
  it("falls back to Twilio when only text_number is set", () => {
    expect(pickChannel({ text: { rcSmsNumber: undefined, number: "+15550000001" } })).toBe(
      "twilio"
    );
  });
  it("returns null when neither number is configured", () => {
    expect(pickChannel({ text: { rcSmsNumber: undefined, number: undefined } })).toBeNull();
    expect(pickChannel({ text: { rcSmsNumber: "  ", number: "  " } })).toBeNull();
  });
});

describe("processTextOutreachCampaign", () => {
  const ctx = { channel: "twilio" as const, templates };

  it("claims a paced batch and marks each sent/delivered_attempt", async () => {
    claimPendingContacts.mockResolvedValueOnce([contact(1), contact(2)]);
    await processTextOutreachCampaign(campaign, ctx);
    expect(claimPendingContacts).toHaveBeenCalledWith("camp-1", 2); // ceil(120/60)
    expect(sendSms).toHaveBeenCalledTimes(2);
    expect(setContactStatus).toHaveBeenCalledWith(1, "sent", "delivered_attempt");
    expect(setContactStatus).toHaveBeenCalledWith(2, "sent", "delivered_attempt");
  });

  it("sends the personalized first message VERBATIM on the conversation", async () => {
    claimPendingContacts.mockResolvedValueOnce([contact(7, "Dana", "+15551234567")]);
    await processTextOutreachCampaign(campaign, ctx);
    const arg = sendSms.mock.calls[0][0] as any;
    expect(arg.body).toBe("Hi Dana, following up!");
    expect(arg.firstBotInitiated).toBe(false);
    expect(arg.conversation.phone_number).toBe("+15551234567");
  });

  it("creates a new conversation on the chosen channel (Twilio)", async () => {
    claimPendingContacts.mockResolvedValueOnce([contact(1)]);
    await processTextOutreachCampaign(campaign, ctx);
    expect(createConversation).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "twilio", trigger: "web_lead" })
    );
  });

  it("reuses an existing conversation without recreating it (non-destructive upsert)", async () => {
    claimPendingContacts.mockResolvedValueOnce([contact(1)]);
    const existing = {
      id: "conv-existing",
      phone_number: contact(1).phone_number,
      channel: "ringcentral",
      captured_data: { first_name: "Prior" },
    };
    findConversationByPhone.mockResolvedValueOnce(existing);
    await processTextOutreachCampaign(campaign, ctx);
    expect(createConversation).not.toHaveBeenCalled();
    expect((sendSms.mock.calls[0][0] as any).conversation).toBe(existing);
  });

  it("skips opted-out numbers as skipped/opted_out without sending", async () => {
    claimPendingContacts.mockResolvedValueOnce([contact(1), contact(2)]);
    isPhoneOptedOut.mockImplementation(async (phone: string) => phone === contact(1).phone_number);
    await processTextOutreachCampaign(campaign, ctx);
    expect(setContactStatus).toHaveBeenCalledWith(1, "skipped", "opted_out");
    expect(sendSms).toHaveBeenCalledTimes(1); // only contact 2 sent
    expect(setContactStatus).toHaveBeenCalledWith(2, "sent", "delivered_attempt");
  });

  it("skips declined numbers as skipped/declined without sending", async () => {
    claimPendingContacts.mockResolvedValueOnce([contact(1), contact(2)]);
    isPhoneDeclined.mockImplementation(async (phone: string) => phone === contact(1).phone_number);
    await processTextOutreachCampaign(campaign, ctx);
    expect(setContactStatus).toHaveBeenCalledWith(1, "skipped", "declined");
    expect(sendSms).toHaveBeenCalledTimes(1); // only contact 2 sent
    expect(setContactStatus).toHaveBeenCalledWith(2, "sent", "delivered_attempt");
  });

  it("skips handed-off numbers as skipped/handed_off without sending (agent takeover)", async () => {
    claimPendingContacts.mockResolvedValueOnce([contact(1), contact(2)]);
    isPhoneHandedOff.mockImplementation(async (phone: string) => phone === contact(1).phone_number);
    await processTextOutreachCampaign(campaign, ctx);
    expect(setContactStatus).toHaveBeenCalledWith(1, "skipped", "handed_off");
    expect(sendSms).toHaveBeenCalledTimes(1); // only contact 2 sent
    expect(setContactStatus).toHaveBeenCalledWith(2, "sent", "delivered_attempt");
  });

  it("leaves a contact PENDING (never failed) when the send is not delivered", async () => {
    claimPendingContacts.mockResolvedValueOnce([contact(1)]);
    sendSms.mockResolvedValueOnce({ sent: false, reason: "no_credentials" });
    await processTextOutreachCampaign(campaign, ctx);
    expect(setContactStatus).toHaveBeenCalledWith(1, "pending");
    expect(setContactStatus).not.toHaveBeenCalledWith(1, "failed", expect.anything());
  });

  it("leaves a contact PENDING when the conversation upsert fails", async () => {
    claimPendingContacts.mockResolvedValueOnce([contact(1)]);
    findConversationByPhone.mockResolvedValueOnce(null);
    createConversation.mockResolvedValueOnce(null);
    await processTextOutreachCampaign(campaign, ctx);
    expect(sendSms).not.toHaveBeenCalled();
    expect(setContactStatus).toHaveBeenCalledWith(1, "pending");
  });

  it("isolates a throwing send and leaves that contact pending; batch continues", async () => {
    claimPendingContacts.mockResolvedValueOnce([contact(1), contact(2)]);
    sendSms.mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    await processTextOutreachCampaign(campaign, ctx);
    expect(setContactStatus).toHaveBeenCalledWith(1, "pending");
    expect(setContactStatus).toHaveBeenCalledWith(2, "sent", "delivered_attempt");
  });

  it("completes the campaign when no pending contacts remain", async () => {
    claimPendingContacts.mockResolvedValueOnce([]);
    countPendingContacts.mockResolvedValueOnce(0);
    await processTextOutreachCampaign(campaign, ctx);
    expect(completeCampaign).toHaveBeenCalledWith("camp-1");
  });

  it("does NOT complete when the batch is empty but pending still remain", async () => {
    claimPendingContacts.mockResolvedValueOnce([]);
    countPendingContacts.mockResolvedValueOnce(5);
    await processTextOutreachCampaign(campaign, ctx);
    expect(completeCampaign).not.toHaveBeenCalled();
  });
});

describe("runTextOutreachTick gates", () => {
  const noon = new Date("2026-07-21T12:00:00Z"); // inside 8am–9pm UTC

  it("processes running campaigns for the texting role in-window", async () => {
    getRunningCampaigns.mockResolvedValueOnce([campaign]);
    claimPendingContacts.mockResolvedValueOnce([contact(1)]);
    await runTextOutreachTick(noon);
    expect(getRunningCampaigns).toHaveBeenCalledWith("text_outreach");
    expect(sendSms).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the role is not texting", async () => {
    cfg.botRole = "answer_calls";
    await runTextOutreachTick(noon);
    expect(getRunningCampaigns).not.toHaveBeenCalled();
  });

  it("skips the entire tick outside quiet hours (before 8am)", async () => {
    const early = new Date("2026-07-21T05:00:00Z");
    await runTextOutreachTick(early);
    expect(getRunningCampaigns).not.toHaveBeenCalled();
  });

  it("skips (leaves pending) when no usable channel is configured", async () => {
    cfg.text.rcSmsNumber = undefined;
    cfg.text.number = undefined;
    await runTextOutreachTick(noon);
    expect(getActiveOutreachTemplates).not.toHaveBeenCalled();
    expect(getRunningCampaigns).not.toHaveBeenCalled();
    expect(claimPendingContacts).not.toHaveBeenCalled();
  });

  it("prefers RingCentral when rc_sms_number is set", async () => {
    cfg.text.rcSmsNumber = "+15550009999";
    getRunningCampaigns.mockResolvedValueOnce([campaign]);
    claimPendingContacts.mockResolvedValueOnce([contact(1)]);
    await runTextOutreachTick(noon);
    expect(createConversation).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "ringcentral" })
    );
  });

  it("skips (leaves pending) when there are no active templates", async () => {
    getActiveOutreachTemplates.mockResolvedValueOnce([]);
    await runTextOutreachTick(noon);
    expect(getRunningCampaigns).not.toHaveBeenCalled();
    expect(claimPendingContacts).not.toHaveBeenCalled();
  });
});

describe("processTextOutreachCampaign send_delay_minutes", () => {
  const ctx = { channel: "twilio" as const, templates };
  const now = new Date("2026-07-21T12:00:00Z");
  const delayed = { ...campaign, send_delay_minutes: 30 };

  it("sends nothing when the newest attempt is more recent than the delay", async () => {
    // Attempt 10 minutes ago; delay is 30 → still spacing, hold this tick.
    getNewestAttemptedAt.mockResolvedValueOnce(new Date("2026-07-21T11:50:00Z"));
    await processTextOutreachCampaign(delayed, ctx, now);
    expect(claimPendingContacts).not.toHaveBeenCalled();
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("sends EXACTLY ONE once the delay has elapsed", async () => {
    // Attempt 31 minutes ago; delay is 30 → elapsed, claim at most one.
    getNewestAttemptedAt.mockResolvedValueOnce(new Date("2026-07-21T11:29:00Z"));
    claimPendingContacts.mockResolvedValueOnce([contact(1)]);
    await processTextOutreachCampaign(delayed, ctx, now);
    expect(claimPendingContacts).toHaveBeenCalledWith("camp-1", 1);
    expect(claimPendingContacts).toHaveBeenCalledTimes(1);
    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(setContactStatus).toHaveBeenCalledWith(1, "sent", "delivered_attempt");
  });

  it("sends one immediately when there are no attempts yet", async () => {
    getNewestAttemptedAt.mockResolvedValueOnce(null);
    claimPendingContacts.mockResolvedValueOnce([contact(1)]);
    await processTextOutreachCampaign(delayed, ctx, now);
    expect(claimPendingContacts).toHaveBeenCalledWith("camp-1", 1);
    expect(sendSms).toHaveBeenCalledTimes(1);
  });

  it("caps a delayed campaign at one send even when pace_per_hour is high", async () => {
    // pace_per_hour 120 would claim 2 on the pace path; delay caps it at 1.
    getNewestAttemptedAt.mockResolvedValueOnce(null);
    claimPendingContacts.mockResolvedValueOnce([contact(1)]);
    await processTextOutreachCampaign({ ...delayed, pace_per_hour: 120 }, ctx, now);
    expect(claimPendingContacts).toHaveBeenCalledWith("camp-1", 1);
  });

  it("treats a 'skipped' (opt-out) attempt as the newest attempt for spacing", async () => {
    // The opted-out contact's skip is the newest attempt 5 min ago → still spacing.
    getNewestAttemptedAt.mockResolvedValueOnce(new Date("2026-07-21T11:55:00Z"));
    await processTextOutreachCampaign(delayed, ctx, now);
    expect(getNewestAttemptedAt).toHaveBeenCalledWith("camp-1");
    expect(claimPendingContacts).not.toHaveBeenCalled();
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("completes the delayed campaign when the delay elapsed but no pending remain", async () => {
    getNewestAttemptedAt.mockResolvedValueOnce(new Date("2026-07-21T11:00:00Z"));
    claimPendingContacts.mockResolvedValueOnce([]);
    countPendingContacts.mockResolvedValueOnce(0);
    await processTextOutreachCampaign(delayed, ctx, now);
    expect(completeCampaign).toHaveBeenCalledWith("camp-1");
  });

  it("null delay leaves the pace path untouched (no spacing query, full batch)", async () => {
    claimPendingContacts.mockResolvedValueOnce([contact(1), contact(2)]);
    await processTextOutreachCampaign(campaign, ctx, now);
    expect(getNewestAttemptedAt).not.toHaveBeenCalled();
    expect(claimPendingContacts).toHaveBeenCalledWith("camp-1", 2); // ceil(120/60)
    expect(sendSms).toHaveBeenCalledTimes(2);
  });
});

describe("runTextOutreachTick Velocify sync piggyback", () => {
  const noon = new Date("2026-07-21T12:00:00Z");

  it("runs the sync BEFORE campaign processing when it is due", async () => {
    isVelocifySyncDue.mockReturnValue(true);
    getRunningCampaigns.mockResolvedValueOnce([]);
    await runTextOutreachTick(noon);
    expect(runSync).toHaveBeenCalledWith(noon);
    // Campaign processing still proceeds after the sync.
    expect(getRunningCampaigns).toHaveBeenCalledWith("text_outreach");
  });

  it("does NOT run the sync when it is not due", async () => {
    isVelocifySyncDue.mockReturnValue(false);
    getRunningCampaigns.mockResolvedValueOnce([]);
    await runTextOutreachTick(noon);
    expect(runSync).not.toHaveBeenCalled();
    expect(getRunningCampaigns).toHaveBeenCalled();
  });

  it("a sync failure does not block normal campaign processing", async () => {
    isVelocifySyncDue.mockReturnValue(true);
    runSync.mockRejectedValueOnce(new Error("sync boom"));
    getRunningCampaigns.mockResolvedValueOnce([campaign]);
    claimPendingContacts.mockResolvedValueOnce([contact(1)]);
    await runTextOutreachTick(noon);
    // Despite the sync throwing, the tick continued and sent the campaign batch.
    expect(sendSms).toHaveBeenCalledTimes(1);
  });
});
