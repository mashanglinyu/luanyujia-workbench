// ── ① 引擎目录的推导（换电脑/换盘符都不用改代码）
// 摘自本机实现 `main.js` 的 Lmain.js–22。
// 脱敏：内部 API 名已去品牌化（kun → app）· 绝对路径 → <DSH根>/<工作区> · 个人名/客户名/站点 → 占位
// 70
// ⚠ 摘录/单文件：脱离这套工作台不能直接运行（依赖壳注入的 app.* 实例与页面上下文）。

// 引擎目录：**优先按"与本工作台同级"推导**（换电脑 / 换盘符都不用改这行），推不出来才退回写死值。
// 2026-10-10 为「换电脑一比一复制」加（见 场景记忆 §39）：只要引擎与工作台仍是同级目录，任何盘符都能跑。
const HARNESS_DIR = (function () {
  const sibling = path.join(path.dirname(__dirname), '引擎');
  try { if (fs.existsSync(path.join(sibling, 'apps', 'cli'))) return sibling; } catch (e) { /* ignore */ }
  return '<盘根>\\DSH\\引擎';
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
const stockStore = require('./stock-store');
const oaStore = require('./oa-store');   // OA 运维场景专属存储（D 盘 data/oa.db，与股票完全隔离）
const oaSsh = require('./oa-ssh');       // OA 运维场景 SSH 通道（paramiko 桥接，密码走 SSH_PASS/配置）

// ---- 个人站场景：官网静态服务（<你的站点工程> → http://127.0.0.1:SITE_PORT）----
const SITE_DIR = '<盘根>\\项目工程\\我的官网';
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