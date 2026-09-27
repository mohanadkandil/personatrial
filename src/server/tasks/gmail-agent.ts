import "server-only";
import { z } from "zod";
import { decodeHTML } from "entities";
import type { GmailMessage } from "../integrations/nango-gmail";

export const gmailDecisionSchema = z
  .object({
    action: z.enum(["finish", "refine"]),
    query: z.string().max(500).nullable(),
    messageIds: z.array(z.string().max(256)).max(5),
  })
  .strict();

export type GmailDecision = z.infer<typeof gmailDecisionSchema>;

export interface GmailObservation {
  request: string;
  queries: string[];
  messages: GmailMessage[];
  searchesRemaining: number;
}

export const gmailAnswerSchema = z
  .object({
    answer: z.string().trim().min(1).max(3500),
    messageIds: z.array(z.string().min(1).max(256)).min(1).max(5),
  })
  .strict();

export interface GmailAnswerInput {
  request: string;
  messages: GmailMessage[];
}

export interface GmailAgentDependencies {
  search(query: string, signal: AbortSignal): Promise<GmailMessage[]>;
  decide(observation: GmailObservation, signal: AbortSignal): Promise<unknown>;
  compose(input: GmailAnswerInput, signal: AbortSignal): Promise<unknown>;
  isCurrent(): Promise<boolean>;
}

export type GmailAgentResult =
  { status: "cancelled" } | { status: "completed" | "failed"; answer: string };

export interface GmailAgentOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  modelTimeoutMs?: number;
}

class TaskDeadline extends Error {
  constructor() {
    super("gmail_task_deadline");
  }
}

const NO_MATCH =
  "I couldn’t find a matching email in those searches. Do you remember the sender, a phrase, or roughly when it arrived?";

function renderEmails(messages: GmailMessage[], verified: boolean): string {
  const heading = verified
    ? "Here’s the relevant email information:"
    : "I retrieved these emails, but couldn’t finish checking which best matches your request:";
  const threads = new Map<string, GmailMessage>();

  for (const message of messages) {
    const key = message.threadId || message.id;

    if (!threads.has(key)) threads.set(key, message);
  }

  const excerpts = [...threads.values()].slice(0, 5).map((message) => {
    const subject = decodeHTML(message.subject || "An email without a subject");
    const sender = message.from ? ` — ${decodeHTML(message.from)}` : "";
    const snippet = message.snippet ? `\n“${decodeHTML(message.snippet)}”` : "";

    return `${subject}${sender}${snippet}`;
  });

  return `${heading}\n\n${excerpts.join("\n\n")}`;
}

function incomplete(messages: GmailMessage[]): GmailAgentResult {
  return {
    status: "failed",
    answer: messages.length
      ? renderEmails(messages, false)
      : "I couldn’t finish checking your Gmail. Your request is saved; you can ask me to try again.",
  };
}

export async function runGmailAgent(
  input: { request: string; initialQuery: string },
  dependencies: GmailAgentDependencies,
  options: GmailAgentOptions = {},
): Promise<GmailAgentResult> {
  const timeoutMs = options.timeoutMs ?? 45_000;
  const modelTimeoutMs = options.modelTimeoutMs ?? 12_000;

  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 60_000 ||
    !Number.isFinite(modelTimeoutMs) ||
    modelTimeoutMs <= 0 ||
    !input.request.trim() ||
    input.request.length > 8000 ||
    !input.initialQuery.trim() ||
    input.initialQuery.length > 500
  ) {
    throw new Error("invalid_gmail_task_input");
  }

  const deadline = Date.now() + timeoutMs;
  const controller = new AbortController();
  const cancel = () => controller.abort();

  options.signal?.addEventListener("abort", cancel, { once: true });

  if (options.signal?.aborted) controller.abort();

  const queries: string[] = [];
  const evidence = new Map<string, GmailMessage>();

  async function bounded<T>(
    work: (signal: AbortSignal) => Promise<T>,
    maximumMs = timeoutMs,
  ): Promise<T> {
    const remaining = Math.min(maximumMs, deadline - Date.now());

    if (controller.signal.aborted || remaining <= 0) throw new TaskDeadline();

    const operation = new AbortController();
    const abortOperation = () => operation.abort();
    controller.signal.addEventListener("abort", abortOperation, { once: true });

    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortWait: (() => void) | undefined;

    try {
      return await Promise.race([
        Promise.resolve().then(() => work(operation.signal)),
        new Promise<never>((_resolve, reject) => {
          abortWait = () => reject(new TaskDeadline());
          operation.signal.addEventListener("abort", abortWait, { once: true });
          timer = setTimeout(() => operation.abort(), remaining);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", abortOperation);
      if (abortWait) operation.signal.removeEventListener("abort", abortWait);
      operation.abort();
    }
  }

  async function current(): Promise<boolean> {
    return (
      !controller.signal.aborted &&
      (await bounded(() => dependencies.isCurrent()))
    );
  }

  try {
    let query = input.initialQuery.trim();

    for (let searchIndex = 0; searchIndex < 2; searchIndex += 1) {
      if (!(await current())) return { status: "cancelled" };

      queries.push(query);

      const messages = await bounded((signal) =>
        dependencies.search(query, signal),
      );

      for (const message of messages.slice(0, 5)) {
        evidence.set(message.id, message);
      }

      if (!(await current())) return { status: "cancelled" };

      let decision: GmailDecision;

      try {
        decision = gmailDecisionSchema.parse(
          await bounded(
            (signal) =>
              dependencies.decide(
                {
                  request: input.request,
                  queries: [...queries],
                  messages: [...evidence.values()],
                  searchesRemaining: 1 - searchIndex,
                },
                signal,
              ),
            modelTimeoutMs,
          ),
        );
      } catch {
        if (controller.signal.aborted || !(await current()))
          return { status: "cancelled" };
        return incomplete([...evidence.values()]);
      }

      if (!(await current())) return { status: "cancelled" };

      if (decision.action === "finish") {
        const ids = [...new Set(decision.messageIds)];

        if (ids.some((id) => !evidence.has(id))) {
          return incomplete([...evidence.values()]);
        }

        if (!ids.length) return { status: "completed", answer: NO_MATCH };

        const selected = ids.map((id) => {
          const message = evidence.get(id)!;

          return {
            ...message,
            subject: decodeHTML(message.subject),
            from: decodeHTML(message.from),
            snippet: decodeHTML(message.snippet),
          };
        });
        let answer = renderEmails(
          ids.map((id) => evidence.get(id)!),
          true,
        );

        try {
          const composed = gmailAnswerSchema.parse(
            await bounded(
              (signal) =>
                dependencies.compose(
                  { request: input.request, messages: selected },
                  signal,
                ),
              modelTimeoutMs,
            ),
          );

          if (composed.messageIds.some((id) => !ids.includes(id))) {
            throw new Error("gmail_answer_unknown_evidence");
          }

          answer = composed.answer;
        } catch {
          if (controller.signal.aborted) return { status: "cancelled" };
        }

        if (!(await current())) return { status: "cancelled" };

        return { status: "completed", answer };
      }

      const nextQuery = decision.query?.trim();

      if (
        searchIndex === 1 ||
        !nextQuery ||
        queries.includes(nextQuery) ||
        /[\u0000-\u001f\u007f]/.test(nextQuery)
      ) {
        return incomplete([...evidence.values()]);
      }

      query = nextQuery;
    }

    return incomplete([...evidence.values()]);
  } catch (error) {
    if (controller.signal.aborted) return { status: "cancelled" };
    if (error instanceof TaskDeadline)
      return incomplete([...evidence.values()]);

    throw error;
  } finally {
    options.signal?.removeEventListener("abort", cancel);
    controller.abort();
  }
}
