import "server-only";
import { generateStructured } from "../ai/structured";
import { conversationInstructions } from "../../prompts/conversation";
import { getDatabase } from "../database";
import { turnDecisionSchema, type TurnDecision } from "./decision";
import { ConversationService } from "./service";
import { ConversationError, type Scope } from "./types";

type Context = Awaited<ReturnType<ConversationService["turnContext"]>>;
type Decide = (context: Context) => Promise<TurnDecision>;

async function decide(context: Context): Promise<TurnDecision> {
  return generateStructured({
    name: "conversation_decision",
    schema: turnDecisionSchema,
    instructions: conversationInstructions,
    input: context,
    maxOutputTokens: 1200,
    timeoutMs: 30_000,
  });
}

export function createConversationEngine(
  service: ConversationService,
  decideTurn: Decide = decide,
) {
  return async (
    scope: Scope,
    evidenceId: string,
  ): Promise<{ reply: string | null }> => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const context = await service.turnContext(scope, evidenceId);

      if (context.handled) return { reply: null };

      const decision = turnDecisionSchema.parse(await decideTurn(context));

      try {
        return await service.commitTurn(scope, {
          evidenceId,
          expectedSequence: context.sequence,
          decision,
        });
      } catch (error) {
        if (!(error instanceof ConversationError) || error.code !== "conflict")
          throw error;
      }
    }

    throw new ConversationError("conflict");
  };
}

export async function runTurn(
  scope: Scope,
  evidenceId: string,
  options: { replay?: boolean } = {},
) {
  const service = new ConversationService(getDatabase());
  const result = await createConversationEngine(service)(scope, evidenceId);

  if (options.replay) {
    const context = await service.turnContext(scope, evidenceId);
    return { reply: context.obsolete ? null : (result.reply ?? context.reply) };
  }

  return result;
}
