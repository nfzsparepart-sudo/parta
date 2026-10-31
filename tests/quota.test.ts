import assert from "node:assert/strict";
import test from "node:test";
import { providerRetryDelayMs } from "../app/lib/quota.ts";

test("extracts Google's fractional retry delay from SDK JSON messages", () => {
  const message = JSON.stringify({ error: { details: [
    { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "32.5s" },
  ] } });
  assert.equal(providerRetryDelayMs({ message }), 32500);
});

test("supports legacy SDK error details and zero delays", () => {
  assert.equal(providerRetryDelayMs({ errorDetails: [
    { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "0s" },
  ] }), 0);
});

test("missing or malformed retry information does not invent a wait", () => {
  for (const error of [null, {}, { message: "Too many requests" },
    { errorDetails: [{ retryDelay: "30s" }] },
    { errorDetails: [{ "@type": "google.rpc.RetryInfo", retryDelay: "-1s" }] },
  ]) assert.equal(providerRetryDelayMs(error), undefined);
});
