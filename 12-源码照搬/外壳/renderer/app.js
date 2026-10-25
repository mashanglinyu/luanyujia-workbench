/* 12-源码照搬 · 最小外壳的渲染层
   能跑：三场景标签、网格面板、文件浏览与预览、盘容量、负载胶囊、⋯ 菜单
   不能跑：真实 DSH 对话（AI 面板是占位，告诉你去接哪个接口） */
'use strict';

const API = window['kun'];

// 场景标签图标（与完整版同款，内联 SVG）
const SCENE_ICONS = {
  'self-review': "<svg width=\"17\" height=\"17\" viewBox=\"0 0 16 16\" fill=\"none\" aria-hidden=\"true\"><path d=\"M13.1 8A5.1 5.1 0 1 1 11.4 4.1\" stroke=\"#8fb4ff\" stroke-width=\"1.5\" stroke-linecap=\"round\"/><path d=\"M13.5 2.2v3h-3\" stroke=\"#8fb4ff\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><rect x=\"5.6\" y=\"5.9\" width=\"4.8\" height=\"6.2\" rx=\"1\" fill=\"#8fb4ff\" opacity=\".85\"/><rect x=\"6.9\" y=\"7.6\" width=\"2.2\" height=\".9\" rx=\".45\" fill=\"#0b1220\" opacity=\".5\"/><rect x=\"6.9\" y=\"9.4\" width=\"2.2\" height=\".9\" rx=\".45\" fill=\"#0b1220\" opacity=\".5\"/></svg>",
  'pc-cleanup': "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"17\" height=\"17\" viewBox=\"0 0 16 16\" fill=\"none\" aria-hidden=\"true\"><circle cx=\"8\" cy=\"8\" r=\"5.4\" stroke=\"#8fb4ff\" stroke-width=\"1.7\" opacity=\".35\"/><path d=\"M8 2.6a5.4 5.4 0 0 1 5.2 4\" stroke=\"#f0a35e\" stroke-width=\"1.7\" stroke-linecap=\"round\"/><circle cx=\"8\" cy=\"8\" r=\"1.7\" fill=\"#8fb4ff\"/></svg>",
  'design-misc': "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"17\" height=\"17\" viewBox=\"0 0 16 16\" fill=\"none\" aria-hidden=\"true\"><path d=\"M1.8 13.6c0-5 2.8-8.4 6.8-8.4 2.3 0 3.5 1.2 3.5 2.8 0 2-1.7 3.1-3.9 3.1-1.9 0-3.2.7-4.1 1.9\" stroke=\"#8fb4ff\" stroke-width=\"1.4\" stroke-linecap=\"round\"/><path d=\"M11.1 2.1 14 5l-3.3.9z\" fill=\"#f0a35e\"/><circle cx=\"1.9\" cy=\"13.4\" r=\"1.15\" fill=\"#f0a35e\"/></svg>",
};

const state = { scenarios: [], current: null, previewTarget: null, view: 'engine' };

// ── 小工具 ─────────────────────────────────────────────
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtKB = (n) => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
const fmtGB = (n) => (n / 1073741824).toFixed(0) + ' GB';

// ── 顶栏：5 个网页端按钮 ───────────────────────────────
const SITES = [
  { key: 'doubao', name: '豆包', url: 'https://www.doubao.com/chat/' },
  { key: 'tongyi', name: '通义千问', url: 'https://tongyi.aliyun.com/qianwen/' },
  { key: 'deepseek', name: 'DeepSeek', url: 'https://chat.deepseek.com/' },
  { key: 'chatglm', name: '智谱清言', url: 'https://chatglm.cn/main/alltoolsdetail' },
  { key: 'kimi', name: 'Kimi', url: 'https://www.kimi.com/' },
];
function mountWebAi() {
  const strip = $('#webai-strip');
  if (!strip || strip.children.length) return;
  SITES.forEach((s) => {
    const b = el('button', 'webai-btn');
    b.title = s.name + '（用系统浏览器打开）';
    const img = el('img');
    img.src = 'assets/webai/' + s.key + '.png';
    img.alt = s.name;
    img.draggable = false;
    img.onerror = () => { img.remove(); b.classList.add('noimg'); b.textContent = s.name.slice(0, 1); };
    b.appendChild(img);
    b.addEventListener('click', () => API.webai.open(s.key, s.url, s.name));
    strip.appendChild(b);
  });
}

// ── 启动动画（约 1.6 秒，纯 CSS/JS，无外部资源）────────
function bootAnim() {
  const ov = document.getElementById('boot-overlay');
  const bar = document.getElementById('boot-bar-in');
  const stage = document.getElementById('boot-stage');
  if (!ov) return;
  const steps = ['正在点亮红标志…', '正在检查引擎…', '正在读场景与配置…', '准备开干'];
  let i = 0;
  const pct = document.getElementById('boot-pct');
  if (pct) pct.textContent = '12%';
  bar.style.width = '12%';
  const t = setInterval(() => {
    i++;
    bar.style.width = Math.min(100, 12 + i * 26) + '%';
    if (pct) pct.textContent = Math.min(100, 12 + i * 26) + '%';
    if (stage) stage.textContent = steps[Math.min(i, steps.length - 1)];
    if (i >= 4) {
      clearInterval(t);
      ov.classList.add('done');
      setTimeout(() => ov.remove(), 420);
    }
  }, 380);
}

// ── 余额 + 连接状态 ───────────────────────────────────
async function tickBalance() {
  const chip = document.getElementById('balance-chip');
  try {
    const r = await API.app.balance();
    if (r.ok) {
      const sym = r.currency === 'CNY' ? '¥' : '$';
      chip.textContent = sym + Number(r.total).toFixed(2);
      chip.className = 'balance-chip' + (r.available ? ' ok' : ' bad');
      chip.title = 'DeepSeek 余额 ' + r.total + ' ' + r.currency + (r.available ? '' : '（余额不足）');
    } else {
      chip.textContent = '¥ —';
      chip.title = '余额取不到：' + r.why;
    }
  } catch (e) { chip.textContent = '¥ —'; }
}

function setStatus(ok, text) {
  const d = document.getElementById('status-dot');
  const t = document.getElementById('status-text');
  if (d) d.className = 'status-dot' + (ok ? ' ok' : '');
  if (t) t.textContent = text;
}

async function tickLoad() {
  try {
    const r = await API.app.load();
    const p = $('#tbs-load');
    const cpu = typeof r.cpu === 'number' ? r.cpu : null;
    const gpu = r.gpu && typeof r.gpu.util === 'number' ? r.gpu.util : null;
    const gpuMem = r.gpu && r.gpu.memUsed && r.gpu.memTotal ? ('（' + r.gpu.memUsed + '/' + r.gpu.memTotal + ' MB）') : '';
    const mem = r.mem && typeof r.mem.usedPct === 'number' ? r.mem.usedPct : null;
    p.innerHTML = '<span class="tbs-txt"><span class="tbs-k">CPU</span><b>' + (cpu == null ? '—' : cpu + '%') + '</b></span>' +
                  '<span class="tbs-txt"><span class="tbs-k">GPU</span><b>' + (gpu == null ? '—' : gpu + '%') + '</b></span>' +
                  '<span class="tbs-txt"><span class="tbs-k">MEM</span><b>' + (mem == null ? '—' : mem + '%') + '</b></span>';
    p.className = 'tbs-pill tbs-load' + (cpu >= 90 ? ' bad' : cpu >= 70 ? ' warn' : '');
    p.title = '本机负载：CPU ' + (cpu == null ? '—' : cpu + '%') + ' · GPU ' + (gpu == null ? '—' : gpu + '%' + gpuMem) + ' · 内存 ' + (mem == null ? '—' : mem + '%');
  } catch (e) { /* ignore */ }
}

// ── 场景标签 ───────────────────────────────────────────
function renderTabs() {
  const nav = $('#scenario-tabs');
  nav.innerHTML = '';
  const eng = el('button', 'tab collapsible' + (state.view === 'engine' ? ' active' : ''));
  eng.title = 'DeepSeek Harness 原始界面';
  const engIco = el('span', 'tab-ico', '🐋');
  eng.appendChild(engIco);
  eng.appendChild(el('span', 'tab-txt', 'DeepSeek Harness'));
  eng.addEventListener('click', () => { state.view = 'engine'; renderTabs(); showView(); });
  nav.appendChild(eng);
  state.scenarios.forEach((sc) => {
    const b = el('button', 'tab collapsible' + (state.view === sc.id ? ' active' : ''));
    b.title = sc.description || sc.name;
    const ico = el('span', 'tab-ico');
    ico.innerHTML = SCENE_ICONS[sc.id] || '';
    b.appendChild(ico);
    b.appendChild(el('span', 'tab-txt', sc.name));
    b.addEventListener('click', () => selectScenario(sc.id));
    nav.appendChild(b);
  });
}

function selectScenario(id) {
  state.current = state.scenarios.find((s) => s.id === id) || state.scenarios[0] || null;
  state.view = state.current ? state.current.id : 'engine';
  renderTabs();
  showView();
}

// 两个视图互斥：引擎 / 场景网格
function showView() {
  const eng = document.getElementById('engine-view');
  const sc = document.getElementById('scenario-view');
  const onEngine = state.view === 'engine';
  eng.classList.toggle('active', onEngine);
  sc.classList.toggle('active', !onEngine);
  if (onEngine) loadEngine();
  else renderGrid();
}

// ── 网格与面板 ─────────────────────────────────────────
function renderGrid() {
  const grid = $('#grid');
  grid.innerHTML = '';
  const sc = state.current;
  if (!sc) { grid.appendChild(el('div', 'empty', '没有场景：把 scenarios/*.json 放进来')); return; }
  // 按本场景用到的最大行数铺满（不出现页面级滚动条）
  const maxRow = (sc.panels || []).reduce((m, x) => Math.max(m, (x.row || 1) + (x.h || 1) - 1), 1);
  grid.style.gridTemplateRows = 'repeat(' + maxRow + ', minmax(0, 1fr))';
  (sc.panels || []).forEach((p, i) => { p.__idx = i + 1; grid.appendChild(buildPanel(sc, p)); });
}

function buildPanel(sc, p) {
  const box = el('div', 'panel');
  box.style.gridColumn = (p.col || 1) + ' / span ' + (p.w || 1);
  box.style.gridRow = (p.row || 1) + ' / span ' + (p.h || 1);
  box.dataset.type = p.type || '';

  const head = el('div', 'panel-head');
  const num = el('span', 'panel-num', String(p.__idx || 1));
  num.title = '窗口序号';
  head.appendChild(num);
  head.appendChild(el('span', 'panel-title', p.title || p.id));
  if (p.sub) head.appendChild(el('span', 'panel-sub', p.sub));
  const ptype = String(p.type || '');
  const canExpand = ptype === 'harness' || ptype === 'embed';   // 会话面板 + 内嵌网页都支持向上展开
  const exp = el('button', 'panel-expand', '▲');
  exp.title = '展开到最高（再点一次收起）';
  exp.style.display = canExpand ? '' : 'none';
  head.appendChild(exp);
  box.appendChild(head);

  if (canExpand) {
    let savedGrid = null;
    exp.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const on = !box.classList.contains('panel-expanded');
      if (on) {
        // 记住原格子（grid 定位是内联的，收起时必须还原）
        savedGrid = { col: box.style.gridColumn, row: box.style.gridRow };
        const r = box.getBoundingClientRect();
        const grid = box.parentNode;
        const ph = document.createElement('div');
        ph.className = 'panel-placeholder';
        ph.style.gridColumn = savedGrid.col;
        ph.style.gridRow = savedGrid.row;
        grid.insertBefore(ph, box);
        box.__ph = ph;

        box.classList.add('panel-expanded');
        box.style.position = 'fixed';
        box.style.left = r.left + 'px';
        box.style.width = r.width + 'px';
        box.style.top = (r.top) + 'px';
        box.style.height = r.height + 'px';
        box.style.zIndex = String(900 + (window.__expZ = (window.__expZ || 0) + 1));
        // 强制回流后立刻改目标（不用 rAF：窗口不在前台时 rAF 会被节流）
        void box.offsetHeight;
        box.style.top = '74px';
        box.style.height = (r.bottom - 74) + 'px';
        exp.textContent = '▼';
        exp.title = '收起';
        window.addEventListener('keydown', escClose, { once: true });
      } else {
        const ph = box.__ph;
        const t = ph ? ph.getBoundingClientRect() : null;
        if (t) {
          // 先动画收回原格子，动画结束再解除 fixed
          box.style.top = t.top + 'px';
          box.style.height = t.height + 'px';
        }
        exp.textContent = '▲';
        exp.title = '展开到最高（再点一次收起）';
        setTimeout(() => {
          if (ph) ph.remove();
          box.__ph = null;
          box.classList.remove('panel-expanded');
          box.style.position = '';
          box.style.left = '';
          box.style.width = '';
          box.style.top = '';
          box.style.height = '';
          box.style.zIndex = '';
          if (savedGrid) { box.style.gridColumn = savedGrid.col; box.style.gridRow = savedGrid.row; }
        }, 200);
      }
    });
    function escClose(e) { if (e.key === 'Escape') exp.click(); }
  }
  
  const body = el('div', 'panel-body');
  box.appendChild(body);

  if (ptype === 'review-doc' || ptype === 'view') {
    body.innerHTML = '<div class="ph">点右边的文件，就在这里预览</div>';
    box._show = (f) => showPreview(body, f);
  } else if (ptype === 'review-files' || ptype === 'file') {
    renderFilePanel(body, p);
  } else if (ptype === 'harness') {
    body.innerHTML = '<div class="ph">AI 面板：<b>' + esc(p.sessionTitle || '会话') + '</b><br>' +
      '<small>本最小壳不内嵌对话。接法：把 <code>sessionId</code> 填进 scenarios 的 json，再用你引擎的会话接口渲染到这里。</small></div>';
  } else if (ptype === 'embed') {
    const wv = document.createElement('webview');
    wv.setAttribute('partition', 'persist:embed-' + p.id);
    wv.setAttribute('allowpopups', '');
    wv.style.cssText = 'width:100%;height:100%;border:0;background:#fff';
    wv.src = p.url;
    body.style.padding = '0';
    body.appendChild(wv);
  } else if (ptype === 'reserved') {
    body.innerHTML = '<div class="ph">' + esc(p.reserveNote || '预留面板') + '</div>';
  } else if (ptype.indexOf('pc-') === 0) {
    renderPcPanel(body, ptype);
  } else {
    body.innerHTML = '<div class="ph">未实现的面板类型：<code>' + esc(ptype) + '</code></div>';
  }

  return box;
}

function rememberRecent(file) {
  try {
    const list = JSON.parse(localStorage.getItem('wb.recent') || '[]');
    const next = [{ path: file, at: Date.now() }].concat(list.filter((x) => x.path !== file)).slice(0, 12);
    localStorage.setItem('wb.recent', JSON.stringify(next));
  } catch (e) {}
}

function showPreview(body, file) {
  rememberRecent(file);
  body.innerHTML = '<div class="ph">读取中…</div>';
  API.fs.read(file).then((r) => {
    if (!r.ok) { body.innerHTML = '<div class="ph">读不了：' + esc(r.why) + '</div>'; return; }
    if (r.kind === 'image') body.innerHTML = '<img class="pv-img" src="' + r.dataUrl + '">';
    else if (r.kind === 'video') body.innerHTML = '<video class="pv-video" src="' + r.fileUrl + '" controls></video>';
    else if (r.kind === 'pdf') body.innerHTML = '<iframe class="pv-frame" src="' + r.fileUrl + '"></iframe>';
    else if (r.kind === 'text' || r.kind === 'md') body.innerHTML = '<pre class="pv-text">' + esc(r.text) + '</pre>';
    else body.innerHTML = '<div class="ph">这个类型先不预览（.' + esc(r.ext || '?') + '，' + fmtKB(r.size || 0) + '）</div>';
  });
}

async function renderFilePanel(body, p) {
  let root = p.root || p.launchPath || '';
  if (!root || root.indexOf('<') >= 0) root = await API.app.home();
  const r = await API.fs.list(root);
  if (!r.ok) { body.innerHTML = '<div class="ph">读不了目录：' + esc(r.why) + '</div>'; return; }
  const list = el('div', 'file-list');
  const head = el('div', 'file-row file-row-dir', '📁 ' + r.dir);
  head.addEventListener('click', () => {});
  list.appendChild(head);
  r.items.slice(0, 300).forEach((it) => {
    const row = el('div', 'file-row' + (it.dir ? ' file-row-dir' : ''), (it.dir ? '📁 ' : '📄 ') + it.name + (it.dir ? '' : '  ·  ' + fmtKB(it.size)));
    if (!it.dir) row.addEventListener('click', () => previewInto(it));
    list.appendChild(row);
  });
  body.appendChild(list);

  function previewInto(it) {
    const targetId = p.viewPanel || boxIdForPreview();
    const target = document.querySelector('[data-preview="' + targetId + '"]');
    if (target && target._show) target._show(r.dir.replace(/[\\/]$/, '') + '\\' + it.name);
    else showPreview(body, r.dir.replace(/[\\/]$/, '') + '\\' + it.name);
  }
  function boxIdForPreview() {
    const t = state.current && (state.current.panels || []).find((x) => x.type === 'review-doc' || x.type === 'view');
    return t ? t.id : '';
  }
}

async function renderPcPanel(body, type) {
  if (type === 'pc-drives') {
    const disks = await API.app.disks();
    if (!disks.length) { body.innerHTML = '<div class="ph">没读到磁盘</div>'; return; }
    const wrap = el('div', 'drives');
    const totalAll = disks.reduce((a, d) => a + d.total, 0);
    const freeAll = disks.reduce((a, d) => a + d.free, 0);
    const head = el('div', 'drives-head');
    head.innerHTML = '<span>总容量 ' + fmtGB(totalAll) + '</span><span>可用 ' + fmtGB(freeAll) +
      '</span><span>已用 ' + Math.round((1 - freeAll / totalAll) * 100) + '%</span>';
    body.appendChild(head);
    disks.forEach((d) => {
      const cls = d.usedPct >= 90 ? 'bad' : d.usedPct >= 70 ? 'warn' : 'ok';
      const C = 2 * Math.PI * 26;
      const off = C * (1 - d.usedPct / 100);
      const card = el('div', 'drive');
      card.innerHTML =
        '<svg class="ring" viewBox="0 0 64 64"><circle cx="32" cy="32" r="26" class="ring-bg"/>' +
        '<circle cx="32" cy="32" r="26" class="ring-fg ' + cls + '" stroke-dasharray="' + C.toFixed(1) + '" stroke-dashoffset="' + off.toFixed(1) + '"/></svg>' +
        '<div class="drive-k">' + d.letter + ':</div>' +
        '<div class="drive-pct ' + cls + '">' + d.usedPct + '%</div>' +
        '<div class="drive-meta">剩 ' + fmtGB(d.free) + ' / ' + fmtGB(d.total) + '</div>';
      wrap.appendChild(card);
    });
    body.appendChild(wrap);
  } else if (type === 'pc-toplarge' || type === 'pc-junk' || type === 'pc-ledger') {
    body.innerHTML = '<div class="ph">' + (type === 'pc-toplarge' ? '大户排行' : type === 'pc-junk' ? '可清理体检' : '清理台账') +
      '：需要外壳提供扫描接口（本最小壳不含）。</div>';
  } else {
    body.innerHTML = '<div class="ph">未实现：' + esc(type) + '</div>';
  }
}

// ── 顶栏交互 ───────────────────────────────────────────
function mountTopbar() {
  const dragArea = document.querySelector('.titlebar-drag');
  if (dragArea) dragArea.addEventListener('dblclick', () => API.win.control('max'));
  $('#btn-min').addEventListener('click', () => API.win.control('min'));
  $('#btn-max').addEventListener('click', () => API.win.control('max'));
  $('#btn-close').addEventListener('click', () => API.win.control('close'));
  $('#btn-refresh').addEventListener('click', async () => { await loadScenarios(); });
  const fb = document.getElementById('btn-folder');
  if (fb) {
    const menu = el('div', 'tb-more-panel folder-menu');
    menu.id = 'folder-menu';
    document.body.appendChild(menu);
    fb.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (menu.style.display === 'block') { menu.style.display = 'none'; return; }
      const d = await API.app.dirs();
      const items = [
        { label: '工作区', path: d.workspace },
        { label: 'DSH 根目录', path: d.root },
        { label: '场景目录', path: d.scenes },
      ].filter((x) => x.path);
      menu.innerHTML = '';
      // 最近打开的文件（点过预览的）
      let recent = [];
      try { recent = JSON.parse(localStorage.getItem('wb.recent') || '[]'); } catch (e) {}
      if (recent.length) {
        const cap = el('div', 'folder-cap', '最近打开');
        menu.appendChild(cap);
        recent.slice(0, 8).forEach((it) => {
          const name = it.path.split(/[\\/]/).pop();
          const row = el('button', 'tb-more-item recent', name);
          row.title = it.path;
          row.addEventListener('click', async (ev3) => {
            ev3.stopPropagation();
            menu.style.display = 'none';
            const target = document.querySelector('.panel[data-type="review-doc"] .panel-body, .panel[data-type="view"] .panel-body');
            if (target) showPreview(target, it.path);
            else { const r = await API.app.openPath(it.path); if (r && r.err) alert('打不开：' + r.err); }
          });
          menu.appendChild(row);
        });
        menu.appendChild(el('div', 'folder-sep'));
      }
      items.forEach((it) => {
        const row = el('button', 'tb-more-item', it.label);
        row.title = it.path;
        row.addEventListener('click', async (ev2) => {
          ev2.stopPropagation();
          menu.style.display = 'none';
          const r = await API.app.openPath(it.path);
          if (r && r.err) alert('打不开：' + r.err);
        });
        menu.appendChild(row);
      });
      const rect = fb.getBoundingClientRect();
      menu.style.position = 'fixed';
      menu.style.left = Math.round(rect.left) + 'px';
      menu.style.top = Math.round(rect.bottom + 6) + 'px';
      menu.style.right = 'auto';
      menu.style.display = 'block';
    });
    document.addEventListener('click', () => { menu.style.display = 'none'; });
  }
  $('#btn-more').addEventListener('click', (e) => {
    e.stopPropagation();
    const p = $('#tb-more-panel');
    p.style.display = p.style.display === 'block' ? 'none' : 'block';
  });
  document.addEventListener('click', () => { $('#tb-more-panel').style.display = 'none'; });
  (function initTabnumLabel() {
    let on = false;
    try { on = localStorage.getItem('wb.tabnum') === '1'; } catch (e) {}
    const b = document.querySelector('[data-act="tabnum"]');
    if (b) b.textContent = '窗口序号：' + (on ? '开' : '关');
  })();

  $('#tb-more-panel').addEventListener('click', async (e) => {
    const act = e.target && e.target.dataset && e.target.dataset.act;
    if (!act) return;
    $('#tb-more-panel').style.display = 'none';
    if (act === 'ver') {
      const v = await API.app.version();
      alert('工作台 ' + v.app + '\nElectron ' + v.electron + '\nChromium ' + v.chrome);
    } else if (act === 'mem') {
      const r = await API.app.injectMemory();
      if (!r.ok) alert('注入失败：' + r.why);
      else alert('记忆模板：\n' + r.res.map((x) => x.scen + ' → ' + (x.skipped ? '已存在，跳过' : x.path)).join('\n'));
    } else if (act === 'theme-cycle') {
      const cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
      const next = cur === 'dark' ? 'light' : 'dark';
      setTheme(next);
      const b = document.querySelector('[data-act="theme-cycle"]');
      if (b) b.textContent = '外观：' + (next === 'dark' ? '深色' : '浅色') + '（点击切换）';
    } else if (act === 'tabnum') {
      const on = !(localStorage.getItem('wb.tabnum') === '1');
      try { localStorage.setItem('wb.tabnum', on ? '1' : '0'); } catch (e) {}
      applyPanelNums();
      const b = document.querySelector('[data-act="tabnum"]');
      if (b) b.textContent = '窗口序号：' + (on ? '开' : '关');
    } else if (act === 'onboard') {
      showOnboard(true);
    } else if (act === 'dir') {
      API.app.openPath('.');
    }
  });
}

// ── 引擎视图（默认） ───────────────────────────────────
let engineLoaded = false;
async function loadEngine() {
  const wv = document.getElementById('engine-webview');
  const off = document.getElementById('engine-off');
  if (engineLoaded) { off.style.display = 'none'; return; }
  const cfg = await API.app.config();
  let url = cfg.engineUrl || 'http://127.0.0.1:3080/';
  if (cfg.engineToken) url += (url.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(cfg.engineToken);
  document.getElementById('engine-off-url').textContent = url.replace(/token=[^&]+/, 'token=***');
  wv.src = url;
  engineLoaded = true;
  const failed = () => { off.style.display = 'flex'; setStatus(false, '引擎未连接'); };
  wv.addEventListener('did-fail-load', failed);
  setTimeout(() => {
    try { if (!wv.getURL() || wv.getURL() === 'about:blank') failed(); } catch (e) { failed(); }
  }, 6000);
  wv.addEventListener('did-finish-load', () => { off.style.display = 'none'; setStatus(true, 'Harness 已连接'); });
  document.getElementById('engine-retry').onclick = () => {
    off.style.display = 'none';
    engineLoaded = false;
    loadEngine();
  };
}

// ── 扩展胶囊：插件 / 技能 / MCP / 工具 ─────────────────
async function mountExtGroup() {
  const root = await API.app.dshRoot();
  const openDir = async (sub) => {
    if (!root) { alert('没检测到 DSH 根目录：\n可在启动外壳前设环境变量 DSH_HOME，指到你的 DSH 引擎目录（含 .dsh 的那层）'); return; }
    const p = sub ? root + '\\' + sub : root;
    const r = await API.app.openPath(p);
    if (r && r.err) alert('打不开：' + r.err);
  };
  document.getElementById('btn-plugins').onclick = () => openDir('插件');
  document.getElementById('btn-skills').onclick = () => openDir('skills');
  document.getElementById('btn-tools').onclick = () => openDir('工具');
  document.getElementById('btn-mcp').onclick = () => alert('MCP 入口：本最小壳不读引擎的 MCP 配置。\n接法：在你的外壳里按 03-MCP接免费AI 那节接，然后把这个按钮指向你的 MCP 面板。');
}

// ── 外观（深/浅/跟随系统）─────────────────────────────
function applyTheme(mode) {
  const root = document.documentElement;
  const sysLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
  const t = mode === 'auto' ? (sysLight ? 'light' : 'dark') : mode;
  root.setAttribute('data-theme', t);
  try { localStorage.setItem('wb.theme', mode); } catch (e) {}
}
function setTheme(mode) { applyTheme(mode); }
function restoreTheme() {
  let mode = 'dark';
  try { mode = localStorage.getItem('wb.theme') || 'dark'; } catch (e) {}
  applyTheme(mode);
}

// ── 引导（首次打开显示；⋯ 里也能重开）───────────────
const ONBOARD_PROMPT = [
  '我在用一个小工作台外壳（Electron），目录：<把这里换成 12-源码照搬\\外壳 的真实路径>。',
  '请你读它的《引导.md》，然后替我把配置填好，不要问我能不能，直接做：',
  '1. 探测：我的 DSH 根目录（含 .dsh 的那层）、dsh web 的地址与 token。',
  '2. 写 <外壳>\\config.local.json：{"engineUrl":"http://127.0.0.1:3080/","engineToken":"<token>"}（有 DEEPSEEK_API_KEY 就加 deepseekKey）。',
  '3. 建三个会话：自我复盘 / 本地电脑 / 设计杂活，把 session id 填进 scenarios 下对应 json 的 sessionId。',
  '4. 把 scenarios 里的占位符换成我机器上真实目录；拿不准的保留并列给我。',
  '5. 校验三个 json 能 JSON.parse；config.local.json 不进 git。',
  '6. 按四行汇报：填了什么 / 会话 id / 改了哪些文件 / 还缺什么。',
  '⛔ 不许改 main.js / preload.js / renderer 下的代码。'
].join('\n');

function showOnboard(force) {
  const mask = document.getElementById('onboard');
  if (!mask) return;
  let done = false;
  try { done = localStorage.getItem('wb.onboarded') === '1'; } catch (e) {}
  if (!force && done) return;
  mask.style.display = 'flex';
}
function mountOnboard() {
  const mask = document.getElementById('onboard');
  if (!mask) return;
  document.getElementById('ob-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(ONBOARD_PROMPT); } catch (e) {}
    document.getElementById('ob-copy').textContent = '已复制 ✓';
    setTimeout(() => { document.getElementById('ob-copy').textContent = '复制给 DSH 的提示词'; }, 1600);
  });
  document.getElementById('ob-guide').addEventListener('click', async () => {
    const d = await API.app.dirs();
    const r = await API.app.openPath(d.shell + '\\引导.md');
    if (r && r.err) alert('打不开引导：' + r.err);
  });
  document.getElementById('ob-close').addEventListener('click', () => {
    mask.style.display = 'none';
    try { localStorage.setItem('wb.onboarded', '1'); } catch (e) {}
  });
  setTimeout(() => showOnboard(false), 1600);   // 等启动动画走完再弹
}

function applyPanelNums() {
  const grid = document.getElementById('grid');
  if (!grid) return;
  let on = false;
  try { on = localStorage.getItem('wb.tabnum') === '1'; } catch (e) {}
  grid.classList.toggle('show-num', on);
}

// ── 启动 ───────────────────────────────────────────────
async function loadScenarios() {
  state.scenarios = await API.app.scenarios();
  if (!state.current || !state.scenarios.find((s) => s.id === state.current.id)) {
    state.current = state.scenarios[0] || null;
  }
  renderTabs();
  if (state.view === 'engine') showView(); else renderGrid();
  $('#status-text').textContent = state.scenarios.length + ' 个场景';
}

(async function boot() {
  restoreTheme();
  bootAnim();
  mountWebAi();
  mountOnboard();
  mountTopbar();
  tickLoad();
  setInterval(tickLoad, 4000);
  tickBalance();
  setInterval(tickBalance, 300000);
  await loadScenarios();
  mountExtGroup();
  showView();
  applyPanelNums();
})();
