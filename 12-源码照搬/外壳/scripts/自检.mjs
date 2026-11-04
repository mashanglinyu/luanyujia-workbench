// 自检：Node 版本 / 引擎目录 / 场景 json / 渲染文件 / 端口（2026-11-04 按 code-ai 复核修三处）
// 用法：node 外壳\scripts\自检.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));      // 外壳\scripts
const SHELL = path.resolve(HERE, '..');                          // 外壳
const ROOT = path.resolve(SHELL, '..');                          // 12-源码照搬
const rows = [];
const check = (name, ok, detail) => rows.push({ name, ok: !!ok, detail: detail || '' });

// 0) 先探端口（引擎判断要用）：3083 引擎 / 31238 界面 / 9876 Blender MCP
const net = await import('node:net');
const busy = [];
for (const port of [3083, 31238, 9876]) {
  await new Promise((resolve) => {
    const s = net.createConnection({ host: '127.0.0.1', port });
    s.setTimeout(400);
    s.once('connect', () => { busy.push(port); s.destroy(); resolve(); });
    s.once('timeout', () => { s.destroy(); resolve(); });
    s.once('error', () => resolve());
  });
}

// 1) Node（引擎要求 >=24.9，外壳自身 18+，整体按取严）
const major = Number(process.versions.node.split('.')[0]);
const minor = Number(process.versions.node.split('.')[1]);
const nodeOk = (major > 24) || (major === 24 && minor >= 9);
check('Node 版本', nodeOk, '当前 ' + process.versions.node + '（引擎要求 >=24.9）');

// 2) 引擎（三态：有本包引擎 / 复用外部已跑引擎 / 都没有）
const bin = path.join(ROOT, '引擎', 'apps', 'cli', 'lib', 'bin.js');
if (fs.existsSync(bin)) check('引擎目录', true, '本包 引擎\\ 已就位');
else if (busy.includes(3083)) check('引擎目录', true, '⚠ 本包无 引擎\\，但 127.0.0.1:3083 已有引擎在跑（复用外部实例）');
else check('引擎目录', false, '缺 ' + bin + '（把 DSH 引擎整个搬成 12-源码照搬\\引擎）');

// 3) 场景 json
const scDir = path.join(SHELL, 'scenarios');
const scs = fs.existsSync(scDir) ? fs.readdirSync(scDir).filter((f) => f.endsWith('.json')) : [];
const bad = [];
for (const f of scs) {
  try { const j = JSON.parse(fs.readFileSync(path.join(scDir, f), 'utf8')); if (!Array.isArray(j.panels)) bad.push(f); }
  catch { bad.push(f); }
}
check('场景配置', scs.length >= 1 && bad.length === 0, scs.length + ' 个 json' + (bad.length ? '，异常: ' + bad.join(',') : ''));

// 4) 外壳文件（含 index.html 实际引用的 9 个脚本）
const need = [
  'main.js', 'preload.js', 'crash.js',
  'renderer/index.html', 'renderer/renderer.js', 'renderer/renderers.js',
  'renderer/styles.css', 'renderer/topbar-status.js', 'renderer/public-clean.js',
  'renderer/public-links.js', 'renderer/customer-start.js',
];
const miss = need.filter((f) => !fs.existsSync(path.join(SHELL, f)));
check('外壳文件', miss.length === 0, miss.length ? '缺: ' + miss.join(',') : need.length + '/' + need.length + ' 在');

// 5) 端口（只是提示）
check('端口', true, busy.length ? '已占用: ' + busy.join(',') + '（工作台已在跑属正常）' : '3083/31238/9876 都空');

// 输出
let fail = 0;
for (const r of rows) {
  if (!r.ok) fail++;
  console.log((r.ok ? '✓ ' : '✗ ') + r.name + (r.detail ? ' — ' + r.detail : ''));
}
console.log(fail ? '\n⛔ ' + fail + ' 项未通过，先修再启动' : '\n✅ 全部通过，可以启动（双击 启动.vbs 或 npm start）');
process.exit(fail ? 1 : 0);
