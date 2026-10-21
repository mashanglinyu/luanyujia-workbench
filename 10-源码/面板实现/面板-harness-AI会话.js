// ── 面板 harness：AI 会话面板（3,158 行 —— 这套东西的"魂"）
// 摘自本机实现 `renderers.js` 的 Lrenderers.js–14093。
// 脱敏：内部 API 名已去品牌化（kun → app）· 绝对路径 → <DSH根>/<工作区> · 个人名/客户名/站点 → 占位
// 17250
// ⚠ 摘录/单文件：脱离这套工作台不能直接运行（依赖壳注入的 app.* 实例与页面上下文）。

renderers.harness = (body, meta, head) => {
  body.classList.add('harness-panel');

  // 标题栏（标题行）加「重新加载」按钮 + 精简模式状态
  let wv = null;
  let hostTimer = null;   // 加载后 30s 注入兜底窗口
  let pinTimer = null;    // 常驻钉住重注入（5s）
  let disposed = false;   // 场景切换后停止一切注入
  const reloadBtn = el('button', 'file-refresh', '🔄 重新加载');
  reloadBtn.title = '重新加载对话窗口';
  reloadBtn.addEventListener('click', () => {
    if (wv) wv.setAttribute('src', wv.getAttribute('src') || '');
    else load();
  });
  const diag = el('span', 'harness-diag', '精简模式：注入中…');
  // 状态小字可点击 = 人工兜底：清掉本面板记住的会话 id，重新按会话名匹配一次。
  // 用途：万一绑错了会话（例如会话改名后被别处占用），用户点一下即可解绑重找，
  // 不用改代码、不用重启 GUI。（鼠标悬停有完整说明，见 injectFix 里的 diag.title）
  diag.style.cursor = 'pointer';
  diag.addEventListener('click', () => {
    try {
      if (!wv || !wv.executeJavaScript) return;
      // 只清本面板的绑定（键名带面板 id），别把其它 AI 面板的记忆一起清掉
      const js = "try{localStorage.removeItem('app_pin_bind_v2:" + PANEL_KEY + "')}catch(e){}; 'ok'";
      wv.executeJavaScript(js)
        .then(() => { try { wv.reload(); } catch (e) { /* ignore */ } })
        .catch(() => { /* ignore */ });
    } catch (e) { /* ignore */ }
  });
  if (head) {
    head.classList.add('file-head');
    const acts = el('div', 'file-head-acts ai-head-acts');
    // 顺序：按钮在左、状态小字在右。窄面板（如 Blender 的 1 列宽 AI 面板）下，
    // 长状态文字不再把按钮挤到换行/裁切；小字自身用省略号收尾（CSS .harness-diag）。
    acts.appendChild(reloadBtn);
    acts.appendChild(diag);
    head.appendChild(acts);
  }

  const msg = el('div', 'harness-loading', '正在加载对话窗口…');
  body.appendChild(msg);

  // 内嵌窗口只显示聊天框：隐藏左侧菜单栏、右侧详情列、对话区顶部标题栏、对话轨迹 turn rail、宽度拖条。
  // 主策略 = CSS 优先（不依赖 JS）：应用框架带内联 grid-template-columns 且含 minmax(0,1fr) 中列，
  // 用 !important 强制成 0 / 1fr / 0；标题栏 data-phase>header、拖条 data-width-handle、手柄 data-side 稳定属性。
  // 兜底 = JS 常驻（MutationObserver + 定时器）纠正 React 重渲染。
  const HARNESS_CHAT_CSS = [
    '[style*="grid-template-columns"][style*="minmax(0"] { grid-template-columns: minmax(0, 1fr) !important; }',
    '[style*="grid-template-columns"][style*="minmax(0"] [data-side="sidebar"], [style*="grid-template-columns"][style*="minmax(0"] [data-side="details"] { display: none !important; }',
    '[style*="grid-template-columns"][style*="minmax(0"] [data-phase] > header { display: none !important; }',
    '[style*="grid-template-columns"][style*="minmax(0"] [data-width-handle] { display: none !important; }',
    // 文字铺满：老写法 `[data-phase] { --dsh-chat-content-width: 100% !important }` 在引擎 0.1.6 上
    // **整条空转**（[data-phase] 不是会话相位容器、变量也不是在别处算的）——详见文件上方
    // 「会话列铺满」那段实测说明。现在改成盖 max-width + 沿祖先链压变量，与场景 0 共用同一组常量。
    HARNESS_WIDE_CSS
  ].join('\n');
  // 钉住脚本（幂等：已装则不再重复装定时器；webview 内部重载后 window 重置，可重新注入）
  // pinTarget 支持「会话名」或「会话名数组」：多候选按顺序匹配——① 标题完全相等 ② 包含匹配，
  // **匹配时忽略大小写与空格**（兼容「oa系统运维」↔「<客户>oa系统运维」↔「<客户> OA 系统运维」）。
  // sessionTitle（可选）= 该会话的**完整真实标题**（从引擎会话索引里查到的原文），优先级最高、要求完全相等。
  // 每次注入都会刷新 window.__pinDiag（诊断），宿主面板会把结果写到标题行小字，便于排查。
  // 没写 pinTarget = 「不钉」（下面 clickItem 会直接什么都不做，交给用户自己选会话）。
  // 别再给缺省值塞历史默认「oa系统运维」：那会让主标签的「工作台」对话面板跑去找 OA 会话、
  // 甚至点到别的会话上去（2026-09-19 去掉这个默认值）。
  const rawPin = (meta && meta.pinTarget) || '';
  const pinTargets = (Array.isArray(rawPin) ? rawPin : [rawPin])
    .map(t => String(t == null ? '' : t).trim()).filter(Boolean);
  const PIN_TARGETS_JS = JSON.stringify(pinTargets);
  const PIN_SESSION_JS = JSON.stringify(String((meta && meta.sessionTitle) || '').trim());
  // ★会话 id = 身份校验（不再是"直达通道"）★ 2026-09-19 二次修正：
  //   场景 json 的 sessionId 是引擎真实 id（如 session-0000…-…），面板拿它来**核对**
  //   「画面上这条会话是不是我要的那条」——因为会话行 DOM 里没有 id，只有标题，而本机真的
  //   存在过只差一个空格的孪生会话（`DSH 改造` / `DSH改造`），光凭标题会认错人。
  //   ⚠ 早先"写 dsh.sessions.current + reload 直达"的做法一度**删除**过（共用分区下两个面板互抢）；
  //     2026-09-19 三次定稿后**已按新前提重新启用**（一板一分区 ⇒ 各写各的键，见下方 ⓪）。
  //   ⚠ 早先"这些面板里侧栏压根不在 DOM 里、点行不可靠"的说法（2026-09-14）也已作废：
  //     2026-09-19 探针实测：侧栏会话行**加载后 1 秒内就在 DOM 里**（[role="treeitem"] 有 7~8 行），点行有效。
  const PIN_SESSION_ID_JS = JSON.stringify(String((meta && meta.sessionId) || '').trim());
  // 面板身份：分区现在是**一板一分区**（见 panelPartition 与 webview 处的说明），但"记住的会话标题"
  // 仍然按面板分键存 —— 面板重建、场景里换了会话 id 时它还要用，换分区不影响这个键的用途。
  const PANEL_KEY = String((meta && meta.id) || (meta && meta.scenario) || 'ai').replace(/[^A-Za-z0-9_-]/g, '') || 'ai';
  const PIN_PANEL_JS = JSON.stringify(PANEL_KEY);
  // ★拖文件进对话窗口（2026-09-23 用户要求）：webview 内部页面收 drop，把文件路径插进输入框
  //   （只插入、不自动发送，用户手动回车）。幂等：window.__kunDropGen 装过一次就不再装；
  //   webview 内部真重载时 window 重置 ⇒ 按新页面重新装一遍。
  //   路径链：guest 页面的 webUtils（引擎一般没暴露）→ File.path（老 Electron）→ text/uri-list / text/plain 兜底
  //   （系统文件拖拽 / 素材管理窗口 startDrag 拖回，dataTransfer 里都带 uri-list，能稳定拿到完整路径）。
  //   输入框 = 引擎 Composer 的 contenteditable（data-composer-input，Lexical 宿主），用 execCommand 插入
  //   会触发标准 InputEvent，Lexical 正常感知（只插文本、不拼文件名以外的任何东西）。
  const HARNESS_DROP_JS = `(() => {
    const GEN = 'kun-drop-v1';
    if (window.__kunDropGen === GEN) return;
    window.__kunDropGen = GEN;
    document.addEventListener('dragover', (ev) => {
      if (!ev.dataTransfer) return;
      try { ev.preventDefault(); } catch (e) { }
    });
    document.addEventListener('drop', (ev) => {
      if (!ev.dataTransfer) return;
      try { ev.preventDefault(); } catch (e) { }
      try { ev.stopPropagation(); } catch (e) { }
      const paths = [];
      const files = ev.dataTransfer.files || [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        let p = '';
        try { if (window.webUtils && window.webUtils.getPathForFile) p = window.webUtils.getPathForFile(f); } catch (e) { }
        if (!p) p = (f && f.path) || '';
        if (p) paths.push(p);
      }
      if (!paths.length) {
        let raw = '';
        try { raw = ev.dataTransfer.getData('text/uri-list') || ev.dataTransfer.getData('text/plain') || ''; } catch (e) { }
        String(raw).split(/\\r?\\n/).forEach((line) => {
          const s = line.trim();
          if (!s) return;
          let p = s;
          if (/^file:\\/\\//i.test(s)) {
            try { p = decodeURIComponent(s.replace(/^file:\\/\\//i, '').replace(/^\\/([A-Za-z]:)/, '$1').replace(/\\//g, '\\\\')); } catch (e) { }
          }
          if (p) paths.push(p);
        });
      }
      if (!paths.length) return;
      const el = document.querySelector('[data-composer-input]');
      if (!el) return;
      el.focus();
      try { document.execCommand('insertText', false, paths.join('\\n')); } catch (e) { }
    });
  })()`;
  const HARNESS_PIN_JS = `(() => {
    const TARGETS = ${PIN_TARGETS_JS};
    const SESSION_TITLE = ${PIN_SESSION_JS};
    const SESSION_ID = ${PIN_SESSION_ID_JS};
    const PANEL = ${PIN_PANEL_JS};
    // ⚠ 侧栏真实 DOM 结构（依据引擎源码 packages/client/ui-workspace/src/client/rows/Rows.tsx）：
    //   · 会话行  = div[role="treeitem"][aria-selected]  —— 没有 data-session-id 之类的 id 属性，
    //     标题在一个 <span class*="title"> 里，行内还有状态点/相对时间/菜单按钮（所以整行 textContent
    //     带着"3天前"这种尾巴，**不能拿整行文本做完全相等判断**）。
    //   · 分组头  = div[role="treeitem"][aria-expanded]（项目/工作区分组，点了只展开分组、不换会话）。
    //   因此：① 只认会话行，永不点分组头；② 只用"标题节点"的文本比对；③ 分组头只用来展开分组。
    // ⚠ 键里带上本面板"当前的钉会话配置"：改了场景（换会话 / 删掉绑定）就一定换键 ⇒
    //   旧记忆立刻失效。否则会出现"场景 json 里已经删了 id，面板还按记住的标题去点旧会话"的鬼绑定。
    const PIN_SIG = (SESSION_ID || SESSION_TITLE || (TARGETS || []).join('|') || 'none');
    const BIND_KEY = 'app_pin_bind_v2:' + PANEL + ':' + PIN_SIG;
    // ★幂等守卫（2026-09-19 三次定稿补）★：宿主每 5 秒会"轻量重注入"一次本脚本（好让 webview 内部
    //   重载后钉住仍生效），而下面装的是 setInterval ⇒ 每次注入都新装一轮，几分钟就能攒出几十个 4 秒循环，
    //   表现为面板状态小字周期性乱跳、空转扫 DOM（用户实感「每隔一会跳一下」）。
    //   同一份配置（GEN 里含面板名 + 钉会话签名）只装一次；重复注入只做一次轻量 tick（点一次 + 刷诊断）。
    //   webview 内部真重载时 window 重置 ⇒ GEN 自然失效 ⇒ 重新按新页面装一遍，语义不变。
    const GEN = 'pin_v3:' + BIND_KEY;
    if (window.__pinGen === GEN) { try { window.__pinTick && window.__pinTick(); } catch (e) { } return; }
    // 绑定 = 本面板上次钉成功的那条会话行的**精确标题**（DOM 里拿不到会话 id，标题就是最可靠的钥匙）；
    // 键名带面板 id，所以多个 AI 面板共用同一个浏览器分区也不会互相串。
    const readBind = () => { try { const s = localStorage.getItem(BIND_KEY); return s ? JSON.parse(s) : null; } catch (e) { return null; } };
    const saveBind = (title) => {
      try { if (title) localStorage.setItem(BIND_KEY, JSON.stringify({ title: String(title) })); } catch (e) { }
    };
    // ── localStorage['dsh.sessions.current'] 的读写（引擎用它记住"上次会话"）──
    // ★2026-09-19 三次定稿：写键 + reload 的"直达通道"**已按新前提重新启用**（见下方 ⓪）。
    //   前提变了：每个带 sessionId 的面板现在有**自己的分区**，本面板写的键只有本面板读得到，
    //   所以不会再出现"共用分区时代"的 8 秒级互抢 ⇒ 这条通道是本面板的首选钉法。
    //   （readSel 也重新可以当"本面板状态"用：它现在就是本面板自己分区里的值。）
    const SEL_KEY = 'dsh.sessions.current';
    const readSel = () => { try { return JSON.parse(localStorage.getItem(SEL_KEY) || 'null'); } catch (e) { return null; } };
    const writeSel = (id) => {
      try {
        const cur = readSel() || {};
        localStorage.setItem(SEL_KEY, JSON.stringify(Object.assign({}, cur, { sessionId: String(id) })));
        return true;
      } catch (e) { return false; }
    };
    // 重载次数记在 sessionStorage（**跨 reload 存活**，localStorage 会被应用改写、不适合计数）
    const RELOAD_KEY = 'app_pin_reloads';
    const readReloads = () => { try { return Number(sessionStorage.getItem(RELOAD_KEY) || 0) || 0; } catch (e) { return 0; } };
    const bumpReloads = () => { try { sessionStorage.setItem(RELOAD_KEY, String(readReloads() + 1)); } catch (e) { } };
    const clearReloads = () => { try { sessionStorage.removeItem(RELOAD_KEY); } catch (e) { } };
    // ★ 节流时间戳也必须跨 reload 存活（2026-09-19 修）：原先记在 window.__pinReloadAt 上，
    //   reload 之后归零 ⇒ "两次之间至少隔 8 秒"实际失效 ⇒ 一个场景挂两个 AI 面板时，两边会
    //   连续互抢同一个当前会话键，抢输的一方重载次数很快用光，最终停在"选择工作区开始"的
    //   新建会话页（症状：切过来偶尔就是新画面）。
    const RELOAD_AT_KEY = 'app_pin_reload_at';
    const readReloadAt = () => { try { return Number(sessionStorage.getItem(RELOAD_AT_KEY) || 0) || 0; } catch (e) { return 0; } };
    const markReloadAt = () => { try { sessionStorage.setItem(RELOAD_AT_KEY, String(Date.now())); } catch (e) { } };
    // ── 跨面板「改键 + 重载」令牌：**一板一分区之后已无必要**，代码保留仅作诊断（refreshDiag 会显示它）。
    //    历史：共用分区（主窗口 persist:harness）里 dsh.sessions.current 只有一个值，同一时刻只允许
    //    一个面板改它，才需要这个令牌；现在各面板写各面板分区里的键 ⇒ 令牌恒为空、claimFree() 恒真。
    const CLAIM_KEY = 'app_pin_claim_v1';
    const CLAIM_TTL = 20000;
    const readClaim = () => { try { return JSON.parse(localStorage.getItem(CLAIM_KEY) || 'null'); } catch (e) { return null; } };
    const claimFree = () => {
      const c = readClaim();
      if (!c || !c.panel) return true;
      if (String(c.panel) === String(PANEL)) return true;
      return (Date.now() - Number(c.at || 0)) > CLAIM_TTL;
    };
    const takeClaim = () => { try { localStorage.setItem(CLAIM_KEY, JSON.stringify({ panel: String(PANEL), at: Date.now() })); } catch (e) { } };
    const dropClaim = () => {
      try { const c = readClaim(); if (c && String(c.panel) === String(PANEL)) localStorage.removeItem(CLAIM_KEY); } catch (e) { }
    };
    // 重载预算（只在本面板**自己分区**的 sessionStorage 里计数，不会被对侧清零）：
    // 前 3 次间隔 ≥8 秒（正常情况下第一次就到位），第 4~5 次转慢车道 ≥25 秒（目标 id 失效时别狂刷），
    // 用完就只走 ① 点侧栏会话行，不会再无休止重载。
    const RELOAD_MAX = 5;
    const reloadGap = () => (readReloads() >= 3 ? 25000 : 8000);
    // ⚠ 归一化**必须保留空格**（只把连续空白压成一个空格）：2026-09-19 实测本机存在"长得一样"的孪生会话
    //   （「DSH 改造」与「DSH改造」、「GUI 页面改造」与「GUI页面改造」），早先这里把空白**全部删掉**（只留字母），
    //   全删了 ⇒ 孪生会话的标题**完全相等** ⇒ 面板把"另一个几乎空白的同名会话"当成目标、还报"✓ 已钉绑定"
    //   ⇒ 用户看到的就是"切过来是空的新画面"（而存储里指向的确实是另一个会话 id）。
    const norm = (x) => String(x == null ? '' : x).toLowerCase().replace(/\\s+/g, ' ').trim();
    // ⚠ 教训（2026-09-14 当天踩过一次，别再犯）：**不要把搜索范围限制在某个"看起来像侧栏"的容器里**。
    //   实测 [data-side="sidebar"] 挂在拖拽手柄上、不是会话列表容器 → 限定范围后候选恒为空 →
    //   一个会话都点不到，面板就停在"新会话/欢迎页"（表现为"每个场景都切不进去"）。
    //   正确做法：全文档找，但 ① 排除聊天内容区（避免点到聊天记录里的同名字样）
    //            ② 绝不点分组头（[aria-expanded]，点了只展开分组）③ 会话行优先。
    const inChat = (e) => {
      try { return !!(e.closest && e.closest('[data-chat-flow],[data-phase]')); } catch (err) { return false; }
    };
    const clickTarget = (e) => (e.closest && e.closest('button,[role="button"],[role="option"],[role="treeitem"],a,li,[aria-selected]')) || e;
    const isRowLike = (e) => !!(e.closest && e.closest('[aria-selected],[data-session-id]'));
    const isGroupHead = (e) => {
      try { return !!(e.hasAttribute && e.hasAttribute('aria-expanded')); } catch (err) { return false; }
    };
    // 元素文本：会话行优先取行内标题节点（整行文本带"3天前"尾巴），其余用自身文本
    const readText = (e) => {
      try {
        if (e.querySelector) {
          const t = e.querySelector('[class*="title"]');
          if (t && t.textContent && t.textContent.trim()) return t.textContent.trim();
        }
      } catch (err) { /* ignore */ }
      return String((e && e.textContent) || '').replace(/\\s+/g, ' ').trim();
    };
    // 一行会话的"标题文本"（给诊断/记忆用）：标题节点 ＞ 按钮 aria-label 里的「标题」＞ 整行文本
    const rowTitle = (row) => {
      try {
        if (!row) return '';
        const t = row.querySelector ? row.querySelector('[class*="title"]') : null;
        if (t && t.textContent && t.textContent.trim()) return t.textContent.trim();
        const b = row.querySelector ? row.querySelector('[aria-label]') : null;
        if (b) {
          const m = String(b.getAttribute('aria-label') || '').match(/[「『"“]([^」』"”]{1,80})[」』"”]/);
          if (m && m[1].trim()) return m[1].trim();
        }
        return String(row.textContent || '').replace(/\\s+/g, ' ').trim();
      } catch (e) { return ''; }
    };
    // 页面标题 =「<会话名> — DSH 本地构建」：去掉后缀就是会话名（应用自己写的，最权威）
    const stripSuffix = (s) => String(s == null ? '' : s).replace(/\s*[—–\-]\s*DSH.*$/, '').trim();
    // 纯页签名（聊天区顶栏里第一个文本常常只是页签名"对话"），不能当成会话名
    const isTabLabel = (s) => /^(对话|chat|新视图|new view)$/i.test(String(s || '').trim());
    // 当前**已打开**的会话名。⚠ 顺序很重要（2026-09-14 修）：
    //   ① document.title —— 应用把会话名写在这里，最可靠（日志实证："<客户>oa系统运维 — DSH 本地构建"）
    //   ② 侧栏高亮行标题（侧栏多半没渲染，聊胜于无）
    //   ③ 聊天区顶栏文字 —— **放最后**：顶栏第一个文本往往是页签名「对话」，优先用它就会误报
    //      "未切到 · 对话"（状态小字显示错误，功能其实是好的）。
    // 都读不到时返回 ''（例如停在"新会话/欢迎页"）。
    const titleOf = () => {
      const dt = stripSuffix(document.title);
      if (dt && dt !== 'DSH 本地构建') return dt;
      try {
        const sel = document.querySelector('[aria-selected="true"]');
        const st = rowTitle(sel);
        if (st && st.length <= 60 && !isTabLabel(st)) return st;
      } catch (e) { /* ignore */ }
      try {
        const h = document.querySelector('[data-phase] > header');
        const ht = h ? String(h.textContent || '').replace(/\\s+/g, ' ').trim() : '';
        if (ht && ht.length <= 60 && !isTabLabel(ht)) return ht;
      } catch (e) { /* ignore */ }
      return '';
    };
    // 这个会话名是从哪儿读来的（只用于诊断显示，便于判断状态小字是否可信）
    const titleSrc = () => {
      const dt = stripSuffix(document.title);
      if (dt && dt !== 'DSH 本地构建') return '页面标题';
      try {
        const st = rowTitle(document.querySelector('[aria-selected="true"]'));
        if (st && st.length <= 60 && !isTabLabel(st)) return '侧栏高亮行';
      } catch (e) { /* ignore */ }
      try {
        const h = document.querySelector('[data-phase] > header');
        const ht = h ? String(h.textContent || '').replace(/\\s+/g, ' ').trim() : '';
        if (ht && ht.length <= 60 && !isTabLabel(ht)) return '聊天区顶栏';
      } catch (e) { /* ignore */ }
      return '读不到';
    };
    const findBest = (relaxed) => {
      // 全文档候选（排除聊天内容区；含"可点/可读"的常见节点）
      // relaxed=true 时不再排除聊天区：只在"严格找一遍没找到"时才用，保证绝不出现"一个都找不到"
      let all;
      try {
        all = document.querySelectorAll('div,button,span,a,li,p,[role="option"],[role="button"],[role="treeitem"],[aria-selected],[data-session-id]');
      } catch (e) { return null; }
      const cand = [];
      for (let i = 0; i < all.length; i++) {
        const e = all[i];
        try {
          const rowLike = isRowLike(e) || isRowLike(clickTarget(e));
          if (!relaxed && !rowLike && inChat(e)) continue;   // 聊天内容区：默认不点
          const raw = readText(e);
          if (!raw || raw.length > 160) continue;
          const n = norm(raw);
          if (!n) continue;
          const target = clickTarget(e);
          if (isGroupHead(target)) continue;            // 分组头：只用于展开分组，不当作会话
          cand.push({ el: e, t: raw, n: n, rank: rowLike ? 0 : 1 });
        } catch (err) { /* ignore */ }
      }
      if (!cand.length) return null;
      // ① 绑定标题 → ② 场景指定标题 → ③ 候选名；同一目标里"会话行优先、完全相等优先、文本越短越像行"
      const bind = readBind();
      const want = [];
      if (bind && bind.title) want.push({ n: norm(bind.title), by: '绑定标题:' + bind.title, exactOnly: true });
      if (SESSION_TITLE) want.push({ n: norm(SESSION_TITLE), by: '指定标题:' + SESSION_TITLE, exactOnly: true });
      for (let ti = 0; ti < TARGETS.length; ti++) want.push({ n: norm(TARGETS[ti]), by: '候选名:' + TARGETS[ti], exactOnly: false });
      for (let w = 0; w < want.length; w++) {
        const W = want[w];
        if (!W.n) continue;
        let best = null, bestKey = Infinity;
        for (let i = 0; i < cand.length; i++) {
          const c = cand[i];
          const exact = (c.n === W.n);
          if (!exact) {
            if (W.exactOnly) continue;
            if (c.n.indexOf(W.n) < 0 || c.n.length > 240) continue;
          }
          const key = c.rank * 1e6 + (exact ? 0 : 1e5) + c.n.length;
          if (key < bestKey) { bestKey = key; best = c; }
        }
        if (best) return { el: best.el, by: (best.n === W.n ? '完全相等 · ' : '包含 · ') + W.by };
      }
      return null;
    };
    const brief = (e) => String((e && (rowTitle(e) || e.textContent)) || '').replace(/\\s+/g, ' ').trim().slice(0, 36);
    const listCands = () => {
      const seen = {}, out = [];
      try {
        const els = document.querySelectorAll('[aria-selected],[data-session-id],[role="treeitem"],div,li,button');
        for (let i = 0; i < els.length && out.length < 12; i++) {
          const e = els[i];
          if (inChat(e)) continue;
          if (isGroupHead(e)) continue;
          const t = rowTitle(e);
          if (!t || t.length > 40) continue;
          if (seen[t]) continue;
          seen[t] = 1; out.push(t);
        }
      } catch (err) { /* ignore */ }
      return out;
    };
    const refreshDiag = (hit) => {
      const h = hit || findBest(false) || findBest(true);   // 与实际点击同一套判据（严格→放宽）
      window.__pinDiag = {
        targets: TARGETS,
        sessionTitle: SESSION_TITLE,
        sessionId: SESSION_ID,
        stored: (() => { const s = readSel(); return (s && s.sessionId) ? String(s.sessionId) : ''; })(),
        reloads: readReloads(),
        reloadMax: RELOAD_MAX,
        claim: (() => {
          const c = readClaim();
          return c ? (String(c.panel) + ' · ' + Math.round((Date.now() - Number(c.at || 0)) / 1000) + ' 秒前') : '';
        })(),
        claimFree: claimFree(),
        title: titleOf(),
        titleSrc: titleSrc(),
        matched: h ? brief(h.el) : '',
        by: h ? h.by : '',
        bound: readBind(),
        rows: (() => { try { return document.querySelectorAll('[aria-selected],[data-session-id],[role="treeitem"]').length; } catch (e) { return -1; } })(),
        clicked: !!window.__pinClickedAt,
        clickedAt: window.__pinClickedAt || 0,
        cands: listCands()
      };
    };
    refreshDiag(null);
    // 用渲染层独立标记（不能复用 __pinSet：主进程注入会先设它，会把这里的新逻辑顶掉）
    if (window.__pinSetR) return;
    window.__pinSetR = true;
    // 双保险：顺手占住 main.js 旧版脚本的标记位，让那份"扫全文档模糊点击"的老逻辑直接 return
    try { window.__pinSet = true; } catch (e) { /* ignore */ }
    let last = 0;
    const reveal = (el) => {
      const hidden = [];
      let n = el.parentElement;
      while (n) {
        if (n.style && n.style.display === 'none') { hidden.push(n); n.style.display = ''; }
        n = n.parentElement;
      }
      return hidden;
    };
    const fire = (el) => {
      const o = { bubbles: true, cancelable: true, view: window };
      try { el.dispatchEvent(new PointerEvent('pointerdown', o)); } catch (_) { }
      try { el.dispatchEvent(new MouseEvent('mousedown', o)); } catch (_) { }
      try { el.dispatchEvent(new PointerEvent('pointerup', o)); } catch (_) { }
      try { el.dispatchEvent(new MouseEvent('mouseup', o)); } catch (_) { }
      try { el.dispatchEvent(new MouseEvent('click', o)); } catch (_) { }
    };
    const doClick = (hit) => {
      const c = hit.el.closest('button,[role="button"],[role="option"],[role="treeitem"],a,li') || hit.el;
      const hidden = reveal(c);
      fire(c);
      last = Date.now();
      window.__pinClickedAt = last;
      window.__pinLastHitTitle = rowTitle(c) || rowTitle(hit.el) || '';
      refreshDiag({ el: c, by: hit.by });
      hidden.forEach(function (h) { h.style.display = 'none'; });
    };
    // 兜底：会话列表若被折叠/隐藏，虚拟列表可能因容器 0 尺寸而不渲染任何列表项（DOM 里找不到）
    // 处理：临时注入样式强制显示侧栏 → 等 React 渲染 → 点击 → 立刻恢复隐藏（用户看不到闪动）。
    // ⚠ 这条规则是实测有效的版本（display:flex + min-width:0）。上一版改成 position:fixed/visibility:hidden
    //   后虚拟列表不再渲染列表项 → 反而"一个会话都切不进去"，已回退，别再改。
    let forceTimes = 0, forceStyle = null;
    const forceShow = () => {
      if (forceStyle) return;
      try {
        forceStyle = document.createElement('style');
        forceStyle.textContent = '[data-side="sidebar"]{display:flex!important;min-width:0!important}';
        document.head.appendChild(forceStyle);
      } catch (e) { forceStyle = null; }
    };
    const forceHide = () => { try { if (forceStyle) { forceStyle.remove(); } } catch (e) { /* ignore */ } forceStyle = null; };
    // 是否已经钉住：按"侧栏高亮行标题"判断（权威），命中绑定标题/指定标题/候选名都算到位
    // 画面证据：标题对 ≠ 画面已打开。2026-09-19 探针实测（全新分区 + 只写当前会话键）：
    //   document.title 已经是目标会话名、存储里也指向目标，但**画面仍是「探索未至之境 / 选择一个工作区开始」**
    //   （路由停在 / 没进会话）⇒ 旧判据会认为"已钉住"从而**永不修复**。所以必须再要一条画面证据。
    const hasFlow = () => { try { return !!document.querySelector('[data-chat-flow],[data-phase]'); } catch (e) { return false; } };
    const welcomeish = () => {
      try {
        const b = (document.body && document.body.innerText) || '';
        return b.indexOf('探索未至之境') >= 0 || b.indexOf('选择一个工作区开始') >= 0;
      } catch (e) { return false; }
    };
    const titlePinned = () => {
      const t = norm(titleOf());
      if (!t) return false;
      let ok = false;
      const bind = readBind();
      if (bind && bind.title && t === norm(bind.title)) ok = true;
      if (!ok && SESSION_TITLE && t === norm(SESSION_TITLE)) ok = true;
      if (!ok) {
        for (let i = 0; i < TARGETS.length; i++) {
          const T = norm(TARGETS[i]);
          if (T && t.indexOf(T) >= 0) { ok = true; break; }
        }
      }
      if (!ok) return false;
      // 标题对上之后再看一眼画面：没有对话流、且还在欢迎/选工作区页 ⇒ 不算钉住（交给侧栏点击那条路）
      if (!hasFlow() && welcomeish()) return false;
      return true;
    };
    // 侧栏只渲染「当前会话所属工作区分组」的行，其他分组的行不在 DOM 里 →
    // 必须先把折叠的分组展开，目标会话行才会出现（这是「切场景钉不住」的根因）
    let expandedByUs = [];
    const collapsedGroups = () => {
      const out = [];
      const gs = document.querySelectorAll('[role="treeitem"][aria-expanded]');
      for (let i = 0; i < gs.length; i++) {
        if (gs[i].getAttribute('aria-expanded') === 'false' && expandedByUs.indexOf(gs[i]) < 0) out.push(gs[i]);
      }
      return out;
    };
    let tries = 0;
    const clickItem = () => {
      // 解绑状态（场景里没给 id / 标题 / 候选名，也没有记住的绑定）→ 什么都不做：
      // 不点侧栏、不展开分组、不强制显隐，面板就停在当前会话，由用户自己选。
      if (!SESSION_ID && !SESSION_TITLE && !(TARGETS && TARGETS.length)) {
        const bU = readBind();
        if (!bU || !bU.title) { refreshDiag(null); return; }
      }
      // 「已钉住」只看**本面板画面**这一条证据（2026-09-19 三次定稿）。
      //   ⚠ 判"成没成"不能用存储值：一板一分区之后 dsh.sessions.current 确实是本面板自己的了，
      //   但"键写对了"不等于"应用已经切过去"（reload 尚未发生时两者必然不一致）⇒ 画面才是唯一判据。
      //   标题证据本身也有死角（应用停在空会话/欢迎页时 document.title 可能还没改），所以 titlePinned() 里
      //   额外要求「有对话流」或「不在欢迎页」——两条合起来才判到位。
      //   下面这个存储值只用于状态小字；写键之前要跟它比一次（见 ⓪）。
      const storedNow = (() => { try { const s = readSel(); return (s && s.sessionId) ? String(s.sessionId) : ''; } catch (e) { return ''; } })();
      if (titlePinned()) {            // 已在这个会话上 → 不再点击、不再折腾侧栏
        // 到位后把"这次钉住的精确标题"记下来（DOM 里没有会话 id，标题就是钥匙）：
        // 以后先按这条标题找，会话列表顺序/分组折叠变化都不会再找错。
        try {
          const b0 = readBind();
          const exact = (window.__pinLastHitTitle || '').trim();
          const cur = (titleOf() || '').trim();
          const remember = cur || exact;
          if (remember && (!b0 || b0.title !== remember)) saveBind(remember);
        } catch (e) { }
        clearReloads();               // 到位即清零本面板的重载预算（本分区只有本面板，清零不会让对侧无限刷）
        dropClaim();                  // ★ 到位即让位：让另一个 AI 面板去改当前会话键（两边各一次就都到位）
        last = Date.now();
        refreshDiag(null);
        return;
      }
      if (Date.now() - last < 1500) return;
      // ⓪ 直达通道（写**本面板自己分区**的 dsh.sessions.current + reload 一次）★2026-09-19 三次定稿·重新启用★
      //   早先删掉它，是因为"两个面板共用 persist:harness、键只有一个值"⇒ 互抢 + 8 秒级对刷
      //   （用户实感「每隔一会跳一下刷新、一打字就断」）。
      //   现在每个带 sessionId 的面板有**自己的分区**（webview 的 panelPartition(meta)）⇒
      //   本面板写的键只有本面板读得到 ⇒ 互抢在结构上不可能 ⇒ 这条通道重新成为**首选**钉法。
      //   探针实测（<DSH根>\工具\probe-seed\，全新分区）：写目标 id + reload ⇒ 1.4 秒落在目标会话。
      //   预算：最多 RELOAD_MAX 次、两次之间隔 reloadGap()（sessionStorage 计数，跨 reload 存活，
      //   而且只在**本分区本面板**里，不会再被对侧清零）。用完就退回 ① 点侧栏会话行，不会无休止重载。
      //   ⚠ 判"到没到位"仍然只看本面板画面（titlePinned）—— 那是唯一可信的本面板状态；
      //     这里读键只用于判断"要不要写"，不用于判断"成没成"。
      if (SESSION_ID) {
        const curSel = (() => { try { const s = readSel(); return (s && s.sessionId) ? String(s.sessionId) : ''; } catch (e) { return ''; } })();
        if (curSel !== String(SESSION_ID) && readReloads() < RELOAD_MAX && (Date.now() - readReloadAt()) > reloadGap()) {
          bumpReloads();
          markReloadAt();
          if (writeSel(SESSION_ID)) {
            refreshDiag(null);
            try { location.reload(); } catch (e) { }
            return;                                  // reload 后脚本会重跑：那时键已是目标，应用直接进会话
          }
        }
      }
      // 说明：走到这里只有一种情形 —— 标题还不像目标：可能应用还在加载（下一轮就好）、
      //   会话行还没渲染（下面会展开分组 / 临时显示侧栏）、或该会话 id 已失效（被归档/删除）。
      // ① 兜底：按标题在会话行里精确匹配（找不到时放宽再找一遍）
      let hit = findBest(false) || findBest(true);
      if (hit) { doClick(hit); forceHide(); return; }
      // 找不到会话行：逐个展开折叠的工作区分组（每轮展开一个，等 React 渲染下轮再找）
      const collapsed = collapsedGroups();
      if (collapsed.length) {
        expandedByUs.push(collapsed[0]);
        fire(collapsed[0]);
        refreshDiag(null);
        return;
      }
      // 分组都展开了仍找不到：侧栏被精简模式隐藏时虚拟列表可能整个不渲染 →
      // 临时让侧栏"有尺寸但不可见"，等渲染完再找（随后立刻恢复隐藏）。最多重试 6 轮。
      if (forceTimes < 6) {
        forceTimes++;
        forceShow();
        refreshDiag(null);
        setTimeout(() => {
          const h2 = findBest();
          if (h2) doClick(h2);
          forceHide();
        }, 900);
        return;
      }
      refreshDiag(null);
    };
    setTimeout(clickItem, 1000);
    // 切场景后先用 1.5s 快节奏重试 20 次（尽快到位），之后 4s 常驻守着
    const fastTimer = setInterval(() => {
      clickItem();
      if (++tries >= 20) clearInterval(fastTimer);
    }, 1500);
    setInterval(clickItem, 4000);
    setInterval(() => refreshDiag(null), 4000);
    // 幂等标记 + 轻量 tick：宿主每 5 秒的重注入只会调 __pinTick（点一次 + 刷一次诊断），
    // 不再新装定时器 —— 见脚本开头的守卫。webview 内部重载后 window 重置，这里会重新执行。
    window.__pinGen = GEN;
    window.__pinTick = () => { try { clickItem(); refreshDiag(null); } catch (e) { } };

    // ---- 聊天滚动锚定：面板展开/收起（webview 视口变大变小）时稳住聊天内容 ----
    // 目的：展开瞬间不要"内容乱跳"。规则：原本贴底 → 展开后仍贴底；否则保持原阅读位置。
    (() => {
      if (window.__expandAnchor) return;
      window.__expandAnchor = true;
      const findScroller = () => {
        let n = document.querySelector('[data-chat-flow]') || document.querySelector('[data-phase]');
        while (n && n !== document.body) {
          try {
            const cs = getComputedStyle(n);
            if (n.scrollHeight - n.clientHeight > 40 && /(auto|scroll)/.test(cs.overflowY)) return n;
          } catch (e) { /* ignore */ }
          n = n.parentElement;
        }
        return document.scrollingElement || document.documentElement;
      };
      window.addEventListener('resize', () => {
        const el = findScroller();
        if (!el) return;
        const wasBottom = (el.scrollHeight - el.scrollTop - el.clientHeight) < 48;
        const prevTop = el.scrollTop;
        requestAnimationFrame(() => {
          try {
            if (wasBottom) el.scrollTop = el.scrollHeight;   // 原来贴底 → 继续贴底
            else el.scrollTop = prevTop;                     // 否则维持原来的阅读位置
          } catch (e) { /* ignore */ }
        });
      }, { passive: true });
    })();
  })();`;
  const HARNESS_FIX_JS = `(() => {
    const pick = () => {
      // 页面唯一带内联 grid-template-columns 且含 minmax( 的元素就是应用框架（已实测 grids=1）。
      const all = document.querySelectorAll('[style*="grid-template-columns"]');
      for (let i = 0; i < all.length; i++) {
        const v = all[i].style.gridTemplateColumns || '';
        if (v.indexOf('minmax(') >= 0) return all[i];
      }
      return null;
    };
    let WIDE = '';   // 铺满诊断（「1列 1354/1386px」），每次 fix 刷新
    const fix = () => {
      const f = pick();
      if (!f) return false;
      // 会话列铺满（三重法的 ①+②，见文件上方「会话列铺满」那段实测说明）：每次 fix 都重算一次，
      // React 重渲染把 max-width 顶回去也能在一秒内纠回来；顺带把实测宽度留给下面的诊断。
      try { WIDE = ${HARNESS_WIDE_PIN_JS}; } catch (e) { /* ignore */ }
      // 单轨道：配合下方结构隐藏，仅剩的中心列占满整个框架
      f.style.setProperty('grid-template-columns', 'minmax(0, 1fr)', 'important');
      // 结构法：定位中心列（含聊天流/会话），隐藏框架其余非定位子元素（侧栏列/详情列）
      let center = null;
      const flow = f.querySelector('[data-chat-flow]') || f.querySelector('[data-phase]');
      if (flow) {
        let n = flow;
        while (n && n.parentElement && n.parentElement !== f) n = n.parentElement;
        if (n && n.parentElement === f) center = n;
      }
      // 保护：中心列未定位到就不做结构隐藏，避免整面板空白
      if (center) {
        const kids = f.children;
        for (let i = 0; i < kids.length; i++) {
          const c = kids[i];
          if (c === center) continue;
          let pos = 'static';
          try { pos = getComputedStyle(c).position; } catch (e) { /* ignore */ }
          if (pos === 'absolute') continue;
          c.style.setProperty('display', 'none', 'important');
        }
      }
      f.querySelectorAll('[data-side="sidebar"], [data-side="details"], [data-width-handle]').forEach(function (h) {
        h.style.setProperty('display', 'none', 'important');
      });
      f.querySelectorAll('[data-phase]').forEach(function (r) {
        // ⚠ 这里以前还有一行「r.style.setProperty('--dsh-chat-content-width','100%','important')」，
        //   2026-09-20 第三波删掉：本版 [data-phase] 是连接状态小圆点按钮，不是会话相位容器，
        //   写在上面的宽度变量压根到不了会话列（实测列仍被 clamp 到 887px）。宽度改由
        //   文件上方 HARNESS_WIDE_PIN_JS 直接盖 [data-chat-flow] / [data-composer-card] 的 max-width
        //   并沿祖先链压变量——**不再依赖 [data-phase] 这个会跟着版本漂移的锚点**。
        // 隐藏不含聊天流的子元素（即会话顶栏；body 含 [data-chat-flow]，保留）
        const kids = r.children;
        let hasFlow = false;
        for (let j = 0; j < kids.length; j++) {
          if (kids[j].querySelector('[data-chat-flow]')) { hasFlow = true; break; }
        }
        if (!hasFlow) return;
        for (let j = 0; j < kids.length; j++) {
          const c = kids[j];
          if (c.querySelector('[data-chat-flow]')) continue;
          c.style.setProperty('display', 'none', 'important');
        }
      });
      if (flow) {
        const sc = flow.parentElement;
        if (sc && sc.firstElementChild && sc.firstElementChild !== flow) {
          sc.firstElementChild.style.setProperty('display', 'none', 'important');
        }
      }
      return true;
    };
    fix();
    // ★幂等守卫（2026-09-20 第三波补）★：宿主会 dom-ready/did-finish-load 各投一次、之后连续 30 秒
    //   每 1.5 秒再投一次，不守卫就会攒出几十个 MutationObserver + 1 秒循环空转（pin_v3 那边踩过同一个坑，
    //   表现为面板小字周期乱跳 + 白扫 DOM）。现在：注入一次就 fix 一次（上面那行在守卫外），定时器只装一轮。
    if (!window.__kunFixOn) {
      window.__kunFixOn = 1;
      try { new MutationObserver(fix).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] }); } catch (e) {}
      setInterval(fix, 1000);
    }
    const all = document.querySelectorAll('[style*="grid-template-columns"]');
    const f2 = pick();
    const vals = [];
    for (let i = 0; i < all.length && i < 5; i++) vals.push(all[i].style.gridTemplateColumns);
    const rootEl = document.getElementById('root') || document.body;
    return JSON.stringify({
      found: !!f2,
      grid: f2 ? f2.style.gridTemplateColumns : '',
      grids: all.length,
      vals: vals,
      iframes: document.querySelectorAll('iframe').length,
      hasPhase: document.querySelectorAll('[data-phase]').length,
      hasChatFlow: document.querySelectorAll('[data-chat-flow]').length,
      wide: WIDE,   // 铺满实测：「1列 1576/1592px」= 铺满几列 · 列宽/可用宽（宿主把它显示在面板标题行）
      rootKids: rootEl ? rootEl.children.length : -1,
      title: document.title,
      url: location.href
    });
  })();
  // ---- 钉住「oa系统运维」会话：面板固定显示该会话，主窗口切换会话不跟随 ----
  ${HARNESS_PIN_JS}
  `;

  const injectFix = async () => {
    try { await wv.insertCSS(HARNESS_CHAT_CSS); } catch (e) { /* ignore */ }
    // 拖文件进对话窗口（幂等脚本，装上监听后重复执行只返回）
    try { await wv.executeJavaScript(HARNESS_DROP_JS); } catch (e) { /* ignore */ }
    let simplify = '';
    let wideTxt = '';
    try {
      const r = await wv.executeJavaScript(HARNESS_FIX_JS);
      let info = null;
      try { info = JSON.parse(r); } catch (e) { /* ignore */ }
      if (info && info.found) simplify = '精简 ✓';
      else if (info) simplify = '等界面…';
      // 铺满实测（例 `铺满 1列 1576/1592px`）：两者只差十几像素（我们留的那 16px）就是铺开了；
      // 还差几百像素说明页面里没有 [data-chat-flow]（引擎换版了）——见文件上方「会话列铺满」。
      if (info && info.wide) { simplify += (simplify ? ' · ' : '') + '铺满 ' + info.wide; wideTxt = info.wide; }
    } catch (e) { /* ignore */ }
    // 钉会话诊断：HARNESS_PIN_JS 每次注入都会刷新 window.__pinDiag，这里读回来显示在面板标题行
    let pinTxt = '钉会话: 检测中…';
    try {
      const d = await wv.executeJavaScript('window.__pinDiag || null');
      if (d && d.targets) {
        const want = [String(d.sessionTitle || '')].filter(Boolean).concat(d.targets || []).join(' / ');
        const nz = (s) => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();   // ⚠ 保留空格：别把 'DSH 改造' 和 'DSH改造' 混成一个（同名孪生会话）
        // 面板当前显示的会话名（取自侧栏高亮行标题，权威）作为最终判据
        const live = String(d.title || '');
        const liveN = nz(live);
        const okName = (!!d.sessionTitle && liveN === nz(d.sessionTitle)) ||
          (d.targets || []).some(t => { const tn = nz(t); return tn && liveN.indexOf(tn) >= 0; });
        const boundOk = !!(d.bound && d.bound.title && liveN === nz(d.bound.title));
        const ok = boundOk || okName;
        const unbound = !d.sessionId && !d.sessionTitle && !(d.targets || []).length && !(d.bound && d.bound.title);
        pinTxt = unbound ? '○ 未绑定 · 面板自由选会话'
          : (boundOk ? '✓ 已钉绑定' : (ok ? '✓ 已钉' : ('未切到 · ' + (live || '读不到当前会话'))));
        if (unbound) diag.title = '该面板未绑定任何会话（场景 json 里没写 sessionTitle / sessionId / pinTarget）\n' +
          '面板停在它当前显示的会话上，不会被自动切换，也不再去找侧栏。\n' +
          '要重新绑定：给该面板补 sessionTitle + sessionId，再切一次场景即可（改了就会立刻生效）。';
        else diag.title = '该面板应对应的会话：' + want +
          '\n指定会话 id：' + (d.sessionId || '（未指定 · 靠标题匹配）') +
          '\n应用存储里的当前会话：' + (d.stored || '（空）') + (String(d.stored) === String(d.sessionId) && d.sessionId ? ' ✓ 一致' : '') +
          (d.reloads ? ('\n直达通道残留计数 ' + d.reloads + ' 次（该通道已停用）') : '') +
          '\n面板当前显示的会话：' + (live || '（读不到）') + (d.titleSrc ? ('（来源：' + d.titleSrc + '）') : '') +
          (d.bound && d.bound.title ? ('\n已记住的会话标题：' + d.bound.title) : '\n已记住的会话标题：（无 · 首次按名字找）') +
          '\n界面可识别会话行/选中行数：' + (d.rows == null ? '未知' : d.rows) +
          (d.matched ? ('\n已定位到会话行：' + d.matched + '（' + d.by + '）') : '\n未定位到目标会话行（分组折叠或列表未渲染）') +
          (d.cands && d.cands.length ? ('\n界面里能看到的会话/行：' + d.cands.join(' ｜ ')) : '\n界面里能看到的会话/行：（读不到）') +
          (wideTxt ? ('\n会话列铺满：' + wideTxt + '（列宽 / 可用宽；只差十几像素＝已铺满，差几百＝没铺上，多半引擎换版了）') : '') +
          '\n\n点击此处 = 忘掉记住的标题，重新按会话名匹配';
      }
    } catch (e) { /* ignore */ }
    diag.textContent = (simplify ? simplify + ' · ' : '') + pinTxt;
  };
  // 主进程通道注入（更可靠）：轮询 webview 的 webContentsId，让 main 直接注入并写日志
  // ⚠ 注意：main.js 注入脚本里**旧版**还带一套"扫全文档模糊匹配后点击"的钉会话循环
  //   （每 4s 点一次），它会和渲染层的新逻辑打架 —— 渲染层刚钉对，它又把面板点到
  //   聊天记录里含同名字样的随便一个元素上，于是"切场景后会话错乱/切不过去"。
  //   这里固定传一个**绝不可能匹配到任何元素**的哨兵目标（NUL 字符不会出现在任何 textContent 里），
  //   于是 main 侧只保留"注入布局修复 + 截图 + 日志"，点击权完全交给本文件的 HARNESS_PIN_JS。
  const mainInject = () => {
    try {
      if (!wv || !wv.getWebContentsId) return;
      const id = wv.getWebContentsId();
      if (id === -1 || typeof window.app.injectHarnessPanel !== 'function') return;
      window.app.injectHarnessPanel(id, '\u0000no-pin\u0000');
    } catch (e) { /* ignore */ }
  };

  const load = async () => {
    if (disposed) return;
    try {
      const ready = await window.app.isHarnessReady();
      if (!ready) {
        msg.textContent = 'Harness 引擎尚未就绪。请稍候或点击「重试」。';
        const retry = el('button', 'file-refresh', '🔄 重试');
        retry.addEventListener('click', () => { msg.textContent = '正在加载对话窗口…'; load(); });
        msg.appendChild(retry);
        return;
      }
      const url = await window.app.getHarnessUrl();
      body.innerHTML = '';
      wv = document.createElement('webview');
      wv.className = 'harness-wv';
      // ⚠ 分区策略（2026-09-19 三次定稿·探针实测）：**带 sessionId 的面板一板一分区**（panelPartition）。
      //   探针证据（<DSH根>\工具\probe-seed\，隐藏 Electron + 真引擎 + 全新分区）：
      //   写入 dsh.sessions.current = 目标 id 后 reload ⇒ 1.4 秒即落在目标会话（标题、正文全对）。
      //   旧注释"独立分区会卡在欢迎页"是误判（当时快照取太早）；但旧注释另一半是对的：
      //   共用分区时"写键 + reload"必然互抢 ⇒ 那才是 2026-09-19「每隔一会跳一下刷新」的真因。
      //   ⇒ 现在两者合起来用：分区私有 + 各自写自己的键，既确定又不互抢。
      //   没带 sessionId 的面板仍然退回 soloHarnessPartition()（主窗口 = persist:harness，与主标签同分区）。
      wv.setAttribute('partition', panelPartition(meta));
      wv.setAttribute('allowpopups', '');
      wv.addEventListener('dom-ready', injectFix);
      wv.addEventListener('did-finish-load', injectFix);
      // 主进程通道 + 宿主定时兜底：加载后前 30 秒每 1.5 秒重注入
      hostTimer = setInterval(() => {
        if (disposed) return;
        if (!wv || !wv.getWebContentsId) return;
        if (wv.getWebContentsId() === -1) return;
        mainInject();
        injectFix();
      }, 1500);
      setTimeout(() => { if (hostTimer) clearInterval(hostTimer); }, 30000);
      // 常驻钉住：每 5 秒轻量重注入一次（webview 内部重载后钉住仍生效；脚本自身幂等）
      pinTimer = setInterval(() => {
        if (disposed) return;
        try { if (wv && wv.executeJavaScript) wv.executeJavaScript(HARNESS_PIN_JS + '\n' + HARNESS_DROP_JS).catch(function () { }); } catch (e) { /* ignore */ }
      }, 5000);
      wv.setAttribute('src', url);
      body.appendChild(wv);
    } catch (e) {
      msg.textContent = '加载失败：' + (e && e.message || e);
    }
  };
  load();
  // 场景切换清理：停止注入定时器（webview DOM 由 loadScenario 统一移除）
  return () => {
    disposed = true;
    if (hostTimer) clearInterval(hostTimer);
    if (pinTimer) clearInterval(pinTimer);
  };
};

// ============ 个人站场景（personal-site）：官网预览 / 关于 / 自媒体 / 联系 / 投喂 ============
var SITE_BASE = null;
function siteBase() {
  if (SITE_BASE) return Promise.resolve(SITE_BASE);
  const p = (window.app && window.app.site && window.app.site.preview)
    ? window.app.site.preview()
    : Promise.resolve(null);
  return p.then(function (r) {
    SITE_BASE = (r && r.base) || '';
    return SITE_BASE;
  }).catch(function () { SITE_BASE = ''; return ''; });
}

// 二维码大图弹层（点击外部关闭）
var siteQrLayer = null;
function showQr(src, title) {
  if (!siteQrLayer) {
    siteQrLayer = el('div', 'site-qr-layer');
    siteQrLayer.addEventListener('click', function () { siteQrLayer.style.display = 'none'; });
    document.body.appendChild(siteQrLayer);
  }
  siteQrLayer.innerHTML = '';
  const box = el('div', 'site-qr-box');
  if (title) box.appendChild(el('div', 'site-qr-title', title));
  const img = document.createElement('img');
  img.src = src;
  box.appendChild(img);
  box.appendChild(el('div', 'site-qr-close', '✕ 点击关闭'));
  siteQrLayer.appendChild(box);
  siteQrLayer.style.display = 'flex';
}

// 官网本地文件夹：浏览 <你的站点工程>（可进入子目录；点击文件经静态服务在浏览器打开）
renderers['site-folder'] = (body, meta, head) => {
  body.classList.add('site-folder');
  const K = window.app && window.app.site;
  const ROOT_LABEL = '<盘根>\\项目工程\\我的官网';
  // 标题栏右侧：当前路径（带背景栏）——路径只显示此处，内容区保持清爽
  const crumbs = el('div', 'file-crumbs', '加载中…');
  if (head) {
    head.classList.add('file-head');
    const acts = el('div', 'file-head-acts');
    acts.appendChild(crumbs);
    head.appendChild(acts);
  }
  const list = el('div', 'file-list');
  body.appendChild(list);

  // 内容可拖动：按住列表任意处上下/左右拖动即可平移浏览（像拖画布），松手停住。
  // 拖动超过 4px 阈值后抑制这一次 click，避免拖动时误进目录/误开文件。
  let dragOn = false, dragMoved = false, dragX = 0, dragY = 0, dragTop = 0, dragLeft = 0;
  list.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0) return;
    // 条目上按住＝拖出文件（交给原生拖动），只有空白处才启动平移
    if (ev.target && ev.target.closest && ev.target.closest('.file-row')) return;
    dragOn = true; dragMoved = false;
    dragX = ev.clientX; dragY = ev.clientY;
    dragTop = list.scrollTop; dragLeft = list.scrollLeft;
  });
  window.addEventListener('mousemove', (ev) => {
    if (!dragOn) return;
    const dx = ev.clientX - dragX, dy = ev.clientY - dragY;
    if (!dragMoved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
      dragMoved = true;
      list.classList.add('dragging');
    }
    if (!dragMoved) return;
    list.scrollTop = dragTop - dy;
    list.scrollLeft = dragLeft - dx;
    ev.preventDefault();
  });
  window.addEventListener('mouseup', () => {
    if (!dragOn) return;
    dragOn = false;
    list.classList.remove('dragging');
  });
  // 捕获阶段吃掉“拖动结束”的那一次 click（否则松手会误打开目录/文件）
  list.addEventListener('click', (ev) => {
    if (!dragMoved) return;
    dragMoved = false;
    ev.stopPropagation();
    ev.preventDefault();
  }, true);

  const fmtSize = (n) => {
    if (n == null) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  };
  const fmtTime = (t) => {
    if (!t) return '—';
    const d = new Date(t * 1000);
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  };
  const joinRel = (r, name) => r ? r + '/' + name : name;
  const parentRel = (r) => {
    const i = r.lastIndexOf('/');
    return i > 0 ? r.slice(0, i) : '';
  };
  const urlOf = (rel) => {
    // 相对路径逐段编码（目录名可能含中文/空格），经主进程静态服务打开
    return (base || '') + '/' + rel.split('/').map(encodeURIComponent).join('/');
  };
  let base = '';
  const mkRow = (ic, name, metaText, isDir, onOpen, relPath) => {
    const r = el('div', 'file-row');
    r.appendChild(el('span', 'ic', ic));
    r.appendChild(el('span', 'grow', name));
    r.appendChild(el('span', 'meta', metaText));
    if (isDir) r.style.cursor = 'pointer';
    if (onOpen) r.addEventListener('click', onOpen);
    // 可拖出：按住条目拖到资源管理器＝复制一份；拖到浏览器/编辑器等窗口＝把文件直接交给它。
    // 走 Electron 原生拖动（主进程 startDrag），所以 dragstart 里先 preventDefault，再由主进程接管。
    if (relPath && K && K.startDrag) {
      r.setAttribute('draggable', 'true');
      r.title = (isDir ? '点击进入' : '点击打开') + '\n按住拖出去：拖到资源管理器＝复制一份，拖到其他窗口＝直接给它';
      r.addEventListener('dragstart', (ev) => {
        ev.preventDefault();
        K.startDrag(relPath);
        r.classList.add('dragging-out');
        setTimeout(() => { r.classList.remove('dragging-out'); }, 1500);
      });
    } else if (isDir) {
      r.title = '点击进入';
    }
    return r;
  };
  const load = (rel) => {
    list.innerHTML = '';
    list.appendChild(el('div', 'file-empty', '加载中…'));
    if (!K || !K.files) {
      crumbs.textContent = ROOT_LABEL + '（无本地文件服务）';
      list.innerHTML = '';
      list.appendChild(el('div', 'file-empty', '（本地文件服务不可用）'));
      return;
    }
    K.files(rel).then(res => {
      if (!res || !res.ok) {
        list.innerHTML = '';
        list.appendChild(el('div', 'file-empty', '无法读取：' + ((res && res.err) || '未知')));
        return;
      }
      base = res.base;
      const cur = res.rel || '';
      crumbs.textContent = cur ? (ROOT_LABEL + '\\' + cur.replace(/\//g, '\\')) : ROOT_LABEL;
      crumbs.title = crumbs.textContent;
      list.innerHTML = '';
      if (cur) {
        list.appendChild(mkRow('↩️', '..', '上级目录', true, () => load(parentRel(cur))));
      }
      (res.rows || []).forEach(it => {
        const relChild = joinRel(cur, it.name);
        list.appendChild(mkRow(it.isDir ? '📁' : '📄', it.name,
          it.isDir ? '目录' : fmtSize(it.size) + ' · ' + fmtTime(it.mtime),
          it.isDir, () => {
            if (it.isDir) { load(relChild); }
            else {
              const url = urlOf(relChild);
              if (window.app && window.app.site && window.app.site.open) window.app.site.open(url);
              else window.open(url);
            }
          }, relChild));
      });
      if (!res.rows || !res.rows.length) list.appendChild(el('div', 'file-empty', '（空目录）'));
    }).catch(() => {
      list.innerHTML = '';
      list.appendChild(el('div', 'file-empty', '读取失败'));
    });
  };
  load('');
};

// 官网预览：webview 内嵌 <你的站点工程>\index.html（主进程静态服务）
renderers['site-preview'] = (body, meta, head) => {
  body.classList.add('site-preview-panel');
  const msg = el('div', 'site-msg', '正在加载官网预览…');
  body.appendChild(msg);
  let wv = null;          // 当前内嵌的 webview（「刷新网页」按钮要操作它）
  if (head) {
    const acts = el('div', 'file-head-acts');
    // 🔄 刷新网页：改完本地 index.html / 素材后不用重启工作台，点一下就能看到新效果
    // 用 reloadIgnoringCache()：静态服务对同一个 URL 可能走缓存，普通 reload() 会看到旧页面
    const reloadBtn = el('button', 'file-refresh', '🔄 刷新网页');
    reloadBtn.title = '重新载入本地网页（跳过缓存）—— 改完 index.html 点这里立刻看效果';
    reloadBtn.addEventListener('click', function () {
      if (wv && typeof wv.reloadIgnoringCache === 'function') {
        wv.reloadIgnoringCache();
      } else if (wv && typeof wv.reload === 'function') {
        wv.reload();
      } else {
        load();                 // 还没加载出来 / 上次加载失败 → 整个重来一遍
        return;
      }
      reloadBtn.textContent = '🔄 刷新中…';
      setTimeout(function () { reloadBtn.textContent = '🔄 刷新网页'; }, 800);
    });
    acts.appendChild(reloadBtn);
    const openBtn = el('button', 'file-refresh', '🌐 浏览器打开');
    openBtn.title = '在系统浏览器打开官网';
    openBtn.addEventListener('click', function () {
      siteBase().then(function (base) {
        const url = base ? base + '/index.html' : '<盘根>\\项目工程\\我的官网\\index.html';
        if (window.app && window.app.site && window.app.site.open) window.app.site.open(url);
        else window.open(url);
      });
    });
    acts.appendChild(openBtn);
    head.appendChild(acts);
  }
  const load = async () => {
    try {
      const r = (window.app && window.app.site && window.app.site.preview)
        ? await window.app.site.preview()
        : null;
      if (!r || !r.ok) {
        msg.textContent = '官网目录不可用：<盘根>\\项目工程\\我的官网（缺失或无法访问）。';
        return;
      }
      SITE_BASE = r.base;
      body.innerHTML = '';
      wv = document.createElement('webview');
      wv.className = 'site-wv';
      wv.setAttribute('partition', 'persist:site');   // 个人站独立会话，不与 Harness 冲突
      // 官网是浅色主题，默认滚动条偏白刺眼：注入暗色科技风滚动条（青色高亮）
      const SITE_SCROLL_CSS = [
        '::-webkit-scrollbar { width: 9px; height: 9px; }',
        '::-webkit-scrollbar-track { background: rgba(10,14,20,.25); }',
        '::-webkit-scrollbar-thumb { background: rgba(6,231,233,.38); border-radius: 5px; border: 2px solid rgba(10,14,20,.3); }',
        '::-webkit-scrollbar-thumb:hover { background: rgba(6,231,233,.68); }',
        '::-webkit-scrollbar-corner { background: transparent; }'
      ].join('\n');
      const injectScroll = function () {
        try { wv.insertCSS(SITE_SCROLL_CSS); } catch (e) { /* ignore */ }
      };
      wv.addEventListener('dom-ready', injectScroll);
      wv.addEventListener('did-finish-load', injectScroll);
      wv.setAttribute('src', r.url);
      body.appendChild(wv);
    } catch (e) {
      msg.textContent = '加载失败：' + (e && e.message || e);
    }
  };
  load();
};

// 关于<机主>：头像 + 简介 + 标签 + 时间线
renderers['site-about'] = (body, meta, head) => {
  body.classList.add('site-about');
  siteBase().then(function (base) {
    const card = el('div', 'site-about-card');
    const avatar = document.createElement('img');
    avatar.className = 'site-avatar';
    avatar.src = base + '/头像/<机主>头像像素画.png';
    avatar.alt = '<机主>';
    card.appendChild(avatar);
    card.appendChild(el('div', 'site-name', '<机主>'));
    card.appendChild(el('div', 'site-slogan', '梦想是优雅地淋一场雨'));
    const tags = ['像素画', '前端', 'AI 工具', '独立开发者', 'UP主'];
    const tagRow = el('div', 'site-tags');
    tags.forEach(function (t) { tagRow.appendChild(el('span', 'site-tag', t)); });
    card.appendChild(tagRow);
    card.appendChild(el('div', 'site-desc',
      '「<机主> · 个人站」作者：像素风 + 下雨背景的个人网站，上架小工具，分享创作内容。'));
    const tl = el('div', 'site-tl');
    [
      ['2026 · 建站', '个人官网「<机主>」上线（像素风 · 下雨主题）'],
      ['2026 · 工具', '「上班盯盘助手」上架 Cloudflare Pages'],
      ['2026 · 内容', 'B站 / 抖音 / 小红书 持续更新像素画与创作']
    ].forEach(function (it) {
      const row = el('div', 'site-tl-row');
      row.appendChild(el('span', 'site-tl-t', it[0]));
      row.appendChild(el('span', 'site-tl-d', it[1]));
      tl.appendChild(row);
    });
    card.appendChild(tl);
    body.appendChild(card);
  });
};

// 自媒体账号：B站 / 抖音 / 小红书 卡片（打开主页 + 二维码弹层）
renderers['site-media'] = (body, meta, head) => {
  body.classList.add('site-media');
  const MEDIA = [
    { name: '哔哩哔哩', handle: '@<机主>', emoji: '📺', url: 'https://space.bilibili.com/96822050', qr: '/账号二维码/哔哩哔哩.jpg' },
    { name: '抖音', handle: '@<机主>（蛋炒饭里悟真我）', emoji: '🎵', url: 'https://www.douyin.com/user/MS4wLjABAAAAV55NIdPri0csj-Gwi0vT4Yuuest0zIvnTZGxe2K3YAXuESpAombXp397aY98jDq-', qr: '/账号二维码/抖音.png' },
    { name: '小红书', handle: '@<机主>', emoji: '📕', url: 'https://www.xiaohongshu.com/user/profile/64be86b700000000140342cb', qr: '/账号二维码/小红书.png' }
  ];
  siteBase().then(function (base) {
    const grid = el('div', 'site-media-grid');
    MEDIA.forEach(function (m) {
      const c = el('div', 'site-media-card');
      c.appendChild(el('div', 'site-media-emoji', m.emoji));
      c.appendChild(el('div', 'site-media-name', m.name));
      c.appendChild(el('div', 'site-media-handle', m.handle));
      const btns = el('div', 'site-media-btns');
      const open = el('button', 'site-btn', '打开主页 ↗');
      open.addEventListener('click', function () { window.open(m.url); });
      const qr = el('button', 'site-btn', '二维码');
      qr.addEventListener('click', function () { showQr(base + m.qr, m.name + ' · ' + m.handle); });
      btns.appendChild(open); btns.appendChild(qr);
      c.appendChild(btns);
      grid.appendChild(c);
    });
    body.appendChild(grid);
  });
};

// 项目管理：项目卡片列表（图标 + 名字 + 状态 + 描述 + 本地路径 + 操作）
renderers['site-projects'] = (body, meta, head) => {
  body.classList.add('site-projects');
  // 项目数据：以后管理就在这里增删改
  const PROJECTS = [
    {
      icon: '/小工具/上班盯盘助手图标.png',
      name: '上班盯盘助手',
      status: '已上线',
      desc: '股票摸鱼小工具 · 像素风',
      path: '<盘根>\\项目工程\\股票小工具',
      url: 'https://<你的工具站>/'
    }
  ];
  siteBase().then(function (base) {
    const list = el('div', 'site-projects-list');
    PROJECTS.forEach(function (p) {
      const card = el('div', 'site-project-card');
      // 头部：图标 + 名字 + 状态
      const top = el('div', 'site-project-top');
      const img = document.createElement('img');
      img.className = 'site-project-icon';
      img.src = base + p.icon;
      img.alt = p.name;
      top.appendChild(img);
      const info = el('div', 'site-project-info');
      // 「已上线」很小的字，放在名字上面（不增加卡片高度）
      const st = el('span', 'site-project-status-mini', p.status);
      if (String(p.status || '').indexOf('已') === 0) st.classList.add('ok');
      info.appendChild(st);
      const nameRow = el('div', 'site-project-name-row');
      nameRow.appendChild(el('div', 'site-project-name', p.name));
      // 描述并入名字行（不单独占一行）
      if (p.desc) nameRow.appendChild(el('span', 'site-project-desc-inline', '· ' + p.desc));
      info.appendChild(nameRow);
      top.appendChild(info);
      // 右上角：路径小字 + 打开文件夹按钮（同一行，路径在前按钮在后，紧凑）
      if (p.path) {
        const pathRow = el('div', 'site-project-path', p.path);
        pathRow.title = '本地项目目录（可选中复制）';
        top.appendChild(pathRow);
      }
      const openDir = el('button', 'site-project-open', '📁 打开');
      openDir.title = '在资源管理器打开 ' + p.path;
      openDir.addEventListener('click', function () {
        if (window.app && window.app.site && window.app.site.openFolder) window.app.site.openFolder(p.path);
      });
      top.appendChild(openDir);
      card.appendChild(top);
      list.appendChild(card);
    });
    if (!PROJECTS.length) list.appendChild(el('div', 'file-empty', '（暂无项目，内容预留）'));
    body.appendChild(list);
  });
};

// 我的网址：一条一条的列表（图标 + 名字 + 网址标签 + 在线状态，点击在浏览器打开）
// 个人站为置顶网站（下方横栏分隔）；其余为个人站内容的相关链接；每 1 分钟自动探测一次在线状态
renderers['site-urls'] = (body, meta, head) => {
  body.classList.add('site-media');
  let urlTimer = null;    // 每 1 分钟在线探测（场景切换时清理）
  let disposed = false;
  // 网址数据：以后管理就在这里增删改（icon 为官网目录内相对路径；links 支持多条并标注；pinned 标记置顶）
  const URLS = [
    {
      icon: '/头像/<机主>头像像素画.png', name: '个人站', pinned: true,
      links: [{ label: 'Pages', url: 'https://<你的站点>/' }]
    },
    {
      icon: '/小工具/上班盯盘助手官网大图.png', name: '上班盯盘助手',
      links: [
        { label: 'GitHub', url: 'https://<你的GitHub账号>.github.io/shangban-dingpan/#donate' },
        { label: 'Pages', url: 'https://<你的工具站>/' }
      ]
    }
  ];
  const openUrl = function (url) {
    if (window.app && window.app.site && window.app.site.open) window.app.site.open(url);
    else window.open(url);
  };
  const K = window.app && window.app.site;
  // 标题栏：探测说明小字 + 探测按钮
  if (head) {
    head.classList.add('file-head');
    const acts = el('div', 'file-head-acts');
    const note = el('span', 'site-probe-note', '⏱ 每 1 分钟探测一次');
    acts.appendChild(note);
    const probeBtn = el('button', 'file-refresh', '🔍 探测');
    probeBtn.title = '立即探测所有网址状态';
    acts.appendChild(probeBtn);
    head.appendChild(acts);
  }
  siteBase().then(function (base) {
    const grid = el('div', 'site-media-grid');
    // 状态管理：卡片级（该卡片所有链接全部失败才算离线）
    const rows = [];
    const statusEls = [];
    URLS.forEach(function (it) {
      const row = el('div', 'site-url-row' + (it.pinned ? ' pinned' : ''));
      const img = document.createElement('img');
      img.className = 'site-url-icon';
      img.src = base + it.icon;
      img.alt = it.name;
      row.appendChild(img);
      const info = el('div', 'site-url-info');
      const nameRow = el('div', 'site-url-name-row');
      nameRow.appendChild(el('div', 'site-url-name', it.name));
      info.appendChild(nameRow);
      const links = el('div', 'site-url-links');
      it.links.forEach(function (l) {
        const chip = el('a', 'site-url-chip');
        chip.title = '在浏览器打开 ' + l.url;
        if (l.label) chip.appendChild(el('span', 'site-url-chip-label', l.label));
        chip.appendChild(el('span', 'site-url-chip-url', String(l.url).replace(/^https?:\/\//, '')));
        chip.addEventListener('click', function (ev) {
          ev.stopPropagation();
          openUrl(l.url);
        });
        links.appendChild(chip);
      });
      info.appendChild(links);
      row.appendChild(info);
      // 右侧：网站状态
      const st = el('span', 'site-url-status', '…探测中');
      st.title = '网站在线状态';
      row.appendChild(st);
      row.title = '打开 ' + (it.links[0] ? it.links[0].url : '');
      row.addEventListener('click', function () {
        if (it.links.length) openUrl(it.links[0].url);
      });
      grid.appendChild(row);
      rows.push(row);
      statusEls.push({ it: it, el: st });
      // 置顶卡片之后插入横栏：其余均为个人站内容的相关链接
      if (it.pinned) {
        const bar = el('div', 'site-url-bar');
        bar.appendChild(el('span', 'site-url-bar-l', '个人站 · 置顶网站'));
        bar.appendChild(el('span', 'site-url-bar-r', '以下为个人站内容的相关链接'));
        grid.appendChild(bar);
      }
    });
    // 状态探测：全部卡片并发出探测；每 1 分钟自动一次
    const probe = function () {
      statusEls.forEach(function (se) {
        if (!se.it.links.length) { se.el.textContent = '—'; return; }
        se.el.textContent = '…探测中';
        se.el.className = 'site-url-status pending';
        let doneN = 0, okN = 0, failN = 0;
        se.it.links.forEach(function (l) {
          const p = (K && K.probe) ? K.probe(l.url) : Promise.resolve({ ok: false });
          p.then(function (r) {
            doneN++;
            if (r && r.ok) okN++; else failN++;
            if (doneN === se.it.links.length) {
              if (okN > 0) { se.el.textContent = '● 在线'; se.el.className = 'site-url-status on'; }
              else { se.el.textContent = '● 离线'; se.el.className = 'site-url-status off'; }
            }
          }).catch(function () {
            doneN++;
            if (doneN === se.it.links.length) {
              se.el.textContent = '● 离线'; se.el.className = 'site-url-status off';
            }
          });
        });
      });
    };
    probe();
    if (!disposed) urlTimer = setInterval(probe, 60000);
    // 探测按钮：手动立即探测
    if (head) {
      const btn = head.querySelector('.file-refresh');
      if (btn) btn.addEventListener('click', probe);
    }
    if (!URLS.length) grid.appendChild(el('div', 'file-empty', '（暂无网址，内容预留）'));
    body.appendChild(grid);
  });
  // 场景切换清理：停止在线探测定时器
  return () => { disposed = true; if (urlTimer) clearInterval(urlTimer); };
};

// ============ Blender 场景（blender）：实时画面 / 本地文件 ============
// 场景独立性：只走 window.app.blender 这一套 IPC，不读股票 / OA / 个人站的任何数据。
// 画面来自主进程的抓帧进程（PrintWindow 抓 Blender 窗口 → JPEG），由本地静态服务直出，
// 渲染层只负责带时间戳轮询同一张图，所以帧数据不经过 IPC。

// Blender 实时画面（大窗口）
renderers['bl-live'] = (body, meta, head) => {
  const K = window.app && window.app.blender;
  body.classList.add('bl-live');
  let disposed = false, running = false;
  let stateTimer = null;

  const dot = el('span', 'bl-dot');
  const note = el('span', 'bl-note', '检测中…');
  let launchBtn = null, reembedBtn = null, closeBtn = null;
  if (head) {
    head.classList.add('file-head');
    const acts = el('div', 'file-head-acts');
    acts.appendChild(dot);
    acts.appendChild(note);
    launchBtn = el('button', 'file-refresh', '▶ 启动');
    launchBtn.title = '启动 Blender（自动开启 MCP 服务器，省去手点 N 面板）';
    closeBtn = el('button', 'file-refresh', '✕ 关闭');
    closeBtn.title = '关闭 Blender：先解除内置再退出；有未保存改动时它会自己弹保存提示';
    reembedBtn = el('button', 'file-refresh', '⧉ 重新内置');
    reembedBtn.title = '先把 Blender 放回桌面，再重新嵌进面板（画面异常时点这个）';
    acts.appendChild(launchBtn);
    acts.appendChild(closeBtn);
    acts.appendChild(reembedBtn);
    head.appendChild(acts);
  }

  const stage = el('div', 'bl-stage');
  const blank = el('div', 'bl-blank');
  const ico = document.createElement('img');
  ico.className = 'bl-blank-ico';
  ico.src = 'assets/blender-icon.png';
  ico.alt = 'Blender';
  blank.appendChild(ico);
  const blankTitle = el('div', 'bl-blank-t', 'Blender 未运行');
  const blankDesc = el('div', 'bl-blank-d', '点「启动」打开 Blender，它会自动嵌进这个面板，可以直接在里面建模改参数');
  const blankBtn = el('button', 'bl-blank-btn', '▶ 启动 Blender');
  blank.appendChild(blankTitle);
  blank.appendChild(blankDesc);
  blank.appendChild(blankBtn);
  stage.appendChild(blank);
  body.appendChild(stage);

  const doLaunch = async () => {
    if (!K) return;
    note.textContent = '正在启动 Blender…';
    blankDesc.textContent = '正在启动 Blender，请稍候（首次启动约 10 秒）…';
    const r = await K.launch();
    if (r && !r.ok) { note.textContent = '启动失败'; blankDesc.textContent = r.err || '启动失败'; return; }
    triedForRun = false;
    setTimeout(() => { refreshState(); }, 3000);
  };
  if (launchBtn) launchBtn.addEventListener('click', doLaunch);
  blankBtn.addEventListener('click', doLaunch);
  // ---------- 只内置模式 ----------
  // 面板不再做截图预览：直接把 Blender 主窗口 SetParent 进来，在里面直接操作。
  // 主进程侧保险：面板切走、GUI 关闭、GUI 崩溃都会把 Blender 释放回桌面。
  let embedded = false, embedBusy = false, embedRO = null, moveTimer = null, triedForRun = false;

  // 只回 CSS px（视口坐标）；主进程负责加上窗口内容区位置并换算成屏幕物理像素
  function panelRect() {
    const r = stage.getBoundingClientRect();
    return {
      x: Math.round(r.left), y: Math.round(r.top),
      w: Math.round(r.width), h: Math.round(r.height)
    };
  }
  function pushMove() {
    if (!embedded || !K || !K.embedMove) return;
    if (moveTimer) clearTimeout(moveTimer);
    moveTimer = setTimeout(() => { try { K.embedMove(panelRect()); } catch (e) { /* ignore */ } }, 120);
  }
  async function releaseEmbed() {
    if (embedRO) { try { embedRO.disconnect(); } catch (e) { /* ignore */ } embedRO = null; }
    window.removeEventListener('resize', pushMove);
    if (!embedded) return;
    embedded = false;
    stage.classList.remove('embedded');
    try { if (K && K.embed) await K.embed(false, null); } catch (e) { /* ignore */ }
  }
  async function embedNow() {
    if (!K || !K.embed || embedBusy || disposed || embedded) return;
    const rc = panelRect();
    if (rc.w < 80 || rc.h < 80) {          // 布局还没稳，等一拍再来，别用退化矩形去内置
      setTimeout(() => { if (!disposed) embedNow(); }, 350);
      return;
    }
    embedBusy = true;
    try {
      setDot('warn', '正在内置…');
      const r = await K.embed(true, panelRect());
      if (disposed) return;
      if (r && r.ok) {
        embedded = true;
        stage.classList.add('embedded');
        setDot('ok', '已内置 · 直接操作');
        if (window.ResizeObserver) { embedRO = new ResizeObserver(pushMove); embedRO.observe(stage); }
        window.addEventListener('resize', pushMove);
      } else {
        setDot('err', '内置失败：' + ((r && r.err) || '未知'));
      }
    } catch (e) {
      setDot('err', '内置异常');
    } finally {
      embedBusy = false;
    }
  }

  const setDot = (cls, text) => {
    dot.className = 'bl-dot ' + cls;
    note.textContent = text;
  };

  async function refreshState() {
    if (disposed || !K) return;
    let s = null;
    try { s = await K.state({ capture: false }); } catch (e) { s = null; }
    if (disposed) return;
    if (!s) { setDot('err', '状态未知'); return; }
    running = !!s.running;
    if (!running) {
      triedForRun = false;
      if (embedded) await releaseEmbed();
      setDot('off', '未运行');
      return;
    }
    if (embedded) { setDot('ok', '已内置 · 直接操作'); return; }
    if (!triedForRun && !embedBusy) { triedForRun = true; embedNow(); }
  }

  if (reembedBtn) reembedBtn.addEventListener('click', async () => {
    if (embedBusy) return;
    await releaseEmbed();
    triedForRun = false;
    await refreshState();
  });

  // ---------- 关闭 Blender ----------
  // 默认优雅关闭（Blender 自己会弹保存提示）。只有确认框里点了「确定」才强杀。
  const doClose = async () => {
    if (!K || !K.close || embedBusy) return;
    embedBusy = true;
    if (closeBtn) closeBtn.disabled = true;
    try {
      setDot('warn', '正在关闭 Blender…');
      let r = null;
      try { r = await K.close(); } catch (e) { r = null; }

      // 本地状态复位：窗口已经还给桌面了
      embedded = false;
      stage.classList.remove('embedded');
      if (embedRO) { try { embedRO.disconnect(); } catch (e) { /* ignore */ } embedRO = null; }
      window.removeEventListener('resize', pushMove);
      triedForRun = true;   // 关掉之后别自动又把它内置回来

      if (r && r.already) {
        setDot('off', '未运行');
      } else if (r && r.closed) {
        setDot('off', '已关闭');
      } else {
        setDot('warn', '已发送关闭请求');
        const force = window.confirm(
          'Blender 还没有退出。\n\n' +
          '通常是因为弹出了「是否保存」对话框，或者它正忙。\n\n' +
          '要强制结束 Blender 吗？未保存的内容会丢失。');
        if (force) {
          setDot('warn', '正在强制结束…');
          try { await K.close({ force: true }); } catch (e) { /* ignore */ }
        }
      }
    } finally {
      embedBusy = false;
      if (closeBtn) closeBtn.disabled = false;
    }
    setTimeout(refreshState, 900);
  };
  if (closeBtn) closeBtn.addEventListener('click', doClose);

  // 只内置模式：不再需要抓帧进程，进来就停掉它
  try { if (K && K.capture) K.capture(false); } catch (e) { /* ignore */ }

  stateTimer = setInterval(refreshState, 4000);
  refreshState();

  return () => {
    disposed = true;
    if (stateTimer) clearInterval(stateTimer);
    if (moveTimer) clearTimeout(moveTimer);
    if (embedRO) { try { embedRO.disconnect(); } catch (e) { /* ignore */ } embedRO = null; }
    window.removeEventListener('resize', pushMove);
    // 面板要没了 —— 必须把 Blender 还回桌面，否则窗口会跟着这个面板一起消失
    if (embedded) { try { if (K && K.embed) K.embed(false, null); } catch (e) { /* ignore */ } }
  };
};

// Blender 本地文件（工作区浏览：<素材目录>\blender控制）
renderers['bl-folder'] = (body, meta, head) => {
  const K = window.app && window.app.blender;
  body.classList.add('bl-folder');
  let disposed = false, rel = '';

  const crumbs = el('div', 'file-crumbs', '加载中…');
  if (head) {
    head.classList.add('file-head');
    const acts = el('div', 'file-head-acts');
    acts.appendChild(crumbs);
    const openBtn = el('button', 'file-refresh', '📂');
    openBtn.title = '在资源管理器打开当前目录';
    openBtn.addEventListener('click', () => { if (K) K.open(rel ? rootPath + '\\' + rel.replace(/\//g, '\\') : rootPath); });
    acts.appendChild(openBtn);
    const upBtn = el('button', 'file-refresh', '⬆');
    upBtn.title = '返回上级';
    upBtn.addEventListener('click', () => { const i = rel.lastIndexOf('/'); load(i > 0 ? rel.slice(0, i) : ''); });
    acts.appendChild(upBtn);
    head.appendChild(acts);
  }
  const list = el('div', 'file-list');
  body.appendChild(list);
  let rootPath = '';

  const fmtSize = (n) => {
    if (n == null) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  };
  const fmtTime = (t) => {
    if (!t) return '—';
    const d = new Date(t * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  };
  const icon = (name, isDir) => {
    if (isDir) return '📁';
    const n = String(name).toLowerCase();
    if (/\.blend\d?$/.test(n)) return '🟠';
    if (/\.(png|jpe?g|webp|exr|hdr)$/.test(n)) return '🖼️';
    if (/\.(mp4|mov|avi|mkv)$/.test(n)) return '🎬';
    if (/\.(obj|fbx|glb|gltf|stl|ply|abc|usd)$/.test(n)) return '🧊';
    if (/\.py$/.test(n)) return '🐍';
    if (/\.(zip|7z|rar)$/.test(n)) return '🗜️';
    return '📄';
  };

  async function load(nextRel) {
    if (disposed || !K) return;
    rel = nextRel || '';
    crumbs.textContent = rel ? rel.replace(/\//g, ' \\ ') : '加载中…';
    list.innerHTML = '';
    list.appendChild(el('div', 'file-empty', '加载中…'));
    let res = null;
    try { res = await K.files(rel); } catch (e) { res = null; }
    if (disposed) return;
    list.innerHTML = '';
    if (!res || !res.ok) {
      list.appendChild(el('div', 'file-empty', '无法读取：' + ((res && res.err) || '未知错误')));
      return;
    }
    rootPath = res.root || rootPath;
    crumbs.textContent = res.rel ? res.rel.replace(/\//g, ' \\ ') : 'Blender 工作区';
    crumbs.title = res.root + (res.rel ? '\\' + res.rel.replace(/\//g, '\\') : '');
    if (!res.rows.length) { list.appendChild(el('div', 'file-empty', '（空目录）')); return; }
    res.rows.forEach((it) => {
      const row = el('div', 'file-row' + (it.isDir ? ' dir' : ''));
      row.appendChild(el('span', 'bl-file-ico', icon(it.name, it.isDir)));
      row.appendChild(el('span', 'file-name', it.name));
      row.appendChild(el('span', 'file-meta', it.isDir ? '目录' : fmtSize(it.size) + ' · ' + fmtTime(it.mtime)));
      // 右键：在资源管理器里定位
      row.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        if (K) K.reveal(rel ? rel + '/' + it.name : it.name);
      });
      row.addEventListener('click', () => {
        if (it.isDir) load(rel ? rel + '/' + it.name : it.name);
        else if (K) K.open(rootPath + '\\' + (rel ? rel.replace(/\//g, '\\') + '\\' : '') + it.name);
      });
      list.appendChild(row);
    });
  }
  load('');
  const timer = setInterval(() => { if (!disposed) load(rel); }, 20000);
  return () => { disposed = true; clearInterval(timer); };
};

/* ══════════════════════════════════════════════════════════════════
   OA 运维场景 · 文件面板（type = "file"）
   meta.mode = 'local' → 只显本地；'cloud' → 只显云端；缺省 → 左右双栏
   每个面板自带【工具条 + 列表】，互不串线
   ══════════════════════════════════════════════════════════════════ */
renderers['file'] = (body, meta, head) => {
  var K = (window.app && window.app.oa) || {};   /* ★ 只用 oa 命名空间（场景隔离要求） */
  var ONLY = (meta && meta.mode) || '';
  var disposed = false;
  // ★ 根目录可由场景 json 指定：面板写 "root": "<盘根>\\" 就是 E 盘根（「视频工作流」场景的素材管理）；
  //   不写 = <客户> OA 工程目录（老场景原样不变）。真正的 LOCAL_ROOT 在下面 normWin 之后算（要用到它）。
  // ★ 归一化 + 当前目录显示（绿色路径标签跟着窗口走；路径太长就压中间、保留首尾）
  var normWin = function (p) { return String(p || '').replace(/[\\/]+/g, '\\').replace(/\\+$/, ''); };
  var shortPath = function (full, root, maxTail) {
    var f = normWin(full), r = normWin(root);
    var tail = f;
    if (r.length && f.toLowerCase().indexOf(r.toLowerCase()) === 0) {
      tail = f.slice(r.length).replace(/^\\+/, '');
    }
    if (!tail) return '';   /* 空 = 就是项目根（或根之外，由调用方另行处理） */
    var mt = maxTail || 28;
    if (tail.length <= mt) return tail;
    /* ★ 压中间：按"从尾部往前数"切，避免把中文/宽字符切出半截造成乱码感 */
    return '…\\' + tail.slice(tail.length - (mt - 1));
  };
  var IMG_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;
  var VID_RE = /\.(mp4|mov|mkv|webm|m4v|avi|flv|wmv|mpe?g|ts)$/i;
  // ★ 根目录（面板级配置）：默认<客户> OA 工程目录，场景 json 里 "root" 可换根
  var DISP_ROOT = String((meta && meta.root) || '<盘根>\\工作\\工程文件\\<客户>教育oa');
  var LOCAL_ROOT = normWin(DISP_ROOT) || DISP_ROOT;
  // ★ 2026-10-20（宿主：「文件管理默认 C/D/E/F 盘」）—— 场景 json 写 "drives": ["C","D","E","F"]（或 true）
  //   ⇒ 面板一开始停在「此电脑」：列这几个盘（带可用/总量，读 app.sys.disks 零子进程），双击进盘；
  //     进盘后「↑ 上级」先回盘根、再回「此电脑」。
  //   ⛔ 不写 drives 的场景（<客户> OA / 视频工作流 / 设计杂活）行为一个字不变。
  var DRIVES = (function () {
    var d = meta && meta.drives;
    if (!d) return null;
    var arr = (d === true) ? ['C', 'D', 'E', 'F'] : (Array.isArray(d) ? d : null);
    if (!arr) return null;
    var out = arr.map(function (x) {
      var m = /^([A-Za-z])/.exec(String(x || '').trim());
      return m ? m[1].toUpperCase() : '';
    }).filter(function (x) { return !!x; });
    return out.length ? out : null;
  })();
  // 从任意路径取"它所在的盘根"（<盘根>:\）；取不到返回 ''
  var driveRootOf = function (p) {
    var m = /^([A-Za-z]):[\\/]/.exec(String(p || ''));
    return m ? m[1].toUpperCase() + ':\\' : '';
  };
  var isImg = function (n) { return IMG_RE.test(String(n || '')); };
  var isVid = function (n) { return VID_RE.test(String(n || '')); };
  // ★ 本地媒体直接交给浏览器解码（file:// 子资源实测可用）：不经过 IPC 传 base64，
  //   大图 / 视频也能秒开（原来的 IPC 读图有 12MB 上限，E 盘素材动辄几十 MB）。
  //   路径按段 encodeURIComponent，中文、空格、# 都不会出问题。
  // ⚠ 别再用 encodeURIComponent 逐段编码（老 bug，2026-09-26 修）：那会把盘符的冒号也编成 %3A
  //   ⇒ file:///E%3A/… 这种地址浏览器认不出盘符，本地缩略图/大图一律"破图"。
  //   encodeURI 会保留 : 和 /，只编码中文/空格等；文件名里可能出现的 # ? 单独转义（跟 flow 渲染器那份写法一致）。
  var fileUrl = function (p) {
    var s = String(p || '').replace(/\\/g, '/').replace(/^\/+/, '');
    return 'file:///' + encodeURI(s).replace(/#/g, '%23').replace(/\?/g, '%3F');
  };
  // 显示 / 复制用的好看路径：盘根补一个反斜杠（E: → <盘根>\）
  var nicePath = function (p) { var s = normWin(p); return /^[A-Za-z]:$/.test(s) ? s + '\\' : s; };
  // ★ 单击文件 ⇒ 送到本场景的「预览」面板（2026-09-26 加，「设计杂活」场景要求"单击就能预览"）。
  //   预览面板（renderers.view）把自己的 API 注册在 window.__kunViews[面板id]，
  //   面板都在同一个文档里 ⇒ 直接调函数即可，**不需要任何新 IPC**（跟流程画布双击节点同一条路）。
  //   场景 json 里给本面板写 "viewPanel": "<预览面板id>" 指定送给谁；没写 = 送第一个注册的预览面板；
  //   场景里根本没有预览面板 ⇒ 静默跳过，单击仍然只是"选中"（跟以前一样，不会报错）。
  var previewTo = function (full, title) {
    try {
      var VP = (typeof flowFindView === 'function') ? flowFindView(meta && meta.viewPanel) : null;
      if (VP && typeof VP.show === 'function') { VP.show({ path: full, title: String(title || '') }); return true; }
    } catch (e) { /* 预览面板不在（或它自己出错）= 什么都不做 */ }
    return false;
  };

  var mk = function (tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  };
  // ★ 标题栏里的按钮：阻断 mousedown/mouseup（否则会被面板拖拽把手吃掉，点了没反应）
  //   ★2026-10-13★ 实现提到公共工具 APP_RENDER_UTILS.wireHeadNoDrag（一处实现，预览面板共用）
  var wireHeadBtn = function (node) {
    var U = window.APP_RENDER_UTILS;
    return (U && U.wireHeadNoDrag) ? U.wireHeadNoDrag(node) : node;
  };
  var fmtSize = function (n) {
    if (n == null || n === 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  };
  var fmtTime = function (t) {
    if (!t) return '';
    var d = new Date(t * 1000), p = function (x) { return String(x).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  };
  var showTip = function (txt, ms) {
    if (!tip) return;
    tip.textContent = txt || '';
    tip.style.display = txt ? '' : 'none';
    if (ms && txt) setTimeout(function () { if (!disposed && tip.textContent === txt) { tip.textContent = ''; tip.style.display = 'none'; } }, ms);
  };

  body.classList.add('oa-file');
  var tip = mk('div', 'oa-file-tip', '');
  tip.style.display = 'none';
  var wrap = mk('div', 'oa-file-wrap');
  body.appendChild(tip);
  body.appendChild(wrap);

  // 图片大图浮层（fallbackFull：file:// 加载失败时退回 IPC 读图，双保险）
  function bigImage(src, title, fallbackFull) {
    var ov = mk('div', 'oa-img-overlay');
    var bar = mk('div', 'oa-img-bar');
    var close = mk('span', 'oa-img-x', '关闭 ✕');
    close.addEventListener('click', function () { ov.remove(); });
    bar.appendChild(mk('span', null, title));
    bar.appendChild(close);
    var im = document.createElement('img');
    im.src = src; im.className = 'oa-img-big';
    if (fallbackFull) {
      var tried = false;
      im.addEventListener('error', function () {
        if (tried || disposed || !K.image) return;
        tried = true;
        Promise.resolve(K.image(fallbackFull)).then(function (res) {
          if (disposed) return;
          if (res && res.ok) im.src = res.dataUrl;
          else showTip('图片读取失败：' + ((res && res.err) || ''), 5000);
        }).catch(function () {});
      });
    }
    im.addEventListener('click', function (ev) { if (ev.target === im) ov.remove(); });
    ov.appendChild(bar); ov.appendChild(im);
    body.appendChild(ov);
  }

  // 视频播放浮层：面板里直接播（素材挑片不用来回切播放器），也能一键丢给系统播放器
  function bigVideo(src, title, fullPath) {
    var ov = mk('div', 'oa-img-overlay');
    var bar = mk('div', 'oa-img-bar');
    var play = mk('span', 'oa-img-btn', '用系统播放器打开');
    play.title = nicePath(fullPath);
    play.addEventListener('click', function (e) {
      e.stopPropagation();
      try { if (K.openPath) K.openPath(nicePath(fullPath)); } catch (err) {}
    });
    var close = mk('span', 'oa-img-x', '关闭 ✕');
    close.addEventListener('click', function () {
      var v = ov.querySelector('video');
      try { if (v) v.pause(); } catch (e2) {}
      ov.remove();
    });
    bar.appendChild(mk('span', null, title));
    bar.appendChild(play);
    bar.appendChild(close);
    var vd = document.createElement('video');
    vd.src = src; vd.className = 'oa-img-big';
    vd.controls = true; vd.autoplay = true; vd.playsInline = true;
    ov.appendChild(bar); ov.appendChild(vd);
    body.appendChild(ov);
  }

  // 单个面板（本地或云端），互相独立
  function makePane(side) {
    var isLocal = (side === 'local');
    var pane = mk('div', 'oa-file-pane oa-file-' + side);
    var bar = mk('div', 'oa-file-pane-hd');
    bar.style.display = 'none';   // 工具条已移到面板标题栏，内容区只留列表
    var list = mk('div', 'file-list oa-file-list');
    pane.appendChild(bar); pane.appendChild(list);
    wrap.appendChild(pane);
    var state = { root: '', atDrives: false };   // atDrives：drives 模式下停在「此电脑」盘符列表

    // —— 工具条内容 ——
    if (isLocal) {
      var pathTag = mk('span', 'oa-file-rootpath', DISP_ROOT);
      // ★ 这个后添加的 span 承载"当前目录那段"；整条标签文字 = 根目录 + 它
      //   （进了子目录 → 它是 '\backend\src'；跳出根目录 → 它直接覆盖成完整路径）
      var pathTagExt = mk('span', 'oa-file-rootpath-ext', '');
      pathTag.appendChild(pathTagExt);
      pathTag.title = '点击复制当前文件夹路径：' + DISP_ROOT;
      // 当前文件夹的绝对路径（本地栏未就绪时就是根目录）
      var curDir = function () { return normWin(state.root) || LOCAL_ROOT; };
      pathTag.addEventListener('click', function (e) {
        e.stopPropagation();
        if (state.atDrives) { showTip('现在停在「此电脑」（C / D / E / F），双击进入一个盘再复制路径', 2600); return; }
        var full = nicePath(curDir());
        try { navigator.clipboard.writeText(full); } catch (err) {}
        showTip('✓ 已复制当前路径：' + full, 2200);
        pathTag.classList.add('copied-flash');
        setTimeout(function () { pathTag.classList.remove('copied-flash'); }, 420);
      });
      var sub = mk('span', 'oa-file-subpath', '');
      var barHost = head || bar;            // ★ 挂到面板标题栏
      barHost.appendChild(wireHeadBtn(pathTag));
      // 2026-10-20（宿主：这条路径已经有一份了，重复）—— 绿色路径标签里已经带当前子目录（pathTagExt），
      //   再挂一条 "\项目工程\产物、素材…" 就是同一份路径写两遍 ⇒ 不挂。sub 仍保留给内部判断用。
      // barHost.appendChild(sub);
      var openBtn = mk('span', 'oa-file-headbtn', '打开');
      openBtn.title = '用资源管理器打开当前文件夹';
      openBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (state.atDrives) { showTip('先双击进入一个盘（这里没有"整台电脑"的文件夹）', 2600); return; }
        try { if (K.openFolder) K.openFolder(nicePath(curDir())); } catch (err) {}
      });
      var upBtn = mk('span', 'oa-file-headbtn', '↑ 上级');
      upBtn.title = '回到上级目录（不会超过场景根目录）';
      upBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (state.atDrives) return;
        var cur = String(state.root || '').replace(/[\\/]+$/, '');
        var nr = function (x) { return String(x || '').replace(/[\\/]+/g, '\\').toLowerCase(); };
        // ★ drives 模式：盘根 ⇒ 回「此电脑」（不然会一路退到盘外，显示成怪路径）
        if (DRIVES && /^[A-Za-z]:$/.test(cur)) { showDrives(); return; }
        if (!cur || nr(cur) === nr(LOCAL_ROOT)) return;
        var i = Math.max(cur.lastIndexOf('\\'), cur.lastIndexOf('/'));
        if (i <= 0) return;
        var nx = cur.slice(0, i);
        if (nr(nx).indexOf(nr(LOCAL_ROOT)) !== 0) {
          if (DRIVES) { showDrives(); return; }        // drives 模式的根 = 盘根，不越界
          nx = DISP_ROOT;
        }
        if (/^[A-Za-z]:$/.test(nx)) nx += '\\';   // 盘根要写成 "<盘根>\"（"E:" 是盘符当前目录的相对形式）
        load(nx);
      });
      barHost.appendChild(wireHeadBtn(openBtn));
      barHost.appendChild(wireHeadBtn(upBtn));
    } else {
      var TAGS = [['代码', '/opt/langchen_oa'], ['数据库', '/root/backup'],
                  ['备份', '/opt/langchen_oa_backups'], ['日志', '/var/log/nginx']];
      var barHost2 = head || bar;           // ★ 挂到面板标题栏
      TAGS.forEach(function (tg) {
        var b = mk('span', 'oa-file-root', tg[0]);
        b.title = '跳转：' + tg[1];
        b.addEventListener('click', function (e) { e.stopPropagation(); load(tg[1]); });
        barHost2.appendChild(wireHeadBtn(b));
      });
      var cpath = mk('span', 'oa-file-headpath', '');
      barHost2.appendChild(cpath);
      state.cpath = cpath;
    }

    function rows(list2, onOpen, onEnter) {
      list.innerHTML = '';
      if (!list2 || !list2.length) { list.appendChild(mk('div', 'oa-file-empty', '（空目录）')); return; }

      // ★ 素材预览：图片 + 视频，一排两个（缩略图网格）
      //   本地：直接 file:// 出图 / 出首帧（大素材、几十 MB 的贴图也不卡；失败自动退回 IPC 读图）
      //   云端：图片仍走 IPC 读图（SSH 取回 base64）；视频不能直出，照旧当普通文件列在下边
      var med = (list2 || []).filter(function (x) { return !x.isDir && (isImg(x.name) || isVid(x.name)); });
      var medShow = isLocal ? med : med.filter(function (x) { return isImg(x.name); });
      var medGrid = medShow.slice(0, 60);                       // 预览上限 60 张，多出来的仍按文件列在下面
      var rest = (list2 || []).filter(function (x) { return x.isDir || medShow.indexOf(x) < 0; })
                              .concat(medShow.slice(60));
      if (medGrid.length) {
        var grid = mk('div', 'oa-thumb-grid');
        medGrid.forEach(function (it) {
          var full = isLocal ? (state.root || '').replace(/[\\/]+$/, '') + '\\' + it.name
                             : (state.root || '').replace(/\/+$/, '') + '/' + it.name;
          var isVideo = isVid(it.name);
          var card = mk('div', 'oa-thumb');
          var box = mk('div', 'oa-thumb-box');
          var ph = mk('div', 'oa-thumb-ph', isVideo ? '🎬' : '🖼');
          box.appendChild(ph);
          var cap = mk('div', 'oa-thumb-cap');
          cap.appendChild(mk('div', 'oa-thumb-name', it.name));
          var sizeTxt = mk('div', 'oa-thumb-size', (isVideo ? '🎬 ' : '🖼 ') + fmtSize(it.size));
          cap.appendChild(sizeTxt);
          card.appendChild(box); card.appendChild(cap);
          card.title = it.name + (isVideo ? '\n双击在面板里播放' : '\n双击看大图');
          // 懒加载缩略图 / 首帧（只给看得见的卡片取）
          var load1 = function () {
            if (disposed) return;
            if (isVideo) {
              if (!isLocal) return;                       // 云端视频不预览
              var vd = document.createElement('video');
              vd.className = 'oa-thumb-img'; vd.src = fileUrl(full);
              vd.preload = 'metadata'; vd.muted = true; vd.playsInline = true;
              vd.addEventListener('loadedmetadata', function () {
                if (disposed) return;
                // 抓一小段当封面（黑帧起头的素材也能看到画面）
                try { vd.currentTime = Math.min(0.3, (vd.duration || 0) / 2); } catch (e) {}
                var d = vd.duration || 0;
                if (d) {
                  sizeTxt.textContent = '🎬 ' + Math.floor(d / 60) + ':' +
                    String(Math.floor(d % 60)).padStart(2, '0') + ' · ' + fmtSize(it.size);
                }
              });
              vd.addEventListener('error', function () {
                box.innerHTML = ''; box.appendChild(mk('div', 'oa-thumb-ph', '🎬'));
              });
              box.innerHTML = ''; box.appendChild(vd);
              box.appendChild(mk('div', 'oa-thumb-play', '▶'));
            } else if (isLocal) {
              var im = document.createElement('img');
              im.className = 'oa-thumb-img'; im.loading = 'lazy'; im.src = fileUrl(full);
              im.addEventListener('error', function () {     // file:// 万一被拦 → 退回 IPC 读图
                if (disposed || !K.image) { box.innerHTML = ''; box.appendChild(mk('div', 'oa-thumb-ph', '⚠')); return; }
                Promise.resolve(K.image(full)).then(function (res) {
                  if (disposed) return;
                  if (res && res.ok) im.src = res.dataUrl;
                  else { box.innerHTML = ''; box.appendChild(mk('div', 'oa-thumb-ph', '⚠')); }
                }).catch(function () { box.innerHTML = ''; box.appendChild(mk('div', 'oa-thumb-ph', '⚠')); });
              });
              box.innerHTML = ''; box.appendChild(im);
            } else if (K.image) {
              Promise.resolve(K.image(full)).then(function (res) {
                if (disposed) return;
                if (res && res.ok) {
                  var im2 = document.createElement('img');
                  im2.src = res.dataUrl; im2.className = 'oa-thumb-img'; im2.loading = 'lazy';
                  box.innerHTML = ''; box.appendChild(im2);
                } else box.replaceChild(mk('div', 'oa-thumb-ph', '⚠'), ph);
              }).catch(function () {});
            }
          };
          if (window.IntersectionObserver) {
            var io2 = new IntersectionObserver(function (ents) {
              ents.forEach(function (en) { if (en.isIntersecting) { io2.disconnect(); load1(); } });
            });
            io2.observe(card);
          } else load1();
          card.addEventListener('click', function () {
            Array.prototype.forEach.call(list.querySelectorAll('.oa-thumb.sel'), function (r) { r.classList.remove('sel'); });
            card.classList.add('sel');
            if (isLocal) previewTo(full, it.name);          // ★ 单击缩略图 ⇒ 预览面板里摊开（图片/视频）
          });
          card.addEventListener('dblclick', function () {
            if (isVideo) {
              if (isLocal) bigVideo(fileUrl(full), it.name, full);   // 面板里直接播
              else onOpen(it);                                       // 云端：照旧下载 / 打开
              return;
            }
            if (isLocal) { bigImage(fileUrl(full), it.name, full); return; }
            if (K.image) {
              Promise.resolve(K.image(full)).then(function (res) {
                if (disposed) return;
                if (res && res.ok) bigImage(res.dataUrl, it.name);
                else showTip('图片读取失败：' + ((res && res.err) || ''), 5000);
              }).catch(function () {});
            }
          });
          grid.appendChild(card);
        });
        list.appendChild(grid);
      }
      if (!rest.length && medGrid.length) return;

      rest.forEach(function (it) {
        var row = mk('div', 'file-row oa-file-row');
        row.appendChild(mk('span', 'oa-file-ic', it.isDir ? '📁' : '📄'));
        row.appendChild(mk('span', 'oa-file-name', it.name));
        row.appendChild(mk('span', 'oa-file-size', it.isDir ? '' : fmtSize(it.size)));
        row.appendChild(mk('span', 'oa-file-time', fmtTime(it.mtime)));
        // ★2026-10-13★ 用户要求：**双击不再拿系统程序打开** —— 预览面板那排已经有「🖥 系统打开」，
        //   所以本地盘只提示"双击仍在预览里看"；云端（<客户> OA 没有预览面板）还是老话术。
        row.title = it.name + (it.isDir ? '\n双击进入'
          : (isLocal ? '\n双击仍在预览面板里看（要外部程序：用预览面板那排的 🖥）' : '\n双击打开 / 可拖到别的窗口'));
        if (!it.isDir && isLocal) {
          row.draggable = true;
          row.addEventListener('dragstart', function (ev) {
            // ★★ 必须先 preventDefault 再调主进程 startDrag ★★
            // 少了这一行，浏览器原生拖拽会和 Electron 的 webContents.startDrag 同时启动，
            // 原生层冲突会直接把整个工作台干掉（无堆栈、无日志，表现为"一拖就闪退"）。
            // 参照 site-folder 面板的正确写法。
            try { ev.preventDefault(); } catch (e) {}
            try { if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'copyMove'; } catch (e) {}
            var full = (state.root || '').replace(/[\\/]+$/, '') + '\\' + it.name;
            try {
              if (K && typeof K.dragStart === 'function') K.dragStart(full);
              else showTip('拖拽需重启一次工作台后生效', 4000);
            } catch (err) {}
          });
          row.addEventListener('dragend', function () { setTimeout(function () { try { window.focus(); } catch (e) {} }, 30); });
        }
        row.addEventListener('click', function () {
          Array.prototype.forEach.call(list.querySelectorAll('.oa-file-row.sel'), function (r) { r.classList.remove('sel'); });
          row.classList.add('sel');
          // ★ 单击文件（目录不算）⇒ 送到预览面板：图片 / 视频 / 各种文档 / PDF 都能看
          if (!it.isDir && isLocal) {
            previewTo((state.root || '').replace(/[\\/]+$/, '') + '\\' + it.name, it.name);
          }
        });
        row.addEventListener('dblclick', function () {
          if (it.isDir) { onEnter(it); return; }
          if (IMG_RE.test(it.name) && K.image) {
            var full = isLocal ? (state.root || '').replace(/[\\/]+$/, '') + '\\' + it.name
                               : (state.root || '').replace(/\/+$/, '') + '/' + it.name;
            if (isLocal) {
              bigImage(fileUrl(full), it.name, full);          // 本地直出（失败自动退回 IPC 读图）
            } else {
              var tmp = '<盘根>\\deepseek\\_oa_tmp_img';
              Promise.resolve(K.download ? K.download(full, tmp) : null).then(function (dd) {
                if (dd && dd.ok && K.image) {
                  Promise.resolve(K.image(dd.local)).then(function (res) {
                    if (res && res.ok) bigImage(res.dataUrl, it.name + '（云端已缓存本地）'); else showTip('图片读取失败', 5000);
                  });
                } else showTip('云端图片下载失败：' + ((dd && dd.err) || ''), 5000);
              });
            }
            return;
          }
          // ★2026-10-13★ 双击**不许再拉起系统程序**（用户原话：不需要双击用系统打开了，因为预览面板有系统打开了）：
          //   本地盘上单击已经把文件递到预览面板（见上面的 click）⇒ 双击只是"再确认一次预览"，什么都不做；
          //   场景里没有预览面板、或不是本地盘（<客户> OA 只有 file 面板）⇒ previewTo 返回 false，照旧 onOpen。
          if (isLocal && previewTo((state.root || '').replace(/[\\/]+$/, '') + '\\' + it.name, it.name)) return;
          onOpen(it);
        });
        list.appendChild(row);
      });
    }

    // ★ drives 模式：「此电脑」盘符列表（C / D / E / F）—— 只有场景 json 配了 drives 时才会走到这儿
    function setRootLabel(txt) {
      try {
        if (pathTag.childNodes && pathTag.childNodes.length && pathTag.childNodes[0].nodeType === 3) {
          pathTag.childNodes[0].nodeValue = String(txt);
        } else {
          pathTag.insertBefore(document.createTextNode(String(txt)), pathTag.firstChild || null);
        }
      } catch (e) { /* ignore */ }
    }
    function showDrives() {
      if (!DRIVES) return;
      state.atDrives = true; state.root = '';
      setRootLabel('此电脑');
      pathTagExt.textContent = ''; pathTagExt.style.display = 'none';
      pathTag.classList.remove('deep'); pathTag.style.maxWidth = '';
      pathTag.title = 'C / D / E / F 盘（双击进入某个盘）';
      pathTagExt.title = pathTag.title;
      if (sub) sub.textContent = '';
      var items = DRIVES.map(function (L) { return { name: L + ':', isDir: true, __drive: L }; });
      rows(items, function () { /* 盘符不是文件，单击只选中 */ }, function (it) { load(it.__drive + ':\\'); });
      // 容量：主进程 statfs 只读数字（零子进程）⇒ 异步补到每行右边
      try {
        var S = window.app && window.app.sys;
        if (S && S.disks) Promise.resolve(S.disks()).then(function (r) {
          if (disposed || !state.atDrives || !r || !Array.isArray(r.drives)) return;
          var map = {};
          r.drives.forEach(function (d) { map[String(d.drive || '').toUpperCase()] = d; });
          var gbOf = function (n) {
            if (!n) return '0';
            return (n >= 1073741824) ? (Math.round(n / 1073741824) + ' GB') : (Math.round(n / 1048576) + ' MB');
          };
          Array.prototype.forEach.call(list.querySelectorAll('.oa-file-row'), function (rowEl) {
            var nm = rowEl.querySelector('.oa-file-name');
            var sz = rowEl.querySelector('.oa-file-size');
            if (!nm || !sz) return;
            var d = map[String(nm.textContent || '').toUpperCase()];
            if (!d) return;
            if (d.ok) {
              var tm = rowEl.querySelector('.oa-file-time');
              var tip = '已用 ' + d.percent + '% · 可用 ' + gbOf(d.free) + ' / 总量 ' + gbOf(d.total);
              // 62px 的"大小"格装不下两句 ⇒ 只留「可用」，总量塞进 96px 的"时间"格（都 nowrap，别三行折行）
              sz.textContent = gbOf(d.free) + ' 可用';
              sz.style.whiteSpace = 'nowrap'; sz.title = tip;
              if (tm) { tm.textContent = '共 ' + gbOf(d.total); tm.style.whiteSpace = 'nowrap'; tm.title = tip; }
            } else { sz.textContent = '不可用'; sz.style.whiteSpace = 'nowrap'; sz.title = String(d.err || ''); }
          });
        }).catch(function () { /* 读不到容量不影响浏览 */ });
      } catch (e) { /* ignore */ }
    }

    function load(p) {
      if (isLocal) {
        // ★ drives 模式：p 空 / '::drives' ⇒ 停在「此电脑」；进盘 ⇒ 把"根"换成该盘盘根（↑ 上级到盘根再回此电脑）
        if (DRIVES && (!p || p === '::drives')) { showDrives(); return; }
        if (DRIVES) { var drPre = driveRootOf(p); if (drPre) LOCAL_ROOT = drPre; }
        Promise.resolve(K.filesLocal ? K.filesLocal(p) : null).then(function (r) {
          if (disposed) return;
          if (!r || r.ok === false) { list.innerHTML = ''; list.appendChild(mk('div', 'oa-file-empty', '无法读取：' + ((r && r.err) || ''))); return; }
          state.root = r.base || p || '';
          state.atDrives = false;
          if (DRIVES) { var drNow = driveRootOf(state.root); if (drNow) { LOCAL_ROOT = drNow; setRootLabel(drNow.slice(0, 2)); } }
          // ★ 绿色路径标签 = 当前文件夹（相对项目根显示；太长压中间）+ 子路径小字保留完整相对路径
          var ROOTN = normWin(LOCAL_ROOT);
          var curFull = normWin(state.root) || LOCAL_ROOT;
          var inRoot = (curFull.toLowerCase() === ROOTN.toLowerCase())
                    || (curFull.toLowerCase().indexOf(ROOTN.toLowerCase() + '\\') === 0);
          if (inRoot && curFull.length > ROOTN.length) {
            pathTagExt.textContent = '\\' + shortPath(curFull, LOCAL_ROOT, 30);
            pathTagExt.style.display = '';
            pathTag.style.maxWidth = '76%';
            pathTag.classList.add('deep');
            pathTag.title = '当前文件夹：' + curFull + '\n点击复制这个路径';
            pathTagExt.title = pathTag.title;
            if (sub) sub.textContent = '\\ ' + curFull.slice(ROOTN.length).replace(/^[\\/]+/, '');
          } else if (inRoot) {
            pathTagExt.textContent = '';
            pathTagExt.style.display = 'none';
            pathTag.style.maxWidth = '';
            pathTag.classList.remove('deep');
            pathTag.title = (DRIVES ? '当前盘根：' + curFull : '场景根目录：' + DISP_ROOT) + '\n点击复制';
            if (sub) sub.textContent = '';
          } else {
            /* 跑到项目根之外（本地栏理论上进不去，兜底别显示错路径） */
            pathTagExt.textContent = curFull;      /* 直接覆盖整条标签文字 */
            pathTagExt.style.display = '';
            pathTag.style.maxWidth = '76%';
            pathTag.classList.remove('deep');
            pathTag.title = '当前文件夹（不在项目根内）：' + curFull + '\n点击复制这个路径';
            pathTagExt.title = pathTag.title;
            if (sub) sub.textContent = '';
          }
          // ★ 藏掉 macOS / Windows 的元数据垃圾（2026-09-26 用户实测踩到）：
          //   `._xxx.png` = AppleDouble（**正好 4096B、名字像图其实不是图**，点了预览必然"破图"，害人误判成面板坏了）；
          //   `.DS_Store` / `Thumbs.db` / `desktop.ini` 同理。别的点开头的文件（.env / .gitignore）照样显示。
          var JUNK_META = /^(\._|\.DS_Store$|Thumbs\.db$|desktop\.ini$)/i;
          var rsLocal = (r.rows || []).filter(function (it) { return !JUNK_META.test(it.name); });
          rows(rsLocal, function (it) {
            var full = state.root.replace(/[\\/]+$/, '') + '\\' + it.name;
            try { if (K.openPath) K.openPath(full); } catch (err) {}
          }, function (it) { load(state.root.replace(/[\\/]+$/, '') + '\\' + it.name); });
        }).catch(function (e) { showTip('读取异常：' + e.message, 5000); });
      } else {
        Promise.resolve(K.files ? K.files(p) : null).then(function (r) {
          if (disposed) return;
          if (!r || r.ok === false) { list.innerHTML = ''; list.appendChild(mk('div', 'oa-file-empty', '无法读取：' + ((r && r.err) || ''))); return; }
          state.root = r.base || p || '';
          if (state.cpath) state.cpath.textContent = state.root + (r.real ? '' : '（缓存）');
          var rs = (r.rows || []).slice();
          var parts = String(state.root).replace(/\/+$/, '').split('/').filter(Boolean);
          if (parts.length) rs = [{ name: '..', isDir: true, size: 0, mtime: 0, __up: true }].concat(rs);
          rows(rs, function (it) {
            var full = state.root.replace(/\/+$/, '') + '/' + it.name;
            var isText = /\.(txt|log|json|md|js|css|html|vue|sh|conf|yml|yaml|sql|env)$/i.test(it.name);
            if (isText && K.code && K.code.read) {
              Promise.resolve(K.code.read(full)).then(function (c) {
                var txt = (c && (c.content || c.text)) || (typeof c === 'string' ? c : '');
                if (!txt) { showTip('无法预览：' + full, 5000); return; }
                var box = mk('div', 'oa-file-preview');
                var b2 = mk('div', 'oa-file-preview-hd');
                var cl = mk('span', 'oa-file-preview-x', '关闭 ✕');
                cl.addEventListener('click', function () { box.remove(); });
                b2.appendChild(mk('span', null, full)); b2.appendChild(cl);
                box.appendChild(b2); box.appendChild(mk('pre', null, String(txt).slice(0, 20000)));
                pane.appendChild(box);
              });
            } else if (K.download) {
              var dir = '<盘根>\\工作\\工程文件\\<客户>教育oa\\备份';
              showTip('下载中：' + full);
              Promise.resolve(K.download(full, dir)).then(function (res) {
                if (res && res.ok) { showTip('✓ 已下载：' + res.local, 4000); try { if (K.openPath) K.openPath(res.local); } catch (err) {} }
                else showTip('✗ 下载失败：' + ((res && res.err) || ''), 6000);
              });
            } else showTip('无法处理：' + full, 4000);
          }, function (it) {
            if (it.__up) {
              var cp = String(state.root).replace(/\/+$/, '');
              var j = cp.lastIndexOf('/');
              load(j > 0 ? cp.slice(0, j) : '/');
              return;
            }
            load(state.root.replace(/\/+$/, '') + '/' + it.name);
          });
        }).catch(function (e) { showTip('读取异常：' + e.message, 5000); });
      }
    }
    return { side: side, load: load };
  }

  var panes = [];
  if (ONLY !== 'cloud') panes.push(makePane('local'));
  if (ONLY !== 'local') panes.push(makePane('cloud'));
  // （原先这里误建了一个本地栏且未隐藏，导致云端面板出现两个窗口 —— 已删除）

  // 初始化
  setTimeout(function () {
    if (disposed) return;
    panes.forEach(function (p) {
      if (p.side === 'local') p.load(DRIVES ? '::drives' : DISP_ROOT);   // ★ drives 模式先停在「此电脑」（C/D/E/F）
      else p.load('/opt/langchen_oa');
    });
  }, 10);

  // 2026-10-20（宿主：预览首页点文件夹 ⇒ 让这块文件管理跳过去）—— 对外挂一个极小的 API：
  //   预览面板（view）用 window.__kunFiles[面板id].open(路径) 调；同一个文档里，不需要新 IPC。
  //   ⚠ 面板重建（⟳）必须把旧的那份删掉，否则预览会调到已经 dispose 的旧闭包。
  try {
    var myId = String((meta && meta.id) || '');
    window.__kunFiles = window.__kunFiles || {};
    window.__kunFiles[myId] = {
      open: function (p) {
        if (disposed || !p) return false;
        var lp = panes.filter(function (x) { return x.side === 'local'; })[0];
        if (!lp) return false;
        lp.load(p); return true;
      }
    };
  } catch (e) { /* ignore */ }

  return function () {
    disposed = true;
    try {
      var id2 = String((meta && meta.id) || '');
      if (window.__kunFiles && window.__kunFiles[id2]) delete window.__kunFiles[id2];
    } catch (e) { /* ignore */ }
  };
};

// =====================================================================================
// 场景「自我复盘」（self-review）：右上角浏览 <DSH根>\自我复盘（md 镜像，只读）
//                                 左上角大窗「单击即预览」（渲染 md + 跟读目录内相对链接）
// -------------------------------------------------------------------------------------
// 为什么另写一对面板，不复用现成的 file / site-folder：
//   1) file 面板单击 = 交给系统程序打开，且只认图/视频；md 是纯文本，这里要的是"单击 = 在左窗渲染"；
//   2) site-folder 的路径夹死在 SITE_DIR，预览走静态服务器（md 会被当纯文本吐出来）→ 不满足"渲染 md"；
//   3) 本场景就这两个面板互相配合：桥接用一个挂在 window 上的小对象 __SR + 两个自定义事件即可，
//      不碰别的场景，也不改 HARNESS_PIN_JS / styles 里任何既有规则。
// 数据来源：主进程 app.review（根＝REVIEW_DIR，路径夹在该目录内，只读，无写接口）。
// =====================================================================================
var SR_LABEL = '<盘根>\\DSH\\自我复盘';
var SR_LAST_KEY = 'sr:self-review:last';   // 记住上次看的文档（按场景分区；切场景/重启后自动恢复）

// ---------- 小工具（都带 sr 前缀，避免和工作台里的同名函数打架）----------
function srEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
// 行内元素：`code` / **粗** / *斜* / ~~删~~ / [文字](链接)
function srInline(s) {
  var t = srEsc(s);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  t = t.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  return t;
}
// 迷你 Markdown → HTML：标题 / 粗斜删 / 行内码 / 围栏码 / 有序无序表 / 复选框 / 表格 / 引用 / 分割线 / 链接
// （够用即止：档案与知识库这几篇就是标题 + 列表 + 表格 + 引用，不为它引入第三方库）
function srMd(src) {
  var lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
  var html = [], i = 0, listOpen = false, para = [];
  function flushPara() {
    if (para.length) { html.push('<p>' + srInline(para.join(' ')) + '</p>'); para = []; }
  }
  function closeList() { if (listOpen) { html.push('</ul>'); listOpen = false; } }
  function cells(s) {
    return s.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(function (c) { return c.trim(); });
  }
  while (i < lines.length) {
    var ln = lines[i];
    // 围栏代码块
    if (/^\s*(```|~~~)/.test(ln)) {
      flushPara(); closeList();
      var body = [], j = i + 1;
      while (j < lines.length && !/^\s*(```|~~~)\s*$/.test(lines[j])) { body.push(lines[j]); j++; }
      html.push('<pre class="sr-code"><code>' + srEsc(body.join('\n')) + '</code></pre>');
      i = j + 1; continue;
    }
    // 表格：本行含 | 且下一行是 |---| 分隔行
    if (ln.indexOf('|') >= 0 && i + 1 < lines.length && /^\s*\|?[\s:|-]*-[\s:|-]*\|/.test(lines[i + 1])) {
      flushPara(); closeList();
      var head2 = cells(ln), trs = [], k = i + 2;
      while (k < lines.length && lines[k].trim() && lines[k].indexOf('|') >= 0) { trs.push(cells(lines[k])); k++; }
      html.push('<table class="sr-tb"><thead><tr>' + head2.map(function (c) { return '<th>' + srInline(c) + '</th>'; }).join('') +
        '</tr></thead><tbody>' + trs.map(function (r) {
          return '<tr>' + r.map(function (c) { return '<td>' + srInline(c) + '</td>'; }).join('') + '</tr>';
        }).join('') + '</tbody></table>');
      i = k; continue;
    }
    var h = ln.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flushPara(); closeList(); html.push('<' + 'h' + h[1].length + '>' + srInline(h[2]) + '</h' + h[1].length + '>'); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(ln)) { flushPara(); closeList(); html.push('<hr>'); i++; continue; }
    if (/^\s*>/.test(ln)) {
      flushPara(); closeList();
      var qb = [], m = i;
      while (m < lines.length && /^\s*>/.test(lines[m])) { qb.push(lines[m].replace(/^\s*>\s?/, '')); m++; }
      html.push('<blockquote>' + srMd(qb.join('\n')) + '</blockquote>');
      i = m; continue;
    }
    var li = ln.match(/^\s*[-*+]\s+(.*)$/);
    if (li) {
      flushPara();
      if (!listOpen) { html.push('<ul>'); listOpen = true; }
      var t = li[1], box = '', cb = t.match(/^\[( |x|X)\]\s+(.*)$/);
      if (cb) { box = '<span class="sr-cb">' + (cb[1].toLowerCase() === 'x' ? '☑' : '☐') + '</span> '; t = cb[2]; }
      html.push('<li>' + box + srInline(t) + '</li>');
      i++; continue;
    }
    var oli = ln.match(/^\s*\d+[.)]\s+(.*)$/);
    if (oli) {
      flushPara();
      if (!listOpen) { html.push('<ul class="sr-ol">'); listOpen = true; }
      html.push('<li>' + srInline(oli[1]) + '</li>');
      i++; continue;
    }
    if (!ln.trim()) { flushPara(); closeList(); i++; continue; }
    para.push(ln.trim()); i++;
  }
  flushPara(); closeList();
  return html.join('\n');
}
// 相对路径解析：支持 ./ 与 ../（文档里的相对链接、目录名都用它）
function srJoin(dir, p) {
  var s = String(p == null ? '' : p).replace(/\\/g, '/');
  try { s = decodeURIComponent(s); } catch (e) { /* 没转义就算了 */ }
  if (/^[a-zA-Z]:/.test(s)) return s.replace(/^[a-zA-Z]:[\\/]*/, '').replace(/\\/g, '/');   // 绝对路径 → 归一到"相对根"
  s = s.replace(/^\.\//, '');
  var parts = String(dir || '').split('/').filter(Boolean);
  s.split('/').forEach(function (seg) {
    if (!seg || seg === '.') return;
    if (seg === '..') parts.pop(); else parts.push(seg);
  });
  return parts.join('/');
}
function srParent(rel) {
  var p = String(rel || '').split('/').filter(Boolean);
  p.pop();
  return p.join('/');
}
function srSize(n) {
  var v = Number(n) || 0;
  if (v < 1024) return v + ' B';
  if (v < 1048576) return (v / 1024).toFixed(v < 10240 ? 1 : 0) + ' KB';
  return (v / 1048576).toFixed(1) + ' MB';
}
function srTime(t) {
  var n = Number(t) || 0;
  if (!n) return '';
  var d = new Date(n * 1000), p = function (x) { return (x < 10 ? '0' : '') + x; };
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
// 主进程里"用系统程序打开 / 在资源管理器里显示"的接口名按存在性探测，避免写错名字静默失效
function srOpenPath(p) {
  var k = window.app || {}, a = k.app || {}, o = k.oa || {};
  var fn = a.openPath || o.openPath;
  if (typeof fn !== 'function') return false;
  try { fn(p); return true; } catch (e) { return false; }
}
function srRevealPath(p) {
  var k = window.app || {}, a = k.app || {}, o = k.oa || {};
  var fn = a.revealPath || o.openFolder;
  if (typeof fn !== 'function') return false;
  try { fn(p); return true; } catch (e) { return false; }
}
function srCopy(text) {
  try {
    var ta = document.createElement('textarea');
    ta.value = String(text == null ? '' : text);
    ta.style.position = 'fixed'; ta.style.left = '-9999px'; ta.style.top = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    var ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) { return false; }
}
function srFull(rel) { return SR_LABEL + '\\' + String(rel || '').replace(/\//g, '\\'); }
// 复盘镜像的**绝对路径**：根目录就是 SR_LABEL 本身（不带结尾反斜杠），窗口二标题行 / ⧉ 都用它
function srAbs(rel) { return rel ? srFull(rel) : SR_LABEL; }
// 操作提示（「✓ 已复制…」）并进**标题行**（用户要求）：原来挂在内容区底部，空着时也占一排（21px），
// 看着就像一条很粗的下边框、正文永远碰不到下沿。拿不到标题行时才退回内容区。
function srTipIn(head, body, before) {
  var t = el('span', 'sr-tip sr-head-tip');
  if (head) { if (before && before.parentNode === head) head.insertBefore(t, before); else head.appendChild(t); }
  else body.appendChild(t);
  var timer = 0;
  return function (msg, ms) {
    t.textContent = msg || '';
    t.title = msg || '';
    if (timer) clearTimeout(timer);
    if (msg && ms) timer = setTimeout(function () { t.textContent = ''; t.title = ''; }, ms);
  };
}

// ---------- 左上「文档预览」的文件分流（★2026-10-11★ 用户要求：预览能力从"只能看 md"扩到"能预览的全部文件"）----------
// 判据只看**扩展名**，并且判在渲染层（不在主进程）：
//   ① 主进程的 review:read 对**任何**文件都会回 utf8 正文（它只是额外标了个 text 标志），
//      "该不该按文本读"必须在这儿先判断 —— 否则 PDF / 图片会被当文本读成一屏乱码；
//   ② 判在渲染层 = 不用动 main.js = 改完 ⟳ 就生效，不用重启 GUI。
// 四类去处：
//   md / text        → 左窗自己渲染（md 走 srMd；txt/json/js/csv/log… 按原文 <pre> 显示）
//   image/video/audio/pdf/html → **整块交给通用预览渲染器**（renderers.view）：
//                      滚轮缩放、播放条、内核 PDF 阅读器、HTML 内嵌渲染都在它那儿，本场景一行都不重复写
//   opaque（docx/xlsx/pptx/zip/psd…）→ 内核渲染不了 ⇒ 明确提示卡 + 「用系统默认程序打开」按钮（不白屏、不静默失败）
//   认不出扩展名的    → 先按文本读，正文里出现 NUL/大量坏字符再退回"打不开"卡片（无后缀、.sample 这类）
var SR_EXT_TEXT = ['md', 'markdown', 'mdx', 'txt', 'text', 'json', 'jsonl', 'jsonc', 'ndjson', 'csv', 'tsv', 'log',
  'ini', 'cfg', 'conf', 'env', 'yaml', 'yml', 'toml', 'xml', 'srt', 'ass', 'vtt',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'css', 'scss', 'less', 'sql', 'py', 'ps1', 'psm1', 'bat', 'cmd',
  'sh', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'lua', 'typ', 'sample'];
var SR_EXT_HTML = ['html', 'htm', 'xhtml'];
var SR_EXT_IMAGE = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif'];
var SR_EXT_VIDEO = ['mp4', 'webm', 'mov', 'mkv', 'm4v', 'avi'];
var SR_EXT_AUDIO = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'];
// ★2026-10-13★ Office / WPS 文档单独成一类（以前算 opaque、只给提示卡）：
//   现在交给通用预览渲染器 → 主进程借本机 Office 转成 PDF → 内核 PDF 阅读器内嵌显示。
//   留在 SR_EXT_OPAQUE 里的只剩"真的没法在面板里看"的：压缩包、PSD、可执行文件、数据库、镜像、APK。
var SR_EXT_OFFICE = ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'rtf', 'odt', 'ods', 'odp', 'wps', 'et', 'dps'];
var SR_EXT_OPAQUE = ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'psd', 'ai', 'exe', 'dll', 'msi', 'db', 'sqlite', 'bin', 'iso', 'apk'];
function srExtOf(p) {
  var m = /\.([A-Za-z0-9]+)$/.exec(String(p || '').trim());
  return m ? m[1].toLowerCase() : '';
}
function srKindOf(p) {
  var e = srExtOf(p);
  if (!e) return 'maybe-text';                       // 无后缀：先按文本试
  if (e === 'md' || e === 'markdown' || e === 'mdx') return 'md';
  if (SR_EXT_HTML.indexOf(e) >= 0) return 'html';    // HTML：看渲染效果（不是当源码看）
  if (SR_EXT_IMAGE.indexOf(e) >= 0) return 'image';
  if (SR_EXT_VIDEO.indexOf(e) >= 0) return 'video';
  if (SR_EXT_AUDIO.indexOf(e) >= 0) return 'audio';
  if (e === 'pdf') return 'pdf';
  if (SR_EXT_OFFICE.indexOf(e) >= 0) return 'office';   // Word/Excel/PPT：转 PDF 后内嵌显示
  if (SR_EXT_TEXT.indexOf(e) >= 0) return 'text';
  if (SR_EXT_OPAQUE.indexOf(e) >= 0) return 'opaque';
  return 'maybe-text';
}
// 二进制嗅探（只给"认不出扩展名"的文件用）：NUL 字节 = 一定是二进制；坏字符（U+FFFD，utf8 解不开的字节）
// 占比超过 5% 也算。真文本（哪怕是 GBK 的老笔记变成坏字符）不会满屏 NUL。
function srLooksBinary(text) {
  var s = String(text == null ? '' : text);
  if (!s) return false;
  if (s.indexOf('\u0000') >= 0) return true;
  var bad = (s.match(/\uFFFD/g) || []).length;
  return bad > 0 && bad / s.length > 0.05;
}
// 文件树里的小图标：一眼分清"点了会出图 / 会播 / 会渲染 / 打不开"
function srRowIcon(name) {
  var k = srKindOf(name);
  if (k === 'md') return '📄';
  if (k === 'image') return '🖼';
  if (k === 'video') return '🎞';
  if (k === 'audio') return '🔊';
  if (k === 'pdf') return '📕';
  if (k === 'office') return '📘';                   // Word/Excel/PPT：点开会在预览里转成 PDF
  if (k === 'html') return '🌐';
  if (k === 'text' || k === 'maybe-text') return '📃';
  return '🧩';                                       // opaque：要交给系统程序打开
}

// ---------- 右上角：文档树（目录＝单击进入，文件＝单击交给左窗预览，双击＝系统程序打开）----------
renderers['review-files'] = function (body, meta, head) {
  var K = (window.app && window.app.review) || null;
  body.classList.add('sr-wrap');

  var curRel = '', rowsCache = [], picked = '', disposed = false, seq = 0;

  // 功能按键（⌂ ↑ ⟳ ⧉）+ 面包屑全部并进**标题行**，排在标题「自我复盘 · 文档」后面 —— 三排压成一排：
  // 第二排的根路径与标题重复、面包屑根段「自我复盘」也重复（用户要求「重复的不显示」），
  // 「只读」徽标同样去掉了。拿不到标题行时退回内容区顶部（.sr-bar），保证单独渲染也能用。
  var bRoot = el('button', 'sr-btn', '⌂'); bRoot.type = 'button'; bRoot.title = '回到根目录';
  var bUp = el('button', 'sr-btn', '↑'); bUp.type = 'button'; bUp.title = '上一级';
  var bRe = el('button', 'sr-btn', '⟳'); bRe.type = 'button'; bRe.title = '重新读取目录';
  var bCp = el('button', 'sr-btn', '⧉'); bCp.type = 'button'; bCp.title = '复制当前文件夹的完整路径';
  var RO_NOTE = '这里是「个人档案 / 我的知识库」的复盘镜像：只读。要改档案去 <盘根>\\学习和自己\\个人档案 与 我的知识库，再同步过来。';
  // 当前文件夹的**完整路径**：并进标题行显示，可拖选、也可单击复制（用户要求）。
  var fpath = el('span', 'sr-fpath');
  fpath.title = '当前文件夹的完整路径（单击复制）';
  if (head) {
    head.classList.add('sr-head', 'sr-head-files');
    var acts = el('div', 'file-head-acts sr-head-acts');
    acts.appendChild(bRoot); acts.appendChild(bUp); acts.appendChild(bRe); acts.appendChild(bCp);
    // 副标题（镜像根路径）与标题行上的完整路径重复 —— 整条收掉，否则它 flex:1 1 100% 会硬占第二排
    var headSub = head.querySelector('.panel-sub');
    if (headSub) { headSub.textContent = ''; headSub.style.display = 'none'; }
    // 插到**标题之后**（同 makePanel 里 AI 面板「展开」箭头的写法）：徽标 → 标题 → 路径 → 提示 → 按键
    var titleEl = head.querySelector('.panel-title');
    if (titleEl) { head.insertBefore(fpath, titleEl.nextSibling); head.insertBefore(acts, fpath.nextSibling); }
    else { head.appendChild(fpath); head.appendChild(acts); }
  } else {
    var bar = el('div', 'sr-bar');
    bar.appendChild(bRoot); bar.appendChild(bUp); bar.appendChild(bRe); bar.appendChild(bCp);
    body.appendChild(bar);
    body.appendChild(fpath);
  }

  var list = el('div', 'sr-list');
  list.title = RO_NOTE;
  body.appendChild(list);

  var tip = srTipIn(head, body, acts);

  // 路径文字 = 当前文件夹的绝对路径（根目录不带结尾反斜杠）。不再印面包屑：路径本身就是"具体位置"，
  // 窄面板里两套并排也放不下；回根 / 上一级仍有 ⌂ ↑。
  function paintPath() {
    var abs = srAbs(curRel);
    fpath.textContent = abs;
    fpath.title = abs + '　（单击复制）';
  }

  function rowOf(r) {
    var rel = curRel ? curRel + '/' + r.name : r.name;
    var ic = r.isDir ? '📁' : srRowIcon(r.name);
    var row = el('div', 'sr-row' + (rel === picked ? ' on' : ''));
    row.appendChild(el('span', 'sr-ic', ic));
    row.appendChild(el('span', 'sr-name', r.name));
    row.appendChild(el('span', 'sr-meta', r.isDir ? '' : srSize(r.size)));
    row.title = r.isDir ? (rel + '　单击进入') : (rel + '　单击＝在左边预览');
    // ★2026-10-11★ 单击 = **一律**送到左边预览（用户要求"右边库点击直接预览"）。
    //   以前这里有个 `r.text` 条件：图片/视频/PDF 这些非文本会被判成"预览不了"直接丢给系统程序打开，
    //   于是"单击"在不同类型上行为不一致。现在一律预览，能不能内嵌由左边那块的分类来决定
    //   （打不开的格式它会给出提示 + 「用系统默认程序打开」按钮，不会白屏）。
    // ★2026-10-13★ 用户又要求：**单击、双击、怎么点都只在左边预览**，别再拿系统程序打开。
    //   原来双击那条 `dblclick` 会直接 shell.openPath 拉起 Word/图片查看器 —— 单击已经预览了，
    //   双击再弹一个外部窗口纯属碍事。⇒ 删掉 dblclick，只留 click 一条路：
    //   双击本来就会先触发两次 click，效果一样是"在左边预览"，行为彻底统一。
    //   「用系统默认程序打开」现在只有**左边预览面板工具栏上那一个入口**（🖥），不会误触。
    function pick() {
      if (r.isDir) { load(rel); return; }
      picked = rel;
      paintRows();
      var br = window.__SR;
      if (br && typeof br.open === 'function') { br.open(rel, r.name, r.size, r.mtime); return; }
      // 预览面板不在（理论上不会发生）：退回"用系统程序打开"，不静默什么都不做
      tip('预览面板不在，已交给系统程序打开：' + r.name, 3500);
      if (!srOpenPath(srFull(rel))) tip('打不开：主进程没有 openPath', 4000);
    }
    row.addEventListener('click', pick);
    return row;
  }

  function paintRows() {
    list.innerHTML = '';
    var rows = rowsCache;
    if (curRel) {
      var up = el('div', 'sr-row sr-up');
      up.appendChild(el('span', 'sr-ic', '↰'));
      up.appendChild(el('span', 'sr-name', '..'));
      up.title = '上一级';
      up.addEventListener('click', function () { load(srParent(curRel)); });
      list.appendChild(up);
    }
    if (!rows.length) { list.appendChild(el('div', 'sr-empty', '（空目录）')); return; }
    rows.forEach(function (r) { list.appendChild(rowOf(r)); });
  }

  function load(rel) {
    if (!K) {
      list.innerHTML = '';
      list.appendChild(el('div', 'sr-empty', '主进程接口 app.review 未就绪（需要重启 GUI）'));
      return;
    }
    curRel = String(rel || '');
    paintPath();
    var my = ++seq;
    list.innerHTML = '';
    list.appendChild(el('div', 'sr-empty', '读取中…'));
    Promise.resolve(K.files(curRel)).then(function (res) {
      if (disposed || my !== seq) return;
      if (!res || !res.ok) { list.innerHTML = ''; list.appendChild(el('div', 'sr-empty', (res && res.err) || '读取失败')); return; }
      rowsCache = res.rows || [];
      picked = (window.__SR && window.__SR.cur) || picked;
      paintRows();
    }).catch(function (e) {
      if (disposed || my !== seq) return;
      list.innerHTML = '';
      list.appendChild(el('div', 'sr-empty', '读取异常：' + e.message));
    });
  }

  // 预览面板切换文档 → 高亮（必要时跟着跳目录）；它在空状态点目录 → 这里跳过去
  function onPick(ev) {
    var rel = ev && ev.detail && ev.detail.rel;
    if (!rel) return;
    picked = rel;
    var dir = rel.indexOf('/') >= 0 ? rel.replace(/[^/]*$/, '').replace(/\/$/, '') : '';
    if (dir !== curRel) load(dir); else paintRows();
  }
  function onGoto(ev) {
    var rel = ev && ev.detail && typeof ev.detail.rel === 'string' ? ev.detail.rel : '';
    load(rel);
  }
  window.addEventListener('sr-pick', onPick);
  window.addEventListener('sr-goto', onGoto);
  // ★2026-10-13★ 预览面板点了「✕ 关闭」⇒ 这里只**取消高亮**，不跟着跳目录
  //   （不能用 sr-goto：那会把文件库整个导航回根目录，用户正翻到深目录时会很烦）
  function onClearPick() { picked = ''; paintRows(); }
  window.addEventListener('sr-clear-pick', onClearPick);

  bRoot.addEventListener('click', function () { load(''); });
  bUp.addEventListener('click', function () { load(srParent(curRel)); });
  bRe.addEventListener('click', function () { load(curRel); });
  // ⧉ 与标题行上的路径文字是同一件事：复制**当前文件夹**的绝对路径（跟左上角预览面板的 ⧉ 同一套
  // srCopy：textarea + execCommand，因为这里是 file:// 页面，navigator.clipboard 不一定可用）。
  function copyAbs() {
    var abs = srAbs(curRel);
    tip(srCopy(abs) ? '✓ 已复制路径：' + abs : '复制失败，可手动选中复制：' + abs, 3200);
  }
  bCp.addEventListener('click', copyAbs);
  fpath.addEventListener('click', copyAbs);

  load('');
  return function () {
    disposed = true;
    window.removeEventListener('sr-pick', onPick);
    window.removeEventListener('sr-goto', onGoto);
    window.removeEventListener('sr-clear-pick', onClearPick);
  };
};

// ---------- 左上角：文档预览（渲染 md；单击右上文档即在此打开；文档内相对链接原地跟读）----------
renderers['review-doc'] = function (body, meta, head) {
  var K = (window.app && window.app.review) || null;
  body.classList.add('sr-wrap', 'sr-doc');

  var curRel = '', disposed = false, seq = 0;

  // 场景内桥：右上角面板单击 → 这里打开（面板渲染顺序里本面板在前，桥一定先就位）
  var br = window.__SR || (window.__SR = {});
  // ★2026-10-11★ 桥多收两个参数（size / mtime）：右栏单击时顺手把大小、时间带过来 —— 图片/视频/PDF
  //   这类媒体就不用为了"显示大小"先把整个文件读一遍（PDF 动辄几十 MB，读进内存纯属浪费）。
  var mine = function (rel, name, size, mtime) { openDoc(rel, name, size, mtime); };
  br.open = mine;
  br.cur = '';

  var fname = el('div', 'sr-doc-name', '（未选择文档）');
  var fmeta = el('div', 'sr-doc-meta', '');
  var acts = el('div', 'sr-doc-acts');
  var bRe = el('button', 'sr-btn', '⟳'); bRe.type = 'button'; bRe.title = '重新读取这个文件';
  var bOut = el('button', 'sr-btn', '🖥'); bOut.type = 'button'; bOut.title = '用系统默认程序打开';
  var bRev = el('button', 'sr-btn', '📂'); bRev.type = 'button'; bRev.title = '在资源管理器里显示';
  var bCp = el('button', 'sr-btn', '⧉'); bCp.type = 'button'; bCp.title = '复制完整路径';
  // ★2026-10-13★ 「✕ 关闭当前预览」（用户要求：加在「复制」右边）——此前只有"换一个文件"、没有"合上"，
  //   看完想收工只能去点别的文件，面板一直占着一份正文。
  //   行为＝回到「未选择文档」空状态 ＋ **顺手忘掉"上次看的文件"**（否则下次开面板它又自己回来了）。
  var bClose = el('button', 'sr-btn sr-btn-close', '✕'); bClose.type = 'button';
  bClose.title = '关闭当前预览（回到「未选择文档」；下次开面板不会自动恢复这个文件）';
  acts.appendChild(bRe); acts.appendChild(bOut); acts.appendChild(bRev); acts.appendChild(bCp); acts.appendChild(bClose);

  // 功能按键并进面板标题行（跟窗口二 .sr-head-acts 同一套做法）：标题「文档预览」→ 文件名 → 靠右的按键，
  // 全在一排；「完整路径 · 大小 · 时间」走标题行下面那行副标题（原来面板的那句提示语只在没打开文档时显示）。
  // 这样内容区只剩 md 正文，不再被横条吃掉一行。拿不到 head 时退回旧横条（.sr-doc-bar），单独渲染也不会瞎。
  var headSub = head ? head.querySelector('.panel-sub') : null;
  var SUB_HINT = '单击右上的文件即可在此预览（要改就用这排的 🖥 打开系统程序）';
  function subText(t) { if (headSub) headSub.textContent = t; else if (fmeta) fmeta.textContent = (t === SUB_HINT ? '' : t); }
  if (head) {
    // sr-head-doc：窗口一专用类 —— 文件名 + 路径·大小·时间 + 按键全部挤进标题这一排（见 styles.css）
    head.classList.add('sr-head', 'sr-head-doc');
    acts.classList.add('sr-head-acts');
    if (!headSub) { headSub = el('span', 'panel-sub', ''); head.appendChild(headSub); }
    // 必须插在**标题之后、副标题之前**：副标题是 flex:1 1 100% 独占一排，
    // 排到它后面的东西会被顶到第三排（窗口二已经踩过一次，见项目信息 §23.5）。
    var titleEl = head.querySelector('.panel-title');
    if (titleEl) { head.insertBefore(fname, titleEl.nextSibling); head.insertBefore(acts, fname.nextSibling); }
    else { head.appendChild(fname); head.appendChild(acts); }
  } else {
    var bar = el('div', 'sr-doc-bar');
    bar.appendChild(fname); bar.appendChild(fmeta); bar.appendChild(acts);
    body.appendChild(bar);
  }

  var md = el('div', 'sr-md');
  body.appendChild(md);

  var tip = srTipIn(head, body, acts);

  // ---------- 非文本类：整块交给通用预览渲染器（复用，不重写）----------
  // ★2026-10-11★ 用户要求「预览能预览的全部文件」。图片（滚轮缩放）、视频/音频（播放条）、
  //   PDF（内核自带阅读器）、HTML（内嵌渲染）这四类**一行渲染代码都不在这儿写** ——
  //   直接把通用预览渲染器 renderers.view 挂进内容区，用它的 window.__kunViews[面板id] 把文件递过去
  //   （跟「设计杂活」预览面板、流程画布双击节点同一条路）。以后 view 那边的图片缩放 / PDF 兜底 /
  //   播放器修好了，这里跟着一起好。
  //   ⚠ 它是往 md 里塞 .view-bar / .view-body / .view-status 的**列式**布局 ⇒ 需要 styles.css 的
  //     `.sr-md.sr-media` 那条规则（收掉正文内边距/滚动，并收掉与面板标题行重复的那条 view 工具行）。
  var MEDIA_ID = 'sr-doc-media';
  var mediaCleanup = null, mediaApi = null;
  function dropMedia() {
    if (mediaCleanup) { try { mediaCleanup(); } catch (e) { /* ignore */ } }
    mediaCleanup = null;
    mediaApi = null;
    md.classList.remove('sr-media');
    if (md.firstChild) md.innerHTML = '';
  }
  function showMedia(kind, rel, name) {
    if (!mediaApi) {
      // ★ 第一次挂通用预览渲染器之前必须先把内容区清干净：上一个文件若是**文本**，
      //   它的 <pre> 是直接写在 md 里的（不属于 view 的 bodyBox，view 的 clearBody 清不掉它），
      //   留着就会把 .view-body 挤成 0 高 —— 表现为"标题栏换成了图片名，正文还是上一篇的文字，
      //   图/PDF 其实已经加载了却看不见"（2026-10-11 探针实测抓到的真 bug）。
      if (md.firstChild) md.innerHTML = '';
      md.classList.add('sr-media');
      mediaCleanup = renderers.view(md, { id: MEDIA_ID });     // ← 复用：它自己往 md 里建「工具行/主体/状态行」
      mediaApi = (window.__kunViews || {})[MEDIA_ID] || null;
    } else {
      md.classList.add('sr-media');
    }
    if (!mediaApi) { showOpaque(rel, name); return; }          // 极端情况（注册表没拿到）⇒ 退回提示卡，绝不白屏
    mediaApi.show({ path: srFull(rel), title: name || '', kind: kind });
  }
  // 「内核渲染不了」的格式（docx/xlsx/pptx/zip/psd…）：说清是什么格式、为什么看不了，并给一个
  // **写在卡片里**的「用系统默认程序打开」按钮 —— 用户明确要求"不要白屏、不要静默失败"。
  function showOpaque(rel, name) {
    dropMedia();
    var box = el('div', 'sr-raw');
    var e = srExtOf(rel);
    box.appendChild(el('div', 'sr-raw-ic', '🧩'));
    box.appendChild(el('div', 'sr-raw-t', (name || rel.split('/').pop() || rel) + (e ? '（.' + e + '）' : '')));
    box.appendChild(el('div', 'sr-raw-s', '这种格式没法在面板里内嵌预览（Word / Excel / PPT / WPS 文档、压缩包、PSD 这类"打包格式"都算）。'
      + '用系统里默认的程序打开它就能看 —— 预览面板不会白屏，也不会默默什么都不做。'));
    var row = el('div', 'sr-raw-acts');
    var b1 = el('button', 'sr-qbtn sr-qopen', '🖥 用系统默认程序打开');
    b1.type = 'button';
    b1.addEventListener('click', function () { if (!srOpenPath(srFull(rel))) tip('打不开：主进程没有 openPath', 4000); });
    var b2 = el('button', 'sr-qbtn', '📂 在资源管理器里显示');
    b2.type = 'button';
    b2.addEventListener('click', function () { if (!srRevealPath(srFull(rel))) tip('打不开：主进程没有 revealPath', 4000); });
    row.appendChild(b1); row.appendChild(b2);
    box.appendChild(row);
    box.appendChild(el('div', 'sr-raw-path', srFull(rel)));
    md.appendChild(box);
  }
  // 打开过一次就记一次（下次 ⟳ / 切场景回来恢复），并让右栏跟着高亮 —— 两条都是原来散在成功分支里的
  function markPicked(rel) {
    try { localStorage.setItem(SR_LAST_KEY, rel); } catch (e) { /* ignore */ }
    try { window.dispatchEvent(new CustomEvent('sr-pick', { detail: { rel: rel } })); } catch (e) { /* ignore */ }
  }
  // 非 md 的文本（txt / json / 代码 / csv / log…）：**按原文显示**，不丢换行。
  //   （以前所有文本都被丢进 Markdown 渲染器 ⇒ json / 代码会被并成一整段，看着就像坏了）
  function showPlainText(text) {
    dropMedia();
    md.appendChild(el('pre', 'sr-pre', String(text == null ? '' : text)));
    md.scrollTop = 0;
  }
  function showMarkdown(text) {
    dropMedia();
    md.innerHTML = srMd(text);
    md.scrollTop = 0;
  }

  async function openDoc(rel, name, size, mtime) {
    rel = String(rel || '');
    if (!rel) return;
    if (!K) {
      dropMedia();
      md.appendChild(el('div', 'sr-empty', '主进程接口 app.review 未就绪（需要重启 GUI）'));
      return;
    }
    curRel = rel;
    br.cur = rel;
    syncClose();                                  // 有文件了 ⇒ ✕ 可用（2026-10-13）
    fname.textContent = name || rel.split('/').pop() || rel;
    fname.title = srFull(rel);
    var kind = srKindOf(rel);
    var title = srFull(rel) + (size ? '　·　' + srSize(size) : '') + (mtime ? '　·　' + srTime(mtime) : '');
    var my = ++seq;
    // ① 媒体类（图片/视频/音频/PDF/HTML/Office）：**不读盘**，直接交给通用预览渲染器
    //    ★2026-10-13★ office 也走这条：通用预览渲染器那边会先让主进程转成 PDF，再用内核 PDF 阅读器显示
    if (kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'pdf' || kind === 'html' || kind === 'office') {
      subText(title);
      showMedia(kind === 'html' ? 'web' : kind, rel, name);
      markPicked(rel);
      return;
    }
    // ② 打包类（zip/rar/7z/psd/exe/db/iso/apk…）：内核渲染不了、也转不出 PDF ⇒ 提示卡 + 系统打开按钮
    if (kind === 'opaque') {
      subText(title);
      showOpaque(rel, name);
      markPicked(rel);
      return;
    }
    // ③ 文本类（md / 源码 / 数据 / 配置 / 认不出扩展名的）：读 utf8 正文
    subText('读取中…');
    dropMedia();
    md.innerHTML = '<div class="sr-empty">读取中…</div>';
    let res = null;
    try { res = await K.read(rel); } catch (e) { res = { ok: false, err: '读取异常：' + ((e && e.message) || e) }; }
    if (disposed || my !== seq) return;
    if (!res || !res.ok) {
      // ★2026-10-11★ 文件不在了（ENOENT：stat/readFile 失败，多见于档案里删过/改过名）⇒ 说人话 + 忘掉这个路径 + 回根，
      //   绝不把内核的 "ENOENT: no such file or directory, stat '…'" 原文糊在面板上。其它错误（越界/目录/权限/编码）照旧原样显示。
      if (/ENOENT|no such file or directory/i.test(String((res && res.err) || ''))) {
        emptyState('上次看的文件不在了（可能已改名或移动）　·　原路径：' + srFull(rel) + '　·　已回到档案根目录');
        try { localStorage.removeItem(SR_LAST_KEY); } catch (e) { /* ignore */ }
        try { window.dispatchEvent(new CustomEvent('sr-goto', { detail: { rel: '' } })); } catch (e) { /* ignore */ }
        return;
      }
      dropMedia();
      md.appendChild(el('div', 'sr-empty', (res && res.err) || '读取失败'));
      subText('');
      return;
    }
    var txt = String(res.content == null ? '' : res.content);
    // 认不出扩展名的文件（无后缀 / .sample 这类）：正文里出现 NUL（或大量坏字符）= 其实是二进制
    //   ⇒ 退回"打不开"卡片，绝不把乱码糊在面板里（不静默失败）
    if (kind === 'maybe-text' && srLooksBinary(txt)) {
      subText(srFull(rel) + '　·　' + srSize(res.size) + '　·　' + srTime(res.mtime));
      showOpaque(rel, name);
      markPicked(rel);
      return;
    }
    subText(srFull(rel) + '　·　' + srSize(res.size) + '　·　' + srTime(res.mtime));
    if (kind === 'md') showMarkdown(txt); else showPlainText(txt);
    if (res.cut) md.insertBefore(el('div', 'sr-cut', '⚠ 文件超过 4 MB，这里只渲染了前 4 MB'), md.firstChild);
    markPicked(rel);
  }

  // 文档里的链接：站内相对链接 → 原地跟读（_索引.md 里那一堆链接直接点就行）；外链 → 交给系统浏览器
  md.addEventListener('click', function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    ev.preventDefault();
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(href)) { srOpenPath(href); return; }
    if (href.charAt(0) === '#') return;
    // ★2026-10-13★ Markdown 里的目标路径必须允许**百分号编码**：文件名带半角空格或半角括号时
    //   （例：`中国鸟类图鉴(1).pdf`、`中国毒蛇及蛇伤救治 (蓝海，陈远聪).pdf`），
    //   裸写会被 Markdown 语法截断（`)` 提前结束目标），所以档案索引里统一写成 `%28`/`%20`
    //   —— 浏览器会自动解码，但这里是自己的渲染器，不解码就点不开（表现为"链接是死的"）。
    //   实测：自我复盘 `关系复盘\_索引.md`、`我的知识库\...\_索引.md` 里共 14 条这类链接。
    if (href.indexOf('%') >= 0) { try { href = decodeURI(href); } catch (e) { /* 不是合法编码就按原样用 */ } }
    var dir = curRel.indexOf('/') >= 0 ? curRel.replace(/[^/]*$/, '') : '';
    openDoc(srJoin(dir, href), null);
  });

  // 空状态：一段说明 + 根目录里的文档/目录快捷入口
  function emptyState(notice) {
    dropMedia();
    fname.textContent = '（未选择文档）';
    subText(SUB_HINT);
    var box = el('div', 'sr-empty sr-empty-big');
    box.appendChild(el('div', 'sr-empty-t', '自我复盘 · 文件预览'));
    if (notice) box.appendChild(el('div', 'sr-empty-s', notice));   // ★2026-10-11★ 回根原因（上次看的文件不在了），说人话
    box.appendChild(el('div', 'sr-empty-s', '在右上角「库」里单击一个文件，这里就会预览它（目录单击＝进入）。'
      + '单击、双击、怎么点都只在这里预览，只有这排的 🖥 才会拉起外部程序。'
      + '能预览的：md / txt / 代码 / json / csv 这些文本、图片（可滚轮缩放）、视频、音频、PDF、HTML、'
      + 'Word / Excel / PPT（自动转成 PDF 内嵌）；压缩包这类真的看不了的，会给一张提示卡 + 一键「用系统默认程序打开」。'
      + '看完点 ✕ 就能合上。'));
    md.appendChild(box);
    syncClose();                                  // 空状态 ⇒ ✕ 置灰（2026-10-13）
    if (!K) return;
    Promise.resolve(K.files('')).then(function (res) {
      if (disposed || !res || !res.ok) return;
      var quick = el('div', 'sr-quick');
      (res.rows || []).filter(function (r) { return r.isDir; }).forEach(function (r) {
        var b = el('button', 'sr-qbtn sr-qdir', '📁 ' + r.name);
        b.type = 'button';
        b.title = '在右上面板里进入这个目录';
        b.addEventListener('click', function () {
          try { window.dispatchEvent(new CustomEvent('sr-goto', { detail: { rel: r.name } })); } catch (e) { /* ignore */ }
        });
        quick.appendChild(b);
      });
      (res.rows || []).filter(function (r) { return !r.isDir; }).slice(0, 6).forEach(function (r) {
        var b = el('button', 'sr-qbtn', r.name);
        b.type = 'button';
        b.addEventListener('click', function () { openDoc(r.name, r.name); });
        quick.appendChild(b);
      });
      if (quick.childNodes.length) md.appendChild(quick);
    }).catch(function () { /* ignore */ });
  }

  bRe.addEventListener('click', function () { if (curRel) openDoc(curRel, null); });
  bOut.addEventListener('click', function () { if (curRel && !srOpenPath(srFull(curRel))) tip('打不开：主进程没有 openPath', 4000); });
  bRev.addEventListener('click', function () { if (curRel && !srRevealPath(srFull(curRel))) tip('打不开：主进程没有 revealPath / openFolder', 4000); });
  bCp.addEventListener('click', function () { if (curRel) tip(srCopy(srFull(curRel)) ? '✓ 已复制完整路径' : '复制失败', 2200); });

  // ---- ✕ 关闭当前预览（2026-10-13 加）----
  // 没打开任何文件时置灰（不然点了没反应，像坏了）。
  function syncClose() { bClose.disabled = !curRel; }
  function closeDoc() {
    if (!curRel) return;
    dropMedia();                                  // 图片/视频/PDF/HTML 这类挂在预览区的要一起销毁
    seq++;                                        // 还在路上的读取结果作废
    curRel = ''; br.cur = '';
    // 忘掉"上次看的文件"：不清的话下次开面板（或点 ⟳）它又自己恢复了，跟"我关掉了"矛盾
    try { localStorage.removeItem(SR_LAST_KEY); } catch (e) { /* ignore */ }
    emptyState('已关闭预览　·　再点右上角「库」里的文件名就能重新打开');
    syncClose();
    // 右上角文件库把高亮也去掉（只清高亮，不跳目录 —— 他可能正翻在很深的目录里）
    try { window.dispatchEvent(new CustomEvent('sr-clear-pick')); } catch (e) { /* ignore */ }
    tip('已关闭预览', 1600);
  }
  bClose.addEventListener('click', closeDoc);

  var last = '';
  try { last = localStorage.getItem(SR_LAST_KEY) || ''; } catch (e) { last = ''; }
  if (last) openDoc(last, null); else emptyState();

  return function () {
    disposed = true;
    seq++;                     // 还在路上的读取结果一律作废
    dropMedia();               // 挂在这儿的通用预览渲染器（图/视频/PDF/HTML）要一起销毁，别留下监听与 webview
    if (window.__SR && window.__SR.open === mine) window.__SR.open = null;
    if (window.__SR && window.__SR.cur === curRel) window.__SR.cur = '';
  };
};

// ============ 右上角「MCP」开关面板（2026-09-21）============
// 面板本体在同目录 mcp-panel.js：本文件每次点 ⟳ 都会重新执行，所以这里用带版本号的
// 动态 <script> 把面板也一起重载（删旧的再加新的）—— 改面板只需点 ⟳，不必重启 GUI。
(function () {
  try {
    var old = document.getElementById('mcp-panel-script');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var s = document.createElement('script');
    s.id = 'mcp-panel-script';
    s.src = 'mcp-panel.js?v=' + Date.now();
    (document.body || document.documentElement).appendChild(s);
  } catch (e) { if (window.console) console.warn('[mcp] 面板加载失败', e); }
})();

// ---- 网页版 AI 桥（renderer\webai-bridge.js）----
// 让任何会话/脚本能问顶栏那 5 个免费网页版（入口：scripts\webai.mjs）。
// 靠 window.__kunWebAiBridge 幂等：⟳ 重跑只是换一次回调，监听不叠（preload 侧只有一个分发器）。
(function () {
  var old = document.getElementById('webai-bridge-script');
  if (old && old.parentNode) old.parentNode.removeChild(old);
  var s = document.createElement('script');
  s.id = 'webai-bridge-script';
  s.src = 'webai-bridge.js?v=' + Date.now();
  (document.body || document.documentElement).appendChild(s);
})();

// ============ 面板对话框「焦点自愈」（2026-09-21）============
// 症状（用户实测原话）：对准面板窗口打字，字不进对话输入框、聊天框不显示，切到别的软件再切回来才好。
// 病因：宿主（<webview> 的 embedder）与 guest 的焦点不同步 —— guest 里的 composer 本来记得焦点，
//       但系统焦点没交给 guest，键盘事件就落在宿主那层（字跑到左上角那块），对话输入框自然不动。
// 修法：只在「guest 内部没有任何可编辑元素持有焦点」时，把焦点交回 guest **最靠下**的可编辑元素
//       （DSH 的 composer 就在页面底部）。用户正在打字时它已经持有焦点 ⇒ 这条分支不会走 ⇒ 绝不打断输入。
// 三道护栏（都是实测会踩到的场景）：
//   ① 宿主自己在输入（重命名节点、画布输入框等）⇒ 不抢；
//   ② 用户正待在别的 <webview> 里（顶栏网页版 AI 窗口、另一个面板）⇒ 不抢；
//   ③ 同一个位置 300ms 内只做一次（focus / transition 会连成一串）。
// 触发点＝用户手动的那个动作：窗口重新拿到系统焦点（alt-tab 回来）／页面重新可见／面板动画结束。
// 生效：改本文件 → 点顶栏 **⟳**（renderer 热更新），**不用重启**。排查用：控制台 `__kunFocusHealNow()`。
(function () {
  if (window.__kunFocusHeal) return;          // ⟳ 重跑只是重新执行本文件 ⇒ 装一次就够
  window.__kunFocusHeal = true;
  var HEAL = '(function(){try{' +
    'function ok(el){return !!el&&(el.tagName==="TEXTAREA"||el.tagName==="INPUT"||el.isContentEditable===true);}' +
    'var a=document.activeElement;' +
    'if(ok(a)){var ra=a.getBoundingClientRect();if(ra.width>40&&ra.height>8)return "keep:"+a.tagName;}' +
    'var n=document.querySelectorAll("textarea,[contenteditable=true]"),best=null,bestTop=-1e9;' +
    'for(var i=0;i<n.length;i++){var e=n[i],r=e.getBoundingClientRect(),s=getComputedStyle(e);' +
    'if(r.width<40||r.height<8||s.display==="none"||s.visibility==="hidden"||s.pointerEvents==="none")continue;' +
    'if(r.top>bestTop){bestTop=r.top;best=e;}}' +
    'if(best){try{best.focus();}catch(e2){}return "fix:"+best.tagName;}' +
    'return "none";}catch(e){return "err";}})()';
  function panelWv() {                        // 正在显示的那个对话面板 webview（有面积 = 在显示）
    var list = document.querySelectorAll('#harness-webview, webview.harness-wv'), best = null, area = 0;
    for (var i = 0; i < list.length; i++) {
      var wv = list[i], r;
      try { r = wv.getBoundingClientRect(); } catch (e) { continue; }
      if (r.width < 120 || r.height < 120) continue;
      var s = getComputedStyle(wv);
      if (s.display === 'none' || s.visibility === 'hidden') continue;
      if (r.width * r.height > area) { area = r.width * r.height; best = wv; }
    }
    return best;
  }
  var last = 0;
  // 留痕：每次自愈都往 data\focus-heal.log 追一行（只留最后 300 行）——
  // 这样"到底有没有再犯"不用靠用户开控制台，看文件就知道（走 app.file 通道，只允许 <盘根>:/E: 盘）。
  var LOG = '<盘根>\\DSH\\外壳\\data\\focus-heal.log';
  function logHeal(why, r) {
    try {
      if (!window.app || !window.app.file || !window.app.file.write) return;
      window.app.file.read(LOG).then(function (res) {
        var old = (res && res.ok && res.text) ? res.text.split('\n') : [];
        var d = new Date();
        var stamp = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2) +
          ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2);
        old.push(stamp + '  ' + why + ' → ' + r);
        var keep = old.filter(function (x) { return x !== ''; }).slice(-300);
        return window.app.file.write(LOG, keep.join('\n') + '\n');
      }).catch(function () { });
    } catch (e) { /* ignore */ }
  }
  function heal(why) {
    var wv = panelWv();
    if (!wv || !wv.focus) return;
    var ae = document.activeElement;                                   // ①② 两道护栏
    if (ae && ae !== document.body) {
      if (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable) return;
      if (ae.tagName === 'WEBVIEW' && ae !== wv) return;
    }
    try { wv.focus(); } catch (e) { }
    try {
      wv.executeJavaScript(HEAL).then(function (r) {
        logHeal(why, r);
        if (window.console && r && r.indexOf('fix') === 0) console.log('[focus-heal] ' + why + ' → ' + r);
      }).catch(function () { });
    } catch (e) { }
  }
  function healSoon(why) {
    var t = Date.now(); if (t - last < 300) return; last = t;           // ③ 防抖
    setTimeout(function () { heal(why); }, 60);
  }
  window.addEventListener('focus', function () { healSoon('win-focus'); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) healSoon('visible'); });
  document.addEventListener('transitionend', function (e) {
    var c = e.target && e.target.classList;
    if (c && (c.contains('panel-body') || c.contains('view-body') || c.contains('webai-body'))) healSoon('anim');
  }, true);
  window.__kunFocusHealNow = function () { heal('manual'); return 'ok'; };   // 手动触发（排查用）
})();

// ================= 独立窗口「置顶」（2026-09-23 第十一轮；第十二轮修"刷新多一个" + 换线性图钉）=================
// 场景分离窗口（?solo=1，主进程 createWindow({scene}) 打开的独立窗口）顶部菜单栏加一个置顶按钮：
// 点它 = 主进程 win.setAlwaysOnTop 开关 ⇒ 置顶后窗口浮在最上层，缩小独立窗口也能
// 「一边看独立窗口、一边看主窗口」，点主窗口/其它页面不会被遮挡。再点取消。
// 放 renderers.js（⟳ 即见）；切置顶走 app.setAlwaysOnTop（preload/main 暴露，重启 GUI 后可用；
// 老宿主没有它 ⇒ 按钮不显示，不崩）。
// ⚠ **必须幂等**：⟳ 是**热更新**（renderer.js 的 hotReloadRenderers() 重新加载本文件、DOM 不重载）
//   ⇒ 这段 IIFE 每点一次 ⟳ 就重跑一遍。原来无条件 insertBefore，点几次就插几个按钮（用户实测报的 bug）。
//   现在：先摘掉旧的 #btn-flow-pin 再重建 —— 旧的 click 监听随节点一起丢掉，**不会**出现"两个监听
//   各切一次 = 点了没反应"；置顶状态记在 data-on 上（DOM 不重载 ⇒ 刷新后状态不丢，接着显示"已置顶"）。
// 图标：与顶栏其它线性图标（手机/技能）同款 —— 16×16、currentColor、stroke-width 1.3 的**图钉**，
//   不再是 📌 emoji（emoji 大小/配色跟着系统字体走，跟顶栏不搭）。
(function () {
  if (!/[?&]solo=1/.test(window.location.search || '')) return;   // 只在独立窗口显示
  var bar = document.querySelector('.titlebar-controls');
  var minBtn = document.getElementById('btn-min');
  if (!bar || !minBtn) return;
  if (!(window.app && window.app.setAlwaysOnTop)) return;         // 老宿主没有这个 IPC ⇒ 干脆不显示按钮

  var PIN_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">'
    + '<path d="M6.15 1.85h3.7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>'
    + '<path d="M7.05 1.85v3.3L4.85 7.6v1.25h6.3V7.6L8.95 5.15v-3.3" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>'
    + '<path d="M8 8.85v5.3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>'
    + '</svg>';

  var prevs = document.querySelectorAll('#btn-flow-pin');        // ⚠ 老版本可能已经插了**好几个**（同 id 重复），getElementById 只拿得到第一个 ⇒ 用 querySelectorAll 全摘
  var on = prevs.length ? prevs[prevs.length - 1].getAttribute('data-on') === '1' : false;
  prevs.forEach(function (b) { b.remove(); });                   // 连旧的 click 监听一起丢掉（避免双触发）
  var btn = el('button', 'tb-btn tb-tools');
  btn.type = 'button';
  btn.id = 'btn-flow-pin';
  btn.innerHTML = PIN_SVG;
  function paint() {
    btn.classList.toggle('on', on);
    btn.setAttribute('data-on', on ? '1' : '0');
    btn.title = on
      ? '已置顶（点我取消：窗口回到普通层，会被其它窗口挡住）'
      : '置顶显示：窗口浮在最上层，缩小后一边看独立窗口一边看主窗口';
  }
  btn.addEventListener('click', async function () {
    var want = !on;
    on = want; paint();                     // 先乐观切换（IPC 回来前界面不卡）
    try {
      var r = await window.app.setAlwaysOnTop(want);
      if (!r || !r.ok) { on = !want; paint(); }
    } catch (e) { on = !want; paint(); }
  });
  paint();
  bar.insertBefore(btn, minBtn);            // 排在 ─ □ ✕ 那组前面，紧挨窗口控制按钮
})();

// ==========================================================================================
// 2026-10-19（宿主：「看着没变化」）—— styles.css 热重载
//   根因：刷新面板只重载 webview + 重跑页面脚本，**不会重新拉 styles.css** ⇒ 改 CSS 以前必须整页刷新。
//   做法：每 2 秒 stat 一次 styles.css 的 mtime，变了就给 <link> 换个查询串 ⇒ 浏览器重新拉文件。
//   纯渲染层（不碰 main/preload）；幂等：计时器挂在 window.__dshCssHot 上，⟳ 多次也只跑一个。
// ==========================================================================================
(function cssHotReload() {
  try {
    if (window.__dshCssHot) return;
    var F = window.app && window.app.file;
    if (!F || !F.stat) return;                       // 老宿主没有 stat ⇒ 静默跳过
    var link = document.querySelector('link[rel="stylesheet"][href*="styles.css"]');
    if (!link) return;
    var winPath = decodeURIComponent(location.pathname).replace(/^\//, '').replace(/\//g, '\\');
    var cssPath = winPath.replace(/[^\\]+$/, 'styles.css');
    window.__dshCssHot = { at: 0, path: cssPath, link: link, n: 0 };
    var last = 0;
    function tick() {
      Promise.resolve().then(function () { return F.stat(cssPath); }).then(function (st) {
        if (!st || !st.exists) return;
        var t = Number(st.mtime) || 0;
        if (!t) return;
        if (last && t !== last) {
          link.href = 'styles.css?v=' + t;
          window.__dshCssHot.n++;
          window.__dshCssHot.at = Date.now();
          if (window.console) console.log('[cssHot] styles.css 变了 ⇒ 重新加载（第 ' + window.__dshCssHot.n + ' 次）');
        }
        last = t;
      }).catch(function () { /* 读不到就算了 */ });
      window.__dshCssHot.at = window.__dshCssHot.at || Date.now();
      window.__dshCssHot.at = window.__dshCssHot.at || Date.now();
    }
    tick();
    setInterval(tick, 2000);
  } catch (e) { /* 装饰失败不影响主流程 */ }
})();

// ==========================================================================================
// 2026-10-19 22:4x（宿主：「打开工作台时 B站场景的网页也露出来」· dg-dsh 定位）
//   机制：切视图只切 .active 类 ⇒ #scenario-view 变 display:none，但 Electron 的 <webview> 是独立 guest view，
//         **不跟着 display:none 隐藏** ⇒ 残影露出来（harness 视图里也能看到 B站网页）。
//   做法：用本仓既有先例（renderers.js L1412：隐藏层用 opacity:0 + pointer-events:none，**不用 display:none**，
//         否则终端/webview 的尺寸测量会失真）——
//     · #scenario-view 失去 .active ⇒ 把里面所有 webview 设 opacity:0 / pointer-events:none（保留尺寸与运行状态）
//     · 重新拿到 .active ⇒ 还原
//     · ⛔ 绝不动 src / 不 reload（B站登录态与页面进度都要保住）
//     · ⚠ 只管 #scenario-view 里的 webview，**不碰 harness 自己的 #harness-webview**
//   场景 A⇄B 互切：grid 会被重建、旧 guest 可能残留一帧 ⇒ 点场景标签时先 park，400ms 后按 .active 状态复位。
// ==========================================================================================
(function parkScenarioWebviews() {
  try {
    if (window.__dshParkWv) return;                       // 幂等：⟳ 多次只装一次
    var host = document.getElementById('scenario-view');
    if (!host) return;
    window.__dshParkWv = true;

    function each(fn) {
      var list = host.querySelectorAll('webview');
      for (var i = 0; i < list.length; i++) fn(list[i]);
    }
    function park(hide) {
      each(function (w) {
        if (hide) {
          if (!w.__dshParked) {
            w.__dshParked = { opacity: w.style.opacity, pe: w.style.pointerEvents };
          }
          w.style.opacity = '0';
          // 2026-10-19 宿主「B站内容操作不了」：这里原来越权设了 pointer-events:none，
          //   一旦某次 sync 没跑（页面重建时序）就会把可见的 webview 钉成不可点。
          //   其实隐藏时父级是 display:none，本来就点不到 ⇒ 这行不需要。
        } else if (w.__dshParked) {
          w.style.opacity = w.__dshParked.opacity || '';
          w.style.pointerEvents = '';   // 无条件清掉：宁可多点穿透，也不能让页面点不动
          delete w.__dshParked;
        }
      });
    }
    function sync() { park(!host.classList.contains('active')); }

    // ① 视图切换：盯 #scenario-view 的 class
    new MutationObserver(sync).observe(host, { attributes: true, attributeFilter: ['class'] });
    sync();

    // ② 场景 A⇄B：点标签时先压住，等重建完（400ms）再按当前可见性复位
    // 2026-10-19 宿主「B站内容操作不了」：原来点场景标签会先 park(true) 再 400ms 复位 ⇒ 时序一乱就把页面钉成不可点。
    //   这里整段撤掉：A⇄B 的残帧最多闪一下，但绝不会让人点不动（可点优先于好看）。
    // ③ 兜底：grid 内容变化时（场景重建）也让新加入的 webview 跟随当前可见性
    var grid = document.getElementById('grid');
    if (grid) {
      new MutationObserver(function () { if (!host.classList.contains('active')) park(true); })
        .observe(grid, { childList: true });
    }
    // 2026-10-19 兜底看门狗：每 2s 检查一次 —— 场景视图激活时，任何被 park 过的 webview 立即还原。
    //   （宁可多跑一个很轻的定时器，也不允许"页面看得见却点不动"）
    setInterval(function () { if (host.classList.contains('active')) park(false); }, 2000);
    // 2026-10-19 23:2x（bv-ai：也许输入没路由到 guest）—— 场景激活时给 webview 补一次 focus（无损）。
    //   ⚠ `重新 append` 那条我先**不启用**：移动 <webview> 可能让 guest 重载（B站会丢页面进度），
    //   等探针 `_点击探针.json` 里的 clicks / hostTop 出来再决定（clicks=0 且 hostTop=webview 才用）。
    new MutationObserver(function () {
      try {
        if (!host.classList.contains('active')) return;
        var ws = host.querySelectorAll('webview');
        for (var i = 0; i < ws.length; i++) {
          var w = ws[i];
          // 2026-10-19 23:3x：探针实测 clicks=0 且 hostTop=webview（没有遮挡、自身也没 pointer-events）
          //   ⇒ 就是 guest 的输入没路由。按 bv-ai 建议：**可见后重新挂一次**（同父容器内 append 回去），
          //   强制 guest 重新计算输入区域。每个 webview 只做一次（避免每次切场景都重挂）。
          if (w && !w.__dshRemounted) {
            w.__dshRemounted = 1;
            try { var pp = w.parentNode; if (pp) pp.appendChild(w); } catch (e) { /* ignore */ }
          }
          try { if (w && w.focus) w.focus(); } catch (e) {}
        }
      } catch (e) { /* ignore */ }
    }).observe(host, { attributes: true, attributeFilter: ['class'] });
    if (window.console) console.log('[park] 场景 webview 停车机制已装（opacity 方案，不动 src）');
  } catch (e) { /* 装饰失败不影响功能 */ }
})();