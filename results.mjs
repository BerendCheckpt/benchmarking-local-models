// Turns the results page's query string into filters, and stored rows into runs.
import { answerState } from "./benchmark.mjs";

const badRequest = (message) => Object.assign(new Error(message), { statusCode: 400 });

/** Validates `model`, `from`/`to` (ISO instants) and `minMessages`/`maxMessages`. */
export function parseResultFilters(params) {
  const text = (name) => params.get(name)?.trim() || null;
  const instant = (name) => {
    const value = text(name);
    if (value === null) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw badRequest(`${name}: not a valid date`);
    return date.toISOString();
  };
  const count = (name) => {
    const value = text(name);
    if (value === null) return null;
    if (!/^\d+$/.test(value)) throw badRequest(`${name}: not a whole number`);
    return Number(value);
  };
  return {
    model: text("model"), from: instant("from"), to: instant("to"),
    minMessages: count("minMessages"), maxMessages: count("maxMessages"),
  };
}

function totals(messages) {
  const count = (state) => messages.filter((m) => m.state === state).length;
  const sum = (key) => messages.reduce((n, m) => n + (m[key] ?? 0), 0);
  // Skipped messages were never asked, so they don't count towards latency.
  const asked = messages.length - count("skipped");
  return {
    messages: messages.length, ok: count("ok"), failed: count("failed"), tokenLimit: count("token-limit"),
    skipped: count("skipped"), contextRecaps: messages.filter((m) => m.contextRecap).length,
    avgLatencyMs: asked ? sum("latency_ms") / asked : null,
    toolCalls: sum("toolCalls"), costUsd: sum("costUsd"),
  };
}

/** Groups rows (ordered by run, session, time) into runs → sessions → messages with totals. */
export function groupRuns(rows) {
  const runs = new Map();
  for (const r of rows) {
    if (!runs.has(r.run_id)) runs.set(r.run_id, { runId: r.run_id, model: r.model, createdAt: r.created_at, sessions: new Map() });
    const run = runs.get(r.run_id);
    if (r.created_at < run.createdAt) run.createdAt = r.created_at;
    if (!run.sessions.has(r.sessionId)) run.sessions.set(r.sessionId, { sessionId: r.sessionId, sessionMessages: r.session_messages, messages: [] });
    run.sessions.get(r.sessionId).messages.push({
      question: r.prompt, expected: r.expected_answer, reply: r.reply, error: r.error ?? "",
      state: r.skip_reason ? "skipped" : answerState({ ok: r.ok, tokenLimit: r.token_limit }),
      skipReason: r.skip_reason ?? "", contextRecap: !!r.context_recap, latency_ms: r.latency_ms, turns: r.turns,
      tools: r.tools ?? [], toolCalls: r.toolCalls, proposals: r.proposals, costUsd: r.costUsd,
      sessionId: r.sessionId, createdAt: r.created_at, attachments: r.attachments ?? [],
    });
  }
  return [...runs.values()]
    .map((run) => {
      const sessions = [...run.sessions.values()].map((s) => ({ ...s, totals: totals(s.messages) }));
      return { ...run, sessions, totals: { ...totals(sessions.flatMap((s) => s.messages)), sessions: sessions.length } };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt) || b.runId - a.runId);
}
