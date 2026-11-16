import { mulberry32, lognormal, normal } from './rng.js';
import { sha256, stableStringify } from './versioning.js';

/**
 * Huff-style competing-destinations model with optional capacity balancing.
 *
 *   U_ij = size_j^alpha * appeal_j * exp(-beta * t_ij)
 *   p_ij = U_ij / sum_k U_ik
 *
 * t_ij is network travel time in minutes (snapped walk + road time). When a
 * store's assigned visits exceed its weekly capacity, an iterative penalty
 * lowers its attractiveness until utilization is near 1; residual demand is
 * reported as spill/unmet rather than silently exceeding capacity.
 */

export const DEFAULT_MODEL = Object.freeze({
  beta: 0.06, // distance decay per minute of network travel time
  alpha: 0.55, // size elasticity
  cutoffMinutes: 12,
  accessMinutes: 8,
  capacityRespected: true,
  planningPeriod: 25,
  demandSigma: 0.10,
  appealSigma: 0.12,
  betaSigma: 0.015,
  uncertaintyDraws: 120,
  seed: 20261116,
});

const EPS = 1e-9;
const MAX_ITER = 80;

export function normalizeModel(overrides = {}) {
  const m = { ...DEFAULT_MODEL, ...(overrides ?? {}) };
  m.beta = clampNumber(m.beta, 0.01, 0.5, DEFAULT_MODEL.beta);
  m.alpha = clampNumber(m.alpha, 0.05, 1.2, DEFAULT_MODEL.alpha);
  m.cutoffMinutes = clampNumber(m.cutoffMinutes, 5, 90, DEFAULT_MODEL.cutoffMinutes);
  m.accessMinutes = clampNumber(m.accessMinutes, 3, 60, DEFAULT_MODEL.accessMinutes);
  m.planningPeriod = Math.max(1, Math.round(Number(m.planningPeriod) || DEFAULT_MODEL.planningPeriod));
  m.demandSigma = clampNumber(m.demandSigma, 0, 0.6, DEFAULT_MODEL.demandSigma);
  m.appealSigma = clampNumber(m.appealSigma, 0, 0.6, DEFAULT_MODEL.appealSigma);
  m.betaSigma = clampNumber(m.betaSigma, 0, 0.1, DEFAULT_MODEL.betaSigma);
  m.uncertaintyDraws = Math.max(0, Math.min(600, Math.round(Number(m.uncertaintyDraws) || 0)));
  m.capacityRespected = m.capacityRespected !== false;
  m.seed = Math.round(Number(m.seed) || DEFAULT_MODEL.seed);
  return m;
}

function clampNumber(value, lo, hi, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

export function modelVersion(model) {
  // planningPeriod is a scenario choice, not a model parameter: keep it out of
  // the content hash so changing the forecast horizon does not mark every saved
  // scenario as stale.
  const m = normalizeModel(model);
  delete m.planningPeriod;
  return 'mdl-' + sha256(stableStringify(m)).slice(0, 10);
}

/**
 * Build network travel times from every demand point to every destination.
 * Also computes a crow-flight approximation for comparison. Cached by caller.
 */
export function buildAccessIndex({ network, demand, destinations, straightLineSpeedKmh = 22 }) {
  const destMeta = destinations.map((d) => {
    const { node, snapM } = network.nearestNode(d.x, d.y);
    return {
      id: d.id,
      nodeId: node.id,
      snapM,
      walkMinutes: (snapM / 1000 / 4.8) * 60,
    };
  });
  const straightMinutesPerMetre = 60 / (straightLineSpeedKmh * 1000);
  const rows = [];
  const diagnostics = {
    pairs: 0,
    reachablePairs: 0,
    cutoffPairs: 0,
    networkMinutesSum: 0,
    straightMinutesSum: 0,
    circuitySum: 0,
    circuitySamples: 0,
    snapMetresSum: 0,
    straightOptimisticPairs: 0,
  };
  for (const point of demand.points) {
    const access = network.accessFrom(point.x, point.y);
    const times = new Float64Array(destinations.length);
    const distances = new Float64Array(destinations.length);
    const straight = new Float64Array(destinations.length);
    for (let j = 0; j < destinations.length; j++) {
      const meta = destMeta[j];
      const path = access.paths.get(meta.nodeId);
      const dest = destinations[j];
      // Destinations and demand points share the local metric frame (metres);
      // crow-flight distance is therefore a plain planar distance.
      const straightM = Math.hypot(dest.x - point.x, dest.y - point.y);
      const straightT = straightM * straightMinutesPerMetre + (meta.snapM / 1000 / 4.8) * 60;
      straight[j] = straightT;
      diagnostics.pairs += 1;
      diagnostics.straightMinutesSum += straightT;
      if (!path) {
        times[j] = Infinity;
        distances[j] = Infinity;
        diagnostics.cutoffPairs += 1;
        continue;
      }
      const t = (access.snapM / 1000 / 4.8) * 60 + path.seconds / 60 + meta.walkMinutes;
      times[j] = t;
      distances[j] = access.snapM + path.distanceM + meta.snapM;
      diagnostics.reachablePairs += 1;
      diagnostics.networkMinutesSum += t;
      diagnostics.snapMetresSum += access.snapM + meta.snapM;
      if (Number.isFinite(distances[j]) && straightM > 50) {
        diagnostics.circuitySum += distances[j] / straightM;
        diagnostics.circuitySamples += 1;
      }
      if (straightT < 10 && t > 15) diagnostics.straightOptimisticPairs += 1;
    }
    rows.push({ point, times, straight, distances });
  }
  const byId = new Map(rows.map((row) => [row.point.id, row]));
  const meanNetwork = diagnostics.networkMinutesSum / Math.max(1, diagnostics.reachablePairs);
  const meanStraight = diagnostics.straightMinutesSum / Math.max(1, diagnostics.pairs);
  const summary = {
    pairs: diagnostics.pairs,
    reachablePairs: diagnostics.reachablePairs,
    unreachablePairs: diagnostics.pairs - diagnostics.reachablePairs,
    meanNetworkMinutes: round(meanNetwork, 2),
    meanStraightLineMinutes: round(meanStraight, 2),
    meanCircuityRatio: round(diagnostics.circuitySum / Math.max(1, diagnostics.circuitySamples), 3),
    meanSnapMetres: round(diagnostics.snapMetresSum / Math.max(1, diagnostics.reachablePairs), 1),
    shareWhereStraightLooksCloseButNetworkFar: round(
      diagnostics.straightOptimisticPairs / Math.max(1, diagnostics.reachablePairs),
      3,
    ),
    straightLineSpeedKmh,
    note: `直线近似按 ${straightLineSpeedKmh} km/h 匀速并叠加步行接驳，未考虑公园与河道绕行；仅用于敏感度对照。`,
  };
  return { rows, byId, summary, destMeta, destinations };
}

export function destinationFromStore(store) {
  return {
    id: store.id,
    kind: 'existing',
    name: store.name,
    x: store.x,
    y: store.y,
    sizeSqm: store.sizeSqm,
    appeal: store.appeal ?? 1,
    capacityVisitsPerWeek: store.capacityVisitsPerWeek,
    format: store.format,
    district: store.district,
    weeklyRentIndex: store.weeklyRentIndex ?? null,
    openedPeriod: store.openedPeriod ?? null,
    closedPeriod: store.closedPeriod ?? null,
    status: store.status,
  };
}

export function destinationFromCandidate(candidate, override = {}) {
  return {
    id: candidate.id,
    kind: 'candidate',
    name: candidate.name,
    x: override.x ?? candidate.x,
    y: override.y ?? candidate.y,
    sizeSqm: override.sizeSqm ?? candidate.sizeSqm,
    appeal: override.appeal ?? candidate.appeal ?? 1,
    capacityVisitsPerWeek: override.capacityVisitsPerWeek ?? candidate.capacityVisitsPerWeek,
    format: candidate.format,
    district: candidate.district,
    weeklyRentIndex: override.weeklyRentIndex ?? candidate.weeklyRentIndex ?? null,
    status: 'open',
    tenure: candidate.tenure,
  };
}

export function isOpenAt(store, period) {
  const opened = store.openedPeriod ?? -Infinity;
  const closed = store.closedPeriod ?? Infinity;
  return period >= opened && period < closed;
}

/**
 * Allocate demand to destinations.
 * @param {object} args
 * @param {ReturnType<typeof buildAccessIndex>} args.access
 * @param {Array} args.demandPoints
 * @param {Array} args.destinations all destinations (open/closed decided by caller)
 * @param {object} args.model normalized model
 * @param {number} [args.seasonality] scalar demand factor for the period
 * @param {Float64Array|number[]} [args.demandFactors] per-point multiplicative factors
 * @param {Float64Array|number[]} [args.appealFactors] per-destination multiplicative factors
 * @param {'network'|'straight'} [args.distanceMode]
 */
export function allocate({
  access,
  demandPoints,
  destinations,
  model,
  seasonality = 1,
  demandFactors = null,
  appealFactors = null,
  distanceMode = 'network',
}) {
  const m = normalizeModel(model);
  const nP = demandPoints.length;
  const nD = destinations.length;
  const attractions = new Float64Array(nD);
  for (let j = 0; j < nD; j++) {
    const sizeTerm = Math.max(1, Number(destinations[j].sizeSqm) || 1) ** m.alpha;
    const appeal = Math.max(0.05, Number(destinations[j].appeal) || 1);
    attractions[j] = sizeTerm * appeal * (appealFactors ? appealFactors[j] : 1);
  }
  const capacities = new Float64Array(nD);
  for (let j = 0; j < nD; j++) {
    const cap = Number(destinations[j].capacityVisitsPerWeek);
    capacities[j] = Number.isFinite(cap) ? Math.max(0, cap) : Infinity;
  }
  const weights = new Float64Array(nP);
  for (let i = 0; i < nP; i++) {
    weights[i] = Math.max(0, Number(demandPoints[i].weeklyDemand) || 0) * seasonality * (demandFactors ? demandFactors[i] : 1);
  }

  // Travel-time matrix aligned by destination id, so a caller may pass a
  // subset of the destinations used to build the access index.
  const timeMatrix = new Float64Array(nP * nD);
  const sourceByDest = new Map((access.destinations ?? []).map((d, j) => [d.id, j]));
  for (let i = 0; i < nP; i++) {
    const row = access.byId?.get(demandPoints[i].id) ?? access.rows[i];
    if (!row) throw new Error(`需求点 ${demandPoints[i].id} 没有可达性记录`);
    const times = distanceMode === 'straight' ? row.straight : row.times;
    for (let j = 0; j < nD; j++) {
      const src = sourceByDest.get(destinations[j].id);
      if (src === undefined) throw new Error(`目标 ${destinations[j].id} 不在可达性矩阵中`);
      timeMatrix[i * nD + j] = times[src];
    }
  }

  // Base utility (before capacity).
  const utility = new Float64Array(nP * nD);
  const inCatchment = new Uint8Array(nP);
  for (let i = 0; i < nP; i++) {
    for (let j = 0; j < nD; j++) {
      const t = timeMatrix[i * nD + j];
      if (Number.isFinite(t) && t <= m.cutoffMinutes) {
        utility[i * nD + j] = attractions[j] * Math.exp(-m.beta * t);
        inCatchment[i] = 1;
      }
    }
  }

  const capacityRespected = m.capacityRespected && capacities.some((c) => Number.isFinite(c));
  const allocation = new Float64Array(nP * nD);
  const remaining = Float64Array.from(weights);
  const remainingCap = Float64Array.from(capacities);
  // Active destinations per point; a destination leaves the active set only
  // when it hits its capacity, in which case its would-be demand is
  // redistributed to the rest instead of being scaled out of existence.
  const active = new Uint8Array(nD).fill(1);
  let iterations = 1;
  let maxPreCapUtilization = 0;

  if (!capacityRespected) {
    for (let i = 0; i < nP; i++) {
      let sum = 0;
      for (let j = 0; j < nD; j++) sum += utility[i * nD + j];
      if (sum <= EPS) continue;
      for (let j = 0; j < nD; j++) allocation[i * nD + j] = (remaining[i] * utility[i * nD + j]) / sum;
    }
  } else {
    for (let round = 0; round < MAX_ITER; round++) {
      iterations = round + 1;
      const desired = new Float64Array(nP * nD);
      const columnTotal = new Float64Array(nD);
      for (let i = 0; i < nP; i++) {
        if (remaining[i] <= EPS) continue;
        let sum = 0;
        for (let j = 0; j < nD; j++) if (active[j]) sum += utility[i * nD + j];
        if (sum <= EPS) continue;
        const factor = remaining[i] / sum;
        for (let j = 0; j < nD; j++) {
          if (!active[j]) continue;
          const v = utility[i * nD + j] * factor;
          desired[i * nD + j] = v;
          columnTotal[j] += v;
        }
      }
      const binding = [];
      for (let j = 0; j < nD; j++) {
        if (!active[j]) continue;
        const ratio = columnTotal[j] / Math.max(remainingCap[j], EPS);
        maxPreCapUtilization = Math.max(maxPreCapUtilization, ratio);
        if (columnTotal[j] > remainingCap[j] + 1e-7) binding.push(j);
      }
      if (!binding.length) {
        for (let i = 0; i < nP; i++) {
          for (let j = 0; j < nD; j++) allocation[i * nD + j] += desired[i * nD + j];
        }
        break;
      }
      // Cap each binding destination at its remaining capacity, splitting that
      // capacity across demand points in proportion to their desired share.
      for (const j of binding) {
        const take = Math.min(remainingCap[j], columnTotal[j]);
        const scale = columnTotal[j] > EPS ? take / columnTotal[j] : 0;
        for (let i = 0; i < nP; i++) {
          const v = desired[i * nD + j] * scale;
          allocation[i * nD + j] += v;
          remaining[i] = Math.max(0, remaining[i] - v);
        }
        remainingCap[j] = Math.max(0, remainingCap[j] - take);
        active[j] = 0;
      }
    }
  }

  // Final shares express the capacity-adjusted probability that a point's
  // visits land at a destination; they are used for overlap and per-point
  // reporting, so they must sum to the actually served fraction, not to 1.
  const shares = new Float64Array(nP * nD);
  for (let i = 0; i < nP; i++) {
    if (weights[i] > EPS) {
      for (let j = 0; j < nD; j++) shares[i * nD + j] = allocation[i * nD + j] / weights[i];
    }
  }

  const finalAssigned = new Float64Array(nD);
  let assignedTotal = 0;
  for (let idx = 0; idx < nP * nD; idx++) {
    finalAssigned[idx % nD] += allocation[idx];
    assignedTotal += allocation[idx];
  }
  const unmetByPoint = new Float64Array(nP);
  const beyondCutoffByPoint = new Float64Array(nP);
  const topStore = new Array(nP).fill(null);
  for (let i = 0; i < nP; i++) {
    let served = 0;
    let best = -1;
    let bestValue = 0;
    for (let j = 0; j < nD; j++) {
      const a = allocation[i * nD + j];
      served += a;
      if (a > bestValue) { bestValue = a; best = j; }
    }
    unmetByPoint[i] = Math.max(0, weights[i] - served);
    if (!inCatchment[i]) beyondCutoffByPoint[i] = weights[i];
    topStore[i] = best >= 0 ? destinations[best].id : null;
  }

  return {
    weights: Array.from(weights),
    shares,
    _times: timeMatrix,
    iterations,
    preCapUtilization: maxPreCapUtilization,
    destinations,
    perDestination: destinations.map((d, j) => {
      const cap = capacities[j];
      const visits = finalAssigned[j];
      const overflow = capacityRespected && Number.isFinite(cap) ? Math.max(0, (1 - remainingCap[j] / Math.max(cap, EPS)) * 0 + 0) : 0;
      void overflow;
      return {
        id: d.id,
        name: d.name,
        kind: d.kind,
        district: d.district,
        x: d.x,
        y: d.y,
        sizeSqm: d.sizeSqm,
        appeal: d.appeal,
        capacityVisitsPerWeek: Number.isFinite(cap) ? cap : null,
        assignedVisits: round(visits, 1),
        utilization: Number.isFinite(cap) && cap > 0 ? round(visits / cap, 4) : null,
        capacityBinding: capacityRespected && Number.isFinite(cap) && remainingCap[j] <= EPS && visits > 0,
        overflowVisits: 0,
        attraction: round(attractions[j], 3),
      };
    }),
    perDemand: demandPoints.map((p, i) => ({
      id: p.id,
      district: p.district,
      weight: round(weights[i], 1),
      allocated: round(weights[i] - unmetByPoint[i], 1),
      unmet: round(unmetByPoint[i], 1),
      beyondCutoff: beyondCutoffByPoint[i] > EPS,
      topStoreId: topStore[i],
    })),
    totals: {
      demandVisits: round(Array.from(weights).reduce((a, b) => a + b, 0), 1),
      assignedVisits: round(assignedTotal, 1),
      unmetVisits: round(unmetByPoint.reduce((a, b) => a + b, 0), 1),
      beyondCutoffVisits: round(beyondCutoffByPoint.reduce((a, b) => a + b, 0), 1),
    },
    capacity: {
      respected: capacityRespected,
      iterations,
      maxPreCapUtilization: round(maxPreCapUtilization, 4),
      bindingStoreIds: destinations
        .filter((d, j) => capacityRespected && Number.isFinite(capacities[j]) && remainingCap[j] <= EPS && finalAssigned[j] > 0)
        .map((d) => d.id),
      capacityOverflowVisits: round(unmetByPoint.reduce((a, b) => a + b, 0) - beyondCutoffByPoint.reduce((a, b) => a + b, 0), 1),
    },
  };
}

/** Expected shared visits between every pair of destinations. */
export function pairOverlap(access, demandPoints, allocation, destinationIds, { seasonality = 1, cutoffMinutes = 12 } = {}) {
  const idx = new Map(destinationIds.map((id, k) => [id, k]));
  const destIndex = new Map(allocation.destinations.map((d, j) => [d.id, j]));
  const nD = destinationIds.length;
  const shared = Array.from({ length: nD }, () => new Float64Array(nD));
  for (let i = 0; i < demandPoints.length; i++) {
    const w = allocation.weights[i];
    if (!w) continue;
    for (let a = 0; a < nD; a++) {
      const ja = destIndex.get(destinationIds[a]);
      const sa = allocation.shares[i * allocation.destinations.length + ja];
      if (!sa) continue;
      for (let b = a + 1; b < nD; b++) {
        const jb = destIndex.get(destinationIds[b]);
        const sb = allocation.shares[i * allocation.destinations.length + jb];
        if (!sb) continue;
        shared[a][b] += w * sa * sb;
      }
    }
  }
  const perDest = new Map(allocation.perDestination.map((d) => [d.id, d]));
  const pairs = [];
  for (let a = 0; a < nD; a++) {
    for (let b = a + 1; b < nD; b++) {
      const small = Math.min(perDest.get(destinationIds[a])?.assignedVisits ?? 0, perDest.get(destinationIds[b])?.assignedVisits ?? 0);
      pairs.push({
        a: destinationIds[a],
        b: destinationIds[b],
        sharedVisits: round(shared[a][b], 1),
        ratioOfSmaller: small > 0 ? round(shared[a][b] / small, 3) : 0,
        note: '按概率乘积计算的期望共享到访，不是实际流失。',
      });
    }
  }
  return pairs;
}

/**
 * Evaluate a candidate set against a baseline (existing stores only).
 * @param {object} opts
 * @param {Array} opts.candidates selected candidates (destination-shaped)
 * @param {Array} opts.stores existing stores
 * @param {number} opts.period planning period used for open/closed status
 */
export function evaluateScenario({
  access,
  demand,
  stores,
  candidates,
  model,
  seasonality = 1,
  period,
  demandFactors = null,
  distanceMode = 'network',
}) {
  const m = normalizeModel({ ...model, planningPeriod: period ?? model.planningPeriod });
  const openExisting = stores.filter((s) => isOpenAt(s, period)).map(destinationFromStore);
  const allDestinations = [...openExisting, ...candidates];
  const proposed = allocate({
    access,
    demandPoints: demand.points,
    destinations: allDestinations,
    model: m,
    seasonality,
    demandFactors,
    distanceMode,
  });
  const baseline = allocate({
    access,
    demandPoints: demand.points,
    destinations: openExisting,
    model: m,
    seasonality,
    demandFactors,
    distanceMode,
  });
  const baselineById = new Map(baseline.perDestination.map((d) => [d.id, d]));
  const proposedById = new Map(proposed.perDestination.map((d) => [d.id, d]));

  const candidateIds = candidates.map((c) => c.id);
  const existingIds = openExisting.map((s) => s.id);
  const overlapPairs = pairOverlap(access, demand.points, proposed, candidateIds, { seasonality, cutoffMinutes: m.cutoffMinutes });

  // Standalone (additive) estimate: run each candidate alone with existing stores.
  const standalone = new Map();
  for (const candidate of candidates) {
    const solo = allocate({
      access,
      demandPoints: demand.points,
      destinations: [...openExisting, candidate],
      model: m,
      seasonality,
      demandFactors,
      distanceMode,
    });
    standalone.set(candidate.id, solo.totals.assignedVisits - baseline.totals.assignedVisits);
  }

  const perStore = allDestinations.map((dest) => {
    const before = baselineById.get(dest.id)?.assignedVisits ?? 0;
    const after = proposedById.get(dest.id)?.assignedVisits ?? 0;
    const pd = proposedById.get(dest.id);
    return {
      id: dest.id,
      name: dest.name,
      kind: dest.kind,
      district: dest.district,
      x: dest.x,
      y: dest.y,
      format: dest.format ?? null,
      weeklyRentIndex: dest.weeklyRentIndex ?? null,
      sizeSqm: dest.sizeSqm,
      capacityVisitsPerWeek: pd?.capacityVisitsPerWeek ?? null,
      beforeVisits: round(before, 1),
      afterVisits: round(after, 1),
      deltaVisits: round(after - before, 1),
      cannibalizedVisits: round(Math.max(0, before - after), 1),
      utilization: pd?.utilization ?? null,
      capacityBinding: pd?.capacityBinding ?? false,
      standaloneVisits: dest.kind === 'candidate' ? round(standalone.get(dest.id) ?? 0, 1) : null,
      rentPerThousandVisits: dest.weeklyRentIndex && after > 0 ? round((dest.weeklyRentIndex * 100) / after, 2) : null,
      note: dest.kind === 'candidate'
        ? '新店到访包含从现有店转移的需求；单店独立预测与并入组合的差额即重叠损失。'
        : '现有店到访变化 = 新店分流后的剩余需求。',
    };
  });

  const accessCoverage = coverageWithin(proposed, demand.points, m.accessMinutes);
  const baselineAccessCoverage = coverageWithin(baseline, demand.points, m.accessMinutes);

  const newStores = perStore.filter((s) => s.kind === 'candidate');
  const existingStores = perStore.filter((s) => s.kind === 'existing');
  const additiveNaive = newStores.reduce((a, s) => a + (s.standaloneVisits ?? 0), 0);
  const actualIncremental = proposed.totals.assignedVisits - baseline.totals.assignedVisits;
  const cannibalized = existingStores.reduce((a, s) => a + s.cannibalizedVisits, 0);
  const newStoreVisits = newStores.reduce((a, s) => a + s.afterVisits, 0);
  const additiveNewStoreVisits = newStores.reduce((a, s) => a + (s.standaloneVisits ?? 0) + (s.cannibalizedVisits ?? 0), 0);

  return {
    model: m,
    period: period ?? m.planningPeriod,
    seasonality,
    distanceMode,
    baseline: {
      destinations: existingIds,
      perStore: baseline.perDestination,
      totals: baseline.totals,
      capacity: baseline.capacity,
    },
    proposed: {
      destinations: allDestinations.map((d) => d.id),
      perStore: proposed.perDestination,
      // Kept so the map can shade demand points by unmet volume; rounded and
      // small (one row per demand point), unlike the full allocation matrices.
      perDemand: proposed.perDemand,
      totals: proposed.totals,
      capacity: proposed.capacity,
    },
    impact: {
      newStoreVisits: round(newStoreVisits, 1),
      baselineExistingVisits: round(existingStores.reduce((a, s) => a + s.beforeVisits, 0), 1),
      cannibalizedExistingVisits: round(cannibalized, 1),
      incrementalVisits: round(actualIncremental, 1),
      additiveNaiveIncremental: round(additiveNaive, 1),
      additiveNewStoreVisits: round(additiveNewStoreVisits, 1),
      combinedNewStoreVisits: round(newStoreVisits, 1),
      overlapLossVisits: round(additiveNaive - actualIncremental, 1),
      overlapLossRatio: additiveNaive > 0 ? round((additiveNaive - actualIncremental) / additiveNaive, 3) : 0,
      unmetVisits: proposed.totals.unmetVisits,
      coverageRatio: proposed.totals.demandVisits > 0 ? round(proposed.totals.assignedVisits / proposed.totals.demandVisits, 4) : 0,
      accessMinutes: m.accessMinutes,
      accessCoverage: round(accessCoverage, 4),
      baselineAccessCoverage: round(baselineAccessCoverage, 4),
      accessCoverageGain: round(accessCoverage - baselineAccessCoverage, 4),
      capacityOverflowVisits: proposed.capacity.capacityOverflowVisits,
      rentIndexTotal: newStores.reduce((a, s) => a + (s.weeklyRentIndex ?? 0), 0),
      incrementalVisitsPerRentIndex: newStores.reduce((a, s) => a + (s.weeklyRentIndex ?? 0), 0) > 0
        ? round(actualIncremental / newStores.reduce((a, s) => a + (s.weeklyRentIndex ?? 0), 0), 2)
        : null,
    },
    perStore,
    overlapPairs,
    overlapByDemand: buildOverlapByDemand(proposed, demand.points, candidates),
    capacityPressure: {
      bindingStoreIds: proposed.capacity.bindingStoreIds,
      maxPreCapUtilization: proposed.capacity.maxPreCapUtilization,
      overflowVisits: proposed.capacity.capacityOverflowVisits,
      note: m.capacityRespected
        ? '容量以每周到访上限计入；超限需求按吸引力迭代回溢，最终分配不超过容量。'
        : '本次试算关闭了容量约束，利用率可超过 100%，仅用于观察需求吸引力。',
    },
    warnings: buildScenarioWarnings({
      proposed, candidates, m, overlapPairs,
      incrementalVisits: actualIncremental,
      cannibalizedVisits: cannibalized,
      baselineCoverageRatio: baseline.totals.demandVisits > 0
        ? baseline.totals.assignedVisits / baseline.totals.demandVisits : 0,
    }),
  };
}

function buildOverlapByDemand(allocation, demandPoints, candidates) {
  const nD = allocation.destinations.length;
  const idx = new Map(allocation.destinations.map((d, j) => [d.id, j]));
  const cols = candidates.map((c) => idx.get(c.id));
  const out = [];
  for (let i = 0; i < demandPoints.length; i++) {
    const w = allocation.weights[i];
    if (!w) continue;
    let shared = 0;
    let newVisits = 0;
    for (let a = 0; a < cols.length; a++) {
      const sa = allocation.shares[i * nD + cols[a]];
      newVisits += w * sa;
      for (let b = a + 1; b < cols.length; b++) {
        shared += w * sa * allocation.shares[i * nD + cols[b]];
      }
    }
    out.push({
      id: demandPoints[i].id,
      newStoreVisits: round(newVisits, 1),
      sharedVisits: round(shared, 1),
      sharedShareOfNew: newVisits > 0 ? round(shared / newVisits, 3) : 0,
    });
  }
  return out;
}

function buildScenarioWarnings({
  proposed, candidates, m, overlapPairs, incrementalVisits = null, cannibalizedVisits = 0, baselineCoverageRatio = 0,
}) {
  const out = [];
  if (candidates.length && incrementalVisits != null && incrementalVisits <= 0.5 && cannibalizedVisits > 0.5) {
    out.push(baselineCoverageRatio >= 0.99
      ? '现有门店已基本服务全部圈层内需求：新店主要分流旧店到访，净增量接近 0。此时应优先看可达覆盖增益或容量压力，而不是增量。'
      : '新店的到访几乎全部来自旧店分流，净增量接近 0；请检查容量假设或需求版本。');
  }
  if (!m.capacityRespected) out.push('容量约束已关闭：结果可能高估单店可服务到访。');
  const binding = proposed.capacity.bindingStoreIds;
  if (binding.length) out.push(`${binding.length} 个点位触及容量上限，需求发生回溢；请检查容量假设。`);
  if (proposed.totals.beyondCutoffVisits > 0) {
    out.push(`${Math.round(proposed.totals.beyondCutoffVisits).toLocaleString('zh-CN')} 人次/周位于 ${m.cutoffMinutes} 分钟圈层外，未分配给任何门店。`);
  }
  if (candidates.length > 1) {
    const worst = [...overlapPairs].sort((a, b) => b.ratioOfSmaller - a.ratioOfSmaller)[0];
    if (worst && worst.ratioOfSmaller > 0.35) {
      out.push(`候选 ${worst.a} 与 ${worst.b} 的期望共享到访占较小店 ${Math.round(worst.ratioOfSmaller * 100)}%，组合内重叠偏高。`);
    }
  }
  return out;
}

/** Share of weekly demand within `minutes` network time of any destination. */
export function coverageWithin(allocation, demandPoints, minutes) {
  const nD = allocation.destinations.length;
  let covered = 0;
  let total = 0;
  for (let i = 0; i < demandPoints.length; i++) {
    const w = allocation.weights?.[i] ?? 0;
    total += w;
    let best = Infinity;
    for (let j = 0; j < nD; j++) {
      const t = ModelTimes.time(allocation, i, j);
      if (t < best) best = t;
    }
    if (best <= minutes) covered += w;
  }
  return total > 0 ? covered / total : 0;
}

/** Monte Carlo uncertainty around the incremental impact. */
export function simulateUncertainty({
  access,
  demand,
  stores,
  candidates,
  model,
  seasonality,
  period,
  distanceMode = 'network',
  draws = 120,
}) {
  const m = normalizeModel({ ...model, uncertaintyDraws: draws });
  if (m.uncertaintyDraws <= 0) return null;
  const rand = mulberry32((m.seed ^ 0x9e3779b9) >>> 0);
  const openExisting = stores.filter((s) => isOpenAt(s, period)).map(destinationFromStore);
  const allDestinations = [...openExisting, ...candidates];
  const nP = demand.points.length;
  const nDest = allDestinations.length;

  const perStoreSamples = new Map(allDestinations.map((d) => [d.id, []]));
  const incrementalSamples = [];
  const newVisitsSamples = [];
  const cannibalSamples = [];

  for (let draw = 0; draw < m.uncertaintyDraws; draw++) {
    const demandFactors = new Float64Array(nP);
    for (let i = 0; i < nP; i++) demandFactors[i] = lognormal(rand, m.demandSigma);
    const appealFactors = new Float64Array(nDest);
    for (let j = 0; j < nDest; j++) appealFactors[j] = lognormal(rand, m.appealSigma);
    const drawModel = { ...m, beta: Math.max(0.01, m.beta + normal(rand) * m.betaSigma) };
    const proposed = allocate({
      access, demandPoints: demand.points, destinations: allDestinations, model: drawModel,
      seasonality, demandFactors, appealFactors, distanceMode,
    });
    const baseline = allocate({
      access, demandPoints: demand.points, destinations: openExisting, model: drawModel,
      seasonality, demandFactors,
      appealFactors: appealFactors.slice(0, openExisting.length),
      distanceMode,
    });
    for (let j = 0; j < nDest; j++) {
      perStoreSamples.get(allDestinations[j].id).push(proposed.perDestination[j].assignedVisits);
    }
    const baseById = new Map(baseline.perDestination.map((d) => [d.id, d.assignedVisits]));
    const newVisits = proposed.perDestination
      .filter((d) => d.kind === 'candidate')
      .reduce((a, d) => a + d.assignedVisits, 0);
    const cannibal = openExisting.reduce((a, s) => {
      const after = proposed.perDestination.find((d) => d.id === s.id)?.assignedVisits ?? 0;
      return a + Math.max(0, (baseById.get(s.id) ?? 0) - after);
    }, 0);
    incrementalSamples.push(proposed.totals.assignedVisits - baseline.totals.assignedVisits);
    newVisitsSamples.push(newVisits);
    cannibalSamples.push(cannibal);
  }

  const pct = (arr, q) => percentile(arr, q);
  const perStore = Object.fromEntries([...perStoreSamples.entries()].map(([id, arr]) => [id, {
    p10: round(pct(arr, 0.1), 1),
    p50: round(pct(arr, 0.5), 1),
    p90: round(pct(arr, 0.9), 1),
  }]));
  return {
    draws: m.uncertaintyDraws,
    perStore,
    incremental: {
      p10: round(pct(incrementalSamples, 0.1), 1),
      p50: round(pct(incrementalSamples, 0.5), 1),
      p90: round(pct(incrementalSamples, 0.9), 1),
      probPositive: round(incrementalSamples.filter((v) => v > 0).length / Math.max(1, incrementalSamples.length), 3),
    },
    newStoreVisits: {
      p10: round(pct(newVisitsSamples, 0.1), 1),
      p50: round(pct(newVisitsSamples, 0.5), 1),
      p90: round(pct(newVisitsSamples, 0.9), 1),
    },
    cannibalized: {
      p10: round(pct(cannibalSamples, 0.1), 1),
      p50: round(pct(cannibalSamples, 0.5), 1),
      p90: round(pct(cannibalSamples, 0.9), 1),
    },
    assumptions: {
      demandSigma: m.demandSigma,
      appealSigma: m.appealSigma,
      betaSigma: m.betaSigma,
      note: '区间仅反映输入需求、吸引力与距离衰减假设的传播，不包含选址执行、租约或收入风险；不是收入预测。',
    },
  };
}

function percentile(values, q) {
  if (!values.length) return 0;
  const a = [...values].sort((x, y) => x - y);
  const pos = (a.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return a[lo];
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

export function round(value, digits = 2) {
  if (!Number.isFinite(value)) return value;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export function accessCacheKey(networkVersion, demandVersion, storeVersion, candidateVersion) {
  return `${networkVersion}|${demandVersion}|${storeVersion}|${candidateVersion}`;
}

/**
 * Allocation result retains per-destination data but not the raw time matrix
 * (which can be large). The optimizer uses this accessor; `setTimes` attaches
 * the matrix when a caller needs accessibility coverage.
 */
export const ModelTimes = {
  time(allocation, i, j) {
    if (!allocation._times) throw new Error('allocation._times missing; call attachTimes() first');
    return allocation._times[i * allocation.destinations.length + j];
  },
  attach(allocation, times) {
    allocation._times = times;
    return allocation;
  },
};
