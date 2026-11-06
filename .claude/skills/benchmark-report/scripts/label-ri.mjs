// For every item that names a label id (a labelizer generation call's
// "Target LabelId: <n>", or a question like "label id 103"), looks up that
// label's history in RetailerIntegration's ri.labelizer_generation_feedback:
// one query per distinct label id, nothing else. Deterministic: no model reads
// the rows. It writes, next to items.json:
//   labels.json  { labels: { <id>: { rows, retailers, shared, error? } },
//                  items: [{ itemId, labelId, source, askedAt, summary, pdfMatch }] }
//   labels.md    the "Label details" section, spliced into the report by
//                assemble-report.mjs
// and adds each item's summary to the chunk items as `labelFeedback` for the
// judges. aggregate.mjs prints the per-label summary table from labels.json.
//
//   node label-ri.mjs <work dir>      (after export-run.mjs, before judging)
//
// CreatedBy is replaced by a pseudonym (User 1, User 2, ...) as soon as a row
// is read, so a real name is never written, printed or given to a judge.
//
// Connection: RI_PGHOST, RI_PGPORT, RI_PGDATABASE, RI_PGUSER, RI_PGPASSWORD and
// optional RI_PGSSLMODE (disable | require | verify-full), from the environment
// or the repo's .env.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { labelRefs } from "../../../../labels.mjs";

export { labelRefs };

/** ssl option for pg from a libpq-style sslmode. */
export function sslOption(mode) {
  switch ((mode ?? "").toLowerCase()) {
    case "": case "disable": return false;
    case "require": return { rejectUnauthorized: false }; // libpq "require": encrypted, not verified
    case "verify-ca": case "verify-full": return true;
    default: throw new Error(`RI_PGSSLMODE: unknown mode ${mode}`);
  }
}

/** Read-only access to ri.labelizer_generation_feedback. */
export class LabelFeedbackRepository {
  constructor(env = process.env) {
    const need = ["RI_PGHOST", "RI_PGDATABASE", "RI_PGUSER", "RI_PGPASSWORD"].filter((k) => !env[k]);
    if (need.length) throw new Error(`set ${need.join(", ")} (in the environment or .env)`);
    // Every setting explicit, so pg never falls back to the benchmark's own PG* variables.
    this.pool = new pg.Pool({
      host: env.RI_PGHOST, port: Number(env.RI_PGPORT || 5432), database: env.RI_PGDATABASE,
      user: env.RI_PGUSER, password: env.RI_PGPASSWORD, ssl: sslOption(env.RI_PGSSLMODE), max: 2,
    });
    this.pool.on("error", (err) => console.error(`[ri] idle connection lost: ${err.message}`));
  }

  async byLabelId(labelId) {
    const { rows } = await this.pool.query(
      `select "Kind", "RetailerId", "CreatedBy", "CreatedAt", "Payload"->>'pdfFilename' as pdf, "Payload"->>'pdfHash' as hash
       from ri.labelizer_generation_feedback
       where "LabelId" = $1
       order by "CreatedAt"`,
      [labelId],
    );
    return rows;
  }

  end() {
    return this.pool.end();
  }
}

/** Stable pseudonyms for CreatedBy: User 1, User 2, ... in the order first seen. Case-insensitive. */
export class Pseudonyms {
  #map = new Map();
  of(name) {
    if (name === null || name === undefined || name === "") return "";
    const key = String(name).toLowerCase();
    if (!this.#map.has(key)) this.#map.set(key, `User ${this.#map.size + 1}`);
    return this.#map.get(key);
  }
  /** The rows with CreatedBy pseudonymised; nothing else changes. */
  rows(rows) {
    return rows.map((r) => ({ ...r, CreatedBy: this.of(r.CreatedBy) }));
  }
}

const MINUTE = 60_000;
const isCorrection = (r) => /correction/i.test(r.Kind ?? "");
const isGeneration = (r) => /generation/i.test(r.Kind ?? "");

/**
 * A label's RI history relative to one question (askedAt, ISO), without
 * CreatedBy: what the judges and the label table get. Times in minutes;
 * null where askedAt or the event is missing.
 */
export function feedbackSummary(rows, askedAt) {
  const at = (r) => new Date(r.CreatedAt).getTime();
  const asked = askedAt ? new Date(askedAt).getTime() : NaN;
  const known = !Number.isNaN(asked);
  const count = (list, pred) => list.filter(pred).length;
  const before = known ? rows.filter((r) => at(r) < asked) : [];
  const after = known ? rows.filter((r) => at(r) >= asked) : [];
  const nextCorrection = after.filter(isCorrection).map(at).sort((a, b) => a - b)[0];
  const firstGeneration = rows.filter(isGeneration).map(at).sort((a, b) => a - b)[0];
  const firstCorrection = rows.filter(isCorrection).map(at).filter((t) => !firstGeneration || t >= firstGeneration).sort((a, b) => a - b)[0];
  return {
    generations: count(rows, isGeneration),
    corrections: count(rows, isCorrection),
    askedAt: askedAt ?? null,
    before: known ? { generations: count(before, isGeneration), corrections: count(before, isCorrection) } : null,
    after: known ? { generations: count(after, isGeneration), corrections: count(after, isCorrection) } : null,
    minutesToNextCorrection: known && nextCorrection ? Math.round((nextCorrection - asked) / MINUTE) : null,
    minutesGenerationToFirstCorrection: firstGeneration && firstCorrection ? Math.round((firstCorrection - firstGeneration) / MINUTE) : null,
    first: rows.length ? rows[0].CreatedAt : null,
    last: rows.length ? rows.at(-1).CreatedAt : null,
  };
}

const sameHash = (a, b) => {
  const x = String(a ?? "").toLowerCase(), y = String(b ?? "").toLowerCase();
  return x.length >= 8 && y.length >= 8 && (x.startsWith(y) || y.startsWith(x));
};

/**
 * Facts about one label id's rows: the retailers it has rows for, and whether
 * the id looks shared by more than one label (rows for several retailers, or
 * generations from different PDFs). PDFs are told apart by file name: a
 * re-export of the same artwork has a new hash but keeps its name.
 */
export function labelFacts(rows) {
  const retailers = [...new Set(rows.map((r) => r.RetailerId).filter((v) => v !== null && v !== undefined))].sort((a, b) => a - b);
  const pdfs = new Set(rows.filter(isGeneration).map((r) => String(r.pdf || r.hash || "").toLowerCase()).filter(Boolean));
  return { retailers, shared: retailers.length > 1 || pdfs.size > 1 };
}

/**
 * Does the PDF sent with the item match what RI generated the label from?
 * Compared by hash; the file name is a fallback signal only.
 */
export function pdfMatch(attachments, rows) {
  const pdfs = (attachments ?? []).filter((a) => /pdf/i.test(a.contentType ?? "") || /\.pdf$/i.test(a.fileName ?? a.name ?? ""));
  if (!pdfs.length) return "no attachment";
  const gens = rows.filter(isGeneration);
  if (!gens.length) return "no RI generation";
  if (pdfs.some((a) => gens.some((g) => sameHash(a.sha256, g.hash)))) return "match";
  const name = (s) => String(s ?? "").toLowerCase();
  if (pdfs.some((a) => gens.some((g) => g.pdf && name(g.pdf) === name(a.fileName ?? a.name)))) return "name only";
  return "different PDF";
}

/** Adds `labelFeedback` (summary, shared, pdfMatch; no rows) to every chunk item that names a label id, for the judges. */
function annotateChunks(dir, labels, items) {
  const byItem = new Map();
  for (const l of items) {
    const facts = labels[l.labelId];
    (byItem.get(l.itemId) ?? byItem.set(l.itemId, []).get(l.itemId)).push(facts.error
      ? { labelId: l.labelId, source: l.source, error: facts.error }
      : { labelId: l.labelId, source: l.source, retailers: facts.retailers, shared: facts.shared, pdfMatch: l.pdfMatch, ...l.summary });
  }
  for (const f of readdirSync(dir).filter((f) => /^chunk\d+\.json$/.test(f))) {
    const chunk = JSON.parse(readFileSync(join(dir, f), "utf8"));
    let changed = false;
    for (const it of chunk) if (byItem.has(it.id)) { it.labelFeedback = byItem.get(it.id); changed = true; }
    if (changed) writeFileSync(join(dir, f), JSON.stringify(chunk, null, 1));
  }
}

const mdCell = (v) => String(v ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

/** The report's "Label details" section: per label id, its rows once (pseudonymised), then the PDF check per item. */
export function labelsMarkdown(labels, items) {
  const out = [];
  const ids = Object.keys(labels);
  const itemsOf = (id) => items.filter((l) => l.labelId === id).map((l) => `#${l.itemId}`);
  out.push("| Label id | Items | Retailers | Generations | Corrections | Shared |", "|---|---|---|---|---|---|");
  for (const id of ids) {
    const f = labels[id];
    if (f.error) { out.push(`| ${id} | ${itemsOf(id).join(", ")} | error: ${mdCell(f.error)} | | | |`); continue; }
    out.push(`| ${id} | ${itemsOf(id).join(", ")} | ${f.retailers.join(", ") || "–"} | ${f.rows.filter(isGeneration).length} | ${f.rows.filter(isCorrection).length} | ${f.shared ? "yes" : "no"} |`);
  }
  out.push("", "PDF sent with the message against the PDF RI generated the label from (by hash):", "");
  out.push("| Item | Label id | PDF match |", "|---|---|---|");
  for (const l of items) out.push(`| #${l.itemId} | ${l.labelId} | ${l.pdfMatch} |`);
  for (const id of ids) {
    const f = labels[id];
    if (f.error) continue;
    out.push("", `#### Label ${id} (${itemsOf(id).join(", ")})`, "");
    if (!f.rows.length) { out.push("No rows."); continue; }
    out.push("| Retailer | Kind | CreatedBy | CreatedAt | PDF | Hash |", "|---|---|---|---|---|---|");
    for (const r of f.rows) {
      const at = r.CreatedAt instanceof Date ? r.CreatedAt.toISOString() : String(r.CreatedAt ?? "");
      out.push(`| ${r.RetailerId ?? ""} | ${mdCell(r.Kind)} | ${mdCell(r.CreatedBy)} | ${at.slice(0, 19)} | ${mdCell(r.pdf)} | ${String(r.hash ?? "").slice(0, 12)} |`);
    }
  }
  return out.join("\n") + "\n";
}

/**
 * Looks up every label id the items name: one query per distinct id, rows
 * pseudonymised at once. A failed query is logged and recorded; the others run.
 * `repo` needs only byLabelId(id); returns { labels, items }.
 */
export async function collectLabels(items, repo, pseudonyms = new Pseudonyms()) {
  const wanted = items.flatMap((it) => labelRefs(it.question).map((ref) => ({ item: it, ...ref })));
  const labels = {};
  for (const { labelId } of wanted) {
    if (labels[labelId]) continue;
    try {
      const rows = pseudonyms.rows(await repo.byLabelId(labelId));
      labels[labelId] = { rows, ...labelFacts(rows) };
    } catch (err) {
      console.error(`[ri] label ${labelId}: ${err.message}`);
      labels[labelId] = { error: err.message };
    }
  }
  const out = wanted.map(({ item, labelId, source }) => {
    const f = labels[labelId];
    return {
      itemId: item.id, labelId, source, askedAt: item.askedAt ?? null,
      ...(f.rows ? { summary: feedbackSummary(f.rows, item.askedAt ?? null), pdfMatch: pdfMatch(item.attachments, f.rows) } : {}),
    };
  });
  return { labels, items: out };
}

async function main(dir) {
  if (!dir) throw new Error("usage: node label-ri.mjs <work dir>");
  if (existsSync(".env")) process.loadEnvFile(".env");
  const items = JSON.parse(readFileSync(join(dir, "items.json"), "utf8"));
  if (!items.some((it) => labelRefs(it.question).length)) {
    writeFileSync(join(dir, "labels.json"), JSON.stringify({ labels: {}, items: [] }));
    writeFileSync(join(dir, "labels.md"), "No item names a label id.\n");
    console.log("no item names a label id; labels.json is empty");
    return;
  }
  const repo = new LabelFeedbackRepository();
  let got;
  try {
    got = await collectLabels(items, repo);
  } finally {
    await repo.end();
  }
  writeFileSync(join(dir, "labels.json"), JSON.stringify(got, null, 1));
  writeFileSync(join(dir, "labels.md"), labelsMarkdown(got.labels, got.items));
  annotateChunks(dir, got.labels, got.items);
  const failed = Object.values(got.labels).filter((l) => l.error).length;
  console.log(`${got.items.length} item label(s), ${Object.keys(got.labels).length} distinct label id(s), ${failed} failed; written to ${join(dir, "labels.json")} and labels.md`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2]).catch((err) => { console.error(err.message); process.exit(1); });
}
