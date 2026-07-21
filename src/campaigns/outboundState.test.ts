import { describe, it, expect, beforeEach } from "vitest";
import {
  registerOutboundCall,
  isOutboundCall,
  getOutboundCall,
  takeOutboundCall,
  liveOutboundCount,
  pruneStaleOutboundCalls,
  clearOutboundCalls,
} from "./outboundState";

beforeEach(() => {
  clearOutboundCalls();
});

describe("outboundState registry", () => {
  it("registers a call and reports it live", () => {
    registerOutboundCall("CA1", 10, "camp-1");
    expect(isOutboundCall("CA1")).toBe(true);
    expect(liveOutboundCount()).toBe(1);
    const entry = getOutboundCall("CA1");
    expect(entry?.contactId).toBe(10);
    expect(entry?.campaignId).toBe("camp-1");
  });

  it("isOutboundCall / getOutboundCall are false/undefined for unknown SIDs", () => {
    expect(isOutboundCall("nope")).toBe(false);
    expect(getOutboundCall("nope")).toBeUndefined();
  });

  it("getOutboundCall does not remove the entry", () => {
    registerOutboundCall("CA1", 10, "camp-1");
    getOutboundCall("CA1");
    expect(liveOutboundCount()).toBe(1);
  });

  it("takeOutboundCall removes and returns the entry", () => {
    registerOutboundCall("CA1", 10, "camp-1");
    const entry = takeOutboundCall("CA1");
    expect(entry?.contactId).toBe(10);
    expect(isOutboundCall("CA1")).toBe(false);
    expect(liveOutboundCount()).toBe(0);
  });

  it("takeOutboundCall returns undefined for an unknown SID", () => {
    expect(takeOutboundCall("nope")).toBeUndefined();
  });

  it("counts multiple live calls", () => {
    registerOutboundCall("CA1", 1, "camp-1");
    registerOutboundCall("CA2", 2, "camp-1");
    expect(liveOutboundCount()).toBe(2);
  });

  it("clearOutboundCalls empties the registry", () => {
    registerOutboundCall("CA1", 1, "camp-1");
    clearOutboundCalls();
    expect(liveOutboundCount()).toBe(0);
  });
});

describe("pruneStaleOutboundCalls", () => {
  it("prunes only calls older than maxAgeMs and returns them", () => {
    const now = 1_000_000;
    registerOutboundCall("CA_old", 1, "camp-1");
    registerOutboundCall("CA_new", 2, "camp-1");
    // Backdate CA_old by mutating via re-register is not possible; use now offset.
    const old = getOutboundCall("CA_old")!;
    old.startedAtMs = now - 20_000;
    const fresh = getOutboundCall("CA_new")!;
    fresh.startedAtMs = now - 1_000;

    const pruned = pruneStaleOutboundCalls(10_000, now);
    expect(pruned.map((e) => e.callSid)).toEqual(["CA_old"]);
    expect(isOutboundCall("CA_old")).toBe(false);
    expect(isOutboundCall("CA_new")).toBe(true);
  });

  it("returns an empty array when nothing is stale", () => {
    const now = 1_000_000;
    registerOutboundCall("CA1", 1, "camp-1");
    getOutboundCall("CA1")!.startedAtMs = now - 1_000;
    expect(pruneStaleOutboundCalls(10_000, now)).toEqual([]);
    expect(liveOutboundCount()).toBe(1);
  });
});
