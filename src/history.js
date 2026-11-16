import { mulberry32, lognormal } from './rng.js';
import { buildAccessIndex, destinationFromStore, isOpenAt, allocate, DEFAULT_MODEL, normalizeModel, round } from './model.js';
import { periodLabel } from './synth.js';

/**
 * Synthetic observed panel, generated once at seed time from a known process
 * with hidden store appeal, observation noise and real closure/open dates.
 *
 * The finest stored grain is (demand point, store, period) — a realistic
 * anonymised home-cell aggregate. Backtests may only read observations; the
 * generating parameters are kept for provenance and never used for scoring.
 */

export const SEASONAL_FACTORS = [0.96, 0.91, 0.95, 0.99, 1.02, 1.04, 1.06, 1.03, 0.99, 1.00, 1.03, 1.08];

export function monthOfPeriod(period) {
  const [year, month] = periodLabel(period).split('-').map(Number);
  return { year, month };
}

export function seasonalityFor(period) {
  const { month } = monthOfPeriod(period);
  return SEASONAL_FACTORS[month - 1] ?? 1;
}

export function trendFor(period) {
  return 1 + 0.006 * (period - 1);
}

export function calendarFactor(period) {
  // No long-run trend is added: a strict time holdout cannot learn a trend it
  // has never seen, and pretending otherwise would overstate forecast skill.
  return seasonalityFor(period);
}

export function generateHistory({ network, demand, storesDoc, model = DEFAULT_MODEL }) {
  const rand = mulberry32(9051123);
  const stores = storesDoc.stores;
  const meta = storesDoc.meta;
  const calcModel = normalizeModel({ ...model, capacityRespected: true });
  const destinations = stores.map(destinationFromStore);
  const access = buildAccessIndex({ network, demand, destinations });

  const latentAppeal = new Map(stores.map((s) => [s.id, lognormal(rand, 0.09)]));
  const trueModel = { ...calcModel, beta: 0.085, alpha: 0.55 };
  // Unobserved heterogeneity deliberately absent from the model:
  //  - each demand point has its own latent demand level (local competition,
  //    reporting coverage, unrecorded daytime population),
  //  - each demand point has a format affinity (street vs park vs office store).
  // These make spatial holdout error irreducible rather than merely noisy.
  const pointEta = new Map(demand.points.map((p) => [p.id, lognormal(rand, 0.13)]));
  const formatAffinity = new Map(
    demand.points.map((p) => [p.id, new Map(
      ['街边标准店', '社区店', '公园店', '写字楼店'].map((f) => [f, lognormal(rand, 0.17)]),
    )]),
  );
  const cells = [];

  for (let period = 1; period <= meta.periods.count; period++) {
    const budget = calendarFactor(period);
    const open = stores.filter((s) => isOpenAt(s, period));
    const alloc = allocate({
      access,
      demandPoints: demand.points,
      destinations: open.map(destinationFromStore),
      model: trueModel,
      seasonality: budget,
      appealFactors: open.map((s) => latentAppeal.get(s.id)),
      distanceMode: 'network',
    });
    for (let i = 0; i < demand.points.length; i++) {
      const point = demand.points[i];
      const eta = pointEta.get(point.id);
      const affinities = open.map((store) => {
        const table = formatAffinity.get(point.id);
        return table?.get(store.format) ?? 1;
      });
      // Start from capacity-adjusted shares, re-weight by the hidden format
      // affinity, and keep total served visits close to the allocation. If the
      // store was capacity-bound, re-weighting must not invent extra capacity.
      const rawShares = open.map((_, j) => alloc.shares[i * open.length + j]);
      const totRaw = rawShares.reduce((a, b) => a + b, 0);
      if (totRaw <= 0) continue;
      const weighted = rawShares.map((sv, j) => sv * affinities[j]);
      const sum = weighted.reduce((a, b) => a + b, 0);
      if (sum <= 0) continue;
      const served = alloc.weights[i] * totRaw * eta;
      for (let j = 0; j < open.length; j++) {
        const expected = served * (weighted[j] / sum);
        if (expected < 0.5) continue;
        const noise = lognormal(rand, 0.045);
        const visits = Math.max(0, Math.round(expected * noise));
        if (visits === 0) continue;
        cells.push({ d: point.id, s: open[j].id, p: period, v: visits });
      }
    }
  }

  const observations = [];
  for (let period = 1; period <= meta.periods.count; period++) {
    const open = stores.filter((s) => isOpenAt(s, period));
    const openIds = new Set(open.map((s) => s.id));
    for (const store of open) {
      const rows = cells.filter((c) => c.s === store.id && c.p === period);
      observations.push({
        storeId: store.id,
        period,
        month: periodLabel(period),
        observedVisits: rows.reduce((a, r) => a + r.v, 0),
      });
    }
    // Closed stores have no rows for the period; explicit zero is not stored.
    void openIds;
  }

  return {
    meta: {
      name: '云澜市门店 × 需求点 × 期观测面板（合成）',
      grain: 'store × demand-cell × period',
      unit: 'visits/week',
      periods: meta.periods,
      generatedAt: '2026-11-16T00:00:00.000Z',
      disclaimer: '观测值为程序生成的虚构到访数据，带有隐藏门店偏好、点位需求偏差、业态偏好、容量回溢与观测噪声；可重复但不能当作真实经营数据。',
      generatingProcess: {
        beta: trueModel.beta,
        alpha: trueModel.alpha,
        latentAppealSigma: 0.09,
        pointDemandSigma: 0.13,
        formatAffinitySigma: 0.17,
        noiseSigma: 0.045,
        calendar: '按自然月的季节因子；不注入长期趋势，见源码 history.js',
        capacityRespected: true,
      },
      cellCount: cells.length,
      observationCount: observations.length,
    },
    observations,
    cells,
  };
}

/** Slice observation cells for a period range and optional point/store subsets. */
export function filterCells(history, { from = 1, to = Infinity, storeIds = null, pointIds = null } = {}) {
  const allowStores = storeIds ? new Set(storeIds) : null;
  const allowPoints = pointIds ? new Set(pointIds) : null;
  return history.cells.filter(
    (c) => c.p >= from && c.p <= to && (!allowStores || allowStores.has(c.s)) && (!allowPoints || allowPoints.has(c.d)),
  );
}

export function filterObservations(history, { from = 1, to = Infinity, storeIds = null } = {}) {
  const allow = storeIds ? new Set(storeIds) : null;
  return history.observations.filter(
    (o) => o.period >= from && o.period <= to && (!allow || allow.has(o.storeId)),
  );
}

export function observedByStorePeriod(history) {
  const map = new Map();
  for (const o of history.observations) {
    if (!map.has(o.storeId)) map.set(o.storeId, new Map());
    map.get(o.storeId).set(o.period, o.observedVisits);
  }
  return map;
}
