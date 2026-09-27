import { randomUUID } from "node:crypto";
import {
  AccessToken,
  AgentDispatchClient,
  RoomServiceClient,
  TrackSource,
} from "livekit-server-sdk";
import { z } from "zod";
import { ConversationService } from "@/server/conversation/service";
import { getDatabase } from "@/server/database";
import { dispatchAfterResponse } from "@/server/http/dispatch";
import { consumeRequestLimit } from "@/server/http/rate-limit";
import { requireSession } from "@/server/http/session";
import {
  errorResponse,
  HttpError,
  jsonResponse,
  readJson,
  requireSameOrigin,
} from "@/server/http/responses";
import { signVoiceSession } from "@/voice/session-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const commandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start") }).strict(),
  z.object({ action: z.literal("ready"), callId: z.uuid() }).strict(),
  z
    .object({
      action: z.literal("end"),
      callId: z.uuid(),
      reason: z.enum(["hangup", "goodbye", "cancel"]),
    })
    .strict(),
]);

function voiceConfiguration() {
  const url = process.env.LIVEKIT_URL;
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const signingSecret = process.env.VOICE_SESSION_SECRET;

  if (
    !url ||
    !apiKey ||
    !apiSecret ||
    !signingSecret ||
    Buffer.byteLength(signingSecret) < 32
  ) {
    throw new HttpError(
      503,
      "voice_unavailable",
      "Calling is not configured yet. We can keep chatting here.",
    );
  }

  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    throw new HttpError(
      503,
      "voice_unavailable",
      "Calling is unavailable right now.",
    );
  }

  if (!["wss:", "ws:", "https:", "http:"].includes(parsed.protocol)) {
    throw new HttpError(
      503,
      "voice_unavailable",
      "Calling is unavailable right now.",
    );
  }

  if (
    process.env.NODE_ENV === "production" &&
    !["wss:", "https:"].includes(parsed.protocol)
  ) {
    throw new HttpError(
      503,
      "voice_unavailable",
      "Calling is unavailable right now.",
    );
  }

  const host = new URL(parsed);
  host.protocol = ["wss:", "https:"].includes(parsed.protocol)
    ? "https:"
    : "http:";

  return { url, host: host.origin, apiKey, apiSecret, signingSecret };
}

export async function POST(request: Request): Promise<Response> {
  try {
    requireSameOrigin(request);

    const command = await readJson(request, commandSchema, 4096);
    const scope = await requireSession(request);
    const service = new ConversationService(getDatabase());

    if (command.action === "ready") {
      await service.markCallReady(scope, command.callId);

      return jsonResponse({ ready: true });
    }

    if (command.action === "end") {
      await service.endCall(scope, command.callId, command.reason);
      dispatchAfterResponse();

      return jsonResponse({ ended: true });
    }

    const config = voiceConfiguration();

    await consumeRequestLimit(scope, "call");
    const callId = randomUUID();
    const roomName = `persona-${callId}`;
    const participantIdentity = `visitor-${randomUUID()}`;
    const expiresAt = Date.now() + 10 * 60 * 1000;
    const metadata = signVoiceSession(
      {
        ...scope,
        callId,
        roomName,
        participantIdentity,
        expiresAt,
      },
      config.signingSecret,
    );

    const token = new AccessToken(config.apiKey, config.apiSecret, {
      identity: participantIdentity,
      ttl: 10 * 60,
    });

    token.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canPublishSources: [TrackSource.MICROPHONE],
      canSubscribe: true,
      canPublishData: false,
      canUpdateOwnMetadata: false,
      canManageAgentSession: false,
    });

    const participantToken = await token.toJwt();
    const options = { requestTimeout: 10 };
    const rooms = new RoomServiceClient(
      config.host,
      config.apiKey,
      config.apiSecret,
      options,
    );
    const dispatch = new AgentDispatchClient(
      config.host,
      config.apiKey,
      config.apiSecret,
      options,
    );

    await service.startCall(scope, callId);

    try {
      await rooms.createRoom({
        name: roomName,
        maxParticipants: 2,
        emptyTimeout: 60,
        departureTimeout: 20,
      });

      await dispatch.createDispatch(
        roomName,
        process.env.LIVEKIT_AGENT_NAME || "persona-onboarding",
        {
          metadata,
        },
      );
    } catch {
      await Promise.allSettled([
        service.endCall(scope, callId, "cancel"),
        rooms.deleteRoom(roomName),
      ]);

      throw new HttpError(
        503,
        "call_failed",
        "The call could not connect. Please try again, or continue here.",
      );
    }

    return jsonResponse({
      callId,
      url: config.url,
      token: participantToken,
      roomName,
      expiresAt,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
