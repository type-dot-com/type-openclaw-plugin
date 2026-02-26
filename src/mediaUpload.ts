import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { resolveApiOriginFromWsUrl } from "./apiOrigin.js";

const FALLBACK_FILENAME = "attachment";
const FALLBACK_MIME_TYPE = "application/octet-stream";
const NETWORK_TIMEOUT_MS = 15_000;

const EXTENSION_TO_MIME_TYPE: Record<string, string> = {
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".zip": "application/zip",
};

interface TypeUploadUrlResponse {
  fileId: string;
  uploadUrl: string;
}

const typeUploadUrlResponseSchema = z.object({
  fileId: z.string().min(1),
  uploadUrl: z.string().url(),
});

export interface TypeOutboundAccountContext {
  token: string;
  wsUrl: string;
  agentId: string;
}

export interface UploadedMediaResult {
  fileId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

interface ResolvedMediaSource {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
}

function isHttpMediaUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

function inferMimeTypeFromFilename(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return EXTENSION_TO_MIME_TYPE[ext] ?? FALLBACK_MIME_TYPE;
}

function parseContentDispositionFilename(
  contentDisposition: string | null,
): string | null {
  if (!contentDisposition) {
    return null;
  }

  const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(contentDisposition);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }

  const asciiMatch = /filename="?([^";]+)"?/i.exec(contentDisposition);
  return asciiMatch?.[1] ?? null;
}

function sanitizeFilename(rawFilename: string | null | undefined): string {
  if (!rawFilename) {
    return FALLBACK_FILENAME;
  }

  const normalized = rawFilename.trim();
  if (!normalized) {
    return FALLBACK_FILENAME;
  }

  const basename = path.basename(normalized);
  return basename || FALLBACK_FILENAME;
}

function filenameFromUrl(mediaUrl: string): string {
  try {
    const parsed = new URL(mediaUrl);
    const decodedPath = decodeURIComponent(parsed.pathname);
    return sanitizeFilename(path.basename(decodedPath));
  } catch {
    return FALLBACK_FILENAME;
  }
}

function resolveLocalFilePath(mediaUrl: string): string {
  if (mediaUrl.startsWith("file://")) {
    const parsed = new URL(mediaUrl);
    return decodeURIComponent(parsed.pathname);
  }
  return path.resolve(mediaUrl);
}

function isPathWithinRoot(candidatePath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function assertLocalPathAllowed(
  localPath: string,
  mediaLocalRoots?: readonly string[],
): void {
  if (!mediaLocalRoots || mediaLocalRoots.length === 0) {
    throw new Error(
      "Local media uploads require at least one allowed mediaLocalRoots entry",
    );
  }

  const normalizedPath = path.resolve(localPath);
  const isAllowed = mediaLocalRoots.some((root) =>
    isPathWithinRoot(normalizedPath, path.resolve(root)),
  );

  if (!isAllowed) {
    throw new Error(
      `Local media path is outside allowed roots: ${normalizedPath}`,
    );
  }
}

async function fetchWithTimeout(
  input: string | URL | Request,
  init: RequestInit = {},
  timeoutMs = NETWORK_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      const endpoint =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      throw new Error(
        `Timed out after ${timeoutMs}ms while calling ${endpoint}`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function resolveRemoteMedia(
  mediaUrl: string,
): Promise<ResolvedMediaSource> {
  const response = await fetchWithTimeout(mediaUrl);
  if (!response.ok) {
    throw new Error(`Failed to download media (HTTP ${response.status})`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const dispositionFilename = parseContentDispositionFilename(
    response.headers.get("content-disposition"),
  );
  const filename = sanitizeFilename(
    dispositionFilename ?? filenameFromUrl(mediaUrl),
  );

  const contentTypeHeader = response.headers.get("content-type");
  const mimeType =
    contentTypeHeader?.split(";")[0]?.trim() ||
    inferMimeTypeFromFilename(filename);

  return {
    bytes,
    filename,
    mimeType,
  };
}

async function resolveLocalMedia(params: {
  mediaUrl: string;
  mediaLocalRoots?: readonly string[];
}): Promise<ResolvedMediaSource> {
  const localPath = resolveLocalFilePath(params.mediaUrl);
  assertLocalPathAllowed(localPath, params.mediaLocalRoots);

  const bytes = await readFile(localPath);
  const filename = sanitizeFilename(path.basename(localPath));
  const mimeType = inferMimeTypeFromFilename(filename);

  return {
    bytes,
    filename,
    mimeType,
  };
}

async function resolveMediaSource(params: {
  mediaUrl: string;
  mediaLocalRoots?: readonly string[];
}): Promise<ResolvedMediaSource> {
  if (isHttpMediaUrl(params.mediaUrl)) {
    return resolveRemoteMedia(params.mediaUrl);
  }
  return resolveLocalMedia(params);
}

async function readUploadUrlResponse(
  response: Response,
): Promise<TypeUploadUrlResponse> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Failed to parse upload URL response");
  }

  const parseResult = typeUploadUrlResponseSchema.safeParse(payload);
  if (!parseResult.success) {
    throw new Error("Upload URL response was missing required fields");
  }

  return parseResult.data;
}

export async function uploadMediaForType(params: {
  mediaUrl: string;
  mediaLocalRoots?: readonly string[];
  channelId: string;
  account: TypeOutboundAccountContext;
}): Promise<UploadedMediaResult> {
  const { mediaUrl, mediaLocalRoots, channelId, account } = params;
  if (!account.token) {
    throw new Error("Type token is required for media uploads");
  }
  if (!account.agentId) {
    throw new Error("Type agentId is required for media uploads");
  }

  const apiOrigin = resolveApiOriginFromWsUrl(account.wsUrl);
  if (!apiOrigin) {
    throw new Error(`Invalid wsUrl for Type media upload: ${account.wsUrl}`);
  }

  const media = await resolveMediaSource({ mediaUrl, mediaLocalRoots });

  const uploadUrlEndpoint = `${apiOrigin}/api/agents/${encodeURIComponent(account.agentId)}/files/upload-url`;
  const uploadUrlResponse = await fetchWithTimeout(uploadUrlEndpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${account.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      filename: media.filename,
      mimeType: media.mimeType,
      sizeBytes: media.bytes.byteLength,
      channelId,
    }),
  });

  if (!uploadUrlResponse.ok) {
    const errorBody = await uploadUrlResponse.text();
    throw new Error(
      `Failed to create upload URL (HTTP ${uploadUrlResponse.status}): ${errorBody || "unknown error"}`,
    );
  }

  const uploadSpec = await readUploadUrlResponse(uploadUrlResponse);

  const uploadResponse = await fetchWithTimeout(uploadSpec.uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": media.mimeType,
    },
    body: new Uint8Array(media.bytes).buffer,
  });

  if (!uploadResponse.ok) {
    throw new Error(
      `Failed to upload media bytes (HTTP ${uploadResponse.status})`,
    );
  }

  const confirmEndpoint = `${apiOrigin}/api/agents/${encodeURIComponent(account.agentId)}/files/confirm-upload`;
  const confirmResponse = await fetchWithTimeout(confirmEndpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${account.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      fileId: uploadSpec.fileId,
    }),
  });

  if (!confirmResponse.ok) {
    const errorBody = await confirmResponse.text();
    throw new Error(
      `Failed to confirm media upload (HTTP ${confirmResponse.status}): ${errorBody || "unknown error"}`,
    );
  }

  return {
    fileId: uploadSpec.fileId,
    filename: media.filename,
    mimeType: media.mimeType,
    sizeBytes: media.bytes.byteLength,
  };
}
