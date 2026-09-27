import "server-only";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";

export type StructuredRequest<Schema extends z.ZodType> = {
  name: string;
  schema: Schema;
  instructions: string;
  input: unknown;
  maxOutputTokens: number;
  timeoutMs: number;
  signal?: AbortSignal;
};

export class ModelRequestError extends Error {
  constructor(
    public readonly code:
      | "config"
      | "invalid_input"
      | "cancelled"
      | "timeout"
      | "invalid_output"
      | "unavailable",
  ) {
    super(`model_${code}`);
    this.name = "ModelRequestError";
  }
}

export function createStructuredModel(options: {
  model: string;
  apiKey?: string;
  fetch?: typeof fetch;
}) {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;

  if (!options.model.trim() || !apiKey?.trim()) {
    throw new ModelRequestError("config");
  }

  const client = new OpenAI({ apiKey, fetch: options.fetch, maxRetries: 0 });

  return async function generate<Schema extends z.ZodType>(
    request: StructuredRequest<Schema>,
  ): Promise<z.output<Schema>> {
    if (request.signal?.aborted) throw new ModelRequestError("cancelled");

    if (
      !Number.isInteger(request.timeoutMs) ||
      request.timeoutMs <= 0 ||
      !Number.isInteger(request.maxOutputTokens) ||
      request.maxOutputTokens <= 0 ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(request.name) ||
      !request.instructions.trim()
    )
      throw new ModelRequestError("invalid_input");

    let input: string;
    let format: ReturnType<typeof zodTextFormat<Schema>>;

    try {
      const serialized = JSON.stringify(request.input);

      if (serialized === undefined) throw new Error("empty_input");

      input = serialized;
      format = zodTextFormat(request.schema, request.name);
    } catch {
      throw new ModelRequestError("invalid_input");
    }

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel: (() => void) | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      const stop = (code: "cancelled" | "timeout") => {
        reject(new ModelRequestError(code));
        controller.abort();
      };

      cancel = () => stop("cancelled");
      request.signal?.addEventListener("abort", cancel, { once: true });
      timer = setTimeout(() => stop("timeout"), request.timeoutMs);
    });

    try {
      const response = await Promise.race([
        client.responses.parse(
          {
            model: options.model,
            store: false,
            max_output_tokens: request.maxOutputTokens,
            instructions: request.instructions,
            input,
            text: { format },
          },
          { signal: controller.signal, timeout: request.timeoutMs },
        ),
        interrupted,
      ]);

      if (response.status !== "completed" || response.output_parsed == null) {
        throw new ModelRequestError("invalid_output");
      }

      return request.schema.parse(response.output_parsed);
    } catch (error) {
      if (
        request.signal?.aborted ||
        error instanceof OpenAI.APIUserAbortError
      ) {
        throw new ModelRequestError("cancelled");
      }
      if (error instanceof OpenAI.APIConnectionTimeoutError) {
        throw new ModelRequestError("timeout");
      }
      if (error instanceof ModelRequestError) throw error;
      if (
        error instanceof z.ZodError ||
        error instanceof SyntaxError ||
        error instanceof TypeError
      ) {
        throw new ModelRequestError("invalid_output");
      }

      throw new ModelRequestError("unavailable");
    } finally {
      clearTimeout(timer);
      if (cancel) request.signal?.removeEventListener("abort", cancel);
    }
  };
}

let configured:
  | {
      model: string;
      apiKey: string;
      generate: ReturnType<typeof createStructuredModel>;
    }
  | undefined;

export function generateStructured<Schema extends z.ZodType>(
  request: StructuredRequest<Schema>,
): Promise<z.output<Schema>> {
  const model = process.env.OPENAI_TEXT_MODEL ?? "";
  const apiKey = process.env.OPENAI_API_KEY ?? "";

  if (configured?.model !== model || configured?.apiKey !== apiKey) {
    configured = {
      model,
      apiKey,
      generate: createStructuredModel({ model, apiKey }),
    };
  }

  return configured.generate(request);
}
