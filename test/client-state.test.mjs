// test/client-state.test.mjs
// Stateful concurrency, fault-injection, disconnect, timeout, and recovery tests
// exercising G2 against the independent MockG2Peripheral (test/mock-g2.mjs).

import assert from "node:assert/strict";
import { G2, buildBmp4bpp } from "../g2.js";
import { MockG2Peripheral } from "./mock-g2.mjs";

const solidBmp = (w, h, lvl) => buildBmp4bpp(w, h, () => lvl);

// 1. Multi-container page + warmup + image render + dedup + text upgrade
{
  const mock = new MockG2Peripheral({ dropFirstImageStream: true });
  const g2 = await G2.fromDevice(mock.device, { heartbeatMs: 0 });
  await g2.setPage({
    texts: [{ id: 1, name: "hdr", x: 0, y: 0, width: 576, height: 40, content: "Init" }],
    lists: [{ id: 2, name: "menu", x: 0, y: 48, width: 320, height: 200, items: ["One", "Two"], capture: true }],
    images: [{ id: 3, name: "pic", x: 340, y: 60, width: 144, height: 112 }],
  });

  // Warmup=true pushes sacrificial blank frame first, so real frame renders on first call
  const r1 = await g2.updateImage("pic", solidBmp(144, 112, 12), { warmup: true });
  assert.equal(r1.skipped, false);
  assert.equal(r1.warmedUp, true);
  assert.equal(mock.renderedImages.get("pic").pixels[0], 12);

  // Identical image is deduplicated
  const r2 = await g2.updateImage("pic", solidBmp(144, 112, 12), { warmup: true });
  assert.equal(r2.skipped, true);

  // Text upgrade updates in-place
  await g2.updateText("hdr", "Updated");
  assert.equal(mock.containers.get("hdr").Content, "Updated");

  g2.disconnect();
}

// 2. Dimension validation rejects mismatched BMP before writing anything
{
  const mock = new MockG2Peripheral();
  const g2 = await G2.fromDevice(mock.device, { heartbeatMs: 0 });
  await g2.setPage({ images: [{ id: 1, name: "pic", x: 0, y: 0, width: 100, height: 80 }] });
  const before = mock.receivedMessages.length;
  await assert.rejects(() => g2.updateImage("pic", solidBmp(144, 112, 9)), /do not match container/);
  assert.equal(mock.receivedMessages.length, before);
  g2.disconnect();
}

// 3. Slow BLE link speed: ack timeout starts AFTER write finishes, not before queuing
{
  // 288x144 BMP is 20854 B (~6 fragments). At 25000 B/s, writing 4 queued fragments takes ~600 ms.
  // With fragmentTimeoutMs = 250 ms and ackDelayMs = 20 ms, starting timeout before write would fail!
  const mock = new MockG2Peripheral({ bytesPerSec: 25000, ackDelayMs: 20, dropFirstImageStream: false });
  const g2 = await G2.fromDevice(mock.device, { heartbeatMs: 0 });
  await g2.setPage({ images: [{ id: 1, name: "big", x: 0, y: 0, width: 288, height: 144 }] });
  const res = await g2.updateImage("big", solidBmp(288, 144, 7), {
    warmup: false, windowSize: 4, fragmentSize: 3800, fragmentTimeoutMs: 250,
  });
  assert.equal(res.missed, 0);
  assert.equal(mock.renderedImages.get("big").pixels[0], 7);
  assert.deepEqual(mock.interleaveErrors, []);
  g2.disconnect();
}

// 4. Concurrent updateImage + frequent heartbeats + setPage: zero interleaving and no stale warmup leak
{
  const mock = new MockG2Peripheral({ ackDelayMs: 5, dropFirstImageStream: true });
  const g2 = await G2.fromDevice(mock.device, { heartbeatMs: 15 });
  await g2.setPage({ images: [{ id: 1, name: "tile", x: 0, y: 0, width: 144, height: 112 }] });

  // Fire overlapping updateImage + setPage (same name!) + another updateImage without awaiting
  const p1 = g2.updateImage("tile", solidBmp(144, 112, 5));
  const p2 = g2.setPage({ images: [{ id: 1, name: "tile", x: 0, y: 0, width: 144, height: 112 }] });
  const p3 = g2.updateImage("tile", solidBmp(144, 112, 5)); // same pixels, MUST still warmup & render after rebuild!

  const [, , res3] = await Promise.all([p1, p2, p3]);
  assert.equal(res3.skipped, false, "must not skip as duplicate after setPage rebuild");
  assert.equal(res3.warmedUp, true, "must warmup freshly rebuilt container");
  assert.equal(mock.renderedImages.get("tile").pixels[0], 5);
  assert.ok(mock.heartbeats >= 1, "heartbeats should have fired concurrently");
  assert.deepEqual(mock.interleaveErrors, [], "no multi-fragment BLE interleaving allowed");
  g2.disconnect();
}

// 5. Write failure in updateText does NOT permanently wedge subsequent updates
{
  const mock = new MockG2Peripheral();
  const g2 = await G2.fromDevice(mock.device, { heartbeatMs: 0 });
  await g2.setPage({ texts: [{ id: 1, name: "hdr", content: "v0", capture: true }] });
  mock.failNextWrites = 1;
  await assert.rejects(() => g2.updateText("hdr", "v1"), /Simulated GATT write failure/);
  // Next updateText MUST succeed
  await g2.updateText("hdr", "v2");
  assert.equal(mock.containers.get("hdr").Content, "v2");
  g2.disconnect();
}

// 6. Mid-transfer disconnect MUST reject (never report success with missed > 0)
{
  const mock = new MockG2Peripheral({ ackDelayMs: 80, dropFirstImageStream: false });
  const g2 = await G2.fromDevice(mock.device, { heartbeatMs: 0 });
  await g2.setPage({ images: [{ id: 1, name: "pic", x: 0, y: 0, width: 144, height: 112 }] });
  setTimeout(() => mock.device.gatt.disconnect(), 15);
  await assert.rejects(
    () => g2.updateImage("pic", solidBmp(144, 112, 11), { warmup: false, fragmentSize: 3800, fragmentTimeoutMs: 500 }),
    /Disconnected|not connected/
  );
}

// 7. Firmware reply error codes reject cleanly on setPage, updateImage, shutdown
{
  const mock = new MockG2Peripheral({ dropFirstImageStream: false });
  const g2 = await G2.fromDevice(mock.device, { heartbeatMs: 0 });

  mock.errorReplyForCmd.set(7, 7); // rebuild_failed
  await assert.rejects(() => g2.setPage({ texts: [{ id: 1, name: "t", content: "x" }] }), /rebuild_failed/);

  await g2.setPage({ images: [{ id: 1, name: "pic", x: 0, y: 0, width: 64, height: 64 }] });
  mock.errorReplyForCmd.set(3, 5); // image_update_failed
  await assert.rejects(() => g2.updateImage("pic", solidBmp(64, 64, 4), { warmup: false }), /image_update_failed/);

  mock.errorReplyForCmd.set(9, 11); // shutdown_failed
  await assert.rejects(() => g2.shutdown(0), /shutdown_failed/);
  g2.disconnect();
}

// 8. Missed-ack boundary (3 ok + no dedup cache, 4 consecutive aborts + bumps session ID; alternating ok)
{
  const mock = new MockG2Peripheral({ ackDelayMs: 5, dropFirstImageStream: false });
  const g2 = await G2.fromDevice(mock.device, { heartbeatMs: 0 });
  await g2.setPage({ images: [{ id: 1, name: "big", x: 0, y: 0, width: 288, height: 144 }] });

  // Drop 3 consecutive acks (indices 1, 2, 3) -> succeeds, but does NOT cache lastHash
  mock.dropImageAckPredicate = ({ fragmentIndex }) => fragmentIndex >= 1 && fragmentIndex <= 3;
  const r3 = await g2.updateImage("big", solidBmp(288, 144, 6), {
    warmup: false, fragmentSize: 3800, fragmentTimeoutMs: 40, maxAckMisses: 3,
  });
  assert.equal(r3.missed, 3);

  // Retry identical image with no drops -> MUST NOT skip as duplicate because previous run had missed acks
  mock.dropImageAckPredicate = null;
  const rRetry = await g2.updateImage("big", solidBmp(288, 144, 6), {
    warmup: false, fragmentSize: 3800, fragmentTimeoutMs: 100,
  });
  assert.equal(rRetry.skipped, false);

  // Drop 4 consecutive acks (indices 0..3) -> MUST abort & advance sessionId by >= 2 from failed session
  const sessionBeforeAbort = g2.imageSessionId;
  mock.dropImageAckPredicate = ({ fragmentIndex }) => fragmentIndex <= 3;
  await assert.rejects(
    () => g2.updateImage("big", solidBmp(288, 144, 9), {
      warmup: false, fragmentSize: 3800, fragmentTimeoutMs: 35, maxAckMisses: 3,
    }),
    /aborted.*4 consecutive/
  );
  assert.ok(g2.imageSessionId >= sessionBeforeAbort + 2, `expected sessionId >= ${sessionBeforeAbort + 2}, got ${g2.imageSessionId}`);

  // Next clean transfer renders properly
  mock.dropImageAckPredicate = null;
  const rNext = await g2.updateImage("big", solidBmp(288, 144, 14), {
    warmup: false, fragmentSize: 3800, fragmentTimeoutMs: 100,
  });
  assert.equal(rNext.missed, 0);
  assert.equal(mock.renderedImages.get("big").pixels[0], 14);
  g2.disconnect();
}

// 9. system-exit clears stale state; updateText/updateImage reject until setPage reopens session
{
  const mock = new MockG2Peripheral({ dropFirstImageStream: false });
  const g2 = await G2.fromDevice(mock.device, { heartbeatMs: 0 });
  await g2.setPage({
    texts: [{ id: 1, name: "hdr", content: "alive" }],
    images: [{ id: 2, name: "pic", x: 0, y: 50, width: 64, height: 64 }],
  });

  const gotExit = new Promise((res) => g2.addEventListener("gesture", (e) => {
    if (e.detail.type === "system-exit") res(e.detail);
  }));
  mock.pushSysEvent(7, 1);
  await gotExit;
  assert.equal(g2.pageLive, false);
  await assert.rejects(() => g2.updateText("hdr", "stale"), /No active page/);
  await assert.rejects(() => g2.updateImage("pic", solidBmp(64, 64, 3)), /No active page/);

  // setPage re-establishes session cleanly
  await g2.setPage({ texts: [{ id: 1, name: "hdr", content: "reborn" }] });
  assert.equal(g2.pageLive, true);
  assert.equal(mock.containers.get("hdr").Content, "reborn");
  g2.disconnect();
}

// 10. setFullImage + shutdown + setImu
{
  const mock = new MockG2Peripheral({ dropFirstImageStream: true });
  const g2 = await G2.fromDevice(mock.device, { heartbeatMs: 0 });
  const rgba = new Uint8Array(576 * 288 * 4);
  rgba.fill(255);
  const tileRes = await g2.setFullImage({ rgba, width: 576, height: 288 }, { captureOverlay: true });
  assert.equal(tileRes.length, 4);
  assert.equal(mock.containers.get("img-cap").IsEventCapture, 1);
  assert.equal(mock.renderedImages.get("t1-1").pixels[0], 15);

  await g2.setImu(true, 200);
  assert.deepEqual(mock.imu, { enabled: true, pace: 200 });
  await g2.setImu(false, 200);
  assert.equal(mock.imu.enabled, false);

  await g2.shutdown(0);
  assert.equal(g2.pageLive, false);
  assert.equal(mock.pageLive, false);
  g2.disconnect();
}

console.log("test/client-state.test.mjs: all checks passed");
