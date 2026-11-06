// The viewer's read-only API, next to nginx on spark. One route:
//   GET /api/exports?from=<iso>&to=<iso>  → { rows }: the stored messages asked
//   in [from, to), plus their sessions' earlier turns (marked context).
// The page groups the rows itself. Connection settings: the standard PG* variables.
import http from "node:http";
import pg from "pg";
import { ExportsRepository } from "./exports.mjs";

const PORT = Number(process.env.API_PORT || 8080);
const pool = new pg.Pool({ max: 4 });
pool.on("error", (err) => console.error(`[db] idle connection lost: ${err.message}`));
const repo = new ExportsRepository(pool);

function send(res, code, body) {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method !== "GET" || url.pathname !== "/api/exports") return send(res, req.method === "GET" ? 404 : 405, { error: "not found" });
  try {
    send(res, 200, { rows: await repo.findRange(url.searchParams.get("from"), url.searchParams.get("to")) });
  } catch (err) {
    if (!err.statusCode) console.error(`[api] ${err.message}`);
    send(res, err.statusCode ?? 500, { error: err.statusCode ? err.message : "could not read the messages" });
  }
});

// The table may not exist before the first sync; make sure of it, retrying while the database starts.
for (let i = 1; ; i++) {
  try { await repo.ensure(); break; } catch (err) {
    if (i >= 30) { console.error(`[api] database not ready: ${err.message}`); process.exit(1); }
    await new Promise((r) => setTimeout(r, 2000));
  }
}
server.listen(PORT, () => console.log(`viewer api listening on :${PORT}`));
