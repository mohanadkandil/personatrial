import "server-only";

export interface NangoGmailConfig {
  secretKey: string;
  integrationId: string;
}

export interface NangoGmailOptions {
  fetch?: typeof globalThis.fetch;
  /** Deadline for the entire operation, including response bodies. Default: 15s. */
  timeoutMs?: number;
}

export interface GmailConnectionInput {
  /** MUST come from a server-side binding owned by the authenticated user.
   * This adapter verifies access, never ownership. Do not accept a client/model ID.
   */
  connectionId: string;
  signal?: AbortSignal;
}

export interface GmailSearchInput extends GmailConnectionInput {
  query: string;
  /** Default 5, maximum 20. Only the first page is returned. */
  limit?: number;
}

export interface GmailMessage {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
}

export interface NangoGmailAdapter {
  verifyConnection(input: GmailConnectionInput): Promise<{ connected: true }>;
  searchGmail(input: GmailSearchInput): Promise<GmailMessage[]>;
}

export type NangoGmailErrorKind = "retryable" | "auth" | "unavailable";
export type NangoGmailErrorCode =
  | "invalid_config"
  | "invalid_input"
  | "cancelled"
  | "timeout"
  | "network_error"
  | "access_denied"
  | "rate_limited"
  | "provider_unavailable"
  | "invalid_response"
  | "response_too_large";

/** Safe to record by code/kind. Never contains upstream text, query, IDs or tokens. */
export class NangoGmailError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly kind: NangoGmailErrorKind,
    readonly code: NangoGmailErrorCode,
  ) {
    super(`Gmail integration: ${code}`);
    this.name = "NangoGmailError";
    this.retryable = kind === "retryable";
  }
}

const MAX_RESPONSE_BYTES = 128 * 1024;
const MESSAGE_PATH = "/gmail/v1/users/me/messages";
const safeHeader = (value: unknown): value is string =>
  typeof value === "string" && /^[\x21-\x7e]{1,512}$/.test(value);
const validId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,256}$/.test(value);

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NangoGmailError("unavailable", "invalid_response");
  }

  return value as Record<string, unknown>;
}

function boundedText(value: unknown, limit: number): string {
  if (value === undefined) {
    return "";
  }

  if (typeof value !== "string") {
    throw new NangoGmailError("unavailable", "invalid_response");
  }

  return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, limit);
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) {
    throw new NangoGmailError("unavailable", "invalid_response");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      size += value.byteLength;

      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new NangoGmailError("unavailable", "response_too_large");
      }

      text += decoder.decode(value, { stream: true });
    }

    text += decoder.decode();

    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new NangoGmailError("unavailable", "invalid_response");
    }
  } finally {
    reader.releaseLock();
  }
}

function isQuotaError(body: unknown): boolean {
  try {
    const errors = record(record(body).error).errors;

    return (
      Array.isArray(errors) &&
      errors.some((error: unknown) =>
        [
          "rateLimitExceeded",
          "userRateLimitExceeded",
          "dailyLimitExceeded",
          "quotaExceeded",
        ].includes(String(record(error).reason)),
      )
    );
  } catch {
    return false;
  }
}

/** Read-only Gmail through Nango Cloud. No automatic retries or logging.
 * All config is trusted server config; every connectionId must already be owner-verified.
 * Returned email text is untrusted content, not instructions for an agent/tool runner.
 */
export function createNangoGmailAdapter(
  config: NangoGmailConfig,
  options: NangoGmailOptions = {},
): NangoGmailAdapter {
  const { secretKey, integrationId } = config;
  const timeoutMs = options.timeoutMs ?? 15_000;

  if (
    !safeHeader(secretKey) ||
    !safeHeader(integrationId) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 60_000
  ) {
    throw new NangoGmailError("unavailable", "invalid_config");
  }

  const fetcher = options.fetch ?? globalThis.fetch;

  async function operation<T>(
    input: GmailConnectionInput,
    work: (
      get: (path: string, params: URLSearchParams) => Promise<unknown>,
    ) => Promise<T>,
  ): Promise<T> {
    if (!safeHeader(input.connectionId)) {
      throw new NangoGmailError("unavailable", "invalid_input");
    }

    if (input.signal?.aborted) {
      throw new NangoGmailError("unavailable", "cancelled");
    }

    const controller = new AbortController();
    let timedOut = false;
    const cancel = () => controller.abort();

    input.signal?.addEventListener("abort", cancel, { once: true });

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    async function get(
      path: string,
      params: URLSearchParams,
    ): Promise<unknown> {
      controller.signal.throwIfAborted();

      const url = new URL(`/proxy${path}`, "https://api.nango.dev");
      url.search = params.toString();

      const response = await fetcher(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "Provider-Config-Key": integrationId,
          "Connection-Id": input.connectionId,
          // Fixed destination; neither users nor provider payloads select a host.
          "Base-Url-Override": "https://gmail.googleapis.com",
          Retries: "0",
        },
        signal: controller.signal,
        redirect: "error",
        cache: "no-store",
      });

      if (!response.ok) {
        let quota = false;

        if (response.status === 403) {
          // Inspect only a bounded reason enum, never propagate upstream text.
          try {
            quota = isQuotaError(await boundedJson(response));
          } catch {
            /* classify by status */
          }
        } else {
          await response.body?.cancel();
        }

        if (response.status === 429 || quota) {
          throw new NangoGmailError("retryable", "rate_limited");
        }

        if (response.status === 401 || response.status === 403) {
          throw new NangoGmailError("auth", "access_denied");
        }

        throw new NangoGmailError(
          response.status >= 500 || response.status === 408
            ? "retryable"
            : "unavailable",
          "provider_unavailable",
        );
      }

      return boundedJson(response);
    }

    try {
      const result = await work(get);
      controller.signal.throwIfAborted();

      return result;
    } catch (error) {
      if (input.signal?.aborted) {
        throw new NangoGmailError("unavailable", "cancelled");
      }

      if (timedOut) {
        throw new NangoGmailError("retryable", "timeout");
      }

      if (error instanceof NangoGmailError) {
        throw error;
      }

      throw new NangoGmailError("retryable", "network_error");
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", cancel);
      controller.abort();
    }
  }

  return {
    async verifyConnection(input) {
      return operation(input, async (get) => {
        // A q-bearing list probe verifies the actual search capability. A successful
        // Nango connection lookup alone cannot prove current Gmail authorization.
        const body = record(
          await get(
            MESSAGE_PATH,
            new URLSearchParams({
              q: "in:inbox",
              maxResults: "1",
              fields: "resultSizeEstimate",
            }),
          ),
        );

        if (
          !Number.isInteger(body.resultSizeEstimate) ||
          Number(body.resultSizeEstimate) < 0
        ) {
          throw new NangoGmailError("unavailable", "invalid_response");
        }

        return { connected: true as const };
      });
    },

    async searchGmail(input) {
      const limit = input.limit ?? 5;

      if (
        typeof input.query !== "string" ||
        !input.query.trim() ||
        input.query.length > 1024 ||
        /[\u0000-\u001f\u007f]/.test(input.query) ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 20
      ) {
        throw new NangoGmailError("unavailable", "invalid_input");
      }

      return operation(input, async (get) => {
        const list = record(
          await get(
            MESSAGE_PATH,
            new URLSearchParams({
              q: input.query.trim(),
              maxResults: String(limit),
              fields: "messages(id),resultSizeEstimate",
            }),
          ),
        );

        if (list.messages === undefined && list.resultSizeEstimate === 0) {
          return [];
        }

        if (!Array.isArray(list.messages)) {
          throw new NangoGmailError("unavailable", "invalid_response");
        }

        const ids = [
          ...new Set(
            list.messages.slice(0, limit).map((entry: unknown) => {
              const id = record(entry).id;

              if (!validId(id)) {
                throw new NangoGmailError("unavailable", "invalid_response");
              }

              return id;
            }),
          ),
        ];
        const results: GmailMessage[] = [];

        // Four reads at a time; preserve list order and reject partial results on error.
        for (let offset = 0; offset < ids.length; offset += 4) {
          results.push(
            ...(await Promise.all(
              ids.slice(offset, offset + 4).map(async (id) => {
                const params = new URLSearchParams({
                  format: "metadata",
                  fields: "id,threadId,snippet,payload(headers)",
                });

                ["Subject", "From", "Date"].forEach((header) =>
                  params.append("metadataHeaders", header),
                );

                const message = record(
                  await get(
                    `${MESSAGE_PATH}/${encodeURIComponent(id)}`,
                    params,
                  ),
                );

                if (message.id !== id || !validId(message.threadId)) {
                  throw new NangoGmailError("unavailable", "invalid_response");
                }

                const headers =
                  message.payload === undefined
                    ? []
                    : (record(message.payload).headers ?? []);

                if (!Array.isArray(headers)) {
                  throw new NangoGmailError("unavailable", "invalid_response");
                }

                const header = (name: string, max: number) => {
                  const found = headers.find((value: unknown) => {
                    const item = record(value);

                    return (
                      typeof item.name === "string" &&
                      item.name.toLowerCase() === name
                    );
                  });

                  return boundedText(
                    found === undefined ? undefined : record(found).value,
                    max,
                  );
                };

                return {
                  id,
                  threadId: message.threadId,
                  subject: header("subject", 512),
                  from: header("from", 512),
                  date: header("date", 128),
                  snippet: boundedText(message.snippet, 1024),
                };
              }),
            )),
          );
        }

        return results;
      });
    },
  };
}
