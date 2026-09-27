import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import postgres from "postgres";
import { createConversationEngine } from "../../src/server/conversation/engine";
import { createCallRecovery } from "../../src/server/conversation/recovery";
import { ConversationService } from "../../src/server/conversation/service";
import type { TurnDecision } from "../../src/server/conversation/decision";
import type { Scope } from "../../src/server/conversation/types";
import { migrateTestDatabase } from "./migrations";

const url = process.env.TEST_DATABASE_URL;

if (!url) {
  throw new Error(
    "Set TEST_DATABASE_URL explicitly to run Postgres integration tests.",
  );
}

const schema = `test_channels_${randomUUID().replaceAll("-", "")}`;
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
    reply: "Let's prepare for your interview.",
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

async function voiceInput(
  scope: Scope,
  callId: string,
  text: string,
  final = true,
) {
  return service.appendInput(scope, {
    sourceEventId: randomUUID(),
    channel: "voice",
    callId,
    text,
    revision: 1,
    final,
  });
}

async function chatInput(scope: Scope, text: string) {
  return service.appendInput(scope, {
    sourceEventId: randomUUID(),
    channel: "chat",
    text,
    revision: 1,
    final: true,
  });
}

async function callWithTask() {
  const scope = await service.create(randomUUID());
  const callId = randomUUID();

  await service.startCall(scope, callId);

  const input = await voiceInput(
    scope,
    callId,
    "Search the sample inbox for recruiters",
  );
  const task = await service.acceptTask(scope, {
    evidenceId: input.id,
    expectedSequence: (await service.snapshot(scope)).sequence,
    kind: "demo.search",
    query: "recruiter",
    idempotencyKey: randomUUID(),
  });

  return { scope, callId, task };
}

test("voice dialogue stays private while the next typed message retains its context", async () => {
  const scope = await service.create(randomUUID());
  const callId = randomUUID();

  await service.startCall(scope, callId);

  const input = await voiceInput(
    scope,
    callId,
    "My engineering interview is on Tuesday",
  );

  await createConversationEngine(service, async () => decision())(
    scope,
    input.id,
  );

  assert.deepEqual((await service.snapshot(scope)).messages, []);

  const stored = await service.history(scope);

  assert.equal(stored.length, 2);
  assert.ok(
    stored.every(
      (message) => message.channel === "voice" && message.callId === callId,
    ),
  );

  await service.endCall(scope, callId, "hangup");

  const typed = await chatInput(scope, "Can we continue preparing here?");

  await createConversationEngine(service, async (context) => {
    assert.ok(
      context.messages.some((message) => message.text.includes("on Tuesday")),
    );
    assert.ok(
      context.messages.some(
        (message) => message.text === "Let's prepare for your interview.",
      ),
    );

    return decision({
      reply: "For Tuesday's interview, let's practice your introduction.",
    });
  })(scope, typed.id);

  const visible = (await service.snapshot(scope)).messages;

  assert.deepEqual(
    visible.map((message) => message.text),
    [
      "Can we continue preparing here?",
      "For Tuesday's interview, let's practice your introduction.",
    ],
  );
});

test("voice task progress and its durable result each appear in chat once without exposing dialogue", async () => {
  const { scope, callId, task } = await callWithTask();

  const pending = (await service.snapshot(scope)).messages;

  assert.equal(pending.length, 1);
  assert.equal(
    pending[0].text,
    "I’ll check the sample inbox and post what I find here.",
  );

  await service.endCall(scope, callId, "hangup");

  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      service.finishTask(scope, {
        taskId: task.id,
        revision: task.revision,
        outcome: "completed",
        answer: "The sample inbox contains two recruiter threads.",
      }),
    ),
  );

  assert.equal(results.filter(Boolean).length, 1);

  const reconnected = new ConversationService(db);
  const visible = (await reconnected.snapshot(scope)).messages;

  assert.equal(visible.length, 2);
  assert.equal(
    visible[1].text,
    "The sample inbox contains two recruiter threads.",
  );
  assert.equal(visible[1].renderedAt, null);
});

test("recovery composes from private dialogue and durable pending work, then posts one contextual message", async () => {
  const { scope, callId } = await callWithTask();

  await service.endCall(scope, callId, "disconnect");

  const recover = createCallRecovery(service, async (context) => {
    assert.equal(context.callId, callId);
    assert.equal(context.reason, "disconnect");
    assert.equal(context.task?.kind, "demo.search");
    assert.equal(context.task?.status, "pending");
    assert.equal(context.task?.query, "recruiter");
    assert.ok(
      context.dialogue.some((message) => message.text.includes("recruiters")),
    );

    return "We got cut off. I'm still checking the sample recruiter emails; we can continue here.";
  });

  await recover(scope, callId);
  await recover(scope, callId);

  const messages = (await service.snapshot(scope)).messages;

  assert.equal(messages.length, 2);
  assert.match(messages[1].text, /sample recruiter emails/);
  assert.doesNotMatch(messages[1].text, /transcript|model|orchestration/i);
});

test("explicit hangup upgrades an earlier disconnect and later disconnect events cannot downgrade it", async () => {
  const scope = await service.create(randomUUID());
  const callId = randomUUID();

  await service.startCall(scope, callId);
  await service.endCall(scope, callId, "disconnect");
  await service.endCall(scope, callId, "hangup");
  await service.endCall(scope, callId, "disconnect");

  const context = await service.recoveryContext(scope, callId);

  assert.equal(context?.reason, "hangup");

  await createCallRecovery(service, async (current) => {
    assert.equal(current.reason, "hangup");

    return "Want to carry on here when it suits you?";
  })(scope, callId);

  const visible = (await service.snapshot(scope)).messages;

  assert.equal(visible.length, 1);
  assert.doesNotMatch(visible[0].text, /disconnect|lost the connection/i);
});

test("explicit hangup while recovery is composing invalidates disconnected copy and recomposes once", async () => {
  const scope = await service.create(randomUUID());
  const callId = randomUUID();

  await service.startCall(scope, callId);
  await service.endCall(scope, callId, "disconnect");

  const started = deferred();
  const release = deferred();
  let attempts = 0;
  const recover = createCallRecovery(service, async (context) => {
    attempts += 1;

    if (attempts === 1) {
      assert.equal(context.reason, "disconnect");
      started.resolve();
      await release.promise;

      return "Looks like we lost the connection.";
    }

    assert.equal(context.reason, "hangup");

    return "Want to carry on here when it suits you?";
  });
  const pending = recover(scope, callId);

  await started.promise;
  await service.endCall(scope, callId, "hangup");

  const upgraded = (await service.snapshot(scope)).sequence;

  await service.endCall(scope, callId, "hangup");
  await service.endCall(scope, callId, "disconnect");

  assert.equal((await service.snapshot(scope)).sequence, upgraded);

  release.resolve();
  await pending;

  assert.equal(attempts, 2);
  assert.deepEqual(
    (await service.snapshot(scope)).messages.map((message) => message.text),
    ["Want to carry on here when it suits you?"],
  );
});

test("recovery waiting on composition is suppressed by resumed chat, goodbye, another call, or a task result", async () => {
  for (const scenario of ["chat", "goodbye", "new-call", "result"] as const) {
    const { scope, callId, task } = await callWithTask();

    await service.endCall(scope, callId, "disconnect");

    const started = deferred();
    const release = deferred();
    const recover = createCallRecovery(service, async () => {
      started.resolve();
      await release.promise;

      return "Stale recovery: want to call again?";
    });
    const pending = recover(scope, callId);

    await started.promise;

    if (scenario === "chat") await chatInput(scope, "Let's continue here");
    if (scenario === "goodbye") await service.endCall(scope, callId, "goodbye");
    if (scenario === "new-call") await service.startCall(scope, randomUUID());
    if (scenario === "result") {
      await service.finishTask(scope, {
        taskId: task.id,
        revision: task.revision,
        outcome: "completed",
        answer: "I found the sample recruiter thread.",
      });
    }

    release.resolve();
    await pending;

    assert.equal(
      (await service.snapshot(scope)).messages.some((message) =>
        message.text.startsWith("Stale recovery"),
      ),
      false,
      scenario,
    );
  }
});

test("late received speech makes recovery recompose instead of committing stale context", async () => {
  const scope = await service.create(randomUUID());
  const callId = randomUUID();

  await service.startCall(scope, callId);
  await voiceInput(scope, callId, "Help with my interview", false);
  await service.endCall(scope, callId, "disconnect");

  const started = deferred();
  const release = deferred();
  let attempts = 0;
  const recover = createCallRecovery(service, async (context) => {
    attempts += 1;

    if (attempts === 1) {
      started.resolve();
      await release.promise;

      return "Old context";
    }

    assert.ok(
      context.dialogue.some((message) => message.text.includes("Tuesday")),
    );

    return "We got cut off while discussing Tuesday's interview. Shall we keep preparing here?";
  });
  const pending = recover(scope, callId);

  await started.promise;
  await voiceInput(scope, callId, "My interview is on Tuesday");
  release.resolve();
  await pending;

  assert.equal(attempts, 2);
  assert.deepEqual(
    (await service.snapshot(scope)).messages.map((message) => message.text),
    [
      "We got cut off while discussing Tuesday's interview. Shall we keep preparing here?",
    ],
  );
});

test("model failure uses a truthful fallback without quoting unfinished speech or inventing accepted work", async () => {
  const scope = await service.create(randomUUID());
  const callId = randomUUID();

  await service.startCall(scope, callId);
  await voiceInput(scope, callId, "Private unfinished detail: find the", false);
  await service.endCall(scope, callId, "hangup");

  await createCallRecovery(service, async () => {
    throw new Error("Simulated model timeout");
  })(scope, callId);

  const state = await service.snapshot(scope);

  assert.equal(state.messages.length, 1);
  assert.equal(state.tasks.length, 0);
  assert.doesNotMatch(
    state.messages[0].text,
    /Private unfinished detail|transcript|still working|searching/i,
  );
});

test("migration hides existing voice messages while keeping typed messages and task results visible", async () => {
  const legacySchema = `test_legacy_${randomUUID().replaceAll("-", "")}`;
  const legacy = postgres(url, {
    max: 1,
    connection: { search_path: legacySchema },
    onnotice: () => {},
  });
  const conversationId = randomUUID();
  const callId = randomUUID();
  const evidenceId = randomUUID();
  const taskId = randomUUID();

  await admin`CREATE SCHEMA ${admin(legacySchema)}`;

  try {
    await legacy.unsafe(
      await readFile(
        new URL("../../db/001_conversations.sql", import.meta.url),
        "utf8",
      ),
    );
    await legacy`INSERT INTO conversations (id, owner_id) VALUES (${conversationId}, ${randomUUID()})`;
    await legacy`INSERT INTO calls (id, conversation_id, status) VALUES (${callId}, ${conversationId}, 'ended')`;
    await legacy`INSERT INTO evidence (id, conversation_id, source_event_id, channel, call_id, text, revision, final, sequence, received_sequence)
      VALUES (${evidenceId}, ${conversationId}, 'speech', 'voice', ${callId}, 'Private voice request', 1, true, 1, 1)`;
    await legacy`INSERT INTO tasks (id, conversation_id, evidence_id, idempotency_key, kind, input, status)
      VALUES (${taskId}, ${conversationId}, ${evidenceId}, 'accepted', 'demo.search', '{}', 'completed')`;

    const messages = [
      {
        source: `input:${evidenceId}`,
        role: "user",
        text: "Private voice request",
      },
      {
        source: `turn:${evidenceId}`,
        role: "assistant",
        text: "Private voice reply",
      },
      {
        source: `accepted:${taskId}`,
        role: "assistant",
        text: "Private task acknowledgement",
      },
      { source: "input:typed-message", role: "user", text: "Typed message" },
      {
        source: `result:${taskId}:1`,
        role: "assistant",
        text: "Useful result",
      },
    ];

    for (const [index, message] of messages.entries()) {
      await legacy`INSERT INTO messages (id, conversation_id, sequence, source_key, role, text)
        VALUES (${randomUUID()}, ${conversationId}, ${index + 1}, ${message.source}, ${message.role}, ${message.text})`;
    }

    await legacy.unsafe(
      await readFile(
        new URL("../../db/004_message_channels.sql", import.meta.url),
        "utf8",
      ),
    );

    const visible =
      await legacy`SELECT text FROM messages WHERE channel = 'chat' ORDER BY sequence`;
    const hidden =
      await legacy`SELECT text, call_id FROM messages WHERE channel = 'voice' ORDER BY sequence`;

    assert.deepEqual(
      visible.map((message) => message.text),
      ["Typed message", "Useful result"],
    );
    assert.equal(hidden.length, 3);
    assert.ok(hidden.every((message) => message.call_id === callId));
  } finally {
    await legacy.end();
    await admin`DROP SCHEMA IF EXISTS ${admin(legacySchema)} CASCADE`;
  }
});
