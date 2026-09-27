import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  signVoiceSession,
  verifyVoiceSession,
  type VoiceSessionClaims,
} from "../../src/voice/session-auth";

const secret = "a-server-secret-with-at-least-32-bytes";

function claims(): VoiceSessionClaims {
  const callId = randomUUID();

  return {
    ownerId: randomUUID(),
    conversationId: randomUUID(),
    callId,
    roomName: `persona-${callId}`,
    participantIdentity: "owner_123",
    expiresAt: Date.now() + 60_000,
  };
}

test("signed dispatch metadata binds owner, conversation, call, room and participant", () => {
  const expected = claims();
  const token = signVoiceSession(expected, secret);

  assert.deepEqual(
    verifyVoiceSession(token, secret, expected.roomName),
    expected,
  );
});

test("rejects tampering, another room, another signing key and expired admission", () => {
  const expected = claims();
  const token = signVoiceSession(expected, secret);
  const [version, body, signature] = token.split(".");
  const changed = Buffer.from(
    JSON.stringify({ ...expected, ownerId: randomUUID() }),
  ).toString("base64url");

  for (const action of [
    () =>
      verifyVoiceSession(
        `${version}.${changed}.${signature}`,
        secret,
        expected.roomName,
      ),
    () => verifyVoiceSession(token, secret, `persona-${randomUUID()}`),
    () =>
      verifyVoiceSession(
        token,
        "another-server-secret-with-at-least-32-bytes",
        expected.roomName,
      ),
    () =>
      verifyVoiceSession(token, secret, expected.roomName, expected.expiresAt),
    () =>
      verifyVoiceSession(`${version}.${body}.short`, secret, expected.roomName),
    () => verifyVoiceSession(`${token}.extra`, secret, expected.roomName),
  ]) {
    assert.throws(action, { message: "invalid_voice_session" });
  }
});

test("signing rejects weak keys, unbounded admission, invalid IDs and room mismatch", () => {
  const expected = claims();

  for (const action of [
    () => signVoiceSession(expected, "short"),
    () =>
      signVoiceSession(
        { ...expected, expiresAt: Date.now() + 16 * 60_000 },
        secret,
      ),
    () => signVoiceSession({ ...expected, roomName: "another-room" }, secret),
    () =>
      signVoiceSession(
        { ...expected, participantIdentity: "user\nadmin" },
        secret,
      ),
    () => signVoiceSession({ ...expected, ownerId: "not-an-id" }, secret),
  ]) {
    assert.throws(action, { message: "invalid_voice_session" });
  }
});
