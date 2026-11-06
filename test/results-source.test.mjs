import { test } from "node:test";
import assert from "node:assert/strict";
import { asText, DockerPsqlSource, PgSource, ResultsRepository } from "../.claude/skills/benchmark-report/scripts/results-source.mjs";

const SQL = "SELECT max(run_id) FROM benchmark_results.rsults";

test("the local source runs the query through docker exec psql", async () => {
  const calls = [];
  const source = new DockerPsqlSource({}, (cmd, args) => { calls.push([cmd, ...args]); return "1793885687\n"; });
  assert.equal(await new ResultsRepository(source).text(SQL), "1793885687");
  assert.deepEqual(calls[0].slice(0, 8), ["docker", "exec", "-i", "postgres", "psql", "-U", "n8n", "-d"]);
  assert.equal(calls[0].at(-1), SQL);
});

test("the server source prints a column the way psql -tA does", async () => {
  const pool = {
    query: async () => ({ fields: [{ name: "v" }], rows: [{ v: 3 }, { v: 1 }] }),
    end: async () => {},
  };
  assert.equal(await new PgSource({}, pool).text("SELECT run_id"), "3\n1");
  // json_agg comes back parsed from pg; it is turned back into JSON text.
  const json = { query: async () => ({ fields: [{ name: "j" }], rows: [{ j: [{ n: 1 }] }] }), end: async () => {} };
  assert.deepEqual(JSON.parse(await new PgSource({}, json).text("SELECT json_agg(t)")), [{ n: 1 }]);
});

test("--server needs the RESULTS_PG connection settings", () => {
  assert.throws(() => ResultsRepository.from({ server: true }, {}), /RESULTS_PGHOST, RESULTS_PGDATABASE, RESULTS_PGUSER, RESULTS_PGPASSWORD/);
  assert.ok(ResultsRepository.from({ server: false }, {}).source instanceof DockerPsqlSource);
});

test("asText leaves nulls empty and keeps one value per line", () => {
  assert.equal(asText([null, "a", 2]), "a\n2");
});
