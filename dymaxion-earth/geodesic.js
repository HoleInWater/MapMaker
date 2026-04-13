'use strict';
/**
 * geodesic.js
 * Icosahedron construction, geodesic subdivision, and lat/lng conversion.
 *
 * Coordinate system: unit sphere, right-handed.
 * Vertices stored as [x, y, z] normalized to radius 1.
 */

const PHI = (1 + Math.sqrt(5)) / 2; // Golden ratio ≈ 1.618

// Fuller-Sadao canonical orientation: rotate all vertices so the icosahedron
// aligns with Earth's land masses as in the published Dymaxion map.
const FULLER_LNG_DEG = -168.0; // 168° west (Fuller-Sadao canonical)
const FULLER_LAT_DEG =   0.0;  // no latitude offset

/**
 * Shift a unit-sphere vertex by the Fuller-Sadao orientation offsets.
 * The longitude shift is a true z-axis rotation; the latitude shift is a
 * small spherical offset (rigid-rotation equivalent for |Δlat| ≤ 2°).
 */
function applyFullerRotation(v) {
  const [x, y, z] = v;
  const lat = Math.asin(Math.max(-1, Math.min(1, z)));
  const lng = Math.atan2(y, x);
  const newLat = lat + FULLER_LAT_DEG * Math.PI / 180;
  const newLng = lng + FULLER_LNG_DEG * Math.PI / 180;
  return [
    Math.cos(newLat) * Math.cos(newLng),
    Math.cos(newLat) * Math.sin(newLng),
    Math.sin(newLat),
  ];
}

// ─── Unit icosahedron ────────────────────────────────────────────────────────

/**
 * The 12 vertices of a regular icosahedron, normalized to the unit sphere,
 * then rotated into the Fuller-Sadao canonical orientation.
 */
function makeIcosahedronVertices() {
  const raw = [
    [0,  1,  PHI], [0, -1,  PHI], [0,  1, -PHI], [0, -1, -PHI],
    [ 1,  PHI, 0], [-1,  PHI, 0], [ 1, -PHI, 0], [-1, -PHI, 0],
    [ PHI, 0,  1], [-PHI, 0,  1], [ PHI, 0, -1], [-PHI, 0, -1],
  ];
  return raw.map(v => applyFullerRotation(normalize(v)));
}

/**
 * The 20 triangular faces of the icosahedron, as index triplets.
 * Winding order is consistent (counter-clockwise when viewed from outside).
 */
const ICOSAHEDRON_FACES = [
  [0, 1, 8],  [0, 8, 4],  [0, 4, 5],  [0, 5, 9],  [0, 9, 1],
  [1, 6, 8],  [8, 6, 10], [8, 10, 4], [4, 10, 2], [4, 2, 5],
  [5, 2, 11], [5, 11, 9], [9, 11, 7], [9, 7, 1],  [1, 7, 6],
  [3, 6, 7],  [3, 7, 11], [3, 11, 2], [3, 2, 10], [3, 10, 6],
];

// ─── Vector math helpers ─────────────────────────────────────────────────────

function normalize(v) {
  const len = Math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]);
  return [v[0]/len, v[1]/len, v[2]/len];
}

function midpoint(a, b) {
  return normalize([(a[0]+b[0])/2, (a[1]+b[1])/2, (a[2]+b[2])/2]);
}

function centroid3(a, b, c) {
  return normalize([(a[0]+b[0]+c[0])/3, (a[1]+b[1]+c[1])/3, (a[2]+b[2]+c[2])/3]);
}

// ─── Geodesic subdivision ────────────────────────────────────────────────────

/**
 * Subdivide a list of triangles (each [v0, v1, v2] as unit-sphere coords)
 * by splitting each edge at its midpoint and projecting back to the sphere.
 * One subdivision step turns N triangles into 4N triangles.
 */
function subdivideOnce(triangles) {
  const result = [];
  for (const [a, b, c] of triangles) {
    const ab = midpoint(a, b);
    const bc = midpoint(b, c);
    const ca = midpoint(c, a);
    result.push([a, ab, ca]);
    result.push([b, bc, ab]);
    result.push([c, ca, bc]);
    result.push([ab, bc, ca]);
  }
  return result;
}

/**
 * Build a geodesic sphere at subdivision level N (1 = plain icosahedron).
 * Returns an array of triangles: each triangle is [[x,y,z],[x,y,z],[x,y,z]].
 */
function buildGeodesicSphere(level) {
  const verts = makeIcosahedronVertices();
  // Initial 20 triangles from vertex indices
  let triangles = ICOSAHEDRON_FACES.map(([i, j, k]) => [verts[i], verts[j], verts[k]]);

  for (let i = 1; i < level; i++) {
    triangles = subdivideOnce(triangles);
  }
  return triangles;
}

// ─── Spherical coordinate conversion ────────────────────────────────────────

/**
 * Convert unit-sphere Cartesian [x, y, z] → {lat, lng} in degrees.
 * lat ∈ [-90, 90], lng ∈ [-180, 180]
 */
function xyzToLatLng(v) {
  const [x, y, z] = v;
  const lat = Math.asin(Math.max(-1, Math.min(1, z))) * 180 / Math.PI;
  const lng = Math.atan2(y, x) * 180 / Math.PI;
  return { lat, lng };
}

/**
 * For a triangle of unit-sphere vertices, return the centroid as {lat, lng}.
 */
function triangleCentroidLatLng(tri) {
  const c = centroid3(...tri);
  return xyzToLatLng(c);
}

/**
 * For a triangle of unit-sphere vertices, compute bounding box in lat/lng.
 * Returns { minLat, maxLat, minLng, maxLng }.
 * Handles antimeridian crossing by extending lng range beyond ±180.
 */
function triangleBBox(tri) {
  const coords = tri.map(xyzToLatLng);
  let lats = coords.map(c => c.lat);
  let lngs = coords.map(c => c.lng);

  // Detect antimeridian crossing: if lng range spans more than 180°, wrap
  const lngRange = Math.max(...lngs) - Math.min(...lngs);
  if (lngRange > 180) {
    // Shift any negative lngs by 360 to unwrap across the antimeridian
    lngs = lngs.map(lng => lng < 0 ? lng + 360 : lng);
  }

  return {
    minLat: Math.min(...lats),
    maxLat: Math.max(...lats),
    minLng: Math.min(...lngs),
    maxLng: Math.max(...lngs),
  };
}

// ─── Fuller net layout ───────────────────────────────────────────────────────

/**
 * Pre-computed 2D vertex positions for each of the 20 icosahedron faces in the
 * canonical Fuller/Dymaxion net, produced by edge-unfolding the icosahedron
 * using a spanning tree that mirrors the d3-geo-polygon airocean layout.
 *
 * FACE_NET_POS[faceIndex][j] = [x, y] in "edge-length" units (1 unit = 1 edge).
 * Vertex ordering matches ICOSAHEDRON_FACES: position j corresponds to sphere
 * vertex ICOSAHEDRON_FACES[faceIndex][j].
 *
 * Spanning tree (child → parent, shared sphere-vertex pair):
 *   F1→F0 {0,8}  F2→F1 {0,4}   F3→F2 {0,5}   F4→F3 {0,9}
 *   F7→F1 {4,8}  F6→F7 {8,10}  F8→F7 {4,10}  F5→F6 {6,8}
 *   F19→F6 {6,10} F9→F8 {2,4}  F10→F9 {2,5}  F11→F10 {5,11}
 *   F12→F11 {9,11} F13→F12 {7,9} F14→F13 {1,7} F15→F14 {6,7}
 *   F16→F12 {7,11} F17→F10 {2,11} F18→F17 {3,2}
 */
const FACE_NET_POS = [
  [[ 0.000000, 0.577350],[-0.500000,-0.288675],[ 0.500000,-0.288675]], // F0
  [[ 0.000000, 0.577350],[ 0.500000,-0.288675],[ 1.000000, 0.577350]], // F1
  [[ 0.000000, 0.577350],[ 1.000000, 0.577350],[ 0.500000, 1.443376]], // F2
  [[ 0.000000, 0.577350],[ 0.500000, 1.443376],[-0.500000, 1.443376]], // F3
  [[ 0.000000, 0.577350],[-0.500000, 1.443376],[-1.000000, 0.577350]], // F4
  [[ 0.000000,-1.154701],[ 1.000000,-1.154701],[ 0.500000,-0.288675]], // F5
  [[ 0.500000,-0.288675],[ 1.000000,-1.154701],[ 1.500000,-0.288675]], // F6
  [[ 0.500000,-0.288675],[ 1.500000,-0.288675],[ 1.000000, 0.577350]], // F7
  [[ 1.000000, 0.577350],[ 1.500000,-0.288675],[ 2.000000, 0.577350]], // F8
  [[ 1.000000, 0.577350],[ 2.000000, 0.577350],[ 1.500000, 1.443376]], // F9
  [[ 1.500000, 1.443376],[ 2.000000, 0.577350],[ 2.500000, 1.443376]], // F10
  [[ 1.500000, 1.443376],[ 2.500000, 1.443376],[ 2.000000, 2.309401]], // F11
  [[ 2.000000, 2.309401],[ 2.500000, 1.443376],[ 3.000000, 2.309401]], // F12
  [[ 2.000000, 2.309401],[ 3.000000, 2.309401],[ 2.500000, 3.175426]], // F13
  [[ 2.500000, 3.175426],[ 3.000000, 2.309401],[ 3.500000, 3.175426]], // F14
  [[ 4.000000, 2.309401],[ 3.500000, 3.175426],[ 3.000000, 2.309401]], // F15
  [[ 3.500000, 1.443376],[ 3.000000, 2.309401],[ 2.500000, 1.443376]], // F16
  [[ 3.000000, 0.577350],[ 2.500000, 1.443376],[ 2.000000, 0.577350]], // F17
  [[ 3.000000, 0.577350],[ 2.000000, 0.577350],[ 2.500000,-0.288675]], // F18
  [[ 2.000000,-1.154701],[ 1.500000,-0.288675],[ 1.000000,-1.154701]], // F19
];

/**
 * Build the complete flat net layout for a given subdivision level.
 * Returns an array of triangle descriptors with their 2D positions.
 *
 * Each descriptor: {
 *   sphereTri: [[x,y,z],[x,y,z],[x,y,z]],  // 3D sphere triangle
 *   netVerts:  [[x,y],[x,y],[x,y]],          // 2D SVG positions
 *   faceIndex: number,                         // parent icosahedron face (0-19)
 *   subIndex:  number,                         // sub-triangle index within face
 * }
 */
function buildNetLayout(level) {
  const verts = makeIcosahedronVertices();
  const baseTriangles = ICOSAHEDRON_FACES.map(([i, j, k]) => [verts[i], verts[j], verts[k]]);

  // Scale FACE_NET_POS to fit the SVG canvas
  const SVG_W = 2000, SVG_H = 1200, MARGIN = 40;
  const allX = FACE_NET_POS.flat().map(p => p[0]);
  const allY = FACE_NET_POS.flat().map(p => p[1]);
  const minX = Math.min(...allX), maxX = Math.max(...allX);
  const minY = Math.min(...allY), maxY = Math.max(...allY);
  const netW = maxX - minX, netH = maxY - minY;
  const scale = Math.min((SVG_W - 2*MARGIN) / netW, (SVG_H - 2*MARGIN) / netH);
  const offsetX = (SVG_W - netW * scale) / 2 - minX * scale;
  const offsetY = (SVG_H - netH * scale) / 2 - minY * scale;

  const result = [];

  for (let fi = 0; fi < 20; fi++) {
    // Subdivide this face
    let faceTris = [baseTriangles[fi]];
    for (let s = 1; s < level; s++) {
      faceTris = subdivideOnce(faceTris);
    }

    // Scale the pre-computed 2D vertices for this face into SVG space
    const parentNetVerts = FACE_NET_POS[fi].map(([x, y]) => [
      x * scale + offsetX,
      y * scale + offsetY,
    ]);

    faceTris.forEach((sphereTri, si) => {
      // Barycentric → 2D: map each sphere sub-vertex into the parent face's 2D triangle
      const netVerts = sphereTri.map(sv => {
        const bary = sphereVertexToBary(sv, baseTriangles[fi]);
        return baryToNet(bary, parentNetVerts);
      });

      result.push({
        sphereTri,
        netVerts,
        faceIndex: fi,
        subIndex: si,
      });
    });
  }

  return result;
}

/**
 * Approximate barycentric coordinates of a sphere point relative to a
 * parent triangle (in 3D). Uses the planar approximation in 3D space.
 */
function sphereVertexToBary(p, tri) {
  const [v0, v1, v2] = tri;
  // Vector from v0
  const d0 = [v1[0]-v0[0], v1[1]-v0[1], v1[2]-v0[2]];
  const d1 = [v2[0]-v0[0], v2[1]-v0[1], v2[2]-v0[2]];
  const dp = [p[0]-v0[0],  p[1]-v0[1],  p[2]-v0[2]];

  // Solve dp = u*d0 + v*d1 via least squares (overdetermined 3x2 system)
  const dot00 = dot(d0, d0);
  const dot01 = dot(d0, d1);
  const dot11 = dot(d1, d1);
  const dot0p = dot(d0, dp);
  const dot1p = dot(d1, dp);

  const inv = 1 / (dot00*dot11 - dot01*dot01);
  const u = (dot11*dot0p - dot01*dot1p) * inv;
  const v = (dot00*dot1p - dot01*dot0p) * inv;
  const w = 1 - u - v;

  return [w, u, v]; // barycentric: [b0, b1, b2] for v0, v1, v2
}

function dot(a, b) { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }

/**
 * Convert barycentric coords [b0,b1,b2] to 2D position given triangle verts.
 */
function baryToNet(bary, netVerts) {
  const [b0, b1, b2] = bary;
  const [n0, n1, n2] = netVerts;
  return [
    b0*n0[0] + b1*n1[0] + b2*n2[0],
    b0*n0[1] + b1*n1[1] + b2*n2[1],
  ];
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  buildGeodesicSphere,
  buildNetLayout,
  xyzToLatLng,
  triangleCentroidLatLng,
  triangleBBox,
  ICOSAHEDRON_FACES,
  subdivideOnce,
  PHI,
};
