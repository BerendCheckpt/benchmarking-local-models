// Builds and (re)starts the benchmark viewer on the spark server with plain
// Docker Compose:
//   1. creates $VIEWER_SSH_DIR/build and $VIEWER_SSH_DIR/reports on spark
//   2. copies deploy/viewer/*, viewer/index.html, viewer/api.mjs and exports.mjs
//      into build/, plus build/.env with the database settings (mode 600)
//   3. runs `docker compose -f docker-compose.yml -f docker-compose.db.yml up -d --build`
//      there: the page (nginx), its read-only API and its Postgres
//
//   npm run viewer:deploy
//
// The SSH user must be allowed to run docker (the docker group). Settings come
// from .env (see viewer-remote.mjs and viewer-sync.mjs).
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { viewerDir, viewerPort, viewerTarget, viewerUrl } from "../viewer-remote.mjs";
import { viewerPgPort } from "../viewer-sync.mjs";

const FILES = [
  ["deploy/viewer/Dockerfile", "Dockerfile"],
  ["deploy/viewer/Dockerfile.api", "Dockerfile.api"],
  ["deploy/viewer/nginx.conf", "nginx.conf"],
  ["deploy/viewer/docker-compose.yml", "docker-compose.yml"],
  ["deploy/viewer/docker-compose.db.yml", "docker-compose.db.yml"],
  ["viewer/index.html", "index.html"],
  ["viewer/api.mjs", "api.mjs"],
  ["exports.mjs", "exports.mjs"],
];

/** build/.env on spark: what docker-compose.db.yml reads. */
export function composeEnv(env = process.env) {
  if (!env.VIEWER_PG_PASSWORD) throw new Error("set VIEWER_PG_PASSWORD in .env (the viewer database's password)");
  // Single-quoted for compose's .env, so $ and spaces stay literal.
  const value = (v) => {
    if (/['\r\n]/.test(v)) throw new Error("the VIEWER_PG_* settings must be one line without a single quote");
    return `'${v}'`;
  };
  return [
    `POSTGRES_DB=${value(env.VIEWER_PG_DATABASE || "benchmark_viewer")}`,
    `POSTGRES_USER=${value(env.VIEWER_PG_USER || "benchmark_viewer")}`,
    `POSTGRES_PASSWORD=${value(env.VIEWER_PG_PASSWORD)}`,
    `VIEWER_PG_PORT=${viewerPgPort(env)}`,
    "",
  ].join("\n");
}

/** Deploys with `target` (exec + put). Returns the compose output. */
export async function deploy(target, env = process.env, root = ".") {
  const dir = viewerDir(env), port = viewerPort(env);
  for (const [local] of FILES) if (!existsSync(join(root, local))) throw new Error(`missing ${local}`);
  const settings = composeEnv(env);
  await target.exec(`mkdir -p '${dir}/build' '${dir}/reports'`);
  // The settings go up from a private temp file that is removed right after.
  const tmp = mkdtempSync(join(tmpdir(), "viewer-env-"));
  try {
    writeFileSync(join(tmp, ".env"), settings, { mode: 0o600 });
    await target.exec(`umask 077 && touch '${dir}/build/.env' && chmod 600 '${dir}/build/.env'`);
    await target.put([
      ...FILES.map(([local, name]) => ({ local: join(root, local), remote: `${dir}/build/${name}` })),
      { local: join(tmp, ".env"), remote: `${dir}/build/.env` },
    ]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const out = await target.exec(
    `cd '${dir}/build' && chmod 600 .env && VIEWER_PORT=${port} VIEWER_REPORTS_DIR='${dir}/reports' `
    + `docker compose -f docker-compose.yml -f docker-compose.db.yml up -d --build 2>&1`);
  return out.toString("utf8");
}

async function main() {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const out = await deploy(viewerTarget());
  console.log(out.trim().split("\n").slice(-6).join("\n"));
  console.log(`viewer deployed: ${viewerUrl()}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(`viewer deploy failed: ${err.message}`); process.exit(1); });
}
