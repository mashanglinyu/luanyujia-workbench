// 12-源码照搬 · 最小外壳（Electron）
// 目标：装完能直接跑起来，看到三个场景的布局与顶栏；不依赖 10-源码 / 11-最小可运行壳。
// 不做：嵌入真实 DSH 对话（那需要引擎 RPC）。AI 面板先给占位，告诉你接哪里。
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = __dirname;
const SCEN_DIR = path.join(ROOT, 'scenarios');
const IS_SELFTEST = process.argv.includes('--selftest');

let win = null;
function LOG(m) { try { require('node:fs').appendFileSync(require('node:path').join(__dirname, 'main.log'), new Date().toISOString() + ' ' + m + '\n'); } catch (e) {} }

function readScenarios() {
  const out = [];
  if (!fs.existsSync(SCEN_DIR)) return out;
  for (const f of fs.readdirSync(SCEN_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(SCEN_DIR, f), 'utf8'));
      j._file = f;
      out.push(j);
    } catch (e) { /* 跳过坏 json */ }
  }
  // 保持固定顺序：自我复盘 / 本地电脑 / 设计杂活，其余按文件名
  const order = ['self-review', 'pc-cleanup', 'design-misc'];
  out.sort((a, b) => {
    const ia = order.indexOf(a.id), ib = order.indexOf(b.id);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  return out;
}

function cpuLoad() {
  // 简单采样：1 秒内 idle/total 差值（够用，不引入依赖）
  return new Promise((resolve) => {
    const s1 = os.cpus().map((c) => c.times);
    setTimeout(() => {
      const s2 = os.cpus().map((c) => c.times);
      let idle = 0, total = 0;
      for (let i = 0; i < s1.length; i++) {
        const a = s1[i], b = s2[i];
        idle += b.idle - a.idle;
        total += (b.user - a.user) + (b.nice - a.nice) + (b.sys - a.sys) + (b.idle - a.idle) + (b.irq - a.irq);
      }
      resolve(Math.max(0, Math.min(100, Math.round((1 - idle / (total || 1)) * 100))));
    }, 700);
  });
}

function gpuLoad() {
  // 有 N 卡就读真利用率；没有/读不到就返回 null（界面显示 —，不编数）
  return new Promise((resolve) => {
    try {
      const { execFile } = require('node:child_process');
      execFile('nvidia-smi', ['--query-gpu=utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'],
        { timeout: 4000 }, (err, stdout) => {
          if (err || !stdout) return resolve(null);
          const first = String(stdout).trim().split(/\r?\n/)[0] || '';
          const [util, used, total] = first.split(',').map((x) => Number(String(x).trim()));
          if (!Number.isFinite(util)) return resolve(null);
          resolve({ util, memUsed: used, memTotal: total });
        });
    } catch (e) { resolve(null); }
  });
}

function memPct() {
  const total = os.totalmem();
  const used = total - os.freemem();
  return Math.round((used / total) * 100);
}

ipcMain.handle('app:config', () => {
  const def = { engineUrl: 'http://127.0.0.1:3080/' };
  for (const name of ['config.json', 'config.local.json']) {
    try {
      const f = path.join(ROOT, name);
      if (fs.existsSync(f)) Object.assign(def, JSON.parse(fs.readFileSync(f, 'utf8')));
    } catch (e) { /* 坏配置跳过 */ }
  }
  return def;
});
ipcMain.handle('app:dirs', () => {
  const root = process.env.DSH_HOME || process.env.DSH_ROOT || '';
  const out = { root, home: os.homedir(), shell: ROOT, scenes: path.join(ROOT, 'scenarios') };
  // 工作区：优先环境变量，其次 <DSH根>\..\工作区，再不行用户目录
  let work = process.env.DSH_WORKSPACE || '';
  if (!work) {
    const guess = root ? path.join(root, '..', '..', '工作区') : '';
    work = guess && fs.existsSync(guess) ? guess : os.homedir();
  }
  out.workspace = work;
  return out;
});
ipcMain.handle('app:dshRoot', () => process.env.DSH_HOME || process.env.DSH_ROOT || '');
ipcMain.handle('app:scenarios', () => readScenarios());
ipcMain.handle('app:openPath', async (_e, p) => { if (!p) return { ok: false, why: '空路径' }; return { ok: true, err: await shell.openPath(p) }; });
ipcMain.handle('app:load', async () => ({ cpu: await cpuLoad(), gpu: await gpuLoad(), mem: { usedPct: memPct() } }));
ipcMain.handle('app:openExternal', async (_e, url) => {
  if (!/^https?:\/\//i.test(String(url || ''))) return { ok: false, why: '只允许 http(s)' };
  await shell.openExternal(url);
  return { ok: true };
});
ipcMain.handle('app:home', () => os.homedir());
ipcMain.handle('webai:open', (_e, key, url, title) => openWebAi(key, url, title));
ipcMain.handle('app:balance', async () => {
  let key = process.env.DEEPSEEK_API_KEY || '';
  try {
    const f = path.join(ROOT, 'config.local.json');
    if (!key && fs.existsSync(f)) key = JSON.parse(fs.readFileSync(f, 'utf8')).deepseekKey || '';
  } catch (e) { /* ignore */ }
  if (!key) return { ok: false, why: '未配置密钥（环境变量 DEEPSEEK_API_KEY 或 config.local.json 的 deepseekKey）' };
  try {
    const res = await fetch('https://api.deepseek.com/user/balance', { headers: { Authorization: 'Bearer ' + key } });
    if (!res.ok) return { ok: false, why: 'HTTP ' + res.status };
    const j = await res.json();
    const info = (j.balance_infos && j.balance_infos[0]) || {};
    return { ok: true, available: !!j.is_available, total: info.total_balance, currency: info.currency || 'CNY' };
  } catch (e) { return { ok: false, why: e.message }; }
});
ipcMain.handle('app:version', () => ({ app: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome }));

ipcMain.handle('disk:list', async () => {
  const out = [];
  for (const letter of ['C', 'D', 'E', 'F']) {
    const root = letter + ':\\';
    try {
      if (!fs.existsSync(root)) continue;
      const st = fs.statfsSync(root);
      const total = st.blocks * st.bsize;
      const free = st.bfree * st.bsize;
      out.push({ letter, total, free, usedPct: Math.round((1 - free / total) * 100) });
    } catch (e) { /* 跳过读不到的盘 */ }
  }
  return out;
});
ipcMain.handle('fs:list', async (_e, dir) => {
  try {
    const items = fs.readdirSync(dir, { withFileTypes: true }).map((d) => ({
      name: d.name,
      dir: d.isDirectory(),
      size: d.isDirectory() ? 0 : (() => { try { return fs.statSync(path.join(dir, d.name)).size; } catch (e) { return 0; } })(),
    }));
    items.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    return { ok: true, items, dir };
  } catch (e) { return { ok: false, why: e.message }; }
});

ipcMain.handle('fs:read', async (_e, p) => {
  try {
    const st = fs.statSync(p);
    if (st.size > 20 * 1024 * 1024) return { ok: false, why: '文件超过 20 MB' };
    const ext = path.extname(p).toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].includes(ext)) {
      return { ok: true, kind: 'image', dataUrl: 'data:image/' + ext.slice(1).replace('jpg', 'jpeg') + ';base64,' + fs.readFileSync(p).toString('base64') };
    }
    if (['.mp4', '.webm'].includes(ext)) {
      return { ok: true, kind: 'video', fileUrl: 'file:///' + p.replace(/\\/g, '/') };
    }
    if (ext === '.pdf') return { ok: true, kind: 'pdf', fileUrl: 'file:///' + p.replace(/\\/g, '/') };
    if (['.md', '.txt', '.json', '.js', '.mjs', '.css', '.html', '.yml', '.yaml', '.log', '.csv'].includes(ext)) {
      return { ok: true, kind: ext === '.md' ? 'md' : 'text', text: fs.readFileSync(p, 'utf8').slice(0, 200000) };
    }
    return { ok: true, kind: 'other', size: st.size, ext };
  } catch (e) { return { ok: false, why: e.message }; }
});

// 首次运行：把 12 自带的记忆模板注入到 <DSH根>\场景项目信息\<场景>\（只在用户点菜单时执行）
ipcMain.handle('mem:inject', async () => {
  let dshRoot = process.env.DSH_ROOT || process.env.DSH_HOME || os.homedir();
  if (!dshRoot) return { ok: false, why: '没检测到 DSH 根目录（可设环境变量 DSH_ROOT）' };
  const res = [];
  const pairs = [
    ['自我复盘', '自我复盘-项目信息.md'],
    ['本地电脑', '本地电脑-项目信息.md'],
    ['设计杂活', '设计杂活-项目信息.md'],
  ];
  for (const [scen, tpl] of pairs) {
    const dir = path.join(dshRoot, '场景项目信息', scen);
    const dst = path.join(dir, '项目信息.md');
    try {
      if (fs.existsSync(dst)) { res.push({ scen, ok: true, skipped: true }); continue; }
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(path.join(ROOT, '记忆模板', tpl), dst);
      res.push({ scen, ok: true, path: dst });
    } catch (e) { res.push({ scen, ok: false, why: e.message }); }
  }
  return { ok: true, res, root: dshRoot };
});

ipcMain.handle('win:control', (_e, action) => {
  if (!win) return;
  if (action === 'min') win.minimize();
  else if (action === 'max') win.isMaximized() ? win.unmaximize() : win.maximize();
  else if (action === 'close') win.close();
});

// ── 网页版 AI 小窗：每站点一个独立窗口（各自登录分区）──
const webaiWins = new Map();
function openWebAi(key, url, title) {
  const old = webaiWins.get(key);
  if (old && !old.isDestroyed()) {
    if (old.isVisible()) { old.hide(); return { ok: true, action: 'hide' }; }
    old.show(); old.focus(); return { ok: true, action: 'show' };
  }
  const w = new BrowserWindow({
    width: 480, height: 760, minWidth: 360, minHeight: 480,
    title: title || key, autoHideMenuBar: true,
    backgroundColor: '#0b0e14',
    webPreferences: { partition: 'persist:webai-' + key, contextIsolation: true, nodeIntegration: false },
  });
  w.loadURL(url);
  w.on('closed', () => webaiWins.delete(key));
  webaiWins.set(key, w);
  return { ok: true, action: 'open' };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 1000,
    minHeight: 660,
    resizable: true,
    frame: false,
    backgroundColor: '#0a0c12',
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });
  LOG('createWindow');
  win.webContents.on('did-finish-load', () => LOG('did-finish-load'));
  win.webContents.on('did-fail-load', (_e, code, desc) => LOG('did-fail-load ' + code + ' ' + desc));
  win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  if (IS_SELFTEST) {
    win.webContents.once('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 2500));
      try {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(ROOT, 'selftest.png'), img.toPNG());
        console.log('SELFTEST_OK ' + path.join(ROOT, 'selftest.png'));
      } catch (e) { console.log('SELFTEST_FAIL ' + e.message); }
      app.exit(0);
    });
  }
}

app.whenReady().then(() => { LOG('ready'); createWindow(); });
app.on('window-all-closed', () => { LOG('window-all-closed'); app.quit(); });
process.on('uncaughtException', (e) => LOG('uncaught ' + e.message));
