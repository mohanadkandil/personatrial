import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import {
  TranscriptJournal,
  type TranscriptWrite,
} from "../../src/voice/transcript-journal";

function event(
  type: "delta" | "completed" | "failed",
  text?: string,
  itemId = "item1",
) {
  return {
    type: `conversation.item.input_audio_transcription.${type}`,
    item_id: itemId,
    content_index: 0,
    ...(type === "delta" ? { delta: text } : { transcript: text }),
  };
}

function setup(
  onFinal: (id: string, generation: number) => Promise<void> = async () => {},
) {
  const writes: TranscriptWrite[] = [];
  const failures: string[] = [];
  const finals: { id: string; generation: number }[] = [];
  const journal = new TranscriptJournal({
    callId: "call-123",
    append: async (input) => {
      writes.push(input);
      return { id: input.sourceEventId };
    },
    onFinal: async (id, generation) => {
      finals.push({ id, generation });
      await onFinal(id, generation);
    },
    onFailure: (code) => failures.push(code),
  });

  return { journal, writes, failures, finals };
}

test("received deltas are durable cumulative evidence before any final or response", async () => {
  const { journal, writes, finals } = setup();

  journal.receive(event("delta", "Find "), 1);
  journal.receive(event("delta", "my flight"), 1);
  await journal.drain();

  assert.deepEqual(
    writes.map(({ text, revision, final }) => ({ text, revision, final })),
    [
      { text: "Find ", revision: 1, final: false },
      { text: "Find my flight", revision: 2, final: false },
    ],
  );
  assert.equal(finals.length, 0);

  journal.receive(event("completed", "Find my flights."), 1);
  await journal.drain();
  await journal.settleTurns();

  assert.equal(writes[2].sourceEventId, writes[0].sourceEventId);
  assert.equal(writes[2].revision, 3);
  assert.equal(writes[2].final, true);
  assert.equal(finals.length, 1);
  assert.equal(finals[0].generation, 1);
});

test("slow response generation never blocks persistence of the next spoken turn", async () => {
  let release!: () => void;
  const slowTurn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { journal, writes } = setup(() => slowTurn);

  journal.receive(event("completed", "First task"), 1);
  await journal.drain();
  journal.receive(event("delta", "Actually cancel that", "item2"), 2);
  await journal.drain();

  assert.equal(writes.length, 2);
  assert.equal(writes[1].text, "Actually cancel that");
  assert.equal(writes[1].final, false);

  release();
  await journal.settleTurns();
});

test("hangup drain preserves partials and still accepts a late provider final", async () => {
  const { journal, writes, finals } = setup();

  journal.receive(event("delta", "I need"), 1);
  await journal.drain();

  // The worker's disconnect grace drains without closing the provider listener yet.
  journal.receive(event("completed", "I need my flight details"), 2);
  await journal.close();
  await journal.settleTurns();

  assert.equal(writes.length, 2);
  assert.equal(writes[1].final, true);
  assert.equal(finals.length, 1);

  journal.receive(event("delta", "ignored after provider close", "item2"), 3);
  await journal.drain();
  assert.equal(writes.length, 2);
});

test("transcription failure never promotes an incomplete fragment into an actionable turn", async () => {
  const { journal, writes, finals } = setup();

  journal.receive(event("delta", "Send everyone"), 1);
  journal.receive(event("failed"), 1);
  journal.receive(event("completed", "Send everyone"), 1);
  await journal.drain();

  assert.equal(writes.length, 1);
  assert.equal(writes[0].final, false);
  assert.equal(finals.length, 0);
});

test("a late final retains its original speech generation after a newer interruption", async () => {
  const { journal, finals } = setup();

  journal.receive(event("delta", "Old task"), 1);
  journal.receive(event("delta", "Actually wait", "item2"), 2);
  journal.receive(event("completed", "Old task"), 2);
  await journal.drain();
  await journal.settleTurns();

  assert.equal(finals.length, 1);
  assert.equal(finals[0].generation, 1);
});

test("duplicate provider event IDs and repeated finals cannot dispatch twice", async () => {
  const { journal, writes, finals } = setup();
  const delta = { ...event("delta", "Hello"), event_id: "event1" };

  journal.receive(delta, 1);
  journal.receive(delta, 1);
  journal.receive(event("completed", "Hello"), 1);
  journal.receive(event("completed", "Hello"), 1);
  journal.receive(event("delta", "extra"), 1);
  await journal.drain();
  await journal.settleTurns();

  assert.equal(writes.length, 2);
  assert.equal(writes[0].text, "Hello");
  assert.equal(finals.length, 1);
});

test("in-progress completed events stay partial; empty finals do not invent a final transcript", async () => {
  const { journal, writes, finals } = setup();

  journal.receive({ ...event("completed", "Wait"), status: "in_progress" }, 1);
  journal.receive(event("completed", ""), 1);
  await journal.drain();

  assert.equal(writes.length, 1);
  assert.equal(writes[0].final, false);
  assert.equal(finals.length, 0);
});

test("excessive input reports a limit and cannot finalize a truncated instruction", async () => {
  const { journal, writes, failures, finals } = setup();

  journal.receive(event("delta", "a".repeat(7999)), 1);
  journal.receive(event("delta", "too long"), 1);
  journal.receive(event("completed", "truncated"), 1);
  await journal.drain();

  assert.equal(writes.length, 1);
  assert.deepEqual(failures, ["transcript_limit"]);
  assert.equal(finals.length, 0);
});

test("failed persistence is reported and never invokes the response engine", async () => {
  const failures: string[] = [];
  const journal = new TranscriptJournal({
    callId: "call-123",
    append: async () => {
      throw new Error("private database error");
    },
    onFinal: async () => assert.fail("must not respond before durable append"),
    onFailure: (code) => failures.push(code),
  });

  journal.receive(event("completed", "Find my flight"), 1);
  await journal.drain();
  await journal.settleTurns();

  assert.deepEqual(failures, ["transcript_write_failed"]);
});

test("model failures do not poison transcript persistence", async () => {
  const { journal, writes, failures } = setup(async () => {
    throw new Error("private provider error");
  });

  journal.receive(event("completed", "First task"), 1);
  await journal.drain();
  await journal.settleTurns();
  journal.receive(event("delta", "Another thought", "item2"), 2);
  await journal.drain();
  await setImmediate();

  assert.equal(writes.length, 2);
  assert.deepEqual(failures, ["turn_failed"]);
});
