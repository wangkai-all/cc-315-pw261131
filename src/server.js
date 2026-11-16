import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatasetStore, seedDatasets, activeDatasetPath } from './store.js';
import { defaultScenarioName, decorateScenario, evaluateScenarioRequest, makeScenarioRecord } from './scenario.js';
import { optimizeCombos, normalizeGoal } from './optimizer.js';
import { getAccess, clearAccessCache } from './access.js';
import { runBacktest, isBacktestFresh } from './backtest.js';
import { TaskQueue } from './tasks.js';
import { applyRevisionPreset, revisionDiagnostics, REVISION_PRESETS } from './revisions.js';
import { MODEL_CODE_VERSION, versionKey, versionOf } from './versioning.js';
import { seasonalityFor } from './history.js';
import { normalizeModel } from './model.js';

const MODULE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = process.env.ATLAS_ROOT ? path.resolve(process.env.ATLAS_ROOT) : MODULE_DIR;
const PUBLIC_DIR = path.join(MODULE_DIR, 'public');
const SCENARIOS_FILE = path.join(ROOT, 'var', 'scenarios.json');
const BACKTEST_FILE = path.join(ROOT, 'data', 'backtests', 'latest.json');

if (!fs.existsSync(activeDatasetPath(ROOT, 'manifest.json'))) {
  seedDatasets(ROOT);
}
const dataset = new DatasetStore(ROOT);
const taskQueue = new TaskQueue(ROOT, {
  backtest: async (payload, progress) => {
    progress(0.1, '构建路网可达性…');
    const store = new DatasetStore(ROOT);
    const versions = { ...store.activeVersions, code: MODEL_CODE_VERSION };
    progress(0.3, '空间分块与时间外推…');
    const report = await runBacktest({
      network: store.network,
      demand: store.demand,
      storesDoc: store.stores,
      history: store.history,
      model: payload.model ? normalizeModel(payload.model) : store.model,
      protocol: payload.protocol ?? {},
      versions,
    });
    progress(0.85, '写回测报告…');
    fs.mkdirSync(path.dirname(BACKTEST_FILE), { recursive: true });
    fs.writeFileSync(BACKTEST_FILE, JSON.stringify(report, null, 2) + '\n');
    progress(1, '完成');
    return { result: { id: report.id, metrics: report.metrics, inputVersionKey: report.inputVersionKey }, ref: 'data/backtests/latest.json', versionKey: report.inputVersionKey };
  },
  optimize: async (payload, progress) => {
    progress(0.15, '读取候选池与可达性…');
    const store = new DatasetStore(ROOT);
    const access = getAccess({
      network: store.network,
      demand: store.demand,
      stores: store.stores.stores,
      candidates: store.candidates.candidates,
      versions: store.activeVersions,
      placement: payload.placement ?? {},
    });
    progress(0.35, '枚举候选组合…');
    const result = optimizeCombos({
      access,
      demand: store.demand,
      stores: store.stores.stores,
      candidates: store.candidates.candidates,
      model: normalizeModel(payload.model ?? store.model),
      period: payload.period ?? 25,
      seasonality: seasonalityFor(payload.period ?? 25),
      goal: payload.goal,
      placement: payload.placement ?? {},
      distanceMode: payload.distanceMode === 'straight' ? 'straight' : 'network',
    });
    progress(0.9, '汇总 Pareto 前沿…');
    const id = versionOf({ result: result.recommended, versions: store.activeVersions, goal: result.goal }, 'opt', 12);
    const doc = {
      id,
      createdAt: new Date().toISOString(),
      versions: store.activeVersions,
      inputVersionKey: versionKey(store.activeVersions),
      params: { goal: result.goal, period: payload.period ?? 25, placement: payload.placement ?? {}, distanceMode: payload.distanceMode ?? 'network' },
      ...result,
    };
    fs.mkdirSync(path.join(ROOT, 'data', 'optimizations'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'data', 'optimizations', `${id}.json`), JSON.stringify(doc, null, 2) + '\n');
    progress(1, '完成');
    return { result: { id, recommended: result.recommended?.ids ?? [], combosEvaluated: result.combosEvaluated }, ref: `data/optimizations/${id}.json`, versionKey: doc.inputVersionKey };
  },
});

function readScenarios() {
  if (!fs.existsSync(SCENARIOS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(SCENARIOS_FILE, 'utf8')); } catch { return []; }
}

function writeScenarios(scenarios) {
  fs.mkdirSync(path.dirname(SCENARIOS_FILE), { recursive: true });
  fs.writeFileSync(SCENARIOS_FILE, JSON.stringify(scenarios, null, 2) + '\n');
}

function loadBacktest() {
  if (!fs.existsSync(BACKTEST_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(BACKTEST_FILE, 'utf8')); } catch { return null; }
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(payload);
}

function fail(res, status, message, detail) {
  json(res, status, { error: message, detail: detail ?? null });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 8_000_000) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(Object.assign(new Error('JSON 解析失败'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function currentVersions() {
  return { ...dataset.activeVersions };
}

function backtestStatus() {
  const report = loadBacktest();
  if (!report) return { present: false, fresh: false, reason: '尚未运行回测' };
  const current = { ...currentVersions(), code: MODEL_CODE_VERSION };
  const fresh = isBacktestFresh(report, current);
  return {
    present: true,
    fresh,
    reason: fresh ? '回测与当前输入版本一致' : '输入或路网已修订，旧回测不再代表当前数据',
    id: report.id,
    createdAt: report.createdAt,
    inputVersions: report.versions,
    inputVersionKey: report.inputVersionKey,
    currentVersionKey: versionKey(current),
    metrics: report.metrics,
    protocol: report.protocol,
    folds: report.folds,
    leakageDiagnostic: report.leakageDiagnostic,
    closureCheck: report.closureCheck,
    interpretation: report.interpretation,
    disclaimer: report.disclaimer,
  };
}

const routes = {
  'GET /api/meta': (req, res) => {
    const versions = currentVersions();
    json(res, 200, {
      city: dataset.demand.meta.name,
      versions,
      versionKey: versionKey(versions),
      currentPeriod: dataset.manifest.currentPeriod ?? dataset.stores.meta.periods.current,
      periods: dataset.stores.meta.periods,
      districts: [...new Map(dataset.demand.points.map((p) => [p.district, p.districtName])).entries()].map(([id, name]) => ({ id, name })),
      demand: dataset.demand.meta,
      network: dataset.network.meta,
      stores: dataset.stores.meta,
      candidates: dataset.candidates.meta,
      history: dataset.history.meta,
      model: dataset.model,
      goal: '在覆盖更多需求与减少重叠服务之间取舍；结果不是收入预测。',
      revisionPresets: Object.entries(REVISION_PRESETS).map(([id, p]) => ({ id, label: p.label, description: p.description })),
      backtest: { present: fs.existsSync(BACKTEST_FILE) },
      disclaimer: '全部数据、路网与门店均为虚构；未调用商业地图、路径规划或真实交易系统。',
    });
  },

  'GET /api/data': (req, res) => {
    const versions = currentVersions();
    json(res, 200, {
      versions,
      versionKey: versionKey(versions),
      currentPeriod: dataset.manifest.currentPeriod ?? 24,
      demand: dataset.demand,
      network: dataset.network,
      stores: dataset.stores,
      candidates: dataset.candidates,
      historyMeta: dataset.history.meta,
      model: dataset.model,
      accessSummary: getAccess({
        network: dataset.network,
        demand: dataset.demand,
        stores: dataset.stores.stores,
        candidates: dataset.candidates.candidates,
        versions,
      }).summary,
    });
  },

  'POST /api/optimize': async (req, res) => {
    const body = await readBody(req);
    const goal = normalizeGoal(body.goal);
    const task = taskQueue.enqueue('optimize', { goal, period: body.period ?? 25, placement: body.placement ?? {}, distanceMode: body.distanceMode ?? 'network', model: body.model ?? dataset.model }, { label: `组合搜索 k=${goal.k}` });
    json(res, 202, { task: publicTask(task) });
  },

  'POST /api/scenarios/preview': async (req, res) => {
    const body = await readBody(req);
    const evaluation = evaluateScenarioRequest({
      network: dataset.network,
      demand: dataset.demand,
      storesDoc: dataset.stores,
      candidatesDoc: dataset.candidates,
      versions: currentVersions(),
      model: body.model ? normalizeModel(body.model) : dataset.model,
      params: body.params ?? body,
      includeUncertainty: body.includeUncertainty !== false,
    });
    json(res, 200, evaluation);
  },

  'GET /api/scenarios': (req, res) => {
    const scenarios = readScenarios();
    const versions = currentVersions();
    json(res, 200, {
      scenarios: scenarios.map((s) => decorateScenario(s, versions)),
      currentVersionKey: versionKey(versions),
    });
  },

  'POST /api/scenarios': async (req, res) => {
    const body = await readBody(req);
    const evaluation = evaluateScenarioRequest({
      network: dataset.network,
      demand: dataset.demand,
      storesDoc: dataset.stores,
      candidatesDoc: dataset.candidates,
      versions: currentVersions(),
      model: body.model ? normalizeModel(body.model) : dataset.model,
      params: body.params ?? body,
      includeUncertainty: true,
    });
    const record = makeScenarioRecord({
      name: body.name ?? defaultScenarioName(evaluation.params, evaluation),
      params: evaluation.params,
      note: body.note ?? '',
      evaluation,
    });
    const scenarios = readScenarios();
    scenarios.push(record);
    writeScenarios(scenarios);
    json(res, 201, { scenario: decorateScenario(record, currentVersions()) });
  },

  'DELETE /api/scenarios/:id': (req, res, params) => {
    const scenarios = readScenarios();
    const idx = scenarios.findIndex((s) => s.id === params.id);
    if (idx < 0) return fail(res, 404, '方案不存在');
    scenarios.splice(idx, 1);
    writeScenarios(scenarios);
    json(res, 200, { ok: true });
  },

  'GET /api/scenarios/:id': (req, res, params) => {
    const scenario = readScenarios().find((s) => s.id === params.id);
    if (!scenario) return fail(res, 404, '方案不存在');
    json(res, 200, { scenario: decorateScenario(scenario, currentVersions()), storedEvaluation: scenario.evaluation });
  },

  'POST /api/scenarios/:id/relink': async (req, res, params) => {
    const scenarios = readScenarios();
    const idx = scenarios.findIndex((s) => s.id === params.id);
    if (idx < 0) return fail(res, 404, '方案不存在');
    const evaluation = evaluateScenarioRequest({
      network: dataset.network,
      demand: dataset.demand,
      storesDoc: dataset.stores,
      candidatesDoc: dataset.candidates,
      versions: currentVersions(),
      model: dataset.model,
      params: scenarios[idx].params,
      includeUncertainty: true,
    });
    scenarios[idx] = {
      ...scenarios[idx],
      inputVersions: evaluation.inputVersions,
      inputVersionKey: evaluation.inputVersionKey,
      model: evaluation.model,
      evaluation,
      updatedAt: new Date().toISOString(),
      relinkedAt: new Date().toISOString(),
    };
    writeScenarios(scenarios);
    json(res, 200, { scenario: decorateScenario(scenarios[idx], currentVersions()) });
  },

  'GET /api/backtest': (req, res) => json(res, 200, backtestStatus()),

  'POST /api/backtest/run': async (req, res) => {
    const body = await readBody(req);
    const task = taskQueue.enqueue('backtest', { protocol: body.protocol ?? {}, model: body.model ?? null }, { label: '空间-时间隔离回测' });
    json(res, 202, { task: publicTask(task) });
  },

  'POST /api/revisions/:preset': async (req, res, params, url) => {
    const body = await readBody(req);
    const result = applyRevisionPreset(dataset, params.preset, body.note ?? '');
    // Reload the dataset in place so subsequent requests see new versions.
    relocateDataset();
    clearAccessCache();
    json(res, 200, {
      ...result,
      versions: currentVersions(),
      versionKey: versionKey(currentVersions()),
      diagnostics: revisionDiagnostics({
        network: dataset.network, demand: dataset.demand, stores: dataset.stores.stores, versions: currentVersions(),
      }),
      impact: {
        staleScenarios: readScenarios().filter((s) => s.inputVersions?.network !== currentVersions().network
          || s.inputVersions?.demand !== currentVersions().demand
          || s.inputVersions?.candidates !== currentVersions().candidates
          || s.inputVersions?.stores !== currentVersions().stores).length,
        backtestFresh: backtestStatus().fresh,
      },
      note: '输入版本已更新；旧方案保留原版本并标记为过期，必须显式重算才能采用新数据。',
    });
  },

  'GET /api/tasks': (req, res) => json(res, 200, { tasks: taskQueue.list().map(publicTask), running: taskQueue.running ? taskQueue.running.id : null }),

  'GET /api/tasks/:id': (req, res, params) => {
    const t = taskQueue.get(params.id);
    if (!t) return fail(res, 404, '任务不存在');
    json(res, 200, { task: publicTask(t) });
  },

  'POST /api/tasks/:id/retry': (req, res, params) => {
    try {
      const t = taskQueue.retry(params.id);
      if (!t) return fail(res, 404, '任务不存在');
      json(res, 200, { task: publicTask(t) });
    } catch (err) {
      fail(res, err.status ?? 500, err.message);
    }
  },

  'POST /api/tasks/:id/cancel': (req, res, params) => {
    const t = taskQueue.cancel(params.id);
    if (!t) return fail(res, 404, '任务不存在');
    json(res, 200, { task: publicTask(t) });
  },

  'GET /api/optimizations/:id': (req, res, params) => {
    const file = path.join(ROOT, 'data', 'optimizations', `${path.basename(params.id)}.json`);
    if (!fs.existsSync(file)) return fail(res, 404, '结果不存在');
    const body = JSON.parse(fs.readFileSync(file, 'utf8'));
    json(res, 200, { ...body, fresh: body.inputVersionKey === versionKey(currentVersions()), currentVersionKey: versionKey(currentVersions()) });
  },
};

function relocateDataset() {
  const fresh = new DatasetStore(ROOT);
  dataset.manifest = fresh.manifest;
  dataset.docs = fresh.docs;
  dataset.network = fresh.network;
  dataset.model = fresh.model;
  dataset.activeVersions = { ...fresh.activeVersions };
}

function publicTask(t) {
  if (!t) return null;
  return {
    id: t.id,
    kind: t.kind,
    label: t.label,
    status: t.status,
    progress: t.progress,
    message: t.message,
    error: t.error,
    result: t.result ?? null,
    resultRef: t.resultRef,
    resultVersionKey: t.resultVersionKey,
    inputRequestVersion: versionOf(t.payload, 'req', 12),
    payload: t.payload,
    createdAt: t.createdAt,
    startedAt: t.startedAt,
    finishedAt: t.finishedAt,
    attempts: t.attempts,
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  const safe = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = path.join(PUBLIC_DIR, safe === '/' ? 'index.html' : safe);
  const rel = path.relative(PUBLIC_DIR, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return fail(res, 403, '禁止访问');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    if (path.extname(file)) return fail(res, 404, '文件不存在');
    file = path.join(PUBLIC_DIR, 'index.html');
  }
  const type = MIME[path.extname(file)] ?? 'application/octet-stream';
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);
  try {
    const match = findRoute(req.method, pathname);
    if (!match) return fail(res, 404, '接口不存在');
    await match.handler(req, res, match.params, url);
  } catch (err) {
    if (!res.headersSent) fail(res, err.status ?? 500, err.message ?? '服务器错误', err.stack);
    else res.end();
  }
});

function findRoute(method, pathname) {
  for (const [key, handler] of Object.entries(routes)) {
    const [m, pattern] = key.split(' ');
    if (m !== method) continue;
    const names = [];
    const regex = new RegExp('^' + pattern.replace(/:[a-zA-Z]+/g, (s) => { names.push(s.slice(1)); return '([^/]+)'; }) + '$');
    const hit = pathname.match(regex);
    if (hit) {
      const params = Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(hit[i + 1])]));
      return { handler, params };
    }
  }
  return null;
}

const PORT = Number(process.env.PORT) || 5173;
server.listen(PORT, '127.0.0.1', () => {
  console.log(`选址分析实验室已启动：http://127.0.0.1:${PORT}`);
  console.log('所有需求、路网、门店与候选点均为虚构；不连接商业地图或真实交易数据。');
});
