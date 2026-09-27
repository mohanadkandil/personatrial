import { resolveMailbox, canUseTaskMailbox } from "../integrations/mailbox";
import { acceptTask, cancelTask, TaskLifecycleError } from "./task-lifecycle";
import { randomUUID } from "node:crypto";
import type { Database, Transaction } from "../database";
import type { TurnDecision } from "./decision";
import type { Profile, ConversationSnapshot } from "@/shared/conversation";
import { recoveryFallback, type RecoveryContext } from "./recovery-policy";
import {
  ConversationError,
  type Scope,
  type Channel,
  type EndReason,
  type Evidence,
  type Task,
  type TaskKind,
  type TaskStatus,
} from "./types";

type Conversation = {
  id: string;
  sequence: string;
  last_chat_sequence: string;
  profile: Profile;
};
type EvidenceRow = {
  id: string;
  source_event_id: string;
  received_sequence: string;
  channel: Channel;
  call_id: string | null;
  text: string;
  revision: number;
  final: boolean;
  sequence: string;
};

type TaskRow = {
  id: string;
  evidence_id: string;
  kind: TaskKind;
  input: { query: string };
  status: TaskStatus;
  revision: number;
};

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireId(value: string) {
  if (!uuid.test(value)) throw new ConversationError("invalid_input");
}

function requireText(value: string, limit = 8000) {
  if (typeof value !== "string" || !value.trim() || value.length > limit)
    throw new ConversationError("invalid_input");
}

async function nextSequence(
  tx: Transaction,
  conversationId: string,
): Promise<number> {
  const [row] =
    await tx`UPDATE conversations SET sequence = sequence + 1 WHERE id = ${conversationId} RETURNING sequence`;

  return Number(row.sequence);
}

async function addMessage(
  tx: Transaction,
  conversationId: string,
  source: string,
  role: "user" | "assistant",
  text: string,
  destination: { channel: Channel; callId?: string | null } = {
    channel: "chat",
  },
) {
  const [existing] =
    await tx`SELECT id FROM messages WHERE conversation_id = ${conversationId} AND source_key = ${source}`;

  if (existing) return String(existing.id);

  const id = randomUUID();

  const sequence = await nextSequence(tx, conversationId);

  await tx`INSERT INTO messages (id, conversation_id, sequence, source_key, role, text, channel, call_id)
    VALUES (${id}, ${conversationId}, ${sequence}, ${source}, ${role}, ${text}, ${destination.channel}, ${destination.callId ?? null})`;

  return id;
}

export class ConversationService {
  constructor(private readonly db: Database) {}

  private async transaction<T>(
    scope: Scope,
    work: (tx: Transaction, conversation: Conversation) => Promise<T>,
    readOnly = false,
  ): Promise<T> {
    requireId(scope.ownerId);
    requireId(scope.conversationId);

    const result = await this.db.begin(
      readOnly ? "isolation level repeatable read read only" : "",
      async (tx) => {
        const [conversation] = await tx<
          Conversation[]
        >`SELECT id, sequence, last_chat_sequence, profile FROM conversations
        WHERE id = ${scope.conversationId} AND owner_id = ${scope.ownerId} ${readOnly ? tx`` : tx`FOR UPDATE`}`;

        if (!conversation) throw new ConversationError("not_found");

        return work(tx, conversation);
      },
    );

    return result as T;
  }

  async create(ownerId: string): Promise<Scope> {
    requireId(ownerId);

    const conversationId = randomUUID();

    await this
      .db`INSERT INTO conversations (id, owner_id) VALUES (${conversationId}, ${ownerId})`;

    return { ownerId, conversationId };
  }

  async appendInput(
    scope: Scope,
    input: {
      sourceEventId: string;
      channel: Channel;
      callId?: string;
      text: string;
      revision: number;
      final: boolean;
    },
    options: { queueTurn?: boolean } = {},
  ): Promise<Evidence & { conversationSequence: number }> {
    requireText(input.sourceEventId, 200);
    requireText(input.text);

    if (
      !["chat", "voice"].includes(input.channel) ||
      !Number.isSafeInteger(input.revision) ||
      input.revision < 1 ||
      typeof input.final !== "boolean"
    )
      throw new ConversationError("invalid_input");

    if (input.channel === "chat" && (!input.final || input.callId))
      throw new ConversationError("invalid_input");

    return this.transaction(scope, async (tx, conversation) => {
      if (input.channel === "voice") {
        if (!input.callId) throw new ConversationError("invalid_input");
        requireId(input.callId);

        const [call] =
          await tx`SELECT id FROM calls WHERE id = ${input.callId} AND conversation_id = ${scope.conversationId}`;

        if (!call) throw new ConversationError("not_found");
      }

      const [existing] = await tx<
        EvidenceRow[]
      >`SELECT * FROM evidence WHERE conversation_id = ${scope.conversationId} AND source_event_id = ${input.sourceEventId}`;

      if (
        existing &&
        (existing.channel !== input.channel ||
          existing.call_id !== (input.callId ?? null))
      )
        throw new ConversationError("conflict");

      if (existing && (existing.final || existing.revision >= input.revision))
        return {
          ...toEvidence(existing),
          conversationSequence: Number(conversation.sequence),
        };

      const id = existing?.id ?? randomUUID();

      const sequence = await nextSequence(tx, scope.conversationId);

      const [row] = await tx<
        EvidenceRow[]
      >`INSERT INTO evidence (id, conversation_id, source_event_id, channel, call_id, text, revision, final, sequence, received_sequence)
        VALUES (${id}, ${scope.conversationId}, ${input.sourceEventId}, ${input.channel}, ${input.callId ?? null}, ${input.text}, ${input.revision}, ${input.final}, ${sequence}, ${sequence})
        ON CONFLICT (conversation_id, source_event_id) DO UPDATE SET text = EXCLUDED.text, revision = EXCLUDED.revision, final = EXCLUDED.final, sequence = EXCLUDED.sequence RETURNING *`;

      if (input.final)
        await addMessage(
          tx,
          scope.conversationId,
          `input:${id}`,
          "user",
          input.text,
          { channel: input.channel, callId: input.callId },
        );

      if (input.channel === "chat")
        await tx`UPDATE conversations SET last_chat_sequence = sequence WHERE id = ${scope.conversationId}`;

      if (input.final && options.queueTurn !== false) {
        await tx`INSERT INTO job_outbox (id, conversation_id, name, subject_id)
          VALUES (${randomUUID()}, ${scope.conversationId}, 'input.final', ${id})
          ON CONFLICT (name, subject_id) DO NOTHING`;
      }

      const [current] =
        await tx`SELECT sequence FROM conversations WHERE id = ${scope.conversationId}`;

      return {
        ...toEvidence(row),
        conversationSequence: Number(current.sequence),
      };
    });
  }

  async startCall(scope: Scope, callId: string): Promise<void> {
    requireId(callId);

    await this.transaction(scope, async (tx) => {
      const [call] =
        await tx`SELECT id, status FROM calls WHERE conversation_id = ${scope.conversationId} AND (id = ${callId} OR status = 'active')`;

      if (call) {
        if (call.id === callId && call.status === "active") return;
        throw new ConversationError("conflict");
      }

      await tx`INSERT INTO calls (id, conversation_id, status) VALUES (${callId}, ${scope.conversationId}, 'active')`;
    });
  }

  async saveVoiceResponse(
    scope: Scope,
    callId: string,
    item: { id: string; text: string },
  ): Promise<void> {
    requireId(callId);
    requireText(item.id, 150);
    requireText(item.text);

    await this.transaction(scope, async (tx) => {
      const [call] = await tx`SELECT id FROM calls
        WHERE id = ${callId} AND conversation_id = ${scope.conversationId}`;

      if (!call) throw new ConversationError("not_found");

      await addMessage(
        tx,
        scope.conversationId,
        `spoken:${callId}:${item.id}`,
        "assistant",
        item.text,
        { channel: "voice", callId },
      );
    });
  }

  async markCallReady(scope: Scope, callId: string): Promise<void> {
    requireId(callId);

    await this.transaction(scope, async (tx) => {
      const [call] = await tx`SELECT status FROM calls
        WHERE id = ${callId} AND conversation_id = ${scope.conversationId}`;

      if (!call) throw new ConversationError("not_found");
      if (call.status !== "active") throw new ConversationError("conflict");

      await tx`UPDATE calls SET ready_at = COALESCE(ready_at, now()) WHERE id = ${callId}`;
    });
  }

  async endCall(
    scope: Scope,
    callId: string,
    reason: EndReason,
  ): Promise<void> {
    requireId(callId);

    if (!["disconnect", "hangup", "goodbye", "cancel"].includes(reason))
      throw new ConversationError("invalid_input");

    await this.transaction(scope, async (tx) => {
      const [call] =
        await tx`SELECT status, end_reason, goodbye_requested FROM calls WHERE id = ${callId} AND conversation_id = ${scope.conversationId}`;

      if (!call) throw new ConversationError("not_found");

      if (call.goodbye_requested && ["hangup", "disconnect"].includes(reason))
        reason = "goodbye";

      if (call.status === "ended") {
        const upgradesReason =
          reason !== call.end_reason &&
          (reason === "goodbye" ||
            reason === "cancel" ||
            (reason === "hangup" && call.end_reason === "disconnect"));

        if (upgradesReason) {
          const changed = await tx`UPDATE calls SET end_reason = ${reason}
            WHERE id = ${callId} AND recovery_handled = false RETURNING id`;

          if (changed.length) await nextSequence(tx, scope.conversationId);
        }

        return;
      }

      const sequence = await nextSequence(tx, scope.conversationId);

      await tx`UPDATE calls SET status = 'ended', end_reason = ${reason}, ended_sequence = ${sequence}, ended_at = now() WHERE id = ${callId}`;

      if (reason === "disconnect" || reason === "hangup") {
        await tx`INSERT INTO job_outbox (id, conversation_id, name, subject_id, available_at)
          VALUES (${randomUUID()}, ${scope.conversationId}, 'call.recovery', ${callId}, now())
          ON CONFLICT (name, subject_id) DO NOTHING`;
      }
    });
  }

  private async readRecovery(
    tx: Transaction,
    scope: Scope,
    callId: string,
    conversation: Conversation,
  ): Promise<RecoveryContext | null> {
    const [call] =
      await tx`SELECT * FROM calls WHERE id = ${callId} AND conversation_id = ${scope.conversationId}`;

    if (!call) throw new ConversationError("not_found");

    if (call.status !== "ended" || call.recovery_handled) return null;

    const [active] =
      await tx`SELECT id FROM calls WHERE conversation_id = ${scope.conversationId} AND status = 'active'`;
    const [answer] = await tx`SELECT id FROM messages
      WHERE conversation_id = ${scope.conversationId} AND channel = 'chat'
        AND sequence > ${call.ended_sequence} AND role = 'assistant' LIMIT 1`;

    if (
      active ||
      answer ||
      Number(conversation.last_chat_sequence) > Number(call.ended_sequence) ||
      ["goodbye", "cancel"].includes(call.end_reason)
    )
      return null;

    const [task] =
      await tx`SELECT t.kind, t.status, t.input FROM tasks t JOIN evidence e ON e.id = t.evidence_id
      WHERE t.conversation_id = ${scope.conversationId} AND e.call_id = ${callId}
      ORDER BY (t.status IN ('pending', 'running')) DESC, t.created_at DESC LIMIT 1`;
    const [fragment] =
      await tx`SELECT final FROM evidence WHERE call_id = ${callId} ORDER BY sequence DESC LIMIT 1`;
    const dialogue = await tx<{ role: "user" | "assistant"; text: string }[]>`
      SELECT role, text FROM messages WHERE conversation_id = ${scope.conversationId} AND call_id = ${callId}
      ORDER BY sequence DESC LIMIT 12`;

    return {
      sequence: Number(conversation.sequence),
      callId,
      reason: call.end_reason,
      profile: conversation.profile,
      dialogue: dialogue.reverse(),
      lastInputPartial: Boolean(fragment && !fragment.final),
      task: task
        ? {
            kind: task.kind,
            status: task.status,
            query: String(task.input.query),
          }
        : null,
    };
  }

  async recoveryContext(
    scope: Scope,
    callId: string,
  ): Promise<RecoveryContext | null> {
    requireId(callId);

    return this.transaction(
      scope,
      (tx, conversation) => this.readRecovery(tx, scope, callId, conversation),
      true,
    );
  }

  async recoverCall(
    scope: Scope,
    callId: string,
    proposal?: { expectedSequence: number; message: string },
  ): Promise<string | null> {
    requireId(callId);

    if (proposal) requireText(proposal.message, 1000);

    return this.transaction(scope, async (tx, conversation) => {
      const context = await this.readRecovery(tx, scope, callId, conversation);

      if (
        context &&
        proposal &&
        context.sequence !== proposal.expectedSequence
      ) {
        throw new ConversationError("conflict");
      }

      await tx`UPDATE calls SET recovery_handled = true
        WHERE id = ${callId} AND conversation_id = ${scope.conversationId} AND status = 'ended'`;

      if (!context) return null;

      return addMessage(
        tx,
        scope.conversationId,
        `recovery:${callId}`,
        "assistant",
        proposal?.message ?? recoveryFallback(context),
      );
    });
  }

  async history(scope: Scope) {
    return this.transaction(
      scope,
      async (tx) => {
        const rows = await tx<
          {
            role: "user" | "assistant";
            text: string;
            channel: Channel;
            call_id: string | null;
          }[]
        >`
        SELECT role, text, channel, call_id FROM messages WHERE conversation_id = ${scope.conversationId}
        ORDER BY sequence DESC LIMIT 40`;

        return rows.reverse().map((row) => ({
          role: row.role,
          text: row.text,
          channel: row.channel,
          callId: row.call_id,
        }));
      },
      true,
    );
  }

  async acceptTask(
    scope: Scope,
    input: {
      evidenceId: string;
      expectedSequence: number;
      kind: TaskKind;
      query: string;
      idempotencyKey: string;
    },
  ): Promise<Task> {
    return this.transaction(scope, async (tx) => {
      try {
        return (await acceptTask(tx, scope, input)).task;
      } catch (error) {
        if (error instanceof TaskLifecycleError) {
          throw new ConversationError(
            error.code === "gmail_not_connected" || error.code === "task_limit"
              ? "conflict"
              : error.code,
          );
        }

        throw error;
      }
    });
  }

  async turnContext(scope: Scope, evidenceId: string) {
    requireId(evidenceId);

    return this.transaction(
      scope,
      async (tx, conversation) => {
        const [input] = await tx<
          EvidenceRow[]
        >`SELECT * FROM evidence WHERE id = ${evidenceId} AND conversation_id = ${scope.conversationId}`;

        if (!input || !input.final) throw new ConversationError("not_found");

        const [turn] =
          await tx`SELECT reply FROM turns WHERE evidence_id = ${evidenceId}`;
        const [newer] =
          await tx`SELECT id FROM evidence WHERE conversation_id = ${scope.conversationId}
          AND final = true AND received_sequence > ${input.received_sequence} LIMIT 1`;
        const messages =
          await tx`SELECT role, text, channel FROM messages WHERE conversation_id = ${scope.conversationId} ORDER BY sequence DESC LIMIT 40`;
        const tasks = await tx<
          TaskRow[]
        >`SELECT * FROM tasks WHERE conversation_id = ${scope.conversationId} AND status IN ('pending', 'running') ORDER BY created_at`;

        const gmail = await resolveMailbox(tx, scope);

        return {
          sequence: Number(conversation.sequence),
          profile: conversation.profile,
          input: toEvidence(input),
          handled: Boolean(turn),
          obsolete: Boolean(newer),
          reply: turn?.reply ? String(turn.reply) : null,
          gmailConnected: Boolean(gmail),
          gmailSource: gmail?.source ?? null,
          messages: messages.reverse().map((message) => ({
            role: String(message.role),
            text: String(message.text),
            channel: String(message.channel),
          })),
          tasks: tasks.map(toTask),
        };
      },
      true,
    );
  }

  async commitTurn(
    scope: Scope,
    input: {
      evidenceId: string;
      expectedSequence: number;
      decision: TurnDecision;
    },
  ): Promise<{ reply: string | null }> {
    requireId(input.evidenceId);
    requireText(input.decision.reply);

    return this.transaction(scope, async (tx, conversation) => {
      const [existing] =
        await tx`SELECT evidence_id FROM turns WHERE evidence_id = ${input.evidenceId} AND conversation_id = ${scope.conversationId}`;

      if (existing) return { reply: null };

      if (Number(conversation.sequence) !== input.expectedSequence)
        throw new ConversationError("conflict");

      const [evidence] = await tx<
        EvidenceRow[]
      >`SELECT * FROM evidence WHERE id = ${input.evidenceId} AND conversation_id = ${scope.conversationId}`;

      if (!evidence || !evidence.final)
        throw new ConversationError("not_found");

      const [newer] = await tx`SELECT id FROM evidence
        WHERE conversation_id = ${scope.conversationId} AND final = true
          AND received_sequence > ${evidence.received_sequence} LIMIT 1`;

      if (newer) {
        await tx`INSERT INTO turns (evidence_id, conversation_id, reply)
          VALUES (${input.evidenceId}, ${scope.conversationId}, NULL)`;

        return { reply: null };
      }

      const decision = input.decision;
      const profile = { ...conversation.profile };

      for (const key of ["agentName", "userName", "helpRequest"] as const) {
        const value = decision[key];

        if (value !== null) {
          requireText(value, key === "helpRequest" ? 1000 : 60);
          profile[key] = value;
        }
      }

      if (decision.callPreference)
        profile.callPreference = decision.callPreference;
      if (decision.gmailPreference)
        profile.gmailPreference = decision.gmailPreference;

      let reply = decision.reply;
      let taskAcknowledged = false;
      let sequenceAdvanced = false;

      if (
        decision.action === "search_gmail" ||
        decision.action === "search_sample"
      ) {
        try {
          const accepted = await acceptTask(tx, scope, {
            evidenceId: input.evidenceId,
            kind:
              decision.action === "search_gmail"
                ? "gmail.search"
                : "demo.search",
            query: decision.query ?? "",
            idempotencyKey: `turn:${input.evidenceId}`,
          });

          reply = accepted.message;
          taskAcknowledged = true;
          sequenceAdvanced = accepted.created;
        } catch (error) {
          if (!(error instanceof TaskLifecycleError)) throw error;

          if (error.code === "gmail_not_connected") {
            reply =
              "Connect Gmail first so I can search your messages. We can keep talking here meanwhile.";
          } else if (error.code === "task_limit") {
            reply =
              "I’m still working through your earlier requests. Let’s finish or cancel one before starting another.";
          } else {
            throw new ConversationError(error.code);
          }
        }
      }

      if (decision.action === "cancel_task") {
        try {
          const result = await cancelTask(
            tx,
            scope,
            decision.cancelTaskId ?? "",
          );

          reply = result.message;
          taskAcknowledged = result.cancelled;
          sequenceAdvanced = result.cancelled;
        } catch (error) {
          if (!(error instanceof TaskLifecycleError)) throw error;

          if (error.code === "not_found") {
            reply =
              "I couldn’t find that request. Which one would you like me to stop?";
          } else {
            throw new ConversationError("invalid_input");
          }
        }
      }

      await tx`UPDATE conversations SET profile = ${tx.json(profile)} WHERE id = ${scope.conversationId}`;
      if (taskAcknowledged && !sequenceAdvanced) {
        await nextSequence(tx, scope.conversationId);
      }

      if (!taskAcknowledged)
        await addMessage(
          tx,
          scope.conversationId,
          `turn:${input.evidenceId}`,
          "assistant",
          reply,
          { channel: evidence.channel, callId: evidence.call_id },
        );
      await tx`INSERT INTO turns (evidence_id, conversation_id, reply) VALUES (${input.evidenceId}, ${scope.conversationId}, ${reply})`;

      return { reply };
    });
  }

  async failTurn(scope: Scope, evidenceId: string): Promise<void> {
    requireId(evidenceId);

    await this.transaction(scope, async (tx) => {
      const [evidence] = await tx<
        EvidenceRow[]
      >`SELECT * FROM evidence WHERE id = ${evidenceId} AND conversation_id = ${scope.conversationId}`;

      if (!evidence || !evidence.final)
        throw new ConversationError("not_found");

      const [turn] =
        await tx`SELECT evidence_id FROM turns WHERE evidence_id = ${evidenceId}`;

      if (turn) return;

      const [newer] =
        await tx`SELECT id FROM evidence WHERE conversation_id = ${scope.conversationId}
        AND final = true AND received_sequence > ${evidence.received_sequence} LIMIT 1`;
      const reply = newer
        ? null
        : "I couldn’t finish responding, but your message is saved. Please try again in a moment.";

      if (reply)
        await addMessage(
          tx,
          scope.conversationId,
          `turn:${evidenceId}`,
          "assistant",
          reply,
        );

      await tx`INSERT INTO turns (evidence_id, conversation_id, reply) VALUES (${evidenceId}, ${scope.conversationId}, ${reply})`;
    });
  }

  async getTask(scope: Scope, taskId: string): Promise<Task> {
    requireId(taskId);

    return this.transaction(
      scope,
      async (tx) => {
        const [row] = await tx<
          TaskRow[]
        >`SELECT * FROM tasks WHERE id = ${taskId} AND conversation_id = ${scope.conversationId}`;

        if (!row) throw new ConversationError("not_found");

        return toTask(row);
      },
      true,
    );
  }

  async finishTask(
    scope: Scope,
    input: {
      taskId: string;
      revision: number;
      outcome: "completed" | "failed";
      answer: string;
    },
  ): Promise<boolean> {
    requireId(input.taskId);
    requireText(input.answer, 16000);

    if (!["completed", "failed"].includes(input.outcome))
      throw new ConversationError("invalid_input");

    return this.transaction(scope, async (tx) => {
      const [task] =
        await tx`SELECT status, revision, kind FROM tasks WHERE id = ${input.taskId} AND conversation_id = ${scope.conversationId}`;

      if (!task) throw new ConversationError("not_found");

      if (
        task.revision !== input.revision ||
        !["pending", "running"].includes(task.status)
      )
        return false;

      if (
        task.kind === "gmail.search" &&
        input.outcome === "completed" &&
        !(await canUseTaskMailbox(tx, scope, input.taskId))
      ) {
        input = {
          ...input,
          outcome: "failed",
          answer:
            "The connected inbox changed, so I stopped that search. Ask me again to search the current inbox.",
        };
      }

      await tx`UPDATE tasks SET status = ${input.outcome}, result = ${tx.json({ answer: input.answer })}, updated_at = now() WHERE id = ${input.taskId}`;

      await addMessage(
        tx,
        scope.conversationId,
        `result:${input.taskId}`,
        "assistant",
        input.answer,
      );

      return true;
    });
  }

  async cancelTask(scope: Scope, taskId: string): Promise<boolean> {
    requireId(taskId);

    return this.transaction(scope, async (tx) => {
      try {
        return (await cancelTask(tx, scope, taskId)).cancelled;
      } catch (error) {
        if (error instanceof TaskLifecycleError) {
          throw new ConversationError(
            error.code === "not_found" ? "not_found" : "invalid_input",
          );
        }

        throw error;
      }
    });
  }

  async acknowledgeRendered(scope: Scope, messageIds: string[]): Promise<void> {
    if (messageIds.length > 100) throw new ConversationError("invalid_input");
    messageIds.forEach(requireId);

    if (!messageIds.length) return;

    await this.transaction(scope, async (tx) => {
      await tx`UPDATE messages SET rendered_at = COALESCE(rendered_at, now()) WHERE conversation_id = ${scope.conversationId} AND channel = 'chat' AND id IN ${tx(messageIds)}`;
    });
  }

  async snapshot(
    scope: Scope,
    after = 0,
  ): Promise<ConversationSnapshot & { evidence: Evidence[] }> {
    if (!Number.isSafeInteger(after) || after < 0)
      throw new ConversationError("invalid_input");

    return this.transaction(
      scope,
      async (tx, conversation) => {
        const messages =
          await tx`SELECT m.*, CASE WHEN e.source_event_id LIKE 'chat:%'
          THEN substring(e.source_event_id FROM 6) ELSE NULL END AS client_event_id
          FROM messages m LEFT JOIN evidence e
            ON e.conversation_id = m.conversation_id AND m.source_key = 'input:' || e.id::text
          WHERE m.conversation_id = ${scope.conversationId} AND m.channel = 'chat'
            AND m.sequence > ${after} ORDER BY m.sequence LIMIT 101`;

        const evidence = await tx<
          EvidenceRow[]
        >`SELECT * FROM evidence WHERE conversation_id = ${scope.conversationId} ORDER BY sequence DESC LIMIT 100`;

        const tasks = await tx<
          TaskRow[]
        >`SELECT * FROM tasks WHERE conversation_id = ${scope.conversationId} ORDER BY (status IN ('pending', 'running')) DESC, created_at DESC LIMIT 50`;

        const gmail = await resolveMailbox(tx, scope);

        const page = messages.slice(0, 100);

        return {
          sequence: Number(conversation.sequence),
          profile: conversation.profile,
          gmailConnected: Boolean(gmail),
          gmailSource: gmail?.source ?? null,
          cursor:
            messages.length > 100
              ? Number(page[page.length - 1].sequence)
              : Number(conversation.sequence),
          hasMore: messages.length > 100,
          messages: page.map((row) => ({
            id: row.id,
            sequence: Number(row.sequence),
            role: row.role,
            text: row.text,
            renderedAt: row.rendered_at?.toISOString() ?? null,
            clientEventId: row.client_event_id ?? null,
          })),
          evidence: evidence.map(toEvidence),
          tasks: tasks.map(toTask),
        };
      },
      true,
    );
  }
}

function toEvidence(row: EvidenceRow): Evidence {
  return {
    id: row.id,
    sourceEventId: row.source_event_id,
    channel: row.channel,
    callId: row.call_id,
    text: row.text,
    revision: row.revision,
    final: row.final,
    sequence: Number(row.sequence),
  };
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
