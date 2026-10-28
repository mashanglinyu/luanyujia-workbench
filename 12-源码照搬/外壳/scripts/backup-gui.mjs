#!/usr/bin/env node
/**
 * backup-gui.mjs —— 给工作台源码打快照（改任何东西之前先跑它）
 *
 *   node scripts/backup-gui.mjs            打一个快照
 *   node scripts/backup-gui.mjs --list     列出已有快照
 *
 * 快照位置：<GUI>\data\backups\gui-<时间戳>\
 * 只备份源码（不含 node_modules / data 里的库 / captures / 日志），默认只保留最近 5 个（2026-10-24 宿主定）。
 * 配套恢复：node scripts/restore-gui.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BK_DIR = path.join(ROOT, 'data', 'backups');
const KEEP = 5;   // 2026-10-24 宿主：界面回退和引擎回退都只留 5 份

// 要备份的源码清单（新增顶层文件/目录时记得加进来）
const FILES = [
  'main.js', 'preload.js', 'stock-store.js', 'oa-store.js', 'oa-ssh.js', 'updater.js', 'crash.js',
  'package.json', 'package-lock.json', 'start.vbs', 'icon.ico', 'icon.png',
  '.gitignore', '项目信息.md', 'GUI改造私有记忆.md', '官方能力搬迁计划.md', '迁移手册.md'
];
const DIRS = ['renderer', 'scenarios', 'scripts', 'GUI改造的项目信息'];   // 归档已并入 scenarios\归档（2026-10-16）

const list = () => {
  if (!fs.existsSync(BK_DIR)) return [];
  return fs.readdirSync(BK_DIR).filter((d) => d.startsWith('gui-')).sort();
};

if (process.argv.includes('--list')) {
  const all = list();
  console.log(all.length ? all.map((d) => '  ' + d).join('\n') : '  (还没有快照)');
  process.exit(0);
}

// ⚠ 先清理旧快照，再复制新快照。
// 原因（真踩过）：清理放在复制之后时，只要这个脚本被中途掐断（例如 `node scripts\backup-gui.mjs | Select-Object -First 1`
// 会在第一行输出后关掉管道 → node 被终止），清理代码就永远跑不到 → 快照会从 10 涨到 20、30……
// 放到前面 = 即使被掐断，数量也只会 ≤ 上限。
const prune = () => {
  const all = list();
  if (all.length < KEEP) return [];
  const removed = [];
  for (const old of all.slice(0, Math.max(0, all.length - KEEP + 1))) {
    try { fs.rmSync(path.join(BK_DIR, old), { recursive: true, force: true }); removed.push(old); }
    catch (e) { console.log('  ! 旧快照删不掉（可能被占用）：' + old + ' → ' + (e && e.message)); }
  }
  return removed;
};
const removedBefore = prune();

fs.mkdirSync(BK_DIR, { recursive: true });
// 本地时间戳（与 restore/pre 快照命名一致，便于排序与辨认）
const d = new Date();
const p2 = (n) => String(n).padStart(2, '0');
const stamp = '' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
const dst = path.join(BK_DIR, 'gui-' + stamp);
fs.mkdirSync(dst, { recursive: true });

let n = 0;
for (const f of FILES) {
  const src = path.join(ROOT, f);
  if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(dst, f)); n++; }
}
for (const dir of DIRS) {
  const src = path.join(ROOT, dir);
  if (fs.existsSync(src)) { fs.cpSync(src, path.join(dst, dir), { recursive: true }); n++; }
}

console.log('✓ 快照完成: ' + dst);
for (const old of removedBefore) console.log('  已清理旧快照: ' + old);
console.log('  当前快照 ' + list().length + ' 个（上限 ' + KEEP + '）');
console.log('  回滚命令: node scripts/restore-gui.mjs');
