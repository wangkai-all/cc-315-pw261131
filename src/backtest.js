import { allocate, buildAccessIndex, destinationFromStore, isOpenAt, normalizeModel, round } from './model.js';
import { haversine } from './geometry.js';
import { versionOf, versionKey } from './versioning.js';
import { seasonalityFor } from './history.js';

/**
 * Backtesting protocol.
 *
 * Validation cells are isolated from training cells in BOTH space and time:
 *  - temporal: fit on periods [1, trainEnd], score on [trainEnd+1, last]
 *  - spatial: leave-one-spatial-block-out; each fold holds out all cells whose
 *    demand point falls in that block
 *  - purge: the last `purgePeriods` training periods are dropped from fitting
 *  - embargo: training points within `bufferM` of a held-out point are dropped
 *
 * The naive random-cell protocol is also computed as a leakage diagnostic so
 * users can see how much a random split flatters the model.
 */

export const DEFAULT_PROTOCOL = Object.freeze({
  trainEnd: 12,
  testStart: 13,
  testEnd: 24,
  folds: 5,
  purgePeriods: 1,
  bufferM: 900,
  betaGrid: [0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.09, 0.10, 0.12, 0.14, 0.16, 0.18, 0.20],
  alphaGrid: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1],
  naiveSplitSeed: 424242,
  naiveTrainShare: 0.8,
});

const MIN_POINTS_PER_FOLD = 6;

export function spatialBlocks(points, k = 5) {
  const kk = Math.max(2, Math.min(k, Math.floor(points.length / MIN_POINTS_PER_FOLD)));
  // Deterministic farthest-point initialisation, then Lloyd iterations.
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const centers = [sorted[0]];
  while (centers.length < kk) {
    let best = null;
    let bestD = -1;
    for (const p of points) {
      const d = Math.min(...centers.map((c) => (c.x - p.x) ** 2 + (c.y - p.y) ** 2));
      if (d > bestD) { bestD = d; best = p; }
    }
    centers.push(best);
  }
  let assign = new Map();
  for (let iter = 0; iter < 25; iter++) {
    const next = new Map();
    for (const p of points) {
      let bi = 0;
      let bd = Infinity;
      centers.forEach((c, i) => {
        const d = (c.x - p.x) ** 2 + (c.y - p.y) ** 2;
        if (d < bd) { bd = d; bi = i; }
      });
      next.set(p.id, bi);
    }
    for (let i = 0; i < centers.length; i++) {
      const members = points.filter((p) => next.get(p.id) === i);
      if (members.length) {
        centers[i] = {
          x: members.reduce((a, p) => a + p.x, 0) / members.length,
          y: members.reduce((a, p) => a + p.y, 0) / members.length,
        };
      }
    }
    const stable = [...next.entries()].every(([id, b]) => assign.get(id) === b);
    assign = next;
    if (stable) break;
  }
  return { k: kk, assign, centers };
}

function storeOpenIds(stores, period) {
  return stores.filter((s) => isOpenAt(s, period)).map((s) => s.id);
}

/**
 * Fit beta/alpha, store appeal and month factors on training cells only.
 * Cells are {d,s,p,v}. `pointsById` and `storesById` are lookup maps.
 */
function fitOnCells({ access, pointsById, stores, cells, protocol, fixedBeta = null }) {
  const periods = [...new Set(cells.map((c) => c.p))].filter((p) => p <= protocol.trainEnd - protocol.purgePeriods);
  const trainCells = cells.filter((c) => periods.includes(c.p));
  const pointIds = new Set(trainCells.map((c) => c.d));
  const trainPoints = [...pointIds].map((id) => pointsById.get(id)).filter(Boolean);
  const monthFactors = estimateMonthFactors(trainCells, periods);

  let best = null;
  for (const beta of protocol.betaGrid) {
    if (fixedBeta !== null && beta !== fixedBeta) continue;
    for (const alpha of protocol.alphaGrid) {
      const model = normalizeModel({ beta, alpha });
      const evalRes = evaluateParams({ access, trainPoints, stores, trainCells, periods, model, monthFactors });
      if (!best || evalRes.wape < best.wape) best = { beta, alpha, wape: evalRes.wape, appeal: evalRes.appeal };
    }
  }
  return {
    beta: best.beta,
    alpha: best.alpha,
    trainWape: round(best.wape, 4),
    storeAppeal: Object.fromEntries([...best.appeal.entries()].map(([k, v]) => [k, round(v, 3)])),
    monthFactors: Object.fromEntries([...monthFactors.entries()].map(([k, v]) => [k, round(v, 4)])),
    trainPeriods: periods,
    trainCells: trainCells.length,
    trainPoints: trainPoints.length,
  };
}

function estimateMonthFactors(cells, periods) {
  const periodMonth = new Map(periods.map((p) => [p, seasonalityFor(p)]));
  // Start from the known 12-month shape of synthetic demand? No: fit from
  // residual ratio of observed to a flat-allocation expectation is complex.
  // Instead use observed totals by calendar month relative to overall mean.
  const byMonth = new Map();
  for (const c of cells) {
    if (!periods.includes(c.p)) continue;
    const m = monthOf(c.p);
    byMonth.set(m, (byMonth.get(m) ?? 0) + c.v);
  }
  const mean = [...byMonth.values()].reduce((a, b) => a + b, 0) / Math.max(1, byMonth.size);
  const out = new Map();
  for (const [m, total] of byMonth) out.set(m, clamp(total / Math.max(1, mean), 0.8, 1.25));
  void periodMonth;
  return out;
}

function monthOf(period) {
  const zero = 11 + (period - 1); // period 1 = December
  return (zero % 12) + 1;
}

function monthFactor(monthFactors, period) {
  return monthFactors.get(monthOf(period)) ?? 1;
}

function predictFromParams({ access, points, stores, periods, model, monthFactors, appeal }) {
  const rows = [];
  for (const period of periods) {
    const open = stores.filter((s) => isOpenAt(s, period));
    if (!open.length) continue;
    const dest = open.map(destinationFromStore);
    const destIndex = new Map(dest.map((d, j) => [d.id, j]));
    const appealFactors = open.map((s) => appeal.get(s.id) ?? 1);
    const m = normalizeModel({ ...model, capacityRespected: true });
    const alloc = allocateRaw({ access, points, dest, model: m, monthFactors, period, appealFactors });
    const rowIndex = new Map(points.map((point, i) => [point.id, i]));
    for (const point of points) {
      const i = rowIndex.get(point.id);
      for (const store of open) {
        const j = destIndex.get(store.id);
        rows.push({
          d: point.id,
          s: store.id,
          p: period,
          v: (alloc.weights[i] ?? 0) * (alloc.shares[i * dest.length + j] ?? 0),
        });
      }
    }
  }
  return rows;
}

function allocateRaw({ access, points, dest, model, monthFactors, period, appealFactors }) {
  return allocate({
    access,
    demandPoints: points,
    destinations: dest,
    model,
    seasonality: monthFactor(monthFactors, period),
    appealFactors,
  });
}

function evaluateParams({ access, trainPoints, stores, trainCells, periods, model, monthFactors }) {
  const baseAppeal = new Map(stores.map((s) => [s.id, 1]));
  // One refinement round for store-level appeal based on training residuals.
  const first = predictFromParams({ access, points: trainPoints, stores, periods, model, monthFactors, appeal: baseAppeal });
  const obsBy = new Map();
  for (const c of trainCells) {
    const key = `${c.s}|${c.p}`;
    if (!obsBy.has(key)) obsBy.set(key, new Map());
    obsBy.get(key).set(c.d, c.v);
  }
  const sums = new Map();
  for (const row of first) {
    const key = `${row.s}|${row.p}`;
    const observed = obsBy.get(key)?.get(row.d) ?? 0;
    if (!sums.has(row.s)) sums.set(row.s, { pred: 0, obs: 0 });
    const s = sums.get(row.s);
    s.pred += row.v;
    s.obs += observed;
  }
  const appeal = new Map();
  for (const store of stores) {
    const s = sums.get(store.id);
    appeal.set(store.id, s && s.pred > 0 ? clamp(s.obs / s.pred, 0.7, 1.3) : 1);
  }
  const rows = predictFromParams({ access, points: trainPoints, stores, periods, model, monthFactors, appeal });
  const predBy = new Map(rows.map((r) => [`${r.d}|${r.s}|${r.p}`, r.v]));
  let abs = 0;
  let obsSum = 0;
  for (const c of trainCells) {
    if (!periods.includes(c.p)) continue;
    const pred = predBy.get(`${c.d}|${c.s}|${c.p}`) ?? 0;
    abs += Math.abs(pred - c.v);
    obsSum += c.v;
  }
  return { wape: obsSum > 0 ? abs / obsSum : 1, appeal };
}

export function runBacktest({ network, demand, storesDoc, history, model, protocol: overrides = {}, versions }) {
  const protocol = { ...DEFAULT_PROTOCOL, ...overrides };
  protocol.testStart = Math.max(protocol.trainEnd + 1, protocol.testStart);
  protocol.testEnd = Math.min(protocol.testEnd, history.meta.periods.count);
  const points = demand.points;
  const pointsById = new Map(points.map((p) => [p.id, p]));
  const stores = storesDoc.stores;
  const access = buildAccessIndex({ network, demand, destinations: stores.map(destinationFromStore) });
  const cells = history.cells;
  const blocks = spatialBlocks(points, protocol.folds);

  // Which store-periods are near capacity in the full observation panel? This
  // is a property of the inputs, not of a fold's subset of points.
  const observedByStorePeriod = new Map();
  for (const o of history.observations) {
    observedByStorePeriod.set(`${o.storeId}|${o.period}`, o.observedVisits);
  }
  const bindingStoreIds = new Set(stores.filter((st) => {
    const total = historyObservationsTotal(observedByStorePeriod, st.id);
    return Number.isFinite(st.capacityVisitsPerWeek) && total >= st.capacityVisitsPerWeek * 0.92;
  }).map((st) => st.id));

  const foldReports = [];
  for (let fold = 0; fold < blocks.k; fold++) {
    const foldPoints = points.filter((p) => blocks.assign.get(p.id) === fold);
    if (foldPoints.length < MIN_POINTS_PER_FOLD) continue;
    const holdIds = new Set(foldPoints.map((p) => p.id));
    // Embargo: any training point within bufferM of a held-out point is removed.
    const embargoed = points.filter(
      (p) => !holdIds.has(p.id) && foldPoints.some((hp) => haversine(p, hp) <= protocol.bufferM),
    );
    const trainPointIds = new Set(points.filter((p) => !holdIds.has(p.id) && !embargoed.some((e) => e.id === p.id)).map((p) => p.id));
    const foldTrainCells = cells.filter(
      (c) => trainPointIds.has(c.d) && c.p <= protocol.trainEnd,
    );
    const foldTestCells = cells.filter(
      (c) => holdIds.has(c.d) && c.p >= protocol.testStart && c.p <= protocol.testEnd,
    );
    const fit = fitOnCells({ access, pointsById, stores, cells: foldTrainCells, protocol });
    const predicted = predictFromParams({
      access, points: foldPoints, stores,
      periods: [...new Set(foldTestCells.map((c) => c.p))].sort((a, b) => a - b),
      model: { ...normalizeModel(model), beta: fit.beta, alpha: fit.alpha },
      monthFactors: new Map(Object.entries(fit.monthFactors).map(([k, v]) => [Number(k), v])),
      appeal: new Map(Object.entries(fit.storeAppeal)),
    });
    const predBy = new Map(predicted.map((r) => [`${r.d}|${r.s}|${r.p}`, r.v]));
    const pairs = foldTestCells.map((c) => ({
      d: c.d, s: c.s, p: c.p,
      obs: c.v,
      pred: predBy.get(`${c.d}|${c.s}|${c.p}`) ?? 0,
      storeOpen: isOpenAt(stores.find((s) => s.id === c.s), c.p),
    }));
    // Cells that exist in observations for a store but were predicted as zero,
    // and combinations absent from the panel are both covered via full join.
    const observedKeys = new Set(foldTestCells.map((c) => `${c.d}|${c.s}|${c.p}`));
    for (const row of predicted) {
      if (row.v < 0.5) continue;
      const key = `${row.d}|${row.s}|${row.p}`;
      if (!observedKeys.has(key)) pairs.push({ d: row.d, s: row.s, p: row.p, obs: 0, pred: row.v, storeOpen: true });
    }
    foldReports.push({
      fold,
      heldPointIds: [...holdIds].sort(),
      heldPointCount: foldPoints.length,
      trainPointCount: trainPointIds.size,
      embargoedPoints: embargoed.map((p) => p.id).sort(),
      trainCells: fit.trainCells,
      testCells: pairs.length,
      periodRange: { train: [1, protocol.trainEnd - protocol.purgePeriods], test: [protocol.testStart, protocol.testEnd] },
      fit,
      metrics: metricsOf(pairs),
      capacitySubset: capacitySubsetMetrics(pairs, stores, bindingStoreIds),
    });
  }

  const pooled = poolPairs(foldReports);
  const naive = runNaiveRandomSplit({ access, pointsById, stores, cells, protocol, model });
  const closureCheck = closureEventCheck({ access, pointsById, stores, cells, protocol, model });
  const aggregate = pooled.metrics;
  const report = {
    id: versionOf({ protocol, versions }, 'bt', 12),
    createdAt: new Date().toISOString(),
    versions,
    inputVersionKey: versionKey(versions),
    protocol: {
      ...protocol,
      description: '空间分块 5 折 + 时间外推（拟合 1–11 期，评分 13–24 期），训练点剔除验证点 900 米内邻居，并丢弃边界期以隔离序列相关。',
      foldsDetail: foldReports.map((f) => ({
        fold: f.fold,
        heldPointCount: f.heldPointCount,
        trainPointCount: f.trainPointCount,
        embargoedPoints: f.embargoedPoints.length,
        trainCells: f.trainCells,
        testCells: f.testCells,
        beta: f.fit.beta,
        alpha: f.fit.alpha,
        wape: f.metrics.wape,
      })),
    },
    metrics: aggregate,
    folds: foldReports.map((f) => ({
      fold: f.fold,
      heldPointIds: f.heldPointIds,
      heldPointCount: f.heldPointCount,
      trainPointCount: f.trainPointCount,
      embargoedPoints: f.embargoedPoints,
      trainCells: f.trainCells,
      testCells: f.testCells,
      periodRange: f.periodRange,
      fit: f.fit,
      metrics: f.metrics,
      capacitySubset: f.capacitySubset,
    })),
    leakageDiagnostic: naive,
    closureCheck,
    interpretation: interpretationOf(aggregate, naive, closureCheck),
    disclaimer: '回测在合成需求与虚构营业历史上进行；WAPE 说明模型在已知生成过程上的内部一致性，不能外推为真实收入或真实门店精度。',
  };
  return report;
}

function metricsOf(pairs) {
  if (!pairs.length) return { n: 0, wape: null, mae: null, rmse: null, bias: null, observedVisits: 0, predictedVisits: 0 };
  let abs = 0;
  let sq = 0;
  let obs = 0;
  let pred = 0;
  for (const p of pairs) {
    abs += Math.abs(p.pred - p.obs);
    sq += (p.pred - p.obs) ** 2;
    obs += p.obs;
    pred += p.pred;
  }
  return {
    n: pairs.length,
    wape: round(abs / Math.max(1, obs), 4),
    mae: round(abs / pairs.length, 2),
    rmse: round(Math.sqrt(sq / pairs.length), 2),
    bias: round((pred - obs) / Math.max(1, obs), 4),
    observedVisits: round(obs, 0),
    predictedVisits: round(pred, 0),
  };
}

function historyObservationsTotal(map, storeId, periods = null) {
  let total = 0;
  for (const [key, value] of map) {
    const [s, p] = key.split('|');
    if (s !== storeId) continue;
    if (periods && !periods.has(Number(p))) continue;
    total = Math.max(total, value);
  }
  return total;
}

function capacitySubsetMetrics(pairs, stores, bindingStoreIds = new Set()) {
  const bindingIds = bindingStoreIds;
  const cap = pairs.filter((p) => bindingIds.has(p.s));
  const other = pairs.filter((p) => !bindingIds.has(p.s));
  return {
    bindingStoreIds: [...bindingIds],
    capacityCells: cap.length,
    capacityMetrics: metricsOf(cap),
    nonCapacityMetrics: metricsOf(other),
    note: '按观测到访是否逼近容量上限划分，用于说明容量约束对误差的影响。',
  };
}

function poolPairs(folds) {
  // Store-level aggregate metrics across folds (mean of fold metrics is noisy
  // because folds differ in size; weight by observed visits).
  let obs = 0;
  let abs = 0;
  let sq = 0;
  let pred = 0;
  let n = 0;
  for (const f of folds) {
    obs += f.metrics.observedVisits;
    pred += f.metrics.predictedVisits;
    abs += f.metrics.mae * f.metrics.n;
    sq += f.metrics.rmse ** 2 * f.metrics.n;
    n += f.metrics.n;
  }
  return {
    metrics: {
      n,
      wape: round(abs / Math.max(1, obs), 4),
      mae: round(abs / Math.max(1, n), 2),
      rmse: round(Math.sqrt(sq / Math.max(1, n)), 2),
      bias: round((pred - obs) / Math.max(1, obs), 4),
      observedVisits: round(obs, 0),
      predictedVisits: round(pred, 0),
    },
  };
}

function runNaiveRandomSplit({ access, pointsById, stores, cells, protocol, model }) {
  // Deliberately leaky: random cell split, no spatial or temporal isolation.
  // This is a diagnostic ONLY and is never used to select the model.
  let seed = protocol.naiveSplitSeed >>> 0;
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const train = [];
  const test = [];
  for (const c of cells) (rand() < protocol.naiveTrainShare ? train : test).push(c);
  const fit = fitOnCells({
    access, pointsById, stores,
    cells: train.filter((c) => c.p <= protocol.testEnd),
    protocol: { ...protocol, purgePeriods: 0 },
  });
  const testPoints = [...new Set(test.map((c) => c.d))].map((id) => pointsById.get(id)).filter(Boolean);
  const predicted = predictFromParams({
    access, points: testPoints, stores,
    periods: [...new Set(test.map((c) => c.p))].sort((a, b) => a - b),
    model: { ...normalizeModel(model), beta: fit.beta, alpha: fit.alpha },
    monthFactors: new Map(Object.entries(fit.monthFactors).map(([k, v]) => [Number(k), v])),
    appeal: new Map(Object.entries(fit.storeAppeal)),
  });
  const predBy = new Map(predicted.map((r) => [`${r.d}|${r.s}|${r.p}`, r.v]));
  const pairs = test.map((c) => ({
    d: c.d, s: c.s, p: c.p, obs: c.v, pred: predBy.get(`${c.d}|${c.s}|${c.p}`) ?? 0,
  }));
  return {
    protocol: 'random-cell-split (leaky diagnostic, not for selection)',
    trainShare: protocol.naiveTrainShare,
    fit: {
      beta: fit.beta, alpha: fit.alpha, trainWape: fit.trainWape,
      trainCells: fit.trainCells, testCells: pairs.length,
    },
    metrics: metricsOf(pairs),
    note: '同一需求点与相邻期的单元格同时出现在训练与测试中，因此误差通常偏乐观；不得用于选参或对外报告。',
  };
}

function closureEventCheck({ access, pointsById, stores, cells, protocol, model }) {
  const closed = stores.filter((s) => s.closedPeriod != null);
  if (!closed.length) return null;
  const store = closed[0];
  const lastOpen = store.closedPeriod - 1;
  const targetPoints = cells
    .filter((c) => c.s === store.id && c.p === lastOpen)
    .sort((a, b) => b.v - a.v)
    .slice(0, 20)
    .map((c) => c.d);
  const before = cells.filter((c) => targetPoints.includes(c.d) && c.p === lastOpen && c.s !== store.id);
  const afterPeriods = [store.closedPeriod, Math.min(protocol.testEnd, store.closedPeriod + 5)];
  const after = cells.filter((c) => targetPoints.includes(c.d) && c.p >= afterPeriods[0] && c.p <= afterPeriods[1] && c.s !== store.id);
  const nearestOpen = stores
    .filter((s) => s.id !== store.id)
    .map((s) => ({ store: s, distanceM: Math.round(Math.min(...targetPoints.map((id) => {
      const p = pointsById.get(id);
      return p ? Math.hypot(p.x - s.x, p.y - s.y) : Infinity;
    }))) }))
    .sort((a, b) => a.distanceM - b.distanceM)[0];
  const periodCount = (rows) => Math.max(1, new Set(rows.map((c) => c.p)).size);
  const beforeOther = before.reduce((a, c) => a + c.v, 0) / periodCount(before);
  const afterOther = after.reduce((a, c) => a + c.v, 0) / periodCount(after);
  const closedOwn = cells.filter((c) => c.s === store.id && c.p === lastOpen).reduce((a, c) => a + c.v, 0);
  const deltaOther = afterOther - beforeOther;
  return {
    storeId: store.id,
    storeName: store.name,
    closedPeriod: store.closedPeriod,
    affectedPointCount: targetPoints.length,
    beforePeriod: lastOpen,
    afterPeriods,
    neighbour: {
      storeId: nearestOpen?.store.id ?? null,
      distanceM: nearestOpen?.distanceM ?? null,
    },
    closedStoreVisitsBeforeClosure: round(closedOwn, 1),
    otherStoresVisitsPerWeekBefore: round(beforeOther, 1),
    otherStoresVisitsPerWeekAfter: round(afterOther, 1),
    transferShareOfClosedStore: closedOwn > 0 ? round(deltaOther / closedOwn, 3) : null,
    note: '关店后邻近需求点在其他门店的增量 / 该店关前到访；因容量与距离限制，转移比例通常小于 100%。',
  };
}

function interpretationOf(metrics, naive, closure) {
  const out = [];
  if (metrics.wape != null) {
    out.push(`空间-时间隔离回测的 WAPE 为 ${(metrics.wape * 100).toFixed(1)}%，偏差 ${(metrics.bias * 100).toFixed(1)}%。`);
  }
  if (naive?.metrics?.wape != null && metrics.wape != null) {
    const delta = (metrics.wape - naive.metrics.wape) * 100;
    out.push(`随机单元格切分的 WAPE 为 ${(naive.metrics.wape * 100).toFixed(1)}%，与隔离协议相差 ${Math.abs(delta).toFixed(1)} 个百分点。`);
    out.push('随机切分允许同一需求点和相邻期同时进入训练与验证。本模型不含点位级参数，因此该泄漏在此合成数据上主要反映为误差估计不稳定，而不一定表现为明显更低的误差；无论数值如何，随机切分都不能作为泛化证据。');
  }
  if (closure) {
    out.push(`营业变更检验：${closure.storeName} 关店后，邻近 ${closure.affectedPointCount} 个需求点在其他门店仅承接了其关前到访的 ${(closure.transferShareOfClosedStore * 100).toFixed(1)}%，并未全部转移。`);
  }
  out.push('回测分数只说明该合成过程下的内部一致性；正式选址必须用真实匿名交易/客流数据和经审计的路网。');
  return out;
}

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

export function isBacktestFresh(report, activeVersions) {
  if (!report?.versions) return false;
  const keys = ['demand', 'network', 'stores', 'history', 'model'];
  if ('code' in report.versions) keys.push('code');
  return keys.every((k) => (report.versions[k] ?? null) === (activeVersions[k] ?? null));
}

export function backtestInputSignature(activeVersions) {
  return versionKey(activeVersions);
}
