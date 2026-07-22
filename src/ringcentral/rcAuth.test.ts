import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Persistence + label writes are spied; their DB layer is covered in
// rcOAuthQueries.test.ts.
const persistRcRefreshToken = vi.fn(async () => undefined);
const setRcSignedInLabel = vi.fn(async () => undefined);
vi.mock("../db/rcOAuthQueries", () => ({
  persistRcRefreshToken: (...a: any[]) => persistRcRefreshToken(...a),
  setRcSignedInLabel: (...a: any[]) => setRcSignedInLabel(...a),
}));

const warnSpy = vi.fn();
const errorSpy = vi.fn();
vi.mock("../logger", () => ({
  logger: { warn: (...a: any[]) => warnSpy(...a), error: (...a: any[]) => errorSpy(...a), info: () => {}, debug: () => {} },
}));

import {
  getRcOAuthAccessToken,
  exchangeAuthorizationCode,
  __clearRcAuthCacheForTests,
} from "./rcAuth";

// Controllable fetch: each call shifts the next queued response.
interface FetchResult {
  ok: boolean;
  status: number;
  body: any;
}
const fetchQueue: FetchResult[] = [];
const fetchCalls: Array<{ url: string; init: any }> = [];
const fetchMock = vi.fn(async (url: string, init: any) => {
  fetchCalls.push({ url, init });
  const r = fetchQueue.shift() ?? { ok: true, status: 200, body: {} };
  return {
    ok: r.ok,
    status: r.status,
    text: async () => (r.body == null ? "" : JSON.stringify(r.body)),
    json: async () => r.body,
  } as any;
});

const BASE = {
  serverUrl: "https://platform.ringcentral.com",
  clientId: "cid",
  clientSecret: "csecret",
};

beforeEach(() => {
  fetchQueue.length = 0;
  fetchCalls.length = 0;
  vi.clearAllMocks();
  __clearRcAuthCacheForTests();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function ok(body: any): FetchResult {
  return { ok: true, status: 200, body };
}
function err(status: number, body: any): FetchResult {
  return { ok: false, status, body };
}

describe("exchangeAuthorizationCode", () => {
  it("POSTs the token endpoint with basic auth and grant_type=authorization_code", async () => {
    fetchQueue.push(ok({ access_token: "at", refresh_token: "rt", expires_in: 3600 }));
    const resp = await exchangeAuthorizationCode({
      ...BASE,
      code: "the-code",
      redirectUri: "https://bot.example.com/rc/oauth/callback",
    });
    expect(resp).toMatchObject({ access_token: "at", refresh_token: "rt" });

    const { url, init } = fetchCalls[0];
    expect(url).toBe("https://platform.ringcentral.com/restapi/oauth/token");
    expect(init.method).toBe("POST");
    const expectedAuth = "Basic " + Buffer.from("cid:csecret").toString("base64");
    expect(init.headers.Authorization).toBe(expectedAuth);
    expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const params = new URLSearchParams(init.body);
    expect(params.get("grant_type")).toBe("authorization_code");
    expect(params.get("code")).toBe("the-code");
    expect(params.get("redirect_uri")).toBe("https://bot.example.com/rc/oauth/callback");
  });

  it("throws RcTokenError carrying the RC error code on a non-2xx response", async () => {
    fetchQueue.push(err(400, { error: "invalid_grant" }));
    await expect(
      exchangeAuthorizationCode({ ...BASE, code: "bad", redirectUri: "https://x/cb" })
    ).rejects.toMatchObject({ rcError: "invalid_grant", status: 400 });
  });
});

describe("getRcOAuthAccessToken — refresh-token flow", () => {
  it("obtains an access token via grant_type=refresh_token (precedence path)", async () => {
    fetchQueue.push(ok({ access_token: "at-1", refresh_token: "rt-2", expires_in: 3600 }));
    const token = await getRcOAuthAccessToken({ botId: "bot-1", ...BASE, refreshToken: "rt-1" });
    expect(token).toBe("at-1");
    const params = new URLSearchParams(fetchCalls[0].init.body);
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("rt-1");
  });

  it("persists the ROTATED refresh token on every token response", async () => {
    fetchQueue.push(ok({ access_token: "at-1", refresh_token: "rotated-A", expires_in: 1 }));
    await getRcOAuthAccessToken({ botId: "bot-1", ...BASE, refreshToken: "rt-1" });
    expect(persistRcRefreshToken).toHaveBeenCalledWith("rotated-A", "bot-1");

    // Force a second refresh (previous token expired ~immediately) → persists again.
    fetchQueue.push(ok({ access_token: "at-2", refresh_token: "rotated-B", expires_in: 3600 }));
    const token = await getRcOAuthAccessToken({ botId: "bot-1", ...BASE, refreshToken: "rotated-A" });
    expect(token).toBe("at-2");
    expect(persistRcRefreshToken).toHaveBeenCalledWith("rotated-B", "bot-1");
    expect(persistRcRefreshToken).toHaveBeenCalledTimes(2);
  });

  it("caches the access token in memory (no second HTTP call before expiry)", async () => {
    fetchQueue.push(ok({ access_token: "at-1", refresh_token: "rt-2", expires_in: 3600 }));
    const first = await getRcOAuthAccessToken({ botId: "bot-1", ...BASE, refreshToken: "rt-1" });
    const second = await getRcOAuthAccessToken({ botId: "bot-1", ...BASE, refreshToken: "rt-1" });
    expect(first).toBe("at-1");
    expect(second).toBe("at-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("invalid_grant → clears label, warns, returns null (JWT fallback)", async () => {
    fetchQueue.push(err(400, { error: "invalid_grant" }));
    const token = await getRcOAuthAccessToken({ botId: "bot-1", ...BASE, refreshToken: "revoked" });
    expect(token).toBeNull();
    expect(setRcSignedInLabel).toHaveBeenCalledWith("", "bot-1");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("sign in again"),
      expect.objectContaining({ botId: "bot-1" })
    );
    expect(persistRcRefreshToken).not.toHaveBeenCalled();
  });

  it("other errors → returns null without clearing the label (transient, keep sign-in)", async () => {
    fetchQueue.push(err(500, { error: "internal" }));
    const token = await getRcOAuthAccessToken({ botId: "bot-1", ...BASE, refreshToken: "rt-1" });
    expect(token).toBeNull();
    expect(setRcSignedInLabel).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("caches are isolated per bot", async () => {
    fetchQueue.push(ok({ access_token: "at-A", refresh_token: "rt-A2", expires_in: 3600 }));
    fetchQueue.push(ok({ access_token: "at-B", refresh_token: "rt-B2", expires_in: 3600 }));
    const a = await getRcOAuthAccessToken({ botId: "bot-A", ...BASE, refreshToken: "rt-A" });
    const b = await getRcOAuthAccessToken({ botId: "bot-B", ...BASE, refreshToken: "rt-B" });
    expect(a).toBe("at-A");
    expect(b).toBe("at-B");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Each bot now serves its own cached token; still no new HTTP.
    expect(await getRcOAuthAccessToken({ botId: "bot-A", ...BASE, refreshToken: "rt-A" })).toBe("at-A");
    expect(await getRcOAuthAccessToken({ botId: "bot-B", ...BASE, refreshToken: "rt-B" })).toBe("at-B");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
