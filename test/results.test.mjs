import { test } from "node:test";
import assert from "node:assert/strict";
import { parseResultFilters, groupRuns } from "../results.mjs";

test("parseResultFilters reads every filter and treats empty values as unset", () => {
  const params = new URLSearchParams({ model: "Qwen3.8:27B", from: "2026-10-28T23:00:00.000Z", to: "2026-10-29T23:00:00.000Z", minMessages: "2", maxMessages: "" });
  assert.deepEqual(parseResultFilters(params), {
    model: "Qwen3.8:27B", from: "2026-10-28T23:00:00.000Z", to: "2026-10-29T23:00:00.000Z", minMessages: 2, maxMessages: null,
  });
  assert.deepEqual(parseResultFilters(new URLSearchParams()), { model: null, from: null, to: null, minMessages: null, maxMessages: null });
});

test("parseResultFilters rejects bad dates and counts with a 400", () => {
  assert.throws(() => parseResultFilters(new URLSearchParams({ from: "yesterday" })), (err) => err.statusCode === 400 && /from/.test(err.message));
  assert.throws(() => parseResultFilters(new URLSearchParams({ minMessages: "-1" })), /minMessages/);
  assert.throws(() => parseResultFilters(new URLSearchParams({ maxMessages: "2.5" })), /maxMessages/);
});

const row = (run_id, sessionId, day, extra = {}) => ({
  run_id, model: "m", created_at: new Date(`2026-10-${day}T10:00:00Z`), sessionId, session_messages: 1,
  prompt: "q", expected_answer: "a", reply: "r", error: null, ok: true, token_limit: false,
  latency_ms: 1000, turns: 1, tools: [], toolCalls: 1, proposals: 0, costUsd: 0.5, ...extra,
});

test("groupRuns nests runs, sessions and messages with totals, newest run first", () => {
  const runs = groupRuns([
    row(1, "a", 28),
    row(1, "a", 28, { ok: false, token_limit: true, latency_ms: 3000 }),
    row(1, "b", 28, { ok: false, error: "boom" }),
    row(2, "c", 29),
  ]);
  assert.deepEqual(runs.map((r) => r.runId), [2, 1]);
  const run = runs[1];
  assert.deepEqual(run.sessions.map((s) => [s.sessionId, s.messages.map((m) => m.state)]), [
    ["a", ["ok", "token-limit"]],
    ["b", ["failed"]],
  ]);
  assert.deepEqual(run.totals, { messages: 3, ok: 1, failed: 1, tokenLimit: 1, skipped: 0, contextRecaps: 0, avgLatencyMs: 5000 / 3, toolCalls: 3, costUsd: 1.5, sessions: 2 });
  assert.equal(run.sessions[0].totals.avgLatencyMs, 2000);
});

test("groupRuns marks skipped rows and leaves them out of the latency", () => {
  const [run] = groupRuns([
    row(1, "a", 28),
    row(1, "a", 28, { ok: false, skip_reason: "needs the repo mirror", latency_ms: 0, toolCalls: 0, costUsd: 0 }),
  ]);
  const [, skipped] = run.sessions[0].messages;
  assert.equal(skipped.state, "skipped");
  assert.equal(skipped.skipReason, "needs the repo mirror");
  assert.equal(run.totals.skipped, 1);
  assert.equal(run.totals.avgLatencyMs, 1000);
});

test("groupRuns carries the recap flag and counts it", () => {
  const [run] = groupRuns([row(1, "a", 28, { context_recap: true }), row(1, "a", 28)]);
  assert.deepEqual(run.sessions[0].messages.map((m) => m.contextRecap), [true, false]);
  assert.equal(run.totals.contextRecaps, 1);
});
