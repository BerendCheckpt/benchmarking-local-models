// Runs one command on an SSH host. ssh2 instead of the ssh binary: the binary
// only takes a password from a terminal, and the container has none.
//
// Each host has its own env prefix (OLLAMA_SSH, QA_SESSIONS_SSH):
//   <P>_HOST, <P>_PORT, <P>_USER, <P>_HOSTKEY_SHA256 (optional pin)
//   <P>_PASSWORD, or <P>_KEY_FILE (+ optional <P>_KEY_PASSPHRASE)
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "ssh2";

/** OpenSSH-style "SHA256:..." fingerprint of a raw host key. */
export function fingerprint(key) {
  return "SHA256:" + createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
}

export class SshTarget {
  constructor(prefix, env = process.env) {
    this.prefix = prefix;
    this.env = env;
  }

  get configured() {
    return !!this.env[`${this.prefix}_HOST`];
  }

  hostVerifier() {
    const pin = this.env[`${this.prefix}_HOSTKEY_SHA256`];
    if (!pin) return undefined;
    const want = pin.startsWith("SHA256:") ? pin : "SHA256:" + pin;
    return (key) => fingerprint(key) === want;
  }

  /** The ssh2 connect options; a key file wins over a password. */
  connectOptions() {
    const p = this.prefix, e = this.env;
    const auth = e[`${p}_KEY_FILE`]
      ? { privateKey: readFileSync(e[`${p}_KEY_FILE`]), passphrase: e[`${p}_KEY_PASSPHRASE`] || undefined }
      : { password: e[`${p}_PASSWORD`] };
    return {
      host: e[`${p}_HOST`],
      port: Number(e[`${p}_PORT`] || 22),
      username: e[`${p}_USER`],
      ...auth,
      hostVerifier: this.hostVerifier(),
      readyTimeout: 15_000,
    };
  }

  /** Runs `command`; resolves stdout as a Buffer, rejects on a non-zero exit. */
  exec(command) {
    return new Promise((resolve, reject) => {
      let options;
      try { options = this.connectOptions(); } catch (err) { return reject(err); }
      const conn = new Client();
      conn
        .on("ready", () => {
          conn.exec(command, (err, stream) => {
            if (err) { conn.end(); return reject(err); }
            const out = [], errOut = [];
            stream
              .on("data", (d) => out.push(d))
              .on("close", (code) => {
                conn.end();
                if (code === 0) resolve(Buffer.concat(out));
                else reject(new Error(`exited ${code}: ${Buffer.concat(errOut).toString("utf8").trim()}`));
              });
            stream.stderr.on("data", (d) => errOut.push(d));
          });
        })
        .on("error", reject)
        .connect(options);
    });
  }
}
