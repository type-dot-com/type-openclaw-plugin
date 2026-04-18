/**
 * Agent tools registered with the Type channel plugin.
 *
 * Extracted from index.ts to keep the plugin entry point slim.
 */

import { getAccountContextForAccount } from "./accountState.js";
import { resolveApiOriginFromWsUrl } from "./apiOrigin.js";
import { setPendingAskUserQuestion } from "./askUserState.js";
import { getInboundRoutingContext } from "./inboundRoutingState.js";

const FETCH_TIMEOUT_MS = 30_000;

type ToolResult = { content: { type: string; text: string }[] };

/**
 * Resolve the API base URL and auth headers for the current account.
 */
function resolveApiContext(): {
  baseUrl: string;
  headers: Record<string, string>;
} | null {
  const ctx = getAccountContextForAccount(null);
  if (!ctx) return null;
  const origin = resolveApiOriginFromWsUrl(ctx.wsUrl);
  if (!origin) return null;
  return {
    baseUrl: `${origin}/api/agents/${ctx.agentId}`,
    headers: {
      Authorization: `Bearer ${ctx.token}`,
      "Content-Type": "application/json",
    },
  };
}

/**
 * Call a Type agent API endpoint with timeout and error handling.
 */
async function callAgentApi(
  method: "GET" | "POST",
  _toolCallId: string,
  path: string,
  label: string,
  body?: Record<string, unknown>,
): Promise<ToolResult> {
  const api = resolveApiContext();
  if (!api) {
    return {
      content: [{ type: "text", text: "Error: No Type account connected." }],
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const url = new URL(`${api.baseUrl}${path}`);
    const channelId = getInboundRoutingContext()?.channelId;
    if (channelId) {
      url.searchParams.set("channelId", channelId);
    }

    const res = await fetch(url.toString(), {
      method,
      headers: api.headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({ error: res.statusText }));
      const errMsg =
        typeof errBody === "object" && errBody !== null && "error" in errBody
          ? String((errBody as { error: unknown }).error)
          : `HTTP ${res.status}`;
      return {
        content: [
          { type: "text", text: `${label} error (${res.status}): ${errMsg}` },
        ],
      };
    }
    const data = await res.json();
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `${label} error: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  } finally {
    clearTimeout(timeout);
  }
}

export const agentTools = [
  {
    name: "ask_user",
    label: "Ask User",
    description:
      "Ask the user a question and wait for their reply. " +
      "Use this when you need clarification, approval, or input before proceeding.",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The question to ask the user",
        },
      },
      required: ["question"],
    },
    execute: async (
      _toolCallId: string,
      args: unknown,
    ): Promise<ToolResult> => {
      const question =
        typeof args === "object" && args !== null && "question" in args
          ? String((args as { question: unknown }).question)
          : "";
      // Store question so messageHandler can retrieve it (deliver callback
      // only receives the formatted tool label, not the question text).
      setPendingAskUserQuestion(_toolCallId, question || undefined);
      return {
        content: [
          { type: "text", text: question || "Waiting for user reply." },
        ],
      };
    },
  },
  {
    name: "find_tools",
    label: "Find Tools",
    description:
      "Discover available integration tools for the current channel. " +
      "Optionally filter by service name (e.g. 'linear', 'github', 'google-calendar'). " +
      "Returns a list of services or, if a service is specified, the full tool schemas for that service. " +
      "Call this to learn what integrations are available before using call_tool.",
    parameters: {
      type: "object",
      properties: {
        service: {
          type: "string",
          description:
            "Optional service name to get detailed tool schemas for (e.g. 'linear', 'github'). " +
            "Omit to list all available services.",
        },
      },
    },
    execute: async (
      _toolCallId: string,
      args: unknown,
    ): Promise<ToolResult> => {
      const parsed =
        typeof args === "object" && args !== null
          ? (args as { service?: unknown })
          : {};
      const service =
        typeof parsed.service === "string" && parsed.service.length > 0
          ? parsed.service
          : null;

      if (service) {
        return callAgentApi(
          "GET",
          _toolCallId,
          `/tools?service=${encodeURIComponent(service)}`,
          "Find tools",
        );
      }
      return callAgentApi("GET", _toolCallId, "/services", "Find tools");
    },
  },
  {
    name: "call_tool",
    label: "Call Tool",
    description:
      "Execute an integration tool discovered via find_tools. " +
      "Provide the service name, tool name, and arguments as returned by find_tools.",
    parameters: {
      type: "object",
      properties: {
        service: {
          type: "string",
          description:
            "The service that owns the tool (e.g. 'linear', 'github')",
        },
        name: {
          type: "string",
          description: "The tool name to execute (from find_tools results)",
        },
        arguments: {
          type: "object",
          description: "Arguments for the tool call, matching the tool schema",
        },
      },
      required: ["service", "name"],
    },
    execute: async (
      _toolCallId: string,
      args: unknown,
    ): Promise<ToolResult> => {
      const parsed =
        typeof args === "object" && args !== null
          ? (args as {
              service?: unknown;
              name?: unknown;
              arguments?: unknown;
            })
          : {};
      const service = String(parsed.service ?? "");
      const name = String(parsed.name ?? "");
      const toolArguments =
        typeof parsed.arguments === "object" && parsed.arguments !== null
          ? (parsed.arguments as Record<string, unknown>)
          : {};

      if (!service || !name) {
        return {
          content: [
            {
              type: "text",
              text: "Error: Both service and name are required.",
            },
          ],
        };
      }

      return callAgentApi("POST", _toolCallId, "/tools/call", "Call tool", {
        service,
        name,
        arguments: toolArguments,
      });
    },
  },
  {
    name: "list_databases",
    label: "List Databases",
    description:
      "List PostgreSQL databases connected to this agent. " +
      "Returns database names, tables, columns, and types. " +
      "Call this first to discover available databases and their schemas before writing SQL queries.",
    parameters: {
      type: "object",
      properties: {},
    },
    execute: async (_toolCallId: string, _args: unknown): Promise<ToolResult> =>
      callAgentApi("GET", _toolCallId, "/postgres", "List databases"),
  },
  {
    name: "postgresql_query",
    label: "PostgreSQL Query",
    description:
      "Execute a read-only SQL SELECT query against a connected PostgreSQL database. " +
      "Use list_databases first to discover available databases and their schemas. " +
      "Only SELECT queries are allowed. Always use LIMIT (10-100 rows) unless aggregating. " +
      "Response includes column metadata with a 'category' field (numeric, temporal, categorical) " +
      "to guide visualization. After getting results, render them using a json-render code block. " +
      'Format: ```json-render { "root": "chart-1", "elements": { "chart-1": { "key": "chart-1", ' +
      '"type": "BarChart", "props": { "title": "Title", "data": [rows], ' +
      '"xAxisKey": "col", "series": [{"dataKey": "col", "name": "Label"}] } } } } ```. ' +
      "Types: BarChart (categories), LineChart (trends), PieChart ({name,value}), AreaChart (cumulative), " +
      "DataTable (columns:[{key,header}] + data), MetricCard ({title,value}). " +
      "Pick by column category: temporal → LineChart/AreaChart, categorical → BarChart, single aggregate → MetricCard.",
    parameters: {
      type: "object",
      properties: {
        integrationId: {
          type: "string",
          description:
            "The integration ID of the database to query (from list_databases)",
        },
        query: {
          type: "string",
          description: "The SQL SELECT query to execute (max 10000 characters)",
        },
      },
      required: ["integrationId", "query"],
    },
    execute: async (
      _toolCallId: string,
      args: unknown,
    ): Promise<ToolResult> => {
      const parsed =
        typeof args === "object" && args !== null
          ? (args as { integrationId?: unknown; query?: unknown })
          : {};
      const integrationId = String(parsed.integrationId ?? "");
      const query = String(parsed.query ?? "");

      if (!integrationId || !query) {
        return {
          content: [
            {
              type: "text",
              text: "Error: Both integrationId and query are required.",
            },
          ],
        };
      }

      return callAgentApi("POST", _toolCallId, "/postgres/query", "Query", {
        integrationId,
        query,
      });
    },
  },
];
