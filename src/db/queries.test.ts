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

import { finalizeCallRecord } from "./queries";

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
