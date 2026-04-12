'use strict';
/**
 * server.js
 * Express server for Dymaxion Earth.
 * Serves the frontend, streams generation progress via SSE, serves outputs.
 */

const express = require('express');
const path    = require('path');
const fs      = require('fs');

const { buildNetLayout } = require('./geodesic');
const { ensureWorldMap, loadWorldMap, rasterizeTriangle, worldMapFile, canvasAvailable } = require('./renderer');
const { buildSVG, renderTrianglePNG, SVG_W, SVG_H } = require('./svgBuilder');

const app  = express();
const PORT = 3000;
const OUTPUT_DIR = path.join(__dirname, 'output');
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

let createCanvas;
try { ({ createCanvas } = require('canvas')); } catch (e) {}

app.use(express.static(path.join(__dirname, 'public')));
app.use('/output', express.static(OUTPUT_DIR));

// ─── Estimates ────────────────────────────────────────────────────────────────

const TRI_COUNTS = { 1: 20, 2: 80, 3: 320, 4: 1280, 5: 5120 };

// Rasterization timing (seconds). World-map download adds ~30s the first time.
const RENDER_EST_S = { 1: 3, 2: 6, 3: 14, 4: 35, 5: 90 };

function worldMapReady() {
  try { return fs.statSync(worldMapFile).size >= 2_000_000; } catch { return false; }
}

app.get('/estimate', (req, res) => {
  const level = Math.max(1, Math.min(5, parseInt(req.query.level) || 1));
  res.json({
    level,
    tris:             TRI_COUNTS[level],
    estimatedSeconds: RENDER_EST_S[level],
    worldMapReady:    worldMapReady(),
  });
});

// ─── SSE Generation endpoint ──────────────────────────────────────────────────

app.get('/generate', async (req, res) => {
  const level    = Math.max(1, Math.min(5, parseInt(req.query.level) || 1));
  const showMesh = req.query.mesh !== 'false';

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const send = data => { try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch (_) {} };

  const progress = (pct, status, phase, extra = {}) =>
    send({ type: 'progress', pct: Math.round(pct), status, phase, ...extra });

  const t0 = Date.now();
  send({ type: 'start', level });

  try {
    // ── Phase 1: Ensure world map ────────────────────────────────────────────
    progress(1, 'Checking world map...', 'Phase 1: World map');

    if (!worldMapReady()) {
      progress(2, 'Downloading NASA Blue Marble (~20 MB, once only)…', 'Phase 1: World map');
    }

    await ensureWorldMap((received, total) => {
      const pct = total > 0 ? (received / total) : 0;
      const mb  = (received / 1e6).toFixed(1);
      const of  = total  > 0 ? ` / ${(total / 1e6).toFixed(1)} MB` : '';
      progress(2 + Math.round(pct * 18), `Downloading world map: ${mb}${of} MB`,
               'Phase 1: World map');
    });

    progress(21, 'Loading world map into memory…', 'Phase 1: World map');
    const worldMap = await loadWorldMap();
    send({ type: 'info', worldMapSize: `${worldMap.width}×${worldMap.height}` });
    progress(25, `World map ready (${worldMap.width}×${worldMap.height} px)`, 'Phase 1: World map');

    // ── Phase 2: Build geodesic net ──────────────────────────────────────────
    progress(26, 'Building geodesic net…', 'Phase 2: Rasterizing');
    const netLayout = buildNetLayout(level);
    const totalTris = netLayout.length;
    send({ type: 'info', totalTris });

    // ── Phase 3: Rasterize every face ────────────────────────────────────────
    const outCanvas = createCanvas(SVG_W, SVG_H);
    const outCtx    = outCanvas.getContext('2d');
    outCtx.fillStyle = '#0a0a0f';
    outCtx.fillRect(0, 0, SVG_W, SVG_H);

    for (let i = 0; i < netLayout.length; i++) {
      const { sphereTri, netVerts } = netLayout[i];
      rasterizeTriangle(outCtx, sphereTri, netVerts, worldMap);

      if (i % 4 === 0 || i === netLayout.length - 1) {
        const pct = 27 + ((i + 1) / totalTris) * 55;
        progress(pct, `Rasterizing face ${i + 1} of ${totalTris}`,
                 'Phase 2: Rasterizing', { trisDone: i + 1, totalTris });
      }
    }

    // ── Phase 4: Extract per-triangle PNGs + SVG ─────────────────────────────
    progress(83, 'Extracting triangle images…', 'Phase 3: Generating SVG');

    const triangleData = netLayout.map(({ netVerts, faceIndex, subIndex }) => ({
      netVerts,
      faceIndex,
      subIndex,
      imageData: renderTrianglePNG(outCanvas, netVerts),
    }));

    progress(93, 'Building SVG…', 'Phase 3: Generating SVG');

    const elapsed = Date.now() - t0;
    const svgStr  = buildSVG(triangleData, {
      showMesh, level,
      stats: { elapsedMs: elapsed },
    });

    const ts      = Date.now();
    const svgFile = `dymaxion-${level}-${ts}.svg`;
    const pngFile = `dymaxion-${level}-${ts}.png`;
    fs.writeFileSync(path.join(OUTPUT_DIR, svgFile), svgStr, 'utf8');
    const pngBuf = outCanvas.toBuffer('image/png');
    fs.writeFileSync(path.join(OUTPUT_DIR, pngFile), pngBuf);

    progress(100, 'Done!', 'Complete');
    send({
      type: 'done',
      svgFile,
      pngFile,
      svgSize:    Buffer.byteLength(svgStr, 'utf8'),
      pngSize:    pngBuf.length,
      totalTris,
      elapsedMs:  Date.now() - t0,
    });

  } catch (err) {
    console.error('[generate] Fatal error:', err);
    send({ type: 'error', message: err.message });
  }

  res.end();
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log('\n✓ Dymaxion Earth ready!');
  console.log(`  Open: http://localhost:${PORT}\n`);
});
