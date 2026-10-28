// DSH 引擎 desktop window (Electron wrapper) — 多场景版
// 场景 0：内嵌 DSH 引擎 Web UI（带 token，默认初始界面）
// 场景 1：<客户> OA 系统运维（本地渲染）
// 场景 2：大A / 美股分析（本地渲染）
// 设计：壳与 Harness 解耦——只通过 HTTP+token 认识它；场景配置在 scenarios/ 下。
const { app, BrowserWindow, dialog, shell, ipcMain, webContents, nativeImage, screen } = require('electron');
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const DSH_PORT = String(process.env.DSH_PORT || '3083');
const BASE = 'http://127.0.0.1:' + DSH_PORT;
// 客户包：把外壳目录暴露给 preload / renderer（读 data\boot-animation.json 用）
process.env.DSH_SHELL_DIR = __dirname;

// ⭐ 应用身份（AppUserModelID）：必须在 **app ready 之前**调用才对 Windows 任务栏生效。
//   2026-10-13 查明：原来这行写在 app.whenReady() 回调里（文件靠后位置）⇒ Windows 认不出身份，
//   任务栏右键菜单里显示成「Electron」、图标退回 Electron 原子图标 ✗。提到顶部即可。
//   配套：开始菜单/桌面那两条「工作台」快捷方式必须带同一个 AUMID（脚本 %TEMP%\set-lnk-aumid2.ps1 写过）。
app.setAppUserModelId('deepseek.harness.gui.v2');   // 2026-10-13 换新身份：旧的 deepseek.harness.gui 已被 Windows 按身份缓存成原子图标，绕开它
// 引擎目录：**优先按"与本工作台同级"推导**（换电脑 / 换盘符都不用改这行），推不出来才退回写死值。
// 2026-10-10 为「换电脑一比一复制」加（见 项目信息.md §39）：只要引擎与工作台仍是同级目录，任何盘符都能跑。
const HARNESS_DIR = (function () {
  const sibling = path.join(path.dirname(__dirname), '引擎');
  try { if (fs.existsSync(path.join(sibling, 'apps', 'cli'))) return sibling; } catch (e) { /* ignore */ }
  return path.join(path.dirname(__dirname), '引擎');
})();
const NPM_BIN = path.join(os.homedir(), 'AppData', 'Roaming', 'npm');
const PNPM_CMD = path.join(NPM_BIN, 'pnpm.cmd');
const LOG_FILE = path.join(__dirname, 'server.log');
const LOG_PREV = path.join(__dirname, 'server.log.prev');
const LOG_MAX_BYTES = 4 * 1024 * 1024;   // 超过 4MB 就轮转，只留上一份（见 rotateLog）

// ---- 日志轮转：日志只增不减会把根目录搞得乱七八糟（曾经涨到 3MB+ 且没有上限）----
// 启动时检查一次：超过上限就把旧日志改名为 server.log.prev（覆盖更早的那份），新日志从空开始。
// 只保留 1 份历史，避免"日志文件越堆越多"这种典型的目录污染。
function rotateLog() {
  try {
    const st = fs.statSync(LOG_FILE);
    if (st.size <= LOG_MAX_BYTES) return;
    try { fs.rmSync(LOG_PREV, { force: true }); } catch (e) { /* ignore */ }
    fs.renameSync(LOG_FILE, LOG_PREV);
  } catch (e) { /* 文件不存在或正被占用：忽略，不影响启动 */ }
}
rotateLog();
const SCENARIOS_DIR = path.join(__dirname, 'scenarios');

// ---- 个人站场景：官网静态服务（<工作台> → http://127.0.0.1:SITE_PORT）----
const SITE_DIR = '<工作台>';
// 2026-10-22：第二个预览源——DSH 社区站（本地目录，静态服务用 /__community/ 前缀直出，
// 不跟官网同根，免得社区站的源码被当成官网页面发布出去）
const COMMUNITY_DIR = '<工作台>';
// 2026-10-22：个人站场景「本地文件」面板的浏览根 = 项目工程总目录（原来写死成官网目录）
const SITE_BROWSE_DIR = '<工作台>';
const SITE_PORT = 31238;
let siteServer = null;

// ---- 数据盘隔离：所有 Electron 运行时数据（userData/session、webview partition、localStorage 等）
// 强制写到 D 盘项目目录，绝不落到 C 盘。必须在任何 app API 之前设置。----
const PROFILE_DIR = path.join(__dirname, 'data', 'electron-profile');
try { fs.mkdirSync(PROFILE_DIR, { recursive: true }); } catch (e) { /* ignore */ }
try { app.setPath('userData', PROFILE_DIR); } catch (e) { /* ignore */ }
try { app.setPath('sessionData', path.join(PROFILE_DIR, 'sessions')); } catch (e) { /* ignore */ }

// 启动计时基准：日志里会打印「窗口可见耗时」与「引擎就绪总耗时」，便于日后评估启动速度
const APP_T0 = Date.now();

let mainWindow = null;
let serverProc = null;
let logTail = '';
let harnessToken = null;

function log(line) {
  try { fs.appendFileSync(LOG_FILE, line + '\r\n'); } catch (e) { /* ignore */ }
  logTail = (logTail + line + '\n').slice(-1200);
}

// ==================== 多窗口（场景分离） ====================
// 主窗口照旧（场景 = 标签页）；任意场景可「弹出」成独立窗口，一屏看一个场景。
// 三条纪律（踩了就出鬼）：
//   ① 窗口控制类 IPC 一律按 e.sender 找窗口 —— 否则分离窗口上的最小化/关闭会去动主窗口；
//   ② 广播类事件（余额 / 启动进度 / 引擎就绪）发给全部窗口 —— 从前只发 mainWindow；
//   ③ Blender「内置」画面只能挂在一个窗口上（它是贴在窗口上的独立顶层窗口）→ 用 blenderEmbedOwner 记账。
const detachWindows = [];                        // 主窗口之外的场景窗口
const WIN_LAYOUT_FILE = path.join(__dirname, 'data', 'windows.json');
// 场景标签顺序（拖拽换位的结果）：**主进程是唯一权威**。
// 为什么不让渲染层自己 localStorage：① 顺序要跨窗口一致（主窗口 / 独立场景窗口 / 将来任何消费方）；
// ② file:// 下的 localStorage 可能被清掉或与分区绑定。渲染层只负责"拖完把新顺序报上来"，读一律读这里。
const SCENE_ORDER_FILE = path.join(__dirname, 'data', 'scene-tab-order.json');
const layoutCache = { main: null, detached: {} }; // sceneId -> 几何（关窗后仍记得，供下次启动恢复）
let quitRequested = false;                       // 主窗口关闭 = 整个应用退出（分离窗口一起关，但布局要留下）

function allWindows() {
  const out = [];
  if (mainWindow && !mainWindow.isDestroyed()) out.push(mainWindow);
  for (const w of detachWindows) { if (w && !w.isDestroyed()) out.push(w); }
  return out;
}
function broadcast(channel, payload) {
  for (const w of allWindows()) {
    try { w.webContents.send(channel, payload); } catch (e) { /* ignore */ }
  }
}
function windowOfEvent(e) {
  try {
    const w = BrowserWindow.fromWebContents(e && e.sender);
    return (w && !w.isDestroyed()) ? w : null;
  } catch (err) { return null; }
}
function sceneNameOf(id) {
  try {
    const hit = listScenarios().filter(function (s) { return s.id === id; })[0];
    return (hit && hit.name) || String(id || '场景');
  } catch (e) { return String(id || '场景'); }
}
function detachedSceneIds() {
  const out = [];
  for (const w of detachWindows) { if (w && !w.isDestroyed() && w.kunScene) out.push(w.kunScene); }
  return out;
}
function findSceneWindow(sceneId) {
  for (const w of detachWindows) {
    if (w && !w.isDestroyed() && w.kunScene === sceneId) return w;
  }
  return null;
}
function notifyWindowsChanged() {
  broadcast('windows:changed', { detached: detachedSceneIds() });
}

// 记录窗口几何（含所在屏幕）；关窗后仍留着，供下次启动恢复
function rectOfWindow(win) {
  try {
    const max = win.isMaximized();
    const b = (max && typeof win.getNormalBounds === 'function') ? win.getNormalBounds() : win.getBounds();
    let displayId = '';
    try { const d = screen.getDisplayMatching(b); if (d) displayId = String(d.id); } catch (e) { /* ignore */ }
    return { x: b.x, y: b.y, w: b.width, h: b.height, maximized: max, display: displayId };
  } catch (e) { return null; }
}
function noteWindowRect(win) {
  if (!win || win.isDestroyed()) return;
  const r = rectOfWindow(win);
  if (!r) return;
  if (win === mainWindow) layoutCache.main = r;
  else if (win.kunScene) layoutCache.detached[win.kunScene] = r;
}
let layoutSaveTimer = null;
function saveWinLayoutSoon() {
  if (layoutSaveTimer) clearTimeout(layoutSaveTimer);
  layoutSaveTimer = setTimeout(function () { saveWinLayout(); }, 600);
}
function saveWinLayout() {
  if (layoutSaveTimer) { clearTimeout(layoutSaveTimer); layoutSaveTimer = null; }
  for (const w of allWindows()) noteWindowRect(w);
  try {
    fs.mkdirSync(path.dirname(WIN_LAYOUT_FILE), { recursive: true });
    fs.writeFileSync(WIN_LAYOUT_FILE, JSON.stringify({
      version: 1,
      savedAt: new Date().toISOString(),
      main: layoutCache.main || null,
      detached: Object.keys(layoutCache.detached).map(function (sid) {
        return Object.assign({ scene: sid }, layoutCache.detached[sid]);
      })
    }, null, 2));
  } catch (e) { log('[win] 保存窗口布局失败: ' + ((e && e.message) || e)); }
}
function loadWinLayout() {
  try {
    const raw = JSON.parse(fs.readFileSync(WIN_LAYOUT_FILE, 'utf8'));
    if (!raw || typeof raw !== 'object') return;
    layoutCache.main = raw.main || null;
    const map = {};
    (Array.isArray(raw.detached) ? raw.detached : []).forEach(function (d) {
      if (d && d.scene) map[String(d.scene)] = d;
    });
    layoutCache.detached = map;
  } catch (e) { /* 首次运行没有该文件，正常 */ }
}
// 恢复前校验：副屏被拔 / 坐标跑到屏幕外 → 夹回工作区，避免"窗口开了但看不见"
function fitSavedBounds(saved, defW, defH) {
  const out = { bounds: null, maximized: false };
  if (!saved || typeof saved.x !== 'number' || typeof saved.y !== 'number') return out;
  const w = Math.max(680, Math.round(saved.w || defW));
  const h = Math.max(460, Math.round(saved.h || defH));
  out.maximized = !!saved.maximized;
  let area = null;
  try {
    const displays = screen.getAllDisplays();
    const same = displays.filter(function (d) { return String(d.id) === String(saved.display); })[0];
    const inter = displays.filter(function (d) {
      const a = d.workArea;
      return saved.x < a.x + a.width && saved.x + w > a.x && saved.y < a.y + a.height && saved.y + h > a.y;
    })[0];
    if (same && inter && same.id === inter.id) area = same.workArea;
    else if (inter) area = inter.workArea;
    if (!area) {
      const wa = screen.getPrimaryDisplay().workArea;
      out.bounds = {
        x: Math.round(wa.x + Math.max(0, (wa.width - Math.min(w, wa.width)) / 2)),
        y: Math.round(wa.y + Math.max(0, (wa.height - Math.min(h, wa.height)) / 2)),
        width: Math.min(w, wa.width),
        height: Math.min(h, wa.height)
      };
      out.clamped = true;
      return out;   // 副屏不在了 → 主屏居中
    }
  } catch (e) { return out; }
  out.bounds = {
    x: Math.round(Math.min(Math.max(saved.x, area.x), Math.max(area.x, area.x + area.width - w))),
    y: Math.round(Math.min(Math.max(saved.y, area.y), Math.max(area.y, area.y + area.height - h))),
    width: w,
    height: h
  };
  return out;
}

// ---- 全局兜底：任何未捕获异常都写日志 + 弹一次可见提示，绝不"静默打不开" ----
// 目的：以前一旦启动流程里抛错，表现就是"点了没反应/窗口不出来"，很难查。
// 现在任何致命错误都会：① 写进 server.log ② 弹一次错误框（含日志路径与回滚提示）。
let fatalShown = false;
function reportFatal(where, err) {
  const detail = (err && (err.stack || err.message)) || String(err);
  try { log('[FATAL] ' + where + ': ' + detail); } catch (e) { /* ignore */ }
  if (fatalShown) return;
  fatalShown = true;
  try {
    dialog.showErrorBox(
      'DSH 引擎 出错（已记录日志）',
      where + '\n\n' + String(detail).slice(0, 1200) +
      '\n\n日志：' + LOG_FILE +
      '\n回滚：把 data\\backups\\gui-<最新> 里的文件覆盖回来即可。'
    );
  } catch (e) { /* 弹框本身失败就只留日志 */ }
}
process.on('uncaughtException', function (err) { reportFatal('主进程未捕获异常', err); });
process.on('unhandledRejection', function (reason) { reportFatal('主进程未处理的 Promise 拒绝', reason); });

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

function probe() {
  return new Promise(function (resolve) {
    const req = http.get(BASE + '/', { timeout: 1500 }, function (res) {
      res.resume();
      resolve(true);
    });
    req.on('error', function () { resolve(false); });
    req.on('timeout', function () { req.destroy(); resolve(false); });
  });
}

// 从 dsh web 输出中解析 token 与完整 URL
function captureToken(text) {
  const m = String(text).match(new RegExp('http:\\/\\/127\\.0\\.0\\.1:' + DSH_PORT + '\\/\\?token=([A-Za-z0-9_\\-]+)'));
  if (m && m[1]) {
    harnessToken = m[1];
    log('[token] captured: ' + m[1]);
  }
}

// ---- 启动进度（渲染层加载页用）----
let lastBoot = { stage: 'init', pct: 0, text: '准备中…', detail: '', ts: Date.now() };
function sendBoot(patch) {
  lastBoot = Object.assign({}, lastBoot, patch, { ts: Date.now() });
  try { broadcast('boot:progress', lastBoot); } catch (e) { /* ignore */ }
  return lastBoot;
}

// 已构建的 CLI 入口：直接 node 跑它，可跳过 cmd.exe → pnpm → tsx 三层转译，明显加快引擎启动
const CLI_BUILT = path.join(HARNESS_DIR, 'apps', 'cli', 'lib', 'bin.js');

function serverSpawnEnv() {
  const env = Object.assign({}, process.env);
  env.Path = NPM_BIN + ';' + (env.Path || '');
  // DSH_HOME 显式指向 D 盘项目目录（数据盘隔离：会话/存储/缓存绝不落 C 盘）。
  // 不设置的话 dsh 默认用 <用户目录>\<user>\.dsh，导致历史会话在界面里"消失"。
  env.DSH_HOME = process.env.DSH_CUSTOMER_HOME || path.join(HARNESS_DIR, '.dsh');
  return env;
}

// 统一挂上 stdout/stderr/exit 处理（解析 token + 写日志）
function wireServerProc(proc) {
  proc.stdout.on('data', function (d) {
    const s = String(d);
    captureToken(s);
    log('[out] ' + s.trim());
  });
  proc.stderr.on('data', function (d) {
    const s = String(d);
    captureToken(s);
    log('[err] ' + s.trim());
  });
  proc.on('exit', function (code) { log('[server exited] code=' + code); });
  return proc;
}

// 解析可用的 node 可执行文件（优先系统 node，其次 Electron 以纯 Node 模式运行自身）
// harness 要求 node ^22.19 || >=24
let cachedNodeExe = null;
function resolveNodeExe() {
  if (cachedNodeExe !== null) return cachedNodeExe;
  cachedNodeExe = '';
  if (process.env.DSH_NODE) {
    try { if (fs.statSync(process.env.DSH_NODE).isFile()) { cachedNodeExe = process.env.DSH_NODE; return cachedNodeExe; } } catch (e) { /* ignore */ }
  }
  const dirs = String(process.env.Path || process.env.PATH || '').split(path.delimiter).filter(Boolean);
  // 末位兜底：本机常见安装位置（PATH 里没有 node 时仍可直连）
  dirs.push('<盘根>:\\software\\node.js');
  for (const d of dirs) {
    const p = path.join(d, 'node.exe');
    try { if (fs.statSync(p).isFile()) { cachedNodeExe = p; return cachedNodeExe; } } catch (e) { /* next */ }
  }
  log('[boot] 未找到系统 node，将用 Electron 的 Node 模式直跑');
  return cachedNodeExe;
}

// 方式一（首选）：直跑构建产物（无 cmd / 无 pnpm / 无 tsx）
function spawnServerDirect() {
  const env = serverSpawnEnv();
  const nodeExe = resolveNodeExe();
  let cmd, args;
  if (nodeExe) {
    cmd = nodeExe;
    args = [CLI_BUILT, 'web', '--no-open', '--port', DSH_PORT];
  } else {
    // Electron 二进制以纯 Node 运行（内置 Node 24.18，满足 engines 要求）
    env.ELECTRON_RUN_AS_NODE = '1';
    cmd = process.execPath;
    args = [CLI_BUILT, 'web', '--no-open', '--port', DSH_PORT];
  }
  log('[boot] direct: ' + cmd + ' ' + args.join(' '));
  return wireServerProc(spawn(cmd, args, {
    cwd: HARNESS_DIR,
    env: env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  }));
}

// 方式二（兜底）：原来的 pnpm 脚本（走 tsx 实时转译，慢但兼容性最好）
function spawnServerPnpm() {
  return wireServerProc(spawn('cmd.exe', ['/c', PNPM_CMD + ' dsh web --no-open --port ' + DSH_PORT], {
    cwd: HARNESS_DIR,
    env: serverSpawnEnv(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  }));
}

// 引擎是不是**别人**拉起来的（我们只是复用）：
//   true ⇒ 我们看不到它启动时打印的 token，日志历史里的 token 也只对"我们自己拉起的那次"有效；
//   引擎在外部重启后旧 token 立刻失效（实测白屏 `dsh web authentication required`）。
//   所以复用外部引擎时，主界面改走本机保命入口 `http://127.0.0.1:<SITE_PORT>/chat`（实时用当前 token 跳转）。
let engineIsForeign = false
const BOOT_FAIL_FILE = path.join(__dirname, 'data', 'engine-boot-fail.json')

function bumpBootFail() {
  let n = 0
  try { n = Number(JSON.parse(fs.readFileSync(BOOT_FAIL_FILE, 'utf8')).count) || 0 } catch { /* first */ }
  n += 1
  try { fs.writeFileSync(BOOT_FAIL_FILE, JSON.stringify({ count: n, at: new Date().toISOString() }, null, 2) + '\n', 'utf8') } catch { /* ignore */ }
  return n
}
function resetBootFail() {
  try { fs.writeFileSync(BOOT_FAIL_FILE, JSON.stringify({ count: 0, at: new Date().toISOString() }, null, 2) + '\n', 'utf8') } catch { /* ignore */ }
}

/**
 * 引擎成功启动后，把当前配置标成“正常点”（2026-10-21 宿主：升级卡死后要能回到上次能用）。
 * 只备份 17 个启动配置，不碰源码/构建；失败静默，不影响启动。
 */
function markEngineGood() {
  try {
    const tool = path.join(__dirname, '..', '工具', '引擎快照.mjs');
    if (!fs.existsSync(tool)) return;
    topbarRunAsync(tool, ['--save', '--quiet'], 120000).then(function (r) {
      if (r && r.ok) log('[engine] 已更新“正常点”配置快照');
      else log('[engine] 正常点快照失败: ' + String((r && r.out) || '').slice(0, 160));
    });
  } catch (e) { log('[engine] 正常点快照异常: ' + String((e && e.message) || e)); }
}

async function startServer() {
  sendBoot({ stage: 'check', pct: 6, text: '检查引擎状态…', detail: '' });
  if (await probe()) {
    log('reuse: port already listening');
    engineIsForeign = true;
    // 端口已在监听时，token 只能尝试从日志历史里找（仅当"我们自己曾拉起过它"时才对）
    if (!harnessToken) {
      const hist = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8') : '';
      const m = hist.match(/token=([A-Za-z0-9_\-]+)/);
      if (m) harnessToken = m[1];
    }
    log('[engine] 复用外部引擎 ⇒ 主界面走保命入口 http://127.0.0.1:' + SITE_PORT + '/chat（token 每次实时转发，永远是最新的）');
    sendBoot({ stage: 'ready', pct: 92, text: '引擎已就绪', detail: '复用正在运行的实例' });
    resetBootFail();
    markEngineGood();
    return true;
  }
  const plans = [];
  if (fs.existsSync(CLI_BUILT)) {
    plans.push({ label: '内置入口', detail: 'apps/cli/lib/bin.js（跳过 pnpm / tsx）', spawn: spawnServerDirect, budget: 45 });
  }
  plans.push({ label: 'pnpm 脚本', detail: 'pnpm dsh web（tsx 转译，兜底）', spawn: spawnServerPnpm, budget: 90 });

  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i];
    sendBoot({ stage: 'spawn', pct: 12, text: '正在启动 Harness 引擎…', detail: plan.detail });
    serverProc = plan.spawn();
    const proc = serverProc;
    const t0 = Date.now();
    while ((Date.now() - t0) < plan.budget * 1000) {
      await sleep(300);   // 300ms 轮询：引擎就绪后最多 0.3s 就能进入下一步（原来 1s）
      if (await probe()) {
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        log('engine ready in ' + secs + 's via ' + plan.label);
        sendBoot({ stage: 'ready', pct: 92, text: '引擎已就绪，正在加载界面…', detail: plan.label + ' · ' + secs + 's' });
        resetBootFail();
        markEngineGood();
        return true;
      }
      if (proc.exitCode !== null) {
        log(plan.label + ' exited early (code=' + proc.exitCode + ')');
        sendBoot({ stage: 'spawn', pct: 14, text: '该启动方式未成功，正在尝试兜底…', detail: plan.label + ' 退出（code ' + proc.exitCode + '）' });
        break;
      }
      const el = (Date.now() - t0) / 1000;
      const pct = Math.min(88, 14 + Math.round((el / plan.budget) * 74));
      sendBoot({ stage: 'wait', pct: pct, text: '引擎启动中…', detail: plan.detail + ' · ' + el.toFixed(0) + 's' });
    }
    killServer();
  }
  sendBoot({ stage: 'error', pct: 100, text: '引擎启动失败', detail: '可点「重试」，或查看 server.log' });
  try {
    const n = bumpBootFail()
    log('[engine] start failed, consecutive=' + n)
    // 连续两次起不来：自动回退到上一次“正常点”配置，再让用户点重试。
    if (n >= 2) {
      const tool = path.join(__dirname, '..', '工具', '引擎快照.mjs')
      if (fs.existsSync(tool)) {
        log('[engine] 连续失败 ⇒ 自动回退引擎配置正常点')
        topbarRunAsync(tool, ['--restore', '--yes'], 120000).then(function (r) {
          log('[engine] 自动回退' + (r && r.ok ? '完成' : '失败: ' + String((r && r.out) || '').slice(0, 160)))
        })
        resetBootFail()
      }
    }
  } catch (e) { log('[engine] boot-fail 计数异常: ' + String((e && e.message) || e)) }
  return false
}

function killServer() {
  if (serverProc) {
    try {
      spawnSync('taskkill', ['/pid', String(serverProc.pid), '/T', '/F'], { windowsHide: true });
    } catch (e) { /* ignore */ }
    serverProc = null;
  }
}

// ---- 场景标签顺序：读 / 写 / 应用（见 SCENE_ORDER_FILE 处的说明）----
function readSceneTabOrder() {
  try {
    const j = JSON.parse(fs.readFileSync(SCENE_ORDER_FILE, 'utf8'));
    if (j && Array.isArray(j.ids)) return j.ids.filter((x) => typeof x === 'string' && x);
  } catch (e) { /* 没有文件 / 内容坏了，都按"没存过"处理 */ }
  return [];
}
function saveSceneTabOrder(ids) {
  const clean = [];
  for (const raw of (Array.isArray(ids) ? ids : [])) {
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (!id || clean.indexOf(id) >= 0) continue;   // 去空、去重
    clean.push(id);
    if (clean.length >= 200) break;                // 上限：坏数据也写不爆文件
  }
  try {
    fs.mkdirSync(path.dirname(SCENE_ORDER_FILE), { recursive: true });
    fs.writeFileSync(SCENE_ORDER_FILE, JSON.stringify({
      version: 1, savedAt: new Date().toISOString(), ids: clean
    }, null, 2));
  } catch (e) { log('[tabs] 保存场景标签顺序失败: ' + ((e && e.message) || e)); }
  return clean;
}
/** 按存下来的顺序排：已删掉的场景自动丢、新场景按 json 自然序追加在后面；标了 first 的场景固定在最前。 */
function applySceneTabOrder(list) {
  const saved = readSceneTabOrder();
  if (!saved.length) return list;
  const byId = {};
  list.forEach((s) => { byId[s.id] = s; });
  const ordered = saved.map((id) => byId[id]).filter(Boolean)
    .concat(list.filter((s) => saved.indexOf(s.id) < 0));
  return ordered.filter((s) => s.first).concat(ordered.filter((s) => !s.first));
}

// ---- 读取场景配置（scenarios/*.json）----
function listScenarios() {
  const out = [];
  if (!fs.existsSync(SCENARIOS_DIR)) return out;
  for (const f of fs.readdirSync(SCENARIOS_DIR).sort()) {
    if (f.startsWith('_')) continue;   // 客户版：_模板-*.json 不参与场景列表
    if (!f.endsWith('.json')) continue;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(SCENARIOS_DIR, f), 'utf8'));
      if (s && s.id) out.push({ id: s.id, name: s.name, description: s.description || '', first: !!s.first });
    } catch (e) { /* skip bad json */ }
  }
  // 在这里就排好 ⇒ 任何消费方（主窗口标签栏 / 独立场景窗口 / 以后的新界面）拿到的顺序天然一致
  return applySceneTabOrder(out);
}

function getScenario(id) {
  const f = path.join(SCENARIOS_DIR, id + '.json');
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; }
}

// ---- 多公司模板支持：当前场景的 meta（可覆盖 SSH/服务/映射/日志/网址）----
// meta 缺省 → 全部回落 oa.db 全局配置（原有场景行为不变）
let oaActiveScenario = 'oa-ops';
function scenarioMeta(sid) {
  const s = getScenario(sid || oaActiveScenario);
  return (s && s.meta && typeof s.meta === 'object') ? s.meta : {};
}
function applyOaScenario(sid) {
  const id = String(sid || '').trim();
  if (!id) return { ok: false, err: '缺少场景 id' };
  oaActiveScenario = id;
  const m = scenarioMeta(id);
  try { oaSsh.setMeta(m); } catch (e) { /* ignore */ }
  invalidateOaCache();          // 切场景后所有采集缓存作废（不同公司数据不能混）
  const sc = getScenario(id);
  return {
    ok: true,
    id: id,
    name: (sc && sc.name) || id,
    company: m.company || '',
    hasMeta: !!(m && Object.keys(m).length),
    ssh: { host: (m.ssh && m.ssh.host) || oaStore.getConfig('ssh.host') || '', user: (m.ssh && m.ssh.user) || oaStore.getConfig('ssh.user') || '' }
  };
}

// ---- 个人站场景：官网静态服务（E 盘官网目录 → 127.0.0.1:SITE_PORT，供 webview 预览与图片加载）----
// ---- Blender 场景：实时画面（抓帧 JPEG 也由这个静态服务直出，避免每帧走 IPC）----
const BLENDER_EXE = '<盘根>:\\software\\Blender\\blender.exe';
const BLENDER_DIR = '<盘根>:\\blender\\blender控制';                               // Blender 工作区（本地文件面板的根）
const BLENDER_AUTOSTART = path.join(__dirname, 'scripts', 'autostart_mcp.py'); // ASCII 路径：中文路径会被 Blender 当文件加载
const BLENDER_CAPTURE_PS = path.join(__dirname, 'scripts', 'blender-capture.ps1');
const BLENDER_LIVE_JPG = path.join(__dirname, 'data', 'blender-live.jpg');
const BLENDER_LIVE_META = path.join(__dirname, 'data', 'blender-live.json');
const BLENDER_CAPTURE_PID = path.join(__dirname, 'data', 'blender-capture.pid');
const BLENDER_MCP_PORT = 9876;

// ---- Blender 内置：把 Blender 主窗口 SetParent 进 GUI 窗口，直接在面板里操作 ----
// Win32 部分全在 scripts/blender-embed-agent.ps1；主进程只负责起代理、下命令、收结果。
const BLENDER_EMBED_AGENT = path.join(__dirname, 'scripts', 'blender-embed-agent.ps1');
const BLENDER_EMBED_CMD = path.join(__dirname, 'data', 'blender-embed.cmd.json');
const BLENDER_EMBED_RES = path.join(__dirname, 'data', 'blender-embed.res.json');

const SITE_MIME = {
  '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon', '.webp': 'image/webp'
};
function startSiteServer() {
  if (siteServer) return;
  const SITE_ROOT = path.normalize(SITE_DIR);
  const hasSite = fs.existsSync(SITE_DIR);
  if (!hasSite) log('[site] 官网目录不存在（个人站预览不可用）: ' + SITE_DIR);
  siteServer = http.createServer(function (req, res) {
    const u = decodeURIComponent((req.url || '/').split('?')[0]);
    // Blender 场景：实时画面（抓帧进程写盘 → 这里直出，渲染层 img 带时间戳轮询即可）
    if (u === '/__blender/live.jpg') {
      fs.readFile(BLENDER_LIVE_JPG, function (err, data) {
        if (err) { res.writeHead(404); res.end('no-frame'); return; }
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store, no-cache, must-revalidate' });
        res.end(data);
      });
      return;
    }
    // 保命入口：http://127.0.0.1:31238/chat → 用**当前** token 跳到引擎对话页。
    // 为什么需要：引擎每次启动都会随机生成新 token（见引擎源码 packages/client/connection/README.md），
    // 所以「带 token 的收藏网址」一重启就 401。这个固定入口只要工作台在跑就总能进对话。
    if (u === '/chat' || u === '/chat/') {
      const t = harnessToken;
      if (t) {
        res.writeHead(302, { Location: BASE + '/?token=' + t, 'Cache-Control': 'no-store' });
        res.end('redirecting to chat...');
      } else {
        // 引擎还没起来 / 还没抓到 token：给一个会自动重试的提示页，而不是 401 白屏
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('<!doctype html><meta charset="utf-8"><title>等待引擎…</title>' +
          '<body style="background:#0b0d12;color:#e6e8ee;font:14px/1.8 system-ui;padding:40px">' +
          '<h2>引擎还没就绪</h2><p>工作台正在启动 Harness 引擎（或还没拿到本次启动令牌）。</p>' +
          '<p>本页每 3 秒自动重试，也可以稍后手动刷新。</p>' +
          '<script>setTimeout(function(){location.reload()},3000)<\/script></body>');
      }
      return;
    }
    // 2026-10-22：DSH 社区站（第二个预览源）—— 前缀 /__community/ 直出本地目录，
    // 与官网同端口不同根；目录不存在时给明确 404，不影响官网预览。
    if (u === '/__community' || u.startsWith('/__community/')) {
      const cRoot = path.normalize(COMMUNITY_DIR);
      if (!fs.existsSync(cRoot)) { res.writeHead(404); res.end('no-community-dir'); return; }
      let rel = u.replace(/^\/__community\/?/, '');
      if (!rel) rel = 'index.html';
      let cp = path.normalize(path.join(cRoot, rel));
      if (!cp.startsWith(cRoot)) { res.writeHead(403); res.end('forbidden'); return; }
      if (fs.existsSync(cp) && fs.statSync(cp).isDirectory()) cp = path.join(cp, 'index.html');
      if (!fs.existsSync(cp)) { res.writeHead(404); res.end('not found'); return; }
      fs.readFile(cp, function (err, data) {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        const ext = path.extname(cp).toLowerCase();
        res.writeHead(200, { 'Content-Type': SITE_MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        res.end(data);
      });
      return;
    }
    if (!hasSite) { res.writeHead(404); res.end('no-site'); return; }
    let p = path.normalize(path.join(SITE_ROOT, u === '/' ? 'index.html' : u));
    if (!p.startsWith(SITE_ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
    if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(SITE_ROOT, 'index.html');
    fs.readFile(p, function (err, data) {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      const ext = path.extname(p).toLowerCase();
      res.writeHead(200, { 'Content-Type': SITE_MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  });
  // ★ 2026-09-26：同一台机上可能同时跑着两个壳（dev 工作台 + 安装版）⇒ 31238 只能被一个占住。
  //   占不到的那个**安静退让**（原来会抛未捕获的 EADDRINUSE 刷日志），保命入口/官网预览由占住的那个提供；
  //   它自己取主界面地址时走 http://127.0.0.1:31238/chat（见下方 harness:url）⇒ 照样能进官方主界面。
  siteServer.on('error', function (e) {
    log('[site] 端口 ' + SITE_PORT + ' 没占上（' + ((e && e.code) || e) + '）⇒ 本实例让给已在跑的那个壳；'
      + '保命入口/官网预览继续由它提供，主界面仍走 http://127.0.0.1:' + SITE_PORT + '/chat');
    siteServer = null;
  });
  siteServer.listen(SITE_PORT, '127.0.0.1', function () {
    log('[site] 静态服务已启动: http://127.0.0.1:' + SITE_PORT + '（个人站官网 + Blender 实时画面 + 保命入口 /chat）');
  });
}

// 个人站上下文：从官网 index.html 提取关键信息（账号/邮箱/标题），失败回退内置
function collectSiteContext() {
  const ctx = {
    title: '<机主> | <机主> · 个人站',
    accounts: [
      { name: '哔哩哔哩', handle: '@<机主>', url: 'https://<你的B站主页>' },
      { name: '抖音', handle: '@<你的抖音账号>', url: 'https://<你的抖音主页>' },
      { name: '小红书', handle: '@<机主>', url: 'https://<你的小红书主页>' }
    ],
    email: '<邮箱>',
    siteUrl: 'http://127.0.0.1:' + SITE_PORT + '/index.html'
  };
  try {
    const html = fs.readFileSync(path.join(SITE_DIR, 'index.html'), 'utf8');
    const t = String(html).match(/<title>([^<]+)<\/title>/);
    if (t && t[1]) ctx.title = t[1].trim();
    const mail = String(html).match(/mailto:([^"']+)/);
    if (mail && mail[1]) ctx.email = mail[1];
  } catch (e) { /* 用内置兜底 */ }
  return ctx;
}

function buildSiteSystem(c) {
  const acct = (c.accounts || []).map(function (a) {
    return '- ' + a.name + '（' + a.handle + '）: ' + a.url;
  }).join('\n');
  return [
    '你是「<机主>」个人站的 AI 助手（<机主>的个人站），只回答与这个个人站相关的问题，语气友好简洁。',
    '',
    '【个人站信息】',
    '标题：' + (c.title || '<机主> | <机主> · 个人站'),
    '官网本地预览：' + (c.siteUrl || ''),
    '自媒体账号：',
    acct || '（无）',
    '联系邮箱：' + (c.email || '<邮箱>'),
    '',
    '【官网板块】#tools <机主>小工具集合（已上架「上班盯盘助手」，其余空位待填）；#media 自媒体账号；#cooperate 联系咨询；#donate 投喂小鱼干；#about 关于<机主>。',
    '【风格】像素风 + 下雨背景，深蓝 #0a1628 主色，青色 #06e7e9 点缀；签名：梦想是优雅地淋一场雨。',
    '无关话题礼貌说明自己只了解<机主>个人站。'
  ].join('\n');
}

// 建窗口：opts = { isMain, scene, saved }
//   isMain=true  → 主窗口（场景标签页齐全，行为与以前完全一致）
//   isMain=false → 「场景分离窗口」：只渲染 opts.scene 这一个场景，隐藏场景标签栏（渲染层按 URL 的 solo=1 处理）
function createWindow(opts) {
  opts = opts || {};
  const isMain = !!opts.isMain;
  const scene = String(opts.scene || '');
  const defW = isMain ? 1380 : 1220;
  const defH = isMain ? 900 : 840;
  const fit = fitSavedBounds(opts.saved, defW, defH);
  const bounds = fit.bounds || { width: defW, height: defH };
  const winOpts = {
    width: bounds.width,
    height: bounds.height,
    minWidth: 1000,
    minHeight: 660,
    title: isMain ? 'DSH 引擎' : (sceneNameOf(scene) + ' · 淋雨家的工作台'),
    autoHideMenuBar: true,
    frame: false,
    backgroundColor: '#0b0d12',
    icon: path.join(__dirname, 'icon.ico'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true
    }
  };
  if (typeof bounds.x === 'number' && typeof bounds.y === 'number') { winOpts.x = bounds.x; winOpts.y = bounds.y; }
  const win = new BrowserWindow(winOpts);
  win.kunRole = isMain ? 'main' : 'scene';
  win.kunScene = isMain ? '' : scene;
  // 网页版 AI 桥的派发目标：记住"最后被聚焦的窗口"——分离窗口也是一整套壳（自带 preload+渲染器+桥），
  // 任务千万不能广播（旧版本桥会抢单，界面里看到的却一直是新代码，极难排查）。
  win.on('focus', function () { lastFocusedWin = win; });
  if (isMain) lastFocusedWin = win;
  win.setMenuBarVisibility(false);
  win.once('ready-to-show', function () {
    win.show();
    if (fit.maximized) { try { win.maximize(); } catch (e) { /* ignore */ } }
    if (isMain) log('[boot] 窗口可见耗时 ' + (Date.now() - APP_T0) + 'ms');
    else log('[win] 场景窗口已打开: ' + scene + (fit.clamped ? '（原屏幕已不在，已夹回主屏）' : ''));
  });
  win.webContents.setWindowOpenHandler(function (details) {
    if (/^https?:/i.test(details.url) || /^mailto:/i.test(details.url)) shell.openExternal(details.url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', function (e, url) {
    // 只允许：引擎地址(DSH_PORT) + GUI 自己目录下的 file:// 页面。
    // 其余一律拦截 —— 这样"把文件拖到窗口上"不会把界面导航到那个文件（观感像闪退）。
    // 注意：主进程主动 loadFile 不会触发 will-navigate，所以启动不受影响。
    const u = String(url);
    const ownDir = __dirname.replace(/\\/g, '/').toLowerCase();
    const isOwnFile = u.indexOf('file://') === 0 && decodeURIComponent(u).toLowerCase().indexOf(ownDir) >= 0;
    if (u.indexOf(BASE) !== 0 && !isOwnFile) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });
  win.on('close', function () {
    // 关之前先把几何记下来：主窗口关闭时还要连带关闭分离窗口，那一刻它们的位置已经取不到了
    noteWindowRect(win);
    if (isMain) { quitRequested = true; saveWinLayout(); }
  });
  win.on('closed', function () {
    if (isMain) {
      mainWindow = null;
      releaseBlenderEmbedSync();
      quitRequested = true;
      // 主窗口关闭 = 整个应用退出（用户选定的行为）：连带关掉分离窗口
      for (const w of detachWindows.slice()) { try { w.close(); } catch (e) { /* ignore */ } }
    } else {
      const i = detachWindows.indexOf(win);
      if (i >= 0) detachWindows.splice(i, 1);
      if (blenderEmbedOwner === win) releaseBlenderEmbedSync();
      // 用户主动关掉某个场景窗口 = 下次启动不再恢复它；整个应用退出时则保留布局
      if (!quitRequested && win.kunScene) delete layoutCache.detached[win.kunScene];
      saveWinLayout();
      notifyWindowsChanged();
    }
  });
  // 覆盖式内置的 Blender 是独立顶层窗口，不会自己跟着 GUI 走：窗口移动/缩放时重新贴合
  win.on('move', function () { scheduleEmbedFollow(win); scheduleAppwFollow(win); noteWindowRect(win); saveWinLayoutSoon(); });
  win.on('resize', function () { scheduleEmbedFollow(win); scheduleAppwFollow(win); noteWindowRect(win); saveWinLayoutSoon(); });
  if (isMain) {
    mainWindow = win;
  } else {
    detachWindows.push(win);
    noteWindowRect(win);
    saveWinLayout();
  }
  // 分离窗口：URL 带场景 id + solo 标记 → 渲染层只画这一个场景（并隐藏场景标签栏）
  win.loadFile(
    path.join(__dirname, 'renderer', 'index.html'),
    isMain ? undefined : { query: { scene: scene, solo: '1' } }
  );
  if (!isMain) notifyWindowsChanged();
  return win;
}

// 「在新窗口打开场景」：已在独立窗口里的场景 → 把那个窗口拉到前台，不重复开
function openSceneWindow(sceneId) {
  const id = String(sceneId || '').trim();
  if (!id) return { ok: false, err: 'empty-scene' };
  // 场景 json 可能已被删/改名 → 先校验，避免开出一个空壳窗口（渲染层取不到场景就只剩空白）
  try {
    const known = listScenarios().map(function (s) { return s.id; });
    if (known.indexOf(id) < 0) return { ok: false, err: 'unknown-scene', scene: id };
  } catch (e) { /* 校验本身失败就不拦，交给渲染层 */ }
  const exist = findSceneWindow(id);
  if (exist) {
    try {
      if (exist.isMinimized()) exist.restore();
      exist.show();
      exist.focus();
    } catch (e) { /* ignore */ }
    return { ok: true, focused: true, scene: id };
  }
  createWindow({ scene: id });
  log('[win] 新开场景窗口: ' + id + '（' + sceneNameOf(id) + '）');
  return { ok: true, focused: false, scene: id };
}


// ---- 外链统一交给系统默认浏览器（对话里的网址点一下就跳默认浏览器）----
// 原因：Harness 界面跑在 <webview> 里，那是独立 webContents，
// 主窗口上的 setWindowOpenHandler / will-navigate 管不到它 →
// 对话里的网址（GFM 自动链接，target=_blank）以往在应用内弹窗或毫无反应。
// 这里对 guest(webview) 内容统一接管：外部 http(s)/mailto 交给系统默认浏览器，
// 本地/内部地址（Harness 127.0.0.1:3080、个人站 :31238、file:// 等）保持原行为。
//
// ★例外：「内置网页版 AI」的窗口（渲染器用 partition="persist:webai-<key>" 建，见
//   renderer\renderers.js 的 WEB_AI）必须"像浏览器一样"，否则两头坏（2026-09-20 实测）：
//   ① 它们自己会跳：智谱加载 2.2 秒后自家 iframe 带着 refer__991 参数再跳一次、
//      千问点"登录"要跳 passport.qianwen.com（阿里账号域）。一拦就 e.preventDefault()
//      → 登录框根本出不来（用户报「智谱和千问无法登陆」）；
//   ② 一拦的同时还会 shell.openExternal() → 一开 GUI 预热时豆包/智谱的页面自己一跳，
//      用户的系统浏览器就被弹出来了（用户报「打开 dsh 之后就会自动打开豆包和智谱的网页」）。
//   所以：这些 guest 的导航一律放行；它们的 window.open（登录小窗、文档链接）在应用内开小窗，
//   并沿用原分区（小窗里的登录态要能回到主窗口）。识别方式：会话存储目录里带 Partitions\webai-<key>
//   （contents.session.getStoragePath() 是公开 API，探针已核实取到 "webai-chatglm" 这种名字）。
const INTERNAL_PROTOCOLS = /^(file|about|data|blob|devtools|dsh-app|chrome-extension|ws|wss):/i;
const INTERNAL_HOSTS = { '127.0.0.1': true, 'localhost': true, '::1': true };
const EXTERNAL_PROTOCOLS = /^(https?|mailto):/i;

function guestPartition(contents) {
  try {
    const m = /[\\/]Partitions[\\/](.+)$/.exec(contents.session.getStoragePath() || '');
    return m ? m[1] : '';
  } catch (e) { return ''; }
}

function isInternalUrl(u) {
  if (!u) return true;
  if (INTERNAL_PROTOCOLS.test(u)) return true;
  try {
    return INTERNAL_HOSTS[new URL(u).hostname] === true;
  } catch (e) {
    return true;
  }
}

function openInSystemBrowser(u) {
  try {
    if (EXTERNAL_PROTOCOLS.test(u)) { shell.openExternal(u); return true; }
  } catch (e) { /* ignore */ }
  return false;
}

app.on('web-contents-created', function (event, contents) {
  let type = '';
  try { type = contents.getType(); } catch (e) { return; }
  if (type !== 'webview') return;   // 主窗口已有自己的处理，不重复接管
  const part = guestPartition(contents);
  const webai = /^webai-/.test(part);   // 内置网页版 AI 的窗口
  // 2026-10-19 host: B站 scene opens Edge immediately. Embedded web panels (persist:embed-*)
  //   used to send EVERY external link / popup to openInSystemBrowser() -> system browser.
  //   For these partitions we now BLOCK instead (the panel has its own "open in browser" button).
  const isEmbed = /^embed-/.test(part);
  try {
    contents.setWindowOpenHandler(function (details) {
      if (isInternalUrl(details.url)) return { action: 'allow' };
      // 2026-10-19（bv-ai 反馈 · 宿主：「首页点视频/搜索没反应」）：embed 里 target=_blank / window.open 的链接
      //   以前直接 deny ⇒ 点了没反应。改成**就地打开**（照 scripts/sidebar.js L72-75 的写法）：
      //   不开新窗口、不弹系统浏览器，就在这个面板里继续走。
      if (isEmbed) {
        try { if (/^(https?:\/\/|file:\/\/)/.test(details.url || '')) contents.loadURL(details.url); } catch (e) { /* ignore */ }
        return { action: 'deny' };
      }
      if (webai) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 560, height: 720, autoHideMenuBar: true,
            webPreferences: { partition: 'persist:' + part },   // 登录小窗与主窗口共用登录态
          },
        };
      }
      openInSystemBrowser(details.url);
      return { action: 'deny' };
    });
  } catch (e) { /* ignore */ }
  if (webai) return;   // 内置网页版 AI：导航完全照浏览器来，不接管
  contents.on('will-navigate', function (e, url) {
    if (isInternalUrl(url)) return;
    if (isEmbed) return;                            // 2026-10-19 embed: 就地导航（不弹系统浏览器、也别拦页面自己的跳转）
    if (openInSystemBrowser(url)) e.preventDefault();
  });
  try {
    contents.on('will-frame-navigate', function (e) {
      const url = e && e.url;
      if (!url || isInternalUrl(url)) return;
      if (isEmbed) return;                            // 2026-10-19 embed: iframe 导航也放行（B站的内部 iframe 全靠它）
      if (openInSystemBrowser(url)) e.preventDefault();
    });
  } catch (e) { /* 旧版 Electron 无此事件，忽略 */ }
});

// ---- IPC：渲染层请求 token / 场景配置 ----
ipcMain.handle('harness:url', () => {
  // ★ 2026-09-26：引擎是**外部进程**时，手上的 token 可能是旧的（引擎一重启就失效 ⇒ 主界面白屏
  //   `dsh web authentication required`）。改用保命入口：由真正拉起引擎的那个工作台提供，
  //   每次请求都拿**当前** token 跳转 ⇒ 安装版/第二个壳也能稳定进主界面。
  if (engineIsForeign) return 'http://127.0.0.1:' + SITE_PORT + '/chat';
  const token = harnessToken;
  return token ? (BASE + '/?token=' + token) : (BASE + '/');
});
ipcMain.handle('harness:ready', () => engineIsForeign || !!harnessToken);

// ---- IPC：版本信息（左上角品牌区悬停显示）----
// 放主进程读的原因：版本号来自各处 package.json，渲染层没有文件系统权限；
// 运行时版本（Electron / Chromium / Node）也只有主进程能一次拿全。
ipcMain.handle('app:version', () => {
  const readVer = (p) => {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')).version || null; } catch (e) { return null; }
  };
  return {
    gui: readVer(path.join(__dirname, 'package.json')),
    engine: readVer(path.join(HARNESS_DIR, 'package.json')),
    cli: readVer(path.join(HARNESS_DIR, 'apps', 'cli', 'package.json')),
    engineDir: HARNESS_DIR,
    electron: process.versions.electron || '',
    chrome: process.versions.chrome || '',
    node: process.versions.node || '',
    app: (() => { try { return app.getVersion(); } catch (e) { return ''; } })(),
  };
});

// ---- 内嵌 Harness 面板精简模式：主进程向 webview 注入（只保留聊天流 + 输入框）----
// 隐藏：左侧菜单栏 / 右侧详情列（框架内联 grid-template-columns「Npx minmax(0,1fr) Npx」，
// 用 !important 强制 0/1fr/0，手柄 data-side 隐藏）；对话区顶部会话标题栏（data-phase > header）；
// 对话轨迹 turn rail（[data-chat-flow] 前一兄弟）；宽度拖条（data-width-handle）。
// ★会话列「铺满」★（2026-09-20 第三波，与 renderer\renderers.js 同名常量保持一致）
// 真因（探针 `_排查脚本存档\probe-chat-width` 实测，renderers.js 里有完整说明）：会话列 [data-chat-flow] 的
// `max-width: var(--dsh-chat-content-width)` 是**就地算**的 clamp(680px, 声明元素自身宽度×64%, 920px)，
// 而 [data-phase] 在本版引擎里是"连接状态小圆点"，不是会话相位容器 ⇒ 老写法（往 [data-phase] 写变量）
// 整条空转，列被钉在 887px。现在改成：① 直接盖 max-width；② 沿祖先链逐层压变量（就近生效，压过 .body）；
// ③ CSS 兜底。两边都写 `calc(100% - 16px)` 时，由于父层内边距不同（32px / 16px），自动得到
// "输入卡比会话列宽 32px"＝引擎原设计比例。改这个数之前先跑一次探针拿 before/after。
const HARNESS_WIDE_COL = 'calc(100% - 16px)';
const HARNESS_WIDE_CARD = 'calc(100% - 16px)';
const HARNESS_WIDE_CSS = [
  '[data-chat-flow] { max-width: ' + HARNESS_WIDE_COL + ' !important; }',
  '[data-composer-card] { max-width: ' + HARNESS_WIDE_CARD + ' !important; }',
  '[class*="embeddedBody"], [class*="column"] { --dsh-chat-content-width: ' + HARNESS_WIDE_COL +
  ' !important; --dsh-composer-card-max-width: ' + HARNESS_WIDE_CARD + ' !important; }'
].join('\n');
// 自维持：宿主只投几次，页面重渲染后自己纠回来（window 级守卫，防止攒出一堆定时器）。
const HARNESS_WIDE_PIN_JS = `(() => {
  var COL = ${JSON.stringify(HARNESS_WIDE_COL)}, CARD = ${JSON.stringify(HARNESS_WIDE_CARD)};
  var pinOnce = function () {
    var pin = function (el) {
      while (el && el.nodeType === 1) {
        try {
          el.style.setProperty('--dsh-chat-content-width', COL, 'important');
          el.style.setProperty('--dsh-composer-card-max-width', CARD, 'important');
        } catch (e) {}
        el = el.parentElement;
      }
    };
    var cols = document.querySelectorAll('[data-chat-flow]');
    for (var i = 0; i < cols.length; i++) { try { cols[i].style.setProperty('max-width', COL, 'important'); } catch (e) {} pin(cols[i]); }
    var cards = document.querySelectorAll('[data-composer-card]');
    for (var j = 0; j < cards.length; j++) { try { cards[j].style.setProperty('max-width', CARD, 'important'); } catch (e) {} pin(cards[j]); }
    var c0 = cols[0], w = 0, pw = 0;
    if (c0) {
      try {
        w = c0.getBoundingClientRect().width;
        // ⚠ 分母用父层**内容盒**（clientWidth 去左右内边距），不能用 border box —— max-width 的 % 就是这么算的
        var p = c0.parentElement || c0, cs = null;
        try { cs = getComputedStyle(p); } catch (e2) {}
        pw = p.clientWidth - ((cs && parseFloat(cs.paddingLeft)) || 0) - ((cs && parseFloat(cs.paddingRight)) || 0);
      } catch (e) {}
    }
    return { cols: cols.length, cards: cards.length, w: Math.round(w), pw: Math.round(pw) };
  };
  var r = pinOnce();
  try { if (!window.__kunWideTimer) window.__kunWideTimer = setInterval(pinOnce, 2000); } catch (e) {}
  return r.cols + '列 ' + r.w + '/' + r.pw + 'px';
})()`;
const HARNESS_CHAT_CSS = [
  '[style*="grid-template-columns"][style*="minmax(0"] { grid-template-columns: minmax(0, 1fr) !important; }',
  '[style*="grid-template-columns"][style*="minmax(0"] [data-side="sidebar"], [style*="grid-template-columns"][style*="minmax(0"] [data-side="details"] { display: none !important; }',
  '[style*="grid-template-columns"][style*="minmax(0"] [data-phase] > header { display: none !important; }',
  '[style*="grid-template-columns"][style*="minmax(0"] [data-width-handle] { display: none !important; }',
  // 文字铺满：老写法 `[data-phase] { --dsh-chat-content-width: 100% !important }` 在引擎 0.1.6 上整条空转，
  // 换成上面那组「盖 max-width + 沿祖先链压变量」（与渲染层 renderers.js 用同一份内容）。
  HARNESS_WIDE_CSS
].join('\n');
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
  const fix = () => {
    const f = pick();
    if (!f) return false;
    // 会话列铺满（见上方 HARNESS_WIDE_CSS / HARNESS_WIDE_PIN_JS 的实测说明）：每次 fix 重算一次，
    // React 重渲染把 max-width 顶回去也能在一秒内纠回来。
    try { window.__wideTxt = ${HARNESS_WIDE_PIN_JS}; } catch (e) { /* ignore */ }
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
      // ⚠ 老代码这里往 [data-phase] 上写 --dsh-chat-content-width；本版 [data-phase] 是连接状态小圆点，
      //   写在上面的变量到不了会话列（实测列仍被钉在 887px）。宽度改由上面的 HARNESS_WIDE_PIN_JS 负责，
      //   **不再依赖 [data-phase] 这个会随版本漂移的锚点**。
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
  // 幂等守卫：主进程也会 dom-ready/did-finish-load 各投一次，不守卫就会攒出多个 MutationObserver + 定时器。
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
  let rect = null;
  if (f2) { const r = f2.getBoundingClientRect(); rect = { x: r.x, y: r.y, w: r.width, h: r.height }; }
  const kidsInfo = [];
  if (f2) {
    const kk = f2.children;
    for (let i = 0; i < kk.length && i < 8; i++) {
      const c = kk[i];
      let pos = 'static', cr = { x: -1, w: -1 };
      try { pos = getComputedStyle(c).position; cr = { x: Math.round(c.getBoundingClientRect().x), w: Math.round(c.getBoundingClientRect().width) }; } catch (e) { /* ignore */ }
      kidsInfo.push({ i: i, cls: (c.className && c.className.toString().slice(0, 30) || c.tagName), pos: pos, x: cr.x, w: cr.w, vis: c.offsetParent !== null });
    }
  }
  window.__fixDiag = JSON.stringify({
    found: !!f2,
    grid: f2 ? f2.style.gridTemplateColumns : '',
    grids: all.length,
    vals: vals,
    iframes: document.querySelectorAll('iframe').length,
    hasPhase: document.querySelectorAll('[data-phase]').length,
    hasChatFlow: document.querySelectorAll('[data-chat-flow]').length,
    wide: window.__wideTxt || '',   // 铺满实测：「1列 1576/1592px」= 铺满几列 · 列宽/可用宽（只差十几像素＝已铺满）
    rootKids: rootEl ? rootEl.children.length : -1,
    frameTag: f2 ? f2.tagName : '',
    frameCls: f2 ? (f2.className && f2.className.toString().slice(0, 60) || '') : '',
    frameRect: rect,
    kidsInfo: kidsInfo,
    sidebarEls: f2 ? f2.querySelectorAll('[data-side="sidebar"]').length : 0,
    winW: window.innerWidth,
    winH: window.innerHeight,
    title: document.title,
    url: location.href,
    pinDiag: (() => {
      const T = 'oa系统运维';
      const hits = [];
      const all = document.querySelectorAll('*');
      for (let i = 0; i < all.length; i++) {
        const e = all[i];
        const t = (e.textContent || '');
        if (t.indexOf(T) < 0) continue;
        hits.push({ tag: e.tagName, cls: String(e.className || '').slice(0, 40), len: t.replace(/\\s+/g, ' ').trim().length, vis: e.offsetParent !== null });
        if (hits.length >= 8) break;
      }
      hits.sort(function (a, b) { return a.len - b.len; });
      return { total: hits.length, top3: hits.slice(0, 3), selected: !!document.querySelector('[aria-selected="true"]') };
    })()
  });
})();
// ---- 钉住会话：已移交渲染层（renderer/renderers.js 的 HARNESS_PIN_JS）单独负责 ----
// 原因（2026-09 根治）：这里原来还有一份"扫全文档模糊匹配 → 点击"的旧实现，每 4s 点一次，
// 与渲染层新逻辑并存 → 两个循环抢着点，渲染层刚钉对的会话会被这里点到聊天记录里
// 含同名字样的任意元素上，表现为「切场景后 AI 面板会话错乱 / 切不到对应会话」。
// 现在分工：main 只负责插入布局精简 CSS、执行布局修复 JS、截图与日志；
// 选会话/绑定会话 id 全部由渲染层完成（只在会话列表区域内匹配 + 绑定 id + 按 id 精确点）。
`;
ipcMain.handle('harness:wv:inject', (e, webContentsId, pinTarget) => {
  const wc = webContents.fromId(Number(webContentsId));
  if (!wc || wc.isDestroyed()) {
    log('[wv:inject] webContents 不存在: ' + webContentsId);
    return { ok: false, err: 'no-webcontents' };
  }
  // 每次注入顺手截一张面板实况图（覆盖保存），便于排查"注入成功但界面没变"
  try {
    wc.capturePage().then(function (img) {
      if (img && !img.isEmpty()) {
        try {
          const dir = path.join(__dirname, 'captures');
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, 'panel-latest.png'), img.toPNG());
          log('[wv:inject] 截图已保存 panel-latest.png');
        } catch (ex) { /* ignore */ }
      }
    }, function () { /* ignore */ });
  } catch (ex) { /* ignore */ }
  try {
    const p = wc.insertCSS(HARNESS_CHAT_CSS);
    if (p && typeof p.catch === 'function') p.catch(function (err) { log('[wv:inject] insertCSS 拒绝: ' + (err && err.message || err)); });
  } catch (ex) { log('[wv:inject] insertCSS 失败: ' + (ex && ex.message || ex)); }
  try {
    // 钉住目标由调用方决定（OA 'oa系统运维' / 个人站 '个人站' / 分析助手 ['<机主>看盘助手','<机主>']）
    // 支持字符串或字符串数组（多候选）；以 JSON 数组字面量注入，避免引号转义问题
    const targets = (Array.isArray(pinTarget) ? pinTarget : [pinTarget])
      .map(function (t) { return String(t == null ? '' : t).trim(); })
      .filter(Boolean);
    const fixJs = HARNESS_FIX_JS.split('__DSH_PIN_TARGET__').join(JSON.stringify(targets.length ? targets : ['oa系统运维']));
    wc.executeJavaScript(fixJs).then(
      function (r) {
        log('[wv:inject] js 结果: ' + String(r));
        // 诊断信息挂在 window.__fixDiag（executeJavaScript 只返回最后表达式值，诊断用全局变量取回）
        try {
          wc.executeJavaScript('window.__fixDiag || null').then(
            function (d) { if (d) log('[wv:inject] diag: ' + String(d).slice(0, 900)); },
            function () { /* ignore */ }
          );
        } catch (ex) { /* ignore */ }
      },
      function (err) { log('[wv:inject] js 失败: ' + (err && err.message || err)); }
    );
  } catch (ex) { log('[wv:inject] exec 异常: ' + (ex && ex.message || ex)); }
  return { ok: true };
});
ipcMain.handle('scenarios:list', () => listScenarios());
ipcMain.handle('scenario:get', (e, id) => getScenario(id));
// 场景标签顺序（拖拽换位）：渲染层拖完报上来，下次开机 / 其它窗口都读它
ipcMain.handle('scenes:order:get', () => ({ saved: fs.existsSync(SCENE_ORDER_FILE), ids: readSceneTabOrder() }));
ipcMain.handle('scenes:order:set', (e, ids) => saveSceneTabOrder(ids));

// ---- 宿主通用能力（不属于任何场景）：打开/定位任意路径 ----
// 之前各场景为了"打开文件夹"互相借用通道（例如 OA 文件面板去调 app.site/app.blender），
// 造成场景间耦合。这里提供一个平台级通道，任何场景都可以用，互不依赖。
// 安全：只允许打开「存在且非可执行」的路径，或 http(s)/mailto 链接。
ipcMain.handle('app:open-path', (e, target) => {
  const t = String(target || '');
  if (!t) return { ok: false, err: 'empty' };
  try {
    if (/^(https?:|mailto:)/i.test(t)) { shell.openExternal(t); return { ok: true }; }
    if (!fs.existsSync(t)) return { ok: false, err: '路径不存在：' + t };
    shell.openPath(t);
    return { ok: true };
  } catch (ex) { return { ok: false, err: String((ex && ex.message) || ex) }; }
});
ipcMain.handle('app:reveal-path', (e, target) => {
  const t = String(target || '');
  if (!t) return { ok: false, err: 'empty' };
  try {
    if (!fs.existsSync(t)) return { ok: false, err: '路径不存在：' + t };
    shell.showItemInFolder(t);
    return { ok: true };
  } catch (ex) { return { ok: false, err: String((ex && ex.message) || ex) }; }
});

// ---- 宿主通用能力：读写文本文件（2026-09-20 加，给「预览面板 / 流程画布节点」用）----
// 为什么必须放主进程：渲染层在 file:// 下拿不到任意路径的文件内容（fetch 被禁、<webview> 只能看不能存），
// 而"画布上一个节点 = 一个真实文件（文案.md / 字幕.srt …）"这套玩法必须能读、能改、能存。
// 规矩：① 读任意存在的文件，但限大小（4 MB 以内，再大不给编辑器看）；
//       ② **写只允许 <盘根>:\ 或 <盘根>:\**（本机铁律：产物/素材不进 C 盘）；
//       ③ 先写 <文件>.kun-tmp 再改名覆盖 —— 避免写一半失败留下半个文件（原文件永远还在）。
// 面板侧封装：preload 暴露成 app.file.{read,write,stat}；没有这个接口 = 主进程还没重启过。
const FILE_TEXT_MAX = 4 * 1024 * 1024;
ipcMain.handle('kun:file:stat', async (e, p) => {
  const t = String(p || '');
  if (!t) return { ok: false, err: 'empty' };
  try {
    const st = await fs.promises.stat(t);
    return { ok: true, exists: true, isDir: st.isDirectory(), size: st.size, mtime: Math.floor(st.mtimeMs / 1000) };
  } catch (ex) {
    return { ok: true, exists: false, isDir: false, size: 0, mtime: 0 };
  }
});
ipcMain.handle('kun:file:read', async (e, p) => {
  const t = String(p || '');
  if (!t) return { ok: false, err: 'empty' };
  try {
    const st = await fs.promises.stat(t);
    if (st.isDirectory()) return { ok: false, err: '这是文件夹，不是文件' };
    if (st.size > FILE_TEXT_MAX) return { ok: false, err: '文件太大（' + (st.size / 1048576).toFixed(1) + ' MB），编辑器只开到 4 MB' };
    const text = await fs.promises.readFile(t, 'utf8');
    return { ok: true, path: t, text: text, size: st.size, mtime: Math.floor(st.mtimeMs / 1000) };
  } catch (ex) { return { ok: false, err: '读不到：' + String((ex && ex.message) || ex) }; }
});
ipcMain.handle('kun:file:write', async (e, p, text) => {
  const t = String(p || '');
  if (!t) return { ok: false, err: 'empty' };
  if (!/^[DE]:[\\/]/i.test(t)) return { ok: false, err: '只允许写到 D: 或 E: 盘：' + t };
  try {
    await fs.promises.mkdir(path.dirname(t), { recursive: true });
    const tmp = t + '.kun-tmp';
    await fs.promises.writeFile(tmp, String(text == null ? '' : text), 'utf8');
    await fs.promises.rename(tmp, t);
    const st = await fs.promises.stat(t);
    return { ok: true, path: t, size: st.size, mtime: Math.floor(st.mtimeMs / 1000) };
  } catch (ex) { return { ok: false, err: '写不了：' + String((ex && ex.message) || ex) }; }
});
// ---- 宿主通用能力：选文件夹（2026-09-23 加，画布节点的「生成路径（文件夹）」用）----
// 走系统对话框（openDirectory + createDirectory，可现场新建文件夹）：返回选中的文件夹绝对路径，取消返回 null。
// 按发起方窗口寻址（分离窗口也能用），拿不到就退回主窗口。
ipcMain.handle('kun:pick-folder', async (e) => {
  const win = windowOfEvent(e) || mainWindow;
  if (!win) return null;
  try {
    const r = await dialog.showOpenDialog(win, {
      title: '选择生成路径（文件夹）',
      buttonLabel: '选这个文件夹',
      properties: ['openDirectory', 'createDirectory']
    });
    if (r.canceled || !r.filePaths || !r.filePaths.length) return null;
    return r.filePaths[0];
  } catch (ex) { return null; }
});
// ---- 宿主通用能力：选具体文件（2026-09-23 第十一轮加，参考素材节点的「路径」用）----
// 与 pick-folder 对称：openFile，返回选中的文件绝对路径，取消返回 null。
ipcMain.handle('kun:pick-file', async (e) => {
  const win = windowOfEvent(e) || mainWindow;
  if (!win) return null;
  try {
    const r = await dialog.showOpenDialog(win, {
      title: '选择素材文件',
      buttonLabel: '选这个文件',
      properties: ['openFile']
    });
    if (r.canceled || !r.filePaths || !r.filePaths.length) return null;
    return r.filePaths[0];
  } catch (ex) { return null; }
});
// ---- 独立窗口置顶（2026-09-23 第十一轮）：分离窗口顶部菜单栏的「📌 置顶」按钮用 ----
// win.setAlwaysOnTop(true/false)：窗口浮在最上层，缩小独立窗口后点主窗口/其它页面也不被遮挡。
ipcMain.handle('kun:set-always-on-top', (e, flag) => {
  const win = windowOfEvent(e);
  if (!win || win.isDestroyed()) return { ok: false };
  try {
    win.setAlwaysOnTop(!!flag);
    return { ok: true, on: !!flag };
  } catch (ex) { return { ok: false, err: String((ex && ex.message) || ex) }; }
});

// ---- 宿主通用能力：看本机某个端口在不在（2026-09-20 加，流程画布的「工具节点」状态点用）----
// 为什么用 TCP connect 而不是像 site:probe 那样发 HTTP：
//   ① 节点只需要"在不在跑"这一个事实，不需要页面内容；
//   ② ComfyUI 控制台(8189)/工作台(8188) 都是本机 HTTP 服务，端口连得上 = 已经起来了；
//   ③ HTTP 要等响应头，TCP 握手一成功就能返回，红点（没运作）也不会拖到几秒。
// 两个坑写在这儿免得以后又踩：
//   ① 本机开着 360 主动防御时，"连一个没人听的端口"要 ~2 秒才回（不是我们的锅，是它拦了一下），
//      所以默认超时压到 1200 ms，并且**永远 resolve、从不 reject** —— 面板要的是"当前状态"而非异常；
//   ② 只探测、不读也不写，参数校验到"是个端口号"为止（面板传的是场景里写死的本机端口）。
// ================= 本地电脑场景（原名电脑清理，2026-10-06 立）：本机磁盘分区容量 =================
// 用 Node 的 fs.statfsSync 只读算每个分区的总量/剩余（C/D/E/F；不存在的盘给 ok:false 而不是抛错）。
// 只读、只返回数字、不执行任何命令 —— 面板 renderers['pc-drives'] 每 10 秒调一次。
// ⚠ 这段在**主进程**里 ⇒ 改完要重启一次 GUI 才生效（面板本身是热更新的）。
ipcMain.handle('kun:sys:disks', () => {
  const drives = ['C', 'D', 'E', 'F'].map((letter) => {
    const root = letter + ':\\';
    const row = { drive: letter + ':', ok: false, total: 0, free: 0, used: 0, percent: 0, err: '' };
    try {
      const st = fs.statfsSync(root);
      const bsize = Number(st.bsize) || 0;
      const total = Number(st.blocks) * bsize;
      const free = Number(st.bavail) * bsize;
      if (!total) throw new Error('no-blocks');
      row.ok = true;
      row.total = total; row.free = free; row.used = Math.max(0, total - free);
      row.percent = Math.round(row.used / total * 1000) / 10;
    } catch (e) { row.err = (e && (e.code || e.message)) || 'unavailable'; }
    return row;
  });
  return { ok: true, at: Date.now(), drives };
});
ipcMain.handle('kun:net:probe', (e, host, port, timeoutMs) => {
  const h = String(host || '127.0.0.1');
  const p = Number(port) || 0;
  const wait = Math.max(120, Math.min(5000, Number(timeoutMs) || 1200));
  if (!p || p < 1 || p > 65535) return { ok: false, err: '端口不对：' + String(port) };
  return new Promise((resolve) => {
    const t0 = Date.now();
    let sock = null, done = false;
    const fin = (open) => {
      if (done) return;
      done = true;
      try { if (sock) sock.destroy(); } catch (x) { /* ignore */ }
      resolve({ ok: true, host: h, port: p, open: !!open, ms: Date.now() - t0 });
    };
    const timer = setTimeout(() => fin(false), wait);
    try {
      sock = require('net').connect({ host: h, port: p });
      sock.setTimeout(wait);
      sock.on('connect', () => { clearTimeout(timer); fin(true); });
      sock.on('timeout', () => { clearTimeout(timer); fin(false); });
      sock.on('error', () => { clearTimeout(timer); fin(false); });
    } catch (ex) { clearTimeout(timer); fin(false); }
  });
});

// ---- 个人站场景 IPC：官网预览地址 / 官网结构化信息 ----
ipcMain.handle('site:preview', () => ({
  ok: fs.existsSync(SITE_DIR),
  url: 'http://127.0.0.1:' + SITE_PORT + '/index.html',
  base: 'http://127.0.0.1:' + SITE_PORT,
  // 2026-10-22：第二个预览源（DSH 社区站），同一静态服务的 /__community/ 前缀
  communityUrl: 'http://127.0.0.1:' + SITE_PORT + '/__community/index.html',
  communityOk: fs.existsSync(COMMUNITY_DIR)
}));
ipcMain.handle('site:info', () => collectSiteContext());
ipcMain.handle('site:open', (e, url) => {
  const u = String(url || '');
  if (/^(https?:|mailto:)/i.test(u)) { try { shell.openExternal(u); } catch (ex) { /* ignore */ } }
  return true;
});
// 个人站场景：在资源管理器打开本地文件夹（项目管理用）
ipcMain.handle('site:open-folder', (e, dir) => {
  const d = String(dir || '');
  if (!d) return { ok: false, err: 'empty' };
  try {
    shell.openPath(d);
    return { ok: true };
  } catch (ex) { return { ok: false, err: String((ex && ex.message) || ex) }; }
});
// 个人站场景：网站可用性探测（我的网址状态；主进程发请求，绕开渲染器跨域限制）
ipcMain.handle('site:probe', (e, url) => {
  const u = String(url || '');
  if (!/^https?:\/\//i.test(u)) return { ok: false, err: 'bad-url' };
  return new Promise((resolve) => {
    let mod = null, req = null;
    try {
      mod = u.toLowerCase().indexOf('https:') === 0 ? require('https') : require('http');
      const done = (ok, status) => { clearTimeout(timer); resolve({ ok: ok, status: status || 0 }); };
      const timer = setTimeout(() => { try { req && req.destroy(); } catch (x) { /* ignore */ } done(false, 0); }, 6000);
      req = mod.get(u, { headers: { 'User-Agent': 'kun-probe/1.0' } }, (res) => {
        // 2xx / 3xx 视为在线
        const code = res.statusCode || 0;
        res.resume();
        done(code >= 200 && code < 400, code);
      });
      req.on('error', () => done(false, 0));
    } catch (ex) { done(false, 0); }
  });
});
// ---- 程序开发场景：把项目里的 H5 用「手机尺寸独立窗口」打开（400×830，独立持久会话 → 登录能记住）----
// 场景 json 的 code-urls 面板里给条目加 "phone": true 就会出现 📱 按钮；换项目只改 json。
ipcMain.handle('code:phone-window', (e, url, title) => {
  const u = String(url || '');
  if (!/^https?:\/\//i.test(u)) return { ok: false, err: 'bad-url' };
  try {
    const win = new BrowserWindow({
      width: 400,
      height: 830,
      title: String(title || '手机预览'),
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition: 'persist:code-phone-preview'
      }
    });
    win.setMenuBarVisibility(false);
    win.loadURL(u);
    return { ok: true };
  } catch (ex) {
    return { ok: false, err: String((ex && ex.message) || ex) };
  }
});

// ---- 个人站场景：官网本地文件夹浏览（安全限制在 SITE_DIR 内，可进入子目录）----
ipcMain.handle('site:files:local', (e, relPath) => {
  const root = path.resolve(SITE_BROWSE_DIR);
  const rel = String(relPath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const full = rel ? path.resolve(root, rel) : root;
  if (full !== root && !full.startsWith(root + path.sep)) {
    return { ok: false, err: '越界路径：仅可浏览 ' + SITE_BROWSE_DIR };
  }
  let ents = [];
  try { ents = fs.readdirSync(full, { withFileTypes: true }); }
  catch (ex) { return { ok: false, err: '无法读取目录：' + full }; }
  const rows = ents.map(en => {
    let isDir = en.isDirectory(), size = 0, mtime = 0;
    try {
      const st = fs.statSync(path.join(full, en.name));
      isDir = st.isDirectory(); size = isDir ? 0 : st.size; mtime = Math.floor(st.mtimeMs / 1000);
    } catch (ex2) { /* ignore */ }
    return { name: en.name, isDir: isDir, size: size, mtime: mtime };
  }).sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name, 'zh'));
  return { ok: true, root: root, rel: rel, base: 'http://127.0.0.1:' + SITE_PORT, rows: rows };
});

// 打开文件（2026-10-22）：浏览根已改成 <工作台>
// 其它项目文件直接交给系统默认程序（shell.openPath），不会 404。
ipcMain.handle('site:open-file', async (e, relPath) => {
  try {
    const root = path.resolve(SITE_BROWSE_DIR);
    const rel = String(relPath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const full = rel ? path.resolve(root, rel) : root;
    if (full !== root && !full.startsWith(root + path.sep)) return { ok: false, err: '越界' };
    if (!fs.existsSync(full)) return { ok: false, err: '文件不存在' };
    if (fs.statSync(full).isDirectory()) return { ok: false, err: '这是目录' };
    const siteRoot = path.resolve(SITE_DIR);
    if (full.startsWith(siteRoot + path.sep)) {
      const r2 = path.relative(siteRoot, full).split(path.sep).join('/');
      const url = 'http://127.0.0.1:' + SITE_PORT + '/' + r2.split('/').map(encodeURIComponent).join('/');
      try { shell.openExternal(url); return { ok: true, url: url }; } catch (ex) { /* 落到下面 openPath */ }
    }
    const r = await shell.openPath(full);
    return r ? { ok: false, err: r } : { ok: true };
  } catch (ex) {
    return { ok: false, err: String((ex && ex.message) || ex) };
  }
});

// ================= 自我复盘场景（独立命名空间 app.review，根＝<工作台>\自我复盘，只读） =================
// 需求：右上角浏览「自我复盘」镜像目录（主要都是 md），左上角大窗口"单击即预览"该文档。
// 为什么必须走主进程：渲染进程是 file:// 页面，fetch/XHR 读不了本地文件（图/视频能当子资源加载，
// 文本不能），所以目录列表与正文都由这里读盘；路径一律相对 REVIEW_DIR 解析并夹在本目录内。
// 只读：镜像是「<机主>-个人信息 / 我的知识库」的副本（技能 maben-profile 的默认只读约束），不提供任何写接口。
const REVIEW_DIR = '<工作台>\\自我复盘';
const REVIEW_TEXT_EXT = /\.(md|markdown|txt|json|ya?ml|csv|log|ini|conf)$/i;
const REVIEW_MAX_BYTES = 4 * 1024 * 1024;   // 单篇上限 4 MB：超了只回前 4 MB，够看且不会把面板卡死

function resolveReviewPath(rel) {
  const root = path.resolve(REVIEW_DIR);
  const r = String(rel == null ? '' : rel).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const full = r ? path.resolve(root, r) : root;
  if (full !== root && !full.startsWith(root + path.sep)) return null;   // 越界 → null（不接受 .. 逃出）
  return { root: root, rel: r, full: full };
}

// 根目录是否存在（给面板显示"目录不见了"用）
ipcMain.handle('review:root', () => {
  const root = path.resolve(REVIEW_DIR);
  let exists = false;
  try { exists = fs.statSync(root).isDirectory(); } catch (ex) { exists = false; }
  return { ok: exists, root: root, label: REVIEW_DIR, exists: exists };
});

// 列目录：目录在前、中文按拼音排；text 标记可预览的文本类（md/txt/json…）
ipcMain.handle('review:files', (e, rel) => {
  const t = resolveReviewPath(rel);
  if (!t) return { ok: false, err: '越界路径：仅可浏览「自我复盘」目录' };
  let ents = [];
  try { ents = fs.readdirSync(t.full, { withFileTypes: true }); }
  catch (ex) { return { ok: false, err: '无法读取目录：' + t.full }; }
  const rows = ents
    .filter(en => !en.name.startsWith('.') && !en.name.startsWith('~$'))
    .map(en => {
      let isDir = en.isDirectory(), size = 0, mtime = 0;
      try {
        const st = fs.statSync(path.join(t.full, en.name));
        isDir = st.isDirectory(); size = isDir ? 0 : st.size; mtime = Math.floor(st.mtimeMs / 1000);
      } catch (ex2) { /* ignore */ }
      return { name: en.name, isDir: isDir, size: size, mtime: mtime, text: isDir || REVIEW_TEXT_EXT.test(en.name) };
    })
    .sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name, 'zh'));
  return { ok: true, root: t.root, rel: t.rel, label: REVIEW_DIR, rows: rows };
});

// 读正文（utf8）：返回相对路径 / 绝对路径 / 大小 / 修改时间 / 内容 / 是否截断
ipcMain.handle('review:read', (e, rel) => {
  const t = resolveReviewPath(rel);
  if (!t) return { ok: false, err: '越界路径：仅可读取「自我复盘」目录' };
  if (t.full === t.root) return { ok: false, err: '这是根目录，不是文档' };
  try {
    const st = fs.statSync(t.full);
    if (st.isDirectory()) return { ok: false, err: '这是目录，不是文档' };
    if (st.size > 512 * 1024 * 1024) return { ok: false, err: '文件过大（>512MB），不预览' };
    const buf = fs.readFileSync(t.full);
    const cut = buf.length > REVIEW_MAX_BYTES;
    return {
      ok: true, rel: t.rel, path: t.full, size: st.size, mtime: Math.floor(st.mtimeMs / 1000),
      content: buf.slice(0, REVIEW_MAX_BYTES).toString('utf8'), cut: cut, text: REVIEW_TEXT_EXT.test(t.full)
    };
  } catch (ex) { return { ok: false, err: '读取失败：' + String((ex && ex.message) || ex) }; }
});

// ============ 通用：Office / WPS 文档 → PDF（预览面板内嵌显示用，2026-10-13 加）============
// 为什么这么做：Chromium 内核渲染不了 doc/docx/xls/xlsx/ppt/pptx，但**能渲染 PDF**（内核自带阅读器）。
//   本机装了 Microsoft Office ⇒ 借它的 COM 转一次 PDF，交给内核阅读器显示 ⇒ 版式是 Office 自己排的，最接近原样。
// 缓存：结果按「绝对路径 + 大小 + 修改时间」算 sha1，落在 %TEMP%\kun-office-pdf\；同一个文件第二次打开直接命中
//   （几百毫秒），不再起 Office。改过文件（大小或时间变了）⇒ 哈希变了 ⇒ 自动重转，不会看到旧版。
// 失败（.wps/.et/.dps 这类 WPS 私有格式 MS Office 打不开、或本机没装 Office）⇒ 明确回报错误，
//   预览层退回「用系统默认程序打开」的卡片，绝不白屏、绝不静默失败。
const OFFICE_PDF_DIR = path.join(os.tmpdir(), 'kun-office-pdf');
const OFFICE_PS1 = path.join(__dirname, 'scripts', 'office2pdf.ps1');
const OFFICE_KIND = {
  doc: 'word', docx: 'word', rtf: 'word', odt: 'word', wps: 'word',
  xls: 'excel', xlsx: 'excel', ods: 'excel', et: 'excel',
  ppt: 'ppt', pptx: 'ppt', odp: 'ppt', dps: 'ppt'
};
const officeJobs = {};          // key → Promise：同一个文件并发点两次只转一次
let officeSwept = false;

// 顺手清缓存：整个进程生命周期做一次，删掉 14 天没动过的（别让它无声长大）
function officeSweep() {
  if (officeSwept) return;
  officeSwept = true;
  try {
    const cut = Date.now() - 14 * 24 * 3600 * 1000;
    fs.readdirSync(OFFICE_PDF_DIR).forEach(function (f) {
      try {
        const p = path.join(OFFICE_PDF_DIR, f);
        if (fs.statSync(p).mtimeMs < cut) fs.unlinkSync(p);
      } catch (e) { /* ignore */ }
    });
  } catch (e) { /* 目录还不存在，正常 */ }
}

function officeToPdf(src) {
  const ext = (path.extname(src).slice(1) || '').toLowerCase();
  const kind = OFFICE_KIND[ext];
  if (!kind) return Promise.resolve({ ok: false, err: '不是可转换的 Office 格式：.' + ext });
  let st = null;
  try { st = fs.statSync(src); } catch (e) { return Promise.resolve({ ok: false, err: '读不到文件：' + src }); }
  if (!st.isFile()) return Promise.resolve({ ok: false, err: '不是文件：' + src });
  if (st.size > 200 * 1024 * 1024) return Promise.resolve({ ok: false, err: '文件过大（>200MB），不做转换预览' });

  const key = crypto.createHash('sha1')
    .update(src.toLowerCase() + '|' + st.size + '|' + st.mtimeMs).digest('hex');
  const out = path.join(OFFICE_PDF_DIR, key + '.pdf');
  try { if (fs.statSync(out).size > 0) return Promise.resolve({ ok: true, pdf: out, cached: true }); }
  catch (e) { /* 没缓存，往下走 */ }
  if (officeJobs[key]) return officeJobs[key];

  officeSweep();
  const job = new Promise(function (resolve) {
    let settled = false;
    const finish = function (r) { if (!settled) { settled = true; resolve(r); } };
    try { fs.mkdirSync(OFFICE_PDF_DIR, { recursive: true }); }
    catch (e) { return finish({ ok: false, err: '建不了缓存目录：' + e.message }); }
    if (!fs.existsSync(OFFICE_PS1)) return finish({ ok: false, err: '缺少转换脚本 scripts\\office2pdf.ps1' });

    let ch = null;
    try {
      ch = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', OFFICE_PS1, '-In', src, '-Out', out, '-Kind', kind], { windowsHide: true });
    } catch (e) { return finish({ ok: false, err: '起不来 PowerShell：' + e.message }); }

    let so = '', se = '';
    if (ch.stdout) ch.stdout.on('data', function (d) { so += d.toString(); });
    if (ch.stderr) ch.stderr.on('data', function (d) { se += d.toString(); });
    // 90 秒兜底：Office 偶尔会卡在激活/字体对话框上，别让面板一直转圈
    const timer = setTimeout(function () { try { ch.kill(); } catch (e) { /* ignore */ } }, 90000);
    ch.on('error', function (e) { clearTimeout(timer); finish({ ok: false, err: 'PowerShell 起不来：' + e.message }); });
    ch.on('close', function () {
      clearTimeout(timer);
      let size = 0;
      try { size = fs.statSync(out).size; } catch (e) { size = 0; }
      if (size > 0) return finish({ ok: true, pdf: out });
      const detail = String(se || so || '').replace(/\s+/g, ' ').trim().slice(0, 240);
      finish({ ok: false, err: '转成 PDF 失败（' + kind + '）' + (detail ? '：' + detail : '') });
    });
  }).then(function (r) { delete officeJobs[key]; return r; });

  officeJobs[key] = job;
  return job;
}

// p 必须是绝对路径（渲染层给的是文件树里的真实路径）；这里不夹目录 —— 预览面板本来就能浏览任意盘
ipcMain.handle('kun:file:toPdf', function (e, p) {
  const t = String(p == null ? '' : p).trim();
  if (!t) return { ok: false, err: '空路径' };
  if (!path.isAbsolute(t)) return { ok: false, err: '需要绝对路径' };
  return officeToPdf(t);
});

// ================= Blender 场景（独立命名空间 app.blender，不读其它场景数据） =================
let blenderCapProc = null;   // 抓帧子进程（blender-capture.ps1 循环）

// Blender 是否在运行（按进程名判断，不依赖窗口）；tasklist 是同步调用，加 4 秒缓存避免卡主进程
let blenderRunCache = { at: 0, v: false };
function blenderRunning() {
  const now = Date.now();
  if (now - blenderRunCache.at < 4000) return blenderRunCache.v;
  let v = false;
  try {
    const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq blender.exe', '/NH'], { windowsHide: true, encoding: 'utf8' });
    v = String((r && r.stdout) || '').toLowerCase().indexOf('blender.exe') >= 0;
  } catch (e) { v = false; }
  blenderRunCache = { at: now, v: v };
  return v;
}

// Blender 进程 PID 列表（关闭时用；同样走 tasklist，避免额外依赖）
function blenderPidList() {
  const pids = [];
  try {
    const r = spawnSync('tasklist',
      ['/FI', 'IMAGENAME eq blender.exe', '/FO', 'CSV', '/NH'],
      { windowsHide: true, encoding: 'utf8' });
    String((r && r.stdout) || '').split(/\r?\n/).forEach(function (line) {
      const m = line.match(/"blender\.exe","(\d+)"/i);
      if (m) pids.push(parseInt(m[1], 10));
    });
  } catch (e) { /* ignore */ }
  return pids;
}
// 抓帧进程：持续把 Blender 窗口画面写成 JPEG（被 GUI 遮挡也能抓到）
function startBlenderCapture() {
  if (blenderCapProc && blenderCapProc.exitCode === null) return true;
  if (!fs.existsSync(BLENDER_CAPTURE_PS)) { log('[blender] 抓帧脚本缺失: ' + BLENDER_CAPTURE_PS); return false; }
  // 收掉上一轮遗留的抓帧进程：脚本会把自己的 PID 写进 pid 文件，而 GUI 关闭时
  // 子进程不会跟着死（Windows 上父进程退出不杀子进程）。不收的话每重启一次 GUI
  // 就多一个进程抢写同一张 JPEG，实测曾累积到 6 个。
  try {
    if (fs.existsSync(BLENDER_CAPTURE_PID)) {
      const oldPid = parseInt(fs.readFileSync(BLENDER_CAPTURE_PID, 'utf8').trim(), 10);
      if (oldPid > 0) {
        spawnSync('taskkill', ['/pid', String(oldPid), '/T', '/F'], { windowsHide: true });
        log('[blender] 已收掉遗留抓帧进程 pid=' + oldPid);
      }
    }
  } catch (e) { /* ignore */ }
  try {
    blenderCapProc = spawn('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', BLENDER_CAPTURE_PS],
      { windowsHide: true, stdio: 'ignore' });
    blenderCapProc.on('exit', function (code) { log('[blender] 抓帧进程退出 code=' + code); blenderCapProc = null; });
    log('[blender] 抓帧进程已启动');
    return true;
  } catch (e) {
    log('[blender] 抓帧启动失败: ' + ((e && e.message) || e));
    return false;
  }
}
function stopBlenderCapture() {
  if (!blenderCapProc) return;
  try { spawnSync('taskkill', ['/pid', String(blenderCapProc.pid), '/T', '/F'], { windowsHide: true }); } catch (e) { /* ignore */ }
  blenderCapProc = null;
}
function readBlenderMeta() {
  try {
    const raw = fs.readFileSync(BLENDER_LIVE_META, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch (e) { return null; }
}
// MCP 端口是否在监听（Blender 插件里的 socket 服务，AI 助手靠它操作 Blender）
// 用异步 TCP 连接探测（不 spawn 进程，不阻塞主进程），结果缓存 4 秒
let mcpCache = { at: 0, v: false };
function checkMcpPort(cb) {
  const now = Date.now();
  if (now - mcpCache.at < 4000) { cb(mcpCache.v); return; }
  let done = false;
  const finish = (v) => {
    if (done) return;
    done = true;
    mcpCache = { at: Date.now(), v: v };
    try { sock.destroy(); } catch (e) { /* ignore */ }
    cb(v);
  };
  const sock = net.connect({ host: '127.0.0.1', port: BLENDER_MCP_PORT });
  sock.setTimeout(600);
  sock.on('connect', () => finish(true));
  sock.on('timeout', () => finish(false));
  sock.on('error', () => finish(false));
}

// 状态查询：是否运行 / 抓帧是否在跑 / 画面帧信息 / MCP 端口
ipcMain.handle('blender:state', (e, opts) => new Promise((resolve) => {
  if (!opts || opts.capture !== false) startBlenderCapture();
  checkMcpPort(function (mcp) {
    const st = fs.existsSync(BLENDER_LIVE_JPG) ? fs.statSync(BLENDER_LIVE_JPG) : null;
    resolve({
      running: blenderRunning(),
      capturing: !!(blenderCapProc && blenderCapProc.exitCode === null),
      mcp: mcp,
      frame: st ? { size: st.size, mtime: st.mtimeMs } : null,
      meta: readBlenderMeta(),
      liveUrl: 'http://127.0.0.1:' + SITE_PORT + '/__blender/live.jpg',
      workspace: BLENDER_DIR,
      exe: BLENDER_EXE,
      mcpPort: BLENDER_MCP_PORT
    });
  });
}));

// 启动 Blender（带 MCP 自启动脚本，省去手点 N 面板）
ipcMain.handle('blender:launch', () => {
  if (blenderRunning()) return { ok: true, already: true };
  if (!fs.existsSync(BLENDER_EXE)) return { ok: false, err: '找不到 blender.exe：' + BLENDER_EXE };
  try {
    const args = fs.existsSync(BLENDER_AUTOSTART) ? ['--python', BLENDER_AUTOSTART] : [];
    const child = spawn(BLENDER_EXE, args, {
      cwd: path.dirname(BLENDER_EXE),
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });
    child.unref();
    log('[blender] 已启动: ' + BLENDER_EXE + ' ' + args.join(' '));
    startBlenderCapture();
    return { ok: true };
  } catch (ex) { return { ok: false, err: String((ex && ex.message) || ex) }; }
});

// 关闭 Blender（面板「✕ 关闭」按钮）
// 先解除内置再发关闭请求：否则保存确认框会挂在一个被剥了边框、被 owner 的窗口上。
// taskkill 不带 /F 就是给该进程的顶层窗口发 WM_CLOSE —— Blender 会正常走退出流程，
// 有未保存改动时弹自己的保存提示（所以不会静默丢数据）。force=true 时才是强杀。
ipcMain.handle('blender:close', async (e, opts) => {
  const force = !!(opts && opts.force);
  blenderEmbedCssRect = null;
  try { await blenderEmbedCommand({ cmd: 'release' }, 4000); } catch (ex) { /* ignore */ }

  const pids = blenderPidList();
  if (!pids.length) { stopBlenderCapture(); blenderRunCache = { at: Date.now(), v: false }; return { ok: true, already: true }; }

  for (const pid of pids) {
    const a = force ? ['/F', '/PID', String(pid)] : ['/PID', String(pid)];
    try { spawnSync('taskkill', a, { windowsHide: true, encoding: 'utf8' }); } catch (ex) { /* ignore */ }
  }
  log('[blender] 已发送' + (force ? '强制' : '') + '关闭请求 pid=' + pids.join(','));

  // 等一拍看是否真的退了（优雅关闭时可能还停在保存提示上）
  await new Promise(function (res) { setTimeout(res, 1600); });
  const left = blenderPidList();
  if (!left.length) {
    stopBlenderCapture();
    blenderRunCache = { at: Date.now(), v: false };
    return { ok: true, closed: true, requested: pids.length, forced: force };
  }
  return {
    ok: true, closed: false, forced: force,
    waiting: left.length, requested: pids.length,
    hint: '已发送关闭请求；若 Blender 有未保存内容，请在它的保存提示框里选择'
  };
});

// 停止抓帧（面板关闭实时画面时用）
ipcMain.handle('blender:capture', (e, on) => {
  if (on === false) { stopBlenderCapture(); return { ok: true, capturing: false }; }
  return { ok: startBlenderCapture(), capturing: true };
});

// ================= Blender 内置（真把窗口嵌进面板，不是截图）=================
// 安全性：Win32 里子窗口会随父窗口一起销毁，所以如果 GUI 崩了，被嵌入的 Blender
// 会连窗口一起被系统销毁。代理脚本里有守护逻辑——一发现本进程（-ParentPid）没了，
// 立刻把 Blender 还回桌面并还原原始样式与几何。任何情况下 Blender 都必须还能单独用。
let blenderEmbedProc = null;
let blenderEmbedSeq = 0;

function startBlenderEmbedAgent() {
  if (blenderEmbedProc && blenderEmbedProc.exitCode === null) return true;
  if (!fs.existsSync(BLENDER_EMBED_AGENT)) { log('[blender] 内置代理缺失: ' + BLENDER_EMBED_AGENT); return false; }
  try {
    try { fs.unlinkSync(BLENDER_EMBED_RES); } catch (e) { /* ignore */ }
    blenderEmbedProc = spawn('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', BLENDER_EMBED_AGENT,
        '-Cmd', BLENDER_EMBED_CMD, '-Res', BLENDER_EMBED_RES, '-ParentPid', String(process.pid)],
      { windowsHide: true, stdio: 'ignore' });
    blenderEmbedProc.on('exit', function (code) { log('[blender] 内置代理退出 code=' + code); blenderEmbedProc = null; });
    log('[blender] 内置代理已启动 pid=' + blenderEmbedProc.pid);
    return true;
  } catch (e) {
    log('[blender] 内置代理启动失败: ' + ((e && e.message) || e));
    return false;
  }
}

// 命令写进命令文件，等代理把同一个 seq 写回来（文件通道，避免 stdio 管道的阻塞坑）
function blenderEmbedCommand(payload, timeoutMs) {
  return new Promise(function (resolve) {
    if (!startBlenderEmbedAgent()) { resolve({ ok: false, err: 'agent-unavailable' }); return; }
    blenderEmbedSeq += 1;
    const seq = blenderEmbedSeq;
    try { fs.writeFileSync(BLENDER_EMBED_CMD, JSON.stringify(Object.assign({}, payload, { seq: seq }))); }
    catch (e) { resolve({ ok: false, err: 'write-cmd-failed: ' + ((e && e.message) || e) }); return; }

    const limit = timeoutMs || 8000;
    const started = Date.now();
    (function poll() {
      if (Date.now() - started > limit) { resolve({ ok: false, err: 'timeout' }); return; }
      let txt = null;
      try { txt = fs.readFileSync(BLENDER_EMBED_RES, 'utf8').replace(/^\uFEFF/, ''); } catch (e) { txt = null; }
      if (txt) {
        let obj = null;
        try { obj = JSON.parse(txt); } catch (e) { obj = null; }
        if (obj && obj.seq === seq) { resolve(obj); return; }
      }
      setTimeout(poll, 40);
    })();
  });
}

// Electron 窗口句柄 -> 十进制字符串（代理侧按 int64 解析）
function windowHandleToDecimal(win) {
  try {
    const buf = win.getNativeWindowHandle();
    if (buf.length === 8) return buf.readBigUInt64LE(0).toString();
    return String(buf.readUInt32LE(0));
  } catch (e) { return '0'; }
}

// 面板给的是 CSS px（视口坐标），而覆盖式内置用的是「屏幕物理像素」：
// Blender 保持顶层窗口（不 SetParent），所以坐标必须是屏幕坐标 —— 先加窗口内容区
// 在屏幕上的位置（DIP），再整体乘缩放比转成物理像素。
// 多窗口：坐标基准必须是「发起内置的那个窗口」（win），不能写死主窗口。
function toScreenPhysicalRect(r, win) {
  const base = (win && !win.isDestroyed()) ? win : mainWindow;
  let scale = 1, cb = { x: 0, y: 0 };
  try {
    if (base && !base.isDestroyed()) {
      cb = base.getContentBounds();
      scale = screen.getDisplayMatching(base.getBounds()).scaleFactor || 1;
    }
  } catch (e) { scale = 1; }
  const cssX = (r && r.x) || 0;
  const cssY = (r && r.y) || 0;
  return {
    x: Math.round((cb.x + cssX) * scale),
    y: Math.round((cb.y + cssY) * scale),
    w: Math.max(80, Math.round(((r && r.w) || 0) * scale)),
    h: Math.max(60, Math.round(((r && r.h) || 0) * scale))
  };
}

// 覆盖式内置下 Blender 是独立顶层窗口，不会自己跟着 GUI 走 —— 得我们跟。
// 缓存最近一次面板 CSS 矩形，窗口移动/缩放时重算并重发 move。
// ★同时只能有一个窗口「内置」★：那是贴在某个窗口上的一块独立顶层窗口，
// 另一个窗口再内置会互相抢 → 用 blenderEmbedOwner 记账，第二家退回抓帧模式。
let blenderEmbedCssRect = null;
let blenderEmbedOwner = null;
let embedFollowTimer = null;
function scheduleEmbedFollow(win) {
  if (!blenderEmbedCssRect) return;
  // 只有"拥有者窗口"移动/缩放才需要跟；别的窗口挪动跟这块画面无关
  if (win && blenderEmbedOwner && win !== blenderEmbedOwner) return;
  if (embedFollowTimer) clearTimeout(embedFollowTimer);
  embedFollowTimer = setTimeout(function () {
    if (!blenderEmbedCssRect) return;
    const p = toScreenPhysicalRect(blenderEmbedCssRect, blenderEmbedOwner || mainWindow);
    blenderEmbedCommand({ cmd: 'move', x: p.x, y: p.y, w: p.w, h: p.h }, 4000);
  }, 120);
}

ipcMain.handle('blender:embed', async (e, on, rect) => {
  const win = windowOfEvent(e) || mainWindow;
  if (on === false) {
    // 面板现在是「只内置」模式：释放后不再重开抓帧，避免白白占 CPU
    // 只有拥有者能释放（别家窗口的"取消内置"不该把别人的画面收走）
    if (blenderEmbedOwner && win && blenderEmbedOwner !== win) return { ok: true, skipped: true };
    blenderEmbedCssRect = null;
    blenderEmbedOwner = null;
    const r = await blenderEmbedCommand({ cmd: 'release' }, 6000);
    return Object.assign({ ok: true }, r || {});
  }
  if (!win) return { ok: false, err: 'no-window' };
  if (blenderEmbedOwner && blenderEmbedOwner !== win && !blenderEmbedOwner.isDestroyed()) {
    return { ok: false, err: '已在另一个窗口内置（这块画面只能贴一个窗口）' };
  }
  const p = toScreenPhysicalRect(rect || {}, win);
  const res = await blenderEmbedCommand({
    cmd: 'embed', parent: windowHandleToDecimal(win),
    x: p.x, y: p.y, w: p.w, h: p.h
  }, 12000);
  if (res && res.ok) {
    blenderEmbedCssRect = rect || null;
    blenderEmbedOwner = win;
    log('[blender] 内置画面已贴到窗口: ' + (win.kunScene || 'main'));
    stopBlenderCapture();    // 已内置就不必再抓帧，省 CPU
  }
  return res;
});

ipcMain.handle('blender:embedMove', (e, rect) => {
  const win = windowOfEvent(e) || blenderEmbedOwner || mainWindow;
  if (blenderEmbedOwner && win && blenderEmbedOwner !== win) return { ok: false, err: 'not-owner' };
  blenderEmbedCssRect = rect || null;
  const p = toScreenPhysicalRect(rect || {}, win);
  return blenderEmbedCommand({ cmd: 'move', x: p.x, y: p.y, w: p.w, h: p.h }, 4000);
});

ipcMain.handle('blender:embedStatus', () => blenderEmbedCommand({ cmd: 'status' }, 6000));

// 退出时先请代理释放；真来不及也有代理里的守护兜底
function releaseBlenderEmbedSync() {
  try {
    blenderEmbedSeq += 1;
    fs.writeFileSync(BLENDER_EMBED_CMD, JSON.stringify({ cmd: 'quit', seq: blenderEmbedSeq }));
  } catch (e) { /* ignore */ }
}

// 工作区文件浏览（只允许 BLENDER_DIR 内）

// 公开版：OA / 行情 / SSH 业务实现不随包发布（保留空桩，等价于「未连接 / 无数据」）
function __stubModule() { return new Proxy(function () {}, { get: () => () => undefined, apply: () => undefined }); }
const stockStore = __stubModule();
const oaStore = __stubModule();
const oaSsh = __stubModule();
// ===== app-window：把任意工业软件窗口内置成面板（2026-10-28 · 客户「<客户>」）=====
// 与 blender 的 owner-overlay 同一套思路（见 scripts\app-embed-agent.ps1 头部：⛔ 不用 SetParent）。
// 差异：目标进程名由渲染器传进来（Proc），一次只服务一个进程（换进程就重启 agent）。
const APPW_AGENT = path.join(__dirname, 'scripts', 'app-embed-agent.ps1');
const APPW_CMD = path.join(__dirname, 'data', 'appwin.cmd.json');
const APPW_RES = path.join(__dirname, 'data', 'appwin.res.json');
let appwProc = null, appwSeq = 0, appwProcName = '';
let appwCssRect = null, appwOwner = null, appwFollowTimer = null;

function startAppwAgent(procName) {
  const name = String(procName || '').trim();
  if (!name) return false;
  if (appwProc && appwProc.exitCode === null && appwProcName === name) return true;
  if (appwProc && appwProc.exitCode === null) { try { appwProc.kill(); } catch (e) { /* ignore */ } appwProc = null; }
  if (!fs.existsSync(APPW_AGENT)) { log('[appwin] 内置代理缺失: ' + APPW_AGENT); return false; }
  try {
    try { fs.unlinkSync(APPW_RES); } catch (e) { /* ignore */ }
    appwProcName = name;
    appwProc = spawn('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', APPW_AGENT,
        '-Cmd', APPW_CMD, '-Res', APPW_RES, '-ParentPid', String(process.pid), '-Proc', name],
      { windowsHide: true, stdio: 'ignore' });
    appwProc.on('exit', function (code) { log('[appwin] 内置代理退出 code=' + code); appwProc = null; });
    log('[appwin] 内置代理已启动 pid=' + appwProc.pid + ' · proc=' + name);
    return true;
  } catch (e) { log('[appwin] 内置代理启动失败: ' + ((e && e.message) || e)); return false; }
}

function appwCommand(payload, timeoutMs) {
  return new Promise(function (resolve) {
    if (!startAppwAgent(payload && payload.proc)) { resolve({ ok: false, err: 'agent-unavailable' }); return; }
    appwSeq += 1;
    const seq = appwSeq;
    try { fs.writeFileSync(APPW_CMD, JSON.stringify(Object.assign({}, payload, { seq: seq }))); }
    catch (e) { resolve({ ok: false, err: 'write-cmd-failed: ' + ((e && e.message) || e) }); return; }
    const limit = timeoutMs || 8000;
    const started = Date.now();
    (function poll() {
      if (Date.now() - started > limit) { resolve({ ok: false, err: 'timeout' }); return; }
      let txt = null;
      try { txt = fs.readFileSync(APPW_RES, 'utf8').replace(/^\uFEFF/, ''); } catch (e) { txt = null; }
      if (txt) {
        let obj = null;
        try { obj = JSON.parse(txt); } catch (e) { obj = null; }
        if (obj && obj.seq === seq) { resolve(obj); return; }
      }
      setTimeout(poll, 120);
    })();
  });
}

function scheduleAppwFollow(win) {
  if (!appwCssRect) return;
  if (win && appwOwner && win !== appwOwner) return;
  if (appwFollowTimer) clearTimeout(appwFollowTimer);
  appwFollowTimer = setTimeout(function () {
    if (!appwCssRect) return;
    const p = toScreenPhysicalRect(appwCssRect, appwOwner || mainWindow);
    appwCommand({ cmd: 'move', proc: appwProcName, x: p.x, y: p.y, w: p.w, h: p.h }, 4000);
  }, 120);
}

ipcMain.handle('appwin:status', (e, procName) => appwCommand({ cmd: 'status', proc: String(procName || '') }, 4000));

ipcMain.handle('appwin:launch', (e, exe, args) => {
  const p = String(exe || '').trim();
  if (!p) return { ok: false, err: 'no-exe' };
  if (!fs.existsSync(p)) return { ok: false, err: 'exe-not-found', path: p };
  try {
    const child = spawn(p, Array.isArray(args) ? args : [], { detached: true, stdio: 'ignore', cwd: path.dirname(p) });
    child.unref();
    return { ok: true, pid: child.pid };
  } catch (err) { return { ok: false, err: String((err && err.message) || err) }; }
});

ipcMain.handle('appwin:embed', async (e, procName, rect) => {
  const win = windowOfEvent(e) || mainWindow;
  if (!win) return { ok: false, err: 'no-window' };
  if (appwOwner && appwOwner !== win && !appwOwner.isDestroyed()) return { ok: false, err: '已在另一个窗口内置' };
  const p = toScreenPhysicalRect(rect || {}, win);
  const res = await appwCommand({
    cmd: 'embed', proc: String(procName || ''), parent: windowHandleToDecimal(win),
    x: p.x, y: p.y, w: p.w, h: p.h
  }, 12000);
  if (res && res.ok) { appwCssRect = rect || null; appwOwner = win; log('[appwin] 已贴到面板: ' + (win.kunScene || 'main')); }
  return res || { ok: false, err: 'no-res' };
});

ipcMain.handle('appwin:move', async (e, rect) => {
  const win = windowOfEvent(e) || mainWindow;
  if (!appwCssRect) return { ok: false, err: 'not-embedded' };
  const p = toScreenPhysicalRect(rect || {}, win || appwOwner || mainWindow);
  appwCssRect = rect || null;
  return appwCommand({ cmd: 'move', proc: appwProcName, x: p.x, y: p.y, w: p.w, h: p.h }, 4000);
});

ipcMain.handle('appwin:release', async () => {
  appwCssRect = null; appwOwner = null;
  return appwCommand({ cmd: 'release', proc: appwProcName }, 6000);
});

ipcMain.handle('blender:files', (e, relPath) => {
  const root = path.resolve(BLENDER_DIR);
  try { if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true }); } catch (ex) { /* ignore */ }
  const rel = String(relPath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const full = rel ? path.resolve(root, rel) : root;
  if (full !== root && !full.startsWith(root + path.sep)) return { ok: false, err: '越界路径：仅可浏览 Blender 工作区' };
  let ents = [];
  try { ents = fs.readdirSync(full, { withFileTypes: true }); }
  catch (ex) { return { ok: false, err: '无法读取目录：' + full }; }
  const rows = ents.map(en => {
    let isDir = en.isDirectory(), size = 0, mtime = 0;
    try {
      const st = fs.statSync(path.join(full, en.name));
      isDir = st.isDirectory(); size = isDir ? 0 : st.size; mtime = Math.floor(st.mtimeMs / 1000);
    } catch (ex2) { /* ignore */ }
    return { name: en.name, isDir: isDir, size: size, mtime: mtime };
  }).filter(r => r.name !== '.gitkeep')
    .sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name, 'zh'));
  return { ok: true, root: root, rel: rel, rows: rows };
});

// 打开路径：文件用系统默认程序，目录用资源管理器；也支持 http(s) 链接
ipcMain.handle('blender:open', (e, target) => {
  const t = String(target || '');
  if (!t) return { ok: false, err: 'empty' };
  try {
    if (/^https?:\/\//i.test(t)) shell.openExternal(t);
    else if (fs.existsSync(t)) shell.openPath(t);
    else return { ok: false, err: '路径不存在：' + t };
    return { ok: true };
  } catch (ex) { return { ok: false, err: String((ex && ex.message) || ex) }; }
});

// 在资源管理器里定位（选中）工作区内的条目
ipcMain.handle('blender:reveal', (e, relPath) => {
  const root = path.resolve(BLENDER_DIR);
  const rel = String(relPath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const full = rel ? path.resolve(root, rel) : root;
  if (full !== root && !full.startsWith(root + path.sep)) return { ok: false, err: '越界路径' };
  try { shell.showItemInFolder(full); return { ok: true }; }
  catch (ex) { return { ok: false, err: String((ex && ex.message) || ex) }; }
});

// 个人站场景：把文件/文件夹「拖出去」给别的窗口 ——
// 本地文件面板里按住条目拖到资源管理器＝复制一份，拖到浏览器/编辑器等＝把该文件直接交给它。
// 必须由主进程调用 webContents.startDrag（渲染层只负责在 dragstart 时把相对路径发过来）。
let siteDragIcon = null;
function siteIcon() {
  if (siteDragIcon && !siteDragIcon.isEmpty()) return siteDragIcon;
  for (const f of ['icon.png', 'icon.ico']) {
    try {
      const img = nativeImage.createFromPath(path.join(__dirname, f));
      if (img && !img.isEmpty()) { siteDragIcon = img; return img; }
    } catch (ex) { /* 继续尝试下一个 */ }
  }
  return null;
}
ipcMain.on('site:drag', (event, relPath) => {
  try {
    const root = path.resolve(SITE_BROWSE_DIR);
    const rel = String(relPath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const full = rel ? path.resolve(root, rel) : root;
    // 安全：只允许拖出项目工程目录内的条目（与 site:files:local 同一守卫）
    if (full !== root && !full.startsWith(root + path.sep)) { log('[site:drag] 越界：' + full); return; }
    if (!fs.existsSync(full)) { log('[site:drag] 不存在：' + full); return; }
    const item = { file: full };
    const ic = siteIcon();
    if (ic) item.icon = ic;   // 拖动时跟手的缩略图
    event.sender.startDrag(item);
    log('[site:drag] 拖出：' + full);
  } catch (ex) { log('[site:drag] 失败：' + (ex && ex.message || ex)); }
});

// ---- 股票助手：本地存储（记忆 / 聊天 / 行情缓存）----
// 场景隔离强化：stock:chat:* / stock:mem:* 的 scenario 参数统一白名单归一化——
// 只允许 stock / oa-ops / personal-site 三个场景，非法/未传值一律落回 'stock'，
// 从主进程侧杜绝渲染层误传或越权把数据写进其他场景（三场景硬隔离）。
const STOCK_SCENARIOS = ['stock', 'oa-ops', 'personal-site'];
function normScenario(s) {
  return STOCK_SCENARIOS.indexOf(String(s || '')) >= 0 ? String(s) : 'stock';
}
ipcMain.handle('stock:mem:add', (e, m) => stockStore.addMemory(Object.assign({}, m || {}, { scenario: normScenario(m && m.scenario) })));
// 场景透传：不传时默认 'stock'，OA 场景必须显式传 'oa-ops'，避免串读
ipcMain.handle('stock:mem:list', (e, kind, scenario) => stockStore.listMemories(kind, normScenario(scenario)));
ipcMain.handle('stock:mem:update', (e, id, patch) => stockStore.updateMemory(id, patch));
ipcMain.handle('stock:mem:delete', (e, id) => stockStore.deleteMemory(id));
ipcMain.handle('stock:chat:create', (e, scenario, title) => stockStore.createSession(normScenario(scenario), title));
ipcMain.handle('stock:chat:list', (e, scenario) => stockStore.listSessions(normScenario(scenario)));
ipcMain.handle('stock:chat:messages', (e, sid) => stockStore.getMessages(sid));
ipcMain.handle('stock:chat:send', (e, sid, role, content) => stockStore.addMessage(sid, role, content));
ipcMain.handle('stock:chat:delete', (e, sid) => stockStore.deleteSession(sid));
ipcMain.handle('stock:chat:rename', (e, sid, title) => stockStore.renameSession(sid, title));

// ---- OA 运维场景：数据读写（D 盘 data/oa.db，与股票完全隔离）----
// 服务器状态 / 操作日志 / 文件 / 网页站点 / 一键操作 / 终端 / 配置 / SSH
let oaStatusCache = { ts: 0, data: null };
let oaStatusError = null;

// ---- OA 采集缓存（TTL + 单飞）----
// 目的：面板高频轮询不再直接打 SSH（每次 SSH 采集要新起 Python + 新握手，实测约 0.74s，其中 82% 花在建通道）。
// 策略：TTL 略小于面板轮询间隔 → 每次轮询都能拿到"新鲜"数据，但同一时刻的重复触发（手动刷新+定时）只采一次。
// 规则：TTL 内直接命中缓存；同一 key 并发请求共享同一次采集（单飞）；手动刷新传 force 绕过。
const oaCache = new Map();      // key -> { ts, val }
const oaInflight = new Map();   // key -> Promise（单飞）
const OA_TTL = { status: 15000, logs: 8000, files: 25000, sync: 55000, web: 20000 };
function cachedOa(key, ttlMs, fn, force) {
  const now = Date.now();
  const hit = oaCache.get(key);
  if (!force && hit && (now - hit.ts) < ttlMs) return Promise.resolve(hit.val);
  const flying = oaInflight.get(key);
  if (flying) return flying;
  const p = Promise.resolve().then(fn).then((val) => {
    oaCache.set(key, { ts: Date.now(), val: val });
    oaInflight.delete(key);
    return val;
  }).catch((err) => {
    oaInflight.delete(key);
    throw err;
  });
  oaInflight.set(key, p);
  return p;
}
function invalidateOaCache(prefix) {
  for (const k of Array.from(oaCache.keys())) if (!prefix || k.indexOf(prefix) === 0) oaCache.delete(k);
}

// 读取状态：已配置 SSH 且缓存超 60s 时通过真实 SSH 采集并写库；未配置/失败回退存储快照（演示数据）
async function getOaStatus(force) {
  if (!oaSsh.isReady()) return oaStore.getStatus();
  try {
    const r = await cachedOa('status', OA_TTL.status, () => oaSsh.collectStatus(), force);
    if (r && r.ok && r.status) {
      oaStore.setStatus(r.status);
      oaStatusError = null;
      return r.status;
    }
    oaStatusError = (r && r.err) || '未知错误';
  } catch (ex) {
    oaStatusError = String((ex && ex.message) || ex);
  }
  const hit = oaCache.get('status');
  if (hit && hit.val && hit.val.status) return hit.val.status;
  return oaStore.getStatus();
}
ipcMain.handle('oa:status', (e, force) => getOaStatus(!!force));
ipcMain.handle('oa:logs', (e, limit) => oaStore.getLogs(limit));
// 真实日志：SSH 已连接 → 抓取 pm2 后端 / nginx / mysql 日志；结果缓存供 AI 上下文引用（面板轮询 30s + 30s TTL）
let oaLogsCache = null;
ipcMain.handle('oa:logs:real', async (e, kinds, lines, force) => {
  if (!oaSsh.isReady()) return { ok: false, err: '未连接服务器', demo: true, rows: oaStore.getLogs(Number(lines) || 12) };
  const key = 'logs:' + String(kinds) + ':' + String(lines || 12);
  try {
    const r = await cachedOa(key, OA_TTL.logs, () => oaSsh.fetchLogs(kinds, lines), !!force);
    if (r && r.ok) {
      oaLogsCache = { ts: Date.now(), sources: r.sources || {} };
      return { ok: true, sources: r.sources || {}, ts: Date.now() };
    }
    return { ok: false, err: (r && r.err) || '日志抓取失败', demo: true, rows: oaStore.getLogs(Number(lines) || 12) };
  } catch (ex) {
    return { ok: false, err: String((ex && ex.message) || ex), demo: true, rows: oaStore.getLogs(Number(lines) || 12) };
  }
});
// 云端文件：SSH 已连接 → 真实 SFTP 列表（60s TTL）；否则回退演示缓存
ipcMain.handle('oa:files', async (e, remotePath, force) => {
  const base = remotePath || oaStore.getConfig('oa.path.code') || '/opt/langchen_oa';
  if (oaSsh.isReady()) {
    try {
      const r = await cachedOa('files:' + base, OA_TTL.files, () => oaSsh.listDir(base), !!force);
      if (r && r.ok) return { ok: true, base: base, rows: r.entries || [], real: true };
    } catch (ex) { /* 失败回退 */ }
    return { ok: false, err: '列表获取失败', base: base, rows: oaStore.getFiles(base).rows, real: false };
  }
  const f = oaStore.getFiles(base);
  return { ok: true, base: f.base, rows: f.rows, real: false };
});
// 本地文件：项目目录浏览（与云端无关，始终可用）
ipcMain.handle('oa:files:local', async (e, localPath) => {
  const base = localPath || oaStore.getConfig('oa.path.local') || '<资料库>';
  try {
    // ★ 异步 + 并行 stat：不再阻塞主进程（原来用 readdirSync/statSync，大目录会卡住整个界面）
    const ents = await fs.promises.readdir(base, { withFileTypes: true });
    const rows = await Promise.all(ents.map(async (en) => {
      let isDir = en.isDirectory(), size = 0, mtime = 0;
      try {
        const st = await fs.promises.stat(path.join(base, en.name));
        isDir = st.isDirectory(); size = isDir ? 0 : st.size; mtime = Math.floor(st.mtimeMs / 1000);
      } catch (err) { /* 忽略单个文件失败 */ }
      return { name: en.name, isDir: isDir, size: size, mtime: mtime };
    }));
    rows.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name, 'zh'));
    return { ok: true, base: base, rows: rows };
  } catch (ex) {
    return { ok: false, err: '无法读取目录: ' + base, base: base, rows: [] };
  }
});
ipcMain.handle('oa:paths', () => {
  const mp = scenarioMeta().paths || {};
  return {
    localRoot: mp.local || oaStore.getConfig('oa.path.local') || '<资料库>',
    code: mp.code || oaStore.getConfig('oa.path.code') || '/opt/langchen_oa',
    www: mp.www || oaStore.getConfig('oa.path.www') || '/var/www',
    backups: mp.backups || oaStore.getConfig('oa.path.backups') || '/opt/langchen_oa_backups',
    mappings: oaSsh.getMappings()
  };
});
// 切换当前 OA 场景（多公司模板：切换后 SSH/服务/映射/日志/网址 全部随场景走）
ipcMain.handle('oa:set-scenario', (e, sid) => applyOaScenario(sid));
// 实时同步状态（本地 ↔ 云端 mtime+size 比对）；结果缓存 120s 供 AI 上下文引用，避免每次对话/轮询都全量比对
let oaSyncCache = null;
// ★ 原生拖拽：把面板里的文件拖到资源管理器 / 别的窗口
ipcMain.on('oa:dragstart', (event, filePath) => {
  // ★ 任何一步异常都不能外抛，否则主进程崩溃 = 整个工作台退出
  try {
    const fp = String(filePath || '');
    if (!fp || !fs.existsSync(fp)) return;
    // 图标必须是非空 NativeImage；空图会让 startDrag 直接抛异常
    let icon = null;
    try {
      const img = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
      if (img && !img.isEmpty()) icon = img.resize({ width: 64 });
    } catch (e) { icon = null; }
    const payload = { file: fp };
    if (icon && !icon.isEmpty()) payload.icon = icon;
    event.sender.startDrag(payload);
  } catch (ex) {
    try { console.error('[oa:dragstart] 已忽略错误：', ex && ex.message); } catch (e2) {}
  }
});
// ★ 读图（返回 dataURL，供面板大图显示）：支持本地绝对路径
ipcMain.handle('oa:image', async (e, p) => {
  try {
    const fp = String(p || '');
    if (!fp || !fs.existsSync(fp)) return { ok: false, err: '文件不存在' };
    const st = fs.statSync(fp);
    if (st.size > 12 * 1024 * 1024) return { ok: false, err: '图片过大（>12MB）' };
    const ext = path.extname(fp).slice(1).toLowerCase();
    const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif'
      : ext === 'webp' ? 'image/webp' : ext === 'bmp' ? 'image/bmp' : 'image/jpeg';
    const b64 = fs.readFileSync(fp).toString('base64');
    return { ok: true, dataUrl: 'data:' + mime + ';base64,' + b64, name: path.basename(fp) };
  } catch (ex) { return { ok: false, err: String((ex && ex.message) || ex) }; }
});
// ★ OA 场景专用：打开本地文件夹 / 打开本地文件（保持场景隔离，只用 oa 命名空间）
ipcMain.handle('oa:openFolder', async (e, dir) => {
  try {
    const d = String(dir || '');
    if (!d || !fs.existsSync(d)) return { ok: false, err: '目录不存在: ' + d };
    const r = await shell.openPath(d);
    return r ? { ok: false, err: r } : { ok: true };
  } catch (ex) { return { ok: false, err: String((ex && ex.message) || ex) }; }
});
ipcMain.handle('oa:openPath', async (e, p) => {
  try {
    const t = String(p || '');
    if (!t) return { ok: false, err: 'empty' };
    if (/^https?:\/\//i.test(t)) { shell.openExternal(t); return { ok: true }; }
    if (!fs.existsSync(t)) return { ok: false, err: '文件不存在: ' + t };
    const r = await shell.openPath(t);
    return r ? { ok: false, err: r } : { ok: true };
  } catch (ex) { return { ok: false, err: String((ex && ex.message) || ex) }; }
});
ipcMain.handle('oa:upload', async (e, localPath, remoteDir) => oaSsh.putFile(localPath, remoteDir));
ipcMain.handle('oa:download', async (e, remotePath, localDir) => oaSsh.getFile(remotePath, localDir));
ipcMain.handle('oa:sync:status', async (e, force) => {
  try {
    const r = await cachedOa('syncstatus', OA_TTL.sync, () => oaSsh.syncStatus(), !!force);
    if (r && r.ok) oaSyncCache = r;
    return r;
  } catch (ex) {
    return { ok: false, err: String((ex && ex.message) || ex) };
  }
});
// 一键推送 / 拉取（与云控台同步规则一致；执行后刷新同步状态与操作日志）
async function runSyncTransfer(mode, key) {
  if (!oaSsh.isReady()) return { ok: false, err: '未连接服务器（配置 SSH 后可用）' };
  const r = await oaSsh.syncTransfer(mode, key);
  const m = oaSsh.getMappings().find(x => x.key === key);
  const label = (m && m.label) || key;
  const arrow = mode === 'push' ? '推送' : '拉取';
  if (r && r.ok) {
    // 同步完成 → 让文件/同步状态缓存立即失效，面板下次刷新拿到真实结果
    invalidateOaCache('files:');
    invalidateOaCache('syncstatus');
    oaStore.addLog('info', 'sync', arrow + '「' + label + '」完成：更新 ' + r.total + ' 个文件' + (r.changed && r.changed.length ? '（' + r.changed.slice(0, 5).join(', ') + (r.total > 5 ? ' …' : '') + '）' : ''));
    const st = await oaSsh.syncStatus();
    if (st && st.ok) { oaSyncCache = st; oaCache.set('syncstatus', { ts: Date.now(), val: st }); }
    return { ok: true, mode: mode, key: key, label: label, total: r.total, changed: r.changed || [] };
  }
  oaStore.addLog('err', 'sync', arrow + '「' + label + '」失败：' + ((r && r.err) || '未知'));
  return { ok: false, mode: mode, key: key, label: label, err: (r && r.err) || '未知错误' };
}
ipcMain.handle('oa:sync:push', (e, key, via) => {
  // via='ai' 表示由 AI 助手触发：受 AI 同步权限约束；用户手动点击按钮不受限
  if (via === 'ai' && !getAiPermissions().sync) return { ok: false, err: 'AI 同步权限已关闭（请在 AI 助手面板的权限开关里开启）' };
  return runSyncTransfer('push', key);
});
ipcMain.handle('oa:sync:pull', (e, key, via) => {
  if (via === 'ai' && !getAiPermissions().sync) return { ok: false, err: 'AI 同步权限已关闭（请在 AI 助手面板的权限开关里开启）' };
  return runSyncTransfer('pull', key);
});
ipcMain.handle('oa:web:list', () => oaStore.listWebSites());

// ---- OA 相关网址（管理后台/教师端/家长端/官网/APK，来自云控台 config.json urls）----
function oaUrls() {
  const m = scenarioMeta();
  // ① 场景 meta.urls 优先：多公司模板下，每家公司自带网址清单（含备用/附加链接）
  if (Array.isArray(m.urls) && m.urls.length) {
    return m.urls.filter(u => u && u.url).map(u => {
      const it = { name: u.name || u.url, url: u.url };
      if (u.backup) it.backup = u.backup;
      if (Array.isArray(u.links) && u.links.length) it.links = u.links;
      return it;
    });
  }
  // ② 缺省：<客户>默认清单（可被 oa.db 的 oa.url.* 覆盖）
  const def = [
    { name: '管理后台', url: 'http://example.com:8083' },
    { name: '教师端', url: 'http://example.com:8081' },
    { name: '家长端', url: 'http://example.com:8082' },
    // ★ 2026-09-28 新增教务端；★ 2026-09-29 用户要求标题去掉「·手机版」后缀 —— 就叫「教务端」（地址仍是 /m/ 手机版 H5）
    { name: '教务端', url: 'http://example.com:8083/m/' },
    {
      name: '<客户>官网', url: 'http://example.com:8084',
      links: [
        { label: '备用1', url: 'http://example.com:8081/site/' },
        { label: '备用2', url: 'http://example.com:8082/site/' },
        { label: '备用3', url: 'http://example.com:8083/site/' }
      ]
    },
    {
      name: 'APK 下载', url: 'http://example.com:8081/apk/teacher.apk',
      links: [
        { label: '教师端', url: 'http://example.com:8081/apk/teacher.apk' },
        { label: '家长端', url: 'http://example.com:8082/apk/parent.apk' },
        // ★ 2026-09-29 新增教务端 APK（首个教务端包，2026-09-29 上架；官网上也已加教务端入口）
        { label: '教务端', url: 'http://example.com:8083/apk/admin.apk' }
      ]
    }
  ];
  const out = [];
  ['admin', 'teacher', 'parent', 'mobile', 'site', 'apk'].forEach((k, i) => {
    const v = oaStore.getConfig('oa.url.' + k);
    const item = { name: def[i].name, url: v || def[i].url };
    if (def[i].backup) item.backup = def[i].backup;   // 官网备用入口（点卡片走主地址，点备用行走备用）
    if (def[i].links) item.links = def[i].links;      // 附加链接（APK：教师端/家长端 共用一个卡片）
    out.push(item);
  });
  return out;
}
// 单 URL HTTP 探测（code + 延迟）
// ⚠️ 必须只取响应头：APK 等大文件若读正文，每轮探测都会下载整个包（31MB+，15 秒一次 → 每天数百 MB）
// 策略：优先 HEAD（nginx 支持 → 正文 0 字节）；遇 405/501 再回退 GET 并在收到响应头后立即断开
// 另：带 DSH-OA-Probe UA（服务器端可据此不写访问日志 → 真实流量更易检测）+ keep-alive 复用连接
const PROBE_UA = 'DSH-OA-Probe/1.0';
const probeAgent = new http.Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 4 });
function httpProbe(url, timeoutMs) {
  const timeout = timeoutMs || 6000;
  const once = (method) => new Promise((resolve) => {
    const started = Date.now();
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    let req;
    try {
      req = http.request(String(url), {
        method: method,
        timeout: timeout,
        agent: probeAgent,
        headers: { 'User-Agent': PROBE_UA, 'Accept-Encoding': 'identity', 'Connection': 'keep-alive' }
      }, (res) => {
        const code = res.statusCode;
        const ms = Date.now() - started;
        try { res.destroy(); } catch (e) { /* ignore */ }   // 不读正文
        finish({ ok: code >= 200 && code < 500, code: code, ms: ms });
      });
    } catch (ex) {
      finish({ ok: false, code: null, ms: Date.now() - started, err: String((ex && ex.message) || ex) });
      return;
    }
    req.on('error', (ex) => finish({ ok: false, code: null, ms: Date.now() - started, err: String((ex && ex.message) || ex) }));
    req.on('timeout', () => { req.destroy(); finish({ ok: false, code: null, ms: Date.now() - started, err: '超时' }); });
    req.end();
  });
  return once('HEAD').then((r) => ((r.code === 405 || r.code === 501) ? once('GET') : r));
}
// 实时监控网址状态（并发探测主地址 + 备用地址 + 附加链接；结果回写 oa.db web_sites，供窗口5与 AI 上下文使用）
async function webCheck(urls) {
  const list = (urls && urls.length) ? urls : oaUrls();
  const out = await Promise.all(list.map(async (u) => {
    const jobs = [httpProbe(u.url, 6000)];
    if (u.backup) jobs.push(httpProbe(u.backup, 6000));
    (u.links || []).forEach(lk => jobs.push(httpProbe(lk.url, 6000)));
    const rs = await Promise.all(jobs);
    let i = 0;
    const item = Object.assign({ name: u.name, url: u.url }, rs[i++]);
    if (u.backup) {
      const b = rs[i++];
      item.backup = u.backup;
      item.backupOk = b.ok;
      item.backupCode = b.code;
      item.backupMs = b.ms;
      item.backupErr = b.err;
    }
    if (u.links && u.links.length) {
      item.links = u.links.map(lk => {
        const r = rs[i++];
        return Object.assign({}, lk, { ok: r.ok, code: r.code, ms: r.ms, err: r.err });
      });
    }
    return item;
  }));
  oaStore.syncWebSites(out.map(o => ({
    name: o.name, url: o.url,
    status: o.ok ? '正常' : '异常',
    note: (o.ok ? ('HTTP ' + o.code + ' · ' + o.ms + 'ms') : (o.err || '离线'))
      + (o.backup ? ('｜备用 ' + (o.backupOk ? ('HTTP ' + o.backupCode + ' · ' + o.backupMs + 'ms') : (o.backupErr || '离线'))) : '')
      + ((o.links && o.links.length)
        ? ('｜' + o.links.map(lk => lk.label + ' ' + (lk.ok ? ('HTTP ' + lk.code) : (lk.err || '离线'))).join('｜'))
        : '')
  })));
  return out;
}
ipcMain.handle('oa:urls', () => oaUrls());
ipcMain.handle('oa:web:check', (e, urls, force) => cachedOa('webcheck', OA_TTL.web, () => webCheck(urls), !!force));
ipcMain.handle('oa:open', (e, url) => {
  try { shell.openExternal(String(url)); return { ok: true }; }
  catch (ex) { return { ok: false, err: String((ex && ex.message) || ex) }; }
});

// ---- 「手机预览」：按 界面预览\打开*.bat 的配方把线上站点开成手机尺寸独立窗口（2026-09-18）----
// 为什么要单开一条 IPC：面板点击走 shell.openExternal，只能呼出系统默认浏览器 ——
// 既做不到 400×830 的手机窗口，也做不到「独立配置目录记住登录」（每次都要重新登录）。
// ★ 2026-09-23 改版：窗口打开的是**本地包装页**（127.0.0.1:PREVIEW_PORT），包装页里 iframe 嵌线上站点，
//   顶部左侧有一个 📌 置顶按钮 —— 按钮在窗口**内部**（不占场景面板），点它调本地 /api/pin → SetWindowPos 置顶。
//   为什么包装页：外部浏览器 --app= 窗口没有"往窗口里加按钮"的通道，只能往页面内容里注入；
//   包装页同时保留独立配置目录（--user-data-dir 不变，登录照样记住）。
const PREVIEW_ROOT = '<资料库>';
const PREVIEW_PORT = Number(process.env.PREVIEW_PORT || 31240);
const PREVIEW_APPS = {
  parent: { name: '家长端', url: 'http://example.com:8082/', x: 70, y: 60 },
  teacher: { name: '教师端', url: 'http://example.com:8081/', x: 510, y: 60 },
  // ★ 2026-09-28 新增「教务端」＝教务后台**手机版 H5**（挂在 8083 的 /m/ 子路径，不是独立端口）
  jiaowu: { name: '教务端', url: 'http://example.com:8083/m/', x: 950, y: 60 }
};
// ★ 2026-09-23 「置顶」：记住每个端最近一次打开的预览窗口 pid，切换置顶时按 pid 找窗口
const PREVIEW_PIDS = {};   // which -> pid（每次打开都覆盖；窗口关了 pid 就失效，pin 会返回"找不到"）
let PREVIEW_PINNED = {};   // which -> true/false（包装页按钮状态回显用）
let previewServer = null;

// 包装页 HTML：顶部一条**顶栏**（右侧 📌 置顶按钮，紧挨系统缩小/放大/关闭那排按钮的下方）+ 下方 iframe 嵌线上站点。
// 2026-09-23 按反馈改：按钮不悬浮（悬浮会挡 iframe 内容），而是做进顶栏 —— 顶栏右侧就是"缩小按键旁边"。
// 系统窗口按钮画在系统标题栏（页面内容上方），本页顶栏贴在标题栏正下方，按钮放顶栏右端，视觉上紧挨那排按钮。
function previewShellHtml(which) {
  const app = PREVIEW_APPS[String(which)] || PREVIEW_APPS.parent;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${app.name} · 预览</title>
<style>
  html, body { margin:0; padding:0; height:100%; background:#fff; overflow:hidden; }
  #bar {
    position:fixed; left:0; right:0; top:0; height:34px; z-index:9999;
    display:flex; align-items:center; justify-content:flex-end; gap:8px;
    padding:0 8px; box-sizing:border-box;
    background:linear-gradient(180deg,#f5f5f5,#e9e9e9);
    border-bottom:1px solid rgba(0,0,0,.12);
    -webkit-app-region:no-drag;
  }
  #barTitle {
    margin-right:auto; font-size:12px; color:#666;
    font-family:"Microsoft YaHei",sans-serif; user-select:none;
  }
  #pinBtn {
    display:flex; align-items:center; gap:4px;
    padding:4px 10px; font-size:12px; line-height:1;
    font-family:"Microsoft YaHei",sans-serif; cursor:pointer;
    background:#fff; color:#555;
    border:1px solid rgba(0,0,0,.22); border-radius:999px;
    box-shadow:0 1px 2px rgba(0,0,0,.12);
    user-select:none; -webkit-user-select:none;
  }
  #pinBtn:hover { background:#fafafa; color:#333; }
  #pinBtn.on { background:#f59e0b; border-color:#d97706; color:#fff; box-shadow:0 1px 6px rgba(217,119,6,.45); }
  iframe { position:fixed; left:0; right:0; top:34px; bottom:0; width:100%; height:calc(100% - 34px); border:0; }
</style>
</head>
<body>
<div id="bar">
  <span id="barTitle">${app.name} · 预览</span>
  <button id="pinBtn" title="置顶预览窗口（浮在最上层，边聊天边看）">📌 置顶</button>
</div>
<iframe src="${app.url}" allow="geolocation; camera; microphone"></iframe>
<script>
(function () {
  var btn = document.getElementById('pinBtn');
  var on = false;
  function paint() { btn.classList.toggle('on', on); btn.textContent = on ? '📌 已置顶' : '📌 置顶'; }
  function setState(s) { on = !!s; paint(); }
  function callPin(next) {
    fetch('http://127.0.0.1:${PREVIEW_PORT}/api/pin?which=${which}&on=' + (next ? 1 : 0))
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d && d.ok) setState(!!d.pinned); })
      .catch(function () { /* 服务不在（GUI 已关）就不动状态 */ });
  }
  btn.addEventListener('click', function () { callPin(!on); });
  // 打开时回显主进程记住的置顶状态（同一窗口重开 / 从面板重开都准）
  fetch('http://127.0.0.1:${PREVIEW_PORT}/api/pin-state?which=${which}')
    .then(function (r) { return r.json(); })
    .then(function (d) { if (d && d.ok) setState(!!d.pinned); })
    .catch(function () {});
})();
</script>
</body>
</html>`;
}

// 本地预览服务：出包装页 + /api/pin + /api/pin-state（跨域放开，因为包装页 fetch 自带的 origin）
function startPreviewServer() {
  if (previewServer) return;
  previewServer = http.createServer(function (req, res) {
    const u = decodeURIComponent((req.url || '/').split('?')[0]);
    const q = (req.url || '').split('?')[1] || '';
    const get = (k) => { const m = new RegExp('[?&]' + k + '=([^&]*)').exec('?' + q); return m ? decodeURIComponent(m[1]) : ''; };
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (u === '/api/pin') {
      const which = get('which');
      const on = get('on') === '1';
      const app = PREVIEW_APPS[which];
      if (!app) { res.writeHead(400); res.end('bad which'); return; }
      doPinPreview(which, on).then(function (r) {
        res.writeHead(r.ok ? 200 : 409, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(r));
      }).catch(function (ex) {
        res.writeHead(500); res.end(JSON.stringify({ ok: false, err: String((ex && ex.message) || ex) }));
      });
      return;
    }
    if (u === '/api/pin-state') {
      const which = get('which');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, pinned: !!PREVIEW_PINNED[which], pid: PREVIEW_PIDS[which] || 0 }));
      return;
    }
    const which = u.replace(/^\//, '').replace(/\.html$/, '');
    if (PREVIEW_APPS[which]) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(previewShellHtml(which));
      return;
    }
    res.writeHead(404); res.end('not found');
  });
  // ★ 2026-09-26：同机多壳（dev 工作台 + 安装版）时端口只能被一个占住 —— 占不到就**安静退让**，
  //   别抛未捕获的 EADDRINUSE（那会弹「DSH 引擎 出错」框，实测被多开实例触发过）。
  previewServer.on('error', function (e) {
    log('[preview] 端口 ' + PREVIEW_PORT + ' 没占上（' + ((e && e.code) || e) + '）⇒ 本实例不提供预览包装页，'
      + '由已在跑的那个壳提供');
    previewServer = null;
  });
  previewServer.listen(PREVIEW_PORT, '127.0.0.1', function () {
    log('[preview] 预览包装页服务已就绪: http://127.0.0.1:' + PREVIEW_PORT + '/parent（教师端 /teacher）');
  });
}
// .bat 的浏览器查找顺序：Edge(x86) → Edge → Chrome → Chrome(x86) → Chrome(用户级)
function findBrowser() {
  const cands = [
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft\\Edge\\Application\\msedge.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft\\Edge\\Application\\msedge.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Google\\Chrome\\Application\\chrome.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Google\\Chrome\\Application\\chrome.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe')
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (e) { /* ignore */ } }
  return '';
}
ipcMain.handle('oa:appWindow', (e, which) => {
  try {
    const app = PREVIEW_APPS[String(which)];
    if (!app) return { ok: false, err: '未知的预览端：' + which };
    const exe = findBrowser();
    if (!exe) return { ok: false, err: '没找到 Edge / Chrome，请先装一个浏览器' };
    startPreviewServer();   // 包装页服务：窗口内容走本地页（含 📌 置顶按钮）
    const prof = path.join(PREVIEW_ROOT, 'data', String(which));
    try { if (!fs.existsSync(prof)) fs.mkdirSync(prof, { recursive: true }); } catch (ex) { /* 目录建不了也让浏览器自己试 */ }
    const args = [
      '--app=http://127.0.0.1:' + PREVIEW_PORT + '/' + String(which),
      '--window-size=400,830',
      '--window-position=' + app.x + ',' + app.y,
      '--user-data-dir=' + prof,
      '--no-first-run', '--no-default-browser-check',
      '--disable-features=Translate,msEdgeSidebarV2,msEdgeBingSidebar',
      '--hide-crash-restore-bubble', '--disable-sync'
    ];
    const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    // ★ 2026-09-23 记住 pid：置顶开关要用它找窗口
    PREVIEW_PIDS[which] = child.pid;
    // 重新打开 = 新窗口：置顶状态还原成"没置顶"，由包装页按钮重新决定
    PREVIEW_PINNED[which] = false;
    return { ok: true, name: app.name, url: app.url, exe: path.basename(exe), pid: child.pid };
  } catch (ex) {
    return { ok: false, err: String((ex && ex.message) || ex) };
  }
});

// ★ 2026-09-23 「置顶预览窗口」核心：按 pid 找窗口句柄，调 user32.SetWindowPos 切 HWND_TOPMOST/NOTOPMOST。
// 为什么用 powershell：Node 里没有现成的 Win32 绑定；不引第三方依赖，调系统 PowerShell 一行脚本最稳。
// 失败场景（返回 ok:false 但不算崩溃）：窗口已关（pid 无效）、或窗口还没有可见句柄（正在启动）。
// 两个入口共用：① 包装页按钮 → 本地 /api/pin；② IPC oa:appWindow:pin（保留，面板侧万一要用）。
function doPinPreview(which, wantPin) {
  return new Promise(function (resolve) {
    try {
      const app = PREVIEW_APPS[String(which)];
      if (!app) return resolve({ ok: false, err: '未知的预览端：' + which });
      const pid = PREVIEW_PIDS[String(which)];
      if (!pid) return resolve({ ok: false, err: '还没打开过' + app.name + '预览' });
      const ps = [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        `Add-Type @'
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr lp);
}
'@
$found = [IntPtr]::Zero
$cb = [W+EnumWindowsProc]{ param($h, $lp)
  $p = 0
  [W]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null
  if ($p -eq $env:pid) { $script:found = $h; return $false }
  return $true
}
[W]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
if ($script:found -eq [IntPtr]::Zero) { Write-Output 'NO_WINDOW'; exit 0 }
$top = if ($env:want -eq '1') { [IntPtr]-1 } else { [IntPtr]-2 }
$r = [W]::SetWindowPos($script:found, $top, 0, 0, 0, 0, 0x0001 -bor 0x0002 -bor 0x0040)
Write-Output ($(if ($r) { 'OK' } else { 'FAIL' }))`
      ];
      const { execFile } = require('child_process');
      execFile('powershell.exe', ps, { windowsHide: true, timeout: 12000, env: Object.assign({}, process.env, { pid: String(pid), want: wantPin ? '1' : '0' }) },
        (err, stdout) => {
          const out = String(stdout || '').trim();
          if (err && !out) return resolve({ ok: false, err: '置顶失败（powershell 未响应）' });
          if (out.indexOf('NO_WINDOW') >= 0) return resolve({ ok: false, err: '预览窗口已关闭（重新打开再置顶）' });
          if (out.indexOf('OK') < 0) return resolve({ ok: false, err: '置顶失败（窗口句柄未就绪？）' });
          PREVIEW_PINNED[String(which)] = wantPin;
          return resolve({ ok: true, pinned: wantPin, pid: pid });
        });
    } catch (ex) {
      return resolve({ ok: false, err: String((ex && ex.message) || ex) });
    }
  });
}
ipcMain.handle('oa:appWindow:pin', (e, which, on) => doPinPreview(which, !!on));
ipcMain.handle('oa:appWindow:pinState', (e, which) => ({ ok: true, pinned: !!PREVIEW_PINNED[String(which)], pid: PREVIEW_PIDS[String(which)] || 0 }));

// ---- AI 助手权限：读代码 / 改代码 / 同步 开关 + 确认模式（ask 写入同步确认｜auto 全自动｜strict 全确认） ----
const AI_PERM_DEFAULTS = { read: true, write: true, sync: true, confirmMode: 'ask' };
function getAiPermissions() {
  const p = Object.assign({}, AI_PERM_DEFAULTS);
  try {
    const raw = oaStore.getConfig('ai.permission');
    if (raw) Object.assign(p, JSON.parse(raw));
  } catch (e) { /* 忽略坏配置 */ }
  return p;
}
function saveAiPermissions(p) {
  const clean = {
    read: !!(p && p.read), write: !!(p && p.write), sync: !!(p && p.sync),
    confirmMode: p && ['ask', 'auto', 'strict'].indexOf(p.confirmMode) >= 0 ? p.confirmMode : 'ask'
  };
  oaStore.setConfig('ai.permission', JSON.stringify(clean));
  return clean;
}
ipcMain.handle('oa:ai:perms', () => getAiPermissions());
ipcMain.handle('oa:ai:perms:set', (e, p) => saveAiPermissions(p || {}));

// ---- AI 代码修改（安全边界：仅 backend/ 与 web/ 源码；禁止 .env；写入前自动备份到 D 盘 data/oa-code-backups） ----
const OA_CODE_ROOTS = ['backend', 'web'];
const OA_CODE_BACKUP_DIR = path.join(__dirname, 'data', 'oa-code-backups');
function resolveOaCodePath(rel) {
  const root = oaStore.getConfig('oa.path.local') || '<资料库>';
  const r = String(rel || '').replace(/^[\\/]+/, '').replace(/\\/g, '/');
  if (!r || r === '.' || r.startsWith('..') || r.indexOf('/../') >= 0 || r.indexOf('\0') >= 0) return null;
  const seg = r.split('/')[0];
  if (OA_CODE_ROOTS.indexOf(seg) < 0) return null;
  const rootRes = path.resolve(root);
  const full = path.resolve(root, r);
  if (full !== rootRes && !full.startsWith(rootRes + path.sep)) return null;
  if (/(^|[\\/])\.env($|\.)/.test(full)) return null;
  return full;
}
ipcMain.handle('oa:code:read', (e, rel) => {
  if (!getAiPermissions().read) return { ok: false, err: 'AI 读取代码权限已关闭（请在 AI 助手面板的权限开关里开启）' };
  const full = resolveOaCodePath(rel);
  if (!full) return { ok: false, err: '路径不允许：仅可读写 backend/ 与 web/ 源码，禁止 .env' };
  try {
    const content = fs.readFileSync(full, 'utf8');
    return { ok: true, rel: String(rel), path: full, lines: content.split('\n').length, content };
  } catch (ex) {
    return { ok: false, err: '读取失败：' + String((ex && ex.message) || ex) };
  }
});
ipcMain.handle('oa:code:write', (e, rel, content) => {
  if (!getAiPermissions().write) return { ok: false, err: 'AI 修改代码权限已关闭（请在 AI 助手面板的权限开关里开启）' };
  const full = resolveOaCodePath(rel);
  if (!full) return { ok: false, err: '路径不允许：仅可读写 backend/ 与 web/ 源码，禁止 .env' };
  const body = String(content == null ? '' : content);
  const newLines = body.split('\n').length;
  try {
    let backupRel = null;
    if (fs.existsSync(full)) {
      const orig = fs.readFileSync(full, 'utf8');
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const safeName = String(rel).replace(/[\\/]+/g, '__');
      backupRel = ts + '__' + safeName;
      fs.mkdirSync(OA_CODE_BACKUP_DIR, { recursive: true });
      fs.writeFileSync(path.join(OA_CODE_BACKUP_DIR, backupRel), orig, 'utf8');
    }
    fs.writeFileSync(full, body, 'utf8');
    oaStore.addLog('info', 'code', 'AI 修改文件 ' + rel + '（新 ' + newLines + ' 行）' + (backupRel ? '，已备份' : '（新建）'));
    return { ok: true, rel: String(rel), path: full, lines: newLines, backup: backupRel };
  } catch (ex) {
    return { ok: false, err: '写入失败：' + String((ex && ex.message) || ex) };
  }
});
ipcMain.handle('oa:backups', (e, limit) => oaStore.listBackups(limit));
ipcMain.handle('oa:action:list', () => oaStore.listActions());
ipcMain.handle('oa:action:run', (e, id) => runOaAction(id));
ipcMain.handle('oa:shell:exec', (e, cmd) => runOaShell(cmd));
ipcMain.handle('oa:shell:history', (e, limit) => oaStore.getShellHistory(limit));
// ---- 助手→SSH 终端可见通道：助手把命令写入 inbox，SSH 面板拾取后走与手动输入相同的执行路径，结果回写 outbox ----
const AGENT_INBOX = path.join(__dirname, 'data', 'agent-shell-inbox.jsonl');
const AGENT_OUTBOX = path.join(__dirname, 'data', 'agent-shell-outbox.jsonl');
const agentReadLines = (f) => {
  try {
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
};
const agentWriteLines = (f, arr) => {
  try { fs.writeFileSync(f, arr.map(x => JSON.stringify(x)).join('\n') + (arr.length ? '\n' : ''), 'utf8'); } catch (e) { }
};
ipcMain.handle('oa:agent:dequeue', () => {
  const lines = agentReadLines(AGENT_INBOX);
  if (!lines.length) return null;
  const first = lines[0];
  agentWriteLines(AGENT_INBOX, lines.slice(1)); // 取出即移除，防重复执行
  return { seq: String(first.seq || ''), cmd: String(first.cmd || '') };
});
ipcMain.handle('oa:agent:ack', (e, r) => {
  if (!r || !r.seq) return false;
  const arr = agentReadLines(AGENT_OUTBOX);
  arr.push({ seq: String(r.seq), ok: !!r.ok, out: String(r.out || ''), err: String(r.err || ''), ts: Date.now() });
  agentWriteLines(AGENT_OUTBOX, arr);
  return true;
});
ipcMain.handle('oa:config:get', (e, key) => oaStore.getConfig(key));
ipcMain.handle('oa:config:set', (e, key, value) => oaStore.setConfig(key, value));
ipcMain.handle('oa:ssh:status', () => {
  const cfg = oaSsh.getConfig();
  return {
    ready: oaSsh.isReady(),
    connected: oaSsh.isReady(),
    host: cfg.host,
    user: cfg.user,
    port: cfg.port,
    auth: cfg.auth,
    passwordSet: cfg.passwordSet,
    passwordEnv: cfg.envSource,
    lastError: oaStatusError
  };
});

// ================= OA 运维：上下文收集 / 系统提示 / 动作执行 / 终端执行 =================
// 只读 oa-store（D 盘 data/oa.db），绝不含任何股票数据；接入真实 SSH 后采集器把真实数据写入 oa.db。
function collectOaContext() {
  const st = oaStore.getStatus();
  const logs = oaStore.getLogs(12);
  const web = oaStore.listWebSites();
  const bks = oaStore.listBackups(5);
  const urls = oaUrls();
  const syncBrief = oaSyncCache && oaSyncCache.ok
    ? oaSyncCache.mappings.map(m => ({ label: m.label, status: m.status, inSync: m.inSync, pushTotal: m.pushTotal, pullTotal: m.pullTotal }))
    : null;
  // 最近一次真实日志抓取（后端 + nginx 各取末尾若干行），供 AI 按需诊断
  const realLogs = {};
  if (oaLogsCache && oaLogsCache.sources) {
    if (oaLogsCache.sources.backend) realLogs.backend = oaLogsCache.sources.backend.slice(-15);
    if (oaLogsCache.sources.nginx) realLogs.nginx = oaLogsCache.sources.nginx.slice(-15);
    if (oaLogsCache.sources['nginx-error'] && oaLogsCache.sources['nginx-error'].length) realLogs['nginx-error'] = oaLogsCache.sources['nginx-error'].slice(-15);
    if (oaLogsCache.sources.mysql && oaLogsCache.sources.mysql.length) realLogs.mysql = oaLogsCache.sources.mysql.slice(-15);
  }
  return {
    connected: oaStore.sshConnected(),
    host: oaStore.getConfig('ssh.host'),
    user: oaStore.getConfig('ssh.user'),
    port: oaStore.getConfig('ssh.port'),
    backupStrategy: oaStore.getConfig('backup.strategy'),
    status: st,
    logs: logs,
    web: web,
    backups: bks,
    urls: urls,
    sync: syncBrief,
    realLogs: realLogs
  };
}

// <客户>教务 OA 项目内置信息（与项目 README/云控台一致；作为助手对项目的固有认知）
function oaProjectBrief() {
  const localRoot = oaStore.getConfig('oa.path.local') || '<资料库>';
  const code = oaStore.getConfig('oa.path.code') || '/opt/langchen_oa';
  const www = oaStore.getConfig('oa.path.www') || '/var/www';
  return [
    '【项目】<客户>教务内部管理系统（<客户>教育 OA）',
    '- 端：Web 管理后台（Vue3 + Element Plus + Vite + Pinia）；教师移动端 App（uni-app）；家长移动端 App（uni-app）',
    '- 后端：Node.js + Express + JWT；数据库 MySQL 8.0；部署 Nginx 反向代理 + HTTPS + pm2（应用名 langchen-oa，端口 3000）',
    '- 角色权限硬隔离：超级管理员 / 教务专员 / 授课教师',
    '- 功能边界：教务管理与教学管理；不含财务/报销/人事/采购/收费/家长端功能',
    '- 账号由后台手动创建，禁止自助注册',
    '- 本地代码：' + localRoot + '；云端代码：' + code + '；站点目录：' + www + '（admin/teacher/parent 三个站点）',
    '- 同步映射（本地 ↔ 云端）：后端 ' + localRoot + '\\backend ↔ ' + code + '/backend；管理后台 ' + localRoot + '\\web\\dist ↔ ' + www + '/admin；教师端/家长端 H5 构建产物 ↔ ' + www + '/teacher|parent（与云控台 push/pull 增量同步一致，排除 node_modules/.git/dist/.env/*.log）',
    '- 运维：pm2 管理后端进程（重启/日志），nginx 管理三个站点，MySQL 8.0 数据库备份'
  ].join('\n');
}

// OA 助手系统提示（像普通对话一样自由；项目背景仅供参考，不设束缚性规则）
function buildOaSystem(c) {
  const L = [];
  L.push('你是用户「<客户>教务内部管理系统」（<客户>教育 OA）项目的专职维护与更新助手。本项目是你在本对话中的长期职责：帮用户维护、排查、修改、同步这个项目的代码、数据与部署。项目源码在本机 ' + (oaStore.getConfig('oa.path.local') || '<资料库>') + '（全部在 D/E 盘，绝不碰 C 盘）。');
  L.push('你可以像普通对话一样自由聊天、帮忙分析问题、给出建议、协助改代码，不必拘泥于运维话术。');
  L.push('下面是该项目（<客户>教育 OA）的背景信息与当前状态，回答项目相关问题时可作参考。');
  L.push('');
  L.push(oaProjectBrief());
  L.push('');
  // 项目主上下文（oa-context.md）：自动注入，助手直接掌握项目全貌，无需临时翻文件
  try {
    const ctxPath = path.join(__dirname, 'scenarios', 'oa-context.md');
    if (fs.existsSync(ctxPath)) {
      const ctx = fs.readFileSync(ctxPath, 'utf8').trim();
      if (ctx) {
        L.push('【项目速查（自动注入）】');
        L.push(ctx);
        L.push('');
      }
    }
  } catch (e) { }
  if (c.connected) {
    L.push('【连接状态】已接入真实服务器 ' + (c.host || '') + (c.user ? '（' + c.user + '@' + (c.host || '') + '）' : ''));
  } else {
    L.push('【连接状态】尚未接入真实服务器，当前为演示数据；回答时如实说明，并可给出接入真实数据后应执行的检查步骤。');
  }
  const st = c.status;
  if (st) {
    L.push('【服务器】' + (st.host || '未知') + ' · ' + (st.os || '') + ' · 运行 ' + (st.uptime || '') +
      ' · CPU ' + (st.cpu != null ? st.cpu + '%' : '--') + ' / 内存 ' + (st.mem != null ? st.mem + '%' : '--') +
      ' / 磁盘 ' + (st.disk != null ? st.disk + '%' : '--'));
    if (Array.isArray(st.services) && st.services.length) {
      L.push('【服务状态】' + st.services.map(s =>
        s.name + ' ' + (s.ok ? '✓' : '✗') + (s.state ? '(' + s.state + ')' : '')).join('；'));
    }
  }
  if (Array.isArray(c.urls) && c.urls.length) {
    L.push('【相关网址】' + c.urls.map(u => u.name + ' ' + u.url).join('；'));
  }
  if (Array.isArray(c.web) && c.web.length) {
    L.push('【网页状态(实时探测)】' + c.web.map(w => w.name + ' ' + w.url + ' [' + w.status + (w.note ? ' ' + w.note : '') + ']').join('；'));
  }
  if (Array.isArray(c.logs) && c.logs.length) {
    L.push('【最近操作日志(最近 ' + c.logs.length + ' 条)】');
    c.logs.slice(0, 10).forEach(l => L.push('- ' + (l.ts || '').slice(5, 16) + ' [' + l.level + '] ' + l.msg));
  }
  if (c.realLogs && (c.realLogs.backend || c.realLogs.nginx || c.realLogs['nginx-error'] || c.realLogs.mysql)) {
    L.push('【真实日志(最近一次抓取的末尾片段)】');
    if (c.realLogs.backend && c.realLogs.backend.length) {
      L.push('— 后端(pm2 langchen-oa)：');
      c.realLogs.backend.slice(-12).forEach(x => L.push('  ' + x));
    }
    if (c.realLogs['nginx-error'] && c.realLogs['nginx-error'].length) {
      L.push('— Nginx 错误：');
      c.realLogs['nginx-error'].slice(-8).forEach(x => L.push('  ' + x));
    }
    if (c.realLogs.nginx && c.realLogs.nginx.length) {
      L.push('— Nginx 访问(最近 ' + Math.min(8, c.realLogs.nginx.length) + ' 条)：');
      c.realLogs.nginx.slice(-8).forEach(x => L.push('  ' + x));
    }
    if (c.realLogs.mysql && c.realLogs.mysql.length) {
      L.push('— MySQL：');
      c.realLogs.mysql.slice(-8).forEach(x => L.push('  ' + x));
    }
    L.push('（日志由窗口4实时抓取缓存；如需更完整日志，可让用户在窗口2执行 tail/pm2 logs 查看）');
  }
  if (Array.isArray(c.sync) && c.sync.length) {
    L.push('【本地↔云端同步(最近一次比对)】' + c.sync.map(s =>
      s.label + ' ' + (s.inSync ? '已同步' : ('待同步 推送' + (s.pushTotal || 0) + '/拉取' + (s.pullTotal || 0)))).join('；'));
  }
  if (Array.isArray(c.backups) && c.backups.length) {
    L.push('【数据库备份】最近：' + c.backups.slice(0, 3).map(b => b.name + ' ' + (b.size || '')).join('、') +
      (c.backupStrategy ? '；策略：' + c.backupStrategy : ''));
  }
  L.push('');
  L.push('回答时自然、直接、友好，用简体中文；涉及项目实时数据时以上面给出的信息为准，不确定就如实说明不确定，不要编造。');
  L.push('');
  L.push('如果你需要修改项目代码或执行本地↔云端同步，可以用下面的工具语法，系统会自动执行并在对话里展示结果（写入与同步前会请用户确认）：');
  L.push('- 读取文件：[工具 read:backend/src/xxx.js]');
  L.push('- 修改文件：[工具 write:backend/src/xxx.js] 后紧跟一个代码块 ```js 完整新内容 ```（每次一个文件，输出完整内容）');
  L.push('- 同步：[工具 sync:push:backend] / [工具 sync:pull:backend]');
  L.push('只允许 backend/ 与 web/ 下的源码文件，禁止 .env；写入前系统会自动备份原文件到 D 盘 data/oa-code-backups/。');
  return L.join('\n');
}

// 执行一键操作（当前为演示：记录到操作日志；接入真实 SSH 后改为远程执行）
// 执行一键操作：已配置 SSH → 真实远程执行；否则演示模式（记录到操作日志）
async function runOaAction(id) {
  const a = oaStore.getAction(id);
  if (!a) return { ok: false, err: '未知操作: ' + id };
  if (oaSsh.isReady()) {
    const r = await oaSsh.exec(a.cmd);
    oaStore.addLog('info', 'action', '执行操作「' + a.name + '」：' + a.cmd + (r && r.ok ? '' : '（失败：' + ((r && r.err) || '未知') + '）'));
    return {
      ok: !!(r && r.ok), id: a.id, name: a.name, cmd: a.cmd, danger: !!a.danger, demo: false,
      out: (r && r.out) || '', err: (r && r.err) || '',
      result: (r && r.ok) ? '已通过 SSH 执行：' + a.cmd : '执行失败：' + ((r && r.err) || '未知错误')
    };
  }
  oaStore.addLog('info', 'action', '执行操作「' + a.name + '」：' + a.cmd + '（演示模式）');
  return {
    ok: true, id: a.id, name: a.name, cmd: a.cmd, danger: !!a.danger, demo: true,
    result: '演示模式：已记录到操作日志。接入真实服务器后该操作将经 SSH 执行。'
  };
}

// 终端执行：已配置 SSH → 真实远程执行；否则演示模式（常见命令给模拟输出并记录）
async function runOaShell(cmd) {
  const c = String(cmd || '').trim();
  if (!c) return { ok: false, err: '空命令' };
  if (oaSsh.isReady()) {
    const r = await oaSsh.exec(c);
    oaStore.addShell(c, (r && (r.out || r.err)) || '');
    oaStore.addLog('info', 'shell', '执行命令：' + c + (r && r.ok ? '' : '（失败：' + ((r && r.err) || '未知') + '）'));
    return { ok: !!(r && r.ok), cmd: c, out: (r && r.out) || '', err: (r && r.err) || '', demo: false };
  }
  const lc = c.toLowerCase();
  let out = '';
  if (/^(uptime|w)$/.test(lc)) {
    out = ' 10:24:01 up 36 days,  4:12,  2 users,  load average: 0.23, 0.31, 0.27';
  } else if (lc.indexOf('df') === 0) {
    out = 'Filesystem      Size  Used Avail Use% Mounted on\n/dev/vda1        80G   46G   34G  58% /data';
  } else if (lc.indexOf('free') === 0) {
    out = '              total        used        free      shared  buff/cache   available\nMem:           7.8G        3.2G        1.1G        210M        3.5G        4.2G';
  } else if (lc.indexOf('systemctl status') === 0) {
    out = '● oa-app.service - OA Application (gunicorn)\n   Loaded: loaded (/etc/systemd/system/oa-app.service; enabled)\n   Active: active (running) since Tue 2026-08-03 06:00:12 UTC; 36 days ago';
  } else if (lc.indexOf('ls') === 0) {
    out = 'config/  logs/  app.py  settings.py  requirements.txt  .env  deploy.sh';
  } else if (lc.indexOf('cat ') === 0) {
    out = '（演示模式）未接入真实服务器，无法读取远程文件内容。';
  } else {
    out = '（演示模式）命令已记录：' + c + '\n接入真实服务器后将通过 SSH 执行并返回真实输出。';
  }
  oaStore.addShell(c, out);
  oaStore.addLog('info', 'shell', '执行命令：' + c);
  return { ok: true, cmd: c, out: out, demo: true };
}


ipcMain.handle('stock:watch:set', (e, code, name) => stockStore.setWatch(code, name));
ipcMain.handle('stock:watch:list', () => stockStore.listWatch());
ipcMain.handle('stock:watch:remove', (e, code) => stockStore.removeWatch(code));
ipcMain.handle('stock:pos:set', (e, code, name, shares, cost) => stockStore.setPosition(code, name, shares, cost));
ipcMain.handle('stock:pos:list', () => stockStore.listPositions());
ipcMain.handle('stock:pos:update', (e, code, patch) => stockStore.updatePosition(code, patch));
ipcMain.handle('stock:pos:remove', (e, code) => stockStore.removePosition(code));
// ---- 交易（同花顺口径：费用 / 摊薄成本 / T+1 / 已实现盈亏）----
ipcMain.handle('stock:trade:buy', (e, code, name, shares, price) => stockStore.buyStock(code, name, shares, price));
ipcMain.handle('stock:trade:sell', (e, code, name, shares, price) => stockStore.sellStock(code, name, shares, price));
ipcMain.handle('stock:trade:close', (e, code, price) => stockStore.closePosition(code, price));
ipcMain.handle('stock:trade:list', (e, limit) => stockStore.listTrades(limit));
ipcMain.handle('stock:trade:stats', () => stockStore.tradeStats());
// 费率设置（佣金/印花税/过户费）
ipcMain.handle('stock:fee:get', () => stockStore.getFeeConfig());
ipcMain.handle('stock:fee:set', (e, patch) => stockStore.setFeeConfig(patch));
ipcMain.handle('stock:quote:cache', (e, code, payload) => stockStore.cacheQuote(code, payload));
ipcMain.handle('stock:quote:latest', (e, code) => stockStore.latestQuote(code));
ipcMain.handle('stock:kline:cache', (e, code, period, payload) => stockStore.cacheKline(code, period, payload));
ipcMain.handle('stock:kline:latest', (e, code, period) => stockStore.latestKline(code, period));
// ---- 板块每日快照（趋势看板历史数据：按 市场+日期 存当天各板块行情概况）----
ipcMain.handle('stock:sector:daily:set', (e, market, date, snapshots) => {
  // snapshots = { sectorId: { avg, up, down, quotes } }
  if (!snapshots || typeof snapshots !== 'object') return { ok: false };
  Object.keys(snapshots).forEach(sid => {
    try { stockStore.cacheSectorDaily(market, date, sid, snapshots[sid]); } catch (ex) { /* 单条失败不影响整体 */ }
  });
  return { ok: true, n: Object.keys(snapshots).length };
});
ipcMain.handle('stock:sector:daily:get', (e, market, date) => stockStore.getSectorDaily(market, date));
ipcMain.handle('stock:sector:daily:history', (e, market, sectorId, limit) => stockStore.listSectorDaily(market, sectorId, limit));
// ---- 账户 / 总资产（现金、资产快照）----
ipcMain.handle('stock:acct:init', (e, amount) => stockStore.initCash(amount));
ipcMain.handle('stock:acct:cash', () => stockStore.getCash());
ipcMain.handle('stock:acct:account', () => stockStore.getAccount());
ipcMain.handle('stock:acct:set-total', (e, amount) => stockStore.setTotalAsset(amount));
ipcMain.handle('stock:acct:set-cash', (e, amount) => stockStore.setCash(amount));
ipcMain.handle('stock:acct:adjust', (e, delta) => stockStore.adjustCash(delta));
ipcMain.handle('stock:acct:snapshot', (e, snap) => stockStore.addAssetSnapshot(snap));
ipcMain.handle('stock:acct:snapshots', (e, limit) => stockStore.listAssetSnapshots(limit));

// ---- 股票助手：运行 Python 数据脚本（akshare / baostock）----
const PYTHON = '<盘根>:\\software\\yuyanhuanjing\\python\\python.exe';
ipcMain.handle('stock:script:run', (e, script) => new Promise((resolve) => {
  if (!script || typeof script !== 'string') return resolve({ ok: false, out: '', err: '脚本为空' });
  // 用 utf-8 环境变量避免中文乱码
  const env = Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' });
  const proc = spawn(PYTHON, ['-c', script], { env, windowsHide: true });
  let out = '', err = '';
  proc.stdout.on('data', d => { out += String(d); });
  proc.stderr.on('data', d => { err += String(d); });
  const timer = setTimeout(() => { proc.kill(); resolve({ ok: false, out, err: err + '\n[超时 30s 已终止]' }); }, 30000);
  proc.on('close', code => {
    clearTimeout(timer);
    resolve({ ok: code === 0, out, err });
  });
  proc.on('error', ex => {
    clearTimeout(timer);
    resolve({ ok: false, out, err: String(ex && ex.message || ex) });
  });
}));

// ---- 股票助手：真实行情（腾讯行情接口，批量 0.5s 级）----
ipcMain.handle('stock:quote:realtime', (e, codes) => new Promise((resolve) => {
  const list = Array.isArray(codes) ? codes.filter(c => typeof c === 'string' && c) : [];
  if (!list.length) return resolve({ ok: true, quotes: {} });
  const script = `
import json, requests, concurrent.futures
def conv(code):
    code = str(code).strip().upper()
    if code.endswith('.SH'): return 'sh' + code[:-3]
    if code.endswith('.SZ'): return 'sz' + code[:-3]
    if code.isdigit():
        return ('sh' if code[0] in '569' else 'sz') + code
    if code.startswith('US'): return 'us' + code[2:]   # 美股：qt.gtimg.cn 要求 usAAPL（代码保持大写）
    if code.startswith('HK'): return 'hk' + code[2:]
    if code.startswith(('SH','SZ')): return code.lower()
    return 'us' + code
codes = [conv(c) for c in "__CODES__"]
H = {'User-Agent': 'Mozilla/5.0'}
def fetch(batch):
    url = 'https://qt.gtimg.cn/q=' + ','.join(batch)
    r = requests.get(url, timeout=8, headers=H)
    r.encoding = 'gbk'
    out = {}
    for line in r.text.strip().split(';'):
        if '=' not in line: continue
        sym = line.split('=')[0].strip()
        if sym.startswith('v_'): sym = sym[2:]
        parts = line.split('=')[1].strip().strip('"').split('~')
        if len(parts) > 45:
            out[sym] = {
                'name': parts[1], 'price': parts[3], 'preclose': parts[4],
                'open': parts[5], 'chg': parts[31], 'pct': parts[32],
                'high': parts[33], 'low': parts[34],
                'vol': parts[36], 'amount': parts[37], 'turn': parts[38],
                'mcap': parts[45],
                'bid': [[parts[9+2*k], parts[10+2*k]] for k in range(5)],
                'ask': [[parts[19+2*k], parts[20+2*k]] for k in range(5)]
            }
    return out
batches = [codes[i:i+60] for i in range(0, len(codes), 60)]
out = {}
with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
    for r in ex.map(fetch, batches):
        out.update(r)
print(json.dumps({'ok': True, 'quotes': out}, ensure_ascii=False))
`;
  const env = Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' });
  const proc = spawn(PYTHON, ['-c', script.replace('"__CODES__"', JSON.stringify(list))], { env, windowsHide: true });
  let out = '', err = '';
  proc.stdout.on('data', d => { out += String(d); });
  proc.stderr.on('data', d => { err += String(d); });
  const timer = setTimeout(() => { proc.kill(); resolve({ ok: false, quotes: {}, err: err + '\n[超时 15s]' }); }, 15000);
  proc.on('close', () => {
    clearTimeout(timer);
    try {
      const data = JSON.parse(out.trim().split('\n').pop());
      resolve(data);
    } catch (ex) {
      resolve({ ok: false, quotes: {}, err: out + err });
    }
  });
  proc.on('error', ex => {
    clearTimeout(timer);
    resolve({ ok: false, quotes: {}, err: String(ex && ex.message || ex) });
  });
}));

// ---- K线缓存的时效判定（★2026-10-15 加）----
// 原来缓存命中只看"非空"⇒ 日/周/月K 一旦写过就**永不回源**（实测 660 行 day 缓存里 633 行早于当天），
// 打开老票看到的是几天前的K线，选股器「波段启动」的 60 日位置 / 距 MA20 也跟着算错。
// 规则：① 缓存里最后一根K线的日期 ≥ "最近一个应当已有K线的交易日" ⇒ 新鲜；
//       ② 这一行缓存本身是今天写的（今天已经问过上游，它就给到这儿）⇒ 也算新鲜，避免节假日/停牌反复白拉。
function bjDayStr(offsetDays) {
  const d = new Date(Date.now() + 8 * 3600e3 - (offsetDays || 0) * 86400e3);
  return d.toISOString().slice(0, 10);
}
function expectedBarDate() {
  const bj = new Date(Date.now() + 8 * 3600e3);
  const hm = bj.getUTCHours() * 100 + bj.getUTCMinutes();
  const isDay = (x) => x.getUTCDay() >= 1 && x.getUTCDay() <= 5;
  let d = new Date(bj.getTime());
  if (!isDay(d) || hm < 930) d = new Date(d.getTime() - 86400e3);   // 今天还没开盘（或本来不是交易日）⇒ 从昨天起找
  for (let i = 0; i < 7 && !isDay(d); i++) d = new Date(d.getTime() - 86400e3);
  return d.toISOString().slice(0, 10);
}
function klineCacheFresh(cached) {
  if (!cached || !cached.ok || !cached.kline || !cached.kline.length) return false;
  const last = cached.kline[cached.kline.length - 1];
  const lastDay = String((last && last[0]) || '');
  if (lastDay && lastDay >= expectedBarDate()) return true;
  return String(cached._ts || '').slice(0, 10) === bjDayStr(0);
}

// ---- K线历史数据（腾讯接口：日/周/月 K + 当日分时），供 K线图表面板 ----
// 持久缓存：先读 data/market.db 的 kline_cache（按 code+period），命中直接返回；
// 未命中才请求腾讯接口，成功后写入缓存，下次秒开。
ipcMain.handle('stock:kline:history', (e, code, period, count, force) => new Promise((resolve) => {
  const sym = String(code || '').trim();
  if (!sym) return resolve({ ok: false, err: 'empty code' });
  const per = ['day', 'week', 'month'].includes(period) ? period : 'day';
  const cnt = Math.max(10, Math.min(500, Number(count) || 120));
  // 1) 先读本地持久缓存（分时周期 force=true 强制拉最新：分时只在当天有效）
  const cached = stockStore.latestKline(sym, per);
  if (!force && klineCacheFresh(cached)) {
    // 分时只在当天有效，缓存里有则带上；没有则置空由前端重取
    return resolve(cached);
  }
  // 2) 未命中 → 请求腾讯接口
  // 代码转腾讯格式：600519 -> sh600519；000001.SH -> sh000001；美股 AAPL -> usAAPL
  let tk = sym.toUpperCase();
  if (tk.endsWith('.SH')) tk = 'sh' + tk.slice(0, -3);
  else if (tk.endsWith('.SZ')) tk = 'sz' + tk.slice(0, -3);
  else if (/^\d+$/.test(tk)) tk = (tk[0] === '6' || tk[0] === '9' ? 'sh' : 'sz') + tk;
  else if (/^(SH|SZ|HK)\d+/.test(tk)) tk = tk.toLowerCase();   // 已带 A股/港股前缀(如 SH600519)
  else tk = 'us' + tk;   // 纯字母美股 ticker（SHOP/USB 等以 sh/us 开头也是美股）
  const fq = 'qfq';   // 前复权
  const script = `
import json, requests
# tk 已由 Node 侧转成腾讯格式（sh600519 / usAAPL），这里不再二次转换
# （之前 conv() 会把小写转大写，腾讯接口大小写敏感导致 K线永远拉空）
sym = '${tk}'
H = {'User-Agent': 'Mozilla/5.0'}
out = {'ok': True, 'code': sym, 'kline': [], 'minute': None, 'date': None}
try:
    # 日/周/月 K 线（前复权）。主域名偶发 501 反爬（返回 JS 跳转页 → json() 抛错），
    # 自动换备用域名 proxy.finance.qq.com 重试（接口路径一致，返回结构相同）
    host = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get'
    fallback = 'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/fqkline/get'
    node = {}
    for u in [host, fallback]:
        try:
            url = '%s?param=%s,%s,,,%d,%s' % (u, sym, '${per}', ${cnt}, '${fq}')
            d = requests.get(url, timeout=8, headers=H).json()
            node = d.get('data', {}).get(sym, {})
            if isinstance(node, dict) and node:
                break
            node = {}
        except Exception:
            node = {}
    if isinstance(node, dict):
        key = 'qfq%s' % '${per}' if 'qfq%s' % '${per}' in node else '${per}'
        out['kline'] = node.get(key, [])
except Exception as ex:
    out['err'] = str(ex)[:200]
try:
    # 当日分时（data.data 才是数组，data.date 是日期）
    u2 = 'https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=%s' % sym
    m = requests.get(u2, timeout=8, headers=H).json()
    node2 = m.get('data', {}).get(sym, {})
    if isinstance(node2, dict):
        inner = node2.get('data', {})
        if isinstance(inner, dict):
            out['minute'] = inner.get('data', [])
            out['date'] = inner.get('date', '')
except Exception as ex:
    out['minute'] = None
print(json.dumps(out, ensure_ascii=False))
`;
  const env = Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' });
  const proc = spawn(PYTHON, ['-c', script], { env, windowsHide: true });
  let out = '', err = '';
  proc.stdout.on('data', d => { out += String(d); });
  proc.stderr.on('data', d => { err += String(d); });
  const timer = setTimeout(() => { proc.kill(); resolve({ ok: false, err: err + '\n[超时 12s]' }); }, 12000);
  proc.on('close', () => {
    clearTimeout(timer);
    try {
      const data = JSON.parse(out.trim().split('\n').pop());
      // 3) 成功后写入持久缓存（kline 非空才写）
      if (data && data.ok && data.kline && data.kline.length) {
        try { stockStore.cacheKline(sym, per, data); } catch (ex) { /* 缓存失败不影响返回 */ }
      }
      resolve(data);
    }
    catch (ex) { resolve({ ok: false, err: out + err }); }
  });
  proc.on('error', ex => {
    clearTimeout(timer);
    resolve({ ok: false, err: String(ex && ex.message || ex) });
  });
}));

// ---- 批量日K线（选股器打分用）：优先读缓存，未命中并发拉腾讯，返回 { ok, data: { code: kline } } ----
ipcMain.handle('stock:kline:batch', (e, codes, count) => new Promise((resolve) => {
  const list = (Array.isArray(codes) ? codes : []).filter(c => typeof c === 'string' && /^[\w.\-]+$/.test(c)).slice(0, 24);
  if (!list.length) return resolve({ ok: false, data: {} });
  const cnt = Math.max(30, Math.min(180, Number(count) || 120));
  const out = {};
  const need = [];
  list.forEach(code => {
    const cached = stockStore.latestKline(code, 'day');
    // ★2026-10-15：批量路径也要判时效 —— 这里喂的是选股器打分（超跌反弹 / 波段启动的均线、60 日位置），
    //   原来只要求"≥40 根"就算命中 ⇒ 拿到几天前的K线照算，特征全是旧的。
    if (cached && cached.kline && cached.kline.length >= 40 && klineCacheFresh(cached)) out[code] = cached.kline;
    else need.push(code);
  });
  if (!need.length) return resolve({ ok: true, data: out, fromCache: true });
  const tks = need.map(code => {
    let tk = String(code).toUpperCase();
    if (tk.endsWith('.SH')) tk = 'sh' + tk.slice(0, -3);
    else if (tk.endsWith('.SZ')) tk = 'sz' + tk.slice(0, -3);
    else if (/^\d+$/.test(tk)) tk = (tk[0] === '6' || tk[0] === '9' ? 'sh' : 'sz') + tk;
    else if (/^(SH|SZ|HK)\d+/.test(tk)) tk = tk.toLowerCase();
    else tk = 'us' + tk;
    return tk;
  });
  const script = `
import json, requests, concurrent.futures
H = {'User-Agent': 'Mozilla/5.0'}
TKS = ${JSON.stringify(tks)}
CNT = ${cnt}
def fetch(tk):
    # 主域名偶发 501 反爬 → 自动换备用域名重试（2026-09-18）
    hosts = ['https://web.ifzq.gtimg.cn/appstock/app/fqkline/get',
             'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/fqkline/get']
    for u in hosts:
        try:
            url = '%s?param=%s,day,,,%d,qfq' % (u, tk, CNT)
            d = requests.get(url, timeout=8, headers=H).json()
            node = d.get('data', {}).get(tk, {})
            if isinstance(node, dict):
                k = node.get('qfqday') or node.get('day') or []
                if k:
                    return (tk, k)
        except Exception:
            pass
    return (tk, [])
with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
    raw = dict(ex.map(fetch, TKS))
print(json.dumps(raw, ensure_ascii=False))
`;
  const env = Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' });
  const proc = spawn(PYTHON, ['-c', script], { env, windowsHide: true });
  let outp = '', errs = '';
  proc.stdout.on('data', d => { outp += String(d); });
  proc.stderr.on('data', d => { errs += String(d); });
  const timer = setTimeout(() => { proc.kill(); resolve({ ok: false, data: out, err: errs + ' [batch超时]' }); }, 15000);
  proc.on('close', () => {
    clearTimeout(timer);
    try {
      const raw = JSON.parse(outp.trim().split('\n').pop());
      Object.keys(raw).forEach((tk, i) => {
        const code = need[i];
        if (raw[tk] && raw[tk].length) {
          out[code] = raw[tk];
          try { stockStore.cacheKline(code, 'day', { ok: true, code: tk, kline: raw[tk], minute: [], date: '' }); } catch (ex) { /* ignore */ }
        }
      });
      resolve({ ok: true, data: out });
    } catch (ex) { resolve({ ok: false, data: out, err: String(ex && ex.message || ex) }); }
  });
  proc.on('error', ex => { clearTimeout(timer); resolve({ ok: false, data: out, err: String(ex && ex.message || ex) }); });
}));

// ---- 全市场排名（东方财富 clist：涨幅榜/跌幅榜双向扫描）----
// 供选股器使用：情绪（涨跌家数/涨停数）、超跌反弹（60日跌幅榜）、波段启动（涨幅榜）。
// 返回 { ok, type, list: [{code,name,price,pct,chg,vol,turn,mcap,totalMcap}], ts }
ipcMain.handle('stock:market:rank', (e, opts) => new Promise((resolve) => {
  // type: up|down（今日涨跌幅方向）；sort: 'pct'（默认，按今日涨跌幅）| 'r60'（按 60 日涨跌幅）
  const o = Object.assign({ type: 'down', pages: 2, sort: 'pct' }, opts || {});
  // ★ 2026-09-21 字段勘误（实测东财 clist，fltt=2）：
  //   f24 = 60 日涨跌幅（百分比，如 -56.68 即 -56.68%），与腾讯日K实算 60 日涨跌幅 24/25 只精确吻合 → 「超跌」必须用它；
  //   f22 ≠ 60 日涨跌幅（多数标的恒为 0，全市场极值仅 ±2%），旧代码用 f22 且再乘 100，
  //      导致「60日 -11%」实际是 -0.11%，超跌反弹引擎的「超跌深度」从根上就是假的。
  //   fltt=2 已返回百分比，禁止再乘 100。
  const fields = 'f12,f14,f2,f3,f4,f5,f6,f8,f9,f10,f15,f16,f17,f18,f20,f21,f23,f24,f25,f62';
  // 已移除 f22：它常被误当成"60日涨跌幅"，实测多数标的恒为 0、全市场极值仅 ±2%，无用。
  // f15 = 当日最高价（用于判定"是否封在涨停板上"，见下方 atLimit）
  // 排序方向由服务端 po 参数决定：po=1 降序 / po=0 升序
  // 注意：之前恒用 po=1，导致"跌幅榜"实际返回的是涨幅榜，超跌反弹引擎拿到错误数据。
  // 东财对极简 UA（Mozilla/5.0）会直接断连，必须用完整浏览器 UA + 重试
  const byR60 = o.sort === 'r60';
  const sort = byR60 ? 'f24' : 'f3';
  // 按 60 日排序时：永远取"跌得最深"的一批（升序），与 up/down 无关
  const order = byR60 ? 'asc' : (o.type === 'up' ? 'desc' : 'asc');
  const po = byR60 ? '0' : (o.type === 'up' ? '1' : '0');
  // 缓存键带上排序维度，避免两种榜单互相覆盖
  const cacheKey = byR60 ? 'r60' : String(o.type || 'down');
  const script = `
import json, requests, concurrent.futures, time
H = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/<IP> Safari/537.36',
     'Referer': 'https://quote.eastmoney.com/',
     'Accept': '*/*', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
     'Connection': 'keep-alive'}
FIELDS = '${fields}'
# 东财会对部分入口域名直接断连（push2 实测 RemoteDisconnected）→ 多域名依次重试，任一可用即可
HOSTS = ['push2.eastmoney.com', 'push2delay.eastmoney.com', '82.push2.eastmoney.com']
def fetch(page):
    for host in HOSTS:
        url = ('https://%s/api/qt/clist/get?pn=%d&pz=60&po=${po}&np=1&fltt=2&invt=2'
               '&fid=%s&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23&fields=%s') % (host, page, '${sort}', FIELDS)
        # ★2026-10-16：东财被 WAF 掐时是**秒断**（实测 3 个域名各 ~0.4s 就 RemoteDisconnected），
        #   而这里原来"每域名重试 2 次 + 每次 sleep 1 秒 + 逐页串行"⇒ pages=4 的 60 日榜必然跑满
        #   外层 20 秒超时，面板就一直显示「⏳ 扫描中…」（用户截图里就是这个状态）。
        #   现改成：每域名只试一次、sleep 0.2、**多页并行** ⇒ 东财不通时 ~1 秒就返回空、立刻走新浪兜底。
        for attempt in range(1):
            try:
                r = requests.get(url, timeout=6, headers=H)
                diff = (r.json().get('data') or {}).get('diff', []) or []
                if diff:
                    return diff
            except Exception:
                pass
            time.sleep(0.2)
    return []
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as _ex:
    pages = list(_ex.map(fetch, range(1, ${Math.max(1, o.pages || 2)} + 1)))
rows = []
for pg in pages:
    for d in pg:
        code = d.get('f12') or ''
        if not code: continue
        try:
            price = float(d.get('f2') if d.get('f2') not in (None, '-') else 0)
        except Exception: price = 0
        try:
            pct = float(d.get('f3') if d.get('f3') not in (None, '-') else 0)
        except Exception: pct = 0
        try:
            # f24 = 60日涨跌幅，fltt=2 下已是百分比数值（-56.68 即 -56.68%），不可再乘 100
            r60 = float(d.get('f24') if d.get('f24') not in (None, '-') else 0)
        except Exception: r60 = 0
        try:
            mv = float(d.get('f62')) if d.get('f62') not in (None, '-') else 0
        except Exception:
            mv = 0
        try:
            hi = float(d.get('f15') if d.get('f15') not in (None, '-') else 0)
        except Exception: hi = 0
        # 涨停识别：涨跌幅上限随板块不同（主板 10% / 创业板·科创板 20% / 北交所 30% / **ST 5%**），
        # 用固定 9.8% 一刀切会把 20% 限制板上的 +11% 误判成"已封板买不进"。
        # ★2026-10-15 补 ST 分支：mkt-fallback.py 的 limit_pct() 早就有 ST=5%，两边口径必须一致
        #   （否则同一只 ST 票在主通道与兜底通道下 atLimit/分档 会不一样）。
        _nm = str(d.get('f14') or '')
        lim = 5.0 if ('ST' in _nm.upper() or '退' in _nm) else (30.0 if code[:2] in ('43', '83', '87', '92') else (20.0 if code[:3] in ('300', '301', '688', '689') else 10.0))
        # price == high 即"当前价即当日最高"（封在板上 / 或最高价回落前的高点），10 元股容差约 0.03%
        atLimit = bool(hi > 0 and price >= hi * 0.9997 and pct >= lim * 0.92)
        rows.append({
            'code': code, 'name': d.get('f14') or '', 'price': price, 'pct': pct,
            'chg': d.get('f4'), 'vol': d.get('f5'), 'amount': d.get('f6'),
            'turn': d.get('f8'), 'mcap': d.get('f20'), 'r60': r60,
            'high': hi, 'limitPct': lim, 'atLimit': atLimit,
            'high52': d.get('f15'), 'low52': d.get('f16'),
            'main': mv
        })
# 本地二次排序（接口已排序，但保险）：按 r60 时以 60 日涨跌幅升序
if '${byR60 ? 'r60' : order}' == 'r60':
    rows.sort(key=lambda x: x['r60'])
elif '${order}' == 'asc':
    rows.sort(key=lambda x: x['pct'])
else:
    rows.sort(key=lambda x: x['pct'], reverse=True)
print(json.dumps({'ok': True, 'type': '${o.type}', 'list': rows, 'ts': __import__('time').time()}, ensure_ascii=False))
`;
  const env = Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' });
  const proc = spawn(PYTHON, ['-c', script], { env, windowsHide: true });
  let out = '', err = '';
  proc.stdout.on('data', d => { out += String(d); });
  proc.stderr.on('data', d => { err += String(d); });
  const timer = setTimeout(() => {
    proc.kill();
    // 超时：回退到本地缓存（避免接口限流时白屏）
    const cached = stockStore.latestRank(cacheKey);
    if (cached && cached.list && cached.list.length) {
      resolve(Object.assign({ ok: true, fromCache: true }, cached));
    } else {
      resolve({ ok: false, list: [], err: err + '\n[超时 20s]' });
    }
  }, 20000);
  proc.on('close', () => {
    clearTimeout(timer);
    try {
      const data = JSON.parse(out.trim().split('\n').pop());
      if (data.ok && data.list && data.list.length) {
        try { stockStore.cacheRank(cacheKey, { list: data.list, ts: data.ts }); } catch (ex) { /* ignore */ }
      } else {
        // 拉取失败但缓存有 → 用缓存
        const cached = stockStore.latestRank(cacheKey);
        if (cached && cached.list && cached.list.length) {
          return resolve(Object.assign({ ok: true, fromCache: true }, cached));
        }
      }
      resolve(data);
    } catch (ex) {
      const cached = stockStore.latestRank(cacheKey);
      if (cached && cached.list && cached.list.length) {
        resolve(Object.assign({ ok: true, fromCache: true }, cached));
      } else {
        resolve({ ok: false, list: [], err: out + err });
      }
    }
  });
  proc.on('error', ex => {
    clearTimeout(timer);
    const cached = stockStore.latestRank(cacheKey);
    if (cached && cached.list && cached.list.length) {
      resolve(Object.assign({ ok: true, fromCache: true }, cached));
    } else {
      resolve({ ok: false, list: [], err: String(ex && ex.message || ex) });
    }
  });
}));

// ---- 插件 / 模型 面板（只读；数据全部来自项目文件夹，核心原则：不落 C 盘） ----
const PLUGINS_DIR = path.join(HARNESS_DIR, '插件');
const DSH_DATA_DIR = path.join(HARNESS_DIR, '.dsh');
const SETTINGS_PATH = path.join(DSH_DATA_DIR, 'settings.yaml');

// 已安装插件清单：扫描 dsh 项目的「插件」目录（每个子目录一个插件，含 package.json 元信息）
ipcMain.handle('plugins:list', () => {
  const out = {
    pluginsDir: PLUGINS_DIR,
    dataDir: DSH_DATA_DIR,
    plugins: [],
    builtinDir: path.join(HARNESS_DIR, 'packages'),
    builtinCount: 0
  };
  try {
    if (fs.existsSync(PLUGINS_DIR)) {
      for (const d of fs.readdirSync(PLUGINS_DIR)) {
        const dir = path.join(PLUGINS_DIR, d);
        let st = null;
        try { st = fs.statSync(dir); } catch (e) { continue; }
        if (!st.isDirectory()) continue;   // 跳过 开发约定.md 等文件
        let name = d, version = null, description = '';
        const pkgPath = path.join(dir, 'package.json');
        if (fs.existsSync(pkgPath)) {
          try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            name = pkg.name || d;
            version = pkg.version || null;
            description = pkg.description || '';
          } catch (e) { /* 忽略坏 JSON */ }
        }
        const plugin = { name, displayName: d, version, description, path: dir };
        // 插件自身的 缓存/ 与 配置/ 目录（展示本地化数据位置）
        for (const sub of ['缓存', 'data', 'cache']) {
          const sp = path.join(dir, sub);
          try { if (fs.statSync(sp).isDirectory()) { plugin.cacheDir = sp; break; } } catch (e) { /* ignore */ }
        }
        for (const sub of ['配置', 'config']) {
          const sp = path.join(dir, sub);
          try { if (fs.statSync(sp).isDirectory()) { plugin.configDir = sp; break; } } catch (e) { /* ignore */ }
        }
        out.plugins.push(plugin);
      }
    }
    // 内置插件包数量（packages/client + packages/host 下的包）
    let n = 0;
    for (const base of [path.join(HARNESS_DIR, 'packages', 'client'), path.join(HARNESS_DIR, 'packages', 'host')]) {
      try {
        n += fs.readdirSync(base).filter(x => { try { return fs.statSync(path.join(base, x)).isDirectory(); } catch (e) { return false; } }).length;
      } catch (e) { /* ignore */ }
    }
    out.builtinCount = n;
  } catch (e) { /* ignore */ }
  return out;
});

// ---- 技能（Skill）清单：扫描 DSH 技能根目录 ----
// 约定来源 @deepseek-ai/dsh-skill-filesystem：
//   用户级 <dshHome>/skills（本机 = <工作台>\引擎\.dsh\skills）
//   项目级 <项目根>/.dsh/skills 与 <项目根>/.agents/skills
//   自定义 settings.yaml 的 customSkillDirs
// 技能格式（只在根目录顶层被发现）：<名字>/SKILL.md 目录包，或 <名字>.md 单文件；
// SKILL.md 顶部 YAML frontmatter 必需 name + description，可选 whenToUse 等。
const SKILLS_DIR = path.join(DSH_DATA_DIR, 'skills');

// 极简 frontmatter 解析：只取 --- 块里的 name / description / whenToUse（其余字段忽略）
function parseSkillFrontmatter(text) {
  const meta = {};
  const m = String(text || '').match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return meta;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let val = kv[2].trim();
    val = val.replace(/^["']|["']$/g, '').replace(/\s+#.*$/, '').trim();
    if (key === 'name' || key === 'description' || key === 'whenToUse') meta[key] = val;
  }
  return meta;
}

// 读取一个技能（目录包或单文件），返回目录条目
function readSkill(file, dirPath, format) {
  const entry = {
    name: '', description: '', whenToUse: '',
    file: file, dir: dirPath, format: format, valid: false, error: ''
  };
  try {
    const text = fs.readFileSync(file, 'utf8');
    const meta = parseSkillFrontmatter(text);
    entry.name = meta.name || '';
    entry.description = meta.description || '';
    entry.whenToUse = meta.whenToUse || '';
    const st = fs.statSync(file);
    entry.mtime = st.mtimeMs;
    entry.size = st.size;
    if (!entry.name || !entry.description) {
      entry.error = 'frontmatter 缺少 name 或 description（引擎会丢弃该技能）';
    } else {
      entry.valid = true;
    }
  } catch (e) {
    entry.error = '读取失败：' + (e && e.message || e);
  }
  return entry;
}

ipcMain.handle('skills:list', () => {
  const out = { skillsDir: SKILLS_DIR, roots: [], skills: [] };
  // 扫描根：用户级 + 项目级（工作台所在目录）+ 自定义目录
  const roots = [
    { source: 'user-dsh', rank: 400, dir: SKILLS_DIR },
    { source: 'project-dsh', rank: 100, dir: path.join(__dirname, '.dsh', 'skills') },
    { source: 'project-agents', rank: 200, dir: path.join(__dirname, '.agents', 'skills') }
  ];
  for (const r of roots) {
    let exists = false;
    try { exists = fs.statSync(r.dir).isDirectory(); } catch (e) { exists = false; }
    out.roots.push({ source: r.source, rank: r.rank, dir: r.dir, exists: exists });
    if (!exists) continue;
    let names = [];
    try { names = fs.readdirSync(r.dir); } catch (e) { continue; }
    for (const n of names) {
      if (n === '.system' || n === '.git' || n.startsWith('_') || n.startsWith('.')) continue;   // 跳过系统/说明目录
      const full = path.join(r.dir, n);
      let st = null;
      try { st = fs.statSync(full); } catch (e) { continue; }
      if (st.isDirectory()) {
        const entryFile = path.join(full, 'SKILL.md');
        if (!fs.existsSync(entryFile)) continue;   // 目录包必须有 SKILL.md
        const entry = readSkill(entryFile, full, 'bundle');
        if (!entry.name) entry.name = n;
        entry.source = r.source;
        out.skills.push(entry);
      } else if (st.isFile() && /\.md$/i.test(n)) {
        const entry = readSkill(full, r.dir, 'flat');
        if (!entry.name) entry.name = n.replace(/\.md$/i, '');
        entry.source = r.source;
        out.skills.push(entry);
      }
    }
  }
  // 优先级高（rank 小）的排前面；同名去重，保留优先级高的
  out.skills.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const seen = {};
  out.skills = out.skills.filter(s => {
    const key = String(s.name || '').toLowerCase();
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  });
  return out;
});

// 打开技能目录 / 打开单个技能正文（系统默认程序）
ipcMain.handle('skills:open', (e, target) => {
  const p = target ? String(target) : SKILLS_DIR;
  try { if (fs.existsSync(p)) { shell.openPath(p); return { ok: true, path: p }; } } catch (ex) { /* ignore */ }
  return { ok: false, err: '路径不存在：' + p };
});

// ---- 设置：读取 / 打开 Harness 配置文件（.dsh/settings.yaml + .credentials.yaml，凭据脱敏）----
const CREDENTIALS_PATH = path.join(DSH_DATA_DIR, '.credentials.yaml');
ipcMain.handle('settings:list', () => {
  const out = { settingsPath: SETTINGS_PATH, credentialsPath: CREDENTIALS_PATH, files: {} };
  try { if (fs.existsSync(SETTINGS_PATH)) out.files.settings = fs.readFileSync(SETTINGS_PATH, 'utf8'); } catch (e) { /* ignore */ }
  try {
    if (fs.existsSync(CREDENTIALS_PATH)) {
      let t = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
      // 脱敏：把行尾 12+ 位长的值（密钥/token）打码，保留短配置项
      t = t.replace(/(:\s*)(["']?)([A-Za-z0-9_\-.]{12,})(["']?)(\s*(#.*)?)$/gm, '$1$2••••••（已隐藏）$4$5');
      out.files.credentials = t;
    }
  } catch (e) { /* ignore */ }
  return out;
});
ipcMain.handle('settings:open', (e, which) => {
  const f = which === 'credentials' ? CREDENTIALS_PATH : SETTINGS_PATH;
  if (fs.existsSync(f)) {
    try { shell.openPath(f); return { ok: true }; } catch (ex) { return { ok: false, err: ex.message }; }
  }
  return { ok: false, err: '文件不存在' };
});

// ---- 余额实时显示：DeepSeek 平台余额（API 密钥只留在主进程，渲染层永远拿不到明文）----
// 数据源优先级：① 「余额显示」插件（引擎侧 GET /plugins/deepseek-balance/balance）
//               ② 插件未加载/不可用时回退主进程直连 https://api.deepseek.com/user/balance
// 点击余额打开 https://platform.deepseek.com/usage
const BALANCE_URL = 'https://api.deepseek.com/user/balance';
const BALANCE_PLUGIN_URL = BASE + '/plugins/deepseek-balance/balance';
const BALANCE_PAGE = 'https://platform.deepseek.com/usage';
const BALANCE_INTERVAL = 10000;   // 每 10 秒刷新一次
let balanceTimer = null;
let lastBalance = null;
let balanceVia = '';              // 最近一次取数来源：plugin / direct

// 首选：走「余额显示」插件；插件未加载时返回 null（由调用方回退直连）
function fetchBalanceViaPlugin() {
  return new Promise(function (resolve) {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const req = http.get(BALANCE_PLUGIN_URL, { timeout: 8000 }, function (res) {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', function (d) { data += d; });
      res.on('end', function () {
        try {
          const j = JSON.parse(data || '{}');
          if (j && j.ok) {
            return finish({
              ok: true, ts: j.ts || Date.now(), isAvailable: !!j.isAvailable,
              currency: j.currency || 'CNY', total: j.total,
              granted: j.granted, toppedUp: j.toppedUp
            });
          }
        } catch (e) { /* 非 JSON → 视为插件不可用 */ }
        finish(null);   // 插件返回失败 → 交给直连路径
      });
    });
    req.on('timeout', function () { req.destroy(); finish(null); });
    req.on('error', function () { finish(null); });
  });
}

// 解析 DeepSeek 密钥：优先 .dsh/.credentials.yaml 的 refs.DEEPSEEK_API_KEY，其次环境变量
function readDeepseekKey() {
  try {
    const cred = path.join(DSH_DATA_DIR, '.credentials.yaml');
    if (fs.existsSync(cred)) {
      const m = fs.readFileSync(cred, 'utf8').match(/DEEPSEEK_API_KEY:\s*(\S+)/);
      if (m && m[1]) return m[1].replace(/^["']|["']$/g, '');
    }
  } catch (e) { /* ignore */ }
  return process.env.DEEPSEEK_API_KEY || '';
}

async function fetchDeepseekBalance() {
  // ① 优先「余额显示」插件（引擎侧实现，插件未加载时静默回退）
  try {
    const viaPlugin = await fetchBalanceViaPlugin();
    if (viaPlugin) { balanceVia = 'plugin'; return viaPlugin; }
  } catch (e) { /* 回退直连 */ }
  balanceVia = 'direct';

  const key = readDeepseekKey();
  if (!key) return { ok: false, err: '未配置 DEEPSEEK_API_KEY', ts: Date.now() };
  const ctl = new AbortController();
  const to = setTimeout(() => { try { ctl.abort(); } catch (e) { /* ignore */ } }, 15000);
  try {
    const res = await fetch(BALANCE_URL, {
      headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' },
      signal: ctl.signal
    });
    clearTimeout(to);
    if (!res.ok) return { ok: false, err: 'HTTP ' + res.status, ts: Date.now() };
    const j = await res.json();
    const list = Array.isArray(j && j.balance_infos) ? j.balance_infos : [];
    const info = list.find(function (x) { return x && x.currency === 'CNY'; }) || list[0];
    if (!info) return { ok: false, err: '响应无余额信息', ts: Date.now() };
    return {
      ok: true, ts: Date.now(), isAvailable: !!(j && j.is_available),
      currency: info.currency || 'CNY',
      total: info.total_balance, granted: info.granted_balance, toppedUp: info.topped_up_balance
    };
  } catch (ex) {
    clearTimeout(to);
    const msg = (ex && ex.name === 'AbortError') ? '请求超时' : (ex && ex.message || String(ex));
    return { ok: false, err: msg, ts: Date.now() };
  }
}

function pushBalance(v) {
  lastBalance = v;
  try {
    // 余额要发全部窗口：分离出去的场景窗口也显示余额条
    try { broadcast('balance:update', v); } catch (e) { /* ignore */ }
  } catch (e) { /* ignore */ }
  return v;
}

function startBalancePoll() {
  if (balanceTimer) clearInterval(balanceTimer);
  const tick = async function () { pushBalance(await fetchDeepseekBalance()); };
  tick();
  balanceTimer = setInterval(tick, BALANCE_INTERVAL);
}

ipcMain.handle('balance:get', async () => lastBalance || await fetchDeepseekBalance());
ipcMain.handle('balance:refresh', async () => pushBalance(await fetchDeepseekBalance()));

// ============ 手机远程访问（dsh-plugin-remote-access）============
// 数据源：插件路由 /plugins/remote-access/*（插件内部放行 loopback 调用，故主进程可直接取）
const REMOTE_BASE = BASE + '/plugins/remote-access';

/** 向远程访问插件发一个请求；asBuffer=true 时保留原始 Buffer（取 PNG 二维码）。 */
function remoteAccessHttp(method, urlPath, asBuffer) {
  return new Promise(function (resolve) {
    let u;
    try { u = new URL(REMOTE_BASE + urlPath); } catch (e) { return resolve({ status: 0, error: '地址无效' }); }
    let done = false;
    const finish = function (v) { if (!done) { done = true; resolve(v); } };
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: method, timeout: 15000
    }, function (res) {
      const chunks = [];
      res.on('data', function (d) { chunks.push(d); });
      res.on('end', function () {
        const buf = Buffer.concat(chunks);
        finish({ status: res.statusCode, buf: buf, text: asBuffer ? '' : buf.toString('utf8') });
      });
    });
    req.on('timeout', function () { req.destroy(); finish({ status: 0, error: '请求超时' }); });
    req.on('error', function (e) { finish({ status: 0, error: e.message }); });
    req.end();
  });
}

ipcMain.handle('remoteAccess:status', async () => {
  const r = await remoteAccessHttp('GET', '/status');
  try { return JSON.parse(r.text); } catch (e) { return { ok: false, error: r.error || ('HTTP ' + r.status) }; }
});

ipcMain.handle('remoteAccess:qr', async () => {
  const r = await remoteAccessHttp('GET', '/qr.png', true);
  return (r.status === 200 && r.buf && r.buf.length)
    ? ('data:image/png;base64,' + r.buf.toString('base64'))
    : '';
});

// 引导第一步用的静态图：手机 WireGuard 配置二维码
ipcMain.handle('remoteAccess:guideImage', async () => {
  try {
    const p = path.join(HARNESS_DIR, '插件', '手机远程访问', 'runtime', '手机导入.png');
    if (fs.existsSync(p)) return 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
  } catch (e) { /* 图缺失时前端会降级为文字说明 */ }
  return '';
});

ipcMain.handle('remoteAccess:action', async (e, action) => {
  if (action !== 'refresh' && action !== 'restart') return { ok: false, error: '未知操作' };
  const r = await remoteAccessHttp('POST', '/' + action);
  try { return JSON.parse(r.text); } catch (err) { return { ok: false, error: r.error || ('HTTP ' + r.status) }; }
});
// 外观：窗口底色随主题（浅色 #f5f7fa / 深色 #0b0d12），避免缩放重绘闪黑
ipcMain.handle('theme:set-window-bg', (e, color) => {
  const v = String(color || '');
  if (/^#[0-9a-fA-F]{6}$/.test(v)) {
    try { const w = windowOfEvent(e); if (w) w.setBackgroundColor(v); } catch (ex) { /* ignore */ }
  }
  return true;
});
ipcMain.handle('balance:open', () => {
  try { shell.openExternal(BALANCE_PAGE); } catch (e) { /* ignore */ }
  return true;
});

// 模型与提供方：解析**引擎真正在用的配置**
//   ★ 2026-10-15 修：旧版死读 .dsh\settings.yaml，而 0.2.1 起该文件根本不存在
//     ⇒ 弹窗必然显示「当前默认模型 —」「未发现自定义提供方」（用户报的"模型提供方不显示"）。
//   现在改为按**结构**解析（不认行号、不认固定缩进）：
//     · profiles\<名字>\cordis.patch.yml 里任意 `providers:` 块 ⇒ 每个子键一个提供方（含 models 列表）
//     · `- id: agent-default-model` / `agent-default-model:` 块 ⇒ 默认模型
//     · 密钥是否已配 = 环境变量 或 .credentials.yaml 的 refs:（引擎把密钥存这，环境变量里通常没有）
const MODEL_PATCH_FILES = () => {
  const out = [];
  try {
    const base = path.join(DSH_DATA_DIR, 'profiles');
    if (fs.existsSync(base)) {
      for (const d of fs.readdirSync(base)) {
        const p = path.join(base, d, 'cordis.patch.yml');
        if (fs.existsSync(p)) out.push(p);
      }
    }
    const top = path.join(DSH_DATA_DIR, 'cordis.patch.yml');
    if (fs.existsSync(top)) out.push(top);
    if (fs.existsSync(SETTINGS_PATH)) out.push(SETTINGS_PATH);   // 旧引擎口径，留着兼容
  } catch (e) { /* ignore */ }
  return out;
};

function parseModelConfig(text) {
  const providers = [];
  const def = {};
  const lines = String(text).split(/\r?\n/);
  let provIndent = -1;                       // providers: 的缩进，-1 = 不在块里
  let cur = null;
  let inModels = false;
  let inDef = false, defIndent = -1;
  for (const raw of lines) {
    if (/^\s*#/.test(raw)) continue;
    const line = raw.replace(/\s+#.*$/, '').replace(/\s+$/, '');
    if (!line.trim()) continue;
    const indent = (line.match(/^ */) || [''])[0].length;
    const t = line.trim();
    // 默认模型（三种写法都认：`- id: agent-default-model` ← 当前引擎实际写法 / `agent-default-model:` / `id: ...`）
    if (/^(?:-\s*)?(?:id:\s*)?agent-default-model:?\s*$/.test(t)) {
      inDef = true; defIndent = indent; provIndent = -1; cur = null; inModels = false; continue;
    }
    if (inDef) {
      if (indent <= defIndent) { inDef = false; }
      else {
        const m = t.match(/^(provider|model|reasoningEffort):\s*(.+)$/);
        if (m) def[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
        continue;
      }
    }
    if (/^providers:\s*$/.test(t)) { provIndent = indent; cur = null; inModels = false; continue; }
    if (provIndent < 0) continue;
    if (indent <= provIndent) { provIndent = -1; cur = null; inModels = false; continue; }
    if (indent === provIndent + 2 && /^[A-Za-z0-9_.\-]+:\s*$/.test(t)) {
      cur = { id: t.slice(0, -1), models: [] };
      providers.push(cur); inModels = false; continue;
    }
    if (!cur) continue;
    if (inModels) {
      const m = t.match(/^-?\s*id:\s*(.+)$/);
      if (m) cur.models.push(m[1].trim().replace(/^['"]|['"]$/g, ''));
      continue;
    }
    if (/^models:\s*$/.test(t)) { inModels = true; continue; }
    const m2 = t.match(/^(displayName|apiKeyEnv|api|baseURL):\s*(.+)$/);
    if (m2) cur[m2[1]] = m2[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return { def, providers };
}

ipcMain.handle('models:list', () => {
  const files = MODEL_PATCH_FILES();
  const out = { settingsPath: files[0] || SETTINGS_PATH, default: null, providers: [], sourceFiles: files };
  try {
    // 引擎已登记的密钥名（.credentials.yaml 的 refs: 段）
    const refs = new Set();
    try {
      if (fs.existsSync(CREDENTIALS_PATH)) {
        const ct = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
        for (const l of ct.split(/\r?\n/)) {
          const m = l.match(/^\s{2}([A-Za-z0-9_]+):/);
          if (m) refs.add(m[1]);
        }
      }
    } catch (e) { /* ignore */ }
    const def = {};
    const merged = new Map();
    for (const f of files) {
      let r;
      try { r = parseModelConfig(fs.readFileSync(f, 'utf8')); } catch (e) { continue; }
      Object.assign(def, r.def);
      for (const p of r.providers) {
        const old = merged.get(p.id);
        if (!old) { merged.set(p.id, p); continue; }
        for (const k of Object.keys(p)) {
          if (k === 'models') continue;
          if (p[k]) old[k] = p[k];
        }
        for (const m of p.models) if (old.models.indexOf(m) < 0) old.models.push(m);
      }
    }
    out.default = Object.keys(def).length ? def : null;
    out.providers = Array.from(merged.values()).map(p => ({
      id: p.id,
      displayName: p.displayName || p.id,
      apiKeyEnv: p.apiKeyEnv || null,
      apiKeySet: p.apiKeyEnv ? (!!process.env[p.apiKeyEnv] || refs.has(p.apiKeyEnv)) : false,
      baseURL: p.baseURL || null,
      models: p.models || []
    }));
  } catch (e) { /* ignore */ }
  return out;
});

// ===========================================================================
// 顶栏状态区（2026-10-16 新增：① 上下文压力灯 ② 谁在等我 ③ 快照/回滚）
//   **纯增量**：不动任何现有按钮 / IPC；渲染层在 renderer\topbar-status.js，读不到这组桥就不显示。
//   为什么放主进程：只有这里能读文件、能 spawn 脚本（渲染层没有 fs）。
// ===========================================================================
const TOPBAR_CTX = path.join(HARNESS_DIR, '.dsh', 'skills', 'context-overflow', 'ctx.mjs');
const TOPBAR_MEM = path.join(HARNESS_DIR, '场景项目信息');
const TOPBAR_CARD = path.join(__dirname, 'scenarios', 'dsh-gui-context.md');
const TOPBAR_BK = path.join(__dirname, 'data', 'backups');
const TOPBAR_ROOT = path.dirname(__dirname);   // <工作台>

// 跑 node 脚本：本体是 Electron，没有独立 node ⇒ 先试 ELECTRON_RUN_AS_NODE，失败再退回 PATH 上的 node
function topbarRun(script, args, timeout) {
  const tries = [
    { exe: process.execPath, env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }) },
    { exe: 'node', env: process.env }
  ];
  let last = '';
  for (const t of tries) {
    try {
      const r = spawnSync(t.exe, [script].concat(args || []), {
        encoding: 'utf8', windowsHide: true, timeout: timeout || 90000,
        env: t.env, maxBuffer: 16 * 1024 * 1024
      });
      const out = String(r.stdout || '') + String(r.stderr || '');
      if (r.status === 0 && String(r.stdout || '').length) return { ok: true, out: String(r.stdout) };
      last = out || ('exit ' + r.status);
    } catch (e) { last = String((e && e.message) || e); }
  }
  return { ok: false, out: last };
}

// 工作台 10 条常驻会话：sessionId → 属于哪个场景/面板（压力灯用它把裸会话名翻译成"我的哪块面板"）
function topbarWorkbenchSessions() {
  const out = [];
  try {
    const dir = path.join(__dirname, 'scenarios');
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json') || f.startsWith('_')) continue;
      let j = null;
      try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { continue; }
      for (const p of (Array.isArray(j.panels) ? j.panels : [])) {
        if (p && p.sessionId) out.push({ scene: j.title || j.id || f, panel: p.title || p.id || '', sessionId: p.sessionId });
      }
    }
  } catch (e) { /* ignore */ }
  return out;
}

// 异步版（压力灯每 90s 刷一次，**必须**用它）：⛔ spawnSync 是同步的，会把主进程连整个窗口的
// IPC/拖拽一起卡住 —— 实测 ctx.mjs --all 要 0.3s，那就是每 90 秒卡 0.3 秒。异步则零感知。
function topbarRunAsync(script, args, timeout) {
  return new Promise((resolve) => {
    const tries = [
      { exe: process.execPath, env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }) },
      { exe: 'node', env: process.env }
    ];
    let last = '';
    const attempt = (i) => {
      if (i >= tries.length) return resolve({ ok: false, out: last });
      const t = tries[i];
      let out = '', settled = false, cp = null;
      try {
        cp = spawn(t.exe, [script].concat(args || []), { windowsHide: true, env: t.env });
      } catch (e) { last = String((e && e.message) || e); return attempt(i + 1); }
      const timer = setTimeout(() => { try { cp.kill(); } catch (e) { /* ignore */ } }, timeout || 120000);
      cp.stdout.on('data', (d) => { out += d; });
      cp.stderr.on('data', (d) => { out += d; });
      cp.on('error', (e) => { if (settled) return; settled = true; clearTimeout(timer); last = String((e && e.message) || e); attempt(i + 1); });
      cp.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0 && out) resolve({ ok: true, out });
        else { last = out || ('exit ' + code); attempt(i + 1); }
      });
    };
    attempt(0);
  });
}

// ⑦ 最近打开的文件夹（Windows 自己的"最近使用"记录，只读）
//   主数据源：%APPDATA%\Microsoft\Windows\Recent\*.lnk —— Explorer 每打开一个文件/文件夹就写一条，按 .lnk 的 mtime 倒序。
//   .lnk 的目标**直接从二进制里抠**（不依赖 COM/PowerShell，快且不弹窗）：
//     先按 UTF-16LE 找 `X 00 : 00 \ 00`，再按 ANSI/GBK 找 `<盘根>:\`；抠出来用 fs 验证「存在且是目录」⇒ 自动滤掉最近打开的**文件**。
//   结果缓存 60 秒，且只在用户点开 📁 胶囊时才跑（不常驻扫盘）。
let topbarRecentCache = { at: 0, rows: [] };
function topbarLnkTarget(p) {
  let buf = null;
  try { buf = fs.readFileSync(p); } catch (e) { return null; }
  if (buf.length < 80) return null;
  const cands = [];
  try {
    for (let i = 0; i + 6 < buf.length; i++) {                       // ① UTF-16LE：X 00 : 00 \ 00
      if (buf[i + 1] === 0 && buf[i + 2] === 0x3A && buf[i + 3] === 0 && buf[i + 4] === 0x5C && buf[i + 5] === 0) {
        let end = i;
        while (end + 1 < buf.length && !(buf[end] === 0 && buf[end + 1] === 0)) end += 2;
        const s = buf.slice(i, end).toString('utf16le');
        if (s.length > 3) cands.push(s);
        i = end;
      }
    }
    for (let i = 0; i + 3 < buf.length; i++) {                       // ② ANSI / GBK：<盘根>:\
      const c = buf[i];
      if (buf[i + 1] === 0x3A && buf[i + 2] === 0x5C && ((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) {
        let end = i;
        while (end < buf.length && buf[end] !== 0 && buf[end] >= 0x20) end++;
        const seg = buf.slice(i, end);
        let s = '';
        try { s = new TextDecoder('gbk').decode(seg); } catch (e) { s = seg.toString('latin1'); }
        if (s.length > 3) cands.push(s);
        i = end;
      }
    }
  } catch (e) { /* ignore */ }
  for (const c of cands) {
    const t = String(c).replace(/\0+$/, '').trim();
    if (!/^[A-Za-z]:\\/.test(t)) continue;
    try { if (fs.existsSync(t) && fs.statSync(t).isDirectory()) return t; } catch (e) { /* ignore */ }
  }
  return null;
}
function topbarRecentFolders(limit) {
  const want = limit || 6;
  const now = Date.now();
  if (now - topbarRecentCache.at < 60000 && topbarRecentCache.rows.length) return topbarRecentCache.rows.slice(0, want);
  const cands = new Map();                       // 路径(小写) → { path, src, at }
  const add = (p, src) => {
    if (!p) return;
    const t = String(p).trim().replace(/[\u0000\s]+$/, '').replace(/\\+$/, '');
    if (!/^[A-Za-z]:\\/.test(t) || t.length > 240) return;
    let st = null;
    try { st = fs.statSync(t); } catch (e) { return; }     // 只留**真的还在**的目录（旧根路径会被自动滤掉）
    if (!st.isDirectory()) return;
    const k = t.toLowerCase();
    if (!cands.has(k)) cands.set(k, { path: t, src: src, at: st.mtimeMs });
  };
  // ① 主力：资源管理器跳转列表 —— 真正"最近打开过"的地方（Recent 里的 .lnk 常被清理工具删掉，所以不能只靠它）
  try {
    const ad = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Recent', 'AutomaticDestinations');
    for (const n of fs.readdirSync(ad)) {
      if (!/\.automaticDestinations-ms$/i.test(n)) continue;
      let buf = null;
      try { buf = fs.readFileSync(path.join(ad, n)); } catch (e) { continue; }
      const m = buf.toString('utf16le').match(/[A-Za-z]:\\[^\u0000-\u001f]{2,180}/g) || [];
      for (const s of m) add(s, '资源管理器最近');
    }
  } catch (e) { /* ignore */ }
  // ② 补充：%APPDATA%\…\Recent\*.lnk（系统开着"显示最近使用的文件"时才有）
  try {
    const rd = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Recent');
    for (const n of fs.readdirSync(rd)) {
      if (!/\.lnk$/i.test(n)) continue;
      add(topbarLnkTarget(path.join(rd, n)), '最近使用');
    }
  } catch (e) { /* ignore */ }
  // ③ 补充：地址栏里敲过的路径（注册表 TypedPaths，reg.exe 查一次，几十毫秒）
  try {
    const r = spawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\TypedPaths'],
      { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    for (const line of String((r && r.stdout) || '').split(/\r?\n/)) {
      const m = line.match(/REG_SZ\s+(.+)$/);
      if (m) add(m[1], '地址栏敲过');
    }
  } catch (e) { /* ignore */ }
  // 排序：按**文件夹自己的最后修改时间**从新到旧（跳转列表里没有时间戳，这是最接近"最近用过"的可靠口径）
  const rows = Array.from(cands.values()).sort((a, b) => b.at - a.at).slice(0, want);
  topbarRecentCache = { at: now, rows };
  return rows;
}
ipcMain.handle('topbar:recent-folders', () => {
  try { return { ok: true, at: Date.now(), rows: topbarRecentFolders(6) }; }
  catch (e) { return { ok: false, rows: [], error: String((e && e.message) || e) }; }
});

// ① 上下文压力：跑 ctx.mjs --panels --json（名册里的 10 面板 + 5 帮手；只回传渲染层要的字段）
//   ⛔ 必须走异步版：spawnSync 会把主进程连整个窗口一起卡住（实测 0.3s/次 × 每 90s 一次）
// 2026-10-19（宿主）：「负载胶囊」取数 —— CPU% 用 os.cpus() 差值（零子进程），GPU 用 nvidia-smi 一次读数（约 40ms）。
//   ★ 资源纪律：渲染层只在**窗口有焦点**时每 5 秒调一次 ⇒ 不在前台时这个 IPC 一次都不跑（不额外养进程/定时器）。
let __loadCpuPrev = null;
function loadCpuPercent() {
  const cpus = os.cpus() || [];
  let idle = 0, total = 0;
  for (const c of cpus) {
    const t = c.times || {};
    idle += t.idle || 0;
    total += (t.user || 0) + (t.nice || 0) + (t.sys || 0) + (t.idle || 0) + (t.irq || 0);
  }
  const prev = __loadCpuPrev;
  __loadCpuPrev = { idle, total };
  if (!prev) return null;                       // 第一次没有差值可算 ⇒ 返回 null，下次就有了
  const di = idle - prev.idle, dt = total - prev.total;
  return dt > 0 ? Math.max(0, Math.min(100, Math.round((1 - di / dt) * 100))) : null;
}
function nvidiaSmiOnce() {
  return new Promise((resolve) => {
    const exe = '<盘根>:\\Windows\\System32\\nvidia-smi.exe';
    let out = '', done = false, cp = null;
    try { cp = spawn(exe, ['--query-gpu=name,utilization.gpu,temperature.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'], { windowsHide: true }); }
    catch (e) { return resolve(null); }
    const t = setTimeout(() => { try { cp.kill(); } catch (e) { /* ignore */ } if (!done) { done = true; resolve(null); } }, 3000);
    cp.stdout.on('data', (d) => { out += d; });
    cp.stderr.on('data', () => { /* 没 N 卡会往 stderr 写，忽略 */ });
    cp.on('error', () => { if (!done) { done = true; clearTimeout(t); resolve(null); } });
    cp.on('close', () => { if (done) return; done = true; clearTimeout(t); resolve(out); });
  });
}
ipcMain.handle('kun:sys:load', async () => {
  const out = { ok: true, at: Date.now(), cpu: null, gpu: null };
  try { out.cpu = loadCpuPercent(); } catch (e) { /* ignore */ }
  // 2026-10-20（宿主：顶栏加内存）—— os.totalmem/freemem ⇒ 已用百分比 + GB（零子进程）
  try {
    const tot = os.totalmem(), free = os.freemem();
    out.mem = { usedPct: Math.round((1 - free / tot) * 100), usedGB: Math.round((tot - free) / 1073741824 * 10) / 10, totalGB: Math.round(tot / 1073741824 * 10) / 10 };
  } catch (e) { /* ignore */ }
  try {
    const raw = await nvidiaSmiOnce();
    if (raw) {
      const p = String(raw).trim().split(/\r?\n/)[0].split(',').map((s) => s.trim());
      if (p.length >= 5 && p[1] !== '' && !isNaN(Number(p[1]))) {
        out.gpu = { name: p[0], util: Number(p[1]), temp: Number(p[2]), memUsed: Number(p[3]), memTotal: Number(p[4]) };
      }
    }
  } catch (e) { /* 没 N 卡就只显示 CPU */ }
  return out;
});
// ==========================================================================================
// 2026-10-20（宿主：把常用网站的"智能抠图"做成**本地**工具）—— 本地 rembg，图片不出本机。
//   引擎在 <工作台>\工具\抠图\venv（Python + rembg + onnxruntime CPU），模型放同目录 models（U2NET_HOME）。
//   ⚠ 这两条在主进程 ⇒ 加完要**重启一次工作台**才会出现（渲染层会先显示"要重启"提示，不会白屏）。
//   资源纪律：跑一张图起一次进程，算完就退（不常驻）；模型只在第一次用时下载。
// ==========================================================================================
/* 开源版：本地抠图（IPC + Python 引擎）已移除 */
;
ipcMain.handle('topbar:pressure', async () => {
  // 2026-10-16 23:3x 按 dg-dsh 派单：取数由 --all 改成 **--panels** ——
  //   --all 有门控（只列 ≥60%），低压力会话被藏起来 ⇒ 面板/帮手匹配不上，只能显示 —；
  //   --panels 固定列 10 个面板 + 5 个帮手（不管压力高低），且带 role/panel/scene/noData/belowGate。
  const r = await topbarRunAsync(TOPBAR_CTX, ['--panels', '--json'], 120000);
  if (!r.ok) return { ok: false, error: String(r.out).slice(0, 300), rows: [], total: 0, at: Date.now() };
  let arr = null;
  try { arr = JSON.parse(r.out); } catch (e) { return { ok: false, error: 'JSON 解析失败: ' + e.message, rows: [], total: 0, at: Date.now() }; }
  if (!Array.isArray(arr)) return { ok: false, error: 'ctx.mjs 返回的不是数组', rows: [], total: 0, at: Date.now() };
  const map = new Map();
  for (const m of topbarWorkbenchSessions()) map.set(m.sessionId, m);
  // 2026-10-16 晚（按 dg-dsh 的嵌套合同）：{version,note,updated,scenes:[{scene,sceneName,panel,bossSessionId,helpers:[{title,sessionId,since,handover,note}]}]}
  //   ⛔ 不是数组、也不是顶层 {helpers:[…]}。容错：缺 scenes 但有顶层 helpers ⇒ 退化成扁平 + 留一行警告。
  const helperIds = new Set();
  const helperMeta = new Map();
  try {
    const hf = path.join(__dirname, 'data', '助手会话.json');
    if (fs.existsSync(hf)) {
      const hj = JSON.parse(fs.readFileSync(hf, 'utf8'));
      const scenes = Array.isArray(hj && hj.scenes) ? hj.scenes : null;
      const addOne = (h, sceneId, sceneName, panel) => {
        if (!h) return;
        const sid = String(h.sessionId || h.id || '');
        if (!sid) return;
        helperIds.add(sid);
        helperMeta.set(sid, { sceneId: sceneId || '', sceneName: sceneName || '', panel: panel || '',
          title: h.title || h.name || '', since: h.since || '', note: h.note || '' });
      };
      if (scenes) {
        for (const s of scenes) {
          if (!s) continue;
          const sName = s.sceneName || s.scene || '';
          for (const h of (Array.isArray(s.helpers) ? s.helpers : [])) addOne(h, s.scene || '', sName, s.panel || '');
        }
      } else if (Array.isArray(hj && hj.helpers)) {
        log('[助手会话] ⚠ 登记表缺 scenes ⇒ 退化成顶层 helpers 扁平读法（建议用 助手会话.mjs 重写一遍）');
        for (const h of hj.helpers) addOne(h, h.scene || '', h.sceneName || h.scene || '', h.panel || '');
      }
    }
  } catch (e) { log('[助手会话] 登记表读不动：' + ((e && e.message) || e)); }
  const rows = [];
  const seen = new Set();
  for (const x of arr) {
    if (!x || !x.fullId) continue;
    const m = map.get(x.fullId);
    if (!m) continue;                       // 只列工作台自己的会话（全机还有几十条别的）
    seen.add(x.fullId);
    rows.push({
      id: x.id, fullId: x.fullId, title: x.title || '',
      pct: (x.pct === null || x.pct === undefined) ? null : (x.pct || 0),   // noData ⇒ null ⇒ 渲染成 —（别假 0%）
      noData: !!x.noData, belowGate: !!x.belowGate, line: x.line || 0, win: x.win || 0,
      projected: x.projected || 0, turns: x.turns || 0, model: x.model || '', scene: m.scene, panel: m.panel
    });
  }
  rows.sort((a, b) => ((b.pct == null ? -1 : b.pct) - (a.pct == null ? -1 : a.pct)));   // 有数据的在前，—的沉底
  // ctx.mjs 只列"有 projcache 数据"的会话 ⇒ 从没用过/刚建的新会话可能不在里面；明确报出来，别让它静默消失
  const missing = [];
  for (const m of map.values()) if (!seen.has(m.sessionId)) missing.push({ scene: m.scene, panel: m.panel });
  // ① 登记表里的**每一行都要出**（哪怕引擎还没给它建用量数据）⇒ pct 取不到就给 null，渲染成 "—"
  const helpers = [];
  const byId = new Map();
  for (const x of arr) if (x && x.fullId) byId.set(String(x.fullId), x);
  for (const [sid, m] of helperMeta) {
    const x = byId.get(sid) || null;
    helpers.push({
      id: x ? x.id : '', fullId: sid, title: m.title || (x && x.title) || '',
      sceneId: m.sceneId || '', sceneName: m.sceneName || '', panel: m.panel || '',
      since: m.since || '', note: m.note || '',
      pct: x ? (x.pct || 0) : null, line: x ? (x.line || 0) : 0,
      projected: x ? (x.projected || 0) : 0, turns: x ? (x.turns || 0) : 0, model: x ? (x.model || '') : ''
    });
  }  return { ok: true, at: Date.now(), rows, total: arr.length, mine: map.size, missing, helpers, helperReg: helperIds.size };
});

// ② 谁在等我：共用定位卡 §六 未办结行 + 各场景记忆 §〇 的「卡点」
ipcMain.handle('topbar:pending', () => {
  const items = [];
  try {
    const t = fs.readFileSync(TOPBAR_CARD, 'utf8');
    const after = t.split(/\n##\s*六、/)[1];
    const seg = after ? after.split(/\n##\s*七、/)[0] : '';
    for (const line of seg.split(/\r?\n/)) {
      const s = line.trim();
      if (s.charAt(0) !== '|') continue;
      const cells = s.split('|').map((x) => x.trim()).filter((x) => x.length);
      if (cells.length < 4) continue;
      if (/^-+$/.test(cells[0]) || cells[0] === '日期') continue;   // 分隔行与表头行都不算待办
      const status = cells[cells.length - 1];
      if (/^✅/.test(status) || /已办结|已关闭|不用做/.test(status)) continue;   // 只留"真的还没办"的
      items.push({
        kind: 'card', date: cells[0], from: cells[1], status,
        text: cells[2].replace(/\*\*/g, '').replace(/\s+/g, ' ').slice(0, 220), file: TOPBAR_CARD
      });
    }
  } catch (e) { /* ignore */ }
  try {
    for (const d of fs.readdirSync(TOPBAR_MEM)) {
      const f = path.join(TOPBAR_MEM, d, '项目信息.md');
      if (!fs.existsSync(f)) continue;
      let head = '';
      try {
        const fd = fs.openSync(f, 'r');
        const b = Buffer.alloc(12000);
        const n = fs.readSync(fd, b, 0, b.length, 0);
        fs.closeSync(fd);
        head = b.slice(0, n).toString('utf8');
      } catch (e) { continue; }
      const m = head.match(/卡点[：:]\s*([^\n\r]{2,200})/);
      if (m) items.push({ kind: 'scene', date: '', from: d, status: '卡点', text: m[1].replace(/\*\*/g, '').trim(), file: f });
    }
  } catch (e) { /* ignore */ }
  return { ok: true, at: Date.now(), items };
});

// ③ 快照：列最近 12 份 / 立即打一份 / 回滚到指定那份（回滚前弹原生确认框）
ipcMain.handle('topbar:snapshots', () => {
  try {
    const names = fs.readdirSync(TOPBAR_BK)
      .filter((n) => n.indexOf('gui-') === 0 && fs.statSync(path.join(TOPBAR_BK, n)).isDirectory());
    const rows = names.map((n) => ({ name: n, at: fs.statSync(path.join(TOPBAR_BK, n)).mtimeMs, pre: n.indexOf('gui-prerestore-') === 0 }))
      .sort((a, b) => b.at - a.at);
    return { ok: true, dir: TOPBAR_BK, rows: rows.slice(0, 5), total: rows.length };
  } catch (e) { return { ok: false, error: String((e && e.message) || e), rows: [], total: 0, dir: TOPBAR_BK }; }
});
ipcMain.handle('topbar:snapshot', () => {
  const r = topbarRun(path.join(__dirname, 'scripts', 'backup-gui.mjs'), [], 180000);
  const out = String(r.out || '');
  const m = out.match(/快照完成[:：]\s*(.+)/);
  return { ok: r.ok, name: m ? m[1].trim() : null, error: r.ok ? null : out.slice(0, 300) };
});
ipcMain.handle('topbar:restore', (e, name) => {
  const n = String(name || '');
  if (!/^gui-[A-Za-z0-9._-]+$/.test(n)) return { ok: false, error: '快照名不合法' };
  if (!fs.existsSync(path.join(TOPBAR_BK, n))) return { ok: false, error: '找不到这个快照：' + n };
  let go = false;
  try {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
    const opt = {
      type: 'warning', buttons: ['回到这个界面', '取消'], defaultId: 1, cancelId: 1,
      title: '界面回退',
      message: '回到界面版本 ' + n + ' ？',
      detail: '只覆盖工作台的界面与脚本源码（main.js / preload.js / renderer\\ / scenarios\\ / scripts\\）。'
        + '回退前会先用当前界面记一份 gui-prerestore-*，还能再回来；不动数据和对话。'
    };
    go = (win ? dialog.showMessageBoxSync(win, opt) : dialog.showMessageBoxSync(opt)) === 0;
  } catch (err) { go = false; }
  if (!go) return { ok: false, error: '已取消' };
  const r = topbarRun(path.join(__dirname, 'scripts', 'restore-gui.mjs'), [n], 240000);
  const tail = String(r.out || '').trim().split(/\r?\n/).slice(-5).join(' | ');
  return { ok: r.ok, error: r.ok ? null : tail.slice(0, 400), out: tail.slice(0, 600) };
});
ipcMain.handle('topbar:engine-status', () => {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'engine-good', 'meta.json'), 'utf8'));
    return { ok: true, meta };
  } catch (e) { return { ok: false, error: '还没有“正常点”（先打一份）', meta: null }; }
});
ipcMain.handle('topbar:engine-snapshot', () => {
  const tool = path.join(TOPBAR_ROOT, '工具', '引擎快照.mjs');
  if (!fs.existsSync(tool)) return { ok: false, error: '找不到 工具\\引擎快照.mjs' };
  const r = topbarRun(tool, ['--save'], 120000);
  return { ok: r.ok, out: String(r.out || '').slice(0, 500), error: r.ok ? null : String(r.out || '').slice(0, 300) };
});
ipcMain.handle('topbar:engine-restore', () => {
  const tool = path.join(TOPBAR_ROOT, '工具', '引擎快照.mjs');
  if (!fs.existsSync(tool)) return { ok: false, error: '找不到 工具\\引擎快照.mjs' };
  let go = false;
  try {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
    const opt = {
      type: 'warning', buttons: ['回到上次正常配置', '取消'], defaultId: 1, cancelId: 1,
      title: '引擎回退', message: '回到上次能正常启动的引擎配置？',
      detail: '只回退 17 个启动配置（cordis.patch.yml / settings / 插件接线），不碰源码与构建产物。\n'
        + '回退前会把当前配置另存到 data\\engine-good\\pre-restore-*。回退后请重启工作台。'
    };
    go = (win ? dialog.showMessageBoxSync(win, opt) : dialog.showMessageBoxSync(opt)) === 0;
  } catch (err) { go = false; }
  if (!go) return { ok: false, error: '已取消' };
  const r = topbarRun(tool, ['--restore', '--yes'], 120000);
  return { ok: r.ok, out: String(r.out || '').slice(0, 600), error: r.ok ? null : String(r.out || '').slice(0, 400) };
});
// ===== 2026-10-24（宿主）：「引擎回退也能记录，上限 5 份」 =====
// 工具（工具\引擎快照.mjs）早就支持多代（--list / --restore-gen），这里只把清单翻译成结构化数据给界面。
ipcMain.handle('topbar:engine-gens', () => {
  const tool = path.join(TOPBAR_ROOT, '工具', '引擎快照.mjs');
  if (!fs.existsSync(tool)) return { ok: false, error: '找不到 工具\\引擎快照.mjs', rows: [] };
  const r = topbarRun(tool, ['--list'], 20000);
  const rows = [];
  String(r.out || '').split(/\r?\n/).forEach((ln) => {
    // 形如：- gen-20261023175458 · 2026-10-23 17:54:58 · 引擎 0.2.1-rc.2 · HEAD 687f282e
    const m = ln.match(/^-\s*(gen-\d+)\s*·\s*([^·]*?)\s*·\s*引擎\s*([^·]*?)\s*·\s*HEAD\s*(\S*)/);
    if (m) rows.push({ gen: m[1].trim(), at: m[2].trim(), ver: m[3].trim(), head: m[4].trim() });
  });
  return { ok: r.ok, rows: rows.slice(0, 5), error: r.ok ? null : String(r.out || '').slice(0, 300) };
});
ipcMain.handle('topbar:engine-restore-gen', (e, gen) => {
  const g = String(gen || '');
  if (!/^gen-\d{8,}$/.test(g)) return { ok: false, error: '这一代的编号不合法：' + g };
  const tool = path.join(TOPBAR_ROOT, '工具', '引擎快照.mjs');
  if (!fs.existsSync(tool)) return { ok: false, error: '找不到 工具\\引擎快照.mjs' };
  let go = false;
  try {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
    const opt = {
      type: 'warning', buttons: ['回到这一代配置', '取消'], defaultId: 1, cancelId: 1,
      title: '引擎回退（指定代）',
      message: '回到引擎配置 ' + g + ' ？',
      detail: '只回退启动配置（不碰源码与构建产物）。\n回退前会把当前配置另存到 data\\engine-good\\pre-restore-*。\n回退后请重启工作台。'
    };
    go = (win ? dialog.showMessageBoxSync(win, opt) : dialog.showMessageBoxSync(opt)) === 0;
  } catch (err) { go = false; }
  if (!go) return { ok: false, error: '已取消' };
  const r = topbarRun(tool, ['--restore-gen', g, '--yes'], 120000);
  return { ok: r.ok, out: String(r.out || '').slice(0, 600), error: r.ok ? null : String(r.out || '').slice(0, 400) };
});

// ===== 2026-10-24（宿主）：「升级中途不小心关闭 ⇒ 自动回滚到上次正常」 =====
// 每次启动先落一枚"这次开过、还没正常退出"的哨（clean:false）；正常退出时改写成 clean:true。
// 下次启动若发现上次 clean:false（崩溃 / 被强关 / 升级中途关掉），60 秒后探一次引擎：
//   · 引擎起来了  → 什么都不做；
//   · 引擎没起来 且 有"正常点" → 自动 引擎快照.mjs --restore --yes，并给界面推一条 toast。
// ⛔ 只回「启动配置」，不碰源码/构建产物（源码坏了要走 git，这个工具做不到，也不该自动做）。
const GUARD_FILE = path.join(__dirname, 'data', 'start-guard.json');
function readGuard() { try { return JSON.parse(fs.readFileSync(GUARD_FILE, 'utf8')); } catch (e) { return null; } }
function writeGuard(obj) { try { fs.writeFileSync(GUARD_FILE, JSON.stringify(obj, null, 2) + '\n', 'utf8'); } catch (e) { /* ignore */ } }
function engineLastGood() {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'engine-good', 'meta.json'), 'utf8'));
    return (m && m.savedAt) ? m : null;
  } catch (e) { return null; }
}
async function guardCheckAfterBoot() {
  const prev = readGuard();
  writeGuard({ clean: false, at: Date.now(), pid: process.pid, appVersion: app.getVersion(), note: '开机登记' });
  if (!prev || prev.clean !== false) return;                 // 上次是正常退出
  const good = engineLastGood();
  log('[guard] 上次没正常退出（' + (prev.at ? new Date(prev.at).toLocaleString() : '?') + '）⇒ 60 秒后查引擎');
  await sleep(60000);
  let up = false;
  try { up = await probe(); } catch (e) { up = false; }
  if (up) { log('[guard] 引擎正常，不做回退'); writeGuard({ clean: false, at: Date.now(), pid: process.pid, note: '引擎正常' }); return; }
  if (!good) { log('[guard] 引擎没起来，但还没有"正常点"，无法自动回退'); return; }
  const tool = path.join(TOPBAR_ROOT, '工具', '引擎快照.mjs');
  let ok = false;
  try {
    const r = topbarRun(tool, ['--restore', '--yes'], 120000);
    ok = !!(r && r.ok);
    log('[guard] 自动回退引擎配置 ' + (ok ? '成功' : '失败') + '：' + String((r && r.out) || '').slice(0, 200));
  } catch (e) { log('[guard] 自动回退异常：' + ((e && e.message) || e)); }
  writeGuard({ clean: false, at: Date.now(), pid: process.pid, autoRolledBack: { at: Date.now(), ok, to: good.savedAt } });
  try {
    broadcast('topbar:toast', {
      text: ok ? ('上次没正常退出、引擎也没起来 ⇒ 已自动回到 ' + good.savedAt + ' 的配置，请重启一次工作台')
               : '上次没正常退出、引擎也没起来，自动回退没成功 —— 看 server.log 或手动「引擎回退」',
      bad: !ok, ms: 20000
    });
  } catch (e2) { /* ignore */ }
}

ipcMain.handle('tools:catalog', () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'data', '工具清单.json'), 'utf8'));
  } catch (e) { return { updated: null, groups: [], error: String((e && e.message) || e) }; }
});
ipcMain.handle('topbar:open', (e, p) => {
  const f = path.resolve(String(p || ''));
  if (f.indexOf(TOPBAR_ROOT) !== 0) return { ok: false, error: '只允许打开项目根目录里的文件' };   // 白名单：别让它变成任意路径打开器
  try { shell.openPath(f); return { ok: true }; } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
});

// 选股器秒开：直接返回本地缓存的最近一次全市场排名（不发网络请求）
ipcMain.handle('stock:market:rankCached', (e, type) => stockStore.latestRank(type));

// ---- 窗口控制（自定义标题栏用）----
// ★按发起方寻址★：分离窗口上的按钮必须动它自己 —— 若仍用 mainWindow，
// 分离窗口点「关闭」会把主窗口关掉（= 整个应用退出），是这套功能里最危险的坑。
// 2026-10-20（宿主报「点最小化没反应」）—— 实测：**Electron 最大化态下 win.minimize() 偶发无效**
//   （点击到、IPC 也 resolve，但窗口不 iconic；Win32 SW_MINIMIZE 却能；unmaximize 后再 minimize 就正常）。
//   这里加一层兜底：先 minimize，300ms 后还是没最小化 ⇒ 先 unmaximize + minimize，并记住"本来是最大化"，
//   恢复（restore）时再 maximize 回去。日志写 server.log，便于以后核对。
ipcMain.handle('window:minimize', (e) => {
  const w = windowOfEvent(e) || mainWindow;
  if (!w) { log('[win] minimize: 没有窗口'); return { ok: false, err: 'no-window' }; }
  let wasMax = false;
  try { wasMax = w.isMaximized(); w.minimize(); } catch (err) {
    log('[win] minimize 抛错: ' + ((err && err.message) || err));
    return { ok: false, err: String((err && err.message) || err) };
  }
  setTimeout(function () {
    try {
      if (w.isMinimized()) {
        log('[win] minimize ok（wasMax=' + wasMax + '）');
        return;
      }
      if (!wasMax) { log('[win] minimize 之后仍未最小化（非最大化态） visible=' + w.isVisible()); return; }
      log('[win] minimize 在最大化态无效 ⇒ 退回 unmaximize + minimize');
      try {
        w.unmaximize();
        w.minimize();
        w.once('restore', function () { try { w.maximize(); } catch (e3) { /* ignore */ } });
      } catch (e2) { log('[win] 兜底也失败: ' + ((e2 && e2.message) || e2)); }
    } catch (e) { /* ignore */ }
  }, 300);
  return { ok: true };
});
ipcMain.handle('window:toggle-maximize', (e) => {
  const w = windowOfEvent(e) || mainWindow;
  if (!w) return false;
  if (w.isMaximized()) w.unmaximize();
  else w.maximize();
  return w.isMaximized();
});
ipcMain.handle('window:is-maximized', (e) => { const w = windowOfEvent(e) || mainWindow; return !!w && w.isMaximized(); });
ipcMain.handle('window:close', (e) => { const w = windowOfEvent(e) || mainWindow; if (w) w.close(); });

// ---- 多窗口（场景分离）：我是谁 / 开场景窗口 / 关自己 / 哪些场景已分离 ----
ipcMain.handle('window:info', (e) => {
  const w = windowOfEvent(e);
  const isMain = !w || w.kunRole !== 'scene';
  return {
    role: isMain ? 'main' : 'scene',
    isMain: isMain,
    scene: (w && w.kunScene) || '',
    sceneName: (w && w.kunScene) ? sceneNameOf(w.kunScene) : '',
    maximized: !!w && w.isMaximized(),
    detached: detachedSceneIds()
  };
});
ipcMain.handle('window:scenes', () => detachedSceneIds());
ipcMain.handle('window:open-scene', (e, sceneId) => openSceneWindow(sceneId));
ipcMain.handle('window:close-self', (e) => { const w = windowOfEvent(e); if (w) w.close(); return { ok: true }; });

// ---- 启动页 IPC：当前进度快照 / 失败后重试 ----
ipcMain.handle('boot:state', () => lastBoot);
let bootRunning = false;
ipcMain.handle('boot:retry', async () => {
  if (bootRunning) return { ok: false, err: '正在启动中，请稍候' };
  bootRunning = true;
  try {
    const ok = await startServer();
    if (ok) broadcast('harness:ready');   // 所有窗口都要知道引擎就绪（分离窗口也要开始加载 webview）
    return { ok: ok };
  } catch (e) {
    sendBoot({ stage: 'error', pct: 100, text: '重试失败', detail: (e && e.message) || String(e) });
    return { ok: false, err: (e && e.message) || String(e) };
  } finally {
    bootRunning = false;
  }
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', function () {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(async function () {
  // 【已移除】任务栏角标（原来显示"当前窗口数"）：2026-10-15 按用户要求删除。
  //   原因：这台机器上 Windows 的徽章层会压过应用自画的叠加图标（TaskbarBadges=1 时永远显示系统的「1」），
  //   而关掉系统徽章后应用叠加图标也一并不显示 ⇒ 「角标 = 窗口数」在 Windows 这一层做不到 ✗。
  //   想数窗口时：鼠标悬停任务栏那颗按钮，Windows 会弹出各窗口的缩略图 ✓（详见 项目信息.md §47 补3）。
    // 启动流程整体兜底：任何一步抛错都不会变成"静默打不开"——
    // 先尽力保证有一个可见窗口，再弹一次错误提示（含日志路径与回滚方法）。
    loadWinLayout();   // 上次退出时的窗口布局：主窗口位置 + 分离出去的场景窗口
    try {
      createWindow({ isMain: true, saved: layoutCache.main });
    } catch (err) {
      reportFatal('创建主窗口失败', err);
      try { createWindow({ isMain: true }); } catch (e2) { reportFatal('重试创建主窗口仍失败', e2); }
    }
    // 恢复上次分离出去的场景窗口（场景 json 可能已被删 → 校验后只开仍然存在的）
    try {
      const known = listScenarios().map(function (s) { return s.id; });
      Object.keys(layoutCache.detached).forEach(function (sid) {
        if (known.indexOf(sid) < 0) { delete layoutCache.detached[sid]; return; }
        try { createWindow({ scene: sid, saved: layoutCache.detached[sid] }); }
        catch (e) { log('[win] 恢复场景窗口失败 ' + sid + ': ' + ((e && e.message) || e)); }
      });
    } catch (err) { log('[win] 恢复场景窗口异常: ' + ((err && err.message) || err)); }
    try {
      startSiteServer();   // 个人站场景：官网静态服务（独立于 Harness）
    } catch (err) { reportFatal('启动本地静态服务失败', err); }
    try {
      startBalancePoll();  // 余额实时显示：每 10s 拉取 DeepSeek 平台余额
    } catch (err) { reportFatal('启动余额轮询失败', err); }
    let ok = false;
    try {
      ok = await startServer();
    } catch (err) {
      reportFatal('启动 Harness 引擎失败', err);
      ok = false;
    }
    if (!ok) {
      // 不再弹框退出：保留窗口，由首屏加载页显示失败态与「重试」（进度条不会空白）
      log('startServer failed — 保留窗口，等待用户重试');
      return;
    }
    log('[boot] 引擎就绪总耗时 ' + ((Date.now() - APP_T0) / 1000).toFixed(1) + 's');
    // 通知渲染层：Harness 已就绪（所有窗口的 webview 都可以加载了）
    try {
      broadcast('harness:ready');
    } catch (err) { log('[boot] 通知渲染层失败: ' + ((err && err.message) || err)); }
    // 2026-10-24：升级/崩溃保险 —— 后台跑，引擎 60 秒没起来就自动回退（不阻塞启动）
    guardCheckAfterBoot().catch(function (e) { log('[guard] 检查自身失败：' + ((e && e.message) || e)); });
  }).catch(function (err) {
    reportFatal('whenReady 启动链失败', err);
  });
  app.on('window-all-closed', function () {
    killServer();
    stopBlenderCapture();
    app.quit();
  });
  app.on('before-quit', function () {
    quitRequested = true;      // 保留"下次恢复"的布局：整体退出 ≠ 用户关掉某个场景窗口
    // 2026-10-24：正常退出 ⇒ 给保险哨子盖章（下次启动不会误判成"升级中途被关掉"）
    try { writeGuard({ clean: true, at: Date.now(), pid: process.pid }); } catch (e) { /* ignore */ }
    try { saveWinLayout(); } catch (e) { /* ignore */ }
    releaseBlenderEmbedSync();
    killServer();
    stopBlenderCapture();
  });
}

// ===== 内置网页版 AI 桥：让任何会话/脚本能“免费问顶栏那 5 个网页版”（2026-09-21 第 10 轮）=====
// 需求：会话想省钱 / API 额度用完时，把活儿外包给免费网页版（DeepSeek·豆包·通义·智谱·Kimi）。
// 链路：脚本 → POST http://127.0.0.1:31239/webai/ask → broadcast('webai:task')
//      → 渲染层 renderer\webai-bridge.js 在对应 <webview> 里输入问题、等回答 → IPC webai:done → 回包。
// 为什么这么绕：会话（引擎侧）只会跑命令，进程外只有 HTTP 进得来；而网页版是**渲染层**的 <webview>
//   （partition=persist:webai-<key>，登录态在那儿），主进程碰不到它的 DOM —— 所以必须借渲染层的手。
// 安全：只监听 127.0.0.1，不对外；claim 机制保证多窗口时只有一个窗口干活（不会问两遍）。
const WEB_AI_PORT = Number(process.env.WEB_AI_PORT || 31239);
const WEB_AI_KEYS = [
  { key: 'deepseek', name: 'DeepSeek', url: 'https://chat.deepseek.com/' },
  { key: 'doubao', name: '豆包', url: 'https://www.doubao.com/chat/' },
  { key: 'tongyi', name: '通义千问', url: 'https://tongyi.aliyun.com/qianwen/' },
  { key: 'chatglm', name: '智谱清言', url: 'https://chatglm.cn/main/alltoolsdetail' },
  { key: 'kimi', name: 'Kimi', url: 'https://www.kimi.com/' }
];   // ⚠ 这份表必须和 renderer\renderers.js 的 WEB_AI 一致（check-gui.mjs 会比对）
const webAiPending = new Map();
let webAiSeq = 0;
let lastFocusedWin = null;      // 由 createWindow 的 focus 事件维护（见上面那段注释：为什么必须定向派发）
// ★多窗口安全（v3.17，2026-09-23）★
// 每个窗口都是**独立一整套壳**（自带 preload + 渲染器 + 一份 webai-bridge.js），而分离窗口那份桥
// 只在它自己那次加载/⟳ 时才更新 —— 用户分屏常驻时它可能很久都是旧代码。旧桥的判正文逻辑是老的，
// 抢到活就把正文切错（实测：菜单墙 / 页脚 / 上一轮内容，现象像"你刚改的判据坏了"，能白查一整轮）。
// 所以派发**必须挑窗口**，三道闸：
//   闸 1：窗口加载完（did-finish-load）问一次它的桥版本；只挑**版本相等**的 ⇒ 旧桥窗口直接出局。
//   闸 2：抢单必须来自派发目标。闸 3：交卷也必须来自派发目标（旧桥不一定申报）。
const WEB_AI_BRIDGE_MIN = '3.17';               // 桥的**最低**可用版本（真正的派活基准见 WEB_AI_WANT）
const webAiWinVer = new Map();                  // webContents.id → { ver, title }
// ★2026-09-26★ 派活基准改成**动态 = 见过的最新桥版本**。
//   原来拿上面那个常量判等 ⇒ 桥一升版（今天 3.17→3.24），所有新窗口都被判成"旧桥、不再派活"，
//   现象却是"`[[peek]]` 偶尔能通、一打字必失败"，查了半天才发现是这儿 ⇒ 桥升级不该再改主进程。
let WEB_AI_WANT = WEB_AI_BRIDGE_MIN;
function webAiVerNum(v) { return String(v || '').split('.').map(function (x) { return parseInt(x, 10) || 0; }); }
function webAiVerGt(a, b) {
  const x = webAiVerNum(a), y = webAiVerNum(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); }
  return false;
}
// 派发目标：**主窗口优先**（用户 2026-09-23 定的口径：分屏时以主窗口为基准）→ 聚焦 → 最后聚焦 → 任意
// 为什么不再"聚焦优先"：分屏时焦点常在别的场景窗口上，任务就被派给那份可能很旧的桥了。
function webAiTargetWindow() {
  const E = require('electron').BrowserWindow;
  const alive = function (w) { return w && !w.isDestroyed() && w.webContents && !w.webContents.isDestroyed(); };
  const ready = function (w) {
    if (!alive(w)) return false;
    const rec = webAiWinVer.get(w.webContents.id);
    return !!rec && rec.ver === WEB_AI_WANT;   // 没申报 / 不是最新版 = 不派（基准是动态的最新版）
  };
  const cands = [mainWindow, E.getFocusedWindow(), lastFocusedWin];
  const all = E.getAllWindows().filter(alive);
  for (let i = 0; i < all.length; i++) cands.push(all[i]);
  for (let i = 0; i < cands.length; i++) if (ready(cands[i])) return cands[i];
  // 一个都没申报（比如刚启动还在加载）：退回旧口径，让闸 2/闸 3 去挡 —— 总比"没窗口可用"强
  for (let i = 0; i < cands.length; i++) if (alive(cands[i])) return cands[i];
  return null;
}
function webAiAsk(key, text, opts) {
  return new Promise(function (resolve) {
    const k = String(key || '').trim();
    const known = WEB_AI_KEYS.map(function (s) { return s.key; });
    if (known.indexOf(k) < 0) { resolve({ ok: false, key: k, err: '不认识的 key：' + k + '（可用：' + known.join(' / ') + '）' }); return; }
    const t = String(text || '');
    if (!t.trim()) { resolve({ ok: false, key: k, err: '问题是空的' }); return; }
    const target = webAiTargetWindow();
    if (!target) { resolve({ ok: false, key: k, err: '工作台窗口还没起来（GUI 正在启动？）' }); return; }
    const targetId = target.webContents.id;
    const targetTitle = (function () { try { return target.getTitle(); } catch (e) { return ''; } })();
    const id = 'w' + (++webAiSeq) + '-' + Date.now().toString(36);
    const timeoutMs = Math.max(5000, Math.min(600000, Number((opts && opts.timeoutMs) || 180000)));
    const timer = setTimeout(function () {
      if (!webAiPending.has(id)) return;
      webAiPending.delete(id);
      resolve({ ok: false, id: id, key: k, err: '超时（' + Math.round(timeoutMs / 1000) + 's）：网页版没回完话，或那个窗口没在跑' });
    }, timeoutMs + 8000);
    webAiPending.set(id, { id: id, key: k, text: t, t0: Date.now(), resolve: resolve, timer: timer, claimed: false, winId: targetId, winTitle: targetTitle });
    try { target.webContents.send('webai:task', { id: id, key: k, text: t, timeoutMs: timeoutMs }); }
    catch (e) {
      clearTimeout(timer); webAiPending.delete(id);
      resolve({ ok: false, key: k, err: '派发失败：' + String((e && e.message) || e) });
      return;
    }
    // 日志里带上窗口标题：多窗口时这一行就是"谁在抢单"的铁证
    log('[webai] → ' + k + ' 任务 ' + id + '（' + t.slice(0, 24) + '…）→ 窗口「' + targetTitle + '」');
  });
}
ipcMain.handle('webai:ask', function (e, key, text, opts) { return webAiAsk(key, text, opts); });
ipcMain.handle('webai:claim', function (e, id) {
  const t = webAiPending.get(String(id || ''));
  if (!t || t.claimed) return false;          // 只有一个窗口能抢到
  // 只认派发目标的抢单：旧版桥（别的窗口）就算收到了也不让它接活
  if (t.winId && e.sender.id !== t.winId) {
    log('[webai] ⛔ 忽略抢单：窗口 id ' + e.sender.id + ' ≠ 目标 ' + t.winId +
      '（那是**旧桥**，正文可能被切错；关掉那个窗口再重开、或点它上面的 ⟳）');
    return false;
  }
  t.claimed = true; t.winId = e.sender.id;
  return true;
});
// 窗口加载完就来申报自己的桥版本 ⇒ 派发时只挑"版本相等"的窗口（旧桥窗口直接出局，不用等它抢单才发现）
ipcMain.handle('webai:bridge', function (e, ver) {
  const E = require('electron').BrowserWindow;
  const w = E.fromWebContents(e.sender);
  let title = '';
  try { title = w ? w.getTitle() : ''; } catch (x) { }
  const v = String(ver || '?');
  const prev = webAiWinVer.get(e.sender.id);
  webAiWinVer.set(e.sender.id, { ver: v, title: title });
  if (webAiVerGt(v, WEB_AI_WANT)) WEB_AI_WANT = v;   // ★动态基准：谁报得比基准新，以后就派给这个版本
  const isMain = !!w && w === mainWindow;
  if (!prev || prev.ver !== v) {
    log('[webai] 窗口申报桥版本 v' + v + (isMain ? '（主窗口）' : '（场景窗口）') + '：' + title +
      (v === WEB_AI_WANT ? ' ✓' : ' ⚠ 低于当前基准 v' + WEB_AI_WANT + ' ⇒ 不派活给它（点它的 ⟳ 或关掉重开）'));
  }
  return { ver: v, want: WEB_AI_WANT, ok: v === WEB_AI_WANT, isMain: isMain };
});
// 体检用：谁申报了什么版本、当前会派给谁 —— 排障时一条命令看清，不用靠猜
ipcMain.handle('webai:who', function () {
  const E = require('electron').BrowserWindow;
  const list = [];
  webAiWinVer.forEach(function (rec, id) { list.push({ id: id, ver: rec.ver, title: rec.title, ok: rec.ver === WEB_AI_WANT }); });
  const t = webAiTargetWindow();
  let tTitle = ''; try { tTitle = t ? t.getTitle() : ''; } catch (e) { }
  return { want: WEB_AI_WANT, windows: list, target: tTitle, pending: webAiPending.size };
});
ipcMain.handle('webai:done', function (e, id, r) {
  const t = webAiPending.get(String(id || ''));
  if (!t) return false;
  // 闸 3：交卷也必须来自派发目标 —— 旧桥可能压根不申报、直接干完就交（那就把它的结果扔掉）
  if (t.winId && e.sender.id !== t.winId) {
    log('[webai] ⛔ 忽略交卷：窗口 id ' + e.sender.id + ' ≠ 目标 ' + t.winId + '（旧桥给的结果不可信，已丢弃）');
    return false;
  }
  clearTimeout(t.timer);
  webAiPending.delete(t.id);
  log('[webai] ← ' + t.key + ' 任务 ' + t.id + '：' + (r && r.ok ? '成功 ' + String((r && r.text) || '').length + ' 字' : '失败 ' + ((r && r.err) || '')));
  t.resolve(Object.assign({ id: t.id, key: t.key, elapsedMs: Date.now() - t.t0 }, r || {}));
  return true;
});
ipcMain.handle('webai:state', function () {
  return {
    port: WEB_AI_PORT,
    keys: WEB_AI_KEYS.map(function (s) { return s.key; }),
    pending: Array.from(webAiPending.values()).map(function (t) {
      return { id: t.id, key: t.key, claimed: t.claimed, ageMs: Date.now() - t.t0, winTitle: t.winTitle || '', text: t.text.slice(0, 40) };
    })
  };
});
const webAiServer = http.createServer(function (req, res) {
  const json = function (code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  };
  const u = (req.url || '/').split('?')[0];
  if (u === '/webai/keys' && req.method === 'GET') { json(200, { keys: WEB_AI_KEYS }); return; }
  if (u === '/webai/state' && req.method === 'GET') {
    json(200, {
      port: WEB_AI_PORT,
      pending: Array.from(webAiPending.values()).map(function (t) { return { id: t.id, key: t.key, claimed: t.claimed, ageMs: Date.now() - t.t0 }; })
    });
    return;
  }
  // 排障：谁申报了哪个版本的桥、现在会派给哪个窗口（= 分屏/多窗口时"到底谁在答"，一条命令看清）
  if (u === '/webai/who' && req.method === 'GET') {
    const E = require('electron').BrowserWindow;
    const list = [];
    webAiWinVer.forEach(function (rec, id) { list.push({ id: id, ver: rec.ver, title: rec.title, ok: rec.ver === WEB_AI_WANT }); });
    const t = webAiTargetWindow();
    let tTitle = ''; try { tTitle = t ? t.getTitle() : ''; } catch (e) { }
    json(200, { want: WEB_AI_WANT, windows: list, target: tTitle, stale: list.filter(function (x) { return !x.ok; }).length });
    return;
  }
  if (u === '/webai/ask') {
    if (req.method !== 'POST') { json(405, { ok: false, err: '这个端点要用 POST' }); return; }
    let body = '';
    req.on('data', function (c) { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', async function () {
      let p = null;
      try { p = JSON.parse(body || '{}'); } catch (e) { json(400, { ok: false, err: '请求体不是 JSON' }); return; }
      const r = await webAiAsk(p.key, p.text, p);
      json(r.ok ? 200 : 502, r);
    });
    return;
  }
  json(404, { ok: false, err: '没有这个端点', endpoints: ['GET /webai/keys', 'GET /webai/state', 'GET /webai/who', 'POST /webai/ask {key,text,timeoutMs}'] });
});
webAiServer.on('error', function (e) { log('[webai] 桥服务起不来（端口 ' + WEB_AI_PORT + '）：' + e.message); });
// ===== 自动更新挂载（官方 apps/desktop 能力搬迁 ② · 2026-09-26）=====
// 独立模块 updater.js：未打包（源码直跑）时静默待命、默认不自动安装、全部错误吞掉 ⇒ 不影响现有使用。
// 会话入口：node scripts\检查更新.mjs [state|check|install|config]
let updaterHandle = null;
try {
  updaterHandle = require('./updater.js').install({ log: log });
} catch (e) {
  log('[updater] 挂载失败（已忽略，不影响使用）：' + (e && e.message ? e.message : String(e)));
}

// ===== 版本策略 / 强制更新挂载（官方 apps/desktop 能力搬迁 ④ 的另一半 · 2026-09-26）=====
// 独立模块 scripts/mandatory-update.js：策略来自 data\version-policy.json；命中弹内联 HTML 模态提示窗。
// ★ 刻意做成**软提示**（可"稍后"），只有策略显式 hardBlock 才不可关 —— 不锁工作台、不影响任何场景。
// 会话入口：node scripts\强制更新.mjs [state|设 <最低版本> [--hard]|清]
try {
  require('./scripts/mandatory-update.js').install({
    log: log,
    checkNow: updaterHandle && typeof updaterHandle.checkNow === 'function' ? updaterHandle.checkNow : null,
  });
} catch (e) {
  log('[强制更新] 挂载失败（已忽略，不影响使用）：' + (e && e.message ? e.message : String(e)));
}

// ===== 原生浏览器侧栏挂载（官方 apps/desktop 能力搬迁 ③ · 2026-09-26）=====
// 独立模块 scripts/sidebar.js：WebContentsView 贴到主窗口 contentView（官方 platform-view.ts 同款做法）。
// ★ 未 attach 时对工作台零影响；不碰场景 json / sessionId / 渲染层注入。
// 会话入口：node scripts\浏览器侧栏.mjs [open|close|url|bounds|state]
try {
  require('./scripts/sidebar.js').install({ log: log });
} catch (e) {
  log('[sidebar] 挂载失败（已忽略，不影响使用）：' + (e && e.message ? e.message : String(e)));
}

// ===== 崩溃上报 + 版本策略挂载（官方 apps/desktop 能力搬迁 ④ · 2026-09-26）=====
// 独立模块 crash.js：本地崩溃转储（不上传）+ 主进程异常流水 data\crash-log.jsonl + 版本策略 data\version-policy.json。
// 全部 try/catch 吞掉 ⇒ 记不下来也不影响使用；不弹窗、不拦启动。
try {
  require('./crash.js').install({ log: log, appendLog: function (m) { try { log(m) } catch (e) {} } });
} catch (e) {
  log('[crash] 挂载失败（已忽略，不影响使用）：' + (e && e.message ? e.message : String(e)));
}

// ===== 外部刷新通道（2026-09-26 立；AI 会话自助刷新，不再让用户手点 ⟳）=====
// 背景：工作台是「零构建 + 单文件渲染器 + ⟳ 热更」，而 ⟳ 以前只能人手点 ⇒ 每次改完 renderer 都要用户动手。
// 现在：任何进程写 data/reload-panels.cmd（内容 all 或场景 id）⇒ 本进程 500ms 内重载匹配的 webview 面板。
// 会话用法：node scripts\刷新面板.mjs all
const RELOAD_CMD = path.join(__dirname, 'data', 'reload-panels.cmd');
// 2026-10-16：顶栏状态区文件的"版本哨"——启动时先记一份 mtime，之后只要它变了就把主窗口整页重载一次
// （不这样记，第一条刷新命令只会"记录"、第二条才重载，白等一轮）。
try { global.__dshTopbarMtime = fs.statSync(path.join(__dirname, 'renderer', 'topbar-status.js')).mtimeMs; }
catch (e) { global.__dshTopbarMtime = undefined; }
setInterval(function () {
  try {
    if (!fs.existsSync(RELOAD_CMD)) return;
    var target = String(fs.readFileSync(RELOAD_CMD, 'utf8')).trim() || 'all';
    fs.unlinkSync(RELOAD_CMD);
    var views = webContents.getAllWebContents().filter(function (wc) {
      try { return wc.getType() === 'webview' && !wc.isDestroyed(); } catch (e) { return false; }
    });
    var hit = target === 'all' ? views : views.filter(function (wc) {
      try { var u = String(wc.getURL()); return u.indexOf(target) >= 0 || u.indexOf(encodeURIComponent(target)) >= 0; } catch (e) { return false; }
    });
    hit.forEach(function (wc) { try { wc.reload(); } catch (e) {} });

    // 2026-10-16 补（界面侧）：顶栏状态区 `renderer\topbar-status.js` 是靠 index.html 的 <script> 加载的，
    //   而下面那条"主窗口热更新"只 executeJavaScript(reloadScene()) ⇒ **不会重新执行页面脚本** ⇒ 改了它主窗口永远不变
    //   （当天实测：连改 4 轮、顶栏一动不动，全是这个原因）。
    //   办法：记一份它的 mtime，**只有它变了**才整页重载主窗口；其余情况照旧走 reloadScene（不打扰 Harness 对话）。
    try {
      var tf = path.join(__dirname, 'renderer', 'topbar-status.js');
      var tm = fs.statSync(tf).mtimeMs;
      if (global.__dshTopbarMtime === undefined) {
        global.__dshTopbarMtime = tm;
      } else if (global.__dshTopbarMtime !== tm) {
        global.__dshTopbarMtime = tm;
        log('[reload-panels] topbar-status.js 变了 ⇒ 整页重载主窗口（让它重新执行）');
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reloadIgnoringCache();
      }
    } catch (e) { /* ignore */ }

    // 2026-09-27 补：<客户> OA 这类「同页 div 面板」不是 webview，上面那条重载碰不到它们。
    // 再让窗口跑一次它自己的热更新（重灌带时间戳的 renderers.js，**不重载页面** ⇒ Harness 对话不断）。
    // 2026-09-29 修：以前只热更新 mainWindow ⇒ 跑在**独立场景窗口**里的面板永远刷不到
    //   （主窗口对"已分离"的场景只画一张占位卡然后 return，所以 renderer 改动在那边全都不生效——
    //    当天就撞上：改了 renderers.js，独立窗口里的「<机主>的分析助手」既不换标题也没有新页签）。
    //   现在按 target 选窗口：场景 id ⇒ 该场景的独立窗口 + 主窗口（主窗口自己判断要不要重建，currentTab 是渲染层状态）；
    //   all ⇒ 所有窗口。**不顺手重建无关窗口**——那会把别的窗口里的 AI 面板一起重建。
    try {
      var js = '(function(){try{ if (typeof reloadScene === "function") { reloadScene(); return "ok"; }'
        + ' if (window.__dshReloadScene) { window.__dshReloadScene(); return "ok-hook"; } return "no-fn"; }'
        + 'catch(e){ return "err:" + ((e && e.message) || e); }})()';
      var wins = allWindows();
      var targets = wins.filter(function (w) {
        if (target === 'all') return true;
        if (w === mainWindow) return true;                    // 主窗口的重建交给它自己的 reloadScene
        try { return String(w.kunScene || '') === target; } catch (e) { return false; }
      });
      targets.forEach(function (w) {
        var tag;
        try { tag = (w === mainWindow) ? '主窗口' : ('独立窗口[' + (w.kunScene || '') + ']'); } catch (e) { tag = '窗口'; }
        w.webContents.executeJavaScript(js).then(function (r) {
          log('[reload-panels] ' + tag + ' 热更新结果: ' + r);
          // 2026-09-27：CSP 是 script-src 'self'（无 unsafe-eval）⇒ eval 这条路随时可能被挡，
          // 一旦够不着（no-fn / err:…）就退回整页重载：不依赖 eval、不依赖动态插 script，必然读到新 renderers.js。
          if (r === 'no-fn' || String(r).indexOf('err:') === 0) {
            log('[reload-panels] ' + tag + ' 热更新够不着 ⇒ 整页重载该窗口');
            try { w.webContents.reloadIgnoringCache(); } catch (e2) { /* ignore */ }
          }
        }).catch(function (e) {
          log('[reload-panels] ' + tag + ' executeJavaScript 被拒（多半是 CSP）⇒ 整页重载该窗口: ' + ((e && e.message) || e));
          try { w.webContents.reloadIgnoringCache(); } catch (e2) { /* ignore */ }
        });
      });
      log('[reload-panels] 同页面板热更新窗口: ' + targets.length + '/' + wins.length + ' 个');
    } catch (e) { /* 窗口没了也不致命 */ }
    log('[reload-panels] ' + target + ' ⇒ 重载 ' + hit.length + '/' + views.length + ' 个面板');
  } catch (e) { /* 命令文件忙/损坏都不致命，下一轮再试 */ }
}, 500);

webAiServer.listen(WEB_AI_PORT, '127.0.0.1', function () {
  log('[webai] 网页版 AI 桥已就绪: http://127.0.0.1:' + WEB_AI_PORT + '/webai/keys（会话可用 scripts\\webai.mjs 问免费网页版）');
});