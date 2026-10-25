/* ============================================================================
   05-顶栏/网页按钮.js —— 在顶栏注入「5 个网页端按钮」
   目的：和原版一样，品牌名右边排 5 个官网图标，点一下开一个内置窗口，再点收起。

   怎么接（两种外壳都适用）：
   ① 你的渲染器支持「窗口内开 webview」：把 openSite(key) 换成你外壳的接口
      （原版是 window.__appWebAiOpen(key)，各外壳不同，见文件末尾「适配点」）。
   ② 不支持 webview 的外壳：会退回用系统浏览器打开（默认行为），不至于点了没反应。

   用法：在外壳渲染器加载完后调用一次 decorateWebAi()；
        场景刷新会重跑，函数里做了幂等（不会插第二排）。
============================================================================ */

(function () {
  'use strict';

  // 站点表：key 必须和你外壳里认的 key 一字不差（图标文件名也用这个 key）
  var SITES = [
    { key: 'doubao',   name: '豆包',     icon: 'assets/webai/doubao.png',   url: 'https://www.doubao.com/chat/' },
    { key: 'tongyi',   name: '通义千问', icon: 'assets/webai/tongyi.png',   url: 'https://www.tongyi.com/' },
    { key: 'deepseek', name: 'DeepSeek', icon: 'assets/webai/deepseek.png', url: 'https://chat.deepseek.com/' },
    { key: 'chatglm',  name: '智谱清言', icon: 'assets/webai/chatglm.png',  url: 'https://chatglm.cn/' },
    { key: 'kimi',     name: 'Kimi',     icon: 'assets/webai/kimi.png',     url: 'https://kimi.moonshot.cn/' }
  ];

  // ── 适配点：把这里换成你外壳"打开内置网页窗口"的能力 ─────────────────────
  function openSite(key, url) {
    // 1) 外壳提供的能力（优先）
    if (typeof window.__appWebAiToggle === 'function') return window.__appWebAiToggle(key);
    if (typeof window.__appWebAiOpen === 'function') return window.__appWebAiOpen(key);
    // 2) 没有能力 ⇒ 退回系统浏览器（不会静默失败）
    if (typeof window.__openExternal === 'function') return window.__openExternal(url);
    window.open(url, '_blank', 'noopener');
  }

  function decorateWebAi() {
    try {
      var titlebar = document.querySelector('#titlebar .titlebar-drag') || document.getElementById('titlebar');
      var brand = document.querySelector('#titlebar .brand');
      if (!titlebar || !brand) return false;

      // 幂等：已经有就不重建
      var strip = document.getElementById('webai-strip');
      if (!strip) {
        strip = document.createElement('span');
        strip.id = 'webai-strip';
        strip.className = 'webai-strip';
        strip.setAttribute('role', 'group');
        strip.setAttribute('aria-label', '网页版 AI');
        brand.parentNode.insertBefore(strip, brand.nextSibling); // 紧跟品牌名
      }

      SITES.forEach(function (site) {
        if (strip.querySelector('.webai-btn[data-key="' + site.key + '"]')) return;
        var btn = document.createElement('button');
        btn.className = 'webai-btn';
        btn.dataset.key = site.key;
        btn.title = site.name + '（点一下开一个窗口，再点收起）';

        var img = document.createElement('img');
        img.src = site.icon;
        img.alt = site.name;
        img.draggable = false;
        img.onerror = function () {           // 图标挂了退回单字，不留破图标位
          try { btn.classList.add('noimg'); btn.textContent = site.name.slice(0, 1); this.remove(); } catch (e) {}
        };
        btn.appendChild(img);
        btn.addEventListener('click', function () { openSite(site.key, site.url); });
        strip.appendChild(btn);
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  window.decorateWebAi = decorateWebAi;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', decorateWebAi);
  else decorateWebAi();
})();
