// test/mock-g2.mjs
// Independent mock G2 BLE peripheral for testing G2 client state-machine behavior,
// concurrency, write serialization, link-speed timing, and error/disconnect handling.
// Uses test/independent-codec.mjs only (zero shared parsers with g2.js / image.js).

import {
  EVENHUB_ENVELOPE_SCHEMA,
  StrictFrameReassembler,
  buildResponseFrames,
  decodeStrict,
  encodeProto,
  parseBmp4bppStrict,
  parseProtoRaw,
} from "./independent-codec.mjs";

const UUID_SERVICE = "00002760-08c2-11e1-9073-0e8ac72e5450";
const UUID_WRITE = "00002760-08c2-11e1-9073-0e8ac72e5401";
const UUID_NOTIFY = "00002760-08c2-11e1-9073-0e8ac72e5402";

const utf8 = new TextEncoder();

export class MockG2Peripheral {
  constructor({
    name = "Even G2_01_R_MOCK01",
    firmware = "2.4.0.24-mock",
    battery = 87,
    bytesPerSec = 0,         // 0 = instant; >0 simulates BLE link throughput per write
    ackDelayMs = 2,
    dropFirstImageStream = true,
  } = {}) {
    this.name = name;
    this.firmware = firmware;
    this.battery = battery;
    this.bytesPerSec = bytesPerSec;
    this.ackDelayMs = ackDelayMs;
    this.dropFirstImageStream = dropFirstImageStream;

    // Fault-injection hooks
    this.failNextWrites = 0;
    this.dropImageAckPredicate = null;   // ({ sessionId, fragmentIndex, containerName }) => boolean
    this.dropImageDataPredicate = null;  // ({ sessionId, fragmentIndex, containerName }) => boolean
    this.errorReplyForCmd = new Map();   // cmd -> errorCode (one-shot)

    // Observable peripheral state
    this.rx = new StrictFrameReassembler();
    this.txSeq = 1;
    this.receivedMessages = [];
    this.interleaveErrors = [];
    this.pageLive = false;
    this.containers = new Map();     // name -> container spec
    this.renderedImages = new Map(); // name -> { width, height, pixels, sessionId }
    this.imageStreams = new Map();   // `${name}:${sessionId}` -> { totalSize, chunks: Map }
    this.seenImageStreams = new Map(); // name -> count of completed streams since container creation
    this.imu = { enabled: false, pace: 0 };
    this.heartbeats = 0;

    this._connected = false;
    this._deviceListeners = new EventTarget();
    this._notifyListeners = new EventTarget();
    this._writeChar = this.#makeWriteChar();
    this._notifyChar = this.#makeNotifyChar();
    this.device = this.#makeDevice();
  }

  #makeDevice() {
    const self = this;
    return {
      name: this.name,
      addEventListener: (t, fn) => self._deviceListeners.addEventListener(t, fn),
      removeEventListener: (t, fn) => self._deviceListeners.removeEventListener(t, fn),
      gatt: {
        get connected() { return self._connected; },
        async connect() {
          self._connected = true;
          return {
            async getPrimaryServices() {
              return [{
                uuid: UUID_SERVICE,
                async getCharacteristics() {
                  return [self._writeChar, self._notifyChar];
                },
              }];
            },
          };
        },
        disconnect() {
          if (!self._connected) return;
          self._connected = false;
          self._deviceListeners.dispatchEvent(new Event("gattserverdisconnected"));
        },
      },
    };
  }

  #makeWriteChar() {
    const self = this;
    return {
      uuid: UUID_WRITE,
      async writeValueWithoutResponse(raw) {
        if (!self._connected) throw new Error("GATT Server is disconnected");
        if (self.failNextWrites > 0) {
          self.failNextWrites--;
          throw new Error("Simulated GATT write failure");
        }
        const bytes = raw instanceof Uint8Array ? new Uint8Array(raw) : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
        if (self.bytesPerSec > 0) {
          const ms = (bytes.length / self.bytesPerSec) * 1000;
          if (ms > 0) await new Promise((r) => setTimeout(r, ms));
        }
        if (!self._connected) return;
        let msg;
        try {
          msg = self.rx.push(bytes);
        } catch (err) {
          self.interleaveErrors.push(err.message);
          throw err;
        }
        if (msg) self.#handleMessage(msg);
      },
    };
  }

  #makeNotifyChar() {
    const self = this;
    return {
      uuid: UUID_NOTIFY,
      addEventListener: (t, fn) => self._notifyListeners.addEventListener(t, fn),
      removeEventListener: (t, fn) => self._notifyListeners.removeEventListener(t, fn),
      async startNotifications() { return this; },
    };
  }

  #emitNotify(sid, flag, payload, delayMs = this.ackDelayMs) {
    const seq = this.txSeq;
    this.txSeq = (this.txSeq + 1) & 0xff;
    const pkts = buildResponseFrames(payload, { seq, sid, flag });
    const sendNow = () => {
      if (!this._connected) return;
      for (const p of pkts) {
        const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
        const ev = new Event("characteristicvaluechanged");
        Object.defineProperty(ev, "target", { value: { value: dv } });
        this._notifyListeners.dispatchEvent(ev);
      }
    };
    if (delayMs > 0) setTimeout(sendNow, delayMs);
    else sendNow();
  }

  #handleMessage({ sid, flag, payload, rawBodyLength }) {
    this.receivedMessages.push({ sid, flag, payload, rawBodyLength });

    if (sid === 0x80) {
      // Echo magic from field 2
      const raw = parseProtoRaw(payload);
      const magic = Number(raw.find((e) => e.field === 2)?.value ?? 0);
      this.#emitNotify(0x80, 0x00, encodeProto([[1, "uint", 1], [2, "uint", magic]]));
      return;
    }

    if (sid === 0x01) {
      const raw = parseProtoRaw(payload);
      const magic = Number(raw.find((e) => e.field === 2)?.value ?? 156);
      this.#emitNotify(0x01, 0x00, encodeProto([[1, "uint", 2], [2, "uint", magic]]));
      return;
    }

    if (sid === 0x09) {
      const raw = parseProtoRaw(payload);
      const magic = Number(raw.find((e) => e.field === 2)?.value ?? 0);
      const reply = encodeProto([
        [1, "uint", 2],
        [2, "uint", magic],
        [4, "message", [
          [6, "string", this.firmware],
          [12, "uint", this.battery],
          [13, "uint", 0],
        ]],
      ]);
      this.#emitNotify(0x09, 0x00, reply);
      return;
    }

    if (sid !== 0xe0) return;

    const env = decodeStrict(payload, EVENHUB_ENVELOPE_SCHEMA);
    const cmd = env.Cmd ?? 0;
    const magic = env.MagicRandom ?? 0;
    if (magic >= 256) throw new Error(`MagicRandom ${magic} >= 256`);

    // One-shot error injection
    if (this.errorReplyForCmd.has(cmd)) {
      const code = this.errorReplyForCmd.get(cmd);
      this.errorReplyForCmd.delete(cmd);
      const resFieldMap = { 0: 4, 3: 6, 5: 10, 7: 8, 9: 12 };
      const resCmdMap = { 0: 1, 3: 4, 5: 6, 7: 8, 9: 10 };
      this.#emitNotify(0xe0, 0x00, encodeProto([
        [1, "uint", resCmdMap[cmd] ?? cmd + 1],
        [2, "uint", magic],
        [resFieldMap[cmd] ?? 4, "message", [[1, "uint", code]]],
      ]));
      return;
    }

    if (cmd === 0) {
      this.#applyPage(env.CreateMessage);
      this.pageLive = true;
      this.#emitNotify(0xe0, 0x00, encodeProto([[1, "uint", 1], [2, "uint", magic], [4, "message", [[1, "uint", 0]]]]));
    } else if (cmd === 7) {
      this.#applyPage(env.RebuildContainer);
      this.pageLive = true;
      this.#emitNotify(0xe0, 0x00, encodeProto([[1, "uint", 8], [2, "uint", magic], [8, "message", [[1, "uint", 6]]]]));
    } else if (cmd === 5) {
      const u = env.TextUpgrade;
      const target = this.containers.get(u.ContainerName);
      if (!target || target.kind !== "text") {
        this.#emitNotify(0xe0, 0x00, encodeProto([[1, "uint", 6], [2, "uint", magic], [10, "message", [[1, "uint", 9]]]]));
        return;
      }
      target.Content = u.Content ?? "";
      this.#emitNotify(0xe0, 0x00, encodeProto([[1, "uint", 6], [2, "uint", magic], [10, "message", [[1, "uint", 8]]]]));
    } else if (cmd === 3) {
      const img = env.ImgRawMsg;
      const name = img.ContainerName;
      const sessionId = img.MapSessionId ?? 0;
      const fragmentIndex = img.MapFragmentIndex ?? 0;
      const data = img.MapRawData ?? new Uint8Array();
      if (utf8.encode(name).length > 14) throw new Error(`Image container name > 14 UTF-8 bytes: ${name}`);
      if (data.length > 4096) {
        this.#emitNotify(0xe0, 0x00, encodeProto([[1, "uint", 4], [2, "uint", magic], [6, "message", [[1, "uint", 5]]]]));
        return;
      }

      const dropData = this.dropImageDataPredicate?.({ sessionId, fragmentIndex, containerName: name }) ?? false;
      if (!dropData) {
        const key = `${name}:${sessionId}`;
        if (!this.imageStreams.has(key)) {
          this.imageStreams.set(key, { totalSize: img.MapTotalSize, chunks: new Map() });
        }
        const st = this.imageStreams.get(key);
        st.chunks.set(fragmentIndex, data);
        let assembledSize = 0;
        for (const c of st.chunks.values()) assembledSize += c.length;
        if (assembledSize >= st.totalSize) {
          const ordered = [...st.chunks.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
          const full = new Uint8Array(assembledSize);
          let off = 0;
          for (const c of ordered) { full.set(c, off); off += c.length; }
          const parsed = parseBmp4bppStrict(full);
          const count = (this.seenImageStreams.get(name) ?? 0) + 1;
          this.seenImageStreams.set(name, count);
          if (!(this.dropFirstImageStream && count === 1)) {
            this.renderedImages.set(name, { ...parsed, sessionId });
          }
          this.imageStreams.delete(key);
        }
      }

      const dropAck = this.dropImageAckPredicate?.({ sessionId, fragmentIndex, containerName: name }) ?? false;
      if (!dropAck) {
        this.#emitNotify(0xe0, 0x00, encodeProto([[1, "uint", 4], [2, "uint", magic], [6, "message", [[1, "uint", 4]]]]));
      }
    } else if (cmd === 9) {
      this.pageLive = false;
      this.containers.clear();
      this.renderedImages.clear();
      this.seenImageStreams.clear();
      this.#emitNotify(0xe0, 0x00, encodeProto([[1, "uint", 10], [2, "uint", magic], [12, "message", [[1, "uint", 10]]]]));
    } else if (cmd === 12) {
      this.heartbeats++;
      this.#emitNotify(0xe0, 0x00, encodeProto([
        [1, "uint", 13],
        [2, "uint", magic],
        [15, "message", [[1, "uint", env.HeartPacketCmd?.Cnt ?? 0], [2, "uint", 12]]],
      ]));
    } else if (cmd === 19) {
      this.imu = { enabled: Boolean(env.ImuCtrl?.IMUReportEn), pace: env.ImuCtrl?.reportFrq ?? 0 };
      this.#emitNotify(0xe0, 0x00, encodeProto([[1, "uint", 20], [2, "uint", magic], [23, "message", [[1, "uint", this.imu.enabled ? 1 : 0]]]]));
    }
  }

  #applyPage(pageMsg) {
    this.containers.clear();
    this.renderedImages.clear();
    this.seenImageStreams.clear();
    this.imageStreams.clear();
    for (const l of pageMsg.ListObject ?? []) {
      if (utf8.encode(l.ContainerName).length > 14) throw new Error(`Name > 14 UTF-8 bytes: ${l.ContainerName}`);
      this.containers.set(l.ContainerName, { kind: "list", ...l });
    }
    for (const t of pageMsg.TextObject ?? []) {
      if (utf8.encode(t.ContainerName).length > 14) throw new Error(`Name > 14 UTF-8 bytes: ${t.ContainerName}`);
      this.containers.set(t.ContainerName, { kind: "text", ...t });
    }
    for (const img of pageMsg.ImageObject ?? []) {
      if (utf8.encode(img.ContainerName).length > 14) throw new Error(`Name > 14 UTF-8 bytes: ${img.ContainerName}`);
      this.containers.set(img.ContainerName, { kind: "image", ...img });
    }
  }

  /** Push a simulated system event (e.g. 7 = system-exit, 9 = long-press) to the connected host. */
  pushSysEvent(eventType, source = 1, imu = null) {
    const sys = [[1, "uint", eventType], [2, "uint", source]];
    if (imu) sys.push([3, "message", [[1, "float", imu.x], [2, "float", imu.y], [3, "float", imu.z]]]);
    const payload = encodeProto([[1, "uint", 2], [13, "message", [[3, "message", sys]]]]);
    this.#emitNotify(0xe0, 0x01, payload, 0);
  }

  /** Push a simulated list tap/scroll event. */
  pushListEvent({ containerId = 1, containerName, itemName, itemIndex = 0, eventType = 0 }) {
    const payload = encodeProto([
      [1, "uint", 2],
      [13, "message", [[1, "message", [
        [1, "uint", containerId],
        [2, "string", containerName],
        [3, "string", itemName],
        [4, "uint", itemIndex],
        [5, "uint", eventType],
      ]]]],
    ]);
    this.#emitNotify(0xe0, 0x01, payload, 0);
  }
}
