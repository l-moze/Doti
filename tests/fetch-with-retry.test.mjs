import assert from "node:assert/strict";
import test from "node:test";

import { loadTsModule } from "./helpers/load-ts-module.mjs";

function loadFetchWithRetry(responder) {
  const calls = [];
  const { fetchWithRetry } = loadTsModule("src/lib/fetch-with-retry.ts", {
    fetch: async (input, init) => {
      calls.push({ input, init });
      return responder(calls.length - 1);
    },
  });

  return { calls, fetchWithRetry };
}

test("a successful response is returned without retrying", async () => {
  const { calls, fetchWithRetry } = loadFetchWithRetry(() => new Response("ok", { status: 200 }));
  const response = await fetchWithRetry("https://example.test");

  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
});

test("server errors are retried until a good response arrives", async () => {
  const { calls, fetchWithRetry } = loadFetchWithRetry((attempt) => (
    attempt === 0 ? new Response(null, { status: 503 }) : new Response("ok", { status: 200 })
  ));
  const response = await fetchWithRetry("https://example.test", { retryDelayMs: 0 });

  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
});

test("rate limited responses are retried", async () => {
  const { calls, fetchWithRetry } = loadFetchWithRetry((attempt) => (
    attempt === 0 ? new Response(null, { status: 429 }) : new Response("ok", { status: 200 })
  ));

  await fetchWithRetry("https://example.test", { retryDelayMs: 0 });
  assert.equal(calls.length, 2);
});

test("client errors are surfaced immediately", async () => {
  const { calls, fetchWithRetry } = loadFetchWithRetry(() => new Response(null, { status: 404 }));
  const response = await fetchWithRetry("https://example.test", { retryDelayMs: 0 });

  assert.equal(response.status, 404);
  assert.equal(calls.length, 1);
});

test("the last failing response is returned once retries are exhausted", async () => {
  const { calls, fetchWithRetry } = loadFetchWithRetry(() => new Response(null, { status: 500 }));
  const response = await fetchWithRetry("https://example.test", { retries: 2, retryDelayMs: 0 });

  assert.equal(response.status, 500);
  assert.equal(calls.length, 3, "the initial call plus two retries");
});

test("retries can be disabled", async () => {
  const { calls, fetchWithRetry } = loadFetchWithRetry(() => new Response(null, { status: 500 }));

  await fetchWithRetry("https://example.test", { retries: 0, retryDelayMs: 0 });
  assert.equal(calls.length, 1);
});

test("network errors are retried and rethrown when they persist", async () => {
  const { calls, fetchWithRetry } = loadFetchWithRetry(() => {
    throw new Error("socket hang up");
  });

  await assert.rejects(
    () => fetchWithRetry("https://example.test", { retries: 1, retryDelayMs: 0 }),
    /socket hang up/
  );
  assert.equal(calls.length, 2);
});

test("a custom retry predicate overrides the default policy", async () => {
  const seen = [];
  const { calls, fetchWithRetry } = loadFetchWithRetry((attempt) => (
    attempt === 0 ? new Response(null, { status: 418 }) : new Response("ok", { status: 200 })
  ));

  await fetchWithRetry("https://example.test", {
    retryDelayMs: 0,
    shouldRetry: (response, _error, attempt) => {
      seen.push(attempt);
      return response?.status === 418;
    },
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(seen, [0, 1]);
});

test("request options are forwarded and retry options are not leaked to fetch", async () => {
  const { calls, fetchWithRetry } = loadFetchWithRetry(() => new Response("ok", { status: 200 }));

  await fetchWithRetry("https://example.test", {
    method: "POST",
    body: "payload",
    retries: 3,
    retryDelayMs: 0,
  });

  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.body, "payload");
  assert.equal("retries" in calls[0].init, false);
  assert.equal("retryDelayMs" in calls[0].init, false);
  assert.equal("shouldRetry" in calls[0].init, false);
});
