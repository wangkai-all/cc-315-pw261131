import test from 'node:test';
import assert from 'node:assert/strict';
import { versionOf, stableStringify, diffVersions, isStale, versionKey } from '../src/versioning.js';
import { RoadNetwork } from '../src/network.js';
import { buildNetwork, buildStores } from '../src/synth.js';
import { buildAccessIndex, destinationFromStore, destinationFromCandidate, DEFAULT_MODEL, allocate, isOpenAt } from '../src/model.js';
import { combinations, evaluateCombo, optimizeCombos, normalizeGoal } from '../src/optimizer.js';
import { spatialBlocks } from '../src/backtest.js';
import { seedDatasets, DatasetStore } from '../src/store.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mulberry32 } from '../src/rng.js';

const storesDoc = buildStores();

function toyNetwork() {
  return new RoadNetwork(
    [
      { id: 'a', x: 0, y: 0 }, { id: 'b', x: 1000, y: 0 },
      { id: 'c', x: 2000, y: 0 }, { id: 'd', x: 0, y: 1000 },
    ],
    [
      { from: 'a', to: 'b', distanceM: 1000, speedKmh: 10, class: 'street' },
      { from: 'a', to: 'd', distanceM: 1000, speedKmh: 40, class: 'arterial' },
      { from: 'd', to: 'c', distanceM: 1500, speedKmh: 40, class: 'arterial' },
      { from: 'b', to: 'c', distanceM: 1000, speedKmh: 10, class: 'street' },
    ],
  );
}

test('versioning is canonical and content-addressed', () => {
  assert.equal(stableStringify({ b: 1, a: [2, { d: 4, c: 3 }] }), stableStringify({ a: [2, { c: 3, d: 4 }], b: 1 }));
  assert.equal(versionOf({ a: 1, b: 2 }, 'x'), versionOf({ b: 2, a: 1 }, 'x'));
  assert.notEqual(versionOf({ a: 1 }, 'x'), versionOf({ a: 2 }, 'x'));
  const diffs = diffVersions({ demand: 'd1', network: 'n1' }, { demand: 'd2', network: 'n1' });
  assert.deepEqual(diffs, [{ key: 'demand', previous: 'd1', current: 'd2' }]);
  assert.equal(isStale({ demand: 'd1', network: 'n1', stores: 's', candidates: 'c', history: 'h', model: 'm' }, { demand: 'd2', network: 'n1', stores: 's', candidates: 'c', history: 'h', model: 'm' }), true);
  assert.equal(versionKey({ demand: 'd1', network: 'n1', stores: 's', candidates: 'c', history: 'h', model: 'm' }).length, 16);
});

test('router uses travel time, not shortest distance', () => {
  const net = toyNetwork();
  const route = net.route('a', 'c');
  // Direct a-b-c is 2 km at 10 km/h; detour via d is 2.5 km at 40 km/h.
  assert.deepEqual(route.path, ['a', 'd', 'c']);
  assert.equal(route.distanceM, 2500);
  assert.ok(route.seconds < 300);
});

test('one-way edges are honoured and unknown nodes rejected', () => {
  const net = new RoadNetwork(
    [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 100, y: 0 }],
    [{ from: 'a', to: 'b', distanceM: 100, speedKmh: 20, class: 'street', oneway: true }],
  );
  assert.ok(net.route('a', 'b'));
  assert.equal(net.route('b', 'a'), null);
  assert.throws(() => new RoadNetwork([{ id: 'a', x: 0, y: 0 }], [{ from: 'a', to: 'z', distanceM: 1, speedKmh: 1, class: 'x' }]), /unknown node/);
});

test('synthetic road network detours around river and park', () => {
  const net = new RoadNetwork(buildNetwork().nodes, buildNetwork().edges, buildNetwork().meta);
  // The only river crossings are rows 1, 4 and 7. A row-0 cross-river trip
  // must therefore detour via row 1, and the park forces a detour via row 5
  // (the row-4 expressway is cut between columns 3 and 5).
  const row0 = net.route('n-0-5', 'n-0-6');
  assert.ok(row0.distanceM > 850, `expected detour, got ${row0.distanceM}`);
  assert.ok(row0.path.includes('n-1-6'));
  const straightAcross = net.route('n-1-5', 'n-1-6');
  assert.ok(straightAcross.distanceM <= 900, 'bridge row crosses directly');
  const park = net.route('n-4-3', 'n-4-5');
  assert.ok(park.distanceM > 2 * 850, `park should force a detour, got ${park.distanceM}`);
});

test('allocation conserves demand unless capacity or cutoff binds', () => {
  const demand = {
    points: [
      { id: 'p1', x: 0, y: 0, weeklyDemand: 100 },
      { id: 'p2', x: 400, y: 0, weeklyDemand: 100 },
    ],
  };
  const net = new RoadNetwork(
    [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 400, y: 0 }],
    [{ from: 'a', to: 'b', distanceM: 400, speedKmh: 30, class: 'street' }],
  );
  const destinations = [
    { id: 'x', name: 'X', x: 0, y: 0, sizeSqm: 300, appeal: 1, capacityVisitsPerWeek: 1000, kind: 'existing' },
    { id: 'y', name: 'Y', x: 400, y: 0, sizeSqm: 300, appeal: 1, capacityVisitsPerWeek: 1000, kind: 'existing' },
  ];
  const access = buildAccessIndex({ network: net, demand, destinations });
  const out = allocate({ access, demandPoints: demand.points, destinations, model: DEFAULT_MODEL });
  assert.ok(Math.abs(out.totals.assignedVisits - 200) < 1e-6);
  assert.ok(Math.abs(out.perDestination[0].assignedVisits - 100) < 1e-6);
});

test('capacity binds and is never exceeded', () => {
  const demand = { points: [{ id: 'p1', x: 0, y: 0, weeklyDemand: 1000 }] };
  const net = new RoadNetwork(
    [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 600, y: 0 }],
    [{ from: 'a', to: 'b', distanceM: 600, speedKmh: 30, class: 'street' }],
  );
  const destinations = [
    { id: 'x', name: 'X', x: 0, y: 0, sizeSqm: 500, appeal: 1, capacityVisitsPerWeek: 120, kind: 'existing' },
    { id: 'y', name: 'Y', x: 600, y: 0, sizeSqm: 500, appeal: 1, capacityVisitsPerWeek: 500, kind: 'existing' },
  ];
  const access = buildAccessIndex({ network: net, demand, destinations });
  const out = allocate({ access, demandPoints: demand.points, destinations, model: DEFAULT_MODEL });
  assert.ok(out.perDestination[0].assignedVisits <= 120 + 1e-6);
  assert.ok(out.perDestination[1].assignedVisits <= 500 + 1e-6);
  assert.ok(Math.abs(out.totals.assignedVisits - 620) < 1e-6, 'assigns up to total capacity');
  assert.equal(out.capacity.respected, true);
});

test('theatres: demand beyond cutoff is reported, not silently dropped', () => {
  const demand = { points: [{ id: 'p1', x: 0, y: 0, weeklyDemand: 100 }] };
  const net = new RoadNetwork(
    [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 20000, y: 0 }],
    [{ from: 'a', to: 'b', distanceM: 20000, speedKmh: 20, class: 'street' }],
  );
  const destinations = [{ id: 'x', name: 'X', x: 20000, y: 0, sizeSqm: 300, appeal: 1, capacityVisitsPerWeek: 10000, kind: 'existing' }];
  const access = buildAccessIndex({ network: net, demand, destinations });
  const out = allocate({ access, demandPoints: demand.points, destinations, model: { ...DEFAULT_MODEL, cutoffMinutes: 12 } });
  assert.equal(out.totals.assignedVisits, 0);
  assert.equal(out.totals.beyondCutoffVisits, 100);
});

test('spatial blocks are disjoint and cover all points', () => {
  const points = Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, x: (i % 6) * 1000, y: Math.floor(i / 6) * 1000 }));
  const blocks = spatialBlocks(points, 5);
  assert.equal(blocks.k, 5);
  assert.equal(blocks.assign.size, 30);
  for (const [id, b] of blocks.assign) assert.ok(id && Number.isInteger(b) && b >= 0 && b < 5);
  const sizes = [...new Set(blocks.assign.values())].map((b) => [...blocks.assign.values()].filter((x) => x === b).length);
  assert.equal(sizes.reduce((a, b) => a + b, 0), 30);
  // Balanced-ish folds: no block may swallow the majority of points.
  assert.ok(Math.max(...sizes) <= 18, `unbalanced folds: ${sizes}`);
});

test('combinations enumerates without duplicates', () => {
  const c = combinations(5, 2);
  assert.equal(c.length, 10);
  assert.equal(new Set(c.map((x) => x.join(','))).size, 10);
  assert.equal(combinations(2, 3).length, 0);
});

test('goal weights normalise and k is clamped', () => {
  const g = normalizeGoal({ k: 99, weightCoverage: 2, weightOverlap: 2 });
  assert.equal(g.k, 6);
  assert.ok(Math.abs(g.weightCoverage - 0.5) < 1e-9);
});

test('combo overlap and additive-vs-combined accounting are consistent', () => {
  const ds = buildNetwork();
  const net = new RoadNetwork(ds.nodes, ds.edges, ds.meta);
  const demand = {
    points: [
      { id: 'p1', x: 1700, y: 1700, weeklyDemand: 400 },
      { id: 'p2', x: 3400, y: 1700, weeklyDemand: 400 },
    ],
  };
  const candidates = [
    { id: 'c1', name: 'C1', x: 2550, y: 1700, sizeSqm: 260, appeal: 1, capacityVisitsPerWeek: 5000, weeklyRentIndex: 500, district: 'sw', format: '社区店' },
    { id: 'c2', name: 'C2', x: 3400, y: 1700, sizeSqm: 260, appeal: 1, capacityVisitsPerWeek: 5000, weeklyRentIndex: 500, district: 'se', format: '社区店' },
  ];
  const access = buildAccessIndex({
    network: net, demand,
    destinations: [...storesDoc.stores.map(destinationFromStore), ...candidates.map((c) => destinationFromCandidate(c))],
  });
  // only use a subset of stores that are open at period 25
  const open = storesDoc.stores.filter((s) => isOpenAt(s, 25));
  const one = evaluateCombo({ access, demand, stores: open, candidates, selectedIds: ['c1'], model: DEFAULT_MODEL, period: 25, seasonality: 1 });
  const two = evaluateCombo({ access, demand, stores: open, candidates, selectedIds: ['c1', 'c2'], model: DEFAULT_MODEL, period: 25, seasonality: 1 });
  assert.ok(two.newStoreVisits >= one.newStoreVisits);
  assert.ok(two.sharedVisitsBetweenNewStores >= 0);
  assert.ok(two.overlapShare >= 0);
  assert.ok(two.sharedVisitsBetweenNewStores <= two.newStoreVisits + 1e-6);
});

test('optimizer frontier is non-dominated and deterministic', () => {
  const ds = buildNetwork();
  const net = new RoadNetwork(ds.nodes, ds.edges, ds.meta);
  const rand = mulberry32(7);
  const demand = {
    points: Array.from({ length: 18 }, (_, i) => ({
      id: `p${i}`,
      x: 500 + (i % 6) * 800 + rand() * 200,
      y: 500 + Math.floor(i / 6) * 1600 + rand() * 200,
      weeklyDemand: 300 + Math.round(rand() * 500),
    })),
  };
  const candidates = Array.from({ length: 8 }, (_, i) => ({
    id: `c${i}`,
    name: `C${i}`,
    x: 700 + (i % 4) * 1200,
    y: 700 + Math.floor(i / 4) * 2400,
    sizeSqm: 240,
    appeal: 1,
    capacityVisitsPerWeek: 5000,
    weeklyRentIndex: 400 + i * 30,
    district: 'x',
    format: '社区店',
  }));
  const access = buildAccessIndex({
    network: net, demand,
    destinations: [...storesDoc.stores.map(destinationFromStore), ...candidates.map((c) => destinationFromCandidate(c))],
  });
  const stores = storesDoc.stores.filter((s) => isOpenAt(s, 25));
  const args = { access, demand, stores, candidates, model: DEFAULT_MODEL, period: 25, seasonality: 1, goal: { k: 2 } };
  const a = optimizeCombos(args);
  const b = optimizeCombos(args);
  assert.equal(a.combosEvaluated, 28);
  assert.deepEqual(a.recommended.ids, b.recommended.ids);
  for (const x of a.frontier) {
    for (const y of a.frontier) {
      if (x === y) continue;
      assert.ok(!(
        x.coverage >= y.coverage - 1e-9
        && x.overlapShare <= y.overlapShare + 1e-9
        && x.rentIndexTotal <= y.rentIndexTotal + 1e-9
        && (x.coverage > y.coverage + 1e-9 || x.overlapShare < y.overlapShare - 1e-9 || x.rentIndexTotal < y.rentIndexTotal - 1e-9)
      ), `frontier member dominated: ${x.ids} by ${y.ids}`);
    }
  }
});

test('re-seeding never rewrites or re-manifests revised inputs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-seed-'));
  try {
    const first = seedDatasets(root);
    const store = new DatasetStore(root);
    const revised = store.revise({ networkEdges: [], note: 'no-op revision' });
    assert.notEqual(revised.versions.net, first.versions.net);
    // Running seed again must leave the revised snapshot and its manifest intact.
    const second = seedDatasets(root);
    assert.equal(second.versions.net, revised.versions.net);
    assert.equal(second.createdAt, seedDatasets(root).createdAt);
    const reloaded = new DatasetStore(root);
    assert.equal(reloaded.activeVersions.network, revised.versions.net);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
