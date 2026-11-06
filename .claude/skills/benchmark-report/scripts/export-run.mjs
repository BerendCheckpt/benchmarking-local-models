// Exports benchmark runs from benchmark_results.rsults to items.json and
// judging chunks, joined with each run's input file for the original session
// and date.
//
//   node export-run.mjs [--run <run_id>] [--input <file.jsonl>] [--out <dir>] [--chunks 5]
//   node export-run.mjs --today [--out <dir>] [--chunks 5]
//   node export-run.mjs --from 2026-10-28 --to 2026-11-02 [--out <dir>] [--chunks 5]
//
// Without --run, --today or --from/--to it takes the most recent run. --today
// and --from/--to take every run that ended in that window (local dates, both
// ends inclusive): its last message was saved in it. A run that is still going
// is left out. Each run's input file is found in INPUT_DIR unless --input is
// given (single run only). Postgres is reached through `docker exec`
// (PG_CONTAINER, PG_USER, PG_DB; defaults postgres / n8n / n8n).
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { matchByLine } from "./match.mjs";

const INPUT_DIR = process.env.INPUT_DIR || "C:\\Users\\hulshofb\\Documents\\Benchmark tests local models";
const BENCH_URL = process.env.BENCH_URL || "http://127.0.0.1:4202";

const flags = new Set(["today"]);
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, a, i, all) => {
  if (a.startsWith("--")) pairs.push([a.slice(2), flags.has(a.slice(2)) ? true : all[i + 1]]);
  return pairs;
}, []));

const container = process.env.PG_CONTAINER || "postgres";
const psql = (sql) => execFileSync("docker", [
  "exec", "-i", container, "psql", "-U", process.env.PG_USER || "n8n", "-d", process.env.PG_DB || "n8n",
  "-v", "ON_ERROR_STOP=1", "-tA", "-c", sql,
], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).trim();

// A local date (YYYY-MM-DD) as the instant its day starts, `days` later.
function localDay(text, days = 0) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text ?? "");
  if (!m) throw new Error(`not a date (YYYY-MM-DD): ${text}`);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days);
}
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// The app's run id is the start in Unix seconds, so while a run is going the
// newest run id is that run.
async function runningRunId() {
  try {
    const { run } = await (await fetch(`${BENCH_URL}/api/status`)).json();
    if (run?.state !== "running") return null;
  } catch {
    console.error(`could not read ${BENCH_URL}/api/status; assuming no run is going`);
    return null;
  }
  return Number(psql("SELECT max(run_id) FROM benchmark_results.rsults"));
}

let window = null;
let runIds;
if (args.today || args.from || args.to) {
  const today = isoDay(new Date());
  const from = args.today ? today : args.from ?? args.to;
  const to = args.today ? today : args.to ?? args.from;
  const start = localDay(from), end = localDay(to, 1);
  if (end <= start) throw new Error(`--from ${from} is after --to ${to}`);
  if (args.input || args.run) throw new Error("--input and --run only go with a single run, not with a date window");
  window = { from, to };
  const running = await runningRunId();
  runIds = psql(`
    SELECT run_id FROM benchmark_results.rsults GROUP BY run_id
    HAVING max(created_at) >= '${start.toISOString()}' AND max(created_at) < '${end.toISOString()}'
    ORDER BY max(created_at), run_id`).split("\n").filter(Boolean).map(Number).filter((id) => id !== running);
  if (running) console.error(`run ${running} is still going and is left out`);
  if (!runIds.length) throw new Error(`no run ended between ${from} and ${to}`);
} else {
  const id = args.run ? Number(args.run) : Number(psql("SELECT max(run_id) FROM benchmark_results.rsults"));
  if (!Number.isInteger(id)) throw new Error(`not a run id: ${args.run}`);
  runIds = [id];
}

const readLines = (file) => readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));

// Each input line is matched to the first unused row with the same question and
// expected answer; the row order alone is not reliable (the 2026-10-30 backfill
// rewrote the old rows). Identical turns within a session can only be told
// apart by insertion time, so in backfilled runs two such turns may swap.
// Returns null when the file does not line up with the run. A run that was
// stopped early matches the first lines of its file.
function match(rows, lines, { partial = false } = {}) {
  if (partial ? lines.length < rows.length : lines.length !== rows.length) return null;
  lines = lines.slice(0, rows.length);
  const used = new Set();
  const pairs = [];
  for (const [i, line] of lines.entries()) {
    const j = rows.findIndex((r, k) => !used.has(k) && r.prompt === line.question && r.expected_answer === (line.answer ?? ""));
    if (j < 0) return null;
    used.add(j);
    pairs.push({ r: rows[j], line, lineNo: i + 1 });
  }
  return pairs;
}

// The input file a run was started with: the one whose every line matches a
// row. A .tagged.jsonl variant wins over its plain twin. A run stopped early
// matches the start of many files (they share their first questions), so it
// takes the newest file that already existed when the run started (the run id
// is its start in Unix seconds).
function findInput(rows, runId) {
  const files = readdirSync(INPUT_DIR).filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ path: join(INPUT_DIR, f), tagged: f.includes(".tagged."), mtime: statSync(join(INPUT_DIR, f)).mtimeMs }))
    .sort((a, b) => b.tagged - a.tagged || b.mtime - a.mtime);
  // A run of chosen messages (input_line saved) matches by line number.
  if (rows.every((r) => Number.isInteger(r.input_line))) {
    for (const f of files) {
      const lines = readLines(f.path);
      const pairs = matchByLine(rows, lines);
      if (pairs) return { input: f.path, partial: false, pairs, of: lines.length };
    }
  }
  for (const f of files) {
    const pairs = match(rows, readLines(f.path));
    if (pairs) return { input: f.path, partial: false, pairs };
  }
  const started = runId > 1e9 ? runId * 1000 : Infinity;
  for (const f of files.filter((f) => f.mtime <= started).sort((a, b) => b.mtime - a.mtime || b.tagged - a.tagged)) {
    const pairs = match(rows, readLines(f.path), { partial: true });
    if (pairs) return { input: f.path, partial: true, pairs };
  }
  return { input: null, partial: false, pairs: rows.map((r) => ({ r, line: null })) };
}

const runs = [];
const items = [];
for (const runId of runIds) {
  // Insertion order (created_at, then ctid for backfilled rows that share a
  // timestamp) is the order the run asked the messages in.
  const rows = JSON.parse(psql(`
    SELECT coalesce(json_agg(t ORDER BY t.n), '[]') FROM (
      SELECT row_number() OVER (ORDER BY created_at, ctid)::int AS n, created_at AS ts, model, "sessionId", prompt, expected_answer, reply, ok,
             token_limit, skip_reason, context_recap, error, latency_ms, tools, "toolCalls", turns,
             to_jsonb(r) -> 'attachments' AS attachments, -- null on rows from before the column existed
             (to_jsonb(r) ->> 'input_line')::int AS input_line
      FROM benchmark_results.rsults r WHERE run_id = ${runId}
    ) t`));
  if (!rows.length) throw new Error(`run ${runId} has no rows`);

  let found;
  if (args.input) {
    const lines = readLines(args.input);
    const byLine = matchByLine(rows, lines);
    const pairs = byLine ?? match(rows, lines) ?? match(rows, lines, { partial: true });
    if (!pairs) throw new Error(`${args.input} does not match run ${runId}`);
    found = byLine ? { input: args.input, partial: false, pairs, of: lines.length }
      : { input: args.input, partial: lines.length > rows.length, pairs };
  } else {
    found = findInput(rows, runId);
    if (!found.input) console.error(`run ${runId}: no input file in ${INPUT_DIR} matches; sessions and dates come from the rows only`);
  }

  // selection: a run of messages chosen on the selection page, out of the file's lines.
  const selection = found.of && found.of > rows.length ? { asked: rows.length, of: found.of } : null;
  runs.push({ runId, model: rows[0].model, input: found.input, partial: found.partial, selection,
    from: rows[0].ts, to: rows.at(-1).ts, messages: rows.length });
  // id numbers the items across all runs, in run order and then input order.
  for (const { r, line, lineNo } of found.pairs) {
    items.push({
      id: items.length + 1,
      runId,
      model: r.model,
      line: line ? lineNo : null,
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
      attachments: r.attachments ?? [], // file metadata only: name, type, bytes, sha256
    });
  }
}

const name = window ? (window.from === window.to ? window.from : `${window.from}_${window.to}`) : String(runIds[0]);
const out = args.out || join("reports", "work", name);
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "items.json"), JSON.stringify(items, null, 1));
writeFileSync(join(out, "run.json"), JSON.stringify({ name, window, runs }, null, 1));

// Skipped messages were never asked, so they are not judged.
const toJudge = items.filter((it) => !it.skipReason);
const n = Math.max(1, Number(args.chunks) || 5);
const size = Math.ceil(toJudge.length / n);
for (let c = 0; c < n; c++) {
  writeFileSync(join(out, `chunk${c + 1}.json`), JSON.stringify(toJudge.slice(c * size, (c + 1) * size), null, 1));
}
console.log(JSON.stringify({ name, runs: runs.map(({ runId, model, input, partial, messages }) => ({ runId, model, input, partial, messages })),
  messages: items.length, skipped: items.length - toJudge.length, chunks: n, out }));
