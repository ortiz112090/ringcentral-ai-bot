import type { LeadFieldRow } from "../db/queries";
import type { Carrier, LeadRecord } from "../db/types";

/**
 * Shared lead-capture logic used by BOTH the voice Realtime engine
 * (src/ai/realtimeEngine.ts) and the SMS text engine (src/sms/smsEngine.ts).
 *
 * Extracted verbatim from realtimeEngine.ts so the two channels validate and persist
 * captured lead data identically — same field-completion rules (address needs
 * street+city+zip, DOB full date, license 4-20 alphanumeric no dashes), same
 * dynamic capture_lead_info tool schema, and the same leads-table column mapping.
 * realtimeEngine.ts re-exports the public names so existing imports/tests are
 * unchanged.
 */

/** Lead columns that also live on the `leads` table (kept in sync via upsertLead). */
export const LEADS_TABLE_KEYS = [
  "first_name",
  "zip_code",
  "date_of_birth",
  "license_number",
  "license_state",
  "quote_amount_pif",
  "quote_amount_monthly",
  "carrier",
] as const;

/**
 * Fallback capture_lead_info tool used when the dynamic lead_fields lookup fails or
 * returns no rows — identical to the previous hardcoded schema so the capture flow
 * is never broken.
 */
export const FALLBACK_CAPTURE_LEAD_TOOL = {
  type: "function",
  name: "capture_lead_info",
  description:
    "Record any lead detail you learned this turn (name, ZIP, DOB, license number, quoted amounts, carrier). Call whenever you learn one.",
  parameters: {
    type: "object",
    properties: {
      first_name: { type: "string" },
      zip_code: { type: "string" },
      date_of_birth: { type: "string", description: "YYYY-MM-DD if known" },
      license_number: { type: "string" },
      license_state: {
        type: "string",
        description: "2-letter state that issued the license, e.g. CA",
      },
      quote_amount_pif: { type: "number" },
      quote_amount_monthly: { type: "number" },
      carrier: { type: "string", enum: ["progressive", "dairyland", "other"] },
    },
  },
} as const;

/**
 * Build the capture_lead_info tool's parameter schema from dashboard-configured
 * lead_fields. Field types map: text→string, number→number, date→string
 * (YYYY-MM-DD), choice→string enum. Each field's description is appended. Fields
 * are intentionally NOT marked JSON-schema-required — the model captures
 * opportunistically; `required` is only a dashboard/UI hint. Returns the fallback
 * hardcoded tool when no fields are provided.
 */
export function buildCaptureLeadTool(fields: LeadFieldRow[]): Record<string, unknown> {
  if (!fields || fields.length === 0) return { ...FALLBACK_CAPTURE_LEAD_TOOL };

  const properties: Record<string, Record<string, unknown>> = {};
  for (const field of fields) {
    if (!field.field_key) continue;
    const prop: Record<string, unknown> = {};
    switch (field.field_type) {
      case "number":
        prop.type = "number";
        break;
      case "date":
        prop.type = "string";
        prop.description = "YYYY-MM-DD";
        break;
      case "choice":
        prop.type = "string";
        if (Array.isArray(field.choices) && field.choices.length > 0) {
          prop.enum = field.choices;
        }
        break;
      case "text":
      default:
        prop.type = "string";
        break;
    }
    if (field.description && field.description.trim() !== "") {
      prop.description = prop.description
        ? `${prop.description} — ${field.description.trim()}`
        : field.description.trim();
    }
    properties[field.field_key] = prop;
  }

  return {
    type: "function",
    name: "capture_lead_info",
    description:
      "Record any lead detail you learned this turn. Call whenever you learn one.",
    parameters: { type: "object", properties },
  };
}

/** Outcome of validating a capture_lead_info payload against its lead_fields. */
export interface CapturedValidation {
  /** Keys that passed validation, with their (normalized) values — safe to persist. */
  valid: Record<string, unknown>;
  /** Keys that failed, mapped to a short human-readable reason. */
  invalid: Record<string, string>;
}

/** True when a field is a ZIP code by key or label ("ZIP" appears in the label). */
function isZipField(field: LeadFieldRow | undefined, key: string): boolean {
  if (key === "zip_code") return true;
  const label = typeof field?.label === "string" ? field.label.toLowerCase() : "";
  return label.includes("zip");
}

/** Lower-cased label for a field, or "" when absent. */
function labelOf(field: LeadFieldRow | undefined): string {
  return typeof field?.label === "string" ? field.label.toLowerCase() : "";
}

/** True for the caller's mailing address field (needs street + city + zip). */
function isAddressField(field: LeadFieldRow | undefined, key: string): boolean {
  return key === "address" || labelOf(field).includes("address");
}

/** True for a person-name field (first_name / last_name), by key or label. */
function isNameField(field: LeadFieldRow | undefined, key: string): boolean {
  return key === "first_name" || key === "last_name" || labelOf(field).includes("name");
}

/**
 * Validate a person's name: free text of letters, spaces, hyphens, and apostrophes
 * only. Rejects empty/whitespace and gibberish (anything with digits or other
 * punctuation, or no letters at all) — same bar as other text fields.
 */
function validateName(
  value: unknown
): { ok: true; value: unknown } | { ok: false; reason: string } {
  const raw = String(value).trim();
  if (raw === "") return { ok: false, reason: "name is required" };
  if (!/[a-zA-Z]/.test(raw) || !/^[a-zA-Z\s'-]+$/.test(raw)) {
    return { ok: false, reason: "must be a name (letters, spaces, hyphens, apostrophes)" };
  }
  return { ok: true, value };
}

/** True for the driver's-license NUMBER field. */
function isLicenseNumberField(field: LeadFieldRow | undefined, key: string): boolean {
  if (key === "license_number") return true;
  const label = labelOf(field);
  return label.includes("license") && (label.includes("number") || label.includes("#"));
}

/** True for the license-STATE companion field (2-letter state that issued the license). */
function isLicenseStateField(field: LeadFieldRow | undefined, key: string): boolean {
  if (key === "license_state") return true;
  const label = labelOf(field);
  return label.includes("license") && label.includes("state");
}

/** Recognized US states / territories: full name (lower-case) → 2-letter code. */
const US_STATE_NAME_TO_ABBR: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
  missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK",
  oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI",
  wyoming: "WY", "district of columbia": "DC",
};

/** Set of valid 2-letter US state / territory abbreviations. */
const US_STATE_ABBRS = new Set(Object.values(US_STATE_NAME_TO_ABBR));

/**
 * Validate a mailing address: it must contain a street number (a digit) AND a
 * 5-digit ZIP AND at least two alphabetic words (street name + city). Returns a
 * targeted rejection reason naming the missing piece so the model re-asks only for
 * that part — never the whole address. State is intentionally not required (derived
 * server-side from the zip later).
 */
function validateAddress(
  value: unknown
): { ok: true; value: unknown } | { ok: false; reason: string } {
  const raw = String(value).trim();
  if (!/\d/.test(raw)) {
    return { ok: false, reason: "address is missing the street number" };
  }
  if (!/\b\d{5}\b/.test(raw)) {
    return { ok: false, reason: "address is missing the 5-digit zip code" };
  }
  const words = raw.match(/[A-Za-z]{2,}/g) ?? [];
  if (words.length < 2) {
    return { ok: false, reason: "address is missing the city or street name" };
  }
  return { ok: true, value: raw };
}

/**
 * Validate a date of birth as a FULL calendar date (month, day, AND year). Partial
 * dates like "March 1990" (no day) are rejected with a reason naming the missing
 * part so the model asks only for that piece. Accepts month-name ("March 5, 1990")
 * and numeric-separated ("3/5/1990", "1990-03-05") shapes.
 */
function validateDateOfBirth(
  value: unknown
): { ok: true; value: unknown } | { ok: false; reason: string } {
  const raw = String(value).trim();
  if (raw === "") return { ok: false, reason: "date of birth is required" };

  const numericParts = raw.split(/[/.\-]/).map((p) => p.trim()).filter((p) => p !== "");
  const allNumeric = numericParts.length > 0 && numericParts.every((p) => /^\d+$/.test(p));
  if (allNumeric) {
    if (numericParts.length < 3) {
      return {
        ok: false,
        reason: "date of birth is incomplete — need the month, day, and year",
      };
    }
    if (Number.isNaN(Date.parse(raw))) {
      return { ok: false, reason: "date of birth is not a valid calendar date" };
    }
    return { ok: true, value: raw };
  }

  const hasMonthName = /jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/i.test(raw);
  const hasYear = /\b\d{4}\b/.test(raw);
  const hasDay = /\b\d{1,2}\b/.test(raw.replace(/\b\d{4}\b/g, ""));
  if (hasMonthName) {
    if (!hasYear) return { ok: false, reason: "date of birth is missing the year" };
    if (!hasDay) return { ok: false, reason: "date of birth is missing the day" };
    if (Number.isNaN(Date.parse(raw))) {
      return { ok: false, reason: "date of birth is not a valid calendar date" };
    }
    return { ok: true, value: raw };
  }

  return {
    ok: false,
    reason: "must be a full date of birth with month, day, and year",
  };
}

/**
 * Validate a driver's license number: strip incoming dashes/spaces (the bot must
 * never add them when saving/speaking), require alphanumeric only, and enforce a
 * plausible 4–20 char length so a single stray character is rejected. Returns the
 * stripped value to persist.
 */
function validateLicenseNumber(
  value: unknown
): { ok: true; value: unknown } | { ok: false; reason: string } {
  const stripped = String(value).replace(/[\s-]/g, "");
  if (!/^[A-Za-z0-9]+$/.test(stripped)) {
    return { ok: false, reason: "license number must contain only letters and digits" };
  }
  if (stripped.length < 4 || stripped.length > 20) {
    return { ok: false, reason: "license number looks incomplete" };
  }
  return { ok: true, value: stripped };
}

/**
 * Validate the license STATE: accept a 2-letter code or a full state name and
 * normalize to the uppercase 2-letter abbreviation ("california" → "CA"). Rejects
 * anything that isn't a recognizable US state.
 */
function validateLicenseState(
  value: unknown
): { ok: true; value: unknown } | { ok: false; reason: string } {
  const raw = String(value).trim().toLowerCase();
  if (raw === "") return { ok: false, reason: "license state is required" };
  if (US_STATE_NAME_TO_ABBR[raw]) {
    return { ok: true, value: US_STATE_NAME_TO_ABBR[raw] };
  }
  const upper = raw.toUpperCase();
  if (US_STATE_ABBRS.has(upper)) return { ok: true, value: upper };
  return { ok: false, reason: "must be a valid US state (e.g. CA or California)" };
}

/**
 * Validate ONE captured value against its lead_fields definition. Returns either the
 * normalized value to store or a rejection reason. The ZIP rule takes precedence over
 * field_type (a ZIP field may be typed text or number). Keys with no matching field
 * definition are treated as free-form text.
 */
function validateOne(
  field: LeadFieldRow | undefined,
  key: string,
  value: unknown
): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (value === undefined || value === null) {
    return { ok: false, reason: "no value provided" };
  }

  if (isZipField(field, key)) {
    const digits = (String(value).match(/\d/g) ?? []).length;
    return digits === 5
      ? { ok: true, value }
      : { ok: false, reason: "must be a 5-digit ZIP code" };
  }

  // Field-completion rules: reject partial answers with a targeted reason so the
  // model re-asks only for the missing piece. license_state is checked before
  // license_number so the "license" + "state" label can't fall into the number rule.
  if (isLicenseStateField(field, key)) return validateLicenseState(value);
  if (isLicenseNumberField(field, key)) return validateLicenseNumber(value);
  if (isAddressField(field, key)) return validateAddress(value);
  if (isNameField(field, key)) return validateName(value);

  const type = field?.field_type ?? "text";

  if (type === "number") {
    const cleaned = String(value).replace(/[$,]/g, "").trim();
    const n = Number(cleaned);
    return cleaned !== "" && Number.isFinite(n)
      ? { ok: true, value: n }
      : { ok: false, reason: "must be a number" };
  }

  if (type === "date" || key === "date_of_birth" || labelOf(field).includes("birth")) {
    return validateDateOfBirth(value);
  }

  if (type === "choice" && Array.isArray(field?.choices) && field!.choices!.length > 0) {
    const match = field!.choices!.find(
      (c) => String(c).toLowerCase() === String(value).trim().toLowerCase()
    );
    return match !== undefined
      ? { ok: true, value: match }
      : { ok: false, reason: `must be one of: ${field!.choices!.join(", ")}` };
  }

  // text (and choice with no configured choices, and unknown keys): reject empty /
  // whitespace-only, and values containing no letters or digits at all.
  const str = String(value).trim();
  if (str === "" || !/[a-zA-Z0-9]/.test(str)) {
    return { ok: false, reason: "must contain letters or digits" };
  }
  return { ok: true, value };
}

/**
 * Server-side validation of a capture_lead_info payload against the loaded lead_fields
 * definitions. Pure + exported for unit testing. Splits the submitted values into the
 * keys that passed (`valid`, with normalized values) and the keys that failed
 * (`invalid`, key → reason) so callers can merge ONLY the valid keys and re-ask the
 * model for the rest. See the spec's per-type rules (number/date/choice/zip/text).
 */
export function validateCapturedValues(
  fields: LeadFieldRow[],
  values: Record<string, unknown>
): CapturedValidation {
  const byKey = new Map<string, LeadFieldRow>();
  for (const f of fields ?? []) {
    if (f.field_key) byKey.set(f.field_key, f);
  }

  const valid: Record<string, unknown> = {};
  const invalid: Record<string, string> = {};
  for (const [key, value] of Object.entries(values ?? {})) {
    const result = validateOne(byKey.get(key), key, value);
    if (result.ok) valid[key] = result.value;
    else invalid[key] = result.reason;
  }
  return { valid, invalid };
}

/** Trim to a non-empty string, or undefined. */
export function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/** Finite number, or undefined. */
export function num(v: unknown): number | undefined {
  return typeof v === "number" && !Number.isNaN(v) ? v : undefined;
}

/** The `leads`-table column subset built from a validated capture payload. */
export interface LeadColumnUpdates {
  /** Only the leads-table columns present in the capture, coerced to their DB types. */
  updates: Partial<LeadRecord>;
  /** True when at least one leads-table column was captured (so a lead upsert is worth doing). */
  hasLeadColumns: boolean;
}

/**
 * Map a validated capture payload to the leads-table column subset (shared by the
 * voice and SMS paths so both keep the `leads` row in sync identically). Custom /
 * dashboard-only keys are ignored here — they live in captured_data only.
 */
export function buildLeadColumnUpdates(valid: Record<string, unknown>): LeadColumnUpdates {
  const hasLeadColumns = LEADS_TABLE_KEYS.some((k) => valid[k] !== undefined);
  const carrier =
    typeof valid.carrier === "string" &&
    ["progressive", "dairyland", "other"].includes(valid.carrier)
      ? (valid.carrier as Carrier)
      : undefined;

  const updates: Partial<LeadRecord> = {
    first_name: str(valid.first_name),
    zip_code: str(valid.zip_code),
    date_of_birth: str(valid.date_of_birth),
    license_number: str(valid.license_number),
    license_state: str(valid.license_state),
    quote_amount_pif: num(valid.quote_amount_pif),
    quote_amount_monthly: num(valid.quote_amount_monthly),
    carrier,
  };
  return { updates, hasLeadColumns };
}
