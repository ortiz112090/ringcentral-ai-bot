import { describe, it, expect } from "vitest";
import { buildRealtimeInstructions } from "./systemPrompt";
import type { ScriptStageRow, ScriptConstraintRow } from "../db/queries";

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

describe("buildRealtimeInstructions adherence + VOICE & DELIVERY (both paths)", () => {
  it("adds the script-adherence rule and VOICE & DELIVERY on the fallback (empty stages) path", () => {
    const prompt = buildRealtimeInstructions(null, []);
    expect(prompt).toMatch(/Do NOT invent your own questions/);
    expect(prompt).toMatch(/steer back to the current stage/);
    expect(prompt).toMatch(/# VOICE & DELIVERY/);
    expect(prompt).toMatch(/contractions/);
    // Hardcoded SR22 script still fully intact.
    expect(prompt).toMatch(/trying to get an SR22 filed/);
    expect(prompt).toMatch(/# SCRIPT FLOW/);
  });
});

describe("buildRealtimeInstructions DB-driven script", () => {
  const stages: ScriptStageRow[] = [
    { stage_key: "opener", stage_order: 1, stage_type: "opener", title: "Warm Opener", script_text: "Hi (Client's Name), it's (Agent Name) here." },
    { stage_key: "qualify", stage_order: 2, stage_type: "qualify", title: "Qualify Need", script_text: "When do you need this filed?" },
    { stage_key: "collect", stage_order: 3, stage_type: "data_collection", title: "Collect Details", script_text: "Can I grab your ZIP?" },
    { stage_key: "quote", stage_order: 4, stage_type: "quote", title: "Present Quote", script_text: "Here is your best rate." },
    { stage_key: "close1", stage_order: 5, stage_type: "close", title: "Initial Offer", script_text: "Ready to lock it in?" },
    { stage_key: "close2", stage_order: 6, stage_type: "close", title: "Split Payment", script_text: "We can split it up." },
    { stage_key: "obj_price", stage_order: 7, stage_type: "objection", title: "Too Expensive", script_text: "I hear you on price." },
    { stage_key: "fb_unknown", stage_order: 8, stage_type: "fallback", title: "Off-Script", script_text: "Let me check on that." },
  ];
  const constraints: ScriptConstraintRow[] = [
    { rule_text: "Never promise a specific approval time.", severity: "warning" },
    { rule_text: "Always confirm identity before quoting.", severity: "critical" },
  ];

  const prompt = buildRealtimeInstructions(
    { first_name: "Jordan" } as any,
    [],
    stages,
    constraints
  );

  it("renders the DB stage titles and text grouped into the right sections", () => {
    expect(prompt).toMatch(/# SCRIPT FLOW/);
    expect(prompt).toContain("## Warm Opener");
    expect(prompt).toContain("## Qualify Need");
    expect(prompt).toContain("## Collect Details");
    expect(prompt).toContain("## Present Quote");
    expect(prompt).toMatch(/# CLOSING DISCIPLINE/);
    expect(prompt).toContain("Initial Offer");
    expect(prompt).toContain("Split Payment");
    expect(prompt).toMatch(/# OBJECTIONS/);
    expect(prompt).toContain("## Too Expensive");
    expect(prompt).toMatch(/# FALLBACKS/);
    expect(prompt).toContain("## Off-Script");
  });

  it("preserves stage_order within SCRIPT FLOW", () => {
    expect(prompt.indexOf("Warm Opener")).toBeLessThan(prompt.indexOf("Qualify Need"));
    expect(prompt.indexOf("Qualify Need")).toBeLessThan(prompt.indexOf("Collect Details"));
    expect(prompt.indexOf("Collect Details")).toBeLessThan(prompt.indexOf("Present Quote"));
  });

  it("numbers close stages 1..N with the record_close_attempt framing", () => {
    expect(prompt).toMatch(/1\. Initial Offer/);
    expect(prompt).toMatch(/2\. Split Payment/);
    expect(prompt).toMatch(/record_close_attempt/);
  });

  it("substitutes (Client's Name) and (Agent Name) placeholders", () => {
    expect(prompt).toContain("Hi Jordan, it's");
    expect(prompt).not.toContain("(Client's Name)");
    expect(prompt).not.toContain("(Agent Name)");
  });

  it("renders active constraints into HARD RULES, critical first", () => {
    expect(prompt).toContain("Always confirm identity before quoting.");
    expect(prompt).toContain("Never promise a specific approval time.");
    expect(prompt.indexOf("Always confirm identity")).toBeLessThan(
      prompt.indexOf("Never promise a specific approval time.")
    );
  });

  it("includes the adherence rule and VOICE & DELIVERY section", () => {
    expect(prompt).toMatch(/Do NOT invent your own questions/);
    expect(prompt).toMatch(/# VOICE & DELIVERY/);
  });

  it("omits the hardcoded opener text when DB stages are present", () => {
    expect(prompt).not.toContain("has anyone helped you out with that yet?");
  });
});
