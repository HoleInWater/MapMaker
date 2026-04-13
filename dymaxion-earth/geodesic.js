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
 * canonical Fuller/Dymaxion net layout on a 5400×2700 canvas.
 *
 * Derived from FULLER_FACES: circumradius=310, base angles [270,30,150] (up)
 * or [90,210,330] (down), plus per-face rotation. Vertex j corresponds to
 * sphere vertex ICOSAHEDRON_FACES[faceIndex][j].
 */
const FACE_NET_POS = [
  [[1483.468,407],[1215,872],[946.532,407]],          // F0
  [[1485,252],[1753.468,717],[1216.532,717]],          // F1
  [[2023.468,407],[1755,872],[1486.532,407]],          // F2
  [[2025,252],[2293.468,717],[1756.532,717]],          // F3
  [[2563.468,407],[2295,872],[2026.532,407]],          // F4
  [[1078.468,745],[810,1210],[541.532,745]],           // F5
  [[1348.468,1055],[811.532,1055],[1080,590]],         // F6
  [[1618.468,745],[1350,1210],[1081.532,745]],         // F7
  [[1888.468,1055],[1351.532,1055],[1620,590]],        // F8
  [[2158.468,745],[1890,1210],[1621.532,745]],         // F9
  [[2428.468,1055],[1891.532,1055],[2160,590]],        // F10
  [[2698.468,745],[2430,1210],[2161.532,745]],         // F11
  [[676.532,1195],[1213.468,1195],[945,1660]],         // F12
  [[1215,1040],[1483.468,1505],[946.532,1505]],        // F13
  [[1216.532,1195],[1753.468,1195],[1485,1660]],       // F14
  [[1755,1040],[2023.468,1505],[1486.532,1505]],       // F15
  [[1756.532,1195],[2293.468,1195],[2025,1660]],       // F16
  [[2295,1040],[2563.468,1505],[2026.532,1505]],       // F17
  [[2296.532,1195],[2833.468,1195],[2565,1660]],       // F18
  [[2835,1040],[3103.468,1505],[2566.532,1505]],       // F19
];

/**
 * Build the complete flat net layout for a given subdivision level.
 * Returns an array of triangle descriptors with their 2D positions.
 *
 * Each descriptor: {
 *   sphereTri: [[x,y,z],[x,y,z],[x,y,z]],  // 3D sphere triangle
 *   netVerts:  [[x,y],[x,y],[x,y]],          // 2D positions (pixels, 5400×2700)
 *   faceIndex: number,                         // parent icosahedron face (0-19)
 *   subIndex:  number,                         // sub-triangle index within face
 * }
 */
function buildNetLayout(level) {
  const verts = makeIcosahedronVertices();
  const baseTriangles = ICOSAHEDRON_FACES.map(([i, j, k]) => [verts[i], verts[j], verts[k]]);

  const result = [];

  for (let fi = 0; fi < 20; fi++) {
    // Subdivide this face
    let faceTris = [baseTriangles[fi]];
    for (let s = 1; s < level; s++) {
      faceTris = subdivideOnce(faceTris);
    }

    // FACE_NET_POS[fi] are already absolute pixel coordinates on the 5400×2700 canvas
    const parentNetVerts = FACE_NET_POS[fi];

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
