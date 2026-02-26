import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { uploadMediaForType } from "./mediaUpload.js";

describe("uploadMediaForType", () => {
  test("uploads remote media, then confirms and returns file ID", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{
      url: string;
      method: string;
      body?: string;
    }> = [];

    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? init.body : undefined;
      calls.push({ url, method, body });

      if (url === "https://cdn.example.com/report.pdf") {
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: {
            "Content-Type": "application/pdf",
          },
        });
      }

      if (
        url === "https://type.example.com/api/agents/agent_123/files/upload-url"
      ) {
        return new Response(
          JSON.stringify({
            fileId: "file_abc",
            uploadUrl: "https://uploads.example.com/r2-put-url",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      if (url === "https://uploads.example.com/r2-put-url") {
        const uploadedArrayBuffer =
          init?.body instanceof ArrayBuffer ? init.body : null;
        expect(uploadedArrayBuffer).not.toBeNull();
        expect(uploadedArrayBuffer?.byteLength).toBe(4);
        return new Response(null, { status: 200 });
      }

      if (
        url ===
        "https://type.example.com/api/agents/agent_123/files/confirm-upload"
      ) {
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    }) as typeof fetch;

    try {
      const result = await uploadMediaForType({
        mediaUrl: "https://cdn.example.com/report.pdf",
        channelId: "ch_123",
        account: {
          token: "ta_test",
          wsUrl: "wss://type.example.com/api/agents/ws",
          agentId: "agent_123",
        },
      });

      expect(result).toEqual({
        fileId: "file_abc",
        filename: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 4,
      });

      const uploadUrlCall = calls.find((call) =>
        call.url.endsWith("upload-url"),
      );
      expect(uploadUrlCall).toBeDefined();
      expect(uploadUrlCall?.method).toBe("POST");
      expect(uploadUrlCall?.body).toBe(
        JSON.stringify({
          filename: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 4,
          channelId: "ch_123",
        }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects local media paths outside mediaLocalRoots", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "type-openclaw-"));
    const mediaPath = path.join(tempDir, "private.txt");
    await writeFile(mediaPath, "secret");

    try {
      await expect(
        uploadMediaForType({
          mediaUrl: mediaPath,
          mediaLocalRoots: [path.join(tempDir, "allowed")],
          channelId: "ch_123",
          account: {
            token: "ta_test",
            wsUrl: "wss://type.example.com/api/agents/ws",
            agentId: "agent_123",
          },
        }),
      ).rejects.toThrow("outside allowed roots");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
