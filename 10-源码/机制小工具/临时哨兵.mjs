#!/usr/bin/env node
// 临时哨兵（公开版·简化）
// ---------------------------------------------------------------------------
// 作用：扫「不该出现临时文件的地方」——工作区、场景记忆、说明目录里出现
//       .tmp / .bak / ~$ 这类文件就报出来，避免临时件混进长期资产。
//
// ⚠ 这份是**简化公开版**：原版带机主本机路径、白名单与阈值，不能原样公开。
//   这里只保留判据骨架，路径全用占位符，跑起来只做「列出来」，不删任何东西。
//
// 用法：node 临时哨兵.mjs [--root <要扫的根目录>] [--dry]
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const ROOT = path.resolve(val('--root', '.'));
const DRY = argv.includes('--dry');

// 临时件的名字特征（判据骨架，可按需改）
const TMP_NAME = /(^~\$)|(\.tmp$)|(\.bak$)|(\.swp$)|(\.part$)|(\.crdownload$)/i;

// 这些目录**不扫**：代码库 / 数据 / 备份里的 .tmp 是正常的
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage',
  '引擎', '启动器', '备份', '会话档案', '模型',
].map((s) => s.toLowerCase()));

// 只扫这些「资产目录」（占位：按你的实际结构改）
const WATCH_DIRS = ['.', '工作区', '说明', '场景记忆'];

const hits = [];
function walk(dir, depth) {
  if (depth > 6) return;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name.toLowerCase())) continue;
      walk(full, depth + 1);
      continue;
    }
    if (TMP_NAME.test(e.name)) hits.push(path.relative(ROOT, full));
  }
}

for (const d of WATCH_DIRS) {
  const full = path.resolve(ROOT, d);
  if (!fs.existsSync(full)) continue;
  walk(full, 0);
}

if (!hits.length) {
  console.log('✓ 临时哨兵：没发现临时文件（' + ROOT + '）');
  process.exit(0);
}

console.log('⚠ 临时哨兵：发现 ' + hits.length + ' 个临时件（只列不删）');
for (const h of hits.slice(0, 50)) console.log('  · ' + h);
if (hits.length > 50) console.log('  … 其余 ' + (hits.length - 50) + ' 个略');

if (!DRY) {
  console.log('\n处置建议：确认无用后自己删，或交给「本地电脑」场景统一清理（本脚本不改任何文件）。');
}
process.exit(1);
