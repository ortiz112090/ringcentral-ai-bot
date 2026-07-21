import { describe, it, expect, vi, beforeEach } from "vitest";

// Deterministic tenant config + Twilio client + logger. resolveEffectiveConfig
// returns just the slices provisioning reads (text.number); twilioSmsWebhookUrl
// yields the fixed public URL.
const effectiveText: { number: string | undefined } = { number: "+15550001111" };
const smsWebhookUrl = { value: "https://bot.example.com/webhooks/twilio/sms" };
vi.mock("../config", () => ({
  resolveEffectiveConfig: vi.fn(async () => ({ text: effectiveText })),
  twilioSmsWebhookUrl: vi.fn(() => smsWebhookUrl.value),
  // Unused by provisionTextNumber but imported at module load.
  twilioVoiceWebhookUrl: vi.fn(() => "https://bot.example.com/webhooks/twilio/voice"),
  twilioStatusCallbackUrl: vi.fn(() => "https://bot.example.com/webhooks/twilio/status"),
}));

const numbersUpdate = vi.fn(async () => ({}));
const numbersList = vi.fn(async () => [] as Array<{ sid: string; phoneNumber: string }>);
// incomingPhoneNumbers is both callable (sid) and has .list — mirror the real SDK.
const incomingPhoneNumbers: any = (_sid: string) => ({ update: (...a: any[]) => numbersUpdate(...a) });
incomingPhoneNumbers.list = (...a: any[]) => numbersList(...a);
const twilioClient: any = { incomingPhoneNumbers };
const getClient = { value: twilioClient as any };
vi.mock("./client", () => ({
  getTwilioClient: vi.fn(async () => getClient.value),
}));

vi.mock("../db/remoteConfig", () => ({ BOT_ID: "bot-test" }));

const warnSpy = vi.fn();
const errorSpy = vi.fn();
const infoSpy = vi.fn();
vi.mock("../logger", () => ({
  logger: {
    warn: (...a: any[]) => warnSpy(...a),
    error: (...a: any[]) => errorSpy(...a),
    info: (...a: any[]) => infoSpy(...a),
    debug: () => {},
  },
}));

import { provisionTextNumber } from "./provisioning";

beforeEach(() => {
  vi.clearAllMocks();
  effectiveText.number = "+15550001111";
  smsWebhookUrl.value = "https://bot.example.com/webhooks/twilio/sms";
  getClient.value = twilioClient;
  numbersList.mockResolvedValue([]);
});

describe("provisionTextNumber", () => {
  it("skips with a warn (not an error) when text_number is unset — texting is opt-in", async () => {
    effectiveText.number = undefined;
    await expect(provisionTextNumber()).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("no text_number assigned"),
      expect.objectContaining({ botId: "bot-test" })
    );
    expect(errorSpy).not.toHaveBeenCalled();
    expect(numbersList).not.toHaveBeenCalled();
    expect(numbersUpdate).not.toHaveBeenCalled();
  });

  it("skips with a warn when text_number is blank/whitespace", async () => {
    effectiveText.number = "   ";
    await provisionTextNumber();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("no text_number assigned"),
      expect.anything()
    );
    expect(numbersUpdate).not.toHaveBeenCalled();
  });

  it("warns and skips when PUBLIC_BASE_URL is unset (no webhook URL)", async () => {
    smsWebhookUrl.value = "";
    await provisionTextNumber();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("PUBLIC_BASE_URL unset"));
    expect(numbersList).not.toHaveBeenCalled();
    expect(numbersUpdate).not.toHaveBeenCalled();
  });

  it("errors (not fatal) and skips when the tenant has no Twilio credentials", async () => {
    getClient.value = null;
    await expect(provisionTextNumber()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("no Twilio REST credentials"),
      expect.objectContaining({ botId: "bot-test" })
    );
    expect(numbersUpdate).not.toHaveBeenCalled();
  });

  it("updates SmsUrl (POST) on the exactly-matching number when found", async () => {
    numbersList.mockResolvedValue([{ sid: "PN123", phoneNumber: "+15550001111" }]);
    await provisionTextNumber();
    expect(numbersList).toHaveBeenCalledWith({ phoneNumber: "+15550001111", limit: 20 });
    expect(numbersUpdate).toHaveBeenCalledWith({
      smsUrl: "https://bot.example.com/webhooks/twilio/sms",
      smsMethod: "POST",
    });
    expect(errorSpy).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("SMS number provisioned"),
      expect.objectContaining({ number: "+15550001111" })
    );
  });

  it("never touches a different number (no exact phoneNumber match)", async () => {
    numbersList.mockResolvedValue([{ sid: "PNother", phoneNumber: "+19998887777" }]);
    await provisionTextNumber();
    expect(numbersUpdate).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("SMS number not found"),
      expect.objectContaining({ botId: "bot-test", number: "+15550001111" })
    );
  });

  it("errors (not fatal) when the number is not in the account", async () => {
    numbersList.mockResolvedValue([]);
    await provisionTextNumber();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("not creating it"),
      expect.objectContaining({ number: "+15550001111" })
    );
    expect(numbersUpdate).not.toHaveBeenCalled();
  });

  it("never throws when the Twilio API rejects", async () => {
    numbersList.mockRejectedValue(new Error("Twilio 500"));
    await expect(provisionTextNumber()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("provisioning failed"),
      expect.objectContaining({ error: "Twilio 500" })
    );
  });
});
