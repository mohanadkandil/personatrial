import { llm } from "@livekit/agents";
import { z } from "zod";
import type { VoiceAction } from "../server/conversation/voice-tools";

export function createVoiceTools(
  execute: (
    action: VoiceAction,
    toolCallId: string,
    signal: AbortSignal,
  ) => Promise<unknown>,
  context: () => Promise<unknown>,
) {
  return {
    saveProfile: llm.tool({
      description:
        "Save the preferred user name, help request, or Gmail preference explicitly supplied in the current spoken turn. Agent naming happens in chat.",
      parameters: z.object({
        userName: z.string().max(60).nullable(),
        helpRequest: z.string().max(1000).nullable(),
        gmailPreference: z.enum(["offered", "declined"]).nullable(),
      }),
      execute: async (args, options) =>
        execute(
          {
            action: "save_profile",
            ...(args.userName ? { userName: args.userName } : {}),
            ...(args.helpRequest ? { helpRequest: args.helpRequest } : {}),
            ...(args.gmailPreference
              ? { gmailPreference: args.gmailPreference }
              : {}),
          },
          options.toolCallId,
          options.abortSignal,
        ),
    }),
    searchGmail: llm.tool({
      description:
        "Accept an explicitly requested, read-only Gmail search. Returns an accepted task ID; results arrive in chat even after hangup. Requires a verified Gmail connection. Never claim acceptance before this succeeds.",
      parameters: z.object({ query: z.string().min(1).max(500) }),
      execute: async (args, options) =>
        execute(
          { action: "search_gmail", query: args.query },
          options.toolCallId,
          options.abortSignal,
        ),
    }),
    searchSampleInbox: llm.tool({
      description:
        "Search fictional sample inbox data only when the user explicitly requests sample/demo data. This never accesses Gmail.",
      parameters: z.object({ query: z.string().min(1).max(500) }),
      execute: async (args, options) =>
        execute(
          { action: "search_sample", query: args.query },
          options.toolCallId,
          options.abortSignal,
        ),
    }),
    cancelTask: llm.tool({
      description:
        "Cancel the specific task requested by the user. Get current task IDs from getContext; ask if ambiguous.",
      parameters: z.object({ taskId: z.string().uuid() }),
      execute: async (args, options) =>
        execute(
          { action: "cancel_task", taskId: args.taskId },
          options.toolCallId,
          options.abortSignal,
        ),
    }),
    goodbye: llm.tool({
      description:
        "Record an explicit farewell so hanging up does not trigger a needless follow-up. Never infer goodbye from silence or interruption.",
      execute: async (_args, options) =>
        execute({ action: "goodbye" }, options.toolCallId, options.abortSignal),
    }),
    getContext: llm.tool({
      description:
        "Read current saved profile, Gmail connection status, tasks and recent results. Use for progress questions or when something has changed. Reading context does not start a task.",
      execute: async () => context(),
    }),
  };
}
