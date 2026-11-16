/* 云澜选址实验室 front-end. Zero dependencies; talks to the local JSON API. */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const fmt = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
const pct = (v, digits = 1) => (v == null ? '—' : `${(v * 100).toFixed(digits)}%`);
const num = (v, digits = 0) => (v == null || Number.isNaN(v) ? '—' : v.toLocaleString('zh-CN', { maximumFractionDigits: digits }));
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  meta: null,
  data: null,
  selected: new Set(),
  placement: {},
  originalPlacement: {},
  period: 25,
  layer: 'overlap',
  evaluation: null,
  previewSeq: 0,
  optimize: null,
  scenarios: [],
  backtest: null,
  tasks: [],
  compare: new Set(),
  goal: { k: 2, weightCoverage: 0.6, weightOverlap: 0.4 },
  taskPoll: null,
  activeTab: 'scenario',
  mapView: { x: 0, y: 0, w: 6000 },
  dragging: null,
  hover: null,
  filters: { district: 'all', sort: 'name' },
  overlayVisibility: { demand: true, candidates: true, stores: true, labels: true },
};

/* ---------- API ---------- */
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { error: text }; }
  if (!res.ok) {
    const err = new Error(payload?.error ?? `请求失败 (${res.status})`);
    err.payload = payload;
    err.status = res.status;
    throw err;
  }
  return payload;
}

function toast(message, kind = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 3200);
}

/* ---------- boot ---------- */
async function boot() {
  try {
    const [meta, data, scenarios, backtest, tasks] = await Promise.all([
      api('/api/meta'), api('/api/data'), api('/api/scenarios'), api('/api/backtest'), api('/api/tasks'),
    ]);
    state.meta = meta;
    state.data = data;
    state.scenarios = scenarios.scenarios;
    state.backtest = backtest;
    state.tasks = tasks.tasks;
    state.period = Math.max(...data.stores.meta.periods.labels.map((_, i) => i + 1)) + 1;
    buildStaticUi();
    renderAll();
    startPolling();
  } catch (err) {
    console.error(err);
    document.body.insertAdjacentHTML('afterbegin', `<div class="banner" style="background:var(--danger-soft)">初始化失败：${escapeHtml(err.message)}</div>`);
  }
}

function buildStaticUi() {
  const districts = state.meta.districts;
  $('#district-filter').innerHTML = `<option value="all">全部片区</option>${districts.map((d) => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join('')}`;
  const periods = state.data.stores.meta.periods;
  const options = [];
  for (let p = periods.current + 1; p <= periods.current + 6; p++) options.push(`<option value="${p}">${periodLabel(p)}（预测第 ${p} 期）</option>`);
  for (let p = periods.current; p >= periods.current - 11; p--) options.push(`<option value="${p}">${periodLabel(p)}（历史第 ${p} 期）</option>`);
  $('#period-select').innerHTML = options.join('');
  $('#period-select').value = String(state.period);
  $('#revision-presets').innerHTML = state.meta.revisionPresets.map((p) => `
    <button class="rev-btn" data-revision="${p.id}" title="${escapeHtml(p.description)}">
      <b>${escapeHtml(p.label)}</b><span class="hint">${escapeHtml(p.description)}</span>
    </button>`).join('');
  $$('.seg').forEach((b) => b.addEventListener('click', () => {
    $$('.seg').forEach((x) => x.classList.toggle('active', x === b));
    state.layer = b.dataset.layer;
    renderMap();
    renderLegend();
  }));
  $$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
  $$('[data-goto]').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.goto)));
  $('#w-coverage').addEventListener('input', () => {
    state.goal.weightCoverage = Number($('#w-coverage').value) / 100;
    state.goal.weightOverlap = 1 - state.goal.weightCoverage;
    $('#w-overlap').value = String(Math.round(state.goal.weightOverlap * 100));
    updateWeightLabels();
    if (state.optimize) $('#run-optimize').dataset.dirty = '1';
  });
  $('#w-overlap').addEventListener('input', () => {
    state.goal.weightOverlap = Number($('#w-overlap').value) / 100;
    state.goal.weightCoverage = 1 - state.goal.weightOverlap;
    $('#w-coverage').value = String(Math.round(state.goal.weightCoverage * 100));
    updateWeightLabels();
    if (state.optimize) $('#run-optimize').dataset.dirty = '1';
  });
  $('#k-select').addEventListener('change', (e) => { state.goal.k = Number(e.target.value); });
  $('#period-select').addEventListener('change', (e) => {
    state.period = Number(e.target.value);
    schedulePreview();
  });
  $('#district-filter').addEventListener('change', (e) => { state.filters.district = e.target.value; renderCandidateList(); });
  $('#sort-filter').addEventListener('change', (e) => { state.filters.sort = e.target.value; renderCandidateList(); });
  $('#reload-data').addEventListener('click', () => location.reload());
  $('#reset-view').addEventListener('click', () => { state.mapView = { x: 0, y: 0, w: 6000 }; renderMap(); });
  $('#run-optimize').addEventListener('click', runOptimize);
  $('#run-backtest').addEventListener('click', runBacktest);
  $('#save-scenario').addEventListener('click', saveScenario);
  $('#revert-placement').addEventListener('click', revertPlacement);
  $('#clear-compare').addEventListener('click', () => { state.compare.clear(); renderCompare(); });
  $('#revision-presets').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-revision]');
    if (btn) applyRevision(btn.dataset.revision);
  });
  updateWeightLabels();
  setupMapInteractions();
}

function updateWeightLabels() {
  $('#w-coverage-label').textContent = `${Math.round(state.goal.weightCoverage * 100)}%`;
  $('#w-overlap-label').textContent = `${Math.round(state.goal.weightOverlap * 100)}%`;
}

function periodLabel(p) {
  const start = new Date(Date.UTC(2024, 11, 1));
  const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + (p - 1), 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function switchTab(name) {
  state.activeTab = name;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.tab-body').forEach((b) => b.classList.toggle('active', b.id === `tab-${name}`));
  if (name === 'tasks') renderTasks();
}

/* ---------- candidate selection ---------- */
function selectedCandidates() {
  return state.data.candidates.candidates.filter((c) => state.selected.has(c.id));
}

function currentPlacement(candidate) {
  return { ...candidate, ...(state.placement[candidate.id] ?? {}) };
}

function toggleCandidate(id, on) {
  if (on) state.selected.add(id); else state.selected.delete(id);
  renderCandidateList();
  renderMap();
  schedulePreview();
}

function renderCandidateList() {
  const all = state.data.candidates.candidates;
  const district = state.filters.district;
  const sort = state.filters.sort;
  let list = all.filter((c) => district === 'all' || c.district === district);
  list = [...list].sort((a, b) => {
    if (sort === 'rent') return b.weeklyRentIndex - a.weeklyRentIndex;
    if (sort === 'capacity') return b.capacityVisitsPerWeek - a.capacityVisitsPerWeek;
    if (sort === 'district') return a.district.localeCompare(b.district) || a.name.localeCompare(b.name);
    return a.name.localeCompare(b.name, 'zh-CN');
  });
  const accessById = new Map((state.evaluation?.perStore ?? []).map((s) => [s.id, s]));
  $('#candidate-list').innerHTML = list.map((c) => {
    const p = currentPlacement(c);
    const sel = state.selected.has(c.id);
    const moved = state.placement[c.id] != null;
    const store = accessById.get(c.id);
    return `
      <label class="candidate ${sel ? 'selected' : ''}" data-candidate="${c.id}">
        <input type="checkbox" ${sel ? 'checked' : ''} data-toggle="${c.id}" />
        <span>
          <span class="c-name">${escapeHtml(c.name)}</span>
          <span class="c-meta">${escapeHtml(c.districtName)} · ${escapeHtml(c.format)} · ${num(p.sizeSqm)} ㎡<br/>容量 ${num(p.capacityVisitsPerWeek)} 人次/周 · 租金指数 ${num(p.weeklyRentIndex)}${moved ? ' · 已移动' : ''}</span>
        </span>
        <span class="c-tag">${store ? `${num(store.afterVisits)} 人次/周` : `c-${c.id.replace('c-', '')}`}</span>
      </label>`;
  }).join('');
  $$('[data-toggle]').forEach((el) => el.addEventListener('change', (e) => {
    e.stopPropagation();
    toggleCandidate(e.target.dataset.toggle, e.target.checked);
  }));
  $$('.candidate').forEach((el) => el.addEventListener('click', (e) => {
    if (e.target.matches('input')) return;
    const id = el.dataset.candidate;
    focusCandidate(id);
  }));
  $('#selected-count').textContent = `${state.selected.size} 个已选`;
}

function focusCandidate(id) {
  const c = state.data.candidates.candidates.find((x) => x.id === id);
  if (!c) return;
  const p = currentPlacement(c);
  state.mapView = { x: p.x - 1800, y: p.y - 1800, w: 3600 };
  renderMap();
}

/* ---------- preview ---------- */
let previewTimer = null;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(refreshPreview, 180);
}

async function refreshPreview() {
  const seq = ++state.previewSeq;
  const selectedIds = [...state.selected];
  if (!selectedIds.length) {
    state.evaluation = null;
    renderScenarioPanel();
    renderMap();
    renderLegend();
    renderCandidateList();
    return;
  }
  try {
    $('#scenario-result').classList.add('loading');
    setTimeout(() => $('#scenario-result').classList.remove('loading'), 1200);
    const evaluation = await api('/api/scenarios/preview', {
      method: 'POST',
      body: { params: { selectedIds, placement: state.placement, period: state.period } },
    });
    if (seq !== state.previewSeq) return;
    state.evaluation = evaluation;
    renderScenarioPanel();
    renderMap();
    renderLegend();
    renderCandidateList();
  } catch (err) {
    if (seq !== state.previewSeq) return;
    toast(`试算失败：${err.message}`, 'error');
  }
}

/* ---------- scenarios ---------- */
async function saveScenario() {
  if (!state.selected.size) return toast('请先选择至少一个候选点', 'error');
  const name = prompt('方案名称', selectedCandidates().map((c) => c.name).join(' + '));
  if (name == null) return;
  try {
    await api('/api/scenarios', {
      method: 'POST',
      body: { name: name.trim(), params: { selectedIds: [...state.selected], placement: state.placement, period: state.period } },
    });
    await loadScenarios();
    toast('方案已保存并固定输入版本');
  } catch (err) {
    toast(`保存失败：${err.message}`, 'error');
  }
}

async function loadScenarios() {
  const res = await api('/api/scenarios');
  state.scenarios = res.scenarios;
  renderScenarioGrid();
}

function renderScenarioGrid() {
  const grid = $('#scenario-grid');
  if (!state.scenarios.length) {
    grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1"><p>还没有保存的方案。选择候选点后点击“保存方案”。</p></div>';
    return;
  }
  grid.innerHTML = state.scenarios.map((s) => {
    const m = s.summary ?? {};
    const stale = s.stale;
    const checked = state.compare.has(s.id);
    return `
      <article class="sc-card ${stale ? 'stale' : ''}" data-scenario="${s.id}">
        <div class="sc-head">
          <b>${escapeHtml(s.name)}</b>
          ${stale ? '<span class="stale-tag" title="输入版本已变化">过期</span>' : '<span class="ok-tag">当前输入</span>'}
        </div>
        <div class="sc-metrics">
          <span>新增增量 <b>${num(m.incrementalVisits)}</b></span>
          <span>覆盖 <b>${pct(m.coverageRatio)}</b></span>
          <span>分流旧店 <b>${num(m.cannibalizedExistingVisits)}</b></span>
          <span>重叠损失 <b>${num(m.overlapLossVisits)}</b></span>
        </div>
        <div class="hint mono">${escapeHtml(s.inputVersionKey.slice(0, 10))} · ${new Date(s.createdAt).toLocaleString('zh-CN')}</div>
        ${stale ? `<div class="hint">已变更：${s.changedInputs.map((c) => `${c.key} ${c.previous?.slice(0, 9) ?? '—'}→${c.current?.slice(0, 9) ?? '—'}`).join('，')}</div>` : ''}
        <div class="sc-actions">
          <button class="btn small ghost" data-load="${s.id}">载入</button>
          <button class="btn small ghost" data-compare="${s.id}">${checked ? '移出对比' : '加入对比'}</button>
          ${stale ? `<button class="btn small primary" data-relink="${s.id}">按新输入重算</button>` : ''}
          <button class="btn small ghost" data-delete="${s.id}">删除</button>
        </div>
      </article>`;
  }).join('');
  $$('[data-load]').forEach((b) => b.addEventListener('click', () => loadScenario(b.dataset.load)));
  $$('[data-compare]').forEach((b) => b.addEventListener('click', () => {
    if (state.compare.has(b.dataset.compare)) state.compare.delete(b.dataset.compare);
    else state.compare.add(b.dataset.compare);
    renderScenarioGrid();
    renderCompare();
  }));
  $$('[data-relink]').forEach((b) => b.addEventListener('click', () => relinkScenario(b.dataset.relink)));
  $$('[data-delete]').forEach((b) => b.addEventListener('click', () => deleteScenario(b.dataset.delete)));
}

async function loadScenario(id) {
  try {
    const res = await api(`/api/scenarios/${id}`);
    const s = res.scenario;
    state.selected = new Set(s.params.selectedIds);
    state.placement = JSON.parse(JSON.stringify(s.params.placement ?? {}));
    state.originalPlacement = JSON.parse(JSON.stringify(state.placement));
    state.period = s.params.period ?? state.period;
    $('#period-select').value = String(state.period);
    renderCandidateList();
    switchTab('scenario');
    await refreshPreview();
    if (s.stale) toast('方案已载入；其保存结果基于旧版本，当前显示按新输入重算的预览');
  } catch (err) {
    toast(`载入失败：${err.message}`, 'error');
  }
}

async function relinkScenario(id) {
  try {
    const res = await api(`/api/scenarios/${id}/relink`, { method: 'POST' });
    await loadScenarios();
    toast(`已按当前输入重算：${res.scenario.summary.incrementalVisits} 人次/周`);
  } catch (err) {
    toast(`重算失败：${err.message}`, 'error');
  }
}

async function deleteScenario(id) {
  if (!confirm('删除该方案？')) return;
  try {
    await api(`/api/scenarios/${id}`, { method: 'DELETE' });
    state.compare.delete(id);
    await loadScenarios();
    renderCompare();
  } catch (err) {
    toast(`删除失败：${err.message}`, 'error');
  }
}

function renderCompare() {
  const ids = [...state.compare];
  const bar = $('#compare-bar');
  if (!ids.length) { bar.hidden = true; return; }
  bar.hidden = false;
  const cards = ids.map((id) => state.scenarios.find((s) => s.id === id))
    .filter(Boolean)
    .sort((a, b) => (b.summary?.incrementalVisits ?? 0) - (a.summary?.incrementalVisits ?? 0));
  const max = Math.max(1, ...cards.map((c) => c.summary?.incrementalVisits ?? 0));
  $('#compare-chips').innerHTML = cards.map((c) => `
    <span class="chip" title="${escapeHtml(c.name)}">
      ${escapeHtml(c.name.slice(0, 14))}${c.stale ? ' ⚠' : ''}
      <b>${num(c.summary?.incrementalVisits)}</b>
      <span class="hint" style="color:#cfd8d1">增量</span>
      <button data-uncompare="${c.id}" aria-label="移出对比">×</button>
    </span>`).join('') + `<span class="hint" style="color:#aab8b0">按新增增量排序，非收入；最高 ${num(max)} 人次/周</span>`;
  $$('[data-uncompare]').forEach((b) => b.addEventListener('click', () => {
    state.compare.delete(b.dataset.uncompare);
    renderCompare();
    renderScenarioGrid();
  }));
}

/* ---------- scenario panel ---------- */
function renderScenarioPanel() {
  const e = state.evaluation;
  const empty = !e;
  $('#scenario-empty').hidden = !empty;
  $('#scenario-result').hidden = empty;
  if (empty) {
    $('#scenario-title').textContent = '未选候选';
    $('#scenario-subtitle').textContent = '在左侧勾选候选点，或从组合搜索中载入方案。';
    return;
  }
  const names = e.perStore.filter((s) => s.kind === 'candidate').map((s) => s.name);
  $('#scenario-title').textContent = names.length > 1 ? `${names.length} 个候选组合` : names[0] ?? '空方案';
  $('#scenario-subtitle').textContent = `${periodLabel(e.period)} · ${e.params.selectedIds.length} 个新点 · ${signed(e.impact.accessCoverageGain * 100)} 可达覆盖率变化 · 输入 ${e.inputVersionKey.slice(0, 10)}`;
  const imp = e.impact;
  const kpis = [
    { label: '新店到访', value: num(imp.newStoreVisits), sub: '含从旧店转移的部分', cls: '' },
    { label: '真实增量', value: num(imp.incrementalVisits), sub: `独立预测相加 = ${num(imp.additiveNaiveIncremental)}`, cls: 'good' },
    { label: '重叠损失', value: num(imp.overlapLossVisits), sub: `占独立预测 ${pct(imp.overlapLossRatio)}`, cls: 'warn' },
    { label: '分流旧店', value: num(imp.cannibalizedExistingVisits), sub: '新店竞争导致旧店减少', cls: 'warn' },
    { label: `可达覆盖（≤${e.impact.accessMinutes} 分钟）`, value: pct(imp.accessCoverage), sub: `基线 ${pct(imp.baselineAccessCoverage)}`, cls: '' },
    { label: '容量约束', value: e.capacityPressure.bindingStoreIds.length ? `${e.capacityPressure.bindingStoreIds.length} 个触顶` : '不绑定', sub: `回溢 ${num(imp.capacityOverflowVisits)} 人次/周`, cls: e.capacityPressure.bindingStoreIds.length ? 'warn' : '' },
    { label: '新增增量 / 租金指数', value: num(imp.incrementalVisitsPerRentIndex, 2), sub: `租金指数合计 ${num(imp.rentIndexTotal)}`, cls: '' },
    { label: '未服务需求', value: num(imp.unmetVisits), sub: `在 ${e.model.cutoffMinutes} 分钟圈层外不计`, cls: '' },
  ];
  $('#kpi-grid').innerHTML = kpis.map((k) => `
    <div class="kpi ${k.cls}"><div class="k-label">${k.label}</div>
      <div class="k-value">${k.value}</div><div class="k-sub">${k.sub}</div></div>`).join('');
  $('#impact-callout').className = 'callout';
  $('#impact-callout').innerHTML = imp.overlapLossVisits > 0
    ? `不能把各候选点单独预测后相加：独立预测合计 <strong>${num(imp.additiveNaiveIncremental)}</strong>，并入同一组合后净增量只有 <strong>${num(imp.incrementalVisits)}</strong>，差额 <strong>${num(imp.overlapLossVisits)}</strong>（${pct(imp.overlapLossRatio)}）来自候选点之间的重复服务与对旧店的分流。`
    : `当前组合未检测到明显重复服务；仍应以组合结果而非单点相加为准。${e.model.capacityRespected ? '' : '（容量约束已关闭，结果偏乐观。）'}`;

  const rows = e.perStore.map((s) => `
    <tr class="${s.kind === 'candidate' ? 'cand' : ''} ${s.capacityBinding ? 'binding' : ''}">
      <td>${escapeHtml(s.name)}</td>
      <td>${num(s.afterVisits)}</td>
      <td>${s.kind === 'existing' ? signed(-s.cannibalizedVisits) : signed(s.deltaVisits)}</td>
      <td>${s.capacityVisitsPerWeek ? pct(s.utilization, 0) : '—'}</td>
      <td>${s.kind === 'candidate' ? num(s.standaloneVisits) : '—'}</td>
    </tr>`).join('');
  $('#store-table').innerHTML = `
    <thead><tr><th>门店</th><th>组合后到访</th><th>变化</th><th>容量利用</th><th>单店独立</th></tr></thead>
    <tbody>${rows}</tbody>`;

  const pairs = e.overlapPairs ?? [];
  const newShare = imp.newStoreVisits > 0 ? pairs.reduce((a, p) => a + p.sharedVisits, 0) / imp.newStoreVisits : 0;
  const cannShare = imp.baselineExistingVisits > 0 ? imp.cannibalizedExistingVisits / imp.baselineExistingVisits : 0;
  const splitNote = `<p class="hint" style="margin-bottom:6px">新店间共享占新店到访 <b>${pct(newShare)}</b>；旧店被分流占其基线到访 <b>${pct(cannShare)}</b>。两部分不能相加成收入损失。</p>`;
  $('#overlap-pairs').innerHTML = splitNote + (pairs.length
    ? pairs.map((p) => {
      const a = e.perStore.find((s) => s.id === p.a);
      const b = e.perStore.find((s) => s.id === p.b);
      const width = Math.min(1, p.ratioOfSmaller) * 100;
      return `<div class="overlap-row">
        <div><b>${escapeHtml(a?.name ?? p.a)}</b> ↔ <b>${escapeHtml(b?.name ?? p.b)}</b>
          <div class="bar"><i style="width:${width.toFixed(1)}%"></i></div></div>
        <div style="text-align:right">${num(p.sharedVisits)}<br/><span class="hint">占较小店 ${pct(p.ratioOfSmaller)}</span></div>
      </div>`;
    }).join('')
    : '<p class="hint">仅一个候选点，无新店之间重叠；仍需关注对旧店的分流。</p>');

  const u = e.uncertainty;
  $('#uncertainty-card').innerHTML = u ? `
    <div class="version-card">
      <div class="version-row"><span>净增量区间（P10–P90）</span><b>${num(u.incremental.p10)} – ${num(u.incremental.p90)}</b></div>
      <div class="version-row"><span>中位（P50）</span><b>${num(u.incremental.p50)}</b></div>
      <div class="version-row"><span>为正的概率</span><b>${pct(u.probPositive)}</b></div>
      <div class="version-row"><span>模拟次数 / 需求σ / 吸引力σ</span><b>${u.draws} / ${u.assumptions.demandSigma} / ${u.assumptions.appealSigma}</b></div>
      <p class="hint" style="margin-top:4px">${escapeHtml(u.assumptions.note)}</p>
    </div>` : '<p class="hint">未包含模拟。</p>';
  $('#scenario-warnings').innerHTML = (e.warnings ?? []).map((w) => `<li>${escapeHtml(w)}</li>`).join('') || '<li>无额外警告。</li>';
  $('#revert-placement').hidden = Object.keys(state.placement).length === 0;
  if (state.originalPlacement == null) state.originalPlacement = {};
}

function signed(v, digits = 0) {
  if (v == null) return '—';
  const s = v > 0 ? '+' : '';
  return `${s}${num(v, digits)}`;
}

/* ---------- map ---------- */
function mapEl(name, attrs = {}, children = '') {
  const a = Object.entries(attrs).filter(([, v]) => v != null).map(([k, v]) => `${k}="${escapeHtml(v)}"`).join(' ');
  return `<${name} ${a}>${children}</${name}>`;
}

const NS = 'http://www.w3.org/2000/svg';

function renderMap() {
  const svg = $('#map');
  const data = state.data;
  if (!data) return;
  const view = state.mapView;
  svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.w}`);
  const nodes = new Map(data.network.nodes.map((n) => [n.id, n]));
  const paths = [];
  // river & park backdrops
  const river = data.network.meta.river;
  const park = data.network.meta.park;
  let inner = '';
  inner += `<rect class="river-shape" x="${river.x0}" y="${river.y0}" width="${river.x1 - river.x0}" height="${river.y1 - river.y0}" />`;
  inner += `<rect class="park-shape" x="${park.x0}" y="${park.y0}" width="${park.x1 - park.x0}" height="${park.y1 - park.y0}" rx="60" />`;
  inner += `<text class="axis-label" x="${park.x0 + 120}" y="${park.y0 + 360}">中央公园</text>`;
  inner += `<text class="axis-label" x="4830" y="150" transform="rotate(90 4830 150)">澜川河</text>`;

  // edges, coloured by class; revised additions marked dashed
  for (const e of data.network.edges) {
    const a = nodes.get(e.from);
    const b = nodes.get(e.to);
    if (!a || !b) continue;
    const cls = e.class === 'bridge' ? 'bridge' : e.class;
    const isNew = !['street', 'arterial', 'ring', 'expressway', 'bridge'].includes(cls) || (e.name === '公园横路');
    inner += `<line class="edge ${cls} ${isNew ? 'new' : ''}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" />`;
  }

  // access bands / overlap heat per demand point
  const heat = buildDemandOverlay();
  inner += heat;

  // demand points
  if (state.overlayVisibility.demand) {
    for (const p of data.demand.points) {
      inner += `<circle class="demand-dot" cx="${p.x}" cy="${p.y}" r="${Math.max(18, Math.sqrt(p.weeklyDemand) * 2.2)}" data-demand="${p.id}"><title>${escapeHtml(`${p.id} · ${p.districtName} · ${p.weeklyDemand} 人次/周`)}</title></circle>`;
    }
  }

  // existing stores
  const evalByName = new Map((state.evaluation?.perStore ?? []).map((s) => [s.id, s]));
  for (const s of data.stores.stores) {
    const open = isOpen(s, state.period);
    const ev = evalByName.get(s.id);
    const title = ev
      ? `${s.name}｜组合后 ${num(ev.afterVisits)}｜分流 ${num(ev.cannibalizedVisits)}｜容量 ${num(s.capacityVisitsPerWeek)}`
      : `${s.name}｜${open ? '营业中' : '未营业'}｜容量 ${num(s.capacityVisitsPerWeek)}`;
    inner += `<g class="store ${open ? 'existing' : 'closed'}" data-store="${s.id}" transform="translate(${s.x} ${s.y})">
      <circle r="${open ? 90 : 70}"></circle>
      ${state.overlayVisibility.labels ? `<text x="118" y="28">${escapeHtml(s.name)}${open ? '' : '（关）'}</text>` : ''}
      <title>${escapeHtml(title)}</title>
    </g>`;
    if (state.layer === 'cannibal' && ev && ev.cannibalizedVisits > 0) {
      const r = Math.min(950, 220 + Math.sqrt(ev.cannibalizedVisits) * 9);
      inner += `<circle class="circle-band" cx="${s.x}" cy="${s.y}" r="${r}" stroke="var(--warn)" stroke-width="4" />`;
    }
  }

  // candidates
  for (const c of data.candidates.candidates) {
    if (!state.overlayVisibility.candidates && !state.selected.has(c.id)) continue;
    const p = currentPlacement(c);
    const sel = state.selected.has(c.id);
    const moved = state.placement[c.id] != null;
    const ev = evalByName.get(c.id);
    const title = sel && ev
      ? `${c.name}｜到访 ${num(ev.afterVisits)}｜容量利用 ${pct(ev.utilization, 0)}`
      : `${c.name}｜${c.districtName}｜租金指数 ${num(p.weeklyRentIndex)}｜容量 ${num(p.capacityVisitsPerWeek)}`;
    inner += `<g class="candidate-dot ${sel ? 'selected' : ''} ${moved ? 'moved' : ''}" data-candidate-dot="${c.id}" transform="translate(${p.x} ${p.y})">
      <circle r="${sel ? 105 : 62}"></circle>
      ${state.overlayVisibility.labels && (sel || state.mapView.w < 3800) ? `<text x="92" y="24">${escapeHtml(c.name)}</text>` : ''}
      <title>${escapeHtml(title)}</title>
    </g>`;
    if (sel) {
      const accessRadius = estimateAccessRadius(p);
      inner += `<circle class="circle-band" cx="${p.x}" cy="${p.y}" r="${accessRadius}" stroke="var(--accent)" stroke-width="3.5" />`;
    }
  }
  svg.innerHTML = inner;
  renderLegend();
  renderMapFooter();
  bindMapSvgEvents();
}

function isOpen(store, period) {
  return period >= (store.openedPeriod ?? -Infinity) && period < (store.closedPeriod ?? Infinity);
}

function estimateAccessRadius(p) {
  // 8 minutes at ~20 km/h mixed network + walk; purely illustrative circle.
  return 2400;
}

function buildDemandOverlay() {
  const e = state.evaluation;
  if (!e) return '';
  const perDemand = e.proposed?.perDemand ?? e.perDemand ?? [];
  const byId = new Map(perDemand.map((d) => [d.id, d]));
  const overlapById = new Map((e.overlapByDemand ?? []).map((d) => [d.id, d]));
  const heatMax = Math.max(1, ...(e.overlapByDemand ?? []).map((d) => d.sharedVisits));
  let out = '';
  for (const p of state.data.demand.points) {
    const row = byId.get(p.id);
    if (!row) continue;
    if (state.layer === 'overlap') {
      const ov = overlapById.get(p.id);
      const value = ov?.sharedVisits ?? 0;
      if (value <= 0.5) continue;
      const alpha = 0.12 + 0.62 * Math.min(1, value / heatMax);
      const r = Math.max(34, Math.sqrt(p.weeklyDemand) * 2.6);
      out += `<circle class="overlap-cell" cx="${p.x}" cy="${p.y}" r="${r}" fill="#c46a12" opacity="${alpha.toFixed(3)}"><title>${escapeHtml(`${p.id} 重叠 ${num(value)} 人次/周`)}</title></circle>`;
    } else if (state.layer === 'access') {
      const unmet = row.unmet ?? row.unmetVisits ?? 0;
      const dist = Math.min(1, unmet / Math.max(1, row.weight));
      if (dist <= 0.001) continue;
      out += `<circle class="overlap-cell" cx="${p.x}" cy="${p.y}" r="${Math.max(30, Math.sqrt(p.weeklyDemand) * 2.4)}" fill="#9a3b2e" opacity="${(0.1 + 0.55 * dist).toFixed(3)}"><title>${escapeHtml(`${p.id} 未分配 ${num(unmet)} 人次/周`)}</title></circle>`;
    } else {
      // cannibalization layer colours demand points by share served by candidates
      const top = overlapById.get(p.id);
      if (!top || top.newStoreVisits <= 0) continue;
      const alpha = 0.08 + 0.5 * Math.min(1, top.newStoreVisits / Math.max(1, p.weeklyDemand));
      out += `<circle class="overlap-cell" cx="${p.x}" cy="${p.y}" r="${Math.max(28, Math.sqrt(p.weeklyDemand) * 2.2)}" fill="#2b5f8a" opacity="${alpha.toFixed(3)}"><title>${escapeHtml(`${p.id} 新店承接 ${num(top.newStoreVisits)} 人次/周`)}</title></circle>`;
    }
  }
  return out;
}

function renderLegend() {
  const legends = {
    overlap: [
      ['#c46a12', '两新店共享到访（热度越高越重叠）'],
      ['#1f6f5c', '已选候选点'],
      ['#2b5f8a', '现有营业门店'],
      ['#a8a294', '已关闭/未营业'],
    ],
    access: [
      ['#9a3b2e', '容量或圈层导致未服务需求'],
      ['#1f6f5c', '已选候选点的 8 分钟示意圈'],
    ],
    cannibal: [
      ['#2b5f8a', '新店承接的到访'],
      ['#a45a12', '现有店被分流量（圈半径）'],
    ],
  };
  $('#map-legend').innerHTML = legends[state.layer].map(([c, label]) => `<span class="legend-item"><i class="legend-swatch" style="background:${c}"></i>${escapeHtml(label)}</span>`).join('');
}

function renderMapFooter() {
  const e = state.evaluation;
  const access = state.data.accessSummary;
  $('#map-caption').textContent = e
    ? `路网平均绕行 ${access.meanCircuityRatio}× 直线；平均车行 ${access.meanNetworkMinutes} 分钟，直线近似仅 ${access.meanStraightLineMinutes} 分钟。`
    : `路网平均行程 ${access.meanNetworkMinutes} 分钟；直线近似 ${access.meanStraightLineMinutes} 分钟（低估绕行）。`;
  $('#map-scale').textContent = `视窗 ${(state.mapView.w / 1000).toFixed(1)} km · 网格 850 m`;
}

function setupMapInteractions() {
  const svg = $('#map');
  const wrap = $('#map-wrap');
  let pan = null;
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = svg.getBoundingClientRect();
    const scale = e.deltaY > 0 ? 1.18 : 0.85;
    const w = Math.min(9000, Math.max(1300, state.mapView.w * scale));
    const k = w / state.mapView.w;
    const mx = state.mapView.x + ((e.clientX - rect.left) / rect.width) * state.mapView.w;
    const my = state.mapView.y + ((e.clientY - rect.top) / rect.height) * state.mapView.w;
    state.mapView = { x: mx - (mx - state.mapView.x) * k, y: my - (my - state.mapView.y) * k, w };
    renderMap();
  }, { passive: false });

  svg.addEventListener('pointerdown', (e) => {
    const candGroup = e.target.closest('[data-candidate-dot]');
    if (candGroup) {
      const id = candGroup.dataset.candidateDot;
      const c = state.data.candidates.candidates.find((x) => x.id === id);
      if (c) {
        state.dragging = { id, startX: e.clientX, startY: e.clientY, origin: currentPlacement(c), moved: false };
        svg.setPointerCapture(e.pointerId);
        svg.classList.add('dragging');
      }
      return;
    }
    pan = { x: e.clientX, y: e.clientY, vx: state.mapView.x, vy: state.mapView.y };
    svg.setPointerCapture(e.pointerId);
    svg.classList.add('dragging');
  });

  svg.addEventListener('pointermove', (e) => {
    if (state.dragging) {
      const rect = svg.getBoundingClientRect();
      const dxUser = ((e.clientX - state.dragging.startX) / rect.width) * state.mapView.w;
      const dyUser = ((e.clientY - state.dragging.startY) / rect.height) * state.mapView.w;
      if (Math.hypot(dxUser, dyUser) < 12) return;
      state.dragging.moved = true;
      const id = state.dragging.id;
      const c = state.data.candidates.candidates.find((x) => x.id === id);
      const x = clamp(state.dragging.origin.x + dxUser, 200, 5400);
      const y = clamp(state.dragging.origin.y + dyUser, 200, 5400);
      state.placement[id] = { ...(state.placement[id] ?? {}), x: Math.round(x), y: Math.round(y) };
      renderMap();
      showTooltip(e, `${c.name}<br/>拖动至 (${Math.round(x)}, ${Math.round(y)})<br/><span class="hint">松开后重新计算可达性</span>`);
      return;
    }
    if (pan) {
      const rect = svg.getBoundingClientRect();
      const dx = ((e.clientX - pan.x) / rect.width) * state.mapView.w;
      const dy = ((e.clientY - pan.y) / rect.height) * state.mapView.w;
      state.mapView = { ...state.mapView, x: pan.vx - dx, y: pan.vy - dy };
      renderMap();
      return;
    }
    const t = e.target.closest('[data-candidate-dot],[data-store],[data-demand]');
    if (t) showTooltip(e, t.querySelector('title')?.textContent ?? '');
    else hideTooltip();
  });

  svg.addEventListener('pointerup', (e) => {
    if (state.dragging) {
      const drag = state.dragging;
      state.dragging = null;
      svg.classList.remove('dragging');
      if (drag.moved) {
        schedulePreview();
        toast('候选点坐标已调整，正在重算路网可达性');
      } else {
        const id = drag.id;
        toggleCandidate(id, !state.selected.has(id));
      }
      return;
    }
    pan = null;
    svg.classList.remove('dragging');
  });

  svg.addEventListener('pointerleave', () => hideTooltip());
  wrap.addEventListener('mouseleave', () => hideTooltip());
}

function bindMapSvgEvents() {
  // Re-bind after innerHTML replacement (title hover is native; only click focus needed).
  $$('[data-candidate-dot]').forEach((el) => {
    el.style.cursor = 'pointer';
  });
}

function showTooltip(e, text) {
  const tip = $('#map-tooltip');
  tip.innerHTML = text;
  tip.hidden = false;
  const rect = $('#map-wrap').getBoundingClientRect();
  const x = Math.min(e.clientX - rect.left, rect.width - 270);
  const y = Math.min(e.clientY - rect.top, rect.height - 90);
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}

function hideTooltip() { $('#map-tooltip').hidden = true; }

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function revertPlacement() {
  state.placement = {};
  renderCandidateList();
  renderMap();
  schedulePreview();
  toast('已恢复候选点初始坐标');
}

/* ---------- optimize ---------- */
async function runOptimize() {
  const btn = $('#run-optimize');
  btn.disabled = true;
  btn.textContent = '提交搜索…';
  try {
    const res = await api('/api/optimize', {
      method: 'POST',
      body: { goal: state.goal, period: state.period, placement: state.placement },
    });
    toast('组合搜索已排队；完成后可在此查看');
    await refreshTasks();
    switchTab('optimize');
    $('#opt-result').innerHTML = `<div class="empty-state"><p>搜索运行中（任务 ${escapeHtml(res.task.id)}）。本页会自动更新。</p></div>`;
    watchTask(res.task.id, async (task) => {
      if (task.status === 'done' && task.result?.id) {
        const doc = await api(`/api/optimizations/${task.result.id}`);
        state.optimize = doc;
        renderOptimize();
        toast('组合搜索完成');
      } else if (task.status === 'error') {
        $('#opt-result').innerHTML = `<div class="empty-state"><p>搜索失败：${escapeHtml(task.error ?? '未知错误')}</p></div>`;
      } else if (task.status === 'interrupted') {
        $('#opt-result').innerHTML = `<div class="empty-state"><p>搜索被服务重启中断，可在“任务”页恢复。</p></div>`;
      }
    });
  } catch (err) {
    toast(`搜索提交失败：${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '搜索候选组合';
  }
}

function renderOptimize() {
  const o = state.optimize;
  if (!o) return;
  $('#opt-result').className = '';
  $('#opt-search-note').textContent = `${o.combosEvaluated} 组合 · ${o.poolTruncated ? '筛后枚举' : '全枚举'}`;
  const rec = o.recommended;
  const recNames = rec ? rec.selected.map((s) => `${escapeHtml(s.name)}（${num(s.assignedVisits)}）`).join(' + ') : '无可行组合';
  const top = o.top ?? [];
  $('#opt-result').innerHTML = `
    ${rec ? `
    <div class="opt-card">
      <h3>推荐：${escapeHtml(rec.ids.join(' + '))}</h3>
      <p class="hint">${recNames}</p>
      <div class="opt-metrics">
        <span>可达覆盖</span><b>${pct(rec.accessCoverage)}</b>
        <span>重复服务指数</span><b>${pct(rec.overlapShare)}</b>
        <span>净增量</span><b>${num(rec.incrementalVisits)}</b>
        <span>租金指数</span><b>${num(rec.rentIndexTotal)}</b>
        <span>旧店分流</span><b>${num(rec.cannibalizedExistingVisits)}</b>
        <span>目标得分</span><b>${rec.goalScore}</b>
      </div>
      <div class="row-actions" style="margin-top:8px">
        <button class="btn small primary" id="load-recommended">载入该组合</button>
      </div>
    </div>` : '<div class="empty-state"><p>当前约束下没有可行组合。</p></div>'}
    <div class="section-title">Pareto 前沿（覆盖↑ / 重复服务↓ / 租金↓）</div>
    <div style="overflow:auto">
      <table class="frontier-table">
        <thead><tr><th>组合</th><th>可达覆盖</th><th>重复服务</th><th>新店重叠</th><th>分流占比</th><th>净增量</th><th>租金</th><th>得分</th></tr></thead>
        <tbody>
          ${o.frontier.map((f) => `<tr data-combo="${f.ids.join(',')}">
            <td>${escapeHtml(f.ids.join('+'))}</td><td>${pct(f.accessCoverage)}</td><td>${pct(f.overlapShare)}</td>
            <td>${pct(f.newStoreOverlapShare)}</td><td>${pct(f.cannibalizationShare)}</td>
            <td>${num(f.incrementalVisits)}</td><td>${num(f.rentIndexTotal)}</td><td>${f.goalScore}</td></tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div class="section-title">目标权重的作用</div>
    <div class="callout ${o.goalConflict ? '' : 'warn'}" style="margin-bottom:8px">${escapeHtml(o.goalConflictNote)}</div>
    <p class="hint">${escapeHtml(o.goal.weightCoverage)} 权重给覆盖、${escapeHtml(o.goal.weightOverlap)} 给重复服务。重复服务 = 新店之间期望共享到访占比与旧店被分流占比各占一半；前沿上的点互不支配，想同时提高覆盖并降低重复服务只能换点或改变开店数。</p>
    <div class="section-title">候选入选项率（前 20 组合）</div>
    <div class="overlap-list">
      ${o.inclusionFrequency.slice(0, 8).map((x) => `<div class="overlap-row"><div>${escapeHtml(x.name)} <span class="hint">${escapeHtml(x.id)}</span><div class="bar"><i style="width:${(x.shareOfTop20 * 100).toFixed(1)}%;background:var(--accent)"></i></div></div><div>${x.count}/20</div></div>`).join('')}
    </div>
    <div class="section-title">搜索说明</div>
    <p class="hint">${escapeHtml(o.searchNote)}</p>
    <ul class="warnings">${(o.warnings ?? []).map((w) => `<li>${escapeHtml(w)}</li>`).join('') || '<li>无约束警告。</li>'}</ul>
    <p class="hint" style="margin-top:8px">${escapeHtml(o.disclaimer)}</p>`;
  const loadBtn = $('#load-recommended');
  if (loadBtn && rec) {
    loadBtn.addEventListener('click', () => {
      state.selected = new Set(rec.ids);
      renderCandidateList();
      refreshPreview();
      switchTab('scenario');
    });
  }
  $$('[data-combo]').forEach((tr) => tr.addEventListener('click', () => {
    state.selected = new Set(tr.dataset.combo.split(','));
    renderCandidateList();
    refreshPreview();
    switchTab('scenario');
  }));
}

async function runBacktest() {
  const btn = $('#run-backtest');
  btn.disabled = true;
  try {
    const res = await api('/api/backtest/run', { method: 'POST', body: {} });
    toast('回测已排队');
    await refreshTasks();
    watchTask(res.task.id, async (task) => {
      if (task.status === 'done') {
        state.backtest = await api('/api/backtest');
        renderBacktest();
        toast('回测完成');
      }
    });
  } catch (err) {
    toast(`回测提交失败：${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

function renderBacktest() {
  const b = state.backtest;
  if (!b?.present) {
    $('#backtest-fresh-note').innerHTML = '';
    $('#backtest-content').innerHTML = '<div class="empty-state"><p>尚无回测报告。点击“运行隔离回测”。</p><p class="hint">协议：空间 5 折 + 时间外推 + 缓冲带剔除。</p></div>';
    return;
  }
  const m = b.metrics;
  const naive = b.leakageDiagnostic?.metrics;
  $('#backtest-fresh-note').innerHTML = b.fresh
    ? `<div class="bt-note ok">${escapeHtml(b.reason)}。报告 ${escapeHtml(b.id)}。</div>`
    : `<div class="bt-note"><b>回测已过期。</b>${escapeHtml(b.reason)}。下方数字仍对应旧输入版本 ${escapeHtml(b.inputVersionKey?.slice(0, 10))}，不能冒充当前数据。</div>`;
  const folds = b.folds ?? [];
  $('#backtest-content').className = '';
  $('#backtest-content').innerHTML = `
    <div class="bt-grid">
      <div class="kpi"><div class="k-label">WAPE</div><div class="k-value">${pct(m.wape)}</div><div class="k-sub">空间+时间隔离</div></div>
      <div class="kpi"><div class="k-label">偏差</div><div class="k-value">${pct(m.bias)}</div><div class="k-sub">预测−观测 / 观测</div></div>
      <div class="kpi"><div class="k-label">MAE</div><div class="k-value">${num(m.mae, 1)}</div><div class="k-sub">人次/周·单元格</div></div>
      <div class="kpi"><div class="k-label">验证单元格</div><div class="k-value">${num(m.n)}</div><div class="k-sub">观测 ${num(m.observedVisits)}</div></div>
    </div>
    <div class="bt-note ${b.fresh ? 'ok' : ''}">
      协议：${escapeHtml(b.protocol.description)}
    </div>
    <div class="section-title">逐折结果</div>
    <table class="bt-folds">
      <thead><tr><th>折</th><th>验证点</th><th>训练点</th><th>剔除邻居</th><th>β</th><th>α</th><th>WAPE</th></tr></thead>
      <tbody>${folds.map((f) => `<tr><td>${f.fold + 1}</td><td>${f.heldPointCount}</td><td>${f.trainPointCount}</td><td>${f.embargoedPoints.length}</td><td>${f.fit.beta}</td><td>${f.fit.alpha}</td><td>${pct(f.metrics.wape)}</td></tr>`).join('')}</tbody>
    </table>
    <div class="section-title">泄漏对照（只作诊断）</div>
    <div class="version-card">
      <div class="version-row"><span>随机单元格切分 WAPE</span><b>${naive ? pct(naive.wape) : '—'}</b></div>
      <div class="version-row"><span>隔离协议 WAPE</span><b>${pct(m.wape)}</b></div>
      <p class="hint" style="margin-top:4px">${escapeHtml(b.leakageDiagnostic?.note ?? '')}</p>
    </div>
    <div class="section-title">营业变更检验</div>
    ${b.closureCheck ? `<div class="version-card">
      <div class="version-row"><span>事件</span><b>${escapeHtml(b.closureCheck.storeName)} 第 ${b.closureCheck.closedPeriod} 期关店</b></div>
      <div class="version-row"><span>邻近需求点</span><b>${b.closureCheck.affectedPointCount} 个</b></div>
      <div class="version-row"><span>关前该店到访</span><b>${num(b.closureCheck.closedStoreVisitsBeforeClosure)}</b></div>
      <div class="version-row"><span>其他店承接比例</span><b>${pct(b.closureCheck.transferShareOfClosedStore)}</b></div>
      <div class="version-row"><span>最近替代店</span><b>${escapeHtml(b.closureCheck.neighbour.storeId ?? '—')} · ${num(b.closureCheck.neighbour.distanceM)} m</b></div>
      <p class="hint" style="margin-top:4px">${escapeHtml(b.closureCheck.note)}</p>
    </div>` : '<p class="hint">无营业变更事件。</p>'}
    <div class="section-title">如何解读</div>
    <ul class="interp">${(b.interpretation ?? []).map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>
    <p class="hint" style="margin-top:8px">${escapeHtml(b.disclaimer)}</p>`;
  if (!b.fresh) $('#backtest-content').insertAdjacentHTML('afterbegin', '<div class="bt-note">以下为旧版本结果，仅供追溯；请重新运行。</div>');
}

/* ---------- revisions ---------- */
async function applyRevision(preset) {
  const label = state.meta.revisionPresets.find((p) => p.id === preset)?.label ?? preset;
  if (!confirm(`应用“${label}”？\n\n将生成新的输入版本；已保存方案与回测会标记为过期，必须显式重算。`)) return;
  try {
    const res = await api(`/api/revisions/${preset}`, { method: 'POST', body: {} });
    toast(`已更新输入：${res.revisions.join('、')}；旧方案 ${res.impact.staleScenarios} 条已标记过期`);
    await reloadAll();
  } catch (err) {
    toast(`修订失败：${err.message}`, 'error');
  }
}

async function reloadAll() {
  const [meta, data, scenarios, backtest, tasks] = await Promise.all([
    api('/api/meta'), api('/api/data'), api('/api/scenarios'), api('/api/backtest'), api('/api/tasks'),
  ]);
  state.meta = meta;
  state.data = data;
  state.scenarios = scenarios.scenarios;
  state.backtest = backtest;
  state.tasks = tasks.tasks;
  renderAll();
}

/* ---------- tasks ---------- */
function startPolling() {
  clearInterval(state.taskPoll);
  state.taskPoll = setInterval(async () => {
    if (document.hidden) return;
    try {
      const res = await api('/api/tasks');
      const changed = JSON.stringify(res.tasks) !== JSON.stringify(state.tasks);
      if (changed) {
        state.tasks = res.tasks;
        renderTasks();
        renderTaskBadge();
        notifyWatchers();
      }
    } catch { /* server may be restarting; retry next tick */ }
  }, 1600);
}

const watchers = new Map();
function watchTask(id, fn) {
  watchers.set(id, fn);
  const t = state.tasks.find((x) => x.id === id);
  if (t) fn(t);
}

function notifyWatchers() {
  for (const [id, fn] of watchers.entries()) {
    const t = state.tasks.find((x) => x.id === id);
    if (!t) continue;
    fn(t);
    if (['done', 'error', 'cancelled', 'interrupted'].includes(t.status)) watchers.delete(id);
  }
}

async function refreshTasks() {
  const res = await api('/api/tasks');
  state.tasks = res.tasks;
  renderTasks();
  renderTaskBadge();
}

function renderTaskBadge() {
  const active = state.tasks.filter((t) => ['queued', 'running', 'interrupted'].includes(t.status)).length;
  const badge = $('#task-badge');
  badge.hidden = active === 0;
  badge.textContent = String(active);
}

function renderTasks() {
  const list = $('#task-list');
  if (!state.tasks.length) {
    list.innerHTML = '<div class="empty-state"><p>还没有任务。</p></div>';
    return;
  }
  list.innerHTML = state.tasks.map((t) => {
    const statusLabel = { queued: '排队', running: '运行中', done: '完成', error: '失败', interrupted: '中断', cancelled: '取消' }[t.status] ?? t.status;
    const canRetry = ['error', 'interrupted', 'cancelled', 'done'].includes(t.status);
    return `<div class="task">
      <div class="task-head">
        <div><b>${escapeHtml(t.label || t.kind)}</b> <span class="hint">${escapeHtml(t.id)}</span></div>
        <span class="tstatus ${t.status}">${statusLabel}</span>
      </div>
      <div class="progress"><i style="width:${Math.round((t.progress ?? 0) * 100)}%"></i></div>
      <div class="hint">${escapeHtml(t.message ?? '')}${t.attempts > 1 ? ` · 第 ${t.attempts} 次尝试` : ''}${t.resultVersionKey ? ` · 输入 ${escapeHtml(t.resultVersionKey.slice(0, 10))}` : ''}</div>
      ${t.result ? `<div class="hint">${escapeHtml(summarizeTaskResult(t))}</div>` : ''}
      ${t.error ? `<details><summary class="hint">错误详情</summary><pre style="white-space:pre-wrap;font-size:10px;max-height:120px;overflow:auto">${escapeHtml(t.error)}</pre></details>` : ''}
      <div class="task-actions">
        ${canRetry ? `<button class="btn small ghost" data-retry="${t.id}">${t.status === 'done' ? '重新运行' : '恢复并重排'}</button>` : ''}
        ${t.status === 'queued' ? `<button class="btn small ghost" data-cancel="${t.id}">取消</button>` : ''}
        ${t.result?.id && t.kind === 'optimize' ? `<button class="btn small ghost" data-open-opt="${t.result.id}">查看结果</button>` : ''}
        ${t.kind === 'backtest' && t.status === 'done' ? '<button class="btn small ghost" data-open-bt="1">查看回测</button>' : ''}
      </div>
    </div>`;
  }).join('');
  $$('[data-retry]').forEach((b) => b.addEventListener('click', () => retryTask(b.dataset.retry)));
  $$('[data-cancel]').forEach((b) => b.addEventListener('click', () => cancelTask(b.dataset.cancel)));
  $$('[data-open-opt]').forEach((b) => b.addEventListener('click', async () => {
    state.optimize = await api(`/api/optimizations/${b.dataset.openOpt}`);
    renderOptimize();
    switchTab('optimize');
  }));
  $$('[data-open-bt]').forEach((b) => b.addEventListener('click', async () => {
    state.backtest = await api('/api/backtest');
    renderBacktest();
    switchTab('backtest');
  }));
  renderTaskBadge();
}

function summarizeTaskResult(t) {
  if (t.kind === 'optimize' && t.result) return `推荐 ${t.result.recommended?.join(' + ')} · 评估 ${t.result.combosEvaluated} 组合`;
  if (t.kind === 'backtest' && t.result) return `WAPE ${pct(t.result.metrics?.wape)} · ${t.result.id}`;
  return '';
}

async function retryTask(id) {
  try {
    const res = await api(`/api/tasks/${id}/retry`, { method: 'POST' });
    await refreshTasks();
    toast('任务已重新排队');
    if (res.task.kind === 'backtest') {
      watchTask(id, async (task) => {
        if (task.status === 'done') { state.backtest = await api('/api/backtest'); renderBacktest(); }
      });
    } else if (res.task.kind === 'optimize') {
      watchTask(id, async (task) => {
        if (task.status === 'done' && task.result?.id) {
          state.optimize = await api(`/api/optimizations/${task.result.id}`);
          renderOptimize();
        }
      });
    }
  } catch (err) {
    toast(`重排失败：${err.message}`, 'error');
  }
}

async function cancelTask(id) {
  try {
    await api(`/api/tasks/${id}/cancel`, { method: 'POST' });
    await refreshTasks();
  } catch (err) { toast(`取消失败：${err.message}`, 'error'); }
}

/* ---------- render all ---------- */
function renderAll() {
  const v = state.data.versions;
  $('#version-pill').textContent = `版本 ${state.data.versionKey.slice(0, 10)}`;
  $('#city-pill').textContent = state.meta.city.split('需求')[0];
  $('#foot-versions').textContent = Object.entries(v).map(([k, val]) => `${k}:${val?.slice(0, 9)}`).join('  ');
  $('#version-card').innerHTML = `
    <div class="version-row"><span>需求</span><code>${v.demand}</code></div>
    <div class="version-row"><span>路网</span><code>${v.network}</code></div>
    <div class="version-row"><span>门店</span><code>${v.stores}</code></div>
    <div class="version-row"><span>候选池</span><code>${v.candidates}</code></div>
    <div class="version-row"><span>观测</span><code>${v.history}</code></div>
    <div class="version-row"><span>模型</span><code>${v.model}</code></div>
    <div class="version-row"><span>当前期 / 预测期</span><b>${state.data.stores.meta.periods.current} / ${state.period}</b></div>`;
  renderCandidateList();
  renderScenarioPanel();
  renderScenarioGrid();
  renderBacktest();
  if (state.optimize) renderOptimize();
  renderTasks();
  renderCompare();
  renderMap();
  renderLegend();
}

boot();
