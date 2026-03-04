/**
 * Agent tools registered with the Type channel plugin.
 *
 * Extracted from index.ts to keep the plugin entry point slim.
 */

import { setPendingAskUserQuestion } from "./askUserState.js";

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
    ): Promise<{
      content: { type: string; text: string }[];
    }> => {
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
];
