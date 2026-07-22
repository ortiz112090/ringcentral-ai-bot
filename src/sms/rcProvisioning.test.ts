import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Tenant config + RC client. resolveEffectiveConfig returns the slices the
// provisioner reads (text.rcSmsNumber, botRole); ringcentralSmsWebhookUrl yields
// the fixed public address.
const effectiveText: { rcSmsNumber: string | undefined } = { rcSmsNumber: "+15550002222" };
let mockRole = "texting";
const mockConfig = { rcSmsWebhookToken: "rc-token" };
const webhookUrl = { value: "https://bot.example.com/webhooks/ringcentral/sms" };
vi.mock("../config", () => ({
  get config() {
    return mockConfig;
  },
  resolveEffectiveConfig: vi.fn(async () => ({ text: effectiveText, botRole: mockRole })),
  ringcentralSmsWebhookUrl: vi.fn(() => webhookUrl.value),
}));

const rcGet = vi.fn(async () => ({ records: [] as any[] }));
const rcPost = vi.fn(async () => ({ id: "sub-new", expirationTime: farFuture() }));
vi.mock("../ringcentral/client", () => ({
  rcGet: (...a: any[]) => rcGet(...a),
  rcPost: (...a: any[]) => rcPost(...a),
}));

vi.mock("../db/remoteConfig", () => ({ BOT_ID: "bot-test" }));

const warnSpy = vi.fn();
const errorSpy = vi.fn();
const infoSpy = vi.fn();
vi.mock("../logger", () => ({
  logger: {
    warn: (...a: any[]) => warnSpy(...a),
    error: (...a: any[]) => errorSpy(...a),
    info: (...a: any[]) => infoSpy(...a),
    debug: () => {},
  },
}));

import {
  provisionRcSmsSubscription,
  startRcSmsProvisioning,
  __stopRcSmsProvisioningForTests,
} from "./rcProvisioning";

function farFuture(): string {
  return new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString(); // +6 days
}
function soon(): string {
  return new Date(Date.now() + 60 * 60 * 1000).toISOString(); // +1h (<24h)
}

const OUR_ADDRESS = "https://bot.example.com/webhooks/ringcentral/sms";

beforeEach(() => {
  vi.clearAllMocks();
  effectiveText.rcSmsNumber = "+15550002222";
  mockRole = "texting";
  mockConfig.rcSmsWebhookToken = "rc-token";
  webhookUrl.value = OUR_ADDRESS;
  rcGet.mockResolvedValue({ records: [] });
  rcPost.mockResolvedValue({ id: "sub-new", expirationTime: farFuture() });
});

afterEach(() => {
  __stopRcSmsProvisioningForTests();
});

describe("provisionRcSmsSubscription — gates (benign skips, never errors)", () => {
  it("skips when PUBLIC_BASE_URL is unset (no webhook URL)", async () => {
    webhookUrl.value = "";
    await provisionRcSmsSubscription();
    expect(rcGet).not.toHaveBeenCalled();
    expect(rcPost).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("skips when RC_SMS_WEBHOOK_TOKEN is unset", async () => {
    mockConfig.rcSmsWebhookToken = "";
    await provisionRcSmsSubscription();
    expect(rcGet).not.toHaveBeenCalled();
    expect(rcPost).not.toHaveBeenCalled();
  });

  it("skips when the tenant role does not allow SMS", async () => {
    mockRole = "answer_calls";
    await provisionRcSmsSubscription();
    expect(rcGet).not.toHaveBeenCalled();
    expect(rcPost).not.toHaveBeenCalled();
  });

  it("skips when rc_sms_number is unset (RC texting opt-in)", async () => {
    effectiveText.rcSmsNumber = undefined;
    await provisionRcSmsSubscription();
    expect(rcGet).not.toHaveBeenCalled();
    expect(rcPost).not.toHaveBeenCalled();
  });
});

describe("provisionRcSmsSubscription — create / idempotence / renewal", () => {
  it("creates a subscription when none matches our address", async () => {
    rcGet.mockResolvedValue({ records: [] });
    await provisionRcSmsSubscription();
    expect(rcPost).toHaveBeenCalledTimes(1);
    const [endpoint, body] = rcPost.mock.calls[0];
    expect(endpoint).toBe("/restapi/v1.0/subscription");
    expect(body).toMatchObject({
      eventFilters: ["/restapi/v1.0/account/~/extension/~/message-store/instant?type=SMS"],
      deliveryMode: {
        transportType: "WebHook",
        address: OUR_ADDRESS,
        verificationToken: "rc-token",
      },
      expiresIn: 604799,
    });
  });

  it("is idempotent — an existing healthy subscription is left alone (no create/renew)", async () => {
    rcGet.mockResolvedValue({
      records: [
        {
          id: "sub-1",
          deliveryMode: { transportType: "WebHook", address: OUR_ADDRESS },
          expirationTime: farFuture(),
        },
      ],
    });
    await provisionRcSmsSubscription();
    expect(rcPost).not.toHaveBeenCalled();
  });

  it("renews an existing subscription that expires within 24h", async () => {
    rcGet.mockResolvedValue({
      records: [
        {
          id: "sub-1",
          deliveryMode: { transportType: "WebHook", address: OUR_ADDRESS },
          expirationTime: soon(),
        },
      ],
    });
    await provisionRcSmsSubscription();
    expect(rcPost).toHaveBeenCalledWith("/restapi/v1.0/subscription/sub-1/renew", {});
  });

  it("recreates when a renewal fails", async () => {
    rcGet.mockResolvedValue({
      records: [
        {
          id: "sub-1",
          deliveryMode: { transportType: "WebHook", address: OUR_ADDRESS },
          expirationTime: soon(),
        },
      ],
    });
    rcPost.mockRejectedValueOnce(new Error("gone")); // the renew call fails
    rcPost.mockResolvedValueOnce({ id: "sub-2", expirationTime: farFuture() }); // recreate
    await provisionRcSmsSubscription();
    expect(rcPost).toHaveBeenCalledWith("/restapi/v1.0/subscription/sub-1/renew", {});
    expect(rcPost).toHaveBeenLastCalledWith(
      "/restapi/v1.0/subscription",
      expect.objectContaining({ expiresIn: 604799 })
    );
  });

  it("ignores subscriptions belonging to a different delivery address", async () => {
    rcGet.mockResolvedValue({
      records: [
        {
          id: "other",
          deliveryMode: { transportType: "WebHook", address: "https://other.example.com/webhooks/ringcentral/sms" },
          expirationTime: farFuture(),
        },
      ],
    });
    await provisionRcSmsSubscription();
    // No match → creates our own; never renews the other tenant's subscription.
    expect(rcPost).toHaveBeenCalledWith(
      "/restapi/v1.0/subscription",
      expect.objectContaining({ deliveryMode: expect.objectContaining({ address: OUR_ADDRESS }) })
    );
  });

  it("never throws when the RC API rejects (list fails)", async () => {
    rcGet.mockRejectedValue(new Error("RC 500"));
    await expect(provisionRcSmsSubscription()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("provisioning failed"),
      expect.objectContaining({ error: "RC 500" })
    );
  });
});

describe("startRcSmsProvisioning", () => {
  it("runs an initial provision and installs a single unref'd poller", async () => {
    startRcSmsProvisioning();
    // The initial provision is fire-and-forget; let microtasks settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(rcGet).toHaveBeenCalled();
  });
});
