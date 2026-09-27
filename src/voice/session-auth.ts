import { createHmac, timingSafeEqual } from "node:crypto";

export interface VoiceSessionClaims {
  ownerId: string;
  conversationId: string;
  callId: string;
  roomName: string;
  participantIdentity: string;
  /** Admission expiry in epoch milliseconds; it does not end an active call. */
  expiresAt: number;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ADMISSION_MS = 15 * 60 * 1000;

function invalid(): never {
  throw new Error("invalid_voice_session");
}

function validate(value: unknown, now: number): VoiceSessionClaims {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalid();
  }

  const claims = value as Record<string, unknown>;

  if (
    typeof claims.ownerId !== "string" ||
    !UUID.test(claims.ownerId) ||
    typeof claims.conversationId !== "string" ||
    !UUID.test(claims.conversationId) ||
    typeof claims.callId !== "string" ||
    !UUID.test(claims.callId) ||
    claims.roomName !== `persona-${claims.callId}` ||
    typeof claims.participantIdentity !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(claims.participantIdentity) ||
    typeof claims.expiresAt !== "number" ||
    !Number.isSafeInteger(claims.expiresAt) ||
    claims.expiresAt <= now ||
    claims.expiresAt > now + MAX_ADMISSION_MS
  ) {
    return invalid();
  }

  return {
    ownerId: claims.ownerId,
    conversationId: claims.conversationId,
    callId: claims.callId,
    roomName: claims.roomName,
    participantIdentity: claims.participantIdentity,
    expiresAt: claims.expiresAt,
  };
}

function signature(body: string, secret: string): Buffer {
  if (typeof secret !== "string" || Buffer.byteLength(secret) < 32) {
    return invalid();
  }

  return createHmac("sha256", secret)
    .update(`persona-voice-v1.${body}`)
    .digest();
}

/** Server-only credential: pass as dispatch job metadata, never participant metadata. */
export function signVoiceSession(
  claims: VoiceSessionClaims,
  secret: string,
): string {
  const body = Buffer.from(
    JSON.stringify(validate(claims, Date.now())),
  ).toString("base64url");

  return `v1.${body}.${signature(body, secret).toString("base64url")}`;
}

export function verifyVoiceSession(
  token: string,
  secret: string,
  expectedRoomName: string,
  nowMs = Date.now(),
): VoiceSessionClaims {
  if (typeof token !== "string" || token.length > 2048) {
    return invalid();
  }

  const [version, body, supplied, extra] = token.split(".");

  if (
    version !== "v1" ||
    !body ||
    !supplied ||
    extra !== undefined ||
    !/^[a-zA-Z0-9_-]+$/.test(body) ||
    !/^[a-zA-Z0-9_-]{43}$/.test(supplied)
  ) {
    return invalid();
  }

  const expected = signature(body, secret);
  const received = Buffer.from(supplied, "base64url");

  if (
    received.length !== expected.length ||
    !timingSafeEqual(received, expected)
  ) {
    return invalid();
  }

  let decoded: unknown;

  try {
    decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return invalid();
  }

  const claims = validate(decoded, nowMs);

  if (claims.roomName !== expectedRoomName) {
    return invalid();
  }

  return claims;
}
