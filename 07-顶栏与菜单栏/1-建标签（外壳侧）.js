// 1-建标签（外壳侧）.js —— 摘自 工作台外壳 renderer.js（顶栏「场景标签栏」的 DOM 构建 + 钉会话）
// ⚠ 外壳侧代码改完**必须重启 GUI**（不像 renderers.js 能热加载）。摘录片段，离上下文不能单独运行，看结构用。
  // 「⧉ 在新窗口打开」：标签右侧的小按钮（场景分离 → 一屏一个场景）
  const attachDetachBtn = (tab, id) => {
    const b = mkEl('span', 'tab-detach', '⧉');
    b.title = '在新窗口打开（多屏分开看）';
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();   // 别顺带切换标签
      ev.preventDefault();
      try { window.app.win.openScene(id); } catch (e) { /* ignore */ }
    });
    tab.appendChild(b);
  };
  const makeTab = (id, name, icon, active, draggable) => {
    const t = mkEl('button', 'tab' + (active ? ' active' : ''));
    // ⚠ 这里**不再**设 HTML5 的 t.draggable：拖拽换位改成"指针事件 + 占位格"（renderers.js 的
    //   initScenarioTabBar），HTML5 DnD 会和它抢事件、幽灵图也丑。data-movable 只用来给光标样式。
    if (draggable) t.dataset.movable = '1';
    const ico = mkEl('span', 'tab-ico');
    if (typeof icon === 'string' && (/\.(png|ico)$/i.test(icon) || icon.startsWith('data:image/svg+xml'))) {
      const img = document.createElement('img');
      img.className = 'tab-ico-img';
      img.src = icon;
      img.alt = '';
      ico.appendChild(img);
    } else {
      ico.textContent = icon;
    }
    const label = mkEl('span', 'tab-label', name);
    t.appendChild(ico);
    t.appendChild(label);
    if (draggable) attachDetachBtn(t, id);   // 场景 0（Harness）常驻主窗口，不给分离按钮
    return t;
  };

  // 已在独立窗口里的场景 → 标签加个标记（一眼看出来它不在这儿跑）
  const decorateDetachedTabs = () => {
    tabsNav.querySelectorAll('.tab').forEach(t => {
      const id = t.dataset.scId;
      const on = !!id && detachedScenes.has(id);
      t.classList.toggle('detached', on);
      const b = t.querySelector('.tab-detach');
      if (b) b.title = on ? '已在独立窗口显示（点标签切到那个窗口）' : '在新窗口打开（多屏分开看）';
    });
  };

  // 2026-10-20（宿主：顶栏 ⋯ 里要能直达工具场景）—— 给外部（topbar-status.js）一个切场景的小入口：
  //   按 data-sc-id 找标签点一下（走的就是用户点标签那条路，不改任何状态机）。
  window.__dshGoScene = function (id) {
    try {
      var nav = document.getElementById('scenario-tabs');
      var t = nav && nav.querySelector('.tab[data-sc-id="' + String(id).replace(/["\\]/g, '') + '"]');
      if (!t) return false;
      t.click();
      return true;
    } catch (e) { return false; }
  };

  // 场景标签拖拽排序：已改为**指针拖拽 + 占位格 FLIP 动画**，实现在热更新层的
  // renderers.js → initScenarioTabBar()（顺手修掉"拖标签会误切场景"和"拖完重启复位"）。
  // 顺序的唯一权威在主进程：data\scene-tab-order.json（listScenarios() 直接按它返回），
  // 这里只提供 persist 回调把新顺序报上去。老的 HTML5 DnD + localStorage 实现已删除。

  // 场景 0：Harness（默认初始界面，固定最前不可拖）
  const tab0 = makeTab('harness', 'DSH 引擎', ICONS.harness, true, false);
  tab0.dataset.scId = 'harness';
  tab0.addEventListener('click', () => {
    tabsNav.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    tab0.classList.add('active');
    currentTab = 'harness';
    showView('harness');
    loadHarness();
  });
  tabsNav.appendChild(tab0);
  currentTab = 'harness';

  // 场景 1..N：本地场景。**顺序由主进程决定**（listScenarios() 已按 data\scene-tab-order.json 排好，
  // 标了 "first": true 的固定最前）⇒ 这里不再自己排一遍，避免两份顺序打架（原来那份在 localStorage 里）。
  const finalList = list;

  finalList.map(s => {
    const t = makeTab(s.id, s.name, ICONS[s.id] || '🧩', false, true);
    t.dataset.scId = s.id;
    t.addEventListener('click', () => {
      tabsNav.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      currentTab = s.id;
      showView('scenario');
      // 已在独立窗口里跑 → 顺手把那个窗口拉到前台（本窗口显示占位卡，不重复渲染一份）
      if (detachedScenes.has(s.id) && forceLocalScene !== s.id) {
        try { window.app.win.openScene(s.id); } catch (e) { /* ignore */ }
      }
      loadScenario(s.id);
    });
    // 右键标签 = 在新窗口打开（与标签上的 ⧉ 等价）
    t.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      try { window.app.win.openScene(s.id); } catch (e) { /* ignore */ }
    });
    tabsNav.appendChild(t);
    return t;
  });

  // 标签栏交互（拖拽换位 + 未激活标签收成图标）交给热更新层：交互逻辑放 renderers.js ⇒ 以后调手感点 ⟳ 即可。
  safeStep('标签栏交互', () => {
    const u = kUtils();
    if (!u || !u.initScenarioTabBar) return;
    const pinnedIds = finalList.filter(s => s.first).map(s => s.id);
    // 新顺序报给主进程（唯一权威）。老壳没有这个通道 ⇒ 退回 localStorage，绝不"报了没人接"。
    const persist = (ids) => {
      try {
        if (window.app.setSceneOrder) window.app.setSceneOrder(ids);
        else localStorage.setItem('scenarioTabOrder', JSON.stringify(ids));
      } catch (e) { /* 存档失败不影响已经换好的位置 */ }
    };
    // 迁移：老版本把顺序存在 localStorage，主进程还没有存档文件时搬一次过去（之后就只认主进程）
    Promise.resolve()
      .then(() => {
        const ls = JSON.parse(localStorage.getItem('scenarioTabOrder') || '[]');
        if (!Array.isArray(ls) || !ls.length || !window.app.getSceneOrder) return null;
        return Promise.resolve(window.app.getSceneOrder()).then((r) => {
          const saved = !!(r && r.saved);
          if (!saved) persist(ls);
        });
      })
      .catch(() => { /* ignore */ });
    u.initScenarioTabBar({ nav: tabsNav, persist, pinnedIds });
  });

  // 分离窗口开/关 → 更新标签标记；当前正显示的场景被分离走 → 立刻换成占位卡
  safeStep('多窗口状态', () => {
    if (window.app.win && window.app.win.onChanged) {
      window.app.win.onChanged((v) => {
        const ids = (v && Array.isArray(v.detached)) ? v.detached : [];
        detachedScenes = new Set(ids);
        decorateDetachedTabs();
        if (currentTab && currentTab !== 'harness' && detachedScenes.has(currentTab) && forceLocalScene !== currentTab) {
          loadScenario(currentTab).catch(() => { /* ignore */ });
        } else if (placeholderSceneId && placeholderSceneId === currentTab && !detachedScenes.has(placeholderSceneId)) {
          // 那个独立窗口关掉了 → 立刻把场景收回来原地显示（不用再点一次标签）
          loadScenario(currentTab).catch(() => { /* ignore */ });