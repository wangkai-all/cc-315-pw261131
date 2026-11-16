/** Planar helpers. The synthetic city lies well inside one UTM-like zone, so
 * local equirectangular projection is accurate enough for internal analysis;
 * it is NOT a substitute for a commercial routing service. */

export const EARTH_RADIUS_M = 6371000;

export function toMeters(lon, lat, originLat) {
  const x = (lon * Math.PI / 180) * EARTH_RADIUS_M * Math.cos((originLat * Math.PI) / 180);
  const y = (lat * Math.PI / 180) * EARTH_RADIUS_M;
  return { x, y };
}

export function fromMeters(x, y, originLat) {
  const lon = (x / (EARTH_RADIUS_M * Math.cos((originLat * Math.PI) / 180))) * 180 / Math.PI;
  const lat = (y / EARTH_RADIUS_M) * 180 / Math.PI;
  return { lon, lat };
}

export function haversine(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function segmentPointDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Quantize a coordinate to a stable grid key for candidate de-duplication. */
export function gridKey(x, y, cell = 25) {
  return `${Math.round(x / cell)}:${Math.round(y / cell)}`;
}
