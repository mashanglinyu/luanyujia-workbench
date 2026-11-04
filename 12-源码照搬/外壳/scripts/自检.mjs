// 自检：Node 版本 / 引擎目录 / 场景 json / 渲染文件（公开版工作台，2026-11-04 加）
// 用法：node 外壳\scripts\自检.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));      // 外壳\scripts
const SHELL = path.resolve(HERE, '..');                          // 外壳
const ROOT = path.resolve(SHELL, '..');                          // 12-源码照搬
const rows = [];
const check = (name, ok, detail) => rows.push({ name, ok: !!ok, detail: detail || '' });

// 1) Node
const major = Number(process.versions.node.split('.')[0]);
check('Node 版本', major >= 18 && major < 25, '当前 ' + process.versions.node + '（要求 18–24）');

// 2) 引擎
const bin = path.join(ROOT, '引擎', 'apps', 'cli', 'lib', 'bin.js');
check('引擎目录', fs.existsSync(bin), bin + (fs.existsSync(bin) ? ' ✓' : ' ✗ 缺失（把 DSH 引擎整个搬成 12-源码照搬\\引擎）'));

// 3) 场景 json
const scDir = path.join(SHELL, 'scenarios');
const scs = fs.existsSync(scDir) ? fs.readdirSync(scDir).filter((f) => f.endsWith('.json')) : [];
let bad = [];
for (const f of scs) {
  try { const j = JSON.parse(fs.readFileSync(path.join(scDir, f), 'utf8')); if (!Array.isArray(j.panels)) bad.push(f); }
  catch { bad.push(f); }
}
check('场景配置', scs.length >= 1 && bad.length === 0, scs.length + ' 个 json' + (bad.length ? '，异常: ' + bad.join(',') : ''));

// 4) 关键渲染文件
const need = ['main.js', 'preload.js', 'renderer/index.html', 'renderer/renderer.js', 'renderer/renderers.js', 'renderer/styles.css'];
const miss = need.filter((f) => !fs.existsSync(path.join(SHELL, f)));
check('外壳文件', miss.length === 0, miss.length ? '缺: ' + miss.join(',') : '6/6 在');

// 5) 端口占用（只是提示，不判失败）
const net = await import('node:net');
const busy = [];
for (const port of [3083, 31238, 31239]) {
  await new Promise((resolve) => {
    const s = net.createConnection({ host: '127.0.0.1', port });
    s.setTimeout(400);
    s.once('connect', () => { busy.push(port); s.destroy(); resolve(); });
    s.once('timeout', () => { s.destroy(); resolve(); });
    s.once('error', () => resolve());
  });
}
check('端口', true, busy.length ? '被占用: ' + busy.join(',') + '（如果工作台已在跑属正常）' : '3083/31238/31239 都空');

// 输出
let fail = 0;
for (const r of rows) {
  if (!r.ok) fail++;
  console.log((r.ok ? '✓ ' : '✗ ') + r.name + (r.detail ? ' — ' + r.detail : ''));
}
console.log(fail ? '\n⛔ ' + fail + ' 项未通过，先修再启动' : '\n✅ 全部通过，可以启动（双击 启动.vbs 或 npm start）');
process.exit(fail ? 1 : 0);
