// 工作台 — 渲染层外壳（场景切换 / 标题栏 / 热更新 / 插件·模型面板）
// 场景 0：DSH 引擎（默认初始界面，webview 内嵌，带 token）
// 场景 1..N：本地场景（scenarios/*.json 配置 + renderers.js 分发）
//
// 热更新约定：面板渲染器全部放在 renderers.js（挂 window.APP_RENDERERS / APP_RENDER_UTILS）。
// 点标题栏「刷新」→ 带时间戳重新加载 renderers.js + 重建当前场景面板，
// 不重载本页面 → harness webview 保持原样，对话不断。
//
// 注意：renderers.js 与外壳都挂在全局作用域，这里一律用 mk* / k* 别名，
// 避免与 renderers.js 里的 el/makePanel/... 顶层声明冲突。
'use strict';

const kUtils = () => window.APP_RENDER_UTILS;
const kRender = () => window.APP_RENDERERS || {};
const mkEl = (tag, cls, text) => kUtils().el(tag, cls, text);
const mkPanel = (meta, idx) => kUtils().makePanel(meta, idx);

// ---------- 场景切换 ----------
const harnessView = document.getElementById('harness-view');
const scenarioView = document.getElementById('scenario-view');
const grid = document.getElementById('grid');
const webview = document.getElementById('harness-webview');
const tabsNav = document.getElementById('scenario-tabs');

let currentTab = null;
// 底部菜单栏：序号徽标显隐（模块级，loadScenario 重渲染后保持）——默认关闭
let badgesOn = false;

// ---------- 拖放兜底（防止"拖文件进来 → 窗口跳走/像闪退"）----------
// 默认情况下，把文件拖到窗口上松开，Chromium 会导航到 file:// 那个文件，
// 整个工作台界面就被"顶掉"了（用户观感＝闪退）。
// 这里在 window 上兜住默认行为；真正要处理拖放的组件在自己的元素上监听
// （元素上的监听先执行，不受这里影响）。注意：内嵌的 webview（AI 面板）是独立
// webContents，它内部的拖放（例如把文件拖进对话框当附件）不受这里影响。
window.addEventListener('dragover', (e) => { e.preventDefault(); }, false);
window.addEventListener('drop', (e) => { e.preventDefault(); }, false);
function applyBadges() {
  document.querySelectorAll('.panel-badge').forEach(b => b.style.display = badgesOn ? '' : 'none');
  const btn = document.getElementById('sf-badges');
  if (btn) btn.textContent = '序号：' + (badgesOn ? '开' : '关');
}

// ---------- 左上角品牌区：悬停版本卡 ----------
// 实现在 renderers.js 的 decorateBrand()：放那边是因为它**可热更新**（点 ⟳ 就生效），
// 不必为了改版本卡重启 GUI；这里不再重复实现，避免两处同时写同一块 DOM。


// ---------- 热更新：带时间戳重载 styles.css + 板块数据 + renderers.js（不重载页面 → webview 对话保持） ----------
function hotReloadRenderers() {
  // 样式表同样带时间戳刷新，让 styles.css 改动热生效
  try {
    const css = document.querySelector('link[href*="styles.css"]');
    if (css) css.href = './styles.css?t=' + Date.now();
  } catch (e) { /* ignore */ }
  // 板块数据（sector-data.js / us-sector-data.js）也热重载：
  // 两文件已改 var 声明，重复加载不报错；renderers.js 在其后执行，能读到新数据
  try {
    ['sector-data.js', 'us-sector-data.js'].forEach(name => {
      const old = document.querySelector('script[data-hr="' + name + '"]');
      if (old) old.remove();
      const s = document.createElement('script');
      s.src = './' + name + '?t=' + Date.now();
      s.dataset.hr = name;
      document.head.appendChild(s);
    });
  } catch (e) { /* ignore */ }
  return new Promise((resolve) => {
    const old = document.getElementById('renderers-script');
    if (old) old.remove();
    const s = document.createElement('script');
    s.id = 'renderers-script';
    s.src = './renderers.js?t=' + Date.now();   // 缓存击穿：强制重新拉取
    s.onload = () => resolve(true);
    s.onerror = () => { setStatus('渲染器热更新失败，请重启 GUI', true); resolve(false); };
    document.head.appendChild(s);
  });
}

// 刷新按钮：热更新渲染器 + 重建当前场景（重新读取 scenarios/*.json）
async function reloadScene() {
  setStatus('正在热更新渲染器…', true);
  const ok = await hotReloadRenderers();
  if (!ok) return;
  if (currentTab && currentTab !== 'harness') {
    await loadScenario(currentTab);
    setStatus('已刷新：' + currentTab, false);
  } else {
    setStatus('渲染器已热更新（Harness 场景无需重建）', false);
  }
}

// ---------- 插件 / 模型 弹窗 ----------
function openModal(title, bodyBuilder) {
  const mask = document.getElementById('modal-mask');
  const titleEl = document.getElementById('modal-title');
  const body = document.getElementById('modal-body');
  titleEl.textContent = title;
  // ⚠ 必须重置类名与滚动位置：所有弹窗共用这一个 #modal-body，各弹窗都是 classList.add(...)，
  //    只清 innerHTML 会让 set-modal-body / sk-body 一路累积 → 下一个弹窗被上一条样式误伤
  //    （技能弹窗的加宽规则就曾因此波及插件/模型弹窗）
  body.className = 'modal-body';
  body.scrollTop = 0;
  body.innerHTML = '';
  try { bodyBuilder(body); } catch (e) {
    body.appendChild(mkEl('div', 'stat-sub', '加载失败: ' + e.message));
  }
  mask.style.display = 'flex';
}
function closeModal() {
  document.getElementById('modal-mask').style.display = 'none';
}

async function showPlugins() {
  openModal('已安装插件', async (body) => {
    body.appendChild(mkEl('div', 'stat-sub', '正在读取插件目录…'));
    try {
      const r = await window.app.plugins.list();
      body.innerHTML = '';
      // 数据位置说明（核心原则：全部在项目文件夹，不落 C 盘）
      const info = mkEl('div', 'modal-note');
      info.appendChild(mkEl('div', 'modal-note-line', '📁 插件目录：' + r.pluginsDir));
      info.appendChild(mkEl('div', 'modal-note-line', '📁 dsh 数据目录：' + r.dataDir + '（项目文件夹，未使用 C 盘）'));
      body.appendChild(info);
      if (!r.plugins.length) {
        body.appendChild(mkEl('div', 'stat-sub', '插件目录下暂无自定义插件。'));
      }
      r.plugins.forEach(p => {
        const card = mkEl('div', 'plg-card');
        const top = mkEl('div', 'plg-top');
        top.appendChild(mkEl('span', 'plg-name', p.displayName || p.name));
        top.appendChild(mkEl('span', 'tag ok', 'v' + (p.version || '?')));
        card.appendChild(top);
        card.appendChild(mkEl('div', 'plg-desc', p.description || '(无描述)'));
        card.appendChild(mkEl('div', 'plg-path', p.path));
        // 插件自己的数据/配置目录（若存在，一并展示，强调本地化）
        if (p.cacheDir) card.appendChild(mkEl('div', 'plg-path', '🗄 数据缓存：' + p.cacheDir));
        if (p.configDir) card.appendChild(mkEl('div', 'plg-path', '⚙️ 配置：' + p.configDir));
        body.appendChild(card);
      });
      if (r.builtinCount != null) {
        body.appendChild(mkEl('div', 'stat-sub', '内置插件包 ' + r.builtinCount + ' 个（' + r.builtinDir + '），由 dsh 框架自带。'));
      }
    } catch (e) {
      body.innerHTML = '';
      body.appendChild(mkEl('div', 'stat-sub', '读取失败: ' + (e && e.message || e)));
    }
  });
}

// ---------- 技能弹窗：列出 DSH 技能目录（.dsh\skills） ----------
// 技能图标 = DSH 原生 skill 图标（说明书 + 闪光），与标题栏按钮保持一致
function skillSvg(size) {
  const s = size || 16;
  return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">'
    + '<path d="M12.5113 15.4067C12.4395 15.6249 12.1308 15.6249 12.059 15.4067L11.643 14.1416C11.454 13.567 11.0033 13.1164 10.4288 12.9274L9.16369 12.5113C8.94544 12.4395 8.94544 12.1308 9.16369 12.059L10.4288 11.643C11.0033 11.454 11.454 11.0033 11.643 10.4288L12.059 9.16369C12.1308 8.94544 12.4395 8.94544 12.5113 9.16369L12.9274 10.4288C13.1164 11.0033 13.567 11.454 14.1416 11.643L15.4067 12.059C15.6249 12.1308 15.6249 12.4395 15.4067 12.5113L14.1416 12.9274C13.567 13.1164 13.1164 13.567 12.9274 14.1416L12.5113 15.4067Z" fill="currentColor"/>'
    + '<path d="M9.02246 0.546878C9.9822 0.546878 10.7564 0.545403 11.374 0.612307C12.0042 0.680586 12.5515 0.826244 13.0273 1.17188C13.3052 1.37376 13.5501 1.61868 13.752 1.89649C14.0975 2.37225 14.2432 2.91984 14.3115 3.54981C14.3784 4.16727 14.377 4.94206 14.377 5.90137V8.51367C13.9611 8.29533 13.5071 8.13985 13.0273 8.06055V5.90137C13.0273 4.9121 13.0259 4.22322 12.9688 3.69532C12.9129 3.18044 12.8098 2.89782 12.6592 2.69043C12.5406 2.52724 12.3966 2.38326 12.2334 2.26465C12.026 2.11404 11.7437 2.0109 11.2285 1.95508C10.7005 1.89789 10.0122 1.89649 9.02246 1.89649H6.55371C5.56395 1.89649 4.87569 1.89787 4.34766 1.95508C3.83242 2.01092 3.55022 2.11398 3.34278 2.26465C3.17953 2.38329 3.03564 2.52719 2.91699 2.69043C2.76642 2.89782 2.66325 3.18042 2.60742 3.69532C2.55027 4.22322 2.54883 4.9121 2.54883 5.90137V10.0986C2.54883 11.0878 2.55031 11.7768 2.60742 12.3047C2.66326 12.8196 2.76642 13.1032 2.91699 13.3105C3.03558 13.4736 3.17966 13.6178 3.34278 13.7363C3.5502 13.8869 3.83265 13.9901 4.34766 14.0459C4.87568 14.1031 5.56398 14.1035 6.55371 14.1035H8.08399C8.27443 14.6025 8.55077 15.0585 8.89551 15.4541H6.55371C5.59402 15.4541 4.81976 15.4546 4.20215 15.3877C3.57204 15.3194 3.02468 15.1738 2.54883 14.8281C2.27111 14.6263 2.02606 14.3813 1.82422 14.1035C1.47883 13.6278 1.33293 13.08 1.26465 12.4502C1.19783 11.8327 1.19922 11.0579 1.19922 10.0986V5.90137C1.19922 4.94206 1.1978 4.16727 1.26465 3.54981C1.33295 2.91984 1.47867 2.37225 1.82422 1.89649C2.02613 1.61864 2.27098 1.37379 2.54883 1.17188C3.02472 0.826181 3.57197 0.6806 4.20215 0.612307C4.81976 0.545393 5.594 0.546877 6.55371 0.546878H9.02246ZM9.19629 9.14649H4.5459V7.84571H9.19629V9.14649ZM11.0303 6.10645H4.5459V4.80567H11.0303V6.10645Z" fill="currentColor"/>'
    + '</svg>';
}

async function showSkills() {
  openModal('技能（Skills）', async (body) => {
    body.classList.add('sk-body');
    body.appendChild(mkEl('div', 'stat-sub', '正在扫描技能目录…'));
    try {
      const r = await window.app.skills.list();
      body.innerHTML = '';
      const list = (r.skills || []);

      // 顶部工具条：数量 + 目录（悬停看全路径）+ 操作
      const bar = mkEl('div', 'sk-bar');
      const left = mkEl('div', 'sk-bar-left');
      left.appendChild(mkEl('span', 'sk-count', list.length ? list.length + ' 个技能' : '暂无技能'));
      const dir = mkEl('span', 'sk-dir', r.skillsDir);
      dir.title = r.skillsDir + '\n（引擎自动扫描：放进去即生效，无需重启）';
      left.appendChild(dir);
      bar.appendChild(left);
      const acts = mkEl('div', 'sk-bar-acts');
      const openBtn = mkEl('button', 'sk-btn primary', '📂 打开目录');
      openBtn.title = '在资源管理器打开技能目录';
      openBtn.addEventListener('click', () => window.app.skills.open(r.skillsDir));
      const docBtn = mkEl('button', 'sk-btn', '📖 存放说明');
      docBtn.title = '技能格式 / 字段 / 安装步骤';
      docBtn.addEventListener('click', () => window.app.skills.open(r.skillsDir + '\\_说明'));
      acts.appendChild(openBtn); acts.appendChild(docBtn);
      bar.appendChild(acts);
      body.appendChild(bar);

      // 空态：居中占位 + 引导
      if (!list.length) {
        const empty = mkEl('div', 'sk-empty');
        const ico = mkEl('div', 'sk-empty-ico');
        ico.innerHTML = skillSvg(38);
        empty.appendChild(ico);
        empty.appendChild(mkEl('div', 'sk-empty-t', '还没有技能'));
        empty.appendChild(mkEl('div', 'sk-empty-d',
          '把技能文件夹（内含 SKILL.md，frontmatter 至少要有 name 与 description）放进上面的目录即可——无需重启，放进来就能用。'));
        const tip = mkEl('div', 'sk-empty-code');
        tip.appendChild(mkEl('span', 'sk-empty-code-l', '格式'));
        tip.appendChild(mkEl('span', 'sk-empty-code-v', '技能名 / SKILL.md   或   技能名.md'));
        empty.appendChild(tip);
        body.appendChild(empty);
        return;
      }

      // 技能列表
      const grid = mkEl('div', 'sk-list');
      list.forEach((s) => {
        const card = mkEl('div', 'sk-card' + (s.valid ? '' : ' bad'));
        const head = mkEl('div', 'sk-head');
        const ico = mkEl('span', 'sk-ico');
        if (s.valid) ico.innerHTML = skillSvg(14); else ico.textContent = '⚠';
        head.appendChild(ico);
        head.appendChild(mkEl('span', 'sk-name', s.name || '(未命名)'));
        head.appendChild(mkEl('span', 'sk-chip', s.format === 'bundle' ? '目录包' : '单文件'));
        head.appendChild(mkEl('span', 'sk-state ' + (s.valid ? 'ok' : 'warn'), s.valid ? '可用' : '配置有误'));
        card.appendChild(head);
        if (s.description) card.appendChild(mkEl('div', 'sk-desc', s.description));
        if (s.whenToUse) {
          const when = mkEl('div', 'sk-when');
          when.appendChild(mkEl('span', 'sk-when-k', '适用'));
          when.appendChild(mkEl('span', 'sk-when-v', s.whenToUse));
          card.appendChild(when);
        }
        if (s.error) card.appendChild(mkEl('div', 'sk-err', s.error));
        const foot = mkEl('div', 'sk-foot');
        const path = mkEl('div', 'sk-path', s.file);
        path.title = s.file;
        foot.appendChild(path);
        const openFile = mkEl('button', 'sk-btn mini', '打开正文');
        openFile.title = '用系统默认编辑器打开 ' + s.file;
        openFile.addEventListener('click', () => window.app.skills.open(s.file));
        foot.appendChild(openFile);
        card.appendChild(foot);
        grid.appendChild(card);
      });
      body.appendChild(grid);
    } catch (e) {
      body.innerHTML = '';
      body.appendChild(mkEl('div', 'stat-sub', '读取失败: ' + (e && e.message || e)));
    }
  });
}

// ---------- 工具面板（2026-10-21）：引擎原有 + 新增工具，位置 + 大白话 ----------
async function showTools() {
  openModal('工具（Tools）', async (body) => {
    body.classList.add('sk-body');
    body.appendChild(mkEl('div', 'stat-sub', '正在读取工具清单…'));
    try {
      const r = await window.app.toolsCatalog();
      body.innerHTML = '';
      const groups = (r && r.groups) || [];
      const countOf = (g) => (g.sections || []).reduce((a, s) => a + ((s.items || []).length), 0) || ((g.items || []).length);
      const total = groups.reduce((a, g) => a + countOf(g), 0);
      const bar = mkEl('div', 'sk-bar');
      const left = mkEl('div', 'sk-bar-left');
      left.appendChild(mkEl('span', 'sk-count', total + ' 个工具'));
      left.appendChild(mkEl('span', 'sk-dir', '清单：外壳\\data\\工具清单.json' + (r.updated ? ' · ' + r.updated : '') + ' · 一行四个 · 可折叠'));
      bar.appendChild(left);
      const acts = mkEl('div', 'sk-bar-acts');
      const foldAll = mkEl('button', 'sk-btn', '全部收起');
      foldAll.title = '折叠 / 展开两组工具';
      acts.appendChild(foldAll);
      bar.appendChild(acts);
      body.appendChild(bar);
      if (r && r.error) body.appendChild(mkEl('div', 'stat-sub', '读取失败：' + r.error));

      const contents = [];
      groups.forEach((g) => {
        const gbox = mkEl('div');
        gbox.style.marginTop = '10px';
        const gh = mkEl('div', 'stat-sub');
        gh.style.cssText = 'cursor:pointer;user-select:none;padding:7px 8px;border:1px solid rgba(255,255,255,.09);border-radius:8px;';
        const title = (g.title || '') + '（' + countOf(g) + '）' + (g.note ? ' · ' + g.note : '');
        gh.textContent = '▾ ' + title;
        const content = mkEl('div');
        contents.push({ gh, content, title });
        gh.addEventListener('click', () => {
          const open = content.style.display !== 'none';
          content.style.display = open ? 'none' : '';
          gh.textContent = (open ? '▸ ' : '▾ ') + title;
        });
        (g.sections && g.sections.length ? g.sections : [{ title: '', items: g.items || [] }]).forEach((sec) => {
          if (sec.title) {
            const sh = mkEl('div', 'stat-sub');
            sh.style.cssText = 'margin:9px 0 3px;opacity:.78;';
            sh.textContent = sec.title;
            content.appendChild(sh);
          }
          const grid = mkEl('div', 'sk-list');
          // 2026-10-21 宿主：一行四个；组内再按用途分块。
          grid.style.cssText = 'display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;align-items:stretch;';
          (sec.items || []).forEach((it) => {
            const card = mkEl('div', 'sk-card');
            card.style.minWidth = '0';
            const h = mkEl('div', 'sk-head');
            h.appendChild(mkEl('span', 'sk-name', it.name || ''));
            h.appendChild(mkEl('span', 'sk-chip', it.tag || ''));
            card.appendChild(h);
            card.appendChild(mkEl('div', 'sk-desc', it.plain || ''));
            if (it.how) {
              const how = mkEl('div', 'sk-when');
              how.appendChild(mkEl('span', 'sk-when-k', '生效'));
              how.appendChild(mkEl('span', 'sk-when-v', it.how));
              card.appendChild(how);
            }
            const path = mkEl('div', 'sk-path', it.where || '');
            path.title = it.where || '';
            card.appendChild(path);
            grid.appendChild(card);
          });
          content.appendChild(grid);
        });
        gbox.appendChild(gh);
        gbox.appendChild(content);
        body.appendChild(gbox);
      });
      let allFolded = false;
      foldAll.addEventListener('click', () => {
        allFolded = !allFolded;
        contents.forEach(({ gh, content, title }) => {
          content.style.display = allFolded ? 'none' : '';
          gh.textContent = (allFolded ? '▸ ' : '▾ ') + title;
        });
        foldAll.textContent = allFolded ? '全部展开' : '全部收起';
      });
      if (r && r.note) body.appendChild(mkEl('div', 'stat-sub', r.note));
      if (!total) body.appendChild(mkEl('div', 'stat-sub', '（清单为空）'));
    } catch (e) {
      body.innerHTML = '';
      body.appendChild(mkEl('div', 'stat-sub', '读取失败: ' + (e && e.message || e)));
    }
  });
}

// ---------- 手机远程访问：扫码引导（右上角 📱）----------
// 数据来自 dsh-plugin-remote-access 插件的路由，经主进程 IPC 转发（见 preload.js）。
async function showRemoteAccess() {
  if (!window.app || !window.app.remoteAccess) {
    openModal('手机远程访问', (body) => {
      body.appendChild(mkEl('div', 'stat-sub', '该功能需要重启一次工作台才会生效（插件接口尚未加载）。'));
    });
    return;
  }
  openModal('手机远程访问', (body) => {
    body.innerHTML = '';
    const NS = 'rgba(255,255,255,.12)';
    const box = document.createElement('div');
    box.style.cssText = 'max-width:620px;font-size:13.5px;line-height:1.65;';
    body.appendChild(box);

    const statusBox = document.createElement('div');
    statusBox.style.cssText = 'padding:10px 12px;border:1px solid ' + NS + ';border-radius:10px;';
    statusBox.textContent = '正在读取隧道状态…';
    box.appendChild(statusBox);

    const addrBox = document.createElement('div');
    addrBox.style.cssText = 'margin:10px 0 4px;padding:9px 10px;border:1px solid ' + NS + ';border-radius:8px;'
      + 'font:12px/1.5 ui-monospace,Consolas,monospace;word-break:break-all;opacity:.85;display:none;';
    box.appendChild(addrBox);

    const actions = document.createElement('div');
    actions.style.cssText = 'margin:10px 0 4px;display:flex;gap:8px;flex-wrap:wrap;';
    box.appendChild(actions);

    const steps = document.createElement('div');
    box.appendChild(steps);

    const tip = document.createElement('div');
    tip.style.cssText = 'margin-top:10px;opacity:.6;font-size:12.5px;line-height:1.7;';
    tip.textContent = '隧道断了会自动重连；DSH 重启后令牌会变，点「刷新二维码」拿最新的即可。';
    box.appendChild(tip);

    function mkBtn(label, fn) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.style.cssText = 'padding:7px 14px;border-radius:9px;border:1px solid ' + NS + ';'
        + 'background:rgba(255,255,255,.05);color:inherit;cursor:pointer;font-size:13px;';
      b.addEventListener('click', fn);
      return b;
    }

    /** 一个「图片步骤」块：序号 + 标题 + 说明 + 可选图片。 */
    function addStep(n, title, desc, imgUrl) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:12px;align-items:flex-start;padding:12px 0;border-top:1px solid ' + NS + ';margin-top:8px;';
      const num = document.createElement('div');
      num.textContent = String(n);
      num.style.cssText = 'flex:0 0 24px;height:24px;line-height:24px;text-align:center;border-radius:50%;'
        + 'background:rgba(120,170,255,.18);color:#8ab4ff;font-size:12.5px;';
      const main = document.createElement('div');
      main.style.cssText = 'flex:1 1 auto;min-width:0;';
      const t = document.createElement('div');
      t.textContent = title;
      t.style.cssText = 'font-weight:600;margin-bottom:2px;';
      const d = document.createElement('div');
      d.textContent = desc;
      d.style.cssText = 'opacity:.72;font-size:12.5px;';
      main.appendChild(t);
      main.appendChild(d);
      if (imgUrl) {
        const img = document.createElement('img');
        img.src = imgUrl;
        img.alt = '步骤 ' + n + ' 配图';
        img.style.cssText = 'display:block;width:176px;margin-top:9px;background:#fff;padding:7px;border-radius:9px;';
        main.appendChild(img);
      } else {
        const ph = document.createElement('div');
        ph.textContent = '（此步无需扫码）';
        ph.style.cssText = 'margin-top:8px;opacity:.45;font-size:12px;';
        main.appendChild(ph);
      }
      row.appendChild(num);
      row.appendChild(main);
      return row;
    }

    let currentUrl = '';

    async function render() {
      steps.innerHTML = '';
      addrBox.style.display = 'none';
      const s = await window.app.remoteAccess.status().catch(() => null);
      if (!s || s.ok === false) {
        statusBox.textContent = '读取失败：' + ((s && s.error) || '插件未响应');
        return;
      }
      const t = s.tunnel || {};
      const stateText = t.healthy ? '✅ 已连通' : (t.ssh ? '⏳ 连接中…' : '❌ 未连接');
      const keeperText = t.keeper ? '运行中' : '未运行';
      statusBox.textContent = '隧道守护：' + keeperText + '　|　隧道连接：' + stateText
        + '　|　中转服务器：' + (s.server && s.server.host ? s.server.host : '—');
      currentUrl = (s.access && s.access.url) || '';
      if (currentUrl) {
        addrBox.textContent = currentUrl;
        addrBox.style.display = 'block';
      }

      let wgImg = '';
      let qrImg = '';
      try { wgImg = await window.app.remoteAccess.guideImage(); } catch (e) { /* 忽略 */ }
      try { qrImg = await window.app.remoteAccess.qr(); } catch (e) { /* 忽略 */ }

      steps.appendChild(addStep(1, '手机装好 WireGuard，扫码导入隧道',
        '打开 WireGuard App → 右下角「+」→ 扫描二维码，扫下面这张。这是本机专用配置，只让 <内网IP>/24 的流量走隧道，不影响手机其它上网。', wgImg));
      steps.appendChild(addStep(2, '打开隧道开关，再扫这张打开 DSH',
        '二维码里带着当前登录令牌，第一次必须用它扫（之后长期免登录，Cookie 10 年，直接访问 ' + ((s.access && s.access.plainUrl) || 'http://<内网IP>:13080') + ' 即可）。', qrImg));
      steps.appendChild(addStep(3, '建议「添加到主屏幕」',
        '手机浏览器菜单 → 添加到主屏幕；之后像 App 一样一点就开，还能直接让我操作这台电脑。', ''));
    }

    actions.appendChild(mkBtn('复制访问地址', () => {
      const u = currentUrl;
      if (!u) { tip.textContent = '暂时没有拿到访问地址（DSH 可能刚启动）。'; return; }
      navigator.clipboard.writeText(u).then(
        () => { tip.textContent = '✅ 访问地址已复制到剪贴板'; },
        () => { tip.textContent = '复制失败，请长按上方地址手动复制'; });
    }));
    actions.appendChild(mkBtn('刷新二维码', async () => {
      tip.textContent = '正在按最新令牌重新生成二维码…';
      const r = await window.app.remoteAccess.action('refresh').catch(() => null);
      tip.textContent = (r && r.ok) ? '✅ 二维码已按最新令牌刷新' : '刷新失败：' + ((r && r.error) || '插件未响应');
      render();
    }));
    actions.appendChild(mkBtn('重启隧道', async () => {
      tip.textContent = '正在重启隧道…';
      const r = await window.app.remoteAccess.action('restart').catch(() => null);
      if (!r || !r.ok) {
        tip.textContent = '重启失败：' + ((r && r.error) || '插件未响应');
        return;
      }
      // 硬断开后服务器最长约 45 秒才回收旧会话，这里轮询到真正恢复为止（最多 60 秒）
      tip.textContent = '⏳ 已断开，守护进程正在重连…';
      render();
      const t0 = Date.now();
      const timer = setInterval(async () => {
        const sec = Math.round((Date.now() - t0) / 1000);
        const s = await window.app.remoteAccess.status().catch(() => null);
        if (s && s.tunnel && s.tunnel.healthy) {
          clearInterval(timer);
          tip.textContent = '✅ 隧道已恢复（用时 ' + sec + ' 秒）';
          render();
        } else if (sec >= 60) {
          clearInterval(timer);
          tip.textContent = '⚠️ 已等 60 秒仍未恢复，请点「刷新二维码」再看状态；仍不通就重启工作台。';
        } else {
          tip.textContent = '⏳ 正在重连…已等 ' + sec + ' 秒（服务器回收旧会话最长约 45 秒，属正常）';
        }
      }, 3000);
    }));

    render();
  });
}

// ---------- 设置弹窗：内嵌 Harness 原生设置（通用 / 模型 / 插件） ----------
async function showSettings() {
  openModal('设置', (body) => {
    // 设置面板需要更宽的空间
    const mask = document.getElementById('modal-mask');
    const modal = mask ? mask.querySelector('.modal') : null;
    if (modal) modal.classList.add('set-modal');
    body.classList.add('set-modal-body');
    const msg = mkEl('div', 'stat-sub', '正在打开 Harness 原生设置…');
    body.appendChild(msg);
    const load = async () => {
      try {
        const url = await window.app.getHarnessUrl();
        if (!url) { msg.textContent = 'Harness 引擎尚未就绪，请稍后重试。'; return; }
        body.innerHTML = '';
        const wv = document.createElement('webview');
        wv.className = 'set-wv';
        wv.setAttribute('partition', 'persist:harness');   // 与主界面同一会话
        wv.setAttribute('src', url);
        body.appendChild(wv);
        // 注入：先隐藏整页首帧（避免闪现 Harness 主界面），打开原生设置面板并撑满整个视口后显示
        const INJECT = `(() => {
          try {
            const root = document.documentElement;
            const show = () => { try { root.style.removeProperty('opacity'); } catch (e) { /* ignore */ } };
            // 触发按钮：0.2.1-alpha.4 起 aria-label 走本地化 t('trigger')，写死的「设置」可能失配
            // ⇒ 三级退化：精确 label → 标签含"设置/Settings/偏好"的 → 任意 aria-haspopup=dialog 的按钮
            const pickTrigger = () => {
              const exact = document.querySelector('button[aria-haspopup="dialog"][aria-label="设置"]')
                || document.querySelector('button[aria-haspopup="dialog"][aria-label="Settings"]');
              if (exact) return exact;
              const all = Array.prototype.slice.call(document.querySelectorAll('button[aria-haspopup="dialog"]'));
              const hit = all.filter((b) => /设置|settings|偏好|preferences/i.test(
                (b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '')));
              return hit[0] || all[0] || null;
            };
            const btn = pickTrigger();
            if (btn && btn.getAttribute('aria-expanded') !== 'true') { try { btn.click(); } catch (e) { /* ignore */ } }
            // 设置面板：[role=dialog][aria-modal=true]，全视口 overlay 内居中
            const stretch = () => {
              const panel = document.querySelector('[role="dialog"][aria-modal="true"]');
              if (!panel) return false;
              panel.style.setProperty('width', '100vw', 'important');
              panel.style.setProperty('height', '100vh', 'important');
              panel.style.setProperty('max-width', '100vw', 'important');
              panel.style.setProperty('max-height', '100vh', 'important');
              panel.style.setProperty('border-radius', '0', 'important');
              const ov = panel.parentElement;
              if (ov) {
                ov.style.setProperty('align-items', 'stretch', 'important');
                ov.style.setProperty('justify-content', 'stretch', 'important');
                ov.style.setProperty('z-index', '999999', 'important');
              }
              return true;
            };
            if (stretch()) { show(); return true; }   // 面板已在 → 只显示不隐藏
            // 连触发按钮都没找到 ⇒ ⛔ 绝不黑屏：把引擎主界面原样露出来（用户可自己点设置）
            if (!btn) { show(); return false; }
            // 面板未出现：隐藏首帧（用户看不到主界面闪现），轮询直到面板出现再显示
            root.style.setProperty('opacity', '0', 'important');
            // 兜底：1.5s 还没开 ⇒ 试一次 Ctrl+, （引擎设置面板自带的快捷键）
            const shortcut = () => {
              try {
                const ev = { key: ',', code: 'Comma', ctrlKey: true, bubbles: true };
                document.dispatchEvent(new KeyboardEvent('keydown', ev));
                window.dispatchEvent(new KeyboardEvent('keydown', ev));
              } catch (e) { /* ignore */ }
            };
            let n = 0;
            const t = setInterval(() => {
              const ok = stretch();
              if (!ok && n === 10) shortcut();
              if (ok || ++n > 40) { clearInterval(t); show(); }   // 6s 兜底显示，避免永久空白
            }, 150);
            return true;
          } catch (e) { return false; }
        })()`;
        const tryInject = () => {
          try {
            if (wv && wv.executeJavaScript) wv.executeJavaScript(INJECT).catch(() => { /* ignore */ });
          } catch (e) { /* ignore */ }
        };
        wv.addEventListener('dom-ready', tryInject);
        // SPA 渲染侧栏需要时间，轮询注入最多 20 秒
        let tries = 0;
        const timer = setInterval(() => {
          tryInject();
          if (++tries > 20) clearInterval(timer);
        }, 1000);
      } catch (e) {
        body.innerHTML = '';
        body.appendChild(mkEl('div', 'stat-sub', '打开设置失败：' + (e && e.message || e)));
      }
    };
    load();
  });
}

async function showModels() {
  openModal('模型与提供方', async (body) => {
    body.appendChild(mkEl('div', 'stat-sub', '正在读取模型配置…'));
    try {
      const r = await window.app.models.list();
      body.innerHTML = '';
      const info = mkEl('div', 'modal-note');
      info.appendChild(mkEl('div', 'modal-note-line', '📁 配置存储：' + r.settingsPath + '（项目文件夹，未落 C 盘）'));
      body.appendChild(info);
      // 当前默认模型
      const def = mkEl('div', 'mdl-default');
      def.appendChild(mkEl('div', 'mdl-def-label', '当前默认模型'));
      def.appendChild(mkEl('div', 'mdl-def-val',
        (r.default && r.default.model || '—') + (r.default && r.default.provider ? '  @ ' + r.default.provider : '')));
      body.appendChild(def);
      if (!r.providers.length) body.appendChild(mkEl('div', 'stat-sub', '未发现自定义提供方（内置 deepseek-official 始终可用）。'));
      r.providers.forEach(p => {
        const card = mkEl('div', 'mdl-card');
        const top = mkEl('div', 'plg-top');
        top.appendChild(mkEl('span', 'plg-name', p.displayName || p.id));
        top.appendChild(mkEl('span', 'tag ' + (p.apiKeySet ? 'ok' : 'warn'),
          p.apiKeySet ? '密钥已配置' : '密钥未设置'));
        card.appendChild(top);
        const meta = mkEl('div', 'mdl-meta');
        meta.appendChild(mkEl('div', 'mdl-meta-line', '提供方 ID：' + p.id));
        if (p.baseURL) meta.appendChild(mkEl('div', 'mdl-meta-line', 'BaseURL：' + p.baseURL));
        if (p.apiKeyEnv) meta.appendChild(mkEl('div', 'mdl-meta-line', '密钥环境变量：' + p.apiKeyEnv));
        meta.appendChild(mkEl('div', 'mdl-meta-line', '模型数量：' + p.models.length));
        card.appendChild(meta);
        const chips = mkEl('div', 'mdl-chips');
        (p.models || []).slice(0, 15).forEach(m => chips.appendChild(mkEl('span', 'mdl-chip', m)));
        if (p.models.length > 15) chips.appendChild(mkEl('span', 'mdl-chip dim', '…共 ' + p.models.length + ' 个'));
        card.appendChild(chips);
        body.appendChild(card);
      });
    } catch (e) {
      body.innerHTML = '';
      body.appendChild(mkEl('div', 'stat-sub', '读取失败: ' + (e && e.message || e)));
    }
  });
}

// ---------- 自定义标题栏：窗口控制 + 刷新 + 插件/模型 ----------
function initTitlebar() {
  document.getElementById('btn-refresh').addEventListener('click', reloadScene);

// 外部刷新通道（main.js 的 data/reload-panels.cmd）用：把热更新挂成全局钩子，
// 主进程 executeJavaScript 万一够不到闭包里的名字，还能走这个。
window.__dshReloadScene = reloadScene;
  // 2026-10-16：给顶栏状态区一个"跳到某个场景"的入口（用户：「待办点击要跳转才行 不然我也不知道在哪」）。
  // 复用渲染层自己的 currentTab + loadScenario（不新造机制）；找不到就返回 false，调用方会退化成"打开出处文件"。
  window.__dshGotoScene = function (id) {
    try {
      if (!id) return false;
      currentTab = id;
      Promise.resolve(loadScenario(id)).catch(function () { /* ignore */ });
      return true;
    } catch (e) { return false; }
  };
  const btnRemote = document.getElementById('btn-remote');
  if (btnRemote) btnRemote.addEventListener('click', showRemoteAccess);
  // 2026-10-16 用户要求删掉顶栏「设置」按钮（改从主界面进设置，那个弹窗"一直跳来跳去"）
  // ⇒ 这里**必须判空**：元素不存在时直接 addEventListener 会抛错，把后面所有按钮的绑定一起带崩。
  const bsBtn = document.getElementById('btn-settings');
  if (bsBtn) bsBtn.addEventListener('click', showSettings);
  document.getElementById('btn-plugins').addEventListener('click', showPlugins);
  document.getElementById('btn-skills').addEventListener('click', showSkills);
  document.getElementById('btn-tools').addEventListener('click', showTools);
  document.getElementById('btn-models').addEventListener('click', showModels);
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-mask').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });
  document.getElementById('btn-min').addEventListener('click', () => window.app.minimize());
  const btnMax = document.getElementById('btn-max');
  btnMax.addEventListener('click', async () => {
    const max = await window.app.toggleMaximize();
    btnMax.textContent = max ? '❐' : '□';
  });
  document.getElementById('btn-close').addEventListener('click', () => window.app.close());
  // 窗口最大化状态变化时更新图标
  window.addEventListener('resize', async () => {
    const max = await window.app.isMaximized();
    btnMax.textContent = max ? '❐' : '□';
  });
}

function setStatus(text, busy) {
  document.getElementById('status-text').textContent = text;
  document.getElementById('status-dot').className = 'status-dot' + (busy ? ' busy' : '');
}

// ---------- 外观切换：深色 / 浅色 / 跟随系统（同 DSH 自带设置的三档） ----------
const THEME_KEY = 'guiTheme';
function currentThemeMode() {
  const v = localStorage.getItem(THEME_KEY);
  return (v === 'light' || v === 'system') ? v : 'dark';
}
function applyTheme(mode) {
  const light = window.matchMedia('(prefers-color-scheme: light)').matches;
  const resolved = mode === 'system' ? (light ? 'light' : 'dark') : mode;
  document.documentElement.dataset.theme = resolved;
  const btn = document.getElementById('btn-theme');
  if (btn) {
    btn.textContent = resolved === 'light' ? '☀️' : '🌙';
    btn.title = '外观：' + (mode === 'system' ? '跟随系统' : (mode === 'dark' ? '深色' : '浅色'))
      + '（当前 ' + (resolved === 'light' ? '浅色' : '深色') + '）';
  }
  // 同步窗口底色，避免浅色下缩放/重绘闪黑
  try {
    if (window.app.theme && window.app.theme.setWindowBg) {
      window.app.theme.setWindowBg(resolved === 'light' ? '#f5f7fa' : '#0b0d12');
    }
  } catch (e) { /* ignore */ }
}
function initTheme() {
  const btn = document.getElementById('btn-theme');
  if (!btn) return;
  let menu = null;
  function closeMenu() {
    if (menu) { menu.remove(); menu = null; document.removeEventListener('click', onDoc, true); }
  }
  function onDoc(e) { if (menu && !menu.contains(e.target) && e.target !== btn) closeMenu(); }
  const openMenu = () => {
    closeMenu();
    menu = mkEl('div', 'theme-menu');
    [['dark', '🌙', '深色'], ['light', '☀️', '浅色'], ['system', '🌗', '跟随系统']].forEach((it) => {
      const b = mkEl('button', 'theme-item' + (currentThemeMode() === it[0] ? ' on' : ''));
      b.appendChild(mkEl('span', 'theme-item-ico', it[1]));
      b.appendChild(mkEl('span', 'theme-item-txt', it[2]));
      b.addEventListener('click', () => {
        localStorage.setItem(THEME_KEY, it[0]);
        applyTheme(it[0]);
        closeMenu();
      });
      menu.appendChild(b);
    });
    document.body.appendChild(menu);
    const r = btn.getBoundingClientRect();
    menu.style.top = (r.bottom + 5) + 'px';
    menu.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
    setTimeout(() => document.addEventListener('click', onDoc, true), 0);
  };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu) closeMenu(); else openMenu();
  });
  // 跟随系统：系统深浅色切换时实时生效
  const mq = window.matchMedia('(prefers-color-scheme: light)');
  const onSys = () => { if (currentThemeMode() === 'system') applyTheme('system'); };
  if (mq.addEventListener) mq.addEventListener('change', onSys);
  else if (mq.addListener) mq.addListener(onSys);
  applyTheme(currentThemeMode());
}

// ---------- 余额实时显示（DeepSeek 平台；密钥只在主进程，渲染层只拿数值） ----------
// 显示在场景栏状态点旁（标题栏那份已按需求移除）
function initBalance() {
  const chips = Array.from(document.querySelectorAll('.balance-chip'));
  if (!chips.length || !window.app.balance) return;
  const paint = (v) => {
    chips.forEach((chip) => {
      chip.classList.remove('ok', 'low', 'err');
      if (!v) { chip.textContent = '¥ …'; chip.title = 'DeepSeek 余额 · 加载中'; return; }
      if (v.ok) {
        const sym = v.currency === 'CNY' ? '¥' : (v.currency === 'USD' ? '$' : (v.currency || '') + ' ');
        chip.textContent = sym + v.total;
        chip.classList.add('ok');
        if (Number(v.total) <= 5) chip.classList.add('low');
        chip.title = 'DeepSeek 余额 ' + sym + v.total + '（充值 ' + v.toppedUp + ' · 赠送 ' + v.granted + '）'
          + (v.isAvailable ? '' : '\n⚠ 账户余额不足')
          + '\n点击打开用量页';
      } else {
        chip.textContent = '¥ --';
        chip.classList.add('err');
        chip.title = '余额获取失败：' + (v.err || '未知错误') + '\n点击打开用量页';
      }
    });
  };
  const onClick = () => {
    window.app.balance.open();
    Promise.resolve(window.app.balance.refresh()).then(paint).catch(() => { /* ignore */ });
  };
  chips.forEach((chip) => chip.addEventListener('click', onClick));
  if (window.app.balance.onUpdate) window.app.balance.onUpdate(paint);
  Promise.resolve(window.app.balance.get()).then(paint).catch(() => paint(null));
}

function showView(name) {
  harnessView.classList.toggle('active', name === 'harness');
  scenarioView.classList.toggle('active', name === 'scenario');
}

// 场景 0：加载 Harness（带 token）
// 注意：引擎未就绪时不再直接返回空界面——保留加载页进度条，
// 引擎就绪后由 onHarnessReady 自动触发加载（原来必须手动点一次标签才会加载）。
async function loadHarness() {
  const ready = await window.app.isHarnessReady();
  if (!ready) {
    setStatus('引擎启动中…', true);
    return;
  }
  const url = await window.app.getHarnessUrl();
  if (webview.getAttribute('src') !== url) {
    webview.setAttribute('src', url);
    setStatus('加载界面…', true);
    if (window.__bootPaint) window.__bootPaint({ stage: 'ui', pct: 94, text: '界面渲染中…', detail: 'Harness 前端正在渲染' });
    watchHarnessReady();          // 轮询等待 SPA 真正渲染（did-finish-load 太早）
  } else {
    setStatus('Harness 已连接', false);
    if (window.__bootFinish) window.__bootFinish();
  }
}

// 轮询 webview 内部：#root 渲染出真实 UI 才算加载完成（文档 did-finish-load 早于 SPA 渲染）
let harnessWatchTimer = null;
function watchHarnessReady() {
  if (harnessWatchTimer) return;
  const started = Date.now();
  let pct = 94;
  const PROBE = `(() => {
    try {
      const root = document.getElementById('root');
      if (!root || root.children.length === 0) return false;
      if (document.querySelector('[data-side="sidebar"]') || document.querySelector('[data-chat-flow]') || document.querySelector('[data-phase]')) return true;
      const txt = (root.innerText || '').trim();
      return txt.length > 20;
    } catch (e) { return false; }
  })()`;
  harnessWatchTimer = setInterval(async () => {
    const elapsed = Date.now() - started;
    let ok = false;
    try { ok = await webview.executeJavaScript(PROBE); } catch (e) { ok = false; }
    if (ok) {
      clearInterval(harnessWatchTimer);
      harnessWatchTimer = null;
      setStatus('Harness 已连接', false);
      if (window.__bootFinish) window.__bootFinish();
      return;
    }
    // 进度条继续爬（94 → 99），让等待有感；12 秒兜底直接进入，避免一直卡在加载页
    if (pct < 99) {
      pct = Math.min(99, pct + 1);
      if (window.__bootPaint) window.__bootPaint({ stage: 'ui', pct: pct, text: '界面渲染中…', detail: '已等待 ' + Math.round(elapsed / 1000) + 's（可点「立即进入」）' });
    }
    if (elapsed > 12000) {
      clearInterval(harnessWatchTimer);
      harnessWatchTimer = null;
      if (window.__bootFinish) window.__bootFinish();
    }
  }, 400);
}

// 立即进入：重设 src 强制重新加载 + 立刻收起加载页（等同"切走再切回来"）
async function forceEnterHarness() {
  try {
    if (harnessWatchTimer) { clearInterval(harnessWatchTimer); harnessWatchTimer = null; }
    setStatus('Harness 已连接', false);
    if (window.__bootFinish) window.__bootFinish();
    const url = await window.app.getHarnessUrl();
    if (url) webview.setAttribute('src', url);
  } catch (e) { /* ignore */ }
}

// ---------- 启动加载页：引擎启动进度（分阶段 + 炫酷进度条 + 失败可重试） ----------
function initBoot() {
  const overlay = document.getElementById('boot-overlay');
  if (!overlay) return;
  const bar = document.getElementById('boot-bar-in');
  const stage = document.getElementById('boot-stage');
  const pctEl = document.getElementById('boot-pct');
  const detail = document.getElementById('boot-detail');
  const retry = document.getElementById('boot-retry');
  const refresh = document.getElementById('boot-refresh');
  let curPct = 0;

  const paint = (v) => {
    if (!v) return;
    overlay.classList.toggle('err', v.stage === 'error');
    if (typeof v.pct === 'number' && v.pct > curPct) {
      curPct = v.pct;
      bar.style.width = curPct + '%';
      pctEl.textContent = curPct + '%';
    }
    if (v.text) stage.textContent = v.text;
    if (v.detail) detail.textContent = v.detail;
    retry.style.display = (v.stage === 'error') ? '' : 'none';
  };
  window.__bootPaint = paint;
  // 引擎/界面就绪 → 100% 并淡出
  window.__bootFinish = () => {
    curPct = 100;
    bar.style.width = '100%';
    pctEl.textContent = '100%';
    stage.textContent = '已就绪';
    overlay.classList.add('hide');
  };

  if (window.app.onBootProgress) window.app.onBootProgress(paint);
  if (window.app.bootState) Promise.resolve(window.app.bootState()).then(paint).catch(() => { /* ignore */ });

  // 「⟳ 立即进入」：任何阶段都能点，点了马上进入界面
  if (refresh) refresh.addEventListener('click', forceEnterHarness);

  retry.addEventListener('click', () => {
    overlay.classList.remove('err');
    retry.style.display = 'none';
    stage.textContent = '正在重试启动…';
    detail.textContent = '—';
    Promise.resolve(window.app.bootRetry()).catch(() => { /* ignore */ });
  });
}

// 场景 1..N：渲染本地场景
// 场景隔离：每次切换场景时，先销毁上一个场景所有面板的后台任务（定时器/网络预载/扫描），
// 再渲染新场景；面板渲染函数可返回 cleanup 函数，由这里统一调用。
let activeCleanups = [];
// ---- 多窗口（场景分离）状态 ----
// 本窗口是不是「场景分离窗口」：主进程 loadFile 时带了 ?solo=1&scene=<id>
const soloSceneId = (function () {
  try {
    const q = new URLSearchParams(location.search);
    return q.get('solo') ? String(q.get('scene') || '') : '';
  } catch (e) { return ''; }
})();
if (soloSceneId) { try { document.body.classList.add('solo'); } catch (e) { /* ignore */ } }
let detachedScenes = new Set();  // 已在独立窗口里跑的场景（主窗口据此不再重复渲染一份）
let forceLocalScene = '';        // 用户点了「仍在此显示」的场景（临时解除上面的限制）
let placeholderSceneId = '';     // 当前正显示「占位卡」的场景（那个独立窗口一关就自动恢复真身）

// 「这个场景正在独立窗口里显示」占位卡：给两条出路，避免用户以为界面坏了
function detachedCard(sc) {
  const card = mkEl('div', 'detach-card');
  card.appendChild(mkEl('div', 'detach-card-ico', '⧉'));
  card.appendChild(mkEl('div', 'detach-card-title', (sc && sc.name) || '该场景'));
  card.appendChild(mkEl('div', 'detach-card-sub', '这个场景正在独立窗口里显示（多屏分开看的工作方式）。关掉那个窗口，它就会回到这里。'));
  const row = mkEl('div', 'detach-card-row');
  const b1 = mkEl('button', 'detach-btn primary', '切到那个窗口');
  b1.addEventListener('click', () => { try { window.app.win.openScene(sc.id); } catch (e) { /* ignore */ } });
  const b2 = mkEl('button', 'detach-btn', '仍在此显示');
  b2.addEventListener('click', () => {
    forceLocalScene = sc.id;
    loadScenario(sc.id).catch(err => bootFail('原地显示场景', err));
  });
  row.appendChild(b1);
  row.appendChild(b2);
  card.appendChild(row);
  return card;
}

async function loadScenario(id) {
  activeCleanups.forEach(fn => { try { fn(); } catch (e) { /* ignore */ } });
  activeCleanups = [];
  const sc = await window.app.getScenario(id);
  if (!sc) return;
  // 场景可自定网格列数（`cols`，默认 4 = styles.css 里 #grid 的列数）。放在前面算，是因为下面"独立窗口占位卡"
  // 那条分支会提前 return —— 列数得跟当前场景一致，不能留着上个场景的（占位卡自己写了 grid-column:1/-1，不受影响）。
  // 平时用不到；需要"某个窗口占五分之三 / 五分之二"这种比例时才写（例：20 列 ⇒ 12/20 = 3/5、8/20 = 2/5，
  // 而原来的 3:1 可以用 15+5 原样保持）。列数 = 4 时清空内联样式，还原 CSS 默认。
  // 兜底：面板坐标要是伸到 cols 之外，隐式列是 auto（按内容宽）不是 1fr ⇒ 比例会整个乱掉
  //（2026-09-20 用户就撞上过：json 用 20 列坐标、渲染器还是旧的，左下被撑到 74%）。所以直接按需要的列数渲染并告警。
  const wantCols = Math.round(Number(sc.cols)) || 4;
  const needCols = (sc.panels || []).reduce(function (m, p) {
    return Math.max(m, (Number(p.col) || 1) + (Number(p.w) || 2) - 1);
  }, 0);
  const gridCols = Math.max(wantCols, needCols);
  if (needCols > wantCols) {
    console.warn('[grid] 场景 ' + sc.id + ' 的面板坐标到第 ' + needCols + ' 列，超过声明的 cols=' + wantCols
      + '（隐式列会按内容宽排、比例全乱）⇒ 已按 ' + gridCols + ' 列渲染。要么把 cols 调到 ' + gridCols + '，要么改面板坐标。');
  }
  grid.style.gridTemplateColumns = gridCols === 4 ? '' : 'repeat(' + gridCols + ',1fr)';
  // 该场景正在独立窗口里跑 → 默认不在这里再渲染一份（两份定时器 / 两份 AI 界面会互相打架）
  if (!soloSceneId && detachedScenes.has(id) && forceLocalScene !== id) {
    grid.innerHTML = '';
    grid.appendChild(detachedCard(sc));
    placeholderSceneId = id;
    applyBadges();
    return;
  }
  placeholderSceneId = '';   // 正常渲染 → 不再处于"占位"状态
  // 多公司模板：切场景即通知主进程切换到该公司配置（SSH / 服务名 / 同步映射 / 日志来源 / 网址清单）
  try { if (window.app.oa && window.app.oa.setScenario) window.app.oa.setScenario(sc.id); } catch (e) { /* ignore */ }
  // 若有面板处于「展开」状态：先收起，撤掉它的 resize/ESC 监听与占位格（否则重建后残留）
  try { if (typeof collapsePanel === 'function') collapsePanel(); } catch (e) { /* ignore */ }
  grid.innerHTML = '';
  const renderers = kRender();
  for (let i = 0; i < sc.panels.length; i++) {
    const p = sc.panels[i];
    p.scenario = sc.id;   // 场景隔离：面板知道自己属于哪个场景（数据按场景分区）
    const { wrap, body, head } = mkPanel(p, i);
    const fn = renderers[p.type];
    if (fn) {
      try {
        const cleanup = fn(body, p, head);
        if (typeof cleanup === 'function') activeCleanups.push(cleanup);
      } catch (err) { body.appendChild(mkEl('div', 'stat-sub', '面板渲染失败: ' + err.message)); }
    } else {
      body.appendChild(mkEl('div', 'stat-sub', '未知面板类型: ' + p.type));
    }
    grid.appendChild(wrap);
  }
  // 纯自动流场景（json 里一个 col/row 都没写，如 oa-ops）：渲染完自己排格 + 拉伸补洞 ——
  // 否则"这块放不下就往下挪"会在半路留出一大块空洞，还把网格行数撑多、把所有面板一起压扁（2026-09-26 用户截图）。
  try { if (kUtils().packAutoGrid) kUtils().packAutoGrid(grid); } catch (e) { /* ignore */ }
  applyBadges();
}

// 渲染层兜底：任何一步失败都在界面上留痕，不出现"窗口开了但空白、还不知道为啥"
function bootFail(where, err) {
  const msg = where + '：' + ((err && (err.message || err)) || '未知错误');
  try { console.error('[init] ' + msg); } catch (e) { /* ignore */ }
  try {
    let box = document.getElementById('init-error');
    if (!box) {
      box = mkEl('div', 'init-error');
      box.id = 'init-error';
      document.body.appendChild(box);
    }
    box.textContent = '⚠ 界面初始化部分失败 → ' + msg + '（按 F12 看控制台；完整日志见 server.log）';
  } catch (e) { /* ignore */ }
}
// 包一层：单步失败不影响其它步骤
function safeStep(where, fn) {
  try { return fn(); } catch (err) { bootFail(where, err); return null; }
}

async function init() {
  // 桥接自检：preload.js 出错时 window.app 会不存在，此时给出明确原因而不是空白窗口
  if (!window.app) {
    try {
      document.body.innerHTML = '<div class="init-error" style="padding:16px;font-size:13px;line-height:1.8">' +
        '⚠ 界面桥接（preload.js）未加载，界面无法初始化。<br>' +
        '常见原因：preload.js 语法错误 / 被 CSP 拦截 / Electron 启动参数异常。<br>' +
        '处理：查看 server.log，或从 data\\backups 恢复上一版源码后重启。' +
        '</div>';
    } catch (e) { /* ignore */ }
    return;
  }
  safeStep('标题栏', () => initTitlebar());
  safeStep('外观', () => initTheme());      // 深色 / 浅色 / 跟随系统
  safeStep('余额', () => initBalance());    // DeepSeek 平台余额
  safeStep('加载页', () => initBoot());     // 引擎启动进度条 + 失败重试
  // 引擎就绪 → 自动加载主界面（不等用户点标签）；webview 加载完成 → 收起加载页
  safeStep('引擎就绪监听', () => { if (window.app.onHarnessReady) window.app.onHarnessReady(() => { loadHarness(); }); });
  safeStep('webview 加载监听', () => {
    webview.addEventListener('did-finish-load', () => {
      // 文档加载完 ≠ 界面可用：Harness 是 SPA，继续等它渲染出真实 UI 再收起加载页
      setStatus('界面渲染中…', true);
      watchHarnessReady();
    });
  });
  // 底部菜单栏：序号徽标显隐开关
  safeStep('底部菜单', () => {
    const badgesBtn = document.getElementById('sf-badges');
    if (badgesBtn) badgesBtn.addEventListener('click', () => { badgesOn = !badgesOn; applyBadges(); });
  });

  // 读取场景列表：失败也要让界面活着（至少能看到标签栏与错误提示）
  let list = [];
  try {
    list = await window.app.listScenarios();
  } catch (err) {
    bootFail('读取场景列表', err);
  }
  if (!Array.isArray(list)) list = [];

  // ── 场景分离窗口（多屏工作）：只画一个场景 ──
  // 不建场景标签栏，也不加载场景 0 的对话界面（省下一整份引擎界面）：
  // 先显示启动加载页（带进度条），引擎就绪后再渲染这个场景 —— 早了 AI 面板会拿到没 token 的地址。
  if (soloSceneId) {
    const hit = list.filter(s => s.id === soloSceneId)[0];
    const winTitle = ((hit && hit.name) || soloSceneId) + ' · 淋雨家的工作台';
    try { document.title = winTitle; } catch (e) { /* ignore */ }
    const brand = document.querySelector('.brand-name');
    if (brand) brand.textContent = winTitle;
    let entered = false;
    const enterSolo = async () => {
      if (entered) return;
      entered = true;
      try { if (window.__bootFinish) window.__bootFinish(); } catch (e) { /* ignore */ }
      showView('scenario');
      try { await loadScenario(soloSceneId); } catch (err) { bootFail('加载分离场景', err); }
    };
    // 「⟳ 立即进入」在分离窗口里 = 直接进这个场景（capture 阶段拦下，别去加载场景 0）
    const rb = document.getElementById('boot-refresh');
    if (rb) rb.addEventListener('click', (ev) => { ev.stopImmediatePropagation(); enterSolo(); }, true);
    safeStep('分离窗口就绪监听', () => {
      if (window.app.onHarnessReady) window.app.onHarnessReady(() => { enterSolo(); });
      Promise.resolve(window.app.isHarnessReady()).then(ok => { if (ok) enterSolo(); }).catch(() => { /* ignore */ });
    });
    showView('harness');   // 先显示启动加载页，就绪后自动切到场景
    return;
  }

  // 场景图标映射（按场景 id）—— 支持图片路径（.png）或 emoji
  // <客户> OA 系统运维：服务器机柜（内联 SVG 转 data URI，改图标不必加二进制资源）
  const SERVER_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 16 16" fill="none">' +
    '<rect x="2" y="2.6" width="12" height="4.7" rx="1.2" fill="#8fb4ff"/>' +
    '<rect x="2" y="8.7" width="12" height="4.7" rx="1.2" fill="#4f8cff"/>' +
    '<circle cx="4.4" cy="4.95" r="1" fill="#3ddc84"/>' +
    '<circle cx="4.4" cy="11.05" r="1" fill="#3ddc84"/>' +
    '<rect x="6.6" y="4.45" width="5.4" height="1" rx=".5" fill="#0b1220" opacity=".5"/>' +
    '<rect x="6.6" y="10.55" width="5.4" height="1" rx=".5" fill="#0b1220" opacity=".5"/></svg>';
  // 视频工作流：胶片 + 播放三角（同样内联 SVG；renderers.js 的 SCENARIO_ICONS 里有同一份，⟳ 即可生效）
  const FILM_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 16 16" fill="none">' +
    '<rect x="2" y="2.4" width="12" height="11.2" rx="1.8" fill="#8fb4ff"/>' +
    '<circle cx="4.7" cy="4.9" r=".8" fill="#0b1220" opacity=".55"/>' +
    '<circle cx="8" cy="4.9" r=".8" fill="#0b1220" opacity=".55"/>' +
    '<circle cx="11.3" cy="4.9" r=".8" fill="#0b1220" opacity=".55"/>' +
    '<circle cx="4.7" cy="11.1" r=".8" fill="#0b1220" opacity=".55"/>' +
    '<circle cx="8" cy="11.1" r=".8" fill="#0b1220" opacity=".55"/>' +
    '<circle cx="11.3" cy="11.1" r=".8" fill="#0b1220" opacity=".55"/>' +
    '<path d="M6.6 6.7l3.8 2.3-3.8 2.3z" fill="#0b1220" opacity=".8"/></svg>';
  // 自我复盘：环形箭头（复盘/回顾）+ 文档页（同样内联 SVG；renderers.js 的 SCENARIO_ICONS 里有同一份）
  const REVIEW_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 16 16" fill="none">' +
    '<path d="M13.1 8A5.1 5.1 0 1 1 11.4 4.1" stroke="#8fb4ff" stroke-width="1.5" stroke-linecap="round"/>' +
    '<path d="M13.5 2.2v3h-3" stroke="#8fb4ff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<rect x="5.6" y="5.9" width="4.8" height="6.2" rx="1" fill="#8fb4ff" opacity=".85"/>' +
    '<rect x="6.9" y="7.6" width="2.2" height=".9" rx=".45" fill="#0b1220" opacity=".5"/>' +
    '<rect x="6.9" y="9.4" width="2.2" height=".9" rx=".45" fill="#0b1220" opacity=".5"/></svg>';
  // DSH·GUI改造：窗口 + 三块面板（右下那块用琥珀色高亮 = 正在改造的那块）。
  // 原为"窗口 + 两条滑杆"，看着像"设置"而不是"改造界面"（2026-09-26 用户要求换）。
  // renderers.js 的 SCENARIO_ICONS 里有同一份，⟳ 即可生效。
  const PANELS_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 16 16" fill="none">' +
    '<rect x="2" y="2.7" width="12" height="10.6" rx="1.6" fill="#4f8cff" opacity=".26"/>' +
    '<rect x="2" y="2.7" width="12" height="10.6" rx="1.6" stroke="#8fb4ff" stroke-width="1.1"/>' +
    '<rect x="2.6" y="4.5" width="10.8" height="1" fill="#8fb4ff" opacity=".45"/>' +
    '<circle cx="4.15" cy="3.6" r=".5" fill="#8fb4ff" opacity=".85"/>' +
    '<circle cx="5.85" cy="3.6" r=".5" fill="#8fb4ff" opacity=".85"/>' +
    '<rect x="3.4" y="6.5" width="4.3" height="5.3" rx=".8" fill="#8fb4ff" opacity=".38"/>' +
    '<rect x="8.7" y="6.5" width="4.1" height="2.2" rx=".8" fill="#8fb4ff" opacity=".38"/>' +
    '<rect x="8.7" y="9.6" width="4.1" height="2.2" rx=".8" fill="#f0a35e"/></svg>';
  // 设计杂活（design-misc）标签图标：钢笔笔尖 + 落笔曲线 —— "画/做设计"的意象（用户要"有设计感"，不要 emoji）。
  // ⚠ 与 renderer\renderers.js 的 SCENARIO_ICONS['design-misc'] 是同一份，改一处必须同步改另一处。
  // ⚠⚠ 必须有 xmlns：这里的图标是塞进 `<img src="data:image/svg+xml…">` 的（独立 SVG 文档），
  //     少一个 xmlns 就一律渲染不出来 —— 标签上会显示成"破图"占位符（2026-09-26 实测踩到）。
  const DESIGN_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<path d="M1.8 13.6c0-5 2.8-8.4 6.8-8.4 2.3 0 3.5 1.2 3.5 2.8 0 2-1.7 3.1-3.9 3.1-1.9 0-3.2.7-4.1 1.9" stroke="#8fb4ff" stroke-width="1.4" stroke-linecap="round"/>' +
    '<path d="M11.1 2.1 14 5l-3.3.9z" fill="#f0a35e"/>' +
    '<circle cx="1.9" cy="13.4" r="1.15" fill="#f0a35e"/></svg>';
  // 本地电脑（原名电脑清理，2026-10-06）：用量环 —— 与 renderers.js 的 SCENARIO_ICONS['pc-cleanup'] 同一份，两边保持一致
  const CLEAN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true">'
    + '<circle cx="8" cy="8" r="5.4" stroke="#8fb4ff" stroke-width="1.7" opacity=".35"/>'
    + '<path d="M8 2.6a5.4 5.4 0 0 1 5.2 4" stroke="#f0a35e" stroke-width="1.7" stroke-linecap="round"/>'
    + '<circle cx="8" cy="8" r="1.7" fill="#8fb4ff"/></svg>';
  // 程序开发（code-dev，2026-10-22 新增）：代码尖括号 + 斜杠，17px 下最好认（与 renderers.js 同一份）。
  const CODE_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<path d="M5.2 4.1 2 8l3.2 3.9" stroke="#8fb4ff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M10.8 4.1 14 8l-3.2 3.9" stroke="#8fb4ff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M9.2 2.8 6.8 13.2" stroke="#f0a35e" stroke-width="1.5" stroke-linecap="round"/></svg>';
  // 工作台定制（workbench-custom，2026-10-26）：蓝壳工作台 + 2×2 面板，右下琥珀块 = 可换/可拼装的那一块。
  // ⚠ 与 renderer\renderers.js 的 SCENARIO_ICONS['workbench-custom'] 是同一份，改一处必须同步改另一处。
  const WORKBENCH_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2" y="2.4" width="12" height="11.2" rx="1.9" fill="#8fb4ff"/><circle cx="4.05" cy="3.5" r=".48" fill="#0b1220" opacity=".45"/><circle cx="5.6" cy="3.5" r=".48" fill="#0b1220" opacity=".45"/><rect x="3.5" y="4.9" width="4" height="3.2" rx=".7" fill="#0b1220" opacity=".55"/><rect x="8.5" y="4.9" width="4" height="3.2" rx=".7" fill="#0b1220" opacity=".55"/><rect x="3.5" y="8.6" width="4" height="3.2" rx=".7" fill="#0b1220" opacity=".55"/><rect x="8.72" y="8.28" width="4" height="3.2" rx=".7" fill="#f0a35e"/></svg>';
  // 命令（command，2026-10-26）：迷你神经元网（6 蓝节点 + 1 琥珀核心 + 连线）—— 与 renderers.js 的 SCENARIO_ICONS['command'] 同一份。
  const NEURON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.7 4.5 8 2.9l4.4 1.7M3 8.4l.7-3.9M8 2.9l.4 5.2M12.4 4.6 8.4 8.1M8.4 8.1l3.8 3.4M8.4 8.1l-3.8 4.1M3 8.4l5.4-.3" stroke="#8fb4ff" stroke-width=".85" stroke-linecap="round" opacity=".6"/><circle cx="3.7" cy="4.5" r="1.45" fill="#8fb4ff"/><circle cx="8" cy="2.9" r="1.15" fill="#8fb4ff" opacity=".85"/><circle cx="12.4" cy="4.6" r="1.25" fill="#8fb4ff"/><circle cx="3" cy="8.4" r="1.05" fill="#8fb4ff" opacity=".8"/><circle cx="8.4" cy="8.1" r="1.85" fill="#f0a35e"/><circle cx="12.2" cy="11.5" r="1.15" fill="#8fb4ff" opacity=".85"/><circle cx="4.6" cy="12.2" r="1.05" fill="#8fb4ff" opacity=".8"/></svg>';
  const ICONS = {
  'bilibili': 'assets/bilibili-icon.png',
    'douyin': 'assets/douyin-icon.png',   // 2026-10-26 宿主新建「刷抖音」场景（抖音官方 favicon）   // 2026-10-19 宿主新建「B站」场景（官方 favicon.svg）
    'harness': 'assets/deepseek-whale.png',
    'oa-ops': 'data:image/svg+xml;utf8,' + encodeURIComponent(SERVER_SVG),  // 服务器图标（原为云朵 ☁️）
    'stock-analysis': 'assets/hithink-icon.png',  // 同花顺官方图标（scripts\fetch-hithink-icon.mjs 从官网抓；原为通用股票图）
    'personal-site': '🐴',  // <机主>个人站（马头图标）
    'blender': 'assets/blender-icon.png',  // Blender 官方图标（从 blender.exe 提取）
    'video-workflow': 'data:image/svg+xml;utf8,' + encodeURIComponent(FILM_SVG),  // 视频工作流（胶片）
    'self-review': 'data:image/svg+xml;utf8,' + encodeURIComponent(REVIEW_SVG),  // 自我复盘（环形箭头 + 文档）
    'dsh-gui': 'data:image/svg+xml;utf8,' + encodeURIComponent(PANELS_SVG),  // DSH·GUI改造（窗口 + 三块面板）
    'design-misc': 'data:image/svg+xml;utf8,' + encodeURIComponent(DESIGN_SVG),
    'code-dev': 'data:image/svg+xml;utf8,' + encodeURIComponent(CODE_SVG),
    'pc-cleanup': 'data:image/svg+xml;utf8,' + encodeURIComponent(CLEAN_SVG),   // 本地电脑（用量环）
    'workbench-custom': 'data:image/svg+xml;utf8,' + encodeURIComponent(WORKBENCH_SVG),  // 工作台定制（蓝壳 + 琥珀可换块）
    'command': 'data:image/svg+xml;utf8,' + encodeURIComponent(NEURON_SVG)  // 命令（记忆神经元）
  };

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
        }
      });
    }
    if (window.app.win && window.app.win.scenes) {
      Promise.resolve(window.app.win.scenes()).then(ids => {
        detachedScenes = new Set(Array.isArray(ids) ? ids : []);
        decorateDetachedTabs();
      }).catch(() => { /* ignore */ });
    }
  });

  // 初始显示 Harness
  showView('harness');
  try {
    await loadHarness();
  } catch (err) {
    bootFail('加载引擎界面', err);
  }
}

// 顶层调用兜底：init 抛错也要在界面上留痕（否则表现为空白窗口）
init().catch((err) => bootFail('初始化主流程', err));
