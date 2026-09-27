import { test, expect } from "@playwright/test";

test("name, messages, and hangup recovery survive a refresh", async ({
  page,
}) => {
  await page.goto("/chat");
  await page.getByRole("button", { name: "Let’s call you June" }).click();
  await page
    .getByRole("textbox", { name: "Message June" })
    .fill("My name is Noor");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Got it, Noor.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Start voice preview" }).click();
  await expect(
    page.getByText("Your microphone is off.", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "End voice preview" }).click();
  await expect(
    page.getByText("Anything you’ve typed", { exact: false }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("textbox", { name: "Message June" }),
  ).toBeVisible();
  await expect(page.getByText("Got it, Noor.", { exact: false })).toHaveCount(
    1,
  );
});

test("refresh during voice preview restores chat once", async ({ page }) => {
  await page.goto("/chat");
  await page.getByRole("button", { name: "Start voice preview" }).click();
  await page.reload();
  await expect(page.getByText("You’re back.", { exact: false })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "End voice preview" }),
  ).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("You’re back.", { exact: false })).toHaveCount(1);
});

test("sample inbox is opt-in and delivers a result and draft", async ({
  page,
}) => {
  await page.goto("/chat");
  await page
    .getByRole("button", { name: "Give your assistant a little context" })
    .click();
  await page.getByRole("button", { name: "Maybe later" }).click();
  await expect(
    page.getByRole("button", { name: "Sample inbox available" }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Give your assistant a little context" })
    .click();
  await page.getByRole("button", { name: "Try the sample inbox" }).click();
  await page
    .getByRole("textbox", { name: "Message Persona" })
    .fill("Find the recruiter email");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("SAMPLE EMAIL", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Draft a reply to sample email" })
    .click();
  await expect(
    page.getByText("This is a draft only. Nothing has been sent.", {
      exact: false,
    }),
  ).toBeVisible();
});

test("reset is explicit and removes saved state", async ({ page }) => {
  await page.goto("/chat");
  await page.getByRole("button", { name: "Let’s call you June" }).click();
  await page.getByRole("button", { name: "Start fresh", exact: true }).click();
  await page.getByRole("button", { name: "Keep this conversation" }).click();
  await expect(
    page.getByRole("textbox", { name: "Message June" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Start fresh", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Start fresh" })
    .click();
  await page.reload();
  await expect(
    page.getByRole("textbox", { name: "Message Persona" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Let’s call you June" }),
  ).toBeVisible();
});

test("mobile layout has no horizontal overflow and call controls stay visible", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.goto("/chat");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.getByRole("button", { name: "Start voice preview" }).click();
  await expect(
    page.getByRole("button", { name: "End voice preview" }),
  ).toBeInViewport();
  await page.getByRole("button", { name: "Continue in chat" }).click();
  await expect(
    page.getByRole("textbox", { name: "Message Persona" }),
  ).toBeInViewport();
});
