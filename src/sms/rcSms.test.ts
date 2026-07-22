import { describe, it, expect, vi, beforeEach } from "vitest";

// Tenant config exposes only the slice sendRcSms reads (text.rcSmsNumber).
const effectiveText: { rcSmsNumber: string | undefined } = { rcSmsNumber: "+15550002222" };
vi.mock("../config", () => ({
  resolveEffectiveConfig: vi.fn(async () => ({ text: effectiveText })),
}));

const rcPost = vi.fn(async () => ({}));
vi.mock("../ringcentral/client", () => ({
  rcPost: (...a: any[]) => rcPost(...a),
}));

vi.mock("../db/remoteConfig", () => ({ BOT_ID: "bot-test" }));

import { sendRcSms } from "./rcSms";

beforeEach(() => {
  vi.clearAllMocks();
  effectiveText.rcSmsNumber = "+15550002222";
});

describe("sendRcSms", () => {
  it("POSTs to the RC extension SMS endpoint with the tenant rc_sms_number as from", async () => {
    const res = await sendRcSms({ to: "+15557778888", text: "hello there" });
    expect(res).toEqual({ sent: true });
    expect(rcPost).toHaveBeenCalledWith("/restapi/v1.0/account/~/extension/~/sms", {
      from: { phoneNumber: "+15550002222" },
      to: [{ phoneNumber: "+15557778888" }],
      text: "hello there",
    });
  });

  it("skips (no_number) when rc_sms_number is unset — never calls RC", async () => {
    effectiveText.rcSmsNumber = undefined;
    const res = await sendRcSms({ to: "+15557778888", text: "hi" });
    expect(res).toEqual({ sent: false, reason: "no_number" });
    expect(rcPost).not.toHaveBeenCalled();
  });

  it("skips (no_number) when rc_sms_number is blank/whitespace", async () => {
    effectiveText.rcSmsNumber = "   ";
    const res = await sendRcSms({ to: "+15557778888", text: "hi" });
    expect(res).toEqual({ sent: false, reason: "no_number" });
    expect(rcPost).not.toHaveBeenCalled();
  });

  it("never throws when the RC API rejects — returns { sent:false, reason:'error' }", async () => {
    rcPost.mockRejectedValueOnce(new Error("RC 500"));
    const res = await sendRcSms({ to: "+15557778888", text: "hi" });
    expect(res).toEqual({ sent: false, reason: "error" });
  });
});
