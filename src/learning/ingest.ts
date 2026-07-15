import { promises as fs } from "fs";
import path from "path";
import { logger } from "../logger";
import { transcribeAudio } from "../speech/openai";
import { insertTrainingCall } from "../db/learningQueries";
import { TrainingTurn } from "../db/types";

/**
 * Ingestion pipeline: turn a real call (audio file or text transcript) into a
 * `training_calls` row that can later be tagged and mined for lessons.
 */

/**
 * Ingest an audio recording. Reuses the existing OpenAI STT wrapper.
 *
 * LIMITATION: OpenAI transcription returns a single flat text (no diarization), and
 * RingCentral call recordings are typically single-channel mixed audio — so we CANNOT
 * reliably separate caller vs. agent automatically. We therefore store the whole
 * transcription as one "caller"-role turn as a best-effort placeholder; the human then
 * uses the tagging CLI to mark the meaningful caller/agent lines by hand. If you later
 * capture dual-channel recordings, split the channels and transcribe each separately.
 */
export async function ingestAudioFile(
  filePath: string,
  notes?: string
): Promise<number | null> {
  try {
    const buffer = await fs.readFile(filePath);
    const filename = path.basename(filePath);
    logger.info("Transcribing training audio", { filePath });
    const text = await transcribeAudio(buffer, filename);
    if (!text) {
      logger.warn("Transcription empty; storing training call with empty transcript", {
        filePath,
      });
    }
    const transcript: TrainingTurn[] = text
      ? [{ role: "caller", text, timestamp: null }]
      : [];
    const id = await insertTrainingCall({
      source: "upload_audio",
      transcript,
      audioUrl: filePath, // local path reference; swap for a stored URL if you upload audio
      notes: notes ?? null,
    });
    logger.info("Ingested audio training call", { id, filePath });
    return id;
  } catch (err) {
    logger.error("Failed to ingest audio file", {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Parse a raw text transcript into turns.
 *
 * EXPECTED FORMAT: one utterance per line, prefixed with a speaker label:
 *   Caller: I was looking to get an SR22 filed.
 *   Agent: No worries, I'll get you taken care of...
 * Anything before the first ':' is treated as the speaker. Labels starting with
 * "agent"/"bot"/"me" map to role 'agent'; everything else maps to 'caller'. Lines
 * with no ':' are appended to the previous turn's text (handles wrapped lines).
 */
export function parseTranscriptText(raw: string): TrainingTurn[] {
  const turns: TrainingTurn[] = [];
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const colon = trimmed.indexOf(":");
    if (colon === -1) {
      // Continuation of the previous turn.
      if (turns.length > 0) {
        turns[turns.length - 1].text += ` ${trimmed}`;
      }
      continue;
    }

    const label = trimmed.slice(0, colon).trim().toLowerCase();
    const text = trimmed.slice(colon + 1).trim();
    if (!text) continue;

    const role: TrainingTurn["role"] =
      label.startsWith("agent") || label.startsWith("bot") || label.startsWith("me")
        ? "agent"
        : "caller";
    turns.push({ role, text, timestamp: null });
  }
  return turns;
}

/** Ingest an already-transcribed text file (see parseTranscriptText for format). */
export async function ingestTranscriptFile(
  filePath: string,
  notes?: string
): Promise<number | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const transcript = parseTranscriptText(raw);
    if (transcript.length === 0) {
      logger.warn("Parsed transcript is empty; check the file format", { filePath });
    }
    const id = await insertTrainingCall({
      source: "upload_transcript",
      transcript,
      notes: notes ?? null,
    });
    logger.info("Ingested transcript training call", { id, filePath, turns: transcript.length });
    return id;
  } catch (err) {
    logger.error("Failed to ingest transcript file", {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
