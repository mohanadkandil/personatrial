import assert from "node:assert/strict";
import test from "node:test";
import {
  createNangoGmailAdapter,
  NangoGmailError,
  type NangoGmailErrorCode,
  type NangoGmailErrorKind,
} from "../../src/server/integrations/nango-gmail";

const config = { secretKey: "test-secret", integrationId: "gmail-readonly" };
const connectionId = "owned-connection";
const json = (value: unknown, status = 200) => Response.json(value, { status });
const errorIs =
  (kind: NangoGmailErrorKind, code: NangoGmailErrorCode) =>
  (error: unknown) => {
    assert.ok(error instanceof NangoGmailError);
    assert.equal(error.kind, kind);
    assert.equal(error.code, code);
    assert.equal(error.retryable, kind === "retryable");
    assert.equal(error.message, `Gmail integration: ${code}`);
    assert.equal(error.cause, undefined);
    return true;
  };

function stubFetch(
  handler: (url: URL, init: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return async (input, init) => handler(new URL(String(input)), init ?? {});
}

test("verification probes current Gmail search access without fetching credentials or email", async () => {
  let calls = 0;
  const adapter = createNangoGmailAdapter(config, {
    fetch: stubFetch((url, init) => {
      calls++;
      assert.equal(url.origin, "https://api.nango.dev");
      assert.equal(url.pathname, "/proxy/gmail/v1/users/me/messages");
      assert.equal(url.searchParams.get("q"), "in:inbox");
      assert.equal(url.searchParams.get("fields"), "resultSizeEstimate");
      assert.equal(url.searchParams.get("maxResults"), "1");
      assert.equal(init.method, "GET");
      assert.equal(init.redirect, "error");
      assert.equal(init.cache, "no-store");
      const headers = new Headers(init.headers);
      assert.equal(headers.get("Authorization"), "Bearer test-secret");
      assert.equal(headers.get("Provider-Config-Key"), "gmail-readonly");
      assert.equal(headers.get("Connection-Id"), connectionId);
      assert.equal(
        headers.get("Base-Url-Override"),
        "https://gmail.googleapis.com",
      );
      assert.equal(headers.get("Retries"), "0");
      return json({ resultSizeEstimate: 0 });
    }),
  });
  assert.deepEqual(await adapter.verifyConnection({ connectionId }), {
    connected: true,
  });
  assert.equal(calls, 1);
});

test("search encodes query and retrieves only bounded metadata, keeping list order", async () => {
  const calls: URL[] = [];
  const query = 'from:example@example.test subject:"a & b"';
  const adapter = createNangoGmailAdapter(config, {
    fetch: stubFetch((url, init) => {
      calls.push(url);
      assert.equal(init.method, "GET");
      if (url.pathname.endsWith("/messages")) {
        assert.equal(url.searchParams.get("q"), query);
        assert.equal(url.searchParams.get("maxResults"), "2");
        return json({
          messages: [{ id: "b" }, { id: "a" }, { id: "ignored" }],
        });
      }
      assert.equal(url.searchParams.get("format"), "metadata");
      assert.deepEqual(url.searchParams.getAll("metadataHeaders"), [
        "Subject",
        "From",
        "Date",
      ]);
      assert.equal(
        url.searchParams.get("fields"),
        "id,threadId,snippet,payload(headers)",
      );
      const id = url.pathname.split("/").at(-1);
      return json({
        id,
        threadId: `thread-${id}`,
        snippet: "s".repeat(2000),
        payload: {
          headers: [
            { name: "SUBJECT", value: "long\r\n" + "x".repeat(1000) },
            { name: "from", value: "Sender <example@example.test>" },
            { name: "Date", value: "Sun, 27 Sep 2026 12:00:00 +0000" },
          ],
          body: { data: "must not return body" },
        },
      });
    }),
  });
  const result = await adapter.searchGmail({ connectionId, query, limit: 2 });
  assert.equal(calls.length, 3);
  assert.deepEqual(
    result.map((message) => message.id),
    ["b", "a"],
  );
  assert.equal(result[0].subject.length, 512);
  assert.ok(!result[0].subject.includes("\n"));
  assert.equal(result[0].snippet.length, 1024);
  assert.deepEqual(Object.keys(result[0]).sort(), [
    "date",
    "from",
    "id",
    "snippet",
    "subject",
    "threadId",
  ]);
});

test("valid empty mailbox returns an empty result, not a failed connection", async () => {
  const adapter = createNangoGmailAdapter(config, {
    fetch: stubFetch(() => json({ resultSizeEstimate: 0 })),
  });
  assert.deepEqual(
    await adapter.searchGmail({ connectionId, query: "is:unread" }),
    [],
  );
});

test("deduplicates message IDs and represents absent optional headers as empty strings", async () => {
  let calls = 0;
  const adapter = createNangoGmailAdapter(config, {
    fetch: stubFetch((url) => {
      calls++;
      return url.pathname.endsWith("/messages")
        ? json({ messages: [{ id: "a" }, { id: "a" }] })
        : json({ id: "a", threadId: "t" });
    }),
  });
  assert.deepEqual(
    await adapter.searchGmail({ connectionId, query: "in:inbox" }),
    [{ id: "a", threadId: "t", subject: "", from: "", date: "", snippet: "" }],
  );
  assert.equal(calls, 2);
});

for (const [status, kind, code] of [
  [401, "auth", "access_denied"],
  [403, "auth", "access_denied"],
  [429, "retryable", "rate_limited"],
  [503, "retryable", "provider_unavailable"],
  [408, "retryable", "provider_unavailable"],
  [404, "unavailable", "provider_unavailable"],
] as const) {
  test(`classifies ${status} without exposing provider error text or retrying`, async () => {
    let calls = 0;
    const adapter = createNangoGmailAdapter(config, {
      fetch: stubFetch(() => {
        calls++;
        return json(
          { error: { message: "private@example.test secret-token" } },
          status,
        );
      }),
    });
    await assert.rejects(
      adapter.verifyConnection({ connectionId }),
      errorIs(kind, code),
    );
    assert.equal(calls, 1);
  });
}

test("recognizes Gmail 403 quota errors as retryable", async () => {
  const adapter = createNangoGmailAdapter(config, {
    fetch: stubFetch(() =>
      json(
        {
          error: {
            errors: [
              { reason: "userRateLimitExceeded", message: "private error" },
            ],
          },
        },
        403,
      ),
    ),
  });
  await assert.rejects(
    adapter.verifyConnection({ connectionId }),
    errorIs("retryable", "rate_limited"),
  );
});

test("transport failures do not expose their cause", async () => {
  const adapter = createNangoGmailAdapter(config, {
    fetch: stubFetch(() => {
      throw new Error("token private@example.test");
    }),
  });
  await assert.rejects(
    adapter.verifyConnection({ connectionId }),
    errorIs("retryable", "network_error"),
  );
});

test("pre-cancelled operations never fetch and cancellation reason remains private", async () => {
  const controller = new AbortController();
  controller.abort("private@example.test");
  const adapter = createNangoGmailAdapter(config, {
    fetch: stubFetch(() => assert.fail("unexpected fetch")),
  });
  await assert.rejects(
    adapter.verifyConnection({ connectionId, signal: controller.signal }),
    errorIs("unavailable", "cancelled"),
  );
});

test("cancels an in-flight request", async () => {
  const controller = new AbortController();
  const adapter = createNangoGmailAdapter(config, {
    fetch: stubFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => reject(new Error("private reason")),
            { once: true },
          );
          queueMicrotask(() => controller.abort("private reason"));
        }),
    ),
  });
  await assert.rejects(
    adapter.verifyConnection({ connectionId, signal: controller.signal }),
    errorIs("unavailable", "cancelled"),
  );
});

test("deadline covers pending requests", async () => {
  const adapter = createNangoGmailAdapter(config, {
    timeoutMs: 10,
    fetch: stubFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        }),
    ),
  });
  await assert.rejects(
    adapter.verifyConnection({ connectionId }),
    errorIs("retryable", "timeout"),
  );
});

test("deadline also covers response body streaming", async () => {
  const adapter = createNangoGmailAdapter(config, {
    timeoutMs: 10,
    fetch: stubFetch(
      (_url, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init.signal?.addEventListener(
                "abort",
                () => controller.error(new Error("aborted")),
                { once: true },
              );
            },
          }),
        ),
    ),
  });
  await assert.rejects(
    adapter.verifyConnection({ connectionId }),
    errorIs("retryable", "timeout"),
  );
});

test("oversized provider responses are stopped", async () => {
  let cancelled = false;
  const adapter = createNangoGmailAdapter(config, {
    fetch: stubFetch(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(128 * 1024 + 1));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    ),
  });
  await assert.rejects(
    adapter.verifyConnection({ connectionId }),
    errorIs("unavailable", "response_too_large"),
  );
  assert.ok(cancelled);
});

test("malformed JSON and success-shaped errors cannot become connected", async () => {
  for (const payload of [
    "not json",
    '{"error":"private"}',
    '{"resultSizeEstimate":-1}',
  ]) {
    const adapter = createNangoGmailAdapter(config, {
      fetch: stubFetch(() => new Response(payload)),
    });
    await assert.rejects(
      adapter.verifyConnection({ connectionId }),
      errorIs("unavailable", "invalid_response"),
    );
  }
});

test("message path injection and mismatched IDs are rejected", async () => {
  for (const id of ["../profile", "valid"]) {
    let calls = 0;
    const adapter = createNangoGmailAdapter(config, {
      fetch: stubFetch(() => {
        calls++;
        return calls === 1
          ? json({ messages: [{ id }] })
          : json({ id: "wrong", threadId: "t" });
      }),
    });
    await assert.rejects(
      adapter.searchGmail({ connectionId, query: "in:inbox" }),
      errorIs("unavailable", "invalid_response"),
    );
    assert.equal(calls, id === "valid" ? 2 : 1);
  }
});

test("invalid queries, limits, connection IDs, and configuration fail before network access", async () => {
  const adapter = createNangoGmailAdapter(config, {
    fetch: stubFetch(() => assert.fail("unexpected fetch")),
  });
  for (const query of ["", "  ", "x".repeat(1025), "hello\nworld"]) {
    await assert.rejects(
      adapter.searchGmail({ connectionId, query }),
      errorIs("unavailable", "invalid_input"),
    );
  }
  for (const limit of [0, 21, -1, 1.5, NaN, Infinity]) {
    await assert.rejects(
      adapter.searchGmail({ connectionId, query: "x", limit }),
      errorIs("unavailable", "invalid_input"),
    );
  }
  await assert.rejects(
    adapter.verifyConnection({ connectionId: "bad\r\nheader" }),
    errorIs("unavailable", "invalid_input"),
  );
  assert.throws(
    () => createNangoGmailAdapter({ ...config, secretKey: "" }),
    errorIs("unavailable", "invalid_config"),
  );
  assert.throws(
    () => createNangoGmailAdapter(config, { timeoutMs: 0 }),
    errorIs("unavailable", "invalid_config"),
  );
});

test("a failed detail read rejects the search instead of returning misleading partial data", async () => {
  const adapter = createNangoGmailAdapter(config, {
    fetch: stubFetch((url) => {
      if (url.pathname.endsWith("/messages"))
        return json({ messages: [{ id: "a" }, { id: "b" }] });
      if (url.pathname.endsWith("/a")) return json({ id: "a", threadId: "t" });
      return json({ error: "private" }, 503);
    }),
  });
  await assert.rejects(
    adapter.searchGmail({ connectionId, query: "in:inbox" }),
    errorIs("retryable", "provider_unavailable"),
  );
});
