// ── ② 启动进度 / 拉起引擎 / 等它真的就绪（含复用外部引擎的坑）
// 摘自本机实现 `main.js` 的 Lmain.js–262。
// 脱敏：内部 API 名已去品牌化（kun → app）· 绝对路径 → <DSH根>/<工作区> · 个人名/客户名/站点 → 占位
// 423
// ⚠ 摘录/单文件：脱离这套工作台不能直接运行（依赖壳注入的 app.* 实例与页面上下文）。

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
  // 不设置的话 dsh 默认用 <盘根>:\Users\<user>\.dsh，导致历史会话在界面里"消失"。
  env.DSH_HOME = path.join(HARNESS_DIR, '.dsh');
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
  dirs.push('<盘根>\\software\\node.js');
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
    args = [CLI_BUILT, 'web', '--no-open'];
  } else {
    // Electron 二进制以纯 Node 运行（内置 Node 24.18，满足 engines 要求）
    env.ELECTRON_RUN_AS_NODE = '1';
    cmd = process.execPath;
    args = [CLI_BUILT, 'web', '--no-open'];
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
  return wireServerProc(spawn('cmd.exe', ['/c', PNPM_CMD + ' dsh web --no-open'], {
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
let engineIsForeign = false;

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
  return false;
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