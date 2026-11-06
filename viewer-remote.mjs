// The benchmark viewer on the spark server, reached over SSH (VIEWER_SSH_*).
// Shared by `npm run viewer:deploy` and the report skill's upload-report.mjs.
//   VIEWER_SSH_HOST, VIEWER_SSH_PORT, VIEWER_SSH_USER, VIEWER_SSH_PASSWORD or
//   VIEWER_SSH_KEY_FILE (+ VIEWER_SSH_KEY_PASSPHRASE), VIEWER_SSH_HOSTKEY_SHA256 (pin)
//   VIEWER_SSH_DIR   folder on spark (default /opt/benchmark-viewer): build/ and reports/
//   VIEWER_PORT      port the viewer listens on (default 4210)
//   VIEWER_URL       how people open it, for the messages (e.g. http://<spark>:4210)
import { SshTarget } from "./ssh.mjs";

/** The SSH target for the viewer; throws when VIEWER_SSH_HOST is not set. */
export function viewerTarget(env = process.env, ClientClass) {
  const target = new SshTarget("VIEWER_SSH", env, ClientClass);
  if (!target.configured) throw new Error("set VIEWER_SSH_HOST, VIEWER_SSH_USER and VIEWER_SSH_PASSWORD or VIEWER_SSH_KEY_FILE in .env");
  return target;
}

/** The viewer's folder on spark, without a trailing slash. Only safe path characters. */
export function viewerDir(env = process.env) {
  const dir = (env.VIEWER_SSH_DIR || "/opt/benchmark-viewer").replace(/\/+$/, "");
  if (!/^\/[\w./-]+$/.test(dir) || dir.includes("..")) throw new Error(`VIEWER_SSH_DIR must be an absolute path of letters, digits, . _ - /: ${dir}`);
  return dir;
}

export const viewerPort = (env = process.env) => {
  const port = Number(env.VIEWER_PORT || 4210);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`VIEWER_PORT is not a port: ${env.VIEWER_PORT}`);
  return port;
};

export const viewerUrl = (env = process.env) => env.VIEWER_URL || `http://${env.VIEWER_SSH_HOST}:${viewerPort(env)}`;
