import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { createDatabase } from "../src/server/database";

const url = process.env.DATABASE_URL;

if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname)) {
  throw new Error(
    "This smoke test requires the local database and running app/voice worker.",
  );
}

const directory = await mkdtemp(join(tmpdir(), "persona-voice-test-"));
const audioPath = join(directory, "silence.wav");
const wav = Buffer.alloc(44 + 48000 * 2 * 60);

wav.write("RIFF", 0);
wav.writeUInt32LE(wav.length - 8, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(48000, 24);
wav.writeUInt32LE(96000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(wav.length - 44, 40);
await writeFile(audioPath, wav);

const db = createDatabase(url);
const browser = await chromium.launch({
  channel: "chrome",
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    `--use-file-for-fake-audio-capture=${process.env.VOICE_SMOKE_INPUT || audioPath}`,
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const context = await browser.newContext({ permissions: ["microphone"] });
const page = await context.newPage();
let conversationId: string | undefined;
let readyAt = 0;
let firstAudioAt = 0;

await page.exposeFunction("recordAudio", () => {
  firstAudioAt ||= Date.now();
});

await page.addInitScript(() => {
  const connected = new WeakSet<HTMLMediaElement>();
  setInterval(() => {
    for (const element of document.querySelectorAll("audio")) {
      if (connected.has(element) || !(element.srcObject instanceof MediaStream))
        continue;
      connected.add(element);

      const audio = new AudioContext();
      const source = audio.createMediaStreamSource(element.srcObject);
      const analyser = audio.createAnalyser();
      source.connect(analyser);
      const samples = new Float32Array(analyser.fftSize);

      const timer = setInterval(() => {
        analyser.getFloatTimeDomainData(samples);

        if (samples.some((sample) => Math.abs(sample) > 0.01)) {
          void (
            window as unknown as { recordAudio: () => Promise<void> }
          ).recordAudio();
          clearInterval(timer);
          void audio.close();
        }
      }, 20);
    }
  }, 50);
});

await page.route("**/api/call", async (route) => {
  if (route.request().postDataJSON()?.action === "ready") {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(firstAudioAt, 0, "agent spoke before browser readiness");
    readyAt = Date.now();
  }

  await route.continue();
});

try {
  await page.goto("http://localhost:3100/chat");
  await page.getByRole("button", { name: "Press here", exact: true }).click();
  const cookie = (await context.cookies()).find(
    (item) => item.name === "persona_trial_session",
  );
  assert.ok(cookie);
  const hash = createHash("sha256").update(cookie.value).digest("hex");
  const [session] =
    await db`SELECT conversation_id FROM browser_sessions WHERE token_hash = ${hash}`;
  conversationId = session.conversation_id;

  await page
    .getByRole("button", { name: "End call" })
    .waitFor({ timeout: 45000 });
  const deadline = Date.now() + 45000;

  while (!firstAudioAt && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  assert.ok(readyAt, "browser never confirmed audio readiness");
  assert.ok(firstAudioAt >= readyAt, "no audible greeting after readiness");
  if (process.env.VOICE_SMOKE_INPUT) {
    const taskDeadline = Date.now() + 45000;
    let accepted = false;
    let nameSaved = false;

    while ((!accepted || !nameSaved) && Date.now() < taskDeadline) {
      const tasks =
        await db`SELECT id FROM tasks WHERE conversation_id = ${conversationId} AND kind = 'demo.search'`;
      accepted = tasks.length > 0;
      const [saved] = await db`SELECT profile FROM conversations WHERE id = ${conversationId}`;
      nameSaved = Boolean(saved?.profile.userName);
      if (!accepted || !nameSaved) await new Promise((resolve) => setTimeout(resolve, 250));
    }

    assert.ok(
      accepted,
      "native Realtime did not accept the spoken sample search",
    );
    const jobs =
      await db`SELECT id FROM job_outbox WHERE conversation_id = ${conversationId} AND name = 'input.final'`;
    assert.equal(
      jobs.length,
      0,
      "voice unexpectedly queued the text response model",
    );
    const [profile] =
      await db`SELECT profile FROM conversations WHERE id = ${conversationId}`;
    assert.ok(
      profile.profile.userName,
      "native profile tool did not save the spoken name",
    );
    console.log(
      JSON.stringify({
        nativeSpeechAndTools: true,
        secondResponseModelJobs: jobs.length,
      }),
    );
  }

  const [count] =
    await db`SELECT count(*) FROM messages WHERE conversation_id = ${conversationId} AND channel = 'chat'`;
  if (!process.env.VOICE_SMOKE_INPUT)
    assert.equal(
      Number(count.count),
      0,
      "silent call produced unexpected chat text",
    );
  console.log(
    JSON.stringify({
      passed: true,
      greetingAfterReadyMs: firstAudioAt - readyAt,
    }),
  );
} finally {
  if (conversationId) {
    const calls =
      await db`SELECT id FROM calls WHERE conversation_id = ${conversationId} AND status = 'active'`;

    for (const call of calls) {
      await context.request.post("http://localhost:3100/api/call", {
        headers: { Origin: "http://localhost:3100" },
        data: { action: "end", callId: call.id, reason: "cancel" },
      });
    }
  }

  await browser.close();
  if (conversationId)
    await db`DELETE FROM conversations WHERE id = ${conversationId}`;
  await db.end();
  await rm(directory, { recursive: true, force: true });
}
