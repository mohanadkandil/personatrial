import type { Scope } from "../conversation/types";
import { getDatabase } from "../database";
import { HttpError } from "./responses";

export async function consumeRequestLimit(
  scope: Scope,
  operation: "message" | "call",
): Promise<void> {
  const maximum = operation === "message" ? 30 : 12;
  const windowSeconds = operation === "message" ? 60 : 3600;
  const db = getDatabase();

  const accepted = await db`
    INSERT INTO http_rate_limits (owner_id, operation, window_started_at, request_count)
    VALUES (${scope.ownerId}, ${operation}, now(), 1)
    ON CONFLICT (owner_id, operation) DO UPDATE SET
      request_count = CASE
        WHEN http_rate_limits.window_started_at <= now() - make_interval(secs => ${windowSeconds}) THEN 1
        ELSE http_rate_limits.request_count + 1
      END,
      window_started_at = CASE
        WHEN http_rate_limits.window_started_at <= now() - make_interval(secs => ${windowSeconds}) THEN now()
        ELSE http_rate_limits.window_started_at
      END
    WHERE http_rate_limits.window_started_at <= now() - make_interval(secs => ${windowSeconds})
       OR http_rate_limits.request_count < ${maximum}
    RETURNING owner_id
  `;

  if (!accepted.length) {
    throw new HttpError(
      429,
      "rate_limited",
      operation === "message"
        ? "Please wait a moment before sending more messages."
        : "You’ve reached the call limit for now. We can continue in chat.",
    );
  }
}
