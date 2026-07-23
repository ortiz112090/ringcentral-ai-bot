import { describe, it, expect, vi, beforeEach } from "vitest";

// Tunable effective-config; individual tests mutate `text`/`business`/`twilio`.
const text: any = {
  enabled: true,
  number: "+15550001111",
  model: "gpt-4o-mini",
  businessName: "Acme",
  missedCallEnabled: true,
  webLeadEnabled: true,
  timezone: "UTC",
};
const business = { agentName: "Alex", brokerageName: "Acme" };
const twilio: any = { escalationNumber: "+15559990000" };
vi.mock("../config", () => ({
  resolveEffectiveConfig: vi.fn(async () => ({ text, business, twilio })),
  config: { supabase: { url: "http://localhost", serviceRoleKey: "test" } },
}));

const isPhoneOptedOut = vi.fn(async () => false);
const createConversation = vi.fn(async () => ({ id: "conv-1", phone_number: "+15557778888", status: "active" }));
const findConversationByPhone = vi.fn(async () => null);
const insertTextMessage = vi.fn(async () => {});
const updateConversationStatus = vi.fn(async () => {});
const getConversationMessages = vi.fn(async () => []);
const getTextStages = vi.fn(async () => []);
const getActiveOutreachTemplates = vi.fn(async () => [] as any[]);
vi.mock("./smsQueries", () => ({
  isPhoneOptedOut: (...a: any[]) => isPhoneOptedOut(...a),
  createConversation: (...a: any[]) => createConversation(...a),
  findConversationByPhone: (...a: any[]) => findConversationByPhone(...a),
  insertTextMessage: (...a: any[]) => insertTextMessage(...a),
  updateConversationStatus: (...a: any[]) => updateConversationStatus(...a),
  getConversationMessages: (...a: any[]) => getConversationMessages(...a),
  getTextStages: (...a: any[]) => getTextStages(...a),
  getActiveOutreachTemplates: (...a: any[]) => getActiveOutreachTemplates(...a),
}));

const sendSms = vi.fn(async () => ({ sent: true }));
vi.mock("./smsSend", () => ({ sendSms: (...a: any[]) => sendSms(...a) }));

const runSmsTurn = vi.fn(async () => ({ reply: "Hi!", escalate: false, optedOut: false, declined: false, captured: {} }));
vi.mock("./smsEngine", () => ({ runSmsTurn: (...a: any[]) => runSmsTurn(...a) }));

const findLeadByPhone = vi.fn(async () => null);
const getLeadFields = vi.fn(async () => []);
vi.mock("../db/queries", () => ({
  findLeadByPhone: (...a: any[]) => findLeadByPhone(...a),
  getLeadFields: (...a: any[]) => getLeadFields(...a),
}));

const messagesCreate = vi.fn(async () => ({ sid: "SM1" }));
vi.mock("../twilio/client", () => ({
  getTwilioClient: vi.fn(async () => ({ messages: { create: (...a: any[]) => messagesCreate(...a) } })),
}));

import {
  handleInboundSms,
  sendMissedCallText,
  sendWebLeadText,
  buildOpenerText,
} from "./smsService";

const INSIDE_WINDOW = new Date("2026-07-21T12:00:00Z"); // noon UTC → within 8am–9pm
const OUTSIDE_WINDOW = new Date("2026-07-21T03:00:00Z"); // 3am UTC → quiet hours

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(text, {
    enabled: true,
    number: "+15550001111",
    businessName: "Acme",
    missedCallEnabled: true,
    webLeadEnabled: true,
    timezone: "UTC",
  });
  isPhoneOptedOut.mockResolvedValue(false);
  findConversationByPhone.mockResolvedValue(null);
  createConversation.mockResolvedValue({ id: "conv-1", phone_number: "+15557778888", status: "active" });
  runSmsTurn.mockResolvedValue({ reply: "Hi!", escalate: false, optedOut: false, declined: false, captured: {} });
  getActiveOutreachTemplates.mockResolvedValue([]);
});

describe("handleInboundSms", () => {
  it("STOP marks the conversation opted out and sends NO reply", async () => {
    await handleInboundSms({ from: "+15557778888", body: "STOP" });
    expect(updateConversationStatus).toHaveBeenCalledWith("conv-1", "opted_out");
    expect(sendSms).not.toHaveBeenCalled();
    expect(runSmsTurn).not.toHaveBeenCalled();
  });

  it("ignores an already opted-out number (no engine, no reply)", async () => {
    isPhoneOptedOut.mockResolvedValue(true);
    await handleInboundSms({ from: "+15557778888", body: "are you there?" });
    expect(runSmsTurn).not.toHaveBeenCalled();
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("HELP replies with an identification message (no engine)", async () => {
    await handleInboundSms({ from: "+15557778888", body: "HELP" });
    expect(runSmsTurn).not.toHaveBeenCalled();
    expect(sendSms).toHaveBeenCalledTimes(1);
  });

  it("normal message runs the engine and sends its reply", async () => {
    await handleInboundSms({ from: "+15557778888", body: "my zip is 90210" });
    expect(runSmsTurn).toHaveBeenCalledTimes(1);
    expect(sendSms).toHaveBeenCalledWith(expect.objectContaining({ body: "Hi!" }));
  });

  it("on engine opt-out: marks opted_out and does NOT reply", async () => {
    runSmsTurn.mockResolvedValue({ reply: "", escalate: false, optedOut: true, declined: false, captured: {} });
    await handleInboundSms({ from: "+15557778888", body: "stop texting me please" });
    expect(updateConversationStatus).toHaveBeenCalledWith("conv-1", "opted_out");
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("on engine decline (interest gate): marks declined and sends the one closing line", async () => {
    runSmsTurn.mockResolvedValue({
      reply: "No problem — thanks for your time!",
      escalate: false,
      optedOut: false,
      declined: true,
      captured: {},
    });
    await handleInboundSms({ from: "+15557778888", body: "not interested" });
    expect(updateConversationStatus).toHaveBeenCalledWith("conv-1", "declined");
    expect(updateConversationStatus).not.toHaveBeenCalledWith("conv-1", "opted_out");
    expect(sendSms).toHaveBeenCalledWith(
      expect.objectContaining({ body: "No problem — thanks for your time!" })
    );
  });

  it("on engine escalate: replies, marks escalated, and notifies the owner", async () => {
    runSmsTurn.mockResolvedValue({ reply: "One moment.", escalate: true, optedOut: false, captured: {} });
    await handleInboundSms({ from: "+15557778888", body: "I want a real person" });
    expect(sendSms).toHaveBeenCalledWith(expect.objectContaining({ body: "One moment." }));
    expect(updateConversationStatus).toHaveBeenCalledWith("conv-1", "escalated");
    expect(messagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ from: "+15550001111", to: "+15559990000" })
    );
  });
});

describe("sendMissedCallText / sendWebLeadText gating", () => {
  it("missed-call: sends the opener inside the texting window", async () => {
    const sent = await sendMissedCallText({ phone: "+15557778888", now: INSIDE_WINDOW });
    expect(sent).toBe(true);
    expect(sendSms).toHaveBeenCalledWith(expect.objectContaining({ firstBotInitiated: true }));
  });

  it("does NOT send outside the quiet-hours window", async () => {
    const sent = await sendMissedCallText({ phone: "+15557778888", now: OUTSIDE_WINDOW });
    expect(sent).toBe(false);
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("does NOT send when the text bot is disabled", async () => {
    text.enabled = false;
    const sent = await sendMissedCallText({ phone: "+15557778888", now: INSIDE_WINDOW });
    expect(sent).toBe(false);
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("respects the missed-call sub-toggle", async () => {
    text.missedCallEnabled = false;
    const sent = await sendMissedCallText({ phone: "+15557778888", now: INSIDE_WINDOW });
    expect(sent).toBe(false);
  });

  it("respects the web-lead sub-toggle", async () => {
    text.webLeadEnabled = false;
    const sent = await sendWebLeadText({ phone: "+15557778888", now: INSIDE_WINDOW });
    expect(sent).toBe(false);
  });

  it("does NOT send to an opted-out number", async () => {
    isPhoneOptedOut.mockResolvedValue(true);
    const sent = await sendWebLeadText({ phone: "+15557778888", now: INSIDE_WINDOW });
    expect(sent).toBe(false);
    expect(sendSms).not.toHaveBeenCalled();
  });
});

describe("sendOpener — template rotation", () => {
  const TEMPLATES = [
    { id: "t1", template_text: "Hey {first_name}, template ONE here." },
    { id: "t2", template_text: "Hi {FirstName}, template TWO here." },
    { id: "t3", template_text: "Yo {firstname}, template THREE here." },
  ];

  it("sends a random active template, personalized and VERBATIM (no prefix/suffix)", async () => {
    getActiveOutreachTemplates.mockResolvedValue(TEMPLATES as any);
    const randSpy = vi.spyOn(Math, "random").mockReturnValue(0); // → index 0
    try {
      const sent = await sendWebLeadText({ phone: "+15557778888", name: "Dana", now: INSIDE_WINDOW });
      expect(sent).toBe(true);
      expect(sendSms).toHaveBeenCalledWith(
        expect.objectContaining({ body: "Hey Dana, template ONE here.", firstBotInitiated: true })
      );
    } finally {
      randSpy.mockRestore();
    }
  });

  it("rotates: different Math.random values select different template bodies", async () => {
    getActiveOutreachTemplates.mockResolvedValue(TEMPLATES as any);
    const randSpy = vi.spyOn(Math, "random");
    try {
      randSpy.mockReturnValue(0); // index 0
      await sendWebLeadText({ phone: "+15557778888", name: "Dana", now: INSIDE_WINDOW });
      randSpy.mockReturnValue(0.4); // index 1
      await sendWebLeadText({ phone: "+15557778888", name: "Dana", now: INSIDE_WINDOW });
      randSpy.mockReturnValue(0.9); // index 2
      await sendWebLeadText({ phone: "+15557778888", name: "Dana", now: INSIDE_WINDOW });

      const bodies = sendSms.mock.calls.map((c: any[]) => c[0].body);
      expect(bodies).toEqual([
        "Hey Dana, template ONE here.",
        "Hi Dana, template TWO here.",
        "Yo Dana, template THREE here.",
      ]);
    } finally {
      randSpy.mockRestore();
    }
  });

  it("mirrors the worker's blank-name handling → 'there'", async () => {
    getActiveOutreachTemplates.mockResolvedValue(TEMPLATES as any);
    const randSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      await sendMissedCallText({ phone: "+15557778888", now: INSIDE_WINDOW });
      expect(sendSms).toHaveBeenCalledWith(
        expect.objectContaining({ body: "Hey there, template ONE here." })
      );
    } finally {
      randSpy.mockRestore();
    }
  });

  it("falls back to buildOpenerText when there are 0 active templates", async () => {
    getActiveOutreachTemplates.mockResolvedValue([]);
    const sent = await sendWebLeadText({ phone: "+15557778888", name: "Dana", now: INSIDE_WINDOW });
    expect(sent).toBe(true);
    const body = sendSms.mock.calls[0][0].body;
    expect(body).toBe(
      buildOpenerText({ stages: [], leadName: "Dana", agentName: "Alex", businessName: "Acme" })
    );
  });
});

describe("buildOpenerText", () => {
  it("uses the opener stage script VERBATIM with placeholders filled and no injected prefix", () => {
    const body = buildOpenerText({
      stages: [
        { stage_key: "opener", stage_order: 1, stage_type: "opener", title: "Opener", script_text: "Hi (Client's Name), it's (Agent Name) here." } as any,
      ],
      leadName: "Dana",
      agentName: "Alex",
      businessName: "Acme",
    });
    expect(body).toBe("Hi Dana, it's Alex here.");
  });

  it("falls back to a default opener that names the agent and business", () => {
    const body = buildOpenerText({ stages: [], leadName: null, agentName: "Alex", businessName: "Acme" });
    expect(body).toContain("Alex");
    expect(body).toContain("Acme");
    expect(body).toContain("there");
  });
});
