import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- Mutable effective config; the velocify section is flipped per test. ----
const cfg: any = {
  velocify: {
    enabled: true,
    reportId: "87",
    firstNameColumn: "D",
    phoneColumn: "F",
    excludedFirstNames: ["inbound call"],
    syncIntervalMinutes: 360,
    pacePerHour: 100,
    lastSyncedAt: undefined as string | undefined,
    username: "user",
    password: "pass",
    endpoint: undefined as string | undefined,
  },
};
vi.mock("../config", () => ({
  resolveEffectiveConfig: vi.fn(async () => cfg),
}));
vi.mock("../db/remoteConfig", () => ({
  BOT_ID: "00000000-0000-0000-0000-000000000001",
}));

const findOrCreateVelocifyCampaign = vi.fn(async (_pace: number) => ({
  id: "camp-velocify",
  bot_id: "00000000-0000-0000-0000-000000000001",
  name: "Velocify Report Sync",
  campaign_type: "text_outreach",
  status: "running",
  pace_per_hour: 100,
  dc_recording_id: null,
  send_delay_minutes: null,
}));
const getKnownCampaignContactPhones = vi.fn(async (_p: string[]) => new Set<string>());
const getKnownConversationPhones = vi.fn(async (_p: string[]) => new Set<string>());
const insertPendingContacts = vi.fn(async (_id: string, contacts: any[]) => contacts.length);
const updateVelocifyLastSyncedAt = vi.fn(async () => {});
vi.mock("./velocifyQueries", () => ({
  VELOCIFY_CAMPAIGN_NAME: "Velocify Report Sync",
  findOrCreateVelocifyCampaign: (...a: any[]) => findOrCreateVelocifyCampaign(...(a as [number])),
  getKnownCampaignContactPhones: (...a: any[]) => getKnownCampaignContactPhones(...(a as [string[]])),
  getKnownConversationPhones: (...a: any[]) => getKnownConversationPhones(...(a as [string[]])),
  insertPendingContacts: (...a: any[]) => insertPendingContacts(...(a as [string, any[]])),
  updateVelocifyLastSyncedAt: (...a: any[]) => updateVelocifyLastSyncedAt(...a),
}));

import {
  buildGetReportResultsBody,
  columnLetterToIndex,
  filterAndDedupe,
  fetchReportRows,
  isVelocifySyncDue,
  normalizePhone,
  parseReportRows,
  runSync,
  SYNC_REASON,
  VELOCIFY_DEFAULT_ENDPOINT,
  VELOCIFY_SOAP_ACTION,
  __resetVelocifyInFlightForTests,
} from "./velocifySync";

function resetCfg() {
  cfg.velocify = {
    enabled: true,
    reportId: "87",
    firstNameColumn: "D",
    phoneColumn: "F",
    excludedFirstNames: ["inbound call"],
    syncIntervalMinutes: 360,
    pacePerHour: 100,
    lastSyncedAt: undefined,
    username: "user",
    password: "pass",
    endpoint: undefined,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  __resetVelocifyInFlightForTests();
  resetCfg();
  findOrCreateVelocifyCampaign.mockResolvedValue({
    id: "camp-velocify",
    bot_id: "00000000-0000-0000-0000-000000000001",
    name: "Velocify Report Sync",
    campaign_type: "text_outreach",
    status: "running",
    pace_per_hour: 100,
    dc_recording_id: null,
    send_delay_minutes: null,
  });
  getKnownCampaignContactPhones.mockResolvedValue(new Set());
  getKnownConversationPhones.mockResolvedValue(new Set());
  insertPendingContacts.mockImplementation(async (_id: string, contacts: any[]) => contacts.length);
});

// ---- A realistic GetReportResults fixture. Uses a namespace-prefixed inner element
// and an escaped value to prove the lenient parser survives namespace quirks. The
// first row is a HEADER (its phone cell has no digits). Columns map positionally:
// D (index 3) = first name, F (index 5) = phone.
const FIXTURE_XML = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <GetReportResultsResponse xmlns="https://service.leads360.com/">
      <GetReportResultsResult>
        <rr:ReportResults xmlns:rr="https://service.leads360.com/">
          <rr:Row>
            <rr:Field>Id</rr:Field><rr:Field>A</rr:Field><rr:Field>B</rr:Field>
            <rr:Field>First Name</rr:Field><rr:Field>Last</rr:Field><rr:Field>Phone</rr:Field>
          </rr:Row>
          <rr:Row>
            <rr:Field>1</rr:Field><rr:Field>x</rr:Field><rr:Field>y</rr:Field>
            <rr:Field>Dana &amp; Co</rr:Field><rr:Field>Smith</rr:Field><rr:Field>(555) 123-4567</rr:Field>
          </rr:Row>
          <rr:Row>
            <rr:Field>2</rr:Field><rr:Field/><rr:Field/>
            <rr:Field>Inbound Call</rr:Field><rr:Field/><rr:Field>5551110000</rr:Field>
          </rr:Row>
        </rr:ReportResults>
      </GetReportResultsResult>
    </GetReportResultsResponse>
  </soap:Body>
</soap:Envelope>`;

describe("buildGetReportResultsBody (SOAP request shape)", () => {
  it("includes username, password, reportId AND an empty templateValues element", () => {
    const body = buildGetReportResultsBody({ username: "u", password: "p", reportId: "87" });
    expect(body).toContain("<username>u</username>");
    expect(body).toContain("<password>p</password>");
    expect(body).toContain("<reportId>87</reportId>");
    // templateValues MUST be present (empty) — omitting it breaks Velocify's parser.
    expect(body).toContain("<templateValues></templateValues>");
    expect(body).toContain('xmlns="https://service.leads360.com/"');
  });

  it("XML-escapes credential/report values so they can't break the envelope", () => {
    const body = buildGetReportResultsBody({
      username: "a&b",
      password: "p<q>",
      reportId: '8"7',
    });
    expect(body).toContain("<username>a&amp;b</username>");
    expect(body).toContain("<password>p&lt;q&gt;</password>");
    expect(body).toContain("<reportId>8&quot;7</reportId>");
  });
});

describe("columnLetterToIndex", () => {
  it("maps A→0, D→3, F→5 (case-insensitive, trimmed)", () => {
    expect(columnLetterToIndex("A")).toBe(0);
    expect(columnLetterToIndex("d")).toBe(3);
    expect(columnLetterToIndex(" F ")).toBe(5);
    expect(columnLetterToIndex("AA")).toBe(26);
  });
  it("returns -1 for a blank/invalid value", () => {
    expect(columnLetterToIndex("")).toBe(-1);
    expect(columnLetterToIndex("3")).toBe(-1);
  });
});

describe("parseReportRows (lenient, namespace-quirk tolerant)", () => {
  it("extracts positional cells per row, decoding entities and surviving namespace prefixes", () => {
    const rows = parseReportRows(FIXTURE_XML);
    expect(rows).toHaveLength(3);
    // Header row cells.
    expect(rows[0][3]).toBe("First Name");
    expect(rows[0][5]).toBe("Phone");
    // Data row: D(3)=first name with a decoded entity, F(5)=phone.
    expect(rows[1][3]).toBe("Dana & Co");
    expect(rows[1][5]).toBe("(555) 123-4567");
    // Self-closing empty <Field/> cells decode to "".
    expect(rows[2][1]).toBe("");
    expect(rows[2][3]).toBe("Inbound Call");
  });
  it("returns [] for empty/garbage input", () => {
    expect(parseReportRows("")).toEqual([]);
    expect(parseReportRows("<html>nope</html>")).toEqual([]);
  });
});

describe("normalizePhone", () => {
  it("normalizes 10-digit US numbers to +1XXXXXXXXXX", () => {
    expect(normalizePhone("(555) 123-4567")).toBe("+15551234567");
    expect(normalizePhone("5551234567")).toBe("+15551234567");
  });
  it("normalizes 11-digit numbers starting with 1", () => {
    expect(normalizePhone("1-555-123-4567")).toBe("+15551234567");
  });
  it("rejects blank / too-short / non-1 11-digit numbers", () => {
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone("12345")).toBeNull();
    expect(normalizePhone("25551234567")).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });
});

describe("filterAndDedupe", () => {
  const opts = { firstNameIndex: 3, phoneIndex: 5, excludedFirstNames: ["inbound call"] };

  it("skips the header row (phone cell has no digits) and buckets each row", () => {
    const rows = parseReportRows(FIXTURE_XML);
    const { survivors, counts } = filterAndDedupe(rows, opts);
    // Header skipped; 'Dana & Co' kept; 'Inbound Call' excluded by name.
    expect(survivors).toEqual([{ firstName: "Dana & Co", phone: "+15551234567" }]);
    expect(counts.excluded_name).toBe(1);
    expect(counts.excluded_phone).toBe(0);
    expect(counts.duplicates).toBe(0);
  });

  it("excludes blank names and honors a custom excluded list (case/space-insensitive)", () => {
    const rows = [
      ["", "", "", "  ", "", "5551110001"], // blank name
      ["", "", "", "  INBOUND   Call ", "", "5551110002"], // excluded, messy case/space
      ["", "", "", "VIP", "", "5551110003"], // custom-excluded below
      ["", "", "", "Keep", "", "5551110004"],
    ];
    const { survivors, counts } = filterAndDedupe(rows, {
      firstNameIndex: 3,
      phoneIndex: 5,
      excludedFirstNames: ["inbound call", "VIP"],
    });
    expect(survivors.map((s) => s.firstName)).toEqual(["Keep"]);
    expect(counts.excluded_name).toBe(3);
  });

  it("counts invalid phones as excluded_phone (after the name passes)", () => {
    const rows = [
      ["", "", "", "Good", "", "555123"], // invalid phone
      ["", "", "", "Fine", "", "5551234567"], // valid
    ];
    const { survivors, counts } = filterAndDedupe(rows, opts);
    expect(counts.excluded_phone).toBe(1);
    expect(survivors).toHaveLength(1);
  });

  it("dedupes within the report by normalized phone (first occurrence wins)", () => {
    const rows = [
      ["", "", "", "Header", "", "phone"], // header (no digits) → skipped
      ["", "", "", "First", "", "(555) 123-4567"],
      ["", "", "", "Second", "", "555-123-4567"], // same normalized phone
    ];
    const { survivors, counts } = filterAndDedupe(rows, opts);
    expect(survivors).toEqual([{ firstName: "First", phone: "+15551234567" }]);
    expect(counts.duplicates).toBe(1);
  });
});

describe("isVelocifySyncDue", () => {
  const now = new Date("2026-07-23T12:00:00Z");
  const base = { enabled: true, reportId: "87", syncIntervalMinutes: 360, lastSyncedAt: undefined as string | undefined };

  it("is due when never synced", () => {
    expect(isVelocifySyncDue(base, now)).toBe(true);
  });
  it("is due when the last sync is older than the interval", () => {
    expect(isVelocifySyncDue({ ...base, lastSyncedAt: "2026-07-23T05:00:00Z" }, now)).toBe(true);
  });
  it("is NOT due within the interval", () => {
    expect(isVelocifySyncDue({ ...base, lastSyncedAt: "2026-07-23T11:30:00Z" }, now)).toBe(false);
  });
  it("is NOT due when disabled / no report id / absent", () => {
    expect(isVelocifySyncDue({ ...base, enabled: false }, now)).toBe(false);
    expect(isVelocifySyncDue({ ...base, reportId: "" }, now)).toBe(false);
    expect(isVelocifySyncDue(undefined, now)).toBe(false);
  });
});

describe("fetchReportRows", () => {
  it("POSTs SOAP 1.1 with the correct Content-Type + SOAPAction and parses the body", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => FIXTURE_XML,
    }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await fetchReportRows({
      endpoint: VELOCIFY_DEFAULT_ENDPOINT,
      username: "u",
      password: "p",
      reportId: "87",
    });
    expect(out.ok).toBe(true);
    expect(out.rows).toHaveLength(3);
    const [url, init] = fetchMock.mock.calls[0] as [string, any];
    expect(url).toBe(VELOCIFY_DEFAULT_ENDPOINT);
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("text/xml; charset=utf-8");
    expect(init.headers.SOAPAction).toBe(VELOCIFY_SOAP_ACTION);
    expect(init.body).toContain("<reportId>87</reportId>");
  });

  it("returns ok:false on a non-2xx status (no throw)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, text: async () => "" })));
    const out = await fetchReportRows({ endpoint: "x", username: "u", password: "p", reportId: "87" });
    expect(out.ok).toBe(false);
    expect(out.rows).toEqual([]);
  });

  it("returns ok:false on a transport error (no throw)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down");
    }));
    const out = await fetchReportRows({ endpoint: "x", username: "u", password: "p", reportId: "87" });
    expect(out.ok).toBe(false);
  });
});

describe("runSync gates", () => {
  it("skips (disabled) without fetching", async () => {
    cfg.velocify.enabled = false;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await runSync();
    expect(res).toEqual({ accepted: false, reason: SYNC_REASON.disabled });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips (no report id)", async () => {
    cfg.velocify.reportId = undefined;
    const res = await runSync();
    expect(res.reason).toBe(SYNC_REASON.noReportId);
  });

  it("skips (missing credentials)", async () => {
    cfg.velocify.password = undefined;
    const res = await runSync();
    expect(res.reason).toBe(SYNC_REASON.missingCredentials);
  });

  it("returns fetch_failed (never throws) when the fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 502, text: async () => "" })));
    const res = await runSync();
    expect(res).toEqual({ accepted: false, reason: SYNC_REASON.fetchFailed });
    expect(insertPendingContacts).not.toHaveBeenCalled();
  });

  it("returns in_flight when a sync is already running", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await gate;
        return { ok: true, status: 200, text: async () => FIXTURE_XML };
      })
    );
    const first = runSync();
    const second = await runSync(); // second call while the first is mid-fetch
    expect(second.reason).toBe(SYNC_REASON.inFlight);
    release();
    await first;
  });
});

describe("runSync happy path (find-or-create + dedupe + insert)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, text: async () => FIXTURE_XML })));
  });

  it("inserts survivors, uses the configured pace, and stamps last-synced", async () => {
    const now = new Date("2026-07-23T12:00:00Z");
    const res = await runSync(now);
    expect(res.accepted).toBe(true);
    expect(res.counts).toEqual({
      fetched: 3,
      excluded_name: 1, // 'Inbound Call'
      excluded_phone: 0,
      duplicates: 0,
      already_known: 0,
      added: 1, // 'Dana & Co'
    });
    expect(findOrCreateVelocifyCampaign).toHaveBeenCalledWith(100);
    expect(insertPendingContacts).toHaveBeenCalledWith(
      "camp-velocify",
      [{ first_name: "Dana & Co", phone_number: "+15551234567" }],
      expect.any(Number)
    );
    expect(updateVelocifyLastSyncedAt).toHaveBeenCalledWith(now.toISOString());
  });

  it("drops a phone already known via campaign_contacts (already_known, not added)", async () => {
    getKnownCampaignContactPhones.mockResolvedValueOnce(new Set(["+15551234567"]));
    const res = await runSync();
    expect(res.counts?.already_known).toBe(1);
    expect(res.counts?.added).toBe(0);
    expect(insertPendingContacts).not.toHaveBeenCalled();
  });

  it("drops a phone already known via conversations (already_known, not added)", async () => {
    getKnownConversationPhones.mockResolvedValueOnce(new Set(["+15551234567"]));
    const res = await runSync();
    expect(res.counts?.already_known).toBe(1);
    expect(res.counts?.added).toBe(0);
  });

  it("does not insert when the campaign can't be found/created", async () => {
    findOrCreateVelocifyCampaign.mockResolvedValueOnce(null);
    const res = await runSync();
    expect(res.accepted).toBe(true);
    expect(res.counts?.added).toBe(0);
    expect(insertPendingContacts).not.toHaveBeenCalled();
  });
});
