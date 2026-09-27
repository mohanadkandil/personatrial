import "server-only";
import { generateStructured } from "../ai/structured";
import { recoveryInstructions } from "../../prompts/recovery";
import { z } from "zod";
import { getDatabase } from "../database";
import { ConversationService } from "./service";
import { ConversationError, type Scope } from "./types";
import { recoveryFallback, type RecoveryContext } from "./recovery-policy";

const recoverySchema = z.object({ message: z.string() });

async function composeRecovery(context: RecoveryContext): Promise<string> {
  const response = await generateStructured({
    name: "call_follow_up",
    schema: recoverySchema,
    instructions: recoveryInstructions,
    input: context,
    maxOutputTokens: 300,
    timeoutMs: 10_000,
  });
  const message = response.message.trim();

  if (!message || message.length > 1000)
    throw new Error("invalid_recovery_message");

  return message;
}

export function createCallRecovery(
  service: ConversationService,
  compose: (context: RecoveryContext) => Promise<string> = composeRecovery,
) {
  return async (scope: Scope, callId: string): Promise<string | null> => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const context = await service.recoveryContext(scope, callId);

      if (!context) return service.recoverCall(scope, callId);

      let message: string;

      try {
        message = (await compose(context)).trim();

        if (!message || message.length > 1000)
          message = recoveryFallback(context);
      } catch {
        message = recoveryFallback(context);
      }

      try {
        return await service.recoverCall(scope, callId, {
          expectedSequence: context.sequence,
          message,
        });
      } catch (error) {
        if (!(error instanceof ConversationError) || error.code !== "conflict")
          throw error;
      }
    }

    return service.recoverCall(scope, callId);
  };
}

export async function recoverCall(scope: Scope, callId: string) {
  return createCallRecovery(new ConversationService(getDatabase()))(
    scope,
    callId,
  );
}
