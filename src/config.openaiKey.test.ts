import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * OpenAI API-key resolution order (config.ts openai.apiKey):
 *   env OPENAI_API_KEY (primary bot only) → api_credentials provider "openai"
 *   (key "api_key", dashboard-written) → provider "openai-tts" (legacy fallback).
 *
 * Mocks ./db/remoteConfig with a mutable credentials store so we can drive the
 * getCredential("openai") ?? getCredential("openai-tts") resolution. BOT_ID is the
 * primary tenant (matches vitest.config env), so credentialFirst allows env fallback.
 */

const creds: Record<string, Record<string, string>> = {};

vi.mock("./db/remoteConfig", () => ({
  BOT_ID: "00000000-0000-0000-0000-000000000001",
  getRemoteConfig: () => ({ bot: null, botConfig: null, credentials: creds }),
  getCredential: (provider: string, key: string): string | undefined => {
    const value = creds[provider]?.[key];
    return typeof value === "string" ? value : undefined;
  },
}));

import { resolveEffectiveConfig } from "./config";

describe("resolveEffectiveConfig openai.apiKey resolution order", () => {
  const originalEnv = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    for (const key of Object.keys(creds)) delete creds[key];
    delete process.env.OPENAI_API_KEY;
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalEnv;
  });

  it('prefers provider "openai" over legacy "openai-tts" when both are present', async () => {
    creds.openai = { api_key: "sk-dashboard" };
    creds["openai-tts"] = { api_key: "sk-legacy" };
    const eff = await resolveEffectiveConfig();
    expect(eff.openai.apiKey).toBe("sk-dashboard");
  });

  it('falls back to legacy provider "openai-tts" when only it exists', async () => {
    creds["openai-tts"] = { api_key: "sk-legacy" };
    const eff = await resolveEffectiveConfig();
    expect(eff.openai.apiKey).toBe("sk-legacy");
  });

  it("keeps env-first behavior for the primary bot (OPENAI_API_KEY wins over both)", async () => {
    process.env.OPENAI_API_KEY = "sk-env";
    creds.openai = { api_key: "sk-dashboard" };
    creds["openai-tts"] = { api_key: "sk-legacy" };
    const eff = await resolveEffectiveConfig();
    expect(eff.openai.apiKey).toBe("sk-env");
  });

  it("is undefined when neither provider nor env supplies a key", async () => {
    const eff = await resolveEffectiveConfig();
    expect(eff.openai.apiKey).toBeUndefined();
  });
});
