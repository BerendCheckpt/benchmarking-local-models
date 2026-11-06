// Postgres access. Connection settings come from the standard PG* env vars.
import pg from "pg";

const TABLE = "benchmark_results.rsults";
const pool = new pg.Pool();
// An idle connection dropped by the server is emitted here; without a listener
// Node treats it as unhandled and the whole app exits. The next query reconnects.
pool.on("error", (err) => console.error(`[db] idle connection lost: ${err.message}`));

export async function ensureSchema() {
  // A fresh database (the spark stack's own Postgres) has neither; the n8n one
  // already has both, made with these original columns.
  await pool.query(`CREATE SCHEMA IF NOT EXISTS benchmark_results`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    run_id integer NOT NULL,
    prompt text NOT NULL,
    expected_answer text NOT NULL,
    latency_ms integer NOT NULL,
    ok boolean NOT NULL,
    reply text NOT NULL,
    error text,
    "sessionId" text NOT NULL,
    "costUsd" real NOT NULL DEFAULT 0,
    turns integer NOT NULL DEFAULT 0,
    tools text[],
    "toolCalls" integer NOT NULL DEFAULT 0,
    proposals integer NOT NULL DEFAULT 0,
    "deltaChars" integer NOT NULL DEFAULT 0)`);
  await pool.query(`ALTER TABLE ${TABLE}
    ADD COLUMN IF NOT EXISTS model text,
    ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS token_limit boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS skip_reason text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS context_recap boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS attachments jsonb,
    ADD COLUMN IF NOT EXISTS input_line int`);
}

export async function insertResult(r, model, runId) {
  await pool.query(
    `INSERT INTO ${TABLE}
       (run_id, prompt, expected_answer, latency_ms, ok, reply, error, "sessionId",
        "costUsd", turns, tools, "toolCalls", proposals, "deltaChars", model, token_limit, skip_reason, context_recap, attachments, input_line)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
    [runId, r.prompt, r.expected_answer, r.latency_ms, r.ok, r.reply, r.error || null, r.sessionId,
      r.costUsd, r.turns, r.tools, r.toolCalls, r.proposals, r.deltaChars, model, !!r.tokenLimit, r.skipReason ?? "", !!r.contextRecap,
      r.attachments?.length ? JSON.stringify(r.attachments) : null, r.inputLine ?? null],
  );
}

/**
 * Stored answers matching the filters; any filter left null is ignored.
 * `session_messages` is the number of messages its session has in that run.
 */
export async function queryResults({ model = null, from = null, to = null, minMessages = null, maxMessages = null }) {
  const { rows } = await pool.query(
    `WITH sessions AS (
       SELECT run_id, "sessionId", count(*)::int AS session_messages FROM ${TABLE} GROUP BY 1, 2
     )
     SELECT r.run_id, r.model, r.created_at, r."sessionId", s.session_messages, r.prompt, r.expected_answer,
            r.reply, r.error, r.ok, r.token_limit, r.skip_reason, r.context_recap, r.latency_ms, r.turns, r.tools, r."toolCalls",
            r.proposals, r."costUsd", r.attachments
     FROM ${TABLE} r JOIN sessions s USING (run_id, "sessionId")
     WHERE ($1::text IS NULL OR r.model = $1)
       AND ($2::timestamptz IS NULL OR r.created_at >= $2)
       AND ($3::timestamptz IS NULL OR r.created_at < $3)
       AND ($4::int IS NULL OR s.session_messages >= $4)
       AND ($5::int IS NULL OR s.session_messages <= $5)
     ORDER BY r.run_id DESC, r."sessionId", r.created_at, r.ctid`,
    [model, from, to, minMessages, maxMessages],
  );
  return rows;
}

export async function listResultModels() {
  const { rows } = await pool.query(`SELECT DISTINCT model FROM ${TABLE} WHERE model IS NOT NULL ORDER BY model`);
  return rows.map((r) => r.model);
}
