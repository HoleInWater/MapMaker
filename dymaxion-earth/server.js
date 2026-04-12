'use strict';
/**
 * server.js
 * Express server for Dymaxion Earth.
 * - Serves the frontend at GET /
 * - Streams generation progress via SSE at GET /generate
 * - Serves output files at GET /output/:file
 */

const express = require('express');
const path = require('path');
const fs = require('fs');

const { buildNetLayout, xyzToLatLng, triangleBBox } = require('./geodesic');
const { zoomForLevel, tilesForBBox, getTile, buildTilePatch, warpTriangle, canvasAvailable, latLngToPixel, TILE_SIZE } = require('./tileMapper');
const { buildSVG, renderTrianglePNG, SVG_W, SVG_H } = require('./svgBuilder');

const app = express();
const PORT = 3000;
const CACHE_DIR = path.join(__dirname, 'tile-cache');
const OUTPUT_DIR = path.join(__dirname, 'output');

fs.mkdirSync(CACHE_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// canvas may not be available
let createCanvas;
try {
  ({ createCanvas } = require('canvas'));
} catch (e) {}

app.use(express.static(path.join(__dirname, 'public')));
app.use('/output', express.static(OUTPUT_DIR));

// ─── Tile count estimates ────────────────────────────────────────────────────

const TILE_ESTIMATES = { 1: 80, 2: 280, 3: 1100, 4: 4200, 5: 16000 };
const OVERHEAD_S     = { 1: 2,  2: 5,   3: 15,   4: 60,   5: 240 };

app.get('/estimate', (req, res) => {
  const level = parseInt(req.query.level) || 1;
  const tiles = TILE_ESTIMATES[level] || 80;
  const secs = Math.round(tiles * 0.1 + (OVERHEAD_S[level] || 2));
  res.json({ level, tiles, estimatedSeconds: secs });
});

// ─── SSE Generation endpoint ─────────────────────────────────────────────────

app.get('/generate', async (req, res) => {
  const level    = Math.max(1, Math.min(5, parseInt(req.query.level) || 1));
  const useCache = req.query.cache !== 'false';
  const showMesh = req.query.mesh !== 'false';

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  function send(data) {
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (e) {}
  }

  function progress(pct, status, phase, extra = {}) {
    send({ type: 'progress', pct: Math.round(pct), status, phase, ...extra });
  }

  const startTime = Date.now();
  send({ type: 'start', level });

  try {
    // ── Phase 1: Build geodesic net layout ──────────────────────────────────
    progress(1, 'Building geodesic sphere...', 'Phase 1: Building geometry');
    const netLayout = buildNetLayout(level);
    const totalTris = netLayout.length;
    send({ type: 'info', totalTris });

    // ── Phase 2: Collect all required tiles ─────────────────────────────────
    progress(3, 'Computing required tiles...', 'Phase 1: Fetching tiles');
    const zoom = zoomForLevel(level);
    const tileSet = new Set();
    const triTiles = []; // per-triangle tile lists

    for (const { sphereTri } of netLayout) {
      const coords = sphereTri.map(v => xyzToLatLng(v));
      const lats = coords.map(c => c.lat);
      const lngs = coords.map(c => c.lng);

      // Handle antimeridian
      let minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
      let minLat = Math.min(...lats), maxLat = Math.max(...lats);
      if (maxLng - minLng > 180) {
        const adjusted = lngs.map(lng => lng < 0 ? lng + 360 : lng);
        minLng = Math.min(...adjusted);
        maxLng = Math.max(...adjusted);
      }

      const tiles = tilesForBBox(minLat, maxLat, minLng, maxLng, zoom);
      triTiles.push(tiles);
      tiles.forEach(t => tileSet.add(`${t.z}/${t.tx}/${t.ty}`));
    }

    const totalTiles = tileSet.size;
    send({ type: 'info', totalTiles });
    progress(5, `Found ${totalTiles} unique tiles to fetch`, 'Phase 1: Fetching tiles');

    // ── Phase 3: Fetch tiles ─────────────────────────────────────────────────
    let tilesFetched = 0;
    const tileBuffers = new Map(); // key → Buffer

    const tileKeys = [...tileSet];
    for (let i = 0; i < tileKeys.length; i++) {
      const key = tileKeys[i];
      const [z, tx, ty] = key.split('/').map(Number);

      const buf = await getTile(z, tx, ty, CACHE_DIR, useCache);
      tileBuffers.set(key, buf);
      tilesFetched++;

      if (i % 5 === 0 || i === tileKeys.length - 1) {
        const pct = 5 + (tilesFetched / totalTiles) * 40;
        progress(pct, `Fetching tile ${tilesFetched} of ${totalTiles}...`, 'Phase 1: Fetching tiles', { tilesFetched, totalTiles });
      }
    }

    progress(45, 'All tiles fetched. Starting compositing...', 'Phase 2: Compositing');

    // ── Phase 4: Composite imagery onto triangles ────────────────────────────

    // Create full output canvas
    let outCanvas = null;
    if (canvasAvailable()) {
      outCanvas = createCanvas(SVG_W, SVG_H);
      const ctx = outCanvas.getContext('2d');
      ctx.fillStyle = '#0a0a0f';
      ctx.fillRect(0, 0, SVG_W, SVG_H);
    }

    const triangleData = []; // { netVerts, imageData, faceIndex, subIndex }

    for (let i = 0; i < netLayout.length; i++) {
      const { sphereTri, netVerts, faceIndex, subIndex } = netLayout[i];

      const tiles = triTiles[i];
      if (tiles.length === 0) {
        triangleData.push({ netVerts, imageData: null, faceIndex, subIndex });
        continue;
      }

      // Get tile buffers for this triangle
      const patchTiles = tiles.filter(t => tileBuffers.has(`${t.z}/${t.tx}/${t.ty}`));

      if (canvasAvailable() && outCanvas) {
        // Build patch canvas and warp onto output
        try {
          const patch = await buildPatchFromBuffers(patchTiles, tileBuffers, zoom);
          if (patch) {
            const ctx = outCanvas.getContext('2d');
            const triLatLng = sphereTri.map(v => {
              const ll = xyzToLatLng(v);
              return [ll.lat, ll.lng];
            });
            warpTriangle(ctx, patch.canvas, triLatLng, netVerts, zoom, patch.originTx, patch.originTy);
          }
        } catch (e) {
          console.error(`[compositing] Error on tri ${i}:`, e.message);
        }
      }

      if (i % 10 === 0 || i === netLayout.length - 1) {
        const pct = 45 + (i / netLayout.length) * 35;
        progress(pct, `Compositing triangle ${i+1} of ${netLayout.length}...`, 'Phase 2: Compositing', {
          trisDone: i+1, totalTris
        });
      }
    }

    progress(80, 'Extracting triangle images...', 'Phase 2: Compositing');

    // Extract per-triangle PNG crops from the composited canvas
    for (let i = 0; i < netLayout.length; i++) {
      const { netVerts, faceIndex, subIndex } = netLayout[i];
      let imageData = null;

      if (outCanvas) {
        imageData = renderTrianglePNG(outCanvas, netVerts);
      }
      triangleData.push({ netVerts, imageData, faceIndex, subIndex });
    }

    progress(85, 'Generating SVG...', 'Phase 3: Generating SVG');

    // ── Phase 5: Build SVG ───────────────────────────────────────────────────
    const elapsed = Date.now() - startTime;
    const svgStr = buildSVG(triangleData, {
      showMesh,
      level,
      stats: { tilesTotal: tilesFetched, timeMs: elapsed },
    });

    // Save files
    const timestamp = Date.now();
    const svgPath = path.join(OUTPUT_DIR, `dymaxion-${level}-${timestamp}.svg`);
    fs.writeFileSync(svgPath, svgStr, 'utf8');

    let pngPath = null;
    let pngSize = 0;
    if (outCanvas) {
      pngPath = path.join(OUTPUT_DIR, `dymaxion-${level}-${timestamp}.png`);
      const pngBuf = outCanvas.toBuffer('image/png');
      fs.writeFileSync(pngPath, pngBuf);
      pngSize = pngBuf.length;
    }

    const svgSize = Buffer.byteLength(svgStr, 'utf8');
    const svgFilename = path.basename(svgPath);
    const pngFilename = pngPath ? path.basename(pngPath) : null;

    progress(100, 'Done!', 'Complete');

    send({
      type: 'done',
      svgFile: svgFilename,
      pngFile: pngFilename,
      svgSize,
      pngSize,
      totalTris,
      tilesFetched,
      elapsedMs: Date.now() - startTime,
    });

  } catch (err) {
    console.error('[generate] Fatal error:', err);
    send({ type: 'error', message: err.message });
  }

  res.end();
});

// ─── Build patch canvas from pre-fetched buffers ─────────────────────────────

async function buildPatchFromBuffers(tiles, tileBuffers, zoom) {
  if (!createCanvas || tiles.length === 0) return null;

  const { loadImage } = require('canvas');
  const txMin = Math.min(...tiles.map(t => t.tx));
  const txMax = Math.max(...tiles.map(t => t.tx));
  const tyMin = Math.min(...tiles.map(t => t.ty));
  const tyMax = Math.max(...tiles.map(t => t.ty));

  const cols = txMax - txMin + 1;
  const rows = tyMax - tyMin + 1;

  const canvas = createCanvas(cols * TILE_SIZE, rows * TILE_SIZE);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#555';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (const { z, tx, ty } of tiles) {
    const key = `${z}/${tx}/${ty}`;
    const buf = tileBuffers.get(key);
    if (!buf) continue;
    try {
      const img = await loadImage(buf);
      ctx.drawImage(img, (tx - txMin) * TILE_SIZE, (ty - tyMin) * TILE_SIZE);
    } catch (e) {}
  }

  return { canvas, originTx: txMin, originTy: tyMin, zoom };
}

// ─── Start server ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n✓ Dymaxion Earth ready!`);
  console.log(`  Open: http://localhost:${PORT}\n`);
});
