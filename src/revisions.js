import { activeDatasetPath } from './store.js';
import { buildAccessIndex, destinationFromStore } from './model.js';
import { versionOf } from './versioning.js';

/**
 * Supported input revisions. Each revision is a payload applied by
 * DatasetStore.revise(), producing fresh content-addressed files. Saved
 * scenarios keep old version ids and are flagged stale — they never silently
 * adopt the new data.
 */

export const REVISION_PRESETS = {
  demandEast: {
    label: '需求修订：东港片区 +15%',
    description: '将东港片区 8 个需求点的周需求提高 15%，模拟新办公园区入驻。',
    apply: (demandDoc) => {
      const points = {};
      let affected = 0;
      for (const p of demandDoc.points) {
        if (p.district === 'ne') {
          points[p.id] = { weeklyDemand: Math.round(p.weeklyDemand * 1.15), note: '东港园区修订 +15%' };
          affected += 1;
        }
      }
      return { demandPoints: points, note: `东港片区 ${affected} 个需求点 +15%` };
    },
  },
  demandSouth: {
    label: '需求修订：南塘片区 −10%',
    description: '南塘片区需求下调 10%，模拟产业外迁。',
    apply: (demandDoc) => {
      const points = {};
      let affected = 0;
      for (const p of demandDoc.points) {
        if (p.district === 'se') {
          points[p.id] = { weeklyDemand: Math.max(1, Math.round(p.weeklyDemand * 0.9)), note: '南塘产业外迁修订 −10%' };
          affected += 1;
        }
      }
      return { demandPoints: points, note: `南塘片区 ${affected} 个需求点 −10%` };
    },
  },
  bridgeCongestion: {
    label: '路网修订：北桥施工封闭',
    description: '1 号跨河桥（北环路桥）施工封闭，跨河出行只能走 4 号或 7 号桥，东北片区耗时明显上升。',
    apply: (demandDoc, networkDoc) => {
      const edges = [];
      let affected = 0;
      networkDoc.edges.forEach((e, i) => {
        if (e.class === 'bridge' && e.from === 'n-1-5' && e.to === 'n-1-6') {
          edges[i] = { speedKmh: 0.01, distanceM: e.distanceM };
          affected += 1;
        }
      });
      void demandDoc;
      return { networkEdges: edges, note: `${affected} 段北桥按施工封闭处理（极低速）` };
    },
  },
  parkPath: {
    label: '路网修订：公园东侧新增支路',
    description: '在中央公园东侧新增一段纵向道路并接入东西向街道，缩短部分绕行。',
    apply: (demandDoc, networkDoc) => {
      // Add a through-road across the park, connecting two existing boundary
      // nodes via a new mid-park node. This creates a genuine shortcut.
      const node = { id: 'n-park-mid', x: 3400, y: 3400, name: '公园横路中段', kind: 'intersection' };
      const west = networkDoc.nodes.find((n) => n.id === 'n-4-3');
      const east = networkDoc.nodes.find((n) => n.id === 'n-4-5');
      const edges = [];
      if (west) edges.push({ from: 'n-4-3', to: node.id, distanceM: 850, speedKmh: 24, class: 'street', oneway: false, name: '公园横路' });
      if (east) edges.push({ from: node.id, to: 'n-4-5', distanceM: 850, speedKmh: 24, class: 'street', oneway: false, name: '公园横路' });
      void demandDoc;
      return { networkNodes: { [node.id]: node }, networkEdges: edges, appendEdges: true, note: '中央公园新增东西向支路' };
    },
  },
};

export function applyRevisionPreset(store, presetId, note = '') {
  const preset = REVISION_PRESETS[presetId];
  if (!preset) throw Object.assign(new Error(`未知修订预设：${presetId}`), { status: 400 });
  const patch = preset.apply(store.demand, store.docs.network);
  const revised = store.revise({ ...patch, note: note || patch.note });
  return {
    presetId,
    label: preset.label,
    description: preset.description,
    note: patch.note,
    ...revised,
  };
}

/**
 * Health checks after a revision: route coverage and median access time.
 * Purely diagnostic; does not mutate data.
 */
export function revisionDiagnostics({ network, demand, stores, versions }) {
  const destinations = stores.map(destinationFromStore);
  const access = buildAccessIndex({ network, demand, destinations });
  const all = access.rows.flatMap((r) => Array.from(r.times)).filter(Number.isFinite);
  all.sort((a, b) => a - b);
  return {
    diagnosticsVersion: versionOf({ versions, n: all.length }, 'diag'),
    reachablePairs: access.summary.reachablePairs,
    totalPairs: access.summary.pairs,
    medianTravelMinutes: all.length ? Number(all[Math.floor(all.length * 0.5)].toFixed(2)) : null,
    meanTravelMinutes: all.length ? Number((all.reduce((a, b) => a + b, 0) / all.length).toFixed(2)) : null,
    meanCircuityRatio: access.summary.meanCircuityRatio,
    note: '修订后的路由可达性自检；如出现不可达需求点，需检查新增节点连接。',
  };
}
