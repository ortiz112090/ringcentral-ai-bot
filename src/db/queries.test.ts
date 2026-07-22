import { describe, it, expect, vi, beforeEach } from "vitest";

// Records one terminal Supabase call (the accumulated builder chain) so tests can
// assert which guarded update ran and with what filters/payload. Results are
// dequeued in order, one per fully-awaited chain.
interface Recorded {
  op?: string;
  payload?: any;
  eq: Record<string, any>;
  is: Record<string, any>;
  selected?: string;
  order?: { col: string; opts?: any };
  limit?: number;
}

const results: Array<{ data: any; error: any }> = [];
const calls: Recorded[] = [];

function makeBuilder() {
  const rec: Recorded = { eq: {}, is: {} };
  const builder: any = {
    update(payload: any) {
      rec.op = "update";
      rec.payload = payload;
      return builder;
    },
    upsert(payload: any) {
      rec.op = "upsert";
      rec.payload = payload;
      return builder;
    },
    insert(payload: any) {
      rec.op = "insert";
      rec.payload = payload;
      return builder;
    },
    select(cols?: string) {
      rec.selected = cols;
      return builder;
    },
    eq(col: string, val: any) {
      rec.eq[col] = val;
      return builder;
    },
    is(col: string, val: any) {
      rec.is[col] = val;
      return builder;
    },
    lt(col: string, val: any) {
      rec.eq[col] = val;
      return builder;
    },
    order(col: string, opts?: any) {
      rec.order = { col, opts };
      return builder;
    },
    limit(n: number) {
      rec.limit = n;
      return builder;
    },
    maybeSingle() {
      return builder;
    },
    then(resolve: any, reject: any) {
      calls.push(rec);
      const result = results.shift() ?? { data: null, error: null };
      return Promise.resolve(result).then(resolve, reject);
    },
  };
  return builder;
}

vi.mock("./supabase", () => ({
  supabase: { from: (_table: string) => makeBuilder() },
}));

import {
  closeCallIfLive,
  fetchBotActiveStatus,
  finalizeCallRecord,
  getLeadFields,
  getScriptStages,
  getScriptConstraints,
  mergeCapturedData,
  getWebhookDestination,
  upsertLead,
} from "./queries";

const BOT_ID = "00000000-0000-0000-0000-000000000001";

beforeEach(() => {
  results.length = 0;
  calls.length = 0;
});

describe("finalizeCallRecord double-finalize guard", () => {
  it("finalizes a still-live row with a single guarded update", async () => {
    results.push({ data: [{ call_id: "c1" }], error: null });

    await finalizeCallRecord("c1", { outcome: "escalated", scriptStageReached: "close" });

    expect(calls).toHaveLength(1);
    const [g] = calls;
    expect(g.op).toBe("update");
    expect(g.payload.outcome).toBe("escalated");
    expect(g.eq.bot_id).toBe(BOT_ID);
    expect(g.eq.call_id).toBe("c1");
    // The guard scopes to live rows only.
    expect(g.is.ended_at).toBeNull();
  });

  it("upgrades an already-'abandoned' row when finalizing 'escalated'", async () => {
    // Guarded update matches nothing (row already finalized by the hangup path),
    // then the follow-up upgrade matches the abandoned row.
    results.push({ data: [], error: null });
    results.push({ data: [{ call_id: "c1" }], error: null });

    await finalizeCallRecord("c1", { outcome: "escalated" });

    expect(calls).toHaveLength(2);
    const upgrade = calls[1];
    expect(upgrade.op).toBe("update");
    expect(upgrade.payload.outcome).toBe("escalated");
    expect(upgrade.eq.bot_id).toBe(BOT_ID);
    expect(upgrade.eq.call_id).toBe("c1");
    // Upgrade is scoped to rows currently marked 'abandoned' — never anything else.
    expect(upgrade.eq.outcome).toBe("abandoned");
  });

  it("'abandoned' never overwrites an already-finalized row", async () => {
    // Guarded update matches nothing because a stronger outcome finalized first.
    results.push({ data: [], error: null });

    await finalizeCallRecord("c1", { outcome: "abandoned" });

    // No follow-up update — 'abandoned' bails out rather than clobbering.
    expect(calls).toHaveLength(1);
    expect(calls[0].is.ended_at).toBeNull();
  });

  it("does not run the upgrade when the guarded update already succeeded", async () => {
    results.push({ data: [{ call_id: "c1" }], error: null });

    await finalizeCallRecord("c1", { outcome: "closed_pif" });

    expect(calls).toHaveLength(1);
  });
});

describe("fetchBotActiveStatus (fresh per-call read of bots.active)", () => {
  it("reads active + deleted_at scoped to this tenant's bots row (id = bot_id)", async () => {
    results.push({ data: { active: true, deleted_at: null }, error: null });

    const status = await fetchBotActiveStatus(BOT_ID);

    expect(status).toEqual({ found: true, active: true, deleted_at: null });
    const [c] = calls;
    expect(c.eq.id).toBe(BOT_ID);
    expect(c.selected).toBe("active, deleted_at");
  });

  it("returns found:false when the bots row is missing (→ caller disables)", async () => {
    results.push({ data: null, error: null });
    expect(await fetchBotActiveStatus(BOT_ID)).toEqual({
      found: false,
      active: null,
      deleted_at: null,
    });
  });

  it("returns null on query error (→ caller fails open)", async () => {
    results.push({ data: null, error: { message: "boom" } });
    expect(await fetchBotActiveStatus(BOT_ID)).toBeNull();
  });
});

describe("closeCallIfLive tolerates a call with no calls row (no error spam)", () => {
  it("does not error when the guarded update matches zero rows", async () => {
    results.push({ data: [], error: null });
    await expect(closeCallIfLive("no-such-call", "abandoned")).resolves.toBeUndefined();
    const [c] = calls;
    expect(c.eq.bot_id).toBe(BOT_ID);
    expect(c.eq.call_id).toBe("no-such-call");
    expect(c.is.ended_at).toBeNull();
  });
});

describe("getLeadFields", () => {
  it("queries active fields for the bot ordered by sort_order", async () => {
    const rows = [{ field_key: "first_name", field_type: "text" }];
    results.push({ data: rows, error: null });

    const out = await getLeadFields(BOT_ID);

    expect(out).toEqual(rows);
    const [c] = calls;
    expect(c.eq.bot_id).toBe(BOT_ID);
    expect(c.eq.active).toBe(true);
    expect(c.order).toEqual({ col: "sort_order", opts: { ascending: true } });
  });

  it("returns [] on query error (fallback path)", async () => {
    results.push({ data: null, error: { message: "boom" } });
    expect(await getLeadFields(BOT_ID)).toEqual([]);
  });
});

describe("getScriptStages", () => {
  it("queries active stages for the bot ordered by stage_order", async () => {
    const rows = [{ stage_key: "opener", stage_type: "opener", stage_order: 1 }];
    results.push({ data: rows, error: null });

    const out = await getScriptStages(BOT_ID);

    expect(out).toEqual(rows);
    const [c] = calls;
    expect(c.eq.bot_id).toBe(BOT_ID);
    expect(c.eq.active).toBe(true);
    expect(c.order).toEqual({ col: "stage_order", opts: { ascending: true } });
  });

  it("returns [] on query error (fallback to hardcoded script)", async () => {
    results.push({ data: null, error: { message: "boom" } });
    expect(await getScriptStages(BOT_ID)).toEqual([]);
  });
});

describe("getScriptConstraints", () => {
  it("queries active constraints scoped to the bot", async () => {
    const rows = [{ rule_text: "No refunds", severity: "critical" }];
    results.push({ data: rows, error: null });

    const out = await getScriptConstraints(BOT_ID);

    expect(out).toEqual(rows);
    const [c] = calls;
    expect(c.eq.bot_id).toBe(BOT_ID);
    expect(c.eq.active).toBe(true);
  });

  it("returns [] on query error", async () => {
    results.push({ data: null, error: { message: "boom" } });
    expect(await getScriptConstraints(BOT_ID)).toEqual([]);
  });
});

describe("mergeCapturedData", () => {
  it("read-modify-writes: preserves existing keys and overwrites with new ones", async () => {
    results.push({ data: { captured_data: { a: 1, b: 2 } }, error: null }); // read
    results.push({ data: null, error: null }); // update

    await mergeCapturedData("c1", { b: 3, c: 4 });

    expect(calls).toHaveLength(2);
    const [read, update] = calls;
    expect(read.op).toBeUndefined(); // select-only chain
    expect(read.eq.call_id).toBe("c1");
    expect(update.op).toBe("update");
    expect(update.payload.captured_data).toEqual({ a: 1, b: 3, c: 4 });
    expect(update.eq.bot_id).toBe(BOT_ID);
    expect(update.eq.call_id).toBe("c1");
  });

  it("no-ops on empty data (no DB calls)", async () => {
    await mergeCapturedData("c1", {});
    expect(calls).toHaveLength(0);
  });

  it("skips the write when the read errors", async () => {
    results.push({ data: null, error: { message: "boom" } });
    await mergeCapturedData("c1", { a: 1 });
    expect(calls).toHaveLength(1); // only the read ran
  });
});

describe("getWebhookDestination", () => {
  it("returns url + secret from an enabled webhook row", async () => {
    results.push({
      data: { config: { url: "https://hook.example.com", secret: "s3cr3t" } },
      error: null,
    });

    const dest = await getWebhookDestination(BOT_ID);

    expect(dest).toEqual({ url: "https://hook.example.com", secret: "s3cr3t" });
    const [c] = calls;
    expect(c.eq.bot_id).toBe(BOT_ID);
    expect(c.eq.destination_type).toBe("webhook");
    expect(c.eq.enabled).toBe(true);
    expect(c.limit).toBe(1);
  });

  it("returns null when config.url is missing/empty", async () => {
    results.push({ data: { config: { secret: "x" } }, error: null });
    expect(await getWebhookDestination(BOT_ID)).toBeNull();
  });

  it("returns null on query error", async () => {
    results.push({ data: null, error: { message: "boom" } });
    expect(await getWebhookDestination(BOT_ID)).toBeNull();
  });
});

describe("upsertLead persists the contact columns", () => {
  it("includes address, email, and start_timeline in the upsert payload", async () => {
    results.push({ data: null, error: null });

    await upsertLead({
      phone_number: "+15551112222",
      address: "123 Main St, Springfield, 90210",
      email: "sam@example.com",
      start_timeline: "this week",
    });

    const [c] = calls;
    expect(c.op).toBe("upsert");
    expect(c.payload.address).toBe("123 Main St, Springfield, 90210");
    expect(c.payload.email).toBe("sam@example.com");
    expect(c.payload.start_timeline).toBe("this week");
    expect(c.payload.phone_number).toBe("+15551112222");
  });
});
