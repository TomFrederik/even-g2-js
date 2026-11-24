// test/independent-codec.mjs
// Standalone frame, CRC-16, protobuf, and 4-bpp BMP parsers written independently
// of g2.js and image.js so loopback tests cannot mask symmetric encode/decode bugs.

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Table-driven CRC-16/CCITT-FALSE (independent implementation from g2.js's bit loop). */
const CRC16_TABLE = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 8;
    for (let b = 0; b < 8; b++) {
      r = (r & 0x8000) ? (((r << 1) ^ 0x1021) & 0xffff) : ((r << 1) & 0xffff);
    }
    t[i] = r;
  }
  return t;
})();

export function independentCrc16(buf) {
  let crc = 0xffff;
  for (let i = 0; i < buf.length; i++) {
    crc = ((crc << 8) ^ CRC16_TABLE[((crc >> 8) ^ buf[i]) & 0xff]) & 0xffff;
  }
  return crc;
}

/**
 * Independent single-buffer BLE frame reassembler matching the G2 firmware constraint:
 * multi-fragment messages must not interleave with any other `seq` while in flight.
 */
export class StrictFrameReassembler {
  #active = null; // { seq, sid, flag, total, chunks: Map }

  push(raw) {
    if (!(raw instanceof Uint8Array) || raw.length < 8) {
      throw new Error(`Invalid BLE frame length: ${raw?.length}`);
    }
    if (raw[0] !== 0xaa || (raw[1] !== 0x21 && raw[1] !== 0x12)) {
      throw new Error(`Invalid frame magic: ${raw[0].toString(16)} ${raw[1].toString(16)}`);
    }
    const seq = raw[2];
    const len = raw[3];
    const total = raw[4];
    const index = raw[5];
    const sid = raw[6];
    const flag = raw[7];
    if (raw.length !== 8 + len) {
      throw new Error(`Frame len field (${len}) != actual payload length (${raw.length - 8})`);
    }
    if (index < 1 || index > total) {
      throw new Error(`Out-of-range fragment index ${index}/${total}`);
    }

    const piece = raw.subarray(8, 8 + len);

    if (this.#active && this.#active.seq !== seq) {
      throw new Error(
        `Interleaved BLE frame detected: seq 0x${seq.toString(16)} (sid=0x${sid.toString(16)}) ` +
        `arrived while seq 0x${this.#active.seq.toString(16)} (${this.#active.chunks.size}/${this.#active.total}) was incomplete`
      );
    }

    let body;
    if (total === 1) {
      if (this.#active) {
        throw new Error(`Single-fragment frame seq 0x${seq.toString(16)} interrupted active multi-fragment reassembly`);
      }
      body = piece;
    } else {
      if (!this.#active) {
        if (index !== 1) throw new Error(`Multi-fragment sequence started at index ${index} instead of 1`);
        this.#active = { seq, sid, flag, total, chunks: new Map() };
      }
      if (this.#active.sid !== sid || this.#active.total !== total) {
        throw new Error(`Mismatched sid/total across fragments of seq 0x${seq.toString(16)}`);
      }
      this.#active.chunks.set(index, piece);
      if (this.#active.chunks.size < total) return null;

      let totalLen = 0;
      for (let k = 1; k <= total; k++) {
        const c = this.#active.chunks.get(k);
        if (!c) throw new Error(`Missing fragment ${k}/${total} for seq 0x${seq.toString(16)}`);
        totalLen += c.length;
      }
      body = new Uint8Array(totalLen);
      let off = 0;
      for (let k = 1; k <= total; k++) {
        const c = this.#active.chunks.get(k);
        body.set(c, off);
        off += c.length;
      }
      this.#active = null;
    }

    if (body.length < 2) throw new Error("Reassembled frame missing CRC-16");
    const payload = body.subarray(0, body.length - 2);
    const gotCrc = body[body.length - 2] | (body[body.length - 1] << 8);
    const expCrc = independentCrc16(payload);
    if (gotCrc !== expCrc) {
      throw new Error(`CRC-16 mismatch: got 0x${gotCrc.toString(16)}, expected 0x${expCrc.toString(16)}`);
    }
    return { seq, sid, flag, payload, rawBodyLength: body.length };
  }
}

/** Build an `aa 21` response frame from the mock peripheral back to the host. */
export function buildResponseFrames(payload, { seq = 1, sid, flag = 0x00, chunk = 200 } = {}) {
  const crc = independentCrc16(payload);
  const body = new Uint8Array(payload.length + 2);
  body.set(payload);
  body[payload.length] = crc & 0xff;
  body[payload.length + 1] = (crc >> 8) & 0xff;
  const total = Math.max(1, Math.ceil(body.length / chunk));
  const out = [];
  for (let i = 0; i < total; i++) {
    const piece = body.subarray(i * chunk, Math.min(body.length, (i + 1) * chunk));
    const f = new Uint8Array(8 + piece.length);
    f.set([0xaa, 0x12, seq & 0xff, piece.length, total, i + 1, sid, flag]);
    f.set(piece, 8);
    out.push(f);
  }
  return out;
}

/** Independent protobuf raw parser preserving every field number, wire type, and raw occurrence order. */
export function parseProtoRaw(bytes) {
  const entries = [];
  let pos = 0;
  const readVarint = () => {
    let result = 0n;
    let shift = 0n;
    while (pos < bytes.length) {
      const b = bytes[pos++];
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result;
      shift += 7n;
      if (shift > 70n) throw new Error("Varint overflow");
    }
    throw new Error("Truncated varint");
  };

  while (pos < bytes.length) {
    const tag = Number(readVarint());
    const field = tag >>> 3;
    const wire = tag & 7;
    if (field === 0) throw new Error("Invalid protobuf field number 0");
    if (wire === 0) {
      entries.push({ field, wire, value: readVarint() });
    } else if (wire === 2) {
      const len = Number(readVarint());
      if (pos + len > bytes.length) throw new Error(`Truncated length-delimited field ${field}`);
      entries.push({ field, wire, value: bytes.slice(pos, pos + len) });
      pos += len;
    } else if (wire === 5) {
      if (pos + 4 > bytes.length) throw new Error(`Truncated 32-bit field ${field}`);
      const view = new DataView(bytes.buffer, bytes.byteOffset + pos, 4);
      entries.push({ field, wire, value: view.getFloat32(0, true) });
      pos += 4;
    } else if (wire === 1) {
      if (pos + 8 > bytes.length) throw new Error(`Truncated 64-bit field ${field}`);
      const view = new DataView(bytes.buffer, bytes.byteOffset + pos, 8);
      entries.push({ field, wire, value: view.getFloat64(0, true) });
      pos += 8;
    } else {
      throw new Error(`Unsupported wire type ${wire} on field ${field}`);
    }
  }
  return entries;
}

/**
 * Decode a protobuf message strictly against an expected field map:
 * `schema = { [fieldNum]: { name, type: "uint"|"string"|"bytes"|"message"|"float", repeated?: true, schema?: ... } }`.
 * Throws immediately on any unknown/unexpected field number or mismatched wire type at any nesting depth.
 */
export function decodeStrict(bytes, schema, path = "root") {
  const entries = parseProtoRaw(bytes);
  const out = {};
  const present = new Set();

  for (const [fStr, def] of Object.entries(schema)) {
    if (def.repeated) out[def.name] = [];
    void fStr;
  }

  for (const { field, wire, value } of entries) {
    const def = schema[field];
    if (!def) {
      throw new Error(`Unexpected protobuf field #${field} (wire=${wire}) at ${path}`);
    }
    present.add(def.name);
    let parsed;
    if (def.type === "uint") {
      if (wire !== 0) throw new Error(`Expected wire=0 for ${path}.${def.name}, got ${wire}`);
      parsed = Number(value);
    } else if (def.type === "string") {
      if (wire !== 2) throw new Error(`Expected wire=2 for ${path}.${def.name}, got ${wire}`);
      parsed = decoder.decode(value);
    } else if (def.type === "bytes") {
      if (wire !== 2) throw new Error(`Expected wire=2 for ${path}.${def.name}, got ${wire}`);
      parsed = value;
    } else if (def.type === "float") {
      if (wire !== 5) throw new Error(`Expected wire=5 for ${path}.${def.name}, got ${wire}`);
      parsed = value;
    } else if (def.type === "message") {
      if (wire !== 2) throw new Error(`Expected wire=2 for ${path}.${def.name}, got ${wire}`);
      parsed = decodeStrict(value, def.schema, `${path}.${def.name}`);
    } else {
      throw new Error(`Unknown schema type ${def.type}`);
    }
    if (def.repeated) out[def.name].push(parsed);
    else out[def.name] = parsed;
  }

  Object.defineProperty(out, "$present", { value: present, enumerable: false });
  return out;
}

/** Strict EvenHub message schemas matching the documented sid=0xe0 wire layout. */
export const LIST_ITEM_SCHEMA = {
  1: { name: "ItemCount", type: "uint" },
  2: { name: "ItemWidth", type: "uint" },
  3: { name: "IsItemSelectBorderEn", type: "uint" },
  4: { name: "ItemName", type: "string", repeated: true },
};

export const LIST_CONTAINER_SCHEMA = {
  1: { name: "XPosition", type: "uint" },
  2: { name: "YPosition", type: "uint" },
  3: { name: "Width", type: "uint" },
  4: { name: "Height", type: "uint" },
  5: { name: "BorderWidth", type: "uint" },
  6: { name: "BorderColor", type: "uint" },
  7: { name: "BorderRadius", type: "uint" },
  8: { name: "PaddingLength", type: "uint" },
  9: { name: "ContainerID", type: "uint" },
  10: { name: "ContainerName", type: "string" },
  11: { name: "ItemContainer", type: "message", schema: LIST_ITEM_SCHEMA },
  12: { name: "IsEventCapture", type: "uint" },
};

export const TEXT_CONTAINER_SCHEMA = {
  1: { name: "XPosition", type: "uint" },
  2: { name: "YPosition", type: "uint" },
  3: { name: "Width", type: "uint" },
  4: { name: "Height", type: "uint" },
  5: { name: "BorderWidth", type: "uint" },
  6: { name: "BorderColor", type: "uint" },
  7: { name: "BorderRadius", type: "uint" },
  8: { name: "PaddingLength", type: "uint" },
  9: { name: "ContainerID", type: "uint" },
  10: { name: "ContainerName", type: "string" },
  11: { name: "IsEventCapture", type: "uint" },
  12: { name: "Content", type: "string" },
};

export const IMAGE_CONTAINER_SCHEMA = {
  1: { name: "XPosition", type: "uint" },
  2: { name: "YPosition", type: "uint" },
  3: { name: "Width", type: "uint" },
  4: { name: "Height", type: "uint" },
  5: { name: "ContainerID", type: "uint" },
  6: { name: "ContainerName", type: "string" },
};

export const EVENHUB_ENVELOPE_SCHEMA = {
  1: { name: "Cmd", type: "uint" },
  2: { name: "MagicRandom", type: "uint" },
  3: {
    name: "CreateMessage",
    type: "message",
    schema: {
      1: { name: "ContainerTotalNum", type: "uint" },
      2: { name: "ListObject", type: "message", repeated: true, schema: LIST_CONTAINER_SCHEMA },
      3: { name: "TextObject", type: "message", repeated: true, schema: TEXT_CONTAINER_SCHEMA },
      4: { name: "ImageObject", type: "message", repeated: true, schema: IMAGE_CONTAINER_SCHEMA },
      5: { name: "widgetId", type: "uint" },
    },
  },
  4: { name: "StartupResCmd", type: "message", schema: { 1: { name: "ResCmdMsg", type: "uint" } } },
  5: {
    name: "ImgRawMsg",
    type: "message",
    schema: {
      1: { name: "ContainerID", type: "uint" },
      2: { name: "ContainerName", type: "string" },
      3: { name: "MapSessionId", type: "uint" },
      4: { name: "MapTotalSize", type: "uint" },
      5: { name: "CompressMode", type: "uint" },
      6: { name: "MapFragmentIndex", type: "uint" },
      7: { name: "MapFragmentPacketSize", type: "uint" },
      8: { name: "MapRawData", type: "bytes" },
    },
  },
  6: { name: "ImgResCmd", type: "message", schema: { 1: { name: "ResCmdMsg", type: "uint" } } },
  7: {
    name: "RebuildContainer",
    type: "message",
    schema: {
      1: { name: "ContainerTotalNum", type: "uint" },
      2: { name: "ListObject", type: "message", repeated: true, schema: LIST_CONTAINER_SCHEMA },
      3: { name: "TextObject", type: "message", repeated: true, schema: TEXT_CONTAINER_SCHEMA },
      4: { name: "ImageObject", type: "message", repeated: true, schema: IMAGE_CONTAINER_SCHEMA },
    },
  },
  8: { name: "RebuildResCmd", type: "message", schema: { 1: { name: "ResCmdMsg", type: "uint" } } },
  9: {
    name: "TextUpgrade",
    type: "message",
    schema: {
      1: { name: "ContainerID", type: "uint" },
      2: { name: "ContainerName", type: "string" },
      3: { name: "ContentOffset", type: "uint" },
      4: { name: "ContentLength", type: "uint" },
      5: { name: "Content", type: "string" },
    },
  },
  10: { name: "TextResCmd", type: "message", schema: { 1: { name: "ResCmdMsg", type: "uint" } } },
  11: { name: "ShutDownCmd", type: "message", schema: { 1: { name: "exitMode", type: "uint" } } },
  12: { name: "ShutDownResCmd", type: "message", schema: { 1: { name: "ResCmdMsg", type: "uint" } } },
  14: { name: "HeartPacketCmd", type: "message", schema: { 1: { name: "Cnt", type: "uint" } } },
  15: {
    name: "DevResHeartPacket",
    type: "message",
    schema: { 1: { name: "Cnt", type: "uint" }, 2: { name: "ResCmdMsg", type: "uint" } },
  },
  22: {
    name: "ImuCtrl",
    type: "message",
    schema: { 1: { name: "IMUReportEn", type: "uint" }, 2: { name: "reportFrq", type: "uint" } },
  },
  23: { name: "IMURes", type: "message", schema: { 1: { name: "IMUReportEnStatus", type: "uint" } } },
};

/** Minimal protobuf builder for mock peripheral replies and simulated glasses events. */
export function encodeProto(fields) {
  const out = [];
  const putVarint = (v) => {
    let n = BigInt(v);
    while (n >= 0x80n) { out.push(Number(n & 0x7fn) | 0x80); n >>= 7n; }
    out.push(Number(n));
  };
  for (const [num, type, val] of fields) {
    if (type === "uint") {
      putVarint((num << 3) | 0);
      putVarint(val);
    } else if (type === "string") {
      const b = encoder.encode(val);
      putVarint((num << 3) | 2);
      putVarint(b.length);
      for (const x of b) out.push(x);
    } else if (type === "bytes") {
      putVarint((num << 3) | 2);
      putVarint(val.length);
      for (const x of val) out.push(x);
    } else if (type === "float") {
      putVarint((num << 3) | 5);
      const b = new Uint8Array(4);
      new DataView(b.buffer).setFloat32(0, val, true);
      for (const x of b) out.push(x);
    } else if (type === "message") {
      const b = encodeProto(val);
      putVarint((num << 3) | 2);
      putVarint(b.length);
      for (const x of b) out.push(x);
    }
  }
  return new Uint8Array(out);
}

/**
 * Independent 4-bpp indexed BMP decoder & validator (checks header invariants, palette,
 * 4-byte row stride, bottom-up order, and unpacks top-down 0..15 pixel array).
 */
export function parseBmp4bppStrict(buf) {
  if (!(buf instanceof Uint8Array) || buf.length < 118) {
    throw new Error(`BMP too small (${buf?.length} bytes)`);
  }
  if (buf[0] !== 0x42 || buf[1] !== 0x4d) throw new Error("Missing 'BM' signature");
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const fileSize = dv.getUint32(2, true);
  if (fileSize !== buf.length) throw new Error(`BMP fileSize ${fileSize} != buffer length ${buf.length}`);
  const pixelOffset = dv.getUint32(10, true);
  const dibSize = dv.getUint32(14, true);
  if (dibSize !== 40) throw new Error(`Expected BITMAPINFOHEADER (40), got ${dibSize}`);
  const width = dv.getInt32(18, true);
  const height = dv.getInt32(22, true);
  if (width <= 0 || height <= 0) throw new Error(`Expected positive bottom-up BMP dims, got ${width}x${height}`);
  const planes = dv.getUint16(26, true);
  const bpp = dv.getUint16(28, true);
  const compression = dv.getUint32(30, true);
  const imageSize = dv.getUint32(34, true);
  const colorsUsed = dv.getUint32(46, true);
  if (planes !== 1) throw new Error(`planes=${planes}`);
  if (bpp !== 4) throw new Error(`bpp=${bpp}`);
  if (compression !== 0) throw new Error(`compression=${compression}`);
  if (colorsUsed !== 16) throw new Error(`colorsUsed=${colorsUsed}`);
  if (pixelOffset !== 14 + 40 + 64) throw new Error(`pixelOffset=${pixelOffset}`);

  // Verify 16-entry grayscale BGRA palette
  for (let i = 0; i < 16; i++) {
    const off = 54 + i * 4;
    const expected = i * 17;
    if (buf[off] !== expected || buf[off + 1] !== expected || buf[off + 2] !== expected || buf[off + 3] !== 0) {
      throw new Error(`Palette entry ${i} mismatch at offset ${off}`);
    }
  }

  const bytesPerRow = Math.ceil(width / 2);
  const stride = (bytesPerRow + 3) & ~3;
  if (imageSize !== stride * height) throw new Error(`imageSize ${imageSize} != ${stride * height}`);
  if (pixelOffset + imageSize !== buf.length) throw new Error("Trailing/missing BMP pixel bytes");

  const pixels = new Uint8Array(width * height);
  for (let row = 0; row < height; row++) {
    const y = height - 1 - row; // bottom-up
    const rowBase = pixelOffset + row * stride;
    for (let x = 0; x < width; x++) {
      const byte = buf[rowBase + (x >> 1)];
      pixels[y * width + x] = (x & 1) === 0 ? (byte >> 4) & 0x0f : byte & 0x0f;
    }
  }
  return { width, height, stride, pixels };
}
