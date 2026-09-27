import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import postgres from "postgres";
import { migrateTestDatabase } from "../backend/migrations";
import {
  createNangoConnectAdapter,
  NangoConnectError,
} from "../../src/server/integrations/nango-connect";
import { GET, POST } from "../../src/app/api/gmail/route";
import { getDatabase } from "../../src/server/database";
import { getOrCreateSession } from "../../src/server/http/session";

const config = {
  secretKey: "test-nango-secret",
  integrationId: "gmail-readonly",
};
const ownerId = randomUUID();
const attemptId = randomUUID();
const expiresAt = () => new Date(Date.now() + 30 * 60 * 1000).toISOString();
const sessionPayload = (link?: string) => ({
  data: {
    token: "short-lived-connect-token",
    expires_at: expiresAt(),
    ...(link ? { connect_link: link } : {}),
  },
});
const connection = (owner: string = ownerId, attempt: string = attemptId) => ({
  connection_id: `connection-${attempt}`,
  provider_config_key: config.integrationId,
  tags: { end_user_id: owner, persona_attempt_id: attempt },
  errors: [],
});
const stub =
  (
    handler: (url: URL, init: RequestInit) => Response | Promise<Response>,
  ): typeof fetch =>
  async (url, init) =>
    handler(new URL(String(url)), init ?? {});
const errorCode = (code: NangoConnectError["code"]) => (error: unknown) =>
  error instanceof NangoConnectError &&
  error.code === code &&
  error.cause === undefined;

test("connect sessions use server ownership tags and a restricted integration without legacy identity", async () => {
  const adapter = createNangoConnectAdapter(config, {
    fetch: stub((url, init) => {
      assert.equal(url.href, "https://api.nango.dev/connect/sessions");
      assert.equal(init.method, "POST");
      assert.equal(init.redirect, "error");
      assert.equal(
        new Headers(init.headers).get("Authorization"),
        `Bearer ${config.secretKey}`,
      );
      assert.deepEqual(JSON.parse(String(init.body)), {
        tags: { end_user_id: ownerId, persona_attempt_id: attemptId },
        allowed_integrations: [config.integrationId],
      });
      return Response.json(sessionPayload());
    }),
  });
  const result = await adapter.createSession(ownerId, attemptId);
  assert.equal(
    result.connectUrl,
    "https://connect.nango.dev/?session_token=short-lived-connect-token",
  );
  assert.equal("token" in result, false);
});

test("unexpected Connect URL hosts, protocols and credentials fail closed", async () => {
  for (const link of [
    "https://attacker.test/",
    "http://connect.nango.dev/",
    "https://connect.nango.dev.attacker.test/",
    "https://user:password@connect.nango.dev/",
  ]) {
    const adapter = createNangoConnectAdapter(config, {
      fetch: stub(() => Response.json(sessionPayload(link))),
    });
    await assert.rejects(
      adapter.createSession(ownerId, attemptId),
      errorCode("invalid_response"),
    );
  }
});

test("connection lookup filters both server tags and returns no provider metadata or credentials", async () => {
  const adapter = createNangoConnectAdapter(config, {
    fetch: stub((url, init) => {
      assert.equal(url.pathname, "/connections");
      assert.equal(url.searchParams.get("tags[end_user_id]"), ownerId);
      assert.equal(url.searchParams.get("tags[persona_attempt_id]"), attemptId);
      assert.equal(init.method, "GET");
      return Response.json({
        connections: [
          {
            ...connection(),
            credentials: "never-return",
            metadata: { secret: "never-return" },
          },
        ],
      });
    }),
  });
  assert.deepEqual(await adapter.findOwnedConnection(ownerId, attemptId), {
    connectionId: `connection-${attemptId}`,
  });
});

test("wrong owner, attempt, integration or ambiguous matches cannot authorize Gmail", async () => {
  for (const entries of [
    [connection(randomUUID())],
    [connection(ownerId, randomUUID())],
    [{ ...connection(), provider_config_key: "other-integration" }],
    [connection(), connection()],
  ]) {
    const adapter = createNangoConnectAdapter(config, {
      fetch: stub(() => Response.json({ connections: entries })),
    });
    await assert.rejects(
      adapter.findOwnedConnection(ownerId, attemptId),
      errorCode("ownership_mismatch"),
    );
  }
});

test("no match remains pending and provider auth errors cannot become connected", async () => {
  const empty = createNangoConnectAdapter(config, {
    fetch: stub(() => Response.json({ connections: [] })),
  });
  assert.equal(await empty.findOwnedConnection(ownerId, attemptId), null);
  const denied = createNangoConnectAdapter(config, {
    fetch: stub(() =>
      Response.json({
        connections: [
          { ...connection(), errors: [{ type: "auth", message: "private" }] },
        ],
      }),
    ),
  });
  await assert.rejects(
    denied.findOwnedConnection(ownerId, attemptId),
    errorCode("authorization_failed"),
  );
});

test("provider failures and oversized responses do not leak private upstream text", async () => {
  const failed = createNangoConnectAdapter(config, {
    fetch: stub(() =>
      Response.json({ secret: "private-token" }, { status: 500 }),
    ),
  });
  await assert.rejects(
    failed.createSession(ownerId, attemptId),
    errorCode("provider_unavailable"),
  );
  const oversized = createNangoConnectAdapter(config, {
    fetch: stub(() => new Response("x".repeat(65 * 1024))),
  });
  await assert.rejects(
    oversized.createSession(ownerId, attemptId),
    errorCode("response_too_large"),
  );
});

test("operation deadline covers body streaming", async () => {
  const adapter = createNangoConnectAdapter(config, {
    timeoutMs: 10,
    fetch: stub(
      (_url, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init.signal?.addEventListener(
                "abort",
                () => controller.error(new Error("private transport detail")),
                { once: true },
              );
            },
          }),
        ),
    ),
  });
  await assert.rejects(
    adapter.createSession(ownerId, attemptId),
    errorCode("timeout"),
  );
});

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl)
  throw new Error(
    "Set TEST_DATABASE_URL explicitly to run Postgres integration tests.",
  );
const schema = `test_nango_connect_${randomUUID().replaceAll("-", "")}`;
const scopedUrl = new URL(databaseUrl);
scopedUrl.searchParams.set("search_path", schema);
const savedEnv = {
  DATABASE_URL: process.env.DATABASE_URL,
  APP_URL: process.env.APP_URL,
  NANGO_SECRET_KEY: process.env.NANGO_SECRET_KEY,
  NANGO_INTEGRATION_ID: process.env.NANGO_INTEGRATION_ID,
};
process.env.DATABASE_URL = scopedUrl.toString();
process.env.APP_URL = "https://persona.test";
process.env.NANGO_SECRET_KEY = config.secretKey;
process.env.NANGO_INTEGRATION_ID = config.integrationId;
const db = getDatabase();
const admin = postgres(databaseUrl, { max: 1, onnotice: () => {} });
const originalFetch = globalThis.fetch;

before(async () => {
  await admin`CREATE SCHEMA ${admin(schema)}`;
  await migrateTestDatabase(db);
});

after(async () => {
  globalThis.fetch = originalFetch;
  await db.end();
  await admin`DROP SCHEMA IF EXISTS ${admin(schema)} CASCADE`;
  await admin.end();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const origin = "https://persona.test";
function request(body: unknown, cookie: string) {
  return new Request(`${origin}/api/gmail`, {
    method: "POST",
    headers: { origin, cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
async function browser() {
  const session = await getOrCreateSession(new Request(origin));
  assert.ok(session.setCookie);
  return { cookie: session.setCookie.split(";")[0], scope: session.scope };
}
function mockProvider() {
  const sessions = new Map<string, string>();
  const ready = new Set<string>();
  let searches = 0;
  const transport = stub((url, init) => {
    if (url.pathname === "/connect/sessions") {
      const data = JSON.parse(String(init.body));
      sessions.set(data.tags.persona_attempt_id, data.tags.end_user_id);
      return Response.json(sessionPayload());
    }
    if (url.pathname === "/connections") {
      const attempt = url.searchParams.get("tags[persona_attempt_id]")!;
      return Response.json({
        connections: ready.has(attempt)
          ? [connection(sessions.get(attempt), attempt)]
          : [],
      });
    }
    if (url.pathname === "/proxy/gmail/v1/users/me/messages") {
      searches += 1;
      return Response.json({ resultSizeEstimate: 0 });
    }
    assert.fail("Unexpected provider request");
  });
  globalThis.fetch = transport;
  return { sessions, ready, transport, searches: () => searches };
}
async function start(cookie: string) {
  const response = await POST(request({ action: "start" }, cookie));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(typeof data.connectUrl, "string");
  assert.equal("token" in data, false);
  return data.attemptId as string;
}

test("cross-owner confirmation is rejected before provider access; successful binding is idempotent", async () => {
  const provider = mockProvider();
  const a = await browser();
  const b = await browser();
  const id = await start(a.cookie);
  provider.ready.add(id);
  assert.equal(
    (await POST(request({ action: "confirm", attemptId: id }, b.cookie)))
      .status,
    404,
  );
  assert.equal(provider.searches(), 0);
  const responses = await Promise.all([
    POST(request({ action: "confirm", attemptId: id }, a.cookie)),
    POST(request({ action: "confirm", attemptId: id }, a.cookie)),
  ]);
  assert.ok(responses.some((response) => response.status === 200));
  assert.ok(
    responses.every((response) => [200, 202].includes(response.status)),
  );
  assert.equal(
    (await POST(request({ action: "confirm", attemptId: id }, a.cookie)))
      .status,
    200,
  );
  assert.equal(provider.searches(), 1);
  const bindings =
    await db`SELECT owner_id FROM gmail_connections WHERE owner_id = ${a.scope.ownerId}`;
  assert.equal(bindings.length, 1);
  const status = await GET(
    new Request(`${origin}/api/gmail`, { headers: { cookie: b.cookie } }),
  );
  assert.equal((await status.json()).connected, false);
});

test("refresh restores pending attempt and superseded or expired attempts never bind", async () => {
  const provider = mockProvider();
  const user = await browser();
  const older = await start(user.cookie);
  const newer = await start(user.cookie);
  provider.ready.add(older);
  const refreshed = await GET(
    new Request(`${origin}/api/gmail`, { headers: { cookie: user.cookie } }),
  );
  const state = await refreshed.json();
  assert.equal(state.attempt.id, newer);
  assert.equal(state.attempt.status, "pending");
  assert.equal(
    (await POST(request({ action: "confirm", attemptId: older }, user.cookie)))
      .status,
    409,
  );
  await db`UPDATE gmail_connect_attempts SET expires_at = now() - interval '1 second' WHERE id = ${newer}`;
  assert.equal(
    (await POST(request({ action: "confirm", attemptId: newer }, user.cookie)))
      .status,
    409,
  );
  const bindings =
    await db`SELECT owner_id FROM gmail_connections WHERE owner_id = ${user.scope.ownerId}`;
  assert.equal(bindings.length, 0);
});

test("superseding during provider verification blocks the delayed old binding", async () => {
  const provider = mockProvider();
  const user = await browser();
  const older = await start(user.cookie);
  provider.ready.add(older);
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  globalThis.fetch = stub(async (url, init) => {
    if (url.pathname === "/connections") {
      entered();
      await blocked;
    }
    return provider.transport(url, init);
  });
  const confirming = POST(
    request({ action: "confirm", attemptId: older }, user.cookie),
  );
  await waiting;
  await start(user.cookie);
  release();
  assert.equal((await confirming).status, 409);
  const bindings =
    await db`SELECT owner_id FROM gmail_connections WHERE owner_id = ${user.scope.ownerId}`;
  assert.equal(bindings.length, 0);
});

test("browser cannot submit ownership overrides and provider errors remain sanitized", async () => {
  const user = await browser();
  globalThis.fetch = stub(() => {
    throw new Error("secret-token private@example.test");
  });
  const invalid = await POST(
    request({ action: "start", ownerId: randomUUID() }, user.cookie),
  );
  assert.equal(invalid.status, 400);
  const failure = await POST(request({ action: "start" }, user.cookie));
  assert.equal(failure.status, 503);
  assert.doesNotMatch(await failure.text(), /secret-token|private@example/);
  assert.match(failure.headers.get("cache-control")!, /no-store/);
});

test("verified owner tags do not bind Gmail when the search capability probe is denied", async () => {
  const provider = mockProvider();
  const user = await browser();
  const id = await start(user.cookie);
  provider.ready.add(id);

  globalThis.fetch = stub((url, init) => {
    if (url.pathname.startsWith("/proxy/")) {
      return Response.json(
        { error: { message: "private revoked token" } },
        { status: 403 },
      );
    }

    return provider.transport(url, init);
  });

  const result = await POST(
    request({ action: "confirm", attemptId: id }, user.cookie),
  );
  assert.equal(result.status, 409);
  assert.doesNotMatch(await result.text(), /private revoked token/);
  const bindings =
    await db`SELECT owner_id FROM gmail_connections WHERE owner_id = ${user.scope.ownerId}`;
  assert.equal(bindings.length, 0);
});

test("rapid confirmation polling reuses the attempt without repeating provider lookups", async () => {
  const provider = mockProvider();
  const user = await browser();
  const id = await start(user.cookie);
  let lookups = 0;

  globalThis.fetch = stub((url, init) => {
    if (url.pathname === "/connections") lookups += 1;

    return provider.transport(url, init);
  });

  for (let count = 0; count < 3; count += 1) {
    const result = await POST(
      request({ action: "confirm", attemptId: id }, user.cookie),
    );
    assert.equal(result.status, 202);
  }

  assert.equal(lookups, 1);
});
