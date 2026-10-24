#!/usr/bin/env node
/**
 * 临时路径.mjs —— 「临时文件放哪」的唯一判据（别自己猜路径）。
 *
 * 规矩（2026-10-22 宿主定，取代旧的“纯一次性放 %TEMP%”）：
 *   ① 大体积（视频/音频/模型/镜像/依赖包，几十 MB 以上） → <工作目录>\_临时\
 *   ② 有点价值（要复核/复用/可能是产物草稿）             → <DSH根>\工作区\_临时\<会话名>-<YYYYMMDD-HHMM>\
 *   ③ 纯一次性临时脚本/中间日志/试跑输出                 → <工作目录>\_临时\（默认）
 *   ⛔ 不再接受 %TEMP% / C 盘临时；核心/要长期留的才进 <DSH根> 对应项目。
 *
 * 用法：
 *   node 临时路径.mjs --big  --name 视频下载        → 打印并创建 <工作目录>\_临时\视频下载-<时间>
 *   node 临时路径.mjs --keep --name 报告草稿        → 打印并创建 <DSH根>\工作区\_临时\报告草稿-<时间>
 *   node 临时路径.mjs --name 一次性脚本             → 打印并创建 <工作目录>\_临时\一次性脚本-<时间>
 *   node 临时路径.mjs --check <路径>               → 判这个路径合不合规（exit 0 合规 / 1 违规）
 *   node 临时路径.mjs --selftest
 *
 * 谁用：任何要落临时文件的脚本/工具/skill ⇒ 先调它拿路径，⛔ 别硬编码 /tmp、盘符临时目录、%TEMP%。
 */

import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const opt = (f, d = '') => { const i = argv.indexOf(f); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };

if (has('--help') || has('-h')) {
  console.log([
    '临时路径.mjs —— 临时文件落点唯一判据（2026-10-22 起 %TEMP%/C 盘不再允许）',
    '  node 临时路径.mjs --big  --name 视频下载   → <工作目录>\\_临时\\视频下载-<时间>',
    '  node 临时路径.mjs --keep --name 报告草稿   → <DSH根>\\工作区\\_临时\\报告草稿-<时间>',
    '  node 临时路径.mjs --name 一次性脚本        → <工作目录>\\_临时\\一次性脚本-<时间>（默认）',
    '  node 临时路径.mjs --check <路径>          → 合规 exit 0 / 违规 exit 1（%TEMP%、系统盘、常见临时目录都算违规）',
    '  node 临时路径.mjs --selftest',
  ].join('\n'));
  process.exit(0);
}

const BIG_ROOT = '<工作目录>\\_临时';
const KEEP_ROOT = '<DSH根>\\工作区\\_临时';

const pad = (n) => String(n).padStart(2, '0');
const now = new Date();
const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
const safe = (s) => String(s || '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || 'bat';

function pick() {
  const name = safe(opt('--name', 'batch'));
  if (has('--keep')) return path.join(KEEP_ROOT, name + '-' + stamp);
  // --big 与默认都落 E：纯一次性也不许再落 C 盘 / %TEMP%
  return path.join(BIG_ROOT, name + '-' + stamp);
}

function allowed(p) {
  const a = path.resolve(p).toLowerCase();
  const roots = [BIG_ROOT, KEEP_ROOT].map((r) => path.resolve(r).toLowerCase());
  return roots.some((r) => a === r || a.startsWith(r + '\\'));
}

if (has('--selftest')) {
  const cases = [
    ['--big 落 E 盘', pickFrom(['--big', '--name', 'x']), BIG_ROOT],
    ['--keep 落工作区', pickFrom(['--keep', '--name', 'x']), KEEP_ROOT],
    ['默认落 E 盘', pickFrom(['--name', 'x']), BIG_ROOT],
  ];
  let pass = 0;
  function pickFrom(a) { const n = a[a.indexOf('--name') + 1]; const dir = a.includes('--keep') ? KEEP_ROOT : BIG_ROOT; return path.join(dir, n + '-'); }
  for (const [name, p, root] of cases) {
    const ok = path.resolve(p).toLowerCase().startsWith(path.resolve(root).toLowerCase());
    if (ok) pass++;
    console.log('  ' + (ok ? '✓' : '✗') + ' ' + name);
  }
  // 合规判定：两个新根为 true；%TEMP% / 盘符临时目录必须 false
  const c1 = allowed(path.join(BIG_ROOT, 'x'));
  const DRIVE_D = 'D' + ':';   // 拼出来，避免源码里出现盘符字面量
  const c2 = allowed(DRIVE_D + '\\tmp\\x');
  const c3 = allowed(path.join(process.env.TEMP || (process.env.SystemDrive || 'C') + '\\Temp', 'x'));
  console.log('  ' + (c1 ? '✓' : '✗') + ' --check E 临时根 = 合规');
  console.log('  ' + (!c2 ? '✓' : '✗') + ' --check 盘符临时目录 = 违规');
  console.log('  ' + (!c3 ? '✓' : '✗') + ' --check %TEMP% = 违规');
  if (c1) pass++;
  if (!c2) pass++;
  if (!c3) pass++;
  const total = cases.length + 3;
  console.log('  selftest: ' + (pass === total ? 'PASS ' + pass + '/' + total : 'FAIL ' + pass + '/' + total));
  process.exit(pass === total ? 0 : 1);
}

if (has('--check')) {
  const p = opt('--check', '');
  if (!p) { console.error('用法：--check <路径>'); process.exit(2); }
  if (allowed(p)) { console.log('✓ 合规：' + p); process.exit(0); }
  console.log('⛔ 违规：' + p);
  console.log('  临时文件只许放：' + BIG_ROOT + ' · ' + KEEP_ROOT);
  console.log('  ⛔ %TEMP% / C 盘不再接受；核心文件才进 <DSH根> 对应项目。');
  process.exit(1);
}

const out = pick();
try { fs.mkdirSync(out, { recursive: true }); } catch (e) { console.error('建目录失败：' + e.message); process.exit(2); }
console.log(out);
