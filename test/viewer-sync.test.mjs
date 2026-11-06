import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import net from "node:net";
import { Duplex } from "node:stream";
import { syncExports, viewerSyncConfigured } from "../viewer-sync.mjs";
import { SshTarget } from "../ssh.mjs";

// Synthetic data only.
const row = (n) => ({ id: `00000000-0000-4000-8000-00000000000${n}`, session: "s", question: `q${n}`, answer: "", needs: null, asked_at: new Date(), dedup_key: `k${n}` });

test("syncExports copies only what the viewer lacks, keeps ids, and goes on after a failed row", async () => {
  const local = { asked: null, async allExcept(ids) { this.asked = ids; return [row(2), row(3), row(4)]; } };
  const copied = [];
  const remote = {
    ids: async () => [row(1).id],
    async insertStored(r) {
      if (r.question === "q3") throw new Error("boom");
      copied.push(r.id);
      return r.question !== "q4"; // q4 was already there (conflict)
    },
  };
  assert.deepEqual(await syncExports(local, remote), { copied: 1, failed: 1 });
  assert.deepEqual(local.asked, [row(1).id]);
  assert.deepEqual(copied, [row(2).id, row(4).id]);
});

test("the sync only runs with an SSH host and a database password", () => {
  assert.equal(viewerSyncConfigured({ VIEWER_SSH_HOST: "h", VIEWER_PG_PASSWORD: "p" }), true);
  assert.equal(viewerSyncConfigured({ VIEWER_SSH_HOST: "h" }), false);
  assert.equal(viewerSyncConfigured({ VIEWER_PG_PASSWORD: "p" }), false);
});

test("SshTarget.tunnel pipes a local connection through forwardOut to the remote port", async () => {
  const forwards = [];
  class FakeClient extends EventEmitter {
    connect() { setImmediate(() => this.emit("ready")); return this; }
    forwardOut(srcHost, srcPort, host, port, cb) {
      forwards.push([host, port]);
      // An echo channel: whatever goes in comes back upper-cased.
      const echo = new Duplex({
        write(chunk, _enc, done) { this.push(chunk.toString().toUpperCase()); done(); },
        read() {},
      });
      echo.close = () => echo.destroy();
      cb(null, echo);
    }
    end() { this.ended = true; }
  }
  const target = new SshTarget("V", { V_HOST: "h", V_USER: "u", V_PASSWORD: "p" }, FakeClient);
  const tunnel = await target.tunnel(5435);
  try {
    const reply = await new Promise((resolve, reject) => {
      const socket = net.connect(tunnel.port, "127.0.0.1", () => socket.write("ping"));
      socket.on("data", (d) => { resolve(d.toString()); socket.destroy(); });
      socket.on("error", reject);
    });
    assert.equal(reply, "PING");
    assert.deepEqual(forwards, [["127.0.0.1", 5435]]);
  } finally {
    await tunnel.close();
  }
});
