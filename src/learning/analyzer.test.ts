import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- Mutable effective config; flipped per test. ----
const cfg: any = {
  botRole: "texting",
  text: { model: "gpt-4o-mini" },
};
vi.mock("../config", () => ({
  resolveEffectiveConfig: vi.fn(async () => cfg),
}));
vi.mock("../db/remoteConfig", () => ({
  BOT_ID: "00000000-0000-0000-0000-000000000001",
  loadRemoteConfig: vi.fn(async () => ({})),
}));

// ---- OpenAI mock: create() returns whatever `openaiContent` holds. ----
let openaiContent = "";
const create = vi.fn(async () => ({
  choices: [{ message: { content: openaiContent } }],
}));
vi.mock("../ai/openaiClient", () => ({
  getOpenAI: vi.fn(async () => ({ chat: { completions: { create } } })),
}));

// ---- suggestionQueries mock. ----
const getLastSuggestionAt = vi.fn(async () => null as string | null);
const countMessagesSince = vi.fn(async () => 50);
const getRecentConversations = vi.fn(async () => [] as any[]);
const getActiveTextStages = vi.fn(async () => [] as any[]);
const getMessagesForConversations = vi.fn(async () => [] as any[]);
const insertScriptSuggestion = vi.fn(async () => true);
vi.mock("./suggestionQueries", () => ({
  getLastSuggestionAt: (...a: any[]) => getLastSuggestionAt(...a),
  countMessagesSince: (...a: any[]) => countMessagesSince(...a),
  getRecentConversations: (...a: any[]) => getRecentConversations(...a),
  getActiveTextStages: (...a: any[]) => getActiveTextStages(...a),
  getMessagesForConversations: (...a: any[]) => getMessagesForConversations(...a),
  insertScriptSuggestion: (...a: any[]) => insertScriptSuggestion(...a),
}));

import { parseSuggestions, runAnalysisOnce, toValidSuggestion } from "./analyzer";

const CONVO_ID = "11111111-1111-1111-1111-111111111111";
const CONVO_ID_2 = "22222222-2222-2222-2222-222222222222";

const stage = {
  id: 7,
  stage_key: "opener",
  stage_type: "opener",
  title: "Opener",
  script_text: "Hi there — has anyone helped you with your SR22 yet?",
};

function convo(id = CONVO_ID) {
  return {
    id,
    status: "active",
    trigger: "inbound",
    created_at: "2026-07-20T00:00:00Z",
    last_message_at: "2026-07-20T00:05:00Z",
  };
}

function msg(conversation_id: string, direction: "inbound" | "outbound", body: string) {
  return { conversation_id, direction, body, created_at: "2026-07-20T00:01:00Z" };
}

/** A well-formed model response containing one reword suggestion. */
function rewordResponse() {
  return JSON.stringify({
    suggestions: [
      {
        stage_key: "opener",
        suggestion_type: "reword",
        current_text: "old",
        suggested_text: "Hey! Quick question — do you still need your SR22 filed?",
        rationale: "Customers went quiet after the current opener.",
        evidence: [{ conversation_id: CONVO_ID, snippet: "no response after opener" }],
      },
    ],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  cfg.botRole = "texting";
  cfg.text = { model: "gpt-4o-mini" };
  openaiContent = rewordResponse();
  getLastSuggestionAt.mockResolvedValue(null);
  countMessagesSince.mockResolvedValue(50);
  getRecentConversations.mockResolvedValue([convo()]);
  getActiveTextStages.mockResolvedValue([stage]);
  getMessagesForConversations.mockResolvedValue([
    msg(CONVO_ID, "outbound", stage.script_text),
    msg(CONVO_ID, "inbound", "..."),
  ]);
  insertScriptSuggestion.mockResolvedValue(true);
});

describe("parseSuggestions", () => {
  it("parses a well-formed suggestions array", () => {
    const out = parseSuggestions(rewordResponse());
    expect(out).toHaveLength(1);
    expect(out[0].stage_key).toBe("opener");
  });

  it("tolerates surrounding prose (extracts the JSON object)", () => {
    const out = parseSuggestions('here you go:\n' + rewordResponse() + '\nthanks');
    expect(out).toHaveLength(1);
  });

  it("throws when there is no JSON object", () => {
    expect(() => parseSuggestions("no json here")).toThrow();
  });

  it("throws when the suggestions array is missing", () => {
    expect(() => parseSuggestions(JSON.stringify({ foo: 1 }))).toThrow();
  });
});

describe("toValidSuggestion", () => {
  const stagesByKey = new Map([[stage.stage_key, stage]]);
  const known = new Set([CONVO_ID]);

  it("maps a reword to the active stage id and uses the LIVE current_text", () => {
    const raw = JSON.parse(rewordResponse()).suggestions[0];
    const out = toValidSuggestion(raw, stagesByKey, known)!;
    expect(out.stageId).toBe(7);
    expect(out.currentText).toBe(stage.script_text); // taken from the live stage, not the model
    expect(out.suggestionType).toBe("reword");
    expect(out.evidence).toHaveLength(1);
  });

  it("drops a reword whose stage_key is not an active stage", () => {
    const raw = { ...JSON.parse(rewordResponse()).suggestions[0], stage_key: "gone" };
    expect(toValidSuggestion(raw, stagesByKey, known)).toBeNull();
  });

  it("drops a suggestion with an unknown suggestion_type", () => {
    const raw = { ...JSON.parse(rewordResponse()).suggestions[0], suggestion_type: "delete" };
    expect(toValidSuggestion(raw, stagesByKey, known)).toBeNull();
  });

  it("drops evidence citing conversations we did not load, and drops the item if none remain", () => {
    const raw = {
      ...JSON.parse(rewordResponse()).suggestions[0],
      evidence: [{ conversation_id: "deadbeef", snippet: "made up" }],
    };
    expect(toValidSuggestion(raw, stagesByKey, known)).toBeNull();
  });

  it("keeps a new_faq with null stage/current_text", () => {
    const raw = {
      stage_key: null,
      suggestion_type: "new_faq",
      current_text: null,
      suggested_text: "We can usually file same-day.",
      rationale: "Several customers asked about timing.",
      evidence: [{ conversation_id: CONVO_ID, snippet: "how long does it take?" }],
    };
    const out = toValidSuggestion(raw, stagesByKey, known)!;
    expect(out.stageId).toBeNull();
    expect(out.currentText).toBeNull();
    expect(out.suggestionType).toBe("new_faq");
  });

  it("drops a suggestion missing suggested_text or rationale", () => {
    const base = JSON.parse(rewordResponse()).suggestions[0];
    expect(toValidSuggestion({ ...base, suggested_text: "  " }, stagesByKey, known)).toBeNull();
    expect(toValidSuggestion({ ...base, rationale: "" }, stagesByKey, known)).toBeNull();
  });
});

describe("runAnalysisOnce", () => {
  it("inserts a pending suggestion from a mocked OpenAI response", async () => {
    await runAnalysisOnce();
    expect(create).toHaveBeenCalledTimes(1);
    // Uses the tenant text_model.
    expect(create.mock.calls[0][0].model).toBe("gpt-4o-mini");
    expect(insertScriptSuggestion).toHaveBeenCalledTimes(1);
    const inserted = insertScriptSuggestion.mock.calls[0][0];
    expect(inserted.flow).toBe("text");
    expect(inserted.stageId).toBe(7);
    expect(inserted.suggestionType).toBe("reword");
  });

  it("does nothing for a non-texting bot (role gate)", async () => {
    cfg.botRole = "answer_calls";
    await runAnalysisOnce();
    expect(getRecentConversations).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(insertScriptSuggestion).not.toHaveBeenCalled();
  });

  it("skips the tick when too few new messages since last run", async () => {
    countMessagesSince.mockResolvedValue(4); // < MIN_NEW_MESSAGES (5)
    await runAnalysisOnce();
    expect(getRecentConversations).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("skips when there are no recent conversations", async () => {
    getRecentConversations.mockResolvedValue([]);
    await runAnalysisOnce();
    expect(create).not.toHaveBeenCalled();
    expect(insertScriptSuggestion).not.toHaveBeenCalled();
  });

  it("skips when recent conversations have no messages", async () => {
    getMessagesForConversations.mockResolvedValue([]);
    await runAnalysisOnce();
    expect(create).not.toHaveBeenCalled();
    expect(insertScriptSuggestion).not.toHaveBeenCalled();
  });

  it("never throws and inserts nothing on malformed model output", async () => {
    openaiContent = "totally not json";
    await expect(runAnalysisOnce()).resolves.toBeUndefined();
    expect(insertScriptSuggestion).not.toHaveBeenCalled();
  });

  it("never throws when the OpenAI call itself rejects", async () => {
    create.mockRejectedValueOnce(new Error("429 rate limited"));
    await expect(runAnalysisOnce()).resolves.toBeUndefined();
    expect(insertScriptSuggestion).not.toHaveBeenCalled();
  });

  it("caps insertion at 5 suggestions even if the model returns more", async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      stage_key: null,
      suggestion_type: "new_faq",
      current_text: null,
      suggested_text: `faq ${i}`,
      rationale: `reason ${i}`,
      evidence: [{ conversation_id: CONVO_ID, snippet: `snippet ${i}` }],
    }));
    openaiContent = JSON.stringify({ suggestions: many });
    await runAnalysisOnce();
    expect(insertScriptSuggestion).toHaveBeenCalledTimes(5);
  });

  it("does not count duplicates that the unique index rejects (insert returns false)", async () => {
    const two = [
      {
        stage_key: "opener",
        suggestion_type: "reword",
        current_text: null,
        suggested_text: "improved opener",
        rationale: "clearer",
        evidence: [{ conversation_id: CONVO_ID, snippet: "quiet" }],
      },
      {
        stage_key: null,
        suggestion_type: "new_faq",
        current_text: null,
        suggested_text: "same-day filing",
        rationale: "timing asked",
        evidence: [{ conversation_id: CONVO_ID_2, snippet: "how long?" }],
      },
    ];
    getRecentConversations.mockResolvedValue([convo(CONVO_ID), convo(CONVO_ID_2)]);
    openaiContent = JSON.stringify({ suggestions: two });
    insertScriptSuggestion.mockResolvedValueOnce(false); // first is a dup
    insertScriptSuggestion.mockResolvedValueOnce(true);
    await runAnalysisOnce();
    expect(insertScriptSuggestion).toHaveBeenCalledTimes(2); // both attempted
  });
});
