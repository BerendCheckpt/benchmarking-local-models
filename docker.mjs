// Minimal Docker Engine API client over the mounted unix socket.
import http from "node:http";

const SOCKET = process.env.DOCKER_SOCKET || "/var/run/docker.sock";

function call(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        socketPath: SOCKET,
        method,
        path,
        headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {},
      },
      (res) => {
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => {
          const json = data ? JSON.parse(data) : null;
          if (res.statusCode >= 400) reject(new Error(`docker ${method} ${path} ${res.statusCode}: ${json?.message ?? data}`));
          else resolve(json);
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

const enc = encodeURIComponent;

export const inspect = (name) => call("GET", `/containers/${enc(name)}/json`);
export const remove = (name) => call("DELETE", `/containers/${enc(name)}?force=true`);
export const create = async (name, config) => (await call("POST", `/containers/create?name=${enc(name)}`, config)).Id;
export const start = (id) => call("POST", `/containers/${enc(id)}/start`);

/** Runs `cmd` in a running container and resolves with its exit code. */
export async function exec(name, cmd) {
  const { Id } = await call("POST", `/containers/${enc(name)}/exec`, { Cmd: cmd });
  await call("POST", `/exec/${enc(Id)}/start`, { Detach: true });
  for (let i = 0; i < 50; i++) {
    const state = await call("GET", `/exec/${enc(Id)}/json`);
    if (!state.Running) return state.ExitCode;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`docker exec ${cmd.join(" ")} did not finish`);
}
