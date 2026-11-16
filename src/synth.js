import { RoadNetwork } from './network.js';
import { fromMeters } from './geometry.js';
import { mulberry32, normal, pick } from './rng.js';

/**
 * Deterministic synthetic city ("云澜市"). Not real geography, not a commercial
 * map. Roads include a central park hole and a river with only three bridges so
 * network travel times genuinely differ from straight-line distance.
 */

export const CITY = {
  name: '云澜市',
  origin: { lat: 31.2304, lon: 121.4737 },
  grid: 8,
  spacingM: 850,
  park: { x0: 2550, y0: 2550, x1: 4250, y1: 4250 },
  river: { x0: 4595, x1: 4755, y0: 0, y1: 5950, bridgeRows: [1, 4, 7] },
};

const ROW_NAMES = ['北环路', '云杉路', '澜川大道', '栖霞路', '中央公园道', '南塘路', '望江路', '环城南路'];
const COL_NAMES = ['西林路', '松涛路', '白鹭街', '云影路', '长宁路', '澜川大道', '东港路', '临江路'];
const DISTRICTS = [
  { id: 'nw', name: '北岸', cx: 1800, cy: 4300 },
  { id: 'ne', name: '东港', cx: 4300, cy: 4300 },
  { id: 'sw', name: '西林', cx: 1800, cy: 1600 },
  { id: 'se', name: '南塘', cx: 4300, cy: 1600 },
];

const nodeId = (r, c) => `n-${r}-${c}`;
const nodeCoord = (r, c) => ({ x: c * CITY.spacingM, y: r * CITY.spacingM });

function inPark(x, y, margin = 0) {
  const p = CITY.park;
  return x > p.x0 - margin && x < p.x1 + margin && y > p.y0 - margin && y < p.y1 + margin;
}

function nodeInPark(r, c) {
  return r === 4 && c === 4;
}

function edgeInsidePark(r, c, dir) {
  // Park spans x 2550..4250, y 2550..4250 (two cells). Boundary streets stay.
  if (dir === 'h') return r === 4 && (c === 3 || c === 4);
  return c === 4 && (r === 3 || r === 4);
}

function crossesRiver(r, c, dir) {
  return dir === 'h' && c === 5 && !CITY.river.bridgeRows.includes(r);
}

function insideCity(x, y) {
  return x >= 0 && x <= (CITY.grid - 1) * CITY.spacingM && y >= 0 && y <= (CITY.grid - 1) * CITY.spacingM;
}

function nearestDistrict(x, y) {
  let best = DISTRICTS[0];
  let bestD = Infinity;
  for (const d of DISTRICTS) {
    const dist = Math.hypot(x - d.cx, y - d.cy);
    if (dist < bestD) { bestD = dist; best = d; }
  }
  return best;
}

function toGeo(x, y) {
  const p = fromMeters(x, y, CITY.origin.lat);
  return { lat: Number((CITY.origin.lat + p.lat).toFixed(6)), lon: Number((CITY.origin.lon + p.lon).toFixed(6)) };
}

export function buildNetwork() {
  const nodes = [];
  for (let r = 0; r < CITY.grid; r++) {
    for (let c = 0; c < CITY.grid; c++) {
      if (nodeInPark(r, c)) continue;
      const { x, y } = nodeCoord(r, c);
      const geo = toGeo(x, y);
      nodes.push({
        id: nodeId(r, c),
        x,
        y,
        ...geo,
        name: `${ROW_NAMES[r]} × ${COL_NAMES[c]}`,
        kind: 'intersection',
      });
    }
  }

  const edges = [];
  const pushEdge = (r, c, dir) => {
    const fr = dir === 'h' ? r : r;
    const fc = dir === 'h' ? c : c;
    const tr = dir === 'h' ? r : r + 1;
    const tc = dir === 'h' ? c + 1 : c;
    if (nodeInPark(fr, fc) || nodeInPark(tr, tc)) return;
    if (edgeInsidePark(r, c, dir) || crossesRiver(r, c, dir)) return;
    const a = nodeCoord(fr, fc);
    const b = nodeCoord(tr, tc);
    let cls = 'street';
    let speedKmh = 28;
    if (r === 0 || r === CITY.grid - 1 || c === 0 || c === CITY.grid - 1) {
      cls = 'ring'; speedKmh = 50;
    }
    if (r === 3 || c === 3) { cls = 'arterial'; speedKmh = 42; }
    if (r === 4) { cls = 'expressway'; speedKmh = 60; }
    if (dir === 'h' && c === 5) { cls = 'bridge'; speedKmh = 32; }
    const name = cls === 'bridge'
      ? `${ROW_NAMES[r]}澜川大桥`
      : dir === 'h' ? ROW_NAMES[r] : COL_NAMES[c];
    edges.push({
      from: nodeId(fr, fc),
      to: nodeId(tr, tc),
      distanceM: Math.round(Math.hypot(b.x - a.x, b.y - a.y)),
      speedKmh,
      class: cls,
      oneway: false,
      name,
    });
  };
  for (let r = 0; r < CITY.grid; r++) {
    for (let c = 0; c < CITY.grid - 1; c++) pushEdge(r, c, 'h');
  }
  for (let r = 0; r < CITY.grid - 1; r++) {
    for (let c = 0; c < CITY.grid; c++) pushEdge(r, c, 'v');
  }

  return {
    meta: {
      name: CITY.name,
      kind: 'synthetic',
      crs: 'local-enu-metres',
      origin: CITY.origin,
      disclaimer: '虚构城市与路网，仅用于方法演示；所有行程时间为静态速度近似，未接入商业地图或实时路况。',
      createdAt: '2026-11-16T00:00:00.000Z',
      park: CITY.park,
      river: CITY.river,
      notes: [
        '中央公园移除内部路口，车辆需绕行公园边界。',
        '澜川河仅在 1/4/7 行架桥，跨河出行需绕行至桥。',
        '行程成本按路段限速计算，并附加每次转向 6 秒惩罚。',
      ],
    },
    nodes,
    edges,
  };
}

export function buildDemand() {
  const rand = mulberry32(20261116);
  const points = [];
  let index = 0;
  for (let r = 0; r < CITY.grid - 1; r++) {
    for (let c = 0; c < CITY.grid - 1; c++) {
      // 2 demand points per block; park blocks contribute none.
      const blockCenter = { x: (c + 0.5) * CITY.spacingM, y: (r + 0.5) * CITY.spacingM };
      if (inPark(blockCenter.x, blockCenter.y, 50)) continue;
      for (let k = 0; k < 2; k++) {
        let x = 0;
        let y = 0;
        for (let attempt = 0; attempt < 20; attempt++) {
          x = blockCenter.x + (rand() - 0.5) * 520;
          y = blockCenter.y + (rand() - 0.5) * 520;
          if (!inPark(x, y, 120) && insideCity(x, y)) break;
        }
        const district = nearestDistrict(x, y);
        const distCenter = Math.hypot(x - 2975, y - 2975);
        let type = 'residential';
        if (distCenter < 2000 && rand() < 0.58) type = 'office';
        else if (distCenter < 3200 && rand() < 0.34) type = 'mixed';
        const households = type === 'office' ? Math.round(30 + rand() * 160) : Math.round(80 + rand() * 560);
        const workers = type === 'residential' ? Math.round(20 + rand() * 160) : Math.round(200 + rand() * 480);
        const weeklyDemand = Math.round(households * 0.92 + workers * 0.38);
        const geo = toGeo(x, y);
        index += 1;
        points.push({
          id: `d-${String(index).padStart(3, '0')}`,
          x: Math.round(x),
          y: Math.round(y),
          ...geo,
          district: district.id,
          districtName: district.name,
          type,
          households,
          workers,
          weeklyDemand,
          note: inPark(x, y, 120) ? 'park-edge' : null,
        });
      }
    }
  }
  return {
    meta: {
      name: '云澜市需求网格 v1',
      grain: 'block-cluster',
      unit: 'visits/week',
      method: '需求潜力 = 住户数 × 0.92 + 岗位数 × 0.38（每周到访人次口径，不代表营业额）',
      disclaimer: '网格需求为合成估算，不是人口普查或真实交易数据。',
      createdAt: '2026-11-16T00:00:00.000Z',
    },
    points,
  };
}

function candidateName(r, c, suffix) {
  return `${ROW_NAMES[r].replace('路', '')}${COL_NAMES[c].replace('路', '').replace('街', '')}${suffix}`;
}

export function buildStores() {
  const at = (r, c) => nodeCoord(r, c);
  const rows = [
    {
      id: 's-01', name: '云杉西林店', x: at(2, 2).x, y: at(2, 2).y, district: 'nw',
      sizeSqm: 320, capacityVisitsPerWeek: 10500, appeal: 1.06, format: '街边标准店',
      openedPeriod: 1, closedPeriod: null, status: 'open', note: '最早门店，承接北岸与西林交界需求。',
    },
    {
      id: 's-02', name: '澜川北店', x: at(2, 5).x, y: at(2, 5).y, district: 'ne',
      sizeSqm: 250, capacityVisitsPerWeek: 9000, appeal: 0.92, format: '社区店',
      openedPeriod: 1, closedPeriod: 18, status: 'closed', note: '第 19 期租约到期关闭，验证营业变更后的需求转移。',
    },
    {
      id: 's-03', name: '西林南店', x: at(5, 2).x, y: at(5, 2).y, district: 'sw',
      sizeSqm: 380, capacityVisitsPerWeek: 11000, appeal: 1.0, format: '街边标准店',
      openedPeriod: 1, closedPeriod: null, status: 'open', note: '西南主力店。',
    },
    {
      id: 's-04', name: '南塘公园店', x: at(5, 4).x, y: at(5, 4).y, district: 'se',
      sizeSqm: 280, capacityVisitsPerWeek: 8000, appeal: 0.98, format: '公园店',
      openedPeriod: 1, closedPeriod: null, status: 'open', note: '公园南缘，周末客流较高。',
    },
    {
      id: 's-05', name: '东港店', x: at(5, 6).x, y: at(5, 6).y, district: 'ne',
      sizeSqm: 300, capacityVisitsPerWeek: 8200, appeal: 1.04, format: '街边标准店',
      openedPeriod: 13, closedPeriod: null, status: 'open', note: '第 13 期新开，用于时间外推验证。',
    },
  ];
  return {
    meta: {
      name: '云澜市现有门店与营业历史',
      unit: 'visits/week',
      disclaimer: '门店、容量与营业历史均为虚构。容量为每周可服务到访人次上限。',
      periods: {
        count: 24,
        labels: Array.from({ length: 24 }, (_, i) => periodLabel(i + 1)),
        current: 24,
        training: [1, 12],
        validation: [13, 24],
      },
    },
    stores: rows,
  };
}

export function periodLabel(p) {
  const startYear = 2024;
  const startMonth = 12; // period 1 = 2024-12
  const zero = startMonth - 1 + (p - 1);
  const year = startYear + Math.floor(zero / 12);
  const month = (zero % 12) + 1;
  return `${year}-${String(month).padStart(2, '0')}`;
}

export function buildCandidates() {
  const rand = mulberry32(77123);
  const stores = buildStores().stores;
  const existing = stores.map((s) => ({ x: s.x, y: s.y }));
  const spots = [];
  for (let r = 1; r < CITY.grid - 1; r++) {
    for (let c = 1; c < CITY.grid - 1; c++) {
      if (nodeInPark(r, c)) continue;
      if ((r === 2 && c === 2) || (r === 2 && c === 5) || (r === 5 && c === 2) || (r === 5 && c === 4) || (r === 5 && c === 6)) continue;
      const jitter = 60 + rand() * 180;
      spots.push({
        r, c,
        x: c * CITY.spacingM + (rand() - 0.5) * jitter,
        y: r * CITY.spacingM + (rand() - 0.5) * jitter,
      });
    }
  }
  // Keep only well-separated, road-adjacent spots not too close to a store.
  const chosen = [];
  for (const spot of spots) {
    if (inPark(spot.x, spot.y, 80)) continue;
    if (existing.some((e) => Math.hypot(e.x - spot.x, e.y - spot.y) < 380)) continue;
    if (chosen.some((e) => Math.hypot(e.x - spot.x, e.y - spot.y) < 420)) continue;
    chosen.push(spot);
    if (chosen.length >= 28) break;
  }
  const candidates = chosen.slice(0, 28).map((spot, i) => {
    const district = nearestDistrict(spot.x, spot.y);
    const centrality = Math.max(0, 1 - Math.hypot(spot.x - 2975, spot.y - 2975) / 4200);
    const rent = Math.round(260 + centrality * 720 + (district.id === 'ne' ? 130 : 0) + rand() * 160);
    const format = pick(rand, ['街边标准店', '社区店', '公园店', '写字楼店']);
    const size = Math.round(150 + rand() * 230);
    return {
      id: `c-${String(i + 1).padStart(2, '0')}`,
      name: candidateName(spot.r, spot.c, ['口', '街角', '东侧', '西侧'][i % 4]),
      x: Math.round(spot.x),
      y: Math.round(spot.y),
      district: district.id,
      districtName: district.name,
      sizeSqm: size,
      capacityVisitsPerWeek: Math.round(2600 + size * 11 + rand() * 1600),
      appeal: Number((0.88 + rand() * 0.22).toFixed(2)),
      weeklyRentIndex: rent,
      format,
      tenure: pick(rand, ['3+3 年', '5 年', '5+3 年']),
      note: rent > 800 ? '核心区位，租约成本较高。' : '租金相对温和，需求密度一般。',
    };
  });
  return {
    meta: {
      name: '候选点位池',
      unit: 'weeklyRentIndex = 每百元周租指数（内部相对口径）',
      disclaimer: '候选点位、租金指数与容量均为虚构，仅用于组合比较。',
      count: candidates.length,
    },
    candidates,
  };
}

export function buildDataset() {
  const network = buildNetwork();
  const demand = buildDemand();
  const stores = buildStores();
  const candidates = buildCandidates();
  return { network, demand, stores, candidates };
}

export function makeRoadNetwork(networkJson) {
  return new RoadNetwork(networkJson.nodes, networkJson.edges, networkJson.meta);
}
