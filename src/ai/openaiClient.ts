import OpenAI from "openai";
import { config } from "../config";

/**
 * Shared OpenAI client, reused across the realtime engine, chat (SMS + learning
 * extraction), speech (STT/TTS), and embeddings so we never spin up duplicate
 * clients. This is now the single AI provider for the whole project — the former
 * Anthropic/Claude client has been retired.
 */
export const openai = new OpenAI({ apiKey: config.openai.apiKey });
