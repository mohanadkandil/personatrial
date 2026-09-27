import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
  createStructuredModel,
  ModelRequestError,
} from "../../src/server/ai/structured";

const schema = z
  .object({ reply: z.string(), confidence: z.number().min(0).max(1) })
  .strict();
const request = {
  name: "test_answer",
  schema,
  instructions: "Use the supplied facts to answer briefly.",
  input: { question: "When is the interview?", facts: ["Tuesday"] },
  maxOutputTokens: 120,
  timeoutMs: 1000,
};

function response(output: unknown, status = "completed") {
  return {
    id: "resp_test",
    object: "response",
    created_at: 1,
    status,
    output,
  };
}

function textOutput(value: unknown) {
  return [
    {
      id: "msg_test",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        { type: "output_text", text: JSON.stringify(value), annotations: [] },
      ],
    },
  ];
}

function fakeFetch(
  handler: (request: Request) => Response | Promise<Response>,
): typeof fetch {
  return async (input, init) => handler(new Request(input, init));
}

function errorIs(code: ModelRequestError["code"]) {
  return (error: unknown) => {
    assert.ok(error instanceof ModelRequestError);
    assert.equal(error.code, code);
    assert.doesNotMatch(
      error.message,
      /private-provider-payload|test-secret-key|private-refusal/,
    );
    assert.equal(error.cause, undefined);

    return true;
  };
}

test("structured generation sends bounded private requests and returns schema-validated output through the actual SDK", async () => {
  let calls = 0;
  const generate = createStructuredModel({
    model: "test-model",
    apiKey: "test-secret-key",
    fetch: fakeFetch(async (sent) => {
      calls += 1;
      assert.equal(sent.method, "POST");
      assert.equal(new URL(sent.url).pathname, "/v1/responses");

      const body = await sent.json();

      assert.equal(body.model, "test-model");
      assert.equal(body.store, false);
      assert.equal(body.max_output_tokens, request.maxOutputTokens);
      assert.equal(body.instructions, request.instructions);
      assert.deepEqual(JSON.parse(body.input), request.input);
      assert.equal(body.text.format.name, request.name);
      assert.equal(body.text.format.type, "json_schema");
      assert.equal(body.text.format.strict, true);

      return Response.json(
        response(
          textOutput({ reply: "Your interview is on Tuesday.", confidence: 1 }),
        ),
      );
    }),
  });

  assert.deepEqual(await generate(request), {
    reply: "Your interview is on Tuesday.",
    confidence: 1,
  });
  assert.equal(calls, 1);
});

test("invalid structured responses, refusals, incomplete generation, and missing output fail closed", async () => {
  const invalid = [
    response(textOutput({ reply: 123, confidence: 1 })),
    response(textOutput({ reply: "Unsupported confidence", confidence: 2 })),
    response(textOutput({ reply: "Extra data", confidence: 1, extra: true })),
    response([
      {
        type: "message",
        role: "assistant",
        content: [{ type: "refusal", refusal: "private-refusal" }],
      },
    ]),
    response(
      textOutput({ reply: "Looks valid but was cut off", confidence: 1 }),
      "incomplete",
    ),
    response([]),
    { id: "resp_missing", status: "completed" },
    response([
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "not-json", annotations: [] }],
      },
    ]),
  ];

  for (const payload of invalid) {
    const generate = createStructuredModel({
      model: "test-model",
      apiKey: "test-secret-key",
      fetch: fakeFetch(() => Response.json(payload)),
    });

    await assert.rejects(generate(request), errorIs("invalid_output"));
  }
});

test("provider rate limits and server errors are not retried and private diagnostics are sanitized", async () => {
  for (const status of [429, 500]) {
    let calls = 0;
    const generate = createStructuredModel({
      model: "test-model",
      apiKey: "test-secret-key",
      fetch: fakeFetch(() => {
        calls += 1;

        return Response.json(
          {
            error: {
              message: "private-provider-payload test-secret-key",
              type: "server_error",
            },
          },
          {
            status,
            headers: { "retry-after": "0", "x-should-retry": "true" },
          },
        );
      }),
    });

    await assert.rejects(generate(request), errorIs("unavailable"));
    assert.equal(calls, 1);
  }
});

test("transport failures remain sanitized and perform one attempt", async () => {
  let calls = 0;
  const generate = createStructuredModel({
    model: "test-model",
    apiKey: "test-secret-key",
    fetch: fakeFetch(() => {
      calls += 1;
      throw new Error("private-provider-payload test-secret-key");
    }),
  });

  await assert.rejects(generate(request), errorIs("unavailable"));
  assert.equal(calls, 1);
});

test("pre-cancelled generation performs no network request", async () => {
  const controller = new AbortController();
  controller.abort(new Error("private-provider-payload"));
  let calls = 0;
  const generate = createStructuredModel({
    model: "test-model",
    apiKey: "test-secret-key",
    fetch: fakeFetch(() => {
      calls += 1;
      throw new Error("must not fetch");
    }),
  });

  await assert.rejects(
    generate({ ...request, signal: controller.signal }),
    errorIs("cancelled"),
  );
  assert.equal(calls, 0);
});

test(
  "caller cancellation aborts an in-flight SDK request without leaking the cancellation reason",
  { timeout: 1500 },
  async () => {
    const controller = new AbortController();
    let signal: AbortSignal | undefined;
    const generate = createStructuredModel({
      model: "test-model",
      apiKey: "test-secret-key",
      fetch: fakeFetch((sent) => {
        signal = sent.signal;

        return new Promise<Response>((_resolve, reject) => {
          sent.signal.addEventListener(
            "abort",
            () =>
              reject(
                new DOMException("private-provider-payload", "AbortError"),
              ),
            { once: true },
          );
          queueMicrotask(() =>
            controller.abort(new Error("private-provider-payload")),
          );
        });
      }),
    });

    await assert.rejects(
      generate({ ...request, signal: controller.signal }),
      errorIs("cancelled"),
    );
    assert.equal(signal?.aborted, true);
  },
);

test(
  "request deadline bounds even a fetch implementation that ignores abort",
  { timeout: 1500 },
  async () => {
    let signal: AbortSignal | undefined;
    const generate = createStructuredModel({
      model: "test-model",
      apiKey: "test-secret-key",
      fetch: fakeFetch((sent) => {
        signal = sent.signal;

        return new Promise<Response>(() => {});
      }),
    });

    await assert.rejects(
      generate({ ...request, timeoutMs: 20 }),
      errorIs("timeout"),
    );
    assert.equal(signal?.aborted, true);
  },
);

test(
  "deadline also covers response body reading",
  { timeout: 1500 },
  async () => {
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const generate = createStructuredModel({
      model: "test-model",
      apiKey: "test-secret-key",
      fetch: fakeFetch(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                body = controller;
              },
            }),
            { headers: { "content-type": "application/json" } },
          ),
      ),
    });

    try {
      await assert.rejects(
        generate({ ...request, timeoutMs: 20 }),
        errorIs("timeout"),
      );
    } finally {
      body?.error(new Error("test stream closed"));
    }
  },
);

test("invalid budgets and request names are rejected before network access", async () => {
  let calls = 0;
  const generate = createStructuredModel({
    model: "test-model",
    apiKey: "test-secret-key",
    fetch: fakeFetch(() => {
      calls += 1;
      throw new Error("must not fetch");
    }),
  });

  for (const invalid of [
    { ...request, maxOutputTokens: 0 },
    { ...request, maxOutputTokens: 1.5 },
    { ...request, timeoutMs: 0 },
    { ...request, timeoutMs: Number.NaN },
    { ...request, name: "" },
  ]) {
    await assert.rejects(generate(invalid), errorIs("invalid_input"));
  }

  assert.equal(calls, 0);
});

test("missing model or explicit empty credentials produce configuration errors without network access", async () => {
  let calls = 0;
  const fetch = fakeFetch(() => {
    calls += 1;
    throw new Error("must not fetch");
  });

  for (const configuration of [
    { model: "", apiKey: "test-secret-key", fetch },
    { model: "test-model", apiKey: "", fetch },
  ]) {
    await assert.rejects(
      async () => createStructuredModel(configuration)(request),
      errorIs("config"),
    );
  }

  assert.equal(calls, 0);
});

test(
  "caller cancellation remains bounded when the transport ignores its abort signal",
  { timeout: 1500 },
  async () => {
    const controller = new AbortController();
    const generate = createStructuredModel({
      model: "test-model",
      apiKey: "test-secret-key",
      fetch: fakeFetch(() => {
        queueMicrotask(() =>
          controller.abort(new Error("private-provider-payload")),
        );
        return new Promise<Response>(() => {});
      }),
    });

    await assert.rejects(
      generate({ ...request, signal: controller.signal }),
      errorIs("cancelled"),
    );
  },
);
