/* ============================================================================
   05-顶栏/更多菜单与回退占位.js —— 顶栏「⋯」菜单 + 「回退序号」外观占位

   ★ 真实接口（2026-10-25 核对，preload 里能看到的）：
       window['kun'].topbar.snapshots()  → { rows: [...], total: N }   （不是数组！）
       window['kun'].topbar.snapshot()   → **新建一份快照**（⚠ 不是回退）
       window['kun'].app.openPath(p)     → 用系统程序打开路径/目录

   ⚠ 所以：
     · 数第几代要读 {total}，列表在 {rows}
     · 「回退」这个动作**本文件不做**（没有对应的 preload IPC）⇒ 点开只提示去外壳的设置里回退，
       绝不调 snapshot()（那是新建，会把"回退"变成"又存一份"）

   ⛔ 回退是可逆性承诺：拿不到快照接口就显示禁用灰条「回退：未接入」。
============================================================================ */

(function () {
  'use strict';

  function ns() { return window['kun'] || window.app || null; }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // ── 「回退 #N」：真实接口 = kun.topbar.snapshots() → { rows, total } ────────
  async function mountRollbackChip() {
    var host = document.querySelector('#titlebar .titlebar-controls') ||
               document.querySelector('#scenebar .scenebar-right');
    if (!host || document.getElementById('rb-chip')) return;

    var A = ns();
    var api = (A && A.topbar && typeof A.topbar.snapshots === 'function') ? A.topbar : null;

    var chip = el('button', 'tb-btn rb-chip');
    chip.id = 'rb-chip';

    if (!api) {
      chip.textContent = '回退：未接入';
      chip.disabled = true;
      chip.title = '你的外壳没有暴露 kun.topbar.snapshots ⇒ 这里只占位，不给假按钮';
      chip.style.opacity = '.55';
      chip.style.cursor = 'not-allowed';
      host.insertBefore(chip, host.firstChild);
      return;
    }

    try {
      var r = await api.snapshots();
      // ⚠ 真实返回是 { rows, total }；也兼容数组（别的外壳）
      var n = Array.isArray(r) ? r.length : (r && (typeof r.total === 'number' ? r.total : (Array.isArray(r.rows) ? r.rows.length : 0)));
      chip.textContent = '回退 #' + n;
      chip.title = '当前快照第 ' + n + ' 代 · 点开看怎么回退';
      chip.addEventListener('click', function () {
        // 本文件**不执行回退**：preload 里没有回退 IPC；只给指引，别拿 snapshot() 冒充
        alert('当前共 ' + n + ' 份快照。\n回退请在你的外壳「设置 → 快照/版本」里选择要回到的那一代。');
      });
    } catch (e) {
      chip.textContent = '回退：读取失败';
      chip.title = '快照接口报错：' + ((e && e.message) || e);
      chip.disabled = true;
    }
    host.insertBefore(chip, host.firstChild);
  }

  // ── 「⋯」菜单：只列当前外壳**真有**的入口 ─────────────────────────────────
  function mountMoreMenu() {
    if (document.getElementById('tb-more')) return;
    var host = document.querySelector('#titlebar .titlebar-controls');
    if (!host) return;

    var A = ns();
    var openPath = (A && A.app && typeof A.app.openPath === 'function') ? A.app.openPath : null;

    var btn = el('button', 'tb-btn', '⋯');
    btn.id = 'tb-more';
    btn.title = '更多';

    var panel = el('div', 'tb-more-panel');
    panel.id = 'tb-more-panel';

    var items = [];

    // 目录类入口：只有外壳**主动注入了路径**才列（preload 只给 openPath，不给目录）
    var shellDir = window.__SHELL_DIR || (A && A.app && (A.app.shellDir || A.app.rootDir)) || '';
    if (openPath && shellDir) {
      items.push({ label: '打开外壳目录', fn: function () { openPath(shellDir); } });
    }
    var dataDir = window.__SHELL_DATA_DIR || (A && A.app && (A.app.dataDir || A.app.userDataDir)) || '';
    if (openPath && dataDir) {
      items.push({ label: '打开数据目录', fn: function () { openPath(dataDir); } });
    }
    // 版本信息：有变量才显示
    if (window.APP_VERSION || window.ENGINE_VERSION) {
      items.push({ label: '版本信息', fn: function () {
        alert('工作台 ' + (window.APP_VERSION || '—') + '\n引擎 ' + (window.ENGINE_VERSION || '—'));
      } });
    }
    // 一个都没有 ⇒ 一句实话，不放空菜单
    if (!items.length) {
      var tip = el('div', 'tb-more-empty', '这个外壳没暴露可用的入口');
      panel.appendChild(tip);
    }

    items.forEach(function (it) {
      var row = el('button', 'tb-more-item', it.label);
      row.addEventListener('click', function () {
        try { it.fn(); } catch (e) { alert('这个入口在你外壳里不可用：' + ((e && e.message) || e)); }
        panel.style.display = 'none';
      });
      panel.appendChild(row);
    });

    btn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    });
    document.addEventListener('click', function () { panel.style.display = 'none'; });

    host.appendChild(btn);
    host.appendChild(panel);
  }

  function start() {
    try { mountMoreMenu(); } catch (e) {}
    mountRollbackChip().catch(function () {});
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
