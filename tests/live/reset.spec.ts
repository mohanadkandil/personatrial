import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";

const emptySnapshot = {
  messages: [],
  tasks: [],
  profile: {},
  gmailConnected: true,
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

test("reset clears history, drafts, and names without accepting late polling responses", async ({
  page,
}) => {
  const oldPoll = deferred();
  const releasePoll = deferred();
  let reset = false;
  let polling = false;
  const previous = {
    ...emptySnapshot,
    profile: { agentName: "Nova" },
    messages: [
      {
        id: randomUUID(),
        role: "assistant",
        text: "Your previous conversation",
        sequence: 1,
        renderedAt: new Date().toISOString(),
      },
    ],
    cursor: 1,
  };

  await page.route("**/api/conversation**", async (route) => {
    const command =
      route.request().method() === "POST"
        ? route.request().postDataJSON()
        : null;

    if (command?.type === "reset") {
      reset = true;
      await route.fulfill({ json: emptySnapshot });
      return;
    }

    if (!command && !reset && !polling) {
      polling = true;
      oldPoll.resolve();
      await releasePoll.promise;
      await route.fulfill({ json: previous });
      return;
    }

    await route.fulfill({ json: reset ? emptySnapshot : previous });
  });

  await page.goto("/chat");
  await expect(
    page.getByText("Your previous conversation", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Hey 👋 What would you like to call me?", { exact: true }),
  ).toBeVisible();
  await oldPoll.promise;
  await page.getByRole("textbox").fill("Unsent draft");
  await page.getByRole("button", { name: "Reset conversation" }).click();
  await expect(
    page.getByRole("textbox", { name: "Message Persona" }),
  ).toHaveValue("");
  await expect(
    page.getByText("Your previous conversation", { exact: true }),
  ).toHaveCount(0);

  releasePoll.resolve();

  await expect(
    page.getByText("Hey 👋 What would you like to call me?", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Your previous conversation", { exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".conversation-header")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Connect Gmail", exact: true }),
  ).toBeVisible();
});

test("reset cancels a pending call and stale call admission cannot affect the fresh chat", async ({
  page,
}) => {
  const callStarted = deferred();
  const releaseCall = deferred();
  const callId = randomUUID();
  const ended: string[] = [];

  await page.route("**/api/conversation**", (route) =>
    route.fulfill({ json: emptySnapshot }),
  );
  await page.route("**/api/call", async (route) => {
    const command = route.request().postDataJSON();

    if (command.action === "end") {
      ended.push(command.callId);
      await route.fulfill({ json: { ended: true } });
      return;
    }

    callStarted.resolve();
    await releaseCall.promise;
    await route.fulfill({
      json: {
        callId,
        url: "wss://unused.example.test",
        token: "cancelled-admission",
      },
    });
  });

  await page.goto("/chat");
  await page.getByRole("button", { name: "Press here", exact: true }).click();
  await callStarted.promise;
  await expect(page.locator(".call-loader svg")).toBeVisible();
  await page.screenshot({ path: "test-results/call-loader-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "test-results/call-loader-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Reset conversation" }).click();
  await expect(
    page.getByRole("button", { name: "Press here", exact: true }),
  ).toBeEnabled();
  releaseCall.resolve();

  await expect.poll(() => ended).toEqual([callId]);
  await expect(
    page.getByText("The call couldn’t connect.", { exact: false }),
  ).toHaveCount(0);
  await expect(page.locator(".call-loader")).toHaveCount(0);
});

test("a send finishing after reset cannot clear the new conversation's draft", async ({
  page,
}) => {
  const sent = deferred();
  const release = deferred();

  await page.route("**/api/conversation**", async (route) => {
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

    await route.fulfill({ json: emptySnapshot });
  });

  await page.goto("/chat");
  await page.getByRole("textbox").fill("Old request");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await sent.promise;
  await page.getByRole("button", { name: "Reset conversation" }).click();
  await expect(page.getByRole("textbox")).toHaveValue("");
  await page.getByRole("textbox").fill("New conversation draft");
  release.resolve();

  await expect(page.getByRole("textbox")).toHaveValue("New conversation draft");
  await expect(
    page.getByRole("button", { name: "Send message", exact: true }),
  ).toBeEnabled();
});

test("Gmail setup errors remain readable and task progress uses messages rather than a separate widget", async ({
  page,
}) => {
  await page.route("**/api/conversation**", (route) =>
    route.fulfill({
      json: {
        ...emptySnapshot,
        gmailConnected: false,
        tasks: [{ id: randomUUID(), status: "pending" }],
      },
    }),
  );
  await page.route("**/api/gmail", (route) =>
    route.fulfill({
      status: 503,
      json: {
        error: "not_configured",
        message: "Gmail is not configured yet.",
      },
    }),
  );

  await page.goto("/chat");
  await page
    .getByRole("button", { name: "Connect Gmail", exact: true })
    .click();
  await expect(
    page.getByText("Gmail is not configured yet.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Working on your request…", { exact: false }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Cancel", exact: true }),
  ).toHaveCount(0);
});

test("Connect Gmail resets the shared-inbox conversation before opening a personal connection", async ({ page, context }) => {
  const actions: string[] = [];
  const attemptId = randomUUID();
  let reset = false;
  const old = {
    ...emptySnapshot,
    gmailSource: "demo",
    profile: { agentName: "Nova" },
    messages: [{ id: randomUUID(), role: "assistant", text: "Previous inbox result", sequence: 1, renderedAt: new Date().toISOString() }],
    cursor: 1,
  };
  const fresh = { ...emptySnapshot, gmailConnected: false, gmailSource: null };

  await page.route("**/api/conversation**", async route => {
    const command = route.request().method() === "POST" ? route.request().postDataJSON() : null;

    if (command?.type === "reset") {
      expect(command.disconnectGmail).toBe(true);
      reset = true;
      actions.push("reset");
    }

    await route.fulfill({ json: reset ? fresh : old });
  });
  await page.route("**/api/gmail", async route => {
    const command = route.request().method() === "POST" ? route.request().postDataJSON() : null;

    if (command?.action === "start") {
      expect(reset).toBe(true);
      actions.push("connect");
      await route.fulfill({ json: { attemptId, connectUrl: "https://connect.nango.dev/test" } });
      return;
    }

    await route.fulfill({ json: { connected: false, attempt: { id: attemptId, status: "pending" } } });
  });
  await context.route("https://connect.nango.dev/**", route => route.fulfill({ body: "Test connection" }));

  await page.goto("/chat");
  await expect(page.getByText("Using Mohanad’s Gmail", { exact: true })).toBeVisible();
  await page.getByRole("textbox").fill("Unsent old inbox request");
  const popup = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Connect Gmail", exact: true }).click();
  const connection = await popup;
  await expect(connection).toHaveURL("https://connect.nango.dev/test");
  await expect(page.getByRole("textbox", { name: "Message Persona" })).toHaveValue("");
  await expect(page.getByText("Previous inbox result", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Using Mohanad’s Gmail", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Continue Gmail connection" })).toBeVisible();
  expect(actions).toEqual(["reset", "connect"]);
});
