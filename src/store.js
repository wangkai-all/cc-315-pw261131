import fs from 'node:fs';
import path from 'node:path';
import { versionOf } from './versioning.js';
import { buildDataset, makeRoadNetwork } from './synth.js';
import { DEFAULT_MODEL, normalizeModel, modelVersion } from './model.js';
import { generateHistory, filterObservations } from './history.js';

/**
 * Dataset files are immutable, content-addressed snapshots under
 * data/datasets/active/. Editing inputs creates a NEW version rather than
 * mutating the existing one, so saved scenarios keep the exact inputs they used.
 * var/store.json points at active versions and holds scenarios/tasks.
 */

const ACTIVE_DIR = path.join('data', 'datasets', 'active');
const STORE_FILE = path.join('var', 'store.json');

export function activeDatasetPath(root = process.cwd(), name = '') {
  return path.join(root, ACTIVE_DIR, name);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

export function hashDoc(doc, prefix) {
  return versionOf(doc, prefix);
}

export function seedDatasets(root = process.cwd(), { force = false } = {}) {
  const ds = buildDataset();
  const targets = [
    ['network.json', 'net', ds.network],
    ['demand.json', 'dem', ds.demand],
    ['stores.json', 'str', ds.stores],
    ['candidates.json', 'cnd', ds.candidates],
  ];
  const versions = {};
  const docs = {};
  for (const [file, prefix, doc] of targets) {
    const full = activeDatasetPath(root, file);
    // Only write what is missing; otherwise respect the (possibly revised)
    // snapshot that is already on disk. Versions must be derived from the file
    // that actually exists, not from a freshly-built doc, or the manifest would
    // disagree with the data after a revision.
    if (force || !fs.existsSync(full)) writeJson(full, doc);
    const onDisk = readJson(full);
    docs[prefix] = onDisk;
    versions[prefix] = versionOf(onDisk, prefix);
  }
  const historyFile = activeDatasetPath(root, 'history.json');
  if (force || !fs.existsSync(historyFile)) {
    const network = makeRoadNetwork(docs.net);
    const history = generateHistory({ network, demand: docs.dem, storesDoc: docs.str });
    writeJson(historyFile, history);
    versions.hist = versionOf(history, 'hist');
  } else {
    versions.hist = versionOf(readJson(historyFile), 'hist');
  }
  const model = normalizeModel(DEFAULT_MODEL);
  versions.mdl = modelVersion(model);
  const existing = fs.existsSync(activeDatasetPath(root, 'manifest.json'))
    ? readJson(activeDatasetPath(root, 'manifest.json')) : null;
  const unchanged = existing && !force
    && ['net', 'dem', 'str', 'cnd', 'hist', 'mdl'].every((k) => existing.versions?.[k] === versions[k]);
  const manifest = {
    createdAt: unchanged ? existing.createdAt : new Date().toISOString(),
    city: docs.net.meta.name,
    versions,
    currentPeriod: docs.str.meta.periods.current,
    note: '内容寻址的不可变输入快照；修改输入会生成新版本，旧方案保留原版本引用。',
  };
  writeJson(activeDatasetPath(root, 'manifest.json'), manifest);
  return manifest;
}

export class DatasetStore {
  constructor(root = process.cwd()) {
    this.root = root;
    this.manifestPath = activeDatasetPath(root, 'manifest.json');
    this.manifest = readJson(this.manifestPath);
    this.docs = {};
    for (const [key, file, prefix] of [
      ['network', 'network.json', 'net'],
      ['demand', 'demand.json', 'dem'],
      ['stores', 'stores.json', 'str'],
      ['candidates', 'candidates.json', 'cnd'],
      ['history', 'history.json', 'hist'],
    ]) {
      const doc = readJson(activeDatasetPath(root, file));
      const actual = versionOf(doc, prefix);
      const recorded = this.manifest.versions[prefix];
      if (recorded && actual !== recorded) {
        throw new Error(`数据集 ${file} 的内容哈希 ${actual} 与清单 ${recorded} 不一致；请重新 seed 或修复清单。`);
      }
      this.docs[key] = doc;
    }
    this.network = makeRoadNetwork(this.docs.network);
    const model = normalizeModel(this.manifest.model ?? DEFAULT_MODEL);
    this.activeVersions = {
      demand: versionOf(this.docs.demand, 'dem'),
      network: versionOf(this.docs.network, 'net'),
      stores: versionOf(this.docs.stores, 'str'),
      candidates: versionOf(this.docs.candidates, 'cnd'),
      history: versionOf(this.docs.history, 'hist'),
      model: modelVersion(model),
    };
    this.model = model;
  }

  get demand() { return this.docs.demand; }
  get stores() { return this.docs.stores; }
  get candidates() { return this.docs.candidates; }
  get history() { return this.docs.history; }

  observations(opts) {
    return filterObservations(this.docs.history, opts);
  }

  /** Version + revision metadata shared by every response. */
  inputVersions() {
    return {
      ...this.activeVersions,
      currentPeriod: this.manifest.currentPeriod ?? this.stores.meta.periods.current,
      city: this.docs.network.meta.name,
      goal: '覆盖到访需求并控制新店之间、新店与旧店之间的重叠服务；不代表收入预测。',
    };
  }

  /** Apply an input revision and write a genuinely new versioned snapshot. */
  revise({ demandPoints, networkNodes, networkEdges, appendEdges = false, candidatePool, note = '' } = {}) {
    const stamp = new Date().toISOString();
    const revisions = [];
    if (demandPoints) {
      const doc = {
        ...this.docs.demand,
        meta: { ...this.docs.demand.meta, revision: stamp, revisionNote: note || '需求权重修订', createdAt: stamp },
        points: this.docs.demand.points.map((p) => {
          const patch = demandPoints[p.id];
          return patch ? { ...p, ...patch } : p;
        }),
      };
      writeJson(activeDatasetPath(this.root, `demand.${versionOf(doc, 'dem')}.json`), doc);
      writeJson(activeDatasetPath(this.root, 'demand.json'), doc);
      revisions.push('demand');
    }
    if (candidatePool) {
      for (const c of this.docs.candidates.candidates) {
        if (candidatePool[c.id]) Object.assign(c, candidatePool[c.id]);
      }
      const doc = {
        ...this.docs.candidates,
        meta: { ...this.docs.candidates.meta, revision: stamp, revisionNote: note || '候选池修订' },
      };
      writeJson(activeDatasetPath(this.root, `candidates.${versionOf(doc, 'cnd')}.json`), doc);
      writeJson(activeDatasetPath(this.root, 'candidates.json'), doc);
      revisions.push('candidates');
    }
    if (networkNodes || networkEdges) {
      const doc = {
        ...this.docs.network,
        nodes: networkNodes
          ? [...this.docs.network.nodes.filter((n) => !networkNodes[n.id]), ...Object.values(networkNodes)]
          : this.docs.network.nodes,
        edges: networkEdges
          ? (appendEdges
            ? [...this.docs.network.edges, ...networkEdges]
            : this.docs.network.edges.map((e, i) => (networkEdges[i] ? { ...e, ...networkEdges[i] } : e)))
          : this.docs.network.edges,
        meta: { ...this.docs.network.meta, revision: stamp, revisionNote: note || '路网修订' },
      };
      writeJson(activeDatasetPath(this.root, `network.${versionOf(doc, 'net')}.json`), doc);
      writeJson(activeDatasetPath(this.root, 'network.json'), doc);
      revisions.push('network');
    }
    const versions = {};
    for (const [key, file, prefix] of [
      ['network', 'network.json', 'net'],
      ['demand', 'demand.json', 'dem'],
      ['stores', 'stores.json', 'str'],
      ['candidates', 'candidates.json', 'cnd'],
      ['history', 'history.json', 'hist'],
    ]) {
      versions[prefix] = versionOf(readJson(activeDatasetPath(this.root, file)), prefix);
    }
    versions.mdl = modelVersion(this.model);
    writeJson(this.manifestPath, { ...this.manifest, versions, revisedAt: stamp, revisedInputs: revisions });
    return { versions, revisions, revisedAt: stamp };
  }

  storeState() {
    if (!fs.existsSync(path.join(this.root, STORE_FILE))) {
      return { scenarios: [], tasks: [], updatedAt: null };
    }
    return readJson(path.join(this.root, STORE_FILE));
  }

  saveStoreState(state) {
    writeJson(path.join(this.root, STORE_FILE), { ...state, updatedAt: new Date().toISOString() });
  }
}

export { STORE_FILE };
