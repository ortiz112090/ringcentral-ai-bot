import { describe, it, expect, vi, beforeEach } from "vitest";

// Exercises the channel-agnostic bits of handleInboundSms: RC dedupe on
// provider_message_id, and that a fresh RC conversation is created on the
// 'ringcentral' channel with the provider id recorded on the inbound message.
const text: any = {
  enabled: true,
  number: "+15550001111",
  rcSmsNumber: "+15550002222",
  model: "gpt-4o-mini",
  businessName: "Acme",
  timezone: "UTC",
};
const business = { agentName: "Alex", brokerageName: "Acme" };
const twilio: any = { escalationNumber: "+15559990000" };
vi.mock("../config", () => ({
  resolveEffectiveConfig: vi.fn(async () => ({ text, business, twilio })),
}));

const hasProviderMessage = vi.fn(async () => false);
const isPhoneOptedOut = vi.fn(async () => false);
const createConversation = vi.fn(async () => ({
  id: "conv-rc",
  phone_number: "+15557778888",
  status: "active",
  channel: "ringcentral",
}));
const findConversationByPhone = vi.fn(async () => null);
const insertTextMessage = vi.fn(async () => {});
const updateConversationStatus = vi.fn(async () => {});
const getConversationMessages = vi.fn(async () => []);
const getTextStages = vi.fn(async () => []);
vi.mock("./smsQueries", () => ({
  hasProviderMessage: (...a: any[]) => hasProviderMessage(...a),
  isPhoneOptedOut: (...a: any[]) => isPhoneOptedOut(...a),
  createConversation: (...a: any[]) => createConversation(...a),
  findConversationByPhone: (...a: any[]) => findConversationByPhone(...a),
  insertTextMessage: (...a: any[]) => insertTextMessage(...a),
  updateConversationStatus: (...a: any[]) => updateConversationStatus(...a),
  getConversationMessages: (...a: any[]) => getConversationMessages(...a),
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

import { handleInboundSms } from "./smsService";

beforeEach(() => {
  vi.clearAllMocks();
  hasProviderMessage.mockResolvedValue(false);
  isPhoneOptedOut.mockResolvedValue(false);
  findConversationByPhone.mockResolvedValue(null as any);
});

describe("handleInboundSms — RingCentral channel", () => {
  it("creates the conversation on the ringcentral channel and records the provider id", async () => {
    await handleInboundSms({
      from: "+15557778888",
      body: "hi",
      channel: "ringcentral",
      providerMessageId: "rc-1",
    });
    expect(createConversation).toHaveBeenCalledWith(
      expect.objectContaining({ phone_number: "+15557778888", trigger: "inbound", channel: "ringcentral" })
    );
    expect(insertTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ direction: "inbound", body: "hi", providerMessageId: "rc-1" })
    );
    expect(runSmsTurn).toHaveBeenCalled();
    expect(sendSms).toHaveBeenCalled();
  });

  it("skips entirely when the provider id was already stored (durable dedupe)", async () => {
    hasProviderMessage.mockResolvedValueOnce(true);
    await handleInboundSms({
      from: "+15557778888",
      body: "hi",
      channel: "ringcentral",
      providerMessageId: "rc-dup",
    });
    expect(createConversation).not.toHaveBeenCalled();
    expect(insertTextMessage).not.toHaveBeenCalled();
    expect(runSmsTurn).not.toHaveBeenCalled();
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("defaults to the twilio channel when none is supplied (unchanged Twilio path)", async () => {
    await handleInboundSms({ from: "+15557778888", body: "hi" });
    expect(hasProviderMessage).not.toHaveBeenCalled();
    expect(createConversation).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: "inbound", channel: "twilio" })
    );
    expect(insertTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ direction: "inbound", body: "hi", providerMessageId: null })
    );
  });

  it("STOP on the RC channel opts out and records the inbound with channel + provider id", async () => {
    await handleInboundSms({
      from: "+15557778888",
      body: "STOP",
      channel: "ringcentral",
      providerMessageId: "rc-stop",
    });
    expect(createConversation).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "ringcentral" })
    );
    expect(updateConversationStatus).toHaveBeenCalledWith("conv-rc", "opted_out");
    expect(sendSms).not.toHaveBeenCalled();
  });
});
