import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import postgres from "postgres";
import { migrateTestDatabase } from "./migrations";
import { ConversationService } from "../../src/server/conversation/service";
import {
  ConversationError,
  type Scope,
} from "../../src/server/conversation/types";

const url = process.env.TEST_DATABASE_URL;
if (!url)
  throw new Error(
    "Set TEST_DATABASE_URL explicitly to run Postgres integration tests.",
  );

const schema = `test_conversation_${randomUUID().replaceAll("-", "")}`;
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

const rejectsWith = (code: ConversationError["code"]) => (error: unknown) =>
  error instanceof ConversationError && error.code === code;

async function acceptedTask(scope: Scope, callId?: string) {
  const evidence = await service.appendInput(scope, {
    sourceEventId: randomUUID(),
    channel: callId ? "voice" : "chat",
    ...(callId ? { callId } : {}),
    text: "Find the recruiter email",
    revision: 1,
    final: true,
  });
  return service.acceptTask(scope, {
    evidenceId: evidence.id,
    expectedSequence: (await service.snapshot(scope)).sequence,
    kind: "demo.search",
    query: "recruiter",
    idempotencyKey: randomUUID(),
  });
}

test("received partial speech survives hangup but cannot become an accepted task", async () => {
  const scope = await service.create(randomUUID());
  const callId = randomUUID();
  await service.startCall(scope, callId);
  const fragment = await service.appendInput(scope, {
    sourceEventId: "speech-fragment",
    callId,
    channel: "voice",
    text: "Find the email from",
    revision: 1,
    final: false,
  });
  await assert.rejects(
    service.acceptTask(scope, {
      evidenceId: fragment.id,
      expectedSequence: (await service.snapshot(scope)).sequence,
      kind: "demo.search",
      query: "recruiter",
      idempotencyKey: "must-not-accept-fragment",
    }),
    rejectsWith("conflict"),
  );
  await service.endCall(scope, callId, "disconnect");
  await service.recoverCall(scope, callId);
  const state = await service.snapshot(scope);
  assert.equal(state.tasks.length, 0);
  assert.equal(state.evidence[0].text, "Find the email from");
  assert.equal(state.messages.filter((m) => m.role === "user").length, 0);
  assert.doesNotMatch(state.messages[0].text, /Find the email from/);
  assert.doesNotMatch(state.messages[0].text, /transcript|session|model/i);
});

test("duplicate and out-of-order speech events preserve final evidence without leaking voice into chat", async () => {
  const scope = await service.create(randomUUID());
  const callId = randomUUID();
  await service.startCall(scope, callId);
  const input = { sourceEventId: "item-1", callId, channel: "voice" as const };
  await service.appendInput(scope, {
    ...input,
    text: "Find",
    revision: 1,
    final: false,
  });
  await service.appendInput(scope, {
    ...input,
    text: "Find the recruiter email",
    revision: 3,
    final: true,
  });
  await Promise.all([
    service.appendInput(scope, {
      ...input,
      text: "Find the recruiter",
      revision: 2,
      final: false,
    }),
    service.appendInput(scope, {
      ...input,
      text: "Find the recruiter email",
      revision: 3,
      final: true,
    }),
    service.appendInput(scope, {
      ...input,
      text: "late partial",
      revision: 4,
      final: false,
    }),
  ]);
  const state = await service.snapshot(scope);
  assert.equal(state.evidence.length, 1);
  assert.equal(state.evidence[0].final, true);
  assert.equal(state.evidence[0].revision, 3);
  assert.equal(state.evidence[0].text, "Find the recruiter email");
  assert.equal(state.messages.length, 0);
  assert.equal((await service.history(scope)).length, 1);
});

test("concurrent acceptance retries create one task, acknowledgement, and outbox event", async () => {
  const scope = await service.create(randomUUID());
  const evidence = await service.appendInput(scope, {
    sourceEventId: randomUUID(),
    channel: "chat",
    text: "Find recruiter emails",
    revision: 1,
    final: true,
  });
  const request = {
    evidenceId: evidence.id,
    expectedSequence: (await service.snapshot(scope)).sequence,
    kind: "demo.search" as const,
    query: "recruiter",
    idempotencyKey: "request-1",
  };
  const tasks = await Promise.all(
    Array.from({ length: 8 }, () => service.acceptTask(scope, request)),
  );
  assert.equal(new Set(tasks.map((task) => task.id)).size, 1);
  const state = await service.snapshot(scope);
  assert.equal(state.tasks.length, 1);
  assert.equal(state.messages.filter((m) => m.role === "assistant").length, 1);
  const rows =
    await db`SELECT * FROM job_outbox WHERE conversation_id = ${scope.conversationId} AND name = 'task.requested'`;
  assert.equal(rows.length, 1);
  await assert.rejects(
    service.acceptTask(scope, { ...request, query: "changed query" }),
    rejectsWith("conflict"),
  );
});

test("a newer user correction prevents acceptance from an outdated decision", async () => {
  const scope = await service.create(randomUUID());
  const evidence = await service.appendInput(scope, {
    sourceEventId: randomUUID(),
    channel: "chat",
    text: "Find recruiter emails",
    revision: 1,
    final: true,
  });
  const expectedSequence = (await service.snapshot(scope)).sequence;
  await service.appendInput(scope, {
    sourceEventId: randomUUID(),
    channel: "chat",
    text: "Actually, only from this week",
    revision: 1,
    final: true,
  });
  await assert.rejects(
    service.acceptTask(scope, {
      evidenceId: evidence.id,
      expectedSequence,
      kind: "demo.search",
      query: "recruiter",
      idempotencyKey: randomUUID(),
    }),
    rejectsWith("conflict"),
  );
  assert.equal((await service.snapshot(scope)).tasks.length, 0);
});

test("accepted voice task survives hangup and final answer is durable without a user prompt", async () => {
  const scope = await service.create(randomUUID());
  const callId = randomUUID();
  await service.startCall(scope, callId);
  const task = await acceptedTask(scope, callId);
  await service.endCall(scope, callId, "hangup");
  await service.recoverCall(scope, callId);
  assert.equal((await service.getTask(scope, task.id)).status, "pending");
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      service.finishTask(scope, {
        taskId: task.id,
        revision: task.revision,
        outcome: "completed",
        answer: "I found two recruiter threads.",
      }),
    ),
  );
  assert.equal(results.filter(Boolean).length, 1);
  const reconnected = new ConversationService(db);
  const state = await reconnected.snapshot(scope);
  assert.equal(state.tasks[0].status, "completed");
  const answers = state.messages.filter(
    (m) => m.text === "I found two recruiter threads.",
  );
  assert.equal(answers.length, 1);
  assert.equal(answers[0].renderedAt, null);
  assert.equal("readAt" in answers[0], false);
  await reconnected.acknowledgeRendered(scope, [answers[0].id, answers[0].id]);
  const rendered = (await reconnected.snapshot(scope)).messages.find(
    (m) => m.id === answers[0].id,
  )!;
  assert.ok(rendered.renderedAt);
  await reconnected.acknowledgeRendered(scope, [answers[0].id]);
  assert.equal(
    (await reconnected.snapshot(scope)).messages.find(
      (m) => m.id === answers[0].id,
    )!.renderedAt,
    rendered.renderedAt,
  );
});

test("concurrent disconnect notifications and recovery produce one follow-up", async () => {
  const scope = await service.create(randomUUID());
  const callId = randomUUID();
  await service.startCall(scope, callId);
  await Promise.all(
    Array.from({ length: 6 }, () =>
      service.endCall(scope, callId, "disconnect"),
    ),
  );
  const recoveries = await Promise.all(
    Array.from({ length: 6 }, () => service.recoverCall(scope, callId)),
  );
  assert.equal(recoveries.filter(Boolean).length, 1);
  assert.equal((await service.snapshot(scope)).messages.length, 1);
  assert.equal(
    (
      await db`SELECT id FROM job_outbox WHERE conversation_id = ${scope.conversationId} AND name = 'call.recovery'`
    ).length,
    1,
  );
});

test("explicit goodbye or cancellation supersedes an earlier disconnect before recovery", async () => {
  for (const reason of ["goodbye", "cancel"] as const) {
    const scope = await service.create(randomUUID());
    const callId = randomUUID();
    await service.startCall(scope, callId);
    await service.endCall(scope, callId, "disconnect");
    await service.endCall(scope, callId, reason);
    await service.endCall(scope, callId, "disconnect");
    assert.equal(await service.recoverCall(scope, callId), null);
    assert.equal((await service.snapshot(scope)).messages.length, 0);
  }
});

test("late final speech persists one evaluation obligation after the call has ended", async () => {
  const scope = await service.create(randomUUID());
  const callId = randomUUID();
  await service.startCall(scope, callId);
  const input = {
    sourceEventId: "late-final",
    callId,
    channel: "voice" as const,
  };
  await service.appendInput(scope, {
    ...input,
    text: "Find the",
    revision: 1,
    final: false,
  });
  assert.equal(
    (
      await db`SELECT id FROM job_outbox WHERE conversation_id = ${scope.conversationId} AND name = 'input.final'`
    ).length,
    0,
  );
  await service.endCall(scope, callId, "disconnect");
  await service.recoverCall(scope, callId);
  const final = await service.appendInput(scope, {
    ...input,
    text: "Find the recruiter email",
    revision: 2,
    final: true,
  });
  await Promise.all(
    Array.from({ length: 4 }, () =>
      service.appendInput(scope, {
        ...input,
        text: "Find the recruiter email",
        revision: 2,
        final: true,
      }),
    ),
  );
  const obligations =
    await db`SELECT subject_id FROM job_outbox WHERE conversation_id = ${scope.conversationId} AND name = 'input.final'`;
  assert.equal(obligations.length, 1);
  assert.equal(obligations[0].subject_id, final.id);
  assert.equal(
    final.conversationSequence,
    (await service.snapshot(scope)).sequence,
  );
  const task = await service.acceptTask(scope, {
    evidenceId: final.id,
    expectedSequence: final.conversationSequence,
    kind: "demo.search",
    query: "recruiter",
    idempotencyKey: "late-final-task",
  });
  assert.equal(task.status, "pending");
});

test("recovery is suppressed after explicit goodbye, resumed chat, a new call, or delivered task answer", async () => {
  for (const scenario of [
    "goodbye",
    "cancel",
    "chat",
    "new-call",
    "answer",
  ] as const) {
    const scope = await service.create(randomUUID());
    const callId = randomUUID();
    await service.startCall(scope, callId);
    const task =
      scenario === "answer" ? await acceptedTask(scope, callId) : null;
    await service.endCall(
      scope,
      callId,
      scenario === "goodbye" || scenario === "cancel" ? scenario : "disconnect",
    );
    if (scenario === "chat")
      await service.appendInput(scope, {
        sourceEventId: randomUUID(),
        channel: "chat",
        text: "Let's continue here",
        revision: 1,
        final: true,
      });
    if (scenario === "new-call") await service.startCall(scope, randomUUID());
    if (task)
      await service.finishTask(scope, {
        taskId: task.id,
        revision: task.revision,
        outcome: "completed",
        answer: "Found it.",
      });
    assert.equal(await service.recoverCall(scope, callId), null, scenario);
    assert.equal(
      await service.recoverCall(scope, callId),
      null,
      `${scenario} remains suppressed`,
    );
  }
});

test("cancellation invalidates in-flight completion and does not create a stale result", async () => {
  const scope = await service.create(randomUUID());
  const task = await acceptedTask(scope);
  assert.equal(await service.cancelTask(scope, task.id), true);
  const staleResults = await Promise.all(
    Array.from({ length: 5 }, () =>
      service.finishTask(scope, {
        taskId: task.id,
        revision: task.revision,
        outcome: "completed",
        answer: "Stale recruiter answer",
      }),
    ),
  );
  assert.deepEqual(staleResults, [false, false, false, false, false]);
  const state = await service.snapshot(scope);
  assert.equal(state.tasks[0].status, "cancelled");
  assert.equal(state.tasks[0].revision, task.revision + 1);
  assert.equal(
    state.messages.filter((m) => m.text === "Stale recruiter answer").length,
    0,
  );
  assert.equal(await service.cancelTask(scope, task.id), false);
});

test("concurrent cancellation and completion choose one terminal result", async () => {
  for (let iteration = 0; iteration < 6; iteration++) {
    const scope = await service.create(randomUUID());
    const task = await acceptedTask(scope);
    const [cancelled, completed] = await Promise.all([
      service.cancelTask(scope, task.id),
      service.finishTask(scope, {
        taskId: task.id,
        revision: task.revision,
        outcome: "completed",
        answer: "Race result",
      }),
    ]);
    assert.equal(Number(cancelled) + Number(completed), 1);
    const state = await service.snapshot(scope);
    assert.equal(state.tasks[0].status, cancelled ? "cancelled" : "completed");
    assert.equal(
      state.messages.filter((m) => m.text === "Race result").length,
      completed ? 1 : 0,
    );
  }
});

test("another owner cannot read, mutate, finish, or acknowledge a conversation", async () => {
  const scope = await service.create(randomUUID());
  const task = await acceptedTask(scope);
  const stranger = { ...scope, ownerId: randomUUID() };
  const messageId = (await service.snapshot(scope)).messages[0].id;
  await assert.rejects(service.snapshot(stranger), rejectsWith("not_found"));
  await assert.rejects(
    service.getTask(stranger, task.id),
    rejectsWith("not_found"),
  );
  await assert.rejects(
    service.cancelTask(stranger, task.id),
    rejectsWith("not_found"),
  );
  await assert.rejects(
    service.finishTask(stranger, {
      taskId: task.id,
      revision: 1,
      outcome: "completed",
      answer: "Injected",
    }),
    rejectsWith("not_found"),
  );
  await assert.rejects(
    service.acknowledgeRendered(stranger, [messageId]),
    rejectsWith("not_found"),
  );
  await assert.rejects(
    service.appendInput(stranger, {
      sourceEventId: randomUUID(),
      channel: "chat",
      text: "Injected",
      revision: 1,
      final: true,
    }),
    rejectsWith("not_found"),
  );
  assert.equal((await service.snapshot(scope)).messages[0].renderedAt, null);
  assert.equal((await service.getTask(scope, task.id)).status, "pending");
});

test("foreign task, evidence, call and message IDs cannot cross conversation boundaries", async () => {
  const owner = randomUUID();
  const own = await service.create(owner);
  const other = await service.create(owner);
  const callId = randomUUID();
  await service.startCall(other, callId);
  const task = await acceptedTask(other, callId);
  await assert.rejects(service.getTask(own, task.id), rejectsWith("not_found"));
  await assert.rejects(
    service.acceptTask(own, {
      evidenceId: task.evidenceId,
      expectedSequence: 0,
      kind: "demo.search",
      query: "recruiter",
      idempotencyKey: randomUUID(),
    }),
    rejectsWith("not_found"),
  );
  await assert.rejects(
    service.endCall(own, callId, "disconnect"),
    rejectsWith("not_found"),
  );
  await assert.rejects(
    service.appendInput(own, {
      sourceEventId: randomUUID(),
      channel: "voice",
      callId,
      text: "Injected",
      revision: 1,
      final: true,
    }),
    rejectsWith("not_found"),
  );

  await service.finishTask(other, {
    taskId: task.id,
    revision: task.revision,
    outcome: "completed",
    answer: "A result belonging to the other conversation.",
  });

  const foreignMessage = (await service.snapshot(other)).messages[0];
  await service.acknowledgeRendered(own, [foreignMessage.id]);
  assert.equal((await service.snapshot(other)).messages[0].renderedAt, null);
});

test("message cursor paginates replay without loss or duplication across non-message sequence gaps", async () => {
  const scope = await service.create(randomUUID());
  for (let index = 0; index < 106; index++)
    await service.appendInput(scope, {
      sourceEventId: `chat-${index}`,
      channel: "chat",
      text: `Message ${index}`,
      revision: 1,
      final: true,
    });
  const first = await service.snapshot(scope);
  assert.equal(first.messages.length, 100);
  assert.equal(first.hasMore, true);
  const second = await service.snapshot(scope, first.cursor);
  assert.equal(second.messages.length, 6);
  assert.equal(second.hasMore, false);
  assert.equal(
    new Set([...first.messages, ...second.messages].map((m) => m.id)).size,
    106,
  );
  assert.equal(
    (await service.snapshot(scope, second.cursor)).messages.length,
    0,
  );
});

test("failed and empty-result tasks both persist a user-visible answer", async () => {
  for (const outcome of ["failed", "completed"] as const) {
    const scope = await service.create(randomUUID());
    const task = await acceptedTask(scope);
    const answer =
      outcome === "failed"
        ? "I couldn’t finish that search. Please try again."
        : "No recruiter emails matched that search.";
    assert.equal(
      await service.finishTask(scope, {
        taskId: task.id,
        revision: task.revision,
        outcome,
        answer,
      }),
      true,
    );
    const state = await service.snapshot(scope);
    assert.equal(state.tasks[0].status, outcome);
    assert.equal(state.messages.filter((m) => m.text === answer).length, 1);
  }
});

test("a message-write failure rolls back task completion so retry can still deliver the result", async () => {
  const scope = await service.create(randomUUID());
  const task = await acceptedTask(scope);
  await db`ALTER TABLE messages ADD CONSTRAINT reject_test_result CHECK (text <> '__reject_result__')`;
  try {
    await assert.rejects(
      service.finishTask(scope, {
        taskId: task.id,
        revision: task.revision,
        outcome: "completed",
        answer: "__reject_result__",
      }),
    );
    assert.equal((await service.getTask(scope, task.id)).status, "pending");
    const [row] = await db`SELECT result FROM tasks WHERE id = ${task.id}`;
    assert.equal(row.result, null);
  } finally {
    await db`ALTER TABLE messages DROP CONSTRAINT reject_test_result`;
  }
  assert.equal(
    await service.finishTask(scope, {
      taskId: task.id,
      revision: task.revision,
      outcome: "completed",
      answer: "Recovered answer",
    }),
    true,
  );
  assert.equal(
    (await service.snapshot(scope)).messages.filter(
      (m) => m.text === "Recovered answer",
    ).length,
    1,
  );
});
