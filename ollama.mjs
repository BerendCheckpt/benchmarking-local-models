// Lists the models on the Ollama server by running `ollama list` over SSH.
// ssh2 instead of the ssh binary: the binary only takes a password from a
// terminal, and the container has none.
import { createHash } from "node:crypto";
import { Client } from "ssh2";

/** First column of `ollama list`, header row skipped. */
export function parseOllamaList(text) {
  return text
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/)[0])
    .filter(Boolean);
}

/** OpenSSH-style "SHA256:..." fingerprint of a raw host key. */
export function fingerprint(key) {
  return "SHA256:" + createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
}

function hostVerifier() {
  const pin = process.env.OLLAMA_SSH_HOSTKEY_SHA256;
  if (!pin) return undefined;
  const want = pin.startsWith("SHA256:") ? pin : "SHA256:" + pin;
  return (key) => fingerprint(key) === want;
}

export function listModels() {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn
      .on("ready", () => {
        conn.exec("ollama list", (err, stream) => {
          if (err) { conn.end(); return reject(err); }
          let out = "", errOut = "";
          stream
            .on("data", (d) => { out += d; })
            .on("close", (code) => {
              conn.end();
              if (code === 0) resolve(parseOllamaList(out));
              else reject(new Error(`ollama list exited ${code}: ${errOut.trim()}`));
            });
          stream.stderr.on("data", (d) => { errOut += d; });
        });
      })
      .on("error", reject)
      .connect({
        host: process.env.OLLAMA_SSH_HOST,
        port: Number(process.env.OLLAMA_SSH_PORT),
        username: process.env.OLLAMA_SSH_USER,
        password: process.env.OLLAMA_SSH_PASSWORD,
        hostVerifier: hostVerifier(),
        readyTimeout: 15_000,
      });
  });
}
