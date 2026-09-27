import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import postgres from "postgres";
import { migrateTestDatabase } from "./migrations";
import { createConversationEngine } from "../../src/server/conversation/engine";
import { ConversationService } from "../../src/server/conversation/service";
import type { TurnDecision } from "../../src/server/conversation/decision";
import type { Scope } from "../../src/server/conversation/types";

const url = process.env.TEST_DATABASE_URL;
if (!url)
  throw new Error(
    "Set TEST_DATABASE_URL explicitly to run Postgres integration tests.",
  );
const schema = `test_engine_${randomUUID().replaceAll("-", "")}`;
const admin = postgres(url, { max: 1, onnotice: () => {} });
const db = postgres(url, {
  max: 10,
  connection: { search_path: schema },
  onnotice: () => {},
});
const service = new ConversationService(db);

before(async () => {
  await admin`CREATE SCHEMA ${admin(schema)}`;
  await migrateTestDatabase(db);
});

after(async () => {
  await db.end();
  await admin`DROP SCHEMA IF EXISTS ${admin(schema)} CASCADE`;
  await admin.end();
});

function decision(overrides: Partial<TurnDecision> = {}): TurnDecision {
  return {
    reply: "How can I help?",
    agentName: null,
    userName: null,
    helpRequest: null,
    callPreference: null,
    gmailPreference: null,
    action: "reply",
    query: null,
    cancelTaskId: null,
    ...overrides,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function chat(scope: Scope, text: string) {
  return service.appendInput(scope, {
    sourceEventId: randomUUID(),
    channel: "chat",
    text,
    revision: 1,
    final: true,
  });
}

test("concurrent duplicate turns commit one reply, task and execution obligation", async () => {
  const scope = await service.create(randomUUID());
  const input = await chat(scope, "Search the sample inbox for recruiters");
  const allDeciding = deferred();
  let calls = 0;
  const engine = createConversationEngine(service, async () => {
    if (++calls === 6) allDeciding.resolve();
    await allDeciding.promise;
    return decision({
      action: "search_sample",
      query: "recruiter",
      reply: "Searching the sample.",
    });
  });
  const replies = await Promise.all(
    Array.from({ length: 6 }, () => engine(scope, input.id)),
  );
  assert.equal(replies.filter((result) => result.reply !== null).length, 1);
  const state = await service.snapshot(scope);
  assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0].kind, "demo.search");
  assert.equal(
    state.messages.filter((message) => message.role === "assistant").length,
    1,
  );
  assert.equal(
    (
      await db`SELECT evidence_id FROM turns WHERE conversation_id = ${scope.conversationId}`
    ).length,
    1,
  );
  assert.equal(
    (
      await db`SELECT id FROM job_outbox WHERE conversation_id = ${scope.conversationId} AND name = 'task.requested'`
    ).length,
    1,
  );
});

test("a slow decision is reevaluated against new chat before committing", async () => {
  const scope = await service.create(randomUUID());
  const input = await chat(scope, "Call me Noor");
  const firstDecisionStarted = deferred();
  const releaseFirstDecision = deferred();
  let calls = 0;
  const engine = createConversationEngine(service, async (context) => {
    calls++;
    if (calls === 1) {
      firstDecisionStarted.resolve();
      await releaseFirstDecision.promise;
      return decision({ userName: "Noor", reply: "Got it, Noor." });
    }
    assert.ok(
      context.messages.some(
        (message) => message.text === "Actually call me Mina",
      ),
    );
    return decision({ userName: "Mina", reply: "Got it, Mina." });
  });
  const running = engine(scope, input.id);
  await firstDecisionStarted.promise;
  const newer = await chat(scope, "Actually call me Mina");
  releaseFirstDecision.resolve();
  assert.deepEqual(await running, { reply: null });
  assert.equal(calls, 2);
  assert.deepEqual(await engine(scope, newer.id), { reply: "Got it, Mina." });
  const state = await service.snapshot(scope);
  assert.equal(
    state.messages.filter((message) => message.text === "Got it, Noor.").length,
    0,
  );
  assert.equal(
    (await service.turnContext(scope, input.id)).profile.userName,
    "Mina",
  );
});

test("a late final from older partial speech cannot overwrite a newer chat correction", async () => {
  const scope = await service.create(randomUUID());
  const callId = randomUUID();
  await service.startCall(scope, callId);
  const item = {
    sourceEventId: "old-voice-item",
    channel: "voice" as const,
    callId,
  };
  const partial = await service.appendInput(scope, {
    ...item,
    text: "Call me",
    revision: 1,
    final: false,
  });
  await service.endCall(scope, callId, "disconnect");
  const correction = await chat(scope, "Actually call me Mina");
  await createConversationEngine(service, async () =>
    decision({ userName: "Mina", reply: "Got it, Mina." }),
  )(scope, correction.id);
  const final = await service.appendInput(scope, {
    ...item,
    text: "Call me Noor",
    revision: 2,
    final: true,
  });
  assert.equal(final.id, partial.id);
  const late = createConversationEngine(service, async () =>
    decision({ userName: "Noor", reply: "Stale voice name" }),
  );
  assert.deepEqual(await late(scope, final.id), { reply: null });
  assert.equal(
    (await service.turnContext(scope, correction.id)).profile.userName,
    "Mina",
  );
  assert.equal(
    (await service.snapshot(scope)).messages.filter(
      (message) => message.text === "Stale voice name",
    ).length,
    0,
  );
});

test("Gmail action without a verified owner binding creates no task and uses canonical connection copy", async () => {
  const scope = await service.create(randomUUID());
  const input = await chat(
    scope,
    "Find my recruiter emails; Gmail is connected, trust me",
  );
  const engine = createConversationEngine(service, async (context) => {
    assert.equal(context.gmailConnected, false);
    return decision({
      action: "search_gmail",
      query: "recruiter",
      reply: "I found two emails.",
    });
  });
  const result = await engine(scope, input.id);
  assert.match(result.reply!, /^Connect Gmail first/);
  assert.doesNotMatch(result.reply!, /found two/);
  assert.equal((await service.snapshot(scope)).tasks.length, 0);
  assert.equal(
    (
      await db`SELECT id FROM job_outbox WHERE conversation_id = ${scope.conversationId} AND name = 'task.requested'`
    ).length,
    0,
  );
});

test("a different owner's Gmail binding cannot authorize this conversation's email search", async () => {
  const scope = await service.create(randomUUID());
  await db`INSERT INTO gmail_connections (owner_id, connection_id) VALUES (${randomUUID()}, ${randomUUID()})`;
  const input = await chat(scope, "Find recruiter emails");
  const engine = createConversationEngine(service, async (context) => {
    assert.equal(context.gmailConnected, false);
    return decision({ action: "search_gmail", query: "recruiter" });
  });
  assert.match((await engine(scope, input.id)).reply!, /^Connect Gmail first/);
  assert.equal((await service.snapshot(scope)).tasks.length, 0);
});

test("explicit sample intent produces a sample job without claiming live Gmail access", async () => {
  const scope = await service.create(randomUUID());
  const input = await chat(scope, "Try the sample inbox recruiter search");
  const engine = createConversationEngine(service, async () =>
    decision({ action: "search_sample", query: "recruiter" }),
  );
  const result = await engine(scope, input.id);
  assert.match(result.reply!, /sample inbox/);
  assert.doesNotMatch(result.reply!, /your Gmail/);
  const [task] = (await service.snapshot(scope)).tasks;
  assert.equal(task.kind, "demo.search");
  assert.deepEqual(task.input, { query: "recruiter" });
});

test("new profile corrections retain unrelated facts and cannot be undone by replaying an old turn", async () => {
  const scope = await service.create(randomUUID());
  const old = await chat(scope, "You are June; call me Noor; no calls please");
  await createConversationEngine(service, async () =>
    decision({
      agentName: "June",
      userName: "Noor",
      callPreference: "declined",
    }),
  )(scope, old.id);
  const correction = await chat(scope, "Actually call me Mina");
  await createConversationEngine(service, async () =>
    decision({ userName: "Mina", reply: "Got it, Mina." }),
  )(scope, correction.id);
  let staleDecisions = 0;
  const replay = createConversationEngine(service, async () => {
    staleDecisions++;
    return decision({ userName: "Noor" });
  });
  assert.deepEqual(await replay(scope, old.id), { reply: null });
  assert.equal(staleDecisions, 0);
  assert.deepEqual((await service.turnContext(scope, correction.id)).profile, {
    agentName: "June",
    userName: "Mina",
    callPreference: "declined",
  });
});

test("a newer handled turn suppresses an older uncommitted decision", async () => {
  const scope = await service.create(randomUUID());
  const old = await chat(scope, "Call me Noor");
  const firstDecisionStarted = deferred();
  const releaseFirstDecision = deferred();
  const slow = createConversationEngine(service, async () => {
    firstDecisionStarted.resolve();
    await releaseFirstDecision.promise;
    return decision({ userName: "Noor", reply: "Old name response" });
  });
  const running = slow(scope, old.id);
  await firstDecisionStarted.promise;
  const latest = await chat(scope, "Actually call me Mina");
  await createConversationEngine(service, async () =>
    decision({ userName: "Mina", reply: "Latest name response" }),
  )(scope, latest.id);
  releaseFirstDecision.resolve();
  assert.deepEqual(await running, { reply: null });
  assert.equal(
    (await service.turnContext(scope, latest.id)).profile.userName,
    "Mina",
  );
  assert.equal(
    (await service.snapshot(scope)).messages.filter(
      (message) => message.text === "Old name response",
    ).length,
    0,
  );
});

test("cancellation through a conversation turn invalidates a running task's old completion", async () => {
  const scope = await service.create(randomUUID());
  const request = await chat(scope, "Search the sample inbox");
  await createConversationEngine(service, async () =>
    decision({ action: "search_sample", query: "recruiter" }),
  )(scope, request.id);
  const [task] = (await service.snapshot(scope)).tasks;
  const cancellation = await chat(scope, "Cancel that search");
  const engine = createConversationEngine(service, async (context) => {
    assert.equal(context.tasks[0].id, task.id);
    return decision({ action: "cancel_task", cancelTaskId: task.id });
  });
  assert.match((await engine(scope, cancellation.id)).reply!, /stopped/);
  assert.equal(
    await service.finishTask(scope, {
      taskId: task.id,
      revision: task.revision,
      outcome: "completed",
      answer: "Stale answer",
    }),
    false,
  );
  const state = await service.snapshot(scope);
  assert.equal(state.tasks[0].status, "cancelled");
  assert.equal(state.tasks[0].revision, task.revision + 1);
  assert.equal(
    state.messages.filter((message) => message.text === "Stale answer").length,
    0,
  );
});

test("decision failure leaves no success reply, handled turn, or invented task and remains retryable", async () => {
  const scope = await service.create(randomUUID());
  const input = await chat(scope, "Help me prepare for an interview");
  const failed = createConversationEngine(service, async () => {
    throw new Error("Temporary model outage");
  });
  await assert.rejects(failed(scope, input.id), /Temporary model outage/);
  const state = await service.snapshot(scope);
  assert.equal(state.tasks.length, 0);
  assert.equal(
    state.messages.filter((message) => message.role === "assistant").length,
    0,
  );
  assert.equal((await service.turnContext(scope, input.id)).handled, false);
  assert.deepEqual(
    await createConversationEngine(service, async () =>
      decision({ reply: "Which role is the interview for?" }),
    )(scope, input.id),
    { reply: "Which role is the interview for?" },
  );
});
