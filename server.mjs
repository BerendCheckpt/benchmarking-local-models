// HTTP entry point: serves the page, the OAuth callback and a small JSON API.
// Listens on 4202 because http://127.0.0.1:4202 is the registered redirect URI.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { parseJsonl, run, snapshot, status } from "./benchmark.mjs";
import { ensureSchema } from "./db.mjs";
import { listModels } from "./ollama.mjs";
import { handleCallback, isLoggedIn, loginUrl } from "./oauth.mjs";

const PORT = Number(process.env.PORT || 4202);
const MAX_BODY = 20 * 1024 * 1024;
const PAGE = new URL("./public/index.html", import.meta.url);

function sendJson(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function redirect(res, location) {
  res.writeHead(302, { location });
  res.end();
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error("request body too large"), { statusCode: 413 });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function home(req, res, url) {
  const code = url.searchParams.get("code");
  if (code) {
    await handleCallback(code, url.searchParams.get("state"));
    return redirect(res, "/");
  }
  const oauthError = url.searchParams.get("error");
  if (oauthError) return sendJson(res, 400, { error: `login failed: ${oauthError}` });
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(await readFile(PAGE));
}

async function startRun(req, res) {
  if (!isLoggedIn()) return sendJson(res, 401, { error: "log in first" });
  if (["starting agent", "running"].includes(status.state)) return sendJson(res, 409, { error: "a benchmark is already running" });
  const { model, jsonl } = await readJson(req);
  if (typeof model !== "string" || !model) return sendJson(res, 400, { error: "model required" });
  let rows;
  try { rows = parseJsonl(String(jsonl ?? "")); } catch (err) { return sendJson(res, 400, { error: err.message }); }
  if (!rows.length) return sendJson(res, 400, { error: "the file has no questions" });
  run(model, rows); // runs in the background; progress is read through /api/status
  sendJson(res, 202, { total: rows.length });
}

const routes = {
  "GET /": home,
  "GET /login": (req, res) => redirect(res, loginUrl()),
  "GET /api/status": (req, res) => sendJson(res, 200, { loggedIn: isLoggedIn(), run: snapshot() }),
  "GET /api/models": async (req, res) => sendJson(res, 200, await listModels()),
  "POST /api/run": startRun,
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const handler = routes[`${req.method} ${url.pathname}`];
  if (!handler) return sendJson(res, 404, { error: "not found" });
  try {
    await handler(req, res, url);
  } catch (err) {
    console.error(`[${req.method} ${url.pathname}] ${err.message}`);
    if (!res.headersSent) sendJson(res, err.statusCode ?? 500, { error: err.message });
  }
});

try {
  await ensureSchema();
} catch (err) {
  console.error(`could not prepare the results table: ${err.message}`);
}
server.listen(PORT, () => console.log(`benchmark app listening on :${PORT}`));
