#!/usr/bin/env node
/**
 * check-gui.mjs —— 工作台自检：改完代码跑一遍，能挡住绝大多数"改完就坏"的问题。
 *
 *   node scripts/check-gui.mjs
 *
 * 检查项：
 *   1) 关键 JS 语法（main / preload / renderer.js / renderers.js）
 *   2) IPC 对齐：preload.js 声明的通道 ↔ main.js 的实现，双向都不得缺失或悬空
 *   3) 场景面板类型覆盖：scenarios/*.json 里每个 panel.type 都必须在 renderers.js 注册
 *   4) 渲染器定时器：凡用 setInterval 的渲染器必须返回 cleanup（切场景不泄漏）
 *   5) 场景图标：renderer.js 的 ICONS 是否覆盖所有场景 id；图片路径是否存在
 *
 * 退出码：0 = 全绿；1 = 有 FAIL（warning 不影响退出码）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

let fails = 0;
let warns = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { fails++; console.log('  ✗ ' + m); };
const warn = (m) => { warns++; console.log('  ! ' + m); };
const head = (m) => console.log('\n== ' + m + ' ==');

// ---------- 1) 语法 ----------
head('1. JS 语法');
for (const f of ['main.js', 'preload.js', 'renderer/renderer.js', 'renderer/renderers.js', 'stock-store.js', 'oa-store.js', 'oa-ssh.js']) {
  if (!exists(f)) { warn(f + ' 不存在，跳过'); continue; }
  const r = spawnSync(process.execPath, ['--check', path.join(ROOT, f)], { encoding: 'utf8' });
  if (r.status === 0) ok(f);
  else bad(f + ' 语法错误：\n' + String(r.stderr || '').split('\n').slice(0, 6).join('\n'));
}

// ---------- 2) IPC 对齐 ----------
head('2. IPC 对齐（preload ↔ main）');
const pre = read('preload.js');
const main = read('main.js');
// IPC 实现源 = main.js **加上 scripts/ 下的模块**（2026-09-26：官方能力搬迁后，新能力都写成独立模块，
// 例如 scripts/sidebar.js 里的 browser-sidebar:* ⇒ 只扫 main.js 会误报"没实现"）
const moduleFiles = (() => {
  try { return fs.readdirSync(ROOT + '/scripts').filter((f) => f.endsWith('.js')) } catch (e) { return [] }
})();
const implSources = main + '\n' + moduleFiles.map((f) => read('scripts/' + f)).join('\n');
const declared = new Set(), handled = new Set();
for (const m of pre.matchAll(/ipcRenderer\.invoke\(\s*'([^']+)'/g)) declared.add(m[1]);
for (const m of pre.matchAll(/ipcRenderer\.on\(\s*'([^']+)'/g)) declared.add(m[1] + ' (event)');
for (const m of implSources.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)) handled.add(m[1]);
for (const m of implSources.matchAll(/ipcMain\.on\(\s*'([^']+)'/g)) handled.add(m[1] + ' (event)');
const missing = [...declared].filter((c) => !c.endsWith('(event)') && !handled.has(c));
const orphan = [...handled].filter((h) => !h.endsWith('(event)') && !declared.has(h));
console.log(`  preload 声明 ${declared.size} 项 / main 实现 ${handled.size} 项`);
if (missing.length) bad('preload 声明了但 main 没实现：' + missing.join(', '));
else ok('preload → main 无缺失');
if (orphan.length) warn('main 实现了但 preload 未暴露（可能是内部事件）：' + orphan.join(', '));
else ok('main → preload 无悬空');

// ---------- 3) 场景面板类型覆盖 ----------
head('3. 场景面板类型覆盖');
const renderersSrc = read('renderer/renderers.js');
const types = new Set();
for (const m of renderersSrc.matchAll(/renderers\[['"]([^'"]+)['"]\]\s*=/g)) types.add(m[1]);
for (const m of renderersSrc.matchAll(/\nrenderers\.([A-Za-z_$][\w$]*)\s*=/g)) types.add(m[1]);
console.log('  已注册类型：' + [...types].sort().join(', '));
const scDir = path.join(ROOT, 'scenarios');
const sceneIds = [];
for (const f of fs.readdirSync(scDir).filter((x) => x.endsWith('.json')).sort()) {
  let sc;
  try { sc = JSON.parse(read(path.join('scenarios', f))); }
  catch (e) { bad(f + ' 不是合法 JSON：' + e.message); continue; }
  sceneIds.push(sc.id);
  const miss = (sc.panels || []).filter((p) => !types.has(p.type)).map((p) => p.id + ':' + p.type);
  const line = `  [${sc.id}] ${sc.name} — ${(sc.panels || []).length} 面板` + (sc.first ? ' · first' : '');
  if (miss.length) bad(line + ' → 未注册类型 ' + miss.join(', '));
  else ok(line);
}

// ---------- 4) 渲染器 cleanup ----------
head('4. 渲染器定时器 cleanup');
const lines = renderersSrc.split(/\r?\n/);
const defs = [];
lines.forEach((l, i) => {
  if (/renderers(\.|\[)/.test(l) && /=\s*(\(|function)/.test(l) && !/^\s*\/\//.test(l)) {
    const m = l.match(/renderers(?:\[['"]([^'"]+)['"]\]|\.([A-Za-z_$][\w$]*))/);
    if (m) defs.push({ name: m[1] || m[2], line: i + 1 });
  }
});
let timerBad = 0;
for (let i = 0; i < defs.length; i++) {
  const d = defs[i];
  const end = i + 1 < defs.length ? defs[i + 1].line - 1 : lines.length;
  const block = lines.slice(d.line - 1, end).join('\n');
  // 注入到 webview 内部字符串里的定时器不算（它们跑在被嵌入页面里）
  const inlineStrs = (block.match(/`[^`]*`/g) || []).join('\n');
  const outside = block.split('`').filter((_, idx) => idx % 2 === 0).join('\n');
  const timers = (outside.match(/setInterval\(/g) || []).length;
  if (timers > 0 && !/return\s*(?:\(\s*\)\s*=>|function\s*\(|\(\)\s*=>)/.test(block)) {
    bad(`renderers.${d.name}（L${d.line}）有 ${timers} 个 setInterval 但没返回 cleanup`);
    timerBad++;
  }
}
if (!timerBad) ok('所有含 setInterval 的渲染器都返回了 cleanup');

// ---------- 5) 场景图标 ----------
head('5. 场景图标（ICONS）');
const rjs = read('renderer/renderer.js');
const iconBlock = (rjs.match(/const ICONS = \{[\s\S]*?\};/) || [''])[0];
for (const id of sceneIds) {
  const re = new RegExp(`'${id}'\\s*:\\s*'([^']+)'`);
  const m = iconBlock.match(re);
  if (!m) { warn(`ICONS 里没有 '${id}'（会退回默认 🧩）`); continue; }
  const icon = m[1];
  if (icon.endsWith('.png')) {
    if (exists(path.join('renderer', icon))) ok(`${id} → ${icon}`);
    else bad(`${id} 图标文件不存在：renderer/${icon}`);
  } else ok(`${id} → ${icon}（emoji）`);
}

// ---------- 6) 场景隔离：渲染器只能访问自己场景的命名空间 ----------
head('6. 场景隔离（渲染器命名空间）');
// 每个渲染器允许用的 app.* 命名空间（shell 有 python 模式，所以允许 stock）
const NS_EXPECT = {
  market: ['stock'], chart: ['stock'], board: ['stock'], usboard: ['stock'], screen: ['stock'],
  dash: ['oa'], shell: ['oa', 'stock'], file: ['oa'], log: ['oa'], web: ['oa'],
  'site-preview': ['site'], 'site-folder': ['site'], 'site-projects': ['site'], 'site-urls': ['site'],
  'site-about': ['site'], 'site-media': ['site'],
  // code-urls = 程序开发场景「网址」：只借 site 命名空间里的两个**宿主通用能力**
  // （HTTP 探活 site.probe / 系统浏览器打开 site.open），不读个人站的任何数据。
  // code = 程序开发场景自己的宿主能力（手机尺寸预览窗口），不是别的场景数据
  'code-urls': ['site', 'code'],
  'bl-live': ['blender'], 'bl-folder': ['blender'],
  harness: [], dsh: ['stock', 'oa', 'site'], ctl: [], reserved: [],
  // embed = 通用内嵌渲染器（首个用户：视频工作流 窗口1 ComfyUI 控制台），只用宿主 app 能力（开外链）
  embed: [],
  // app-window = 把外部工业软件窗口内置成面板（2026-10-28 客户「<客户>」）：
  //   只用宿主通用能力 app.appwin（主进程 owner-overlay），不碰任何场景命名空间
  'app-window': ['appwin'],
  // wb-cards = 工作台定制「客户与交付」卡片墙（2026-10-27，wb-ai 需求、dg-gui 实现）：
  //   只用宿主通用能力 —— app.oa.filesLocal（列模板/客户目录）、app.file.read（读 05-状态.md 第一行阶段）、app.app.openPath（打开文件夹）。不碰任何场景命名空间。
  'wb-cards': ['oa', 'file', 'app'],
  // neuron = 2026-10-26 新场景「命令」左窗：3D 记忆神经元。只用 app.file（读共享记忆/技能体积）与 app.topbar.open（定位文件），不碰任何场景命名空间
  // neuron 用 app.oa.filesLocal 列项目目录（宿主通用列目录能力，view 也这么用，不读 OA 数据）
  neuron: ['oa'],
  // flow = 通用流程图/流程画布渲染器（首个用户：视频工作流 左下「视频·全工作流」），
  //        纯 DOM + localStorage（图）+ 宿主 app.file（节点文件读写）+ app.net（工具节点看端口状态），
  //        不碰任何场景命名空间
  flow: [],
  // view = 通用预览/编辑渲染器（首个用户：视频工作流 窗口1）。用宿主 app（开外链/定位）+ app.file（读写文件），
  //        以及同文档的 window.__kunViews 注册表（面板间互相喊话，不是 app.* 命名空间）。
  //        2026-10-13 查第 6 项告警后据实放行 'oa'：view 只用到 app.oa 里的两个**宿主能力**——
  //        image（本地图读成 data: URL，文件面板的大图也走它）、filesLocal（列目录做缩略图网格），
  //        历史上挂在 oa 命名空间下，不是 OA 场景数据。除这两个成员外，view 里不要再添 oa.* 的用法。
  view: ['oa'],
  // cut = 2026-10-20 新加「抠图」场景主面板：本地 rembg（app.cut）+ 宿主 app（打开/定位/选文件），
  //        不碰任何场景数据命名空间
  cut: ['cut']
};
const KNOWN_NS = ['stock', 'oa', 'site', 'blender', 'balance', 'skills', 'theme', 'notes', 'app', 'file', 'net', 'cut', 'code'];
// 'app'（打开/定位路径）、'file'（读写本地文件）、'net'（探本机端口通不通）都是**宿主通用能力**，
// 跟场景数据无关，任何场景都允许用，不算串场景（'file'/'net' 是 2026-09-20 加工具节点时补进来的）
const HOST_NS = ['app', 'file', 'net'];
// 切块：到下一个顶层声明为止（这样相邻的独立工具函数不会被算进上一个渲染器，避免误报）
const blockOf = (startIdx) => {
  const out = [];
  for (let i = startIdx; i < lines.length; i++) {
    if (i > startIdx && /^(renderers[.[]|function\s|var\s|const\s|let\s|\/\/\s=====)/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join('\n');
};
const defIdx = [];
lines.forEach((l, i) => {
  if (/^renderers(\.|\[)/.test(l) && /=\s*(\(|function)/.test(l)) {
    const m = l.match(/renderers(?:\[['"]([^'"]+)['"]\]|\.([A-Za-z_$][\w$]*))/);
    if (m) defIdx.push({ name: m[1] || m[2], i });
  }
});
let nsBad = 0;
for (const d of defIdx) {
  const block = blockOf(d.i);
  // 去掉模板字符串内容（注入 webview 的脚本不算渲染器自己访问）
  const outside = block.split('`').filter((_, idx) => idx % 2 === 0).join('\n');
  const used = new Set();
  // 连成员一起收：window.app.oa.image → 'oa.image'；裸写 window.app.oa → 'oa'（照旧按命名空间判）
  for (const m of outside.matchAll(/window\.app\.([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?/g)) {
    if (KNOWN_NS.includes(m[1])) used.add(m[2] ? m[1] + '.' + m[2] : m[1]);
  }
  const exp = NS_EXPECT[d.name];
  if (!exp) continue;
  const extra = [...used].filter((x) => {
    const ns = x.split('.')[0];
    if (HOST_NS.includes(ns)) return false;          // 宿主通用能力：谁都可用
    if (exp.includes(ns)) return false;              // 本场景命名空间
    return true;
  });
  if (extra.length) {
    warn(`renderers.${d.name} 访问了非本场景命名空间: ${extra.join(', ')}（期望 ${exp.join('|') || '无'}）`);
    nsBad++;
  }
}
if (!nsBad) ok('所有渲染器只访问自己场景的命名空间');

// ---------- 7) 稳定性护栏（防"改完打不开"） ----------
head('7. 稳定性护栏');
const GUARDS = [
  ['main.js', /uncaughtException/, '主进程未捕获异常兜底'],
  ['main.js', /unhandledRejection/, '主进程 Promise 拒绝兜底'],
  ['main.js', /function reportFatal/, '致命错误上报（日志 + 弹框）'],
  ['renderer/renderer.js', /function safeStep/, '渲染层分步兜底'],
  ['renderer/renderer.js', /function bootFail/, '渲染层错误可见化'],
  ['renderer/renderer.js', /init\(\)\.catch/, 'init 顶层兜底']
];
for (const [file, re, label] of GUARDS) {
  if (!exists(file)) { warn(file + ' 不存在'); continue; }
  if (re.test(read(file))) ok(label);
  else bad(file + ' 缺少护栏：' + label);
}

// 7.x 拖出文件必须先 preventDefault 再调主进程 startDrag
//     （少了它：浏览器原生拖拽与 webContents.startDrag 同时启动 → 原生冲突 → 整个工作台闪退）
{
  const lines2 = renderersSrc.split(/\r?\n/);
  let dragBad = 0, dragChecked = 0;
  for (let i = 0; i < lines2.length; i++) {
    if (!/addEventListener\('dragstart'/.test(lines2[i])) continue;
    const body = lines2.slice(i, Math.min(i + 14, lines2.length)).join('\n');
    if (!/\.(startDrag|dragStart)\(/.test(body)) continue;   // 只查"交给主进程原生拖动"的那种
    dragChecked++;
    if (!/preventDefault/.test(body)) {
      bad(`renderers.js L${i + 1}：dragstart 里调了主进程 startDrag 却没有 preventDefault（会导致闪退）`);
      dragBad++;
    }
  }
  if (!dragBad) ok(`原生拖出 ${dragChecked} 处均先 preventDefault（不闪退）`);
}

// 7.y 拖进来的文件不能把窗口导航走（全局 drop 兜底）
if (/addEventListener\('drop'[\s\S]{0,120}preventDefault/.test(rjs)) ok('渲染层有全局 drop 兜底（拖入不跳转）');
else bad('renderer.js 缺少全局 drop 兜底：把文件拖进窗口会把界面导航走（观感像闪退）');

// 7.z 多窗口（场景分离）：窗口控制按发起方寻址 + 广播发全部窗口 + 布局可恢复
//     回归症状：分离窗口点「关闭」把主窗口关掉 → 整个应用连同其它场景一起消失
{
  const mjs = read('main.js');
  const MW = [
    [/function windowOfEvent\(/, '按 webContents 找窗口（每个窗口各管各的）'],
    [/function broadcast\(/, '全窗口广播（余额 / 启动进度 / 引擎就绪）'],
    [/ipcMain\.handle\('window:minimize', \(e\)/, '最小化按发起方寻址'],
    [/ipcMain\.handle\('window:close', \(e\)/, '关闭按发起方寻址'],
    [/ipcMain\.handle\('window:info'/, 'window:info（窗口要知道自己是谁）'],
    [/ipcMain\.handle\('window:open-scene'/, 'window:open-scene（把场景弹出成独立窗口）'],
    [/function openSceneWindow\(/, '已在独立窗口的场景 → 聚焦而不是重复开'],
    [/fitSavedBounds\(/, '布局恢复前做屏幕校验（副屏拔掉不丢窗口）'],
    [/saveWinLayout\(/, '窗口布局落盘（data/windows.json）'],
    [/solo: '1'/, '分离窗口 loadFile 带 solo=1（渲染层进入单场景模式）']
  ];
  for (const [re, label] of MW) {
    if (re.test(mjs)) ok(label);
    else bad('main.js 缺少多窗口护栏：' + label);
  }
  // 反向断言：窗口控制 IPC 不能再直接操作 mainWindow（那样分离窗口会去动主窗口）
  if (/ipcMain\.handle\('window:(minimize|close|toggle-maximize|is-maximized)', \(\)[^\n]*mainWindow/.test(mjs)) {
    bad('窗口控制 IPC 又绑回了 mainWindow（分离窗口的按钮会操作主窗口）');
  } else ok('窗口控制 IPC 没有绑回 mainWindow（分离窗口各管各的）');
  // 反向断言：不能再有"只发主窗口"的残留（分离窗口收不到引擎就绪 → 面板永远停在加载页）
  if (/mainWindow\.webContents\.send\(/.test(mjs)) {
    bad('main.js 里还有 mainWindow.webContents.send( → 应该走 broadcast()（否则分离窗口收不到）');
  } else ok('没有"只发主窗口"的广播残留');
  // 渲染层：分离模式与占位卡
  if (/soloSceneId/.test(rjs) && /classList\.add\('solo'\)/.test(rjs)) ok('渲染层识别 solo 模式并收起场景标签栏');
  else bad('renderer.js 没有 solo 模式识别（分离窗口会出现第二套标签栏）');
  if (/function detachedCard\(/.test(rjs)) ok('已在独立窗口的场景 → 主窗口显示占位卡而不是重复渲染');
  else bad('renderer.js 缺少占位卡：同一场景会在两个窗口里各跑一份');
}

// ---------- 8) 启动依赖预检（专治"改完打不开"） ----------
head('8. 启动依赖预检');
// 8.1 package.json 入口
try {
  const pkg = JSON.parse(read('package.json'));
  const mainEntry = pkg.main || 'index.js';
  if (fs.existsSync(path.join(ROOT, mainEntry))) ok('package.json main → ' + mainEntry);
  else bad('package.json main 指向的文件不存在：' + mainEntry);
} catch (e) { bad('package.json 读取/解析失败：' + e.message); }

// 8.2 main.js 里的相对 require 是否都存在
const mainSrc = read('main.js');
const reqs = [...mainSrc.matchAll(/require\(\s*'(\.\/[^']+)'\s*\)/g)].map((m) => m[1]);
let reqBad = 0;
for (const r of new Set(reqs)) {
  const p = path.join(ROOT, r.endsWith('.js') ? r : r + '.js');
  if (!fs.existsSync(p)) { bad('main.js require 的文件不存在：' + r); reqBad++; }
}
if (!reqBad) ok('main.js 的 ' + new Set(reqs).size + ' 个相对 require 全部存在');

// 8.3 main.js 必须在 BrowserWindow 里指向 preload.js，且文件存在
if (/preload:\s*path\.join\(__dirname,\s*'preload\.js'\)/.test(mainSrc)) ok('BrowserWindow 已挂 preload.js');
else bad('main.js 里找不到 preload.js 的挂载（window.app 会缺失）');
if (exists('preload.js')) ok('preload.js 存在');
else bad('preload.js 缺失');

// 8.4 index.html 引用的资源是否都在
if (exists('renderer/index.html')) {
  ok('renderer/index.html 存在');
  const html = read('renderer/index.html');
  const refs = [
    ...html.matchAll(/(?:src|href)="([^"]+)"/g)
  ].map((m) => m[1]).filter((u) => !/^(https?:|data:|#)/.test(u));
  let miss = 0;
  for (const u of new Set(refs)) {
    const p = path.join(ROOT, 'renderer', u.split('?')[0]);
    if (!fs.existsSync(p)) { bad('index.html 引用的资源不存在：' + u); miss++; }
  }
  if (!miss) ok('index.html 的 ' + new Set(refs).size + ' 个本地引用全部存在');
} else bad('renderer/index.html 缺失（窗口会空白）');

// 8.5 启动脚本与图标
for (const f of ['start.vbs', 'icon.ico', 'scripts/check-gui.mjs', 'scripts/backup-gui.mjs', 'scripts/restore-gui.mjs',
  'scripts/check-injected.mjs', 'scripts/sessions.mjs', 'scripts/engine-before.mjs', 'scripts/engine-after.mjs']) {
  if (exists(f)) ok(f + ' 存在');
  else warn(f + ' 缺失');
}
// 8.6 Electron 必须锁死版本：壳最脆的机制（webview 冻结 / 拖拽区 / 面板动画）全在 Electron 行为面上，
//     声明成 "latest" 时任何一次 npm install 都可能换掉它，出事只能靠快照回滚。
{
  const pkg = (() => { try { return JSON.parse(read('package.json')); } catch (e) { return null; } })();
  const dep = pkg && pkg.devDependencies && pkg.devDependencies.electron;
  const installed = (() => { try { return JSON.parse(read('node_modules/electron/package.json')).version; } catch (e) { return null; } })();
  if (!dep) warn('package.json 里没有声明 electron');
  else if (/^[\^~]|latest|x$/.test(String(dep))) bad('electron 依赖是浮动版本「' + dep + '」→ 改成精确版本（当前已安装 ' + (installed || '?') + '），并用 npm ci 安装');
  else {
    ok('electron 已锁死为 ' + dep + (installed ? '（已安装 ' + installed + '）' : ''));
    if (installed && installed !== dep) warn('已安装的 electron ' + installed + ' 与声明 ' + dep + ' 不一致 → 用 npm ci 重装');
  }
}

// ---------- 9. AI 面板：注入脚本 + 场景↔会话一一对应 ----------
// 这两件事坏掉时的症状是"AI 面板切不到该有的会话 / 会话错乱"，宿主文件语法检查查不出来，
// 所以固定并入自检：9.1 注入脚本能否解析（宿主 node --check 通过 ≠ 注入进去的脚本能跑）；
// 9.2 每个场景声明的 sessionTitle/pinTarget 是否命中引擎里真实存在的会话。
head('9. AI 面板：注入脚本与场景↔会话对照');
for (const s of ['scripts/check-injected.mjs', 'scripts/sessions.mjs']) {
  if (!exists(s)) { warn(s + ' 缺失，跳过'); continue; }
  const r = spawnSync(process.execPath, [s, ...(s.includes('sessions') ? ['--check'] : [])], { cwd: ROOT, encoding: 'utf8' });
  const out = String(r.stdout || '') + String(r.stderr || '');
  const lines = out.split(/\r?\n/).filter((l) => l.trim());
  const badLines = lines.filter((l) => /^✗/.test(l.trim()));
  if (r.status === 0) ok(s + ' → ' + (lines[lines.length - 1] || '通过'));
  else {
    bad(s + ' 未通过：');
    for (const l of (badLines.length ? badLines : lines.slice(-6))) console.log('      ' + l.trim());
  }
}

// ---------- 10. 目录契约（防止"装插件/扩功能时到处乱建目录、补丁乱放"） ----------
// 为什么要有这一项：功能是会长出来的，人（和 AI）最容易做的就是"随手新建一个目录/临时文件"，
// 半年后目录就烂了：不知道哪个文件夹有用、哪个能删、回滚该备份谁。
// 这里把"哪里放什么"变成机器可校验的规则（对应 项目信息.md §18 目录契约）。
//
// 规则：
//   10.1 顶层只允许清单内的条目；多出来的 → FAIL 并告诉它该放哪
//   10.2 GUI 根目录不许出现 skills/插件/extensions 这类"第二存放点"
//   10.3 顶层与 renderer/scripts/scenarios/data 里不许有临时/备份垃圾文件
//   10.4 会长大的东西要有上限：日志体积、快照数量、诊断截图数量
//   10.5 新增顶层源码必须同步进 scripts/backup-gui.mjs 的备份清单（否则回滚会漏文件）
//   10.6 引擎侧扩展点结构正确：技能必须有 SKILL.md；插件目录要有开发约定
head('10. 目录契约（哪里放什么 · 防乱建）');

const ALLOWED_DIRS = ['renderer', 'scenarios', 'scripts', 'data', 'captures', 'node_modules', '.git', 'GUI改造的项目信息'];   // 2026-10-16：归档并进 scenarios\归档，顶层不再有 归档
const ALLOWED_FILES = [
  'main.js', 'preload.js', 'stock-store.js', 'oa-store.js', 'oa-ssh.js', 'updater.js', 'crash.js',
  'package.json', 'package-lock.json', 'start.vbs', 'icon.ico', 'icon.png',
  'server.log', 'server.log.prev', '.gitignore', '项目信息.md', 'GUI改造私有记忆.md', '官方能力搬迁计划.md', '迁移手册.md',
];
// 这些名字出现在 GUI 根目录 = 放错地方（技能/插件属于引擎侧，见 §18）
const WRONG_PLACE_DIRS = ['skills', 'skill', 'plugins', 'plugin', 'extensions', 'extension',
  '插件', '技能', '扩展', 'mcp', 'cordis'];
// 临时/垃圾文件特征（顶层与几个源码目录里都不该有）
const JUNK_RE = /^(tmp[-_.]|_tmp|temp[-_.]|test[-_.]|新建|未命名|Copy of|副本|.*\.bak$|.*\.orig$|.*\.rej$|.*\.tmp$|.*~$|thumbs\.db$|desktop\.ini$|~\$.*)/i;

const topEntries = fs.readdirSync(ROOT, { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory() }));
const extraDirs = topEntries.filter((e) => e.dir && !ALLOWED_DIRS.includes(e.name));
const extraFiles = topEntries.filter((e) => !e.dir && !ALLOWED_FILES.includes(e.name));
if (!extraDirs.length && !extraFiles.length) ok('顶层条目都在契约清单内（' + ALLOWED_DIRS.length + ' 个目录 + ' + ALLOWED_FILES.length + ' 个文件）');
for (const e of extraDirs) bad('顶层多了目录「' + e.name + '」→ 不属于契约（放哪：见 项目信息.md §18；确需保留就登记进 ALLOWED_DIRS）');
for (const e of extraFiles) bad('顶层多了文件「' + e.name + '」→ 不属于契约（放哪：见 项目信息.md §18；源码文件还要加进 backup-gui.mjs 的 FILES）');

const wrongPlace = topEntries.filter((e) => e.dir && WRONG_PLACE_DIRS.includes(e.name.toLowerCase()));
if (!wrongPlace.length) ok('GUI 根目录没有 skills/插件/extensions 这类"第二存放点"');
for (const e of wrongPlace) bad('GUI 根目录出现「' + e.name + '」→ 技能放 .dsh/skills/、插件放 <工作台>\\引擎\\插件\\，别在 GUI 里另起一套');

let junk = 0;
for (const rel of ['', 'renderer', 'scripts', 'scenarios', 'data']) {
  const dir = path.join(ROOT, rel);
  if (!fs.existsSync(dir)) continue;
  for (const e of fs.readdirSync(dir)) {
    if (JUNK_RE.test(e)) { bad('临时/垃圾文件：' + (rel ? rel + '/' : '') + e + '（确认无用后删掉，别留在目录里）'); junk++; }
  }
}
if (!junk) ok('顶层与 renderer/ scripts/ scenarios/ data/ 没有临时/垃圾文件');

// 会长大的东西：必须有上限
const sizeOf = (p) => { try { return fs.statSync(path.join(ROOT, p)).size; } catch (e) { return 0; } };
const logMB = sizeOf('server.log') / 1048576;
if (logMB <= 8) ok('server.log ' + logMB.toFixed(1) + ' MB（上限 4MB，重启时自动轮转到 server.log.prev）');
else warn('server.log 已 ' + logMB.toFixed(1) + ' MB（重启 GUI 会自动轮转；轮转逻辑在 main.js 的 rotateLog）');
const bkCount = exists('data/backups') ? fs.readdirSync(path.join(ROOT, 'data', 'backups')).filter((d) => d.startsWith('gui-')).length : 0;
if (bkCount <= 10) ok('源码快照 ' + bkCount + ' 个（上限 10）');
else bad('源码快照 ' + bkCount + ' 个，超过上限 10 → 跑一次 node scripts/backup-gui.mjs 会清理（注意：别把它的输出管道给 Select-Object -First，会掐断清理）');
const capCount = exists('captures') ? fs.readdirSync(path.join(ROOT, 'captures')).length : 0;
if (capCount <= 5) ok('captures/ 诊断截图 ' + capCount + ' 个（纯诊断用，可随时删）');
else warn('captures/ 有 ' + capCount + ' 个文件（诊断截图，可随时清空）');

// 备份清单必须覆盖所有顶层源码条目（否则"回滚后少文件/回滚不干净"）
if (exists('scripts/backup-gui.mjs')) {
  const bk = read('scripts/backup-gui.mjs');
  const bkFiles = (bk.match(/const FILES = \[([\s\S]*?)\]/) || [, ''])[1];
  const bkDirs = (bk.match(/const DIRS = \[([\s\S]*?)\]/) || [, ''])[1];
  const listed = (bkFiles + bkDirs).replace(/\/\/.*$/gm, '');
  // runtimeOnly = 不需要进备份清单的顶层条目：
  //   data/captures = 运行时数据；node_modules = 可重装；日志 = 可再生；
  //   .gitignore = 一行的配置；**`.git` = 版本控制本身**（备份快照就在仓库内，纳入会自我嵌套）
  const runtimeOnly = ['data', 'captures', 'node_modules', 'server.log', 'server.log.prev', '.gitignore', '.git'];
  const missing = ALLOWED_DIRS.concat(ALLOWED_FILES)
    .filter((x) => !runtimeOnly.includes(x))
    .filter((x) => !new RegExp("['\"]" + x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "['\"]").test(listed));
  if (!missing.length) ok('backup-gui.mjs 的备份清单覆盖了全部顶层源码条目');
  else bad('这些顶层条目没进备份清单（回滚会漏）：' + missing.join(', ') + ' → 加进 scripts/backup-gui.mjs 的 FILES/DIRS');
}

// 引擎侧扩展点（技能 / 插件）结构是否正确
// 引擎目录：2026-10-10 起 main.js 把它改成了「与本工作台同级」自动推导（带写死兜底），
// 所以这里两种写法都认 —— 先认老的字面量，认不到再取推导式里那个兜底字面量。
const _mainSrc = read('main.js');
const harnessDir = ((_mainSrc.match(/const HARNESS_DIR = '([^']+)'/) || [])[1])
  || ((_mainSrc.match(/HARNESS_DIR[\s\S]{0,600}?return '([^']+)'/) || [])[1]);
if (harnessDir && fs.existsSync(harnessDir)) {
  const skillsDir = path.join(harnessDir, '.dsh', 'skills');
  if (fs.existsSync(skillsDir)) {
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    // 约定：下划线开头 = 说明/文档目录，不是技能（例如 `_说明/技能体系.md`），不要求 SKILL.md
    const docDirs = entries.filter((e) => e.isDirectory() && e.name.startsWith('_')).map((e) => e.name);
    const skillDirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'));
    const missing = skillDirs.filter((e) => !fs.existsSync(path.join(skillsDir, e.name, 'SKILL.md'))).map((e) => e.name);
    const strayFiles = entries.filter((e) => !e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
    if (!missing.length) {
      ok('技能目录结构正确（' + skillDirs.length + ' 个技能，每个都有 SKILL.md'
        + (docDirs.length ? '；另有 ' + docDirs.length + ' 个下划线说明目录' : '') + '）');
    }
    for (const m of missing) bad('技能「' + m + '」里没有 SKILL.md → 技能不会被加载（目录名要与 frontmatter 的 name 一致；纯说明目录请用下划线开头）');
    if (strayFiles.length) warn('技能根目录有散落文件：' + strayFiles.join(', ') + '（技能应各自一个文件夹）');
  } else warn('没找到 ' + skillsDir + '（技能根目录）');
  const pluginDir = path.join(harnessDir, '插件');
  if (fs.existsSync(pluginDir)) {
    const convention = fs.existsSync(path.join(pluginDir, '开发约定.md'));
    const n = fs.readdirSync(pluginDir, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
    if (convention) ok('插件目录 ' + n + ' 个 + 开发约定.md 在位（引擎侧插件的唯一落点）');
    else warn('插件目录里没有「开发约定.md」→ 建议补一份，避免后来人乱放');
  } else warn('没找到 ' + pluginDir + '（引擎侧插件落点）');
} else {
  warn('读不到引擎目录（main.js 的 HARNESS_DIR），跳过引擎侧结构检查');
}

// ---------- 11. 引擎接线（升级后最容易"静默降级"的地方） ----------
// 壳是围绕引擎的**内部实现**做的（DOM 属性 / localStorage 键 / 会话行结构 / 产物入口）。
// 上游一改，壳不会崩但会静默降级：面板藏不住侧栏、钉会话失效、状态小字乱报。
// 这里直接复用 engine-after.mjs（它核对：产物是否配套 / 上游实现是否还在 / 插件接线 / 数据目录 / 适配版本），
// 再加两条壳侧自身的检查。
head('11. 引擎接线（产物配套 · 上游实现 · 插件接线 · 适配版本）');
if (exists('scripts/engine-after.mjs')) {
  const r = spawnSync(process.execPath, ['scripts/engine-after.mjs'], { cwd: ROOT, encoding: 'utf8' });
  const lines = (String(r.stdout || '') + String(r.stderr || '')).split(/\r?\n/).filter((l) => l.trim());
  for (const l of lines) {
    const t = l.trim();
    if (/^✓/.test(t)) ok(t.replace(/^✓\s*/, ''));
    else if (/^✗/.test(t)) bad(t.replace(/^✗\s*/, ''));
    else if (/^!/.test(t)) warn(t.replace(/^!\s*/, ''));
  }
  if (r.status !== 0) bad('engine-after.mjs 报告了需要处理的问题（见上）');
} else {
  warn('scripts/engine-after.mjs 缺失，跳过引擎接线核对');
}
{
  const rj = read('renderer/renderers.js');
  const adapted = (rj.match(/var\s+ADAPTED_ENGINE\s*=\s*'([^']+)'/) || [])[1];
  if (adapted) ok('壳里记录了"已验证的引擎版本"：' + adapted + '（版本不一致时品牌区小点会转琥珀色并给出提示）');
  else bad('renderer/renderers.js 里缺少 ADAPTED_ENGINE（引擎升级后就没人对账了）');
  if (/ADAPTED_ENGINE/.test(rj) && /brand-dot-warn/.test(read('renderer/styles.css'))) ok('版本不一致的提示样式在位（brand-dot-warn）');
  else warn('版本不一致的提示样式缺失（styles.css 里应有 .brand-dot.brand-dot-warn）');
}

// ---------- 汇总 ----------
console.log('\n' + '-'.repeat(52));
console.log(fails === 0 ? `全部通过 ✓（warning ${warns}）` : `发现 ${fails} 个 FAIL、${warns} 个 warning ✗`);
process.exit(fails === 0 ? 0 : 1);
