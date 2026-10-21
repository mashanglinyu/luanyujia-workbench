// ── 面板 file：文件管理（306 行，最小的一个完整面板）
// 摘自本机实现 `renderers.js` 的 Lrenderers.js–962。
// 脱敏：内部 API 名已去品牌化（kun → app）· 绝对路径 → <DSH根>/<工作区> · 个人名/客户名/站点 → 占位
// 1268
// ⚠ 摘录/单文件：脱离这套工作台不能直接运行（依赖壳注入的 app.* 实例与页面上下文）。

renderers.file = (body, meta, head) => {
  oaSyncScenario(meta);
  const K = window.app && window.app.oa;
  body.classList.add('file-panel');

  // ---- 工具 ----
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
  const joinPath = (a, b) => (/[\\/]$/.test(a) ? a + b : a + '/' + b);
  const parentPath = (p) => {
    const norm = String(p).replace(/[\\/]+$/, '');
    const idx = Math.max(norm.lastIndexOf('/'), norm.lastIndexOf('\\'));
    return idx > 0 ? norm.slice(0, idx) : norm;
  };

  // ---- 工具按钮（放进面板标题那一行：刷新 + 同步按钮开关）----
  const refreshBtn = el('button', 'file-refresh', '🔄 刷新');
  refreshBtn.title = '手动刷新文件列表与同步状态';
  refreshBtn.addEventListener('click', () => {
    refreshBtn.disabled = true;
    refreshBtn.textContent = '刷新中…';
    Promise.all([
      Promise.resolve(loadSync(true)),
      Promise.resolve(loadLocal(localPath)),
      Promise.resolve(loadCloud(cloudPath, true))
    ]).then(() => { refreshBtn.disabled = false; refreshBtn.textContent = '🔄 刷新'; })
      .catch(() => { refreshBtn.disabled = false; refreshBtn.textContent = '🔄 刷新'; });
  });
  // 同步按钮开关（默认隐藏推送/拉取按钮，防止误点；打开后才显示）
  let showSyncActs = false;
  const syncToggle = el('button', 'file-refresh sync-toggle off', '🔒 同步');
  syncToggle.title = '默认隐藏推送/拉取按钮，防止误点；打开后显示 ↑推送 / ↓拉取';
  syncToggle.addEventListener('click', () => {
    showSyncActs = !showSyncActs;
    syncToggle.textContent = showSyncActs ? '🔓 同步' : '🔒 同步';
    syncToggle.classList.toggle('on', showSyncActs);
    syncToggle.classList.toggle('off', !showSyncActs);
    loadSync();   // 重绘（含推送/拉取按钮显隐）
  });
  if (head) {
    head.classList.add('file-head');
    head.appendChild(el('span', 'stat-refresh', K ? '30秒' : '演示'));
    const headActs = el('div', 'file-head-acts');
    headActs.appendChild(refreshBtn);
    headActs.appendChild(syncToggle);
    head.appendChild(headActs);
  }

  // ---- 四个同步段（后端 / 管理后台 / 教师 / 家长 排成一行）----
  const segs = el('div', 'sync-segs');
  body.appendChild(segs);
  const msgEl = el('div', 'sync-msg', '');
  body.appendChild(msgEl);

  // ---- 左右两栏 ----
  const mkCol = (titleText) => {
    const root = el('div', 'file-col');
    const head = el('div', 'file-col-head');
    head.appendChild(el('span', 'file-col-title', titleText));
    const jumps = el('div', 'file-jumps');
    head.appendChild(jumps);
    root.appendChild(head);
    const crumbs = el('div', 'file-crumbs', '…');
    root.appendChild(crumbs);
    const list = el('div', 'file-list');
    root.appendChild(list);
    return { root, head, jumps, crumbs, list };
  };
  const localCol = mkCol('📁 本地');
  const cloudCol = mkCol('☁️ 云端');
  const cols = el('div', 'file-cols');
  cols.appendChild(localCol.root);
  cols.appendChild(cloudCol.root);
  body.appendChild(cols);

  // ---- 行 ----
  const mkRow = (ic, name, metaText, isDir, onOpen) => {
    const r = el('div', 'file-row' + (isDir ? ' dir' : ''));
    r.appendChild(el('span', 'file-ic', ic));
    r.appendChild(el('span', 'file-name', name));
    r.appendChild(el('span', 'file-meta', metaText));
    if (isDir) { r.title = '点击进入'; r.style.cursor = 'pointer'; }
    if (onOpen) r.addEventListener('click', onOpen);
    return r;
  };
  const mkEmpty = (txt) => el('div', 'file-empty', txt);

  let localPath = null, cloudPath = null, paths = null;
  let disposed = false;

  // ---- 同步状态（实时） ----
  const buildTitle = (m) => {
    if (m.status === 'missing-local') return '本地目录不存在：' + m.local;
    if (m.status === 'missing-remote') return '云端目录不存在：' + m.remote;
    if (m.inSync) return m.label + ' 已同步（本地 ' + m.localCount + ' · 云端 ' + m.remoteCount + ' 个文件）';
    let s = m.label + ' 待同步（本地 ' + m.localCount + ' · 云端 ' + m.remoteCount + ' 个文件）';
    if (m.push && m.push.length) s += '\n\n⬆️ 需推送（本地更新）：\n' + m.push.slice(0, 20).join('\n');
    if (m.pull && m.pull.length) s += '\n\n⬇️ 需拉取（云端更新）：\n' + m.pull.slice(0, 20).join('\n');
    return s;
  };
  const paintSync = (res) => {
    segs.innerHTML = '';
    if (!res || !res.ok) {
      const seg = el('div', 'sync-seg wide');
      seg.appendChild(el('span', 'seg-state off', '🟡 未连接服务器 · 演示'));
      segs.appendChild(seg);
      return;
    }
    const list = res.mappings || [];
    if (!list.length) {
      const seg = el('div', 'sync-seg wide');
      seg.appendChild(el('span', 'seg-state off', '未配置同步项'));
      segs.appendChild(seg);
      return;
    }
    list.forEach(m => {
      let dot = 'ok', state = '已同步';
      if (m.status === 'missing-local') { dot = 'warn'; state = '本地缺失'; }
      else if (m.status === 'missing-remote') { dot = 'warn'; state = '云端缺失'; }
      else if (!m.inSync) {
        const parts = [];
        if (m.pushTotal) parts.push('推' + m.pushTotal);
        if (m.pullTotal) parts.push('拉' + m.pullTotal);
        state = parts.join('·') || '有差异';
        dot = 'warn';
      }
      const seg = el('div', 'sync-seg');
      const top = el('span', 'seg-top');
      top.appendChild(el('span', 'seg-label', String(m.label || m.key).replace(/端$/, '')));
      top.appendChild(el('span', 'seg-dot ' + dot));
      seg.appendChild(top);
      seg.appendChild(el('span', 'seg-state ' + dot, state));
      // 有差异时提供一键推送/拉取（默认隐藏，需打开「同步」开关；未连接则仅展示）
      if (showSyncActs && m.status !== 'missing-local' && m.status !== 'missing-remote' && !m.inSync && K && K.sync && K.sync.push) {
        const acts = el('span', 'seg-acts');
        const pb = el('button', 'seg-btn', '↑');
        pb.title = '推送（本地 → 云端）：' + m.local;
        pb.addEventListener('click', () => doTransfer('push', m));
        const rb = el('button', 'seg-btn', '↓');
        rb.title = '拉取（云端 → 本地）：' + m.remote;
        rb.addEventListener('click', () => doTransfer('pull', m));
        acts.appendChild(pb);
        acts.appendChild(rb);
        seg.appendChild(acts);
      }
      seg.title = buildTitle(m);
      segs.appendChild(seg);
    });
  };
  const loadSync = (force) => {
    if (!K) return;
    K.sync.status(!!force).then(paintSync).catch(() => paintSync(null));
  };
  // 一键推送 / 拉取（复用云控台同步规则；执行后刷新状态）
  let busy = false, msgTimer = null;
  const toast = (txt, isErr) => {
    msgEl.textContent = (isErr ? '✗ ' : '') + txt;
    msgEl.className = 'sync-msg' + (isErr ? ' err' : ' ok');
    if (msgTimer) clearTimeout(msgTimer);
    msgTimer = setTimeout(() => { msgEl.textContent = ''; msgEl.className = 'sync-msg'; }, 6000);
  };
  const doTransfer = (mode, m) => {
    if (busy || !K || !K.sync) return;
    const dirTxt = mode === 'push' ? '推送' : '拉取';
    const cnt = mode === 'push' ? m.pushTotal : m.pullTotal;
    const ok = confirm('确认' + dirTxt + '「' + m.label + '」？\n' +
      (mode === 'push' ? '本地 → 云端：' + m.local + '\n→ ' + m.remote : '云端 → 本地：' + m.remote + '\n→ ' + m.local) +
      '\n将更新 ' + (cnt || 0) + ' 个文件（排除 node_modules/.git/dist/.env/*.log）');
    if (!ok) return;
    busy = true;
    refreshBtn.disabled = true;
    toast('正在' + dirTxt + '「' + m.label + '」…');
    const fn = mode === 'push' ? K.sync.push : K.sync.pull;
    fn(m.key).then(r => {
      busy = false;
      refreshBtn.disabled = false;
      if (r && r.ok) toast('✓ ' + dirTxt + '「' + (r.label || m.label) + '」完成，更新 ' + r.total + ' 个文件');
      else toast((r && r.err) || '操作失败', true);
      loadSync();
    }).catch(() => {
      busy = false;
      refreshBtn.disabled = false;
      toast('操作失败', true);
    });
  };

  // ---- 本地列 ----
  const loadLocal = (p) => {
    const target = p || localPath;
    if (!target) return;
    localPath = target;
    localCol.crumbs.textContent = target;
    localCol.crumbs.title = target;
    localCol.list.innerHTML = '';
    if (!K) { localCol.list.appendChild(mkEmpty('（无本地服务）')); return; }
    K.filesLocal(target).then(r => {
      if (disposed) return;
      localCol.crumbs.textContent = (r && r.base) || target;
      localCol.crumbs.title = (r && r.base) || target;
      localCol.list.innerHTML = '';
      if (parentPath(target) !== target) {
        localCol.list.appendChild(mkRow('↩️', '..', '上级目录', true, () => loadLocal(parentPath(target))));
      }
      if (!r || !r.ok) { localCol.list.appendChild(mkEmpty('无法读取：' + ((r && r.err) || '未知'))); return; }
      (r.rows || []).forEach(it => {
        localCol.list.appendChild(mkRow(it.isDir ? '📁' : '📄', it.name,
          it.isDir ? '目录' : fmtSize(it.size) + ' · ' + fmtTime(it.mtime),
          it.isDir, () => loadLocal(joinPath(target, it.name))));
      });
      if (!r.rows || !r.rows.length) localCol.list.appendChild(mkEmpty('（空目录）'));
    }).catch(() => {
      localCol.list.innerHTML = '';
      localCol.list.appendChild(mkEmpty('读取失败'));
    });
  };

  // ---- 云端列（SFTP） ----
  const loadCloud = (p, force) => {
    const target = p || cloudPath;
    if (!target) return;
    cloudPath = target;
    cloudCol.crumbs.textContent = target;
    cloudCol.crumbs.title = target;
    cloudCol.list.innerHTML = '';
    if (!K) { cloudCol.list.appendChild(mkEmpty('☁️ 演示')); return; }
    K.files(target, !!force).then(r => {
      if (disposed) return;
      cloudCol.crumbs.textContent = (r && r.base) || target;
      cloudCol.crumbs.title = (r && r.base) || target;
      cloudCol.list.innerHTML = '';
      if (parentPath(target) !== target) {
        cloudCol.list.appendChild(mkRow('↩️', '..', '上级目录', true, () => loadCloud(parentPath(target))));
      }
      if (!r || !r.ok || !r.real) {
        cloudCol.list.appendChild(mkEmpty('☁️ ' + (r && !r.real ? '未连接服务器 · 无真实数据' : ((r && r.err) || '无法读取'))));
        return;
      }
      (r.rows || []).forEach(it => {
        cloudCol.list.appendChild(mkRow(it.isDir ? '📁' : '📄', it.name,
          it.isDir ? '目录' : fmtSize(it.size) + ' · ' + fmtTime(it.mtime),
          it.isDir, () => loadCloud(joinPath(target, it.name))));
      });
      if (!r.rows || !r.rows.length) cloudCol.list.appendChild(mkEmpty('（空目录）'));
    }).catch(() => {
      cloudCol.list.innerHTML = '';
      cloudCol.list.appendChild(mkEmpty('读取失败'));
    });
  };

  // 云端快捷跳转
  const setupCloudJumps = () => {
    if (!paths || !K) return;
    const defs = [
      ['代码', paths.code], ['站点', paths.www], ['备份', paths.backups]
    ];
    defs.forEach(([label, p]) => {
      const b = el('button', 'file-jump', label);
      b.title = p;
      b.addEventListener('click', () => loadCloud(p));
      cloudCol.jumps.appendChild(b);
    });
  };

  // ---- 无桥接：静态演示 ----
  if (!K) {
    localCol.crumbs.textContent = '本地项目';
    cloudCol.crumbs.textContent = '/opt/oa';
    [['📁', 'backend/', '目录'], ['📁', 'web/', '目录'], ['📄', 'README.md', '5 KB']]
      .forEach(([ic, n, m]) => localCol.list.appendChild(el('div', 'file-row', ic + ' ' + n + ' ' + m)));
    [['📁', 'backend/', '目录'], ['📁', 'www/', '目录'], ['📄', 'app.js', '--']]
      .forEach(([ic, n, m]) => cloudCol.list.appendChild(el('div', 'file-row', ic + ' ' + n + ' ' + m)));
    return;
  }

  // ---- 初始化 + 轮询（20s：同步状态 + 当前目录） ----
  let timer = null;
  K.paths().then(pa => {
    paths = pa;
    setupCloudJumps();
    loadSync();
    loadLocal(pa.localRoot);
    loadCloud(pa.code);
  }).catch(() => { loadSync(); loadLocal(null); });
  // 目录/本地列表 30s 轮询；同步比对（较重，云端全量 walk）每 2 个周期 = 60s 一次；不可见暂停
  let syncTick = 0;
  const stopPoll = oaPoll(30000, () => {
    if (disposed) return;
    if (syncTick++ % 2 === 0) loadSync(false);
    loadLocal(localPath);
    loadCloud(cloudPath, false);
  });

  return () => { disposed = true; stopPoll(); };
};

// ============ log：真实日志（pm2 后端 / nginx / mysql，SSH 已连接则实时抓取；否则操作日志） ============