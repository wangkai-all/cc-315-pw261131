import { allocate, destinationFromCandidate, destinationFromStore, isOpenAt, normalizeModel, round, ModelTimes } from './model.js';

/**
 * Candidate-set search under three partly conflicting goals:
 *   coverage  — serve as much weekly demand as possible
 *   overlap   — limit expected shared visits between selected new stores and
 *               cannibalisation of existing stores
 *   cost      — limit aggregate rent index
 *
 * Returns the Pareto frontier plus a weighted recommendation. A weighted sum is
 * only a convenience; the frontier shows the actual trade-off so users do not
 * have to trust one arbitrary weight.
 */

export const DEFAULT_GOAL = Object.freeze({
  k: 2,
  weightCoverage: 0.6,
  weightOverlap: 0.4,
  maxRentIndexTotal: null,
  capacityRespected: true,
});

export function normalizeGoal(goal = {}) {
  const k = Math.max(1, Math.min(6, Math.round(Number(goal.k) || DEFAULT_GOAL.k)));
  let wc = Number(goal.weightCoverage);
  let wo = Number(goal.weightOverlap);
  if (!Number.isFinite(wc) || wc < 0) wc = DEFAULT_GOAL.weightCoverage;
  if (!Number.isFinite(wo) || wo < 0) wo = DEFAULT_GOAL.weightOverlap;
  const sum = wc + wo || 1;
  return {
    k,
    weightCoverage: wc / sum,
    weightOverlap: wo / sum,
    maxRentIndexTotal: Number.isFinite(Number(goal.maxRentIndexTotal)) && Number(goal.maxRentIndexTotal) > 0
      ? Number(goal.maxRentIndexTotal) : null,
  };
}

export function combinations(n, k) {
  const out = [];
  const pick = (start, acc) => {
    if (acc.length === k) { out.push([...acc]); return; }
    for (let i = start; i < n; i++) {
      acc.push(i);
      pick(i + 1, acc);
      acc.pop();
    }
  };
  pick(0, []);
  return out;
}

/**
 * Evaluate one candidate set once and derive coverage/overlap/cost metrics.
 * `placement` may override x/y/size/capacity/appeal for "what-if" edits.
 */
export function evaluateCombo({ access, demand, stores, candidates, selectedIds, model, period, seasonality, placement = {}, distanceMode = 'network' }) {
  const selected = candidates.filter((c) => selectedIds.includes(c.id));
  const dests = selected.map((c) => destinationFromCandidate(c, placement[c.id] ?? {}));
  const openExisting = stores.filter((s) => isOpenAt(s, period));
  const m = normalizeModel({ ...model, planningPeriod: period });
  const proposed = allocate({
    access, demandPoints: demand.points, destinations: [...openExisting.map(destinationFromStore), ...dests],
    model: m, seasonality, distanceMode,
  });
  const baseline = allocate({
    access, demandPoints: demand.points, destinations: openExisting.map(destinationFromStore),
    model: m, seasonality, distanceMode,
  });
  const byId = new Map(proposed.perDestination.map((d) => [d.id, d]));
  const baselineById = new Map(baseline.perDestination.map((d) => [d.id, d]));
  const newVisits = selected.reduce((a, c) => a + (byId.get(c.id)?.assignedVisits ?? 0), 0);
  const additive = newVisits; // In a combo, new stores' own visits ≈ standalone only if no overlap; see comboOverlap below.
  const cannibal = openExisting.reduce((a, s) => {
    const before = baselineById.get(s.id)?.assignedVisits ?? 0;
    const after = byId.get(s.id)?.assignedVisits ?? 0;
    return a + Math.max(0, before - after);
  }, 0);
  const incremental = proposed.totals.assignedVisits - baseline.totals.assignedVisits;
  const rentTotal = selected.reduce((a, c) => {
    const p = placement[c.id] ?? {};
    return a + (p.weeklyRentIndex ?? c.weeklyRentIndex ?? 0);
  }, 0);
  // Two coverage notions:
  //  - accessCoverage: share of weekly demand within `accessMinutes` network
  //    time of any open store. Adding a store in an already-served area barely
  //    moves this, which exposes the coverage/overlap trade-off.
  //  - servedCoverage: share actually assigned under capacity, which saturates
  //    when capacity is abundant and is therefore reported but not optimised.
  const accessMinutes = Number(model.accessMinutes) > 0 ? Number(model.accessMinutes) : 8;
  let coveredWeight = 0;
  let totalWeight = 0;
  for (let i = 0; i < demand.points.length; i++) {
    totalWeight += proposed.weights[i];
    let best = Infinity;
    for (let j = 0; j < proposed.destinations.length; j++) {
      const t = ModelTimes.time(proposed, i, j);
      if (t < best) best = t;
    }
    if (best <= accessMinutes) coveredWeight += proposed.weights[i];
  }
  const accessCoverage = totalWeight > 0 ? coveredWeight / totalWeight : 0;
  const servedCoverage = proposed.totals.demandVisits > 0 ? proposed.totals.assignedVisits / proposed.totals.demandVisits : 0;

  // Expected shared visits between selected new stores.
  let shared = 0;
  const n = proposed.destinations.length;
  const idx = new Map(proposed.destinations.map((d, j) => [d.id, j]));
  for (let i = 0; i < demand.points.length; i++) {
    const w = proposed.weights[i];
    if (!w) continue;
    for (let a = 0; a < selected.length; a++) {
      const ja = idx.get(selected[a].id);
      const sa = proposed.shares[i * n + ja];
      if (!sa) continue;
      for (let b = a + 1; b < selected.length; b++) {
        const jb = idx.get(selected[b].id);
        shared += w * sa * proposed.shares[i * n + jb];
      }
    }
  }
  const overlapRatio = newVisits > 0 ? shared / newVisits : 0;
  // Duplicated service has two distinct components. Averaging their shares (not
  // raw visits) keeps a large cannibalisation base from swamping the much
  // smaller new-store overlap, and both must not be added up as if each store
  // were independent.
  const baselineExistingVisits = Math.max(
    1,
    openExisting.reduce((a, s) => a + (baselineById.get(s.id)?.assignedVisits ?? 0), 0),
  );
  const newStoreOverlapShare = newVisits > 0 ? shared / newVisits : 0;
  const cannibalizationShare = cannibal / baselineExistingVisits;
  const duplicatedService = shared + cannibal;
  const overlapShare = 0.5 * newStoreOverlapShare + 0.5 * cannibalizationShare;
  return {
    ids: selectedIds.slice().sort(),
    names: selected.map((c) => c.name),
    selected: selected.map((c) => ({
      id: c.id,
      name: c.name,
      district: c.district,
      x: dests.find((d) => d.id === c.id)?.x ?? c.x,
      y: dests.find((d) => d.id === c.id)?.y ?? c.y,
      sizeSqm: dests.find((d) => d.id === c.id)?.sizeSqm ?? c.sizeSqm,
      capacityVisitsPerWeek: dests.find((d) => d.id === c.id)?.capacityVisitsPerWeek ?? c.capacityVisitsPerWeek,
      assignedVisits: byId.get(c.id)?.assignedVisits ?? 0,
      utilization: byId.get(c.id)?.utilization ?? null,
      capacityBinding: byId.get(c.id)?.capacityBinding ?? false,
      rentIndex: placement[c.id]?.weeklyRentIndex ?? c.weeklyRentIndex ?? 0,
    })),
    coverage: round(accessCoverage, 4),
    accessCoverage: round(accessCoverage, 4),
    servedCoverage: round(servedCoverage, 4),
    accessMinutes,
    newStoreVisits: round(newVisits, 1),
    incrementalVisits: round(incremental, 1),
    sharedVisitsBetweenNewStores: round(shared, 1),
    overlapRatio: round(overlapRatio, 4),
    overlapShare: round(overlapShare, 4),
    newStoreOverlapShare: round(newStoreOverlapShare, 4),
    cannibalizationShare: round(cannibalizationShare, 4),
    duplicatedServiceVisits: round(duplicatedService, 1),
    cannibalizedExistingVisits: round(cannibal, 1),
    additiveNewVisits: round(additive, 1),
    overlapLossVisits: round(additive - incremental, 1),
    rentIndexTotal: round(rentTotal, 1),
    incrementalPerRent: rentTotal > 0 ? round(incremental / rentTotal, 2) : null,
    unmetVisits: proposed.totals.unmetVisits,
    capacityBindingIds: proposed.capacity.bindingStoreIds.filter((id) => selectedIds.includes(id)),
    warnings: [],
  };
}

/**
 * Enumerate combos of size k (with a shortlist guard), compute the Pareto
 * frontier over (coverage ↑, overlap ↓, rent ↓) and rank by the user weights.
 */
export function optimizeCombos({
  access, demand, stores, candidates, model, period, seasonality,
  goal, placement = {}, distanceMode = 'network', maxCombos = 6000,
}) {
  const g = normalizeGoal(goal);
  const pool = candidates;
  const total = countCombinations(pool.length, g.k);
  let poolUsed = pool;
  let truncated = false;
  if (total > maxCombos) {
    // Shortlist by standalone incremental visits, but keep district diversity.
    const ranked = pool.map((c) => {
      const solo = evaluateCombo({
        access, demand, stores, candidates: pool, selectedIds: [c.id], model, period, seasonality, placement, distanceMode,
      });
      return { c, score: solo.incrementalVisits };
    }).sort((a, b) => b.score - a.score);
    poolUsed = ranked.slice(0, Math.max(g.k + 2, Math.min(14, Math.ceil(Math.sqrt(maxCombos)) + 2))).map((r) => r.c);
    truncated = true;
  }
  const combos = combinations(poolUsed.length, Math.min(g.k, poolUsed.length));
  const results = [];
  for (const combo of combos) {
    const ids = combo.map((i) => poolUsed[i].id);
    const res = evaluateCombo({
      access, demand, stores, candidates: pool, selectedIds: ids, model, period, seasonality, placement, distanceMode,
    });
    if (g.maxRentIndexTotal != null && res.rentIndexTotal > g.maxRentIndexTotal) continue;
    results.push(res);
  }

  // Ideal-point scoring inside the min–max range of the feasible set:
  // 0 = worst observed value, 1 = best observed value. This keeps the score
  // interpretable when the ranges are narrow (a saturated coverage metric
  // still differentiates combinations) instead of amplifying noise.
  const covMax = Math.max(...results.map((r) => r.coverage), 1e-9);
  const covMin = Math.min(...results.map((r) => r.coverage));
  const ovMax = Math.max(...results.map((r) => r.overlapShare), 1e-9);
  const ovMin = Math.min(...results.map((r) => r.overlapShare));
  for (const r of results) {
    const covScore = covMax - covMin > 1e-9 ? (r.coverage - covMin) / (covMax - covMin) : 1;
    const ovScore = ovMax - ovMin > 1e-9 ? (ovMax - r.overlapShare) / (ovMax - ovMin) : 1;
    r.goalScore = round(covScore * g.weightCoverage + ovScore * g.weightOverlap, 4);
    r.coverageGoalComponent = round(covScore, 4);
    r.overlapGoalComponent = round(ovScore, 4);
  }
  // Flag whether the two goals actually conflict in this feasible set: if the
  // highest-coverage combo is also the lowest-overlap one, weights are moot.
  // Use a meaningful threshold (0.25% of the coverage span) so tiny numeric
  // differences do not masquerade as a real trade-off.
  const bestCoverage = [...results].sort((a, b) => b.coverage - a.coverage)[0];
  const leastOverlap = [...results].sort((a, b) => a.overlapShare - b.overlapShare)[0];
  const tension = bestCoverage && leastOverlap
    ? leastOverlap.coverage < bestCoverage.coverage - 0.01
    : false;
  results.sort((a, b) => b.goalScore - a.goalScore || b.incrementalVisits - a.incrementalVisits);
  const recommended = results[0] ?? null;
  const frontier = paretoFrontier(results).slice(0, 40);

  // Candidate inclusion frequency among top 20 combos to show robustness.
  const top = results.slice(0, 20);
  const freq = new Map();
  for (const r of top) for (const s of r.selected) freq.set(s.id, (freq.get(s.id) ?? 0) + 1);

  return {
    goal: g,
    poolSize: poolUsed.length,
    poolTruncated: truncated,
    searchNote: truncated
      ? `组合数 ${total} 超过上限 ${maxCombos}，先按单店增量筛出 ${poolUsed.length} 个候选再枚举；结果不再是全局最优。`
      : `已枚举全部 ${results.length} 个可行组合（上限 ${maxCombos}）。`,
    combosEvaluated: results.length,
    feasible: results.length,
    goalConflict: tension === true,
    goalConflictNote: tension === true
      ? '覆盖最高与重叠最低不是同一组合：提高覆盖需要接受更多重复服务，权重会改变推荐。'
      : '本可行集中覆盖最高与重叠最低几乎同向，权重对推荐影响有限；请扩大候选池或改变开店数。',
    recommended,
    frontier,
    top: results.slice(0, 20).map((r) => ({
      ids: r.ids, names: r.names, coverage: r.coverage, overlapShare: r.overlapShare,
      newStoreOverlapShare: r.newStoreOverlapShare, cannibalizationShare: r.cannibalizationShare,
      incrementalVisits: r.incrementalVisits, rentIndexTotal: r.rentIndexTotal, goalScore: r.goalScore,
      capacityBindingIds: r.capacityBindingIds,
    })),
    inclusionFrequency: [...freq.entries()].map(([id, count]) => ({
      id, name: candidates.find((c) => c.id === id)?.name ?? id, count, shareOfTop20: round(count / Math.max(1, top.length), 2),
    })).sort((a, b) => b.count - a.count),
    warnings: buildOptimizerWarnings(results, candidates, g),
    disclaimer: '组合排名基于合成需求与静态路网近似，仅用于演示覆盖—重叠权衡，不构成收入或成功率预测。',
  };
}

function countCombinations(n, k) {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return Math.round(r);
}

function dominates(a, b) {
  const noWorse = a.coverage >= b.coverage - 1e-12
    && a.overlapShare <= b.overlapShare + 1e-12
    && a.rentIndexTotal <= b.rentIndexTotal + 1e-12;
  const better = a.coverage > b.coverage + 1e-12
    || a.overlapShare < b.overlapShare - 1e-12
    || a.rentIndexTotal < b.rentIndexTotal - 1e-12;
  return noWorse && better;
}

function paretoFrontier(results) {
  const sorted = [...results].sort((a, b) => b.coverage - a.coverage || a.overlapShare - b.overlapShare);
  const front = [];
  for (const r of sorted) {
    if (!front.some((f) => dominates(f, r))) front.push(r);
  }
  return front;
}

function buildOptimizerWarnings(results, candidates, g) {
  const out = [];
  const withBinding = results.filter((r) => r.capacityBindingIds.length).length;
  if (withBinding > 0) out.push(`${withBinding} 个组合至少有 1 个点位达容量上限；容量假设会直接限制可覆盖需求。`);
  const maxOverlap = results.reduce((m, r) => Math.max(m, r.overlapShare), 0);
  if (maxOverlap > 0.5) out.push(`部分组合的新店之间期望共享到访超过新店到访的 50%，不宜把各自独立预测相加。`);
  if (g.maxRentIndexTotal != null) out.push(`已施加租金上限 ${g.maxRentIndexTotal}；无可行组合时请放宽上限或减少开店数。`);
  if (!results.length) out.push('当前约束下没有可行组合。');
  return out;
}
