import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import postgres from "postgres";
import { ConversationService } from "../../src/server/conversation/service";
import {
  VoiceToolError,
  VoiceToolService,
  type VoiceAction,
} from "../../src/server/conversation/voice-tools";
import type { Scope } from "../../src/server/conversation/types";
import { migrateTestDatabase } from "./migrations";

const url = process.env.TEST_DATABASE_URL;

if (!url)
  throw new Error(
    "Set TEST_DATABASE_URL explicitly to run Postgres integration tests.",
  );

const schema = `test_voice_tools_${randomUUID().replaceAll("-", "")}`;
const admin = postgres(url, { max: 1, onnotice: () => {} });
const db = postgres(url, {
  max: 10,
  connection: { search_path: schema },
  onnotice: () => {},
});
const conversations = new ConversationService(db);
const tools = new VoiceToolService(db);

before(async () => {
  await admin`CREATE SCHEMA ${admin(schema)}`;
  await migrateTestDatabase(db);
});

after(async () => {
  await db.end();
  await admin`DROP SCHEMA IF EXISTS ${admin(schema)} CASCADE`;
  await admin.end();
});

const rejectsWith = (code: VoiceToolError["code"]) => (error: unknown) =>
  error instanceof VoiceToolError && error.code === code;

async function spokenInput(
  scope: Scope,
  callId: string,
  generation: number,
  final = true,
) {
  const inputToken = randomUUID();
  const [conversation] =
    await db`SELECT last_chat_sequence FROM conversations WHERE id = ${scope.conversationId}`;
  const input = {
    inputToken,
    generation,
    expectedChatSequence: Number(conversation.last_chat_sequence),
  };

  await tools.beginInput(scope, callId, input);

  const evidence = await conversations.appendInput(
    scope,
    {
      sourceEventId: `voice:${callId}:${inputToken}:0`,
      channel: "voice",
      callId,
      text: "My name is Noor. Find sample recruiter emails.",
      revision: 1,
      final,
    },
    { queueTurn: false },
  );

  return { inputToken, generation, evidenceId: evidence.id };
}

async function call() {
  const scope = await conversations.create(randomUUID());
  const callId = randomUUID();

  await conversations.startCall(scope, callId);

  const input = await spokenInput(scope, callId, 1);

  return { scope, callId, input };
}

function request(
  input: Awaited<ReturnType<typeof spokenInput>>,
  action: VoiceAction,
) {
  return { ...input, toolCallId: randomUUID(), action };
}

test("native profile tools update user facts without renaming the agent, creating chat bubbles, or queuing a text-model turn", async () => {
  const { scope, callId, input } = await call();

  await db`UPDATE conversations SET profile = '{"agentName":"June","callPreference":"offered"}'::jsonb WHERE id = ${scope.conversationId}`;

  const result = await tools.execute(
    scope,
    callId,
    request(input, {
      action: "save_profile",
      userName: "Noor",
      helpRequest: "Prepare for Tuesday's interview",
      gmailPreference: "declined",
    }),
  );

  assert.equal(result.action, "save_profile");
  assert.deepEqual((await conversations.snapshot(scope)).profile, {
    agentName: "June",
    callPreference: "offered",
    userName: "Noor",
    helpRequest: "Prepare for Tuesday's interview",
    gmailPreference: "declined",
  });
  assert.deepEqual((await conversations.snapshot(scope)).messages, []);
  assert.equal(
    (
      await db`SELECT id FROM job_outbox WHERE conversation_id = ${scope.conversationId}`
    ).length,
    0,
  );
  assert.equal(
    (
      await db`SELECT id FROM evidence WHERE conversation_id = ${scope.conversationId}`
    ).length,
    1,
  );
});

test("concurrent provider call retries accept one task and one durable job, and replay after hangup performs no new mutation", async () => {
  const { scope, callId, input } = await call();
  const command = request(input, {
    action: "search_sample",
    query: "recruiter",
  });
  const results = await Promise.all(
    Array.from({ length: 6 }, () => tools.execute(scope, callId, command)),
  );

  for (const result of results) assert.deepEqual(result, results[0]);
  assert.equal((await conversations.snapshot(scope)).tasks.length, 1);
  assert.deepEqual(
    (await conversations.snapshot(scope)).messages.map(
      (message) => message.text,
    ),
    ["I’ll check the sample inbox and post what I find here."],
  );
  assert.equal(
    (
      await db`SELECT id FROM job_outbox WHERE conversation_id = ${scope.conversationId} AND name = 'task.requested'`
    ).length,
    1,
  );
  assert.equal(
    (
      await db`SELECT tool_call_id FROM voice_tool_calls WHERE call_id = ${callId}`
    ).length,
    1,
  );

  await conversations.endCall(scope, callId, "hangup");

  const before = (await conversations.snapshot(scope)).sequence;

  assert.deepEqual(await tools.execute(scope, callId, command), results[0]);
  assert.equal((await conversations.snapshot(scope)).sequence, before);
  await assert.rejects(
    tools.execute(scope, callId, {
      ...command,
      action: { action: "search_sample", query: "changed" },
    }),
    rejectsWith("conflict"),
  );
});

test("native accepted work survives hangup and its final answer is delivered in chat", async () => {
  const { scope, callId, input } = await call();

  await tools.execute(
    scope,
    callId,
    request(input, { action: "search_sample", query: "recruiter" }),
  );
  await conversations.endCall(scope, callId, "hangup");

  const [task] = (await conversations.snapshot(scope)).tasks;

  assert.equal(
    await conversations.finishTask(scope, {
      taskId: task.id,
      revision: task.revision,
      outcome: "completed",
      answer: "The sample recruiter email asks for your availability.",
    }),
    true,
  );
  assert.deepEqual(
    (await conversations.snapshot(scope)).messages.map(
      (message) => message.text,
    ),
    [
      "I’ll check the sample inbox and post what I find here.",
      "The sample recruiter email asks for your availability.",
    ],
  );
});

test("new speech, newer chat, and ended calls each reject a late uncommitted tool", async () => {
  for (const scenario of ["speech", "chat", "end"] as const) {
    const { scope, callId, input } = await call();

    if (scenario === "speech") await spokenInput(scope, callId, 2);
    if (scenario === "chat") {
      await conversations.appendInput(scope, {
        sourceEventId: randomUUID(),
        channel: "chat",
        text: "Actually call me Mina",
        revision: 1,
        final: true,
      });
    }
    if (scenario === "end")
      await conversations.endCall(scope, callId, "hangup");

    await assert.rejects(
      tools.execute(
        scope,
        callId,
        request(input, { action: "save_profile", userName: "Noor" }),
      ),
      rejectsWith("stale_input"),
    );
    assert.equal(
      (await conversations.snapshot(scope)).profile.userName,
      undefined,
    );
  }
});

test("out-of-order speech generations and old chat baselines cannot establish a new native input", async () => {
  const { scope, callId, input } = await call();

  await spokenInput(scope, callId, 2);
  await assert.rejects(
    tools.beginInput(scope, callId, {
      inputToken: input.inputToken,
      generation: 1,
      expectedChatSequence: 0,
    }),
    rejectsWith("stale_input"),
  );
  await conversations.appendInput(scope, {
    sourceEventId: randomUUID(),
    channel: "chat",
    text: "Text takes over",
    revision: 1,
    final: true,
  });
  await assert.rejects(
    tools.beginInput(scope, callId, {
      inputToken: randomUUID(),
      generation: 3,
      expectedChatSequence: 0,
    }),
    rejectsWith("stale_input"),
  );
});

test("partial, old, and mismatched input evidence cannot authorize a native task", async () => {
  const scope = await conversations.create(randomUUID());
  const callId = randomUUID();

  await conversations.startCall(scope, callId);

  const partial = await spokenInput(scope, callId, 1, false);

  await assert.rejects(
    tools.execute(
      scope,
      callId,
      request(partial, { action: "search_sample", query: "recruiter" }),
    ),
    rejectsWith("stale_input"),
  );

  const latest = await spokenInput(scope, callId, 2);

  await assert.rejects(
    tools.execute(
      scope,
      callId,
      request(
        { ...latest, evidenceId: partial.evidenceId },
        { action: "search_sample", query: "recruiter" },
      ),
    ),
    rejectsWith("stale_input"),
  );
  assert.equal((await conversations.snapshot(scope)).tasks.length, 0);
});

test("scope, call, and evidence IDs cannot cross owner or conversation boundaries", async () => {
  const own = await call();
  const other = await call();

  await assert.rejects(
    tools.execute(
      { ...own.scope, ownerId: other.scope.ownerId },
      own.callId,
      request(own.input, { action: "save_profile", userName: "Injected" }),
    ),
    rejectsWith("not_found"),
  );
  await assert.rejects(
    tools.execute(
      own.scope,
      other.callId,
      request(other.input, { action: "save_profile", userName: "Injected" }),
    ),
    rejectsWith("not_found"),
  );
  await assert.rejects(
    tools.execute(
      own.scope,
      own.callId,
      request(
        { ...own.input, evidenceId: other.input.evidenceId },
        { action: "search_sample", query: "recruiter" },
      ),
    ),
    rejectsWith("not_found"),
  );
});

test("Gmail search requires this owner's verified connection and never substitutes sample data", async () => {
  const { scope, callId, input } = await call();

  await db`INSERT INTO gmail_connections (owner_id, connection_id) VALUES (${randomUUID()}, ${randomUUID()})`;

  const command = request(input, {
    action: "search_gmail",
    query: "recruiter",
  });

  await assert.rejects(
    tools.execute(scope, callId, command),
    rejectsWith("gmail_not_connected"),
  );
  assert.equal((await conversations.snapshot(scope)).tasks.length, 0);

  await db`INSERT INTO gmail_connections (owner_id, connection_id) VALUES (${scope.ownerId}, ${randomUUID()})`;

  const result = await tools.execute(scope, callId, command);

  assert.equal(result.action, "search_gmail");
  assert.equal(
    (await conversations.snapshot(scope)).tasks[0].kind,
    "gmail.search",
  );
});

test("native cancellation invalidates late task completion without exposing another owner's task", async () => {
  const { scope, callId, input } = await call();

  await tools.execute(
    scope,
    callId,
    request(input, { action: "search_sample", query: "recruiter" }),
  );

  const [task] = (await conversations.snapshot(scope)).tasks;
  const cancellation = await spokenInput(scope, callId, 2);

  assert.deepEqual(
    await tools.execute(
      scope,
      callId,
      request(cancellation, { action: "cancel_task", taskId: task.id }),
    ),
    {
      action: "cancel_task",
      taskId: task.id,
      cancelled: true,
    },
  );
  assert.equal(
    await conversations.finishTask(scope, {
      taskId: task.id,
      revision: task.revision,
      outcome: "completed",
      answer: "Stale result",
    }),
    false,
  );

  const other = await call();

  await assert.rejects(
    tools.execute(
      other.scope,
      other.callId,
      request(other.input, { action: "cancel_task", taskId: task.id }),
    ),
    rejectsWith("not_found"),
  );
});

test("goodbye remains playable, suppresses recovery on hangup, and can be revoked by new speech", async () => {
  const ended = await call();

  assert.deepEqual(
    await tools.execute(
      ended.scope,
      ended.callId,
      request(ended.input, { action: "goodbye" }),
    ),
    {
      action: "goodbye",
      goodbyeRequested: true,
    },
  );

  const [active] =
    await db`SELECT status FROM calls WHERE id = ${ended.callId}`;

  assert.equal(active.status, "active");
  await conversations.endCall(ended.scope, ended.callId, "hangup");
  assert.equal(
    await conversations.recoverCall(ended.scope, ended.callId),
    null,
  );

  const resumed = await call();

  await tools.execute(
    resumed.scope,
    resumed.callId,
    request(resumed.input, { action: "goodbye" }),
  );
  await spokenInput(resumed.scope, resumed.callId, 2);

  const [row] =
    await db`SELECT goodbye_requested FROM calls WHERE id = ${resumed.callId}`;

  assert.equal(row.goodbye_requested, false);
});

test("empty profile updates, assistant renames, and unrecognized actions fail before mutation", async () => {
  const { scope, callId, input } = await call();

  await assert.rejects(
    tools.execute(scope, callId, request(input, { action: "save_profile" })),
    rejectsWith("invalid_input"),
  );

  const extra = {
    ...request(input, { action: "save_profile", userName: "Noor" }),
    action: {
      action: "save_profile" as const,
      userName: "Noor",
      agentName: "Renamed",
    },
  };

  await assert.rejects(
    tools.execute(scope, callId, extra),
    rejectsWith("invalid_input"),
  );
  assert.deepEqual((await conversations.snapshot(scope)).profile, {});
  assert.equal(
    (
      await db`SELECT tool_call_id FROM voice_tool_calls WHERE call_id = ${callId}`
    ).length,
    0,
  );
});

test("tool receipt failure rolls back task acceptance, chat acknowledgement, and job together", async () => {
  const { scope, callId, input } = await call();
  const command = request(input, {
    action: "search_sample",
    query: "recruiter",
  });

  await db.unsafe(`CREATE FUNCTION reject_voice_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'simulated_receipt_failure'; END; $$`);
  await db.unsafe(
    "CREATE TRIGGER reject_voice_receipt BEFORE INSERT ON voice_tool_calls FOR EACH ROW EXECUTE FUNCTION reject_voice_receipt()",
  );

  try {
    await assert.rejects(
      tools.execute(scope, callId, command),
      /simulated_receipt_failure/,
    );

    const state = await conversations.snapshot(scope);

    assert.equal(state.tasks.length, 0);
    assert.equal(state.messages.length, 0);
    assert.equal(
      (
        await db`SELECT id FROM job_outbox WHERE conversation_id = ${scope.conversationId}`
      ).length,
      0,
    );
  } finally {
    await db.unsafe("DROP TRIGGER reject_voice_receipt ON voice_tool_calls");
    await db.unsafe("DROP FUNCTION reject_voice_receipt()");
  }

  await tools.execute(scope, callId, command);

  assert.equal((await conversations.snapshot(scope)).tasks.length, 1);
  assert.equal((await conversations.snapshot(scope)).messages.length, 1);
});
