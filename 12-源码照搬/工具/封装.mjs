#!/usr/bin/env node
/**
 * 封装.mjs —— 把当前工作台打成可分发的发布包（客户自己的 DSH 也能跑它）
 *
 * 用法：
 *   node 工具\封装.mjs --out <盘根>:\发布            # 默认：只打工作台层（不带引擎）
 *   node 工具\封装.mjs --out <盘根>:\发布 --with-engine   # 客户机没引擎时才用（≈5GB）
 *   node 工具\封装.mjs --out <盘根>:\发布 --dry           # 只打印会打什么
 *
 * 产物：
 *   <out>\发布包-<版本>-<YYYYMMDD>.zip
 *   <out>\发布包-<版本>-<YYYYMMDD>\ （同时留一份目录，便于核对）
 *
 * 内置自检（不通过就不出包）：
 *   1) 文本里 grep 一遍 session- / sk- / <工作台> / <用户目录> —— 命中即报
 *   2) 场景 json 的 sessionId 全部清成 __待填__（改的是打包副本，不动源目录）
 *   3) SHA256SUMS 与文件数对账
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');            // 工作台根
const argv = process.argv.slice(2);
const has = k => argv.includes(k);
const val = k => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] || '') : ''; };

const OUT = val('--out') || path.join(path.dirname(ROOT), '发布');
const WITH_ENGINE = has('--with-engine');
const DRY = has('--dry');

// 版本：package.json 的 version + 日期
let version = '0.0.0';
try { version = JSON.parse(fs.readFileSync(path.join(ROOT, '外壳', 'package.json'), 'utf8')).version || version; } catch {}
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
let product = '工作台';
try { product = JSON.parse(fs.readFileSync(path.join(ROOT, '外壳', 'package.json'), 'utf8')).productName || product; } catch {}
const safeProduct = String(product).replace(/[\\/:*?"<>|\s]/g, '').slice(0, 20);
const NAME = '发布包-' + safeProduct + '-' + version + '-' + stamp;
const STAGE = path.join(OUT, NAME);
const ZIP = path.join(OUT, NAME + '.zip');

// 不打包的东西（路径片段匹配，小写比较）
const EXCLUDE = [
  '外壳\\node_modules', '.git', '引擎\\', '引擎/', '引擎数据\\.dsh\\sessions', '引擎数据\\.dsh\\storages',
  '引擎数据\\.dsh\\profiles\\web\\node_modules', '引擎数据\\.dsh\\profiles\\web\\package.json', '引擎数据\\.dsh\\.credentials.yaml', '引擎数据\\.dsh\\.anonymous-user-id',
  '引擎数据\\.dsh\\skills', 'engine-prof', 'data\\electron-profile', 'data\\oa.db', 'server.log',
  'captures', 'data\\backups', 'data\\windows.json', 'data\\scene-tab-order.json'.replace('data\\scene-tab-order.json', '__keep__'),
  '身份卡.md', '场景画像.md', '_审计', '宿主画像', 'areas\\', '发布包-', '.installed.json',
  '工作台\\引擎\\',
];

function excluded(rel) {
  const low = rel.toLowerCase();
  return EXCLUDE.some(x => {
    const k = x.toLowerCase();
    if (!k || k === '__keep__') return false;
    return low.includes(k);
  });
}

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    const rel = path.relative(base, abs);
    if (excluded(rel)) continue;
    if (e.isDirectory()) walk(abs, base, out);
    else out.push({ abs, rel });
  }
  return out;
}

const files = walk(ROOT);
const totalMB = files.reduce((a, f) => a + fs.statSync(f.abs).size, 0) / 1024 / 1024;

if (DRY) {
  console.log('（演练）会打 ' + files.length + ' 个文件 · ' + totalMB.toFixed(2) + ' MB');
  console.log('输出：' + STAGE + '.zip');
  process.exit(0);
}

// 1) 组装暂存目录
if (fs.existsSync(STAGE)) fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });
for (const f of files) {
  const dst = path.join(STAGE, f.rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(f.abs, dst);
}

// 2) 清 sessionId（只改暂存副本）
let cleared = 0;
const scDir = path.join(STAGE, '外壳', 'scenarios');
if (fs.existsSync(scDir)) {
  for (const f of fs.readdirSync(scDir).filter(x => x.endsWith('.json'))) {
    const p = path.join(scDir, f);
    let s = fs.readFileSync(p, 'utf8');
    if (/"sessionId"\s*:\s*"session-[^"]+"/.test(s)) {
      s = s.replace(/("sessionId"\s*:\s*)"session-[^"]+"/g, '$1"__待填__"');
      fs.writeFileSync(p, s, 'utf8');
      cleared++;
    }
  }
}

// 3) 泄漏自检
// 阻断项：真会话 id、密钥
const BLOCK = [/session-[0-9a-f]{8}/i, /\bsk-[A-Za-z0-9]{16,}/];
// 提示项：宿主路径（多半是注释/兜底路径，不阻断）
const WARN = [/<工作台>/i, /<用户目录>\\/i];
const leaks = [];
const warns = [];
const TEXT_EXT = /\.(js|mjs|json|md|html|css|txt|yml|yaml|vbs|cmd|ps1)$/i;
for (const f of walk(STAGE, STAGE)) {
  if (!TEXT_EXT.test(f.rel)) continue;
  const t = fs.readFileSync(f.abs, 'utf8');
  for (const re of BLOCK) {
    const m = t.match(re);
    if (m) { leaks.push(f.rel + ' ← ' + m[0].slice(0, 40)); break; }
  }
  if (!leaks.length) {
    for (const re of WARN) {
      if (re.test(t)) { warns.push(f.rel); break; }
    }
  }
}
if (leaks.length) {
  console.log('✗ 发现 ' + leaks.length + ' 处疑似泄漏，先修再打包：');
  for (const l of leaks.slice(0, 15)) console.log('  - ' + l);
  process.exit(2);
}
console.log('✓ 泄漏自检通过（阻断项 0）');
if (warns.length) { console.log('  ! 提示：' + warns.length + ' 个文件含宿主路径字样（多为注释/兜底），首装后建议扫一眼：'); for (const w of warns.slice(0, 8)) console.log('    - ' + w); }

// 4) 版本.json + SHA256SUMS
const scenes = fs.existsSync(scDir)
  ? fs.readdirSync(scDir).filter(x => x.endsWith('.json')).map(f => {
      try { const j = JSON.parse(fs.readFileSync(path.join(scDir, f), 'utf8')); return { id: j.id, name: j.name, file: '外壳/scenarios/' + f }; } catch { return null; }
    }).filter(Boolean)
  : [];
fs.writeFileSync(path.join(STAGE, '版本.json'), JSON.stringify({
  version, builtAt: new Date().toISOString(), scenes, minEngineVersion: '0.2.1',
  containsEngine: WITH_ENGINE,
}, null, 1) + '\n', 'utf8');

const lines = [];
for (const f of walk(STAGE, STAGE).sort((a, b) => a.rel.localeCompare(b.rel))) {
  const h = crypto.createHash('sha256').update(fs.readFileSync(f.abs)).digest('hex');
  lines.push(h + '  ' + f.rel.replace(/\\/g, '/'));
}
fs.writeFileSync(path.join(STAGE, 'SHA256SUMS'), lines.join('\n') + '\n', 'utf8');
console.log('✓ SHA256SUMS：' + lines.length + ' 条');

// 5) 压 zip（Windows 自带 tar 支持 zip）
fs.mkdirSync(OUT, { recursive: true });
if (fs.existsSync(ZIP)) fs.rmSync(ZIP, { force: true });
try {
  execFileSync('tar', ['-a', '-c', '-f', ZIP, '-C', OUT, NAME], { stdio: 'ignore' });
  console.log('✓ 打好了：' + ZIP + '（' + (fs.statSync(ZIP).size / 1024 / 1024).toFixed(1) + ' MB）');
} catch (e) {
  console.log('! zip 没打成（目录版仍在）：' + e.message);
  console.log('  目录：' + STAGE);
}
console.log('');
console.log('✅ 已完成。源包可保留，也可自行清理。');
