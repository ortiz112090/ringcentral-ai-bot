import { describe, it, expect, beforeEach, afterEach } from "vitest";

// resolveEffectiveConfig lazily require()s ./db/remoteConfig. Importing it here
// registers it in vitest's module graph so that require resolves. No mock needed:
// the real cache starts empty (botConfig null) and BOT_ID from vitest.config.ts is
// the primary tenant, so the plain env-first fallback applies.
import "./db/remoteConfig";
import { resolveEffectiveConfig, resolveRealtimeSpeed } from "./config";

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
