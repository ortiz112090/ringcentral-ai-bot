import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the DB layer so no real Supabase I/O happens. finalizeCallRecord is the
// write we assert on; the rest are stubs the module (and conversationStore) import.
const finalizeCallRecord = vi.fn(async () => {});

vi.mock("./db/queries", () => ({
  finalizeCallRecord: (...a: any[]) => finalizeCallRecord(...a),
  createCallRecord: vi.fn(async () => {}),
  findLeadByPhone: vi.fn(async () => null),
  upsertLead: vi.fn(async () => {}),
  insertCallTranscriptTurn: vi.fn(async () => {}),
}));

import { wrapUpCall, onCallEnded } from "./callHandler";
import { createCallState, getCallState } from "./state/conversationStore";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("wrapUpCall double-finalize dedupe", () => {
  it("removes in-memory state BEFORE awaiting the DB write", async () => {
    let resolveWrite: () => void = () => {};
    finalizeCallRecord.mockImplementationOnce(
      () => new Promise<void>((r) => (resolveWrite = r))
    );

    const state = createCallState("c1", "+15551234567", null);
    const pending = wrapUpCall(state, "escalated");

    // The state must already be gone even though the DB write hasn't resolved —
    // this is what makes a concurrent duplicate teardown find nothing.
    expect(getCallState("c1")).toBeUndefined();

    resolveWrite();
    await pending;
    expect(finalizeCallRecord).toHaveBeenCalledTimes(1);
  });

  it("a concurrent onCallEnded finds no state and does not double-write", async () => {
    const state = createCallState("c2", "+15551234567", null);

    // The realtime path finalizes as 'escalated' and clears the state.
    await wrapUpCall(state, "escalated");
    expect(finalizeCallRecord).toHaveBeenCalledTimes(1);
    expect(finalizeCallRecord).toHaveBeenCalledWith(
      "c2",
      expect.objectContaining({ outcome: "escalated" })
    );

    // The Twilio "stop" hangup path then runs — it must find no state and bail,
    // so 'abandoned' is never written.
    await onCallEnded("c2");
    expect(finalizeCallRecord).toHaveBeenCalledTimes(1);
    expect(finalizeCallRecord).not.toHaveBeenCalledWith(
      "c2",
      expect.objectContaining({ outcome: "abandoned" })
    );
  });

  it("onCallEnded on an unknown call is a no-op", async () => {
    await onCallEnded("does-not-exist");
    expect(finalizeCallRecord).not.toHaveBeenCalled();
  });
});
