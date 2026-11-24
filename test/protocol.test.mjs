// test/protocol.test.mjs
// Zero-dependency protocol, wire-encoding, reply/event decoding, and 4-bpp BMP tests
// verified through an independent codec (test/independent-codec.mjs).

import assert from "node:assert/strict";
import {
  Cmd,
  G2_LIMITS,
  SID,
  buildBmp4bpp,
  buildTestCardBmp,
  decode,
  decodeEvent,
  frames,
  gray8ToBmp4bpp,
  msg,
  planImageFragments,
  readReplyStatus,
  rgbaPixelToGray4,
  rgbaToBmp4bpp,
  rgbaToTiles,
  validatePage,
} from "../g2.js";
import {
  EVENHUB_ENVELOPE_SCHEMA,
  StrictFrameReassembler,
  decodeStrict,
  encodeProto,
  parseBmp4bppStrict,
} from "./independent-codec.mjs";

function roundTripEnvelope(pbBytes, seq = 0x55) {
  const rx = new StrictFrameReassembler();
  const list = frames(pbBytes, { seq, sid: SID.evenHub });
  let msgOut = null;
  for (const f of list) msgOut = rx.push(f);
  assert.ok(msgOut, "expected reassembled message");
  assert.equal(msgOut.sid, SID.evenHub);
  return decodeStrict(msgOut.payload, EVENHUB_ENVELOPE_SCHEMA);
}

// 1. CreateStartUpPageContainer — mixed text + list + image + borders/padding
{
  const page = validatePage({
    lists: [{
      id: 1, name: "menu", x: 10, y: 60, width: 320, height: 180,
      borderWidth: 2, borderColor: 10, borderRadius: 6, paddingLength: 8,
      itemWidth: 300, selectionBorder: true, items: ["Alpha", "Beta", "Gamma"], capture: true,
    }],
    texts: [{
      id: 2, name: "hdr", x: 10, y: 8, width: 556, height: 42,
      borderWidth: 1, borderColor: 6, borderRadius: 4, paddingLength: 6,
      content: "Header Line", capture: false,
    }],
    images: [{ id: 3, name: "icon", x: 360, y: 60, width: 144, height: 112 }],
  });
  const env = roundTripEnvelope(msg.createPage(101, page, { widgetId: 10000 }));
  assert.equal(env.Cmd ?? 0, Cmd.create);
  assert.equal(env.MagicRandom, 101);
  assert.equal(env.CreateMessage.ContainerTotalNum, 3);
  assert.equal(env.CreateMessage.widgetId, 10000);
  assert.equal(env.CreateMessage.ListObject.length, 1);
  assert.equal(env.CreateMessage.ListObject[0].BorderWidth, 2);
  assert.equal(env.CreateMessage.ListObject[0].BorderColor, 10);
  assert.equal(env.CreateMessage.ListObject[0].BorderRadius, 6);
  assert.equal(env.CreateMessage.ListObject[0].PaddingLength, 8);
  assert.equal(env.CreateMessage.ListObject[0].ItemContainer.ItemWidth, 300);
  assert.deepEqual(env.CreateMessage.ListObject[0].ItemContainer.ItemName, ["Alpha", "Beta", "Gamma"]);
  assert.equal(env.CreateMessage.TextObject[0].Content, "Header Line");
  assert.equal(env.CreateMessage.TextObject[0].PaddingLength, 6);
  assert.equal(env.CreateMessage.ImageObject[0].Width, 144);
  assert.equal(env.CreateMessage.ImageObject[0].Height, 112);
  assert.equal(env.CreateMessage.ImageObject[0].ContainerName, "icon");
}

// 2. RebuildPageContainer — 2x2 image tiles + text
{
  const env = roundTripEnvelope(
    msg.rebuildPage(102, {
      images: [
        { id: 1, name: "t0-0", x: 0, y: 0, width: 288, height: 144 },
        { id: 2, name: "t1-0", x: 288, y: 0, width: 288, height: 144 },
        { id: 3, name: "t0-1", x: 0, y: 144, width: 288, height: 144 },
        { id: 4, name: "t1-1", x: 288, y: 144, width: 288, height: 144 },
      ],
    })
  );
  assert.equal(env.Cmd, Cmd.rebuild);
  assert.equal(env.RebuildContainer.ContainerTotalNum, 4);
  assert.equal(env.RebuildContainer.ImageObject.length, 4);
  assert.equal(env.RebuildContainer.ImageObject[3].XPosition, 288);
  assert.equal(env.RebuildContainer.ImageObject[3].YPosition, 144);
}

// 3. TextContainerUpgrade with non-zero offset & UTF-8 byte length
{
  const content = "Temp 21°C ✓";
  const env = roundTripEnvelope(msg.textUpgrade(103, { id: 2, name: "hdr", content, offset: 4 }));
  assert.equal(env.Cmd, Cmd.textUpgrade);
  assert.equal(env.TextUpgrade.ContainerID, 2);
  assert.equal(env.TextUpgrade.ContainerName, "hdr");
  assert.equal(env.TextUpgrade.ContentOffset, 4);
  assert.equal(env.TextUpgrade.ContentLength, new TextEncoder().encode(content).length);
  assert.equal(env.TextUpgrade.Content, content);
}

// 4. ImageRawDataUpdate, ShutDown, Heartbeat, ImuCtrl + explicitZeros toggle
{
  const chunk = new Uint8Array([0x42, 0x4d, 0x01, 0x02, 0x03]);
  const imgImplicit = roundTripEnvelope(msg.imageRawData(104, {
    id: 3, name: "icon", sessionId: 7, totalSize: 500, compressMode: 0, fragmentIndex: 0, data: chunk,
  }));
  assert.equal(imgImplicit.ImgRawMsg.$present.has("CompressMode"), false);
  assert.equal(imgImplicit.ImgRawMsg.$present.has("MapFragmentIndex"), false);

  const imgExplicit = roundTripEnvelope(msg.imageRawData(105, {
    id: 3, name: "icon", sessionId: 7, totalSize: 500, compressMode: 0, fragmentIndex: 0, data: chunk, explicitZeros: true,
  }));
  assert.equal(imgExplicit.ImgRawMsg.$present.has("CompressMode"), true);
  assert.equal(imgExplicit.ImgRawMsg.$present.has("MapFragmentIndex"), true);
  assert.equal(imgExplicit.ImgRawMsg.CompressMode, 0);
  assert.equal(imgExplicit.ImgRawMsg.MapFragmentIndex, 0);
  assert.equal(imgExplicit.ImgRawMsg.MapFragmentPacketSize, 5);
  assert.deepEqual(imgExplicit.ImgRawMsg.MapRawData, chunk);

  const sdExplicit = roundTripEnvelope(msg.shutDown(106, 0, { explicitZeros: true }));
  assert.equal(sdExplicit.Cmd, Cmd.shutDown);
  assert.equal(sdExplicit.ShutDownCmd.$present.has("exitMode"), true);
  assert.equal(sdExplicit.ShutDownCmd.exitMode, 0);

  const hb = roundTripEnvelope(msg.heartbeat(107, 42));
  assert.equal(hb.Cmd, Cmd.heartbeat);
  assert.equal(hb.HeartPacketCmd.Cnt, 42);

  const imuOff = roundTripEnvelope(msg.imuControl(108, false, 500, { explicitZeros: true }));
  assert.equal(imuOff.Cmd, Cmd.imuControl);
  assert.equal(imuOff.ImuCtrl.$present.has("IMUReportEn"), true);
  assert.equal(imuOff.ImuCtrl.IMUReportEn, 0);
  assert.equal(imuOff.ImuCtrl.reportFrq, 500);
}

// 5. Glasses -> Client replies (success & error codes) and events (list, text, sys, gestures 0..10, IMU)
{
  const okRebuild = decode(encodeProto([[1, "uint", Cmd.rebuildResponse], [2, "uint", 102], [8, "message", [[1, "uint", 6]]]]));
  assert.equal(readReplyStatus(okRebuild, 8).ok, true);
  const errRebuild = decode(encodeProto([[1, "uint", Cmd.rebuildResponse], [2, "uint", 102], [8, "message", [[1, "uint", 7]]]]));
  assert.equal(readReplyStatus(errRebuild, 8).ok, false);
  assert.equal(readReplyStatus(errRebuild, 8).code, 7);

  const errImg = decode(encodeProto([[1, "uint", Cmd.imageRawDataResponse], [2, "uint", 104], [6, "message", [[1, "uint", 5]]]]));
  assert.equal(readReplyStatus(errImg, 6).ok, false);

  const listEv = decodeEvent(encodeProto([
    [1, "uint", Cmd.deviceEvent],
    [13, "message", [[1, "message", [[1, "uint", 1], [2, "string", "menu"], [3, "string", "Beta"], [4, "uint", 1], [5, "uint", 0]]]]],
  ]));
  assert.deepEqual(listEv, { type: "tap", containerId: 1, container: "menu", index: 1, item: "Beta" });

  const textEv = decodeEvent(encodeProto([
    [1, "uint", Cmd.deviceEvent],
    [13, "message", [[2, "message", [[1, "uint", 2], [2, "string", "hdr"], [3, "uint", 3]]]]],
  ]));
  assert.deepEqual(textEv, { type: "double-tap", containerId: 2, container: "hdr" });

  const lpEv = decodeEvent(encodeProto([
    [1, "uint", Cmd.deviceEvent],
    [13, "message", [[3, "message", [[1, "uint", 9], [2, "uint", 2]]]]],
  ]));
  assert.deepEqual(lpEv, { type: "long-press", source: "ring" });

  const lprEv = decodeEvent(encodeProto([
    [1, "uint", Cmd.deviceEvent],
    [13, "message", [[3, "message", [[1, "uint", 10], [2, "uint", 3]]]]],
  ]));
  assert.deepEqual(lprEv, { type: "long-press-release", source: "left temple" });

  const imuEv = decodeEvent(encodeProto([
    [1, "uint", Cmd.deviceEvent],
    [13, "message", [[3, "message", [[1, "uint", 8], [2, "uint", 1], [3, "message", [[1, "float", 0.25], [2, "float", -0.5], [3, "float", 0.75]]]]]]],
  ]));
  assert.equal(imuEv.type, "motion");
  assert.ok(Math.abs(imuEv.motion.x - 0.25) < 1e-5 && Math.abs(imuEv.motion.y + 0.5) < 1e-5);
}

// 6. Validation edge cases (UTF-8 name bytes, container limits, image bounds, fragment size)
{
  assert.throws(() => validatePage({}), /1\.\.12/);
  // 5 3-byte UTF-8 chars = 15 bytes > 14 byte limit even though .length === 5
  assert.throws(() => validatePage({ texts: [{ name: "日本語文字", content: "hi" }] }), /UTF-8 bytes/);
  assert.throws(() => validatePage({ texts: [{ name: "a".repeat(15), content: "hi" }] }), /UTF-8 bytes/);
  assert.throws(() => validatePage({
    texts: [{ name: "t1", content: "a", capture: true }, { name: "t2", content: "b", capture: true }],
  }), /At most one/);
  assert.throws(() => validatePage({ images: [{ name: "i1", width: 19, height: 40 }] }), /width 19/);
  assert.throws(() => validatePage({ images: [{ name: "i1", width: 289, height: 40 }] }), /width 289/);
  assert.throws(() => validatePage({ images: [{ name: "i1", width: 40, height: 145 }] }), /height 145/);
  assert.throws(() => msg.imageRawData(100, {
    id: 1, name: "i1", sessionId: 1, totalSize: 5000, data: new Uint8Array(G2_LIMITS.maxImageFragmentBytes + 1),
  }), /exceeds firmware cap/);
}

// 7. 4-bpp BMP verification: sweep widths 20..27 (all 0..3 padding bytes + odd/even), RGBA/gray8, tile seams, test card
{
  for (let w = 20; w <= 27; w++) {
    const h = 13;
    const expected = (x, y) => (x * 3 + y * 5) & 0x0f;
    const bmp = buildBmp4bpp(w, h, expected);
    const parsed = parseBmp4bppStrict(bmp);
    assert.equal(parsed.width, w);
    assert.equal(parsed.height, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        assert.equal(parsed.pixels[y * w + x], expected(x, y), `mismatch at ${w}x${h} (${x},${y})`);
      }
    }
  }

  // Color-to-gray luminance & transparent pixel mapping
  assert.equal(rgbaPixelToGray4(255, 255, 255, 0), 0);
  assert.equal(rgbaPixelToGray4(255, 255, 255, 255), 15);
  assert.equal(rgbaPixelToGray4(0, 0, 0, 255), 0);
  const g8 = new Uint8Array(24 * 20).map((_, i) => (i * 11) & 0xff);
  const g8Parsed = parseBmp4bppStrict(gray8ToBmp4bpp(g8, 24, 20));
  for (let i = 0; i < g8.length; i++) assert.equal(g8Parsed.pixels[i], g8[i] >> 4);

  // Full 576x288 2x2 tile seam verification (rows 143/144, cols 287/288)
  const fullRgba = new Uint8Array(576 * 288 * 4);
  for (let y = 0; y < 288; y++) {
    for (let x = 0; x < 576; x++) {
      const val = ((x + y * 2) & 0x0f) * 17;
      const off = (y * 576 + x) * 4;
      fullRgba[off] = val; fullRgba[off + 1] = val; fullRgba[off + 2] = val; fullRgba[off + 3] = 255;
    }
  }
  const tiles = rgbaToTiles(fullRgba, 576, 288);
  assert.equal(tiles.length, 4);
  const rebuilt = new Uint8Array(576 * 288);
  for (const t of tiles) {
    const p = parseBmp4bppStrict(t.bmp);
    assert.equal(p.width, 288);
    assert.equal(p.height, 144);
    for (let ly = 0; ly < p.height; ly++) {
      for (let lx = 0; lx < p.width; lx++) {
        rebuilt[(t.y + ly) * 576 + (t.x + lx)] = p.pixels[ly * p.width + lx];
      }
    }
  }
  for (const y of [0, 143, 144, 287]) {
    for (const x of [0, 287, 288, 575]) {
      assert.equal(rebuilt[y * 576 + x], (x + y * 2) & 0x0f, `seam mismatch at (${x},${y})`);
    }
  }

  // Test card asymmetric corners & rightmost-column marker on odd width (145x112)
  const card = parseBmp4bppStrict(buildTestCardBmp(145, 112, { label: "K7M2", cornerTag: "T0" }));
  assert.equal(card.pixels[4 * 145 + 4], 15, "TL solid square");
  assert.equal(card.pixels[50 * 145 + 144], 15, "rightmost-column odd-width marker");
  // Fragment planner enforces <= 4096 B
  const frags = planImageFragments(rgbaToBmp4bpp(new Uint8Array(288 * 144 * 4), 288, 144), 3800);
  assert.ok(frags.length === 6 && frags.every((f) => f.data.length <= 3800));
}

console.log("test/protocol.test.mjs: all checks passed");
