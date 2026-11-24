// test/relay.test.mjs
// End-to-end test of the Option 1 GATT-over-WebSocket relay:
//   G2.fromDevice(RemoteG2Device) -> ws://.../ws/controller -> relay-server.mjs
//   -> ws://.../ws/device -> GattRelayClient -> MockG2Peripheral (independent codec)

import assert from "node:assert/strict";
import { G2, buildTestCardBmp } from "../g2.js";
import { GattRelayClient } from "../relay-client.js";
import { createRelayServer } from "../scripts/relay-server.mjs";
import { RemoteG2Device } from "../scripts/remote-device.mjs";
import { MockG2Peripheral } from "./mock-g2.mjs";

const relay = createRelayServer({ host: "127.0.0.1", port: 0, pingIntervalMs: 0 });
const { port } = await relay.start();
const deviceUrl = `ws://127.0.0.1:${port}/ws/device`;
const controllerUrl = `ws://127.0.0.1:${port}/ws/controller`;

const mock = new MockG2Peripheral({ ackDelayMs: 2, dropFirstImageStream: true });
const browserRelay = new GattRelayClient();

try {
  // 1. Browser side pairs BLE and connects outbound WS to /ws/device
  await browserRelay.attachDevice(mock.device, { wsUrl: deviceUrl });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("Timed out waiting for device WS")), 3000);
    const check = () => {
      if (browserRelay.wsConnected) { clearTimeout(t); resolve(); }
    };
    browserRelay.addEventListener("state", check);
    check();
  });

  // 2. Verify /healthz reports deviceConnected=true
  const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.deviceConnected, true);

  // 3. CLI controller attaches and drives real G2.fromDevice(...) over the WS relay
  const remote = await RemoteG2Device.connect({ url: controllerUrl, waitDeviceMs: 3000 });
  const g2 = await G2.fromDevice(remote.device, { heartbeatMs: 0, trace: true });

  await g2.setPage({
    texts: [{ id: 1, name: "hdr", x: 10, y: 10, width: 300, height: 40, content: "Via Relay" }],
    images: [{ id: 2, name: "card", x: 350, y: 60, width: 145, height: 112 }],
  });
  await g2.updateText("hdr", "Updated Via Relay");
  assert.equal(mock.containers.get("hdr").Content, "Updated Via Relay");

  // Multi-fragment 4-bpp BMP image over WS relay
  const res = await g2.updateImage("card", buildTestCardBmp(145, 112, { label: "RLY1" }), { warmup: true });
  assert.equal(res.missed, 0);
  assert.equal(mock.renderedImages.get("card").width, 145);
  assert.equal(mock.renderedImages.get("card").pixels[4 * 145 + 4], 15);

  // Inbound gesture notification flows back from glasses -> browser relay -> CLI controller
  const gotTap = new Promise((resolve) => g2.addEventListener("gesture", (e) => resolve(e.detail), { once: true }));
  mock.pushSysEvent(9, 1);
  assert.deepEqual(await gotTap, { type: "long-press", source: "right temple" });

  // Detaching CLI controller MUST leave the browser's BLE pairing alive for the next run!
  g2.disconnect();
  remote.close();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(browserRelay.bleConnected, true, "BLE pairing must survive controller detach");
  assert.equal(browserRelay.wsConnected, true, "Browser WS must stay open for next CLI run");

  // Second consecutive CLI run reuses the exact same paired BLE device with zero browser action
  const remote2 = await RemoteG2Device.connect({ url: controllerUrl, waitDeviceMs: 3000 });
  const g2b = await G2.fromDevice(remote2.device, { heartbeatMs: 0 });
  await g2b.text("Second CLI run — zero refresh!");
  assert.equal(mock.containers.get("text-a").Content, "Second CLI run — zero refresh!");
  assert.deepEqual(mock.interleaveErrors, []);

  g2b.disconnect();
  remote2.close();
  console.log("test/relay.test.mjs: all checks passed");
} finally {
  browserRelay.stop();
  await relay.stop();
}
