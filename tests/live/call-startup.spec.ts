import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";

const snapshot = {
  messages: [],
  tasks: [],
  profile: {},
  gmailConnected: false,
  cursor: 0,
  hasMore: false,
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

async function prepareChat(page: Page) {
  await page.route("**/api/conversation**", (route) =>
    route.fulfill({ json: snapshot }),
  );
  await page.route("**/api/gmail", (route) =>
    route.fulfill({
      json: { connected: false, attempt: null },
    }),
  );
}

test("a cancelled admission resolving late cannot cancel the next call attempt", async ({
  page,
}) => {
  await prepareChat(page);

  const firstStarted = deferred();
  const secondStarted = deferred();
  const releaseFirst = deferred();
  const releaseSecond = deferred();
  const firstId = randomUUID();
  const ends: { callId: string; reason: string }[] = [];
  let starts = 0;

  await page.route("**/api/call", async (route) => {
    const command = route.request().postDataJSON();

    if (command.action === "end") {
      ends.push(command);
      await route.fulfill({ json: { ended: true } });
      return;
    }

    starts += 1;

    if (starts === 1) {
      firstStarted.resolve();
      await releaseFirst.promise;
      await route.fulfill({
        json: {
          callId: firstId,
          url: "wss://unused.example.test",
          token: "never-used-because-attempt-was-cancelled",
        },
      });
    } else {
      secondStarted.resolve();
      await releaseSecond.promise;
      await route.fulfill({ status: 503, json: { error: "test_unavailable" } });
    }
  });

  await page.goto("/chat");
  await page.getByRole("button", { name: "Press here", exact: true }).click();
  await firstStarted.promise;
  await page.getByRole("button", { name: "Cancel call", exact: true }).click();
  await page.getByRole("button", { name: "Press here", exact: true }).click();
  await secondStarted.promise;

  releaseFirst.resolve();

  await expect.poll(() => ends.length).toBe(1);
  expect(ends[0]).toMatchObject({ callId: firstId, reason: "cancel" });
  await expect(
    page.getByRole("button", { name: "Cancel call", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Connecting…", { exact: true })).toBeVisible();

  releaseSecond.resolve();

  await expect(
    page.getByRole("button", { name: "Press here", exact: true }),
  ).toBeVisible();
  expect(ends).toHaveLength(1);
});

test("successful submit preserves a new draft typed while the request is pending", async ({
  page,
}) => {
  await prepareChat(page);

  const sent = deferred();
  const release = deferred();

  await page.route("**/api/conversation", async (route) => {
    const command =
      route.request().method() === "POST"
        ? route.request().postDataJSON()
        : null;

    if (command?.type === "message") {
      sent.resolve();
      await release.promise;
      await route.fulfill({
        status: 202,
        json: { evidenceId: randomUUID(), sequence: 1 },
      });
      return;
    }

    await route.fulfill({ json: snapshot });
  });

  await page.goto("/chat");

  const composer = page.getByRole("textbox", { name: "Message Persona" });

  await composer.fill("First request");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await sent.promise;
  await composer.fill("Actually, use this corrected detail");
  release.resolve();

  await expect(
    page.getByRole("button", { name: "Send message", exact: true }),
  ).toBeEnabled();
  await expect(composer).toHaveValue("Actually, use this corrected detail");
});

test("startup has an overall deadline and cleans up admission that arrives after timeout", async ({
  page,
}) => {
  await prepareChat(page);
  await page.clock.install();

  const started = deferred();
  const release = deferred();
  const callId = randomUUID();
  const ended: string[] = [];

  await page.route("**/api/call", async (route) => {
    const command = route.request().postDataJSON();

    if (command.action === "end") {
      ended.push(command.callId);
      await route.fulfill({ json: { ended: true } });
      return;
    }

    started.resolve();
    await release.promise;
    await route.fulfill({
      json: {
        callId,
        url: "wss://unused.example.test",
        token: "never-used-because-startup-timed-out",
      },
    });
  });

  await page.goto("/chat");
  await page.getByRole("button", { name: "Press here", exact: true }).click();
  await started.promise;
  await page.clock.fastForward(30_001);

  await expect(
    page.getByRole("button", { name: "Press here", exact: true }),
  ).toBeVisible();

  release.resolve();

  await expect.poll(() => ended).toEqual([callId]);
  await expect(
    page.getByRole("button", { name: "Press here", exact: true }),
  ).toBeVisible();
});
