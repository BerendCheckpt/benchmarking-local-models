// Exports one benchmark run from benchmark_results.rsults to items.json and
// judging chunks, joined with the input file for the original session and date.
//
//   node export-run.mjs [--run <run_id>] [--input <file.jsonl>] [--out <dir>] [--chunks 5]
//
// Without --run it takes the most recent run. Postgres is reached through
// `docker exec` (PG_CONTAINER, PG_USER, PG_DB; defaults postgres / n8n / n8n).
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, a, i, all) => {
  if (a.startsWith("--")) pairs.push([a.slice(2), all[i + 1]]);
  return pairs;
}, []));

const container = process.env.PG_CONTAINER || "postgres";
const psql = (sql) => execFileSync("docker", [
  "exec", "-i", container, "psql", "-U", process.env.PG_USER || "n8n", "-d", process.env.PG_DB || "n8n",
  "-v", "ON_ERROR_STOP=1", "-tA", "-c", sql,
], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).trim();

const runId = args.run ? Number(args.run) : Number(psql("SELECT max(run_id) FROM benchmark_results.rsults"));
if (!Number.isInteger(runId)) throw new Error(`not a run id: ${args.run}`);

// Insertion order (created_at, then ctid for backfilled rows that share a
// timestamp) is the order the run asked the messages in.
const rows = JSON.parse(psql(`
  SELECT coalesce(json_agg(t ORDER BY t.n), '[]') FROM (
    SELECT row_number() OVER (ORDER BY created_at, ctid)::int AS n, created_at AS ts, model, "sessionId", prompt, expected_answer, reply, ok,
           token_limit, skip_reason, context_recap, error, latency_ms, tools, "toolCalls", turns
    FROM benchmark_results.rsults WHERE run_id = ${runId}
  ) t`));
if (!rows.length) throw new Error(`run ${runId} has no rows`);

// Each input line is matched to the first unused row with the same question and
// expected answer; the row order alone is not reliable (the 2026-10-30 backfill
// rewrote the old rows). With an input file the id is the line number. Identical
// turns within a session can only be told apart by insertion time, so in
// backfilled runs two such turns may swap.
let pairs = rows.map((r) => ({ r, line: null }));
if (args.input) {
  const lines = readFileSync(args.input, "utf8").split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
  const used = new Set();
  pairs = lines.map((line) => {
    const j = rows.findIndex((r, k) => !used.has(k) && r.prompt === line.question && r.expected_answer === (line.answer ?? ""));
    if (j < 0) throw new Error(`${args.input} does not match run ${runId}: no row for "${line.question.slice(0, 60)}"`);
    used.add(j);
    return { r: rows[j], line };
  });
  if (used.size !== rows.length) throw new Error(`run ${runId} has ${rows.length - used.size} rows that are not in ${args.input}`);
}

const items = pairs.map(({ r, line }, i) => ({
  id: i + 1,
  createdAt: r.ts,
  seq: r.n, // insertion order; breaks created_at ties in backfilled runs
  session: line?.session ?? r.sessionId,
  askedAt: line?.askedAt ?? null,
  needs: line?.needs ?? null,
  question: r.prompt,
  expected: r.expected_answer,
  reply: r.reply,
  ok: r.ok,
  tokenLimit: r.token_limit,
  skipReason: r.skip_reason ?? "",
  contextRecap: !!r.context_recap,
  error: r.error ?? "",
  latencyS: Math.round(r.latency_ms / 1000),
  tools: r.tools ?? [],
  toolCalls: r.toolCalls,
}));

const out = args.out || join("reports", "work", String(runId));
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "items.json"), JSON.stringify(items, null, 1));
writeFileSync(join(out, "run.json"), JSON.stringify({ runId, model: rows[0].model, input: args.input ?? null,
  from: rows[0].ts, to: rows.at(-1).ts, messages: rows.length }, null, 1));

// Skipped messages were never asked, so they are not judged.
const toJudge = items.filter((it) => !it.skipReason);
const n = Math.max(1, Number(args.chunks) || 5);
const size = Math.ceil(toJudge.length / n);
for (let c = 0; c < n; c++) {
  writeFileSync(join(out, `chunk${c + 1}.json`), JSON.stringify(toJudge.slice(c * size, (c + 1) * size), null, 1));
}
console.log(JSON.stringify({ runId, model: rows[0].model, messages: items.length,
  skipped: items.length - toJudge.length, chunks: n, out }));
