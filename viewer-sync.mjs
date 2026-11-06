// Keeps the viewer's database on spark in step with the app's stored messages
// (benchmark_results.hanuman_exports), one way: app → spark, same ids. Only rows
// spark doesn't have yet are copied. The database is reached through an SSH
// tunnel with the VIEWER_SSH_* login; it listens on spark's loopback only.
//   VIEWER_PG_PORT      its port on spark's loopback (default 5435)
//   VIEWER_PG_DATABASE  default benchmark_viewer
//   VIEWER_PG_USER      default benchmark_viewer
//   VIEWER_PG_PASSWORD  required
import { pathToFileURL } from "node:url";
import pg from "pg";
import { ExportsRepository } from "./exports.mjs";
import { viewerTarget } from "./viewer-remote.mjs";

export const viewerPgPort = (env = process.env) => Number(env.VIEWER_PG_PORT || 5435);

/** Is a sync to the viewer set up in this environment? */
export const viewerSyncConfigured = (env = process.env) => !!(env.VIEWER_SSH_HOST && env.VIEWER_PG_PASSWORD);

/**
 * Copies the rows `remote` doesn't have from `local`, each insert on its own:
 * one failed row is logged and the rest still go. Returns `{ copied, failed }`.
 */
export async function syncExports(local, remote) {
  const have = await remote.ids();
  const missing = await local.allExcept(have);
  const counts = { copied: 0, failed: 0 };
  for (const row of missing) {
    try {
      if (await remote.insertStored(row)) counts.copied++;
    } catch (err) {
      counts.failed++;
      console.error(`[viewer-sync] could not copy message ${row.id}: ${err.message}`);
    }
  }
  return counts;
}

/**
 * Runs `fn(repo)` against the viewer's database through a tunnel, with the table
 * made sure of first, and closes both afterwards. Every pg setting is explicit,
 * so pg never falls back to the app's own PG* variables.
 */
export async function withViewerDb(fn, env = process.env, target = viewerTarget(env)) {
  if (!env.VIEWER_PG_PASSWORD) throw new Error("set VIEWER_PG_PASSWORD in .env");
  const tunnel = await target.tunnel(viewerPgPort(env));
  const pool = new pg.Pool({
    host: "127.0.0.1", port: tunnel.port, max: 1,
    database: env.VIEWER_PG_DATABASE || "benchmark_viewer",
    user: env.VIEWER_PG_USER || "benchmark_viewer",
    password: env.VIEWER_PG_PASSWORD,
  });
  pool.on("error", (err) => console.error(`[viewer-sync] connection lost: ${err.message}`));
  try {
    const repo = new ExportsRepository(pool);
    await repo.ensure();
    return await fn(repo);
  } finally {
    await pool.end().catch(() => {});
    await tunnel.close();
  }
}

/** Copies the app's new messages to the viewer. `local` is the app's ExportsRepository. */
export const syncToViewer = (local, env = process.env) => withViewerDb((remote) => syncExports(local, remote), env);

// `npm run viewer:sync` runs this file inside the app container, which has the
// app's Postgres on its network and .env in its environment. The app does the
// same after every upload; this is for the first backfill or after spark was down.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = new pg.Pool({ max: 1 });
  try {
    const { copied, failed } = await syncToViewer(new ExportsRepository(pool));
    console.log(`viewer sync: ${copied} copied${failed ? `, ${failed} failed (see above)` : ""}`);
    if (failed) process.exitCode = 1;
  } catch (err) {
    console.error(`viewer sync failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
