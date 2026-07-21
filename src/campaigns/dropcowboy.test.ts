import { describe, it, expect } from "vitest";
import { buildRvmPayload, toDigits, DROPCOWBOY_RVM_URL } from "./dropcowboy";

const creds = { teamId: "team-1", secret: "sekret", brandId: "brand-9" };

describe("toDigits", () => {
  it("strips '+' and formatting, keeping the country code", () => {
    expect(toDigits("+1 (555) 123-4567")).toBe("15551234567");
    expect(toDigits("15551234567")).toBe("15551234567");
    expect(toDigits("")).toBe("");
  });
});

describe("buildRvmPayload (spec §3 request shape)", () => {
  const base = {
    credentials: creds,
    contactId: 42,
    phoneNumber: "+15551234567",
    recordingId: "rec-guid-123",
    forwardingNumber: "+15550000001",
    callbackUrl: "https://bot.example.com/webhooks/dropcowboy/status?token=abc",
  };

  it("maps every required field per Drop Cowboy's contract", () => {
    const p = buildRvmPayload(base);
    expect(p).toEqual({
      team_id: "team-1",
      secret: "sekret",
      brand_id: "brand-9",
      foreign_id: "42", // String(contact.id)
      phone_number: "15551234567", // E.164 digits, no '+'
      recording_id: "rec-guid-123",
      forwarding_number: "+15550000001",
      callback_url: "https://bot.example.com/webhooks/dropcowboy/status?token=abc",
    });
  });

  it("foreign_id is always the stringified contact id", () => {
    expect(buildRvmPayload({ ...base, contactId: 7 }).foreign_id).toBe("7");
  });

  it("omits forwarding_number/callback_url when blank rather than sending empty", () => {
    const p = buildRvmPayload({ ...base, forwardingNumber: "  ", callbackUrl: "" });
    expect(p).not.toHaveProperty("forwarding_number");
    expect(p).not.toHaveProperty("callback_url");
  });

  it("keeps a stable shape when credentials are missing (worker enforces presence)", () => {
    const p = buildRvmPayload({ ...base, credentials: { teamId: undefined, secret: undefined, brandId: undefined } });
    expect(p.team_id).toBe("");
    expect(p.secret).toBe("");
    expect(p.brand_id).toBe("");
  });

  it("targets the documented RVM endpoint", () => {
    expect(DROPCOWBOY_RVM_URL).toBe("https://api.dropcowboy.com/v1/rvm");
  });
});
