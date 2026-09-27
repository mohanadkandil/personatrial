import { after } from "next/server";

export function dispatchAfterResponse(): void {
  try {
    after(async () => {
      try {
        const { dispatchJobs } = await import("../jobs/functions");
        await dispatchJobs();
      } catch {
        // The scheduled reconciler retries the persisted outbox.
      }
    });
  } catch {
    // A non-Next caller can rely on the same durable reconciler.
  }
}
