import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// oauth.mjs reads its token file when it loads, so point it at a scratch
// directory with a stored login first. The real data/.tokens.json is never touched.
const dataDir = mkdtempSync(path.join(tmpdir(), "oauth-test-"));
const tokenFile = path.join(dataDir, ".tokens.json");
writeFileSync(tokenFile, JSON.stringify({ accessToken: "old", refreshToken: "dead", expiresAt: 0 }));

// A token endpoint that first rotates tokens (slowly, so calls overlap), then
// rejects every refresh token, as the login server did on 2026-11-02.
let reject = false, refreshes = 0;
const server = http.createServer((req, res) => {
  refreshes++;
  setTimeout(() => {
    res.writeHead(reject ? 400 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify(reject
      ? { error: "invalid_grant", error_description: "The specified refresh token is invalid." }
      : { access_token: `at${refreshes}`, refresh_token: `rt${refreshes}`, expires_in: 1 }));
  }, 50);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
process.env.DATA_DIR = dataDir;
process.env.OAUTH_TOKEN_URL = `http://127.0.0.1:${server.address().port}/connect/token`;
const { checkLogin, getAccessToken, isLoggedIn } = await import("../oauth.mjs");

test("overlapping callers share one refresh", async () => {
  const [a, b] = await Promise.all([getAccessToken(), getAccessToken({ forceRefresh: true })]);
  assert.equal(refreshes, 1);
  assert.equal(a, "at1");
  assert.equal(b, "at1");
});

test("a rejected refresh token logs the app out, and the status check finds it", async () => {
  try {
    reject = true;
    await new Promise((r) => setTimeout(r, 1100)); // let the 1 s access token expire
    assert.equal(isLoggedIn(), true);
    assert.equal(await checkLogin(), false);
    assert.equal(isLoggedIn(), false);
    assert.equal(existsSync(tokenFile), false);
    assert.equal(refreshes, 2);
    await assert.rejects(getAccessToken(), /not logged in/);
  } finally {
    server.close();
  }
});

test("the login callback page tells its opener and closes", () => {
  const page = readFileSync(new URL("../public/login-done.html", import.meta.url), "utf8");
  assert.match(page, /window\.opener\.postMessage\(\{ type: "login-done", error \}, location\.origin\)/);
  assert.match(page, /if \(!error\) window\.close\(\)/);
});
