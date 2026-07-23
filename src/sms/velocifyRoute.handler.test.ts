import { describe, it, expect, vi, beforeEach } from "vitest";

const mockConfig = { textOutreachSecret: "s3cret" };
vi.mock("../config", () => ({
  get config() {
    return mockConfig;
  },
  resolveEffectiveConfig: vi.fn(async () => ({ text: {}, botRole: "texting" })),
  twilioSmsWebhookUrl: () => "https://bot.example.com/webhooks/twilio/sms",
}));
vi.mock("../db/remoteConfig", () => ({
  BOT_ID: "00000000-0000-0000-0000-000000000001",
  loadRemoteConfig: vi.fn(async () => ({ bot: null, botConfig: null, credentials: {} })),
}));
// smsRoutes now transitively imports the real Supabase client (via velocifySync →
// velocifyQueries), which reads config at module load. Stub it so that import-time
// read doesn't fire the config getter before mockConfig initializes.
vi.mock("../db/supabase", () => ({ supabase: {} }));
vi.mock("../twilio/client", () => ({ getTwilioAuthToken: vi.fn(async () => "tok") }));
vi.mock("./smsService", () => ({
  handleInboundSms: vi.fn(async () => {}),
  sendWebLeadText: vi.fn(async () => true),
}));

const runSync = vi.fn();
vi.mock("../campaigns/velocifySync", async () => {
  const actual = await vi.importActual<typeof import("../campaigns/velocifySync")>(
    "../campaigns/velocifySync"
  );
  return { ...actual, runSync: (...a: any[]) => runSync(...a) };
});

import { handleVelocifySync } from "./smsRoutes";
import { loadRemoteConfig } from "../db/remoteConfig";

function fakeReq(opts: { headers?: Record<string, string>; params?: Record<string, string> }) {
  const headers = opts.headers ?? {};
  return { header: (n: string) => headers[n], body: {}, params: opts.params ?? {} } as any;
}
function fakeRes() {
  const res: any = {
    statusCode: 0,
    jsonBody: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.jsonBody = payload;
      return this;
    },
  };
  return res;
}

const auth = { "X-Outreach-Secret": "s3cret" };
const botParams = { botId: "00000000-0000-0000-0000-000000000001" };

beforeEach(() => {
  vi.clearAllMocks();
  mockConfig.textOutreachSecret = "s3cret";
  runSync.mockResolvedValue({
    accepted: true,
    counts: { fetched: 3, excluded_name: 1, excluded_phone: 0, duplicates: 0, already_known: 0, added: 2 },
  });
});

describe("handleVelocifySync (auth mirrors handleTextOutreach)", () => {
  it("503 when TEXT_OUTREACH_SECRET is unset", async () => {
    mockConfig.textOutreachSecret = "";
    const res = fakeRes();
    await handleVelocifySync(fakeReq({ headers: auth, params: botParams }), res);
    expect(res.statusCode).toBe(503);
    expect(runSync).not.toHaveBeenCalled();
  });

  it("401 on a bad/missing secret", async () => {
    const res = fakeRes();
    await handleVelocifySync(fakeReq({ headers: { "X-Outreach-Secret": "wrong" }, params: botParams }), res);
    expect(res.statusCode).toBe(401);
    expect(runSync).not.toHaveBeenCalled();
  });

  it("404 when the path botId does not match this tenant", async () => {
    const res = fakeRes();
    await handleVelocifySync(fakeReq({ headers: auth, params: { botId: "other" } }), res);
    expect(res.statusCode).toBe(404);
    expect(runSync).not.toHaveBeenCalled();
  });

  it("refreshes remote config before running the sync", async () => {
    const res = fakeRes();
    await handleVelocifySync(fakeReq({ headers: auth, params: botParams }), res);
    expect(loadRemoteConfig).toHaveBeenCalled();
  });

  it("200 with the counts JSON on a successful sync", async () => {
    const res = fakeRes();
    await handleVelocifySync(fakeReq({ headers: auth, params: botParams }), res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toEqual({
      accepted: true,
      counts: { fetched: 3, excluded_name: 1, excluded_phone: 0, duplicates: 0, already_known: 0, added: 2 },
    });
  });

  it("409 with {accepted:false, reason} when gated (disabled/no report id/creds)", async () => {
    runSync.mockResolvedValueOnce({ accepted: false, reason: "velocify_sync_disabled" });
    const res = fakeRes();
    await handleVelocifySync(fakeReq({ headers: auth, params: botParams }), res);
    expect(res.statusCode).toBe(409);
    expect(res.jsonBody).toEqual({ accepted: false, reason: "velocify_sync_disabled" });
  });

  it("502 with {accepted:false, reason} on a fetch/parse failure", async () => {
    runSync.mockResolvedValueOnce({ accepted: false, reason: "fetch_failed" });
    const res = fakeRes();
    await handleVelocifySync(fakeReq({ headers: auth, params: botParams }), res);
    expect(res.statusCode).toBe(502);
    expect(res.jsonBody).toEqual({ accepted: false, reason: "fetch_failed" });
  });
});
