// scripts/remote-device.mjs
// Adapts the localhost relay (`/ws/controller`) into a standard Web Bluetooth
// BluetoothDevice interface so `G2.fromDevice(remote.device)` runs unmodified from Node
// against real G2 glasses paired in a Chrome tab.

import { UUIDS } from "../g2.js";

function toHex(u8) {
  let out = "";
  for (let i = 0; i < u8.length; i++) out += u8[i].toString(16).padStart(2, "0");
  return out;
}

function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export class RemoteG2Device {
  #ws;
  #nextId = 1;
  #pendingWrites = new Map();
  #deviceEvents = new EventTarget();
  #notifyEvents = new EventTarget();
  #connected = false;
  #name = "Even G2 (remote)";

  constructor(ws, initialStatus) {
    this.#ws = ws;
    this.#connected = Boolean(initialStatus.deviceConnected);
    this.#name = initialStatus.deviceName || "Even G2 (remote)";

    ws.addEventListener("message", (ev) => {
      let msg;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.type === "write_ok") {
        const p = this.#pendingWrites.get(msg.id);
        if (p) { this.#pendingWrites.delete(msg.id); p.resolve(); }
      } else if (msg.type === "write_err") {
        const p = this.#pendingWrites.get(msg.id);
        if (p) { this.#pendingWrites.delete(msg.id); p.reject(new Error(msg.error || "Remote write failed")); }
      } else if (msg.type === "notify") {
        const bytes = fromHex(msg.hex);
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const e = new Event("characteristicvaluechanged");
        Object.defineProperty(e, "target", { value: { value: dv } });
        this.#notifyEvents.dispatchEvent(e);
      } else if (msg.type === "device_disconnected") {
        this.#markDisconnected("Remote BLE device disconnected");
      } else if (msg.type === "status" && msg.deviceConnected) {
        this.#name = msg.deviceName || this.#name;
      }
    });

    ws.addEventListener("close", () => {
      this.#markDisconnected("Relay WebSocket closed");
    });

    const self = this;
    const writeChar = {
      uuid: UUIDS.write,
      writeValueWithoutResponse(raw) {
        if (!self.#connected || self.#ws.readyState !== WebSocket.OPEN) {
          return Promise.reject(new Error("Remote BLE device not connected"));
        }
        const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
        const id = self.#nextId++;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            if (self.#pendingWrites.delete(id)) reject(new Error("Remote write ack timed out"));
          }, 10000);
          self.#pendingWrites.set(id, {
            resolve: () => { clearTimeout(timer); resolve(); },
            reject: (err) => { clearTimeout(timer); reject(err); },
          });
          self.#ws.send(JSON.stringify({ type: "write", id, hex: toHex(bytes) }));
        });
      },
    };
    const notifyChar = {
      uuid: UUIDS.notify,
      addEventListener: (t, fn) => self.#notifyEvents.addEventListener(t, fn),
      removeEventListener: (t, fn) => self.#notifyEvents.removeEventListener(t, fn),
      async startNotifications() { return this; },
    };

    this.device = {
      get name() { return self.#name; },
      addEventListener: (t, fn) => self.#deviceEvents.addEventListener(t, fn),
      removeEventListener: (t, fn) => self.#deviceEvents.removeEventListener(t, fn),
      gatt: {
        get connected() { return self.#connected; },
        async connect() {
          if (!self.#connected) throw new Error("No G2 device paired in browser relay tab");
          return {
            async getPrimaryServices() {
              return [{
                uuid: UUIDS.services[1],
                async getCharacteristics() { return [writeChar, notifyChar]; },
              }];
            },
          };
        },
        disconnect() {
          // Only detach the CLI controller WS — keep the browser tab's BLE pairing alive!
          self.close();
        },
      },
    };
  }

  #markDisconnected(reason) {
    if (!this.#connected) return;
    this.#connected = false;
    const err = new Error(reason);
    for (const p of this.#pendingWrites.values()) p.reject(err);
    this.#pendingWrites.clear();
    this.#deviceEvents.dispatchEvent(new Event("gattserverdisconnected"));
  }

  close() {
    this.#markDisconnected("Controller detached");
    if (this.#ws.readyState === WebSocket.OPEN || this.#ws.readyState === WebSocket.CONNECTING) {
      this.#ws.close(1000, "Done");
    }
  }

  static async connect({ url = "ws://127.0.0.1:18130/ws/controller", waitDeviceMs = 5000 } = {}) {
    const ws = new WebSocket(url);
    const status = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`Timed out connecting to relay at ${url}`));
      }, waitDeviceMs);

      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`Could not connect to relay at ${url} (is even-relay.service running?)`));
      });

      ws.addEventListener("message", function onFirst(ev) {
        let msg;
        try { msg = JSON.parse(String(ev.data)); } catch { return; }
        if (msg.type === "status") {
          if (msg.deviceConnected) {
            ws.removeEventListener("message", onFirst);
            clearTimeout(timer);
            resolve(msg);
          }
        }
      });
    });
    return new RemoteG2Device(ws, status);
  }
}
