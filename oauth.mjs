// OAuth2 Authorization Code + PKCE against the CheckNet login server, with a
// refresh token kept on disk so a restart does not need a new browser login.
// Tokens never reach a log or the browser.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const TOKEN_FILE = path.join(process.env.DATA_DIR || "./data", ".tokens.json");
const REFRESH_MARGIN_MS = 60_000;

const cfg = () => ({
  authUrl: process.env.OAUTH_AUTH_URL,
  tokenUrl: process.env.OAUTH_TOKEN_URL,
  clientId: process.env.OAUTH_CLIENT_ID,
  scope: process.env.OAUTH_SCOPE,
  redirectUri: process.env.OAUTH_REDIRECT_URI,
});

let tokens = load();
const pending = new Map(); // state -> code_verifier
// The refresh in flight. Callers share it, so a refresh token is only ever sent
// once (the server issues a new one with each refresh and voids the old one).
let refreshing = null;
let checkFailedAt = 0;

function load() {
  try { return JSON.parse(readFileSync(TOKEN_FILE, "utf8")); } catch { return null; }
}

function save(t) {
  tokens = t;
  mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  writeFileSync(TOKEN_FILE, JSON.stringify(t), { mode: 0o600 });
}

function clearTokens() {
  tokens = null;
  rmSync(TOKEN_FILE, { force: true });
}

const b64url = (buf) => buf.toString("base64url");

export function pkcePair() {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function loginUrl() {
  const c = cfg();
  const { verifier, challenge } = pkcePair();
  const state = b64url(randomBytes(16));
  pending.set(state, verifier);
  const url = new URL(c.authUrl);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: c.clientId,
    redirect_uri: c.redirectUri,
    scope: c.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

async function tokenRequest(params) {
  const c = cfg();
  // Public client: credentials go in the body, there is no secret.
  const res = await fetch(c.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.clientId, ...params }),
  });
  const body = await res.json().catch(() => ({}));
  // A refresh token the server rejects is dead: forget it, so the page asks for a new login.
  if (!res.ok && params.grant_type === "refresh_token" && body.error === "invalid_grant") clearTokens();
  if (!res.ok) throw new Error(`token endpoint ${res.status}: ${body.error ?? "unknown"} ${body.error_description ?? ""}`.trim());
  save({
    accessToken: body.access_token,
    // Servers that do not rotate refresh tokens omit it on refresh.
    refreshToken: body.refresh_token ?? tokens?.refreshToken,
    expiresAt: Date.now() + (Number(body.expires_in) || 300) * 1000,
  });
}

export async function handleCallback(code, state) {
  const verifier = pending.get(state);
  if (!verifier) throw new Error("unknown or expired login state");
  pending.delete(state);
  await tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: cfg().redirectUri,
    code_verifier: verifier,
  });
}

export async function getAccessToken({ forceRefresh = false } = {}) {
  if (!tokens?.refreshToken && !tokens?.accessToken) throw new Error("not logged in");
  if (forceRefresh || Date.now() > tokens.expiresAt - REFRESH_MARGIN_MS) {
    if (!tokens.refreshToken) throw new Error("access token expired and no refresh token; log in again");
    await refresh();
  }
  return tokens.accessToken;
}

function refresh() {
  refreshing ??= tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refreshToken })
    .finally(() => { refreshing = null; });
  return refreshing;
}

/**
 * isLoggedIn, after a refresh when the access token has expired, so a refresh
 * token the server no longer accepts shows as logged out (and the page opens
 * the login) without waiting for a benchmark to fail. A failed check is not
 * repeated for a minute, since the page polls every few seconds.
 */
export async function checkLogin() {
  if (tokens?.refreshToken && Date.now() > tokens.expiresAt && Date.now() - checkFailedAt > 60_000) {
    try { await refresh(); } catch { checkFailedAt = Date.now(); }
  }
  return isLoggedIn();
}

export const isLoggedIn = () => Boolean(tokens?.refreshToken || (tokens?.accessToken && Date.now() < tokens.expiresAt));
