// ── 面板 view：预览器（1,832 行）
// 摘自本机实现 `renderers.js` 的 Lrenderers.js–5480。
// 脱敏：内部 API 名已去品牌化（kun → app）· 绝对路径 → <DSH根>/<工作区> · 个人名/客户名/站点 → 占位
// 7311
// ⚠ 摘录/单文件：脱离这套工作台不能直接运行（依赖壳注入的 app.* 实例与页面上下文）。

renderers.view = (body, meta, head) => {
  body.classList.add('view-panel');
  const pid = String(meta.id || 'panel');
  const A = window.app && window.app.app;      // 宿主通用能力：开外链 / 定位路径
  const F = window.app && window.app.file;     // 文件读写（没有 = 需要重启一次 GUI）
  const HOME = '预览';
  const storeKey = 'app.view.' + pid;          // 记住上次看的是哪个文件（⟳ / 切场景回来还在）
  const quickLinks = (Array.isArray(meta.quickLinks) ? meta.quickLinks : [])
    .filter(q => q && typeof q === 'object' && (q.url || q.path || q.launchPath));
  let cur = { kind: 'empty', path: '', url: '', title: '', dirty: false, size: 0, mtime: 0 };
  let inner = null;        // 当前主体元素（textarea / img / video / webview / 卡片）
  let disposed = false;
  let readSeq = 0;         // 异步读盘令牌：切得快时，晚回来的那次结果直接丢掉
  let officeStone = 0;     // Office→PDF 转换令牌：转换是异步的（几秒），切走之后晚回来的结果不许抢屏
  let flash = { text: '', cls: '', until: 0 };
  let flashTimer = null;

  const EXT = {
    text: ['md', 'markdown', 'txt', 'json', 'jsonc', 'js', 'mjs', 'cjs', 'ts', 'css', 'py', 'bat', 'cmd', 'ps1', 'vbs',
      'ini', 'cfg', 'conf', 'log', 'csv', 'srt', 'ass', 'vtt', 'yaml', 'yml', 'xml', 'sql', 'toml', 'sh', 'env', 'gitignore'],
    image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif'],
    video: ['mp4', 'webm', 'mov', 'mkv', 'm4v', 'avi'],
    audio: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'],
    // 2026-09-26 加：PDF / Office（「设计杂活」场景要"什么都能预览"）
    pdf: ['pdf'],
    office: ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'rtf', 'odt', 'ods', 'odp', 'wps', 'et', 'dps']
  };
  const extOf = (p) => {
    const m = /\.([A-Za-z0-9]+)$/.exec(String(p || '').trim());
    return m ? m[1].toLowerCase() : '';
  };
  const isHtml = (p) => /^(html?|htm)$/.test(extOf(p));
  // ★2026-10-13★ 用户要求「预览能预览更多类型、别双击就拉系统程序」：把"内核怎么都看不了"的封装 / 二进制类
  //   单列一类（清单跟自我复盘的 SR_EXT_OPAQUE 一致）⇒ 给一张说清楚的卡片 + 卡片里就能系统打开，
  //   而不是把它们当文本读出一屏乱码。认不出扩展名的，靠 openText 里的二进制嗅探兜底。
  const EXT_OPAQUE = ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'psd', 'ai', 'exe', 'dll', 'msi',
    'db', 'sqlite', 'bin', 'iso', 'apk', 'ttf', 'otf', 'woff', 'woff2'];
  function pickKind(p) {
    const e = extOf(p);
    if (isHtml(p)) return 'web';                          // html：先看渲染效果，按钮能切去改源码
    if (EXT.image.indexOf(e) >= 0) return 'image';
    if (EXT.video.indexOf(e) >= 0) return 'video';
    if (EXT.audio.indexOf(e) >= 0) return 'audio';
    if (EXT.pdf.indexOf(e) >= 0) return 'pdf';                 // PDF：交给内核自带的阅读器（webview）
    if (EXT.office.indexOf(e) >= 0) return 'office';           // Office/WPS：内核渲染不了 ⇒ 给一张"怎么打开"的卡片
    if (EXT_OPAQUE.indexOf(e) >= 0) return 'opaque';           // 压缩包/安装包/二进制 ⇒ 提示卡 + 系统打开（★2026-10-13）
    return 'text';                                        // 其余都按文本读；真二进制由 openText 的嗅探退回提示卡
  }
  function fileUrl(p) { return 'file:///' + encodeURI(String(p).replace(/\\/g, '/')).replace(/^\/+/, ''); }
  const fmtSize = (n) => (!n ? '0 B' : (n < 1024 ? n + ' B' : (n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB')));
  const fmtClock = (sec) => {
    if (!sec) return '';
    try {
      const d = new Date(sec * 1000);
      const p2 = (x) => (x < 10 ? '0' + x : '' + x);
      return (d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
    } catch (e) { return ''; }
  };
  function remember(p) { try { if (p) localStorage.setItem(storeKey, p); else localStorage.removeItem(storeKey); } catch (e) { /* ignore */ } }

  // ---- DOM：一条工具行 + 主体 + 一条状态行 ----
  const HEADMODE = !!head;                 // 有标题行 ⇒ 按键并进标题行（见本渲染器顶部说明）
  const bar = el('div', 'view-bar');
  const what = el('div', 'view-what');
  const iconEl = el('span', 'view-icon', '👁');
  const nameEl = el('span', 'view-name', HOME);
  what.appendChild(iconEl); what.appendChild(nameEl);
  const acts = el('div', 'view-acts');
  bar.appendChild(what); bar.appendChild(acts);
  const bodyBox = el('div', 'view-body');
  const statusEl = el('div', 'view-status', '');
  // 2026-10-18（vw-ai 派单 · 可选）：状态行里那串路径也做成「单击即复制」，照自我复盘 fpath 的先例。
  statusEl.style.cursor = 'copy';
  statusEl.title = '点一下复制当前文件路径';
  statusEl.addEventListener('click', () => {
    const txt = String(cur.path || '').trim();
    if (!txt) return;
    const ok = () => say('✓ 已复制：' + txt);
    try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(txt).then(ok, () => { if (viewCopyText(txt)) ok(); }); return; } } catch (e) { /* 落下面 */ }
    if (viewCopyText(txt)) ok();
  });
  if (HEADMODE) {
    head.classList.add('view-head');
    body.classList.add('view-head-mode');            // 空状态行由 CSS :empty 收掉（不白占一行）
    acts.classList.add('view-head-acts');
    nameEl.classList.add('view-head-name');
    // ⚠ 必须插在**标题之后、副标题之前**：.panel-sub 是 flex:1 1 100% 独占一排，
    //   排在它后面的东西会被顶到第三排（自我复盘的窗口二踩过，见工作台项目信息 §23.5）。
    const titleEl = head.querySelector('.panel-title');
    if (titleEl) { head.insertBefore(nameEl, titleEl.nextSibling); head.insertBefore(acts, nameEl.nextSibling); }
    else { head.appendChild(nameEl); head.appendChild(acts); }
    // 标题行同时是拖拽把手 ⇒ 塞进去的东西必须阻断指针事件，否则点了没反应（公共工具，素材管理面板同一条）
    if (window.APP_RENDER_UTILS && window.APP_RENDER_UTILS.wireHeadNoDrag) {
      window.APP_RENDER_UTILS.wireHeadNoDrag(acts);
      window.APP_RENDER_UTILS.wireHeadNoDrag(nameEl);
    }
    // 2026-10-18（宿主实测反馈）：▲ 原来被 makePanel 插在 title 之后、又被这里的 nameEl/acts 挤到**✕ 关闭右边** ⇒
    //   容易误点关闭。现在把 ▲ 挪到**整排按钮最左边**（=「⟳ 重读」左边），并补一次 wireHeadNoDrag。
    const expBtn = head.querySelector('.panel-expand');
    if (expBtn) {
      head.insertBefore(expBtn, acts);
      if (window.APP_RENDER_UTILS && window.APP_RENDER_UTILS.wireHeadNoDrag) window.APP_RENDER_UTILS.wireHeadNoDrag(expBtn);
    }
    body.appendChild(bodyBox); body.appendChild(statusEl);
  } else {
    body.appendChild(bar); body.appendChild(bodyBox); body.appendChild(statusEl);
  }

  const B = {};
  function mkBtn(key, label, title, cls) {
    const b = el('button', 'file-refresh' + (cls ? ' ' + cls : ''), label);
    b.type = 'button';
    if (title) b.title = title;
    B[key] = b;
    acts.appendChild(b);
    return b;
  }
  mkBtn('save', '💾 保存', '存盘（Ctrl+S）—— 只写 D: / E: 盘', 'primary');
  mkBtn('src', '✎ 编辑源码', '把 HTML 切回源码模式改');
  mkBtn('preview', '👁 看效果', '切回渲染效果（有改动会先存盘）');
  mkBtn('reread', '⟳ 重读', '从磁盘重新读一遍（丢掉没保存的手改）');
  mkBtn('sysopen', '🖥 系统打开', '用系统的默认程序打开这个文件');
  mkBtn('reveal', '📂 定位', '在资源管理器里选中它');
  // 2026-10-18（vw-ai 派单 · 宿主点名）：「宿主要能复制文件的具体路径」⇒ 专门一颗按钮。
  mkBtn('copypath', '⧉ 复制路径', '把这个文件的完整路径复制到剪贴板');
  mkBtn('close', '✕ 关闭', '回到空预览（文件不动）');
  // 常驻快捷入口（场景 json 配的）：视频工作流用它留住 ComfyUI 控制台
  quickLinks.forEach((q, i) => {
    const b = mkBtn('ql' + i, String(q.label || q.url || q.path), '切到这个页面：' + (q.url || q.path || q.launchPath));
    b.classList.add('view-quick');
    b.addEventListener('click', () => {
      if (q.url) open({ url: q.url, title: q.label || '' });
      else if (q.path) open({ path: q.path, title: q.label || q.kind || '' });
    });
    if (q.launchPath) {
      const d = mkBtn('qll' + i, '🖥', '桌面启动：' + q.launchPath);
      d.classList.add('view-quick');
      d.addEventListener('click', () => {
        if (A && A.openPath) A.openPath(q.launchPath);
        else say('没有宿主能力，打不开启动器', 'warn');
      });
    }
  });

  // 挂在 bodyBox 上的临时监听（换文件/⟳ 时统一摘掉，别攒着）——图片的滚轮缩放/拖动就挂这儿
  let bodyHooks = [];
  function clearBody() {
    officeStone++;                 // 任何一次"换内容"都让在飞的 Office 转换作废（否则它回来会抢屏）
    bodyHooks.forEach(h => { try { h(); } catch (e) { /* ignore */ } });
    bodyHooks = [];
    if (inner && inner.parentNode) inner.parentNode.removeChild(inner);
    inner = null;
  }
  function say(text, cls, ms) {
    flash = { text: text, cls: cls || '', until: Date.now() + (ms || 3500) };
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { if (!disposed) paintStatus(); }, (ms || 3500) + 30);
    paintStatus();
  }
  function paintStatus() {
    if (flash.until > Date.now() && flash.text) { statusEl.textContent = flash.text; statusEl.className = 'view-status ' + flash.cls; return; }
    statusEl.className = 'view-status';
    if (cur.kind === 'empty') { statusEl.textContent = F ? '' : '当前是旧主进程：文本读写要重启一次 GUI 才有（图片/视频/网页不受影响）'; return; }
    // 只读文档（画布双击「固定流程预设」摊出来的东西）：没有磁盘路径，状态行就印那句"这是什么、为什么不能改"
    if (cur.doc) { statusEl.textContent = cur.note || '只读预览'; return; }
    if (cur.url && !cur.path) { statusEl.textContent = cur.url; return; }
    if (cur.kind === 'dir') { statusEl.textContent = '文件夹 · ' + cur.path; return; }
    if (cur.kind === 'opaque') { statusEl.textContent = cur.path; return; }   // 二进制/封装类：只印路径，别写"已保存"（★2026-10-13）
    const bits = [cur.path];
    if (cur.size) bits.push(fmtSize(cur.size));
    if (cur.mtime) bits.push('改于 ' + fmtClock(cur.mtime));
    bits.push(cur.dirty ? '● 有改动没保存' : '已保存');
    statusEl.textContent = bits.join('  ·  ');
  }
  function paint() {
    const label = cur.title || (cur.path ? flowPathParts(cur.path).file : (cur.url || HOME));
    // 并进标题行时，空状态的「预览」跟面板标题重复 ⇒ 留空（标题行写的就是「预览」）
    nameEl.textContent = (HEADMODE && label === HOME) ? '' : label;
    nameEl.title = cur.path || cur.url || cur.note || '';
    if (cur.kind === 'dir') iconEl.textContent = '📁'; else iconEl.textContent = cur.kind === 'image' ? '🖼' : (cur.kind === 'video' ? '🎞' : (cur.kind === 'audio' ? '🔊'
      : (cur.kind === 'web' ? '🌐' : (cur.kind === 'preset' ? '📋' : (cur.kind === 'text' ? '✎' : (cur.kind === 'office' ? '📘' : (cur.kind === 'opaque' ? '📦' : '👁')))))));
    const isText = cur.kind === 'text' && !!cur.path;
    const webish = cur.kind === 'web';
    const isDir = cur.kind === 'dir';
    const htmlFile = isHtml(cur.path || '');
    // ★2026-09-26★ 按钮要**贴合场景**（用户点名）：目录视图自带「⟳ 刷新 / 📂 用资源管理器打开」，
    //   顶上那排通用的「重读 / 系统打开 / 定位」就是重复且语义不对 ⇒ 目录视图只留「✕ 关闭」。
    const on = {
      save: isText,
      src: webish && htmlFile,
      preview: isText && htmlFile,
      reread: !!(cur.path && cur.kind !== 'empty') && !isDir,
      sysopen: !!(cur.path || cur.url) && !isDir,
      reveal: !!cur.path && !isDir,
      copypath: !!(cur.path || cur.url) && !isDir,   // 2026-10-18：漏登记会导致永远 display:none（宿主实测「按钮没出现」）
      close: cur.kind !== 'empty'
    };
    Object.keys(B).forEach(k => { if (k.indexOf('ql') !== 0) B[k].style.display = on[k] ? '' : 'none'; });
    B.save.classList.toggle('dirty', !!cur.dirty);
    bodyBox.dataset.mode = cur.kind;
    paintStatus();
  }
  function shell(cls) { clearBody(); const d = el('div', cls || 'view-empty'); bodyBox.appendChild(d); inner = d; return d; }
  function card(icon, title, sub, pathText) {
    const d = shell();
    d.appendChild(el('div', 'view-empty-icon', icon));
    d.appendChild(el('div', 'view-empty-title', title));
    if (sub) d.appendChild(el('div', 'view-empty-sub', sub));
    if (pathText) d.appendChild(el('div', 'view-empty-path', pathText));
    return d;
  }
  // 2026-10-20（宿主：「本场景的文件预览默认显示最近打开的文件夹以及常用的文件夹」）
  //   配了 meta.home / meta.homeFolders 才出现；点一下 ⇒ 让 meta.filesPanel 指定的「文件管理」跳过去
  //   （file 面板对外挂了 window.__kunFiles[面板id].open(路径)，同文档直调，不用新 IPC）。
  function buildHome(host) {
    host.classList.add('has-home');     // 让空状态容器放宽（.view-empty 默认按内容收缩，网格会被挤成一列）
    const wrap = el('div', 'view-home');
    host.appendChild(wrap);
    const mkSection = (title) => {
      const box = el('div', 'view-home-sec');
      box.appendChild(el('div', 'view-home-h', title));
      const grid = el('div', 'view-home-grid');
      box.appendChild(grid); wrap.appendChild(box);
      return grid;
    };
    const nameOf = (p) => {
      const t = String(p || '').replace(/[\\/]+$/, '');
      const seg = t.split(/[\\/]/).filter(Boolean).pop();
      return seg || t || String(p || '');
    };
    const chip = (label, p) => {
      const b = el('button', 'view-home-chip');
      b.type = 'button';
      b.appendChild(el('span', 'ico', '📁'));
      const mid = el('span', 'mid');
      mid.appendChild(el('span', 'n', String(label || nameOf(p))));
      mid.appendChild(el('span', 'p', String(p)));
      b.appendChild(mid);
      b.title = p + '\n点击 ⇒ 让「文件管理」跳到这个文件夹';
      b.addEventListener('click', () => {
        const api = (window.__kunFiles || {})[String(meta.filesPanel || '')];
        if (api && api.open) { api.open(p); say('文件管理 → ' + p, 'ok'); }
        else if (A && A.openPath) A.openPath(p);
        else say('这个场景没有可跳转的文件管理面板', 'warn');
      });
      return b;
    };
    const favs = (Array.isArray(meta.homeFolders) ? meta.homeFolders : [])
      .map((x) => (x && typeof x === 'object')
        ? { label: x.label || '', path: String(x.path || x.launchPath || '') }
        : { label: '', path: String(x || '') })
      .filter((x) => !!x.path);
    if (favs.length) {
      const g1 = mkSection('常用文件夹');
      favs.forEach((x) => g1.appendChild(chip(x.label, x.path)));
    }
    const TB2 = window.app && window.app.topbar;
    if (TB2 && TB2.recentFolders) {
      Promise.resolve().then(() => TB2.recentFolders()).then((r) => {
        if (disposed) return;
        const rows = ((r && r.rows) || []).filter((x) => x && x.path);
        if (!rows.length) return;
        const g2 = mkSection('最近打开的文件夹');
        rows.slice(0, 6).forEach((x) => g2.appendChild(chip('', x.path)));
      }).catch(() => { /* 读不到最近记录就不显示这一节 */ });
    }
  }
  // 空状态：说明 + 手填路径打开（没有"选择文件"对话框这回事，直接让用户粘真实路径 —— 他就喜欢写路径）
  function showEmpty(msg) {
    cur = { kind: 'empty', path: '', url: '', title: '', dirty: false, size: 0, mtime: 0 };
    remember('');
    const d = card('👁', meta.hint ? String(meta.hint) : '这里是预览位',
      msg || (meta.emptyMsg != null ? String(meta.emptyMsg)
        : '流程画布上双击一个节点，它对应的文件就摊在这里（文本能直接改、能存盘）。也可以自己填个路径：'));
    if (meta.home || meta.homeFolders) buildHome(d);
    const row = el('div', 'view-open');
    const inp = el('input', 'view-open-input');
    inp.type = 'text';
    inp.placeholder = '<盘根>\\视频工作流\\文案\\小猫视频文案.md';
    inp.spellcheck = false;
    const go = el('button', 'file-refresh', '打开');
    go.type = 'button';
    const run = () => { const p = inp.value.trim().replace(/^"|"$/g, ''); if (p) open({ path: p }); };
    go.addEventListener('click', run);
    inp.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') { ev.preventDefault(); run(); }
    });
    row.appendChild(inp); row.appendChild(go);
    d.appendChild(row);
    if (quickLinks.length) d.appendChild(el('div', 'view-empty-sub', '右上角的按钮是本场景的常驻入口，点一下就在这儿打开。'));
    paint();
  }
  function needRestart(p) {
    const d = card('🔒', '这个要重启一次 GUI 才能用', F ? '' : '宿主这次启动时还没有文件读写接口（app.file）。重启 GUI 后：文本能直接在这里改、Ctrl+S 存盘。图片/视频/网页不受影响。', p);
    const row = el('div', 'view-open');
    const mk = (label, fn) => { const b = el('button', 'file-refresh', label); b.type = 'button'; b.addEventListener('click', fn); row.appendChild(b); };
    mk('🖥 用系统程序打开', () => { if (A && A.openPath) A.openPath(p); });
    mk('📂 定位', () => { if (A && A.revealPath) A.revealPath(p); });
    d.appendChild(row);
  }

  // ★2026-10-13★ 「预览更多类型」：内核渲染不了、也转不出 PDF 的封装/二进制类（zip/rar/7z/psd/exe/msi/db/iso/apk…）
  //   单独归一类 ⇒ 给一张**说清楚**的卡片 + 卡片里就能「🖥 系统打开 / 📂 定位」，绝不白屏、不静默失败（照自我复盘那份做法）。
  //   ⚠ 它同时是"素材管理双击不再拉系统程序"的兜底：用户双击一个 zip，看到的是这张卡，不是一屏乱码。
  function openOpaque(p, why) {
    const d = card('📦', '这类文件内核看不了：' + flowPathParts(p).file,
      (why ? why + '。' : '') + '它属于压缩包 / 安装包 / 二进制这类格式（内核渲染不了，也转不出 PDF）。'
      + '看内容请用系统程序打开；要在这里看，请选文本、图片、视频、音频、PDF、Office 或 HTML。', p);
    const row = el('div', 'view-open');
    const mk = (label, fn) => { const b = el('button', 'file-refresh', label); b.type = 'button'; b.addEventListener('click', fn); row.appendChild(b); };
    mk('🖥 用系统程序打开', () => { if (A && A.openPath) A.openPath(p); else say('没有宿主能力，打不开', 'warn'); });
    mk('📂 定位', () => { if (A && A.revealPath) A.revealPath(p); });
    d.appendChild(row);
    remember(p);
  }

  async function flushDirty() {
    if (!(cur.dirty && cur.kind === 'text' && cur.path && inner && inner.tagName === 'TEXTAREA')) return;
    if (!F || !F.write) { cur.dirty = false; return; }
    const p = cur.path, text = inner.value;
    let r = null;
    try { r = await F.write(p, text); } catch (e) { r = { ok: false, err: String((e && e.message) || e) }; }
    cur.dirty = false;
    if (r && r.ok) { cur.size = r.size || cur.size; cur.mtime = r.mtime || cur.mtime; say('✓ 切走之前先自动存了：' + flowPathParts(p).file, 'ok'); }
    else say('⚠ 自动保存失败：' + ((r && r.err) || '未知'), 'bad');
  }
  async function saveText() {
    if (!(cur.kind === 'text' && cur.path && inner && inner.tagName === 'TEXTAREA')) return false;
    if (!F || !F.write) { say('宿主还没重启过：重启一次 GUI 才能写文件', 'warn'); return false; }
    const r = await F.write(cur.path, inner.value);
    if (r && r.ok) {
      cur.dirty = false; cur.size = r.size || 0; cur.mtime = r.mtime || 0;
      say('✓ 已保存 ' + fmtClock(r.mtime) + '  ·  ' + cur.path, 'ok');
    } else say('⚠ ' + ((r && r.err) || '保存失败'), 'bad');
    paint();
    return !!(r && r.ok);
  }

  async function openText(p) {
    const stone = ++readSeq;
    card('⏳', '正在读：' + flowPathParts(p).file, '', p);
    if (!F || !F.read) { needRestart(p); return; }
    let r = null;
    try { r = await F.read(p); } catch (e) { r = { ok: false, err: String((e && e.message) || e) }; }
    if (disposed || stone !== readSeq) return;
    if (!r || !r.ok) {
      const d = card('⚠', '打不开这个文件', (r && r.err) || '未知错误', p);
      const row = el('div', 'view-open');
      const mk = el('button', 'file-refresh', '📄 新建空文件');
      mk.type = 'button';
      mk.addEventListener('click', async () => {
        const w = await F.write(p, '');
        if (w && w.ok) openText(p); else say('新建失败：' + ((w && w.err) || ''), 'bad');
      });
      const mk2 = el('button', 'file-refresh', '🖥 系统打开');
      mk2.type = 'button';
      mk2.addEventListener('click', () => { if (A && A.openPath) A.openPath(p); });
      row.appendChild(mk); row.appendChild(mk2);
      d.appendChild(row);
      remember('');
      return;
    }
    cur.size = r.size || 0; cur.mtime = r.mtime || 0; cur.dirty = false;
    // ★2026-10-13★ 认不出扩展名、其实是二进制的文件（无后缀 / .sample 这类）：读回来出现 NUL 或大量坏字符
    //   （U+FFFD = utf8 解不开的字节）⇒ 退回"看不了"卡片，绝不把乱码糊在面板里（照自我复盘那份做法）。
    const rawTxt = r.text == null ? '' : String(r.text);
    if (rawTxt && (rawTxt.indexOf('\u0000') >= 0 || (rawTxt.match(/\uFFFD/g) || []).length > 8)) {
      cur.kind = 'opaque'; paint();
      return openOpaque(p, '这个文件其实是二进制');
    }
    clearBody();
    const ta = el('textarea', 'view-ta');
    ta.value = r.text == null ? '' : String(r.text);
    ta.spellcheck = false;
    ta.addEventListener('input', () => { if (!cur.dirty) { cur.dirty = true; paint(); } });
    ta.addEventListener('keydown', (ev) => {
      ev.stopPropagation();                                  // 别让快捷键跑到宿主/画布那边去
      if ((ev.ctrlKey || ev.metaKey) && (ev.key === 's' || ev.key === 'S')) { ev.preventDefault(); saveText(); }
      else if (ev.key === 'Tab') {                           // 改 HTML / 脚本时 Tab 缩进比切焦点有用
        ev.preventDefault();
        const s = ta.selectionStart, e2 = ta.selectionEnd;
        ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(e2);
        ta.selectionStart = ta.selectionEnd = s + 2;
        if (!cur.dirty) { cur.dirty = true; paint(); }
      }
    });
    bodyBox.appendChild(ta);
    inner = ta;
    remember(p);
    paint();
    try { ta.focus(); } catch (e) { /* ignore */ }
  }
  function openImage(p) {
    clearBody();
    const img = el('img', 'view-img');
    img.alt = flowPathParts(p).file;
    // ★ 本地图片**优先走宿主 IPC 读成 data: URL**（app.oa.image，上限 12MB）——跟文件面板的大图同一条路。
    //   为什么不让 file:// 先试：2026-09-26 用户实测"预览里本地图打不开"，而 data: 这条路一直是通的
    //   （data: 是 CSP 一直放行的源；file:// 在不同内核/CSP 组合下不一定通）。IPC 读不了（比如 >12MB）再退回 file://。
    const K = window.app && window.app.oa;
    let imgTriedFile = false;
    const useFile = () => {
      if (imgTriedFile || disposed) return;
      imgTriedFile = true;
      img.src = fileUrl(p);
      img.addEventListener('error', () => {
        if (disposed) return;
        say('图片没显示出来：文件不在、或者它其实不是图片'
          + '（名字以 ._ 开头的是 macOS 元数据文件，4KB 左右，不是图）', 'bad');
      }, { once: true });
    };
    if (K && K.image && p) {
      Promise.resolve(K.image(p)).then(r => {
        if (disposed) return;
        if (r && r.ok && r.dataUrl) img.src = r.dataUrl;
        else useFile();                                  // 读不到（例如超过 12MB）⇒ 退回 file://
      }).catch(useFile);
    } else {
      useFile();
    }
    bodyBox.appendChild(img); inner = img;
    // ★ 滚轮放大 / 拖动平移 / 双击复原（2026-09-26 用户要求："显示图片时可以滚轮放大缩小看细节"）
    //   做法：只动图片自己的 transform —— translate(tx,ty) scale(z)，原点固定 0 0（不动面板布局）。
    //   滚轮以**光标所在的那个点**为锚（缩放时它在屏幕上原地不动，否则一放大就跑偏，细节没法看）：
    //   锚点坐标要的是"没缩放时的矩形"，所以量之前先把 transform 摘掉再量，同一帧内改回去（不闪屏）。
    //   监听挂在 bodyBox 上（图片小的时候，边上的黑边也能滚），换文件时由 clearBody 统一摘掉。
    img.style.transformOrigin = '0 0';
    img.style.cursor = 'zoom-in';
    let z = 1, tx = 0, ty = 0, lastPct = 100, dragging = false, lx = 0, ly = 0;
    const applyT = () => { img.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + z + ')'; };
    const baseRect = () => {
      const keep = img.style.transform;
      img.style.transform = 'none';
      const r = img.getBoundingClientRect();
      img.style.transform = keep;
      return r;
    };
    const onWheel = (e) => {
      if (!img.clientWidth) return;
      e.preventDefault();                                   // 别让面板/页面跟着滚
      const r = baseRect();
      const cx = e.clientX - r.left, cy = e.clientY - r.top;
      const nz = Math.min(20, Math.max(0.2, z * Math.exp(-e.deltaY * 0.0016)));
      if (nz === z) return;
      tx += cx * (z - nz);                                  // 光标那个点原地不动（推导见上）
      ty += cy * (z - nz);
      z = nz; applyT();
      img.style.cursor = z > 1.01 ? 'grab' : 'zoom-in';
      const pct = Math.round(z * 100);
      if (pct !== lastPct) {                                // 别每个滚轮事件都刷状态行
        lastPct = pct;
        say('缩放 ' + pct + '%' + (z > 1.01 ? ' · 按住拖动平移 · 双击复原' : ''), '', 1400);
      }
    };
    const onDown = (e) => {
      if (z <= 1.01 || e.button !== 0) return;              // 没放大 = 不拖动（保持原来的选中/拖拽行为）
      dragging = true; lx = e.clientX; ly = e.clientY;
      img.style.cursor = 'grabbing';
      try { bodyBox.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      e.preventDefault();
    };
    const onMove = (e) => {
      if (!dragging) return;
      tx += e.clientX - lx; ty += e.clientY - ly;
      lx = e.clientX; ly = e.clientY;
      applyT();
    };
    const onUp = () => { if (!dragging) return; dragging = false; img.style.cursor = z > 1.01 ? 'grab' : 'zoom-in'; };
    const onDbl = () => {
      z = 1; tx = 0; ty = 0; applyT(); lastPct = 100;
      img.style.cursor = 'zoom-in';
      say('已复原成适应窗口（滚轮放大，放大后按住拖动看细节）', '', 1600);
    };
    bodyBox.addEventListener('wheel', onWheel, { passive: false });
    bodyBox.addEventListener('pointerdown', onDown);
    bodyBox.addEventListener('pointermove', onMove);
    bodyBox.addEventListener('pointerup', onUp);
    bodyBox.addEventListener('pointercancel', onUp);
    bodyBox.addEventListener('dblclick', onDbl);
    bodyHooks.push(() => {
      bodyBox.removeEventListener('wheel', onWheel);
      bodyBox.removeEventListener('pointerdown', onDown);
      bodyBox.removeEventListener('pointermove', onMove);
      bodyBox.removeEventListener('pointerup', onUp);
      bodyBox.removeEventListener('pointercancel', onUp);
      bodyBox.removeEventListener('dblclick', onDbl);
    });
    remember(p);
    paint();
  }
  function openMedia(p, kind) {
    clearBody();
    const v = el(kind === 'audio' ? 'audio' : 'video', 'view-media-el');
    v.controls = true;
    v.src = fileUrl(p);
    bodyBox.appendChild(v); inner = v;
    remember(p);
    paint();
  }
  function openWeb(src) {
    clearBody();
    const wv = document.createElement('webview');
    wv.setAttribute('partition', 'persist:view-' + pid.replace(/[^A-Za-z0-9_-]/g, '_'));
    wv.setAttribute('allowpopups', '');
    wv.setAttribute('src', src);
    wv.className = 'view-web';
    bodyBox.appendChild(wv); inner = wv;
    if (cur.path) remember(cur.path);
    paint();
  }
  // ---- PDF：用内核自带的 PDF 阅读器（<webview> 载 file://）----
  // 为什么不自己解析：Electron 自带 Chromium 的 PDF 查看器，翻页 / 缩放 / 搜索 / 打印都是现成的。
  // 万一这台机器上没出图（少数情况），工具栏的「🖥 系统打开」是兜底。
  function openPdf(p) {
    clearBody();
    const wv = document.createElement('webview');
    wv.setAttribute('partition', 'persist:view-' + pid.replace(/[^A-Za-z0-9_-]/g, '_'));
    wv.setAttribute('src', fileUrl(p));
    wv.className = 'view-web';
    bodyBox.appendChild(wv); inner = wv;
    remember(p);
    paint();
    say('PDF：用页面自带的工具条翻页/缩放；没显示出来就点「🖥 系统打开」', '', 6000);
  }
  // ---- Office / WPS 文档（★2026-10-13 升级：从"只能说怎么打开"变成"真能看"）----
  // 旧版只摊一张说明卡。现在先让主进程借本机装的 Office 把它转成 PDF（按文件缓存），
  //   转成功就直接喂给内核自带 PDF 阅读器 ⇒ Word / Excel / PPT 在这里就能看，版式是 Office 自己排的。
  // 转不动（.wps/.et/.dps 这类 WPS 私有格式、本机没装 Office、或主进程还是旧的）才退回那张说明卡，
  //   并把**具体原因**印在卡上 —— 用户明确要求"不要白屏、不要静默失败"。
  function openOffice(p) {
    const api = (window.app && window.app.file) || null;
    if (!api || typeof api.toPdf !== 'function') {
      openOfficeCard(p, '当前主进程还是旧的（没有 doc→PDF 接口）—— 重启一次 GUI 就能在这里内嵌预览');
      return;
    }
    clearBody();
    const stone = ++officeStone;        // clearBody 之后再取号：此后任何一次换内容都会让它作废
    const wrap = el('div', 'view-doc');
    wrap.appendChild(el('pre', 'view-doc-pre',
      '正在把这份 .' + extOf(p) + ' 转成 PDF 预览…\n\n'
      + '· 借本机装的 Office 转一次；第一次大约几秒，转完按文件缓存，再打开就是秒开\n'
      + '· 版式由 Office 自己排，跟原文件一致（翻页/缩放/搜索都用 PDF 阅读器那套）\n'
      + '· 不想等：直接点工具栏「🖥 系统打开」'));
    bodyBox.appendChild(wrap); inner = wrap;
    if (cur.path) remember(cur.path);
    paint();
    say('转换中…', '', 0);
    Promise.resolve(api.toPdf(p)).then(function (r) {
      if (disposed || stone !== officeStone) return;        // 期间切到别的文件了 ⇒ 丢掉这次结果
      if (r && r.ok && r.pdf) {
        openPdf(r.pdf);
        // openPdf 会把"上次看的文件"记成 %TEMP% 里那份转换产物 —— 这里改回**原始文档**：
        // 否则下次开面板会去恢复一个临时 PDF（临时目录一清就找不到，还会让人以为在预览 PDF）。
        remember(p);
        say(r.cached ? 'PDF（缓存命中）· 翻页/缩放用页面自带工具条' : '已转成 PDF 预览 · 下次打开秒开', '', 5000);
        return;
      }
      openOfficeCard(p, String((r && r.err) || '转换成 PDF 失败'));
    }).catch(function (e) {
      if (disposed || stone !== officeStone) return;
      openOfficeCard(p, '转换异常：' + String((e && e.message) || e));
    });
  }
  // 兜底卡片（转不动时才用）：说清是什么格式、为什么看不了、下一步点哪儿
  function openOfficeCard(p, why) {
    clearBody();
    const wrap = el('div', 'view-doc');
    const e = extOf(p);
    wrap.appendChild(el('pre', 'view-doc-pre',
      '这种格式（.' + e + '）没法内嵌预览。\n\n'
      + (why ? '原因：' + why + '\n\n' : '')
      + '三种做法：\n'
      + '  · 点工具栏「🖥 系统打开」—— 用 Word / WPS / Office 打开它（最常用）\n'
      + '  · 先在 Office 里「另存为 PDF」，PDF 能在预览面板里直接看\n'
      + '  · 只是要看/改文字：把内容贴给我，我在 AI 面板里处理'));
    wrap.appendChild(el('div', 'view-preset-cap', '文件'));
    wrap.appendChild(el('pre', 'view-preset-prompt', String(p)));
    bodyBox.appendChild(wrap); inner = wrap;
    remember(p);
    paint();
  }
  // ---- 两类"没有文件"的只读预览（画布上双击「固定流程预设」摊到这儿的东西）----
  // 共同点：都不读盘、不能改、**不写 last（remember）** —— 它们不是"上次看的文件"，
  //   写了的话下次开面板会试图按路径打开一个空路径。要改内容 = 回画布右键那个节点。
  // ① 只读文档（预览形式 = 文字说明）：把步骤 + 指令模板整段摊出来。
  //    为什么不用 readonly 的 textarea：那看着像"能改但点不动"，反而让人反复试；pre 一眼就是"看的"。
  function openDoc(o) {
    cur = {
      kind: 'text', path: '', url: '', title: String(o.title || ''), dirty: false, size: 0, mtime: 0,
      doc: true, note: String(o.note || '只读预览（要改就回画布右键那个节点 → ✎ 编辑节点）')
    };
    clearBody();
    const wrap = el('div', 'view-doc');
    // 用 pre 而不是普通 div：步骤/指令里的换行、缩进都是内容的一部分，不能被 HTML 折叠掉
    wrap.appendChild(el('pre', 'view-doc-pre', String(o.text == null ? '' : o.text)));
    bodyBox.appendChild(wrap); inner = wrap;
    paint();
  }
  // ② 流程图小图（预览形式 = 流程图小图）：小方块 + 箭头，**纯 HTML/CSS 的静态示意图**。
  //    ⚠ 这里是预览，不是可编辑画布 ⚠ —— 不拖、不连、不存盘。为什么不复用画布那套 DOM/SVG 内核：
  //    那套是编辑器（几十个事件 + 缩放 + 平移 + localStorage），为了画几个方块引进来，
  //    既拖慢预览面板，又会让人以为"这儿能连线"（不能，改法只有一个：右键画布上那个节点）。
  function openPresetMini(o) {
    const steps = (Array.isArray(o.steps) ? o.steps : []).map(s => String(s == null ? '' : s).trim()).filter(s => !!s);
    cur = {
      kind: 'preset', path: '', url: '', title: String(o.title || ''), dirty: false, size: 0, mtime: 0,
      doc: true, note: '固定流程预设 · ' + steps.length + ' 步（只读的示意图 —— 要改步骤就右键画布上那个节点）'
    };
    clearBody();
    const wrap = el('div', 'view-preset');
    if (!steps.length) wrap.appendChild(el('div', 'view-preset-empty', '这个预设还没写步骤（右键画布上那个节点 → ✎ 编辑节点，或在内置模板里挑一个）'));
    steps.forEach((s, i) => {
      const bx = el('div', 'view-preset-step');
      bx.appendChild(el('span', 'view-preset-no', String(i + 1)));
      bx.appendChild(el('span', 'view-preset-txt', s));
      wrap.appendChild(bx);
      if (i < steps.length - 1) {
        const ar = el('div', 'view-preset-arrow', '↓');
        ar.title = '下一步';
        wrap.appendChild(ar);
      }
    });
    const prompt = String(o.prompt || '').trim();
    if (prompt) {
      wrap.appendChild(el('div', 'view-preset-cap', '指令模板'));
      wrap.appendChild(el('pre', 'view-preset-prompt', prompt));
    }
    wrap.appendChild(el('div', 'view-preset-tip', '⚠ 这里是预览、不是可编辑画布 —— 要改步骤或指令，右键画布上那个节点 → ✎ 编辑节点'));
    bodyBox.appendChild(wrap); inner = wrap;
    paint();
  }

  // ★2026-09-26★ 项目文件夹（画布上双击「项目文件夹」节点）= 在预览面板里**摊开这个文件夹**：
  //   图片、视频直接给缩略图（视频用 <video preload="metadata"> 出首帧），双击任意一项 = 在**这个面板里**
  //   看/播（图片大图、视频/音频带播放条、文本可改可存）；顶部两个按钮：⟳ 刷新、📂 用资源管理器打开。
  //   列目录借宿主现成的 `app.oa.filesLocal`（= `oa:files:local`，本来是给 OA 用的，其实是通用的本地列目录，
  //   **不用新 IPC、不用重启 GUI**）。找不到预览面板时画布那边会退回"直接用资源管理器打开"。
  // ★2026-09-26★ 目录视图的小样式：**就地注入一段 <style>**（不去动 styles.css —— 那份不一定跟着热重载，
  //   而这里注入的只作用于 .kun-dir-* 这几个类名；幂等：已经插过就不重复插）。
  function ensureDirCss() {
    // ★2026-09-27 用户反馈：「文件夹预览里面的 md 文件显示太差了，可以显示文件名和图标」★
    //   原来是"缩略图区里放一个 📄 emoji + 下面一行窄窄的文件名"，实际看着就是**一张几乎全黑的空卡片**。
    //   现在：非图片/视频的文件（md/txt/json/srt…）走 `.plain` 卡片 —— **扩展名徽标当图标 + 文件名占两行**。
    //   ⚠ 必须带版本判据：老写法只有 `if (已存在) return`，改了 CSS 也不生效（同 ensureRunCss 那条经验）。
    // ★2026-09-27 v3 ★ 「卡片被压成 21~50px 横条」那条 bug 的修复就在下面这几条规则里（根因与量到的数字
    //   写在 .kun-dir-grid 那段注释里）。**版本号必须跟着改**（v2-filecards → v3-rows-fixed），
    //   否则老的 <style> 已经在文档里、`data-ver` 一样就直接 return，改了的 CSS 一条都不生效 —— 这条经验踩过两次。
    const VER = 'v4-grid-scroll';
    const old = document.getElementById('kun-view-dir-css');
    if (old && old.getAttribute('data-ver') === VER) return;
    if (old && old.parentNode) old.parentNode.removeChild(old);
    const st = document.createElement('style');
    st.id = 'kun-view-dir-css';
    st.setAttribute('data-ver', VER);
    st.textContent = [
      '.kun-dir-bar{display:flex;align-items:center;gap:8px;padding:7px 9px;border-bottom:1px solid var(--border);}',
      '.kun-dir-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--mono);font-size:11px;color:var(--text-dim);}',
      '.kun-dir-btn{display:inline-flex;align-items:center;gap:5px;padding:4px 11px;border-radius:7px;cursor:pointer;font:inherit;font-size:11.5px;line-height:1.5;color:var(--text);background:rgba(255,255,255,.05);border:1px solid var(--border);transition:background .14s ease,border-color .14s ease,transform .1s ease;}',
      '.kun-dir-btn:hover{background:rgba(255,255,255,.11);border-color:var(--accent);}',
      '.kun-dir-btn:active{transform:translateY(1px);}',
      // ★2026-09-27 修「卡片被压成横条」★（用户截图：预览面板摊开项目文件夹，26 张卡每张只剩 ~21~50px 高的
      //   一条压扁/裁切的图片，文件名和大小全看不见）。
      //   根因：`.kun-dir-grid` 是 `flex:1` + `min-height:0` 的 flex item，而预览面板只占 2×2 格
      //   （scenarios\video-workflow.json 的 vw-view = col1,row4,w2,h2；主窗口 1558×913 ⇒ 面板体 ≈770×314
      //   ⇒ 网格只剩 ≈218px 高），grid 内容却要 ≈1008px ⇒ flex 把网格**压到内容高度以下**，
      //   grid-auto-rows 默认 auto 的行一起被压成 20.5px（真浏览器量到：卡 21px、行 20.5312px、
      //   而 .kun-dir-thumb 的 computed height 仍是 118px ⇒ 缩略图整个溢出卡片，
      //   被 `.kun-dir-card{overflow:hidden}` 裁掉下半 ⇒ 只剩一条图片横条，名字/大小全被吃掉）。
      //   修法（打不烂的写法）：① 网格**不再参与收缩**（flex:none）+ 行高不压缩（grid-auto-rows:max-content）
      //     ⇒ 网格永远按内容排满，装不下就自己滚动（wrap 有 min-height:0，滚动条落在网格内部）；
      //   ② 卡片一律 flex 列布局 + min-height:0，缩略图 flex:none 不被压；
      //   ③ JS 里再给 thumb/img/video/name/meta 写**内联兜底尺寸**（见 openDir），样式被别处覆盖也塌不了。
      // ★2026-09-27 再修（用户反馈"预览不全"）★：上一版写成 `flex:none`（不参与收缩）⇒ 网格按**内容高度**撑到 1000+px，
      //   超出面板的部分被裁掉、**下面那些项够不到**。正解 = **允许收缩到面板高度 + 内部滚动**（`flex:1 1 auto` + `min-height:0` + `overflow:auto`），
      //   同时保留 `grid-auto-rows:max-content` —— 那才是最初"卡片被压成横条"的真根因（行高被压扁）。
      '.kun-dir-grid{flex:1 1 auto;min-height:0;overflow:auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));grid-auto-rows:max-content;gap:9px;padding:10px;align-content:start;}',
      '.kun-dir-card{display:flex;flex-direction:column;min-height:0;border:1px solid var(--border);border-radius:9px;overflow:hidden;cursor:pointer;background:var(--bg-panel);transition:border-color .14s ease,box-shadow .14s ease,transform .1s ease;}',
      '.kun-dir-card:hover{border-color:var(--accent);box-shadow:0 4px 14px rgba(0,0,0,.35);transform:translateY(-1px);}',
      '.kun-dir-thumb{height:118px;flex:none;display:flex;align-items:center;justify-content:center;background:#0d1424;font-size:34px;overflow:hidden;}',
      // ★媒体缩略图按**原始比例**铺满（object-fit:contain）——不加这条 <video> 会被拉变形/裁掉★（2026-09-27 用户："合适比例显示不要压缩"）
      '.kun-dir-thumb>img,.kun-dir-thumb>video{display:block;width:100%;height:100%;object-fit:contain;background:#0a1120;}',
      // 文件名/尺寸行：flex:none + 最多两行（媒体卡与徽标卡**同一条规则**，不再分叉；长文件名换行不裁字）
      '.kun-dir-name{flex:none;padding:6px 8px 2px;font-size:11px;line-height:1.35;color:var(--text);'
        + 'white-space:normal;word-break:break-all;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;}',
      '.kun-dir-meta{flex:none;padding:0 8px 7px;font-size:10px;color:var(--text-dim);font-family:var(--mono);white-space:nowrap;}',
      '.kun-dir-empty{grid-column:1/-1;padding:22px 10px;text-align:center;color:var(--text-dim);font-size:12px;}',
      // ---- 非媒体文件（md/txt/json/srt/csv…）：不用 emoji 兜底，直接"扩展名徽标 + 两行文件名" ----
      '.kun-dir-card.plain .kun-dir-thumb{height:auto;min-height:66px;background:transparent;padding:13px 8px 4px;font-size:0;}',
      '.kun-dir-ext{display:inline-flex;align-items:center;justify-content:center;min-width:46px;padding:7px 12px;border-radius:9px;'
        + 'font-family:var(--mono);font-size:14px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;'
        + 'color:#7fe3ff;background:rgba(77,226,255,.13);border:1px solid rgba(77,226,255,.34);}',
      // 文件夹也用徽标（emoji 在不同机器上不一定有）
      '.kun-dir-card.dir .kun-dir-thumb{height:auto;min-height:66px;background:transparent;font-size:0;padding:13px 8px 4px;}',
      '.kun-dir-badge{display:inline-flex;align-items:center;justify-content:center;min-width:46px;padding:7px 12px;border-radius:9px;'
        + 'font-size:17px;color:#ffd479;background:rgba(224,179,65,.14);border:1px solid rgba(224,179,65,.36);}',
    ].join('\n');
    (document.head || document.body).appendChild(st);
  }
  async function openDir(p) {
    // ⚠ 先把整个 body 清干净：`clearBody()` 只删 `inner` 那**一个**节点，而这个视图有"工具条 + 网格"两块 ⇒
    //   只清 inner 会留下旧工具条（实测：双击两次 ⇒ 两根工具条叠着、卡片还被后来的空状态顶掉 ✗）。
    while (bodyBox.firstChild) bodyBox.removeChild(bodyBox.firstChild);
    inner = null;
    ensureDirCss();
    const K = (window.app && window.app.oa) || null;
    // 工具条 + 网格**包在一个 wrap 里**，wrap 就是 inner ⇒ 以后任何 clearBody() 都能一次清掉整块
    const wrap = el('div', 'view-dirwrap');
    wrap.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;';
    bodyBox.appendChild(wrap); inner = wrap;
    const bar = el('div', 'kun-dir-bar');
    const t = el('div', 'kun-dir-path', p);
    t.title = p;
    const bRef = el('button', 'kun-dir-btn', '⟳ 刷新');
    const bOpen = el('button', 'kun-dir-btn', '📂 用资源管理器打开');
    bar.appendChild(t); bar.appendChild(bRef); bar.appendChild(bOpen);
    wrap.appendChild(bar);
    const grid = el('div', 'kun-dir-grid');
    wrap.appendChild(grid);
    // ★2026-09-27 用户要求：「合适比例显示不要压缩，加个滚轮」★
    //   Ctrl/⌘ + 滚轮 = 调缩略图大小（72~320px，同时改卡片宽度）；**普通滚轮照旧滚动列表**（不抢滚动）。
    //   只作用在媒体卡（图片/视频）上；.plain/.dir 那种徽标卡高度自适应，别被内联高度压住。
    let thumbH = 118;
    const applyThumbSize = () => {
      const h = Math.round(thumbH);
      grid.style.gridTemplateColumns = 'repeat(auto-fill,minmax(' + Math.round(thumbH * 1.27) + 'px,1fr))';
      grid.querySelectorAll('.kun-dir-card:not(.plain):not(.dir) .kun-dir-thumb').forEach((x) => {
        // ⚠ 三个一起写：只写 height 的话，别的规则里的 flex-shrink / max-height 还是能把它压扁
        //   （2026-09-27 那条"卡片压成横条"的 bug 就是被 flex 压的）⇒ height + min/max 全部钉死。
        x.style.height = h + 'px';
        x.style.minHeight = h + 'px';
        x.style.maxHeight = h + 'px';
        x.style.flex = '0 0 auto';
      });
    };
    grid.addEventListener('wheel', (ev) => {
      if (!ev.ctrlKey && !ev.metaKey) return;                 // 普通滚轮 = 正常滚动
      ev.preventDefault();
      thumbH = Math.max(72, Math.min(320, thumbH * (ev.deltaY < 0 ? 1.12 : 0.9)));
      applyThumbSize();
      say('缩略图 ' + Math.round(thumbH) + 'px（Ctrl+滚轮 继续调；普通滚轮 = 滚动列表）', '', 1600);
    }, { passive: false });
    bRef.addEventListener('click', () => openDir(p));
    bOpen.addEventListener('click', () => { const A2 = window.app && window.app.app; if (A2 && A2.openPath) A2.openPath(p); else say('没有宿主打开能力', 'warn'); });
    if (!K || !K.filesLocal) {
      grid.appendChild(el('div', 'view-empty-s', '宿主没有列目录的能力（app.oa.filesLocal）—— 这台 GUI 版本旧了'));
      paint(); return;
    }
    const r = await K.filesLocal(p);
    if (disposed) return;
    if (!r || !r.ok) { grid.appendChild(el('div', 'view-empty-s', '读不了这个文件夹：' + ((r && r.err) || p))); paint(); return; }
    const rows = (r.rows || []).filter(x => !/^\./.test(x.name));
    if (!rows.length) { grid.appendChild(el('div', 'view-empty-s', '这个文件夹还是空的 —— 产物生成后会出现在这儿')); paint(); return; }
    const IMG = /\.(png|jpe?g|webp|gif|bmp)$/i, VID = /\.(mp4|mov|mkv|webm|avi|m4v)$/i, AUD = /\.(mp3|wav|m4a|flac|aac)$/i;
    const fmtSize = (n) => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : (n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B');
    let nMedia = 0;
    // ★内联兜底尺寸（2026-09-27 修"卡片压成横条"那条 bug 的第二道防线）★
    //   为什么非要写内联：这次的根因是**容器被 flex 压缩**导致卡片只剩 21px，将来任何一条别的规则
    //   （新加的 .flow-node* 段、全局 img/div 规则、主题覆盖…）都可能再把它压一次。
    //   把每张卡的**骨架尺寸直接钉在元素 style 上**，样式表被谁盖了都塌不了：
    //     thumb 高（媒体卡）/ min-height（徽标卡）、img/video 充满且 contain、name 两行、meta 一行。
    const THUMB_FALLBACK = 'flex:0 0 auto;height:' + Math.round(thumbH) + 'px;min-height:' + Math.round(thumbH) + 'px;'
      + 'display:flex;align-items:center;justify-content:center;overflow:hidden;';
    const MEDIA_FALLBACK = 'display:block;width:100%;height:100%;max-width:100%;max-height:100%;object-fit:contain;flex:0 0 auto;';
    const BADGE_FALLBACK = 'flex:0 0 auto;height:auto;min-height:66px;display:flex;align-items:center;justify-content:center;overflow:hidden;';
    const NAME_FALLBACK = 'flex:0 0 auto;min-height:15px;padding:6px 8px 2px;font-size:11px;line-height:1.35;overflow:hidden;'
      + 'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-all;';
    const META_FALLBACK = 'flex:0 0 auto;padding:0 8px 7px;font-size:10px;line-height:1.3;white-space:nowrap;overflow:hidden;';
    rows.forEach(it => {
      const full = p.replace(/[\\/]+$/, '') + '\\' + it.name;
      const card = el('div', 'kun-dir-card');
      card.title = it.name + (it.isDir ? '\n双击进入这个子文件夹' : (IMG.test(it.name) ? '\n双击看大图' : ((VID.test(it.name) || AUD.test(it.name)) ? '\n双击播放' : '\n双击打开')));
      const thumb = el('div', 'kun-dir-thumb');
      // ★非图片/视频：给"扩展名徽标 + 两行文件名"的卡片（不再靠 emoji 兜底 —— 用户反馈那些 md 看着就是一张空卡）★
      const extOf = (n) => { const m = /\.([A-Za-z0-9]{1,5})$/.exec(n || ''); return m ? m[1].toLowerCase() : '文件'; };
      const isBadge = it.isDir || (!IMG.test(it.name) && !VID.test(it.name));
      thumb.style.cssText = isBadge
        ? (BADGE_FALLBACK + 'background:transparent;font-size:0;padding:13px 8px 4px;')
        : THUMB_FALLBACK;
      if (it.isDir) { card.classList.add('dir'); const b = el('span', 'kun-dir-badge', '📁'); b.textContent = '📁'; thumb.appendChild(b); }
      else if (IMG.test(it.name)) { const im = el('img', ''); im.src = fileUrl(full); im.loading = 'lazy'; im.style.cssText = MEDIA_FALLBACK; thumb.appendChild(im); nMedia++; }
      else if (VID.test(it.name)) { const vd = document.createElement('video'); vd.src = fileUrl(full); vd.preload = 'metadata'; vd.muted = true; vd.style.cssText = MEDIA_FALLBACK; thumb.appendChild(vd); nMedia++; }
      else if (AUD.test(it.name)) { card.classList.add('plain'); const b = el('span', 'kun-dir-ext', '♪ ' + extOf(it.name)); thumb.appendChild(b); }
      else { card.classList.add('plain'); const b = el('span', 'kun-dir-ext', extOf(it.name)); thumb.appendChild(b); }
      card.appendChild(thumb);
      const nm = el('div', 'kun-dir-name', it.name);
      nm.title = it.name; nm.style.cssText = NAME_FALLBACK;
      const mt = el('div', 'kun-dir-meta', it.isDir ? '文件夹' : fmtSize(it.size || 0));
      mt.style.cssText = META_FALLBACK;
      card.appendChild(nm); card.appendChild(mt);
      card.addEventListener('dblclick', () => { if (it.isDir) open({ kind: 'dir', path: full, title: it.name }); else open({ path: full, title: it.name }); });
      grid.appendChild(card);
    });
    applyThumbSize();          // 卡片都建好了，先按当前缩略图尺寸排一次（Ctrl+滚轮 就在这个基础上调）
    remember(p);
    say(rows.length + ' 项' + (nMedia ? '（' + nMedia + ' 个图片/视频）' : '') + ' · 双击就在这个面板里看/播');
    paint();
  }
  async function open(opt) {
    const o = opt || {};
    const p = String(o.path || '').trim();
    const url = String(o.url || '').trim();
    await flushDirty();                                   // 切走之前先把没存的手改存了（防丢）
    if (disposed) return;
    const kind = o.kind || (p ? pickKind(p) : 'web');
    // 画布上两类"没有文件"的东西走这两条支线（**必须排在 !p && !url 那道判空前面**，
    // 否则它们没有路径，会直接被当成"空预览"清屏 —— 用户点了个预设却什么都没发生）
    if (kind === 'preset') return openPresetMini(o);
    if (kind === 'text' && !p && !url) return openDoc(o);
    if (!p && !url) { showEmpty(); return; }
    cur = { kind: kind, path: p, url: url, title: String(o.title || ''), dirty: false, size: 0, mtime: 0 };
    paint();
    if (kind === 'text') return openText(p);
    if (kind === 'image') return openImage(p);
    if (kind === 'video' || kind === 'audio') return openMedia(p, kind);
    if (kind === 'dir') return openDir(p);                       // ★项目文件夹：摊开列出里面的东西（图片/视频带缩略图）
    if (kind === 'web') return openWeb(url || fileUrl(p));
    if (kind === 'pdf') return openPdf(p);                       // PDF：内核自带阅读器
    if (kind === 'office') return openOffice(p);                 // Office/WPS：先转 PDF 再内嵌显示（★2026-10-13）
    if (kind === 'opaque') return openOpaque(p);                 // 压缩包/安装包/二进制：提示卡 + 系统打开（★2026-10-13）
    showEmpty();
  }

  B.save.addEventListener('click', () => saveText());
  B.reread.addEventListener('click', () => {
    if (cur.kind === 'dir') { open({ kind: 'dir', path: cur.path, title: cur.title }); return; }   // 目录要按 dir 重开，否则会被当成文本
    if (cur.path) open({ path: cur.path, title: cur.title });
  });
  B.sysopen.addEventListener('click', () => {
    const t = cur.path || cur.url;
    if (!t) return;
    if (A && A.openPath) A.openPath(t); else say('没有宿主能力，打不开', 'warn');
  });
  B.reveal.addEventListener('click', () => { if (cur.path && A && A.revealPath) A.revealPath(cur.path); })
  // 2026-10-18（vw-ai 派单）：复制当前文件完整路径。web/url 态没有磁盘路径 ⇒ 退回复制 URL。
  //   两条兜底照本文件既有写法：navigator.clipboard 优先（真 GUI 聚焦时最稳），失败退 textarea+execCommand。
  const viewCopyText = (txt) => {
    try {
      const ta = document.createElement('textarea');
      ta.value = txt;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return !!ok;
    } catch (e) { return false; }
  };
  B.copypath.addEventListener('click', () => {
    const txt = String(cur.path || cur.url || '').trim();
    if (!txt) { say('还没打开文件，没路径可复制', 'warn'); return; }
    const ok = () => say('✓ 已复制：' + txt);
    const fb = () => { if (viewCopyText(txt)) ok(); else say('复制失败（窗口可能没聚焦）· 路径：' + txt, 'warn'); };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(txt).then(ok, fb); return; }
    } catch (e) { /* 落到 fb */ }
    fb();
  });;
  B.close.addEventListener('click', () => showEmpty());
  B.src.addEventListener('click', () => { cur.kind = 'text'; paint(); openText(cur.path); });
  B.preview.addEventListener('click', async () => {
    const p = cur.path;
    await flushDirty();
    if (disposed) return;
    cur.kind = 'web'; cur.dirty = false; paint();
    openWeb(fileUrl(p));
  });

  const api = {
    pid: pid,
    current: () => ({ kind: cur.kind, path: cur.path, url: cur.url, title: cur.title, dirty: !!cur.dirty }),
    show: (o) => open(o || {}),
    clear: () => showEmpty()
  };
  window.__kunViews = window.__kunViews || {};
  window.__kunViews[pid] = api;

  // 开场：先按上次看的文件恢复（有才开），否则空状态
  let last = '';
  try { last = localStorage.getItem(storeKey) || ''; } catch (e) { last = ''; }
  if (last) open({ path: last });
  else showEmpty();

  return () => {
    disposed = true;
    readSeq++;
    // 面板被销毁（切场景 / ⟳）前抢存一次手改 —— 不能让用户的心血随面板一起没
    if (cur.dirty && cur.kind === 'text' && cur.path && inner && inner.tagName === 'TEXTAREA' && F && F.write) {
      try { F.write(cur.path, inner.value); } catch (e) { /* ignore */ }
    }
    if (flashTimer) clearTimeout(flashTimer);
    if (window.__kunViews && window.__kunViews[pid] === api) delete window.__kunViews[pid];
    clearBody();
  };
};

// ============ embed：把"本机自带的网页工具"整页内嵌进面板（<webview>） ============
// 首个用户：视频工作流 窗口1 = ComfyUI 控制台（http://127.0.0.1:8189/，bridge.py 起的本地页面）。
// 为什么用 <webview> 而不是 iframe：与 harness / 官网预览一致，guest view 独立进程更稳，
// 且能带自己的 partition（一板一分区），不和引擎面板串味。
//
// 配置（都在场景 json 的面板对象里，全是选填、缺省即"没有这个按钮"）：
//   meta.url          必填，要内嵌的页面
//   meta.failHint     连不上时卡片里的一句话排查提示
//   meta.launchPath   桌面启动器的路径（快捷方式/exe）：点「🖥 桌面启动」就用宿主能力打开它
//   meta.launchLabel  桌面启动按钮文字（默认「🖥 桌面启动」）
//   meta.launchHint   点完桌面启动后卡片里显示的那句话
//   meta.embedToggle  false = 不显示「内置/取消内置」按钮（默认显示）
//   meta.offHint      「取消内置」后卡片里的说明（默认一句通用说明）
// 为什么桌面启动不用新开 IPC：宿主通用能力 app:open-path 走 shell.openPath（= ShellExecute），
// 传桌面 .lnk 就等价于双击快捷方式，所以这条路不用重启 GUI 就能加。
//
// 「内置 / 取消内置」（2026-09-20 加，用户要求"比较灵活"）：取消内置 = 把 <webview> 真的摘掉
// （不是隐藏）——不再有 guest 进程、也不会有第二份轮询；选择记在 localStorage，⟳/切场景都记得住。
// 内嵌页面的 UA：Electron 默认 UA 尾巴上挂着 "Electron/43.4.0"，有的站点一看就把页面盖成
// 「使用环境异常 / 建议使用我们的官方产品」弹窗（DeepSeek 网页版 2026-09-20 实测如此）。
// meta.userAgent 写 "chrome" ⇒ 换成一条**纯 Chrome UA**，Chrome 版本取当前 Electron 真实内核版本
// （process.versions.chrome，不写死、不撒谎）；也可以直接写完整 UA 字符串；不写 = 不动（用默认）。
// 为什么用函数声明而不是顶层 const/let：renderers.js 会被反复 ⟳ 重新求值，顶层 const 会重复声明报错。
function resolveEmbedUA(v) {
  if (!v) return '';
  if (v !== 'chrome' && v !== true) return String(v);
  var ver = '';
  try { ver = (typeof process !== 'undefined' && process.versions && process.versions.chrome) || ''; } catch (e) { ver = ''; }
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/'
    + (ver || '<IP>') + ' Safari/537.36';
}

// ==========================================================================================
// 2026-10-19 22:5x（宿主：「左边点开视频，右边直接说『总结这个』就行」· dg-dsh 派单）
//   当前视频同步：只在 **B站场景的 embed 面板** 上，每 1.5s 看一次 webview 的 URL，
//   抽 BV 号 + document.title，写到 `引擎\场景项目信息\B站\当前视频.json`（AI 侧已约定读它）。
//   ⛔ 不动 src / 不 reload / 不往页面里注入；⛔ 只在内容变化时写盘；⛔ 只认 bilibili 场景。
//   ⛔ 失败一律静默（同步挂了绝不影响看视频）。
// ==========================================================================================
function startBiliTrack(wv, meta) {
  try {
    var scene = String((meta && meta.scenario) || '');
    if (scene !== 'bilibili') return;                        // 别的场景嵌网页一律不装
    if (window.__biliTrack && window.__biliTrack.stop) window.__biliTrack.stop();   // 幂等：只跑一个
    var OUT = '<盘根>\\DSH\\引擎\\场景项目信息\\B站\\当前视频.json';
    var last = '', timer = null, alive = true, seenInDoc = false;
    function iso() {
      var d = new Date();
      var off = -d.getTimezoneOffset(), oh = Math.floor(Math.abs(off) / 60), om = Math.abs(off) % 60;
      var p = function (n) { return (n < 10 ? '0' : '') + n; };
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' +
        p(d.getMinutes()) + ':' + p(d.getSeconds()) + (off >= 0 ? '+' : '-') + p(oh) + ':' + p(om);
    }
    function write(bv, url, title) {
      if (!url) return;                                       // webview 还没就绪 ⇒ 不写（免得刷一堆空记录）
      // ⚠ 2026-10-19 自查修的 bug：原来拿**整个 JSON**（含 at）比 ⇒ 每轮都不同 ⇒ 一直在刷盘。
      //   现在只比 bv+url+title；at 只记"这次写入的时间"。
      var key = String(bv) + '|' + url + '|' + String(title || '');
      if (key === last) return;
      var txt = JSON.stringify({ bv: bv, url: url, title: String(title || ''), at: iso() });
      // （内容没变已在上面按 key 拦掉；这句保留只为兼容旧注释，不会命中）
      last = key;
      try {
        if (window.app && window.app.file && window.app.file.write) {
          Promise.resolve(window.app.file.write(OUT, txt + '\n')).catch(function () { /* 静默 */ });
        }
      } catch (e) { /* 静默 */ }
    }
    function stop() { alive = false; if (timer) { clearInterval(timer); timer = null; } window.__biliTrack = null; }
    function tick() {
      if (!alive) return;
      var inDoc = document.body.contains(wv);
      if (inDoc) seenInDoc = true;                                  // 挂上过一次才算“活过”
      else if (seenInDoc) { stop(); return; }                       // 曾经挂上 → 现在没了 ⇒ 面板销毁/场景切走
      else return;                                                 // 还没挂上 ⇒ 先等（别把自己判死）
      var url = '';
      try { url = (wv.getURL && wv.getURL()) || ''; } catch (e) { url = ''; }
      if (!url) return;
      var m = /\/video\/(BV[0-9A-Za-z]+)/.exec(url);
      var bv = m ? m[1] : null;
      var done = function (t) { if (alive) write(bv, url, t); };
      // 2026-10-19 自查修：原来首页直接 done('') 不取 title ⇒ 文件里 title 永远是空串。
      //   现在统一走下面的"取 title"路径（bv=null 也照样取，契约里两态都有 title）。
      try {
        Promise.resolve(wv.executeJavaScript('document.title')).then(function (t) { done(t); }).catch(function () { done(''); });
      } catch (e) { done(''); }
    }
    timer = setInterval(tick, 1500);
    window.__biliTrack = { stop: stop, at: Date.now(), out: OUT };
    // 2026-10-19 23:4x（宿主：打字/滚动/选中都行，就是点了不跳转）——**换方式**：不依赖弹窗策略，
    //   直接在页面里接管"新窗口链接"：点 a[target=_blank] ⇒ 当前页面打开（location.href）。幂等、失败静默。
    var LINKFIX = '(function(){try{if(window.__dshLinkFix)return "ok";window.__dshLinkFix=1;'
      + 'document.addEventListener("click",function(e){try{'
      + 'var a=e.target&&e.target.closest?e.target.closest("a[href]"):null;if(!a)return;'
      + 'var h=a.getAttribute("href")||"";'
      + 'if(!h||h==="#"||h.indexOf("javascript:")===0||h.indexOf("#")===0)return;'
      + 'if(a.target==="_blank"||!a.target){e.preventDefault();location.href=a.href;}'
      + '}catch(_){}},true);return "ok";}catch(e){return "err";}})()';
    function installLinkFix() {
      try { Promise.resolve(wv.executeJavaScript(LINKFIX)).catch(function () {}); } catch (e) { /* ignore */ }
    }
    try { wv.addEventListener('did-finish-load', function () { installLinkFix(); }); } catch (e) {}
    installLinkFix();
    tick();
    if (window.console) console.log('[biliTrack] 已启动 ⇒ ' + OUT);
  } catch (e) { /* 静默 */ }
}

// ==========================================================================================
// 2026-10-19 23:2x（bv-ai 派单）—— 临时点击探针，用来判断"点击到底进没进 guest"
//   写到 `引擎\场景项目信息\B站\_点击探针.json`（⚠ 临时文件，定位完就删；不污染 AI 认的 当前视频.json）
//   采：① guest 内的 document 级 click 计数与最近一次 target ② a[target=_blank] 数量
//       ③ 屏幕中心点 elementFromPoint（guest 内）④ 同一位置在**宿主页面**里的 elementFromPoint（看有没有东西盖住 webview）
// ==========================================================================================
function startBiliProbe(wv, meta) {
  try {
    if (String((meta && meta.scenario) || '') !== 'bilibili') return;
    if (window.__biliProbe && window.__biliProbe.stop) window.__biliProbe.stop();
    var OUT = '<盘根>\\DSH\\引擎\\场景项目信息\\B站\\_点击探针.json';
    var last = '', timer = null, alive = true, seen = false, injected = false;
    var INJECT = '(function(){try{if(window.__dshProbe)return "exists";window.__dshProbe={n:0,last:""};'
      + 'document.addEventListener("click",function(e){try{window.__dshProbe.n++;var el=e.target||{};'
      + 'var t=(el.tagName||"?")+"#"+(el.id||"")+"."+String(el.className||"");window.__dshProbe.last=t.slice(0,140);}catch(_){}} ,true);'
      + 'return "ok";}catch(e){return "err:"+String(e&&e.message||e);}})()';
    var READ = '(function(){try{var p=window.__dshProbe||{};'
      + 'var a=document.querySelectorAll("a[target=_blank]").length;'
      + 'var el=null;try{el=document.elementFromPoint((innerWidth||800)/2,(innerHeight||600)/2);}catch(_){}'
      + 'var mid=el?((el.tagName||"?")+"#"+(el.id||"")+"."+String(el.className||"")):"";'
      + 'return JSON.stringify({clicks:p.n||0,last:p.last||"",ab:a,mid:mid.slice(0,140)});'
      + '}catch(e){return JSON.stringify({err:String(e&&e.message||e)});}})()';
    function stop() { alive = false; if (timer) { clearInterval(timer); timer = null; } window.__biliProbe = null; }
    function tick() {
      if (!alive) return;
      var inDoc = document.body.contains(wv);
      if (inDoc) seen = true; else if (seen) { stop(); return; } else return;
      if (!injected) { injected = true; try { Promise.resolve(wv.executeJavaScript(INJECT)).catch(function () {}); } catch (e) {} }
      var r = null;
      try { r = wv.getBoundingClientRect(); } catch (e) { r = null; }
      var top = '', rect = '';
      if (r && r.width > 8 && r.height > 8) {
        rect = Math.round(r.left) + ',' + Math.round(r.top) + ',' + Math.round(r.width) + 'x' + Math.round(r.height);
        try {
          var he = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          top = he ? (String(he.tagName || '?').toLowerCase() + '#' + (he.id || '') + '.' + String(he.className || '')) : '';
        } catch (e) { top = 'err'; }
      }
      try {
        Promise.resolve(wv.executeJavaScript(READ)).then(function (s) {
          var g = {};
          try { g = JSON.parse(String(s || '{}')); } catch (e) { g = { parse: 'fail' }; }
          var obj = { at: Date.now(), clicks: g.clicks || 0, last: g.last || '', ab: g.ab, mid: g.mid || '',
                      hostTop: top, rect: rect, pe: (wv.style.pointerEvents || '(none-set)'), op: (wv.style.opacity || '(none-set)') };
          var txt = JSON.stringify(obj);
          if (txt !== last) {
            last = txt;
            try { if (window.app && window.app.file && window.app.file.write) Promise.resolve(window.app.file.write(OUT, txt + '\n')).catch(function () {}); } catch (e) {}
          }
        }).catch(function () {});
      } catch (e) { /* 静默 */ }
    }
    timer = setInterval(tick, 1500);
    window.__biliProbe = { stop: stop, out: OUT };
    tick();
  } catch (e) { /* 静默 */ }
}

// ==========================================================================================
// 2026-10-19 23:2x（宿主：启动动画要可选）—— 外壳侧"播放层"
//   ① 启动时读 <DSH根>\外壳\data\boot-animation.json 的 id ⇒ 给 #boot-overlay 加 data-anim
//      （文件不存在/坏了 ⇒ 一律回落 classic，⛔ 绝不让启动失败）
//   ② window.__bootPreview(id)：把 overlay 亮出来按 id 播一遍，1.8 秒后收起（给插件点选用）
//   ⛔ 不碰 boot 逻辑（__bootPaint / __bootFinish / 超时 / 重试全在 renderer.js，一个字没动）
// ==========================================================================================
(function bootAnimRegistry() {
  var CFG = '<盘根>\\DSH\\外壳\\data\\boot-animation.json';
  // 2026-10-20（宿主：把片头视频做成启动动画）—— 视频铺满 overlay（muted 自动播放才允许），
  //   其余（底部光带/百分比/立即进入）由 CSS 叠在上面；只在 id=video 时挂，别的动画会把它摘掉。
  function ensureBootVideo(id) {
    try {
      var ov = document.getElementById('boot-overlay');
      if (!ov) return;
      var v = ov.querySelector('.boot-video');
      // 2026-10-20：支持多个视频动画 —— 按 id 选文件（video=线条睁眼鲸鱼 3D · slogan=为理想奋斗）
      var VID_SRC = {
        video: '../renderer/assets/boot-video.mp4',
        slogan: '../renderer/assets/boot-video-slogan.mp4'
      };
      var want = VID_SRC[id] || '';
      if (!want) { if (v) v.remove(); return; }
      if (v && v.getAttribute('data-anim-src') === want) { try { v.currentTime = 0; v.play(); } catch (e) {} return; }
      if (v) { try { v.remove(); } catch (e) {} v = null; }
      var el2 = document.createElement('video');
      el2.className = 'boot-video';
      el2.setAttribute('data-anim-src', want);
      el2.src = want;
      el2.autoplay = true; el2.muted = true; el2.playsInline = true;
      el2.setAttribute('muted', '');
      el2.setAttribute('playsinline', '');
      ov.insertBefore(el2, ov.firstChild);
      try { el2.play(); } catch (e) { /* 自动播放被拒也没关系，画面会在下次交互开始 */ }
    } catch (e) { /* 静默 */ }
  }
  function apply(id) {
    try {
      var ov = document.getElementById('boot-overlay');
      if (!ov) return false;
      ov.setAttribute('data-anim', String(id || 'classic'));
      ensureBootVideo(String(id || "classic"));
      return true;
    } catch (e) { return false; }
  }
  try {
    var F = window.app && window.app.file;
    if (F && F.read) {
      Promise.resolve(F.read(CFG)).then(function (r) {
        var txt = (typeof r === 'string') ? r : ((r && (r.text || r.content)) || '');
        var id = 'classic';
        try { var j = JSON.parse(txt); if (j && j.id) id = String(j.id); } catch (e) { /* 坏文件 ⇒ classic */ }
        apply(id);
      }).catch(function () { apply('classic'); });
    }
  } catch (e) { /* 读配置失败 ⇒ 什么都不做 = classic */ }
  window.__bootPreview = function (id) {
    try {
      var ov = document.getElementById('boot-overlay');
      if (!ov) return false;
      var play = function (real) {
        var rid = String(real || 'classic');
        ov.classList.remove('hide', 'err');
        ov.setAttribute('data-anim', rid);
        ensureBootVideo(rid);
        window.__bootId = rid;
        if (window.__bootPaint) {
          window.__bootPaint({ stage: 'anim', pct: 42, text: '启动动画预览：' + rid, detail: '1.8 秒后自动收起' });
        }
        setTimeout(function () {
          try { if (window.__bootFinish) window.__bootFinish(); else ov.classList.add('hide'); } catch (e) { /* ignore */ }
        }, (rid === 'video') ? 7500 : 1800);   // 2026-10-20：视频片头 7.5s 才能看到结尾
      };
      if (id) { play(id); return true; }
      // 2026-10-19 23:5x（宿主：设置里改了但预览没变）—— 不传 id 时**现读一遍配置**：
      //   插件里刚点完卡片，菜单里的预览立刻就是新的（不用等下次启动）。
      var F = window.app && window.app.file;
      if (F && F.read) {
        Promise.resolve(F.read(CFG)).then(function (r) {
          var txt = (typeof r === 'string') ? r : ((r && (r.text || r.content)) || '');
          var cur = 'classic';
          try { var j2 = JSON.parse(txt); if (j2 && j2.id) cur = String(j2.id); } catch (e) { /* classic */ }
          play(cur);
        }).catch(function () { play(ov.getAttribute('data-anim') || 'classic'); });
      } else {
        play(ov.getAttribute('data-anim') || 'classic');
      }
      return true;
    } catch (e) { return false; }
  };
})();

// ==========================================================================================
// 2026-10-20（宿主：把常用网站的"智能抠图"做成**本地**工具）—— 场景「抠图」的主面板
//   引擎：本地 venv 里的 rembg（主进程 app.cut.run 起一次进程，算完就退，不常驻；图片不出本机）。
//   图片来源：① 左边「文件管理」里单击图片 ⇒ 走 window.__kunViews[面板id].show({path}) 送进来
//            ② 面板上的「选择图片…」(app.pickFile 系统对话框) ③ 直接把图片拖进来 (app.filePath)
//   输出：同目录 `<原名>_抠图.png`（带透明通道），旁边给 复制路径 / 定位 / 系统打开。
// ==========================================================================================
// 2026-10-20（宿主：「不要做成场景，做成一个小工具放在 CPU 左边，剪刀图标和其它图标风格一致」
//            + 「只有开始抠图吗，有没有橡皮或者扩选」）—— 顶栏「本地抠图」小工具
//   · 按钮：.titlebar-controls 里、负载胶囊（#tbs-load）**左边**；16px 线稿剪刀，与手机/月亮同一套 .tb-btn
//   · 弹层：居中（最宽 980、最高 88vh），左原图右结果 = 一块可精修的画布
//   · 引擎：<DSH根>\工具\抠图（rembg，离线）→ app.cut.run；读/存 PNG → app.cut.read / app.cut.write
//   · 精修（答宿主的问题：自动抠图只是第一步）：
//       橡皮擦 = 把不要的地方擦成透明；恢复笔 = 把擦掉/误抠的地方补回来（按自动结果的 alpha）
//       扩选 +N / 缩减 -N = 边缘整体外扩 / 内收 N 像素；羽化 N = 边缘过渡变软
//       撤销 / 重置（回到自动结果）/ 保存（覆盖 <原名>_抠图.png）/ 复制路径 / 定位
//   ⚠ 只有点过「✂ 自动抠图」之后才有画布可修；编辑全在本地 canvas，不联网。
// ==========================================================================================
(function cutToolTopbar() {
  // ⟳ 重注入时：把上一份的按钮 / 弹层拆掉再建新的 —— 否则旧按钮还绑着旧闭包（点它跑的是旧代码）
  if (window.__cutTool) {
    try {
      var ob = document.getElementById('btn-cut'); if (ob && ob.parentNode) ob.parentNode.removeChild(ob);
      var om = document.querySelector('.cut-mask'); if (om && om.parentNode) om.parentNode.removeChild(om);
    } catch (e) { /* ignore */ }
  }
  window.__cutTool = true;
  var K = window.app || {};
  var C = K.cut || null;
  var A = K.app || {};

  // ---------- 顶栏按钮（剪刀线稿，风格同 #btn-remote / #btn-theme）----------
  var ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">'
    + '<circle cx="4.3" cy="12.05" r="1.85" stroke="currentColor" stroke-width="1.25"/>'
    + '<circle cx="11.7" cy="12.05" r="1.85" stroke="currentColor" stroke-width="1.25"/>'
    + '<path d="M5.7 10.55 11.4 2.2M10.3 10.55 4.6 2.2" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>'
    + '</svg>';
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tb-btn tb-tools';
  btn.id = 'btn-cut';
  btn.title = '本地抠图（rembg · 离线，图片不出本机）';
  btn.innerHTML = ICON;
  btn.addEventListener('click', function (ev) { ev.stopPropagation(); open(); });

  function place() {
    var controls = document.querySelector('#titlebar .titlebar-controls');
    if (!controls) return;
    var load = document.getElementById('tbs-load');
    if (load && load.parentNode === controls) {
      if (btn.nextSibling !== load) controls.insertBefore(btn, load);
    } else if (!btn.parentNode) {
      controls.insertBefore(btn, controls.firstChild);
    }
  }
  place();
  var tries = 0;
  var t = setInterval(function () { place(); if (++tries > 25) clearInterval(t); }, 400);

  // ---------- 状态 ----------
  var S = {
    mask: null, modal: null, stat: null, cv: null, ctx: null, tools: null,
    src: '', out: '', model: 'isnet-anime',
    // ★ pix = RGBA 工作副本。为什么不能只改画布 alpha：canvas 内部是预乘的，alpha 置 0 会把颜色也抹成 0，
    //   再"恢复笔"把 alpha 提回来就只剩黑色（宿主实测踩到）。⇒ 颜色以这份副本为准，画布只是显示。
    pix: null,
    autoAlpha: null, undo: [], mode: 'erase', brush: 26, radius: 6, busy: false, painting: false, last: null
  };
  var MODEL_NAME = {
    'isnet-anime': '二次元 / 插画（ISNet Anime）★',
    'isnet-general-use': '精细（ISNet 通用 · 照片用）',
    'silueta': '均衡（Silueta · 43MB）',
    'u2net': '通用（U2Net）',
    'u2net_human_seg': '人像（U2Net Human）',
    'u2netp': '轻量（u2netp）'
  };

  function mk(tag, cls, txt) { var n = document.createElement(tag); if (cls) n.className = cls; if (txt != null) n.textContent = txt; return n; }
  function setStat(txt, cls) { if (!S.stat) return; S.stat.textContent = txt || ''; S.stat.className = 'cut-stat' + (cls ? ' ' + cls : ''); }

  // ---------- 弹层 ----------
  function build() {
    if (S.mask) return;
    var mask = mk('div', 'cut-mask');
    var modal = mk('div', 'cut-modal');
    S.mask = mask; S.modal = modal;

    // 标题
    var h = mk('div', 'cut-h');
    h.appendChild(mk('span', 'cut-h-ico', '✂'));
    h.appendChild(mk('span', 'cut-h-t', '本地抠图'));
    h.appendChild(mk('span', 'cut-h-s', 'rembg · 离线 · 图片不出本机'));
    var x = mk('span', 'cut-x', '✕');
    x.title = '关闭（Esc）';
    x.addEventListener('click', close);
    h.appendChild(x);
    modal.appendChild(h);

    // 第一行：选图 / 抠图 / 模型 / 状态
    var bar = mk('div', 'cut-bar');
    var pickBtn = mk('button', 'file-refresh', '📂 选择图片…'); pickBtn.type = 'button';
    var runBtn = mk('button', 'file-refresh cut-run', '✂ 自动抠图'); runBtn.type = 'button';
    var sel = document.createElement('select'); sel.className = 'cut-sel';
    var chkW = document.createElement('label'); chkW.className = 'cut-chk'; chkW.title = 'alpha matting：发丝/绒毛更干净，但慢 5~10 倍';
    var chk = document.createElement('input'); chk.type = 'checkbox';
    chkW.appendChild(chk); chkW.appendChild(document.createTextNode(' 发丝精细'));
    S.stat = mk('span', 'cut-stat', '');
    var spacer = mk('span', 'grow');
    bar.appendChild(pickBtn); bar.appendChild(runBtn); bar.appendChild(sel); bar.appendChild(chkW); bar.appendChild(S.stat); bar.appendChild(spacer);
    modal.appendChild(bar);
    S.sel = sel; S.chk = chk; S.runBtn = runBtn;

    function fillModels(list) {
      var use = (list || []).filter(function (n) { return MODEL_NAME[n]; });
      if (!use.length) use = Object.keys(MODEL_NAME);
      sel.innerHTML = '';
      use.forEach(function (n) { var o = document.createElement('option'); o.value = n; o.textContent = MODEL_NAME[n]; sel.appendChild(o); });
      // 默认优先「二次元 / 插画」模型（宿主常用插画图；照片可以在下拉里换回 ISNet 通用）
      S.model = use.indexOf('isnet-anime') >= 0 ? 'isnet-anime'
        : (use.indexOf('isnet-general-use') >= 0 ? 'isnet-general-use' : use[0]);
      sel.value = S.model;
    }
    fillModels([]);
    sel.addEventListener('change', function () { S.model = sel.value; });
    sel.addEventListener('mousedown', function (e) { e.stopPropagation(); });

    // 画布：左「原图」右「结果（可精修）」—— 选完图马上能在左边看到图
    var stage = mk('div', 'cut-stage');
    var pL = mk('div', 'cut-pane');
    pL.appendChild(mk('div', 'cut-pane-h', '原图（只读）'));
    var origBox = mk('div', 'cut-imgbox');
    var orig = document.createElement('img');
    orig.className = 'cut-orig';
    orig.alt = '';
    orig.style.display = 'none';
    origBox.appendChild(orig);
    pL.appendChild(origBox);
    var pR = mk('div', 'cut-pane');
    var rHead = mk('div', 'cut-pane-h', '结果（在这块上涂）');
    pR.appendChild(rHead);
    var box = mk('div', 'cut-imgbox checker');
    var cvWrap = mk('div', 'cut-cvw');
    var cv = document.createElement('canvas');
    cv.className = 'cut-cv';
    var ring = mk('div', 'cut-ring');
    ring.style.display = 'none';
    cvWrap.appendChild(cv); cvWrap.appendChild(ring);
    box.appendChild(cvWrap);
    pR.appendChild(box);
    stage.appendChild(pL); stage.appendChild(pR);
    modal.appendChild(stage);
    S.cv = cv; S.ctx = cv.getContext('2d', { willReadFrequently: true });
    S.orig = orig; S.origBox = origBox; S.rHead = rHead; S.ring = ring; S.cvWrap = cvWrap;

    // 第二行：精修工具
    var tools = mk('div', 'cut-tools');
    S.tools = tools;
    var g1 = mk('div', 'cut-grp');
    var eraser = mk('button', 'file-refresh on', '🧽 橡皮擦'); eraser.type = 'button'; eraser.dataset.mode = 'erase';
    var brushB = mk('button', 'file-refresh', '🖌 恢复笔'); brushB.type = 'button'; brushB.dataset.mode = 'restore';
    eraser.title = '按住拖动：把不要的地方擦成透明';
    brushB.title = '按住拖动：把误擦/漏抠的地方按自动结果补回来';
    var sizeIn = document.createElement('input'); sizeIn.type = 'range'; sizeIn.min = '4'; sizeIn.max = '120'; sizeIn.value = '26'; sizeIn.className = 'cut-range'; sizeIn.title = '笔刷大小';
    g1.appendChild(eraser); g1.appendChild(brushB); g1.appendChild(sizeIn);
    [eraser, brushB].forEach(function (b) {
      b.addEventListener('click', function () {
        S.mode = b.dataset.mode;
        eraser.className = 'file-refresh' + (S.mode === 'erase' ? ' on' : '');
        brushB.className = 'file-refresh' + (S.mode === 'restore' ? ' on' : '');
      });
    });
    sizeIn.addEventListener('input', function () { S.brush = Number(sizeIn.value) || 26; });

    var g2 = mk('div', 'cut-grp');
    var nIn = document.createElement('input'); nIn.type = 'number'; nIn.min = '1'; nIn.max = '60'; nIn.value = '6'; nIn.className = 'cut-num'; nIn.title = '边缘外扩/内收的像素数';
    var growB = mk('button', 'file-refresh', '扩选'); growB.type = 'button'; growB.title = '把选区整体外扩 N 像素（补回被抠掉的边缘）';
    var shrinkB = mk('button', 'file-refresh', '缩减'); shrinkB.type = 'button'; shrinkB.title = '把选区整体内收 N 像素（去掉残留背景）';
    var fIn = document.createElement('input'); fIn.type = 'range'; fIn.min = '0'; fIn.max = '20'; fIn.value = '0'; fIn.className = 'cut-range'; fIn.title = '羽化半径（0 = 不羽化）';
    var fB = mk('button', 'file-refresh', '羽化'); fB.type = 'button'; fB.title = '按滑杆的半径把边缘过渡变软';
    g2.appendChild(nIn); g2.appendChild(growB); g2.appendChild(shrinkB); g2.appendChild(fIn); g2.appendChild(fB);

    var g3 = mk('div', 'cut-grp');
    var undoB = mk('button', 'file-refresh', '↶ 撤销'); undoB.type = 'button';
    var resetB = mk('button', 'file-refresh', '重置'); resetB.type = 'button'; resetB.title = '丢掉所有手改，回到刚自动抠完的样子';
    var saveB = mk('button', 'file-refresh', '💾 保存'); saveB.type = 'button'; saveB.title = '覆盖 <原名>_抠图.png';
    var copyB = mk('button', 'file-refresh', '⧉ 路径'); copyB.type = 'button';
    var revealB = mk('button', 'file-refresh', '📂 定位'); revealB.type = 'button';
    g3.appendChild(undoB); g3.appendChild(resetB); g3.appendChild(saveB); g3.appendChild(copyB); g3.appendChild(revealB);

    tools.appendChild(g1); tools.appendChild(g2); tools.appendChild(g3);
    modal.appendChild(tools);

    var hint = mk('div', 'cut-hint', '① 选图 → ② 自动抠图 → ③ 用橡皮擦 / 恢复笔 / 扩选缩减 / 羽化精修 → ④ 保存。也可以把图直接拖进来。');
    modal.appendChild(hint);

    mask.appendChild(modal);
    document.body.appendChild(mask);
    mask.addEventListener('click', function (ev) { if (ev.target === mask) close(); });
    document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && S.mask && S.mask.style.display !== 'none') close(); });

    // 拖图进来
    box.addEventListener('dragover', function (e) { e.preventDefault(); e.stopPropagation(); box.classList.add('drop-on'); });
    box.addEventListener('dragleave', function () { box.classList.remove('drop-on'); });
    box.addEventListener('drop', function (e) {
      e.preventDefault(); e.stopPropagation(); box.classList.remove('drop-on');
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      var p = '';
      try { p = (K.filePath && K.filePath(f)) || f.path || ''; } catch (err) { p = ''; }
      if (p) setSrc(p); else setStat('拖进来的文件拿不到完整路径 ⇒ 用「选择图片…」', 'bad');
    });

    // 画笔事件：圈出笔刷范围（能看见就说明事件是通的），按住拖 = 擦 / 补
    function showRing(ev) {
      try {
        var r = cv.getBoundingClientRect();
        if (!r.width || !S.ring) return;
        var d = Math.max(8, 2 * S.brush * (r.width / cv.width));
        S.ring.style.width = d + 'px'; S.ring.style.height = d + 'px';
        S.ring.style.left = (ev.clientX - r.left - d / 2) + 'px';
        S.ring.style.top = (ev.clientY - r.top - d / 2) + 'px';
        S.ring.style.display = '';
      } catch (e) { /* ignore */ }
    }
    function hideRing() { if (S.ring) S.ring.style.display = 'none'; }
    cv.addEventListener('pointerenter', showRing);
    cv.addEventListener('pointermove', function (ev) {
      showRing(ev);
      if (!S.painting) return;
      ev.preventDefault();
      paintAt(posOf(ev));
    });
    cv.addEventListener('pointerleave', function () { hideRing(); if (!S.painting) return; });
    cv.addEventListener('pointerdown', function (ev) {
      if (!S.autoAlpha) { setStat('先点「✂ 自动抠图」，有结果才能精修', 'bad'); return; }
      ev.preventDefault();
      try { pushUndo(); } catch (err) {
        setStat('画布不能编辑：' + ((err && err.message) || err), 'bad'); return;
      }
      S.painting = true; S.last = null;
      try { cv.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
      setStat((S.mode === 'erase' ? '🧽 橡皮擦' : '🖌 恢复笔') + ' · ' + S.brush + 'px 拖动中…');
      showRing(ev);
      paintAt(posOf(ev));
    });
    function endPaint() {
      if (S.painting) setStat('✓ 已改这一笔（可撤销）', 'ok');
      S.painting = false; S.last = null;
    }
    cv.addEventListener('pointerup', endPaint);
    cv.addEventListener('pointercancel', endPaint);

    pickBtn.addEventListener('click', pickFile);
    runBtn.addEventListener('click', runCut);
    undoB.addEventListener('click', undo);
    resetB.addEventListener('click', resetAll);
    saveB.addEventListener('click', save);
    copyB.addEventListener('click', function () {
      if (!S.out) { setStat('还没有结果', 'bad'); return; }
      try { navigator.clipboard.writeText(S.out); setStat('✓ 已复制结果路径', 'ok'); } catch (e) { /* ignore */ }
    });
    revealB.addEventListener('click', function () { if (S.out && A.revealPath) A.revealPath(S.out); });
    growB.addEventListener('click', function () { morph(Number(nIn.value) || 6, true); });
    shrinkB.addEventListener('click', function () { morph(Number(nIn.value) || 6, false); });
    fB.addEventListener('click', function () { feather(Number(fIn.value) || 0); });
    setToolsEnabled(false);
  }

  function setToolsEnabled(on) {
    if (!S.tools) return;
    var bs = S.tools.querySelectorAll('button');
    for (var i = 0; i < bs.length; i++) {
      var b = bs[i];
      var isSave = /保存|路径|定位/.test(b.textContent || '');
      b.disabled = (!on && !isSave);
      b.style.opacity = (!on && !isSave) ? '.5' : '';
    }
  }

  function open() {
    build();
    S.mask.style.display = '';
    refreshStatus();
  }
  function close() { if (S.mask) S.mask.style.display = 'none'; }

  function refreshStatus() {
    if (!C) { setStat('这个 GUI 版本还没有抠图通道 ⇒ 要重启一次工作台', 'bad'); return; }
    Promise.resolve(C.status()).then(function (s) {
      if (!s || !S.stat) return;
      if (s.models && s.models.length && S.sel) {
        S.sel.innerHTML = '';
        s.models.filter(function (n) { return MODEL_NAME[n]; }).forEach(function (n) {
          var o = document.createElement('option'); o.value = n; o.textContent = MODEL_NAME[n]; S.sel.appendChild(o);
        });
        if (s.models.indexOf('isnet-anime') >= 0) { S.model = 'isnet-anime'; S.sel.value = S.model; }
        else if (s.models.indexOf('isnet-general-use') >= 0) { S.model = 'isnet-general-use'; S.sel.value = S.model; }
      }
      if (!s.pyOk) setStat('引擎没装好：缺 ' + (s.exe || 'python.exe'), 'bad');
      else setStat(s.modelOk ? '引擎就绪 · 图片不出本机' : '引擎就绪 · 还没有模型文件', 'ok');
    }).catch(function (e) { setStat('读引擎状态失败：' + ((e && e.message) || e), 'bad'); });
  }

  function pickFile() {
    if (!K.pickFile) { setStat('这个 GUI 版本没有选文件通道（要重启一次工作台）', 'bad'); return; }
    Promise.resolve(K.pickFile()).then(function (p) { if (p) setSrc(p); }).catch(function () { /* 取消 */ });
  }

  function setSrc(p) {
    S.src = String(p || ''); S.out = ''; S.autoAlpha = null; S.pix = null; S.undo = [];
    if (S.cv) { S.ctx.clearRect(0, 0, S.cv.width, S.cv.height); S.cv.width = 1; S.cv.height = 1; }
    setToolsEnabled(false);
    // 左边直接把选中的图显示出来（CSP 的 img-src 放行了 file:，不需要过 IPC）
    if (S.orig) {
      if (S.src) {
        var u = 'file:///' + encodeURI(String(S.src).replace(/\\/g, '/')).replace(/^\/+/, '').replace(/#/g, '%23').replace(/\?/g, '%3F');
        S.orig.style.display = '';
        S.orig.onerror = function () { S.orig.style.display = 'none'; setStat('这张图读不出来（路径里可能有特殊字符）：' + S.src, 'bad'); };
        S.orig.src = u;
      } else {
        S.orig.style.display = 'none';
        S.orig.removeAttribute('src');
      }
    }
    if (S.rHead) S.rHead.textContent = '结果（透明底 · 可精修）';
    setStat(S.src ? ('已选：' + String(S.src).split(/[\\/]/).pop() + ' —— 点「✂ 自动抠图」') : '');
  }

  function runCut() {
    if (!C) { setStat('这个 GUI 版本还没有抠图通道 ⇒ 要重启一次工作台', 'bad'); return; }
    if (!S.src) { setStat('先选一张图片', 'bad'); return; }
    if (S.busy) return;
    S.busy = true; S.runBtn.disabled = true; setStat('抠图中…（首次会加载模型）');
    Promise.resolve(C.run(S.src, { model: S.model, matting: !!S.chk.checked })).then(function (r) {
      S.busy = false; S.runBtn.disabled = false;
      if (!r || !r.ok) { setStat('✗ ' + ((r && r.err) || '失败'), 'bad'); return; }
      S.out = r.out;
      setStat('✓ 自动抠图完成 · ' + (Math.round((r.ms || 0) / 100) / 10) + ' 秒 · 可以精修了', 'ok');
      if (S.rHead) S.rHead.textContent = '结果 · ' + String(r.out).split(/[\\/]/).pop();
      loadResult(r.out);
    }).catch(function (e) {
      S.busy = false; S.runBtn.disabled = false;
      setStat('✗ ' + ((e && e.message) || e), 'bad');
    });
  }

  function loadResult(p) {
    if (!C || !C.read) { setStat('缺 app.cut.read ⇒ 要重启一次工作台', 'bad'); return; }
    Promise.resolve(C.read(p)).then(function (r) {
      if (!r || !r.ok) { setStat('读结果失败：' + ((r && r.err) || ''), 'bad'); return; }
      var im = new Image();
      im.onload = function () {
        try {
          S.cv.width = im.naturalWidth; S.cv.height = im.naturalHeight;
          S.ctx.clearRect(0, 0, S.cv.width, S.cv.height);
          S.ctx.drawImage(im, 0, 0);
          var id0 = S.ctx.getImageData(0, 0, S.cv.width, S.cv.height);
          S.pix = new Uint8ClampedArray(id0.data);       // RGBA 工作副本（颜色以它为准）
          var n = S.cv.width * S.cv.height;
          S.autoAlpha = new Uint8ClampedArray(n);
          for (var i = 0; i < n; i++) S.autoAlpha[i] = S.pix[i * 4 + 3];
          S.undo = [];
          setToolsEnabled(true);
          if (S.rHead) S.rHead.textContent = '结果 · ' + String(S.out).split(/[\\/]/).pop() + ' · ' + S.cv.width + '×' + S.cv.height;
          setStat('✓ 可以精修：在右边这块上用橡皮擦 / 恢复笔涂', 'ok');
        } catch (e) {
          // 万一 getImageData 被拒（画布被标记跨域），至少把原因说出来，别让工具悄悄变灰
          setStat('画布不可编辑：' + ((e && e.message) || e), 'bad');
        }
      };
      im.onerror = function () { setStat('图解码失败', 'bad'); };
      im.src = r.dataUrl;
    }).catch(function (e) { setStat('读图异常：' + ((e && e.message) || e), 'bad'); });
  }

  // ---------- 画笔 ----------
  function posOf(ev) {
    var r = S.cv.getBoundingClientRect();
    return {
      x: Math.round((ev.clientX - r.left) * S.cv.width / r.width),
      y: Math.round((ev.clientY - r.top) * S.cv.height / r.height)
    };
  }
  function paintAt(p) {
    if (!p || !S.autoAlpha || !S.pix) return;
    try {
      var from = S.last || p;
      var dx = p.x - from.x, dy = p.y - from.y;
      var dist = Math.sqrt(dx * dx + dy * dy);
      var step = Math.max(1, Math.floor(S.brush / 3));
      var n = Math.max(1, Math.ceil(dist / step));
      for (var i = 0; i <= n; i++) dot(Math.round(from.x + dx * i / n), Math.round(from.y + dy * i / n));
      S.last = p;
      commit();
    } catch (e) {
      S.painting = false;
      setStat('涂不上去：' + ((e && e.message) || e), 'bad');
    }
  }
  // 把 S.pix 画回画布（只用于显示；真正的数据在 S.pix）
  function commit() {
    if (!S.pix) return;
    try { S.ctx.putImageData(new ImageData(S.pix, S.cv.width, S.cv.height), 0, 0); return; } catch (e) { /* 老内核 */ }
    var id = S.ctx.createImageData(S.cv.width, S.cv.height);
    id.data.set(S.pix);
    S.ctx.putImageData(id, 0, 0);
  }
  function dot(cx, cy) {
    if (!S.pix) return;
    var r = S.brush, W = S.cv.width, H = S.cv.height, p = S.pix;
    var x0 = Math.max(0, cx - r), y0 = Math.max(0, cy - r);
    var x1 = Math.min(W, cx + r + 1), y1 = Math.min(H, cy + r + 1);
    if (x1 <= x0 || y1 <= y0) return;
    var r2 = r * r;
    for (var y = y0; y < y1; y++) {
      for (var x = x0; x < x1; x++) {
        var ddx = x - cx, ddy = y - cy;
        if (ddx * ddx + ddy * ddy > r2) continue;
        var i = (y * W + x) * 4 + 3;
        if (S.mode === 'erase') p[i] = 0;          // 只动 alpha；颜色在 S.pix 里留着 ⇒ 恢复笔提回来还是原色
        else p[i] = S.autoAlpha[(y * W) + x];
      }
    }
  }

  // ---------- 撤销 / 重置 ----------
  function alphaCopy() {
    if (!S.pix) return null;
    var a = new Uint8ClampedArray(S.cv.width * S.cv.height);
    for (var i = 0; i < a.length; i++) a[i] = S.pix[i * 4 + 3];
    return a;
  }
  function pushUndo() {
    if (!S.autoAlpha || !S.pix) return;
    S.undo.push(alphaCopy());
    if (S.undo.length > 12) S.undo.shift();
  }
  function applyAlpha(a) {
    if (!S.pix || !a) return;
    for (var i = 0; i < a.length; i++) S.pix[i * 4 + 3] = a[i];
    commit();
  }
  function undo() {
    if (!S.undo.length) { setStat('没有可撤销的了', 'bad'); return; }
    applyAlpha(S.undo.pop());
    setStat('↶ 已撤销一步', 'ok');
  }
  function resetAll() {
    if (!S.autoAlpha) return;
    pushUndo();
    applyAlpha(S.autoAlpha);
    setStat('已重置为自动抠图结果', 'ok');
  }

  // ---------- 扩选 / 缩减（可分离形态学，O(N·r)）----------
  function morph(r, dilate) {
    if (!S.autoAlpha || !S.pix) { setStat('先自动抠图', 'bad'); return; }
    var W = S.cv.width, H = S.cv.height, n = W * H;
    var d = S.pix;
    var a = new Uint8ClampedArray(n), tmp = new Uint8ClampedArray(n), out = new Uint8ClampedArray(n);
    for (var i = 0; i < n; i++) a[i] = d[i * 4 + 3];
    var best, k, v, x, y;
    for (y = 0; y < H; y++) {
      for (x = 0; x < W; x++) {
        best = dilate ? 0 : 255;
        for (k = -r; k <= r; k++) {
          var xx = x + k; if (xx < 0 || xx >= W) continue;
          v = a[y * W + xx];
          if (dilate ? v > best : v < best) best = v;
        }
        tmp[y * W + x] = best;
      }
    }
    for (y = 0; y < H; y++) {
      for (x = 0; x < W; x++) {
        best = dilate ? 0 : 255;
        for (k = -r; k <= r; k++) {
          var yy = y + k; if (yy < 0 || yy >= H) continue;
          v = tmp[yy * W + x];
          if (dilate ? v > best : v < best) best = v;
        }
        out[y * W + x] = best;
      }
    }
    pushUndo();
    for (i = 0; i < n; i++) d[i * 4 + 3] = out[i];
    commit();
    setStat((dilate ? '扩选 +' : '缩减 -') + r + ' px', 'ok');
  }

  // ---------- 羽化（可分离盒式模糊）----------
  function feather(r) {
    if (!S.autoAlpha || !S.pix) { setStat('先自动抠图', 'bad'); return; }
    if (!r) { setStat('羽化半径是 0，用右边滑杆调一下', 'bad'); return; }
    var W = S.cv.width, H = S.cv.height, n = W * H;
    var d = S.pix;
    var a = new Uint8ClampedArray(n), tmp = new Uint8ClampedArray(n), out = new Uint8ClampedArray(n);
    for (var i = 0; i < n; i++) a[i] = d[i * 4 + 3];
    var x, y, k, sum, cnt, x0, x1, y0, y1;
    for (y = 0; y < H; y++) {
      for (x = 0; x < W; x++) {
        sum = 0; cnt = 0;
        x0 = Math.max(0, x - r); x1 = Math.min(W - 1, x + r);
        for (k = x0; k <= x1; k++) { sum += a[y * W + k]; cnt++; }
        tmp[y * W + x] = sum / cnt;
      }
    }
    for (y = 0; y < H; y++) {
      for (x = 0; x < W; x++) {
        sum = 0; cnt = 0;
        y0 = Math.max(0, y - r); y1 = Math.min(H - 1, y + r);
        for (k = y0; k <= y1; k++) { sum += tmp[k * W + x]; cnt++; }
        out[y * W + x] = sum / cnt;
      }
    }
    pushUndo();
    for (i = 0; i < n; i++) d[i * 4 + 3] = out[i];
    commit();
    setStat('羽化 ' + r + ' px', 'ok');
  }

  // ---------- 保存 ----------
  function save() {
    if (!S.out || !S.pix) { setStat('还没有结果可存', 'bad'); return; }
    if (!C || !C.write) { setStat('缺 app.cut.write ⇒ 要重启一次工作台', 'bad'); return; }
    var url = '';
    try {
      var tc = document.createElement('canvas');
      tc.width = S.cv.width; tc.height = S.cv.height;
      var tg = tc.getContext('2d');
      var id = tg.createImageData(tc.width, tc.height);
      id.data.set(S.pix);
      tg.putImageData(id, 0, 0);
      url = tc.toDataURL('image/png');
    } catch (e) { setStat('导出失败：' + ((e && e.message) || e), 'bad'); return; }
    Promise.resolve(C.write(S.out, url)).then(function (r) {
      if (r && r.ok) setStat('✓ 已保存：' + r.path, 'ok');
      else setStat('✗ ' + ((r && r.err) || '保存失败'), 'bad');
    }).catch(function (e) { setStat('✗ ' + ((e && e.message) || e), 'bad'); });
  }
})();

// ==========================================================================================
// 2026-10-20（dg-dsh 派单）—— 顶栏「本地模型」开关（**只在主窗口**）
//   状态：app.localmodel.status() → {running,pid,vramFreeMb,modelReady}（亮=开 / 灰=关）
//   点击：app.localmodel.toggle()（脚本最多 90s：启动要等 /health + 真出字；启动中显示 loading）
//   悬停：本地 Qwen2.5-7B（GPU 39 字/秒）· 显存空闲 N MB · 不用时关掉释放
//   失败：把脚本 stderr 最后一行弹出来（常见：显存不足 <5500MB）
//   ⛔ 不动引擎、不动 profile：只调 <DSH根>\工具\本地模型.mjs
// ==========================================================================================
(function localModelTopbar() {
  var LM = window.app && window.app.localmodel;
  // 只在主窗口（分离窗口是一窗一场景，别让这个开关重复出现）
  try { if (/[?&]solo=1/.test(location.search || '')) return; } catch (e) { return; }

  // ⟳ 重注入：先拆旧按钮，避免旧闭包留着
  try { var old = document.getElementById('btn-localmodel'); if (old && old.parentNode) old.parentNode.removeChild(old); } catch (e) { /* ignore */ }

  var ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">'
    + '<rect x="2.7" y="2.7" width="10.6" height="10.6" rx="2.2" stroke="currentColor" stroke-width="1.25"/>'
    + '<rect x="5.5" y="5.5" width="5" height="5" rx="1.1" stroke="currentColor" stroke-width="1.25"/>'
    + '<path d="M6.4 2.7V1.3M9.6 2.7V1.3M6.4 14.7v-1.4M9.6 14.7v-1.4M2.7 6.4H1.3M2.7 9.6H1.3M14.7 6.4h-1.4M14.7 9.6h-1.4" stroke="currentColor" stroke-width="1.05" stroke-linecap="round"/>'
    + '</svg>';

  var st = { running: false, vram: null, modelReady: null, busy: false, err: '', at: 0 };
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tb-btn tb-tools lm-pill lm-off';
  btn.id = 'btn-localmodel';
  btn.innerHTML = ICON + '<span class="lm-txt">本地模型 关</span>';

  function toast(msg, bad) {
    try {
      var box = document.querySelector('.tbs-toasts');
      if (!box) { box = document.createElement('div'); box.className = 'tbs-toasts'; document.body.appendChild(box); }
      var t = document.createElement('div');
      t.className = 'tbs-toast' + (bad ? ' bad' : '');
      t.textContent = msg;
      box.appendChild(t);
      setTimeout(function () { t.classList.add('out'); setTimeout(function () { t.remove(); }, 320); }, 4600);
    } catch (e) { /* ignore */ }
  }

  function place() {
    var controls = document.querySelector('#titlebar .titlebar-controls');
    if (!controls) return;
    if (btn.parentNode !== controls) {
      // 2026-10-20（宿主报"最小化没反应"后）—— 挪到 **⟳ 左边**：离窗口控制区（─ □ ✕）远一点，
      //   以后 pill 再变宽也碰不到最小化/最大化/关闭那三颗。
      var ref = document.getElementById('btn-refresh') || document.getElementById('btn-plugins')
        || document.getElementById('btn-theme') || null;
      if (ref && ref.parentNode === controls) controls.insertBefore(btn, ref);
      else controls.appendChild(btn);
    }
  }

  function paint() {
    var on = !!st.running;
    btn.classList.toggle('lm-on', on && !st.busy);
    btn.classList.toggle('lm-off', !on && !st.busy);
    btn.classList.toggle('lm-busy', !!st.busy);
    btn.disabled = false;
    // 带字：开=绿「本地模型 开」/ 关=灰「本地模型 关」/ 忙=琥珀「启动中…」「停止中…」
    var txt = btn.querySelector('.lm-txt');
    if (txt) {
      txt.textContent = st.busy
        ? ('本地模型 ' + (on ? '停止中…' : '启动中…'))
        : ('本地模型 ' + (on ? '开' : '关'));
    }
    var vr = (typeof st.vram === 'number') ? ('显存空闲 ' + st.vram + ' MB') : '显存空闲 —';
    var tip = '本地 Qwen2.5-7B（GPU 39 字/秒）· ' + vr + ' · 不用时关掉释放';
    tip += on ? '\n（运行中 —— 点一下停掉，释放显存）' : '\n（点一下启动，约 10 秒）';
    if (st.busy) tip = '正在启动/停止本地模型…（最多 90 秒）';
    if (st.modelReady === false) tip += '\n⚠ 模型文件没找到（<盘根>\\deepseek\\models\\qwen2.5-7b）';
    if (st.err) tip += '\n⚠ ' + st.err;
    btn.title = tip;
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  function refresh() {
    if (!LM || !LM.status) { st.err = '这个 GUI 版本还没有本地模型通道（要重启一次工作台）'; paint(); return; }
    Promise.resolve(LM.status()).then(function (r) {
      if (!r) { st.err = '读不到状态'; paint(); return; }
      if (typeof r.vramFreeMb === 'number') st.vram = r.vramFreeMb;
      if (r.modelReady === false) st.modelReady = false; else st.modelReady = true;
      if (r.ok) { st.err = ''; st.running = !!r.running; st.at = Date.now(); }
      else st.err = r.err || '读不到状态';
      paint();
    }).catch(function (e) { st.err = (e && e.message) || String(e); paint(); });
  }

  function toggle() {
    if (st.busy) return;
    if (!LM || !LM.toggle) { st.err = '要重启一次工作台才有开关通道'; paint(); return; }
    st.busy = true; st.err = ''; paint();
    var t0 = Date.now();
    Promise.resolve(LM.toggle()).then(function (r) {
      st.busy = false;
      if (r && typeof r.vramFreeMb === 'number') st.vram = r.vramFreeMb;
      if (r && r.ok) {
        st.running = !!r.running;
        toast('本地模型：' + (st.running ? '已启动' : '已停止') + ' · ' + Math.round((Date.now() - t0) / 1000) + ' 秒', false);
      } else {
        if (r && typeof r.running === 'boolean') st.running = r.running;
        st.err = (r && r.err) || '切换失败';
        toast('本地模型切换失败：' + st.err, true);
      }
      paint();
    }).catch(function (e) {
      st.busy = false;
      st.err = (e && e.message) || String(e);
      toast('本地模型切换失败：' + st.err, true);
      paint();
    });
  }

  btn.addEventListener('click', function (ev) { ev.stopPropagation(); toggle(); });
  place();
  var tries = 0;
  var tm = setInterval(function () {
    place();
    if (++tries > 25) clearInterval(tm);
  }, 400);
  refresh();
  // 只在窗口有焦点时每 20 秒对一次状态（不额外养进程：脚本本身 0.2s 就跑完）
  setInterval(function () {
    if (document.hidden || !document.hasFocus()) return;
    if (st.busy) return;
    refresh();
  }, 20000);
  window.addEventListener('focus', function () { if (!st.busy) refresh(); });
  paint();
})();
