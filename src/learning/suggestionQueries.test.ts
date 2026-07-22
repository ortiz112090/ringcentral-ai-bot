import { describe, it, expect, vi, beforeEach } from "vitest";

// Minimal chainable Supabase builder that records the terminal call and dequeues
// a queued result. Supports the subset of methods suggestionQueries uses.
interface Recorded {
  table: string;
  op?: string;
  payload?: any;
  eq: Record<string, any>;
  gte?: { col: string; val: any };
  gt?: { col: string; val: any };
  in?: { col: string; vals: any[] };
  selected?: string;
  head?: boolean;
  order?: { col: string; opts?: any };
  limit?: number;
}

const results: Array<{ data?: any; error?: any; count?: number }> = [];
const calls: Recorded[] = [];

function makeBuilder(table: string) {
  const rec: Recorded = { table, eq: {} };
  const builder: any = {
    insert(payload: any) {
      rec.op = "insert";
      rec.payload = payload;
      return builder;
    },
    select(cols?: string, opts?: any) {
      rec.selected = cols;
      if (opts?.head) rec.head = true;
      return builder;
    },
    eq(col: string, val: any) {
      rec.eq[col] = val;
      return builder;
    },
    gte(col: string, val: any) {
      rec.gte = { col, val };
      return builder;
    },
    gt(col: string, val: any) {
      rec.gt = { col, val };
      return builder;
    },
    in(col: string, vals: any[]) {
      rec.in = { col, vals };
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

vi.mock("../db/supabase", () => ({
  supabase: { from: (table: string) => makeBuilder(table) },
}));
vi.mock("../db/remoteConfig", () => ({
  BOT_ID: "00000000-0000-0000-0000-000000000001",
}));

import {
  countMessagesSince,
  getActiveTextStages,
  insertScriptSuggestion,
  type NewScriptSuggestion,
} from "./suggestionQueries";

beforeEach(() => {
  results.length = 0;
  calls.length = 0;
});

const sample: NewScriptSuggestion = {
  flow: "text",
  stageId: 7,
  suggestionType: "reword",
  currentText: "old",
  suggestedText: "new and improved",
  rationale: "clearer",
  evidence: [{ conversation_id: "c1", snippet: "quiet" }],
};

describe("insertScriptSuggestion", () => {
  it("inserts a pending row scoped to the bot and returns true", async () => {
    results.push({ error: null });
    const ok = await insertScriptSuggestion(sample);
    expect(ok).toBe(true);
    expect(calls[0].table).toBe("script_suggestions");
    expect(calls[0].payload).toEqual(
      expect.objectContaining({
        bot_id: "00000000-0000-0000-0000-000000000001",
        flow: "text",
        stage_id: 7,
        suggestion_type: "reword",
        suggested_text: "new and improved",
        status: "pending",
      })
    );
  });

  it("silently skips a duplicate (unique-violation 23505) and returns false", async () => {
    results.push({ error: { code: "23505", message: "duplicate key" } });
    const ok = await insertScriptSuggestion(sample);
    expect(ok).toBe(false);
  });

  it("returns false (not throw) on any other DB error", async () => {
    results.push({ error: { code: "500", message: "boom" } });
    const ok = await insertScriptSuggestion(sample);
    expect(ok).toBe(false);
  });
});

describe("getActiveTextStages", () => {
  it("filters to active rows for the bot and returns them", async () => {
    results.push({ data: [{ id: 1, stage_key: "opener", stage_type: "opener", title: "O", script_text: "hi" }], error: null });
    const stages = await getActiveTextStages();
    expect(stages).toHaveLength(1);
    expect(calls[0].eq).toEqual(
      expect.objectContaining({ bot_id: "00000000-0000-0000-0000-000000000001", active: true })
    );
  });

  it("returns [] on error", async () => {
    results.push({ data: null, error: { message: "nope" } });
    expect(await getActiveTextStages()).toEqual([]);
  });
});

describe("countMessagesSince", () => {
  it("adds a > filter when given a timestamp and returns the count", async () => {
    results.push({ count: 12, error: null });
    const n = await countMessagesSince("2026-07-01T00:00:00Z");
    expect(n).toBe(12);
    expect(calls[0].gt).toEqual({ col: "created_at", val: "2026-07-01T00:00:00Z" });
    expect(calls[0].head).toBe(true);
  });

  it("counts all-time (no > filter) when given null", async () => {
    results.push({ count: 3, error: null });
    const n = await countMessagesSince(null);
    expect(n).toBe(3);
    expect(calls[0].gt).toBeUndefined();
  });

  it("returns 0 on error", async () => {
    results.push({ count: null, error: { message: "boom" } });
    expect(await countMessagesSince(null)).toBe(0);
  });
});
