// 2-标签交互（热更新侧）.js —— 摘自 renderers.js：拖拽换位 + 未激活收成图标 + 固定组
// 这一层随 ⟳ 热加载，调手感不用重启 GUI。纯函数（tabDropIndex / tabClampTarget）可以直接单测。
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
