#!/usr/bin/env node
// scripts/relay-server.mjs
// Zero-dependency RFC 6455 WebSocket + HTTP GATT relay for Even G2 dev loop.
//
// Endpoints:
//   GET  /healthz        -> JSON status (keep localhost-only)
//   WS   /ws/device      -> browser Chrome tab holding the paired Web Bluetooth device
//   WS   /ws/controller  -> local CLI runner (keep localhost-only)
//
// Security: only forwards structured JSON GATT commands (write/notify/status) — no eval/code exec.

import crypto from "node:crypto";
import http from "node:http";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Minimal RFC 6455 WebSocket connection wrapper over a raw net.Socket. */
class WsConn {
  constructor(socket, onMessage, onClose) {
    this.socket = socket;
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.buf = Buffer.alloc(0);
    this.fragOpcode = 0;
    this.fragChunks = [];
    this.closed = false;

    socket.on("data", (chunk) => this.#onData(chunk));
    socket.on("close", () => this.#cleanup());
    socket.on("error", () => this.#cleanup());
  }

  #cleanup() {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.();
  }

  #writeFrame(opcode, payloadBuf) {
    if (this.closed || this.socket.destroyed) return;
    const len = payloadBuf.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode;
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    this.socket.write(Buffer.concat([header, payloadBuf]));
  }

  sendJson(obj) {
    this.#writeFrame(0x1, Buffer.from(JSON.stringify(obj), "utf8"));
  }

  ping() {
    this.#writeFrame(0x9, Buffer.alloc(0));
  }

  close(code = 1000, reason = "") {
    if (this.closed) return;
    const reasonBuf = Buffer.from(reason, "utf8");
    const body = Buffer.alloc(2 + reasonBuf.length);
    body.writeUInt16BE(code, 0);
    reasonBuf.copy(body, 2);
    this.#writeFrame(0x8, body);
    this.socket.end();
    this.#cleanup();
  }

  #onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 2) {
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;

      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        off = 10;
      }
      if (len > 1024 * 1024) {
        this.close(1009, "Message too large");
        return;
      }
      const need = off + (masked ? 4 : 0) + len;
      if (this.buf.length < need) return;

      let payload;
      if (masked) {
        const mask = this.buf.subarray(off, off + 4);
        const raw = this.buf.subarray(off + 4, need);
        payload = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) payload[i] = raw[i] ^ mask[i & 3];
      } else {
        payload = Buffer.from(this.buf.subarray(off, need));
      }
      this.buf = this.buf.subarray(need);

      if (opcode === 0x8) {
        this.close(1000);
        return;
      } else if (opcode === 0x9) {
        this.#writeFrame(0xa, payload); // pong
      } else if (opcode === 0xa) {
        // pong received
      } else if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
        if (opcode !== 0x0) {
          this.fragOpcode = opcode;
          this.fragChunks = [payload];
        } else {
          this.fragChunks.push(payload);
        }
        if (fin) {
          const full = this.fragChunks.length === 1 ? this.fragChunks[0] : Buffer.concat(this.fragChunks);
          this.fragChunks = [];
          if (this.fragOpcode === 0x1) {
            try {
              this.onMessage?.(JSON.parse(full.toString("utf8")));
            } catch {
              this.sendJson({ type: "error", error: "Invalid JSON" });
            }
          }
        }
      }
    }
  }
}

export function createRelayServer({ host = "127.0.0.1", port = 18130, pingIntervalMs = 25000 } = {}) {
  let deviceConn = null;
  let deviceName = null;
  let deviceBleReady = false;
  let controllerConn = null;

  const statusPayload = () => ({
    type: "status",
    deviceConnected: Boolean(deviceConn && deviceBleReady),
    deviceName: deviceBleReady ? deviceName : null,
    controllerConnected: Boolean(controllerConn),
  });

  const server = http.createServer((req, res) => {
    const urlPath = (req.url || "/").split("?")[0];
    if (req.method === "GET" && urlPath === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: true, ...statusPayload() }));
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });

  server.on("upgrade", (req, socket) => {
    const urlPath = (req.url || "/").split("?")[0];
    const key = req.headers["sec-websocket-key"];
    if (!key || (urlPath !== "/ws/device" && urlPath !== "/ws/controller")) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    socket.setNoDelay(true);

    if (urlPath === "/ws/device") {
      if (deviceConn) deviceConn.close(1000, "Replaced by newer browser tab");
      deviceBleReady = false;
      deviceName = null;
      const conn = new WsConn(
        socket,
        (msg) => {
          if (msg.type === "device_ready") {
            deviceBleReady = true;
            deviceName = String(msg.name || "Even G2");
            controllerConn?.sendJson(statusPayload());
          } else if (msg.type === "device_disconnected") {
            deviceBleReady = false;
            deviceName = null;
            controllerConn?.sendJson({ type: "device_disconnected" });
            controllerConn?.sendJson(statusPayload());
          } else if (msg.type === "notify" || msg.type === "write_ok" || msg.type === "write_err") {
            controllerConn?.sendJson(msg);
          }
        },
        () => {
          if (deviceConn === conn) {
            deviceConn = null;
            const wasReady = deviceBleReady;
            deviceBleReady = false;
            deviceName = null;
            if (wasReady) controllerConn?.sendJson({ type: "device_disconnected" });
            controllerConn?.sendJson(statusPayload());
          }
        }
      );
      deviceConn = conn;
      conn.sendJson({ type: "relay_hello", controllerConnected: Boolean(controllerConn) });
    } else if (urlPath === "/ws/controller") {
      if (controllerConn) controllerConn.close(1000, "Replaced by newer controller");
      const conn = new WsConn(
        socket,
        (msg) => {
          if (msg.type === "status") {
            conn.sendJson(statusPayload());
            return;
          }
          if (msg.type === "write") {
            if (!deviceConn || !deviceBleReady) {
              conn.sendJson({ type: "write_err", id: msg.id, error: "No BLE device connected via relay" });
              return;
            }
            if (typeof msg.hex !== "string" || msg.hex.length > 2048) {
              conn.sendJson({ type: "write_err", id: msg.id, error: "Invalid hex payload" });
              return;
            }
            deviceConn.sendJson({ type: "write", id: msg.id, hex: msg.hex });
          } else if (msg.type === "disconnect_ble") {
            deviceConn?.sendJson({ type: "disconnect_ble" });
          }
        },
        () => {
          if (controllerConn === conn) {
            controllerConn = null;
            deviceConn?.sendJson({ type: "controller_status", connected: false });
          }
        }
      );
      controllerConn = conn;
      conn.sendJson(statusPayload());
      deviceConn?.sendJson({ type: "controller_status", connected: true });
    }
  });

  // Keepalive pings keep WebSockets alive through Cloudflare Tunnel (100s idle limit).
  const pingTimer = pingIntervalMs > 0
    ? setInterval(() => {
        deviceConn?.ping();
        controllerConn?.ping();
      }, pingIntervalMs)
    : null;
  pingTimer?.unref?.();

  return {
    server,
    start: () =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          const addr = server.address();
          resolve({ host: addr.address, port: addr.port });
        });
      }),
    stop: () =>
      new Promise((resolve) => {
        if (pingTimer) clearInterval(pingTimer);
        deviceConn?.close(1001, "Server stopping");
        controllerConn?.close(1001, "Server stopping");
        server.close(() => resolve());
      }),
  };
}

// Run standalone when invoked directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const host = process.env.HOST || "127.0.0.1";
  const port = Number(process.env.PORT || 18130);
  const relay = createRelayServer({ host, port });
  const addr = await relay.start();
  console.log(`[even-relay] listening on http://${addr.host}:${addr.port}`);
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, async () => {
      await relay.stop();
      process.exit(0);
    });
  }
}
