#!/usr/bin/env node
// scripts/hw-test.mjs
// Autonomous CLI hardware runner driving real G2 glasses via the GATT WebSocket relay.
//
// Usage:
//   node scripts/hw-test.mjs status
//   node scripts/hw-test.mjs text "Hello from CLI"
//   node scripts/hw-test.mjs card [CODE] [--warmup=true|false] [--delay=0] [--zeros=false]
//   node scripts/hw-test.mjs full-card [CODE] [--warmup=true|false]
//   node scripts/hw-test.mjs selftest [--warmup=true] [--delay=0] [--zeros=false] [--window=4] [--frag=3800] [--out=test/traces/latest.json]

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { G2, buildTestCardBmp } from "../g2.js";
import { SELF_TEST_STEPS, buildFullTestCardRgba, buildScrubbedTrace, randomCode } from "../selftest.js";
import { RemoteG2Device } from "./remote-device.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function parseFlags(argv) {
  const pos = [];
  const flags = {};
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      const [k, v = "true"] = arg.slice(2).split("=");
      flags[k] = v;
    } else {
      pos.push(arg);
    }
  }
  return { pos, flags };
}

const boolFlag = (v, def) => (v == null ? def : v !== "false" && v !== "0");

async function main() {
  const { pos, flags } = parseFlags(process.argv.slice(2));
  const cmd = pos[0] || "status";
  const httpBase = flags.relayHttp || "http://127.0.0.1:18130";
  const wsUrl = flags.relay || "ws://127.0.0.1:18130/ws/controller";

  if (cmd === "status") {
    const res = await fetch(`${httpBase}/healthz`);
    console.log(JSON.stringify(await res.json(), null, 2));
    return;
  }

  const remote = await RemoteG2Device.connect({ url: wsUrl, waitDeviceMs: Number(flags.wait || 5000) });
  const traces = [];
  const gestures = [];
  const explicitZeros = boolFlag(flags.zeros, false);

  const g2 = await G2.fromDevice(remote.device, {
    log: (s) => console.log(`[g2] ${s}`),
    trace: (t) => traces.push(t),
    heartbeatMs: 5000,
    explicitZeros,
  });
  g2.addEventListener("gesture", (e) => gestures.push({ ts: Date.now(), ...e.detail }));

  try {
    if (cmd === "text") {
      const body = pos.slice(1).join(" ") || "Hello from CLI via GATT relay!";
      await g2.text(body);
      console.log("Sent text:", body);
    } else if (cmd === "card") {
      const code = (pos[1] || randomCode()).toUpperCase();
      await g2.setPage({
        texts: [{ id: 1, name: "odd-lbl", x: 12, y: 12, width: 380, height: 46, borderWidth: 1, borderColor: 6, borderRadius: 4, paddingLength: 6, content: `CLI CARD 145x112  CODE: ${code}` }],
        images: [{ id: 2, name: "odd-card", x: 410, y: 82, width: 145, height: 112 }],
      });
      const res = await g2.updateImage("odd-card", buildTestCardBmp(145, 112, { label: code, cornerTag: "C1" }), {
        warmup: boolFlag(flags.warmup, true),
        postRebuildDelayMs: Number(flags.delay || 0),
        windowSize: Number(flags.window || 4),
        fragmentSize: Number(flags.frag || 3800),
        dedup: false,
      });
      console.log("Rendered odd card:", { code, ...res });
    } else if (cmd === "full-card") {
      const code = (pos[1] || randomCode()).toUpperCase();
      const t0 = performance.now();
      const tiles = await g2.setFullImage(buildFullTestCardRgba(code), {
        warmup: boolFlag(flags.warmup, true),
        windowSize: Number(flags.window || 4),
        fragmentSize: Number(flags.frag || 3800),
        captureOverlay: boolFlag(flags.captureOverlay, false),
        dedup: false,
      });
      console.log("Rendered 2x2 full card:", { code, elapsedMs: Math.round(performance.now() - t0), tiles });
    } else if (cmd === "selftest") {
      const code = (flags.code || randomCode()).toUpperCase();
      const opts = {
        code,
        warmup: boolFlag(flags.warmup, true),
        explicitZeros,
        captureOverlay: boolFlag(flags.captureOverlay, false),
        windowSize: Number(flags.window || 4),
        fragmentSize: Number(flags.frag || 3800),
        postRebuildDelayMs: Number(flags.delay || 0),
      };
      console.log(`Starting Hardware Self-Test (run code: ${code}) with options:`, opts);
      const stepResults = {};
      for (const step of SELF_TEST_STEPS) {
        const t0 = performance.now();
        try {
          const result = await step.run(g2, opts);
          const durationMs = Math.round(performance.now() - t0);
          stepResults[step.id] = { ok: true, durationMs, result };
          console.log(`  [PASS] ${step.title} (${durationMs} ms)`, JSON.stringify(result));
        } catch (err) {
          stepResults[step.id] = { ok: false, error: err.message };
          console.error(`  [FAIL] ${step.title}:`, err.message);
        }
      }
      const outPath = path.resolve(repoRoot, flags.out || `test/traces/hw-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
      await mkdir(path.dirname(outPath), { recursive: true });
      const report = buildScrubbedTrace({ g2, options: opts, stepResults, gestures, traces });
      await writeFile(outPath, JSON.stringify(report, null, 2));
      console.log(`Saved scrubbed trace (${traces.length} frames) -> ${outPath}`);
    } else {
      throw new Error(`Unknown command "${cmd}". Use: status | text | card | full-card | selftest`);
    }
  } finally {
    g2.disconnect();
    remote.close();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
