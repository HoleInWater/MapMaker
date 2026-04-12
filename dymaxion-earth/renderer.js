'use strict';
/**
 * renderer.js
 *
 * Replaces the entire tile-based tileMapper.js approach.
 *
 * Strategy: download ONE NASA Blue Marble equirectangular JPEG (5400×2700),
 * load it into memory as a flat RGBA pixel array, then for every Dymaxion
 * face render pixel-by-pixel using:
 *
 *   output pixel (ox,oy)
 *     → barycentric coords within the 2D net triangle
 *     → interpolate + re-normalise three unit-sphere vertices
 *     → lat = asin(z),  lng = atan2(y,x)
 *     → equirectangular pixel: x=(lng+π)/(2π)*W,  y=(π/2−lat)/π*H
 *     → bilinear sample
 *
 * This is geometrically correct for ALL faces — polar, antimeridian-crossing,
 * and everything else — because the source lookup is purely spherical and
 * requires no tile boundaries, seams, or coordinate-system hacks.
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');
const http  = require('http');

let createCanvas, loadImage, canvasAvailable;
try {
  ({ createCanvas, loadImage } = require('canvas'));
  canvasAvailable = true;
} catch (e) {
  canvasAvailable = false;
  console.warn('[renderer] node-canvas not available — SVG-only mode');
}

const WORLD_MAP_URL  = 'https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/73909/world.topo.bathy.200412.3x5400x2700.jpg';
const WORLD_MAP_FILE = path.join(__dirname, 'world-map.jpg');
const MIN_VALID_SIZE = 2_000_000; // bytes — anything smaller is a partial download

// ─── World map download ───────────────────────────────────────────────────────

/**
 * Ensure world-map.jpg exists locally and is complete.
 * On first run this downloads ~20 MB from NASA once.
 * progressCb(bytesReceived, totalBytes) is called during download.
 */
async function ensureWorldMap(progressCb) {
  if (fs.existsSync(WORLD_MAP_FILE)) {
    const { size } = fs.statSync(WORLD_MAP_FILE);
    if (size >= MIN_VALID_SIZE) return;          // already good
    fs.unlinkSync(WORLD_MAP_FILE);               // partial — re-download
  }
  await _download(WORLD_MAP_URL, WORLD_MAP_FILE, progressCb);
}

function _download(url, dest, progressCb, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 8) return reject(new Error('Too many redirects'));
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'DymaxionEarth/1.0' } }, res => {
      const { statusCode, headers } = res;
      if (statusCode === 301 || statusCode === 302 || statusCode === 307 || statusCode === 308) {
        res.resume();
        return resolve(_download(headers.location, dest, progressCb, hops + 1));
      }
      if (statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${statusCode} for ${url}`));
      }
      const total = parseInt(headers['content-length'] || '0', 10);
      let received = 0;
      const file = fs.createWriteStream(dest);
      res.on('data', chunk => {
        received += chunk.length;
        if (progressCb) progressCb(received, total);
      });
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      res.on('error',  err => { fs.unlink(dest, () => {}); reject(err); });
      file.on('error', err => { fs.unlink(dest, () => {}); reject(err); });
    });
    req.on('error', reject);
  });
}

// ─── World map load ───────────────────────────────────────────────────────────

/**
 * Load world-map.jpg into a flat RGBA Uint8ClampedArray for fast random access.
 * Returns { data: Uint8ClampedArray, width: number, height: number }.
 */
async function loadWorldMap() {
  if (!canvasAvailable) throw new Error('node-canvas is required for rendering');
  const img    = await loadImage(WORLD_MAP_FILE);
  const canvas = createCanvas(img.width, img.height);
  const ctx    = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, img.width, img.height);
  return { data, width: img.width, height: img.height };
}

// ─── Equirectangular sampler ──────────────────────────────────────────────────

/**
 * Bilinear sample of the equirectangular image at the given lat/lng (radians).
 *
 * Equirectangular mapping:
 *   px = (lng + π) / (2π) * W        → left edge = –180°, right = +180°
 *   py = (π/2 – lat) / π  * H        → top = +90°, bottom = –90°
 */
function sampleEquirect(data, W, H, lat, lng) {
  let x = (lng + Math.PI) / (2 * Math.PI) * W;
  let y = (Math.PI / 2 - lat) / Math.PI * H;

  // Clamp to valid pixel range
  x = Math.max(0, Math.min(W - 1.001, x));
  y = Math.max(0, Math.min(H - 1.001, y));

  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx  = x - x0,       fy  = y - y0;

  // Inline bilinear interpolation — hot path, avoid function calls
  function idx(xi, yi) {
    return (Math.min(H - 1, Math.max(0, yi)) * W + Math.min(W - 1, Math.max(0, xi))) * 4;
  }
  const i00 = idx(x0,   y0),   i10 = idx(x0+1, y0);
  const i01 = idx(x0,   y0+1), i11 = idx(x0+1, y0+1);

  const w00 = (1-fx)*(1-fy), w10 = fx*(1-fy);
  const w01 = (1-fx)*fy,     w11 = fx*fy;

  return [
    Math.round(data[i00]*w00 + data[i10]*w10 + data[i01]*w01 + data[i11]*w11),
    Math.round(data[i00+1]*w00 + data[i10+1]*w10 + data[i01+1]*w01 + data[i11+1]*w11),
    Math.round(data[i00+2]*w00 + data[i10+2]*w10 + data[i01+2]*w01 + data[i11+2]*w11),
  ];
}

// ─── Triangle rasterizer ──────────────────────────────────────────────────────

/**
 * Rasterize one Dymaxion face onto outCtx.
 *
 * Algorithm (per output pixel inside the 2D net triangle):
 *   1. Compute barycentric coords (w0, w1, w2) in 2D net space
 *   2. Interpolate the three unit-sphere vertices by (w0, w1, w2)
 *   3. Re-normalise to unit sphere
 *   4. lat = asin(z), lng = atan2(y, x)
 *   5. Bilinear-sample the equirectangular world map
 *
 * No tile fetching. No coordinate wrapping. Works for every face.
 *
 * @param {CanvasRenderingContext2D} outCtx
 * @param {Array} sphereTri  [[x,y,z], [x,y,z], [x,y,z]]  — unit sphere
 * @param {Array} netVerts   [[x,y],   [x,y],   [x,y]]    — 2-D SVG coords
 * @param {Object} worldMap  { data, width, height }
 */
function rasterizeTriangle(outCtx, sphereTri, netVerts, worldMap) {
  if (!canvasAvailable) return;

  const [v0, v1, v2] = sphereTri;        // unit-sphere vertices
  const [n0, n1, n2] = netVerts;         // 2-D destination vertices
  const { data: wData, width: wW, height: wH } = worldMap;

  // Destination bounding box
  const xMin = Math.floor(Math.min(n0[0], n1[0], n2[0]));
  const xMax = Math.ceil( Math.max(n0[0], n1[0], n2[0]));
  const yMin = Math.floor(Math.min(n0[1], n1[1], n2[1]));
  const yMax = Math.ceil( Math.max(n0[1], n1[1], n2[1]));
  const W = xMax - xMin;
  const H = yMax - yMin;
  if (W <= 0 || H <= 0) return;

  // Barycentric denominator (constant for this triangle)
  // w0 = [(n1y-n2y)(px-n2x) + (n2x-n1x)(py-n2y)] / denom
  // w1 = [(n2y-n0y)(px-n2x) + (n0x-n2x)(py-n2y)] / denom
  // w2 = 1 - w0 - w1
  const denom = (n1[1]-n2[1])*(n0[0]-n2[0]) + (n2[0]-n1[0])*(n0[1]-n2[1]);
  if (Math.abs(denom) < 1e-8) return;
  const invD = 1 / denom;

  // Precompute per-row increments for the barycentric coordinates.
  // Moving one pixel right: Δw0 = (n1y-n2y)*invD,  Δw1 = (n2y-n0y)*invD
  // Moving one pixel down:  Δw0 = (n2x-n1x)*invD,  Δw1 = (n0x-n2x)*invD
  const dw0_dx = (n1[1]-n2[1]) * invD;
  const dw1_dx = (n2[1]-n0[1]) * invD;
  const dw0_dy = (n2[0]-n1[0]) * invD;
  const dw1_dy = (n0[0]-n2[0]) * invD;

  // Rasterize into a local ImageData buffer (avoids repeated large-canvas reads)
  const triCanvas = createCanvas(W, H);
  const triCtx    = triCanvas.getContext('2d');
  const imgData   = triCtx.createImageData(W, H);
  const buf       = imgData.data;

  // Initial barycentric coords for the top-left corner of the bbox
  const ox0 = xMin + 0.5, oy0 = yMin + 0.5;  // pixel centres
  let row_w0 = ((n1[1]-n2[1])*(ox0-n2[0]) + (n2[0]-n1[0])*(oy0-n2[1])) * invD;
  let row_w1 = ((n2[1]-n0[1])*(ox0-n2[0]) + (n0[0]-n2[0])*(oy0-n2[1])) * invD;

  for (let py = 0; py < H; py++) {
    let w0 = row_w0, w1 = row_w1;

    for (let px = 0; px < W; px++) {
      const w2 = 1 - w0 - w1;

      if (w0 >= -1e-6 && w1 >= -1e-6 && w2 >= -1e-6) {
        // Interpolate sphere point and re-normalise
        let sx = w0*v0[0] + w1*v1[0] + w2*v2[0];
        let sy = w0*v0[1] + w1*v1[1] + w2*v2[1];
        let sz = w0*v0[2] + w1*v1[2] + w2*v2[2];
        const len = Math.sqrt(sx*sx + sy*sy + sz*sz);
        if (len > 1e-10) {
          sx /= len; sy /= len; sz /= len;
          const lat = Math.asin(Math.max(-1, Math.min(1, sz)));
          const lng = Math.atan2(sy, sx);
          const [r, g, b] = sampleEquirect(wData, wW, wH, lat, lng);
          const i = (py * W + px) * 4;
          buf[i] = r; buf[i+1] = g; buf[i+2] = b; buf[i+3] = 255;
        }
      }

      w0 += dw0_dx;
      w1 += dw1_dx;
    }
    row_w0 += dw0_dy;
    row_w1 += dw1_dy;
  }

  triCtx.putImageData(imgData, 0, 0);

  // Clip to triangle shape and blit onto the main output canvas
  outCtx.save();
  outCtx.beginPath();
  outCtx.moveTo(n0[0], n0[1]);
  outCtx.lineTo(n1[0], n1[1]);
  outCtx.lineTo(n2[0], n2[1]);
  outCtx.closePath();
  outCtx.clip();
  outCtx.drawImage(triCanvas, xMin, yMin);
  outCtx.restore();
}

module.exports = {
  ensureWorldMap,
  loadWorldMap,
  rasterizeTriangle,
  worldMapFile: WORLD_MAP_FILE,
  canvasAvailable: () => canvasAvailable,
};
