// Splices the generated tables into a written report, so they are never read
// or retyped by the model:
//   <!-- label-details -->  ->  <work dir>/labels.md   (label-ri.mjs)
//   <!-- appendix -->       ->  <work dir>/appendix.md (aggregate.mjs)
//
//   node assemble-report.mjs <report.md> <work dir>
//
// Refuses when a marker is missing (or its file is), and leaves the report as
// it was. Running it twice is safe: the markers are gone after the first run.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const MARKERS = { "<!-- label-details -->": "labels.md", "<!-- appendix -->": "appendix.md" };

/** The report text with every marker replaced by its file's content. Throws on a missing marker or file. */
export function assemble(report, dir, read = (p) => readFileSync(p, "utf8"), exists = existsSync) {
  let out = report;
  for (const [marker, file] of Object.entries(MARKERS)) {
    if (!out.includes(marker)) throw new Error(`marker ${marker} is missing from the report`);
    const path = join(dir, file);
    if (!exists(path)) throw new Error(`${path} is missing: run ${file === "labels.md" ? "label-ri.mjs" : "aggregate.mjs"} first`);
    out = out.replace(marker, () => read(path).trimEnd());
  }
  return out.endsWith("\n") ? out : out + "\n";
}

function main(reportPath, dir) {
  if (!reportPath || !dir) throw new Error("usage: node assemble-report.mjs <report.md> <work dir>");
  const report = readFileSync(reportPath, "utf8");
  writeFileSync(reportPath, assemble(report, dir));
  console.log(`assembled ${reportPath} from ${dir}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv[2], process.argv[3]); } catch (err) { console.error(err.message); process.exit(1); }
}
