# Even G2 Web Bluetooth Fork

Fork of [mrahtz/even-g2-js](https://github.com/mrahtz/even-g2-js) (MIT) extended with multi-container pages (`text`, `list`, `image`), container borders/padding, 4-bpp indexed BMP image streaming, `shutdown`, and `imuControl`.

## Licensing & Dependencies

- **Zero runtime or test npm dependencies.** Pure ES modules (`g2.js`, `image.js`, `selftest.js`, `relay-client.js`, `index.html`) under **MIT**.
- Initial wire field numbers for `Cmd=3/5/7/9/19` and 4-bpp BMP headers referenced from MIT [Commute773/g2-kit-unofficial](https://github.com/Commute773/g2-kit-unofficial), treated as hypotheses until verified on physical G2 hardware.
- Do not inspect or copy code from strong-copyleft (GPL/AGPL) G2 repos.

## Protocol Scope & Hardware Verification Status

- **Upstream-verified (firmware 2.4.0.24 on macOS Chrome per upstream README):** handshake, prelude, single-container text/list, gestures.
- **Added in this fork (untested on physical G2 hardware yet):** multi-container `setPage` (`Cmd=7`), borders/padding/radius/itemWidth, `updateText` (`Cmd=5` with offset), 4-bpp BMP streaming `updateImage` / `setFullImage` (`Cmd=3`, sliding window, optional warmup, `explicitZeros` A/B toggle), `shutdown` (`Cmd=9`), `setImu` (`Cmd=19`), and `long-press` / `long-press-release` gesture decoding.
- **Not yet mapped on wire:** `zOrderIndex`, `textColor` (0..4), `menuObject` / `menuItemClickEvent`, and `CompressMode=2` (LZ4).

## Verification Commands

- `npm test` — zero-dependency Node suite:
  - `test.mjs` — upstream golden vectors (`crc16`, `PRELUDE`, IMU capture, safe glyph checks).
  - `test/protocol.test.mjs` — independent wire/protobuf parser checking every emitted message, `explicitZeros`, glasses→client replies/events, and 4-bpp BMP checks (widths `20..27` stride sweep, tile seams, test card).
  - `test/client-state.test.mjs` — independent mock GATT peripheral (`test/mock-g2.mjs`, does NOT reuse `g2.js`/`image.js` parsers) testing client concurrency, write non-interleaving, link-speed timeout behavior, write rejections, disconnect handling, error replies, missed-ack abort boundaries, and `system-exit` recovery.
  - `test/relay.test.mjs` — end-to-end test of the persistent GATT-over-WebSocket relay (`scripts/relay-server.mjs` + `relay-client.js` + `scripts/remote-device.mjs`).
- `npm run test:visual` — slim Playwright capture (`scripts/visual-verify.mjs`) rendering `index.html` screenshots to `shots/` for UI inspection (visual approximations only; not a firmware layout proof).
- **Persistent GATT Relay (`npm run relay` on `127.0.0.1:18130`):**
  - Open the hosted HTTPS page in Chrome/Edge once and click **Pair & Relay to CLI** (keeps BLE pairing open; auto-reconnects WS if relay restarts).
  - Reverse proxy should expose only `/ws/device`; `/ws/controller` and `/healthz` stay localhost-only.
  - Drive paired glasses directly from the CLI (`node scripts/hw-test.mjs status | text | card | full-card | selftest`) and save scrubbed JSON traces under `test/traces/`.

## UI Convention

- Default companion UI (`index.html`) to **light theme**. The simulated 576×288 optical display stays black background with monochrome green pixels.
