import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/live",
  workers: 1,
  use: { baseURL: "http://localhost:3100", channel: "chrome", headless: true },
});
