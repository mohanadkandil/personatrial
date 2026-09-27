import { resolveMailbox } from "../integrations/mailbox";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Transaction } from "../database";
import type { Scope, Task } from "./types";

const acceptanceSchema = z.object({
  evidenceId: z.uuid(),
  kind: z.enum(["gmail.search", "demo.search"]),
  query: z
    .string()
    .min(1)
    .max(500)
    .refine((value) => Boolean(value.trim())),
  idempotencyKey: z.string().min(1).max(200),
  expectedSequence: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
});

type Acceptance = z.infer<typeof acceptanceSchema>;
type TaskRow = {
  id: string;
  evidence_id: string;
  kind: Task["kind"];
  input: { query: string };
  status: Task["status"];
  revision: number;
};

export class TaskLifecycleError extends Error {
  constructor(
    public readonly code:
      | "invalid_input"
      | "not_found"
      | "conflict"
      | "gmail_not_connected"
      | "task_limit",
  ) {
    super(code);
    this.name = "TaskLifecycleError";
  }
}

async function lockConversation(tx: Transaction, scope: Scope) {
  const [conversation] = await tx`SELECT sequence FROM conversations
    WHERE id = ${scope.conversationId} AND owner_id = ${scope.ownerId} FOR UPDATE`;

  if (!conversation) throw new TaskLifecycleError("not_found");

  return Number(conversation.sequence);
}

async function acknowledge(
  tx: Transaction,
  conversationId: string,
  source: string,
  text: string,
) {
  const [conversation] =
    await tx`UPDATE conversations SET sequence = sequence + 1
    WHERE id = ${conversationId} RETURNING sequence`;

  await tx`INSERT INTO messages (id, conversation_id, sequence, source_key, role, text, channel)
    VALUES (${randomUUID()}, ${conversationId}, ${conversation.sequence}, ${source}, 'assistant', ${text}, 'chat')`;
}

function acceptanceMessage(kind: Task["kind"]) {
  return kind === "gmail.search"
    ? "I’ll check your Gmail and post what I find here."
    : "I’ll check the sample inbox and post what I find here.";
}

// The caller supplies its transaction so channel guards, receipts and task effects commit together.
export async function acceptTask(
  tx: Transaction,
  scope: Scope,
  input: Acceptance,
): Promise<{ task: Task; created: boolean; message: string }> {
  const checked = acceptanceSchema.safeParse(input);

  if (!checked.success) throw new TaskLifecycleError("invalid_input");

  const request = checked.data;
  const currentSequence = await lockConversation(tx, scope);
  const existing = await tx<TaskRow[]>`SELECT * FROM tasks
    WHERE conversation_id = ${scope.conversationId}
      AND (idempotency_key = ${request.idempotencyKey}
        OR (evidence_id = ${request.evidenceId} AND kind = ${request.kind}))`;

  if (existing.length) {
    const [task] = existing;

    if (
      existing.length !== 1 ||
      task.evidence_id !== request.evidenceId ||
      task.kind !== request.kind ||
      task.input.query !== request.query
    )
      throw new TaskLifecycleError("conflict");

    return {
      task: toTask(task),
      created: false,
      message: acceptanceMessage(task.kind),
    };
  }

  if (
    request.expectedSequence !== undefined &&
    currentSequence !== request.expectedSequence
  ) {
    throw new TaskLifecycleError("conflict");
  }

  const [evidence] = await tx`SELECT final FROM evidence
    WHERE id = ${request.evidenceId} AND conversation_id = ${scope.conversationId}`;

  if (!evidence) throw new TaskLifecycleError("not_found");
  if (!evidence.final) throw new TaskLifecycleError("conflict");

  const mailbox =
    request.kind === "gmail.search" ? await resolveMailbox(tx, scope) : null;

  if (request.kind === "gmail.search" && !mailbox)
    throw new TaskLifecycleError("gmail_not_connected");

  const [{ count }] = await tx`SELECT count(*)::int AS count FROM tasks
    WHERE conversation_id = ${scope.conversationId} AND status IN ('pending', 'running')`;

  if (count >= 20) throw new TaskLifecycleError("task_limit");

  const taskId = randomUUID();
  const [task] = await tx<TaskRow[]>`INSERT INTO tasks
    (id, conversation_id, evidence_id, idempotency_key, kind, input, status, gmail_connection_id)
    VALUES (${taskId}, ${scope.conversationId}, ${request.evidenceId}, ${request.idempotencyKey},
      ${request.kind}, ${tx.json({ query: request.query })}, 'pending', ${mailbox?.connectionId ?? null}) RETURNING *`;

  await tx`INSERT INTO job_outbox (id, conversation_id, name, subject_id)
    VALUES (${randomUUID()}, ${scope.conversationId}, 'task.requested', ${taskId})`;

  const message = acceptanceMessage(request.kind);

  await acknowledge(tx, scope.conversationId, `accepted:${taskId}`, message);

  return { task: toTask(task), created: true, message };
}

export async function cancelTask(
  tx: Transaction,
  scope: Scope,
  taskId: string,
): Promise<{ cancelled: boolean; message: string }> {
  if (!z.uuid().safeParse(taskId).success)
    throw new TaskLifecycleError("invalid_input");

  await lockConversation(tx, scope);

  const [task] = await tx`SELECT status FROM tasks
    WHERE id = ${taskId} AND conversation_id = ${scope.conversationId}`;

  if (!task) throw new TaskLifecycleError("not_found");

  if (!["pending", "running"].includes(task.status)) {
    return {
      cancelled: false,
      message:
        task.status === "cancelled"
          ? "That request is already stopped. What would you like to do next?"
          : "That request has already finished. What would you like to do next?",
    };
  }

  await tx`UPDATE tasks SET status = 'cancelled', revision = revision + 1, updated_at = now()
    WHERE id = ${taskId} AND conversation_id = ${scope.conversationId}`;

  const message = "Okay, I’ve stopped that request.";

  await acknowledge(tx, scope.conversationId, `cancelled:${taskId}`, message);

  return { cancelled: true, message };
}

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    evidenceId: row.evidence_id,
    kind: row.kind,
    input: row.input,
    status: row.status,
    revision: row.revision,
  };
}
