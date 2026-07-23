import { describe, it, expect, beforeEach, afterEach } from "vitest";

// resolveEffectiveConfig lazily require()s ./db/remoteConfig. Importing it here
// registers it in vitest's module graph so that require resolves. No mock needed:
// the real cache starts empty (botConfig null) and BOT_ID from vitest.config.ts is
// the primary tenant, so the plain env-first fallback applies.
import "./db/remoteConfig";
import { config, resolveEffectiveConfig, resolveRealtimeSpeed, ringcentralSmsWebhookUrl } from "./config";

describe("resolveRealtimeSpeed clamp + default", () => {
  it("passes an in-range value through unchanged", () => {
    expect(resolveRealtimeSpeed(1.15)).toBe(1.15);
    expect(resolveRealtimeSpeed("1.15")).toBe(1.15);
  });

  it("clamps above the max down to 1.5", () => {
    expect(resolveRealtimeSpeed(2.0)).toBe(1.5);
  });

  it("clamps below the min up to 0.25", () => {
    expect(resolveRealtimeSpeed(0.1)).toBe(0.25);
  });

  it("defaults non-numeric / null / undefined to 1.0", () => {
    expect(resolveRealtimeSpeed("fast")).toBe(1.0);
    expect(resolveRealtimeSpeed(null)).toBe(1.0);
    expect(resolveRealtimeSpeed(undefined)).toBe(1.0);
  });
});

describe("resolveEffectiveConfig realtimeSpeed", () => {
  const original = process.env.OPENAI_REALTIME_SPEED;
  beforeEach(() => {
    delete process.env.OPENAI_REALTIME_SPEED;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.OPENAI_REALTIME_SPEED;
    else process.env.OPENAI_REALTIME_SPEED = original;
  });

  it("defaults to 1.0 when no env override and no bot_config value", async () => {
    const eff = await resolveEffectiveConfig();
    expect(eff.realtimeSpeed).toBe(1.0);
  });

  it("respects OPENAI_REALTIME_SPEED env override, clamped", async () => {
    process.env.OPENAI_REALTIME_SPEED = "1.25";
    expect((await resolveEffectiveConfig()).realtimeSpeed).toBe(1.25);
    process.env.OPENAI_REALTIME_SPEED = "9";
    expect((await resolveEffectiveConfig()).realtimeSpeed).toBe(1.5);
  });
});

describe("resolveEffectiveConfig botRole", () => {
  const original = process.env.BOT_ROLE;
  beforeEach(() => {
    delete process.env.BOT_ROLE;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.BOT_ROLE;
    else process.env.BOT_ROLE = original;
  });

  it("defaults to answer_calls with no env override or bot_config value", async () => {
    expect((await resolveEffectiveConfig()).botRole).toBe("answer_calls");
  });

  it("respects the BOT_ROLE env override (normalized)", async () => {
    process.env.BOT_ROLE = "  Texting ";
    expect((await resolveEffectiveConfig()).botRole).toBe("texting");
  });

  it("falls back to the default on an unknown BOT_ROLE", async () => {
    process.env.BOT_ROLE = "banana";
    expect((await resolveEffectiveConfig()).botRole).toBe("answer_calls");
  });
});

describe("resolveEffectiveConfig transcribeModel", () => {
  const original = process.env.OPENAI_TRANSCRIBE_MODEL;

  beforeEach(() => {
    delete process.env.OPENAI_TRANSCRIBE_MODEL;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.OPENAI_TRANSCRIBE_MODEL;
    else process.env.OPENAI_TRANSCRIBE_MODEL = original;
  });

  it("defaults to gpt-4o-transcribe when no env override is set", async () => {
    const eff = await resolveEffectiveConfig();
    expect(eff.openai.transcribeModel).toBe("gpt-4o-transcribe");
  });

  it("respects the OPENAI_TRANSCRIBE_MODEL env override", async () => {
    process.env.OPENAI_TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";
    const eff = await resolveEffectiveConfig();
    expect(eff.openai.transcribeModel).toBe("gpt-4o-mini-transcribe");
  });
});

describe("resolveEffectiveConfig rcSmsExtensionId", () => {
  const original = process.env.RC_SMS_EXTENSION_ID;

  beforeEach(() => {
    delete process.env.RC_SMS_EXTENSION_ID;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.RC_SMS_EXTENSION_ID;
    else process.env.RC_SMS_EXTENSION_ID = original;
  });

  it("is undefined when no env override and no bot_config value (authenticated extension)", async () => {
    const eff = await resolveEffectiveConfig();
    expect(eff.text.rcSmsExtensionId).toBeUndefined();
  });

  it("respects the RC_SMS_EXTENSION_ID env override", async () => {
    process.env.RC_SMS_EXTENSION_ID = "4056789012";
    const eff = await resolveEffectiveConfig();
    expect(eff.text.rcSmsExtensionId).toBe("4056789012");
  });
});

describe("ringcentralSmsWebhookUrl — secret rides in the ?token= query param", () => {
  const original = config.rcSmsWebhookToken;
  afterEach(() => {
    config.rcSmsWebhookToken = original;
  });

  it("appends the url-encoded token as a query param (PUBLIC_BASE_URL is set in test env)", () => {
    config.rcSmsWebhookToken = "s3cr et/&";
    expect(ringcentralSmsWebhookUrl()).toBe(
      `https://bot.example.com/webhooks/ringcentral/sms?token=${encodeURIComponent("s3cr et/&")}`
    );
  });

  it("returns the bare URL (no query) when the token is unset", () => {
    config.rcSmsWebhookToken = "";
    expect(ringcentralSmsWebhookUrl()).toBe("https://bot.example.com/webhooks/ringcentral/sms");
  });
});
