import { describe, it, expect, vi, beforeEach } from "vitest";

// Reply-channel selection: a 'twilio' conversation must go out the Twilio sender,
// a 'ringcentral' conversation out the RC sender (sendRcSms).
const effectiveText = { number: "+15550001111", rcSmsNumber: "+15550002222" };
vi.mock("../config", () => ({
  resolveEffectiveConfig: vi.fn(async () => ({ text: effectiveText })),
}));
const messagesCreate = vi.fn(async () => ({ sid: "SM1" }));
vi.mock("../twilio/client", () => ({
  getTwilioClient: vi.fn(async () => ({ messages: { create: (...a: any[]) => messagesCreate(...a) } })),
}));
const sendRcSms = vi.fn(async () => ({ sent: true }));
vi.mock("./rcSms", () => ({
  sendRcSms: (...a: any[]) => sendRcSms(...a),
}));
const isPhoneOptedOut = vi.fn(async () => false);
const isPhoneHandedOff = vi.fn(async () => false);
const insertTextMessage = vi.fn(async () => {});
vi.mock("./smsQueries", () => ({
  isPhoneOptedOut: (...a: any[]) => isPhoneOptedOut(...a),
  isPhoneHandedOff: (...a: any[]) => isPhoneHandedOff(...a),
  insertTextMessage: (...a: any[]) => insertTextMessage(...a),
}));

import { sendSms } from "./smsSend";

const twilioConvo: any = { id: "c-tw", phone_number: "+15557778888", channel: "twilio" };
const rcConvo: any = { id: "c-rc", phone_number: "+15557778888", channel: "ringcentral" };

beforeEach(() => {
  vi.clearAllMocks();
  isPhoneOptedOut.mockResolvedValue(false);
  isPhoneHandedOff.mockResolvedValue(false);
  sendRcSms.mockResolvedValue({ sent: true });
});

describe("sendSms reply-channel selection", () => {
  it("twilio conversation → Twilio sender, never the RC sender", async () => {
    const res = await sendSms({ conversation: twilioConvo, body: "hi tw" });
    expect(res).toEqual({ sent: true });
    expect(messagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ from: "+15550001111", to: "+15557778888", body: "hi tw" })
    );
    expect(sendRcSms).not.toHaveBeenCalled();
    expect(insertTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "c-tw", direction: "outbound", body: "hi tw" })
    );
  });

  it("ringcentral conversation → RC sender, never Twilio", async () => {
    const res = await sendSms({ conversation: rcConvo, body: "hi rc" });
    expect(res).toEqual({ sent: true });
    expect(sendRcSms).toHaveBeenCalledWith({ to: "+15557778888", text: "hi rc" });
    expect(messagesCreate).not.toHaveBeenCalled();
    expect(insertTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "c-rc", direction: "outbound", body: "hi rc" })
    );
  });

  it("never records the outbound message when the RC send fails", async () => {
    sendRcSms.mockResolvedValueOnce({ sent: false, reason: "error" });
    const res = await sendSms({ conversation: rcConvo, body: "hi rc" });
    expect(res).toEqual({ sent: false, reason: "error" });
    expect(insertTextMessage).not.toHaveBeenCalled();
  });

  it("opt-out is enforced regardless of channel (RC)", async () => {
    isPhoneOptedOut.mockResolvedValueOnce(true);
    const res = await sendSms({ conversation: rcConvo, body: "hi rc" });
    expect(res).toEqual({ sent: false, reason: "opted_out" });
    expect(sendRcSms).not.toHaveBeenCalled();
    expect(insertTextMessage).not.toHaveBeenCalled();
  });
});
