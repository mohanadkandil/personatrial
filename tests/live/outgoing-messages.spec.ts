import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const empty = {
  sequence: 0,
  messages: [],
  tasks: [],
  profile: {},
  gmailConnected: false,
  gmailSource: null,
  cursor: 0,
  hasMore: false,
};

test("outgoing bubble appears before send or polling completes and reconciles by event ID", async ({
  page,
}) => {
  const release = deferred();
  const received = deferred();
  let saved:
    | {
        id: string;
        clientEventId: string;
        role: string;
        text: string;
        sequence: number;
        renderedAt: string;
      }
    | undefined;
  let showSaved = false;

  await page.route("**/api/conversation**", async (route) => {
    const command =
      route.request().method() === "POST"
        ? route.request().postDataJSON()
        : null;
    if (command?.type === "message") {
      saved = {
        id: randomUUID(),
        clientEventId: command.eventId,
        role: "user",
        text: command.text,
        sequence: 2,
        renderedAt: new Date().toISOString(),
      };
      received.resolve();
      await release.promise;
      await route.fulfill({ status: 202, json: {} });
      return;
    }
    await route.fulfill({
      json:
        showSaved && saved ? { ...empty, cursor: 2, messages: [saved] } : empty,
    });
  });

  await page.goto("/chat");
  await expect(
    page.getByRole("button", { name: "Reset conversation" }),
  ).toBeEnabled();
  await page.getByRole("textbox").fill("A message with a slow connection");
  await page.getByRole("button", { name: "Send message" }).click();
  await received.promise;
  await expect(
    page
      .locator(".message-bubble")
      .filter({ hasText: "A message with a slow connection" }),
  ).toBeVisible({ timeout: 1000 });
  await expect(page.getByRole("textbox")).toHaveValue("");
  await expect(page.getByText("Sending…", { exact: true })).toBeVisible();

  showSaved = true;
  await expect(page.getByText("Sending…", { exact: true })).toHaveCount(0);
  await expect(
    page
      .locator(".message-bubble")
      .filter({ hasText: "A message with a slow connection" }),
  ).toHaveCount(1);
  release.resolve();
  await expect(
    page.getByRole("button", { name: "Retry sending message" }),
  ).toHaveCount(0);
});

test("retry after a lost response reuses the event ID and preserves the next draft", async ({
  page,
}) => {
  const ids: string[] = [];
  let saved: object | undefined;
  await page.route("**/api/conversation**", async (route) => {
    const command =
      route.request().method() === "POST"
        ? route.request().postDataJSON()
        : null;
    if (command?.type === "message") {
      ids.push(command.eventId);
      if (ids.length === 1) {
        await route.abort("failed");
        return;
      }
      saved = {
        id: randomUUID(),
        clientEventId: command.eventId,
        role: "user",
        text: command.text,
        sequence: 2,
        renderedAt: new Date().toISOString(),
      };
      await route.fulfill({ status: 202, json: {} });
      return;
    }
    await route.fulfill({
      json: saved ? { ...empty, cursor: 2, messages: [saved] } : empty,
    });
  });
  await page.goto("/chat");
  await expect(
    page.getByRole("button", { name: "Reset conversation" }),
  ).toBeEnabled();
  await page.getByRole("textbox").fill("Please keep this message");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(
    page.getByRole("button", { name: "Retry sending message" }),
  ).toBeVisible();
  await expect(
    page
      .locator(".message-bubble")
      .filter({ hasText: "Please keep this message" }),
  ).toHaveCount(1);
  await page.getByRole("textbox").fill("My next draft");
  await page.getByRole("button", { name: "Retry sending message" }).click();
  await expect.poll(() => ids.length).toBe(2);
  expect(ids[0]).toBe(ids[1]);
  await expect(
    page.getByRole("button", { name: "Retry sending message" }),
  ).toHaveCount(0);
  await expect(page.getByRole("textbox")).toHaveValue("My next draft");
  await expect(
    page
      .locator(".message-bubble")
      .filter({ hasText: "Please keep this message" }),
  ).toHaveCount(1);
});

test("identical messages stay separate and reset discards an unconfirmed send", async ({
  page,
}) => {
  const release = deferred();
  const ids: string[] = [];
  let saved: object | undefined;
  let reset = false;

  await page.route("**/api/conversation**", async (route) => {
    const command =
      route.request().method() === "POST"
        ? route.request().postDataJSON()
        : null;
    if (command?.type === "reset") {
      reset = true;
      await route.fulfill({ json: empty });
      return;
    }
    if (command?.type === "message") {
      ids.push(command.eventId);
      if (ids.length === 1) {
        saved = {
          id: randomUUID(),
          clientEventId: command.eventId,
          role: "user",
          text: command.text,
          sequence: 2,
          renderedAt: new Date().toISOString(),
        };
        await route.fulfill({ status: 202, json: {} });
      } else {
        await release.promise;
        await route.fulfill({ status: 202, json: {} }).catch(() => {});
      }
      return;
    }
    await route.fulfill({
      json:
        !reset && saved ? { ...empty, cursor: 2, messages: [saved] } : empty,
    });
  });

  await page.goto("/chat");
  await expect(
    page.getByRole("button", { name: "Reset conversation" }),
  ).toBeEnabled();
  for (let i = 0; i < 2; i++) {
    await page.getByRole("textbox").fill("Same words, different message");
    await page.getByRole("button", { name: "Send message" }).click();
  }
  await expect.poll(() => ids.length).toBe(2);
  expect(ids[0]).not.toBe(ids[1]);
  await expect(page.getByText("Sent", { exact: true })).toHaveCount(0);
  await expect(
    page
      .locator(".message-bubble")
      .filter({ hasText: "Same words, different message" }),
  ).toHaveCount(2);
  await page.getByRole("button", { name: "Reset conversation" }).click();
  release.resolve();
  await expect(page.locator(".message-row.user")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Retry sending message" }),
  ).toHaveCount(0);
});

test("a stalled send becomes retryable instead of staying in sending forever", async ({
  page,
}) => {
  const release = deferred();
  const received = deferred();
  await page.clock.install();
  await page.route("**/api/conversation**", async (route) => {
    const command =
      route.request().method() === "POST"
        ? route.request().postDataJSON()
        : null;
    if (command?.type === "message") {
      received.resolve();
      await release.promise;
      await route.fulfill({ status: 202, json: {} }).catch(() => {});
      return;
    }
    await route.fulfill({ json: empty });
  });
  await page.goto("/chat");
  await expect(
    page.getByRole("button", { name: "Reset conversation" }),
  ).toBeEnabled();
  await page.getByRole("textbox").fill("Keep this visible during a timeout");
  await page.getByRole("button", { name: "Send message" }).click();
  await received.promise;
  await page.clock.fastForward(10_001);
  await expect(
    page.getByRole("button", { name: "Retry sending message" }),
  ).toBeVisible();
  await expect(
    page
      .locator(".message-bubble")
      .filter({ hasText: "Keep this visible during a timeout" }),
  ).toHaveCount(1);
  release.resolve();
});
