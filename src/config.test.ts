import { describe, it, expect, beforeEach, afterEach } from "vitest";

// resolveEffectiveConfig lazily require()s ./db/remoteConfig. Importing it here
// registers it in vitest's module graph so that require resolves. No mock needed:
// the real cache starts empty (botConfig null) and BOT_ID from vitest.config.ts is
// the primary tenant, so the plain env-first fallback applies.
import "./db/remoteConfig";
import { resolveEffectiveConfig } from "./config";

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
