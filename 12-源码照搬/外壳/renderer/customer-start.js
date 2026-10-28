/* customer-start.js —— 客户版启动落地：开机直接进「命令」场景（可改 FIRST） */
(function () {
  var FIRST = 'command';   // 想换默认场景改这里（面板 id 见 scenarios\_场景身份索引.md）
  var tries = 0;
  function tabs() { return document.querySelectorAll('#scenario-tabs .tab'); }
  function activeId() {
    var a = document.querySelector('#scenario-tabs .tab.active');
    return a ? a.getAttribute('data-sc-id') : '';
  }
  function pick() {
    var all = tabs();
    if (!all.length) return false;
    var want = null;
    for (var i = 0; i < all.length; i++) {
      if (all[i].getAttribute('data-sc-id') === FIRST) { want = all[i]; break; }
    }
    if (!want) want = all[0];
    try {
      want.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      want.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
      want.click();
    } catch (e) {}
    return activeId() === FIRST;
  }
  function tick() {
    tries++;
    if (!pick() && tries < 40) setTimeout(tick, 800);
  }
  function bootOver() {
    var ov = document.getElementById('boot-overlay');
    if (!ov) return true;
    var st = window.getComputedStyle(ov);
    return st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0;
  }
  function boot() {
    // 等经典动画播完再切场景（最多等 20 秒）
    var waited = 0;
    var wait = setInterval(function () {
      waited += 500;
      if (bootOver() || waited > 8000) { clearInterval(wait); tick(); }
    }, 500);
    // 启动完成后如果又被引擎页抢走，再拉一次
    setInterval(function () {
      var a = activeId();
      if (!a || a === 'harness') pick();
    }, 3000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
