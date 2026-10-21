// ── webai.mjs —— 把"网页版 AI"当工具调用的本地桥（不花 API token）
// 摘自本机实现 `webai.mjs` 的 全文。
// 脱敏：内部 API 名已去品牌化（kun → app）· 绝对路径 → <DSH根>/<工作区> · 个人名/客户名/站点 → 占位
// 含：站点列表、提问、等稳定、取文本、长回答存盘只回预览（省上下文的关键设计）
// ⚠ 摘录/单文件：脱离这套工作台不能直接运行（依赖壳注入的 app.* 实例与页面上下文）。

// 网页版 AI 命令行（任何会话都能用）· 2026-09-21 第 10 轮
//
// 用法（在**任何**会话里跑，不花 API token）：
//   node "<DSH根>\外壳\scripts\webai.mjs" list
//   node "<DSH根>\外壳\scripts\webai.mjs" ask kimi "用一句话解释什么是向量数据库"
//   node "<DSH根>\外壳\scripts\webai.mjs" ask doubao "把下面这段改成 100 字摘要：…" --timeout 240000
//   node "<DSH根>\外壳\scripts\webai.mjs" ask tongyi "按这份需求写 5 条标题" --file <工作区>\_任务单编制\需求.md --out <工作区>\_webai产物\标题.md
//   node "<DSH根>\外壳\scripts\webai.mjs" state          # 看有没有任务在跑
// 选项：--timeout 毫秒（默认 180000，最长 600000）｜--json 输出原始 JSON｜--dry 只回显将要发送的正文（不发出去，排查用）
//       --file 路径   把**文件内容**当问题（长中文/带引号的内容别塞命令行；可与行内文字同时给，先文字后文件）
//       --out 路径    把回答**存成文件**，终端只回 600 字预览（省会话上下文：长回答别整篇灌进对话）；
//                     落盘的是**干净正文**：桥的诊断标记走 stderr、``` 围栏自动剥掉
//                     ★ 文本一律存 **Markdown**（用户 2026-09-21 定的规矩）：路径给**目录**或**不写扩展名**
//                       ⇒ 自动生成 `webai-<站点>-<年月日-时分>.md`；`.txt` ⇒ 自动改 `.md`；
//                       `.md` 与代码后缀（.html/.js/.py/.sql/.json…）原样保留
//       --save-image 路径  把这次回答里的**图**存下来（豆包生图/封面用；路径给目录就自动按 宽x高 命名）
//                     ⚠ 优先按页面上的**签名直链**下原图（全分辨率），下不动才退回渲染层截屏（小、带聊天气泡）
//
// 链路：本脚本 → HTTP 127.0.0.1:31239（main.js 的桥服务）→ 工作台渲染层
//       → 复用顶栏那个网页版的 <webview>（登录态是持久的）→ 把回答文本带回来。
// 前提：工作台开着，且**已经重启过一次 GUI**（main.js/preload.js 是壳代码，改了必须重启）。
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.WEB_AI_PORT || 31239);
const BASE = 'http://127.0.0.1:' + PORT;
const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(name);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v === undefined ? true : v;
};
// 布尔开关**只能删自己**：以前用 flag() 处理 --json，会把紧跟其后的 --timeout 一起吞掉，
// 于是它的值（90000）留在 argv 里、被当成问题正文发出去（实测：deepseek 收到的是"90000 只回复两个字：收到"）。
const boolFlag = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return false;
  argv.splice(i, 1);
  return true;
};
const asJson = boolFlag('--json');
const timeoutMs = Number(flag('--timeout', 180000)) || 180000;
const fileArg = flag('--file', null);
const outArg = flag('--out', null);
const saveImgArg = flag('--save-image', null);
const dryArg = boolFlag('--dry');
const cmd = (argv.shift() || 'list').toLowerCase();

// 落盘的文本一律 **Markdown**（用户 2026-09-21 定的规矩）：
//   ① `--out` 给**目录**（或没有扩展名的路径）⇒ 自动生成 `webai-<站点>-<年月日-时分>.md`，不用再手写文件名；
//   ② 给的文件名是 `.txt`/`.text` ⇒ 自动改成 `.md`（网页版回答本来就是 md 结构：标题/列表/加粗）；
//   ③ `.md` 和代码/数据后缀（.html/.js/.py/.sql/.json/…）原样保留 —— 代码草稿有自己的格式，别乱改。
const CODEY = /^\.(html?|js|mjs|cjs|ts|tsx|jsx|py|sh|ps1|bat|cmd|sql|json|ya?ml|toml|ini|css|scss|xml|csv|tsv|svg|vue|rb|go|rs|java|c|h|cpp|cs|php|pl|lua)$/i;
// 导出只是为了让探针能直接测这条规则（当 CLI 跑时没有任何影响）：
export function resolveTextOut(outPath, key) {
  const strip = (s) => String(s || '').replace(/[\\/]+$/, '');
  const isDir = fs.existsSync(outPath) && fs.statSync(outPath).isDirectory();
  const hasExt = /\.[a-z0-9]{2,5}$/i.test(path.basename(strip(outPath)));
  if (isDir || !hasExt) {
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const stamp = d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' + p2(d.getHours()) + p2(d.getMinutes());
    return { out: path.join(strip(outPath), 'webai-' + key + '-' + stamp + '.md'), why: isDir ? '目录 ⇒ 自动命名' : '没写扩展名 ⇒ 按 md 规矩' };
  }
  const ext = path.extname(outPath);
  if (/^\.(txt|text)$/i.test(ext)) return { out: outPath.replace(/\.[a-z0-9]+$/i, '.md'), why: '.txt ⇒ 改正为 .md（落盘一律 Markdown）' };
  if (!/^\.md$/i.test(ext) && !CODEY.test(ext)) return { out: outPath, why: '⚠ 不是 .md —— 按用户定的规矩，文本一律存 Markdown' };
  return { out: outPath, why: '' };
}

const die = (msg, hint) => {
  console.error('✗ ' + msg);
  if (hint) console.error('  ' + hint);
  process.exit(2);
};

const get = async (path) => {
  try {
    const r = await fetch(BASE + path);
    return await r.json();
  } catch (e) {
    die('连不上桥服务 ' + BASE + '（' + e.message + '）',
      '先确认工作台开着；如果刚才是这次会话才加的桥，需要**重启一次 GUI** 才会生效。');
  }
};

// ── 一次问答（probe 与 ask 共用；2026-09-23 第 12 轮抽出，避免两处各写一遍） ──
// 返回：{ ok, r(原始回包), t0, elapsed, text, clean, diag[], pick, ver, cleanLen }
const MARK = /\[\[(?:bridge|webai-note|webai-img|webai-img-err|webai-pick)[^\]]*\]\]/g;
const askOnce = async (key, text, timeoutMs2) => {
  const t0 = Date.now();
  let r;
  try {
    const res = await fetch(BASE + '/webai/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, text, timeoutMs: timeoutMs2 })
    });
    r = await res.json();
  } catch (e) {
    return { ok: false, err: '连不上桥服务 ' + BASE + '（' + e.message + '）', t0, elapsedMs: Date.now() - t0 };
  }
  const elapsedMs = Number(r.elapsedMs || (Date.now() - t0));
  const t = String(r.text || '').trim();
  const diag = t.match(MARK) || [];
  const clean = t.replace(MARK, '').trim();
  const pick = (t.match(/\[\[webai-pick:([^\]]*)\]\]/) || [])[1] || '';
  const ver = (t.match(/\[\[bridge:v([0-9.]+)\]\]/) || [])[1] || '';
  return { ok: !!r.ok && !!t, err: r.err || (t ? '' : '回包是空的'), t0, elapsedMs, raw: r, text: t, clean, diag, pick, ver, cleanLen: clean.length };
};

// 装好的那份桥的版本（"旧桥抢单"闸门要用）
const installedBridgeVer = () => {
  try {
    const src = fs.readFileSync('<盘根>\\DSH\\外壳\\renderer\\webai-bridge.js', 'utf8');
    return (src.match(/ver:\s*'([0-9.]+)'/) || [])[1] || '';
  } catch (e) { return ''; }
};

// 规则：文本落盘一律 Markdown。函数已导出，供探针直接测（见 <DSH根>\工具\2026-09-21-轮换技能核对\md-out-probe.mjs）。

if (cmd === 'list' || cmd === 'keys') {
  const j = await get('/webai/keys');
  if (asJson) { console.log(JSON.stringify(j, null, 2)); process.exit(0); }
  console.log('可用网页版（' + j.keys.length + ' 个，全部免费、不花 API token）：');
  for (const k of j.keys) console.log('  ' + k.key.padEnd(9) + k.name + '   ' + k.url);
  console.log('\n问法：node scripts\\webai.mjs ask <key> "你的问题" [--timeout 240000]');
  process.exit(0);
}

if (cmd === 'state') {
  const j = await get('/webai/state');
  console.log(JSON.stringify(j, null, 2));
  process.exit(0);
}

if (cmd === 'probe') {
  // 网页版 AI 体检（2026-09-23 第 12 轮）：逐个站问一句最短的话，把"输入框选对没、正文切对没、多快、多少字"落成一张表。
  // 为什么要有它：切正文的启发式一改就得挨个站真机验，靠人肉一条条敲、再人肉比对，改一次半小时。
  const want = installedBridgeVer();
  let keys = [];
  try { const j = await get('/webai/keys'); keys = (j.keys || []).map(function (k) { return k.key; }); } catch (e) { }
  const only = argv.filter(function (a) { return !a.startsWith('--'); });
  if (only.length) keys = keys.filter(function (k) { return only.indexOf(k) >= 0; });
  if (!keys.length) die('没拿到站点列表', '工作台开着吗？node scripts\\webai.mjs list 先看一眼');
  const OUT = flag('--report', '<盘根>\\DSH\\工具\\webai体检');
  const ASK = '只回复四个字：收到收到';
  console.error('→ 体检 ' + keys.length + ' 个站（每个问「' + ASK + '」，装好的桥 v' + (want || '?') + '）\n');
  const rows = [];
  for (const k of keys) {
    const t0 = Date.now();
    const a = await askOnce(k, ASK, timeoutMs);
    const secs = Math.round((a.elapsedMs || (Date.now() - t0)) / 1000);
    const good = a.ok && a.cleanLen >= 2 && a.cleanLen <= 80 && /收到/.test(a.clean);
    const stale = a.ver && want && a.ver !== want;
    rows.push({ key: k, ok: !!a.ok, secs: secs, len: a.cleanLen, ver: a.ver, stale: stale, pick: a.pick, clean: a.clean, err: a.err || '' });
    console.log('  ' + k.padEnd(9) + (a.ok ? '✓' : '✗') + ' ' + String(secs + 's').padStart(5) + ' ' +
      String(a.cleanLen + '字').padStart(6) + '  桥v' + (a.ver || '?') + (stale ? '(旧!)' : '') +
      (good ? '  ' : '  ⚠ ') + String(a.clean || a.err).replace(/\s+/g, ' ').slice(0, 46));
    if (a.pick) console.log('            ' + a.pick.slice(0, 150));
  }
  // 落一张报告，方便跨天比对（"哪个站最快/最稳"这种结论要有据可查，不能靠印象）
  try {
    fs.mkdirSync(OUT, { recursive: true });
    const d = new Date(), p2 = (n) => String(n).padStart(2, '0');
    const f = path.join(OUT, '体检-' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' + p2(d.getHours()) + p2(d.getMinutes()) + '.md');
    const L = [];
    L.push('# 网页版 AI 体检 ' + d.toLocaleString());
    L.push('');
    L.push('- 装好的桥：v' + (want || '?') + '　探针问句：「' + ASK + '」');
    L.push('');
    L.push('| 站点 | 结果 | 用时 | 字数 | 桥版本 | 选中输入框 / 正文切法 |');
    L.push('|---|---|---|---|---|---|');
    for (const r of rows) L.push('| ' + r.key + ' | ' + (r.ok ? '✓' : '✗ ' + String(r.err).slice(0, 30)) + ' | ' + r.secs + 's | ' + r.len +
      ' | v' + (r.ver || '?') + (r.stale ? ' ⚠旧桥' : '') + ' | ' + String(r.pick || '(桥太旧，没有这条证据)').replace(/\|/g, '/') + ' |');
    L.push('');
    L.push('## 回答原文（判定"切对没"看这里）');
    L.push('');
    for (const r of rows) { L.push('### ' + r.key); L.push('```'); L.push(r.clean || ('(空) ' + r.err)); L.push('```'); }
    L.push('');
    fs.writeFileSync(f, L.join('\n') + '\n', 'utf8');
    console.error('\n— 报告已存 ' + f + '（跨天比对"哪个站快/稳"用它）');
  } catch (e) { console.error('（报告没写成功：' + e.message + '）'); }
  const bad = rows.filter(function (r) { return !r.ok || r.len < 2 || r.stale; });
  console.error(bad.length ? '⚠ ' + bad.length + ' 个站有问题：' + bad.map(function (r) { return r.key; }).join(' / ')
    : '全部正常 ✓（5 个站都能打字、能取回正文）');
  process.exit(bad.length ? 1 : 0);
}

// who：多窗口时"到底谁在答"。
// 背景（2026-09-23 踩了一整轮）：每个窗口都是独立一整套壳、各自带一份 webai-bridge.js，
// 分离窗口那份只在它自己加载/⟳ 时才更新 ⇒ 旧桥会把正文切错（菜单墙/页脚/上一轮内容），
// 现象像"刚改的判据坏了"。v3.17 起主进程只把活派给**申报了当前版本**的窗口。
if (cmd === 'who') {
  let j = null;
  try { j = await get('/webai/who'); } catch (e) { die('连不上桥服务 ' + BASE + '（' + e.message + '）', '工作台没开？'); }
  if (!j || !Array.isArray(j.windows)) {
    // 老 main.js 没有这个端点 ⇒ 它自己会回 404（这时别把"没有窗口申报"当成结论，那会误导排查方向）
    console.error('⚠ 当前 GUI 主进程还没有 /webai/who 端点（回的是：' + JSON.stringify(j).slice(0, 120) + '）');
    console.error('  ⇒ **壳（main.js/preload.js）需要重启一次**：关掉工作台窗口再打开。');
    process.exit(1);
  }
  const w = j.windows || [];
  console.log('桥版本要求 v' + j.want + '；当前会派给：' + (j.target ? '「' + j.target + '」' : '（还没有可用窗口）'));
  if (!w.length) console.log('  ⚠ 没有任何窗口申报过版本 —— 壳没重启过（preload 是壳代码），或桥没加载。');
  for (const x of w) console.log('  ' + (x.ok ? '✓' : '✗') + ' v' + String(x.ver).padEnd(6) + ' 窗口#' + x.id + ' ' + (x.title || '（无标题）') + (x.ok ? '' : '  ← 旧桥，不会再派活给它'));
  if (j.stale) console.log('\n有 ' + j.stale + ' 个旧桥窗口：点**它自己**标题栏上的 ⟳；不行就关掉那个窗口重开（不用重启整个工作台）。');
  process.exit(0);
}

if (cmd === 'ask') {
  const key = String(argv.shift() || '').trim();
  const parts = [];
  const inline = argv.join(' ').trim();
  if (inline) parts.push(inline);
  if (typeof fileArg === 'string') {
    if (!fs.existsSync(fileArg)) die('--file 指的文件不存在：' + fileArg);
    const body = fs.readFileSync(fileArg, 'utf8');
    if (body.trim()) parts.push(body.trim());
  }
  let text = parts.join('\n\n').trim();
  // [[save-img]]：让渲染层这次"把页面上的图也抓回来"（豆包生图/封面）。渲染层会把它从真正发出去的文本里删掉。
  if (typeof saveImgArg === 'string') text = (text + '\n[[save-img]]').trim();
  if (!key || !text) die('用法：ask <key> "问题" 或 ask <key> --file 路径（key 见 list）');
  if (text.length > 60000) die('问题太长（' + text.length + ' 字）——网页版输入框塞不下，先截断或分两次问');
  // --dry：只把"最终会发出去的正文"打出来，不碰桥。查"--file 到底读进去什么/参数有没有混进正文"用这条。
  if (dryArg) { console.log(text); console.error('\n（--dry：只回显将要发送的正文，' + text.length + ' 字，没有真的发出去）'); process.exit(0); }
  // 动手之前先清中转：老图留着会造成"这次明明没出图，却存下来上一张"的假成功（也顺手让 big/小图两种路径互不干扰）
  if (typeof saveImgArg === 'string') {
    for (const f of ['<盘根>\\DSH\\外壳\\data\\webai-last-image.b64', '<盘根>\\DSH\\外壳\\data\\webai-last-image.json']) {
      try { fs.unlinkSync(f); } catch (e) { /* 本来就没有就算了 */ }
    }
  }
  if (!asJson) console.error('→ 问 ' + key + '（' + text.length + ' 字' + (text.indexOf('[[save-img]]') >= 0 ? '·要图' : '') + '），等它答完…');
  const t0 = Date.now();
  let r;
  try {
    const res = await fetch(BASE + '/webai/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, text, timeoutMs })
    });
    r = await res.json();
  } catch (e) {
    die('连不上桥服务 ' + BASE + '（' + e.message + '）', '工作台没开？或壳没重启过？');
  }
  if (asJson) { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); }
  if (!r.ok) {
    console.error('✗ ' + (r.err || '失败') + '（' + Math.round((r.elapsedMs || 0) / 1000) + 's）');
    // 桥会把"页面上到底有哪些候选输入框"带回来（v3.14 起）⇒ 失败时直接把它打出来，省得靠猜/靠截图
    const cd = (r.raw && r.raw.cands) || '';
    if (cd) console.error('  页面上的候选框：' + (Array.isArray(cd) ? cd.join('；') : cd));
    console.error('  排查：看工作台顶栏那个网页版窗口里发生了什么（可能要登录/过验证码/站点改版）。');
    process.exit(1);
  }
  const t = String(r.text || '').trim();
  if (!t) {
    console.error('⚠ 网页版没吐出任何新文本（' + Math.round((r.elapsedMs || 0) / 1000) + 's）。窗口里可能是空的/还在生成。');
    process.exit(1);
  }
  // 落盘/预览只给**干净正文**：诊断标记（[[bridge:vX]] 版本戳、[[webai-note:…]]、[[webai-img…]]）一律转到 stderr。
  // 不这么做，--out 存下来的 HTML/代码第一行就是 [[bridge:v3.2]]，每次还得手工删。（正则 MARK 见文件上方，probe 共用）
  const diag = (t.match(MARK) || []);
  // ⚠ 版本闸：工作台里曾出现过"分离出去又合并回来"的**隐藏窗口**，它那份旧桥还在抢单 ——
  // 旧桥的判完/切正文逻辑是老的，会把长回答切半（实测把 HTML 只切到 <!DOCTYPE html>）。
  // 所以只要回包里的版本戳跟**装好的那份**对不上，就直接报错，别让人对着半截产物猜。
  const wantVer = installedBridgeVer();
  const gotVers = diag.map(function (d) { return (d.match(/bridge:v([0-9.]+)/) || [])[1]; }).filter(Boolean);
  if (wantVer && gotVers.length && gotVers.some(function (v) { return v !== wantVer; })) {
    console.error('✗ 回包来自**旧桥** v' + gotVers.join('/v') + '，装好的那份是 v' + wantVer +
      ' —— 说明还有别的窗口活着（多半是分离出去又合并回来的隐藏窗口）在抢单。');
    console.error('  修法：重启一次工作台（关掉窗口再打开）。旧桥会把长回答切半，这份结果不可信。');
    if (!asJson) process.exit(1);
  }
  let clean = t.replace(MARK, '').trim();
  // 网页版爱把整份代码包在 ``` 围栏里（有时前面还带一句"这是..."）：落盘时剥掉围栏+那句客套，存下来就能直接用
  const fence = clean.match(/^(?:[^\n`]{0,80}\n)?```[a-zA-Z0-9+#.-]*\r?\n([\s\S]*?)\r?\n```\s*$/);
  if (fence) clean = fence[1].trim();
  if (diag.length && !asJson) console.error('· 诊断：' + diag.join(' '));
  // --save-image：把渲染层写进中转文件的图（dataURL）解码成真图存到指定路径
  if (typeof saveImgArg === 'string') {
    const SPOOL = '<盘根>\\DSH\\外壳\\data\\webai-last-image';
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(SPOOL + '.json', 'utf8')); } catch (e) { meta = null; }
    if (!meta || !meta.ts || meta.ts < t0 - 3000) {
      const why = (String(r.text || '').match(/\[\[webai-img-err:([^\]]+)\]\]/) || [])[1];
      console.error('✗ 这次没取到图：' + (why || (meta ? '中转文件是旧的（' + new Date(meta.ts).toLocaleString() + '）' : '中转文件不存在')));
      console.error('  常见原因：网页版还没出图 / 是视频（太大，得手动保存）/ 这次问答里本来就没有图片。');
      // 图没成不代表文字要丢：照旧把回答落盘/预览出来
      if (typeof outArg === 'string') {
        const R = resolveTextOut(outArg, r.key);
        try { fs.mkdirSync(path.dirname(R.out), { recursive: true }); fs.writeFileSync(R.out, clean + '\n', 'utf8'); console.error('  （回答已照旧存到 ' + R.out + '，' + clean.length + ' 字）'); } catch (e) { }
      } else {
        console.error('  —— 回答预览（前 400 字）：' + clean.slice(0, 400).replace(/\n+/g, ' / '));
      }
      process.exit(1);
    }
    // 原图优先：网页版页面上那张图通常带**签名直链**（CDN）。渲染层在页面上下文里 fetch 会被 CORS 挡住，
    // 只能退化成截屏（实测只有 479×360，还带上聊天气泡，做封面根本不够）。会话这一侧是 Node，没有 CORS
    // ⇒ 直接按直链下原图（实测 2304×1728 / 3.9MB，跟网页版里那张一模一样）。下不动才用截屏。
    const m = (function () {
      let dataUrl = '';
      try { dataUrl = fs.readFileSync(SPOOL + '.b64', 'utf8'); } catch (e) { return null; }
      return dataUrl.match(/^data:([^;]+);base64,([\s\S]+)$/);
    })();
    let buf = null, mime = m ? m[1] : '', how = '截屏保底';
    const srcUrl = String((meta && meta.src) || '');
    if (/^https?:\/\//i.test(srcUrl)) {
      try {
        const rs = await fetch(srcUrl);
        if (rs.ok) {
          const ab = Buffer.from(await rs.arrayBuffer());
          if (ab.length > 2048) {
            buf = ab;
            mime = String(rs.headers.get('content-type') || mime || 'image/jpeg').split(';')[0].trim();
            how = '原图直链';
          }
        }
      } catch (e) { /* 链接过期/要登录：安静地落回截屏 */ }
    }
    if (!buf) {
      if (!m) {
        if (meta && meta.big) die('图太大（' + Math.round((meta.bytes || 0) / 1024) + 'KB）过不了中转，直链也没下动（链接过期/要登录）⇒ 请在那个网页版窗口里手动保存');
        die('中转文件读不出来，或不是预期的 dataURL 格式');
      }
      buf = Buffer.from(m[2], 'base64');
      mime = m[1];
    }
    // 别信扩展名、也别全信 content-type：CDN 的 URL 常写着 .png 而字节是 JPEG（或反过来）。
    // 用魔数定格式 —— 实测踩过：直链下回来的是 PNG，我按 .jpg 命名，图片工具直接拒读。
    const sniff = (function (b) {
      if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
      if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
      if (b.length > 12 && b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
      if (b.length > 6 && /^GIF8[79]a$/.test(b.slice(0, 6).toString('ascii'))) return 'image/gif';
      return '';
    })(buf);
    if (sniff) mime = sniff;
    // image/svg+xml → svg（不处理会写出 .svgxml）、image/jpeg → jpg，其余取子类型里的字母数字
    const ext = (mime.split('/')[1] || 'png').replace('+xml', '').replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '');
    let out = saveImgArg;
    if (!/\.[a-z0-9]{2,4}$/i.test(out)) out = out.replace(/[\\/]+$/, '') + '\\webai-img-' + meta.w + 'x' + meta.h + '.' + ext;
    else if (!new RegExp('\\.' + ext + '$', 'i').test(out)) out = out.replace(/\.[a-z0-9]{2,4}$/i, '.' + ext);   // 后缀跟真实格式对齐
    try {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, buf);
    } catch (e) { die('图片写不进去：' + e.message); }
    console.log('✓ 图片已存：' + out + '（' + meta.w + '×' + meta.h + '·' + how + '·' + mime + '·' + Math.round(buf.length / 1024) + 'KB，来自 ' + meta.key + '，未花 API token）');
  }
  if (typeof outArg === 'string') {
    // 存盘 + 只回预览：长回答不灌进会话上下文（省 token 的关键用法）。
    // 落盘一律 Markdown：给目录/无扩展名 ⇒ 自动 `webai-<站点>-<年月日-时分>.md`；.txt ⇒ 改 .md（见文件头 resolveTextOut）。
    const R = resolveTextOut(outArg, r.key);
    if (R.why && !asJson) console.error('· 落盘：' + R.why + ' ⇒ ' + R.out);
    try {
      fs.mkdirSync(path.dirname(R.out), { recursive: true });
      fs.writeFileSync(R.out, clean + '\n', 'utf8');
    } catch (e) {
      die('--out 写不进去：' + e.message);
    }
    console.log(clean.slice(0, 600));
    console.error('\n— 全文已存 ' + R.out + '（' + clean.length + ' 字，来自 ' + r.key + '，用时 ' +
      Math.round(r.elapsedMs / 1000) + 's，未花 API token）；上面只是前 600 字预览，需要细节就 read 那个文件。');
    process.exit(0);
  }
  console.log(clean);
  if (!asJson) console.error('\n— 来自网页版 ' + r.key + '，用时 ' + Math.round(r.elapsedMs / 1000) + 's，' + clean.length + ' 字（未花 API token）');
  process.exit(0);
}

die('不认识的命令：' + cmd, '可用：list ｜ ask <key> "问题" ｜ state');
