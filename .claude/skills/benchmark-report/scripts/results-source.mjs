// Where export-run.mjs reads benchmark_results.rsults from:
//   - local (default): `docker exec <PG_CONTAINER> psql`, the n8n Postgres on this PC
//   - server (--server): a pg connection, normally an SSH tunnel to the spark
//     stack's own Postgres (RESULTS_PGHOST/PORT/DATABASE/USER/PASSWORD)
// Both answer a one-column query the way `psql -tA` prints it: one value per
// line, and a JSON value as JSON text, so the caller's SQL and parsing stay the same.
import { execFileSync } from "node:child_process";
import pg from "pg";

/** One column of rows as `psql -tA` would print it. */
export function asText(values) {
  return values.map((v) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v)))
    .join("\n").trim();
}

/** Reads through `docker exec ... psql`. `run(cmd, args)` returns stdout (injectable for tests). */
export class DockerPsqlSource {
  constructor(env = process.env, run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })) {
    this.args = (sql) => [
      "exec", "-i", env.PG_CONTAINER || "postgres", "psql", "-U", env.PG_USER || "n8n", "-d", env.PG_DB || "n8n",
      "-v", "ON_ERROR_STOP=1", "-tA", "-c", sql,
    ];
    this.run = run;
  }
  async text(sql) { return this.run("docker", this.args(sql)).trim(); }
  async end() {}
}

/** Reads through a pg pool, e.g. an SSH tunnel to the spark stack's Postgres. */
export class PgSource {
  constructor(env = process.env, pool = null) {
    const need = ["RESULTS_PGHOST", "RESULTS_PGDATABASE", "RESULTS_PGUSER", "RESULTS_PGPASSWORD"].filter((k) => !env[k]);
    if (!pool && need.length) throw new Error(`--server needs ${need.join(", ")} (in the environment or .env)`);
    // Every setting explicit, so pg never falls back to other PG* variables.
    this.pool = pool ?? new pg.Pool({
      host: env.RESULTS_PGHOST, port: Number(env.RESULTS_PGPORT || 5433), database: env.RESULTS_PGDATABASE,
      user: env.RESULTS_PGUSER, password: env.RESULTS_PGPASSWORD, max: 2,
    });
  }
  async text(sql) {
    const { rows, fields } = await this.pool.query(sql);
    const col = fields?.[0]?.name ?? Object.keys(rows[0] ?? {})[0];
    return asText(rows.map((r) => r[col]));
  }
  async end() { await this.pool.end(); }
}

/** The results repository export-run.mjs uses: server (pg) or local (docker exec). */
export class ResultsRepository {
  constructor(source) { this.source = source; }
  static from({ server = false } = {}, env = process.env) {
    return new ResultsRepository(server ? new PgSource(env) : new DockerPsqlSource(env));
  }
  text(sql) { return this.source.text(sql); }
  end() { return this.source.end(); }
}
