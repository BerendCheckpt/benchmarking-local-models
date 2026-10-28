// Runs a benchmark: one conversation per `session`, messages in order, each
// follow-up continuing the agent session the previous answer returned.
import { applyModel, postChat } from "./agent.mjs";
import { insertResult } from "./db.mjs";

export const status = {
  state: "idle", model: null, done: 0, total: 0, failures: 0, unsaved: 0, lastError: "",
  current: null, last: null, sessions: [],
};

/** Parses JSON Lines rows of `{ session, question, answer }`. */
export function parseJsonl(text) {
  return text.split(/\r?\n/).flatMap((line, i) => {
    if (!line.trim()) return [];
    let row;
    try { row = JSON.parse(line); } catch { throw new Error(`line ${i + 1}: not valid JSON`); }
    if (typeof row?.question !== "string" || !row.question.trim()) throw new Error(`line ${i + 1}: "question" missing`);
    return [{ session: row.session ?? null, question: row.question, answer: row.answer ?? "" }];
  });
}

/** Groups rows by session, keeping file order. Rows without a session stand alone. */
export function groupBySession(rows) {
  const groups = new Map();
  rows.forEach((row, i) => {
    const key = row.session ?? Symbol(i);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });
  return [...groups.values()];
}

/** The status with the running request's elapsed time filled in. */
export function snapshot() {
  const current = status.current && { ...status.current, elapsedMs: Date.now() - status.current.startedAt };
  return { ...status, current };
}

async function ask(question, sessionId) {
  try {
    return await postChat(question, sessionId);
  } catch (err) {
    return { ok: false, reply: "", error: err.message, sessionId: "", costUsd: 0, turns: 0, tools: [], toolCalls: 0, proposals: 0, deltaChars: 0 };
  }
}

/** Calls fn, retrying after each delay while it throws; the last error is rethrown. */
export async function withRetry(fn, delaysMs = [1000, 2000, 4000, 8000]) {
  for (const delay of delaysMs) {
    try {
      return await fn();
    } catch (err) {
      console.error(`[run] retrying in ${delay} ms: ${err.message}`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  return fn();
}

/** After a run stops early: the message in flight failed, the rest never ran. */
export function markAborted(sessions, error) {
  for (const message of sessions.flatMap((s) => s.messages)) {
    if (message.state === "running") Object.assign(message, { state: "failed", error });
    else if (message.state === "pending") message.state = "skipped";
  }
}

// One question: ask, show the result, then save it. The page is updated before
// the insert so a database outage cannot lose an answer that took minutes.
async function answerOne({ view, s, m, of, question, answer, sessionId, model, runId }) {
  const started = Date.now();
  view.messages[m].state = "running";
  status.current = { session: s, label: view.label, message: m, of, question, sessionId, startedAt: started };
  const result = await ask(question, sessionId);
  // A failed turn returns no session; keep the old one so the follow-ups still have context.
  const nextSessionId = result.sessionId || sessionId;
  const latency_ms = Date.now() - started;
  Object.assign(view.messages[m], { ...result, sessionId: nextSessionId, latency_ms, state: result.ok ? "ok" : "failed" });
  view.agentSessionId = nextSessionId;
  status.current = null;
  status.done++;
  if (!result.ok) { status.failures++; status.lastError = result.error; }

  const row = { ...result, sessionId: nextSessionId, prompt: question, expected_answer: answer, latency_ms };
  try {
    await withRetry(() => insertResult(row, model, runId));
  } catch (err) {
    console.error(`[run] could not save session ${view.label} message ${m + 1}: ${err.message}`);
    Object.assign(view.messages[m], { unsaved: true, dbError: err.message });
    status.unsaved++;
    status.lastError = `not saved: ${err.message}`;
  }
  status.last = { label: view.label, message: m, of, ...view.messages[m] };
  return nextSessionId;
}

export async function run(model, rows) {
  const groups = groupBySession(rows);
  Object.assign(status, {
    state: "starting agent", model, done: 0, total: rows.length, failures: 0, unsaved: 0, lastError: "",
    current: null, last: null,
    // Per-session view for the page; each message gets its result once answered.
    sessions: groups.map((group, i) => ({
      label: group[0].session ?? `(no session) #${i + 1}`,
      agentSessionId: "",
      messages: group.map(({ question, answer }) => ({ question, expected: answer, state: "pending" })),
    })),
  });
  try {
    await applyModel(model);
    status.state = "running";
    const runId = Math.floor(Date.now() / 1000);
    for (const [s, conversation] of groups.entries()) {
      const view = status.sessions[s];
      let sessionId = "";
      for (const [m, { question, answer }] of conversation.entries()) {
        sessionId = await answerOne({ view, s, m, of: conversation.length, question, answer, sessionId, model, runId });
      }
    }
    status.state = "finished";
  } catch (err) {
    console.error(`[run] stopped: ${err.message}`);
    markAborted(status.sessions, err.message);
    Object.assign(status, { state: "failed", lastError: err.message, current: null });
  }
}
