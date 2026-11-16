import { getAccess } from './access.js';
import { destinationFromCandidate, destinationFromStore, destinationFromCandidate as toDest, isOpenAt, modelVersion, normalizeModel, round, simulateUncertainty } from './model.js';
import { evaluateScenario } from './model.js';
import { seasonalityFor } from './history.js';
import { versionKey, versionOf } from './versioning.js';

/**
 * Scenario = a chosen candidate set + optional placement edits, pinned to the
 * exact input versions and model parameters used. Results are stored alongside
 * so a stale scenario can still be inspected without pretending to be current.
 */

export const DEFAULT_SCENARIO_PLACEMENT = Object.freeze({});

export function normalizeScenarioParams(params = {}) {
  const selectedIds = [...new Set((params.selectedIds ?? []).filter((x) => typeof x === 'string'))].sort();
  const placement = {};
  const bounds = {
    x: [0, 6000], y: [0, 6000], sizeSqm: [20, 2000],
    capacityVisitsPerWeek: [1, 200000], appeal: [0.2, 3], weeklyRentIndex: [0, 10000],
  };
  for (const [id, patch] of Object.entries(params.placement ?? {})) {
    if (!patch || typeof patch !== 'object') continue;
    const clean = {};
    for (const [key, [lo, hi]] of Object.entries(bounds)) {
      const raw = patch[key];
      if (raw === undefined || raw === null || raw === '') continue;
      if (typeof raw !== 'number' && typeof raw !== 'string') continue;
      const value = Number(raw);
      if (!Number.isFinite(value)) continue;
      if (value < lo || value > hi) continue;
      clean[key] = value;
    }
    if (Object.keys(clean).length) placement[id] = clean;
  }
  return {
    selectedIds,
    placement,
    period: Math.max(1, Math.round(Number(params.period) || 25)),
    goal: params.goal ?? null,
    label: typeof params.label === 'string' ? params.label.slice(0, 120) : '',
  };
}

export function scenarioInputVersions(baseVersions) {
  return {
    demand: baseVersions.demand,
    network: baseVersions.network,
    stores: baseVersions.stores,
    candidates: baseVersions.candidates,
    history: baseVersions.history,
    model: baseVersions.model,
  };
}

export function evaluateScenarioRequest({
  network, demand, storesDoc, candidatesDoc, versions, model, params, includeUncertainty = true,
}) {
  const p = normalizeScenarioParams(params);
  const stores = storesDoc.stores;
  const candidates = candidatesDoc.candidates.filter((c) => p.selectedIds.includes(c.id));
  const unknown = p.selectedIds.filter((id) => !candidatesDoc.candidates.some((c) => c.id === id));
  if (unknown.length) throw Object.assign(new Error(`未知候选点位：${unknown.join(', ')}`), { status: 400 });
  const access = getAccess({ network, demand, stores, candidates: candidatesDoc.candidates, versions, placement: p.placement });
  const storeCount = stores.length;
  const candidateDestinations = access.destinations.slice(storeCount).filter((d) => p.selectedIds.includes(d.id));
  const seasonality = seasonalityFor(p.period);
  const m = normalizeModel({ ...model, planningPeriod: p.period });
  const result = evaluateScenario({
    access: { ...access, destinations: [...access.destinations.slice(0, storeCount), ...candidateDestinations] },
    demand,
    stores,
    candidates: candidateDestinations,
    model: m,
    seasonality,
    period: p.period,
  });
  const uncertainty = includeUncertainty
    ? simulateUncertainty({
      access: { ...access, destinations: [...access.destinations.slice(0, storeCount), ...candidateDestinations] },
      demand, stores, candidates: candidateDestinations, model: m, seasonality, period: p.period,
      distanceMode: 'network',
    })
    : null;
  const inputVersions = { ...scenarioInputVersions(versions), model: modelVersion(m) };
  return {
    params: p,
    inputVersions,
    inputVersionKey: versionKey(inputVersions),
    model: m,
    seasonality,
    accessSummary: access.summary,
    ...result,
    uncertainty,
    generatedAt: new Date().toISOString(),
  };
}

export function makeScenarioRecord({ name, params, evaluation, note = '' }) {
  const now = new Date().toISOString();
  const base = {
    name: name?.trim() || defaultScenarioName(params, evaluation),
    note,
    createdAt: now,
    updatedAt: now,
    inputVersions: evaluation.inputVersions,
    inputVersionKey: evaluation.inputVersionKey,
    params: evaluation.params,
    model: evaluation.model,
    evaluation,
  };
  base.id = versionOf({ name: base.name, params: evaluation.params, versions: evaluation.inputVersions, createdAt: now }, 'sc', 12);
  return base;
}

export function defaultScenarioName(params, evaluation) {
  if (params?.label) return params.label;
  const names = evaluation?.perStore?.filter((s) => s.kind === 'candidate').map((s) => s.name) ?? [];
  return names.length ? names.join(' + ') : '空方案（仅现有门店）';
}

/** Recompute stale flag and version diffs against the active inputs. */
export function decorateScenario(scenario, activeVersions) {
  const keys = ['demand', 'network', 'stores', 'candidates', 'history', 'model'];
  const changed = keys
    .filter((k) => scenario.inputVersions?.[k] !== activeVersions?.[k])
    .map((k) => ({ key: k, previous: scenario.inputVersions?.[k] ?? null, current: activeVersions?.[k] ?? null }));
  return {
    id: scenario.id,
    name: scenario.name,
    note: scenario.note,
    createdAt: scenario.createdAt,
    updatedAt: scenario.updatedAt,
    params: scenario.params,
    inputVersions: scenario.inputVersions,
    inputVersionKey: scenario.inputVersionKey,
    stale: changed.length > 0,
    changedInputs: changed,
    summary: summarizeEvaluation(scenario.evaluation),
  };
}

export function summarizeEvaluation(evaluation) {
  if (!evaluation) return null;
  const newStores = evaluation.perStore.filter((s) => s.kind === 'candidate');
  return {
    candidateCount: newStores.length,
    candidateNames: newStores.map((s) => s.name),
    newStoreVisits: evaluation.impact.newStoreVisits,
    incrementalVisits: evaluation.impact.incrementalVisits,
    cannibalizedExistingVisits: evaluation.impact.cannibalizedExistingVisits,
    overlapLossVisits: evaluation.impact.overlapLossVisits,
    overlapLossRatio: evaluation.impact.overlapLossRatio,
    coverageRatio: evaluation.impact.coverageRatio,
    unmetVisits: evaluation.impact.unmetVisits,
    rentIndexTotal: evaluation.impact.rentIndexTotal,
    incrementalVisitsPerRentIndex: evaluation.impact.incrementalVisitsPerRentIndex,
    capacityBindingIds: evaluation.capacityPressure?.bindingStoreIds ?? [],
    uncertainty: evaluation.uncertainty
      ? {
        incrementalP10: evaluation.uncertainty.incremental.p10,
        incrementalP50: evaluation.uncertainty.incremental.p50,
        incrementalP90: evaluation.uncertainty.incremental.p90,
        probPositive: evaluation.uncertainty.incremental.probPositive,
      }
      : null,
    warnings: evaluation.warnings ?? [],
  };
}

/** Baseline-only evaluation for comparison. */
export function evaluateBaseline({ network, demand, storesDoc, versions, model, period = 25 }) {
  return evaluateScenarioRequest({
    network, demand, storesDoc,
    candidatesDoc: { candidates: [] },
    versions, model,
    params: { selectedIds: [], period },
    includeUncertainty: false,
  });
}

export function placementForCandidate(candidate, placement = {}) {
  return destinationFromCandidate(candidate, placement[candidate.id] ?? {});
}
