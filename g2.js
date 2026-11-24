// g2.js: drive Even Realities G2 glasses from a web page over Web Bluetooth.
// Zero dependencies. Works in Chrome / Edge on macOS, Windows, Linux and Android
// (not Safari or iOS). The page must be served over https or from localhost.
//
// Forked from mrahtz/even-g2-js (MIT) and extended with multi-container pages,
// borders/padding, 4-bpp BMP image streaming, shutdown, and IMU control.

import {
  G2_HEIGHT,
  G2_WIDTH,
  MAX_IMAGE_FRAGMENT_BYTES,
  buildBlankBmp4bpp,
  canvasToBmp4bpp,
  fnv1a32,
  gray8ToBmp4bpp,
  isBmp,
  planImageFragments,
  readBmpHeader,
  rgbaToBmp4bpp,
  rgbaToTiles,
} from "./image.js";

export * from "./image.js";

// ---------------------------------------------------------------- framing

const uuid = (suffix) => `00002760-08c2-11e1-9073-0e8ac72e${suffix}`;
export const UUIDS = {
  write: uuid("5401"),
  notify: uuid("5402"),
  // Services the characteristics may live under; Web Bluetooth needs them listed up front.
  services: ["0000", "5450", "6450", "7450"].map(uuid),
};

export const SID = { app: 0x01, settings: 0x09, stateChange: 0x0d, handshake: 0x80, evenHub: 0xe0 };
const FLAG_REQUEST = 0x20;
const FLAG_NOTIFY = 0x01;

export const G2_LIMITS = {
  width: G2_WIDTH,
  height: G2_HEIGHT,
  maxContainers: 12,
  maxText: 8,
  maxImage: 4,
  maxNameBytes: 14,
  maxTextBytes: 990,
  maxListItems: 20,
  minImageWidth: 20,
  maxImageWidth: 288,
  minImageHeight: 20,
  maxImageHeight: 144,
  maxImageFragmentBytes: MAX_IMAGE_FRAGMENT_BYTES,
};

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

/** CRC-16/CCITT-FALSE. */
export function crc16(bytes) {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let k = 0; k < 8; k++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/** Splits a payload into `aa 21` frames; every fragment shares `seq`, CRC on the last. */
export function frames(payload, { seq, sid, flag = FLAG_REQUEST, chunk = 200 }) {
  const crc = crc16(payload);
  const body = new Uint8Array(payload.length + 2);
  body.set(payload);
  body[payload.length] = crc & 0xff;
  body[payload.length + 1] = crc >> 8;
  const total = Math.max(1, Math.ceil(body.length / chunk));
  const out = [];
  for (let i = 0; i < total; i++) {
    const piece = body.subarray(i * chunk, Math.min(body.length, (i + 1) * chunk));
    const f = new Uint8Array(8 + piece.length);
    f.set([0xaa, 0x21, seq & 0xff, piece.length, total, i + 1, sid, flag]);
    f.set(piece, 8);
    out.push(f);
  }
  return out;
}

class Reassembler {
  pending = new Map();

  /** Returns { sid, flag, seq, payload } once a whole message has arrived. */
  push(raw) {
    if (raw.length < 8 || raw[0] !== 0xaa || (raw[1] !== 0x12 && raw[1] !== 0x21)) return null;
    const [, , seq, len, total, index, sid, flag] = raw;
    const chunk = raw.subarray(8, 8 + len);
    let body;
    if (total <= 1) {
      body = chunk;
    } else {
      if (index === 1 || !this.pending.has(seq)) this.pending.set(seq, { total, parts: new Map() });
      const p = this.pending.get(seq);
      p.parts.set(index, chunk);
      if (p.parts.size < p.total) return null;
      this.pending.delete(seq);
      const parts = [...Array(p.total).keys()].map((i) => p.parts.get(i + 1) ?? new Uint8Array());
      body = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
      let o = 0;
      for (const x of parts) { body.set(x, o); o += x.length; }
    }
    if (body.length < 2) return null;
    return { sid, flag, seq, payload: body.subarray(0, body.length - 2) };
  }
}

// ---------------------------------------------------------------- protobuf

/** Minimal proto3 writer. Set `explicitZeros: true` to emit 0-valued scalars explicitly for hardware A/B testing. */
class PB {
  bytes = [];
  explicitZeros = false;
  constructor(explicitZeros = false) { this.explicitZeros = explicitZeros; }
  static build(fn, { explicitZeros = false } = {}) {
    const w = new PB(explicitZeros);
    fn(w);
    return new Uint8Array(w.bytes);
  }
  varint(v) {
    let n = BigInt(v);
    while (n >= 0x80n) { this.bytes.push(Number(n & 0x7fn) | 0x80); n >>= 7n; }
    this.bytes.push(Number(n));
  }
  key(field, wire) { this.varint((field << 3) | wire); }
  uint(field, v, { force = false } = {}) {
    if (v || force || this.explicitZeros) { this.key(field, 0); this.varint(v ?? 0); }
    return this;
  }
  bool(field, v, opts) { return this.uint(field, v ? 1 : 0, opts); }
  raw(field, data) { this.key(field, 2); this.varint(data.length); for (let i = 0; i < data.length; i++) this.bytes.push(data[i]); return this; }
  bytesField(field, data) { if (data && data.length > 0) this.raw(field, data); return this; }
  string(field, s) { if (s) this.raw(field, utf8Encoder.encode(s)); return this; }
  message(field, fn) { return this.raw(field, PB.build(fn, { explicitZeros: this.explicitZeros })); }
}

/** Decodes a protobuf message into field -> [values]. Bytes values stay Uint8Array. */
export function decode(buf) {
  const fields = new Map();
  let i = 0;
  const varint = () => {
    let v = 0n, s = 0n;
    while (i < buf.length) {
      const c = buf[i++];
      v |= BigInt(c & 0x7f) << s;
      if (!(c & 0x80)) return v;
      s += 7n;
    }
    throw new Error("truncated varint");
  };
  const add = (f, v) => { if (!fields.has(f)) fields.set(f, []); fields.get(f).push(v); };
  try {
    while (i < buf.length) {
      const k = Number(varint());
      const f = k >> 3, wire = k & 7;
      if (wire === 0) add(f, Number(varint()));
      else if (wire === 2) { const n = Number(varint()); add(f, buf.subarray(i, i + n)); i += n; }
      else if (wire === 5) { add(f, new DataView(buf.buffer, buf.byteOffset + i, 4).getFloat32(0, true)); i += 4; }
      else if (wire === 1) { add(f, new DataView(buf.buffer, buf.byteOffset + i, 8).getFloat64(0, true)); i += 8; }
      else return null;
    }
  } catch { return null; }
  const last = (f) => fields.get(f)?.at(-1);
  return {
    fields,
    has: (f) => fields.has(f),
    uint: (f) => (typeof last(f) === "number" ? last(f) : 0),
    num: (f) => (typeof last(f) === "number" ? last(f) : 0),
    string: (f) => (last(f) instanceof Uint8Array ? utf8Decoder.decode(last(f)) : ""),
    bytes: (f) => (last(f) instanceof Uint8Array ? last(f) : new Uint8Array()),
    message: (f) => (last(f) instanceof Uint8Array ? decode(last(f)) : null),
    messages: (f) => (fields.get(f) ?? []).filter((v) => v instanceof Uint8Array).map((v) => decode(v)),
    strings: (f) => (fields.get(f) ?? []).filter((v) => v instanceof Uint8Array).map((v) => utf8Decoder.decode(v)),
  };
}

// ---------------------------------------------------------------- validation & messages

const W = G2_WIDTH, H = G2_HEIGHT;

export const Cmd = {
  create: 0,
  createResponse: 1,
  deviceEvent: 2,
  imageRawData: 3,
  imageRawDataResponse: 4,
  textUpgrade: 5,
  textUpgradeResponse: 6,
  rebuild: 7,
  rebuildResponse: 8,
  shutDown: 9,
  shutDownResponse: 10,
  privateEvent: 11,
  heartbeat: 12,
  heartbeatResponse: 13,
  privateSystemEvent: 14,
  audioControl: 15,
  audioControlResponse: 16,
  imuControl: 19,
  imuControlResponse: 20,
};

/**
 * EvenHub reply status codes (aligned with EvenHub_ErrorCode_List).
 * Failure codes are explicitly listed so non-zero success codes (4, 6, 8, 10, 12, 13)
 * and error codes (1, 2, 3, 5, 7, 9, 11, 14) are handled accurately.
 */
export const ERROR_CODES = new Set([1, 2, 3, 5, 7, 9, 11, 14]);
export const REPLY_STATUS_NAMES = {
  0: "create_success",
  1: "create_invalid_container",
  2: "create_oversize",
  3: "create_out_of_memory",
  4: "image_update_success",
  5: "image_update_failed",
  6: "rebuild_success",
  7: "rebuild_failed",
  8: "text_upgrade_success",
  9: "text_upgrade_failed",
  10: "shutdown_success",
  11: "shutdown_failed",
  12: "heartbeat_success",
  13: "audio_ctrl_success",
  14: "audio_ctrl_failed",
};

/** Inspect an EvenHub response protobuf (field `resField` -> field 1 `ResCmdMsg`). */
export function readReplyStatus(pb, resField) {
  if (!pb) return { ok: false, code: null, reason: "timeout" };
  const sub = pb.message(resField);
  if (!sub) return { ok: true, code: 0, reason: "ok" };
  const code = sub.uint(1);
  if (ERROR_CODES.has(code)) {
    return { ok: false, code, reason: REPLY_STATUS_NAMES[code] ?? `error_${code}` };
  }
  return { ok: true, code, reason: REPLY_STATUS_NAMES[code] ?? `code_${code}` };
}

function truncateUtf8(str, maxBytes = G2_LIMITS.maxTextBytes) {
  let s = str || " ";
  while (utf8Encoder.encode(s).length > maxBytes) s = s.slice(0, -1);
  return s;
}

function assertName(name) {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("Container name is required");
  }
  const byteLen = utf8Encoder.encode(name).length;
  if (byteLen > G2_LIMITS.maxNameBytes) {
    throw new Error(`Container name "${name}" is ${byteLen} UTF-8 bytes (max ${G2_LIMITS.maxNameBytes})`);
  }
}

/**
 * Validate and normalize a multi-container page specification:
 * `{ texts?: [...], lists?: [...], images?: [...] }`.
 */
export function validatePage(spec = {}) {
  const rawTexts = spec.texts ?? [];
  const rawLists = spec.lists ?? [];
  const rawImages = spec.images ?? [];
  const total = rawTexts.length + rawLists.length + rawImages.length;

  if (total < 1 || total > G2_LIMITS.maxContainers) {
    throw new RangeError(`Page must contain 1..${G2_LIMITS.maxContainers} containers, got ${total}`);
  }
  if (rawTexts.length > G2_LIMITS.maxText) {
    throw new RangeError(`At most ${G2_LIMITS.maxText} text containers allowed, got ${rawTexts.length}`);
  }
  if (rawImages.length > G2_LIMITS.maxImage) {
    throw new RangeError(`At most ${G2_LIMITS.maxImage} image containers allowed, got ${rawImages.length}`);
  }

  const usedIds = new Set();
  const usedNames = new Set();
  let autoId = 1;
  const allocId = (given) => {
    let id = given;
    if (id == null) {
      while (usedIds.has(autoId)) autoId++;
      id = autoId++;
    }
    if (!Number.isInteger(id) || id < 1) throw new RangeError(`Invalid container id: ${id}`);
    if (usedIds.has(id)) throw new Error(`Duplicate container id: ${id}`);
    usedIds.add(id);
    return id;
  };
  const registerName = (given, fallback) => {
    const name = given ?? fallback;
    assertName(name);
    if (usedNames.has(name)) throw new Error(`Duplicate container name: "${name}"`);
    usedNames.add(name);
    return name;
  };

  let captureCount = 0;

  const lists = rawLists.map((l, idx) => {
    const id = allocId(l.id);
    const name = registerName(l.name, `list-${idx + 1}`);
    const items = (l.items ?? []).map(String);
    if (items.length === 0 || items.length > G2_LIMITS.maxListItems) {
      throw new RangeError(`List "${name}" must have 1..${G2_LIMITS.maxListItems} items, got ${items.length}`);
    }
    const capture = l.capture ?? false;
    if (capture) captureCount++;
    return {
      kind: "list",
      id,
      name,
      x: l.x ?? 0,
      y: l.y ?? 0,
      width: l.width ?? W,
      height: l.height ?? H,
      borderWidth: l.borderWidth ?? 0,
      borderColor: l.borderColor ?? 0,
      borderRadius: l.borderRadius ?? 0,
      paddingLength: l.paddingLength ?? 0,
      itemWidth: l.itemWidth ?? 0,
      selectionBorder: l.selectionBorder ?? true,
      items,
      capture,
    };
  });

  const texts = rawTexts.map((t, idx) => {
    const id = allocId(t.id);
    const name = registerName(t.name, `text-${idx + 1}`);
    const content = truncateUtf8(String(t.content ?? " "), G2_LIMITS.maxTextBytes);
    const capture = t.capture ?? false;
    if (capture) captureCount++;
    return {
      kind: "text",
      id,
      name,
      x: t.x ?? 0,
      y: t.y ?? 0,
      width: t.width ?? W,
      height: t.height ?? H,
      borderWidth: t.borderWidth ?? 0,
      borderColor: t.borderColor ?? 0,
      borderRadius: t.borderRadius ?? 0,
      paddingLength: t.paddingLength ?? 0,
      content,
      capture,
    };
  });

  const images = rawImages.map((img, idx) => {
    const id = allocId(img.id);
    const name = registerName(img.name, `img-${idx + 1}`);
    const width = img.width ?? 144;
    const height = img.height ?? 112;
    if (width < G2_LIMITS.minImageWidth || width > G2_LIMITS.maxImageWidth) {
      throw new RangeError(`Image "${name}" width ${width} out of range (${G2_LIMITS.minImageWidth}..${G2_LIMITS.maxImageWidth})`);
    }
    if (height < G2_LIMITS.minImageHeight || height > G2_LIMITS.maxImageHeight) {
      throw new RangeError(`Image "${name}" height ${height} out of range (${G2_LIMITS.minImageHeight}..${G2_LIMITS.maxImageHeight})`);
    }
    return {
      kind: "image",
      id,
      name,
      x: img.x ?? 0,
      y: img.y ?? 0,
      width,
      height,
    };
  });

  if (captureCount > 1) {
    throw new Error(`At most one container per page may set capture: true (got ${captureCount})`);
  }

  return { total, lists, texts, images };
}

const hub = (cmd, magic, fn = () => {}, opts = {}) =>
  PB.build((w) => { w.uint(1, cmd).uint(2, magic); fn(w); }, opts);

function encodeTextObject(m, t) {
  m.uint(1, t.x)
    .uint(2, t.y)
    .uint(3, t.width)
    .uint(4, t.height)
    .uint(5, t.borderWidth)
    .uint(6, t.borderColor)
    .uint(7, t.borderRadius)
    .uint(8, t.paddingLength)
    .uint(9, t.id)
    .string(10, t.name)
    .bool(11, t.capture)
    .string(12, t.content);
}

function encodeListObject(m, l) {
  m.uint(1, l.x)
    .uint(2, l.y)
    .uint(3, l.width)
    .uint(4, l.height)
    .uint(5, l.borderWidth)
    .uint(6, l.borderColor)
    .uint(7, l.borderRadius)
    .uint(8, l.paddingLength)
    .uint(9, l.id)
    .string(10, l.name)
    .message(11, (it) => {
      it.uint(1, l.items.length)
        .uint(2, l.itemWidth)
        .bool(3, l.selectionBorder !== false);
      for (const s of l.items) it.string(4, s);
    })
    .bool(12, l.capture);
}

function encodeImageObject(m, img) {
  m.uint(1, img.x)
    .uint(2, img.y)
    .uint(3, img.width)
    .uint(4, img.height)
    .uint(5, img.id)
    .string(6, img.name);
}

export const msg = {
  createPage: (magic, pageSpec, { widgetId = 10000, explicitZeros = false } = {}) => {
    const p = pageSpec.total != null ? pageSpec : validatePage(pageSpec);
    return hub(Cmd.create, magic, (w) => w.message(3, (m) => {
      m.uint(1, p.total);
      for (const l of p.lists) m.message(2, (o) => encodeListObject(o, l));
      for (const t of p.texts) m.message(3, (o) => encodeTextObject(o, t));
      for (const img of p.images) m.message(4, (o) => encodeImageObject(o, img));
      m.uint(5, widgetId);
    }), { explicitZeros });
  },
  rebuildPage: (magic, pageSpec, { explicitZeros = false } = {}) => {
    const p = pageSpec.total != null ? pageSpec : validatePage(pageSpec);
    return hub(Cmd.rebuild, magic, (w) => w.message(7, (m) => {
      m.uint(1, p.total);
      for (const l of p.lists) m.message(2, (o) => encodeListObject(o, l));
      for (const t of p.texts) m.message(3, (o) => encodeTextObject(o, t));
      for (const img of p.images) m.message(4, (o) => encodeImageObject(o, img));
    }), { explicitZeros });
  },
  textUpgrade: (magic, idOrName, content, { id = 1, offset = 0, explicitZeros = false } = {}) => {
    const opts = typeof idOrName === "object"
      ? idOrName
      : { id, name: idOrName, content, offset, explicitZeros };
    assertName(opts.name);
    const body = opts.content ?? " ";
    const byteLen = utf8Encoder.encode(body).length;
    return hub(Cmd.textUpgrade, magic, (w) => w.message(9, (m) => {
      m.uint(1, opts.id ?? 1)
        .string(2, opts.name)
        .uint(3, opts.offset ?? 0)
        .uint(4, byteLen)
        .string(5, body);
    }), { explicitZeros: Boolean(opts.explicitZeros) });
  },
  imageRawData: (
    magic,
    { id, name, sessionId, totalSize, compressMode = 0, fragmentIndex = 0, data, explicitZeros = false }
  ) => {
    assertName(name);
    if (data.length > MAX_IMAGE_FRAGMENT_BYTES) {
      throw new RangeError(`Image fragment ${data.length} B exceeds firmware cap of ${MAX_IMAGE_FRAGMENT_BYTES} B`);
    }
    return hub(Cmd.imageRawData, magic, (w) => w.message(5, (m) => {
      m.uint(1, id)
        .string(2, name)
        .uint(3, sessionId)
        .uint(4, totalSize)
        .uint(5, compressMode)
        .uint(6, fragmentIndex)
        .uint(7, data.length)
        .bytesField(8, data);
    }), { explicitZeros });
  },
  shutDown: (magic, exitMode = 0, { explicitZeros = false } = {}) =>
    hub(Cmd.shutDown, magic, (w) => w.message(11, (m) => {
      m.uint(1, exitMode);
    }), { explicitZeros }),
  imuControl: (magic, enabled, reportFrq = 500, { explicitZeros = false } = {}) =>
    hub(Cmd.imuControl, magic, (w) => w.message(22, (m) => {
      m.uint(1, enabled ? 1 : 0).uint(2, reportFrq);
    }), { explicitZeros }),
  heartbeat: (magic, cnt = 0, { explicitZeros = false } = {}) =>
    hub(Cmd.heartbeat, magic, (w) => w.message(14, (m) => {
      m.uint(1, cnt);
    }), { explicitZeros }),
  statusQuery: (magic) => PB.build((w) => w.uint(1, 2).uint(2, magic).message(4, (m) => m.uint(1, 1))),
};

/** The Even app's sid=0x80 start-up exchange; without it the glasses drop the link after ~27 s. */
function handshake(now = Date.now()) {
  const clock = (magic) => PB.build((w) => w.uint(1, 128).uint(2, magic).message(128, (m) => {
    m.uint(1, Math.floor(now / 1000)).uint(2, 0xffffffffffffffe8n);
  }));
  return [
    [0x00, new Uint8Array([0x08, 0x04, 0x10, 0x0c, 0x1a, 0x04, 0x08, 0x01, 0x10, 0x04])],
    [0x20, new Uint8Array([0x08, 0x05, 0x10, 0x0e, 0x22, 0x02, 0x08, 0x02])],
    [0x20, clock(0x0f)],
    [0x00, new Uint8Array([0x08, 0x04, 0x10, 0x10, 0x1a, 0x04, 0x08, 0x01, 0x10, 0x04])],
    [0x00, new Uint8Array([0x08, 0x04, 0x10, 0x11, 0x1a, 0x04, 0x08, 0x01, 0x10, 0x04])],
    [0x20, new Uint8Array([0x08, 0x05, 0x10, 0x12, 0x22, 0x02, 0x08, 0x01])],
    [0x20, clock(0x13)],
  ];
}

/** sid=0x01 app-launch, verbatim from an Even app capture. Its ack echoes 156. */
export const PRELUDE = new Uint8Array([
  0xaa, 0x21, 0x92, 0x13, 0x01, 0x01, 0x01, 0x20, 0x08, 0x02, 0x10, 0x9c, 0x01, 0x22, 0x0a, 0x1a,
  0x08, 0x12, 0x06, 0x12, 0x04, 0x08, 0x00, 0x10, 0x00, 0xa1, 0x42,
]);

export const GESTURES = [
  "tap",
  "swipe-back",
  "swipe-forward",
  "double-tap",
  "foreground-enter",
  "foreground-exit",
  "abnormal-exit",
  "system-exit",
  "motion",
  "long-press",
  "long-press-release",
];
const SOURCES = ["unknown", "right temple", "ring", "left temple"];

/** Decodes an async EvenHub event into { type, source?, container?, containerId?, index?, item?, motion? }. */
export function decodeEvent(payload) {
  const pb = decode(payload);
  if (!pb || pb.uint(1) !== Cmd.deviceEvent) return null;
  const dev = pb.message(13);
  if (!dev) return null;
  const list = dev.message(1), text = dev.message(2), sys = dev.message(3);
  if (list) {
    return {
      type: GESTURES[list.uint(5)] ?? `unknown(${list.uint(5)})`,
      containerId: list.uint(1),
      container: list.string(2),
      index: list.uint(4),
      item: list.string(3),
    };
  }
  if (text) {
    return {
      type: GESTURES[text.uint(3)] ?? `unknown(${text.uint(3)})`,
      containerId: text.uint(1),
      container: text.string(2),
    };
  }
  if (sys) {
    const ev = {
      type: GESTURES[sys.uint(1)] ?? `unknown(${sys.uint(1)})`,
      source: SOURCES[sys.uint(2)] ?? "unknown",
    };
    const imu = sys.message(3);
    if (imu) ev.motion = { x: imu.num(1), y: imu.num(2), z: imu.num(3) };
    return ev;
  }
  return { type: "tap", source: "unknown" };
}

function toHex(u8) {
  let out = "";
  for (let i = 0; i < u8.length; i++) out += u8[i].toString(16).padStart(2, "0");
  return out;
}

// ---------------------------------------------------------------- session

/**
 * A connected pair of glasses (right temple). Events:
 *   "gesture"     detail: { type, source?, container?, containerId?, index?, item?, motion? }
 *   "status"      detail: { battery, charging, firmware }
 *   "disconnect"
 *   "log"         detail: string (protocol-level diagnostics)
 *   "trace"       detail: { dir: "tx" | "rx", ts, hex }
 */
export class G2 extends EventTarget {
  #device; #write; #notify;
  #seq = 0x40; #magic = 100;
  #waiters = new Map();
  #writing = Promise.resolve();
  #opQueue = Promise.resolve();
  #rx = new Reassembler();
  #heartbeat = null;
  #heartbeatMs = 5000;
  #explicitZeros = false;
  #textName = ""; #flip = false; #pageLive = false;
  #pageEpoch = 0;
  #pendingText = null; #textBusy = null;
  #pendingContainerText = new Map(); #containerTextBusy = new Map();
  #animation = null;
  #containers = new Map();   // key (id or name) -> normalized container spec
  #imageState = new Map();   // container name -> { warmedUp, lastHash }
  #imageSessionId = 1;
  #fullImageActive = false;
  #traceEnabled = false;
  status = null;

  static get supported() { return typeof navigator !== "undefined" && !!navigator.bluetooth; }

  /** Opens the browser's device picker (must run from a user gesture) and connects. */
  static async connect({ log, namePrefix, trace, heartbeatMs, explicitZeros } = {}) {
    if (!G2.supported) throw new Error("This browser has no Web Bluetooth. Use Chrome or Edge.");
    const device = await navigator.bluetooth.requestDevice({
      filters: namePrefix ? [{ namePrefix }] : [{ namePrefix: "Even G2" }, { namePrefix: "G2_" }],
      optionalServices: UUIDS.services,
    });
    return G2.fromDevice(device, { log, trace, heartbeatMs, explicitZeros });
  }

  /** Connects using an existing BluetoothDevice (or mock BluetoothDevice for tests). */
  static async fromDevice(device, { log, trace = false, heartbeatMs = 5000, explicitZeros = false } = {}) {
    const g2 = new G2();
    g2.#heartbeatMs = heartbeatMs;
    g2.#traceEnabled = Boolean(trace);
    g2.#explicitZeros = Boolean(explicitZeros);
    if (log) g2.addEventListener("log", (e) => log(e.detail));
    if (typeof trace === "function") g2.addEventListener("trace", (e) => trace(e.detail));
    await g2.#open(device);
    return g2;
  }

  /** "Even G2_32_R_EB40AF" → "Even G2_32_R_": matches this pair's right temple only. */
  static rightTemplePrefix(name) {
    const m = /^(.*G\d+_\d+_)[LR]_/i.exec(name ?? "");
    return m ? `${m[1]}R_` : null;
  }

  get name() { return this.#device?.name ?? ""; }
  get connected() { return !!this.#device?.gatt.connected; }
  get pageLive() { return this.#pageLive; }
  get imageSessionId() { return this.#imageSessionId; }
  get explicitZeros() { return this.#explicitZeros; }
  set explicitZeros(v) { this.#explicitZeros = Boolean(v); }

  #log(s) { this.dispatchEvent(new CustomEvent("log", { detail: s })); }
  #emitTrace(dir, bytes) {
    if (!this.#traceEnabled) return;
    this.dispatchEvent(new CustomEvent("trace", { detail: { dir, ts: Date.now(), hex: toHex(bytes) } }));
  }
  #nextMagic() { this.#magic = this.#magic >= 255 ? 100 : this.#magic + 1; return this.#magic; }

  /** Serializes page/image/lifecycle mutations so overlapping calls never race container state. */
  #enqueueOp(fn) {
    const run = this.#opQueue.then(fn, fn);
    this.#opQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  async #open(device) {
    this.#device = device;
    if (/_L_/i.test(device.name ?? "")) {
      this.#log("That's the left temple; events and the display session live on the right one (…_R_…).");
    }
    device.addEventListener("gattserverdisconnected", () => this.#closed());
    const server = await device.gatt.connect();
    for (const s of await server.getPrimaryServices()) {
      for (const c of await s.getCharacteristics().catch(() => [])) {
        if (c.uuid === UUIDS.write) this.#write = c;
        if (c.uuid === UUIDS.notify) this.#notify = c;
      }
    }
    if (!this.#write || !this.#notify) {
      throw new Error("These don't look like G2 glasses (no 5401/5402 characteristics).");
    }
    this.#notify.addEventListener("characteristicvaluechanged", (e) => {
      const v = e.target.value;
      const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      this.#emitTrace("rx", bytes);
      this.#received(bytes);
    });
    await this.#notify.startNotifications();
    await this.#startSession();
    if (this.#heartbeatMs > 0) {
      this.#heartbeat = setInterval(() => {
        if (!this.#pageLive || !this.connected) return;
        const m = this.#nextMagic();
        this.#send(SID.evenHub, msg.heartbeat(m, 0, { explicitZeros: this.#explicitZeros }), m, { timeout: 2000 }).catch(() => {});
      }, this.#heartbeatMs);
    }
    this.refreshStatus().catch(() => {});
  }

  async #startSession() {
    let acked = 0;
    for (const [flag, payload] of handshake()) {
      if (await this.#send(SID.handshake, payload, decode(payload).uint(2), { flag, timeout: 1000 })) acked++;
    }
    this.#log(`handshake ${acked}/7 acknowledged`);
    const launch = this.#registerWaiter(SID.app, 156);
    await this.#writeFrames([PRELUDE]);
    if (!(await launch.wait(4000))) {
      throw new Error("The glasses didn't accept the session. Are they connected to another app or phone?");
    }
    const m = this.#nextMagic();
    const bootPage = validatePage({ lists: [{ id: 1, name: "g2web", items: ["G2 web"], capture: true }] });
    const ack = await this.#send(SID.evenHub, msg.createPage(m, bootPage, { explicitZeros: this.#explicitZeros }), m, { timeout: 4000 });
    const st = readReplyStatus(ack, 4);
    if (!st.ok) throw new Error(`Startup page creation failed: ${st.reason}`);
    this.#pageLive = true;
    this.#textName = "";
    this.#fullImageActive = false;
    this.#registerContainers(bootPage);
  }

  #registerContainers(page) {
    this.#pageEpoch++;
    this.#containers.clear();
    this.#imageState.clear();
    this.#pendingContainerText.clear();
    for (const c of [...page.lists, ...page.texts, ...page.images]) {
      this.#containers.set(c.id, c);
      this.#containers.set(c.name, c);
      if (c.kind === "image") {
        this.#imageState.set(c.name, { warmedUp: false, lastHash: null });
      }
    }
  }

  #resetPageState() {
    this.#pageEpoch++;
    this.#pageLive = false;
    this.#textName = "";
    this.#fullImageActive = false;
    this.#containers.clear();
    this.#imageState.clear();
    this.#pendingContainerText.clear();
  }

  #closed() {
    clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    this.stop();
    this.#resetPageState();
    const err = new Error("Disconnected");
    for (const w of this.#waiters.values()) w.fail(err);
    this.#waiters.clear();
    this.dispatchEvent(new Event("disconnect"));
  }

  disconnect() { this.#device?.gatt.disconnect(); }

  /** Serializes multi-fragment frame groups so heartbeats / other writes cannot interleave mid-message. */
  #writeFrames(list) {
    const run = this.#writing.then(async () => {
      if (!this.connected) throw new Error("not connected");
      for (const f of list) {
        this.#emitTrace("tx", f);
        await this.#write.writeValueWithoutResponse(f);
      }
    });
    this.#writing = run.catch(() => {});
    return run;
  }

  /**
   * Registers a reply waiter BEFORE writing (so fast synchronous/local replies aren't missed),
   * but starts the timeout clock ONLY when `wait(ms)` is called AFTER the BLE write finishes.
   */
  #registerWaiter(sid, magic) {
    const key = `${sid}:${magic}`;
    this.#waiters.get(key)?.resolve(null);

    let settled = false;
    let value = null;
    let error = null;
    let timer = null;
    let onSettle = null;

    const entry = {
      resolve(reply) {
        if (settled) return;
        settled = true;
        value = reply;
        clearTimeout(timer);
        if (onSettle) onSettle();
      },
      fail(err) {
        if (settled) return;
        settled = true;
        error = err;
        clearTimeout(timer);
        if (onSettle) onSettle();
      },
    };
    this.#waiters.set(key, entry);

    return {
      cancel: () => {
        if (this.#waiters.get(key) === entry) this.#waiters.delete(key);
        clearTimeout(timer);
      },
      wait: (timeoutMs) => {
        if (settled) return error ? Promise.reject(error) : Promise.resolve(value);
        return new Promise((resolve, reject) => {
          onSettle = () => (error ? reject(error) : resolve(value));
          timer = setTimeout(() => {
            if (this.#waiters.get(key) === entry) this.#waiters.delete(key);
            entry.resolve(null);
          }, timeoutMs);
        });
      },
    };
  }

  /**
   * Sends a payload and resolves with the decoded reply (null on timeout, rejects on disconnect / write error).
   * Timeout starts AFTER the BLE frames finish transmitting through `#writeFrames`.
   */
  async #send(sid, payload, magic, { flag = FLAG_REQUEST, timeout = 3000 } = {}) {
    if (!this.connected) throw new Error("not connected");
    const waiter = this.#registerWaiter(sid, magic);
    const seq = this.#seq;
    this.#seq = (this.#seq + 1) & 0xff;
    try {
      await this.#writeFrames(frames(payload, { seq, sid, flag }));
    } catch (err) {
      waiter.cancel();
      throw err;
    }
    return waiter.wait(timeout);
  }

  #received(raw) {
    const m = this.#rx.push(raw);
    if (!m) return;
    const pb = decode(m.payload);
    if (m.flag !== FLAG_NOTIFY && pb?.has(2)) {
      const key = `${m.sid}:${pb.uint(2)}`;
      const w = this.#waiters.get(key);
      if (w) { this.#waiters.delete(key); w.resolve(pb); return; }
    }
    if (m.flag !== FLAG_NOTIFY && m.flag !== 0x06) return;
    if (m.sid === SID.evenHub) {
      const ev = decodeEvent(m.payload);
      if (!ev) return;
      if (ev.type === "system-exit" || ev.type === "abnormal-exit") {
        this.#resetPageState();
      }
      this.dispatchEvent(new CustomEvent("gesture", { detail: ev }));
    } else if (m.sid === SID.settings) {
      this.refreshStatus().catch(() => {});
    }
  }

  // -------------------------------------------------------------- display (multi-container + legacy)

  async #ensurePage() { if (!this.#pageLive) await this.#startSession(); }

  /**
   * Declare a multi-container page (up to 12 containers total: ≤ 8 text, ≤ 4 image, lists).
   * Serialized against in-flight image/page operations so container state never races.
   */
  setPage(spec, { timeout = 4000 } = {}) {
    const page = validatePage(spec);
    return this.#enqueueOp(async () => {
      this.stop();
      await this.#textBusy;
      await this.#ensurePage();
      const m = this.#nextMagic();
      const ack = await this.#send(
        SID.evenHub,
        msg.rebuildPage(m, page, { explicitZeros: this.#explicitZeros }),
        m,
        { timeout }
      );
      const st = readReplyStatus(ack, 8);
      if (!st.ok) throw new Error(`rebuildPage failed: ${st.reason}`);
      this.#textName = page.texts.length === 1 && page.lists.length === 0 && page.images.length === 0
        ? page.texts[0].name
        : "";
      this.#fullImageActive = false;
      this.#registerContainers(page);
      return { page, ack, status: st };
    });
  }

  /**
   * In-place update for a specific text container (by numeric `id` or `name`).
   * Coalesces rapid calls per container and always clears busy state on error.
   */
  updateText(target, content, { offset = 0 } = {}) {
    if (!this.#pageLive) {
      return Promise.reject(new Error("No active page (session exited or shut down); call setPage() first"));
    }
    const c = this.#containers.get(target);
    if (!c || c.kind !== "text") {
      return Promise.reject(new Error(`No active text container matching ${JSON.stringify(target)}`));
    }
    const key = `${this.#pageEpoch}:${c.name}`;
    this.#pendingContainerText.set(key, { c, content: truncateUtf8(String(content ?? " ")), offset });
    if (!this.#containerTextBusy.has(key)) {
      const run = (async () => {
        try {
          while (this.#pendingContainerText.has(key)) {
            const next = this.#pendingContainerText.get(key);
            this.#pendingContainerText.delete(key);
            const m = this.#nextMagic();
            const ack = await this.#send(
              SID.evenHub,
              msg.textUpgrade(m, {
                id: next.c.id,
                name: next.c.name,
                content: next.content,
                offset: next.offset,
                explicitZeros: this.#explicitZeros,
              }),
              m
            );
            const st = readReplyStatus(ack, 10);
            if (!st.ok) throw new Error(`updateText("${next.c.name}") failed: ${st.reason}`);
          }
        } finally {
          this.#containerTextBusy.delete(key);
        }
      })();
      this.#containerTextBusy.set(key, run);
    }
    return this.#containerTextBusy.get(key);
  }

  /**
   * Convert and dimension-check an image input (4-bpp BMP, Canvas, `{ rgba, width, height }`, or `{ gray8, width, height }`).
   */
  #normalizeBmp(source, container) {
    let bmp;
    if (isBmp(source)) {
      bmp = source;
    } else if (source && typeof source.getContext === "function") {
      bmp = canvasToBmp4bpp(source);
    } else if (source?.rgba) {
      bmp = rgbaToBmp4bpp(source.rgba, source.width ?? container.width, source.height ?? container.height);
    } else if (source?.gray8) {
      bmp = gray8ToBmp4bpp(source.gray8, source.width ?? container.width, source.height ?? container.height);
    } else {
      throw new TypeError("Unsupported image source: pass a 4-bpp BMP Uint8Array, Canvas, { rgba, width, height }, or { gray8, width, height }");
    }
    const hdr = readBmpHeader(bmp);
    if (hdr.bpp !== 4) {
      throw new RangeError(`Expected 4-bpp BMP for "${container.name}", got ${hdr.bpp}-bpp`);
    }
    if (hdr.width !== container.width || hdr.height !== container.height) {
      throw new RangeError(
        `Image dimensions ${hdr.width}x${hdr.height} do not match container "${container.name}" (${container.width}x${container.height})`
      );
    }
    return bmp;
  }

  /**
   * Stream raw 4-bpp BMP pixels into a declared image container via `Cmd=3` fragments.
   * Serialized via `#enqueueOp`; updates duplicate cache ONLY when every fragment is acked.
   */
  updateImage(
    target,
    source,
    {
      warmup = true,
      postRebuildDelayMs = 0,
      dedup = true,
      windowSize = 4,
      fragmentSize = 3800,
      maxAckMisses = 3,
      fragmentTimeoutMs = 1500,
    } = {}
  ) {
    return this.#enqueueOp(async () => {
      if (!this.#pageLive) {
        throw new Error("No active page (session exited or shut down); call setPage() first");
      }
      const c = this.#containers.get(target);
      if (!c || c.kind !== "image") {
        throw new Error(`No active image container matching ${JSON.stringify(target)}`);
      }
      const epoch = this.#pageEpoch;
      const bmp = this.#normalizeBmp(source, c);
      const st = this.#imageState.get(c.name) ?? { warmedUp: false, lastHash: null };
      const hash = fnv1a32(bmp);
      if (dedup && st.warmedUp && st.lastHash === hash) {
        return { skipped: true, warmedUp: false, bytes: bmp.length, fragments: 0, acked: 0, missed: 0, durationMs: 0 };
      }

      const t0 = performance.now();
      let didWarmup = false;
      if (!st.warmedUp && postRebuildDelayMs > 0) {
        await new Promise((r) => setTimeout(r, postRebuildDelayMs));
      }
      if (warmup && !st.warmedUp) {
        const blank = buildBlankBmp4bpp(c.width, c.height);
        await this.#streamBmp(c, blank, { windowSize, fragmentSize, maxAckMisses, fragmentTimeoutMs });
        if (this.#pageEpoch !== epoch) throw new Error("Page changed during warmup transfer");
        st.warmedUp = true;
        didWarmup = true;
      }

      const res = await this.#streamBmp(c, bmp, { windowSize, fragmentSize, maxAckMisses, fragmentTimeoutMs });
      if (this.#pageEpoch !== epoch) throw new Error("Page changed during image transfer");
      st.warmedUp = true;
      // Only cache dedup hash when every fragment was explicitly acknowledged.
      st.lastHash = res.missed === 0 ? hash : null;
      this.#imageState.set(c.name, st);
      return { ...res, skipped: false, warmedUp: didWarmup, durationMs: Math.round(performance.now() - t0) };
    });
  }

  async #streamBmp(container, bmp, { windowSize, fragmentSize, maxAckMisses, fragmentTimeoutMs }) {
    const frags = planImageFragments(bmp, fragmentSize);
    const sessionId = this.#imageSessionId;
    this.#imageSessionId++;
    const win = Math.max(1, windowSize);
    const inflight = [];
    let acked = 0;
    let totalMissed = 0;
    let consecutiveMisses = 0;

    const retireOne = async () => {
      const item = inflight.shift();
      const reply = await item.promise;
      if (!this.connected) throw new Error("Disconnected during image transfer");
      if (reply) {
        const st = readReplyStatus(reply, 6);
        if (!st.ok) {
          this.#imageSessionId = sessionId + 2;
          throw new Error(`Image fragment ${item.index} rejected for "${container.name}": ${st.reason}`);
        }
        acked++;
        consecutiveMisses = 0;
      } else {
        totalMissed++;
        consecutiveMisses++;
        if (consecutiveMisses > maxAckMisses) {
          // Ensure next session ID skips the adjacent ID (sessionId + 1) to avoid wedged firmware buffers.
          this.#imageSessionId = Math.max(this.#imageSessionId, sessionId + 2);
          throw new Error(`Image stream aborted for "${container.name}" after ${consecutiveMisses} consecutive missed acks`);
        }
      }
    };

    try {
      for (const f of frags) {
        if (!this.connected) throw new Error("not connected");
        const m = this.#nextMagic();
        const pb = msg.imageRawData(m, {
          id: container.id,
          name: container.name,
          sessionId,
          totalSize: bmp.length,
          compressMode: 0,
          fragmentIndex: f.index,
          data: f.data,
          explicitZeros: this.#explicitZeros,
        });
        const promise = this.#send(SID.evenHub, pb, m, { timeout: fragmentTimeoutMs });
        // Attach noop rejection handler while queued in window so an early failure cannot crash Node as unhandledRejection.
        promise.catch(() => {});
        inflight.push({ index: f.index, promise });
        if (inflight.length >= win) {
          await retireOne();
        }
      }
      while (inflight.length > 0) {
        await retireOne();
      }
      return { bytes: bmp.length, fragments: frags.length, acked, missed: totalMissed, sessionId };
    } catch (err) {
      await Promise.allSettled(inflight.map((i) => i.promise));
      throw err;
    }
  }

  /**
   * Render an RGBA buffer or Canvas across the full 576×288 lens using a 2×2 grid
   * of 288×144 image containers (only rebuilds page when layout changes).
   * Pass `captureOverlay: true` to include a tiny invisible text capture container for gesture testing.
   */
  async setFullImage(source, { captureOverlay = false, ...opts } = {}) {
    let rgba, width, height;
    if (source && typeof source.getContext === "function") {
      const ctx = source.getContext("2d");
      const imgData = ctx.getImageData(0, 0, source.width, source.height);
      rgba = imgData.data;
      width = imgData.width;
      height = imgData.height;
    } else if (source?.rgba) {
      rgba = source.rgba;
      width = source.width;
      height = source.height;
    } else {
      throw new TypeError("setFullImage expects a Canvas or { rgba, width, height }");
    }

    const tiles = rgbaToTiles(rgba, width, height);
    if (!this.#fullImageActive) {
      await this.setPage({
        images: tiles.map((t, i) => ({
          id: i + 1,
          name: t.name,
          x: t.x,
          y: t.y,
          width: t.width,
          height: t.height,
        })),
        texts: captureOverlay
          ? [{ id: 5, name: "img-cap", x: 0, y: 0, width: 1, height: 1, content: " ", capture: true }]
          : [],
      });
      this.#fullImageActive = true;
    }
    const results = [];
    for (const t of tiles) {
      results.push(await this.updateImage(t.name, t.bmp, opts));
    }
    return results;
  }

  /** Dismiss the active page container (`Cmd=9 ShutDown`, exitMode 0 = immediate, 1 = prompt). */
  shutdown(exitMode = 0, { timeout = 3000 } = {}) {
    return this.#enqueueOp(async () => {
      this.stop();
      await this.#textBusy;
      if (!this.connected) return null;
      const m = this.#nextMagic();
      const ack = await this.#send(
        SID.evenHub,
        msg.shutDown(m, exitMode, { explicitZeros: this.#explicitZeros }),
        m,
        { timeout }
      );
      const st = readReplyStatus(ack, 12);
      if (!st.ok) throw new Error(`shutdown failed: ${st.reason}`);
      this.#resetPageState();
      return { ack, status: st };
    });
  }

  /** Enable/disable IMU motion reporting (`Cmd=19`, reportFrq in 100..1000). */
  setImu(enabled, pace = 500, { timeout = 3000 } = {}) {
    if (pace < 100 || pace > 1000) throw new RangeError(`IMU pace must be 100..1000, got ${pace}`);
    return this.#enqueueOp(async () => {
      await this.#ensurePage();
      const m = this.#nextMagic();
      const ack = await this.#send(
        SID.evenHub,
        msg.imuControl(m, enabled, pace, { explicitZeros: this.#explicitZeros }),
        m,
        { timeout }
      );
      if (!ack) throw new Error("setImu timed out");
      const res = ack.message(23);
      return { ack, status: res ? res.uint(1) : null };
    });
  }

  /** Shows text full-lens (≈10 lines × 50 chars). Stops any animation. */
  text(content) { this.stop(); return this.#queueText(content); }

  /** Coalesces: while a frame is in flight only the newest pending text is kept. */
  #queueText(content) {
    this.#pendingText = content;
    if (!this.#textBusy) {
      this.#textBusy = (async () => {
        try {
          while (this.#pendingText !== null) {
            const next = this.#pendingText;
            this.#pendingText = null;
            await this.#renderText(next).catch((e) => this.#log(`text failed: ${e.message}`));
          }
        } finally {
          this.#textBusy = null;
        }
      })();
    }
    return this.#textBusy;
  }

  async #renderText(raw) {
    const content = truncateUtf8(raw || " ");
    await this.#ensurePage();
    if (this.#textName) {
      const m = this.#nextMagic();
      const ack = await this.#send(
        SID.evenHub,
        msg.textUpgrade(m, this.#textName, content, { explicitZeros: this.#explicitZeros }),
        m
      );
      if (ack && readReplyStatus(ack, 10).ok) return;
    }
    this.#flip = !this.#flip;
    const name = `text-${this.#flip ? "a" : "b"}`;
    const m = this.#nextMagic();
    const page = validatePage({ texts: [{ id: 1, name, content, capture: true }] });
    await this.#send(SID.evenHub, msg.rebuildPage(m, page, { explicitZeros: this.#explicitZeros }), m);
    this.#textName = name;
    this.#fullImageActive = false;
    this.#registerContainers(page);
  }

  /** Shows a selectable list (≤ 20 items); choices arrive as "gesture" events with `item`. */
  list(items) {
    return this.#enqueueOp(async () => {
      this.stop();
      await this.#textBusy;
      await this.#ensurePage();
      this.#flip = !this.#flip;
      const name = `list-${this.#flip ? "a" : "b"}`;
      const m = this.#nextMagic();
      const page = validatePage({ lists: [{ id: 1, name, items: items.slice(0, 20), capture: true }] });
      const ack = await this.#send(SID.evenHub, msg.rebuildPage(m, page, { explicitZeros: this.#explicitZeros }), m);
      const st = readReplyStatus(ack, 8);
      if (!st.ok) throw new Error(`list failed: ${st.reason}`);
      this.#textName = "";
      this.#fullImageActive = false;
      this.#registerContainers(page);
    });
  }

  clear() { return this.text(" "); }

  /** Battery and firmware; also emitted as a "status" event. */
  async refreshStatus() {
    const m = this.#nextMagic();
    const reply = await this.#send(SID.settings, msg.statusQuery(m), m, { timeout: 4000 });
    const r = reply?.message(4);
    if (!r) return this.status;
    this.status = { battery: r.uint(12), charging: !!r.uint(13), firmware: r.string(6) };
    this.dispatchEvent(new CustomEvent("status", { detail: this.status }));
    return this.status;
  }

  // -------------------------------------------------------------- animation

  /**
   * Plays an effect from `effects` (or any { fps, duration?, pausable?, frame(t, state) }).
   * A tap on the glasses pauses / resumes pausable effects. `text()` / `list()` / `setPage()` stop it.
   */
  play(effect) {
    this.stop();
    const state = { paused: false, value: 0, elapsed: 0, finished: false };
    let last = 0, lastFrame = null, timer = null;
    const onGesture = (e) => { if (e.detail.type === "tap" && effect.pausable !== false) state.paused = !state.paused; };
    this.addEventListener("gesture", onGesture);
    const tick = async () => {
      const now = performance.now();
      if (!state.paused) state.elapsed += (now - last) / 1000;
      last = now;
      if (effect.duration != null && state.elapsed >= effect.duration) { state.elapsed = effect.duration; state.finished = true; }
      const frame = effect.frame(state.elapsed, state);
      if (frame !== lastFrame) { lastFrame = frame; await this.#queueText(frame); }
      if (this.#animation?.state !== state) return;
      if (state.finished) { this.removeEventListener("gesture", onGesture); return; }
      timer = setTimeout(tick, 1000 / effect.fps);
    };
    this.#animation = { state, stop: () => { clearTimeout(timer); this.removeEventListener("gesture", onGesture); } };
    last = performance.now();
    tick();
    return state;
  }

  /** Stops the animation, leaving its last frame on the lens. */
  stop() { this.#animation?.stop(); this.#animation = null; }
}

// ---------------------------------------------------------------- effects

// Only glyphs the firmware font has (Even Hub design guidelines); others are dropped.
const ROWS = 10, COLS = 44, BAR = 24;

const page = (lines) => {
  const top = Math.max(0, Math.floor((ROWS - lines.length) / 2));
  return "\n".repeat(top) + lines.map((l) => " ".repeat(Math.max(0, Math.floor((COLS - [...l].length) / 2))) + l).join("\n");
};
const bar = (f, w = BAR) => {
  const n = Math.round(Math.min(1, Math.max(0, f)) * w);
  return "━".repeat(n) + "─".repeat(w - n);
};
const clock = (t, tenths = false) => {
  t = Math.max(0, t);
  const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = Math.floor(t) % 60;
  const p = (n) => String(n).padStart(2, "0");
  return (h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`) + (tenths ? `.${Math.floor(t * 10) % 10}` : "");
};
const paused = (s) => (s.paused ? ["", "■ paused - tap to resume"] : []);

/** Word-wraps to `cols` characters. */
export function wrap(text, cols = COLS) {
  const out = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (let w of para.split(/ +/).filter(Boolean)) {
      while (w.length > cols) { if (line) { out.push(line); line = ""; } out.push(w.slice(0, cols)); w = w.slice(cols); }
      if (!line) line = w;
      else if (line.length + 1 + w.length <= cols) line += " " + w;
      else { out.push(line); line = w; }
    }
    out.push(line);
  }
  while (out.length && !out.at(-1)) out.pop();
  return out;
}

const SPINNERS = {
  dots: ["●○○○", "○●○○", "○○●○", "○○○●", "○○●○", "○●○○"],
  bar: ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█", "▇", "▆", "▅", "▄", "▃", "▂"],
  line: ["|", "/", "─", "\\"],
  blocks: ["■□□□□", "□■□□□", "□□■□□", "□□□■□", "□□□□■", "□□□■□", "□□■□□", "□■□□□"],
  arrows: ["▶▷▷▷", "▷▶▷▷", "▷▷▶▷", "▷▷▷▶"],
};

export const effects = {
  spinner: ({ label = "", style = "dots" } = {}) => ({
    fps: 8,
    frame: (t, s) => { const f = SPINNERS[style] ?? SPINNERS.dots; const g = f[Math.floor(t * 8) % f.length]; return page(label ? [g, "", label, ...paused(s)] : [g]); },
  }),
  progress: ({ label = "", seconds } = {}) => ({
    fps: 10, duration: seconds,
    frame: (t, s) => { const f = seconds ? t / seconds : s.value; return page([label, "", bar(f), `${Math.round(Math.min(1, Math.max(0, f)) * 100)}%`, ...paused(s)]); },
  }),
  countdown: ({ seconds = 300, label = "" } = {}) => ({
    fps: 10, duration: seconds + 6,
    frame: (t, s) => {
      const left = seconds - t;
      if (left <= 0) return page([label || "Time's up", "", Math.floor(t * 2) % 2 ? "☆  TIME'S UP  ☆" : "★  TIME'S UP  ★"]);
      return page([label, "", clock(Math.ceil(left)), "", bar(left / seconds), ...paused(s)]);
    },
  }),
  stopwatch: ({ label = "" } = {}) => ({ fps: 10, frame: (t, s) => page([label, "", clock(t, true), ...paused(s)]) }),
  clock: ({ seconds = true, date = true } = {}) => ({
    fps: 4, pausable: false,
    frame: () => {
      const now = new Date();
      const ascii = (x) => x.replace(/[  ]/g, " ");
      const time = ascii(now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}) }));
      const day = ascii(now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" }));
      return page(date ? [time, "", day] : [time]);
    },
  }),
  ticker: ({ text = "", cps = 8 } = {}) => ({
    fps: Math.min(16, cps),
    frame: (t, s) => {
      const win = COLS - 4, loop = [...(" ".repeat(win) + text.replace(/\n/g, "   "))];
      const start = Math.floor(t * cps) % loop.length;
      const visible = Array.from({ length: win }, (_, i) => loop[(start + i) % loop.length]).join("");
      return page(["─".repeat(win), visible, "─".repeat(win), ...paused(s)]);
    },
  }),
  typewriter: ({ text = "", cps = 12 } = {}) => ({
    fps: Math.min(16, cps), duration: [...text].length / cps + 1.5,
    frame: (t) => {
      const chars = [...text], n = Math.min(chars.length, Math.floor(t * cps));
      const cursor = n < chars.length || Math.floor(t * 2) % 2 === 0 ? "█" : "";
      return wrap(chars.slice(0, n).join("") + cursor).slice(-(ROWS - 1)).join("\n");
    },
  }),
  breathe: ({ inhale = 4, hold = 2, exhale = 6 } = {}) => ({
    fps: 10,
    frame: (t, s) => {
      const cycle = inhale + hold + exhale + hold, p = t % cycle;
      const [word, f, left] = p < inhale ? ["Breathe in", p / inhale, inhale - p]
        : p < inhale + hold ? ["Hold", 1, inhale + hold - p]
        : p < inhale + hold + exhale ? ["Breathe out", 1 - (p - inhale - hold) / exhale, inhale + hold + exhale - p]
        : ["Hold", 0, cycle - p];
      return page([word, "", bar(f), String(Math.ceil(left)), ...paused(s)]);
    },
  }),
  equalizer: ({ label = "" } = {}) => ({
    fps: 12, pausable: false,
    frame: (t) => {
      const lv = "▁▂▃▄▅▆▇█";
      const bars = Array.from({ length: 20 }, (_, i) => {
        const v = 0.5 + 0.25 * Math.sin(t * 5.1 + i * 0.9) + 0.2 * Math.sin(t * 8.7 + i * 2.3) + 0.05 * Math.sin(t * 13 + i * 5);
        return lv[Math.min(7, Math.max(0, Math.floor(v * 8)))];
      }).join("");
      return page(label ? [bars, "", label] : [bars]);
    },
  }),
  frames: (list, { fps = 4, loop = true } = {}) => ({
    fps: Math.min(16, fps), duration: loop ? undefined : list.length / fps,
    frame: (t) => list[loop ? Math.floor(t * fps) % list.length : Math.min(list.length - 1, Math.floor(t * fps))] || " ",
  }),
};
