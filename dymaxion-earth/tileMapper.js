'use strict';
/**
 * tileMapper.js
 * Tile coordinate math, fetching, disk caching, and image warping.
 *
 * Tile system: Web Mercator / TMS (same as Google Maps, OpenStreetMap).
 * ESRI World Imagery: https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// node-canvas may fail to install; gracefully degrade
let createCanvas, loadImage, canvasAvailable;
try {
  ({ createCanvas, loadImage } = require('canvas'));
  canvasAvailable = true;
} catch (e) {
  canvasAvailable = false;
  console.warn('[tileMapper] node-canvas not available — SVG-only mode');
}

const TILE_SIZE = 256;
const TILE_BASE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile';
const TILE_DELAY_MS = 50; // minimum ms between requests

// ─── Tile math ───────────────────────────────────────────────────────────────

/**
 * Tile zoom level — fixed at 5 for all subdivision levels.
 */
function zoomForLevel(_subdivLevel) {
  return 5;
}

/**
 * Convert lat/lng (degrees) to tile XY at a given zoom level.
 * Uses Web Mercator (EPSG:3857).
 * Returns { tx, ty } (integer tile coords).
 */
function latLngToTile(lat, lng, zoom) {
  const n = Math.pow(2, zoom);
  const tx = Math.floor((lng + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const ty = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  return {
    tx: Math.max(0, Math.min(n - 1, tx)),
    ty: Math.max(0, Math.min(n - 1, ty)),
  };
}

/**
 * Convert tile XY to NW corner lat/lng in degrees.
 */
function tileToLatLng(tx, ty, zoom) {
  const n = Math.pow(2, zoom);
  const lng = tx / n * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * ty / n)));
  const lat = latRad * 180 / Math.PI;
  return { lat, lng };
}

/**
 * Convert a lat to tile Y at a given zoom level.
 */
function latToTileY(lat, zoom) {
  const n = Math.pow(2, zoom);
  const latClamped = Math.max(-85, Math.min(85, lat));
  const latRad = latClamped * Math.PI / 180;
  return Math.max(0, Math.min(n - 1,
    Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n)
  ));
}

/**
 * Get all tile XYZ coords covering a spherical triangle, correctly handling
 * antimeridian crossing.
 *
 * Antimeridian fix: instead of a simple bbox in [-180,180] space (which
 * creates a huge gap in the tile patch for crossing triangles), we compute
 * "virtual tile X" (vtx) by unwrapping each vertex's tile-column relative to
 * the first vertex using the shortest-arc rule.  vtx may be < 0 or >= n;
 * physical tx is always (vtx % n + n) % n.  The virtualTx property is stored
 * on every returned tile so that buildPatchFromBuffers can place them
 * contiguously without gaps.
 *
 * @param {Array} triLatLng - [[lat,lng],[lat,lng],[lat,lng]] in degrees
 * @param {number} zoom
 * @returns {Array<{z,tx,ty,virtualTx}>}
 */
function getTriangleTiles(triLatLng, zoom) {
  const n = Math.pow(2, zoom);

  // ── Compute centroid lat/lng (antimeridian-safe lng averaging) ──────────
  const lats = triLatLng.map(([lat]) => lat);
  const lngs = triLatLng.map(([, lng]) => lng);
  // Unwrap lngs relative to vertex 0 before averaging so a triangle whose
  // vertices straddle ±180° gets a sensible centroid lng.
  const refLng = lngs[0];
  const unwrappedLngs = lngs.map(lng => {
    let d = lng - refLng;
    if (d >  180) d -= 360;
    if (d < -180) d += 360;
    return refLng + d;
  });
  const centroidLat = lats.reduce((s, v) => s + v, 0) / 3;
  // Normalise back to [-180, 180]
  let centroidLng = unwrappedLngs.reduce((s, v) => s + v, 0) / 3;
  centroidLng = ((centroidLng % 360) + 540) % 360 - 180;

  // ── Polar-face override ─────────────────────────────────────────────────
  // Near the poles, Web-Mercator longitude lines converge so the three vertex
  // lngs can span up to 360°.  The unwrapping logic below would generate a
  // vtx range covering the entire globe → wrong tiles, stripe artifacts.
  // Fix: replace the vertex-derived bbox with a tight 10°×10° box centred on
  // the face centroid.  At |lat| > 60° this is always small enough to be
  // non-crossing and fits within a handful of tiles.
  if (Math.abs(centroidLat) > 60) {
    const boxLat0 = Math.max(-85, centroidLat - 5);
    const boxLat1 = Math.min(85,  centroidLat + 5);
    const boxLng0 = centroidLng - 5;
    const boxLng1 = centroidLng + 5;

    const tyMin = latToTileY(boxLat1, zoom); // north edge → smaller ty
    const tyMax = latToTileY(boxLat0, zoom); // south edge → larger ty
    const txMin = Math.max(0,     Math.floor((boxLng0 + 180) / 360 * n));
    const txMax = Math.min(n - 1, Math.floor((boxLng1 + 180) / 360 * n));

    const tiles = [];
    for (let ty = tyMin; ty <= tyMax; ty++) {
      for (let tx = txMin; tx <= txMax; tx++) {
        tiles.push({ z: zoom, tx, ty, virtualTx: tx });
      }
    }
    return tiles;
  }

  // ── Normal (non-polar) path: unwrap gx relative to vertex 0 ─────────────
  // Converts an antimeridian-spanning triangle, e.g. gx = [0.2, 15.8, 8.0],
  // into a contiguous range [0.2, -0.2, 8.0] so vtxMin..vtxMax has no gap.
  const gxTile = triLatLng.map(([, lng]) => (lng + 180) / 360 * n);
  const ref = gxTile[0];
  const unwrapped = gxTile.map(gx => {
    let d = gx - ref;
    if (d >  n / 2) d -= n;
    if (d < -n / 2) d += n;
    return ref + d;
  });

  const vtxMin = Math.floor(Math.min(...unwrapped));
  const vtxMax = Math.floor(Math.max(...unwrapped));

  const tyMin = latToTileY(Math.max(...lats), zoom);
  const tyMax = latToTileY(Math.min(...lats), zoom);

  const tiles = [];
  for (let ty = tyMin; ty <= tyMax; ty++) {
    for (let vtx = vtxMin; vtx <= vtxMax; vtx++) {
      const tx = ((vtx % n) + n) % n;
      tiles.push({ z: zoom, tx, ty, virtualTx: vtx });
    }
  }
  return tiles;
}

/**
 * Legacy bbox-based tile collector (kept for reference; server.js uses
 * getTriangleTiles instead).
 */
function tilesForBBox(minLat, maxLat, minLng, maxLng, zoom) {
  const n = Math.pow(2, zoom);
  minLng = ((minLng + 180) % 360 + 360) % 360 - 180;
  maxLng = ((maxLng + 180) % 360 + 360) % 360 - 180;
  if (maxLng < minLng) maxLng += 360;
  const { tx: txMin, ty: tyMax } = latLngToTile(Math.max(-85, minLat), minLng, zoom);
  const { tx: txMax, ty: tyMin } = latLngToTile(Math.min(85, maxLat), maxLng, zoom);
  const tiles = [];
  for (let ty = tyMin; ty <= tyMax; ty++) {
    for (let tx = txMin; tx <= txMax; tx++) {
      tiles.push({ z: zoom, tx: ((tx % n) + n) % n, ty });
    }
  }
  return tiles;
}

// ─── Tile fetching & caching ─────────────────────────────────────────────────

let lastFetchTime = 0;

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch a single tile as a Buffer. Respects TILE_DELAY_MS between requests.
 * Retries once on failure. Returns null on persistent failure.
 */
async function fetchTile(z, tx, ty) {
  const now = Date.now();
  const elapsed = now - lastFetchTime;
  if (elapsed < TILE_DELAY_MS) {
    await sleep(TILE_DELAY_MS - elapsed);
  }
  lastFetchTime = Date.now();

  const url = `${TILE_BASE_URL}/${z}/${ty}/${tx}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const buf = await httpGet(url);
      return buf;
    } catch (err) {
      if (attempt === 0) {
        await sleep(500);
      } else {
        console.warn(`[tileMapper] Failed to fetch tile z=${z} x=${tx} y=${ty}: ${err.message}`);
        return null;
      }
    }
  }
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { headers: { 'User-Agent': 'DymaxionEarth/1.0' } }, res => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Get a tile as a Buffer, using disk cache if available.
 * cacheDir: path to tile-cache directory.
 */
async function getTile(z, tx, ty, cacheDir, useCache = true) {
  const tilePath = path.join(cacheDir, String(z), String(tx), `${ty}.png`);

  if (useCache && fs.existsSync(tilePath)) {
    // Validate cache entry
    try {
      const buf = fs.readFileSync(tilePath);
      if (buf.length > 100) return buf; // basic sanity check
      // Corrupted — delete and re-fetch
      fs.unlinkSync(tilePath);
    } catch (e) {
      // Corrupted — fall through to fetch
    }
  }

  const buf = await fetchTile(z, tx, ty);
  if (buf) {
    // Write to cache
    fs.mkdirSync(path.dirname(tilePath), { recursive: true });
    fs.writeFileSync(tilePath, buf);
  }
  return buf;
}

// ─── Image compositing ───────────────────────────────────────────────────────

/**
 * Build a composite image patch covering the given tiles.
 * Returns { canvas, originX, originY, tileSize } where:
 *   originX/Y = pixel coords of the NW corner of tile (txMin, tyMin) in the
 *               global pixel space at the given zoom.
 */
async function buildTilePatch(tiles, z, cacheDir, useCache, progressCb) {
  if (!canvasAvailable) return null;
  if (tiles.length === 0) return null;

  const txMin = Math.min(...tiles.map(t => t.tx));
  const txMax = Math.max(...tiles.map(t => t.tx));
  const tyMin = Math.min(...tiles.map(t => t.ty));
  const tyMax = Math.max(...tiles.map(t => t.ty));

  const cols = txMax - txMin + 1;
  const rows = tyMax - tyMin + 1;

  const canvas = createCanvas(cols * TILE_SIZE, rows * TILE_SIZE);
  const ctx = canvas.getContext('2d');

  // Fill with gray fallback
  ctx.fillStyle = '#555';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (const { tx, ty } of tiles) {
    const buf = await getTile(z, tx, ty, cacheDir, useCache);
    if (progressCb) progressCb(tx, ty);
    if (!buf) continue;

    try {
      const img = await loadImage(buf);
      const px = (tx - txMin) * TILE_SIZE;
      const py = (ty - tyMin) * TILE_SIZE;
      ctx.drawImage(img, px, py);
    } catch (e) {
      // Draw gray placeholder for this tile
    }
  }

  return {
    canvas,
    originTx: txMin,
    originTy: tyMin,
    zoom: z,
  };
}

// ─── Affine warp: tile patch → triangle ─────────────────────────────────────

/**
 * Convert a lat/lng point to pixel coords within the tile patch.
 * Uses Web Mercator projection.
 */
function latLngToPixel(lat, lng, zoom, originTx, originTy) {
  const n = Math.pow(2, zoom);
  // Global pixel position
  const gx = (lng + 180) / 360 * n * TILE_SIZE;
  const latRad = lat * Math.PI / 180;
  const gy = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n * TILE_SIZE;
  // Relative to patch origin
  return {
    px: gx - originTx * TILE_SIZE,
    py: gy - originTy * TILE_SIZE,
  };
}

/**
 * Warp the tile patch to fill a triangle in the output canvas.
 * Uses scanline rasterization with bilinear sampling from the source patch.
 *
 * Source pixel computation uses antimeridian-safe "unwrapped gx":
 * each vertex's tile-column is unwrapped relative to vertex 0 so the three
 * source pixels are always contiguous — matching the virtualTx-based patch
 * layout produced by buildPatchFromBuffers.
 *
 * @param {CanvasRenderingContext2D} outCtx    - output canvas context
 * @param {Canvas} patchCanvas                 - source tile patch
 * @param {Array}  triLatLng                   - [[lat,lng],[lat,lng],[lat,lng]]
 * @param {Array}  triNet                      - [[x,y],[x,y],[x,y]] SVG output coords
 * @param {number} zoom
 * @param {number} originVirtualTx             - min virtualTx of the patch (may be < 0)
 * @param {number} originTy                    - min ty of the patch
 */
function warpTriangle(outCtx, patchCanvas, triLatLng, triNet, zoom, originVirtualTx, originTy) {
  if (!canvasAvailable) return;
  const n = Math.pow(2, zoom);

  // --- Antimeridian-safe source pixel computation -------------------------
  // Compute gx in tile-column units, then unwrap relative to vertex 0 so
  // crossing vertices get gx values that are contiguous (not jumping by ~n).
  const gxTile = triLatLng.map(([, lng]) => (lng + 180) / 360 * n);
  const ref = gxTile[0];
  const unwrappedGxTile = gxTile.map(gx => {
    let d = gx - ref;
    if (d >  n / 2) d -= n;
    if (d < -n / 2) d += n;
    return ref + d;
  });

  // Source pixel coords for each triangle vertex in the patch canvas.
  const src = triLatLng.map(([lat], i) => {
    const latClamped = Math.max(-85.05, Math.min(85.05, lat));
    const latRad = latClamped * Math.PI / 180;
    const gy = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI)
               / 2 * n * TILE_SIZE;
    const px = unwrappedGxTile[i] * TILE_SIZE - originVirtualTx * TILE_SIZE;
    const py = gy - originTy * TILE_SIZE;
    return [px, py];
  });

  // Destination triangle (output SVG space)
  const dst = triNet;

  // Compute affine transform from dst → src (3x3 2D homogeneous)
  const [A, B] = computeAffine(dst, src);

  // Bounding box of destination triangle
  const dstXs = dst.map(p => p[0]);
  const dstYs = dst.map(p => p[1]);
  const x0 = Math.floor(Math.min(...dstXs));
  const x1 = Math.ceil(Math.max(...dstXs));
  const y0 = Math.floor(Math.min(...dstYs));
  const y1 = Math.ceil(Math.max(...dstYs));

  const W = x1 - x0;
  const H = y1 - y0;
  if (W <= 0 || H <= 0) return;

  // Create a small canvas for this triangle region
  const triCanvas = createCanvas(W, H);
  const triCtx = triCanvas.getContext('2d');
  const imgData = triCtx.createImageData(W, H);
  const srcCtx = patchCanvas.getContext('2d');

  // Get patch pixel data for efficient sampling
  const patchW = patchCanvas.width;
  const patchH = patchCanvas.height;
  let patchData;
  try {
    patchData = srcCtx.getImageData(0, 0, patchW, patchH).data;
  } catch (e) {
    return;
  }

  // Precompute edge functions for triangle membership test
  const inside = makePointInTriangle(dst);

  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const ox = x0 + px;
      const oy = y0 + py;

      if (!inside(ox + 0.5, oy + 0.5)) continue;

      // Apply affine transform to get source pixel
      const sx = A[0]*ox + A[1]*oy + A[2];
      const sy = B[0]*ox + B[1]*oy + B[2];

      // Bilinear sample from patch
      const color = sampleBilinear(patchData, patchW, patchH, sx, sy);
      const idx = (py * W + px) * 4;
      imgData.data[idx]   = color[0];
      imgData.data[idx+1] = color[1];
      imgData.data[idx+2] = color[2];
      imgData.data[idx+3] = 255;
    }
  }

  triCtx.putImageData(imgData, 0, 0);

  // Clip to triangle shape then draw onto output
  outCtx.save();
  outCtx.beginPath();
  outCtx.moveTo(dst[0][0], dst[0][1]);
  outCtx.lineTo(dst[1][0], dst[1][1]);
  outCtx.lineTo(dst[2][0], dst[2][1]);
  outCtx.closePath();
  outCtx.clip();
  outCtx.drawImage(triCanvas, x0, y0);
  outCtx.restore();
}

/**
 * Compute affine matrix mapping src triangle → dst triangle.
 * Returns [rowA, rowB] where each row is [a, b, c] s.t. x' = a*x + b*y + c.
 */
function computeAffine(src, dst) {
  const [[x0,y0],[x1,y1],[x2,y2]] = src;
  const [[u0,v0],[u1,v1],[u2,v2]] = dst;

  // Solve: [u0 u1 u2; v0 v1 v2] = M * [x0 x1 x2; y0 y1 y2; 1 1 1]
  // M = [u0 u1 u2; v0 v1 v2] * inv([x0 x1 x2; y0 y1 y2; 1 1 1])
  const det = x0*(y1-y2) - x1*(y0-y2) + x2*(y0-y1);
  if (Math.abs(det) < 1e-10) return [[1,0,0],[0,1,0]];

  const invDet = 1 / det;
  const i00 = (y1-y2)*invDet,  i01 = (x2-x1)*invDet,  i02 = (x1*y2-x2*y1)*invDet;
  const i10 = (y2-y0)*invDet,  i11 = (x0-x2)*invDet,  i12 = (x2*y0-x0*y2)*invDet;
  const i20 = (y0-y1)*invDet,  i21 = (x1-x0)*invDet,  i22 = (x0*y1-x1*y0)*invDet;

  // Row for u: [a,b,c] s.t. u = a*x + b*y + c
  const rowA = [
    u0*i00 + u1*i10 + u2*i20,
    u0*i01 + u1*i11 + u2*i21,
    u0*i02 + u1*i12 + u2*i22,
  ];
  const rowB = [
    v0*i00 + v1*i10 + v2*i20,
    v0*i01 + v1*i11 + v2*i21,
    v0*i02 + v1*i12 + v2*i22,
  ];
  return [rowA, rowB];
}

/**
 * Returns a function that tests if a point is inside a triangle.
 */
function makePointInTriangle(tri) {
  const [[ax,ay],[bx,by],[cx,cy]] = tri;
  return function(px, py) {
    const d1 = sign(px,py,ax,ay,bx,by);
    const d2 = sign(px,py,bx,by,cx,cy);
    const d3 = sign(px,py,cx,cy,ax,ay);
    const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
    const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);
    return !(hasNeg && hasPos);
  };
}
function sign(p1x,p1y,p2x,p2y,p3x,p3y) {
  return (p1x-p3x)*(p2y-p3y)-(p2x-p3x)*(p1y-p3y);
}

/**
 * Bilinear sample from a flat RGBA pixel array.
 */
function sampleBilinear(data, W, H, x, y) {
  x = Math.max(0, Math.min(W - 1.001, x));
  y = Math.max(0, Math.min(H - 1.001, y));
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = x0 + 1, y1 = y0 + 1;
  const fx = x - x0, fy = y - y0;

  function px(xi, yi) {
    xi = Math.max(0, Math.min(W-1, xi));
    yi = Math.max(0, Math.min(H-1, yi));
    const i = (yi * W + xi) * 4;
    return [data[i], data[i+1], data[i+2]];
  }

  const c00 = px(x0,y0), c10 = px(x1,y0);
  const c01 = px(x0,y1), c11 = px(x1,y1);

  return [
    Math.round(c00[0]*(1-fx)*(1-fy) + c10[0]*fx*(1-fy) + c01[0]*(1-fx)*fy + c11[0]*fx*fy),
    Math.round(c00[1]*(1-fx)*(1-fy) + c10[1]*fx*(1-fy) + c01[1]*(1-fx)*fy + c11[1]*fx*fy),
    Math.round(c00[2]*(1-fx)*(1-fy) + c10[2]*fx*(1-fy) + c01[2]*(1-fx)*fy + c11[2]*fx*fy),
  ];
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  zoomForLevel,
  latLngToTile,
  tileToLatLng,
  tilesForBBox,
  getTriangleTiles,
  getTile,
  buildTilePatch,
  warpTriangle,
  canvasAvailable: () => canvasAvailable,
  latLngToPixel,
  TILE_SIZE,
};
