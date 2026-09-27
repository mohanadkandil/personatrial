import { z } from "zod";
import { ConversationError } from "../conversation/types";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly publicMessage: string,
  ) {
    super(code);
    this.name = "HttpError";
  }
}

export function applicationUrl(): URL {
  const configured = process.env.APP_URL;

  if (!configured) {
    throw new HttpError(
      503,
      "not_configured",
      "The service is not configured yet.",
    );
  }

  let url: URL;

  try {
    url = new URL(configured);
  } catch {
    throw new HttpError(
      503,
      "not_configured",
      "The service is not configured yet.",
    );
  }

  if (
    !["http:", "https:"].includes(url.protocol) ||
    (process.env.NODE_ENV === "production" && url.protocol !== "https:")
  ) {
    throw new HttpError(
      503,
      "not_configured",
      "The service is not configured yet.",
    );
  }

  return url;
}

export function requireSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");

  if (origin !== applicationUrl().origin) {
    throw new HttpError(403, "origin_rejected", "This request is not allowed.");
  }
}

export async function readJson<T>(
  request: Request,
  schema: z.ZodType<T>,
  maxBytes = 24_000,
): Promise<T> {
  if (
    request.headers.get("content-type")?.split(";")[0].trim() !==
    "application/json"
  ) {
    throw new HttpError(415, "unsupported_media_type", "Send a JSON request.");
  }

  const length = Number(request.headers.get("content-length") ?? 0);

  if (length > maxBytes) {
    throw new HttpError(413, "body_too_large", "This message is too large.");
  }

  const reader = request.body?.getReader();

  if (!reader) {
    throw new HttpError(400, "invalid_input", "The request is incomplete.");
  }

  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    while (true) {
      const chunk = await reader.read();

      if (chunk.done) break;

      size += chunk.value.byteLength;

      if (size > maxBytes) {
        await reader.cancel();
        throw new HttpError(
          413,
          "body_too_large",
          "This message is too large.",
        );
      }

      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    throw new HttpError(400, "invalid_input", "The request is not valid JSON.");
  }

  const result = schema.safeParse(parsed);

  if (!result.success) {
    throw new HttpError(
      400,
      "invalid_input",
      "Please check the request and try again.",
    );
  }

  return result.data;
}

export function jsonResponse(
  value: unknown,
  status = 200,
  additionalHeaders?: HeadersInit,
): Response {
  const headers = new Headers(additionalHeaders);
  headers.set("Cache-Control", "private, no-store, max-age=0");
  headers.set("Vary", "Cookie");
  headers.set("X-Content-Type-Options", "nosniff");

  return Response.json(value, { status, headers });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return jsonResponse(
      { error: error.code, message: error.publicMessage },
      error.status,
    );
  }

  if (error instanceof ConversationError) {
    const status = { not_found: 404, invalid_input: 400, conflict: 409 }[
      error.code
    ];
    const message = {
      not_found: "This conversation item is not available.",
      invalid_input: "Please check the request and try again.",
      conflict: "The conversation changed. Please try again.",
    }[error.code];

    return jsonResponse({ error: error.code, message }, status);
  }

  return jsonResponse(
    {
      error: "temporarily_unavailable",
      message: "Something went wrong. Please try again shortly.",
    },
    503,
  );
}
