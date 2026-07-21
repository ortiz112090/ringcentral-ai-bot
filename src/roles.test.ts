import { describe, it, expect } from "vitest";
import { normalizeRole, roleAllows, DEFAULT_BOT_ROLE, type BotRole, type Feature } from "./roles";

describe("normalizeRole", () => {
  it("passes valid roles through (trim + lower-case)", () => {
    expect(normalizeRole("answer_calls")).toBe("answer_calls");
    expect(normalizeRole("  Outbound_Calls ")).toBe("outbound_calls");
    expect(normalizeRole("ANSWER_AND_FOLLOWUP")).toBe("answer_and_followup");
    expect(normalizeRole("texting")).toBe("texting");
  });

  it("falls back to the default on unknown/blank/non-string", () => {
    expect(normalizeRole("nonsense")).toBe(DEFAULT_BOT_ROLE);
    expect(normalizeRole("")).toBe(DEFAULT_BOT_ROLE);
    expect(normalizeRole(null)).toBe(DEFAULT_BOT_ROLE);
    expect(normalizeRole(undefined)).toBe(DEFAULT_BOT_ROLE);
    expect(normalizeRole(42 as unknown)).toBe(DEFAULT_BOT_ROLE);
    expect(DEFAULT_BOT_ROLE).toBe("answer_calls");
  });
});

describe("roleAllows matrix (spec §1)", () => {
  // Expected allow-set per feature.
  const matrix: Record<Feature, BotRole[]> = {
    voice_inbound: ["answer_calls", "outbound_calls", "answer_and_followup"],
    sms: ["texting"],
    campaign_calls: ["outbound_calls"],
    campaign_rvm: ["answer_and_followup"],
  };
  const allRoles: BotRole[] = [
    "answer_calls",
    "outbound_calls",
    "answer_and_followup",
    "texting",
  ];

  for (const feature of Object.keys(matrix) as Feature[]) {
    for (const role of allRoles) {
      const expected = matrix[feature].includes(role);
      it(`${role} ${expected ? "CAN" : "cannot"} ${feature}`, () => {
        expect(roleAllows(role, feature)).toBe(expected);
      });
    }
  }

  it("voice stays reachable for outbound/follow-up bots (callbacks)", () => {
    expect(roleAllows("outbound_calls", "voice_inbound")).toBe(true);
    expect(roleAllows("answer_and_followup", "voice_inbound")).toBe(true);
  });

  it("texting bots do not answer voice", () => {
    expect(roleAllows("texting", "voice_inbound")).toBe(false);
  });
});
