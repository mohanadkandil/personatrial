import { createHash, randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { createDatabase } from "../../src/server/database";
import { ConversationService } from "../../src/server/conversation/service";

test("a saved sample task finishes after simulated hangup and reaches a reconnecting browser without another message", async ({
  page,
  context,
}) => {
  const url = process.env.TEST_DATABASE_URL;

  if (!url || !["127.0.0.1", "localhost"].includes(new URL(url).hostname)) {
    throw new Error(
      "Use explicit local TEST_DATABASE_URL, live app and Inngest dev server",
    );
  }

  const db = createDatabase(url);
  let conversationId: string | undefined;

  try {
    await page.goto("/chat");
    await expect(
      page.getByRole("button", { name: "Connect Gmail", exact: true }),
    ).toBeEnabled();

    const cookie = (await context.cookies()).find(
      (entry) => entry.name === "persona_trial_session",
    );

    expect(cookie).toBeDefined();

    const hash = createHash("sha256").update(cookie!.value).digest("hex");
    const [session] =
      await db`SELECT owner_id, conversation_id FROM browser_sessions WHERE token_hash = ${hash}`;
    const scope = {
      ownerId: String(session.owner_id),
      conversationId: String(session.conversation_id),
    };
    conversationId = scope.conversationId;
    const service = new ConversationService(db);
    const callId = randomUUID();

    await context.setOffline(true);
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
        action: "search_sample",
        reply: "I’ll check the sample inbox.",
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

    const jobs =
      await db`SELECT id FROM job_outbox WHERE conversation_id = ${scope.conversationId}`;

    for (const job of jobs) {
      const response = await fetch(
        "http://localhost:8288/e/local-browser-test",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: job.id,
            name: "persona/job.requested",
            data: { jobId: job.id },
          }),
        },
      );

      expect(response.ok).toBe(true);
    }

    await expect
      .poll(async () => (await service.snapshot(scope)).tasks[0]?.status, {
        timeout: 20_000,
      })
      .toBe("completed");

    const saved = (await service.snapshot(scope)).messages.find((message) =>
      message.text.startsWith("Sample inbox:"),
    );

    expect(saved?.renderedAt).toBeNull();
    await context.setOffline(false);
    await expect(
      page.getByText(/Sample inbox: Alex Rivera invited you/),
    ).toBeVisible({ timeout: 10_000 });

    await expect
      .poll(async () => {
        const [message] =
          await db`SELECT rendered_at FROM messages WHERE id = ${saved!.id}`;
        return Boolean(message.rendered_at);
      })
      .toBe(true);

    await page.reload();
    await expect(
      page.getByText(/Sample inbox: Alex Rivera invited you/),
    ).toHaveCount(1);
  } finally {
    await context.setOffline(false);
    await page.goto("about:blank");

    if (conversationId)
      await db`DELETE FROM conversations WHERE id = ${conversationId}`;

    await db.end();
  }
});
