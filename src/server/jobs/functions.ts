import { resolveMailbox, canUseTaskMailbox } from "../integrations/mailbox";
import "server-only";
import { Inngest, NonRetriableError } from "inngest";
import { getDatabase } from "../database";
import { ConversationService } from "../conversation/service";
import { runTurn } from "../conversation/engine";
import { recoverCall } from "../conversation/recovery";
import {
  createNangoGmailAdapter,
  NangoGmailError,
} from "../integrations/nango-gmail";
import { JobOutbox, dispatchPendingJobs } from "./outbox";
import { runGmailAgent } from "../tasks/gmail-agent";
import { composeGmailAnswer, decideGmailTask } from "../tasks/gmail-model";

export const inngest = new Inngest({ id: "persona-trial" });

export async function dispatchJobs() {
  return dispatchPendingJobs(new JobOutbox(getDatabase()), async (event) => {
    await inngest.send(event);
  });
}

const reconcile = inngest.createFunction(
  { id: "dispatch-pending-jobs", triggers: { cron: "* * * * *" } },
  async ({ step }) => step.run("dispatch", dispatchJobs),
);

async function executeJob(jobId: string) {
  const db = getDatabase();
  const job = await new JobOutbox(db).get(jobId);

  if (!job) return;

  const service = new ConversationService(db);

  if (job.name === "input.final") {
    await runTurn(job.scope, job.subjectId);
    return;
  }

  if (job.name === "call.recovery") {
    await recoverCall(job.scope, job.subjectId);
    return;
  }

  const task = await service.getTask(job.scope, job.subjectId);

  if (!["pending", "running"].includes(task.status)) return;

  let answer: string;
  let outcome: "completed" | "failed" = "completed";

  if (task.kind === "demo.search") {
    answer =
      "Sample inbox: Alex Rivera invited you to discuss a product engineering role and asked for your availability. This is sample data; your Gmail was not accessed.";
  } else {
    const connection = await resolveMailbox(db, job.scope);

    if (!connection || !(await canUseTaskMailbox(db, job.scope, task.id)))
      throw new NonRetriableError("gmail_not_connected");

    const adapter = createNangoGmailAdapter({
      secretKey: process.env.NANGO_SECRET_KEY ?? "",
      integrationId: process.env.NANGO_INTEGRATION_ID ?? "",
    });

    try {
      const [evidence] = await db`SELECT text FROM evidence
        WHERE id = ${task.evidenceId} AND conversation_id = ${job.scope.conversationId}`;

      const result = await runGmailAgent(
        {
          request: evidence ? String(evidence.text) : String(task.input.query),
          initialQuery: String(task.input.query),
        },
        {
          search: (query, signal) =>
            adapter.searchGmail({
              connectionId: connection.connectionId,
              query,
              limit: 5,
              signal,
            }),
          decide: decideGmailTask,
          compose: composeGmailAnswer,
          isCurrent: async () => {
            const current = await service.getTask(job.scope, task.id);

            return (
              current.revision === task.revision &&
              ["pending", "running"].includes(current.status) &&
              (await canUseTaskMailbox(db, job.scope, task.id))
            );
          },
        },
      );

      if (result.status === "cancelled") {
        if (!(await canUseTaskMailbox(db, job.scope, task.id)))
          throw new NonRetriableError("gmail_access_changed");

        return;
      }

      answer = result.answer;
      outcome = result.status;
    } catch (error) {
      if (error instanceof NonRetriableError) throw error;

      if (error instanceof NangoGmailError && !error.retryable)
        throw new NonRetriableError(error.code);

      throw new Error("gmail_search_retry_required");
    }
  }

  await service.finishTask(job.scope, {
    taskId: task.id,
    revision: task.revision,
    outcome,
    answer,
  });
}

async function reportFailure(jobId: string) {
  const db = getDatabase();
  const job = await new JobOutbox(db).get(jobId);

  if (!job) return;

  const service = new ConversationService(db);

  if (job.name === "task.requested") {
    const task = await service.getTask(job.scope, job.subjectId);

    await service.finishTask(job.scope, {
      taskId: task.id,
      revision: task.revision,
      outcome: "failed",
      answer:
        "I couldn’t finish that search. Your request is saved here. Check that Gmail is connected, then ask me to try again.",
    });
  } else if (job.name === "input.final") {
    await service.failTurn(job.scope, job.subjectId);
  }
}

const execute = inngest.createFunction(
  {
    id: "execute-conversation-job",
    triggers: { event: "persona/job.requested" },
    retries: 3,
    concurrency: { limit: 1, key: "event.data.jobId" },
    onFailure: async ({ event }) => {
      const jobId = event.data.event.data.jobId;

      if (typeof jobId === "string") await reportFailure(jobId);
    },
  },
  async ({ event, step }) => {
    const jobId = event.data.jobId;

    if (typeof jobId !== "string" || !/^[0-9a-f-]{36}$/i.test(jobId))
      throw new NonRetriableError("invalid_job_id");

    const kind = await step.run("load-job-kind", async () => {
      return (await new JobOutbox(getDatabase()).get(jobId))?.name ?? null;
    });

    if (kind === "call.recovery")
      await step.sleep("wait-for-late-speech", "3s");

    await step.run("process-and-persist", async () => {
      await executeJob(jobId);
      return { processed: true };
    });

    await step.run("dispatch-follow-up", dispatchJobs);

    return { processed: true };
  },
);

export const functions = [reconcile, execute];
