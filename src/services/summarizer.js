/**
 * Conversation summarization — used to keep LLM prompts within context
 * budget as chats grow. We summarize older turns into a single system
 * message and only keep the most recent N turns verbatim.
 */

import { callLLM } from "./llm.js";

const KEEP_RECENT = parseInt(process.env.SUMMARY_KEEP_RECENT || "6", 10);
const TRIGGER_AT = parseInt(process.env.SUMMARY_TRIGGER_AT || "12", 10);

/**
 * Given a list of messages [{role,content}], return the same list but with
 * older turns collapsed into a single `system`-style summary. A no-op if the
 * message list is short enough.
 */
export async function summarizeIfNeeded(messages, llmOpts = {}) {
  if (!messages || messages.length <= TRIGGER_AT) return messages;

  const keepFrom = messages.length - KEEP_RECENT;
  const older = messages.slice(0, keepFrom);
  const recent = messages.slice(keepFrom);

  const transcript = older
    .map((m) => `${m.role.toUpperCase()}: ${(m.content || "").slice(0, 800)}`)
    .join("\n\n");

  const prompt =
    `Summarize the following OpenShift support conversation into a concise context ` +
    `note (under 300 words). Preserve: namespaces, pod/deployment names, error types, ` +
    `decisions made, and any pending actions. Output plain text, no prose framing.\n\n${transcript}`;

  let summary = "";
  try {
    const r = await callLLM({
      messages: [{ role: "user", content: prompt }],
      system: "You are a concise technical summarizer for SRE conversations.",
      maxTokens: 500,
      temperature: 0,
      ...llmOpts,
    });
    summary = r.text || "";
  } catch {
    return messages; // Graceful fallback — keep the original
  }

  if (!summary) return messages;

  return [
    {
      role: "system",
      content: `[Conversation summary of ${older.length} earlier turns]\n${summary}`,
    },
    ...recent,
  ];
}
