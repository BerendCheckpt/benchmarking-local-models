import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { parseJsonl, groupBySession, withRetry, markAborted, answerState, nextSession, needsMirror, skipReasons, withRecap } from "../benchmark.mjs";
import { parseSse, withEnv, withBind, mirrorSkipReason } from "../agent.mjs";
import { parseOllamaList, fingerprint } from "../ollama.mjs";
import { pkcePair } from "../oauth.mjs";

test("parseJsonl skips blank lines and defaults answer and session", () => {
  const rows = parseJsonl('{"session":"a","question":"q1","answer":"x"}\n\n{"question":"q2"}\r\n');
  assert.deepEqual(rows, [
    { session: "a", question: "q1", answer: "x", needs: null },
    { session: null, question: "q2", answer: "", needs: null },
  ]);
});

test("parseJsonl reports the bad line", () => {
  assert.throws(() => parseJsonl('{"question":"ok"}\nnot json'), /line 2: not valid JSON/);
  assert.throws(() => parseJsonl('{"answer":"no question"}'), /line 1: "question" missing/);
  assert.throws(() => parseJsonl('{"question":"q","needs":"mirror"}'), /line 1: "needs" must be a list/);
});

test("needsMirror follows the needs tag, and falls back to keywords only without one", () => {
  assert.equal(needsMirror({ question: "hi", needs: ["mirror"] }), true);
  assert.equal(needsMirror({ question: "what does the FDS say?", needs: [] }), false);
  assert.equal(needsMirror({ question: "what does the FDS say?", needs: null }), true);
  assert.equal(needsMirror({ question: "which ticket centers does C&A use?", needs: null }), false);
});

test("skipReasons skips only the messages that need a missing mirror", () => {
  const conversation = [
    { question: "a", needs: [] }, { question: "b", needs: ["mirror"] }, { question: "c", needs: [] },
  ];
  const reasons = skipReasons(conversation, ["GH_TOKEN", "AZDO_PAT"]);
  assert.deepEqual(reasons.map(Boolean), [false, true, false]);
  assert.match(reasons[1], /GH_TOKEN and AZDO_PAT missing/);
  assert.deepEqual(skipReasons(conversation, []), ["", "", ""]);
  assert.equal(mirrorSkipReason(["AZDO_PAT"]), "needs the repo mirror, which is not synced: AZDO_PAT missing");
});

test("groupBySession keeps order, needs no minimum, and isolates rows without a session", () => {
  const rows = [
    { session: "a", question: "1" },
    { session: null, question: "2" },
    { session: "b", question: "3" },
    { session: "a", question: "4" },
    { session: null, question: "5" },
  ];
  const groups = groupBySession(rows).map((g) => g.map((r) => r.question));
  assert.deepEqual(groups, [["1", "4"], ["2"], ["3"], ["5"]]);
});

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

test("parseSse builds a result row from the stream", () => {
  const text =
    sse("delta", { text: "Hel" }) +
    sse("tool", { tool: "Bash" }) +
    sse("delta", { text: "lo" }) +
    sse("tool", { tool: "Read" }) +
    sse("action-proposal", {}) +
    sse("result", { sessionId: "s1", costUsd: 0.5, turns: 3, reply: "Hello" }) +
    sse("done", { sessionId: "s1" });
  assert.deepEqual(parseSse(text), {
    ok: true, reply: "Hello", error: "", tokenLimit: false, sessionId: "s1", costUsd: 0.5, turns: 3,
    tools: ["Bash", "Read"], toolCalls: 2, proposals: 1, deltaChars: 5,
  });
});

test("parseSse marks errors as not ok and falls back to done", () => {
  const r = parseSse(sse("error", { error: "boom" }) + sse("done", { sessionId: "s2", turns: 1 }));
  assert.equal(r.ok, false);
  assert.equal(r.error, "boom");
  assert.equal(r.sessionId, "s2");
  assert.equal(r.turns, 1);
  assert.equal(parseSse(sse("error", { code: "AttachmentRejected", reason: "too big" })).error, "too big");
});

test("parseSse flags the output token limit", () => {
  const limit = "Claude Code returned an error result: API Error: Claude's response exceeded the 32000 output token maximum.";
  assert.equal(parseSse(sse("error", { error: limit })).tokenLimit, true);
  assert.equal(parseSse(sse("error", { error: "boom" })).tokenLimit, false);
});

test("answerState separates token-limit answers from other failures", () => {
  assert.equal(answerState({ ok: true }), "ok");
  assert.equal(answerState({ ok: false, tokenLimit: true }), "token-limit");
  assert.equal(answerState({ ok: false, tokenLimit: false }), "failed");
});

test("parseSse of an empty body is an empty failed row", () => {
  assert.deepEqual(parseSse(""), {
    ok: false, reply: "", error: "", tokenLimit: false, sessionId: "", costUsd: 0, turns: 0,
    tools: [], toolCalls: 0, proposals: 0, deltaChars: 0,
  });
});

test("withEnv replaces only the given keys", () => {
  const env = ["PORT=8090", "CLAUDE_CHAT_MODEL=old", "ANTHROPIC_BASE_URL=http://a=b"];
  assert.deepEqual(withEnv(env, { CLAUDE_CHAT_MODEL: "new" }), [
    "PORT=8090", "ANTHROPIC_BASE_URL=http://a=b", "CLAUDE_CHAT_MODEL=new",
  ]);
  assert.deepEqual(withEnv(undefined, { A: "1" }), ["A=1"]);
});

test("withBind replaces a bind to the same target and keeps the others", () => {
  const binds = ["/data:/data", "old-mirror:/srv/repos:ro"];
  assert.deepEqual(withBind(binds, "claude-repos:/srv/repos:ro"), ["/data:/data", "claude-repos:/srv/repos:ro"]);
  assert.deepEqual(withBind(null, "claude-repos:/srv/repos:ro"), ["claude-repos:/srv/repos:ro"]);
});

test("a token-limit answer starts a fresh agent session; other answers continue it", () => {
  assert.equal(nextSession("token-limit", "abc"), "");
  assert.equal(nextSession("ok", "abc"), "abc");
  assert.equal(nextSession("failed", "abc"), "abc");
});

test("withRecap puts the earlier turns, answers shortened, before the question", () => {
  assert.equal(withRecap([], "q1"), "q1");
  const message = withRecap([{ question: "q1", reply: "x".repeat(900) }, { question: "q2", reply: "" }], "q3");
  assert.match(message, /Question 1: q1\nYour answer: x{800} \[…\]\n\nQuestion 2: q2\nYour answer: \(no answer\)/);
  assert.ok(message.endsWith("\n\nThe next question:\nq3"));
});

test("parseOllamaList returns the NAME column", () => {
  const out = "NAME                ID              SIZE      MODIFIED\nqwen3.8:27B   abc   17 GB   2 days ago\r\nllama3.2:latest  def  2 GB  3 weeks ago\n\n";
  assert.deepEqual(parseOllamaList(out), ["qwen3.8:27B", "llama3.2:latest"]);
});

test("fingerprint matches the OpenSSH SHA256 format", () => {
  const key = Buffer.from("host-key-blob");
  const expected = "SHA256:" + createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
  assert.equal(fingerprint(key), expected);
});

test("pkcePair derives an S256 challenge from the verifier", () => {
  const { verifier, challenge } = pkcePair();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(challenge, createHash("sha256").update(verifier).digest("base64url"));
});

test("withRetry returns once fn succeeds", async () => {
  let calls = 0;
  const value = await withRetry(async () => { if (++calls < 3) throw new Error("EAI_AGAIN"); return "saved"; }, [0, 0, 0, 0]);
  assert.equal(value, "saved");
  assert.equal(calls, 3);
});

test("withRetry rethrows the last error after all attempts", async () => {
  let calls = 0;
  await assert.rejects(withRetry(async () => { calls++; throw new Error(`fail ${calls}`); }, [0, 0]), /fail 3/);
  assert.equal(calls, 3);
});

test("markAborted fails the message in flight and skips the rest", () => {
  const sessions = [
    { messages: [{ state: "ok" }, { state: "running" }] },
    { messages: [{ state: "pending" }, { state: "pending" }] },
  ];
  markAborted(sessions, "agent not healthy");
  assert.deepEqual(sessions.flatMap((s) => s.messages), [
    { state: "ok" },
    { state: "failed", error: "agent not healthy" },
    { state: "skipped" },
    { state: "skipped" },
  ]);
});
