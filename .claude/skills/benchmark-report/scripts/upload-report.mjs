// Uploads ONE report's viewer file to the benchmark viewer on the spark server,
// over SSH (VIEWER_SSH_* in .env, see viewer-remote.mjs). Only when the user
// asks for it: /benchmark-report upload <run_id>.
//
//   node upload-report.mjs reports/run-<id>.viewer.json
//
// Refuses anything that isn't a *.viewer.json directly in reports/.
import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { viewerDir, viewerTarget, viewerUrl } from "../../../../viewer-remote.mjs";

/** The checked absolute path of a viewer file directly in `<root>/reports/`; throws otherwise. */
export function checkReportPath(file, root = process.cwd()) {
  if (!file) throw new Error("usage: node upload-report.mjs reports/run-<id>.viewer.json");
  const abs = resolve(root, file);
  const name = basename(abs);
  if (dirname(abs) !== resolve(root, "reports") || !/^[\w.-]+\.viewer\.json$/.test(name)) {
    throw new Error(`only a *.viewer.json file directly in reports/ can be uploaded, not ${file}`);
  }
  if (!existsSync(abs)) throw new Error(`${file} does not exist: run viewer-data.mjs for that report first`);
  return abs;
}

/** Uploads the file with `target` (exec + put); resolves to its remote path. */
export async function uploadReport(file, target, env = process.env, root = process.cwd()) {
  const abs = checkReportPath(file, root);
  const dir = `${viewerDir(env)}/reports`;
  await target.exec(`mkdir -p '${dir}'`);
  const [remote] = await target.put([{ local: abs, remote: `${dir}/${basename(abs)}` }]);
  return remote;
}

async function main(file) {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const remote = await uploadReport(file, viewerTarget());
  console.log(`uploaded ${basename(remote)}; open ${viewerUrl()}/#results`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2]).catch((err) => { console.error(err.message); process.exit(1); });
}
