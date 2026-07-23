import { describe, it, expect, vi, beforeEach } from "vitest";

// Deterministic tenant config + Twilio client + opt-out state.
const effectiveText = { number: "+15550001111", businessName: "Acme" };
vi.mock("../config", () => ({
  resolveEffectiveConfig: vi.fn(async () => ({ text: effectiveText })),
}));
const messagesCreate = vi.fn(async () => ({ sid: "SM1" }));
vi.mock("../twilio/client", () => ({
  getTwilioClient: vi.fn(async () => ({ messages: { create: (...a: any[]) => messagesCreate(...a) } })),
}));
// Mock the RC sender so this Twilio-path test never loads the RingCentral client
// chain (which would pull remoteConfig → supabase → config). These cases only
// exercise the Twilio channel (conversation.channel is undefined/'twilio').
vi.mock("./rcSms", () => ({ sendRcSms: vi.fn(async () => ({ sent: true })) }));
const isPhoneOptedOut = vi.fn(async () => false);
const isPhoneHandedOff = vi.fn(async () => false);
const insertTextMessage = vi.fn(async () => {});
vi.mock("./smsQueries", () => ({
  isPhoneOptedOut: (...a: any[]) => isPhoneOptedOut(...a),
  isPhoneHandedOff: (...a: any[]) => isPhoneHandedOff(...a),
  insertTextMessage: (...a: any[]) => insertTextMessage(...a),
}));

import { sendSms } from "./smsSend";

const convo: any = { id: "conv-1", phone_number: "+15557778888", status: "active" };

beforeEach(() => {
  vi.clearAllMocks();
  isPhoneOptedOut.mockResolvedValue(false);
  isPhoneHandedOff.mockResolvedValue(false);
});

describe("sendSms opt-out enforcement", () => {
  it("NEVER sends to an opted-out number", async () => {
    isPhoneOptedOut.mockResolvedValueOnce(true);
    const res = await sendSms({ conversation: convo, body: "hello" });
    expect(res).toEqual({ sent: false, reason: "opted_out" });
    expect(messagesCreate).not.toHaveBeenCalled();
    expect(insertTextMessage).not.toHaveBeenCalled();
  });

  it("NEVER sends to a handed-off number (agent takeover)", async () => {
    isPhoneHandedOff.mockResolvedValueOnce(true);
    const res = await sendSms({ conversation: convo, body: "hello" });
    expect(res).toEqual({ sent: false, reason: "handed_off" });
    expect(messagesCreate).not.toHaveBeenCalled();
    expect(insertTextMessage).not.toHaveBeenCalled();
  });

  it("sends from the tenant text number and records the outbound message", async () => {
    const res = await sendSms({ conversation: convo, body: "hi there" });
    expect(res.sent).toBe(true);
    expect(messagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ from: "+15550001111", to: "+15557778888", body: "hi there" })
    );
    expect(insertTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "conv-1", direction: "outbound", body: "hi there" })
    );
  });

  it("sends the FIRST bot-initiated message VERBATIM (no opt-out suffix appended)", async () => {
    await sendSms({ conversation: convo, body: "Hi, this is Acme.", firstBotInitiated: true });
    const sentBody = messagesCreate.mock.calls[0][0].body as string;
    expect(sentBody).toBe("Hi, this is Acme.");
  });

  it("sends replies to inbound VERBATIM as well", async () => {
    await sendSms({ conversation: convo, body: "Sure, what's your ZIP?" });
    const sentBody = messagesCreate.mock.calls[0][0].body as string;
    expect(sentBody).toBe("Sure, what's your ZIP?");
  });
});
