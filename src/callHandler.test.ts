import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the DB layer so no real Supabase I/O happens. finalizeCallRecord is the
// write we assert on; the rest are stubs the module (and conversationStore) import.
const finalizeCallRecord = vi.fn(async () => {});
const getWebhookDestination = vi.fn(async () => null as any);

vi.mock("./db/queries", () => ({
  finalizeCallRecord: (...a: any[]) => finalizeCallRecord(...a),
  createCallRecord: vi.fn(async () => {}),
  findLeadByPhone: vi.fn(async () => null),
  upsertLead: vi.fn(async () => {}),
  insertCallTranscriptTurn: vi.fn(async () => {}),
  getWebhookDestination: (...a: any[]) => getWebhookDestination(...a),
}));

import { createHmac } from "node:crypto";
import { wrapUpCall, onCallEnded, dispatchLeadWebhook, type LeadWebhookPayload } from "./callHandler";
import { createCallState, getCallState } from "./state/conversationStore";

beforeEach(() => {
  vi.clearAllMocks();
  getWebhookDestination.mockResolvedValue(null as any);
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

describe("dispatchLeadWebhook", () => {
  const payload: LeadWebhookPayload = {
    bot_id: "00000000-0000-0000-0000-000000000001",
    call_id: "c1",
    caller_number: "+15551234567",
    outcome: "closed_pif",
    started_at: "2026-07-20T10:00:00.000Z",
    ended_at: "2026-07-20T10:05:00.000Z",
    captured_data: { first_name: "Sam", start_timeline: "next week" },
  };

  it("does nothing when no webhook destination is configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    getWebhookDestination.mockResolvedValueOnce(null as any);

    await dispatchLeadWebhook(payload);

    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("POSTs the payload without a signature when no secret is set", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }) as any);
    vi.stubGlobal("fetch", fetchMock);
    getWebhookDestination.mockResolvedValueOnce({ url: "https://hook.example.com/lead" } as any);

    await dispatchLeadWebhook(payload);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, any];
    expect(url).toBe("https://hook.example.com/lead");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual(payload);
    expect(init.headers).not.toHaveProperty("X-Signature");
    vi.unstubAllGlobals();
  });

  it("signs the raw body with HMAC-SHA256 hex in X-Signature when a secret is set", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }) as any);
    vi.stubGlobal("fetch", fetchMock);
    const secret = "s3cr3t";
    getWebhookDestination.mockResolvedValueOnce({
      url: "https://hook.example.com/lead",
      secret,
    } as any);

    await dispatchLeadWebhook(payload);

    const [, init] = fetchMock.mock.calls[0] as [string, any];
    const expected = createHmac("sha256", secret).update(init.body).digest("hex");
    expect(init.headers["X-Signature"]).toBe(expected);
    vi.unstubAllGlobals();
  });

  it("never throws when the fetch fails (non-fatal)", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });
    vi.stubGlobal("fetch", fetchMock);
    getWebhookDestination.mockResolvedValueOnce({ url: "https://hook.example.com/lead" } as any);

    await expect(dispatchLeadWebhook(payload)).resolves.toBeUndefined();
    vi.unstubAllGlobals();
  });
});
