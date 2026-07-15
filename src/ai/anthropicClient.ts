import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config";

/**
 * Single shared Anthropic client, reused by the live conversation engine and the
 * learning system's lesson extractor so we never spin up duplicate clients.
 */
export const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

/** Convenience: pull the first text block out of a Claude message response. */
export function firstTextBlock(content: Anthropic.Messages.ContentBlock[]): string {
  const block = content.find((b) => b.type === "text");
  return block && block.type === "text" ? block.text : "";
}
