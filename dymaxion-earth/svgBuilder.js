'use strict';
/**
 * svgBuilder.js
 * Assembles the final SVG string from composited triangle images.
 *
 * Each triangle is rendered as:
 *   <clipPath id="c{i}"><polygon points="..."/></clipPath>
 *   <image clip-path="url(#c{i})" href="data:image/png;base64,..." .../>
 * with optional stroke outlines.
 */

const SVG_W = 2000;
const SVG_H = 1200;

/**
 * Build the complete SVG string.
 *
 * @param {Array} triangles - array of {
 *   netVerts: [[x,y],[x,y],[x,y]],
 *   imageData: Buffer|null,   // PNG for this triangle (base64 embedded)
 *   faceIndex: number,
 *   subIndex: number,
 * }
 * @param {object} opts
 *   showMesh: boolean - draw face boundary lines
 *   level: number
 *   stats: { tilesTotal, timeMs }
 */
function buildSVG(triangles, opts = {}) {
  const { showMesh = true, level = 1, stats = {} } = opts;

  const parts = [];

  parts.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"`);
  parts.push(`     viewBox="0 0 ${SVG_W} ${SVG_H}" width="${SVG_W}" height="${SVG_H}">`);

  // Metadata
  parts.push(`  <title>Dymaxion Earth — Subdivision Level ${level}</title>`);
  parts.push(`  <desc>Fuller Dymaxion projection with ESRI World Imagery satellite data.</desc>`);
  parts.push(`  <metadata>`);
  parts.push(`    <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">`);
  parts.push(`      <rdf:Description>`);
  parts.push(`        <dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">Dymaxion Earth</dc:title>`);
  parts.push(`        <dc:description xmlns:dc="http://purl.org/dc/elements/1.1/">Level ${level} geodesic subdivision, ${triangles.length} triangles, ${stats.tilesTotal||0} tiles fetched</dc:description>`);
  parts.push(`        <dc:date xmlns:dc="http://purl.org/dc/elements/1.1/">${new Date().toISOString()}</dc:date>`);
  parts.push(`      </rdf:Description>`);
  parts.push(`    </rdf:RDF>`);
  parts.push(`  </metadata>`);

  // Black background
  parts.push(`  <rect width="${SVG_W}" height="${SVG_H}" fill="#0a0a0f"/>`);

  // Defs: clip paths
  parts.push(`  <defs>`);
  for (let i = 0; i < triangles.length; i++) {
    const { netVerts } = triangles[i];
    const pts = netVerts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
    parts.push(`    <clipPath id="c${i}"><polygon points="${pts}"/></clipPath>`);
  }
  parts.push(`  </defs>`);

  // Group for triangle images
  parts.push(`  <g id="imagery">`);
  for (let i = 0; i < triangles.length; i++) {
    const { netVerts, imageData } = triangles[i];

    // Bounding box for the image element
    const xs = netVerts.map(p => p[0]);
    const ys = netVerts.map(p => p[1]);
    const x = Math.floor(Math.min(...xs));
    const y = Math.floor(Math.min(...ys));
    const w = Math.ceil(Math.max(...xs)) - x;
    const h = Math.ceil(Math.max(...ys)) - y;

    if (imageData && imageData.length > 0) {
      const b64 = imageData.toString('base64');
      parts.push(`    <image clip-path="url(#c${i})" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="none" href="data:image/png;base64,${b64}"/>`);
    } else {
      // Gray fallback
      const pts = netVerts.map(([px, py]) => `${px.toFixed(2)},${py.toFixed(2)}`).join(' ');
      parts.push(`    <polygon points="${pts}" fill="#444"/>`);
    }
  }
  parts.push(`  </g>`);

  // Mesh overlay (triangle outlines)
  if (showMesh) {
    parts.push(`  <g id="mesh" stroke="rgba(255,255,255,0.3)" stroke-width="0.5" fill="none">`);
    for (const { netVerts } of triangles) {
      const pts = netVerts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
      parts.push(`    <polygon points="${pts}"/>`);
    }
    parts.push(`  </g>`);
  }

  // Attribution text
  parts.push(`  <text x="10" y="${SVG_H - 10}" font-family="sans-serif" font-size="10" fill="rgba(255,255,255,0.5)">`);
  parts.push(`    Dymaxion Earth • ESRI World Imagery • Level ${level} • ${triangles.length} triangles`);
  parts.push(`  </text>`);

  parts.push(`</svg>`);

  return parts.join('\n');
}

/**
 * Render a single triangle to a PNG Buffer using node-canvas.
 * The result is a tight bounding-box crop of the warped imagery.
 *
 * @param {Canvas} patchCanvas - the source tile patch
 * @param {Array}  triSrc      - [[srcX,srcY],[srcX,srcY],[srcX,srcY]] in patch coords
 * @param {Array}  triDst      - [[dstX,dstY],...] in SVG output coords
 * @returns {Buffer} PNG buffer of the bounding box, or null
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

    // Crop from the full composited canvas
    const ctx = outCanvas.getContext('2d');
    const cropped = require('canvas').createCanvas(w, h);
    const croppedCtx = cropped.getContext('2d');
    croppedCtx.drawImage(outCanvas, x, y, w, h, 0, 0, w, h);
    return cropped.toBuffer('image/png');
  } catch (e) {
    return null;
  }
}

module.exports = { buildSVG, renderTrianglePNG, SVG_W, SVG_H };
