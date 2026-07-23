import { resolveEffectiveConfig } from "../config";
import { logger } from "../logger";
import { BOT_ID } from "../db/remoteConfig";
import {
  findOrCreateVelocifyCampaign,
  getKnownCampaignContactPhones,
  getKnownConversationPhones,
  insertPendingContacts,
  updateVelocifyLastSyncedAt,
  VELOCIFY_CAMPAIGN_NAME,
} from "./velocifyQueries";

/**
 * Velocify report sync → text-outreach pipeline.
 *
 * Pulls a Velocify report via the SOAP GetReportResults call, filters/dedupes the
 * rows into new (first_name, phone) contacts, and drops the survivors as PENDING
 * campaign_contacts on this tenant's auto-created 'Velocify Report Sync'
 * text_outreach campaign. The EXISTING text-outreach worker then paces the sends and
 * the inbound AI script handles replies — nothing here texts anyone directly.
 *
 * Shared by two triggers: the scheduled worker-tick piggyback and the manual
 * POST /v1/leads/:botId/velocify-sync route. runSync() NEVER throws — a fetch/parse
 * failure returns a failed-sync result so the worker tick can never be crashed by it.
 * Credentials and full request XML (which carries the password) are never logged.
 */

/** Default SOAP endpoint; overridable per tenant via credential key `endpoint`. */
export const VELOCIFY_DEFAULT_ENDPOINT =
  "https://service.prod.velocify.com/ClientService.asmx";

/** Velocify's SOAP 1.1 SOAPAction + XML namespace for GetReportResults. */
export const VELOCIFY_NAMESPACE = "https://service.leads360.com/";
export const VELOCIFY_SOAP_ACTION = "https://service.leads360.com/GetReportResults";

/** Hard cap on one report fetch so a hung endpoint can never stall the worker. */
const FETCH_TIMEOUT_MS = 30_000;

/** Insert/lookup batch size — keep Supabase `.in()` filters and inserts bounded. */
const CHUNK_SIZE = 200;

/** Per-bucket tally returned by a successful (or partial) sync. */
export interface SyncCounts {
  fetched: number;
  excluded_name: number;
  excluded_phone: number;
  duplicates: number;
  already_known: number;
  added: number;
}

/**
 * Outcome of a sync run. `accepted` is true only when the report was fetched and
 * processed; a gate miss or fetch/parse failure returns accepted:false with a
 * machine-readable reason (see SYNC_REASON).
 */
export interface SyncResult {
  accepted: boolean;
  reason?: string;
  counts?: SyncCounts;
}

/** Reason codes: gate misses fail "soft" (409); a fetch/parse failure is "hard" (502). */
export const SYNC_REASON = {
  disabled: "velocify_sync_disabled",
  noReportId: "no_report_id",
  missingCredentials: "missing_credentials",
  inFlight: "sync_in_flight",
  fetchFailed: "fetch_failed",
} as const;

/** True when `reason` is a gate miss (caller should answer 409 rather than 502). */
export function isGateReason(reason: string | undefined): boolean {
  return (
    reason === SYNC_REASON.disabled ||
    reason === SYNC_REASON.noReportId ||
    reason === SYNC_REASON.missingCredentials ||
    reason === SYNC_REASON.inFlight
  );
}

/** Escape the five XML-significant characters so credentials/ids can't break the body. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Build the SOAP 1.1 GetReportResults request body. Pure — no I/O, never logged.
 * `templateValues` MUST be present (even empty): omitting it makes Velocify's parser
 * fail (learned from prior work), so it is always emitted as an empty element.
 */
export function buildGetReportResultsBody(input: {
  username: string;
  password: string;
  reportId: string;
}): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
    "<soap:Body>" +
    `<GetReportResults xmlns="${VELOCIFY_NAMESPACE}">` +
    `<username>${escapeXml(input.username)}</username>` +
    `<password>${escapeXml(input.password)}</password>` +
    `<reportId>${escapeXml(input.reportId)}</reportId>` +
    "<templateValues></templateValues>" +
    "</GetReportResults>" +
    "</soap:Body>" +
    "</soap:Envelope>"
  );
}

/** Decode the XML entities our lenient parser may encounter in a cell value. */
function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, "&");
}

/**
 * Convert a spreadsheet column letter to a 0-based index (A→0, B→1, … D→3, F→5).
 * Multi-letter columns (AA→26) are supported. Returns -1 for a blank/invalid value.
 */
export function columnLetterToIndex(letter: string): number {
  const s = (letter ?? "").trim().toUpperCase();
  if (!/^[A-Z]+$/.test(s)) return -1;
  let idx = 0;
  for (const ch of s) idx = idx * 26 + (ch.charCodeAt(0) - 64);
  return idx - 1;
}

/**
 * Extract the ordered (tagName, value) child pairs from one <Result> block's inner
 * XML. Handles both open/close pairs (`<Tag>value</Tag>`) and self-closing empties
 * (`<Tag/>` → ""), preserving document order. Values are XML-decoded and trimmed.
 */
function extractResultChildren(inner: string): Array<[string, string]> {
  const childRe = /<(\w+)(?:\s[^>]*)?>([\s\S]*?)<\/\1>|<(\w+)\s*\/>/g;
  const pairs: Array<[string, string]> = [];
  let m: RegExpExecArray | null;
  while ((m = childRe.exec(inner)) !== null) {
    if (m[1] !== undefined) pairs.push([m[1], decodeXml(m[2] ?? "").trim()]);
    else if (m[3] !== undefined) pairs.push([m[3], ""]);
  }
  return pairs;
}

/**
 * Merge one row's ordered tag sequence into the running master column order. Each
 * row's tags are a subsequence of the report's full column order, so we walk the row
 * and, for any tag not yet in master, insert it right after its nearest preceding
 * known neighbor (or append at end when there is none). Mutates `master`.
 */
function mergeTagOrder(master: string[], seq: string[]): void {
  let anchor = -1; // index in master of the last tag we matched/inserted
  for (const tag of seq) {
    const idx = master.indexOf(tag);
    if (idx !== -1) {
      anchor = idx;
    } else if (anchor === -1) {
      master.push(tag);
      anchor = master.length - 1;
    } else {
      master.splice(anchor + 1, 0, tag);
      anchor += 1;
    }
  }
}

/**
 * Legacy fallback: extract ordered <Field> cells from each <Row> (any namespace
 * prefix), self-closing = empty. Kept as cheap insurance for the old response shape.
 */
function parseRowFieldRows(xml: string): string[][] {
  const rows: string[][] = [];
  const rowRe = /<(?:\w+:)?Row\b[^>]*>([\s\S]*?)<\/(?:\w+:)?Row>/gi;
  // A field is either a self-closing empty element or an open/close pair.
  const fieldRe = /<(?:\w+:)?Field\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?Field>)/gi;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(xml)) !== null) {
    const inner = rowMatch[1];
    const cells: string[] = [];
    let fieldMatch: RegExpExecArray | null;
    fieldRe.lastIndex = 0;
    while ((fieldMatch = fieldRe.exec(inner)) !== null) {
      cells.push(decodeXml(fieldMatch[1] ?? "").trim());
    }
    rows.push(cells);
  }
  return rows;
}

/**
 * Lenient parser for a GetReportResults response → array of fixed-length positional
 * string cells per row. The real payload nests <Result> rows under ReportResults, each
 * carrying NAMED child elements (DateAdded, Status, …) — and blank cells are OMITTED,
 * not self-closed, so naive positional extraction shifts columns. So we (1) pull each
 * <Result> block's ordered (tag,value) pairs, (2) merge the per-row tag sequences into
 * one master column order, then (3) emit every row at the master's length so column
 * letters map to element names consistently (A→DateAdded, D→FirstName, F→DayWorkPhone,
 * …), inserting "" for any tag a given row omitted. Falls back to the legacy <Row>/
 * <Field> shape when no <Result> blocks are present. Never throws — unrecognized → [].
 */
export function parseReportRows(xml: string): string[][] {
  if (typeof xml !== "string" || xml.trim() === "") return [];

  // Phase 1: extract each <Result> row as ordered (tag, value) pairs.
  const resultRe = /<(?:\w+:)?Result\b[^>]*>([\s\S]*?)<\/(?:\w+:)?Result>/gi;
  const rowPairs: Array<Array<[string, string]>> = [];
  let rm: RegExpExecArray | null;
  while ((rm = resultRe.exec(xml)) !== null) {
    rowPairs.push(extractResultChildren(rm[1]));
  }

  // No <Result> rows → legacy <Row>/<Field> shape (cheap insurance).
  if (rowPairs.length === 0) return parseRowFieldRows(xml);

  // Phase 2: build the master column order by merging per-row tag sequences,
  // seeding with the row that has the most distinct tags so the common case
  // (a full row) yields the complete order in one pass.
  const seqs = rowPairs.map((pairs) => pairs.map(([tag]) => tag));
  const distinct = (s: string[]) => new Set(s).size;
  const master: string[] = [];
  for (const seq of [...seqs].sort((a, b) => distinct(b) - distinct(a))) {
    mergeTagOrder(master, seq);
  }

  // Phase 3: emit fixed-length positional rows (missing tag → "").
  const rows = rowPairs.map((pairs) => {
    const byTag = new Map(pairs);
    return master.map((tag) => byTag.get(tag) ?? "");
  });

  // Column NAMES only (never cell values) — aids future column-letter configuration.
  logger.info("Velocify report parsed", { botId: BOT_ID, columns: master });
  return rows;
}

/**
 * Normalize a raw phone to E.164 (+1XXXXXXXXXX). 10 digits → assume US; 11 digits
 * starting with 1 → US with country code; anything else → null (invalid). Pure.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** True when the string contains at least one digit (used for header-row detection). */
function hasDigits(value: string | undefined): boolean {
  return typeof value === "string" && /\d/.test(value);
}

/**
 * POST the SOAP request and return the parsed rows. Never throws: a transport error,
 * non-2xx status, or timeout resolves to { ok:false }. Only the numeric HTTP status
 * is logged — never the body or the request XML (which carries the password).
 */
export async function fetchReportRows(input: {
  endpoint: string;
  username: string;
  password: string;
  reportId: string;
  timeoutMs?: number;
}): Promise<{ ok: boolean; rows: string[][]; status: number }> {
  const body = buildGetReportResultsBody({
    username: input.username,
    password: input.password,
    reportId: input.reportId,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(input.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        SOAPAction: VELOCIFY_SOAP_ACTION,
      },
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      logger.error("Velocify report fetch returned non-2xx", { status: res.status });
      return { ok: false, rows: [], status: res.status };
    }
    const text = await res.text().catch(() => "");
    return { ok: true, rows: parseReportRows(text), status: res.status };
  } catch (err) {
    logger.error("Velocify report fetch failed (transport/timeout)", {
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, rows: [], status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/** A row that survived name/phone filtering, keyed for dedupe by its normalized phone. */
interface Survivor {
  firstName: string | null;
  phone: string;
}

/**
 * Pure filtering + in-report dedupe. Skips a leading header row (first row whose phone
 * cell has no digits), then buckets each row: blank/excluded first name →
 * excluded_name; blank/invalid phone → excluded_phone; an in-report repeat of a
 * normalized phone → duplicates (first occurrence wins). Returns the survivors and the
 * running counts (fetched/already_known/added filled in by the caller).
 */
export function filterAndDedupe(
  rows: string[][],
  opts: { firstNameIndex: number; phoneIndex: number; excludedFirstNames: string[] }
): { survivors: Survivor[]; counts: Omit<SyncCounts, "fetched" | "already_known" | "added"> } {
  // Normalize excluded names by trimming, lower-casing, and collapsing internal
  // whitespace so "  INBOUND   Call " matches "inbound call".
  const normalizeName = (n: string) => n.trim().toLowerCase().replace(/\s+/g, " ");
  const excluded = new Set(opts.excludedFirstNames.map(normalizeName));
  const counts = { excluded_name: 0, excluded_phone: 0, duplicates: 0 };
  const seen = new Set<string>();
  const survivors: Survivor[] = [];

  let data = rows;
  // Header-row skip: drop the first row when its phone cell carries no digits.
  if (data.length > 0 && !hasDigits(data[0][opts.phoneIndex])) {
    data = data.slice(1);
  }

  for (const row of data) {
    const rawName = (row[opts.firstNameIndex] ?? "").trim();
    if (rawName === "" || excluded.has(normalizeName(rawName))) {
      counts.excluded_name += 1;
      continue;
    }
    const phone = normalizePhone(row[opts.phoneIndex]);
    if (!phone) {
      counts.excluded_phone += 1;
      continue;
    }
    if (seen.has(phone)) {
      counts.duplicates += 1;
      continue;
    }
    seen.add(phone);
    survivors.push({ firstName: rawName, phone });
  }
  return { survivors, counts };
}

/** In-flight guard so overlapping ticks / a concurrent manual call can't double-sync. */
let syncInFlight = false;

/** Test-only: reset the in-flight guard between cases. */
export function __resetVelocifyInFlightForTests(): void {
  syncInFlight = false;
}

/**
 * True when a scheduled sync is DUE: the feature is enabled, a report id is set, and
 * either no sync has ever run or the last one is older than the configured interval.
 * Pure/null-tolerant so the worker can call it with a possibly-absent velocify section.
 */
export function isVelocifySyncDue(
  velocify:
    | {
        enabled: boolean;
        reportId: string | undefined;
        syncIntervalMinutes: number;
        lastSyncedAt: string | undefined;
      }
    | undefined,
  now: Date = new Date()
): boolean {
  if (!velocify || !velocify.enabled) return false;
  if (!velocify.reportId || velocify.reportId.trim() === "") return false;
  if (!velocify.lastSyncedAt) return true;
  const last = new Date(velocify.lastSyncedAt).getTime();
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last >= velocify.syncIntervalMinutes * 60_000;
}

/**
 * Run one full sync (shared by both triggers). Resolves fresh effective config,
 * enforces the gates (enabled / report id / credentials), fetches+parses the report,
 * filters+dedupes, drops phones already known to this bot (any campaign_contact or any
 * conversation), find-or-creates the campaign, inserts the survivors as pending
 * contacts, and stamps velocify_last_synced_at. Ignores the interval (the scheduled
 * caller checks that separately). Never throws.
 */
export async function runSync(now: Date = new Date()): Promise<SyncResult> {
  if (syncInFlight) {
    logger.info("Velocify sync skipped: a sync is already in flight", { botId: BOT_ID });
    return { accepted: false, reason: SYNC_REASON.inFlight };
  }
  syncInFlight = true;
  try {
    const { velocify } = await resolveEffectiveConfig();

    // 1. Gates.
    if (!velocify.enabled) {
      logger.info("Velocify sync skipped: disabled for tenant", { botId: BOT_ID });
      return { accepted: false, reason: SYNC_REASON.disabled };
    }
    const reportId = (velocify.reportId ?? "").trim();
    if (reportId === "") {
      logger.info("Velocify sync skipped: no report id configured", { botId: BOT_ID });
      return { accepted: false, reason: SYNC_REASON.noReportId };
    }
    if (!velocify.username || !velocify.password) {
      logger.warn("Velocify sync skipped: missing credentials", { botId: BOT_ID });
      return { accepted: false, reason: SYNC_REASON.missingCredentials };
    }

    // 2. Fetch + parse.
    const fetched = await fetchReportRows({
      endpoint: velocify.endpoint || VELOCIFY_DEFAULT_ENDPOINT,
      username: velocify.username,
      password: velocify.password,
      reportId,
    });
    if (!fetched.ok) {
      return { accepted: false, reason: SYNC_REASON.fetchFailed };
    }

    // 3-4. Filter + in-report dedupe.
    const firstNameIndex = columnLetterToIndex(velocify.firstNameColumn);
    const phoneIndex = columnLetterToIndex(velocify.phoneColumn);
    const { survivors, counts: filterCounts } = filterAndDedupe(fetched.rows, {
      firstNameIndex,
      phoneIndex,
      excludedFirstNames: velocify.excludedFirstNames,
    });

    // 5. Drop phones we've EVER contacted on this bot (any campaign_contact OR any
    //    conversation), batching both lookups in chunks so a big report stays cheap.
    const survivorPhones = survivors.map((s) => s.phone);
    const [knownContacts, knownConvos] = await Promise.all([
      getKnownCampaignContactPhones(survivorPhones, CHUNK_SIZE),
      getKnownConversationPhones(survivorPhones, CHUNK_SIZE),
    ]);
    const known = new Set<string>([...knownContacts, ...knownConvos]);
    let already_known = 0;
    const toInsert: Survivor[] = [];
    for (const s of survivors) {
      if (known.has(s.phone)) {
        already_known += 1;
        continue;
      }
      toInsert.push(s);
    }

    // 6. Find-or-create the campaign (updating pace when the setting changed) and
    //    insert the survivors as pending contacts in chunks.
    const campaign = await findOrCreateVelocifyCampaign(velocify.pacePerHour);
    let added = 0;
    if (campaign && toInsert.length > 0) {
      added = await insertPendingContacts(
        campaign.id,
        toInsert.map((s) => ({ first_name: s.firstName, phone_number: s.phone })),
        CHUNK_SIZE
      );
    } else if (!campaign) {
      logger.error("Velocify sync: could not find/create campaign; no contacts inserted", {
        botId: BOT_ID,
        campaignName: VELOCIFY_CAMPAIGN_NAME,
      });
    }

    // 7. Stamp last-synced state and return the tally.
    await updateVelocifyLastSyncedAt(now.toISOString());

    const counts: SyncCounts = {
      fetched: fetched.rows.length,
      excluded_name: filterCounts.excluded_name,
      excluded_phone: filterCounts.excluded_phone,
      duplicates: filterCounts.duplicates,
      already_known,
      added,
    };
    logger.info("Velocify sync complete", { botId: BOT_ID, ...counts });
    return { accepted: true, counts };
  } catch (err) {
    // Belt-and-suspenders: runSync must never throw into the worker tick.
    logger.error("Velocify sync failed unexpectedly", {
      botId: BOT_ID,
      error: err instanceof Error ? err.message : String(err),
    });
    return { accepted: false, reason: SYNC_REASON.fetchFailed };
  } finally {
    syncInFlight = false;
  }
}
