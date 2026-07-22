import { describe, it, expect, vi, beforeEach } from "vitest";

// Tenant config exposes only the slice sendRcSms reads (text.rcSmsNumber,
// text.rcSmsExtensionId).
const effectiveText: {
  rcSmsNumber: string | undefined;
  rcSmsExtensionId: string | undefined;
} = { rcSmsNumber: "+15550002222", rcSmsExtensionId: undefined };
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
  effectiveText.rcSmsExtensionId = undefined;
});

describe("sendRcSms", () => {
  it("POSTs to the authenticated-extension SMS endpoint (~) when no rc_sms_extension_id is set", async () => {
    const res = await sendRcSms({ to: "+15557778888", text: "hello there" });
    expect(res).toEqual({ sent: true });
    expect(rcPost).toHaveBeenCalledWith("/restapi/v1.0/account/~/extension/~/sms", {
      from: { phoneNumber: "+15550002222" },
      to: [{ phoneNumber: "+15557778888" }],
      text: "hello there",
    });
  });

  it("sends AS the chosen extension when rc_sms_extension_id is set (from stays rc_sms_number)", async () => {
    effectiveText.rcSmsExtensionId = "4056789012";
    const res = await sendRcSms({ to: "+15557778888", text: "hi there" });
    expect(res).toEqual({ sent: true });
    expect(rcPost).toHaveBeenCalledWith(
      "/restapi/v1.0/account/~/extension/4056789012/sms",
      {
        from: { phoneNumber: "+15550002222" },
        to: [{ phoneNumber: "+15557778888" }],
        text: "hi there",
      }
    );
  });

  it("trims a padded rc_sms_extension_id in the endpoint path", async () => {
    effectiveText.rcSmsExtensionId = "  4056789012  ";
    await sendRcSms({ to: "+15557778888", text: "hi" });
    expect(rcPost).toHaveBeenCalledWith(
      "/restapi/v1.0/account/~/extension/4056789012/sms",
      expect.any(Object)
    );
  });

  it("logs the account-level-permission hint on a CMN-408 error when sending as another extension", async () => {
    effectiveText.rcSmsExtensionId = "4056789012";
    rcPost.mockRejectedValueOnce(new Error("CMN-408 In order to call this API endpoint, application needs..."));
    const res = await sendRcSms({ to: "+15557778888", text: "hi" });
    expect(res).toEqual({ sent: false, reason: "error" });
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
