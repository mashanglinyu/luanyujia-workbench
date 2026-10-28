// 工作台 — 渲染层主逻辑（多场景版）
// 场景 0：DSH 引擎（默认初始界面，webview 内嵌，带 token）
// 场景 1..N：本地场景（scenarios/*.json 配置 + renderers 分发）
// 顶层声明一律用 var：刷新按钮会带时间戳重复加载本文件，const/let 重复声明会直接报错导致热更新失效
'use strict';

var el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

// ---------- 主题感知：画布本身透明（clearRect），底色来自 CSS ----------
// 浅色主题下"白色前景"（十字线等）必须反转成深色，否则在浅底上看不见
function isLightTheme() {
  try { return document.documentElement.dataset.theme === 'light'; } catch (e) { return false; }
}
// 画布前景色：深色主题 → 白系；浅色主题 → 深灰蓝系
function canvasFg(alpha) {
  return isLightTheme() ? 'rgba(15, 23, 42, ' + alpha + ')' : 'rgba(255, 255, 255, ' + alpha + ')';
}

// ---------- 多公司模板：把"当前场景 id"告知主进程（幂等，仅在变化时发 IPC）----------
// 场景 json 的 meta 可覆盖：ssh / svc / paths / mappings / logs / urls / pinTarget
// meta 缺省时主进程全部回落 oa.db 全局配置 → 原有场景行为不变
var oaScenarioSynced = null;
var oaSyncScenario = (meta) => {
  const sid = (meta && meta.scenario) || 'oa-ops';
  if (sid === oaScenarioSynced) return sid;
  oaScenarioSynced = sid;
  try {
    const K = window.app && window.app.oa;
    if (K && K.setScenario) K.setScenario(sid);
  } catch (e) { /* ignore */ }
  return sid;
};

// ---------- 面板轮询助手（省流量：不可见即暂停，恢复可见立刻刷新一次）----------
// 背景：每个面板的采集都要新起 Python + SSH 连接（约 0.3s CPU + 一次握手）。
// 原间隔（dash 15s / logs 6s / files 20s / web 15s）合计约 1200 次 SSH/小时，属明显浪费。
// 现规则：间隔放大到 30~60s + 主进程 TTL 缓存 + 窗口不可见（最小化/切走）时完全停轮询。
var oaPoll = (intervalMs, fn) => {
  let timer = null, stopped = false;
  const start = () => { if (timer === null && !stopped) timer = setInterval(fn, intervalMs); };
  const stop = () => { if (timer !== null) { clearInterval(timer); timer = null; } };
  const onVis = () => {
    if (document.hidden) { stop(); return; }
    try { fn(); } catch (e) { /* ignore */ }   // 回到可见 → 立即补一次
    start();
  };
  document.addEventListener('visibilitychange', onVis);
  if (!document.hidden) start();
  return () => { stopped = true; stop(); document.removeEventListener('visibilitychange', onVis); };
};

// ---------- 工具 ----------
function mktColor(v) {
  if (v == null) return '';
  // 兼容 "+0.52%" / "-0.30%" / "-4.23" / 数值等格式
  const n = Number(String(v).replace(/[+%]/g, ''));
  if (n > 0) return '#e5484d';   // A股红涨
  if (n < 0) return '#2ebd85';   // A股绿跌
  return '';
}

// ---------- 面板渲染器（本地场景用） ----------
var renderers = {};

// ---------- 面板「展开到最高 / 收起」（AI 助手面板用）----------
// 需求：点标题栏中间的箭头 → 该面板高度直接占满整个场景（盖住其它面板），
//       其它面板位置**完全不动**；箭头翻转，再点收回原状。
// 关键点：面板本来是 grid item，直接改成 absolute 会让其余面板**回流跑位**，
//        所以展开前先在原位置插一个「占位格」（同 grid-column/grid-row），把版面钉住。
// 动效：以「原格子几何 → 满高几何」在 top/height 上做 CSS 过渡（320ms），配青色描边高亮、
//        自上而下的扫描光带、以及压暗其它面板的聚焦层。
//        ⚠ 刻意不用 transform 缩放：面板里是 <webview>，guest view 对祖先 transform 跟随不稳，
//          而展开时只有高度/纵向位置在变（宽度不变），top/height 过渡的重排成本很低。
// 展开中的面板（**可以同时展开多个**：2026-09-20 用户要求"两个 AI 窗口能同时展开"）。
// 顺序 = 展开先后，用来定 z-index（后展开的压住先展开的）和 ESC 的退栈顺序。
// 元素形如 { wrap, slot, btn, onResize, onKey, backdrop }
var panelExpandStates = [];
var panelExpandZ = 60;         // 展开面板的 z-index 基数，每展开一个 +1
var PANEL_ANIM_MS = 320;

function panelMotionOff() {
  try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; }
}

// 把面板从「当前几何」过渡到 toRect（fixed 定位下改 top/left/width/height），结束后回调 done
function animatePanelBox(wrap, toRect, done) {
  wrap.classList.add('panel-anim');
  void wrap.offsetWidth;   // 强制回流：保证起始帧先落地，过渡才会跑
  wrap.style.left = Math.round(toRect.left) + 'px';
  wrap.style.top = Math.round(toRect.top) + 'px';
  wrap.style.width = Math.round(toRect.width) + 'px';
  wrap.style.height = Math.round(toRect.height) + 'px';
  var finished = false;
  var finish = function () {
    if (finished) return;
    finished = true;
    try { wrap.classList.remove('panel-anim'); } catch (e) { /* ignore */ }
    wrap.removeEventListener('transitionend', onEnd);
    if (done) done();
  };
  var onEnd = function (e) { if (e.target === wrap && e.propertyName === 'height') finish(); };
  wrap.addEventListener('transitionend', onEnd);
  setTimeout(finish, PANEL_ANIM_MS + 140);   // 兜底：transitionend 偶发不触发
}

// 找到某个面板的展开状态（没展开 = null）
function expandedStateOf(wrap) {
  for (var i = 0; i < panelExpandStates.length; i++) {
    if (panelExpandStates[i].wrap === wrap) return panelExpandStates[i];
  }
  return null;
}

// 收起：`collapsePanel(wrap)` 只收这一个；`collapsePanel()` 不带参数 = 全收（切场景时 renderer.js 用的就是这种）。
function collapsePanel(wrap) {
  if (!panelExpandStates.length) return;
  var targets = wrap ? panelExpandStates.filter(function (s) { return s.wrap === wrap; })
                     : panelExpandStates.slice();
  if (!targets.length) return;
  // 逆序收（后展开的先收），动画重叠时视觉更像"退栈"
  for (var i = targets.length - 1; i >= 0; i--) collapseOne(targets[i]);
}

function collapseOne(st) {
  if (!st) return;
  var at = panelExpandStates.indexOf(st);
  if (at >= 0) panelExpandStates.splice(at, 1);
  try {
    const wrap = st.wrap;
    // 目标几何 = 占位格（原格子）；占位格在展开期间一直钉着，所以这里能直接量到
    let toRect = null;
    try { if (st.slot && st.slot.parentNode) toRect = st.slot.getBoundingClientRect(); } catch (e) { toRect = null; }
    if (st.btn) { st.btn.textContent = '▲'; st.btn.title = '展开到最高（再点一次收起）'; }
    window.removeEventListener('resize', st.onResize);
    document.removeEventListener('keydown', st.onKey, true);
    if (st.backdrop) {
      const b = st.backdrop;
      try { b.classList.remove('on'); } catch (e) { /* ignore */ }
      setTimeout(function () { try { if (b.parentNode) b.parentNode.removeChild(b); } catch (e) { /* ignore */ } }, PANEL_ANIM_MS + 60);
    }
    const reset = function () {
      try {
        wrap.classList.remove('panel-expanded');
        wrap.classList.remove('panel-anim');
        wrap.style.position = '';
        wrap.style.zIndex = '';
        wrap.style.left = '';
        wrap.style.top = '';
        wrap.style.width = '';
        wrap.style.height = '';
        if (st.slot && st.slot.parentNode) st.slot.parentNode.removeChild(st.slot);
      } catch (e) { /* ignore */ }
    };
    // 收起同理：贴底冻结 → 缩短动画 → 解冻（内容不会来回跳）
    if (toRect && wrap.isConnected && !panelMotionOff()) {
      const unfreeze = freezePanelWebviews(wrap);
      animatePanelBox(wrap, toRect, function () { try { unfreeze(); } catch (e) { /* ignore */ } reset(); });
    } else {
      reset();
    }
  } catch (e) { /* ignore */ }
}

// 展开/收起时把面板里的 <webview> **贴底冻结**（尺寸不变 + 底边钉住容器底边）。
//
// 为什么这么做：面板展开是「下边缘不动、上边缘往上长」。若让 webview 跟着逐帧长高，
// guest（DSH 对话页，独立进程）会每帧重排 → 内容抖。冻结后 guest 全程只重排 1 次。
//
// ⚠⚠ 必须用 absolute + bottom:0 钉底，**不能**用 flex 的 margin-top:auto：
//    收起时容器会变得比冻结高度更矮，flex 在「负剩余空间」下会把 auto 边距当 0，
//    元素被顶到上方、底部被裁 → 贴底的输入框整块消失，解冻后才跳回来（踩过的坑）。
//    绝对定位 + bottom:0 则始终以底边对齐容器底边，超出部分从**上方**被裁 →
//    输入框全程可见，展开/收起都不跳。
function freezePanelWebviews(wrap) {
  const list = [];
  try {
    wrap.querySelectorAll('webview').forEach(function (wv) {
      const h = Math.round(wv.getBoundingClientRect().height);
      if (!h) return;
      const body = wv.parentElement;
      let changedBodyPos = false;
      if (body) {
        try {
          if (getComputedStyle(body).position === 'static') { body.style.position = 'relative'; changedBodyPos = true; }
        } catch (e) { /* ignore */ }
      }
      list.push({ wv: wv, body: body, changedBodyPos: changedBodyPos });
      wv.style.position = 'absolute';
      wv.style.left = '0';
      wv.style.right = '0';
      wv.style.bottom = '0';
      wv.style.height = h + 'px';
      wv.style.flex = 'none';
    });
  } catch (e) { /* ignore */ }
  if (!list.length) return function () { };
  return function unfreeze() {
    list.forEach(function (it) {
      try {
        const wv = it.wv;
        wv.style.position = '';
        wv.style.left = '';
        wv.style.right = '';
        wv.style.bottom = '';
        wv.style.height = '';
        wv.style.flex = '';
        if (it.changedBodyPos && it.body) it.body.style.position = '';
      } catch (e) { /* ignore */ }
    });
  };
}

function expandPanel(wrap, btn) {
  const gridEl = wrap.parentElement;
  if (!gridEl) return;
  if (expandedStateOf(wrap)) return;   // 已经展开了，别重复插占位格
  // ★ 2026-09-20：**不再"同时只允许展开一个"**（原来这里有一句 collapsePanel()）。
  //   现在可以多个面板并排同时展开（用户要求：自我复盘的两个 AI 窗口都要能展开）。
  //   同一列/同一片区域的两个面板同时展开会互相盖住 —— 靠 z-index 定序：后展开的压在上面；
  //   ⚠ 被完全盖住的那个面板，标题行的 ▲ 会点不到，得先收掉上面那个（横向并排的场景没这个问题）。
  try {
    const from = wrap.getBoundingClientRect();   // ① 原格子几何
    // ② 占位：同坐标同跨度的空格子，保证其它面板不动
    const slot = el('div', 'panel-slot');
    slot.style.gridColumn = wrap.style.gridColumn;
    slot.style.gridRow = wrap.style.gridRow;
    gridEl.insertBefore(slot, wrap);
    // ③ 目标几何：横向保持原位置与原宽度（以占位格为准），高度占满整格。
    //    ⚠ 必须用 position:fixed + 视口坐标：
    //    带 grid-column/grid-row 的网格项改成 absolute 后，**包含块是它自己那一格网格区**
    //    而不是整个网格 —— 用"相对网格的偏移"会再叠加一次格子起点，导致面板右移/下移一格
    //    （现象：面板"脱离场景"、跑到别的列还超出底边）。
    const g = gridEl.getBoundingClientRect();
    const s = slot.getBoundingClientRect();
    const to = { left: s.left, top: g.top, width: s.width, height: g.height };
    // ④ 先落到「起点」：fixed + 原格子几何（此刻不动画）
    wrap.style.position = 'fixed';
    wrap.style.zIndex = String(++panelExpandZ);   // 后展开的压住先展开的
    wrap.style.left = Math.round(from.left) + 'px';
    wrap.style.top = Math.round(from.top) + 'px';
    wrap.style.width = Math.round(from.width) + 'px';
    wrap.style.height = Math.round(from.height) + 'px';
    wrap.classList.add('panel-expanded');
    // ⑤ 聚焦层（全屏压暗 + 青色渐变）**已按用户要求关闭**：
    //    "光效要围绕着窗口，不是全屏都有" → 现在只保留环绕面板的常驻光环（见 styles.css 的 .panel-expanded）。
    //    想恢复全屏压暗：把下面三行取消注释即可（.grid-backdrop 的 CSS 仍在）。
    // const backdrop = el('div', 'grid-backdrop');
    // gridEl.appendChild(backdrop);
    // requestAnimationFrame(function () { try { backdrop.classList.add('on'); } catch (e) { /* ignore */ } });
    const backdrop = null;
    // ⑥ 过渡到满高：动画期间**贴底冻结** webview（内容原地不动、只重排 1 次），
    //    动画结束解冻 → 新增高度全部出现在输入框上方，看起来就是"展开显示上面的信息"。
    if (panelMotionOff()) {
      wrap.style.left = Math.round(to.left) + 'px';
      wrap.style.top = Math.round(to.top) + 'px';
      wrap.style.width = Math.round(to.width) + 'px';
      wrap.style.height = Math.round(to.height) + 'px';
    } else {
      const unfreeze = freezePanelWebviews(wrap);
      animatePanelBox(wrap, to, unfreeze);
    }
    btn.textContent = '▼';
    btn.title = '收起（恢复原来的高度）';
    // ⑦ 窗口尺寸变化时重新贴合（不带动画）；ESC 收起**最上层那个**（连按 = 逐个退栈）；
    //    面板若已被移出文档则自动清理（只清自己，别把别的面板一起收了）
    const onResize = () => {
      if (!wrap.isConnected) { collapsePanel(wrap); return; }
      try {
        wrap.classList.remove('panel-anim');
        const g2 = gridEl.getBoundingClientRect();
        const s2 = slot.getBoundingClientRect();
        wrap.style.left = Math.round(s2.left) + 'px';
        wrap.style.top = Math.round(g2.top) + 'px';
        wrap.style.width = Math.round(s2.width) + 'px';
        wrap.style.height = Math.round(g2.height) + 'px';
      } catch (e) { /* ignore */ }
    };
    const onKey = (e) => {
      if (!wrap.isConnected) { collapsePanel(wrap); return; }
      // 多个面板同时展开时，ESC 只收最上层那个（= 最后展开的），再按一次收下一个
      if (e.key === 'Escape' && panelExpandStates[panelExpandStates.length - 1] === st) collapsePanel(wrap);
    };
    window.addEventListener('resize', onResize);
    document.addEventListener('keydown', onKey, true);
    const st = { wrap, slot, btn, onResize, onKey, backdrop };
    panelExpandStates.push(st);
  } catch (e) { /* 展开失败就保持原状 */ }
}

function panelHead(title, sub) {
  const head = el('div', 'panel-head');
  head.appendChild(el('span', 'panel-title', title));
  if (sub) head.appendChild(el('span', 'panel-sub', sub));
  return head;
}

function makePanel(meta, idx) {
  const wrap = el('section', 'panel');
  // 面板元素上挂一份 meta：拖拽结束后的「排格 + 补洞」（packAutoGrid）要按它算坐标与跨度
  wrap.__meta = meta;
  // 显式坐标（meta.col/meta.row）+ 尺寸：合并成完整简写（如 "2 / span 3"）。
  // 注意：不能先设 gridRow="span N" 再覆盖 gridRowStart —— start 覆盖后 end 变 auto，高度会塌成 1 行。
  wrap.style.gridColumn = (meta.col ? meta.col + ' / span ' : 'span ') + (meta.w || 2);
  wrap.style.gridRow = (meta.row ? meta.row + ' / span ' : 'span ') + (meta.h || 2);
  wrap.dataset.panelId = meta.id;
  const head = panelHead(meta.title, meta.sub || '');
  // 面板序号徽标（方便用户指定要修改哪个窗口）——两位补零，配合 .panel-badge 科技感样式
  const badge = el('span', 'panel-badge', String(idx + 1).padStart(2, '0'));
  badge.title = '面板序号';
  head.insertBefore(badge, head.firstChild);
  // 「展开到最高」箭头：AI 面板（harness）默认就有；别的类型想有就在场景 json 里写 "expand": true
  // （放标题**右边**、不居中——居中会撞上右侧的重新加载按钮/引擎状态字，Blender 面板尤其明显）。
  // 展开逻辑与本按钮无关（expandPanel 是通用的：占位格 + position:fixed 撑满整个网格高度），
  // 所以 embed 这类面板一样能"向上展开"：动画期间 webview 贴底冻结，新增高度出现在内容上方。
  if (meta.type === 'harness' || meta.expand) {
    const exp = el('button', 'panel-expand', '▲');
    exp.type = 'button';
    exp.title = '展开到最高（再点一次收起）';
    exp.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      if (expandedStateOf(wrap)) collapsePanel(wrap);
      else expandPanel(wrap, exp);
    });
    const titleEl = head.querySelector('.panel-title');
    if (titleEl && titleEl.nextSibling) head.insertBefore(exp, titleEl.nextSibling);
    else head.appendChild(exp);
  }
  wrap.appendChild(head);
  const body = el('div', 'panel-body');
  body.dataset.kind = meta.type;
  wrap.appendChild(body);
  // 自由拖拽缩放已取消（用户要求固定布局）；attachResize 定义保留备用
  // if (!meta.fixed) attachResize(wrap, meta);
  return { wrap, body, head };
}

// ---------- 面板自由拖拽调大小（四边/四角，相邻上下左右可调） ----------
// 调节上限 = 整个工作区（#grid）大小：宽不超过总列数，高不超过网格总行数
var GRID_COLS = 4;   // 与 #grid 的 grid-template-columns 一致（总窗口列数；场景 json 可用 cols 覆写）

// 当前场景实际的网格列数：renderer.js 会按场景 json 的 cols 覆写 #grid 的内联 grid-template-columns。
function gridColsOf(gridEl) {
  try {
    const t = ((gridEl || document.getElementById('grid')).style.gridTemplateColumns || '');
    const m = /repeat\(\s*(\d+)/.exec(t);
    if (m) return Math.max(1, parseInt(m[1], 10));
  } catch (e) { /* ignore */ }
  return GRID_COLS;
}

// 网格总行数（所有面板 meta.row + meta.h 的最大值）。
function gridRowCount(gridEl) {
  const grid = gridEl || document.getElementById('grid');
  if (!grid) return 1;
  let rows = 1;
  Array.prototype.forEach.call(grid.children, function (p) {
    const m = p && p.__meta;
    if (!m || !m.row) return;
    rows = Math.max(rows, (Number(m.row) || 1) + (Number(m.h) || 2) - 1);
  });
  return Math.max(1, rows);
}

// 一格的实际像素宽度 / 高度：把鼠标位移换算成"格"。
// 优先按面板自身尺寸推算（最准）；面板还没排好时（clientWidth/Height 为 0）退回按网格实测算 ——
// 分母是 0 会让一次轻拖直接跨好几格（2026-09-26：独立窗口里 AI 面板被拖成整行宽就是这个坑）。
function gridCellW(panel) {
  try {
    const m = panel && panel.__meta;
    if (m && m.w && panel.clientWidth > 24) return panel.clientWidth / m.w;
  } catch (e) { /* ignore */ }
  const grid = document.getElementById('grid');
  if (!grid) return 200;
  const gap = parseFloat(getComputedStyle(grid).columnGap) || 10;
  const cols = gridColsOf(grid);
  return Math.max(30, (grid.getBoundingClientRect().width - gap * (cols - 1)) / cols);
}

function gridCellH(panel) {
  try {
    const m = panel && panel.__meta;
    if (m && m.h && panel.clientHeight > 24) return panel.clientHeight / m.h;
  } catch (e) { /* ignore */ }
  const grid = document.getElementById('grid');
  if (!grid) return 100;
  const gap = parseFloat(getComputedStyle(grid).rowGap) || 10;
  const rows = gridRowCount(grid);
  return Math.max(24, (grid.getBoundingClientRect().height - gap * (rows - 1)) / rows);
}

// ---------- 纯自动流场景的排格器：紧凑首适配 + 拉伸补洞 ----------
// 背景（2026-09-26 用户截图）：json 里一个 col/row 都没写的场景（当前只有 oa-ops）原本交给 CSS 自动流排，
//   而 CSS 的规则是"这一排放不下就往下挪" —— 把 AI 面板拖成整行宽（4 列）后，第 3-4 行（列 1 被
//   「网址」这个 1 列 2 行的面板占着）放不下它 ⇒ AI 面板被挪到第 5-6 行，第 3-4 行列 2-4 空成一个大洞，
//   网格也从 4 行变 6 行 ⇒ 每行只剩 1/6 高，**所有面板一起被压扁、内容被裁**（服务器状态/操作日志/本地文件全截断）。
// 做法：自己按 DOM 顺序做紧凑首适配（等价 CSS 稀疏自动流），排完再把"每条行带右侧空出来的格子"
//   拉伸给该带上的面板 ⇒ 拖大拖小都不留空洞；拖拽期间面板按 meta.col 原地改大小，不再整场洗牌。
// 幂等：只处理"没有 col/row，或由本函数排过（__autoPacked）"的面板，每次从 meta.w/meta.h 重算；
//   拉伸出来的宽度**不写回 meta.w**（只影响本次显示），所以把面板拖回原样时布局能自己复原。
function packAutoGrid(grid) {
  grid = grid || document.getElementById('grid');
  if (!grid) return;
  // 顺手清掉残留的"展开占位格"：正常收起时就删了，热更新/异常时可能留下一个透明空格子（看不见但占着格子）
  Array.prototype.forEach.call(grid.querySelectorAll('.panel-slot'), function (s) {
    let owned = false;
    for (let i = 0; i < panelExpandStates.length; i++) if (panelExpandStates[i].slot === s) { owned = true; break; }
    if (!owned) { try { s.parentNode.removeChild(s); } catch (e) { /* ignore */ } }
  });
  const cols = gridColsOf(grid);
  const kids = Array.prototype.filter.call(grid.children, function (n) {
    return n && n.classList && n.classList.contains('panel') && n.__meta;
  });
  if (!kids.length) return;
  for (let i = 0; i < kids.length; i++) {
    const m = kids[i].__meta;
    if ((Number(m.col) || 0) > 0 && !m.__autoPacked) return;   // 有手写坐标 = 设计好的布局，一个字都别动
  }
  const occ = Object.create(null);
  const mark = function (r, c, w, h, v) {
    for (let i2 = r; i2 < r + h; i2++) for (let j = c; j < c + w; j++) occ[i2 + ',' + j] = v;
  };
  const free = function (r, c, w, h) {
    for (let i2 = r; i2 < r + h; i2++) for (let j = c; j < c + w; j++) if (occ[i2 + ',' + j]) return false;
    return true;
  };
  const placed = [];
  let cursor = 0;   // 线性游标（行主序）——等价 CSS 稀疏自动流：每块从"上一块的位置"接着找
  for (let i = 0; i < kids.length; i++) {
    const meta = kids[i].__meta;
    const w = Math.max(1, Math.min(cols, Number(meta.w) || 2));
    const h = Math.max(1, Number(meta.h) || 2);
    for (let idx = cursor, guard = 0; guard < 10000; idx++, guard++) {
      const r = Math.floor(idx / cols), c = idx % cols;
      if (c + w > cols) { cursor = (r + 1) * cols; idx = cursor - 1; continue; }
      if (free(r, c, w, h)) {
        mark(r, c, w, h, 1);
        placed.push({ el: kids[i], meta: meta, r: r, c: c, w: w, h: h });
        cursor = idx;
        break;
      }
    }
  }
  // 补洞：某面板右侧、在它自己跨的每一行里都空着 ⇒ 拉到最后一列（宽度只影响显示，不写回 meta.w）
  for (let q = 0; q < placed.length; q++) {
    const it = placed[q];
    let ok = true;
    for (let rr = it.r; rr < it.r + it.h && ok; rr++) {
      for (let cc = it.c + it.w; cc < cols; cc++) if (occ[rr + ',' + cc]) { ok = false; break; }
    }
    if (!ok) continue;
    const grow = cols - it.c;
    if (grow > it.w) { mark(it.r, it.c, it.w, it.h, 0); it.w = grow; mark(it.r, it.c, it.w, it.h, 1); }
  }
  for (let z = 0; z < placed.length; z++) {
    const it = placed[z];
    it.meta.col = it.c + 1; it.meta.row = it.r + 1; it.meta.__autoPacked = 1;
    it.el.style.gridColumn = (it.c + 1) + ' / span ' + it.w;
    it.el.style.gridRow = (it.r + 1) + ' / span ' + it.h;
  }
}
function attachResize(wrap, meta) {
  // 8 个方向手柄：n/s/e/w/ne/nw/se/sw（透明热区，无可见角标）
  const HANDLES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
  const handles = {};
  HANDLES.forEach(dir => {
    const h = el('div', 'panel-handle p-h-' + dir);
    h.title = '拖拽调整大小';
    wrap.appendChild(h);
    handles[dir] = h;
  });

  let drag = null;   // { dir, startX, startY, curW, curH, maxRows }

  // 当前网格总行数：所有面板占据的最大行范围（拖拽起点快照，作为高度上限）
  const gridRows = () => {
    const grid = document.getElementById('grid');
    if (!grid) return 1;
    const panels = grid.querySelectorAll('.panel');
    if (!panels.length) return 1;
    const rowH = panels[0].offsetHeight || 100;
    let maxBottom = 0;
    panels.forEach(p => { maxBottom = Math.max(maxBottom, p.offsetTop + p.offsetHeight); });
    return Math.max(1, Math.round(maxBottom / rowH));
  };

  const apply = (w, h) => {
    // ⚠ 必须保留显式锚点（meta.col/meta.row）：原来这里写死 `span N`，一拖就把面板变成"自动流"，
    //   整个场景重新洗牌（面板乱跳、留空洞、行数变多把所有面板压扁）——与 makePanel 里的写法保持一致。
    const col = Number(meta.col) || 0, row = Number(meta.row) || 0;
    // 宽度不能越过最后一列：越过会生出隐式列（按内容宽排）⇒ 整场比例全乱（renderer.js 里有同样的兜底告警）。
    const cols = gridColsOf(document.getElementById('grid'));
    const maxW = col ? Math.max(1, cols - col + 1) : cols;
    w = Math.max(1, Math.min(maxW, Math.round(w) || 1));
    h = Math.max(1, Math.round(h) || 1);
    wrap.style.gridColumn = (col ? col + ' / span ' : 'span ') + w;
    wrap.style.gridRow = (row ? row + ' / span ' : 'span ') + h;
    meta.w = w; meta.h = h;   // 记住，切换场景回来保持
  };

  const startDrag = (dir, e) => {
    e.preventDefault();
    e.stopPropagation();
    drag = {
      dir,
      startX: e.clientX,
      startY: e.clientY,
      curW: Math.min(meta.w || 2, GRID_COLS),
      curH: meta.h || 2,
      maxRows: gridRows()   // 快照总窗口行数，拖拽过程高度不超它
    };
    wrap.classList.add('resizing');
    // 对应方向的光标
    const cursors = {
      n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
      ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize'
    };
    document.body.style.cursor = cursors[dir] || 'default';
  };

  HANDLES.forEach(dir => {
    handles[dir].addEventListener('mousedown', (e) => startDrag(dir, e));
  });

  // rAF 节流：保证拖拽丝滑（60fps 跟随鼠标，不卡顿）
  let raf = null;
  window.addEventListener('mousemove', (e) => {
    if (!drag || raf) return;
    raf = requestAnimationFrame(() => {
      raf = null;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      // 每列/每行像素：走 gridCellW/H（面板自身尺寸为 0 时自动退回按网格实测），
      // 避免"分母是 0 ⇒ 一次轻拖跨好几格"（独立窗口里 AI 面板被拖成整行宽的真凶）
      const cellW = gridCellW(wrap);
      const cellH = gridCellH(wrap);
      let nextW = drag.curW, nextH = drag.curH;
      const d = drag.dir;
      // 整数格步进（CSS grid span 只支持整数）+ rAF 节流保证跟手不卡顿
      if (d.includes('e')) nextW = Math.round(drag.curW + dx / Math.max(cellW, 1));
      if (d.includes('w')) nextW = Math.round(drag.curW - dx / Math.max(cellW, 1));
      if (d.includes('s')) nextH = Math.round(drag.curH + dy / Math.max(cellH, 1));
      if (d.includes('n')) nextH = Math.round(drag.curH - dy / Math.max(cellH, 1));
      // 上限 = 总窗口大小（宽 ≤ 总列数，高 ≤ 总行数）；下限 = 1 格
      nextW = Math.max(1, Math.min(GRID_COLS, nextW));
      nextH = Math.max(1, Math.min(drag.maxRows, nextH));
      if (nextW !== drag.curW || nextH !== drag.curH) {
        drag.curW = nextW; drag.curH = nextH;
        apply(nextW, nextH);
      }
    });
  });

  window.addEventListener('mouseup', () => {
    if (!drag) return;
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    drag = null;
    wrap.classList.remove('resizing');
    document.body.style.cursor = '';
    // 拖完立刻"整理"：这次改大小留下的空格子会被拉伸补掉（纯自动流场景，见 packAutoGrid）
    try { packAutoGrid(document.getElementById('grid')); } catch (e) { /* ignore */ }
  });
}

// ══ 演示脱敏（2026-09-27 用户要求）：录屏时实例名/公网地址不该露全，点「眼睛」一键遮住中间 ══
// ⚠ 这里**必须是一个函数，不能是顶层 `const OA_MASK_KEY = '…'`**（2026-09-27 多画布那批改的）：
//   本文件是热更新的 —— 点 ⟳ 会在**同一个全局上下文**里把整份脚本重新求值一次，
//   顶层 const/let（以及**同名** var）会和上一次那份留下的词法绑定撞车 ⇒
//   "Identifier 'OA_MASK_KEY' has already been declared" ⇒ 整份脚本不执行、⟳ **静默失效**
//   （Chromium 对"脚本解析失败"不发 script.onerror，壳那边连"渲染器热更新失败"都不会报，最坑的一种坏法）。
//   函数声明可以重复求值（var 语义），所以 key 走函数取；**改这一处前先看 check-gui 第 4 项与多画布探针 ⑩**。
function oaMaskKey() { return 'oa-demo-mask'; }
function oaMasked() { try { return localStorage.getItem(oaMaskKey()) === '1'; } catch (e) { return false; } }
/** 把 example.com → 47.108.•••.••• */
function oaMaskIpHint(t) {
  return String(t == null ? '' : t).replace(/(\d{1,3}\.\d{1,3})\.\d{1,3}\.\d{1,3}/g, '$1.•••.•••');
}
/** 把 iZ2vcc7tgt0vdwyopm11mtZ (example.com) → iZ2vcc••••1mtZ (47.108.•••.•••) */
function oaMaskText(v) {
  if (!v) return v;
  const str = String(v);
  const m = str.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  const head = (m ? m[1] : str).trim();
  const ip = m ? m[2] : '';
  const mid = (t) => (t.length > 10 ? t.slice(0, 6) + '••••' + t.slice(-4) : t);
  let out;
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(head)) out = oaMaskIpHint(head);
  else if (/^[A-Za-z0-9._-]{12,}$/.test(head)) out = mid(head);
  else out = head;   // 纯中文提示（如「未配置服务器」）原样，不遮
  if (ip) out += ' (' + oaMaskIpHint(ip) + ')';
  return out;
}
/** 极简线性眼睛：睁开=当前完整，带斜杠=当前已遮住 */
function oaEyeIcon(on) {
  const eye = '<path d="M1.7 10S4.9 5.5 10 5.5 18.3 10 18.3 10 15.1 14.5 10 14.5 1.7 10 1.7 10Z"/><circle cx="10" cy="10" r="2.1"/>';
  const slash = '<path d="M3.7 16.3 16.3 3.7"/>';
  return '<svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">' + eye + (on ? slash : '') + '</svg>';
}
/** 点眼睛：切换遮/显，立即应用，并写进 localStorage（另一个面板下次重绘会跟上） */
function oaToggleMask(btn, apply) {
  const on = !oaMasked();
  try { localStorage.setItem(oaMaskKey(), on ? '1' : '0'); } catch (e) { /* ignore */ }
  btn.innerHTML = oaEyeIcon(on);
  btn.title = on ? '显示完整（当前已遮住）' : '遮住实例名/地址（录屏用）';
  apply();
}

// ============ dash：服务器状态（SSH 已连接 → 真实数据轮询；未连接 → oa-store 演示快照） ============
renderers.dash = (body, meta, head) => {
  oaSyncScenario(meta);   // 多公司模板：确保主进程用的是"本场景"的服务器配置
  const fallback = {
    host: 'prod-oa-01 (<内网IP>)',
    os: 'Ubuntu 22.04 LTS',
    uptime: '36 天 4 小时',
    cpu: 23, mem: 41, disk: 58,
    services: [
      { name: 'nginx', state: 'running', ok: true },
      { name: 'oa-app (gunicorn)', state: 'running', ok: true },
      { name: 'postgresql', state: 'running', ok: true },
      { name: 'redis', state: 'running', ok: true },
      { name: 'celery-worker', state: 'down', ok: false }
    ]
  };
  // 标题右侧连接徽标：🔴 实时 / 🟡 演示数据
  const badge = el('span', 'panel-sub dash-badge', '…');
  if (head) head.appendChild(badge);
  // 刷新周期小字：紧跟"实时"徽标（只显示秒数，省标题行空间）
  const refreshNote = el('span', 'stat-refresh', '20秒');
  if (head) head.appendChild(refreshNote); else body.appendChild(refreshNote);
  // 手动刷新按钮（放标题行最右）
  const dashRefresh = el('button', 'file-refresh', '🔄 刷新');
  dashRefresh.title = '立即采集服务器状态（不等自动周期）';
  dashRefresh.addEventListener('click', () => {
    dashRefresh.disabled = true;
    dashRefresh.textContent = '采集中…';
    tick(true, () => { dashRefresh.disabled = false; dashRefresh.textContent = '🔄 刷新'; });
  });
  if (head) {
    const acts = el('div', 'file-head-acts');
    acts.appendChild(dashRefresh);
    head.appendChild(acts);
  }
  // 运行时间一目了然，紧凑且保留分钟；天数很大时自动压缩防溢出：
  // 'up 1 week, 3 hours, 12 minutes' → '7天3时12分'；≥100 天 → 'N天N时'；超 1 年 → 'N年N天'
  const fmtUptime = (s) => {
    if (!s) return '--';
    const t = String(s);
    const grab = (re) => { const mm = t.match(re); return mm ? parseFloat(mm[1]) : 0; };
    const y = Math.floor(grab(/([\d.]+)\s*(?:years?|年)/));
    const mo = Math.floor(grab(/([\d.]+)\s*(?:months?|月)/));
    const d = Math.floor(grab(/([\d.]+)\s*(?:days?|天)/)) + Math.floor(grab(/([\d.]+)\s*(?:weeks?|周)/)) * 7;
    const h = Math.floor(grab(/([\d.]+)\s*(?:hours?|小时|时)/));
    let m = Math.floor(grab(/([\d.]+)\s*(?:minutes?|分钟|分)/));
    const sec = grab(/([\d.]+)\s*(?:secs?|秒)/);
    if (!y && !mo && !d && !h && !m && sec) m = Math.floor(sec / 60) || 1;
    if (y > 0) {
      const rd = mo * 30 + d;
      return rd ? y + '年' + rd + '天' : y + '年';
    }
    if (d >= 100) return d + '天' + (h ? h + '时' : '');
    if (d > 0) return d + '天' + (h ? h + '时' : '') + (m ? m + '分' : '');
    if (h > 0) return h + '时' + (m ? m + '分' : '');
    return m ? m + '分钟' : (sec ? sec + '秒' : t);
  };
  const paint = (s) => {
    body.innerHTML = '';
    const connected = !!(s && s.connected);
    badge.textContent = connected ? '🔴 实时' : '🟡 演示数据';
    badge.title = connected
      ? '已通过 SSH 连接真实服务器（每 20 秒自动刷新）'
      : '未连接真实服务器（配置 SSH 后自动切换实时）';
    // 顶部：主机 · 系统 · 端口
    const top = el('div', 'stat-top');
    const hostRaw = s.host || '未配置服务器';
    const hostEl = el('span', 'stat-host', oaMasked() ? oaMaskText(hostRaw) : hostRaw);
    const hostEye = el('button', 'stat-eye', '');
    hostEye.type = 'button';
    hostEye.innerHTML = oaEyeIcon(oaMasked());
    hostEye.title = oaMasked() ? '显示完整（当前已遮住）' : '遮住实例名/地址（录屏用）';
    hostEye.addEventListener('click', (ev) => {
      ev.stopPropagation();
      oaToggleMask(hostEye, () => { hostEl.textContent = oaMasked() ? oaMaskText(hostRaw) : hostRaw; });
    });
    top.appendChild(hostEl);
    top.appendChild(hostEye);
    top.appendChild(el('span', 'stat-os', s.os || ''));
    body.appendChild(top);
    // 指标卡片（带彩色占用进度条）
    const grid = el('div', 'stat-grid');
    const card = (label, val, pct) => {
      const c = el('div', 'stat-card');
      c.appendChild(el('div', 'stat-label', label));
      c.appendChild(el('div', 'stat-value', val));
      if (pct != null) {
        const bar = el('div', 'stat-bar');
        const fill = el('div', 'stat-bar-fill ' + (pct >= 80 ? 'hi' : pct >= 50 ? 'mid' : 'lo'));
        fill.style.width = Math.min(100, Math.max(0, pct)) + '%';
        bar.appendChild(fill);
        c.appendChild(bar);
      }
      return c;
    };
    grid.appendChild(card('CPU', (s.cpu != null ? s.cpu : '--') + '%', s.cpu));
    grid.appendChild(card('内存', (s.mem != null ? s.mem : '--') + '%', s.mem));
    grid.appendChild(card('磁盘', (s.disk != null ? s.disk : '--') + '%', s.disk));
    grid.appendChild(card('运行时间', fmtUptime(s.uptime)));
    body.appendChild(grid);
    // 服务状态
    const list = el('div', 'svc-list');
    (s.services || []).forEach(svc => {
      const row = el('div', 'svc-row');
      row.appendChild(el('span', 'svc-name', svc.name));
      row.appendChild(el('span', 'tag ' + (svc.ok ? 'ok' : 'err'), svc.state || (svc.ok ? 'running' : 'down')));
      list.appendChild(row);
    });
    body.appendChild(list);
    // 端口放内容最底部：录屏时不滚到底就看不到（2026-09-27 用户要求）
    if (connected && Array.isArray(s.ports) && s.ports.length) {
      body.appendChild(el('div', 'stat-foot', '端口 ' + s.ports.join(' · ')));
    }
    refreshNote.textContent = connected ? '20秒' : '';
  };
  const K = window.app && window.app.oa;
  if (!K) { paint(fallback); return; }
  let disposed = false;
  const tick = (force, done) => {
    K.status(force).then(s => { if (!disposed) paint(s || fallback); if (done) done(); })
      .catch(() => { if (!disposed) paint(fallback); if (done) done(); });
  };
  tick(false);
  // 自动轮询 20s（主进程 15s TTL 去重）；窗口不可见时暂停，回来自动补一次
  const stopPoll = oaPoll(20000, () => tick(false));
  // 场景隔离：切走场景后停止轮询
  return () => { disposed = true; stopPoll(); };
};

// ============ shell：终端 / Python 数据脚本 ============
renderers.shell = (body, meta, head) => {
  oaSyncScenario(meta);
  // Python 数据脚本模式（股票场景 mk-script）：运行真实 akshare/baostock 脚本
  if (meta && meta.mode === 'python') return renderPythonShell(body);

  // 默认：OA 运维终端（命令经 oa:shell:exec 记录并返回结果；SSH 已连接则真实执行）
  const K = window.app && window.app.oa;
  // 连接状态提示：放在标题行（SSH 终端 之后），不占内容区
  const hint = el('div', 'term-hint', '🔌 检测连接状态…');
  const setHint = (raw) => {
    hint.dataset.raw = raw;
    hint.textContent = oaMasked() ? oaMaskIpHint(raw) : raw;
  };
  if (head) head.appendChild(hint); else body.appendChild(hint);
  // 眼睛：一键遮住标题里的主机地址（录屏用）
  const shellEye = el('button', 'stat-eye', '');
  shellEye.type = 'button';
  shellEye.innerHTML = oaEyeIcon(oaMasked());
  shellEye.title = oaMasked() ? '显示完整（当前已遮住）' : '遮住实例名/地址（录屏用）';
  shellEye.addEventListener('click', (ev) => {
    ev.stopPropagation();
    oaToggleMask(shellEye, () => { hint.textContent = oaMasked() ? oaMaskIpHint(hint.dataset.raw || '') : (hint.dataset.raw || ''); });
  });
  if (head) head.appendChild(shellEye); else body.appendChild(shellEye);
  if (K) {
    K.ssh.status().then(r => {
      if (r && r.ready) {
        setHint('🔌 已连接 ' + ((r.user || '') + '@' + (r.host || '') + (r.port ? ':' + r.port : '')) + ' · 命令将真实执行');
      } else if (r && r.host) {
        setHint('🔌 服务器 ' + r.host + ' 已配置，但未设密码（环境变量 SSH_PASS 或配置 ssh.credential）· 演示模式');
      } else {
        setHint('🔌 未配置服务器 · 演示模式');
      }
    }).catch(() => { setHint('🔌 连接状态未知'); });
  } else {
    setHint('🔌 演示模式');
  }

  const term = el('div', 'term');
  // 真实终端：不再写死假输出，只留一行状态提示（内容始终滚到最底部，随时可输入）
  term.appendChild(el('div', 'term-line term-welcome', '输入命令后回车执行（已连接则在服务器真实执行）'));
  const inputWrap = el('div', 'term-line term-input');
  inputWrap.appendChild(el('span', 'term-prompt', 'root@prod-oa-01:~$ '));
  const input = document.createElement('input');
  input.className = 'term-field';
  input.placeholder = '输入命令（SSH 已连接则真实执行）…';
  inputWrap.appendChild(input);
  term.appendChild(inputWrap);
  // 手动输入与助手注入共用同一执行路径（保证终端可见、操作日志可查）
  let shellBusy = false;
  let agentTimer = null;   // 助手命令轮询（2s），场景切换时清理
  const execAndShow = (cmd, mark, done) => {
    if (shellBusy || !cmd) return;
    shellBusy = true;
    term.insertBefore(el('div', 'term-line' + (mark ? ' agent' : ''), (mark ? '🤖 助手$ ' : '') + cmd), inputWrap);
    input.value = '';
    const finish = (r) => { shellBusy = false; if (done) done(r); };
    if (K) {
      K.shell.exec(cmd).then(r => {
        const out = (r && r.ok) ? (r.out || '') : ('执行失败: ' + ((r && r.err) || '未知错误'));
        String(out).split('\n').forEach(l => {
          if (l.trim()) term.insertBefore(el('div', 'term-line', l), inputWrap);
        });
        term.scrollTop = term.scrollHeight;
        finish(r);
      }).catch(() => {
        term.insertBefore(el('div', 'term-line', '（本地助手不可用，命令未执行）'), inputWrap);
        term.scrollTop = term.scrollHeight;
        finish({ ok: false, err: '本地助手不可用' });
      });
    } else {
      finish({ ok: false, err: '本地助手不可用' });
    }
    term.scrollTop = term.scrollHeight;
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && input.value.trim()) execAndShow(input.value.trim(), false, null);
  });
  // 助手命令通道：轮询 inbox，拾取后以 🤖 标记执行并回写结果
  const KA = K && K.agent;
  if (KA) {
    const pollAgent = () => {
      if (shellBusy) return;
      KA.dequeue().then(q => {
        if (!q || !q.cmd) return;
        execAndShow(q.cmd, true, (r) => {
          KA.ack({ seq: q.seq, ok: !!(r && r.ok), out: (r && r.out) || '', err: (r && r.err) || '' });
        });
      }).catch(() => { });
    };
    agentTimer = setInterval(pollAgent, 400);   // 2026-10-19 宿主：「工作好久才亮」⇒ 2000 → 400ms（上界 0.4s，仍远高于派单的 200ms 下限）
    pollAgent();
  }
  body.appendChild(term);
  // ★ 开面板/输出后都滚到最底部，保证输入行始终可见
  const toBottom = () => { try { term.scrollTop = term.scrollHeight; } catch (e) {} };
  toBottom();
  setTimeout(toBottom, 50);
  setTimeout(toBottom, 300);
  input.addEventListener('focus', toBottom);
  // 场景切换清理：停止助手命令轮询（避免切走后仍每 2s 打 IPC）
  return () => { if (agentTimer) clearInterval(agentTimer); };
};

// ---- Python 数据脚本运行器（真实执行 akshare / baostock）----
function renderPythonShell(body) {
  const K = window.app.stock;

  // 内置实用脚本（A股为主，美股为辅）
  const SCRIPTS = {
    '自选实时行情 (A股)': `
# -*- coding: utf-8 -*-
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
from contextlib import redirect_stdout, redirect_stderr
import os
os.environ['TQDM_DISABLE'] = '1'
import akshare as ak
with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
    df = ak.stock_zh_a_spot()
cols = ['代码','名称','最新价','涨跌幅','涨跌额','成交量','成交额']
df = df[cols].head(20)
print(df.to_string(index=False))
`,
    '我的自选股行情': `
# -*- coding: utf-8 -*-
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
from contextlib import redirect_stdout, redirect_stderr
import os
os.environ['TQDM_DISABLE'] = '1'
import akshare as ak
with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
    df = ak.stock_zh_a_spot()
df = df.set_index('代码')
for code in ['600519','300750','002594','688981','600036']:
    if code in df.index:
        r = df.loc[code]
        print(f"{r['名称']} {code} 最新 {r['最新价']} 涨跌 {r['涨跌幅']}%")
`,
    '个股日K (baostock)': `
# -*- coding: utf-8 -*-
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
import baostock as bs
lg = bs.login()
rs = bs.query_history_k_data_plus('sh.600519',
    'date,code,open,high,low,close,volume',
    start_date='2025-08-01', end_date='2025-09-06',
    frequency='d', adjustflag='2')
rows = []
while rs.error_code == '0' and rs.next():
    rows.append(rs.get_row_data())
print(f"贵州茅台 近 {len(rows)} 根日K：")
for r in rows[-5:]:
    print(' '.join(r))
bs.logout()
`,
    '大盘指数': `
# -*- coding: utf-8 -*-
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
# 屏蔽 tqdm 进度条噪音
from contextlib import redirect_stderr, redirect_stdout
import os
os.environ['TQDM_DISABLE'] = '1'
import akshare as ak
with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
    df = ak.stock_zh_index_spot_sina()
for code in ['sh000001','sz399001','sz399006']:
    r = df[df['代码']==code]
    if len(r):
        x = r.iloc[0]
        print(f"{x['名称']} {x['最新价']} {x['涨跌幅']}%")
`
  };

  // 顶部：脚本选择按钮
  const bar = el('div', 'py-bar');
  Object.keys(SCRIPTS).forEach(name => {
    const b = el('button', 'py-btn', name);
    b.addEventListener('click', async () => {
      bar.querySelectorAll('.py-btn').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      await run(SCRIPTS[name]);
    });
    bar.appendChild(b);
  });
  body.appendChild(bar);

  // 输出区
  const out = el('div', 'py-out');
  out.appendChild(el('div', 'py-line dim', '选择上方脚本运行真实 Python 数据源（akshare / baostock）。A股为主。'));
  body.appendChild(out);

  const run = async (script) => {
    out.innerHTML = '';
    out.appendChild(el('div', 'py-line dim', '⏳ 运行中…'));
    try {
      const r = await K.script.run(script);
      out.innerHTML = '';
      if (r.out) {
        r.out.split('\n').forEach(l => {
          if (l.trim()) out.appendChild(el('div', 'py-line', l));
        });
      }
      if (r.err) {
        r.err.split('\n').forEach(l => {
          if (l.trim()) out.appendChild(el('div', 'py-line err', l));
        });
      }
      if (!r.out && !r.err) out.appendChild(el('div', 'py-line dim', '(无输出)'));
    } catch (e) {
      out.appendChild(el('div', 'py-line err', '执行失败: ' + e.message));
    }
  };
}

// ============ file：本地 / 云端文件 · 实时同步（左右分栏 + mtime/size 同步状态） ============
renderers.file = (body, meta, head) => {
  oaSyncScenario(meta);
  const K = window.app && window.app.oa;
  body.classList.add('file-panel');

  // ---- 工具 ----
  const fmtSize = (n) => {
    if (n == null) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  };
  const fmtTime = (t) => {
    if (!t) return '—';
    const d = new Date(t * 1000);
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  };
  const joinPath = (a, b) => (/[\\/]$/.test(a) ? a + b : a + '/' + b);
  const parentPath = (p) => {
    const norm = String(p).replace(/[\\/]+$/, '');
    const idx = Math.max(norm.lastIndexOf('/'), norm.lastIndexOf('\\'));
    return idx > 0 ? norm.slice(0, idx) : norm;
  };

  // ---- 工具按钮（放进面板标题那一行：刷新 + 同步按钮开关）----
  const refreshBtn = el('button', 'file-refresh', '🔄 刷新');
  refreshBtn.title = '手动刷新文件列表与同步状态';
  refreshBtn.addEventListener('click', () => {
    refreshBtn.disabled = true;
    refreshBtn.textContent = '刷新中…';
    Promise.all([
      Promise.resolve(loadSync(true)),
      Promise.resolve(loadLocal(localPath)),
      Promise.resolve(loadCloud(cloudPath, true))
    ]).then(() => { refreshBtn.disabled = false; refreshBtn.textContent = '🔄 刷新'; })
      .catch(() => { refreshBtn.disabled = false; refreshBtn.textContent = '🔄 刷新'; });
  });
  // 同步按钮开关（默认隐藏推送/拉取按钮，防止误点；打开后才显示）
  let showSyncActs = false;
  const syncToggle = el('button', 'file-refresh sync-toggle off', '🔒 同步');
  syncToggle.title = '默认隐藏推送/拉取按钮，防止误点；打开后显示 ↑推送 / ↓拉取';
  syncToggle.addEventListener('click', () => {
    showSyncActs = !showSyncActs;
    syncToggle.textContent = showSyncActs ? '🔓 同步' : '🔒 同步';
    syncToggle.classList.toggle('on', showSyncActs);
    syncToggle.classList.toggle('off', !showSyncActs);
    loadSync();   // 重绘（含推送/拉取按钮显隐）
  });
  if (head) {
    head.classList.add('file-head');
    head.appendChild(el('span', 'stat-refresh', K ? '30秒' : '演示'));
    const headActs = el('div', 'file-head-acts');
    headActs.appendChild(refreshBtn);
    headActs.appendChild(syncToggle);
    head.appendChild(headActs);
  }

  // ---- 四个同步段（后端 / 管理后台 / 教师 / 家长 排成一行）----
  const segs = el('div', 'sync-segs');
  body.appendChild(segs);
  const msgEl = el('div', 'sync-msg', '');
  body.appendChild(msgEl);

  // ---- 左右两栏 ----
  const mkCol = (titleText) => {
    const root = el('div', 'file-col');
    const head = el('div', 'file-col-head');
    head.appendChild(el('span', 'file-col-title', titleText));
    const jumps = el('div', 'file-jumps');
    head.appendChild(jumps);
    root.appendChild(head);
    const crumbs = el('div', 'file-crumbs', '…');
    root.appendChild(crumbs);
    const list = el('div', 'file-list');
    root.appendChild(list);
    return { root, head, jumps, crumbs, list };
  };
  const localCol = mkCol('📁 本地');
  const cloudCol = mkCol('☁️ 云端');
  const cols = el('div', 'file-cols');
  cols.appendChild(localCol.root);
  cols.appendChild(cloudCol.root);
  body.appendChild(cols);

  // ---- 行 ----
  const mkRow = (ic, name, metaText, isDir, onOpen) => {
    const r = el('div', 'file-row' + (isDir ? ' dir' : ''));
    r.appendChild(el('span', 'file-ic', ic));
    r.appendChild(el('span', 'file-name', name));
    r.appendChild(el('span', 'file-meta', metaText));
    if (isDir) { r.title = '点击进入'; r.style.cursor = 'pointer'; }
    if (onOpen) r.addEventListener('click', onOpen);
    return r;
  };
  const mkEmpty = (txt) => el('div', 'file-empty', txt);

  let localPath = null, cloudPath = null, paths = null;
  let disposed = false;

  // ---- 同步状态（实时） ----
  const buildTitle = (m) => {
    if (m.status === 'missing-local') return '本地目录不存在：' + m.local;
    if (m.status === 'missing-remote') return '云端目录不存在：' + m.remote;
    if (m.inSync) return m.label + ' 已同步（本地 ' + m.localCount + ' · 云端 ' + m.remoteCount + ' 个文件）';
    let s = m.label + ' 待同步（本地 ' + m.localCount + ' · 云端 ' + m.remoteCount + ' 个文件）';
    if (m.push && m.push.length) s += '\n\n⬆️ 需推送（本地更新）：\n' + m.push.slice(0, 20).join('\n');
    if (m.pull && m.pull.length) s += '\n\n⬇️ 需拉取（云端更新）：\n' + m.pull.slice(0, 20).join('\n');
    return s;
  };
  const paintSync = (res) => {
    segs.innerHTML = '';
    if (!res || !res.ok) {
      const seg = el('div', 'sync-seg wide');
      seg.appendChild(el('span', 'seg-state off', '🟡 未连接服务器 · 演示'));
      segs.appendChild(seg);
      return;
    }
    const list = res.mappings || [];
    if (!list.length) {
      const seg = el('div', 'sync-seg wide');
      seg.appendChild(el('span', 'seg-state off', '未配置同步项'));
      segs.appendChild(seg);
      return;
    }
    list.forEach(m => {
      let dot = 'ok', state = '已同步';
      if (m.status === 'missing-local') { dot = 'warn'; state = '本地缺失'; }
      else if (m.status === 'missing-remote') { dot = 'warn'; state = '云端缺失'; }
      else if (!m.inSync) {
        const parts = [];
        if (m.pushTotal) parts.push('推' + m.pushTotal);
        if (m.pullTotal) parts.push('拉' + m.pullTotal);
        state = parts.join('·') || '有差异';
        dot = 'warn';
      }
      const seg = el('div', 'sync-seg');
      const top = el('span', 'seg-top');
      top.appendChild(el('span', 'seg-label', String(m.label || m.key).replace(/端$/, '')));
      top.appendChild(el('span', 'seg-dot ' + dot));
      seg.appendChild(top);
      seg.appendChild(el('span', 'seg-state ' + dot, state));
      // 有差异时提供一键推送/拉取（默认隐藏，需打开「同步」开关；未连接则仅展示）
      if (showSyncActs && m.status !== 'missing-local' && m.status !== 'missing-remote' && !m.inSync && K && K.sync && K.sync.push) {
        const acts = el('span', 'seg-acts');
        const pb = el('button', 'seg-btn', '↑');
        pb.title = '推送（本地 → 云端）：' + m.local;
        pb.addEventListener('click', () => doTransfer('push', m));
        const rb = el('button', 'seg-btn', '↓');
        rb.title = '拉取（云端 → 本地）：' + m.remote;
        rb.addEventListener('click', () => doTransfer('pull', m));
        acts.appendChild(pb);
        acts.appendChild(rb);
        seg.appendChild(acts);
      }
      seg.title = buildTitle(m);
      segs.appendChild(seg);
    });
  };
  const loadSync = (force) => {
    if (!K) return;
    K.sync.status(!!force).then(paintSync).catch(() => paintSync(null));
  };
  // 一键推送 / 拉取（复用云控台同步规则；执行后刷新状态）
  let busy = false, msgTimer = null;
  const toast = (txt, isErr) => {
    msgEl.textContent = (isErr ? '✗ ' : '') + txt;
    msgEl.className = 'sync-msg' + (isErr ? ' err' : ' ok');
    if (msgTimer) clearTimeout(msgTimer);
    msgTimer = setTimeout(() => { msgEl.textContent = ''; msgEl.className = 'sync-msg'; }, 6000);
  };
  const doTransfer = (mode, m) => {
    if (busy || !K || !K.sync) return;
    const dirTxt = mode === 'push' ? '推送' : '拉取';
    const cnt = mode === 'push' ? m.pushTotal : m.pullTotal;
    const ok = confirm('确认' + dirTxt + '「' + m.label + '」？\n' +
      (mode === 'push' ? '本地 → 云端：' + m.local + '\n→ ' + m.remote : '云端 → 本地：' + m.remote + '\n→ ' + m.local) +
      '\n将更新 ' + (cnt || 0) + ' 个文件（排除 node_modules/.git/dist/.env/*.log）');
    if (!ok) return;
    busy = true;
    refreshBtn.disabled = true;
    toast('正在' + dirTxt + '「' + m.label + '」…');
    const fn = mode === 'push' ? K.sync.push : K.sync.pull;
    fn(m.key).then(r => {
      busy = false;
      refreshBtn.disabled = false;
      if (r && r.ok) toast('✓ ' + dirTxt + '「' + (r.label || m.label) + '」完成，更新 ' + r.total + ' 个文件');
      else toast((r && r.err) || '操作失败', true);
      loadSync();
    }).catch(() => {
      busy = false;
      refreshBtn.disabled = false;
      toast('操作失败', true);
    });
  };

  // ---- 本地列 ----
  const loadLocal = (p) => {
    const target = p || localPath;
    if (!target) return;
    localPath = target;
    localCol.crumbs.textContent = target;
    localCol.crumbs.title = target;
    localCol.list.innerHTML = '';
    if (!K) { localCol.list.appendChild(mkEmpty('（无本地服务）')); return; }
    K.filesLocal(target).then(r => {
      if (disposed) return;
      localCol.crumbs.textContent = (r && r.base) || target;
      localCol.crumbs.title = (r && r.base) || target;
      localCol.list.innerHTML = '';
      if (parentPath(target) !== target) {
        localCol.list.appendChild(mkRow('↩️', '..', '上级目录', true, () => loadLocal(parentPath(target))));
      }
      if (!r || !r.ok) { localCol.list.appendChild(mkEmpty('无法读取：' + ((r && r.err) || '未知'))); return; }
      (r.rows || []).forEach(it => {
        localCol.list.appendChild(mkRow(it.isDir ? '📁' : '📄', it.name,
          it.isDir ? '目录' : fmtSize(it.size) + ' · ' + fmtTime(it.mtime),
          it.isDir, () => loadLocal(joinPath(target, it.name))));
      });
      if (!r.rows || !r.rows.length) localCol.list.appendChild(mkEmpty('（空目录）'));
    }).catch(() => {
      localCol.list.innerHTML = '';
      localCol.list.appendChild(mkEmpty('读取失败'));
    });
  };

  // ---- 云端列（SFTP） ----
  const loadCloud = (p, force) => {
    const target = p || cloudPath;
    if (!target) return;
    cloudPath = target;
    cloudCol.crumbs.textContent = target;
    cloudCol.crumbs.title = target;
    cloudCol.list.innerHTML = '';
    if (!K) { cloudCol.list.appendChild(mkEmpty('☁️ 演示')); return; }
    K.files(target, !!force).then(r => {
      if (disposed) return;
      cloudCol.crumbs.textContent = (r && r.base) || target;
      cloudCol.crumbs.title = (r && r.base) || target;
      cloudCol.list.innerHTML = '';
      if (parentPath(target) !== target) {
        cloudCol.list.appendChild(mkRow('↩️', '..', '上级目录', true, () => loadCloud(parentPath(target))));
      }
      if (!r || !r.ok || !r.real) {
        cloudCol.list.appendChild(mkEmpty('☁️ ' + (r && !r.real ? '未连接服务器 · 无真实数据' : ((r && r.err) || '无法读取'))));
        return;
      }
      (r.rows || []).forEach(it => {
        cloudCol.list.appendChild(mkRow(it.isDir ? '📁' : '📄', it.name,
          it.isDir ? '目录' : fmtSize(it.size) + ' · ' + fmtTime(it.mtime),
          it.isDir, () => loadCloud(joinPath(target, it.name))));
      });
      if (!r.rows || !r.rows.length) cloudCol.list.appendChild(mkEmpty('（空目录）'));
    }).catch(() => {
      cloudCol.list.innerHTML = '';
      cloudCol.list.appendChild(mkEmpty('读取失败'));
    });
  };

  // 云端快捷跳转
  const setupCloudJumps = () => {
    if (!paths || !K) return;
    const defs = [
      ['代码', paths.code], ['站点', paths.www], ['备份', paths.backups]
    ];
    defs.forEach(([label, p]) => {
      const b = el('button', 'file-jump', label);
      b.title = p;
      b.addEventListener('click', () => loadCloud(p));
      cloudCol.jumps.appendChild(b);
    });
  };

  // ---- 无桥接：静态演示 ----
  if (!K) {
    localCol.crumbs.textContent = '本地项目';
    cloudCol.crumbs.textContent = '/opt/oa';
    [['📁', 'backend/', '目录'], ['📁', 'web/', '目录'], ['📄', 'README.md', '5 KB']]
      .forEach(([ic, n, m]) => localCol.list.appendChild(el('div', 'file-row', ic + ' ' + n + ' ' + m)));
    [['📁', 'backend/', '目录'], ['📁', 'www/', '目录'], ['📄', 'app.js', '--']]
      .forEach(([ic, n, m]) => cloudCol.list.appendChild(el('div', 'file-row', ic + ' ' + n + ' ' + m)));
    return;
  }

  // ---- 初始化 + 轮询（20s：同步状态 + 当前目录） ----
  let timer = null;
  K.paths().then(pa => {
    paths = pa;
    setupCloudJumps();
    loadSync();
    loadLocal(pa.localRoot);
    loadCloud(pa.code);
  }).catch(() => { loadSync(); loadLocal(null); });
  // 目录/本地列表 30s 轮询；同步比对（较重，云端全量 walk）每 2 个周期 = 60s 一次；不可见暂停
  let syncTick = 0;
  const stopPoll = oaPoll(30000, () => {
    if (disposed) return;
    if (syncTick++ % 2 === 0) loadSync(false);
    loadLocal(localPath);
    loadCloud(cloudPath, false);
  });

  return () => { disposed = true; stopPoll(); };
};

// ============ log：真实日志（pm2 后端 / nginx / mysql，SSH 已连接则实时抓取；否则操作日志） ============
renderers.log = (body, meta, head) => {
  oaSyncScenario(meta);
  const K = window.app && window.app.oa;
  const FALLBACK = [
    ['10:23:11', 'info', '服务 oa-app 健康检查通过 (200 OK)'],
    ['10:22:47', 'info', 'nginx reload 完成'],
    ['10:22:40', 'warn', 'celery-worker 心跳超时，正在重启'],
    ['10:20:05', 'info', '部署 release-2025.09.06 成功'],
    ['10:18:32', 'info', 'git pull origin master (3 files changed)'],
    ['10:15:00', 'err', '<内网IP> 连续 3 次登录失败（已锁定）'],
    ['10:12:19', 'info', '备份 /data/postgres 完成 (1.2GB)']
  ];
  body.classList.add('log-panel');
  const SOURCES = [
    ['backend', '后端'], ['nginx', '站点访问'], ['nginx-error', '站点错误'], ['mysql', 'MySQL']
  ];

  const hint = el('div', 'term-hint', '…');
  if (head) head.appendChild(hint); else body.appendChild(hint);
  const tabs = el('div', 'log-tabs');
  body.appendChild(tabs);
  const view = el('div', 'log-view');
  body.appendChild(view);

  let active = 'backend';
  let connected = false;
  let last = {};
  let disposed = false;
  let tabBtns = {};

  const paintOpLog = (rows) => {
    view.innerHTML = '';
    (rows || []).forEach(([t, lv, msg]) => {
      const line = el('div', 'log-line');
      line.appendChild(el('span', 'log-time', t));
      line.appendChild(el('span', 'log-lv ' + lv, lv));
      line.appendChild(el('span', 'log-msg', msg));
      view.appendChild(line);
    });
  };
  // 真实日志行：尽力提取时间前缀（pm2 ISO / nginx [bracket]），其余原样显示
  const splitLine = (l) => {
    const s = String(l);
    let t = '', rest = s;
    let m = s.match(/^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z?)\s*(.*)$/);
    if (m) { t = (m[1] || '').slice(5, 16); rest = m[2] || ''; }
    else {
      m = s.match(/^\[([^\]]+)\]\s*(.*)$/);
      if (m) { t = (m[1] || '').replace(/^(\d{2}\/[A-Za-z]{3}\/\d{4}:\d{2}:\d{2}:\d{2}).*/, '$1'); rest = m[2] || ''; }
    }
    return [t, rest];
  };
  const paintCurrent = () => {
    if (!connected) return;
    const lines = last[active] || [];
    view.innerHTML = '';
    if (!lines.length) {
      view.appendChild(el('div', 'log-empty', '（该来源暂无日志）'));
      return;
    }
    // 最新在最上：tail 是旧→新，反转后新→旧，并滚到顶部
    [...lines].reverse().forEach(l => {
      const [t, rest] = splitLine(l);
      const line = el('div', 'log-line real');
      line.appendChild(el('span', 'log-time', t));
      line.appendChild(el('span', 'log-msg', rest || l));
      view.appendChild(line);
    });
    view.scrollTop = 0;
  };
  const ensureTabs = () => {
    tabs.innerHTML = '';
    tabBtns = {};
    SOURCES.forEach(([key, label]) => {
      const has = !!(last[key] && last[key].length);
      const b = el('button', 'log-tab' + (key === active ? ' on' : '') + (has ? '' : ' empty'), label + (has ? '' : ' ·空'));
      b.addEventListener('click', () => { active = key; paintCurrent(); ensureTabs(); });
      tabBtns[key] = b;
      tabs.appendChild(b);
    });
  };
  const fetchReal = (force) => {
    if (!K || !K.logsReal) return;
    K.logsReal(['backend', 'nginx', 'nginx-error', 'mysql'], 100, !!force).then(r => {
      if (disposed) return;
      if (r && r.ok) {
        connected = true;
        last = r.sources || {};
        const now = new Date();
        const p2 = n => String(n).padStart(2, '0');
        hint.textContent = '10秒 · 采集于 ' + p2(now.getHours()) + ':' + p2(now.getMinutes()) + ':' + p2(now.getSeconds());
        ensureTabs();
        paintCurrent();
      } else if (r && r.demo) {
        connected = false;
        hint.textContent = '🟡 未连接服务器 · 显示本地操作记录';
        paintOpLog([...(r.rows || [])].reverse().map(x => [(x.ts || '').slice(11), x.level, x.msg]));
      } else {
        hint.textContent = '⚠️ ' + ((r && r.err) || '日志获取失败');
      }
    }).catch(() => { hint.textContent = '⚠️ 日志获取失败'; });
  };

  if (!K) { hint.textContent = '演示模式'; paintOpLog(FALLBACK); return; }
  fetchReal();
  // 日志 10s 轮询（主进程 8s TTL 去重）；不可见暂停
  const stopPoll = oaPoll(10000, () => { if (!disposed) fetchReal(false); });
  // 标题行「立即刷新」按钮（强制穿透缓存）
  const logRefresh = el('button', 'file-refresh', '🔄 刷新');
  logRefresh.title = '立即抓取最新日志（不等自动周期）';
  logRefresh.addEventListener('click', () => {
    logRefresh.disabled = true;
    logRefresh.textContent = '抓取中…';
    Promise.resolve(fetchReal(true)).then(() => { logRefresh.disabled = false; logRefresh.textContent = '🔄 刷新'; });
  });
  if (head) {
    const acts = el('div', 'file-head-acts');
    acts.appendChild(logRefresh);
    head.appendChild(acts);
  }
  return () => { disposed = true; stopPoll(); };
};

// ============ combo：组合窗（多个子面板合成一个窗口 + 顶栏切预览，交叉淡入淡出）============
// 谁要它：<客户> OA 运维场景（用户 2026-09-27 提的）——「SSH 终端 / 云端文件 / 操作日志」原本是**三个独立面板**，
//   三块之间横着 #grid 的 10px 行列缝（用户抱怨的"连接处留黑"就是它，缝里露的是 --bg 近黑底色）。
//   合成一个面板 ⇒ 一个窗口、一条黑缝都没有；顶栏正中一个按钮在「工位区」和「预览区」之间"丝滑切换"。
// 场景 json 面板字段（都在 meta 上）：
//   meta.subPanels          [{id,title,type,...}] 子面板数组；id/title/type 必给，其余字段**原样**透传给子渲染器
//   meta.previewPanelId     预览子面板 id（默认 meta.id + '-view'）；也是别的面板递给它的地址（场景 json 的 viewPanel）
//   meta.previewQuickLinks  选填，原样透传给 view 的 quickLinks
// 状态记忆：localStorage['app.combo.' + meta.id] = 'stage' | 'view'（默认 stage = 工位区）
//
// 六条硬约束（每条都对应一个踩过的坑）：
//   ① 子面板 id **原样透传**：embed / harness 的 localStorage 分区都认面板 id（persist:embed-<id> 等），
//      改了 = 丢登录态 / 丢绑定；所以这里只 Object.assign({}, sub, {scenario}) 补一个场景标记，不碰 id。
//   ② 每个 slot **自己造一个细条 header** 交给子渲染器：三个都塞面板自己的 head 的话，三家的
//      「连接状态 / 刷新 / 眼睛」按钮会全挤进同一个标题栏里。
//      ⚠ renderers.view 只收 (body, meta) 两个参数 —— 别给它第三个。
//   ③ 子渲染器返回的 cleanup **全部收集**，组合窗销毁时依次调用（不收集 = SSH 助手轮询、日志 10s 轮询泄漏）。
//   ④ 切换**只动 opacity / transform**（交叉淡入淡出），全程不碰 width/height/display/flex：
//      动画期间改尺寸会让 shell/view 里的内容逐帧重排而"抖"（技能 gui-workbench reference/布局与展开.md §二），
//      而且组合窗的格子一动，用户要的"场景稳定"（其它面板一格不动）就没了。
//      隐藏层用 opacity:0 + pointer-events:none（**不是 display:none**）：① 终端/webview 的尺寸测量不失真
//      ② 层还留在流里 ⇒ SSH 会话、滚动位置、日志后台照跑。
//   ⑤ 预览区**懒挂载**：第一次要它才渲染 view；挂上 → 等一帧 → 再淡入（第一帧不闪）。
//   ⑥ 预览层全程 transform:none（见 styles.css 同段注释）：view 里可能出现 <webview>（PDF / HTML），
//      而 guest view 对**祖先 transform** 跟随不稳（同一份 reference 里踩过），所以位移只给工位层。
// combo 工位区的**迷你网格排格**：语义与工作台 #grid 完全一致 ——
//   col/row = **起始格**（1 起算；不写就自动排）、w/h = **跨格**（缺省各算 1）。
// 返回 { cols, rows, at:[{col,row,w,h}] }，at 与传入的 subs 一一对应，直接喂给 grid-column / grid-row。
// 通用：1×2 / 2×2 / N 列都行，本场景（SSH 1×1 + 云端文件 1×1 + 日志 2×1）算出来就是 2 列 2 行。
// 三条规矩：
//   ① 列数 = max(最宽的格子, 显式 col 撑出来的列, ceil(sqrt(总格数)))：
//      最宽的格子永远放得下（这条是硬底线）；ceil(sqrt()) 只兜"全是 1×1"的情况 ——
//      两个 1×1 该并排两列，而不是叠成一竖列（不然 form 上永远排不出 1×2 的并排布局）。
//   ② 排格 = 行主序（左→右、上→下）找**第一个放得下**的空位（等价 #grid 的稀疏首适配自动流）；
//      有显式 col/row 的按坐标原样放，只给一半（只写 col 或只写 row）的就在那一列/那一行里找空位。
//   ③ 排完把右侧、底部**整列整行空着**的部分裁掉（单个 w:1 的格子不会白占半幅宽）。
// 为什么不是把 w/h 当装饰：用户原来的排法就是这三个数字说的（第一行两块并排、第二行日志通栏），
// 之前"flex 等高均分"把三格排成了三等分竖条 —— 用户截图里判定为「排列错了」。
function planComboGrid(subs) {
  const span = (v) => { const n = Math.floor(Number(v)); return n > 0 ? n : 1; };   // 缺省各算 1
  const items = subs.map((sub) => ({
    w: span(sub.w), h: span(sub.h),
    hasCol: Number(sub.col) > 0, hasRow: Number(sub.row) > 0,
    col: span(sub.col), row: span(sub.row)
  }));
  let cells = 0, widest = 1;
  items.forEach((it) => {
    cells += it.w * it.h;
    widest = Math.max(widest, it.w, it.hasCol ? it.col + it.w - 1 : 1);
  });
  const cols = Math.max(widest, Math.ceil(Math.sqrt(cells)) || 1);
  const occ = Object.create(null);
  const mark = (c, r, w, h, v) => {
    for (let rr = r; rr < r + h; rr++) for (let cc = c; cc < c + w; cc++) occ[rr + ',' + cc] = v;
  };
  const free = (c, r, w, h) => {
    if (c < 1 || c + w - 1 > cols) return false;
    for (let rr = r; rr < r + h; rr++) for (let cc = c; cc < c + w; cc++) if (occ[rr + ',' + cc]) return false;
    return true;
  };
  const at = [];
  let maxRow = 1;
  items.forEach((it) => {
    let spot = null;
    if (it.hasCol && it.hasRow) spot = { col: it.col, row: it.row };          // 显式坐标：原样用
    else {
      // 上限 = 已占行 + 自己高度：cols ≥ w 保证第 1 列永远放得下，所以一定找得到，循环必然终止
      for (let r = it.hasRow ? it.row : 1; r <= maxRow + it.h && !spot; r++) {
        for (let c = it.hasCol ? it.col : 1; c + it.w - 1 <= cols; c++) {
          if (free(c, r, it.w, it.h)) { spot = { col: c, row: r }; break; }
        }
      }
      if (!spot) spot = { col: it.hasCol ? it.col : 1, row: it.hasRow ? it.row : 1 };   // 理论上到不了这儿
    }
    mark(spot.col, spot.row, it.w, it.h, 1);
    maxRow = Math.max(maxRow, spot.row + it.h - 1);
    at.push({ col: spot.col, row: spot.row, w: it.w, h: it.h });
  });
  let usedCols = 1, usedRows = 1;
  at.forEach((p) => {
    usedCols = Math.max(usedCols, p.col + p.w - 1);
    usedRows = Math.max(usedRows, p.row + p.h - 1);
  });
  return { cols: usedCols, rows: usedRows, at: at };
}

renderers.combo = (body, meta, head) => {
  body.classList.add('combo-body');
  const subs = (Array.isArray(meta.subPanels) ? meta.subPanels : []).filter((s) => s && s.id && s.type);
  const viewId = String(meta.previewPanelId || ((meta.id || 'combo') + '-view'));
  const stateKey = 'app.combo.' + String(meta.id || 'combo');

  // ---- DOM：一个**尺寸全程不变**的盒子 + 两层（工位区 / 预览区），两层都是 position:absolute; inset:0 ----
  const wrap = el('div', 'combo-wrap');
  const stage = el('div', 'combo-stage combo-layer');
  // 预览层复用一个 .panel-body 的尺寸规则（view 自己会再加 .view-panel）——不重写任何预览能力
  const viewEl = el('div', 'panel-body combo-view combo-layer');
  wrap.appendChild(stage);
  wrap.appendChild(viewEl);
  body.appendChild(wrap);

  const cleanups = [];        // 子渲染器 + 预览的 cleanup
  let disposed = false;
  let mode = '';              // '' 未定 | 'stage' 工位区 | 'view' 预览区
  let viewMounted = false;
  let viewApi = null;
  let fadeTimer = null, mountTimer = null, bootTimer = null;
  let btn = null;

  const setLayer = (elm, on) => {
    if (!elm) return;
    if (on) { elm.classList.remove('combo-off'); elm.removeAttribute('aria-hidden'); }
    else { elm.classList.add('combo-off'); elm.setAttribute('aria-hidden', 'true'); }
  };

  // ---- 工位区：按 subPanels 的 w/h 排出来的**迷你网格**（gap:0 = 零黑缝；行列都 1fr = 各占一半）----
  //   列数/行数是算出来的，写在内联 grid-template-* 上；slot 用 grid-column/grid-row 落到"起始格 + 跨格"。
  //   本场景 oa-ops：SSH(1×1) 云端文件(1×1) 日志(2×1) ⇒ 2 列 2 行 —— 第一行两块并排各半，第二行日志通栏。
  const plan = planComboGrid(subs);
  stage.style.gridTemplateColumns = 'repeat(' + plan.cols + ', minmax(0, 1fr))';
  stage.style.gridTemplateRows = 'repeat(' + plan.rows + ', minmax(0, 1fr))';
  subs.forEach((sub, si) => {
    const slot = el('div', 'combo-slot');
    const g = plan.at[si] || { col: 1, row: 1, w: 1, h: 1 };
    slot.style.gridColumn = g.col + ' / span ' + g.w;
    slot.style.gridRow = g.row + ' / span ' + g.h;
    // 分隔线按**真实格位**加（第 2 行起上边线、第 2 列起左边线）：1px 极淡，不是空隙
    if (g.row > 1) slot.classList.add('combo-slot-sep-t');
    if (g.col > 1) slot.classList.add('combo-slot-sep-l');
    slot.dataset.pid = sub.id;      // 定位用：这块是谁（id 就是原来那个，没改）
    const sh = panelHead(sub.title || sub.id, sub.sub || '');
    sh.classList.add('combo-slot-head');
    const sb = el('div', 'panel-body combo-slot-body');
    slot.appendChild(sh);
    slot.appendChild(sb);
    stage.appendChild(slot);
    const fn = renderers[sub.type];
    if (typeof fn !== 'function') { sb.appendChild(el('div', 'stat-sub', '未知子面板类型: ' + sub.type)); return; }
    try {
      const subMeta = Object.assign({}, sub, { scenario: meta.scenario });   // id/title/type 原样，只补场景标记
      const ret = (sub.type === 'view') ? fn(sb, subMeta) : fn(sb, subMeta, sh);
      if (typeof ret === 'function') cleanups.push(ret);
    } catch (err) {
      // 一个子面板挂了不能拖垮整个组合窗：其余格子照常可用，错误就写在这一格里
      sb.appendChild(el('div', 'stat-sub', '子面板渲染失败: ' + ((err && err.message) || err)));
    }
  });

  // ---- 预览代理：view 是**懒挂载**的，但「本地文件」单击就要往这儿递文件 ----
  //   别的面板靠 window.__kunViews[预览id]（renderers['file'] 的 viewPanel / flowFindView）找预览面板，
  //   懒挂载的话第一次点文件时 view 还没注册 ⇒ 点了没反应。所以先注册一个**只转发**的代理占住这个 id：
  //   真被用到时它顺手把 view 挂上、切到预览，再转给真的 API（md 源码视图 / 图片滚轮缩放全是 view 自己的，这里不复制）。
  const proxy = {
    pid: viewId,
    __comboProxy: true,
    current: () => (viewApi ? viewApi.current() : { kind: 'empty', path: '', url: '', title: '', dirty: false }),
    show: (o) => { applyMode('view', true); if (viewApi) viewApi.show(o || {}); },
    clear: () => { if (viewApi) viewApi.clear(); }
  };
  try { window.__kunViews = window.__kunViews || {}; window.__kunViews[viewId] = proxy; } catch (e) { /* ignore */ }

  function ensureView() {
    if (viewMounted || disposed) return false;
    viewMounted = true;
    // 挂载时这层已经是 inset:0 的整块盒子（wrap 的尺寸全程不变）⇒ view 量到的就是真实宽高
    try {
      const ret = renderers.view(viewEl, {
        id: viewId, type: 'view', title: '预览',
        quickLinks: meta.previewQuickLinks || [], scenario: meta.scenario
      });
      if (typeof ret === 'function') cleanups.push(ret);
    } catch (err) {
      viewEl.appendChild(el('div', 'stat-sub', '预览面板渲染失败: ' + ((err && err.message) || err)));
    }
    const reg = (window.__kunViews && window.__kunViews[viewId]) || null;
    viewApi = (reg && reg !== proxy) ? reg : null;   // view 没注册成功（报错）⇒ 别把代理当 API，否则无限递归
    return true;
  }

  // 交叉淡入淡出：只改 .combo-off 这一个类 ⇒ CSS 里只有 opacity + transform，**没有任何尺寸属性**。
  // 尺寸刷新：盒子尺寸全程没变，"补一次 resize"是给终端/预览贴合留的保险（幂等、极便宜）。
  function fadeTo(next) {
    const showEl = next === 'view' ? viewEl : stage;
    const hideEl = next === 'view' ? stage : viewEl;
    if (!panelMotionOff()) {
      showEl.classList.add('combo-off');
      void showEl.offsetWidth;   // 强制回流：让"起始帧"先落地，再撤类过渡才会跑（同 animatePanelBox 手法）
    }
    setLayer(hideEl, false);
    setLayer(showEl, true);
    if (fadeTimer) clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => {
      fadeTimer = null;
      if (disposed) return;
      try { window.dispatchEvent(new Event('resize')); } catch (e) { /* ignore */ }
    }, 0);
  }

  function applyMode(next, persist) {
    if (disposed || next === mode) return;   // 幂等：反复点按钮 / 重复递文件都不会再叠一次动画或监听器
    const first = !mode;
    mode = next;
    if (next === 'view') {
      const justMounted = ensureView();
      if (justMounted && !panelMotionOff()) {
        // 懒挂载：这层这会儿还是隐藏的，先让 view 把内容铺好，**下一帧**再淡入（避免第一帧闪）
        if (mountTimer) clearTimeout(mountTimer);
        mountTimer = setTimeout(() => {
          mountTimer = null;
          if (!disposed && mode === 'view') fadeTo('view');
        }, 0);
      } else fadeTo('view');
    } else if (first) {
      setLayer(stage, true); setLayer(viewEl, false);   // 开场默认工位：首帧不淡入（一进场景别先闪一次）
    } else fadeTo('stage');
    if (btn) {
      btn.textContent = mode === 'view' ? '🖥 工位' : '⧉ 预览';
      btn.title = mode === 'view'
        ? '切回工位区（SSH 终端 / 云端文件 / 操作日志 —— 一直在后台跑着）'
        : '切到预览区（md / txt / 图片 / 视频；图片可滚轮缩放）';
    }
    if (persist) { try { localStorage.setItem(stateKey, mode); } catch (e) { /* ignore */ } }
  }

  // ---- 顶栏正中的切换按钮（绝对定位居中，不动标题栏的 flex 布局）----
  btn = el('button', 'combo-switch', '⧉ 预览');
  btn.type = 'button';
  btn.title = '切到预览区（md / txt / 图片 / 视频；图片可滚轮缩放）';
  const onSwitch = (ev) => {
    ev.preventDefault(); ev.stopPropagation();
    applyMode(mode === 'view' ? 'stage' : 'view', true);
  };
  btn.addEventListener('click', onSwitch);
  if (head && head.appendChild) head.appendChild(btn);

  // ---- 开场：默认工位；记忆里是预览就等一帧再切（那时面板已挂进 #grid，view 才量得到真实宽高）----
  setLayer(stage, true);
  setLayer(viewEl, false);
  let start = 'stage';
  try { if (localStorage.getItem(stateKey) === 'view') start = 'view'; } catch (e) { start = 'stage'; }
  if (start === 'view') bootTimer = setTimeout(() => { bootTimer = null; if (!disposed) applyMode('view', false); }, 0);
  else applyMode('stage', false);

  return () => {
    disposed = true;
    if (fadeTimer) clearTimeout(fadeTimer);
    if (mountTimer) clearTimeout(mountTimer);
    if (bootTimer) clearTimeout(bootTimer);
    fadeTimer = mountTimer = bootTimer = null;
    if (btn) btn.removeEventListener('click', onSwitch);
    // 子渲染器 + 预览的 cleanup **全部**依次调用（一个抛错不影响后面）
    for (let i = 0; i < cleanups.length; i++) { try { cleanups[i](); } catch (e) { /* ignore */ } }
    cleanups.length = 0;
    try { if (window.__kunViews && window.__kunViews[viewId] === proxy) delete window.__kunViews[viewId]; } catch (e) { /* ignore */ }
  };
};

// ============ ctl：一键操作 ============
renderers.ctl = (body) => {
  const actions = [
    { name: '重启 oa-app', desc: 'systemctl restart oa-app' },
    { name: '重载 nginx', desc: 'nginx -s reload' },
    { name: '拉取最新代码', desc: 'git pull origin master' },
    { name: '执行数据库备份', desc: 'pg_dump → /data/backups' },
    { name: '清理日志 (>7d)', desc: 'logrotate -f /etc/logrotate.d/oa' }
  ];
  const list = el('div', 'act-list');
  actions.forEach(a => {
    const b = el('button', 'act-btn', a.name);
    b.title = a.desc;
    b.addEventListener('click', () => {
      b.classList.add('spinning');
      setTimeout(() => {
        b.classList.remove('spinning');
        b.textContent = '✓ ' + a.name;
        setTimeout(() => (b.textContent = a.name), 1200);
      }, 900);
    });
    list.appendChild(b);
  });
  body.appendChild(list);
  body.appendChild(el('div', 'stat-sub', '演示模式：按钮仅展示交互，不实际执行命令。'));
};

// ============ reserved：预留占位面板 ============
renderers.reserved = (body, meta) => {
  const box = el('div', 'reserved-box');
  box.appendChild(el('div', 'reserved-icon', '🕐'));
  box.appendChild(el('div', 'reserved-title', '预留'));
  box.appendChild(el('div', 'reserved-sub', meta.reserveNote || '待规划功能，敬请期待。'));
  body.appendChild(box);
};

// ============ wb-cards：卡片墙（通用 · 2026-10-27）============
// 用法一（默认，工作台定制场景）：不给 groups ⇒ 「模板 / 客户」两段（读 03-客户\ 与 \_模板\）。
// 用法二（通用项目卡）：给 meta.groups = [{ label, root, list?, tone?, icon?, note? }]
//   · list:false（默认）→ root 本身一张卡（快捷打开某个项目目录）
//   · list:true          → 列 root 下的子目录，每个子目录一张卡
// 卡片副标题：优先 root\05-状态.md 的「阶段：」行，其次 root\说明.md 的第一条正文，最后 note。
// 点卡片 = app.app.openPath 打开该文件夹；⛔ 只读，不写不删任何文件。
renderers['wb-cards'] = (body, meta) => {
  const K = window.app || {};
  const OA = K.oa || null, APP = K.app || null, F = K.file || null;
  const BASE = String((meta && meta.root) || '<工作台>');
  const TPL_DIR = BASE + '\\_模板';
  const NOT_SCENE = { '外壳': 1, '引擎': 1 };
  const GROUPS = (meta && Array.isArray(meta.groups) && meta.groups.length) ? meta.groups : null;
  body.classList.add('wbc-body');
  const wrap = el('div', 'wbc');
  const head = el('div', 'wbc-head');
  head.appendChild(el('span', 'wbc-title', (meta && meta.label) || (GROUPS ? '项目' : '模板与客户')));
  const cntEl = el('span', 'wbc-count', '…');
  head.appendChild(cntEl);
  wrap.appendChild(head);
  const list = el('div', 'wbc-list');
  wrap.appendChild(list);
  body.appendChild(wrap);
  let gone = false;

  function ls(p) {
    if (!OA || !OA.filesLocal) return Promise.resolve(null);
    return Promise.resolve(OA.filesLocal(p)).then(function (r) {
      if (!r || r.ok === false) return null;
      return r.rows || [];
    }).catch(function () { return null; });
  }
  function read(p) {
    if (!F || !F.read) return Promise.resolve('');
    return Promise.resolve(F.read(p)).then(function (r) {
      return (typeof r === 'string') ? r : ((r && (r.text || r.content)) || '');
    }).catch(function () { return ''; });
  }
  function dirsOf(rows) {
    return (rows || []).filter(function (it) { return it && it.isDir && String(it.name).charAt(0) !== '_'; });
  }
  function pickStatus(txt) {
    const lines = String(txt || '').split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      if (/^阶段[:：]/.test(lines[i])) return lines[i].replace(/^阶段[:：]\s*/, '').replace(/\*\*/g, '').slice(0, 90);
    }
    for (let j = 0; j < lines.length; j++) {
      if (!/^#/.test(lines[j]) && !/^```/.test(lines[j])) return lines[j].replace(/\*\*/g, '').slice(0, 90);
    }
    return '';
  }
  function statusOf(dir) {
    return read(dir + '\\05-状态.md').then(function (a) {
      const s = pickStatus(a);
      if (s) return s;
      return read(dir + '\\说明.md').then(function (b) { return pickStatus(b); });
    });
  }
  function openFolder(p) {
    if (APP && APP.openPath) { Promise.resolve(APP.openPath(p)).catch(function () { return null; }); return; }
    if (APP && APP.revealPath) { Promise.resolve(APP.revealPath(p)).catch(function () { return null; }); return; }
    wrap.appendChild(el('div', 'wbc-note', '这个版本没有打开文件夹的能力（app.app.openPath）'));
  }
  function card(tone, title, path, icon) {
    const cls = tone === 'gold' ? 'wbc-tpl' : (tone === 'blue' ? 'wbc-cus' : 'wbc-plain');
    const b = el('button', 'wbc-card ' + cls);
    b.type = 'button';
    b.title = path;
    b.appendChild(el('div', 'wbc-ico', icon || '📁'));
    const mid = el('div', 'wbc-mid');
    mid.appendChild(el('div', 'wbc-nm', title));
    const sub = el('div', 'wbc-sub', '');
    mid.appendChild(sub);
    mid.appendChild(el('div', 'wbc-path', path));
    b.appendChild(mid);
    b.addEventListener('click', function () { openFolder(path); });
    return { node: b, sub: sub };
  }
  function groupTitle(title, tone) {
    const g = el('div', 'wbc-grp ' + (tone === 'gold' ? 'wbc-gold' : (tone === 'blue' ? 'wbc-blue' : 'wbc-plain')));
    g.appendChild(el('div', 'wbc-grp-t', title));
    return g;
  }
  function note(txt) {
    list.innerHTML = '';
    list.appendChild(el('div', 'wbc-note', txt));
    cntEl.textContent = '0';
  }
  function setSub(c, p) {
    statusOf(p).then(function (s) {
      if (gone) return;
      c.sub.textContent = s || '（点一下在资源管理器打开）';
    });
  }

  // ---- 通用：meta.groups ----
  function renderGroups() {
    let total = 0;
    let pending = 0;
    const done = function () { if (!gone) cntEl.textContent = String(total); };
    GROUPS.forEach(function (g) {
      const gTitle = String(g.label || '');
      const gRoot = String(g.root || '');
      const tone = g.tone || 'plain';
      const icon = g.icon || '📁';
      if (!gRoot) return;
      if (g.list) {
        const box = groupTitle(gTitle, tone);
        list.appendChild(box);
        pending++;
        ls(gRoot).then(function (rows) {
          if (gone) return;
          const ds = dirsOf(rows);
          if (!ds.length) { box.appendChild(el('div', 'wbc-note', '（目录读不到 or 里面没有子目录）')); }
          ds.forEach(function (d) {
            const p = gRoot + '\\' + d.name;
            const c = card(tone, d.name, p, icon);
            box.appendChild(c.node);
            total++;
            setSub(c, p);
          });
          cntEl.textContent = String(total);
        });
      } else {
        const c = card(tone, gTitle || gRoot.split('\\').pop(), gRoot, icon);
        list.appendChild(groupTitle('', tone));
        list.appendChild(c.node);
        total++;
        if (g.note) { c.sub.textContent = String(g.note); }
        else setSub(c, gRoot);
        cntEl.textContent = String(total);
      }
    });
    if (!total) note('还没有配置项目（meta.groups 是空的）。');
  }

  // ---- 默认：模板 + 客户 ----
  function renderLegacy() {
    Promise.all([ls(TPL_DIR), ls(BASE)]).then(function (r) {
      if (gone) return;
      const tpls = dirsOf(r[0]), custs = dirsOf(r[1]);
      list.innerHTML = '';
      cntEl.textContent = String(tpls.length + custs.length);
      if (!tpls.length && !custs.length) { note('这里还没有模板或客户目录。'); return; }
      if (tpls.length) {
        list.appendChild(groupTitle('模板', 'gold'));
        tpls.forEach(function (it) {
          const p = TPL_DIR + '\\' + it.name;
          const c = card('gold', it.name, p, '📦');
          list.appendChild(c.node);
          ls(p).then(function (rows) {
            if (gone) return;
            const n = dirsOf(rows).filter(function (d) { return !NOT_SCENE[d.name]; }).length;
            c.sub.textContent = '模板 · ' + n + ' 场景';
          });
        });
      }
      if (custs.length) {
        list.appendChild(groupTitle('客户', 'blue'));
        custs.forEach(function (it) {
          const p = BASE + '\\' + it.name;
          const c = card('blue', it.name, p, '👤');
          list.appendChild(c.node);
          setSub(c, p);
        });
      }
    }).catch(function () { if (!gone) note('读交付目录时出错（已忽略，不影响其它面板）'); });
  }

  if (GROUPS) renderGroups(); else renderLegacy();

  return function () { gone = true; };
};

// ============ app-window：把外部工业软件窗口内置成面板（2026-10-28 · 客户「<客户>」）============
// meta.app = { label, exe, match:{process,titleHas}, launchArgs, mode:'overlay'|'capture', chrome:'strip'|'keep', keepRatio, closeWithPanel }
// 机制：主进程 owner-overlay（scripts\app-embed-agent.ps1）——软件保持一级窗口，GUI 当它的 owner，再按屏幕坐标贴到面板上。
// 失败/未启动时只显示提示与按钮，不报错；切场景/销毁时按 closeWithPanel 释放 owner。
renderers['app-window'] = (body, meta, head) => {
  const A = (window.app && window.app.appwin) || null;
  const CFG = (meta && meta.app) || {};
  const PROC = String((CFG.match && CFG.match.process) || '').trim();
  const EXE = String(CFG.exe || '').trim();
  const ARGS = Array.isArray(CFG.launchArgs) ? CFG.launchArgs : [];
  const CLOSE_WITH_PANEL = !!CFG.closeWithPanel;
  body.classList.add('aw-body');
  const wrap = el('div', 'aw');
  const stage = el('div', 'aw-stage');
  const note = el('div', 'aw-note', '未连接 · 点上面的「启动」或「重连」');
  stage.appendChild(note);
  wrap.appendChild(stage);
  body.appendChild(wrap);
  let gone = false, embedded = false, timer = null, moveT = null, minimized = false;

  if (head) {
    head.classList.add('file-head');
    const acts = el('div', 'file-head-acts');
    const bLaunch = el('button', 'kneu-btn', '▶ 启动');
    const bRe = el('button', 'kneu-btn', '⟲ 重连');
    const bRel = el('button', 'kneu-btn', '⤢ 释放');
    [bLaunch, bRe, bRel].forEach(function (b) { b.type = 'button'; acts.appendChild(b); });
    head.appendChild(acts);
    bLaunch.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (!A) { say('这个外壳版本没有窗口嵌入能力（app.appwin）'); return; }
      if (!EXE) { say('没有配置 exe 路径：请在场景 json 的 app.exe 里填上（客户机上可能不在一处）'); return; }
      say('正在启动 ' + (CFG.label || PROC) + ' …');
      Promise.resolve(A.launch(EXE, ARGS)).then(function (r) {
        if (r && r.ok) { say('已启动，正在找窗口…'); setTimeout(connect, 2500); }
        else say('启动失败：' + ((r && (r.err || r.path)) || '未知'));
      });
    });
    bRe.addEventListener('click', function (ev) { ev.stopPropagation(); connect(); });
    bRel.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (!A) return;
      Promise.resolve(A.release()).then(function () { embedded = false; say('已释放（软件回到普通窗口）'); });
    });
  }

  function say(t) { note.textContent = t; }
  function rect() {
    const r = stage.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  }
  function connect() {
    if (gone || !A) { if (!A) say('这个外壳版本没有窗口嵌入能力（app.appwin）'); return; }
    if (!PROC) { say('场景 json 没配 app.match.process（进程名）'); return; }
    say('正在找 ' + PROC + ' 的窗口…');
    Promise.resolve(A.status(PROC)).then(function (st) {
      if (gone) return;
      minimized = !!(st && st.minimized);
      if (!st || !st.ok || !st.found) { embedded = false; say('没找到 ' + PROC + ' 的窗口 —— 先「启动」它，或确认进程名对不对'); return; }
      Promise.resolve(A.embed(PROC, rect())).then(function (r) {
        if (gone) return;
        if (r && r.ok) {
          embedded = true;
          say(minimized ? '窗口是**最小化**的：已保留上一帧，点「重连」恢复窗口' : '已内置（拖动分隔条会自动贴合）');
        } else {
          embedded = false;
          say('内置失败：' + ((r && r.err) || '未知') + '（可先用「启动」把软件打开）');
        }
      });
    });
  }
  function follow() {
    if (!embedded || gone || !A) return;
    if (moveT) clearTimeout(moveT);
    moveT = setTimeout(function () { if (!gone) Promise.resolve(A.move(rect())).catch(function () { return null; }); }, 200);
  }
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(follow);
    ro.observe(stage);
    window.addEventListener('resize', follow);
    // 清理
    var cleanup = function () {
      try { ro.disconnect(); } catch (e) { /* ignore */ }
      window.removeEventListener('resize', follow);
    };
    setTimeout(connect, 400);
    timer = setInterval(function () { if (!gone && !embedded) connect(); }, 6000);
    return function () {
      gone = true;
      cleanup();
      if (timer) clearInterval(timer);
      if (moveT) clearTimeout(moveT);
      if (embedded && CLOSE_WITH_PANEL && A) Promise.resolve(A.release()).catch(function () { return null; });
    };
  }
  // 老壳（没有 ResizeObserver）：只连一次
  setTimeout(connect, 400);
  timer = setInterval(function () { if (!gone && !embedded) connect(); }, 6000);
  return function () {
    gone = true;
    if (timer) clearInterval(timer);
    if (moveT) clearTimeout(moveT);
    if (embedded && CLOSE_WITH_PANEL && A) Promise.resolve(A.release()).catch(function () { return null; });
  };
};

// ============ flow：流程画布（节点 + 连线，用来自建工作流） ============
// 首个用户：视频工作流场景的左下窗口（原来是「预留」位，2026-09-20 用户要求改成画布：
// "可以新建节点搭建流程图，为自己搭建工作流做准备"）。
// 这是**通用节点画布**，但每个节点都绑一个**真实文件**（用户 2026-09-20 第二轮定的规矩）：
//   节点 = { id, type, name, desc, path, x, y }，连线 = { id, from, to }
//   type   当前只有 'text'（文案）：一个 .md / .txt 文件，双击就摊在「预览面板」里改
//   name   节点名（默认「文案」，右键可改成「小猫视频文案」这样便于辨认）
//   desc   一句话说明（显示在节点第二行）
//   path   真实文件全路径（写到文件名）。填了就自动对接：双击节点 = 打开这个文件
// 为什么"节点 = 文件"：用户要的是"每个节点对应一个程序/一份东西，双击就把它调出来"，
//   而这份东西必须是**文件**——AI 认文件、人认文件、剪映/ComfyUI 也认文件，
//   画布存的只是"图和路径"，内容永远在磁盘上（文件才是长期记忆）。
//
// 节点类型**一次只加一个**（用户要求"一个个来"；2026-09-21 长到 **15 种**，并分成**四类**）：
//   加新类型 = 往 FLOW_TYPES 里加一行（**只要把 `cat` / `kind` / `sides` 写对**）；
//   分类的四处呈现（四个「＋ …节点 ▾」入口 / 卡片左侧的 2px 类色条 / 工具栏右边的小字统计 /
//   空白右键菜单的分组小标题）全部按 `cat` 现算 ⇒ **加类型只改 FLOW_TYPES，别的地方一个字都不用动**。
//
// 为什么自己写、不引 react-flow / litegraph：工作台是"零构建 + 单文件渲染器 + ⟳ 热更"，
// 引库要么联网要么加打包步骤，跟这套约定冲突；节点画布本身几百行就够，以后长成自己的也更顺。
//
// 交互（用户 2026-09-20 定）：单击 = 选中；**双击 = 把节点对应的东西摊到预览面板**；
//   **右键 = 编辑节点 / 删除**；空白拖动 = 平移；滚轮 = 缩放；双击空白 = 加节点；
//   拖节点右边 ● 到另一个节点 = 连线；选中 + Delete = 删。
//
// 图存哪儿：localStorage（键 app.flow.<面板id>，格式 {v:2,...}）——图是"视图"，不是内容；
//   内容在 path 指向的文件里。⟳ / 切场景 / 重启 GUI 图都还在；**别改面板 id**（换了 id = 换键 = 丢图）。
//   要给 AI 看：点「⧉ Markdown」复制，粘到 AI 面板让它落进项目信息。
var FLOW_KINDS = [];   // v1 遗留（老图里有 kind 字段），新代码不用；保留空数组防止旧引用报错
// ---- 节点分类（2026-09-21 用户先定三类，同日再拍板加第四类「方式节点」）----
// 为什么分这四类（不是分着好看，是它们**在图里的角色**根本不同）：
//   内容节点 content =「做出来的东西」：文案 / 视频 / 图片 / 音频。双击摊到预览面板里看和改；
//                     它自己的字段（段落 / 起止秒 / 情节 / 用途）就是给 AI 会话看的"这份东西要长成什么样"。
//   方式节点 method  =「**怎么做**」：HTML 模板 / 固定流程预设。★注意：HTML 是"怎么做"，**不是产出物**★
//                     （2026-09-21 用户把它从内容类挪过来的）；它连上谁 = 告诉那个工具/会话按这份做法去做。
//   工具节点 tool    =「用啥干」：一个**能干活的东西**（本机服务 / 软件 / 免费的网页版 AI）。
//   看板节点 board   =「看状态用」：不产出东西，只把某个服务的现状摊出来（现在只有 ComfyUI 控制台）。
// 图的三条铁律（用户 2026-09-21 拍板的画法，跟三种线型一一对应）：
//   **横向 = 时间**（内容节点从左到右连成主线）·**纵向在下 = 产法**（工具/方式在下往上产出）·**上方 = 依据**（素材/参考供上来）。
// ⚠ 以后加新类型：**只往 FLOW_TYPES 里加一行、把 `cat` 写对**就行 ——「＋ …节点 ▾」入口、
//   卡片左侧那条 2px 类色条、工具栏右边的小字统计、空白右键菜单的分组小标题，四处全是按 cat 现算的，不会漏。
//   顺序 = 用户口述的顺序（内容 → 方式 → 工具 → 看板）：工具栏四个入口、统计小字、空白菜单分组**共用这一个顺序**，
//   免得"菜里一个序、统计里另一个序"（老版本 FLOW_CATS 与 FLOW_ADD_ORDER 故意不同序，本批统一了）。
var FLOW_CATS = [
  { id: 'content', name: '内容节点', color: '#4f8cff', hint: '做出来的东西（文案 / 视频 / 图片 / 音频）：双击摊到预览面板里看和改，字段里写清"要什么样"' },
  { id: 'method', name: '方式节点', color: '#c084fc', hint: '**怎么做**（HTML 模板 / 固定流程预设）：HTML 是"方式"不是产出物；连上谁 = 让谁按这份做法去做' },
  { id: 'tool', name: '工具节点', color: '#34c98f', hint: '能干活的东西（本机服务 / 软件 / 免费网页版 AI）：内容节点连到它 = 告诉 AI 会话用这个方式来' },
  { id: 'board', name: '看板节点', color: '#e5b355', hint: '看状态用的：不产出东西，只把某个服务的现状摊出来；以后还有别的看板再往里加' },
  // ★2026-09-26★ 用户点名："加一个文件夹节点叫『项目文件夹』，双击打开所在文件夹" —— 归这一类：
  //   一条工作流（素材 → 稿子 → 成片）**全放同一个文件夹**，接着干、查进度都只认它 ⇒ 它是"位置"，不是产出物。
  { id: 'place', name: '位置节点', color: '#e0b341', hint: '东西放在哪：双击**直接打开那个文件夹**（资源管理器）—— 一条工作流的全部产物都在同一个文件夹里，方便查看与继续' }
];
// 工具栏那四个「＋ …节点 ▾」入口从左到右的顺序（用户 2026-09-21 点的：内容 / 方式 / 工具 / 看板）。
// 与 FLOW_CATS 同序（本批统一，见上面那条注释）；以后加分类，两处都要看一眼（漏了这里 = 新分类在工具栏上没有入口）。
var FLOW_ADD_ORDER = ['content', 'method', 'tool', 'board', 'place'];   // ★2026-09-26★ 末尾加"位置节点"（放最后：前四个按钮的位置不动）
function flowCat(id) {
  for (var i = 0; i < FLOW_CATS.length; i++) if (FLOW_CATS[i].id === id) return FLOW_CATS[i];
  // 认不出来的一律当内容节点（内容节点是兜底语义，最不容易误导）。
  // ⚠ 这里**按 id 找**而不是取最后一个：FLOW_CATS 现在最后一项是"看板"，取最后一个就把兜底换人了。
  for (var j = 0; j < FLOW_CATS.length; j++) if (FLOW_CATS[j].id === 'content') return FLOW_CATS[j];
  return FLOW_CATS[0];
}
function flowCatOf(t) { return flowCat(t && t.cat); }
// 某一类里现在有哪些类型（顺序 = FLOW_TYPES 里的顺序）：四个添加入口和「用什么方式生成」下拉都靠它
function flowTypesOfCat(catId) {
  var out = [];
  for (var i = 0; i < FLOW_TYPES.length; i++) if (FLOW_TYPES[i].cat === catId) out.push(FLOW_TYPES[i]);
  return out;
}
// 「用什么方式生成」这个下拉的选项 = **所有工具节点的名字** + 一个「未定」。
// 为什么不写死一张列表（用户口述的那 8 个名字确实能写死）：以后往工具节点那类里再加一个类型，
//   下拉会自动多一项、和菜单里的分类天然一致 —— 少一处"加了类型忘了改下拉"的坑。
// ⚠ 2026-09-26 起**没有任何类型**用这个下拉了（video 的「用什么方式生成」改成认连线，见那个类型的注释），
//   函数留着当通用能力：真要再用，就在类型行里写 `pick: { key: '…', label: '…', from: 'tool' }`。
function flowMethodOptions() {
  var out = ['未定'];
  flowTypesOfCat('tool').forEach(function (t) { out.push(t.name); });
  return out;
}
// ---- 三种线型（2026-09-21 用户逐条点名的画法，★本批最关键的一块★）----
// 用户在画布上说的话：「主线用粗实线加箭头，方式线换个颜色不要用虚线加箭头，依据线用虚线加箭头，
//   这个箭头是从哪里指向哪里就在哪里」。三句话对应三件事：
//   ① 线宽：主线明显更粗（3px），另两种细（1.6~1.8）；② 方式线**实线 + 换颜色**（方式类的紫 #c084fc），
//      **不许虚线**（虚线是"依据"的记号，用了就分不出来）；③ 箭头**只画在被指向的那一端**。
// 数据：边上加 `kind` 字段（'seq' | 'how' | 'dep'）。老图没有这个字段 ⇒ 按两端分类**推断**（见 flowInferKind），
//   推断结果**只影响显示、绝不写回 localStorage** —— 老图必须能照原样开、拖、删，不能因为我们升级就被改写。
var FLOW_WIRES = [
  { id: 'seq', name: '主线', hint: '时间顺序：成片的段落按这条线往下走（从"开头"到"结尾"）' },
  { id: 'how', name: '方式', hint: '用这个把它做出来：工具/方式节点在下往上产出' },
  { id: 'dep', name: '依据', hint: '供给/依据：文案、分镜表、参考图、BGM 这一路' }
];
var FLOW_WIRE_STYLE = {
  seq: { w: 3, dash: '', color: '#7d8cb2' },        // 主线：粗实线
  how: { w: 1.8, dash: '', color: '#c084fc' },       // 方式：实线（换色，不虚线）
  dep: { w: 1.6, dash: '6 4', color: '#8b93a7' }     // 依据：虚线（中性灰）
};
function flowWireStyle(k) { return FLOW_WIRE_STYLE[k] || FLOW_WIRE_STYLE.dep; }
// 线型的名字（人话，用在提示语和右键菜单上）。认不出来的一律按"依据"算（跟 flowWireStyle 的兜底一致）。
function flowWireName(k) {
  for (var i = 0; i < FLOW_WIRES.length; i++) if (FLOW_WIRES[i].id === k) return FLOW_WIRES[i].name;
  return FLOW_WIRES[FLOW_WIRES.length - 1].name;
}
// 这条边现在算哪一型：**存了就以存的为准**（用户在气泡/右键里选过 = 用户说了算），没存才推断。
function flowWireKind(e, a, b) {
  return (e && FLOW_WIRE_STYLE[e.kind]) ? e.kind : flowInferKind(a, b);
}
// 老图（没有 kind 的边）怎么推断 —— 用户给的规则：到"内容"、来自"工具/方式" ⇒ how；内容→内容 ⇒ seq；其余 ⇒ dep。
// ⚠ 这是**纯显示层**的推断：不写回 localStorage（除非用户真的动手改过那一条线）。
function flowInferKind(a, b) {
  var ca = flowCatOf(flowType(a && a.type)).id, cb = flowCatOf(flowType(b && b.type)).id;
  if (cb === 'content' && (ca === 'tool' || ca === 'method')) return 'how';
  if (ca === 'content' && cb === 'content') return 'seq';
  return 'dep';
}
// 落点方位 → 线型（"方位自动判线型"那张表的唯一实现处）：
//   右口 ⇒ 主线（横向 = 时间）· 下口 ⇒ 方式（纵向在下 = 产法）· 上口 ⇒ 依据（上方 = 依据）。
//   左口用户没点名，按"主线从左边进来"算 seq（横向的入口，不是纵向）—— 这条是补的，报告里点出来了。
function flowKindFromSide(side) {
  return side === 'b' ? 'how' : (side === 't' ? 'dep' : 'seq');
}
// 箭头（★只画在指向端★）：尖端贴在被指向节点的端口锚点上、**朝节点里指**，尾巴朝线那一侧。
// 用一根自己算坐标的三角 path，不用 SVG <marker>：marker 的坐标在 jsdom 里读不出来，
//   而"箭头到底在哪一端"正是本批必须能被探针断言的东西（marker 会让这条断言变成"看代码猜"）。
function flowArrowD(p2, len, wid) {
  var dx = (p2.dx || 0), dy = (p2.dy || 0);              // 锚点法线朝外 = 线伸过来的那一侧
  // 底边落在**线的这一侧（节点外）**、尖端顶在锚点上朝节点里指 ⇒ 箭头方向 = 线的走向。
  // ★坑（2026-09-22 用户报「连线的箭头是反的」）：当初写成 -(p2.dx)，底边伸进节点里、
  //   尖端反而朝线尾 ⇒ 每根箭头都反着画。探针已加"底边与控制点同侧"的断言钉住。
  var n = Math.sqrt(dx * dx + dy * dy) || 1; dx /= n; dy /= n;
  var bx = p2.x + dx * len, by = p2.y + dy * len;        // 底边中点（在线的这一侧）
  var px = -dy, py = dx;                                 // 底边的垂直方向
  return 'M ' + p2.x + ' ' + p2.y
    + ' L ' + (bx + px * wid) + ' ' + (by + py * wid)
    + ' L ' + (bx - px * wid) + ' ' + (by - py * wid) + ' Z';
}
// ---- 图标位（2026-09-21 用户要求「网页ai的图标用官网图标」）----
// 有点的：类型表里有 `img`（官网图标，相对 renderer\ 的路径）就渲染 <img>；没有就渲染 `icon` 单字。
// 两个坑，都是"以后加图片图标时会踩的"：
//   ① render() 调得很勤（选中 / 拖动 / 探活 / 统计都会调）⇒ **不能每次都重建 <img>**，
//      否则图片被反复重载、图标一闪一闪。所以用 host.dataset.ico 记住"现在渲染的是什么"，没变就一个字都不动。
//   ② 图挂了（文件被挪走 / 路径写错）必须**退回单字**，而且要记住这次失败、不再重试 ——
//      否则每次 render 都会再拉一次坏图，还留一个空白图标位给人猜。
//      `icon` 单字就是为这一刻留的兜底，别删。
var flowIconFailed = {};
function flowIconKey(t) {
  return (t && t.img && !flowIconFailed[t.img]) ? 'img:' + t.img : 'txt:' + ((t && t.icon) || '');
}
function flowIconInto(host, t, cls) {
  if (!host) return;
  var want = flowIconKey(t);
  if (host.dataset.ico === want) return;
  host.dataset.ico = want;
  host.textContent = '';
  if (want.indexOf('img:') === 0) {
    var src = want.slice(4);
    var im = document.createElement('img');
    im.className = cls || 'flow-node-img';
    im.src = src;
    im.alt = '';                 // 装饰性图标：别让读屏念文件名
    im.draggable = false;        // 拖节点时别让浏览器变成"拖这张图"
    im.addEventListener('error', function () {
      flowIconFailed[src] = true;   // 这次 ⟳ 生命周期内不再试（⟳ 重跑本文件会清空，等于刷新后还给一次机会）
      host.dataset.ico = '';
      flowIconInto(host, t, cls);
    });
    host.appendChild(im);
  } else {
    host.textContent = (t && t.icon) || '';
  }
}
// 节点类型表（用户 2026-09-20 起一个一个加，2026-09-21 到 **15 种 / 四类**）。
// 每类几个关键字段，别的代码全靠它们分叉：
//   cat：  四分类之一（见上面的 FLOW_CATS）——只写这一个字段，界面上的四处分类呈现就自动跟上；
//   sides：这个节点的接线口开在哪几面（'lr' 左右 / 'tb' 上下 / 'lrtb' 四面）——
//          本批按"三条铁律"统一了：**内容类 'lrtb'**（左进右出=时间线、下口接方式、上口接依据）、
//          **工具/方式类 'tb'**（在下往上产出）、看板保持 'tb'（只跟下面的工作台连）。
//          ⚠ 工作台原来是四面（老用户要求"上下左右都要有连接"），本批按新铁律收成上下两面 —— 见 §五 追加那条。
//   kind： 双击这个节点会发生什么 ——
//          'file' 真实文件（摊到预览面板里改）／'url' 本机网页（摊到预览面板里操作）／
//          'app'  本机软件（直接打开，不做预览，只当流程里的一环）／
//          'webai' 顶栏那排图标背后的**免费网页版 AI 浮动窗口**（同一个登录态，不花 API token）／
//          'preset' 固定流程预设（没有文件，双击把它的步骤摊到预览面板：文字说明或一张静态小流程图）；
//   字段声明（弹框里长哪几栏、卡片副行印什么，全由类型表声明，加类型不用碰弹框代码）：
//     texts   = [{ key, label, rows, hint, value }]  多行文本；`value` = 建节点时的预设值（工具类的 duty 用它）
//     pick    = { key, label, from }                 下拉，选项**现算**（video 的 method = 所有工具节点的名字）
//     selects = [{ key, label, options, value }]     固定选项下拉（段落 / 用途 / 预览形式）；options 可以是
//                                                    '字符串' 或 { v, t }（值 + 给人看的字）
//     nums    = [{ key, label, hint }]               数字输入（起止秒；允许只填一个）
//     tpl     = { label, list:[{ name, steps, prompt }] }  内置模板下拉（选中就把 steps/prompt 填进去，之后还能手改）
//     subKeys = ['seg','secs', …]                    卡片副行印哪几个字段（'secs'/'stepCount' 是现算的复合值）
//     thumb   = 'image' | 'video'                    卡片上放真缩略图（图片=静态解码；视频=抽第一帧，有数量闸门）
// 工具节点都带"默认目标"（path 字段）：建出来就能双击用，想改再右键编辑。
//   控制台/工作台 = 本机地址；剪映/OBS = 桌面快捷方式（.lnk 走 ShellExecute，等于双击图标，
//   比直接写 exe 稳：工作目录/启动参数都按快捷方式里的来）。
// 「素材性质」两个模式值（2026-09-23 第七轮）：存盘的就是这段中文，别改字 —— 卡片副行 / 状态点 / 弹框都认它。
var FLOW_MODE_REF = '已有素材 · 参考';
var FLOW_MODE_GEN = '待生成 → 存到文件夹';
// ★「格式」下拉（2026-09-26 用户点名："所有内容节点都要有格式选择，文案默认是 md 格式，视频默认是可以录透明底流程图的格式"）★
//   格式值 → 文件扩展名：选了格式 ⇒「生成的文件名」自动补的后缀就按它（卡片副行 / 状态点会把全名写出来）。
var FLOW_FMT_EXT = { md: 'md', txt: 'txt', png: 'png', jpg: 'jpg', webp: 'webp', mp3: 'mp3', wav: 'wav', m4a: 'm4a', prores4444: 'mov', mp4: 'mp4' };
// 这个节点"生成出来会是什么后缀"：节点上选了 format 就用它；没选（老图）用类型的默认格式；再兜底类型的第一种扩展名。
function flowFmtExt(n, t) {
  var f = String((n && n.format) || '').trim();
  if (FLOW_FMT_EXT[f]) return FLOW_FMT_EXT[f];
  var fs = ((t && t.selects) || []).filter(function (x) { return x.key === 'format'; })[0];
  var dv = fs && fs.value != null ? String(fs.value) : '';
  if (FLOW_FMT_EXT[dv]) return FLOW_FMT_EXT[dv];
  return String(((t && t.exts) || [])[0] || '').replace(/^\./, '');
}
// 描述现在可以是**大文本框**（多行，2026-09-26）⇒ 卡片第二行 / Markdown 这些"一行"的地方要压成一行再显示。
function flowOneLine(s) { return String(s == null ? '' : s).replace(/[\s\u3000]+/g, ' ').trim(); }
// ★2026-09-26★ 「待生成」节点的**目标完整路径** = 存到文件夹 + 生成的文件名（按所选格式补后缀）。
//   文件名里自己带了扩展名就不重复补。返回 '' = 还没填全（这时候没什么可查的）。
//   用途：完成指示灯（见 flow 里的 checkGenDone）靠它去 stat"文件到底出来没有"。
// ★2026-09-27 用户定★ 项目文件夹继承（**写实**，不是只在内部派生）：
//   用户原话「填写项目文件夹之后，其他节点需要生成路径文件的**自动为项目文件夹**；也可以手动修改单个节点的文件夹路径」。
//   ⇒ 给「项目文件夹」填一次（或改一次）路径，就把这个路径**写进每个产物节点的「存到文件夹」字段本身**（卡片/编辑弹框里都看得见）；
//     某个节点的 dir 被手动改成**别的**路径 ⇒ 它是"自己的值"，以后项目文件夹再变也不动它。
//   为什么还要 flowDirOf：老图/手动清空的节点仍可能留空 ⇒ 内部派生兜底，保证"目标完整路径"永远算得对（见 flowGenFull）。
var FLOW_PROJ_DIR = '';                              // = 上一次同步过的项目文件夹路径（由 flowSyncProjDir 维护）
function flowProjDir() { return String(FLOW_PROJ_DIR || '').trim().replace(/[\\/]+$/, ''); }
function flowDirOf(n) {
  var d = String((n && n.dir) || '').trim().replace(/[\\/]+$/, '');
  return d || flowProjDir();
}
// 把「项目文件夹」写进各产物节点（返回 true = 真的改动了东西，调用方负责存盘）
function flowSyncProjDir(nodes, folderNode) {
  var nd = String((folderNode && folderNode.path) || '').trim().replace(/[\\/]+$/, '');
  var old = String(FLOW_PROJ_DIR || '').trim().replace(/[\\/]+$/, '');
  var changed = false;
  (nodes || []).forEach(function (n) {
    if (!n || n.dir === undefined) return;                       // 非产物节点（工具/方式/文件夹本身）不管
    var cur = String(n.dir || '').trim().replace(/[\\/]+$/, '');
    if (cur === '' && nd) { n.dir = nd; changed = true; return; } // 留空的 ⇒ 写实成项目文件夹
    if (old && cur === old && cur !== nd) { n.dir = nd; changed = true; }   // 上次跟着项目文件夹的 ⇒ 跟着变（手动改过的不动）
  });
  FLOW_PROJ_DIR = nd;
  return changed;
}
function flowGenFull(n) {
  var dir = flowDirOf(n);
  var f = String((n && n.fname) || '').trim();
  if (!dir || !f) return '';
  var ext = flowFmtExt(n, flowType(n.type));
  if (ext && !new RegExp('\\.' + ext + '$', 'i').test(f)) f += '.' + ext;
  return dir + '\\' + f;
}
// ★2026-09-27 用户定★ 内置模板：「物理科普短视频」（画布工具栏那颗「▤ 物理科普短视频」按钮就用它）。
//   只含**最初的任务流**：项目文件夹 + ①文案/②现象/③原理/④成片 + 各自的工具节点 + 固定做法（m2）。
//   现象段 1/2/3 那种"按文案分出来的段"是后面才加的，**不进模板**（用户原话：只保留一开始的任务流）。
//   路径一律留空 ⇒ 用户只要给「项目文件夹」填一次，其余节点靠 flowDirOf() 自动派生；
//   想单独改某个节点，就在那个节点里填「存到文件夹」（填了就以它为准 = 手动覆盖，见 flowGenFull 注释）。
//   注意：这份数据是从现役画布**导出**的，改模板请改这里（点一次 ⟳ 生效，不用重启 GUI）。
//   ★2026-09-27 布局（用户定）★ 第 1 行主流程横向（项目文件夹 → ①文案 → ②现象 → ③原理 → ④成片）、
//   第 2 行四个工具各自对在它服务的节点下方、第 3 行固定做法（m2）+ 方式节点（m1）、
//   右侧一列三个封面（同一 x、y 递增）。**改坐标只改 <临时目录> 的 LAYOUT 表**，
//   别手改这里（下一次跑生成器会把这一段整块覆盖）。
// ★2026-09-27 用户定★ 内置模板：「物理科普短视频」（画布工具栏那颗「▤ 物理科普短视频」按钮就用它）。
//   只含**最初的任务流**：项目文件夹 + ①文案/②现象/③原理/④成片 + 各自的工具节点 + 固定做法（m2）。
//   ★2026-09-30 用户定★ 现象片段**按小段各一个节点**（n2a/n2b/n2c…）+ **具体物体先出参考图**（m3）都已经进模板；
//   段表里有几段就摆几个（加 ②-4 照 LAYOUT 那行加、步距照 COL）。
//   路径一律留空 ⇒ 用户只要给「项目文件夹」填一次，其余节点靠 flowDirOf() 自动派生；
//   想单独改某个节点，就在那个节点里填「存到文件夹」（填了就以它为准 = 手动覆盖，见 flowGenFull 注释）。
//   注意：这份数据是从现役画布**导出**的，改模板请改这里（点一次 ⟳ 生效，不用重启 GUI）。
//   ★2026-09-27 布局（用户定）★ 第 1 行主流程横向（项目文件夹 → ①文案 → ②现象 → ③原理 → ④成片）、
//   第 2 行四个工具各自对在它服务的节点下方、第 3 行固定做法（m2）+ 方式节点（m1）、
//   右侧一列三个封面（同一 x、y 递增）。**改坐标只改 <临时目录> 的 LAYOUT 表**，
//   别手改这里（下一次跑生成器会把这一段整块覆盖）。
// ★2026-09-27 用户定★ 内置模板：「物理科普短视频」（画布工具栏那颗「▤ 物理科普短视频」按钮就用它）。
//   只含**最初的任务流**：项目文件夹 + ①文案/②现象/③原理/④成片 + 各自的工具节点 + 固定做法（m2）。
//   ★2026-09-30 用户定★ 现象片段**按小段各一个节点**（n2a/n2b/n2c…）+ **具体物体先出参考图**（m3）都已经进模板；
//   段表里有几段就摆几个（加 ②-4 照 LAYOUT 那行加、步距照 COL）。
//   路径一律留空 ⇒ 用户只要给「项目文件夹」填一次，其余节点靠 flowDirOf() 自动派生；
//   想单独改某个节点，就在那个节点里填「存到文件夹」（填了就以它为准 = 手动覆盖，见 flowGenFull 注释）。
//   注意：这份数据是从现役画布**导出**的，改模板请改这里（点一次 ⟳ 生效，不用重启 GUI）。
//   ★2026-09-27 布局（用户定）★ 第 1 行主流程横向（项目文件夹 → ①文案 → ②现象 → ③原理 → ④成片）、
//   第 2 行四个工具各自对在它服务的节点下方、第 3 行固定做法（m2）+ 方式节点（m1）、
//   右侧一列三个封面（同一 x、y 递增）。**改坐标只改 <临时目录> 的 LAYOUT 表**，
//   别手改这里（下一次跑生成器会把这一段整块覆盖）。
// ★2026-09-27 用户定★ 内置模板：「物理科普短视频」（画布工具栏那颗「▤ 物理科普短视频」按钮就用它）。
//   只含**最初的任务流**：项目文件夹 + ①文案/②现象/③原理/④成片 + 各自的工具节点 + 固定做法（m2）。
//   ★2026-09-30 用户定★ 现象片段**按小段各一个节点**（n2a/n2b/n2c…）+ **具体物体先出参考图**（m3）都已经进模板；
//   段表里有几段就摆几个（加 ②-4 照 LAYOUT 那行加、步距照 COL）。
//   路径一律留空 ⇒ 用户只要给「项目文件夹」填一次，其余节点靠 flowDirOf() 自动派生；
//   想单独改某个节点，就在那个节点里填「存到文件夹」（填了就以它为准 = 手动覆盖，见 flowGenFull 注释）。
//   注意：这份数据是从现役画布**导出**的，改模板请改这里（点一次 ⟳ 生效，不用重启 GUI）。
//   ★2026-09-27 布局（用户定）★ 第 1 行主流程横向（项目文件夹 → ①文案 → ②现象 → ③原理 → ④成片）、
//   第 2 行四个工具各自对在它服务的节点下方、第 3 行固定做法（m2）+ 方式节点（m1）、
//   右侧一列三个封面（同一 x、y 递增）。**改坐标只改 <临时目录> 的 LAYOUT 表**，
//   别手改这里（下一次跑生成器会把这一段整块覆盖）。
// ★2026-09-27 用户定★ 内置模板：「物理科普短视频」（画布工具栏那颗「▤ 物理科普短视频」按钮就用它）。
//   只含**最初的任务流**：项目文件夹 + ①文案/②现象/③原理/④成片 + 各自的工具节点 + 固定做法（m2）。
//   ★2026-09-30 用户定★ 现象片段**按小段各一个节点**（n2a/n2b/n2c…）+ **具体物体先出参考图**（m3）都已经进模板；
//   段表里有几段就摆几个（加 ②-4 照 LAYOUT 那行加、步距照 COL）。
//   路径一律留空 ⇒ 用户只要给「项目文件夹」填一次，其余节点靠 flowDirOf() 自动派生；
//   想单独改某个节点，就在那个节点里填「存到文件夹」（填了就以它为准 = 手动覆盖，见 flowGenFull 注释）。
//   注意：这份数据是从现役画布**导出**的，改模板请改这里（点一次 ⟳ 生效，不用重启 GUI）。
//   ★2026-09-27 布局（用户定）★ 第 1 行主流程横向（项目文件夹 → ①文案 → ②现象 → ③原理 → ④成片）、
//   第 2 行四个工具各自对在它服务的节点下方、第 3 行固定做法（m2）+ 方式节点（m1）、
//   右侧一列三个封面（同一 x、y 递增）。**改坐标只改 <临时目录> 的 LAYOUT 表**，
//   别手改这里（下一次跑生成器会把这一段整块覆盖）。
// ★2026-09-27 用户定★ 内置模板：「物理科普短视频」（画布工具栏那颗「▤ 物理科普短视频」按钮就用它）。
//   只含**最初的任务流**：项目文件夹 + ①文案/②现象/③原理/④成片 + 各自的工具节点 + 固定做法（m2）。
//   ★2026-09-30 用户定★ 现象片段**按小段各一个节点**（n2a/n2b/n2c…）+ **具体物体先出参考图**（m3）都已经进模板；
//   段表里有几段就摆几个（加 ②-4 照 LAYOUT 那行加、步距照 COL）。
//   路径一律留空 ⇒ 用户只要给「项目文件夹」填一次，其余节点靠 flowDirOf() 自动派生；
//   想单独改某个节点，就在那个节点里填「存到文件夹」（填了就以它为准 = 手动覆盖，见 flowGenFull 注释）。
//   注意：这份数据是从现役画布**导出**的，改模板请改这里（点一次 ⟳ 生效，不用重启 GUI）。
//   ★2026-09-27 布局（用户定）★ 第 1 行主流程横向（项目文件夹 → ①文案 → ②现象 → ③原理 → ④成片）、
//   第 2 行四个工具各自对在它服务的节点下方、第 3 行固定做法（m2）+ 方式节点（m1）、
//   右侧一列三个封面（同一 x、y 递增）。**改坐标只改 <临时目录> 的 LAYOUT 表**，
//   别手改这里（下一次跑生成器会把这一段整块覆盖）。
// ★2026-09-27 用户定★ 内置模板：「物理科普短视频」（画布工具栏那颗「▤ 物理科普短视频」按钮就用它）。
//   只含**最初的任务流**：项目文件夹 + ①文案/②现象/③原理/④成片 + 各自的工具节点 + 固定做法（m2）。
//   ★2026-09-30 用户定★ 现象片段**按小段各一个节点**（n2a/n2b/n2c…）+ **具体物体先出参考图**（m3）都已经进模板；
//   段表里有几段就摆几个（加 ②-4 照 LAYOUT 那行加、步距照 COL）。
//   路径一律留空 ⇒ 用户只要给「项目文件夹」填一次，其余节点靠 flowDirOf() 自动派生；
//   想单独改某个节点，就在那个节点里填「存到文件夹」（填了就以它为准 = 手动覆盖，见 flowGenFull 注释）。
//   注意：这份数据是从现役画布**导出**的，改模板请改这里（点一次 ⟳ 生效，不用重启 GUI）。
//   ★2026-09-27 布局（用户定）★ 第 1 行主流程横向（项目文件夹 → ①文案 → ②现象 → ③原理 → ④成片）、
//   第 2 行四个工具各自对在它服务的节点下方、第 3 行固定做法（m2）+ 方式节点（m1）、
//   右侧一列三个封面（同一 x、y 递增）。**改坐标只改 <临时目录> 的 LAYOUT 表**，
//   别手改这里（下一次跑生成器会把这一段整块覆盖）。
var FLOW_TPL_PHYSICS = {
  name: '空白画布',
  hint: '自己拖节点：想法 → 素材 → 草稿 → 产出 → 复盘',
  nodes: [],
  edges: []
};;
var FLOW_TPL_CODEVIDEO = {
  name: "代码视频",
  hint: "代码生成的短片：画面+音效本地跑（0 元 API），字幕与 BGM 交给剪映；跑哪一步哪个节点亮灯",
  nodes: [
    {"path":"","desc":"这部片子的全部产物：src / 渲染 / 声音 / 成片 / 封面 / 素材 / 记录。**双击在预览面板摊开**。⚠ 只填这一次 —— 其余节点「存到文件夹」留空就自动跟随这里。★ 根目录 `<视频工作流> 只放两样：`脚本\\`（流水线脚本，所有片子共用）与 `模板\\`（新片骨架）；**一部片子一个日期文件夹**。","id":"d1","type":"folder","name":"项目文件夹 · <项目>","x":20,"y":16},
    {"path":"","desc":"要什么样的文案：**真实、合情合理、不吹**；每句 ≤14 字（口播节奏）；**每句结尾不留标点**。写完把每句的秒数也定下来 —— 它就是②时间轴里 lines 的来源（台词合计必须等于镜头时长）。","id":"n1","type":"text","name":"① 文案 · 台词表","mode":"待生成 → 存到文件夹","format":"md","dir":"","fname":"文案","x":256,"y":16},
    {"path":"","desc":"**全片唯一真相**（JSON）：<N> 镜 · <秒>s · 镜头 t0/t1/tscale · 台词秒数 · 字幕 subs · 音效对位 sfx · 幕刻度 chapters。画面读它出帧、混音读它摆音效、字幕读它出 SRT/剪映字幕轨。**交付开关**：`meta.audio.bgm=false` 不要 BGM、`meta.audio.vo=false` 不要旁白、`meta.noSubs=true` 不烧字幕（字幕交剪映）。⚠ 台词秒数之和必须等于镜头时长（build.mjs 自检）。","id":"n2","type":"text","name":"② 时间轴 · 唯一真相","mode":"待生成 → 存到文件夹","format":"txt","dir":"","fname":"时间轴","x":492,"y":16},
    {"path":"","desc":"","id":"n3","type":"html","name":"③ 分镜代码 · <N> 镜","mode":"待生成 → 存到文件夹","format":"html","dir":"","fname":"大片","purpose":"单文件 HTML：把整条片子写成确定性页面，供无头 Edge 逐帧渲染（不录屏、可重渲、可分段）。骨架直接拷 `模板\\src\\`。","prompt":"硬要求：① `window.__DURATION_MS` + `window.__frame(tMs)`，同一个 t 必须渲染同一帧（禁 Date.now / 随机）；② `?noauto=1` 时不要自己跑 rAF；③ 坐标一律用 S.W/S.H 比例（草稿能降到 960×540 跑）；④ 底部 12% 留字幕安全区；⑤ 后处理只在半分辨率做（泛光/分级/暗角/颗粒/色散烘进\"大气层\"）。镜头 = 一个函数 `shotNN(ctx, S, PX)`，build 全量内联。","x":728,"y":16},
    {"path":"","desc":"","id":"n4","type":"video","name":"④ 出帧渲染 · N 段并行","mode":"待生成 → 存到文件夹","format":"mp4","seg":"自定义","t0":"0","t1":"<秒>","dir":"","fname":"J1","plot":"一条命令：`node 脚本\\render.mjs --proj <项目> --n 8 --detach`（按时长自动切片、各自独立 EDGE_PROFILE + 端口、脱离父进程所以会话重启也不丢）。★必须 `--jpg 95`★：4K 实测 PNG 2089ms/帧 vs JPEG 204ms/帧，而画面本身只要 193ms —— **编码器才是瓶颈**。⚠ 拼接前逐段 ffprobe 过闸门（没有 moov = 还没写完，拼了会得到\"能播、时长对、内容少一截\"的假成片）；⚠ **改完 src\\ 一定先 build 再出帧**，否则拿着旧 HTML 白渲一整轮。","x":964,"y":16},
    {"path":"","desc":"","id":"n5","type":"video","name":"⑤ 成片 · 画面 + 音效","mode":"待生成 → 存到文件夹","format":"mp4","seg":"自定义","t0":"0","t1":"<秒>","dir":"","fname":"<片名>-4K60","plot":"`node 脚本\\finish.mjs --proj <项目>`：闸门 → 拼接（-c copy）→（看 `meta.noSubs`，默认**不烧字幕**）合混音母版 → H.264 CRF19 + AAC + faststart。规格：3840×2160 · 60fps · 16:9 · <秒>s。**交付形态**：只要**画面 + 音效**；字幕与 BGM 都由剪映做。","x":1200,"y":16},
    {"path":"","desc":"","id":"n6","type":"video","name":"⑥ 剪映草稿","mode":"待生成 → 存到文件夹","format":"mp4","dir":"","fname":"剪映草稿","plot":"`node 脚本\\剪映草稿.mjs --proj <项目> [--go]`：把成片塞进主画面轨 + 按时间轴 subs 铺一条**字幕轨**（新青年体 / 字号 9 / `transform_y=-0.75` 即界面 y-900 / 默认描边），**不带 BGM 轨、不带配音轨**。铁律：先 dry_run 看清单（`成片\\_剪映清单.json`），确认无误再加 `--go`；发布后在剪映里刷新或重开才看得到草稿。","x":1436,"y":16},
    {"path":"","desc":"`node 脚本\\covers.mjs --proj <项目>`：16:9（2560×1440）/ 4:3（2304×1728）/ 3:4（1728×2304），标题《<片名>》+ 署名。★底图必须从**无字幕母版**（`渲染\\合并.mp4`）抽帧★ —— 从成片抽会把画面里的字带进封面。","id":"n7","type":"image","name":"⑦ 封面 · 三比例","mode":"待生成 → 存到文件夹","format":"png","use":"封面","dir":"","fname":"封面-16-9-成品","x":1672,"y":16},
    {"path":"","desc":"","id":"m1","type":"preset","name":"代码视频配方（一条命令链）","steps":"① node 脚本\\新建短片.mjs <项目名>     从 模板\\ 生成骨架 + 标准目录 + 时间轴\n② 改两个地方：<项目>\\时间轴.json 与 <项目>\\src\\（每镜一个 shotNN）\n③ node 脚本\\build.mjs --proj <项目>      自检 + 内联成 渲染\\大片.html\n④ node 脚本\\bench.mjs <html> <秒> 6 3840 2160   先量成本\n⑤ node 脚本\\sfx.mjs --proj <项目>        26 条程序化音效\n⑥ node 脚本\\mix.mjs --proj <项目>        混音母版 + 成片\\字幕.srt\n⑦ node 脚本\\render.mjs --proj <项目> --n 8 --detach   出帧（一条命令）\n⑧ node 脚本\\finish.mjs --proj <项目>     闸门 → 拼接 → 合音\n⑨ node 脚本\\剪映草稿.mjs --proj <项目> --go   出剪映草稿（字幕轨铺好）\n⑩ node 脚本\\covers.mjs --proj <项目>     三比例封面","prompt":"「代码视频」这条流水线的固定配方：**画面与音效由代码/本机生成，0 元 API；字幕与 BGM 交给剪映**。三条纪律：① 出帧必须 JPEG；② 后处理只在半分辨率；③ 时间轴是唯一真相（画面/声音/字幕三处都读它）。只重渲受影响的镜头（`--t0`）；**跑哪一步，画布上那个节点就会呼吸亮灯**。","x":20,"y":448},
    {"path":"","desc":"","id":"t1","type":"webai-deepseek","name":"网页版 AI（选题/文案 · 可选）","duty":"可选：把选题、文案初稿外包给免费网页版 AI（豆包/通义/DeepSeek/智谱/Kimi，0 元 API）。用户要求\"全由会话把关\"时就不用它 —— 线路留在图上是给以后的片子用的。","x":256,"y":232},
    {"path":"","desc":"`node 脚本\\sfx.mjs --proj <项目>`：正弦/噪声/包络现场合成（打字·心跳·whoosh·riser·impact·glitch·修复铃·数据扫频·机械嗡鸣·风扇…），**零采样零版权**。","id":"a1","type":"audio","name":"音效 · 26 条（全程序化）","mode":"待生成 → 存到文件夹","format":"wav","use":"音效","dir":"","fname":"sfx","x":20,"y":664},
    {"path":"","desc":"`node 脚本\\mix.mjs --proj <项目>`：按时间轴把音效逐条摆位（cue 是\"镜头内部毫秒\" ⇒ 要除以 tscale）+ 空间混响 + loudnorm 到 -14 LUFS。看时间轴开关：`bgm=false` 不做 BGM、`vo=false` 不做旁白 ⇒ **只出画面 + 音效**；同时另存 `成片\\字幕.srt` 给剪映导入。⚠ 配乐短于成片会 undefined→NaN 把整条母版变静音。","id":"a2","type":"audio","name":"混音母版（对位 + 混响）","mode":"待生成 → 存到文件夹","format":"wav","use":"音效","dir":"","fname":"混音母版","x":256,"y":664},
    {"path":"","desc":"**这一条不在这里生成** —— 按用户规矩：BGM 在剪映里**另起一条、用现成素材**（不自己合成），按内容挑。节点留在图上是让流程完整可见。","id":"a3","type":"audio","name":"BGM（剪映里加）","mode":"","format":"mp3","use":"BGM","dir":"","fname":"BGM","x":492,"y":664},
    {"path":"","desc":"**这一条也不在这里生成** —— 在剪映里用「朗读」生成（音色：真人新闻主播）。MCP 与 pyJianYingDraft 都没有 TTS 能力，这一步必须在剪映里点一次。","id":"a4","type":"audio","name":"配音（剪映朗读）","mode":"","format":"mp3","use":"配音","dir":"","fname":"配音","x":728,"y":664},
    {"path":"","desc":"由 ⑥ 剪映草稿脚本按时间轴 `subs` 铺成剪映的**字幕轨**（可改、可删、可重排）：新青年体 / 字号 9 / x0 y-0.75（＝界面 y-900）/ 默认描边。另有一份 `成片\\字幕.srt` 可直接导入剪映。**每句结尾不留标点**（生成时已 trimEnd）。","id":"s1","type":"text","name":"字幕（剪映字幕轨）","mode":"待生成 → 存到文件夹","format":"txt","dir":"","fname":"字幕","x":964,"y":664}
  ],
  edges: [
    {"id":"e1","from":"n1","to":"n2","kind":"seq"},
    {"id":"e2","from":"n2","to":"n3","kind":"seq"},
    {"id":"e3","from":"n3","to":"n4","kind":"seq"},
    {"id":"e4","from":"n4","to":"n5","kind":"seq"},
    {"id":"e5","from":"n5","to":"n6","kind":"seq"},
    {"id":"e6","from":"n5","to":"n7","kind":"seq"},
    {"id":"e7","from":"m1","to":"n2","kind":"how"},
    {"id":"e8","from":"m1","to":"n3","kind":"how"},
    {"id":"e9","from":"m1","to":"n4","kind":"how"},
    {"id":"e10","from":"m1","to":"n5","kind":"how"},
    {"id":"e11","from":"m1","to":"n6","kind":"how"},
    {"id":"e12","from":"m1","to":"n7","kind":"how"},
    {"id":"e13","from":"t1","to":"n1","kind":"how"},
    {"id":"e14","from":"a1","to":"a2","kind":"seq"},
    {"id":"e15","from":"a2","to":"n5","kind":"dep"},
    {"id":"e16","from":"a3","to":"n6","kind":"dep"},
    {"id":"e17","from":"a4","to":"n6","kind":"dep"},
    {"id":"e18","from":"s1","to":"n6","kind":"dep"},
    {"id":"e19","from":"d1","to":"n1","kind":"dep"},
    {"id":"e20","from":"d1","to":"n2","kind":"dep"},
    {"id":"e21","from":"d1","to":"n5","kind":"dep"},
    {"id":"e22","from":"d1","to":"n6","kind":"dep"}
  ]
};
var FLOW_TYPES = [
  {
  },

  {
    id: 'text', name: '文案', icon: '✎', color: '#4f8cff', cat: 'content',
    kind: 'file', sides: 'lrtb',
    exts: ['.md', '.txt', '.srt', '.csv'],
    newName: '文案',
    pathLabel: '路径', pathHint: '<视频工作流>',
    // ★描述就是"要求"那一栏（2026-09-26 用户点名："文案节点的描述窗口大一点，这个描述就是需要什么样的文案，我填写要求，比如 500 字的啥啥啥"）★
    //   ⇒ 内容节点的「描述」改成**大文本框**（`descRows` / `descHint`）：写"要 500 字、讲什么、什么口吻"正合适。
    descRows: 5,
    descHint: '需要什么样的文案？例：500 字，讲我为什么开始做视频工作流，口语化，结尾留个钩子',
    // ★素材性质 + 生成文件名 + 存到文件夹（2026-09-23 用户拍板 + 第十一轮修正）：
    //   mode 是第一栏（老图没有 ⇒ 当空串 ⇒ 卡片零变化）；「生成的文件名 + 存到文件夹」只在 mode=待生成时显示
    //   （第十一轮用户原话"待生成也要有个选择文件夹，参考素材是选择具体文件"⇒ 待生成 = fname+dir，
    //   参考素材 = 路径（选具体文件），两边互不显示）。
    // ★格式（2026-09-26 用户点名："所有内容节点都要有格式选择，文案默认是 md 格式"）★
    //   ⇒ 文案默认 md，也可以 txt（选中的格式决定「生成的文件名」自动补什么后缀）。
    selects: [{ key: 'mode', label: '素材性质', options: ['', FLOW_MODE_REF, FLOW_MODE_GEN] },
      { key: 'format', label: '格式', options: ['md', 'txt'], value: 'md' }],
    dirs: [
      { key: 'fname', label: '生成的文件名', hint: '例：小猫成片（不带扩展名，自动按所选「格式」补后缀）' },
      { key: 'dir', label: '存到文件夹', hint: '例：<视频工作流> 📁 选）' }
    ],
    subKeys: ['genDir'],
    note: '路径写真实文件（.md 为主，也可以 .txt）：填好后双击这个节点，内容就摊在预览面板里改、直接存盘。'
      + '口开在四面：右出主线、左入主线、下口接方式、上口接依据。',
    tip: '一个 .md / .txt 文件：双击在预览面板里摊开并直接改'
  },
  {
    id: 'video', name: '视频', icon: '🎬', color: '#ff7ab6', cat: 'content',
    kind: 'file', sides: 'lrtb',
    exts: ['.mp4', '.mov', '.mkv', '.webm', '.avi'],
    newName: '视频',
    pathLabel: '路径', pathHint: '<视频工作流>',
    // ★「用什么方式生成」不再是一栏（2026-09-26 用户点名改）★
    //   用户原话：「内容节点的视频节点为啥点击编辑会有'用什么方式生成'？那个是靠连线得到的」。
    //   ⇒ 方式**只认连线**：把工具节点用方式线（how）连到这一段上，卡片和导出就显示「→ 用 <工具>」。
    //   原来那个 method 下拉是**同一件事说两遍**（既选了工具 A、线又连到工具 B 时该算谁？）—— 已删。
    //   老图里存着的 method 字段不再被读、也不再被写（**不主动清**，免得动用户的数据）。
    //   段落 + 起止秒 = 这一段在成片里的位置（"顺序不靠眼睛数位置"：卡片角标 + 导出里的 ①②③ 都由它定）。
    // ★视频节点不要那个一行的「描述」（2026-09-26 用户点名："视频节点也是一样，只需要描述，描述窗口大一点
    //   然后标注一下情节提示词" ⇒ 用户选了"只留一个大框，标签就叫「情节 / 提示词」"）★
    //   ⇒ `noDesc: true`：编辑框里不再出现「描述」那一行（**字段本身还在**，卡片第二行仍用它的值，值不丢）。
    noDesc: true,
    //   「情节 / 提示词」就是那个唯一的**大框**（rows 4 → 7）：写具体情节提示词用。
    texts: [{ key: 'plot', label: '情节 / 提示词', rows: 7, hint: '这一段具体怎么拍/生成什么（例：冰块掉进玻璃杯后浮起来，特写，浅色台面，明亮自然光）。⚠ 四条纪律：① AI 画面里**不许有自带字幕/文字**（字幕一律剪映后期加）② 只要画面，**不要 BGM**（音效可以）③ **不许出现真人**（不要真人的手/真人脸/真实人物，需要人、手时用**动漫（二次元）形象**）④ **风格按内容定**：抽象概念（光/声/电/磁/波）走**科技感/特效感**，具体实物（冰块/水/沉浮）走**真实感/物理感**' },
      // ★2026-09-26★ 用户点名："每有一个视频片段就要有这个节点，这个节点下面对应相应的 AI 提示词文案
      //   以及对应的文案（也就是字幕和配音 —— 剪映操作，AI 画面里不能有自带字幕）" ⇒ 视频节点多这一栏：
      //   它就是该段的字幕与配音文本（剪映照它上字幕、配 TTS）；一行一段、和口播稿逐句对上。
      { key: 'line', label: '本段口播 / 字幕', rows: 3, hint: '这一段对应的解说词（剪映照它上字幕 + TTS 配音；画面提示词里要写明"不要任何文字/字幕"）' }],
    selects: [{ key: 'mode', label: '素材性质', options: ['', FLOW_MODE_REF, FLOW_MODE_GEN] },
      { key: 'seg', label: '段落', options: ['', '开头', '前半段', '后半段', '结尾', '自定义'] },
      // ★格式（2026-09-26 用户点名：所有内容节点都要有格式选择，视频默认=能录透明底流程图的格式）★
      //   prores4444 = MOV · ProRes 4444（带 alpha 的透明底，透明流程图流水线就是它，见技能 transparent-flow-video）；
      //   mp4 = 普通成片（不透明）。默认 prores4444。
      { key: 'format', label: '格式', options: [{ v: 'prores4444', t: 'MOV · ProRes 4444（透明底流程图）' }, { v: 'mp4', t: 'MP4（普通成片）' }], value: 'prores4444' }],
    dirs: [
      { key: 'fname', label: '生成的文件名', hint: '例：小猫成片（不带扩展名，自动按所选「格式」补后缀）' },
      { key: 'dir', label: '存到文件夹', hint: '例：<视频工作流> 📁 选）' }
    ],
    nums: [{ key: 't0', label: '起始秒', hint: '例：5' }, { key: 't1', label: '结束秒', hint: '例：15' }],
    subKeys: ['seg', 'secs', 'genDir'],
    thumb: 'video',   // ★卡片上抽第一帧当缩略图★（真要解码，所以有数量闸门：FLOW_VIDEO_THUMB_MAX）
    note: '成片文件（.mp4/.mov/.mkv/.webm/.avi）：双击在预览面板里直接放。'
      + '另几栏是给 AI 看的 —— 「段落 + 起止秒」定它在成片时间线上的位置、「情节」说明这一段要什么样；'
      + '**用什么做？把工具节点用「方式线」连到它身上**（卡片上会显示「→ 用 豆包」）。',
    tip: '成片：双击在预览面板里播放；「段落 / 起止秒 / 情节」是给 AI 会话看的；**方式看连线**（谁连到它）'
  },
  {
    id: 'image', name: '图片', icon: '🖼', color: '#2dd4bf', cat: 'content',
    kind: 'file', sides: 'lrtb',
    exts: ['.png', '.jpg', '.jpeg', '.webp', '.gif'],
    newName: '图片',
    pathLabel: '路径', pathHint: '<视频工作流>',
    // ★图片节点（2026-09-26 用户点名："图片节点也有有个参考或者是待生成，然后描述窗口大一点写具体生成的要求，
    //   **不需要备注窗口了**"）★ ⇒ ①「备注」那一栏**删掉**（`texts` 整个去掉、subKeys 里的 `note` 也去掉）；
    //   ②「描述」升级成大文本框（`descRows`）= 写"具体生成的要求"（例：白色背景、一只橘猫、16:9、留出标题区）。
    descRows: 5,
    descHint: '要生成什么样的图？例：16:9 白色背景，一只橘猫趴在键盘上，画面右上角留出标题位置',
    selects: [{ key: 'mode', label: '素材性质', options: ['', FLOW_MODE_REF, FLOW_MODE_GEN] },
      { key: 'use', label: '用途', options: ['', '参考图', '生成结果', '封面'] },
      { key: 'format', label: '格式', options: ['png', 'jpg', 'webp'], value: 'png' }],
    dirs: [
      { key: 'fname', label: '生成的文件名', hint: '例：封面主图（不带扩展名，自动按格式补 .png/.jpg/.webp）' },
      { key: 'dir', label: '存到文件夹', hint: '例：<视频工作流> 📁 选）' }
    ],
    subKeys: ['use', 'genDir'],
    thumb: 'image',   // ★卡片上显示真缩略图★（读不到文件就退回图标，见 updateThumb）
    note: '图片文件（.png/.jpg/.jpeg/.webp/.gif）：双击在预览面板里看大图；卡片上直接显示缩略图。'
      + '「描述」就是**具体生成的要求**（写清要什么样的图）；「用途」那栏是给 AI 看的 —— 这张图是参考图、生成结果还是封面；'
      + '「格式」定生成出来是 .png/.jpg/.webp（待生成时按它补后缀）。',
    tip: '一张图：双击在预览面板里看；卡片上带缩略图；「描述」= 生成要求、「用途」= 参考图/生成结果/封面'
  },
  {
    id: 'audio', name: '音频', icon: '🎙', color: '#f0a35e', cat: 'content',
    kind: 'file', sides: 'lrtb',
    exts: ['.mp3', '.wav', '.m4a', '.flac', '.aac'],
    newName: '音频',
    pathLabel: '路径', pathHint: '<视频工作流>',
    // ★（2026-09-26）内容节点统一：描述 = 大文本框（说清"要什么样的"）+ 格式下拉★
    descRows: 4,
    descHint: '要什么样的音频？例：30 秒轻快电子 BGM，不要鼓点，垫在口播下面',
    selects: [{ key: 'mode', label: '素材性质', options: ['', FLOW_MODE_REF, FLOW_MODE_GEN] },
      { key: 'use', label: '用途', options: ['', '配音', 'BGM', '音效'] },
      { key: 'format', label: '格式', options: ['mp3', 'wav', 'm4a'], value: 'mp3' }],
    dirs: [
      { key: 'fname', label: '生成的文件名', hint: '例：开场BGM（不带扩展名，自动按格式补 .mp3/.wav/.m4a）' },
      { key: 'dir', label: '存到文件夹', hint: '例：<视频工作流> 📁 选）' }
    ],
    texts: [
      { key: 'source', label: '谁念 / 来源', rows: 2, hint: '配音写"我的声音"/"TTS"；BGM/音效写来源（曲名 / 素材站 / 豆包生成）' },
      { key: 'note', label: '备注', rows: 2, hint: '还有啥要交代的（例：垫在 5-15s 那段下面，音量 -12dB）' }
    ],
    subKeys: ['use', 'source', 'genDir'],
    note: '音频文件（.mp3/.wav/.m4a/.flac/.aac）：双击在预览面板里播放、摊开。'
      + '⚠ **字幕不单独建类型**（用户定的：字幕默认归剪映）—— 剪映那个工具节点的「默认干什么」里写清了。',
    tip: '一段音频（配音 / BGM / 音效）：双击在预览面板里播放；字幕不建类型，默认归剪映'
  },
  {
    id: 'html', name: 'HTML', icon: '</>', color: '#c084fc', cat: 'method',
    kind: 'file', sides: 'tb',
    exts: ['.html', '.htm'],
    newName: 'HTML',
    pathLabel: '路径', pathHint: '<视频工作流>',
    // ★2026-09-26 用户点名：方式节点也要「素材性质（已有素材·参考 / 待生成）」+ 待生成时填「生成的文件名 / 存到文件夹」★
    //   为什么：这份 HTML 常常是**要 AI 现做一份**（待生成），而不是手头已有一份（参考）；
    //   用内容节点同一套语义 ⇒ 状态点「◎ 待生成 → 存到 …」、卡片副行、Markdown、📁 选文件夹按钮**全是白拿的**
    //   （那些代码一律按 `mode` / `t.dirs` 泛型走，没有按 `cat` 拦过 —— 加类型只写类型行）。
    selects: [{ key: 'mode', label: '素材性质', options: ['', FLOW_MODE_REF, FLOW_MODE_GEN] }],
    dirs: [
      { key: 'fname', label: '生成的文件名', hint: '例：流程图模板（不带扩展名，自动按类型补）' },
      { key: 'dir', label: '存到文件夹', hint: '例：<视频工作流> 📁 选）' }
    ],
    subKeys: ['genDir'],
    // ★语义（用户 2026-09-21 拍板）★ **HTML 是"怎么做"（方式），不是产出物** ⇒ 本批从内容类挪到方式类。
    //   这个节点连上谁，就是在告诉那个工具/会话：**用这份 HTML、按这段指令去做这件事**。
    // ★图标从 🧩 换成 `</>`★：🧩 撞了顶栏那个「插件」按钮（`renderer\index.html` 里 `#btn-plugins` 就是 🧩），
    //   图上和顶栏两个地方同一个图标、含义还不一样。`</>` 三个字符确实比 emoji 宽（12px 字号下约 21px vs 13px），
    //   但卡片头是 flex 行、标题自带省略号，挤掉的是标题的几个像素，不会溢出也不会换行 ⇒ 就用它（选型见报告）。
    texts: [
      { key: 'purpose', label: '要做什么', rows: 3, hint: '例：用 html 生成背景透明的流程图视频' },
      { key: 'prompt', label: '指令模板', rows: 4, hint: '给会话照做的那段话（复制给 AI 会话，让它按这个做）' }
    ],
    note: '网页文件（.html/.htm）：双击在预览面板里看（HTML 自带「👁 看效果 / ✎ 编辑源码」互切，不用另配）。'
      + '「素材性质」两选：**手头已有一份 = 已有素材 · 参考**（填路径，双击就能预览）；'
      + '**要 AI 现做一份 = 待生成 → 存到文件夹**（填生成的文件名 + 存到文件夹，生成完把路径填上照样双击预览）。'
      + '★HTML 是"方式"不是产出物★：「要做什么 + 指令模板」两栏是给 AI 看的 —— 这个节点连上谁，'
      + '就是在告诉那个工具/会话：用这份 HTML、按这段指令去做这件事。',
    tip: '一份 HTML（方式节点）：双击在预览面板里看效果或改源码；「要做什么 + 指令模板」是给 AI 会话照做的；'
      + '「素材性质」分参考（已有这份）与待生成（要 AI 现做，填文件名 + 文件夹）'
  },
  {
    id: 'preset', name: '固定流程预设', icon: '📋', color: '#a78bfa', cat: 'method',
    kind: 'preset', sides: 'tb',
    newName: '固定流程预设',
    // ★这个节点没有文件、也没有地址★：它的内容就是"一套固定做法"（步骤清单 + 指令模板），
    //   双击 = 把这份做法摊到预览面板（两种形式，见 tpl/preview 两栏）。
    texts: [
      { key: 'steps', label: '步骤清单（一行一步）', rows: 5, hint: '一行一步，例：\nHTML 模板\nEdge 无头逐帧导 α PNG\nffmpeg 合成 ProRes 4444' },
      { key: 'prompt', label: '指令模板', rows: 5, hint: '给会话照做的那段话（导出的 Markdown 里「## 指令」那一节就是它）' }
    ],
    // `ui:true` = 这一栏只是给人挑"怎么看"的，不是做法本身 ⇒ 不进卡片副行、也不进导出的 Markdown
    selects: [{ key: 'preview', label: '预览形式', ui: true, options: [{ v: 'text', t: '文字说明（默认）' }, { v: 'canvas', t: '流程图小图' }], value: 'text' }],
    // 内置模板：选中就把 steps/prompt 填进上面两栏（之后照样能手改）。
    // 为什么写死在这里而不是另存一个文件：模板要跟类型一起 ⟳ 热更，写文件就得引 IPC / 加读写路径，不划算。
    tpl: {
      label: '内置模板', hint: '选一个模板先把步骤和指令填好，再按自己的情况改',
      list: [
        {
          name: '① 透明流程图流水线（对得上技能 transparent-flow-video）',
          steps: '写 HTML 模板（16:9 流程图）\nEdge 无头 + CDP 逐帧导出带 alpha 的 PNG\nffmpeg 合成 ProRes 4444（透明背景）\n同时出一份预览 MP4',
          prompt: '用「透明流程图流水线」做：先写 HTML 版流程图，再用 Edge 无头 + CDP 逐帧导出带 alpha 的 PNG，'
            + '最后用 ffmpeg 合成 ProRes 4444（透明背景），并另出一份预览 MP4。技能：transparent-flow-video。'
        },
        {
          name: '② OBS 录屏成段（网页里的东西录下来当一段）',
          steps: 'DeepSeek 网页版出代码\n生成 HTML\n打开页面\nOBS 录屏\n得到这一段视频\n最后拼接',
          prompt: '这一段用录屏做：先让 DeepSeek 网页版写代码 → 生成 HTML → 打开页面 → 用 OBS 录屏 → 得到这一段视频；'
            + '所有段落最后用剪映拼接、加字幕。'
        }
      ]
    },
    subKeys: ['stepCount'],
    note: '固定流程预设（方式节点）：把"这一套固定做法"存成一个节点 —— 步骤清单 + 指令模板。'
      + '双击就把这份做法摊到预览面板（「预览形式」选文字说明或流程图小图）。'
      + '⚠ 预览那张小图是**只读的示意图**，不是可编辑画布（要改就右键编辑这个节点的步骤）。',
    tip: '一套固定做法（步骤清单 + 指令模板）：双击摊到预览面板看；导出的 Markdown 里「## 指令」就是它'
  },
  {
    id: 'cui-console', name: 'ComfyUI 控制台', icon: '🖥', color: '#e5b355', cat: 'board',
    kind: 'url', sides: 'tb',
    url: 'http://127.0.0.1:8189/', probe: { host: '127.0.0.1', port: 8189 },
    newName: 'ComfyUI 控制台',
    pathLabel: '地址', pathHint: 'http://127.0.0.1:8189/',
    note: '这个是"看状态用"的工具节点：双击在预览面板里打开控制台；口开在上下，一般只跟下面的工作台连。',
    tip: '看控制台状态：双击在预览面板里打开；口开在上下，一般只跟工作台连'
  },
  {
    id: 'cui-desk', name: 'ComfyUI 工作台', icon: '⚙', color: '#34c98f', cat: 'tool',
    kind: 'url', sides: 'tb',
    url: 'http://127.0.0.1:8188/', probe: { host: '127.0.0.1', port: 8188 },
    newName: 'ComfyUI 工作台',
    pathLabel: '地址', pathHint: 'http://127.0.0.1:8188/',
    // 「默认干什么」= 工具类的公共字段 duty（建节点时按这里的 value 预设好，右键编辑能改）。
    //   为什么要有它：会话拿到导出的 Markdown 时，光看"剪映"三个字还得猜这一步拿它干什么；
    //   写清"拼接 + 自动字幕"它就能直接照做（字幕不建类型，就是在这里交代的）。
    texts: [{ key: 'duty', label: '默认干什么', rows: 2, value: '生成（跑工作流出视频片段）', hint: '这一步拿它干什么（会写进导出的 Markdown）' }],
    subKeys: ['duty'],
    note: '干活的主体：双击在预览面板里打开工作台（在预览面板里就能跑工作流）。'
      + '口开在上下两面（在下往上产出 = 方式线）；第三行的点是它的状态 —— 绿点=在跑，红点=没运作。',
    tip: '干活的主体：双击在预览面板里打开工作台；绿点=在跑 / 红点=没运作；口在上下面（往上产出）'
  },
  {
    id: 'jianying', name: '剪映', icon: '✂', color: '#ef5d6d', cat: 'tool',
    kind: 'app', sides: 'tb',
    path: '<桌面>\\剪映专业版.lnk',
    newName: '剪映',
    pathLabel: '程序', pathHint: '<桌面>\\剪映专业版.lnk',
    texts: [{ key: 'duty', label: '默认干什么', rows: 4, value: '拼接（按①的分段表顺序和秒数）+ 字幕 + 配音 + BGM + 导出 4:3\n字幕：新青年体 · 字号 9 · 位置 x0 / y-1200 · 默认描边\nAI 片段一律不带 BGM（可带音效）；BGM 另起一条、按内容挑\n配音：剪映「朗读」（TTS）', hint: '这一步拿它干什么（会写进导出的 Markdown）' }],
    subKeys: ['duty'],
    note: '剪辑软件：双击直接打开剪映（不做预览，只当流程里的一环）。填桌面快捷方式（.lnk）最稳。'
      + '★字幕默认归它：用户定的"字幕不建类型"，所以自动字幕写在这个节点的「默认干什么」里。'
      + '★2026-09-27 用户定的**物理科普短视频默认样式**（就是这个默认值）：字幕新青年体/字号 9/位置 x0,y-1200/默认描边；'
      + 'AI 生成的画面片段一律**不带 BGM**（允许带音效），BGM 单独一条并按内容选；配音走剪映朗读。',
    tip: '剪辑软件：双击直接打开剪映；默认干"拼接 + 字幕（新青年体 9 号 x0 y-1200 描边）+ 配音 + BGM"'
  },
  {
    id: 'obs', name: 'OBS 录屏', icon: '⏺', color: '#8b93a7', cat: 'tool',
    kind: 'app', sides: 'tb',
    path: '<桌面>\\OBS Studio.lnk',
    newName: 'OBS 录屏',
    pathLabel: '程序', pathHint: '<桌面>\\OBS Studio.lnk',
    texts: [{ key: 'duty', label: '默认干什么', rows: 2, value: '录屏（把网页/操作录成一段视频）', hint: '这一步拿它干什么（会写进导出的 Markdown）' }],
    subKeys: ['duty'],
    note: '录屏工具：双击直接打开 OBS（不做预览）。填桌面快捷方式（.lnk）最稳。',
    tip: '录屏工具：双击直接打开 OBS；默认干"把网页/操作录成一段视频"'
  },
  // ---- 5 个「网页版 AI」节点（都属于工具节点 cat:'tool'）----
  // 它们双击 = 打开**顶栏那排图标背后的同一个浮动窗口**（同一个站点、同一份 webview 分区 ⇒ 同一个登录态，
  // 也**不花 API token**）。画布这层只是把入口搬进图里，让人一眼看出"这一步用哪个免费网站做"。
  // ⚠ webaiKey **必须和本文件上面 WEB_AI 表里的 key 一字不差**（那边认 key 不认名字）——
  //   对不上时双击会在画布上直接说"没找到这个站点"，不会静默失败。
  // ⚠ 它们**没有真实文件路径**：不给文件状态点（第三行写"双击打开"），弹框里也没有第三个字段。
  //
  // ★这 5 个用**官网图标**（2026-09-21 用户要求「网页ai的图标用官网图标」）★：
  //   `img` = 图标文件相对 `renderer\` 的路径（`scripts\fetch-webai-icons.mjs` 从各家官网抓的 favicon，
  //   180×180 PNG，和顶栏那排图标**是同一份文件**，别拷贝、别改 `renderer\assets\webai\` 里的文件）；
  //   `icon` 单字**保留当兜底**：图片挂了（文件被挪走/路径写错）时 onerror 退回单字，不会留一个破图标位。
  //   其它类型继续用 emoji 单字：文案 ✎ / 视频 🎬 / 图片 🖼 / 音频 🎙 / 控制台 🖥 / 工作台 ⚙ / 剪映 ✂ / OBS ⏺ /
  //   固定流程预设 📋；**HTML 单独说一句**：本批把它的图标从 🧩 换成 `</>`（见那条里的注释）。
  {
    id: 'webai-doubao', name: '豆包', icon: '豆', img: 'assets/webai/doubao.png', color: '#3b82f6', cat: 'tool',
    kind: 'webai', sides: 'tb', webaiKey: 'doubao',
    newName: '豆包',
    texts: [{ key: 'duty', label: '默认干什么', rows: 2, value: '按站点强项：生图 / 生视频 / 写文案', hint: '这一步拿它干什么（会写进导出的 Markdown）' }],
    subKeys: ['duty'],
    note: '双击打开顶栏那个同款免费网页版窗口（同一个登录态、不花 API token）：豆包擅长生图/生视频/写文案。'
      + '这个节点连到内容节点上，就是在告诉 AI 会话：这一步用豆包做。',
    tip: '免费网页版豆包（顶栏同款窗口，同一个登录态、不花 API token）：双击打开'
  },
  {
    id: 'webai-deepseek', name: 'DeepSeek', icon: '鲸', img: 'assets/webai/deepseek.png', color: '#4d6bfe', cat: 'tool',
    kind: 'webai', sides: 'tb', webaiKey: 'deepseek',
    newName: 'DeepSeek',
    texts: [{ key: 'duty', label: '默认干什么', rows: 2, value: '按站点强项：写代码 / 推理', hint: '这一步拿它干什么（会写进导出的 Markdown）' }],
    subKeys: ['duty'],
    note: '双击打开顶栏那个同款免费网页版窗口（同一个登录态、不花 API token）：写代码/推理用它。'
      + '⚠ 这一站是"点开才加载"（不预热）⇒ **第一次点开会现加载几秒，这是正常的**。',
    tip: '免费网页版 DeepSeek（顶栏同款窗口，同一个登录态、不花 API token）：双击打开；第一次是现加载，慢几秒正常'
  },
  {
    id: 'webai-tongyi', name: '通义千问', icon: '通', img: 'assets/webai/tongyi.png', color: '#7c5cff', cat: 'tool',
    kind: 'webai', sides: 'tb', webaiKey: 'tongyi',
    newName: '通义千问',
    texts: [{ key: 'duty', label: '默认干什么', rows: 2, value: '按站点强项：写代码 / 长文', hint: '这一步拿它干什么（会写进导出的 Markdown）' }],
    subKeys: ['duty'],
    note: '双击打开顶栏那个同款免费网页版窗口（同一个登录态、不花 API token）：长文/代码都能顶。'
      + '这个节点连到内容节点上，就是在告诉 AI 会话：这一步用通义做。',
    tip: '免费网页版通义千问（顶栏同款窗口，同一个登录态、不花 API token）：双击打开'
  },
  {
    id: 'webai-chatglm', name: '智谱清言', icon: '智', img: 'assets/webai/chatglm.png', color: '#2f6fed', cat: 'tool',
    kind: 'webai', sides: 'tb', webaiKey: 'chatglm',
    newName: '智谱清言',
    texts: [{ key: 'duty', label: '默认干什么', rows: 2, value: '按站点强项：代码 / 文档分析', hint: '这一步拿它干什么（会写进导出的 Markdown）' }],
    subKeys: ['duty'],
    note: '双击打开顶栏那个同款免费网页版窗口（同一个登录态、不花 API token）：代码/文档分析用它。'
      + '这个节点连到内容节点上，就是在告诉 AI 会话：这一步用智谱做。',
    tip: '免费网页版智谱清言（顶栏同款窗口，同一个登录态、不花 API token）：双击打开'
  },
  {
    id: 'webai-kimi', name: 'Kimi', icon: 'K', img: 'assets/webai/kimi.png', color: '#c3cad8', cat: 'tool',
    kind: 'webai', sides: 'tb', webaiKey: 'kimi',
    newName: 'Kimi',
    texts: [{ key: 'duty', label: '默认干什么', rows: 2, value: '按站点强项：长文 / 资料整理', hint: '这一步拿它干什么（会写进导出的 Markdown）' }],
    subKeys: ['duty'],
    // Kimi 的品牌色是黑，深色底上看不见 ⇒ 这条用浅石板灰（用户允许"自己挑一个深色底上能看清的"）
    note: '双击打开顶栏那个同款免费网页版窗口（同一个登录态、不花 API token）：长文/资料整理用它。'
      + '这个节点连到内容节点上，就是在告诉 AI 会话：这一步用 Kimi 做。',
    tip: '免费网页版 Kimi（顶栏同款窗口，同一个登录态、不花 API token）：双击打开'
  },
  // ★2026-09-26★ 「项目文件夹」（用户点名：加一个文件夹节点叫项目文件夹、双击打开所在文件夹；
  //   "一般情况下跑一整个工作流都在一个文件夹，方便任务查看以及继续"）。归类 = 位置节点（FLOW_CATS 的 place）。
  //   端口开在**上下**：它不参加主线时序（别跟 seq 混在一起），往下连到产物节点 = "这些东西都在这个文件夹里"。
  {
    id: 'folder', name: '项目文件夹', icon: '📁', color: '#e0b341', cat: 'place',
    kind: 'dir', sides: 'tb',
    newName: '项目文件夹',
    pathLabel: '文件夹路径', pathHint: '<资料库>',
    descRows: 3,
    descHint: '这个文件夹是干什么的？例：本项目全部产物都放这儿（口播稿 / 现象段 / 原理段 / 成片）',
    subKeys: ['desc'],
    note: '**双击 = 在预览面板里摊开这个文件夹**（图片/视频直接带缩略图，双击其中一个就在面板里看/播；'
      + '面板顶部还有「📂 用资源管理器打开」）。一条工作流从素材到成片都放同一个文件夹 ⇒ 下次接着干、查进度都只认这一个地方。'
      + '★**填了它就够了**：所有产物节点的「存到文件夹」会**自动跟随**这个文件夹（`flowSyncProjDir`，渲染时自动写入并存盘）；某个节点想放别处就单独改它的路径，改过的不再跟随。'
      + '口开在上下（不参加主线时序）：往下连到各个产物节点，表示"这些东西都在这个文件夹里"。',
    tip: '一个项目文件夹：双击在预览面板里摊开（里面的图片/视频可直接看/播）；一条工作流的全部产物都放里面'
  }
];
function flowType(id) {
  for (var i = 0; i < FLOW_TYPES.length; i++) if (FLOW_TYPES[i].id === id) return FLOW_TYPES[i];
  return FLOW_TYPES[0];
}
// 这个类开在哪儿几个面（顺序固定 l→r→t→b，画 DOM 和热点高亮都按这个顺序）
function flowSides(t) {
  var s = String((t && t.sides) || 'lr'), out = [];
  if (s.indexOf('l') >= 0) out.push('l');
  if (s.indexOf('r') >= 0) out.push('r');
  if (s.indexOf('t') >= 0) out.push('t');
  if (s.indexOf('b') >= 0) out.push('b');
  return out.length ? out : ['l', 'r'];
}
function flowClampN(v, a, b) { return v < a ? a : (v > b ? b : v); }
// 路径有没有写全（必须带盘符或 UNC，否则写了也打不开）
function flowPathOk(p) {
  var s = String(p || '').trim();
  return /^[A-Za-z]:[\\/]/.test(s) || /^\\\\/.test(s);
}
// 本机地址有没有写全（工具节点 kind==='url' 用；只有 http/https）
function flowUrlOk(p) {
  return /^https?:\/\/\S+$/i.test(String(p || '').trim());
}
// 从地址里抠出 host:port（探测状态要连的这个口）—— 抠不出来返回 null
function flowUrlPort(p) {
  var m = /^https?:\/\/([^\/:]+)(?::(\d+))?/i.exec(String(p || '').trim());
  if (!m) return null;
  return { host: m[1], port: Number(m[2] || (String(p).toLowerCase().indexOf('https:') === 0 ? 443 : 80)) };
}
// ---- 接线口几何（2026-09-20 加：工具节点的口不再只有左右两个面）----
// 为什么单独抽成一层：以前"出线"永远在右边、"入线"永远在左边，画线的锚点是写死的
// (a.x + w, a.y + h/2) → (b.x, b.y + h/2)。控制台要在上下、工作台四面都要，写死就不够了。
// 现在：边记两端各自的方位（fs/ts），锚点按方位取；没记方位的老图按相对位置猜，画出来照样对。
var FLOW_DIRS = { l: { dx: -1, dy: 0 }, r: { dx: 1, dy: 0 }, t: { dx: 0, dy: -1 }, b: { dx: 0, dy: 1 } };
function flowAnchor(n, s, side) {
  var d = FLOW_DIRS[side] || FLOW_DIRS.r;
  var x = d.dx < 0 ? n.x : (d.dx > 0 ? n.x + s.w : n.x + s.w / 2);
  var y = d.dy < 0 ? n.y : (d.dy > 0 ? n.y + s.h : n.y + s.h / 2);
  return { x: x, y: y, dx: d.dx, dy: d.dy };
}
// 自动判方位时，**只从"目标类型真有的那几个口"里挑**：挑最正对来源节点的那一面。
// 为什么要这一层：工具/方式类现在只有上下两个口，要是照老算法把线落到它的左口，
//   箭头会贴在一面根本没有接线口的边上（看着像坏了）。老图存在边上的 fs/ts 照旧不做改动。
function flowFacingSide(b, sb, ax, ay, allow) {
  var cx = b.x + sb.w / 2, cy = b.y + sb.h / 2;
  var vx = ax - cx, vy = ay - cy;
  var len = Math.sqrt(vx * vx + vy * vy) || 1;
  var best = allow[0], bestScore = -Infinity;
  allow.forEach(function (s) {
    var d = FLOW_DIRS[s];
    var sc = (vx * d.dx + vy * d.dy) / len;
    if (sc > bestScore) { bestScore = sc; best = s; }
  });
  return best;
}
function flowEdgeSides(a, sa, b, sb, tb) {
  var ax = a.x + sa.w / 2, ay = a.y + sa.h / 2, bx = b.x + sb.w / 2, by = b.y + sb.h / 2;
  var auto = (Math.abs(bx - ax) >= Math.abs(by - ay))
    ? (bx >= ax ? { fs: 'r', ts: 'l' } : { fs: 'l', ts: 'r' })
    : (by >= ay ? { fs: 'b', ts: 't' } : { fs: 't', ts: 'b' });
  if (tb) {
    var allow = flowSides(tb);
    if (allow.indexOf(auto.ts) < 0) auto.ts = flowFacingSide(b, sb, ax, ay, allow);
  }
  return auto;
}
function flowWireD(p1, p2) {
  var span = p1.dx ? Math.abs(p2.x - p1.x) : Math.abs(p2.y - p1.y);
  var k = Math.max(26, span * 0.45);
  return 'M ' + p1.x + ' ' + p1.y + ' C ' + (p1.x + p1.dx * k) + ' ' + (p1.y + p1.dy * k)
    + ', ' + (p2.x + p2.dx * k) + ' ' + (p2.y + p2.dy * k) + ', ' + p2.x + ' ' + p2.y;
}
function flowScreen(p, v) { return { x: p.x * v.k + v.x, y: p.y * v.k + v.y, dx: p.dx, dy: p.dy }; }
// 文件名 / 目录 拆开（节点第三行只显示文件名，完整路径进 tooltip）
function flowPathParts(p) {
  var s = String(p || '').trim();
  var i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return { file: i >= 0 ? s.slice(i + 1) : s, dir: i >= 0 ? s.slice(0, i) : '' };
}
// 卡片副行只印前 16 个字（再长就把卡片撑成一行字，完整内容在 tooltip / ⧉ Markdown 里）
// ⚠ 2026-09-27 起卡片上不再有"截 16 字"的副行（见 flowHintOf），这个函数留给别处复用（导出/旧调用）。
function flowClip16(s) {
  var v = String(s == null ? '' : s);
  return v.length > 16 ? v.slice(0, 16) + '…' : v;
}
// ★2026-09-27 用户定（画布卡片改版 · 本批最重要的一处）★
// 卡片上那**唯一一行提示** = 这个节点「要求文字」的**第一句**，截到 ~40 字。
//   用户原话：「内容卡片只显示标题以及对应的图片视频或者音频以及提示，文案内容卡片只显示标题以及提示」——
//   以前那张卡是四行小字（描述 2 行 + 方式 + 前 16 字 + 段落秒数），字挤在一起就是用户说的"文字糊成一团"。
//   三件事都在这一处做完（别散到调用方，否则"提示行"的样子会各处不一样）：
//     ① 先按**换行**取第一段（要求文字常写成"第一行是要点、后面是细则"）⇒ 提示更像"一句话要点"；
//     ② 压成一行 + 去掉 markdown 记号（`**` / 反引号 / *斜体*）—— 卡片上不该看见星号；
//     ③ 按中文句读（。！？；）断第一句，仍超 40 字再截断加省略号。
function flowHintOf(s) {
  var lines = String(s == null ? '' : s).split('\n');
  var head = '';
  for (var i = 0; i < lines.length; i++) { if (flowOneLine(lines[i])) { head = lines[i]; break; } }
  if (!head) return '';
  var t = flowOneLine(head).replace(/\*\*/g, '').replace(/`/g, '').replace(/\*([^*]+)\*/g, '$1');
  var m = /^[^。！？!?；;]{1,60}/.exec(t);
  var first = (m ? m[0] : t).trim();
  if (first.length > 40) first = first.slice(0, 40) + '…';
  return first;
}
// 「要求文字」= 这个节点上"要什么 / 怎么做"的那一段（卡片提示行读它；没有它时那一行整行不显示）。
//   为什么按一张**优先级表**取而不是各类型写死：同一个节点上常常填了好几处（video = 情节 + 描述 + 字幕，
//   html = 要做什么 + 指令模板，preset = 步骤 + 指令）—— 卡片只印一处，就必须有唯一的裁决处，否则
//   "填了却看不见 / 两处打架"这类事会反复出现（这就是上一版 .flow-node-plot 只认第一个文本字段的毛病）。
//   顺序 = 越"这一段要什么"越靠前：情节 → 描述 → 要做什么 → 指令模板 → 默认干什么 → 来源/备注 → 步骤。
function flowReqText(n, t) {
  var order = ['plot', 'desc', 'purpose', 'prompt', 'duty', 'source', 'note', 'steps'];
  for (var i = 0; i < order.length; i++) {
    var v = n ? n[order[i]] : null;
    if (v == null) continue;
    if (Object.prototype.toString.call(v) === '[object Array]') v = (v || [])[0];   // steps 是数组（一行一步）
    var s = String(v).trim();
    if (s) return s;
  }
  return '';
}
// 内容节点的"给 AI 看的语义"（video 的 情节 + 用什么方式生成 / html 的 用途）拆成短句，
// 卡片副行和「⧉ Markdown」导出**共用这一份**（免得两处说法不一致）。
// 返回 [{ kind:'pick'|'text', key, label, text, raw }]，**空字段直接不出现** ⇒ 老图（没这些字段）一行都不会多。
// `key` = 节点上的字段名（导出时按它分节：情节/指令模板进「## 指令」，其余跟着节点走）—— 别省这一项。
function flowAiLines(n, t) {
  var out = [];
  if (t && t.pick) {
    // ⚠ 现在**没有任何类型**声明 pick 了（video 的「用什么方式生成」2026-09-26 已改成认连线，见该类型上的注释）。
    //   这一支是**通用能力**留着：以后哪个类型要"选项现算的下拉"（from:'tool'）直接写 pick 就行。
    var pv = String(n[t.pick.key] || '').trim();
    // 「未定」= 没选，等于空（下拉的默认项），不当成内容印出来
    if (pv && pv !== '未定') out.push({ kind: 'pick', key: t.pick.key, label: t.pick.label, text: '→ 用 ' + pv, raw: pv });
  }
  var texts = (t && t.texts) || [];
  texts.forEach(function (f) {
    var v = String(n[f.key] || '').replace(/\s+/g, ' ').trim();
    if (v) out.push({ kind: 'text', key: f.key, label: f.label, text: v, raw: v });
  });
  return out;
}
// 建节点时把类型表里声明的"预设值"抄到节点上（现在只有工具类的 `duty` 用得上）。
// 为什么放这儿而不是在 addNode 里写 if：以后加类型只要在类型行里写 `value: '…'`，建出来就带上了。
function flowTypeDefaults(t) {
  var out = {};
  ((t && t.texts) || []).forEach(function (f) { if (f.value != null) out[f.key] = f.value; });
  ((t && t.selects) || []).forEach(function (f) { if (f.value != null) out[f.key] = f.value; });
  return out;
}
// 卡片副行里"现算的复合值"（不是节点上的单个字段，得拼一下才能读）。
// 加类型时在类型行的 `subKeys` 里点名叫它们就行，不用改卡片代码。
var FLOW_SUB_FMT = {
  // 起止秒：两个数字都允许空（用户要求"允许只填一个"）—— 只填一个时写成"5s 起 / 到 15s"，别显示成 5-undefined
  secs: function (n) {
    var a = String(n.t0 == null ? '' : n.t0).trim(), b = String(n.t1 == null ? '' : n.t1).trim();
    if (!a && !b) return '';
    if (a && b) return a + '-' + b + 's';
    return a ? a + 's 起' : '到 ' + b + 's';
  },
  // 预设的步骤数（卡片上让人一眼看出这套做法有几步）
  stepCount: function (n) {
    var k = flowPresetSteps(n.steps).length;
    return k ? k + ' 步' : '';
  },
  // 素材性质（2026-09-23 第七轮 + 修正 + 第十一轮）：待生成 ⇒ "待生成 → 文件名"（没填文件名就用存到文件夹的末段）；
  // 已有素材 ⇒ "已有素材"；老图没有 mode ⇒ 空串 ⇒ 卡片副行零变化。
  genDir: function (n) {
    var m = String(n.mode || '').trim();
    if (m === FLOW_MODE_GEN) {
      var f = String(n.fname || '').trim();
      var seg = flowDirSeg(flowDirOf(n));
      var ext = flowFmtExt(n, flowType(n.type));
      var show = f ? (f + (ext ? '.' + ext : '')) : seg;
      return '待生成' + (show ? ' → ' + show : '');
    }
    if (m === FLOW_MODE_REF) return '已有素材';
    return '';
  }
};
// 卡片副行（第二/三行的"关键字段一句话"）：按类型表声明的 subKeys 顺序拼，空字段自动不出现。
function flowSubLine(n, t) {
  var keys = (t && t.subKeys) || [], out = [];
  keys.forEach(function (k) {
    var f = FLOW_SUB_FMT[k];
    var v = f ? f(n) : String(n[k] == null ? '' : n[k]).replace(/\s+/g, ' ').trim();
    if (v) out.push(v);
  });
  return out.join(' · ');
}
// 「⧉ Markdown」专用的字段清单 = 卡片那份 + 下拉/数字栏（卡片上放不下，但会话需要）。
// 跳过 `ui:true` 的纯界面栏（例：预设的"预览形式"是给人挑的，跟做法本身无关）。
function flowFieldLines(n, t) {
  var out = flowAiLines(n, t);
  ((t && t.selects) || []).forEach(function (f) {
    if (f.ui) return;
    var v = String(n[f.key] == null ? '' : n[f.key]).trim();
    if (v) out.push({ kind: 'sel', key: f.key, label: f.label, text: v, raw: v });
  });
  // 生成路径（dirs，2026-09-23 第七轮）：只打印"填了"的那一行（空着不进 Markdown）
  ((t && t.dirs) || []).forEach(function (f) {
    var v = String(n[f.key] == null ? '' : n[f.key]).trim();
    if (v) out.push({ kind: 'dir', key: f.key, label: f.label, text: v, raw: v });
  });
  ((t && t.nums) || []).forEach(function (f) {
    var v = String(n[f.key] == null ? '' : n[f.key]).trim();
    if (v) out.push({ kind: 'num', key: f.key, label: f.label, text: v, raw: v });
  });
  return out;
}
// 本地文件 → file:// 地址（卡片缩略图 / 首帧要用）。
// 为什么只认盘符开头的绝对路径：相对路径在这儿没有"当前目录"可言，拼出来必然是错的（不如不显示）。
function flowFileUrl(p) {
  var s = String(p || '').trim().replace(/\\/g, '/');
  if (!/^[A-Za-z]:\//.test(s)) return '';
  return 'file:///' + encodeURI(s).replace(/#/g, '%23').replace(/\?/g, '%3F');
}
// 文件夹路径的末段名（"<视频工作流>" → "成片"；空/不合法 → ''）—— 卡片副行/状态点显示"存到哪"用
function flowDirSeg(p) {
  var s = String(p || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!s) return '';
  return s.split('/').pop() || '';
}
// 图上最多给几个**视频**节点抽首帧（超过就退回图标）。为什么要有这道闸门：
// 视频首帧 = 真要解码（不是读个文件头），一张卡一个 <video preload="metadata">，图上十几个就够让这台 16 GB 的机器发涩；
// 图片是静态解码、便宜，所以**不设限**。觉得卡就往下调这个数（调到 0 = 视频一律只显示图标）。
var FLOW_VIDEO_THUMB_MAX = 8;
function flowCountType(g, typeId) {
  var k = 0;
  (g.nodes || []).forEach(function (n) { if (n.type === typeId) k++; });
  return k;
}
// 预设的步骤清单：一行一步 —— 顺手把行首的 "1." / "1、" / "-" 这些序号剥掉（导出时我们自己编号，
// 剥掉才不会出现"1. 1. 写 HTML"这种双序号）。
function flowPresetSteps(s) {
  return String(s == null ? '' : s).split('\n')
    .map(function (x) { return x.replace(/^\s*(?:\d+\s*[.、)）]|[-*·])\s*/, '').trim(); })
    .filter(function (x) { return !!x; });
}
// 「成片时间线」的编号：沿**主线（seq）**把内容节点串起来，从"没有入边的头"往下走，按走的顺序 ① ② ③…
// 卡片右上角的角标和导出的 Markdown **共用这一份顺序** ⇒ 两处永远不会打架（这是用户要的"顺序不靠眼睛数位置"）。
// 环（有人连成圈）时也要能出结果：头找不到就从第一个有连线的节点起步，走不动就停。
function flowSeqOrder(g) {
  var byId = {}, out = {}, inn = {};
  (g.nodes || []).forEach(function (n) { byId[n.id] = n; });
  (g.edges || []).forEach(function (e) {
    var a = byId[e.from], b = byId[e.to];
    if (!a || !b || e.from === e.to) return;
    if (flowWireKind(e, a, b) !== 'seq') return;
    (out[e.from] = out[e.from] || []).push(e.to);
    (inn[e.to] = inn[e.to] || []).push(e.from);
  });
  var heads = (g.nodes || []).map(function (n) { return n.id; }).filter(function (id) { return out[id] && !inn[id]; });
  if (!heads.length) heads = (g.nodes || []).map(function (n) { return n.id; }).filter(function (id) { return out[id] || inn[id]; });
  var order = [], seen = {};
  heads.forEach(function (h) {
    var cur = h;
    while (cur && !seen[cur]) {
      seen[cur] = 1; order.push(cur);
      var nx = (out[cur] || []).filter(function (id) { return !seen[id]; });
      cur = nx.length ? nx[0] : null;
    }
  });
  // 图上**一条主线都没有**时（刚建的空图、或者用户只连了方式/依据线）：退回"按位置把内容节点从左到右排一遍"。
  //   为什么不干脆空着：角标和导出的「## 成片时间线」是同一份顺序，一起空掉的话用户看到的是"没反应"；
  //   退回按位置排之后，一旦连上第一条主线，两处会同时切成"按连线"的顺序（不需要任何额外操作）。
  if (!order.length) {
    (g.nodes || []).slice()
      .filter(function (n) { return flowCatOf(flowType(n.type)).id === 'content'; })
      .sort(function (a, b) { return (a.x - b.x) || (a.y - b.y); })
      .forEach(function (n) { order.push(n.id); });
  }
  return order;
}
var FLOW_NUMS = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
function flowNum(i) { return FLOW_NUMS.charAt(i) || ('(' + (i + 1) + ')'); }
// 某个内容节点是"谁做出来的"：把落在它身上的**方式线**来源，再往上（依据线/方式线都算）追一层，
// 全按 x 从左到右排 —— 就是用户要的"方式链 A: ① … → ② … → ③ …"。返回节点数组（不含它自己）。
function flowHowChain(g, nodeId) {
  var byId = {}, seen = {}, chain = [];
  (g.nodes || []).forEach(function (n) { byId[n.id] = n; });
  var push = function (a) {
    if (!a || seen[a.id] || a.id === nodeId) return;
    seen[a.id] = 1; chain.push(a);
    (g.edges || []).forEach(function (e) {
      if (e.to !== a.id) return;
      var p = byId[e.from];
      if (p && !seen[p.id] && p.id !== nodeId) push(p);
    });
  };
  (g.edges || []).forEach(function (e) {
    if (e.to !== nodeId) return;
    var a = byId[e.from], b = byId[e.to];
    if (a && b && flowWireKind(e, a, b) === 'how') push(a);
  });
  chain.sort(function (a, b) { return (a.x - b.x) || (a.y - b.y); });
  return chain;
}
// 默认图 = 空画布上先摆一个「文案」节点（用户："先添加第一个节点 1.文案"）
function flowSeedGraph() {
  return {
    v: 2,
    nodes: [{ id: 'n1', type: 'text', name: '文案', desc: '', path: '', x: 24, y: 24 }],
    edges: []
  };
}
function flowLoadGraph(key) {
  try {
    var raw = localStorage.getItem(key);
    if (!raw) return null;
    var o = JSON.parse(raw);
    if (!o || o.v !== 2 || !Array.isArray(o.nodes)) return null;   // v1 的老示例图不再兼容：忽略，重新起一张
    o.nodes.forEach(function (n) {
      if (!n.type) n.type = 'text';
      if (n.name == null) n.name = flowType(n.type).newName;
      if (n.desc == null) n.desc = '';
      if (n.path == null) n.path = '';
    });
    if (!Array.isArray(o.edges)) o.edges = [];
    return o;
  } catch (e) { return null; }
}
// ---- 画布快照：把整张图落一份到磁盘（2026-09-23 第十二轮 · vw-ai 会话加）----
// 为什么：画布原先只有「⧉ Markdown 复制 → 人粘给 AI」这一条读法（见画布项目信息 §一），每读一次都要人动手；
//   右下「AI·视频工作流」的常驻会话想"按画布上的流程干活"，就得能自己读到图。
// 怎么配：场景 json 的面板里写 `"snapshotDir": "<盘根>:\\…\\画布快照"` ⇒ 该面板每次保存都写一份 JSON 快照；
//   **没配 = 一个字都不写**（别的场景 / 别的 flow 面板行为完全不变）。
// 写盘走宿主 IPC `app.file.write`（只认 D/E 盘、自动建目录、临时文件+改名原子落盘）；失败静默，绝不影响画布本身。
function flowSnapFile(key, dir, ext) {
  return String(dir).replace(/[\\/]+$/, '') + '\\' + String(key).replace(/[^A-Za-z0-9._-]/g, '_') + '.' + ext;
}
function flowSnapWrite(key, dir, ext, text) {
  try {
    const w = (typeof window !== 'undefined' && window.app && window.app.file && window.app.file.write) ? window.app.file.write : null;
    if (!dir || !w) return false;
    const p = w(flowSnapFile(key, dir, ext), String(text == null ? '' : text));
    if (p && typeof p.catch === 'function') p.catch(function () { /* 写不了就算了：画布不靠它 */ });
    return true;
  } catch (e) { return false; }
}
function flowSaveGraph(key, g, snapDir) {
  let ok = true;
  try { localStorage.setItem(key, JSON.stringify(g)); } catch (e) { ok = false; }
  // 快照 = 图原样在顶层（这份文件本身就是一张合法 v2 图，将来要导回去也认）+ 两个记账字段
  try {
    if (snapDir) {
      const snap = Object.assign({}, g, { savedAt: new Date().toISOString(), snapKey: key });
      flowSnapWrite(key, snapDir, 'json', JSON.stringify(snap, null, 2));
    }
  } catch (e) { /* ignore */ }
  return ok;
}
// ★2026-09-26★ 会话填画布（AI 反向填）：把「import 文件」装进 localStorage。
//   文件 = `<快照目录>\app.flow.<面板id>.import.json`，本身就是一张合法 v2 图（多带 savedAt 当版本号）。
//   force=true 忽略版本号强装（给手动按钮用）。返回 Promise<{ok, nodes, why}>；
//   画布 DOM 在挂载时就建好了 ⇒ 装完**只能重载界面**才算数，所以调用方拿到 ok 后自己调 flowRedrawUI()。
function flowImportLoad(key, snapDir, force) {
  return new Promise(function (resolve) {
    try {
      const w = window.app && window.app.file;
      if (!snapDir || !w || !w.read) { resolve({ ok: false, why: '没配快照目录（或没有读文件的能力）' }); return; }
      const stampKey = key + '.importedAt';
      w.read(flowSnapFile(key, snapDir, 'import.json')).then(function (res) {
        try {
          if (!res || !res.ok || !res.text) { resolve({ ok: false, why: '还没有 import 文件' }); return; }
          const o = JSON.parse(res.text);
          if (!o || o.v !== 2 || !Array.isArray(o.nodes)) { resolve({ ok: false, why: 'import 文件不是合法 v2 图' }); return; }
          const stamp = String(o.savedAt || '');
          if (!stamp) { resolve({ ok: false, why: 'import 文件缺 savedAt（没法判断新旧）' }); return; }
          if (!force && localStorage.getItem(stampKey) === stamp) { resolve({ ok: false, why: '这份图已经装过了' }); return; }
          localStorage.setItem(key, JSON.stringify(o));
          localStorage.setItem(stampKey, stamp);
          resolve({ ok: true, nodes: o.nodes.length });
        } catch (e) { resolve({ ok: false, why: '装不进去：' + String((e && e.message) || e) }); }
      }).catch(function () { resolve({ ok: false, why: '还没有 import 文件' }); });
    } catch (e) { resolve({ ok: false, why: String((e && e.message) || e) }); }
  });
}
// 重绘 = 走壳里的「⟳ 刷新当前场景」（热重载渲染层 + 重挂当前场景，**不重载页面**、不动 Harness 对话）。
//   ⛔ 不许用 location.reload()：整页重载会连所有 webview 面板、其它场景的临时状态一起刷掉，
//   而且 check-injected.mjs 有硬判据「location.reload() 必须恰好 1 处」（只留给那条带三道防护的直达通道）。
function flowRedrawUI() { try { const b = document.getElementById('btn-refresh'); if (b) b.click(); } catch (e) { /* ignore */ } }
// 看门狗：每 5 秒看一次 import 文件 —— **会话一有动作（写了新图），画布就自己刷**，不用人去点。
//   ⚠ 定时器必须建在**渲染器函数体内**：check-gui 第 4 项按"renderers.X 的行区间"数 setInterval(
//   （顶层函数会被算进上一个渲染器 reserved 的区间 ⇒ 误报"没返回 cleanup"），而 flow 末尾本来就有
//   `return () => {…}` 那个清理函数，在那儿把它 clearInterval 掉就合规。见本文件 flow 内的同名局部实现。
// 面板之间互相喊话：预览面板（renderers.view）把自己的小 API 注册到 window.__kunViews[面板id]，
// 别的面板（流程画布双击节点）靠它把"要看的文件"递过去。所有面板都在**同一个文档**里，
// 所以同文档直接调函数就够了 —— 这一层不需要任何新 IPC（跨进程的 AI 面板才需要走文件）。
function flowFindView(preferId) {
  var m = (typeof window !== 'undefined' && window.__kunViews) || {};
  if (preferId && m[preferId]) return m[preferId];
  var ks = Object.keys(m);
  return ks.length ? m[ks[0]] : null;
}
// 复制到剪贴板：navigator.clipboard 在 file:// 下不一定给权限（还要求文档聚焦），
// 所以用跟 srCopy 一样的 textarea + execCommand 老办法（这个在 Electron 渲染层一直好使）
function flowCopyText(text) {
  try {
    var ta = document.createElement('textarea');
    ta.value = String(text == null ? '' : text);
    ta.style.position = 'fixed'; ta.style.left = '-9999px'; ta.style.top = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    var ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) { return false; }
}

// ============ 多画布（一个 flow 面板里放几张图，像浏览器标签栏）============
// ★AI 读取兼容契约（2026-09-27 定：会话侧按固定路径读画布，这几条一个字都不许变）★
//   第 1 张「默认画布」key = `app.flow.<面板id>` ⇒ 快照仍是 `app.flow.<面板id>.json` / `.import.json`
//     / `.running.json` / `.md`（`_看画布.mjs`、技能 `video-workflow-canvas`、`_工具\_标记运行.mjs` 等全按这个路径写死）
//   第 2/3 张 key = `app.flow.<面板id>.2` / `.3`（`flowSnapFile` 就是拼 key ⇒ 文件名自动成 `….2.json` 等）
//   清单文件 = `<快照目录>\app.flow.<面板id>.canvases.json`：
//     {"v":1,"active":1,"limit":3,"list":[{"n":1,"key":"app.flow.<面板id>","title":"默认画布"},…]}
//     **每次新建 / 切换 / 改名 / 删除都重写它**（这是会话侧"现在有几张画布、看的是第几张"的唯一入口）
//   ⚠ 本文件是**热更新**的（点 ⟳ 会在同一个全局上下文里把整份脚本重新求值一次）⇒ 模块级声明一律 var/function；
//     用 const/let 会 "Identifier has already been declared"（整份脚本直接不执行、面板全白）。函数体内的 const/let 不受影响。
var FLOW_CANVAS_LIMIT = 3;                       // 上限 3 张（用户 2026-09-27 点名）
function flowCanvasKeyOf(baseKey, n) { return (Number(n) || 1) <= 1 ? baseKey : baseKey + '.' + Number(n); }
function flowCanvasTitleOf(n) { return (Number(n) || 1) <= 1 ? '默认画布' : '画布 ' + Number(n); }
// 清单规整：编号只认 1..上限 内不重复的整数、key **一律由 baseKey 现推**（不认清单里写的 key，防手改串台）、
//   active 必须落在 list 里。坏数据就地修好再用 —— 会话侧只读不写，所以这里必须防"人把清单改坏"。
function flowCanvasNorm(baseKey, raw) {
  var out = { v: 1, active: 1, limit: FLOW_CANVAS_LIMIT, list: [] };
  var byN = {};
  try {
    if (raw && typeof raw === 'object' && Array.isArray(raw.list)) {
      raw.list.forEach(function (it) {
        var n = Math.floor(Number(it && it.n));
        if (!(n >= 1 && n <= FLOW_CANVAS_LIMIT) || byN[n]) return;
        var t = String((it && it.title) || '').trim();
        byN[n] = { n: n, key: flowCanvasKeyOf(baseKey, n), title: t ? t.slice(0, 20) : flowCanvasTitleOf(n) };
      });
    }
  } catch (e) { /* 坏清单 = 从头来 */ }
  if (!byN[1]) byN[1] = { n: 1, key: baseKey, title: flowCanvasTitleOf(1) };
  Object.keys(byN).map(Number).sort(function (a, b) { return a - b; }).forEach(function (n) { out.list.push(byN[n]); });
  var act = Math.floor(Number(raw && raw.active));
  out.active = out.list.some(function (x) { return x.n === act; }) ? act : 1;
  return out;
}
function flowCanvasLoad(baseKey) {
  var raw = null;
  try { raw = JSON.parse(localStorage.getItem(baseKey + '.canvases') || 'null'); } catch (e) { raw = null; }
  return flowCanvasNorm(baseKey, raw);
}

renderers.flow = (body, meta, head) => {
  const SVGNS = 'http://www.w3.org/2000/svg';
  const pid = String(meta.id || 'flow');
  // ★多画布（2026-09-27）★ baseKey = 第 1 张「默认画布」的 key（**契约：一个字符都不许变**，见本文件里那段说明）；
  //   storeKey = **当前显示的那张**（切标签就换它）—— 下面所有落盘/读盘/快照/看门狗/运行灯轮询一律按它走。
  const baseKey = 'app.flow.' + pid;
  const canvasesKey = baseKey + '.canvases';        // 清单在本机 localStorage 里那份（磁盘那份在快照目录：<baseKey>.canvases.json）
  const canvases = flowCanvasLoad(baseKey);         // 同步读清单（坏数据自动修好）；active 决定一进来显示哪张
  let storeKey = flowCanvasKeyOf(baseKey, canvases.active);
  const snapDir = String(meta.snapshotDir || '');   // 画布快照目录（场景 json 里配；没配就只走 localStorage，不落盘）
  body.classList.add('flow-panel');
  // 面板体本来就是 flex（.panel-body.flow-panel），标签栏要**横在最上面** ⇒ 这里改成"列"。
  //   ⚠ 只写在本面板这一个元素的内联样式上：不动外层 .panel-body 规则、不动 styles.css、更不动外壳。
  body.style.flexDirection = 'column';
  // 多画布标签栏：像浏览器标签 —— 当前那张高亮、每张显示标题、右侧「＋」（到上限置灰 + tip「上限 3 个」）、
  //   非默认那张标签上带 ×。位置 = flow 面板自己的 body 里、.flow-bar（浮在画布上那条工具栏）之上。
  //   ⛔ 不碰标题栏/外壳（main.js / renderer.js / index.html 一律没动）⇒ 点 ⟳ 就生效，不用重启 GUI。
  const ensureCanvasCss = () => {
    // 样式**注入在本文件里**（和"跑着灯"的 ensureRunCss 同一套做法）：只改 renderers.js，⟳ 即生效。
    //   版本判据必须有：点 ⟳ 只重新求值本文件、不重建 DOM ⇒ 旧 <style> 还在 head 里，同 id 直接 return 就没法更新。
    const VER = 'v1-tabs';
    const old = document.getElementById('kun-flow-canvas-css');
    if (old && old.getAttribute('data-ver') === VER) return;
    if (old && old.parentNode) old.parentNode.removeChild(old);
    const st = document.createElement('style');
    st.id = 'kun-flow-canvas-css';
    st.setAttribute('data-ver', VER);
    st.textContent = [
      // 标签栏本体：横在最上面一条，底色比画布深一点、下沿一条分隔线（看着就是"浏览器标签栏"）
      '.flow-tabs{flex:0 0 auto;display:flex;align-items:flex-end;gap:3px;padding:5px 8px 0;'
        + 'background:var(--bg-panel);border-bottom:1px solid var(--border);overflow:hidden;}',
      '.flow-tabs-list{display:flex;align-items:flex-end;gap:3px;min-width:0;overflow:hidden;}',
      // 单个标签：默认是"没选中的标签"（暗、贴底），选中的那张亮起来 + 顶部一条类别色高亮
      '.flow-tab{display:flex;align-items:center;gap:5px;max-width:190px;padding:4px 8px 5px;margin-bottom:-1px;'
        + 'border:1px solid var(--border);border-bottom:0;border-radius:7px 7px 0 0;'
        + 'background:var(--bg);color:var(--text-dim);font:11.5px/1.5 var(--sans);cursor:pointer;'
        + 'user-select:none;white-space:nowrap;}',
      '.flow-tab:hover{background:var(--bg-panel-hover);color:var(--text);}',
      '.flow-tab.on{background:var(--bg-panel);color:var(--text);font-weight:600;'
        + 'border-color:var(--accent);box-shadow:inset 0 2px 0 var(--accent);}',
      '.flow-tab-name{overflow:hidden;text-overflow:ellipsis;}',
      '.flow-tab-x{border:0;background:transparent;color:inherit;opacity:.5;font-size:13px;line-height:1;'
        + 'padding:0 2px;border-radius:4px;cursor:pointer;}',
      '.flow-tab-x:hover{opacity:1;background:rgba(255,90,90,.22);color:#ff8c8c;}',
      '.flow-tab-edit{width:108px;font:11.5px var(--sans);background:var(--bg);color:var(--text);'
        + 'border:1px solid var(--accent);border-radius:4px;padding:1px 4px;outline:none;}',
      '.flow-tab-add{border:1px solid var(--border);border-bottom:0;border-radius:7px 7px 0 0;background:var(--bg);'
        + 'color:var(--text-dim);font-size:13px;line-height:1;padding:5px 9px;margin-bottom:-1px;cursor:pointer;}',
      '.flow-tab-add:hover{background:var(--bg-panel-hover);color:var(--text);}',
      '.flow-tab-add:disabled,.flow-tab-add.off{opacity:.38;cursor:not-allowed;filter:grayscale(1);}',
      '.flow-tabs-hint{margin-left:auto;padding:0 0 6px 8px;font-size:10.5px;color:var(--text-dim);opacity:.75;white-space:nowrap;}',
    ].join('\n');
    (document.head || document.body).appendChild(st);
  };
  const tabBar = el('div', 'flow-tabs');
  tabBar.dataset.role = 'flow-canvas-tabs';
  const tabList = el('div', 'flow-tabs-list');
  const tabsInfo = el('span', 'flow-tabs-hint', '');
  const tabAdd = el('button', 'flow-tab-add', '＋');
  tabAdd.type = 'button';
  tabAdd.dataset.role = 'flow-canvas-add';
  tabAdd.addEventListener('click', () => { canvasAdd(); });
  tabBar.appendChild(tabList);
  tabBar.appendChild(tabAdd);
  tabBar.appendChild(tabsInfo);
  body.appendChild(tabBar);   // ⚠ 必须排在 viewport 之前 append：body 已是 flex 列，先来的在上面

  // ★2026-09-26★ AI 反向填画布（会话写图 → 面板自己装载，不用人点"导入"）：
  //   会话往快照目录写 `app.flow.<id>.import.json`（= 一张合法 v2 图，自带 savedAt 当版本号）；
  //   面板挂载时若它比"上次装过的那份"新 ⇒ 写进 localStorage 并重挂一次（图在挂载时就被读出来建 UI 了，
  //   所以装载只能发生在"下一次挂载"）。**绝不会盖掉用户之后的改动**：装完记下那份 savedAt，之后不再动作。
  //   ⚠ 重挂走壳里的「⟳ 刷新当前场景」（= 热重载渲染层 + 重挂当前场景），**不许再用 location.reload()**：
  //   那是整页重载，会把整个工作台连同所有 webview 面板一起刷掉（正在跑的会话、其它场景的临时状态全丢）；
  //   而且 check-injected.mjs 有硬判据「location.reload() 必须**恰好 1 处**（只留给带预算/键比对/时间戳三道
  //   防护的直达通道）」—— 这里多一处就红灯，两处都删同样是红灯。
  //   点 ⟳ 不会自刷成环：stampKey 已记下这份 savedAt，重挂后 flowImportOnce 一开始就 return。
  (function flowImportOnce() {
    try {
      const w = window.app && window.app.file;
      if (!snapDir || !w || !w.read) return;
      const impPath = flowSnapFile(storeKey, snapDir, 'import.json');
      const stampKey = storeKey + '.importedAt';
      w.read(impPath).then(function (res) {
        try {
          if (!res || !res.ok || !res.text) return;
          const o = JSON.parse(res.text);
          if (!o || o.v !== 2 || !Array.isArray(o.nodes)) return;
          const stamp = String(o.savedAt || '');
          if (!stamp || localStorage.getItem(stampKey) === stamp) return;
          localStorage.setItem(storeKey, JSON.stringify(o));
          localStorage.setItem(stampKey, stamp);
          setTimeout(function () {
            try {
              const btn = document.getElementById('btn-refresh');   // 壳里的「⟳ 刷新当前场景」
              if (btn) btn.click();   // 按钮不存在（异常壳）就只留 localStorage 那份，下次挂载自然读到
            } catch (e) { /* ignore */ }
          }, 150);
        } catch (e) { /* 装不了就当没这回事，画布照旧 */ }
      }).catch(function () { /* 文件不存在 = 常态，静默 */ });
    } catch (e) { /* ignore */ }
  })();
  // 挂载时先自动装一次（有新版才装），再挂上 5 秒一次的看门狗 —— 会话写完图，画布自己就刷新。
  flowImportLoad(storeKey, snapDir, false).then(function (r) { if (r && r.ok) setTimeout(flowRedrawUI, 150); });
  // 看门狗：每 5 秒看一次 import 文件 —— 会话一写新图，画布就自己刷（用户 2026-09-26 点名"有动作就主动刷画布"）。
  //   ⚠ 定时器就建在这里（**渲染器函数体内**）；末尾那个 `return () => {…}` 里 clearInterval 掉 ⇒ check-gui 第 4 项合规。
  //   ★多画布★ 定时器**按 key 建**：切标签时先 watchDetach(旧 key) 再 watchAttach(新 key)
  //   ⇒ 绝不留"指向旧画布"的定时器在后台对着旧 key 轮询（那是多画布最容易出的坑）。
  function watchAttach(key) {
    try {
      window.__kunFlowWatch = window.__kunFlowWatch || {};
      if (!window.__kunFlowWatch[key]) {
        window.__kunFlowWatch[key] = setInterval(function () {
          flowImportLoad(key, snapDir, false).then(function (r) { if (r && r.ok) flowRedrawUI(); });
        }, 5000);
      }
    } catch (e) { /* ignore */ }
  }
  function watchDetach(key) {
    try {
      if (window.__kunFlowWatch && window.__kunFlowWatch[key]) {
        clearInterval(window.__kunFlowWatch[key]);
        delete window.__kunFlowWatch[key];
      }
    } catch (e) { /* ignore */ }
  }
  watchAttach(storeKey);
  let g = flowLoadGraph(storeKey);
  // 🔍 挂载心跳（诊断用）：面板**每一次真正挂载**都写一次 —— 远程就能判断"画布到底有没有重建过新实例"。
  //   配合 pollRunning 里那份 beat.json：mount 有、beat 没有 ⇒ 实例在但轮询死了；两个都没有 ⇒ 实例根本没重建。
  try { flowSnapWrite(storeKey, snapDir, 'mount.json', new Date().toISOString()); } catch (e) { /* ignore */ }
  if (!g) g = flowSeedGraph();
  // 一进来就落一次（种子图 / 老图都算）：localStorage 照旧，配了快照目录就顺手把磁盘那份也刷新，
  // 这样"打开过画布"就等于"AI 会话立刻能读到图"，不用等人点一次 ⧉ Markdown。
  flowSaveGraph(storeKey, g, snapDir);
  let view = { x: 16, y: 44, k: 1 };
  let sel = null;                    // { type:'node'|'edge', id }
  let nodeEls = {};                  // id -> DOM
  let dragMove = null, dragPan = null, dragWire = null;
  let seq = 0;
  let pathStat = {};                 // path -> { exists, size }：节点第三行的 ✓/⚠（异步查，查完重画）
  let checking = false;              // 正在批量查路径状态（防重入）
  let checkAgain = false;            // 查的当中又存了新路径 ⇒ 这一轮收尾后再补一轮（见 checkPaths 末尾）
  let netStat = {};                  // 'host:port' -> { open, at, noApi }：控制台/工作台的状态点
  let netBusy = false;               // 正在探端口（防重入：一轮没探完不发下一轮）
  let thumbBudget = 0;               // 本帧还剩几个"视频首帧"名额（见 FLOW_VIDEO_THUMB_MAX，每帧在 render 开头重置）
  let bubbleEl = null;               // 落点判型的小气泡（同时只留一个，关的时候一起清）
  let bubbleTimer = null;            // 气泡的自动消失定时器（cleanup 里要清掉，不然面板销毁后还在响）
  const previewId = String(meta.viewPanel || '');   // 双击节点时把文件摊到哪个预览面板（场景 json 里配）

  const viewport = el('div', 'flow-viewport');
  viewport.tabIndex = 0;
  const world = el('div', 'flow-world');
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('class', 'flow-wires');
  const wireLayer = document.createElementNS(SVGNS, 'g');
  svg.appendChild(wireLayer);
  const tempWire = document.createElementNS(SVGNS, 'path');
  tempWire.setAttribute('class', 'flow-wire-temp');
  tempWire.style.display = 'none';
  svg.appendChild(tempWire);
  viewport.appendChild(world);
  viewport.appendChild(svg);
  body.appendChild(viewport);

  // ---- 左上工具条（浮在画布上，不占画布高度） ----
  // ★四个添加入口，一类一个★（用户 2026-09-21：「添加节点分一下类，内容、工具、看板节点都要有一个自己的添加节点」，
  //   同日再补第四类 **方式节点**）—— 以前是一个混着 12 个类型的「＋ 节点 ▾」，一摞到底；
  //   现在**按类拆成四个按钮、各带自己的分类色**，每个菜单里只有这一类的类型，还带一句 tip。
  //   四个菜单**天生互斥**：showMenu() 第一件事就是 closeMenu()，点第二个按钮时前一个自己就关了。
  //   顺序 = FLOW_ADD_ORDER（内容 / 方式 / 工具 / 看板），本批与 FLOW_CATS 统一成同一个顺序。
  //   ⚠ 不再保留"混在一起的第五个入口"（用户明说别留）。
  const bar = el('div', 'flow-bar');
  const mkBtn = (label, title) => {
    const b = el('button', 'file-refresh', label);
    b.type = 'button';
    b.title = title || '';
    return b;
  };
  const addBtns = {};
  FLOW_ADD_ORDER.forEach(cid => {
    const c = flowCat(cid);
    const b = mkBtn('＋ ' + c.name + ' ▾', '加一个' + c.name + '（只列这一类的类型）\n' + c.name + '：' + c.hint);
    b.dataset.cat = c.id;         // 让探针/自检认得出"哪个按钮是哪一类"
    b.style.color = c.color;      // 视觉上也用各分类自己的颜色（用户允许"小圆点或文字色即可"）
    b.addEventListener('click', () => openAddMenu(c, b));
    addBtns[c.id] = b;
    bar.appendChild(b);
  });
  const fitBtn = mkBtn('⤢ 适应', '缩放到能看见全部节点');
  const tidyBtn = mkBtn('⇥ 整理', '按连线顺序重新排成左→右的列');
  const chkBtn = mkBtn('⟳ 状态', '重新检查：节点的文件在不在（✓ 在 / ⚠ 找不到）、控制台/工作台的端口通不通（绿点/红点）');
  const mdBtn = mkBtn('⧉ Markdown', '把这张图复制成 Markdown 大纲（粘给 AI 看 / 落进项目信息）');
  const clrBtn = mkBtn('🗑 清空', '清空整张图（节点和连线都删掉）');
  [fitBtn, tidyBtn, chkBtn, mdBtn, clrBtn].forEach(x => bar.appendChild(x));
  // ★2026-09-27 用户定★ 「▤ 物理科普短视频」= 一键套用内置模板（就放在工具栏那四个「＋ …节点」入口后面）。
  //   用户原话：「目前这整个任务流是专门属于（物理科普短视频）你可以把这个模板保存下来放在视频群工作流标题栏后面」。
  //   套用只换**图**（节点 + 连线）：磁盘上的文件一个都不动（和「🗑 清空」同一套写法：g = {...}; sel = null; save(); render()）。
  //   路径一律留空 ⇒ 靠"项目文件夹继承"派生（见 flowDirOf / render 里那两行）；单个节点自己填了「存到文件夹」就以它为准。
  // ★2026-09-27 用户要求：模板改成**下拉**（「不然模板多了位置不够」）★
  //   原来是一模板一颗按钮 ⇒ 模板一多工具栏就挤爆。现在跟四个「＋ …节点 ▾」同一套：
  //   一颗「▤ 模板 ▾」，菜单里列模板（现在是 1 个：物理科普短视频），**以后加模板只往 FLOW_TEMPLATES 里加一项**。
  const FLOW_TEMPLATES = [FLOW_TPL_PHYSICS, FLOW_TPL_CODEVIDEO];
  const applyTemplate = (tpl) => {
    const cur = (g.nodes || []).length;
    if (cur && !window.confirm('套用「' + tpl.name + '」模板会**替换**当前画布上的 ' + cur + ' 个节点和连线。\n\n磁盘上的文件一个都不动，但画布现在的排列会没了 —— 建议先点「⧉ Markdown」留一份，或先「⟳ 刷新当前场景」存一次快照。\n\n确定套用吗？')) return;
    const cp = x => JSON.parse(JSON.stringify(x));
    g = { v: 2, nodes: tpl.nodes.map(cp), edges: tpl.edges.map(cp) };
    sel = null; save(); render();
    say('已套用「' + tpl.name + '」模板 —— 给「项目文件夹」填一次路径，其余节点自动派生；单个节点也能手改');
  };
  const tplBtn = mkBtn('▤ 模板 ▾', '内置模板：一键套用一条完整任务流（只载入最初的任务流；套用会替换当前画布，磁盘文件不动）'
    + '\n· 路径一律留空 ⇒ 给「项目文件夹」填一次，其余节点自动派生（单个节点填了就以它为准）'
    + '\n· 加模板只改 FLOW_TEMPLATES 一处');
  tplBtn.dataset.tpl = 'menu';
  tplBtn.addEventListener('click', () => {
    const r = tplBtn.getBoundingClientRect();
    showMenu(r.left, r.bottom + 6, FLOW_TEMPLATES.map(t => ({
      icon: '▤', label: t.name,
      tip: (t.hint || '') + '\n只载入最初的任务流；点一下套用（会替换当前画布，磁盘文件不动）',
      run: () => applyTemplate(t),
    })));
  });
  bar.appendChild(tplBtn);
  // 工具栏右边这行小字 = 分类统计（用户要的"让分类看得见"的第三处；另两处：＋菜单的小标题、卡片左侧 2px 色条）。
  // 数字是**按图里现在真有的节点**现数的（不是类型表的数量）⇒ 一眼看出这张图里内容/方式/工具/看板各几个。
  // 样式写 inline 而不是进 styles.css：本次只许动 renderers.js，这样点一次 ⟳ 就生效、不用重启 GUI。
  const catStat = el('span', 'flow-cat-stat', '');
  catStat.style.cssText = 'margin-left:2px;padding:2px 8px;border-radius:999px;border:1px solid var(--border);'
    + 'font-size:10.5px;line-height:1.6;color:var(--text-dim);white-space:nowrap;cursor:default;';
  catStat.title = '这张图里四类节点各几个（按角色分，不是按类型）：'
    + FLOW_CATS.map(c => '\n· ' + c.name + '：' + c.hint).join('')
    + '\n\n卡片左侧那条 2px 色条 = 类别色（' + FLOW_CATS.map(c => c.name + ' ' + c.color).join(' / ') + '）'
    + '\n工具栏左边四个按钮就是按这四类分开的（' + FLOW_ADD_ORDER.map(id => '＋ ' + flowCat(id).name).join(' / ') + '），各自只列自己那一类'
    + '\n加新类型只改 FLOW_TYPES 里的 cat 字段。';
  bar.appendChild(catStat);
  viewport.appendChild(bar);
  const hint = el('div', 'flow-hint', '拖动空白=平移 · 滚轮=缩放 · 「＋ 内容/方式/工具/看板节点 ▾」=按类选类型 · 拖 ● =连线（看落点自动定线型：右口=主线 / 下口=方式 / 上口=依据） · 右键线=改线型·删线 · 双击节点=打开/摊到预览');
  const stat = el('div', 'flow-stat', '');
  const toast = el('div', 'flow-toast', '');
  viewport.appendChild(hint);
  viewport.appendChild(stat);
  viewport.appendChild(toast);

  let toastTimer = null;
  function say(msg) {
    toast.textContent = msg;
    toast.classList.add('on');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.classList.remove('on'); toastTimer = null; }, 1600);
  }
  const save = () => flowSaveGraph(storeKey, g, snapDir);

  // ============ 多画布：清单 / 标签栏 / 切换 / 新建 / 改名 / 删除 ============
  // 契约与文件布局见本文件里"多画布"那段说明。三条铁律：
  //   ① 第 1 张（默认画布）key 永远是 baseKey，**不可删、不可改名**（会话侧就按它读快照）；
  //   ② 第 2/3 张 = baseKey + '.' + n，各自独立的 localStorage / 快照 / running 灯；
  //   ③ 清单**每次新建·切换·改名·删除**都重写两份（localStorage + 快照目录里那份 json）。
  const canvasViews = {};                              // 每张画布自己的平移缩放（切走时记下、切回来还原；不落盘）
  const canvasTabOf = (n) => canvases.list.filter((c) => c.n === n)[0] || null;
  // 标签栏重绘（标签最多 3 个 ⇒ 整条重建最省事；改名用的输入框只在 dblclick 期间存在，重建不会打断用户输入状态）
  function canvasTabsRender() {
    while (tabList.firstChild) tabList.removeChild(tabList.firstChild);
    canvases.list.forEach((c) => {
      const on = c.n === canvases.active;
      const t = el('div', 'flow-tab' + (on ? ' on' : ''));
      t.dataset.n = String(c.n);
      t.dataset.key = c.key;
      t.dataset.on = on ? '1' : '0';
      t.title = c.title + '（第 ' + c.n + ' 张）\n' + c.key
        + (on ? '\n★ 当前显示的就是这张' : '\n单击 = 切到这张（节点/连线/视图/运行灯都是它自己的）')
        + (c.n === 1 ? '\n默认画布：不可删、不可改名（会话侧按这个 key 读快照）' : '\n双击 = 改名 · 点 × = 删除');
      t.appendChild(el('span', 'flow-tab-name', c.title));
      if (c.n !== 1) {
        const x = el('button', 'flow-tab-x', '×');
        x.type = 'button';
        x.dataset.role = 'flow-canvas-del';
        x.title = '删除「' + c.title + '」（清掉 ' + c.key + ' 的 localStorage；磁盘快照留着，自己清）';
        x.addEventListener('mousedown', (ev) => ev.stopPropagation());
        x.addEventListener('click', (ev) => { ev.stopPropagation(); canvasRemove(c.n); });
        t.appendChild(x);
      }
      t.addEventListener('click', () => { if (c.n !== canvases.active) canvasActivate(c.n); });
      t.addEventListener('dblclick', (ev) => { ev.stopPropagation(); canvasRename(c.n); });
      tabList.appendChild(t);
    });
    const full = canvases.list.length >= FLOW_CANVAS_LIMIT;
    tabAdd.disabled = full;                            // 到上限：按钮禁用
    tabAdd.classList.toggle('off', full);
    tabAdd.dataset.full = full ? '1' : '0';
    tabAdd.title = full
      ? ('上限 ' + FLOW_CANVAS_LIMIT + ' 个：要新建就先删一张（非默认标签上的 ×）')
      : ('新建画布（现在 ' + canvases.list.length + '/' + FLOW_CANVAS_LIMIT + ' 张）：空图 + 一个「文案」种子节点'
        + '\n快捷键：标签双击改名 · 非默认标签有 × 可删');
    tabsInfo.textContent = '第 ' + canvases.active + ' / ' + canvases.list.length + ' 张（上限 ' + FLOW_CANVAS_LIMIT + '）';
  }
  // 清单落两份：localStorage（本机、同步、下次挂载先读它）+ 快照目录里的 json（会话侧唯一入口）。写完顺手重绘标签栏。
  function canvasManifestSave() {
    const json = JSON.stringify(canvases, null, 2);
    try { localStorage.setItem(canvasesKey, json); } catch (e) { /* 存不了也还能用，只是下次打开不记得 */ }
    try { flowSnapWrite(baseKey, snapDir, 'canvases.json', json); } catch (e) { /* ignore */ }
    canvasTabsRender();
  }
  // 切画布 / 新建 / 删掉当前那张 之后共用的"换图"动作：换 key → 读新图 → 停旧看门狗起新的 → 清 DOM → 重绘。
  //   ⚠ 顺序不能改：**先 save() 再换 storeKey**（否则这一张的改动会写进下一张的 key 里 = 串图）。
  function canvasSwapTo(n, viewInit) {
    storeKey = flowCanvasKeyOf(baseKey, n);
    g = flowLoadGraph(storeKey) || flowSeedGraph();
    const v = viewInit || canvasViews[n];
    view = v ? { x: v.x, y: v.y, k: v.k } : { x: 16, y: 44, k: 1 };
    sel = null;
    runIds = [];                                       // 旧那张的运行灯名单清掉（新那张由 pollRunning 按它的 running.json 重新点）
    nodeEls = {};
    while (world.firstChild) world.removeChild(world.firstChild);
    closeMenu(); closeBubble(); closeDialog();
    try { flowSnapWrite(storeKey, snapDir, 'mount.json', new Date().toISOString()); } catch (e) { /* ignore */ }
    save();
    applyView(); render();
    setTimeout(function () { if (!disposed) { checkPaths(); pollNet(); pollRunning(); } }, 0);
  }
  // 切到第 n 张：**保存当前这张 → 换 storeKey → 重新读图 + render()**（用户要的"切回来不丢"）
  function canvasActivate(n) {
    const to = canvasTabOf(n);
    if (!to || n === canvases.active) return;
    const prevKey = storeKey;
    canvasViews[canvases.active] = { x: view.x, y: view.y, k: view.k };   // 记下当前这张的平移缩放
    save();                                                               // 当前这张先落盘（localStorage + 快照），切回来不丢
    canvases.active = n;
    watchDetach(prevKey);                                // ⛔ 旧 key 的看门狗先停，再建新的
    watchAttach(flowCanvasKeyOf(baseKey, n));
    canvasSwapTo(n);
    canvasManifestSave();                                // 清单（active 变了）+ 标签高亮
    say('已切到「' + to.title + '」（' + g.nodes.length + ' 个节点 · ' + storeKey + '）');
  }
  // 新建：新标签 = 空图 + 一份种子（flowSeedGraph，跟第一次打开画布同一份）；到上限就不给新建
  function canvasAdd() {
    if (canvases.list.length >= FLOW_CANVAS_LIMIT) {     // 双保险：按钮已置灰，这里再挡一次（脚本/键盘也进不来）
      say('上限 ' + FLOW_CANVAS_LIMIT + ' 个画布：要新建就先删一张（非默认标签上的 ×）');
      return;
    }
    let n = 0;
    for (let i = 2; i <= FLOW_CANVAS_LIMIT; i++) if (!canvasTabOf(i)) { n = i; break; }
    if (!n) return;
    const prevKey = storeKey;
    canvasViews[canvases.active] = { x: view.x, y: view.y, k: view.k };
    save();
    canvases.list.push({ n: n, key: flowCanvasKeyOf(baseKey, n), title: flowCanvasTitleOf(n) });
    canvases.list.sort((a, b) => a.n - b.n);
    canvases.active = n;
    watchDetach(prevKey);
    watchAttach(flowCanvasKeyOf(baseKey, n));
    canvasSwapTo(n, { x: 16, y: 44, k: 1 });             // 新画布从默认视口开始（fit 不调：种子就一个节点，居中看即可）
    canvasManifestSave();
    say('已新建「' + canvasTabOf(n).title + '」（空图 + 一个「文案」种子节点 · ' + storeKey + '）');
  }
  // 删除：默认画布不可删；删之前 confirm；删了清掉它的 localStorage 并重写清单（磁盘快照留着，由用户自己清）
  function canvasRemove(n) {
    const c = canvasTabOf(n);
    if (!c) return;
    if (n === 1) { say('默认画布不能删（会话侧就按 ' + baseKey + ' 读快照）'); return; }
    const left = canvases.list.filter((x) => x.n !== n);
    const snap = snapDir ? flowSnapFile(c.key, snapDir, 'json') : '';
    if (!window.confirm('删除画布「' + c.title + '」？\n\n'
      + '· 它的 localStorage（' + c.key + '）会被清掉 —— 这张图就没了；另外 ' + left.length + ' 张不受影响\n'
      + '· 磁盘上的快照' + (snap ? '（' + snap + '）' : '') + '**不删**：要清自己删\n'
      + '· 默认画布（' + baseKey + '）不动\n\n确定删除吗？')) return;
    const wasActive = canvases.active === n;
    const prevKey = storeKey;
    try { localStorage.removeItem(c.key); localStorage.removeItem(c.key + '.importedAt'); } catch (e) { /* ignore */ }
    delete canvasViews[n];
    canvases.list = left;
    if (wasActive) {                                     // 删的是正在看的那张 ⇒ 切回第 1 张
      canvases.active = left[0].n;
      watchDetach(prevKey);
      watchAttach(flowCanvasKeyOf(baseKey, canvases.active));
      canvasSwapTo(canvases.active);
    }
    canvasManifestSave();
    say('已删除「' + c.title + '」' + (wasActive ? ('，已切回「' + canvasTabOf(canvases.active).title + '」') : ''));
  }
  // 改名（标签双击）：默认画布不许改（它的标题按契约就是「默认画布」）。
  //   ⚠ Electron 里 window.prompt 不可用 ⇒ 就地放一个 input（Enter 提交 / Esc 取消 / 失焦提交）。
  function canvasRename(n) {
    const c = canvasTabOf(n);
    if (!c) return;
    if (n === 1) { say('默认画布不可改名（第 1 张 = 会话侧读的那张，标题固定「默认画布」）'); return; }
    const tab = tabList.querySelector('.flow-tab[data-n="' + n + '"]');
    if (!tab || tab.querySelector('.flow-tab-edit')) return;   // 已经在改名了就别叠第二个输入框
    const nameEl = tab.querySelector('.flow-tab-name');
    const inp = document.createElement('input');
    inp.className = 'flow-tab-edit';
    inp.value = c.title;
    inp.maxLength = 20;
    if (nameEl) nameEl.style.display = 'none';
    tab.appendChild(inp);
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      const v = String(inp.value || '').trim();
      if (ok && v && v !== c.title) {
        c.title = v.slice(0, 20);
        canvasManifestSave();                            // 改名也重写清单（会话侧看的就是清单里的 title）
        say('已改名为「' + c.title + '」');
      } else canvasTabsRender();
    };
    inp.addEventListener('mousedown', (ev) => ev.stopPropagation());
    inp.addEventListener('dblclick', (ev) => ev.stopPropagation());
    inp.addEventListener('keydown', (ev) => {
      ev.stopPropagation();                              // 别让画布的 Delete/Backspace 快捷键顺手删节点
      if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
      else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
    });
    inp.addEventListener('blur', () => finish(true));
    setTimeout(() => { try { inp.focus(); inp.select(); } catch (e) { /* ignore */ } }, 0);
  }
  // 挂载时初始化标签栏：注入样式 + 写一份清单（**每次挂载都重写** ⇒ 会话侧随时读得到"有几张、看的是第几张"）
  function canvasInit() {
    ensureCanvasCss();
    canvasManifestSave();
  }
  const nodeById = (id) => {
    for (let i = 0; i < g.nodes.length; i++) if (g.nodes[i].id === id) return g.nodes[i];
    return null;
  };
  const nodeSize = (id) => {
    const d = nodeEls[id];
    return { w: d ? d.offsetWidth : 190, h: d ? d.offsetHeight : 74 };
  };
  function applyView() {
    world.style.transform = 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.k + ')';
    // 点阵背景不跟着 world 缩放（缩放的圆点会糊），改为手动对齐网格：位置随平移、间距随缩放
    const step = 20 * view.k;
    viewport.style.backgroundSize = step + 'px ' + step + 'px';
    viewport.style.backgroundPosition = (view.x % step) + 'px ' + (view.y % step) + 'px';
    drawWires();
  }
  // 画线（三种线型共用这一处，见 FLOW_WIRE_STYLE）：
  //   主线 = 粗实线 + 箭头 / 方式 = 细实线（紫，**不虚线**）+ 箭头 / 依据 = 虚线（中性灰）+ 箭头。
  // ★箭头只画在**被指向的那一端**★（用户原话"这个箭头是从哪里指向哪里就在哪里"）：尖端落在目标节点的
  //   端口锚点上、朝节点里指；起点端和线的中间一律不画（所以不用 SVG marker，见 flowArrowD 的注释）。
  function drawWires() {
    while (wireLayer.firstChild) wireLayer.removeChild(wireLayer.firstChild);
    g.edges.forEach(e => {
      const a = nodeById(e.from), b = nodeById(e.to);
      if (!a || !b || !nodeEls[e.from] || !nodeEls[e.to]) return;
      const sa = nodeSize(e.from), sb = nodeSize(e.to);
      // 世界坐标 → 屏幕坐标：连线这一层**不跟着 world 变换**（stroke 不会被缩放糊掉，
      // 也不用为了超出 world 的 0×0 盒子去做 overflow 命中测试），所以这里手动换算。
      const sd = (FLOW_DIRS[e.fs] && FLOW_DIRS[e.ts]) ? { fs: e.fs, ts: e.ts } : flowEdgeSides(a, sa, b, sb, flowType(b.type));
      const p1 = flowScreen(flowAnchor(a, sa, sd.fs), view);
      const p2 = flowScreen(flowAnchor(b, sb, sd.ts), view);
      const kind = flowWireKind(e, a, b);
      const st = flowWireStyle(kind);
      const on = !!(sel && sel.type === 'edge' && sel.id === e.id);
      // 颜色/线宽/虚线全部**写 inline**：一是探针能直接读到（styles.css 里那套老 .flow-wire 样式是黑历史），
      // 二是内联优先级最高、选中态（.on）改不了它们 ⇒ 选中改成"更粗 + 外发光"，颜色仍然一眼能认出是哪一型。
      const p = document.createElementNS(SVGNS, 'path');
      p.setAttribute('class', 'flow-wire flow-wire-' + kind + (on ? ' on' : ''));
      p.setAttribute('d', flowWireD(p1, p2));
      p.setAttribute('stroke', on ? '#e9eefc' : st.color);
      p.setAttribute('stroke-width', String(st.w + (on ? 1.2 : 0)));
      if (st.dash) p.setAttribute('stroke-dasharray', st.dash);
      p.dataset.kind = kind;
      p.dataset.from = e.from; p.dataset.to = e.to;
      p.dataset.fs = sd.fs; p.dataset.ts = sd.ts;
      if (on) p.style.filter = 'drop-shadow(0 0 4px ' + st.color + ')';
      p.addEventListener('mousedown', (ev) => {
        ev.stopPropagation();
        sel = { type: 'edge', id: e.id };
        render();
      });
      // 右键一条线 = 改线型 / 删线（用户要的"右键连线可以改类型或删除"）。
      // 右键也顺手把它选中：菜单点完要重画时，人还看得见自己刚才动的是哪条。
      p.addEventListener('contextmenu', (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        sel = { type: 'edge', id: e.id };
        render();
        showMenu(ev.clientX, ev.clientY, edgeMenu(e, kind, a, b));
      });
      wireLayer.appendChild(p);
      // 箭头（只有在目标端这一个）：尺寸跟着线宽走（主线粗 ⇒ 箭头也大一号，远看一眼就能分清）
      const ar = document.createElementNS(SVGNS, 'path');
      ar.setAttribute('class', 'flow-arrow flow-arrow-' + kind);
      ar.setAttribute('d', flowArrowD(p2, 5 + st.w * 1.6, 3.2 + st.w * 0.7));
      ar.setAttribute('fill', on ? '#e9eefc' : st.color);
      ar.dataset.kind = kind;
      ar.dataset.to = e.to;            // ★箭头挂在谁身上★（探针就断言这一条：只出现在被指向的那一端）
      ar.dataset.side = sd.ts;
      ar.dataset.x = String(Math.round(p2.x)); ar.dataset.y = String(Math.round(p2.y));
      wireLayer.appendChild(ar);
      const dot = document.createElementNS(SVGNS, 'circle');
      dot.setAttribute('class', 'flow-wire-dot' + (on ? ' on' : ''));
      dot.setAttribute('cx', p2.x); dot.setAttribute('cy', p2.y); dot.setAttribute('r', 3.2);
      dot.setAttribute('fill', on ? '#e9eefc' : st.color);
      wireLayer.appendChild(dot);
    });
  }
  function makeNodeEl(n) {
    const d = el('div', 'flow-node');
    d.dataset.id = n.id;
    const head = el('div', 'flow-node-head');
    const ic = el('span', 'flow-node-icon', '');
    const ti = el('span', 'flow-node-title', '');
    head.appendChild(ic); head.appendChild(ti);
    // ★2026-09-27 卡片改版（用户原话：「内容卡片只显示标题以及对应的图片视频或者音频以及提示，
    //   文案内容卡片只显示标题以及提示。其他卡片也要美观」）★
    //   一张卡从上到下**只有这四行**：
    //     ① 标题行（图标 + 名字，12px/600，超出省略号）—— head
    //     ② 媒体位（video/image 有真文件 ⇒ 真缩略图/首帧；没有文件 ⇒ 一枚小而克制的类型徽标「视频 · MP4」）
    //        ⚠ 文案卡（type=text）与方式/工具/看板/文件夹卡**没有这一行**（整个不显示，卡片自然矮一截）
    //     ③ 提示行（**唯一一行**要求文字 = 第一句 ~40 字，见 flowHintOf；没有要求文字就整行不显示）
    //     ④ 状态行（状态点 + 文件/端口/待生成 —— 完成指示灯就长在这一行的点上，不能动）
    //   删掉的四行（.flow-node-note / -method / -plot / -seg）里的信息**一个都没丢**：
    //     · 描述 / 情节 / 要做什么 / 指令模板 / 默认干什么 —— 仍在右键「✎ 编辑节点」里，且整段进 d.title（悬停可见）；
    //     · 段落 / 起止秒 / 用途 / 格式 / 几步 —— 仍在 d.title 与「⧉ Markdown」导出里（导出走 flowFieldLines，没动）。
    //   为什么删：用户点名"卡片之间不要重复、同一个信息只出现一次"—— 旧卡片上"待生成"在副行和状态行各写了一遍，
    //     描述还占了 2 行 + 前 16 字一行（同一段话说三遍），卡片又高又糊。
    //   ⚠ 下面这些类名/属性**不许改**（改了就破既有能力）：`.flow-node-thumb`（updateThumb 按它找 + 视频首帧闸门）、
    //     `.flow-node-path/-dot/-file`（状态点 / 完成指示灯 / 端口探测）、`.flow-node-no`（主线角标）、
    //     `.flow-node-catbar`（左侧 2px 类色条）、`.flow-port-*`（四个接线口）、`data-id`（跑着灯的定位）。
    const md = el('div', 'flow-node-media', '');          // 媒体位（徽标宿主；有真图时让位给 .flow-node-thumb）
    md.style.cssText = 'display:none;margin:5px 0 0;line-height:0;';
    const bg = el('span', 'flow-node-badge', '');
    bg.style.cssText = 'display:inline-block;box-sizing:border-box;max-width:100%;padding:1px 7px;border-radius:999px;'
      + 'border:1px solid var(--border);background:rgba(127,140,170,.10);'
      + 'font-size:9.5px;line-height:15px;letter-spacing:.2px;color:var(--text-dim);'
      + 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    md.appendChild(bg);
    // 真缩略图（图片类型 / 视频首帧）：用户要的"内容节点能预览"落到卡片上这一层。
    //   ⚠ 默认 display:none，只有 render() 确认"文件真的在 + 这个类型声明了 thumb"才显示并把图标换掉。
    const th = el('div', 'flow-node-thumb', '');
    th.style.cssText = 'display:none;margin:5px 0 1px;border-radius:4px;overflow:hidden;background:#0b0f18;'
      + 'line-height:0;pointer-events:none;';
    const hn = el('div', 'flow-node-hint', '');          // 提示行（一行；没有要求文字就整行不显示）
    hn.style.cssText = 'margin-top:3px;font-size:10.5px;line-height:1.35;color:var(--text-dim);'
      + 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:none;';
    const pt = el('div', 'flow-node-path');              // 最后一行：文件名/端口状态 + 状态点
    const pd = el('span', 'flow-node-dot', '·');
    const pf = el('span', 'flow-node-file', '');
    pt.appendChild(pd); pt.appendChild(pf);
    d.appendChild(head); d.appendChild(md); d.appendChild(th); d.appendChild(hn); d.appendChild(pt);
    // 编号角标（右上角）：主线（seq 连线）串起来的顺序 ① ② ③ —— 和「⧉ Markdown」导出**同一份编号**。
    //   为什么非要有：用户"顺序不靠眼睛数位置" ⇒ 卡片上直接写死号码，导出和画面对得上。
    //   不在主线上的节点不显示（display:none），比如挂在旁边的依据/素材。
    const no = el('span', 'flow-node-no', '');
    no.style.cssText = 'position:absolute;top:-7px;right:-7px;min-width:16px;height:16px;padding:0 3px;'
      + 'border-radius:9px;font-size:10px;font-weight:700;line-height:16px;text-align:center;'
      + 'color:#0b0f18;display:none;pointer-events:none;box-shadow:0 0 0 2px var(--bg-panel,#141a26);';
    d.appendChild(no);
    // 类别标记（"让分类看得见"的第二处）：卡片**内侧**左边一条 2px 色条。
    // 为什么放内侧：卡片外层那 3px 左边框早就给了"类型自己的颜色"（那个观感要保留），
    //   绝对定位的 left:0 是相对 padding box ⇒ 类色条落在边框里面，两种颜色并排、谁也不盖谁。
    // 颜色在 render() 里按 cat 刷（这里只建元素，和别的字段一样"建一次、之后只改内容"）。
    const cb = el('span', 'flow-node-catbar', '');
    cb.style.cssText = 'position:absolute;left:0;top:0;bottom:0;width:2px;border-radius:2px 0 0 2px;'
      + 'pointer-events:none;';
    d.appendChild(cb);
    // 接线口：这个类开在哪儿几个面由类型的 sides 决定（左右=老样子 / 上下 / 四面都开）。
    // ⚠ 每个口**既能拖出线、也能被接线**（不用再分"这是输入口那是输出口"）：
    //    拖出去时记下从哪个面出发，接上时记下落在哪个面 → 边存 fs/ts，画线按面取锚点。
    flowSides(flowType(n.type)).forEach(side => {
      // 保留老的 in/out 类名只是为了让老 CSS（左口灰、右口蓝）继续生效，不影响行为
      const role = (side === 'l' || side === 't') ? ' flow-port-in' : ' flow-port-out';
      const sp = el('span', 'flow-port flow-port-' + side + role);
      sp.dataset.side = side;
      sp.title = side === 't' ? '上口：往上/往下连都行（控制台一般接在工作台上方）'
        : side === 'b' ? '下口：从这里拖出去就能连线'
          : side === 'l' ? '左口：别的节点连过来的地方'
            : '右口：从这里拖到下一个节点就能连线';
      sp.addEventListener('mousedown', (ev) => {
        if (ev.button !== 0) return;
        ev.stopPropagation(); ev.preventDefault();
        dragWire = { from: n.id, side: side };
        tempWire.style.display = '';
        bindDrag();
      });
      d.appendChild(sp);
    });
    // 拖节点（按住节点任意处）= 移动；同时选中它
    d.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return;
      ev.stopPropagation();
      sel = { type: 'node', id: n.id };
      render();
      d.classList.add('dragging');   // 拖动期间：过渡全停 + 悬浮那 2px 位移让位（见 styles.css 末尾追加段）
      dragMove = { n: n, mx: ev.clientX, my: ev.clientY, x0: n.x, y0: n.y, moved: false };
      bindDrag();
    });
    // 双击 = 把这个节点对应的东西摊到预览面板 / 打开软件 / 打开网页版窗口（四种 kind 都在这儿分叉，见 nodeTypeOpen）
    d.addEventListener('dblclick', (ev) => { ev.stopPropagation(); nodeTypeOpen(n); });
    // 右键 = 编辑 / 打开 / 删除（用户定的规矩：单击选中后再右击可以编辑节点）
    d.addEventListener('contextmenu', (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      sel = { type: 'node', id: n.id };
      render();
      showMenu(ev.clientX, ev.clientY, nodeMenu(n));
    });
    return d;
  }
  // 卡片缩略图 / 视频首帧（用户要的"内容节点能预览"落到卡片这一层）。
  //   三件事决定"到底出不出图"：① 类型声明了 `thumb`（图片 'image' / 视频 'video'）；
  //   ② 路径写了、而且 pathStat 说文件真在（不在就别去拉图，省得留一个破图位）；
  //   ③ 视频还要过 FLOW_VIDEO_THUMB_MAX 这道数量闸门（首帧是真解码，图上十几个就够卡 —— 见那个常量的注释）。
  //   ⚠ 只在"路径变了"时才重建元素：拖动/选中会反复 render，每次重造 <video> 就会反复解码、画面直闪。
  function updateThumb(d, n, k) {
    const host = d.querySelector('.flow-node-thumb');
    const ic = d.querySelector('.flow-node-icon');
    if (!host) return;
    const st = pathStat[n.path];
    const okFile = !!(n.path && st && st.exists && !st.isDir);
    let mode = (k.thumb && okFile) ? k.thumb : '';
    if (mode === 'video') { if (thumbBudget <= 0) mode = ''; else thumbBudget--; }
    const key = mode ? (mode + '|' + n.path) : '';
    // ★2026-09-27 卡片改版★ 媒体位里的那枚**类型徽标**（"视频 · MP4"）：没有真图时占住媒体位 ——
    //   用户点名"没有文件就显示一个小而克制的类型徽标，不要一大片空白"。
    //   ⚠ 只给内容类**真有媒体位**的卡（video / image / audio）：文案卡按用户要求只有标题 + 提示。
    //   ⚠ 这两句必须排在下面那个 `dataset.tk === key` 的提前 return **之前** —— 徽标不随 key 变
    //     （它只在"有没有真图"之间切），放后面的话切图那一次徽标就会留在屏幕上或该出的时候不出。
    const cat = flowCatOf(k);
    const canSlot = !!(cat.id === 'content' && k.id !== 'text');
    const ext = flowFmtExt(n, k);
    const bTxt = canSlot ? (k.name + (ext ? ' · ' + String(ext).toUpperCase() : '')) : '';
    const slotEl = d.querySelector('.flow-node-media');
    const bdgEl = d.querySelector('.flow-node-badge');
    if (slotEl) slotEl.style.display = (bTxt && !mode) ? '' : 'none';
    if (bdgEl) bdgEl.textContent = bTxt;
    if (host.dataset.tk === key) return;          // 没变化，一个字都不动（这就是"不闪"的关键）
    host.dataset.tk = key;
    while (host.firstChild) host.removeChild(host.firstChild);
    if (ic) ic.style.display = mode ? 'none' : '';   // 有图就不摆图标（图标是"读不到图"时的兜底）
    if (!mode) { host.style.display = 'none'; return; }
    const url = flowFileUrl(n.path);
    // 图/首帧读不出来（文件坏了 / 编码浏览器不认 / 路径失效）时：藏掉媒体位、退回类型徽标
    //   —— ★用户点名的"不要一大片空白"★，这里是最容易漏的一条路：以前只把图标还原，媒体位是空的。
    const kill = () => {
      host.style.display = 'none'; host.dataset.tk = ''; if (ic) ic.style.display = '';
      if (slotEl && bTxt) slotEl.style.display = '';
    };
    if (mode === 'image') {
      const im = el('img', 'flow-node-thumb-img');
      im.alt = ''; im.loading = 'lazy';
      im.style.cssText = 'display:block;width:100%;height:84px;object-fit:cover;';
      im.onerror = kill;                          // 图坏了不留空位，退回图标
      im.src = url;                               // src 最后设：先挂 onerror 再给地址，免得瞬间失败接不住
      host.appendChild(im);
    } else {
      const vd = el('video', 'flow-node-thumb-video');
      vd.muted = true; vd.preload = 'metadata'; vd.playsInline = true;
      vd.style.cssText = 'display:block;width:100%;height:84px;object-fit:cover;background:#000;';
      // 只写 preload="metadata" 时常常只拿到时长、不出画面 ⇒ 元数据到了再跳到 0.1s，逼出第一帧
      vd.addEventListener('loadedmetadata', () => { try { vd.currentTime = 0.1; } catch (e) { /* ignore */ } });
      vd.onerror = kill;
      vd.src = url;
      host.appendChild(vd);
    }
    host.style.display = '';
  }
  // 卡片"活起来"的三样（用户要的"节点卡片要生动"）：① 鼠标悬浮 = 抬起来一点 + 描边换成类别色；
  //   ② 选中 = 同色发光（.flow-node.on 的发光在 styles.css 追加段里，用 --fc 变量取类别色）；
  //   ③ 拖节点时不加过渡（加了会跟手迟滞）⇒ 悬浮才挂 transition，离开就摘掉。
  function bindNodeHover(d) {
    if (d.dataset.hover === '1') return;          // 只挂一次（卡片是复用的）
    d.dataset.hover = '1';
    // 抬起来 = 在这份基础 transform（dataset.tf，现在是空串）后面追一句 translateY。
    //   ⚠ 这里**只许碰 transform**：位置在 left/top 上（见 render 的注释）——
    //   改前位置和动效共用 transform，拖完一移开鼠标就被 mouseleave 按旧值拉回拖动前的位置 = "乱跳"。
    //   为什么不写进 CSS 的 :hover：这串是内联的，CSS 里再写 transform 会被内联压掉。
    //   两个都要判 dragMove：拖动中让位（.dragging 还会把 transform 压成 none），别跟正在拖的卡片抢。
    d.addEventListener('mouseenter', () => { if (dragMove) return; d.style.transform = (d.dataset.tf || '') + ' translateY(-2px)'; d.classList.add('hover'); });
    d.addEventListener('mouseleave', () => { if (dragMove) return; d.classList.remove('hover'); d.style.transform = d.dataset.tf || ''; });
  }
  function render() {
    thumbBudget = FLOW_VIDEO_THUMB_MAX;           // 每帧重置视频首帧名额（谁先渲染谁先占）
    // ★2026-09-27★ 项目文件夹继承：每帧核一次 —— 「项目文件夹」填/改了，就把路径**写实**进各产物节点的「存到文件夹」
    //   （用户原话：填了项目文件夹，其他要生成路径文件的节点**自动为项目文件夹**；单个节点也能手改）。
    //   真的改动了才存盘（平时这一句零开销）；写盘走 flowSaveGraph 而不是 save()，免得依赖 const save 的初始化顺序。
    {
      const fdn = g.nodes.filter(x => x.type === 'folder')[0];
      if (flowSyncProjDir(g.nodes, fdn)) { try { flowSaveGraph(storeKey, g, snapDir); } catch (e) { /* 存不了也不影响这一帧 */ } }
    }
    // 主线编号：先按 seq 连线把顺序算出来（卡片的角标和「⧉ Markdown」导出共用这一份，见 flowSeqOrder）
    const seqOrder = flowSeqOrder(g);
    const seqNo = {};
    seqOrder.forEach((id, i) => { seqNo[id] = flowNum(i); });
    // 节点：先增改、再删（复用 DOM，拖动时不会重建）
    const seen = {};
    g.nodes.forEach(n => {
      seen[n.id] = true;
      let d = nodeEls[n.id];
      if (!d) { d = makeNodeEl(n); nodeEls[n.id] = d; world.appendChild(d); bindNodeHover(d); }
      const k = flowType(n.type);
      d.dataset.type = n.type;
      // ★位置只写 left/top（相对 .flow-world），transform 只留给悬浮动效★
      //   两件事写同一个属性 = "拖动乱跳"的真因（见 bindNodeHover / onDragMove 的注释，2026-09-21 修）。
      d.style.left = n.x + 'px';
      d.style.top = n.y + 'px';
      d.dataset.tf = '';                           // 悬浮"抬起来"叠在这串后面（位置已不在 transform 上 ⇒ 恒为空）
      d.dataset.id = n.id;                         // ★「正在跑」的闪烁靠它找节点（见 pollRunning）
      // ★2026-09-27 用户点名：「哪一步在执行，哪一步就要有信号」★
      //   以前只靠 pollRunning 每 2 秒贴 `.run` ⇒ 面板一重建/一 dispose（导入、切场景、热重载、另一个窗口的旧实例）
      //   灯就再也不亮。现在**重绘时也认一次**：图里存着 running 名单（`g.running`，由 _标记运行.mjs 同步写进快照）
      //   ⇒ 任何一次 render 都会把灯带上，跟轮询在不在跑无关。
      if (g && Array.isArray(g.running) && g.running.indexOf(String(n.id)) >= 0) d.classList.add('run');
      d.style.borderLeftColor = k.color;
      const cat = flowCatOf(k);
      d.style.setProperty('--fc', cat.color);      // 悬浮描边 / 选中发光都取这个类别色
      // 图标位：有官网图标（k.img）就放 <img>，没有就放单字；图挂了自动退回单字（见 flowIconInto）
      flowIconInto(d.querySelector('.flow-node-icon'), k);
      d.querySelector('.flow-node-title').textContent = n.name || k.newName;
      const nt = d.querySelector('.flow-node-note');
      if (nt) nt.style.display = 'none';           // 旧的多行正文（老实例/热重载残留）一律不显示
      // ★2026-09-27 卡片改版★ 卡片上只刷两样（标题上一行已经写了）：**提示行** + **状态行**。
      //   提示行 = 该节点「要求文字」的**第一句**（flowHintOf / flowReqText），全类型一套口径：
      //     内容卡 = 情节 / 描述；方式卡 = 要做什么 / 指令模板；工具卡 = 默认干什么；预设卡 = 指令模板。
      //     **文案卡（type=text）就只有标题 + 提示**（用户点名"正文一律不显示"）—— 所以这里没有按类型分叉。
      //     ⚠ 唯一的例外是「项目文件夹」：用户点名"文件夹=路径一行" ⇒ 不印提示（状态行里就是那条路径）。
      //   段落/起止秒/用途/格式/几步、以及方式（谁把它做出来）不再印在卡片上（用户要"同一个信息只出现一次"、
      //   卡片不许又高又糊）—— 它们全部留在 d.title（悬停看全文）和「⧉ Markdown」导出里，一个字都没丢。
      const reqTxt = (k.kind === 'dir') ? '' : flowReqText(n, k);
      const hintTxt = flowHintOf(reqTxt);
      const hn = d.querySelector('.flow-node-hint');
      hn.textContent = hintTxt;
      hn.style.display = hintTxt ? '' : 'none';
      hn.title = hintTxt ? ('要求（卡片只印第一句，全文见下）：\n' + String(reqTxt)) : '';
      // 最后一行：这个节点对应的"东西"现在什么样。三种问法（另有一种没有状态点，见 nodeStatus）：
      //   文件类（文案/视频/HTML/剪映/OBS）= 文件在不在：· 没填 / … 查中 / ✓ 在 / ⚠ 找不到
      //   网页类（控制台/工作台）= 端口通不通：● 绿=在跑 / ● 红=没运作（用户点名的"运行绿点、没运作红点"）
      //   网页版 AI（5 个免费站）= **不查**（它没有真实文件/地址），只写"双击打开"
      const st = nodeStatus(n, k);
      const dot = d.querySelector('.flow-node-dot');
      dot.textContent = st.dot;
      dot.className = 'flow-node-dot ' + st.cls + (st.live ? ' live' : '');
      const pf = d.querySelector('.flow-node-file');
      pf.textContent = st.text;
      pf.classList.toggle('none', !st.has);
      // 类别标记：色条按 cat 刷；颜色/说明都从 FLOW_CATS 现取（以后加类型不用动这里）
      d.querySelector('.flow-node-catbar').style.background = cat.color;
      // 方式链（★从连线现算★，2026-09-26 用户点名改：那个是靠连线得到的）：落在本节点上的**方式线（how）**
      //   来源 = 谁把它做出来（flowHowChain 按 x 从左到右排）。2026-09-27 起不再单独占卡片一行（用户要卡片清爽），
      //   改为进 d.title —— 连线本身在画布上看得见，文字版在这一处 + 导出里那份都还在。
      const howChain = flowHowChain(g, n.id);
      const howNm = x => (x.name || flowType(x.type).newName);
      const howTxt = howChain.length ? ('→ 用 ' + howChain.map(howNm).join(' → ')) : '';
      updateThumb(d, n, k);                        // 媒体位：真缩略图 / 视频首帧 / 没有文件时的类型徽标
      // 主线编号角标：不在主线上（seqOrder 里没有）就不显示
      const no = d.querySelector('.flow-node-no');
      const nn = seqNo[n.id] || '';
      no.textContent = nn;
      no.style.display = nn ? '' : 'none';
      no.style.background = cat.color;
      no.title = nn ? ('主线第 ' + nn + ' 段（按主线的顺序，和「⧉ Markdown」导出里那个号一致）') : '';
      // 悬停看全文（卡片上被"只印第一句 / 只印一行"省掉的东西，全在这儿找回来）：
      //   要求全文（描述/情节/要做什么/指令/默认干什么，一节一行）+ 关键字段一行（段落·秒数·用途·几步）+ 方式链。
      //   ⚠ 这一段就是"卡片变干净了但信息没丢"的兜底，别省。
      const subTxt = flowSubLine(n, k);
      const tlTxt = flowAiLines(n, k).map(x => x.label + '：' + x.text).join('\n');
      d.title = (n.name || k.newName)
        + (n.desc && flowAiLines(n, k).every(x => x.key !== 'desc') ? '\n' + String(n.desc) : '')
        + (tlTxt ? '\n' + tlTxt : '')
        + (subTxt ? '\n' + subTxt : '')
        + (howTxt ? '\n' + howTxt : '')
        + '\n' + st.tip
        + '\n分类：' + cat.name + '（' + cat.id + '）—— ' + cat.hint
        + '\n类型：' + k.name + '（' + k.id + '）'
        + '\n接线口：' + flowSides(k).map(s => ({ l: '左', r: '右', t: '上', b: '下' }[s])).join(' / ')
        + '（右=主线出 / 左=主线入 / 下=方式 / 上=依据）'
        + '\n双击：' + (k.kind === 'file' ? '在预览面板里打开这个文件'
          : k.kind === 'url' ? '在预览面板里打开这个页面'
            : k.kind === 'webai' ? '打开顶栏那个同款的免费网页版窗口（同一个登录态，不花 API token）'
              : k.kind === 'preset' ? '把这套做法摊到预览面板（步骤清单 + 指令模板，只读）'
                : '直接打开这个软件');
      d.classList.toggle('on', !!(sel && sel.type === 'node' && sel.id === n.id));
    });
    Object.keys(nodeEls).forEach(id => {
      if (!seen[id]) { try { world.removeChild(nodeEls[id]); } catch (e) { /* ignore */ } delete nodeEls[id]; }
    });
    drawWires();
    stat.textContent = '节点 ' + g.nodes.length + ' · 连线 ' + g.edges.length + ' · ' + Math.round(view.k * 100) + '%';
    renderCatStat();
  }
  // 工具栏右边那行分类统计：「内容 3 · 方式 2 · 工具 8 · 看板 1」（名字去掉"节点"二字，短；数字按图里现有节点数）
  function renderCatStat() {
    const cnt = {};
    g.nodes.forEach(n => {
      const c = flowCatOf(flowType(n.type)).id;
      cnt[c] = (cnt[c] || 0) + 1;
    });
    catStat.textContent = FLOW_CATS.map(c => c.name.replace('节点', '') + ' ' + (cnt[c.id] || 0)).join(' · ');
  }
  // 第三行 + 状态点的内容（按类型分几种问法，见 render 里的注释）
  function nodeStatus(n, k) {
    // 网页版 AI 节点：**没有真实文件/地址**（用户点名"不要给它文件状态点"）⇒
    // 状态点留空，第三行只写它是干什么的（不然那一行会是"未设路径（右键编辑）"，误导人）。
    if (k.kind === 'webai') {
      return {
        dot: '', cls: 'none', has: true,
        text: '免费网页版 · 双击打开',
        tip: '顶栏同款窗口（站点 key：' + (k.webaiKey || '？') + '）：同一个登录态、不花 API token'
      };
    }
    // 项目文件夹节点（kind:'dir'）：它自己**就是**一个文件夹 ⇒ 第三行写"双击打开"，**不做文件 stat**
    //   （拿目录去 stat 只会报"找不到"，反而误导人）。
    if (k.kind === 'dir') {
      const dp = String(n.path || '').trim();
      return {
        dot: dp ? '●' : '·', cls: dp ? 'ok' : 'none', has: true,
        text: dp ? ('双击打开 · ' + dp) : '还没填文件夹路径（右键「✎ 编辑节点」）',
        tip: dp ? ('双击用资源管理器打开：' + dp) : '把文件夹路径填上（写到文件夹本身，例：<资料库>'
      };
    }
    // 固定流程预设节点：也**没有文件/地址**（它的"内容"就是那几行步骤）⇒ 同 webai 的处理，
    // 第三行写"双击摊开这套做法 + 几步"，让人一眼知道它是什么、点下去会发生什么。
    if (k.kind === 'preset') {
      const cnt = flowPresetSteps(n.steps).length;
      return {
        dot: '', cls: 'none', has: true,
        text: '预设 · ' + (cnt ? cnt + ' 步' : '还没写步骤') + ' · 双击预览',
        tip: '固定流程预设：' + (cnt ? cnt + ' 步做法' : '还没写步骤（右键编辑）')
          + '\n预览形式：' + (String(n.preview || 'text') === 'canvas' ? '流程图小图' : '文字说明')
      };
    }
    const net = !!(k.kind === 'url' && k.probe);
    // ★素材性质=待生成（2026-09-23 第七轮 + 修正）：这个节点还没文件、也不该报"没填路径"红点 ——
    //   它的"目标"是生成一个文件，状态点改显示「◎ 待生成 → 存到 <文件名>」（文件名没填则提示补）。
    if (String(n.mode || '').trim() === FLOW_MODE_GEN) {
      const f = String(n.fname || '').trim();
      const seg = flowDirSeg(flowDirOf(n)) || f;
      return {
        dot: '◎', cls: 'gen', has: true,
        text: '待生成 → 存到 ' + (seg || '（还没填）'),
        tip: '素材性质：待生成 → 存到文件夹'
          + (String(flowDirOf(n)).trim() ? '\n存到文件夹：' + flowDirOf(n) + (String(n.dir || '').trim() ? '' : '（跟随项目文件夹）') : '')
          + (f ? '\n生成的文件名：' + f + (flowFmtExt(n, k) ? '.' + flowFmtExt(n, k) : '') + '（格式：' + (String(n.format || '').trim() || '默认') + '）' : '\n⚠ 还没填生成的文件名（右键编辑 → 「生成的文件名」）')
      };
    }
    // ★2026-09-27 卡片改版（顺手修的一处"卡片在说假话"）★
    //   节点自己没填路径时，**退回类型表里那个默认目标**（工具类都有：剪映/OBS=桌面快捷方式、控制台/工作台=本机地址）。
    //   为什么必须退回：① 建节点时 addNode 本来就把 `t.path || t.url` 抄到节点上了，老图/模板里常见是空的；
    //   ② 双击（nodeTypeOpen）走的**就是这个兜底** ⇒ 卡片写"未设程序"、双击却能打开，两处自相矛盾。
    //   ⚠ 只影响"节点空 + 类型有默认"的那几种（剪映/OBS/控制台/工作台）；产物节点没有类型级 path，行为一个没变。
    const nPath = String(n.path || '').trim() || String(k.path || k.url || '').trim();
    if (nPath === '') {
      return net
        ? { dot: '●', cls: 'err', live: true, has: true, text: '没填地址（右键编辑）', tip: '地址：' + (k.url || '（还没填）') }
        : { dot: '·', cls: 'none', has: false, text: k.kind === 'file' ? '未设路径（右键编辑）' : '未设程序（右键编辑）', tip: '目标：（还没填）' };
    }
    if (net) {
      // 探哪个口：优先按节点自己填的地址算（用户改了地址就得探新的），算不出来才用类型的默认口
      const pp = flowUrlPort(nPath) || k.probe;
      const s = netStat[pp.host + ':' + pp.port];
      if (!s) return { dot: '●', cls: 'wait', live: true, has: true, text: '正在看端口 ' + pp.port + '…', tip: '地址：' + nPath };
      if (s.noApi) return { dot: '●', cls: 'wait', live: true, has: true, text: '要重启一次 GUI 才能看状态', tip: '地址：' + nPath };
      return {
        dot: '●', cls: s.open ? 'ok' : 'err', live: true, has: true,
        text: (s.open ? '在跑' : '没运作') + '（端口 ' + pp.port + '）',
        tip: '地址：' + nPath + '\n端口 ' + pp.port + '：' + (s.open ? '通（在跑）' : '不通（没运作）')
      };
    }
    const stt = pathStat[nPath];
    return {
      dot: !stt ? '…' : (stt.exists && !stt.isDir ? '✓' : '⚠'),
      cls: !stt ? 'wait' : (stt.exists && !stt.isDir ? ' ok' : ' bad'),
      has: true,
      text: flowPathParts(nPath).file,
      tip: (k.kind === 'app' ? '程序：' : '文件：') + nPath
        + (String(n.path || '').trim() ? '' : '（节点没填，用的是类型默认目标）')
        + (stt ? (stt.exists ? (stt.isDir ? '\n⚠ 这是个文件夹' : '\n✓ 在，' + fmtSize(stt.size || 0)) : '\n⚠ 找不到') : '')
    };
  }
  const toWorld = (cx, cy) => {
    const r = viewport.getBoundingClientRect();
    return { x: (cx - r.left - view.x) / view.k, y: (cy - r.top - view.y) / view.k };
  };
  // 拖动期间才挂 window 监听（不拖动就一个监听都没有，避免长驻监听互相打架）
  function bindDrag() {
    window.addEventListener('mousemove', onDragMove);
    window.addEventListener('mouseup', onDragUp);
  }
  function unbindDrag() {
    window.removeEventListener('mousemove', onDragMove);
    window.removeEventListener('mouseup', onDragUp);
  }
  function onDragMove(ev) {
    if (dragMove) {
      const dx = (ev.clientX - dragMove.mx) / view.k, dy = (ev.clientY - dragMove.my) / view.k;
      if (!dragMove.moved && Math.abs(dx) + Math.abs(dy) < 1.5) return;   // 手抖不算拖动
      dragMove.moved = true;
      dragMove.n.x = Math.round(dragMove.x0 + dx);
      dragMove.n.y = Math.round(dragMove.y0 + dy);
      const d = nodeEls[dragMove.n.id];
      // 位移 = 起手记下的逻辑坐标 + 鼠标位移（统一除以画布缩放），**直接写 left/top**：
      //   跟 render() 同一个属性、同一个数据来源 ⇒ 谁后写都是同一个值，不会互相打架。
      //   ⚠ 这里绝不碰 transform（那是悬浮动效的地盘；改前两边一起写，松手/移开就会跳回去）。
      if (d) { d.style.left = dragMove.n.x + 'px'; d.style.top = dragMove.n.y + 'px'; }
      drawWires();
    } else if (dragPan) {
      view.x = dragPan.vx + (ev.clientX - dragPan.mx);
      view.y = dragPan.vy + (ev.clientY - dragPan.my);
      applyView();
    } else if (dragWire) {
      const a = nodeById(dragWire.from);
      const d = nodeEls[dragWire.from];
      if (!a || !d) return;
      const s = nodeSize(dragWire.from);
      // 拖着的那头：从这个节点的"出发面"长出去（从下口拖就从下面长）
      const p1 = flowScreen(flowAnchor(a, s, dragWire.side), view);
      const t = toWorld(ev.clientX, ev.clientY);
      // 另一头跟着鼠标：方向给 0，贝塞尔就自然收在指针上
      const p2 = { x: t.x * view.k + view.x, y: t.y * view.k + view.y, dx: 0, dy: 0 };
      tempWire.setAttribute('d', flowWireD(p1, p2));
      // 悬停高亮目标节点的接线口（四面都要亮，不再是只亮左口）
      const over = hitTest(ev.clientX, ev.clientY);
      Object.keys(nodeEls).forEach(id => {
        const hot = !!(over && over.id === id && id !== dragWire.from);
        nodeEls[id].querySelectorAll('.flow-port').forEach(sp => {
          sp.classList.toggle('hot', hot && (!over.side || sp.dataset.side === over.side));
        });
      });
    }
  }
  function onDragUp(ev) {
    if (dragMove) {
      // 收尾：摘 .dragging 的同时把"按住之前那一刻的悬浮抬起"也一起清掉。
      //   不清的话：mouseenter 早先写下的 translateY(-2px) 一直留在内联样式里，
      //   摘掉 .dragging 的一瞬间它会重新生效 ⇒ 松手时卡片弹起 2px（肉眼可见的小跳）。
      //   松手后卡片就平贴在拖到的位置；指针移开再悬停回来，悬浮动效照旧（见 bindNodeHover）。
      const d0 = nodeEls[dragMove.n.id];
      if (d0) { d0.classList.remove('dragging'); d0.classList.remove('hover'); d0.style.transform = d0.dataset.tf || ''; }
      if (dragMove.moved) save();
      dragMove = null;
    } else if (dragPan) {
      dragPan = null;
    } else if (dragWire) {
      const hit = hitTest(ev.clientX, ev.clientY);
      const from = dragWire.from, fSide = dragWire.side;
      dragWire = null;
      tempWire.style.display = 'none';
      Object.keys(nodeEls).forEach(id => {
        nodeEls[id].querySelectorAll('.flow-port').forEach(sp => sp.classList.remove('hot'));
      });
      const target = hit ? hit.id : null;
      if (target && target !== from) {
        const dup = g.edges.some(e => e.from === from && e.to === target);
        if (dup) say('这两个节点已经连过了');
        else {
          // 落在哪个口就从哪个口进；落在节点身上（没对准口）就按两边相对位置自动选面
          // ⚠ 自动选面只在"目标类型真有的口"里挑（flowEdgeSides 的第三个参数）——
          //   工具/方式类只有上下口，老算法会把线落到它的左边，箭头贴在一条没有口的边上，像坏了。
          const a = nodeById(from), b = nodeById(target);
          const auto = flowEdgeSides(a, nodeSize(from), b, nodeSize(target), flowType(b.type));
          const ts = hit.side || auto.ts;
          // ★落点自动定线型★（右口=主线 / 下口=方式 / 上口=依据）+ 把用户的这回手势**记进边**：
          //   这是"用户刚画的一条线"，不是对老图的推断 ⇒ 写进 localStorage 是应该的（推断才不许写回）。
          const kind = flowKindFromSide(ts);
          const e = { id: 'e' + Date.now().toString(36) + (seq++), from: from, to: target, fs: fSide || auto.fs, ts: ts, kind: kind };
          g.edges.push(e);
          save(); render();
          say('已连线 → ' + ((nodeById(target) || {}).name || '节点') + '（' + flowWireName(kind) + '线）');
          // 判完弹一个小气泡让人一键改成另两种（用户："判完弹一个小气泡让我一键改成另两种"）。
          //   气泡里点过 = 用户说了算 ⇒ 写进 e.kind；不点它就一直用落点判出来的那个。
          showKindBubble(ev.clientX, ev.clientY, e, b);
        }
      }
    }
    unbindDrag();
  }
  // 鼠标底下是哪个节点、压在哪个接线口上（压不到口就 side=''）
  function hitTest(cx, cy) {
    try {
      const e = document.elementFromPoint(cx, cy);
      if (!e || !e.closest) return null;
      const n = e.closest('.flow-node');
      if (!n) return null;
      const sp = e.classList && e.classList.contains('flow-port') ? e : e.closest('.flow-port');
      const m = sp ? /flow-port-([lrtb])\b/.exec(sp.className || '') : null;
      return { id: n.dataset.id, side: m ? m[1] : '' };
    } catch (err) { return null; }
  }
  function nodeUnder(cx, cy) {
    const h = hitTest(cx, cy);
    return h ? h.id : null;
  }
  // ---- 端口状态：控制台/工作台这类"本机网页"节点，定时看端口通不通 ----
  // 为什么要有它：用户点名"运行的时候加一个绿点表示状态，红点是未运作"。工作流在 ComfyUI 那边跑，
  // 宿主看不到它的内部状态，但"这个服务起没起"完全能看出来 —— 端口连得上就是绿的。
  // 一轮一个口最多探一次（去重），一轮没探完不发下一轮（netBusy），面板销毁时把定时器清掉。
  function netTargets() {
    const out = [];
    g.nodes.forEach(n => {
      const k = flowType(n.type);
      if (k.kind !== 'url' || !k.probe || !n.path) return;
      const pp = flowUrlPort(n.path) || k.probe;
      const key = pp.host + ':' + pp.port;
      if (out.indexOf(key) < 0) out.push(key);
    });
    return out;
  }
  async function pollNet() {
    const list = netTargets();
    if (!list.length || netBusy || disposed) return 0;
    const N = window.app && window.app.net;
    if (!N || !N.probe) {   // 主进程还是旧的（没重启过 GUI）：老实说，别假装是红的
      list.forEach(key => { netStat[key] = { open: false, noApi: true, at: Date.now() }; });
      render();
      return 0;
    }
    netBusy = true;
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const parts = list[i].split(':');
      let r = null;
      try { r = await N.probe(parts[0], Number(parts[1]), 1200); } catch (e) { r = null; }
      if (disposed) { netBusy = false; return n; }
      netStat[list[i]] = { open: !!(r && r.open), at: Date.now() };
      n++;
    }
    netBusy = false;
    if (!disposed) render();
    return n;
  }
  // ---- 节点对应的"真实东西"：双击 = 摊到预览面板 / 打开软件 ----
  const revealPath = (p) => {
    const A = window.app && window.app.app;
    if (A && A.revealPath) A.revealPath(p);
  };
  function launchApp(n, k) {
    const A = window.app && window.app.app;
    const p = String(n.path || k.path || '').trim();
    if (!p) { say('这个节点还没设程序路径 —— 右键「✎ 编辑节点」填一个'); openDialog(n); return; }
    if (!A || !A.openPath) { say('打不开：这台 GUI 还没重启过（宿主接口是新的）'); return; }
    A.openPath(p);
    say('已打开：' + flowPathParts(p).file + '（不做预览，它只是流程里的一环）');
  }
  // ---- 网页版 AI 节点（kind:'webai'）：双击 = 打开顶栏那排图标背后的同一个浮动窗口 ----
  // 为什么"复用顶栏那一个函数"而不是在画布这节另写一份：那个窗口连 webview 分区/登录态/释放内存
  // 都在顶栏那一节里管着，画布再建一份就是两套登录态、两份 guest 内存。所以顶栏那节在函数定义完
  // 之后**导出了一行** `window.__kunWebAiOpen`（见本文件 WEB_AI 那节末尾的注释），这里只调它。
  function openWebAi(n, k) {
    const key = String(k.webaiKey || '');
    const open = window.__kunWebAiOpen;
    if (typeof open !== 'function') {
      // 别静默失败：用户看到这句话就知道点一下标题栏的 ⟳ 就好（不需要重启 GUI）
      say('打不开：顶栏那套网页版窗口还没挂上（点一下标题栏的 ⟳ 重跑渲染器就好）');
      return;
    }
    let ok = false;
    try { ok = open(key, true) !== false; } catch (e) { ok = false; }
    if (!ok) { say('打不开：顶栏站点表里没有「' + key + '」这个 key（类型表里 webaiKey 要和 WEB_AI 一致）'); return; }
    // forceShow=true：已经开着就只是提到最前面，不会把它收起来（用户说的是"双击打开"）
    say('已打开「' + (n.name || k.name) + '」网页版窗口（同一个登录态，不花 API token）');
  }
  function nodeTypeOpen(n) {
    const k = flowType(n.type);
    if (k.kind === 'webai') { openWebAi(n, k); return; }   // 5 个免费网页版 AI：打开顶栏那个同款窗口
    if (k.kind === 'app') { launchApp(n, k); return; }     // 剪映 / OBS：直接开软件
    // ★2026-09-26★ 项目文件夹（kind:'dir'）：双击 = **直接用资源管理器打开这个文件夹**
    //   （不是"摊到预览面板"—— 文件夹在预览面板里没有意义）。排在下面那道"没填路径"检查**前面**，
    //   因为它要自己说清"这一栏该填文件夹、不是文件"。
    if (k.kind === 'dir') {
      const dp = String(n.path || '').trim();
      if (!dp) { say('这个项目文件夹节点还没填路径 —— 右键「✎ 编辑节点」填一个（写到**文件夹本身**，例：<资料库>'); openDialog(n); return; }
      // ★2026-09-26★ 用户点名："项目文件夹双击在预览里显示，内容文件视频和图片都要显示出来，
      //   然后双击具体的图片或者视频要播放展示" ⇒ **优先摊到预览面板**（列出文件夹内容、图片/视频带缩略图、
      //   双击就在面板里看/播）；这个场景没有预览面板时，才退回"直接用资源管理器打开"。
      const VP = flowFindView(previewId);
      if (VP) {
        VP.show({ kind: 'dir', path: dp, title: n.name || k.name, from: '流程画布' });
        say('预览面板里摊开这个文件夹：' + dp);
        return;
      }
      const A = window.app && window.app.app;
      if (A && A.openPath) { A.openPath(dp); say('这个场景没有预览面板 ⇒ 已用资源管理器打开：' + dp); return; }
      say('打不开：这个场景没有预览面板，宿主也没有打开能力');
      return;
    }
    // 固定流程预设**排在"没填路径"那道检查前面**：它本来就没有路径，
    //   放到后面就会先被"还没填文件路径"拦下来（这个顺序踩过一次，别再换回来）。
    if (k.kind === 'preset') {
      const VP = flowFindView(previewId);
      if (!VP) { say('这个场景里没有预览面板（场景 json 里给画布配 viewPanel 指过去）'); return; }
      openPreset(n, k, VP);
      return;
    }
    const p = String(n.path || '').trim();
    if (!p) {
      // ★2026-09-26：待生成的节点**故意**没有路径（要等生成出来才有）—— 别再说"还没填文件路径"（那句话是错的），
      //   直接说清楚"怎么才能预览到它"（用户点名要给 html 方式节点加"待生成"+可预览）。
      if (String(n.mode || '').trim() === FLOW_MODE_GEN) {
        say('这个节点是「待生成」：现在还没有文件可预览 —— 生成好之后把素材性质改回「' + FLOW_MODE_REF + '」并填上路径，就能双击预览');
        openDialog(n);
        return;
      }
      say(k.kind === 'url' ? '这个节点还没填地址 —— 右键「✎ 编辑节点」' : '这个节点还没填文件路径 —— 右键「✎ 编辑节点」填一个');
      openDialog(n);
      return;
    }
    const V = flowFindView(previewId);
    if (!V) { say('这个场景里没有预览面板（场景 json 里给画布配 viewPanel 指过去）'); return; }
    if (k.kind === 'url') {
      // 控制台 / 工作台：把网页摊到预览面板（在那儿看状态、跑工作流）
      pollNet();   // 顺手刷一下状态，双击后就该看到最新的点
      V.show({ url: p, title: n.name || k.name, kind: 'web', from: '流程画布' });
      say('预览面板里打开：' + (n.name || k.name));
      return;
    }
    V.show({ path: p, title: n.name || '', from: '流程画布' });
  }
  // 固定流程预设（kind:'preset'）：没有文件、没有地址，双击 = 把"这套做法"摊到预览面板。
  //   两种预览形式（节点上的 preview 字段，弹框里能选）：
  //     'text'   → **只读文字说明**（用 view 渲染器里最薄的那条"没有路径的 kind:'text'"支线）
  //     'canvas' → 一张**只读的静态小流程图**（renderers.view 里 kind:'preset' 那段，小方块 + 箭头）
  //   ⚠ 那张小图是预览、不是可编辑画布（要改就右键编辑这个节点的步骤）—— 用户明确要的是"看"。
  function openPreset(n, k, V) {
    const steps = flowPresetSteps(n.steps);
    const prompt = String(n.prompt || '').trim();
    const title = n.name || k.newName;
    if (String(n.preview || 'text') === 'canvas') {
      V.show({ kind: 'preset', steps: steps, prompt: prompt, title: title, from: '流程画布' });
    } else {
      const lines = [];
      steps.forEach((s, i) => lines.push((i + 1) + '. ' + s));
      if (prompt) { lines.push(''); lines.push('指令模板：'); lines.push(prompt); }
      if (!lines.length) lines.push('（这个预设还没写步骤 —— 右键「✎ 编辑节点」或在内置模板里挑一个）');
      V.show({
        kind: 'text', text: lines.join('\n'), title: title, from: '流程画布',
        note: '固定流程预设 · ' + steps.length + ' 步（只读：要改就右键编辑画布上这个节点）'
      });
    }
    say('预览面板里摊开：' + title + (steps.length ? '（' + steps.length + ' 步）' : ''));
  }
  // ---- 路径状态：异步查一遍（不阻塞画布），查完重画节点第三行 ----
  // 返回"这一轮真查了几个"：按钮点它好报一句实话（全都查过了就说没有要查的，别一直挂着"正在检查…"）
  async function checkPaths() {
    if (checking) { checkAgain = true; return -1; }
    const want = [];
    // 只查"文件类"的节点：控制台/工作台填的是网址（拿去 stat 一定报"找不到"），
    // 它们的状态走端口探测（netStat / pollNet）
    g.nodes.forEach(n => {
      const k = flowType(n.type);
      if (!n.path || k.kind === 'url' || pathStat[n.path] || want.indexOf(n.path) >= 0) return;
      want.push(n.path);
    });
    if (!want.length) return 0;
    checking = true;
    const F = window.app && window.app.file;
    if (!F || !F.stat) { want.forEach(p => { pathStat[p] = { exists: false, size: 0, noApi: true }; }); checking = false; render(); return want.length; }
    for (let i = 0; i < want.length; i++) {
      try {
        const r = await F.stat(want[i]);
        pathStat[want[i]] = { exists: !!r.exists, size: r.size || 0, isDir: !!r.isDir };
      } catch (e) { pathStat[want[i]] = { exists: false, size: 0 }; }
    }
    checking = false;
    if (!disposed) render();
    // 查的当儿又有人存了新路径（连着重填两个节点就会这样）⇒ 立刻补一轮。
    //   不补的话：后存的那个节点第三行永远是"…"、图片/视频也不出缩略图，用户只能去点 ⟳ 状态才看见
    //   —— 这正是本批"卡片要生动、状态要准"最容易被忽略的一环。
    if (checkAgain) {
      checkAgain = false;
      const more = await checkPaths();
      if (more > 0) return want.length + more;
    }
    return want.length;
  }
  // ★2026-09-26★ 待生成节点的**完成指示灯**（用户点名："每个节点带一个指示灯，完成好就是显示绿色、
  //   并改变内容为已有素材、然后自动定位文件"）：
  //   每 4 秒拿 `flowGenFull` 算出的目标路径去 stat 一次；文件一出现 ⇒ ① 切成「已有素材 · 参考」
  //   ② 把真实路径填进 path（双击就能预览/播放）③ 存盘 + 重画（灯自然变绿）④ 在画布上说一句。
  //   只在**真的出现**时才重画，平时完全不动界面（不会打扰拖动/连线）。
  async function checkGenDone() {
    const F = window.app && window.app.file;
    if (!F || !F.stat) return 0;
    let flipped = 0, names = [];
    for (const n of g.nodes) {
      if (String(n.mode || '').trim() !== FLOW_MODE_GEN) continue;
      const full = flowGenFull(n);
      if (!full) continue;
      let r = null;
      try { r = await F.stat(full); } catch (e) { r = null; }
      if (!r || !r.exists || r.isDir) continue;
      n.mode = FLOW_MODE_REF;      // 完成 ⇒ 素材性质自动改成「已有素材 · 参考」
      n.path = full;               // 完成 ⇒ 自动定位到这个真实文件
      flipped++;
      names.push(n.name || flowType(n.type).newName);
    }
    if (flipped) {
      save(); render(); checkPaths();
      say('✅ ' + names.join('、') + ' 已经生成 ⇒ 自动切成「' + FLOW_MODE_REF + '」并定位到文件（双击就能看/播）');
    }
    return flipped;
  }
  const genTimer = setInterval(() => { if (!disposed) checkGenDone(); }, 4000);
  // ★2026-09-26★ "正在跑"的闪烁指示（用户点名：豆包正在生成视频时，**豆包节点和那条视频节点都要闪**）。
  //   走**单独一个 running.json**（`{ids:["s1","t2"]}`），**绝不塞进 import.json** —— 那份一变就整页热重载，
  //   会把网页版窗口重挂、把正在跑的任务搞坏 ✗。这里只每 2 秒读一个小文件、给命中的节点加 `.run` 类，不动图、不重载。
  //   ★2026-09-27 改版（用户点名：「卡片左下角一个小灯 + 边框发亮就行，做得有科技感一点」）★
  //   旧那套是三处一起闪（第三行状态点闪 + 标题变黄 + 右上角一个「跑着」角标）⇒ 太吵、也不像"设备在跑"。
  //   现在只留两处**长在卡片自己身上**的表达：① 整圈边框青色呼吸发光；② 左下角一颗小灯（带一圈扩散光环 = 设备指示灯）。
  function ensureRunCss() {
    // 版本判据：点 ⟳ 只重新求值本文件、**不重建 DOM** ⇒ 旧那份 <style> 会留在 head 里；
    //   不比对版本的话，新样式永远加不进去（同 id 命中就 return 了）—— 这一步最容易漏，漏了就是"改了没变化"。
    //   ★2026-09-27 再改（用户反馈：「节点到哪里那里就闪烁，中间断了很多次」）★
    //   上一版给了三处**无限动画**（边框呼吸 + 小灯脉动 + 扩散光环）⇒ 在工作场景里看着就是"一直在闪"。
    //   现在**全部改成常亮**：灯亮着 = 在跑，靠颜色/外发光表达"科技感"，一点动画都不留（.run 类由 pollRunning 每 2 秒维持）。
    //   ★2026-09-27 三改（用户点名：「可以是呼吸闪烁」）★
    //   上一版全常亮 ⇒ 用户要"呼吸"：改成**一条 2.4 秒的平滑明暗脉动**（边框发光 + 小灯亮度/大小 + 光环扩散三处同一个节奏，
    //   ease-in-out 无限循环）。与最早那版"乱闪"的区别：**只有一个节奏、幅度收窄、绝不同步多个不同周期的动画**
    //   （那次 4 处不同周期一起动，看着就是"一直在闪、中间断了很多次"）。
    //   ⚠ `.run` 类仍由 pollRunning 每 2 秒无条件重贴 —— 重绘会重建节点 DOM、把类丢掉，这才是"灯灭掉"的真原因，跟动画无关。
    const VER = 'v4-lamp-breath';
    const old = document.getElementById('kun-flow-run-css');
    if (old && old.getAttribute('data-ver') === VER) return;
    if (old && old.parentNode) old.parentNode.removeChild(old);
    const st = document.createElement('style');
    st.id = 'kun-flow-run-css';
    st.setAttribute('data-ver', VER);
    st.textContent = [
      // 呼吸的关键帧：三处共用同一个 2.4s 节奏（只有明暗/大小在变，位置不动 ⇒ 不会"跳"）
      '@keyframes kunBreathGlow{'
        + '0%,100%{box-shadow:0 0 0 1px rgba(77,226,255,.55),0 0 10px rgba(77,226,255,.22),inset 0 0 12px rgba(77,226,255,.06),0 2px 10px rgba(0,0,0,.38);}'
        + '50%{box-shadow:0 0 0 1px rgba(77,226,255,.95),0 0 26px rgba(77,226,255,.55),inset 0 0 22px rgba(77,226,255,.16),0 2px 10px rgba(0,0,0,.38);}}',
      '@keyframes kunBreathLamp{0%,100%{opacity:.7;transform:scale(.9);}50%{opacity:1;transform:scale(1.08);}}',
      '@keyframes kunBreathRing{0%,100%{opacity:.22;transform:scale(.86);}50%{opacity:.62;transform:scale(1.14);}}',
      // 边框：青色呼吸发光（常亮的底色仍在 0% 帧里，所以"最暗的时候也是亮着的"，不会看着断掉）
      '.flow-node.run{border-color:#4de2ff !important;animation:kunBreathGlow 2.4s ease-in-out infinite;}',
      // 左下角小灯：径向渐变的灯芯（左上角高光）+ 双层外发光；半嵌在卡片角上（左/下各出框 4px），不占内容行的位置
      //   transform-origin 定在灯自己中心，缩放才像"呼吸"而不是"往右下长"
      '.flow-node.run::before{content:"";position:absolute;left:-4px;bottom:-4px;width:9px;height:9px;border-radius:50%;pointer-events:none;'
        + 'transform-origin:center;'
        + 'background:radial-gradient(circle at 35% 32%,#f2ffff 0 20%,#4de2ff 55%,#137fa6 100%);'
        + 'box-shadow:0 0 7px rgba(77,226,255,.95),0 0 16px rgba(77,226,255,.55);'
        + 'animation:kunBreathLamp 2.4s ease-in-out infinite;}',
      // 小灯外一圈细光环（设备指示灯的"灯罩"感）：跟着同一个节奏轻轻扩散/收拢
      '.flow-node.run::after{content:"";position:absolute;left:-7px;bottom:-7px;width:15px;height:15px;border-radius:50%;pointer-events:none;'
        + 'transform-origin:center;border:1px solid rgba(77,226,255,.45);'
        + 'animation:kunBreathRing 2.4s ease-in-out infinite;}',
      // 被选中的跑着节点：边框交回给"选中"那圈（--fc），只保留呼吸的青色外发光提示它还在跑
      '.flow-node.run.on{border-color:var(--fc) !important;'
        + 'animation:kunBreathGlowOn 2.4s ease-in-out infinite;}',
      '@keyframes kunBreathGlowOn{'
        + '0%,100%{box-shadow:0 0 0 1px var(--fc),0 6px 20px rgba(0,0,0,.5),0 0 10px rgba(77,226,255,.20);}'
        + '50%{box-shadow:0 0 0 1px var(--fc),0 6px 20px rgba(0,0,0,.5),0 0 20px rgba(77,226,255,.50);}}',
      // 系统里开了"减少动态效果"就退回常亮（无障碍 + 有人就是嫌动）
      '@media (prefers-reduced-motion: reduce){'
        + '.flow-node.run,.flow-node.run::before,.flow-node.run::after,.flow-node.run.on{animation:none !important;}}',
      // ---- 换步的"丝滑"收尾（★必须排在 .run 之后★：选择器权重相同，靠后者覆盖前者）----
      //   熄灭：`.run-out` 期间还在 `.run` 上，用一条 forwards 动画把三处一起淡掉（面板不上暗、只淡灯和光）
      '.flow-node.run-out{animation:kunGlowOut .4s ease-out forwards !important;}'
        + '.flow-node.run-out::before{animation:kunLampOut .4s ease-out forwards !important;}'
        + '.flow-node.run-out::after{animation:kunRingOut .4s ease-out forwards !important;}',
      '@keyframes kunGlowOut{to{box-shadow:0 0 0 1px rgba(77,226,255,0),0 0 0 rgba(77,226,255,0),inset 0 0 0 rgba(77,226,255,0),0 2px 10px rgba(0,0,0,.38);}}',
      '@keyframes kunLampOut{to{opacity:0;transform:scale(.55);}}',
      '@keyframes kunRingOut{to{opacity:0;transform:scale(1.5);}}',
    ].join('\n');
    (document.head || document.body).appendChild(st);
  }
  // ★多画布★ running.json 的路径**按当前 storeKey 现算**（以前是挂载时算死的 ⇒ 切了画布还会去读上一张的灯）。
  const runPathOf = (key) => (snapDir ? flowSnapFile(key, snapDir, 'running.json') : '');
  let runIds = [];
  async function pollRunning() {
    const F = window.app && window.app.file;
    const runPath = runPathOf(storeKey);
    if (!runPath || !F || !F.read) return;
    let ids = [];
    try {
      const r = await F.read(runPath);
      if (r && r.ok && r.text) { const o = JSON.parse(r.text); ids = (o && Array.isArray(o.ids)) ? o.ids.map(String) : []; }
    } catch (e) { ids = []; }
    // ⚠ 不能"ids 没变就 return"（2026-09-27 修）：画布重绘（导入 / 切面板 / 热重载）会把节点 DOM 重建一次，
    //   那一刻 `.run` 就没了，而 ids 没变 ⇒ 灯**再也不会亮回来**，用户看到的就是"断了很多次"。
    //   代价只是每 2 秒给十几个节点 toggle 一次 class，可忽略。
    runIds = ids;
    // 🔍 诊断心跳（临时）：轮询每次都会写这个小文件 —— 用来远程确认"这个画布实例的轮询到底跑没跑"。
    //   看到它一直在更新 = 轮询活着（那问题在贴类/样式）；一直不出现 = 轮询没跑（得换机制）。
    try { flowSnapWrite(storeKey, snapDir, 'beat.json', String(Date.now()) + ' ids=' + ids.join(',')); } catch (e) { /* ignore */ }
    // 名单也塞进图里（g.running）：这样下一次重绘（导入/切场景/热重载）能直接把灯带上，
    // 不依赖"这个面板实例的轮询还活着"（用户 2026-09-27：灯必须跟着执行步骤走）。
    try { g.running = ids; } catch (e) { /* ignore */ }
    ensureRunCss();
    // 样式到底进没进去 —— 决定要不要补一层静态内联发光（进去了就**纯 CSS 呼吸**，别用内联压住动画）
    const cssOk = !!document.getElementById('kun-flow-run-css');
    if (!ids.length) {
      // 全清：也走下面的渐隐，不要"啪一下全黑"
    }
    // ★2026-09-27 用户点名：「要实时对应，节点完成换节点要丝滑」★
    //   丝滑 = 旧节点**渐隐**、新节点**同时**接管，中间不许出现"两边都没灯"的空档。
    //   做法：熄灭不直接摘 `.run`，先挂 `.run-out`（CSS 里 400ms 渐隐，见 ensureRunCss），等它放完再摘；
    //   若这当中它又被点亮（下一轮 0.6s 内），立刻撤掉 `.run-out` 继续呼吸 ⇒ 连续换步看着是一口气交接。
    g.nodes.forEach((n) => {
      const el2 = document.querySelector('.flow-node[data-id="' + n.id + '"]');
      if (!el2) return;
      const on = ids.indexOf(String(n.id)) >= 0;
      const was = el2.classList.contains('run');
      if (on) {
        if (!was || el2.classList.contains('run-out')) { el2.classList.remove('run-out'); el2.classList.add('run'); }
        // ★简单 + 稳（用户 2026-09-27：「光效可以简单一点，保证稳定」）★
        //   只做一件事：给卡挂 `.run`，动画全在 CSS 里（呼吸）；**不再写内联样式** ——
        //   上一版内联 box-shadow 反而压住了动画，看着就是"只闪一下然后一直亮着"。
        //   唯一的兜底：万一样式没注入成功（cssOk=false），才补一层静态内联发光，保证"至少看得出哪步在跑"。
        if (!cssOk) {
          try {
            el2.style.borderColor = '#4de2ff';
            el2.style.boxShadow = '0 0 0 2px rgba(77,226,255,.85), 0 0 18px rgba(77,226,255,.45)';
          } catch (e) { /* ignore */ }
        } else if (el2.style.boxShadow) { el2.style.borderColor = ''; el2.style.boxShadow = ''; }
      } else if (was && !el2.classList.contains('run-out')) {
        el2.classList.add('run-out');
        el2.__runT = setTimeout(() => {
          try { el2.classList.remove('run', 'run-out'); el2.style.borderColor = ''; el2.style.boxShadow = ''; } catch (e) { /* ignore */ }
        }, 420);
      }
    });
  }
  // 0.6 秒一轮：用户要"实时对应"（原来是 2 秒 ⇒ 换步时肉眼能看出滞后）。
  //   代价 = 每秒不到两次小文件读，可忽略；DOM 只在**状态真变**时才动（上面那圈判断），所以不会把卡片刷花。
  const runTimer = setInterval(() => { if (!disposed) pollRunning(); }, 600);
  setTimeout(() => { if (!disposed) pollRunning(); }, 120);
  const fmtSize = (n) => (n < 1024 ? n + ' B' : (n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB'));

  // ---- 右键菜单 / 「＋ …节点 ▾」下拉（同一套渲染，节点菜单、空白菜单、三类添加菜单都走它）----
  let menuEl = null;
  function closeMenu() { if (menuEl && menuEl.parentNode) menuEl.parentNode.removeChild(menuEl); menuEl = null; }
  // 菜单项 = 图标（有官网图标就放图，否则单字）+ 名字 + 一句 tip（tip 直接取类型表的 `tip`，不另写一份）。
  // 结构：第一行「图标 名字」，tip 换行缩进在下面（flex-wrap + flex:0 0 100%）。
  function menuItem(it) {
    const b = el('button', 'flow-menu-item' + (it.danger ? ' danger' : '') + (it.off ? ' off' : ''), '');
    b.type = 'button';
    if (it.img || it.icon) {
      const ic = el('span', 'flow-menu-ic', '');
      flowIconInto(ic, { img: it.img, icon: it.icon }, 'flow-menu-img');
      b.appendChild(ic);
    }
    b.appendChild(el('span', 'flow-menu-text', it.label));
    if (it.tip) { b.appendChild(el('span', 'flow-menu-tip', it.tip)); b.title = it.tip; }
    if (it.off) b.disabled = true;
    else b.addEventListener('click', () => { closeMenu(); it.run(); });
    return b;
  }
  function showMenu(cx, cy, items) {
    closeMenu();
    const m = el('div', 'flow-menu');
    items.forEach(it => {
      if (it.sep) { m.appendChild(el('div', 'flow-menu-sep', '')); return; }
      // 分组小标题：不是按钮、点不动，只是给这一摞选项起个名（空白右键菜单按三类分组时用）。
      if (it.group) {
        const gi = el('div', 'flow-menu-group', it.group);
        gi.style.cssText = 'padding:5px 9px 2px;font-size:10px;font-weight:700;letter-spacing:.4px;'
          + 'color:var(--text-dim);opacity:.85;cursor:default;';
        if (it.title) gi.title = it.title;
        m.appendChild(gi);
        return;
      }
      m.appendChild(menuItem(it));
    });
    viewport.appendChild(m);
    // ★"能上下滑动 + 不能超出可视区"（用户 2026-09-21 点名的第二件事）★
    // ① 先定高度上限：46vh 与"面板本身多高"取小。8 项的工具菜单在矮面板里靠它**变成可滚动**，
    //    而不是把下面几项顶到 .flow-viewport 外面 —— 那一层是 overflow:hidden，溢出的项**既看不见也点不着**。
    // ② 再摆位：默认贴着触发点往下；**下方放不下就向上弹**（工具栏在面板最下面一行时也能完整操作）；
    //    上下都不够（面板很矮）就夹在视口里，并把高度收到真正可用的大小，剩下的交给滚动条。
    // 内联写 max-height/overflow-y（而不是只靠 styles.css）：这样"能不能滚""会不会出界"跟样式表加载无关，
    //   离屏自检读内联样式也能验证（styles.css 末尾另有一份同口径的规则，负责滚动条外观）。
    const r = viewport.getBoundingClientRect();
    const capH = Math.max(90, Math.min(Math.round((window.innerHeight || 800) * 0.46), Math.round(r.height - 8)));
    m.style.maxHeight = capH + 'px';
    m.style.overflowY = 'auto';
    m.style.overscrollBehavior = 'contain';   // 滚到菜单尽头别把画布/整页跟着滚
    let left = Math.max(4, Math.min(cx - r.left, r.width - m.offsetWidth - 6));
    let top = cy - r.top;
    const mh = m.offsetHeight;
    if (top + mh + 6 > r.height && top - mh - 2 >= 4) top = top - mh - 2;   // ← 向上弹
    if (top + mh + 6 > r.height) {                                          // 上下都不够：夹住 + 再收高度
      top = 4;
      m.style.maxHeight = Math.max(90, Math.round(r.height - 10)) + 'px';
    }
    top = Math.max(4, Math.min(top, Math.max(4, r.height - m.offsetHeight - 6)));
    m.style.left = Math.round(left) + 'px';
    m.style.top = Math.round(top) + 'px';
    menuEl = m;
  }
  function nodeMenu(n) {
    const t = flowType(n.type);
    const items = [{ label: '✎ 编辑节点…', run: () => openDialog(n) }];
    if (t.kind === 'webai') {
      // 网页版 AI 节点没有预览、也没有软件路径：右键只给"打开那个窗口"和"去顶栏那边找"
      items.push({ label: '🌐 打开网页版窗口', run: () => nodeTypeOpen(n) });
      items.push({ label: '⤴ 顶栏也有同一个图标', off: true, run: () => {} });
    } else if (t.kind === 'preset') {
      // 固定流程预设：也没有文件/地址 —— 右键只给"摊开这套做法"（双击同效）
      items.push({ label: '📋 摊开这套做法（预览）', run: () => nodeTypeOpen(n) });
      items.push({ label: '🧩 换一个内置模板…', run: () => openDialog(n) });
    } else if (t.kind === 'url') {
      items.push({ label: '🌐 在预览里打开', off: !n.path, run: () => nodeTypeOpen(n) });
      items.push({ label: '🔄 重新看状态', run: () => { pollNet(); say('正在看端口…'); } });
    } else if (t.kind === 'app') {
      items.push({ label: '🖥 打开软件', off: !n.path, run: () => nodeTypeOpen(n) });
      items.push({ label: '📂 定位到文件夹', off: !n.path, run: () => revealPath(n.path) });
    } else {
      items.push({ label: '📄 在预览里打开', off: !n.path, run: () => nodeTypeOpen(n) });
      items.push({ label: '📂 定位到文件夹', off: !n.path, run: () => revealPath(n.path) });
    }
    items.push({ sep: true });
    items.push({ label: '🗑 删除节点', danger: true, run: () => { sel = { type: 'node', id: n.id }; render(); removeSel(); } });
    return items;
  }
  // 一条线的右键菜单（用户要的"右键连线可以改类型或删除"）：
  //   三型各一项（当前那一型前面打 ✓），点一下就改 + 立刻存盘重画；下面是删除。
  //   为什么把当前型也列出来（而不是只列另两型）：一眼能看出"这条线现在算哪一型"，
  //   尤其是老图（没有 kind 字段）—— 那个型是推断出来的，菜单里直接写明白。
  function edgeMenu(e, kind, a, b) {
    const nm = (x) => (x && (x.name || flowType(x.type).name)) || '？';
    const items = [{
      group: '这条线：' + nm(a) + ' → ' + nm(b),
      title: '现在按「' + flowWireName(kind) + '」画' + (e.kind ? '' : '（老图没记线型，这是按两端节点推断的；点一下就会记下来）')
    }];
    FLOW_WIRES.forEach(w => {
      const cur = w.id === kind;
      items.push({
        label: (cur ? '✓ ' : '　') + w.name + '线',
        icon: w.id === 'seq' ? '━' : (w.id === 'how' ? '─' : '┄'),
        off: false,
        tip: w.hint + (cur ? '\n（现在就是这一型）' : '\n点一下 = 把这条线改成' + w.name + '线'),
        run: () => {
          e.kind = w.id;
          save(); render();
          say('这条线现在是「' + w.name + '」线');
        }
      });
    });
    items.push({ sep: true });
    items.push({
      label: '🗑 删除这条线', danger: true, icon: '✕',
      tip: nm(a) + ' → ' + nm(b),
      run: () => { g.edges = g.edges.filter(x => x !== e); if (sel && sel.type === 'edge' && sel.id === e.id) sel = null; save(); render(); say('删掉一条线'); }
    });
    return items;
  }
  // 刚连完一条线冒出来的小气泡（用户："判完弹一个小气泡让我一键改成另两种"）。
  //   三个键 = 三种线型（当前那一型高亮）；就地出现在松手的位置旁边（眼睛和手都还在那儿）。
  //   关掉的时机：点了某一型 / 点画布别处 / Esc / 8 秒没人理（免得一直挂在图上）。
  function closeBubble() {
    if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null; }
    if (bubbleEl && bubbleEl.parentNode) bubbleEl.parentNode.removeChild(bubbleEl);
    bubbleEl = null;
  }
  function showKindBubble(cx, cy, e, b) {
    closeBubble();
    const box = el('div', 'flow-kind-bubble', '');
    box.style.cssText = 'position:absolute;z-index:7;display:flex;align-items:center;gap:4px;padding:4px 6px;'
      + 'border:1px solid var(--border);border-radius:8px;background:var(--bg-panel,#141a26);'
      + 'box-shadow:0 6px 18px rgba(0,0,0,.4);font-size:10.5px;color:var(--text-dim);white-space:nowrap;';
    const lb = el('span', '', '线型');
    lb.style.cssText = 'padding:0 2px;';
    box.appendChild(lb);
    FLOW_WIRES.forEach(w => {
      const cur = w.id === flowWireKind(e, nodeById(e.from), b);
      const bt = mkBtn(w.name, w.hint);
      bt.dataset.kind = w.id;                    // 探针/自检认得出的抓手
      bt.style.cssText = 'padding:2px 7px;font-size:10.5px;'
        + (cur ? 'border-color:' + flowWireStyle(w.id).color + ';color:' + flowWireStyle(w.id).color + ';font-weight:700;' : '');
      bt.addEventListener('click', () => {
        e.kind = w.id;
        save(); render(); closeBubble();
        say('这条线改成「' + w.name + '」线（右键任意一条线都能再改）');
      });
      box.appendChild(bt);
    });
    const x = el('button', 'file-refresh', '✕');
    x.type = 'button'; x.title = '就这样（不再改）';
    x.style.cssText = 'padding:2px 6px;font-size:10.5px;';
    x.addEventListener('click', closeBubble);
    box.appendChild(x);
    viewport.appendChild(box);
    // 摆位：默认贴在松手处右下，出界就翻到另一侧（跟菜单一个口径，别顶出可视区）
    const r = viewport.getBoundingClientRect();
    const bw = box.offsetWidth || 190, bh = box.offsetHeight || 24;
    let left = cx - r.left + 8, top = cy - r.top + 10;
    if (left + bw + 6 > r.width) left = Math.max(4, cx - r.left - bw - 8);
    if (top + bh + 6 > r.height) top = Math.max(4, cy - r.top - bh - 8);
    box.style.left = Math.round(Math.max(4, left)) + 'px';
    box.style.top = Math.round(Math.max(4, top)) + 'px';
    bubbleEl = box;
    bubbleTimer = setTimeout(() => { bubbleTimer = null; closeBubble(); }, 8000);
  }
  // 新节点落在哪儿：**不传坐标就用当前可视区的中间**（用户点的："点一下就按该类型在当前画布可视区域中间建节点"）。
  // 为什么要现算而不是在"打开菜单"那一刻算：菜单可能开着一会儿（用户还在挑），
  //   期间画布被平移/缩放了的话，按老坐标落点就跑到可视区外面去了。
  function addSpot(wx, wy) {
    if (wx != null && wy != null) return { x: wx, y: wy };
    const vp = viewport.getBoundingClientRect();
    return toWorld(vp.left + vp.width / 2 - 95, vp.top + vp.height / 2 - 30);   // 减半张卡片 ≈ 落在正中
  }
  // 某一类的类型清单（三个「＋ …节点 ▾」各用各的；空白右键菜单把三类拼在一起）。
  // 每项 = 图标（官网图标优先）+ 名字 + 一句 tip（tip 就是类型表里的 `tip`，不在菜单里另写一份说明）。
  function typeItems(c, wx, wy) {
    const mk = (t) => ({
      label: t.name + (t.kind === 'webai' ? '（免费网页版）' : ''),
      icon: t.icon, img: t.img, tip: t.tip,
      run: () => { const p = addSpot(wx, wy); addNode(t.id, p.x, p.y); }
    });
    const list = flowTypesOfCat(c.id);
    // 防御：万一某一类一个类型都没有（现在不可能），也别给一个空菜单 —— 按兜底类型（FLOW_TYPES[0]）建
    return list.length ? list.map(mk) : [mk(FLOW_TYPES[0])];
  }
  // 点「＋ X节点 ▾」= 在按钮正下方弹出**只有这一类**的清单（三个菜单互斥：showMenu 会先 closeMenu）
  function openAddMenu(c, btn) {
    const r = btn.getBoundingClientRect();
    if (!flowTypesOfCat(c.id).length) {
      const p = addSpot();
      addNode(FLOW_TYPES[0].id, p.x, p.y);
      say('「' + c.name + '」这一类暂时是空的 —— 按兜底类型「' + FLOW_TYPES[0].name + '」建了一个');
      return;
    }
    showMenu(r.left + 6, r.bottom + 2, typeItems(c));
  }
  // 空白右键的菜单：三类各起一个小标题（跟工具栏三个入口同一份数据、同一个分组顺序）
  function typeMenu(wx, wy) {
    const out = [];
    FLOW_CATS.forEach(c => {
      const list = flowTypesOfCat(c.id);
      if (!list.length) return;
      out.push({ group: c.name + '（' + list.length + '）', title: c.name + '：' + c.hint });
      typeItems(c, wx, wy).forEach(it => out.push(it));
    });
    return out;
  }
  function blankMenu(wx, wy) {
    return typeMenu(wx, wy).concat([
      { sep: true },
      { label: '⤢ 适应窗口', run: fit },
      { label: '⧉ 复制成 Markdown', run: () => exportText('md') }
    ]);
  }

  // ---- 编辑节点弹框（所有类型都有 名称 / 描述；"有真实目标"的再多一个 路径/地址/程序 栏；
  //      其余栏全由类型表声明：texts 多行 / pick 现算下拉 / selects 固定下拉 / nums 数字 / tpl 内置模板）----
  let dlgEl = null;
  function closeDialog() { if (dlgEl && dlgEl.parentNode) dlgEl.parentNode.removeChild(dlgEl); dlgEl = null; }
  function openDialog(n, isNew) {
    closeDialog();
    const t = flowType(n.type);
    const box = el('div', 'flow-dlg');
    const card = el('div', 'flow-dlg-box');
    card.appendChild(el('div', 'flow-dlg-title', '编辑节点 · ' + t.name + (isNew ? '（新）' : '')));
    const mkRow = (label, hint) => {
      const row = el('div', 'flow-dlg-row');
      row.appendChild(el('label', 'flow-dlg-label', label));
      const inp = el('input', 'flow-dlg-input');
      inp.type = 'text'; inp.placeholder = hint || ''; inp.spellcheck = false;
      row.appendChild(inp);
      return { row: row, inp: inp };
    };
    // 前两个字段（名称 / 描述）**所有类型都一样**；第三个字段只有"有真实目标"的类型才有：
    //   文件类=「路径」（写到文件名）／网页类=「地址」（http://…）／软件类=「程序」（.exe 或 .lnk）
    //   ⚠ 两类节点**没有第三个字段**（用户点名"没有真实文件路径"）：
    //     · 网页版 AI（webai）—— 双击就是开顶栏那个窗口，填路径毫无意义（填了还会长出个假状态点）；
    //     · 固定流程预设（preset）—— 它的"内容"是步骤清单 + 指令模板，本来就不对应磁盘上的任何东西。
    // 之后还可能多出几栏，全部由类型表声明（以后加类型只改 FLOW_TYPES）：
    //   t.texts   = [{ key, label, rows, hint }]         多行文本（video 的 plot / html 的要做什么 / 工具类的 duty）
    //   t.pick    = { key, label, from }                 下拉，选项现算（⚠ 2026-09-26 起没有类型用它了：
    //                                                    video 的「用什么方式生成」已改成认连线，机制留作通用能力）
    //   t.selects = [{ key, label, options, ui }]        固定选项下拉（段落 / 用途 / 预览形式）
    //   t.nums    = [{ key, label, hint }]               数字栏（起止秒，允许只填一个）
    //   t.tpl     = { label, list:[{name,steps,prompt}] } 内置模板下拉（选中就填进 steps/prompt，之后照样能手改）
    const isUrl = t.kind === 'url', isApp = t.kind === 'app';
    const isWebAi = t.kind === 'webai', isPreset = t.kind === 'preset';
    const texts = t.texts || [], pick = t.pick || null;
    const selects = t.selects || [], nums = t.nums || [];
    // ★「素材性质」（mode）是内容节点的第一定性栏：从 selects 里拆出来、渲染在路径栏后面第一个
    //   （先定"这个素材是参考还是待生成"，再往下填别的；老图没有 mode ⇒ 下拉值为空、保存照常）。
    const modeSel = selects.filter(f => f.key === 'mode')[0] || null;
    const restSelects = selects.filter(f => f.key !== 'mode');
    // 取消时判断"改没改"：新字段一起记下来（**老图里这些字段是 undefined ⇒ 当空串**，不会因为缺字段报错）
    const before = { name: n.name || '', desc: n.desc || '', path: n.path || '' };
    texts.forEach(f => { before[f.key] = n[f.key] || ''; });
    if (pick) before[pick.key] = n[pick.key] || '';
    selects.forEach(f => { before[f.key] = n[f.key] == null ? '' : String(n[f.key]); });
    nums.forEach(f => { before[f.key] = n[f.key] == null ? '' : String(n[f.key]); });
    (t.dirs || []).forEach(f => { before[f.key] = n[f.key] || ''; });
    const r1 = mkRow('名称', t.newName);
    // ★描述（2026-09-26 用户点名）：内容节点用**大文本框**（`t.descRows`，写"要求"那一栏）；
    //   video 连这栏都不要（`t.noDesc`）⇒ r2 = null，下面每处用到 r2 的地方都先判空。
    //   ⚠ 这里**不能调 mkCol**（它定义在后面、const 有 TDZ）⇒ 就地拼一个竖排行（样式与 mkCol 一致）。
    const descRows = Number(t.descRows || 0);
    let r2 = null;
    if (descRows > 1) {
      const dRow = el('div', 'flow-dlg-row');
      dRow.style.cssText = 'flex-direction:column;align-items:stretch;gap:3px;';
      const dLb = el('label', 'flow-dlg-label', t.descLabel || '描述');
      dLb.style.cssText = 'width:auto;';
      dRow.appendChild(dLb);
      const dTa = el('textarea', 'flow-dlg-input flow-dlg-desc');
      dTa.rows = descRows;
      dTa.placeholder = t.descHint || '';
      dTa.spellcheck = false;
      dTa.style.cssText = 'flex:0 0 auto;width:100%;height:' + (18 * descRows + 14) + 'px;resize:vertical;line-height:1.5;'
        + 'font-family:var(--sans);font-size:11.5px;';
      dRow.appendChild(dTa);
      r2 = { row: dRow, inp: dTa };
    } else if (!t.noDesc) {
      r2 = mkRow('描述', '一句话说明这一步做什么（显示在节点第二行）');
    }
    const r3 = (isWebAi || isPreset) ? null : mkRow(t.pathLabel || '路径', t.pathHint || '');
    r1.inp.value = before.name;
    if (r2) r2.inp.value = before.desc;
    if (r3) r3.inp.value = before.path;
    // ★路径栏带选择按钮（2026-09-23 第十轮 + 第十一轮修正；2026-09-29 修 folder 节点）：
    //   内容节点（参考素材）= **选具体文件**（app.pickFile）；
    //   ★folder 节点（FLOW_TYPES.folder 带 kind:'dir'，路径写的是"文件夹本身"）= **选文件夹**（app.pickFolder）★
    //   —— 2026-09-29 用户报：「修复项目文件夹节点，应该是选择文件夹不是选具体文件」（原来一律挂 app.pickFile，选不到文件夹）。
    //   选中后回填到路径栏；老宿主没有对应 IPC ⇒ 按钮不显示（不崩）。
    if (r3) {
      const isDirPath = String(t.kind || '') === 'dir';
      const pkBtn = el('button', 'file-refresh flow-dlg-pick', isDirPath ? '📁 选文件夹' : '📁 选文件');
      pkBtn.type = 'button';
      pkBtn.title = isDirPath
        ? '弹出系统文件夹选择器，选中文件夹后回填（写到文件夹本身，不带文件名）'
        : '弹出系统文件选择器，选中素材文件后回填到路径栏（真实路径，不用手打）';
      pkBtn.style.cssText = 'flex:0 0 auto;margin-left:6px;font-size:11px;padding:1px 6px;';
      pkBtn.addEventListener('click', async () => {
        try {
          if (isDirPath) {
            if (!(window.app && window.app.pickFolder)) return;
            const dir = await window.app.pickFolder();
            if (dir) { r3.inp.value = dir; r3.inp.focus(); }
          } else {
            if (!(window.app && window.app.pickFile)) return;
            const p = await window.app.pickFile();
            if (p) { r3.inp.value = p; r3.inp.focus(); }
          }
        } catch (e) { /* ignore */ }
      });
      const hasPicker = isDirPath ? !!(window.app && window.app.pickFolder) : !!(window.app && window.app.pickFile);
      if (hasPicker) r3.row.appendChild(pkBtn);
    }
    // 多出来的那几栏走**竖排**（标签在上、控件在下）：会出现「情节 / 提示词」「要做什么」
    // 这种长标签，老的横排（标签固定 34px）会把输入框挤没。样式 inline，理由同 catStat（只许动本文件）。
    const mkCol = (label) => {
      const row = el('div', 'flow-dlg-row');
      row.style.cssText = 'flex-direction:column;align-items:stretch;gap:3px;';
      const lb = el('label', 'flow-dlg-label', label);
      lb.style.cssText = 'width:auto;';
      row.appendChild(lb);
      return row;
    };
    const xrows = [];   // [{ key, el, row }]：保存时按 key 写进节点对象
    // 内置模板下拉（只有声明了 tpl 的类型有，现在 = 固定流程预设）：
    // 先建好、等下面两栏建完再挂 change（change 里按 key 找到那两个 textarea 填进去）。
    // ⚠ 它自己**不是一个节点字段**（"填表助手"，不是内容）⇒ 不进 xrows、不会被存进 localStorage。
    let tplRow = null, tplSel = null;
    if (t.tpl && (t.tpl.list || []).length) {
      tplRow = mkCol(t.tpl.label || '内置模板');
      tplSel = el('select', 'flow-dlg-input flow-dlg-tpl');
      tplSel.style.cssText = 'flex:0 0 auto;width:100%;font-family:var(--sans);font-size:11.5px;';
      const op0 = el('option', '', '（不用模板，自己写）');
      op0.value = '';
      tplSel.appendChild(op0);
      t.tpl.list.forEach((tp, i) => {
        const op = el('option', '', tp.name);
        op.value = String(i);
        tplSel.appendChild(op);
      });
      tplRow.appendChild(tplSel);
      if (t.tpl.hint) tplRow.appendChild(el('div', 'flow-dlg-note', t.tpl.hint));
    }
    texts.forEach(f => {
      const row = mkCol(f.label);
      const ta = el('textarea', 'flow-dlg-input');
      ta.rows = f.rows || 3;
      ta.placeholder = f.hint || '';
      ta.spellcheck = false;
      ta.style.cssText = 'flex:0 0 auto;width:100%;height:' + (18 * (f.rows || 3) + 14) + 'px;resize:vertical;line-height:1.5;'
        + 'font-family:var(--sans);font-size:11.5px;';
      ta.value = before[f.key];
      row.appendChild(ta);
      xrows.push({ key: f.key, el: ta, row: row });
    });
    if (pick) {
      const row = mkCol(pick.label);
      // ⚠ flex:0 0 auto 必须写：`.flow-dlg-input` 自带 `flex:1`（= 主轴撑满），
      //   在竖排的行里主轴是**高度** ⇒ 不覆盖的话这栏会被压成 0 高（styles.css 不许改，只能在这儿压回去）。
      const sel = el('select', 'flow-dlg-input');
      sel.style.cssText = 'flex:0 0 auto;width:100%;font-family:var(--sans);font-size:11.5px;';
      // 选项**现算**（所有工具节点的名字 + 「未定」），不写死列表：以后加工具节点，这里自己多一项
      flowMethodOptions().forEach(v => {
        const op = el('option', '', v);
        op.value = v;
        sel.appendChild(op);
      });
      sel.value = before[pick.key] || '未定';
      row.appendChild(sel);
      xrows.push({ key: pick.key, el: sel, row: row });
    }
    // 固定选项下拉（段落 / 用途 / 预览形式）：选项可以写 '字符串'，也可以写 { v, t }（值 + 给人看的字）
    // ⚠「素材性质」（mode）不在这里渲染 —— 它被 modeSel 拆出去、排在路径栏后面第一个（见下）。
    restSelects.forEach(f => {
      const row = mkCol(f.label);
      const sel = el('select', 'flow-dlg-input flow-dlg-sel');
      sel.style.cssText = 'flex:0 0 auto;width:100%;font-family:var(--sans);font-size:11.5px;';
      sel.dataset.key = f.key;
      (f.options || []).forEach(o => {
        const isObj = o && typeof o === 'object';
        const v = isObj ? String(o.v) : String(o);
        const op = el('option', '', isObj ? String(o.t) : (v || '（没定）'));
        op.value = v;
        sel.appendChild(op);
      });
      sel.value = before[f.key];
      row.appendChild(sel);
      xrows.push({ key: f.key, el: sel, row: row });
    });
    // 数字栏（起止秒）：允许只填一个 ⇒ 两栏各自独立，没有必填、也不做"起必须小于止"的校验
    //   （用户原话"两个数字，允许只填一个"；硬校验只会让人填不进去）
    nums.forEach(f => {
      const row = el('div', 'flow-dlg-row');
      row.appendChild(el('label', 'flow-dlg-label', f.label));
      const inp = el('input', 'flow-dlg-input flow-dlg-num');
      inp.type = 'number'; inp.min = '0'; inp.step = '0.1';
      inp.placeholder = f.hint || '';
      inp.style.cssText = 'flex:0 0 auto;width:110px;font-family:var(--sans);font-size:11.5px;';
      inp.value = before[f.key];
      inp.dataset.key = f.key;
      row.appendChild(inp);
      xrows.push({ key: f.key, el: inp, row: row });
    });
    // 「生成的文件名 + 存到文件夹」栏（dirs，2026-09-23 第七轮 + 修正 + 第十一轮）：只有"素材性质=待生成"才有意义 ⇒ 弹框里只在待生成时显示。
    //   第十一轮用户原话"待生成也要有个选择文件夹"⇒ dir 栏带「📁 选文件夹」按钮（app.pickFolder 真实选文件夹）。
    const dirRows = [];
    (t.dirs || []).forEach(f => {
      const row = mkCol(f.label);
      const inp = el('input', 'flow-dlg-input');
      inp.type = 'text'; inp.placeholder = f.hint || ''; inp.spellcheck = false;
      inp.style.cssText = 'width:100%;font-family:var(--sans);font-size:11.5px;';
      inp.value = before[f.key];
      inp.dataset.key = f.key;
      if (f.key === 'dir') {
        // 存到文件夹：input + 📁 选文件夹 按钮同一行（竖排行里再包一层横排容器）
        const line = el('div', '');
        line.style.cssText = 'display:flex;gap:4px;width:100%;align-items:center;';
        inp.style.cssText = 'flex:1 1 auto;min-width:0;font-family:var(--sans);font-size:11.5px;';
        line.appendChild(inp);
        const pkBtn = el('button', 'file-refresh flow-dlg-pick', '📁 选文件夹');
        pkBtn.type = 'button';
        pkBtn.title = '弹出系统文件夹选择器，选中生成文件存放的文件夹后回填（真实路径，不用手打）';
        pkBtn.style.cssText = 'flex:0 0 auto;font-size:11px;padding:1px 6px;';
        pkBtn.addEventListener('click', async () => {
          try {
            if (!(window.app && window.app.pickFolder)) return;
            const dir = await window.app.pickFolder();
            if (dir) { inp.value = dir; inp.focus(); }
          } catch (e) { /* ignore */ }
        });
        if (window.app && window.app.pickFolder) line.appendChild(pkBtn);
        row.appendChild(line);
      } else {
        row.appendChild(inp);
      }
      xrows.push({ key: f.key, el: inp, row: row });
      dirRows.push({ key: f.key, row: row });
    });
    // 素材性质=待生成 才显示生成文件名栏（别的模式藏起来，别让"生成文件名"出现在参考素材的框里）；
    // 反过来：**路径栏只有参考素材才有**（2026-09-23 第十轮，用户原话"选择已有素材参考才会有路径，
    // 选择待生成就不显示路径"）—— 待生成的东西还没有现成素材路径，路径栏整行藏掉（按钮跟着藏）。
    const applyDirVis = () => {
      const mx = xrows.filter(x => x.key === 'mode')[0];
      const mv = String(mx && mx.el ? mx.el.value : (before.mode || '')).trim();
      const isGen = (mv === FLOW_MODE_GEN);
      dirRows.forEach(r => { r.row.style.display = isGen ? '' : 'none'; });
      if (r3) r3.row.style.display = isGen ? 'none' : '';   // 待生成 ⇒ 路径栏藏（参考素材 ⇒ 显示）
    };
    // 模板下拉的 change：把选中模板的 steps / prompt 填进对应的多行栏（找不到那一栏就什么都不做）
    if (tplSel) {
      tplSel.addEventListener('change', () => {
        const i = Number(tplSel.value);
        const tp = (t.tpl.list || [])[i];
        if (!tp || tplSel.value === '') return;
        ['steps', 'prompt'].forEach(key => {
          const x = xrows.filter(y => y.key === key)[0];
          if (x && tp[key] != null) x.el.value = tp[key];
        });
        setStat('✓ 已把「' + tp.name + '」填进下面两栏 —— 还能接着手改（改完点保存）', 'ok');
      });
    }
    const pstat = el('div', 'flow-dlg-stat', '');
    const note = el('div', 'flow-dlg-note', t.note || '');
    const btns = el('div', 'flow-dlg-btns');
    const mk = (label, cls) => { const b = el('button', 'file-refresh' + (cls ? ' ' + cls : ''), label); b.type = 'button'; return b; };
    // 「📄 新建空文件」只对文件类有意义：工具节点填的是地址/程序，不是要新建的文件
    const newBtn = t.kind === 'file' ? mk('📄 新建空文件') : null;
    const cancel = mk('取消');
    const ok = mk('保存', 'primary');
    (newBtn ? [newBtn, cancel, ok] : [cancel, ok]).forEach(b => btns.appendChild(b));
    // ★素材性质下拉（mode）：单独建、放在路径栏后面第一个（"这个素材是参考还是待生成"先定下来）
    const modeRow = modeSel ? (() => {
      const row = mkCol(modeSel.label);
      const sel = el('select', 'flow-dlg-input flow-dlg-sel');
      sel.style.cssText = 'flex:0 0 auto;width:100%;font-family:var(--sans);font-size:11.5px;';
      sel.dataset.key = modeSel.key;
      (modeSel.options || []).forEach(o => {
        const isObj = o && typeof o === 'object';
        const v = isObj ? String(o.v) : String(o);
        const op = el('option', '', isObj ? String(o.t) : (v || '（没定）'));
        op.value = v;
        sel.appendChild(op);
      });
      sel.value = before[modeSel.key] == null ? '' : String(before[modeSel.key]);
      row.appendChild(sel);
      xrows.push({ key: modeSel.key, el: sel, row: row });
      sel.addEventListener('change', () => { applyDirVis(); refreshStat(); });   // 切待生成：露「生成的文件名」栏 + 状态行跟着换说法
      return row;
    })() : null;
    card.appendChild(r1.row); if (r2) card.appendChild(r2.row);
    if (r3) card.appendChild(r3.row);
    if (modeRow) card.appendChild(modeRow);
    applyDirVis();   // 开框时按老值定一次显隐（老图没有 mode ⇒ 栏藏起来，卡片零变化）
    if (tplRow) card.appendChild(tplRow);        // 模板下拉排在它要填的那两栏**前面**（读起来才顺）
    xrows.forEach(x => { if (x.row !== modeRow) card.appendChild(x.row); });
    card.appendChild(pstat); card.appendChild(note); card.appendChild(btns);
    box.appendChild(card);
    viewport.appendChild(box);
    dlgEl = box;   // ⚠ 必须记下来：不记的话 closeDialog() 永远找不到它 ⇒ 每开一次就多留一个弹框（探针逮到的）

    let statTimer = null;
    const setStat = (text, cls) => { pstat.textContent = text; pstat.className = 'flow-dlg-stat' + (cls ? ' ' + cls : ''); };
    async function refreshStat() {
      // 没有"目标"栏可查的两类节点：直接说清双击干什么（别显示"还没填路径"这种误导话）
      if (!r3) {
        setStat(isPreset
          ? '· 这个节点不用填文件/地址 —— 它的内容就是「步骤清单 + 指令模板」；双击它把这份做法摊到预览面板（只读，要改就回这儿改）'
          : '· 这个节点不用填文件/地址 —— 双击它就打开顶栏那个同款的免费网页版窗口（同一个登录态，不花 API token）', '');
        return;
      }
      const p = r3.inp.value.trim();
      if (newBtn) newBtn.style.display = 'none';
      if (!p) {
        // 待生成模式：路径栏藏起来了，状态行别再拿"还没填路径"吓人 —— 改提示填生成的文件名/文件夹
        const mx2 = xrows.filter(x => x.key === 'mode')[0];
        const mv2 = String(mx2 && mx2.el ? mx2.el.value : '').trim();
        if (mx2 && mv2 === FLOW_MODE_GEN) {
          setStat('（待生成 —— 填「生成的文件名」和「存到文件夹」就行，不用素材路径）', '');
          return;
        }
        setStat(isUrl ? '（还没填地址 —— 一般不用改，默认就是本机这个端口）'
          : isApp ? '（还没填程序 —— 把桌面快捷方式（.lnk）的路径粘进来最稳）'
            : '（还没填路径 —— 只填名称和描述也行，以后再补）', '');
        return;
      }
      if (isUrl) {
        // 网页类：只校验格式 + 顺手看端口通不通（状态点的同一个探测）
        if (!flowUrlOk(p)) { setStat('⚠ 地址要写完整：http://127.0.0.1:8188/', 'bad'); return; }
        const pp = flowUrlPort(p);
        if (!pp) { setStat('· 地址看着没问题（看不出端口，就没法看状态）', ''); return; }
        const N = window.app && window.app.net;
        if (!N || !N.probe) { setStat('（宿主还没重启过：重启一次 GUI 才能看端口状态）', 'warn'); return; }
        setStat('… 正在看端口 ' + pp.port, '');
        const r = await N.probe(pp.host, pp.port, 1200);
        if (disposed) return;
        netStat[pp.host + ':' + pp.port] = { open: !!(r && r.open), at: Date.now() };
        if (r && r.open) setStat('✓ 在跑（端口 ' + pp.port + ' 通）', 'ok');
        else setStat('● 没运作（端口 ' + pp.port + ' 不通 —— 双击这个节点打开看看起没起）', 'bad');
        render();
        return;
      }
      if (!flowPathOk(p)) { setStat('⚠ ' + (isApp ? '程序路径' : '路径') + '要写完整：盘符 + 目录 + ' + (isApp ? '程序名' : '文件名'), 'bad'); return; }
      const F = window.app && window.app.file;
      if (!F || !F.stat) { setStat('（宿主还没重启过：重启一次 GUI 才能读写文件）', 'warn'); return; }
      const r = await F.stat(p);
      pathStat[p] = { exists: !!r.exists, size: r.size || 0, isDir: !!r.isDir };
      if (r.exists && r.isDir) setStat('⚠ 这是个文件夹 —— 要写到' + (isApp ? '程序名' : '文件名'), 'bad');
      else if (r.exists) setStat((isApp ? '✓ 程序在，' : '✓ 文件在，') + fmtSize(r.size || 0), 'ok');
      else if (isApp) setStat('⚠ 找不到这个程序 —— 路径要指到 .exe 或桌面快捷方式（.lnk）', 'bad');
      else {
        setStat('· 文件还不存在 —— 保存后会连路径一起记住，第一次存盘时自动建；也可以现在点「新建空文件」', 'warn');
        if (newBtn) newBtn.style.display = '';
      }
      if (!disposed) render();
    }
    // 目标栏的输入监听：⚠ 网页版 AI 节点**没有这一栏**（r3 是 null），不判这一下会在开框时直接抛异常 ——
    // 抛了就轮不到下面的 refreshStat() 和按钮绑定，表现是"弹框里状态行空的、点取消也关不掉"（探针逮到的）。
    if (r3) r3.inp.addEventListener('input', () => { if (statTimer) clearTimeout(statTimer); statTimer = setTimeout(refreshStat, 350); });
    function commit() {
      const pth = r3 ? r3.inp.value.trim() : '';
      if (pth && isUrl && !flowUrlOk(pth)) { say('地址要写完整：http://…'); r3.inp.focus(); return; }
      if (pth && !isUrl && !flowPathOk(pth)) { say((isApp ? '程序路径' : '路径') + '要写完整（盘符 + 目录 + ' + (isApp ? '程序名' : '文件名') + '）'); r3.inp.focus(); return; }
      n.name = r1.inp.value.trim() || t.newName;
      if (r2) n.desc = String(r2.inp.value == null ? '' : r2.inp.value).trim();   // 大文本框留住换行（卡片/Markdown 显示时再压成一行）
      n.path = pth;   // webai 节点没有目标栏 ⇒ 一直是空串（它本来就没有真实文件路径）
      // 给 AI 看的那几栏：原样存（情节是给人/给 AI 读的多行文本，不折叠空白；卡片和 Markdown 会自己压成一行）
      xrows.forEach(x => { n[x.key] = String(x.el.value == null ? '' : x.el.value).trim(); });
      // 素材性质不是"待生成"时，「生成的文件名」栏是藏起来的 —— 存进去的必须是空
      // （别让一个"已有素材 · 参考"节点莫名其妙带个生成文件名；老图无 mode 也走这里清掉）
      const mx = xrows.filter(x => x.key === 'mode')[0];
      const mvNow = String(mx && mx.el ? mx.el.value : '').trim();
      if (mx && mvNow !== FLOW_MODE_GEN) {
        (t.dirs || []).forEach(f => { n[f.key] = ''; });
      }
      // 反过来（2026-09-23 第十轮）：待生成的节点**没有现成素材路径**，路径栏藏起来了 ⇒ 存进去的必须是空
      if (mx && mvNow === FLOW_MODE_GEN && r3) {
        n.path = '';
      }
      sel = { type: 'node', id: n.id };
      save(); closeDialog(); render();
      let msg = isPreset ? '已保存 —— 双击这个节点就把这套做法摊到预览面板'
        : isWebAi ? '已保存 —— 双击这个节点就打开顶栏那个同款的网页版窗口'
          : mx && mvNow === FLOW_MODE_GEN
            ? (String(n.fname || '').trim() || String(flowDirOf(n)).trim()
                ? '已保存 —— 待生成' + (String(n.fname || '').trim() ? '「' + String(n.fname).trim() + '」' : '（还没填文件名）')
                  + (String(flowDirOf(n)).trim() ? '，存到 ' + flowDirSeg(flowDirOf(n)) + (String(n.dir || '').trim() ? '' : '（跟随项目文件夹）') : '')
                : '已保存（还没填生成的文件名 —— 右键编辑 → 「生成的文件名」）')
            : !pth ? ('已保存（还没填' + (isUrl ? '地址' : isApp ? '程序' : '路径') + '）')
              : isUrl ? '已保存 —— 双击这个节点就在预览面板里打开它'
                : isApp ? '已保存 —— 双击这个节点就打开这个软件'
                  : '已保存 —— 双击这个节点就能打开';
      // 内容节点还填了"给 AI 看的栏"时补一句：这几栏是要给会话读的（⧉ Markdown 带上）
      const nAi = xrows.filter(x => {
        const v = String(x.el.value == null ? '' : x.el.value).trim();
        return v && v !== '未定';
      }).length;
      if (nAi) msg += '；给 AI 看的 ' + nAi + ' 栏也记下了（点 ⧉ Markdown 会带上）';
      say(msg);
      if (pth && isUrl) pollNet();          // 地址不是文件，别拿去查文件状态
      if (pth && !isUrl) checkPaths();
    }
    if (newBtn) newBtn.addEventListener('click', async () => {
      const p = r3 ? r3.inp.value.trim() : '';
      if (!flowPathOk(p)) { setStat('⚠ 先写完整路径再新建', 'bad'); return; }
      const F = window.app && window.app.file;
      if (!F || !F.write) { setStat('（宿主还没重启过：重启一次 GUI 才能写文件）', 'warn'); return; }
      const r = await F.write(p, '');
      if (r && r.ok) { pathStat[p] = { exists: true, size: 0 }; setStat('✓ 已新建：' + p, 'ok'); newBtn.style.display = 'none'; render(); }
      else setStat('⚠ ' + ((r && r.err) || '新建失败'), 'bad');
    });
    cancel.addEventListener('click', () => {
      // 新建出来的节点，如果用户一个字没改就取消了 —— 那就当没建过（免得画布上留一堆空节点）
      // 工具节点建出来就带默认目标（地址/快捷方式），所以判据是"所有字段都还等于打开时的值"
      // （含新加的那几栏：情节 / 用什么方式生成 / 用途）
      const changed = r1.inp.value.trim() !== before.name
        || (r2 ? r2.inp.value.trim() !== before.desc : false)
        || (r3 ? r3.inp.value.trim() !== before.path : false)
        || xrows.some(x => String(x.el.value == null ? '' : x.el.value).trim() !== String(before[x.key] || '').trim());
      if (isNew && !changed) {
        g.nodes = g.nodes.filter(x => x.id !== n.id);
        g.edges = g.edges.filter(e => e.from !== n.id && e.to !== n.id);
        sel = null; closeDialog(); save(); render(); say('没建（取消掉了）');
        return;
      }
      closeDialog();
    });
    ok.addEventListener('click', commit);
    box.addEventListener('mousedown', (ev) => { if (ev.target === box) closeDialog(); });
    // Enter = 保存 / Esc = 取消；并且把按键截在弹框里（别让画布的 Delete 抢走 Backspace）
    box.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      // ⚠ 多行文本框（情节 / 用途）里的回车是"换行"，不是"保存" ——
      //   不判这一下，情节刚敲一行就被保存关窗了（新加字段时最容易漏的一处）
      const inTextarea = !!(ev.target && ev.target.tagName === 'TEXTAREA');
      if (ev.key === 'Enter' && !inTextarea) { ev.preventDefault(); commit(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); closeDialog(); }
    });
    refreshStat();
    setTimeout(() => { try { r1.inp.focus(); r1.inp.select(); } catch (e) { /* ignore */ } }, 0);
  }
  // 新建节点的落点：同一个位置连着建好几个会叠成一摞（看着像只建了一个）。按 190×64 的格子
  // 依次试右 / 下 / 左 / 上 / 斜角，找第一个不压着已有节点的位置；用户想摆哪自己拖。
  const FLOW_SPOTS = [[0, 0], [212, 0], [0, 116], [-212, 0], [0, -116], [212, 116], [-212, 116], [212, -116], [-212, -116], [424, 0], [0, 232], [-424, 0], [0, -232]];
  function flowFreeSpot(wx, wy) {
    const busy = (x, y) => g.nodes.some(n => Math.abs(n.x - x) < 170 && Math.abs(n.y - y) < 60);
    for (const d of FLOW_SPOTS) {
      const x = Math.round(wx) + d[0], y = Math.round(wy) + d[1];
      if (!busy(x, y)) return { x: x, y: y };
    }
    return { x: Math.round(wx), y: Math.round(wy) };
  }
  function addNode(typeId, wx, wy) {
    const t = flowType(typeId);
    const spot = flowFreeSpot(wx, wy);
    const n = {
      id: 'n' + Date.now().toString(36) + (seq++),
      type: t.id, name: t.newName, desc: '',
      // 工具节点建出来就带"默认目标"：控制台/工作台=本机地址，剪映/OBS=桌面快捷方式。
      // 这样点一下「＋ 节点 ▾ → ComfyUI 工作台」就能直接双击用，想改再右键编辑。
      path: t.path || t.url || '',
      x: spot.x, y: spot.y
    };
    // 类型表里声明了默认值的栏（用途 / 段落 / 预览形式 / 默认干什么）在建节点时就落上去：
    //   这样卡片上立刻能看出"这是个什么节点"（用户要的"字段要精准"），而不是等用户编辑一遍才有字。
    //   全是老字段名（use / seg / preview / duty…），老图不受影响。
    const defs = flowTypeDefaults(t);
    Object.keys(defs).forEach(k => { if (n[k] == null) n[k] = defs[k]; });
    g.nodes.push(n);
    sel = { type: 'node', id: n.id };
    save(); render();
    openDialog(n, true);   // 新建后直接把编辑框打开：名称/描述/路径一次填完（以前是就地改标题）
  }
  function removeSel() {
    if (!sel) { say('先点一个节点或线选中它'); return; }
    if (sel.type === 'node') {
      const t = nodeById(sel.id);
      g.nodes = g.nodes.filter(n => n.id !== sel.id);
      g.edges = g.edges.filter(e => e.from !== sel.id && e.to !== sel.id);
      say('已删除节点：' + ((t || {}).name || ''));
    } else {
      g.edges = g.edges.filter(e => e.id !== sel.id);
      say('已删除连线');
    }
    sel = null;
    save(); render();
  }
  function fit() {
    const r = viewport.getBoundingClientRect();
    if (!g.nodes.length) { view = { x: 16, y: 44, k: 1 }; applyView(); render(); return; }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    g.nodes.forEach(n => {
      const s = nodeSize(n.id);
      x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
      x1 = Math.max(x1, n.x + s.w); y1 = Math.max(y1, n.y + s.h);
    });
    const padT = 46, padB = 36, padX = 22;   // 上方留工具条、下方留提示行（留够，别让节点贴着提示行）
    const k = flowClampN(Math.min((r.width - padX * 2) / Math.max(1, x1 - x0), (r.height - padT - padB) / Math.max(1, y1 - y0)), 0.32, 1.3);
    view.k = k;
    view.x = Math.round((r.width - (x1 - x0) * k) / 2 - x0 * k);
    view.y = Math.round(padT + ((r.height - padT - padB) - (y1 - y0) * k) / 2 - y0 * k);
    applyView(); render();
  }
  // 整理成列：按连线做一次拓扑分层（深度 = 第几列），列内按当前 y 排 —— 图有环也能收敛
  function tidy() {
    const indeg = {}, adj = {};
    g.nodes.forEach(n => { indeg[n.id] = 0; adj[n.id] = []; });
    g.edges.forEach(e => {
      if (adj[e.from] && indeg[e.to] != null) { adj[e.from].push(e.to); indeg[e.to]++; }
    });
    const depth = {};
    const q = g.nodes.filter(n => !indeg[n.id]).map(n => n.id);
    q.forEach(id => { depth[id] = 0; });
    let maxD = 0;
    while (q.length) {
      const id = q.shift();
      adj[id].forEach(t => {
        depth[t] = Math.max(depth[t] == null ? 0 : depth[t], depth[id] + 1);
        maxD = Math.max(maxD, depth[t]);
        if (--indeg[t] === 0) q.push(t);
      });
    }
    const restCol = maxD + 1;   // 环里/孤立但没入度的节点统一放最后一列
    g.nodes.forEach(n => { if (depth[n.id] == null) depth[n.id] = restCol; });
    const rows = {};
    g.nodes
      .slice()
      .sort((a, b) => (depth[a.id] - depth[b.id]) || (a.y - b.y) || (a.x - b.x))
      .forEach(n => {
        const c = depth[n.id];
        rows[c] = rows[c] || 0;
        n.x = 20 + c * 208;
        n.y = 18 + rows[c] * 118;
        rows[c]++;
      });
    save(); fit();
    say('已按连线顺序排成 ' + (restCol + 1) + ' 列');
  }
  // ---- 「⧉ Markdown」：固定四节 + 附录（用户 2026-09-21 定的结构）----
  // 为什么是这四节、为什么顺序不能动：这份文本是**递给 AI 会话的活**（画布 → 会话的唯一通道），
  //   会话按「时间线 → 方式链 → 依据 → 指令」就能知道"成片有哪几段、每段怎么产出来、依据是什么、照哪段指令做"。
  //   哪一节没内容也得印出来（写「（空）」）—— 少一节，会话就以为那份信息"不存在"而不是"还没填"。
  // 附录那份节点清单（按画布上的先后编号）保留的是"逐个节点"的完整档案（路径、状态、接线口、每个字段），
  //   会话照着它才知道每个节点对应磁盘上哪个文件、那个文件现在在不在。
  function toMarkdown() {
    const idx = {};
    g.nodes.forEach((n, i) => { idx[n.id] = i + 1; });
    const outs = {}, inns = {};
    g.edges.forEach(e => {
      (outs[e.from] = outs[e.from] || []).push(e.to);
      (inns[e.to] = inns[e.to] || []).push(e.from);
    });
    const nm = (n, t) => (n.name || t.newName);
    const tag = (n, t) => flowCatOf(t).name.replace('节点', '') + ' · ' + t.name;
    // 主线顺序 = 卡片角标用的那一份（flowSeqOrder）⇒ 角标 ① 和这里的第一段永远是同一个节点
    const spine = flowSeqOrder(g).map(id => nodeById(id)).filter(Boolean);
    const spineNo = {};
    spine.forEach((n, i) => { spineNo[n.id] = flowNum(i); });
    const lines = ['# ' + (meta.title || pid), ''];   // 标题不再重复一遍图名（2026-09-26 用户："内容太多了"）
    // ── ① 成片时间线 ───────────────────────────────────────────────
    lines.push('## 成片时间线');
    if (!spine.length) lines.push('（空）');
    spine.forEach(n => {
      const t = flowType(n.type);
      const seg = String(n.seg || '').trim() || t.name;                 // 段定义（没填就用类型名兜底）
      const secs = FLOW_SUB_FMT.secs(n) || '秒数未填';                   // 秒数（允许只填一头，见 FLOW_SUB_FMT）
      // 产出方式**认连线**（2026-09-26 用户点名改：这个字段本来就是靠连线得到的，不该再问一遍）
      const hc = flowHowChain(g, n.id);
      const how = hc.length ? hc.map(x => (x.name || flowType(x.type).newName)).join(' → ') : '产出方式未填';
      // 一行说清这一段：编号 + 名字 + 类型 + 段落/秒数（**填了才写**）+ 产出方式（认连线）+ 定性栏（用途/来源…）
      //   ⚠ 上面 seg/secs/how 那几行现在用不上了，留着不动（少改多行注释）；下面自成一套 bits。
      const bits = [];
      if (String(n.seg || '').trim()) bits.push('段落：' + String(n.seg).trim());
      const secs2 = FLOW_SUB_FMT.secs(n);
      if (secs2) bits.push(secs2);
      const hc2 = flowHowChain(g, n.id);
      if (hc2.length) bits.push('产出方式：**' + hc2.map(x => (x.name || flowType(x.type).newName)).join(' → ') + '**');
      const inline = flowFieldLines(n, t).filter(x => x.raw && x.kind !== 'num'
        && ['plot', 'prompt', 'purpose', 'mode', 'fname', 'dir', 'format', 'seg'].indexOf(x.key) < 0);
      inline.forEach(x => bits.push(x.label + '：' + x.raw));
      lines.push('- ' + spineNo[n.id] + ' **' + nm(n, t) + '**（' + tag(n, t) + '）' + (bits.length ? ' — ' + bits.join(' · ') : ''));
      if (n.desc) lines.push('  - 要求：' + flowOneLine(n.desc));         // 描述 = 那栏"要求"（大文本框，可能多行）
      const prod = flowProdLine(n, t);                                    // 产物：待生成 ⇒ 一行完整路径（老版印四行）
      if (prod) lines.push('  - 产物：' + prod);
      const fl = flowFieldLines(n, t).filter(x => x.kind !== 'num');      // 秒数上面已经写过了，别再重复
      // 字段不再逐条印（2026-09-26 收敛成上面那一行的内联定性栏 + 「要求：/产物：」两行）
      // 路径并进上面那行「产物：」了（待生成会把 "文件夹 + 文件名 + 格式" 拼成一条完整路径）
    });
    lines.push('');
    // ── ② 方式链（一个主线节点一条链，链内从左到右 ①②③）────────────────
    // （「方式链」这一节 2026-09-26 已合并进「成片时间线」那行的「产出方式：」——用户："内容太多了"）
    let chainNo = 0, chainAny = false;
    spine.forEach(n => {
      const chain = flowHowChain(g, n.id);
      if (!chain.length) return;
      chainAny = true;
      const letter = String.fromCharCode(65 + (chainNo++));               // A / B / C…
      const parts = chain.map((x, i) => flowNum(i) + ' **' + nm(x, flowType(x.type)) + '**（'
        + flowCatOf(flowType(x.type)).name.replace('节点', '') + '）');
      parts.push(flowNum(chain.length) + ' **' + nm(n, flowType(n.type)) + '**（成片这一段）');
      // 方式链不再单独导出（同上：已并进时间线那一行）
    });
    void chainAny;
    lines.push('');
    // ── ③ 依据 / 素材 ───────────────────────────────────────────────
    // 「依据/素材」标题等内容收集完再印（空的时候只留一行「依据/素材：无」；⚠ 别写在 const depLines 前面 —— TDZ 会抛异常、整个导出变空）
    const depLines = [];
    g.edges.forEach(e => {
      const a = nodeById(e.from), b = nodeById(e.to);
      if (!a || !b) return;
      if (flowWireKind(e, a, b) !== 'dep') return;                       // 只有"依据线"进这一节
      depLines.push('- ' + (spineNo[b.id] ? spineNo[b.id] + ' ' : '') + '**' + nm(b, flowType(b.type)) + '** 的依据 → **'
        + nm(a, flowType(a.type)) + '**（' + tag(a, flowType(a.type)) + '）' + (a.path ? '：`' + a.path + '`' : ''));
    });
    // 没接进主线的素材也列出来（不然会话会以为"图里没有它"，而这些往往正是要用的料）
    const loose = g.nodes.filter(n => flowCatOf(flowType(n.type)).id === 'content' && !spineNo[n.id]);
    loose.forEach(n => depLines.push('- 不在主线上的内容节点：**' + nm(n, flowType(n.type)) + '**（'
      + tag(n, flowType(n.type)) + '）' + (n.desc ? ' — ' + flowOneLine(n.desc) : '') + (n.path ? '：`' + n.path + '`' : '')));
    lines.push(depLines.length ? '## 依据/素材' : '依据/素材：无');
    depLines.forEach(x => lines.push(x));
    lines.push('');
    // ── ④ 指令（会话照做的那几段话：情节/提示词、指令模板）────────────────
    // 「指令」标题**等内容收集完再印**（空的时候只留一行「指令：无」）
    const cmdKeys = ['plot', 'prompt', 'purpose'];   // purpose（HTML 的「要做什么」）也归"照做的东西"
    const cmdLines = [];
    spine.concat(g.nodes.filter(n => !spineNo[n.id])).forEach(n => {
      const t = flowType(n.type);
      flowFieldLines(n, t).forEach(x => {
        if (cmdKeys.indexOf(x.key) < 0 || !x.raw) return;
        const pre = spineNo[n.id] ? spineNo[n.id] + ' ' : '';
        cmdLines.push('- ' + pre + '**' + nm(n, t) + '** · ' + x.label + '：' + x.raw);
      });
      // 预设节点：步骤清单也属于"照做的东西"，跟在指令后面（一行一步，编号重排，不会出现双序号）
      if (t.kind === 'preset') {
        const st = flowPresetSteps(n.steps);
        if (st.length) {
          cmdLines.push('- **' + nm(n, t) + '** · 步骤清单：');
          st.forEach((s, i) => cmdLines.push('  ' + (i + 1) + '. ' + s));
        }
      }
    });
    lines.push(cmdLines.length ? '## 指令' : '指令：无');
    cmdLines.forEach(x => lines.push(x));
    lines.push('');
    // ── 附录：节点清单（逐个节点的完整档案 —— 老结构原样保留，只把字段换成新的那套）────
    // （附录「节点清单」已停用 ⇒ 改成末尾一行「工具：」+ 一行「其他节点：」）
    [].forEach((n, i) => {   // 2026-09-26：附录"逐节点档案"整块停用（时间线/依据/指令里已经交代过，重复）
      const to = (outs[n.id] || []).filter(t => idx[t]).map(t => idx[t] + '. ' + ((nodeById(t) || {}).name || '')).join('、');
      const t = flowType(n.type);
      const cat = flowCatOf(t);
      lines.push((i + 1) + '. **' + nm(n, t) + '**（' + cat.name + ' · ' + t.name + '）'
        + (n.desc ? ' — ' + flowOneLine(n.desc) : '') + (to ? '  → ' + to : ''));
      // 内容节点那几栏（情节 / 段落 / 用途 / 指令模板）**必须进 Markdown**：
      //   用户要的语义就是"这个节点连到哪个工具节点 = 告诉正在用工作流的 AI 会话用那个工具、按这份情节生成"，
      //   而画布把话递给会话的唯一通道就是这份 Markdown（⧉ 按钮）—— 不写进来，那几栏就等于只有人看得见。
      flowFieldLines(n, t).forEach(x => lines.push('   - ' + x.label + '：' + x.raw));
      // 目标按类型换称呼：文件类=文件 / 网页类=地址（带端口状态）/ 软件类=程序
      if (n.path) {
        const lab = t.kind === 'url' ? '地址' : t.kind === 'app' ? '程序' : '文件';
        lines.push('   - ' + lab + '：`' + n.path + '`' + pathMark(n, t));
      }
      // 口开在哪几面也写进去：AI 看这份 Markdown 才知道"控制台在上下、工作台上下都能接"
      const sd = flowSides(t).map(s => ({ l: '左', r: '右', t: '上', b: '下' }[s])).join('/');
      if (sd !== '左/右') lines.push('   - 接线口：' + sd);
      // 这个节点在主线上的话，把它的编号也交代一句（会话就能把附录和「成片时间线」对上）
      if (spineNo[n.id]) lines.push('   - 主线位置：第 ' + spineNo[n.id] + ' 段');
    });
    lines.push('');
    // ── 末尾只留两行"还有哪些节点"（2026-09-26 用户点名砍掉逐节点档案）──
    //   工具：写清"拿它干什么"（会话才知道豆包擅长什么）；其他节点：只剩**上面一个字都没提到**的（提醒别漏了它）。
    const toolNodes = g.nodes.filter(n => {
      const c = flowCatOf(flowType(n.type)).id;
      return (c === 'tool' || c === 'method') && String(n.duty || n.desc || '').trim();
    });
    if (toolNodes.length) {
      lines.push('工具：' + toolNodes.map(n => nm(n, flowType(n.type)) + '（' + flowOneLine(n.duty || n.desc) + '）').join('、'));
    }
    const restNodes = g.nodes.filter(n => {
      if (spineNo[n.id]) return false;
      if (toolNodes.indexOf(n) >= 0) return false;
      if (flowCatOf(flowType(n.type)).id === 'content') return false;
      return true;
    });
    if (restNodes.length) {
      lines.push('其他节点：' + restNodes.map(n => nm(n, flowType(n.type)) + '（' + tag(n, flowType(n.type)) + '）'
        + (n.path ? ' `' + n.path + '`' : '')).join('、'));
    }
    // （线型图例已砍：那是讲界面的；会话看"在哪一节"就知道是方式线还是依据线）
    return lines.join('\n');
  }
  // 路径后面那个状态记号（附录和「成片时间线」共用）：文件类看 pathStat，网页类看端口探测
  // 「产物」那一行（2026-09-26 用户点名收敛）：待生成 ⇒ 把 "文件夹 + 文件名 + 格式" 拼成**一条完整路径**（老版印四行）；
  //   已有素材/参考 ⇒ 一条路径 + 状态记号；两样都没有 ⇒ 空串（这一行不出现）。
  function flowProdLine(n, t) {
    if (String(n.mode || '').trim() === FLOW_MODE_GEN) {
      const f = String(n.fname || '').trim();
      const ext = flowFmtExt(n, t);
      const name = f ? (f + (ext ? '.' + ext : '')) : '';
      const dir = flowDirOf(n);   // ★跟随项目文件夹★：留空就是项目文件夹（见 flowDirOf 注释）
      const full = dir ? (name ? dir + '\\' + name : dir + '\\') : name;
      return '`' + (full || '（还没填生成的文件名/文件夹）') + '`（待生成'
        + (String(n.format || '').trim() ? ' · ' + String(n.format).trim() : '') + '）';
    }
    if (n.path) return '`' + n.path + '`' + pathMark(n, t);
    return '';
  }
  function pathMark(n, t) {
    if (!n.path) return '';
    if (t.kind === 'url') {
      const pp = flowUrlPort(n.path) || t.probe;
      const ns = pp ? netStat[pp.host + ':' + pp.port] : null;
      return !ns ? '' : (ns.open ? ' ✓ 在跑' : ' ● 没运作');
    }
    const st = pathStat[n.path];
    return st ? (st.exists ? (st.isDir ? ' ⚠ 是文件夹' : ' ✓') : ' ⚠ 找不到') : '';
  }
  // 兜底：两路剪贴板都失败（窗口没聚焦时 execCommand('copy') 会被拒）就把内容摆出来让人自己 Ctrl+C。
  // 2026-09-20 探针实测：隐藏窗口下 execCommand('copy') 返回 false —— 真 GUI 里通常没事，
  // 但不能让用户点了按钮"什么都没发生"，所以必须有这条兜底路径。
  function showManual(text) {
    let box = viewport.querySelector('.flow-export');
    if (!box) {
      box = el('div', 'flow-export');
      box.appendChild(el('div', 'flow-export-tip', '剪贴板用不了（窗口没聚焦）——下面全选好了，按 Ctrl+C 复制，或点关闭'));
      const ta = el('textarea', 'flow-export-ta');
      const close = el('button', 'file-refresh', '关闭');
      close.type = 'button';
      close.addEventListener('click', () => { if (box.parentNode) box.parentNode.removeChild(box); });
      box.appendChild(ta);
      box.appendChild(close);
      viewport.appendChild(box);
    }
    const ta = box.querySelector('.flow-export-ta');
    ta.value = text;
    ta.focus();
    try { ta.select(); } catch (e) { /* ignore */ }
    say('剪贴板不可用 → 已展开手动复制框');
  }
  function exportText(kind) {
    const text = kind === 'md' ? toMarkdown() : JSON.stringify(g, null, 2);
    // 顺手把「⧉ Markdown」那份四节大纲也落进快照目录（JSON 每次保存已自动写；这份带着主线 ①②③ 顺序，AI 读起来更省事）
    if (kind === 'md') flowSnapWrite(storeKey, snapDir, 'md', text);
    const ok = () => say(kind === 'md' ? '已复制 Markdown（粘给 AI 就能落进项目信息）' : '已复制 JSON');
    // 两条路都试：navigator.clipboard 是异步新接口（真 GUI 聚焦时最稳），
    // execCommand 是老办法（file:// 下也能用，但窗口未聚焦会被拒）。
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(ok, () => { if (flowCopyText(text)) ok(); else showManual(text); });
        return;
      }
    } catch (e) { /* ignore */ }
    if (flowCopyText(text)) ok(); else showManual(text);
  }

  // ---- 工具条动作 ----
  bar.addEventListener('mousedown', (ev) => ev.stopPropagation());   // 点工具条不当作平移画布
  bar.addEventListener('dblclick', (ev) => ev.stopPropagation());
  // 三个「＋ …节点 ▾」的点击行为已经在建按钮时挂好了（addEventListener('click', () => openAddMenu(c, b))），
  // ★「▶ 开始」：把这张画布当工单，**直接发进本场景的 AI 会话**（用户 2026-09-26 点名：
  //   「在视频全工作流标题框加一个开始按钮，点击之后就是相当于给你发信息开始跑工作流」）。
  //   以前只能手动点「⧉ Markdown」再粘过去 —— 现在一键就等于对会话说"按画布开始跑工作流"。
  //   通道：引擎 RPC `POST /api/session/prompt`（信封 `{type:'client-request',rpcId,method,payload:{args:{request}}}`，
  //   契约见 DSH `packages/api/session-controller/src/commands.ts` 的 `prompt()` 与 `types.ts` 的 SessionPromptRequest）。
  //   ⚠ 必须在**那个 harness webview 里**发：它带着 3080 的同源 cookie；渲染层自己 fetch 会被 CORS/凭据挡。
  //   发不出去（没绑会话 / 面板没加载 / 接口改版）⇒ 退回"复制到剪贴板"并**明说原因**，绝不静默失败。
  // 「你是哪条会话？」：**在那个 webview 里问它自己**，不走场景 json ——
  //   ① 主窗口 URL 不带 `?scene=`（只有分离窗口才有，见 panelPartition），靠场景 json 拿 sessionId 在真 GUI 里会取空；
  //   ② 面板真正"钉着哪条会话"只有它自己知道（注入脚本把绑定写进它自己的分区 localStorage）。
  //   三个来源挨个试：引擎壳的 `dsh.sessions.current` → 绑定键 `app_pin_bind*` → URL 里的 session-xxxx。
  const ASK_ID_JS = '(function(){var out={id:"",from:""};try{'
    + 'var v=localStorage.getItem("dsh.sessions.current");'
    + 'if(v){try{v=JSON.parse(v);}catch(e){}var t=(v&&typeof v==="object")?(v.sessionId||v.id||(v.value&&v.value.sessionId)):v;'
    + 'if(t){out.id=String(t);out.from="dsh.sessions.current";}}'
    + 'if(!out.id){for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);if(String(k).indexOf("app_pin_bind")!==0)continue;'
    + 'var m=String(localStorage.getItem(k)||"").match(/session-[0-9a-fA-F-]{8,}/);if(m){out.id=m[0];out.from=k;break;}}}'
    + 'if(!out.id){var m2=String(location.href+location.search).match(/session-[0-9a-fA-F-]{8,}/);if(m2){out.id=m2[0];out.from="url";}}'
    + '}catch(e){out.err=String(e);}return out;})()';
  // 本场景的对话窗口 = 分区名 `persist:harness-panel-*`（panelPartition 定的，见上面 harness 那节）。
  // ⚠ 一个场景挂多个 AI 面板时，取**第一个能读出会话 id** 的那个（要精确指定得给画布面板加个字段，先不做）。
  // ★2026-09-29 修（用户报：「▶ 开始」把工单发到<客户>场景的会话去了）★
  //   病根：这里原来是**问那个 webview 自己"你现在显示哪条会话"**，再往那条发 ——
  //   只要 AI 面板被切到过别的会话（实测切到了<客户> OA 那条），工单就会**悄无声息地跑进别的场景**。
  //   现在改成：**目标会话只认本场景 json 里 AI 面板声明的 sessionId**（scenarios/<场景>.json 的 panels[].sessionId）。
  //   webview 只当**发请求的通道**（它带 3080 的同源 cookie）——面板当前显示哪条，不影响投递目标；
  //   两者不一致时**照样发进声明的会话**，并在提示里明说（别再让这种事无声无息）。
  async function flowSceneSession() {
    const scene = String((meta && meta.scenario) || '');
    if (!scene) return { err: '这个画布面板没带场景标记（meta.scenario 为空），没法确定该发给哪条会话' };
    let sc = null;
    try { sc = await window.app.getScenario(scene); } catch (e) { return { err: '读场景配置失败：' + String((e && e.message) || e) }; }
    const ai = (((sc || {}).panels) || []).filter(function (p) { return p && p.type === 'harness' && p.sessionId; });
    if (!ai.length) return { err: '场景「' + scene + '」里没有绑定会话的 AI 面板' };
    const want = String(ai[0].sessionId);
    const title = String(ai[0].title || ai[0].sessionTitle || 'AI');
    const wvs = [].slice.call(document.querySelectorAll('webview'));
    const partOf = function (w) { return String(w.getAttribute('partition') || ''); };
    const wv = wvs.filter(function (w) { return partOf(w) === 'persist:harness-panel-' + ai[0].id; })[0]        // ① 本场景那个 AI 面板
      || wvs.filter(function (w) { return partOf(w).indexOf('persist:harness-panel-') === 0; })[0]              // ② 别的 harness 面板（只当通道）
      || wvs.filter(function (w) { return partOf(w) === 'persist:harness'; })[0];                               // ③ 共用分区
    if (!wv) return { err: '本场景的 AI 面板还没加载出来（它是发消息的通道）' };
    let showing = '';
    try { const r0 = await wv.executeJavaScript(ASK_ID_JS, true); showing = String((r0 && r0.id) || ''); } catch (e) { /* 读不到就不提 */ }
    return { wv: wv, sessionId: want, title: title, showing: showing, mismatch: !!showing && showing !== want };
  }
  async function flowSendToSession(text) {
    const live = await flowSceneSession();
    if (live.err) return { ok: false, why: live.err };
    const rid = 'canvas-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    const env = {
      type: 'client-request', rpcId: rid, method: 'session/prompt',
      payload: { args: { request: { requestId: rid, sessionId: live.sessionId, mode: 'queue', content: [{ type: 'text', text: text }] } } },
    };
    const js = '(function(){var b=' + JSON.stringify(env) + ';'
      + 'return fetch("/api/session/prompt",{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify(b)})'
      + '.then(function(r){return r.text().then(function(t){return {status:r.status,body:String(t).slice(0,240)};});},'
      + 'function(e){return {err:String(e)};});})()';
    let res = null;
    try { res = await live.wv.executeJavaScript(js, true); }
    catch (e) { return { ok: false, why: '那个窗口里执行不了：' + String((e && e.message) || e) }; }
    if (!res || res.err) return { ok: false, why: '窗口内 fetch 没成：' + String((res && res.err) || '无返回') };
    if (res.status === 200 && /"accepted"\s*:\s*true/.test(String(res.body || ''))) return { ok: true, title: live.title, sessionId: live.sessionId, showing: live.showing, mismatch: live.mismatch, wv: live.wv };
    return { ok: false, why: 'HTTP ' + res.status + ' ' + String(res.body || '').slice(0, 150) };
  }
  // ★发完发现"面板显示的不是本场景会话"时，用它现成的「状态小字」入口解绑重找 ★
  //   （renderers.harness 里 diag 的点击 = 清 app_pin_bind_v2:<面板id> + reload ⇒ 面板按场景 json 重钉会话）
  //   不重复实现重绑逻辑，只复用那一个入口（一个功能只留一处实现）。
  function flowRebindPanel(wv) {
    try {
      let host = wv;
      for (let i = 0; i < 6 && host && host.parentElement; i++) {
        host = host.parentElement;
        const d = host.querySelector ? host.querySelector('.harness-diag') : null;
        if (d && d.click) { d.click(); return true; }
      }
    } catch (e) { /* ignore */ }
    return false;
  }
  const startBtn = mkBtn('▶ 开始', '把这张画布当工单，**直接发进本场景的 AI 会话** —— 等于对那个会话说"按画布开始跑工作流"');
  startBtn.dataset.act = 'start';
  startBtn.style.color = '#7ee0a1';
  startBtn.style.fontWeight = '600';
  startBtn.addEventListener('click', () => {
    const text = '按画布开始跑工作流（画布「' + (meta.title || pid) + '」）。下面是这张工单：\n\n' + toMarkdown();
    const label = startBtn.textContent;
    startBtn.disabled = true;
    startBtn.textContent = '⏳ 发送中…';
    const done = (msg) => { startBtn.disabled = false; startBtn.textContent = label; say(msg); };
    // 发不进去时的兜底：和「⧉ Markdown」同一套三条路（真剪贴板 → execCommand → 手动复制框）
    const fallbackCopy = (why) => {
      const hit = () => done('⚠ 没发进会话（' + why + '）→ 工单已复制，粘给会话即可');
      const miss = () => { const okc = flowCopyText(text); if (okc) hit(); else { showManual(text); done('⛔ 没发进会话（' + why + '），复制也没成 → 手动复制框已打开'); } };
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(hit, miss); return; }
      } catch (e) { /* ignore */ }
      miss();
    };
    flowSendToSession(text).then(r => {
      if (r.ok) {
        const healed = (r.mismatch && r.wv) ? flowRebindPanel(r.wv) : false;
        done('✅ 已把工单发进本场景的会话「' + r.title + '」'
          + (r.mismatch ? '（⚠ 那个 AI 面板刚才显示的是另一条会话 …' + String(r.showing).slice(-8)
            + (healed ? '，已顺手让它重绑回本场景的会话' : '，工单照样发进了场景绑定的会话 —— 点它标题右侧状态小字可重绑') + '）' : '')
          + ' —— 它开工了，去那个面板看进度');
        return;
      }
      fallbackCopy(r.why);
    }, e => fallbackCopy(String((e && e.message) || e)));
  });
  // 放**面板标题框**里（用户点名「在视频全工作流标题框加一个开始按钮」）：head 就是那行标题，
  //   renderer.js 的 `fn(body, p, head)` 每个渲染器都收得到（harness 面板的「🔄 重新加载」也挂这儿）。
  //   探针/老壳没给 head 时退回工具栏最前面，保证按钮永远在。
  if (head && head.appendChild) head.appendChild(startBtn);
  else bar.insertBefore(startBtn, bar.firstChild);
  // ★「⟳ 刷新画布」（用户 2026-09-26 点名：加在「▶ 开始」右边）——手动重读画布图并重绘。
  //   会话刚写过新图时点它（不用等 5 秒看门狗）；没有新图就按当前图重画一遍。
  const refBtn = mkBtn('⟳ 刷新画布', '重新读一次画布图并重绘：会话刚写过新图时点它；没有新图就按当前图重画一遍');
  refBtn.dataset.act = 'refresh';
  refBtn.addEventListener('click', () => {
    const label = refBtn.textContent;
    refBtn.disabled = true;
    refBtn.textContent = '⏳ 刷新中…';
    flowImportLoad(storeKey, snapDir, false).then(function (r) {
      if (r && r.ok) { say('画布已装入会话写的新图（' + r.nodes + ' 个节点）⇒ 重绘'); flowRedrawUI(); return; }
      say('没有更新的画布图（' + String((r && r.why) || '') + '）⇒ 按当前图重画一遍');
      refBtn.disabled = false;
      refBtn.textContent = label;
      flowRedrawUI();
    }, function () { refBtn.disabled = false; refBtn.textContent = label; flowRedrawUI(); });
  });
  if (head && head.appendChild) head.appendChild(refBtn);
  else bar.insertBefore(refBtn, startBtn.nextSibling);
  // 这里不再有第四个"混在一起的添加入口"。
  fitBtn.addEventListener('click', fit);
  tidyBtn.addEventListener('click', () => { tidy(); });
  chkBtn.addEventListener('click', async () => {
    pathStat = {}; netStat = {}; render();
    const n = await checkPaths();
    // 端口那一轮可能正跑着（4 秒一轮 / 刚提交过）：等它收了再探，否则这次刷新会"什么都没探"、数字是 0
    for (let i = 0; i < 20 && netBusy; i++) await new Promise(r => setTimeout(r, 150));
    const m = await pollNet();
    if (disposed) return;
    if (n > 0 || m > 0) say('✓ 查完了：' + n + ' 个文件、' + m + ' 个端口（节点第三行就是状态）');
    else if (n === 0 && m === 0) say('没有要查的：节点还没填路径/地址（右键节点 → 编辑，或先加一个工具节点）');
    // n === -1：上一轮还没查完，什么都不说
  });
  mdBtn.addEventListener('click', () => exportText('md'));
  clrBtn.addEventListener('click', () => {
    if (!window.confirm('清空整张图？节点和连线都会删掉（磁盘上的文件不动，只是画布上不再显示）。')) return;
    g = { v: 2, nodes: [], edges: [] }; sel = null; save(); render();
    say('已清空（双击空白处就能加第一个节点）');
  });

  // ---- 画布：平移 / 缩放 / 新建 ----
  viewport.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0) return;
    if (ev.target === viewport || ev.target === world || ev.target === svg) {
      closeMenu();
      closeBubble();          // 点画布别处 = 不打算再改这条线了，气泡收掉
      sel = null;
      render();
      dragPan = { mx: ev.clientX, my: ev.clientY, vx: view.x, vy: view.y };
      bindDrag();
      viewport.focus();
    }
  });
  viewport.addEventListener('wheel', (ev) => {
    // ⚠ 下拉菜单 / 编辑弹框自己会滚（类型菜单 8 项靠 overflow-y:auto 上下翻）——
    //   滚轮悬在它们上面时把事件还给它们（直接 return、不 preventDefault），
    //   别抢来缩放画布（否则 .flow-menu 的滚动条永远滚不动，用户 2026-09-23 报的）。
    if (ev.target && ev.target.closest && ev.target.closest('.flow-menu, .flow-dlg-box')) return;
    ev.preventDefault();
    const r = viewport.getBoundingClientRect();
    const mx = ev.clientX - r.left, my = ev.clientY - r.top;
    const old = view.k;
    const next = flowClampN(old * (ev.deltaY < 0 ? 1.12 : 1 / 1.12), 0.3, 2);
    if (next === old) return;
    // 以指针为锚点缩放：指针下的那个世界点保持不动
    view.x = mx - (mx - view.x) * (next / old);
    view.y = my - (my - view.y) * (next / old);
    view.k = next;
    applyView(); render();
  }, { passive: false });
  viewport.addEventListener('dblclick', (ev) => {
    if (ev.target !== viewport && ev.target !== world && ev.target !== svg) return;
    const c = toWorld(ev.clientX, ev.clientY);
    addNode(FLOW_TYPES[0].id, c.x - 84, c.y - 26);
  });
  // ---- 拖文件进画布 = 自动建"素材/参考"节点（2026-09-23 第七轮）----
  // 只收四类内容文件（文案/视频/图片/音频），按类型行的 exts 反向认扩展名；其它扩展名直接跳过并提示。
  // 建出来的节点：name=文件名去扩展名、path=完整路径、mode=已有素材·参考；图片自动用途=参考图。
  // 老壳没有 app.filePath（webUtils 是 Electron 新 API）⇒ 退回 File.path（老 Electron 里一样能拿到真实路径）。
  let dropDepth = 0;   // dragenter/dragleave 成对计数（鼠标从子元素上穿过会多出成对的 enter/leave）
  const dropExt = {};  // '.mp4' -> typeId（只收四类内容，html/预设/工具那些不收）
  FLOW_TYPES.forEach(t => {
    if (t.cat === 'content' && (t.exts || []).length) t.exts.forEach(e => { dropExt[e.toLowerCase()] = t.id; });
  });
  viewport.addEventListener('dragenter', (ev) => {
    ev.preventDefault();
    dropDepth++;
    viewport.classList.add('flow-drop-zone');
  });
  viewport.addEventListener('dragover', (ev) => {
    // ⚠ 不 preventDefault 就没有 drop 事件（拖放默认是"不许放"）
    ev.preventDefault();
    viewport.classList.add('flow-drop-zone');
  });
  viewport.addEventListener('dragleave', (ev) => {
    ev.preventDefault();
    if (--dropDepth <= 0) { dropDepth = 0; viewport.classList.remove('flow-drop-zone'); }
  });
  viewport.addEventListener('drop', (ev) => {
    ev.preventDefault();
    dropDepth = 0;
    viewport.classList.remove('flow-drop-zone');
    if (dlgEl) return;   // 弹框开着 = 正在编辑，拖入先忽略
    const dt = ev.dataTransfer;
    // ★路径解析：素材管理窗口（renderers['file']）是系统级拖拽（主进程 startDrag）——
    //   拖回本窗口时 drop 里的形态可能不止一种，这里通吃：
    //   ① dataTransfer.files（真 File 对象，经 app.filePath / File.path 拿路径）；
    //   ② 拿不到 files 就从 text/uri-list / text/plain 里解析完整路径（兜底）。
    const paths = [];
    const files = (dt && dt.files) || [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const p = (window.app && window.app.filePath) ? window.app.filePath(f) : (f.path || '');
      paths.push({ name: String(f.name || ''), path: p || '' });
    }
    if (!paths.length && dt) {
      let raw = '';
      try { raw = dt.getData('text/uri-list') || dt.getData('text/plain') || ''; } catch (e) { /* ignore */ }
      String(raw).split(/\r?\n/).forEach(line => {
        const s = line.trim();
        if (!s) return;
        let p = s;
        if (/^file:\/\//i.test(s)) {
          try { p = decodeURIComponent(s.replace(/^file:\/\//i, '').replace(/^\/([A-Za-z]:)/, '$1').replace(/\//g, '\\')); } catch (e) { /* ignore */ }
        }
        p = String(p).replace(/[\\/]+/g, '\\');
        if (p) paths.push({ name: p.split(/[\\/]/).pop() || '', path: p });
      });
    }
    if (!paths.length) return;
    const c = toWorld(ev.clientX, ev.clientY);
    let cx = c.x - 84, cy = c.y - 26;   // 让节点中心大致落在指针处（和双击加节点同一个习惯）
    const made = [], skipped = [];
    for (const it of paths) {
      const nm = String(it.name || '');
      const m = /\.([A-Za-z0-9]+)$/.exec(nm);
      const ext = m ? ('.' + m[1].toLowerCase()) : '';
      const tid = ext ? dropExt[ext] : null;
      if (!tid) { skipped.push(nm || '（没名字的文件）'); continue; }
      const t = flowType(tid);
      const spot = flowFreeSpot(cx, cy);
      const n = {
        id: 'n' + Date.now().toString(36) + (seq++),
        type: tid, name: nm.replace(/\.[^.]+$/, ''), desc: '',
        path: it.path, x: spot.x, y: spot.y,
        mode: FLOW_MODE_REF
      };
      if (tid === 'image') n.use = '参考图';   // 图片拖进来的默认用途（不弹框，直接给个合理的）
      g.nodes.push(n);
      made.push(n);
      cx = spot.x; cy = spot.y;               // 下一个文件从刚建的节点位置继续排开
    }
    if (made.length) {
      sel = { type: 'node', id: made[made.length - 1].id };
      save(); render();
      say('已拖入 ' + made.length + ' 个素材/参考节点'
        + (skipped.length ? '；跳过 ' + skipped.length + ' 个（' + skipped.slice(0, 2).join('、') + (skipped.length > 2 ? '…' : '') + '，只收 文案/视频/图片/音频）' : ''));
    } else if (skipped.length) {
      say('拖入的文件都不是画布收的类型（文案/视频/图片/音频）：' + skipped.slice(0, 3).join('、'));
    }
  });
  // 空白右键 = 画布菜单（节点自己的 contextmenu 已经 stopPropagation，不会走到这儿）
  viewport.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    if (dlgEl) return;
    const c = toWorld(ev.clientX, ev.clientY);
    showMenu(ev.clientX, ev.clientY, blankMenu(c.x, c.y));
  });
  viewport.addEventListener('keydown', (ev) => {
    const tag = (ev.target && ev.target.tagName) || '';
    // 弹框/输入框里的按键归它们自己（尤其 Backspace：不然在改名时会顺手把节点删了）
    if (ev.target && (ev.target.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT')) return;
    if (dlgEl) return;
    if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); removeSel(); }
    else if (ev.key === 'Escape') { closeMenu(); closeBubble(); sel = null; render(); }
  });

  let disposed = false;
  // 端口轮询：控制台/工作台的状态点（4 秒一轮；没有这类节点时 netTargets() 为空，等于什么都不做）
  const netTimer = setInterval(() => { if (!disposed) pollNet(); }, 4000);
  canvasInit();   // 多画布：注入标签栏样式 + 写一份清单（磁盘 <快照目录>\app.flow.<id>.canvases.json）
  render();
  // 注意：此刻面板还没被挂进 #grid（renderer.js 是「先调渲染器、再 appendChild」）——
  // 这时量到的尺寸全是 0，直接 fit() 会把缩放压到下限、位置算成负数。
  // 所以等首帧之后（元素已进 DOM、布局完成）再适配一次。
  setTimeout(() => { if (!disposed) { fit(); checkPaths(); pollNet(); } }, 0);
  return () => {   // 面板被销毁（切场景 / ⟳）时的清理：拖动中的 window 监听必须撤掉
    disposed = true;
    dragMove = dragPan = dragWire = null;
    unbindDrag();
    closeMenu(); closeDialog(); closeBubble();   // 气泡也一起收（它的定时器不清，面板销毁后还会响）
    if (toastTimer) clearTimeout(toastTimer);
    if (netTimer) clearInterval(netTimer);
    if (genTimer) clearInterval(genTimer);   // 待生成完成指示灯（4 秒一轮）也一起停
    if (runTimer) clearInterval(runTimer);   // "正在跑"闪烁（2 秒一轮）
    // 画布看门狗也一起停（不然切场景后它还在轮询 import 文件 —— check-gui 第 4 项要的就是这一句）。
    // ★多画布★ 走"当前 storeKey"这一份：切标签时旧 key 的那份已经当场 watchDetach 掉了，不会残留。
    watchDetach(storeKey);
  };
};

// ============ view：通用预览 / 编辑面板（视频工作流 窗口1 用）============
// 干什么：把"当前这一步要看的东西"摊在一个面板里 —— 文本(md/txt，**能直接改、能存盘**) / 图片 / 视频 / 音频 / 网页。
// 谁驱动它：别的面板把文件递过来（流程画布双击「文案」节点 ⇒ V.show({path})）。
//   面板都在**同一个文档**里 ⇒ 靠 window.__kunViews[面板id] 这个小注册表互相调函数，
//   **不需要新 IPC**（跨进程的 AI 面板才必须走文件）。
// 为什么把窗口1 从"内嵌 ComfyUI"改成它（用户 2026-09-20 定的）：窗口1 当**通用预览位** ——
//   以后每个节点（文案 / 动画 / 成片）双击都往这里摊，不用为每种东西各开一个面板。
//   ComfyUI 控制台没丢：配在 quickLinks 里，右上角一个按钮就能切过去看。
//
// 场景 json 可配（全选填）：
//   meta.quickLinks  [{ label, url, launchPath }]  右上角常驻入口；带 launchPath 的多一个「🖥 桌面启动」
//   meta.hint        空状态里的自定义说明
// 读文件靠宿主能力 app.file（2026-09-20 新加的 IPC）：没有它 = 主进程还是旧的（没重启过 GUI），
//   这时**图片/视频/网页照样能看**（让内核自己按 file:// 读），只有"文本内容"和"保存"要等重启一次。
// ★2026-10-13★ 收第三个参数 head（面板标题行）：用户要求「功能按键压到标题栏、跟标题共用一排，省内容空间」——
//   拿得到 head ⇒ 文件名 + 那排按键并进标题行，内容区第一行就是正文；
//   拿不到（内部复用调用，例如自我复盘 review-doc 把 view 挂进自己内容区）⇒ 退回原来的体内工具行，单独渲染也不会瞎。
renderers.view = (body, meta, head) => {
  body.classList.add('view-panel');
  const pid = String(meta.id || 'panel');
  const A = window.app && window.app.app;      // 宿主通用能力：开外链 / 定位路径
  const F = window.app && window.app.file;     // 文件读写（没有 = 需要重启一次 GUI）
  const HOME = '预览';
  const storeKey = 'app.view.' + pid;          // 记住上次看的是哪个文件（⟳ / 切场景回来还在）
  const quickLinks = (Array.isArray(meta.quickLinks) ? meta.quickLinks : [])
    .filter(q => q && typeof q === 'object' && (q.url || q.path || q.launchPath));
  let cur = { kind: 'empty', path: '', url: '', title: '', dirty: false, size: 0, mtime: 0 };
  let inner = null;        // 当前主体元素（textarea / img / video / webview / 卡片）
  let disposed = false;
  let readSeq = 0;         // 异步读盘令牌：切得快时，晚回来的那次结果直接丢掉
  let officeStone = 0;     // Office→PDF 转换令牌：转换是异步的（几秒），切走之后晚回来的结果不许抢屏
  let flash = { text: '', cls: '', until: 0 };
  let flashTimer = null;

  const EXT = {
    text: ['md', 'markdown', 'txt', 'json', 'jsonc', 'js', 'mjs', 'cjs', 'ts', 'css', 'py', 'bat', 'cmd', 'ps1', 'vbs',
      'ini', 'cfg', 'conf', 'log', 'csv', 'srt', 'ass', 'vtt', 'yaml', 'yml', 'xml', 'sql', 'toml', 'sh', 'env', 'gitignore'],
    image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif'],
    video: ['mp4', 'webm', 'mov', 'mkv', 'm4v', 'avi'],
    audio: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'],
    // 2026-09-26 加：PDF / Office（「设计杂活」场景要"什么都能预览"）
    pdf: ['pdf'],
    office: ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'rtf', 'odt', 'ods', 'odp', 'wps', 'et', 'dps']
  };
  const extOf = (p) => {
    const m = /\.([A-Za-z0-9]+)$/.exec(String(p || '').trim());
    return m ? m[1].toLowerCase() : '';
  };
  const isHtml = (p) => /^(html?|htm)$/.test(extOf(p));
  // ★2026-10-13★ 用户要求「预览能预览更多类型、别双击就拉系统程序」：把"内核怎么都看不了"的封装 / 二进制类
  //   单列一类（清单跟自我复盘的 SR_EXT_OPAQUE 一致）⇒ 给一张说清楚的卡片 + 卡片里就能系统打开，
  //   而不是把它们当文本读出一屏乱码。认不出扩展名的，靠 openText 里的二进制嗅探兜底。
  const EXT_OPAQUE = ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'psd', 'ai', 'exe', 'dll', 'msi',
    'db', 'sqlite', 'bin', 'iso', 'apk', 'ttf', 'otf', 'woff', 'woff2'];
  function pickKind(p) {
    const e = extOf(p);
    if (isHtml(p)) return 'web';                          // html：先看渲染效果，按钮能切去改源码
    if (EXT.image.indexOf(e) >= 0) return 'image';
    if (EXT.video.indexOf(e) >= 0) return 'video';
    if (EXT.audio.indexOf(e) >= 0) return 'audio';
    if (EXT.pdf.indexOf(e) >= 0) return 'pdf';                 // PDF：交给内核自带的阅读器（webview）
    if (EXT.office.indexOf(e) >= 0) return 'office';           // Office/WPS：内核渲染不了 ⇒ 给一张"怎么打开"的卡片
    if (EXT_OPAQUE.indexOf(e) >= 0) return 'opaque';           // 压缩包/安装包/二进制 ⇒ 提示卡 + 系统打开（★2026-10-13）
    return 'text';                                        // 其余都按文本读；真二进制由 openText 的嗅探退回提示卡
  }
  function fileUrl(p) { return 'file:///' + encodeURI(String(p).replace(/\\/g, '/')).replace(/^\/+/, ''); }
  const fmtSize = (n) => (!n ? '0 B' : (n < 1024 ? n + ' B' : (n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB')));
  const fmtClock = (sec) => {
    if (!sec) return '';
    try {
      const d = new Date(sec * 1000);
      const p2 = (x) => (x < 10 ? '0' + x : '' + x);
      return (d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
    } catch (e) { return ''; }
  };
  function remember(p) { try { if (p) localStorage.setItem(storeKey, p); else localStorage.removeItem(storeKey); } catch (e) { /* ignore */ } }

  // ---- DOM：一条工具行 + 主体 + 一条状态行 ----
  const HEADMODE = !!head;                 // 有标题行 ⇒ 按键并进标题行（见本渲染器顶部说明）
  const bar = el('div', 'view-bar');
  const what = el('div', 'view-what');
  const iconEl = el('span', 'view-icon', '👁');
  const nameEl = el('span', 'view-name', HOME);
  what.appendChild(iconEl); what.appendChild(nameEl);
  const acts = el('div', 'view-acts');
  bar.appendChild(what); bar.appendChild(acts);
  const bodyBox = el('div', 'view-body');
  const statusEl = el('div', 'view-status', '');
  // 2026-10-18（vw-ai 派单 · 可选）：状态行里那串路径也做成「单击即复制」，照自我复盘 fpath 的先例。
  statusEl.style.cursor = 'copy';
  statusEl.title = '点一下复制当前文件路径';
  statusEl.addEventListener('click', () => {
    const txt = String(cur.path || '').trim();
    if (!txt) return;
    const ok = () => say('✓ 已复制：' + txt);
    try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(txt).then(ok, () => { if (viewCopyText(txt)) ok(); }); return; } } catch (e) { /* 落下面 */ }
    if (viewCopyText(txt)) ok();
  });
  if (HEADMODE) {
    head.classList.add('view-head');
    body.classList.add('view-head-mode');            // 空状态行由 CSS :empty 收掉（不白占一行）
    acts.classList.add('view-head-acts');
    nameEl.classList.add('view-head-name');
    // ⚠ 必须插在**标题之后、副标题之前**：.panel-sub 是 flex:1 1 100% 独占一排，
    //   排在它后面的东西会被顶到第三排（自我复盘的窗口二踩过，见工作台项目信息 §23.5）。
    const titleEl = head.querySelector('.panel-title');
    if (titleEl) { head.insertBefore(nameEl, titleEl.nextSibling); head.insertBefore(acts, nameEl.nextSibling); }
    else { head.appendChild(nameEl); head.appendChild(acts); }
    // 标题行同时是拖拽把手 ⇒ 塞进去的东西必须阻断指针事件，否则点了没反应（公共工具，素材管理面板同一条）
    if (window.APP_RENDER_UTILS && window.APP_RENDER_UTILS.wireHeadNoDrag) {
      window.APP_RENDER_UTILS.wireHeadNoDrag(acts);
      window.APP_RENDER_UTILS.wireHeadNoDrag(nameEl);
    }
    // 2026-10-18（宿主实测反馈）：▲ 原来被 makePanel 插在 title 之后、又被这里的 nameEl/acts 挤到**✕ 关闭右边** ⇒
    //   容易误点关闭。现在把 ▲ 挪到**整排按钮最左边**（=「⟳ 重读」左边），并补一次 wireHeadNoDrag。
    const expBtn = head.querySelector('.panel-expand');
    if (expBtn) {
      head.insertBefore(expBtn, acts);
      if (window.APP_RENDER_UTILS && window.APP_RENDER_UTILS.wireHeadNoDrag) window.APP_RENDER_UTILS.wireHeadNoDrag(expBtn);
    }
    body.appendChild(bodyBox); body.appendChild(statusEl);
  } else {
    body.appendChild(bar); body.appendChild(bodyBox); body.appendChild(statusEl);
  }

  const B = {};
  function mkBtn(key, label, title, cls) {
    const b = el('button', 'file-refresh' + (cls ? ' ' + cls : ''), label);
    b.type = 'button';
    if (title) b.title = title;
    B[key] = b;
    acts.appendChild(b);
    return b;
  }
  mkBtn('save', '💾 保存', '存盘（Ctrl+S）—— 只写 D: / E: 盘', 'primary');
  mkBtn('src', '✎ 编辑源码', '把 HTML 切回源码模式改');
  mkBtn('preview', '👁 看效果', '切回渲染效果（有改动会先存盘）');
  mkBtn('reread', '⟳ 重读', '从磁盘重新读一遍（丢掉没保存的手改）');
  mkBtn('sysopen', '🖥 系统打开', '用系统的默认程序打开这个文件');
  mkBtn('reveal', '📂 定位', '在资源管理器里选中它');
  // 2026-10-18（vw-ai 派单 · 宿主点名）：「宿主要能复制文件的具体路径」⇒ 专门一颗按钮。
  mkBtn('copypath', '⧉ 复制路径', '把这个文件的完整路径复制到剪贴板');
  mkBtn('close', '✕ 关闭', '回到空预览（文件不动）');
  // 常驻快捷入口（场景 json 配的）：视频工作流用它留住 ComfyUI 控制台
  quickLinks.forEach((q, i) => {
    const b = mkBtn('ql' + i, String(q.label || q.url || q.path), '切到这个页面：' + (q.url || q.path || q.launchPath));
    b.classList.add('view-quick');
    b.addEventListener('click', () => {
      if (q.url) open({ url: q.url, title: q.label || '' });
      else if (q.path) open({ path: q.path, title: q.label || q.kind || '' });
    });
    if (q.launchPath) {
      const d = mkBtn('qll' + i, '🖥', '桌面启动：' + q.launchPath);
      d.classList.add('view-quick');
      d.addEventListener('click', () => {
        if (A && A.openPath) A.openPath(q.launchPath);
        else say('没有宿主能力，打不开启动器', 'warn');
      });
    }
  });

  // 挂在 bodyBox 上的临时监听（换文件/⟳ 时统一摘掉，别攒着）——图片的滚轮缩放/拖动就挂这儿
  let bodyHooks = [];
  function clearBody() {
    officeStone++;                 // 任何一次"换内容"都让在飞的 Office 转换作废（否则它回来会抢屏）
    bodyHooks.forEach(h => { try { h(); } catch (e) { /* ignore */ } });
    bodyHooks = [];
    if (inner && inner.parentNode) inner.parentNode.removeChild(inner);
    inner = null;
  }
  function say(text, cls, ms) {
    flash = { text: text, cls: cls || '', until: Date.now() + (ms || 3500) };
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { if (!disposed) paintStatus(); }, (ms || 3500) + 30);
    paintStatus();
  }
  function paintStatus() {
    if (flash.until > Date.now() && flash.text) { statusEl.textContent = flash.text; statusEl.className = 'view-status ' + flash.cls; return; }
    statusEl.className = 'view-status';
    if (cur.kind === 'empty') { statusEl.textContent = F ? '' : '当前是旧主进程：文本读写要重启一次 GUI 才有（图片/视频/网页不受影响）'; return; }
    // 只读文档（画布双击「固定流程预设」摊出来的东西）：没有磁盘路径，状态行就印那句"这是什么、为什么不能改"
    if (cur.doc) { statusEl.textContent = cur.note || '只读预览'; return; }
    if (cur.url && !cur.path) { statusEl.textContent = cur.url; return; }
    if (cur.kind === 'dir') { statusEl.textContent = '文件夹 · ' + cur.path; return; }
    if (cur.kind === 'opaque') { statusEl.textContent = cur.path; return; }   // 二进制/封装类：只印路径，别写"已保存"（★2026-10-13）
    const bits = [cur.path];
    if (cur.size) bits.push(fmtSize(cur.size));
    if (cur.mtime) bits.push('改于 ' + fmtClock(cur.mtime));
    bits.push(cur.dirty ? '● 有改动没保存' : '已保存');
    statusEl.textContent = bits.join('  ·  ');
  }
  function paint() {
    const label = cur.title || (cur.path ? flowPathParts(cur.path).file : (cur.url || HOME));
    // 并进标题行时，空状态的「预览」跟面板标题重复 ⇒ 留空（标题行写的就是「预览」）
    nameEl.textContent = (HEADMODE && label === HOME) ? '' : label;
    nameEl.title = cur.path || cur.url || cur.note || '';
    if (cur.kind === 'dir') iconEl.textContent = '📁'; else iconEl.textContent = cur.kind === 'image' ? '🖼' : (cur.kind === 'video' ? '🎞' : (cur.kind === 'audio' ? '🔊'
      : (cur.kind === 'web' ? '🌐' : (cur.kind === 'preset' ? '📋' : (cur.kind === 'text' ? '✎' : (cur.kind === 'office' ? '📘' : (cur.kind === 'opaque' ? '📦' : '👁')))))));
    const isText = cur.kind === 'text' && !!cur.path;
    const webish = cur.kind === 'web';
    const isDir = cur.kind === 'dir';
    const htmlFile = isHtml(cur.path || '');
    // ★2026-09-26★ 按钮要**贴合场景**（用户点名）：目录视图自带「⟳ 刷新 / 📂 用资源管理器打开」，
    //   顶上那排通用的「重读 / 系统打开 / 定位」就是重复且语义不对 ⇒ 目录视图只留「✕ 关闭」。
    const on = {
      save: isText,
      src: webish && htmlFile,
      preview: isText && htmlFile,
      reread: !!(cur.path && cur.kind !== 'empty') && !isDir,
      sysopen: !!(cur.path || cur.url) && !isDir,
      reveal: !!cur.path && !isDir,
      copypath: !!(cur.path || cur.url) && !isDir,   // 2026-10-18：漏登记会导致永远 display:none（宿主实测「按钮没出现」）
      close: cur.kind !== 'empty'
    };
    Object.keys(B).forEach(k => { if (k.indexOf('ql') !== 0) B[k].style.display = on[k] ? '' : 'none'; });
    B.save.classList.toggle('dirty', !!cur.dirty);
    bodyBox.dataset.mode = cur.kind;
    paintStatus();
  }
  function shell(cls) { clearBody(); const d = el('div', cls || 'view-empty'); bodyBox.appendChild(d); inner = d; return d; }
  function card(icon, title, sub, pathText) {
    const d = shell();
    d.appendChild(el('div', 'view-empty-icon', icon));
    d.appendChild(el('div', 'view-empty-title', title));
    if (sub) d.appendChild(el('div', 'view-empty-sub', sub));
    if (pathText) d.appendChild(el('div', 'view-empty-path', pathText));
    return d;
  }
  // 2026-10-20（宿主：「本场景的文件预览默认显示最近打开的文件夹以及常用的文件夹」）
  //   配了 meta.home / meta.homeFolders 才出现；点一下 ⇒ 让 meta.filesPanel 指定的「文件管理」跳过去
  //   （file 面板对外挂了 window.__kunFiles[面板id].open(路径)，同文档直调，不用新 IPC）。
  function buildHome(host) {
    host.classList.add('has-home');     // 让空状态容器放宽（.view-empty 默认按内容收缩，网格会被挤成一列）
    const wrap = el('div', 'view-home');
    host.appendChild(wrap);
    const mkSection = (title) => {
      const box = el('div', 'view-home-sec');
      box.appendChild(el('div', 'view-home-h', title));
      const grid = el('div', 'view-home-grid');
      box.appendChild(grid); wrap.appendChild(box);
      return grid;
    };
    const nameOf = (p) => {
      const t = String(p || '').replace(/[\\/]+$/, '');
      const seg = t.split(/[\\/]/).filter(Boolean).pop();
      return seg || t || String(p || '');
    };
    const chip = (label, p) => {
      const b = el('button', 'view-home-chip');
      b.type = 'button';
      b.appendChild(el('span', 'ico', '📁'));
      const mid = el('span', 'mid');
      mid.appendChild(el('span', 'n', String(label || nameOf(p))));
      mid.appendChild(el('span', 'p', String(p)));
      b.appendChild(mid);
      b.title = p + '\n点击 ⇒ 让「文件管理」跳到这个文件夹';
      b.addEventListener('click', () => {
        const api = (window.__kunFiles || {})[String(meta.filesPanel || '')];
        if (api && api.open) { api.open(p); say('文件管理 → ' + p, 'ok'); }
        else if (A && A.openPath) A.openPath(p);
        else say('这个场景没有可跳转的文件管理面板', 'warn');
      });
      return b;
    };
    const favs = (Array.isArray(meta.homeFolders) ? meta.homeFolders : [])
      .map((x) => (x && typeof x === 'object')
        ? { label: x.label || '', path: String(x.path || x.launchPath || '') }
        : { label: '', path: String(x || '') })
      .filter((x) => !!x.path);
    if (favs.length) {
      const g1 = mkSection('常用文件夹');
      favs.forEach((x) => g1.appendChild(chip(x.label, x.path)));
    }
    const TB2 = window.app && window.app.topbar;
    if (TB2 && TB2.recentFolders) {
      Promise.resolve().then(() => TB2.recentFolders()).then((r) => {
        if (disposed) return;
        const rows = ((r && r.rows) || []).filter((x) => x && x.path);
        if (!rows.length) return;
        const g2 = mkSection('最近打开的文件夹');
        rows.slice(0, 6).forEach((x) => g2.appendChild(chip('', x.path)));
      }).catch(() => { /* 读不到最近记录就不显示这一节 */ });
    }
  }
  // 空状态：说明 + 手填路径打开（没有"选择文件"对话框这回事，直接让用户粘真实路径 —— 他就喜欢写路径）
  function showEmpty(msg) {
    cur = { kind: 'empty', path: '', url: '', title: '', dirty: false, size: 0, mtime: 0 };
    remember('');
    const d = card('👁', meta.hint ? String(meta.hint) : '这里是预览位',
      msg || (meta.emptyMsg != null ? String(meta.emptyMsg)
        : '流程画布上双击一个节点，它对应的文件就摊在这里（文本能直接改、能存盘）。也可以自己填个路径：'));
    if (meta.home || meta.homeFolders) buildHome(d);
    const row = el('div', 'view-open');
    const inp = el('input', 'view-open-input');
    inp.type = 'text';
    inp.placeholder = '<视频工作流>';
    inp.spellcheck = false;
    const go = el('button', 'file-refresh', '打开');
    go.type = 'button';
    const run = () => { const p = inp.value.trim().replace(/^"|"$/g, ''); if (p) open({ path: p }); };
    go.addEventListener('click', run);
    inp.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') { ev.preventDefault(); run(); }
    });
    row.appendChild(inp); row.appendChild(go);
    d.appendChild(row);
    if (quickLinks.length) d.appendChild(el('div', 'view-empty-sub', '右上角的按钮是本场景的常驻入口，点一下就在这儿打开。'));
    paint();
  }
  function needRestart(p) {
    const d = card('🔒', '这个要重启一次 GUI 才能用', F ? '' : '宿主这次启动时还没有文件读写接口（app.file）。重启 GUI 后：文本能直接在这里改、Ctrl+S 存盘。图片/视频/网页不受影响。', p);
    const row = el('div', 'view-open');
    const mk = (label, fn) => { const b = el('button', 'file-refresh', label); b.type = 'button'; b.addEventListener('click', fn); row.appendChild(b); };
    mk('🖥 用系统程序打开', () => { if (A && A.openPath) A.openPath(p); });
    mk('📂 定位', () => { if (A && A.revealPath) A.revealPath(p); });
    d.appendChild(row);
  }

  // ★2026-10-13★ 「预览更多类型」：内核渲染不了、也转不出 PDF 的封装/二进制类（zip/rar/7z/psd/exe/msi/db/iso/apk…）
  //   单独归一类 ⇒ 给一张**说清楚**的卡片 + 卡片里就能「🖥 系统打开 / 📂 定位」，绝不白屏、不静默失败（照自我复盘那份做法）。
  //   ⚠ 它同时是"素材管理双击不再拉系统程序"的兜底：用户双击一个 zip，看到的是这张卡，不是一屏乱码。
  function openOpaque(p, why) {
    const d = card('📦', '这类文件内核看不了：' + flowPathParts(p).file,
      (why ? why + '。' : '') + '它属于压缩包 / 安装包 / 二进制这类格式（内核渲染不了，也转不出 PDF）。'
      + '看内容请用系统程序打开；要在这里看，请选文本、图片、视频、音频、PDF、Office 或 HTML。', p);
    const row = el('div', 'view-open');
    const mk = (label, fn) => { const b = el('button', 'file-refresh', label); b.type = 'button'; b.addEventListener('click', fn); row.appendChild(b); };
    mk('🖥 用系统程序打开', () => { if (A && A.openPath) A.openPath(p); else say('没有宿主能力，打不开', 'warn'); });
    mk('📂 定位', () => { if (A && A.revealPath) A.revealPath(p); });
    d.appendChild(row);
    remember(p);
  }

  async function flushDirty() {
    if (!(cur.dirty && cur.kind === 'text' && cur.path && inner && inner.tagName === 'TEXTAREA')) return;
    if (!F || !F.write) { cur.dirty = false; return; }
    const p = cur.path, text = inner.value;
    let r = null;
    try { r = await F.write(p, text); } catch (e) { r = { ok: false, err: String((e && e.message) || e) }; }
    cur.dirty = false;
    if (r && r.ok) { cur.size = r.size || cur.size; cur.mtime = r.mtime || cur.mtime; say('✓ 切走之前先自动存了：' + flowPathParts(p).file, 'ok'); }
    else say('⚠ 自动保存失败：' + ((r && r.err) || '未知'), 'bad');
  }
  async function saveText() {
    if (!(cur.kind === 'text' && cur.path && inner && inner.tagName === 'TEXTAREA')) return false;
    if (!F || !F.write) { say('宿主还没重启过：重启一次 GUI 才能写文件', 'warn'); return false; }
    const r = await F.write(cur.path, inner.value);
    if (r && r.ok) {
      cur.dirty = false; cur.size = r.size || 0; cur.mtime = r.mtime || 0;
      say('✓ 已保存 ' + fmtClock(r.mtime) + '  ·  ' + cur.path, 'ok');
    } else say('⚠ ' + ((r && r.err) || '保存失败'), 'bad');
    paint();
    return !!(r && r.ok);
  }

  async function openText(p) {
    const stone = ++readSeq;
    card('⏳', '正在读：' + flowPathParts(p).file, '', p);
    if (!F || !F.read) { needRestart(p); return; }
    let r = null;
    try { r = await F.read(p); } catch (e) { r = { ok: false, err: String((e && e.message) || e) }; }
    if (disposed || stone !== readSeq) return;
    if (!r || !r.ok) {
      const d = card('⚠', '打不开这个文件', (r && r.err) || '未知错误', p);
      const row = el('div', 'view-open');
      const mk = el('button', 'file-refresh', '📄 新建空文件');
      mk.type = 'button';
      mk.addEventListener('click', async () => {
        const w = await F.write(p, '');
        if (w && w.ok) openText(p); else say('新建失败：' + ((w && w.err) || ''), 'bad');
      });
      const mk2 = el('button', 'file-refresh', '🖥 系统打开');
      mk2.type = 'button';
      mk2.addEventListener('click', () => { if (A && A.openPath) A.openPath(p); });
      row.appendChild(mk); row.appendChild(mk2);
      d.appendChild(row);
      remember('');
      return;
    }
    cur.size = r.size || 0; cur.mtime = r.mtime || 0; cur.dirty = false;
    // ★2026-10-13★ 认不出扩展名、其实是二进制的文件（无后缀 / .sample 这类）：读回来出现 NUL 或大量坏字符
    //   （U+FFFD = utf8 解不开的字节）⇒ 退回"看不了"卡片，绝不把乱码糊在面板里（照自我复盘那份做法）。
    const rawTxt = r.text == null ? '' : String(r.text);
    if (rawTxt && (rawTxt.indexOf('\u0000') >= 0 || (rawTxt.match(/\uFFFD/g) || []).length > 8)) {
      cur.kind = 'opaque'; paint();
      return openOpaque(p, '这个文件其实是二进制');
    }
    clearBody();
    const ta = el('textarea', 'view-ta');
    ta.value = r.text == null ? '' : String(r.text);
    ta.spellcheck = false;
    ta.addEventListener('input', () => { if (!cur.dirty) { cur.dirty = true; paint(); } });
    ta.addEventListener('keydown', (ev) => {
      ev.stopPropagation();                                  // 别让快捷键跑到宿主/画布那边去
      if ((ev.ctrlKey || ev.metaKey) && (ev.key === 's' || ev.key === 'S')) { ev.preventDefault(); saveText(); }
      else if (ev.key === 'Tab') {                           // 改 HTML / 脚本时 Tab 缩进比切焦点有用
        ev.preventDefault();
        const s = ta.selectionStart, e2 = ta.selectionEnd;
        ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(e2);
        ta.selectionStart = ta.selectionEnd = s + 2;
        if (!cur.dirty) { cur.dirty = true; paint(); }
      }
    });
    bodyBox.appendChild(ta);
    inner = ta;
    remember(p);
    paint();
    try { ta.focus(); } catch (e) { /* ignore */ }
  }
  function openImage(p) {
    clearBody();
    const img = el('img', 'view-img');
    img.alt = flowPathParts(p).file;
    // ★ 本地图片**优先走宿主 IPC 读成 data: URL**（app.oa.image，上限 12MB）——跟文件面板的大图同一条路。
    //   为什么不让 file:// 先试：2026-09-26 用户实测"预览里本地图打不开"，而 data: 这条路一直是通的
    //   （data: 是 CSP 一直放行的源；file:// 在不同内核/CSP 组合下不一定通）。IPC 读不了（比如 >12MB）再退回 file://。
    const K = window.app && window.app.oa;
    let imgTriedFile = false;
    const useFile = () => {
      if (imgTriedFile || disposed) return;
      imgTriedFile = true;
      img.src = fileUrl(p);
      img.addEventListener('error', () => {
        if (disposed) return;
        say('图片没显示出来：文件不在、或者它其实不是图片'
          + '（名字以 ._ 开头的是 macOS 元数据文件，4KB 左右，不是图）', 'bad');
      }, { once: true });
    };
    if (K && K.image && p) {
      Promise.resolve(K.image(p)).then(r => {
        if (disposed) return;
        if (r && r.ok && r.dataUrl) img.src = r.dataUrl;
        else useFile();                                  // 读不到（例如超过 12MB）⇒ 退回 file://
      }).catch(useFile);
    } else {
      useFile();
    }
    bodyBox.appendChild(img); inner = img;
    // ★ 滚轮放大 / 拖动平移 / 双击复原（2026-09-26 用户要求："显示图片时可以滚轮放大缩小看细节"）
    //   做法：只动图片自己的 transform —— translate(tx,ty) scale(z)，原点固定 0 0（不动面板布局）。
    //   滚轮以**光标所在的那个点**为锚（缩放时它在屏幕上原地不动，否则一放大就跑偏，细节没法看）：
    //   锚点坐标要的是"没缩放时的矩形"，所以量之前先把 transform 摘掉再量，同一帧内改回去（不闪屏）。
    //   监听挂在 bodyBox 上（图片小的时候，边上的黑边也能滚），换文件时由 clearBody 统一摘掉。
    img.style.transformOrigin = '0 0';
    img.style.cursor = 'zoom-in';
    let z = 1, tx = 0, ty = 0, lastPct = 100, dragging = false, lx = 0, ly = 0;
    const applyT = () => { img.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + z + ')'; };
    const baseRect = () => {
      const keep = img.style.transform;
      img.style.transform = 'none';
      const r = img.getBoundingClientRect();
      img.style.transform = keep;
      return r;
    };
    const onWheel = (e) => {
      if (!img.clientWidth) return;
      e.preventDefault();                                   // 别让面板/页面跟着滚
      const r = baseRect();
      const cx = e.clientX - r.left, cy = e.clientY - r.top;
      const nz = Math.min(20, Math.max(0.2, z * Math.exp(-e.deltaY * 0.0016)));
      if (nz === z) return;
      tx += cx * (z - nz);                                  // 光标那个点原地不动（推导见上）
      ty += cy * (z - nz);
      z = nz; applyT();
      img.style.cursor = z > 1.01 ? 'grab' : 'zoom-in';
      const pct = Math.round(z * 100);
      if (pct !== lastPct) {                                // 别每个滚轮事件都刷状态行
        lastPct = pct;
        say('缩放 ' + pct + '%' + (z > 1.01 ? ' · 按住拖动平移 · 双击复原' : ''), '', 1400);
      }
    };
    const onDown = (e) => {
      if (z <= 1.01 || e.button !== 0) return;              // 没放大 = 不拖动（保持原来的选中/拖拽行为）
      dragging = true; lx = e.clientX; ly = e.clientY;
      img.style.cursor = 'grabbing';
      try { bodyBox.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      e.preventDefault();
    };
    const onMove = (e) => {
      if (!dragging) return;
      tx += e.clientX - lx; ty += e.clientY - ly;
      lx = e.clientX; ly = e.clientY;
      applyT();
    };
    const onUp = () => { if (!dragging) return; dragging = false; img.style.cursor = z > 1.01 ? 'grab' : 'zoom-in'; };
    const onDbl = () => {
      z = 1; tx = 0; ty = 0; applyT(); lastPct = 100;
      img.style.cursor = 'zoom-in';
      say('已复原成适应窗口（滚轮放大，放大后按住拖动看细节）', '', 1600);
    };
    bodyBox.addEventListener('wheel', onWheel, { passive: false });
    bodyBox.addEventListener('pointerdown', onDown);
    bodyBox.addEventListener('pointermove', onMove);
    bodyBox.addEventListener('pointerup', onUp);
    bodyBox.addEventListener('pointercancel', onUp);
    bodyBox.addEventListener('dblclick', onDbl);
    bodyHooks.push(() => {
      bodyBox.removeEventListener('wheel', onWheel);
      bodyBox.removeEventListener('pointerdown', onDown);
      bodyBox.removeEventListener('pointermove', onMove);
      bodyBox.removeEventListener('pointerup', onUp);
      bodyBox.removeEventListener('pointercancel', onUp);
      bodyBox.removeEventListener('dblclick', onDbl);
    });
    remember(p);
    paint();
  }
  function openMedia(p, kind) {
    clearBody();
    const v = el(kind === 'audio' ? 'audio' : 'video', 'view-media-el');
    v.controls = true;
    v.src = fileUrl(p);
    bodyBox.appendChild(v); inner = v;
    remember(p);
    paint();
  }
  function openWeb(src) {
    clearBody();
    const wv = document.createElement('webview');
    wv.setAttribute('partition', 'persist:view-' + pid.replace(/[^A-Za-z0-9_-]/g, '_'));
    wv.setAttribute('allowpopups', '');
    wv.setAttribute('src', src);
    wv.className = 'view-web';
    bodyBox.appendChild(wv); inner = wv;
    if (cur.path) remember(cur.path);
    paint();
  }
  // ---- PDF：用内核自带的 PDF 阅读器（<webview> 载 file://）----
  // 为什么不自己解析：Electron 自带 Chromium 的 PDF 查看器，翻页 / 缩放 / 搜索 / 打印都是现成的。
  // 万一这台机器上没出图（少数情况），工具栏的「🖥 系统打开」是兜底。
  function openPdf(p) {
    clearBody();
    const wv = document.createElement('webview');
    wv.setAttribute('partition', 'persist:view-' + pid.replace(/[^A-Za-z0-9_-]/g, '_'));
    wv.setAttribute('src', fileUrl(p));
    wv.className = 'view-web';
    bodyBox.appendChild(wv); inner = wv;
    remember(p);
    paint();
    say('PDF：用页面自带的工具条翻页/缩放；没显示出来就点「🖥 系统打开」', '', 6000);
  }
  // ---- Office / WPS 文档（★2026-10-13 升级：从"只能说怎么打开"变成"真能看"）----
  // 旧版只摊一张说明卡。现在先让主进程借本机装的 Office 把它转成 PDF（按文件缓存），
  //   转成功就直接喂给内核自带 PDF 阅读器 ⇒ Word / Excel / PPT 在这里就能看，版式是 Office 自己排的。
  // 转不动（.wps/.et/.dps 这类 WPS 私有格式、本机没装 Office、或主进程还是旧的）才退回那张说明卡，
  //   并把**具体原因**印在卡上 —— 用户明确要求"不要白屏、不要静默失败"。
  function openOffice(p) {
    const api = (window.app && window.app.file) || null;
    if (!api || typeof api.toPdf !== 'function') {
      openOfficeCard(p, '当前主进程还是旧的（没有 doc→PDF 接口）—— 重启一次 GUI 就能在这里内嵌预览');
      return;
    }
    clearBody();
    const stone = ++officeStone;        // clearBody 之后再取号：此后任何一次换内容都会让它作废
    const wrap = el('div', 'view-doc');
    wrap.appendChild(el('pre', 'view-doc-pre',
      '正在把这份 .' + extOf(p) + ' 转成 PDF 预览…\n\n'
      + '· 借本机装的 Office 转一次；第一次大约几秒，转完按文件缓存，再打开就是秒开\n'
      + '· 版式由 Office 自己排，跟原文件一致（翻页/缩放/搜索都用 PDF 阅读器那套）\n'
      + '· 不想等：直接点工具栏「🖥 系统打开」'));
    bodyBox.appendChild(wrap); inner = wrap;
    if (cur.path) remember(cur.path);
    paint();
    say('转换中…', '', 0);
    Promise.resolve(api.toPdf(p)).then(function (r) {
      if (disposed || stone !== officeStone) return;        // 期间切到别的文件了 ⇒ 丢掉这次结果
      if (r && r.ok && r.pdf) {
        openPdf(r.pdf);
        // openPdf 会把"上次看的文件"记成 %TEMP% 里那份转换产物 —— 这里改回**原始文档**：
        // 否则下次开面板会去恢复一个临时 PDF（临时目录一清就找不到，还会让人以为在预览 PDF）。
        remember(p);
        say(r.cached ? 'PDF（缓存命中）· 翻页/缩放用页面自带工具条' : '已转成 PDF 预览 · 下次打开秒开', '', 5000);
        return;
      }
      openOfficeCard(p, String((r && r.err) || '转换成 PDF 失败'));
    }).catch(function (e) {
      if (disposed || stone !== officeStone) return;
      openOfficeCard(p, '转换异常：' + String((e && e.message) || e));
    });
  }
  // 兜底卡片（转不动时才用）：说清是什么格式、为什么看不了、下一步点哪儿
  function openOfficeCard(p, why) {
    clearBody();
    const wrap = el('div', 'view-doc');
    const e = extOf(p);
    wrap.appendChild(el('pre', 'view-doc-pre',
      '这种格式（.' + e + '）没法内嵌预览。\n\n'
      + (why ? '原因：' + why + '\n\n' : '')
      + '三种做法：\n'
      + '  · 点工具栏「🖥 系统打开」—— 用 Word / WPS / Office 打开它（最常用）\n'
      + '  · 先在 Office 里「另存为 PDF」，PDF 能在预览面板里直接看\n'
      + '  · 只是要看/改文字：把内容贴给我，我在 AI 面板里处理'));
    wrap.appendChild(el('div', 'view-preset-cap', '文件'));
    wrap.appendChild(el('pre', 'view-preset-prompt', String(p)));
    bodyBox.appendChild(wrap); inner = wrap;
    remember(p);
    paint();
  }
  // ---- 两类"没有文件"的只读预览（画布上双击「固定流程预设」摊到这儿的东西）----
  // 共同点：都不读盘、不能改、**不写 last（remember）** —— 它们不是"上次看的文件"，
  //   写了的话下次开面板会试图按路径打开一个空路径。要改内容 = 回画布右键那个节点。
  // ① 只读文档（预览形式 = 文字说明）：把步骤 + 指令模板整段摊出来。
  //    为什么不用 readonly 的 textarea：那看着像"能改但点不动"，反而让人反复试；pre 一眼就是"看的"。
  function openDoc(o) {
    cur = {
      kind: 'text', path: '', url: '', title: String(o.title || ''), dirty: false, size: 0, mtime: 0,
      doc: true, note: String(o.note || '只读预览（要改就回画布右键那个节点 → ✎ 编辑节点）')
    };
    clearBody();
    const wrap = el('div', 'view-doc');
    // 用 pre 而不是普通 div：步骤/指令里的换行、缩进都是内容的一部分，不能被 HTML 折叠掉
    wrap.appendChild(el('pre', 'view-doc-pre', String(o.text == null ? '' : o.text)));
    bodyBox.appendChild(wrap); inner = wrap;
    paint();
  }
  // ② 流程图小图（预览形式 = 流程图小图）：小方块 + 箭头，**纯 HTML/CSS 的静态示意图**。
  //    ⚠ 这里是预览，不是可编辑画布 ⚠ —— 不拖、不连、不存盘。为什么不复用画布那套 DOM/SVG 内核：
  //    那套是编辑器（几十个事件 + 缩放 + 平移 + localStorage），为了画几个方块引进来，
  //    既拖慢预览面板，又会让人以为"这儿能连线"（不能，改法只有一个：右键画布上那个节点）。
  function openPresetMini(o) {
    const steps = (Array.isArray(o.steps) ? o.steps : []).map(s => String(s == null ? '' : s).trim()).filter(s => !!s);
    cur = {
      kind: 'preset', path: '', url: '', title: String(o.title || ''), dirty: false, size: 0, mtime: 0,
      doc: true, note: '固定流程预设 · ' + steps.length + ' 步（只读的示意图 —— 要改步骤就右键画布上那个节点）'
    };
    clearBody();
    const wrap = el('div', 'view-preset');
    if (!steps.length) wrap.appendChild(el('div', 'view-preset-empty', '这个预设还没写步骤（右键画布上那个节点 → ✎ 编辑节点，或在内置模板里挑一个）'));
    steps.forEach((s, i) => {
      const bx = el('div', 'view-preset-step');
      bx.appendChild(el('span', 'view-preset-no', String(i + 1)));
      bx.appendChild(el('span', 'view-preset-txt', s));
      wrap.appendChild(bx);
      if (i < steps.length - 1) {
        const ar = el('div', 'view-preset-arrow', '↓');
        ar.title = '下一步';
        wrap.appendChild(ar);
      }
    });
    const prompt = String(o.prompt || '').trim();
    if (prompt) {
      wrap.appendChild(el('div', 'view-preset-cap', '指令模板'));
      wrap.appendChild(el('pre', 'view-preset-prompt', prompt));
    }
    wrap.appendChild(el('div', 'view-preset-tip', '⚠ 这里是预览、不是可编辑画布 —— 要改步骤或指令，右键画布上那个节点 → ✎ 编辑节点'));
    bodyBox.appendChild(wrap); inner = wrap;
    paint();
  }

  // ★2026-09-26★ 项目文件夹（画布上双击「项目文件夹」节点）= 在预览面板里**摊开这个文件夹**：
  //   图片、视频直接给缩略图（视频用 <video preload="metadata"> 出首帧），双击任意一项 = 在**这个面板里**
  //   看/播（图片大图、视频/音频带播放条、文本可改可存）；顶部两个按钮：⟳ 刷新、📂 用资源管理器打开。
  //   列目录借宿主现成的 `app.oa.filesLocal`（= `oa:files:local`，本来是给 OA 用的，其实是通用的本地列目录，
  //   **不用新 IPC、不用重启 GUI**）。找不到预览面板时画布那边会退回"直接用资源管理器打开"。
  // ★2026-09-26★ 目录视图的小样式：**就地注入一段 <style>**（不去动 styles.css —— 那份不一定跟着热重载，
  //   而这里注入的只作用于 .kun-dir-* 这几个类名；幂等：已经插过就不重复插）。
  function ensureDirCss() {
    // ★2026-09-27 用户反馈：「文件夹预览里面的 md 文件显示太差了，可以显示文件名和图标」★
    //   原来是"缩略图区里放一个 📄 emoji + 下面一行窄窄的文件名"，实际看着就是**一张几乎全黑的空卡片**。
    //   现在：非图片/视频的文件（md/txt/json/srt…）走 `.plain` 卡片 —— **扩展名徽标当图标 + 文件名占两行**。
    //   ⚠ 必须带版本判据：老写法只有 `if (已存在) return`，改了 CSS 也不生效（同 ensureRunCss 那条经验）。
    // ★2026-09-27 v3 ★ 「卡片被压成 21~50px 横条」那条 bug 的修复就在下面这几条规则里（根因与量到的数字
    //   写在 .kun-dir-grid 那段注释里）。**版本号必须跟着改**（v2-filecards → v3-rows-fixed），
    //   否则老的 <style> 已经在文档里、`data-ver` 一样就直接 return，改了的 CSS 一条都不生效 —— 这条经验踩过两次。
    const VER = 'v4-grid-scroll';
    const old = document.getElementById('kun-view-dir-css');
    if (old && old.getAttribute('data-ver') === VER) return;
    if (old && old.parentNode) old.parentNode.removeChild(old);
    const st = document.createElement('style');
    st.id = 'kun-view-dir-css';
    st.setAttribute('data-ver', VER);
    st.textContent = [
      '.kun-dir-bar{display:flex;align-items:center;gap:8px;padding:7px 9px;border-bottom:1px solid var(--border);}',
      '.kun-dir-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--mono);font-size:11px;color:var(--text-dim);}',
      '.kun-dir-btn{display:inline-flex;align-items:center;gap:5px;padding:4px 11px;border-radius:7px;cursor:pointer;font:inherit;font-size:11.5px;line-height:1.5;color:var(--text);background:rgba(255,255,255,.05);border:1px solid var(--border);transition:background .14s ease,border-color .14s ease,transform .1s ease;}',
      '.kun-dir-btn:hover{background:rgba(255,255,255,.11);border-color:var(--accent);}',
      '.kun-dir-btn:active{transform:translateY(1px);}',
      // ★2026-09-27 修「卡片被压成横条」★（用户截图：预览面板摊开项目文件夹，26 张卡每张只剩 ~21~50px 高的
      //   一条压扁/裁切的图片，文件名和大小全看不见）。
      //   根因：`.kun-dir-grid` 是 `flex:1` + `min-height:0` 的 flex item，而预览面板只占 2×2 格
      //   （scenarios\video-workflow.json 的 vw-view = col1,row4,w2,h2；主窗口 1558×913 ⇒ 面板体 ≈770×314
      //   ⇒ 网格只剩 ≈218px 高），grid 内容却要 ≈1008px ⇒ flex 把网格**压到内容高度以下**，
      //   grid-auto-rows 默认 auto 的行一起被压成 20.5px（真浏览器量到：卡 21px、行 20.5312px、
      //   而 .kun-dir-thumb 的 computed height 仍是 118px ⇒ 缩略图整个溢出卡片，
      //   被 `.kun-dir-card{overflow:hidden}` 裁掉下半 ⇒ 只剩一条图片横条，名字/大小全被吃掉）。
      //   修法（打不烂的写法）：① 网格**不再参与收缩**（flex:none）+ 行高不压缩（grid-auto-rows:max-content）
      //     ⇒ 网格永远按内容排满，装不下就自己滚动（wrap 有 min-height:0，滚动条落在网格内部）；
      //   ② 卡片一律 flex 列布局 + min-height:0，缩略图 flex:none 不被压；
      //   ③ JS 里再给 thumb/img/video/name/meta 写**内联兜底尺寸**（见 openDir），样式被别处覆盖也塌不了。
      // ★2026-09-27 再修（用户反馈"预览不全"）★：上一版写成 `flex:none`（不参与收缩）⇒ 网格按**内容高度**撑到 1000+px，
      //   超出面板的部分被裁掉、**下面那些项够不到**。正解 = **允许收缩到面板高度 + 内部滚动**（`flex:1 1 auto` + `min-height:0` + `overflow:auto`），
      //   同时保留 `grid-auto-rows:max-content` —— 那才是最初"卡片被压成横条"的真根因（行高被压扁）。
      '.kun-dir-grid{flex:1 1 auto;min-height:0;overflow:auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));grid-auto-rows:max-content;gap:9px;padding:10px;align-content:start;}',
      '.kun-dir-card{display:flex;flex-direction:column;min-height:0;border:1px solid var(--border);border-radius:9px;overflow:hidden;cursor:pointer;background:var(--bg-panel);transition:border-color .14s ease,box-shadow .14s ease,transform .1s ease;}',
      '.kun-dir-card:hover{border-color:var(--accent);box-shadow:0 4px 14px rgba(0,0,0,.35);transform:translateY(-1px);}',
      '.kun-dir-thumb{height:118px;flex:none;display:flex;align-items:center;justify-content:center;background:#0d1424;font-size:34px;overflow:hidden;}',
      // ★媒体缩略图按**原始比例**铺满（object-fit:contain）——不加这条 <video> 会被拉变形/裁掉★（2026-09-27 用户："合适比例显示不要压缩"）
      '.kun-dir-thumb>img,.kun-dir-thumb>video{display:block;width:100%;height:100%;object-fit:contain;background:#0a1120;}',
      // 文件名/尺寸行：flex:none + 最多两行（媒体卡与徽标卡**同一条规则**，不再分叉；长文件名换行不裁字）
      '.kun-dir-name{flex:none;padding:6px 8px 2px;font-size:11px;line-height:1.35;color:var(--text);'
        + 'white-space:normal;word-break:break-all;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;}',
      '.kun-dir-meta{flex:none;padding:0 8px 7px;font-size:10px;color:var(--text-dim);font-family:var(--mono);white-space:nowrap;}',
      '.kun-dir-empty{grid-column:1/-1;padding:22px 10px;text-align:center;color:var(--text-dim);font-size:12px;}',
      // ---- 非媒体文件（md/txt/json/srt/csv…）：不用 emoji 兜底，直接"扩展名徽标 + 两行文件名" ----
      '.kun-dir-card.plain .kun-dir-thumb{height:auto;min-height:66px;background:transparent;padding:13px 8px 4px;font-size:0;}',
      '.kun-dir-ext{display:inline-flex;align-items:center;justify-content:center;min-width:46px;padding:7px 12px;border-radius:9px;'
        + 'font-family:var(--mono);font-size:14px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;'
        + 'color:#7fe3ff;background:rgba(77,226,255,.13);border:1px solid rgba(77,226,255,.34);}',
      // 文件夹也用徽标（emoji 在不同机器上不一定有）
      '.kun-dir-card.dir .kun-dir-thumb{height:auto;min-height:66px;background:transparent;font-size:0;padding:13px 8px 4px;}',
      '.kun-dir-badge{display:inline-flex;align-items:center;justify-content:center;min-width:46px;padding:7px 12px;border-radius:9px;'
        + 'font-size:17px;color:#ffd479;background:rgba(224,179,65,.14);border:1px solid rgba(224,179,65,.36);}',
    ].join('\n');
    (document.head || document.body).appendChild(st);
  }
  async function openDir(p) {
    // ⚠ 先把整个 body 清干净：`clearBody()` 只删 `inner` 那**一个**节点，而这个视图有"工具条 + 网格"两块 ⇒
    //   只清 inner 会留下旧工具条（实测：双击两次 ⇒ 两根工具条叠着、卡片还被后来的空状态顶掉 ✗）。
    while (bodyBox.firstChild) bodyBox.removeChild(bodyBox.firstChild);
    inner = null;
    ensureDirCss();
    const K = (window.app && window.app.oa) || null;
    // 工具条 + 网格**包在一个 wrap 里**，wrap 就是 inner ⇒ 以后任何 clearBody() 都能一次清掉整块
    const wrap = el('div', 'view-dirwrap');
    wrap.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;';
    bodyBox.appendChild(wrap); inner = wrap;
    const bar = el('div', 'kun-dir-bar');
    const t = el('div', 'kun-dir-path', p);
    t.title = p;
    const bRef = el('button', 'kun-dir-btn', '⟳ 刷新');
    const bOpen = el('button', 'kun-dir-btn', '📂 用资源管理器打开');
    bar.appendChild(t); bar.appendChild(bRef); bar.appendChild(bOpen);
    wrap.appendChild(bar);
    const grid = el('div', 'kun-dir-grid');
    wrap.appendChild(grid);
    // ★2026-09-27 用户要求：「合适比例显示不要压缩，加个滚轮」★
    //   Ctrl/⌘ + 滚轮 = 调缩略图大小（72~320px，同时改卡片宽度）；**普通滚轮照旧滚动列表**（不抢滚动）。
    //   只作用在媒体卡（图片/视频）上；.plain/.dir 那种徽标卡高度自适应，别被内联高度压住。
    let thumbH = 118;
    const applyThumbSize = () => {
      const h = Math.round(thumbH);
      grid.style.gridTemplateColumns = 'repeat(auto-fill,minmax(' + Math.round(thumbH * 1.27) + 'px,1fr))';
      grid.querySelectorAll('.kun-dir-card:not(.plain):not(.dir) .kun-dir-thumb').forEach((x) => {
        // ⚠ 三个一起写：只写 height 的话，别的规则里的 flex-shrink / max-height 还是能把它压扁
        //   （2026-09-27 那条"卡片压成横条"的 bug 就是被 flex 压的）⇒ height + min/max 全部钉死。
        x.style.height = h + 'px';
        x.style.minHeight = h + 'px';
        x.style.maxHeight = h + 'px';
        x.style.flex = '0 0 auto';
      });
    };
    grid.addEventListener('wheel', (ev) => {
      if (!ev.ctrlKey && !ev.metaKey) return;                 // 普通滚轮 = 正常滚动
      ev.preventDefault();
      thumbH = Math.max(72, Math.min(320, thumbH * (ev.deltaY < 0 ? 1.12 : 0.9)));
      applyThumbSize();
      say('缩略图 ' + Math.round(thumbH) + 'px（Ctrl+滚轮 继续调；普通滚轮 = 滚动列表）', '', 1600);
    }, { passive: false });
    bRef.addEventListener('click', () => openDir(p));
    bOpen.addEventListener('click', () => { const A2 = window.app && window.app.app; if (A2 && A2.openPath) A2.openPath(p); else say('没有宿主打开能力', 'warn'); });
    if (!K || !K.filesLocal) {
      grid.appendChild(el('div', 'view-empty-s', '宿主没有列目录的能力（app.oa.filesLocal）—— 这台 GUI 版本旧了'));
      paint(); return;
    }
    const r = await K.filesLocal(p);
    if (disposed) return;
    if (!r || !r.ok) { grid.appendChild(el('div', 'view-empty-s', '读不了这个文件夹：' + ((r && r.err) || p))); paint(); return; }
    const rows = (r.rows || []).filter(x => !/^\./.test(x.name));
    if (!rows.length) { grid.appendChild(el('div', 'view-empty-s', '这个文件夹还是空的 —— 产物生成后会出现在这儿')); paint(); return; }
    const IMG = /\.(png|jpe?g|webp|gif|bmp)$/i, VID = /\.(mp4|mov|mkv|webm|avi|m4v)$/i, AUD = /\.(mp3|wav|m4a|flac|aac)$/i;
    const fmtSize = (n) => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : (n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B');
    let nMedia = 0;
    // ★内联兜底尺寸（2026-09-27 修"卡片压成横条"那条 bug 的第二道防线）★
    //   为什么非要写内联：这次的根因是**容器被 flex 压缩**导致卡片只剩 21px，将来任何一条别的规则
    //   （新加的 .flow-node* 段、全局 img/div 规则、主题覆盖…）都可能再把它压一次。
    //   把每张卡的**骨架尺寸直接钉在元素 style 上**，样式表被谁盖了都塌不了：
    //     thumb 高（媒体卡）/ min-height（徽标卡）、img/video 充满且 contain、name 两行、meta 一行。
    const THUMB_FALLBACK = 'flex:0 0 auto;height:' + Math.round(thumbH) + 'px;min-height:' + Math.round(thumbH) + 'px;'
      + 'display:flex;align-items:center;justify-content:center;overflow:hidden;';
    const MEDIA_FALLBACK = 'display:block;width:100%;height:100%;max-width:100%;max-height:100%;object-fit:contain;flex:0 0 auto;';
    const BADGE_FALLBACK = 'flex:0 0 auto;height:auto;min-height:66px;display:flex;align-items:center;justify-content:center;overflow:hidden;';
    const NAME_FALLBACK = 'flex:0 0 auto;min-height:15px;padding:6px 8px 2px;font-size:11px;line-height:1.35;overflow:hidden;'
      + 'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-all;';
    const META_FALLBACK = 'flex:0 0 auto;padding:0 8px 7px;font-size:10px;line-height:1.3;white-space:nowrap;overflow:hidden;';
    rows.forEach(it => {
      const full = p.replace(/[\\/]+$/, '') + '\\' + it.name;
      const card = el('div', 'kun-dir-card');
      card.title = it.name + (it.isDir ? '\n双击进入这个子文件夹' : (IMG.test(it.name) ? '\n双击看大图' : ((VID.test(it.name) || AUD.test(it.name)) ? '\n双击播放' : '\n双击打开')));
      const thumb = el('div', 'kun-dir-thumb');
      // ★非图片/视频：给"扩展名徽标 + 两行文件名"的卡片（不再靠 emoji 兜底 —— 用户反馈那些 md 看着就是一张空卡）★
      const extOf = (n) => { const m = /\.([A-Za-z0-9]{1,5})$/.exec(n || ''); return m ? m[1].toLowerCase() : '文件'; };
      const isBadge = it.isDir || (!IMG.test(it.name) && !VID.test(it.name));
      thumb.style.cssText = isBadge
        ? (BADGE_FALLBACK + 'background:transparent;font-size:0;padding:13px 8px 4px;')
        : THUMB_FALLBACK;
      if (it.isDir) { card.classList.add('dir'); const b = el('span', 'kun-dir-badge', '📁'); b.textContent = '📁'; thumb.appendChild(b); }
      else if (IMG.test(it.name)) { const im = el('img', ''); im.src = fileUrl(full); im.loading = 'lazy'; im.style.cssText = MEDIA_FALLBACK; thumb.appendChild(im); nMedia++; }
      else if (VID.test(it.name)) { const vd = document.createElement('video'); vd.src = fileUrl(full); vd.preload = 'metadata'; vd.muted = true; vd.style.cssText = MEDIA_FALLBACK; thumb.appendChild(vd); nMedia++; }
      else if (AUD.test(it.name)) { card.classList.add('plain'); const b = el('span', 'kun-dir-ext', '♪ ' + extOf(it.name)); thumb.appendChild(b); }
      else { card.classList.add('plain'); const b = el('span', 'kun-dir-ext', extOf(it.name)); thumb.appendChild(b); }
      card.appendChild(thumb);
      const nm = el('div', 'kun-dir-name', it.name);
      nm.title = it.name; nm.style.cssText = NAME_FALLBACK;
      const mt = el('div', 'kun-dir-meta', it.isDir ? '文件夹' : fmtSize(it.size || 0));
      mt.style.cssText = META_FALLBACK;
      card.appendChild(nm); card.appendChild(mt);
      card.addEventListener('dblclick', () => { if (it.isDir) open({ kind: 'dir', path: full, title: it.name }); else open({ path: full, title: it.name }); });
      grid.appendChild(card);
    });
    applyThumbSize();          // 卡片都建好了，先按当前缩略图尺寸排一次（Ctrl+滚轮 就在这个基础上调）
    remember(p);
    say(rows.length + ' 项' + (nMedia ? '（' + nMedia + ' 个图片/视频）' : '') + ' · 双击就在这个面板里看/播');
    paint();
  }
  async function open(opt) {
    const o = opt || {};
    const p = String(o.path || '').trim();
    const url = String(o.url || '').trim();
    await flushDirty();                                   // 切走之前先把没存的手改存了（防丢）
    if (disposed) return;
    const kind = o.kind || (p ? pickKind(p) : 'web');
    // 画布上两类"没有文件"的东西走这两条支线（**必须排在 !p && !url 那道判空前面**，
    // 否则它们没有路径，会直接被当成"空预览"清屏 —— 用户点了个预设却什么都没发生）
    if (kind === 'preset') return openPresetMini(o);
    if (kind === 'text' && !p && !url) return openDoc(o);
    if (!p && !url) { showEmpty(); return; }
    cur = { kind: kind, path: p, url: url, title: String(o.title || ''), dirty: false, size: 0, mtime: 0 };
    paint();
    if (kind === 'text') return openText(p);
    if (kind === 'image') return openImage(p);
    if (kind === 'video' || kind === 'audio') return openMedia(p, kind);
    if (kind === 'dir') return openDir(p);                       // ★项目文件夹：摊开列出里面的东西（图片/视频带缩略图）
    if (kind === 'web') return openWeb(url || fileUrl(p));
    if (kind === 'pdf') return openPdf(p);                       // PDF：内核自带阅读器
    if (kind === 'office') return openOffice(p);                 // Office/WPS：先转 PDF 再内嵌显示（★2026-10-13）
    if (kind === 'opaque') return openOpaque(p);                 // 压缩包/安装包/二进制：提示卡 + 系统打开（★2026-10-13）
    showEmpty();
  }

  B.save.addEventListener('click', () => saveText());
  B.reread.addEventListener('click', () => {
    if (cur.kind === 'dir') { open({ kind: 'dir', path: cur.path, title: cur.title }); return; }   // 目录要按 dir 重开，否则会被当成文本
    if (cur.path) open({ path: cur.path, title: cur.title });
  });
  B.sysopen.addEventListener('click', () => {
    const t = cur.path || cur.url;
    if (!t) return;
    if (A && A.openPath) A.openPath(t); else say('没有宿主能力，打不开', 'warn');
  });
  B.reveal.addEventListener('click', () => { if (cur.path && A && A.revealPath) A.revealPath(cur.path); })
  // 2026-10-18（vw-ai 派单）：复制当前文件完整路径。web/url 态没有磁盘路径 ⇒ 退回复制 URL。
  //   两条兜底照本文件既有写法：navigator.clipboard 优先（真 GUI 聚焦时最稳），失败退 textarea+execCommand。
  const viewCopyText = (txt) => {
    try {
      const ta = document.createElement('textarea');
      ta.value = txt;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return !!ok;
    } catch (e) { return false; }
  };
  B.copypath.addEventListener('click', () => {
    const txt = String(cur.path || cur.url || '').trim();
    if (!txt) { say('还没打开文件，没路径可复制', 'warn'); return; }
    const ok = () => say('✓ 已复制：' + txt);
    const fb = () => { if (viewCopyText(txt)) ok(); else say('复制失败（窗口可能没聚焦）· 路径：' + txt, 'warn'); };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(txt).then(ok, fb); return; }
    } catch (e) { /* 落到 fb */ }
    fb();
  });;
  B.close.addEventListener('click', () => showEmpty());
  B.src.addEventListener('click', () => { cur.kind = 'text'; paint(); openText(cur.path); });
  B.preview.addEventListener('click', async () => {
    const p = cur.path;
    await flushDirty();
    if (disposed) return;
    cur.kind = 'web'; cur.dirty = false; paint();
    openWeb(fileUrl(p));
  });

  const api = {
    pid: pid,
    current: () => ({ kind: cur.kind, path: cur.path, url: cur.url, title: cur.title, dirty: !!cur.dirty }),
    show: (o) => open(o || {}),
    clear: () => showEmpty()
  };
  window.__kunViews = window.__kunViews || {};
  window.__kunViews[pid] = api;

  // 开场：先按上次看的文件恢复（有才开），否则空状态
  let last = '';
  try { last = localStorage.getItem(storeKey) || ''; } catch (e) { last = ''; }
  if (last) open({ path: last });
  else showEmpty();

  return () => {
    disposed = true;
    readSeq++;
    // 面板被销毁（切场景 / ⟳）前抢存一次手改 —— 不能让用户的心血随面板一起没
    if (cur.dirty && cur.kind === 'text' && cur.path && inner && inner.tagName === 'TEXTAREA' && F && F.write) {
      try { F.write(cur.path, inner.value); } catch (e) { /* ignore */ }
    }
    if (flashTimer) clearTimeout(flashTimer);
    if (window.__kunViews && window.__kunViews[pid] === api) delete window.__kunViews[pid];
    clearBody();
  };
};

// ============ embed：把"本机自带的网页工具"整页内嵌进面板（<webview>） ============
// 首个用户：视频工作流 窗口1 = ComfyUI 控制台（http://127.0.0.1:8189/，bridge.py 起的本地页面）。
// 为什么用 <webview> 而不是 iframe：与 harness / 官网预览一致，guest view 独立进程更稳，
// 且能带自己的 partition（一板一分区），不和引擎面板串味。
//
// 配置（都在场景 json 的面板对象里，全是选填、缺省即"没有这个按钮"）：
//   meta.url          必填，要内嵌的页面
//   meta.failHint     连不上时卡片里的一句话排查提示
//   meta.launchPath   桌面启动器的路径（快捷方式/exe）：点「🖥 桌面启动」就用宿主能力打开它
//   meta.launchLabel  桌面启动按钮文字（默认「🖥 桌面启动」）
//   meta.launchHint   点完桌面启动后卡片里显示的那句话
//   meta.embedToggle  false = 不显示「内置/取消内置」按钮（默认显示）
//   meta.offHint      「取消内置」后卡片里的说明（默认一句通用说明）
// 为什么桌面启动不用新开 IPC：宿主通用能力 app:open-path 走 shell.openPath（= ShellExecute），
// 传桌面 .lnk 就等价于双击快捷方式，所以这条路不用重启 GUI 就能加。
//
// 「内置 / 取消内置」（2026-09-20 加，用户要求"比较灵活"）：取消内置 = 把 <webview> 真的摘掉
// （不是隐藏）——不再有 guest 进程、也不会有第二份轮询；选择记在 localStorage，⟳/切场景都记得住。
// 内嵌页面的 UA：Electron 默认 UA 尾巴上挂着 "Electron/43.4.0"，有的站点一看就把页面盖成
// 「使用环境异常 / 建议使用我们的官方产品」弹窗（DeepSeek 网页版 2026-09-20 实测如此）。
// meta.userAgent 写 "chrome" ⇒ 换成一条**纯 Chrome UA**，Chrome 版本取当前 Electron 真实内核版本
// （process.versions.chrome，不写死、不撒谎）；也可以直接写完整 UA 字符串；不写 = 不动（用默认）。
// 为什么用函数声明而不是顶层 const/let：renderers.js 会被反复 ⟳ 重新求值，顶层 const 会重复声明报错。
function resolveEmbedUA(v) {
  if (!v) return '';
  if (v !== 'chrome' && v !== true) return String(v);
  var ver = '';
  try { ver = (typeof process !== 'undefined' && process.versions && process.versions.chrome) || ''; } catch (e) { ver = ''; }
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/'
    + (ver || '<IP>') + ' Safari/537.36';
}

// ==========================================================================================
// 2026-10-19 22:5x（宿主：「左边点开视频，右边直接说『总结这个』就行」· dg-dsh 派单）
//   当前视频同步：只在 **B站场景的 embed 面板** 上，每 1.5s 看一次 webview 的 URL，
//   抽 BV 号 + document.title，写到 `引擎\场景项目信息\B站\当前视频.json`（AI 侧已约定读它）。
//   ⛔ 不动 src / 不 reload / 不往页面里注入；⛔ 只在内容变化时写盘；⛔ 只认 bilibili 场景。
//   ⛔ 失败一律静默（同步挂了绝不影响看视频）。
// ==========================================================================================
function startBiliTrack(wv, meta) {
  try {
    var scene = String((meta && meta.scenario) || '');
    if (scene !== 'bilibili') return;                        // 别的场景嵌网页一律不装
    if (window.__biliTrack && window.__biliTrack.stop) window.__biliTrack.stop();   // 幂等：只跑一个
    var OUT = ((window.app && window.app.paths && window.app.paths.memRoot) || '') + '\\B站\\当前视频.json';
    var last = '', timer = null, alive = true, seenInDoc = false;
    function iso() {
      var d = new Date();
      var off = -d.getTimezoneOffset(), oh = Math.floor(Math.abs(off) / 60), om = Math.abs(off) % 60;
      var p = function (n) { return (n < 10 ? '0' : '') + n; };
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' +
        p(d.getMinutes()) + ':' + p(d.getSeconds()) + (off >= 0 ? '+' : '-') + p(oh) + ':' + p(om);
    }
    function write(bv, url, title) {
      if (!url) return;                                       // webview 还没就绪 ⇒ 不写（免得刷一堆空记录）
      // ⚠ 2026-10-19 自查修的 bug：原来拿**整个 JSON**（含 at）比 ⇒ 每轮都不同 ⇒ 一直在刷盘。
      //   现在只比 bv+url+title；at 只记"这次写入的时间"。
      var key = String(bv) + '|' + url + '|' + String(title || '');
      if (key === last) return;
      var txt = JSON.stringify({ bv: bv, url: url, title: String(title || ''), at: iso() });
      // （内容没变已在上面按 key 拦掉；这句保留只为兼容旧注释，不会命中）
      last = key;
      try {
        if (window.app && window.app.file && window.app.file.write) {
          Promise.resolve(window.app.file.write(OUT, txt + '\n')).catch(function () { /* 静默 */ });
        }
      } catch (e) { /* 静默 */ }
    }
    function stop() { alive = false; if (timer) { clearInterval(timer); timer = null; } window.__biliTrack = null; }
    function tick() {
      if (!alive) return;
      var inDoc = document.body.contains(wv);
      if (inDoc) seenInDoc = true;                                  // 挂上过一次才算“活过”
      else if (seenInDoc) { stop(); return; }                       // 曾经挂上 → 现在没了 ⇒ 面板销毁/场景切走
      else return;                                                 // 还没挂上 ⇒ 先等（别把自己判死）
      var url = '';
      try { url = (wv.getURL && wv.getURL()) || ''; } catch (e) { url = ''; }
      if (!url) return;
      var m = /\/video\/(BV[0-9A-Za-z]+)/.exec(url);
      var bv = m ? m[1] : null;
      var done = function (t) { if (alive) write(bv, url, t); };
      // 2026-10-19 自查修：原来首页直接 done('') 不取 title ⇒ 文件里 title 永远是空串。
      //   现在统一走下面的"取 title"路径（bv=null 也照样取，契约里两态都有 title）。
      try {
        Promise.resolve(wv.executeJavaScript('document.title')).then(function (t) { done(t); }).catch(function () { done(''); });
      } catch (e) { done(''); }
    }
    timer = setInterval(tick, 1500);
    window.__biliTrack = { stop: stop, at: Date.now(), out: OUT };
    // 2026-10-19 23:4x（宿主：打字/滚动/选中都行，就是点了不跳转）——**换方式**：不依赖弹窗策略，
    //   直接在页面里接管"新窗口链接"：点 a[target=_blank] ⇒ 当前页面打开（location.href）。幂等、失败静默。
    var LINKFIX = '(function(){try{if(window.__dshLinkFix)return "ok";window.__dshLinkFix=1;'
      + 'document.addEventListener("click",function(e){try{'
      + 'var a=e.target&&e.target.closest?e.target.closest("a[href]"):null;if(!a)return;'
      + 'var h=a.getAttribute("href")||"";'
      + 'if(!h||h==="#"||h.indexOf("javascript:")===0||h.indexOf("#")===0)return;'
      + 'if(a.target==="_blank"||!a.target){e.preventDefault();location.href=a.href;}'
      + '}catch(_){}},true);return "ok";}catch(e){return "err";}})()';
    function installLinkFix() {
      try { Promise.resolve(wv.executeJavaScript(LINKFIX)).catch(function () {}); } catch (e) { /* ignore */ }
    }
    try { wv.addEventListener('did-finish-load', function () { installLinkFix(); }); } catch (e) {}
    installLinkFix();
    tick();
    if (window.console) console.log('[biliTrack] 已启动 ⇒ ' + OUT);
  } catch (e) { /* 静默 */ }
}

// ==========================================================================================
// 2026-10-19 23:2x（bv-ai 派单）—— 临时点击探针，用来判断"点击到底进没进 guest"
//   写到 `引擎\场景项目信息\B站\_点击探针.json`（⚠ 临时文件，定位完就删；不污染 AI 认的 当前视频.json）
//   采：① guest 内的 document 级 click 计数与最近一次 target ② a[target=_blank] 数量
//       ③ 屏幕中心点 elementFromPoint（guest 内）④ 同一位置在**宿主页面**里的 elementFromPoint（看有没有东西盖住 webview）
// ==========================================================================================
function startBiliProbe(wv, meta) {
  try {
    if (String((meta && meta.scenario) || '') !== 'bilibili') return;
    if (window.__biliProbe && window.__biliProbe.stop) window.__biliProbe.stop();
    var OUT = ((window.app && window.app.paths && window.app.paths.memRoot) || '') + '\\B站\\_点击探针.json';
    var last = '', timer = null, alive = true, seen = false, injected = false;
    var INJECT = '(function(){try{if(window.__dshProbe)return "exists";window.__dshProbe={n:0,last:""};'
      + 'document.addEventListener("click",function(e){try{window.__dshProbe.n++;var el=e.target||{};'
      + 'var t=(el.tagName||"?")+"#"+(el.id||"")+"."+String(el.className||"");window.__dshProbe.last=t.slice(0,140);}catch(_){}} ,true);'
      + 'return "ok";}catch(e){return "err:"+String(e&&e.message||e);}})()';
    var READ = '(function(){try{var p=window.__dshProbe||{};'
      + 'var a=document.querySelectorAll("a[target=_blank]").length;'
      + 'var el=null;try{el=document.elementFromPoint((innerWidth||800)/2,(innerHeight||600)/2);}catch(_){}'
      + 'var mid=el?((el.tagName||"?")+"#"+(el.id||"")+"."+String(el.className||"")):"";'
      + 'return JSON.stringify({clicks:p.n||0,last:p.last||"",ab:a,mid:mid.slice(0,140)});'
      + '}catch(e){return JSON.stringify({err:String(e&&e.message||e)});}})()';
    function stop() { alive = false; if (timer) { clearInterval(timer); timer = null; } window.__biliProbe = null; }
    function tick() {
      if (!alive) return;
      var inDoc = document.body.contains(wv);
      if (inDoc) seen = true; else if (seen) { stop(); return; } else return;
      if (!injected) { injected = true; try { Promise.resolve(wv.executeJavaScript(INJECT)).catch(function () {}); } catch (e) {} }
      var r = null;
      try { r = wv.getBoundingClientRect(); } catch (e) { r = null; }
      var top = '', rect = '';
      if (r && r.width > 8 && r.height > 8) {
        rect = Math.round(r.left) + ',' + Math.round(r.top) + ',' + Math.round(r.width) + 'x' + Math.round(r.height);
        try {
          var he = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          top = he ? (String(he.tagName || '?').toLowerCase() + '#' + (he.id || '') + '.' + String(he.className || '')) : '';
        } catch (e) { top = 'err'; }
      }
      try {
        Promise.resolve(wv.executeJavaScript(READ)).then(function (s) {
          var g = {};
          try { g = JSON.parse(String(s || '{}')); } catch (e) { g = { parse: 'fail' }; }
          var obj = { at: Date.now(), clicks: g.clicks || 0, last: g.last || '', ab: g.ab, mid: g.mid || '',
                      hostTop: top, rect: rect, pe: (wv.style.pointerEvents || '(none-set)'), op: (wv.style.opacity || '(none-set)') };
          var txt = JSON.stringify(obj);
          if (txt !== last) {
            last = txt;
            try { if (window.app && window.app.file && window.app.file.write) Promise.resolve(window.app.file.write(OUT, txt + '\n')).catch(function () {}); } catch (e) {}
          }
        }).catch(function () {});
      } catch (e) { /* 静默 */ }
    }
    timer = setInterval(tick, 1500);
    window.__biliProbe = { stop: stop, out: OUT };
    tick();
  } catch (e) { /* 静默 */ }
}

// ==========================================================================================
// 2026-10-19 23:2x（宿主：启动动画要可选）—— 外壳侧"播放层"
//   ① 启动时读 <盘根>:\DSH\外壳\data\boot-animation.json 的 id ⇒ 给 #boot-overlay 加 data-anim
//      （文件不存在/坏了 ⇒ 一律回落 classic，⛔ 绝不让启动失败）
//   ② window.__bootPreview(id)：把 overlay 亮出来按 id 播一遍，1.8 秒后收起（给插件点选用）
//   ⛔ 不碰 boot 逻辑（__bootPaint / __bootFinish / 超时 / 重试全在 renderer.js，一个字没动）
// ==========================================================================================
(function bootAnimRegistry() {
  var CFG = ((window.app && window.app.paths && window.app.paths.bootCfg) || '');
  // 2026-10-20（宿主：把片头视频做成启动动画）—— 视频铺满 overlay（muted 自动播放才允许），
  //   其余（底部光带/百分比/立即进入）由 CSS 叠在上面；只在 id=video 时挂，别的动画会把它摘掉。
  function ensureBootVideo(id) {
    try {
      var ov = document.getElementById('boot-overlay');
      if (!ov) return;
      var v = ov.querySelector('.boot-video');
      // 2026-10-20：支持多个视频动画 —— 按 id 选文件（video=线条睁眼鲸鱼 3D · slogan=为理想奋斗）
      var VID_SRC = {
        video: '../renderer/assets/boot-video.mp4',
        slogan: '../renderer/assets/boot-video-slogan.mp4'
      };
      var want = VID_SRC[id] || '';
      if (!want) { if (v) v.remove(); return; }
      if (v && v.getAttribute('data-anim-src') === want) { try { v.currentTime = 0; v.play(); } catch (e) {} return; }
      if (v) { try { v.remove(); } catch (e) {} v = null; }
      var el2 = document.createElement('video');
      el2.className = 'boot-video';
      el2.setAttribute('data-anim-src', want);
      el2.src = want;
      el2.autoplay = true; el2.muted = true; el2.playsInline = true;
      el2.setAttribute('muted', '');
      el2.setAttribute('playsinline', '');
      ov.insertBefore(el2, ov.firstChild);
      try { el2.play(); } catch (e) { /* 自动播放被拒也没关系，画面会在下次交互开始 */ }
    } catch (e) { /* 静默 */ }
  }
  // 2026-10-21（宿主：ideal 只有一屏太单一）—— 新动画 ideal2「星火 · 钢铁 · 理想」三幕轮播。
  //   画在 overlay 上（不进 .boot-card，免得跟进度条的 flex 布局打架）；id 不是 ideal2 就把这块摘掉。
  var BA_HTML = [
    '<div class="ba-act ba1">',
    '  <div class="ba-emblem"></div>',
    '  <div class="ba-spark s1"></div><div class="ba-spark s2"></div><div class="ba-spark s3"></div>',
    '  <div class="ba-spark s4"></div><div class="ba-spark s5"></div><div class="ba-spark s6"></div>',
    '  <div class="ba-quote">为理想而奋斗</div>',
    '  <div class="ba-sub">星星之火，可以燎原</div>',
    '</div>',
    '<div class="ba-act ba2">',
    '  <div class="ba-cam">',
    '    <div class="ba-flagStage">',
    '      <div class="ba-flag">',
    '        <div class="ba-strips"></div>',
    '        <div class="ba-shade"></div>',
    '        <svg class="ba-sketch" viewBox="0 0 480 320" fill="none" stroke="#ffd9a9" stroke-width="2.6" stroke-linejoin="round" aria-hidden="true">',
    '          <rect class="ba-draw" x="2" y="2" width="476" height="316" stroke-dasharray="1590" stroke-dashoffset="1590"/>',
    '          <polygon class="ba-draw d2" points="80.0,32.0 90.8,65.2 125.7,65.2 97.4,85.7 108.2,118.8 80.0,98.3 51.8,118.8 62.6,85.7 34.3,65.2 69.2,65.2" stroke-dasharray="330" stroke-dashoffset="330"/>',
    '          <polygon class="ba-draw d3" points="146.3,40.2 153.9,31.5 147.9,21.5 158.6,26.0 166.3,17.3 165.2,28.9 175.9,33.4 164.6,36.0 163.6,47.6 157.6,37.6" stroke-dasharray="120" stroke-dashoffset="120"/>',
    '          <polygon class="ba-draw d3" points="176.2,66.3 186.6,61.1 185.0,49.6 193.0,58.0 203.5,52.9 198.1,63.1 206.1,71.5 194.7,69.5 189.3,79.8 187.6,68.3" stroke-dasharray="120" stroke-dashoffset="120"/>',
    '          <polygon class="ba-draw d3" points="176.6,107.6 188.2,107.2 191.4,96.0 195.4,106.9 207.0,106.5 197.9,113.7 201.9,124.6 192.2,118.1 183.1,125.3 186.3,114.1" stroke-dasharray="120" stroke-dashoffset="120"/>',
    '          <polygon class="ba-draw d3" points="147.5,134.0 158.4,138.1 165.6,129.0 165.1,140.6 176.0,144.7 164.8,147.8 164.2,159.4 157.8,149.7 146.6,152.8 153.9,143.7" stroke-dasharray="120" stroke-dashoffset="120"/>',
    '        </svg>',
    '      </div>',
    '    </div>',
    '  </div>',
    '  <div class="ba-call">中华人民共和国万岁</div>',
    '  <div class="ba-sub">一九四九年 · 十月一日</div>',
    '</div>'
  ].join('');
  // ⚠ 动画 DOM 有版本号：改了 BA_HTML 就把 ART_VER 一起改，⟳ 热更新时才能把**旧 DOM** 换掉。
  //   （踩过的坑：只加"有就跳过"的幂等判断 ⇒ 热更新后页面上还是上一版的三幕，新旧文案叠在一起。）
  var ART_VER = '2026-10-21-i';
  // 2026-10-21 宿主：「随风飘要做得像真的」—— 旗帜改成 **40 条竖条**，每条只做上下位移、
  //   相位依次错开、振幅从旗杆那头（1px）到旗尾（13px）递增 ⇒ 看起来像布料在风里行走的波。
  //   这里的 SVG 只用来给每条当背景图（480×320 的旗面），条纹靠 background-position 切。
  var BA_FLAG_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 320">'
    + '<rect width="480" height="320" fill="#e21b1b"/>'
    + '<polygon points="80.0,32.0 90.8,65.2 125.7,65.2 97.4,85.7 108.2,118.8 80.0,98.3 51.8,118.8 62.6,85.7 34.3,65.2 69.2,65.2" fill="#ffde00"/>'
    + '<polygon points="146.3,40.2 153.9,31.5 147.9,21.5 158.6,26.0 166.3,17.3 165.2,28.9 175.9,33.4 164.6,36.0 163.6,47.6 157.6,37.6" fill="#ffde00"/>'
    + '<polygon points="176.2,66.3 186.6,61.1 185.0,49.6 193.0,58.0 203.5,52.9 198.1,63.1 206.1,71.5 194.7,69.5 189.3,79.8 187.6,68.3" fill="#ffde00"/>'
    + '<polygon points="176.6,107.6 188.2,107.2 191.4,96.0 195.4,106.9 207.0,106.5 197.9,113.7 201.9,124.6 192.2,118.1 183.1,125.3 186.3,114.1" fill="#ffde00"/>'
    + '<polygon points="147.5,134.0 158.4,138.1 165.6,129.0 165.1,140.6 176.0,144.7 164.8,147.8 164.2,159.4 157.8,149.7 146.6,152.8 153.9,143.7" fill="#ffde00"/>'
    + '</svg>';
  function buildFlagStrips(root) {
    try {
      var box = root && root.querySelector ? root.querySelector('.ba-strips') : null;
      if (!box || box.getAttribute('data-built') === '1') return;
      var uri = 'data:image/svg+xml;base64,' + btoa(BA_FLAG_SVG);   // 纯 ASCII，btoa 安全
      // 2026-10-21：旗面放大到 640×427 ⇒ 80 条 × 8px、振幅 1~17px（越靠旗尾甩得越大，才有"挥舞"感）
      var N = 80, STEP = 8, parts = [];
      for (var i = 0; i < N; i++) {
        var amp = (1 + 21 * i / (N - 1)).toFixed(1);
        parts.push('<div class="ba-strip" style="left:' + (i * STEP) + 'px;'
          // 竖条是 top:-20 / 高度 +40（上下留出位移余量）⇒ 背景也要往下补 20px，否则旗面整体上移 20px
          + "background-image:url('" + uri + "');background-position:-" + (i * STEP) + 'px 20px;'
          + '--amp:' + amp + ';animation-delay:-' + (i * 0.03).toFixed(2) + 's"></div>');
      }
      box.innerHTML = parts.join('');
      box.setAttribute('data-built', '1');
    } catch (e) { /* ignore */ }
  }
  function ensureBootArt(id) {
    try {
      var ov = document.getElementById('boot-overlay');
      if (!ov) return;
      var old = document.getElementById('boot-art');
      if (id !== 'ideal2') { if (old && old.parentNode) old.parentNode.removeChild(old); return; }
      if (old && old.getAttribute('data-ver') === ART_VER) return;   // 同版本：保留（重建会重启动画）
      if (old && old.parentNode) old.parentNode.removeChild(old);     // 旧版本：拆掉重建
      var d = document.createElement('div');
      d.id = 'boot-art';
      d.className = 'ba-stage';
      d.setAttribute('data-ver', ART_VER);
      d.innerHTML = BA_HTML;
      ov.appendChild(d);
      buildFlagStrips(d);
    } catch (e) { /* 静默 */ }
  }
  // 2026-10-22（宿主：切到别的场景后，启动动画预览就看不见了）——
  //   #boot-overlay 原本挂在 #harness-view 里面，一切场景那个 .view 就 display:none，遮罩跟着消失。
  //   这里把它**提到 body 上**（只提一次）并加 .lifted（position:fixed 盖满整窗）⇒ 任何页签下预览/启动进度都看得见。
  function liftOverlay() {
    var el = document.getElementById('boot-overlay');
    if (!el) return null;
    if (el.parentNode !== document.body) document.body.appendChild(el);
    el.classList.add('lifted');
    return el;
  }
  function apply(id) {
    try {
      var ov = liftOverlay();
      if (!ov) return false;
      ov.setAttribute('data-anim', String(id || 'classic'));
      ensureBootVideo(String(id || "classic"));
      ensureBootArt(String(id || 'classic'));
      return true;
    } catch (e) { return false; }
  }
  try {
    var F = window.app && window.app.file;
    if (F && F.read) {
      if (!window.__bpwTicks) window.__bpwTicks = 0; if (++window.__bpwTicks % 5 === 0) log('tick ' + window.__bpwTicks + ' hidden=' + document.hidden);
      Promise.resolve(F.read(CFG)).then(function (r) {
        var txt = (typeof r === 'string') ? r : ((r && (r.text || r.content)) || '');
        var id = 'classic';
        try { var j = JSON.parse(txt); if (j && j.id) id = String(j.id); } catch (e) { /* 坏文件 ⇒ classic */ }
        apply(id);
      }).catch(function () { apply('classic'); });
    }
  } catch (e) { /* 读配置失败 ⇒ 什么都不做 = classic */ }
  window.__bootPreview = function (id) {
    try {
      var ov = document.getElementById('boot-overlay');
      if (!ov) return false;
      var play = function (real) {
        var rid = String(real || 'classic');
        ov = liftOverlay() || ov;          // 预览也走"提 body"（切到别的场景同样看得见）
        ov.classList.remove('hide', 'err');
        ov.setAttribute('data-anim', rid);
        ensureBootVideo(rid);
        ensureBootArt(rid);
        window.__bootId = rid;
        if (window.__bootPaint) {
          window.__bootPaint({ stage: 'anim', pct: 42, text: '启动动画预览：' + rid, detail: '1.8 秒后自动收起' });
        }
        setTimeout(function () {
          try { if (window.__bootFinish) window.__bootFinish(); else ov.classList.add('hide'); } catch (e) { /* ignore */ }
        // 2026-10-21：视频 7.5s；三幕动画 ideal2 要 11s 才能看完三幕
        }, (rid === 'video') ? 7500 : ((rid === 'ideal2') ? 11000 : 1800));
      };
      if (id) { play(id); return true; }
      // 2026-10-19 23:5x（宿主：设置里改了但预览没变）—— 不传 id 时**现读一遍配置**：
      //   插件里刚点完卡片，菜单里的预览立刻就是新的（不用等下次启动）。
      var F = window.app && window.app.file;
      if (F && F.read) {
        Promise.resolve(F.read(CFG)).then(function (r) {
          var txt = (typeof r === 'string') ? r : ((r && (r.text || r.content)) || '');
          var cur = 'classic';
          try { var j2 = JSON.parse(txt); if (j2 && j2.id) cur = String(j2.id); } catch (e) { /* classic */ }
          play(cur);
        }).catch(function () { play(ov.getAttribute('data-anim') || 'classic'); });
      } else {
        play(ov.getAttribute('data-anim') || 'classic');
      }
      return true;
    } catch (e) { return false; }
  };
})();

// ==========================================================================================
// 2026-10-20（宿主：把常用网站的"智能抠图"做成**本地**工具）—— 场景「抠图」的主面板
//   引擎：本地 venv 里的 rembg（主进程 app.cut.run 起一次进程，算完就退，不常驻；图片不出本机）。
//   图片来源：① 左边「文件管理」里单击图片 ⇒ 走 window.__kunViews[面板id].show({path}) 送进来
//            ② 面板上的「选择图片…」(app.pickFile 系统对话框) ③ 直接把图片拖进来 (app.filePath)
//   输出：同目录 `<原名>_抠图.png`（带透明通道），旁边给 复制路径 / 定位 / 系统打开。
// ==========================================================================================
// 2026-10-20（宿主：「不要做成场景，做成一个小工具放在 CPU 左边，剪刀图标和其它图标风格一致」
//            + 「只有开始抠图吗，有没有橡皮或者扩选」）—— 顶栏「本地抠图」小工具
//   · 按钮：.titlebar-controls 里、负载胶囊（#tbs-load）**左边**；16px 线稿剪刀，与手机/月亮同一套 .tb-btn
//   · 弹层：居中（最宽 980、最高 88vh），左原图右结果 = 一块可精修的画布
//   · 引擎：<盘根>:\DSH\工具\抠图（rembg，离线）→ app.cut.run；读/存 PNG → app.cut.read / app.cut.write
//   · 精修（答宿主的问题：自动抠图只是第一步）：
//       橡皮擦 = 把不要的地方擦成透明；恢复笔 = 把擦掉/误抠的地方补回来（按自动结果的 alpha）
//       扩选 +N / 缩减 -N = 边缘整体外扩 / 内收 N 像素；羽化 N = 边缘过渡变软
//       撤销 / 重置（回到自动结果）/ 保存（覆盖 <原名>_抠图.png）/ 复制路径 / 定位
//   ⚠ 只有点过「✂ 自动抠图」之后才有画布可修；编辑全在本地 canvas，不联网。
// ==========================================================================================
/* 开源版：本地抠图入口已移除 */
// ==========================================================================================
// 2026-10-20（dg-dsh 派单）—— 顶栏「本地模型」开关（**只在主窗口**）
//   状态：app.localmodel.status() → {running,pid,vramFreeMb,modelReady}（亮=开 / 灰=关）
//   点击：app.localmodel.toggle()（脚本最多 90s：启动要等 /health + 真出字；启动中显示 loading）
//   悬停：本地 Qwen3-8B（GPU）· 显存空闲 N MB · 不用时关掉释放
//   失败：把脚本 stderr 最后一行弹出来（常见：显存不足 <5000MB）
//   ⛔ 不动引擎、不动 profile：只调 <盘根>:\DSH\工具\本地模型.mjs
// ==========================================================================================
(function localModelTopbar() {
  var LM = window.app && window.app.localmodel;
  // 只在主窗口（分离窗口是一窗一场景，别让这个开关重复出现）
  try { if (/[?&]solo=1/.test(location.search || '')) return; } catch (e) { return; }

  // ⟳ 重注入：把上一份按钮**全清掉**（可能不止一个：旧闭包的 place() 定时器会把摘下来的按钮再插回去）
  try {
    var olds = document.querySelectorAll('#btn-localmodel');
    for (var oi = 0; oi < olds.length; oi++) { if (olds[oi].parentNode) olds[oi].parentNode.removeChild(olds[oi]); }
  } catch (e) { /* ignore */ }
  window.__lmGen = (window.__lmGen || 0) + 1;
  var MY_GEN = window.__lmGen;

  var ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">'
    + '<rect x="2.7" y="2.7" width="10.6" height="10.6" rx="2.2" stroke="currentColor" stroke-width="1.25"/>'
    + '<rect x="5.5" y="5.5" width="5" height="5" rx="1.1" stroke="currentColor" stroke-width="1.25"/>'
    + '<path d="M6.4 2.7V1.3M9.6 2.7V1.3M6.4 14.7v-1.4M9.6 14.7v-1.4M2.7 6.4H1.3M2.7 9.6H1.3M14.7 6.4h-1.4M14.7 9.6h-1.4" stroke="currentColor" stroke-width="1.05" stroke-linecap="round"/>'
    + '</svg>';

  var st = { running: false, vram: null, modelReady: null, busy: false, err: '', at: 0 };
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tb-btn tb-tools lm-pill lm-off';
  btn.id = 'btn-localmodel';
  btn.innerHTML = ICON + '<span class="lm-txt">本地模型 关</span>';

  function toast(msg, bad) {
    try {
      var box = document.querySelector('.tbs-toasts');
      if (!box) { box = document.createElement('div'); box.className = 'tbs-toasts'; document.body.appendChild(box); }
      var t = document.createElement('div');
      t.className = 'tbs-toast' + (bad ? ' bad' : '');
      t.textContent = msg;
      box.appendChild(t);
      setTimeout(function () { t.classList.add('out'); setTimeout(function () { t.remove(); }, 320); }, 4600);
    } catch (e) { /* ignore */ }
  }

  function place() {
    if (window.__lmGen !== MY_GEN) return;     // 旧闭包（⟳ 之前那份）不再往 DOM 里插东西
    var controls = document.querySelector('#titlebar .titlebar-controls');
    if (!controls) return;
    if (btn.parentNode !== controls) {
      // 2026-10-20（宿主报"最小化没反应"后）—— 挪到 **⟳ 左边**：离窗口控制区（─ □ ✕）远一点，
      //   以后 pill 再变宽也碰不到最小化/最大化/关闭那三颗。
      var ref = document.getElementById('btn-refresh') || document.getElementById('btn-plugins')
        || document.getElementById('btn-theme') || null;
      if (ref && ref.parentNode === controls) controls.insertBefore(btn, ref);
      else controls.appendChild(btn);
    }
  }

  function paint() {
    var on = !!st.running;
    btn.classList.toggle('lm-on', on && !st.busy);
    btn.classList.toggle('lm-off', !on && !st.busy);
    btn.classList.toggle('lm-busy', !!st.busy);
    btn.disabled = false;
    // 带字：开=绿「本地模型 开」/ 关=灰「本地模型 关」/ 忙=琥珀「启动中…」「停止中…」
    var txt = btn.querySelector('.lm-txt');
    if (txt) {
      txt.textContent = st.busy
        ? ('本地模型 ' + (on ? '停止中…' : '启动中…'))
        : ('本地模型 ' + (on ? '开' : '关'));
    }
    var vr = (typeof st.vram === 'number') ? ('显存空闲 ' + st.vram + ' MB') : '显存空闲 —';
    var tip = '本地 Qwen3-8B（GPU）· ' + vr + ' · 不用时关掉释放';
    tip += on ? '\n（运行中 —— 点一下停掉，释放显存）' : '\n（点一下启动，约 10 秒）';
    if (st.busy) tip = '正在启动/停止本地模型…（最多 90 秒）';
    if (st.modelReady === false) tip += '\n⚠ 模型文件没找到（<模型目录>\\qwen3-8b）';
    if (st.err) tip += '\n⚠ ' + st.err;
    btn.title = tip;
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  function refresh() {
    if (!LM || !LM.status) { st.err = '这个 GUI 版本还没有本地模型通道（要重启一次工作台）'; paint(); return; }
    Promise.resolve(LM.status()).then(function (r) {
      if (!r) { st.err = '读不到状态'; paint(); return; }
      if (typeof r.vramFreeMb === 'number') st.vram = r.vramFreeMb;
      if (r.modelReady === false) st.modelReady = false; else st.modelReady = true;
      if (r.ok) { st.err = ''; st.running = !!r.running; st.at = Date.now(); }
      else st.err = r.err || '读不到状态';
      paint();
    }).catch(function (e) { st.err = (e && e.message) || String(e); paint(); });
  }

  function toggle() {
    if (st.busy) return;
    if (!LM || !LM.toggle) { st.err = '要重启一次工作台才有开关通道'; paint(); return; }
    st.busy = true; st.err = ''; paint();
    var t0 = Date.now();
    Promise.resolve(LM.toggle()).then(function (r) {
      st.busy = false;
      if (r && typeof r.vramFreeMb === 'number') st.vram = r.vramFreeMb;
      if (r && r.ok) {
        st.running = !!r.running;
        toast('本地模型：' + (st.running ? '已启动' : '已停止') + ' · ' + Math.round((Date.now() - t0) / 1000) + ' 秒', false);
      } else {
        if (r && typeof r.running === 'boolean') st.running = r.running;
        st.err = (r && r.err) || '切换失败';
        toast('本地模型切换失败：' + st.err, true);
      }
      paint();
    }).catch(function (e) {
      st.busy = false;
      st.err = (e && e.message) || String(e);
      toast('本地模型切换失败：' + st.err, true);
      paint();
    });
  }

  btn.addEventListener('click', function (ev) { ev.stopPropagation(); toggle(); });
  place();
  var tries = 0;
  var tm = setInterval(function () {
    place();
    if (++tries > 25) clearInterval(tm);
  }, 400);
  refresh();
  // 只在窗口有焦点时每 20 秒对一次状态（不额外养进程：脚本本身 0.2s 就跑完）
  setInterval(function () {
    if (document.hidden || !document.hasFocus()) return;
    if (st.busy) return;
    refresh();
  }, 20000);
  window.addEventListener('focus', function () { if (!st.busy) refresh(); });
  paint();
})();

renderers.embed = (body, meta, head) => {  body.classList.add('embed-panel');
  const url = String(meta.url || '');
  const A = window.app && window.app.app;   // app = 宿主通用能力（开外链/定位路径），不占任何场景命名空间
  const pid = String(meta.id || 'panel');
  const storeKey = 'app.embed.on.' + pid;
  const launchPaths = (Array.isArray(meta.launchPaths) ? meta.launchPaths : [meta.launchPath])
    .filter((p) => typeof p === 'string' && p);
  let wv = null;
  let disposed = false;
  let retryTimer = null;
  let retryLeft = 0;

  // 记住"内置还是没内置"：默认内置；用户点了取消内置就一直是取消状态，直到自己切回来
  let embedded = true;
  try { if (window.localStorage.getItem(storeKey) === '0') embedded = false; } catch (e) { /* 存储不可用就按默认 */ }
  const remember = (on) => { try { window.localStorage.setItem(storeKey, on ? '1' : '0'); } catch (e) { /* ignore */ } };

  const msg = el('div', 'embed-msg', '');
  body.appendChild(msg);
  const clearCards = () => {
    const c = body.querySelectorAll('.embed-fail, .embed-off');
    for (let i = 0; i < c.length; i++) c[i].remove();
  };
  const showMsg = (t) => { msg.textContent = t; msg.style.display = ''; };
  const hideMsg = () => { msg.style.display = 'none'; };

  // 桌面启动：按候选顺序试，第一个打开成功就停（用桌面快捷方式 = 等价双击）
  const needsRetry = () => (!wv || !!body.querySelector('.embed-fail'));   // 页面好好的就别去折腾它
  const launch = async (statusEl) => {
    if (!launchPaths.length) return false;
    let ok = false;
    for (let i = 0; i < launchPaths.length; i++) {
      const p = launchPaths[i];
      try {
        const r = A && A.openPath ? await A.openPath(p) : (window.open(p, '_blank'), { ok: true });
        if (r && r.ok) { ok = true; break; }
      } catch (e) { /* 试下一个 */ }
    }
    const failText = '桌面启动失败：没找到启动器（' + launchPaths.join(' / ') + '），请手动双击桌面快捷方式。';
    if (statusEl) statusEl.textContent = ok ? (meta.launchHint || '已调用桌面启动器，等它起来（本机约 1~2 秒），好会自动接上…') : failText;
    if (ok) { if (needsRetry()) autoRetry(); }
    else showMsg(failText);   // 标题行没有状态栏，失败就写到面板中间，别静默
    return ok;
  };

  // 点了桌面启动后：每 2 秒自己重试一次，最多 12 次（约 24 秒）；成功或超时就停，不留定时器
  const stopRetry = () => { if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; } };
  const autoRetry = () => {
    if (disposed || !embedded || retryTimer) return;
    retryLeft = 12;
    const tick = () => {
      retryTimer = null;
      if (disposed || !embedded) return;
      if (retryLeft-- <= 0) { showMsg('等不到 ' + url + ' 起来，点「🔄 刷新」再试，或看桌面那个窗口是不是报错了。'); return; }
      clearCards();
      // 失败时 did-fail-load 会把 webview 摘掉，所以这里可能是"没有 wv"的状态 → 重新挂一个
      if (!wv) mount();
      else { try { wv.reload(); } catch (e) { try { wv.loadURL(url); } catch (e2) { /* ignore */ } } }
      retryTimer = setTimeout(tick, 2000);
    };
    retryTimer = setTimeout(tick, 2000);
  };

  const makeBtn = (label, title, cls) => {
    const b = el('button', cls || 'file-refresh', label);
    if (title) b.title = title;
    return b;
  };

  // 内嵌页面的滚动条：guest 是**另一个文档**，工作台的 ::-webkit-scrollbar 管不到它，
  // 默认那条白条在深色面板里特别扎眼 ⇒ 往 guest 里注一层同款深色细条（meta.scrollbar === false 可关）
  const SCROLL_CSS = '::-webkit-scrollbar{width:10px;height:10px}'
    + '::-webkit-scrollbar-track{background:transparent}'
    + '::-webkit-scrollbar-thumb{background:rgba(148,163,184,.42);border-radius:5px;border:2px solid transparent;background-clip:content-box}'
    + '::-webkit-scrollbar-thumb:hover{background:rgba(148,163,184,.62);background-clip:content-box}'
    + '::-webkit-scrollbar-corner{background:transparent}';
  const applyScrollCss = () => {
    if (meta.scrollbar === false || !wv) return;
    try {
      if (typeof wv.insertCSS === 'function') {
        const p = wv.insertCSS(SCROLL_CSS);
        if (p && p.catch) p.catch(() => { /* guest 已销毁 */ });
        return;
      }
      // 老 Electron 没有 insertCSS：退化成往 guest 里塞一个 <style>（带 id，重复注入只留一份）
      if (typeof wv.executeJavaScript === 'function') {
        const p = wv.executeJavaScript('(function(){if(document.getElementById("kun-scrollbar-css"))return;'
          + 'var s=document.createElement("style");s.id="kun-scrollbar-css";s.textContent=' + JSON.stringify(SCROLL_CSS)
          + ';(document.head||document.documentElement).appendChild(s);})()');
        if (p && p.catch) p.catch(() => { /* ignore */ });
      }
    } catch (e) { /* 注入失败不影响页面 */ }
  };

  // ---- 挂上 webview（内置模式）----
  const mount = () => {
    if (wv || !url) return;
    hideMsg();
    clearCards();
    wv = document.createElement('webview');
    wv.className = 'embed-wv';
    // partition 必须在首次导航前设好；面板 id 决定分区名，避免和 harness 的会话分区混用
    wv.setAttribute('partition', 'persist:embed-' + pid.replace(/[^A-Za-z0-9_-]/g, '_'));
    // UA 也必须在首次导航前设好（加载后再改要重载才生效）
    const ua = resolveEmbedUA(meta.userAgent);
    if (ua) wv.setAttribute('useragent', ua);
    // 2026-10-19（宿主：B站场景一点开就跳两个 Edge 窗口）——根因：embed 的 webview 开了 allowpopups，
    //   B站页面会 window.open 它自己的内部页（leader-election/iframe.html、Cross Origin Local Storage），
    //   而 main.js 的 setWindowOpenHandler 对非内部 URL 一律 openInSystemBrowser() ⇒ 跑到系统浏览器。
    //   现在**默认不给弹窗**（浏览器不会弹，也不会跳 Edge）；确实需要弹窗的面板，在场景 json 里写 "allowPopups": true。
    if (meta.allowPopups === true) wv.setAttribute('allowpopups', '');
    wv.addEventListener('dom-ready', applyScrollCss);
    startBiliTrack(wv, meta);   // 2026-10-19：B站场景「当前视频」同步（非 B站场景内部直接 return）
    startBiliProbe(wv, meta);   // 2026-10-19 临时：点击探针（定位完删掉）
    wv.addEventListener('did-finish-load', () => { hideMsg(); clearCards(); stopRetry(); applyScrollCss(); });
    wv.addEventListener('did-fail-load', (e) => {
      // -3 = ERR_ABORTED：正常重载/跳转时的取消，不算故障
      if (e && e.errorCode === -3) return;
      if (wv) { try { wv.remove(); } catch (ex) { /* ignore */ } wv = null; }
      hideMsg();
      clearCards();
      showFail(e);
    });
    wv.setAttribute('src', url);
    body.appendChild(wv);
  };

  // ---- 摘掉 webview（取消内置模式）----
  const unmount = () => {
    stopRetry();
    if (wv) { try { wv.remove(); } catch (e) { /* ignore */ } wv = null; }
    clearCards();
    showMsg('已取消内置：这个面板不再加载 ' + url + '（省一份 guest 进程和轮询）。');
  };

  const showFail = (e) => {
    const box = el('div', 'embed-fail');
    box.appendChild(el('div', 'embed-fail-icon', '🔌'));
    box.appendChild(el('div', 'embed-fail-title', '连不上 ' + url));
    box.appendChild(el('div', 'embed-fail-sub', meta.failHint || '确认这个服务在本机跑着，再点「重试」。'));
    if (e && (e.errorDescription || e.errorCode)) {
      box.appendChild(el('div', 'embed-fail-err', String(e.errorDescription || e.errorCode)));
    }
    const status = el('div', 'embed-fail-status', '');
    const row = el('div', 'embed-actions');
    if (launchPaths.length) {
      const lb = makeBtn(meta.launchLabel || '🖥 桌面启动', '按场景 json 里配的启动器把桌面程序拉起来', 'file-refresh embed-btn');
      lb.addEventListener('click', () => launch(status));
      row.appendChild(lb);
    }
    const retry = makeBtn('🔄 重试', '再连一次', 'file-refresh embed-btn');
    retry.addEventListener('click', () => {
      hideMsg();
      clearCards();
      mount();
    });
    row.appendChild(retry);
    box.appendChild(row);
    box.appendChild(status);
    body.appendChild(box);
  };

  const showOff = () => {
    clearCards();
    hideMsg();
    const box = el('div', 'embed-off');
    box.appendChild(el('div', 'embed-off-icon', '⏏️'));
    box.appendChild(el('div', 'embed-off-title', '已取消内置'));
    box.appendChild(el('div', 'embed-off-sub', meta.offHint
      || '这个面板不再内嵌页面（省一份 guest 进程和它的轮询）。要在这里看就点「🔗 内置」切回来；桌面那个窗口不受影响。'));
    const status = el('div', 'embed-fail-status', '');
    const row = el('div', 'embed-actions');
    if (launchPaths.length) {
      const lb = makeBtn(meta.launchLabel || '🖥 桌面启动', '按场景 json 里配的启动器把桌面程序拉起来', 'file-refresh embed-btn');
      lb.addEventListener('click', () => launch(status));
      row.appendChild(lb);
    }
    const openBtn = makeBtn('🌐 浏览器打开', '在系统浏览器打开（要放大时用）', 'file-refresh embed-btn');
    openBtn.addEventListener('click', () => { if (A && A.openPath) A.openPath(url); else window.open(url, '_blank'); });
    row.appendChild(openBtn);
    const backBtn = makeBtn('🔗 内置', '把这个页面嵌回面板', 'file-refresh embed-btn');
    backBtn.addEventListener('click', () => setEmbedded(true));
    row.appendChild(backBtn);
    box.appendChild(row);
    box.appendChild(status);
    body.appendChild(box);
  };

  const setEmbedded = (on) => {
    embedded = !!on;
    remember(embedded);
    if (toggleBtn) {
      toggleBtn.textContent = embedded ? '⛔ 取消内置' : '🔗 内置';
      toggleBtn.title = embedded ? '不再把这个页面嵌在面板里（省资源，随时可切回）' : '把这个页面嵌回面板';
      toggleBtn.classList.toggle('embed-toggle-off', !embedded);
    }
    if (reloadBtn) reloadBtn.style.display = embedded ? '' : 'none';
    if (embedded) { hideMsg(); mount(); } else { unmount(); showOff(); }
  };

  // ---- 标题行按钮：桌面启动 · 内置开关 · 刷新 · 浏览器打开 ----
  let toggleBtn = null;
  let reloadBtn = null;
  if (head) {
    const acts = el('div', 'file-head-acts');
    if (launchPaths.length) {
      const launchBtn = makeBtn(meta.launchLabel || '🖥 桌面启动', '把桌面那个程序拉起来（等价双击桌面快捷方式）');
      launchBtn.addEventListener('click', () => launch(null));
      acts.appendChild(launchBtn);
    }
    if (meta.embedToggle !== false) {
      toggleBtn = makeBtn('⛔ 取消内置', '');
      toggleBtn.addEventListener('click', () => setEmbedded(!embedded));
      acts.appendChild(toggleBtn);
    }
    reloadBtn = makeBtn('🔄 刷新', '重新加载这个页面');
    reloadBtn.addEventListener('click', () => {
      if (!wv) { mount(); return; }
      retryLeft = 0;
      stopRetry();
      try { wv.reload(); } catch (e) { /* ignore */ }
    });
    acts.appendChild(reloadBtn);
    const openBtn = makeBtn('🌐 浏览器打开', '在系统浏览器打开（要放大、要登录时用）');
    openBtn.addEventListener('click', () => {
      if (A && A.openPath) A.openPath(url);
      else window.open(url, '_blank');
    });
    acts.appendChild(openBtn);
    head.appendChild(acts);
  }

  if (!url) { showMsg('这个面板没有配置 url。'); return () => { disposed = true; stopRetry(); }; }

  setEmbedded(embedded);   // 按记下来的状态进入：内置 or 取消内置

  return () => { disposed = true; stopRetry(); };
};

// ============ web（oa-ops 窗口6「网址 · 快捷监控」）：管理后台/教师端/家长端网址的实时状态监控（点击用系统浏览器打开） ============
renderers.web = (body, meta, head) => {
  oaSyncScenario(meta);
  const K = window.app && window.app.oa;
  body.classList.add('web-panel');

  // 探测按钮 + 周期小字：都放在标题行（小字紧跟标题，只显示秒数；按钮靠右）
  const refreshBtn = el('button', 'file-refresh', '🔄 探测');
  refreshBtn.title = '立即重新探测所有网址状态';
  // 在线数汇总：一眼看出有没有异常（红字提示）
  const summary = el('span', 'stat-refresh web-summary', '');
  // 演示脱敏：网址显示成遮罩版（⚠ 必须在 if (head) 块**外面**——card()/subLine() 在块外用它）
  const oaUrl = (u) => (oaMasked() ? oaMaskIpHint(String(u)) : String(u));
  if (head) {
    // 标题行专属类：CSS 靠它把这一行压成一行（见 styles.css 的 .kun-web-head）。
    // 不能靠 .web-panel 后代选择器——.web-panel 在 body 上，head 是 body 的兄弟节点。
    head.classList.add('kun-web-head');
    head.appendChild(el('span', 'stat-refresh', '30秒'));
    head.appendChild(summary);
    // 演示脱敏（2026-09-27 用户要求）：这一排末尾的空白处放一个眼睛，点一下遮住卡片网址的中间段。
    // 只遮「屏幕上显示的字」，点击打开 / 复制按钮拿到的仍是真网址。
    const webEye = el('button', 'stat-eye', '');
    webEye.type = 'button';
    webEye.innerHTML = oaEyeIcon(oaMasked());
    webEye.title = oaMasked() ? '显示完整网址（当前已遮住）' : '遮住网址中间（录屏用）';
    webEye.addEventListener('click', (ev) => {
      ev.stopPropagation();
      oaToggleMask(webEye, () => paint());   // paint 在本函数后面定义，点的时候早已就绪
    });
    head.appendChild(webEye);
    const acts = el('div', 'file-head-acts');
    // 「手机预览」：把线上站点开成 400×830 的手机窗口（配方同 界面预览\打开*.bat）。
    // 与卡片点击的区别：卡片走系统默认浏览器（普通标签页、不记登录）；
    // 这两个按钮用独立配置目录，登录状态记住，看界面不用反复登录。
    // 图标 + 文字拆成两个 span：面板窄时 CSS 只藏 .lb 保图标，
    // 不用 font-size:0 / ::first-letter 那套（emoji 不是"字母"，::first-letter 在 Chrome 里
    // 对 emoji 开头的文本不一定命中，会白折腾）。
    // ★ 2026-09-23 置顶按钮**不在面板上**了：挪进预览窗口内部（包装页右上角，挨着缩小/放大/关闭），面板保持干净。
    [['parent', '家长端'], ['teacher', '教师端'], ['jiaowu', '教务端']].forEach(([which, label]) => {
      const b = el('button', 'file-refresh web-preview-btn');
      b.type = 'button';
      const ico = el('span', 'ico', '📱');
      const lb = el('span', 'lb', label);
      b.appendChild(ico);
      b.appendChild(lb);
      b.title = '用手机尺寸独立窗口打开线上' + label + '（记住登录，不用反复登录）';
      b.addEventListener('click', () => {
        // 反馈只改文字部分，别把图标冲掉
        const old = lb.textContent;
        const back = (txt) => { lb.textContent = txt; setTimeout(() => { lb.textContent = old; }, 1600); };
        if (!(K && K.web && K.web.appWindow)) { back('不可用'); return; }
        Promise.resolve(K.web.appWindow(which)).then((r) => {
          if (r && r.ok) back('已打开');
          else back((r && r.err) || '打不开');
        }).catch(() => back('打不开'));
      });
      acts.appendChild(b);
    });
    acts.appendChild(refreshBtn);
    head.appendChild(acts);
  } else {
    body.appendChild(refreshBtn);
  }

  const grid = el('div', 'web-grid');
  body.appendChild(grid);

  // 常驻网址：即使主进程清单里没有，也自动补上（2026-09-11 官网下载中心 + 全部备用 + APK 下载）
  const ALWAYS_URLS = [
    {
      name: '<客户>官网', url: 'http://example.com:8084',
      links: [
        { label: '备用1', url: 'http://example.com:8081/site/' },
        { label: '备用2', url: 'http://example.com:8082/site/' },
        { label: '备用3', url: 'http://example.com:8083/site/' }
      ]
    },
    {
      name: 'APK 下载', url: 'http://example.com:8081/apk/teacher.apk',
      links: [
        { label: '教师端', url: 'http://example.com:8081/apk/teacher.apk' },
        { label: '家长端', url: 'http://example.com:8082/apk/parent.apk' },
        // ★ 2026-09-29 新增教务端 APK（`:8083/apk/admin.apk`，已上架并实测 HEAD 200 / 28,723,338 字节）
        { label: '教务端', url: 'http://example.com:8083/apk/admin.apk' }
      ]
    },
    // ★ 2026-09-29：教务端（手机版 H5）。主进程那份标题是「教务端·手机版」，用户要求去掉后缀 ⇒
    //   这里带 name，合并时就地改名（⟳ 即生效，不用等重启 GUI）；顺带保底：主进程清单丢了这项时自动补上。
    { name: '教务端', url: 'http://example.com:8083/m/' }
  ];
  const withAlways = (list) => {
    const out = (list || []).slice();
    // ★ 2026-09-29 修 bug：原来只给 u.url 去尾斜杠、x.url 没去 ⇒ **带尾斜杠的 URL 永远匹配不上**
    //   （官网/APK 没尾斜杠所以没暴露；教务端 `:8083/m/` 就中招：改不了名还多出一条重复卡）。两边一起归一化。
    const norm = (s) => String(s == null ? '' : s).replace(/\/+$/, '');
    ALWAYS_URLS.forEach(x => {
      const hit = out.find(u => norm(u.url) === norm(x.url));
      if (hit) {
        // 主进程清单已有该项 → 补上缺失的备用地址 / 附加链接
        // ★ 2026-09-29：名称以渲染层为准（用于「教务端·手机版」→「教务端」这类改名，⟳ 即生效）
        if (x.name) hit.name = x.name;
        if (!hit.backup && x.backup) hit.backup = x.backup;
        // ★ 2026-09-29：links 改成**取并集**（原来只在"主进程没有 links"时才补 ⇒
        //   主进程那份少了教务端时，渲染层加了也白加，非得重启 GUI 才看得到）。
        //   现在渲染层有、主进程没有的链接会按 URL 去重后追加；主进程那份（重启后生效）仍是权威来源。
        if (x.links && x.links.length) {
          hit.links = (hit.links || []).slice();
          x.links.forEach(l => {
            if (!hit.links.some(e => String(e.url) === String(l.url))) hit.links.push(l);
          });
        }
      } else {
        out.push(Object.assign({}, x));
      }
    });
    return out;
  };

  let urls = [], disposed = false, lastOk = false;

  // 复制地址：优先 Clipboard API，失败回退 execCommand（Electron file:// 环境双保险）
  const fallbackCopy = (txt) => {
    try {
      const ta = document.createElement('textarea');
      ta.value = txt;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  };
  const copyText = (txt, btn) => {
    const feedback = (ok) => {
      btn.textContent = ok ? '✓' : '✕';
      if (ok) btn.classList.add('ok'); else btn.classList.remove('ok');
      btn.title = ok ? '已复制' : '复制失败（可手动选中复制）';
      setTimeout(() => { btn.textContent = '⧉'; btn.classList.remove('ok'); btn.title = '复制地址'; }, 1100);
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(() => feedback(true)).catch(() => feedback(fallbackCopy(txt)));
        return;
      }
    } catch (e) { /* ignore */ }
    feedback(fallbackCopy(txt));
  };
  const copyBtn = (url) => {
    const b = el('button', 'web-copy', '⧉');
    b.type = 'button';
    b.title = '复制地址';
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      copyText(url, b);
    });
    return b;
  };

  // 附加链接行（备用地址 / APK 等）：点这一行单独跳转，不触发卡片主跳转
  const subLine = (label, url, okState) => {
    const line = el('div', 'web-url-backup');
    line.title = '点击打开：' + oaUrl(url);
    line.appendChild(el('span', 'web-backup-tag', label));
    line.appendChild(el('span', 'web-backup-url', oaUrl(url)));
    line.appendChild(copyBtn(url));
    const ok = okState === true;
    const known = okState !== undefined && okState !== null;
    line.appendChild(el('span', 'web-dot ' + (ok ? 'ok' : 'down'), known ? (ok ? '● 在线' : '● 离线') : '● 待探测'));
    line.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (K && K.web && K.web.open) K.web.open(url);
    });
    return line;
  };

  const card = (u) => {
    const c = el('div', 'web-card ' + (u.ok ? 'up' : 'down'));
    const top = el('div', 'web-card-top');
    top.appendChild(el('span', 'web-name', u.name || u.url));
    const dot = el('span', 'web-dot ' + (u.ok ? 'ok' : 'down'), u.ok ? '● 在线' : '● 离线');
    top.appendChild(dot);
    c.appendChild(top);
    const hasLinks = Array.isArray(u.links) && u.links.length > 0;
    // 附加行里若有与主地址相同的项（如 APK 卡片的教师端）→ 不再重复显示主地址行
    const norm = (x) => String(x || '').replace(/\/+$/, '');
    const dupMain = hasLinks && u.links.some(lk => norm(lk.url) === norm(u.url));
    if (!dupMain) {
      const row = el('div', 'web-url-row');
      row.appendChild(el('span', 'web-url', oaUrl(u.url)));
      row.appendChild(copyBtn(u.url));
      c.appendChild(row);
    }
    // 备用地址（点这一行走备用，点卡片其余区域走主地址）
    if (u.backup) c.appendChild(subLine('备用', u.backup, u.backupOk));
    // 附加链接（官网全部备用入口 / APK 下载等，共用一个卡片）
    if (hasLinks) u.links.forEach(lk => c.appendChild(subLine(lk.label || '链接', lk.url, lk.ok)));
    const metaLine = el('div', 'web-meta',
      u.ok ? ('HTTP ' + (u.code != null ? u.code : '--') + ' · ' + (u.ms != null ? u.ms + 'ms' : '')) : ((u.err || '无法连接') + (u.ms != null ? ' · ' + u.ms + 'ms' : '')));
    c.appendChild(metaLine);
    c.appendChild(el('div', 'web-open', '点击在浏览器中打开 ↗'));
    // 点击 → 系统默认浏览器打开
    c.addEventListener('click', () => {
      if (K && K.web && K.web.open) K.web.open(u.url);
    });
    return c;
  };

  const paint = () => {
    grid.innerHTML = '';
    if (!urls.length) {
      grid.appendChild(el('div', 'web-empty', '未获取到网址（需接入 OA 场景）。'));
      return;
    }
    urls.forEach(u => grid.appendChild(card(u)));
    // 汇总在线情况（有异常时红字，方便一眼发现；未探测完不误报）
    const total = urls.length;
    const up = urls.filter(u => u.ok === true).length;
    const down = urls.filter(u => u.ok === false).length;
    const pending = total - up - down;
    if (summary) {
      if (down > 0) {
        summary.textContent = up + '/' + total + ' · ' + down + '异常';
        summary.style.color = 'var(--err)';
        summary.title = '异常：' + urls.filter(u => u.ok === false).map(u => u.name || u.url).join('、');
      } else if (pending === total) {
        summary.textContent = '探测中…';
        summary.style.color = '';
        summary.title = '';
      } else {
        summary.textContent = up + '/' + total;   // 2026-09-27 用户要求：去掉「· N待探」
        summary.style.color = '';
        summary.title = '全部网址状态正常';
      }
    }
  };

  let probeTick = 0;
  const probe = (all) => {
    if (!K || !K.web || !K.web.check) return;
    refreshBtn.disabled = true;
    refreshBtn.textContent = '探测中…';
    const payload = probePayload(all);
    probeTick++;
    if (!payload.length) { refreshBtn.disabled = false; refreshBtn.textContent = '🔄 探测'; return; }
    K.web.check(payload, !!all).then(res => {
      refreshBtn.disabled = false;
      refreshBtn.textContent = '🔄 探测';
      if (res && Array.isArray(res)) {
        // 新版主进程会回传 backupOk/links 状态 → 说明它只取响应头、不会下载整包
        if (res.some(r => r.backupOk !== undefined)) linksSupported = true;
        const byUrl = {};
        res.forEach(r => { byUrl[String(r.url)] = r; });
        // 合并状态（保留本轮未探测的卡片，如尚未支持探测的 APK）
        urls = urls.map(u => (byUrl[String(u.url)] ? Object.assign({}, u, byUrl[String(u.url)]) : u));
        paint();
      }
    }).catch(() => {
      refreshBtn.disabled = false;
      refreshBtn.textContent = '🔄 探测';
    });
  };

  // 探测负载：主进程未确认"只取响应头"前，不把 .apk 等大文件交给它
  // （旧版主进程 httpProbe 会 drain 正文 → 探测 31MB 的 APK 会真的下载整包）
  // 现主进程用 HEAD（服务器发送 0 字节）+ keep-alive，故每轮都探全部地址（含备用/APK），保证及时发现故障
  let linksSupported = false;
  const HEAVY_URL = /\.apk(\?|$)/i;
  const probePayload = () => urls
    .filter(u => linksSupported || !HEAVY_URL.test(u.url))
    .map(u => Object.assign({}, u, { links: linksSupported ? u.links : [] }));

  if (!K || !K.urls) {
    urls = [
      { name: '管理后台', url: 'http://example.com:8083' },
      { name: '教师端', url: 'http://example.com:8081' },
      { name: '家长端', url: 'http://example.com:8082' }
    ];
    urls = withAlways(urls).map(u => Object.assign(u, {
      ok: true, code: 200, ms: 0,
      backupOk: u.backup ? true : undefined,
      links: u.links ? u.links.map(lk => Object.assign({}, lk, { ok: true, code: 200, ms: 0 })) : undefined
    }));
    paint();
    return;
  }

  K.urls().then(us => {
    urls = withAlways(us);
    // 先用上次回写的状态填充（oa.db web_sites），随后立即探测刷新
    // ⚠ 2026-09-27：paint() 必须单独 try —— 渲染出错若冒泡到下面的数据 catch，
    //   那个 catch 会把 urls 清空 ⇒ 面板显示"未获取到网址"，真实原因被彻底藏起来。
    try {
      paint();
    } catch (e) {
      grid.appendChild(el('div', 'web-empty', '卡片渲染出错：' + ((e && e.message) || e)));
    }
    probe(true);   // 首次全量探测（含备用/APK）
  }).catch(() => {
    // 数据真取不到时，至少把常驻网址（官网/APK）画出来，不再给一个空面板
    urls = withAlways([]);
    paint();
  });
  refreshBtn.addEventListener('click', () => probe(true));   // 手动探测 = 全量
  const stopPoll = oaPoll(30000, () => { if (!disposed) probe(false); });
  return () => { disposed = true; stopPoll(); };
};

// ============ market：自选列表 + A股大盘（持久化本机数据库） ============
renderers.market = (body, meta, head) => {
  const K = window.app.stock;
  let list = [];            // 自选 watchlist
  let disposed = false;     // 场景隔离：切走场景后不再刷新/写库
  const table = el('div', 'mkt-table');

  // 模拟行情源（接 akshare 后替换为真实数据）
  const QUOTES = {
    '600519.SH': ['贵州茅台', '1426.00', '+0.82%', '+11.60'],
    '300750.SZ': ['宁德时代', '186.42', '-1.35%', '-2.55'],
    '002594.SZ': ['比亚迪', '241.88', '+2.10%', '+4.97'],
    '688981.SH': ['中芯国际', '88.55', '-0.44%', '-0.39'],
    '600036.SH': ['招商银行', '34.12', '+0.29%', '+0.10'],
    '601318.SH': ['中国平安', '52.60', '+0.77%', '+0.40'],
    '000858.SZ': ['五粮液', '128.90', '-0.62%', '-0.80'],
    'AAPL': ['Apple', '228.03', '+0.42%', '+0.95'],
    'NVDA': ['NVIDIA', '118.66', '+2.31%', '+2.68'],
    'MSFT': ['Microsoft', '417.11', '-0.18%', '-0.75'],
    'TSLA': ['Tesla', '231.28', '+1.10%', '+2.52'],
    'META': ['Meta', '502.10', '+0.85%', '+4.22']
  };

  // A股大盘（三大指数，紧跟标题显示，红绿涨跌）
  const INDEXES = [
    ['上证', '000001.SH', '3254.31', '+0.52%'],
    ['深证', '399001.SZ', '10417.42', '+0.87%'],
    ['创业板', '399006.SZ', '2152.66', '+1.23%']
  ];

  // 真实行情缓存：code -> { name, price, chg, pct }（腾讯接口）；接口失败时回退到 QUOTES 模拟
  let quotes = {};
  const idxEls = [];   // 每个指数的 [priceEl, pctEl] 引用，供刷新

  // ---- 标题栏（内容区只留数据，工具全部收进标题栏）：三大指数条 + 添加自选表单 ----
  const idxStrip = el('div', 'head-idx');
  const renderIndexes = () => {
    idxStrip.innerHTML = '';
    idxEls.length = 0;
    INDEXES.forEach(item => {
      const [name, code, price, pct] = item;
      const q = quotes[code] || { price, pct };   // 按原始代码（如 000001.SH）存取
      const s = el('span', 'idx-item');
      s.appendChild(el('span', 'idx-name', name));
      const priceEl = el('span', 'idx-price', String(q.price != null ? q.price : price));
      const pctEl = el('span', 'idx-pct', (q.pct != null ? (Number(q.pct) > 0 ? '+' : '') + q.pct + '%' : pct));
      pctEl.style.color = mktColor(pctEl.textContent);
      s.appendChild(priceEl);
      s.appendChild(pctEl);
      idxEls.push([priceEl, pctEl]);
      idxStrip.appendChild(s);
    });
  };

  const headExtra = el('div', 'head-extra');
  // 三大指数紧跟标题（第一行 title 之后），添加自选表单在第二行（见下方 addBox）
  head.appendChild(headExtra);
  head.insertBefore(idxStrip, headExtra);   // headExtra 已在 head 中，idxStrip 插到它前面

  // 代码 -> 腾讯接口格式：600519.SH -> sh600519；600519 -> sh600519；纯字母(含 SHOP/USB) -> us前缀
  const convCode = (code) => {
    const c = String(code || '').trim().toUpperCase();
    if (!c) return '';
    if (c.endsWith('.SH')) return 'sh' + c.slice(0, -3);
    if (c.endsWith('.SZ')) return 'sz' + c.slice(0, -3);
    if (/^\d+$/.test(c)) return (c[0] === '6' || c[0] === '9' ? 'sh' : 'sz') + c;
    if (/^(SH|SZ|HK)\d+/.test(c)) return c.toLowerCase();
    return 'us' + c;   // 纯字母美股 ticker → us 前缀
  };

  // 自选行情落库（quote_cache）：AI 上下文按「股票代码」读取现价。
  // 之前只在添加自选时写了 { name, time }（无价格），导致 AI 分析时现价为空。
  const fetchAndCacheListQuotes = async () => {
    if (disposed) return;
    try {
      const watch = await K.watch.list();
      const codes = [];
      (watch || []).forEach(w => { if (w.code && codes.indexOf(w.code) < 0) codes.push(w.code); });
      if (!codes.length) return;
      const res = await K.quote.realtime(codes);
      if (!(res && res.ok && res.quotes)) return;
      for (let i = 0; i < codes.length; i++) {
        const code = codes[i];
        const q = res.quotes[convCode(code)];
        if (q && q.price) {
          quotes[code] = q;                                  // 供面板显示
          try { await K.quote.cache(code, q); } catch (e) { /* 落库失败不影响刷新 */ }
        }
      }
    } catch (e) { /* ignore */ }
  };

  // 拉取真实行情并刷新：指数 + 当前列表代码一起查
  let fetching = false;
  const fetchQuotes = async () => {
    if (fetching || disposed) return;
    fetching = true;
    const codes = [];
    INDEXES.forEach(([, code]) => codes.push(code));
    (list || []).forEach(item => codes.push(item.code));
    try {
      const res = await K.quote.realtime(codes);
      if (res && res.ok && res.quotes) {
        // 腾讯返回 key 是 sh600519 这种，转回原代码格式存储：直接按 conv 后的 key 存
        const byConv = {};
        Object.keys(res.quotes).forEach(k => { byConv[k] = res.quotes[k]; });
        // 保留并合并（避免覆盖用户手动名）
        list.forEach(item => {
          const q = byConv[convCode(item.code)];
          if (q) {
            quotes[item.code] = q;
          }
        });
        INDEXES.forEach(([, code]) => {
          const q = byConv[convCode(code)];
          if (q) quotes[code] = q;
        });
        renderIndexes();
        refresh();
      }
    } catch (ex) {
      // 接口失败：保持模拟/上一次数据
    }
    fetching = false;
    // 自选现价落库（供 AI 上下文与重启后读取）
    fetchAndCacheListQuotes();
  };
  renderIndexes();   // 首次渲染标题指数（convCode 已定义）

  // ---- 主体：添加自选表单（在标题栏，见 headExtra）+ 自选列表 ----
  const addBox = el('div', 'mkt-add');
  const watchInput = el('input', 'chat-field');
  watchInput.placeholder = '添加代码，如 600519 / AAPL';
  const btn = el('button', 'chat-send', '加入自选');
  btn.title = '添加股票到自选';
  addBox.appendChild(watchInput);
  addBox.appendChild(btn);

  const refresh = () => {
    table.innerHTML = '';
    {   // 自选列表（2026-09-16 起仅自选，持仓功能已整体移除）
      const headRow = el('div', 'mkt-row mkt-head');
      ['名称', '代码', '现价', '涨跌幅', '涨跌额', ''].forEach(h => headRow.appendChild(el('span', 'mkt-cell', h)));
      table.appendChild(headRow);
      if (!list.length) {
        table.appendChild(el('div', 'stat-sub', '还没有自选股。输入股票代码（如 600519 或 AAPL）添加。'));
      }
      list.forEach(w => {
        const q = quotes[w.code] || { name: (QUOTES[w.code] || [w.name])[0], price: (QUOTES[w.code] || ['', '--', '--', '--'])[1], pct: (QUOTES[w.code] || ['', '--', '--', '--'])[2], chg: (QUOTES[w.code] || ['', '--', '--', '--'])[3] };
        const row = el('div', 'mkt-row');
        row.appendChild(el('span', 'mkt-cell', q.name || w.name));
        row.appendChild(el('span', 'mkt-cell dim', w.code));
        row.appendChild(el('span', 'mkt-cell', q.price != null ? q.price : '--'));
        const pct = el('span', 'mkt-cell', q.pct != null ? (Number(q.pct) > 0 ? '+' : '') + q.pct + '%' : '--');
        pct.style.color = mktColor(pct.textContent);
        row.appendChild(pct);
        const amt = el('span', 'mkt-cell', q.chg != null ? (Number(q.chg) > 0 ? '+' : '') + q.chg : '--');
        amt.style.color = mktColor(amt.textContent);
        row.appendChild(amt);
        const del = el('button', 'mkt-del', '✕');
        del.title = '移出自选';
        del.addEventListener('click', async (e) => {
          e.stopPropagation();
          await K.watch.remove(w.code);
          await load();
        });
        row.appendChild(del);
        // 点击整行 → 联动 K线图表面板显示该股
        row.classList.add('mkt-sel');
        row.title = '点击查看 K线/分时分析';
        row.addEventListener('click', () => {
          window.dispatchEvent(new CustomEvent('stockSelect', {
            detail: { code: w.code, name: q.name || w.name }
          }));
        });
        table.appendChild(row);
      });
    }
  };

  const load = async () => {
    list = await K.watch.list();
    refresh();
    fetchQuotes();   // 加载列表后拉真实行情
  };

  // 添加自选：写 watchlist + quote_cache（AI 上下文按代码读现价）
  const doAdd = async () => {
    const code = watchInput.value.trim().toUpperCase();
    if (!code) return;
    const known = QUOTES[code];
    const name = known ? known[0] : (quotes[code] ? quotes[code].name : code);
    await K.watch.set(code, name);
    await K.quote.cache(code, { name, time: new Date().toISOString() });
    watchInput.value = '';
    await load();
  };
  btn.addEventListener('click', doAdd);
  watchInput.addEventListener('keydown', e => { if (e.key === 'Enter') doAdd(); });

  body.classList.add('mkt-body');
  // 添加自选表单也收进标题栏（见头部 headExtra），内容区只留数据
  headExtra.appendChild(addBox);
  const tableWrap = el('div', 'mkt-table-wrap');
  tableWrap.appendChild(table);
  body.appendChild(tableWrap);
  // 初始化：加载自选列表
  (async () => { await load(); })();
  // 每 60s 自动刷新一次真实行情；
  // 场景切换（loadScenario）时销毁定时器与后台刷新，避免跨场景泄漏与接口限流
  const refreshTimer = setInterval(() => { if (!fetching) fetchQuotes(); }, 60000);
  return () => {
    disposed = true;
    clearInterval(refreshTimer);
  };
};

// ============ chart：趋势看板（同花顺式专业 K线图 + 票号直达 + 板块趋势联动） ============
// 输入框+加号：输入票号直接查看（自动补全市场前缀）；默认显示上一次看的票（localStorage 持久化）；
// 板块雷达单击板块 → 本面板切换「板块趋势」视图（板块简介 + 近 N 日涨跌柱状图 + 成分股行情）
renderers.chart = (body, meta, panelHead) => {
  let chartStopped = false;   // ★2026-10-16：切走场景时停掉盘中 30 秒刷新
  const K = window.app.stock;
  const UP = '#e5484d', DOWN = '#2ebd85';
  const LAST_KEY = 'trend_last_v1';
  let state = {
    code: '600519.SH', name: '贵州茅台',
    period: 'day',           // 'min' | 'day' | 'week' | 'month'
    kline: [],               // K线数组 [date, open, close, high, low, volume]
    minute: [],              // 分时数组 ['0930 price vol amount']
    loading: false,
    nShow: 70,               // K线显示根数（时间轴缩放，30~250）
    viewEnd: 0,              // 可视窗口最后一根 K线下标（平移用），0=最新
    realtime: null           // 最近一次实时行情（含 preclose：分时"昨收"基准线要用它，不能用 K线收盘价兜）
  };
  let sectorTrend = null;    // 板块趋势模式：null=个股K线；{sector, market, quotes}

  // ---- 工具条：票号输入框+加号 + 股票名/现价 + 周期切换 → 全部并入「面板标题栏」同一排 ----
  // ★ 2026-09-20：行情串拆成 4 段（代码/名称/现价/涨跌）。名称可省略号收缩、代码与价格不收缩，
  //   于是 1 列宽面板（≈382px）里「标题 + 票号 + 行情 + 周期」也能压成单行，把标题栏高度让给 K 线图。
  const info = el('span', 'chart-stock');
  const infoCode = el('span', 'chart-stock-code', '600519.SH');
  const infoName = el('span', 'chart-stock-name', '贵州茅台');
  const infoPrice = el('span', 'chart-stock-price', '');
  const infoPct = el('span', 'chart-stock-pct', '');
  info.appendChild(infoCode); info.appendChild(infoName);
  info.appendChild(infoPrice); info.appendChild(infoPct);
  const codeInput = el('input', 'chart-input', '');
  codeInput.placeholder = '票号';
  codeInput.type = 'text';
  codeInput.title = '输入 A股代码或美股代码，回车/点＋立即查看；输入过程自动联想加载';
  const addBtn = el('button', 'chart-add', '＋');
  addBtn.title = '查看该票（回车等价）';
  const periods = [['分时', 'min'], ['日K', 'day'], ['周K', 'week'], ['月K', 'month']];
  const periodBar = el('div', 'chart-periods');
  const periodBtns = {};
  periods.forEach(([label, key]) => {
    const b = el('button', 'chart-period' + (key === 'day' ? ' on' : ''), label);
    b.addEventListener('click', () => { setPeriod(key); });
    periodBar.appendChild(b);
    periodBtns[key] = b;
  });
  // 侧栏开关（五档盘口 / 筹码分布）：与周期按钮同一排，外观沿用 .chart-period
  const sideSep = el('span', 'chart-side-sep', '');
  const btnBook = el('button', 'chart-period chart-side-t', '盘口');
  const btnChip = el('button', 'chart-period chart-side-t', '筹码');
  btnBook.addEventListener('click', () => { sideCfg.book = !sideCfg.book; saveSide(); applySide(true); });
  btnChip.addEventListener('click', () => { sideCfg.chip = !sideCfg.chip; saveSide(); applySide(true); });
  periodBar.appendChild(sideSep);
  periodBar.appendChild(btnBook);
  periodBar.appendChild(btnChip);
  body.classList.add('chart-body');
  if (panelHead) {
    panelHead.classList.add('chart-panel-head');
    const acts = el('div', 'chart-head-acts');
    acts.appendChild(codeInput);
    acts.appendChild(addBtn);
    acts.appendChild(info);
    acts.appendChild(periodBar);
    panelHead.appendChild(acts);
  } else {
    const head = el('div', 'chart-head');   // 兜底：拿不到标题栏时仍放内容区顶部
    head.appendChild(codeInput);
    head.appendChild(addBtn);
    head.appendChild(info);
    head.appendChild(periodBar);
    body.appendChild(head);
  }

  // 票号解析：兼容 600519 / 600519.SH / sh600519 / AAPL / 00700.HK
  const parseCode = (raw) => {
    let c = String(raw || '').trim().toUpperCase();
    if (!c) return '';
    if (/^\d{6}$/.test(c)) return c[0] === '6' || c[0] === '9' ? c + '.SH' : c + '.SZ';
    if (/^\d{5}$/.test(c)) return c + '.HK';
    return c;
  };
  let inputTimer = null;
  const goCode = () => {
    const c = parseCode(codeInput.value);
    if (!c) return;
    load(c, c);
  };
  // 输入自动加载（防抖 600ms）：输入票号自动显示情况
  codeInput.addEventListener('input', () => {
    clearTimeout(inputTimer);
    inputTimer = setTimeout(goCode, 600);
  });
  codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { clearTimeout(inputTimer); goCode(); }
  });
  addBtn.addEventListener('click', () => { clearTimeout(inputTimer); goCode(); });

  // ---- 主体：左侧 canvas 图表 + 右侧栏（分时→五档盘口，K线→筹码分布） ----
  const main = el('div', 'chart-main');
  // 板块趋势视图（板块雷达单击板块时显示）：板块简介 + 近 N 日涨跌柱状图 + 成分股行情
  const sectorView = el('div', 'chart-sector');
  sectorView.style.display = 'none';
  const secHead = el('div', 'sec-head');
  const secIcon = el('span', 'sec-ico', '');
  const secTitle = el('span', 'sec-title', '');
  const secAvg = el('span', 'sec-avg', '');
  secHead.appendChild(secIcon);
  secHead.appendChild(secTitle);
  secHead.appendChild(secAvg);
  const secDesc = el('div', 'sec-desc', '');
  const secHistTitle = el('div', 'sec-hist-title', '近 N 日板块涨跌（每日快照入库）');
  const secHist = el('div', 'sec-hist', '');
  const secStkTitle = el('div', 'sec-stk-title', '板块成分股（点击查看个股K线）');
  const secStks = el('div', 'sec-stks', '');
  sectorView.appendChild(secHead);
  sectorView.appendChild(secDesc);
  sectorView.appendChild(secHistTitle);
  sectorView.appendChild(secHist);
  sectorView.appendChild(secStkTitle);
  sectorView.appendChild(secStks);
  body.appendChild(sectorView);
  const canvasWrap = el('div', 'chart-canvas-wrap');
  const canvas = document.createElement('canvas');
  canvas.className = 'chart-canvas';
  const ctx = canvas.getContext('2d');
  canvasWrap.appendChild(canvas);
  main.appendChild(canvasWrap);
  const side = el('div', 'chart-side');
  // 五档盘口（买1-5 / 卖1-5，同花顺式）
  const levels = el('div', 'chart-levels');
  const lvHead = el('div', 'lv-head');
  lvHead.appendChild(el('span', 'lv-title', '五档盘口'));
  const lvName = el('span', 'lv-name', '');
  lvHead.appendChild(lvName);
  const lvPrice = el('div', 'lv-price', '--');
  const lvSub = el('div', 'lv-sub', '');
  const lvRows = el('div', 'lv-rows');
  levels.appendChild(lvHead);
  levels.appendChild(lvPrice);
  levels.appendChild(lvSub);
  levels.appendChild(lvRows);
  side.appendChild(levels);
  // 筹码分布（日K/周K/月K 右侧显示，价格轴与主图对齐）
  const chip = el('div', 'chart-chip');
  const chipHead = el('div', 'lv-head');
  chipHead.appendChild(el('span', 'lv-title', '筹码分布'));
  chip.appendChild(chipHead);
  const chipCanvas = document.createElement('canvas');
  chipCanvas.className = 'chip-canvas';
  const chipCtx = chipCanvas.getContext('2d');
  chip.appendChild(chipCanvas);
  side.appendChild(chip);
  // ---- 侧栏开关（2026-10-14 用户要求：五档盘口 / 筹码分布 可以各自选择显示或隐藏）----
  // 分时页签用五档盘口、日K/周K/月K 用筹码分布（本来就按周期互斥），所以就是两个独立开关。
  // 两个都关掉后 canvas 自动占满宽度（ResizeObserver 盯着 canvasWrap，会自己重画到新宽度）。
  // ⚠ 显隐判断**统一收口到 applySide()**：原来散在 load() / 板块模式 / 初始化三处，
  //   加了开关后必须收口，否则"分时↔日K 来回切"或"刷新行情"会把用户的开关状态冲掉。
  // 键名带版本：开关语义变了就升版，旧值自动作废（不留半截旧状态）
  const SIDE_KEY = 'chart_side_v2';
  const sideCfg = { book: true, chip: true };
  try {
    const s0 = JSON.parse(localStorage.getItem(SIDE_KEY) || '{}');
    if (s0 && typeof s0 === 'object') { sideCfg.book = s0.book !== false; sideCfg.chip = s0.chip !== false; }
  } catch (e) { /* ignore */ }
  const saveSide = () => { try { localStorage.setItem(SIDE_KEY, JSON.stringify(sideCfg)); } catch (e) { /* ignore */ } };
  const applySide = (redraw) => {
    const narrow = body.classList.contains('chart-narrow');   // 窄面板(<560px)自动收起（否则图被挤成一条）
    const isMin = state.period === 'min';
    const wantBook = sideCfg.book && isMin;
    const wantChip = sideCfg.chip && !isMin;
    levels.style.display = (!narrow && wantBook) ? '' : 'none';
    chip.style.display = (!narrow && wantChip) ? '' : 'none';
    side.style.display = (!narrow && (wantBook || wantChip)) ? '' : 'none';
    // ⚠ 按钮 .on = **此刻真的显示着**（pref && 当前周期适用 && 面板不窄）：
    //   否则日K 页签下"盘口"亮着却没盘口栏，用户会以为按钮坏了。
    //   pref 与 eff 分开判断，是为了把"你开过、但这个页签不用它"讲清楚（见 title）。
    const mark = (b2, pref, eff, label, onlyMin) => {
      if (!b2) return;
      b2.classList.toggle('on', !!(eff && !narrow));
      let tail;
      if (!pref) tail = '　已收起，点一下显示';
      else if (narrow) tail = '　面板太窄（<560px）已自动收起，拉宽面板即恢复';
      else if (!eff) tail = onlyMin ? '　只在分时页签显示，切到分时即出现' : '　只在日K/周K/月K 页签显示';
      else tail = '　当前显示中，点一下收起';
      b2.title = label + tail;
    };
    mark(btnBook, sideCfg.book, wantBook, '五档盘口', true);
    mark(btnChip, sideCfg.chip, wantChip, '筹码分布', false);
    // redraw=false 用于"定义后立刻调一次"（那时 resizeCanvas 还没定义，碰它会 TDZ 报错）
    if (redraw !== false) requestAnimationFrame(() => { try { resizeCanvas(); } catch (e) { /* ignore */ } });
  };
  applySide(false);
  main.appendChild(side);
  body.appendChild(main);
  // 操作提示从「占一行内容区」改成面板标题的悬停提示（省一行高度）
  if (panelHead) {
    const t = panelHead.querySelector('.panel-title');
    if (t) t.title = '点击板块雷达、选股建议里的任意股票即可联动此处\n滚轮缩放时间轴 · 按住拖拽平移 · 数据来自腾讯行情（已本地缓存）';
  }

  // 高分屏适配 + 自适应尺寸
  // ⚠ 关键（2026-09-21）：必须用 **offsetWidth/offsetHeight**（布局盒尺寸），不能用 getBoundingClientRect()——
  // canvas 是 flex 子项，rect 会带上"上一次画布尺寸"算出来的布局，首帧/面板刚布局完时量到的是旧的小尺寸，
  // 于是绘图缓冲区比面板小一圈，右下大片空白（图表像"没占满窗口"）。
  // 另外先把 canvas.width/height 归零，切断"布局尺寸 ← 画布尺寸"的回环，量到的才是真·可用空间。
  const resizeCanvas = () => {
    const pw = body.clientWidth || 0;
    body.classList.toggle('chart-narrow', pw > 0 && pw < 560);
    const cw0 = canvas.offsetWidth, chh0 = canvas.offsetHeight;
    if (!cw0 || !chh0) return;            // 面板还没量到尺寸：交给 ResizeObserver 下次回调
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.round(cw0 * dpr), bh = Math.round(chh0 * dpr);
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw; canvas.height = bh;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    const ccw = chipCanvas.offsetWidth, cch = chipCanvas.offsetHeight;
    if (ccw && cch && (chipCanvas.width !== Math.round(ccw * dpr) || chipCanvas.height !== Math.round(cch * dpr))) {
      chipCanvas.width = Math.round(ccw * dpr);
      chipCanvas.height = Math.round(cch * dpr);
      chipCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    draw();
  };
  // ResizeObserver：面板缩放时图表自适应（场景切换时断开）
  let ro = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => {
      // 先归零缓冲区再量：量到的是 CSS 布局真值，画布尺寸不再反过来撑大布局
      const w0 = canvas.width, h0 = canvas.height;
      canvas.width = 0; canvas.height = 0;
      resizeCanvas();
      if (!canvas.width || canvas.width <= 10) { canvas.width = w0; canvas.height = h0; }   // 退化保护
    });
    ro.observe(canvasWrap);
    ro.observe(body);
  }
  window.addEventListener('resize', resizeCanvas);

  // ---- 数据加载 ----
  // 尺寸兜底：面板刚渲染时 canvas 可能没有布局尺寸（宽高为 0），draw 会直接 return；
  // 用 rAF 重试若干次等布局完成再画；rAF 在面板隐藏（display:none）时不触发，再用 setTimeout 兜底。
  const ensureDraw = () => {
    let n = 30;   // rAF 30 次 ≈ 480ms
    // 判定"尺寸就绪"也看画布缓冲区（和 draw 同一口径），避免 rect 与画布不一致时反复空转
    const ready = () => {
      const dpr = window.devicePixelRatio || 1;
      return canvas.width / dpr > 5 && canvas.height / dpr > 5;
    };
    const attempt = () => {
      if (ready()) { (typeof resizeCanvas === 'function' ? resizeCanvas : draw)(); return; }
      if (n-- > 0) requestAnimationFrame(attempt);
    };
    attempt();
    // 面板隐藏/延迟布局时 rAF 可能空转：定时器兜底强制重绘一次
    setTimeout(() => {
      if (ready() && state.kline.length) (typeof resizeCanvas === 'function' ? resizeCanvas : draw)();
    }, 500);
  };

  // 记住最近一次 K线结果的腾讯代码（sh600519），供实时行情对齐
  let lastResCode = '';
  const resCodeOf = () => lastResCode;

  const applyData = (res) => {
    if (res && res.ok) {
      state.kline = res.kline || [];
      state.minute = res.minute || [];
      state.minDate = res.date || '';
      if (res.code) lastResCode = res.code;
      return true;
    }
    return false;
  };

  const load = async (code, name, quiet) => {
    state.code = code; state.name = name;
    infoCode.textContent = code; infoName.textContent = name;
    infoPrice.textContent = ''; infoPct.textContent = '';   // 等实时行情回来再填现价/涨跌
    state.loading = true;
    state.nShow = 70; state.viewEnd = 0;   // 切换股票重置缩放/平移
    // 个股模式：退出板块趋势视图（板块模式 = 主 canvas 画板块合成K线 + 底部信息区，见 showSectorTrend）
    if (sectorTrend) {
      sectorTrend = null;
      sectorView.style.display = 'none';
      body.classList.remove('chart-sector-mode');
      main.style.display = '';
      applySide();   // 恢复五档/筹码侧栏（含用户的开关状态）
      resizeCanvas();
    }
    // 记住「上一次看的票」（⟳ 刷新后默认显示这只）
    try { localStorage.setItem(LAST_KEY, JSON.stringify({ code, name })); } catch (e) { /* ignore */ }
    const per = state.period === 'min' ? 'day' : state.period;
    const isMin = state.period === 'min';
    // 侧栏显隐统一走 applySide()（五档盘口 / 筹码分布 各有开关，见该函数）
    applySide();
    // quiet（盘中 30 秒静默刷新）⇒ 不调暗画布、不清 realtime，避免每 30 秒闪一下
    if (!quiet) {
      canvas.style.opacity = 0.4;
      state.realtime = null;   // 换股票先清掉上一只的实时行情，避免"昨收"基准线用错标的
    }
    // 1) 先画本地持久缓存（秒开，不联网；重启/重开面板不白屏）
    //    ⚠ 分时模式**跳过缓存**：分时图要"昨收"基准线，缓存里的日K可能是很多天前的旧数据
    //    （实测 000823 缓存停在 2026-09-08，导致分时 25 元、昨收线却在 16.53，整张图对不上）。
    if (!isMin) {
      try {
        const cached = await K.kline.latest(code, per);
        if (cached && cached.kline && cached.kline.length) {
          applyData(cached);
          ensureDraw();
        }
      } catch (e) { /* 缓存不可用则直接等网络 */ }
    }
    // 2) 后台拉最新（腾讯接口，成功后写库；网络失败不清空已有缓存）
    //    分时周期 force=true：日K 必须取最新（既要当天日期，也要正确的昨收），不能吃缓存
    try {
      const res = await K.kline.history(code, per, 120, isMin);
      if (res && res.ok) {
        applyData(res);
      } else if (!state.kline.length) {
        state.kline = []; state.minute = [];
      }
    } catch (e) { /* 保持缓存数据 */ }
    // 3) 分时 + 实时行情一起更新标题（现价/涨跌）
    try {
      const q = await K.quote.realtime([code]);
      if (q && q.ok && q.quotes) {
        const qq = q.quotes[(resCodeOf() || code)];
        if (qq) {
          state.realtime = qq;   // 分时图的"昨收"基准线取这里的 preclose（交易所口径，最准）
          infoCode.textContent = code;
          infoName.textContent = name;
          infoPrice.textContent = qq.price;
          infoPct.textContent = (Number(qq.pct) > 0 ? '+' : '') + qq.pct + '%';
          const qc = mktColor(qq.chg);   // A股红涨绿跌：现价与涨跌幅同色
          infoPrice.style.color = qc; infoPct.style.color = qc;
          renderLevels(qq);   // 五档盘口 + 现价/涨跌
        }
      }
    } catch (e) { /* 实时价失败不影响图表 */ }
    state.loading = false;
    canvas.style.opacity = 1;
    ensureDraw();
  };

  // ---- 五档盘口渲染（买1-5 / 卖1-5，同花顺式） ----
  const renderLevels = (q) => {
    const fmtP = (v) => (v == null || v === '' || isNaN(Number(v))) ? '--' : Number(v).toFixed(2);
    lvName.textContent = q.name || '';
    lvPrice.textContent = fmtP(q.price);
    lvPrice.style.color = mktColor(q.chg);
    const chgTxt = q.pct != null ? ((Number(q.pct) > 0 ? '+' : '') + q.pct + '%') : '--';
    const chgAmt = q.chg != null ? ((Number(q.chg) > 0 ? '+' : '') + q.chg) : '';
    lvSub.textContent = [q.open != null ? '开 ' + fmtP(q.open) : '', q.high != null ? '高 ' + fmtP(q.high) : '', q.low != null ? '低 ' + fmtP(q.low) : ''].filter(Boolean).join('  ') + (chgTxt !== '--' ? '  ·  ' + chgTxt + (chgAmt ? ' (' + chgAmt + ')' : '') : '');
    lvSub.style.color = mktColor(q.chg);
    lvRows.innerHTML = '';
    const maxVol = Math.max(1, ...(q.ask || []).map(a => Number(a[1]) || 0), ...(q.bid || []).map(b => Number(b[1]) || 0));
    // 卖（上方，绿色）
    (q.ask || []).forEach((a, i) => {
      const row = el('div', 'lv-row lv-ask');
      const tag = el('span', 'lv-tag', '卖' + (i + 1));
      const pr = el('span', 'lv-px', fmtP(a[0]));
      const bar = el('div', 'lv-bar-wrap');
      const barIn = el('div', 'lv-bar', '');
      barIn.style.width = Math.round((Number(a[1]) || 0) / maxVol * 100) + '%';
      bar.appendChild(barIn);
      const qty = el('span', 'lv-qty', String(a[1] || ''));
      row.appendChild(tag); row.appendChild(pr); row.appendChild(bar); row.appendChild(qty);
      lvRows.appendChild(row);
    });
    // 现价分隔行
    const mid = el('div', 'lv-row lv-mid');
    mid.appendChild(el('span', 'lv-tag', '—'));
    mid.appendChild(el('span', 'lv-px', fmtP(q.price)));
    mid.appendChild(el('span', 'lv-bar-wrap', ''));
    mid.appendChild(el('span', 'lv-qty', chgTxt !== '--' ? chgTxt : ''));
    lvRows.appendChild(mid);
    // 买（下方，红色）
    (q.bid || []).forEach((b, i) => {
      const row = el('div', 'lv-row lv-bid');
      const tag = el('span', 'lv-tag', '买' + (i + 1));
      const pr = el('span', 'lv-px', fmtP(b[0]));
      const bar = el('div', 'lv-bar-wrap');
      const barIn = el('div', 'lv-bar', '');
      barIn.style.width = Math.round((Number(b[1]) || 0) / maxVol * 100) + '%';
      bar.appendChild(barIn);
      const qty = el('span', 'lv-qty', String(b[1] || ''));
      row.appendChild(tag); row.appendChild(pr); row.appendChild(bar); row.appendChild(qty);
      lvRows.appendChild(row);
    });
  };
  renderLevels({});   // 初始占位（显隐由上面的 applySide() 定：初始日K → 显示筹码、隐藏五档）

  const setPeriod = (key) => {
    // 板块趋势模式：板块K线是成分股等权合成的日K，只有 day 周期；点其它周期直接忽略（不切回个股）
    if (sectorTrend) {
      if (key === 'day') {
        Object.keys(periodBtns).forEach(k => periodBtns[k].classList.toggle('on', k === 'day'));
      }
      return;
    }
    state.period = key;
    state.nShow = 70; state.viewEnd = 0;   // 切换周期重置缩放/平移
    Object.keys(periodBtns).forEach(k => periodBtns[k].classList.toggle('on', k === key));
    load(state.code, state.name);
  };

  // ---- 绘图 ----
  const fmt = (v) => Number(v).toFixed(2);

  // ---- 筹码分布（右侧，价格轴与主图对齐） ----
  const drawChip = (start, end, minP, maxP) => {
    if (chip.style.display === 'none' || state.period === 'min') return;
    const W = chipCanvas.clientWidth, H = chipCanvas.clientHeight;
    if (!W || !H) return;
    chipCtx.clearRect(0, 0, W, H);
    const padT = 22, mainH = Math.round(H * 0.58);
    const L = 48;                     // 价格档数
    const rows = state.kline;
    if (!rows || !rows.length) return;
    const opens = rows.map(r => Number(r[1]));
    const closes = rows.map(r => Number(r[2]));
    const highs = rows.map(r => Number(r[3]));
    const lows = rows.map(r => Number(r[4]));
    const vols = rows.map(r => Number(r[5]));
    const span = (maxP - minP) || 1;
    const bins = new Array(L).fill(0);
    for (let i = start; i <= end; i++) {
      const lo = lows[i], hi = highs[i], cl = closes[i], v = vols[i] || 0;
      if (hi <= lo) {
        const k = Math.max(0, Math.min(L - 1, Math.floor((cl - minP) / span * L)));
        bins[k] += v;
        continue;
      }
      const seg = v / (hi - lo);
      const k0 = Math.max(0, Math.floor((lo - minP) / span * L));
      const k1 = Math.min(L - 1, Math.floor((hi - minP) / span * L));
      for (let k = k0; k <= k1; k++) {
        const pLow = minP + span * k / L;
        const pHigh = minP + span * (k + 1) / L;
        const ov = Math.max(0, Math.min(hi, pHigh) - Math.max(lo, pLow));
        bins[k] += ov * seg;
      }
    }
    const bmax = Math.max(...bins, 1);
    const priceAxisW = 42, plotW = Math.max(10, W - priceAxisW - 6);
    // 网格（与主图 6 档对齐）
    chipCtx.strokeStyle = 'rgba(139,147,167,0.12)';
    chipCtx.fillStyle = '#8b93a7';
    chipCtx.textAlign = 'right';
    for (let i = 0; i <= 5; i++) {
      const p = maxP - span * i / 5;
      const yy = padT + (i / 5) * mainH;
      chipCtx.beginPath(); chipCtx.moveTo(0, yy); chipCtx.lineTo(plotW, yy); chipCtx.stroke();
      chipCtx.fillText(p.toFixed(2), W - 4, yy + 3);
    }
    // 筹码柱（从右向左延伸）
    const binH = mainH / L;
    for (let k = 0; k < L; k++) {
      const v = bins[k];
      if (!v) continue;
      const yk = padT + k * binH;
      const w = Math.max(1, (v / bmax) * plotW);
      chipCtx.fillStyle = 'rgba(79,140,255,0.5)';
      chipCtx.fillRect(plotW - w, yk, w, Math.max(1, binH - 1));
    }
  };

  // 计算均线
  const sma = (arr, n) => {
    return arr.map((_, i) => {
      if (i < n - 1) return null;
      let s = 0;
      for (let j = i - n + 1; j <= i; j++) s += arr[j];
      return s / n;
    });
  };
  // MACD（12,26,9）
  const macd = (closes) => {
    const ema = (n) => {
      const out = [closes[0]];
      const k = 2 / (n + 1);
      for (let i = 1; i < closes.length; i++) out.push(closes[i] * k + out[i - 1] * (1 - k));
      return out;
    };
    const e12 = ema(12), e26 = ema(26);
    const dif = closes.map((_, i) => e12[i] - e26[i]);
    const dea = [dif[0]];
    const k = 2 / 10;
    for (let i = 1; i < dif.length; i++) dea.push(dif[i] * k + dea[i - 1] * (1 - k));
    const hist = dif.map((v, i) => (v - dea[i]) * 2);
    return { dif, dea, hist };
  };

  const draw = () => {
    // ⚠ 绘图尺寸一律从**画布缓冲区**换算（canvas.width / dpr），不再 getBoundingClientRect()：
    // 画布尺寸由 resizeCanvas 按布局盒设定，这里再量一次布局只会引入"旧尺寸"，右下会留出空白。
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.width / dpr, H = canvas.height / dpr;
    if (!W || !H || W < 5 || H < 5) {
      // 尺寸未就绪：延迟自愈重绘一次（面板刚布局/切场景时）
      setTimeout(() => {
        if (canvas.width / (window.devicePixelRatio || 1) > 5 && (state.kline.length || state.minute.length)) draw();
      }, 300);
      return;
    }
    ctx.clearRect(0, 0, W, H);
    ctx.font = '10px system-ui, sans-serif';

    if (state.period === 'min') { drawMinute(W, H); return; }
    drawKline(W, H);
  };

  // ---- 分时图 ----
  const drawMinute = (W, H) => {
    // ⚠ 2026-10-13 修「分时图鼠标信息是错的/显示的是日期」：
    //   canvas.onmousemove 是**属性**，切周期时不会自动失效 —— 分时以前没有自己的处理器，
    //   日K 那次 drawKline 装上的处理器会一直残留，并按"日K 槽位"把鼠标 x 换成下标，
    //   于是鼠标停在 11:35 却读到 34 个交易日前的 2026-06-04 那根日K的 开/高/低/收。
    //   这里先清掉，再由下面的分时专用处理器接管。
    canvas.onmousemove = null;
    // ⚠ 2026-10-13：腾讯分时数据带 15:01–15:30 的"盘后固定价格交易"尾巴（实测 267 行、末行 1530），
    //   若按行号均匀铺进 09:30–15:00 的横轴：右侧会出现一条不动的平线（价格不变、量不增）、
    //   刻度与十字光标也整体左移。这里只保留正常交易时段（09:30–11:30 / 13:00–15:00）。
    const rowsAll = state.minute;
    const rowsKept = rowsAll.filter(r => { const t = String(r).split(' ')[0]; return t >= '0930' && t <= '1500'; });
    const rows = rowsKept.length ? rowsKept : rowsAll;
    if (!rows.length) {
      ctx.fillStyle = '#8b93a7';
      ctx.textAlign = 'center';
      ctx.fillText('暂无分时数据（可能休市或美股）', W / 2, H / 2);
      return;
    }
    const prices = rows.map(r => Number(r.split(' ')[1]));
    const vols = rows.map(r => Number(r.split(' ')[2]));
    const maxP = Math.max(...prices), minP = Math.min(...prices);
    // 昨收基准价优先级：① 实时行情的 preclose（交易所口径，最准）→ ② 日K最后一根的收盘价
    // ⚠ 不能用 kline[length-1][3]：腾讯字段是 [date, open, close, high, low, vol]，[3] 是**最高价**；
    //   而且日K缓存可能停在多天前，会画出一条和分时价完全不搭的"昨收"线（用户报"显示的是错的"）。
    const rtPre = Number(state.realtime && state.realtime.preclose);
    const kLast = state.kline.length ? state.kline[state.kline.length - 1] : null;
    let preclose = (isFinite(rtPre) && rtPre > 0) ? rtPre
      : (kLast ? Number(kLast[2]) : 0);
    if (!(preclose > 0)) preclose = prices[0] || 0;
    const padL = 56, padR = 12, padT = 14, padB = 20;
    const cw = W - padL - padR, ch = H - padT - padB;
    const span = Math.max(maxP - minP, Math.abs(preclose - minP), Math.abs(maxP - preclose), 0.01);
    const top = Math.max(maxP, preclose) + span * 0.1;
    const bottom = Math.min(minP, preclose) - span * 0.1;
    const y = (p) => padT + (top - p) / (top - bottom) * ch;

    // 背景网格 + 昨收线
    const preY = y(preclose);          // 2026-10-13：昨收标注要和刻度数字"去重"，位置得先算出来
    ctx.strokeStyle = 'rgba(139,147,167,0.15)';
    ctx.fillStyle = '#8b93a7';
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const p = top + (bottom - top) * i / 4;
      ctx.beginPath(); ctx.moveTo(padL, y(p)); ctx.lineTo(W - padR, y(p)); ctx.stroke();
      // ⚠ 与"昨收 xx.xx"同一水平线的那个刻度数字跳过：昨收线本来就落在某个刻度上，
      //   两个数上下紧贴（实测 昨收 25.83 下面叠着 25.83），用户报"重叠"。
      if (Math.abs(y(p) - preY) < 13) continue;
      ctx.fillText(p.toFixed(2), padL - 4, y(p) + 3);
    }
    // 昨收基准线
    ctx.strokeStyle = '#8b93a7'; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(padL, preY); ctx.lineTo(W - padR, preY); ctx.stroke();
    ctx.setLineDash([]);
    // 昨收标注：抬高 2px 与虚线拉开（刻度数字已跳过，不再重叠）；左侧空间不够时自动右移，避免被画布裁掉
    const preTxt = '昨收 ' + preclose.toFixed(2);
    const preW = ctx.measureText(preTxt).width;
    ctx.fillText(preTxt, Math.max(preW + 4, padL - 4), preY - 5);
    // 均价线（累计成交额/累计量）
    const cumAmount = [], cumVol = [];
    let a = 0, v = 0;
    rows.forEach(r => {
      const p2 = r.split(' ');
      a += Number(p2[3] || 0); v += Number(p2[2] || 0);
      cumAmount.push(a); cumVol.push(v);
    });
    const avg = prices.map((_, i) => cumVol[i] > 0 ? cumAmount[i] / cumVol[i] / 100 : prices[i]);
    // 价格线
    ctx.strokeStyle = '#4f8cff'; ctx.lineWidth = 1.2; ctx.beginPath();
    prices.forEach((p, i) => {
      const x = padL + i / (rows.length - 1) * cw;
      i === 0 ? ctx.moveTo(x, y(p)) : ctx.lineTo(x, y(p));
    });
    ctx.stroke();
    // 均价线
    ctx.strokeStyle = '#e8b339'; ctx.lineWidth = 1; ctx.beginPath();
    avg.forEach((p, i) => {
      const x = padL + i / (rows.length - 1) * cw;
      i === 0 ? ctx.moveTo(x, y(p)) : ctx.lineTo(x, y(p));
    });
    ctx.stroke();
    // 底部成交量（红绿按价格涨跌）
    const vmax = Math.max(...vols, 1);
    const vh = 40;
    prices.forEach((p, i) => {
      const x = padL + i / (rows.length - 1) * cw;
      const hv = (vols[i] / vmax) * vh;
      ctx.fillStyle = p >= preclose ? 'rgba(229,72,77,0.5)' : 'rgba(46,189,133,0.5)';
      ctx.fillRect(x - cw / rows.length / 2, padT + ch - hv, Math.max(1, cw / rows.length - 1), hv);
    });
    // 时间轴：按**真实分钟**定位（不再均匀 5 等分）—— 分时数据里没有午休那 90 分钟，
    // 均匀铺会让 11:30 / 13:30 这类刻度漂掉（11:30 实际在第 45% 处，均分却在 40%）
    // ⚠ 2026-10-14 修两个显示 bug（用户报"分时图右下时间重叠、卡不见"）：
    //   ① 旧写法把"还没到的时点"回退到最后一根 ⇒ 10:30/11:30/13:30/14:30/15:00 五个标签
    //      全叠在同一 x 上（右下角糊成 "10:1?10:30"）⇒ 没到的时点**直接不画**；
    //   ② 首/尾标签中心对齐会各自越界一半被裁（"卡不见"）⇒ 夹在 [padL, W-padR] 内；
    //   ③ 再挡一道最小间距，任何两个标签都不许叠在一起（窄面板同理）。
    ctx.fillStyle = '#8b93a7'; ctx.textAlign = 'center';
    const times = ['09:30', '10:30', '11:30', '13:30', '14:30', '15:00'];
    let lastLbl = -1e9;
    times.forEach((tl) => {
      const xi = rows.findIndex(r => String(r).split(' ')[0] >= tl.replace(':', ''));
      if (xi < 0) return;                                   // 该时点还没到（数据没走到）⇒ 不画
      const x = padL + xi / Math.max(1, rows.length - 1) * cw;
      const tw = ctx.measureText(tl).width;
      const xc = Math.max(padL + tw / 2 + 2, Math.min(W - padR - tw / 2 - 2, x));   // 首尾不越界
      if (xc - lastLbl < tw + 14) return;                   // 与上一个标签太近 ⇒ 跳过（防重叠）
      ctx.fillText(tl, xc, padT + ch + 14);
      lastLbl = xc;
    });

    // ---- 分时十字光标（横轴是"分钟下标"，不是日K槽位；信息按分时口径：时间/价/均/涨跌/量）----
    canvas.onmousemove = (e) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      if (mx < padL || mx > W - padR) { draw(); return; }
      const i = Math.max(0, Math.min(rows.length - 1, Math.round((mx - padL) / cw * (rows.length - 1))));
      draw();
      const px = padL + i / (rows.length - 1) * cw;
      const p = prices[i];
      ctx.strokeStyle = 'rgba(139,147,167,0.55)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(px, padT); ctx.lineTo(px, padT + ch); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(padL, y(p)); ctx.lineTo(W - padR, y(p)); ctx.stroke();
      const tRaw = String(rows[i]).split(' ')[0] || '';
      const hhmm = tRaw.length >= 4 ? tRaw.slice(0, 2) + ':' + tRaw.slice(2, 4) : tRaw;
      const diff = preclose > 0 ? (p - preclose) / preclose * 100 : 0;
      const txt = hhmm + '  价 ' + p.toFixed(2) + '  均 ' + (avg[i] || p).toFixed(2) +
        '  ' + (diff >= 0 ? '+' : '') + diff.toFixed(2) + '%  量 ' + vols[i];
      const tw = ctx.measureText(txt).width + 14;
      const bx = Math.min(W - tw - 6, 8);
      ctx.fillStyle = 'rgba(20,24,36,0.92)';
      ctx.fillRect(bx, 2, tw, 18);
      ctx.fillStyle = p >= preclose ? UP : DOWN;
      ctx.textAlign = 'left';
      ctx.fillText(txt, bx + 7, 14);
      // 底部时间药丸：鼠标在哪一分钟，一眼看到时间（与日K的日期药丸同一位置）
      const dw = ctx.measureText(hhmm).width + 10;
      const dbx = Math.max(padL, Math.min(W - padR - dw, px - dw / 2));
      ctx.fillStyle = 'rgba(79,140,255,0.92)';
      ctx.fillRect(dbx, padT + ch + 3, dw, 14);
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center';
      ctx.fillText(hhmm, dbx + dw / 2, padT + ch + 13.5);
    };
  };

  // ---- K线图（蜡烛 + 均线 + 成交量 + MACD） ----
  const drawKline = (W, H) => {
    const rows = state.kline;
    if (!rows.length) {
      ctx.fillStyle = '#8b93a7'; ctx.textAlign = 'center';
      ctx.fillText('暂无K线数据（可能代码无效或美股）', W / 2, H / 2);
      return;
    }
    // 解析 [date, open, close, high, low, volume]
    const dates = rows.map(r => String(r[0]));
    const opens = rows.map(r => Number(r[1]));
    const closes = rows.map(r => Number(r[2]));
    const highs = rows.map(r => Number(r[3]));
    const lows = rows.map(r => Number(r[4]));
    const vols = rows.map(r => Number(r[5]));
    const N = rows.length;

    // 布局：主图 58% / 成交量 14% / MACD 22%
    // padT 从 22 提到 40：顶部留出一条专属"信息条"空间给十字光标浮层（浮层盒占 y=2..20），
    // 否则浮层会压住最高一条 Y 轴刻度。整体下移后把 MACD 底部留白从 22 收到 16 抵消，总高不变。
    let padL = 44;
    const padR = 14, padT = 40;   // 左边距默认 44＝价格轴标签宽度 + 少量留白（贴窗口左沿）；下一段按实际数字再自适应
    // ⚠ 改 padL 必须同步改下面滚轮/拖动里的 padL2（L5425），否则鼠标定位会整体错位
    const mainH = Math.round(H * 0.58);
    const volH = Math.round(H * 0.14);
    const macdTop = padT + mainH + 16;
    const macdH = H - macdTop - 12;   // 只留时间轴那一行 12px → 量能(MACD)图贴到面板最下面（用户："量能图对齐最下面"）
    // 左边距自适应：按最长价格文本实测宽度收紧（4 位价如 "1234.56" 自动加宽，不会把标签压出画布）。
    // 这里用原始高低价的粗估宽度（真正的 maxP 要等下面统计算完，且还要加 8% 余量，量级一致）。
    const priceGuess = Math.max.apply(null, highs.concat(lows, [1]));
    padL = Math.max(36, Math.min(78, Math.ceil(ctx.measureText(priceGuess.toFixed(2)).width) + 10));
    const cw = W - padL - padR;
    // 时间轴缩放：nShow = 显示的根数（滚轮 30~250），viewEnd = 可视窗口最后根下标
    let nShow = Math.max(10, Math.min(N, Math.round(state.nShow) || 70));
    // 可视窗口起点（受平移影响，保证不越界）
    let start = Math.max(0, Math.min(N - nShow, (state.viewEnd || 0) - nShow + 1));
    start = Math.max(0, start);
    if (start + nShow > N) { start = N - nShow; }
    const end = start + nShow - 1;          // 最后一根下标（含）
    const slotW = cw / nShow;
    const candleW = Math.max(1, slotW * 0.62);

    const ma5 = sma(closes, 5), ma10 = sma(closes, 10), ma20 = sma(closes, 20);
    const { dif, dea, hist } = macd(closes);

    // 价格范围（含均线）
    let minP = Infinity, maxP = -Infinity;
    for (let i = start; i <= end; i++) {
      minP = Math.min(minP, lows[i]); maxP = Math.max(maxP, highs[i]);
      [ma5[i], ma10[i], ma20[i]].forEach(v => { if (v != null) { minP = Math.min(minP, v); maxP = Math.max(maxP, v); } });
    }
    if (minP === Infinity) { minP = 0; maxP = 1; }
    const pad = (maxP - minP) * 0.08 || 0.5;
    minP -= pad; maxP += pad;
    drawChip(start, end, minP, maxP);
    const y = (p) => padT + (maxP - p) / (maxP - minP) * mainH;
    const x = (i) => padL + (i - start + 0.5) * slotW;

    // 网格 + 价格轴
    ctx.strokeStyle = 'rgba(139,147,167,0.12)';
    ctx.fillStyle = '#8b93a7'; ctx.textAlign = 'right';
    for (let i = 0; i <= 5; i++) {
      const p = maxP - (maxP - minP) * i / 5;
      ctx.beginPath(); ctx.moveTo(padL, y(p)); ctx.lineTo(W - padR, y(p)); ctx.stroke();
      ctx.fillText(p.toFixed(2), padL - 4, y(p) + 3);
    }
    // 时间轴：常规刻度压成 MM-DD（13 个刻度也不会挤成一片），**最新那个交易日用完整 YYYY-MM-DD**
    // （用户："日期显示全一点"）；间距由**实测字宽**决定（不再用固定的 80px 猜）。
    ctx.textAlign = 'center';
    ctx.fillStyle = '#8b93a7';
    const dateH = padT + mainH + 12;
    const shortDate = (d) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || ''));
      return m ? m[1] + '-' + m[2] + '-' + m[3] : String(d || '');
    };
    const lblW = ctx.measureText('00-00').width;
    const slotStep = Math.max(1, Math.ceil((lblW + 14) / Math.max(slotW, 1)));   // 字宽 + 14px 间隙 → 不重叠
    // 居中画日期，但**夹在画布内**——最新那天在最右侧，完整日期居中会溢出右边界
    const dateTick = (i, y2, full) => {
      const txt = shortDate(dates[i]);
      ctx.textAlign = 'center'; ctx.fillStyle = full ? '#c3cad9' : '#8b93a7';
      const tx = Math.max(padL + 1, Math.min(W - padR - 1 - ctx.measureText(txt).width / 2, x(i)));
      ctx.fillText(txt, tx, y2);
    };
    // 刻度位置：按实测字宽定间距（留 22px 防重叠），并且**强制补上最后一根（最新那个交易日）的日期**——
    // 步进循环多半落不到 end 上，那样"最新交易日"就永远没有标签（用户：最新日应该显示出来）。
    // 最后一格要放完整日期（更宽），所以把它的占位宽度也算进防重叠判断里。
    const need = lblW + 22;
    const ticks = [];
    for (let i = start; i <= end; i += slotStep) {
      while (ticks.length && x(i) - x(ticks[ticks.length - 1]) < need) ticks.pop();
      ticks.push(i);
    }
    if (!ticks.length || ticks[ticks.length - 1] !== end) {
      // 最新日期用完整格式，宽度约为 "00-00" 的 1.9 倍 → 左邻刻度要让开
      const fullNeed = Math.ceil(ctx.measureText('0000-00-00').width) / 2 + 26;
      while (ticks.length && x(end) - x(ticks[ticks.length - 1]) < fullNeed) ticks.pop();
      ticks.push(end);
    }
    ticks.forEach(i => dateTick(i, dateH, i === end));

    // 蜡烛
    for (let i = start; i <= end; i++) {
      const up = closes[i] >= opens[i];
      const col = up ? UP : DOWN;
      const cx = x(i);
      ctx.strokeStyle = col; ctx.fillStyle = col;
      // 影线
      ctx.beginPath();
      ctx.moveTo(cx, y(highs[i])); ctx.lineTo(cx, y(lows[i]));
      ctx.stroke();
      // 实体
      const o = y(opens[i]), c = y(closes[i]);
      ctx.fillRect(cx - candleW / 2, Math.min(o, c), candleW, Math.max(1, Math.abs(c - o)));
    }
    // 均线
    const drawMA = (arr, color) => {
      ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.beginPath();
      let started = false;
      for (let i = start; i <= end; i++) {
        if (arr[i] == null) continue;
        if (!started) { ctx.moveTo(x(i), y(arr[i])); started = true; }
        else ctx.lineTo(x(i), y(arr[i]));
      }
      ctx.stroke();
    };
    drawMA(ma5, '#f0b90b');
    drawMA(ma10, '#4f8cff');
    drawMA(ma20, '#e5484d');

    // 成交量
    const vmax = Math.max(...vols.slice(start, end + 1), 1);
    ctx.textAlign = 'right'; ctx.fillStyle = '#8b93a7';
    ctx.fillText('VOL', padL - 4, padT + mainH + 22);
    for (let i = start; i <= end; i++) {
      const up = closes[i] >= opens[i];
      const hv = (vols[i] / vmax) * volH;
      const cx = x(i);
      ctx.fillStyle = up ? 'rgba(229,72,77,0.55)' : 'rgba(46,189,133,0.55)';
      ctx.fillRect(cx - candleW / 2, padT + mainH + 18 + (volH - 6 - hv), candleW, hv);
    }

    // MACD 指标名：旧写法 textAlign='right' + x=padL-4，而左侧留白只有 ~18px，
    // 装不下 "MACD(12,26,9)" 的宽度 ⇒ 右半截探进绘图区、压住 MACD 柱。
    // 现在改为画在绘图区内左上角，并先铺一层底色把柱线压掉，保证任何缩放下都清晰。
    const macdLabel = 'MACD(12,26,9)';
    const mlw = ctx.measureText(macdLabel).width;
    ctx.fillStyle = 'rgba(13,16,23,0.92)';
    ctx.fillRect(padL + 2, macdTop + 1, mlw + 8, 13);
    ctx.fillStyle = '#8b93a7'; ctx.textAlign = 'left';
    ctx.fillText(macdLabel, padL + 6, macdTop + 11);
    const mvals = [...hist.slice(start, end + 1), ...dif.slice(start, end + 1), ...dea.slice(start, end + 1)].map(v => Math.abs(v));
    const mmax = Math.max(...mvals, 0.01);
    const my = (v) => macdTop + 14 + (mmax - v) / (mmax * 2) * (macdH - 18);
    // 零轴
    ctx.strokeStyle = 'rgba(139,147,167,0.3)';
    ctx.beginPath(); ctx.moveTo(padL, my(0)); ctx.lineTo(W - padR, my(0)); ctx.stroke();
    // 柱
    for (let i = start; i <= end; i++) {
      const hv = hist[i];
      const cx = x(i);
      ctx.fillStyle = hv >= 0 ? 'rgba(229,72,77,0.7)' : 'rgba(46,189,133,0.7)';
      const yy0 = my(0), yy1 = my(hv);
      ctx.fillRect(cx - candleW / 2, Math.min(yy0, yy1), candleW, Math.max(1, Math.abs(yy1 - yy0)));
    }
    // DIF / DEA 线
    ctx.strokeStyle = '#f0b90b'; ctx.lineWidth = 1; ctx.beginPath();
    let difStarted = false;
    for (let i = start; i <= end; i++) {
      if (dif[i] == null) continue;
      if (!difStarted) { ctx.moveTo(x(i), my(dif[i])); difStarted = true; }
      else ctx.lineTo(x(i), my(dif[i]));
    }
    ctx.stroke();
    ctx.strokeStyle = '#4f8cff'; ctx.beginPath();
    let deaStarted = false;
    for (let i = start; i <= end; i++) {
      if (dea[i] == null) continue;
      if (!deaStarted) { ctx.moveTo(x(i), my(dea[i])); deaStarted = true; }
      else ctx.lineTo(x(i), my(dea[i]));
    }
    ctx.stroke();

    // 十字光标（只在非拖动时显示）
    canvas.onmousemove = (e) => {
      if (dragState.dragging) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const idx = start + Math.floor((mx - padL) / slotW);
      if (idx < start || idx > end || mx < padL || mx > W - padR) { draw(); return; }
      draw();
      ctx.strokeStyle = canvasFg(0.25); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x(idx), padT); ctx.lineTo(x(idx), padT + mainH); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(padL, y(closes[idx])); ctx.lineTo(W - padR, y(closes[idx])); ctx.stroke();
      // 信息框
      const up = closes[idx] >= opens[idx];
      ctx.fillStyle = 'rgba(20,24,36,0.92)';
      const txt = dates[idx] + '  开' + fmt(opens[idx]) + ' 高' + fmt(highs[idx]) +
        ' 低' + fmt(lows[idx]) + ' 收' + fmt(closes[idx]) + ' 量' + vols[idx];
      const tw = ctx.measureText(txt).width + 14;
      const bx = Math.min(W - tw - 6, 8);
      ctx.fillRect(bx, 2, tw, 18);
      ctx.fillStyle = up ? UP : DOWN;
      ctx.textAlign = 'left';
      ctx.fillText(txt, bx + 7, 14);
      // 底部时间轴：在光标同一列贴一个"日期药丸"，直接把光标那根的日期标出来
      //（这样十字光标不用回到顶部信息条里找日期，鼠标在哪天一眼就看到）
      if (period !== 'min') {
        const dtxt = shortDate(dates[idx]);
        const dw = ctx.measureText(dtxt).width + 10;
        let dbx = x(idx) - dw / 2;
        dbx = Math.max(padL, Math.min(W - padR - dw, dbx));
        ctx.fillStyle = 'rgba(79,140,255,0.92)';
        ctx.fillRect(dbx, padT + mainH + 3, dw, 14);
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.fillText(dtxt, dbx + dw / 2, padT + mainH + 13.5);
      }
    };
  };

  // ---- 时间轴交互：滚轮缩放 + 拖动平移 ----
  const dragState = { dragging: false, lastX: 0, lastY: 0 };
  // 滚轮缩放：nShow 在 30~250 之间，围绕鼠标位置缩放（保持指针下K线不动）
  canvas.addEventListener('wheel', (e) => {
    if (state.period === 'min' || !state.kline.length) return;
    e.preventDefault();
    const N = state.kline.length;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    // 当前可视窗口
    const curN = Math.max(10, Math.min(N, Math.round(state.nShow) || 70));
    let start = Math.max(0, Math.min(N - curN, (state.viewEnd || 0) - curN + 1));
    if (start + curN > N) start = N - curN;
    const padL2 = 44, cw2 = rect.width - padL2 - 14;   // ⚠ 必须与 drawKline 的 padL 一致
    const slotW2 = cw2 / curN;
    // 鼠标指向的 K线下标
    const hoverIdx = start + Math.floor((mx - padL2) / slotW2);
    // 缩放比例：向上放大（减少根数），向下缩小（增加根数）
    const factor = e.deltaY > 0 ? 1.15 : 0.87;
    let nextN = Math.round(curN * factor);
    nextN = Math.max(30, Math.min(250, nextN));
    nextN = Math.min(nextN, N);
    // 保持 hoverIdx 对应的 K线位置不变：新的窗口起点
    const ratio = (hoverIdx - start) / curN;
    let newStart = Math.round(hoverIdx - ratio * nextN);
    newStart = Math.max(0, Math.min(N - nextN, newStart));
    state.nShow = nextN;
    state.viewEnd = newStart + nextN - 1;
    draw();
  }, { passive: false });
  // 拖动平移：按住左键拖拽，可视窗口跟随移动
  canvas.addEventListener('mousedown', (e) => {
    if (state.period === 'min' || !state.kline.length) return;
    dragState.dragging = true;
    dragState.lastX = e.clientX;
    canvas.style.cursor = 'grabbing';
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragState.dragging || state.period === 'min' || !state.kline.length) return;
    const N = state.kline.length;
    const curN = Math.max(10, Math.min(N, Math.round(state.nShow) || 70));
    const rect = canvas.getBoundingClientRect();
    const cw2 = rect.width - 62 - 14;
    // 水平位移 → K线根数偏移（向右拖 = 看更早，向左拖 = 看更新）
    const dx = e.clientX - dragState.lastX;
    const slotW2 = cw2 / curN;
    const nShift = Math.round(-dx / Math.max(slotW2, 1));
    let end2 = (state.viewEnd || 0) + nShift;
    end2 = Math.max(curN - 1, Math.min(N - 1, end2));
    state.viewEnd = end2;
    dragState.lastX = e.clientX;
    draw();
  });
  window.addEventListener('mouseup', () => {
    if (dragState.dragging) {
      dragState.dragging = false;
      canvas.style.cursor = '';
    }
  });

  // ---- 板块趋势视图：板块雷达单击板块 → 本面板显示板块简介 + 近 N 日涨跌 + 成分股行情 ----
  // 数据来源：板块每日快照（sector_daily 表，每日首次打开时由板块雷达写入）→ 画历史柱状图；
  //           板块内成分股行情由 board 渲染器随事件带过来（quotes），点击成分股 → 切回个股K线
  // ---- 等权合成板块K线（2026-09-23）：成分股日K → 板块指数K线 ----
  // 做法：以"首日收盘=1000"为基准，之后每日指数 = 前日指数 × (1 + 当日成分股等权平均涨跌幅)；
  //       OHLC 各自按同口径合成（板块开盘/最高/最低 = 前日指数 × (1 + 当日成分股对应值的等权涨跌)）。
  //       停牌/未上市票当日无数据则自动不参与该日平均；成交量取当日成分股之和。
  // 输入 rowsMap: { code: [date,open,close,high,low,vol][] }；输出同个股K线形状，可直接喂 drawKline。
  const synthSectorKline = (rowsMap) => {
    const codes = Object.keys(rowsMap || {}).filter(c => (rowsMap[c] || []).length);
    if (!codes.length) return [];
    const byCode = {};
    codes.forEach(c => {
      const m = {};
      (rowsMap[c] || []).forEach(r => {
        if (r && r[0]) m[r[0]] = { o: +r[1], c: +r[2], h: +r[3], l: +r[4], v: +r[5] || 0 };
      });
      byCode[c] = m;
    });
    const dateSet = {};
    codes.forEach(c => Object.keys(byCode[c]).forEach(d => { dateSet[d] = 1; }));
    const dates = Object.keys(dateSet).sort();
    if (dates.length < 5) return [];
    const out = [];
    const prevClose = {};   // 每票上一交易日收盘（算涨跌幅用）
    let idx = 1000;
    dates.forEach(d => {
      let pSum = 0, oSum = 0, hSum = 0, lSum = 0, pN = 0, vSum = 0;
      codes.forEach(c => {
        const r = byCode[c][d];
        if (!r) return;
        const pc = prevClose[c];
        if (pc) { pSum += r.c / pc - 1; oSum += r.o / pc - 1; hSum += r.h / pc - 1; lSum += r.l / pc - 1; pN++; }
        prevClose[c] = r.c;
        vSum += r.v;
      });
      if (!pN) {   // 首日（无前收）或当日全停牌：输出基准K线，指数不动
        out.push([d, +idx.toFixed(2), +idx.toFixed(2), +idx.toFixed(2), +idx.toFixed(2), Math.round(vSum)]);
        return;
      }
      const po = idx * (1 + oSum / pN);
      const pc2 = idx * (1 + pSum / pN);
      const ph = idx * (1 + hSum / pN);
      const pl = idx * (1 + lSum / pN);
      out.push([d, +po.toFixed(2), +pc2.toFixed(2), +ph.toFixed(2), +pl.toFixed(2), Math.round(vSum)]);
      idx = pc2;
    });
    return out;
  };

  const showSectorTrend = async (detail) => {
    if (!body.isConnected) return;
    const { sector, market, quotes } = detail || {};
    if (!sector) return;
    sectorTrend = { sector, market, quotes };
    // ★ 板块模式（2026-09-23）：主 canvas 画「等权合成板块K线」（与个股一样的蜡烛图 + 缩放平移交互），
    //   底部保留信息区（简介 + 近N日柱状 + 成分股列表）。合成K线写入 kline_cache（key=sector:<市场>:<板块id>），
    //   重开/再点秒显，不联网。
    body.classList.add('chart-sector-mode');
    main.style.display = '';          // 显示主图
    side.style.display = 'none';      // 板块无五档/筹码侧栏
    sectorView.style.display = '';    // 底部信息区
    const name = sector.name || sector.id || '';
    secIcon.textContent = sector.icon || '';
    secTitle.textContent = name;
    secDesc.textContent = sector.desc || '';
    secStks.innerHTML = '';
    // 腾讯行情键转换（sh600519）与股票全代码（600519.SH）
    const toTk2 = (code) => {
      const c = String(code || '').trim().toUpperCase();
      if (!c) return '';
      if (c.endsWith('.SH')) return 'sh' + c.slice(0, -3);
      if (c.endsWith('.SZ')) return 'sz' + c.slice(0, -3);
      if (/^\d+$/.test(c)) return (c[0] === '6' || c[0] === '9' ? 'sh' : 'sz') + c;
      if (/^(SH|SZ|HK)\d+/.test(c)) return c.toLowerCase();
      return 'us' + c;
    };
    const fullCodeOf = (code) => {
      const c = String(code || '').trim().toUpperCase();
      if (/^\d{6}$/.test(c)) return (c[0] === '6' || c[0] === '9' ? c + '.SH' : c + '.SZ');
      if (/^\d{5}$/.test(c)) return c + '.HK';
      if (/^\d+$/.test(c)) return c + '.SH';
      return c;
    };
    // 板块今日平均涨跌（用带过来的成分股行情算；2026-09-23 起成分股已扩充至 30~40 只，不再截断 20）
    let avgSum = 0, avgN = 0;
    const stocks = sector.stocks || [];
    stocks.forEach(st => {
      const q = quotes && quotes[st.c] ? quotes[st.c] : (quotes && quotes[toTk2(st.c)] ? quotes[toTk2(st.c)] : null);
      if (q && q.pct != null) { avgSum += Number(q.pct); avgN++; }
    });
    const avg = avgN ? (avgSum / avgN) : null;
    secAvg.textContent = avg == null ? '--' : (avg > 0 ? '+' : '') + avg.toFixed(2) + '%';
    secAvg.className = 'sec-avg ' + (avg == null ? 'na' : (avg >= 0 ? 'up' : 'down'));
    secStkTitle.textContent = '板块成分股 ' + stocks.length + ' 只（点击查看个股K线）';
    // 成分股行情行（每行一排排：名称/代码 + 现价/涨跌 + 业务描述）
    stocks.forEach(st => {
      const q = quotes && quotes[st.c] ? quotes[st.c] : (quotes && quotes[toTk2(st.c)] ? quotes[toTk2(st.c)] : null);
      const row = el('div', 'sec-stk-row');
      const nm = el('span', 'sec-stk-name', st.name || st.c);
      const px = el('span', 'sec-stk-px', q && q.price != null ? String(q.price) : '--');
      const pct = el('span', 'sec-stk-pct', q && q.pct != null ? ((Number(q.pct) > 0 ? '+' : '') + q.pct + '%') : '--');
      if (q && q.pct != null) pct.style.color = mktColor(q.pct);
      const biz = el('span', 'sec-stk-biz', st.d || '');
      row.appendChild(nm); row.appendChild(px); row.appendChild(pct); row.appendChild(biz);
      const full = fullCodeOf(st.c);
      row.title = '查看 ' + (st.name || st.c) + ' 的K线';
      row.addEventListener('click', () => load(full || st.c, st.name || st.c));
      secStks.appendChild(row);
    });
    // 近 N 日板块涨跌柱状图（从 SQLite 每日快照读；当天数据由板块雷达写入）
    try {
      const hist = await K.sector.history(String(market != null ? market : 0), sector.id || '', 20);
      secHist.innerHTML = '';
      if (hist && hist.length) {
        const items = hist.slice().reverse();   // 旧→新
        const maxAbs = Math.max(...items.map(i => Math.abs(Number(i.payload && i.payload.avg) || 0)), 0.5);
        items.forEach(it => {
          const v = Number(it.payload && it.payload.avg) || 0;
          const bar = el('div', 'sec-hist-bar');
          const col = el('div', 'sec-hist-col ' + (v >= 0 ? 'up' : 'down'));
          col.style.height = Math.max(6, Math.abs(v) / maxAbs * 100) + '%';
          const d = el('div', 'sec-hist-date', String(it.date).slice(5));
          const val = el('div', 'sec-hist-val', (v > 0 ? '+' : '') + v.toFixed(2) + '%');
          bar.appendChild(col); bar.appendChild(d); bar.appendChild(val);
          secHist.appendChild(bar);
        });
        secHistTitle.textContent = '近 ' + items.length + ' 日板块涨跌（每日快照入库）';
      } else {
        secHistTitle.textContent = '近 N 日板块涨跌（暂无历史，今日起每日自动入库积累）';
      }
    } catch (e) { secHistTitle.textContent = '近 N 日板块涨跌（历史读取失败）'; }
    // ★ 板块合成K线（2026-09-23）：主 canvas 显示「等权合成板块指数」蜡烛图，与个股K线一样的交互（缩放/平移/MACD）。
    //   合成结果写入 kline_cache（key = sector:<市场>:<板块id>），本地缓存，重开/再点秒显不联网。
    //   仅细分板块（≤80 只）画合成K线；分类（把几个板块拼一起、往往数百只）不画——拉全量日K太慢没意义。
    try {
      const mk = market != null ? market : 0;
      const cacheKey = 'sector:' + mk + ':' + sector.id;
      const codes = (sector.stocks || []).map(s => s.c);
      if (codes.length > 80) {
        // 分类视图：只清掉上一只个股的残留图（信息区照常显示），不画合成K线
        state.kline = []; state.minute = [];
        ensureDraw();
      } else {
        // 板块雷达已拉过成分股实时行情（带 quotes 进来），但日K合成需要成分股日K线 —— 只在这里需要时拉。
        let rows = null;
        // 1) 先吃本地缓存（秒开）
        try {
          const cached = await K.kline.latest(cacheKey, 'day');
          if (cached && cached.ok && cached.kline && cached.kline.length >= 20) rows = cached.kline;
        } catch (e) { /* 缓存不可用则现拉合成 */ }
        // 2) 无缓存 → 分块批量拉成分股日K（batch 每批上限 24 只，板块 30~40 只拆两批）→ 等权合成 → 写缓存
        if (!rows) {
          // 拉网络要几秒：先清掉主图残留的「上一只个股K线」，避免板块模式下还挂着旧股票图
          state.kline = []; state.minute = [];
          ensureDraw();
          const rowsMap = {};
          for (let i = 0; i < codes.length; i += 20) {
            const chunk = codes.slice(i, i + 20);
            if (!chunk.length) continue;
            try {
              const res = await K.kline.batch(chunk, 120);
              if (res && res.ok && res.data) Object.assign(rowsMap, res.data);
            } catch (e) { /* 单批失败继续下一批 */ }
          }
          rows = synthSectorKline(rowsMap);
          if (rows && rows.length) {
            try { await K.kline.cache(cacheKey, 'day', { ok: true, code: cacheKey, kline: rows, minute: [], date: '' }); } catch (e) { /* ignore */ }
          }
        }
        // 3) 画主图：把合成K线喂给 state.kline，日K周期 + 默认缩放 70 根
        if (rows && rows.length) {
          state.kline = rows; state.minute = []; state.minDate = '';
          state.period = 'day'; state.nShow = 70; state.viewEnd = 0;
          state.realtime = null;
          Object.keys(periodBtns).forEach(k => periodBtns[k].classList.toggle('on', k === 'day'));
          infoCode.textContent = name + '（板块合成）';
          infoName.textContent = '';
          infoPrice.textContent = '';
          infoPct.textContent = '';
          chip.style.display = 'none'; levels.style.display = 'none';   // 板块合成K线无五档/筹码
          canvas.style.opacity = 1;
          ensureDraw();
        }
      }
    } catch (e) { /* 板块K线失败不影响信息区 */ }
  };

  // ---- 点击联动：A股行情面板/板块雷达点击股票 → 本面板切换 ----
  // 场景切换重建面板后旧 listener 仍挂在 window 上，用 isConnected 屏蔽已移除的实例
  window.addEventListener('stockSelect', (e) => {
    if (!body.isConnected) return;
    const { code, name } = e.detail || {};
    if (code) load(code, name || code);
  });
  // 板块雷达单击板块 → 本面板显示板块趋势（板块简介 + 历史柱状 + 成分股）
  window.addEventListener('sectorTrend', (e) => {
    if (!body.isConnected) return;
    showSectorTrend(e.detail || {});
  });

  // 初始加载：优先显示「上一次看的票」（localStorage）；没有才用自选第一只；再兜底茅台
  (async () => {
    try {
      const last = JSON.parse(localStorage.getItem(LAST_KEY) || 'null');
      if (last && last.code) { load(last.code, last.name || last.code); return; }
    } catch (e) { /* 无记录走自选 */ }
    try {
      const watch = await K.watch.list();
      if (watch && watch.length) { load(watch[0].code, watch[0].name || watch[0].code); return; }
    } catch (e) { /* 读自选失败走兜底 */ }
    load('600519.SH', '贵州茅台');
  })();

  // ★2026-10-16（用户要求"非开盘的时间没必要一直刷新，只有开盘的时候才会"）：
  //   趋势看板原来**完全没有自动刷新** —— 只有"输代码 / 切周期 / 点别的面板的股票"才取数，盘中看着它是不动的。
  //   现在加一个**仅盘中**的静默刷新：每 30 秒重取当前票（分时+日K+现价），休市/周末/午休一次都不请求。
  //   quiet=true ⇒ 不把画布调暗、不清 realtime（否则每 30 秒闪一下、分时"昨收"基准线还会丢）。
  const chartBj = () => { const d = new Date(Date.now() + 8 * 3600e3); return { w: d.getUTCDay(), hm: d.getUTCHours() * 100 + d.getUTCMinutes() }; };
  const chartTrading = () => {
    const t = chartBj();
    return t.w !== 0 && t.w !== 6 && ((t.hm >= 915 && t.hm <= 1135) || (t.hm >= 1255 && t.hm <= 1505));
  };
  const chartTimer = setInterval(() => {
    if (chartStopped) return;
    if (!chartTrading()) return;                 // 休市：一次都不拉（数据就停在收盘口径，当固定分析面板看）
    if (document.hidden || !state.code) return;  // 页面不在前台也不拉
    load(state.code, state.name, true);
  }, 30000);

  // 场景隔离：切走场景时断开 ResizeObserver + 停掉盘中刷新
  // （window 事件与 stockSelect 由 isConnected 自愈）
  return () => {
    chartStopped = true;
    if (chartTimer) clearInterval(chartTimer);
    if (ro) { try { ro.disconnect(); } catch (e) { /* ignore */ } }
  };
};

// ============ board：板块标准分类层（A股 / 美股 一一对应） ============
// 问题：A股 54 个板块（sector-data.js）与美股 54 个板块（us-sector-data.js）是两套**各写各的**名字，
//       同一个产业在两边叫法不同（A股「算力芯片」↔ 美股「AI算力·芯片」），用户无法对着看。
// 做法：给两边**共用一套分类骨架**（下面 15 个 CAT_DEFS，id 全局唯一、顺序固定）——
//       分类名按市场各用各的自然叫法（A股「信息技术·TMT」= 美股「科技·半导体」），
//       但**同一个 id 在两个市场里指的是同一件事**。切市场时分类位置一一对应。
// 口径：只做"归类 + 浏览"，**不改任何行情计算**——分类涨跌幅 = 其成员板块均值的再平均（未取到行情的板块自动剔除）。
// 细节：A股 54 / 美股 54 个板块，每个板块**只落进一个分类**，两个市场的 CAT_MAP 长度都必须 = 54（对不上会 console.warn）。
var CAT_DEFS = [
  { id: 'tech',    icon: '💻', label: '信息技术·TMT', labelUs: '科技·半导体', desc: '半导体全链（设计/制造/设备/材料/存储）、光通信、算力基础设施、软件与AI应用、云计算' },
  { id: 'digital', icon: '🌐', label: '数字新经济',    labelUs: '数字新经济',  desc: '数字货币、金融科技与支付、数据要素与AI平台' },
  { id: 'ce',      icon: '📱', label: '消费电子·终端', labelUs: '消费电子·硬件', desc: '消费电子与AI终端、精密传感器、硬件零部件' },
  { id: 'telecom', icon: '📡', label: '通信·电信',     labelUs: '通信·电信',    desc: '通信设备与光模块、电信运营商、宽带与5G/光纤基础设施' },
  { id: 'media',   icon: '🎬', label: '传媒游戏',      labelUs: '传媒·游戏',    desc: '游戏与发行、影视短剧、社交平台、流媒体、广告与娱乐平台' },
  { id: 'mfg',     icon: '⚙️', label: '高端制造·军工', labelUs: '高端制造·工业', desc: '工业母机、机器人自动化、国防军工、商业航天、低空经济' },
  { id: 'health',  icon: '💊', label: '医药健康',      labelUs: '医药健康',    desc: '创新药与CXO、医疗器械、医药商业与服务' },
  { id: 'fin',     icon: '🏦', label: '大金融',        labelUs: '金融',        desc: '银行、保险、券商与多元金融' },
  { id: 'estate',  icon: '🏗️', label: '地产建筑基建',  labelUs: '地产·建筑',    desc: '房地产开发、建材基建、一带一路出海工程、REITs' },
  { id: 'consume', icon: '🛒', label: '消费',          labelUs: '消费',        desc: '白酒食品饮料、家电家居、消费零售、文旅酒店与出行' },
  { id: 'agri',    icon: '🌾', label: '农业环保',      labelUs: '农业·环保',    desc: '农林牧渔、环保固废与再生' },
  { id: 'trans',   icon: '✈️', label: '交运物流',      labelUs: '交运物流',    desc: '交通运输、物流快递、航空机场' },
  { id: 'energy',  icon: '⛏️', label: '能源资源',      labelUs: '能源·资源',    desc: '石油天然气与油服、煤炭、有色金属、黄金贵金属、稀土小金属' },
  { id: 'power',   icon: '⚡', label: '公用电力·新能源', labelUs: '公用电力·新能源', desc: '火电水电核电与电网设备、光伏风电、储能与锂电池、氢能、新能源车' },
  { id: 'style',   icon: '💎', label: '风格·高股息',   labelUs: '风格·价值成长', desc: '红利高股息与价值股、成长股——不分行业，按"钱的偏好"归类' }
];
// A股 54 板块（sector-data.js）→ 分类（每个板块只出现一次，合计必须 = 54）
// 注：A股没有独立的「电信运营商」板块，它的通信业落点是 optics（📡 光通信·通信设备），
//     与美股 telecom（📡 通信·电信）同属「通信·电信」——这是两边**唯一名称相近却分处不同数据集**的一类。
var CAT_MAP_A = {
  tech:    ['chip', 'semi-eq', 'semimat', 'g3semi', 'mem', 'infra', 'app', 'cloud', 'xc'],
  digital: ['crypto'],
  ce:      ['ce', 'sensor'],
  telecom: ['optics'],
  media:   ['game', 'drama'],
  mfg:     ['machine', 'robot', 'defense', 'space', 'lowalt', 'manda', 'soe'],
  health:  ['pharma', 'cxo', 'meddev'],
  fin:     ['bank', 'broker'],
  estate:  ['realestate', 'beltroad'],
  consume: ['baijiu', 'home', 'consume', 'tourism'],
  agri:    ['agri', 'env'],
  trans:   ['transport'],
  energy:  ['energy', 'coal', 'chem', 'steel', 'rare', 'gold'],
  power:   ['power', 'powereq', 'solar', 'wind', 'h2', 'storage', 'battery', 'ssb', 'sodium', 'ev', 'adas'],
  style:   ['dividend']
};
// 美股 54 板块（us-sector-data.js）→ 同一套分类（合计必须 = 54）
var CAT_MAP_U = {
  tech:    ['semigpu', 'semieq', 'semidesign', 'software', 'cloudinfra', 'security', 'dataai', 'aiapp', 'mega'],
  digital: ['crypto', 'fintech'],
  ce:      ['consumertech', 'hardware'],
  telecom: ['telecom'],
  media:   ['social', 'streaming', 'media', 'gaming'],
  mfg:     ['industrial', 'robotics', 'military', 'space', 'diversified'],
  health:  ['bigpharma', 'biotech', 'medtech', 'healthcare'],
  fin:     ['banks', 'insurance', 'capmkt'],
  estate:  ['housing', 'reits'],
  consume: ['foodbev', 'consumer', 'retail', 'ecom', 'travel', 'airlines'],
  agri:    ['agri', 'recycling'],
  trans:   ['railshipping'],
  energy:  ['energy', 'oilservice', 'copper', 'materials', 'gold'],
  power:   ['utilities', 'powergrid', 'renewable', 'batteries', 'evcharge', 'autos'],
  style:   ['value', 'growth']
};
var CAT_MAP_BY_MARKET = [CAT_MAP_A, CAT_MAP_U];

// ============ board：板块分析（54 板块 + 点击进入成分股，腾讯实时行情） ============
// 默认展示 SECTOR_DATA 54 个板块（名称/图标/简介）；点击板块 → 展示该板块最多 20 只成分股实时行情；
// 板块内股票可点击 → 联动 K线图表面板；顶部提供搜索过滤 + 返回板块列表。
// ============ board：板块分析（A股 54 板块 + 点击进入成分股，腾讯实时行情） ============
// 特性：每板块显示实时涨跌幅（红绿）· 按涨跌排序（按钮切换升/降）· 板块列表/成分股切换 ·
//       拉过的行情写入 quote_cache 本地缓存，重开秒显。
function createBoardRenderer(body, opts, panelHead) {
  const K = window.app.stock;
  const datasets = (opts && opts.datasets) || [{
    label: '',
    sectors: (opts && opts.SECTORS) || (typeof SECTOR_DATA !== 'undefined' && Array.isArray(SECTOR_DATA) ? SECTOR_DATA : [])
  }];
  let SECTORS = datasets[0].sectors;         // 当前市场板块集（切换时更新）
  // 每个板块取多少只：**不再写死 20**——板块自己的列表是"人工核对过的高度相关个股"，
  // 有几个就显示几个（54 板块建议每板块 ≥20 只、上限 40）；分类视图则把所有成员板块拼起来去重，天然更多。
  const MAX_STOCKS = Infinity;
  const secStocks = (sec) => (sec && sec.stocks) || [];
  let disposed = false;                      // 场景隔离：切走场景后停止预载/刷新
  // ---- 工具条：返回 / 市场切换 / 排序 / 视图切换 / 搜索 → 统一放进「面板标题栏右侧」，
  //      内容区整块留给板块卡片。原来顶部那行「板块雷达」标题与面板标题重复，已删除；
  //      板块名与数量改由 sub 显示（挂在面板标题后面）。 ----
  const backBtn = el('button', 'bd-back', '‹ 板块');
  backBtn.style.display = 'none';
  const sub = el('span', 'bd-sub', SECTORS.length + ' 板块');
  // 行情时间横幅：✦ 让用户一眼看到"这是哪一天哪一刻的行情"（用户 2026-09-21 明确要求）
  let lastQuoteAt = 0, quoteFetching = false;
  const FRESH_ELS = [];
  const fmtClock = (t) => {
    if (!t) return '';
    const d = new Date(t);
    const p = (n) => (n < 10 ? '0' : '') + n;
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  };
  const paintFresh = () => {
    const txt = quoteFetching && !lastQuoteAt ? '行情 拉取中…'
      : (lastQuoteAt ? '行情 ' + fmtClock(lastQuoteAt) + '（最后刷新）' : '行情 --');
    FRESH_ELS.forEach(e => { e.textContent = txt; });
  };
  const noteQuoteAt = (t) => { lastQuoteAt = Math.max(lastQuoteAt, t || Date.now()); paintFresh(); };
  const freshTag = el('span', 'bd-fresh', '行情 --');
  FRESH_ELS.push(freshTag);
  const search = el('input', 'bd-search', '');
  search.placeholder = '搜索板块…';
  search.type = 'text';
  // 排序按钮：涨跌幅 高→低 / 低→高
  const sortBtn = el('button', 'bd-sort', '⇅ 涨跌排序');
  sortBtn.title = '按板块涨跌幅排序';
  // 切换按钮：板块列表 ⇄ 成分股（用户反馈不需要显式切换按钮，双击进成分股、‹ 板块 返回已足够）
  const refreshBtn = el('button', 'bd-refresh', '⟳');
  refreshBtn.title = '立即重新拉取所有板块实时行情（无视缓存）';
  // 分类切换：细分板块（现状 54 个）⇄ 标准分类（13 类，A股/美股一一对应）
  // 视图切换 = 一对互斥按钮（15 分类 / 54 板块）——比单个开关更直观：**当前在哪个视图，哪个是亮的**。
  var viewSeg = el('div', 'bd-seg');
  const segCat = el('button', 'bd-sort', CAT_DEFS.length + ' 板块');
  const segAll = el('button', 'bd-sort', SECTORS.length + ' 板块');
  segCat.title = CAT_DEFS.length + ' 个标准分类板块：A股与美股共用同一套分类骨架，同一个位置指同一件事（单击看该分类趋势、双击进分类看细分板块）';
  segAll.title = '原始的 ' + SECTORS.length + ' 个细分板块（单击看板块趋势、双击看成分股）';
  viewSeg.appendChild(segCat); viewSeg.appendChild(segAll);
  // 市场切换 tab（A股 / 美股），多数据集时显示
  const mktTabs = el('div', 'bd-mkttabs');
  datasets.forEach((ds, i) => {
    const t = el('button', 'bd-mkttab' + (i === 0 ? ' on' : ''), ds.label || ('市场' + (i + 1)));
    t.title = '切换到 ' + (ds.label || '市场');
    t.addEventListener('click', () => switchMarket(i));
    mktTabs.appendChild(t);
  });
  mktTabs.style.display = datasets.length > 1 ? '' : 'none';
  body.classList.add('bd-body');
  if (panelHead) {
    panelHead.classList.add('bd-panel-head');
    sub.classList.add('panel-sub');
    panelHead.appendChild(sub);
    panelHead.appendChild(freshTag);   // 紧跟副标题：一眼看到行情是哪天哪一刻的
    const acts = el('div', 'bd-head-acts');
    acts.appendChild(backBtn);
    acts.appendChild(mktTabs);
    acts.appendChild(viewSeg);
    acts.appendChild(refreshBtn);
    acts.appendChild(sortBtn);
    acts.appendChild(search);
    panelHead.appendChild(acts);
  } else {
    const head = el('div', 'bd-head');   // 兜底：拿不到标题栏时仍放内容区顶部
    head.appendChild(backBtn);
    head.appendChild(sub);
    head.appendChild(freshTag);
    head.appendChild(mktTabs);
    head.appendChild(viewSeg);
    head.appendChild(refreshBtn);
    head.appendChild(sortBtn);
    head.appendChild(search);
    body.appendChild(head);
  }
  const list = el('div', 'bd-list');
  body.appendChild(list);

  const toTk = (code) => {
    const c = String(code || '').trim().toUpperCase();
    if (!c) return '';
    if (c.endsWith('.SH')) return 'sh' + c.slice(0, -3);
    if (c.endsWith('.SZ')) return 'sz' + c.slice(0, -3);
    if (/^\d+$/.test(c)) return (c[0] === '6' || c[0] === '9' ? 'sh' : 'sz') + c;
    if (/^(SH|SZ|HK)\d+/.test(c)) return c.toLowerCase();   // 已带 A股/港股前缀(如 SH600519)
    return 'us' + c;   // 纯字母美股 ticker（SHOP/USB 等以 SH/US 开头也是美股，必须加 us 前缀）
  };

  let filter = '';
  let activeSector = null;
  let sortDesc = true;             // 排序方向：true=涨跌高→低，false=低→高
  let stockView = false;           // false=板块列表，true=成分股视图
  // 默认视图：挂了两个市场（A股+美股）就默认进「标准分类」——15 类骨架比 54 个板块名好读，
  // 且切市场时分类位置一一对应；单市场渲染器（usboard 等）没有"对应"可言，仍默认细分板块。
  let catMode = datasets.length > 1;   // 标准分类视图开关（🗂 分类 按钮随时切回 54 细分板块）
  let activeCat = null;            // 当前进入的分类（标准分类视图下）
  let quoteCache = {};             // sectorId -> { tk: {price,pct,chg} }
  let curMarket = 0;               // 当前市场数据集下标
  // 整体快照 localStorage key（按市场隔离）
  const lsKey = () => 'board_snap_v1_' + curMarket;

  const setSearch = () => { filter = search.value.trim().toLowerCase(); render(); };
  search.addEventListener('input', setSearch);
  sortBtn.addEventListener('click', () => { sortDesc = !sortDesc; render(); });
  refreshBtn.addEventListener('click', () => { refreshBtn.textContent = '⏳'; refreshBtn.disabled = true; preloadAll(true).then(() => { if (!disposed) { refreshBtn.textContent = '⟳'; refreshBtn.disabled = false; } }); });

  const fetchQuotes = async (codes) => {
    try {
      const res = await K.quote.realtime(codes);
      return (res && res.ok && res.quotes) ? res.quotes : {};
    } catch (e) { return {}; }
  };
  // 整体快照缓存（localStorage）：3 分钟内秒开、零网络请求；超时才后台并发刷新
  const CACHE_TTL = 3 * 60 * 1000;
  // SQLite 兜底缓存（quote_cache）：localStorage 快照缺失/异常时，从持久库恢复分板块行情
  const loadCachedQuotes = async () => {
    for (let i = 0; i < SECTORS.length; i++) {
      if (disposed) return;
      const sec = SECTORS[i];
      try {
        const cached = await K.quote.latest('sector:' + curMarket + ':' + sec.id);
        if (cached && typeof cached === 'object' && Object.keys(cached).length) {
          quoteCache[sec.id] = cached;
        }
      } catch (e) { /* ignore */ }
    }
  };
  const loadAllCached = () => {
    try {
      const raw = localStorage.getItem(lsKey());
      if (raw) {
        const snap = JSON.parse(raw);
        if (snap && snap.quotes && typeof snap.quotes === 'object') {
          quoteCache = snap.quotes;
          // 从快照恢复也算"这批行情的时间"——否则重启秒开后横幅是空的（本次没发请求，但数据有明确时间戳）
          if (snap.ts && !lastQuoteAt) noteQuoteAt(snap.ts);
          return snap.ts || 0;
        }
      }
    } catch (e) { /* ignore */ }
    return 0;
  };
  const saveAllCached = () => {
    try { localStorage.setItem(lsKey(), JSON.stringify({ ts: Date.now(), quotes: quoteCache })); }
    catch (e) { /* ignore */ }
  };

  // （行情时间横幅的状态与 helper 见本函数上方 freshTag 定义处）
  const loadSectorQuotes = async (sec) => {
    if (disposed) return;
    const codes = (sec.stocks || []).map(s => s.c);
    if (!codes.length) return;
    const q = await fetchQuotes(codes);
    quoteCache[sec.id] = q;
    noteQuoteAt(Date.now());
    // 持久缓存（供重启秒开，key 带市场前缀避免 A股/美股冲突）
    try { await K.quote.cache('sector:' + curMarket + ':' + sec.id, q); } catch (e) { /* ignore */ }
    if (activeSector && activeSector.id === sec.id) render();
  };
  // 板块平均涨跌幅（成分股已拉过行情才计算）
  const sectorAvg = (sec) => {
    const q = quoteCache[sec.id];
    if (!q) return null;
    const vals = [];
    (sec.stocks || []).forEach(st => {
      const x = q[toTk(st.c)];
      if (x && x.pct != null && isFinite(Number(x.pct))) vals.push(Number(x.pct));
    });
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };
  // ---- 标准分类层：分类没有自己的行情，全部由成员板块现算 ----
  // 反查表：板块 id → 分类 id（按市场缓存，数据是静态的，只需建一次）
  let catOfMap = null, catOfMapFor = -1;
  const catOf = (sec) => {
    if (catOfMapFor !== curMarket) {
      catOfMap = {}; catOfMapFor = curMarket;
      const m = CAT_MAP_BY_MARKET[curMarket] || {};
      Object.keys(m).forEach(cid => (m[cid] || []).forEach(sid => { catOfMap[sid] = cid; }));
      const ids = {}; SECTORS.forEach(s => { ids[s.id] = 1; });
      // 自检：两边口径必须严丝合缝——漏挂的板块会从分类视图里彻底消失，多挂的引用不存在的板块
      const missing = SECTORS.filter(s => !catOfMap[s.id]).map(s => s.id);
      const extra = Object.keys(catOfMap).filter(id => !ids[id]);
      if (missing.length || extra.length) console.warn('[board] 分类映射对不上：未归类板块=' + missing.join(',') + ' ｜ 多余引用=' + extra.join(','));
    }
    return catOfMap[sec.id] || '';
  };
  const catDef = (cid) => CAT_DEFS.filter(c => c.id === cid)[0] || { id: cid, icon: '📁', label: cid, labelUs: cid, desc: '' };
  // 分类名：两个市场各用各的自然叫法（label = A股叫法，labelUs = 美股叫法，缺省回落到 label）。
  // 同名分类（如 通信·电信）两边一致，就只在 labelUs 省略。
  const CAT_LABEL = (c) => (curMarket === 1 ? (c.labelUs || c.label) : c.label);
  const CAT_OTHER = (c) => {
    const mine = CAT_LABEL(c), other = (curMarket === 1 ? c.label : (c.labelUs || c.label));
    return other === mine ? other + '（同名）' : other;   // 两边叫法一样时点明"同名"，避免用户以为没对应
  };
  // 分类成员板块（按 CAT_DEFS 顺序，未知分类丢弃）
  const catMembers = (cid) => (CAT_MAP_BY_MARKET[curMarket] || {})[cid] || [];
  // 分类涨跌幅 = 成员板块均值的再平均（没取到行情的板块自动剔除；一个都没取到返回 null）
  const catAvg = (cid) => {
    const vals = catMembers(cid).map(sid => {
      const sec = SECTORS.filter(s => s.id === sid)[0];
      return sec ? sectorAvg(sec) : null;
    }).filter(v => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };
  // 分类成分股：把成员板块的票拼成一串，并带上所属板块（每只票仍是"板块×20"口径，不额外放宽）
  const catStocks = (cid) => {
    const out = [];
    catMembers(cid).forEach(sid => {
      const sec = SECTORS.filter(s => s.id === sid)[0];
      if (!sec) return;
      (sec.stocks || []).forEach(st => {
        if (out.some(x => x.c === st.c)) return;   // 同一只票在多个板块里出现时只留一次
        out.push({ c: st.c, d: st.d, _sec: sec.name });
      });
    });
    return out;
  };
  // 本地日期（YYYY-MM-DD，按电脑时区；A股收盘后快照归档为当天）
  const todayStr = () => {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };
  // 板块每日快照（sector_daily 表）：打开时先读当天库 → 秒开、不重复全量拉；
  // 返回恢复的板块数（0 = 无快照）：只有「全部板块都有行情」才视为快照完整可免拉；
  // 不完整时调用方继续全量拉取补全（避免快照残缺 → 大量板块永远没有涨跌数字）
  const loadDailySnapshot = async () => {
    try {
      const data = await K.sector.getDaily(curMarket, todayStr());
      if (data && typeof data === 'object' && Object.keys(data).length) {
        let restored = 0;
        SECTORS.forEach(sec => {
          const snap = data[sec.id];
          if (snap && snap.quotes && typeof snap.quotes === 'object' && Object.keys(snap.quotes).length) {
            quoteCache[sec.id] = snap.quotes;
            restored++;
          }
        });
        if (restored) {
          saveAllCached();
          render();
        }
        return restored;
      }
    } catch (e) { /* 读库失败走正常拉取 */ }
    return 0;
  };
  const saveDailySnapshot = async () => {
    try {
      const snapshots = {};
      SECTORS.forEach(sec => {
        const q = quoteCache[sec.id];
        if (!q || !Object.keys(q).length) return;
        snapshots[sec.id] = {
          avg: sectorAvg(sec),
          quotes: q
        };
      });
      if (Object.keys(snapshots).length) {
        await K.sector.setDaily(curMarket, todayStr(), snapshots);
      }
    } catch (e) { /* 写库失败不影响本次显示 */ }
  };
  // 启动：先画本地快照/缓存（秒开），新鲜则不重拉；过期则后台并发刷新
  // force=true（手动刷新按钮）：无视 3min TTL 无条件全量重拉
  const preloadAll = async (force) => {
    const snapTs = loadAllCached();
    let fresh = snapTs > 0 && (Date.now() - snapTs < CACHE_TTL);
    // 快照"新鲜"但数据不完整（有行情的板块数 < 板块总数）→ 不视为新鲜，自动补拉缺失板块
    if (fresh && !force) {
      const hasQuotes = Object.keys(quoteCache).filter(id => quoteCache[id] && Object.keys(quoteCache[id]).length).length;
      if (hasQuotes < SECTORS.length) fresh = false;
    }
    if (force) fresh = false;
    // localStorage 快照缺失/异常时，先从「当天板块每日快照」恢复（重启/隔天打开也秒开，不再全量拉）
    if (!fresh && !Object.keys(quoteCache).length) {
      const restored = await loadDailySnapshot();
      if (disposed) return;
      if (restored > 0 && restored >= SECTORS.length) {
        return;   // 当天快照完整 → 本次免全量拉（数据在 60s 自动刷新时更新）
      }
      // 快照缺失或不完整 → 继续走下面的全量拉取补全所有板块
    }
    // localStorage 快照缺失/异常时，从 SQLite 持久缓存兜底恢复（拉过一次就有）
    if (!fresh && !Object.keys(quoteCache).length) {
      await loadCachedQuotes();
    }
    if (disposed) return;
    render();
    if (fresh) return;   // 3 分钟内直接吃快照，不重复请求
    quoteFetching = true; paintFresh();   // 横幅进"拉取中…"态（拿 ⟳ 手动刷新时能看到）
    const all = [];
    SECTORS.forEach(sec => {
      (sec.stocks || []).forEach(st => {
        const tk = toTk(st.c);
        if (all.indexOf(tk) < 0) all.push(tk);
      });
    });
    const batches = [];
    for (let i = 0; i < all.length; i += 60) batches.push(all.slice(i, i + 60));
    const out = {};
    const CONC = 6;   // 6 路并发批量拉取（原为串行，几十个请求排队导致“一直加载中”）
    for (let b = 0; b < batches.length; b += CONC) {
      if (disposed) return;
      await Promise.all(batches.slice(b, b + CONC).map(async (batch) => {
        const q = await fetchQuotes(batch);
        Object.keys(q).forEach(k => { out[k] = q[k]; });
      }));
    }
    if (disposed) return;
    // 分板块回填 quoteCache + 持久缓存 + 当天每日快照（趋势看板历史）
    SECTORS.forEach(sec => {
      const m = {};
      (sec.stocks || []).forEach(st => {
        const tk = toTk(st.c);
        if (out[tk]) m[tk] = out[tk];
      });
      if (Object.keys(m).length) {
        quoteCache[sec.id] = m;
        try { K.quote.cache('sector:' + curMarket + ':' + sec.id, m); } catch (e) { /* ignore */ }
      }
    });
    saveAllCached();
    await saveDailySnapshot();   // 写入当天板块快照（sector_daily 表）
    quoteFetching = false; noteQuoteAt(Date.now());   // 全量拉完 → 横幅打上"最后刷新"时间
    render();
  };

  // 板块列表视图（每板块显示涨跌幅 + 按涨跌排序）
  const renderSectors = () => {
    list.innerHTML = '';
    let secs = SECTORS.filter(s =>
      !filter || s.name.toLowerCase().includes(filter) || (s.desc || '').toLowerCase().includes(filter)
    );
    // 排序：有涨跌的按涨跌排，无数据的排最后
    secs = secs.map(s => ({ s, avg: sectorAvg(s) }))
      .sort((a, b) => {
        if (a.avg == null && b.avg == null) return 0;
        if (a.avg == null) return 1;
        if (b.avg == null) return -1;
        return sortDesc ? b.avg - a.avg : a.avg - b.avg;
      })
      .map(x => x.s);
    if (!secs.length) {
      list.appendChild(el('div', 'stat-sub', '没有匹配的板块。'));
      return;
    }
    secs.forEach(sec => {
      const avg = sectorAvg(sec);
      const card = el('div', 'bd-card');
      const icoBox = el('div', 'bd-ico-box');
      icoBox.appendChild(el('span', 'bd-ico', sec.icon || '📊'));
      card.appendChild(icoBox);
      card.appendChild(el('span', 'bd-name', sec.name));
      const pct = el('span', 'bd-avg ' + (avg == null ? 'na' : (avg >= 0 ? 'up' : 'down')),
        avg == null ? '·' : (avg >= 0 ? '+' : '') + avg.toFixed(2) + '%');
      card.appendChild(pct);
      card.appendChild(el('span', 'bd-cnt', String((sec.stocks || []).length) + ' 只'));
      // 涨跌方向色条（红涨绿跌，无数据灰）→ 让卡片一眼看出板块强弱
      const bar = el('div', 'bd-bar ' + (avg == null ? 'na' : (avg >= 0 ? 'up' : 'down')));
      card.appendChild(bar);
      card.title = (sec.desc || '') + (sec.us ? '\n' + sec.us : '') +
        '\n\n单击 → 左侧「趋势看板」看板块趋势（等权合成板块K线/简介/历史涨跌/成分股 ' + (sec.stocks || []).length + ' 只）\n双击 → 进入成分股明细';
      // 单击（250ms 防抖判双击）→ 板块趋势联动左侧趋势看板；双击 → 进入成分股视图
      let clickTimer = null;
      card.addEventListener('click', () => {
        if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return; }   // 双击的第二次点击 → 交给 dblclick
        clickTimer = setTimeout(() => {
          clickTimer = null;
          if (disposed) return;
          window.dispatchEvent(new CustomEvent('sectorTrend', {
            detail: { sector: sec, market: curMarket, quotes: quoteCache[sec.id] || {} }
          }));
        }, 250);
      });
      card.addEventListener('dblclick', () => {
        if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
        openSector(sec);
      });
      list.appendChild(card);
    });
  };

  // 标准分类卡片视图（13 类；单击＝板块趋势、双击＝进该类板块列表）
  // 「标准分类」与「细分板块」是两种**排列方式**，卡片外形与操作手感完全一致，用户不用重新学。
  const renderCategories = () => {
    list.innerHTML = '';
    let cats = CAT_DEFS.map(c => ({
      c, avg: catAvg(c.id), members: catMembers(c.id),
      cnt: catMembers(c.id).reduce((n, sid) => {
        const sec = SECTORS.filter(s => s.id === sid)[0];
        return n + (sec ? (sec.stocks || []).length : 0);
      }, 0)
    }));
    if (filter) {
      cats = cats.filter(x => CAT_LABEL(x.c).toLowerCase().includes(filter) || (x.c.desc || '').toLowerCase().includes(filter));
    }
    cats.sort((a, b) => {
      if (a.avg == null && b.avg == null) return 0;
      if (a.avg == null) return 1;
      if (b.avg == null) return -1;
      return sortDesc ? b.avg - a.avg : a.avg - b.avg;
    });
    if (!cats.length) {
      list.appendChild(el('div', 'stat-sub', '没有匹配的分类。'));
      return;
    }
    cats.forEach(x => {
      const card = el('div', 'bd-card');
      const icoBox = el('div', 'bd-ico-box');
      icoBox.appendChild(el('span', 'bd-ico', x.c.icon));
      card.appendChild(icoBox);
      card.appendChild(el('span', 'bd-name', CAT_LABEL(x.c)));
      card.appendChild(el('span', 'bd-avg ' + (x.avg == null ? 'na' : (x.avg >= 0 ? 'up' : 'down')),
        x.avg == null ? '·' : (x.avg >= 0 ? '+' : '') + x.avg.toFixed(2) + '%'));
      card.appendChild(el('span', 'bd-cnt', x.members.length + ' 细分 · ' + x.cnt + ' 只'));
      card.appendChild(el('div', 'bd-bar ' + (x.avg == null ? 'na' : (x.avg >= 0 ? 'up' : 'down'))));
      card.title = x.c.desc + '\n对应另一市场：' + CAT_OTHER(x.c) +
        '\n\n单击 → 左侧「趋势看板」看分类趋势\n双击 → 进入分类，看它所包含的 ' + x.members.length + ' 个细分板块';
      let clickTimer = null;
      card.addEventListener('click', () => {
        if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return; }
        clickTimer = setTimeout(() => {
          clickTimer = null;
          if (disposed) return;
          if (activeCat && activeCat.id === x.c.id) {
            window.dispatchEvent(new CustomEvent('sectorTrend', catTrendPayload(x.c.id)));
            return;
          }
          openCategory(x.c.id);
        }, 250);
      });
      card.addEventListener('dblclick', () => {
        if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
        openCategory(x.c.id);
      });
      list.appendChild(card);
    });
  };

  // 成分股视图（最多 20 只 + 实时行情，行式「一排排」：名称/现价/涨跌 + 业务覆盖 + 产业/题材/未来方向）
  // 个股级数据只有一句话业务描述（st.d）；产业信息/炒作题材/未来可能业务由板块级字段（name/desc/us）承接展示
  const renderStocks = (sec) => {
    list.innerHTML = '';
    const isCat = !!sec._catId;
    const stocks = isCat ? catStocks(sec._catId) : secStocks(sec);
    const qOf = (code) => (isCat ? (quoteCache['cat:' + curMarket + ':' + sec._catId] || {}) : (quoteCache[sec.id] || {}))[toTk(code)];
    const wrap = el('div', 'bd-stk-rows');
    stocks.forEach(st => {
      const q = qOf(st.c);
      const name = (q && q.name) || st.name || st.c;
      const row = el('div', 'bd-stk-row bd-sel');
      // 行首：名称 + 代码 + 现价 + 涨跌幅
      const head = el('div', 'bd-stk-rhead');
      head.appendChild(el('span', 'bd-stk-name', name));
      head.appendChild(el('span', 'bd-stk-code', st.c));
      const price = el('span', 'bd-stk-price', q && q.price != null ? q.price : '--');
      const pct = el('span', 'bd-stk-pct',
        q && q.pct != null ? (Number(q.pct) > 0 ? '+' : '') + q.pct + '%' : '--');
      pct.style.color = mktColor(pct.textContent);
      head.appendChild(price);
      head.appendChild(pct);
      row.appendChild(head);
      // 业务覆盖情况（个股一句话业务）
      if (st.d) row.appendChild(el('div', 'bd-stk-biz', '📌 业务覆盖：' + st.d));
      // 产业信息 / 炒作题材（板块级，行式标签呈现）；分类视图下额外标出该票属于哪个细分板块
      const tags = el('div', 'bd-stk-tags');
      tags.appendChild(el('span', 'bd-stk-tag', '🏭 ' + (isCat ? '板块：' + st._sec : '产业：' + (sec.name || ''))));
      if (!isCat) {
        if (sec.desc) tags.appendChild(el('span', 'bd-stk-tag', '🔥 题材：' + sec.desc));
        if (sec.us) tags.appendChild(el('span', 'bd-stk-tag future', '🔮 未来可能：' + sec.us));
      }
      row.appendChild(tags);
      row.title = (st.d || '') + '\n点击联动「趋势看板」看 K线';
      row.addEventListener('click', () => {
        window.dispatchEvent(new CustomEvent('stockSelect', {
          detail: { code: st.c, name: name }
        }));
      });
      wrap.appendChild(row);
    });
    list.appendChild(wrap);
    list.appendChild(el('div', 'stat-sub', isCat
      ? '分类内 ' + stocks.length + ' 只（各细分板块成员去重）· 点击任意行 → 联动「趋势看板」看分时/K线。'
      : '每只票一排排显示：名称/现价/涨跌 + 业务覆盖 + 产业/题材/未来方向。点击任意行 → 联动「趋势看板」看分时/K线。'));
  };

  const render = () => {
    if (disposed) return;
    // 板块列表视图：自适应网格（不限制每排几个，CSS auto-fill 按面板宽度自然排布，超长滚动）；成分股视图回退自适应流式网格
    list.classList.toggle('sectors-view', !stockView);
    list.classList.toggle('cats-view', catMode && !stockView);   // 分类卡片：细分板块数少，卡片收窄一点
    // 返回键：成分股 → 上一层（分类视图回分类列表 / 细分视图回板块列表）；分类列表 → 板块列表或分类根
    backBtn.style.display = (activeSector || (catMode && activeCat)) ? '' : 'none';
    backBtn.textContent = activeSector ? ('‹ ' + (catMode && activeCat ? CAT_LABEL(catDef(activeCat)) : '板块')) : '‹ 分类';
    // 视图按钮互斥高亮（清空搜索框时也走这里，所以状态一律在这里同步）
    segCat.classList.toggle('on', catMode);
    segAll.classList.toggle('on', !catMode);
    // 板块名 + 数量统一由 sub 显示（挂面板标题后面）；原来的内容区「板块雷达」标题已删，避免与面板标题重复
    if (mktTabs.children.length > 1) {
      for (let i = 0; i < mktTabs.children.length; i++) {
        mktTabs.children[i].classList.toggle('on', i === curMarket);
      }
    }
    if (stockView && activeSector) {
      sub.textContent = (catMode && activeCat ? CAT_LABEL(catDef(activeCat)) + ' · ' : '') +
        activeSector.name + ' · ' + (activeSector.stocks || []).length + ' 只成分股';
    } else if (catMode && activeCat) {
      const c = catDef(activeCat);
      sub.textContent = CAT_LABEL(c) + ' · ' + catMembers(activeCat).length + ' 个细分板块';
    } else if (catMode) {
      sub.textContent = CAT_DEFS.length + ' 大分类 · A股/美股一一对应 · 单击看分类 · 双击进分类';
    } else {
      sub.textContent = SECTORS.length + ' 板块 · 单击看板块趋势 · 双击进成分股';
    }
    sortBtn.style.display = stockView ? 'none' : '';
    if (activeSector && stockView) renderStocks(activeSector);
    else if (activeSector) renderSectors();
    else if (catMode) { if (activeCat) renderSectors(); else renderCategories(); }
    else renderSectors();
  };

  // 分类 → 左侧「趋势看板」的分类趋势视图（把成员板块的实时行情合并成板块趋势的数据形状）
  const catTrendPayload = (cid) => {
    const c = catDef(cid);
    const stocks = catStocks(cid);
    const q = {};
    const src = quoteCache['cat:' + curMarket + ':' + cid] || {};
    Object.keys(src).forEach(k => { q[k] = src[k]; });
    return {
      sector: {
        id: 'cat_' + cid,
        icon: c.icon,
        name: CAT_LABEL(c) + '（分类）',
        desc: c.desc + '｜本类含 ' + catMembers(cid).length + ' 个细分板块、' + stocks.length + ' 只成分股。',
        us: '对应另一市场：' + CAT_OTHER(c),
        stocks: stocks
      },
      market: curMarket,
      quotes: q
    };
  };

  // 进入某个分类：先渲染（行情未到先画空价），再补齐该分类里所有板块的行情
  const openCategory = async (cid) => {
    activeCat = cid;
    activeSector = null;
    stockView = false;
    render();
    const cacheKey = 'cat:' + curMarket + ':' + cid;
    const members = catMembers(cid);
    // 该分类里有票、但行情还没拉过的板块 → 需要补拉（正常情况下预载已覆盖，这里只兜底）
    const missing = members.filter(sid => {
      const sec = SECTORS.filter(s => s.id === sid)[0];
      return sec && (sec.stocks || []).length && !(quoteCache[sec.id] && Object.keys(quoteCache[sec.id]).length);
    });
    if (!quoteCache[cacheKey] || missing.length) await loadCategoryQuotes(cid);
    else render();
  };

  // 切换市场（A股 / 美股）：重置状态，预载新市场板块行情
  // ⚠ 分类视图下切市场**保留 activeCat**：同一个分类 id 在两边指同一件事，
  //   切过去正好看到"同类板块在另一个市场的叫法"，这就是「一一对应」的用法。
  const switchMarket = (i) => {
    if (disposed || i < 0 || i >= datasets.length || i === curMarket) return;
    curMarket = i;
    SECTORS = datasets[i].sectors;
    filter = ''; search.value = '';
    activeSector = null; stockView = false;
    quoteCache = {};     // 清空，切换后用新市场行情重新填充
    render();
    preloadAll();
  };

  const openSector = async (sec) => {
    activeSector = sec;
    stockView = true;          // 进入成分股视图
    render();
    if (!quoteCache[sec.id]) {
      list.appendChild(el('div', 'stat-sub', '正在加载 ' + (sec.stocks || []).length + ' 只成分股实时行情…'));
      await loadSectorQuotes(sec);
    } else {
      render();
    }
  };

  // 分类行情：把该分类下所有板块的票一次批量拉回，存成一条 'cat:<市场>:<分类id>' 缓存。
  // 只用于分类视图显示价格；**不写 sector_daily 快照**（那是板块口径的历史，分类现算即可，避免污染）。
  const loadCategoryQuotes = async (cid) => {
    if (disposed) return;
    const stocks = catStocks(cid);
    if (!stocks.length) return;
    const codes = [];
    stocks.forEach(st => { const tk = toTk(st.c); if (codes.indexOf(tk) < 0) codes.push(tk); });
    const batches = [];
    for (let i = 0; i < codes.length; i += 60) batches.push(codes.slice(i, i + 60));
    const out = {};
    const CONC = 6;
    for (let b = 0; b < batches.length; b += CONC) {
      if (disposed) return;
      await Promise.all(batches.slice(b, b + CONC).map(async (batch) => {
        const q = await fetchQuotes(batch);
        Object.keys(q).forEach(k => { out[k] = q[k]; });
      }));
    }
    if (disposed) return;
    quoteCache['cat:' + curMarket + ':' + cid] = out;
    // 顺手把各板块自己的缓存补上（分类视图里点进某个细分板块就不用再拉）
    catMembers(cid).forEach(sid => {
      const sec = SECTORS.filter(s => s.id === sid)[0];
      if (!sec) return;
      const m = {};
      (sec.stocks || []).forEach(st => { const tk = toTk(st.c); if (out[tk]) m[tk] = out[tk]; });
      if (Object.keys(m).length && !(quoteCache[sec.id] && Object.keys(quoteCache[sec.id]).length)) quoteCache[sec.id] = m;
    });
    saveAllCached();
    noteQuoteAt(Date.now());   // 分类视图的行情也算一次刷新（横幅跟着走）
    if (activeCat === cid || (activeSector && catOf(activeSector) === cid)) render();
  };

  // 视图切换：15 分类 ⇄ 54 板块（两个视图都从根开始，避免残留在上一个视图的层级里）
  const setCatMode = (v) => {
    catMode = !!v;
    activeCat = null; activeSector = null; stockView = false;
    filter = ''; search.value = '';
    render();
  };
  segCat.addEventListener('click', () => setCatMode(true));
  segAll.addEventListener('click', () => setCatMode(false));

  // 返回：一层一层退——成分股 →（分类视图：分类列表 / 细分视图：板块列表）
  backBtn.addEventListener('click', () => {
    if (activeSector) { activeSector = null; stockView = false; render(); return; }
    if (activeCat) { activeCat = null; render(); return; }
    catMode = false; render();
  });

  render();
  preloadAll();   // 后台预载所有板块行情
  // 盘中自动刷新：60s 周期，preloadAll 内部自行判断（3min TTL + 快照不完整自动补拉）；板块详情视图内不打扰
  // ★2026-10-15：**休市不再每 3 分钟重拉**（用户要求"不开盘就是固定面板"）。
  //   原来它收盘后照样按 TTL 全量重拉，而每次重拉会把 108 个板块键各写一行 ~10.5KB 进 `quote_cache`
  //   （PK 是 code+毫秒时间戳 ⇒ 只增不减）—— 那就是 `market.db` 涨到 165MB（其中 132MB 是垃圾）的源头。
  //   现在：交易时段才自动重拉；休市只在"当天还没存过快照"时补一次，之后冻住。
  const boardBjHM = () => { const d = new Date(Date.now() + 8 * 3600e3); const w = d.getUTCDay(); return { w, hm: d.getUTCHours() * 100 + d.getUTCMinutes() }; };
  const boardTrading = () => { const t = boardBjHM(); return t.w !== 0 && t.w !== 6 && ((t.hm >= 915 && t.hm <= 1135) || (t.hm >= 1255 && t.hm <= 1505)); };
  const boardSnapDay = () => { const d = new Date(Date.now() + 8 * 3600e3); return d.toISOString().slice(0, 10); };
  let boardClosedDay = '';        // 已经为哪一天存过"收盘快照"
  const autoRefresh = setInterval(() => {
    if (disposed || activeSector || (catMode && activeCat)) return;
    if (!boardTrading()) {
      // 休市：当天只补一次（拿到收盘口径就冻住）；`loadAllCached` 的快照还是今天的就完全不动
      const day = boardSnapDay();
      if (boardClosedDay === day) return;
      const snapTs = loadAllCached();
      if (snapTs && new Date(snapTs + 8 * 3600e3).toISOString().slice(0, 10) === day) { boardClosedDay = day; return; }
      boardClosedDay = day;
      preloadAll(true);
      return;
    }
    preloadAll();
  }, 60000);

  // 场景隔离：切走场景时停止后台预载与刷新（disposed 守卫）
  return () => { disposed = true; clearInterval(autoRefresh); };
};


renderers.board = (body, meta, panelHead) => createBoardRenderer(body, {
  datasets: [
    { label: 'A股', sectors: (typeof SECTOR_DATA !== 'undefined' && Array.isArray(SECTOR_DATA)) ? SECTOR_DATA : [] },
    { label: '美股', sectors: (typeof US_SECTOR_DATA !== 'undefined' && Array.isArray(US_SECTOR_DATA)) ? US_SECTOR_DATA : [] }
  ]
}, panelHead);
// 兼容保留：单市场渲染器（场景里不再直接使用 usboard 面板）
renderers.usboard = (body, meta, panelHead) => createBoardRenderer(body, { SECTORS: (typeof US_SECTOR_DATA !== 'undefined' && Array.isArray(US_SECTOR_DATA)) ? US_SECTOR_DATA : [] }, panelHead);
// ============ screen：选股器（三引擎：情绪 / 超跌反弹 / 波段启动） ============
// 数据源：东方财富 clist 全市场排名（涨幅榜 + 跌幅榜双向扫描，真实行情）
// 引擎一「情绪」：涨跌家数、涨停/跌停数、连板高度 → 市场温度
// 引擎二「超跌反弹」：60日跌幅深 + 今日企稳（跌深反弹博弈）
// 引擎三「波段启动」：涨幅榜中趋势确立 + 放量（动量突破）
renderers.screen = (body, meta, panelHead) => {
  body.classList.add('screen-body');
  const K = window.app.stock;
  let tab = 'alert';   // alert(🔔提示) | sentiment | rebound | breakout
  let upList = [], downList = [];   // 全市场涨幅榜 / 跌幅榜缓存
  let r60List = [];                // 全市场 60 日跌幅榜（后端按东财 f24 升序，供超跌反弹用）
  // ★2026-10-16：**本地 60 日榜**（东财 clist 被 WAF 掐时的兜底）。
  //   背景：东财三个域名被秒断是常态（实测 0.4s RemoteDisconnected），而 `r60List` 原来**没有任何兜底**
  //   ——新浪的榜行 `r60=null` 给不出 60 日涨跌幅 ⇒「🔄 超跌反弹」在东财挂掉时永远是空的（"用了没效"）。
  //   做法：拿 `sector-data.js` 里自己盯的那些主板成分股（≈940 只，实测 150 只仅 1.4s），分批拉日K本地算
  //   `r60 = 现价/60 交易日前收盘 - 1`，结果累积进 localStorage；每轮扫描推进一批（96 只），
  //   约 10 轮扫完整池，之后每次扫描都是命中 kline_cache（当天已取过 ⇒ 秒回）。
  //   ⚠ 只在东财榜拿不到时才跑，且**休市不跑**（休市靠当天那次收盘快照）。
  var R60_KEY = 'scr_r60_local_v1';
  var R60_KEEP = -12;              // 只留 r60 ≤ -12% 的（超跌候选才有用；顺便把 localStorage 控制在几十 KB）
  let r60Local = {};               // code -> {name, r60, lastDay, ts}
  let r60Ptr = 0;                  // 轮询游标：每轮从池子不同位置开始，扫完整池
  try {
    const savedR60 = JSON.parse(localStorage.getItem(R60_KEY) || '{}');
    if (savedR60 && savedR60.pool && typeof savedR60.pool === 'object') {
      r60Local = savedR60.pool;
      r60Ptr = Number(savedR60.ptr) || 0;
    }
  } catch (e) { /* ignore */ }
  const saveR60 = () => { try { localStorage.setItem(R60_KEY, JSON.stringify({ pool: r60Local, ptr: r60Ptr, ts: Date.now() })); } catch (e) { /* ignore */ } };
  const bjToday = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const R60_UNIVERSE = (() => {
    const seen = {}, out = [];
    try {
      (typeof SECTOR_DATA !== 'undefined' ? SECTOR_DATA : []).forEach(sec => (sec.stocks || []).forEach(st => {
        const c = String((st && st.c) || '').replace(/^(sh|sz|bj)/i, '').replace(/\.(SH|SZ|BJ)$/i, '');
        if (!/^\d{6}$/.test(c) || seen[c] || noBuy(c)) return;
        seen[c] = 1; out.push({ code: c, name: (st && st.n) || '' });
      }));
    } catch (e) { /* 拿不到板块数据就不兜底 */ }
    return out;
  })();
  // 推进一步本地扫描（4 轮 × 24 只 = 96 只）；返回本轮新增的候选数
  const sweepR60Local = async () => {
    if (disposed || !R60_UNIVERSE.length) return 0;
    let added = 0;
    const CH = 24;
    for (let r = 0; r < 4; r++) {
      if (disposed) break;
      const batch = [];
      for (let i = 0; i < CH; i++) batch.push(R60_UNIVERSE[(r60Ptr + i) % R60_UNIVERSE.length]);
      r60Ptr = (r60Ptr + CH) % R60_UNIVERSE.length;
      try {
        const res = await K.kline.batch(batch.map(x => x.code), 120);
        if (disposed) break;
        const data = (res && res.ok && res.data) || {};
        batch.forEach(x => {
          const kl = data[x.code];
          if (!kl || kl.length < 62) return;
          const lastDay = String(kl[kl.length - 1][0] || '');
          const c0 = Number(kl[kl.length - 61][2]), c1 = Number(kl[kl.length - 1][2]);
          const p0 = Number(kl[kl.length - 2] ? kl[kl.length - 2][2] : 0);
          if (!c0 || !c1) return;
          // 末根K线太旧（停牌/退市/长期没数据）→ 丢弃，别让 2023 年的"超跌"混进来
          const ageMs = Date.now() + 8 * 3600e3 - Date.parse(lastDay + 'T00:00:00Z');
          if (!isFinite(ageMs) || ageMs > 10 * 86400e3) return;
          const r60 = (c1 / c0 - 1) * 100;
          if (r60 > R60_KEEP || r60 < -90) { delete r60Local[x.code]; return; }
          r60Local[x.code] = { name: x.name, r60, lastDay, ts: Date.now(), pctK: p0 ? (c1 / p0 - 1) * 100 : null };
          added++;
        });
      } catch (e) { /* 这一批失败就跳过 */ }
    }
    saveR60();
    return added;
  };
  // 把本地池子转成"榜行"形状（补现价/涨跌/换手/市值 —— 一次批量行情就够，只有几十只）
  const r60LocalRows = async () => {
    const codes = Object.keys(r60Local);
    if (!codes.length) return [];
    let qmap = {};
    try {
      const q = await K.quote.realtime(codes);
      if (disposed) return [];
      qmap = (q && q.quotes) || {};
    } catch (e) { /* 行情拿不到就只按 K线算的涨跌幅填 */ }
    return codes.map(c => {
      const e = r60Local[c];
      const qq = qmap[c] || qmap[('sh' + c)] || qmap[('sz' + c)] || null;
      if (!qq) return null;                 // 行情都没拿到 ⇒ 这行没法判"企稳/市值"，直接不显示
      return {
        code: c, name: qq.name || e.name || c,
        price: Number(qq.price) || null,
        pct: isFinite(Number(qq.pct)) ? Number(qq.pct) : (e.pctK == null ? 0 : e.pctK),
        turn: Number(qq.turn) || 0,
        mcap: Number(qq.mcap) || 0,
        r60: e.r60, r60Local: true, r60Day: e.lastDay,
      };
    }).filter(Boolean);
  };
  let ztPool = [];                 // 真·全市场涨停池（东财 push2ex，经 scripts\mkt-fallback.py 取；样本口径的替代）
  let loading = false, ts = 0;
  let disposed = false;    // 场景隔离：切走场景后停止扫描/渲染

  // ---- 风险标的识别（供超跌反弹 / 波段启动过滤）----
  // ST / *ST / 退：涨跌停 5%，且多为重组或退市博弈，与"技术性超跌反弹"不是一回事
  const isST = (s) => /ST|退/.test(String((s && s.name) || ''));
  // 上市首日/次新：东财用 C 前缀（如 "C沈鼓"），注册制新股首日无涨跌幅限制，
  // 首日 +177% 被当成"波段启动"是纯噪音。注：仅匹配"单个 C/N + 中文名"，
  // 避免误伤 "NST"、"XD"、"ST" 这类正常前缀。
  const isIPO = (s) => /^(?:[CN](?!ST|XD))/.test(String((s && s.name) || ''));

  const wrap = el('div', 'scr-wrap');
  body.appendChild(wrap);
  // 2026-10-14：这层面板真正滚动的是 .panel-body（.scr-list 的 flex:1 在 auto 高度的父级里拿不到定高，
  // 所以它自己不滚）⇒ 给 body 打个标记，CSS 里关掉 scroll anchoring（见 styles.css .screen-body 段）。
  if (body && body.classList) body.classList.add('scr-body');

  // ---- 工具条：模式切换 + 刷新行情 → 统一放进「面板标题栏右侧」，不再占用内容区 ----
  // 原来内容区顶部有一行「🎯 选股器」大字标题，与面板标题重复，已删除。
  const modes = el('div', 'scr-modes');
  const modeBtns = {};
  const mkMode = (id, label, tip) => {
    const b = el('button', 'scr-mode' + (tab === id ? ' on' : ''), label);
    b.title = tip;
    b.addEventListener('click', () => { tab = id; syncModeHighlight(); render(); });
    modes.appendChild(b);
    modeBtns[id] = b;
    return b;
  };
  // 模式切换时蓝色高亮跟随当前 tab（原先只在创建时设置 class，点击后高亮不移动）
  const syncModeHighlight = () => {
    Object.keys(modeBtns).forEach(id => modeBtns[id].classList.toggle('on', id === tab));
  };
  mkMode('alert', '🛰️ 雷达提示', '规则盯盘 + 秒级雷达（已合并成一页）：持仓到价 / 急拉急跌 / 涨停潮 / 板块联动 / 机会票，纯本地不耗 token');
  mkMode('opp', '🚀 机会池', '拉涨即机会（全市场涨幅榜，涨幅 >0 全进池；已屏蔽创业板/科创板/北交所）：本地规则打分 + 六类动作，回答"能不能参与、以什么方式参与"');
  mkMode('sentiment', '📊 情绪', '全市场涨跌家数 / 涨停数 / 连板高度');
  mkMode('rebound', '🔄 超跌反弹', '60日跌幅深 + 企稳信号，博弈均值回归');
  mkMode('breakout', '🚀 波段启动', '低位 + 不追高：涨幅榜里筛「60日位置<50% 且 距 MA20 在 -8%~+5%」，按位置最低排序 · 回测口径 止盈+8%/止损−5%（2026-10-15 重做，理由见场景卡）');
  const refreshBtn = el('button', 'scr-refresh', '🔄 刷新行情');
  refreshBtn.title = '重新拉取全市场涨幅榜/跌幅榜（这次扫了什么，看左边的 ⓘ）';
  refreshBtn.addEventListener('click', () => scan());
  // ★2026-10-15（用户要求）：① 把「🔄 刷新行情」挪到标题行（「选股建议」那一排）——原来它自己占一整行；
  //   ② 旁边加一个 ⓘ 指示：**鼠标悬停显示「已扫描 400 只…」那段扫描口径**（原来那段文字占内容区 3 行）。
  //      ⓘ 点一下 = 把口径在内容区摊开／收起；扫描失败/⚠ 时自动摊开（报错不许藏在 tooltip 里）。
  const infoBtn = el('button', 'scr-info', 'ⓘ');
  infoBtn.title = '扫描口径（点过「刷新行情」后这里显示：扫了哪些榜、屏蔽了哪些板块）';
  if (panelHead) {
    panelHead.classList.add('scr-head');
    const titleActs = el('div', 'scr-head-title-acts');
    titleActs.appendChild(infoBtn);
    titleActs.appendChild(refreshBtn);
    panelHead.appendChild(titleActs);
    // 标题行同时是拖拽把手 ⇒ 塞进去的按钮必须阻断指针事件，否则"点了没反应"
    if (typeof wireHeadNoDrag === 'function') wireHeadNoDrag(titleActs);
    const acts = el('div', 'scr-head-acts');
    acts.appendChild(modes);
    panelHead.appendChild(acts);
  } else {
    // 兜底：拿不到标题栏时仍放在内容区顶部
    const top = el('div', 'scr-top');
    top.appendChild(modes);
    top.appendChild(infoBtn);
    top.appendChild(refreshBtn);
    wrap.appendChild(top);
  }

  // ---- 状态行 ----
  // ★2026-10-15：默认收起（内容只走 ⓘ 的 tooltip），点 ⓘ 摊开/收起 ⇒ 省下一整块内容区高度。
  const status = el('div', 'scr-status scr-status-hide', '点击「刷新行情」扫描全市场…');
  let statusMo = null;
  const infoTip = () => {
    const t = (status.textContent || '').replace(/\s+$/, '');
    infoBtn.title = t
      ? t.replace(/\s*\+\s*/g, '\n+ ').replace(/\s*·\s*/g, '\n· ')   // 换个行，长 tooltip 好读
      : '点击「刷新行情」扫描全市场…';
  };
  infoBtn.addEventListener('click', () => { status.classList.toggle('scr-status-hide'); infoTip(); });
  infoTip();
  try {
    statusMo = new MutationObserver(() => {
      infoTip();
      // 报错/异常：自动把口径摊开（宁可多占点高度，也不让失败信息藏在 tooltip 里）
      if (/失败|错误|⚠|超时|异常/.test(status.textContent || '')) status.classList.remove('scr-status-hide');
    });
    statusMo.observe(status, { childList: true, subtree: true, characterData: true });
  } catch (e) { statusMo = null; }
  wrap.appendChild(status);

  // ---- 结果容器 ----
  const list = el('div', 'scr-list');
  wrap.appendChild(list);
  // 2026-10-14：「提示」与「雷达」合并成一个页签 —— renderAlert 只重画"提示区"（规则 / 命中日志），
  // 雷达块由 renderAlertMerged 一次建好并常驻，20 秒自检不会把它冲掉（否则每 20 秒重建一次轮询器）。
  let alertHostRef = list;

  const fmt = (v, d = 2) => v == null ? '--' : Number(v).toFixed(d);
  const mkColor = v => mktColor(v);

  // ============ 打分引擎（移植自双引擎选股器：超跌反弹 + 波段启动，满分各100） ============
  const lin = (x, x0, x1, y0, y1) => {
    if (x1 === x0) return y1;
    const v = y0 + (x - x0) / (x1 - x0) * (y1 - y0);
    return Math.max(Math.min(v, Math.max(y0, y1)), Math.min(y0, y1));
  };
  const SMA = (arr, n) => { if (arr.length < n) return null; let s = 0; for (let i = arr.length - n; i < arr.length; i++) s += arr[i]; return s / n; };
  const EMA = (arr, n) => {
    const k = 2 / (n + 1); let ema = arr[0]; const out = [arr[0]];
    for (let i = 1; i < arr.length; i++) { ema = arr[i] * k + ema * (1 - k); out.push(ema); }
    return out;
  };
  const STD = (arr) => {
    const m = arr.reduce((a, b) => a + b, 0) / arr.length;
    return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length);
  };
  const sliceN = (arr, n) => arr.slice(-n);
  const macdInd = (closes) => {
    const e12 = EMA(closes, 12), e26 = EMA(closes, 26);
    const dif = e12.map((v, i) => v - e26[i]);
    const dea = EMA(dif, 9);
    const hist = dif.map((v, i) => (v - dea[i]) * 2);
    return { dif, dea, hist };
  };
  const rsiInd = (closes, n = 14) => {
    if (closes.length <= n) return null;
    let g = 0, l = 0;
    for (let i = closes.length - n; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      if (d > 0) g += d; else l -= d;
    }
    if (g + l === 0) return 50;
    return 100 * g / (g + l);
  };
  const quantile = (arr, q) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const pos = (s.length - 1) * q;
    const base = Math.floor(pos), rest = pos - base;
    return s[base + 1] ? s[base] * (1 - rest) + s[base + 1] * rest : s[base];
  };
  const bollInd = (closes, n = 20) => {
    if (closes.length < n) return null;
    const mid = SMA(closes, n);
    const std = STD(sliceN(closes, n));
    return { mid, up: mid + 2 * std, dn: mid - 2 * std };
  };
  // 腾讯K线行 [date,o,c,h,l,v] → 打分用 {o,c,h,l,v,a}
  const toKL = (rows) => (rows || []).map(k => {
    const c = Number(k[2]);
    return { o: Number(k[1]), c, h: Number(k[3]), l: Number(k[4]), v: Number(k[5]) || 0, a: (Number(k[5]) || 0) * (c || 0) };
  });
  // 超跌反弹打分：超跌深度30 + 企稳确认35 + 反转催化20 + 风控15
  const analyzeA = (mk, rows) => {
    const kl = toKL(rows);
    const N = kl.length;
    if (N < 40) return null;
    const closes = kl.map(k => k.c), highs = kl.map(k => k.h), lows = kl.map(k => k.l), vols = kl.map(k => k.v);
    const C = closes[N - 1], H60 = Math.max(...highs.slice(-60)), L60 = Math.min(...lows.slice(-60));
    const ma5 = SMA(closes, 5), ma10 = SMA(closes, 10), ma20 = SMA(closes, 20), ma60 = N >= 60 ? SMA(closes, 60) : null;
    const sd20 = STD(sliceN(closes, 20));
    const z = (C - ma20) / (sd20 || 1);
    const bb = bollInd(closes, 20);
    const bwNow = bb ? (bb.up - bb.dn) / bb.mid : 0;
    const bwHist = [];
    for (let i = 20; i < N; i++) {
      const seg = closes.slice(i - 20, i);
      const mid = seg.reduce((a, b) => a + b, 0) / 20;
      const sd = STD(seg);
      bwHist.push((2 * sd * 2) / mid);
    }
    const bwQ30 = bwHist.length ? quantile(bwHist, 0.3) : 0;
    const volMA20 = SMA(vols, 20);
    const md = macdInd(closes);
    const r14 = rsiInd(closes, 14);
    const low3 = Math.min(lows[N - 3], lows[N - 2], lows[N - 1]);
    const lowPrev5 = Math.min(...lows.slice(N - 8, N - 3));
    const ret60 = (C - closes[N - 61]) / closes[N - 61] * 100;

    const drawdown = Math.max(0, (H60 - C) / H60 * 100);
    let s1 = lin(drawdown, 10, 35, 0, 30);
    let s2 = lin(z, 0, -2, 0, 30);
    const pos60 = (C - L60) / (H60 - L60 + 1e-9);
    let s3 = lin(pos60, 0.6, 0.25, 0, 30);
    const scoreDeep = Math.min(30, (s1 + s2 + s3) / 3);

    const maLong = N >= 130 ? SMA(closes, 130) : (N >= 60 ? SMA(closes, 60) : SMA(closes, 20));
    const longDown = maLong && ma60 && ma60 < maLong * 0.99;
    const stabOk = low3 > lowPrev5;
    const above5ok = C > ma5;
    const volRatio = vols[N - 1] / (volMA20 || 1);
    const inStateS1 = drawdown >= 12 && (longDown || ret60 <= -8) && (stabOk || above5ok || volRatio <= 0.8);
    if (!inStateS1) return null;

    let q1 = lin(bwNow / (bwQ30 + 1e-9), 2, 0.5, 0, 10);
    let q2 = lin(volRatio, 1.2, 0.5, 0, 9);
    let q3 = stabOk ? 6 : 0;
    let q4 = above5ok ? 5 : 0;
    const lowerShadow = (Math.min(kl[N - 1].o, C) - lows[N - 1]) / (highs[N - 1] - lows[N - 1] + 1e-9);
    let q5 = lowerShadow > 0.5 ? 5 : 0;
    const scoreStable = Math.min(35, q1 + q2 + q3 + q4 + q5);

    let r1 = 0;
    const last5Low = Math.min(...lows.slice(-5));
    r1 = (C <= L60 * 1.03 && last5Low <= L60 * 1.02) ? 5 : 0;
    const dif = md.dif[N - 1];
    const difPrev5 = Math.min(...md.dif.slice(-6, -1));
    const cLowPrev5 = Math.min(...lows.slice(-6, -1));
    let r2 = (last5Low < cLowPrev5 && dif > difPrev5) ? 5 : 0;
    let r3 = (r14 != null && r14 < 40 && r14 > 25) ? 5 : 0;
    let r4 = (volRatio > 1.5 && C >= kl[N - 1].o) ? 5 : 0;
    const scoreCat = Math.min(20, r1 + r2 + r3 + r4);

    let risk = 15;
    const amt = kl[N - 1].a;
    if (amt < 3000e4) risk -= 8;
    if (mk.mcap < 30e8 || mk.mcap > 500e8) risk -= 4;
    if (ret60 <= -45) risk -= 3;
    risk = Math.max(0, risk);

    const total = Math.round(scoreDeep + scoreStable + scoreCat + risk);
    return { total, scoreDeep, scoreStable, scoreCat, risk };
  };
  // 波段启动打分：方向30 + 回调充分20 + 资金量能30 + 安全边际20
  const analyzeB = (mk, rows) => {
    const kl = toKL(rows);
    const N = kl.length;
    if (N < 80) return null;
    const closes = kl.map(k => k.c), highs = kl.map(k => k.h), lows = kl.map(k => k.l), vols = kl.map(k => k.v);
    const C = closes[N - 1];
    const H60 = Math.max(...highs.slice(-60)), L60 = Math.min(...lows.slice(-60));
    const ma5 = SMA(closes, 5), ma10 = SMA(closes, 10), ma20 = SMA(closes, 20), ma60 = SMA(closes, 60);
    const ma130 = N >= 130 ? SMA(closes, 130) : ma60;
    const ma20prev5 = SMA(closes.slice(0, -5), 20);
    const md = macdInd(closes);
    const r14 = rsiInd(closes, 14);
    const volMA5 = SMA(vols, 5), volMA20 = SMA(vols, 20);
    const volRatio = vols[N - 1] / (volMA5 || 1);
    const ret60 = (C - closes[N - 61]) / closes[N - 61] * 100;
    const ret5 = (C - closes[N - 6]) / closes[N - 6] * 100;
    const drawdown = Math.max(0, (H60 - C) / H60 * 100);
    const pos60 = (C - L60) / (H60 - L60 + 1e-9);
    const longUp = ma60 >= ma130 * 0.97;
    const longDown = ma60 <= ma130 * 1.03;
    const low3 = Math.min(lows[N - 3], lows[N - 2], lows[N - 1]);
    const lowPrev5 = Math.min(...lows.slice(N - 8, N - 3));
    const stab = low3 > lowPrev5;
    const above5 = C > ma5;
    const breakMA20 = C > ma20 && vols[N - 1] > volMA20 * 1.1;

    let state = 'S5';
    const goldCross = md.dif[N - 1] > md.dea[N - 1];
    const aboveMA20 = C > ma20;
    if (longUp && aboveMA20 && (breakMA20 || goldCross)) state = 'S3';
    else if (longUp && drawdown >= 5 && drawdown <= 35 && (stab || above5 || ret5 > -2)) state = 'S2';
    else if (longDown && drawdown >= 12 && (stab || above5) && C > ma10) state = 'S4';
    else if (longUp && drawdown >= 4 && drawdown <= 40 && kl[N - 1].c >= kl[N - 1].o) state = 'S2';
    if (state === 'S5') return null;

    let dir = 0;
    if (longUp) dir += 16; else if (longDown) dir += 6; else dir += 11;
    const slope20 = (ma20 - ma20prev5) / (ma20prev5 || 1);
    if (slope20 > 0.002) dir += 10; else if (slope20 > -0.002) dir += 5; else dir += 1;
    const scoreDir = Math.min(30, dir);

    let pull = 0;
    if (state === 'S2') {
      if (drawdown >= 8 && drawdown <= 32) pull = lin(drawdown, 8, 22, 6, 18);
      else pull = 6;
      if (drawdown < 8) pull = 4;
      if (drawdown > 32) pull = 5;
    } else if (state === 'S3') {
      pull = C >= H60 * 0.97 ? 20 : 16;
    } else {
      pull = C >= H60 * 0.95 ? 18 : 12;
    }
    pull = Math.max(0, Math.min(20, pull));

    let fund = 0;
    if (volRatio >= 1.3 && volRatio <= 3.5) fund += 12; else if (volRatio > 0.8 && volRatio < 6) fund += 7; else fund += 2;
    const turn = mk.turn;
    if (turn >= 3 && turn <= 12) fund += 10; else if (turn >= 1 && turn <= 20) fund += 6; else fund += 2;
    // ★2026-10-15 体检：新浪兜底行没有主力净额（`main: null`），`Number(null)||0` ⇒ 恒走 `else fund += 1`
    //   ⇒ **同一只票在东财口径下比新浪口径高 7 分**（资金项满分 30），而 scoreCls 的 80/65/50 是绝对阈值
    //   ⇒ 降级到新浪时全页分数被系统性压低、颜色整体变差。区分"未知"与"真的是 0"：未知给中性 5。
    if (mk.mainKnown === false) fund += 5;
    else if (mk.main > 0) fund += 8;
    else fund += 1;
    const scoreFund = Math.min(30, fund);

    let safe = 0;
    if (r14 != null) { if (r14 >= 50 && r14 <= 72) safe = 8; else if (r14 >= 40 && r14 <= 80) safe = 5; else safe = 2; }
    const distHigh = (H60 - C) / H60 * 100;
    if (distHigh < 15) safe += 7; else if (distHigh < 30) safe += 4; else safe += 1;
    if (pos60 >= 0.35 && pos60 <= 0.88) safe += 5; else safe += 2;
    const scoreSafe = Math.min(20, safe);

    const total = Math.round(scoreDir + pull + scoreFund + scoreSafe);
    return { total, scoreDir, pull, scoreFund, scoreSafe };
  };
  const scoreCls = (s) => s >= 80 ? 'hi' : s >= 65 ? 'mid' : s >= 50 ? 'lo' : 'bad';
  // 对候选批量拉日K并打分，异步补到行内分数徽章
  const scoreBatch = async (rows, kind) => {
    if (!rows.length || disposed) return;
    // ★2026-10-15 体检修三处（都在这一页/超跌反弹共用的打分链路里）：
    //   ① 原来只给**前 20 只**打分，而列表有 30 只 ⇒ 第 21~30 行的徽章永远停在「…打分中…」，
    //      看着像卡住（今天实测有 10 行如此）。改成按 20 只一批**分块全打**（main.js 的批量接口上限是 24）。
    //   ② 拿不到 K 线 / K 线不足 40 根 / 形态是 S5（既没突破也没企稳）时**什么都不写** ⇒ 同样是永远转圈。
    //      现在明确写「—」并在 tooltip 里说清原因（"打分中"和"没有信号"是两回事）。
    //   ③ 主力净额缺失（新浪兜底）时把 `mainKnown=false` 传下去，别再白扣 7 分（见 analyzeB 里的说明）。
    const CH = 20;
    for (let i = 0; i < rows.length; i += CH) {
      if (disposed) return;
      const chunk = rows.slice(i, i + CH);
      const codes = chunk.map(r => r.code);
      let klMap = {}, failed = false;
      try {
        const res = await K.kline.batch(codes, 120);
        if (res && res.ok && res.data) klMap = res.data;
        else failed = true;
      } catch (e) { failed = true; }
      if (disposed) return;
      if (failed) {
        // 批量K线接口不存在（GUI 未重启加载 main.js）→ 徽章给出明确提示
        chunk.forEach(r => {
          const box = list.querySelector('.scr-score[data-code="' + r.code + '"]');
          if (box) {
            box.textContent = '重开';
            box.className = 'scr-score bad';
            box.title = '打分引擎需重启 GUI 后可用（main.js 已含批量K线接口）';
          }
        });
        return;
      }
      chunk.forEach(r => {
        const box = list.querySelector('.scr-score[data-code="' + r.code + '"]');
        const kl = klMap[r.code];
        if (!kl || kl.length < 40) {
          if (box) { box.textContent = '—'; box.className = 'scr-score bad'; box.title = 'K线不足 40 根（数据源没给到），这行不参与打分'; }
          return;
        }
        const mk = { mcap: Number(r.mcap) || 0, turn: Number(r.turn) || 0, main: Number(r.main) || 0, mainKnown: r.main != null };
        const sc = kind === 'rebound' ? analyzeA(mk, kl) : analyzeB(mk, kl);
        if (!box) return;
        if (!sc || !Number.isFinite(sc.total)) {
          box.textContent = '—';
          box.className = 'scr-score bad';
          box.title = '当前不是启动/企稳形态（S5）⇒ 只作观察，不参与排序';
          return;
        }
        box.textContent = sc.total;
        box.className = 'scr-score ' + scoreCls(sc.total);
        // ⚠两种打分函数返回的**字段名不同**（analyzeA: scoreDeep/scoreStable/scoreCat/risk；
        //   analyzeB: scoreDir/pull/scoreFund/scoreSafe）⇒ 分开拼，别混着读（混读会印出 undefined）
        box.title = kind === 'rebound'
          ? '总分 ' + sc.total + '/100　超跌深度 ' + sc.scoreDeep + '／企稳 ' + sc.scoreStable +
            '／催化 ' + sc.scoreCat + '／风控 ' + sc.risk
          : '总分 ' + sc.total + '/100　方向 ' + sc.scoreDir + '／回调 ' + sc.pull +
            '／资金 ' + sc.scoreFund + '／安全 ' + sc.scoreSafe +
            (mk.mainKnown ? '' : '　⚠数据源无主力净额，资金项按中性计');
      });
    }
  };

  // ---- 市场广度：真正有意义的情绪统计口径 ----
  // ★ 2026-09-21 修正：旧版直接用 up/(up+down+flat)，而 upList/downList 是「涨幅榜各 2 页」，
  //   两边各 120 只、去重后 240 只，up:down 恒为 120:120 → 温度恒等于 50%，
  //   "🔥偏热 / 🧊偏冷" 两个分支永远不会触发，那张卡片和那句解读等于空转。
  //   改用涨停/跌停家数 + 样本中位涨幅。
  // ★ 2026-10-14 修正（用户问"中位数涨幅是啥意思"，顺手查出**假信号**）：
  //   含义 = 「涨幅榜第 k 名」与「跌幅榜第 k 名」的中点（k = 两侧较短那侧的条数），量的是
  //     "最强的还在涨多少、最弱的跌到哪"之间的**缝**：缝宽 ⇒ 普涨/普跌（情绪极端），缝窄 ⇒ 分化。
  //   ⚠ 两侧**必须等深**才成立：深度不一样时结算点会整片滑进正区间 ⇒ 中位虚高。
  //     实测 2026-10-14：面板 11:19 报 6.49%、11:25 报 2.11%，而同一时刻按两侧各 200 只等深算是
  //     **+0.11%**（涨停 59 / 跌停 8，涨榜末名 +3.84% / 跌榜末名 −3.63%）⇒ 那两条"情绪偏热 ⇒ 减仓良机"
  //     是样本不均衡造出来的假信号。现在按 k = min(两侧) 等深结算，并在样本太浅时 ok=false（不判定）。
  const computeBreadth = () => {
    const uniq = [...new Map(upList.concat(downList).map(x => [x.code, x])).values()];
    const n = uniq.length;
    const upOnly = upList.filter(x => (Number(x.pct) || 0) > 0);     // 涨幅榜（按涨幅降序）
    const dnOnly = downList.filter(x => (Number(x.pct) || 0) < 0);   // 跌幅榜（按跌幅降序 = 涨幅升序）
    const k = Math.min(upOnly.length, dnOnly.length);                // 等深结算深度
    const ok = k >= 60;                                             // 两侧各 ≥60 只才认这个数
    if (!n) return { n: 0, ok: false, k: 0, upSide: 0, downSide: 0, limitUp: 0, limitDown: 0, median: 0, upRatio: 0, strongUp: 0, strongDown: 0 };
    const median = k ? ((Number(dnOnly[k - 1].pct) || 0) + (Number(upOnly[k - 1].pct) || 0)) / 2 : 0;
    return {
      n,
      ok,
      k,
      upSide: upOnly.length,
      downSide: dnOnly.length,
      limitUp: uniq.filter(x => (Number(x.pct) || 0) >= 9.8).length,
      limitDown: uniq.filter(x => (Number(x.pct) || 0) <= -9.8).length,
      median: median,
      upRatio: uniq.filter(x => (Number(x.pct) || 0) > 0).length / n,
      strongUp: uniq.filter(x => (Number(x.pct) || 0) >= 2).length,
      strongDown: uniq.filter(x => (Number(x.pct) || 0) <= -2).length
    };
  };

  // ---- 计算市场情绪 ----
  const computeSentiment = () => {
    const all = upList.concat(downList);
    let up = 0, down = 0, flat = 0, limitUp = 0, limitDown = 0;
    let topPct = [], bottomPct = [];
    all.forEach(s => {
      const p = Number(s.pct) || 0;
      if (p > 0) up++; else if (p < 0) down++; else flat++;
      if (p >= 9.8) limitUp++;
      if (p <= -9.8) limitDown++;
    });
    // 去重（涨幅榜/跌幅榜可能有交集）
    const seen = new Set(); const uniq = [];
    all.forEach(s => { if (!seen.has(s.code)) { seen.add(s.code); uniq.push(s); } });
    const sorted = uniq.slice().sort((a, b) => (Number(b.pct) || 0) - (Number(a.pct) || 0));
    topPct = sorted.slice(0, 5);
    bottomPct = sorted.slice(-5).reverse();
    const total = up + down + flat;
    return { up, down, flat, total, limitUp, limitDown, topPct, bottomPct, breadth: computeBreadth() };
  };

  // ---- 超跌反弹：全市场 60 日跌幅榜（按 f24 升序）中筛选企稳 ----
  const computeRebound = () => {
    // ★ 2026-09-21 修正：旧版在 downList（按"今日涨跌幅"排的跌幅榜）里按 r60 排序，
    //   而 r60 当时取的是东财 f22（多数标的恒为 0）再乘 100 → 所谓"60日-11%"实为 -0.11%，
    //   全市场 60 日跌幅实际只有 1% 上下，引擎等于在挑"今天跌得多的票"，不是超跌票。
    //   现改为消费 r60List（后端按 f24 真实 60 日涨跌幅升序扫描）。
    return r60List
      .filter(s => !noBuy(s.code))                     // 创业板/科创板：买不了，只当板块参考
      .filter(s => (Number(s.r60) || 0) <= -15)        // 真·超跌：60 日跌逾 15%
      .filter(s => (Number(s.r60) || 0) >= -75)        // 跌逾 75% 多为退市/重大违规，不是技术性超跌
      .filter(s => (Number(s.pct) || 0) > -3)          // 今日未继续大跌（企稳）
      .filter(s => (Number(s.pct) !== 0) || (Number(s.turn) > 0))   // 停牌守卫：今日无成交不算"企稳"
      .filter(s => (Number(s.mcap) || 0) > 8e8)        // 剔除 8 亿以下微盘（波动失真）
      .filter(s => !isST(s) && !isIPO(s))              // 剔除 ST/退市风险/上市首日
      // ★2026-10-15 回测修正排序方向（池＝榜单强势股 59 个交易日 · 次日开盘进场 · 5日内 +8%止盈/-5%止损）：
      //   升序（跌最深在前）止盈 34.1% / 单笔期望 +1.50%；原来的降序（跌最浅在前）只有 25.4% / +0.83%
      //   ⇒ 原注释写的是"跌最深在前"，代码却排成了"最浅在前"，这条 bug 让页面几乎白给一半胜率。
      .sort((a, b) => (Number(a.r60) || 0) - (Number(b.r60) || 0))  // 跌最深在前（r60 为负，越小越深）
      .slice(0, 30);
  };

  // ---- 波段启动：预选池 + 特征（★2026-10-15 口径重做，有回测依据）----
  // 回测（池＝236 只主板强势股｜2026-07-03~10-08 共 59 个交易日｜次日开盘进场｜5 日内 +8% 止盈 / −5% 止损｜同日先判止损）：
  //   旧口径（按今日涨幅降序取前 30）：止盈 32.9% / 止损 39.8% / 单笔期望 +0.94%
  //   新口径（60 日位置<50% 且 距 MA20 ≤5%，按"位置最低"排序）：止盈 **41.8%** / 止损 **23.9%** / 期望 **+2.78%**
  //   另测：单纯"上升结构（>MA20 且 MA5>MA10）"反而更差（5 日胜率 35.7% vs 基线 43.6%）⇒ **别把"趋势突破"当买点**；
  //        低位（60日位置<29.7%）59.8%、远离 20 日高（<-10%）55.4%、缩量（量比<1）49.9% 都优于基线。
  //   ⚠ 池子是"当天涨过 2% 的强势股"，属偏乐观样本 ⇒ **能用的是口径之间的相对差**，不是绝对值；未计手续费/滑点。
  //   数据：`<临时目录>
  const BR = { POOL: 60, SHOW: 30, POS_MAX: 50, MA20_MIN: -8, MA20_MAX: 5, TP: 8, SL: -5 };
  // 预选池：只用榜单字段（宽松），目的是把"今天在涨、且买得进"的票捞出来，真正的取舍交给 K 线特征
  const brPoolList = () => upList
    .filter(s => !noBuy(s.code))                     // 创业板/科创板/北交所：买不了，只当板块参考
    .filter(s => (Number(s.pct) || 0) >= 2 && !s.atLimit)   // 今日在涨、且没封死（封板买不进，开板即接盘）
    .filter(s => (Number(s.mcap) || 0) > 0)          // 排除退市/停牌
    .filter(s => !isST(s) && !isIPO(s))              // 剔除 ST/退市风险 + 上市首日
    .sort((a, b) => (Number(b.pct) || 0) - (Number(a.pct) || 0))
    .slice(0, BR.POOL);
  // 单只特征（K线不足 60 根返回 null）：60 日位置 / 距 MA20 / 量比
  const brFeature = (rawKl, price) => {
    const kl = toKL(rawKl);
    const N = kl.length;
    if (N < 60) return null;
    const closes = kl.map(k => k.c), highs = kl.map(k => k.h), lows = kl.map(k => k.l), vols = kl.map(k => k.v);
    const C = Number(price) || closes[N - 1];
    const h60 = Math.max.apply(null, highs.slice(-60)), l60 = Math.min.apply(null, lows.slice(-60));
    const ma5 = SMA(closes, 5), ma10 = SMA(closes, 10), ma20 = SMA(closes, 20);
    const vma5 = SMA(vols.slice(0, -1), 5);
    return {
      pos60: (C - l60) / (h60 - l60 + 1e-9) * 100,
      distMA20: ma20 ? (C / ma20 - 1) * 100 : 999,
      ma5, ma10, ma20,
      vr: vma5 ? vols[N - 1] / vma5 : 0,
      raw: rawKl,
    };
  };

  // ========================================================================
  // 🔔 提示：本地规则盯盘（2026-09-29 用户要求）
  // 定位：**纯本地程序，全程不调用 AI ⇒ 不消耗任何 token**。
  //   - 规则存 memories 表（scenario=stock, kind=alert_rules）⇒ AI 每天开盘前改那一行 JSON 就能换阈值，
  //     面板不用改代码、不用重启（重新打开提示页即读到）；
  //   - 面板每 20 秒用腾讯行情自检一次（带买卖五档 ⇒ 能读**封单**做炸板预警），命中写「提醒」并给页签打徽标；
  //   - 休市（含午休）不发请求，只刷新状态行。
  // ⚠ 定时器建在渲染器函数体内、由末尾 `return () => {…}` 清掉（check-gui 第 4 项按行区间校验）。
  // ========================================================================
  const ALERT_LOG_KEY = 'screen_alert_log_v1';
  const ALERT_STATE_KEY = 'screen_alert_state_v1';
  let alertRules = null;      // 规则数组（来自记忆表；为空则用预设）
  let alertMemId = null;      // 记忆表行 id（回写用）
  let alertQuotes = {};       // 最近一次监控行情（key = 腾讯符号，如 sz000823）
  let alertState = {};        // 规则上升沿状态（避免同一条件反复提醒）
  let alertLog = [];          // 已触发记录（新在前，留 60 条）
  const alertDraft = {};      // 添加规则表单草稿：20 秒重画一次也不丢输入（2026-10-13 加）
  let alertAt = 0;            // 最近一次检查时间
  let alertRulesAt = 0;       // ★2026-10-16：最近一次“重读规则表”的时间（休市降到 5 分钟一次）
  let alertNew = 0;           // 未读命中数（页签徽标）
  let alertTimer = null;      // 20 秒自检定时器

  // 与 main.js 的 conv() 完全对齐：用户写的代码 → 腾讯返回的 key
  const alertKey = (code) => {
    const c = String(code || '').trim().toUpperCase();
    if (c.endsWith('.SH')) return 'sh' + c.slice(0, -3);
    if (c.endsWith('.SZ')) return 'sz' + c.slice(0, -3);
    if (/^\d+$/.test(c)) return ('569'.indexOf(c.charAt(0)) >= 0 ? 'sh' : 'sz') + c;
    if (c.startsWith('US')) return 'us' + c.slice(2);
    if (c.startsWith('HK')) return 'hk' + c.slice(2);
    if (c.startsWith('SH') || c.startsWith('SZ')) return c.toLowerCase();
    return 'us' + c;
  };
  const R = (code, name, t, op, v, tag, note) => ({ code, name, t, op, v, tag, note, on: true });
  // 预设规则（2026-10-15 收盘调仓后持仓：汉缆股份 002498 1200 股 @5.798、协和电子 605258 300 股 @40.921、传艺科技 002866 200 股 @15.533；沃格光电 603773 已清仓）
  // ⚠ 这里只是"记忆里没有规则时"的种子；真正生效的口径在记忆 id=6（`scripts\提示规则.mjs --set/--add/--del`）。改持仓时两处一起改。
  const ALERT_DEFAULTS = [
    R('002866', '传艺科技', 'p', 'gte', 17.38, '持仓', '200股：反弹到 MA5 17.38（头上第一压力；MA10 16.60 刚丢）⇒ 先减 100，只留 100 看 18.6'),
    R('002866', '传艺科技', 'p', 'gte', 18.60, '持仓', '200股：到前高密集区 18.32~18.59 ⇒ 剩下 100 全清（上方 19.15 / 20.45）'),
    R('002866', '传艺科技', 'p', 'lte', 15.50, '持仓', '★200股：破 MA20 15.505 + 成本 15.533 双关 ⇒ 全清（13.68 起的反弹结构走坏，纪律 #15）'),
    R('605258', '协和电子', 'p', 'gte', 43.92, '持仓', '300股：到 10-15 高点 43.92 ⇒ 先减 150 落袋（成本 40.921，+7.3%）'),
    R('605258', '协和电子', 'p', 'gte', 45.77, '持仓', '★300股：到前高 45.77 ⇒ 剩下 150 全清（放量站稳才改看新高）'),
    R('605258', '协和电子', 'p', 'lte', 39.85, '持仓', '300股：破 MA5 39.85／MA10 40.25 一带 ⇒ 先减 150（10-15 低 39.59 是当日支撑）'),
    R('605258', '协和电子', 'p', 'lte', 38.90, '持仓', '★300股：破 MA20 38.913 ⇒ 全部清掉'),
    R('002498', '汉缆股份', 'p', 'gte', 6.11, '持仓', '1200股：反弹到 MA5 6.108／MA10 6.123 一带 ⇒ 先减 600（成本 5.798，均线全在头上）'),
    R('002498', '汉缆股份', 'p', 'gte', 6.37, '持仓', '1200股：到 MA20 6.372 ⇒ 再减 600 清光（上方 20 日高 7.15 / 60 日高 7.57）'),
    R('002498', '汉缆股份', 'p', 'lte', 5.60, '持仓', '★1200股：跌破 10-15 低 5.64（＝20 日最低）⇒ 全清止损，别摊平（纪律 #15、#16）'),
    R('*', '全市场中位涨幅', 'b', 'lte', -1.0, '大盘', '市场转冷（中位跌幅逾 1%）⇒ 禁止开新仓'),
    R('*', '全市场中位涨幅', 'b', 'gte', 1.0, '大盘', '情绪偏热（中位涨幅逾 1%）⇒ 注意追高风险'),
    R('*', '机会票扫描（波段启动）', 'opp', 'gte', 0, '机会', '拉涨即机会：涨幅 >0 全进池；弹窗只推 A 涨停/触板、B 急拉≥5%（双创/北交所已屏蔽）'),
    R('*', '机会票扫描（超跌企稳）', 'reb', 'gte', 0, '机会', '60 日跌 ≥40% ∧ 今日 >−3% ∧ 市值 >8 亿 ∧ 非 ST')
  ];
  const alertTypeLabel = (r) => {
    const opTxt = r.op === 'gte' ? '≥' : '≤';
    if (r.t === 'p') return '现价 ' + opTxt + ' ' + fmt(r.v);
    if (r.t === 'pct') return '当日涨幅 ' + opTxt + ' ' + fmt(r.v) + '%';
    if (r.t === 'turn') return '换手率 ' + opTxt + ' ' + fmt(r.v) + '%';
    if (r.t === 'seal') return '封单 ' + opTxt + ' ' + fmt(r.v / 1e4, 1) + ' 万手';
    if (r.t === 'b') return '中位涨幅 ' + opTxt + ' ' + fmt(r.v) + '%';    if (r.t === 'opp') return '自动扫描（波段启动口径）';
    if (r.t === 'reb') return '自动扫描（超跌企稳口径）';
    return '—';
  };
  const alertSealed = (q) => { const a0 = q && q.ask && q.ask[0]; return !!(a0 && Number(a0[0]) === 0); };
  // 命中值的人话（2026-10-14 修：'b' 类原来一律印成「现价 2.36000000000000003」——标签错 + 浮点毛刺）
  const alertValTxt = (r, cur) => {
    if (cur == null) return '';
    if (r.t === 'b') return '中位 ' + fmt(cur) + '%';
    if (r.t === 'p') return '现价 ' + fmt(cur);
    if (r.t === 'pct') return '当日涨幅 ' + fmt(cur) + '%';
    if (r.t === 'turn') return '换手 ' + fmt(cur) + '%';
    if (r.t === 'seal') return '封单 ' + fmt(cur / 1e4, 1) + ' 万手';
    if (r.t === 'opp' || r.t === 'reb') return cur + ' 只';
    return String(cur);
  };
  const alertOpps = (t) => {
    if (t === 'reb') {
      return (r60List || [])
        .filter(s => (Number(s.r60) || 0) <= -40)
        .filter(s => (Number(s.pct) || 0) > -3)
        .filter(s => (Number(s.mcap) || 0) > 8e8)
        .filter(s => !isST(s) && !isIPO(s))
        .sort((a, b) => (Number(a.r60) || 0) - (Number(b.r60) || 0))
        .slice(0, 6);
    }
    return (upList || [])
      .filter(s => (Number(s.pct) || 0) >= 2 && (Number(s.pct) || 0) <= 7)
      .filter(s => !s.atLimit)
      .filter(s => (Number(s.turn) || 0) >= 5)
      .filter(s => (Number(s.mcap) || 0) >= 20e8 && (Number(s.mcap) || 0) <= 200e8)
      .filter(s => !isST(s) && !isIPO(s))
      .sort((a, b) => (Number(b.turn) || 0) - (Number(a.turn) || 0))
      .slice(0, 6);
  };
  const alertCurTxt = (r) => {
    if (r.t === 'b') {
      const bd = computeBreadth();
      return '中位 ' + fmt(bd.median) + '%' + (bd.ok ? '（第' + bd.k + '名中点）' : ' ⚠样本仅 ' + bd.k + ' 对，暂不判定');
    }
    if (r.t === 'opp' || r.t === 'reb') return alertOpps(r.t).length + ' 只';
    const q = alertQuotes[alertKey(r.code)];
    if (!q) return '--';
    if (r.t === 'p') return fmt(q.price);
    if (r.t === 'pct') return fmt(q.pct) + '%';
    if (r.t === 'turn') return fmt(q.turn) + '%';
    if (r.t === 'seal') return alertSealed(q) ? fmt(Number((q.bid && q.bid[0] && q.bid[0][1]) || 0) / 1e4, 1) + ' 万手' : '未封板';
    return '--';
  };
  const alertSaveLog = () => { try { localStorage.setItem(ALERT_LOG_KEY, JSON.stringify(alertLog.slice(0, 60))); } catch (e) { /* ignore */ } };
  const alertSaveState = () => { try { localStorage.setItem(ALERT_STATE_KEY, JSON.stringify(alertState)); } catch (e) { /* ignore */ } };
  const alertWrite = async () => {
    try {
      const content = JSON.stringify(alertRules);
      if (alertMemId) await K.mem.update(alertMemId, { kind: 'alert_rules', title: '盯盘提示规则', content, tags: 'alert,提示' });
      else alertMemId = await K.mem.add({ kind: 'alert_rules', title: '盯盘提示规则', content, tags: 'alert,提示' });
    } catch (e) { /* 存不下不影响盯盘 */ }
  };
  const alertLoadRules = async () => {
    let rules = null, id = null;
    try {
      const rows = await K.mem.list('alert_rules');
      // ★2026-10-15：原来只认 `rows[0]`，而且 JSON 一坏就退回预设 + 清空 alertMemId
      //   ⇒ 此时用户点一下开关，alertWrite 会**新加一行**，记忆里就出现两行 alert_rules，之后取哪行看 id 顺序。
      //   现在：挑**第一行能解析出非空数组**的（坏行跳过），并记住它的 id 继续回写那一行。
      const cand = (rows || []).filter(r => r && r.content);
      for (const r of cand) {
        try {
          const p = JSON.parse(r.content);
          if (Array.isArray(p) && p.length) { rules = p; id = r.id; break; }
        } catch (e) { /* 这一行坏了，试下一行 */ }
      }
    } catch (e) { /* 读不到就用预设 */ }
    if (rules) alertRules = rules;
    else { alertRules = ALERT_DEFAULTS.map(x => Object.assign({}, x)); alertMemId = null; }
    if (id) alertMemId = id;
    if (!id) alertWrite();   // 首次：把预设写进记忆表，方便 AI 之后直接改
  };
  const alertLoadLog = () => {
    try {
      const p = JSON.parse(localStorage.getItem(ALERT_LOG_KEY) || '[]');
      if (Array.isArray(p)) alertLog = p;
      const s = JSON.parse(localStorage.getItem(ALERT_STATE_KEY) || '{}');
      if (s && typeof s === 'object') alertState = s;
    } catch (e) { alertLog = []; alertState = {}; }
  };
  const syncAlertBadge = () => {
    const b = modeBtns.alert;
    if (!b) return;
    b.textContent = alertNew > 0 ? '🛰️ 雷达提示 ' + alertNew : '🛰️ 雷达提示';
    b.classList.toggle('hit', alertNew > 0);
  };
  // ---- 置顶"最新命中"横幅（2026-10-14）----
  // 规则命中原先只落进页面最底部的「命中日志」，要往下翻才看得到；雷达命中也被埋在雷达块里。
  // 现在两边都往这一行推，且 sticky 在页面最上方 —— 盯盘时永远第一眼看到。
  let alertBarEl = null, alertBarLast = null;
  const paintAlertBar = () => {
    if (!alertBarEl) return;
    const d = alertBarLast;
    alertBarEl.innerHTML = '';
    if (!d) {
      alertBarEl.className = 'rd-alertbar empty';
      alertBarEl.appendChild(el('span', 't', '🛰️ 盯盘就绪：持仓到价 / 急拉急跌 / 涨停潮 / 板块联动 / 机会票，命中就弹在这一行'));
      return;
    }
    alertBarEl.className = 'rd-alertbar ' + (d.kind || 'info');
    alertBarEl.appendChild(el('span', 't', '[' + d.t + '] ' + (d.tag || '')));
    alertBarEl.appendChild(el('span', 'm', (d.title ? d.title + '　' : '') + (d.text || '')));
    if (alertLog.length) alertBarEl.appendChild(el('span', 'n', '规则命中 ' + alertLog.length + ' 条 ↓'));
    else alertBarEl.appendChild(el('span', 'n', '↓ 规则日志'));
  };
  const alertBarShow = (kind, tag, title, text, ts) => {
    const d = new Date(ts || Date.now());
    const p = (n) => (n < 10 ? '0' + n : '' + n);
    alertBarLast = { kind: kind, tag: tag, title: title, text: text,
      t: p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) };
    paintAlertBar();
  };
  const alertPush = (r, cur) => {
    alertLog.unshift({ ts: Date.now(), code: r.code, name: r.name || r.code, text: r.note || alertTypeLabel(r), cur: cur });
    if (alertLog.length > 60) alertLog.length = 60;
    alertNew++;
    alertSaveLog();
    syncAlertBadge();
    // 同步推到置顶横幅：跌破/止损类算风险（红），到价减仓算机会（绿）
    alertBarShow(r.op === 'lte' ? 'risk' : 'opp', '🔔 规则 · ' + (r.name || r.code),
      r.note || alertTypeLabel(r), alertValTxt(r, cur));
  };
  // 北京时间（不依赖本机时区）：工作日 09:15-11:35 / 12:55-15:05 才拉行情
  const alertBj = () => { const d = new Date(Date.now() + 8 * 3600e3); return { dow: d.getUTCDay(), hm: d.getUTCHours() * 100 + d.getUTCMinutes() }; };
  const isTradingTime = () => {
    const t = alertBj();
    if (t.dow === 0 || t.dow === 6) return false;
    return (t.hm >= 915 && t.hm <= 1135) || (t.hm >= 1255 && t.hm <= 1505);
  };
  const alertCheck = async (evaluate) => {
    if (disposed || !alertRules) return;
    const codes = [];
    alertRules.forEach(r => {
      if (r.on === false || !r.code || r.code === '*') return;
      if (['p', 'pct', 'seal', 'turn'].indexOf(r.t) < 0) return;
      if (codes.indexOf(r.code) < 0) codes.push(r.code);
    });
    if (codes.length) {
      try {
        const res = await K.quote.realtime(codes);
        Object.keys((res && res.quotes) || {}).forEach(k => { alertQuotes[k] = res.quotes[k]; });
      } catch (e) { /* 网络抖动：保留上一次值，宁可漏报也不误报 */ }
    }
    alertAt = Date.now();
    // evaluate === false：只取数（显示"当前值"），**不判定** —— 休市时拿收盘价判"封单不足"会误报"炸板"
    if (evaluate === false) {
      if (tab === 'alert') renderAlert(); else syncAlertBadge();
      return;
    }
    alertRules.forEach(r => {
      if (r.on === false || r.t === 'opp' || r.t === 'reb') return;
      const key = r.code + '|' + r.t + '|' + r.op + '|' + r.v;
      let cur = null;
      if (r.t === 'b') {
        // 样本太浅（两侧取不到各 60 只）⇒ **不判定**，宁可漏报也不拿残缺样本报"情绪偏热"骗人减仓
        const bd = computeBreadth();
        if (!bd.ok) return;
        cur = bd.median;
      } else {
        const q = alertQuotes[alertKey(r.code)];
        if (!q) return;
        if (r.t === 'p') cur = Number(q.price);
        else if (r.t === 'pct') cur = Number(q.pct);
        else if (r.t === 'turn') cur = Number(q.turn);
        else if (r.t === 'seal') cur = alertSealed(q) ? Number((q.bid && q.bid[0] && q.bid[0][1]) || 0) : 0;
      }
      if (cur == null || isNaN(cur)) return;
      const fire = r.op === 'gte' ? cur >= r.v : cur <= r.v;
      if (fire && !alertState[key]) { alertState[key] = true; alertPush(r, cur); }
      else if (!fire && alertState[key]) alertState[key] = false;   // 条件解除 ⇒ 允许下次再报
    });
    alertSaveState();
    if (tab === 'alert') renderAlert(); else syncAlertBadge();
  };
  const alertTick = async () => {
    if (disposed) return;
    // ★2026-10-16（用户："非开盘的时间没必要一直刷新"）：休市时**不再每 20 秒读规则表 + 重画页面**——
    //   那只是本地 sqlite 读 + 整块 DOM 重建，对"固定分析面板"没有任何意义。改成 5 分钟一次（仍能及时
    //   反映 AI 在会话侧改的规则），其余时间直接返回、一次 DOM 都不碰。
    if (!isTradingTime()) {
      if (Date.now() - alertRulesAt < 300000) return;
      alertRulesAt = Date.now();
      await alertLoadRules();
      if (disposed) return;
      if (tab === 'alert') renderAlert();
      return;
    }
    // 盘中：每轮重读规则表（AI 改了记忆里那行 JSON ⇒ 20 秒内自动生效），然后判定
    await alertLoadRules();
    if (disposed) return;
    alertRulesAt = Date.now();
    alertCheck();
  };
  const renderAlert = () => {
    if (disposed) return;
    // 合并页里 list 指向"提示区"（alertHostRef）：雷达块在同一页上方，这里清场不会碰它
    const list = alertHostRef;
    // ⚠ 必须整体重画：清空提醒 / 停用 / ✕ / ＋添加 / 每 20 秒自检 都直接调这里；
    //    不清空就会把整页再叠一份（旧内容留在上面 ⇒ 看起来"点了没反应"）。2026-10-13 修。
    list.innerHTML = '';
    if (alertNew) { alertNew = 0; syncAlertBadge(); }
    const trading = isTradingTime();
    const head = el('div', 'scr-alert-head');
    head.appendChild(el('span', 'scr-alert-dot' + (trading ? ' on' : ''), trading ? '🟢 盯盘中' : '⚪ 休市'));
    head.appendChild(el('span', 'scr-meta-item', '最近检查 ' + (alertAt ? new Date(alertAt).toLocaleTimeString('zh-CN', { hour12: false }) : '--')));
    head.appendChild(el('span', 'scr-meta-item', '监控 ' + ((alertRules || []).filter(r => r.on !== false && r.code !== '*' && r.t !== 'b').length) + ' 只'));
    const bd = computeBreadth();
    if (bd.n) head.appendChild(el('span', 'scr-meta-item', '中位涨幅 ' + fmt(bd.median) + '%'));
    head.appendChild(el('span', 'scr-meta-item', '命中 ' + alertLog.length + ' 条'));
    list.appendChild(head);

    // ---- 命中提醒（新在前）----
    if (alertLog.length) {
      const box = el('div', 'scr-alert-log');
      alertLog.slice(0, 12).forEach(h => {
        const item = el('div', 'scr-alert-hit');
        item.appendChild(el('span', 'scr-alert-hit-time', new Date(h.ts).toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5)));
        item.appendChild(el('span', 'scr-alert-hit-name', h.name));
        item.appendChild(el('span', 'scr-alert-hit-cur', fmt(h.cur)));
        item.appendChild(el('span', 'scr-alert-hit-text', h.text));
        if (h.code && h.code !== '*') {
          item.classList.add('scr-sel');
          item.addEventListener('click', () => window.dispatchEvent(new CustomEvent('stockSelect', { detail: { code: h.code, name: h.name } })));
        }
        box.appendChild(item);
      });
      const clr = el('button', 'scr-rule-btn', '清空提醒');
      clr.addEventListener('click', () => { alertLog = []; alertSaveLog(); renderAlert(); });
      box.appendChild(clr);
      list.appendChild(box);
    } else {
      list.appendChild(el('div', 'scr-empty', '暂无命中。规则见下方，程序每 20 秒自检一次（休市不发请求）。'));
    }

    // ---- 机会票（复用两个引擎的口径，不是新算法）----
    const opps = alertOpps('opp'), rebs = alertOpps('reb');
    if (opps.length || rebs.length) {
      list.appendChild(el('div', 'scr-sec-title', '🎯 机会票（实时扫描）'));
      if (opps.length) {
        list.appendChild(el('div', 'scr-alert-sub', '波段启动候选 · ' + alertTypeLabel({ t: 'opp' })));
        const box = el('div', 'scr-list-inner');
        opps.forEach(s => box.appendChild(rowHtml(s, '换手 ' + fmt(s.turn) + '%', '市值 ' + fmt((Number(s.mcap) || 0) / 1e8, 1) + ' 亿')));
        list.appendChild(box);
      }
      if (rebs.length) {
        list.appendChild(el('div', 'scr-alert-sub', '超跌企稳候选 · ' + alertTypeLabel({ t: 'reb' })));
        const box2 = el('div', 'scr-list-inner');
        rebs.forEach(s => box2.appendChild(rowHtml(s, '60日 ' + fmt(s.r60) + '%', '市值 ' + fmt((Number(s.mcap) || 0) / 1e8, 1) + ' 亿')));
        list.appendChild(box2);
      }
    }

    // ---- 规则表 ----
    list.appendChild(el('div', 'scr-sec-title', '⚙️ 监控规则（' + ((alertRules || []).length) + ' 条）'));
    const order = { '持仓': 0, '大盘': 1, '机会': 2 };
    const rulesBox = el('div', 'scr-rules');
    const sorted = (alertRules || []).slice().sort((a, c) => ((order[a.tag] == null ? 9 : order[a.tag]) - (order[c.tag] == null ? 9 : order[c.tag])));
    sorted.forEach(r => {
      const row = el('div', 'scr-rule' + (r.on === false ? ' off' : ''));
      row.appendChild(el('span', 'scr-rule-code', r.code === '*' ? '扫描' : r.code));
      row.appendChild(el('span', 'scr-rule-name', r.name || ''));
      row.appendChild(el('span', 'scr-rule-cond', alertTypeLabel(r)));
      row.appendChild(el('span', 'scr-rule-val', alertCurTxt(r)));
      row.appendChild(el('span', 'scr-rule-tag', r.tag || ''));
      const tg = el('button', 'scr-rule-btn', r.on === false ? '启用' : '停用');
      tg.addEventListener('click', () => { r.on = (r.on === false); alertWrite(); renderAlert(); });
      row.appendChild(tg);
      const del = el('button', 'scr-rule-btn', '✕');
      del.addEventListener('click', () => { const i = alertRules.indexOf(r); if (i >= 0) alertRules.splice(i, 1); alertWrite(); renderAlert(); });
      row.appendChild(del);
      rulesBox.appendChild(row);
    });
    list.appendChild(rulesBox);

    // ---- 添加规则 ----
    const form = el('div', 'scr-rule-add');
    const iCode = el('input', 'scr-inp'); iCode.placeholder = '代码 600519'; iCode.value = alertDraft.code || '';
    iCode.addEventListener('input', () => { alertDraft.code = iCode.value; });
    const iName = el('input', 'scr-inp'); iName.placeholder = '名称（可空）'; iName.value = alertDraft.name || '';
    iName.addEventListener('input', () => { alertDraft.name = iName.value; });
    const iType = el('select', 'scr-inp');
    [['p', '价格'], ['pct', '涨幅%'], ['turn', '换手%']].forEach(p => { const o = el('option', '', p[1]); o.value = p[0]; iType.appendChild(o); });
    const iOp = el('select', 'scr-inp');
    [['gte', '≥ 涨到/超过'], ['lte', '≤ 跌到/低于']].forEach(p => { const o = el('option', '', p[1]); o.value = p[0]; iOp.appendChild(o); });
    const iVal = el('input', 'scr-inp'); iVal.placeholder = '阈值'; iVal.value = alertDraft.val || '';
    iVal.addEventListener('input', () => { alertDraft.val = iVal.value; });
    const iNote = el('input', 'scr-inp scr-inp-wide'); iNote.placeholder = '提醒语（可空）'; iNote.value = alertDraft.note || '';
    iNote.addEventListener('input', () => { alertDraft.note = iNote.value; });
    const addBtn = el('button', 'scr-rule-btn primary', '＋ 添加');
    addBtn.addEventListener('click', () => {
      const code = String(iCode.value || '').trim();
      const v = Number(iVal.value);
      if (!code || !isFinite(v)) { try { iCode.focus(); } catch (e) { /* ignore */ } return; }
      alertRules.push({
        code, name: String(iName.value || '').trim() || code, t: iType.value, op: iOp.value, v,
        tag: '自定', note: String(iNote.value || '').trim() || ('到价提醒：' + alertTypeLabel({ t: iType.value, op: iOp.value, v })), on: true
      });
      alertWrite();
      alertDraft.code = ''; alertDraft.name = ''; alertDraft.val = ''; alertDraft.note = '';
      renderAlert();
      alertCheck(isTradingTime());
    });
    [iCode, iName, iType, iOp, iVal, iNote, addBtn].forEach(x => form.appendChild(x));
    list.appendChild(form);
    list.appendChild(el('div', 'scr-alert-note',
      '纯本地程序：每 20 秒用腾讯行情自检一次，不调用 AI、不消耗 token。规则存在记忆表 kind=alert_rules ⇒ AI 每天开盘前可直接改阈值。'));
  };

  // ---- 渲染 ----
  // 页签级资源：雷达的定时器只在「🛰️ 雷达」页签可见时跑，切走立刻停（否则每切一次就攒一批轮询器）
  let radarStop = null;
  const stopRadar = () => { if (radarStop) { try { radarStop(); } catch (e) { /* ignore */ } radarStop = null; } };
  const renderRadar = () => { stopRadar(); radarStop = makeRadar(list); };
  // 「提示」页（2026-10-14 起＝雷达 + 提示合并页）：
  //   rz 雷达块：一次建好常驻（状态条/大卡片/持仓格/板块/事件流，自带 1.5s·3s·4s 轮询）
  //   az 提示区：规则编辑器 + 命中日志，每 20 秒只重画这一块
  const renderAlertMerged = () => {
    // 置顶横幅（sticky）：点它跳到底部命中日志
    const bar = el('div', 'rd-alertbar empty');
    alertBarEl = bar;
    bar.addEventListener('click', () => {
      const lg = (alertHostRef || list).querySelector('.scr-alert-log');
      if (lg && lg.scrollIntoView) { try { lg.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) { /* ignore */ } }
    });
    list.appendChild(bar);
    const rz = el('div', 'rd-zone');
    const az = el('div', 'scr-alert-zone');
    list.appendChild(rz);
    list.appendChild(az);
    alertHostRef = az;
    stopRadar();
    radarStop = makeRadar(rz);
    if (radarStop && radarStop.setBridge) {
      radarStop.setBridge((ev) => alertBarShow(ev.kind, '🛰️ 雷达 · ' + (ev.tag || ''), ev.title, ev.text, ev.ts));
    }
    paintAlertBar();
    renderAlert();
  };
  const render = () => {
    if (disposed) return;
    stopRadar();
    stopOppPage();
    list.innerHTML = '';
    if (tab === 'alert') renderAlertMerged();
    else if (tab === 'opp') renderOpp();
    else if (tab === 'sentiment') renderSentiment();
    else if (tab === 'rebound') renderRebound();
    else if (tab === 'radar') renderRadar();
    else renderBreakout();
    // ★2026-10-15：切到"数据页"时顺手补一次数（盘中过期 60 秒就重扫；休市只补"不是今天的"）
    if (tab === 'sentiment' || tab === 'rebound' || tab === 'breakout') ensureFresh();
  };

  const rowHtml = (s, extra, extra2, scored) => {
    const row = el('div', 'scr-row');
    // 第一行：代码 + 名称 + 今日涨跌幅
    const top = el('div', 'scr-row-top');
    top.appendChild(el('span', 'scr-code', s.code));
    top.appendChild(el('span', 'scr-name', s.name || s.code));
    const pct = Number(s.pct) || 0;
    const pctEl = el('span', 'scr-pct', (pct >= 0 ? '+' : '') + fmt(pct) + '%');
    pctEl.style.color = mkColor(pct);
    top.appendChild(pctEl);
    // 打分徽章（占位，异步打分完成后填充）
    if (scored) {
      const box = el('span', 'scr-score');
      box.dataset.code = s.code;
      box.textContent = '…';
      box.title = '打分中…';
      top.appendChild(box);
    }
    row.appendChild(top);
    // 第二行：现价 + 附加指标（换手/60日/市值等）
    const meta = el('div', 'scr-row-meta');
    meta.appendChild(el('span', 'scr-meta-item', '现价 ' + fmt(s.price)));
    if (extra) meta.appendChild(el('span', 'scr-meta-item', extra));
    if (extra2) meta.appendChild(el('span', 'scr-meta-item', extra2));
    row.appendChild(meta);
    // 点击联动 K线图
    row.classList.add('scr-sel');
    row.title = '点击查看 ' + (s.name || s.code) + ' 的 K线分析';
    row.addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('stockSelect', {
        detail: { code: s.code, name: s.name || s.code }
      }));
    });
    return row;
  };

  // ============ 🚀 机会池：单开一页（2026-10-14 二次修正）============
  // 用户原话：「我的意思是机会会放在情绪左边单开一页不是和情绪同步」
  // ⇒ ① 不再塞进「情绪」页签里当左栏（情绪页签回归单栏）；② 页签排在「情绪」**左边**；
  //    ③ **本页自己轮询榜单**，不依赖雷达页签是否开着 —— 切页签时 render() 会 stopRadar()，
  //       雷达的池子当场冻住，靠它同步会看到一潭死水。
  // 口径与雷达池子完全一致：拉涨即机会（pct>0 全进）、屏蔽创业板/科创板/北交所、按强度 A/B/C/D 分档。
  let oppPageTimer = null, oppPageSort = 'score', oppPageAt = 0, oppPageSrc = '', oppPageErr = '';
  try { oppPageSort = localStorage.getItem('scr_opp_sort') || 'score'; } catch (e) { /* ignore */ }
  const stopOppPage = () => { if (oppPageTimer) { clearInterval(oppPageTimer); oppPageTimer = null; } };
  const oppClock = (ts) => {
    if (!ts) return '--';
    const d = new Date(ts), p = (n) => (n < 10 ? '0' + n : '' + n);
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  };
  const pollOppPage = async () => {
    if (disposed) return;
    // ★2026-10-15：休市不再每 8 秒拉（用户要求"不开盘＝固定面板"）。收盘后第一次照拉（拿收盘口径），
    //   之后 10 分钟内直接跳过 ⇒ 整晚最多几次请求，而不是几千次。
    if (!isTradingTime() && oppPageAt && Date.now() - oppPageAt < 10 * 60e3) return;
    try {
      let rows = [], src = '';
      const r = await K.market.rank({ type: 'up', pages: 2, sort: 'pct' });
      if (disposed) return;
      rows = (r && r.list) || [];
      src = (r && r.fromCache) ? '缓存' : '东财';
      if (!rows.length || (r && r.fromCache)) {
        const frk = await mkPyRun(['--rank', 'up', '--pages', '2']);   // 东财拿不到 ⇒ 新浪兜底（与雷达同一策略）
        if (disposed) return;
        if (frk && frk.ok && frk.list && frk.list.length) { rows = frk.list; src = frk.src === 'sina' ? '新浪' : '东财'; }
      }
      if (!rows.length) { oppPageErr = '榜单暂无数据（东财/新浪都没回）'; if (tab === 'opp') paintOppPage(false); return; }
      oppPageErr = '';
      const pool = {};
      rows.forEach((x) => {
        const code = mkC6(x.code);
        const pct = Number(x.pct) || 0;
        if (!code || !(pct > 0)) return;      // 拉涨即机会：>0 全进池，一只不漏
        if (noBuy(code)) return;              // 双创/北交所买不了：只作板块参考，不进机会
        const prev = MK_OPP_SNAP.pool[code];
        pool[code] = {
          code: code, name: x.name || code, pct: pct, price: Number(x.price) || 0,
          turn: Number(x.turn) || 0, mcap: Number(x.mcap) || 0, atLimit: !!x.atLimit,
          limitPct: Number(x.limitPct) || 0, tier: mkTierOf(x),
          first: (prev && prev.first) || Date.now(),
          hist: ((prev && prev.hist) || []).concat([pct]).slice(-8)
        };
      });
      MK_OPP_SNAP.pool = pool;
      MK_OPP_SNAP.boards = MK_OPP_SNAP.boards || [];
      MK_OPP_SNAP.ts = Date.now();
      MK_OPP_SNAP.src = src;
      oppPageAt = Date.now(); oppPageSrc = src;
      if (tab === 'opp') paintOppPage(false);
    } catch (e) {
      oppPageErr = String((e && e.message) || e);
      if (tab === 'opp') paintOppPage(false);
    }
  };
  const startOppPage = () => {
    stopOppPage();
    pollOppPage();                          // 立刻来一发，别让用户等 8 秒
    oppPageTimer = setInterval(pollOppPage, 8000);
  };
  const renderOpp = () => { paintOppPage(true); startOppPage(); };
  // 面板里"能滚的"不止一个（实测是外层 .panel-body 在滚，.scr-list 自己不高）⇒ 不猜是哪个，
  // 向上把所有可滚动祖先都收进来，统一定位/复位。
  const oppScrollHosts = () => {
    const out = [];
    let n = list;
    while (n && n !== document.documentElement) {
      const cs = getComputedStyle(n);
      if (/(auto|scroll)/.test(cs.overflowY) && n.scrollHeight - n.clientHeight > 4) out.push(n);
      n = n.parentElement;
    }
    return out;
  };
  // resetTop=true 只在"刚切进本页签"时用；定时刷新必须保留用户当前的滚动位置（否则每 8 秒被拽回顶部）
  const paintOppPage = (resetTop) => {
    const hosts = oppScrollHosts();
    const keeps = resetTop ? hosts.map(() => 0) : hosts.map(h => h.scrollTop);
    list.innerHTML = '';
    const arr = Object.keys(MK_OPP_SNAP.pool).map(k => MK_OPP_SNAP.pool[k]);
    list.appendChild(el('div', 'scr-sec-title', '🚀 机会池 · 拉涨即机会（' + arr.length + ' 只）'));
    list.appendChild(el('div', 'scr-sample', '口径：涨幅 >0 全部算机会，一只不漏；已屏蔽创业板/科创板/北交所（买不起，只作板块参考）。' +
      '（「雷达提示」页里的那个池只列 A/B 档＝弹窗口径，这里是完整体，所以两边只数不一样。）' +
      '更新 ' + oppClock(MK_OPP_SNAP.ts || oppPageAt) + (oppPageSrc ? ' · 榜单：' + oppPageSrc : '') +
      ' · 本页每 8 秒自己刷（不依赖雷达页签是否开着）'));
    if (oppPageErr) list.appendChild(el('div', 'scr-empty-small', '⚠ ' + oppPageErr));    if (!arr.length) {
      list.appendChild(el('div', 'scr-empty', '还没拉到在拉涨的票：开盘后这里每 8 秒扫一次全市场涨幅榜，涨幅 >0 的会自动进池。'));
      return;
    }
    const scored = mkOppScoreAll(arr, { boards: MK_OPP_SNAP.boards, zt: MK_ZT_SNAP });
    const acts = { board: 0, seal: 0, chase: 0, dip: 0, watch: 0, avoid: 0 };
    scored.forEach(z => { if (acts[z.r.act] != null) acts[z.r.act]++; });
    const tt = { A: 0, B: 0, C: 0, D: 0 };
    arr.forEach(x => { if (tt[x.tier] != null) tt[x.tier]++; });   // 分档直接从池子数，不信二手计数
    const sum = el('div', 'opp-pg-sum');
    ['A', 'B', 'C', 'D'].forEach(k => {
      if (!tt[k]) return;
      const g = el('span', 'rd-opp-tag rd-t' + k, k + ' ' + tt[k]);
      g.title = k + ' 档 = ' + (TIER_MINI[k] || '') + '，共 ' + tt[k] + ' 只';
      sum.appendChild(g);
    });
    ['board', 'seal', 'chase', 'dip', 'watch', 'avoid'].forEach(k => {
      if (!acts[k]) return;
      const c = el('span', 'mk-act mk-act-' + k, MK_ACT[k].t + ' ' + acts[k]);
      c.title = MK_ACT[k].d;
      sum.appendChild(c);
    });
    const sb = el('button', 'scr-refresh opp-pg-sort', oppPageSort === 'score' ? '排序：评分 ⇄' : '排序：涨幅 ⇄');
    sb.title = '评分＝能不能参与 / 以什么方式参与；涨幅＝今日强弱。点了立刻重排（记住选择）';
    sb.addEventListener('click', () => {
      oppPageSort = oppPageSort === 'score' ? 'pct' : 'score';
      try { localStorage.setItem('scr_opp_sort', oppPageSort); } catch (e2) { /* ignore */ }
      paintOppPage(true);
    });
    sum.appendChild(sb);
    list.appendChild(sum);
    const rows = scored.slice();
    if (oppPageSort === 'pct') rows.sort((a, b) => Number(b.x.pct) - Number(a.x.pct));
    rows.slice(0, 40).forEach(({ x, r }) => {
      const row = rowHtml(x, '换手 ' + fmt(x.turn, 1) + '%', '市值 ' + fmt((Number(x.mcap) || 0) / 1e8, 1) + ' 亿', true);
      const sc = row.querySelector('.scr-score');
      if (sc) { sc.textContent = r.s; sc.className = 'scr-score ' + scoreCls(r.s); sc.title = '打分 ' + r.s + '/100　' + r.say; }
      row.title = '点击看 K 线 ｜ ' + mkC6(x.code) + ' ' + (x.name || '') + ' ｜ 打分 ' + r.s + '/100（动能30+量价25+市值15+共振15+早板10−风险）' +
        '\n加分项：' + r.why.join(' · ') + (r.risk.length ? '\n风险项：' + r.risk.join(' · ') : '') + '\n本地规则相对排序，不是投资建议';
      const line = el('div', 'opp-line');
      line.appendChild(el('span', 'mk-act mk-act-' + r.act, MK_ACT[r.act].t));
      line.appendChild(el('span', 'opp-why', r.say + (r.risk.length ? '　⚠ ' + r.risk.join(' · ') : '')));
      row.appendChild(line);
      list.appendChild(row);
    });
    list.appendChild(el('div', 'scr-sample', '打分 = 动能30 + 量价25 + 市值15 + 共振15 + 早板10 − 风险（ST/爆量/连板/冲高回落/连阴）；' +
      '只回答"能不能参与、以什么方式参与"，是**本地规则相对排序**，不构成买卖建议。这里展示前 40 只，池内全程在雷达页签可见。'));
    // 重建后把滚动位置放回去（定时刷新不打断阅读；切页签时归零，标题/档位条一定看得见）
    hosts.forEach((h, i) => { if (h.scrollTop !== keeps[i]) h.scrollTop = keeps[i]; });
  };

  const renderSentiment = () => {
    if (!upList.length && !downList.length) {
      list.appendChild(el('div', 'scr-empty', '暂无数据，点击「刷新行情」扫描全市场。'));
      return;
    }
    const s = computeSentiment();
    // 2026-10-14 二次修正：机会池已从本页签**拆出去单开一页**（「🚀 机会池」，排在「情绪」左边），
    // 所以这里回归单栏（原来的 .scr-split 左池右情绪会让两半都变窄）。
    const L = list;            // 以下内容全部进本页签单栏
    // ★2026-10-15：模式与数据时间（盘中＝每 60 秒重扫；休市＝固定收盘快照）
    L.appendChild(el('div', 'scr-sample', dataStamp()));
    // 休市＝"固定分析面板"：补一块收盘总结，一眼看完今天（不再反复请求）
    if (!isTradingTime()) {
      const nZt = ztPool.length;
      const maxBoard = nZt ? Math.max.apply(null, ztPool.map(x => Number(x.days) || 0)) : 0;
      const bdSum = s.breadth || {};
      const lead = (MK_OPP_SNAP.boards || []).slice()
        .filter(b => Number(b.p) > 0).sort((a, b) => Number(b.p) - Number(a.p)).slice(0, 3)
        .map(b => b.n + ' +' + fmt(b.p) + '%').join('、');
      L.appendChild(el('div', 'scr-verdict',
        '📊 收盘总结：真涨停 ' + (nZt || '--') + ' 家' + (maxBoard ? '（最高 ' + maxBoard + ' 板）' : '') +
        '　中位涨幅 ' + ((Number(bdSum.median) || 0) >= 0 ? '+' : '') + fmt(bdSum.median) + '%' +
        (bdSum.ok === false ? '（⚠样本浅，不判定）' : '') +
        (lead ? '　领涨板块 ' + lead : '') +
        '　—— 收盘后本页不再自动更新，开盘（09:15）恢复每 60 秒重扫。'));
    }
    // 情绪总览卡
    const cards = el('div', 'scr-cards');
    const card = (label, val, color) => {
      const c = el('div', 'scr-card');
      c.appendChild(el('span', 'scr-card-label', label));
      const v = el('span', 'scr-card-val', val);
      if (color) v.style.color = color;
      c.appendChild(v);
      return c;
    };
    // 2026-10-14：「上涨/下跌家数」在"两端各取 2 页"的样本口径下恒为 200/200（页签自己都标了
    // 「不可外推为全市场」），摆在最显眼处反而是误导 ⇒ 换成真·全市场涨停池 + 最高连板高度；
    // 池子拿不到时退回样本口径并明确标注来源。
    const hasZt = ztPool.length > 0;
    if (hasZt) {
      const ztBoard = Math.max.apply(null, ztPool.map(x => Number(x.days) || 0));
      cards.appendChild(card('真·涨停', ztPool.length, '#e5484d'));
      cards.appendChild(card('最高连板', ztBoard + ' 板', '#e5484d'));
      cards.appendChild(card('样本涨停', s.limitUp, '#8a94a6'));
      cards.appendChild(card('样本跌停', s.limitDown, '#8a94a6'));
    } else {
      cards.appendChild(card('样本涨停', s.limitUp, '#e5484d'));
      cards.appendChild(card('样本跌停', s.limitDown, '#2ebd85'));
    }
    // 市场温度 = 样本中位涨跌幅（旧版是 up/total，因两端各取 2 页而恒为 50%）
    const b = s.breadth || {};
    const med = Number(b.median) || 0;
    const medCard = card('中位涨幅', (med >= 0 ? '+' : '') + fmt(med, 2) + '%' + (b.ok === false ? ' ⚠' : ''), mkColor(med));
    medCard.title = '样本 ' + (b.n || 0) + ' 只里「涨幅榜第 ' + (b.k || 0) + ' 名」与「跌幅榜第 ' + (b.k || 0) +
      ' 名」的中点：最强的一批还在涨多少、最弱的一批跌到哪。等权口径、不受极值影响；' +
      '两侧**等深**才准（深度不一样这个数会虚高）。' +
      (b.ok === false ? ' ⚠ 此刻两侧只取到各 ' + (b.k || 0) + ' 只（涨 ' + (b.upSide || 0) + ' / 跌 ' + (b.downSide || 0) + '），样本太浅，已暂停判定。' : '');
    cards.appendChild(medCard);
    L.appendChild(cards);

    // 情绪解读（用中位涨幅判定，避免"涨跌家数各半"的恒定中性）
    const temp = med;
    const verdict = el('div', 'scr-verdict',
      temp >= 1 ? '🔥 市场情绪偏热：中位个股涨逾 1%，赚钱效应扩散，注意追高风险。' :
      temp <= -1 ? '🧊 市场情绪偏冷：中位个股跌逾 1%，亏钱效应明显，防守为主，等待企稳信号。' :
      '⚖️ 市场情绪中性：中位个股涨跌在 ±1% 内，结构性行情，精选个股。');
    L.appendChild(verdict);
    // 样本说明（诚实标注统计口径）
    const seenSet = new Set(upList.concat(downList).map(x => x.code));
    L.appendChild(el('div', 'scr-sample',
      '统计口径：涨幅榜 + 跌幅榜共扫描 ' + seenSet.size + ' 只样本（' +
      ((upList[0] && upList[0].src === 'sina') ? '新浪实时榜兜底' : '东方财富') + '，各 2 页），非全市场精确值；' +
      '中位涨幅＝「涨幅榜第 ' + (b.k || 0) + ' 名」与「跌幅榜第 ' + (b.k || 0) + ' 名」的中点（两侧等深）' +
      (b.ok === false ? '，⚠ 此刻样本太浅已暂停判定' : '') + '；' +
      '其中涨停 ' + (b.limitUp || 0) + ' / 跌停 ' + (b.limitDown || 0) +
      '，涨逾2% ' + (b.strongUp || 0) + ' / 跌逾2% ' + (b.strongDown || 0) +
      '。注：样本近似涨跌各半，故「涨跌家数」不可外推为全市场；真·全市场口径看上方「真·涨停 / 最高连板」。'));

    // 领涨/领跌
    const twoCol = el('div', 'scr-two');
    const col = (title, arr, color) => {
      const d = el('div', 'scr-col');
      d.appendChild(el('div', 'scr-col-title', title));
      if (!arr.length) d.appendChild(el('div', 'scr-empty-small', '暂无'));
      arr.slice(0, 8).forEach(r => d.appendChild(rowHtml(r, '换手 ' + fmt(r.turn, 1) + '%')));
      return d;
    };
    twoCol.appendChild(col('🏆 领涨榜', s.topPct, '#e5484d'));
    twoCol.appendChild(col('📉 领跌榜', s.bottomPct, '#2ebd85'));
    L.appendChild(twoCol);

    // 涨停梯队打分（基础版，即时计算无需K线）：换手25 + 市值20 + 板块热度20 + 榜位35，满分100
    const uniqUp = [...new Map(upList.map(x => [x.code, x])).values()];
    const zt = uniqUp.filter(x => (Number(x.pct) || 0) >= 9.8).slice(0, 12);
    if (zt.length) {
      const hotmap = {};
      zt.forEach(x => { const k = (x.name || '').slice(0, 2); hotmap[k] = (hotmap[k] || 0) + 1; });
      L.appendChild(el('div', 'scr-sec-title', '🔥 涨停梯队打分（换手25 + 市值20 + 板块热度20 + 榜位35，满分100）'));
      zt.forEach(x => {
        const hs = Number(x.turn) || 0;
        const mcap = Number(x.mcap) || 0;
        const hot = hotmap[(x.name || '').slice(0, 2)] || 1;
        const pos = Math.max(0, 35 - uniqUp.indexOf(x) * 3);   // 涨幅榜越靠前强度越高
        let sc = 0;
        if (hs >= 5 && hs <= 15) sc += 25; else if (hs >= 2 && hs < 5) sc += 15; else if (hs > 15 && hs <= 25) sc += 15; else if (hs < 2) sc += 10; else sc += 12;
        if (mcap < 50e8) sc += 20; else if (mcap < 100e8) sc += 16; else if (mcap < 200e8) sc += 10; else sc += 4;
        if (hot >= 5) sc += 20; else if (hot >= 3) sc += 14; else if (hot === 2) sc += 8; else sc += 4;
        sc += pos;
        sc = Math.min(100, sc);
        const row = rowHtml(x,
          '换手 ' + fmt(hs, 1) + '%',
          mcap > 0 ? '市值 ' + fmt(mcap / 1e8, 0) + '亿' : null, true);
        const box = row.querySelector('.scr-score');
        if (box) {
          box.textContent = sc;
          box.className = 'scr-score ' + scoreCls(sc);
          box.title = '涨停打分 ' + sc + '/100（换手/市值/板块热度/榜位）';
        }
        L.appendChild(row);
      });
    }
  };

  const renderRebound = () => {
    if (!r60List.length) {
      // ★2026-10-16：说清"为什么没有"，别只让人点刷新 —— 东财不通时 r60 靠本地按日K算，
      //   要是连跌幅榜都拿不到，那就是整条网络断了，点刷新也没用。
      list.appendChild(el('div', 'scr-empty',
        '暂无 60 日跌幅榜数据' +
        (downList.length ? '（跌幅榜有 ' + downList.length + ' 只，但本地算 r60 失败：日K 取不到）'
                         : '（涨幅/跌幅榜都没取到，网络可能整条断了）') +
        '，点「🔄 刷新行情」重扫。'));
      return;
    }
    const rows = computeRebound();
    list.appendChild(el('div', 'scr-sec-title', '🔄 超跌反弹候选（60日跌幅深 + 今日企稳，前 30 · 右侧徽章为量化打分，满分100）'));
    list.appendChild(el('div', 'scr-sample', dataStamp()));
    if (!rows.length) {
      list.appendChild(el('div', 'scr-empty', '当前未筛选出符合条件的超跌反弹标的。'));
      return;
    }
    rows.forEach(r => {
      const r60 = Number(r.r60) || 0;
      list.appendChild(rowHtml(r,
        '60日 ' + fmt(r60, 1) + '%',
        '换手 ' + fmt(r.turn, 1) + '%', true));
    });
    scoreBatch(rows, 'rebound');   // 异步拉日K打分
    list.appendChild(el('div', 'scr-tip', '💡 打分 = 超跌深度30 + 企稳确认35 + 反转催化20 + 风控15。策略：跌透 + 企稳 + 资金回头，博 5~15% 反弹。非投资建议，注意止损。'));
  };

  const renderBreakout = () => {
    if (!upList.length) {
      list.appendChild(el('div', 'scr-empty', '暂无数据，点击「刷新行情」扫描全市场。'));
      return;
    }
    const pool = brPoolList();
    if (!pool.length) {
      list.appendChild(el('div', 'scr-empty', '当前未筛选出符合条件的标的（今日涨幅≥2% 的非封板票为空）。'));
      return;
    }
    list.appendChild(el('div', 'scr-sec-title',
      '🚀 波段启动候选（60 日位置 <' + BR.POS_MAX + '% 且 距 MA20 在 ' + BR.MA20_MIN + '%~+' + BR.MA20_MAX + '% · 按"位置最低"排序 · 参考 止盈 +' + BR.TP + '% / 止损 ' + BR.SL + '%）'));
    const note = el('div', 'scr-tip', '⏳ 正在按「低位 + 不追高」筛选：拉 ' + pool.length + ' 只日K 算 60 日位置 / 距 MA20 / 量比…');
    const box = el('div', 'scr-list-inner');
    list.appendChild(el('div', 'scr-sample', dataStamp()));
    list.appendChild(note);
    list.appendChild(box);
    brEnrich(pool, box, note);
  };
  // 异步：拉日K → 算特征 → 过滤排序 → 画行（徽章＝形态分，只作参考，不再是排序依据）
  const brEnrich = async (pool, box, note) => {
    const feats = {};
    const CH = 20;
    for (let i = 0; i < pool.length; i += CH) {
      if (disposed) return;
      const chunk = pool.slice(i, i + CH);
      let klMap = null;
      try {
        const res = await K.kline.batch(chunk.map(r => r.code), 120);
        if (res && res.ok && res.data) klMap = res.data;
      } catch (e) { /* ignore */ }
      if (disposed) return;
      if (!klMap) {
        // K线接口不可用（GUI 未重启 / main.js 未加载）⇒ 老实退回"按涨幅列"，并说明没做低位筛选
        note.className = 'scr-tip bad';
        note.textContent = '⚠ K线接口不可用（需重启过 GUI 的 main.js）⇒ 本次只按涨幅列出，未做低位筛选';
        pool.slice(0, BR.SHOW).forEach(s => box.appendChild(rowHtml(s, '换手 ' + fmt(s.turn, 1) + '%', null, false)));
        return;
      }
      chunk.forEach(s => { const f = brFeature(klMap[s.code], s.price); if (f) feats[s.code] = f; });
    }
    if (disposed) return;
    let rows = pool
      .filter(s => feats[s.code] && feats[s.code].pos60 < BR.POS_MAX &&
        feats[s.code].distMA20 <= BR.MA20_MAX && feats[s.code].distMA20 >= BR.MA20_MIN)
      .sort((a, b) => feats[a.code].pos60 - feats[b.code].pos60)
      .slice(0, BR.SHOW);
    let relaxed = '';
    if (!rows.length) {
      relaxed = '（今日没有"低位且贴近 MA20"的票 ⇒ 放宽为"按贴近 MA20 排序"）';
      rows = pool.filter(s => feats[s.code])
        .sort((a, b) => Math.abs(feats[a.code].distMA20) - Math.abs(feats[b.code].distMA20))
        .slice(0, BR.SHOW);
    }
    note.className = 'scr-tip';
    note.textContent = '✅ 从 ' + pool.length + ' 只预选里筛出 ' + rows.length + ' 只' + relaxed +
      '　口径：60 日位置 <' + BR.POS_MAX + '% 且 距 MA20 在 ' + BR.MA20_MIN + '% ~ +' + BR.MA20_MAX +
      '% 之间（回测：止盈 40.0% / 止损 20.2% / 单笔期望 +2.99% · 徽章＝形态分仅供参考）';
    box.innerHTML = '';
    rows.forEach(s => {
      const f = feats[s.code];
      const row = rowHtml(s,
        '位置 ' + fmt(f.pos60, 0) + '% · 距MA20 ' + (f.distMA20 >= 0 ? '+' : '') + fmt(f.distMA20, 1) + '%',
        '量比 ' + fmt(f.vr, 2) + ' · 止盈 +' + BR.TP + '% / 止损 ' + BR.SL + '%', true);
      box.appendChild(row);
      const b = row.querySelector('.scr-score');
      if (b) {
        const sc = analyzeB({ mcap: Number(s.mcap) || 0, turn: Number(s.turn) || 0, main: Number(s.main) || 0, mainKnown: s.main != null }, f.raw);
        if (!sc || !Number.isFinite(sc.total)) {
          b.textContent = '—'; b.className = 'scr-score bad';
          b.title = '形态分：当前不是趋势启动形态（S5）';
        } else {
          b.textContent = sc.total; b.className = 'scr-score ' + scoreCls(sc.total);
          b.title = '形态分 ' + sc.total + '/100（方向' + sc.scoreDir + '/回调' + sc.pull + '/资金' + sc.scoreFund + '/安全' + sc.scoreSafe + '）' +
            '　⚠ 这是"趋势突破"口径，回测显示它与后续 5 日收益**负相关**，只作参考；本页排序用的是「位置最低」';
        }
      }
    });
  };

  // ---- 数据新鲜度：盘中密集扫 / 休市固定快照（★2026-10-15 用户要求）----
  // 用户原话："这些东西应该是开盘的时候进入密集工作，不开盘就是固定的分析面板总结"。
  // 所以：**开盘**＝每 60 秒自动重扫（只有正看着这三个数据页时才扫，避免后台白拉）；
  //       **休市**＝当天只扫一次拿收盘口径，之后**冻住**当固定分析面板（页头写明数据时间，别让人以为是实时）。
  const SCAN_TTL_LIVE = 60000;              // 盘中：数据超过 60 秒就重扫
  const SCAN_TTL_CLOSED = 12 * 3600e3;      // 休市：半天内不重复扫（当天收盘数据扫一次就够）
  let scanTimer = null;
  const dataAge = () => (ts ? Date.now() - ts : Infinity);
  const needScan = () => (!loading && (isTradingTime() ? dataAge() > SCAN_TTL_LIVE : dataAge() > SCAN_TTL_CLOSED));
  const ensureFresh = async () => { if (needScan()) await scan(); };
  const isToday = (t) => !!t && new Date(t).toDateString() === new Date().toDateString();
  // 页头那一行"现在是什么模式、数据是几点的"
  const dataStamp = () => {
    const live = isTradingTime();
    const head = live ? '🟢 盘中 · 每 60 秒自动重扫' : '📊 收盘快照（最近一个交易日的收盘口径）· 收盘后不再自动更新';
    const when = ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '--';
    return head + '　本轮取数 ' + when + (ts && !isToday(ts) ? '　⚠ 不是今天的（开盘后会自动补扫）' : '');
  };

  // ---- 扫描全市场 ----
  const scan = async () => {
    if (loading) return;
    loading = true;
    refreshBtn.disabled = true;
    refreshBtn.textContent = '⏳ 扫描中…';
    status.textContent = '正在拉取全市场涨幅榜 / 跌幅榜（东方财富）…';
    // ★2026-10-16：**不再先清空列表** —— 东财不通时这一趟要等满 20 秒外层超时，
    //   先清空的话整页空白 20 秒，看着就是"卡在扫描中"（用户截图里那个状态）。现在保留上一屏数据，
    //   扫描完由 render() 整页重画。
    try {
      const [upRes, downRes, r60Res] = await Promise.all([
        K.market.rank({ type: 'up', pages: 2 }),
        K.market.rank({ type: 'down', pages: 2 }),
        K.market.rank({ type: 'down', pages: 4, sort: 'r60' })   // 真·60日跌幅榜（f24 升序）
      ]);
      if (disposed) return;   // 场景已切走：丢弃结果
      upList = (upRes && upRes.list) || [];
      downList = (downRes && downRes.list) || [];
      r60List = (r60Res && r60Res.list) || [];
      ts = Date.now();
      const fromCache = (upRes && upRes.fromCache) || (downRes && downRes.fromCache) ||
        (r60Res && r60Res.fromCache);
      // 2026-10-14：东财 clist 被掐时主进程只会回放缓存 —— 缓存是"上一轮的榜"，
      // 对"波段启动 / 超跌反弹"这种当天信号几乎没用。这里补一层实时榜兜底（纯本地脚本，不耗 token）。
      let upSrc = '', downSrc = '';
      if (!upList.length || (upRes && upRes.fromCache)) {
        const fb = await mkPyRun(['--rank', 'up', '--pages', '2']);
        if (disposed) return;
        if (fb && fb.ok && fb.list && fb.list.length) { upList = fb.list; upSrc = fb.src === 'sina' ? '新浪' : '东财'; }
      }
      if (!downList.length || (downRes && downRes.fromCache)) {
        const fb = await mkPyRun(['--rank', 'down', '--pages', '2']);
        if (disposed) return;
        if (fb && fb.ok && fb.list && fb.list.length) { downList = fb.list; downSrc = fb.src === 'sina' ? '新浪' : '东财'; }
      }
      // ★2026-10-16：**60 日跌幅榜的本地兜底**（原来这一路完全没有兜底 —— 东财一挂，
      //   「🔄 超跌反弹」就永远是空的：新浪的榜行 `r60=null`，给不出 60 日涨跌幅）。
      //   做法：拿跌幅榜里那些票，批量取 120 根前复权日K，本地算 `r60 = 现价/60交易日前收盘-1`。
      //   腾讯日K 这条路是通的（面板其余取数都靠它），所以超跌反弹从此**不依赖东财**。
      let r60Src = '';
      if (!r60List.length && downList.length) {
        const cand = downList.slice(0, 90);
        const klMap = {};
        try {
          for (let i = 0; i < cand.length; i += 24) {
            const chunk = cand.slice(i, i + 24);
            const res = await K.kline.batch(chunk.map(x => x.code), 120);
            if (disposed) return;
            if (res && res.ok && res.data) Object.keys(res.data).forEach(k => { klMap[k] = res.data[k]; });
          }
        } catch (e) { /* 兜底失败就保持空，页面会说明原因 */ }
        const local = [];
        cand.forEach(x => {
          const kl = klMap[x.code];
          if (!kl || kl.length < 62) return;
          const c0 = Number(kl[kl.length - 61][2]), c1 = Number(kl[kl.length - 1][2]);
          if (!c0 || !c1) return;
          local.push(Object.assign({}, x, { r60: (c1 / c0 - 1) * 100, r60Local: true }));
        });
        if (local.length) { r60List = local; r60Src = '本地按日K算'; }
      }
      // ★2026-10-16 第三级兜底：**本地扫自己盯的板块**（完全不依赖东财）。
      //   每轮推进 96 只（实测 150 只 1.4s），约 10 轮扫完 940 只；扫过的当天会命中 kline_cache ⇒ 之后秒回。
      if (!r60List.length && R60_UNIVERSE.length) {
        const added = await sweepR60Local();
        if (disposed) return;
        const rowsLocal = await r60LocalRows();
        if (disposed) return;
        if (rowsLocal.length) {
          r60List = rowsLocal;
          r60Src = '本地扫板块 ' + Object.keys(r60Local).length + ' 只候选' + (added ? '（本轮+' + added + '）' : '');
        }
      }
      const live = upSrc || downSrc;
      // 真·涨停池（全市场，含连板数）：情绪页签的"涨停数/连板高度"用它，比样本口径准
      const fbz = await mkPyRun(['--zt']);
      if (disposed) return;
      if (fbz && fbz.ok && fbz.list && fbz.list.length) {
        ztPool = fbz.list;
        // 顺带喂给机会池打分（连板高度是扣分项）：代码 -> 连板数
        try {
          MK_ZT_SNAP = {};
          ztPool.forEach(x => { const c = String(x.code || '').replace(/\.(SH|SZ|BJ)$/i, ''); if (c) MK_ZT_SNAP[c] = Number(x.days) || 1; });
        } catch (e) { /* ignore */ }
      }
      status.textContent = (fromCache && !live ? '📦 网络受限，使用本地缓存数据 · ' : '') +
        '已扫描 ' + (upList.length + downList.length) + ' 只' + (live ? '（实时兜底·' + live + '）' : '') +
        ' + 60日跌幅榜 ' + r60List.length + ' 只' +
        (r60Src ? '（' + r60Src + '）' : (r60List.length && r60Res && r60Res.fromCache ? '（缓存）' : '')) +
        ' + 涨停池 ' + ztPool.length + ' 家' +
        '（' + new Date(ts).toLocaleTimeString('zh-CN', { hour12: false }) + '）· 已屏蔽 创业板(300/301)·科创板(688/689)·北交所(43/83/87/88/920)（仅作板块参考）· 点击股票联动 K线';
      render();
    } catch (ex) {
      status.textContent = '扫描失败：' + (ex && ex.message || ex);
      // ★2026-10-16：**失败也要让页面有东西看**（原来失败时因为开头清空过列表，整页空白）
      try { render(); } catch (e2) { /* ignore */ }
    } finally {
      // ★2026-10-16：收尾放 finally —— 原来那几处 `if (disposed) return` 会**跳过**下面三行，
      //   一旦中途返回，按钮就永远停在「⏳ 扫描中…」、`loading` 永远为 true ⇒ 之后所有自动重扫全被拦住。
      loading = false;
      refreshBtn.disabled = false;
      refreshBtn.textContent = '🔄 刷新行情';
    }
  };

  // 秒开：先用本地缓存的最近一次排名渲染（不联网），再后台扫描刷新
  const paintCached = async () => {
    try {
      const [up, down] = await Promise.all([
        K.market.rankCached('up'),
        K.market.rankCached('down')
      ]);
      if (disposed) return;
      if ((up && up.list && up.list.length) || (down && down.list && down.list.length)) {
        upList = (up && up.list) || [];
        downList = (down && down.list) || [];
        ts = Date.now();
        status.textContent = '📦 已显示本地缓存行情（' +
          new Date((up && up.ts) || (down && down.ts) || Date.now()).toLocaleTimeString('zh-CN', { hour12: false }) +
          '），正在后台刷新…';
        render();
      } else {
        // 无缓存（首次使用）：旧版这里什么都不画，而 scan() 要联网数秒 ⇒ 那几秒是纯空白，
        // 看着像"坏了"。现在先给一个明确的加载态。
        status.textContent = '⏳ 首次加载：正在扫描全市场行情，请稍候…';
        render();
      }
    } catch (e) { /* 缓存不可用则直接等扫描 */ }
  };

  // 启动：先画本地缓存，再自动扫描一次；随后装上「🔔 提示」的规则盯盘（读记忆表规则 + 首检 + 20 秒自检）
  paintCached();
  scan();
  alertLoadLog();
  alertLoadRules().then(() => {
    if (disposed) return;
    syncAlertBadge();
    if (tab === 'alert') renderAlert();
    alertCheck(isTradingTime());   // 交易时段内才判定；休市只取一次数把"当前值"填上
  });
  alertTimer = setInterval(alertTick, 20000);
  // ★2026-10-15「开盘密集 / 休市固定」的自动重扫：每 20 秒看一眼要不要补数（真正的节流在 needScan 里：
  //   盘中 >60 秒才重扫、休市只补"不是今天"的那一次），而且**只有正看着数据页时才扫**（不看就不白拉）。
  scanTimer = setInterval(() => {
    if (disposed || loading) return;
    if (tab !== 'sentiment' && tab !== 'rebound' && tab !== 'breakout') return;
    // 收盘补扫一次：15:05 之后手上数据还是"今天盘中"的（<15:00）⇒ 补一次拿收盘终值，之后彻底冻住
    const bj = (t) => { const d = new Date(t + 8 * 3600e3); return d.getUTCHours() * 100 + d.getUTCMinutes(); };
    if (!isTradingTime() && bj(Date.now()) >= 1505 && ts && isToday(ts) && bj(ts) < 1500) { scan(); return; }
    if (needScan()) scan();
  }, 20000);

  // ---- 残留调试探针清扫（2026-10-14 用户报「左下角有个 PROBE…」）----
  // 来历：10:30 调面板布局时用一段**临时**探针在 <body> 上挂了个 position:fixed 的 DIV，每几秒刷新
  //   "win=… dpr=… grid=… | 趋势看板=… | 板块推荐=…" 这行面板尺寸。**探针代码本身早已删掉**，
  //   但「刷新面板」是**重新注入脚本、不重载页面** ⇒ 那个 setInterval 还活在页面里，隔一阵就把 DIV 挂回来。
  // 修法：做一次窄口径清扫，口径小到不可能误伤正常元素 —— 只删「body 直接子级 + 无 class + 无子元素
  //   + position:fixed + 文本以 "PROBE " 开头」的节点；每 5 秒扫一次，外挂探针再冒头也会被立刻清掉。
  //   （彻底清掉的办法仍是整页重载/GUI 重启，但那样要打断用户；这个守卫 5 秒内自愈、不用他动手。）
  const sweepProbe = () => {
    if (disposed) return;
    document.querySelectorAll('body > div').forEach(n => {
      if (n.className || n.children.length) return;
      if ((n.textContent || '').slice(0, 6) !== 'PROBE ') return;
      if (getComputedStyle(n).position !== 'fixed') return;
      n.remove();
    });
  };
  sweepProbe();
  const probeTimer = setInterval(sweepProbe, 15000);   // ★2026-10-16：5 秒 → 15 秒（只是防历史探针残留，不用这么勤）

  // 场景隔离：切走场景时停止后续渲染，并清掉盯盘定时器（check-gui 第 4 项）
  return () => {
    disposed = true;
    stopRadar();
    stopOppPage();
    if (probeTimer) clearInterval(probeTimer);
    if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
    if (statusMo) { try { statusMo.disconnect(); } catch (e) { /* ignore */ } statusMo = null; }
    if (alertTimer) { clearInterval(alertTimer); alertTimer = null; }
  };
};

// ---- 标题行里的按键：必须阻断指针事件 ----
// ★2026-10-13★ 面板标题行同时是**拖拽把手** ⇒ 塞进标题行的按钮不阻断 mousedown/pointerdown 的话，
//   事件会被把手吃掉，表现为"点了没反应"。原来只有素材管理面板里那份局部实现（wireHeadBtn），
//   现在提到公共工具（一处实现）：预览面板把功能按键并进标题行时也用它。
function wireHeadNoDrag(node) {
  if (!node) return node;
  ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'click', 'dblclick'].forEach(function (ev) {
    node.addEventListener(ev, function (e) { e.stopPropagation(); });
  });
  return node;
}

// ---- 暴露给外壳（renderer.js）的热更新接口 ----
// 面板渲染器与工具函数挂到 window 上；刷新场景时 renderer.js 会带时间戳重新加载本文件，
// 从而让 renderer 逻辑改动即时生效（不重载页面、不影响 harness webview 对话）。
window.APP_RENDER_UTILS = { el, mktColor, GRID_COLS, panelHead, makePanel, attachResize, packAutoGrid, gridColsOf, initScenarioTabBar, decorateScenarioIcons, wireHeadNoDrag };
window.APP_RENDERERS = renderers;

// ============ 左上角品牌区：悬停显示版本信息卡 ============
// ★版本契约★：本壳是围绕引擎的"内部实现"做的（DOM 属性 / localStorage 键 / 会话行结构…见项目信息 §18），
// 上游一改这些，壳不会崩但会**静默降级**（面板藏不住侧栏、钉会话失效、状态小字乱报）。
// 所以这里记一份"已验证过的引擎版本"：引擎版号与它不一致 → 品牌区小点变琥珀色 + 悬停卡里明确写出，
// 并在 console 留一行提示。**只提示、不阻塞启动**（升级后功能多数仍然可用，不该把人挡在门外）。
var ADAPTED_ENGINE = '0.2.1-rc.3';   // 2026-10-26 升到 0.2.1-rc.3（HEAD 22ddee3792；engine-after 8 锚点全在 + 面板/钉会话/藏列实测通过）
var engineMismatch = '';
// 为什么放在这个文件（而不是 renderer.js）：renderers.js 是**可热更新**的（标题栏 ⟳ 会重新执行它），
// 把"品牌区装饰 + 版本卡"放这里，改完点 ⟳ 就生效，不用重启 GUI。
// 幂等：index.html 里已有 .brand-tip 就用现成的；没有就建一个（这样旧 index.html 也能有版本卡）。
// 数据：优先走主进程 app:version（preload 的 app.getVersion，含 引擎/GUI/Electron/Chromium/Node 版本）；
// 若主进程还没重启（没有这个接口）→ 先用 navigator.userAgent 能拿到的信息，并提示重启后显示引擎版本，
// 之后 30 秒内每 3 秒重试一次（用户中途重启了也能自动补全，不用再点 ⟳）。
var brandTipRetry = null;
function decorateBrand() {
  try {
    const brand = document.querySelector('.brand');
    if (!brand) return;
    let tip = document.getElementById('brand-tip');
    if (!tip) {
      tip = document.createElement('span');
      tip.id = 'brand-tip';
      tip.className = 'brand-tip';
      tip.setAttribute('role', 'tooltip');
      tip.innerHTML =
        '<span class="brand-tip-line brand-tip-title">DSH 引擎 <b id="ver-engine">—</b></span>' +
        '<span class="brand-tip-line">工作台 GUI <b id="ver-gui">—</b></span>' +
        '<span class="brand-tip-line" id="ver-runtime">运行时 —</span>' +
        '<span class="brand-tip-line brand-tip-dim" id="ver-dir">引擎目录 —</span>';
      brand.appendChild(tip);
    }
    const set = (id, text) => { const el = document.getElementById(id); if (el && text) el.textContent = text; };
    const ua = String(navigator.userAgent || '');
    const electron = (ua.match(/Electron\/([\d.]+)/) || [])[1];
    const chrome = (ua.match(/Chrome\/([\d.]+)/) || [])[1];
    const fill = (v) => {
      if (!v || !(v.engine || v.cli || v.gui || v.electron)) return false;
      const vv = (x) => (x ? 'v' + x : '（未知）');
      set('ver-engine', vv(v.engine || v.cli));
      set('ver-gui', vv(v.gui || v.app));
      const rt = [];
      if (v.electron) rt.push('Electron ' + v.electron);
      if (v.chrome) rt.push('Chromium ' + v.chrome);
      if (v.node) rt.push('Node ' + v.node);
      set('ver-runtime', rt.join(' · ') || '运行时（未知）');
      let dir = '引擎目录 ' + (v.engineDir || '（未知）');
      // 引擎与 CLI 版本不一致 = "看起来正常其实错配"，直接标出来
      if (v.engine && v.cli && v.engine !== v.cli) dir += ' ⚠ CLI ' + v.cli;
      set('ver-dir', dir);
      // ★版本契约核对★：引擎换了版本 → 明确写出来（不阻塞，只提示 + 变琥珀色）
      if (v.engine && ADAPTED_ENGINE && v.engine !== ADAPTED_ENGINE) {
        engineMismatch = v.engine;
        set('ver-runtime', (rt.join(' · ') || '运行时') + '\n⚠ 本壳适配的是 v' + ADAPTED_ENGINE + '，引擎已是 v' + v.engine +
          '：若面板藏不住侧栏 / 切不到会话，先跑 node scripts\\engine-after.mjs 核对上游实现');
        try { highlightEngineMismatch(true); } catch (e) { /* ignore */ }
        try { console.warn('[工作台] 引擎版本 ' + v.engine + ' ≠ 本壳适配版本 ' + ADAPTED_ENGINE + '，请跑 node scripts/engine-after.mjs 核对'); } catch (e) { /* ignore */ }
      } else {
        engineMismatch = '';
        try { highlightEngineMismatch(false); } catch (e) { /* ignore */ }
      }
      return true;
    };
    const tryFetch = () => {
      try {
        if (!window.app || typeof window.app.getVersion !== 'function') return false;
        window.app.getVersion().then(fill).catch(function () { });
        return true;
      } catch (e) { return false; }
    };
    if (!tryFetch()) {
      const rt = [];
      if (electron) rt.push('Electron ' + electron);
      if (chrome) rt.push('Chromium ' + chrome);
      set('ver-runtime', rt.join(' · ') || '运行时（未知）');
      set('ver-engine', '重启 GUI 后显示');
      set('ver-dir', '版本接口需重启一次 GUI（app:version）');
      // 有界重试（最多 10 次，每次 3 秒）：用户中途重启了 GUI 也能自动补上，不用再点 ⟳。
      // 用 setTimeout 递归而不是 setInterval：这是"启动期一次性补偿"，不是常驻定时器，
      // 也不会被 check-gui 的"渲染器定时器必须有 cleanup"规则误判（它不是面板定时器）。
      if (!brandTipRetry) {
        let n = 0;
        const retry = () => {
          if (tryFetch() || ++n > 10) { brandTipRetry = null; return; }
          brandTipRetry = setTimeout(retry, 3000);
        };
        brandTipRetry = setTimeout(retry, 3000);
      }
    }
  } catch (e) { /* 品牌区装饰失败绝不能影响工作台启动 */ }
}

// ===== 顶栏「网页版 AI」：五个官方小图标 + 点开的浮动窗口（2026-09-20 第四波 / 第五波补 DeepSeek）=====
// 用户原话：「把这四个网页版内置到 gui 窗口最顶上，<机主>的工作台字段后面，用一个个官方小图标
// 显示，点击就可以出来一个窗口，保证快速响应」。
//
// ★为什么整段都在这里、一行 index.html 都不改★
//   1) index.html 是外壳，改它要**重启 GUI**；本文件点「⟳」就重新执行 ⇒ 加顶栏元素必须放这儿；
//   2) 图标必须是**官方**的：`scripts\fetch-webai-icons.mjs` 从各家官网抓 favicon 落到
//      `renderer\assets\webai\`（不是手画 SVG），抓不到时按钮退回"名字首字"，不会出现破图；
//   3) ★快★ = **预热**：启动后错峰把网页各建一个 <webview> 先加载好（不显示），
//      点图标只是"把已经加载好的窗口挪出来" ⇒ 打开是瞬时的，不是每次重新联网。
//      代价是每个预热过的页面各占一份常驻内存；不想要就在各自窗口的工具栏里点「⏏ 释放」
//      （下次点开重新加载）。站点表里标了 `noWarm` 的站不进预热队列 —— 点开时才加载。
//
// 宿主侧没有任何配套改动（不开新 BrowserWindow、不加新 IPC）：webview 的 partition 不需要主进程
// 白名单，登录态默认落在各自的 `persist:webai-<key>` 分区里，互不串味、也不会污染对话那条链路。
// ★唯一的例外是 deepseek★：它在站点表里显式写了 `partition`，**和自我复盘场景左下角那个 DeepSeek
//   面板共用同一个分区**（`persist:embed-sr-site-bl`；embed 面板的分区规则 = `persist:embed-<面板id>`，
//   见本文件 renderers.embed）⇒ 两边同一份 cookie、同一个登录态，「联通」不是两套各登一次。
// ⚠ 已知限制（主进程的既有策略，不是本功能的 bug）：这几个站点里 `window.open` 弹出来的
//   第三方登录小窗会被统一丢给系统默认浏览器（main.js 的 setWindowOpenHandler）⇒ 扫码/授权类
//   登录建议直接在系统浏览器里登完，本窗口用账号密码登录没问题。
// 站点表字段：key/name/icon/fallback/url 必填；另有两个可选开关 ——
//   partition：覆盖默认的 `persist:webai-<key>`（**只在"要跟别的面板共用登录态"时才写**）；
//   noWarm   ：不参加启动预热（点开时才建 webview，省一份常驻 guest 内存）；
//   userAgent：'chrome' = 换成纯 Chrome UA（站点认 Electron 就会盖一层「使用环境异常」弹窗）。
// ⚠ deepseek 这一项**故意**用 `persist:embed-sr-site-bl`：它和自我复盘场景（scenarios\self-review.json）
//   左下角那个 DeepSeek 面板（面板 id `sr-site-bl`，同一个 chat.deepseek.com）**是同一个 webview 分区**
//   ⇒ 登录态/会话完全**联通**：在场景面板里登录过，顶栏点开就是登录好的，反过来也一样。
//   不是"两套各登一次"；也别把这个分区名改掉 —— 改了两边同时掉登录。
var WEB_AI = [
  { key: 'deepseek', name: 'DeepSeek', icon: 'assets/webai/deepseek.png', fallback: 'D',
    url: 'https://chat.deepseek.com/', partition: 'persist:embed-sr-site-bl',
    userAgent: 'chrome', noWarm: true,
    tip: '与自我复盘场景的 DeepSeek 面板共用登录态（同一个 webview 分区）' },
  { key: 'doubao', name: '豆包', icon: 'assets/webai/doubao.png', fallback: '豆',
    url: 'https://www.doubao.com/chat/' },
  { key: 'tongyi', name: '通义千问', icon: 'assets/webai/tongyi.png', fallback: '通',
    url: 'https://tongyi.aliyun.com/qianwen/' },
  { key: 'chatglm', name: '智谱清言', icon: 'assets/webai/chatglm.png', fallback: '智',
    url: 'https://chatglm.cn/main/alltoolsdetail' },
  { key: 'kimi', name: 'Kimi', icon: 'assets/webai/kimi.png', fallback: 'K',
    url: 'https://www.kimi.com/' },
];

// ★状态为什么挂在 window 上★ ⟳ 会**重新求值本文件**却**不重建 DOM**（同一个页面上下文）：
// 状态若只放在 `var webAiWins = {}` 里，点一次「⟳」就会被清空，而旧的窗口 div 与那只正在跑的
// webview 还留在页面上 ⇒ 再预热一遍就多出一整套窗口（两只会互相盖住，肉眼很难发现）。
// 所以状态存 window.__kunWebAi（和 __kunFixOn / __kunWideTimer 是同一个套路）。
var WEB_AI_ST = window.__kunWebAi || (window.__kunWebAi = { wins: {}, layer: null, z: 2400, warmed: false });
var webAiWins = WEB_AI_ST.wins;   // 别名：下面所有代码照旧用这个名字

// ⟳ 之后把页面上**已经存在**的窗口认领回来（不重建、不重复挂 webview）
function webAiAdopt() {
  try {
    const layer = document.querySelector('.webai-layer');
    if (layer) WEB_AI_ST.layer = layer;
    Array.prototype.forEach.call(document.querySelectorAll('.webai-win'), function (el) {
      const key = el.dataset.key;
      if (!key || WEB_AI_ST.wins[key]) return;
      const site = WEB_AI.filter(function (s) { return s.key === key; })[0];
      if (!site) return;
      WEB_AI_ST.wins[key] = {
        el: el, wv: el.querySelector('webview'), mask: el.querySelector('.webai-mask'),
        host: el.querySelector('.webai-host'), key: key, site: site,
      };
    });
  } catch (e) { /* ignore */ }
}

// 每个站点的窗口几何记在 localStorage：拖过/拉过大小，下次点开还在原地
function webAiGeom(key, idx) {
  try {
    const raw = localStorage.getItem('app.webai.geom.' + key);
    if (raw) {
      const g = JSON.parse(raw);
      if (g && g.w > 200 && g.h > 150) return g;
    }
  } catch (e) { /* ignore */ }
  const w = Math.min(980, Math.max(420, Math.round((window.innerWidth || 1400) * 0.56)));
  const h = Math.min(760, Math.max(360, Math.round((window.innerHeight || 900) * 0.78)));
  const x = Math.max(12, Math.round(((window.innerWidth || 1400) - w) / 2) + idx * 26);
  const y = Math.max(46, Math.round(((window.innerHeight || 900) - h) / 2) + idx * 22);
  return { x: x, y: y, w: w, h: h };
}
function webAiRecordGeometry(key) {
  const o = webAiWins[key];
  if (!o || !o.el) return;
  try {
    const r = o.el.getBoundingClientRect();
    if (r.width > 200) {
      localStorage.setItem('app.webai.geom.' + key, JSON.stringify({
        x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
      }));
    }
  } catch (e) { /* ignore */ }
}
function webAiSetStatus(key, st) {
  const o = webAiWins[key];
  if (o && o.btn) o.btn.dataset.st = st;
}

// 建（或复用）一个站点的窗口 + 它的 <webview>；mode: 'warm' 只加载不显示，'show' 顺带摊出来
function webAiEnsure(key, mode) {
  const site = WEB_AI.filter(function (s) { return s.key === key; })[0];
  if (!site) return null;
  let o = webAiWins[key];
  if (!o) webAiAdopt();
  o = webAiWins[key];
  if (!o) {
    if (!WEB_AI_ST.layer) {
      WEB_AI_ST.layer = document.createElement('div');
      WEB_AI_ST.layer.className = 'webai-layer';
      document.body.appendChild(WEB_AI_ST.layer);
    }
    const idx = WEB_AI.map(function (s) { return s.key; }).indexOf(key);
    const g = webAiGeom(key, idx);
    const el = document.createElement('div');
    el.className = 'webai-win warm';
    el.dataset.key = key;
    el.style.left = g.x + 'px';
    el.style.top = g.y + 'px';
    el.style.width = g.w + 'px';
    el.style.height = g.h + 'px';
    el.style.zIndex = String(++WEB_AI_ST.z);

    // 标题栏顺序 = 图标 · 名字 · 当前网址 · 空白 · 工具按钮（一次append到位，不做插入挪动）
    const head = document.createElement('div');
    head.className = 'webai-head';
    const ico = document.createElement('img');
    ico.src = site.icon; ico.alt = '';
    ico.onerror = function () { try { this.style.display = 'none'; } catch (e) {} };
    const title = document.createElement('span');
    title.className = 'webai-title'; title.textContent = site.name;
    const host = document.createElement('span');
    host.className = 'webai-host'; host.textContent = new URL(site.url).host;
    const spacer = document.createElement('span');
    spacer.className = 'webai-spacer';
    const mkTb = function (act, label, tip, cls) {
      const b = document.createElement('button');
      b.className = 'webai-tb' + (cls ? ' ' + cls : '');
      b.dataset.act = act;
      b.textContent = label;
      b.title = tip;
      b.setAttribute('aria-label', tip);
      return b;
    };
    const bBack = mkTb('back', '‹', '后退');
    const bFwd = mkTb('fwd', '›', '前进');
    const bRel = mkTb('reload', '⟳', '重新加载这个页面');
    // 「只留标题栏（▁）」按钮已按用户要求去掉（2026-09-23：留着没用还占位）。功能本体还在：
    // 7802 行 act==='mini' 的分支与 7864 行的 classList.remove('mini') 都保留 —— 万一有窗口停在 mini 态，
    // 重开该窗口会自动恢复成正常高度，不会卡死。
    const bFree = mkTb('free', '⏏', '释放内存：关掉网页本身，下次点开重新加载');
    const bOpen = mkTb('open', '↗', '用系统默认浏览器打开（登录/扫码建议走这里）');
    const bClose = mkTb('close', '✕', '关掉这个窗口（网页留着，下次点开秒开）', 'close');
    [ico, title, host, spacer, bBack, bFwd, bRel, bFree, bOpen, bClose].forEach(function (n) { head.appendChild(n); });

    const body = document.createElement('div');
    body.className = 'webai-body';
    const wv = document.createElement('webview');
    // 站点表给了 partition 就用它（deepseek 与自我复盘面板共用 ⇒ 登录态联通）；没给才按 key 各建一个
    wv.setAttribute('partition', site.partition || ('persist:webai-' + key));
    // UA 也必须在首次导航前设好（加载后再改要重载才生效）；没写 userAgent 的站点一个字都不动
    const ua = resolveEmbedUA(site.userAgent);
    if (ua) wv.setAttribute('useragent', ua);
    wv.setAttribute('allowpopups', '');
    // 2026-10-17 按 dg-dsh 派单：**不再关掉后台节流**（实测闲置 14 个隐藏面板全速跑 ≈1.12 核 / 5.2 GB）。
  //   删掉 backgroundThrottling=no ⇒ 交给 Electron 默认：前台那个不节流、隐藏的自动节流（定时器 1 Hz、不重绘）。
    wv.setAttribute('src', site.url);
    body.appendChild(wv);

    const mask = document.createElement('div');
    mask.className = 'webai-mask';
    mask.innerHTML = '<div class="webai-spin"></div><div class="webai-mask-t">正在加载 ' + site.name + ' …</div>';
    body.appendChild(mask);

    el.appendChild(head);
    el.appendChild(body);
    WEB_AI_ST.layer.appendChild(el);

    o = webAiWins[key] = { el: el, wv: wv, mask: mask, host: host, key: key, site: site };
    o.btn = document.querySelector('.webai-btn[data-key="' + key + '"]');
    webAiSetStatus(key, 'loading');
    webAiBindWindow(o);
    webAiBindWebview(o);      // ★必须绑★：状态点变绿、遮罩撤掉、加载失败出"重试"全靠这几个事件
  } else if (!o.wv) {
    // 释放过：重新挂一只 webview（同一分区 ⇒ 登录态还在）
    webAiRebuildGuest(o);
  }
  if (mode === 'show') webAiShow(key);
  return o;
}

// 释放后重建 guest（保留窗口外壳与几何）
function webAiRebuildGuest(o) {
  const wv = document.createElement('webview');
  // ★必须和首次创建用同一个表达式★：否则"⏏ 释放 → 再点开"会重建到另一个分区，deepseek 的登录态就丢了
  wv.setAttribute('partition', (o.site && o.site.partition) || ('persist:webai-' + o.key));
  const ua = resolveEmbedUA(o.site && o.site.userAgent);
  if (ua) wv.setAttribute('useragent', ua);
  wv.setAttribute('allowpopups', '');
  // 2026-10-17 按 dg-dsh 派单：**不再关掉后台节流**（实测闲置 14 个隐藏面板全速跑 ≈1.12 核 / 5.2 GB）。
  //   删掉 backgroundThrottling=no ⇒ 交给 Electron 默认：前台那个不节流、隐藏的自动节流（定时器 1 Hz、不重绘）。
  wv.setAttribute('src', o.site.url);
  o.wv = wv;
  o.el.querySelector('.webai-body').insertBefore(wv, o.mask);
  webAiBindWebview(o);
  webAiSetStatus(o.key, 'loading');
  o.mask.style.display = '';
  o.mask.innerHTML = '<div class="webai-spin"></div><div class="webai-mask-t">正在加载 ' + o.site.name + ' …</div>';
}

function webAiBindWebview(o) {
  const wv = o.wv;
  if (!wv || !wv.addEventListener) return;
  const done = function () {
    webAiSetStatus(o.key, 'ready');
    if (o.mask) o.mask.style.display = 'none';
    webAiSyncNav(o);
  };
  wv.addEventListener('did-stop-loading', done);
  wv.addEventListener('did-fail-load', function (e) {
    if (e && e.errorCode === -3) return;                 // -3 = ERR_ABORTED（同页跳转/被取消），不是失败
    webAiSetStatus(o.key, 'fail');
    if (o.mask) {
      o.mask.style.display = '';
      o.mask.innerHTML = '<div class="webai-err">打不开：' + String((e && (e.errorDescription || e.errorCode)) || '未知错误') +
        '</div><div class="webai-act" data-act="retry">点这里重试</div>' +
        '<div class="webai-act" data-act="open">改用系统浏览器打开</div>';
    }
  });
  wv.addEventListener('did-navigate', function (e) { if (e && e.url) webAiSetHost(o, e.url); });
  wv.addEventListener('did-navigate-in-page', function (e) { if (e && e.url) webAiSetHost(o, e.url); });
  wv.addEventListener('page-title-updated', function (e) {
    try { o.el.querySelector('.webai-title').textContent = o.site.name + (e && e.title ? ' · ' + String(e.title).slice(0, 28) : ''); } catch (err) {}
  });
  wv.addEventListener('did-start-loading', function () { webAiSetStatus(o.key, 'loading'); });
}
function webAiSetHost(o, url) {
  try { o.host.textContent = new URL(url).host; } catch (e) { /* ignore */ }
}
function webAiSyncNav(o) {
  try {
    const q = function (a) { return o.el.querySelector('.webai-tb[data-act="' + a + '"]'); };
    const bb = q('back'), bf = q('fwd');
    if (bb) bb.disabled = !(o.wv && o.wv.canGoBack && o.wv.canGoBack());
    if (bf) bf.disabled = !(o.wv && o.wv.canGoForward && o.wv.canGoForward());
  } catch (e) { /* ignore */ }
}

function webAiBindWindow(o) {
  const el = o.el;
  // ① 拖标题栏挪窗口（不能用 app-region: drag —— 那是拖**整个应用窗口**，不是拖这个 div）
  const head = el.querySelector('.webai-head');
  let drag = null;
  head.addEventListener('mousedown', function (e) {
    if (e.target.closest && e.target.closest('.webai-tb')) return;      // 点按钮不算拖
    const r = el.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, w: r.width, h: r.height };
    webAiRaise(o);
    e.preventDefault();
  });
  window.addEventListener('mousemove', function (e) {
    if (!drag) return;
    const x = Math.min(Math.max(-drag.w + 120, e.clientX - drag.dx), window.innerWidth - 90);
    const y = Math.min(Math.max(0, e.clientY - drag.dy), window.innerHeight - 34);
    el.style.left = Math.round(x) + 'px';
    el.style.top = Math.round(y) + 'px';
  });
  window.addEventListener('mouseup', function () {
    if (!drag) return;
    drag = null;
    webAiRecordGeometry(o.key);
  });
  // ② 工具栏
  head.addEventListener('click', function (e) {
    const b = e.target.closest && e.target.closest('.webai-tb');
    if (!b) { webAiRaise(o); return; }
    const act = b.dataset.act;
    try {
      if (act === 'back') o.wv.goBack();
      else if (act === 'fwd') o.wv.goForward();
      else if (act === 'reload') { o.mask.style.display = ''; o.wv.reload(); webAiSetStatus(o.key, 'loading'); }
      else if (act === 'mini') { el.classList.toggle('mini'); b.textContent = el.classList.contains('mini') ? '▔' : '▁'; webAiRecordGeometry(o.key); }
      else if (act === 'free') webAiFree(o);
      else if (act === 'open') webAiOpenExternal(o.key);
      else if (act === 'close') webAiHide(o.key);
    } catch (err) { /* ignore */ }
  });
  // ③ 遮罩里的"重试 / 用浏览器打开"
  el.querySelector('.webai-body').addEventListener('click', function (e) {
    const a = e.target.closest && e.target.closest('.webai-act');
    if (!a) return;
    if (a.dataset.act === 'retry') {
      o.mask.style.display = '';
      o.mask.innerHTML = '<div class="webai-spin"></div><div class="webai-mask-t">正在加载 ' + o.site.name + ' …</div>';
      webAiSetStatus(o.key, 'loading');
      try { o.wv.loadURL ? o.wv.loadURL(o.site.url) : (o.wv.src = o.site.url); } catch (err) { o.wv.setAttribute('src', o.site.url); }
    } else if (a.dataset.act === 'open') webAiOpenExternal(o.key);
  });
  // ④ 鼠标按在窗口任何地方都把它抬到最前（多窗口叠着时符合直觉）
  el.addEventListener('mousedown', function () { webAiRaise(o); }, true);
  // ⑤ 拉过右下角大小 → 记下来（resize 是 CSS 的，没有事件，用 ResizeObserver）
  try {
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(function () { webAiRecordGeometry(o.key); });
      ro.observe(el);
      o.ro = ro;
    }
  } catch (e) { /* ignore */ }
}

function webAiRaise(o) {
  try {
    o.el.style.zIndex = String(++WEB_AI_ST.z);
    webAiMarkOn();
  } catch (e) { /* ignore */ }
}
function webAiOpenExternal(key) {
  const site = WEB_AI.filter(function (s) { return s.key === key; })[0];
  let url = site ? site.url : '';
  try { const o = webAiWins[key]; if (o && o.wv && o.wv.getURL) url = o.wv.getURL() || url; } catch (e) { /* ignore */ }
  try {
    if (window.app && typeof window.app.openExternal === 'function') { window.app.openExternal(url); return; }
  } catch (e) { /* ignore */ }
  try { window.open(url, '_blank'); } catch (e) { /* ignore */ }
}
function webAiFree(o) {
  try {
    if (o.ro) { o.ro.disconnect(); o.ro = null; }
    if (o.wv) {
      try { o.wv.stop(); } catch (e) {}
      try { o.wv.remove(); } catch (e) { const p = o.wv.parentNode; if (p) p.removeChild(o.wv); }
      o.wv = null;
    }
    webAiSetStatus(o.key, 'none');
    o.mask.style.display = '';
    o.mask.innerHTML = '<div class="webai-mask-t">已释放内存</div>' +
      '<div class="webai-act" data-act="retry">点这里重新加载</div>' +
      '<div class="webai-act" data-act="open">改用系统浏览器打开</div>';
  } catch (e) { /* ignore */ }
}
function webAiShow(key) {
  const o = webAiEnsure(key, '');
  if (!o) return;
  o.el.classList.remove('warm', 'mini');
  const mb = o.el.querySelector('.webai-tb[data-act="mini"]');
  if (mb) mb.textContent = '▁';
  webAiRaise(o);
  // 不做"开一个就收别的"：五个窗口互相独立（豆包和 Kimi 可以并排摆着看），
  // 每个图标只管自己那扇窗；要收就再点一次自己的图标，或点自己标题栏的 ✕。
  webAiMarkOn();
  try {
    if (o.wv && o.wv.focus) setTimeout(function () { try { o.wv.focus(); } catch (e) {} }, 0);
  } catch (e) { /* ignore */ }
}
function webAiHide(key) {
  const o = webAiWins[key];
  if (!o) return;
  o.el.classList.add('warm');
  webAiRecordGeometry(key);
  webAiMarkOn();
}
// 打开 / 收起一个站点的窗口 —— **顶栏图标和画布上的「网页版 AI 节点」共用这一个函数**
// （一个功能只留一处实现：另写一份就会出现两套窗口、两份登录态、两份 guest 内存）。
// forceShow=true 表示"只开不收"：画布上双击节点的语义是**打开**（用户原话"点击选中双击打开"），
//   窗口本来就开着的时候再双击，应该只是把它提到最前面，而不是把它收起来。
// 返回 true = 答应打开了；false = 顶栏站点表里没有这个 key（画布靠它决定要不要提示，不许静默失败）。
function webAiToggle(key, forceShow) {
  if (!WEB_AI.filter(function (s) { return s.key === key; })[0]) return false;
  const o = webAiWins[key];
  if (!forceShow && o && !o.el.classList.contains('warm')) { webAiHide(key); return true; }
  webAiShow(key);
  return true;
}
// ★导出一份给画布节点复用★（用它的地方：本文件上面 renderers.flow 里的 openWebAi）。
// 为什么多这一行：画布那节要的是"打开某个站点的窗口"，而站点表 / webview 分区 / 登录态 /
//   ⏏ 释放内存全在这一节里管着 —— 画布只认这个入口，不碰里面的细节。
// 为什么挂 window 而不是让画布直接调 webAiToggle：⟳ 会**重新求值整个文件**（页面上下文不变），
//   挂 window 上每次重跑都会被新函数覆盖、不会留旧闭包；画布那边取不到时**当场出提示**，不会静默失败。
window.__kunWebAiOpen = webAiToggle;
// ★给网页版 AI 桥的"确保挂载"入口（v3.17，2026-09-23）★
// 为什么需要：桥要往某个站的 <webview> 里打脚本，而**没挂到 DOM 上的 webview 拒绝执行**
//   （electron：`The WebView must be attached to the DOM`）⇒ 一问就 0 字失败，报错还看不懂。
//   挂载只有这一节能做（分区/遮罩/状态点都在这儿），所以给桥一个窄入口：只"显示"，不 toggle（绝不把开着的窗口关掉）。
//   桥那边只在检测到 wv.isConnected === false 时才调它。
window.__kunWebAiEnsure = function (key) {
  try {
    var o = webAiEnsure(String(key), '');
    if (!o) return false;
    if (!o.wv || o.wv.isConnected === false) webAiRebuildGuest(o);   // ⏏ 释放过 / 被卸掉 ⇒ 用同一分区重建
    webAiShow(key);
    return true;
  } catch (e) { return false; }
};
// ★2026-09-30★ 静默挂载（`__kunWebAiSilentMount`）：把窗口和 guest **建好但保持收起**（warm = opacity:0，
//   屏幕上不出现、不抢焦点、不 raise）。和上面 `__kunWebAiEnsure` 的唯一区别就是**不调 webAiShow**。
//   为什么需要它：用户当天明确要求「调用免费 AI 时不要打开新窗口」（他正在录屏，窗口自己蹦出来很恼人）；
//   但 `noWarm` 的站（deepseek）压根没建 webview ⇒ 完全不给入口就等于"必须用户手动点开"。
//   桥在"窗口没开 / guest 被释放 / 刚重载还没挂载"三种情形下改走这条 ⇒ 活照跑、屏幕上一个窗口都不多。
window.__kunWebAiSilentMount = function (key) {
  try {
    var o = webAiEnsure(String(key), 'warm');
    if (!o) return false;
    if (!o.wv || o.wv.isConnected === false) webAiRebuildGuest(o);
    return true;
  } catch (e) { return false; }
};
// 说明：没有 webAiHideOthers —— 五个窗口是互相独立的（见 webAiShow 里的注释），
// 唯一"会收起来"的动作是用户自己点：点图标切换、点 ✕、点 ⏏（释放内存）。
function webAiMarkOn() {
  try {
    Object.keys(webAiWins).forEach(function (k) {
      const btn = document.querySelector('.webai-btn[data-key="' + k + '"]');
      if (btn) btn.classList.toggle('on', !webAiWins[k].el.classList.contains('warm'));
    });
  } catch (e) { /* ignore */ }
}

// 顶栏那五个图标（插在「<机主>的工作台」字段后面；✕ 幂等：⟳ 重跑不会插第二排）
function decorateWebAi() {
  try {
    const drag = document.querySelector('#titlebar .titlebar-drag');
    const brand = document.querySelector('#titlebar .brand');
    if (!drag || !brand) return;
    webAiAdopt();                                    // ⟳ 之后先把旧窗口认领回来
    let strip = document.getElementById('webai-strip');
    if (!strip) {
      strip = document.createElement('span');
      strip.id = 'webai-strip';
      strip.className = 'webai-strip';
      strip.setAttribute('role', 'group');
      strip.setAttribute('aria-label', '网页版 AI');
      brand.parentNode.insertBefore(strip, brand.nextSibling);   // ★紧跟品牌字段之后
    }
    WEB_AI.forEach(function (site, i) {
      let btn = strip.querySelector('.webai-btn[data-key="' + site.key + '"]');
      if (!btn) {
        btn = document.createElement('button');
        btn.className = 'webai-btn';
        btn.dataset.key = site.key;
        btn.dataset.st = 'none';
        btn.dataset.fb = site.fallback;
        btn.title = site.name + '（点一下开一个窗口，再点收起）' + (site.tip ? '　·　' + site.tip : '');
        const img = document.createElement('img');
        img.src = site.icon;
        img.alt = site.name;
        img.draggable = false;
        img.onerror = function () { try { btn.classList.add('noimg'); this.remove(); } catch (e) {} };
        btn.appendChild(img);
        btn.addEventListener('click', function () {
          // 已开着 → 再点收起；否则打开。判定/动作都在 webAiToggle 里（画布节点走的是同一个函数）
          webAiToggle(site.key);
        });
        strip.appendChild(btn);
      }
    });
    // ★预热★ 只排一轮（按站点表下标错峰 700ms 一个，别在启动瞬间五个站点一起抢网络）。
    // 状态记在 WEB_AI_ST.warmed 上 ⇒ 点「⟳」重跑这个函数也不会再排第二轮、不会再建第二套窗口。
    // ★但必须先确认壳侧放行了这些站点的"自身跳转"（app.caps.webaiGuestFreeNav）：
    //   老壳（main.js 未换）会把站点自己的一次跳转/登录 SSO 丢给系统浏览器并取消导航 ⇒
    //   一开 GUI 就自动弹出豆包/智谱的网页，而且千问/智谱的登录框被掐掉。
    //   老壳下干脆不预热（点开时才加载），重启一次 GUI 后这个能力位出现，预热自动恢复。
    const warmOk = !!(window.app && window.app.caps && window.app.caps.webaiGuestFreeNav);
    if (!WEB_AI_ST.warmed && warmOk) {
      WEB_AI_ST.warmed = true;
      WEB_AI.forEach(function (s, k) {   // k 只是站点表下标、用来错峰（跳过 noWarm 的站会留个空档，无害）
        if (s.noWarm) return;             // 不预热的站：点开时才建 webview（省一份常驻 guest 内存）
        setTimeout(function () { try { webAiEnsure(s.key, 'warm'); } catch (e) { /* 单个站点失败不影响别的 */ } }, k * 700);
      });
    } else if (!WEB_AI_ST.warmed && !WEB_AI_ST.warmOff) {
      WEB_AI_ST.warmOff = true;
      if (window.console && console.info) {
        console.info('[webai] 壳还是旧策略（main.js/preload.js 需重启 GUI）→ 暂不预热，避免自动弹出系统浏览器');
      }
      const tip = '　·　重启一次 GUI 后自动开启"秒开预热"';
      WEB_AI.forEach(function (site) {
        const b = strip.querySelector('.webai-btn[data-key="' + site.key + '"]');
        if (b && b.title.indexOf('重启一次 GUI') < 0) b.title += tip;
      });
    }
    webAiMarkOn();
  } catch (e) { /* 装饰失败不影响工作台 */ }
}

// ============ 标题栏右上角：把 emoji 按钮换成"线性浅灰图标" ============
// 为什么也放这里：改 index.html 要重启 GUI，而这个文件点 ⟳ 就重新执行 → 换图标立刻生效。
// 风格对齐"技能"按钮（16×16 内联 SVG、currentColor 继承 .tb-btn 的浅灰、悬停变亮）。
// 图标取"精简有代表性"：外观=月牙（深/浅色）、插件=插头、模型与提供方=芯片。
var TOOLBAR_ICONS = {
  'btn-theme':
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
  'btn-plugins':
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<path d="M6 2.6v2.2M10 2.6v2.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>' +
    '<path d="M3.9 4.8h8.2v2.6a4.1 4.1 0 0 1-8.2 0V4.8Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>' +
    '<path d="M8 11.5v1.9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  'btn-models':
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<rect x="4.6" y="4.6" width="6.8" height="6.8" rx="1.4" stroke="currentColor" stroke-width="1.3"/>' +
    '<rect x="6.9" y="6.9" width="2.2" height="2.2" rx="0.6" stroke="currentColor" stroke-width="1.2"/>' +
    '<path d="M6.6 2.6v2M9.4 2.6v2M6.6 11.4v2M9.4 11.4v2M2.6 6.6h2M2.6 9.4h2M11.4 6.6h2M11.4 9.4h2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
};
function decorateToolbarIcons() {
  try {
    Object.keys(TOOLBAR_ICONS).forEach(function (id) {
      const btn = document.getElementById(id);
      if (!btn) return;
      if (btn.getAttribute('data-icon') === 'svg') return;   // 幂等：换过就不再动
      btn.innerHTML = TOOLBAR_ICONS[id];
      btn.setAttribute('data-icon', 'svg');
    });
  } catch (e) { /* 换图标失败不影响功能 */ }
}

// 引擎版本与"本壳适配版本"不一致时：小点转琥珀色（呼吸光效保留），一眼能看出"该核对一下了"
function highlightEngineMismatch(on) {
  try {
    const dot = document.getElementById('brand-dot');
    if (dot) dot.classList.toggle('brand-dot-warn', !!on);
    const brand = document.querySelector('.brand');
    if (brand) brand.title = on ? ('引擎版本与适配版本不一致：引擎 v' + engineMismatch + '，本壳适配 v' + ADAPTED_ENGINE) : '';
  } catch (e) { /* ignore */ }
}

// ── 场景标签图标（外壳 renderer.js 里 ICONS 的"热更新版"）────────────────────
// 为什么放这里：`renderer.js` 是外壳，改它要重启应用；本文件随标题栏「⟳ 刷新」重载并重建。
// 这里按场景 id 覆写标签图标 ⇒ 换图标立刻生效，不必重启，两边写法保持一致即可。
// oa-ops：服务器机柜（两片机架 + 绿色指示灯 + 插槽），比原来的云朵更贴合"OA 运维"。
var SCENARIO_ICONS = {
  // 命令（command，2026-10-26）：与 renderer.js 的 NEURON_SVG 同一份
  'command':
    '<svg width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.7 4.5 8 2.9l4.4 1.7M3 8.4l.7-3.9M8 2.9l.4 5.2M12.4 4.6 8.4 8.1M8.4 8.1l3.8 3.4M8.4 8.1l-3.8 4.1M3 8.4l5.4-.3" stroke="#8fb4ff" stroke-width=".85" stroke-linecap="round" opacity=".6"/><circle cx="3.7" cy="4.5" r="1.45" fill="#8fb4ff"/><circle cx="8" cy="2.9" r="1.15" fill="#8fb4ff" opacity=".85"/><circle cx="12.4" cy="4.6" r="1.25" fill="#8fb4ff"/><circle cx="3" cy="8.4" r="1.05" fill="#8fb4ff" opacity=".8"/><circle cx="8.4" cy="8.1" r="1.85" fill="#f0a35e"/><circle cx="12.2" cy="11.5" r="1.15" fill="#8fb4ff" opacity=".85"/><circle cx="4.6" cy="12.2" r="1.05" fill="#8fb4ff" opacity=".8"/></svg>',
  // 工作台定制（workbench-custom，2026-10-26）：与 renderer.js 的 WORKBENCH_SVG 同一份
  'workbench-custom':
    '<svg width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2" y="2.4" width="12" height="11.2" rx="1.9" fill="#8fb4ff"/><circle cx="4.05" cy="3.5" r=".48" fill="#0b1220" opacity=".45"/><circle cx="5.6" cy="3.5" r=".48" fill="#0b1220" opacity=".45"/><rect x="3.5" y="4.9" width="4" height="3.2" rx=".7" fill="#0b1220" opacity=".55"/><rect x="8.5" y="4.9" width="4" height="3.2" rx=".7" fill="#0b1220" opacity=".55"/><rect x="3.5" y="8.6" width="4" height="3.2" rx=".7" fill="#0b1220" opacity=".55"/><rect x="8.72" y="8.28" width="4" height="3.2" rx=".7" fill="#f0a35e"/></svg>',
  // 2026-10-19「B站」：这里的内容是 innerHTML 插入 ⇒ 要写 <img> 标签（不是路径）
  'bilibili': '<img src="assets/bilibili-icon.png" width="17" height="17" alt="" style="display:block">',
  // 2026-10-26「刷抖音」：抖音官方 favicon 转 PNG（32×32，去背白）
  'douyin': '<img src="assets/douyin-icon.png" width="17" height="17" alt="" style="display:block">',
  'oa-ops':
    '<svg width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<rect x="2" y="2.6" width="12" height="4.7" rx="1.2" fill="currentColor"/>' +
    '<rect x="2" y="8.7" width="12" height="4.7" rx="1.2" fill="currentColor" opacity=".8"/>' +
    '<circle cx="4.4" cy="4.95" r="1" fill="#3ddc84"/>' +
    '<circle cx="4.4" cy="11.05" r="1" fill="#3ddc84"/>' +
    '<rect x="6.6" y="4.45" width="5.4" height="1" rx=".5" fill="#0b1220" opacity=".45"/>' +
    '<rect x="6.6" y="10.55" width="5.4" height="1" rx=".5" fill="#0b1220" opacity=".45"/></svg>',
  // video-workflow：胶片 + 播放三角（与 renderer.js 的 FILM_SVG 同一份，两边保持一致）
  'video-workflow':
    '<svg width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<rect x="2" y="2.4" width="12" height="11.2" rx="1.8" fill="#8fb4ff"/>' +
    '<circle cx="4.7" cy="4.9" r=".8" fill="#0b1220" opacity=".55"/>' +
    '<circle cx="8" cy="4.9" r=".8" fill="#0b1220" opacity=".55"/>' +
    '<circle cx="11.3" cy="4.9" r=".8" fill="#0b1220" opacity=".55"/>' +
    '<circle cx="4.7" cy="11.1" r=".8" fill="#0b1220" opacity=".55"/>' +
    '<circle cx="8" cy="11.1" r=".8" fill="#0b1220" opacity=".55"/>' +
    '<circle cx="11.3" cy="11.1" r=".8" fill="#0b1220" opacity=".55"/>' +
    '<path d="M6.6 6.7l3.8 2.3-3.8 2.3z" fill="#0b1220" opacity=".8"/></svg>',
  // self-review：环形箭头（复盘/回顾）+ 文档页（与 renderer.js 的 REVIEW_SVG 同一份，两边保持一致）
  'self-review':
    '<svg width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<path d="M13.1 8A5.1 5.1 0 1 1 11.4 4.1" stroke="#8fb4ff" stroke-width="1.5" stroke-linecap="round"/>' +
    '<path d="M13.5 2.2v3h-3" stroke="#8fb4ff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<rect x="5.6" y="5.9" width="4.8" height="6.2" rx="1" fill="#8fb4ff" opacity=".85"/>' +
    '<rect x="6.9" y="7.6" width="2.2" height=".9" rx=".45" fill="#0b1220" opacity=".5"/>' +
    '<rect x="6.9" y="9.4" width="2.2" height=".9" rx=".45" fill="#0b1220" opacity=".5"/></svg>',
  // stock-analysis：「<机主>的分析助手」→ 同花顺官方图标（用户 2026-09-26 指定；
  // 由 scripts\fetch-hithink-icon.mjs 从 10jqka 官网抓到 renderer\assets\hithink-icon.png（32×32 PNG；
  // 那个网址后缀是 .ico、content-type 也写 image/x-icon，但真实字节是 PNG —— 脚本按魔数认格式），
  // 换版式了重跑那个脚本即可）。这里用 <img>：renderer.js 只认 .png，热更新版不受那个限制。
  'stock-analysis':
    '<img class="tab-ico-img" src="assets/hithink-icon.png" alt="">',
  // dsh-gui：窗口 + 三块面板（右下那块琥珀色高亮 = 正在改造的那块）。
  // 原为"窗口 + 两条滑杆"，像"设置"而不像"改造界面"（2026-09-26 用户要求换）；与 renderer.js 的 PANELS_SVG 同一份。
  'dsh-gui':
    '<svg width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<rect x="2" y="2.7" width="12" height="10.6" rx="1.6" fill="#4f8cff" opacity=".26"/>' +
    '<rect x="2" y="2.7" width="12" height="10.6" rx="1.6" stroke="#8fb4ff" stroke-width="1.1"/>' +
    '<rect x="2.6" y="4.5" width="10.8" height="1" fill="#8fb4ff" opacity=".45"/>' +
    '<circle cx="4.15" cy="3.6" r=".5" fill="#8fb4ff" opacity=".85"/>' +
    '<circle cx="5.85" cy="3.6" r=".5" fill="#8fb4ff" opacity=".85"/>' +
    '<rect x="3.4" y="6.5" width="4.3" height="5.3" rx=".8" fill="#8fb4ff" opacity=".38"/>' +
    '<rect x="8.7" y="6.5" width="4.1" height="2.2" rx=".8" fill="#8fb4ff" opacity=".38"/>' +
    '<rect x="8.7" y="9.6" width="4.1" height="2.2" rx=".8" fill="#f0a35e"/></svg>',
  // design-misc（设计杂活，2026-09-26 新增）：钢笔笔尖 + 落笔曲线 —— "画/做设计"的意象（用户要"有设计感"，不要 emoji）。
  // 三个候选（贝塞尔控制点 / 三层图层 / 钢笔）出过 17px 对比图，钢笔这版在真标签尺寸下最好认。
  // 与 renderer.js 的 DESIGN_SVG 同一份，两边保持一致。
  'design-misc':
    '<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<path d="M1.8 13.6c0-5 2.8-8.4 6.8-8.4 2.3 0 3.5 1.2 3.5 2.8 0 2-1.7 3.1-3.9 3.1-1.9 0-3.2.7-4.1 1.9" stroke="#8fb4ff" stroke-width="1.4" stroke-linecap="round"/>' +
    '<path d="M11.1 2.1 14 5l-3.3.9z" fill="#f0a35e"/>' +
    '<circle cx="1.9" cy="13.4" r="1.15" fill="#f0a35e"/></svg>',
  // code-dev（程序开发，2026-10-22 新增）：代码尖括号 + 斜杠；与 renderer.js 的 CODE_SVG 是同一份。
  'code-dev':
    '<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<path d="M5.2 4.1 2 8l3.2 3.9" stroke="#8fb4ff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M10.8 4.1 14 8l-3.2 3.9" stroke="#8fb4ff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M9.2 2.8 6.8 13.2" stroke="#f0a35e" stroke-width="1.5" stroke-linecap="round"/></svg>',
    // pc-cleanup（电脑清理，2026-10-06 新增）：用量环 —— "分区占用"的意象；与 renderer.js 的 CLEAN_SVG 是同一份。
    'pc-cleanup':
      '<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
      '<circle cx="8" cy="8" r="5.4" stroke="#8fb4ff" stroke-width="1.7" opacity=".35"/>' +
      '<path d="M8 2.6a5.4 5.4 0 0 1 5.2 4" stroke="#f0a35e" stroke-width="1.7" stroke-linecap="round"/>' +
      '<circle cx="8" cy="8" r="1.7" fill="#8fb4ff"/></svg>',
};
// ============ 电脑清理场景：磁盘分区面板（C / D / E / F 四个分区的大小）============
// 数据：宿主 IPC app.sys.disks()（main.js 用 fs.statfsSync 只读算总量/剩余）。
// ⚠ 缺这个命名空间 = 主进程还是旧的（本次动的就是 main.js/preload.js）⇒ 要**重启一次 GUI** 才有实时读数；
//   没重启前面板显示提示而不是空白（面板代码本身是 ⟳ 热更新的）。
// 危险度配色：<70% 绿 · 70~89% 黄 · ≥90% 红 —— 一眼看出哪个盘该清。
// 2026-10-10 美化 + 占满：顶部总览条（总量/已用/剩余/最紧张）+ 四张"占比环"卡 + 底部图例，
//   网格改成 `auto 1fr 1fr auto` 撑满整格 —— 老版是 `align-content:start`，内容堆在顶上、下半格全空。
renderers['pc-drives'] = (body) => {
  body.classList.add('pc-drives-body');
  const K = window.app && window.app.sys;
  const wrap = el('div', 'pc-drives');
  body.appendChild(wrap);
  let disposed = false;
  const GB = 1073741824;
  const fmt = (b) => (b == null ? '--' : ((b / GB) >= 100 ? (b / GB).toFixed(0) : (b / GB).toFixed(1)) + ' GB');
  const fmtBig = (b) => { if (b == null) return '--'; const g = b / GB; return g >= 1024 ? (g / 1024).toFixed(2) + ' TB' : g.toFixed(0) + ' GB'; };
  const level = (p) => (p >= 90 ? 'bad' : (p >= 70 ? 'warn' : 'ok'));
  // 分区角色：用户 2026-10-10 明确的定位 —— D 主要存软件 / E 主要存文件 / F 是游戏盘
  const ROLE = { 'C:': '系统盘', 'D:': '软件盘', 'E:': '文件盘', 'F:': '游戏盘' };
  const RING_R = 33, RING_C = 2 * Math.PI * RING_R;

  // 占比环：SVG 描边 + 虚线偏移（矢量，缩放不糊；比进度条更像仪表盘）
  function ringOf(pct, lv) {
    const NS = 'http://www.w3.org/2000/svg';
    const mk = (t) => document.createElementNS(NS, t);
    const svg = mk('svg');
    svg.setAttribute('viewBox', '0 0 80 80');
    svg.setAttribute('class', 'pc-ring');
    const bg = mk('circle');
    bg.setAttribute('cx', '40'); bg.setAttribute('cy', '40'); bg.setAttribute('r', String(RING_R));
    bg.setAttribute('class', 'pc-ring-bg');
    const fg = mk('circle');
    fg.setAttribute('cx', '40'); fg.setAttribute('cy', '40'); fg.setAttribute('r', String(RING_R));
    fg.setAttribute('class', 'pc-ring-fg ' + lv);
    fg.setAttribute('stroke-dasharray', RING_C.toFixed(2));
    const p = Math.max(0, Math.min(100, pct));
    fg.setAttribute('stroke-dashoffset', (RING_C * (1 - p / 100)).toFixed(2));
    fg.setAttribute('transform', 'rotate(-90 40 40)');   // 从 12 点方向起画
    svg.appendChild(bg); svg.appendChild(fg);
    const box = el('div', 'pc-ring-wrap');
    box.appendChild(svg);
    box.appendChild(el('span', 'pc-ring-txt ' + lv, Math.round(pct) + '%'));
    return box;
  }
  function kv(k, v) {
    const row = el('div', 'pc-drive-line');
    row.appendChild(el('span', 'pc-k', k));
    row.appendChild(el('span', 'pc-v', v));
    return row;
  }
  function paint(rows, note) {
    if (disposed) return;
    wrap.innerHTML = '';
    if (note) { wrap.appendChild(el('div', 'pc-drives-note', note)); return; }
    const list = (rows || []).filter(Boolean);
    const live = list.filter((d) => d.ok);
    // ① 顶部总览条
    const tot = live.reduce((a, d) => a + (d.total || 0), 0);
    const used = live.reduce((a, d) => a + (d.used || 0), 0);
    const free = live.reduce((a, d) => a + (d.free || 0), 0);
    const worst = live.slice().sort((a, b) => b.percent - a.percent)[0];
    const sum = el('div', 'pc-drives-sum');
    const item = (k, v, cls) => {
      const it = el('div', 'pc-sum-item');
      it.appendChild(el('span', 'pc-sum-k', k));
      it.appendChild(el('span', 'pc-sum-v' + (cls ? ' ' + cls : ''), v));
      return it;
    };
    sum.appendChild(item('总容量', fmtBig(tot)));
    sum.appendChild(item('已用', fmtBig(used)));
    sum.appendChild(item('剩余', fmtBig(free)));
    if (worst) sum.appendChild(item('最紧张', String(worst.drive) + ' ' + worst.percent.toFixed(1) + '%', level(worst.percent)));
    const hhmmss = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    sum.appendChild(el('span', 'pc-sum-hint', PC_SEL.drive ? ('已选 ' + PC_SEL.drive + ' → 右侧只看它') : '点分区卡 → 右侧看该盘大户'));
    sum.appendChild(el('span', 'pc-sum-time', hhmmss + ' 读数 · 每 10 秒自动刷新'));
    wrap.appendChild(sum);
    // ② 四张分区卡（可点：选中 ⇒ 右侧「磁盘大户排行」切成这个盘；再点一次取消）
    list.forEach((d) => {
      const lv = d.ok ? level(d.percent) : 'off';
      const sel = d.drive && PC_SEL.drive === d.drive;
      const card = el('div', 'pc-drive-card ' + lv + (sel ? ' sel' : ''));
      if (d.ok) {
        card.title = '点一下：右侧「磁盘大户排行」只看 ' + d.drive + (sel ? '（再点一次取消）' : '');
        card.addEventListener('click', () => pcSelectDrive(d.drive));
      }
      if (d.ok) card.appendChild(ringOf(d.percent, lv));
      const info = el('div', 'pc-drive-info');
      const top = el('div', 'pc-drive-top');
      top.appendChild(el('span', 'pc-drive-name', String(d.drive || '?')));
      if (ROLE[d.drive]) top.appendChild(el('span', 'pc-drive-role', ROLE[d.drive]));
      if (sel) top.appendChild(el('span', 'pc-drive-badge', '已选'));
      info.appendChild(top);
      if (d.ok) {
        info.appendChild(kv('已用', fmt(d.used)));
        info.appendChild(kv('剩余', fmt(d.free)));
        info.appendChild(kv('总量', fmt(d.total)));
      } else {
        info.appendChild(kv('状态', d.err === 'ENOENT' ? '无此分区' : '未就绪'));
      }
      card.appendChild(info);
      wrap.appendChild(card);
    });
    // ③ 底部图例（颜色含义 + 清理纪律一句）
    const lg = el('div', 'pc-drives-legend');
    [['ok', '＜70% 宽裕'], ['warn', '70~89% 该留意'], ['bad', '≥90% 该清']].forEach((p) => {
      const s = el('span', 'pc-lg ' + p[0]);
      s.appendChild(el('i', 'pc-lg-dot'));
      s.appendChild(el('span', null, p[1]));
      lg.appendChild(s);
    });
    lg.appendChild(el('span', 'pc-lg-note', '清理纪律：先列清单等你点头 → 直接删（无暂存，技能 pc-cleanup）'));
    wrap.appendChild(lg);
  }
  async function load() {
    if (disposed) return;
    if (!K || !K.disks) { paint([], '宿主还没重启：磁盘容量要重启一次 GUI 才会实时读数（面板已就位）。'); return; }
    try {
      const r = await K.disks();
      if (disposed) return;
      if (!r || !r.ok || !Array.isArray(r.drives)) { paint([], '读磁盘失败：' + ((r && r.err) || '未知')); return; }
      paint(r.drives, '');
    } catch (e) { paint([], '读磁盘异常：' + ((e && e.message) || e)); }
  }
  load();
  pcOnSelect(() => { if (!disposed) load(); });   // 点某个盘 ⇒ 立刻重画，把选中态亮出来
  const t = setInterval(load, 10000);
  return () => { disposed = true; clearInterval(t); };   // ★ cleanup：切场景/热更新时停掉，不泄漏
};

// ============ 电脑清理场景：三块数据面板（2026-10-10 立）============
//   ① pc-toplarge 磁盘大户排行   ② pc-stage 清理暂存   ③ pc-ledger 清理台账
// 数据来源：① ② 读 `data\pc-cleanup-scan.json`（由 scripts\pc-scan.mjs 产出）；
//          ③ 读 `data\pc-cleanup-log.json`（每清一次由 AI 追加一条）。
// ⛔ 面板**自己不能扫盘**：渲染层只有 app.file.read/write/stat，没有列目录 IPC ⇒ 数据必须由脚本产出。
//    也正因为纯读 JSON，这三块全是 ⟳ 热更新，不用重启 GUI。
var PC_DATA = {
  scan: ((window.app && window.app.paths && window.app.paths.dataDir) || '.') + '\\pc-cleanup-scan.json',
  log: ((window.app && window.app.paths && window.app.paths.dataDir) || '.') + '\\pc-cleanup-log.json',
};

// 跨面板联动：点磁盘分区面板里的某个盘 ⇒ 大户排行面板单独显示这个盘（再点一次取消，回到全盘）。
// 两块面板在同一个文档里，所以一个模块级变量 + 订阅就够，不用 IPC（也不惊动 main.js ⇒ 保持 ⟳ 热更新）。
var PC_SEL = { drive: '' };
var PC_SEL_SUBS = [];
function pcSelectDrive(d) {
  const next = String(d || '');
  PC_SEL.drive = (PC_SEL.drive === next) ? '' : next;   // 再点同一个 = 取消
  PC_SEL_SUBS.forEach((f) => { try { f(); } catch (e) { /* 单个订阅出错不影响别人 */ } });
}
function pcOnSelect(fn) { PC_SEL_SUBS.push(fn); }

// 读 JSON：文件不存在 = "还没扫过"（正常空态，不是错误）
function pcReadJson(file) {
  const F = window.app && window.app.file;
  if (!F || !F.read) return Promise.resolve({ err: '宿主还没重启：读文件要重启一次 GUI 才有 app.file。' });
  return F.read(file).then((res) => {
    if (!res || !res.ok) return { missing: true };
    try { return { data: JSON.parse(res.text), mtime: res.mtime }; }
    catch (e) { return { err: 'JSON 解析失败：' + ((e && e.message) || e) }; }
  }).catch((e) => ({ err: '读取异常：' + ((e && e.message) || e) }));
}
var pcGb = (n) => (n == null ? '--' : (n >= 1024 ? (n / 1024).toFixed(2) + ' TB' : (n >= 100 ? Number(n).toFixed(0) : Number(n).toFixed(1)) + ' GB'));
var pcBase = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || p;
var pcOpen = (fn, target) => {
  const A = window.app && window.app.app;
  if (!A || !A[fn]) return;
  try { A[fn](target); } catch (e) { /* 打不开就算了，不弹错 */ }
};
/** 面板骨架：定时重读 JSON —— 我重扫完你不用点 ⟳，十几秒内面板自己就变了。
 *  onReady(wrap, tick)：注册跨面板联动用（比如"点了某个盘就重画"）。 */
function pcPanel(body, cls, everyMs, render, onReady) {
  body.classList.add(cls);
  const wrap = el('div', 'pc-panel');
  body.appendChild(wrap);
  let disposed = false;
  const tick = () => { if (!disposed) render(wrap); };
  tick();
  if (onReady) { try { onReady(wrap, tick); } catch (e) { /* ignore */ } }
  const t = setInterval(tick, everyMs || 15000);
  return () => { disposed = true; clearInterval(t); };   // ★ cleanup
}
function pcEmpty(wrap, msg) { wrap.appendChild(el('div', 'pc-hint', msg)); }

// ① 磁盘大户排行：谁最占地方，点一行在资源管理器里定位。
// **联动**：点了磁盘分区面板里的某个盘 ⇒ 这里只显示那个盘（标题变成「C: 单盘排行」+ 显示全部按钮）；
// 默认（没选盘）= 全盘 Top N。数据分别是 byDrive[盘] / items。
function pcRenderTopLarge(wrap) {
  pcReadJson(PC_DATA.scan).then((r) => {
    wrap.innerHTML = '';
    if (r.missing) return pcEmpty(wrap, '还没扫过。让 AI 跑一次扫描（scripts\\pc-scan.mjs），这里就会列出最占地方的目录。');
    if (r.err) return pcEmpty(wrap, r.err);
    const d = r.data || {};
    const sel = PC_SEL.drive;
    const items = sel ? ((d.byDrive || {})[sel] || []) : (d.items || []);
    const when = d.scannedAt ? new Date(d.scannedAt).toLocaleString('zh-CN', { hour12: false }).slice(5) : '?';
    const head = el('div', 'pc-panel-head');
    if (sel) {
      head.appendChild(el('span', 'pc-sel-tag', sel + ' 单盘排行'));
      const back = el('button', 'pc-mini-btn', '显示全部');
      back.title = '回到全盘排行（也可以再点一次那个分区卡）';
      back.addEventListener('click', () => pcSelectDrive(''));
      head.appendChild(back);
    } else {
      head.appendChild(el('span', null, '全盘排行'));
    }
    head.appendChild(el('span', 'pc-panel-head-sub', '上次扫描 ' + when + ' · 用时 ' + (d.tookSec || '?') + 's'));
    wrap.appendChild(head);
    if (!items.length) {
      return pcEmpty(wrap, sel ? (sel + ' 上没有超过 ' + (d.minGb || 0.5) + ' GB 的目录。') : '扫描结果里没有超过 ' + (d.minGb || 0.5) + ' GB 的目录。');
    }
    const max = items[0].gb || 1;
    const list = el('div', 'pc-rank');
    items.forEach((it, i) => {
      const row = el('div', 'pc-rank-row');
      row.title = it.path + '\n（点击在资源管理器里定位）';
      const bar = el('i', 'pc-rank-bar');
      bar.style.width = Math.max(2, Math.round((it.gb / max) * 100)) + '%';
      row.appendChild(bar);
      row.appendChild(el('span', 'pc-rank-no', String(i + 1)));
      const nm = el('span', 'pc-rank-name');
      nm.appendChild(el('b', null, pcBase(it.path)));
      nm.appendChild(el('i', null, String(it.path).slice(0, String(it.path).length - pcBase(it.path).length - 1)));
      row.appendChild(nm);
      row.appendChild(el('span', 'pc-rank-gb', pcGb(it.gb)));
      row.addEventListener('click', () => pcOpen('revealPath', it.path));
      list.appendChild(row);
    });
    wrap.appendChild(list);
    if (!sel) wrap.appendChild(el('div', 'pc-foot', '点左边任意分区卡 → 这里只看那个盘'));
  });
}
renderers['pc-toplarge'] = (body) => {
  // ⚠ 显式 cleanup：check-gui 第 4 项按"本渲染器 → 下一个 renderers[...]"切片认这个形状
  const stop = pcPanel(body, 'pc-toplarge-body', 15000, pcRenderTopLarge, (wrap, tick) => pcOnSelect(tick));
  return () => stop();
};

// ② 可清理体检：常扫的缓存/临时位置逐项体积，一眼看出哪里又长回来了。
// ⚠ 2026-10-10 用户定：**清理直接删除，不要"清理暂存"这一步**（原来那块面板已废）。
renderers['pc-junk'] = (body) => {
  const stop = pcPanel(body, 'pc-junk-body', 20000, (wrap) => {
    pcReadJson(PC_DATA.scan).then((r) => {
      wrap.innerHTML = '';
      if (r.missing) return pcEmpty(wrap, '还没扫过。让 AI 跑一次扫描（scripts\\pc-scan.mjs），这里列出各处的缓存体积。');
      if (r.err) return pcEmpty(wrap, r.err);
      const d = r.data || {};
      const junk = d.junk || [];
      // ⚠ 必须显示扫描时刻：面板数据是快照，清理完不重扫的话这些数字是旧的（曾把已删的 7.36 GB 还列在上面）
      const when = d.scannedAt ? new Date(d.scannedAt).toLocaleString('zh-CN', { hour12: false }).slice(5) : '?';
      wrap.appendChild(el('div', 'pc-panel-head', '上次扫描 ' + when + ' · 点一行打开位置'));
      const big = el('div', 'pc-big');
      big.appendChild(el('b', 'pc-big-num', pcGb(d.junkTotalGb != null ? d.junkTotalGb : junk.reduce((a, j) => a + (j.gb || 0), 0))));
      big.appendChild(el('span', 'pc-big-k', '体检合计 · ' + junk.length + ' 项'));
      wrap.appendChild(big);
      if (!junk.length) return pcEmpty(wrap, '这次扫描没量到可清理项。');
      junk.slice(0, 6).forEach((j) => {
        const row = el('div', 'pc-line clickable');
        row.title = j.k + '\n' + (j.path || '') + (j.note ? '\n' + j.note : '') + '\n（点击打开所在位置）';
        row.appendChild(el('span', 'pc-line-m', j.k));
        row.appendChild(el('span', 'pc-line-v', pcGb(j.gb)));
        row.addEventListener('click', () => pcOpen('openPath', j.path));
        wrap.appendChild(row);
      });
      wrap.appendChild(el('div', 'pc-foot', '要我清就说一声 —— 按新规矩直接删，不留暂存'));
    });
  });
  return () => stop();
};

// ③ 清理台账：历次清了什么、释放多少、累计多少
// ⚠ 这里必须写成显式 `return () => stop()`：check-gui 第 4 项是按"本渲染器 → 下一个 renderers[...]"
//   切片去找 cleanup 形状的，而 pc-ledger 后面隔着几千行无关代码（里面有 setInterval），
//   简写形式会被误判成"用了定时器却不返回 cleanup"。
renderers['pc-ledger'] = (body) => {
  const stop = pcPanel(body, 'pc-ledger-body', 20000, (wrap) => {
    pcReadJson(PC_DATA.log).then((r) => {
      wrap.innerHTML = '';
      if (r.err) return pcEmpty(wrap, r.err);
      const es = (r.data && r.data.entries) || [];
      const total = es.reduce((a, e) => a + (Number(e.freed) || 0), 0);
      const big = el('div', 'pc-big');
      big.appendChild(el('b', 'pc-big-num', pcGb(total)));
      big.appendChild(el('span', 'pc-big-k', '累计释放 · ' + es.length + ' 次'));
      wrap.appendChild(big);
      if (!es.length) return pcEmpty(wrap, '还没有清理记录。清完一次我会往台账里追加一条。');
      es.slice().reverse().slice(0, 6).forEach((e) => {
        const row = el('div', 'pc-line');
        row.title = (e.what || '') + (e.note ? '\n' + e.note : '');
        row.appendChild(el('span', 'pc-line-k', String(e.date || '').slice(5)));
        row.appendChild(el('span', 'pc-line-m', e.what || ''));
        row.appendChild(el('span', 'pc-line-v accent', '+' + (Number(e.freed) || 0).toFixed(2)));
        wrap.appendChild(row);
      });
    });
  });
  return () => stop();
};

function decorateScenarioIcons() {
  try {
    Object.keys(SCENARIO_ICONS).forEach(function (id) {
      const ico = document.querySelector('#scenario-tabs .tab[data-sc-id="' + id + '"] .tab-ico');
      if (!ico) return;
      // 幂等靠"比对内容"：原来只记一个 'svg' 标记 ⇒ 同一个 id 换了新图标（新 SVG / 换成图片）后，
      // ⟳ 会被这个标记挡住、永远不更新（用户换了图标却看不见变化）。现在把上次写进去的内容存在
      // data-icon 里，内容变了才重写 —— 既幂等（重复调用不闪），又能跟着改。
      const html = SCENARIO_ICONS[id];
      if (ico.getAttribute('data-icon') === html) return;
      ico.innerHTML = html;
      ico.setAttribute('data-icon', html);
      ico.style.opacity = '1';   // emoji 那套 14px / opacity .85 的样式对 SVG/图片不适用
    });
  } catch (e) { /* 换图标失败不影响功能 */ }
}

// ── 场景标签栏：拖拽换位（浏览器标签页那种丝滑）+ 未激活标签收成图标 ─────────────────────
// 分工：标签 DOM 由外壳 renderer.js 建（改外壳要重启 GUI），**交互在这一层** ⇒ 随 ⟳ 重载，调手感不必重启。
// 外壳建完标签调一次 initScenarioTabBar({ nav, persist, pinnedIds }) 即可。
// 稳定性要点（几条都是"会真出事"的）：
//   ① 用**指针事件 + setPointerCapture**，不用 HTML5 DnD：幽灵图丑、落点时机不可控、和 click 抢事件；
//   ② 拖动超过阈值 ⇒ 这一次的 click 在 capture 阶段就被吞掉 ⇒ **拖标签绝不会误切场景**（老实现就有这毛病）；
//   ③ 落位用"占位格 + 其它标签 FLIP 位移"，被拖的标签脱流跟着指针走 ⇒ 视觉上就是浏览器标签在让位；
//   ④ 幂等：容器上记 data-tabbar 版本，⟳ 重复调用只重排状态、不叠加监听；
//   ⑤ 顺序**只报给外壳**（外壳交主进程存），这一层自己不存 —— 单一权威在 main.js，避免两份顺序打架。
var TABBAR_VERSION = 'tabs-2026-09-26.1';
var TAB_COLLAPSED_W = 33;   // 收起后只留图标：17px 图标 + 7px×2 内边距 + 2px 边框

function tabListOf(nav) {
  return Array.prototype.filter.call(nav.children, function (n) {
    return n && n.classList && n.classList.contains('tab');
  });
}

/** 落点 → 目标下标（**纯函数**，只吃 rect 数字 ⇒ 好单测）。
 *  规则与浏览器一致：从左往右，第一个"中心点在指针右侧"的标签就是插入点；都不满足则插到末尾。 */
function tabDropIndex(rects, dropX) {
  for (var i = 0; i < rects.length; i++) {
    if (dropX < (rects[i].left + rects[i].right) / 2) return i;
  }
  return rects.length;
}

/** 固定组规则（场景 json 里 "first": true，如 Blender）：它们永远排在最前 ——
 *  拖固定标签 ⇒ 只能在自己那一组内换位；拖别的标签 ⇒ 插不到固定组前面。
 *  纯函数，好单测；这条就是"顺序不会乱"的关键。 */
function tabClampTarget(target, dragIsPinned, fixedCount) {
  if (dragIsPinned) return Math.min(target, fixedCount);
  return Math.max(target, fixedCount);
}

/** 其它标签要平移时用 FLIP 补动画：先记位置 → 改 → 用 transform 抵消跳变 → 下一帧放开。 */
function flipNav(nav, mutate) {
  var tabs = tabListOf(nav);
  // 先把在飞的 FLIP transform 清干净（拖得快时上一个动画还没结束，叠加起来会抖）
  tabs.forEach(function (t) { t.style.transition = 'none'; t.style.transform = ''; });
  void nav.offsetWidth;   // 强制回流：让上面的清理落定，下面的 before 才是干净的位置
  var before = tabs.map(function (t) { return t.getBoundingClientRect().left; });
  mutate();
  var after = tabs.map(function (t) { return t.getBoundingClientRect().left; });
  tabs.forEach(function (t, i) {
    var d = before[i] - after[i];
    if (!d || Math.abs(d) < 0.5) return;
    t.style.transition = 'none';
    t.style.transform = 'translateX(' + d + 'px)';
    requestAnimationFrame(function () {
      t.style.transition = '';
      t.style.transform = '';
    });
  });
}

/** 收起 / 展开：激活的、鼠标悬停的、正在拖的**始终展开**，其余只留图标。 */
function applyTabCollapse(nav, keepOpen) {
  tabListOf(nav).forEach(function (t) {
    var open = t === keepOpen || t.classList.contains('active') || t.classList.contains('tab-dragging');
    t.classList.toggle('tab-collapsed', !open);
  });
}

/** 量"展开时的自然宽度"与"文字宽度"，存成 CSS 变量 —— 两端都是 px，width / max-width 才可过渡
 *（悬停展开之所以丝滑，靠的就是这个：上游标签宽度在动画，后面的标签每帧跟着重排，不需要 JS 逐帧）。 */
function measureTabWidths(nav) {
  var tabs = tabListOf(nav);
  tabs.forEach(function (t) {
    t.classList.remove('tab-collapsed');
    t.style.removeProperty('--tab-w');
    t.style.removeProperty('--label-w');
  });
  tabs.forEach(function (t) {
    var w = Math.ceil(t.getBoundingClientRect().width);
    if (w > 0) t.style.setProperty('--tab-w', (w + 1) + 'px');
    var lab = t.querySelector('.tab-label');
    if (lab) {
      var lw = Math.ceil(lab.scrollWidth);
      if (lw > 0) t.style.setProperty('--label-w', lw + 'px');
    }
    t.style.setProperty('--tab-cw', TAB_COLLAPSED_W + 'px');
  });
}

function initScenarioTabBar(opts) {
  opts = opts || {};
  var nav = opts.nav || document.getElementById('scenario-tabs');
  if (!nav) return null;
  if (nav.getAttribute('data-tabbar') === TABBAR_VERSION) {   // 幂等：⟳ 只重排状态，不叠加监听
    measureTabWidths(nav);
    applyTabCollapse(nav);
    return null;
  }
  nav.setAttribute('data-tabbar', TABBAR_VERSION);
  measureTabWidths(nav);

  var pinnedIds = opts.pinnedIds || [];
  var isPinned = function (t) { return pinnedIds.indexOf(t.dataset.scId) >= 0; };
  var pinnedCountExcept = function (t) {
    return tabListOf(nav).filter(function (x) { return x !== t && isPinned(x); }).length;
  };
  var drag = null, suppressClick = false, suppressTimer = null;

  // ---- 悬停丝滑展开（事件委托：标签重建也不用重绑）----
  nav.addEventListener('mouseover', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('.tab') : null;
    if (t && t.parentNode === nav) applyTabCollapse(nav, t);
  });
  nav.addEventListener('mouseout', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('.tab') : null;
    if (!t || t.parentNode !== nav) return;
    var to = e.relatedTarget;
    if (to && t.contains(to)) return;      // 在标签内部挪动不算移出
    applyTabCollapse(nav);
  });

  // ---- 拖动换位 ----
  var beginDrag = function () {
    var t = drag.tab;
    // 尺寸/起点一律用 offset*（相对 nav，且**不含 transform**）—— 用 getBoundingClientRect 的话，
    // 上一次 FLIP 还在飞时会把 transform 偏移算进来，拖动中就会跳。
    drag.width = t.offsetWidth; drag.height = t.offsetHeight;
    drag.startLeft = t.offsetLeft;
    drag.startTop = t.offsetTop;
    var ph = el('div', 'tab-placeholder');
    ph.style.width = drag.width + 'px';
    ph.style.height = drag.height + 'px';
    nav.insertBefore(ph, t);          // 占位格替它占住原位置
    drag.ph = ph;
    t.classList.add('tab-dragging');  // 脱流，跟着指针走
    t.style.position = 'absolute';
    t.style.width = drag.width + 'px';
    t.style.height = drag.height + 'px';
    t.style.left = drag.startLeft + 'px';
    t.style.top = drag.startTop + 'px';
    nav.classList.add('tabs-dragging');
    drag.started = true;
    drag.curTarget = -1;
    applyTabCollapse(nav, t);
  };

  var placeTarget = function (target) {
    var others = tabListOf(nav).filter(function (x) { return x !== drag.tab; });
    flipNav(nav, function () {
      if (target >= others.length) nav.appendChild(drag.ph);
      else nav.insertBefore(drag.ph, others[target]);
    });
  };

  var edgeScroll = function (clientX) {
    var nr = nav.getBoundingClientRect();
    var max = nav.scrollWidth - nav.clientWidth;
    if (max <= 0) return;
    if (clientX < nr.left + 30) nav.scrollLeft = Math.max(0, nav.scrollLeft - 8);
    else if (clientX > nr.right - 30) nav.scrollLeft = Math.min(max, nav.scrollLeft + 8);
  };

  var onDown = function (e) {
    if (e.button !== 0) return;
    var t = e.target && e.target.closest ? e.target.closest('.tab') : null;
    if (!t || t.parentNode !== nav) return;
    if (e.target.closest('.tab-detach')) return;         // ⧉ 有自己的逻辑
    if (tabListOf(nav).some(function (x) { return x.classList.contains('tab-dragging'); })) return;  // 上一次还没落位
    drag = { tab: t, id: e.pointerId, startX: e.clientX, startY: e.clientY, started: false, scrollAt: nav.scrollLeft };
    try { t.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  };

  var onMove = function (e) {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.started) {
      if (Math.abs(e.clientX - drag.startX) < 5 && Math.abs(e.clientY - drag.startY) < 5) return;  // 5px 内算点击
      beginDrag();
    }
    if (e.cancelable) e.preventDefault();
    var scrollDelta = nav.scrollLeft - drag.scrollAt;
    drag.tab.style.left = (drag.startLeft + (e.clientX - drag.startX) + scrollDelta) + 'px';
    // 落点判定：用 offsetLeft/offsetWidth（**不含 transform**，且是内容坐标）——
    // 用 rect 的话，FLIP 动画在飞时会把 transform 偏移算进去 ⇒ 占位格在拖动中乱跳。
    var nr = nav.getBoundingClientRect();
    var dropX = e.clientX - (nr.left + nav.clientLeft) + nav.scrollLeft;
    var others = tabListOf(nav).filter(function (x) { return x !== drag.tab; });
    var rects = others.map(function (x) {
      return { left: x.offsetLeft, right: x.offsetLeft + x.offsetWidth };
    });
    var target = tabClampTarget(tabDropIndex(rects, dropX), isPinned(drag.tab), pinnedCountExcept(drag.tab));
    if (target !== drag.curTarget) { drag.curTarget = target; placeTarget(target); }
    edgeScroll(e.clientX);
  };

  var onUp = function (e) {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.started) { drag = null; return; }   // 没拖动 ⇒ 放行 click（正常切场景）
    var t = drag.tab, ph = drag.ph;
    // 立刻标记"这次 click 不算数"：click 紧跟在 pointerup 之后就来，不能等动画结束
    suppressClick = true;
    if (suppressTimer) clearTimeout(suppressTimer);
    suppressTimer = setTimeout(function () { suppressClick = false; }, 500);
    drag = null;
    // 落位动画：从当前位置滑到占位格（offsetLeft 同样是内容坐标，不受滚动/transform 影响）
    t.style.transition = 'left .16s cubic-bezier(.2,.8,.2,1), transform .16s ease';
    t.style.left = ph.offsetLeft + 'px';
    setTimeout(function () {
      nav.insertBefore(t, ph);                     // 按占位格的位置插回 DOM（= 新顺序）
      t.classList.remove('tab-dragging');
      ['position', 'width', 'height', 'left', 'top', 'transition', 'zIndex'].forEach(function (k) { t.style.removeProperty(k); });
      if (ph.parentNode) ph.parentNode.removeChild(ph);
      nav.classList.remove('tabs-dragging');
      measureTabWidths(nav);
      applyTabCollapse(nav);
      if (typeof opts.persist === 'function') {
        try {
          opts.persist(tabListOf(nav).map(function (x) { return x.dataset.scId; }).filter(Boolean));
        } catch (err) { /* 存档失败不影响已经换好的位置 */ }
      }
    }, 170);
  };

  // 拖动过的那一次点击要吞掉（capture 阶段抢在外壳的 click 处理之前），否则"拖标签 = 顺带切场景"
  nav.addEventListener('click', function (e) {
    if (!suppressClick) return;
    e.stopPropagation();
    e.preventDefault();
  }, true);

  nav.addEventListener('pointerdown', onDown);
  nav.addEventListener('pointermove', onMove);
  nav.addEventListener('pointerup', onUp);
  nav.addEventListener('pointercancel', onUp);
  applyTabCollapse(nav);
  return { version: TABBAR_VERSION, refresh: function () { measureTabWidths(nav); applyTabCollapse(nav); } };
}

// ---------- 会话列「铺满窗口」（场景 0 与各场景面板共用，2026-09-20 第三波）----------
// 需求原文：「现在会话又变窄了，修改一下自适应窗口的宽度，包括每个场景窗口里的 ai 会话」。
//
// ★真因（隐藏探针 `_排查脚本存档\probe-chat-width` 实测，别再靠猜）★
//   引擎 0.1.6 这条链是：会话列 = `[data-chat-flow]`（class 形如 `Rpcr1W_column`，
//   `max-width: var(--dsh-chat-content-width)`）；输入卡 = `[data-composer-card]`
//   （`max-width: var(--dsh-composer-card-max-width)`）。
//   两个变量都是**就地算**的 calc：clamp(680px, **声明它的那个元素自己的宽度** × 64%, 920px)。
//   实测 1666 宽窗口：框架内联 grid = `280px minmax(0px, 1fr) 0px` ⇒ 中列 1386 ⇒ 会话列 1386×0.64 = 887px、
//   输入卡 919px——两边各空 250px，正是用户截图里那条"又变窄了"。
//   ⚠ 老办法「把 --dsh-chat-content-width 写在 [data-phase] 上」在本版**必然失效**，两个原因：
//     ① 变量是就地算的：写在别的元素上，算出来的百分比不是会话列自己的宽度；
//     ② 本版 `[data-phase]` **不是**会话相位容器（实测全页只有 2 个，是连接状态小圆点按钮）；
//        会话列真正的锚点是 `[data-chat-flow]`。老代码拿 [data-phase] 兼作"中心列探测器"，
//        靠 `||` 兜底才没一起崩，但宽度那条早就空转了。
//     ③ 变量在**声明它的元素**上求值一次就定死 ⇒ 只改框架层，列自己那层（.embeddedBody）声明会盖掉它。
//
// 做法：三重，任何一条单独生效都能铺满，互不冲突（都是幂等的）：
//   ① 直接盖 `max-width`（不依赖任何变量，最稳）：列与输入卡都写成「父层内容盒 − 16px」——
//     父层内边距不同（会话列 32px / 输入卡 16px），于是自动得到"输入卡比列宽 32px"这个引擎原设计比例，
//     两侧留白也从实测的 250px 收到 20~40px（见下面两个常量的注释：数字是量出来的，别凭感觉改）。
//   ② 从列/输入卡一路往上（含 html/body）**逐层**内联 !important 写这两个变量 ⇒ 消息气泡、
//      markdown、审批面板等"读变量"的地方一起铺开，并压过更上层（:root/.body/.embeddedBody）的声明；
//   ③ CSS 里再写一份同样的规则，作为 JS 没跑起来时的兜底。
// 想更宽/更窄只改下面两个字符串；想彻底还原就把 HARNESS_WIDE_CSS / HARNESS_WIDE_PIN_JS 从两处链路里摘掉。
// ⚠ 这两个数是**实测调出来的**（probe-chat-width 的 before/after）：
//   会话列 `.column` 的父层自己带 32px 内边距，输入卡的父层（composer root）只带 16px ——
//   所以两边同写 `calc(100% - 16px)` 时，恰好得到「输入卡比会话列宽 32px」＝引擎原设计的关系
//   （原设计 887 / 919 就是差 32），同时各自还留 ≥8px 兜底留白（父层没内边距时也不会贴边）。
//   一开始给列写 32px 时是这个结果：列 1560 / 卡 1608，两侧留白 48 vs 24 不对称 —— 别改回去。
var HARNESS_WIDE_COL = 'calc(100% - 16px)';    // 会话列：父层内容盒 − 16px
var HARNESS_WIDE_CARD = 'calc(100% - 16px)';   // 输入卡：父层内容盒 − 16px（父层内边距更小 ⇒ 卡比列宽 32px）
var HARNESS_WIDE_CSS = [
  '[data-chat-flow] { max-width: ' + HARNESS_WIDE_COL + ' !important; }',
  '[data-composer-card] { max-width: ' + HARNESS_WIDE_CARD + ' !important; }',
  // 兜底：万一某版把这两个变量声明在别的层上，也一起压掉。CSS module 的类名 = 哈希_局部名（实测
  // `Rpcr1W_column` / `nrbKnG_card`），所以 `[class*=...]` 这种子串匹配是可靠的。
  '[class*="embeddedBody"], [class*="column"] { --dsh-chat-content-width: ' + HARNESS_WIDE_COL +
  ' !important; --dsh-composer-card-max-width: ' + HARNESS_WIDE_CARD + ' !important; }'
].join('\n');
// ②的 JS 版：列/输入卡自身 + 祖先链逐层写变量，并**自维持**（宿主只投几次，页面重渲染后自己纠回来）。
// 返回给宿主看的实测小字：「1列 1576/1592px」= 铺满了几列 · 列宽 / 可用宽。
// 判读：两者只差十几像素（正是我们留的那 16px）= 已铺满；还差几百像素 = 没铺上（多半引擎换版、锚点没了）。
// ⚠ 自维持定时器带 window 级守卫：宿主每 1.5 秒重注入一次（连续 30 秒），不守卫就会攒出几十个循环。
var HARNESS_WIDE_PIN_JS = `(() => {
  var COL = ${JSON.stringify(HARNESS_WIDE_COL)}, CARD = ${JSON.stringify(HARNESS_WIDE_CARD)};
  var pinOnce = function () {
    var layers = 0;
    var pin = function (el) {
      while (el && el.nodeType === 1) {
        try {
          el.style.setProperty('--dsh-chat-content-width', COL, 'important');
          el.style.setProperty('--dsh-composer-card-max-width', CARD, 'important');
        } catch (e) {}
        layers++; el = el.parentElement;
      }
    };
    var cols = document.querySelectorAll('[data-chat-flow]');
    for (var i = 0; i < cols.length; i++) { try { cols[i].style.setProperty('max-width', COL, 'important'); } catch (e) {} pin(cols[i]); }
    var cards = document.querySelectorAll('[data-composer-card]');
    for (var j = 0; j < cards.length; j++) { try { cards[j].style.setProperty('max-width', CARD, 'important'); } catch (e) {} pin(cards[j]); }
    var c0 = cols[0], pw = 0, w = 0;
    // ⚠ 分母必须是"可用宽"＝父层**内容盒**（clientWidth 去掉左右内边距），不能用父层 border box：
    //    max-width 里的 % 就是对这个内容盒算的。实测父层 border box 1656 / 内容盒 1592 / 列 1576 ⇒ 只差 16px。
    if (c0) {
      try {
        w = c0.getBoundingClientRect().width;
        var p = c0.parentElement || c0, cs = null;
        try { cs = getComputedStyle(p); } catch (e2) {}
        pw = p.clientWidth - ((cs && parseFloat(cs.paddingLeft)) || 0) - ((cs && parseFloat(cs.paddingRight)) || 0);
      } catch (e) {}
    }
    return { cols: cols.length, cards: cards.length, layers: layers, w: Math.round(w), pw: Math.round(pw) };
  };
  var r = pinOnce();
  try { if (!window.__kunWideTimer) window.__kunWideTimer = setInterval(pinOnce, 2000); } catch (e) {}
  return r.cols + '列 ' + r.w + '/' + r.pw + 'px';
})()`;
// 场景 0 = index.html 里的 #harness-webview：**引擎原生界面，设计上不做任何精简注入**（不隐藏侧栏/顶栏），
// 所以这里只投"铺满"这一件事（CSS 兜底 + JS 逐层压变量），别的布局一律不动。
// ⚠ 只作用于 #harness-webview；各场景面板（bl-ai / oa-ai / site-ai / mk-chat）走的是本文件里的
//   HARNESS_CHAT_CSS + HARNESS_FIX_JS 那条独立链路，两条链路共用上面这组常量，但互不干扰。
var HARNESS_MAIN_WIDE_CSS = HARNESS_WIDE_CSS;
function widenMainHarnessView() {
  try {
    var wv = document.getElementById('harness-webview');
    if (!wv) return;
    var apply = function () {
      try {
        var p = wv.insertCSS(HARNESS_MAIN_WIDE_CSS);
      
        if (p && p.catch) p.catch(function () { /* 页面还没就绪，后面还有补投 */ });
      } catch (e) { /* 同上 */ }
      // JS 那一半：既压变量又量宽度；页面没就绪时 executeJavaScript 会 reject，忽略即可。
      try {
        var q = wv.executeJavaScript(HARNESS_WIDE_PIN_JS);
        if (q && q.catch) q.catch(function () { /* 同上 */ });
      } catch (e) { /* 同上 */ }
    };
    apply();
    if (wv.getAttribute('data-wide-hook') !== '1') {
      wv.setAttribute('data-wide-hook', '1');
      // 冷启动时引擎要十几秒才渲染完，靠这两个事件在页面真正加载时补投
      try { wv.addEventListener('dom-ready', apply); } catch (e) { /* ignore */ }
      try { wv.addEventListener('did-finish-load', apply); } catch (e) { /* ignore */ }
    }
    // SPA 渲染晚于 did-finish-load：再补两次（重复插入同一条 CSS 无害）
    setTimeout(apply, 1500);
    setTimeout(apply, 4000);
  } catch (e) { /* 加宽失败不影响功能 */ }
}

// ── 底部菜单栏收进顶栏（2026-09-20，用户要求）──────────────────────────────
// 需求原文：「把场景下面的菜单 有个序号开关移到最顶的菜单栏，下面的菜单栏不要了以便于节省空间，
//            最下面的窗口下边框向下扩展占满原来的下部菜单」。
// 底部那条 `#scenario-footer`（「菜单」+「序号：开/关」）里只有一个开关，却占了一整条 40px 的横条；
// 把开关搬到顶栏、底栏整个删掉，`#grid` 是 `flex: 1; min-height: 0`，底栏一走它自动向下撑满
// （`#scenario-view` 的 10px 内边距保留，和左右上一致）→ 最下排面板的下边框就落到原底栏的位置。
//
// 为什么放 renderers.js（而不是改 index.html / renderer.js）：本文件随标题栏「⟳」重载 ⇒ **点 ⟳ 就生效，
// 不必重启 GUI**；改 `index.html` / `renderer.js` 是外壳，必须重启。与上面 decorateBrand /
// decorateScenarioIcons 同一个理由（renderer.js 里的注释也写着这条）。
// ⚠ 只**搬节点**、不新建按钮：renderer.js 里 `#sf-badges` 的 click 监听绑在按钮本体上，
//   `applyBadges()` 也是按 id 找它写文字（『序号：开/关』）——同一个节点搬过去，监听与文字更新都跟着走，
//   renderer.js 一行都不用改（改它就等于要重启）。幂等：重复执行只是再确认一次位置。
function moveSceneToggleToTopbar() {
  try {
    const btn = document.getElementById('sf-badges');
    if (btn) {
      const controls = document.querySelector('#titlebar .titlebar-controls');
      if (controls && !controls.contains(btn)) {
        btn.classList.remove('sf-btn');                       // 底栏的样式换成顶栏按钮的样式
        btn.classList.add('tb-btn', 'tb-tools', 'tb-badges');
        btn.title = '显示/隐藏窗口序号徽标（原底部菜单，已收进顶栏）';
        const ref = document.getElementById('btn-refresh');   // 排在「⟳ 刷新当前场景」右边（同为场景级操作）
        if (ref && ref.parentNode === controls) controls.insertBefore(btn, ref.nextSibling);
        else controls.insertBefore(btn, controls.firstChild);
        // 亮不亮跟着文字走（renderer.js 的 applyBadges 只改文字，不给状态）：开=高亮，关=普通
        const sync = function () {
          try { btn.dataset.on = /开/.test(btn.textContent) ? '1' : '0'; } catch (e) { /* ignore */ }
        };
        sync();
        btn.addEventListener('click', function () { setTimeout(sync, 0); });
      }
    }
    const footer = document.getElementById('scenario-footer');   // 底栏整个不要了
    if (footer && footer.parentNode) footer.parentNode.removeChild(footer);
  } catch (e) { /* 收纳失败不影响功能（最坏情况 = 还是原来那条底栏） */ }
}

/**
 * 2026-10-24（宿主：「把序号外观远程控制 放在⋯里」）——
 * 把这三个顶栏按钮藏起来（**只加 class，不删节点**）：
 *   ① renderer.js 的点击监听、`applyBadges()` 的文字同步都绑在节点本身上 ⇒ 节点必须留着；
 *   ② ⋯ 菜单里那三行就是替宿主 .click() 这个隐藏按钮 ⇒ 点一次走的是原来同一套逻辑，零改动；
 *   ③ 幂等：反复调用只是再确认一次 class。id 找不到（老外壳）就安静跳过。
 */
function hideMovedTopbarButtons() {
  try {
    ['btn-remote', 'btn-theme', 'sf-badges'].forEach(function (id) {
      var b = document.getElementById(id);
      if (!b) return;
      b.classList.add('tb-moved');
      b.setAttribute('data-moved-to', 'more-menu');
    });
  } catch (e) { /* 藏不掉就还是留在顶栏，不影响功能 */ }
}

/**
 * 自动装标签栏交互（不需要外壳配合）。
 * 为什么要这一段：外壳 renderer.js 里那次调用要**重启 GUI** 才生效，而热更新只重跑本文件。
 * 于是这里自己兜底：
 *   ① 把老外壳给标签设的 HTML5 `draggable` 摘掉 —— 它的 dragstart/drop 监听还在，但 draggable=false
 *      之后 dragstart 永远不会触发 ⇒ 老 DnD 自动失效，不会和新指针拖拽抢事件；
 *   ② 顺序照样能存：新外壳走主进程（setSceneOrder），老外壳退回 localStorage 的老 key
 *      （老外壳开机就读这个 key，所以**重启也不会复位**）。
 * 开机时标签可能还没建出来（外壳 init 是异步的）⇒ 由下面的轻量轮询补上，装好即停。
 */
// ===== 场景标签「正在工作」光效（2026-09-29 立；用户要求：场景的 AI 在跑要发光，它派子代理时也要亮）=====
// 数据源（不用动 main.js / preload.js，纯读文件）：
//   <DSH_HOME>\storages\session_projcache\sessions\<会话id>.json —— 引擎**按会话**实时写的状态缓存（明文 JSON）。
//   判定字段：record.rows.sessionStats.val.openStep（有值 = 有一步正开着 = 真在跑）+ pendingCalls（有在飞的工具调用）。
//   为什么不用"日志文件时间"：一次 LLM 步可能好几分钟不落盘，时间法会闪；openStep 全程为真。
//   （2026-09-29 实测：全机唯一在跑的会话 openStep={"turn":24,"step":13,…}，其余 171 条全是 null。）
//   子代理：父会话在等子代理时 openStep 一直开着 ⇒ **父场景标签照样亮** —— 正是用户要的"派出去也要有光效"。
//   子代理（2026-09-29 补齐）：父会话自己的记录里 `subagentCatalog.val.head.values[].childId` 就是它派出去的子会话 id
//     （引擎侧真身是会话 header 的 `parentSession`，但会话文件是 zstd 压缩的读不了；这个投影是明文，可直接读）
//     ⇒ 顺着它递归查子孙会话的在跑状态（最多两层）⇒ **父回合已结束、子代理还在跑时，父场景标签也亮** ✓
// 标签定位：#scenario-tabs .tab[data-sc-id="<场景id>"]；场景→面板 sessionId 用 app.listScenarios/getScenario 取，
//   60 秒刷一次映射（面板换了会话也能自动跟上）。
// ⚠ 幂等：⟳ 是热更新（本文件会被重新加载、DOM 不重载）⇒ 状态与计时器挂在 window.__dshSceneGlow 上，
//   每次重载只把 S.tick 指到新函数，**永远只有一个计时器**。
var GLOW_TICK_MS = 2500;
// 引擎用户数据目录（DSH_HOME）：**空 = 运行时从 app.getVersion().engineDir 推**（换电脑/换盘符都不用改这行），
// 老宿主没有 app:version 或它没带 engineDir 时退回下面这个兜底值。2026-10-12 为"拷给别人/换机开箱即用"改。
var GLOW_HOME = window.__dshGlowHome || '';
var GLOW_HOME_FALLBACK = '<工作台>\\引擎数据\\.dsh';
async function glowHome() {
  if (GLOW_HOME) return GLOW_HOME;
  try {
    var v = (window.app && window.app.getVersion) ? await window.app.getVersion() : null;
    if (v && v.engineDir) { GLOW_HOME = v.engineDir + '\\.dsh'; return GLOW_HOME; }
  } catch (e) { /* ignore */ }
  return GLOW_HOME_FALLBACK;
}
var GLOW_READ_WINDOW_S = 900;   // 状态文件 15 分钟没动过的会话连读都不读（一步不可能开 15 分钟）

function glowTabEl(sceneId) {
  var bar = document.getElementById('scenario-tabs');
  if (!bar) return null;
  return bar.querySelector('.tab[data-sc-id="' + sceneId + '"]');
}
async function glowMapRefresh(S) {
  if (Date.now() - (S.mapAt || 0) < 60000 && Object.keys(S.sidByScene || {}).length) return;
  if (!(window.app && window.app.listScenarios && window.app.getScenario)) return;
  var list = [];
  try { list = (await window.app.listScenarios()) || []; } catch (e) { return; }
  var map = {};
  for (var i = 0; i < list.length; i++) {
    var id = list[i] && list[i].id;
    if (!id) continue;
    try {
      var sc = await window.app.getScenario(id);
      map[id] = ((sc && sc.panels) || []).filter(function (p) { return p && p.sessionId; })
        .map(function (p) { return p.sessionId; });
    } catch (e) { /* ignore */ }
  }
  if (Object.keys(map).length) { S.sidByScene = map; S.mapAt = Date.now(); }
}
// 读一条会话的状态文件 ⇒ {busy, kids}
//   busy：openStep 非空（有一步开着）/ pendingCalls 非空（工具在飞）；**只有文件够新时才认**
//   子代理兜底：它自己是子代理（rows.subagent.identity 有值）且状态文件 ≤20 秒前刚写过 ⇒ 也算在跑
//     （子代理两步之间的缝隙可能既没 openStep 也没 pendingCalls，纯靠上面两条会闪）
//   kids：父会话记录里 subagentCatalog.val.head.values[].childId = 它派出去的子会话 id
//     ⚠ 即使父会话文件已经"不新"也要采 catalog —— 子代理长时间在跑时父会话自己是不写盘的
async function glowReadState(sid, wantCatalog) {
  var out = { busy: false, kids: [] };
  if (!(window.app && window.app.file && window.app.file.stat)) return out;
  var p = (await glowHome()) + '\\storages\\session_projcache\\sessions\\' + sid + '.json';
  var ageS = Infinity;
  try {
    var st = await window.app.file.stat(p);
    if (!st || !st.exists) return out;
    ageS = Date.now() / 1000 - (Number(st.mtime) || 0);
  } catch (e) { return out; }
  if (ageS > GLOW_READ_WINDOW_S && !wantCatalog) return out;
  try {
    var res = await window.app.file.read(p);
    var txt = (typeof res === 'string') ? res : (res && (res.text || res.data || res.content || res.body));
    if (!txt) return out;
    var rows = JSON.parse(txt).record.rows;
    var ss = rows && rows.sessionStats && rows.sessionStats.val;
    var isChild = !!(rows && rows.subagent && rows.subagent.val && rows.subagent.val.identity);
    if (ageS <= GLOW_READ_WINDOW_S && ss) {
      out.busy = !!(ss.openStep || (ss.pendingCalls && Object.keys(ss.pendingCalls).length));
      if (!out.busy && isChild && ageS <= 20) out.busy = true;
    }
    var cat = wantCatalog && rows && rows.subagentCatalog && rows.subagentCatalog.val;
    var vals = cat && cat.head && cat.head.values;
    if (Array.isArray(vals)) out.kids = vals.map(function (v) { return v && v.childId; }).filter(Boolean);
  } catch (e) { /* ignore */ }
  return out;
}
// 场景在跑 = 它自己的会话在跑 **或** 它派出去的子孙会话在跑（子代理干活时父场景标签也亮）
async function glowTick() {
  var S = window.__dshSceneGlow;
  if (!S) return;
  await glowMapRefresh(S);
  if (!S.kids) S.kids = {};
  // 每 60 秒重采一次"父会话 → 子会话"清单（顺带把子会话的子会话也收进来，最多两层）
  if (!S.watch || Date.now() - (S.watchAt || 0) > 60000) {
    var watch = [];
    Object.keys(S.sidByScene || {}).forEach(function (sc) { watch = watch.concat(S.sidByScene[sc] || []); });
    for (var pass = 0; pass < 2; pass++) {
      for (var w = 0; w < watch.length; w++) {
        var st = await glowReadState(watch[w], true);
        if (st.kids.length) {
          S.kids[watch[w]] = st.kids;
          st.kids.forEach(function (k) { if (watch.indexOf(k) < 0) watch.push(k); });
        }
      }
    }
    S.watch = watch; S.watchAt = Date.now();
  }
  var cache = {};
  async function busyOf(sid, seen) {
    if (sid in cache) return cache[sid];
    if (seen[sid]) return false;
    seen[sid] = 1;
    var st = await glowReadState(sid, false), busy = st.busy;
    var kids = S.kids[sid] || [];
    for (var i = 0; i < kids.length && !busy; i++) busy = await busyOf(kids[i], seen);
    cache[sid] = busy;
    return busy;
  }
  var ids = Object.keys(S.sidByScene || {});
  for (var n = 0; n < ids.length; n++) {
    var sids = S.sidByScene[ids[n]] || [], busy = false;
    for (var k = 0; k < sids.length && !busy; k++) busy = await busyOf(sids[k], {});
    var tab = glowTabEl(ids[n]);
    if (!tab) continue;                                    // 标签还没建出来 / 独立窗口里没有它
    if (busy === tab.classList.contains('tab-working')) continue;
    tab.classList.toggle('tab-working', busy);             // 只有状态变了才写 DOM，平时零开销
  }
}
// 幂等启动：状态与计时器挂 window.__dshSceneGlow ⇒ ⟳ 热更新后旧计时器跑的是新代码，永远只有一个计时器
function ensureSceneGlow() {
  var S = window.__dshSceneGlow = window.__dshSceneGlow || { sidByScene: {}, mapAt: 0 };
  S.tick = glowTick;
  if (!S.timer) {
    S.timer = setInterval(function () {
      try { (window.__dshSceneGlow && window.__dshSceneGlow.tick ? window.__dshSceneGlow.tick : function () {})(); }
      catch (e) { /* ignore */ }
    }, GLOW_TICK_MS);
  }
  try { S.tick(); } catch (e) { /* ignore */ }
}

function autoInitScenarioTabBar() {
  var nav = document.getElementById('scenario-tabs');
  if (!nav || !nav.querySelector('.tab')) return false;
  if (nav.getAttribute('data-tabbar') === TABBAR_VERSION) return true;   // 已装过（外壳那次也会命中这里）
  tabListOf(nav).forEach(function (t) { t.draggable = false; t.removeAttribute('draggable'); });
  var persist = function (ids) {
    try {
      if (window.app && window.app.setSceneOrder) window.app.setSceneOrder(ids);     // 新外壳：主进程是权威
      else localStorage.setItem('scenarioTabOrder', JSON.stringify(ids));            // 老外壳：老 key，重启能被读走
    } catch (e) { /* 存档失败不影响已经换好的位置 */ }
  };
  Promise.resolve(window.app && window.app.listScenarios ? window.app.listScenarios() : [])
    .then(function (list) {
      // 固定组（"first": true）从场景表里现取，跟外壳那次用同一份数据 ⇒ 规则一致
      var pinned = (list || []).filter(function (s) { return s && s.first; })
        .map(function (s) { return s.id; });
      initScenarioTabBar({ nav: nav, persist: persist, pinnedIds: pinned });
    })
    .catch(function () { initScenarioTabBar({ nav: nav, persist: persist, pinnedIds: [] }); });
  return true;
}
// 轮询只在"还没装上"时活着，装上就停；用 window 旗标防止 ⟳ 反复重载攒出多个定时器
function ensureScenarioTabBar() {
  if (autoInitScenarioTabBar()) return;
  if (window.__kunTabBarRetry) return;
  var tries = 0;
  window.__kunTabBarRetry = setInterval(function () {
    if (autoInitScenarioTabBar() || ++tries > 40) {   // 最多 ~12 秒，够外壳把标签建出来
      clearInterval(window.__kunTabBarRetry);
      window.__kunTabBarRetry = null;
    }
  }, 300);
}
function decorateShell() {
  // 标签栏放**最前**：上面这些装饰函数任何一个抛错都会截断本函数，而标签栏交互不能因此装不上。
  try { ensureScenarioTabBar(); } catch (e) { /* 装不上就是"老样子"，不影响别的功能 */ }
  try { ensureSceneGlow(); } catch (e) { /* 光效装不上就只是没有光效，不影响别的功能 */ }
  decorateBrand();
  decorateToolbarIcons();
  decorateScenarioIcons();
  decorateWebAi();          // 顶栏五个网页版 AI 图标 + 预热（⟳ 重跑幂等）
  moveSceneToggleToTopbar();
  hideMovedTopbarButtons(); // 2026-10-24：序号 / 外观 / 远程控制 已收进 ⋯ ⇒ 顶栏这三个按钮藏起来
  widenMainHarnessView();
}
// 脚本在 </body> 前加载 → DOM 已就绪；万一以后挪进 head，这里也能补上
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', decorateShell, { once: true });
} else {
  decorateShell();
}


// 场景分离窗口（主进程 loadFile 时带 ?solo=1&scene=<id>）里的引擎界面分区。
// ⚠ 2026-09-19 三次定稿：AI 面板**不再**共用这个分区了，一律走 panelPartition（见下）。
// 这个函数现在只服务"没带 sessionId 的面板"：主窗口退回 persist:harness，
// 分离窗口必须"一窗一分区"（否则两个窗口互相改写 localStorage['dsh.sessions.current']，
// 引擎用它记住"上次会话"，会把对方带到别的会话去）。
function soloHarnessPartition() {
  try {
    var q = new URLSearchParams(location.search);
    if (!q.get('solo')) return 'persist:harness';
    var sid = String(q.get('scene') || 'x').replace(/[^a-zA-Z0-9_-]/g, '');
    return 'persist:harness-solo-' + (sid || 'x');
  } catch (e) { return 'persist:harness'; }
}

// ★每个 AI 面板用哪个分区★ 2026-09-19 三次定稿（这一次是探针实测定的，别再往回合）：
// 引擎事实：面板显示哪个会话，取决于应用启动时从 localStorage['dsh.sessions.current'] 恢复的那一个
// （packages/api/session-controller/src/client/sessions/service.ts 的 persist 名），
// 而**一个分区里只有这一个键**——它不区分标签、不区分面板。
//   结论一：两个面板**共用**一个分区 ⇒ 那个键只能表示"最后动过的那个面板" ⇒ 谁也没法被稳定钉住
//     （用户实感：「切过来是别的会话」「左右两个窗口都变成同一个会话」）。
//   结论二（2026-09-19 探针实测，**推翻**旧结论）：全新分区里"写好这个键 + reload"是**能直接进会话的**——
//     隐藏 Electron + 真引擎实测（<盘根>:\DSH\工具\probe-seed\）：写入目标 sessionId 后 reload，
//     1.4 秒后 document.title 就变成目标会话、正文 231 → 23031 字符、不再停欢迎页。
//     旧注释里"新分区只能停在欢迎页"是**看太早**造成的误判（那次快照在 reload 后 1 秒内就下了结论）。
//   ✓ 所以最终方案：**一板一分区**（panelPartition）＋ 每个面板往**自己的**键里写目标 id、reload 一次。
//     分区私有 ⇒ 两边写的是两个不同的 localStorage ⇒ 互抢/互刷在结构上不可能（"每隔一会跳一下刷新"不会再有）。
//   ✓ 代价：每个面板**第一次**打开会先闪一下欢迎页（约 1–2 秒）再 reload 到位；之后键里已经是目标 ⇒ 直接进、不再 reload。
function panelPartition(meta) {
  try {
    var solo = false, sid = '';
    try {
      var q = new URLSearchParams(location.search);
      solo = !!q.get('solo');
      sid = String(q.get('scene') || '').replace(/[^a-zA-Z0-9_-]/g, '');
    } catch (e) { solo = false; sid = ''; }
    var key = String((meta && meta.id) || '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (meta && meta.sessionId && key) {
      // ① 带 sessionId（scenarios/*.json 里所有 AI 面板都必须带，见 scripts\sessions.mjs --check）：
      //    一板一分区；分离窗口再带上场景名，避免"同场景开两个窗口"时两个窗口共用一个分区。
      return solo ? ('persist:harness-panel-' + (sid || 'x') + '-' + key) : ('persist:harness-panel-' + key);
    }
    // ② 没带 sessionId：主窗口共用 persist:harness；分离窗口退回一窗一分区。
    return soloHarnessPartition();
  } catch (e) { return 'persist:harness'; }
}

// ============ harness：直接内嵌 DSH 引擎 对话窗口（带 sessionId 的面板一板一分区，见 panelPartition） ============
// ==================== 盘中雷达（radar 面板 · 2026-10-13 建）====================
// 定位：场景内的独立盯盘程序（不占 选股建议 的页签、不调用 AI、不消耗 token）。
// 数据：持仓 1.5s（腾讯行情 IPC）· 全市场榜单 3s（东财 clist IPC）· 板块 4s（Python 直连东财，走 stock:script:run）
// 命中即：面板内大卡片 + 提示音 + Windows 系统通知 + 事件流留痕。
// 规则沿用记忆表 kind=alert_rules（与「选股建议 · 🔔 提示」同一份 ⇒ AI 改一处两边都生效）。
// ---- 统一兜底取数（2026-10-14）------------------------------------------------
// 背景：东财 push2 的 clist（多股列表）接口在本机会被整段丢弃（RemoteDisconnected，
// 换镜像号 / 加 ut / 换协议都无效），而工作台的榜单 / 板块 / 机会票全依赖它
// ⇒ 三个扫描页签集体退回本地缓存、雷达"板块 0 个"。统一改走 scripts\mkt-fallback.py：
// 东财优先、失败自动降级到新浪 / 腾讯，并把真实来源(src)带回来给界面标注；
// 东财失败后脚本自身熔断 5 分钟（state 文件），不再每次白等 1.5 秒。
var MK_FALLBACK = '<工作台>\\外壳\\scripts\\mkt-fallback.py';
// 场景专属数据仓库（2026-10-14 建）：榜单/机会池/板块落库 + 基本面采集 + 调研报告
// 与 OA 场景的 data\oa.db 同一套"场景专属库"约定；CLI 与 mkt-fallback.py 同构，故共用这个 runner。
var MK_WH = '<工作台>\\外壳\\scripts\\warehouse.py';   // ★2026-10-15 从 data\stock\ 搬进 scripts\（进得了 backup 快照）
// ---- 买不了的板（2026-10-14 用户要求）：创业板 300/301、科创板 688/689 ----
// 这些票**只当板块参考**：不进机会池、不进机会事件、不弹窗，也不进「波段启动 / 超跌反弹」候选清单。
// （行情榜单快照照旧全收，方便复盘和看板块；情绪/涨停池是全市场口径，也不受影响。）
// 2026-10-14 追加：**北交所 43/83/87/88/920** 一并屏蔽 —— 权限门槛 50 万（创业板 10 万），
// 用户总资产 2.35 万，这三类都开不了；北交所还是 30% 涨跌幅 + ST 妖股扎堆，留着只会误导。
// 若哪天开了权限，从这里删掉对应前缀即可，**记得同步仓库侧 warehouse.py 的 NOBUY**。
var MK_NOBUY = ['300', '301', '688', '689', '43', '83', '87', '88', '920'];
var noBuy = function (code) {
  var c = String(code == null ? '' : code).replace(/^(sh|sz|bj)/i, '');
  return MK_NOBUY.some(function (p) { return c.indexOf(p) === 0; });
};
// 2026-10-14 显示用（用户："这个机会提示要显示票号，不然不好搜"）：
// 票号一律显示成 6 位纯数字（去掉 sh/sz/bj 前缀与 .SH/.SZ/.BJ 后缀），方便直接复制去行情软件搜。
// ⚠ 只用于"显示"：别拿它替换匹配/联动用的 keyOf（那边的语义保持原样，免得动到规则匹配）。
var mkC6 = function (code) {
  return String(code == null ? '' : code).replace(/^(sh|sz|bj)/i, '').replace(/\.(SH|SZ|BJ)$/i, '');
};
// 机会池分档（2026-10-14 从 makeRadar 提到顶层：雷达页签与「🚀 机会池」页签必须同一口径，
// 两处各写一份迟早跑偏）。A=涨停/触板 B=急拉≥5% C=温和2~5% D=微涨0~2%
var mkTierOf = function (x) {
  var pct = Number(x && x.pct), lp = Number(x && x.limitPct);
  if (x && (x.atLimit || (isFinite(lp) && lp > 0 && pct >= lp - 0.6))) return 'A';
  if (pct >= 5) return 'B';
  if (pct >= 2) return 'C';
  return 'D';
};
var TIER_MINI = { A: '涨停/触板', B: '急拉≥5%', C: '温和2~5%', D: '微涨0~2%' };

// ============ 机会票打分（2026-10-14 用户要求：给票打分 · 分析要具体 · 不能全是"打板"）============
// 为什么需要它：口径改成"拉涨即机会"之后，池里常年 60~110 只 —— A 档已封死的板和微涨 0.2% 的票
// 混在一起，光按涨幅排等于把"根本买不到"的推到最前面（用户原话"全是机会总不能全部都打板"）。
// 所以分数**不是"推荐买入"**，而是把票按「能不能参与、以什么方式参与」排队，并且每条都给出
// 可核对的理由（全部来自本地榜单字段，不联网、不耗 token）：
//   动能 0~30（涨幅/是否已封板）+ 量价 0~25（换手健康区）+ 市值 0~15
//   + 共振 0~15（池内同字号链条 + 领涨板块名粗匹配）+ 早板 0~10 − 风险扣分 0~40
// 真正有用的是 **act 动作**：已封板（打板买不到 → 看次日溢价）/ 冲板中 / 追涨 / 低吸 / 观察 / 回避。
// ⚠ 分数是本地规则的相对排序，不构成投资建议；理由是"数据长这样"，不是"该不该买"。
var MK_ACT = {
  seal:  { t: '已封板', o: 1, d: '已封死在涨停 ⇒ 打板买不到，只能看次日溢价（或炸板回封）' },
  board: { t: '冲板中', o: 2, d: '贴近涨停但未封 ⇒ 只能追板/排板，破板即走（高风险）' },
  chase: { t: '追涨',   o: 3, d: '急拉 5%~9.5% ⇒ 右侧追，别接在长上影上' },
  dip:   { t: '低吸',   o: 4, d: '温和 2%~5% 且换手健康 ⇒ 等回踩，不追高' },
  watch: { t: '观察',   o: 5, d: '涨幅小 / 缩量 / 回落 ⇒ 只进池记录，暂不参与' },
  avoid: { t: '回避',   o: 6, d: '有硬风险（ST / 爆量 / 深回落 / 高位连板）⇒ 不碰' }
};
var MK_F2 = function (v, d) { var n = Number(v); return isFinite(n) ? n.toFixed(d == null ? 2 : d) : '--'; };
var mkHM = function (ts) {
  var d = new Date(ts), p = function (n) { return n < 10 ? '0' + n : '' + n; };
  return p(d.getHours()) + ':' + p(d.getMinutes());
};
var mkStName = function (name) { return /ST|退/.test(String(name || '')); };
// 领涨板块名与股票名**粗匹配**（没有成分股映射，只能按名称窗口匹配；4 字窗口优先，减少"XX科技"式误配）
var mkOppBoardHit = function (name, boards) {
  var n = String(name || '');
  if (n.length < 2 || !boards || !boards.length) return '';
  for (var i = 0; i < boards.length && i < 24; i++) {
    var b = boards[i];
    if (!b || !b.n || !(Number(b.p) > 1)) continue;
    var bn = String(b.n);
    for (var L = 4; L >= 2; L--) {
      for (var j = 0; j + L <= bn.length; j++) {
        if (n.indexOf(bn.substr(j, L)) >= 0) return bn + ' +' + MK_F2(b.p) + '%（名称粗匹配）';
      }
    }
  }
  return '';
};
var mkOppScore = function (x, ctx) {
  ctx = ctx || {};
  var why = [], risk = [];
  var pct = Number(x.pct) || 0, turn = Number(x.turn) || 0;
  var yi = (Number(x.mcap) || 0) / 1e8;
  var atLimit = !!x.atLimit, st = mkStName(x.name);
  var hist = (x.hist && x.hist.length ? x.hist : [pct]);
  var hi = Math.max.apply(null, hist);
  var lbc = (ctx.zt && ctx.zt[x.code]) || 0;
  var s = 0;
  // ① 动能 0~30
  if (atLimit) { s += 30; why.push('已封板'); }
  else if (pct >= 9.5) { s += 28; why.push('贴近涨停 ' + MK_F2(pct) + '%'); }
  else if (pct >= 7) { s += 24; why.push('大涨 ' + MK_F2(pct) + '%'); }
  else if (pct >= 5) { s += 21; why.push('急拉 ' + MK_F2(pct) + '%'); }
  else if (pct >= 3) { s += 15; why.push('中阳 ' + MK_F2(pct) + '%'); }
  else if (pct >= 2) { s += 12; why.push('温和 ' + MK_F2(pct) + '%'); }
  else { s += 6; why.push('微涨 ' + MK_F2(pct) + '%'); }
  // ② 量价：换手健康区 0~25（<1% 无量、3~15% 接力健康、>25% 多半派发）
  if (turn >= 3 && turn <= 15) { s += 25; why.push('换手 ' + MK_F2(turn) + '% 健康'); }
  else if (turn > 15 && turn <= 25) { s += 16; why.push('换手 ' + MK_F2(turn) + '% 偏大'); }
  else if (turn >= 1 && turn < 3) { s += 13; why.push('换手 ' + MK_F2(turn) + '% 偏轻'); }
  else if (turn > 25) { s += 4; risk.push('换手 ' + MK_F2(turn) + '% 过大（派发/接盘）'); }
  else { s += 7; risk.push('换手 ' + MK_F2(turn) + '% 极低（无量，跟不动）'); }
  // ③ 市值适配 0~15（本账户 2.35 万：20~200 亿兼顾弹性与流动性）
  if (yi >= 20 && yi <= 200) { s += 15; }
  else if (yi > 200 && yi <= 500) { s += 10; }
  else if (yi > 500) { s += 4; risk.push('市值 ' + MK_F2(yi, 0) + ' 亿偏大（弹性弱）'); }
  else if (yi > 0) { s += 7; risk.push('市值 ' + MK_F2(yi, 0) + ' 亿偏小（易被操纵）'); }
  else { s += 8; }
  // ④ 共振 0~15：池内"同字号"链条（≥3 只同前两字 = 一条题材链）+ 领涨板块名粗匹配
  var chain = (ctx.chains && ctx.chains[String(x.name || '').slice(0, 2)]) || 0;
  if (chain >= 3) { s += 8; why.push('同字号 ' + String(x.name).slice(0, 2) + ' × ' + chain + ' 只（题材链）'); }
  var bd = mkOppBoardHit(x.name, ctx.boards);
  if (bd) { s += 7; why.push('疑似 ' + bd); }
  if (!chain && !bd) s += 4;
  // ⑤ 早板 0~10：A 档 + 首见早（09:50 前就进池）⇒ 资金提前做，次日溢价概率高
  var early = false;
  if (atLimit && x.first) {
    var d0 = new Date(x.first);
    early = (d0.getHours() * 60 + d0.getMinutes()) <= (9 * 60 + 50);
  }
  if (early) { s += 10; why.push('早板 ' + mkHM(x.first)); }
  else if (atLimit) s += 5;
  // ⑥ 风险扣分
  if (st) { s -= 25; risk.push('ST/退市风险股'); }
  if (lbc >= 3) { s -= 12; risk.push('已 ' + lbc + ' 连板（高位）'); }
  else if (lbc === 2) { s -= 4; risk.push('2 连板'); }
  if (hi - pct >= 4) { s -= 12; risk.push('冲高回落（曾 +' + MK_F2(hi) + '% → 现 +' + MK_F2(pct) + '%）'); }
  else if (hist.length >= 4 && hist[hist.length - 1] < hist[hist.length - 3]) { s -= 4; risk.push('连续两轮走弱'); }
  s = Math.max(0, Math.min(100, Math.round(s)));
  // ⑦ 动作：先看硬风险与位置，再看涨幅 —— 这就是"不是所有机会都能打板"的落点
  var act;
  if (st) act = 'avoid';
  else if (risk.length >= 2) act = 'avoid';
  else if (atLimit) act = 'seal';
  else if (pct >= 9.5) act = 'board';
  else if (pct >= 5) act = 'chase';
  else if (pct >= 2 && turn >= 2) act = 'dip';
  else act = 'watch';
  if ((act === 'chase' || act === 'dip') && (turn > 25 || hi - pct >= 4)) act = 'watch';
  // ⑧ 一句话结论（具体到数字，便于核对）
  var say;
  if (act === 'seal') say = '打板买不到 ⇒ 看次日溢价' + (early ? '（' + mkHM(x.first) + ' 早板，越早越强）' : '') + ' · 换手 ' + MK_F2(turn) + '%';
  else if (act === 'board') say = '未封板，只能追板/排板 ⇒ 破板即走 · 现 +' + MK_F2(pct) + '% 换手 ' + MK_F2(turn) + '%';
  else if (act === 'chase') say = '右侧追涨（+' + MK_F2(pct) + '% 换手 ' + MK_F2(turn) + '%）⇒ 回踩不破均价线再看';
  else if (act === 'dip') say = '低吸（+' + MK_F2(pct) + '% 换手 ' + MK_F2(turn) + '%）⇒ 等回踩，别追高';
  else if (act === 'avoid') say = '回避：' + (risk.join(' · ') || '风险项过多');
  else say = '只是进池（+' + MK_F2(pct) + '% 换手 ' + MK_F2(turn) + '%）⇒ 观察，不动手';
  return { s: s, act: act, why: why, risk: risk, say: say, early: early, lbc: lbc };
};
// 批量打分（算"同字号链条"要全池口径）→ 按分数降序返回 [{x, r}]
var mkOppScoreAll = function (arr, ctx) {
  ctx = ctx || {};
  var chains = {};
  arr.forEach(function (x) {
    var k = String(x.name || '').slice(0, 2);
    if (k.length === 2) chains[k] = (chains[k] || 0) + 1;
  });
  ctx.chains = chains;
  return arr.map(function (x) { return { x: x, r: mkOppScore(x, ctx) }; })
    .sort(function (a, b) { return b.r.s - a.r.s || Number(b.x.pct) - Number(a.x.pct); });
};
// 雷达 → 情绪页签左栏的数据桥（makeRadar 与 makeScreen 是两套闭包，只能这样递）
var MK_OPP_SNAP = { pool: {}, boards: [], ts: 0 };
var MK_ZT_SNAP = {};        // 涨停池：代码 -> 连板数（情绪页签扫描时刷新）
// 最近一次取数失败的原因（排障用：面板上会亮出来，不再只有一句"失败"）
var MK_LAST = { args: null, err: '', out: '' };
var mkPyRun = async (args, scriptPath) => {
  try {
    const f = scriptPath || MK_FALLBACK;
    const py = 'import sys\n' +
      'sys.argv = ["fb"] + ' + JSON.stringify(args) + '\n' +
      'exec(compile(open(r"' + f + '", encoding="utf-8").read(), "fb", "exec"), {"__name__": "__main__"})';
    const r = await window.app.stock.script.run(py);
    if (!r || !r.ok) {
      MK_LAST.args = args;
      MK_LAST.err = String((r && r.err) || '无返回').slice(-200);
      MK_LAST.out = String((r && r.out) || '').slice(-200);
      return null;
    }
    const line = String(r.out || '').trim().split('\n').filter(Boolean).pop() || '';
    try { return JSON.parse(line); } catch (e2) {
      MK_LAST.args = args; MK_LAST.err = 'JSON 解析失败'; MK_LAST.out = line.slice(-200);
      return null;
    }
  } catch (e) {
    MK_LAST.args = args; MK_LAST.err = String((e && e.message) || e).slice(-200);
    return null;
  }
};

var makeRadar = (host) => {
  var K = window.app.stock;
  var disposed = false;
  var timers = [];
  var CFG_KEY = 'radar_cfg_v1';
  var cf = { sound: true, notify: true, paused: false };
  try { var saved = JSON.parse(localStorage.getItem(CFG_KEY) || '{}'); if (saved && typeof saved === 'object') { cf.sound = saved.sound !== false; cf.notify = saved.notify !== false; } } catch (e) { /* ignore */ }
  var rules = [];                       // 持仓规则（记忆表来的）
  var rulesId = null;
  var quotes = {};                      // 归一化代码 -> 行情
  var prevPx = {};                      // 代码 -> 上一轮价格（急动检测）
  var evs = [];                         // 事件流（新在前）
  var boards = [];                      // 最新板块快照
  var bHist = {};                       // 板块代码 -> [{p,ts}...]
  var cd = {};                          // 冷却：key -> ts
  var rankPrev = 0;                     // 上一轮涨停只数
  // ---- 机会池（2026-10-14 用户口径：**只要在拉涨（pct>0）就全部算机会**）----
  // 判定上不设任何门槛（市值/换手/涨幅区间都不拦，旧口径"涨 8% 的强势票反被丢掉"已废）；
  // 只按强度分 A/B/C/D 四档，**弹窗只推 A、B 两档**，C/D 进池计数不刷屏。
  var oppPool = {};                     // 代码 -> {code,name,pct,price,turn,mcap,tier,ts,first,hit}
  var oppTier = { A: 0, B: 0, C: 0, D: 0 };
  var whSt = { ts: 0, n: 0, err: '' };  // 仓库落库状态（data\stock\warehouse.db）
  var TIER_NAME = TIER_MINI;          // 顶层一份（「🚀 机会池」页签共用）
  var tierOf = mkTierOf;              // 分档口径在顶层（「🚀 机会池」页签共用同一份，别再各写一份）
  var rdState = {};                     // 规则上升沿
  var judging = true;                   // 是否允许"判定/报警"（休市快照那一次取数置 false，见 tickFast）
  // ★2026-10-15：`cd`（冷却）与 `rdState`（上升沿）原来是**纯内存** ⇒ 刷新面板 / 切回场景后，
  //   条件仍成立的持仓规则会**再响一次铃**、已经推过的机会票也会再弹一遍（提示引擎的 alertState 早就持久化了）。
  //   现在一起存 localStorage；冷却表只留 12 小时内的，免得越积越多。
  var RD_STATE_KEY = 'radar_state_v1';
  var saveRdState = function () {
    try {
      var cut = Date.now() - 12 * 3600e3, keep = {};
      Object.keys(cd).forEach(function (k) { if (cd[k] > cut) keep[k] = cd[k]; });
      cd = keep;
      localStorage.setItem(RD_STATE_KEY, JSON.stringify({ rd: rdState, cd: cd }));
    } catch (e) { /* ignore */ }
  };
  try {
    var _rd = JSON.parse(localStorage.getItem(RD_STATE_KEY) || '{}');
    if (_rd && typeof _rd === 'object') {
      if (_rd.rd && typeof _rd.rd === 'object') rdState = _rd.rd;
      if (_rd.cd && typeof _rd.cd === 'object') cd = _rd.cd;
    }
  } catch (e) { /* ignore */ }
  var flash = null, err = '', at = 0, busy = { hold: false, rank: false, board: false };
  var nEv = 0;
  var DEFAULTS = [
    { code: '002866', name: '传艺科技', t: 'p', op: 'gte', v: 17.38, tag: '持仓', note: '传艺 200 股：到 MA5 17.38 ⇒ 先减 100', on: true },
    { code: '002866', name: '传艺科技', t: 'p', op: 'gte', v: 18.60, tag: '持仓', note: '传艺 200 股：前高密集 18.32~18.59 ⇒ 剩 100 全清', on: true },
    { code: '002866', name: '传艺科技', t: 'p', op: 'lte', v: 15.50, tag: '持仓', note: '★传艺：破 MA20 15.505 + 成本 15.533 ⇒ 全清', on: true },
    { code: '605258', name: '协和电子', t: 'p', op: 'gte', v: 43.92, tag: '持仓', note: '协和 300 股：到 10-15 高 43.92 ⇒ 减 150', on: true },
    { code: '605258', name: '协和电子', t: 'p', op: 'gte', v: 45.77, tag: '持仓', note: '★协和：到前高 45.77 ⇒ 剩 150 全清', on: true },
    { code: '605258', name: '协和电子', t: 'p', op: 'lte', v: 39.85, tag: '持仓', note: '协和：破 MA5 39.85／MA10 40.25 ⇒ 减 150', on: true },
    { code: '605258', name: '协和电子', t: 'p', op: 'lte', v: 38.90, tag: '持仓', note: '★协和：破 MA20 38.913 ⇒ 全清', on: true },
    { code: '002498', name: '汉缆股份', t: 'p', op: 'gte', v: 6.11, tag: '持仓', note: '汉缆 1200 股：到 MA5 6.108／MA10 6.123 ⇒ 减 600', on: true },
    { code: '002498', name: '汉缆股份', t: 'p', op: 'gte', v: 6.37, tag: '持仓', note: '汉缆：到 MA20 6.372 ⇒ 再减 600 清光', on: true },
    { code: '002498', name: '汉缆股份', t: 'p', op: 'lte', v: 5.60, tag: '持仓', note: '★汉缆：破 10-15 低 5.64（20 日最低）⇒ 全清止损', on: true }
  ];
  var KW = ['电子', '光电', '半导', '芯片', '通信', '算力', '液冷', '铜箔', '玻纤', '存储', '军工', '稀土', '航运', '机器人', '固态', '储能', '光模块', '数据中心', '印制电路'];
  var f2 = function (v, d) { var n = Number(v); return isFinite(n) ? n.toFixed(d == null ? 2 : d) : '--'; };
  var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
  var hhmm = function (ts) { var d = new Date(ts); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); };
  var keyOf = function (code) { return String(code || '').replace(/\.(SH|SZ|BJ)$/i, ''); };
  // 6 位纯代码 → 腾讯/新浪要的带市场前缀代码（sh/sz/bj）。2026-10-15 加：
  //   兜底脚本 `--quotes` 只认带前缀的（实测不认 6 位裸代码）⇒ 两处口径必须分开：
  //   `keyOf` 是**内部匹配键**（保持裸代码），`tkOf` 只用于**对外请求**。
  var tkOf = function (code) {
    var c = keyOf(code);
    if (/^(60|68|9)/.test(c)) return 'sh' + c;
    if (/^(43|83|87|88|920)/.test(c)) return 'bj' + c;
    return 'sz' + c;
  };
  var qGet = function (code) {
    var c = keyOf(code);
    if (quotes[c]) return quotes[c];
    var pre = /^(60|68|9)/.test(c) ? 'sh' : 'sz';
    if (quotes[pre + c]) return quotes[pre + c];
    return null;
  };
  var cool = function (key, ms) { var t = Date.now(); if (cd[key] && t - cd[key] < ms) return false; cd[key] = t; return true; };
  var beep = function (kind) {
    if (!cf.sound) return;
    try {
      var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
      var ctx = new AC(), o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination); o.type = 'sine';
      var hi = kind === 'opp';
      o.frequency.value = hi ? 740 : 430;
      g.gain.value = 0.07;
      o.start();
      o.frequency.linearRampToValueAtTime(hi ? 1180 : 300, ctx.currentTime + 0.16);
      g.gain.exponentialRampToValueAtTime(0.0008, ctx.currentTime + 0.34);
      o.stop(ctx.currentTime + 0.36);
      setTimeout(function () { try { ctx.close(); } catch (e) { /* ignore */ } }, 900);
    } catch (e) { /* 静默 */ }
  };
  var ntfDiag = '';                     // 系统通知自检/发送结果：'' / 'ok' / 失败原因（显示在按钮上）
  var ntfPerm = function () {
    try { return (window.Notification && Notification.permission) || 'unsupported'; } catch (e) { return 'error'; }
  };
  var sysNotify = function (title, text, force) {
    if (!cf.notify && !force) return;
    try {
      if (!window.Notification) { ntfDiag = '本环境无 Notification'; return; }
      var fire = function () {
        try {
          // ⚠ 两个都写：renderer 侧只认标准的 requireInteraction，timeoutType 是 Electron 主进程侧的名字；
          //   目标一致 —— Windows 上横幅**不自动消失**（盯盘告警不能被 5 秒卷走）
          new Notification(title, { body: text, silent: false, requireInteraction: true, timeoutType: 'never' });
          ntfDiag = 'ok';
        } catch (e) { ntfDiag = '弹窗抛错'; }
      };
      if (Notification.permission === 'granted') fire();
      else if (Notification.permission !== 'denied') {
        Notification.requestPermission().then(function (p) { if (p === 'granted') fire(); else ntfDiag = '未授权(' + p + ')'; });
      } else ntfDiag = '未授权(denied)';
    } catch (e) { ntfDiag = '通知异常'; }
    try { paintTop(); } catch (e) { /* ignore */ }
  };
  var bridge = null;                    // 合并页注入：把命中同步到页面顶部的置顶横幅
  // 2026-10-15：休市快照期间（judging=false）事件只丢弃、不落流、不响铃、不弹窗 —— 收盘价不该在晚上报"命中"。
  var push = function (ev) {
    if (!judging) return;
    ev.ts = Date.now();
    // 2026-10-14 用户要求「这个机会提示要显示票号，不然不好搜」：
    // 统一在事件入口补一次票号 ⇒ 弹窗横幅 / 事件流 / 系统通知 三处同源，不会各写各的漏掉某处
    if (ev.code) {
      var c6 = mkC6(ev.code);
      if (c6 && c6 !== '*' && String(ev.title || '').indexOf(c6) < 0) {
        var nm = String(ev.name || '');
        var tt = String(ev.title || '');
        ev.title = (nm && tt.indexOf(nm) === 0) ? tt.replace(nm, nm + ' ' + c6) : (tt ? tt + '　' + c6 : c6);
      }
    }
    evs.unshift(ev);
    if (evs.length > 80) evs.length = 80;
    nEv++;
    if (!ev.quiet) {
      flash = ev;
      beep(ev.kind);
      sysNotify((ev.kind === 'risk' ? '⚠ ' : ev.kind === 'opp' ? '🚀 ' : '🔔 ') + ev.tag + ' · ' + ev.title, ev.text);
      if (bridge) { try { bridge(ev); } catch (e) { /* ignore */ } }
    }
    paintFlash(); paintEvents();
    saveRdState();   // ★2026-10-15：连冷却一起落盘，重载后不再重复弹已推过的票
  };
  // ---------------- 渲染 ----------------
  var root = el('div', 'rd-root');
  var top = el('div', 'rd-top');
  var holdBox = el('div', 'rd-holds');
  var oppTitle = el('div', 'rd-sec', '🚀 机会池（拉涨即进池 · 分档只收口弹窗）');
  var oppBox = el('div', 'rd-opps');
  var bdTitle = el('div', 'rd-sec', '🧭 板块异动（4 秒轮询 · 东财实时）');
  var bdBox = el('div', 'rd-boards');
  var evTitle = el('div', 'rd-sec', '📡 事件流（新在前，留 80 条）');
  var evBox = el('div', 'rd-events');
  // ★2026-10-15（用户要求「只留下一个提示卡片，省窗口」）：雷达块里原来还有一张和页面最顶
  //   「置顶横幅」(rd-alertbar) **完全同源**的大卡片 rd-flash（同一条命中画两遍，占 3~4 行）。
  //   现在只留置顶那张（sticky，永远第一眼看到），rd-flash 不再建、也不再进 DOM；
  //   `paintFlash()` 保留成空实现，调用点不用动。雷达的"就绪"提示本来就由置顶横幅负责。
  [top, holdBox, oppTitle, oppBox, bdTitle, bdBox, evTitle, evBox].forEach(function (x) { root.appendChild(x); });
  host.appendChild(root);
  var btnSound, btnNotify, btnPause;
  var mkBtn = function (txt, on, fn) {
    var b = el('button', 'rd-btn' + (on ? ' on' : ''), txt);
    b.addEventListener('click', fn);
    return b;
  };
  var paintOpp = function () {
    try {
      paintOppInner();
    } catch (e) { /* 机会池渲染异常不许影响雷达其它部分 */ }
  };
  // 机会池排序：2026-10-14 起**默认按打分**（用户："给票打分；全是机会总不能全部都打板"），
  // 可以一键切回按涨幅（旧口径）。选择记在 localStorage。
  var oppSort = 'score';
  try { if (localStorage.getItem('radar_opp_sort') === 'pct') oppSort = 'pct'; } catch (e) { /* ignore */ }
  var paintOppInner = function () {
    oppBox.innerHTML = '';
    var arr = Object.keys(oppPool).map(function (k) { return oppPool[k]; });
    if (!arr.length) { oppBox.appendChild(el('div', 'rd-empty', '机会池空：等涨幅榜刷新（休市时不增长）。')); return; }
    // 打分（全池口径算"同字号链条"）+ 发布快照给「🚀 机会池」页签 / 提示引擎
    var scored = mkOppScoreAll(arr, { boards: boards, zt: MK_ZT_SNAP });
    // ★2026-10-15：别覆盖 `pool`！那是「🚀 机会池」页签唯一的显示数据源（它自己每 8 秒写一次），
    //   雷达每 5 秒再写一遍 ⇒ 两边互相盖，页面上的"共 N 只"会在两个池子之间莫名跳动。
    //   雷达自己的池放在 `radarPool`（页面只读 pool；`boards` 两边共用，雷达这份更新，照旧写）。
    MK_OPP_SNAP.radarPool = oppPool; MK_OPP_SNAP.boards = boards; MK_OPP_SNAP.ts = Date.now();
    // 2026-10-14：以前这里派发 oppPoolUpdate 给「情绪」页签左栏；机会池已改成单开一页且**自己轮询**
    // （见 makeScreen 的 pollOppPage），所以没人再监听这个事件了。留着不碍事（万一以后有别的订阅者）。
    try { window.dispatchEvent(new CustomEvent('oppPoolUpdate')); } catch (e2) { /* ignore */ }
    var head = el('div', 'rd-opp-hd');
    // 档位数字按**池子构成**算（不是本轮扫描），免得 A+B ≠ 共 N 只让人以为漏了
    var cnt = { A: 0, B: 0, C: 0, D: 0 };
    arr.forEach(function (x) { if (cnt[x.tier] != null) cnt[x.tier]++; });
    ['A', 'B', 'C', 'D'].forEach(function (t) {
      head.appendChild(el('span', 'rd-opp-t rd-t' + t, t + ' ' + TIER_NAME[t] + ' ' + cnt[t]));
    });
    head.appendChild(el('span', 'rd-opp-t', '共 ' + arr.length + ' 只'));
    oppBox.appendChild(head);
    // 动作分布 —— 这才是"不能全部打板"的答案：每种参与方式各有多少只
    var acts = { seal: 0, board: 0, chase: 0, dip: 0, watch: 0, avoid: 0 };
    scored.forEach(function (z) { if (acts[z.r.act] != null) acts[z.r.act]++; });
    var hd2 = el('div', 'rd-act-hd');
    ['board', 'seal', 'chase', 'dip', 'watch', 'avoid'].forEach(function (k) {
      if (!acts[k]) return;
      var t = el('span', 'mk-act mk-act-' + k, MK_ACT[k].t + ' ' + acts[k]);
      t.title = MK_ACT[k].d;
      hd2.appendChild(t);
    });
    var sb = el('button', 'rd-btn rd-sort', oppSort === 'score' ? '排序：评分' : '排序：涨幅');
    sb.title = '切换排序：按打分（能不能参与 / 以什么方式参与）⇄ 按涨幅';
    sb.addEventListener('click', function () {
      oppSort = oppSort === 'score' ? 'pct' : 'score';
      try { localStorage.setItem('radar_opp_sort', oppSort); } catch (e2) { /* ignore */ }
      paintOpp();
    });
    hd2.appendChild(sb);
    oppBox.appendChild(hd2);
    var list = scored.slice();
    if (oppSort === 'pct') list.sort(function (a, b) { return Number(b.x.pct) - Number(a.x.pct); });
    var nShow = 15;
    list.slice(0, nShow).forEach(function (z) {
      var x = z.x, r = z.r;
      var row = el('div', 'rd-opp sel rd-opp2');
      var l1 = el('div', 'rd-opp-l1');
      l1.appendChild(el('span', 'rd-score ' + (r.s >= 80 ? 'hi' : r.s >= 65 ? 'mid' : r.s >= 50 ? 'lo' : 'bad'), String(r.s)));
      l1.appendChild(el('span', 'rd-opp-tag rd-t' + x.tier, x.tier));
      l1.appendChild(el('span', 'mk-act mk-act-' + r.act, MK_ACT[r.act].t));
      l1.appendChild(el('span', 'nm', (mkC6(x.code) + ' ' + (x.name || '')).trim()));
      l1.appendChild(el('span', 'rd-up', '+' + f2(x.pct) + '%'));
      row.appendChild(l1);
      row.appendChild(el('div', 'rd-why', r.say + (r.risk.length ? '　⚠ ' + r.risk.join(' · ') : '')));
      row.title = '点击看 K 线 ｜ ' + mkC6(x.code) + ' ' + (x.name || '') + ' ｜ 打分 ' + r.s + '/100（动能30+量价25+市值15+共振15+早板10−风险）' +
        '\n加分项：' + r.why.join(' · ') + (r.risk.length ? '\n风险项：' + r.risk.join(' · ') : '') +
        '\n本地规则排序，仅供参考，不是投资建议';
      row.addEventListener('click', function () {
        try { window.dispatchEvent(new CustomEvent('stockSelect', { detail: { code: keyOf(x.code), name: x.name || '' } })); } catch (e2) { /* ignore */ }
      });
      oppBox.appendChild(row);
    });
    if (arr.length > nShow) oppBox.appendChild(el('div', 'rd-empty', '（只列前 ' + nShow + ' 只 · 全池 ' + arr.length + ' 只已落库 data\\stock\\warehouse.db）'));
  };
  var paintTop = function () {
    top.innerHTML = '';
    var trading = isTradingNow();
    top.appendChild(el('span', 'rd-dot' + (trading ? ' on' : '')));
    top.appendChild(el('span', '', trading ? '盯盘中' : '休市'));
    top.appendChild(el('span', '', '最近检查 ' + (at ? hhmm(at) : '--')));
    top.appendChild(el('span', '', '持仓 ' + rules.filter(function (r) { return r.on !== false; }).length + ' 条规则'));
    top.appendChild(el('span', '', '板块 ' + boards.length + ' 个'));
    top.appendChild(el('span', '', '机会池 ' + Object.keys(oppPool).length + ' 只'));
    top.appendChild(el('span', '', '命中 ' + nEv));
    if (whSt.ts) top.appendChild(el('span', 'rd-src', '仓库落库 ' + hhmm(whSt.ts) + ' ×' + whSt.n));
    else if (whSt.err) top.appendChild(el('span', 'rd-err', '仓库 ' + String(whSt.err).slice(0, 70)));
    if (err) top.appendChild(el('span', 'rd-err', err));
    if (rankSrc || boardSrc || quoteSrc) {
      top.appendChild(el('span', 'rd-src', '数据源 ' + [rankSrc && '榜:' + rankSrc, boardSrc && '板块:' + boardSrc, quoteSrc && '行情:' + quoteSrc].filter(Boolean).join(' ')));
    }
    btnSound = mkBtn(cf.sound ? '🔊 提示音' : '🔇 静音', cf.sound, function () { cf.sound = !cf.sound; saveCfg(); paintTop(); });
    btnNotify = mkBtn(cf.notify ? ('🪟 系统通知' + (ntfDiag === 'ok' ? ' ✓' : ntfDiag ? ' ⚠' : '')) : '🪟 通知关', cf.notify, function () { cf.notify = !cf.notify; saveCfg(); if (cf.notify) sysNotify('盘中雷达 · 测试', '系统通知已开启：命中会弹到桌面横幅（没看到＝Windows 把横幅拦了）'); paintTop(); });
    btnNotify.title = '通知权限：' + ntfPerm() + (ntfDiag ? '　最近一次发送：' + ntfDiag : '') + '　—— 按钮上若显示 ⚠ 说明是系统侧没弹';
    btnPause = mkBtn(cf.paused ? '▶ 继续' : '⏸ 暂停', cf.paused, function () { cf.paused = !cf.paused; saveCfg(); paintTop(); });
    top.appendChild(btnSound); top.appendChild(btnNotify); top.appendChild(btnPause);
    top.appendChild(mkBtn('🗑 清空事件', false, function () { evs = []; nEv = 0; flash = null; paintFlash(); paintEvents(); paintTop(); }));
  };
  // 2026-10-15：这张面板内大卡片已下线（与置顶横幅同源、重复占高度）⇒ 空实现，调用点保留。
  //   命中信息的落点现在是：① 页面最顶的 sticky 置顶横幅（唯一那张"提示卡片"）
  //   ② 事件流的一行留痕 ③ 提示音/系统通知。
  var paintFlash = function () { return; };
  var paintHolds = function () {
    holdBox.innerHTML = '';
    var codes = [];
    rules.forEach(function (r) { var c = keyOf(r.code); if (c && c !== '*' && codes.indexOf(c) < 0) codes.push(c); });
    if (!codes.length) { holdBox.appendChild(el('div', 'rd-empty', '暂无持仓规则')); return; }
    codes.forEach(function (c) {
      var q = qGet(c);
      var nm = (rules.filter(function (r) { return keyOf(r.code) === c; })[0] || {}).name || c;
      // 2026-10-14 用户要求：左边持仓票也要能点开看（联动趋势看板，与机会池/事件流一致）
      var box = el('div', 'rd-hold sel');
      box.title = '点击看 ' + nm + ' 的 K 线（联动趋势看板）';
      box.addEventListener('click', function () {
        try { window.dispatchEvent(new CustomEvent('stockSelect', { detail: { code: c, name: nm } })); } catch (e) { /* ignore */ }
      });
      box.appendChild(el('div', 'n', nm + ' ' + c));
      if (!q) { box.appendChild(el('div', 'p', '--')); holdBox.appendChild(box); return; }
      var up = Number(q.pct) >= 0;
      box.appendChild(el('div', 'p ' + (up ? 'rd-up' : 'rd-dn'), f2(q.price) + '  ' + (up ? '+' : '') + f2(q.pct) + '%'));
      var near = rules.filter(function (r) { return keyOf(r.code) === c && r.on !== false; }).map(function (r) { return (r.op === 'gte' ? '↑' : '↓') + f2(r.v); }).join(' ');
      box.appendChild(el('div', 's', '换手 ' + f2(q.turn) + '%　' + near));
      box.appendChild(el('div', 's', '量 ' + (q.amount ? f2(Number(q.amount) / 1e8, 2) + ' 亿' : '--')));
      holdBox.appendChild(box);
    });
  };
  var paintEvents = function () {
    evBox.innerHTML = '';
    if (!evs.length) { evBox.appendChild(el('div', 'rd-empty', '暂无事件。')); return; }
    evs.slice(0, 40).forEach(function (e) {
      var row = el('div', 'rd-ev' + (e.code ? ' sel' : ''));
      row.appendChild(el('span', 'tm', hhmm(e.ts).slice(0, 5)));
      row.appendChild(el('span', 'tag', e.tag));
      row.appendChild(el('span', 'tx', e.title + ' — ' + e.text));
      if (e.code) row.addEventListener('click', function () { try { window.dispatchEvent(new CustomEvent('stockSelect', { detail: { code: keyOf(e.code), name: e.name || '' } })); } catch (x) { /* ignore */ } });
      evBox.appendChild(row);
    });
  };
  var paintBoards = function () {
    bdBox.innerHTML = '';
    var top10 = boards.slice().filter(function (b) { return Number(b.p) > 0.6; }).slice(0, 10);
    if (!top10.length) { bdBox.appendChild(el('div', 'rd-empty', err ? '板块数据暂不可用：' + err : '暂无明显走强板块。')); return; }
    top10.forEach(function (b) {
      var row = el('div', 'rd-bd');
      row.appendChild(el('span', 'nm', (b.kind === 'con' ? '【概】' : '') + b.n));
      row.appendChild(el('span', 'rd-up', '+' + f2(b.p) + '%'));
      row.appendChild(el('span', '', '主力 ' + f2(Number(b.m) / 1e8, 1) + ' 亿'));
      row.appendChild(el('span', '', '涨' + (b.u == null ? '-' : b.u) + '/跌' + (b.dn == null ? '-' : b.dn)));
      if (b.ld) row.appendChild(el('span', '', '领涨 ' + b.ld + ' ' + f2(b.lp) + '%'));
      bdBox.appendChild(row);
    });
  };
  // ---------------- 轮询 ----------------
  var isTradingNow = function () {
    var d = new Date(Date.now() + 8 * 3600e3), dow = d.getUTCDay(), hm = d.getUTCHours() * 100 + d.getUTCMinutes();
    if (dow === 0 || dow === 6) return false;
    return (hm >= 915 && hm <= 1135) || (hm >= 1255 && hm <= 1505);
  };
  var pollHold = async function (judge) {
    if (disposed || busy.hold) return false;
    var doJudge = judge !== false;
    var codes = [];
    rules.forEach(function (r) { var c = keyOf(r.code); if (c && c !== '*' && codes.indexOf(c) < 0) codes.push(c); });
    if (!codes.length) return false;
    var got = false;
    busy.hold = true;
    try {
      var r = await K.quote.realtime(codes);
      if (disposed) return false;
      var qmap = (r && r.quotes) || null;
      if (!qmap || !Object.keys(qmap).length) {
        // 2026-10-14：主通道（main.js 腾讯）偶尔整批返回空 ⇒ 走兜底脚本再取一次，
        // 否则持仓格会变成一片 "--"，等于雷达瞎了
        // ★2026-10-15 修：兜底脚本走的是腾讯 `qt.gtimg.cn/q=`，**代码必须带市场前缀**
        //   （实测 `--quotes 605258,002498` → {"ok":false,"n":0}；`sh605258,sz002498` → 3 条）。
        //   这里过去直接传 6 位纯代码 ⇒ **兜底从来没生效过**（主通道一挂，持仓格就永远 "--"）。
        var fbq = await mkPyRun(['--quotes', codes.map(tkOf).join(',')]);
        if (disposed) return false;
        if (fbq && fbq.ok && fbq.map && Object.keys(fbq.map).length) { qmap = fbq.map; quoteSrc = '兜底'; }
      }
      if (qmap) {
        for (var k in qmap) { if (Object.prototype.hasOwnProperty.call(qmap, k)) quotes[keyOf(k)] = qmap[k]; }
        at = Date.now();
        got = true;
      }
      if (got && doJudge) {
        // 急拉急跌（相邻两轮）
        codes.forEach(function (c) {
          var q = qGet(c); if (!q) return;
          var p = Number(q.price); if (!isFinite(p) || p <= 0) return;
          var pv = prevPx[c];
          if (pv && Math.abs(p - pv) / pv >= 0.006) {
            var nm = (rules.filter(function (x) { return keyOf(x.code) === c; })[0] || {}).name || c;
            var up = p > pv;
            if (cool('mv' + c, 60000)) push({ kind: up ? 'opp' : 'risk', tag: up ? '急拉' : '急跌', code: c, name: nm, title: nm + ' ' + (up ? '+' : '') + f2((p - pv) / pv * 100) + '%', text: '1 轮内从 ' + f2(pv, 3) + ' → ' + f2(p, 3) + '（现价 ' + f2(p) + '）' });
          }
          prevPx[c] = p;
        });
        // 规则（上升沿）
        rules.forEach(function (r) {
          if (r.on === false || r.code === '*') return;
          var q = qGet(r.code); if (!q) return;
          var cur = r.t === 'turn' ? Number(q.turn) : r.t === 'pct' ? Number(q.pct) : Number(q.price);
          if (!isFinite(cur)) return;
          var k = keyOf(r.code) + '|' + r.t + '|' + r.op + '|' + r.v;
          var hit = r.op === 'gte' ? cur >= Number(r.v) : cur <= Number(r.v);
          if (hit && !rdState[k]) {
            rdState[k] = true;
            var down = r.op === 'lte';
            push({ kind: down ? 'risk' : 'opp', tag: r.tag || '持仓', code: keyOf(r.code), name: r.name, title: (r.name || r.code) + ' ' + f2(cur) + (r.t === 'p' ? '' : '%'), text: r.note || '触发规则' });
          } else if (!hit && rdState[k]) rdState[k] = false;
        });
        saveRdState();   // ★2026-10-15：规则上升沿落盘 —— 重载后"条件仍成立"的规则不会再响一次铃
      }
      paintHolds();
    } catch (e) { /* 静默 */ }
    busy.hold = false;
    return got;
  };
  var pollRank = async function () {
    if (disposed || busy.rank) return false;
    busy.rank = true;
    try {
      var r = await K.market.rank({ type: 'up', pages: 1, sort: 'pct' });
      if (disposed) return false;
      var list = (r && r.list) || [];
      rankSrc = (r && r.fromCache) ? '缓存' : '';
      if (!list.length || (r && r.fromCache)) {
        // 东财 clist 拿不到（或只是回放缓存）⇒ 用新浪实时榜兜底，比"看昨天的缓存"强得多
        var frk = await mkPyRun(['--rank', 'up', '--pages', '1']);
        if (disposed) return false;
        if (frk && frk.ok && frk.list && frk.list.length) {
          list = frk.list;
          rankSrc = frk.src === 'sina' ? '新浪' : '东财';
        }
      }
      if (!list.length) { err = '榜单暂无数据'; paintTop(); busy.rank = false; return false; }
      err = '';
      // 涨停潮
      var lim = list.filter(function (x) { return x.atLimit; });
      var n = lim.length;
      if (rankPrev && n - rankPrev >= 3) push({ kind: 'opp', tag: '涨停潮', title: '涨停/触板新增 ' + (n - rankPrev) + ' 只', text: '当前榜内 ' + n + ' 只触板（涨幅 ≥ limit×0.92）⇒ 情绪升温', quiet: false });
      rankPrev = n;
      // 关键词联动（"后缀电子"这类群涨）
      KW.forEach(function (kw) {
        var g = list.filter(function (x) { return x.name && x.name.indexOf(kw) >= 0 && Number(x.pct) >= 4; });
        if (g.length < 3) return;
        if (!cool('kw' + kw, 180000)) return;
        g.sort(function (a, b) { return Number(b.pct) - Number(a.pct); });
        var avg = g.reduce(function (s, x) { return s + Number(x.pct); }, 0) / g.length;
        push({ kind: 'opp', tag: '板块联动', title: kw + ' × ' + g.length + ' 只集体走强（均 ' + f2(avg) + '%）', text: g.slice(0, 6).map(function (x) { return x.name + ' ' + f2(x.pct) + '%' + (x.atLimit ? '(板)' : ''); }).join('、'), extra: '⇒ 同链条个股，留意补涨/联动', quiet: false });
      });
      // ---- 机会判定（2026-10-14 改口径）----
      // 旧：涨幅 2~7% + 换手≥5% + 未封板 + 市值 20~200 亿（四道门槛 ⇒ 涨 8% 的强势票、涨停票反被丢掉）
      // 新：**pct > 0 全部算机会**，一只不漏地进「机会池」；只按强度分档，弹窗只推 A/B 两档。
      var nowTs = Date.now(), freshA = [], freshB = [];
      oppTier.A = oppTier.B = oppTier.C = oppTier.D = 0;
      list.forEach(function (x) {
        var pct = Number(x.pct);
        if (!(pct > 0)) return;
        var code = keyOf(x.code);
        if (noBuy(code)) return;                                     // 创业板/科创板：只作板块参考，不进机会
        var tier = tierOf(x);
        var prev = oppPool[code];
        // hist：最近 8 次采样涨幅（打分要用它识别"冲高回落 / 连续走弱"）；
        // atLimit/limitPct 也带上 —— 打分的动作分类（已封板 vs 冲板中）全靠它
        var hist = ((prev && prev.hist) ? prev.hist : []).concat([pct]).slice(-8);
        oppPool[code] = {
          code: code, name: x.name, pct: pct, price: Number(x.price), turn: Number(x.turn),
          mcap: Number(x.mcap), tier: tier, ts: nowTs, first: prev ? prev.first : nowTs,
          hit: (prev ? prev.hit : 0) + 1, atLimit: !!x.atLimit, limitPct: Number(x.limitPct) || 0,
          hist: hist
        };
        oppTier[tier]++;
        if (tier !== 'A' && tier !== 'B') return;                    // C/D 只进池，不弹窗
        if (!cool((tier === 'A' ? 'opa' : 'opb') + code, tier === 'A' ? 300000 : 600000)) return;
        (tier === 'A' ? freshA : freshB).push(x);
      });
      var byPct = function (a, b) { return Number(b.pct) - Number(a.pct); };
      freshA.sort(byPct); freshB.sort(byPct);
      freshA.slice(0, 2).forEach(function (x) {
        push({ kind: 'opp', tag: '机会票 · 涨停/触板', code: x.code, name: x.name,
          title: x.name + ' +' + f2(x.pct) + '%　封板/触板',
          text: '现价 ' + f2(x.price) + '　换手 ' + f2(x.turn) + '%　市值 ' + f2(Number(x.mcap) / 1e8, 1) + ' 亿',
          extra: '⇒ 已进机会池（A 档）' });
      });
      freshB.slice(0, 2).forEach(function (x) {
        push({ kind: 'opp', tag: '机会票 · 急拉', code: x.code, name: x.name,
          title: x.name + ' +' + f2(x.pct) + '%',
          text: '现价 ' + f2(x.price) + '　换手 ' + f2(x.turn) + '%　市值 ' + f2(Number(x.mcap) / 1e8, 1) + ' 亿',
          extra: '⇒ 已进机会池（B 档）' });
      });
      var nPool = Object.keys(oppPool).length;
      if (nPool && cool('oppsum', 120000)) {
        push({ kind: 'info', tag: '机会池',
          title: '池内 ' + nPool + ' 只在拉涨（涨停 ' + oppTier.A + ' · 急拉 ' + oppTier.B + ' · 温和 ' + oppTier.C + ' · 微涨 ' + oppTier.D + '）',
          text: '口径：只要在拉涨就全部算机会、一只不漏进池并落库；弹窗只推 A/B 两档（A 5 分钟、B 10 分钟冷却）',
          quiet: true });
      }
      paintTop();
      paintOpp();
    } catch (e) { /* 静默 */ }
    busy.rank = false;
    return true;
  };
  var rankSrc = '', boardSrc = '', quoteSrc = '';   // 非"东财/主通道"时才亮出来（降级可见）
  var pollBoard = async function () {
    if (disposed || busy.board) return false;
    busy.board = true;
    try {
      var data = await mkPyRun(['--boards']);
      if (disposed) return false;
      if (!data || !data.ok) { err = '板块数据源不可用'; paintTop(); busy.board = false; return false; }
      boardSrc = data.src === 'sina' ? '新浪' : '';
      var all = [];
      (data.ind || []).forEach(function (b) { all.push({ kind: 'ind', c: b.c, n: b.n, p: Number(b.p), m: Number(b.m), u: b.u, dn: b.dn, ld: b.ld, lp: Number(b.lp) }); });
      (data.con || []).forEach(function (b) { all.push({ kind: 'con', c: b.c, n: b.n, p: Number(b.p), m: Number(b.m), u: b.u, dn: b.dn, ld: b.ld, lp: Number(b.lp) }); });
      all = all.filter(function (b) { return b.c && isFinite(b.p); });
      all.sort(function (a, b) { return b.p - a.p; });
      boards = all;
      err = '';
      var now = Date.now();
      all.forEach(function (b) {
        var h = bHist[b.c] || (bHist[b.c] = []);
        h.push({ p: b.p, ts: now });
        if (h.length > 40) h.shift();
        // 60 秒基准对比 ⇒ 板块急拉
        var base = null;
        for (var i = h.length - 1; i >= 0; i--) { if (now - h[i].ts >= 55000) { base = h[i]; break; } }
        if (base) {
          var d = b.p - base.p;
          if (d >= (b.kind === 'con' ? 1.0 : 0.8) && cool('bd' + b.c, 150000)) {
            push({ kind: 'opp', tag: '板块急拉', title: b.n + ' +' + f2(b.p) + '%（60 秒 +' + f2(d) + '）', text: '主力 ' + f2(b.m / 1e8, 1) + ' 亿　涨' + b.u + '/跌' + b.dn + (b.ld ? '　领涨 ' + b.ld + ' ' + f2(b.lp) + '%' : ''), extra: '⇒ 同板块个股可能快速跟上' });
          } else if (d <= -(b.kind === 'con' ? 1.0 : 0.8) && b.p < -1 && cool('bdd' + b.c, 300000)) {
            push({ kind: 'risk', tag: '板块走弱', title: b.n + ' ' + f2(b.p) + '%（60 秒 ' + f2(d) + '）', text: '主力 ' + f2(b.m / 1e8, 1) + ' 亿 ⇒ 持仓若属该链条应减' , quiet: true });
          }
        }
      });
      paintBoards(); paintTop();
    } catch (e) { err = '板块解析失败'; paintTop(); }
    busy.board = false;
    return true;
  };
  var loadRules = async function () {
    try {
      var rows = await K.mem.list('alert_rules');
      var row = (rows || [])[0];
      if (row) {
        rulesId = row.id;
        var p = JSON.parse(row.content || '[]');
        if (Array.isArray(p) && p.length) { rules = p.filter(function (x) { return x && x.code && x.code !== '*' && x.t !== 'b'; }); paintTop(); paintHolds(); return; }
      }
    } catch (e) { /* ignore */ }
    rules = DEFAULTS.map(function (x) { return Object.assign({}, x); });
    paintTop(); paintHolds();
  };
  var saveCfg = function () { try { localStorage.setItem(CFG_KEY, JSON.stringify(cf)); } catch (e) { /* ignore */ } };
  // ---------------- 启动 ----------------
  paintTop(); paintFlash(); paintHolds(); paintOpp(); paintEvents(); paintBoards();
  loadRules();
  // 2026-10-15：休市也要有一次"收盘快照" —— 只填数、不判定（judging=false ⇒ push 静默、不响铃）。
  //   为什么：晚上打开面板（用户 20:56 就在看持仓）时，原来持仓格全是「--」、板块 0 个、机会池 0 只，
  //   看起来像面板坏了/没更新。口径与「提示」页一致（那边也是"休市只取一次数把当前值填上"）。
  //   ⚠ 实测（2026-10-15 21:04 休市）：行情快照 ✓（三只持仓卡显示收盘价）、板块 ✓（224 个）、
  //   涨幅榜也能拿到（21:12 画面「机会池 57 只 · 数据源 榜:新浪 板块:新浪」）—— 第一次取数只是比板块慢一拍，
  //   所以榜/板块各留 3 次重试是对的（原来我误记成"休市拿不到"，21:12 的实拍已更正）。
  //   行情快照也**必须有上限**：失败了会连带走 `mkPyRun(--quotes)` 兜底（＝起一个 python 进程），
  //   若整夜断网还无限重试就是每 1.5 秒起一个进程 ⇒ 5 次拿不到就放弃（夜间本来就只是补个收盘价）。
  var OFF_HOLD_TRIES = 5;
  var offShot = { hold: false, holdTry: 0, rank: 0, board: 0 };
  var lastRulesAt = 0;   // ★2026-10-16：休市时规则表读取降到 5 分钟一次（盘中仍 60 秒）
  var offShotReset = function () { offShot.hold = false; offShot.holdTry = 0; offShot.rank = 0; offShot.board = 0; };
  var tickFast = async function () {
    if (disposed || cf.paused) return;
    if (!isTradingNow()) {
      if (!offShot.hold && offShot.holdTry < OFF_HOLD_TRIES) {
        offShot.holdTry++;
        judging = false;
        if (await pollHold(false)) offShot.hold = true;
      }
      paintTop(); return;
    }
    offShotReset(); judging = true;
    await pollHold(true);
  };
  var tickRank = async function () {
    if (disposed || cf.paused) return;
    if (!isTradingNow()) {
      if (offShot.rank >= 3) return;
      offShot.rank++; judging = false; await pollRank(); return;
    }
    judging = true; await pollRank();
  };
  var tickBoard = async function () {
    if (disposed || cf.paused) return;
    if (!isTradingNow()) {
      if (offShot.board >= 3) return;
      offShot.board++; judging = false; await pollBoard(); return;
    }
    judging = true; await pollBoard();
  };
  // ---- 系统通知自检（每 6 小时最多一次，2026-10-14）----
  // 「系统通知开着却没弹窗」时用它定性：结果写进 ntfDiag，显示在「🪟 系统通知」按钮上（✓ 正常 / ⚠ 原因）。
  try {
    var NTF_TEST_KEY = 'radar_ntf_test_v1';
    var lastNtfTest = Number(localStorage.getItem(NTF_TEST_KEY) || 0);
    if (cf.notify && Date.now() - lastNtfTest > 6 * 3600e3) {
      localStorage.setItem(NTF_TEST_KEY, String(Date.now()));
      setTimeout(function () {
        if (!disposed) sysNotify('盘中雷达 · 通知自检', '看到这条桌面横幅 = 系统通知正常；没看到 = Windows 把横幅拦了（通知多半只进了通知中心）');
      }, 2500);
    }
  } catch (e) { /* ignore */ }
  timers.push(setInterval(tickFast, 1500));
  timers.push(setInterval(tickRank, 5000));
  timers.push(setInterval(tickBoard, 9000));
  // ---- 数据仓库落库（2026-10-14 建）：每 30 秒把榜单 + 机会池写进 data\stock\warehouse.db，
  //      板块每两轮（60 秒）一次。"当时它是什么样"从此可回放，东财被封也不影响历史。
  var tickWH = async function () {
    if (disposed || cf.paused || !isTradingNow()) return;
    var r = await mkPyRun(['--snap-rank', '--pages', '1'], MK_WH);
    if (r && r.ok) { whSt.ts = Date.now(); whSt.n++; whSt.err = ''; }
    else whSt.err = (MK_LAST.args ? MK_LAST.args[0] + ' ' : '') + (MK_LAST.err || '落库失败');
    if (whSt.n % 2 === 1) await mkPyRun(['--snap-boards'], MK_WH);
    // 口径对账：把本侧机会池只数、**其中买不了的板有几只**、池子档位构成写进仓库 pool_audit。
    // 硬指标只有一个：`--bad` 必须恒为 0（说明 MK_NOBUY 过滤有效且与 warehouse.py 的 NOBUY 同步）。
    // ⚠ 两边的池子只数**不要求相等**：DB 池是跨批次累计，JS 池是本次会话内存，刷新面板即清零。
    var cnt = { A: 0, B: 0, C: 0, D: 0 }, nBad = 0;
    Object.keys(oppPool).forEach(function (k) {
      var t = oppPool[k].tier;
      if (cnt[t] != null) cnt[t]++;
      if (noBuy(k)) nBad++;
    });
    await mkPyRun(['--audit', String(Object.keys(oppPool).length), '--bad', String(nBad),
      '--tier', [cnt.A, cnt.B, cnt.C, cnt.D].join(',')], MK_WH);
    paintTop();
  };
  timers.push(setInterval(tickWH, 30000));
  if (isTradingNow()) setTimeout(tickWH, 6000);
  timers.push(setInterval(function () {
    // ★2026-10-16（用户："非开盘的时间没必要一直刷新"）：休市没必要每分钟读一次规则表 —— 改成 5 分钟一次；
    //   盘中仍 60 秒（AI 在会话侧改了记忆里的规则，一分钟内就反映到面板）。
    if (!isTradingNow() && Date.now() - lastRulesAt < 300000) return;
    lastRulesAt = Date.now();
    loadRules();
  }, 60000));
  tickFast();
  if (isTradingNow()) { tickRank(); tickBoard(); }
  var rdStop = function () {
    disposed = true;
    timers.forEach(function (t) { clearInterval(t); });
    timers = [];
  };
  // 合并页用：把雷达命中接到页面顶部的置顶横幅（2026-10-14）
  rdStop.setBridge = function (fn) { bridge = fn; };
  return rdStop;
};

// 独立面板形态（scenarios 里 type="radar" 时用）；同一份实现也被「选股建议 · 🛰️ 雷达」页签复用
renderers.radar = (body) => { body.classList.add('radar-panel'); return makeRadar(body); };

renderers.harness = (body, meta, head) => {
  body.classList.add('harness-panel');

  // 标题栏（标题行）加「重新加载」按钮 + 精简模式状态
  let wv = null;
  let hostTimer = null;   // 加载后 30s 注入兜底窗口
  let pinTimer = null;    // 常驻钉住重注入（5s）
  let disposed = false;   // 场景切换后停止一切注入
  const reloadBtn = el('button', 'file-refresh', '🔄 重新加载');
  reloadBtn.title = '重新加载对话窗口';
  reloadBtn.addEventListener('click', () => {
    if (wv) wv.setAttribute('src', wv.getAttribute('src') || '');
    else load();
  });
  const diag = el('span', 'harness-diag', '精简模式：注入中…');
  // 状态小字可点击 = 人工兜底：清掉本面板记住的会话 id，重新按会话名匹配一次。
  // 用途：万一绑错了会话（例如会话改名后被别处占用），用户点一下即可解绑重找，
  // 不用改代码、不用重启 GUI。（鼠标悬停有完整说明，见 injectFix 里的 diag.title）
  diag.style.cursor = 'pointer';
  diag.addEventListener('click', () => {
    try {
      if (!wv || !wv.executeJavaScript) return;
      // 只清本面板的绑定（键名带面板 id），别把其它 AI 面板的记忆一起清掉
      const js = "try{localStorage.removeItem('app_pin_bind_v2:" + PANEL_KEY + "')}catch(e){}; 'ok'";
      wv.executeJavaScript(js)
        .then(() => { try { wv.reload(); } catch (e) { /* ignore */ } })
        .catch(() => { /* ignore */ });
    } catch (e) { /* ignore */ }
  });
  if (head) {
    head.classList.add('file-head');
    const acts = el('div', 'file-head-acts ai-head-acts');
    // 顺序：按钮在左、状态小字在右。窄面板（如 Blender 的 1 列宽 AI 面板）下，
    // 长状态文字不再把按钮挤到换行/裁切；小字自身用省略号收尾（CSS .harness-diag）。
    acts.appendChild(reloadBtn);
    acts.appendChild(diag);
    head.appendChild(acts);
  }

  const msg = el('div', 'harness-loading', '正在加载对话窗口…');
  body.appendChild(msg);

  // 内嵌窗口只显示聊天框：隐藏左侧菜单栏、右侧详情列、对话区顶部标题栏、对话轨迹 turn rail、宽度拖条。
  // 主策略 = CSS 优先（不依赖 JS）：应用框架带内联 grid-template-columns 且含 minmax(0,1fr) 中列，
  // 用 !important 强制成 0 / 1fr / 0；标题栏 data-phase>header、拖条 data-width-handle、手柄 data-side 稳定属性。
  // 兜底 = JS 常驻（MutationObserver + 定时器）纠正 React 重渲染。
  const HARNESS_CHAT_CSS = [
    '[style*="grid-template-columns"][style*="minmax(0"] { grid-template-columns: minmax(0, 1fr) !important; }',
    '[style*="grid-template-columns"][style*="minmax(0"] [data-side="sidebar"], [style*="grid-template-columns"][style*="minmax(0"] [data-side="details"] { display: none !important; }',
    '[style*="grid-template-columns"][style*="minmax(0"] [data-phase] > header { display: none !important; }',
    '[style*="grid-template-columns"][style*="minmax(0"] [data-width-handle] { display: none !important; }',
    // 文字铺满：老写法 `[data-phase] { --dsh-chat-content-width: 100% !important }` 在引擎 0.1.6 上
    // **整条空转**（[data-phase] 不是会话相位容器、变量也不是在别处算的）——详见文件上方
    // 「会话列铺满」那段实测说明。现在改成盖 max-width + 沿祖先链压变量，与场景 0 共用同一组常量。
    HARNESS_WIDE_CSS
  ].join('\n');
  // 钉住脚本（幂等：已装则不再重复装定时器；webview 内部重载后 window 重置，可重新注入）
  // pinTarget 支持「会话名」或「会话名数组」：多候选按顺序匹配——① 标题完全相等 ② 包含匹配，
  // **匹配时忽略大小写与空格**（兼容「oa系统运维」↔「<客户>oa系统运维」↔「<客户> OA 系统运维」）。
  // sessionTitle（可选）= 该会话的**完整真实标题**（从引擎会话索引里查到的原文），优先级最高、要求完全相等。
  // 每次注入都会刷新 window.__pinDiag（诊断），宿主面板会把结果写到标题行小字，便于排查。
  // 没写 pinTarget = 「不钉」（下面 clickItem 会直接什么都不做，交给用户自己选会话）。
  // 别再给缺省值塞历史默认「oa系统运维」：那会让主标签的「工作台」对话面板跑去找 OA 会话、
  // 甚至点到别的会话上去（2026-09-19 去掉这个默认值）。
  const rawPin = (meta && meta.pinTarget) || '';
  const pinTargets = (Array.isArray(rawPin) ? rawPin : [rawPin])
    .map(t => String(t == null ? '' : t).trim()).filter(Boolean);
  const PIN_TARGETS_JS = JSON.stringify(pinTargets);
  const PIN_SESSION_JS = JSON.stringify(String((meta && meta.sessionTitle) || '').trim());
  // ★会话 id = 身份校验（不再是"直达通道"）★ 2026-09-19 二次修正：
  //   场景 json 的 sessionId 是引擎真实 id（如 session-XXXXXXXX-…），面板拿它来**核对**
  //   「画面上这条会话是不是我要的那条」——因为会话行 DOM 里没有 id，只有标题，而本机真的
  //   存在过只差一个空格的孪生会话（`DSH 改造` / `DSH改造`），光凭标题会认错人。
  //   ⚠ 早先"写 dsh.sessions.current + reload 直达"的做法一度**删除**过（共用分区下两个面板互抢）；
  //     2026-09-19 三次定稿后**已按新前提重新启用**（一板一分区 ⇒ 各写各的键，见下方 ⓪）。
  //   ⚠ 早先"这些面板里侧栏压根不在 DOM 里、点行不可靠"的说法（2026-09-14）也已作废：
  //     2026-09-19 探针实测：侧栏会话行**加载后 1 秒内就在 DOM 里**（[role="treeitem"] 有 7~8 行），点行有效。
  const PIN_SESSION_ID_JS = JSON.stringify(String((meta && meta.sessionId) || '').trim());
  // 面板身份：分区现在是**一板一分区**（见 panelPartition 与 webview 处的说明），但"记住的会话标题"
  // 仍然按面板分键存 —— 面板重建、场景里换了会话 id 时它还要用，换分区不影响这个键的用途。
  const PANEL_KEY = String((meta && meta.id) || (meta && meta.scenario) || 'ai').replace(/[^A-Za-z0-9_-]/g, '') || 'ai';
  const PIN_PANEL_JS = JSON.stringify(PANEL_KEY);
  // ★拖文件进对话窗口（2026-09-23 用户要求）：webview 内部页面收 drop，把文件路径插进输入框
  //   （只插入、不自动发送，用户手动回车）。幂等：window.__kunDropGen 装过一次就不再装；
  //   webview 内部真重载时 window 重置 ⇒ 按新页面重新装一遍。
  //   路径链：guest 页面的 webUtils（引擎一般没暴露）→ File.path（老 Electron）→ text/uri-list / text/plain 兜底
  //   （系统文件拖拽 / 素材管理窗口 startDrag 拖回，dataTransfer 里都带 uri-list，能稳定拿到完整路径）。
  //   输入框 = 引擎 Composer 的 contenteditable（data-composer-input，Lexical 宿主），用 execCommand 插入
  //   会触发标准 InputEvent，Lexical 正常感知（只插文本、不拼文件名以外的任何东西）。
  const HARNESS_DROP_JS = `(() => {
    const GEN = 'kun-drop-v1';
    if (window.__kunDropGen === GEN) return;
    window.__kunDropGen = GEN;
    document.addEventListener('dragover', (ev) => {
      if (!ev.dataTransfer) return;
      try { ev.preventDefault(); } catch (e) { }
    });
    document.addEventListener('drop', (ev) => {
      if (!ev.dataTransfer) return;
      try { ev.preventDefault(); } catch (e) { }
      try { ev.stopPropagation(); } catch (e) { }
      const paths = [];
      const files = ev.dataTransfer.files || [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        let p = '';
        try { if (window.webUtils && window.webUtils.getPathForFile) p = window.webUtils.getPathForFile(f); } catch (e) { }
        if (!p) p = (f && f.path) || '';
        if (p) paths.push(p);
      }
      if (!paths.length) {
        let raw = '';
        try { raw = ev.dataTransfer.getData('text/uri-list') || ev.dataTransfer.getData('text/plain') || ''; } catch (e) { }
        String(raw).split(/\\r?\\n/).forEach((line) => {
          const s = line.trim();
          if (!s) return;
          let p = s;
          if (/^file:\\/\\//i.test(s)) {
            try { p = decodeURIComponent(s.replace(/^file:\\/\\//i, '').replace(/^\\/([A-Za-z]:)/, '$1').replace(/\\//g, '\\\\')); } catch (e) { }
          }
          if (p) paths.push(p);
        });
      }
      if (!paths.length) return;
      const el = document.querySelector('[data-composer-input]');
      if (!el) return;
      el.focus();
      try { document.execCommand('insertText', false, paths.join('\\n')); } catch (e) { }
    });
  })()`;
  const HARNESS_PIN_JS = `(() => {
    const TARGETS = ${PIN_TARGETS_JS};
    const SESSION_TITLE = ${PIN_SESSION_JS};
    const SESSION_ID = ${PIN_SESSION_ID_JS};
    const PANEL = ${PIN_PANEL_JS};
    // ⚠ 侧栏真实 DOM 结构（依据引擎源码 packages/client/ui-workspace/src/client/rows/Rows.tsx）：
    //   · 会话行  = div[role="treeitem"][aria-selected]  —— 没有 data-session-id 之类的 id 属性，
    //     标题在一个 <span class*="title"> 里，行内还有状态点/相对时间/菜单按钮（所以整行 textContent
    //     带着"3天前"这种尾巴，**不能拿整行文本做完全相等判断**）。
    //   · 分组头  = div[role="treeitem"][aria-expanded]（项目/工作区分组，点了只展开分组、不换会话）。
    //   因此：① 只认会话行，永不点分组头；② 只用"标题节点"的文本比对；③ 分组头只用来展开分组。
    // ⚠ 键里带上本面板"当前的钉会话配置"：改了场景（换会话 / 删掉绑定）就一定换键 ⇒
    //   旧记忆立刻失效。否则会出现"场景 json 里已经删了 id，面板还按记住的标题去点旧会话"的鬼绑定。
    const PIN_SIG = (SESSION_ID || SESSION_TITLE || (TARGETS || []).join('|') || 'none');
    const BIND_KEY = 'app_pin_bind_v2:' + PANEL + ':' + PIN_SIG;
    // ★幂等守卫（2026-09-19 三次定稿补）★：宿主每 5 秒会"轻量重注入"一次本脚本（好让 webview 内部
    //   重载后钉住仍生效），而下面装的是 setInterval ⇒ 每次注入都新装一轮，几分钟就能攒出几十个 4 秒循环，
    //   表现为面板状态小字周期性乱跳、空转扫 DOM（用户实感「每隔一会跳一下」）。
    //   同一份配置（GEN 里含面板名 + 钉会话签名）只装一次；重复注入只做一次轻量 tick（点一次 + 刷诊断）。
    //   webview 内部真重载时 window 重置 ⇒ GEN 自然失效 ⇒ 重新按新页面装一遍，语义不变。
    const GEN = 'pin_v3:' + BIND_KEY;
    if (window.__pinGen === GEN) { try { window.__pinTick && window.__pinTick(); } catch (e) { } return; }
    // 绑定 = 本面板上次钉成功的那条会话行的**精确标题**（DOM 里拿不到会话 id，标题就是最可靠的钥匙）；
    // 键名带面板 id，所以多个 AI 面板共用同一个浏览器分区也不会互相串。
    const readBind = () => { try { const s = localStorage.getItem(BIND_KEY); return s ? JSON.parse(s) : null; } catch (e) { return null; } };
    const saveBind = (title) => {
      try { if (title) localStorage.setItem(BIND_KEY, JSON.stringify({ title: String(title) })); } catch (e) { }
    };
    // ── localStorage['dsh.sessions.current'] 的读写（引擎用它记住"上次会话"）──
    // ★2026-09-19 三次定稿：写键 + reload 的"直达通道"**已按新前提重新启用**（见下方 ⓪）。
    //   前提变了：每个带 sessionId 的面板现在有**自己的分区**，本面板写的键只有本面板读得到，
    //   所以不会再出现"共用分区时代"的 8 秒级互抢 ⇒ 这条通道是本面板的首选钉法。
    //   （readSel 也重新可以当"本面板状态"用：它现在就是本面板自己分区里的值。）
    const SEL_KEY = 'dsh.sessions.current';
    const readSel = () => { try { return JSON.parse(localStorage.getItem(SEL_KEY) || 'null'); } catch (e) { return null; } };
    const writeSel = (id) => {
      try {
        const cur = readSel() || {};
        localStorage.setItem(SEL_KEY, JSON.stringify(Object.assign({}, cur, { sessionId: String(id) })));
        return true;
      } catch (e) { return false; }
    };
    // 重载次数记在 sessionStorage（**跨 reload 存活**，localStorage 会被应用改写、不适合计数）
    const RELOAD_KEY = 'app_pin_reloads';
    const readReloads = () => { try { return Number(sessionStorage.getItem(RELOAD_KEY) || 0) || 0; } catch (e) { return 0; } };
    const bumpReloads = () => { try { sessionStorage.setItem(RELOAD_KEY, String(readReloads() + 1)); } catch (e) { } };
    const clearReloads = () => { try { sessionStorage.removeItem(RELOAD_KEY); } catch (e) { } };
    // ★ 节流时间戳也必须跨 reload 存活（2026-09-19 修）：原先记在 window.__pinReloadAt 上，
    //   reload 之后归零 ⇒ "两次之间至少隔 8 秒"实际失效 ⇒ 一个场景挂两个 AI 面板时，两边会
    //   连续互抢同一个当前会话键，抢输的一方重载次数很快用光，最终停在"选择工作区开始"的
    //   新建会话页（症状：切过来偶尔就是新画面）。
    const RELOAD_AT_KEY = 'app_pin_reload_at';
    const readReloadAt = () => { try { return Number(sessionStorage.getItem(RELOAD_AT_KEY) || 0) || 0; } catch (e) { return 0; } };
    const markReloadAt = () => { try { sessionStorage.setItem(RELOAD_AT_KEY, String(Date.now())); } catch (e) { } };
    // ── 跨面板「改键 + 重载」令牌：**一板一分区之后已无必要**，代码保留仅作诊断（refreshDiag 会显示它）。
    //    历史：共用分区（主窗口 persist:harness）里 dsh.sessions.current 只有一个值，同一时刻只允许
    //    一个面板改它，才需要这个令牌；现在各面板写各面板分区里的键 ⇒ 令牌恒为空、claimFree() 恒真。
    const CLAIM_KEY = 'app_pin_claim_v1';
    const CLAIM_TTL = 20000;
    const readClaim = () => { try { return JSON.parse(localStorage.getItem(CLAIM_KEY) || 'null'); } catch (e) { return null; } };
    const claimFree = () => {
      const c = readClaim();
      if (!c || !c.panel) return true;
      if (String(c.panel) === String(PANEL)) return true;
      return (Date.now() - Number(c.at || 0)) > CLAIM_TTL;
    };
    const takeClaim = () => { try { localStorage.setItem(CLAIM_KEY, JSON.stringify({ panel: String(PANEL), at: Date.now() })); } catch (e) { } };
    const dropClaim = () => {
      try { const c = readClaim(); if (c && String(c.panel) === String(PANEL)) localStorage.removeItem(CLAIM_KEY); } catch (e) { }
    };
    // 重载预算（只在本面板**自己分区**的 sessionStorage 里计数，不会被对侧清零）：
    // 前 3 次间隔 ≥8 秒（正常情况下第一次就到位），第 4~5 次转慢车道 ≥25 秒（目标 id 失效时别狂刷），
    // 用完就只走 ① 点侧栏会话行，不会再无休止重载。
    const RELOAD_MAX = 5;
    const reloadGap = () => (readReloads() >= 3 ? 25000 : 8000);
    // ⚠ 归一化**必须保留空格**（只把连续空白压成一个空格）：2026-09-19 实测本机存在"长得一样"的孪生会话
    //   （「DSH 改造」与「DSH改造」、「GUI 页面改造」与「GUI页面改造」），早先这里把空白**全部删掉**（只留字母），
    //   全删了 ⇒ 孪生会话的标题**完全相等** ⇒ 面板把"另一个几乎空白的同名会话"当成目标、还报"✓ 已钉绑定"
    //   ⇒ 用户看到的就是"切过来是空的新画面"（而存储里指向的确实是另一个会话 id）。
    const norm = (x) => String(x == null ? '' : x).toLowerCase().replace(/\\s+/g, ' ').trim();
    // ⚠ 教训（2026-09-14 当天踩过一次，别再犯）：**不要把搜索范围限制在某个"看起来像侧栏"的容器里**。
    //   实测 [data-side="sidebar"] 挂在拖拽手柄上、不是会话列表容器 → 限定范围后候选恒为空 →
    //   一个会话都点不到，面板就停在"新会话/欢迎页"（表现为"每个场景都切不进去"）。
    //   正确做法：全文档找，但 ① 排除聊天内容区（避免点到聊天记录里的同名字样）
    //            ② 绝不点分组头（[aria-expanded]，点了只展开分组）③ 会话行优先。
    const inChat = (e) => {
      try { return !!(e.closest && e.closest('[data-chat-flow],[data-phase]')); } catch (err) { return false; }
    };
    const clickTarget = (e) => (e.closest && e.closest('button,[role="button"],[role="option"],[role="treeitem"],a,li,[aria-selected]')) || e;
    const isRowLike = (e) => !!(e.closest && e.closest('[aria-selected],[data-session-id]'));
    const isGroupHead = (e) => {
      try { return !!(e.hasAttribute && e.hasAttribute('aria-expanded')); } catch (err) { return false; }
    };
    // 元素文本：会话行优先取行内标题节点（整行文本带"3天前"尾巴），其余用自身文本
    const readText = (e) => {
      try {
        if (e.querySelector) {
          const t = e.querySelector('[class*="title"]');
          if (t && t.textContent && t.textContent.trim()) return t.textContent.trim();
        }
      } catch (err) { /* ignore */ }
      return String((e && e.textContent) || '').replace(/\\s+/g, ' ').trim();
    };
    // 一行会话的"标题文本"（给诊断/记忆用）：标题节点 ＞ 按钮 aria-label 里的「标题」＞ 整行文本
    const rowTitle = (row) => {
      try {
        if (!row) return '';
        const t = row.querySelector ? row.querySelector('[class*="title"]') : null;
        if (t && t.textContent && t.textContent.trim()) return t.textContent.trim();
        const b = row.querySelector ? row.querySelector('[aria-label]') : null;
        if (b) {
          const m = String(b.getAttribute('aria-label') || '').match(/[「『"“]([^」』"”]{1,80})[」』"”]/);
          if (m && m[1].trim()) return m[1].trim();
        }
        return String(row.textContent || '').replace(/\\s+/g, ' ').trim();
      } catch (e) { return ''; }
    };
    // 页面标题 =「<会话名> — DSH 本地构建」：去掉后缀就是会话名（应用自己写的，最权威）
    const stripSuffix = (s) => String(s == null ? '' : s).replace(/\s*[—–\-]\s*DSH.*$/, '').trim();
    // 纯页签名（聊天区顶栏里第一个文本常常只是页签名"对话"），不能当成会话名
    const isTabLabel = (s) => /^(对话|chat|新视图|new view)$/i.test(String(s || '').trim());
    // 当前**已打开**的会话名。⚠ 顺序很重要（2026-09-14 修）：
    //   ① document.title —— 应用把会话名写在这里，最可靠（日志实证："<客户>oa系统运维 — DSH 本地构建"）
    //   ② 侧栏高亮行标题（侧栏多半没渲染，聊胜于无）
    //   ③ 聊天区顶栏文字 —— **放最后**：顶栏第一个文本往往是页签名「对话」，优先用它就会误报
    //      "未切到 · 对话"（状态小字显示错误，功能其实是好的）。
    // 都读不到时返回 ''（例如停在"新会话/欢迎页"）。
    const titleOf = () => {
      const dt = stripSuffix(document.title);
      if (dt && dt !== 'DSH 本地构建') return dt;
      try {
        const sel = document.querySelector('[aria-selected="true"]');
        const st = rowTitle(sel);
        if (st && st.length <= 60 && !isTabLabel(st)) return st;
      } catch (e) { /* ignore */ }
      try {
        const h = document.querySelector('[data-phase] > header');
        const ht = h ? String(h.textContent || '').replace(/\\s+/g, ' ').trim() : '';
        if (ht && ht.length <= 60 && !isTabLabel(ht)) return ht;
      } catch (e) { /* ignore */ }
      return '';
    };
    // 这个会话名是从哪儿读来的（只用于诊断显示，便于判断状态小字是否可信）
    const titleSrc = () => {
      const dt = stripSuffix(document.title);
      if (dt && dt !== 'DSH 本地构建') return '页面标题';
      try {
        const st = rowTitle(document.querySelector('[aria-selected="true"]'));
        if (st && st.length <= 60 && !isTabLabel(st)) return '侧栏高亮行';
      } catch (e) { /* ignore */ }
      try {
        const h = document.querySelector('[data-phase] > header');
        const ht = h ? String(h.textContent || '').replace(/\\s+/g, ' ').trim() : '';
        if (ht && ht.length <= 60 && !isTabLabel(ht)) return '聊天区顶栏';
      } catch (e) { /* ignore */ }
      return '读不到';
    };
    const findBest = (relaxed) => {
      // 全文档候选（排除聊天内容区；含"可点/可读"的常见节点）
      // relaxed=true 时不再排除聊天区：只在"严格找一遍没找到"时才用，保证绝不出现"一个都找不到"
      let all;
      try {
        all = document.querySelectorAll('div,button,span,a,li,p,[role="option"],[role="button"],[role="treeitem"],[aria-selected],[data-session-id]');
      } catch (e) { return null; }
      const cand = [];
      for (let i = 0; i < all.length; i++) {
        const e = all[i];
        try {
          const rowLike = isRowLike(e) || isRowLike(clickTarget(e));
          if (!relaxed && !rowLike && inChat(e)) continue;   // 聊天内容区：默认不点
          const raw = readText(e);
          if (!raw || raw.length > 160) continue;
          const n = norm(raw);
          if (!n) continue;
          const target = clickTarget(e);
          if (isGroupHead(target)) continue;            // 分组头：只用于展开分组，不当作会话
          cand.push({ el: e, t: raw, n: n, rank: rowLike ? 0 : 1 });
        } catch (err) { /* ignore */ }
      }
      if (!cand.length) return null;
      // ① 绑定标题 → ② 场景指定标题 → ③ 候选名；同一目标里"会话行优先、完全相等优先、文本越短越像行"
      const bind = readBind();
      const want = [];
      if (bind && bind.title) want.push({ n: norm(bind.title), by: '绑定标题:' + bind.title, exactOnly: true });
      if (SESSION_TITLE) want.push({ n: norm(SESSION_TITLE), by: '指定标题:' + SESSION_TITLE, exactOnly: true });
      for (let ti = 0; ti < TARGETS.length; ti++) want.push({ n: norm(TARGETS[ti]), by: '候选名:' + TARGETS[ti], exactOnly: false });
      for (let w = 0; w < want.length; w++) {
        const W = want[w];
        if (!W.n) continue;
        let best = null, bestKey = Infinity;
        for (let i = 0; i < cand.length; i++) {
          const c = cand[i];
          const exact = (c.n === W.n);
          if (!exact) {
            if (W.exactOnly) continue;
            if (c.n.indexOf(W.n) < 0 || c.n.length > 240) continue;
          }
          const key = c.rank * 1e6 + (exact ? 0 : 1e5) + c.n.length;
          if (key < bestKey) { bestKey = key; best = c; }
        }
        if (best) return { el: best.el, by: (best.n === W.n ? '完全相等 · ' : '包含 · ') + W.by };
      }
      return null;
    };
    const brief = (e) => String((e && (rowTitle(e) || e.textContent)) || '').replace(/\\s+/g, ' ').trim().slice(0, 36);
    const listCands = () => {
      const seen = {}, out = [];
      try {
        const els = document.querySelectorAll('[aria-selected],[data-session-id],[role="treeitem"],div,li,button');
        for (let i = 0; i < els.length && out.length < 12; i++) {
          const e = els[i];
          if (inChat(e)) continue;
          if (isGroupHead(e)) continue;
          const t = rowTitle(e);
          if (!t || t.length > 40) continue;
          if (seen[t]) continue;
          seen[t] = 1; out.push(t);
        }
      } catch (err) { /* ignore */ }
      return out;
    };
    const refreshDiag = (hit) => {
      const h = hit || findBest(false) || findBest(true);   // 与实际点击同一套判据（严格→放宽）
      window.__pinDiag = {
        targets: TARGETS,
        sessionTitle: SESSION_TITLE,
        sessionId: SESSION_ID,
        stored: (() => { const s = readSel(); return (s && s.sessionId) ? String(s.sessionId) : ''; })(),
        reloads: readReloads(),
        reloadMax: RELOAD_MAX,
        claim: (() => {
          const c = readClaim();
          return c ? (String(c.panel) + ' · ' + Math.round((Date.now() - Number(c.at || 0)) / 1000) + ' 秒前') : '';
        })(),
        claimFree: claimFree(),
        title: titleOf(),
        titleSrc: titleSrc(),
        matched: h ? brief(h.el) : '',
        by: h ? h.by : '',
        bound: readBind(),
        rows: (() => { try { return document.querySelectorAll('[aria-selected],[data-session-id],[role="treeitem"]').length; } catch (e) { return -1; } })(),
        clicked: !!window.__pinClickedAt,
        clickedAt: window.__pinClickedAt || 0,
        cands: listCands()
      };
    };
    refreshDiag(null);
    // 用渲染层独立标记（不能复用 __pinSet：主进程注入会先设它，会把这里的新逻辑顶掉）
    if (window.__pinSetR) return;
    window.__pinSetR = true;
    // 双保险：顺手占住 main.js 旧版脚本的标记位，让那份"扫全文档模糊点击"的老逻辑直接 return
    try { window.__pinSet = true; } catch (e) { /* ignore */ }
    let last = 0;
    const reveal = (el) => {
      const hidden = [];
      let n = el.parentElement;
      while (n) {
        if (n.style && n.style.display === 'none') { hidden.push(n); n.style.display = ''; }
        n = n.parentElement;
      }
      return hidden;
    };
    const fire = (el) => {
      const o = { bubbles: true, cancelable: true, view: window };
      try { el.dispatchEvent(new PointerEvent('pointerdown', o)); } catch (_) { }
      try { el.dispatchEvent(new MouseEvent('mousedown', o)); } catch (_) { }
      try { el.dispatchEvent(new PointerEvent('pointerup', o)); } catch (_) { }
      try { el.dispatchEvent(new MouseEvent('mouseup', o)); } catch (_) { }
      try { el.dispatchEvent(new MouseEvent('click', o)); } catch (_) { }
    };
    const doClick = (hit) => {
      const c = hit.el.closest('button,[role="button"],[role="option"],[role="treeitem"],a,li') || hit.el;
      const hidden = reveal(c);
      fire(c);
      last = Date.now();
      window.__pinClickedAt = last;
      window.__pinLastHitTitle = rowTitle(c) || rowTitle(hit.el) || '';
      refreshDiag({ el: c, by: hit.by });
      hidden.forEach(function (h) { h.style.display = 'none'; });
    };
    // 兜底：会话列表若被折叠/隐藏，虚拟列表可能因容器 0 尺寸而不渲染任何列表项（DOM 里找不到）
    // 处理：临时注入样式强制显示侧栏 → 等 React 渲染 → 点击 → 立刻恢复隐藏（用户看不到闪动）。
    // ⚠ 这条规则是实测有效的版本（display:flex + min-width:0）。上一版改成 position:fixed/visibility:hidden
    //   后虚拟列表不再渲染列表项 → 反而"一个会话都切不进去"，已回退，别再改。
    let forceTimes = 0, forceStyle = null;
    const forceShow = () => {
      if (forceStyle) return;
      try {
        forceStyle = document.createElement('style');
        forceStyle.textContent = '[data-side="sidebar"]{display:flex!important;min-width:0!important}';
        document.head.appendChild(forceStyle);
      } catch (e) { forceStyle = null; }
    };
    const forceHide = () => { try { if (forceStyle) { forceStyle.remove(); } } catch (e) { /* ignore */ } forceStyle = null; };
    // 是否已经钉住：按"侧栏高亮行标题"判断（权威），命中绑定标题/指定标题/候选名都算到位
    // 画面证据：标题对 ≠ 画面已打开。2026-09-19 探针实测（全新分区 + 只写当前会话键）：
    //   document.title 已经是目标会话名、存储里也指向目标，但**画面仍是「探索未至之境 / 选择一个工作区开始」**
    //   （路由停在 / 没进会话）⇒ 旧判据会认为"已钉住"从而**永不修复**。所以必须再要一条画面证据。
    const hasFlow = () => { try { return !!document.querySelector('[data-chat-flow],[data-phase]'); } catch (e) { return false; } };
    const welcomeish = () => {
      try {
        const b = (document.body && document.body.innerText) || '';
        return b.indexOf('探索未至之境') >= 0 || b.indexOf('选择一个工作区开始') >= 0;
      } catch (e) { return false; }
    };
    const titlePinned = () => {
      const t = norm(titleOf());
      if (!t) return false;
      let ok = false;
      const bind = readBind();
      if (bind && bind.title && t === norm(bind.title)) ok = true;
      if (!ok && SESSION_TITLE && t === norm(SESSION_TITLE)) ok = true;
      if (!ok) {
        for (let i = 0; i < TARGETS.length; i++) {
          const T = norm(TARGETS[i]);
          if (T && t.indexOf(T) >= 0) { ok = true; break; }
        }
      }
      if (!ok) return false;
      // 标题对上之后再看一眼画面：没有对话流、且还在欢迎/选工作区页 ⇒ 不算钉住（交给侧栏点击那条路）
      if (!hasFlow() && welcomeish()) return false;
      return true;
    };
    // 侧栏只渲染「当前会话所属工作区分组」的行，其他分组的行不在 DOM 里 →
    // 必须先把折叠的分组展开，目标会话行才会出现（这是「切场景钉不住」的根因）
    let expandedByUs = [];
    const collapsedGroups = () => {
      const out = [];
      const gs = document.querySelectorAll('[role="treeitem"][aria-expanded]');
      for (let i = 0; i < gs.length; i++) {
        if (gs[i].getAttribute('aria-expanded') === 'false' && expandedByUs.indexOf(gs[i]) < 0) out.push(gs[i]);
      }
      return out;
    };
    let tries = 0;
    const clickItem = () => {
      // 解绑状态（场景里没给 id / 标题 / 候选名，也没有记住的绑定）→ 什么都不做：
      // 不点侧栏、不展开分组、不强制显隐，面板就停在当前会话，由用户自己选。
      if (!SESSION_ID && !SESSION_TITLE && !(TARGETS && TARGETS.length)) {
        const bU = readBind();
        if (!bU || !bU.title) { refreshDiag(null); return; }
      }
      // 「已钉住」只看**本面板画面**这一条证据（2026-09-19 三次定稿）。
      //   ⚠ 判"成没成"不能用存储值：一板一分区之后 dsh.sessions.current 确实是本面板自己的了，
      //   但"键写对了"不等于"应用已经切过去"（reload 尚未发生时两者必然不一致）⇒ 画面才是唯一判据。
      //   标题证据本身也有死角（应用停在空会话/欢迎页时 document.title 可能还没改），所以 titlePinned() 里
      //   额外要求「有对话流」或「不在欢迎页」——两条合起来才判到位。
      //   下面这个存储值只用于状态小字；写键之前要跟它比一次（见 ⓪）。
      const storedNow = (() => { try { const s = readSel(); return (s && s.sessionId) ? String(s.sessionId) : ''; } catch (e) { return ''; } })();
      if (titlePinned()) {            // 已在这个会话上 → 不再点击、不再折腾侧栏
        // 到位后把"这次钉住的精确标题"记下来（DOM 里没有会话 id，标题就是钥匙）：
        // 以后先按这条标题找，会话列表顺序/分组折叠变化都不会再找错。
        try {
          const b0 = readBind();
          const exact = (window.__pinLastHitTitle || '').trim();
          const cur = (titleOf() || '').trim();
          const remember = cur || exact;
          if (remember && (!b0 || b0.title !== remember)) saveBind(remember);
        } catch (e) { }
        clearReloads();               // 到位即清零本面板的重载预算（本分区只有本面板，清零不会让对侧无限刷）
        dropClaim();                  // ★ 到位即让位：让另一个 AI 面板去改当前会话键（两边各一次就都到位）
        last = Date.now();
        refreshDiag(null);
        return;
      }
      if (Date.now() - last < 1500) return;
      // ⓪ 直达通道（写**本面板自己分区**的 dsh.sessions.current + reload 一次）★2026-09-19 三次定稿·重新启用★
      //   早先删掉它，是因为"两个面板共用 persist:harness、键只有一个值"⇒ 互抢 + 8 秒级对刷
      //   （用户实感「每隔一会跳一下刷新、一打字就断」）。
      //   现在每个带 sessionId 的面板有**自己的分区**（webview 的 panelPartition(meta)）⇒
      //   本面板写的键只有本面板读得到 ⇒ 互抢在结构上不可能 ⇒ 这条通道重新成为**首选**钉法。
      //   探针实测（<盘根>:\DSH\工具\probe-seed\，全新分区）：写目标 id + reload ⇒ 1.4 秒落在目标会话。
      //   预算：最多 RELOAD_MAX 次、两次之间隔 reloadGap()（sessionStorage 计数，跨 reload 存活，
      //   而且只在**本分区本面板**里，不会再被对侧清零）。用完就退回 ① 点侧栏会话行，不会无休止重载。
      //   ⚠ 判"到没到位"仍然只看本面板画面（titlePinned）—— 那是唯一可信的本面板状态；
      //     这里读键只用于判断"要不要写"，不用于判断"成没成"。
      if (SESSION_ID) {
        const curSel = (() => { try { const s = readSel(); return (s && s.sessionId) ? String(s.sessionId) : ''; } catch (e) { return ''; } })();
        if (curSel !== String(SESSION_ID) && readReloads() < RELOAD_MAX && (Date.now() - readReloadAt()) > reloadGap()) {
          bumpReloads();
          markReloadAt();
          if (writeSel(SESSION_ID)) {
            refreshDiag(null);
            try { location.reload(); } catch (e) { }
            return;                                  // reload 后脚本会重跑：那时键已是目标，应用直接进会话
          }
        }
      }
      // 说明：走到这里只有一种情形 —— 标题还不像目标：可能应用还在加载（下一轮就好）、
      //   会话行还没渲染（下面会展开分组 / 临时显示侧栏）、或该会话 id 已失效（被归档/删除）。
      // ① 兜底：按标题在会话行里精确匹配（找不到时放宽再找一遍）
      let hit = findBest(false) || findBest(true);
      if (hit) { doClick(hit); forceHide(); return; }
      // 找不到会话行：逐个展开折叠的工作区分组（每轮展开一个，等 React 渲染下轮再找）
      const collapsed = collapsedGroups();
      if (collapsed.length) {
        expandedByUs.push(collapsed[0]);
        fire(collapsed[0]);
        refreshDiag(null);
        return;
      }
      // 分组都展开了仍找不到：侧栏被精简模式隐藏时虚拟列表可能整个不渲染 →
      // 临时让侧栏"有尺寸但不可见"，等渲染完再找（随后立刻恢复隐藏）。最多重试 6 轮。
      if (forceTimes < 6) {
        forceTimes++;
        forceShow();
        refreshDiag(null);
        setTimeout(() => {
          const h2 = findBest();
          if (h2) doClick(h2);
          forceHide();
        }, 900);
        return;
      }
      refreshDiag(null);
    };
    setTimeout(clickItem, 1000);
    // 切场景后先用 1.5s 快节奏重试 20 次（尽快到位），之后 4s 常驻守着
    const fastTimer = setInterval(() => {
      clickItem();
      if (++tries >= 20) clearInterval(fastTimer);
    }, 1500);
    setInterval(clickItem, 4000);
    setInterval(() => refreshDiag(null), 4000);
    // 幂等标记 + 轻量 tick：宿主每 5 秒的重注入只会调 __pinTick（点一次 + 刷一次诊断），
    // 不再新装定时器 —— 见脚本开头的守卫。webview 内部重载后 window 重置，这里会重新执行。
    window.__pinGen = GEN;
    window.__pinTick = () => { try { clickItem(); refreshDiag(null); } catch (e) { } };

    // ---- 聊天滚动锚定：面板展开/收起（webview 视口变大变小）时稳住聊天内容 ----
    // 目的：展开瞬间不要"内容乱跳"。规则：原本贴底 → 展开后仍贴底；否则保持原阅读位置。
    (() => {
      if (window.__expandAnchor) return;
      window.__expandAnchor = true;
      const findScroller = () => {
        let n = document.querySelector('[data-chat-flow]') || document.querySelector('[data-phase]');
        while (n && n !== document.body) {
          try {
            const cs = getComputedStyle(n);
            if (n.scrollHeight - n.clientHeight > 40 && /(auto|scroll)/.test(cs.overflowY)) return n;
          } catch (e) { /* ignore */ }
          n = n.parentElement;
        }
        return document.scrollingElement || document.documentElement;
      };
      window.addEventListener('resize', () => {
        const el = findScroller();
        if (!el) return;
        const wasBottom = (el.scrollHeight - el.scrollTop - el.clientHeight) < 48;
        const prevTop = el.scrollTop;
        requestAnimationFrame(() => {
          try {
            if (wasBottom) el.scrollTop = el.scrollHeight;   // 原来贴底 → 继续贴底
            else el.scrollTop = prevTop;                     // 否则维持原来的阅读位置
          } catch (e) { /* ignore */ }
        });
      }, { passive: true });
    })();
  })();`;
  const HARNESS_FIX_JS = `(() => {
    const pick = () => {
      // 页面唯一带内联 grid-template-columns 且含 minmax( 的元素就是应用框架（已实测 grids=1）。
      const all = document.querySelectorAll('[style*="grid-template-columns"]');
      for (let i = 0; i < all.length; i++) {
        const v = all[i].style.gridTemplateColumns || '';
        if (v.indexOf('minmax(') >= 0) return all[i];
      }
      return null;
    };
    let WIDE = '';   // 铺满诊断（「1列 1354/1386px」），每次 fix 刷新
    const fix = () => {
      const f = pick();
      if (!f) return false;
      // 会话列铺满（三重法的 ①+②，见文件上方「会话列铺满」那段实测说明）：每次 fix 都重算一次，
      // React 重渲染把 max-width 顶回去也能在一秒内纠回来；顺带把实测宽度留给下面的诊断。
      try { WIDE = ${HARNESS_WIDE_PIN_JS}; } catch (e) { /* ignore */ }
      // 单轨道：配合下方结构隐藏，仅剩的中心列占满整个框架
      f.style.setProperty('grid-template-columns', 'minmax(0, 1fr)', 'important');
      // 结构法：定位中心列（含聊天流/会话），隐藏框架其余非定位子元素（侧栏列/详情列）
      let center = null;
      const flow = f.querySelector('[data-chat-flow]') || f.querySelector('[data-phase]');
      if (flow) {
        let n = flow;
        while (n && n.parentElement && n.parentElement !== f) n = n.parentElement;
        if (n && n.parentElement === f) center = n;
      }
      // 保护：中心列未定位到就不做结构隐藏，避免整面板空白
      if (center) {
        const kids = f.children;
        for (let i = 0; i < kids.length; i++) {
          const c = kids[i];
          if (c === center) continue;
          let pos = 'static';
          try { pos = getComputedStyle(c).position; } catch (e) { /* ignore */ }
          if (pos === 'absolute') continue;
          c.style.setProperty('display', 'none', 'important');
        }
      }
      f.querySelectorAll('[data-side="sidebar"], [data-side="details"], [data-width-handle]').forEach(function (h) {
        h.style.setProperty('display', 'none', 'important');
      });
      f.querySelectorAll('[data-phase]').forEach(function (r) {
        // ⚠ 这里以前还有一行「r.style.setProperty('--dsh-chat-content-width','100%','important')」，
        //   2026-09-20 第三波删掉：本版 [data-phase] 是连接状态小圆点按钮，不是会话相位容器，
        //   写在上面的宽度变量压根到不了会话列（实测列仍被 clamp 到 887px）。宽度改由
        //   文件上方 HARNESS_WIDE_PIN_JS 直接盖 [data-chat-flow] / [data-composer-card] 的 max-width
        //   并沿祖先链压变量——**不再依赖 [data-phase] 这个会跟着版本漂移的锚点**。
        // 隐藏不含聊天流的子元素（即会话顶栏；body 含 [data-chat-flow]，保留）
        const kids = r.children;
        let hasFlow = false;
        for (let j = 0; j < kids.length; j++) {
          if (kids[j].querySelector('[data-chat-flow]')) { hasFlow = true; break; }
        }
        if (!hasFlow) return;
        for (let j = 0; j < kids.length; j++) {
          const c = kids[j];
          if (c.querySelector('[data-chat-flow]')) continue;
          c.style.setProperty('display', 'none', 'important');
        }
      });
      if (flow) {
        const sc = flow.parentElement;
        if (sc && sc.firstElementChild && sc.firstElementChild !== flow) {
          sc.firstElementChild.style.setProperty('display', 'none', 'important');
        }
      }
      return true;
    };
    fix();
    // ★幂等守卫（2026-09-20 第三波补）★：宿主会 dom-ready/did-finish-load 各投一次、之后连续 30 秒
    //   每 1.5 秒再投一次，不守卫就会攒出几十个 MutationObserver + 1 秒循环空转（pin_v3 那边踩过同一个坑，
    //   表现为面板小字周期乱跳 + 白扫 DOM）。现在：注入一次就 fix 一次（上面那行在守卫外），定时器只装一轮。
    if (!window.__kunFixOn) {
      window.__kunFixOn = 1;
      try { new MutationObserver(fix).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] }); } catch (e) {}
      setInterval(fix, 1000);
    }
    const all = document.querySelectorAll('[style*="grid-template-columns"]');
    const f2 = pick();
    const vals = [];
    for (let i = 0; i < all.length && i < 5; i++) vals.push(all[i].style.gridTemplateColumns);
    const rootEl = document.getElementById('root') || document.body;
    return JSON.stringify({
      found: !!f2,
      grid: f2 ? f2.style.gridTemplateColumns : '',
      grids: all.length,
      vals: vals,
      iframes: document.querySelectorAll('iframe').length,
      hasPhase: document.querySelectorAll('[data-phase]').length,
      hasChatFlow: document.querySelectorAll('[data-chat-flow]').length,
      wide: WIDE,   // 铺满实测：「1列 1576/1592px」= 铺满几列 · 列宽/可用宽（宿主把它显示在面板标题行）
      rootKids: rootEl ? rootEl.children.length : -1,
      title: document.title,
      url: location.href
    });
  })();
  // ---- 钉住「oa系统运维」会话：面板固定显示该会话，主窗口切换会话不跟随 ----
  ${HARNESS_PIN_JS}
  `;

  const injectFix = async () => {
    try { await wv.insertCSS(HARNESS_CHAT_CSS); } catch (e) { /* ignore */ }
    // 拖文件进对话窗口（幂等脚本，装上监听后重复执行只返回）
    try { await wv.executeJavaScript(HARNESS_DROP_JS); } catch (e) { /* ignore */ }
    let simplify = '';
    let wideTxt = '';
    try {
      const r = await wv.executeJavaScript(HARNESS_FIX_JS);
      let info = null;
      try { info = JSON.parse(r); } catch (e) { /* ignore */ }
      if (info && info.found) simplify = '精简 ✓';
      else if (info) simplify = '等界面…';
      // 铺满实测（例 `铺满 1列 1576/1592px`）：两者只差十几像素（我们留的那 16px）就是铺开了；
      // 还差几百像素说明页面里没有 [data-chat-flow]（引擎换版了）——见文件上方「会话列铺满」。
      if (info && info.wide) { simplify += (simplify ? ' · ' : '') + '铺满 ' + info.wide; wideTxt = info.wide; }
    } catch (e) { /* ignore */ }
    // 钉会话诊断：HARNESS_PIN_JS 每次注入都会刷新 window.__pinDiag，这里读回来显示在面板标题行
    let pinTxt = '钉会话: 检测中…';
    try {
      const d = await wv.executeJavaScript('window.__pinDiag || null');
      if (d && d.targets) {
        const want = [String(d.sessionTitle || '')].filter(Boolean).concat(d.targets || []).join(' / ');
        const nz = (s) => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();   // ⚠ 保留空格：别把 'DSH 改造' 和 'DSH改造' 混成一个（同名孪生会话）
        // 面板当前显示的会话名（取自侧栏高亮行标题，权威）作为最终判据
        const live = String(d.title || '');
        const liveN = nz(live);
        const okName = (!!d.sessionTitle && liveN === nz(d.sessionTitle)) ||
          (d.targets || []).some(t => { const tn = nz(t); return tn && liveN.indexOf(tn) >= 0; });
        const boundOk = !!(d.bound && d.bound.title && liveN === nz(d.bound.title));
        const ok = boundOk || okName;
        const unbound = !d.sessionId && !d.sessionTitle && !(d.targets || []).length && !(d.bound && d.bound.title);
        pinTxt = unbound ? '○ 未绑定 · 面板自由选会话'
          : (boundOk ? '✓ 已钉绑定' : (ok ? '✓ 已钉' : ('未切到 · ' + (live || '读不到当前会话'))));
        if (unbound) diag.title = '该面板未绑定任何会话（场景 json 里没写 sessionTitle / sessionId / pinTarget）\n' +
          '面板停在它当前显示的会话上，不会被自动切换，也不再去找侧栏。\n' +
          '要重新绑定：给该面板补 sessionTitle + sessionId，再切一次场景即可（改了就会立刻生效）。';
        else diag.title = '该面板应对应的会话：' + want +
          '\n指定会话 id：' + (d.sessionId || '（未指定 · 靠标题匹配）') +
          '\n应用存储里的当前会话：' + (d.stored || '（空）') + (String(d.stored) === String(d.sessionId) && d.sessionId ? ' ✓ 一致' : '') +
          (d.reloads ? ('\n直达通道残留计数 ' + d.reloads + ' 次（该通道已停用）') : '') +
          '\n面板当前显示的会话：' + (live || '（读不到）') + (d.titleSrc ? ('（来源：' + d.titleSrc + '）') : '') +
          (d.bound && d.bound.title ? ('\n已记住的会话标题：' + d.bound.title) : '\n已记住的会话标题：（无 · 首次按名字找）') +
          '\n界面可识别会话行/选中行数：' + (d.rows == null ? '未知' : d.rows) +
          (d.matched ? ('\n已定位到会话行：' + d.matched + '（' + d.by + '）') : '\n未定位到目标会话行（分组折叠或列表未渲染）') +
          (d.cands && d.cands.length ? ('\n界面里能看到的会话/行：' + d.cands.join(' ｜ ')) : '\n界面里能看到的会话/行：（读不到）') +
          (wideTxt ? ('\n会话列铺满：' + wideTxt + '（列宽 / 可用宽；只差十几像素＝已铺满，差几百＝没铺上，多半引擎换版了）') : '') +
          '\n\n点击此处 = 忘掉记住的标题，重新按会话名匹配';
      }
    } catch (e) { /* ignore */ }
    diag.textContent = (simplify ? simplify + ' · ' : '') + pinTxt;
  };
  // 主进程通道注入（更可靠）：轮询 webview 的 webContentsId，让 main 直接注入并写日志
  // ⚠ 注意：main.js 注入脚本里**旧版**还带一套"扫全文档模糊匹配后点击"的钉会话循环
  //   （每 4s 点一次），它会和渲染层的新逻辑打架 —— 渲染层刚钉对，它又把面板点到
  //   聊天记录里含同名字样的随便一个元素上，于是"切场景后会话错乱/切不过去"。
  //   这里固定传一个**绝不可能匹配到任何元素**的哨兵目标（NUL 字符不会出现在任何 textContent 里），
  //   于是 main 侧只保留"注入布局修复 + 截图 + 日志"，点击权完全交给本文件的 HARNESS_PIN_JS。
  const mainInject = () => {
    try {
      if (!wv || !wv.getWebContentsId) return;
      const id = wv.getWebContentsId();
      if (id === -1 || typeof window.app.injectHarnessPanel !== 'function') return;
      window.app.injectHarnessPanel(id, '\u0000no-pin\u0000');
    } catch (e) { /* ignore */ }
  };

  const load = async () => {
    if (disposed) return;
    try {
      const ready = await window.app.isHarnessReady();
      if (!ready) {
        msg.textContent = 'Harness 引擎尚未就绪。请稍候或点击「重试」。';
        const retry = el('button', 'file-refresh', '🔄 重试');
        retry.addEventListener('click', () => { msg.textContent = '正在加载对话窗口…'; load(); });
        msg.appendChild(retry);
        return;
      }
      const url = await window.app.getHarnessUrl();
      body.innerHTML = '';
      wv = document.createElement('webview');
      wv.className = 'harness-wv';
      // ⚠ 分区策略（2026-09-19 三次定稿·探针实测）：**带 sessionId 的面板一板一分区**（panelPartition）。
      //   探针证据（<盘根>:\DSH\工具\probe-seed\，隐藏 Electron + 真引擎 + 全新分区）：
      //   写入 dsh.sessions.current = 目标 id 后 reload ⇒ 1.4 秒即落在目标会话（标题、正文全对）。
      //   旧注释"独立分区会卡在欢迎页"是误判（当时快照取太早）；但旧注释另一半是对的：
      //   共用分区时"写键 + reload"必然互抢 ⇒ 那才是 2026-09-19「每隔一会跳一下刷新」的真因。
      //   ⇒ 现在两者合起来用：分区私有 + 各自写自己的键，既确定又不互抢。
      //   没带 sessionId 的面板仍然退回 soloHarnessPartition()（主窗口 = persist:harness，与主标签同分区）。
      wv.setAttribute('partition', panelPartition(meta));
      wv.setAttribute('allowpopups', '');
      wv.addEventListener('dom-ready', injectFix);
      wv.addEventListener('did-finish-load', injectFix);
      // 主进程通道 + 宿主定时兜底：加载后前 30 秒每 1.5 秒重注入
      hostTimer = setInterval(() => {
        if (disposed) return;
        if (!wv || !wv.getWebContentsId) return;
        if (wv.getWebContentsId() === -1) return;
        mainInject();
        injectFix();
      }, 1500);
      setTimeout(() => { if (hostTimer) clearInterval(hostTimer); }, 30000);
      // 常驻钉住：每 5 秒轻量重注入一次（webview 内部重载后钉住仍生效；脚本自身幂等）
      pinTimer = setInterval(() => {
        if (disposed) return;
        try { if (wv && wv.executeJavaScript) wv.executeJavaScript(HARNESS_PIN_JS + '\n' + HARNESS_DROP_JS).catch(function () { }); } catch (e) { /* ignore */ }
      }, 5000);
      wv.setAttribute('src', url);
      body.appendChild(wv);
    } catch (e) {
      msg.textContent = '加载失败：' + (e && e.message || e);
    }
  };
  load();
  // 场景切换清理：停止注入定时器（webview DOM 由 loadScenario 统一移除）
  return () => {
    disposed = true;
    if (hostTimer) clearInterval(hostTimer);
    if (pinTimer) clearInterval(pinTimer);
  };
};

// ============ 个人站场景（personal-site）：官网预览 / 关于 / 自媒体 / 联系 / 投喂 ============
var SITE_BASE = null;
function siteBase() {
  if (SITE_BASE) return Promise.resolve(SITE_BASE);
  const p = (window.app && window.app.site && window.app.site.preview)
    ? window.app.site.preview()
    : Promise.resolve(null);
  return p.then(function (r) {
    SITE_BASE = (r && r.base) || '';
    return SITE_BASE;
  }).catch(function () { SITE_BASE = ''; return ''; });
}

// 二维码大图弹层（点击外部关闭）
var siteQrLayer = null;
function showQr(src, title) {
  if (!siteQrLayer) {
    siteQrLayer = el('div', 'site-qr-layer');
    siteQrLayer.addEventListener('click', function () { siteQrLayer.style.display = 'none'; });
    document.body.appendChild(siteQrLayer);
  }
  siteQrLayer.innerHTML = '';
  const box = el('div', 'site-qr-box');
  if (title) box.appendChild(el('div', 'site-qr-title', title));
  const img = document.createElement('img');
  img.src = src;
  box.appendChild(img);
  box.appendChild(el('div', 'site-qr-close', '✕ 点击关闭'));
  siteQrLayer.appendChild(box);
  siteQrLayer.style.display = 'flex';
}

// 官网/项目本地文件夹（2026-10-22：浏览根由主进程 SITE_BROWSE_DIR 决定，默认 <工作台>
renderers['site-folder'] = (body, meta, head) => {
  body.classList.add('site-folder');
  const K = window.app && window.app.site;
  let ROOT_LABEL = '<工作台>';
  // 标题栏右侧：当前路径（带背景栏）——路径只显示此处，内容区保持清爽
  const crumbs = el('div', 'file-crumbs', '加载中…');
  if (head) {
    head.classList.add('file-head');
    const acts = el('div', 'file-head-acts');
    acts.appendChild(crumbs);
    head.appendChild(acts);
  }
  // 2026-10-22：路径可点/右键复制（换渲染器时丢过一次这功能）
  let curRel = '';
  const absOf = (rel) => {
    const r = String(rel || '').replace(/\//g, '\\');
    return r ? (ROOT_LABEL.replace(/\\+$/, '') + '\\' + r) : ROOT_LABEL;
  };
  const flashCrumb = (msg) => {
    const back = crumbs.textContent;
    crumbs.textContent = msg;
    setTimeout(function () { if (crumbs.textContent === msg) crumbs.textContent = back; }, 1200);
  };
  const copyPath = (rel) => {
    const p = absOf(rel);
    let ok = false;
    try { ok = (typeof flowCopyText === 'function') ? flowCopyText(p) : false; } catch (e) { ok = false; }
    if (!ok) {
      try {
        const ta = document.createElement('textarea');
        ta.value = p; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        ok = document.execCommand('copy'); ta.remove();
      } catch (e2) { ok = false; }
    }
    flashCrumb(ok ? '已复制 ✓' : '复制失败');
  };
  crumbs.style.cursor = 'pointer';
  crumbs.title = '点击复制当前路径（条目上右键＝复制那个文件的路径）';
  crumbs.addEventListener('click', function () { copyPath(curRel); });
  const list = el('div', 'file-list');
  body.appendChild(list);

  // 内容可拖动：按住列表任意处上下/左右拖动即可平移浏览（像拖画布），松手停住。
  // 拖动超过 4px 阈值后抑制这一次 click，避免拖动时误进目录/误开文件。
  let dragOn = false, dragMoved = false, dragX = 0, dragY = 0, dragTop = 0, dragLeft = 0;
  list.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0) return;
    // 条目上按住＝拖出文件（交给原生拖动），只有空白处才启动平移
    if (ev.target && ev.target.closest && ev.target.closest('.file-row')) return;
    dragOn = true; dragMoved = false;
    dragX = ev.clientX; dragY = ev.clientY;
    dragTop = list.scrollTop; dragLeft = list.scrollLeft;
  });
  window.addEventListener('mousemove', (ev) => {
    if (!dragOn) return;
    const dx = ev.clientX - dragX, dy = ev.clientY - dragY;
    if (!dragMoved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
      dragMoved = true;
      list.classList.add('dragging');
    }
    if (!dragMoved) return;
    list.scrollTop = dragTop - dy;
    list.scrollLeft = dragLeft - dx;
    ev.preventDefault();
  });
  window.addEventListener('mouseup', () => {
    if (!dragOn) return;
    dragOn = false;
    list.classList.remove('dragging');
  });
  // 捕获阶段吃掉“拖动结束”的那一次 click（否则松手会误打开目录/文件）
  list.addEventListener('click', (ev) => {
    if (!dragMoved) return;
    dragMoved = false;
    ev.stopPropagation();
    ev.preventDefault();
  }, true);

  const fmtSize = (n) => {
    if (n == null) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  };
  const fmtTime = (t) => {
    if (!t) return '—';
    const d = new Date(t * 1000);
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  };
  const joinRel = (r, name) => r ? r + '/' + name : name;
  const parentRel = (r) => {
    const i = r.lastIndexOf('/');
    return i > 0 ? r.slice(0, i) : '';
  };
  const urlOf = (rel) => {
    // 相对路径逐段编码（目录名可能含中文/空格），经主进程静态服务打开
    return (base || '') + '/' + rel.split('/').map(encodeURIComponent).join('/');
  };
  let base = '';
  const mkRow = (ic, name, metaText, isDir, onOpen, relPath) => {
    const r = el('div', 'file-row');
    r.appendChild(el('span', 'ic', ic));
    r.appendChild(el('span', 'grow', name));
    r.appendChild(el('span', 'meta', metaText));
    if (isDir) r.style.cursor = 'pointer';
    if (onOpen) r.addEventListener('click', onOpen);
    // 可拖出：按住条目拖到资源管理器＝复制一份；拖到浏览器/编辑器等窗口＝把文件直接交给它。
    // 走 Electron 原生拖动（主进程 startDrag），所以 dragstart 里先 preventDefault，再由主进程接管。
    if (relPath && K && K.startDrag) {
      r.setAttribute('draggable', 'true');
      r.title = (isDir ? '点击进入' : '点击打开') + '\n按住拖出去：拖到资源管理器＝复制一份，拖到其他窗口＝直接给它';
      r.addEventListener('dragstart', (ev) => {
        ev.preventDefault();
        K.startDrag(relPath);
        r.classList.add('dragging-out');
        setTimeout(() => { r.classList.remove('dragging-out'); }, 1500);
      });
    } else if (isDir) {
      r.title = '点击进入';
    }
    // 右键＝复制这个条目的完整路径
    if (relPath) {
      r.addEventListener('contextmenu', function (ev) { ev.preventDefault(); copyPath(relPath); });
    }
    return r;
  };
  const load = (rel) => {
    list.innerHTML = '';
    list.appendChild(el('div', 'file-empty', '加载中…'));
    if (!K || !K.files) {
      crumbs.textContent = ROOT_LABEL + '（无本地文件服务）';
      list.innerHTML = '';
      list.appendChild(el('div', 'file-empty', '（本地文件服务不可用）'));
      return;
    }
    K.files(rel).then(res => {
      if (!res || !res.ok) {
        list.innerHTML = '';
        list.appendChild(el('div', 'file-empty', '无法读取：' + ((res && res.err) || '未知')));
        return;
      }
      base = res.base;
      if (res.root) ROOT_LABEL = res.root;
      const cur = res.rel || '';
      curRel = cur;
      crumbs.textContent = cur ? (ROOT_LABEL + '\\' + cur.replace(/\//g, '\\')) : ROOT_LABEL;
      crumbs.title = crumbs.textContent;
      list.innerHTML = '';
      if (cur) {
        list.appendChild(mkRow('↩️', '..', '上级目录', true, () => load(parentRel(cur))));
      }
      (res.rows || []).forEach(it => {
        const relChild = joinRel(cur, it.name);
        list.appendChild(mkRow(it.isDir ? '📁' : '📄', it.name,
          it.isDir ? '目录' : fmtSize(it.size) + ' · ' + fmtTime(it.mtime),
          it.isDir, () => {
            if (it.isDir) { load(relChild); }
            else if (K && K.openFile) {
              // 2026-10-22：官网目录内的文件走静态服务（原预览行为），其它项目文件交给系统默认程序
              K.openFile(relChild);
            }
            else {
              const url = urlOf(relChild);
              if (window.app && window.app.site && window.app.site.open) window.app.site.open(url);
              else window.open(url);
            }
          }, relChild));
      });
      if (!res.rows || !res.rows.length) list.appendChild(el('div', 'file-empty', '（空目录）'));
    }).catch(() => {
      list.innerHTML = '';
      list.appendChild(el('div', 'file-empty', '读取失败'));
    });
  };
  load('');
};

// 官网预览：webview 内嵌 <工作台>
renderers['site-preview'] = (body, meta, head) => {
  body.classList.add('site-preview-panel');
  const msg = el('div', 'site-msg', '正在加载官网预览…');
  body.appendChild(msg);
  let wv = null;          // 当前内嵌的 webview（「刷新网页」按钮要操作它）
  // 2026-10-22：两个预览源（官网 / DSH 社区），选择记在 localStorage，按面板 id 区分
  let srcKey = 'app.site.preview.src' + (meta && meta.id ? '.' + meta.id : '');
  let current = (localStorage.getItem(srcKey) === 'community') ? 'community' : 'site';
  const urls = { site: '', community: '' };
  let commOk = true;
  let btnSite = null, btnComm = null;
  function paintSwitch() {
    if (!btnSite || !btnComm) return;
    btnSite.classList.toggle('on', current === 'site');
    btnComm.classList.toggle('on', current === 'community');
    btnComm.title = commOk ? '预览 DSH 社区站（<工作台>' : 'DSH 社区目录不存在：<工作台>';
  }
  function switchTo(k) {
    if (k === current) return;
    current = k;
    try { localStorage.setItem(srcKey, k); } catch (e) { /* ignore */ }
    paintSwitch();
    if (k === 'community' && !commOk) { msg.textContent = 'DSH 社区目录不存在：<工作台>'; return; }
    const target = urls[k];
    if (wv && target) { msg.textContent = ''; wv.setAttribute('src', target); }
    else { load(); }
  }
  if (head) {
    const acts = el('div', 'file-head-acts');
    // ── 预览源切换：官网 / DSH 社区（2026-10-22 加）──
    if (!document.getElementById('site-switch-css')) {
      const swStyle = document.createElement('style');
      swStyle.id = 'site-switch-css';
      swStyle.textContent = [
        '.site-switch{display:flex;gap:3px;margin-right:8px;padding:2px;border-radius:8px;background:rgba(255,255,255,.06)}',
        '.site-switch-btn{border:0;background:transparent;color:#9aa4b2;font-size:12px;line-height:1;padding:4px 10px;border-radius:6px;cursor:pointer;white-space:nowrap}',
        '.site-switch-btn:hover{color:#fff}',
        '.site-switch-btn.on{background:#2f6feb;color:#fff}'
      ].join('\n');
      document.head.appendChild(swStyle);
    }
    const sw = el('div', 'site-switch');
    btnSite = el('button', 'site-switch-btn', '官网');
    btnComm = el('button', 'site-switch-btn', 'DSH 社区');
    btnSite.onclick = function () { switchTo('site'); };
    btnComm.onclick = function () { switchTo('community'); };
    sw.appendChild(btnSite);
    sw.appendChild(btnComm);
    acts.appendChild(sw);
    paintSwitch();
    // 🔄 刷新网页：改完本地 index.html / 素材后不用重启工作台，点一下就能看到新效果
    // 用 reloadIgnoringCache()：静态服务对同一个 URL 可能走缓存，普通 reload() 会看到旧页面
    const reloadBtn = el('button', 'file-refresh', '🔄 刷新网页');
    reloadBtn.title = '重新载入本地网页（跳过缓存）—— 改完 index.html 点这里立刻看效果';
    reloadBtn.addEventListener('click', function () {
      if (wv && typeof wv.reloadIgnoringCache === 'function') {
        wv.reloadIgnoringCache();
      } else if (wv && typeof wv.reload === 'function') {
        wv.reload();
      } else {
        load();                 // 还没加载出来 / 上次加载失败 → 整个重来一遍
        return;
      }
      reloadBtn.textContent = '🔄 刷新中…';
      setTimeout(function () { reloadBtn.textContent = '🔄 刷新网页'; }, 800);
    });
    acts.appendChild(reloadBtn);
    const openBtn = el('button', 'file-refresh', '🌐 浏览器打开');
    openBtn.title = '在系统浏览器打开当前预览的站点';
    openBtn.addEventListener('click', function () {
      const u = urls[current] || urls.site;
      if (u) {
        if (window.app && window.app.site && window.app.site.open) window.app.site.open(u);
        else window.open(u);
        return;
      }
      siteBase().then(function (base) {
        const url = base ? base + '/index.html' : '<工作台>';
        if (window.app && window.app.site && window.app.site.open) window.app.site.open(url);
        else window.open(url);
      });
    });
    acts.appendChild(openBtn);
    head.appendChild(acts);
  }
  const load = async () => {
    try {
      const r = (window.app && window.app.site && window.app.site.preview)
        ? await window.app.site.preview()
        : null;
      if (!r) {
        msg.textContent = '预览服务不可用（主进程未就绪）。';
        return;
      }
      SITE_BASE = r.base;
      urls.site = r.url || '';
      urls.community = r.communityUrl || '';
      commOk = (r.communityOk !== false) && !!urls.community;
      if (current === 'community' && !commOk) { current = 'site'; }
      paintSwitch();
      if (current === 'community' && !commOk) {
        msg.textContent = 'DSH 社区目录不可用：<工作台>';
      }
      body.innerHTML = '';
      wv = document.createElement('webview');
      wv.className = 'site-wv';
      wv.setAttribute('partition', 'persist:site');   // 个人站独立会话，不与 Harness 冲突
      // 官网是浅色主题，默认滚动条偏白刺眼：注入暗色科技风滚动条（青色高亮）
      const SITE_SCROLL_CSS = [
        '::-webkit-scrollbar { width: 9px; height: 9px; }',
        '::-webkit-scrollbar-track { background: rgba(10,14,20,.25); }',
        '::-webkit-scrollbar-thumb { background: rgba(6,231,233,.38); border-radius: 5px; border: 2px solid rgba(10,14,20,.3); }',
        '::-webkit-scrollbar-thumb:hover { background: rgba(6,231,233,.68); }',
        '::-webkit-scrollbar-corner { background: transparent; }'
      ].join('\n');
      const injectScroll = function () {
        try { wv.insertCSS(SITE_SCROLL_CSS); } catch (e) { /* ignore */ }
      };
      wv.addEventListener('dom-ready', injectScroll);
      wv.addEventListener('did-finish-load', injectScroll);
      wv.setAttribute('src', urls[current] || urls.site);
      body.appendChild(wv);
    } catch (e) {
      msg.textContent = '加载失败：' + (e && e.message || e);
    }
  };
  load();
};

// 关于<机主>：头像 + 简介 + 标签 + 时间线
renderers['site-about'] = (body, meta, head) => {
  body.classList.add('site-about');
  siteBase().then(function (base) {
    const card = el('div', 'site-about-card');
    const avatar = document.createElement('img');
    avatar.className = 'site-avatar';
    avatar.src = base + '/头像/<机主>头像像素画.webp';
    avatar.alt = '<机主>';
    card.appendChild(avatar);
    card.appendChild(el('div', 'site-name', '<机主>'));
    card.appendChild(el('div', 'site-slogan', '梦想是优雅地淋一场雨'));
    const tags = ['像素画', '前端', 'AI 工具', '独立开发者', 'UP主'];
    const tagRow = el('div', 'site-tags');
    tags.forEach(function (t) { tagRow.appendChild(el('span', 'site-tag', t)); });
    card.appendChild(tagRow);
    card.appendChild(el('div', 'site-desc',
      '「<机主> · 个人站」作者：像素风 + 下雨背景的个人网站，上架小工具，分享创作内容。'));
    const tl = el('div', 'site-tl');
    [
      ['2026 · 建站', '个人官网「<机主>」上线（像素风 · 下雨主题）'],
      ['2026 · 工具', '「上班盯盘助手」上架 Cloudflare Pages'],
      ['2026 · 内容', 'B站 / 抖音 / 小红书 持续更新像素画与创作']
    ].forEach(function (it) {
      const row = el('div', 'site-tl-row');
      row.appendChild(el('span', 'site-tl-t', it[0]));
      row.appendChild(el('span', 'site-tl-d', it[1]));
      tl.appendChild(row);
    });
    card.appendChild(tl);
    body.appendChild(card);
  });
};

// 自媒体账号：B站 / 抖音 / 小红书 卡片（打开主页 + 二维码弹层）
renderers['site-media'] = (body, meta, head) => {
  body.classList.add('site-media');
  const MEDIA = [
    { name: '哔哩哔哩', handle: '@<机主>', emoji: '📺', url: 'https://<你的B站主页>', qr: '/账号二维码/哔哩哔哩.jpg' },
    { name: '抖音', handle: '@<机主>（蛋炒饭里悟真我）', emoji: '🎵', url: 'https://www.douyin.com/user/MS4wLjABAAAAV55NIdPri0csj-Gwi0vT4Yuuest0zIvnTZGxe2K3YAXuESpAombXp397aY98jDq-', qr: '/账号二维码/抖音.png' },
    { name: '小红书', handle: '@<机主>', emoji: '📕', url: 'https://www.xiaohongshu.com/user/profile/64be86b700000000140342cb', qr: '/账号二维码/小红书.png' }
  ];
  siteBase().then(function (base) {
    const grid = el('div', 'site-media-grid');
    MEDIA.forEach(function (m) {
      const c = el('div', 'site-media-card');
      c.appendChild(el('div', 'site-media-emoji', m.emoji));
      c.appendChild(el('div', 'site-media-name', m.name));
      c.appendChild(el('div', 'site-media-handle', m.handle));
      const btns = el('div', 'site-media-btns');
      const open = el('button', 'site-btn', '打开主页 ↗');
      open.addEventListener('click', function () { window.open(m.url); });
      const qr = el('button', 'site-btn', '二维码');
      qr.addEventListener('click', function () { showQr(base + m.qr, m.name + ' · ' + m.handle); });
      btns.appendChild(open); btns.appendChild(qr);
      c.appendChild(btns);
      grid.appendChild(c);
    });
    body.appendChild(grid);
  });
};

// 项目管理：项目卡片列表（图标 + 名字 + 状态 + 描述 + 本地路径 + 操作）
renderers['site-projects'] = (body, meta, head) => {
  body.classList.add('site-projects');
  // 项目数据：以后管理就在这里增删改
  const PROJECTS = [
    {
      icon: '/小工具/上班盯盘助手图标.png',
      name: '上班盯盘助手',
      status: '已上线',
      desc: '股票摸鱼小工具 · 像素风',
      path: '<工作台>',
      url: 'https://<你的工具站>/'
    }
  ];
  siteBase().then(function (base) {
    const list = el('div', 'site-projects-list');
    PROJECTS.forEach(function (p) {
      const card = el('div', 'site-project-card');
      // 头部：图标 + 名字 + 状态
      const top = el('div', 'site-project-top');
      const img = document.createElement('img');
      img.className = 'site-project-icon';
      img.src = base + p.icon;
      img.alt = p.name;
      top.appendChild(img);
      const info = el('div', 'site-project-info');
      // 「已上线」很小的字，放在名字上面（不增加卡片高度）
      const st = el('span', 'site-project-status-mini', p.status);
      if (String(p.status || '').indexOf('已') === 0) st.classList.add('ok');
      info.appendChild(st);
      const nameRow = el('div', 'site-project-name-row');
      nameRow.appendChild(el('div', 'site-project-name', p.name));
      // 描述并入名字行（不单独占一行）
      if (p.desc) nameRow.appendChild(el('span', 'site-project-desc-inline', '· ' + p.desc));
      info.appendChild(nameRow);
      top.appendChild(info);
      // 右上角：路径小字 + 打开文件夹按钮（同一行，路径在前按钮在后，紧凑）
      if (p.path) {
        const pathRow = el('div', 'site-project-path', p.path);
        pathRow.title = '本地项目目录（可选中复制）';
        top.appendChild(pathRow);
      }
      const openDir = el('button', 'site-project-open', '📁 打开');
      openDir.title = '在资源管理器打开 ' + p.path;
      openDir.addEventListener('click', function () {
        if (window.app && window.app.site && window.app.site.openFolder) window.app.site.openFolder(p.path);
      });
      top.appendChild(openDir);
      card.appendChild(top);
      list.appendChild(card);
    });
    if (!PROJECTS.length) list.appendChild(el('div', 'file-empty', '（暂无项目，内容预留）'));
    body.appendChild(list);
  });
};

// 我的网址：一条一条的列表（图标 + 名字 + 网址标签 + 在线状态，点击在浏览器打开）
// 个人站为置顶网站（下方横栏分隔）；其余为个人站内容的相关链接；每 1 分钟自动探测一次在线状态
renderers['site-urls'] = (body, meta, head) => {
  body.classList.add('site-media');
  let disposed = false;
  // 网址数据：以后管理就在这里增删改（icon 为官网目录内相对路径；links 支持多条并标注；pinned 标记置顶）
  const URLS = [
    {
      icon: '/头像/<机主>头像像素画.webp', name: '个人站', pinned: true,
      links: [{ label: 'Pages', url: 'https://<你的站点>/' }]
    },
    {
      icon: '/小工具/上班盯盘助手官网大图.webp', name: '上班盯盘助手',
      links: [
        { label: 'GitHub', url: 'https://<你的GitHub账号>.github.io/shangban-dingpan/#donate' },
        { label: 'Pages', url: 'https://<你的工具站>/' }
      ]
    },
    // ── DSH 集市（三个地址一张卡：点卡片走第一链接，其余在下面）──
    {
      icon: '/img/panel/dsh-market.png', name: 'DSH 集市',
      links: [
        { label: 'www', url: 'https://www.mydsh.xyz/' },
        { label: '根域', url: 'https://mydsh.xyz/' },
        { label: 'Pages', url: 'https://<你的站点>/' }
      ]
    },
    // ── 两个公开仓库（各自的 GitHub 卡片）──
    {
      icon: '/img/panel/workbench.png', name: '<机主>的工作台',
      links: [{ label: 'GitHub', url: 'https://github.com/<你的GitHub账号>/<仓库名>' }]
    },
    {
      icon: '/img/panel/dsh-repo.png', name: '<机主>的DSH',
      links: [{ label: 'GitHub', url: 'https://github.com/<你的GitHub账号>/<仓库名>' }]
    }
  ];
  const openUrl = function (url) {
    if (window.app && window.app.site && window.app.site.open) window.app.site.open(url);
    else window.open(url);
  };
  const K = window.app && window.app.site;
  // 标题栏：探测说明小字 + 探测按钮
  if (head) {
    head.classList.add('file-head');
    const acts = el('div', 'file-head-acts');
    const note = el('span', 'site-probe-note', '⏱ 打开时探测一次，可手动重探');
    acts.appendChild(note);
    const probeBtn = el('button', 'file-refresh', '🔍 探测');
    probeBtn.title = '立即探测所有网址状态';
    acts.appendChild(probeBtn);
    head.appendChild(acts);
  }
  siteBase().then(function (base) {
    const grid = el('div', 'site-media-grid');
    // 状态管理：卡片级（该卡片所有链接全部失败才算离线）
    const rows = [];
    const statusEls = [];
    URLS.forEach(function (it) {
      const row = el('div', 'site-url-row' + (it.pinned ? ' pinned' : ''));
      const img = document.createElement('img');
      img.className = 'site-url-icon';
      img.src = base + it.icon;
      img.alt = it.name;
      row.appendChild(img);
      const info = el('div', 'site-url-info');
      const nameRow = el('div', 'site-url-name-row');
      nameRow.appendChild(el('div', 'site-url-name', it.name));
      info.appendChild(nameRow);
      const links = el('div', 'site-url-links');
      it.links.forEach(function (l) {
        const chip = el('a', 'site-url-chip');
        chip.title = '在浏览器打开 ' + l.url;
        if (l.label) chip.appendChild(el('span', 'site-url-chip-label', l.label));
        chip.appendChild(el('span', 'site-url-chip-url', String(l.url).replace(/^https?:\/\//, '')));
        chip.addEventListener('click', function (ev) {
          ev.stopPropagation();
          openUrl(l.url);
        });
        links.appendChild(chip);
      });
      info.appendChild(links);
      row.appendChild(info);
      // 右侧：网站状态
      const st = el('span', 'site-url-status', '…探测中');
      st.title = '网站在线状态';
      row.appendChild(st);
      row.title = '打开 ' + (it.links[0] ? it.links[0].url : '');
      row.addEventListener('click', function () {
        if (it.links.length) openUrl(it.links[0].url);
      });
      grid.appendChild(row);
      rows.push(row);
      statusEls.push({ it: it, el: st });
      // 置顶卡片之后插入横栏：其余均为个人站内容的相关链接
      if (it.pinned) {
        const bar = el('div', 'site-url-bar');
        bar.appendChild(el('span', 'site-url-bar-l', '个人站 · 置顶网站'));
        bar.appendChild(el('span', 'site-url-bar-r', '以下为个人站内容的相关链接'));
        grid.appendChild(bar);
      }
    });
    // 状态探测：全部卡片并发出探测；每 1 分钟自动一次
    const probe = function () {
      statusEls.forEach(function (se) {
        if (!se.it.links.length) { se.el.textContent = '—'; return; }
        se.el.textContent = '…探测中';
        se.el.className = 'site-url-status pending';
        let doneN = 0, okN = 0, failN = 0;
        se.it.links.forEach(function (l) {
          const p = (K && K.probe) ? K.probe(l.url) : Promise.resolve({ ok: false });
          p.then(function (r) {
            doneN++;
            if (r && r.ok) okN++; else failN++;
            if (doneN === se.it.links.length) {
              if (okN > 0) { se.el.textContent = '● 在线'; se.el.className = 'site-url-status on'; }
              else { se.el.textContent = '● 离线'; se.el.className = 'site-url-status off'; }
            }
          }).catch(function () {
            doneN++;
            if (doneN === se.it.links.length) {
              se.el.textContent = '● 离线'; se.el.className = 'site-url-status off';
            }
          });
        });
      });
    };
    probe();   // 打开面板时探测一次；之后只有手动点「探测」才查（不再每分钟轮询，省内存）
    // 探测按钮：手动立即探测
    if (head) {
      const btn = head.querySelector('.file-refresh');
      if (btn) btn.addEventListener('click', probe);
    }
    if (!URLS.length) grid.appendChild(el('div', 'file-empty', '（暂无网址，内容预留）'));
    body.appendChild(grid);
  });
  // 场景切换清理：目前没有定时器，只做 disposed 标记
  return () => { disposed = true; };
};

// ============ code-urls（程序开发场景「网址」）：项目相关网址的实时状态（点击用系统浏览器打开）============
// 数据来自场景 json：meta.urls = [{ name, url, note? }] —— 换项目只改 json，不动渲染器。
// 只用宿主通用能力：app.site.probe（主进程发 HTTP，绕开渲染器跨域限制）/ app.site.open（系统浏览器打开）。
// 首个用户：code-dev 场景「网址」窗口（取代原来那个空的「项目管理」预留位）。
renderers['code-urls'] = (body, meta, head) => {
  body.classList.add('web-panel');
  const K = window.app && window.app.site;
  const items = (Array.isArray(meta.urls) ? meta.urls : [])
    .filter((u) => u && u.url)
    .map((u) => ({
      name: String(u.name || u.url),
      url: String(u.url),
      note: String(u.note || ''),
      phone: !!u.phone,   // true = 标题栏出现 📱 按钮，用手机尺寸窗口打开
      ok: null,      // null=未探测 true=在线 false=离线
      code: 0,
      ms: null
    }));
  let timer = null;
  let disposed = false;

  const summary = el('span', 'stat-refresh web-summary', '');
  const probeBtn = el('button', 'file-refresh', '🔄 探测');
  probeBtn.title = '立即重新探测所有网址状态';
  if (head) {
    // 与<客户>「网址」面板同一套窄排样式（.kun-web-head）
    head.classList.add('kun-web-head');
    head.appendChild(el('span', 'stat-refresh', '30秒'));
    head.appendChild(summary);
    const acts = el('div', 'file-head-acts');
    // 📱 手机预览：条目带 "phone": true 才有（用户端 / 师傅端 H5）；点击开 400×830 独立窗口
    const phoneApi = window.app && window.app.code;
    items.filter((it) => it.phone).forEach((it) => {
      const pb = el('button', 'file-refresh web-preview-btn');
      pb.type = 'button';
      pb.title = '用手机尺寸窗口打开「' + it.name + '」（400×830，独立会话记住登录）';
      pb.appendChild(el('span', 'ico', '📱'));
      pb.appendChild(el('span', 'lb', it.name.replace(/\s*H5\s*$/i, '')));
      pb.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (!phoneApi || !phoneApi.phoneWindow) {
          if (summary) summary.textContent = '手机预览需重启一次工作台';
          return;
        }
        Promise.resolve(phoneApi.phoneWindow(it.url, it.name)).then((r) => {
          if (r && r.ok === false && summary) summary.textContent = '打不开：' + (r.err || '未知');
        }).catch(() => {
          if (summary) summary.textContent = '手机预览打不开';
        });
      });
      acts.appendChild(pb);
    });
    acts.appendChild(probeBtn);
    head.appendChild(acts);
  } else {
    body.appendChild(probeBtn);
  }

  const grid = el('div', 'web-grid');
  body.appendChild(grid);

  const openUrl = (url) => {
    if (K && K.open) K.open(url);
    else if (window.app && window.app.openExternal) window.app.openExternal(url);
    else window.open(url);
  };
  const copyUrl = (url, btn) => {
    const done = (pass) => {
      btn.textContent = pass ? '✓' : '✕';
      setTimeout(() => { btn.textContent = '⧉'; }, 1100);
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(() => done(true)).catch(() => done(false));
        return;
      }
    } catch (e) { /* ignore */ }
    done(false);
  };
  const card = (u) => {
    const c = el('div', 'web-card ' + (u.ok === false ? 'is-off' : 'is-ok'));
    const top = el('div', 'web-card-top');
    top.appendChild(el('span', 'web-name', u.name));
    top.appendChild(el('span', 'web-dot ' + (u.ok === true ? 'ok' : (u.ok === false ? 'down' : '')),
      u.ok === true ? '● 在线' : (u.ok === false ? '● 离线' : '● 待探测')));
    c.appendChild(top);
    const row = el('div', 'web-url-row');
    row.appendChild(el('span', 'web-url', u.url.replace(/^https?:\/\//, '')));
    const cb = el('button', 'web-copy', '⧉');
    cb.type = 'button';
    cb.title = '复制地址';
    cb.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      copyUrl(u.url, cb);
    });
    row.appendChild(cb);
    c.appendChild(row);
    if (u.note) c.appendChild(el('div', 'web-meta', u.note));
    const state = u.ok === true
      ? 'HTTP ' + (u.code || '--') + ' · ' + (u.ms != null ? u.ms + 'ms' : '')
      : (u.ok === false ? '无法连接' + (u.ms != null ? ' · ' + u.ms + 'ms' : '') : '探测中…');
    c.appendChild(el('div', 'web-meta', state));
    c.appendChild(el('div', 'web-open', '点击在浏览器中打开 ↗'));
    c.addEventListener('click', () => openUrl(u.url));
    return c;
  };
  const paint = () => {
    grid.innerHTML = '';
    if (!items.length) {
      grid.appendChild(el('div', 'web-empty', '（未配置网址：在场景 json 的 urls 里加）'));
      return;
    }
    items.forEach((u) => grid.appendChild(card(u)));
    if (!summary) return;
    const up = items.filter((u) => u.ok === true).length;
    const down = items.filter((u) => u.ok === false).length;
    if (down > 0) {
      summary.textContent = up + '/' + items.length + ' · ' + down + '异常';
      summary.style.color = 'var(--err)';
      summary.title = '离线：' + items.filter((u) => u.ok === false).map((u) => u.name).join('、');
    } else if (up === 0) {
      summary.textContent = '探测中…';
      summary.style.color = '';
      summary.title = '';
    } else {
      summary.textContent = up + '/' + items.length;
      summary.style.color = '';
      summary.title = '全部在线';
    }
  };
  const probe = () => {
    if (!K || !K.probe) { paint(); return; }
    probeBtn.disabled = true;
    Promise.all(items.map((u) => {
      const t0 = Date.now();
      return Promise.resolve(K.probe(u.url)).then((r) => {
        u.ok = !!(r && r.ok);
        u.code = (r && r.status) || 0;
        u.ms = Date.now() - t0;
      }).catch(() => {
        u.ok = false;
        u.code = 0;
        u.ms = Date.now() - t0;
      });
    })).then(() => {
      probeBtn.disabled = false;
      if (!disposed) paint();
    });
  };
  paint();
  probe();
  probeBtn.addEventListener('click', probe);
  timer = setInterval(() => { if (!disposed) probe(); }, 30000);
  return () => { disposed = true; if (timer) clearInterval(timer); };
};

// ============ Blender 场景（blender）：实时画面 / 本地文件 ============
// 场景独立性：只走 window.app.blender 这一套 IPC，不读股票 / OA / 个人站的任何数据。
// 画面来自主进程的抓帧进程（PrintWindow 抓 Blender 窗口 → JPEG），由本地静态服务直出，
// 渲染层只负责带时间戳轮询同一张图，所以帧数据不经过 IPC。

// Blender 实时画面（大窗口）
renderers['bl-live'] = (body, meta, head) => {
  const K = window.app && window.app.blender;
  body.classList.add('bl-live');
  let disposed = false, running = false;
  let stateTimer = null;

  const dot = el('span', 'bl-dot');
  const note = el('span', 'bl-note', '检测中…');
  let launchBtn = null, reembedBtn = null, closeBtn = null;
  if (head) {
    head.classList.add('file-head');
    const acts = el('div', 'file-head-acts');
    acts.appendChild(dot);
    acts.appendChild(note);
    launchBtn = el('button', 'file-refresh', '▶ 启动');
    launchBtn.title = '启动 Blender（自动开启 MCP 服务器，省去手点 N 面板）';
    closeBtn = el('button', 'file-refresh', '✕ 关闭');
    closeBtn.title = '关闭 Blender：先解除内置再退出；有未保存改动时它会自己弹保存提示';
    reembedBtn = el('button', 'file-refresh', '⧉ 重新内置');
    reembedBtn.title = '先把 Blender 放回桌面，再重新嵌进面板（画面异常时点这个）';
    acts.appendChild(launchBtn);
    acts.appendChild(closeBtn);
    acts.appendChild(reembedBtn);
    head.appendChild(acts);
  }

  const stage = el('div', 'bl-stage');
  const blank = el('div', 'bl-blank');
  const ico = document.createElement('img');
  ico.className = 'bl-blank-ico';
  ico.src = 'assets/blender-icon.png';
  ico.alt = 'Blender';
  blank.appendChild(ico);
  const blankTitle = el('div', 'bl-blank-t', 'Blender 未运行');
  const blankDesc = el('div', 'bl-blank-d', '点「启动」打开 Blender，它会自动嵌进这个面板，可以直接在里面建模改参数');
  const blankBtn = el('button', 'bl-blank-btn', '▶ 启动 Blender');
  blank.appendChild(blankTitle);
  blank.appendChild(blankDesc);
  blank.appendChild(blankBtn);
  stage.appendChild(blank);
  body.appendChild(stage);

  const doLaunch = async () => {
    if (!K) return;
    note.textContent = '正在启动 Blender…';
    blankDesc.textContent = '正在启动 Blender，请稍候（首次启动约 10 秒）…';
    const r = await K.launch();
    if (r && !r.ok) { note.textContent = '启动失败'; blankDesc.textContent = r.err || '启动失败'; return; }
    triedForRun = false;
    setTimeout(() => { refreshState(); }, 3000);
  };
  if (launchBtn) launchBtn.addEventListener('click', doLaunch);
  blankBtn.addEventListener('click', doLaunch);
  // ---------- 只内置模式 ----------
  // 面板不再做截图预览：直接把 Blender 主窗口 SetParent 进来，在里面直接操作。
  // 主进程侧保险：面板切走、GUI 关闭、GUI 崩溃都会把 Blender 释放回桌面。
  let embedded = false, embedBusy = false, embedRO = null, moveTimer = null, triedForRun = false;

  // 只回 CSS px（视口坐标）；主进程负责加上窗口内容区位置并换算成屏幕物理像素
  function panelRect() {
    const r = stage.getBoundingClientRect();
    return {
      x: Math.round(r.left), y: Math.round(r.top),
      w: Math.round(r.width), h: Math.round(r.height)
    };
  }
  function pushMove() {
    if (!embedded || !K || !K.embedMove) return;
    if (moveTimer) clearTimeout(moveTimer);
    moveTimer = setTimeout(() => { try { K.embedMove(panelRect()); } catch (e) { /* ignore */ } }, 120);
  }
  async function releaseEmbed() {
    if (embedRO) { try { embedRO.disconnect(); } catch (e) { /* ignore */ } embedRO = null; }
    window.removeEventListener('resize', pushMove);
    if (!embedded) return;
    embedded = false;
    stage.classList.remove('embedded');
    try { if (K && K.embed) await K.embed(false, null); } catch (e) { /* ignore */ }
  }
  async function embedNow() {
    if (!K || !K.embed || embedBusy || disposed || embedded) return;
    const rc = panelRect();
    if (rc.w < 80 || rc.h < 80) {          // 布局还没稳，等一拍再来，别用退化矩形去内置
      setTimeout(() => { if (!disposed) embedNow(); }, 350);
      return;
    }
    embedBusy = true;
    try {
      setDot('warn', '正在内置…');
      const r = await K.embed(true, panelRect());
      if (disposed) return;
      if (r && r.ok) {
        embedded = true;
        stage.classList.add('embedded');
        setDot('ok', '已内置 · 直接操作');
        if (window.ResizeObserver) { embedRO = new ResizeObserver(pushMove); embedRO.observe(stage); }
        window.addEventListener('resize', pushMove);
      } else {
        setDot('err', '内置失败：' + ((r && r.err) || '未知'));
      }
    } catch (e) {
      setDot('err', '内置异常');
    } finally {
      embedBusy = false;
    }
  }

  const setDot = (cls, text) => {
    dot.className = 'bl-dot ' + cls;
    note.textContent = text;
  };

  async function refreshState() {
    if (disposed || !K) return;
    let s = null;
    try { s = await K.state({ capture: false }); } catch (e) { s = null; }
    if (disposed) return;
    if (!s) { setDot('err', '状态未知'); return; }
    running = !!s.running;
    if (!running) {
      triedForRun = false;
      if (embedded) await releaseEmbed();
      setDot('off', '未运行');
      return;
    }
    if (embedded) { setDot('ok', '已内置 · 直接操作'); return; }
    if (!triedForRun && !embedBusy) { triedForRun = true; embedNow(); }
  }

  if (reembedBtn) reembedBtn.addEventListener('click', async () => {
    if (embedBusy) return;
    await releaseEmbed();
    triedForRun = false;
    await refreshState();
  });

  // ---------- 关闭 Blender ----------
  // 默认优雅关闭（Blender 自己会弹保存提示）。只有确认框里点了「确定」才强杀。
  const doClose = async () => {
    if (!K || !K.close || embedBusy) return;
    embedBusy = true;
    if (closeBtn) closeBtn.disabled = true;
    try {
      setDot('warn', '正在关闭 Blender…');
      let r = null;
      try { r = await K.close(); } catch (e) { r = null; }

      // 本地状态复位：窗口已经还给桌面了
      embedded = false;
      stage.classList.remove('embedded');
      if (embedRO) { try { embedRO.disconnect(); } catch (e) { /* ignore */ } embedRO = null; }
      window.removeEventListener('resize', pushMove);
      triedForRun = true;   // 关掉之后别自动又把它内置回来

      if (r && r.already) {
        setDot('off', '未运行');
      } else if (r && r.closed) {
        setDot('off', '已关闭');
      } else {
        setDot('warn', '已发送关闭请求');
        const force = window.confirm(
          'Blender 还没有退出。\n\n' +
          '通常是因为弹出了「是否保存」对话框，或者它正忙。\n\n' +
          '要强制结束 Blender 吗？未保存的内容会丢失。');
        if (force) {
          setDot('warn', '正在强制结束…');
          try { await K.close({ force: true }); } catch (e) { /* ignore */ }
        }
      }
    } finally {
      embedBusy = false;
      if (closeBtn) closeBtn.disabled = false;
    }
    setTimeout(refreshState, 900);
  };
  if (closeBtn) closeBtn.addEventListener('click', doClose);

  // 只内置模式：不再需要抓帧进程，进来就停掉它
  try { if (K && K.capture) K.capture(false); } catch (e) { /* ignore */ }

  stateTimer = setInterval(refreshState, 4000);
  refreshState();

  return () => {
    disposed = true;
    if (stateTimer) clearInterval(stateTimer);
    if (moveTimer) clearTimeout(moveTimer);
    if (embedRO) { try { embedRO.disconnect(); } catch (e) { /* ignore */ } embedRO = null; }
    window.removeEventListener('resize', pushMove);
    // 面板要没了 —— 必须把 Blender 还回桌面，否则窗口会跟着这个面板一起消失
    if (embedded) { try { if (K && K.embed) K.embed(false, null); } catch (e) { /* ignore */ } }
  };
};

// Blender 本地文件（工作区浏览：<盘根>:\blender\blender控制）
renderers['bl-folder'] = (body, meta, head) => {
  const K = window.app && window.app.blender;
  body.classList.add('bl-folder');
  let disposed = false, rel = '';

  const crumbs = el('div', 'file-crumbs', '加载中…');
  if (head) {
    head.classList.add('file-head');
    const acts = el('div', 'file-head-acts');
    acts.appendChild(crumbs);
    const openBtn = el('button', 'file-refresh', '📂');
    openBtn.title = '在资源管理器打开当前目录';
    openBtn.addEventListener('click', () => { if (K) K.open(rel ? rootPath + '\\' + rel.replace(/\//g, '\\') : rootPath); });
    acts.appendChild(openBtn);
    const upBtn = el('button', 'file-refresh', '⬆');
    upBtn.title = '返回上级';
    upBtn.addEventListener('click', () => { const i = rel.lastIndexOf('/'); load(i > 0 ? rel.slice(0, i) : ''); });
    acts.appendChild(upBtn);
    head.appendChild(acts);
  }
  const list = el('div', 'file-list');
  body.appendChild(list);
  let rootPath = '';

  const fmtSize = (n) => {
    if (n == null) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  };
  const fmtTime = (t) => {
    if (!t) return '—';
    const d = new Date(t * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  };
  const icon = (name, isDir) => {
    if (isDir) return '📁';
    const n = String(name).toLowerCase();
    if (/\.blend\d?$/.test(n)) return '🟠';
    if (/\.(png|jpe?g|webp|exr|hdr)$/.test(n)) return '🖼️';
    if (/\.(mp4|mov|avi|mkv)$/.test(n)) return '🎬';
    if (/\.(obj|fbx|glb|gltf|stl|ply|abc|usd)$/.test(n)) return '🧊';
    if (/\.py$/.test(n)) return '🐍';
    if (/\.(zip|7z|rar)$/.test(n)) return '🗜️';
    return '📄';
  };

  async function load(nextRel) {
    if (disposed || !K) return;
    rel = nextRel || '';
    crumbs.textContent = rel ? rel.replace(/\//g, ' \\ ') : '加载中…';
    list.innerHTML = '';
    list.appendChild(el('div', 'file-empty', '加载中…'));
    let res = null;
    try { res = await K.files(rel); } catch (e) { res = null; }
    if (disposed) return;
    list.innerHTML = '';
    if (!res || !res.ok) {
      list.appendChild(el('div', 'file-empty', '无法读取：' + ((res && res.err) || '未知错误')));
      return;
    }
    rootPath = res.root || rootPath;
    crumbs.textContent = res.rel ? res.rel.replace(/\//g, ' \\ ') : 'Blender 工作区';
    crumbs.title = res.root + (res.rel ? '\\' + res.rel.replace(/\//g, '\\') : '');
    if (!res.rows.length) { list.appendChild(el('div', 'file-empty', '（空目录）')); return; }
    res.rows.forEach((it) => {
      const row = el('div', 'file-row' + (it.isDir ? ' dir' : ''));
      row.appendChild(el('span', 'bl-file-ico', icon(it.name, it.isDir)));
      row.appendChild(el('span', 'file-name', it.name));
      row.appendChild(el('span', 'file-meta', it.isDir ? '目录' : fmtSize(it.size) + ' · ' + fmtTime(it.mtime)));
      // 右键：在资源管理器里定位
      row.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        if (K) K.reveal(rel ? rel + '/' + it.name : it.name);
      });
      row.addEventListener('click', () => {
        if (it.isDir) load(rel ? rel + '/' + it.name : it.name);
        else if (K) K.open(rootPath + '\\' + (rel ? rel.replace(/\//g, '\\') + '\\' : '') + it.name);
      });
      list.appendChild(row);
    });
  }
  load('');
  const timer = setInterval(() => { if (!disposed) load(rel); }, 20000);
  return () => { disposed = true; clearInterval(timer); };
};

/* ══════════════════════════════════════════════════════════════════
   OA 运维场景 · 文件面板（type = "file"）
   meta.mode = 'local' → 只显本地；'cloud' → 只显云端；缺省 → 左右双栏
   每个面板自带【工具条 + 列表】，互不串线
   ══════════════════════════════════════════════════════════════════ */
renderers['file'] = (body, meta, head) => {
  var K = (window.app && window.app.oa) || {};   /* ★ 只用 oa 命名空间（场景隔离要求） */
  var ONLY = (meta && meta.mode) || '';
  var disposed = false;
  // ★ 根目录可由场景 json 指定：面板写 "root": "<盘根>:\\" 就是 E 盘根（「视频工作流」场景的素材管理）；
  //   不写 = <客户> OA 工程目录（老场景原样不变）。真正的 LOCAL_ROOT 在下面 normWin 之后算（要用到它）。
  // ★ 归一化 + 当前目录显示（绿色路径标签跟着窗口走；路径太长就压中间、保留首尾）
  var normWin = function (p) { return String(p || '').replace(/[\\/]+/g, '\\').replace(/\\+$/, ''); };
  var shortPath = function (full, root, maxTail) {
    var f = normWin(full), r = normWin(root);
    var tail = f;
    if (r.length && f.toLowerCase().indexOf(r.toLowerCase()) === 0) {
      tail = f.slice(r.length).replace(/^\\+/, '');
    }
    if (!tail) return '';   /* 空 = 就是项目根（或根之外，由调用方另行处理） */
    var mt = maxTail || 28;
    if (tail.length <= mt) return tail;
    /* ★ 压中间：按"从尾部往前数"切，避免把中文/宽字符切出半截造成乱码感 */
    return '…\\' + tail.slice(tail.length - (mt - 1));
  };
  var IMG_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;
  var VID_RE = /\.(mp4|mov|mkv|webm|m4v|avi|flv|wmv|mpe?g|ts)$/i;
  // ★ 根目录（面板级配置）：默认<客户> OA 工程目录，场景 json 里 "root" 可换根
  var DISP_ROOT = String((meta && meta.root) || '<资料库>');
  var LOCAL_ROOT = normWin(DISP_ROOT) || DISP_ROOT;
  // ★ 2026-10-20（宿主：「文件管理默认 C/D/E/F 盘」）—— 场景 json 写 "drives": ["C","D","E","F"]（或 true）
  //   ⇒ 面板一开始停在「此电脑」：列这几个盘（带可用/总量，读 app.sys.disks 零子进程），双击进盘；
  //     进盘后「↑ 上级」先回盘根、再回「此电脑」。
  //   ⛔ 不写 drives 的场景（<客户> OA / 视频工作流 / 设计杂活）行为一个字不变。
  var DRIVES = (function () {
    var d = meta && meta.drives;
    if (!d) return null;
    var arr = (d === true) ? ['C', 'D', 'E', 'F'] : (Array.isArray(d) ? d : null);
    if (!arr) return null;
    var out = arr.map(function (x) {
      var m = /^([A-Za-z])/.exec(String(x || '').trim());
      return m ? m[1].toUpperCase() : '';
    }).filter(function (x) { return !!x; });
    return out.length ? out : null;
  })();
  // 从任意路径取"它所在的盘根"（<盘根>:\）；取不到返回 ''
  var driveRootOf = function (p) {
    var m = /^([A-Za-z]):[\\/]/.exec(String(p || ''));
    return m ? m[1].toUpperCase() + ':\\' : '';
  };
  var isImg = function (n) { return IMG_RE.test(String(n || '')); };
  var isVid = function (n) { return VID_RE.test(String(n || '')); };
  // ★ 本地媒体直接交给浏览器解码（file:// 子资源实测可用）：不经过 IPC 传 base64，
  //   大图 / 视频也能秒开（原来的 IPC 读图有 12MB 上限，E 盘素材动辄几十 MB）。
  //   路径按段 encodeURIComponent，中文、空格、# 都不会出问题。
  // ⚠ 别再用 encodeURIComponent 逐段编码（老 bug，2026-09-26 修）：那会把盘符的冒号也编成 %3A
  //   ⇒ file:///E%3A/… 这种地址浏览器认不出盘符，本地缩略图/大图一律"破图"。
  //   encodeURI 会保留 : 和 /，只编码中文/空格等；文件名里可能出现的 # ? 单独转义（跟 flow 渲染器那份写法一致）。
  var fileUrl = function (p) {
    var s = String(p || '').replace(/\\/g, '/').replace(/^\/+/, '');
    return 'file:///' + encodeURI(s).replace(/#/g, '%23').replace(/\?/g, '%3F');
  };
  // 显示 / 复制用的好看路径：盘根补一个反斜杠（E: → <盘根>:\）
  var nicePath = function (p) { var s = normWin(p); return /^[A-Za-z]:$/.test(s) ? s + '\\' : s; };
  // ★ 单击文件 ⇒ 送到本场景的「预览」面板（2026-09-26 加，「设计杂活」场景要求"单击就能预览"）。
  //   预览面板（renderers.view）把自己的 API 注册在 window.__kunViews[面板id]，
  //   面板都在同一个文档里 ⇒ 直接调函数即可，**不需要任何新 IPC**（跟流程画布双击节点同一条路）。
  //   场景 json 里给本面板写 "viewPanel": "<预览面板id>" 指定送给谁；没写 = 送第一个注册的预览面板；
  //   场景里根本没有预览面板 ⇒ 静默跳过，单击仍然只是"选中"（跟以前一样，不会报错）。
  var previewTo = function (full, title) {
    try {
      var VP = (typeof flowFindView === 'function') ? flowFindView(meta && meta.viewPanel) : null;
      if (VP && typeof VP.show === 'function') { VP.show({ path: full, title: String(title || '') }); return true; }
    } catch (e) { /* 预览面板不在（或它自己出错）= 什么都不做 */ }
    return false;
  };

  var mk = function (tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  };
  // ★ 标题栏里的按钮：阻断 mousedown/mouseup（否则会被面板拖拽把手吃掉，点了没反应）
  //   ★2026-10-13★ 实现提到公共工具 APP_RENDER_UTILS.wireHeadNoDrag（一处实现，预览面板共用）
  var wireHeadBtn = function (node) {
    var U = window.APP_RENDER_UTILS;
    return (U && U.wireHeadNoDrag) ? U.wireHeadNoDrag(node) : node;
  };
  var fmtSize = function (n) {
    if (n == null || n === 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  };
  var fmtTime = function (t) {
    if (!t) return '';
    var d = new Date(t * 1000), p = function (x) { return String(x).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  };
  var showTip = function (txt, ms) {
    if (!tip) return;
    tip.textContent = txt || '';
    tip.style.display = txt ? '' : 'none';
    if (ms && txt) setTimeout(function () { if (!disposed && tip.textContent === txt) { tip.textContent = ''; tip.style.display = 'none'; } }, ms);
  };

  body.classList.add('oa-file');
  var tip = mk('div', 'oa-file-tip', '');
  tip.style.display = 'none';
  var wrap = mk('div', 'oa-file-wrap');
  body.appendChild(tip);
  body.appendChild(wrap);

  // 图片大图浮层（fallbackFull：file:// 加载失败时退回 IPC 读图，双保险）
  function bigImage(src, title, fallbackFull) {
    var ov = mk('div', 'oa-img-overlay');
    var bar = mk('div', 'oa-img-bar');
    var close = mk('span', 'oa-img-x', '关闭 ✕');
    close.addEventListener('click', function () { ov.remove(); });
    bar.appendChild(mk('span', null, title));
    bar.appendChild(close);
    var im = document.createElement('img');
    im.src = src; im.className = 'oa-img-big';
    if (fallbackFull) {
      var tried = false;
      im.addEventListener('error', function () {
        if (tried || disposed || !K.image) return;
        tried = true;
        Promise.resolve(K.image(fallbackFull)).then(function (res) {
          if (disposed) return;
          if (res && res.ok) im.src = res.dataUrl;
          else showTip('图片读取失败：' + ((res && res.err) || ''), 5000);
        }).catch(function () {});
      });
    }
    im.addEventListener('click', function (ev) { if (ev.target === im) ov.remove(); });
    ov.appendChild(bar); ov.appendChild(im);
    body.appendChild(ov);
  }

  // 视频播放浮层：面板里直接播（素材挑片不用来回切播放器），也能一键丢给系统播放器
  function bigVideo(src, title, fullPath) {
    var ov = mk('div', 'oa-img-overlay');
    var bar = mk('div', 'oa-img-bar');
    var play = mk('span', 'oa-img-btn', '用系统播放器打开');
    play.title = nicePath(fullPath);
    play.addEventListener('click', function (e) {
      e.stopPropagation();
      try { if (K.openPath) K.openPath(nicePath(fullPath)); } catch (err) {}
    });
    var close = mk('span', 'oa-img-x', '关闭 ✕');
    close.addEventListener('click', function () {
      var v = ov.querySelector('video');
      try { if (v) v.pause(); } catch (e2) {}
      ov.remove();
    });
    bar.appendChild(mk('span', null, title));
    bar.appendChild(play);
    bar.appendChild(close);
    var vd = document.createElement('video');
    vd.src = src; vd.className = 'oa-img-big';
    vd.controls = true; vd.autoplay = true; vd.playsInline = true;
    ov.appendChild(bar); ov.appendChild(vd);
    body.appendChild(ov);
  }

  // 单个面板（本地或云端），互相独立
  function makePane(side) {
    var isLocal = (side === 'local');
    var pane = mk('div', 'oa-file-pane oa-file-' + side);
    var bar = mk('div', 'oa-file-pane-hd');
    bar.style.display = 'none';   // 工具条已移到面板标题栏，内容区只留列表
    var list = mk('div', 'file-list oa-file-list');
    pane.appendChild(bar); pane.appendChild(list);
    wrap.appendChild(pane);
    var state = { root: '', atDrives: false };   // atDrives：drives 模式下停在「此电脑」盘符列表

    // —— 工具条内容 ——
    if (isLocal) {
      var pathTag = mk('span', 'oa-file-rootpath', DISP_ROOT);
      // ★ 这个后添加的 span 承载"当前目录那段"；整条标签文字 = 根目录 + 它
      //   （进了子目录 → 它是 '\backend\src'；跳出根目录 → 它直接覆盖成完整路径）
      var pathTagExt = mk('span', 'oa-file-rootpath-ext', '');
      pathTag.appendChild(pathTagExt);
      pathTag.title = '点击复制当前文件夹路径：' + DISP_ROOT;
      // 当前文件夹的绝对路径（本地栏未就绪时就是根目录）
      var curDir = function () { return normWin(state.root) || LOCAL_ROOT; };
      pathTag.addEventListener('click', function (e) {
        e.stopPropagation();
        if (state.atDrives) { showTip('现在停在「此电脑」（C / D / E / F），双击进入一个盘再复制路径', 2600); return; }
        var full = nicePath(curDir());
        try { navigator.clipboard.writeText(full); } catch (err) {}
        showTip('✓ 已复制当前路径：' + full, 2200);
        pathTag.classList.add('copied-flash');
        setTimeout(function () { pathTag.classList.remove('copied-flash'); }, 420);
      });
      var sub = mk('span', 'oa-file-subpath', '');
      var barHost = head || bar;            // ★ 挂到面板标题栏
      barHost.appendChild(wireHeadBtn(pathTag));
      // 2026-10-20（宿主：这条路径已经有一份了，重复）—— 绿色路径标签里已经带当前子目录（pathTagExt），
      //   再挂一条 "\项目工程\产物、素材…" 就是同一份路径写两遍 ⇒ 不挂。sub 仍保留给内部判断用。
      // barHost.appendChild(sub);
      var openBtn = mk('span', 'oa-file-headbtn', '打开');
      openBtn.title = '用资源管理器打开当前文件夹';
      openBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (state.atDrives) { showTip('先双击进入一个盘（这里没有"整台电脑"的文件夹）', 2600); return; }
        try { if (K.openFolder) K.openFolder(nicePath(curDir())); } catch (err) {}
      });
      var upBtn = mk('span', 'oa-file-headbtn', '↑ 上级');
      upBtn.title = '回到上级目录（不会超过场景根目录）';
      upBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (state.atDrives) return;
        var cur = String(state.root || '').replace(/[\\/]+$/, '');
        var nr = function (x) { return String(x || '').replace(/[\\/]+/g, '\\').toLowerCase(); };
        // ★ drives 模式：盘根 ⇒ 回「此电脑」（不然会一路退到盘外，显示成怪路径）
        if (DRIVES && /^[A-Za-z]:$/.test(cur)) { showDrives(); return; }
        if (!cur || nr(cur) === nr(LOCAL_ROOT)) return;
        var i = Math.max(cur.lastIndexOf('\\'), cur.lastIndexOf('/'));
        if (i <= 0) return;
        var nx = cur.slice(0, i);
        if (nr(nx).indexOf(nr(LOCAL_ROOT)) !== 0) {
          if (DRIVES) { showDrives(); return; }        // drives 模式的根 = 盘根，不越界
          nx = DISP_ROOT;
        }
        if (/^[A-Za-z]:$/.test(nx)) nx += '\\';   // 盘根要写成 "<盘根>:\"（"E:" 是盘符当前目录的相对形式）
        load(nx);
      });
      barHost.appendChild(wireHeadBtn(openBtn));
      barHost.appendChild(wireHeadBtn(upBtn));
    } else {
      var TAGS = [['代码', '/opt/langchen_oa'], ['数据库', '/root/backup'],
                  ['备份', '/opt/langchen_oa_backups'], ['日志', '/var/log/nginx']];
      var barHost2 = head || bar;           // ★ 挂到面板标题栏
      TAGS.forEach(function (tg) {
        var b = mk('span', 'oa-file-root', tg[0]);
        b.title = '跳转：' + tg[1];
        b.addEventListener('click', function (e) { e.stopPropagation(); load(tg[1]); });
        barHost2.appendChild(wireHeadBtn(b));
      });
      var cpath = mk('span', 'oa-file-headpath', '');
      barHost2.appendChild(cpath);
      state.cpath = cpath;
    }

    function rows(list2, onOpen, onEnter) {
      list.innerHTML = '';
      if (!list2 || !list2.length) { list.appendChild(mk('div', 'oa-file-empty', '（空目录）')); return; }

      // ★ 素材预览：图片 + 视频，一排两个（缩略图网格）
      //   本地：直接 file:// 出图 / 出首帧（大素材、几十 MB 的贴图也不卡；失败自动退回 IPC 读图）
      //   云端：图片仍走 IPC 读图（SSH 取回 base64）；视频不能直出，照旧当普通文件列在下边
      var med = (list2 || []).filter(function (x) { return !x.isDir && (isImg(x.name) || isVid(x.name)); });
      var medShow = isLocal ? med : med.filter(function (x) { return isImg(x.name); });
      var medGrid = medShow.slice(0, 60);                       // 预览上限 60 张，多出来的仍按文件列在下面
      var rest = (list2 || []).filter(function (x) { return x.isDir || medShow.indexOf(x) < 0; })
                              .concat(medShow.slice(60));
      if (medGrid.length) {
        var grid = mk('div', 'oa-thumb-grid');
        medGrid.forEach(function (it) {
          var full = isLocal ? (state.root || '').replace(/[\\/]+$/, '') + '\\' + it.name
                             : (state.root || '').replace(/\/+$/, '') + '/' + it.name;
          var isVideo = isVid(it.name);
          var card = mk('div', 'oa-thumb');
          var box = mk('div', 'oa-thumb-box');
          var ph = mk('div', 'oa-thumb-ph', isVideo ? '🎬' : '🖼');
          box.appendChild(ph);
          var cap = mk('div', 'oa-thumb-cap');
          cap.appendChild(mk('div', 'oa-thumb-name', it.name));
          var sizeTxt = mk('div', 'oa-thumb-size', (isVideo ? '🎬 ' : '🖼 ') + fmtSize(it.size));
          cap.appendChild(sizeTxt);
          card.appendChild(box); card.appendChild(cap);
          card.title = it.name + (isVideo ? '\n双击在面板里播放' : '\n双击看大图');
          // 懒加载缩略图 / 首帧（只给看得见的卡片取）
          var load1 = function () {
            if (disposed) return;
            if (isVideo) {
              if (!isLocal) return;                       // 云端视频不预览
              var vd = document.createElement('video');
              vd.className = 'oa-thumb-img'; vd.src = fileUrl(full);
              vd.preload = 'metadata'; vd.muted = true; vd.playsInline = true;
              vd.addEventListener('loadedmetadata', function () {
                if (disposed) return;
                // 抓一小段当封面（黑帧起头的素材也能看到画面）
                try { vd.currentTime = Math.min(0.3, (vd.duration || 0) / 2); } catch (e) {}
                var d = vd.duration || 0;
                if (d) {
                  sizeTxt.textContent = '🎬 ' + Math.floor(d / 60) + ':' +
                    String(Math.floor(d % 60)).padStart(2, '0') + ' · ' + fmtSize(it.size);
                }
              });
              vd.addEventListener('error', function () {
                box.innerHTML = ''; box.appendChild(mk('div', 'oa-thumb-ph', '🎬'));
              });
              box.innerHTML = ''; box.appendChild(vd);
              box.appendChild(mk('div', 'oa-thumb-play', '▶'));
            } else if (isLocal) {
              var im = document.createElement('img');
              im.className = 'oa-thumb-img'; im.loading = 'lazy'; im.src = fileUrl(full);
              im.addEventListener('error', function () {     // file:// 万一被拦 → 退回 IPC 读图
                if (disposed || !K.image) { box.innerHTML = ''; box.appendChild(mk('div', 'oa-thumb-ph', '⚠')); return; }
                Promise.resolve(K.image(full)).then(function (res) {
                  if (disposed) return;
                  if (res && res.ok) im.src = res.dataUrl;
                  else { box.innerHTML = ''; box.appendChild(mk('div', 'oa-thumb-ph', '⚠')); }
                }).catch(function () { box.innerHTML = ''; box.appendChild(mk('div', 'oa-thumb-ph', '⚠')); });
              });
              box.innerHTML = ''; box.appendChild(im);
            } else if (K.image) {
              Promise.resolve(K.image(full)).then(function (res) {
                if (disposed) return;
                if (res && res.ok) {
                  var im2 = document.createElement('img');
                  im2.src = res.dataUrl; im2.className = 'oa-thumb-img'; im2.loading = 'lazy';
                  box.innerHTML = ''; box.appendChild(im2);
                } else box.replaceChild(mk('div', 'oa-thumb-ph', '⚠'), ph);
              }).catch(function () {});
            }
          };
          if (window.IntersectionObserver) {
            var io2 = new IntersectionObserver(function (ents) {
              ents.forEach(function (en) { if (en.isIntersecting) { io2.disconnect(); load1(); } });
            });
            io2.observe(card);
          } else load1();
          card.addEventListener('click', function () {
            Array.prototype.forEach.call(list.querySelectorAll('.oa-thumb.sel'), function (r) { r.classList.remove('sel'); });
            card.classList.add('sel');
            if (isLocal) previewTo(full, it.name);          // ★ 单击缩略图 ⇒ 预览面板里摊开（图片/视频）
          });
          card.addEventListener('dblclick', function () {
            if (isVideo) {
              if (isLocal) bigVideo(fileUrl(full), it.name, full);   // 面板里直接播
              else onOpen(it);                                       // 云端：照旧下载 / 打开
              return;
            }
            if (isLocal) { bigImage(fileUrl(full), it.name, full); return; }
            if (K.image) {
              Promise.resolve(K.image(full)).then(function (res) {
                if (disposed) return;
                if (res && res.ok) bigImage(res.dataUrl, it.name);
                else showTip('图片读取失败：' + ((res && res.err) || ''), 5000);
              }).catch(function () {});
            }
          });
          grid.appendChild(card);
        });
        list.appendChild(grid);
      }
      if (!rest.length && medGrid.length) return;

      rest.forEach(function (it) {
        var row = mk('div', 'file-row oa-file-row');
        row.appendChild(mk('span', 'oa-file-ic', it.isDir ? '📁' : '📄'));
        row.appendChild(mk('span', 'oa-file-name', it.name));
        row.appendChild(mk('span', 'oa-file-size', it.isDir ? '' : fmtSize(it.size)));
        row.appendChild(mk('span', 'oa-file-time', fmtTime(it.mtime)));
        // ★2026-10-13★ 用户要求：**双击不再拿系统程序打开** —— 预览面板那排已经有「🖥 系统打开」，
        //   所以本地盘只提示"双击仍在预览里看"；云端（<客户> OA 没有预览面板）还是老话术。
        row.title = it.name + (it.isDir ? '\n双击进入'
          : (isLocal ? '\n双击仍在预览面板里看（要外部程序：用预览面板那排的 🖥）' : '\n双击打开 / 可拖到别的窗口'));
        if (!it.isDir && isLocal) {
          row.draggable = true;
          row.addEventListener('dragstart', function (ev) {
            // ★★ 必须先 preventDefault 再调主进程 startDrag ★★
            // 少了这一行，浏览器原生拖拽会和 Electron 的 webContents.startDrag 同时启动，
            // 原生层冲突会直接把整个工作台干掉（无堆栈、无日志，表现为"一拖就闪退"）。
            // 参照 site-folder 面板的正确写法。
            try { ev.preventDefault(); } catch (e) {}
            try { if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'copyMove'; } catch (e) {}
            var full = (state.root || '').replace(/[\\/]+$/, '') + '\\' + it.name;
            try {
              if (K && typeof K.dragStart === 'function') K.dragStart(full);
              else showTip('拖拽需重启一次工作台后生效', 4000);
            } catch (err) {}
          });
          row.addEventListener('dragend', function () { setTimeout(function () { try { window.focus(); } catch (e) {} }, 30); });
        }
        row.addEventListener('click', function () {
          Array.prototype.forEach.call(list.querySelectorAll('.oa-file-row.sel'), function (r) { r.classList.remove('sel'); });
          row.classList.add('sel');
          // ★ 单击文件（目录不算）⇒ 送到预览面板：图片 / 视频 / 各种文档 / PDF 都能看
          if (!it.isDir && isLocal) {
            previewTo((state.root || '').replace(/[\\/]+$/, '') + '\\' + it.name, it.name);
          }
        });
        row.addEventListener('dblclick', function () {
          if (it.isDir) { onEnter(it); return; }
          if (IMG_RE.test(it.name) && K.image) {
            var full = isLocal ? (state.root || '').replace(/[\\/]+$/, '') + '\\' + it.name
                               : (state.root || '').replace(/\/+$/, '') + '/' + it.name;
            if (isLocal) {
              bigImage(fileUrl(full), it.name, full);          // 本地直出（失败自动退回 IPC 读图）
            } else {
              // 2026-10-21：临时缓存统一收到 <临时目录> 盘只剩临时/Junction，核心已迁 <盘根>:\DSH）
              var tmp = '<临时目录>';
              Promise.resolve(K.download ? K.download(full, tmp) : null).then(function (dd) {
                if (dd && dd.ok && K.image) {
                  Promise.resolve(K.image(dd.local)).then(function (res) {
                    if (res && res.ok) bigImage(res.dataUrl, it.name + '（云端已缓存本地）'); else showTip('图片读取失败', 5000);
                  });
                } else showTip('云端图片下载失败：' + ((dd && dd.err) || ''), 5000);
              });
            }
            return;
          }
          // ★2026-10-13★ 双击**不许再拉起系统程序**（用户原话：不需要双击用系统打开了，因为预览面板有系统打开了）：
          //   本地盘上单击已经把文件递到预览面板（见上面的 click）⇒ 双击只是"再确认一次预览"，什么都不做；
          //   场景里没有预览面板、或不是本地盘（<客户> OA 只有 file 面板）⇒ previewTo 返回 false，照旧 onOpen。
          if (isLocal && previewTo((state.root || '').replace(/[\\/]+$/, '') + '\\' + it.name, it.name)) return;
          onOpen(it);
        });
        list.appendChild(row);
      });
    }

    // ★ drives 模式：「此电脑」盘符列表（C / D / E / F）—— 只有场景 json 配了 drives 时才会走到这儿
    function setRootLabel(txt) {
      try {
        if (pathTag.childNodes && pathTag.childNodes.length && pathTag.childNodes[0].nodeType === 3) {
          pathTag.childNodes[0].nodeValue = String(txt);
        } else {
          pathTag.insertBefore(document.createTextNode(String(txt)), pathTag.firstChild || null);
        }
      } catch (e) { /* ignore */ }
    }
    function showDrives() {
      if (!DRIVES) return;
      state.atDrives = true; state.root = '';
      setRootLabel('此电脑');
      pathTagExt.textContent = ''; pathTagExt.style.display = 'none';
      pathTag.classList.remove('deep'); pathTag.style.maxWidth = '';
      pathTag.title = 'C / D / E / F 盘（双击进入某个盘）';
      pathTagExt.title = pathTag.title;
      if (sub) sub.textContent = '';
      var items = DRIVES.map(function (L) { return { name: L + ':', isDir: true, __drive: L }; });
      rows(items, function () { /* 盘符不是文件，单击只选中 */ }, function (it) { load(it.__drive + ':\\'); });
      // 容量：主进程 statfs 只读数字（零子进程）⇒ 异步补到每行右边
      try {
        var S = window.app && window.app.sys;
        if (S && S.disks) Promise.resolve(S.disks()).then(function (r) {
          if (disposed || !state.atDrives || !r || !Array.isArray(r.drives)) return;
          var map = {};
          r.drives.forEach(function (d) { map[String(d.drive || '').toUpperCase()] = d; });
          var gbOf = function (n) {
            if (!n) return '0';
            return (n >= 1073741824) ? (Math.round(n / 1073741824) + ' GB') : (Math.round(n / 1048576) + ' MB');
          };
          Array.prototype.forEach.call(list.querySelectorAll('.oa-file-row'), function (rowEl) {
            var nm = rowEl.querySelector('.oa-file-name');
            var sz = rowEl.querySelector('.oa-file-size');
            if (!nm || !sz) return;
            var d = map[String(nm.textContent || '').toUpperCase()];
            if (!d) return;
            if (d.ok) {
              var tm = rowEl.querySelector('.oa-file-time');
              var tip = '已用 ' + d.percent + '% · 可用 ' + gbOf(d.free) + ' / 总量 ' + gbOf(d.total);
              // 62px 的"大小"格装不下两句 ⇒ 只留「可用」，总量塞进 96px 的"时间"格（都 nowrap，别三行折行）
              sz.textContent = gbOf(d.free) + ' 可用';
              sz.style.whiteSpace = 'nowrap'; sz.title = tip;
              if (tm) { tm.textContent = '共 ' + gbOf(d.total); tm.style.whiteSpace = 'nowrap'; tm.title = tip; }
            } else { sz.textContent = '不可用'; sz.style.whiteSpace = 'nowrap'; sz.title = String(d.err || ''); }
          });
        }).catch(function () { /* 读不到容量不影响浏览 */ });
      } catch (e) { /* ignore */ }
    }

    function load(p) {
      if (isLocal) {
        // ★ drives 模式：p 空 / '::drives' ⇒ 停在「此电脑」；进盘 ⇒ 把"根"换成该盘盘根（↑ 上级到盘根再回此电脑）
        if (DRIVES && (!p || p === '::drives')) { showDrives(); return; }
        if (DRIVES) { var drPre = driveRootOf(p); if (drPre) LOCAL_ROOT = drPre; }
        Promise.resolve(K.filesLocal ? K.filesLocal(p) : null).then(function (r) {
          if (disposed) return;
          if (!r || r.ok === false) { list.innerHTML = ''; list.appendChild(mk('div', 'oa-file-empty', '无法读取：' + ((r && r.err) || ''))); return; }
          state.root = r.base || p || '';
          state.atDrives = false;
          if (DRIVES) { var drNow = driveRootOf(state.root); if (drNow) { LOCAL_ROOT = drNow; setRootLabel(drNow.slice(0, 2)); } }
          // ★ 绿色路径标签 = 当前文件夹（相对项目根显示；太长压中间）+ 子路径小字保留完整相对路径
          var ROOTN = normWin(LOCAL_ROOT);
          var curFull = normWin(state.root) || LOCAL_ROOT;
          var inRoot = (curFull.toLowerCase() === ROOTN.toLowerCase())
                    || (curFull.toLowerCase().indexOf(ROOTN.toLowerCase() + '\\') === 0);
          if (inRoot && curFull.length > ROOTN.length) {
            pathTagExt.textContent = '\\' + shortPath(curFull, LOCAL_ROOT, 30);
            pathTagExt.style.display = '';
            pathTag.style.maxWidth = '76%';
            pathTag.classList.add('deep');
            pathTag.title = '当前文件夹：' + curFull + '\n点击复制这个路径';
            pathTagExt.title = pathTag.title;
            if (sub) sub.textContent = '\\ ' + curFull.slice(ROOTN.length).replace(/^[\\/]+/, '');
          } else if (inRoot) {
            pathTagExt.textContent = '';
            pathTagExt.style.display = 'none';
            pathTag.style.maxWidth = '';
            pathTag.classList.remove('deep');
            pathTag.title = (DRIVES ? '当前盘根：' + curFull : '场景根目录：' + DISP_ROOT) + '\n点击复制';
            if (sub) sub.textContent = '';
          } else {
            /* 跑到项目根之外（本地栏理论上进不去，兜底别显示错路径） */
            pathTagExt.textContent = curFull;      /* 直接覆盖整条标签文字 */
            pathTagExt.style.display = '';
            pathTag.style.maxWidth = '76%';
            pathTag.classList.remove('deep');
            pathTag.title = '当前文件夹（不在项目根内）：' + curFull + '\n点击复制这个路径';
            pathTagExt.title = pathTag.title;
            if (sub) sub.textContent = '';
          }
          // ★ 藏掉 macOS / Windows 的元数据垃圾（2026-09-26 用户实测踩到）：
          //   `._xxx.png` = AppleDouble（**正好 4096B、名字像图其实不是图**，点了预览必然"破图"，害人误判成面板坏了）；
          //   `.DS_Store` / `Thumbs.db` / `desktop.ini` 同理。别的点开头的文件（.env / .gitignore）照样显示。
          var JUNK_META = /^(\._|\.DS_Store$|Thumbs\.db$|desktop\.ini$)/i;
          var rsLocal = (r.rows || []).filter(function (it) { return !JUNK_META.test(it.name); });
          rows(rsLocal, function (it) {
            var full = state.root.replace(/[\\/]+$/, '') + '\\' + it.name;
            try { if (K.openPath) K.openPath(full); } catch (err) {}
          }, function (it) { load(state.root.replace(/[\\/]+$/, '') + '\\' + it.name); });
        }).catch(function (e) { showTip('读取异常：' + e.message, 5000); });
      } else {
        Promise.resolve(K.files ? K.files(p) : null).then(function (r) {
          if (disposed) return;
          if (!r || r.ok === false) { list.innerHTML = ''; list.appendChild(mk('div', 'oa-file-empty', '无法读取：' + ((r && r.err) || ''))); return; }
          state.root = r.base || p || '';
          if (state.cpath) state.cpath.textContent = state.root + (r.real ? '' : '（缓存）');
          var rs = (r.rows || []).slice();
          var parts = String(state.root).replace(/\/+$/, '').split('/').filter(Boolean);
          if (parts.length) rs = [{ name: '..', isDir: true, size: 0, mtime: 0, __up: true }].concat(rs);
          rows(rs, function (it) {
            var full = state.root.replace(/\/+$/, '') + '/' + it.name;
            var isText = /\.(txt|log|json|md|js|css|html|vue|sh|conf|yml|yaml|sql|env)$/i.test(it.name);
            if (isText && K.code && K.code.read) {
              Promise.resolve(K.code.read(full)).then(function (c) {
                var txt = (c && (c.content || c.text)) || (typeof c === 'string' ? c : '');
                if (!txt) { showTip('无法预览：' + full, 5000); return; }
                var box = mk('div', 'oa-file-preview');
                var b2 = mk('div', 'oa-file-preview-hd');
                var cl = mk('span', 'oa-file-preview-x', '关闭 ✕');
                cl.addEventListener('click', function () { box.remove(); });
                b2.appendChild(mk('span', null, full)); b2.appendChild(cl);
                box.appendChild(b2); box.appendChild(mk('pre', null, String(txt).slice(0, 20000)));
                pane.appendChild(box);
              });
            } else if (K.download) {
              var dir = '<资料库>';
              showTip('下载中：' + full);
              Promise.resolve(K.download(full, dir)).then(function (res) {
                if (res && res.ok) { showTip('✓ 已下载：' + res.local, 4000); try { if (K.openPath) K.openPath(res.local); } catch (err) {} }
                else showTip('✗ 下载失败：' + ((res && res.err) || ''), 6000);
              });
            } else showTip('无法处理：' + full, 4000);
          }, function (it) {
            if (it.__up) {
              var cp = String(state.root).replace(/\/+$/, '');
              var j = cp.lastIndexOf('/');
              load(j > 0 ? cp.slice(0, j) : '/');
              return;
            }
            load(state.root.replace(/\/+$/, '') + '/' + it.name);
          });
        }).catch(function (e) { showTip('读取异常：' + e.message, 5000); });
      }
    }
    return { side: side, load: load };
  }

  var panes = [];
  if (ONLY !== 'cloud') panes.push(makePane('local'));
  if (ONLY !== 'local') panes.push(makePane('cloud'));
  // （原先这里误建了一个本地栏且未隐藏，导致云端面板出现两个窗口 —— 已删除）

  // 初始化
  setTimeout(function () {
    if (disposed) return;
    panes.forEach(function (p) {
      if (p.side === 'local') p.load(DRIVES ? '::drives' : DISP_ROOT);   // ★ drives 模式先停在「此电脑」（C/D/E/F）
      else p.load('/opt/langchen_oa');
    });
  }, 10);

  // 2026-10-20（宿主：预览首页点文件夹 ⇒ 让这块文件管理跳过去）—— 对外挂一个极小的 API：
  //   预览面板（view）用 window.__kunFiles[面板id].open(路径) 调；同一个文档里，不需要新 IPC。
  //   ⚠ 面板重建（⟳）必须把旧的那份删掉，否则预览会调到已经 dispose 的旧闭包。
  try {
    var myId = String((meta && meta.id) || '');
    window.__kunFiles = window.__kunFiles || {};
    window.__kunFiles[myId] = {
      open: function (p) {
        if (disposed || !p) return false;
        var lp = panes.filter(function (x) { return x.side === 'local'; })[0];
        if (!lp) return false;
        lp.load(p); return true;
      }
    };
  } catch (e) { /* ignore */ }

  return function () {
    disposed = true;
    try {
      var id2 = String((meta && meta.id) || '');
      if (window.__kunFiles && window.__kunFiles[id2]) delete window.__kunFiles[id2];
    } catch (e) { /* ignore */ }
  };
};

// =====================================================================================
// 场景「自我复盘」（self-review）：右上角浏览 <盘根>:\DSH\自我复盘（md 镜像，只读）
//                                 左上角大窗「单击即预览」（渲染 md + 跟读目录内相对链接）
// -------------------------------------------------------------------------------------
// 为什么另写一对面板，不复用现成的 file / site-folder：
//   1) file 面板单击 = 交给系统程序打开，且只认图/视频；md 是纯文本，这里要的是"单击 = 在左窗渲染"；
//   2) site-folder 的路径夹死在 SITE_DIR，预览走静态服务器（md 会被当纯文本吐出来）→ 不满足"渲染 md"；
//   3) 本场景就这两个面板互相配合：桥接用一个挂在 window 上的小对象 __SR + 两个自定义事件即可，
//      不碰别的场景，也不改 HARNESS_PIN_JS / styles 里任何既有规则。
// 数据来源：主进程 app.review（根＝REVIEW_DIR，路径夹在该目录内，只读，无写接口）。
// =====================================================================================
var SR_LABEL = ((window.app && window.app.paths && window.app.paths.reviewDir) || '自我复盘');
var SR_LAST_KEY = 'sr:self-review:last';   // 记住上次看的文档（按场景分区；切场景/重启后自动恢复）

// ---------- 小工具（都带 sr 前缀，避免和工作台里的同名函数打架）----------
function srEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
// 行内元素：`code` / **粗** / *斜* / ~~删~~ / [文字](链接)
function srInline(s) {
  var t = srEsc(s);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  t = t.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  return t;
}
// 迷你 Markdown → HTML：标题 / 粗斜删 / 行内码 / 围栏码 / 有序无序表 / 复选框 / 表格 / 引用 / 分割线 / 链接
// （够用即止：档案与知识库这几篇就是标题 + 列表 + 表格 + 引用，不为它引入第三方库）
function srMd(src) {
  var lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
  var html = [], i = 0, listOpen = false, para = [];
  function flushPara() {
    if (para.length) { html.push('<p>' + srInline(para.join(' ')) + '</p>'); para = []; }
  }
  function closeList() { if (listOpen) { html.push('</ul>'); listOpen = false; } }
  function cells(s) {
    return s.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(function (c) { return c.trim(); });
  }
  while (i < lines.length) {
    var ln = lines[i];
    // 围栏代码块
    if (/^\s*(```|~~~)/.test(ln)) {
      flushPara(); closeList();
      var body = [], j = i + 1;
      while (j < lines.length && !/^\s*(```|~~~)\s*$/.test(lines[j])) { body.push(lines[j]); j++; }
      html.push('<pre class="sr-code"><code>' + srEsc(body.join('\n')) + '</code></pre>');
      i = j + 1; continue;
    }
    // 表格：本行含 | 且下一行是 |---| 分隔行
    if (ln.indexOf('|') >= 0 && i + 1 < lines.length && /^\s*\|?[\s:|-]*-[\s:|-]*\|/.test(lines[i + 1])) {
      flushPara(); closeList();
      var head2 = cells(ln), trs = [], k = i + 2;
      while (k < lines.length && lines[k].trim() && lines[k].indexOf('|') >= 0) { trs.push(cells(lines[k])); k++; }
      html.push('<table class="sr-tb"><thead><tr>' + head2.map(function (c) { return '<th>' + srInline(c) + '</th>'; }).join('') +
        '</tr></thead><tbody>' + trs.map(function (r) {
          return '<tr>' + r.map(function (c) { return '<td>' + srInline(c) + '</td>'; }).join('') + '</tr>';
        }).join('') + '</tbody></table>');
      i = k; continue;
    }
    var h = ln.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flushPara(); closeList(); html.push('<' + 'h' + h[1].length + '>' + srInline(h[2]) + '</h' + h[1].length + '>'); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(ln)) { flushPara(); closeList(); html.push('<hr>'); i++; continue; }
    if (/^\s*>/.test(ln)) {
      flushPara(); closeList();
      var qb = [], m = i;
      while (m < lines.length && /^\s*>/.test(lines[m])) { qb.push(lines[m].replace(/^\s*>\s?/, '')); m++; }
      html.push('<blockquote>' + srMd(qb.join('\n')) + '</blockquote>');
      i = m; continue;
    }
    var li = ln.match(/^\s*[-*+]\s+(.*)$/);
    if (li) {
      flushPara();
      if (!listOpen) { html.push('<ul>'); listOpen = true; }
      var t = li[1], box = '', cb = t.match(/^\[( |x|X)\]\s+(.*)$/);
      if (cb) { box = '<span class="sr-cb">' + (cb[1].toLowerCase() === 'x' ? '☑' : '☐') + '</span> '; t = cb[2]; }
      html.push('<li>' + box + srInline(t) + '</li>');
      i++; continue;
    }
    var oli = ln.match(/^\s*\d+[.)]\s+(.*)$/);
    if (oli) {
      flushPara();
      if (!listOpen) { html.push('<ul class="sr-ol">'); listOpen = true; }
      html.push('<li>' + srInline(oli[1]) + '</li>');
      i++; continue;
    }
    if (!ln.trim()) { flushPara(); closeList(); i++; continue; }
    para.push(ln.trim()); i++;
  }
  flushPara(); closeList();
  return html.join('\n');
}
// 相对路径解析：支持 ./ 与 ../（文档里的相对链接、目录名都用它）
function srJoin(dir, p) {
  var s = String(p == null ? '' : p).replace(/\\/g, '/');
  try { s = decodeURIComponent(s); } catch (e) { /* 没转义就算了 */ }
  if (/^[a-zA-Z]:/.test(s)) return s.replace(/^[a-zA-Z]:[\\/]*/, '').replace(/\\/g, '/');   // 绝对路径 → 归一到"相对根"
  s = s.replace(/^\.\//, '');
  var parts = String(dir || '').split('/').filter(Boolean);
  s.split('/').forEach(function (seg) {
    if (!seg || seg === '.') return;
    if (seg === '..') parts.pop(); else parts.push(seg);
  });
  return parts.join('/');
}
function srParent(rel) {
  var p = String(rel || '').split('/').filter(Boolean);
  p.pop();
  return p.join('/');
}
function srSize(n) {
  var v = Number(n) || 0;
  if (v < 1024) return v + ' B';
  if (v < 1048576) return (v / 1024).toFixed(v < 10240 ? 1 : 0) + ' KB';
  return (v / 1048576).toFixed(1) + ' MB';
}
function srTime(t) {
  var n = Number(t) || 0;
  if (!n) return '';
  var d = new Date(n * 1000), p = function (x) { return (x < 10 ? '0' : '') + x; };
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
// 主进程里"用系统程序打开 / 在资源管理器里显示"的接口名按存在性探测，避免写错名字静默失效
function srOpenPath(p) {
  var k = window.app || {}, a = k.app || {}, o = k.oa || {};
  var fn = a.openPath || o.openPath;
  if (typeof fn !== 'function') return false;
  try { fn(p); return true; } catch (e) { return false; }
}
function srRevealPath(p) {
  var k = window.app || {}, a = k.app || {}, o = k.oa || {};
  var fn = a.revealPath || o.openFolder;
  if (typeof fn !== 'function') return false;
  try { fn(p); return true; } catch (e) { return false; }
}
function srCopy(text) {
  try {
    var ta = document.createElement('textarea');
    ta.value = String(text == null ? '' : text);
    ta.style.position = 'fixed'; ta.style.left = '-9999px'; ta.style.top = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    var ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) { return false; }
}
function srFull(rel) { return SR_LABEL + '\\' + String(rel || '').replace(/\//g, '\\'); }
// 复盘镜像的**绝对路径**：根目录就是 SR_LABEL 本身（不带结尾反斜杠），窗口二标题行 / ⧉ 都用它
function srAbs(rel) { return rel ? srFull(rel) : SR_LABEL; }
// 操作提示（「✓ 已复制…」）并进**标题行**（用户要求）：原来挂在内容区底部，空着时也占一排（21px），
// 看着就像一条很粗的下边框、正文永远碰不到下沿。拿不到标题行时才退回内容区。
function srTipIn(head, body, before) {
  var t = el('span', 'sr-tip sr-head-tip');
  if (head) { if (before && before.parentNode === head) head.insertBefore(t, before); else head.appendChild(t); }
  else body.appendChild(t);
  var timer = 0;
  return function (msg, ms) {
    t.textContent = msg || '';
    t.title = msg || '';
    if (timer) clearTimeout(timer);
    if (msg && ms) timer = setTimeout(function () { t.textContent = ''; t.title = ''; }, ms);
  };
}

// ---------- 左上「文档预览」的文件分流（★2026-10-11★ 用户要求：预览能力从"只能看 md"扩到"能预览的全部文件"）----------
// 判据只看**扩展名**，并且判在渲染层（不在主进程）：
//   ① 主进程的 review:read 对**任何**文件都会回 utf8 正文（它只是额外标了个 text 标志），
//      "该不该按文本读"必须在这儿先判断 —— 否则 PDF / 图片会被当文本读成一屏乱码；
//   ② 判在渲染层 = 不用动 main.js = 改完 ⟳ 就生效，不用重启 GUI。
// 四类去处：
//   md / text        → 左窗自己渲染（md 走 srMd；txt/json/js/csv/log… 按原文 <pre> 显示）
//   image/video/audio/pdf/html → **整块交给通用预览渲染器**（renderers.view）：
//                      滚轮缩放、播放条、内核 PDF 阅读器、HTML 内嵌渲染都在它那儿，本场景一行都不重复写
//   opaque（docx/xlsx/pptx/zip/psd…）→ 内核渲染不了 ⇒ 明确提示卡 + 「用系统默认程序打开」按钮（不白屏、不静默失败）
//   认不出扩展名的    → 先按文本读，正文里出现 NUL/大量坏字符再退回"打不开"卡片（无后缀、.sample 这类）
var SR_EXT_TEXT = ['md', 'markdown', 'mdx', 'txt', 'text', 'json', 'jsonl', 'jsonc', 'ndjson', 'csv', 'tsv', 'log',
  'ini', 'cfg', 'conf', 'env', 'yaml', 'yml', 'toml', 'xml', 'srt', 'ass', 'vtt',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'css', 'scss', 'less', 'sql', 'py', 'ps1', 'psm1', 'bat', 'cmd',
  'sh', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'lua', 'typ', 'sample'];
var SR_EXT_HTML = ['html', 'htm', 'xhtml'];
var SR_EXT_IMAGE = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif'];
var SR_EXT_VIDEO = ['mp4', 'webm', 'mov', 'mkv', 'm4v', 'avi'];
var SR_EXT_AUDIO = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'];
// ★2026-10-13★ Office / WPS 文档单独成一类（以前算 opaque、只给提示卡）：
//   现在交给通用预览渲染器 → 主进程借本机 Office 转成 PDF → 内核 PDF 阅读器内嵌显示。
//   留在 SR_EXT_OPAQUE 里的只剩"真的没法在面板里看"的：压缩包、PSD、可执行文件、数据库、镜像、APK。
var SR_EXT_OFFICE = ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'rtf', 'odt', 'ods', 'odp', 'wps', 'et', 'dps'];
var SR_EXT_OPAQUE = ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'psd', 'ai', 'exe', 'dll', 'msi', 'db', 'sqlite', 'bin', 'iso', 'apk'];
function srExtOf(p) {
  var m = /\.([A-Za-z0-9]+)$/.exec(String(p || '').trim());
  return m ? m[1].toLowerCase() : '';
}
function srKindOf(p) {
  var e = srExtOf(p);
  if (!e) return 'maybe-text';                       // 无后缀：先按文本试
  if (e === 'md' || e === 'markdown' || e === 'mdx') return 'md';
  if (SR_EXT_HTML.indexOf(e) >= 0) return 'html';    // HTML：看渲染效果（不是当源码看）
  if (SR_EXT_IMAGE.indexOf(e) >= 0) return 'image';
  if (SR_EXT_VIDEO.indexOf(e) >= 0) return 'video';
  if (SR_EXT_AUDIO.indexOf(e) >= 0) return 'audio';
  if (e === 'pdf') return 'pdf';
  if (SR_EXT_OFFICE.indexOf(e) >= 0) return 'office';   // Word/Excel/PPT：转 PDF 后内嵌显示
  if (SR_EXT_TEXT.indexOf(e) >= 0) return 'text';
  if (SR_EXT_OPAQUE.indexOf(e) >= 0) return 'opaque';
  return 'maybe-text';
}
// 二进制嗅探（只给"认不出扩展名"的文件用）：NUL 字节 = 一定是二进制；坏字符（U+FFFD，utf8 解不开的字节）
// 占比超过 5% 也算。真文本（哪怕是 GBK 的老笔记变成坏字符）不会满屏 NUL。
function srLooksBinary(text) {
  var s = String(text == null ? '' : text);
  if (!s) return false;
  if (s.indexOf('\u0000') >= 0) return true;
  var bad = (s.match(/\uFFFD/g) || []).length;
  return bad > 0 && bad / s.length > 0.05;
}
// 文件树里的小图标：一眼分清"点了会出图 / 会播 / 会渲染 / 打不开"
function srRowIcon(name) {
  var k = srKindOf(name);
  if (k === 'md') return '📄';
  if (k === 'image') return '🖼';
  if (k === 'video') return '🎞';
  if (k === 'audio') return '🔊';
  if (k === 'pdf') return '📕';
  if (k === 'office') return '📘';                   // Word/Excel/PPT：点开会在预览里转成 PDF
  if (k === 'html') return '🌐';
  if (k === 'text' || k === 'maybe-text') return '📃';
  return '🧩';                                       // opaque：要交给系统程序打开
}

// ---------- 右上角：文档树（目录＝单击进入，文件＝单击交给左窗预览，双击＝系统程序打开）----------
renderers['review-files'] = function (body, meta, head) {
  var K = (window.app && window.app.review) || null;
  body.classList.add('sr-wrap');

  var curRel = '', rowsCache = [], picked = '', disposed = false, seq = 0;

  // 功能按键（⌂ ↑ ⟳ ⧉）+ 面包屑全部并进**标题行**，排在标题「自我复盘 · 文档」后面 —— 三排压成一排：
  // 第二排的根路径与标题重复、面包屑根段「自我复盘」也重复（用户要求「重复的不显示」），
  // 「只读」徽标同样去掉了。拿不到标题行时退回内容区顶部（.sr-bar），保证单独渲染也能用。
  var bRoot = el('button', 'sr-btn', '⌂'); bRoot.type = 'button'; bRoot.title = '回到根目录';
  var bUp = el('button', 'sr-btn', '↑'); bUp.type = 'button'; bUp.title = '上一级';
  var bRe = el('button', 'sr-btn', '⟳'); bRe.type = 'button'; bRe.title = '重新读取目录';
  var bCp = el('button', 'sr-btn', '⧉'); bCp.type = 'button'; bCp.title = '复制当前文件夹的完整路径';
  var RO_NOTE = '这里是「个人档案 / 我的知识库」的复盘镜像：只读。要改档案去 <盘根>:\\学习和自己\\个人档案 与 我的知识库，再同步过来。';
  // 当前文件夹的**完整路径**：并进标题行显示，可拖选、也可单击复制（用户要求）。
  var fpath = el('span', 'sr-fpath');
  fpath.title = '当前文件夹的完整路径（单击复制）';
  if (head) {
    head.classList.add('sr-head', 'sr-head-files');
    var acts = el('div', 'file-head-acts sr-head-acts');
    acts.appendChild(bRoot); acts.appendChild(bUp); acts.appendChild(bRe); acts.appendChild(bCp);
    // 副标题（镜像根路径）与标题行上的完整路径重复 —— 整条收掉，否则它 flex:1 1 100% 会硬占第二排
    var headSub = head.querySelector('.panel-sub');
    if (headSub) { headSub.textContent = ''; headSub.style.display = 'none'; }
    // 插到**标题之后**（同 makePanel 里 AI 面板「展开」箭头的写法）：徽标 → 标题 → 路径 → 提示 → 按键
    var titleEl = head.querySelector('.panel-title');
    if (titleEl) { head.insertBefore(fpath, titleEl.nextSibling); head.insertBefore(acts, fpath.nextSibling); }
    else { head.appendChild(fpath); head.appendChild(acts); }
  } else {
    var bar = el('div', 'sr-bar');
    bar.appendChild(bRoot); bar.appendChild(bUp); bar.appendChild(bRe); bar.appendChild(bCp);
    body.appendChild(bar);
    body.appendChild(fpath);
  }

  var list = el('div', 'sr-list');
  list.title = RO_NOTE;
  body.appendChild(list);

  var tip = srTipIn(head, body, acts);

  // 路径文字 = 当前文件夹的绝对路径（根目录不带结尾反斜杠）。不再印面包屑：路径本身就是"具体位置"，
  // 窄面板里两套并排也放不下；回根 / 上一级仍有 ⌂ ↑。
  function paintPath() {
    var abs = srAbs(curRel);
    fpath.textContent = abs;
    fpath.title = abs + '　（单击复制）';
  }

  function rowOf(r) {
    var rel = curRel ? curRel + '/' + r.name : r.name;
    var ic = r.isDir ? '📁' : srRowIcon(r.name);
    var row = el('div', 'sr-row' + (rel === picked ? ' on' : ''));
    row.appendChild(el('span', 'sr-ic', ic));
    row.appendChild(el('span', 'sr-name', r.name));
    row.appendChild(el('span', 'sr-meta', r.isDir ? '' : srSize(r.size)));
    row.title = r.isDir ? (rel + '　单击进入') : (rel + '　单击＝在左边预览');
    // ★2026-10-11★ 单击 = **一律**送到左边预览（用户要求"右边库点击直接预览"）。
    //   以前这里有个 `r.text` 条件：图片/视频/PDF 这些非文本会被判成"预览不了"直接丢给系统程序打开，
    //   于是"单击"在不同类型上行为不一致。现在一律预览，能不能内嵌由左边那块的分类来决定
    //   （打不开的格式它会给出提示 + 「用系统默认程序打开」按钮，不会白屏）。
    // ★2026-10-13★ 用户又要求：**单击、双击、怎么点都只在左边预览**，别再拿系统程序打开。
    //   原来双击那条 `dblclick` 会直接 shell.openPath 拉起 Word/图片查看器 —— 单击已经预览了，
    //   双击再弹一个外部窗口纯属碍事。⇒ 删掉 dblclick，只留 click 一条路：
    //   双击本来就会先触发两次 click，效果一样是"在左边预览"，行为彻底统一。
    //   「用系统默认程序打开」现在只有**左边预览面板工具栏上那一个入口**（🖥），不会误触。
    function pick() {
      if (r.isDir) { load(rel); return; }
      picked = rel;
      paintRows();
      var br = window.__SR;
      if (br && typeof br.open === 'function') { br.open(rel, r.name, r.size, r.mtime); return; }
      // 预览面板不在（理论上不会发生）：退回"用系统程序打开"，不静默什么都不做
      tip('预览面板不在，已交给系统程序打开：' + r.name, 3500);
      if (!srOpenPath(srFull(rel))) tip('打不开：主进程没有 openPath', 4000);
    }
    row.addEventListener('click', pick);
    return row;
  }

  function paintRows() {
    list.innerHTML = '';
    var rows = rowsCache;
    if (curRel) {
      var up = el('div', 'sr-row sr-up');
      up.appendChild(el('span', 'sr-ic', '↰'));
      up.appendChild(el('span', 'sr-name', '..'));
      up.title = '上一级';
      up.addEventListener('click', function () { load(srParent(curRel)); });
      list.appendChild(up);
    }
    if (!rows.length) { list.appendChild(el('div', 'sr-empty', '（空目录）')); return; }
    rows.forEach(function (r) { list.appendChild(rowOf(r)); });
  }

  function load(rel) {
    if (!K) {
      list.innerHTML = '';
      list.appendChild(el('div', 'sr-empty', '主进程接口 app.review 未就绪（需要重启 GUI）'));
      return;
    }
    curRel = String(rel || '');
    paintPath();
    var my = ++seq;
    list.innerHTML = '';
    list.appendChild(el('div', 'sr-empty', '读取中…'));
    Promise.resolve(K.files(curRel)).then(function (res) {
      if (disposed || my !== seq) return;
      if (!res || !res.ok) { list.innerHTML = ''; list.appendChild(el('div', 'sr-empty', (res && res.err) || '读取失败')); return; }
      rowsCache = res.rows || [];
      picked = (window.__SR && window.__SR.cur) || picked;
      paintRows();
    }).catch(function (e) {
      if (disposed || my !== seq) return;
      list.innerHTML = '';
      list.appendChild(el('div', 'sr-empty', '读取异常：' + e.message));
    });
  }

  // 预览面板切换文档 → 高亮（必要时跟着跳目录）；它在空状态点目录 → 这里跳过去
  function onPick(ev) {
    var rel = ev && ev.detail && ev.detail.rel;
    if (!rel) return;
    picked = rel;
    var dir = rel.indexOf('/') >= 0 ? rel.replace(/[^/]*$/, '').replace(/\/$/, '') : '';
    if (dir !== curRel) load(dir); else paintRows();
  }
  function onGoto(ev) {
    var rel = ev && ev.detail && typeof ev.detail.rel === 'string' ? ev.detail.rel : '';
    load(rel);
  }
  window.addEventListener('sr-pick', onPick);
  window.addEventListener('sr-goto', onGoto);
  // ★2026-10-13★ 预览面板点了「✕ 关闭」⇒ 这里只**取消高亮**，不跟着跳目录
  //   （不能用 sr-goto：那会把文件库整个导航回根目录，用户正翻到深目录时会很烦）
  function onClearPick() { picked = ''; paintRows(); }
  window.addEventListener('sr-clear-pick', onClearPick);

  bRoot.addEventListener('click', function () { load(''); });
  bUp.addEventListener('click', function () { load(srParent(curRel)); });
  bRe.addEventListener('click', function () { load(curRel); });
  // ⧉ 与标题行上的路径文字是同一件事：复制**当前文件夹**的绝对路径（跟左上角预览面板的 ⧉ 同一套
  // srCopy：textarea + execCommand，因为这里是 file:// 页面，navigator.clipboard 不一定可用）。
  function copyAbs() {
    var abs = srAbs(curRel);
    tip(srCopy(abs) ? '✓ 已复制路径：' + abs : '复制失败，可手动选中复制：' + abs, 3200);
  }
  bCp.addEventListener('click', copyAbs);
  fpath.addEventListener('click', copyAbs);

  load('');
  return function () {
    disposed = true;
    window.removeEventListener('sr-pick', onPick);
    window.removeEventListener('sr-goto', onGoto);
    window.removeEventListener('sr-clear-pick', onClearPick);
  };
};

// ---------- 左上角：文档预览（渲染 md；单击右上文档即在此打开；文档内相对链接原地跟读）----------
renderers['review-doc'] = function (body, meta, head) {
  var K = (window.app && window.app.review) || null;
  body.classList.add('sr-wrap', 'sr-doc');

  var curRel = '', disposed = false, seq = 0;

  // 场景内桥：右上角面板单击 → 这里打开（面板渲染顺序里本面板在前，桥一定先就位）
  var br = window.__SR || (window.__SR = {});
  // ★2026-10-11★ 桥多收两个参数（size / mtime）：右栏单击时顺手把大小、时间带过来 —— 图片/视频/PDF
  //   这类媒体就不用为了"显示大小"先把整个文件读一遍（PDF 动辄几十 MB，读进内存纯属浪费）。
  var mine = function (rel, name, size, mtime) { openDoc(rel, name, size, mtime); };
  br.open = mine;
  br.cur = '';

  var fname = el('div', 'sr-doc-name', '（未选择文档）');
  var fmeta = el('div', 'sr-doc-meta', '');
  var acts = el('div', 'sr-doc-acts');
  var bRe = el('button', 'sr-btn', '⟳'); bRe.type = 'button'; bRe.title = '重新读取这个文件';
  var bOut = el('button', 'sr-btn', '🖥'); bOut.type = 'button'; bOut.title = '用系统默认程序打开';
  var bRev = el('button', 'sr-btn', '📂'); bRev.type = 'button'; bRev.title = '在资源管理器里显示';
  var bCp = el('button', 'sr-btn', '⧉'); bCp.type = 'button'; bCp.title = '复制完整路径';
  // ★2026-10-13★ 「✕ 关闭当前预览」（用户要求：加在「复制」右边）——此前只有"换一个文件"、没有"合上"，
  //   看完想收工只能去点别的文件，面板一直占着一份正文。
  //   行为＝回到「未选择文档」空状态 ＋ **顺手忘掉"上次看的文件"**（否则下次开面板它又自己回来了）。
  var bClose = el('button', 'sr-btn sr-btn-close', '✕'); bClose.type = 'button';
  bClose.title = '关闭当前预览（回到「未选择文档」；下次开面板不会自动恢复这个文件）';
  acts.appendChild(bRe); acts.appendChild(bOut); acts.appendChild(bRev); acts.appendChild(bCp); acts.appendChild(bClose);

  // 功能按键并进面板标题行（跟窗口二 .sr-head-acts 同一套做法）：标题「文档预览」→ 文件名 → 靠右的按键，
  // 全在一排；「完整路径 · 大小 · 时间」走标题行下面那行副标题（原来面板的那句提示语只在没打开文档时显示）。
  // 这样内容区只剩 md 正文，不再被横条吃掉一行。拿不到 head 时退回旧横条（.sr-doc-bar），单独渲染也不会瞎。
  var headSub = head ? head.querySelector('.panel-sub') : null;
  var SUB_HINT = '单击右上的文件即可在此预览（要改就用这排的 🖥 打开系统程序）';
  function subText(t) { if (headSub) headSub.textContent = t; else if (fmeta) fmeta.textContent = (t === SUB_HINT ? '' : t); }
  if (head) {
    // sr-head-doc：窗口一专用类 —— 文件名 + 路径·大小·时间 + 按键全部挤进标题这一排（见 styles.css）
    head.classList.add('sr-head', 'sr-head-doc');
    acts.classList.add('sr-head-acts');
    if (!headSub) { headSub = el('span', 'panel-sub', ''); head.appendChild(headSub); }
    // 必须插在**标题之后、副标题之前**：副标题是 flex:1 1 100% 独占一排，
    // 排到它后面的东西会被顶到第三排（窗口二已经踩过一次，见项目信息 §23.5）。
    var titleEl = head.querySelector('.panel-title');
    if (titleEl) { head.insertBefore(fname, titleEl.nextSibling); head.insertBefore(acts, fname.nextSibling); }
    else { head.appendChild(fname); head.appendChild(acts); }
  } else {
    var bar = el('div', 'sr-doc-bar');
    bar.appendChild(fname); bar.appendChild(fmeta); bar.appendChild(acts);
    body.appendChild(bar);
  }

  var md = el('div', 'sr-md');
  body.appendChild(md);

  var tip = srTipIn(head, body, acts);

  // ---------- 非文本类：整块交给通用预览渲染器（复用，不重写）----------
  // ★2026-10-11★ 用户要求「预览能预览的全部文件」。图片（滚轮缩放）、视频/音频（播放条）、
  //   PDF（内核自带阅读器）、HTML（内嵌渲染）这四类**一行渲染代码都不在这儿写** ——
  //   直接把通用预览渲染器 renderers.view 挂进内容区，用它的 window.__kunViews[面板id] 把文件递过去
  //   （跟「设计杂活」预览面板、流程画布双击节点同一条路）。以后 view 那边的图片缩放 / PDF 兜底 /
  //   播放器修好了，这里跟着一起好。
  //   ⚠ 它是往 md 里塞 .view-bar / .view-body / .view-status 的**列式**布局 ⇒ 需要 styles.css 的
  //     `.sr-md.sr-media` 那条规则（收掉正文内边距/滚动，并收掉与面板标题行重复的那条 view 工具行）。
  var MEDIA_ID = 'sr-doc-media';
  var mediaCleanup = null, mediaApi = null;
  function dropMedia() {
    if (mediaCleanup) { try { mediaCleanup(); } catch (e) { /* ignore */ } }
    mediaCleanup = null;
    mediaApi = null;
    md.classList.remove('sr-media');
    if (md.firstChild) md.innerHTML = '';
  }
  function showMedia(kind, rel, name) {
    if (!mediaApi) {
      // ★ 第一次挂通用预览渲染器之前必须先把内容区清干净：上一个文件若是**文本**，
      //   它的 <pre> 是直接写在 md 里的（不属于 view 的 bodyBox，view 的 clearBody 清不掉它），
      //   留着就会把 .view-body 挤成 0 高 —— 表现为"标题栏换成了图片名，正文还是上一篇的文字，
      //   图/PDF 其实已经加载了却看不见"（2026-10-11 探针实测抓到的真 bug）。
      if (md.firstChild) md.innerHTML = '';
      md.classList.add('sr-media');
      mediaCleanup = renderers.view(md, { id: MEDIA_ID });     // ← 复用：它自己往 md 里建「工具行/主体/状态行」
      mediaApi = (window.__kunViews || {})[MEDIA_ID] || null;
    } else {
      md.classList.add('sr-media');
    }
    if (!mediaApi) { showOpaque(rel, name); return; }          // 极端情况（注册表没拿到）⇒ 退回提示卡，绝不白屏
    mediaApi.show({ path: srFull(rel), title: name || '', kind: kind });
  }
  // 「内核渲染不了」的格式（docx/xlsx/pptx/zip/psd…）：说清是什么格式、为什么看不了，并给一个
  // **写在卡片里**的「用系统默认程序打开」按钮 —— 用户明确要求"不要白屏、不要静默失败"。
  function showOpaque(rel, name) {
    dropMedia();
    var box = el('div', 'sr-raw');
    var e = srExtOf(rel);
    box.appendChild(el('div', 'sr-raw-ic', '🧩'));
    box.appendChild(el('div', 'sr-raw-t', (name || rel.split('/').pop() || rel) + (e ? '（.' + e + '）' : '')));
    box.appendChild(el('div', 'sr-raw-s', '这种格式没法在面板里内嵌预览（Word / Excel / PPT / WPS 文档、压缩包、PSD 这类"打包格式"都算）。'
      + '用系统里默认的程序打开它就能看 —— 预览面板不会白屏，也不会默默什么都不做。'));
    var row = el('div', 'sr-raw-acts');
    var b1 = el('button', 'sr-qbtn sr-qopen', '🖥 用系统默认程序打开');
    b1.type = 'button';
    b1.addEventListener('click', function () { if (!srOpenPath(srFull(rel))) tip('打不开：主进程没有 openPath', 4000); });
    var b2 = el('button', 'sr-qbtn', '📂 在资源管理器里显示');
    b2.type = 'button';
    b2.addEventListener('click', function () { if (!srRevealPath(srFull(rel))) tip('打不开：主进程没有 revealPath', 4000); });
    row.appendChild(b1); row.appendChild(b2);
    box.appendChild(row);
    box.appendChild(el('div', 'sr-raw-path', srFull(rel)));
    md.appendChild(box);
  }
  // 打开过一次就记一次（下次 ⟳ / 切场景回来恢复），并让右栏跟着高亮 —— 两条都是原来散在成功分支里的
  function markPicked(rel) {
    try { localStorage.setItem(SR_LAST_KEY, rel); } catch (e) { /* ignore */ }
    try { window.dispatchEvent(new CustomEvent('sr-pick', { detail: { rel: rel } })); } catch (e) { /* ignore */ }
  }
  // 非 md 的文本（txt / json / 代码 / csv / log…）：**按原文显示**，不丢换行。
  //   （以前所有文本都被丢进 Markdown 渲染器 ⇒ json / 代码会被并成一整段，看着就像坏了）
  function showPlainText(text) {
    dropMedia();
    md.appendChild(el('pre', 'sr-pre', String(text == null ? '' : text)));
    md.scrollTop = 0;
  }
  function showMarkdown(text) {
    dropMedia();
    md.innerHTML = srMd(text);
    md.scrollTop = 0;
  }

  async function openDoc(rel, name, size, mtime) {
    rel = String(rel || '');
    if (!rel) return;
    if (!K) {
      dropMedia();
      md.appendChild(el('div', 'sr-empty', '主进程接口 app.review 未就绪（需要重启 GUI）'));
      return;
    }
    curRel = rel;
    br.cur = rel;
    syncClose();                                  // 有文件了 ⇒ ✕ 可用（2026-10-13）
    fname.textContent = name || rel.split('/').pop() || rel;
    fname.title = srFull(rel);
    var kind = srKindOf(rel);
    var title = srFull(rel) + (size ? '　·　' + srSize(size) : '') + (mtime ? '　·　' + srTime(mtime) : '');
    var my = ++seq;
    // ① 媒体类（图片/视频/音频/PDF/HTML/Office）：**不读盘**，直接交给通用预览渲染器
    //    ★2026-10-13★ office 也走这条：通用预览渲染器那边会先让主进程转成 PDF，再用内核 PDF 阅读器显示
    if (kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'pdf' || kind === 'html' || kind === 'office') {
      subText(title);
      showMedia(kind === 'html' ? 'web' : kind, rel, name);
      markPicked(rel);
      return;
    }
    // ② 打包类（zip/rar/7z/psd/exe/db/iso/apk…）：内核渲染不了、也转不出 PDF ⇒ 提示卡 + 系统打开按钮
    if (kind === 'opaque') {
      subText(title);
      showOpaque(rel, name);
      markPicked(rel);
      return;
    }
    // ③ 文本类（md / 源码 / 数据 / 配置 / 认不出扩展名的）：读 utf8 正文
    subText('读取中…');
    dropMedia();
    md.innerHTML = '<div class="sr-empty">读取中…</div>';
    let res = null;
    try { res = await K.read(rel); } catch (e) { res = { ok: false, err: '读取异常：' + ((e && e.message) || e) }; }
    if (disposed || my !== seq) return;
    if (!res || !res.ok) {
      // ★2026-10-11★ 文件不在了（ENOENT：stat/readFile 失败，多见于档案里删过/改过名）⇒ 说人话 + 忘掉这个路径 + 回根，
      //   绝不把内核的 "ENOENT: no such file or directory, stat '…'" 原文糊在面板上。其它错误（越界/目录/权限/编码）照旧原样显示。
      if (/ENOENT|no such file or directory/i.test(String((res && res.err) || ''))) {
        emptyState('上次看的文件不在了（可能已改名或移动）　·　原路径：' + srFull(rel) + '　·　已回到档案根目录');
        try { localStorage.removeItem(SR_LAST_KEY); } catch (e) { /* ignore */ }
        try { window.dispatchEvent(new CustomEvent('sr-goto', { detail: { rel: '' } })); } catch (e) { /* ignore */ }
        return;
      }
      dropMedia();
      md.appendChild(el('div', 'sr-empty', (res && res.err) || '读取失败'));
      subText('');
      return;
    }
    var txt = String(res.content == null ? '' : res.content);
    // 认不出扩展名的文件（无后缀 / .sample 这类）：正文里出现 NUL（或大量坏字符）= 其实是二进制
    //   ⇒ 退回"打不开"卡片，绝不把乱码糊在面板里（不静默失败）
    if (kind === 'maybe-text' && srLooksBinary(txt)) {
      subText(srFull(rel) + '　·　' + srSize(res.size) + '　·　' + srTime(res.mtime));
      showOpaque(rel, name);
      markPicked(rel);
      return;
    }
    subText(srFull(rel) + '　·　' + srSize(res.size) + '　·　' + srTime(res.mtime));
    if (kind === 'md') showMarkdown(txt); else showPlainText(txt);
    if (res.cut) md.insertBefore(el('div', 'sr-cut', '⚠ 文件超过 4 MB，这里只渲染了前 4 MB'), md.firstChild);
    markPicked(rel);
  }

  // 文档里的链接：站内相对链接 → 原地跟读（_索引.md 里那一堆链接直接点就行）；外链 → 交给系统浏览器
  md.addEventListener('click', function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    ev.preventDefault();
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(href)) { srOpenPath(href); return; }
    if (href.charAt(0) === '#') return;
    // ★2026-10-13★ Markdown 里的目标路径必须允许**百分号编码**：文件名带半角空格或半角括号时
    //   （例：`中国鸟类图鉴(1).pdf`、`中国毒蛇及蛇伤救治 (蓝海，陈远聪).pdf`），
    //   裸写会被 Markdown 语法截断（`)` 提前结束目标），所以档案索引里统一写成 `%28`/`%20`
    //   —— 浏览器会自动解码，但这里是自己的渲染器，不解码就点不开（表现为"链接是死的"）。
    //   实测：自我复盘 `关系复盘\_索引.md`、`我的知识库\...\_索引.md` 里共 14 条这类链接。
    if (href.indexOf('%') >= 0) { try { href = decodeURI(href); } catch (e) { /* 不是合法编码就按原样用 */ } }
    var dir = curRel.indexOf('/') >= 0 ? curRel.replace(/[^/]*$/, '') : '';
    openDoc(srJoin(dir, href), null);
  });

  // 空状态：一段说明 + 根目录里的文档/目录快捷入口
  function emptyState(notice) {
    dropMedia();
    fname.textContent = '（未选择文档）';
    subText(SUB_HINT);
    var box = el('div', 'sr-empty sr-empty-big');
    box.appendChild(el('div', 'sr-empty-t', '自我复盘 · 文件预览'));
    if (notice) box.appendChild(el('div', 'sr-empty-s', notice));   // ★2026-10-11★ 回根原因（上次看的文件不在了），说人话
    box.appendChild(el('div', 'sr-empty-s', '在右上角「库」里单击一个文件，这里就会预览它（目录单击＝进入）。'
      + '单击、双击、怎么点都只在这里预览，只有这排的 🖥 才会拉起外部程序。'
      + '能预览的：md / txt / 代码 / json / csv 这些文本、图片（可滚轮缩放）、视频、音频、PDF、HTML、'
      + 'Word / Excel / PPT（自动转成 PDF 内嵌）；压缩包这类真的看不了的，会给一张提示卡 + 一键「用系统默认程序打开」。'
      + '看完点 ✕ 就能合上。'));
    md.appendChild(box);
    syncClose();                                  // 空状态 ⇒ ✕ 置灰（2026-10-13）
    if (!K) return;
    Promise.resolve(K.files('')).then(function (res) {
      if (disposed || !res || !res.ok) return;
      var quick = el('div', 'sr-quick');
      (res.rows || []).filter(function (r) { return r.isDir; }).forEach(function (r) {
        var b = el('button', 'sr-qbtn sr-qdir', '📁 ' + r.name);
        b.type = 'button';
        b.title = '在右上面板里进入这个目录';
        b.addEventListener('click', function () {
          try { window.dispatchEvent(new CustomEvent('sr-goto', { detail: { rel: r.name } })); } catch (e) { /* ignore */ }
        });
        quick.appendChild(b);
      });
      (res.rows || []).filter(function (r) { return !r.isDir; }).slice(0, 6).forEach(function (r) {
        var b = el('button', 'sr-qbtn', r.name);
        b.type = 'button';
        b.addEventListener('click', function () { openDoc(r.name, r.name); });
        quick.appendChild(b);
      });
      if (quick.childNodes.length) md.appendChild(quick);
    }).catch(function () { /* ignore */ });
  }

  bRe.addEventListener('click', function () { if (curRel) openDoc(curRel, null); });
  bOut.addEventListener('click', function () { if (curRel && !srOpenPath(srFull(curRel))) tip('打不开：主进程没有 openPath', 4000); });
  bRev.addEventListener('click', function () { if (curRel && !srRevealPath(srFull(curRel))) tip('打不开：主进程没有 revealPath / openFolder', 4000); });
  bCp.addEventListener('click', function () { if (curRel) tip(srCopy(srFull(curRel)) ? '✓ 已复制完整路径' : '复制失败', 2200); });

  // ---- ✕ 关闭当前预览（2026-10-13 加）----
  // 没打开任何文件时置灰（不然点了没反应，像坏了）。
  function syncClose() { bClose.disabled = !curRel; }
  function closeDoc() {
    if (!curRel) return;
    dropMedia();                                  // 图片/视频/PDF/HTML 这类挂在预览区的要一起销毁
    seq++;                                        // 还在路上的读取结果作废
    curRel = ''; br.cur = '';
    // 忘掉"上次看的文件"：不清的话下次开面板（或点 ⟳）它又自己恢复了，跟"我关掉了"矛盾
    try { localStorage.removeItem(SR_LAST_KEY); } catch (e) { /* ignore */ }
    emptyState('已关闭预览　·　再点右上角「库」里的文件名就能重新打开');
    syncClose();
    // 右上角文件库把高亮也去掉（只清高亮，不跳目录 —— 他可能正翻在很深的目录里）
    try { window.dispatchEvent(new CustomEvent('sr-clear-pick')); } catch (e) { /* ignore */ }
    tip('已关闭预览', 1600);
  }
  bClose.addEventListener('click', closeDoc);

  var last = '';
  try { last = localStorage.getItem(SR_LAST_KEY) || ''; } catch (e) { last = ''; }
  if (last) openDoc(last, null); else emptyState();

  return function () {
    disposed = true;
    seq++;                     // 还在路上的读取结果一律作废
    dropMedia();               // 挂在这儿的通用预览渲染器（图/视频/PDF/HTML）要一起销毁，别留下监听与 webview
    if (window.__SR && window.__SR.open === mine) window.__SR.open = null;
    if (window.__SR && window.__SR.cur === curRel) window.__SR.cur = '';
  };
};

// ============ 右上角「MCP」开关面板（2026-09-21）============
// 面板本体在同目录 mcp-panel.js：本文件每次点 ⟳ 都会重新执行，所以这里用带版本号的
// 动态 <script> 把面板也一起重载（删旧的再加新的）—— 改面板只需点 ⟳，不必重启 GUI。
(function () {
  try {
    var old = document.getElementById('mcp-panel-script');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var s = document.createElement('script');
    s.id = 'mcp-panel-script';
    s.src = 'mcp-panel.js?v=' + Date.now();
    (document.body || document.documentElement).appendChild(s);
  } catch (e) { if (window.console) console.warn('[mcp] 面板加载失败', e); }
})();

// ---- 网页版 AI 桥（renderer\webai-bridge.js）----
// 让任何会话/脚本能问顶栏那 5 个免费网页版（入口：scripts\webai.mjs）。
// 靠 window.__kunWebAiBridge 幂等：⟳ 重跑只是换一次回调，监听不叠（preload 侧只有一个分发器）。
(function () {
  var old = document.getElementById('webai-bridge-script');
  if (old && old.parentNode) old.parentNode.removeChild(old);
  var s = document.createElement('script');
  s.id = 'webai-bridge-script';
  s.src = 'webai-bridge.js?v=' + Date.now();
  (document.body || document.documentElement).appendChild(s);
})();

// ============ 面板对话框「焦点自愈」（2026-09-21）============
// 症状（用户实测原话）：对准面板窗口打字，字不进对话输入框、聊天框不显示，切到别的软件再切回来才好。
// 病因：宿主（<webview> 的 embedder）与 guest 的焦点不同步 —— guest 里的 composer 本来记得焦点，
//       但系统焦点没交给 guest，键盘事件就落在宿主那层（字跑到左上角那块），对话输入框自然不动。
// 修法：只在「guest 内部没有任何可编辑元素持有焦点」时，把焦点交回 guest **最靠下**的可编辑元素
//       （DSH 的 composer 就在页面底部）。用户正在打字时它已经持有焦点 ⇒ 这条分支不会走 ⇒ 绝不打断输入。
// 三道护栏（都是实测会踩到的场景）：
//   ① 宿主自己在输入（重命名节点、画布输入框等）⇒ 不抢；
//   ② 用户正待在别的 <webview> 里（顶栏网页版 AI 窗口、另一个面板）⇒ 不抢；
//   ③ 同一个位置 300ms 内只做一次（focus / transition 会连成一串）。
// 触发点＝用户手动的那个动作：窗口重新拿到系统焦点（alt-tab 回来）／页面重新可见／面板动画结束。
// 生效：改本文件 → 点顶栏 **⟳**（renderer 热更新），**不用重启**。排查用：控制台 `__kunFocusHealNow()`。
(function () {
  if (window.__kunFocusHeal) return;          // ⟳ 重跑只是重新执行本文件 ⇒ 装一次就够
  window.__kunFocusHeal = true;
  var HEAL = '(function(){try{' +
    'function ok(el){return !!el&&(el.tagName==="TEXTAREA"||el.tagName==="INPUT"||el.isContentEditable===true);}' +
    'var a=document.activeElement;' +
    'if(ok(a)){var ra=a.getBoundingClientRect();if(ra.width>40&&ra.height>8)return "keep:"+a.tagName;}' +
    'var n=document.querySelectorAll("textarea,[contenteditable=true]"),best=null,bestTop=-1e9;' +
    'for(var i=0;i<n.length;i++){var e=n[i],r=e.getBoundingClientRect(),s=getComputedStyle(e);' +
    'if(r.width<40||r.height<8||s.display==="none"||s.visibility==="hidden"||s.pointerEvents==="none")continue;' +
    'if(r.top>bestTop){bestTop=r.top;best=e;}}' +
    'if(best){try{best.focus();}catch(e2){}return "fix:"+best.tagName;}' +
    'return "none";}catch(e){return "err";}})()';
  function panelWv() {                        // 正在显示的那个对话面板 webview（有面积 = 在显示）
    var list = document.querySelectorAll('#harness-webview, webview.harness-wv'), best = null, area = 0;
    for (var i = 0; i < list.length; i++) {
      var wv = list[i], r;
      try { r = wv.getBoundingClientRect(); } catch (e) { continue; }
      if (r.width < 120 || r.height < 120) continue;
      var s = getComputedStyle(wv);
      if (s.display === 'none' || s.visibility === 'hidden') continue;
      if (r.width * r.height > area) { area = r.width * r.height; best = wv; }
    }
    return best;
  }
  var last = 0;
  // 留痕：每次自愈都往 data\focus-heal.log 追一行（只留最后 300 行）——
  // 这样"到底有没有再犯"不用靠用户开控制台，看文件就知道（走 app.file 通道，只允许 <盘根>:/E: 盘）。
  var LOG = '<工作台>\\外壳\\data\\focus-heal.log';
  function logHeal(why, r) {
    try {
      if (!window.app || !window.app.file || !window.app.file.write) return;
      window.app.file.read(LOG).then(function (res) {
        var old = (res && res.ok && res.text) ? res.text.split('\n') : [];
        var d = new Date();
        var stamp = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2) +
          ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2);
        old.push(stamp + '  ' + why + ' → ' + r);
        var keep = old.filter(function (x) { return x !== ''; }).slice(-300);
        return window.app.file.write(LOG, keep.join('\n') + '\n');
      }).catch(function () { });
    } catch (e) { /* ignore */ }
  }
  function heal(why) {
    var wv = panelWv();
    if (!wv || !wv.focus) return;
    var ae = document.activeElement;                                   // ①② 两道护栏
    if (ae && ae !== document.body) {
      if (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable) return;
      if (ae.tagName === 'WEBVIEW' && ae !== wv) return;
    }
    try { wv.focus(); } catch (e) { }
    try {
      wv.executeJavaScript(HEAL).then(function (r) {
        logHeal(why, r);
        if (window.console && r && r.indexOf('fix') === 0) console.log('[focus-heal] ' + why + ' → ' + r);
      }).catch(function () { });
    } catch (e) { }
  }
  function healSoon(why) {
    var t = Date.now(); if (t - last < 300) return; last = t;           // ③ 防抖
    setTimeout(function () { heal(why); }, 60);
  }
  window.addEventListener('focus', function () { healSoon('win-focus'); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) healSoon('visible'); });
  document.addEventListener('transitionend', function (e) {
    var c = e.target && e.target.classList;
    if (c && (c.contains('panel-body') || c.contains('view-body') || c.contains('webai-body'))) healSoon('anim');
  }, true);
  window.__kunFocusHealNow = function () { heal('manual'); return 'ok'; };   // 手动触发（排查用）
})();

// ================= 独立窗口「置顶」（2026-09-23 第十一轮；第十二轮修"刷新多一个" + 换线性图钉）=================
// 场景分离窗口（?solo=1，主进程 createWindow({scene}) 打开的独立窗口）顶部菜单栏加一个置顶按钮：
// 点它 = 主进程 win.setAlwaysOnTop 开关 ⇒ 置顶后窗口浮在最上层，缩小独立窗口也能
// 「一边看独立窗口、一边看主窗口」，点主窗口/其它页面不会被遮挡。再点取消。
// 放 renderers.js（⟳ 即见）；切置顶走 app.setAlwaysOnTop（preload/main 暴露，重启 GUI 后可用；
// 老宿主没有它 ⇒ 按钮不显示，不崩）。
// ⚠ **必须幂等**：⟳ 是**热更新**（renderer.js 的 hotReloadRenderers() 重新加载本文件、DOM 不重载）
//   ⇒ 这段 IIFE 每点一次 ⟳ 就重跑一遍。原来无条件 insertBefore，点几次就插几个按钮（用户实测报的 bug）。
//   现在：先摘掉旧的 #btn-flow-pin 再重建 —— 旧的 click 监听随节点一起丢掉，**不会**出现"两个监听
//   各切一次 = 点了没反应"；置顶状态记在 data-on 上（DOM 不重载 ⇒ 刷新后状态不丢，接着显示"已置顶"）。
// 图标：与顶栏其它线性图标（手机/技能）同款 —— 16×16、currentColor、stroke-width 1.3 的**图钉**，
//   不再是 📌 emoji（emoji 大小/配色跟着系统字体走，跟顶栏不搭）。
(function () {
  if (!/[?&]solo=1/.test(window.location.search || '')) return;   // 只在独立窗口显示
  var bar = document.querySelector('.titlebar-controls');
  var minBtn = document.getElementById('btn-min');
  if (!bar || !minBtn) return;
  if (!(window.app && window.app.setAlwaysOnTop)) return;         // 老宿主没有这个 IPC ⇒ 干脆不显示按钮

  var PIN_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">'
    + '<path d="M6.15 1.85h3.7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>'
    + '<path d="M7.05 1.85v3.3L4.85 7.6v1.25h6.3V7.6L8.95 5.15v-3.3" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>'
    + '<path d="M8 8.85v5.3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>'
    + '</svg>';

  var prevs = document.querySelectorAll('#btn-flow-pin');        // ⚠ 老版本可能已经插了**好几个**（同 id 重复），getElementById 只拿得到第一个 ⇒ 用 querySelectorAll 全摘
  var on = prevs.length ? prevs[prevs.length - 1].getAttribute('data-on') === '1' : false;
  prevs.forEach(function (b) { b.remove(); });                   // 连旧的 click 监听一起丢掉（避免双触发）
  var btn = el('button', 'tb-btn tb-tools');
  btn.type = 'button';
  btn.id = 'btn-flow-pin';
  btn.innerHTML = PIN_SVG;
  function paint() {
    btn.classList.toggle('on', on);
    btn.setAttribute('data-on', on ? '1' : '0');
    btn.title = on
      ? '已置顶（点我取消：窗口回到普通层，会被其它窗口挡住）'
      : '置顶显示：窗口浮在最上层，缩小后一边看独立窗口一边看主窗口';
  }
  btn.addEventListener('click', async function () {
    var want = !on;
    on = want; paint();                     // 先乐观切换（IPC 回来前界面不卡）
    try {
      var r = await window.app.setAlwaysOnTop(want);
      if (!r || !r.ok) { on = !want; paint(); }
    } catch (e) { on = !want; paint(); }
  });
  paint();
  bar.insertBefore(btn, minBtn);            // 排在 ─ □ ✕ 那组前面，紧挨窗口控制按钮
})();

// ==========================================================================================
// 2026-10-19（宿主：「看着没变化」）—— styles.css 热重载
//   根因：刷新面板只重载 webview + 重跑页面脚本，**不会重新拉 styles.css** ⇒ 改 CSS 以前必须整页刷新。
//   做法：每 2 秒 stat 一次 styles.css 的 mtime，变了就给 <link> 换个查询串 ⇒ 浏览器重新拉文件。
//   纯渲染层（不碰 main/preload）；幂等：计时器挂在 window.__dshCssHot 上，⟳ 多次也只跑一个。
// ==========================================================================================
(function cssHotReload() {
  try {
    if (window.__dshCssHot) return;
    var F = window.app && window.app.file;
    if (!F || !F.stat) return;                       // 老宿主没有 stat ⇒ 静默跳过
    var link = document.querySelector('link[rel="stylesheet"][href*="styles.css"]');
    if (!link) return;
    var winPath = decodeURIComponent(location.pathname).replace(/^\//, '').replace(/\//g, '\\');
    var cssPath = winPath.replace(/[^\\]+$/, 'styles.css');
    window.__dshCssHot = { at: 0, path: cssPath, link: link, n: 0 };
    var last = 0;
    function tick() {
      Promise.resolve().then(function () { return F.stat(cssPath); }).then(function (st) {
        if (!st || !st.exists) return;
        var t = Number(st.mtime) || 0;
        if (!t) return;
        if (last && t !== last) {
          link.href = 'styles.css?v=' + t;
          window.__dshCssHot.n++;
          window.__dshCssHot.at = Date.now();
          if (window.console) console.log('[cssHot] styles.css 变了 ⇒ 重新加载（第 ' + window.__dshCssHot.n + ' 次）');
        }
        last = t;
      }).catch(function () { /* 读不到就算了 */ });
      window.__dshCssHot.at = window.__dshCssHot.at || Date.now();
      window.__dshCssHot.at = window.__dshCssHot.at || Date.now();
    }
    tick();
    setInterval(tick, 2000);
  } catch (e) { /* 装饰失败不影响主流程 */ }
})();

// ==========================================================================================
// 2026-10-19 22:4x（宿主：「打开工作台时 B站场景的网页也露出来」· dg-dsh 定位）
//   机制：切视图只切 .active 类 ⇒ #scenario-view 变 display:none，但 Electron 的 <webview> 是独立 guest view，
//         **不跟着 display:none 隐藏** ⇒ 残影露出来（harness 视图里也能看到 B站网页）。
//   做法：用本仓既有先例（renderers.js L1412：隐藏层用 opacity:0 + pointer-events:none，**不用 display:none**，
//         否则终端/webview 的尺寸测量会失真）——
//     · #scenario-view 失去 .active ⇒ 把里面所有 webview 设 opacity:0 / pointer-events:none（保留尺寸与运行状态）
//     · 重新拿到 .active ⇒ 还原
//     · ⛔ 绝不动 src / 不 reload（B站登录态与页面进度都要保住）
//     · ⚠ 只管 #scenario-view 里的 webview，**不碰 harness 自己的 #harness-webview**
//   场景 A⇄B 互切：grid 会被重建、旧 guest 可能残留一帧 ⇒ 点场景标签时先 park，400ms 后按 .active 状态复位。
// ==========================================================================================
(function parkScenarioWebviews() {
  try {
    if (window.__dshParkWv) return;                       // 幂等：⟳ 多次只装一次
    var host = document.getElementById('scenario-view');
    if (!host) return;
    window.__dshParkWv = true;

    function each(fn) {
      var list = host.querySelectorAll('webview');
      for (var i = 0; i < list.length; i++) fn(list[i]);
    }
    function park(hide) {
      each(function (w) {
        if (hide) {
          if (!w.__dshParked) {
            w.__dshParked = { opacity: w.style.opacity, pe: w.style.pointerEvents };
          }
          w.style.opacity = '0';
          // 2026-10-19 宿主「B站内容操作不了」：这里原来越权设了 pointer-events:none，
          //   一旦某次 sync 没跑（页面重建时序）就会把可见的 webview 钉成不可点。
          //   其实隐藏时父级是 display:none，本来就点不到 ⇒ 这行不需要。
        } else if (w.__dshParked) {
          w.style.opacity = w.__dshParked.opacity || '';
          w.style.pointerEvents = '';   // 无条件清掉：宁可多点穿透，也不能让页面点不动
          delete w.__dshParked;
        }
      });
    }
    function sync() { park(!host.classList.contains('active')); }

    // ① 视图切换：盯 #scenario-view 的 class
    new MutationObserver(sync).observe(host, { attributes: true, attributeFilter: ['class'] });
    sync();

    // ② 场景 A⇄B：点标签时先压住，等重建完（400ms）再按当前可见性复位
    // 2026-10-19 宿主「B站内容操作不了」：原来点场景标签会先 park(true) 再 400ms 复位 ⇒ 时序一乱就把页面钉成不可点。
    //   这里整段撤掉：A⇄B 的残帧最多闪一下，但绝不会让人点不动（可点优先于好看）。
    // ③ 兜底：grid 内容变化时（场景重建）也让新加入的 webview 跟随当前可见性
    var grid = document.getElementById('grid');
    if (grid) {
      new MutationObserver(function () { if (!host.classList.contains('active')) park(true); })
        .observe(grid, { childList: true });
    }
    // 2026-10-19 兜底看门狗：每 2s 检查一次 —— 场景视图激活时，任何被 park 过的 webview 立即还原。
    //   （宁可多跑一个很轻的定时器，也不允许"页面看得见却点不动"）
    setInterval(function () { if (host.classList.contains('active')) park(false); }, 2000);
    // 2026-10-19 23:2x（bv-ai：也许输入没路由到 guest）—— 场景激活时给 webview 补一次 focus（无损）。
    //   ⚠ `重新 append` 那条我先**不启用**：移动 <webview> 可能让 guest 重载（B站会丢页面进度），
    //   等探针 `_点击探针.json` 里的 clicks / hostTop 出来再决定（clicks=0 且 hostTop=webview 才用）。
    new MutationObserver(function () {
      try {
        if (!host.classList.contains('active')) return;
        var ws = host.querySelectorAll('webview');
        for (var i = 0; i < ws.length; i++) {
          var w = ws[i];
          // 2026-10-19 23:3x：探针实测 clicks=0 且 hostTop=webview（没有遮挡、自身也没 pointer-events）
          //   ⇒ 就是 guest 的输入没路由。按 bv-ai 建议：**可见后重新挂一次**（同父容器内 append 回去），
          //   强制 guest 重新计算输入区域。每个 webview 只做一次（避免每次切场景都重挂）。
          if (w && !w.__dshRemounted) {
            w.__dshRemounted = 1;
            try { var pp = w.parentNode; if (pp) pp.appendChild(w); } catch (e) { /* ignore */ }
          }
          try { if (w && w.focus) w.focus(); } catch (e) {}
        }
      } catch (e) { /* ignore */ }
    }).observe(host, { attributes: true, attributeFilter: ['class'] });
    if (window.console) console.log('[park] 场景 webview 停车机制已装（opacity 方案，不动 src）');
  } catch (e) { /* 装饰失败不影响功能 */ }
})();

// ==========================================================================================
// 2026-10-21（宿主：顶栏 ⟳ 刷不到「原始对话面板」，而且它有时会空白）
//   ⟳ 原来只做两件事：热更新渲染器 + 重建**本地场景**；Harness（场景 0，内嵌 webview）根本不碰
//   ⇒ 所以刷不到。这里补一层（放 renderers.js，可热重载、不用重启工作台）：
//     ① Harness 页签下点 ⟳ ⇒ 真 reload 那个 webview（会话/布局都在引擎侧，刷新不丢）
//     ② 刷完 2.5s 自检：还空白 ⇒ 重新取一次带 token 的地址强刷
//     ③ 自愈：guest 进程崩了 / did-fail-load ⇒ 自动重载（最多 3 次，间隔递增，60s 冷却）
//     ④ 窗口获得焦点时，若当前就在 Harness 页且是空白 ⇒ 自动恢复（同样带冷却）
// ==========================================================================================
(function harnessRefreshHook() {
  var wv = document.getElementById('harness-webview');
  var btn = document.getElementById('btn-refresh');
  var view = document.getElementById('harness-view');
  if (!wv || !btn || !view) return;

  // 2026-10-21（宿主改口径）：**把"刷新"拆开** —— 顶栏 ⟳ 只刷场景，不再碰对话；
  //   对话面板单独一颗按钮，放在场景栏右侧「余额」旁边（宿主原话："到余额旁边专门刷新对话的"）。
  //   ⚠ 这一段必须放在"是否已挂监听"的判断**之前**：hotReload 重跑本文件时它每次都要重新插一次按钮。
  window.__mountChatReload = function () {
    try {
      var right = document.querySelector('.scenebar-right');
      if (!right) return;
      var olds = document.querySelectorAll('#btn-chat-reload');
      for (var i = 0; i < olds.length; i++) { if (olds[i].parentNode) olds[i].parentNode.removeChild(olds[i]); }
      var b = document.createElement('button');
      b.type = 'button';
      b.id = 'btn-chat-reload';
      b.className = 'sb-reload';
      b.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">'
        + '<path d="M13.25 8a5.25 5.25 0 1 1-1.62-3.79" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/>'
        + '<path d="M13.45 2.35v3.5H9.95" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/>'
        + '</svg><span>刷新对话</span>';
      b.title = '只重载 DSH 引擎 的对话面板（场景不变、会话不丢；面板空白时点它就能救回来）';
      b.addEventListener('click', function (ev) { ev.stopPropagation(); reloadHarness(); });
      var chip = document.getElementById('balance-chip');
      if (chip && chip.parentNode === right) right.insertBefore(b, chip);   // 紧挨「余额」左边
      else right.insertBefore(b, right.firstChild);
    } catch (e) { /* ignore */ }
  };
  window.__mountChatReload();

  if (window.__harnessRefreshHooked) {        // ⟳ 重注入：别挂第二份监听
    window.__harnessWv = wv;
    return;
  }
  window.__harnessRefreshHooked = true;
  window.__harnessWv = wv;

  var BLANK_PROBE = '(() => { try {'
    + ' var r = document.getElementById("root"); if (!r || r.children.length === 0) return false;'
    + ' if (document.querySelector(\'[data-side="sidebar"]\') || document.querySelector("[data-chat-flow]") || document.querySelector("[data-phase]")) return true;'
    + ' return (r.innerText || "").trim().length > 20;'
    + ' } catch (e) { return false; } })()';

  function toast(msg, bad) {
    try {
      var box = document.querySelector('.tbs-toasts');
      if (!box) { box = document.createElement('div'); box.className = 'tbs-toasts'; document.body.appendChild(box); }
      var t = document.createElement('div');
      t.className = 'tbs-toast' + (bad ? ' bad' : '');
      t.textContent = msg;
      box.appendChild(t);
      setTimeout(function () { t.classList.add('out'); setTimeout(function () { t.remove(); }, 320); }, 3600);
    } catch (e) { /* ignore */ }
  }
  function isActive() { try { return view.classList.contains('active'); } catch (e) { return false; } }
  var lastAuto = 0;
  function canAuto() { var now = Date.now(); if (now - lastAuto < 60000) return false; lastAuto = now; return true; }

  function reloadHarness(why, quiet) {
    try {
      var src = wv.getAttribute('src') || '';
      if (!src) {
        // 还没拿到地址（引擎刚起）⇒ 交给 renderer.js 的 loadHarness
        if (typeof window.loadHarness === 'function') window.loadHarness();
        if (!quiet) toast('对话面板还没加载，已让它重新加载');
        return;
      }
      try { wv.reload(); } catch (e) { /* ignore */ }
      if (!quiet) toast('已刷新对话界面' + (why ? '（' + why + '）' : ''));
      setTimeout(verify, 2500);
    } catch (e) { if (!quiet) toast('刷新失败：' + ((e && e.message) || e), true); }
  }

  // 刷完自检：还是空白 ⇒ 重新取一次带 token 的地址，强刷一遍
  function verify() {
    var p;
    try { p = wv.executeJavaScript(BLANK_PROBE); } catch (e) { return; }
    if (!p || !p.then) return;
    p.then(function (ok) {
      if (ok) return;
      try {
        if (!(window.app && window.app.getHarnessUrl)) return;
        window.app.getHarnessUrl().then(function (url) {
          if (!url) return;
          try { wv.setAttribute('src', 'about:blank'); } catch (e) { /* ignore */ }
          setTimeout(function () { try { wv.setAttribute('src', url); } catch (e) { /* ignore */ } }, 80);
          toast('界面仍是空白 ⇒ 已重新取地址强刷（多半是引擎 token 换过了）', true);
        }).catch(function () { /* ignore */ });
      } catch (e) { /* ignore */ }
    }).catch(function () { /* 执行不了 = 还在加载 */ });
  }

  // 自愈 ①：guest 进程崩了
  var autoTries = 0;
  try {
    wv.addEventListener('render-process-gone', function () {
      if (autoTries >= 3) return;
      autoTries++;
      setTimeout(function () { reloadHarness('渲染进程崩了，自动恢复', true); }, 800 * autoTries);
    });
    wv.addEventListener('crashed', function () {
      if (autoTries >= 3) return;
      autoTries++;
      setTimeout(function () { reloadHarness('渲染进程崩了，自动恢复', true); }, 800 * autoTries);
    });
    // 自愈 ②：加载失败（-3 = 主动取消，不算）
    wv.addEventListener('did-fail-load', function (e) {
      if (e && e.errorCode === -3) return;
      if (autoTries >= 3) return;
      autoTries++;
      setTimeout(function () { reloadHarness('加载失败，自动恢复', true); }, 1200 * autoTries);
    });
    wv.addEventListener('did-finish-load', function () { autoTries = 0; });
  } catch (e) { /* ignore */ }

  // 自愈 ③：窗口回到前台、且当前就在 Harness 页 → 探一次空白（60s 冷却）
  window.addEventListener('focus', function () {
    if (!isActive()) return;
    if (!canAuto()) return;
    var p;
    try { p = wv.executeJavaScript(BLANK_PROBE); } catch (e) { return; }
    if (!p || !p.then) return;
    p.then(function (ok) {
      try { if (!ok && !wv.isLoading()) reloadHarness('检测到空白，自动恢复', true); } catch (e) { /* ignore */ }
    }).catch(function () { /* ignore */ });
  });
})();

// ==========================================================================================
// 2026-10-21（宿主：「把这四个用一个大胶囊扩住，他们是一类」）
//   这四个 = 插件 🧩 / 技能 ✨ / MCP 🔌 / 工具 🛠 —— 都是"扩展类"入口，
//   原来散在顶栏里跟 ⟳、序号、模型、窗口按钮混在一起。这里给它们套一个圆角大胶囊（.tb-group）。
//   ⚠ btn-mcp 是 mcp-panel.js **后来才插**的 ⇒ 用 MutationObserver + 前 12 秒补几次，
//      保证它一出现就被收进同一个胶囊；⟳ 重注入也幂等（有 #tb-group-ext 就只校正顺序）。
// ==========================================================================================
(function extGroupTopbar() {
  var IDS = ['btn-plugins', 'btn-skills', 'btn-mcp', 'btn-tools'];
  function ensure() {
    try {
      var controls = document.querySelector('#titlebar .titlebar-controls');
      var first = document.getElementById('btn-plugins');
      if (!controls || !first) return;
      var group = document.getElementById('tb-group-ext');
      if (!group) {
        group = document.createElement('div');
        group.className = 'tb-group';
        group.id = 'tb-group-ext';
        group.title = '扩展：插件 / 技能 / MCP / 工具';
        controls.insertBefore(group, first);
      }
      var want = [];
      for (var i = 0; i < IDS.length; i++) {
        var b = document.getElementById(IDS[i]);
        if (b) want.push(b);
      }
      var now = Array.prototype.slice.call(group.children);
      var same = want.length === now.length && want.every(function (b, k) { return now[k] === b; });
      if (!same) { for (var j = 0; j < want.length; j++) group.appendChild(want[j]); }
    } catch (e) { /* ignore */ }
  }
  ensure();
  var tries = 0;
  var t = setInterval(function () { ensure(); if (++tries > 20) clearInterval(t); }, 600);
  try {
    var c = document.querySelector('#titlebar .titlebar-controls');
    if (c && window.MutationObserver) {
      var mo = new MutationObserver(function () { ensure(); });
      mo.observe(c, { childList: true });
    }
  } catch (e) { /* ignore */ }
  window.addEventListener('focus', ensure);
})();

// 2026-10-22（宿主：分离窗口拖不动、要"左上角标题能拖"）——
//   .brand 从 no-drag 改成 drag（整块标题都能拖窗口），代价是 :hover 不投递事件 ⇒ 版本卡出不来。
//   补法：只有那颗小圆点还留 no-drag（能收鼠标事件），悬停它时给 .brand 挂 .is-tip，CSS 负责显示版本卡。
//   放 renderers.js ⇒ ⟳ 即生效，不用重启。
(function brandTipOnDot() {
  try {
    var brand = document.querySelector('#titlebar .brand');
    var dot = document.getElementById('brand-dot');
    if (!brand || !dot || dot.__tipBound) return;
    dot.__tipBound = true;
    dot.addEventListener('mouseenter', function () { brand.classList.add('is-tip'); });
    dot.addEventListener('mouseleave', function () { brand.classList.remove('is-tip'); });
  } catch (e) { /* ignore */ }
})();

// 2026-10-22（宿主：预览统一收到「设置 → 启动动画」插件页）——
//   外壳只负责"被叫醒"：插件写 外壳\data\boot-preview.json  {"id":"<动画id>","at":<毫秒>}
//   这里每 1.2 秒看一眼；at 比上次处理过的更大就 __bootPreview(id) 播一遍。
//   · at 记在 localStorage（app.bpw.at）⇒ 页面重载/重启不会把同一条指令再播一次
//   · 每次热注入重挂 interval（先 clear），避免旧实例被页面重载带走后变哑巴
//   · 只读文件，不写不删
(function bootPreviewWatch() {
  try {
    var F = window.app && window.app.file;
    if (!F || !F.read) return;
    if (window.__bpwTimer) { clearInterval(window.__bpwTimer); window.__bpwTimer = null; }
    var CFG = ((window.app && window.app.paths && window.app.paths.dataDir) || '.') + '\\boot-preview.json';
    var KEY = 'app.bpw.at';
    var lastAt = 0;
    try { lastAt = Number(localStorage.getItem(KEY)) || 0; } catch (e) { /* ignore */ }
    window.__bpwTimer = setInterval(function () {
      if (document.hidden) return;
      Promise.resolve(F.read(CFG)).then(function (r) {
        var txt = (typeof r === 'string') ? r : ((r && (r.text || r.content)) || '');
        if (!txt) return;
        var j = null;
        try { j = JSON.parse(txt); } catch (e) { return; }
        var at = Number(j && j.at) || 0;
        if (!at || at <= lastAt) return;
        lastAt = at;
        try { localStorage.setItem(KEY, String(at)); } catch (e) { /* ignore */ }
        var id = j && j.id ? String(j.id) : '';
        if (window.__bootPreview) window.__bootPreview(id || undefined);
      }).catch(function () { /* 读不到安静跳过 */ });
    }, 1200);
  } catch (e) { /* ignore */ }
})();

// ==========================================================================================
// 2026-10-26（宿主）：新场景「命令」——左边大窗口把记忆系统做成 3D 神经元网络（节点=场景/技能/记忆文档，
//   连线=所有权与依赖），右边窄条 = AI 会话。本渲染器只读共享记忆与技能目录，不改任何文件。
//   · 3D 用 canvas 2D 自己投影（不引三方库，CSP script-src 'self' 也引不进来）
//   · 数据源：_共享记忆\索引.json + areas\*.md + 冲突.md + _待办.md + _跨场景通知.md + 技能 SKILL.md
//   · 交互：拖拽旋转 / 滚轮缩放 / 悬停高亮邻居 / 点击看详情（可定位文件）/ 搜索过滤 / 自转开关
// ==========================================================================================
renderers.neuron = (body, meta, head) => {
  body.classList.add('kneu-wrap');
  body.innerHTML = '';

  const F = (window.app && window.app.file) || null;
  const OPEN = (window.app && window.app.topbar && window.app.topbar.open) || null;
  // 根统一 引擎\\场景记忆（2026-10-27 审计②：旧别名 场景项目信息 是 junction，收掉就全断）
  const P = (window.app && window.app.paths) || {};
  const MEM_ROOT = P.memRoot || '';
  const ROOT = MEM_ROOT + '\\_共享记忆';
  const META_DIR = MEM_ROOT;
  const SKILL_DIR = P.skillDir || '<工作台>\\引擎数据\\.dsh\\skills';
  // 技能清单**不硬编码**（2026-10-27 审计①：硬编码 23 漏了 command / douyin）——运行时列技能目录，这份只当兜底
  const SKILL_FALLBACK = ['gui-workbench', 'harness-dev', 'context-overflow', 'workbuddy', 'webai-offload',
    'new-tools', 'code-dev', 'design-misc', 'pc-cleanup', 'bilibili', 'blender', 'comfyui',
    'code-video', 'jianying-ai-editor', 'oa-ops', 'your-site', 'self-profile',
    'video-workflow-canvas', 'transparent-flow-video', 'provider-direct', 'host-scan', 'app-packaging',
    'local-pc-control', 'command', 'douyin'];
  // 边的语义标签（2026-10-27 审计⑤：原来只有颜色，看不出这条线是什么关系）
  const EDGE_LABEL = {
    area: '内核 → 区域', skill: '技能归属（→ owner 场景）', memory: '私有记忆归属',
    project: '项目 owner', dep: '区域互相提及（文本启发式）', chain: '提交链',
    source: '数据源', doc: '共享文档'
  };
  // 归口配色：引擎/工具=蓝 · 界面/设计=琥珀 · 内容/业务=绿 · 运维/清理=红
  const GROUP = {
    'dg-dsh': 'engine', 'dg-gui': 'ui', 'code-ai': 'code', 'dz-ai': 'ui', 'site-ai': 'content',
    'wb-ai': 'content', 'oa-ai': 'content', 'vw-ai': 'content', 'bv-ai': 'content', 'bl-ai': 'content',
    'mk-chat': 'content', 'sr-ai': 'content', 'pc-ai': 'ops'
  };
  const COLOR = { core: '#7fe3ff', engine: '#8fb4ff', ui: '#f0a35e', code: '#b79bff', content: '#3ddc84', ops: '#e5484d', skill: '#6f8fd6', doc: '#c9d4e6', project: '#2dd4bf', memory: '#dfe7ff', source: '#8f9bb3', chain: '#ffcf6b' };
  // 项目层（2026-10-26）：不是从记忆里正则猜，而是直接列真实目录（B 盘/项目工程），归属按 area 正文里出现的名字来挂
  const PROJECT_ROOTS = P.projectRoots || [];
  // dg-dsh 审计（2026-10-26）：这 5 个是一级目录但属于「资料/介质夹」，不是项目
  const NON_PROJECTS = ['_项目文件', '产物、素材、内容、方案', '服务器信息', '通用素材', '更新feed'];
  // 私有记忆（2026-10-26，宿主："每个场景的私有记忆连到各自对应的场景"）——
  //   映射照抄 _场景身份索引.md §五「写回点」的权威表，别自己猜文件夹名。
  // 私有记忆兜底表（2026-10-27 审计②）：只补 记忆地图 缺的项；名字统一 场景私有记忆.md、根统一 场景记忆
  const MEM_DIR = MEM_ROOT;
  const CHAIN_DIR = MEM_ROOT + '\\_共享记忆\\提交链';
  const MEMORY_BY_PANEL = {
    'cmd-chat': MEM_DIR + '\\命令\\场景私有记忆.md',
    'bv-ai': MEM_DIR + '\\B站\\场景私有记忆.md',
    'dg-dsh': MEM_DIR + '\\DSH·GUI改造\\场景私有记忆.md',
    'dg-gui': MEM_DIR + '\\DSH·GUI改造\\场景私有记忆.md',
    'bl-ai': MEM_DIR + '\\Blender\\场景私有记忆.md'
  };

  // ---------- 骨架 ----------
  const cv = el('canvas', 'kneu-cv');
  const hud = el('div', 'kneu-hud');
  const stat = el('div', 'kneu-stat', '加载中…');
  const searchWrap = el('div', 'kneu-searchwrap');
  const search = el('input', 'kneu-search');
  search.type = 'search';
  search.placeholder = '搜场景 / 技能 / 文件…';
  searchWrap.appendChild(el('span', 'kneu-searchico', '⌕'));
  searchWrap.appendChild(search);
  hud.appendChild(searchWrap);
  hud.appendChild(stat);
  const btns = el('div', 'kneu-btns');
  const bRot = el('button', 'kneu-btn', '⟳ 自转');
  const bReset = el('button', 'kneu-btn', '⤾ 复位');
  const bMem = el('button', 'kneu-btn', '只看记忆');
  const bFx = el('button', 'kneu-btn', '动效：开');
  bMem.type = 'button';
  bMem.title = '只留：场景 / 私有记忆 / 提交链 / 共享文档（技能·项目·数据源 及它们的连线一起隐藏）';
  const bLabel = el('button', 'kneu-btn', '标签：自动');
  bFx.type = 'button';
  bFx.title = '星点/流光/呼吸的开关（卡就关掉）';
  const bReload = el('button', 'kneu-btn', '↻ 重读');
  bLabel.type = 'button';
  bLabel.title = '节点标签：自动（场景常显、项目近了才显示）→ 全部 → 关';
  bRot.type = bReset.type = bReload.type = 'button';
  btns.appendChild(bRot); btns.appendChild(bReset); btns.appendChild(bMem); btns.appendChild(bFx); btns.appendChild(bLabel); btns.appendChild(bReload);
  hud.appendChild(btns);
  const detail = el('div', 'kneu-detail');
  const legend = el('div', 'kneu-legend');
  [['engine', '引擎/工具'], ['ui', '界面/设计'], ['code', '代码'], ['content', '内容/业务'], ['ops', '运维/清理'], ['project', '项目'], ['memory', '私有记忆'], ['chain', '提交链'], ['source', '数据源'], ['skill', '技能'], ['doc', '共享文档']]
    .forEach(function (p) {
      var it = el('span', 'kneu-lg');
      var dot = el('i', 'kneu-dot');
      dot.style.background = COLOR[p[0]];
      it.appendChild(dot);
      it.appendChild(document.createTextNode(p[1]));
      legend.appendChild(it);
    });
  body.appendChild(cv);
  body.appendChild(hud);
  body.appendChild(detail);
  body.appendChild(legend);
  if (head) {
    head.appendChild(el('span', 'stat-refresh', '共享记忆 · 只读'));
  }

  // ---------- 状态 ----------
  let nodes = [];        // {id,label,kind,group,path,size,x,y,z,r,deg,hover}
  let edges = [];        // {a,b,kind}
  let ry = -0.35, rx = 0.18, zoom = 1.42;
  let hover = null, sel = null, auto = true, disposed = false, raf = 0, last = 0;
  var ownerSkill = {};   // skill 节点 id → 面板 id（layout 贴 owner 用）
  let labelMode = 1;   // 1=全部（默认，宿主 2026-10-26：所有点都要有文字标签） 0=自动 2=关
  let fx = true;       // 动效（星点/流光/呼吸）；卡就一键关
  let onlyMem = false; // 只看记忆：只留 内核/场景/私有记忆/提交链/共享文档
  let bornAt = 0;      // 载入时刻（入场动画：整图从中心展开）
  let introBoot = false; // 2026-10-27 宿主：点「↻ 重读」无条件重播一次入场动画（即使动效开关是关的）
  var stars = [];
  function makeStars() {
    stars = [];
    var n = 18;
    for (var i = 0; i < n; i++) {
      stars.push({ x: Math.random() * W, y: Math.random() * H, r: 0.4 + Math.random() * 1.1, ph: Math.random() * 6.28, sp: 0.4 + Math.random() * 1.2 });
    }
  }
  let W = 0, H = 0, dpr = 1, q = '';

  function readText(p) {
    if (!F || !F.read) return Promise.resolve('');
    return Promise.resolve(F.read(p)).then(function (r) {
      return (typeof r === 'string') ? r : ((r && (r.text || r.content)) || '');
    }).catch(function () { return ''; });
  }
  function statSize(p) {
    if (!F || !F.stat) return Promise.resolve(0);
    return Promise.resolve(F.stat(p)).then(function (r) {
      return (r && (r.size || (r.stat && r.stat.size))) || 0;
    }).catch(function () { return 0; });
  }
  // 2026-10-27 审计⑤：路径存在校验（kun:file:stat 缺失时返回 {ok:true, exists:false}，不抛错）
  function statOk(p) {
    if (!F || !F.stat || !p) return Promise.resolve(false);
    return Promise.resolve(F.stat(p)).then(function (r) {
      if (!r || r.ok === false) return false;
      if (r.exists === false) return false;
      return !!(r.isDir || r.size != null || r.stat);
    }).catch(function () { return false; });
  }

  // ---------- 载入数据 ----------
  function load() {
    stat.textContent = '正在读共享记忆…';
    return Promise.all([readText(ROOT + '\\索引.json'), readText(ROOT + '\\项目.json'), readText(ROOT + '\\记忆地图.json')]).then(function (both) {
      var txt = both && both[0];
      var projTxt = (both && both[1]) || '';
      var mapTxt = (both && both[2]) || '';
      var memMap = null;
      try { memMap = mapTxt ? JSON.parse(mapTxt) : null; } catch (e) { memMap = null; }
      var memByPanel = {};
      if (memMap && Array.isArray(memMap.areas)) {
        memMap.areas.forEach(function (a) {
          if (a && a.panel && Array.isArray(a.privateMemory) && a.privateMemory.length) memByPanel[a.panel] = a.privateMemory;
        });
      }
      var reg = null;
      try { reg = projTxt ? JSON.parse(projTxt) : null; } catch (e) { reg = null; }
      var idx = null;
      try { idx = JSON.parse(txt); } catch (e) { idx = null; }
      // 客户包：记忆地图里的相对路径按记忆根解析（不带盘符）
      function __memAbs(mp) {
        if (!mp) return '';
        if (/^[A-Za-z]:/.test(mp)) return mp;
        return MEM_ROOT + '\\' + String(mp).replace(/^引擎[\\/]场景记忆[\\/]/, '');
      }
      var areas = (idx && idx.areas) || [];
      nodes = []; edges = [];
      var core = { id: 'core', label: 'DSH 记忆', kind: 'core', group: 'core', r: 15, path: ROOT, size: 0 };
      nodes.push(core);

      var docs = [
        { id: 'doc-todo', label: '待办', path: META_DIR + '\\_待办.md', ang: 0 },
        { id: 'doc-msg', label: '通知', path: META_DIR + '\\_跨场景通知.md', ang: Math.PI * 0.66 },
        { id: 'doc-conf', label: '冲突', path: ROOT + '\\冲突.md', ang: Math.PI * 1.33 }
      ];
      var jobs = [];

      // 文档节点（放在内核附近）
      docs.forEach(function (d) {
        jobs.push(statSize(d.path).then(function (sz) {
          nodes.push({ id: d.id, label: d.label, kind: 'doc', group: 'doc', path: d.path, size: sz, r: 8 });
          edges.push({ a: 'core', b: d.id, kind: 'doc' });
        }));
      });

      // 场景区域节点（球壳 1）+ 依赖边
      areas.forEach(function (a, i) {
        var id = 'area-' + a.owner;
        var g = GROUP[a.owner] || 'content';
        jobs.push(readText(ROOT + '\\' + String(a.file || '').replace(/\//g, '\\')).then(function (txt) {
          nodes.push({
            id: id, label: a.owner, title: a.title || '', kind: 'area', group: g,
            path: ROOT + '\\' + String(a.file || '').replace(/\//g, '\\'),
            size: txt.length, region: a.region || '', text: txt
          });
          edges.push({ a: 'core', b: id, kind: 'area' });
        }));
      });

      // 项目节点（2026-10-26）：优先读 dg-dsh 建的登记表 _共享记忆\\项目.json；
      //   没有才退回"列两个真实根目录"。登记表里有 owner/status/aliases ⇒ 归属与状态都比猜的准。
      var fromReg = !!(reg && Array.isArray(reg.projects) && reg.projects.length);
      if (fromReg) {
        reg.projects.forEach(function (pr) {
          if (!pr || !pr.name) return;
          var owner = String(pr.owner || '');
          nodes.push({
            id: 'proj-' + String(pr.id || pr.name),
            label: String(pr.name).slice(0, 24),
            kind: 'project', group: 'project',
            path: (Array.isArray(pr.paths) && pr.paths[0]) || '',
            paths: Array.isArray(pr.paths) ? pr.paths : [],
            owner: owner,
            status: String(pr.status || 'active'),
            aliases: Array.isArray(pr.aliases) ? pr.aliases : [],
            size: 0
          });
        });
        console.log('[neuron] 项目登记表：' + reg.projects.length + ' 个项目');
      }
      var oaApi = (window.app && window.app.oa) || null;   // 列目录能力：项目兜底 + 提交链 都要用
      if (!fromReg && oaApi && oaApi.filesLocal) {
        PROJECT_ROOTS.forEach(function (root) {
          jobs.push(Promise.resolve(oaApi.filesLocal(root)).then(function (r) {
            if (!r || r.ok === false) return;
            (r.rows || []).filter(function (it) {
              return it && it.isDir && NON_PROJECTS.indexOf(String(it.name)) < 0;
            }).slice(0, 40).forEach(function (it) {
              nodes.push({
                id: 'proj-' + root.replace(/[^A-Za-z0-9]/g, '_') + '-' + it.name,
                label: String(it.name).slice(0, 22), kind: 'project', group: 'project',
                path: root + '\\' + it.name, size: it.size || 0, root: root
              });
            });
          }).catch(function () { /* 目录不存在就算了 */ }));
        });
      }

      // 私有记忆节点：优先用 记忆地图.json（一个面板可有多份），没有才退回硬编码表
      areas.forEach(function (a) {
        var list = (memByPanel[a.owner] || (MEMORY_BY_PANEL[a.owner] ? [MEMORY_BY_PANEL[a.owner]] : [])).map(__memAbs);
        list.forEach(function (mp, mi) {
          var isDir = /[\\/]$/.test(mp) || !/\.md$/i.test(mp);
          (isDir ? Promise.resolve(0) : statSize(mp)).then(function (sz) {
            var id = 'mem-' + a.owner + (list.length > 1 ? ('-' + mi) : '');
            nodes.push({
              id: id, label: '§' + a.owner + (list.length > 1 ? ('·' + (mi + 1)) : ''), kind: 'memory', group: 'memory',
              path: mp, size: sz || 0, isDir: isDir, ownerPanel: a.owner
            });
            edges.push({ a: 'area-' + a.owner, b: id, kind: 'memory' });
          });
        });
      });

      // 数据源节点（记忆地图 dataSources）：工具/插件/MCP/会话档案/备份/台账/体检 …
      if (memMap && memMap.dataSources) {
        var SKIP = { scenes: 1, skills: 1, projects: 1, tasks: 1 };   // 这几个已有专门节点
        Object.keys(memMap.dataSources).forEach(function (key) {
          if (SKIP[key]) return;
          var ds = memMap.dataSources[key] || {};
          var nm = ({ tools: '工具', plugins: '插件', mcp: 'MCP', sessions: '会话档案', backups: '备份', docs: '说明台账', health: '体检' })[key] || key;
          var cnt = ds.count;
          nodes.push({
            id: 'src-' + key, label: nm + (cnt ? (' ' + cnt) : ''), kind: 'source', group: 'source',
            path: String(ds.path || ds.board || ''), size: 0, srcKey: key,
            dsInfo: ds
          });
          edges.push({ a: 'core', b: 'src-' + key, kind: 'source' });
        });
      }

      // 提交链（2026-10-26 A 档）：每个面板一条追加式锚点链，只读
      if (oaApi && oaApi.filesLocal) {
        jobs.push(Promise.resolve(oaApi.filesLocal(CHAIN_DIR)).then(function (r) {
          if (!r || r.ok === false) return [];
          var rows = (r.rows || []).filter(function (it) { return it && /\.jsonl$/i.test(it.name); });
          return Promise.all(rows.map(function (it) {
            var panel = String(it.name).replace(/\.jsonl$/i, '');
            return readText(CHAIN_DIR + '\\' + it.name).then(function (txt) {
              var list = String(txt || '').split(/\r?\n/).filter(Boolean).map(function (line) {
                try { return JSON.parse(line); } catch (e) { return null; }
              }).filter(Boolean);
              if (!list.length) return;
              var last = list[list.length - 1];
              nodes.push({
                id: 'chain-' + panel, label: '链 ' + list.length, kind: 'chain', group: 'chain',
                path: CHAIN_DIR + '\\' + panel + '.jsonl', size: 0, panel: panel,
                total: list.length, recent: list.slice(-3).reverse()
              });
              edges.push({ a: 'area-' + panel, b: 'chain-' + panel, kind: 'chain' });
            });
          }));
        }).catch(function () { /* 没有链目录就算了 */ }));
      }

      // 技能归属（2026-10-26）：读 skills\_索引.md 的「属于哪个场景」列，把技能挂到它 owner 的 area 上
      // 2026-10-27 修：那一格写的是「场景名（`场景id` · 面板 `面板id`）」，旧正则取第一个形如 xx-xx 的反引号词
      //   ⇒ pc-cleanup / self-profile / code-dev / oa-ops 被解析成「场景 id」（area-pc-cleanup 之类根本不存在）
      //   ⇒ 边悬空、画不出来 ⇒ 这几个技能点看着"没连线"。现在只认**真实存在的 area owner（面板 id）**。
      var AREA_IDS = {};
      areas.forEach(function (a) { if (a && a.owner) AREA_IDS[a.owner] = 1; });
      var SKILL_OWNER = {};
      jobs.push(readText('<工作台>\\引擎数据\\.dsh\\skills\\_索引.md').then(function (txt) {
        String(txt || '').split(/\r?\n/).forEach(function (line) {
          if (!line.startsWith('| `')) return;
          var cells = line.split('|').map(function (c) { return c.trim(); });
          var name = String(cells[1] || '').replace(/`/g, '');
          var own = String(cells[2] || '');
          var toks = own.match(/`[a-z0-9][a-z0-9-]{1,20}`/g) || [];
          var picked = '';
          for (var ti = 0; ti < toks.length; ti++) {
            var tk = toks[ti].replace(/`/g, '');
            if (AREA_IDS[tk]) { picked = tk; break; }     // 只认真实 area owner
          }
          if (name) SKILL_OWNER[name] = picked;            // 空串 = 没有归属 ⇒ 挂 core
        });
      }).catch(function () { /* 索引读不到就当没归属 */ }));

      // 技能节点（球壳 2）：清单 = 真实目录（2026-10-27 审计①），读不到才用兜底表
      var skillListP = (oaApi && oaApi.filesLocal)
        ? Promise.resolve(oaApi.filesLocal(SKILL_DIR)).then(function (r) {
            if (!r || r.ok === false) return [];
            return (r.rows || []).filter(function (it) {
              return it && it.name && String(it.name).charAt(0) !== '_' && it.isDir !== false;
            }).map(function (it) { return String(it.name); });
          }).catch(function () { return []; })
        : Promise.resolve([]);
      jobs.push(skillListP.then(function (dirs) {
        var list = (dirs && dirs.length) ? dirs.slice().sort() : SKILL_FALLBACK;
        list.forEach(function (n) {
          var id = 'skill-' + n;
          jobs.push(statSize(SKILL_DIR + '\\' + n + '\\SKILL.md').then(function (sz) {
            nodes.push({ id: id, label: n, kind: 'skill', group: 'skill', path: SKILL_DIR + '\\' + n + '\\SKILL.md', size: sz });
            var ownerPanel = SKILL_OWNER[n];
            edges.push({ a: ownerPanel ? ('area-' + ownerPanel) : 'core', b: id, kind: 'skill' });
            if (ownerPanel) ownerSkill[id] = ownerPanel;
          }));
        });
      }));

      return Promise.all(jobs).then(function () { return Promise.all(jobs); });
    }).then(function () {
      // 路径校验（2026-10-27 审计⑤）：每个节点加载时验一次，失效的标红、详情里写明
      return Promise.all(nodes.filter(function (n) { return n.path; }).map(function (n) {
        return statOk(n.path).then(function (okk) { n.missing = !okk; });
      }));
    }).then(function () {
      // 依赖边：area 文本里提到别的 owner ⇒ 连一条
      var owners = nodes.filter(function (n) { return n.kind === 'area'; }).map(function (n) { return n.label; });
      nodes.filter(function (n) { return n.kind === 'area' && n.text; }).forEach(function (n) {
        owners.forEach(function (o) {
          if (o === n.label) return;
          if (new RegExp('`?' + o.replace(/[-]/g, '\\-') + '`?').test(n.text)) {
            edges.push({ a: n.id, b: 'area-' + o, kind: 'dep' });
          }
        });
      });
      // 重名项目（两组「<机主>的git hub仓库」）：后面缀盘符区分，别让人看混
      var nameCount = {};
      nodes.filter(function (n) { return n.kind === 'project'; }).forEach(function (n) { nameCount[n.label] = (nameCount[n.label] || 0) + 1; });
      nodes.filter(function (n) { return n.kind === 'project' && nameCount[n.label] > 1; }).forEach(function (n) {
        n.label = n.label + '（' + (String(n.root).indexOf('E:') === 0 ? 'E 盘' : 'D 盘') + '）';
      });

      // 项目归属：登记表给了 owner ⇒ 直接连到 owner 的 area；没有才退回"正文里提到名字"的启发式
      var areaById = {};
      nodes.filter(function (n) { return n.kind === 'area'; }).forEach(function (n) { areaById[n.label] = n; });
      var regDone = {};
      nodes.filter(function (n) { return n.kind === 'project' && n.owner; }).forEach(function (n) {
        var target = areaById[n.owner] || null;
        edges.push({ a: target ? target.id : 'core', b: n.id, kind: 'project' });
        regDone[n.id] = 1;
      });

      // 项目归属（兜底）：某 area 正文里出现项目名 ⇒ 连到它；否则挂 core
      var areaNodes = nodes.filter(function (n) { return n.kind === 'area' && n.text; });
      nodes.filter(function (n) { return n.kind === 'project' && !regDone[n.id]; }).forEach(function (p) {
        var owner = null;
        for (var ai = 0; ai < areaNodes.length; ai++) {
          if (String(areaNodes[ai].text).indexOf(p.label) >= 0) { owner = areaNodes[ai]; break; }
        }
        edges.push({ a: owner ? owner.id : 'core', b: p.id, kind: 'project' });
      });
      nodes.forEach(function (n) { delete n.text; n.deg = 0; });
      var byId = {}; nodes.forEach(function (n) { byId[n.id] = n; });
    // 尺寸变了就重设位图（真机上 ResizeObserver 有时晚一拍）
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    }
      // 2026-10-27：边只留两端都真实存在的；悬空的丢掉并在头部报数（不再"悄悄算一条画不出来的线"）
      var nDangling = 0;
      edges = edges.filter(function (e) {
        if (byId[e.a] && byId[e.b]) return true;
        nDangling++;
        return false;
      });
      edges.forEach(function (e) { if (byId[e.b]) byId[e.b].deg++; if (byId[e.a]) byId[e.a].deg++; });
      layout();
      bornAt = performance.now();
      // 2026-10-27 审计③：17 个区域里有「宿主 / 全体场景」两个伪节点，不再叫"场景 17"
      var nArea = nodes.filter(function (n) { return n.kind === 'area'; }).length;
      var nPseudo = nodes.filter(function (n) { return n.kind === 'area' && /^(宿主|全体场景)$/.test(String(n.label)); }).length;
      var nChainN = nodes.filter(function (n) { return n.kind === 'chain'; }).length;
      var nMiss = nodes.filter(function (n) { return n.missing; }).length;
      // 2026-10-27（宿主：这段"看着太丑"）：不再拼一整句纯文本 —— 每项一个小段，整段不拆行；
      //   面板窄时按「·」整段换行（不会把「孤立 0」拆成「孤 / 立 0」），右侧按钮也不会被挤压成两行。
      var nSkillN = nodes.filter(function (n) { return n.kind === 'skill'; }).length;
      var nMemN = nodes.filter(function (n) { return n.kind === 'memory'; }).length;
      var nDocN = nodes.filter(function (n) { return n.kind === 'doc'; }).length;
      var nSrcN = nodes.filter(function (n) { return n.kind === 'source'; }).length;
      var nProjN = nodes.filter(function (n) { return n.kind === 'project'; }).length;
      var nAnchorN = nodes.filter(function (n) { return n.kind === 'chain'; }).reduce(function (a, n) { return a + (n.total || 0); }, 0);
      var nLoneN = nodes.filter(function (n) { return n.kind !== 'core' && !n.deg; }).length;
      var chips = [
        { t: '区域 ' + nArea + '（' + (nArea - nPseudo) + ' 场景 + 宿主 + 全体）' },
        { t: '技能 ' + nSkillN },
        { t: '私有记忆 ' + nMemN },
        { t: '共享 ' + nDocN },
        { t: '数据源 ' + nSrcN },
        { t: '提交链 ' + nChainN + ' 文件 / ' + nAnchorN + ' 锚点' },
        { t: '项目 ' + nProjN },
        { t: '连线 ' + edges.length },
        { t: '孤立 ' + nLoneN, cls: nLoneN ? ' bad' : '' }
      ];
      if (nDangling) chips.push({ t: '⛔ 悬空边 ' + nDangling, cls: ' bad' });
      chips.push(nMiss ? { t: '⛔ 路径失效 ' + nMiss, cls: ' bad' } : { t: '路径全在', cls: ' ok' });
      stat.innerHTML = '';
      chips.forEach(function (c, ci) {
        if (ci) stat.appendChild(el('span', 'kneu-sep', '·'));
        stat.appendChild(el('span', 'kneu-seg' + (c.cls || ''), c.t));
      });
      stat.title = '数据源：引擎\\场景记忆\\_共享记忆（索引/项目/记忆地图/提交链）+ .dsh\\skills 目录'
        + ' · 核对时间 ' + new Date().toLocaleString('zh-CN', { hour12: false });
    }).catch(function (e) {
      stat.textContent = '读不到共享记忆：' + ((e && e.message) || e);
    });
  }

  // ---------- 3D 布置 ----------
  function layout() {
    var areas = nodes.filter(function (n) { return n.kind === 'area'; });
    var areaByLabel = {};
    areas.forEach(function (a) { areaByLabel[a.label] = a; });
    var skills = nodes.filter(function (n) { return n.kind === 'skill'; });
    var docs = nodes.filter(function (n) { return n.kind === 'doc'; });
    var projects = nodes.filter(function (n) { return n.kind === 'project'; });
    var mems = nodes.filter(function (n) { return n.kind === 'memory'; });
    var srcs = nodes.filter(function (n) { return n.kind === 'source'; });
    var chains = nodes.filter(function (n) { return n.kind === 'chain'; });
    var R1 = 430, R2 = 700, R0 = 150;
    areas.forEach(function (n, i) {
      var t = (i / Math.max(1, areas.length)) * Math.PI * 2;
      var ring = (i % 2 === 0) ? 1 : 0.86;                 // 错开两层，看起来像神经元簇
      n.x = Math.cos(t) * R1 * ring;
      n.y = Math.sin(t * 2) * 52 * ring;                    // 上下起伏，避免一张平面
      n.z = Math.sin(t) * R1 * ring;
      n.r = 9 + Math.min(9, Math.sqrt(n.size / 700));
    });
    // 技能：仍在外圈（两条壳）——标签要铺开才读得清；归属靠连线（→ owner 场景）
    skills.forEach(function (n, i) {
      n.r = 5 + Math.min(4, Math.sqrt(n.size / 2200));
      var t = (i / Math.max(1, skills.length)) * Math.PI * 2 + 0.5;
      var ring = (i % 2 === 0) ? 1 : 0.8;
      n.x = Math.cos(t) * R2 * ring;
      n.y = Math.cos(t * 1.7) * 210 + (i % 2 ? 46 : -46);
      n.z = Math.sin(t) * R2 * ring;
    });
    // 数据源：内核外面一小圈（靠里，表示"我的家底"）
    srcs.forEach(function (n, i) {
      var t = (i / Math.max(1, srcs.length)) * Math.PI * 2 + 0.2;
      var rr = 168;
      n.x = Math.cos(t) * rr; n.z = Math.sin(t) * rr; n.y = (i % 2 ? 14 : -14);
      n.r = 5.2;
    });

    // 提交链：再外一圈（1.52 倍、反向偏角），像"笔记外面的年表"
    chains.forEach(function (n) {
      var own = areaByLabel[n.panel];
      if (!own) return;
      var ang = Math.atan2(own.z, own.x) - 0.13;
      var rad = Math.hypot(own.x, own.z) * 1.52;
      n.x = Math.cos(ang) * rad; n.z = Math.sin(ang) * rad;
      n.y = own.y - 22; n.r = 4.4;
    });

    // 私有记忆：贴在场景**外侧**（1.34 倍、同角度偏一点），像场景的"随身笔记"
    mems.forEach(function (n, i) {
      var own = areaByLabel[n.ownerPanel];
      if (!own) return;
      var ang = Math.atan2(own.z, own.x) + 0.11;
      var rad = Math.hypot(own.x, own.z) * 1.34;
      n.x = Math.cos(ang) * rad; n.z = Math.sin(ang) * rad;
      n.y = own.y + 26; n.r = 4.6;
    });

    // 2026-10-26：项目不再是"一圈"，而是**贴着它的 owner 场景**摆（径向 0.6 倍、同角度）⇒ 一眼看出"这项目归谁"
    projects.forEach(function (n, i) {
      var own = n.owner ? areaByLabel[n.owner] : null;
      if (own) {
        var ang = Math.atan2(own.z, own.x);
        var rad = Math.hypot(own.x, own.z) * 0.72 + (i % 2 ? 22 : -22);
        n.x = Math.cos(ang) * rad + Math.cos(ang + 1.57) * ((i % 2 ? 14 : -14));
        n.z = Math.sin(ang) * rad + Math.sin(ang + 1.57) * ((i % 2 ? 14 : -14));
        n.y = own.y * 0.5 + (i % 2 ? 10 : -10);
      } else {
        var t = (i / Math.max(1, projects.length)) * Math.PI * 2 + 0.32;
        var rp = 168 + (i % 2 ? 16 : 0);
        n.x = Math.cos(t) * rp; n.y = Math.sin(t * 1.4) * 34; n.z = Math.sin(t) * rp;
      }
      n.r = 5.4;
    });
    docs.forEach(function (n, i) {
      var t = [0, 2.1, 4.2][i % 3];
      n.x = Math.cos(t) * R0; n.y = Math.sin(t) * 30; n.z = Math.sin(t) * R0; n.r = 8;
    });
    nodes.filter(function (n) { return n.kind === 'core'; }).forEach(function (n) { n.x = 0; n.y = 0; n.z = 0; });
  }

  // ---------- 画布 ----------
  function fit() {
    dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    var rect = body.getBoundingClientRect();
    // 2026-10-26 真机排查：面板刚建时 rect 可能是 0 ⇒ 先看 clientWidth/Height，还是 0 就下一帧再量
    var cw = body.clientWidth || 0, ch = body.clientHeight || 0;
    var w0 = Math.round(rect.width) || cw, h0 = Math.round(rect.height) || ch;
    if (!w0 || !h0) {
      if (!fit._tries) fit._tries = 0;
      if (fit._tries++ < 60 && !disposed) requestAnimationFrame(fit);
      w0 = w0 || W || 320; h0 = h0 || H || 240;
    } else fit._tries = 0;
    W = Math.max(320, w0);
    H = Math.max(240, h0);
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    makeStars();
  }
  function project(n) {
    var cy = Math.cos(ry), sy = Math.sin(ry);
    var x1 = n.x * cy - n.z * sy;
    var z1 = n.x * sy + n.z * cy;
    var cx0 = Math.cos(rx), sx0 = Math.sin(rx);
    var y1 = n.y * cx0 - z1 * sx0;
    var z2 = n.y * sx0 + z1 * cx0;
    var f = 820;
    var s = (f / (f + z2 + 420)) * zoom;
    return { x: W / 2 + x1 * s, y: H / 2 + y1 * s, s: s, z: z2 };
  }
  function draw() {
    var ctx = cv.getContext('2d');
    try { drawInner(ctx); } catch (e) {
      try {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, W, H);
        ctx.font = '700 15px Consolas, monospace';
        ctx.fillStyle = '#ff4d6d';
        ctx.textAlign = 'left';
        ctx.fillText('neuron 绘制出错：' + ((e && e.message) || e), 16, 60);
      } catch (e2) { /* ignore */ }
    }
  }
  function drawInner(ctx) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    // 背景：中心微光
    var bg = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.62);
    bg.addColorStop(0, 'rgba(30,54,96,.55)');
    bg.addColorStop(1, 'rgba(6,9,16,0)');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    var tt = fx ? (performance.now() / 1000) : 0;
    // 星点（有动效时轻微明暗呼吸，静止时一片星空）
    if (stars.length) {
      for (var si = 0; si < stars.length; si++) {
        var st = stars[si];
        var tw = fx ? (0.35 + 0.65 * (0.5 + 0.5 * Math.sin(tt * st.sp + st.ph))) : 0.55;
        ctx.beginPath();
        ctx.arc(st.x, st.y, st.r, 0, 6.2832);
        ctx.fillStyle = 'rgba(190,215,255,' + (0.07 * tw) + ')';
        ctx.fill();
      }
    }
    // 暗角：把注意力收到中间
    var vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.32, W / 2, H / 2, Math.max(W, H) * 0.78);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(2,4,9,.55)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);

    // ══ 入场动画（2026-10-27 科幻版）══
    //   节拍：核心点火(0~0.3s) → 冲击波+扫描线(0.15~1.1s) → 连线逐条生长(0.26~1.9s) → 节点被依次点亮(0.26~1.8s) → 余晖淡出
    //   全程一次（2.4s），只在 fx 开着时跑；跑完所有进度=1，完全退回原来的静态渲染路径。
    var INTRO = 2400;
    var animOn = fx || introBoot;                                          // 动效关也允许"重读"重播一次
    var ei = animOn ? Math.max(0, performance.now() - (bornAt || 0)) : INTRO; // 已进入的毫秒数
    if (introBoot && ei > INTRO + 400) introBoot = false;                   // 只播一次，播完自动熄
    var eo = 1 - Math.pow(1 - Math.min(1, ei / INTRO), 3);                  // easeOutCubic：先快后慢
    var introOn = animOn && ei < INTRO + 400;
    var kk = 0.86 + 0.14 * eo;                                              // 位置只从 86% 展开，主要靠"生长"而不是"炸开"
    var D2C = Math.hypot(W, H) * 0.5 || 1;                                  // 画面中心 → 角的距离
    function waveT(norm) { return 260 + norm * 1150; }                      // 冲击波到达某处的时间
    function nodeNorm(n) {
      var qq = project(n);
      return Math.min(1, Math.hypot(qq.x - W / 2, qq.y - H / 2) / D2C);
    }
    function P(n) {
      var pp = project(n);
      if (kk < 0.999) { pp.x = W / 2 + (pp.x - W / 2) * kk; pp.y = H / 2 + (pp.y - H / 2) * kk; }
      return pp;
    }

    var byId = {}; nodes.forEach(function (n) { byId[n.id] = n; });
    var selN = sel ? byId[sel] : null;
    var hoverN = hover ? byId[hover] : null;
    var neigh = {};
    if (hoverN) {
      neigh[hoverN.id] = true;
      edges.forEach(function (e) {
        if (e.a === hoverN.id) neigh[e.b] = true;
        if (e.b === hoverN.id) neigh[e.a] = true;
      });
    }
    function dimmed(n) {
      if (q) {
        var hay = (n.id + ' ' + (n.label || '') + ' ' + (n.title || '') + ' ' + (n.region || '') + ' ' + (n.path || '')).toLowerCase();
        if (hay.indexOf(q) < 0 && n.kind !== 'core') return true;
      }
      if (hoverN) return !neigh[n.id];
      return false;
    }
    // 只看记忆：留下的种类（内核/场景/私有记忆/提交链/共享文档）
    var MEM_KINDS = { core: 1, area: 1, memory: 1, chain: 1, doc: 1 };
    function keep(n) { return !onlyMem || !!MEM_KINDS[n.kind]; }
    function col(group) { return COLOR[group] || '#94a3b8'; }
    function safeR(n, ps) { var r = n.r * ps; return (isFinite(r) && r > 0) ? Math.max(1.6, r) : 1.6; }

    // 先画线（远的先画）
    var segs = edges.map(function (e) {
      var a = byId[e.a], b = byId[e.b];
      if (!a || !b) return null;
      if (!keep(a) || !keep(b)) return null;
      var pa = P(a), pb = P(b);
      return { e: e, a: a, b: b, pa: pa, pb: pb, z: (pa.z + pb.z) / 2 };
    }).filter(Boolean).sort(function (x, y) { return y.z - x.z; });
    segs.forEach(function (s) {
      var hot = hoverN && (s.e.a === hoverN.id || s.e.b === hoverN.id);
      var active = selN && (s.e.a === selN.id || s.e.b === selN.id);
      // 入场：这条线什么时候开始长（按边中点离中心远近，像冲击波扫过去），长 520ms，从 a 端推向 b 端
      var gp = 1;
      if (introOn) {
        var mx = (s.pa.x + s.pb.x) / 2 - W / 2, my = (s.pa.y + s.pb.y) / 2 - H / 2;
        var mn = Math.min(1, Math.hypot(mx, my) / D2C);
        var gt = (ei - waveT(mn)) / 520;
        gp = gt <= 0 ? 0 : (gt >= 1 ? 1 : 1 - Math.pow(1 - gt, 3));
        if (gp <= 0) return;                       // 还没轮到这个方向
      }
      var alpha = (hot ? 0.55 : (active ? 0.4 : Math.max(0.05, 0.22 - s.z / 2600))) * (fx ? (0.5 + 0.5 * eo) : 1);
      if (introOn) alpha *= 0.35 + 0.65 * gp;
      if (s.e.kind === 'skill') alpha *= 0.55;
      if (dimmed(s.a) && dimmed(s.b)) alpha *= 0.25;
      // 线的颜色按类型分（记忆=近白、项目=青、依赖=青蓝、其余=蓝），一眼能分出关系
      var lc = (s.e.kind === 'memory') ? '223,231,255'
        : (s.e.kind === 'project') ? '45,212,191'
        : (s.e.kind === 'dep') ? '127,227,255' : '143,180,255';
      var core = hot ? 1.7 : (s.e.kind === 'dep' ? 1.15 : 0.85);
      var ex2 = s.pb.x, ey2 = s.pb.y;
      if (gp < 1) { ex2 = s.pa.x + (s.pb.x - s.pa.x) * gp; ey2 = s.pa.y + (s.pb.y - s.pa.y) * gp; }
      ctx.beginPath();
      ctx.moveTo(s.pa.x, s.pa.y);
      ctx.lineTo(ex2, ey2);
      if (fx && (hot || active)) {              // 悬停/选中：跑虚线流光
        ctx.setLineDash([5, 6]);
        ctx.lineDashOffset = -(tt * 26) % 11;
      }
      if (fx) {                                 // 霓虹光晕（宽、淡）
        ctx.strokeStyle = 'rgba(' + lc + ',' + (alpha * 0.17) + ')';
        ctx.lineWidth = core * 2.8;
        ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(' + lc + ',' + alpha + ')';
      ctx.lineWidth = core;
      ctx.stroke();
      ctx.setLineDash([]);
      if (introOn && gp < 1) {                     // 生长头：亮点把线"推"出来
        ctx.beginPath();
        ctx.arc(ex2, ey2, 2.4 + 1.8 * (1 - gp), 0, 6.2832);
        ctx.fillStyle = 'rgba(214,242,255,' + (0.55 + 0.4 * (1 - gp)) + ')';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(ex2, ey2, 7 + 9 * (1 - gp), 0, 6.2832);
        ctx.fillStyle = 'rgba(120,200,255,' + (0.22 * (1 - gp)) + ')';
        ctx.fill();
      }
    });

    // 扫描光（高级感的关键：一次只有一条边在走，不抢戏）
    if (fx && segs.length && kk > 0.9) {
      var CYC = 2.4;
      var slot = Math.floor(tt / CYC);
      var sg2 = segs[slot % segs.length];
      if (sg2 && !dimmed(sg2.a) && !dimmed(sg2.b)) {
        var run2 = (tt % CYC) / CYC;
        var fade = Math.sin(Math.PI * run2);
        var ddx = sg2.pb.x - sg2.pa.x, ddy = sg2.pb.y - sg2.pa.y;
        var hx2 = sg2.pa.x + ddx * run2, hy2 = sg2.pa.y + ddy * run2;
        for (var t2 = 0; t2 < 6; t2++) {
          var q2 = Math.max(0, run2 - t2 * 0.022);
          var x2 = sg2.pa.x + ddx * q2, y2 = sg2.pa.y + ddy * q2;
          ctx.beginPath();
          ctx.arc(x2, y2, 1.5 - t2 * 0.16, 0, 6.2832);
          ctx.fillStyle = 'rgba(215,235,255,' + (0.5 * fade * (1 - t2 / 6)) + ')';
          ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(hx2, hy2, 2.2, 0, 6.2832);
        ctx.fillStyle = 'rgba(240,248,255,' + (0.85 * fade) + ')';
        ctx.fill();
      }
    }

    // 入场专属特效（只在前 2.8 秒，跑完这段画面回到原来的样子）
    if (introOn) {
      var cx0 = W / 2, cy0 = H / 2;
      var maxR = Math.hypot(W, H) * 0.62;
      // ① 核心点火闪光（前 320ms）
      if (ei < 320) {
        var fl = 1 - ei / 320;
        var fg = ctx.createRadialGradient(cx0, cy0, 0, cx0, cy0, 90 + 130 * fl);
        fg.addColorStop(0, 'rgba(224,246,255,' + (0.45 * fl) + ')');
        fg.addColorStop(0.4, 'rgba(110,200,255,' + (0.2 * fl) + ')');
        fg.addColorStop(1, 'rgba(80,170,255,0)');
        ctx.fillStyle = fg;
        ctx.fillRect(0, 0, W, H);
      }
      // ② 两层冲击波（错开 180ms，从核心向外扩散、变淡变细）
      for (var wi = 0; wi < 2; wi++) {
        var wt = (ei - wi * 180) / 1100;
        if (wt > 0 && wt < 1) {
          var wr = maxR * (1 - Math.pow(1 - wt, 2.2));
          ctx.beginPath();
          ctx.arc(cx0, cy0, wr, 0, 6.2832);
          ctx.lineWidth = 2.4 - 1.4 * wt;
          ctx.strokeStyle = 'rgba(130,214,255,' + (0.34 * (1 - wt) * (1 - wt)) + ')';
          ctx.stroke();
        }
      }
      // ③ 扫描线：一次从上往下抹过（0.15~1.0s），像雷达扫过整片星图
      var sc = (ei - 150) / 850;
      if (sc > 0 && sc < 1) {
        var sy = H * (sc * sc * (3 - 2 * sc));
        var lg = ctx.createLinearGradient(0, sy - 90, 0, sy);
        lg.addColorStop(0, 'rgba(90,190,255,0)');
        lg.addColorStop(0.85, 'rgba(90,190,255,.055)');
        lg.addColorStop(1, 'rgba(180,232,255,.16)');
        ctx.fillStyle = lg;
        ctx.fillRect(0, sy - 90, W, 90);
        ctx.beginPath();
        ctx.moveTo(0, sy); ctx.lineTo(W, sy);
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(190,236,255,' + (0.22 * Math.sin(Math.PI * sc)) + ')';
        ctx.stroke();
      }
      // ④ 沿线奔跑的粒子：入场时 5 颗，错开时间，跑完就没了
      if (segs.length) {
        for (var pi2 = 0; pi2 < 5; pi2++) {
          var pr2 = ((ei / 900) + pi2 * 0.21) % 1;
          if (pr2 <= 0 || pr2 >= 1) continue;
          var s3 = segs[(pi2 * 7 + Math.floor(ei / 900)) % segs.length];
          if (!s3) continue;
          var hx3 = s3.pa.x + (s3.pb.x - s3.pa.x) * pr2;
          var hy3 = s3.pa.y + (s3.pb.y - s3.pa.y) * pr2;
          ctx.beginPath();
          ctx.arc(hx3, hy3, 1.8, 0, 6.2832);
          ctx.fillStyle = 'rgba(235,250,255,' + (0.55 * Math.sin(Math.PI * pr2)) + ')';
          ctx.fill();
        }
      }
    }

    var labelBoxes = [];
    // 再画节点（按深度排序）
    var list = nodes.filter(keep).map(function (n) { return { n: n, p: project(n) }; }).sort(function (a, b) { return a.p.z - b.p.z; });
    list.forEach(function (it) {
      var n = it.n, p = it.p;
      // 入场：节点等冲击波到达才亮（离中心越远越晚），亮的那一下带一圈扩散光环
      var np2 = 1, nring = 0;
      if (introOn) {
        var nt = (ei - waveT(nodeNorm(n))) / 420;
        np2 = nt <= 0 ? 0 : (nt >= 1 ? 1 : 1 - Math.pow(1 - nt, 3));
        if (np2 <= 0) return;
        nring = np2 < 1 ? (1 - np2) : 0;
      }
      var r = safeR(n, p.s) * (fx ? (0.55 + 0.45 * kk) : 1) * (introOn ? (0.5 + 0.5 * np2) : 1);

      var alpha = dimmed(n) ? 0.18 : Math.max(0.35, 1 - p.z / 1500);
      if (introOn) alpha *= 0.25 + 0.75 * np2;
      var c = col(n.group);
      if (n.kind === 'project') { if (n.status === 'delivery') c = '#f0a35e'; else if (n.status === 'archived' || n.status === 'parked') c = '#8b93a7'; }
      // 光晕
      var g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 3.4);
      g.addColorStop(0, hexA(c, 0.55 * alpha));
      g.addColorStop(0.45, hexA(c, 0.16 * alpha));
      g.addColorStop(1, hexA(c, 0));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(p.x, p.y, r * 3.4, 0, Math.PI * 2); ctx.fill();
      // 核：球面渐变（左上亮、右下暗）+ 细内描边
      var ng = ctx.createRadialGradient(p.x - r * 0.35, p.y - r * 0.38, r * 0.15, p.x, p.y, r * 1.15);
      ng.addColorStop(0, hexA('#ffffff', 0.55 * alpha));
      ng.addColorStop(0.35, hexA(c, 0.95 * alpha));
      ng.addColorStop(1, hexA(c, 0.72 * alpha));
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = ng;
      ctx.fill();
      ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(0.5, r - 0.6), 0, Math.PI * 2);
      ctx.lineWidth = 0.8;
      ctx.strokeStyle = hexA('#ffffff', 0.22 * alpha);
      ctx.stroke();
      // 高光：左上一点亮，球体感
      ctx.beginPath();
      ctx.arc(p.x - r * 0.32, p.y - r * 0.34, Math.max(0.9, r * 0.34), 0, 6.2832);
      ctx.fillStyle = 'rgba(255,255,255,' + (0.28 * alpha) + ')';
      ctx.fill();
      if (nring > 0) {                             // 点亮瞬间：一圈光环扩散出去
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 4 + 26 * (1 - nring), 0, 6.2832);
        ctx.lineWidth = 1.6;
        ctx.strokeStyle = hexA('#bfe8ff', 0.55 * nring);
        ctx.stroke();
      }
      if (n.missing) {                     // 2026-10-27 审计⑤：路径失效的点 → 红虚线圈
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 3.5, 0, 6.2832);
        ctx.setLineDash([2, 3]);
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = 'rgba(229,72,77,.8)';
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (n.kind === 'core') {
        ctx.lineWidth = 2; ctx.strokeStyle = hexA('#7fe3ff', 0.8); ctx.stroke();
      }
      if (n.kind === 'core' && fx) {       // 核心：缓慢旋转的细光环（全图唯一的常驻动效）
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(tt * 0.25);
        ctx.beginPath();
        ctx.setLineDash([3, 8]);
        ctx.arc(0, 0, r + 7, 0, 6.2832);
        ctx.lineWidth = 1.1;
        ctx.strokeStyle = hexA('#8fd7ff', 0.5);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }
      if (selN && n.id === selN.id) {     // 选中：外圈光环
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 5, 0, 6.2832);
        ctx.lineWidth = 1.4;
        ctx.strokeStyle = hexA('#cfe1ff', 0.75);
        ctx.stroke();
      }
      // 标签：内核 / 悬停 / 选中 / 搜索命中 / 大节点
      var show = false;
      if (labelMode === 2) show = n.kind === 'core' || (hoverN && n.id === hoverN.id) || (selN && n.id === selN.id);
      else if (labelMode === 1) show = true;
      else show = n.kind === 'core' || (hoverN && n.id === hoverN.id) || (selN && n.id === selN.id)
        || (q && !dimmed(n)) || (n.kind === 'area' && p.s > 0.55)
        || (n.kind === 'project' && (n.id === sel || n.id === hover || (p.s > 1.05 && n.deg > 0)));
      if (show) {
        var fsz = n.kind === 'core' ? 13 : (n.kind === 'area' ? 11 : (n.kind === 'project' ? 10 : 9));
        ctx.font = (n.kind === 'core' ? '700 13px' : (n.kind === 'area' ? '600 11px' : '500 ' + fsz + 'px')) + ' ui-sans-serif, "Microsoft YaHei", system-ui';
        var lbl = String(n.label || '');
        if (n.kind === 'skill' && lbl.length > 15) lbl = lbl.slice(0, 14) + '…';
        var tw = ctx.measureText(lbl).width;
        var force = (hoverN && n.id === hoverN.id) || (selN && n.id === selN.id) || (q && !dimmed(n));
        // 四向候选：上 → 下 → 右 → 左，挑第一个不撞的；都撞就照画（宿主：所有点都要有标签）
        // 记忆/链/数据源这类"卫星":先试右边（免得压住它贴着的主场景标签）；场景/项目先试上方
        var rightFirst = (n.kind === 'memory' || n.kind === 'chain' || n.kind === 'source');
        var cands = rightFirst
          ? [{ lx: p.x + r + 7, ly: p.y + 4, align: 'left' },
             { lx: p.x, ly: p.y - r - 7, align: 'center' },
             { lx: p.x, ly: p.y + r + 13, align: 'center' },
             { lx: p.x - r - 7, ly: p.y + 4, align: 'right' }]
          : [{ lx: p.x, ly: p.y - r - 7, align: 'center' },
             { lx: p.x, ly: p.y + r + 13, align: 'center' },
             { lx: p.x + r + 7, ly: p.y + 4, align: 'left' },
             { lx: p.x - r - 7, ly: p.y + 4, align: 'right' }];
        var pick = cands[0], clash = false;
        for (var ci = 0; ci < cands.length; ci++) {
          var cd = cands[ci];
          var x1 = cd.align === 'left' ? cd.lx : (cd.align === 'right' ? cd.lx - tw : cd.lx - tw / 2);
          var bx0 = { x1: x1 - 2, x2: x1 + tw + 2, y1: cd.ly - 10, y2: cd.ly + 3 };
          var hit2 = false;
          for (var bi = 0; bi < labelBoxes.length; bi++) {
            var bb = labelBoxes[bi];
            if (bx0.x1 < bb.x2 && bx0.x2 > bb.x1 && bx0.y1 < bb.y2 && bx0.y2 > bb.y1) { hit2 = true; break; }
          }
          if (!hit2) { pick = cd; clash = false; break; }
          pick = cd; clash = true;
        }
        var ly = pick.ly, alignMode = pick.align;
        var box = { x1: (alignMode === 'left' ? pick.lx : (alignMode === 'right' ? pick.lx - tw : pick.lx - tw / 2)) - 2,
                    x2: (alignMode === 'left' ? pick.lx + tw : (alignMode === 'right' ? pick.lx : pick.lx + tw / 2)) + 2,
                    y1: ly - 10, y2: ly + 3 };
        if (!clash || force || labelMode !== 2) {
          labelBoxes.push(box);
          // 底片：深色半透明圆角，压住后面的线和星点（"更清晰"主要靠它）
          var bx = box.x1 - 3, by = box.y1, bw = (box.x2 - box.x1) + 6, bh = (box.y2 - box.y1) + 1;
          ctx.beginPath();
          if (ctx.roundRect) { ctx.roundRect(bx, by, bw, bh, 4); }
          else { ctx.rect(bx, by, bw, bh); }
          ctx.fillStyle = 'rgba(6,10,18,' + (force ? 0.62 : 0.34) + ')';
          ctx.fill();
          ctx.fillStyle = dimmed(n) ? 'rgba(200,215,240,.35)' : 'rgba(226,236,255,.92)';
          ctx.fillStyle = force ? '#eaf2ff' : ctx.fillStyle;
          ctx.textAlign = alignMode;
          ctx.fillText(lbl, pick.lx, ly);
        }
      }
    });
  }
  function hexA(hex, a) {
    var h = hex.replace('#', '');
    var r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }

  function loop(t) {
    if (disposed) return;
    if (auto && !document.hidden) { ry += 0.0032; }
    draw();
    raf = requestAnimationFrame(loop);
  }

  // ---------- 交互 ----------
  let drag = null;
  function pos(ev) {
    var r = cv.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }
  function pick(mx, my) {
    var best = null, bestD = 1e9;
    nodes.forEach(function (n) {
      var p = project(n);
      var rr = Math.max(6, n.r * p.s) + 6;
      var d = Math.hypot(p.x - mx, p.y - my);
      if (d < rr && d < bestD) { bestD = d; best = n; }
    });
    return best;
  }
  function onDown(ev) {
    drag = { x: ev.clientX, y: ev.clientY, ry: ry, rx: rx, moved: false };
    cv.setPointerCapture && cv.setPointerCapture(ev.pointerId);
  }
  function onMove(ev) {
    var p = pos(ev);
    if (drag) {
      var dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      ry = drag.ry + dx * 0.006;
      rx = Math.max(-1.1, Math.min(1.1, drag.rx + dy * 0.005));
      return;
    }
    var n = pick(p.x, p.y);
    hover = n ? n.id : null;
    cv.style.cursor = n ? 'pointer' : 'grab';
  }
  function onUp(ev) {
    var wasDrag = drag && drag.moved;
    drag = null;
    if (wasDrag) return;
    var p = pos(ev);
    var n = pick(p.x, p.y);
    sel = n ? n.id : null;
    showDetail(n);
  }
  function onWheel(ev) {
    ev.preventDefault();
    zoom = Math.max(0.35, Math.min(9, zoom * (ev.deltaY > 0 ? 0.92 : 1.08)));
  }
  // 2026-10-27 审计⑤：点击/定位统一入口 —— 文件→预览面板，目录→资源管理器，失败退回系统打开
  function openNode(n) {
    var p = n && (n.path || (n.paths && n.paths[0]));
    if (!p) { stat.textContent = '这个节点没有路径'; return; }
    var APP = (window.app && window.app.app) || null;
    var isDir = !!n.isDir || /[\\/]$/.test(p) || !/\.[A-Za-z0-9]{1,6}$/.test(p);
    if (n.missing) stat.textContent = '⛔ 这个路径不存在：' + p;
    if (isDir) {
      if (APP && APP.openPath) {
        Promise.resolve(APP.openPath(p)).then(function (r) { if (r && r.ok === false) stat.textContent = '打不开：' + (r.error || ''); });
        return;
      }
    }
    if (OPEN) {
      Promise.resolve(OPEN(p)).then(function (r) {
        if (r && r.ok === false) {
          if (APP && APP.openPath) Promise.resolve(APP.openPath(p)).then(function (r2) { if (r2 && r2.ok === false) stat.textContent = '打不开：' + (r2.error || ''); });
          else stat.textContent = '打不开：' + (r.error || '');
        }
      });
      return;
    }
    if (APP && APP.openPath) { Promise.resolve(APP.openPath(p)); return; }
    stat.textContent = '这个版本没有打开通道';
  }

  function showDetail(n) {
    if (!n) { detail.classList.remove('on'); return; }
    detail.innerHTML = '';
    var t = el('div', 'kneu-dt', n.label + (n.title ? (' · ' + n.title) : ''));
    detail.appendChild(t);
    if (n.region) detail.appendChild(el('div', 'kneu-ds', n.region));
    if (n.owner) detail.appendChild(el('div', 'kneu-ds', '归属：' + n.owner + (n.status && n.status !== 'active' ? (' · 状态：' + n.status) : '')));
    (n.paths && n.paths.length ? n.paths : [n.path]).filter(Boolean).forEach(function (pp) {
      detail.appendChild(el('div', 'kneu-dp', pp));
    });
    if (n.aliases && n.aliases.length) detail.appendChild(el('div', 'kneu-ds', '别名：' + n.aliases.join(' / ')));
    if (n.kind === 'chain' && n.recent && n.recent.length) {
      detail.appendChild(el('div', 'kneu-ds', '共 ' + n.total + ' 段 · 最近：'));
      n.recent.forEach(function (e) {
        detail.appendChild(el('div', 'kneu-dp', e.coord + '  ' + String(e.title || '').slice(0, 26)));
      });
    }
    if (n.dsInfo) {
      if (n.dsInfo.count) detail.appendChild(el('div', 'kneu-ds', '数量：' + n.dsInfo.count));
      if (n.dsInfo.caveat) detail.appendChild(el('div', 'kneu-ds', '说明：' + n.dsInfo.caveat));
      if (n.dsInfo.index) detail.appendChild(el('div', 'kneu-dp', n.dsInfo.index));
    }
    if (n.isDir) detail.appendChild(el('div', 'kneu-ds', '（目录 · 里面按主题分文件）'));
    else if (n.size) detail.appendChild(el('div', 'kneu-ds', '约 ' + (n.size > 1024 ? (n.size / 1024).toFixed(1) + ' KB' : n.size + ' 字节')));
    if (n.missing) detail.appendChild(el('div', 'kneu-ds', '⛔ 文件不存在（路径已失效）：' + (n.path || '')));
    // 关系（2026-10-27 审计⑤：边原来只有颜色，这里写清"这条线是什么意思"）
    var relMap = {};
    var byIdD = {};
    nodes.forEach(function (x) { byIdD[x.id] = x; });
    edges.forEach(function (e2) {
      if (e2.a !== n.id && e2.b !== n.id) return;
      var o = byIdD[(e2.a === n.id) ? e2.b : e2.a];
      if (!o) return;
      var k = EDGE_LABEL[e2.kind] || e2.kind;
      (relMap[k] = relMap[k] || []).push(o.label);
    });
    Object.keys(relMap).forEach(function (k) {
      detail.appendChild(el('div', 'kneu-ds', k + '（' + relMap[k].length + '）：' + relMap[k].slice(0, 6).join('、') + (relMap[k].length > 6 ? ' …' : '')));
    });
    var row = el('div', 'kneu-drow');
    var bOpen = el('button', 'kneu-btn', n.isDir ? '📂 打开目录' : '📂 打开文件');
    bOpen.type = 'button';
    bOpen.addEventListener('click', function (ev) { ev.stopPropagation(); openNode(n); });
    var bReveal = el('button', 'kneu-btn', '🗂 资源管理器定位');
    bReveal.type = 'button';
    bReveal.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var APP = (window.app && window.app.app) || null;
      var p2 = n.path || (n.paths && n.paths[0]);
      if (!p2) { stat.textContent = '这个节点没有路径'; return; }
      if (APP && APP.revealPath) Promise.resolve(APP.revealPath(p2)).then(function (r) { if (r && r.ok === false) stat.textContent = '定位失败：' + (r.error || ''); });
      else stat.textContent = '这个版本没有定位通道';
    });
    var bCopy = el('button', 'kneu-btn', '⧉ 复制路径');
    bCopy.type = 'button';
    bCopy.addEventListener('click', function (ev) {
      ev.stopPropagation();
      try { navigator.clipboard.writeText(n.path || ''); bCopy.textContent = '✓ 已复制'; } catch (e) { /* ignore */ }
    });
    row.appendChild(bOpen); row.appendChild(bReveal); row.appendChild(bCopy);
    detail.appendChild(row);
    detail.classList.add('on');
  }

  bRot.addEventListener('click', function () {
    auto = !auto;
    bRot.classList.toggle('on', auto);
  });
  bReset.addEventListener('click', function () {
    ry = -0.35; rx = 0.18; zoom = 1.42; sel = null; hover = null; detail.classList.remove('on');
  });
  bReload.addEventListener('click', function () {
    introBoot = true;                 // 2026-10-27：重读 = 重读数据 + 重播一次入场动画
    bornAt = performance.now();
    load();
  });
  var statAll = '';   // 全量统计文案（切回时还原）
  bMem.addEventListener('click', function () {
    onlyMem = !onlyMem;
    bMem.textContent = onlyMem ? '只看记忆 ✓' : '只看记忆';
    bMem.classList.toggle('on', onlyMem);
    if (onlyMem) {
      statAll = stat.textContent;
      var c = { area: 0, memory: 0, chain: 0, doc: 0, chainSeg: 0 };
      nodes.forEach(function (n) {
        if (n.kind === 'area') c.area++;
        else if (n.kind === 'memory') c.memory++;
        else if (n.kind === 'chain') { c.chain++; c.chainSeg += (n.total || 0); }
        else if (n.kind === 'doc') c.doc++;
      });
      stat.textContent = '只看记忆 · 场景 ' + c.area + ' · 私有记忆 ' + c.memory + ' · 提交链 ' + c.chain + ' 条/' + c.chainSeg + ' 段 · 共享 ' + c.doc;
    } else if (statAll) {
      stat.textContent = statAll;
    }
  });
  bFx.addEventListener('click', function () {
    fx = !fx;
    bFx.textContent = '动效：' + (fx ? '开' : '关');
    bFx.classList.toggle('on', fx);
  });
  bFx.classList.toggle('on', fx);
  bLabel.addEventListener('click', function () {
    labelMode = (labelMode + 1) % 3;
    bLabel.textContent = '标签：' + ['自动', '全部', '关'][labelMode];
  });
  search.addEventListener('input', function () { q = String(search.value || '').trim().toLowerCase(); });
  cv.addEventListener('pointerdown', onDown);
  cv.addEventListener('pointermove', onMove);
  cv.addEventListener('pointerup', onUp);
  cv.addEventListener('pointerleave', function () { hover = null; });
  cv.addEventListener('wheel', onWheel, { passive: false });
  bRot.classList.toggle('on', auto);

  var ro = null;
  try {
    ro = new ResizeObserver(function () { fit(); });
    ro.observe(body);
  } catch (e) { /* 老内核没有 ResizeObserver */ }
  fit();
  load();
  raf = requestAnimationFrame(loop);

  delete body.dataset.neuronDone;
  return function cleanup() {
    disposed = true;
    if (raf) cancelAnimationFrame(raf);
    if (ro) { try { ro.disconnect(); } catch (e) { /* ignore */ } }
    cv.removeEventListener('pointerdown', onDown);
    cv.removeEventListener('pointermove', onMove);
    cv.removeEventListener('pointerup', onUp);
    cv.removeEventListener('wheel', onWheel);
    body.innerHTML = '';
  };
};

