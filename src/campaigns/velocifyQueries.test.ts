import { describe, it, expect, vi, beforeEach } from "vitest";

// Chainable, thenable Supabase mock. Each `.from()` records a call; terminal
// operations (`await builder` after in()/insert()/eq-chains, or `.maybeSingle()`)
// consume the next queued result. Covers the shapes these helpers use.
interface Recorded {
  table: string;
  op?: string;
  select?: string;
  payload?: any;
  eqs: Record<string, any>;
  inCol?: string;
  inVals?: any[];
}

const results: Array<{ data?: any; error?: any }> = [];
const calls: Recorded[] = [];

function nextResult(): { data?: any; error?: any } {
  return results.shift() ?? { data: null, error: null };
}

function makeBuilder(table: string) {
  const rec: Recorded = { table, eqs: {} };
  calls.push(rec);
  const builder: any = {
    select(cols: string) {
      rec.select = cols;
      return builder;
    },
    insert(payload: any) {
      rec.op = "insert";
      rec.payload = payload;
      return builder;
    },
    update(payload: any) {
      rec.op = "update";
      rec.payload = payload;
      return builder;
    },
    eq(col: string, val: any) {
      rec.eqs[col] = val;
      return builder;
    },
    in(col: string, vals: any[]) {
      rec.op = rec.op ?? "in";
      rec.inCol = col;
      rec.inVals = vals;
      return builder;
    },
    limit() {
      return builder;
    },
    order() {
      return builder;
    },
    maybeSingle() {
      return Promise.resolve(nextResult());
    },
    then(resolve: any, reject: any) {
      return Promise.resolve(nextResult()).then(resolve, reject);
    },
  };
  return builder;
}

vi.mock("../db/supabase", () => ({
  supabase: { from: (table: string) => makeBuilder(table) },
}));
vi.mock("../db/remoteConfig", () => ({ BOT_ID: "bot-1" }));
vi.mock("../logger", () => ({
  logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
}));

import {
  findOrCreateVelocifyCampaign,
  getKnownCampaignContactPhones,
  getKnownConversationPhones,
  insertPendingContacts,
  updateVelocifyLastSyncedAt,
  VELOCIFY_CAMPAIGN_NAME,
} from "./velocifyQueries";

beforeEach(() => {
  results.length = 0;
  calls.length = 0;
});

describe("getKnownCampaignContactPhones", () => {
  it("returns [] set for no input without querying", async () => {
    const set = await getKnownCampaignContactPhones([]);
    expect(set.size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("batches lookups in chunks and unions the found phones", async () => {
    results.push({ data: [{ phone_number: "+15550000001" }] });
    results.push({ data: [{ phone_number: "+15550000003" }] });
    const phones = ["+15550000001", "+15550000002", "+15550000003"];
    const set = await getKnownCampaignContactPhones(phones, 2); // chunk size 2 → two queries
    expect(calls).toHaveLength(2);
    expect(calls[0].table).toBe("campaign_contacts");
    expect(calls[0].inVals).toEqual(["+15550000001", "+15550000002"]);
    expect(calls[1].inVals).toEqual(["+15550000003"]);
    expect([...set].sort()).toEqual(["+15550000001", "+15550000003"]);
  });

  it("treats a chunk error as none-known (failure-tolerant)", async () => {
    results.push({ error: { message: "boom" } });
    const set = await getKnownCampaignContactPhones(["+15550000001"]);
    expect(set.size).toBe(0);
  });
});

describe("getKnownConversationPhones", () => {
  it("queries text_conversations and returns the found phones", async () => {
    results.push({ data: [{ phone_number: "+15550000009" }] });
    const set = await getKnownConversationPhones(["+15550000009"]);
    expect(calls[0].table).toBe("text_conversations");
    expect(set.has("+15550000009")).toBe(true);
  });
});

describe("findOrCreateVelocifyCampaign", () => {
  it("returns the existing campaign and updates pace when it changed", async () => {
    results.push({
      data: { id: "c1", pace_per_hour: 50, status: "running", name: VELOCIFY_CAMPAIGN_NAME },
    }); // select
    results.push({ data: null, error: null }); // pace update
    const row = await findOrCreateVelocifyCampaign(100);
    expect(row?.id).toBe("c1");
    expect(row?.pace_per_hour).toBe(100);
    // Second call is the pace update on campaigns; status already running → untouched.
    expect(calls[1].op).toBe("update");
    expect(calls[1].payload).toEqual({ pace_per_hour: 100 });
    expect(calls[1].eqs.id).toBe("c1");
    expect(calls[1].eqs.bot_id).toBe("bot-1");
  });

  it("does NOT update pace when it already matches", async () => {
    results.push({
      data: { id: "c1", pace_per_hour: 100, status: "running", name: VELOCIFY_CAMPAIGN_NAME },
    });
    const row = await findOrCreateVelocifyCampaign(100);
    expect(row?.pace_per_hour).toBe(100);
    expect(calls).toHaveLength(1); // only the select
  });

  it("re-activates a reused campaign the worker had auto-completed", async () => {
    results.push({
      data: { id: "c1", pace_per_hour: 100, status: "completed", name: VELOCIFY_CAMPAIGN_NAME },
    }); // select
    results.push({ data: null, error: null }); // status update
    const row = await findOrCreateVelocifyCampaign(100);
    expect(row?.status).toBe("running");
    // Pace matches, so only status is written — one scoped update.
    expect(calls[1].op).toBe("update");
    expect(calls[1].payload).toEqual({ status: "running" });
    expect(calls[1].eqs.id).toBe("c1");
    expect(calls[1].eqs.bot_id).toBe("bot-1");
  });

  it("folds a status reset and pace change into one update", async () => {
    results.push({
      data: { id: "c1", pace_per_hour: 50, status: "completed", name: VELOCIFY_CAMPAIGN_NAME },
    }); // select
    results.push({ data: null, error: null }); // combined update
    const row = await findOrCreateVelocifyCampaign(100);
    expect(row?.status).toBe("running");
    expect(row?.pace_per_hour).toBe(100);
    expect(calls).toHaveLength(2); // select + single update
    expect(calls[1].op).toBe("update");
    expect(calls[1].payload).toEqual({ pace_per_hour: 100, status: "running" });
  });

  it("leaves a reused running campaign untouched", async () => {
    results.push({
      data: { id: "c1", pace_per_hour: 100, status: "running", name: VELOCIFY_CAMPAIGN_NAME },
    });
    const row = await findOrCreateVelocifyCampaign(100);
    expect(row?.status).toBe("running");
    expect(calls).toHaveLength(1); // only the select — no status churn
  });

  it("creates a running text_outreach campaign when none exists", async () => {
    results.push({ data: null }); // select → not found
    results.push({ data: { id: "c-new", pace_per_hour: 100, name: VELOCIFY_CAMPAIGN_NAME } }); // insert
    const row = await findOrCreateVelocifyCampaign(100);
    expect(row?.id).toBe("c-new");
    expect(calls[0].eqs.campaign_type).toBe("text_outreach");
    expect(calls[0].eqs.name).toBe(VELOCIFY_CAMPAIGN_NAME);
    expect(calls[1].op).toBe("insert");
    expect(calls[1].payload).toMatchObject({
      campaign_type: "text_outreach",
      name: VELOCIFY_CAMPAIGN_NAME,
      status: "running",
      pace_per_hour: 100,
    });
  });

  it("returns null on a read error", async () => {
    results.push({ error: { message: "db down" } });
    expect(await findOrCreateVelocifyCampaign(100)).toBeNull();
  });
});

describe("insertPendingContacts", () => {
  it("inserts pending rows in chunks and returns the inserted count", async () => {
    results.push({ error: null }); // chunk 1
    results.push({ error: null }); // chunk 2
    const contacts = [
      { first_name: "A", phone_number: "+15550000001" },
      { first_name: "B", phone_number: "+15550000002" },
      { first_name: "C", phone_number: "+15550000003" },
    ];
    const inserted = await insertPendingContacts("camp-1", contacts, 2);
    expect(inserted).toBe(3);
    expect(calls).toHaveLength(2);
    expect(calls[0].op).toBe("insert");
    expect(calls[0].payload[0]).toMatchObject({
      campaign_id: "camp-1",
      bot_id: "bot-1",
      status: "pending",
      first_name: "A",
      phone_number: "+15550000001",
    });
  });

  it("skips a failed chunk but still counts the successful ones", async () => {
    results.push({ error: { message: "boom" } }); // chunk 1 fails
    results.push({ error: null }); // chunk 2 ok
    const contacts = [
      { first_name: "A", phone_number: "+15550000001" },
      { first_name: "B", phone_number: "+15550000002" },
    ];
    const inserted = await insertPendingContacts("camp-1", contacts, 1);
    expect(inserted).toBe(1);
  });

  it("no-ops for an empty list", async () => {
    expect(await insertPendingContacts("camp-1", [])).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe("updateVelocifyLastSyncedAt", () => {
  it("updates bot_config for this tenant", async () => {
    results.push({ error: null });
    await updateVelocifyLastSyncedAt("2026-07-23T12:00:00Z");
    expect(calls[0].table).toBe("bot_config");
    expect(calls[0].op).toBe("update");
    expect(calls[0].payload).toEqual({ velocify_last_synced_at: "2026-07-23T12:00:00Z" });
    expect(calls[0].eqs.bot_id).toBe("bot-1");
  });
});
