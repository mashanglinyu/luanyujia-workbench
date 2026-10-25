/* ============================================================================
   05-顶栏/网页按钮.js —— 在顶栏注入「5 个网页端按钮」
   目的：品牌名右边排 5 个官网图标，点一下开一个内置窗口，再点收起。

   ★ 桥的名字（照抄不会错）
   本机外壳暴露的是：window.__kunWebAiToggle(key) / window.__kunWebAiOpen(key)
   （不同外壳可能叫别的名字；下面 openSite() 里按优先级依次试，最后才退回系统浏览器）

   用法：外壳渲染器加载完后调用一次 decorateWebAi()；
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

  // ── 适配点：按优先级找"能开内置窗口"的桥 ──────────────────────────────────
  function openSite(key, url) {
    // 1) 本机外壳的桥（切换/打开）
    if (typeof window.__kunWebAiToggle === 'function') return window.__kunWebAiToggle(key);
    if (typeof window.__kunWebAiOpen === 'function') return window.__kunWebAiOpen(key);
    // 2) 其它外壳常见写法
    if (typeof window.__appWebAiOpen === 'function') return window.__appWebAiOpen(key);
    if (window.app && typeof window.app.openWebAi === 'function') return window.app.openWebAi(key);
    // 3) 都没有 ⇒ 退回系统浏览器（不会静默失败）
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
