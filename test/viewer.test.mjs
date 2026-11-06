import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { parseJsonl, previewSessions } from "../benchmark.mjs";
import { SshTarget } from "../ssh.mjs";
import { deploy } from "../scripts/viewer-deploy.mjs";
import { viewerDir } from "../viewer-remote.mjs";
import { viewerData, viewerFileName } from "../.claude/skills/benchmark-report/scripts/viewer-data.mjs";
import { checkReportPath, uploadReport } from "../.claude/skills/benchmark-report/scripts/upload-report.mjs";

// Synthetic data only.
const JSONL = [
  { session: "s1", question: "which vendor ships for Primark?", answer: "v1", askedAt: "2026-11-04T09:00:00Z" },
  { session: "s1", question: "and how is that implemented in the plugin code?", answer: "t1" },
  { session: "s2", question: "Use the labelizer skill\nINPUT PDF: /tmp/labelizer-x/1up.pdf\nTarget LabelId: 45. Target RetailerId: 9.", answer: "ok" },
  { session: "s2", question: "fix label id 45\n\nThe person attached 1 file to this message. They are on disk and you can read them:\n- shot.pdf (3 KB) at /tmp/a/shot.pdf\n", answer: "done", needs: ["mirror"] },
  { question: "no session here", answer: "" },
].map((r) => JSON.stringify(r)).join("\n");

/** The viewer page's rules block, run in a fresh context like a browser would. */
function viewerRules() {
  const html = readFileSync(new URL("../viewer/index.html", import.meta.url), "utf8");
  const m = /<script id="rules">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, "viewer/index.html has a <script id=\"rules\"> block");
  const context = vm.createContext({});
  vm.runInContext(m[1], context);
  return (rows) => vm.runInContext(`previewSessions(${JSON.stringify(rows)})`, context);
}

// Rows as the viewer's API returns them: stored messages with an id, some marked context.
const ROWS = parseJsonl(JSONL).map((r, i) => ({ ...r, line: null, id: `00000000-0000-4000-8000-00000000000${i}`, ...(i === 0 ? { context: true } : {}) }));

test("the viewer's copied rules give the same sessions and badges as the app", () => {
  const fromViewer = viewerRules()(ROWS);
  const fromApp = previewSessions(ROWS);
  assert.equal(JSON.stringify(fromViewer), JSON.stringify(fromApp));
  assert.equal(fromApp[0].messages[0].context, true);
  // And the badges are really there, so the comparison isn't vacuous.
  const [, s2] = fromApp;
  assert.deepEqual(s2.messages[0].files, ["1up.pdf"]);
  assert.equal(s2.messages[0].labelizer, true);
  assert.deepEqual(s2.messages[1].labelIds, ["45"]);
  assert.equal(fromApp[0].messages[1].needsMirror, true);
});

const row = (id, extra) => ({ id, runId: 1, session: "s", question: `q${id}`, expected: "e", reply: "r", ok: true,
  category: "data-lookup", persona: "support", answerable: "full", score: 2, verdict: "v", ...extra });

test("viewerData counts outcomes, scores only asked messages and keeps only the shown fields", () => {
  const rows = [
    row(1, { score: 3 }),
    row(2, { score: 0, reply: "I ran out of time before I could finish checking." }),
    row(3, { ok: false, error: "no response within 6 hours", score: 0 }),
    row(4, { skipReason: "attachment not recoverable", score: undefined, judgeNotes: "internal" }),
  ];
  const data = viewerData({ runId: 1, model: "m" }, rows);
  assert.deepEqual(data.summary.outcomes, { answered: 1, "out of time": 1, "transport error": 1, skipped: 1 });
  assert.equal(data.summary.messages, 4);
  assert.equal(data.summary.skipped, 1);
  assert.equal(data.summary.mean, "1.00");
  assert.equal(data.summary.weighted, "33%");
  assert.equal(data.rows[3].judgeNotes, undefined);
  assert.equal(viewerFileName({ runId: 1793885687, runs: [{ runId: 1793885687 }] }), "run-1793885687.viewer.json");
  assert.equal(viewerFileName({ name: "2026-11-05", window: { from: "a", to: "b" }, runs: [{ runId: 1 }, { runId: 2 }] }), "runs-2026-11-05.viewer.json");
});

test("viewer-data refuses a work folder without rows.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "vd-"));
  try {
    writeFileSync(join(dir, "run.json"), JSON.stringify({ runId: 1 }));
    assert.throws(() => execFileSync(process.execPath, [".claude/skills/benchmark-report/scripts/viewer-data.mjs", dir, "--out", dir], { stdio: "pipe" }),
      /rows\.json is missing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("upload-report uploads only a viewer file from reports/, and only that file", async () => {
  const root = mkdtempSync(join(tmpdir(), "up-"));
  try {
    mkdirSync(join(root, "reports"));
    writeFileSync(join(root, "reports", "run-1.viewer.json"), "{}");
    writeFileSync(join(root, "reports", "run-1.md"), "# report");
    assert.throws(() => checkReportPath("reports/run-1.md", root), /only a \*\.viewer\.json/);
    assert.throws(() => checkReportPath("../secrets.viewer.json", root), /only a \*\.viewer\.json/);
    assert.throws(() => checkReportPath("reports/work/run-1.viewer.json", root), /only a \*\.viewer\.json/);
    assert.throws(() => checkReportPath("reports/run-2.viewer.json", root), /does not exist/);

    const calls = [];
    const target = { exec: async (c) => { calls.push(["exec", c]); return Buffer.from(""); }, put: async (f) => { calls.push(["put", f]); return f.map((x) => x.remote); } };
    const remote = await uploadReport("reports/run-1.viewer.json", target, { VIEWER_SSH_DIR: "/opt/bv/" }, root);
    assert.equal(remote, "/opt/bv/reports/run-1.viewer.json");
    assert.deepEqual(calls[0], ["exec", "mkdir -p '/opt/bv/reports'"]);
    assert.equal(calls[1][1].length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("viewer:deploy copies the build files and the db settings, and runs both compose files", async () => {
  const calls = [];
  let settings = null;
  const target = {
    exec: async (c) => { calls.push(c); return Buffer.from("Container benchmark-viewer Started"); },
    put: async (f) => {
      calls.push(f.map((x) => x.remote));
      settings = readFileSync(f.find((x) => x.remote.endsWith("/.env")).local, "utf8"); // read before the temp file goes
      return [];
    },
  };
  const env = { VIEWER_SSH_DIR: "/opt/benchmark-viewer", VIEWER_PORT: "4210", VIEWER_PG_PASSWORD: "s3cr$t x" };
  const out = await deploy(target, env, ".");
  assert.match(out, /Started/);
  assert.equal(calls[0], "mkdir -p '/opt/benchmark-viewer/build' '/opt/benchmark-viewer/reports'");
  assert.match(calls[1], /chmod 600 '\/opt\/benchmark-viewer\/build\/.env'/);
  assert.deepEqual(calls[2], ["Dockerfile", "Dockerfile.api", "nginx.conf", "docker-compose.yml", "docker-compose.db.yml",
    "index.html", "api.mjs", "exports.mjs", ".env"].map((f) => `/opt/benchmark-viewer/build/${f}`));
  assert.equal(settings, "POSTGRES_DB='benchmark_viewer'\nPOSTGRES_USER='benchmark_viewer'\nPOSTGRES_PASSWORD='s3cr$t x'\nVIEWER_PG_PORT=5435\n");
  assert.match(calls[3], /docker compose -f docker-compose.yml -f docker-compose.db.yml up -d --build/);
  assert.match(calls[3], /VIEWER_REPORTS_DIR='\/opt\/benchmark-viewer\/reports'/);
  await assert.rejects(deploy(target, { VIEWER_SSH_DIR: "/opt/benchmark-viewer" }, "."), /VIEWER_PG_PASSWORD/);
  await assert.rejects(deploy(target, { ...env, VIEWER_PG_PASSWORD: "a'b" }, "."), /single quote/);
  assert.throws(() => viewerDir({ VIEWER_SSH_DIR: "/opt/x; rm -rf /" }), /absolute path/);
  assert.throws(() => viewerDir({ VIEWER_SSH_DIR: "relative" }), /absolute path/);
});

test("SshTarget.put sends every file over one SFTP connection", async () => {
  const sent = [];
  class FakeClient extends EventEmitter {
    connect() { setImmediate(() => this.emit("ready")); return this; }
    sftp(cb) { cb(null, { fastPut: (local, remote, done) => { sent.push([local, remote]); done(); } }); }
    end() { this.ended = true; }
  }
  const target = new SshTarget("V", { V_HOST: "h", V_USER: "u", V_PASSWORD: "p" }, FakeClient);
  const remotes = await target.put([{ local: "a", remote: "/r/a" }, { local: "b", remote: "/r/b" }]);
  assert.deepEqual(remotes, ["/r/a", "/r/b"]);
  assert.deepEqual(sent, [["a", "/r/a"], ["b", "/r/b"]]);
});
