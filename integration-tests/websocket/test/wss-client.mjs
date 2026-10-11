// Phase 4 wss:// proof: this spec hosts an independent wss echo server
// (node:tls via https.createServer, with ws attached purely as a
// third-party oracle server -- mirroring how the existing specs use ws as
// the server side) on 127.0.0.1:9516, then runs the Gren `wss-app`, which
// is a PURE WebSocket client: WebSocketClient.connect("wss://...") through
// the native Gren.Kernel.Net + Gren.Kernel.Tls stack with
// rejectUnauthorized = true. The self-signed fixture certificate is passed
// to the app via NODE_EXTRA_CA_CERTS so certificate verification has a
// real anchor; the URL host (127.0.0.1) must match the cert SAN
// (IP:127.0.0.1). The app prints PASS and exits 0 on a successful echo
// roundtrip; any handshake or verification failure makes it exit 1.
import * as childProc from "node:child_process";
import * as fs from "node:fs";
import * as https from "node:https";
import * as path from "node:path";
import * as assert from "node:assert";
import { WebSocketServer } from "ws";

const WSS_PORT = 9516;
const certDir = path.resolve(import.meta.dirname, "../test/certs");

describe("WebSocket client over TLS (wss://)", function () {
  this.timeout(30000);

  let httpsServer;
  let wss;

  before(async () => {
    httpsServer = https.createServer({
      cert: fs.readFileSync(path.join(certDir, "server-good.crt")),
      key: fs.readFileSync(path.join(certDir, "server-good.key")),
    });
    wss = new WebSocketServer({ server: httpsServer });
    wss.on("connection", (socket) => {
      socket.on("message", (data, isBinary) => {
        socket.send(data, { binary: isBinary });
      });
    });
    await new Promise((resolve, reject) => {
      httpsServer.once("error", reject);
      httpsServer.listen(WSS_PORT, "127.0.0.1", resolve);
    });
  });

  after(async () => {
    if (wss) await new Promise((resolve) => wss.close(resolve));
    if (httpsServer) {
      await new Promise((resolve) => httpsServer.close(resolve));
    }
  });

  it("connects with wss://, verifies the cert chain, and roundtrips a message", async () => {
    const appPath = path.resolve(import.meta.dirname, "../wss-app");
    const output = await new Promise((resolve, reject) => {
      const child = childProc.execFile(process.execPath, [appPath], {
        timeout: 20000,
        env: {
          ...process.env,
          NODE_EXTRA_CA_CERTS: path.join(certDir, "server-good.crt"),
        },
      });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.on("exit", (code) => {
        if (code === 0) resolve(out);
        else reject(new Error(`wss-app exited with code ${code}\n${out}`));
      });
      child.on("error", reject);
    });
    assert.match(output, /PASS wss echo roundtrip/);
  });
});
