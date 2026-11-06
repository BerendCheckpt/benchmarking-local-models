// Runs one command on an SSH host. ssh2 instead of the ssh binary: the binary
// only takes a password from a terminal, and the container has none.
//
// Each host has its own env prefix (OLLAMA_SSH, QA_SESSIONS_SSH):
//   <P>_HOST, <P>_PORT, <P>_USER, <P>_HOSTKEY_SHA256 (optional pin)
//   <P>_PASSWORD, or <P>_KEY_FILE (+ optional <P>_KEY_PASSPHRASE)
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import net from "node:net";
import { Client } from "ssh2";

/** OpenSSH-style "SHA256:..." fingerprint of a raw host key. */
export function fingerprint(key) {
  return "SHA256:" + createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
}

export class SshTarget {
  /** `ClientClass` is ssh2's Client; a test passes a fake. */
  constructor(prefix, env = process.env, ClientClass = Client) {
    this.prefix = prefix;
    this.env = env;
    this.Client = ClientClass;
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
      const conn = new this.Client();
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

  /**
   * An SSH tunnel to `remotePort` on the host's loopback (`ssh -L` without the
   * binary). Resolves `{ port, close() }`: connect to 127.0.0.1:port here.
   * Same login and host-key pin as exec.
   */
  tunnel(remotePort) {
    return new Promise((resolve, reject) => {
      let options;
      try { options = this.connectOptions(); } catch (err) { return reject(err); }
      const conn = new this.Client();
      const server = net.createServer((socket) => {
        conn.forwardOut("127.0.0.1", 0, "127.0.0.1", remotePort, (err, channel) => {
          if (err) return socket.destroy(err);
          socket.pipe(channel).pipe(socket);
          socket.on("error", () => channel.close());
          channel.on("error", () => socket.destroy());
        });
      });
      const close = () => new Promise((done) => { server.close(() => done()); conn.end(); });
      conn
        .on("ready", () => {
          server.on("error", (err) => { conn.end(); reject(err); });
          server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, close }));
        })
        .on("error", reject)
        .connect(options);
    });
  }

  /**
   * Uploads local files over SFTP in one connection: `files` is
   * `[{ local, remote }]`. Same login and host-key pin as exec. Each remote
   * folder must exist (create it with exec first).
   */
  put(files) {
    return new Promise((resolve, reject) => {
      let options;
      try { options = this.connectOptions(); } catch (err) { return reject(err); }
      const conn = new this.Client();
      conn
        .on("ready", () => {
          conn.sftp(async (err, sftp) => {
            if (err) { conn.end(); return reject(err); }
            try {
              for (const { local, remote } of files) {
                await new Promise((ok, fail) => sftp.fastPut(local, remote, (e) => (e ? fail(new Error(`${remote}: ${e.message}`)) : ok())));
              }
              conn.end();
              resolve(files.map((f) => f.remote));
            } catch (e) {
              conn.end();
              reject(e);
            }
          });
        })
        .on("error", reject)
        .connect(options);
    });
  }
}
