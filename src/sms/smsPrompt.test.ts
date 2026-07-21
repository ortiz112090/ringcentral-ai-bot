import { describe, it, expect } from "vitest";
import { buildSmsSystemPrompt } from "./smsPrompt";
import type { TextStageRow } from "./smsQueries";

const baseArgs = {
  lead: null,
  stages: [] as TextStageRow[],
  leadFields: [] as any[],
  agentName: "Alex",
  businessName: "Acme Insurance",
};

describe("buildSmsSystemPrompt — script discipline", () => {
  it("encodes the verbatim rule for stage lines", () => {
    const p = buildSmsSystemPrompt(baseArgs);
    expect(p).toMatch(/word-for-word|EXACTLY/i);
    expect(p).toMatch(/do not rephrase|verbatim/i);
  });

  it("lists the four acknowledgments and forbids repeating one twice in a row", () => {
    const p = buildSmsSystemPrompt(baseArgs);
    expect(p).toContain("Awesome!");
    expect(p).toContain("Great!");
    expect(p).toContain("Perfect!");
    expect(p).toContain("Mhm, no problem!");
    expect(p).toMatch(/never use the same one twice in a row/i);
  });

  it("includes the BACK ON SCRIPT rule", () => {
    const p = buildSmsSystemPrompt(baseArgs);
    expect(p).toMatch(/back on script/i);
    expect(p).toMatch(/steer .*back/i);
  });

  it("enforces SMS length (2–3 short sentences, no markdown)", () => {
    const p = buildSmsSystemPrompt(baseArgs);
    expect(p).toMatch(/2.?3 short sentences/i);
    expect(p).toMatch(/no markdown/i);
  });

  it("enforces field-completion (address/DOB/license) like the voice path", () => {
    const p = buildSmsSystemPrompt(baseArgs);
    expect(p).toMatch(/street, city, and zip/i);
    expect(p).toMatch(/month, day, and year/i);
    expect(p).toMatch(/no dashes/i);
    expect(p).toMatch(/only for the missing piece/i);
  });

  it("requires first AND last name before the urgency question", () => {
    const p = buildSmsSystemPrompt(baseArgs);
    expect(p).toMatch(/first and last name/i);
    expect(p).toMatch(/urgency|how soon/i);
  });

  it("references the SMS tools including mark_opted_out", () => {
    const p = buildSmsSystemPrompt(baseArgs);
    expect(p).toContain("capture_lead_info");
    expect(p).toContain("escalate_to_human");
    expect(p).toContain("mark_opted_out");
  });
});

describe("buildSmsSystemPrompt — data-driven behavior", () => {
  it("uses text_stages script text verbatim when provided", () => {
    const stages: TextStageRow[] = [
      {
        stage_key: "opener",
        stage_order: 1,
        stage_type: "opener",
        title: "Opener",
        script_text: "Hi (Client's Name), it's (Agent Name) — ready to finish your SR22?",
      },
    ];
    const p = buildSmsSystemPrompt({ ...baseArgs, stages });
    // Placeholder for agent name is substituted; unknown lead name stays as {name}.
    expect(p).toContain("it's Alex");
    expect(p).toContain("ready to finish your SR22?");
    expect(p).not.toContain("(Agent Name)");
  });

  it("does not re-ask known lead fields", () => {
    const p = buildSmsSystemPrompt({
      ...baseArgs,
      lead: { phone_number: "+15551112222", first_name: "Dana", zip_code: "90210" },
    });
    expect(p).toMatch(/do not re-ask/i);
    expect(p).toContain("Dana");
  });
});
