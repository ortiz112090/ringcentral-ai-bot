import { describe, it, expect, vi, beforeEach } from "vitest";

// Chainable Supabase mock covering the two shapes these helpers use:
//   select().eq().eq().maybeSingle()   (read existing ringcentral creds)
//   upsert(payload, opts)              (write merged creds)
//   update(payload).eq()               (set the label)
interface Recorded {
  table: string;
  op?: string;
  payload?: any;
  opts?: any;
  eq: Record<string, any>;
}

const results: Array<{ data?: any; error?: any }> = [];
const calls: Recorded[] = [];

function makeBuilder(table: string) {
  const rec: Recorded = { table, eq: {} };
  const builder: any = {
    select() {
      rec.op = "select";
      return builder;
    },
    update(payload: any) {
      rec.op = "update";
      rec.payload = payload;
      return builder;
    },
    upsert(payload: any, opts: any) {
      rec.op = "upsert";
      rec.payload = payload;
      rec.opts = opts;
      calls.push(rec);
      return Promise.resolve(results.shift() ?? { data: null, error: null });
    },
    eq(col: string, val: any) {
      rec.eq[col] = val;
      // update().eq() is terminal (awaited).
      if (rec.op === "update") {
        calls.push(rec);
        return Promise.resolve(results.shift() ?? { data: null, error: null });
      }
      return builder;
    },
    maybeSingle() {
      calls.push(rec);
      return Promise.resolve(results.shift() ?? { data: null, error: null });
    },
  };
  return builder;
}

vi.mock("./supabase", () => ({
  supabase: { from: (table: string) => makeBuilder(table) },
}));
vi.mock("./remoteConfig", () => ({ BOT_ID: "bot-default" }));

const errorSpy = vi.fn();
vi.mock("../logger", () => ({
  logger: { warn: () => {}, error: (...a: any[]) => errorSpy(...a), info: () => {}, debug: () => {} },
}));

import { persistRcRefreshToken, setRcSignedInLabel } from "./rcOAuthQueries";

beforeEach(() => {
  results.length = 0;
  calls.length = 0;
  errorSpy.mockReset();
});

describe("persistRcRefreshToken", () => {
  it("merges the refresh token into existing ringcentral credentials and upserts", async () => {
    results.push({ data: { credentials: { client_id: "cid", client_secret: "sec", jwt: "j" } } }); // read
    results.push({ error: null }); // upsert
    await persistRcRefreshToken("rt-new", "bot-1");

    const read = calls[0];
    expect(read.table).toBe("api_credentials");
    expect(read.eq).toEqual({ bot_id: "bot-1", provider: "ringcentral" });

    const write = calls[1];
    expect(write.op).toBe("upsert");
    expect(write.payload).toEqual({
      bot_id: "bot-1",
      provider: "ringcentral",
      credentials: { client_id: "cid", client_secret: "sec", jwt: "j", rc_refresh_token: "rt-new" },
    });
    expect(write.opts).toEqual({ onConflict: "bot_id,provider" });
  });

  it("handles an absent existing row (creates credentials with just the token)", async () => {
    results.push({ data: null }); // read: no row yet
    results.push({ error: null }); // upsert
    await persistRcRefreshToken("rt-1");
    expect(calls[1].payload.credentials).toEqual({ rc_refresh_token: "rt-1" });
    expect(calls[1].payload.bot_id).toBe("bot-default"); // default BOT_ID
  });

  it("no-ops on a blank token (no DB calls)", async () => {
    await persistRcRefreshToken("   ", "bot-1");
    expect(calls.length).toBe(0);
  });

  it("does not upsert when the read fails (logs, leaves creds untouched)", async () => {
    results.push({ error: { message: "read boom" } });
    await persistRcRefreshToken("rt", "bot-1");
    expect(calls.length).toBe(1); // only the read
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe("setRcSignedInLabel", () => {
  it("updates bot_config.rc_signed_in_label scoped by bot_id", async () => {
    results.push({ error: null });
    await setRcSignedInLabel("Joal — ext 499", "bot-9");
    expect(calls[0]).toMatchObject({
      table: "bot_config",
      op: "update",
      payload: { rc_signed_in_label: "Joal — ext 499" },
      eq: { bot_id: "bot-9" },
    });
  });

  it("clears the label with '' (signed-out) and is failure-tolerant", async () => {
    results.push({ error: { message: "upd boom" } });
    await setRcSignedInLabel("", "bot-9");
    expect(calls[0].payload).toEqual({ rc_signed_in_label: "" });
    expect(errorSpy).toHaveBeenCalled();
  });
});
