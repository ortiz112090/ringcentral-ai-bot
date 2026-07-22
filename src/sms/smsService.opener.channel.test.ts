import { describe, it, expect, vi, beforeEach } from "vitest";

// Verifies the bot-initiated opener path (sendOpener via its exported wrappers)
// picks the outbound channel from effective config: 'ringcentral' when an
// rc_sms_number is configured (preferred even if a Twilio number also exists),
// else 'twilio'. Only createConversation's channel arg is asserted.
const text: any = {
  enabled: true,
  number: undefined,
  rcSmsNumber: undefined,
  model: "gpt-4o-mini",
  businessName: "Acme",
  timezone: "UTC",
  missedCallEnabled: true,
  webLeadEnabled: true,
};
const business = { agentName: "Alex", brokerageName: "Acme" };
const twilio: any = { escalationNumber: "+15559990000" };
vi.mock("../config", () => ({
  resolveEffectiveConfig: vi.fn(async () => ({ text, business, twilio })),
}));

const isPhoneOptedOut = vi.fn(async () => false);
const createConversation = vi.fn(async () => ({
  id: "conv-1",
  phone_number: "+15557778888",
  status: "active",
  channel: "twilio",
}));
const getTextStages = vi.fn(async () => []);
vi.mock("./smsQueries", () => ({
  isPhoneOptedOut: (...a: any[]) => isPhoneOptedOut(...a),
  createConversation: (...a: any[]) => createConversation(...a),
  getTextStages: (...a: any[]) => getTextStages(...a),
}));

const sendSms = vi.fn(async () => ({ sent: true }));
vi.mock("./smsSend", () => ({ sendSms: (...a: any[]) => sendSms(...a) }));

const runSmsTurn = vi.fn(async () => ({ reply: "Hi!", escalate: false, optedOut: false, declined: false, captured: {} }));
vi.mock("./smsEngine", () => ({ runSmsTurn: (...a: any[]) => runSmsTurn(...a) }));

const findLeadByPhone = vi.fn(async () => null);
const getLeadFields = vi.fn(async () => []);
vi.mock("../db/queries", () => ({
  findLeadByPhone: (...a: any[]) => findLeadByPhone(...a),
  getLeadFields: (...a: any[]) => getLeadFields(...a),
}));

vi.mock("../twilio/client", () => ({
  getTwilioClient: vi.fn(async () => ({ messages: { create: vi.fn(async () => ({})) } })),
}));

import { sendWebLeadText, sendMissedCallText } from "./smsService";

// 10am UTC — safely within the 8am–9pm texting window used by sendOpener.
const now = new Date("2026-07-22T10:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  isPhoneOptedOut.mockResolvedValue(false);
  text.enabled = true;
  text.number = undefined;
  text.rcSmsNumber = undefined;
});

describe("sendOpener — outbound channel choice", () => {
  it("uses the ringcentral channel when only an rc_sms_number is configured", async () => {
    text.rcSmsNumber = "+15550002222";
    text.number = undefined;
    await sendWebLeadText({ phone: "+15557778888", now });
    expect(createConversation).toHaveBeenCalledWith(
      expect.objectContaining({ phone_number: "+15557778888", trigger: "web_lead", channel: "ringcentral" })
    );
  });

  it("uses the twilio channel when only a twilio number is configured", async () => {
    text.rcSmsNumber = undefined;
    text.number = "+15550001111";
    await sendWebLeadText({ phone: "+15557778888", now });
    expect(createConversation).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: "web_lead", channel: "twilio" })
    );
  });

  it("prefers ringcentral when both rc_sms_number and a twilio number are set", async () => {
    text.rcSmsNumber = "+15550002222";
    text.number = "+15550001111";
    await sendMissedCallText({ phone: "+15557778888", now });
    expect(createConversation).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: "missed_call", channel: "ringcentral" })
    );
  });
});
