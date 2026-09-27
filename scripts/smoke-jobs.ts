import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createDatabase } from "../src/server/database";
import { ConversationService } from "../src/server/conversation/service";
import { dispatchJobs } from "../src/server/jobs/functions";

async function main() {
  const url = process.env.TEST_DATABASE_URL;

  if (!url || !["127.0.0.1", "localhost"].includes(new URL(url).hostname)) {
    throw new Error("Use an explicit local TEST_DATABASE_URL");
  }

  process.env.DATABASE_URL = url;
  process.env.INNGEST_DEV = "1";

  const db = createDatabase(url);
  const service = new ConversationService(db);
  const scope = await service.create(randomUUID());

  try {
    const callId = randomUUID();

    await service.startCall(scope, callId);

    const evidence = await service.appendInput(scope, {
      sourceEventId: randomUUID(),
      channel: "voice",
      callId,
      text: "Search the sample recruiter inbox",
      revision: 1,
      final: true,
    });

    await service.commitTurn(scope, {
      evidenceId: evidence.id,
      expectedSequence: evidence.conversationSequence,
      decision: {
        reply: "I’ll check the sample inbox.",
        action: "search_sample",
        query: "recruiter",
        agentName: null,
        userName: null,
        helpRequest: null,
        callPreference: null,
        gmailPreference: null,
        cancelTaskId: null,
      },
    });

    await service.endCall(scope, callId, "hangup");
    await dispatchJobs();

    for (let attempt = 0; attempt < 40; attempt += 1) {
      const snapshot = await service.snapshot(scope);

      if (snapshot.tasks[0]?.status === "completed") {
        assert.equal(
          snapshot.messages.filter((message) =>
            message.text.startsWith("Sample inbox:"),
          ).length,
          1,
        );
        assert.equal(snapshot.messages.at(-1)?.renderedAt, null);
        process.stdout.write(
          "Real Inngest execution passed: accepted sample task survived hangup and saved one answer without a follow-up prompt. Model intent and voice transport were simulated.\n",
        );
        return;
      }

      await delay(500);
    }

    throw new Error(
      "The running local Inngest worker did not complete the task",
    );
  } finally {
    await db`DELETE FROM conversations WHERE id = ${scope.conversationId} AND owner_id = ${scope.ownerId}`;
    await db.end();
  }
}

main()
  .then(() => process.exit(0))
  .catch(() => {
    process.stderr.write(
      "Workflow smoke test failed. Check local app, migrations and Inngest dev server.\n",
    );
    process.exit(1);
  });
