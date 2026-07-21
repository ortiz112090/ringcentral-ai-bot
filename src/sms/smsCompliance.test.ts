import { describe, it, expect } from "vitest";
import {
  buildHelpReply,
  classifyInboundKeyword,
  isWithinTextingWindow,
  OPT_OUT_SUFFIX,
} from "./smsCompliance";

describe("classifyInboundKeyword", () => {
  it("detects STOP-family keywords exactly (case/space-insensitive)", () => {
    for (const kw of ["STOP", "stop", "  Stop ", "unsubscribe", "QUIT", "cancel", "end", "stopall"]) {
      expect(classifyInboundKeyword(kw)).toBe("stop");
    }
  });

  it("detects HELP-family keywords", () => {
    expect(classifyInboundKeyword("HELP")).toBe("help");
    expect(classifyInboundKeyword(" info ")).toBe("help");
  });

  it("treats ordinary sentences as normal messages (not keywords)", () => {
    expect(classifyInboundKeyword("please help me pick a plan")).toBeNull();
    expect(classifyInboundKeyword("can you stop by tomorrow?")).toBeNull();
    expect(classifyInboundKeyword("my zip is 90210")).toBeNull();
    expect(classifyInboundKeyword("")).toBeNull();
  });
});

describe("isWithinTextingWindow (quiet hours 8am–9pm)", () => {
  it("allows sends inside the window and blocks outside (UTC)", () => {
    expect(isWithinTextingWindow(new Date("2026-07-21T08:00:00Z"), "UTC")).toBe(true);
    expect(isWithinTextingWindow(new Date("2026-07-21T12:00:00Z"), "UTC")).toBe(true);
    expect(isWithinTextingWindow(new Date("2026-07-21T20:59:00Z"), "UTC")).toBe(true);
    expect(isWithinTextingWindow(new Date("2026-07-21T21:00:00Z"), "UTC")).toBe(false); // 9pm exclusive
    expect(isWithinTextingWindow(new Date("2026-07-21T07:59:00Z"), "UTC")).toBe(false);
    expect(isWithinTextingWindow(new Date("2026-07-21T03:00:00Z"), "UTC")).toBe(false);
  });

  it("respects the configured timezone (America/Los_Angeles, July=PDT)", () => {
    // 15:00Z = 08:00 PDT → inside; 13:00Z = 06:00 PDT → outside.
    expect(isWithinTextingWindow(new Date("2026-07-21T15:00:00Z"), "America/Los_Angeles")).toBe(true);
    expect(isWithinTextingWindow(new Date("2026-07-21T13:00:00Z"), "America/Los_Angeles")).toBe(false);
  });

  it("fails open (allows) on an invalid timezone rather than muting the bot", () => {
    expect(isWithinTextingWindow(new Date("2026-07-21T03:00:00Z"), "Not/AZone")).toBe(true);
  });
});

describe("buildHelpReply + OPT_OUT_SUFFIX", () => {
  it("identifies the business and mentions STOP", () => {
    const reply = buildHelpReply("Acme Insurance");
    expect(reply).toContain("Acme Insurance");
    expect(reply.toLowerCase()).toContain("stop");
  });
  it("exposes the mandatory opt-out suffix", () => {
    expect(OPT_OUT_SUFFIX.toLowerCase()).toContain("stop");
  });
});
