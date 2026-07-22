import { describe, it, expect, vi, beforeEach } from "vitest";

// Minimal chainable Supabase builder for the delete-then-insert used by
// replaceRcSmsOptions. Each terminal call dequeues a queued result and records
// the op so the test can assert what was sent.
interface Recorded {
  table: string;
  op?: string;
  payload?: any;
  eq: Record<string, any>;
}

const results: Array<{ data?: any; error?: any }> = [];
const calls: Recorded[] = [];

function makeBuilder(table: string) {
  const rec: Recorded = { table, eq: {} };
  const builder: any = {
    delete() {
      rec.op = "delete";
      return builder;
    },
    insert(payload: any) {
      rec.op = "insert";
      rec.payload = payload;
      calls.push(rec);
      return Promise.resolve(results.shift() ?? { data: null, error: null });
    },
    eq(col: string, val: any) {
      rec.eq[col] = val;
      // .delete().eq() is terminal (awaited) — record + resolve here.
      if (rec.op === "delete") {
        calls.push(rec);
        return Promise.resolve(results.shift() ?? { data: null, error: null });
      }
      return builder;
    },
  };
  return builder;
}

vi.mock("../db/supabase", () => ({
  supabase: { from: (table: string) => makeBuilder(table) },
}));
vi.mock("../db/remoteConfig", () => ({ BOT_ID: "bot-test" }));

const errorSpy = vi.fn();
vi.mock("../logger", () => ({
  logger: {
    warn: () => {},
    error: (...a: any[]) => errorSpy(...a),
    info: () => {},
    debug: () => {},
  },
}));

import { replaceRcSmsOptions, type RcSmsOptionInput } from "./smsQueries";

const sample: RcSmsOptionInput[] = [
  {
    extension_id: "301",
    extension_name: "Sales",
    extension_number: "101",
    phone_number: "+15550000101",
    sms_enabled: true,
  },
];

beforeEach(() => {
  results.length = 0;
  calls.length = 0;
  errorSpy.mockReset();
});

describe("replaceRcSmsOptions", () => {
  it("deletes the bot's rows then bulk-inserts the fresh set (bot_id stamped)", async () => {
    results.push({ error: null }); // delete
    results.push({ error: null }); // insert
    await replaceRcSmsOptions(sample);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      table: "rc_sms_options",
      op: "delete",
      eq: { bot_id: "bot-test" },
    });
    expect(calls[1].op).toBe("insert");
    expect(calls[1].payload).toEqual([
      { bot_id: "bot-test", ...sample[0], synced_at: expect.any(String) },
    ]);
  });

  it("does not insert when the option set is empty (delete-only clear)", async () => {
    results.push({ error: null }); // delete
    await replaceRcSmsOptions([]);
    expect(calls).toHaveLength(1);
    expect(calls[0].op).toBe("delete");
  });

  it("leaves old rows in place (no insert) when the delete fails", async () => {
    results.push({ error: { message: "delete boom" } }); // delete fails
    await replaceRcSmsOptions(sample);
    expect(calls).toHaveLength(1);
    expect(calls[0].op).toBe("delete");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("leaving old rows"),
      expect.objectContaining({ error: "delete boom" })
    );
  });

  it("logs when the insert fails", async () => {
    results.push({ error: null }); // delete
    results.push({ error: { message: "insert boom" } }); // insert fails
    await replaceRcSmsOptions(sample);
    expect(calls).toHaveLength(2);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to insert rc_sms_options"),
      expect.objectContaining({ error: "insert boom" })
    );
  });
});
