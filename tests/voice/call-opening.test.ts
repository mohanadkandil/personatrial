import assert from "node:assert/strict";
import test from "node:test";
import { openCall } from "../../src/voice/call-opening";

test("the greeting waits for browser audio readiness", async () => {
  let ready = false;
  let waits = 0;
  const spoken: string[] = [];

  await openCall({
    state: async () => ({ active: true, ready }),
    uninterrupted: () => true,
    compose: async () => "Hey! How’s your day going?",
    speak: (text) => {
      assert.equal(
        ready,
        true,
        "greeting started before browser audio was ready",
      );
      spoken.push(text);
    },
    wait: async () => {
      waits += 1;
      ready = true;
    },
  });

  assert.equal(waits, 1);
  assert.equal(spoken.length, 1);
});

test("a caller who starts speaking before readiness gets no competing greeting", async () => {
  let uninterrupted = true;
  let composed = false;

  await openCall({
    state: async () => ({ active: true, ready: false }),
    uninterrupted: () => uninterrupted,
    compose: async () => {
      composed = true;
      return "hello";
    },
    speak: () => assert.fail("must not interrupt the caller"),
    wait: async () => {
      uninterrupted = false;
    },
  });

  assert.equal(composed, false);
});

test("hangup or new speech during greeting composition discards the stale greeting", async () => {
  for (const interruption of ["hangup", "speech"]) {
    let active = true;
    let uninterrupted = true;

    await openCall({
      state: async () => ({ active, ready: true }),
      uninterrupted: () => uninterrupted,
      compose: async () => {
        if (interruption === "hangup") active = false;
        else uninterrupted = false;
        return "hello";
      },
      speak: () => assert.fail("must not play stale speech"),
      wait: async () => {},
    });
  }
});

test("missing browser readiness has a bounded timeout", async () => {
  let attempts = 0;

  await assert.rejects(
    openCall({
      state: async () => ({ active: true, ready: false }),
      uninterrupted: () => true,
      compose: async () => "hello",
      speak: () => assert.fail("must not greet an unready browser"),
      wait: async () => {
        attempts += 1;
      },
      attempts: 3,
    }),
    /caller_audio_not_ready/,
  );

  assert.equal(attempts, 3);
});
