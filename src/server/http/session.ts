import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getDatabase } from "../database";
import type { Scope } from "../conversation/types";
import { applicationUrl, HttpError } from "./responses";

const lifetimeSeconds = 7 * 24 * 60 * 60;

function cookieName(): string {
  return applicationUrl().protocol === "https:"
    ? "__Host-persona_trial_session"
    : "persona_trial_session";
}

function readToken(request: Request): string | null {
  const name = `${cookieName()}=`;
  const matches = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(name));

  if (matches.length !== 1) return null;

  const token = matches[0].slice(name.length);

  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function sessionCookie(token: string): string {
  const secure = applicationUrl().protocol === "https:" ? "; Secure" : "";

  return `${cookieName()}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${lifetimeSeconds}${secure}`;
}

async function findSession(request: Request): Promise<Scope | null> {
  const token = readToken(request);

  if (!token) return null;

  const db = getDatabase();
  const [row] = await db<{ owner_id: string; conversation_id: string }[]>`
    SELECT s.owner_id, s.conversation_id
    FROM browser_sessions s
    JOIN conversations c ON c.id = s.conversation_id AND c.owner_id = s.owner_id
    WHERE s.token_hash = ${tokenHash(token)} AND s.expires_at > now()
  `;

  return row
    ? { ownerId: row.owner_id, conversationId: row.conversation_id }
    : null;
}

export async function requireSession(request: Request): Promise<Scope> {
  const scope = await findSession(request);

  if (!scope) {
    throw new HttpError(
      401,
      "session_required",
      "Open a conversation to continue.",
    );
  }

  return scope;
}

export async function getOrCreateSession(request: Request): Promise<{
  scope: Scope;
  setCookie?: string;
}> {
  const existing = await findSession(request);

  if (existing) return { scope: existing };

  const token = randomBytes(32).toString("base64url");
  const scope = { ownerId: randomUUID(), conversationId: randomUUID() };
  const expiresAt = new Date(Date.now() + lifetimeSeconds * 1000);
  const db = getDatabase();

  await db.begin(async (tx) => {
    await tx`
      INSERT INTO conversations (id, owner_id)
      VALUES (${scope.conversationId}, ${scope.ownerId})
    `;

    await tx`
      INSERT INTO browser_sessions (token_hash, owner_id, conversation_id, expires_at)
      VALUES (${tokenHash(token)}, ${scope.ownerId}, ${scope.conversationId}, ${expiresAt})
    `;
  });

  return { scope, setCookie: sessionCookie(token) };
}

export async function resetSession(
  request: Request,
  options: { disconnectGmail?: boolean } = {},
): Promise<{
  scope: Scope;
  setCookie: string;
}> {
  const previousToken = readToken(request);

  if (!previousToken) {
    throw new HttpError(
      401,
      "session_required",
      "Open a conversation to continue.",
    );
  }

  const token = randomBytes(32).toString("base64url");
  const conversationId = randomUUID();
  const expiresAt = new Date(Date.now() + lifetimeSeconds * 1000);
  const db = getDatabase();
  const scope = await db.begin(async (tx) => {
    const [previous] = await tx<
      { owner_id: string; conversation_id: string; gmail_mode: string }[]
    >`
      SELECT s.owner_id, s.conversation_id, c.gmail_mode
      FROM browser_sessions s
      JOIN conversations c ON c.id = s.conversation_id AND c.owner_id = s.owner_id
      WHERE s.token_hash = ${tokenHash(previousToken)} AND s.expires_at > now()
      FOR UPDATE OF c, s
    `;

    if (!previous) {
      throw new HttpError(
        401,
        "session_required",
        "Open a conversation to continue.",
      );
    }

    const ownerId = options.disconnectGmail ? randomUUID() : previous.owner_id;
    const gmailMode = options.disconnectGmail
      ? "personal"
      : previous.gmail_mode;

    await tx`
      DELETE FROM conversations
      WHERE id = ${previous.conversation_id} AND owner_id = ${previous.owner_id}
    `;

    await tx`
      INSERT INTO conversations (id, owner_id, gmail_mode)
      VALUES (${conversationId}, ${ownerId}, ${gmailMode})
    `;

    await tx`
      INSERT INTO browser_sessions (token_hash, owner_id, conversation_id, expires_at)
      VALUES (${tokenHash(token)}, ${ownerId}, ${conversationId}, ${expiresAt})
    `;

    return { ownerId, conversationId };
  });

  return { scope, setCookie: sessionCookie(token) };
}
