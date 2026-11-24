#!/usr/bin/env node
// scripts/visual-verify.mjs
// Slim Playwright UI screenshot capture for index.html (drives Demo Preview over
// the independent MockG2Peripheral so screenshots reflect decoded wire bytes).

import http from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const shotsDir = path.join(repoRoot, "shots");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function startStaticServer() {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const urlPath = (req.url || "/").split("?")[0];
      const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
      const filePath = path.resolve(repoRoot, rel);
      if (!filePath.startsWith(repoRoot)) {
        res.writeHead(403).end();
        return;
      }
      try {
        const data = await readFile(filePath);
        res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
        res.end(data);
      } catch {
        res.writeHead(404).end("Not found");
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/` });
    });
  });
}

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const candidates = [
    process.env.PLAYWRIGHT_CORE_PATH,
    path.join(repoRoot, "node_modules/playwright-core"),
    path.resolve(repoRoot, "../sites/bin/node_modules/playwright-core"),
  ].filter(Boolean);
  for (const p of candidates) {
    try { return require(p); } catch {}
  }
  throw new Error("playwright-core not found (install it or set PLAYWRIGHT_CORE_PATH)");
}

async function main() {
  await mkdir(shotsDir, { recursive: true });
  const { server, url } = await startStaticServer();
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ headless: true });
  const errors = [];

  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 840 } });
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

    await page.goto(url, { waitUntil: "networkidle" });
    await page.click("#demo-btn");
    await page.waitForFunction(() => document.querySelector("#btn-dash")?.disabled === false);

    // 1. Mixed dashboard (text + list + 144x112 4-bpp BMP image)
    await page.click("#btn-dash");
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(shotsDir, "01-dashboard.png"), fullPage: true });
    await page.locator("#lens").screenshot({ path: path.join(shotsDir, "01-dashboard-lens.png") });

    // 2. Full-lens 2x2 asymmetric test card (576x288)
    await page.click("#btn-full-card");
    await page.waitForTimeout(350);
    await page.locator("#lens").screenshot({ path: path.join(shotsDir, "02-full-testcard-lens.png") });

    // 3. Hardware Self-Test tab + run step 2 (multi-text-list)
    await page.click('[data-tab="selftest"]');
    await page.click('[data-run-step="multi-text-list"]');
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(shotsDir, "03-selftest.png"), fullPage: true });

    if (errors.length > 0) {
      throw new Error(`Browser console/page errors:\n${errors.join("\n")}`);
    }
    console.log("Saved screenshots in", shotsDir);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
