import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Tenant config + RC client. resolveEffectiveConfig returns the slices the
// provisioner reads (text.rcSmsNumber, botRole); ringcentralSmsWebhookUrl yields
// the fixed public address.
const effectiveText: {
  rcSmsNumber: string | undefined;
  rcSmsExtensionId: string | undefined;
} = { rcSmsNumber: "+15550002222", rcSmsExtensionId: undefined };
let mockRole = "texting";
const mockRingcentral: {
  clientId: string | undefined;
  clientSecret: string | undefined;
  jwt: string | undefined;
} = { clientId: "cid", clientSecret: "csecret", jwt: "jwt" };
const mockConfig = { rcSmsWebhookToken: "rc-token" };
const webhookUrl = { value: "https://bot.example.com/webhooks/ringcentral/sms" };
vi.mock("../config", () => ({
  get config() {
    return mockConfig;
  },
  resolveEffectiveConfig: vi.fn(async () => ({
    text: effectiveText,
    botRole: mockRole,
    ringcentral: mockRingcentral,
  })),
  ringcentralSmsWebhookUrl: vi.fn(() => webhookUrl.value),
}));

const rcGet = vi.fn(async () => ({ records: [] as any[] }));
const rcPost = vi.fn(async () => ({ id: "sub-new", expirationTime: farFuture() }));
const rcDelete = vi.fn(async () => undefined);
vi.mock("../ringcentral/client", async () => {
  const actual = await vi.importActual<typeof import("../ringcentral/client")>(
    "../ringcentral/client"
  );
  return {
    rcGet: (...a: any[]) => rcGet(...a),
    rcPost: (...a: any[]) => rcPost(...a),
    rcDelete: (...a: any[]) => rcDelete(...a),
    // Use the real helper so the wiring test exercises actual error-body extraction.
    extractRcErrorDetail: actual.extractRcErrorDetail,
  };
});

// The rc_sms_options read-model write is exercised as a spy; the DB layer itself
// (delete-then-insert) is covered in smsQueries.rcOptions.test.ts.
const replaceRcSmsOptions = vi.fn(async () => undefined);
vi.mock("./smsQueries", () => ({
  replaceRcSmsOptions: (...a: any[]) => replaceRcSmsOptions(...a),
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
  syncRcSmsOptions,
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
  effectiveText.rcSmsExtensionId = undefined;
  mockRole = "texting";
  mockRingcentral.clientId = "cid";
  mockRingcentral.clientSecret = "csecret";
  mockRingcentral.jwt = "jwt";
  mockConfig.rcSmsWebhookToken = "rc-token";
  webhookUrl.value = OUR_ADDRESS;
  rcGet.mockResolvedValue({ records: [] });
  rcPost.mockResolvedValue({ id: "sub-new", expirationTime: farFuture() });
  rcDelete.mockResolvedValue(undefined);
  replaceRcSmsOptions.mockResolvedValue(undefined);
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
        validationToken: "rc-token",
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

  it("logs the RC error body (errorCode + errors[]) when a create is rejected by RC", async () => {
    // Simulate the RC SDK ApiError: err.message is the terse top-level string while
    // the full diagnostic detail lives in the fetch-style .response JSON body. The
    // body is read via .clone() so any other caller's stream stays intact.
    const errorBody = {
      errorCode: "CMN-101",
      message: "Parameter [deliveryMode.verificationToken] value is invalid",
      errors: [
        {
          errorCode: "CMN-101",
          parameterName: "deliveryMode.verificationToken",
          message: "Value is invalid",
        },
      ],
    };
    const apiError: any = new Error(
      "Parameter [deliveryMode.verificationToken] value is invalid"
    );
    apiError.response = {
      status: 400,
      clone: () => ({ json: async () => errorBody }),
      json: async () => errorBody,
    };
    rcGet.mockResolvedValue({ records: [] }); // no existing sub → attempts a create
    rcPost.mockRejectedValue(apiError);

    await expect(provisionRcSmsSubscription()).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("provisioning failed"),
      expect.objectContaining({
        error: "Parameter [deliveryMode.verificationToken] value is invalid",
        errorCode: "CMN-101",
        errors: errorBody.errors,
      })
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

const AUTHED_EXT_FILTER =
  "/restapi/v1.0/account/~/extension/~/message-store/instant?type=SMS";
const CHOSEN_EXT_FILTER =
  "/restapi/v1.0/account/~/extension/4056789012/message-store/instant?type=SMS";

function existingSub(eventFilters: string[]) {
  return {
    id: "sub-1",
    deliveryMode: { transportType: "WebHook", address: OUR_ADDRESS },
    eventFilters,
    expirationTime: farFuture(),
  };
}

describe("provisionRcSmsSubscription — follows the chosen extension", () => {
  it("creates the subscription targeting the chosen extension's message-store", async () => {
    effectiveText.rcSmsExtensionId = "4056789012";
    rcGet.mockResolvedValue({ records: [] });
    await provisionRcSmsSubscription();
    expect(rcPost).toHaveBeenCalledWith(
      "/restapi/v1.0/subscription",
      expect.objectContaining({ eventFilters: [CHOSEN_EXT_FILTER] })
    );
  });

  it("recreates (delete + create) when an existing subscription targets a different extension", async () => {
    effectiveText.rcSmsExtensionId = "4056789012";
    rcGet.mockResolvedValue({ records: [existingSub([AUTHED_EXT_FILTER])] });
    await provisionRcSmsSubscription();
    expect(rcDelete).toHaveBeenCalledWith("/restapi/v1.0/subscription/sub-1");
    expect(rcPost).toHaveBeenCalledWith(
      "/restapi/v1.0/subscription",
      expect.objectContaining({ eventFilters: [CHOSEN_EXT_FILTER] })
    );
    // Recreate, not renew.
    expect(rcPost).not.toHaveBeenCalledWith(
      "/restapi/v1.0/subscription/sub-1/renew",
      expect.anything()
    );
  });

  it("leaves the subscription alone when it already targets the chosen extension", async () => {
    effectiveText.rcSmsExtensionId = "4056789012";
    rcGet.mockResolvedValue({ records: [existingSub([CHOSEN_EXT_FILTER])] });
    await provisionRcSmsSubscription();
    expect(rcDelete).not.toHaveBeenCalled();
    expect(rcPost).not.toHaveBeenCalled();
  });

  it("does not recreate a legacy (no eventFilters) subscription while still on the authenticated extension", async () => {
    // rcSmsExtensionId undefined → desired '~'; a sub with no parseable filter
    // defaults to '~', so it matches and is left healthy.
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
    expect(rcDelete).not.toHaveBeenCalled();
    expect(rcPost).not.toHaveBeenCalled();
  });
});

// Distinguish the RC read endpoints the options sync hits.
function routeRcGet(handlers: {
  extensionList?: () => any;
  accountPhones?: () => any;
  authedExtension?: () => any;
  authedExtensionPhones?: () => any;
}) {
  rcGet.mockImplementation(async (endpoint: string) => {
    if (endpoint.includes("/extension/~/phone-number")) {
      return handlers.authedExtensionPhones?.() ?? { records: [] };
    }
    if (endpoint.includes("/phone-number")) {
      return handlers.accountPhones?.() ?? { records: [] };
    }
    if (endpoint.includes("/extension?")) {
      return handlers.extensionList?.() ?? { records: [] };
    }
    if (endpoint === "/restapi/v1.0/account/~/extension/~") {
      return handlers.authedExtension?.() ?? {};
    }
    return { records: [] };
  });
}

function forbidden() {
  const err: any = new Error("Forbidden");
  err.response = { status: 403 };
  return err;
}

describe("syncRcSmsOptions", () => {
  it("account-level happy path: maps SMS-capable numbers to their extension and replaces the read-model", async () => {
    routeRcGet({
      extensionList: () => ({
        records: [
          { id: 301, name: "Sales", extensionNumber: "101" },
          { id: 302, name: "Support", extensionNumber: "102" },
        ],
      }),
      accountPhones: () => ({
        records: [
          {
            phoneNumber: "+15550000101",
            features: ["SmsSender", "MmsSender"],
            extension: { id: 301 },
          },
          {
            // Voice-only number: no SMS feature → excluded.
            phoneNumber: "+15550000900",
            features: ["CallerId"],
            extension: { id: 302 },
          },
          {
            phoneNumber: "+15550000102",
            features: ["MmsSender"],
            extension: { id: 302 },
          },
        ],
      }),
    });

    await syncRcSmsOptions();

    expect(replaceRcSmsOptions).toHaveBeenCalledTimes(1);
    const [options] = replaceRcSmsOptions.mock.calls[0] as any[];
    expect(options).toEqual([
      {
        extension_id: "301",
        extension_name: "Sales",
        extension_number: "101",
        phone_number: "+15550000101",
        sms_enabled: true,
      },
      {
        extension_id: "302",
        extension_name: "Support",
        extension_number: "102",
        phone_number: "+15550000102",
        sms_enabled: true,
      },
    ]);
  });

  it("403 fallback: syncs just the authenticated extension when the account-level read is forbidden", async () => {
    routeRcGet({
      extensionList: () => {
        throw forbidden();
      },
      authedExtension: () => ({ id: 500, name: "My Ext", extensionNumber: "499" }),
      authedExtensionPhones: () => ({
        records: [
          { phoneNumber: "+15550005000", features: ["SmsSender"] },
          { phoneNumber: "+15550005999", features: ["CallerId"] },
        ],
      }),
    });

    await syncRcSmsOptions();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("403"),
      expect.objectContaining({ botId: "bot-test" })
    );
    expect(replaceRcSmsOptions).toHaveBeenCalledTimes(1);
    const [options] = replaceRcSmsOptions.mock.calls[0] as any[];
    expect(options).toEqual([
      {
        extension_id: "500",
        extension_name: "My Ext",
        extension_number: "499",
        phone_number: "+15550005000",
        sms_enabled: true,
      },
    ]);
  });

  it("failed fetch (non-403) preserves old rows: never calls replaceRcSmsOptions", async () => {
    rcGet.mockRejectedValue(new Error("RC 500"));
    await expect(syncRcSmsOptions()).resolves.toBeUndefined();
    expect(replaceRcSmsOptions).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("options sync failed"),
      expect.objectContaining({ error: "RC 500" })
    );
  });

  it("skips (benign) when RingCentral credentials are not configured", async () => {
    mockRingcentral.jwt = undefined;
    await syncRcSmsOptions();
    expect(rcGet).not.toHaveBeenCalled();
    expect(replaceRcSmsOptions).not.toHaveBeenCalled();
  });
});
