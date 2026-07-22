import { describe, it, expect, vi } from "vitest";

// client.ts builds the SDK lazily, so importing it has no side effects, but it
// pulls in config/logger/remoteConfig — stub them so this stays a focused unit
// test of the pure error-body extractor.
vi.mock("../config", () => ({ resolveEffectiveConfig: vi.fn() }));
vi.mock("../db/remoteConfig", () => ({ BOT_ID: "bot-test", getCredential: vi.fn() }));
vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { extractRcErrorDetail } from "./client";

describe("extractRcErrorDetail", () => {
  it("returns the parsed RC error body (errorCode + errors[])", async () => {
    const body = {
      errorCode: "CMN-101",
      message: "Parameter [deliveryMode.verificationToken] value is invalid",
      errors: [{ parameterName: "deliveryMode.verificationToken" }],
    };
    const err = { response: { json: async () => body } };
    await expect(extractRcErrorDetail(err)).resolves.toEqual(body);
  });

  it("reads a clone() so the original response stream is left for other callers", async () => {
    const body = { errorCode: "SUB-406" };
    const originalJson = vi.fn(async () => body);
    const cloneJson = vi.fn(async () => body);
    const err = {
      response: {
        json: originalJson,
        clone: () => ({ json: cloneJson }),
      },
    };

    await expect(extractRcErrorDetail(err)).resolves.toEqual(body);
    // The clone's body was consumed, not the original's.
    expect(cloneJson).toHaveBeenCalledTimes(1);
    expect(originalJson).not.toHaveBeenCalled();
  });

  it("returns undefined when there is no response", async () => {
    await expect(extractRcErrorDetail(new Error("boom"))).resolves.toBeUndefined();
    await expect(extractRcErrorDetail(undefined)).resolves.toBeUndefined();
  });

  it("returns undefined (never throws) when json() rejects", async () => {
    const err = { response: { json: async () => { throw new Error("not json"); } } };
    await expect(extractRcErrorDetail(err)).resolves.toBeUndefined();
  });

  it("returns undefined when the body is not a JSON object", async () => {
    const err = { response: { json: async () => "plain text" } };
    await expect(extractRcErrorDetail(err)).resolves.toBeUndefined();
  });
});
