import "server-only";
import { z } from "zod";

export class NangoConnectError extends Error {
  constructor(
    public readonly code:
      | "invalid_config"
      | "invalid_input"
      | "invalid_response"
      | "ownership_mismatch"
      | "authorization_failed"
      | "provider_unavailable"
      | "timeout"
      | "response_too_large",
  ) {
    super(code);
    this.name = "NangoConnectError";
  }
}

const identifier = z.uuid();
const printable = z.string().regex(/^[\x21-\x7e]+$/);
const sessionSchema = z.object({
  data: z.object({
    token: printable.min(1).max(2048),
    expires_at: z.string().datetime({ offset: true }),
    connect_link: z.string().url().max(4096).optional(),
  }),
});
const connectionsSchema = z.object({
  connections: z
    .array(
      z.object({
        connection_id: printable.min(1).max(256),
        provider_config_key: z.string().min(1).max(512),
        tags: z.record(z.string(), z.string()),
        errors: z.array(z.object({ type: z.string() })),
      }),
    )
    .max(10),
});

export function createNangoConnectAdapter(
  config: { secretKey: string; integrationId: string },
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
) {
  const timeoutMs = options.timeoutMs ?? 15_000;

  if (
    !printable.min(1).max(512).safeParse(config.secretKey).success ||
    !printable.min(1).max(512).safeParse(config.integrationId).success ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 60_000
  ) {
    throw new NangoConnectError("invalid_config");
  }

  const fetcher = options.fetch ?? globalThis.fetch;

  function validateIdentity(ownerId: string, attemptId: string) {
    if (
      !identifier.safeParse(ownerId).success ||
      !identifier.safeParse(attemptId).success
    ) {
      throw new NangoConnectError("invalid_input");
    }
  }

  async function request(path: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetcher(new URL(path, "https://api.nango.dev"), {
        ...init,
        headers: {
          Authorization: `Bearer ${config.secretKey}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
        redirect: "error",
        cache: "no-store",
      });

      if (!response.ok) {
        await response.body?.cancel();
        throw new NangoConnectError("provider_unavailable");
      }

      if (!response.body) throw new NangoConnectError("invalid_response");

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let text = "";
      let size = 0;

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) break;

          size += value.byteLength;

          if (size > 64 * 1024) {
            await reader.cancel();
            throw new NangoConnectError("response_too_large");
          }

          text += decoder.decode(value, { stream: true });
        }

        text += decoder.decode();
      } finally {
        reader.releaseLock();
      }

      controller.signal.throwIfAborted();

      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new NangoConnectError("invalid_response");
      }
    } catch (error) {
      if (controller.signal.aborted) throw new NangoConnectError("timeout");
      if (error instanceof NangoConnectError) throw error;

      throw new NangoConnectError("provider_unavailable");
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  return {
    async createSession(ownerId: string, attemptId: string) {
      validateIdentity(ownerId, attemptId);

      const payload = await request("/connect/sessions", {
        method: "POST",
        body: JSON.stringify({
          tags: { end_user_id: ownerId, persona_attempt_id: attemptId },
          allowed_integrations: [config.integrationId],
        }),
      });
      const result = sessionSchema.safeParse(payload);

      if (!result.success) throw new NangoConnectError("invalid_response");

      const {
        token,
        expires_at: expiresAt,
        connect_link: connectUrl,
      } = result.data.data;
      const expiry = Date.parse(expiresAt);

      if (expiry <= Date.now() || expiry > Date.now() + 35 * 60 * 1000) {
        throw new NangoConnectError("invalid_response");
      }

      if (connectUrl) {
        const link = new URL(connectUrl);

        if (
          link.origin !== "https://connect.nango.dev" ||
          link.username ||
          link.password
        ) {
          throw new NangoConnectError("invalid_response");
        }
      }

      const link = connectUrl
        ? new URL(connectUrl)
        : new URL("https://connect.nango.dev/");

      if (!connectUrl) link.searchParams.set("session_token", token);

      return { connectUrl: link.toString(), expiresAt };
    },

    async findOwnedConnection(ownerId: string, attemptId: string) {
      validateIdentity(ownerId, attemptId);

      const params = new URLSearchParams({
        "tags[end_user_id]": ownerId,
        "tags[persona_attempt_id]": attemptId,
        limit: "10",
      });
      const payload = await request(`/connections?${params}`, {
        method: "GET",
      });
      const result = connectionsSchema.safeParse(payload);

      if (!result.success) throw new NangoConnectError("invalid_response");
      if (result.data.connections.length === 0) return null;

      if (result.data.connections.length !== 1) {
        throw new NangoConnectError("ownership_mismatch");
      }

      const connection = result.data.connections[0];

      if (
        connection.provider_config_key !== config.integrationId ||
        connection.tags.end_user_id !== ownerId ||
        connection.tags.persona_attempt_id !== attemptId
      ) {
        throw new NangoConnectError("ownership_mismatch");
      }

      if (connection.errors.some((error) => error.type === "auth")) {
        throw new NangoConnectError("authorization_failed");
      }

      return { connectionId: connection.connection_id };
    },
  };
}
