import { describe, it, expect } from "vitest";
import {
  buildLeadColumnUpdates,
  validateCapturedValues,
  LEADS_TABLE_KEYS,
} from "./capture";

/**
 * The validators are exercised in depth via the voice engine's tests
 * (realtimeEngine.test.ts) since they were extracted verbatim from there. These
 * tests lock the SHARED-MODULE surface the SMS path depends on: the same
 * validation behavior and the leads-column mapping (buildLeadColumnUpdates).
 */

describe("shared capture module — validator reuse", () => {
  it("enforces the same field-completion rules the voice path uses", () => {
    const fields: any[] = [];
    expect(validateCapturedValues(fields, { zip_code: "90210" }).valid.zip_code).toBe("90210");
    expect(validateCapturedValues(fields, { zip_code: "9021" }).invalid.zip_code).toMatch(/5-digit/);
    expect(validateCapturedValues(fields, { date_of_birth: "March 1990" }).invalid.date_of_birth).toMatch(/day/i);
    // license number: dashes/spaces stripped, alphanumeric, 4–20 chars.
    expect(validateCapturedValues(fields, { license_number: "D123-4567 89" }).valid.license_number).toBe("D123456789");
    expect(validateCapturedValues(fields, { license_number: "D" }).invalid.license_number).toMatch(/incomplete/i);
    // license state normalized to 2-letter upper.
    expect(validateCapturedValues(fields, { license_state: "california" }).valid.license_state).toBe("CA");
  });

  it("validates and normalizes email (lowercase + trim)", () => {
    const fields: any[] = [];
    expect(validateCapturedValues(fields, { email: "  Sam@Example.COM " }).valid.email).toBe(
      "sam@example.com"
    );
    expect(validateCapturedValues(fields, { email: "not-an-email" }).invalid.email).toMatch(
      /invalid email address/i
    );
    expect(validateCapturedValues(fields, { email: "a@b" }).invalid.email).toMatch(
      /invalid email address/i
    );
    // A field labeled "Email" (custom key) is treated as an email too.
    const labeled: any[] = [{ field_key: "contact", label: "Email", field_type: "text" }];
    expect(validateCapturedValues(labeled, { contact: "X@Y.io" }).valid.contact).toBe("x@y.io");
  });

  it("requires a non-empty start_timeline", () => {
    const fields: any[] = [];
    expect(validateCapturedValues(fields, { start_timeline: "ASAP" }).valid.start_timeline).toBe(
      "ASAP"
    );
    expect(
      validateCapturedValues(fields, { start_timeline: "   " }).invalid.start_timeline
    ).toMatch(/required/i);
  });
});

describe("buildLeadColumnUpdates", () => {
  it("maps only leads-table columns and coerces carrier/numbers", () => {
    const { updates, hasLeadColumns } = buildLeadColumnUpdates({
      first_name: "Sam",
      zip_code: "90210",
      quote_amount_pif: 1200,
      carrier: "progressive",
      some_custom_key: "ignored",
    });
    expect(hasLeadColumns).toBe(true);
    expect(updates.first_name).toBe("Sam");
    expect(updates.zip_code).toBe("90210");
    expect(updates.quote_amount_pif).toBe(1200);
    expect(updates.carrier).toBe("progressive");
    expect((updates as Record<string, unknown>).some_custom_key).toBeUndefined();
  });

  it("drops an unrecognized carrier and reports no lead columns for custom-only payloads", () => {
    expect(buildLeadColumnUpdates({ carrier: "geico" }).updates.carrier).toBeUndefined();
    const res = buildLeadColumnUpdates({ note: "call me later" });
    expect(res.hasLeadColumns).toBe(false);
  });

  it("maps the new contact columns (address, email, start_timeline) onto the leads row", () => {
    const { updates, hasLeadColumns } = buildLeadColumnUpdates({
      address: "123 Main St, Springfield, 90210",
      email: "sam@example.com",
      start_timeline: "this week",
    });
    expect(hasLeadColumns).toBe(true);
    expect(updates.address).toBe("123 Main St, Springfield, 90210");
    expect(updates.email).toBe("sam@example.com");
    expect(updates.start_timeline).toBe("this week");
  });

  it("exposes the leads-table key set shared by both channels", () => {
    expect(LEADS_TABLE_KEYS).toContain("first_name");
    expect(LEADS_TABLE_KEYS).toContain("license_state");
    expect(LEADS_TABLE_KEYS).toContain("address");
    expect(LEADS_TABLE_KEYS).toContain("email");
    expect(LEADS_TABLE_KEYS).toContain("start_timeline");
  });
});
