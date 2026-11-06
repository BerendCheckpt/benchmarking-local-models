// HTTP entry point: serves the page, the OAuth callback and a small JSON API.
// Listens on PORT, which must match the port in the registered redirect URI.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { parseJsonl, previewSessions, run, selectRows, snapshot, status } from "./benchmark.mjs";
import { ensureSchema, listResultModels, queryResults } from "./db.mjs";
import { listModels } from "./ollama.mjs";
import { checkLogin, handleCallback, isLoggedIn, loginUrl } from "./oauth.mjs";
import { groupRuns, parseResultFilters } from "./results.mjs";

// Hosts, URLs and ports only come from .env; stop early when one is missing.
const REQUIRED = [
  "PORT", "OAUTH_AUTH_URL", "OAUTH_TOKEN_URL", "OAUTH_CLIENT_ID", "OAUTH_SCOPE", "OAUTH_REDIRECT_URI",
  "AGENT_BASE_URL", "OLLAMA_SSH_HOST", "OLLAMA_SSH_PORT", "PGHOST", "PGPORT",
];
const missing = REQUIRED.filter((name) => !process.env[name]?.trim());
if (missing.length) {
  console.error(`missing settings in .env: ${missing.join(", ")}`);
  process.exit(1);
}

const PORT = Number(process.env.PORT);
const MAX_BODY = 20 * 1024 * 1024;
const PAGE = new URL("./public/index.html", import.meta.url);

/** Serves one file from public/ with the given content type. */
const file = (name, type) => async (req, res) => {
  res.writeHead(200, { "content-type": type });
  res.end(await readFile(new URL(`./public/${name}`, import.meta.url)));
};

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
  // The login runs in a pop-up; /login-done tells the page and closes it.
  const code = url.searchParams.get("code");
  if (code) {
    try {
      await handleCallback(code, url.searchParams.get("state"));
    } catch (err) {
      return redirect(res, `/login-done?error=${encodeURIComponent(err.message)}`);
    }
    return redirect(res, "/login-done");
  }
  const oauthError = url.searchParams.get("error");
  if (oauthError) return redirect(res, `/login-done?error=${encodeURIComponent(oauthError)}`);
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(await readFile(PAGE));
}

async function startRun(req, res) {
  if (!isLoggedIn()) return sendJson(res, 401, { error: "log in first" });
  if (["starting agent", "running"].includes(status.state)) return sendJson(res, 409, { error: "a benchmark is already running" });
  const { model, jsonl, lines } = await readJson(req);
  if (typeof model !== "string" || !model) return sendJson(res, 400, { error: "model required" });
  let rows;
  try { rows = parseJsonl(String(jsonl ?? "")); } catch (err) { return sendJson(res, 400, { error: err.message }); }
  if (!rows.length) return sendJson(res, 400, { error: "the file has no questions" });
  // `lines`: the 1-based lines chosen on the selection page; without it every line is asked.
  try { rows = selectRows(rows, lines); } catch (err) { return sendJson(res, err.statusCode ?? 400, { error: err.message }); }
  run(model, rows); // runs in the background; progress is read through /api/status
  sendJson(res, 202, { total: rows.length });
}

/** The uploaded file as sessions and messages, for the selection page. */
async function parse(req, res) {
  const { jsonl } = await readJson(req);
  let rows;
  try { rows = parseJsonl(String(jsonl ?? "")); } catch (err) { return sendJson(res, 400, { error: err.message }); }
  if (!rows.length) return sendJson(res, 400, { error: "the file has no questions" });
  sendJson(res, 200, { sessions: previewSessions(rows) });
}

async function results(req, res, url) {
  const filters = parseResultFilters(url.searchParams);
  const [models, rows] = await Promise.all([listResultModels(), queryResults(filters)]);
  sendJson(res, 200, { models, runs: groupRuns(rows) });
}

const routes = {
  "GET /": home,
  "GET /new": file("new.html", "text/html; charset=utf-8"),
  "GET /results": file("results.html", "text/html; charset=utf-8"),
  "GET /style.css": file("style.css", "text/css; charset=utf-8"),
  "GET /common.js": file("common.js", "text/javascript; charset=utf-8"),
  "GET /api/results": results,
  "GET /login": (req, res) => redirect(res, loginUrl()),
  "GET /login-done": file("login-done.html", "text/html; charset=utf-8"),
  "GET /api/status": async (req, res) => sendJson(res, 200, { loggedIn: await checkLogin(), run: snapshot() }),
  "GET /api/models": async (req, res) => sendJson(res, 200, await listModels()),
  "POST /api/run": startRun,
  "POST /api/parse": parse,
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
