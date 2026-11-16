import { seedDatasets } from '../src/store.js';

const force = process.argv.includes('--force');
const manifest = seedDatasets(process.cwd(), { force });
console.log(JSON.stringify(manifest, null, 2));
console.log(force
  ? '已重建全部不可变输入快照。'
  : '仅补齐缺失的快照；如需重建请加 --force。');
