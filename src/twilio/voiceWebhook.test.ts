import { describe, it, expect } from "vitest";
import { buildVoiceTwiml, type VoiceDecisionInput } from "./voiceWebhook";

const base: VoiceDecisionInput = {
  to: "+15550000001",
  from: "+15557654321",
  twilioNumber: "+15550000001",
  voiceProvider: "twilio",
  botEnabled: true,
  escalationNumber: "+15559999999",
  wssUrl: "wss://bot.example.com/twilio/media",
};

describe("buildVoiceTwiml fail-closed decisions", () => {
  it("(a) rejects when voice_provider is not 'twilio'", () => {
    const xml = buildVoiceTwiml({ ...base, voiceProvider: "ringcentral" });
    expect(xml).toContain("<Reject");
    expect(xml).not.toContain("<Connect>");
  });

  it("(a) rejects when twilio_number is not set", () => {
    const xml = buildVoiceTwiml({ ...base, twilioNumber: undefined });
    expect(xml).toContain("<Reject");
    expect(xml).not.toContain("<Connect>");
  });

  it("(b) rejects when the called number does not match twilio_number", () => {
    const xml = buildVoiceTwiml({ ...base, to: "+15550000999" });
    expect(xml).toContain("<Reject");
    expect(xml).not.toContain("<Connect>");
  });

  it("(b) matches numbers regardless of formatting / leading US 1", () => {
    const xml = buildVoiceTwiml({ ...base, to: "5550000001" });
    expect(xml).toContain("<Connect>");
    expect(xml).toContain("<Stream");
  });

  it("(c) kill switch: dials escalation_number when the bot is disabled", () => {
    const xml = buildVoiceTwiml({ ...base, botEnabled: false });
    expect(xml).toContain("<Dial>+15559999999</Dial>");
    expect(xml).not.toContain("<Connect>");
    expect(xml).not.toContain("<Stream");
  });

  it("(c) kill switch: hangs up when disabled and no escalation_number", () => {
    const xml = buildVoiceTwiml({ ...base, botEnabled: false, escalationNumber: undefined });
    expect(xml).toContain("<Hangup");
    expect(xml).not.toContain("<Dial>");
    expect(xml).not.toContain("<Connect>");
  });

  it("rejects when no public wss URL is configured (cannot bridge media)", () => {
    const xml = buildVoiceTwiml({ ...base, wssUrl: "" });
    expect(xml).toContain("<Reject");
    expect(xml).not.toContain("<Connect>");
  });

  it("answers: connects a media stream and passes caller number as a parameter", () => {
    const xml = buildVoiceTwiml(base);
    expect(xml).toContain("<Connect>");
    expect(xml).toContain('<Stream url="wss://bot.example.com/twilio/media">');
    expect(xml).toContain('name="from"');
    expect(xml).toContain('value="+15557654321"');
  });
});
