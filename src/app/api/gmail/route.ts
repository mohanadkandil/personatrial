import { resolveMailbox } from "@/server/integrations/mailbox";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getDatabase } from "@/server/database";
import { requireSession } from "@/server/http/session";
import {
  errorResponse,
  HttpError,
  jsonResponse,
  readJson,
  requireSameOrigin,
} from "@/server/http/responses";
import {
  createNangoConnectAdapter,
  NangoConnectError,
} from "@/server/integrations/nango-connect";
import {
  createNangoGmailAdapter,
  NangoGmailError,
} from "@/server/integrations/nango-gmail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const commandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start") }).strict(),
  z.object({ action: z.literal("confirm"), attemptId: z.uuid() }).strict(),
]);

type Attempt = {
  id: string;
  status: "creating" | "pending" | "completed" | "failed" | "cancelled";
  connection_id: string | null;
  integration_id: string;
  expires_at: Date;
  verification_token: string | null;
};

function configuration() {
  const secretKey = process.env.NANGO_SECRET_KEY;
  const integrationId = process.env.NANGO_INTEGRATION_ID;

  if (!secretKey || !integrationId) {
    throw new HttpError(
      503,
      "gmail_unavailable",
      "Gmail connection is not configured yet. We can keep chatting here.",
    );
  }

  return { secretKey, integrationId };
}

function respondToError(error: unknown): Response {
  if (error instanceof NangoConnectError || error instanceof NangoGmailError) {
    const denied =
      error.code === "ownership_mismatch" ||
      error.code === "authorization_failed" ||
      error.code === "access_denied";

    return jsonResponse(
      {
        error: denied ? "gmail_not_verified" : "gmail_unavailable",
        message: denied
          ? "Gmail authorization could not be verified. Please connect again."
          : "Gmail could not connect right now. Please try again shortly.",
      },
      denied ? 409 : 503,
    );
  }

  return errorResponse(error);
}

export async function GET(request: Request): Promise<Response> {
  try {
    const scope = await requireSession(request);
    const db = getDatabase();
    const connection = await resolveMailbox(db, scope);
    const [attempt] = await db<Attempt[]>`
      SELECT id, status, expires_at FROM gmail_connect_attempts
      WHERE owner_id = ${scope.ownerId} ORDER BY created_at DESC LIMIT 1
    `;

    return jsonResponse({
      connected: Boolean(connection),
      attempt: attempt
        ? {
            id: attempt.id,
            status:
              ["pending", "creating"].includes(attempt.status) &&
              attempt.expires_at.getTime() <= Date.now()
                ? "expired"
                : attempt.status,
            expiresAt: attempt.expires_at.toISOString(),
          }
        : null,
    });
  } catch (error) {
    return respondToError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    requireSameOrigin(request);

    const command = await readJson(request, commandSchema, 4096);
    const scope = await requireSession(request);
    const config = configuration();
    const adapter = createNangoConnectAdapter(config);
    const db = getDatabase();

    if (command.action === "start") {
      const attemptId = randomUUID();

      await db.begin(async (tx) => {
        await tx`SELECT id FROM conversations WHERE id = ${scope.conversationId} AND owner_id = ${scope.ownerId} FOR UPDATE`;

        const [{ count }] = await tx`
          SELECT count(*)::int AS count FROM gmail_connect_attempts
          WHERE owner_id = ${scope.ownerId} AND created_at > now() - interval '1 hour'
        `;

        if (count >= 5)
          throw new HttpError(
            429,
            "rate_limited",
            "Please wait before starting another Gmail connection.",
          );

        await tx`
          UPDATE gmail_connect_attempts SET status = 'cancelled'
          WHERE owner_id = ${scope.ownerId} AND status IN ('creating', 'pending')
        `;
        await tx`
          INSERT INTO gmail_connect_attempts (id, owner_id, conversation_id, integration_id, status, expires_at)
          VALUES (${attemptId}, ${scope.ownerId}, ${scope.conversationId}, ${config.integrationId}, 'creating', now() + interval '30 minutes')
        `;
      });

      try {
        const session = await adapter.createSession(scope.ownerId, attemptId);
        const updated = await db`
          UPDATE gmail_connect_attempts SET status = 'pending', expires_at = ${new Date(session.expiresAt)}
          WHERE id = ${attemptId} AND owner_id = ${scope.ownerId} AND status = 'creating'
          RETURNING id
        `;

        if (!updated.length)
          throw new HttpError(
            409,
            "attempt_replaced",
            "A newer Gmail connection was started. Continue with that one.",
          );

        return jsonResponse({
          attemptId,
          expiresAt: session.expiresAt,
          connectUrl: session.connectUrl,
        });
      } catch (error) {
        await db`
          UPDATE gmail_connect_attempts SET status = 'failed'
          WHERE id = ${attemptId} AND owner_id = ${scope.ownerId} AND status = 'creating'
        `;

        throw error;
      }
    }

    const [attempt] = await db<Attempt[]>`
      SELECT * FROM gmail_connect_attempts WHERE id = ${command.attemptId} AND owner_id = ${scope.ownerId}
    `;

    if (!attempt)
      throw new HttpError(
        404,
        "attempt_not_found",
        "This Gmail connection attempt is not available.",
      );

    if (attempt.status === "completed") {
      const [binding] = await db`
        SELECT owner_id FROM gmail_connections WHERE owner_id = ${scope.ownerId} AND connection_id = ${attempt.connection_id}
      `;

      if (!binding)
        throw new HttpError(
          409,
          "attempt_replaced",
          "This Gmail connection is no longer active.",
        );

      return jsonResponse({ connected: true });
    }

    if (
      attempt.status !== "pending" ||
      attempt.expires_at.getTime() <= Date.now() ||
      attempt.integration_id !== config.integrationId
    ) {
      throw new HttpError(
        409,
        "attempt_expired",
        "Please start a new Gmail connection.",
      );
    }

    const verificationToken = randomUUID();
    const claimed = await db`
      UPDATE gmail_connect_attempts
      SET verification_token = ${verificationToken}, verification_until = now() + interval '45 seconds'
      WHERE id = ${attempt.id} AND owner_id = ${scope.ownerId} AND status = 'pending'
        AND expires_at > now() AND next_check_at <= now()
        AND (verification_until IS NULL OR verification_until < now())
      RETURNING id
    `;

    if (!claimed.length)
      return jsonResponse({ connected: false, pending: true }, 202);

    try {
      const connection = await adapter.findOwnedConnection(
        scope.ownerId,
        attempt.id,
      );

      if (!connection)
        return jsonResponse({ connected: false, pending: true }, 202);

      await createNangoGmailAdapter(config).verifyConnection({
        connectionId: connection.connectionId,
      });

      await db.begin(async (tx) => {
        await tx`SELECT id FROM conversations WHERE id = ${scope.conversationId} AND owner_id = ${scope.ownerId} FOR UPDATE`;

        const [current] = await tx<Attempt[]>`
        SELECT * FROM gmail_connect_attempts WHERE id = ${attempt.id} AND owner_id = ${scope.ownerId} FOR UPDATE
      `;

        if (
          !current ||
          !["pending", "completed"].includes(current.status) ||
          (current.status === "pending" &&
            (current.expires_at.getTime() <= Date.now() ||
              current.verification_token !== verificationToken))
        ) {
          throw new HttpError(
            409,
            "attempt_replaced",
            "This Gmail connection attempt is no longer active.",
          );
        }

        if (current.status === "completed") return;

        const [otherOwner] = await tx`
        SELECT owner_id FROM gmail_connections WHERE connection_id = ${connection.connectionId} AND owner_id <> ${scope.ownerId}
      `;

        if (otherOwner)
          throw new HttpError(
            409,
            "gmail_not_verified",
            "Gmail authorization could not be verified.",
          );

        await tx`
        INSERT INTO gmail_connections (owner_id, connection_id, verified_at)
        VALUES (${scope.ownerId}, ${connection.connectionId}, now())
        ON CONFLICT (owner_id) DO UPDATE SET connection_id = EXCLUDED.connection_id, verified_at = EXCLUDED.verified_at
      `;
        await tx`
        UPDATE gmail_connect_attempts SET status = 'completed', connection_id = ${connection.connectionId}, completed_at = now()
        WHERE id = ${attempt.id}
      `;
      });

      return jsonResponse({ connected: true });
    } finally {
      await db`
        UPDATE gmail_connect_attempts
        SET verification_token = NULL, verification_until = NULL, next_check_at = now() + interval '2 seconds'
        WHERE id = ${attempt.id} AND owner_id = ${scope.ownerId} AND verification_token = ${verificationToken}
      `;
    }
  } catch (error) {
    return respondToError(error);
  }
}
