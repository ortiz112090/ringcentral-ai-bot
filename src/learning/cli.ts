import * as readline from "readline";
import { logger } from "../logger";
import { ingestAudioFile, ingestTranscriptFile } from "./ingest";
import { getTrainingCall } from "../db/learningQueries";
import { createTag, KNOWN_CATEGORIES } from "./tagging";
import { extractLesson } from "./extractLessons";
import { approveRule, listPendingRules, rejectRule } from "./review";
import { TagType } from "../db/types";

/**
 * Stopgap CLI for the learning system (no dashboard yet). Three subcommands:
 *   ingest  --audio <path> | --transcript <path> [--notes "..."]
 *   tag     --call <training_call_id>
 *   review
 *
 * Run after `npm run build` (these execute the compiled dist/ output). See package.json
 * scripts: learn:ingest, learn:tag, learn:review. Clarity over polish — this is a
 * temporary tool until a real tagging/review dashboard exists.
 */

// ---------- tiny arg + prompt helpers ----------

function getFlag(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(`--${name}`);
  return idx !== -1 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
}

function createPrompter() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, (a) => resolve(a.trim())));
  return { ask, close: () => rl.close() };
}

// ---------- ingest ----------

async function runIngest(argv: string[]): Promise<void> {
  const audio = getFlag(argv, "audio");
  const transcript = getFlag(argv, "transcript");
  const notes = getFlag(argv, "notes");

  if (!audio && !transcript) {
    console.error("Usage: learn:ingest -- --audio <path> | --transcript <path> [--notes \"...\"]");
    process.exitCode = 1;
    return;
  }

  const id = audio
    ? await ingestAudioFile(audio, notes)
    : await ingestTranscriptFile(transcript as string, notes);

  if (id == null) {
    console.error("Ingestion failed — check logs above.");
    process.exitCode = 1;
    return;
  }
  console.log(`\nIngested training call #${id}. Next: npm run learn:tag -- --call ${id}`);
}

// ---------- tag ----------

async function runTag(argv: string[]): Promise<void> {
  const callArg = getFlag(argv, "call");
  const trainingCallId = callArg ? parseInt(callArg, 10) : NaN;
  if (Number.isNaN(trainingCallId)) {
    console.error("Usage: learn:tag -- --call <training_call_id>");
    process.exitCode = 1;
    return;
  }

  const call = await getTrainingCall(trainingCallId);
  if (!call) {
    console.error(`Training call #${trainingCallId} not found.`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n=== Training call #${call.id} (${call.source}) ===`);
  if (call.notes) console.log(`Notes: ${call.notes}`);
  call.transcript.forEach((turn, i) => {
    const who = turn.role === "agent" ? "AGENT " : "CALLER";
    console.log(`[${i}] ${who}: ${turn.text}`);
  });
  console.log("\nMark good/bad moments. Categories:", KNOWN_CATEGORIES.join(", "));

  const { ask, close } = createPrompter();
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const more = (await ask("\nTag a moment? (y/N): ")).toLowerCase();
      if (more !== "y" && more !== "yes") break;

      const typeRaw = (await ask("good or bad example? (g/b): ")).toLowerCase();
      const tagType: TagType = typeRaw.startsWith("b") ? "bad_example" : "good_example";
      const category = (await ask("category: ")) || "other";
      const startIdx = await ask("segment start turn index (blank if n/a): ");
      const endIdx = await ask("segment end turn index (blank if n/a): ");

      // Auto-pull the referenced lines if a valid start index was given.
      let callerLine: string | null = null;
      let agentLine: string | null = null;
      const si = parseInt(startIdx, 10);
      if (!Number.isNaN(si) && call.transcript[si]) {
        const turn = call.transcript[si];
        if (turn.role === "caller") callerLine = turn.text;
        else agentLine = turn.text;
      }
      callerLine = (await ask(`caller line [${callerLine ?? ""}]: `)) || callerLine;
      agentLine = (await ask(`agent line [${agentLine ?? ""}]: `)) || agentLine;

      const tagId = await createTag({
        trainingCallId: call.id,
        tagType,
        category,
        segmentStart: startIdx || null,
        segmentEnd: endIdx || null,
        callerLine,
        agentLine,
      });

      if (tagId == null) {
        console.error("Failed to save tag — check logs.");
        continue;
      }
      console.log(`Saved tag #${tagId}. Extracting lesson with Claude...`);
      const ruleId = await extractLesson(tagId);
      console.log(
        ruleId != null
          ? `Lesson #${ruleId} created (pending review). Run npm run learn:review to approve.`
          : "Lesson extraction failed — check logs."
      );
    }
  } finally {
    close();
  }
}

// ---------- review ----------

async function runReview(): Promise<void> {
  const pending = await listPendingRules();
  if (pending.length === 0) {
    console.log("No pending lessons to review.");
    return;
  }
  console.log(`\n${pending.length} pending lesson(s) to review.\n`);

  const { ask, close } = createPrompter();
  try {
    for (const rule of pending) {
      console.log("────────────────────────────────────────");
      console.log(`Rule #${rule.id}  [${rule.category}]`);
      console.log(`When: ${rule.situation_summary}`);
      console.log(`Do:   ${rule.recommended_response}`);
      if (rule.avoid_response) console.log(`Avoid: ${rule.avoid_response}`);

      const answer = (await ask("(a)pprove / (r)eject / (s)kip / (q)uit: ")).toLowerCase();
      if (answer === "q" || answer === "quit") break;
      if (answer === "a" || answer === "approve") {
        await approveRule(rule.id);
        console.log(`Approved #${rule.id} — now live for retrieval.`);
      } else if (answer === "r" || answer === "reject") {
        await rejectRule(rule.id);
        console.log(`Rejected #${rule.id}.`);
      } else {
        console.log(`Skipped #${rule.id} (stays pending).`);
      }
    }
  } finally {
    close();
  }
}

// ---------- entry ----------

async function main(): Promise<void> {
  const [command, ...argv] = process.argv.slice(2);
  switch (command) {
    case "ingest":
      await runIngest(argv);
      break;
    case "tag":
      await runTag(argv);
      break;
    case "review":
      await runReview();
      break;
    default:
      console.error(
        "Unknown command. Use one of:\n" +
          "  npm run learn:ingest -- --audio <path> | --transcript <path>\n" +
          "  npm run learn:tag -- --call <training_call_id>\n" +
          "  npm run learn:review"
      );
      process.exitCode = 1;
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    logger.error("CLI fatal error", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
