// Postgres access. Connection settings come from the standard PG* env vars.
import pg from "pg";

const TABLE = "benchmark_results.rsults";
const pool = new pg.Pool();

export async function ensureSchema() {
  await pool.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS model text`);
}

export async function insertResult(r, model, runId) {
  await pool.query(
    `INSERT INTO ${TABLE}
       (run_id, prompt, expected_answer, latency_ms, ok, reply, error, "sessionId",
        "costUsd", turns, tools, "toolCalls", proposals, "deltaChars", model)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [runId, r.prompt, r.expected_answer, r.latency_ms, r.ok, r.reply, r.error || null, r.sessionId,
      r.costUsd, r.turns, r.tools, r.toolCalls, r.proposals, r.deltaChars, model],
  );
}
