import { z } from "zod";
import type { ConversationSnapshot } from "@/shared/conversation";
import { ConversationService } from "@/server/conversation/service";
import { getDatabase } from "@/server/database";
import { dispatchAfterResponse } from "@/server/http/dispatch";
import { consumeRequestLimit } from "@/server/http/rate-limit";
import {
  getOrCreateSession,
  requireSession,
  resetSession,
} from "@/server/http/session";
import {
  errorResponse,
  HttpError,
  jsonResponse,
  readJson,
  requireSameOrigin,
} from "@/server/http/responses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const commandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("bootstrap") }).strict(),
  z
    .object({
      type: z.literal("reset"),
      disconnectGmail: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("message"),
      eventId: z.uuid(),
      text: z.string().trim().min(1).max(8000),
    })
    .strict(),
  z
    .object({
      type: z.literal("ack"),
      messageIds: z.array(z.uuid()).max(100),
    })
    .strict(),
  z
    .object({
      type: z.literal("cancel"),
      taskId: z.uuid(),
    })
    .strict(),
]);

function publicSnapshot(
  snapshot: Awaited<ReturnType<ConversationService["snapshot"]>>,
): ConversationSnapshot {
  return {
    sequence: snapshot.sequence,
    profile: snapshot.profile,
    gmailConnected: snapshot.gmailConnected,
    gmailSource: snapshot.gmailSource,
    cursor: snapshot.cursor,
    hasMore: snapshot.hasMore,
    messages: snapshot.messages,
    tasks: snapshot.tasks,
  };
}

export async function GET(request: Request): Promise<Response> {
  try {
    const scope = await requireSession(request);
    const rawCursor = new URL(request.url).searchParams.get("after") ?? "0";
    const cursor = Number(rawCursor);

    if (!/^\d+$/.test(rawCursor) || !Number.isSafeInteger(cursor)) {
      throw new HttpError(
        400,
        "invalid_input",
        "The message cursor is invalid.",
      );
    }

    const service = new ConversationService(getDatabase());

    return jsonResponse(publicSnapshot(await service.snapshot(scope, cursor)));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    requireSameOrigin(request);

    const command = await readJson(request, commandSchema);
    const service = new ConversationService(getDatabase());

    if (command.type === "bootstrap") {
      const session = await getOrCreateSession(request);
      const snapshot = await service.snapshot(session.scope);
      const headers = session.setCookie
        ? { "Set-Cookie": session.setCookie }
        : undefined;

      return jsonResponse(publicSnapshot(snapshot), 200, headers);
    }

    if (command.type === "reset") {
      const session = await resetSession(request, {
        disconnectGmail: command.disconnectGmail,
      });
      const snapshot = await service.snapshot(session.scope);

      return jsonResponse(publicSnapshot(snapshot), 200, {
        "Set-Cookie": session.setCookie,
      });
    }

    const scope = await requireSession(request);

    if (command.type === "message") {
      await consumeRequestLimit(scope, "message");

      const input = await service.appendInput(scope, {
        sourceEventId: `chat:${command.eventId}`,
        channel: "chat",
        text: command.text,
        revision: 1,
        final: true,
      });

      dispatchAfterResponse();

      return jsonResponse(
        { evidenceId: input.id, sequence: input.conversationSequence },
        202,
      );
    }

    if (command.type === "ack") {
      await service.acknowledgeRendered(scope, command.messageIds);

      return jsonResponse({ acknowledged: true });
    }

    const cancelled = await service.cancelTask(scope, command.taskId);

    dispatchAfterResponse();

    return jsonResponse({ cancelled });
  } catch (error) {
    return errorResponse(error);
  }
}
