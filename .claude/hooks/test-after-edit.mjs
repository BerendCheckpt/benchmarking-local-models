// PostToolUse hook for Edit|Write: runs the unit tests after a code file changes.
// A failure exits 2 with the end of the test output, which Claude Code feeds
// back to Claude; a pass stays silent.
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const input = JSON.parse(await new Response(process.stdin).text() || "{}");
const file = input.tool_input?.file_path ?? "";
if (!/\.(mjs|js)$/i.test(file)) process.exit(0);

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const run = spawnSync(process.execPath, ["--test", "--test-reporter=spec", "test/*.test.mjs"], {
  cwd: repo, encoding: "utf8",
});
if (run.status === 0) process.exit(0);

const output = `${run.stdout}${run.stderr}`.trimEnd().split("\n").slice(-60).join("\n");
process.stderr.write(`npm test failed after editing ${file}:\n${output}\n`);
process.exit(2);
