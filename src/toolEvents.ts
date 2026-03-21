import { z } from "zod";

/**
 * Tool Event Parsing
 *
 * Parses OpenClaw's formatted tool output text into structured
 * tool-call and tool-result stream events for Type's UI.
 *
 * With `verboseDefault: "full"`, OpenClaw sends tool output as:
 *   "📚 Read: /path/to/file\n```txt\nactual file content\n```"
 *
 * With `verboseDefault: "on"`, only summaries are sent:
 *   "📚 Read: /path/to/file"
 */

export const ToolEventPayloadSchema = z
  .object({
    kind: z.string(),
  })
  .passthrough();

export type ToolEventPayload = z.infer<typeof ToolEventPayloadSchema>;

export interface ParsedToolText {
  toolName: string;
  /** Text after colon on summary line (e.g., "/path/to/file") */
  toolSummary: string;
  /** Actual tool output from code fence (empty if no fence present) */
  toolOutput: string;
  /** Whether a code fence was found (indicates verboseDefault: "full") */
  hasFullOutput: boolean;
}

/**
 * Split a summary line on the first colon into name and metadata.
 */
function parseSummaryLine(line: string): { name: string; summary: string } {
  const colonIdx = line.indexOf(":");
  if (colonIdx > 0) {
    return {
      name: line.slice(0, colonIdx).trim(),
      summary: line.slice(colonIdx + 1).trim(),
    };
  }
  return { name: line || "tool", summary: "" };
}

/**
 * Extract text content from inside a markdown code fence block.
 * Input starts with "```lang\n..." and ends with "\n```".
 */
function extractCodeFenceContent(fenceBlock: string): string {
  // Skip the opening "```lang" line
  const openEnd = fenceBlock.indexOf("\n");
  if (openEnd < 0) return "";
  const afterOpen = fenceBlock.slice(openEnd + 1);
  // Empty fence: closing ``` immediately follows opening line
  if (/^```\s*$/.test(afterOpen)) return "";
  // Strip trailing closing fence
  return afterOpen.replace(/\n```\s*$/, "");
}

/**
 * Parse formatted tool text into structured fields.
 *
 * Handles three formats:
 *
 * **Code fence** (verboseDefault: "full"):
 *   "📚 Read: /path/to/file\n```txt\nactual content\n```"
 *   → toolName="Read", toolSummary="/path/to/file", toolOutput="actual content"
 *
 * **Inline multiline** (verboseDefault: "full", no code fence):
 *   "Browser\n{\"targetId\": \"abc\"}"
 *   → toolName="Browser", toolSummary="", toolOutput="{\"targetId\": \"abc\"}"
 *
 * **Single line** (verboseDefault: "on", summary only):
 *   "📚 Read: /path/to/file"
 *   → toolName="Read", toolSummary="/path/to/file", toolOutput=""
 */
export function parseToolText(text: string): ParsedToolText {
  const trimmed = text.trim();
  // Strip leading emoji (unicode emoji + variation selectors + ZWJ)
  const stripped = trimmed.replace(/^(?:\p{Emoji}|\uFE0F|\u200D)+\s*/u, "");

  // Check for code fence (verboseDefault: "full" code fence format)
  const fenceIdx = stripped.indexOf("\n```");
  if (fenceIdx >= 0) {
    const summaryLine = stripped.slice(0, fenceIdx).trim();
    const fenceBlock = stripped.slice(fenceIdx + 1);
    const { name, summary } = parseSummaryLine(summaryLine);
    const output = extractCodeFenceContent(fenceBlock);
    return {
      toolName: name,
      toolSummary: summary,
      toolOutput: output,
      hasFullOutput: true,
    };
  }

  // Check for multiline text without code fence (verboseDefault: "full" inline format).
  // First line is the summary, remaining lines are the tool output.
  const newlineIdx = stripped.indexOf("\n");
  if (newlineIdx >= 0) {
    const summaryLine = stripped.slice(0, newlineIdx).trim();
    const output = stripped.slice(newlineIdx + 1).trim();
    const { name, summary } = parseSummaryLine(summaryLine);
    return {
      toolName: name,
      toolSummary: summary,
      toolOutput: output,
      hasFullOutput: true,
    };
  }

  // Single line — summary only (verboseDefault: "on")
  const { name, summary } = parseSummaryLine(stripped);
  return {
    toolName: name,
    toolSummary: summary,
    toolOutput: "",
    hasFullOutput: false,
  };
}

/**
 * Create a tool-call + tool-result event pair from formatted tool text.
 * Returns a 2-element array: [tool-call, tool-result].
 */
export function createToolEvents(
  text: string,
  opts?: { toolCallId?: string },
): [ToolEventPayload, ToolEventPayload] {
  const { toolName, toolSummary, toolOutput, hasFullOutput } =
    parseToolText(text);
  const toolCallId =
    opts?.toolCallId ??
    `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // When full output is present, use it as-is (even if empty — an empty
  // result is meaningful, e.g. a no-output command or empty file).
  // Only fall back to summary/name in summary-only mode.
  const displayOutput = hasFullOutput ? toolOutput : toolSummary || toolName;

  return [
    {
      kind: "tool-call",
      toolCallId,
      toolName,
      input: toolSummary ? { command: toolSummary.split("\n")[0] } : {},
    },
    {
      kind: "tool-result",
      toolCallId,
      toolName,
      outcomes: [{ kind: "text", toolName, text: displayOutput }],
    },
  ];
}
