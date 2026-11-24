# even-g2-js (multi-container fork)

Fork of [mrahtz/even-g2-js](https://github.com/mrahtz/even-g2-js) (MIT) to drive **Even Realities G2** smart glasses directly from a web page over **Web Bluetooth**, extended with:

- **Multi-container pages** (`g2.setPage({ texts, lists, images })`) with borders, border color/radius, padding, and `itemWidth`.
- **In-place container updates** (`g2.updateText(idOrName, content, { offset })`).
- **4-bpp indexed BMP image streaming** (`image.js`, `g2.updateImage(idOrName, source)`, `g2.setFullImage(source)` for 2×2 `576×288` tiled images, sliding window, optional warmup frame, dedup on clean acks).
- **Lifecycle & sensors:** `g2.shutdown(exitMode)`, `g2.setImu(enabled, pace)`, `long-press` / `long-press-release` gesture decoding, and an `explicitZeros` A/B flag for hardware testing.
- **Hardware Self-Test** (`selftest.js` + `index.html`): guided probes with per-run confirmation codes, asymmetric odd-width & 2×2 test cards, A/B warmup/zero toggles, and scrubbed JSON TX/RX trace export.

Zero runtime or test dependencies.

```bash
python3 -m http.server 8000   # open http://localhost:8000 in Chrome or Edge
npm test                      # zero-dependency protocol + client state + relay tests
```

## Persistent GATT Relay (Hands-Off Dev Loop)

1. Run `npm run relay` (listens on `127.0.0.1:18130` by default).
2. Open the page in Chrome/Edge and click **Pair & Relay to CLI** once (leave the tab open; WS auto-reconnects without dropping BLE).
3. Drive the paired glasses directly from the CLI with zero browser refreshes:

```bash
node scripts/hw-test.mjs status
node scripts/hw-test.mjs selftest --out=test/traces/latest.json
node scripts/hw-test.mjs card
node scripts/hw-test.mjs full-card
```

## Status

- **Upstream-verified (firmware 2.4.0.24 on macOS Chrome per upstream README):** handshake, prelude, single-container text/list, gestures.
- **New fork features (multi-container `setPage`, borders/padding, 4-bpp BMP `Cmd=3` streaming, `shutdown`, `setImu`):** verified offline against an independent codec & mock GATT peripheral; **not yet verified on physical G2 hardware**.
- **Deferred (wire field numbers not yet mapped):** `zOrderIndex`, `textColor` (0..4), contextual `menuObject`, and `CompressMode=2` (LZ4).

## License

MIT. See [LICENSE](LICENSE).
