import OpenAI, { toFile } from "openai";
import { config } from "../config";
import { logger } from "../logger";

const client = new OpenAI({ apiKey: config.openai.apiKey });

/**
 * Speech-to-text. Takes raw caller audio bytes (e.g. a wav/mp3 chunk pulled from
 * RingCentral media) and returns transcribed text.
 *
 * We use OpenAI for STT (per the requirements) for consistency with TTS. If you
 * later switch RingCentral to a raw RTP/PCM media stream, you'd transcode to wav
 * before calling this, or swap in a streaming STT provider — noted as a tradeoff.
 */
export async function transcribeAudio(
  audio: Buffer,
  filename = "caller-audio.wav"
): Promise<string> {
  try {
    const file = await toFile(audio, filename);
    const result = await client.audio.transcriptions.create({
      file,
      model: config.openai.sttModel,
    });
    return result.text.trim();
  } catch (err) {
    logger.error("STT transcription failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return "";
  }
}

/**
 * Text-to-speech. Synthesizes the bot's spoken line and returns audio bytes
 * (MP3 by default) ready to be played back to the caller via RingCentral.
 */
export async function synthesizeSpeech(text: string): Promise<Buffer> {
  const response = await client.audio.speech.create({
    model: config.openai.ttsModel,
    voice: config.openai.ttsVoice,
    input: text,
    response_format: "mp3",
  });
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Create an embedding vector for a piece of text. Used by the learning system to
 * embed a rule's situation_summary (on extraction) and the live call situation (on
 * retrieval) for pgvector similarity search. Returns null on failure so callers can
 * fall back to category-based lookup without crashing.
 */
export async function createEmbedding(text: string): Promise<number[] | null> {
  try {
    const result = await client.embeddings.create({
      model: config.openai.embeddingModel,
      input: text,
    });
    return result.data[0]?.embedding ?? null;
  } catch (err) {
    logger.error("Embedding creation failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
