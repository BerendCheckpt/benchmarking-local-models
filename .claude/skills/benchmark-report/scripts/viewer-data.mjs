// Writes the viewer file for a report: everything the benchmark viewer's
// Results tab shows, in one JSON file next to the report.
//
//   node viewer-data.mjs <work dir> [--out <dir>]     (after aggregate.mjs)
//
// Output: <out>/run-<id>.viewer.json, or runs-<window>.viewer.json for a
// window (default out: reports). It holds customer names and order numbers,
// like the report, and stays local until upload-report.mjs sends it to the
// viewer on request.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mean, outcome, weighted } from "./outcome.mjs";

// What the viewer shows per message; nothing else leaves the work folder.
const FIELDS = ["id", "runId", "model", "line", "session", "askedAt", "createdAt", "question", "expected", "reply", "error",
  "ok", "skipReason", "contextRecap", "latencyS", "attachments", "category", "persona", "answerable", "score", "grounded",
  "verdict", "flags", "roleFit", "labelCheck"];

/** The viewer file's content from a work folder's run.json and rows.json. */
export function viewerData(run, rows) {
  const pick = (r) => Object.fromEntries(FIELDS.filter((f) => r[f] !== undefined).map((f) => [f, r[f]]));
  const out = rows.map((r) => ({ ...pick(r), outcome: r.skipReason ? "skipped" : outcome(r) }));
  const asked = rows.filter((r) => !r.skipReason && typeof r.score === "number");
  const outcomes = {};
  for (const r of out) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
  return {
    run,
    summary: {
      messages: rows.length, skipped: rows.filter((r) => r.skipReason).length,
      weighted: weighted(asked), mean: mean(asked), outcomes,
    },
    rows: out,
  };
}

/** The file name for a work folder's run.json: run-<id> or runs-<window>. */
export function viewerFileName(run) {
  const runs = run.runs ?? [run];
  const name = run.window || runs.length > 1 ? `runs-${run.name}` : `run-${runs[0].runId}`;
  if (!/^[\w.-]+$/.test(name)) throw new Error(`unexpected report name: ${name}`);
  return `${name}.viewer.json`;
}

function main(argv) {
  const dir = argv[0];
  if (!dir) throw new Error("usage: node viewer-data.mjs <work dir> [--out <dir>]");
  const at = argv.indexOf("--out");
  const outDir = at > 0 && argv[at + 1] ? argv[at + 1] : "reports";
  if (!existsSync(join(dir, "rows.json"))) throw new Error(`${join(dir, "rows.json")} is missing: run aggregate.mjs first`);
  const run = JSON.parse(readFileSync(join(dir, "run.json"), "utf8"));
  const rows = JSON.parse(readFileSync(join(dir, "rows.json"), "utf8"));
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, viewerFileName(run));
  const data = viewerData(run, rows);
  writeFileSync(file, JSON.stringify(data));
  console.log(`${file}: ${data.rows.length} messages, weighted ${data.summary.weighted}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); } catch (err) { console.error(err.message); process.exit(1); }
}
