import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import postgres from "postgres";
import { migrateTestDatabase } from "./migrations";
import { GET, POST } from "../../src/app/api/conversation/route";
import { POST as callPost } from "../../src/app/api/call/route";
import { getDatabase } from "../../src/server/database";
import { ConversationService } from "../../src/server/conversation/service";
import { requireSession } from "../../src/server/http/session";
import { errorResponse } from "../../src/server/http/responses";
import { HttpError } from "../../src/server/http/responses";
import { consumeRequestLimit } from "../../src/server/http/rate-limit";

const url = process.env.TEST_DATABASE_URL;
if (!url)
  throw new Error(
    "Set TEST_DATABASE_URL explicitly to run Postgres integration tests.",
  );
const schema = `test_http_${randomUUID().replaceAll("-", "")}`;
const databaseUrl = new URL(url);
databaseUrl.searchParams.set("search_path", schema);
const previousDatabaseUrl = process.env.DATABASE_URL;
const previousAppUrl = process.env.APP_URL;
process.env.DATABASE_URL = databaseUrl.toString();
process.env.APP_URL = "https://persona.test";
const admin = postgres(url, { max: 1, onnotice: () => {} });
const origin = "https://persona.test";
const db = getDatabase();
const service = new ConversationService(db);

before(async () => {
  await admin`CREATE SCHEMA ${admin(schema)}`;
  await migrateTestDatabase(db);
});

after(async () => {
  await db.end();
  await admin`DROP SCHEMA IF EXISTS ${admin(schema)} CASCADE`;
  await admin.end();
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
  if (previousAppUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = previousAppUrl;
});

function request(
  body: unknown,
  cookie?: string,
  extraHeaders: HeadersInit = {},
) {
  const headers = new Headers({
    "content-type": "application/json",
    origin,
    ...extraHeaders,
  });
  if (cookie) headers.set("cookie", cookie);
  return new Request(`${origin}/api/conversation`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function bootstrap() {
  const response = await POST(request({ type: "bootstrap" }));
  assert.equal(response.status, 200);
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie);
  const cookie = setCookie.split(";")[0];
  const scope = await requireSession(
    new Request(origin, { headers: { cookie } }),
  );
  return { response, cookie, setCookie, scope };
}

test("conversation polling and bootstrap never serialize private voice evidence", async () => {
  const { cookie, scope } = await bootstrap();
  const callId = randomUUID();

  await service.startCall(scope, callId);
  await service.appendInput(scope, {
    sourceEventId: randomUUID(),
    channel: "voice",
    callId,
    text: "Private voice detail from the call",
    revision: 1,
    final: true,
  });

  const responses = [
    await GET(
      new Request(`${origin}/api/conversation`, { headers: { cookie } }),
    ),
    await POST(request({ type: "bootstrap" }, cookie)),
  ];

  for (const response of responses) {
    assert.equal(response.status, 200);

    const body = await response.json();

    assert.equal("evidence" in body, false);
    assert.doesNotMatch(
      JSON.stringify(body),
      /Private voice detail from the call/,
    );
    assert.deepEqual(body.messages, []);
  }

  assert.equal(
    (await service.history(scope))[0].text,
    "Private voice detail from the call",
  );
});

test("call readiness requires ownership, rejects ended calls, and is idempotent", async () => {
  const owner = await bootstrap();
  const stranger = await bootstrap();
  const callId = randomUUID();

  await service.startCall(owner.scope, callId);

  assert.equal(
    (await callPost(request({ action: "ready", callId }, stranger.cookie)))
      .status,
    404,
  );
  assert.equal(
    (await callPost(request({ action: "ready", callId }, owner.cookie))).status,
    200,
  );

  const [first] = await db`SELECT ready_at FROM calls WHERE id = ${callId}`;

  assert.ok(first.ready_at);
  assert.equal(
    (await callPost(request({ action: "ready", callId }, owner.cookie))).status,
    200,
  );

  const [second] = await db`SELECT ready_at FROM calls WHERE id = ${callId}`;

  assert.equal(first.ready_at.toISOString(), second.ready_at.toISOString());
  await service.endCall(owner.scope, callId, "cancel");
  assert.equal(
    (await callPost(request({ action: "ready", callId }, owner.cookie))).status,
    409,
  );
});

test("native voice keeps both sides private without queuing a second response model", async () => {
  const { scope } = await bootstrap();
  const callId = randomUUID();
  await service.startCall(scope, callId);

  const input = await service.appendInput(
    scope,
    {
      sourceEventId: `voice:${callId}:native_input:0`,
      channel: "voice",
      callId,
      text: "My name is Noor",
      revision: 1,
      final: true,
    },
    { queueTurn: false },
  );
  const response = {
    id: "native_reply",
    text: "Nice to meet you, Noor. What can I help with?",
  };

  await service.saveVoiceResponse(scope, callId, response);
  await service.saveVoiceResponse(scope, callId, response);

  const jobs =
    await db`SELECT id FROM job_outbox WHERE subject_id = ${input.id}`;
  assert.equal(jobs.length, 0);
  assert.deepEqual((await service.snapshot(scope)).messages, []);
  assert.deepEqual(
    (await service.history(scope)).map((item) => item.text),
    ["My name is Noor", response.text],
  );

  const stranger = await bootstrap();
  await assert.rejects(
    service.saveVoiceResponse(stranger.scope, callId, response),
  );
});

test("bootstrap stores only a bearer hash and issues a secure private HttpOnly session cookie", async () => {
  const { response, cookie, setCookie, scope } = await bootstrap();
  assert.match(setCookie, /^__Host-persona_trial_session=/);
  assert.match(setCookie, /; Secure/);
  assert.match(setCookie, /; HttpOnly/);
  assert.match(setCookie, /; SameSite=Strict/);
  assert.match(setCookie, /; Path=\//);
  assert.match(response.headers.get("cache-control")!, /no-store/);
  assert.equal(response.headers.get("vary"), "Cookie");
  const token = cookie.slice(cookie.indexOf("=") + 1);
  const [row] =
    await db`SELECT * FROM browser_sessions WHERE conversation_id = ${scope.conversationId}`;
  assert.equal(
    row.token_hash,
    createHash("sha256").update(token).digest("hex"),
  );
  assert.doesNotMatch(JSON.stringify(row), new RegExp(token));
  const reused = await POST(request({ type: "bootstrap" }, cookie));
  assert.equal(reused.status, 200);
  assert.equal(reused.headers.get("set-cookie"), null);
});

test("missing and foreign origins are rejected before creating browser sessions", async () => {
  const [{ count: beforeCount }] =
    await db`SELECT count(*)::int AS count FROM browser_sessions`;
  for (const value of [
    null,
    "https://attacker.test",
    "https://persona.test.attacker.test",
  ]) {
    const req = request({ type: "bootstrap" });
    if (value === null) req.headers.delete("origin");
    else req.headers.set("origin", value);
    const response = await POST(req);
    assert.equal(response.status, 403);
    assert.match(response.headers.get("cache-control")!, /no-store/);
  }
  const [{ count: afterCount }] =
    await db`SELECT count(*)::int AS count FROM browser_sessions`;
  assert.equal(afterCount, beforeCount);
});

test("request validation rejects oversized streamed bodies, invalid JSON and extra identity fields", async () => {
  const oversized = request({
    type: "message",
    eventId: randomUUID(),
    text: "x".repeat(25_000),
  });
  assert.equal(oversized.headers.get("content-length"), null);
  assert.equal((await POST(oversized)).status, 413);
  assert.equal(
    (await POST(request({ type: "bootstrap", ownerId: randomUUID() }))).status,
    400,
  );
  assert.equal(
    (await POST(request({ type: "bootstrap", conversationId: randomUUID() })))
      .status,
    400,
  );
  const invalidJson = new Request(`${origin}/api/conversation`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: "{broken",
  });
  assert.equal((await POST(invalidJson)).status, 400);
});

test("missing, forged, duplicate and expired session cookies cannot read a conversation", async () => {
  const { cookie, scope } = await bootstrap();
  const forged = `__Host-persona_trial_session=${randomBytes(32).toString("base64url")}`;
  for (const value of ["", forged, `${cookie}; ${cookie}`]) {
    const response = await GET(
      new Request(`${origin}/api/conversation`, { headers: { cookie: value } }),
    );
    assert.equal(response.status, 401);
    assert.match(response.headers.get("cache-control")!, /no-store/);
  }
  await db`UPDATE browser_sessions SET expires_at = now() - interval '1 second' WHERE conversation_id = ${scope.conversationId}`;
  assert.equal(
    (
      await GET(
        new Request(`${origin}/api/conversation`, { headers: { cookie } }),
      )
    ).status,
    401,
  );
});

test("a second session cannot cancel another conversation's task or end its call", async () => {
  const a = await bootstrap();
  const b = await bootstrap();
  const input = await service.appendInput(a.scope, {
    sourceEventId: randomUUID(),
    channel: "chat",
    text: "Search sample",
    revision: 1,
    final: true,
  });
  const task = await service.acceptTask(a.scope, {
    evidenceId: input.id,
    expectedSequence: input.conversationSequence,
    kind: "demo.search",
    query: "recruiter",
    idempotencyKey: randomUUID(),
  });
  assert.equal(
    (await POST(request({ type: "cancel", taskId: task.id }, b.cookie))).status,
    404,
  );
  assert.equal((await service.getTask(a.scope, task.id)).status, "pending");
  const callId = randomUUID();
  await service.startCall(a.scope, callId);
  assert.equal(
    (
      await callPost(
        request({ action: "end", callId, reason: "hangup" }, b.cookie),
      )
    ).status,
    404,
  );
  const [call] = await db`SELECT status FROM calls WHERE id = ${callId}`;
  assert.equal(call.status, "active");
});

test("message API deduplicates retried input and scopes snapshot replay to the session", async () => {
  const a = await bootstrap();
  const b = await bootstrap();
  const command = {
    type: "message",
    eventId: randomUUID(),
    text: "Only session A should see this",
  };
  const responses = await Promise.all(
    Array.from({ length: 3 }, () => POST(request(command, a.cookie))),
  );
  assert.ok(responses.every((response) => response.status === 202));
  const aResponse = await GET(
    new Request(`${origin}/api/conversation`, {
      headers: { cookie: a.cookie },
    }),
  );
  const aBody = await aResponse.json();
  assert.equal(aBody.messages.length, 1);
  assert.equal(aBody.messages[0].text, command.text);
  const bResponse = await GET(
    new Request(`${origin}/api/conversation`, {
      headers: { cookie: b.cookie },
    }),
  );
  const bBody = await bResponse.json();
  assert.equal(bBody.messages.length, 0);
  assert.equal(
    (
      await GET(
        new Request(`${origin}/api/conversation?after=-1`, {
          headers: { cookie: a.cookie },
        }),
      )
    ).status,
    400,
  );
});

test("unexpected server errors are private and do not expose secret-like internal details", async () => {
  const response = errorResponse(
    new Error("private-api-key-secret database SQL context"),
  );
  assert.equal(response.status, 503);
  assert.match(response.headers.get("cache-control")!, /no-store/);
  assert.doesNotMatch(
    await response.text(),
    /private-api-key-secret|database SQL/,
  );
});

test("concurrent message limit cannot exceed its cap and resets only after its window", async () => {
  const { scope } = await bootstrap();
  const outcomes = await Promise.allSettled(
    Array.from({ length: 31 }, () => consumeRequestLimit(scope, "message")),
  );
  assert.equal(
    outcomes.filter((result) => result.status === "fulfilled").length,
    30,
  );
  const rejected = outcomes.filter((result) => result.status === "rejected");
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0].reason instanceof HttpError);
  assert.equal(rejected[0].reason.status, 429);
  await db`UPDATE http_rate_limits SET window_started_at = now() - interval '61 seconds' WHERE owner_id = ${scope.ownerId} AND operation = 'message'`;
  await consumeRequestLimit(scope, "message");
  const [row] =
    await db`SELECT request_count FROM http_rate_limits WHERE owner_id = ${scope.ownerId} AND operation = 'message'`;
  assert.equal(row.request_count, 1);
});

test("call limits are per owner and separate from message limits", async () => {
  const a = await bootstrap();
  const b = await bootstrap();
  const outcomes = await Promise.allSettled(
    Array.from({ length: 13 }, () => consumeRequestLimit(a.scope, "call")),
  );
  assert.equal(
    outcomes.filter((result) => result.status === "fulfilled").length,
    12,
  );
  assert.equal(
    outcomes.filter((result) => result.status === "rejected").length,
    1,
  );
  await consumeRequestLimit(a.scope, "message");
  await consumeRequestLimit(b.scope, "call");
});

test("chat snapshots expose stable client event IDs for retries without exposing voice input", async () => {
  const { cookie, scope } = await bootstrap();
  const eventId = randomUUID();
  const input = {
    sourceEventId: `chat:${eventId}`,
    channel: "chat" as const,
    text: "Keep one bubble",
    revision: 1,
    final: true,
  };
  await service.appendInput(scope, input, { queueTurn: false });
  await service.appendInput(scope, input, { queueTurn: false });
  const response = await GET(
    new Request(`${origin}/api/conversation`, { headers: { cookie } }),
  );
  const snapshot = await response.json();
  assert.equal(snapshot.messages.length, 1);
  assert.equal(snapshot.messages[0].clientEventId, eventId);
  assert.equal(snapshot.messages[0].text, input.text);
});
