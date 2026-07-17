import { describe, it, expect } from "vitest";
import { buildVoiceTwiml, resolveCallerNumber, type VoiceDecisionInput } from "./voiceWebhook";

const base: VoiceDecisionInput = {
  callSid: "CA456",
  to: "+15550000001",
  from: "+15557654321",
  twilioNumber: "+15550000001",
  botEnabled: true,
  escalationNumber: "+15559999999",
  wssUrl: "wss://bot.example.com/media/CA456",
  authToken: "test-auth-token",
};

describe("buildVoiceTwiml fail-closed decisions", () => {
  // Gate (a): kill switch is evaluated FIRST, before the To-number match.
  it("(a) kill switch: dials escalation_number when the bot is disabled", () => {
    const xml = buildVoiceTwiml({ ...base, botEnabled: false });
    expect(xml).toContain("<Dial>+15559999999</Dial>");
    expect(xml).not.toContain("<Connect>");
    expect(xml).not.toContain("<Stream");
  });

  it("(a) kill switch: hangs up with a message when disabled and no escalation_number", () => {
    const xml = buildVoiceTwiml({ ...base, botEnabled: false, escalationNumber: undefined });
    expect(xml).toContain("<Hangup");
    expect(xml).toContain("<Say>");
    expect(xml).not.toContain("<Dial>");
    expect(xml).not.toContain("<Connect>");
  });

  it("(a) kill switch takes priority over a To mismatch (evaluated first)", () => {
    // Disabled bot AND wrong number → still the kill-switch fallback, not a bridge.
    const xml = buildVoiceTwiml({ ...base, botEnabled: false, to: "+15550000999" });
    expect(xml).toContain("<Dial>+15559999999</Dial>");
    expect(xml).not.toContain("<Connect>");
  });

  // Gate (b): To must match this tenant's number → graceful fallback otherwise.
  it("(b) falls back (dials escalation) when the called number does not match twilio_number", () => {
    const xml = buildVoiceTwiml({ ...base, to: "+15550000999" });
    expect(xml).toContain("<Dial>+15559999999</Dial>");
    expect(xml).not.toContain("<Connect>");
  });

  it("(b) falls back when twilio_number is not set", () => {
    const xml = buildVoiceTwiml({ ...base, twilioNumber: undefined });
    expect(xml).toContain("<Dial>+15559999999</Dial>");
    expect(xml).not.toContain("<Connect>");
  });

  it("(b) matches numbers regardless of formatting / leading US 1", () => {
    const xml = buildVoiceTwiml({ ...base, to: "5550000001" });
    expect(xml).toContain("<Connect>");
    expect(xml).toContain("<Stream");
  });

  it("falls back when no public wss URL is configured (cannot bridge media)", () => {
    const xml = buildVoiceTwiml({ ...base, wssUrl: "" });
    expect(xml).toContain("<Dial>+15559999999</Dial>");
    expect(xml).not.toContain("<Connect>");
  });

  it("falls back when no auth token is available to sign the media-stream token", () => {
    const xml = buildVoiceTwiml({ ...base, authToken: undefined });
    expect(xml).toContain("<Dial>+15559999999</Dial>");
    expect(xml).not.toContain("<Connect>");
  });

  it("falls back when the CallSid is missing (cannot bind the token to a call)", () => {
    const xml = buildVoiceTwiml({ ...base, callSid: null });
    expect(xml).toContain("<Dial>+15559999999</Dial>");
    expect(xml).not.toContain("<Connect>");
  });

  it("answers: connects a per-call media stream and passes caller number as a parameter", () => {
    const xml = buildVoiceTwiml(base);
    expect(xml).toContain("<Connect>");
    expect(xml).toContain('<Stream url="wss://bot.example.com/media/CA456">');
    expect(xml).toContain('name="from"');
    expect(xml).toContain('value="+15557654321"');
  });

  it("answers: includes a call-bound media-stream token parameter", () => {
    const xml = buildVoiceTwiml(base);
    expect(xml).toContain('name="token"');
    // Token is `${exp}.${hexdigest}` — assert the shape is present in the value.
    const match = xml.match(/name="token" value="(\d+\.[0-9a-f]+)"/);
    expect(match).not.toBeNull();
  });
});

describe("resolveCallerNumber (RC-forwarded caller identity)", () => {
  // NOTE: these encode the CURRENT fallback logic, which must be verified against a
  // real RC-forwarded test call (see the prominent comment in voiceWebhook.ts).
  it("prefers ForwardedFrom when present and different from the To number", () => {
    const caller = resolveCallerNumber({
      from: "+15550000001", // RC forwarding number
      forwardedFrom: "+15557654321", // original lead
      to: "+15550000001",
    });
    expect(caller).toBe("+15557654321");
  });

  it("falls back to From when ForwardedFrom is absent", () => {
    const caller = resolveCallerNumber({ from: "+15557654321", forwardedFrom: null, to: "+15550000001" });
    expect(caller).toBe("+15557654321");
  });

  it("ignores ForwardedFrom when it merely echoes the To number", () => {
    const caller = resolveCallerNumber({
      from: "+15557654321",
      forwardedFrom: "+15550000001", // same as To → not a real original caller
      to: "+15550000001",
    });
    expect(caller).toBe("+15557654321");
  });

  it("returns null when neither is usable", () => {
    expect(resolveCallerNumber({ from: null, forwardedFrom: null, to: "+15550000001" })).toBeNull();
  });
});
