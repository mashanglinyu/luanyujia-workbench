/* customer-start.js —— 客户版启动落地：开机直接进「命令」场景（可改 FIRST）
 * 2026-11-04 修复（code-ai 复核）：
 *   ① 本文件原来没被 index.html 引用 ⇒ 客户版一直停在引擎页（已加引用）
 *   ② 找不到 FIRST 时点 all[0] 却返回 false ⇒ 会反复点同一 tab（现在返回 true 停止重试）
 *   ③ 原「每 3 秒把 harness 拽回 command」会让用户永远打不开引擎页 ⇒ 改成启动后限时 3 次兜底
 *   ④ 注释写 20 秒、代码 8 秒 ⇒ 统一为 8 秒
 */
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
    // 已经点下去了就算成功（找不到 FIRST 时退到第一个 tab 也是成功，别反复点）
    return activeId() === FIRST || !!activeId();
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
    // 等启动动画播完再切场景（最多等 8 秒）
    var waited = 0;
    var wait = setInterval(function () {
      waited += 500;
      if (bootOver() || waited > 8000) { clearInterval(wait); tick(); }
    }, 500);
    // 启动阶段兜底：万一被引擎页抢走，最多再拉 3 次（9 秒内），之后不再插手
    var pulls = 0;
    var guard = setInterval(function () {
      pulls++;
      var a = activeId();
      if (a && a !== 'harness') { clearInterval(guard); return; }   // 已经落到场景，停
      pick();
      if (pulls >= 3) clearInterval(guard);                         // 最多 3 次，之后尊重用户选择
    }, 3000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
