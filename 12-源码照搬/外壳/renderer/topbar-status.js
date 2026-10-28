/* topbar-status.js —— 顶栏右侧「状态区」v2（2026-10-16；纯增量，一个现有按钮都不动）
 * 2026-10-26：新场景「命令」（command）已建：左窗 3D 记忆神经元 + 右窄 AI 会话。
 * 2026-10-26：新增场景「工作台定制」（workbench-custom）的标签图标已加进 renderer.js 的 ICONS
 *            与 renderers.js 的 SCENARIO_ICONS（同一份 SVG，改一处必须同步另一处）。
 *
 *   [ 🛡 快照 ]  [ 🔔 谁在等我 ]  [ ● 压力 ]  [ ⋯ 更多 ]
 *     · 快照：立即打一份源码快照 / 列最近快照 + 一键回滚（回滚前弹原生确认框）
 *     · 谁在等我：共用定位卡 §六 未办结行 + 各场景记忆的「卡点」，说人话版
 *     · 压力：工作台各会话的上下文用量（全中文，不用术语）
 *     · ⋯ 更多：磁盘余量 / 今天体检 / 搜文件脚本 / 打开常用文件夹
 *
 * 位置：**最右边** —— 插进 .titlebar-controls（窗口按钮那一簇）里、`─ □ ✕` 前面。
 * 数据：window.app.topbar.*（压力/待办/快照，走主进程 IPC）+ 复用已有的 app.sys.disks / app.file.read / app.app.*
 * 生效：只改本文件与 styles.css ⇒ 跑 `刷新面板.mjs all` 即热更新，**不用重启**。
 */
(function () {
  'use strict';
  if (window.__dshTopbarStatus) return;
  window.__dshTopbarStatus = true;
  var K = window.app || {};
  var TB = K.topbar || null;
  if (!TB) return;                 // 老宿主没有这组 IPC ⇒ 整个状态区不显示（同 btn-flow-pin 的做法）

  // 2026-10-24（宿主：升级中途关掉要能自动回滚）——
  //   主进程的"启动保险"发现自己上次没正常退出 + 引擎起不来时，会自动回退并推一条 topbar:toast 过来。
  //   这里把它接到界面自己的 toast 上（onToast 只注册一次：本文件被 ⟳ 重跑多少遍都不会叠加监听）。
  try {
    if (typeof TB.onToast === 'function' && !window.__tbToastBound) {
      window.__tbToastBound = true;
      TB.onToast(function (v) {
        if (!v || !v.text) return;
        try { toast(v.text, !!v.bad, v.ms || 12000); } catch (e) { /* ignore */ }
      });
    }
  } catch (e) { /* 老宿主没有这个通道 */ }

  // ROOT 以前写死旧根 `<工作台>` ✗ —— 换根（2026-10-16 预告 → `<工作台>`）就会失效。
  // 现在**从页面自身路径推导**（本文件由 `外壳\renderer\index.html` 加载 ⇒ location 里就带着真根），字面量只作兜底。
  var ROOT = (function () {
    try {
      var p = decodeURIComponent(String(location.pathname || '')).replace(/^\//, '').replace(/\//g, '\\');
      var m = p.match(/^(.*)\\外壳\\renderer\\/i);
      if (m && m[1]) return m[1];
    } catch (e) { /* ignore */ }
    return '<工作台>';   // 兜底：搬家脚本会改写这一行
  })();
  var INDEX_FILES = [
    { label: '场景身份索引', file: ROOT + '\\外壳\\scenarios\\_场景身份索引.md' },
    { label: '记忆总索引', file: ROOT + '\\引擎数据\\.dsh\\场景记忆\\_总索引.md' },
    { label: '跨场景通知', file: ROOT + '\\引擎数据\\.dsh\\场景记忆\\_共享记忆\\_跨场景通知.md' }
  ];
  // 常用文件夹（2026-10-21 宿主亲口指定的 6 个 + 2026-10-27 宿主加的第 7 个 `<工作台>`，别自作主张改）：
  //   1 <资料库>  2 <视频工作流>  3 <视频素材>
  //   4 <素材库>  5 <成品库>  6 <工作台>  7 <工作台>
  // 注意 4 和 5 只差一个逗号（收录素材那个带逗号、成品那个不带），照抄，别"顺手统一"。
  var FOLDERS = [    { label: '工作台目录', p: '<盘根>:\\客户工作台\\<客户>' },
    { label: '本机 D 盘', p: '<盘根>:\\' },
    { label: '桌面', p: '<用户目录>\\Public\\Desktop' },
    { label: '文档', p: '<用户目录>\\Public\\Documents' }
  ];

  // ---------------------------------------------------------------- 小工具
  function el(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  }
  // 大数字说人话：791k → 79.1万
  function humans(n) {
    if (!n) return '0';
    if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + '万';
    if (n >= 1000) return Math.round(n / 1000) + 'k';
    return String(n);
  }
  function gb(n) { return n >= 1073741824 ? (n / 1073741824).toFixed(0) + ' GB' : Math.round(n / 1048576) + ' MB'; }
  function tstr(ms) {
    if (!ms) return '';
    var d = new Date(ms), p = function (x) { return (x < 10 ? '0' : '') + x; };
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function today() {
    var d = new Date(), p = function (x) { return (x < 10 ? '0' : '') + x; };
    return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
  }
  // 把工程话翻译成人话
  function plainFrom(s) {
    if (!s) return '?';
    if (s.indexOf('界面侧') === 0) return '界面侧（就是这边）';
    if (s.indexOf('引擎侧') === 0) return '引擎侧（管底层的会话）';
    return s;
  }
  function plainStatus(s) {
    var m = { '待评估': '还没定', '待界面侧评估': '等你这边定', '待引擎侧确认': '等引擎侧定', '卡点': '卡住了' };
    return m[s] || s || '';
  }
  // 一句话摘要：去掉 markdown 记号与路径，取第一个句号/分号之前
  function brief(s, max) {
    var t = String(s || '').replace(/`/g, '').replace(/\*\*/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    t = t.replace(/[A-Za-z]:\\[^\s，。；、）]*/g, '（路径）').replace(/\s+/g, ' ').trim();
    var cut = t.split(/[。；]/)[0];
    if (cut.length > (max || 46)) cut = cut.slice(0, max || 46) + '…';
    return cut;
  }
  function shortName(x) {
    var n = (x.panel || x.title || x.scene || '会话').replace(/^AI[·.、]?/, '').replace(/^AI /, '');
    return n.length > 9 ? n.slice(0, 9) + '…' : n;
  }

  var pop = null;
  function closePop() {
    if (pop) { pop.remove(); pop = null; }
    document.removeEventListener('mousedown', docDown, true);
  }
  function docDown(e) {
    if (!pop) return;
    if (pop.contains(e.target)) return;
    if (e.target.closest && e.target.closest('.tbs-pill')) return;
    closePop();
  }
  function openPop(anchor, kind, build) {
    if (pop && pop.dataset.kind === kind) { closePop(); return; }
    closePop();
    pop = el('div', 'tbs-pop');
    pop.dataset.kind = kind;
    build(pop);
    document.body.appendChild(pop);
    var r = anchor.getBoundingClientRect(), w = pop.offsetWidth;
    pop.style.top = Math.round(r.bottom + 6) + 'px';
    // 锚点在右上角 ⇒ 靠右对齐，且不越出窗口
    pop.style.left = Math.round(Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))) + 'px';
    setTimeout(function () { document.addEventListener('mousedown', docDown, true); }, 0);
  }
  function repaint(kind, build) { if (pop && pop.dataset.kind === kind) { pop.innerHTML = ''; build(pop); } }
  // 2026-10-19：【修「助手折叠点不动」】助手/快照现在有两个落点 —— 自己的弹层（kind='helpers'/'snaps'）
  //   或 ⋯ 菜单里（kind='more'）。原来的 repaint(kind) 在 ⋯ 里 kind 不匹配 ⇒ 什么都不做 ⇒ 看着像卡住。
  //   统一走这两个分发器：**不管挂在哪都重绘**，并保持滚动位置（不然一折叠就跳回顶部）。
  function repaintIn(kind, build, altBuild, altKind) {
    if (!pop) return;
    var want = (pop.dataset.kind === kind) ? build : ((altKind && pop.dataset.kind === altKind) ? altBuild : null);
    if (!want) return;
    var st = pop.scrollTop;
    pop.innerHTML = '';
    want(pop);
    pop.scrollTop = st;
  }
  function repaintHelpers() { repaintIn('helpers', buildHelpers, buildMore, 'more'); }
  function repaintSnaps() { repaintIn('snaps', buildSnaps, buildMore, 'more'); }
  var toastBox = null;
  function toast(msg, bad, ms) {
    if (!toastBox) { toastBox = el('div', 'tbs-toasts'); document.body.appendChild(toastBox); }
    var t = el('div', 'tbs-toast' + (bad ? ' bad' : ''), msg);
    toastBox.appendChild(t);
    setTimeout(function () { t.classList.add('out'); setTimeout(function () { t.remove(); }, 300); }, ms || 3600);
  }

  // ============================================================ 挂载（最右边）
  var wrap = el('div', 'tbs-wrap');
  wrap.id = 'tbs-wrap';
  function mount() {
    if (document.getElementById('tbs-wrap')) return;
    var controls = document.querySelector('#titlebar .titlebar-controls');
    var minBtn = document.getElementById('btn-min');
    if (controls && minBtn) controls.insertBefore(wrap, minBtn);      // ← 贴在 ─ □ ✕ 左边 = 最右边
    else if (controls) controls.appendChild(wrap);
    else { var bar = document.getElementById('titlebar'); if (bar) bar.appendChild(wrap); }
  }

  // ============================================================ ① 快照 / 回滚
  var SNAP = { at: 0, rows: [], total: 0, dir: '', error: null, busy: false };
  var sPill = el('button', 'tbs-pill');
  sPill.type = 'button';
  sPill.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">'
    + '<path d="M8 1.9 2.6 4.2v4.1c0 3 2.3 5.2 5.4 5.8 3.1-.6 5.4-2.8 5.4-5.8V4.2L8 1.9Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>'
    + '<path d="M5.9 8.1 7.4 9.6l2.8-2.9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    + '<span class="tbs-txt">界面回退</span>';
  sPill.title = '界面回退：回到上一个正常的工作台界面（只动界面/脚本源码，不动数据与对话）';
  sPill.addEventListener('click', function () { openPop(sPill, 'snaps', buildSnaps); if (!SNAP.rows.length) refreshSnaps(); });

  function refreshSnaps() {
    return Promise.resolve().then(function () { return TB.snapshots(); }).then(function (r) {
      SNAP.at = Date.now();
      SNAP.rows = (r && r.rows) || [];
      SNAP.total = (r && r.total) || 0;
      SNAP.dir = (r && r.dir) || '';
      SNAP.error = (r && r.error) || null;
      repaintSnaps();
    }).catch(function (e) { SNAP.error = String((e && e.message) || e); repaintSnaps(); });
  }
  function buildSnaps(box) {
    box.appendChild(el('div', 'tbs-pop-h', '界面回退 · ' + SNAP.total + ' 份'));
    box.appendChild(el('div', 'tbs-pop-sub', '只动界面源码，不动数据与对话'));
    var list = el('div', 'tbs-pop-list');
    if (SNAP.error) list.appendChild(el('div', 'tbs-pop-hint', '读不到界面版本：' + SNAP.error));
    if (!SNAP.rows.length && !SNAP.error) list.appendChild(el('div', 'tbs-pop-hint', '（还没有界面版本）'));
    SNAP.rows.forEach(function (x, i) {
      var r0 = el('div', 'tbs-row');
      r0.appendChild(el('span', 'tbs-dot ' + (i === 0 ? 'ok' : '')));
      var mid = el('div', 'tbs-row-mid');
      mid.appendChild(el('div', 'tbs-row-t', i === 0 ? '最新那份' : x.name.replace('gui-', '')));
      mid.appendChild(el('div', 'tbs-row-s', tstr(x.at) + (x.pre ? ' · 回滚前自动留的' : '')));
      r0.appendChild(mid);
      var btn = el('button', 'tbs-btn danger', '回到');
      btn.type = 'button';
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (SNAP.busy) return;
        SNAP.busy = true;
        btn.textContent = '回滚中…';
        TB.restore(x.name).then(function (r) {
          SNAP.busy = false;
          if (r && r.ok) { toast('已回到 ' + tstr(x.at) + ' 那份（回滚前也自动留了一份）· 点 ⟳ 让它生效', false, 6500); closePop(); }
          else { btn.textContent = '回到'; toast('回滚没成功：' + ((r && r.error) || '未知原因'), true, 7000); }
        });
      });
      r0.appendChild(btn);
      list.appendChild(r0);
    });
    box.appendChild(list);
    var foot = el('div', 'tbs-pop-f');
    var b = el('button', 'tbs-btn', '＋ 记版本');
    b.type = 'button';
    b.addEventListener('click', function () {
      if (SNAP.busy) return;
      SNAP.busy = true;
      b.textContent = '打包中…';
      TB.snapshot().then(function (r) {
        SNAP.busy = false;
        b.textContent = '＋ 记版本';
        if (r && r.ok) { toast('界面版本记好了 ✓'); refreshSnaps(); }
        else { toast('快照没打成：' + ((r && r.error) || '未知原因'), true, 7000); }
      });
    });
    foot.appendChild(b);
    foot.appendChild(el('span', 'tbs-pop-hint', SNAP.at ? ('更新于 ' + tstr(SNAP.at)) : ''));
    box.appendChild(foot);
  }

  // ============================================================ ①b 引擎回退（2026-10-21）
  var ENG = { at: 0, meta: null, gens: [], error: null, busy: false };
  function refreshEngine() {
    if (!TB.engineStatus) { ENG.error = '当前工作台版本没有引擎回退桥（重启后生效）'; repaint('more', buildMore); return; }
    return Promise.all([
      Promise.resolve().then(function () { return TB.engineStatus(); }).catch(function (e) { return { ok: false, error: String((e && e.message) || e) }; }),
      (typeof TB.engineGens === 'function')
        ? Promise.resolve().then(function () { return TB.engineGens(); }).catch(function () { return { rows: [] }; })
        : Promise.resolve({ rows: [] })
    ]).then(function (all2) {
      var r = all2[0] || {}, g = all2[1] || {};
      ENG.at = Date.now();
      ENG.meta = (r && r.meta) || null;
      ENG.gens = (g && g.rows) || [];
      ENG.error = (r && r.ok === false) ? (r.error || '读取失败') : null;
      repaint('more', buildMore);
    }).catch(function (e) { ENG.error = String((e && e.message) || e); repaint('more', buildMore); });
  }
  function buildEngine(box) {
    box.appendChild(el('div', 'tbs-pop-h', '引擎回退'));
    box.appendChild(el('div', 'tbs-pop-sub', '只回启动配置，不碰源码与构建产物'));
    if (ENG.error) box.appendChild(el('div', 'tbs-pop-hint', ENG.error));
    if (!ENG.meta) { box.appendChild(el('div', 'tbs-pop-hint', '（还没有正常点；先点下面“把现在标为正常”）')); }
    else {
      var m = ENG.meta;
      var metaLine = el('div', 'tbs-pop-hint', '上次正常：' + String(m.savedAt || '?').slice(5, 16) + ' · ' + String(m.engineVersion || '?'));
      metaLine.title = '引擎 ' + String(m.engineVersion || '?') + (m.head ? (' · HEAD ' + String(m.head).slice(0, 8)) : '') + ' · ' + Object.keys(m.files || {}).length + ' 个配置';
      box.appendChild(metaLine);
    }
    // 2026-10-24（宿主）：引擎回退也留 5 代，能挑任意一代回（工具侧 --list / --restore-gen）
    if (ENG.gens && ENG.gens.length) {
      var gl = el('div', 'tbs-pop-list');
      ENG.gens.forEach(function (x, i) {
        var r0 = el('div', 'tbs-row');
        r0.appendChild(el('span', 'tbs-dot ' + (i === 0 ? 'ok' : '')));
        var mid = el('div', 'tbs-row-mid');
        mid.appendChild(el('div', 'tbs-row-t', i === 0 ? '最近一代' : String(x.at || '').slice(5, 16)));
        var sub = el('div', 'tbs-row-s', String(x.at || '').slice(5, 16) + ' · 引擎 ' + (x.ver || '?'));
        sub.title = 'gen ' + x.gen + (x.head ? (' · HEAD ' + x.head) : '');
        mid.appendChild(sub);
        r0.appendChild(mid);
        var gb = el('button', 'tbs-btn danger', '回到');
        gb.type = 'button';
        gb.addEventListener('click', function (e) {
          e.stopPropagation();
          if (ENG.busy || !TB.engineRestoreGen) return;
          ENG.busy = true; gb.textContent = '回退中…';
          TB.engineRestoreGen(x.gen).then(function (r) {
            ENG.busy = false; gb.textContent = '回到';
            if (r && r.ok) { toast('已回到 ' + String(x.at || '').slice(5, 16) + ' 那一代 ✓ 重启工作台后生效', false, 8000); refreshEngine(); }
            else toast('回退没成功：' + ((r && r.error) || '已取消'), true, 7000);
          });
        });
        r0.appendChild(gb);
        gl.appendChild(r0);
      });
      box.appendChild(gl);
    }
    var foot = el('div', 'tbs-pop-f');
    var save = el('button', 'tbs-btn', '标为正常');
    save.type = 'button';
    save.addEventListener('click', function () {
      if (ENG.busy || !TB.engineSnapshot) return;
      ENG.busy = true; save.textContent = '记录中…';
      TB.engineSnapshot().then(function (r) {
        ENG.busy = false; save.textContent = '标为正常';
        if (r && r.ok) { toast('已记下当前引擎配置为正常点 ✓'); refreshEngine(); }
        else toast('记录失败：' + ((r && r.error) || '未知原因'), true, 7000);
      });
    });
    foot.appendChild(save);
    var back = el('button', 'tbs-btn danger', '回到正常');
    back.type = 'button';
    back.addEventListener('click', function () {
      if (ENG.busy || !TB.engineRestore) return;
      ENG.busy = true; back.textContent = '回退中…';
      TB.engineRestore().then(function (r) {
        ENG.busy = false; back.textContent = '回到正常';
        if (r && r.ok) { toast('已回到上次正常配置 ✓ 重启工作台后生效', false, 8000); refreshEngine(); }
        else toast('回退没成功：' + ((r && r.error) || '已取消'), true, 7000);
      });
    });
    foot.appendChild(back);
    box.appendChild(foot);
  }

  // ============================================================ ② 谁在等我
  var PEN = { at: 0, items: [], error: null, open: -1 };
  // 2026-10-16 用户要：① 收进 ⋯ 菜单（角标挂在 ⋯ 那颗胶囊上）；② 分两类 —— **只有"要你拍板"的进角标**。
  var bBadge = el('span', 'tbs-badge', '0');
  bBadge.style.display = 'none';
  function needYou(x) {
    var s = String((x && x.status) || '');
    var t = String((x && x.text) || '');
    if (/拍板/.test(s)) return true;                        // 显式标注（推荐各家在 §六 状态格里这么写）
    return /(用户|你要|要不要|需你|你决定|花你)/.test(t);    // 兜底：内容里牵涉到"你"
  }
  function penSorted() {
    var mine = [], other = [];
    PEN.items.forEach(function (x) { (needYou(x) ? mine : other).push(x); });
    return mine.concat(other);                               // 要你拍板的排最前
  }
  function paintPending() {
    var mine = PEN.items.filter(needYou).length;
    bBadge.textContent = String(mine);
    bBadge.style.display = mine ? '' : 'none';
    if (mPill) {                                             // mPill（⋯ 胶囊）在本文件后面定义，运行到这里已存在
      if (bBadge.parentNode !== mPill) mPill.appendChild(bBadge);
      mPill.title = '更多：待办 / 磁盘余量 / 今天体检 / 搜文件脚本 / 打开常用文件夹'
        + (mine ? ('　·　⚠ ' + mine + ' 件要你拍板') : (PEN.items.length ? ('　·　' + PEN.items.length + ' 件知悉即可') : ''));
    }
  }
  function refreshPending() {
    return Promise.resolve().then(function () { return TB.pending(); }).then(function (r) {
      PEN.at = Date.now();
      PEN.items = (r && r.items) || [];
      PEN.error = (r && r.error) || null;
      paintPending();
      repaint('more', buildMore);
    }).catch(function (e) { PEN.error = String((e && e.message) || e); paintPending(); });
  }
  // 2026-10-16：用户要"只要显示哪个场景的会话有就行" ⇒ 把「谁提的」翻成场景名。
  //   共用卡的条目 = 本场景 DSH·GUI改造（界面侧/引擎侧两条会话都在里面）；场景记忆的卡点 = 拿 from 去场景列表模糊匹配。
  var SCENES = [];
  try {
    if (K.listScenarios) Promise.resolve(K.listScenarios()).then(function (l) { SCENES = l || []; repaint("more", buildMore); }).catch(function () { /* ignore */ });
  } catch (e) { /* ignore */ }
  function sceneLabel(x) {
    if (!x) return "";
    if (x.kind === 'card') return '场景：DSH·GUI改造（界面侧 / 引擎侧）';
    var f = String(x.from || '');
    var hit = (SCENES || []).filter(function (s) {
      if (!s || !s.title) return false;
      var tt = String(s.title);
      return tt.indexOf(f) >= 0 || f.indexOf(tt) >= 0;
    })[0];
    return '场景：' + (hit ? hit.title : (f || '?'));
  }
  function buildPending(box) {
    var mineN = PEN.items.filter(needYou).length;
    box.appendChild(el('div', 'tbs-pop-h', '待办 · 共 ' + PEN.items.length + ' 件'
      + (mineN ? ('，其中 ' + mineN + ' 件要你拍板') : '（没有要你拍板的）')));
    box.appendChild(el('div', 'tbs-pop-sub', '来源：共用定位卡 §六 还没办结的行 + 各场景记忆 §〇 的「卡点」。'
      + '分类依据：牵涉到"要不要做 / 花不花你的时间"的算「要你拍板」（红点）；其余是各会话之间的技术商量（黄点），你知悉即可。'));
    var list = el('div', 'tbs-pop-list');
    var arr = penSorted();
    if (!arr.length) list.appendChild(el('div', 'tbs-pop-hint', PEN.error ? ('读不到：' + PEN.error) : '没有待办 ✓'));
    arr.forEach(function (x) {
      var i = PEN.items.indexOf(x);
      var hot = needYou(x);
      var r0 = el('div', 'tbs-row tbs-col');
      var head = el('div', 'tbs-row');
      head.appendChild(el('span', 'tbs-dot ' + (hot ? 'bad' : (x.kind === 'card' ? 'warn' : 'ok'))));
      var mid = el('div', 'tbs-row-mid');
      mid.appendChild(el('div', 'tbs-row-t', brief(x.text) || '(无标题)'));
      mid.appendChild(el('div', 'tbs-row-s', (hot ? '要你拍板' : '知悉即可') + '　·　' + sceneLabel(x)
        + '　·　' + plainStatus(x.status) + (x.date ? '　·　' + x.date : '')));
      head.appendChild(mid);
      // 2026-10-16 17:3x 用户改口径：「不要点击跳转了，只要显示哪个场景的会话有就行了」
      // ⇒ 整行点击回到「展开全文」（跳转逻辑撤掉；renderer.js 里的 __dshGotoScene 钩子留着不碍事）。
      head.addEventListener('click', function () {
        PEN.open = (PEN.open === i) ? -1 : i;
        repaint('more', buildMore);
      });
      r0.appendChild(head);
      if (PEN.open === i) {
        var full = el('div', 'tbs-full');
        full.textContent = String(x.text || '').replace(/\*\*/g, '');
        r0.appendChild(full);
        var acts = el('div', 'tbs-acts');
        var ob = el('button', 'tbs-btn', '打开出处');
        ob.type = 'button';
        ob.addEventListener('click', function (e) {
          e.stopPropagation();
          if (K.app && K.app.openPath) K.app.openPath(x.file);
          toast('已打开：' + String(x.file || '').split('\\').pop());
        });
        acts.appendChild(ob);
        acts.appendChild(el('span', 'tbs-pop-hint', x.kind === 'card' ? '（写在共用定位卡里）' : '（写在那个场景自己的记忆里）'));
        r0.appendChild(acts);
      }
      list.appendChild(r0);
    });
    box.appendChild(list);
    var foot = el('div', 'tbs-pop-f');
    var b = el('button', 'tbs-btn', '重新扫一遍');
    b.type = 'button';
    b.addEventListener('click', function () { b.textContent = '扫描中…'; refreshPending().then(function () { b.textContent = '重新扫一遍'; }); });
    foot.appendChild(b);
    foot.appendChild(el('span', 'tbs-pop-hint', PEN.at ? ('更新于 ' + tstr(PEN.at)) : ''));
    box.appendChild(foot);
  }

  // ============================================================ ④ ⋯ 更多
  var MORE = { open: '' };
  var mPill = el('button', 'tbs-pill');
  mPill.type = 'button';
  mPill.innerHTML = '<span class="tbs-more">⋯</span>';
  mPill.title = '更多：磁盘余量 / 今天体检 / 搜文件脚本 / 打开常用文件夹';
  mPill.addEventListener('click', function () { MORE.open = ''; openPop(mPill, 'more', buildMore); });

  function accHead(box, key, icon, title, hint, onOpen) {
    var head = el('div', 'tbs-row');
    head.appendChild(el('span', 'tbs-row-ico', icon));
    var mid = el('div', 'tbs-row-mid');
    mid.appendChild(el('div', 'tbs-row-t', title));
    if (hint) mid.appendChild(el('div', 'tbs-row-s', hint));
    head.appendChild(mid);
    head.appendChild(el('span', 'tbs-caret', MORE.open === key ? '▾' : '▸'));
    head.title = [title, hint].filter(Boolean).join('\n');
    head.addEventListener('click', function () {
      MORE.open = (MORE.open === key) ? '' : key;
      if (MORE.open === key && onOpen) onOpen();
      repaint('more', buildMore);
    });
    box.appendChild(head);
  }
  function buildMore(box) {
    // 2026-10-19 宿主：从顶栏搬进 ⋯ 的两项（快照 / 助手）—— 放菜单最上面，展开即用，builder 直接复用。
    // 2026-10-22（宿主）：启动动画预览**从 ⋯ 菜单撤掉**，统一收到「设置 → 启动动画」那个插件页里
    //   （插件点「预览」→ 写 外壳\data\boot-preview.json → renderers.js 的 bootPreviewWatch 捞到就播）。
    // 2026-10-24（宿主：「把序号外观远程控制 放在⋯里」）——
    //   三个按钮本体还留在 DOM 里（renderer.js 的监听/文字同步都绑在它们身上），只是被 renderers.js 的
    //   hideMovedTopbarButtons() 加了 .tb-moved 藏起来；这里点一行 = 替宿主点一下那个隐藏按钮 ⇒ 逻辑零改动。
    (function () {
      var row = function (ico, t, sub, id) {
        var r = el('div', 'tbs-row');
        r.appendChild(el('div', 'tbs-row-ico', ico));
        var mid = el('div', 'tbs-row-mid');
        mid.appendChild(el('div', 'tbs-row-t', t));
        mid.appendChild(el('div', 'tbs-row-s', sub));
        r.appendChild(mid);
        r.addEventListener('click', function () {
          closePop();
          var b = document.getElementById(id);
          if (b) b.click();
        });
        box.appendChild(r);
      };
      var badges = document.getElementById('sf-badges');
      var seqTxt = badges ? String(badges.textContent || '').replace(/^序号[:：]\s*/, '') : '';
      row('🌙', '外观', '深色 / 浅色 / 跟随系统（点一下切换）', 'btn-theme');
      row('#', '序号' + (seqTxt ? '：' + seqTxt : ''), '窗口标题上的两位序号徽标，显示/隐藏', 'sf-badges');
    })();
    accHead(box, 'rollback', '↩', '回退（界面 / 引擎）', '界面坏了→界面回退；配置起不来→引擎回退；源码坏了走 git', function () { refreshEngine(); refreshSnaps(); });
    if (MORE.open === 'rollback') {
      var rw = el('div', 'tbs-acc');
      // 2026-10-24 宿主「字太多了」⇒ 判断口诀收进悬停提示，界面上只留两块操作
    rw.title = '坑的判断：① 界面/按钮/面板坏 → 界面回退；② 引擎起不来/配置改坏 → 引擎回退；③ 源码或构建坏了 → 两个都不够，走 engine-before + git';
      buildSnaps(rw);
      buildEngine(rw);
      box.appendChild(rw);
    }
    accHead(box, 'helpers', '🧑‍🤝‍🧑', '助手', '各场景派出去干重活的帮手（带「在工作」灯）', loadHelpers);
    if (MORE.open === 'helpers') { var hw2 = el('div', 'tbs-acc'); buildHelpers(hw2); box.appendChild(hw2); }



    // 0 待办（谁在等我）—— 2026-10-16 用户要求：从顶栏胶囊收进这里，角标挂在 ⋯ 上
    var mineN = PEN.items.filter(needYou).length;
    if (MORE.open === 'disk') {
      var dw = el('div', 'tbs-acc');
      if (!DISK.rows.length) dw.appendChild(el('div', 'tbs-pop-hint', DISK.err ? ('读不到：' + DISK.err) : '读取中…'));
      DISK.rows.forEach(function (d) {
        var lvl = d.percent >= 88 ? 'bad' : (d.percent >= 75 ? 'warn' : 'ok');
        var line = el('div', 'tbs-disk');
        line.appendChild(el('span', 'tbs-disk-n', d.drive));
        var bar = el('div', 'tbs-bar');
        var fill = el('div', 'tbs-bar-f ' + lvl);
        fill.style.width = Math.max(2, Math.min(100, d.percent)) + '%';
        bar.appendChild(fill);
        line.appendChild(bar);
        line.appendChild(el('span', 'tbs-disk-v', '已用 ' + d.percent + '%　剩 ' + gb(d.free) + ' / 共 ' + gb(d.total)));
        dw.appendChild(line);
      });
      dw.appendChild(el('div', 'tbs-pop-hint', '快满了就去「本地电脑」那个场景让它清 —— 清理的活全归它。'));
      box.appendChild(dw);
    }

    // 2 今天的体检
    // 2 体检（2026-10-16 晚 按 dg-dsh 派单完善：① 头部合成一行 ② 每类带条目数徽标 ③ 点某类展开明细 ④ 底部一行）
    accHead(box, 'health', '🩺', '体检', healthHead(), loadHealth);
    if (MORE.open === 'health') {
      var hw = el('div', 'tbs-acc');
      if (HEALTH.state === 'loading') hw.appendChild(el('div', 'tbs-pop-hint', '读取中…'));
      else if (HEALTH.state === 'none') {
        hw.appendChild(el('div', 'tbs-pop-hint', '还没跑过体检（现在改成每周日 12:30 自动跑一次）。'));
        hw.appendChild(el('div', 'tbs-pop-hint', '想现在跑：让任意会话执行 `全量标准化体检.mjs`，回来点「重新读一次」即可。'));
      } else if (HEALTH.state === 'error') hw.appendChild(el('div', 'tbs-pop-hint', '读不到：' + HEALTH.err));
      else {
        (HEALTH.groups || []).forEach(function (g, gi) {
          var st = (g && g.status) || 'ok';
          var cls = st === 'ok' ? 'ok' : (st === 'warn' ? 'warn' : 'bad');
          var ct = g && g.counts;
          var key = String((g && g.name) || ('group' + gi));
          var open = !!HEALTH.open[key];
          var row = el('div', 'tbs-row tbs-fold');
          row.appendChild(el('span', 'tbs-arrow', open ? '▾' : '▸'));
          row.appendChild(el('span', 'tbs-row-ico', (g && g.icon) || '•'));
          var mid = el('div', 'tbs-row-mid');
          mid.appendChild(el('div', 'tbs-row-t', (g && g.name) || ''));
          if (g && g.note) mid.appendChild(el('div', 'tbs-row-s', String(g.note).slice(0, 70)));
          row.appendChild(mid);
          // 条目数徽标：⛔ 优先 → ⚠ → 全 ok 显示 ✓N；老快照没有 counts 就退回原来的 ✓/⚠/⛔ 单字
          if (ct) {
            var bcls = ct.bad ? 'bad' : (ct.warn ? 'warn' : 'ok');
            row.appendChild(el('span', 'tbs-pct ' + bcls, (ct.bad ? ('⛔' + ct.bad) : (ct.warn ? ('⚠' + ct.warn) : ('✓' + ct.ok)))));
          } else row.appendChild(el('span', 'tbs-pct ' + cls, st === 'ok' ? '✓' : (st === 'warn' ? '⚠' : '⛔')));
          row.addEventListener('click', function () { HEALTH.open[key] = !HEALTH.open[key]; repaint('more', buildMore); });
          hw.appendChild(row);
          if (!open) return;                                    // ← 折叠状态记得住（HEALTH.open）
          var items = Array.isArray(g && g.items) ? g.items : null;
          if (!items) { hw.appendChild(el('div', 'tbs-pop-hint', '　这一类没有逐项明细（老快照只有摘要，下次体检后就有）。')); return; }
          var bad = items.filter(function (it) { return it && it.status && it.status !== 'ok'; });
          if (!bad.length) { hw.appendChild(el('div', 'tbs-pop-hint', '　✅ ' + items.length + ' 项全过')); return; }
          bad.sort(function (a, b) { return (a.status === 'bad' ? 0 : 1) - (b.status === 'bad' ? 0 : 1); });
          var MAXI = 8;    // dg-dsh 建议：每类最多 8 条，超出打一行指到报告
          bad.slice(0, MAXI).forEach(function (it) {
            var iw = el('div', 'tbs-hd-item');
            iw.appendChild(el('div', 'tbs-hd-name', (it.status === 'bad' ? '⛔ ' : '⚠ ') + (it.name || '(无名)')));
            var dt = el('div', 'tbs-hd-detail', String(it.detail || ''));
            dt.title = '点一下复制全文';
            dt.addEventListener('click', function (e) { e.stopPropagation(); copyText(String(it.detail || '')); });
            iw.appendChild(dt);
            hw.appendChild(iw);
          });
          if (bad.length > MAXI) hw.appendChild(el('div', 'tbs-pop-hint', '　还有 ' + (bad.length - MAXI) + ' 条 —— 见 说明\\体检报告.md（§' + ((g && g.name) || '') + ' 那一节）'));
        });
        if (HEALTH.report) {
          var hb = el('button', 'tbs-btn', '打开报告全文');
          hb.type = 'button';
          hb.addEventListener('click', function () { if (K.app && K.app.openPath) K.app.openPath(HEALTH.report); });
          hw.appendChild(hb);
        }
        hw.appendChild(el('div', 'tbs-pop-hint', healthFoot()));
      }
      box.appendChild(hw);
    }

    // 3 搜文件 / 脚本
    accHead(box, 'search', '🔍', '搜文件 / 脚本', '在索引里找（比翻目录快）', null);
    if (MORE.open === 'search') {
      var sw = el('div', 'tbs-acc');
      var inp = el('input', 'tbs-input');
      inp.placeholder = '输入关键词，回车搜索（可空格分词）';
      inp.value = SEARCH.q || '';
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { SEARCH.q = inp.value.trim(); runSearch(); } });
      sw.appendChild(inp);
      if (SEARCH.busy) sw.appendChild(el('div', 'tbs-pop-hint', '搜索中…'));
      else if (SEARCH.done) {
        sw.appendChild(el('div', 'tbs-pop-hint', SEARCH.hits.length
          ? ('找到 ' + SEARCH.hits.length + ' 处（搜的是索引文件，不是全盘）· 点一行用默认程序打开')
          : '没找到。换个词，或让那个场景把新东西登记进索引。'));
        SEARCH.hits.slice(0, 24).forEach(function (h) {
          var r0 = el('div', 'tbs-row');
          r0.appendChild(el('span', 'tbs-dot'));
          var mid = el('div', 'tbs-row-mid');
          mid.appendChild(el('div', 'tbs-row-t', h.text));
          mid.appendChild(el('div', 'tbs-row-s', h.label));
          r0.appendChild(mid);
          r0.addEventListener('click', function () { if (K.app && K.app.openPath) K.app.openPath(h.file); });
          sw.appendChild(r0);
        });
      }
      box.appendChild(sw);
      setTimeout(function () { try { inp.focus(); } catch (e) { /* ignore */ } }, 0);
    }

    // 4 常用文件夹 —— 2026-10-16 用户要求「放出来」⇒ 已提升为顶栏一级胶囊（见 buildFolders），这里不再重复。
  }

  // ---- ⋯ 里的三块数据 ----
  var DISK = { rows: [], err: null, at: 0 };
  function loadDisks() {
    if (DISK.at && Date.now() - DISK.at < 10000) return;
    DISK.at = Date.now();
    if (!(K.sys && K.sys.disks)) { DISK.err = '这个宿主没有磁盘接口'; return; }
    Promise.resolve().then(function () { return K.sys.disks(); }).then(function (r) {
      var rows = (r && r.drives) || [];
      DISK.rows = rows.filter(function (d) { return d && d.ok !== false; })
        .map(function (d) { return { drive: d.drive, percent: d.percent, free: d.free, total: d.total }; });
      DISK.err = rows.length ? null : '没读到分区';
      repaint('more', buildMore);
    }).catch(function (e) { DISK.err = String((e && e.message) || e); repaint('more', buildMore); });
  }
  var HEALTH = { state: '', at: 0, time: '', verdict: '', ok: 0, warn: 0, bad: 0, report: '', groups: [], err: null , totals: null, sources: [], open: {} };
  // 头部/底部两行（2026-10-16 晚：头部原来在标题和卡身各写一遍 ⇒ 合成一行；底部补"共 N 项明细 · 来源 M 个子检查"）
  function healthHead() {
    if (HEALTH.state === 'none') return '还没跑过';
    var s = '上次体检 ' + (HEALTH.time || '—') + ' · ' + (HEALTH.verdict || '');
    s += ' · ✓' + HEALTH.ok + ' ⚠' + HEALTH.warn + ' ⛔' + HEALTH.bad;
    if (HEALTH.totals) s += ' · 逐项 ' + HEALTH.totals.items + '（✅' + HEALTH.totals.ok + ' ⚠' + HEALTH.totals.warn + ' · ⛔' + HEALTH.totals.bad + '）';
    return s;
  }
  function healthFoot() {
    if (!HEALTH.totals) return '生成 ' + (HEALTH.time || '—') + '　·　明细全文见 说明\\体检报告.md';
    return '生成 ' + (HEALTH.time || '—') + '　·　共 ' + HEALTH.totals.items + ' 项明细 · 来源 ' + ((HEALTH.sources || []).length || '?') + ' 个子检查 · 每周日 12:30 自动　·　明细全文见 说明\\体检报告.md';
  }
  function loadHealth() {
    if (HEALTH.at && Date.now() - HEALTH.at < 60000 && HEALTH.state) return;
    HEALTH.at = Date.now();
    HEALTH.state = 'loading';
    // 2026-10-16 改：不再读「_基础体检-<今天>.md」（那是每天跑的产物，改成每周日后就不存在了 ⇒ 用户看到"今天这份还没生成"）。
    // 现在固定读引擎侧 `全量标准化体检.mjs` 写的卡片数据；报告路径也用它给的 json.report。
    var f = ROOT + '\\引擎\\场景项目信息\\_体检-latest.json';
    if (!(K.file && K.file.read)) { HEALTH.state = 'error'; HEALTH.err = '这个宿主没有读文件接口'; return; }
    Promise.resolve().then(function () { return K.file.read(f); }).then(function (t) {
      var o = null;
      try {
        if (t && typeof t === 'object' && !t.text) o = t;                       // 宿主直接给了对象
        else { var s = (typeof t === 'string') ? t : ((t && t.text) || ''); if (!s) throw new Error('空'); o = JSON.parse(s); }
      } catch (e) { o = null; }
      if (!o) { HEALTH.state = 'error'; HEALTH.err = '读不到或解析失败'; repaint('more', buildMore); return; }
      HEALTH.time = o.time || '';
      HEALTH.verdict = o.verdict || '';
      HEALTH.ok = o.ok || 0;
      HEALTH.warn = o.warn || 0;
      HEALTH.bad = o.bad || 0;
      HEALTH.report = o.report || '';
      HEALTH.groups = Array.isArray(o.groups) ? o.groups : [];
      HEALTH.totals = o.totals || null;
      HEALTH.sources = Array.isArray(o.sources) ? o.sources : [];
      HEALTH.state = 'ok';
      repaint('more', buildMore);
    }).catch(function () { HEALTH.state = 'none'; repaint('more', buildMore); });
  }
  var SEARCH = { q: '', hits: [], done: false, busy: false };
  function runSearch() {
    if (!SEARCH.q) return;
    SEARCH.busy = true; SEARCH.done = false; SEARCH.hits = [];
    repaint('more', buildMore);
    var terms = SEARCH.q.toLowerCase().split(/\s+/).filter(Boolean);
    var jobs = INDEX_FILES.map(function (ix) {
      return Promise.resolve().then(function () { return K.file.read(ix.file); }).then(function (t) {
        var s = typeof t === 'string' ? t : ((t && t.text) || '');
        var out = [];
        s.split(/\r?\n/).forEach(function (line) {
          if (!line.trim()) return;
          var low = line.toLowerCase();
          if (terms.every(function (x) { return low.indexOf(x) >= 0; })) {
            out.push({
              label: ix.label, file: ix.file,
              text: line.trim().replace(/^\|\s*/, '').replace(/\s*\|\s*$/, '').slice(0, 150)
            });
          }
        });
        return out;
      }).catch(function () { return []; });
    });
    Promise.all(jobs).then(function (arrs) {
      var all = [];
      arrs.forEach(function (a) { all = all.concat(a); });
      SEARCH.hits = all;
      SEARCH.busy = false;
      SEARCH.done = true;
      repaint('more', buildMore);
    });
  }

  // ============================================================ ⑤ 助手（帮手会话，2026-10-16 用户点名）
  //   数据源：引擎侧写 `外壳\data\助手会话.json`（合同见《标准化规范》§2.13）；**压力复用 topbar:pressure 的 helpers**，不另算。
  //   点「打开」= 切到它所属场景（帮手没有自己的面板）；切不动就退化成复制 id。
  var HELP = { at: 0, rows: [], err: null, ready: false };
  var hPill = el('button', 'tbs-pill');
  hPill.type = 'button';
  hPill.innerHTML = '<span class="tbs-row-ico">🧑‍🤝‍🧑</span><span class="tbs-txt">助手</span>';
  hPill.title = '各场景的帮手会话（按场景分组看，含上下文压力）';
  hPill.addEventListener('click', function () { openPop(hPill, 'helpers', buildHelpers); loadHelpers(); });

  function copyText(t) {
    try {
      var ta = document.createElement('textarea');
      ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
      toast('已复制：' + t);
    } catch (e) { toast('复制失败：' + ((e && e.message) || e), true); }
  }
  function loadHelpers() {
    if (!TB || !TB.pressure) { HELP.err = '这个宿主还没有压力接口'; repaintHelpers(); return; }
    Promise.resolve().then(function () { return TB.pressure(); }).then(function (r) {
      HELP.at = Date.now();
      HELP.ready = true;
      HELP.err = (r && r.ok === false) ? ((r && r.error) || '读不到') : null;
      HELP.rows = (r && r.helpers) || [];
      HELP.noField = !!r && r.helpers === undefined;      // 老主进程（没重启）⇒ 温和提示
      repaintHelpers();
    }).catch(function (e) { HELP.err = String((e && e.message) || e); repaintHelpers(); });
  }
  function sceneIdOf(h) {
    var want = String((h && (h.panel || h.scene)) || '');
    var hit = (SCENES || []).filter(function (s) {
      if (!s) return false;
      var t = String(s.title || ''), i = String(s.id || '');
      return (want && (t.indexOf(want) >= 0 || want.indexOf(t) >= 0 || i === want));
    })[0];
    return hit ? hit.id : '';
  }
  function pressChip(pct) {
    var lvl = pct >= 400 ? 'bad' : (pct >= 100 ? 'warn' : 'ok');
    return { cls: lvl, txt: pct + '%' };
  }
  var HELP = { at: 0, rows: [], err: null, ready: false, noField: false };
  function buildHelpers(box) {
    var on = 0;
    HELP.rows.forEach(function (h) { if (glowOf(h.fullId) === true) on++; });
    box.appendChild(el('div', 'tbs-pop-h', '各场景的帮手会话 · ' + HELP.rows.length + ' 个' + (on ? ('（' + on + ' 个正在干活）') : '')));
    box.appendChild(el('div', 'tbs-pop-sub', '帮手是各场景主会话派出去干重活的独立会话（没有自己的面板）。**亮灯 = 正在干活**（跟场景标签同一个判据）。'));
    if (HELP.noField) {
      box.appendChild(el('div', 'tbs-pop-hint', '⚠ 压力列要 重启一次工作台 才显示 —— 取数在主进程 main.js 里。'));
      box.appendChild(el('div', 'tbs-pop-hint', '重启后我会复验：这批帮手每条都带上真实百分比，并跑一次 check-gui。'));
    }
    if (!HELP.ready) box.appendChild(el('div', 'tbs-pop-hint', '读取中…'));
    else if (HELP.err) box.appendChild(el('div', 'tbs-pop-hint', '读不到：' + HELP.err));
    if (HELP.ready && !HELP.rows.length && !HELP.err) {
      box.appendChild(el('div', 'tbs-pop-hint', '还没有登记帮手。'));
      box.appendChild(el('div', 'tbs-pop-hint', '用引擎侧 助手会话.mjs --add 登记（规矩见《标准化规范》§2.13）；目前只有<客户>有。'));
    }
    WORK.dots = {};
    var order = [], groups = {};
    HELP.rows.forEach(function (h) {
      var head = (h.sceneName || h.scene || h.sceneId || '未指定场景') + (h.panel ? (' · ' + h.panel) : '');
      if (!groups[head]) { groups[head] = []; order.push(head); }
      groups[head].push(h);
    });
    order.forEach(function (head) {
      var arr = groups[head];
      var busyN = arr.filter(function (h) { return glowOf(h.fullId) === true; }).length;
      var folded = HELP.fold && HELP.fold[head];
      var hd = foldHead(box, !folded, '◈', head, arr.length, busyN ? (busyN + ' 个正在干活') : '点一下折叠/展开');
      hd.addEventListener('click', function () {
        HELP.fold = HELP.fold || {};
        HELP.fold[head] = !HELP.fold[head];
        repaintHelpers();
      });
      box.appendChild(hd);
      if (folded) return;
      arr.forEach(function (h) {
        var row = el('div', 'tbs-row');
        var dot = el('span', 'tbs-dot' + (glowOf(h.fullId) === true ? ' tbs-work' : ''));
        dot.title = glowOf(h.fullId) === true ? '正在干活' : (glowOf(h.fullId) === false ? '闲置' : '还没测到状态');
        WORK.dots[h.fullId] = dot;
        row.appendChild(dot);
        var mid = el('div', 'tbs-row-mid');
        mid.appendChild(el('div', 'tbs-row-t', h.title || '(无标题)'));
        var has = !(h.pct === null || h.pct === undefined);
        mid.appendChild(el('div', 'tbs-row-s', has
          ? ('用了 ' + humans(h.projected) + ' / 线 ' + humans(h.line) + '　·　聊了 ' + h.turns + ' 轮' + (h.since ? ('　·　' + h.since) : ''))
          : ('压力 —（引擎还没这条会话的用量数据）' + (h.since ? ('　·　' + h.since) : ''))));
        mid.appendChild(el('div', 'tbs-row-s', String(h.fullId)));
        if (h.note) mid.appendChild(el('div', 'tbs-row-s', h.note));
        row.appendChild(mid);
        if (has) { var p = pressChip(h.pct); row.appendChild(el('span', 'tbs-pct ' + p.cls, p.txt)); }
        else row.appendChild(el('span', 'tbs-pct', '—'));
        var b1 = el('button', 'tbs-btn', '打开');
        b1.type = 'button';
        b1.addEventListener('click', function (e) {
          e.stopPropagation();
          var sid = sceneIdOf(h);
          if (sid && window.__dshGotoScene && window.__dshGotoScene(sid)) { toast('已切到该场景：' + sid + '（帮手没有自己的面板，id 已复制）'); copyText(h.fullId); closePop(); }
          else copyText(h.fullId);
        });
        row.appendChild(b1);
        var b2 = el('button', 'tbs-btn', '复制 id');
        b2.type = 'button';
        b2.addEventListener('click', function (e) { e.stopPropagation(); copyText(h.fullId); });
        row.appendChild(b2);
        box.appendChild(row);
      });
    });
    var foot = el('div', 'tbs-pop-f');
    var b = el('button', 'tbs-btn', '重新读一次');
    b.type = 'button';
    b.addEventListener('click', function () { b.textContent = '读取中…'; loadHelpers(); setTimeout(function () { b.textContent = '重新读一次'; }, 600); });
    foot.appendChild(b);
    foot.appendChild(el('span', 'tbs-pop-hint', HELP.at ? ('更新于 ' + tstr(HELP.at)) : ''));
    box.appendChild(foot);
    WORK.root = box;
    startWork();
  }
  // 2026-10-16：帮手"在工作"的灯 —— **复用场景标签那套判据**（renderers.js 的 glowReadState：
  //   引擎状态缓存里 openStep 非空 / pendingCalls 非空 / 子代理新鲜）⇒ 不另造一套。
  //   只在"助手弹层开着"时每 3 秒测一次，关掉就自停（不为看不见的东西白耗）。
  var WORK = { cache: {}, timer: null, root: null, dots: {} };
  function glowOf(sid) {
    var c = WORK.cache[sid];
    return (c && (Date.now() - c.at < 9000)) ? c.busy : null;
  }
  function workTick() {
    if (!WORK.root || !WORK.root.isConnected) {
      if (WORK.timer) { clearInterval(WORK.timer); WORK.timer = null; }
      return;
    }
    if (typeof window.glowReadState !== 'function') return;   // 宿主没有现成判据 ⇒ 不猜，宁可没灯
    var ids = (HELP.rows || []).map(function (h) { return h.fullId; });
    var i = 0;
    (function next() {
      if (i >= ids.length) return;
      var sid = ids[i++];
      Promise.resolve().then(function () { return window.glowReadState(sid, false); })
        .then(function (st) { WORK.cache[sid] = { at: Date.now(), busy: !!(st && st.busy) }; })
        .catch(function () { WORK.cache[sid] = { at: Date.now(), busy: false }; })
        .then(function () {
          var d = WORK.dots[sid];
          if (d && d.isConnected) d.classList.toggle('tbs-work', WORK.cache[sid].busy === true);
          next();
        });
    })();
  }
  function startWork() {
    workTick();
    if (!WORK.timer) WORK.timer = setInterval(workTick, 3000);
  }
  // ============================================================ ⑥ 负载胶囊（CPU / GPU 实时）
  //   2026-10-19 宿主：N 卡的浮层（GPU 28% 41°C | CPU 30% 75°C）挡住界面 ⇒ 把同样的读数搬进顶栏，
  //   放在「手机远程」左边，这样关掉浮层也能一眼看到。
  //   ⚠ 资源纪律：**只在这个窗口有焦点时**每 5 秒取一次；不在前台 = 一次都不取（点开看明细才额外取）。
  var LOAD = { at: 0, cpu: null, gpu: null, err: null, busy: false };
  var lPill = el('button', 'tbs-pill tbs-load');
  lPill.type = 'button';
  lPill.id = 'tbs-load';
  lPill.title = '本机负载：CPU / GPU（点开看明细）';
  function paintLoad() {
    var cpu = (LOAD.cpu === null || LOAD.cpu === undefined) ? '—' : (LOAD.cpu + '%');
    var gpu = LOAD.gpu ? (LOAD.gpu.util + '%') : '—';
    var mem = (LOAD.mem && typeof LOAD.mem.usedPct === 'number') ? (LOAD.mem.usedPct + '%') : '—';   // 2026-10-20 内存   // 2026-10-19 宿主：胶囊里不显示温度（温度放点开的明细里）
    var lvl = (typeof LOAD.cpu === 'number' && LOAD.cpu >= 90) ? 'bad' : (typeof LOAD.cpu === 'number' && LOAD.cpu >= 70 ? 'warn' : '');
    lPill.innerHTML = '<span class="tbs-txt"><span class="tbs-k">CPU</span><b>' + cpu + '</b></span>'
      + '<span class="tbs-txt"><span class="tbs-k">GPU</span><b>' + gpu + '</b></span>'
      + '<span class="tbs-txt"><span class="tbs-k">MEM</span><b>' + mem + '</b></span>';
    lPill.className = 'tbs-pill tbs-load' + (lvl ? ' ' + lvl : '');
    lPill.title = '本机负载：CPU ' + cpu + ' · GPU ' + gpu + (LOAD.gpu ? ('（' + LOAD.gpu.memUsed + '/' + LOAD.gpu.memTotal + ' MB 显存）') : '') + '　·　点开看明细';
  }
  function refreshLoad() {
    if (LOAD.busy) return;
    if (!(K.sys && K.sys.load)) { LOAD.err = '这个宿主还没有负载接口（要重启一次工作台）'; paintLoad(); return; }
    LOAD.busy = true;
    Promise.resolve().then(function () { return K.sys.load(); }).then(function (r) {
      LOAD.busy = false;
      LOAD.at = Date.now();
      LOAD.err = (r && r.ok === false) ? '读不到' : null;
      LOAD.cpu = (r && typeof r.cpu === 'number') ? r.cpu : LOAD.cpu;
      LOAD.gpu = (r && r.gpu) ? r.gpu : null;
      LOAD.mem = (r && r.mem) ? r.mem : null;
      paintLoad();
      if (typeof POP !== 'undefined' && POP && POP.key === 'load') repaint('load', buildLoad);
    }).catch(function (e) { LOAD.busy = false; LOAD.err = String((e && e.message) || e); paintLoad(); });
  }
  function buildLoad(box) {
    box.appendChild(el('div', 'tbs-pop-h', '本机负载'));
    box.appendChild(el('div', 'tbs-pop-sub', 'CPU 用系统差值算（零子进程）；GPU 走 nvidia-smi（每 5 秒一次，仅当这个窗口在前台）。'));
    var cpu = (typeof LOAD.cpu === 'number') ? (LOAD.cpu + '%') : '—';
    var g = LOAD.gpu;
    box.appendChild(el('div', 'tbs-row')).appendChild(el('div', 'tbs-row-t', 'CPU ' + cpu));
    if (g) {
      box.appendChild(el('div', 'tbs-row')).appendChild(el('div', 'tbs-row-t', g.name + '　GPU ' + g.util + '%　' + g.temp + '°C　显存 ' + g.memUsed + '/' + g.memTotal + ' MB'));
    }
    if (LOAD.mem) {
      box.appendChild(el('div', 'tbs-row')).appendChild(el('div', 'tbs-row-t', '内存　已用 ' + LOAD.mem.usedPct + '%　' + LOAD.mem.usedGB + ' / ' + LOAD.mem.totalGB + ' GB'));
    }
    if (!g) {
      box.appendChild(el('div', 'tbs-pop-hint', LOAD.err ? ('GPU：' + LOAD.err) : 'GPU：没有读到（没有 N 卡，或 nvidia-smi 不可用）'));
    }
    var foot = el('div', 'tbs-pop-f');
    var b = el('button', 'tbs-btn', '＋ 记版本');
    b.type = 'button';
    b.addEventListener('click', function () {
      if (SNAP.busy) return;
      SNAP.busy = true;
      b.textContent = '打包中…';
      TB.snapshot().then(function (r) {
        SNAP.busy = false;
        b.textContent = '＋ 记版本';
        if (r && r.ok) { toast('界面版本记好了 ✓'); refreshSnaps(); }
        else { toast('快照没打成：' + ((r && r.error) || '未知原因'), true, 7000); }
      });
    });
    foot.appendChild(b);
    foot.appendChild(el('span', 'tbs-pop-hint', SNAP.at ? ('更新于 ' + tstr(SNAP.at)) : ''));
    box.appendChild(foot);
  }

  // ============================================================ ①b 引擎回退（2026-10-21）
  var ENG = { at: 0, meta: null, gens: [], error: null, busy: false };
  function refreshEngine() {
    if (!TB.engineStatus) { ENG.error = '当前工作台版本没有引擎回退桥（重启后生效）'; repaint('more', buildMore); return; }
    return Promise.all([
      Promise.resolve().then(function () { return TB.engineStatus(); }).catch(function (e) { return { ok: false, error: String((e && e.message) || e) }; }),
      (typeof TB.engineGens === 'function')
        ? Promise.resolve().then(function () { return TB.engineGens(); }).catch(function () { return { rows: [] }; })
        : Promise.resolve({ rows: [] })
    ]).then(function (all2) {
      var r = all2[0] || {}, g = all2[1] || {};
      ENG.at = Date.now();
      ENG.meta = (r && r.meta) || null;
      ENG.gens = (g && g.rows) || [];
      ENG.error = (r && r.ok === false) ? (r.error || '读取失败') : null;
      repaint('more', buildMore);
    }).catch(function (e) { ENG.error = String((e && e.message) || e); repaint('more', buildMore); });
  }
  function buildEngine(box) {
    box.appendChild(el('div', 'tbs-pop-h', '引擎回退'));
    box.appendChild(el('div', 'tbs-pop-sub', '只回启动配置，不碰源码与构建产物'));
    if (ENG.error) box.appendChild(el('div', 'tbs-pop-hint', ENG.error));
    if (!ENG.meta) { box.appendChild(el('div', 'tbs-pop-hint', '（还没有正常点；先点下面“把现在标为正常”）')); }
    else {
      var m = ENG.meta;
      box.appendChild(el('div', 'tbs-pop-hint', '上次正常：' + String(m.savedAt || '?') + ' · 引擎 ' + String(m.engineVersion || '?')
        + (m.head ? (' · HEAD ' + String(m.head).slice(0, 8)) : '') + ' · ' + Object.keys(m.files || {}).length + ' 个配置'));
    }
    // 2026-10-24（宿主）：引擎回退也留 5 代，能挑任意一代回（工具侧 --list / --restore-gen）
    if (ENG.gens && ENG.gens.length) {
      var gl = el('div', 'tbs-pop-list');
      ENG.gens.forEach(function (x, i) {
        var r0 = el('div', 'tbs-row');
        r0.appendChild(el('span', 'tbs-dot ' + (i === 0 ? 'ok' : '')));
        var mid = el('div', 'tbs-row-mid');
        mid.appendChild(el('div', 'tbs-row-t', i === 0 ? '最近一代' : String(x.at || '').slice(5, 16)));
        var sub = el('div', 'tbs-row-s', String(x.at || '').slice(5, 16) + ' · 引擎 ' + (x.ver || '?'));
        sub.title = 'gen ' + x.gen + (x.head ? (' · HEAD ' + x.head) : '');
        mid.appendChild(sub);
        r0.appendChild(mid);
        var gb = el('button', 'tbs-btn danger', '回到');
        gb.type = 'button';
        gb.addEventListener('click', function (e) {
          e.stopPropagation();
          if (ENG.busy || !TB.engineRestoreGen) return;
          ENG.busy = true; gb.textContent = '回退中…';
          TB.engineRestoreGen(x.gen).then(function (r) {
            ENG.busy = false; gb.textContent = '回到';
            if (r && r.ok) { toast('已回到 ' + String(x.at || '').slice(5, 16) + ' 那一代 ✓ 重启工作台后生效', false, 8000); refreshEngine(); }
            else toast('回退没成功：' + ((r && r.error) || '已取消'), true, 7000);
          });
        });
        r0.appendChild(gb);
        gl.appendChild(r0);
      });
      box.appendChild(gl);
    }
    var foot = el('div', 'tbs-pop-f');
    var save = el('button', 'tbs-btn', '标为正常');
    save.type = 'button';
    save.addEventListener('click', function () {
      if (ENG.busy || !TB.engineSnapshot) return;
      ENG.busy = true; save.textContent = '记录中…';
      TB.engineSnapshot().then(function (r) {
        ENG.busy = false; save.textContent = '标为正常';
        if (r && r.ok) { toast('已记下当前引擎配置为正常点 ✓'); refreshEngine(); }
        else toast('记录失败：' + ((r && r.error) || '未知原因'), true, 7000);
      });
    });
    foot.appendChild(save);
    var back = el('button', 'tbs-btn danger', '回到正常');
    back.type = 'button';
    back.addEventListener('click', function () {
      if (ENG.busy || !TB.engineRestore) return;
      ENG.busy = true; back.textContent = '回退中…';
      TB.engineRestore().then(function (r) {
        ENG.busy = false; back.textContent = '回到正常';
        if (r && r.ok) { toast('已回到上次正常配置 ✓ 重启工作台后生效', false, 8000); refreshEngine(); }
        else toast('回退没成功：' + ((r && r.error) || '已取消'), true, 7000);
      });
    });
    foot.appendChild(back);
    box.appendChild(foot);
  }

  // ============================================================ ② 谁在等我
  var PEN = { at: 0, items: [], error: null, open: -1 };
  // 2026-10-16 用户要：① 收进 ⋯ 菜单（角标挂在 ⋯ 那颗胶囊上）；② 分两类 —— **只有"要你拍板"的进角标**。
  var bBadge = el('span', 'tbs-badge', '0');
  bBadge.style.display = 'none';
  function needYou(x) {
    var s = String((x && x.status) || '');
    var t = String((x && x.text) || '');
    if (/拍板/.test(s)) return true;                        // 显式标注（推荐各家在 §六 状态格里这么写）
    return /(用户|你要|要不要|需你|你决定|花你)/.test(t);    // 兜底：内容里牵涉到"你"
  }
  function penSorted() {
    var mine = [], other = [];
    PEN.items.forEach(function (x) { (needYou(x) ? mine : other).push(x); });
    return mine.concat(other);                               // 要你拍板的排最前
  }
  function paintPending() {
    var mine = PEN.items.filter(needYou).length;
    bBadge.textContent = String(mine);
    bBadge.style.display = mine ? '' : 'none';
    if (mPill) {                                             // mPill（⋯ 胶囊）在本文件后面定义，运行到这里已存在
      if (bBadge.parentNode !== mPill) mPill.appendChild(bBadge);
      mPill.title = '更多：待办 / 磁盘余量 / 今天体检 / 搜文件脚本 / 打开常用文件夹'
        + (mine ? ('　·　⚠ ' + mine + ' 件要你拍板') : (PEN.items.length ? ('　·　' + PEN.items.length + ' 件知悉即可') : ''));
    }
  }
  function refreshPending() {
    return Promise.resolve().then(function () { return TB.pending(); }).then(function (r) {
      PEN.at = Date.now();
      PEN.items = (r && r.items) || [];
      PEN.error = (r && r.error) || null;
      paintPending();
      repaint('more', buildMore);
    }).catch(function (e) { PEN.error = String((e && e.message) || e); paintPending(); });
  }
  // 2026-10-16：用户要"只要显示哪个场景的会话有就行" ⇒ 把「谁提的」翻成场景名。
  //   共用卡的条目 = 本场景 DSH·GUI改造（界面侧/引擎侧两条会话都在里面）；场景记忆的卡点 = 拿 from 去场景列表模糊匹配。
  var SCENES = [];
  try {
    if (K.listScenarios) Promise.resolve(K.listScenarios()).then(function (l) { SCENES = l || []; repaint("more", buildMore); }).catch(function () { /* ignore */ });
  } catch (e) { /* ignore */ }
  function sceneLabel(x) {
    if (!x) return "";
    if (x.kind === 'card') return '场景：DSH·GUI改造（界面侧 / 引擎侧）';
    var f = String(x.from || '');
    var hit = (SCENES || []).filter(function (s) {
      if (!s || !s.title) return false;
      var tt = String(s.title);
      return tt.indexOf(f) >= 0 || f.indexOf(tt) >= 0;
    })[0];
    return '场景：' + (hit ? hit.title : (f || '?'));
  }
  function buildPending(box) {
    var mineN = PEN.items.filter(needYou).length;
    box.appendChild(el('div', 'tbs-pop-h', '待办 · 共 ' + PEN.items.length + ' 件'
      + (mineN ? ('，其中 ' + mineN + ' 件要你拍板') : '（没有要你拍板的）')));
    box.appendChild(el('div', 'tbs-pop-sub', '来源：共用定位卡 §六 还没办结的行 + 各场景记忆 §〇 的「卡点」。'
      + '分类依据：牵涉到"要不要做 / 花不花你的时间"的算「要你拍板」（红点）；其余是各会话之间的技术商量（黄点），你知悉即可。'));
    var list = el('div', 'tbs-pop-list');
    var arr = penSorted();
    if (!arr.length) list.appendChild(el('div', 'tbs-pop-hint', PEN.error ? ('读不到：' + PEN.error) : '没有待办 ✓'));
    arr.forEach(function (x) {
      var i = PEN.items.indexOf(x);
      var hot = needYou(x);
      var r0 = el('div', 'tbs-row tbs-col');
      var head = el('div', 'tbs-row');
      head.appendChild(el('span', 'tbs-dot ' + (hot ? 'bad' : (x.kind === 'card' ? 'warn' : 'ok'))));
      var mid = el('div', 'tbs-row-mid');
      mid.appendChild(el('div', 'tbs-row-t', brief(x.text) || '(无标题)'));
      mid.appendChild(el('div', 'tbs-row-s', (hot ? '要你拍板' : '知悉即可') + '　·　' + sceneLabel(x)
        + '　·　' + plainStatus(x.status) + (x.date ? '　·　' + x.date : '')));
      head.appendChild(mid);
      // 2026-10-16 17:3x 用户改口径：「不要点击跳转了，只要显示哪个场景的会话有就行了」
      // ⇒ 整行点击回到「展开全文」（跳转逻辑撤掉；renderer.js 里的 __dshGotoScene 钩子留着不碍事）。
      head.addEventListener('click', function () {
        PEN.open = (PEN.open === i) ? -1 : i;
        repaint('more', buildMore);
      });
      r0.appendChild(head);
      if (PEN.open === i) {
        var full = el('div', 'tbs-full');
        full.textContent = String(x.text || '').replace(/\*\*/g, '');
        r0.appendChild(full);
        var acts = el('div', 'tbs-acts');
        var ob = el('button', 'tbs-btn', '打开出处');
        ob.type = 'button';
        ob.addEventListener('click', function (e) {
          e.stopPropagation();
          if (K.app && K.app.openPath) K.app.openPath(x.file);
          toast('已打开：' + String(x.file || '').split('\\').pop());
        });
        acts.appendChild(ob);
        acts.appendChild(el('span', 'tbs-pop-hint', x.kind === 'card' ? '（写在共用定位卡里）' : '（写在那个场景自己的记忆里）'));
        r0.appendChild(acts);
      }
      list.appendChild(r0);
    });
    box.appendChild(list);
    var foot = el('div', 'tbs-pop-f');
    var b = el('button', 'tbs-btn', '重新扫一遍');
    b.type = 'button';
    b.addEventListener('click', function () { b.textContent = '扫描中…'; refreshPending().then(function () { b.textContent = '重新扫一遍'; }); });
    foot.appendChild(b);
    foot.appendChild(el('span', 'tbs-pop-hint', PEN.at ? ('更新于 ' + tstr(PEN.at)) : ''));
    box.appendChild(foot);
  }

  // ============================================================ ④ ⋯ 更多
  var MORE = { open: '' };
  var mPill = el('button', 'tbs-pill');
  mPill.type = 'button';
  mPill.innerHTML = '<span class="tbs-more">⋯</span>';
  mPill.title = '更多：磁盘余量 / 今天体检 / 搜文件脚本 / 打开常用文件夹';
  mPill.addEventListener('click', function () { MORE.open = ''; openPop(mPill, 'more', buildMore); });

  function accHead(box, key, icon, title, hint, onOpen) {
    var head = el('div', 'tbs-row');
    head.appendChild(el('span', 'tbs-row-ico', icon));
    var mid = el('div', 'tbs-row-mid');
    mid.appendChild(el('div', 'tbs-row-t', title));
    if (hint) mid.appendChild(el('div', 'tbs-row-s', hint));
    head.appendChild(mid);
    head.appendChild(el('span', 'tbs-caret', MORE.open === key ? '▾' : '▸'));
    head.title = [title, hint].filter(Boolean).join('\n');
    head.addEventListener('click', function () {
      MORE.open = (MORE.open === key) ? '' : key;
      if (MORE.open === key && onOpen) onOpen();
      repaint('more', buildMore);
    });
    box.appendChild(head);
  }
  function buildMore(box) {
    // 2026-10-19 宿主：从顶栏搬进 ⋯ 的两项（快照 / 助手）—— 放菜单最上面，展开即用，builder 直接复用。
    // 2026-10-22：启动动画预览已从 ⋯ 菜单撤掉（改到「设置 → 启动动画」插件页，见 buildMore 处的说明）
    // 2026-10-24：序号 / 外观 / 远程控制 三项从顶栏搬进来（点一行 = 点一下那个隐藏的原按钮）
    (function () {
      var row = function (ico, t, sub, id) {
        var r = el('div', 'tbs-row');
        r.appendChild(el('div', 'tbs-row-ico', ico));
        var mid = el('div', 'tbs-row-mid');
        mid.appendChild(el('div', 'tbs-row-t', t));
        mid.appendChild(el('div', 'tbs-row-s', sub));
        r.appendChild(mid);
        r.addEventListener('click', function () {
          closePop();
          var b = document.getElementById(id);
          if (b) b.click();
        });
        box.appendChild(r);
      };
      var badges = document.getElementById('sf-badges');
      var seqTxt = badges ? String(badges.textContent || '').replace(/^序号[:：]\s*/, '') : '';
      row('🌙', '外观', '深色 / 浅色 / 跟随系统（点一下切换）', 'btn-theme');
      row('#', '序号' + (seqTxt ? '：' + seqTxt : ''), '窗口标题上的两位序号徽标，显示/隐藏', 'sf-badges');
    })();
    accHead(box, 'rollback', '↩', '回退（界面 / 引擎）', '界面坏了→界面回退；配置起不来→引擎回退；源码坏了走 git', function () { refreshEngine(); refreshSnaps(); });
    if (MORE.open === 'rollback') {
      var rw = el('div', 'tbs-acc');
      // 2026-10-24 宿主「字太多了」⇒ 判断口诀收进悬停提示，界面上只留两块操作
    rw.title = '坑的判断：① 界面/按钮/面板坏 → 界面回退；② 引擎起不来/配置改坏 → 引擎回退；③ 源码或构建坏了 → 两个都不够，走 engine-before + git';
      buildSnaps(rw);
      buildEngine(rw);
      box.appendChild(rw);
    }
    accHead(box, 'helpers', '🧑‍🤝‍🧑', '助手', '各场景派出去干重活的帮手（带「在工作」灯）', loadHelpers);
    if (MORE.open === 'helpers') { var hw2 = el('div', 'tbs-acc'); buildHelpers(hw2); box.appendChild(hw2); }



    // 0 待办（谁在等我）—— 2026-10-16 用户要求：从顶栏胶囊收进这里，角标挂在 ⋯ 上
    var mineN = PEN.items.filter(needYou).length;
    if (MORE.open === 'disk') {
      var dw = el('div', 'tbs-acc');
      if (!DISK.rows.length) dw.appendChild(el('div', 'tbs-pop-hint', DISK.err ? ('读不到：' + DISK.err) : '读取中…'));
      DISK.rows.forEach(function (d) {
        var lvl = d.percent >= 88 ? 'bad' : (d.percent >= 75 ? 'warn' : 'ok');
        var line = el('div', 'tbs-disk');
        line.appendChild(el('span', 'tbs-disk-n', d.drive));
        var bar = el('div', 'tbs-bar');
        var fill = el('div', 'tbs-bar-f ' + lvl);
        fill.style.width = Math.max(2, Math.min(100, d.percent)) + '%';
        bar.appendChild(fill);
        line.appendChild(bar);
        line.appendChild(el('span', 'tbs-disk-v', '已用 ' + d.percent + '%　剩 ' + gb(d.free) + ' / 共 ' + gb(d.total)));
        dw.appendChild(line);
      });
      dw.appendChild(el('div', 'tbs-pop-hint', '快满了就去「本地电脑」那个场景让它清 —— 清理的活全归它。'));
      box.appendChild(dw);
    }

    // 2 今天的体检
    // 2 体检（2026-10-16 晚 按 dg-dsh 派单完善：① 头部合成一行 ② 每类带条目数徽标 ③ 点某类展开明细 ④ 底部一行）
    accHead(box, 'health', '🩺', '体检', healthHead(), loadHealth);
    if (MORE.open === 'health') {
      var hw = el('div', 'tbs-acc');
      if (HEALTH.state === 'loading') hw.appendChild(el('div', 'tbs-pop-hint', '读取中…'));
      else if (HEALTH.state === 'none') {
        hw.appendChild(el('div', 'tbs-pop-hint', '还没跑过体检（现在改成每周日 12:30 自动跑一次）。'));
        hw.appendChild(el('div', 'tbs-pop-hint', '想现在跑：让任意会话执行 `全量标准化体检.mjs`，回来点「重新读一次」即可。'));
      } else if (HEALTH.state === 'error') hw.appendChild(el('div', 'tbs-pop-hint', '读不到：' + HEALTH.err));
      else {
        (HEALTH.groups || []).forEach(function (g, gi) {
          var st = (g && g.status) || 'ok';
          var cls = st === 'ok' ? 'ok' : (st === 'warn' ? 'warn' : 'bad');
          var ct = g && g.counts;
          var key = String((g && g.name) || ('group' + gi));
          var open = !!HEALTH.open[key];
          var row = el('div', 'tbs-row tbs-fold');
          row.appendChild(el('span', 'tbs-arrow', open ? '▾' : '▸'));
          row.appendChild(el('span', 'tbs-row-ico', (g && g.icon) || '•'));
          var mid = el('div', 'tbs-row-mid');
          mid.appendChild(el('div', 'tbs-row-t', (g && g.name) || ''));
          if (g && g.note) mid.appendChild(el('div', 'tbs-row-s', String(g.note).slice(0, 70)));
          row.appendChild(mid);
          // 条目数徽标：⛔ 优先 → ⚠ → 全 ok 显示 ✓N；老快照没有 counts 就退回原来的 ✓/⚠/⛔ 单字
          if (ct) {
            var bcls = ct.bad ? 'bad' : (ct.warn ? 'warn' : 'ok');
            row.appendChild(el('span', 'tbs-pct ' + bcls, (ct.bad ? ('⛔' + ct.bad) : (ct.warn ? ('⚠' + ct.warn) : ('✓' + ct.ok)))));
          } else row.appendChild(el('span', 'tbs-pct ' + cls, st === 'ok' ? '✓' : (st === 'warn' ? '⚠' : '⛔')));
          row.addEventListener('click', function () { HEALTH.open[key] = !HEALTH.open[key]; repaint('more', buildMore); });
          hw.appendChild(row);
          if (!open) return;                                    // ← 折叠状态记得住（HEALTH.open）
          var items = Array.isArray(g && g.items) ? g.items : null;
          if (!items) { hw.appendChild(el('div', 'tbs-pop-hint', '　这一类没有逐项明细（老快照只有摘要，下次体检后就有）。')); return; }
          var bad = items.filter(function (it) { return it && it.status && it.status !== 'ok'; });
          if (!bad.length) { hw.appendChild(el('div', 'tbs-pop-hint', '　✅ ' + items.length + ' 项全过')); return; }
          bad.sort(function (a, b) { return (a.status === 'bad' ? 0 : 1) - (b.status === 'bad' ? 0 : 1); });
          var MAXI = 8;    // dg-dsh 建议：每类最多 8 条，超出打一行指到报告
          bad.slice(0, MAXI).forEach(function (it) {
            var iw = el('div', 'tbs-hd-item');
            iw.appendChild(el('div', 'tbs-hd-name', (it.status === 'bad' ? '⛔ ' : '⚠ ') + (it.name || '(无名)')));
            var dt = el('div', 'tbs-hd-detail', String(it.detail || ''));
            dt.title = '点一下复制全文';
            dt.addEventListener('click', function (e) { e.stopPropagation(); copyText(String(it.detail || '')); });
            iw.appendChild(dt);
            hw.appendChild(iw);
          });
          if (bad.length > MAXI) hw.appendChild(el('div', 'tbs-pop-hint', '　还有 ' + (bad.length - MAXI) + ' 条 —— 见 说明\\体检报告.md（§' + ((g && g.name) || '') + ' 那一节）'));
        });
        if (HEALTH.report) {
          var hb = el('button', 'tbs-btn', '打开报告全文');
          hb.type = 'button';
          hb.addEventListener('click', function () { if (K.app && K.app.openPath) K.app.openPath(HEALTH.report); });
          hw.appendChild(hb);
        }
        hw.appendChild(el('div', 'tbs-pop-hint', healthFoot()));
      }
      box.appendChild(hw);
    }

    // 3 搜文件 / 脚本
    accHead(box, 'search', '🔍', '搜文件 / 脚本', '在索引里找（比翻目录快）', null);
    if (MORE.open === 'search') {
      var sw = el('div', 'tbs-acc');
      var inp = el('input', 'tbs-input');
      inp.placeholder = '输入关键词，回车搜索（可空格分词）';
      inp.value = SEARCH.q || '';
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { SEARCH.q = inp.value.trim(); runSearch(); } });
      sw.appendChild(inp);
      if (SEARCH.busy) sw.appendChild(el('div', 'tbs-pop-hint', '搜索中…'));
      else if (SEARCH.done) {
        sw.appendChild(el('div', 'tbs-pop-hint', SEARCH.hits.length
          ? ('找到 ' + SEARCH.hits.length + ' 处（搜的是索引文件，不是全盘）· 点一行用默认程序打开')
          : '没找到。换个词，或让那个场景把新东西登记进索引。'));
        SEARCH.hits.slice(0, 24).forEach(function (h) {
          var r0 = el('div', 'tbs-row');
          r0.appendChild(el('span', 'tbs-dot'));
          var mid = el('div', 'tbs-row-mid');
          mid.appendChild(el('div', 'tbs-row-t', h.text));
          mid.appendChild(el('div', 'tbs-row-s', h.label));
          r0.appendChild(mid);
          r0.addEventListener('click', function () { if (K.app && K.app.openPath) K.app.openPath(h.file); });
          sw.appendChild(r0);
        });
      }
      box.appendChild(sw);
      setTimeout(function () { try { inp.focus(); } catch (e) { /* ignore */ } }, 0);
    }

    // 4 常用文件夹 —— 2026-10-16 用户要求「放出来」⇒ 已提升为顶栏一级胶囊（见 buildFolders），这里不再重复。
  }

  // ---- ⋯ 里的三块数据 ----
  var DISK = { rows: [], err: null, at: 0 };
  function loadDisks() {
    if (DISK.at && Date.now() - DISK.at < 10000) return;
    DISK.at = Date.now();
    if (!(K.sys && K.sys.disks)) { DISK.err = '这个宿主没有磁盘接口'; return; }
    Promise.resolve().then(function () { return K.sys.disks(); }).then(function (r) {
      var rows = (r && r.drives) || [];
      DISK.rows = rows.filter(function (d) { return d && d.ok !== false; })
        .map(function (d) { return { drive: d.drive, percent: d.percent, free: d.free, total: d.total }; });
      DISK.err = rows.length ? null : '没读到分区';
      repaint('more', buildMore);
    }).catch(function (e) { DISK.err = String((e && e.message) || e); repaint('more', buildMore); });
  }
  var HEALTH = { state: '', at: 0, time: '', verdict: '', ok: 0, warn: 0, bad: 0, report: '', groups: [], err: null , totals: null, sources: [], open: {} };
  // 头部/底部两行（2026-10-16 晚：头部原来在标题和卡身各写一遍 ⇒ 合成一行；底部补"共 N 项明细 · 来源 M 个子检查"）
  function healthHead() {
    if (HEALTH.state === 'none') return '还没跑过';
    var s = '上次体检 ' + (HEALTH.time || '—') + ' · ' + (HEALTH.verdict || '');
    s += ' · ✓' + HEALTH.ok + ' ⚠' + HEALTH.warn + ' ⛔' + HEALTH.bad;
    if (HEALTH.totals) s += ' · 逐项 ' + HEALTH.totals.items + '（✅' + HEALTH.totals.ok + ' ⚠' + HEALTH.totals.warn + ' · ⛔' + HEALTH.totals.bad + '）';
    return s;
  }
  function healthFoot() {
    if (!HEALTH.totals) return '生成 ' + (HEALTH.time || '—') + '　·　明细全文见 说明\\体检报告.md';
    return '生成 ' + (HEALTH.time || '—') + '　·　共 ' + HEALTH.totals.items + ' 项明细 · 来源 ' + ((HEALTH.sources || []).length || '?') + ' 个子检查 · 每周日 12:30 自动　·　明细全文见 说明\\体检报告.md';
  }
  function loadHealth() {
    if (HEALTH.at && Date.now() - HEALTH.at < 60000 && HEALTH.state) return;
    HEALTH.at = Date.now();
    HEALTH.state = 'loading';
    // 2026-10-16 改：不再读「_基础体检-<今天>.md」（那是每天跑的产物，改成每周日后就不存在了 ⇒ 用户看到"今天这份还没生成"）。
    // 现在固定读引擎侧 `全量标准化体检.mjs` 写的卡片数据；报告路径也用它给的 json.report。
    var f = ROOT + '\\引擎\\场景项目信息\\_体检-latest.json';
    if (!(K.file && K.file.read)) { HEALTH.state = 'error'; HEALTH.err = '这个宿主没有读文件接口'; return; }
    Promise.resolve().then(function () { return K.file.read(f); }).then(function (t) {
      var o = null;
      try {
        if (t && typeof t === 'object' && !t.text) o = t;                       // 宿主直接给了对象
        else { var s = (typeof t === 'string') ? t : ((t && t.text) || ''); if (!s) throw new Error('空'); o = JSON.parse(s); }
      } catch (e) { o = null; }
      if (!o) { HEALTH.state = 'error'; HEALTH.err = '读不到或解析失败'; repaint('more', buildMore); return; }
      HEALTH.time = o.time || '';
      HEALTH.verdict = o.verdict || '';
      HEALTH.ok = o.ok || 0;
      HEALTH.warn = o.warn || 0;
      HEALTH.bad = o.bad || 0;
      HEALTH.report = o.report || '';
      HEALTH.groups = Array.isArray(o.groups) ? o.groups : [];
      HEALTH.totals = o.totals || null;
      HEALTH.sources = Array.isArray(o.sources) ? o.sources : [];
      HEALTH.state = 'ok';
      repaint('more', buildMore);
    }).catch(function () { HEALTH.state = 'none'; repaint('more', buildMore); });
  }
  var SEARCH = { q: '', hits: [], done: false, busy: false };
  function runSearch() {
    if (!SEARCH.q) return;
    SEARCH.busy = true; SEARCH.done = false; SEARCH.hits = [];
    repaint('more', buildMore);
    var terms = SEARCH.q.toLowerCase().split(/\s+/).filter(Boolean);
    var jobs = INDEX_FILES.map(function (ix) {
      return Promise.resolve().then(function () { return K.file.read(ix.file); }).then(function (t) {
        var s = typeof t === 'string' ? t : ((t && t.text) || '');
        var out = [];
        s.split(/\r?\n/).forEach(function (line) {
          if (!line.trim()) return;
          var low = line.toLowerCase();
          if (terms.every(function (x) { return low.indexOf(x) >= 0; })) {
            out.push({
              label: ix.label, file: ix.file,
              text: line.trim().replace(/^\|\s*/, '').replace(/\s*\|\s*$/, '').slice(0, 150)
            });
          }
        });
        return out;
      }).catch(function () { return []; });
    });
    Promise.all(jobs).then(function (arrs) {
      var all = [];
      arrs.forEach(function (a) { all = all.concat(a); });
      SEARCH.hits = all;
      SEARCH.busy = false;
      SEARCH.done = true;
      repaint('more', buildMore);
    });
  }

  // ============================================================ ⑤ 助手（帮手会话，2026-10-16 用户点名）
  //   数据源：引擎侧写 `外壳\data\助手会话.json`（合同见《标准化规范》§2.13）；**压力复用 topbar:pressure 的 helpers**，不另算。
  //   点「打开」= 切到它所属场景（帮手没有自己的面板）；切不动就退化成复制 id。
  var HELP = { at: 0, rows: [], err: null, ready: false };
  var hPill = el('button', 'tbs-pill');
  hPill.type = 'button';
  hPill.innerHTML = '<span class="tbs-row-ico">🧑‍🤝‍🧑</span><span class="tbs-txt">助手</span>';
  hPill.title = '各场景的帮手会话（按场景分组看，含上下文压力）';
  hPill.addEventListener('click', function () { openPop(hPill, 'helpers', buildHelpers); loadHelpers(); });

  function copyText(t) {
    try {
      var ta = document.createElement('textarea');
      ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
      toast('已复制：' + t);
    } catch (e) { toast('复制失败：' + ((e && e.message) || e), true); }
  }
  function loadHelpers() {
    if (!TB || !TB.pressure) { HELP.err = '这个宿主还没有压力接口'; repaintHelpers(); return; }
    Promise.resolve().then(function () { return TB.pressure(); }).then(function (r) {
      HELP.at = Date.now();
      HELP.ready = true;
      HELP.err = (r && r.ok === false) ? ((r && r.error) || '读不到') : null;
      HELP.rows = (r && r.helpers) || [];
      HELP.noField = !!r && r.helpers === undefined;      // 老主进程（没重启）⇒ 温和提示
      repaintHelpers();
    }).catch(function (e) { HELP.err = String((e && e.message) || e); repaintHelpers(); });
  }
  function sceneIdOf(h) {
    var want = String((h && (h.panel || h.scene)) || '');
    var hit = (SCENES || []).filter(function (s) {
      if (!s) return false;
      var t = String(s.title || ''), i = String(s.id || '');
      return (want && (t.indexOf(want) >= 0 || want.indexOf(t) >= 0 || i === want));
    })[0];
    return hit ? hit.id : '';
  }
  function pressChip(pct) {
    var lvl = pct >= 400 ? 'bad' : (pct >= 100 ? 'warn' : 'ok');
    return { cls: lvl, txt: pct + '%' };
  }
  var HELP = { at: 0, rows: [], err: null, ready: false, noField: false };
  function buildHelpers(box) {
    var on = 0;
    HELP.rows.forEach(function (h) { if (glowOf(h.fullId) === true) on++; });
    box.appendChild(el('div', 'tbs-pop-h', '各场景的帮手会话 · ' + HELP.rows.length + ' 个' + (on ? ('（' + on + ' 个正在干活）') : '')));
    box.appendChild(el('div', 'tbs-pop-sub', '帮手是各场景主会话派出去干重活的独立会话（没有自己的面板）。**亮灯 = 正在干活**（跟场景标签同一个判据）。'));
    if (HELP.noField) {
      box.appendChild(el('div', 'tbs-pop-hint', '⚠ 压力列要 重启一次工作台 才显示 —— 取数在主进程 main.js 里。'));
      box.appendChild(el('div', 'tbs-pop-hint', '重启后我会复验：这批帮手每条都带上真实百分比，并跑一次 check-gui。'));
    }
    if (!HELP.ready) box.appendChild(el('div', 'tbs-pop-hint', '读取中…'));
    else if (HELP.err) box.appendChild(el('div', 'tbs-pop-hint', '读不到：' + HELP.err));
    if (HELP.ready && !HELP.rows.length && !HELP.err) {
      box.appendChild(el('div', 'tbs-pop-hint', '还没有登记帮手。'));
      box.appendChild(el('div', 'tbs-pop-hint', '用引擎侧 助手会话.mjs --add 登记（规矩见《标准化规范》§2.13）；目前只有<客户>有。'));
    }
    WORK.dots = {};
    var order = [], groups = {};
    HELP.rows.forEach(function (h) {
      var head = (h.sceneName || h.scene || h.sceneId || '未指定场景') + (h.panel ? (' · ' + h.panel) : '');
      if (!groups[head]) { groups[head] = []; order.push(head); }
      groups[head].push(h);
    });
    order.forEach(function (head) {
      var arr = groups[head];
      var busyN = arr.filter(function (h) { return glowOf(h.fullId) === true; }).length;
      var folded = HELP.fold && HELP.fold[head];
      var hd = foldHead(box, !folded, '◈', head, arr.length, busyN ? (busyN + ' 个正在干活') : '点一下折叠/展开');
      hd.addEventListener('click', function () {
        HELP.fold = HELP.fold || {};
        HELP.fold[head] = !HELP.fold[head];
        repaintHelpers();
      });
      box.appendChild(hd);
      if (folded) return;
      arr.forEach(function (h) {
        var row = el('div', 'tbs-row');
        var dot = el('span', 'tbs-dot' + (glowOf(h.fullId) === true ? ' tbs-work' : ''));
        dot.title = glowOf(h.fullId) === true ? '正在干活' : (glowOf(h.fullId) === false ? '闲置' : '还没测到状态');
        WORK.dots[h.fullId] = dot;
        row.appendChild(dot);
        var mid = el('div', 'tbs-row-mid');
        mid.appendChild(el('div', 'tbs-row-t', h.title || '(无标题)'));
        var has = !(h.pct === null || h.pct === undefined);
        mid.appendChild(el('div', 'tbs-row-s', has
          ? ('用了 ' + humans(h.projected) + ' / 线 ' + humans(h.line) + '　·　聊了 ' + h.turns + ' 轮' + (h.since ? ('　·　' + h.since) : ''))
          : ('压力 —（引擎还没这条会话的用量数据）' + (h.since ? ('　·　' + h.since) : ''))));
        mid.appendChild(el('div', 'tbs-row-s', String(h.fullId)));
        if (h.note) mid.appendChild(el('div', 'tbs-row-s', h.note));
        row.appendChild(mid);
        if (has) { var p = pressChip(h.pct); row.appendChild(el('span', 'tbs-pct ' + p.cls, p.txt)); }
        else row.appendChild(el('span', 'tbs-pct', '—'));
        var b1 = el('button', 'tbs-btn', '打开');
        b1.type = 'button';
        b1.addEventListener('click', function (e) {
          e.stopPropagation();
          var sid = sceneIdOf(h);
          if (sid && window.__dshGotoScene && window.__dshGotoScene(sid)) { toast('已切到该场景：' + sid + '（帮手没有自己的面板，id 已复制）'); copyText(h.fullId); closePop(); }
          else copyText(h.fullId);
        });
        row.appendChild(b1);
        var b2 = el('button', 'tbs-btn', '复制 id');
        b2.type = 'button';
        b2.addEventListener('click', function (e) { e.stopPropagation(); copyText(h.fullId); });
        row.appendChild(b2);
        box.appendChild(row);
      });
    });
    var foot = el('div', 'tbs-pop-f');
    var b = el('button', 'tbs-btn', '重新读一次');
    b.type = 'button';
    b.addEventListener('click', function () { b.textContent = '读取中…'; loadHelpers(); setTimeout(function () { b.textContent = '重新读一次'; }, 600); });
    foot.appendChild(b);
    foot.appendChild(el('span', 'tbs-pop-hint', HELP.at ? ('更新于 ' + tstr(HELP.at)) : ''));
    box.appendChild(foot);
    WORK.root = box;
    startWork();
  }
  // 2026-10-16：帮手"在工作"的灯 —— **复用场景标签那套判据**（renderers.js 的 glowReadState：
  //   引擎状态缓存里 openStep 非空 / pendingCalls 非空 / 子代理新鲜）⇒ 不另造一套。
  //   只在"助手弹层开着"时每 3 秒测一次，关掉就自停（不为看不见的东西白耗）。
  var WORK = { cache: {}, timer: null, root: null, dots: {} };
  function glowOf(sid) {
    var c = WORK.cache[sid];
    return (c && (Date.now() - c.at < 9000)) ? c.busy : null;
  }
  function workTick() {
    if (!WORK.root || !WORK.root.isConnected) {
      if (WORK.timer) { clearInterval(WORK.timer); WORK.timer = null; }
      return;
    }
    if (typeof window.glowReadState !== 'function') return;   // 宿主没有现成判据 ⇒ 不猜，宁可没灯
    var ids = (HELP.rows || []).map(function (h) { return h.fullId; });
    var i = 0;
    (function next() {
      if (i >= ids.length) return;
      var sid = ids[i++];
      Promise.resolve().then(function () { return window.glowReadState(sid, false); })
        .then(function (st) { WORK.cache[sid] = { at: Date.now(), busy: !!(st && st.busy) }; })
        .catch(function () { WORK.cache[sid] = { at: Date.now(), busy: false }; })
        .then(function () {
          var d = WORK.dots[sid];
          if (d && d.isConnected) d.classList.toggle('tbs-work', WORK.cache[sid].busy === true);
          next();
        });
    })();
  }
  function startWork() {
    workTick();
    if (!WORK.timer) WORK.timer = setInterval(workTick, 3000);
  }
  // ============================================================ ⑥ 负载胶囊（CPU / GPU 实时）
  //   2026-10-19 宿主：N 卡的浮层（GPU 28% 41°C | CPU 30% 75°C）挡住界面 ⇒ 把同样的读数搬进顶栏，
  //   放在「手机远程」左边，这样关掉浮层也能一眼看到。
  //   ⚠ 资源纪律：**只在这个窗口有焦点时**每 5 秒取一次；不在前台 = 一次都不取（点开看明细才额外取）。
  var LOAD = { at: 0, cpu: null, gpu: null, err: null, busy: false };
  var lPill = el('button', 'tbs-pill tbs-load');
  lPill.type = 'button';
  lPill.id = 'tbs-load';
  lPill.title = '本机负载：CPU / GPU（点开看明细）';
  function paintLoad() {
    var cpu = (LOAD.cpu === null || LOAD.cpu === undefined) ? '—' : (LOAD.cpu + '%');
    var gpu = LOAD.gpu ? (LOAD.gpu.util + '%') : '—';
    var mem = (LOAD.mem && typeof LOAD.mem.usedPct === 'number') ? (LOAD.mem.usedPct + '%') : '—';   // 2026-10-20 内存   // 2026-10-19 宿主：胶囊里不显示温度（温度放点开的明细里）
    var lvl = (typeof LOAD.cpu === 'number' && LOAD.cpu >= 90) ? 'bad' : (typeof LOAD.cpu === 'number' && LOAD.cpu >= 70 ? 'warn' : '');
    lPill.innerHTML = '<span class="tbs-txt"><span class="tbs-k">CPU</span><b>' + cpu + '</b></span>'
      + '<span class="tbs-txt"><span class="tbs-k">GPU</span><b>' + gpu + '</b></span>'
      + '<span class="tbs-txt"><span class="tbs-k">MEM</span><b>' + mem + '</b></span>';
    lPill.className = 'tbs-pill tbs-load' + (lvl ? ' ' + lvl : '');
    lPill.title = '本机负载：CPU ' + cpu + ' · GPU ' + gpu + (LOAD.gpu ? ('（' + LOAD.gpu.memUsed + '/' + LOAD.gpu.memTotal + ' MB 显存）') : '') + '　·　点开看明细';
  }
  function refreshLoad() {
    if (LOAD.busy) return;
    if (!(K.sys && K.sys.load)) { LOAD.err = '这个宿主还没有负载接口（要重启一次工作台）'; paintLoad(); return; }
    LOAD.busy = true;
    Promise.resolve().then(function () { return K.sys.load(); }).then(function (r) {
      LOAD.busy = false;
      LOAD.at = Date.now();
      LOAD.err = (r && r.ok === false) ? '读不到' : null;
      LOAD.cpu = (r && typeof r.cpu === 'number') ? r.cpu : LOAD.cpu;
      LOAD.gpu = (r && r.gpu) ? r.gpu : null;
      LOAD.mem = (r && r.mem) ? r.mem : null;
      paintLoad();
      if (typeof POP !== 'undefined' && POP && POP.key === 'load') repaint('load', buildLoad);
    }).catch(function (e) { LOAD.busy = false; LOAD.err = String((e && e.message) || e); paintLoad(); });
  }
  function buildLoad(box) {
    box.appendChild(el('div', 'tbs-pop-h', '本机负载'));
    box.appendChild(el('div', 'tbs-pop-sub', 'CPU 用系统差值算（零子进程）；GPU 走 nvidia-smi（每 5 秒一次，仅当这个窗口在前台）。'));
    var cpu = (typeof LOAD.cpu === 'number') ? (LOAD.cpu + '%') : '—';
    var g = LOAD.gpu;
    box.appendChild(el('div', 'tbs-row')).appendChild(el('div', 'tbs-row-t', 'CPU ' + cpu));
    if (g) {
      box.appendChild(el('div', 'tbs-row')).appendChild(el('div', 'tbs-row-t', g.name + '　GPU ' + g.util + '%　' + g.temp + '°C　显存 ' + g.memUsed + '/' + g.memTotal + ' MB'));
    }
    if (LOAD.mem) {
      box.appendChild(el('div', 'tbs-row')).appendChild(el('div', 'tbs-row-t', '内存　已用 ' + LOAD.mem.usedPct + '%　' + LOAD.mem.usedGB + ' / ' + LOAD.mem.totalGB + ' GB'));
    } else {
      box.appendChild(el('div', 'tbs-pop-hint', LOAD.err ? ('GPU：' + LOAD.err) : 'GPU：没有读到（没有 N 卡，或 nvidia-smi 不可用）'));
    }
    var foot = el('div', 'tbs-pop-f');
    var b = el('button', 'tbs-btn', '刷新一下');
    b.type = 'button';
    b.addEventListener('click', function () { b.textContent = '读取中…'; refreshLoad(); setTimeout(function () { b.textContent = '刷新一下'; }, 800); });
    foot.appendChild(b);
    foot.appendChild(el('span', 'tbs-pop-hint', LOAD.at ? ('更新于 ' + tstr(LOAD.at)) : ''));
    box.appendChild(foot);
  }
  // 2026-10-23（宿主：「这个点击查看明细没有用」）—— 胶囊一直只画不绑点击（buildLoad 早就写好了，没人调它）。
  //   这里补上：点胶囊 ⇒ 先刷一次数据，再弹「本机负载」明细浮层（再点一下收起）。
  function bindLoadClick(pill) {
    if (!pill || pill.dataset.bound === '1') return;
    pill.dataset.bound = '1';
    pill.addEventListener('click', function () {
      refreshLoad();
      openPop(pill, 'load', buildLoad);
    });
  }
  function mountLoad() {
    var exist = document.getElementById('tbs-load');
    if (exist) { bindLoadClick(exist); return; }
    var remoteBtn = document.getElementById('btn-remote');
    if (remoteBtn && remoteBtn.parentNode) remoteBtn.parentNode.insertBefore(lPill, remoteBtn);   // ← 「手机远程」左边
    else wrap.appendChild(lPill);
    bindLoadClick(lPill);
    paintLoad();
    refreshLoad();
    setInterval(function () { if (document.hidden) return; if (!document.hasFocus()) return; refreshLoad(); }, 5000);
    window.addEventListener('focus', function () { if (!document.hidden) refreshLoad(); });
  }
  // ============================================================ 启动
  // 文件夹胶囊（2026-10-16 用户：「打开常用文件夹功能放出来」⇒ 从 ⋯ 里提到顶栏一级）
  // buildFolders 用函数声明（会提升）⇒ 在这里定义、上面 mount 之后就能用。
  var fPill = el('button', 'tbs-pill');
  fPill.type = 'button';
  fPill.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">'
    + '<path d="M1.9 4.3c0-.8.6-1.4 1.4-1.4h2.6l1.3 1.5h5.5c.8 0 1.4.6 1.4 1.4v6.2c0 .8-.6 1.4-1.4 1.4H3.3c-.8 0-1.4-.6-1.4-1.4V4.3Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>'
    + '<span class="tbs-txt">文件夹</span>';
  fPill.title = '打开常用文件夹（工程文件 / 视频工作流 / 视频编辑素材 / 收录素材 / 成品 / 项目工程 / DSH 根）';
  fPill.addEventListener('click', function () { openPop(fPill, 'folders', buildFolders); loadRecent(); });

  // ⛔ 2026-10-21：这里原来 push 了「场景记忆 / 工具」两个，凑成 8 个。
  //    宿主把常用文件夹定死（2026-10-27 起 7 个，含 `<工作台>`；见文件头 FOLDERS），所以不再追加 —— 要加先问宿主。

  // 最近打开的文件夹（Windows「最近使用」记录；2026-10-16 用户要求：按最新时间显示 6 个）
  var RECENT = { at: 0, rows: [], err: null, busy: false };
  function loadRecent() {
    if (RECENT.busy) return;
    if (!(TB && TB.recentFolders)) {
      RECENT.err = '这个宿主还没有这个接口（要重启一次工作台才有）';
      repaint('folders', buildFolders);
      return;
    }
    RECENT.busy = true;
    Promise.resolve().then(function () { return TB.recentFolders(); }).then(function (r) {
      RECENT.busy = false;
      RECENT.at = Date.now();
      RECENT.rows = (r && r.rows) || [];
      RECENT.err = (r && r.error) || null;
      repaint('folders', buildFolders);
    }).catch(function (e) {
      RECENT.busy = false;
      RECENT.err = String((e && e.message) || e);
      repaint('folders', buildFolders);
    });
  }
  function folderRow(p, sub, note, titleText) {
    var r0 = el('div', 'tbs-row');
    r0.appendChild(el('span', 'tbs-row-ico', '📁'));
    var mid = el('div', 'tbs-row-mid');
    // 常用文件夹给了 label 就用它当标题（同名的"重新开始…"靠 label 区分），下面一行显示完整路径
    mid.appendChild(el('div', 'tbs-row-t', titleText || String(p).split('\\').filter(Boolean).pop() || p));
    var line2 = el('div', 'tbs-row-s', sub || p);
    if (note) { line2.textContent = (sub ? sub + '　·　' : '') + note; }
    mid.appendChild(line2);
    r0.appendChild(mid);
    r0.title = p;
    r0.addEventListener('click', function () {
      if (K.app && K.app.revealPath) K.app.revealPath(p);
      closePop();
    });
    return r0;
  }
  function buildFolders(box) {
    // ① 最近打开的（真实来源：资源管理器跳转列表 + 最近使用 + 地址栏敲过的路径）
    box.appendChild(el('div', 'tbs-pop-h', '最近打开的文件夹'));
    if (!RECENT.at && !RECENT.err) box.appendChild(el('div', 'tbs-pop-hint', '读取中…'));
    else if (RECENT.err) box.appendChild(el('div', 'tbs-pop-hint', '读不到：' + RECENT.err));
    else if (!RECENT.rows.length) box.appendChild(el('div', 'tbs-pop-hint', '（没找到最近记录）'));
    RECENT.rows.slice(0, 6).forEach(function (x) {
      box.appendChild(folderRow(x.path, '最后改动 ' + tstr(x.at), x.src));
    });
    // ② 常用（客户可自改，见文件头 FOLDERS；第 7 个 <工作台> 是 2026-10-27 加的）
    box.appendChild(el('div', 'tbs-pop-h', '常用文件夹'));
    box.appendChild(el('div', 'tbs-pop-sub', '点一行就在资源管理器里定位过去（只是定位，不会打开或改动任何文件）。'));
    FOLDERS.forEach(function (f) { box.appendChild(folderRow(f.p, null, null, f.label)); });
  }

  // 2026-10-16 用户要求：**删掉顶栏那颗「⚙ 设置」**（原话：「切到主界面打开设置最稳定，这个一直跳来跳去」）。
  // index.html 里已把该元素删掉，这里再兜一次（旧缓存 / 从备份还原的情况）；
  // 顺带它也是"版本哨"：main.js 的刷新通道只认本文件 mtime ⇒ 改这里就能让主窗口整页重载一次。
  try {
    var bsBtn = document.getElementById('btn-settings');
    if (bsBtn && bsBtn.parentNode) bsBtn.parentNode.removeChild(bsBtn);
  } catch (e) { /* ignore */ }

  mount();
  // 2026-10-19 宿主：快照移进 ⋯ 菜单（胶囊不撤代码，想按回来一行即可）
  // wrap.appendChild(sPill);
  // 2026-10-23 宿主：「这个会话压力不需要了删掉这个功能」⇒ 胶囊 + ⋯ 菜单条目 + 明细面板**整段删除**
  //   （引擎侧 `topbar:pressure` IPC 与 ctx.mjs 仍保留，命令行照常能查；只是界面不再展示）
  wrap.appendChild(fPill);
    // 2026-10-19 宿主：助手移进 ⋯ 菜单（同上，代码留着）
  // wrap.appendChild(hPill);
  wrap.appendChild(mPill);
  mountLoad();   // 2026-10-19：负载胶囊 ⇒ 插到「手机远程」左边
  // ⚠ 铃铛胶囊（原 bPill）已按用户要求收进 ⋯ 菜单 ⇒ 不再挂到顶栏；它的**角标改挂到 mPill 上**（见 paintPending）。
  try {
    var bar0 = document.getElementById('titlebar');
    if (bar0 && window.MutationObserver) {
      new MutationObserver(function () { if (!document.getElementById('tbs-wrap')) mount(); })
        .observe(bar0.parentNode || document.body, { childList: true, subtree: false });
    }
  } catch (e) { /* 装饰失败不影响主流程 */ }

})();

// 2026-10-19 21:4x bootstrap: touch ⇒ main.js 的 mtime 哨兵整页重载（首次装上 CSS 热重载与验证标记）
// 2026-10-19 22:4x park: touch ⇒ 整页重载，让 renderers.js 末尾的 webview 停车机制装上
// 2026-10-19 23:1x park-fix: touch ⇒ 整页重载（让去掉 pointer-events 的停车逻辑生效）
// 2026-10-19 23:2x probe: touch ⇒ 整页重载，装上点击探针
// 2026-10-19 23:3x focus: touch ⇒ 整页重载（装上激活时 focus 钩子）
// 2026-10-19 23:3x remount: touch ⇒ 整页重载（启用激活后重挂 webview）
// 2026-10-19 23:4x linkfix: touch ⇒ 整页重载（页面内接管新窗口链接）
// 2026-10-19 23:4x linkfix2: touch ⇒ 整页重载
// 2026-10-19 23:5x linkfix3: touch
// 2026-10-19 23:5x previewmenu: touch ⇒ 整页重载（装上 ⋯ 里的预览入口）
// 2026-10-19 23:5x previewmenu2: touch
// 2026-10-19 23:5x previewmenu3: touch
// 2026-10-19 23:5x previewlive: touch
// 2026-10-19 23:5x previewlive2: touch
// 2026-10-19 23:5x previewlive3: touch
// 2026-10-20 videoanim: touch
// 2026-10-20 swapvideo: touch
// 2026-10-20 swapvideo2: touch
// 2026-10-20 onlyone: touch
// 2026-10-20 memfix: touch
// 2026-10-26 touch: 新场景「刷抖音」需要整页重载才能建出标签
// 2026-10-26 第二次 touch（配合 reload 命令，触发整页重载建标签）
