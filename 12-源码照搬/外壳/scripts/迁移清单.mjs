// 迁移清单.mjs —— 「换电脑一比一复制」清单生成器（2026-10-10 立）
//
// 用法：
//   node scripts\迁移清单.mjs            # 只打印
//   node scripts\迁移清单.mjs --json     # 机器可读
//   node scripts\迁移清单.mjs --write    # 额外把清单写进 迁移手册.md 的「自动清单」段
//
// 做三件事：
//   ① 扫出「工作台 + 引擎 .dsh」里被引用的所有绝对路径根（带样例文件，方便回头定位）
//   ② 盘点关键外部依赖：在不在、多大、要不要重建
//   ③ 按「必须复制 / 必须重装重建 / 必须按新机器改」分类给出结论
//
// 设计原则（为什么这么写）：
//   · 路径全部相对 __dirname 推导 ⇒ 这个脚本本身在任何盘符/机器上都能跑；
//   · 只读，不改任何东西（--write 也只写自己那份手册）；
//   · 不知道的不猜：拿不到的信息标「需人工确认」。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUI = path.dirname(HERE);                       // 工作台根（scripts 的上一级）
const ENGINE = path.join(path.dirname(GUI), 'DSH 引擎'); // 同级的引擎目录
const DSH = path.join(ENGINE, '.dsh');                // 引擎用户数据（DSH_HOME）

const argv = process.argv.slice(2);
const AS_JSON = argv.includes('--json');
const DO_WRITE = argv.includes('--write');

// ---------- 小工具 ----------
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
function dirSize(dir, cap = Infinity) {
  let total = 0, files = 0;
  const walk = (d) => {
    let list; try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.git') walk(p); }
      else { try { total += fs.statSync(p).size; files++; } catch {} }
      if (total > cap) return;
    }
  };
  walk(dir);
  return { bytes: total, files };
}
function info(p) {
  try {
    const st = fs.statSync(p);
    if (st.isDirectory()) { const s = dirSize(p); return { exists: true, kind: 'dir', bytes: s.bytes, files: s.files }; }
    return { exists: true, kind: 'file', bytes: st.size, files: 1 };
  } catch { return { exists: false, kind: '-', bytes: 0, files: 0 }; }
}
const SCAN_SKIP = /node_modules|[\\/]\.git[\\/]|data[\\/](backups|captures|spill|scenario-backup|engine-backup|logs)/;
const TEXT_EXT = /\.(js|mjs|cjs|json|md|css|html|vbs|ps1|yml|yaml|txt|ts|tsx)$/;

// ---------- ① 扫绝对路径根 ----------
function scanRoots(root, label) {
  const hits = new Map();   // 根 → { count, samples:Set }
  let files = 0;
  const walk = (d) => {
    let list; try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const p = path.join(d, e.name);
      if (SCAN_SKIP.test(p)) continue;
      if (e.isDirectory()) { walk(p); continue; }
      if (!TEXT_EXT.test(e.name)) continue;
      let t = ''; try { t = fs.readFileSync(p, 'utf8'); } catch { continue; }
      const m = t.match(/[A-Za-z]:\\[^\s"'`)\]<>|,;]+/g) || [];
      if (!m.length) continue;
      files++;
      for (const s of m) {
        const parts = s.split('\\').filter(Boolean);
        const key = (parts[0] || '') + '\\' + (parts[1] || '') + '\\' + (parts[2] || '');
        if (!hits.has(key)) hits.set(key, { count: 0, samples: new Set() });
        const h = hits.get(key); h.count++;
        if (h.samples.size < 3) h.samples.add(path.relative(root, p));
      }
    }
  };
  walk(root);
  return { label, root, files, rows: [...hits.entries()].map(([k, v]) => ({ root: k, count: v.count, samples: [...v.samples] })).sort((a, b) => b.count - a.count) };
}

// ---------- ② 外部依赖盘点 ----------
const DEPS = [
  // [用途, 路径, 迁移处理]
  ['引擎源码/构建目录', ENGINE, 'reinstall'],
  ['引擎 git 元数据', path.join(ENGINE, '.git'), 'reinstall'],
  ['引擎内置 CLI 产物（快启动入口）', path.join(ENGINE, 'apps', 'cli', 'lib', 'bin.js'), 'build'],
  ['引擎 web 客户端产物', path.join(ENGINE, 'apps', 'web', 'dist', 'index.html'), 'build'],
  ['引擎 node_modules', path.join(ENGINE, 'node_modules'), 'reinstall'],
  ['引擎插件目录', path.join(ENGINE, '插件'), 'copy'],
  ['引擎 MCP 本体', path.join(ENGINE, 'MCP'), 'copy-or-rebuild'],
  ['DSH 用户数据根', DSH, 'copy'],
  ['DSH 凭据（密钥！）', path.join(DSH, '.credentials.yaml'), 'copy-secret'],
  ['DSH 全局须知', path.join(DSH, 'AGENTS.md'), 'copy'],
  ['DSH 技能目录', path.join(DSH, 'skills'), 'copy'],
  ['DSH profile 配置', path.join(DSH, 'profiles', 'web', 'cordis.patch.yml'), 'copy-then-edit'],
  ['DSH 用户级补丁', path.join(DSH, 'cordis.patch.yml'), 'copy'],
  ['DSH 会话存储', path.join(DSH, 'storages'), 'copy'],
  ['DSH 会话原始日志', path.join(DSH, 'sessions'), 'copy'],
  ['工作台主程序', GUI, 'copy'],
  ['工作台 node_modules', path.join(GUI, 'node_modules'), 'reinstall'],
  ['工作台运行数据（窗口/顺序/备份）', path.join(GUI, 'data'), 'copy-runtime'],
  ['工作台服务器日志', path.join(GUI, 'server.log'), 'skip'],
];

// 场景记忆 / 项目目录（从扫描结果里认，也认几个已知根）
const KNOWN_DATA_DIRS = [
  ['场景长期记忆根（每个场景一份项目信息）', '<工作台>', 'copy'],
  ['<客户> OA 项目（OA 场景的资产）', '<资料库>', 'copy'],
  ['视频工作流素材根', '<视频工作流>', 'copy'],
  ['各会话工作区根', '<临时目录>', 'copy-workspace'],
];

// ---------- 跑 ----------
const guiScan = scanRoots(GUI, '工作台');
const dshScan = scanRoots(DSH, '引擎 .dsh');
const allRoots = new Map();
for (const s of [guiScan, dshScan]) for (const r of s.rows) {
  const k = r.root;
  if (!allRoots.has(k)) allRoots.set(k, { root: k, count: 0, where: new Set() });
  const a = allRoots.get(k); a.count += r.count; a.where.add(s.label);
}
const rootRows = [...allRoots.values()].sort((a, b) => b.count - a.count);

const depRows = [];
for (const [label, p, how] of DEPS) {
  const i = info(p);
  depRows.push({ label, path: p, how, exists: i.exists, kind: i.kind, bytes: i.bytes, files: i.files });
}
const dataRows = [];
for (const [label, p, how] of KNOWN_DATA_DIRS) {
  const i = info(p);
  dataRows.push({ label, path: p, how, exists: i.exists, kind: i.kind, bytes: i.bytes, files: i.files });
}

// ---------- ②b 机器相关项：换电脑「必须手改」的地方（带 文件:行号）----------
const MACHINE_FILES = [
  ['工作台主进程', path.join(GUI, 'main.js')],
  ['工作台预加载', path.join(GUI, 'preload.js')],
  ['工作台渲染层', path.join(GUI, 'renderer', 'renderers.js')],
  ['引擎 profile 配置', path.join(DSH, 'profiles', 'web', 'cordis.patch.yml')],
  ['引擎用户级补丁', path.join(DSH, 'cordis.patch.yml')],
];
const MACHINE_PATTERNS = [
  // ⚠ 同时认「单反斜杠」（YAML/注释里）与「双反斜杠」（JS 字符串字面量里）—— 2026-10-10 补：
  //   只认单斜杠时漏掉了 renderer\renderers.js 里两条 <用户目录>\<user>\Desktop\*.lnk（JS 里写成 \\）
  ['用户名路径（换用户名必改）', /<盘根>:\\+Users\\+[^\\\s"'`]+/g],
  ['node 绝对路径', /[A-Za-z]:\\+[^\s"'`]*node\.js\\+node\.exe/g],
  ['uv/uvx 绝对路径', /[A-Za-z]:\\+[^\s"'`]*uvx?\.exe/g],
  ['python venv 绝对路径', /[A-Za-z]:\\+[^\s"'`]*\.venv\\+Scripts\\+[^\s"'`]+/g],
];
function scanMachine() {
  const rows = [];
  for (const [label, file] of MACHINE_FILES) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { rows.push({ label, file, exists: false, hits: [] }); continue; }
    const hits = [];
    text.split(/\r?\n/).forEach((line, i) => {
      for (const [why, re] of MACHINE_PATTERNS) {
        re.lastIndex = 0;
        const m = line.match(re);
        if (m) hits.push({ line: i + 1, why, sample: m[0] });
      }
    });
    rows.push({ label, file, exists: true, hits });
  }
  return rows;
}
const machineRows = scanMachine();

if (AS_JSON) {
  console.log(JSON.stringify({ gui: guiScan, dsh: dshScan, roots: rootRows, deps: depRows, data: dataRows, machine: machineRows }, null, 2));
} else {
  console.log('=== ① 被引用的绝对路径根（前 20）===');
  rootRows.slice(0, 20).forEach((r) => console.log('  ' + String(r.count).padStart(5) + '  ' + r.root + '   （' + [...r.where].join('/') + '）'));
  console.log('  —— 共 ' + rootRows.length + ' 个根；工作台 ' + guiScan.files + ' 个文件、引擎 .dsh ' + dshScan.files + ' 个文件含盘符路径');

  console.log('\n=== ② 关键外部依赖 ===');
  for (const d of depRows) {
    const flag = d.exists ? (d.kind === 'dir' ? '✔ ' + mb(d.bytes) + ' / ' + d.files + ' 文件' : '✔ 文件') : '✘ 不存在';
    console.log('  [' + d.how.padEnd(16) + '] ' + flag.padEnd(28) + ' ' + d.label);
    console.log('  ' + ' '.repeat(20) + d.path);
  }
  console.log('\n=== ③ 数据/记忆目录 ===');
  for (const d of dataRows) {
    const flag = d.exists ? (d.kind === 'dir' ? '✔ ' + mb(d.bytes) + ' / ' + d.files + ' 文件' : '✔ 文件') : '✘ 不存在';
    console.log('  [' + d.how.padEnd(16) + '] ' + flag.padEnd(28) + ' ' + d.label);
    console.log('  ' + ' '.repeat(20) + d.path);
  }
  console.log('\n=== ④ 换电脑必须手改的地方（文件:行号）===');
  for (const r of machineRows) {
    if (!r.exists) { console.log('  ✘ 读不到 ' + r.file); continue; }
    console.log('  ' + r.label + '（' + r.hits.length + ' 处）');
    for (const h of r.hits) console.log('     L' + String(h.line).padStart(5) + '  ' + h.why + '  ' + h.sample);
  }

  const missing = [...depRows, ...dataRows].filter((d) => !d.exists && d.how !== 'skip');
  console.log('\n=== 结论 ===');
  console.log('  不存在的依赖 ' + missing.length + ' 个' + (missing.length ? '：' + missing.map((m) => m.label).join('、') : ''));
  console.log('  必须重装/重建：' + [...depRows].filter((d) => d.how === 'reinstall' || d.how === 'build').map((d) => d.label).join('、'));
  console.log('  必须按新机器手改：profile 配置里的绝对路径（node 路径、MCP venv 路径）+ 工作台 main.js 里的引擎目录推定值');
  console.log('  密钥类（复制时注意）：' + [...depRows].filter((d) => d.how === 'copy-secret').map((d) => d.label + ' → ' + d.path).join('、'));
}

// ---------- ③ 可选：写进手册 ----------
if (DO_WRITE) {
  const doc = path.join(GUI, '迁移手册.md');
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const lines = [];
  lines.push('<!-- 本段由 scripts\\迁移清单.mjs --write 生成，时间 ' + stamp + '；手写内容请放本段之外 -->');
  lines.push('');
  lines.push('### 自动清单 · 依赖实况（' + stamp + '）');
  lines.push('');
  lines.push('| 用途 | 路径 | 迁移处理 | 实况 |');
  lines.push('|---|---|---|---|');
  for (const d of [...depRows, ...dataRows]) {
    const flag = d.exists ? (d.kind === 'dir' ? mb(d.bytes) + ' / ' + d.files + ' 文件' : '文件 ' + mb(d.bytes)) : '**不存在**';
    lines.push('| ' + d.label + ' | `' + d.path + '` | ' + d.how + ' | ' + flag + ' |');
  }
  lines.push('');
  lines.push('### 自动清单 · 被引用的绝对路径根（前 20）');
  lines.push('');
  lines.push('| 次数 | 路径根 | 出现在 |');
  lines.push('|---|---|---|');
  for (const r of rootRows.slice(0, 20)) lines.push('| ' + r.count + ' | `' + r.root + '` | ' + [...r.where].join(' / ') + ' |');
  lines.push('');
  const block = lines.join('\n');
  const BEGIN = '<!-- AUTO:MIGRATION:BEGIN -->';
  const END = '<!-- AUTO:MIGRATION:END -->';
  let old = '';
  try { old = fs.readFileSync(doc, 'utf8'); } catch {}
  const wrapped = BEGIN + '\n' + block + '\n' + END;
  let next;
  if (old.includes(BEGIN) && old.includes(END)) {
    next = old.slice(0, old.indexOf(BEGIN)) + wrapped + old.slice(old.indexOf(END) + END.length);
  } else {
    next = (old ? old.replace(/\s*$/, '\n\n') : '# 换电脑 · 一比一复制手册\n\n') + wrapped + '\n';
  }
  fs.writeFileSync(doc, next, 'utf8');
  console.log('\n已写入 ' + doc + '（AUTO 段）');
}
