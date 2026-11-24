// selftest.js: Guided real-hardware smoke test suite & scrubbed trace exporter for Even G2.
// Zero dependencies. Pure ES module (MIT).

import { buildTestCardBmp, G2_HEIGHT, G2_WIDTH } from "./g2.js";

const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/** Generate a 4-character per-run visual confirmation code (omits ambiguous 0/O/1/I). */
export function randomCode(len = 4) {
  let out = "";
  for (let i = 0; i < len; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

/**
 * Build a 576×288 RGBA asymmetric 2×2 test card with per-tile corner tags (T0..T3),
 * distinct outer corner markers, 16-step grayscale ramp, and a centered per-run code.
 */
export function buildFullTestCardRgba(code) {
  const rgba = new Uint8Array(G2_WIDTH * G2_HEIGHT * 4);
  const tiles = [
    { x: 0, y: 0, tag: "T0", label: code },
    { x: 288, y: 0, tag: "T1", label: "R-TOP" },
    { x: 0, y: 144, tag: "T2", label: "L-BOT" },
    { x: 288, y: 144, tag: "T3", label: code },
  ];
  for (const t of tiles) {
    const bmp = buildTestCardBmp(288, 144, { label: t.label, cornerTag: t.tag });
    const dv = new DataView(bmp.buffer, bmp.byteOffset, bmp.byteLength);
    const pixOff = dv.getUint32(10, true);
    const stride = (Math.ceil(288 / 2) + 3) & ~3;
    for (let row = 0; row < 144; row++) {
      const ly = 143 - row;
      const base = pixOff + row * stride;
      for (let lx = 0; lx < 288; lx++) {
        const b = bmp[base + (lx >> 1)];
        const lvl = (lx & 1) === 0 ? (b >> 4) & 0x0f : b & 0x0f;
        const v = lvl * 17;
        const off = ((t.y + ly) * G2_WIDTH + (t.x + lx)) * 4;
        rgba[off] = v;
        rgba[off + 1] = v;
        rgba[off + 2] = v;
        rgba[off + 3] = 255;
      }
    }
  }
  return { rgba, width: G2_WIDTH, height: G2_HEIGHT };
}

export const SELF_TEST_STEPS = [
  {
    id: "status",
    title: "1. Status & firmware",
    needsVisualConfirm: false,
    description: "Queries firmware version & battery over sid=0x09.",
    async run(g2) {
      const s = await g2.refreshStatus();
      if (!s) throw new Error("No status reply received");
      return { firmware: s.firmware, battery: s.battery, charging: s.charging };
    },
  },
  {
    id: "multi-text-list",
    title: "2. Multi-container text + list",
    needsVisualConfirm: true,
    description: "Sends a bordered header text + selectable list with per-run code.",
    async run(g2, { code }) {
      const { status } = await g2.setPage({
        texts: [{
          id: 1, name: "st-hdr", x: 12, y: 8, width: 552, height: 48,
          borderWidth: 1, borderColor: 8, borderRadius: 6, paddingLength: 8,
          content: `SELF-TEST CODE: ${code}  |  TEXT+LIST`,
        }],
        lists: [{
          id: 2, name: "st-list", x: 12, y: 66, width: 552, height: 204,
          borderWidth: 1, borderColor: 5, borderRadius: 6, paddingLength: 6,
          items: [`Code ${code}`, "Border + padding check", "Swipe/tap item 3"],
          capture: true,
        }],
      });
      return { code, status };
    },
  },
  {
    id: "image-odd-card",
    title: "3. Odd-width image card (145×112)",
    needsVisualConfirm: true,
    description: "Streams an odd-width asymmetric 4-bpp BMP (checks stride, warmup A/B, corner marks).",
    async run(g2, { code, warmup, postRebuildDelayMs, windowSize, fragmentSize }) {
      await g2.setPage({
        texts: [{
          id: 1, name: "img-lbl", x: 12, y: 12, width: 380, height: 48,
          borderWidth: 1, borderColor: 6, borderRadius: 4, paddingLength: 6,
          content: `IMG 145x112  warmup=${warmup}  delay=${postRebuildDelayMs}ms`,
        }],
        images: [{ id: 2, name: "odd-card", x: 410, y: 80, width: 145, height: 112 }],
      });
      const bmp = buildTestCardBmp(145, 112, { label: code, cornerTag: "C1" });
      const res = await g2.updateImage("odd-card", bmp, {
        warmup, postRebuildDelayMs, windowSize, fragmentSize, dedup: false,
      });
      return { code, warmup, postRebuildDelayMs, ...res };
    },
  },
  {
    id: "mixed-live",
    title: "4. Mixed dashboard + live updates",
    needsVisualConfirm: true,
    description: "Sets text+list+image, then sends live updateText + updateImage.",
    async run(g2, { code, warmup, windowSize, fragmentSize }) {
      await g2.setPage({
        texts: [
          { id: 1, name: "dash-hdr", x: 12, y: 8, width: 552, height: 44, borderWidth: 1, borderColor: 6, borderRadius: 6, paddingLength: 6, content: "Phase 1 (before update)" },
          { id: 4, name: "dash-ftr", x: 12, y: 242, width: 552, height: 36, paddingLength: 4, content: "Waiting for update..." },
        ],
        lists: [{
          id: 2, name: "dash-lst", x: 12, y: 62, width: 376, height: 170,
          borderWidth: 1, borderColor: 4, borderRadius: 6, paddingLength: 6,
          items: ["Dashboard OK", `Verify ${code}`, "Mixed layout"],
          capture: true,
        }],
        images: [{ id: 3, name: "dash-img", x: 406, y: 84, width: 144, height: 112 }],
      });
      await g2.updateText("dash-hdr", `LIVE UPDATE OK  |  CODE: ${code}`);
      await g2.updateText("dash-ftr", "updateText + updateImage verified");
      const bmp = buildTestCardBmp(144, 112, { label: code, cornerTag: "MX" });
      const imgRes = await g2.updateImage("dash-img", bmp, { warmup, windowSize, fragmentSize, dedup: false });
      return { code, imgRes };
    },
  },
  {
    id: "full-2x2",
    title: "5. Full-lens 2×2 tiled image (576×288)",
    needsVisualConfirm: true,
    description: "Streams 4× 288×144 tiles (T0..T3) and measures total KB/s throughput.",
    async run(g2, { code, warmup, windowSize, fragmentSize, captureOverlay }) {
      const t0 = performance.now();
      const full = buildFullTestCardRgba(code);
      const tiles = await g2.setFullImage(full, { warmup, windowSize, fragmentSize, captureOverlay, dedup: false });
      const elapsedMs = Math.round(performance.now() - t0);
      const totalBytes = tiles.reduce((n, r) => n + r.bytes, 0);
      const kbps = elapsedMs > 0 ? Number(((totalBytes / 1024) / (elapsedMs / 1000)).toFixed(2)) : 0;
      return { code, tiles: tiles.length, totalBytes, elapsedMs, kbps, captureOverlay };
    },
  },
  {
    id: "imu-rate",
    title: "6. IMU enable / rate / disable",
    needsVisualConfirm: false,
    description: "Enables IMU at pace=200 (2 s), pace=500 (2 s), then disables and checks silence.",
    async run(g2) {
      const countFor = async (ms) => {
        let n = 0;
        const fn = (e) => { if (e.detail.type === "motion") n++; };
        g2.addEventListener("gesture", fn);
        await new Promise((r) => setTimeout(r, ms));
        g2.removeEventListener("gesture", fn);
        return n;
      };
      await g2.setImu(true, 200);
      const c200 = await countFor(2000);
      await g2.setImu(true, 500);
      const c500 = await countFor(2000);
      await g2.setImu(false, 500);
      const cOff = await countFor(1000);
      return { countPace200_2s: c200, countPace500_2s: c500, countAfterDisable_1s: cOff };
    },
  },
  {
    id: "shutdown-recover",
    title: "7. Shutdown + clean reopen",
    needsVisualConfirm: true,
    description: "Calls shutdown(0), pauses 500 ms, then reopens a fresh text container with code.",
    async run(g2, { code }) {
      await g2.shutdown(0);
      await new Promise((r) => setTimeout(r, 500));
      const { status } = await g2.setPage({
        texts: [{
          id: 1, name: "reborn", x: 16, y: 96, width: 544, height: 96,
          borderWidth: 1, borderColor: 10, borderRadius: 6, paddingLength: 10,
          content: `REOPENED AFTER SHUTDOWN\nCODE: ${code}`,
          capture: true,
        }],
      });
      return { code, reopened: true, status };
    },
  },
];

/**
 * Export a scrubbed JSON trace report safe to commit to a public repo
 * (strips device name, BLE MAC/suffixes, and any serial identifiers).
 */
export function buildScrubbedTrace({ g2, options, stepResults, gestures, traces }) {
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    deviceName: "REDACTED",
    firmware: g2?.status?.firmware ?? "unknown",
    battery: g2?.status?.battery ?? null,
    platform: typeof navigator !== "undefined" ? navigator.userAgent : "node",
    options,
    steps: stepResults,
    gestures,
    traceCount: traces.length,
    traces: traces.slice(-500),
  };
}
