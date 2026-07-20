import { describe, it, expect } from "vitest";
import { buildRealtimeInstructions } from "./systemPrompt";

describe("buildRealtimeInstructions unclear-speech honesty rules", () => {
  const prompt = buildRealtimeInstructions(null, []);

  it("tells the model never to guess or pretend to understand unclear speech", () => {
    expect(prompt).toMatch(/unclear|garbled|nonsensical/i);
    expect(prompt).toMatch(/NEVER guess/);
    expect(prompt).toMatch(/pretend to understand/i);
    // Do not fabricate what the caller said.
    expect(prompt).toMatch(/didn't say|did not say|attribute words/i);
  });

  it("forbids capturing values it is not confident the caller said", () => {
    expect(prompt).toMatch(/capture_lead_info/);
    expect(prompt).toMatch(/not confident/i);
    expect(prompt).toMatch(/re-ask|repeat|clarify/i);
  });

  it("instructs moving on / offering callback or transfer after 2 failed attempts", () => {
    expect(prompt).toMatch(/2 attempts|two attempts/i);
    expect(prompt).toMatch(/callback|transfer/i);
  });

  it("keeps the existing SR22 script content intact", () => {
    expect(prompt).toMatch(/SR22/);
    expect(prompt).toMatch(/MVR/);
    expect(prompt).toMatch(/CLOSING DISCIPLINE/);
  });
});
