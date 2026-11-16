import { buildAccessIndex, destinationFromCandidate, destinationFromStore } from './model.js';

/**
 * Access index cache. Travel times depend on the road network, demand points
 * and every destination coordinate, so the key includes all three versions and
 * a coordinate fingerprint of edited placements.
 */
const cache = new Map();
const MAX_ENTRIES = 24;

export function fingerprintDestinations(stores, candidates, placement = {}) {
  const parts = [];
  for (const s of stores) parts.push(`${s.id}@${s.x},${s.y}`);
  for (const c of candidates) {
    const p = placement[c.id] ?? {};
    parts.push(`${c.id}@${p.x ?? c.x},${p.y ?? c.y}`);
  }
  return parts.join('|');
}

export function getAccess({ network, demand, stores, candidates, versions, placement = {} }) {
  const networkVersion = versions.network;
  const demandVersion = versions.demand;
  const fp = fingerprintDestinations(stores, candidates, placement);
  const key = `${networkVersion}|${demandVersion}|${fp}`;
  if (cache.has(key)) {
    const hit = cache.get(key);
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const destinations = [
    ...stores.map(destinationFromStore),
    ...candidates.map((c) => destinationFromCandidate(c, placement[c.id] ?? {})),
  ];
  const index = buildAccessIndex({ network, demand, destinations });
  const entry = { ...index, destinations, key };
  cache.set(key, entry);
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
  return entry;
}

/** Split the shared index into existing-store and candidate destination views. */
export function splitAccess(access, storeCount) {
  return {
    all: access,
    stores: access.destinations.slice(0, storeCount),
    candidates: access.destinations.slice(storeCount),
  };
}

export function clearAccessCache() {
  cache.clear();
}
