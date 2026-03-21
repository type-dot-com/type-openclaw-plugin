import { describe, expect, test } from "bun:test";
import { createToolEvents, parseToolText } from "./toolEvents.js";

describe("parseToolText", () => {
  test("parses emoji + colon format (summary only)", () => {
    const result = parseToolText("📚 Read: /path/to/file");
    expect(result).toEqual({
      toolName: "Read",
      toolSummary: "/path/to/file",
      toolOutput: "",
      hasFullOutput: false,
    });
  });

  test("parses colon format without emoji", () => {
    const result = parseToolText("search: query results here");
    expect(result).toEqual({
      toolName: "search",
      toolSummary: "query results here",
      toolOutput: "",
      hasFullOutput: false,
    });
  });

  test("uses full text as tool name when no colon present", () => {
    const result = parseToolText("Helpscout Search Conversations");
    expect(result).toEqual({
      toolName: "Helpscout Search Conversations",
      toolSummary: "",
      toolOutput: "",
      hasFullOutput: false,
    });
  });

  test("strips emoji when no colon present", () => {
    const result = parseToolText("🔍 Helpscout Search Conversations");
    expect(result).toEqual({
      toolName: "Helpscout Search Conversations",
      toolSummary: "",
      toolOutput: "",
      hasFullOutput: false,
    });
  });

  test("returns generic 'tool' for empty text", () => {
    const result = parseToolText("");
    expect(result).toEqual({
      toolName: "tool",
      toolSummary: "",
      toolOutput: "",
      hasFullOutput: false,
    });
  });

  test("returns generic 'tool' for whitespace-only text", () => {
    const result = parseToolText("   ");
    expect(result).toEqual({
      toolName: "tool",
      toolSummary: "",
      toolOutput: "",
      hasFullOutput: false,
    });
  });

  // verboseDefault: "full" format tests
  test("parses code fence with txt language tag", () => {
    const text = "📚 Read: /path/to/file\n```txt\nline 1\nline 2\n```";
    const result = parseToolText(text);
    expect(result).toEqual({
      toolName: "Read",
      toolSummary: "/path/to/file",
      toolOutput: "line 1\nline 2",
      hasFullOutput: true,
    });
  });

  test("parses code fence with json language tag", () => {
    const text =
      '🔎 Web Search: for "query" (top 3)\n```json\n{"results": [1, 2, 3]}\n```';
    const result = parseToolText(text);
    expect(result).toEqual({
      toolName: "Web Search",
      toolSummary: 'for "query" (top 3)',
      toolOutput: '{"results": [1, 2, 3]}',
      hasFullOutput: true,
    });
  });

  test("parses code fence with no language tag", () => {
    const text = "Exec: ls -la\n```\nfile1\nfile2\n```";
    const result = parseToolText(text);
    expect(result).toEqual({
      toolName: "Exec",
      toolSummary: "ls -la",
      toolOutput: "file1\nfile2",
      hasFullOutput: true,
    });
  });

  test("parses code fence with multiline output", () => {
    const text =
      "📚 Read: /path/to/file\n```txt\nconst x = 1;\nconst y = 2;\nreturn x + y;\n```";
    const result = parseToolText(text);
    expect(result).toEqual({
      toolName: "Read",
      toolSummary: "/path/to/file",
      toolOutput: "const x = 1;\nconst y = 2;\nreturn x + y;",
      hasFullOutput: true,
    });
  });

  test("parses code fence with empty content", () => {
    const text = "📚 Read: /path/to/file\n```txt\n```";
    const result = parseToolText(text);
    expect(result).toEqual({
      toolName: "Read",
      toolSummary: "/path/to/file",
      toolOutput: "",
      hasFullOutput: true,
    });
  });

  test("parses tool with no colon but with code fence", () => {
    const text =
      'Helpscout Search Conversations\n```json\n{"conversations": []}\n```';
    const result = parseToolText(text);
    expect(result).toEqual({
      toolName: "Helpscout Search Conversations",
      toolSummary: "",
      toolOutput: '{"conversations": []}',
      hasFullOutput: true,
    });
  });

  // Inline multiline format (no code fence)
  test("parses inline multiline — tool name + JSON output", () => {
    const text = 'Browser\n{"targetId": "abc123", "type": "page"}';
    const result = parseToolText(text);
    expect(result).toEqual({
      toolName: "Browser",
      toolSummary: "",
      toolOutput: '{"targetId": "abc123", "type": "page"}',
      hasFullOutput: true,
    });
  });

  test("parses inline multiline — summary line with colon + output", () => {
    const text = "Read: /path/to/file\nline 1\nline 2";
    const result = parseToolText(text);
    expect(result).toEqual({
      toolName: "Read",
      toolSummary: "/path/to/file",
      toolOutput: "line 1\nline 2",
      hasFullOutput: true,
    });
  });

  test("parses inline multiline — emoji + summary + multiline output", () => {
    const text = "🧪 Exec: ls -la\nfile1\nfile2";
    const result = parseToolText(text);
    expect(result).toEqual({
      toolName: "Exec",
      toolSummary: "ls -la",
      toolOutput: "file1\nfile2",
      hasFullOutput: true,
    });
  });
});

describe("createToolEvents", () => {
  test("creates tool-call and tool-result pair from summary", () => {
    const [call, result] = createToolEvents("📚 Read: /path/to/file");
    expect(call.kind).toBe("tool-call");
    expect(result.kind).toBe("tool-result");
    expect(call.toolCallId).toBe(result.toolCallId);
    expect(call.toolName).toBe("Read");
    expect(result.toolName).toBe("Read");
    const input = (call as Record<string, unknown>).input as Record<
      string,
      unknown
    >;
    expect(input).toEqual({ command: "/path/to/file" });
    const outcomes = (result as Record<string, unknown>).outcomes as Array<{
      text: string;
    }>;
    // Without code fence, falls back to toolSummary
    expect(outcomes[0].text).toBe("/path/to/file");
  });

  test("uses provided toolCallId", () => {
    const [call, result] = createToolEvents("search: query", {
      toolCallId: "tc_123",
    });
    expect(call.toolCallId).toBe("tc_123");
    expect(result.toolCallId).toBe("tc_123");
  });

  test("handles tool text without colon", () => {
    const [call, result] = createToolEvents("Helpscout Search Conversations");
    expect(call.toolName).toBe("Helpscout Search Conversations");
    expect(result.toolName).toBe("Helpscout Search Conversations");
    // With no output or summary, the result text falls back to the tool name
    const outcomes = (result as Record<string, unknown>).outcomes as Array<{
      text: string;
    }>;
    expect(outcomes[0].text).toBe("Helpscout Search Conversations");
  });

  test("extracts full output from code fence", () => {
    const text =
      '📚 Read: /path/to/file\n```txt\n{"data": "full content"}\n```';
    const [call, result] = createToolEvents(text);
    expect(call.toolName).toBe("Read");
    const input = (call as Record<string, unknown>).input as Record<
      string,
      unknown
    >;
    expect(input).toEqual({ command: "/path/to/file" });
    const outcomes = (result as Record<string, unknown>).outcomes as Array<{
      text: string;
    }>;
    expect(outcomes[0].text).toBe('{"data": "full content"}');
  });

  test("code fence output takes precedence over summary for result", () => {
    const text = "Exec: pwd\n```\n/home/user\n```";
    const [call, result] = createToolEvents(text);
    expect(call.toolName).toBe("Exec");
    const input = (call as Record<string, unknown>).input as Record<
      string,
      unknown
    >;
    expect(input).toEqual({ command: "pwd" });
    const outcomes = (result as Record<string, unknown>).outcomes as Array<{
      text: string;
    }>;
    expect(outcomes[0].text).toBe("/home/user");
  });

  test("preserves empty output for no-output commands", () => {
    const text = "Exec: true\n```\n```";
    const [_call, result] = createToolEvents(text);
    const outcomes = (result as Record<string, unknown>).outcomes as Array<{
      text: string;
    }>;
    expect(outcomes[0].text).toBe("");
  });

  test("preserves empty output for empty file reads", () => {
    const text = "Read: /tmp/empty.txt\n```txt\n```";
    const [_call, result] = createToolEvents(text);
    const outcomes = (result as Record<string, unknown>).outcomes as Array<{
      text: string;
    }>;
    expect(outcomes[0].text).toBe("");
  });

  test("backwards compatible — works without opts", () => {
    const [call, result] = createToolEvents("📚 Read: /path/to/file");
    expect(call.toolName).toBe("Read");
    expect(result.toolName).toBe("Read");
    const input = (call as Record<string, unknown>).input as Record<
      string,
      unknown
    >;
    expect(input).toEqual({ command: "/path/to/file" });
    const outcomes = (result as Record<string, unknown>).outcomes as Array<{
      text: string;
    }>;
    expect(outcomes[0].text).toBe("/path/to/file");
  });
});
