import { randomUUID } from "node:crypto";
import type { Database } from "../database";
import type { Scope } from "../conversation/types";

export type JobName = "input.final" | "task.requested" | "call.recovery";

export type PendingJob = {
  id: string;
  name: JobName;
  subjectId: string;
  scope: Scope;
  leaseToken: string;
};

type JobRow = {
  id: string;
  name: JobName;
  subject_id: string;
  conversation_id: string;
  owner_id: string;
  lease_token: string;
};

export class JobOutbox {
  constructor(private readonly db: Database) {}

  async claim(limit = 25): Promise<PendingJob[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Invalid job batch size");
    }

    const leaseToken = randomUUID();
    const rows = await this.db<JobRow[]>`
      WITH candidates AS (
        SELECT id FROM job_outbox
        WHERE published_at IS NULL
          AND available_at <= now()
          AND (lease_until IS NULL OR lease_until < now())
        ORDER BY available_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      ), claimed AS (
        UPDATE job_outbox AS jobs
        SET lease_token = ${leaseToken}, lease_until = now() + interval '60 seconds', attempts = attempts + 1
        FROM candidates
        WHERE jobs.id = candidates.id
        RETURNING jobs.*
      )
      SELECT claimed.*, conversations.owner_id
      FROM claimed JOIN conversations ON conversations.id = claimed.conversation_id
    `;

    return rows.map(toJob);
  }

  async markPublished(job: PendingJob): Promise<boolean> {
    const rows = await this.db`
      UPDATE job_outbox SET published_at = now(), lease_until = NULL, lease_token = NULL
      WHERE id = ${job.id} AND lease_token = ${job.leaseToken} AND lease_until > now()
      RETURNING id
    `;

    return rows.length === 1;
  }

  async release(job: PendingJob): Promise<void> {
    await this.db`
      UPDATE job_outbox
      SET lease_until = NULL, lease_token = NULL, available_at = now() + interval '10 seconds'
      WHERE id = ${job.id} AND lease_token = ${job.leaseToken}
    `;
  }

  async get(jobId: string): Promise<Omit<PendingJob, "leaseToken"> | null> {
    const [row] = await this.db<JobRow[]>`
      SELECT jobs.*, conversations.owner_id
      FROM job_outbox jobs JOIN conversations ON conversations.id = jobs.conversation_id
      WHERE jobs.id = ${jobId}
    `;

    if (!row) return null;

    const { leaseToken: _, ...job } = toJob(row);

    return job;
  }
}

export async function dispatchPendingJobs(
  outbox: JobOutbox,
  publish: (event: {
    id: string;
    name: "persona/job.requested";
    data: { jobId: string };
  }) => Promise<void>,
): Promise<{ published: number; deferred: number }> {
  const jobs = await outbox.claim();
  let published = 0;
  let deferred = 0;

  for (const job of jobs) {
    try {
      await publish({
        id: job.id,
        name: "persona/job.requested",
        data: { jobId: job.id },
      });

      if (await outbox.markPublished(job)) {
        published += 1;
      } else {
        deferred += 1;
      }
    } catch {
      await outbox.release(job);
      deferred += 1;
    }
  }

  return { published, deferred };
}

function toJob(row: JobRow): PendingJob {
  return {
    id: row.id,
    name: row.name,
    subjectId: row.subject_id,
    scope: { ownerId: row.owner_id, conversationId: row.conversation_id },
    leaseToken: row.lease_token,
  };
}
