import { acceptTask, cancelTask, TaskLifecycleError } from "./task-lifecycle";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Database, Transaction } from "../database";
import type { Profile } from "@/shared/conversation";
import type { Scope } from "./types";

const id = z.uuid();
const token = z.string().min(1).max(200);
const generation = z.number().int().positive().max(2_147_483_647);
const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const actionSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("save_profile"),
      userName: z.string().trim().min(1).max(60).optional(),
      helpRequest: z.string().trim().min(1).max(1000).optional(),
      gmailPreference: z.enum(["offered", "declined"]).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("search_gmail"),
      query: z.string().trim().min(1).max(500),
    })
    .strict(),
  z
    .object({
      action: z.literal("search_sample"),
      query: z.string().trim().min(1).max(500),
    })
    .strict(),
  z.object({ action: z.literal("cancel_task"), taskId: id }).strict(),
  z.object({ action: z.literal("goodbye") }).strict(),
]);

export type VoiceAction = z.infer<typeof actionSchema>;
export type VoiceInput = {
  inputToken: string;
  generation: number;
  expectedChatSequence: number;
};
export type VoiceToolRequest = {
  toolCallId: string;
  inputToken: string;
  generation: number;
  evidenceId: string;
  action: VoiceAction;
};
export type VoiceToolResult =
  | { action: "save_profile"; saved: Partial<Profile> }
  | {
      action: "search_gmail" | "search_sample";
      taskId: string;
      status: "pending" | "running" | "completed" | "failed" | "cancelled";
      resultChannel: "chat";
    }
  | { action: "cancel_task"; taskId: string; cancelled: boolean }
  | { action: "goodbye"; goodbyeRequested: true };

export class VoiceToolError extends Error {
  constructor(
    public readonly code:
      | "invalid_input"
      | "not_found"
      | "stale_input"
      | "conflict"
      | "gmail_not_connected"
      | "task_limit",
  ) {
    super(code);
    this.name = "VoiceToolError";
  }
}

type ConversationRow = {
  id: string;
  sequence: string;
  last_chat_sequence: string;
  profile: Profile;
};

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);

  if (!result.success) throw new VoiceToolError("invalid_input");

  return result.data;
}

async function advance(
  tx: Transaction,
  conversationId: string,
): Promise<number> {
  const [row] = await tx`UPDATE conversations SET sequence = sequence + 1
    WHERE id = ${conversationId} RETURNING sequence`;

  return Number(row.sequence);
}

export class VoiceToolService {
  constructor(private readonly db: Database) {}

  private async transaction<T>(
    scope: Scope,
    callId: string,
    work: (tx: Transaction, conversation: ConversationRow) => Promise<T>,
  ): Promise<T> {
    parse(id, scope.ownerId);
    parse(id, scope.conversationId);
    parse(id, callId);

    const result = await this.db.begin(async (tx) => {
      const [conversation] = await tx<
        ConversationRow[]
      >`SELECT id, sequence, last_chat_sequence, profile
        FROM conversations WHERE id = ${scope.conversationId} AND owner_id = ${scope.ownerId} FOR UPDATE`;

      if (!conversation) throw new VoiceToolError("not_found");

      const [call] =
        await tx`SELECT id FROM calls WHERE id = ${callId} AND conversation_id = ${scope.conversationId}`;

      if (!call) throw new VoiceToolError("not_found");

      return work(tx, conversation);
    });

    return result as T;
  }

  async beginInput(
    scope: Scope,
    callId: string,
    input: VoiceInput,
  ): Promise<void> {
    const checked = parse(
      z
        .object({
          inputToken: token,
          generation,
          expectedChatSequence: sequence,
        })
        .strict(),
      input,
    );

    await this.transaction(scope, callId, async (tx, conversation) => {
      const [call] =
        await tx`SELECT status, native_input_token, native_input_generation FROM calls WHERE id = ${callId}`;

      if (
        call.status !== "active" ||
        Number(conversation.last_chat_sequence) !== checked.expectedChatSequence
      ) {
        throw new VoiceToolError("stale_input");
      }

      if (
        call.native_input_generation === checked.generation &&
        call.native_input_token === checked.inputToken
      )
        return;

      if (call.native_input_generation >= checked.generation)
        throw new VoiceToolError("stale_input");

      const barrier = await advance(tx, scope.conversationId);

      await tx`UPDATE calls SET native_input_token = ${checked.inputToken}, native_input_generation = ${checked.generation},
        native_input_sequence = ${barrier}, native_input_chat_sequence = ${checked.expectedChatSequence}, goodbye_requested = false
        WHERE id = ${callId}`;
    });
  }

  async execute(
    scope: Scope,
    callId: string,
    input: VoiceToolRequest,
  ): Promise<VoiceToolResult> {
    const checked = parse(
      z
        .object({
          toolCallId: token,
          inputToken: token,
          generation,
          evidenceId: id,
          action: actionSchema,
        })
        .strict(),
      input,
    );
    const requestHash = createHash("sha256")
      .update(JSON.stringify(checked))
      .digest("hex");

    return this.transaction(scope, callId, async (tx, conversation) => {
      const [existing] =
        await tx`SELECT request_hash, result FROM voice_tool_calls
        WHERE call_id = ${callId} AND tool_call_id = ${checked.toolCallId}`;

      if (existing) {
        if (existing.request_hash !== requestHash)
          throw new VoiceToolError("conflict");

        return existing.result as VoiceToolResult;
      }

      const [call] = await tx`SELECT * FROM calls WHERE id = ${callId}`;

      if (
        call.status !== "active" ||
        call.native_input_token !== checked.inputToken ||
        call.native_input_generation !== checked.generation ||
        Number(call.native_input_chat_sequence) !==
          Number(conversation.last_chat_sequence)
      ) {
        throw new VoiceToolError("stale_input");
      }

      const [evidence] =
        await tx`SELECT final, channel, call_id, received_sequence, source_event_id FROM evidence
        WHERE id = ${checked.evidenceId} AND conversation_id = ${scope.conversationId}`;

      if (
        !evidence ||
        evidence.channel !== "voice" ||
        evidence.call_id !== callId
      ) {
        throw new VoiceToolError("not_found");
      }

      if (
        !evidence.final ||
        Number(evidence.received_sequence) <=
          Number(call.native_input_sequence) ||
        !String(evidence.source_event_id).startsWith(
          `voice:${callId}:${checked.inputToken}:`,
        )
      ) {
        throw new VoiceToolError("stale_input");
      }

      const action = checked.action;
      let result: VoiceToolResult;
      let sequenceAdvanced = false;

      if (action.action === "save_profile") {
        const saved: Partial<Profile> = {};

        if (action.userName !== undefined) saved.userName = action.userName;
        if (action.helpRequest !== undefined)
          saved.helpRequest = action.helpRequest;
        if (action.gmailPreference !== undefined)
          saved.gmailPreference = action.gmailPreference;

        if (!Object.keys(saved).length)
          throw new VoiceToolError("invalid_input");

        await tx`UPDATE conversations SET profile = ${tx.json({ ...conversation.profile, ...saved })}
          WHERE id = ${scope.conversationId}`;

        result = { action: "save_profile", saved };
      } else if (
        action.action === "search_gmail" ||
        action.action === "search_sample"
      ) {
        try {
          const accepted = await acceptTask(tx, scope, {
            evidenceId: checked.evidenceId,
            kind:
              action.action === "search_gmail" ? "gmail.search" : "demo.search",
            query: action.query,
            idempotencyKey: `voice:${callId}:${createHash("sha256").update(checked.toolCallId).digest("hex")}`,
          });

          sequenceAdvanced = accepted.created;
          result = {
            action: action.action,
            taskId: accepted.task.id,
            status: accepted.task.status,
            resultChannel: "chat",
          };
        } catch (error) {
          if (error instanceof TaskLifecycleError)
            throw new VoiceToolError(error.code);

          throw error;
        }
      } else if (action.action === "cancel_task") {
        try {
          const cancellation = await cancelTask(tx, scope, action.taskId);

          sequenceAdvanced = cancellation.cancelled;
          result = {
            action: "cancel_task",
            taskId: action.taskId,
            cancelled: cancellation.cancelled,
          };
        } catch (error) {
          if (error instanceof TaskLifecycleError)
            throw new VoiceToolError(error.code);

          throw error;
        }
      } else {
        await tx`UPDATE calls SET goodbye_requested = true WHERE id = ${callId}`;

        result = { action: "goodbye", goodbyeRequested: true };
      }

      if (!sequenceAdvanced) await advance(tx, scope.conversationId);

      await tx`INSERT INTO voice_tool_calls (call_id, tool_call_id, request_hash, result)
        VALUES (${callId}, ${checked.toolCallId}, ${requestHash}, ${tx.json(result)})`;

      return result;
    });
  }
}
