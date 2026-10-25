/* ============================================================================
   05-顶栏/负载胶囊.js —— CPU / GPU / 内存 实时胶囊
   位置：**顶栏最右侧**（在「最小化 ─ / 最大化 □ / 关闭 ✕」那一组的左边），不是 ⟳ 旁边。

   ★ 数据从哪来（照抄不会错）
   本机外壳把读机器的桥挂在 kun 命名空间下，函数名是 sys.load：
       window['kun'].sys.load()  →  { cpu, gpu:{util,memUsed,memTotal}, mem:{usedPct} }
   （字符串写法是为了不在公开仓库里硬编码内部命名空间；你换成自己外壳的桥即可。）

   ⛔ 不要在前端直接读 WMI / 显卡驱动：一是权限，二是阻塞界面。
============================================================================ */

(function () {
  'use strict';

  var LOAD = { cpu: null, gpu: null, mem: null, err: null, busy: false };
  var POLL_MS = 4000;          // 轮询间隔
  var pill = null;

  // ── 取数：按优先级找本机外壳的桥 ──────────────────────────────────────────
  async function probeLoad() {
    // 1) 本机外壳：kun.sys.load（字符串取，避免公开仓库出现内部命名空间）
    var ns = window['kun'] || window.app || null;
    if (ns && ns.sys && typeof ns.sys.load === 'function') return await ns.sys.load();
    // 2) 有的外壳挂在顶层 IPC 桥
    if (window.app && window.app.sys && typeof window.app.sys.load === 'function') return await window.app.sys.load();
    // 3) 本地 HTTP 兜底
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
    // ★ 位置：顶栏右侧那组窗口按钮（.titlebar-controls）里，排在第一个（= 紧挨 ─ 左边）
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
    if (document.hidden) return;      // 窗口不可见时不轮询（省电），回来自动补一次
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
      LOAD.err = String((e && e.message) || e);
    } finally {
      LOAD.busy = false;
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
