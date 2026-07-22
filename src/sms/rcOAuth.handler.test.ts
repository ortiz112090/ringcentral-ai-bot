import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";

// vi.mock factories are hoisted above the module's top-level consts, so anything
// they close over must be created via vi.hoisted (which runs first).
const h = vi.hoisted(() => ({
  SECRET: "test-service-role-key",
  CALLBACK_URL: "https://bot.example.com/rc/oauth/callback",
  TENANT: "00000000-0000-0000-0000-000000000001",
  mockRingcentral: {
    clientId: "cid" as string | undefined,
    clientSecret: "csecret" as string | undefined,
    serverUrl: "https://platform.ringcentral.com",
  },
  loadRemoteConfig: vi.fn(async () => ({ bot: null, botConfig: null, credentials: {} })),
  exchangeAuthorizationCode: vi.fn(),
  persistRcRefreshToken: vi.fn(async () => undefined),
  setRcSignedInLabel: vi.fn(async () => undefined),
  syncRcSmsOptions: vi.fn(async () => undefined),
}));

const SECRET = h.SECRET;
const CALLBACK_URL = h.CALLBACK_URL;
const TENANT = h.TENANT;
const mockRingcentral = h.mockRingcentral;
const loadRemoteConfig = h.loadRemoteConfig;
const exchangeAuthorizationCode = h.exchangeAuthorizationCode;
const persistRcRefreshToken = h.persistRcRefreshToken;
const setRcSignedInLabel = h.setRcSignedInLabel;
const syncRcSmsOptions = h.syncRcSmsOptions;

vi.mock("../config", () => ({
  config: { supabase: { serviceRoleKey: h.SECRET } },
  resolveEffectiveConfig: vi.fn(async () => ({ ringcentral: h.mockRingcentral })),
  rcOAuthCallbackUrl: () => h.CALLBACK_URL,
}));

vi.mock("../db/remoteConfig", () => ({
  BOT_ID: h.TENANT,
  loadRemoteConfig: (...a: any[]) => h.loadRemoteConfig(...a),
}));

vi.mock("../ringcentral/rcAuth", () => ({
  exchangeAuthorizationCode: (...a: any[]) => h.exchangeAuthorizationCode(...a),
}));

vi.mock("../db/rcOAuthQueries", () => ({
  persistRcRefreshToken: (...a: any[]) => h.persistRcRefreshToken(...a),
  setRcSignedInLabel: (...a: any[]) => h.setRcSignedInLabel(...a),
}));

vi.mock("./rcProvisioning", () => ({
  syncRcSmsOptions: (...a: any[]) => h.syncRcSmsOptions(...a),
}));

vi.mock("../logger", () => ({
  logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
}));

import { handleRcOAuthStart, handleRcOAuthCallback } from "./rcOAuth";

// Mirror the module's state signing so we can mint valid/tampered/stale states.
function signState(payload: { bot_id: string; return_to: string; ts: number }): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function fakeReq(query: Record<string, string>): any {
  return { query };
}

function fakeRes(): any {
  return {
    statusCode: 0,
    body: "",
    redirectedTo: null as string | null,
    redirectCode: 0,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send(payload?: string) {
      this.body = payload ?? "";
      return this;
    },
    redirect(code: number, url: string) {
      this.redirectCode = code;
      this.redirectedTo = url;
      return this;
    },
  };
}

const RETURN_TO = "https://dash.example.com/settings";

beforeEach(() => {
  vi.clearAllMocks();
  mockRingcentral.clientId = "cid";
  mockRingcentral.clientSecret = "csecret";
  mockRingcentral.serverUrl = "https://platform.ringcentral.com";
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("handleRcOAuthStart", () => {
  it("302s to RingCentral /authorize with a valid, signed state", async () => {
    const res = fakeRes();
    await handleRcOAuthStart(
      fakeReq({ bot_id: TENANT, return_to: RETURN_TO }),
      res
    );
    expect(res.redirectCode).toBe(302);
    const url = new URL(res.redirectedTo);
    expect(url.origin + url.pathname).toBe("https://platform.ringcentral.com/restapi/oauth/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe(CALLBACK_URL);

    // The state must verify against the same HMAC secret.
    const state = url.searchParams.get("state")!;
    const [body, sig] = state.split(".");
    const expected = createHmac("sha256", SECRET).update(body).digest("base64url");
    expect(sig).toBe(expected);
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    expect(payload).toMatchObject({ bot_id: TENANT, return_to: RETURN_TO });
    expect(typeof payload.ts).toBe("number");
  });

  it("400s on an invalid (non-uuid) bot_id", async () => {
    const res = fakeRes();
    await handleRcOAuthStart(fakeReq({ bot_id: "not-a-uuid", return_to: RETURN_TO }), res);
    expect(res.statusCode).toBe(400);
    expect(res.redirectedTo).toBeNull();
  });

  it("400s when return_to is not https", async () => {
    const res = fakeRes();
    await handleRcOAuthStart(fakeReq({ bot_id: TENANT, return_to: "http://dash.example.com" }), res);
    expect(res.statusCode).toBe(400);
  });

  it("redirects back with rc_error when client_id is not configured", async () => {
    mockRingcentral.clientId = undefined;
    const res = fakeRes();
    await handleRcOAuthStart(fakeReq({ bot_id: TENANT, return_to: RETURN_TO }), res);
    expect(res.redirectCode).toBe(302);
    expect(new URL(res.redirectedTo).searchParams.get("rc_error")).toBe("not_configured");
  });
});

describe("handleRcOAuthCallback", () => {
  function stubIdentityFetch() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ name: "Joal Ortiz", extensionNumber: "499" }),
      }))
    );
  }

  it("happy path: persists rotated refresh token + label, triggers sync, redirects rc_connected=1", async () => {
    stubIdentityFetch();
    exchangeAuthorizationCode.mockResolvedValueOnce({
      access_token: "at-1",
      refresh_token: "rt-rotated",
      expires_in: 3600,
    });
    const state = signState({ bot_id: TENANT, return_to: RETURN_TO, ts: Date.now() });
    const res = fakeRes();
    await handleRcOAuthCallback(fakeReq({ code: "the-code", state }), res);

    expect(exchangeAuthorizationCode).toHaveBeenCalledWith(
      expect.objectContaining({ code: "the-code", redirectUri: CALLBACK_URL })
    );
    expect(persistRcRefreshToken).toHaveBeenCalledWith("rt-rotated", TENANT);
    expect(setRcSignedInLabel).toHaveBeenCalledWith("Joal Ortiz — ext 499", TENANT);
    expect(syncRcSmsOptions).toHaveBeenCalledTimes(1);
    expect(res.redirectCode).toBe(302);
    expect(new URL(res.redirectedTo).searchParams.get("rc_connected")).toBe("1");
  });

  it("tampered state → 400, nothing persisted", async () => {
    const state = signState({ bot_id: TENANT, return_to: RETURN_TO, ts: Date.now() });
    const tampered = state.slice(0, -2) + (state.endsWith("A") ? "B" : "A"); // corrupt the signature
    const res = fakeRes();
    await handleRcOAuthCallback(fakeReq({ code: "x", state: tampered }), res);
    expect(res.statusCode).toBe(400);
    expect(persistRcRefreshToken).not.toHaveBeenCalled();
    expect(exchangeAuthorizationCode).not.toHaveBeenCalled();
  });

  it("stale state (ts older than 15 min) → 400, nothing persisted", async () => {
    const state = signState({
      bot_id: TENANT,
      return_to: RETURN_TO,
      ts: Date.now() - 16 * 60 * 1000,
    });
    const res = fakeRes();
    await handleRcOAuthCallback(fakeReq({ code: "x", state }), res);
    expect(res.statusCode).toBe(400);
    expect(persistRcRefreshToken).not.toHaveBeenCalled();
  });

  it("token-exchange failure → rc_error redirect, nothing persisted", async () => {
    exchangeAuthorizationCode.mockRejectedValueOnce(
      Object.assign(new Error("bad"), { rcError: "invalid_grant", status: 400 })
    );
    const state = signState({ bot_id: TENANT, return_to: RETURN_TO, ts: Date.now() });
    const res = fakeRes();
    await handleRcOAuthCallback(fakeReq({ code: "the-code", state }), res);
    expect(res.redirectCode).toBe(302);
    expect(new URL(res.redirectedTo).searchParams.get("rc_error")).toBe("token_exchange");
    expect(persistRcRefreshToken).not.toHaveBeenCalled();
    expect(setRcSignedInLabel).not.toHaveBeenCalled();
    expect(syncRcSmsOptions).not.toHaveBeenCalled();
  });

  it("state bot_id mismatch → rc_error redirect (guards the tenant)", async () => {
    const state = signState({
      bot_id: "11111111-1111-1111-1111-111111111111",
      return_to: RETURN_TO,
      ts: Date.now(),
    });
    const res = fakeRes();
    await handleRcOAuthCallback(fakeReq({ code: "x", state }), res);
    expect(res.redirectCode).toBe(302);
    expect(new URL(res.redirectedTo).searchParams.get("rc_error")).toBe("bot_mismatch");
    expect(exchangeAuthorizationCode).not.toHaveBeenCalled();
  });
});
