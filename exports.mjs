// The stored Hanuman messages a benchmark is chosen from (benchmark_results.hanuman_exports).
// A JSONL file is uploaded into it once; a run is then picked by question date.
import { createHash, randomUUID } from "node:crypto";

const TABLE = "benchmark_results.hanuman_exports";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const badRequest = (message) => Object.assign(new Error(message), { statusCode: 400 });

/** An askedAt as ISO, or null when it is missing or not a date. */
export function isoOrNull(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * What makes a message unique: its session, question date and question. A line
 * with neither a session nor a date falls back to its question and answer.
 */
export function dedupKey({ session = null, askedAt = null, question, answer = "" }) {
  const at = isoOrNull(askedAt);
  const parts = session || at ? ["s", session ?? null, at, question] : ["q", question, answer ?? ""];
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/**
 * The order a run asks them in: sessions by their first question date, then
 * each session's messages by date (upload order breaks ties). A message
 * without a session stands alone.
 */
export function orderForRun(rows) {
  const time = (r) => (r.askedAt ? Date.parse(r.askedAt) : Infinity);
  const byTurn = (a, b) => time(a) - time(b) || (a.seq ?? 0) - (b.seq ?? 0);
  const groups = new Map();
  for (const r of rows) {
    const key = r.session ?? Symbol(r.id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return [...groups.values()].map((g) => g.sort(byTurn)).sort((a, b) => byTurn(a[0], b[0])).flat();
}

/** A table row as the benchmark's rows look (the shape parseJsonl gives, plus id). */
function toRow(r) {
  return {
    id: r.id, session: r.session, question: r.question, answer: r.answer ?? "", needs: r.needs ?? null,
    askedAt: r.asked_at ? new Date(r.asked_at).toISOString() : null, line: null, seq: Number(r.seq),
    ...(r.context ? { context: true } : {}),
  };
}

export class ExportsRepository {
  /** `db` is anything with pg's `query(sql, params)`. */
  constructor(db) { this.db = db; }

  async ensure() {
    await this.db.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (
      id uuid PRIMARY KEY,
      seq bigint GENERATED ALWAYS AS IDENTITY,
      session text,
      question text NOT NULL,
      answer text NOT NULL DEFAULT '',
      needs jsonb,
      asked_at timestamptz,
      dedup_key text NOT NULL UNIQUE,
      uploaded_at timestamptz NOT NULL DEFAULT now())`);
    await this.db.query(`CREATE INDEX IF NOT EXISTS hanuman_exports_asked_at ON ${TABLE} (asked_at)`);
  }

  /**
   * Stores parsed JSONL rows; one already stored (same dedupKey) is left alone.
   * Each insert has its own error handling, so one bad line doesn't stop the rest.
   */
  async insertMany(rows) {
    const counts = { inserted: 0, duplicates: 0, failed: 0, withoutAskedAt: 0 };
    for (const row of rows) {
      const askedAt = isoOrNull(row.askedAt);
      if (!askedAt) counts.withoutAskedAt++;
      try {
        const { rowCount } = await this.db.query(
          `INSERT INTO ${TABLE} (id, session, question, answer, needs, asked_at, dedup_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (dedup_key) DO NOTHING`,
          [randomUUID(), row.session ?? null, row.question, row.answer ?? "",
            row.needs ? JSON.stringify(row.needs) : null, askedAt, dedupKey(row)],
        );
        if (rowCount) counts.inserted++; else counts.duplicates++;
      } catch (err) {
        counts.failed++;
        console.error(`[exports] could not store line ${row.line ?? "?"}: ${err.message}`);
      }
    }
    return counts;
  }

  /**
   * The messages asked in [from, to), plus the earlier turns of their sessions
   * (marked `context`), in run order.
   */
  async findRange(from, to) {
    const start = isoOrNull(from), end = isoOrNull(to);
    if (!start || !end) throw badRequest("from and to must be dates");
    if (start >= end) throw badRequest("from must be before to");
    const { rows } = await this.db.query(
      `WITH hit AS (SELECT DISTINCT session FROM ${TABLE}
                    WHERE asked_at >= $1 AND asked_at < $2 AND session IS NOT NULL)
       SELECT id, seq, session, question, answer, needs, asked_at, asked_at < $1 AS context FROM ${TABLE}
       WHERE (asked_at >= $1 AND asked_at < $2)
          OR (asked_at < $1 AND session IN (SELECT session FROM hit))`,
      [start, end],
    );
    return orderForRun(rows.map(toRow));
  }

  /** The chosen messages, in run order. Throws a 400 for a bad or unknown id. */
  async findByIds(ids) {
    if (!Array.isArray(ids) || !ids.length || !ids.every((id) => typeof id === "string" && UUID.test(id))) {
      throw badRequest("ids must be a non-empty list of message ids");
    }
    const wanted = [...new Set(ids)];
    const { rows } = await this.db.query(
      `SELECT id, seq, session, question, answer, needs, asked_at FROM ${TABLE} WHERE id = ANY($1::uuid[])`, [wanted],
    );
    if (rows.length !== wanted.length) {
      const known = new Set(rows.map((r) => r.id));
      throw badRequest(`unknown message id ${wanted.filter((id) => !known.has(id)).join(", ")}`);
    }
    return orderForRun(rows.map(toRow));
  }
}
