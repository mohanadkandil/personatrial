import { z } from "zod";

export const turnDecisionSchema = z.object({
  reply: z.string(),
  agentName: z.string().nullable(),
  userName: z.string().nullable(),
  helpRequest: z.string().nullable(),
  callPreference: z.enum(["offered", "declined"]).nullable(),
  gmailPreference: z.enum(["offered", "declined"]).nullable(),
  action: z.enum(["reply", "search_gmail", "search_sample", "cancel_task"]),
  query: z.string().nullable(),
  cancelTaskId: z.string().nullable(),
});

export type TurnDecision = z.infer<typeof turnDecisionSchema>;
