import { describe, it, expect, vi, beforeEach } from "vitest";

const mockConfig = { dcWebhookToken: "tok-123" };
vi.mock("../config", () => ({
  get config() {
    return mockConfig;
  },
}));
vi.mock("../db/remoteConfig", () => ({
  BOT_ID: "00000000-0000-0000-0000-000000000001",
}));

const findContactById = vi.fn(async (_id: number) => null as any);
const setContactStatus = vi.fn(async () => {});
vi.mock("./campaignQueries", () => ({
  findContactById: (...a: any[]) => findContactById(...a),
  setContactStatus: (...a: any[]) => setContactStatus(...a),
}));

import { handleDropcowboyStatus, mapDeliveryStatus } from "./rvmRoutes";

function fakeReq(opts: { query?: Record<string, unknown>; body?: Record<string, unknown> }) {
  return { query: opts.query ?? {}, body: opts.body ?? {} } as any;
}
function fakeRes() {
  const res: any = {
    statusCode: 0,
    jsonBody: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.jsonBody = payload;
      return this;
    },
  };
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConfig.dcWebhookToken = "tok-123";
  findContactById.mockResolvedValue(null);
});

describe("mapDeliveryStatus", () => {
  it("maps delivered-family statuses to completed", () => {
    for (const s of ["delivered", "Completed", "SUCCESS", "sent", "complete"]) {
      expect(mapDeliveryStatus(s)).toBe("completed");
    }
  });
  it("maps other non-empty statuses to failed", () => {
    expect(mapDeliveryStatus("undelivered")).toBe("failed");
    expect(mapDeliveryStatus("error")).toBe("failed");
  });
  it("returns null for a blank/absent status", () => {
    expect(mapDeliveryStatus("")).toBeNull();
    expect(mapDeliveryStatus(undefined)).toBeNull();
    expect(mapDeliveryStatus(null)).toBeNull();
  });
});

describe("handleDropcowboyStatus auth (fail closed)", () => {
  it("503 when DC_WEBHOOK_TOKEN is unset", async () => {
    mockConfig.dcWebhookToken = "";
    const res = fakeRes();
    await handleDropcowboyStatus(fakeReq({ query: { token: "tok-123" }, body: {} }), res);
    expect(res.statusCode).toBe(503);
    expect(setContactStatus).not.toHaveBeenCalled();
  });

  it("403 on a missing token", async () => {
    const res = fakeRes();
    await handleDropcowboyStatus(fakeReq({ body: { foreign_id: "1" } }), res);
    expect(res.statusCode).toBe(403);
    expect(setContactStatus).not.toHaveBeenCalled();
  });

  it("403 on a wrong token", async () => {
    const res = fakeRes();
    await handleDropcowboyStatus(fakeReq({ query: { token: "nope" }, body: { foreign_id: "1" } }), res);
    expect(res.statusCode).toBe(403);
    expect(setContactStatus).not.toHaveBeenCalled();
  });
});

describe("handleDropcowboyStatus mapping", () => {
  const auth = { token: "tok-123" };

  it("unknown foreign_id → 200 no-op (no status write)", async () => {
    findContactById.mockResolvedValueOnce(null);
    const res = fakeRes();
    await handleDropcowboyStatus(fakeReq({ query: auth, body: { foreign_id: "999", status: "delivered" } }), res);
    expect(res.statusCode).toBe(200);
    expect(setContactStatus).not.toHaveBeenCalled();
  });

  it("missing foreign_id → 200 no-op", async () => {
    const res = fakeRes();
    await handleDropcowboyStatus(fakeReq({ query: auth, body: { status: "delivered" } }), res);
    expect(res.statusCode).toBe(200);
    expect(findContactById).not.toHaveBeenCalled();
    expect(setContactStatus).not.toHaveBeenCalled();
  });

  it("known contact + delivered → completed with outcome", async () => {
    findContactById.mockResolvedValueOnce({ id: 5 } as any);
    const res = fakeRes();
    await handleDropcowboyStatus(fakeReq({ query: auth, body: { foreign_id: "5", status: "delivered" } }), res);
    expect(res.statusCode).toBe(200);
    expect(setContactStatus).toHaveBeenCalledWith(5, "completed", "delivered");
  });

  it("known contact + failure status → failed", async () => {
    findContactById.mockResolvedValueOnce({ id: 6 } as any);
    const res = fakeRes();
    await handleDropcowboyStatus(fakeReq({ query: auth, body: { foreign_id: "6", status: "undelivered" } }), res);
    expect(setContactStatus).toHaveBeenCalledWith(6, "failed", "undelivered");
  });

  it("accepts delivery_status as an alias field", async () => {
    findContactById.mockResolvedValueOnce({ id: 8 } as any);
    const res = fakeRes();
    await handleDropcowboyStatus(fakeReq({ query: auth, body: { foreign_id: "8", delivery_status: "completed" } }), res);
    expect(setContactStatus).toHaveBeenCalledWith(8, "completed", "completed");
  });
});
