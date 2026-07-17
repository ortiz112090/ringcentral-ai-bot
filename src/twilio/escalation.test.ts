import { describe, it, expect } from "vitest";
import { buildEscalationTwiml } from "./escalation";

describe("buildEscalationTwiml (live-call escalation redirect)", () => {
  it("dials the escalation number with the tenant's Twilio number as callerId", () => {
    const xml = buildEscalationTwiml("+15559999999", "+15550000001");
    expect(xml).toContain("<Dial");
    expect(xml).toContain('callerId="+15550000001"');
    expect(xml).toContain(">+15559999999</Dial>");
    expect(xml).not.toContain("<Hangup");
  });

  it("dials without a callerId when no Twilio number is available", () => {
    const xml = buildEscalationTwiml("+15559999999", undefined);
    expect(xml).toContain("<Dial>+15559999999</Dial>");
    expect(xml).not.toContain("callerId");
  });

  it("apologizes, offers a callback, and hangs up when no escalation number is set", () => {
    const xml = buildEscalationTwiml(undefined, "+15550000001");
    expect(xml).toContain("<Say>");
    expect(xml).toContain("call you back");
    expect(xml).toContain("<Hangup");
    expect(xml).not.toContain("<Dial");
  });

  it("treats a blank escalation number as unset", () => {
    const xml = buildEscalationTwiml("   ", "+15550000001");
    expect(xml).toContain("<Hangup");
    expect(xml).not.toContain("<Dial");
  });
});
