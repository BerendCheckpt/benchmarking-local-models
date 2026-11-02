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

const run = read("run.json");
const asked = rows;
console.log(`# Aggregates for run ${run.runId} (${run.model})`);
console.log(`\n${all.length} messages: ${asked.length} asked, ${skipped.length} skipped.`);
console.log(`Weighted ${weighted(asked)} overall, ${weighted(asked.filter(answered))} on answered turns.`);
console.log(`Score distribution: ${[0, 1, 2, 3].map((s) => `${s} → ${asked.filter((r) => r.score === s).length}`).join(", ")}.`);

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
for (const r of all) (sessions[r.session] ??= []).push(r);
const cascades = Object.entries(sessions).filter(([, l]) => l.some((r) => r.tokenLimit));
if (cascades.length) {
  console.log("\n### Sessions with a token limit (. answered, T token limit, t out of time, x failed, s skipped, R recapped)\n");
  for (const [s, l] of cascades) {
    console.log(`- \`${String(s).slice(0, 8)}\` \`${l.map((r) => (r.skipReason ? "s" : r.tokenLimit ? "T" : !r.ok ? "x"
      : outOfTime(r) ? "t" : r.contextRecap ? "R" : ".")).join("")}\``);
  }
}

console.log("\n### Low scores on answered turns (for the findings)\n");
for (const r of asked.filter((r) => answered(r) && r.score <= 1)) {
  console.log(`- ${r.id} [${r.category}/${r.persona}/${r.answerable}] ${r.question.slice(0, 90).replace(/\s+/g, " ")} :: ${r.verdict}`);
}
console.log("\n### Better than the reference\n");
for (const r of asked.filter((r) => r.flags?.includes("better-than-expected"))) {
  console.log(`- ${r.id} [${r.category}] ${r.question.slice(0, 80).replace(/\s+/g, " ")} :: ${r.verdict}`);
}

// The report's appendix, one row per message in the order they were asked.
const cell = (s) => String(s ?? "").replace(/\s+/g, " ").replace(/\|/g, "\\|");
const code = { answered: "ans", "out of time": "time", "token limit": "tok", "transport error": "net" };
const appendix = [
  "| # | Session | Asked | Question | Type | Persona | Access | Ans. | Outcome | Score | Verdict |",
  "|---|---|---|---|---|---|---|---|---|---|---|",
  ...all.map((r) => `| ${r.id} | \`${String(r.session).slice(0, 8)}\` | ${r.askedAt?.slice(0, 10) ?? ""} | ${cell(r.question.slice(0, 120))} | `
    + (r.skipReason ? `| | | | skip | – | ${cell(r.skipReason)} |`
      : `${r.category} | ${r.persona} | ${[].concat(r.access).join(", ")} | ${r.answerable[0].toUpperCase()} | `
        + `${code[outcome(r)]}${r.contextRecap ? " R" : ""} | ${r.score} | ${cell(r.verdict)} |`)),
];
writeFileSync(join(dir, "appendix.md"), appendix.join("\n") + "\n");
console.log(`\nAppendix table written to ${join(dir, "appendix.md")}`);
