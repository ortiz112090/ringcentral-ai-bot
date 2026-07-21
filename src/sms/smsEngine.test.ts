import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the OpenAI chat client; each test scripts the sequence of responses.
const create = vi.fn();
vi.mock("../ai/openaiClient", () => ({
  getOpenAI: vi.fn(async () => ({ chat: { completions: { create: (...a: any[]) => create(...a) } } })),
}));

// Persistence side effects — assert they fire without touching a real DB.
const mergeConversationCapturedData = vi.fn(async () => {});
vi.mock("./smsQueries", () => ({
  mergeConversationCapturedData: (...a: any[]) => mergeConversationCapturedData(...a),
}));
const upsertLead = vi.fn(async () => {});
vi.mock("../db/queries", () => ({
  upsertLead: (...a: any[]) => upsertLead(...a),
}));

import { runSmsTurn } from "./smsEngine";

const convo: any = { id: "conv-1", phone_number: "+15557778888", status: "active" };
const baseInput = {
  conversation: convo,
  lead: null,
  stages: [],
  leadFields: [] as any[],
  history: [{ role: "user" as const, content: "hi" }],
  model: "gpt-4o-mini",
  agentName: "Alex",
  businessName: "Acme",
};

/** Helper: a plain assistant text response (no tool calls). */
const textResponse = (content: string) => ({
  choices: [{ message: { role: "assistant", content, tool_calls: [] } }],
});

/** Helper: an assistant response that calls one function tool. */
const toolResponse = (name: string, args: Record<string, unknown>) => ({
  choices: [
    {
      message: {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call_1", type: "function", function: { name, arguments: JSON.stringify(args) } },
        ],
      },
    },
  ],
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runSmsTurn", () => {
  it("returns the model's plain text reply when no tools are called", async () => {
    create.mockResolvedValueOnce(textResponse("Sure — what's your ZIP code?"));
    const res = await runSmsTurn(baseInput);
    expect(res.reply).toBe("Sure — what's your ZIP code?");
    expect(res.escalate).toBe(false);
    expect(res.optedOut).toBe(false);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("executes capture_lead_info: validates, persists captured_data + leads upsert, then replies", async () => {
    create
      .mockResolvedValueOnce(toolResponse("capture_lead_info", { first_name: "Dana", zip_code: "90210" }))
      .mockResolvedValueOnce(textResponse("Thanks Dana!"));

    const res = await runSmsTurn(baseInput);

    expect(res.captured).toMatchObject({ first_name: "Dana", zip_code: "90210" });
    expect(mergeConversationCapturedData).toHaveBeenCalledWith(
      "conv-1",
      expect.objectContaining({ first_name: "Dana", zip_code: "90210" })
    );
    expect(upsertLead).toHaveBeenCalledWith(
      expect.objectContaining({ phone_number: "+15557778888", first_name: "Dana", zip_code: "90210" })
    );
    expect(res.reply).toBe("Thanks Dana!");
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("does NOT upsert a lead for a rejected-only capture but still replies", async () => {
    create
      .mockResolvedValueOnce(toolResponse("capture_lead_info", { zip_code: "9021" }))
      .mockResolvedValueOnce(textResponse("That ZIP looks short — can you resend all five digits?"));

    const res = await runSmsTurn(baseInput);

    expect(upsertLead).not.toHaveBeenCalled();
    expect(mergeConversationCapturedData).not.toHaveBeenCalled();
    expect(res.captured).toEqual({});
    expect(res.reply).toMatch(/five digits/);
  });

  it("sets escalate and supplies a safe handoff line when the model escalates with no text", async () => {
    create.mockResolvedValueOnce(toolResponse("escalate_to_human", { reason: "wants a person" }));
    // Round 2: model emits nothing further.
    create.mockResolvedValueOnce(textResponse(""));

    const res = await runSmsTurn(baseInput);
    expect(res.escalate).toBe(true);
    expect(res.reply.toLowerCase()).toContain("specialist");
  });

  it("sets optedOut when the model calls mark_opted_out", async () => {
    create
      .mockResolvedValueOnce(toolResponse("mark_opted_out", {}))
      .mockResolvedValueOnce(textResponse(""));
    const res = await runSmsTurn(baseInput);
    expect(res.optedOut).toBe(true);
  });

  it("never throws — a model/API failure yields a safe escalation", async () => {
    create.mockRejectedValueOnce(new Error("429 rate limited"));
    const res = await runSmsTurn(baseInput);
    expect(res.escalate).toBe(true);
    expect(res.reply.toLowerCase()).toContain("specialist");
  });
});
