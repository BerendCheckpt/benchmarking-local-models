// Helpers shared by the benchmark page and the results page.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const ICON = { pending: "○", running: "◐", ok: "✓", failed: "✗", "token-limit": "⚠", skipped: "⊘" };
const ANSWERED = new Set(["ok", "failed", "token-limit"]);
const label = (state) => state.replace("-", " ");
/** Marker for a message asked in a fresh session with the earlier turns recapped. */
const recapTag = (m) => m.contextRecap ? ` <span class="recap" title="Fresh agent session; the earlier turns were recapped in the message">↻ recap</span>` : "";
const open = new Set(); // keys of expanded <details>, kept across re-renders

function duration(ms) {
  if (ms == null) return "–";
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  return `${Math.floor(s / 60)}m ${String(Math.floor(s % 60)).padStart(2, "0")}s`;
}

async function api(path, options) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

function details(key, summary, body) {
  return `<details data-key="${esc(key)}"${open.has(key) ? " open" : ""}><summary>${summary}</summary>${body}</details>`;
}

function resultFacts(r) {
  return `<div class="facts">
    <span class="${r.state}">${ICON[r.state]} ${label(r.state)}</span>
    ${r.contextRecap ? `<span class="recap">↻ fresh session, earlier turns recapped</span>` : ""}
    ${r.unsaved ? `<span class="unsaved">not saved: ${esc(r.dbError)}</span>` : ""}
    <span>latency ${duration(r.latency_ms)}</span>
    <span>turns ${r.turns ?? 0}</span>
    <span>tool calls ${r.toolCalls ?? 0}${r.tools?.length ? ` (${esc([...new Set(r.tools)].join(", "))})` : ""}</span>
    <span>proposals ${r.proposals ?? 0}</span>
    <span>cost $${Number(r.costUsd ?? 0).toFixed(4)}</span>
    <span class="mono">session ${esc(r.sessionId || "–")}</span>
  </div>`;
}

/** Why a message was not asked; empty for asked messages. */
const skipNote = (m) => m.skipReason ? `<div class="skipped">Skipped: ${esc(m.skipReason)}</div>` : "";

/** Question, reply, expected answer and error of one answered message. */
function answerBody(m) {
  if (m.state === "skipped") return `${skipNote(m)}<div class="muted">Expected</div><pre>${esc(m.expected || "(none)")}</pre>`;
  return `${resultFacts(m)}${m.error ? `<div class="bad">${esc(m.error)}</div>` : ""}
    <div class="muted">Reply</div><pre>${esc(m.reply || "(empty)")}</pre>
    <div class="muted">Expected</div><pre>${esc(m.expected || "(none)")}</pre>`;
}

const shortQuestion = (q) => esc(q.length > 120 ? q.slice(0, 120) + "…" : q);

// toggle does not bubble, so listen in the capture phase.
document.addEventListener("toggle", (e) => {
  const key = e.target.dataset?.key;
  if (key) e.target.open ? open.add(key) : open.delete(key);
}, true);
