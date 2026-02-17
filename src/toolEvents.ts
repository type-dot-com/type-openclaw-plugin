import { z } from "zod";

/**
 * Tool Event Parsing
 *
 * Parses OpenClaw's formatted tool output text into structured
 * tool-call and tool-result stream events for Type's UI.
 */

export const ToolEventPayloadSchema = z
  .object({
    kind: z.string(),
  })
  .passthrough();

export type ToolEventPayload = z.infer<typeof ToolEventPayloadSchema>;

/**
 * Parse formatted tool text into a tool name and output.
 *
 * OpenClaw formats tool output like:
 *   "📚 Read: /path/to/file"
 *   "🧪 Exec: command here\noutput..."
 *
 * Strips leading emoji, splits on first colon.
 */
export function parseToolText(text: string): {
  toolName: string;
  toolOutput: string;
} {
  const trimmed = text.trim();
  // Strip leading emoji (unicode emoji + variation selectors + ZWJ)
  const stripped = trimmed.replace(/^(?:\p{Emoji}|\uFE0F|\u200D)+\s*/u, "");
  const colonIdx = stripped.indexOf(":");
  if (colonIdx > 0) {
    return {
      toolName: stripped.slice(0, colonIdx).trim(),
      toolOutput: stripped.slice(colonIdx + 1).trim(),
    };
  }
  return { toolName: "tool", toolOutput: stripped };
}

/**
 * Create a tool-call + tool-result event pair from formatted tool text.
 * Returns a 2-element array: [tool-call, tool-result].
 */
export function createToolEvents(
  text: string,
): [ToolEventPayload, ToolEventPayload] {
  const { toolName, toolOutput } = parseToolText(text);
  const toolCallId = `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  return [
    {
      kind: "tool-call",
      toolCallId,
      toolName,
      input: toolOutput ? { command: toolOutput.split("\n")[0] } : {},
    },
    {
      kind: "tool-result",
      toolCallId,
      toolName,
      outcomes: [{ kind: "text", toolName, text: toolOutput }],
    },
  ];
}
