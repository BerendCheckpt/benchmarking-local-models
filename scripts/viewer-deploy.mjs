// Builds and (re)starts the benchmark viewer on the spark server with plain
// Docker Compose:
//   1. creates $VIEWER_SSH_DIR/build and $VIEWER_SSH_DIR/reports on spark
//   2. copies deploy/viewer/* and viewer/index.html into build/
//   3. runs `docker compose up -d --build` there (builds the image when it
//      doesn't exist, rebuilds it on every deploy)
//
//   npm run viewer:deploy
//
// The SSH user must be allowed to run docker (the docker group). Settings come
// from .env (see viewer-remote.mjs).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { viewerDir, viewerPort, viewerTarget, viewerUrl } from "../viewer-remote.mjs";

const FILES = [
  ["deploy/viewer/Dockerfile", "Dockerfile"],
  ["deploy/viewer/nginx.conf", "nginx.conf"],
  ["deploy/viewer/docker-compose.yml", "docker-compose.yml"],
  ["viewer/index.html", "index.html"],
];

/** Deploys with `target` (exec + put). Returns the compose output. */
export async function deploy(target, env = process.env, root = ".") {
  const dir = viewerDir(env), port = viewerPort(env);
  for (const [local] of FILES) if (!existsSync(join(root, local))) throw new Error(`missing ${local}`);
  await target.exec(`mkdir -p '${dir}/build' '${dir}/reports'`);
  await target.put(FILES.map(([local, name]) => ({ local: join(root, local), remote: `${dir}/build/${name}` })));
  const out = await target.exec(
    `cd '${dir}/build' && VIEWER_PORT=${port} VIEWER_REPORTS_DIR='${dir}/reports' docker compose up -d --build 2>&1`);
  return out.toString("utf8");
}

async function main() {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const out = await deploy(viewerTarget());
  console.log(out.trim().split("\n").slice(-5).join("\n"));
  console.log(`viewer deployed: ${viewerUrl()}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(`viewer deploy failed: ${err.message}`); process.exit(1); });
}
