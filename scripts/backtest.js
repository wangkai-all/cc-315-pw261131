import fs from 'node:fs';
import path from 'node:path';
import { DatasetStore } from '../src/store.js';
import { runBacktest } from '../src/backtest.js';
import { MODEL_CODE_VERSION } from '../src/versioning.js';

const root = process.cwd();
const store = new DatasetStore(root);
const versions = { ...store.activeVersions, code: MODEL_CODE_VERSION };
const report = await runBacktest({
  network: store.network,
  demand: store.demand,
  storesDoc: store.stores,
  history: store.history,
  model: store.model,
  versions,
});
const outDir = path.join(root, 'data', 'backtests');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'latest.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({
  version: report.id,
  inputVersionKey: report.inputVersionKey,
  metrics: report.metrics,
  naive: report.leakageDiagnostic?.metrics,
  closure: report.closureCheck,
  folds: report.protocol.foldsDetail,
}, null, 2));
