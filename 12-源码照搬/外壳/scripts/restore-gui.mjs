#!/usr/bin/env node
/**
 * restore-gui.mjs —— 一键回滚到某个源码快照（**GUI 打不开时的救命命令**）
 *
 *   node scripts/restore-gui.mjs                 回滚到最新快照
 *   node scripts/restore-gui.mjs --list          看有哪些快照
 *   node scripts/restore-gui.mjs gui-20260914035126   回滚到指定快照
 *
 * 行为：
 *   1) 先把**当前**源码再打一份快照（前缀 gui-prerestore-），万一回滚错了还能回来
 *   2) 用快照覆盖 main.js / preload.js / renderer\ / scenarios\ / scripts\ 等源码文件
 *   3) 覆盖后自动跑语法检查，告诉你是否可以启动
 *
 * 注意：只动源码，不动 data\ 里的数据库、配置与 node_modules。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BK_DIR = path.join(ROOT, 'data', 'backups');
const FILES = [
  'main.js', 'preload.js', 'stock-store.js', 'oa-store.js', 'oa-ssh.js', 'updater.js', 'crash.js',
  'package.json', 'package-lock.json', 'start.vbs', 'icon.ico', 'icon.png',
  '.gitignore', '项目信息.md', '官方能力搬迁计划.md'
];
const DIRS = ['renderer', 'scenarios', 'scripts'];   // 归档已并入 scenarios\归档（2026-10-16）

const snapshots = () => {
  if (!fs.existsSync(BK_DIR)) return [];
  return fs.readdirSync(BK_DIR)
    .filter((d) => d.startsWith('gui-') && fs.statSync(path.join(BK_DIR, d)).isDirectory())
    .sort();
};

const args = process.argv.slice(2);
if (args.includes('--list')) {
  const all = snapshots();
  console.log('可用快照（新→旧）:');
  console.log(all.length ? all.slice().reverse().map((d) => '  ' + d).join('\n') : '  (无)');
  process.exit(0);
}

const all = snapshots();
if (!all.length) {
  console.error('✗ 没有可用快照。先跑 node scripts/backup-gui.mjs 打一个。');
  process.exit(1);
}

const wanted = args.find((a) => !a.startsWith('--'));
const target = wanted
  ? path.join(BK_DIR, wanted)
  : path.join(BK_DIR, all[all.length - 1]);

if (!fs.existsSync(target)) {
  console.error('✗ 快照不存在: ' + target);
  console.error('  可用: ' + all.join(', '));
  process.exit(1);
}

console.log('将要回滚到: ' + target);

// 1) 回滚前先把当前状态存一份（可反悔）
const _d = new Date();
const _p2 = (n) => String(n).padStart(2, '0');
const stamp = 'gui-prerestore-' + _d.getFullYear() + _p2(_d.getMonth() + 1) + _p2(_d.getDate()) + _p2(_d.getHours()) + _p2(_d.getMinutes()) + _p2(_d.getSeconds());
const pre = path.join(BK_DIR, stamp);
try {
  fs.mkdirSync(pre, { recursive: true });
  for (const f of FILES) if (fs.existsSync(path.join(ROOT, f))) fs.copyFileSync(path.join(ROOT, f), path.join(pre, f));
  for (const d of DIRS) if (fs.existsSync(path.join(ROOT, d))) fs.cpSync(path.join(ROOT, d), path.join(pre, d), { recursive: true });
  console.log('✓ 已备份回滚前的状态: ' + pre);
} catch (e) {
  console.error('✗ 备份当前状态失败，已中止（避免不可逆）: ' + e.message);
  process.exit(1);
}

// 2) 覆盖
let n = 0;
for (const f of FILES) {
  const src = path.join(target, f);
  if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(ROOT, f)); n++; }
}
for (const d of DIRS) {
  const src = path.join(target, d);
  if (!fs.existsSync(src)) continue;
  // 覆盖前先清掉目标目录里的 .js/.json/.md/.ps1/.py（避免快照里已删除的文件残留导致不一致）
  const dstDir = path.join(ROOT, d);
  if (fs.existsSync(dstDir)) {
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.(js|mjs|json|md|ps1|py|css|html)$/i.test(e.name)) { try { fs.rmSync(full); } catch (err) { /* ignore */ } }
      }
    };
    walk(dstDir);
  }
  fs.cpSync(src, dstDir, { recursive: true });
  n++;
}
console.log('✓ 已恢复 ' + n + ' 项源码');

// 3) 语法自检
console.log('\n语法检查:');
let bad = 0;
for (const f of ['main.js', 'preload.js', 'renderer/renderer.js', 'renderer/renderers.js']) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) continue;
  const r = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' });
  if (r.status === 0) console.log('  ✓ ' + f);
  else { bad++; console.log('  ✗ ' + f + '\n' + String(r.stderr || '').split('\n').slice(0, 4).join('\n')); }
}
console.log(bad ? '\n✗ 仍有语法错误，请检查快照内容' : '\n✓ 全部通过，可以启动 GUI（双击 start.vbs）');
