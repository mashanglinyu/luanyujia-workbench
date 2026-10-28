// 右上角「MCP」开关面板（自包含；被 renderers.js 动态加载，点标题栏 ⟳ 即整体重载）
// 数据来源与写入格式 = 引擎官方语义：profile patch 末尾追加 id 覆盖项 `disabled: true`。
//   ⚠ 一个文件只能有一个写入者：本文件与技能里的 mcp-switch.mjs 用同一套格式，别再用「# 注释」那套。
// 生效方式：引擎开了 patch 热重载（profiles\web\package.json: patchReload=live，hmr 监听该文件），
//   写盘后配置即时重放 ⇒ 相关 MCP 卸载/拉起；面板会话可能断一次，刷新界面即接回（会话记录不丢）。
(function () {
  'use strict';
  var FILE = '<工作台>\\引擎\\.dsh\\profiles\\web\\cordis.patch.yml';
  var MB = '# >>> MCP 开关（界面右上角「MCP」图标 或 mcp-switch.mjs 管理：disabled: true = 关掉这个 MCP）>>>';
  var ME = '# <<< MCP 开关 <<<';
  // ⚠ tools / est 两个数字**只许照实测抄**，别手拍：
  //   node "<工作台>\引擎\MCP\检查MCP.mjs"   ⇒ 每个 MCP 的工具数 + 「≈ N token/轮」
  //   （est 的公式与引擎一致：ceil(JSON.stringify(tools).length / 4) + 4，见引擎 packages\llm\token-meter\src\estimate.ts）
  //   2026-09-23：就是这里手拍的 30/14000 与漏改的「4 个 MCP」让面板显示出了错数字。
  var WEB = '网页版 AI（免费，按需开）';   // 同一 grp 值的行会收进同一张折叠卡片
  var openGrp = {};                        // 折叠状态（弹窗每次重绘都整块重建，状态必须放在外面）
  var lastMsg = '';                        // 最近一条提示（重绘时保留，别让"已写入"一闪就没）
  var MCP = [
    { id: 'mcp-blender',                 label: 'Blender',  tools: 32, est: 8902,  desc: '三维建模 / 改材质 / 读场景 / 渲染出图 / 导出 GLB·FBX' },
    { id: 'computer-use-cua-driver-mcp', label: '桌面操控', tools: 57, est: 26801, desc: '操控这台电脑：找窗口 / 点击 / 打字 / 截屏 / 摆位' },
    { id: 'mcp-jianying',                label: '剪映',     tools: 8,  est: 1271,  desc: '剪映草稿：识别视频 / 自动剪辑 / 字幕排版 / 批量出片' },
    { id: 'mcp-comfy',                   label: 'ComfyUI',  tools: 39, est: 14746, desc: '文生视频 / 图生视频（MiniMax H3 海螺）' },
    // 网页版 AI（v3.17，2026-09-23）：5 个站各一个独立 MCP，内核共用一份。
    // 每个只注册 1 个工具 ask（question / save_image / timeout_s），实测每站 ≈130 token/轮。
    // 数字虽小，但**每个会话每轮都注入**：不常用的站关掉就是白省（5 个全开 ≈660/轮）。
    // 它们**收进一张折叠卡片**（同一 grp 值 = 同一张卡；默认收起，点标题展开）——5 行平铺太占地方。
    { id: 'mcp-webai-deepseek', label: '网页版·DeepSeek', tools: 1, est: 136, grp: WEB, desc: '免费问 DeepSeek 网页版：长文本 / 写代码（最难的那种先问它）' },
    { id: 'mcp-webai-doubao',   label: '网页版·豆包',     tools: 1, est: 132, grp: WEB, desc: '免费问豆包：生图 / 生视频 / 日常问答' },
    { id: 'mcp-webai-tongyi',   label: '网页版·通义千问', tools: 1, est: 130, grp: WEB, desc: '免费问通义：生图（备用）/ 中文长文（正文有时夹侧栏文字）' },
    { id: 'mcp-webai-chatglm',  label: '网页版·智谱清言', tools: 1, est: 128, grp: WEB, desc: '免费问智谱：写代码（主力）/ 结构化输出' },
    { id: 'mcp-webai-kimi',     label: '网页版·Kimi',     tools: 1, est: 132, grp: WEB, desc: '⚠ 当前打不进输入框（2026-09-23 实测），先别开' }
  ];
  var ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<rect x="6.1" y="6.1" width="3.8" height="3.8" rx="1.1" stroke="currentColor" stroke-width="1.3"/>' +
    '<path d="M8 2.2v3.2M8 10.6v3.2M2.2 8h3.2M10.6 8h3.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>' +
    '<circle cx="8" cy="2.1" r="1.15" fill="currentColor"/><circle cx="8" cy="13.9" r="1.15" fill="currentColor"/>' +
    '<circle cx="2.1" cy="8" r="1.15" fill="currentColor"/><circle cx="13.9" cy="8" r="1.15" fill="currentColor"/></svg>';
  // 千位以下**必须**原样显示：整千化会把 130 显示成 "0k"（网页版 AI 那几个站全是三位数）
  function k(n) {
    if (n < 1000) return String(n);
    return (n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, '') + 'k';
  }
  // ⚠ 样式表**每次都要重建**，不许"已存在就 return"：
  //   标题栏 ⟳（reloadScene → hotReloadRenderers）是**热更新脚本、不重载页面**，
  //   上一版注入的 <style id="mcp-panel-style"> 会一直留在 head 里 —— 早退就等于新加的规则永远不生效。
  //   2026-09-23 的现场：折叠卡片新加的 .mcp-grp* 没注入 → 标题行是个裸 <button>，浏览器默认白底。
  function style() {
    var old = document.getElementById('mcp-panel-style');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var s = document.createElement('style'); s.id = 'mcp-panel-style';
    s.textContent = [
      '.mcp-note{border:1px solid rgba(79,140,255,.20);background:rgba(79,140,255,.06);border-radius:10px;padding:9px 11px;margin:6px 0 10px;color:#a9b4c6;font-size:12px;line-height:1.65}',
      '.mcp-note.dim{border-color:var(--border,rgba(255,255,255,.12));background:rgba(255,255,255,.02);color:#8b93a7;font-size:11px;line-height:1.6}',
      '.mcp-row{position:relative;border:1px solid var(--border,rgba(255,255,255,.10));border-radius:10px;padding:10px 12px;margin:0 0 8px;background:linear-gradient(180deg,rgba(255,255,255,.025),rgba(255,255,255,0));transition:border-color .16s ease,box-shadow .16s ease}',
      '.mcp-row:hover{border-color:rgba(79,140,255,.34);box-shadow:0 6px 18px -14px rgba(79,140,255,.85)}',
      '.mcp-head{display:flex;align-items:center;gap:8px;margin-bottom:4px}',
      '.mcp-name{font-weight:600;font-size:13px;letter-spacing:.2px}.mcp-meta{color:#8b93a7;font-size:12px}',
      '.mcp-desc{color:#c7ced8;font-size:12px;line-height:1.5;margin:2px 0 8px}',
      '.mcp-sw{margin-left:auto;display:inline-flex;align-items:center;gap:6px;appearance:none;-webkit-appearance:none;border:1px solid var(--border,rgba(255,255,255,.18));background:rgba(255,255,255,.05);color:var(--text,#e6eaf0);border-radius:999px;padding:3px 12px;font-family:var(--sans,inherit);font-size:12px;cursor:pointer;transition:border-color .16s ease,background .16s ease}',
      '.mcp-sw::before{content:"";width:6px;height:6px;border-radius:50%;background:#5b6478}',
      '.mcp-sw.on{border-color:rgba(52,201,143,.45);background:rgba(52,201,143,.14)}',
      '.mcp-sw.on::before{background:#34c98f;box-shadow:0 0 7px rgba(52,201,143,.9)}',
      '.mcp-sw.border::before{display:none}',
      '.mcp-sw:hover{filter:brightness(1.18)}',
      '.mcp-badge{position:absolute;top:2px;right:1px;min-width:13px;height:13px;line-height:13px;border-radius:999px;background:#4f8cff;color:#0b1220;font-size:9px;font-weight:700;text-align:center;padding:0 3px;box-shadow:0 0 8px rgba(79,140,255,.75)}',
      // —— 分组折叠卡片（网页版 AI 那组）：收起时只有一行标题，展开才铺开各行 ——
      '.mcp-grp{position:relative;border:1px solid var(--border,rgba(255,255,255,.12));border-radius:12px;margin:0 0 8px;overflow:hidden;background:linear-gradient(180deg,rgba(79,140,255,.07),rgba(79,140,255,0) 64%)}',
      '.mcp-grp::before{content:"";position:absolute;left:0;top:0;bottom:0;width:2px;background:linear-gradient(180deg,#4f8cff,rgba(79,140,255,0));opacity:.55;transition:opacity .2s ease}',
      '.mcp-grp.open{border-color:rgba(79,140,255,.42);box-shadow:inset 0 0 0 1px rgba(79,140,255,.10),0 8px 22px -16px rgba(79,140,255,.9)}',
      '.mcp-grp.open::before{opacity:1}',
      '.mcp-grp-hd{display:flex;align-items:center;gap:10px;width:100%;box-sizing:border-box;text-align:left;appearance:none;-webkit-appearance:none;border:0;background:transparent;color:var(--text,#e6e8ee);padding:10px 12px 10px 14px;font-family:var(--sans,inherit);font-size:13px;cursor:pointer;transition:background .16s ease}',
      '.mcp-grp-hd:hover{background:rgba(79,140,255,.10)}',
      '.mcp-grp-hd:focus-visible{outline:1px solid rgba(79,140,255,.65);outline-offset:-2px}',
      '.mcp-chev{flex:0 0 18px;width:18px;height:18px;line-height:17px;text-align:center;border-radius:6px;font-size:10px;color:#cfe0ff;background:rgba(79,140,255,.18);border:1px solid rgba(79,140,255,.34);transition:transform .22s cubic-bezier(.2,.8,.2,1),background .16s ease}',
      '.mcp-grp.open .mcp-chev{transform:rotate(90deg);background:rgba(79,140,255,.34)}',
      '.mcp-grp-t{font-weight:600;font-size:13px;letter-spacing:.2px}',
      '.mcp-grp-m{margin-left:auto;display:flex;align-items:center;gap:6px;white-space:nowrap}',
      '.mcp-chip{font-family:var(--mono,monospace);font-size:11px;line-height:16px;padding:0 7px;border-radius:999px;border:1px solid var(--border,rgba(255,255,255,.14));color:#8b93a7;background:rgba(255,255,255,.03)}',
      '.mcp-chip.on{color:#9fe8c8;border-color:rgba(52,201,143,.38);background:rgba(52,201,143,.12)}',
      '.mcp-chip.est{color:#bcd2ff;border-color:rgba(79,140,255,.34);background:rgba(79,140,255,.12)}',
      '.mcp-chip.hint{border-style:dashed}',
      '.mcp-grp-bd{padding:10px 10px 2px;border-top:1px solid rgba(79,140,255,.20);background:rgba(0,0,0,.16)}',
      // 浅色主题兜底（面板里写死的深色字/底在浅色下会看不清）
      'html[data-theme="light"] .mcp-note{background:#f1f5ff;border-color:rgba(37,99,235,.18);color:#4a5568}',
      'html[data-theme="light"] .mcp-desc{color:#3d4757}',
      'html[data-theme="light"] .mcp-meta{color:#5b6478}',
      'html[data-theme="light"] .mcp-grp{background:linear-gradient(180deg,rgba(37,99,235,.06),rgba(37,99,235,0) 64%)}',
      'html[data-theme="light"] .mcp-grp-bd{background:rgba(15,23,42,.03)}',
      'html[data-theme="light"] .mcp-chip{background:rgba(15,23,42,.03)}',
      'html[data-theme="light"] .mcp-chev{color:#1d4ed8}'
    ].join('');
    document.head.appendChild(s);
  }
  function parse(text) {
    var lines = text.split(/\r?\n/), ib = lines.indexOf(MB), ie = lines.indexOf(ME);
    var managed = ib >= 0 && ie > ib, off = {}, outside = {};
    for (var i = 0; i < lines.length; i++) {
      var m = /^-\s+id:\s*([A-Za-z0-9_.-]+)\s*$/.exec(lines[i]); if (!m) continue;
      var idx = -1; for (var j = 0; j < MCP.length; j++) if (MCP[j].id === m[1]) idx = j;
      if (idx < 0) continue;
      var inM = managed && i > ib && i < ie;
      var d = /^\s+disabled:\s*(true|false)\s*$/i.exec(lines[i + 1] || '');
      var isOff = d ? d[1].toLowerCase() === 'true' : true;
      if (inM) { if (isOff) off[idx] = 1; } else { outside[idx] = 1; if (isOff) off[idx] = 1; }
    }
    return { lines: lines, ib: ib, ie: ie, managed: managed, off: off, outside: outside,
             eol: /\r\n/.test(text) ? '\r\n' : '\n', tail: /\r?\n$/.test(text) };
  }
  function build(st, wantOff) {
    var body = st.lines.slice();
    if (st.managed) { var s = st.ib, e = st.ie; if (body[s - 1] !== undefined && body[s - 1].trim() === '') s--; body.splice(s, e - s + 1); }
    while (body.length && body[body.length - 1].trim() === '') body.pop();
    var list = [], i; for (i = 0; i < MCP.length; i++) if (wantOff[i]) list.push(MCP[i]);
    if (list.length) {
      body.push('', MB);
      for (i = 0; i < list.length; i++) body.push('- id: ' + list[i].id, '  disabled: true');
      body.push(ME);
    }
    if (st.tail) body.push('');
    return body.join(st.eol);
  }
  // 主进程 kun:file:read 返回的是对象 {ok,path,text,size,mtime}（main.js:1065-1075），不是裸字符串；
  // write 返回 {ok,path,size,mtime} 或 {ok:false,err}。这里统一收口，失败带原话抛出（别静默失败）。
  function read() {
    if (!window.app || !window.app.file) return Promise.reject(new Error('没有 app.file 接口（主进程没重启过，或这不是工作台主窗口）'));
    return Promise.resolve(window.app.file.read(FILE)).then(function (r) {
      if (!r) throw new Error('主进程没有返回内容');
      if (r.ok === false) throw new Error(r.err || '读取被拒绝');
      var t = (typeof r === 'string') ? r : r.text;
      if (typeof t !== 'string') throw new Error('返回内容不是文本（字段：' + Object.keys(r).join(',') + '）');
      return t;
    });
  }
  function write(t) {
    return Promise.resolve(window.app.file.write(FILE, t)).then(function (r) {
      if (!r || r.ok === false) throw new Error((r && r.err) || '写入被拒绝');
      return true;
    });
  }
  function note(txt, cls) {
    var d = document.createElement('div'); d.className = 'mcp-note' + (cls ? ' ' + cls : ''); d.textContent = txt; return d;
  }
  function row(st, i, rerender) {
    var m = MCP[i], on = !st.off[i];
    var card = document.createElement('div'); card.className = 'mcp-row';
    var head = document.createElement('div'); head.className = 'mcp-head';
    var nm = document.createElement('span'); nm.className = 'mcp-name'; nm.textContent = m.label;
    var mt = document.createElement('span'); mt.className = 'mcp-meta';
    mt.textContent = '约 ' + m.tools + ' 个工具 · ' + (on ? '开着，每轮固定开销约 ' + k(m.est) : '已关，省下约 ' + k(m.est) + '/轮');
    var sw = document.createElement('button'); sw.className = 'mcp-sw' + (on ? ' on' : ''); sw.textContent = on ? '已开启' : '已关闭';
    sw.title = on ? '点一下关掉它（省 token）' : '点一下打开它';
    sw.addEventListener('click', function () { toggle(i, rerender); });
    head.appendChild(nm); head.appendChild(mt); head.appendChild(sw);
    var de = document.createElement('div'); de.className = 'mcp-desc'; de.textContent = m.desc;
    card.appendChild(head); card.appendChild(de);
    return card;
  }
  function toggle(i, rerender) {
    var m = MCP[i], turnOff = !window.__mcpState.off[i];
    var msg = '要' + (turnOff ? '关掉' : '打开') + '「' + m.label + '」MCP 吗？\n\n' +
      (turnOff ? '关掉后每轮固定开销省约 ' + k(m.est) + ' token（工具表少 ' + m.tools + ' 个）。\n'
               : '打开后每轮多约 ' + k(m.est) + ' token（工具表多 ' + m.tools + ' 个）。\n') +
      '\n生效方式：保存后引擎立刻热重载配置（约 1~2 秒），该 MCP 子进程会被卸载/拉起。\n' +
      '副作用：面板里的 AI 会话可能断开一次——点标题栏 ⟳ 或刷新页面就接回，会话记录不丢。\n\n确定写入并生效？';
    if (!window.confirm(msg)) return;
    read().then(function (text) {
      var st = parse(text), want = {};
      for (var j = 0; j < MCP.length; j++) want[j] = st.off[j] || false;
      want[i] = turnOff;
      return write(build(st, want));
    }).then(function () {
      return read();
    }).then(function (text) {
      window.__mcpState = parse(text);
      rerender('✅ 已写入并生效：' + m.label + ' 已' + (turnOff ? '关闭' : '打开') + '。若对话正好卡住或工具表没更新，点标题栏「⟳」刷新界面即可接回原会话。');
    }).catch(function (e) {
      rerender('⚠ 写入失败：' + (e && e.message ? e.message : e));
    });
  }
  // 折叠卡片：grp 相同的一串行收成一张卡（默认收起，点标题行展开）
  function groupCard(title, idxs, st, rerender) {
    var on = 0, est = 0, i;
    for (i = 0; i < idxs.length; i++) if (!st.off[idxs[i]]) { on++; est += MCP[idxs[i]].est; }
    var open = !!openGrp[title];
    var card = document.createElement('div'); card.className = 'mcp-grp' + (open ? ' open' : '');
    var hd = document.createElement('button'); hd.className = 'mcp-grp-hd'; hd.type = 'button';
    hd.setAttribute('aria-expanded', open ? 'true' : 'false');
    hd.title = open ? '收起这一组' : '展开这一组（逐个开关）';
    var ch = document.createElement('span'); ch.className = 'mcp-chev'; ch.textContent = '▸';   // 展开时由 CSS 转 90° 变 ▾
    var tt = document.createElement('span'); tt.className = 'mcp-grp-t'; tt.textContent = title;
    var mt = document.createElement('span'); mt.className = 'mcp-grp-m';
    function chip(txt, cls) {
      var c = document.createElement('span'); c.className = 'mcp-chip' + (cls ? ' ' + cls : '');
      c.textContent = txt; return c;
    }
    mt.appendChild(chip(idxs.length + ' 个'));
    mt.appendChild(chip('开着 ' + on, on ? 'on' : ''));
    mt.appendChild(chip('≈' + k(est) + '/轮', 'est'));
    if (!open) mt.appendChild(chip('点开', 'hint'));
    hd.appendChild(ch); hd.appendChild(tt); hd.appendChild(mt);
    hd.addEventListener('click', function () { openGrp[title] = !openGrp[title]; rerender(lastMsg); });
    card.appendChild(hd);
    if (open) {
      var bd = document.createElement('div'); bd.className = 'mcp-grp-bd';
      for (i = 0; i < idxs.length; i++) bd.appendChild(row(st, idxs[i], rerender));
      card.appendChild(bd);
    }
    return card;
  }
  function open() {
    if (typeof window.openModal !== 'function') { window.alert('弹窗组件未就绪（renderer.js 尚未加载），稍后再试。'); return; }
    window.openModal('MCP 开关', function (body) {
      style();
      function render(msg) {
        if (msg !== undefined) lastMsg = msg;
        body.innerHTML = '';
        var st = window.__mcpState;
        var onN = 0, estOn = 0, i;
        for (i = 0; i < MCP.length; i++) if (!st.off[i]) { onN++; estOn += MCP[i].est; }
        var head = note('这台机器装了 ' + MCP.length + ' 个 MCP（模型直接可用的工具组）。每个 MCP 的工具定义都会算进「每一轮」的固定开销——用不上的关掉，省下的 token 直接变成对话可用空间。现在开着 ' + onN + '/' + MCP.length + '，合计约 ' + k(estOn) + ' token/轮。');
        body.appendChild(head);
        if (lastMsg) body.appendChild(note(lastMsg));
        var grp = '';
        for (i = 0; i < MCP.length; i++) {
          if (MCP[i].grp && MCP[i].grp !== grp) {         // 同 grp 的连续若干行 → 一张折叠卡片
            grp = MCP[i].grp;
            var idxs = [], j;
            for (j = i; j < MCP.length && MCP[j].grp === grp; j++) idxs.push(j);
            body.appendChild(groupCard(grp, idxs, st, render));
            i = j - 1;
            continue;
          }
          body.appendChild(row(st, i, render));
        }
        var tail = note('写入位置：' + FILE + '（引擎官方 patch 覆盖项 disabled: true）。命令行等价物：node "<工作台>\\引擎\\.dsh\\skills\\context-overflow\\mcp-switch.mjs" 设置 blender=off --apply', 'dim');
        body.appendChild(tail);
        var btn = document.createElement('button'); btn.className = 'mcp-sw border'; btn.style.marginLeft = '0';
        btn.textContent = '⟳ 刷新界面（接回会话 / 让工具表生效）';
        btn.addEventListener('click', function () { var b = document.getElementById('btn-refresh'); if (b) b.click(); else location.reload(); });
        body.appendChild(btn);
      }
      body.innerHTML = ''; body.appendChild(note('正在读取配置…'));
      read().then(function (text) {
        window.__mcpState = parse(text); render('');
        syncBadge();                                    // 顺手把标题栏徽标对齐（可能是别的窗口刚改过）
      }).catch(function (e) { body.innerHTML = ''; body.appendChild(note('⚠ 读不到配置：' + (e && e.message ? e.message : e) + '（' + FILE + '）')); });
    });
  }
  // 读一次配置 → 对齐徽标与 tooltip（值没变就不碰 DOM，免得 20 秒兜底轮询白白触发重排）
  function syncBadge() {
    return read().then(function (t) {
      var st = parse(t), n = MCP.length - Object.keys(st.off).length, bd = document.getElementById('mcp-badge'), b = document.getElementById('btn-mcp');
      window.__mcpState = st;
      if (bd) { var s = String(n); if (bd.textContent !== s) bd.textContent = s; if (bd.style.display === 'none') bd.style.display = ''; }
      if (b) {
        var tt = 'MCP 开关：开着 ' + n + '/' + MCP.length + '（' + MCP.map(function (m) { return m.label; }).join(' / ') + '）';
        if (b.title !== tt) b.title = tt;
      }
      return n;
    }).catch(function () { var bd = document.getElementById('mcp-badge'); if (bd) bd.style.display = 'none'; });
  }
  function mount() {
    if (document.getElementById('btn-mcp')) return;                  // 幂等：只建一次
    var ref = document.getElementById('btn-skills') || document.querySelector('.titlebar-controls');
    if (!ref || !ref.parentNode) return;
    var b = document.createElement('button');
    b.className = 'tb-btn tb-tools'; b.id = 'btn-mcp';
    b.setAttribute('aria-label', 'MCP 开关');
    b.title = 'MCP 开关（' + MCP.map(function (m) { return m.label; }).join(' / ') + '）——用不上就关，省每轮固定开销';
    b.style.position = 'relative';
    b.innerHTML = ICON + '<span class="mcp-badge" id="mcp-badge">' + MCP.length + '</span>';
    b.addEventListener('click', open);
    ref.parentNode.insertBefore(b, ref.nextSibling);
    style();
    // 多窗口：分离的场景窗口是**一整套壳**（自带 preload/渲染器/桥），每个窗口标题栏各有一份按钮，
    // 而标题栏 ⟳ 只热更新**当前这个窗口**的脚本。写入的是同一个 cordis.patch.yml、引擎侧对**所有**会话生效，
    // 但别家窗口的徽标不会自己变 —— 所以挂几个便宜的对齐点，让"谁被点到谁就跟上"。
    // ⚠ 钩子只装一次（挂在 window 上），每次 ⟳ 只把 window.__mcpSync 指到最新闭包，避免监听器越堆越多。
    window.__mcpSync = syncBadge;
    if (!window.__mcpSyncHooked) {
      window.__mcpSyncHooked = true;
      var kick = function () { if (window.__mcpSync) window.__mcpSync(); };
      window.addEventListener('focus', kick);
      document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') kick(); });
      if (window.app && window.app.win && window.app.win.onChanged) window.app.win.onChanged(kick);   // 分离窗口增删
      setInterval(function () { if (document.visibilityState === 'visible') kick(); }, 20000);        // 兜底
    }
    syncBadge();
  }
  try { mount(); } catch (e) { if (window.console) console.warn('[mcp] 按钮挂载失败', e); }
  window.__dshMcpPanel = { open: open, mount: mount, parse: parse, build: build };
})();

/* 每次点 ⟳ 本文件都会重新执行：mount() 见到旧按钮会直接返回，
   于是按钮上绑的仍是旧闭包（旧的 read()）——必须把按钮整个换新，避免旧闭包留在原地。 */
(function () {
  try {
    if (!window.__dshMcpPanel) return;
    var old = document.getElementById('btn-mcp');
    if (!old || !old.parentNode) return;
    var host = old.parentNode;
    var bd = document.getElementById('mcp-badge');
    if (bd && bd.parentNode) bd.parentNode.removeChild(bd);
    host.removeChild(old);
    window.__dshMcpPanel.mount();
    if (window.console && console.log) console.log('[mcp-panel] 已重挂按钮（新版本）');
  } catch (e) {}
})();

/* —— 一个窗口点 ⟳ ⇒ 所有窗口跟着热更新（用户原话：「主窗口刷新其他跟着刷新」）——
   为什么不用 IPC 广播：那要动 main.js/preload.js，必须重启 GUI（会打断所有会话）。
   渲染器侧拿 localStorage 当信箱就够了：点 ⟳ 的窗口写一个 token（时间戳），
   别的窗口发现 token 变了就**点自己那个 ⟳** —— 走的是和用户手点完全同一条已跑通的路径。
   ⚠ 跟随者绝不能再写 token，否则两个窗口互相触发成死循环 ⇒ 用 __kunFollowing 标记区分。
   ⚠ 钩子只装一次：本文件每次 ⟳ 都被重新注入，重复 addEventListener 会让一次点击连刷 N 次。
   ⚠ localStorage 在 file:// 页面拿不到时（异常）整块静默失效，不影响其它功能。 */
(function () {
  var KEY = 'kun:renderer-reload';
  if (window.__kunReloadSync) return;
  window.__kunReloadSync = true;
  var readToken = function () { try { return localStorage.getItem(KEY); } catch (e) { return null; } };
  window.__kunReloadToken = readToken();                    // 我已知的最新 token（启动时的值不算"变化"）
  var fire = function (token) {
    window.__kunReloadToken = token;                        // 先记住：别把自己再触发一次
    window.__kunFollowing = true;
    var b = document.getElementById('btn-refresh');
    try {
      if (b) b.click();
      else if (typeof window.hotReloadRenderers === 'function') window.hotReloadRenderers();
      else window.__kunFollowing = false;
    } catch (e) { window.__kunFollowing = false; }
  };
  var btn = document.getElementById('btn-refresh');
  if (btn) btn.addEventListener('click', function () {
    if (window.__kunFollowing) { window.__kunFollowing = false; return; }   // 我是被叫醒的 ⇒ 不写 token
    // ⚠ 令牌必须唯一：只用 Date.now() 的话，同毫秒内的两次 ⟳（快速双击/连点）会被当成"没变化"而不传播
    try { var t = Date.now() + '-' + Math.random().toString(36).slice(2, 8); localStorage.setItem(KEY, t); window.__kunReloadToken = t; } catch (e) {}
  });
  window.addEventListener('storage', function (e) {         // 同一 partition 的页面之间即时通知（拿不到就靠下面的轮询）
    if (!e || e.key !== KEY || !e.newValue || e.newValue === window.__kunReloadToken) return;
    fire(e.newValue);
  });
  setInterval(function () {                                 // 兜底：读 localStorage 是纯内存操作，2 秒一次不要钱
    if (document.visibilityState === 'hidden') return;      // 最小化的窗口等它被打开时再对齐
    var t = readToken();
    if (t && t !== window.__kunReloadToken) fire(t);
  }, 2000);
})();

/* —— 同一场景只留一份界面：「仍在此处显示」改成「收回这里显示」（用户 2026-09-23 要求）——
   背景：renderer.js 占位卡的第 2 个按钮会设 forceLocalScene，让主窗口**也**渲染一份 ⇒ 同一个场景两份界面
   （两套定时器、两套 AI 界面，webai 桥只派发给其中一个窗口）——用户原话「不要搞一模一样的会打架」。
   这里不动 renderer.js（它不参与 ⟳ 热更新，改它必须重开窗口），改用 DOM 热补丁把那个按钮换成"收回"：
   点一下 → localStorage 广播 → 那个分离窗口自己 `app.win.closeSelf()` → 关掉后 renderer.js 收到
   windows:changed 会把场景自动收回主窗口（占位卡消失、真身出现）。
   ⚠ 下次 GUI 重启时应在 renderer.js 的 detachedCard() 里正式改掉；本补丁按按钮文字判断，见到新文字自动让路。 */
(function () {
  var CMD = 'kun:win-cmd';
  var sceneNameOfMe = function () {
    if (!/[?&]scene=/.test(location.search)) return '';      // 主窗口不是任何场景 ⇒ 不响应"收回"
    return String(document.title || '').split(' · ')[0];     // renderer.js 在 solo 窗口里设的标题
  };
  var publish = function (cmd, arg) {
    try {
      localStorage.setItem(CMD, JSON.stringify({ t: Date.now() + '-' + Math.random().toString(36).slice(2, 8), cmd: cmd, arg: arg || '' }));
    } catch (e) {}
  };
  var lastCmd = null; try { lastCmd = localStorage.getItem(CMD); } catch (e) {}   // ⚠ 启动前留下的命令不执行
  var patchCard = function () {
    var card = document.querySelector('.detach-card');
    if (!card) return;
    var tt = card.querySelector('.detach-card-title');
    var name = (tt && tt.textContent) || '';
    var btns = card.querySelectorAll('.detach-btn');
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].textContent !== '仍在此处显示') continue;    // 已换过 / 将来 renderer.js 正式改过 → 让路
      var nb = btns[i].cloneNode(true);                      // clone 掉旧监听器（匿名，摘不掉）
      nb.textContent = '收回这里显示';
      nb.title = '关掉那个独立窗口，把场景收回主窗口 —— 同一个场景只留一份界面';
      nb.addEventListener('click', function () {
        if (!name) return;
        publish('close', name);
        nb.textContent = '正在收回…'; nb.disabled = true;
        setTimeout(function () { if (nb.parentNode) { nb.textContent = '收回这里显示'; nb.disabled = false; } }, 6000);
      });
      btns[i].parentNode.replaceChild(nb, btns[i]);
    }
  };
  patchCard();
  setInterval(function () {                                  // 占位卡是按需重建的：顺手兼顾"收回"广播的接收
    patchCard();
    var raw = null; try { raw = localStorage.getItem(CMD); } catch (e) { return; }
    if (!raw || raw === lastCmd) return;
    lastCmd = raw;                                           // 自己写的也记下（不然把自己当目标）
    var m = null; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || m.cmd !== 'close' || !m.arg) return;
    if (m.arg === sceneNameOfMe() && window.app && window.app.win && window.app.win.closeSelf) {
      try { window.app.win.closeSelf(); } catch (e) {}
    }
  }, 1000);
})();
