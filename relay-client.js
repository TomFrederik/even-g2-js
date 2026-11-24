// relay-client.js: Browser-side GATT-over-WebSocket relay for Even G2 dev loop.
// Zero dependencies. Pure ES module (MIT).
//
// Keeps a single Web Bluetooth pairing open in Chrome while exposing ONLY raw GATT
// write/notify forwarding over an outbound WebSocket to the relay server (`/ws/device`).
// If the relay server restarts, the WebSocket reconnects automatically without dropping BLE.

import { UUIDS } from "./g2.js";

function toHex(u8) {
  let out = "";
  for (let i = 0; i < u8.length; i++) out += u8[i].toString(16).padStart(2, "0");
  return out;
}

function fromHex(hex) {
  if (hex.length % 2 !== 0) throw new Error("Odd hex length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export class GattRelayClient extends EventTarget {
  #device = null;
  #writeChar = null;
  #notifyChar = null;
  #ws = null;
  #wsUrl = "";
  #stopped = false;
  #reconnectTimer = null;
  #reconnectDelayMs = 1000;
  #onNotify = null;
  #onBleDisconnect = null;

  txCount = 0;
  rxCount = 0;
  controllerConnected = false;

  get wsConnected() { return this.#ws?.readyState === WebSocket.OPEN; }
  get bleConnected() { return Boolean(this.#device?.gatt?.connected); }
  get deviceName() { return this.#device?.name ?? ""; }

  #emitState() {
    this.dispatchEvent(new CustomEvent("state", {
      detail: {
        bleConnected: this.bleConnected,
        wsConnected: this.wsConnected,
        controllerConnected: this.controllerConnected,
        deviceName: this.deviceName,
        txCount: this.txCount,
        rxCount: this.rxCount,
      },
    }));
  }

  #log(msg) {
    this.dispatchEvent(new CustomEvent("log", { detail: msg }));
  }

  /**
   * Pair a real G2 via Chrome Web Bluetooth and start relaying to `wsUrl`.
   */
  async pairAndStart({ wsUrl, namePrefix } = {}) {
    if (typeof navigator === "undefined" || !navigator.bluetooth) {
      throw new Error("Web Bluetooth is not available in this browser");
    }
    const device = await navigator.bluetooth.requestDevice({
      filters: namePrefix ? [{ namePrefix }] : [{ namePrefix: "Even G2" }, { namePrefix: "G2_" }],
      optionalServices: UUIDS.services,
    });
    return this.attachDevice(device, { wsUrl });
  }

  /**
   * Attach an already-selected BluetoothDevice (or MockG2Peripheral.device) and open the relay WS.
   */
  async attachDevice(device, { wsUrl } = {}) {
    this.stop();
    this.#stopped = false;
    this.txCount = 0;
    this.rxCount = 0;
    this.#device = device;
    this.#wsUrl = wsUrl || `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws/device`;

    this.#onBleDisconnect = () => {
      this.#log(`BLE disconnected (${device.name || "device"})`);
      this.#sendWs({ type: "device_disconnected" });
      this.#emitState();
    };
    device.addEventListener("gattserverdisconnected", this.#onBleDisconnect);

    const server = await device.gatt.connect();
    for (const s of await server.getPrimaryServices()) {
      for (const c of await s.getCharacteristics().catch(() => [])) {
        if (c.uuid === UUIDS.write) this.#writeChar = c;
        if (c.uuid === UUIDS.notify) this.#notifyChar = c;
      }
    }
    if (!this.#writeChar || !this.#notifyChar) {
      throw new Error("Selected BLE device has no G2 5401/5402 characteristics");
    }

    this.#onNotify = (e) => {
      const v = e.target.value;
      const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      this.rxCount++;
      this.#sendWs({ type: "notify", hex: toHex(bytes), ts: Date.now() });
      this.#emitState();
    };
    this.#notifyChar.addEventListener("characteristicvaluechanged", this.#onNotify);
    await this.#notifyChar.startNotifications();

    this.#log(`BLE paired: ${device.name || "Even G2"} (ready for CLI relay)`);
    this.#connectWs();
    this.#emitState();
  }

  #sendWs(obj) {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify(obj));
    }
  }

  #connectWs() {
    if (this.#stopped) return;
    clearTimeout(this.#reconnectTimer);
    const ws = new WebSocket(this.#wsUrl);
    this.#ws = ws;

    ws.addEventListener("open", () => {
      this.#reconnectDelayMs = 1000;
      this.#log(`Relay WS connected (${this.#wsUrl})`);
      if (this.bleConnected) {
        this.#sendWs({ type: "device_ready", name: this.deviceName });
      }
      this.#emitState();
    });

    ws.addEventListener("message", async (ev) => {
      let msg;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.type === "relay_hello") {
        this.controllerConnected = Boolean(msg.controllerConnected);
        this.#emitState();
      } else if (msg.type === "controller_status") {
        this.controllerConnected = Boolean(msg.connected);
        this.#log(this.controllerConnected ? "CLI controller attached" : "CLI controller detached");
        this.#emitState();
      } else if (msg.type === "write") {
        try {
          if (!this.bleConnected) throw new Error("BLE disconnected");
          await this.#writeChar.writeValueWithoutResponse(fromHex(msg.hex));
          this.txCount++;
          this.#sendWs({ type: "write_ok", id: msg.id });
          this.#emitState();
        } catch (err) {
          this.#sendWs({ type: "write_err", id: msg.id, error: err?.message || String(err) });
        }
      } else if (msg.type === "disconnect_ble") {
        this.#device?.gatt?.disconnect();
      }
    });

    ws.addEventListener("close", () => {
      if (this.#ws === ws) this.#ws = null;
      this.controllerConnected = false;
      this.#emitState();
      if (!this.#stopped && this.bleConnected) {
        const delay = this.#reconnectDelayMs;
        this.#reconnectDelayMs = Math.min(5000, Math.round(delay * 1.5));
        this.#log(`Relay WS closed; reconnecting in ${delay} ms (BLE stays paired)`);
        this.#reconnectTimer = setTimeout(() => this.#connectWs(), delay);
      }
    });

    ws.addEventListener("error", () => {
      // close event handles reconnect
    });
  }

  stop({ disconnectBle = true } = {}) {
    this.#stopped = true;
    clearTimeout(this.#reconnectTimer);
    if (this.#ws) {
      try { this.#ws.close(1000, "Stopped"); } catch {}
      this.#ws = null;
    }
    if (this.#notifyChar && this.#onNotify) {
      this.#notifyChar.removeEventListener("characteristicvaluechanged", this.#onNotify);
    }
    if (this.#device && this.#onBleDisconnect) {
      this.#device.removeEventListener("gattserverdisconnected", this.#onBleDisconnect);
    }
    if (disconnectBle && this.#device?.gatt?.connected) {
      try { this.#device.gatt.disconnect(); } catch {}
    }
    this.#writeChar = null;
    this.#notifyChar = null;
    this.#device = null;
    this.controllerConnected = false;
    this.#emitState();
  }
}
