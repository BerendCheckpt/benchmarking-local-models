import { test } from "node:test";
import assert from "node:assert/strict";
import { ExportsRepository, dedupKey, orderForRun } from "../exports.mjs";
import { parseJsonl, previewSessions } from "../benchmark.mjs";

// Synthetic data only.
const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("dedupKey is the same for a re-upload and falls back to question + answer", () => {
  const a = { session: "s1", askedAt: "2026-11-04T09:00:00Z", question: "q", answer: "x" };
  assert.equal(dedupKey(a), dedupKey({ ...a, answer: "other answer", askedAt: "2026-11-04T09:00:00.000Z" }));
  assert.notEqual(dedupKey(a), dedupKey({ ...a, question: "q2" }));
  assert.notEqual(dedupKey(a), dedupKey({ ...a, session: "s2" }));
  const loose = { session: null, askedAt: null, question: "q", answer: "x" };
  assert.equal(dedupKey(loose), dedupKey({ ...loose }));
  assert.notEqual(dedupKey(loose), dedupKey({ ...loose, answer: "y" }));
});

/** A fake pg client: a dedup_key unique index, and one key that fails to insert. */
function fakeDb({ failQuestion = null, select = [] } = {}) {
  const keys = new Set();
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.startsWith("INSERT")) {
        if (params[2] === failQuestion) throw new Error("boom");
        if (keys.has(params[6])) return { rowCount: 0 };
        keys.add(params[6]);
        return { rowCount: 1 };
      }
      return { rows: select };
    },
  };
}

test("insertMany stores new lines, counts duplicates, and goes on after a failed line", async () => {
  const rows = parseJsonl([
    { session: "s1", question: "q1", answer: "a", askedAt: "2026-11-04T09:00:00Z" },
    { session: "s1", question: "q1", answer: "a", askedAt: "2026-11-04T09:00:00Z" },
    { session: "s1", question: "bad", answer: "a", askedAt: "2026-11-04T09:01:00Z" },
    { question: "loose" },
  ].map((r) => JSON.stringify(r)).join("\n"));
  const db = fakeDb({ failQuestion: "bad" });
  const counts = await new ExportsRepository(db).insertMany(rows);
  assert.deepEqual(counts, { inserted: 2, duplicates: 1, failed: 1, withoutAskedAt: 1 });
  const loose = db.calls.at(-1).params;
  assert.match(loose[0], /^[0-9a-f-]{36}$/);
  assert.equal(loose[5], null); // no asked_at
  // A second upload of the same lines adds nothing.
  assert.equal((await new ExportsRepository(db).insertMany(rows)).inserted, 0);
});

test("orderForRun keeps sessions together by their first question, turns by date", () => {
  const r = (id, session, askedAt, seq) => ({ id: ID(id), session, askedAt, seq });
  const ordered = orderForRun([
    r(1, "late", "2026-11-04T12:00:00Z", 1),
    r(2, "early", "2026-11-04T09:30:00Z", 2),
    r(3, "early", "2026-11-04T09:00:00Z", 3),
    r(4, null, "2026-11-04T10:00:00Z", 4),
    r(5, "early", "2026-11-04T09:00:00Z", 5), // same time as 3: upload order decides
  ]);
  assert.deepEqual(ordered.map((x) => x.id), [ID(3), ID(5), ID(2), ID(4), ID(1)]);
});

test("findRange returns the range plus earlier turns marked context, in run order", async () => {
  const db = fakeDb({ select: [
    { id: ID(2), seq: "2", session: "s1", question: "follow-up", answer: "b", needs: null, asked_at: new Date("2026-11-05T10:00:00Z"), context: false },
    { id: ID(1), seq: "1", session: "s1", question: "first", answer: "a", needs: ["mirror"], asked_at: new Date("2026-11-03T10:00:00Z"), context: true },
  ] });
  const repo = new ExportsRepository(db);
  const rows = await repo.findRange("2026-11-05T00:00:00Z", "2026-11-06T00:00:00Z");
  assert.deepEqual(rows.map((r) => [r.question, !!r.context]), [["first", true], ["follow-up", false]]);
  assert.deepEqual(db.calls[0].params, ["2026-11-05T00:00:00.000Z", "2026-11-06T00:00:00.000Z"]);
  const [session] = previewSessions(rows);
  assert.deepEqual(session.messages.map((m) => [m.id, m.context]), [[ID(1), true], [ID(2), false]]);
  await assert.rejects(repo.findRange("2026-11-06T00:00:00Z", "2026-11-05T00:00:00Z"), (e) => e.statusCode === 400);
  await assert.rejects(repo.findRange("not a date", "2026-11-05T00:00:00Z"), (e) => e.statusCode === 400);
});

test("findByIds returns the chosen messages in run order and refuses unknown or bad ids", async () => {
  const stored = [
    { id: ID(2), seq: "2", session: "s1", question: "second", answer: "", needs: null, asked_at: new Date("2026-11-05T10:05:00Z") },
    { id: ID(1), seq: "1", session: "s1", question: "first", answer: "", needs: null, asked_at: new Date("2026-11-05T10:00:00Z") },
  ];
  const repo = new ExportsRepository(fakeDb({ select: stored }));
  assert.deepEqual((await repo.findByIds([ID(2), ID(1)])).map((r) => r.question), ["first", "second"]);
  await assert.rejects(new ExportsRepository(fakeDb({ select: stored.slice(0, 1) })).findByIds([ID(1), ID(2)]), /unknown message id/);
  await assert.rejects(repo.findByIds([]), (e) => e.statusCode === 400);
  await assert.rejects(repo.findByIds(["1; drop table"]), (e) => e.statusCode === 400);
});
