// image.js: 4-bpp indexed BMP encoding and tiling for Even Realities G2 EvenHub ImageContainers.
// Zero dependencies. Pure ES module (MIT).

export const G2_WIDTH = 576;
export const G2_HEIGHT = 288;
export const G2_TILE_WIDTH = 288;
export const G2_TILE_HEIGHT = 144;
export const MAX_IMAGE_FRAGMENT_BYTES = 4096;

/** 16-entry grayscale BGRA palette (entry i = i * 17, alpha = 0). */
export const EVEN_PALETTE_GRAY16 = (() => {
  const pal = new Uint8Array(16 * 4);
  for (let i = 0; i < 16; i++) {
    const v = i * 17;
    pal[i * 4 + 0] = v;
    pal[i * 4 + 1] = v;
    pal[i * 4 + 2] = v;
    pal[i * 4 + 3] = 0;
  }
  return pal;
})();

/** True if `bytes` begins with a BMP ('BM') header. */
export function isBmp(bytes) {
  return bytes instanceof Uint8Array && bytes.length >= 54 && bytes[0] === 0x42 && bytes[1] === 0x4d;
}

/** Read `{ width, height, bpp, pixelOffset, fileSize }` from a BMP header. */
export function readBmpHeader(bmp) {
  if (!isBmp(bmp)) throw new Error("Not a valid BMP buffer");
  const view = new DataView(bmp.buffer, bmp.byteOffset, bmp.byteLength);
  const fileSize = view.getUint32(2, true);
  const pixelOffset = view.getUint32(10, true);
  const dibSize = view.getUint32(14, true);
  const width = view.getInt32(18, true);
  const rawHeight = view.getInt32(22, true);
  const bpp = view.getUint16(28, true);
  const compression = view.getUint32(30, true);
  const colorsUsed = view.getUint32(46, true);
  return {
    fileSize,
    pixelOffset,
    dibSize,
    width,
    height: Math.abs(rawHeight),
    topDown: rawHeight < 0,
    bpp,
    compression,
    colorsUsed,
  };
}

/**
 * Build a 4-bpp indexed BMP with the 16-step grayscale palette.
 * `pixel(x, y)` returns 0..15 (0 = black/off, 15 = brightest green).
 * Rows are stored bottom-up and padded to a 4-byte boundary per the BMP spec.
 */
export function buildBmp4bpp(width, height, pixel) {
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new RangeError(`Invalid BMP dimensions: ${width}x${height}`);
  }
  const bytesPerRow = Math.ceil(width / 2);
  const rowStride = (bytesPerRow + 3) & ~3;
  const pixelDataSize = rowStride * height;

  const fileHeaderSize = 14;
  const dibHeaderSize = 40;
  const paletteSize = EVEN_PALETTE_GRAY16.length;
  const pixelOffset = fileHeaderSize + dibHeaderSize + paletteSize; // 118
  const fileSize = pixelOffset + pixelDataSize;

  const buf = new Uint8Array(fileSize);
  const view = new DataView(buf.buffer);

  // BITMAPFILEHEADER (14 bytes)
  buf[0] = 0x42; // 'B'
  buf[1] = 0x4d; // 'M'
  view.setUint32(2, fileSize, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, 0, true);
  view.setUint32(10, pixelOffset, true);

  // BITMAPINFOHEADER (40 bytes)
  view.setUint32(14, dibHeaderSize, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true); // positive = bottom-up
  view.setUint16(26, 1, true);     // planes
  view.setUint16(28, 4, true);     // bits per pixel
  view.setUint32(30, 0, true);     // BI_RGB (uncompressed)
  view.setUint32(34, pixelDataSize, true);
  view.setInt32(38, 0, true);
  view.setInt32(42, 0, true);
  view.setUint32(46, 16, true);    // biClrUsed = 16
  view.setUint32(50, 0, true);     // biClrImportant

  buf.set(EVEN_PALETTE_GRAY16, fileHeaderSize + dibHeaderSize);

  for (let bmpRow = 0; bmpRow < height; bmpRow++) {
    const srcY = height - 1 - bmpRow;
    const rowOff = pixelOffset + bmpRow * rowStride;
    for (let x = 0; x < width; x += 2) {
      const hi = pixel(x, srcY) & 0x0f;
      const lo = (x + 1 < width ? pixel(x + 1, srcY) : 0) & 0x0f;
      buf[rowOff + (x >> 1)] = (hi << 4) | lo;
    }
  }
  return buf;
}

/** Build an all-zero (blank) 4-bpp BMP of `width × height` (used for warmup frames). */
export function buildBlankBmp4bpp(width, height) {
  return buildBmp4bpp(width, height, () => 0);
}

/** Convert an RGBA8 pixel to 4-bit gray (0..15) using Rec. 601 luminance. */
export function rgbaPixelToGray4(r, g, b, a = 255) {
  if (a === 0) return 0;
  const luma = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  return Math.min(15, Math.max(0, luma >> 4));
}

/** Convert an RGBA8 buffer (`width * height * 4` bytes, top-down) to 4-bpp BMP. */
export function rgbaToBmp4bpp(rgba, width, height) {
  if (rgba.length !== width * height * 4) {
    throw new RangeError(`rgba length ${rgba.length} != ${width}*${height}*4`);
  }
  return buildBmp4bpp(width, height, (x, y) => {
    const i = (y * width + x) * 4;
    return rgbaPixelToGray4(rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3] ?? 255);
  });
}

/** Convert a Gray8 buffer (`width * height` bytes, top-down) to 4-bpp BMP. */
export function gray8ToBmp4bpp(gray, width, height) {
  if (gray.length !== width * height) {
    throw new RangeError(`gray8 length ${gray.length} != ${width}*${height}`);
  }
  return buildBmp4bpp(width, height, (x, y) => (gray[y * width + x] >> 4) & 0x0f);
}

/** Convert an HTMLCanvasElement or OffscreenCanvas to a 4-bpp BMP. */
export function canvasToBmp4bpp(canvas) {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not acquire 2D context from canvas");
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return rgbaToBmp4bpp(data, width, height);
}

/**
 * Resample an RGBA buffer onto `targetWidth × targetHeight` (default 576×288)
 * and split it into a 2×2 grid of `288×144` 4-bpp BMP tiles.
 */
export function rgbaToTiles(
  srcRgba,
  srcWidth,
  srcHeight,
  { tileWidth = G2_TILE_WIDTH, tileHeight = G2_TILE_HEIGHT, targetWidth = G2_WIDTH, targetHeight = G2_HEIGHT } = {}
) {
  if (srcRgba.length !== srcWidth * srcHeight * 4) {
    throw new RangeError(`srcRgba length ${srcRgba.length} != ${srcWidth}*${srcHeight}*4`);
  }
  const tiles = [];
  const cols = Math.ceil(targetWidth / tileWidth);
  const rows = Math.ceil(targetHeight / tileHeight);
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      const x = tx * tileWidth;
      const y = ty * tileHeight;
      const w = Math.min(tileWidth, targetWidth - x);
      const h = Math.min(tileHeight, targetHeight - y);
      const bmp = buildBmp4bpp(w, h, (lx, ly) => {
        const dx = x + lx;
        const dy = y + ly;
        const sx = Math.min(srcWidth - 1, Math.floor((dx * srcWidth) / targetWidth));
        const sy = Math.min(srcHeight - 1, Math.floor((dy * srcHeight) / targetHeight));
        const i = (sy * srcWidth + sx) * 4;
        return rgbaPixelToGray4(srcRgba[i], srcRgba[i + 1], srcRgba[i + 2], srcRgba[i + 3] ?? 255);
      });
      tiles.push({ col: tx, row: ty, name: `t${tx}-${ty}`, x, y, width: w, height: h, bmp });
    }
  }
  return tiles;
}

/**
 * Generate an asymmetric 4-bpp diagnostic test card of `width × height`:
 * - Distinct corner markers (TL=solid square, TR=hollow frame, BL=diagonal slash, BR=checker)
 * - 16-step grayscale ramp across the center
 * - Bright 1-pixel marker on the rightmost column (x = width - 1) to catch odd-width stride/nibble bugs
 * - Optional short 5×7 bitmap label rendered cleanly in the upper half (e.g. a per-run random code)
 */
export function buildTestCardBmp(width, height, { label = "", cornerTag = "" } = {}) {
  const grid = new Uint8Array(width * height);
  const set = (x, y, v) => {
    if (x >= 0 && x < width && y >= 0 && y < height) grid[y * width + x] = v & 0x0f;
  };

  // Outer 1-px border (dim) + rightmost column marker (bright)
  for (let x = 0; x < width; x++) { set(x, 0, 5); set(x, height - 1, 5); }
  for (let y = 0; y < height; y++) { set(0, y, 5); set(width - 1, y, 15); }

  const cs = Math.max(6, Math.min(18, Math.floor(Math.min(width, height) / 6)));
  // Top-left: solid bright square
  for (let y = 3; y < 3 + cs; y++) for (let x = 3; x < 3 + cs; x++) set(x, y, 15);
  // Top-right: 2px hollow frame
  for (let y = 3; y < 3 + cs; y++) {
    for (let x = width - 3 - cs; x < width - 3; x++) {
      const edge = x <= width - 2 - cs || x >= width - 5 || y <= 4 || y >= 1 + cs;
      if (edge) set(x, y, 13);
    }
  }
  // Bottom-left: diagonal slash
  for (let k = 0; k < cs; k++) {
    set(3 + k, height - 3 - cs + k, 14);
    set(4 + k, height - 3 - cs + k, 14);
  }
  // Bottom-right: 2x2 checker
  for (let y = height - 3 - cs; y < height - 3; y++) {
    for (let x = width - 3 - cs; x < width - 3; x++) {
      if ((((x >> 1) + (y >> 1)) & 1) === 0) set(x, y, 12);
    }
  }

  // 16-step grayscale ramp in lower middle
  const rampY0 = Math.floor(height * 0.62);
  const rampY1 = Math.min(height - cs - 5, Math.floor(height * 0.84));
  const rampX0 = Math.max(4, Math.floor(width * 0.08));
  const rampX1 = Math.min(width - 4, Math.floor(width * 0.92));
  for (let y = rampY0; y < rampY1; y++) {
    for (let x = rampX0; x < rampX1; x++) {
      const step = Math.floor(((x - rampX0) / Math.max(1, rampX1 - rampX0)) * 16);
      set(x, y, Math.min(15, step));
    }
  }

  // Minimal 5x7 uppercase/digit bitmap text for label / cornerTag
  const drawText = (txt, ox, oy, scale = 2) => {
    let cx = ox;
    for (const ch of String(txt).toUpperCase()) {
      const glyph = FONT_5X7[ch] ?? FONT_5X7[" "];
      for (let gy = 0; gy < 7; gy++) {
        const row = glyph[gy];
        for (let gx = 0; gx < 5; gx++) {
          if ((row >> (4 - gx)) & 1) {
            for (let sy = 0; sy < scale; sy++) {
              for (let sx = 0; sx < scale; sx++) set(cx + gx * scale + sx, oy + gy * scale + sy, 15);
            }
          }
        }
      }
      cx += 6 * scale;
    }
  };

  if (cornerTag) drawText(cornerTag, 6 + cs, 4, 1);
  if (label) {
    const scale = width >= 180 ? 2 : 1;
    const textW = label.length * 6 * scale;
    const ox = Math.max(4, Math.floor((width - textW) / 2));
    const oy = Math.max(4, Math.floor(height * 0.30));
    drawText(label, ox, oy, scale);
  }

  return buildBmp4bpp(width, height, (x, y) => grid[y * width + x]);
}

const FONT_5X7 = {
  " ": [0, 0, 0, 0, 0, 0, 0],
  "-": [0, 0, 0, 31, 0, 0, 0],
  "0": [14, 17, 19, 21, 25, 17, 14],
  "1": [4, 12, 4, 4, 4, 4, 14],
  "2": [14, 17, 1, 6, 8, 16, 31],
  "3": [14, 17, 1, 6, 1, 17, 14],
  "4": [2, 6, 10, 18, 31, 2, 2],
  "5": [31, 16, 30, 1, 1, 17, 14],
  "6": [6, 8, 16, 30, 17, 17, 14],
  "7": [31, 1, 2, 4, 8, 8, 8],
  "8": [14, 17, 17, 14, 17, 17, 14],
  "9": [14, 17, 17, 15, 1, 2, 12],
  A: [14, 17, 17, 31, 17, 17, 17],
  B: [30, 17, 17, 30, 17, 17, 30],
  C: [14, 17, 16, 16, 16, 17, 14],
  D: [30, 17, 17, 17, 17, 17, 30],
  E: [31, 16, 16, 30, 16, 16, 31],
  F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 23, 17, 17, 14],
  H: [17, 17, 17, 31, 17, 17, 17],
  I: [14, 4, 4, 4, 4, 4, 14],
  J: [7, 2, 2, 2, 2, 18, 12],
  K: [17, 18, 20, 24, 20, 18, 17],
  L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 17, 17, 17, 17],
  N: [17, 25, 21, 19, 17, 17, 17],
  O: [14, 17, 17, 17, 17, 17, 14],
  P: [30, 17, 17, 30, 16, 16, 16],
  Q: [14, 17, 17, 17, 21, 18, 13],
  R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30],
  T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14],
  V: [17, 17, 17, 17, 17, 10, 4],
  W: [17, 17, 17, 17, 21, 27, 17],
  X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 10, 4, 4, 4, 4],
  Z: [31, 1, 2, 4, 8, 16, 31],
};

/** Split a BMP buffer into Cmd=3 app-level fragments (≤ 4096 B each). */
export function planImageFragments(bmp, maxFragmentSize = 3800) {
  if (!Number.isInteger(maxFragmentSize) || maxFragmentSize <= 0 || maxFragmentSize > MAX_IMAGE_FRAGMENT_BYTES) {
    throw new RangeError(`maxFragmentSize must be 1..${MAX_IMAGE_FRAGMENT_BYTES}, got ${maxFragmentSize}`);
  }
  const count = Math.max(1, Math.ceil(bmp.length / maxFragmentSize));
  const out = [];
  for (let i = 0; i < count; i++) {
    const start = i * maxFragmentSize;
    const end = Math.min(start + maxFragmentSize, bmp.length);
    out.push({ index: i, data: bmp.subarray(start, end) });
  }
  return out;
}

/** Fast 32-bit FNV-1a hash for image frame deduplication. */
export function fnv1a32(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}
