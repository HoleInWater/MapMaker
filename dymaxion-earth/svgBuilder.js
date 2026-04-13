'use strict';
/**
 * svgBuilder.js
 * Builds the final Dymaxion Earth SVG using hardcoded Fuller canonical face positions.
 * Canvas: 5400×2700. Circumradius: 310px per face.
 */

const SVG_W = 5400;
const SVG_H = 2700;

// Fuller/Dymaxion canonical face positions on a 5400×2700 canvas.
// cx, cy: centroid in pixels; rot: additional rotation (degrees);
// up: true = △ (vertex up), false = ▽ (vertex down).
const FULLER_FACES = [
  { id:  0, cx: 1215, cy:  562, rot: 240, up: false },
  { id:  1, cx: 1485, cy:  562, rot:   0, up: true  },
  { id:  2, cx: 1755, cy:  562, rot: 240, up: false },
  { id:  3, cx: 2025, cy:  562, rot:   0, up: true  },
  { id:  4, cx: 2295, cy:  562, rot: 240, up: false },
  { id:  5, cx:  810, cy:  900, rot:  60, up: true  },
  { id:  6, cx: 1080, cy:  900, rot: 300, up: false },
  { id:  7, cx: 1350, cy:  900, rot:  60, up: true  },
  { id:  8, cx: 1620, cy:  900, rot: 300, up: false },
  { id:  9, cx: 1890, cy:  900, rot:  60, up: true  },
  { id: 10, cx: 2160, cy:  900, rot: 300, up: false },
  { id: 11, cx: 2430, cy:  900, rot:  60, up: true  },
  { id: 12, cx:  945, cy: 1350, rot: 120, up: false },
  { id: 13, cx: 1215, cy: 1350, rot:   0, up: true  },
  { id: 14, cx: 1485, cy: 1350, rot: 120, up: false },
  { id: 15, cx: 1755, cy: 1350, rot:   0, up: true  },
  { id: 16, cx: 2025, cy: 1350, rot: 120, up: false },
  { id: 17, cx: 2295, cy: 1350, rot:   0, up: true  },
  { id: 18, cx: 2565, cy: 1350, rot: 120, up: false },
  { id: 19, cx: 2835, cy: 1350, rot:   0, up: true  },
];

const CIRCUMRADIUS = 310;
const DEG = Math.PI / 180;

/**
 * Compute the 3 screen vertices for a face.
 * up=true  base angles: [270°, 30°, 150°]  (point up)
 * up=false base angles: [90°, 210°, 330°]  (point down)
 * rot shifts all angles.
 */
function faceScreenVerts(face) {
  const base = face.up ? [270, 30, 150] : [90, 210, 330];
  return base.map(a => {
    const rad = (a + face.rot) * DEG;
    return [
      face.cx + CIRCUMRADIUS * Math.cos(rad),
      face.cy + CIRCUMRADIUS * Math.sin(rad),
    ];
  });
}

// Pre-compute screen vertices for all 20 base faces once
const BASE_SCREEN_VERTS = FULLER_FACES.map(faceScreenVerts);

/**
 * Build the complete SVG string.
 *
 * @param {Array} triangles  array of { netVerts, faceIndex, subIndex, imageData }
 * @param {object} opts      { showMesh, level, stats }
 */
function buildSVG(triangles, opts = {}) {
  const { showMesh = true, level = 1, stats = {} } = opts;

  console.log(`[svgBuilder] Building SVG: ${triangles.length} triangles at level ${level}`);

  const parts = [];

  parts.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"`);
  parts.push(`     viewBox="0 0 ${SVG_W} ${SVG_H}" width="${SVG_W}" height="${SVG_H}">`);
  parts.push(`  <title>Dymaxion Earth — Subdivision Level ${level}</title>`);
  parts.push(`  <rect width="${SVG_W}" height="${SVG_H}" fill="#0a0a0f"/>`);

  // Clip paths — one per triangle, using netVerts (already in 5400×2700 pixel space)
  parts.push(`  <defs>`);
  for (let i = 0; i < triangles.length; i++) {
    const { netVerts } = triangles[i];
    const pts = netVerts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
    parts.push(`    <clipPath id="c${i}"><polygon points="${pts}"/></clipPath>`);
  }
  parts.push(`  </defs>`);

  // Imagery group
  let rendered = 0;
  parts.push(`  <g id="imagery">`);
  for (let i = 0; i < triangles.length; i++) {
    const { netVerts, imageData } = triangles[i];
    const xs = netVerts.map(p => p[0]);
    const ys = netVerts.map(p => p[1]);
    const bx = Math.floor(Math.min(...xs));
    const by = Math.floor(Math.min(...ys));
    const bw = Math.ceil(Math.max(...xs)) - bx;
    const bh = Math.ceil(Math.max(...ys)) - by;

    if (imageData && imageData.length > 0) {
      const b64 = imageData.toString('base64');
      parts.push(`    <image clip-path="url(#c${i})" x="${bx}" y="${by}" width="${bw}" height="${bh}" preserveAspectRatio="none" href="data:image/png;base64,${b64}"/>`);
      rendered++;
    } else {
      const pts = netVerts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
      parts.push(`    <polygon points="${pts}" fill="#334455"/>`);
    }
  }
  parts.push(`  </g>`);

  console.log(`[svgBuilder] ${rendered}/${triangles.length} faces rendered with imagery`);

  // Mesh overlay
  if (showMesh) {
    parts.push(`  <g id="mesh" stroke="rgba(255,255,255,0.25)" stroke-width="1" fill="none">`);
    // Draw only the 20 base-face outlines for a clean mesh
    for (const verts of BASE_SCREEN_VERTS) {
      const pts = verts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
      parts.push(`    <polygon points="${pts}"/>`);
    }
    parts.push(`  </g>`);
  }

  // Attribution
  const elapsed = stats.elapsedMs ? ` • ${(stats.elapsedMs / 1000).toFixed(1)}s` : '';
  parts.push(`  <text x="20" y="${SVG_H - 15}" font-family="sans-serif" font-size="22" fill="rgba(255,255,255,0.5)">`);
  parts.push(`    Dymaxion Earth • NASA Blue Marble • Level ${level} • ${triangles.length} triangles${elapsed}`);
  parts.push(`  </text>`);
  parts.push(`</svg>`);

  return parts.join('\n');
}

/**
 * Crop a triangle's bounding box from the composited canvas.
 * @param {Canvas}  outCanvas  the fully composited canvas
 * @param {Array}   triDst     [[x,y],[x,y],[x,y]] destination vertices
 * @returns {Buffer|null}  PNG buffer
 */
function renderTrianglePNG(outCanvas, triDst) {
  try {
    const xs = triDst.map(p => p[0]);
    const ys = triDst.map(p => p[1]);
    const x = Math.floor(Math.min(...xs));
    const y = Math.floor(Math.min(...ys));
    const w = Math.ceil(Math.max(...xs)) - x;
    const h = Math.ceil(Math.max(...ys)) - y;
    if (w <= 0 || h <= 0) return null;

    const { createCanvas } = require('canvas');
    const cropped = createCanvas(w, h);
    const ctx = cropped.getContext('2d');
    ctx.drawImage(outCanvas, x, y, w, h, 0, 0, w, h);
    return cropped.toBuffer('image/png');
  } catch (e) {
    console.error('[renderTrianglePNG] error:', e.message);
    return null;
  }
}

module.exports = { buildSVG, renderTrianglePNG, SVG_W, SVG_H };
