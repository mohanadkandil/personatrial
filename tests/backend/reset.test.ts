import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import postgres from "postgres";
import { GET, POST } from "../../src/app/api/conversation/route";
import { ConversationService } from "../../src/server/conversation/service";
import { getDatabase } from "../../src/server/database";
import { requireSession } from "../../src/server/http/session";
import { migrateTestDatabase } from "./migrations";

const url = process.env.TEST_DATABASE_URL;

if (!url)
  throw new Error("Set TEST_DATABASE_URL to run reset integration tests.");

const schema = `test_reset_${randomUUID().replaceAll("-", "")}`;
const databaseUrl = new URL(url);
const previousDatabaseUrl = process.env.DATABASE_URL;
const previousAppUrl = process.env.APP_URL;
const origin = "https://persona.test";

databaseUrl.searchParams.set("search_path", schema);
process.env.DATABASE_URL = databaseUrl.toString();
process.env.APP_URL = origin;

const admin = postgres(url, { max: 1, onnotice: () => {} });
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

function request(body: unknown, cookie = "") {
  return new Request(`${origin}/api/conversation`, {
    method: "POST",
    headers: { origin, cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function bootstrap() {
  const response = await POST(request({ type: "bootstrap" }));
  assert.equal(response.status, 200);

  const cookie = response.headers.get("set-cookie")!.split(";")[0];
  const scope = await requireSession(request({}, cookie));

  return { cookie, scope };
}

test("reset erases the conversation and pending work, rotates its session, and retains only the owner's Gmail binding", async () => {
  const owner = await bootstrap();
  const other = await bootstrap();
  const callId = randomUUID();

  await service.startCall(owner.scope, callId);

  const input = await service.appendInput(owner.scope, {
    sourceEventId: randomUUID(),
    channel: "chat",
    text: "Old conversation detail",
    revision: 1,
    final: true,
  });
  const task = await service.acceptTask(owner.scope, {
    evidenceId: input.id,
    expectedSequence: input.conversationSequence,
    kind: "demo.search",
    query: "old query",
    idempotencyKey: randomUUID(),
  });

  await db`UPDATE conversations SET profile = '{"agentName":"Old name"}' WHERE id = ${owner.scope.conversationId}`;
  await db`INSERT INTO gmail_connections (owner_id, connection_id) VALUES (${owner.scope.ownerId}, ${randomUUID()})`;
  await db`
    INSERT INTO gmail_connect_attempts (id, owner_id, conversation_id, integration_id, status, expires_at)
    VALUES (${randomUUID()}, ${owner.scope.ownerId}, ${owner.scope.conversationId}, 'gmail', 'pending', now() + interval '1 hour')
  `;

  const response = await POST(request({ type: "reset" }, owner.cookie));
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.deepEqual(body.messages, []);
  assert.deepEqual(body.tasks, []);
  assert.deepEqual(body.profile, {});
  assert.equal(body.gmailConnected, true);
  assert.equal(body.cursor, 0);

  const setCookie = response.headers.get("set-cookie")!;
  const cookie = setCookie.split(";")[0];
  assert.notEqual(cookie, owner.cookie);
  assert.match(setCookie, /; HttpOnly; SameSite=Strict/);
  assert.match(setCookie, /; Secure/);

  const scope = await requireSession(request({}, cookie));
  assert.equal(scope.ownerId, owner.scope.ownerId);
  assert.notEqual(scope.conversationId, owner.scope.conversationId);
  await assert.rejects(requireSession(request({}, owner.cookie)));
  await assert.rejects(service.getTask(owner.scope, task.id));
  await assert.rejects(
    service.appendInput(owner.scope, {
      sourceEventId: randomUUID(),
      channel: "voice",
      callId,
      text: "Late call transcript",
      revision: 1,
      final: true,
    }),
  );

  for (const table of [
    "conversations",
    "calls",
    "evidence",
    "messages",
    "tasks",
    "turns",
    "job_outbox",
    "gmail_connect_attempts",
    "browser_sessions",
  ]) {
    const key = table === "conversations" ? "id" : "conversation_id";
    const rows =
      await db`SELECT 1 FROM ${db(table)} WHERE ${db(key)} = ${owner.scope.conversationId}`;
    assert.equal(
      rows.length,
      0,
      `${table} should have no old conversation rows`,
    );
  }

  assert.deepEqual(
    await requireSession(request({}, other.cookie)),
    other.scope,
  );
  assert.deepEqual((await service.snapshot(scope)).messages, []);
  assert.equal(
    (
      await GET(
        new Request(`${origin}/api/conversation`, {
          headers: { cookie: owner.cookie },
        }),
      )
    ).status,
    401,
  );
});

test("reset requires an existing same-origin session and rejects supplied ownership", async () => {
  const owner = await bootstrap();
  assert.equal((await POST(request({ type: "reset" }))).status, 401);

  const foreign = request({ type: "reset" }, owner.cookie);
  foreign.headers.set("origin", "https://other.test");
  assert.equal((await POST(foreign)).status, 403);
  assert.equal(
    (
      await POST(
        request({ type: "reset", conversationId: randomUUID() }, owner.cookie),
      )
    ).status,
    400,
  );
  assert.deepEqual(
    await requireSession(request({}, owner.cookie)),
    owner.scope,
  );
});

test("concurrent reset requests cannot create multiple replacement conversations", async () => {
  const owner = await bootstrap();
  const responses = await Promise.all([
    POST(request({ type: "reset" }, owner.cookie)),
    POST(request({ type: "reset" }, owner.cookie)),
  ]);

  assert.deepEqual(
    responses.map((response) => response.status).sort(),
    [200, 401],
  );

  const rows =
    await db`SELECT id FROM conversations WHERE owner_id = ${owner.scope.ownerId}`;
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].id, owner.scope.conversationId);
});
