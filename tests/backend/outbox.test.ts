import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import postgres from "postgres";
import { migrateTestDatabase } from "./migrations";
import { ConversationService } from "../../src/server/conversation/service";
import { JobOutbox, dispatchPendingJobs } from "../../src/server/jobs/outbox";

const url = process.env.TEST_DATABASE_URL;
if (!url)
  throw new Error(
    "Set TEST_DATABASE_URL explicitly to run Postgres integration tests.",
  );
const schema = `test_outbox_${randomUUID().replaceAll("-", "")}`;
const admin = postgres(url, { max: 1, onnotice: () => {} });
const db = postgres(url, {
  max: 10,
  connection: { search_path: schema },
  onnotice: () => {},
});
const conversations = new ConversationService(db);
const outbox = new JobOutbox(db);

before(async () => {
  await admin`CREATE SCHEMA ${admin(schema)}`;
  await migrateTestDatabase(db);
});

after(async () => {
  await db.end();
  await admin`DROP SCHEMA IF EXISTS ${admin(schema)} CASCADE`;
  await admin.end();
});

async function enqueue() {
  const scope = await conversations.create(randomUUID());
  await conversations.appendInput(scope, {
    sourceEventId: randomUUID(),
    channel: "chat",
    text: "Private email search request",
    revision: 1,
    final: true,
  });
  return scope;
}

test("concurrent publishers exclusively claim eligible jobs with their owning scope", async () => {
  const scopes = await Promise.all(Array.from({ length: 12 }, enqueue));
  const batches = await Promise.all(
    Array.from({ length: 4 }, () => outbox.claim(4)),
  );
  const jobs = batches.flat();
  assert.equal(jobs.length, 12);
  assert.equal(new Set(jobs.map((job) => job.id)).size, 12);
  for (const job of jobs) {
    assert.deepEqual(
      job.scope,
      scopes.find((scope) => scope.conversationId === job.scope.conversationId),
    );
    assert.equal(await outbox.markPublished(job), true);
    assert.equal(await outbox.markPublished(job), false);
  }
  assert.deepEqual(await outbox.claim(), []);
});

test("expired worker leases are reclaimed and stale completion cannot acknowledge the new lease", async () => {
  const scope = await enqueue();
  const [oldJob] = await outbox.claim();
  assert.equal(oldJob.scope.conversationId, scope.conversationId);
  await db`UPDATE job_outbox SET lease_until = now() - interval '1 second' WHERE id = ${oldJob.id}`;
  assert.equal(await outbox.markPublished(oldJob), false);
  const [newJob] = await outbox.claim();
  assert.equal(newJob.id, oldJob.id);
  assert.notEqual(newJob.leaseToken, oldJob.leaseToken);
  await outbox.release(oldJob);
  assert.deepEqual(await outbox.claim(), []);
  assert.equal(await outbox.markPublished(oldJob), false);
  assert.equal(await outbox.markPublished(newJob), true);
});

test("publication failure schedules retry with a stable event ID and no private conversation payload", async () => {
  await enqueue();
  const attempts: Parameters<Parameters<typeof dispatchPendingJobs>[1]>[0][] =
    [];
  const failed = await dispatchPendingJobs(outbox, async (event) => {
    attempts.push(event);
    throw new Error("Provider is temporarily unavailable");
  });
  assert.deepEqual(failed, { published: 0, deferred: 1 });
  assert.equal(attempts.length, 1);
  assert.deepEqual(Object.keys(attempts[0]).sort(), ["data", "id", "name"]);
  assert.deepEqual(attempts[0].data, { jobId: attempts[0].id });
  assert.equal(attempts[0].name, "persona/job.requested");
  assert.doesNotMatch(
    JSON.stringify(attempts[0]),
    /Private email|ownerId|conversationId/,
  );
  assert.deepEqual(await outbox.claim(), []);
  await db`UPDATE job_outbox SET available_at = now() - interval '1 second' WHERE id = ${attempts[0].id}`;
  assert.deepEqual(
    await dispatchPendingJobs(outbox, async (event) => {
      attempts.push(event);
    }),
    { published: 1, deferred: 0 },
  );
  assert.deepEqual(attempts[1], attempts[0]);
  assert.deepEqual(await outbox.claim(), []);
});

test("publish-before-ack crash can replay the same stable event for downstream deduplication", async () => {
  await enqueue();
  const [first] = await outbox.claim();
  const firstPublishedEvent = { id: first.id, data: { jobId: first.id } };
  await db`UPDATE job_outbox SET lease_until = now() - interval '1 second' WHERE id = ${first.id}`;
  const [retry] = await outbox.claim();
  assert.deepEqual(
    { id: retry.id, data: { jobId: retry.id } },
    firstPublishedEvent,
  );
  assert.equal(await outbox.markPublished(retry), true);
});

test("call recovery is immediately dispatchable and job lookup contains no lease token", async () => {
  const scope = await conversations.create(randomUUID());
  const callId = randomUUID();
  await conversations.startCall(scope, callId);
  await conversations.endCall(scope, callId, "disconnect");
  const [row] =
    await db`SELECT id FROM job_outbox WHERE conversation_id = ${scope.conversationId}`;
  const lookup = await outbox.get(row.id);
  assert.ok(lookup);
  assert.equal(lookup.name, "call.recovery");
  assert.equal("leaseToken" in lookup, false);
  assert.deepEqual(lookup.scope, scope);
  const [job] = await outbox.claim();
  assert.equal(job.id, row.id);
  await outbox.markPublished(job);
});
