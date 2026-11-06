// How a judged message counts: its outcome and its weight. Shared by
// aggregate.mjs (the report tables) and viewer-data.mjs (the viewer file).

// Weight = how costly a wrong answer is (category) × how hard it is for the
// asker to spot one (persona) × answerability, so setup gaps don't dominate.
export const CAT = { troubleshoot: 3, "implementation-logic": 3, "data-lookup": 2, labelizer: 2,
  "request-drafting": 2, "feasibility-estimate": 2, "how-to": 1.5, "follow-up": 1, general: 0.5 };
export const PER = { support: 1.25, operations: 1.25, "requirement-analyst": 1.15,
  "layout-designer": 1.0, developer: 0.9, unknown: 1.0 };
export const ANS = { full: 1, partial: 0.75, no: 0.5 };
export const weight = (r) => (CAT[r.category] ?? 1) * (PER[r.persona] ?? 1) * (ANS[r.answerable] ?? 1);

// The agent's own deadline notes, old and new wording; a model that mentions time in its answer is still answered.
export const outOfTime = (r) => r.ok && /I ran out of time before (finishing|I could finish checking|I had anything to tell you)/i.test(r.reply);
export const outcome = (r) => (!r.ok ? (r.tokenLimit ? "token limit" : /not logged in/i.test(r.error) ? "not logged in" : "transport error")
  : outOfTime(r) ? "out of time" : "answered");

export const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "–");
export const weighted = (list) => pct(list.reduce((s, r) => s + weight(r) * r.score, 0), 3 * list.reduce((s, r) => s + weight(r), 0));
export const mean = (list) => (list.length ? (list.reduce((s, r) => s + r.score, 0) / list.length).toFixed(2) : "–");
