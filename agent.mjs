// Talks to the claude-agent container: switches its model and posts /chat.
import http from "node:http";
import https from "node:https";
import * as docker from "./docker.mjs";
import { getAccessToken } from "./oauth.mjs";

const TIMEOUT_MS = 10 * 60_000;
// Claude Code's own default is 32000; local models hit it on long answers (run 1793258147: 21 turns).
const MAX_OUTPUT_TOKENS = "42000";
const HEALTH_WAIT_MS = 60_000;

const baseUrl = () => process.env.AGENT_BASE_URL;

/** Returns a copy of a Docker `Env` array with the given keys set. */
export function withEnv(env, updates) {
  const keys = new Set(Object.keys(updates));
  return [
    ...(env ?? []).filter((e) => !keys.has(e.split("=", 1)[0])),
    ...Object.entries(updates).map(([k, v]) => `${k}=${v}`),
  ];
}

const envValue = (env, key) => env?.find((e) => e.startsWith(key + "="))?.slice(key.length + 1);

// Where the agent's prompt and skills expect the repo mirror (plugin code, FDS
// documents, Layout Designer manual). Mounted read-only, as in the swarm.
export const MIRROR_PATH = "/srv/repos";

/** Returns a copy of a Docker `Binds` array with `bind` replacing any bind to the same target. */
export function withBind(binds, bind) {
  const target = bind.split(":")[1];
  return [...(binds ?? []).filter((b) => b.split(":")[1] !== target), bind];
}

/**
 * The agent reads CLAUDE_CHAT_MODEL once at startup (chat.mjs), so a new model
 * means a new container. Everything else is copied from the existing one.
 */
export async function applyModel(model) {
  const name = process.env.AGENT_CONTAINER || "claude-agent-local";
  const updates = {
    CLAUDE_CHAT_MODEL: model,
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: process.env.AGENT_MAX_OUTPUT_TOKENS?.trim() || MAX_OUTPUT_TOKENS,
  };
  if (process.env.AGENT_OLLAMA_URL) updates.ANTHROPIC_BASE_URL = process.env.AGENT_OLLAMA_URL;
  const mirror = process.env.AGENT_REPO_MIRROR?.trim();
  if (mirror) updates.CNU_REPO_MIRROR = MIRROR_PATH;

  const current = await docker.inspect(name);
  const binds = mirror ? withBind(current.HostConfig.Binds, `${mirror}:${MIRROR_PATH}:ro`) : current.HostConfig.Binds;
  const unchanged = Object.entries(updates).every(([k, v]) => envValue(current.Config.Env, k) === v)
    && JSON.stringify(binds ?? null) === JSON.stringify(current.HostConfig.Binds ?? null);
  if (unchanged && current.State.Running) return false;

  const { Hostname, ...config } = current.Config; // a copied Hostname would be the old container id
  await docker.remove(name);
  const id = await docker.create(name, {
    ...config, Env: withEnv(config.Env, updates), HostConfig: { ...current.HostConfig, Binds: binds },
  });
  await docker.start(id);
  await waitForHealth();
  return true;
}

// The two halves of the mirror and the token sync-mirror.mjs needs to fill each.
const MIRROR_PARTS = [
  { dir: "github", token: "GH_TOKEN" },  // new-flow plugins, CNU services, Layout Designer manual
  { dir: "devops", token: "AZDO_PAT" },  // legacy CKP.RI.RetailerPlugIn.* plugins
];

/**
 * "skipped: …" text for a message that needs the mirror, or "" to ask it. Only a
 * missing github/ half skips: it holds the new-flow plugins, the services and the
 * Layout Designer manual. Without devops/ the message is still asked, and the
 * agent can't read the legacy plugin code.
 */
export function mirrorSkipReason(missingTokens) {
  if (!missingTokens.includes("GH_TOKEN")) return "";
  return `needs the repo mirror, which is not synced: ${missingTokens.join(" and ")} missing`;
}

/** Tokens whose half of the mirror the agent container does not have. */
export async function missingMirrorTokens() {
  if (!process.env.AGENT_REPO_MIRROR?.trim()) return MIRROR_PARTS.map((p) => p.token);
  const name = process.env.AGENT_CONTAINER || "claude-agent-local";
  const missing = [];
  for (const { dir, token } of MIRROR_PARTS) {
    if (await docker.exec(name, ["test", "-d", `${MIRROR_PATH}/${dir}`]) !== 0) missing.push(token);
  }
  return missing;
}

async function waitForHealth() {
  const until = Date.now() + HEALTH_WAIT_MS;
  while (Date.now() < until) {
    try {
      const res = await fetch(`${baseUrl()}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`agent did not become healthy within ${HEALTH_WAIT_MS / 1000}s`);
}

/** Parses the /chat SSE stream into one result row (port of the n8n "Build result" node). */
export function parseSse(text) {
  const events = text.split(/\r?\n\r?\n/).filter(Boolean).map((block) => {
    let event = "message", data = "";
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    return { event, data: data ? JSON.parse(data) : null };
  });
  const of = (name) => events.filter((e) => e.event === name).map((e) => e.data);
  const result = of("result")[0], error = of("error")[0], done = of("done").pop();
  const summary = result ?? done;
  const message = error?.error ?? error?.reason ?? "";
  return {
    ok: !!result && !error,
    reply: result?.reply ?? "",
    error: message,
    // Claude Code gives up once one response passes its output token maximum (CLAUDE_CODE_MAX_OUTPUT_TOKENS).
    tokenLimit: /output token maximum/i.test(message),
    sessionId: summary?.sessionId ?? "",
    costUsd: summary?.costUsd ?? 0,
    turns: summary?.turns ?? 0,
    tools: of("tool").map((t) => t.tool),
    toolCalls: of("tool").length,
    proposals: of("action-proposal").length,
    deltaChars: of("delta").reduce((n, d) => n + (d.text?.length ?? 0), 0),
  };
}

/** "6 hours", "30 minutes": a limit as the error text names it. */
export function describeLimit(ms) {
  const minutes = ms / 60_000;
  return minutes >= 120 && minutes % 60 === 0 ? `${minutes / 60} hours` : `${minutes} minutes`;
}

// node:http rather than fetch: undici's default 300 s body timeout would cut a
// slow local model off long before the 10 minutes we allow. setTimeout is an
// idle timeout: /from-pdf sends nothing until the job ends, so it must cover
// the whole job, and TCP keep-alive keeps the quiet connection open meanwhile.
function post(url, headers, body, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = (u.protocol === "https:" ? https : http).request(u, { method: "POST", headers }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { data += c; });
      res.on("end", () => resolve({ status: res.statusCode, data }));
    });
    req.on("socket", (socket) => socket.setKeepAlive(true, 60_000));
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no response within ${describeLimit(timeoutMs)}`)));
    req.on("error", reject);
    req.end(body);
  });
}

/** `attachments`: `[{ fileName, contentType, dataBase64 }]`, the shape the agent's /chat takes. */
export async function postChat(message, sessionId, attachments = []) {
  const files = attachments.map(({ fileName, contentType, dataBase64 }) => ({ fileName, contentType, dataBase64 }));
  const body = JSON.stringify({ message, env: process.env.AGENT_ENV || "qa", sessionId, ...(files.length ? { attachments: files } : {}) });
  const send = async (token) => post(`${baseUrl()}/chat?stream=1`, {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "x-assistant-deadline-seconds": String(TIMEOUT_MS / 1000),
  }, body);

  let res = await send(await getAccessToken());
  if (res.status === 401) res = await send(await getAccessToken({ forceRefresh: true }));
  if (res.status !== 200) {
    let error = res.data;
    try { error = JSON.parse(res.data).error ?? res.data; } catch { /* not JSON */ }
    return { ...parseSse(""), error: `HTTP ${res.status}: ${error}` };
  }
  return parseSse(res.data);
}

// The agent keeps a /from-pdf job running after its caller leaves, so giving up
// early only stacks the next job on top of it (run 1793885687: seven at once on
// one Ollama). Wait for the real result: a local model can need about an hour
// (55 min for one template). The cap only guards against a job that never ends.
export const GENERATE_TIMEOUT_DEFAULT_S = 6 * 60 * 60;
export const generateTimeoutMs = () => (Number(process.env.GENERATE_TIMEOUT_S) || GENERATE_TIMEOUT_DEFAULT_S) * 1000;

/**
 * A labelizer generation call, as QA made it: the PDF to the agent's /from-pdf
 * (no user token). Resolves to `{ template, demoData, result }`; throws on a
 * non-200 reply.
 */
export async function postFromPdf({ pdfBase64, filename, labelId, retailerId }) {
  const body = JSON.stringify({ pdfBase64, filename, labelId, retailerId });
  const res = await post(`${baseUrl()}/from-pdf`, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  }, body, generateTimeoutMs());
  let data;
  try { data = JSON.parse(res.data); } catch { /* not JSON */ }
  if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${data?.error ?? res.data}`);
  if (!data) throw new Error("from-pdf: reply is not JSON");
  return data;
}
