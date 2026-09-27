import {
  resolveMailbox,
  canUseTaskMailbox,
} from "../../src/server/integrations/mailbox";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import postgres from "postgres";
import { POST } from "../../src/app/api/conversation/route";
import { ConversationService } from "../../src/server/conversation/service";
import { getDatabase } from "../../src/server/database";
import { requireSession } from "../../src/server/http/session";
import { migrateTestDatabase } from "./migrations";

const url = process.env.TEST_DATABASE_URL;

if (!url)
  throw new Error("Set TEST_DATABASE_URL to run reset integration tests.");

const schema = `test_demo_mailbox_${randomUUID().replaceAll("-", "")}`;
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

async function configureMailbox() {
  const host = await bootstrap();
  const connectionId = randomUUID();

  await db`INSERT INTO gmail_connections (owner_id, connection_id) VALUES (${host.scope.ownerId}, ${connectionId})`;
  await db`
    INSERT INTO demo_mailbox (singleton, connection_id)
    VALUES (true, ${connectionId})
    ON CONFLICT (singleton) DO UPDATE SET connection_id = EXCLUDED.connection_id
  `;

  return { host, connectionId };
}

test("visitors share the configured inbox while conversations and tasks remain private", async () => {
  const { host, connectionId } = await configureMailbox();
  const tester = await bootstrap();
  const stranger = await bootstrap();

  const input = await service.appendInput(tester.scope, {
    sourceEventId: randomUUID(),
    channel: "chat",
    text: "Find recruiter emails",
    revision: 1,
    final: true,
  });
  const acceptance = {
    evidenceId: input.id,
    expectedSequence: input.conversationSequence,
    kind: "gmail.search" as const,
    query: "recruiter",
    idempotencyKey: randomUUID(),
  };
  assert.deepEqual(await resolveMailbox(db, tester.scope), {
    connectionId,
    source: "demo",
  });
  assert.deepEqual(await resolveMailbox(db, stranger.scope), {
    connectionId,
    source: "demo",
  });
  assert.equal(
    await resolveMailbox(db, {
      ...tester.scope,
      conversationId: host.scope.conversationId,
    }),
    null,
  );

  const task = await service.acceptTask(tester.scope, acceptance);
  assert.equal(await canUseTaskMailbox(db, tester.scope, task.id), true);
  const snapshot = await service.snapshot(tester.scope);
  assert.equal(snapshot.gmailSource, "demo");
  assert.deepEqual((await service.snapshot(stranger.scope)).messages, []);
  assert.deepEqual((await service.snapshot(host.scope)).tasks, []);
  assert.equal(JSON.stringify(snapshot).includes(connectionId), false);
});

test("regular reset preserves the demo inbox; connecting another Gmail clears history and permanently opts this conversation out", async () => {
  const { connectionId } = await configureMailbox();
  const tester = await bootstrap();

  const reset = await POST(request({ type: "reset" }, tester.cookie));
  const cookie = reset.headers.get("set-cookie")!.split(";")[0];
  const scope = await requireSession(request({}, cookie));
  assert.equal((await reset.json()).gmailSource, "demo");

  const input = await service.appendInput(scope, {
    sourceEventId: randomUUID(),
    channel: "chat",
    text: "Find interview email",
    revision: 1,
    final: true,
  });
  const task = await service.acceptTask(scope, {
    evidenceId: input.id,
    expectedSequence: input.conversationSequence,
    kind: "gmail.search",
    query: "interview",
    idempotencyKey: randomUUID(),
  });
  const switched = await POST(
    request({ type: "reset", disconnectGmail: true }, cookie),
  );
  const nextCookie = switched.headers.get("set-cookie")!.split(";")[0];
  const next = await requireSession(request({}, nextCookie));
  const fresh = await switched.json();

  assert.notEqual(next.ownerId, scope.ownerId);
  assert.equal(fresh.gmailConnected, false);
  assert.deepEqual(fresh.messages, []);
  assert.deepEqual(fresh.tasks, []);
  await assert.rejects(requireSession(request({}, cookie)));
  await assert.rejects(
    service.finishTask(scope, {
      taskId: task.id,
      revision: 1,
      outcome: "completed",
      answer: "Old mailbox content",
    }),
  );

  assert.equal(await resolveMailbox(db, next), null);
  const again = await POST(request({ type: "reset" }, nextCookie));
  assert.equal((await again.json()).gmailConnected, false);

  const [{ connection_id }] = await db`SELECT connection_id FROM demo_mailbox`;
  assert.equal(connection_id, connectionId);
});

test("a personal account overrides shared access without changing another visitor's mailbox", async () => {
  const { connectionId } = await configureMailbox();
  const tester = await bootstrap();
  const other = await bootstrap();
  const personalId = randomUUID();
  await db`INSERT INTO gmail_connections (owner_id, connection_id) VALUES (${tester.scope.ownerId}, ${personalId})`;

  assert.deepEqual(await resolveMailbox(db, tester.scope), {
    connectionId: personalId,
    source: "personal",
  });
  assert.deepEqual(await resolveMailbox(db, other.scope), {
    connectionId,
    source: "demo",
  });
});

test("pending tasks cannot read a replacement mailbox or deliver results after access is revoked", async () => {
  await configureMailbox();
  const tester = await bootstrap();
  const callId = randomUUID();
  await service.startCall(tester.scope, callId);
  const input = await service.appendInput(tester.scope, {
    sourceEventId: randomUUID(),
    channel: "voice",
    callId,
    text: "Find recruiter emails",
    revision: 1,
    final: true,
  });
  const task = await service.acceptTask(tester.scope, {
    evidenceId: input.id,
    expectedSequence: input.conversationSequence,
    kind: "gmail.search",
    query: "recruiter",
    idempotencyKey: randomUUID(),
  });

  const replacementId = randomUUID();
  await db`INSERT INTO gmail_connections (owner_id, connection_id) VALUES (${randomUUID()}, ${replacementId})`;
  await db`UPDATE demo_mailbox SET connection_id = ${replacementId}`;
  assert.equal(await canUseTaskMailbox(db, tester.scope, task.id), false);
  await service.finishTask(tester.scope, {
    taskId: task.id,
    revision: 1,
    outcome: "completed",
    answer: "Private previous inbox contents",
  });
  const snapshot = await service.snapshot(tester.scope);
  assert.equal(snapshot.tasks[0].status, "failed");
  assert.equal(
    snapshot.messages.some((message) =>
      message.text.includes("Private previous inbox"),
    ),
    false,
  );

  await db`DELETE FROM demo_mailbox`;
  assert.equal(await resolveMailbox(db, tester.scope), null);
});
