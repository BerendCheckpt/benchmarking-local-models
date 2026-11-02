// Runs a benchmark: one conversation per `session`, messages in order, each
// follow-up continuing the agent session the previous answer returned.
import { applyModel, mirrorSkipReason, missingMirrorTokens, postChat } from "./agent.mjs";
import { insertResult } from "./db.mjs";

export const status = {
  state: "idle", model: null, done: 0, total: 0, failures: 0, tokenLimits: 0, skipped: 0, unsaved: 0, lastError: "",
  mirrorMissing: [], current: null, last: null, sessions: [],
};

/** Parses JSON Lines rows of `{ session, question, answer, needs? }`. */
export function parseJsonl(text) {
  return text.split(/\r?\n/).flatMap((line, i) => {
    if (!line.trim()) return [];
    let row;
    try { row = JSON.parse(line); } catch { throw new Error(`line ${i + 1}: not valid JSON`); }
    if (typeof row?.question !== "string" || !row.question.trim()) throw new Error(`line ${i + 1}: "question" missing`);
    if (row.needs !== undefined && !(Array.isArray(row.needs) && row.needs.every((n) => typeof n === "string"))) {
      throw new Error(`line ${i + 1}: "needs" must be a list of strings`);
    }
    return [{ session: row.session ?? null, question: row.question, answer: row.answer ?? "", needs: row.needs ?? null }];
  });
}

// Used only for lines without a "needs" list. It catches the obvious cases and
// misses many (on the 2026-10-29 file: 15 of 67), so tag the input file instead.
const MIRROR_WORDS = /\b(fds|source code|plugin.{0,12}(code|logic)|(import|export) (logic|process|plugin)|implemented|business rules?|layout designer)\b/i;

/** Does answering this row need the repo mirror (plugin code, FDS, Layout Designer manual)? */
export function needsMirror(row) {
  return row.needs ? row.needs.includes("mirror") : MIRROR_WORDS.test(row.question);
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
    return { ok: false, reply: "", error: err.message, tokenLimit: false, sessionId: "", costUsd: 0, turns: 0, tools: [], toolCalls: 0, proposals: 0, deltaChars: 0 };
  }
}

/** The state shown for an answered message. */
export function answerState(result) {
  if (result.ok) return "ok";
  return result.tokenLimit ? "token-limit" : "failed";
}

/**
 * The agent session the next message continues. After a token-limit error the
 * resumed session almost always hits the limit again (run 1793258147: 17 of the
 * 20 turns after one), so the follow-ups start a fresh one, with the earlier
 * turns recapped in the first message (withRecap).
 */
export function nextSession(state, sessionId) {
  return state === "token-limit" ? "" : sessionId;
}

// Room for one earlier answer in a recap; the full replies can run to pages.
const RECAP_ANSWER_CHARS = 800;

/**
 * The message for a conversation that lost its agent session (after a token
 * limit, or a first turn that returned none): the earlier turns, answers
 * shortened, then the question. Returns the question itself when there is no
 * history to recap.
 */
export function withRecap(history, question) {
  if (!history.length) return question;
  const turns = history.map(({ question: q, reply }, i) => {
    const answer = !reply ? "(no answer)"
      : reply.length > RECAP_ANSWER_CHARS ? reply.slice(0, RECAP_ANSWER_CHARS) + " […]" : reply;
    return `Question ${i + 1}: ${q}\nYour answer: ${answer}`;
  });
  return "This continues an earlier conversation with you. Its session was lost, so here are the earlier turns "
    + "(answers shortened). Do not answer them again.\n\n"
    + turns.join("\n\n")
    + "\n\nThe next question:\n" + question;
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
async function answerOne({ view, s, m, of, question, answer, sessionId, history, model, runId }) {
  const started = Date.now();
  // Without a session the agent has none of the earlier turns, so they go in the message.
  const contextRecap = !sessionId && history.length > 0;
  view.messages[m].state = "running";
  status.current = { session: s, label: view.label, message: m, of, question, sessionId, contextRecap, startedAt: started };
  const result = await ask(contextRecap ? withRecap(history, question) : question, sessionId);
  const latency_ms = Date.now() - started;
  const state = answerState(result);
  // A failed turn returns no session; keep the old one so the follow-ups still have context.
  const usedSessionId = result.sessionId || sessionId;
  const nextSessionId = nextSession(state, usedSessionId);
  Object.assign(view.messages[m], { ...result, sessionId: usedSessionId, latency_ms, state, contextRecap });
  view.agentSessionId = nextSessionId;
  status.current = null;
  status.done++;
  // Answer errors stay on their message; lastError is only for a run that stopped.
  if (state === "failed") status.failures++;
  if (state === "token-limit") status.tokenLimits++;

  const row = { ...result, sessionId: usedSessionId, prompt: question, expected_answer: answer, latency_ms, contextRecap };
  try {
    await withRetry(() => insertResult(row, model, runId));
  } catch (err) {
    console.error(`[run] could not save session ${view.label} message ${m + 1}: ${err.message}`);
    Object.assign(view.messages[m], { unsaved: true, dbError: err.message });
    status.unsaved++;
  }
  status.last = { label: view.label, message: m, of, ...view.messages[m] };
  history.push({ question, reply: result.reply });
  return nextSessionId;
}

/** Saves a message that was not asked, with the reason, so the run shows what it left out. */
async function skipOne({ view, m, question, answer, sessionId: agentSession, model, runId, reason }) {
  // No agent session yet: name it after the input session so skipped conversations stay apart.
  const sessionId = agentSession || `skipped:${view.label}`;
  Object.assign(view.messages[m], { state: "skipped", skipReason: reason, sessionId });
  status.done++;
  status.skipped++;
  const row = {
    ok: false, reply: "", error: "", tokenLimit: false, sessionId, costUsd: 0, turns: 0, tools: [], toolCalls: 0,
    proposals: 0, deltaChars: 0, prompt: question, expected_answer: answer, latency_ms: 0, skipReason: reason,
  };
  try {
    await withRetry(() => insertResult(row, model, runId));
  } catch (err) {
    console.error(`[run] could not save skipped message ${m + 1} of session ${view.label}: ${err.message}`);
    Object.assign(view.messages[m], { unsaved: true, dbError: err.message });
    status.unsaved++;
  }
}

/**
 * Why each message of a conversation is skipped, or "" to ask it. Only the
 * messages that need the missing mirror are skipped; the conversation carries
 * on with the others, so a follow-up that leans on a skipped answer should be
 * tagged itself.
 */
export function skipReasons(conversation, missingTokens) {
  const reason = mirrorSkipReason(missingTokens);
  return conversation.map((row) => (reason && needsMirror(row) ? reason : ""));
}

async function mirrorStatus() {
  try {
    return await missingMirrorTokens();
  } catch (err) {
    console.error(`[run] could not check the repo mirror, treating it as missing: ${err.message}`);
    return ["GH_TOKEN", "AZDO_PAT"];
  }
}

export async function run(model, rows) {
  const groups = groupBySession(rows);
  Object.assign(status, {
    state: "starting agent", model, done: 0, total: rows.length, failures: 0, tokenLimits: 0, skipped: 0, unsaved: 0,
    lastError: "", mirrorMissing: [], current: null, last: null,
    // Per-session view for the page; each message gets its result once answered.
    sessions: groups.map((group, i) => ({
      label: group[0].session ?? `(no session) #${i + 1}`,
      agentSessionId: "",
      messages: group.map(({ question, answer }) => ({ question, expected: answer, state: "pending" })),
    })),
  });
  try {
    await applyModel(model);
    status.mirrorMissing = await mirrorStatus();
    status.state = "running";
    const runId = Math.floor(Date.now() / 1000);
    for (const [s, conversation] of groups.entries()) {
      const view = status.sessions[s];
      const skips = skipReasons(conversation, status.mirrorMissing);
      let sessionId = "";
      const history = []; // asked turns, for a recap if the session is lost
      for (const [m, { question, answer }] of conversation.entries()) {
        if (skips[m]) {
          await skipOne({ view, m, question, answer, sessionId, model, runId, reason: skips[m] });
          continue;
        }
        sessionId = await answerOne({ view, s, m, of: conversation.length, question, answer, sessionId, history, model, runId });
      }
    }
    status.state = "finished";
  } catch (err) {
    console.error(`[run] stopped: ${err.message}`);
    markAborted(status.sessions, err.message);
    Object.assign(status, { state: "failed", lastError: err.message, current: null });
  }
}
