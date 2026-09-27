import "server-only";
import { generateStructured } from "../ai/structured";
import {
  gmailTaskInstructions,
  gmailAnswerInstructions,
} from "../../prompts/gmail";
import {
  gmailAnswerSchema,
  gmailDecisionSchema,
  type GmailAnswerInput,
  type GmailObservation,
} from "./gmail-agent";

export async function decideGmailTask(
  observation: GmailObservation,
  signal: AbortSignal,
): Promise<unknown> {
  return generateStructured({
    name: "gmail_task_decision",
    schema: gmailDecisionSchema,
    instructions: gmailTaskInstructions,
    input: observation,
    maxOutputTokens: 500,
    timeoutMs: 12_000,
    signal,
  });
}

export async function composeGmailAnswer(
  input: GmailAnswerInput,
  signal: AbortSignal,
): Promise<unknown> {
  return generateStructured({
    name: "gmail_answer",
    schema: gmailAnswerSchema,
    instructions: gmailAnswerInstructions,
    input,
    maxOutputTokens: 1100,
    timeoutMs: 12_000,
    signal,
  });
}
