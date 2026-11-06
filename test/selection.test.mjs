import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJsonl, previewSessions } from "../benchmark.mjs";
import { matchByLine } from "../.claude/skills/benchmark-report/scripts/match.mjs";
import { collectLabels, feedbackSummary, labelFacts, labelsMarkdown, pdfMatch, Pseudonyms } from "../.claude/skills/benchmark-report/scripts/label-ri.mjs";
import { assemble } from "../.claude/skills/benchmark-report/scripts/assemble-report.mjs";

// Synthetic data only.
const file = [
  { session: "s1", question: "which vendor?", answer: "v1", askedAt: "2026-11-04T09:00:00Z" },
  { session: "s1", question: "and its ticket center?", answer: "t1" },
  { session: "s2", question: "Use the labelizer skill\nINPUT PDF: /tmp/labelizer-x/1up.pdf\nTarget LabelId: 45. Target RetailerId: 9.", answer: "ok" },
  { session: "s2", question: "fix the layout of label id 45" + "\n\nThe person attached 1 file to this message. They are on disk and you can read them:\n- shot.pdf (3 KB) at /tmp/cnu-chat/a/attachments/b/shot.pdf\n", answer: "done" },
].map((r) => JSON.stringify(r)).join("\n");

test("previewSessions groups the file and marks files, labelizer and label ids", () => {
  const sessions = previewSessions(parseJsonl(file));
  assert.deepEqual(sessions.map((s) => [s.label, s.messages.map((m) => m.line)]), [["s1", [1, 2]], ["s2", [3, 4]]]);
  const [gen, fix] = sessions[1].messages;
  assert.equal(gen.labelizer, true);
  assert.deepEqual(gen.labelIds, ["45"]);
  assert.deepEqual(gen.files, ["1up.pdf"]);
  assert.equal(fix.labelizer, false);
  assert.deepEqual(fix.files, ["shot.pdf"]);
  assert.equal(sessions[0].messages[0].askedAt, "2026-11-04T09:00:00Z");
});

test("matchByLine matches a selection run to its file by input_line", () => {
  const lines = file.split("\n").map((l) => JSON.parse(l));
  const row = (n) => ({ input_line: n, prompt: lines[n - 1].question, expected_answer: lines[n - 1].answer });
  const pairs = matchByLine([row(4), row(2)], lines);
  assert.deepEqual(pairs.map((p) => p.lineNo), [2, 4]);
  assert.equal(matchByLine([{ ...row(2), prompt: "other" }], lines), null);
  assert.equal(matchByLine([{ prompt: "which vendor?", expected_answer: "v1" }], lines), null); // old run: no input_line
});

test("feedbackSummary counts corrections around the question and the gaps", () => {
  const rows = [
    { Kind: "generation", CreatedAt: "2026-11-04T08:00:00Z" },
    { Kind: "correction", CreatedAt: "2026-11-04T08:30:00Z" },
    { Kind: "correction", CreatedAt: "2026-11-04T11:00:00Z" },
    { Kind: "correction", CreatedAt: "2026-11-05T09:00:00Z" },
  ];
  const s = feedbackSummary(rows, "2026-11-04T10:00:00Z");
  assert.equal(s.generations, 1);
  assert.equal(s.corrections, 3);
  assert.deepEqual(s.before, { generations: 1, corrections: 1 });
  assert.deepEqual(s.after, { generations: 0, corrections: 2 });
  assert.equal(s.minutesToNextCorrection, 60);
  assert.equal(s.minutesGenerationToFirstCorrection, 30);
  const noTime = feedbackSummary(rows, null);
  assert.equal(noTime.before, null);
  assert.equal(noTime.minutesToNextCorrection, null);
  assert.equal(noTime.corrections, 3);
  assert.equal(feedbackSummary([], "2026-11-04T10:00:00Z").minutesGenerationToFirstCorrection, null);
});

test("aggregate prints the role, irrelevant-question and labelizer tables", () => {
  const dir = mkdtempSync(join(tmpdir(), "agg-"));
  try {
    const item = (id, question, extra = {}) => ({
      id, runId: 1, model: "m", line: id, createdAt: `2026-11-05T10:0${id}:00Z`, session: "aaaaaaaa-1",
      askedAt: "2026-11-04T10:00:00Z", question, ok: true, reply: "r", skipReason: "", latencyS: 3, ...extra,
    });
    writeFileSync(join(dir, "items.json"), JSON.stringify([
      item(1, "Target LabelId: 5."), item(2, "what is the capital of France?"), item(3, "status of order 1?"),
    ]));
    const judged = (id, extra) => ({ id, score: 2, persona: "support", answerable: "full", access: ["none"], grounded: "yes", verdict: "v", relevant: "yes", stopped: null, roleFit: null, labelCheck: "n/a", ...extra });
    writeFileSync(join(dir, "judged1.json"), JSON.stringify([
      judged(1, { category: "labelizer", persona: "layout-designer", labelCheck: "contradicts", roleFit: "Say the template needs checking." }),
      judged(2, { category: "general", relevant: "no", stopped: "no", score: 0, roleFit: "Decline: outside CNU scope." }),
      judged(3, { category: "data-lookup", score: 3 }),
    ]));
    writeFileSync(join(dir, "run.json"), JSON.stringify({ runId: 1, model: "m", input: "x", from: "a", to: "b", messages: 3 }));
    const rows = [{ Kind: "generation", RetailerId: 9, CreatedAt: "2026-11-04T09:00:00Z", CreatedBy: "User 1" }, { Kind: "correction", RetailerId: 9, CreatedAt: "2026-11-04T12:00:00Z", CreatedBy: "User 1" }];
    writeFileSync(join(dir, "labels.json"), JSON.stringify({
      labels: { 5: { rows, ...labelFacts(rows) } },
      items: [{ itemId: 1, labelId: "5", source: "generation", askedAt: "2026-11-04T10:00:00Z", summary: feedbackSummary(rows, "2026-11-04T10:00:00Z"), pdfMatch: "match" }],
    }));
    const out = execFileSync(process.execPath, [".claude/skills/benchmark-report/scripts/aggregate.mjs", dir], { encoding: "utf8" });
    assert.match(out, /### Irrelevant questions/);
    assert.match(out, /\| all \| 1 \| 0 \| 0 \| 1 \|/);
    assert.match(out, /### Advice per role/);
    assert.match(out, /- 2 \[general, score 0\] Decline: outside CNU scope\./);
    assert.match(out, /### Labelizer questions vs RetailerIntegration/);
    assert.match(out, /\| 5 \| 1 \| labelizer \| 1 \| 1 \| 1 \| 1\.0 \| 2\.0 h \| 2\.0 h \| 3\.0 h \| 1 \| no \| match \| contradicts 1 \|/);
    // The row-level details stay out of the aggregate output and the appendix: they live in labels.md.
    assert.doesNotMatch(out, /Label details/);
    assert.doesNotMatch(out, /User 1/);
    assert.doesNotMatch(readFileSync(join(dir, "appendix.md"), "utf8"), /Label details/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Pseudonyms replace CreatedBy stably, case-insensitively, in first-seen order", () => {
  const p = new Pseudonyms();
  assert.equal(p.of("SmithJ"), "User 1");
  assert.equal(p.of("DoeA"), "User 2");
  assert.equal(p.of("smithj"), "User 1");
  assert.equal(p.of(null), "");
  assert.deepEqual(p.rows([{ CreatedBy: "DoeA", Kind: "correction" }]), [{ CreatedBy: "User 2", Kind: "correction" }]);
});

test("collectLabels queries once per label id and never keeps a real name", async () => {
  const calls = [];
  const repo = {
    async byLabelId(id) {
      calls.push(id);
      if (id === "77") throw new Error("boom");
      return [
        { Kind: "generation", RetailerId: 9, CreatedBy: "SmithJ", CreatedAt: "2026-11-04T08:00:00Z", pdf: "a.pdf", hash: "abcdef123456" },
        { Kind: "correction", RetailerId: 9, CreatedBy: "DoeA", CreatedAt: "2026-11-04T08:30:00Z" },
      ];
    },
  };
  const items = [
    { id: 1, question: "Target LabelId: 45.", askedAt: "2026-11-04T07:00:00Z", attachments: [{ fileName: "a.pdf", contentType: "application/pdf", sha256: "abcdef1234567890" }] },
    { id: 2, question: "fix label id 45 please", askedAt: "2026-11-04T09:00:00Z" },
    { id: 3, question: "and label id 77?" },
  ];
  const got = await collectLabels(items, repo);
  assert.deepEqual(calls, ["45", "77"]);
  assert.deepEqual(got.items.map((l) => [l.itemId, l.labelId, l.pdfMatch ?? null]), [[1, "45", "match"], [2, "45", "no attachment"], [3, "77", null]]);
  assert.equal(got.labels["77"].error, "boom");
  const text = JSON.stringify(got) + labelsMarkdown(got.labels, got.items);
  assert.doesNotMatch(text, /SmithJ|DoeA/);
  assert.match(text, /User 1/);
});

test("pdfMatch and labelFacts spot a matching PDF and a shared label id", () => {
  const gen = (hash, retailer = 9, pdf = "x.pdf") => ({ Kind: "generation", RetailerId: retailer, hash, pdf });
  const att = [{ fileName: "x.pdf", contentType: "application/pdf", sha256: "1111222233334444" }];
  assert.equal(pdfMatch(att, [gen("111122223333")]), "match");
  assert.equal(pdfMatch(att, [gen("999988887777")]), "name only");
  assert.equal(pdfMatch(att, [gen("999988887777", 9, "other.pdf")]), "different PDF");
  assert.equal(pdfMatch(att, [{ Kind: "correction", RetailerId: 9 }]), "no RI generation");
  assert.equal(pdfMatch([], [gen("111122223333")]), "no attachment");
  assert.deepEqual(labelFacts([gen("a1a1a1a1"), gen("a1a1a1a1")]), { retailers: [9], shared: false });
  assert.deepEqual(labelFacts([gen("a1a1a1a1", 9), { Kind: "correction", RetailerId: 12 }]), { retailers: [9, 12], shared: true });
  assert.equal(labelFacts([gen("a1a1a1a1"), gen("b2b2b2b2")]).shared, false); // same file re-exported
  assert.equal(labelFacts([gen("a1a1a1a1", 9, "x.pdf"), gen("b2b2b2b2", 9, "y.pdf")]).shared, true);
});

test("assemble-report splices the generated tables and refuses a missing marker", () => {
  const files = { [join("w", "labels.md")]: "LABELS\n", [join("w", "appendix.md")]: "APPENDIX\n" };
  const read = (p) => files[p];
  const exists = (p) => p in files;
  const out = assemble("# R\n\n<!-- label-details -->\n\n<!-- appendix -->\n", "w", read, exists);
  assert.equal(out, "# R\n\nLABELS\n\nAPPENDIX\n");
  assert.throws(() => assemble("# R\n<!-- appendix -->\n", "w", read, exists), /label-details/);
  assert.throws(() => assemble("<!-- label-details --><!-- appendix -->", "v", read, exists), /missing/);
});
