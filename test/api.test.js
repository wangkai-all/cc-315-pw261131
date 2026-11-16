import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5317 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;

let child;
let tmp;

async function waitForServer(tries = 80) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${BASE}/api/meta`);
      if (res.ok) return await res.json();
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error('server did not start');
}

async function req(method, p, body) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { status: res.status, json };
}

async function runTask(start, tries = 160) {
  for (let i = 0; i < tries; i++) {
    const tasks = await req('GET', '/api/tasks');
    const task = tasks.json.tasks.find((t) => t.id === start.json.task.id);
    if (task?.status === 'done') return task;
    if (task?.status === 'error') throw new Error(`task failed: ${task.error}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('task did not finish');
}

test.before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-api-'));
  fs.mkdirSync(path.join(tmp, 'data', 'datasets', 'active'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'data', 'datasets', 'active'), path.join(tmp, 'data', 'datasets', 'active'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'var'), { recursive: true });
  child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), ATLAS_ROOT: tmp },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  await waitForServer();
});

test.after(() => {
  child?.kill('SIGKILL');
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test('meta exposes versions, presets and the no-real-map disclaimer', async () => {
  const { status, json } = await req('GET', '/api/meta');
  assert.equal(status, 200);
  assert.equal(json.city.startsWith('云澜市'), true);
  for (const k of ['demand', 'network', 'stores', 'candidates', 'history', 'model']) {
    assert.match(json.versions[k], /^(dem|net|str|cnd|hist|mdl)-[0-9a-f]{10}$/);
  }
  assert.equal(json.versions.code, undefined, 'model code version must not masquerade as an input');
  assert.ok(json.revisionPresets.length >= 3);
  assert.match(json.disclaimer, /虚构/);
});

test('unknown routes and malformed bodies fail cleanly', async () => {
  assert.equal((await req('GET', '/api/nope')).status, 404);
  const res = await fetch(`${BASE}/api/scenarios/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops',
  });
  assert.equal(res.status, 400);
  const bad = await req('POST', '/api/scenarios/preview', { params: { selectedIds: ['does-not-exist'] } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /未知候选/);
});

test('preview rejects non-numeric placement fields rather than passing NaN', async () => {
  const { status, json } = await req('POST', '/api/scenarios/preview', {
    params: { selectedIds: ['c-01'], placement: { 'c-01': { x: 'abc', y: NaN, sizeSqm: -50 } }, period: 25 },
  });
  assert.equal(status, 200);
  // Every invalid field is dropped; if nothing valid remains the entry disappears
  // rather than surviving as an empty patch.
  assert.equal(json.params.placement['c-01'], undefined);
  assert.ok(Number.isFinite(json.impact.newStoreVisits));
  const partial = await req('POST', '/api/scenarios/preview', {
    params: { selectedIds: ['c-01'], placement: { 'c-01': { x: 1234, y: NaN, sizeSqm: -50 } }, period: 25 },
  });
  assert.equal(partial.status, 200);
  assert.deepEqual(partial.json.params.placement['c-01'], { x: 1234 });
});

test('scenario preview separates additive sum from combined incremental', async () => {
  const { status, json } = await req('POST', '/api/scenarios/preview', {
    params: { selectedIds: ['c-06', 'c-18'], period: 25 },
  });
  assert.equal(status, 200);
  const imp = json.impact;
  assert.ok(imp.additiveNaiveIncremental > 0);
  assert.ok(imp.incrementalVisits <= imp.additiveNaiveIncremental + 1e-6);
  assert.ok(imp.overlapLossVisits >= 0);
  assert.ok(json.overlapPairs.length === 1);
  // The map's access layer needs per-demand unmet volume, not just store totals.
  assert.equal(json.proposed.perDemand.length, 90);
  assert.ok(json.proposed.perDemand.every((d) => typeof d.unmet === 'number' && d.unmet >= 0));
  const unmetSum = json.proposed.perDemand.reduce((a, d) => a + d.unmet, 0);
  assert.ok(Math.abs(unmetSum - imp.unmetVisits) < 1, `per-demand unmet ${unmetSum} vs impact ${imp.unmetVisits}`);
  assert.ok(json.overlapByDemand.some((d) => d.sharedVisits > 0));
  assert.ok(json.uncertainty.incremental.p10 <= json.uncertainty.incremental.p90);
  assert.ok(json.uncertainty.perStore['c-06']);
  assert.match(json.uncertainty.assumptions.note, /不是收入预测/);
});

test('scenario is saved with pinned versions and flagged stale after a revision', async () => {
  const created = await req('POST', '/api/scenarios', {
    name: 'API 测试方案',
    params: { selectedIds: ['c-06', 'c-18'], period: 25 },
  });
  assert.equal(created.status, 201);
  const id = created.json.scenario.id;
  assert.equal(created.json.scenario.stale, false);
  const before = created.json.scenario.inputVersions;

  // A backtest pinned to the pre-revision inputs.
  const bt = await req('POST', '/api/backtest/run', {});
  assert.equal(bt.status, 202);
  await runTask(bt);
  assert.equal((await req('GET', '/api/backtest')).json.fresh, true);

  const revised = await req('POST', '/api/revisions/bridgeCongestion', {});
  assert.equal(revised.status, 200);
  assert.ok(revised.json.versions.network !== before.network);
  assert.ok(revised.json.impact.staleScenarios >= 1);

  const list = await req('GET', '/api/scenarios');
  const found = list.json.scenarios.find((s) => s.id === id);
  assert.equal(found.stale, true);
  assert.equal(found.changedInputs[0].key, 'network');
  // The *stored* evaluation must still reference the old version, not silently adopt new data.
  assert.equal(found.inputVersions.network, before.network);

  const backtest = await req('GET', '/api/backtest');
  assert.equal(backtest.json.fresh, false);
  assert.match(backtest.json.reason, /已修订/);

  const relinked = await req('POST', `/api/scenarios/${id}/relink`);
  assert.equal(relinked.status, 200);
  assert.equal(relinked.json.scenario.stale, false);
  assert.notEqual(relinked.json.scenario.inputVersions.network, before.network);
});

test('optimize and backtest tasks run to completion and are listable', async () => {
  const opt = await req('POST', '/api/optimize', { goal: { k: 2, weightCoverage: 0.5, weightOverlap: 0.5 }, period: 25 });
  assert.equal(opt.status, 202);
  const bt = await req('POST', '/api/backtest/run', {});
  assert.equal(bt.status, 202);
  const [optTask, btTask] = [await runTask(opt), await runTask(bt)];
  assert.equal(optTask.status, 'done');
  assert.ok(optTask.result.recommended.length >= 1);
  const doc = await req('GET', `/api/optimizations/${optTask.result.id}`);
  assert.equal(doc.status, 200);
  assert.ok(doc.json.frontier.length >= 1);
  assert.equal(typeof doc.json.goalConflict, 'boolean');

  assert.equal(btTask.status, 'done');
  const report = await req('GET', '/api/backtest');
  assert.equal(report.json.fresh, true);
  assert.ok(report.json.metrics.wape > 0);
  assert.equal(report.json.folds.length, 5);
  assert.ok(report.json.leakageDiagnostic.metrics.wape > 0);
  assert.ok(report.json.closureCheck.transferShareOfClosedStore > 0);
});

test('unknown task id and retry of missing task are 404', async () => {
  assert.equal((await req('GET', '/api/tasks/task-nope')).status, 404);
  assert.equal((await req('POST', '/api/tasks/task-nope/retry')).status, 404);
});
