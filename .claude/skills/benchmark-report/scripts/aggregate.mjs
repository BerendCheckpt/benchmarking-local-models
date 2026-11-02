// Joins the judges' output (judged*.json) with items.json and prints the
// tables for the report as Markdown. Writes rows.json for the appendix.
//
//   node aggregate.mjs <work dir>
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) throw new Error("usage: node aggregate.mjs <work dir>");
const read = (f) => JSON.parse(readFileSync(join(dir, f), "utf8"));

const items = read("items.json");
const judged = readdirSync(dir).filter((f) => /^judged\d+\.json$/.test(f)).flatMap(read);
const J = new Map(judged.map((j) => [j.id, j]));
const all = items.map((it) => ({ ...it, ...J.get(it.id) }));
const skipped = all.filter((r) => r.skipReason);
const rows = all.filter((r) => !r.skipReason);
const missing = rows.filter((r) => r.score === undefined).map((r) => r.id);
if (missing.length) {
  console.error(`not judged yet: ${missing.join(",")}`);
  process.exit(1);
}
writeFileSync(join(dir, "rows.json"), JSON.stringify(all, null, 1));

// Weight = how costly a wrong answer is (category) × how hard it is for the
// asker to spot one (persona) × answerability, so setup gaps don't dominate.
const CAT = { troubleshoot: 3, "implementation-logic": 3, "data-lookup": 2, labelizer: 2,
  "request-drafting": 2, "feasibility-estimate": 2, "how-to": 1.5, "follow-up": 1, general: 0.5 };
const PER = { support: 1.25, operations: 1.25, "requirement-analyst": 1.15,
  "layout-designer": 1.0, developer: 0.9, unknown: 1.0 };
const ANS = { full: 1, partial: 0.75, no: 0.5 };
const weight = (r) => (CAT[r.category] ?? 1) * (PER[r.persona] ?? 1) * (ANS[r.answerable] ?? 1);

const outOfTime = (r) => r.ok && /ran out of time/i.test(r.reply);
const outcome = (r) => (!r.ok ? (r.tokenLimit ? "token limit" : "transport error") : outOfTime(r) ? "out of time" : "answered");
const answered = (r) => outcome(r) === "answered";

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "–");
const mean = (list) => (list.length ? (list.reduce((s, r) => s + r.score, 0) / list.length).toFixed(2) : "–");
const weighted = (list) => pct(list.reduce((s, r) => s + weight(r) * r.score, 0), 3 * list.reduce((s, r) => s + weight(r), 0));
const avgS = (list) => (list.length ? `${Math.round(list.reduce((s, r) => s + r.latencyS, 0) / list.length)} s` : "–");

function groupBy(key) {
  const groups = {};
  for (const r of rows) for (const k of [].concat(r[key] ?? "none")) (groups[k] ??= []).push(r);
  return Object.entries(groups).sort((a, b) => b[1].length - a[1].length);
}

function table(title, head, lines) {
  console.log(`\n### ${title}\n\n| ${head.join(" | ")} |\n|${head.map(() => "---").join("|")}|`);
  for (const l of lines) console.log(`| ${l.join(" | ")} |`);
}

// run.json lists the runs; reports from before date windows hold one run's facts.
const run = read("run.json");
const runs = run.runs ?? [{ runId: run.runId, model: run.model, input: run.input, from: run.from, to: run.to, messages: run.messages }];
const multi = runs.length > 1;
const runIndex = new Map(runs.map((r, i) => [r.runId, i]));
// The same input session can be replayed in several runs, so a session is keyed by run too.
const sessionKey = (r) => `${r.runId ?? ""}:${r.session}`;
const asked = rows;
console.log(multi
  ? `# Aggregates for ${runs.length} runs ended ${run.window.from === run.window.to ? `on ${run.window.from}` : `${run.window.from} to ${run.window.to}`}`
  : `# Aggregates for run ${runs[0].runId} (${runs[0].model})`);
console.log(`\n${all.length} messages: ${asked.length} asked, ${skipped.length} skipped.`);
console.log(`Weighted ${weighted(asked)} overall, ${weighted(asked.filter(answered))} on answered turns.`);
console.log(`Score distribution: ${[0, 1, 2, 3].map((s) => `${s} → ${asked.filter((r) => r.score === s).length}`).join(", ")}.`);

if (multi) {
  table("By run", ["Run", "Model", "Ended", "Messages", "Asked", "Skipped", "Answered", "Mean", "Weighted"], runs.map((x) => {
    const l = asked.filter((r) => r.runId === x.runId);
    return [x.runId, x.model, String(x.to).slice(0, 16), x.messages, l.length, x.messages - l.length,
      pct(l.filter(answered).length, l.length), mean(l), weighted(l)];
  }));
}

const byOutcome = {};
for (const r of asked) (byOutcome[outcome(r)] ??= []).push(r);
table("By outcome", ["Outcome", "n", "Mean score", "Mean time"],
  Object.entries(byOutcome).sort((a, b) => b[1].length - a[1].length).map(([k, l]) => [k, l.length, mean(l), avgS(l)]));

table("By question type", ["Type", "n", "Mean (all)", "Mean (answered)", "Weighted", "≥ 2", "No answer"],
  groupBy("category").map(([k, l]) => [k, l.length, mean(l), mean(l.filter(answered)), weighted(l),
    pct(l.filter((r) => r.score >= 2).length, l.length), l.filter((r) => !answered(r)).length]));

table("By persona", ["Persona", "n", "No answer", "Weighted (all)", "Weighted (answered)"],
  groupBy("persona").map(([k, l]) => [k, l.length, l.filter((r) => !answered(r)).length, weighted(l), weighted(l.filter(answered))]));

table("By access needed", ["Access", "n", "Weighted"], groupBy("access").map(([k, l]) => [k, l.length, weighted(l)]));
table("By answerability", ["Answerable", "n", "Mean", "Weighted"], groupBy("answerable").map(([k, l]) => [k, l.length, mean(l), weighted(l)]));
table("By grounding", ["Grounded", "n", "Mean", "Weighted"], groupBy("grounded").map(([k, l]) => [k, l.length, mean(l), weighted(l)]));

const recapped = asked.filter((r) => r.contextRecap);
if (recapped.length) {
  table("Recapped follow-ups (fresh session after a lost one)", ["", "n", "Mean", "Weighted"],
    [["recapped", recapped.length, mean(recapped), weighted(recapped)],
      ["other follow-ups", asked.filter((r) => !r.contextRecap && r.category === "follow-up").length,
        mean(asked.filter((r) => !r.contextRecap && r.category === "follow-up")),
        weighted(asked.filter((r) => !r.contextRecap && r.category === "follow-up"))]]);
}

const cats = groupBy("category").map(([k]) => k);
const pers = groupBy("persona").map(([k]) => k);
table("Question type × persona (count / mean)", ["", ...pers], cats.map((c) => [c, ...pers.map((p) => {
  const l = asked.filter((r) => r.category === c && r.persona === p);
  return l.length ? `${l.length} / ${mean(l).slice(0, 3)}` : "";
})]));

const models = [...new Set(asked.map((r) => r.model))];
if (models.length > 1) {
  table("Question type × model (count / mean)", ["", ...models], cats.map((c) => [c, ...models.map((m) => {
    const l = asked.filter((r) => r.category === c && r.model === m);
    return l.length ? `${l.length} / ${mean(l).slice(0, 3)}` : "";
  })]));
}

if (skipped.length) {
  const reasons = {};
  for (const r of skipped) reasons[r.skipReason] = (reasons[r.skipReason] ?? 0) + 1;
  table("Skipped (not asked, not scored)", ["Reason", "n"], Object.entries(reasons));
}

const flags = {};
for (const r of asked) for (const f of r.flags ?? []) flags[f] = (flags[f] ?? 0) + 1;
table("Flags", ["Flag", "n"], Object.entries(flags).sort((a, b) => b[1] - a[1]));

// Token-limit cascades: one line per session that hit the limit, "." ok, "T" limit, "x" other failure.
const sessions = {};
for (const r of all) (sessions[sessionKey(r)] ??= []).push(r);
const cascades = Object.entries(sessions).filter(([, l]) => l.some((r) => r.tokenLimit));
if (cascades.length) {
  console.log("\n### Sessions with a token limit (. answered, T token limit, t out of time, x failed, s skipped, R recapped)\n");
  for (const [, l] of cascades) {
    console.log(`- \`${multi ? `${l[0].runId} ` : ""}${String(l[0].session).slice(0, 8)}\` \`${l.map((r) => (r.skipReason ? "s" : r.tokenLimit ? "T" : !r.ok ? "x"
      : outOfTime(r) ? "t" : r.contextRecap ? "R" : ".")).join("")}\``);
  }
}

console.log("\n### Low scores on answered turns (for the findings)\n");
for (const r of asked.filter((r) => answered(r) && r.score <= 1)) {
  console.log(`- ${r.id}${multi ? ` (run ${r.runId})` : ""} [${r.category}/${r.persona}/${r.answerable}] ${r.question.slice(0, 90).replace(/\s+/g, " ")} :: ${r.verdict}`);
}
console.log("\n### Better than the reference\n");
for (const r of asked.filter((r) => r.flags?.includes("better-than-expected"))) {
  console.log(`- ${r.id}${multi ? ` (run ${r.runId})` : ""} [${r.category}] ${r.question.slice(0, 80).replace(/\s+/g, " ")} :: ${r.verdict}`);
}

// The report's appendix: grouped by run (in the order they ended), then by
// session, sessions and their messages in created_at order (the order the run
// asked them). Backfilled runs share one created_at, so the input order (id)
// breaks ties.
const byCreated = (a, b) => (runIndex.get(a.runId) ?? 0) - (runIndex.get(b.runId) ?? 0)
  || String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")) || a.id - b.id;
const sessionOrder = new Map();
for (const r of [...all].sort(byCreated)) if (!sessionOrder.has(sessionKey(r))) sessionOrder.set(sessionKey(r), sessionOrder.size);
const bySession = new Map();
for (const r of [...all].sort((a, b) => sessionOrder.get(sessionKey(a)) - sessionOrder.get(sessionKey(b)) || byCreated(a, b))) {
  if (!bySession.has(sessionKey(r))) bySession.set(sessionKey(r), []);
  bySession.get(sessionKey(r)).push(r);
}
const cell = (s) => String(s ?? "").replace(/\s+/g, " ").replace(/\|/g, "\\|");
const code = { answered: "ans", "out of time": "time", "token limit": "tok", "transport error": "net" };
const short = (s) => String(s).slice(0, 8);
const heading = (list) => `${multi ? `${list[0].runId} · ` : ""}${short(list[0].session)} · ${list.length} ${list.length === 1 ? "turn" : "turns"}`;
// GitHub-style anchor of a heading: lower case, punctuation dropped, spaces to hyphens.
const slug = (text) => text.toLowerCase().replace(/[^\w\- ]/g, "").replace(/ /g, "-");
const messageRow = (r, turn, of) => `| ${turn}/${of} | ${r.line ?? r.id} | ${r.askedAt?.slice(0, 10) ?? ""} | ${cell(r.question.slice(0, 120))} | `
  + (r.skipReason ? `| | | | skip | – | ${cell(r.skipReason)} |`
    : `${r.category} | ${r.persona} | ${[].concat(r.access).join(", ")} | ${r.answerable[0].toUpperCase()} | `
      + `${code[outcome(r)]}${r.contextRecap ? " R" : ""} | ${r.score} | ${cell(r.verdict)} |`);
// One row per session in the sessions table, each linking to its own message table below.
const appendix = [
  "### Sessions",
  "",
  `| ${multi ? "Run | Model | " : ""}Session | Turns | Asked | Mean score | Answered | Out of time | Token limit | Failed | Skipped |`,
  `|${multi ? "---|---|" : ""}---|---|---|---|---|---|---|---|---|`,
  ...[...bySession.values()].map((list) => {
    const asked = list.filter((r) => !r.skipReason);
    const n = (o) => asked.filter((r) => outcome(r) === o).length;
    const dates = list.map((r) => r.askedAt?.slice(0, 10) ?? "").sort();
    return `| ${multi ? `${list[0].runId} | ${list[0].model} | ` : ""}[${short(list[0].session)}](#${slug(heading(list))}) | ${list.length} | ${dates[0] === dates.at(-1) ? dates[0] : `${dates[0]} to ${dates.at(-1)}`} | `
      + `${mean(asked)} | ${n("answered")} | ${n("out of time")} | ${n("token limit")} | ${n("transport error")} | ${list.length - asked.length} |`;
  }),
  "",
  "### Messages by session",
  ...[...bySession.values()].flatMap((list) => [
    "",
    `#### ${heading(list)}`,
    "",
    "| Turn | # | Asked | Question | Type | Persona | Access | Ans. | Outcome | Score | Verdict |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...list.map((r, i) => messageRow(r, i + 1, list.length)),
  ]),
];
writeFileSync(join(dir, "appendix.md"), appendix.join("\n") + "\n");
console.log(`\nAppendix table written to ${join(dir, "appendix.md")}`);
