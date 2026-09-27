import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import postgres from "postgres";
import { ConversationService } from "../../src/server/conversation/service";
import {
  VoiceToolService,
  VoiceToolError,
} from "../../src/server/conversation/voice-tools";
import {
  ConversationError,
  type Scope,
} from "../../src/server/conversation/types";
import type { TurnDecision } from "../../src/server/conversation/decision";
import { migrateTestDatabase } from "./migrations";

const url = process.env.TEST_DATABASE_URL;

if (!url)
  throw new Error(
    "Set TEST_DATABASE_URL explicitly to run Postgres integration tests.",
  );

const schema = `test_task_lifecycle_${randomUUID().replaceAll("-", "")}`;
const admin = postgres(url, { max: 1, onnotice: () => {} });
const db = postgres(url, {
  max: 10,
  connection: { search_path: schema },
  onnotice: () => {},
});
const conversations = new ConversationService(db);
const voice = new VoiceToolService(db);

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
    reply: "I’ll check the sample inbox.",
    agentName: null,
    userName: null,
    helpRequest: null,
    callPreference: null,
    gmailPreference: null,
    action: "search_sample",
    query: "recruiter",
    cancelTaskId: null,
    ...overrides,
  };
}

async function chat(scope: Scope, text: string) {
  return conversations.appendInput(scope, {
    sourceEventId: randomUUID(),
    channel: "chat",
    text,
    revision: 1,
    final: true,
  });
}

async function spoken(scope: Scope, text = "Find sample recruiter emails") {
  const callId = randomUUID();
  const inputToken = randomUUID();
  const toolCallId: string = randomUUID();
  const [conversation] =
    await db`SELECT last_chat_sequence FROM conversations WHERE id = ${scope.conversationId}`;

  await conversations.startCall(scope, callId);
  await voice.beginInput(scope, callId, {
    inputToken,
    generation: 1,
    expectedChatSequence: Number(conversation.last_chat_sequence),
  });

  const evidence = await conversations.appendInput(
    scope,
    {
      sourceEventId: `voice:${callId}:${inputToken}:0`,
      channel: "voice",
      callId,
      text,
      revision: 1,
      final: true,
    },
    { queueTurn: false },
  );

  return {
    scope,
    callId,
    inputToken,
    generation: 1,
    evidenceId: evidence.id,
    toolCallId,
    idempotencyKey: randomUUID(),
  };
}

type Fixture = Awaited<ReturnType<typeof spoken>>;
type Path = "direct" | "turn" | "voice";

async function accept(fixture: Fixture, path: Path, query = "recruiter") {
  const { scope, evidenceId } = fixture;
  const expectedSequence = (await conversations.snapshot(scope)).sequence;

  if (path === "direct") {
    return conversations.acceptTask(scope, {
      evidenceId,
      expectedSequence,
      kind: "demo.search",
      query,
      idempotencyKey: fixture.idempotencyKey,
    });
  }

  if (path === "turn") {
    return conversations.commitTurn(scope, {
      evidenceId,
      expectedSequence,
      decision: decision({ query }),
    });
  }

  return voice.execute(scope, fixture.callId, {
    toolCallId: fixture.toolCallId,
    inputToken: fixture.inputToken,
    generation: fixture.generation,
    evidenceId,
    action: { action: "search_sample", query },
  });
}

async function taskCounts(scope: Scope) {
  const [counts] = await db`SELECT
    (SELECT count(*)::int FROM tasks WHERE conversation_id = ${scope.conversationId}) AS tasks,
    (SELECT count(*)::int FROM job_outbox WHERE conversation_id = ${scope.conversationId} AND name = 'task.requested') AS jobs,
    (SELECT count(*)::int FROM messages WHERE conversation_id = ${scope.conversationId} AND role = 'assistant') AS acknowledgements`;

  return {
    tasks: counts.tasks,
    jobs: counts.jobs,
    acknowledgements: counts.acknowledgements,
  };
}

test("one evidence item replayed through all acceptance paths retains one task, job, and acknowledgement in every order", async () => {
  const orders: Path[][] = [
    ["direct", "turn", "voice"],
    ["direct", "voice", "turn"],
    ["turn", "direct", "voice"],
    ["turn", "voice", "direct"],
    ["voice", "direct", "turn"],
    ["voice", "turn", "direct"],
  ];

  for (const order of orders) {
    const fixture = await spoken(await conversations.create(randomUUID()));
    let acceptedId: string | undefined;

    for (const path of [...order, ...order]) {
      await accept(fixture, path);

      const [task] = (await conversations.snapshot(fixture.scope)).tasks;

      acceptedId ??= task.id;
      assert.equal(task.id, acceptedId, order.join(" → "));
      assert.deepEqual(
        await taskCounts(fixture.scope),
        { tasks: 1, jobs: 1, acknowledgements: 1 },
        order.join(" → "),
      );
    }
  }
});

test("changing the query when another path has already accepted the evidence is a conflict", async () => {
  for (const first of ["direct", "voice"] as const) {
    const fixture = await spoken(await conversations.create(randomUUID()));

    await accept(fixture, first);

    for (const path of ["direct", "turn", "voice"] as const) {
      await assert.rejects(
        accept(fixture, path, "train booking"),
        (error: unknown) => {
          assert.ok(
            error instanceof ConversationError ||
              error instanceof VoiceToolError,
          );
          assert.equal(error.code, "conflict");
          return true;
        },
      );
    }

    const [task] = (await conversations.snapshot(fixture.scope)).tasks;

    assert.deepEqual(task.input, { query: "recruiter" });
    assert.deepEqual(await taskCounts(fixture.scope), {
      tasks: 1,
      jobs: 1,
      acknowledgements: 1,
    });
  }
});

test("chat and direct cancellation of voice-accepted work each invalidate an in-flight completion", async () => {
  for (const path of ["turn", "direct"] as const) {
    const fixture = await spoken(await conversations.create(randomUUID()));

    await accept(fixture, "voice");

    const [task] = (await conversations.snapshot(fixture.scope)).tasks;

    if (path === "turn") {
      const input = await chat(fixture.scope, "Cancel that search");

      await conversations.commitTurn(fixture.scope, {
        evidenceId: input.id,
        expectedSequence: (await conversations.snapshot(fixture.scope))
          .sequence,
        decision: decision({
          action: "cancel_task",
          query: null,
          cancelTaskId: task.id,
        }),
      });
    } else {
      assert.equal(
        await conversations.cancelTask(fixture.scope, task.id),
        true,
      );
    }

    assert.equal(await conversations.cancelTask(fixture.scope, task.id), false);
    assert.equal(
      await conversations.finishTask(fixture.scope, {
        taskId: task.id,
        revision: task.revision,
        outcome: "completed",
        answer: "Stale result after cancellation",
      }),
      false,
    );

    const cancelled = await conversations.getTask(fixture.scope, task.id);

    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.revision, task.revision + 1);
    assert.deepEqual(await taskCounts(fixture.scope), {
      tasks: 1,
      jobs: 1,
      acknowledgements: 2,
    });
    assert.equal(
      (await conversations.snapshot(fixture.scope)).messages.some((message) =>
        message.text.includes("Stale result"),
      ),
      false,
    );
  }
});

test("a voice cancellation can cancel a chat-accepted task without duplicating its acknowledgement", async () => {
  const scope = await conversations.create(randomUUID());
  const input = await chat(scope, "Find sample recruiter emails");

  await conversations.commitTurn(scope, {
    evidenceId: input.id,
    expectedSequence: input.conversationSequence,
    decision: decision(),
  });

  const [task] = (await conversations.snapshot(scope)).tasks;
  const cancellation = await spoken(scope, "Cancel that search");
  const command = {
    toolCallId: cancellation.toolCallId,
    inputToken: cancellation.inputToken,
    generation: cancellation.generation,
    evidenceId: cancellation.evidenceId,
    action: { action: "cancel_task" as const, taskId: task.id },
  };

  const result = await voice.execute(scope, cancellation.callId, command);

  assert.deepEqual(result, {
    action: "cancel_task",
    taskId: task.id,
    cancelled: true,
  });
  assert.deepEqual(
    await voice.execute(scope, cancellation.callId, command),
    result,
  );
  assert.equal(
    (await conversations.getTask(scope, task.id)).revision,
    task.revision + 1,
  );
  assert.deepEqual(await taskCounts(scope), {
    tasks: 1,
    jobs: 1,
    acknowledgements: 2,
  });
  assert.equal(
    await conversations.finishTask(scope, {
      taskId: task.id,
      revision: task.revision,
      outcome: "completed",
      answer: "Late chat task result",
    }),
    false,
  );
});

test("neither a foreign owner nor another conversation can cancel a voice-accepted task", async () => {
  const original = await spoken(await conversations.create(randomUUID()));

  await accept(original, "voice");

  const [task] = (await conversations.snapshot(original.scope)).tasks;
  const ownOtherConversation = await conversations.create(
    original.scope.ownerId,
  );
  const foreignOwner = { ...original.scope, ownerId: randomUUID() };

  for (const scope of [foreignOwner, ownOtherConversation]) {
    await assert.rejects(
      conversations.cancelTask(scope, task.id),
      (error: unknown) =>
        error instanceof ConversationError && error.code === "not_found",
    );
  }

  const foreignCall = await spoken(await conversations.create(randomUUID()));

  await assert.rejects(
    voice.execute(foreignCall.scope, foreignCall.callId, {
      toolCallId: foreignCall.toolCallId,
      inputToken: foreignCall.inputToken,
      generation: foreignCall.generation,
      evidenceId: foreignCall.evidenceId,
      action: { action: "cancel_task", taskId: task.id },
    }),
    (error: unknown) =>
      error instanceof VoiceToolError && error.code === "not_found",
  );

  assert.equal(
    (await conversations.getTask(original.scope, task.id)).status,
    "pending",
  );
});

test("a decision started before a correction cannot accept stale work even when retried at the latest sequence", async () => {
  const scope = await conversations.create(randomUUID());
  const original = await chat(scope, "Find sample recruiter emails");
  const expectedSequence = (await conversations.turnContext(scope, original.id))
    .sequence;

  await chat(scope, "Actually, cancel that request. I do not need a search.");
  await assert.rejects(
    conversations.commitTurn(scope, {
      evidenceId: original.id,
      expectedSequence,
      decision: decision(),
    }),
    (error: unknown) =>
      error instanceof ConversationError && error.code === "conflict",
  );

  assert.deepEqual(
    await conversations.commitTurn(scope, {
      evidenceId: original.id,
      expectedSequence: (await conversations.snapshot(scope)).sequence,
      decision: decision(),
    }),
    { reply: null },
  );
  assert.deepEqual(await taskCounts(scope), {
    tasks: 0,
    jobs: 0,
    acknowledgements: 0,
  });
});

test("failure to persist acceptance rolls back the task and job for every public entry path", async () => {
  for (const path of ["direct", "turn", "voice"] as const) {
    const fixture = await spoken(await conversations.create(randomUUID()));

    await db.unsafe(`CREATE FUNCTION reject_acceptance_message() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.role = 'assistant' THEN RAISE EXCEPTION 'acceptance_storage_failure'; END IF; RETURN NEW; END; $$`);
    await db.unsafe(
      "CREATE TRIGGER reject_acceptance_message BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION reject_acceptance_message()",
    );

    try {
      await assert.rejects(accept(fixture, path), /acceptance_storage_failure/);
      assert.deepEqual(await taskCounts(fixture.scope), {
        tasks: 0,
        jobs: 0,
        acknowledgements: 0,
      });
      assert.equal(
        (
          await db`SELECT evidence_id FROM turns WHERE conversation_id = ${fixture.scope.conversationId}`
        ).length,
        0,
      );
      assert.equal(
        (
          await db`SELECT tool_call_id FROM voice_tool_calls WHERE call_id = ${fixture.callId}`
        ).length,
        0,
      );
    } finally {
      await db.unsafe("DROP TRIGGER reject_acceptance_message ON messages");
      await db.unsafe("DROP FUNCTION reject_acceptance_message()");
    }

    await accept(fixture, path);
    assert.deepEqual(await taskCounts(fixture.scope), {
      tasks: 1,
      jobs: 1,
      acknowledgements: 1,
    });
  }
});

test("all acceptance paths require this owner's Gmail connection even when a different owner is connected", async () => {
  await db`INSERT INTO gmail_connections (owner_id, connection_id) VALUES (${randomUUID()}, ${randomUUID()})`;

  for (const path of ["direct", "turn", "voice"] as const) {
    const fixture = await spoken(await conversations.create(randomUUID()));
    const expectedSequence = (await conversations.snapshot(fixture.scope))
      .sequence;

    if (path === "direct") {
      await assert.rejects(
        conversations.acceptTask(fixture.scope, {
          evidenceId: fixture.evidenceId,
          expectedSequence,
          kind: "gmail.search",
          query: "recruiter",
          idempotencyKey: fixture.idempotencyKey,
        }),
        (error: unknown) =>
          error instanceof ConversationError && error.code === "conflict",
      );
    } else if (path === "turn") {
      const result = await conversations.commitTurn(fixture.scope, {
        evidenceId: fixture.evidenceId,
        expectedSequence,
        decision: decision({ action: "search_gmail" }),
      });

      assert.match(result.reply ?? "", /connect gmail/i);
    } else {
      await assert.rejects(
        voice.execute(fixture.scope, fixture.callId, {
          toolCallId: fixture.toolCallId,
          inputToken: fixture.inputToken,
          generation: fixture.generation,
          evidenceId: fixture.evidenceId,
          action: { action: "search_gmail", query: "recruiter" },
        }),
        (error: unknown) =>
          error instanceof VoiceToolError &&
          error.code === "gmail_not_connected",
      );
    }

    const counts = await taskCounts(fixture.scope);

    assert.equal(counts.tasks, 0);
    assert.equal(counts.jobs, 0);
  }
});

test("an idempotency key from one task cannot alias a different already accepted evidence item", async () => {
  const scope = await conversations.create(randomUUID());
  const first = await chat(scope, "Find sample recruiter emails");
  const firstKey = randomUUID();

  await conversations.acceptTask(scope, {
    evidenceId: first.id,
    expectedSequence: first.conversationSequence,
    kind: "demo.search",
    query: "recruiter",
    idempotencyKey: firstKey,
  });

  const second = await chat(scope, "Run another sample recruiter search");
  const secondKey = randomUUID();

  await conversations.acceptTask(scope, {
    evidenceId: second.id,
    expectedSequence: second.conversationSequence,
    kind: "demo.search",
    query: "recruiter",
    idempotencyKey: secondKey,
  });
  await assert.rejects(
    conversations.acceptTask(scope, {
      evidenceId: first.id,
      expectedSequence: (await conversations.snapshot(scope)).sequence,
      kind: "demo.search",
      query: "recruiter",
      idempotencyKey: secondKey,
    }),
    (error: unknown) =>
      error instanceof ConversationError && error.code === "conflict",
  );

  assert.deepEqual(await taskCounts(scope), {
    tasks: 2,
    jobs: 2,
    acknowledgements: 2,
  });
});

test("a valid 200-character provider tool call ID accepts and replays one task", async () => {
  const fixture = await spoken(await conversations.create(randomUUID()));
  fixture.toolCallId = "call_" + "x".repeat(195);

  await accept(fixture, "voice");
  await accept(fixture, "voice");
  await accept(fixture, "direct");
  await accept(fixture, "turn");

  assert.deepEqual(await taskCounts(fixture.scope), {
    tasks: 1,
    jobs: 1,
    acknowledgements: 1,
  });

  const receipts =
    await db`SELECT tool_call_id FROM voice_tool_calls WHERE call_id = ${fixture.callId}`;

  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].tool_call_id, fixture.toolCallId);
});

test("a turn reusing direct acceptance advances the version for new profile facts but receipt replay does not", async () => {
  const fixture = await spoken(
    await conversations.create(randomUUID()),
    "My name is Noor. Find sample recruiter emails.",
  );

  await accept(fixture, "direct");

  const before = await conversations.snapshot(fixture.scope);
  const command = {
    evidenceId: fixture.evidenceId,
    expectedSequence: before.sequence,
    decision: decision({ userName: "Noor" }),
  };

  await conversations.commitTurn(fixture.scope, command);

  const updated = await conversations.snapshot(fixture.scope);

  assert.equal(updated.profile.userName, "Noor");
  assert.ok(updated.sequence > before.sequence);
  assert.deepEqual(await taskCounts(fixture.scope), {
    tasks: 1,
    jobs: 1,
    acknowledgements: 1,
  });
  assert.deepEqual(await conversations.commitTurn(fixture.scope, command), {
    reply: null,
  });
  assert.equal(
    (await conversations.snapshot(fixture.scope)).sequence,
    updated.sequence,
  );
  assert.deepEqual(await taskCounts(fixture.scope), {
    tasks: 1,
    jobs: 1,
    acknowledgements: 1,
  });
});
