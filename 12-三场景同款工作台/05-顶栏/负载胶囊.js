/* ============================================================================
   05-顶栏/负载胶囊.js —— CPU / GPU / 内存 实时胶囊
   目的：顶栏右侧显示「CPU 10% · GPU 9% · MEM 42%」，≥70% 黄、≥90% 红。

   怎么接：
   ① 外壳主进程提供一个只读接口（示例：IPC 'sys:load' 或 HTTP /api/load），
      返回 { cpu: 10, gpu: { util: 9, memUsed: 2048, memTotal: 8192 }, mem: { usedPct: 42 } }
   ② 渲染层调它 → 画胶囊。下面 probeLoad() 默认走 IPC，没有就退回 HTTP。

   ⛔ 不要在前端直接读 WMI / 显卡驱动：一是权限，二是阻塞界面。
============================================================================ */

(function () {
  'use strict';

  var LOAD = { cpu: null, gpu: null, mem: null, err: null, busy: false, at: 0 };
  var POLL_MS = 4000;          // 轮询间隔
  var pill = null;

  // ── 适配点：换成你外壳的取数接口 ──────────────────────────────────────────
  async function probeLoad() {
    // 1) Electron / 外壳注入的 IPC 桥（优先）
    if (window.app && window.app.sys && typeof window.app.sys.load === 'function') {
      return await window.app.sys.load();
    }
    // 2) 本地 HTTP 接口（很多外壳会开一个本地服务）
    var r = await fetch('/api/load', { cache: 'no-store' });
    if (!r.ok) throw new Error('http ' + r.status);
    return await r.json();
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function ensurePill() {
    if (pill && pill.isConnected) return pill;
    var host = document.querySelector('#titlebar .titlebar-controls') ||
               document.querySelector('#scenebar .scenebar-right') ||
               document.getElementById('titlebar');
    if (!host) return null;
    pill = document.getElementById('tbs-load');
    if (!pill) {
      pill = el('button', 'tbs-pill tbs-load');
      pill.id = 'tbs-load';
      pill.title = '本机负载：CPU / GPU / 内存（点开看明细）';
      host.insertBefore(pill, host.firstChild);
    }
    return pill;
  }

  function paint() {
    var p = ensurePill();
    if (!p) return;
    var cpu = (typeof LOAD.cpu === 'number') ? LOAD.cpu + '%' : '—';
    var gpu = (LOAD.gpu && typeof LOAD.gpu.util === 'number') ? LOAD.gpu.util + '%' : '—';
    var mem = (LOAD.mem && typeof LOAD.mem.usedPct === 'number') ? LOAD.mem.usedPct + '%' : '—';

    p.className = 'tbs-pill tbs-load' +
      (typeof LOAD.cpu === 'number' && LOAD.cpu >= 90 ? ' bad' :
       typeof LOAD.cpu === 'number' && LOAD.cpu >= 70 ? ' warn' : '');
    p.innerHTML = '<span class="tbs-txt"><span class="tbs-k">CPU</span><b>' + cpu + '</b></span>' +
                  '<span class="tbs-txt"><span class="tbs-k">GPU</span><b>' + gpu + '</b></span>' +
                  '<span class="tbs-txt"><span class="tbs-k">MEM</span><b>' + mem + '</b></span>';
    p.title = '本机负载：CPU ' + cpu + ' · GPU ' + gpu +
      (LOAD.mem ? ' · 内存 ' + mem : '') +
      (LOAD.err ? '（取数失败：' + LOAD.err + '）' : '');
  }

  async function tick() {
    if (LOAD.busy) return;
    // 窗口不可见时轮询没有意义（省电），回来时立刻补一次
    if (document.hidden) return;
    LOAD.busy = true;
    try {
      var r = await probeLoad();
      if (r) {
        if (typeof r.cpu === 'number') LOAD.cpu = r.cpu;
        LOAD.gpu = r.gpu || null;
        LOAD.mem = r.mem || null;
        LOAD.err = null;
      }
    } catch (e) {
      LOAD.err = String(e && e.message || e);
    } finally {
      LOAD.busy = false;
      LOAD.at = Date.now();
      paint();
    }
  }

  function start() {
    ensurePill();
    tick();
    setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) tick(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
