#!/usr/bin/env node
/**
 * 临时哨兵.mjs —— 把「临时文件只能放两处」这条规矩变成可执行的检查。
 *
 * 规矩（2026-10-19 宿主定，见 AGENTS「临时文件分三档放」）：
 *   ① 大体积 → <工作目录>\_临时\        （视频/音频/模型/镜像/依赖包）
 *   ② 有价值 → <DSH根>\工作区\_临时\<会话名>-<时间>\
 *   ③ 一次性 → %TEMP%
 *   ⇒ 除这三处以外，**不该有临时文件**。
 *
 * 用法：
 *   node 临时哨兵.mjs              人类可读报告（有违规 exit 1）
 *   node 临时哨兵.mjs --json       机器可读（体检用）
 *   node 临时哨兵.mjs --selftest   自测（含"应当失败"反例）
 *
 * 判据设计（宁可漏报，不许天天狼来了）：
 *   ⛔ 违规：允许区外出现"临时特征"的文件/目录（名字/后缀命中），或 <工作目录> 根层丢文件
 *   ⚠ 提醒：<工作目录> 顶层出现白名单外的新目录（顶层白名单制）
 *   ✓ 允许区：<工作目录>\_临时、<DSH根>\工作区\_临时、%TEMP%
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const SELFTEST = argv.includes('--selftest');

/* ─────────────────────────── 规则表 ─────────────────────────── */

/** 允许放临时文件的地方（绝对路径前缀，小写比较） */
const ALLOWED = [
  '<工作目录>\\_临时',
  path.join('<DSH根>\\工作区\\_临时'),
].map((p) => p.toLowerCase()).filter(Boolean);

/** 这些目录**不扫**（代码库/数据/备份里 .tmp/.bak 是正常的） */
const SKIP_ABS = [
  '<DSH根>\\引擎', '<DSH根>\\外壳', '<DSH根>\\启动器', '<DSH根>\\备份', '<DSH根>\\自我复盘', '<DSH根>\\会话档案',
  '<DSH根>\\工具', '<DSH根>\\说明',
  '<DSH根>\\工作区\\.wrangler',   // wrangler 自己的 cache/tmp（站点工具用，不是场景临时文件）
  '<工作目录>\\_文档', '<工作目录>\\_项目文件', '<工作目录>\\_存档_<客户> '<工作目录>\\_审计_<客户>
  '<工作目录>\\_修复_<客户> '<工作目录>\\_site', '<工作目录>\\_webai产物', '<工作目录>\\_任务单编制',
  '<工作目录>\\_更新feed', '<工作目录>\\截图位置', '<工作目录>\\_临时',
  '<工作目录>\\_oa_tmp',   // 白名单目录，但名字带 tmp ⇒ 单独加进跳过表，避免被临时名判据误伤
].map((p) => p.toLowerCase());

/** <工作目录> 根层**允许**的文件（入口三件套） */
const DEEPSEEK_ROOT_OK_FILES = new Set(['readme.md', '_目录地图.md', 'dsh调用逻辑与效率手册.md'].map((s) => s.toLowerCase()));

/** <工作目录> 顶层白名单目录（不在表里的 = 新夹子，要宿主批准） */
const DEEPSEEK_TOP_OK = new Set([
  '_apkchk', '_oa_mt_out', '_oa_tmp', '_site', '_webai产物', '_临时', '_任务单编制', '_修复_<客户>
  '_存档_<客户> '_审计_<客户> '_排查脚本存档-旧-20261018', '_文档', '_更新feed', '_项目文件', '截图位置',
  'models',   // 2026-10-20：本地模型（Qwen2.5-7B，宿主批准），只读资产
  '<作者>的git hub仓库',   // 2026-10-21：迁 <DSH根>\项目 后旧位保留的 Junction（宿主批准）
].map((s) => s.toLowerCase()));

/** 临时特征：名字命中就叫"像临时" */
const TEMP_NAME = /(^|[\\_\-\s.()【】])(temp|tmp|临时|未命名|新建文件夹|新建|副本|copy|备份文件|untitled|scratch|试跑|草稿|draft)([\\_\-\s.()【】\d]|$)/i;
const TEMP_EXT = /\.(tmp|temp|part|crdownload|partial|download|!ut)$/i;
const TEMP_PREFIX = /^~\$/;   // Office 锁文件

/* ─────────────────────────── 扫描 ─────────────────────────── */

function isUnder(p, root) {
  const a = p.toLowerCase();
  return a === root || a.startsWith(root.endsWith('\\') ? root : root + '\\');
}
const isAllowed = (p) => ALLOWED.some((r) => isUnder(p, r));
const isSkipped = (p) => SKIP_ABS.some((r) => isUnder(p, r));

function lookTempy(name) {
  return TEMP_NAME.test(name) || TEMP_EXT.test(name) || TEMP_PREFIX.test(name);
}

function statOf(p) {
  try {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      let mb = 0;
      (function w(d, depth) {
        if (depth > 3) return;
        let es = [];
        try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of es) {
          const f = path.join(d, e.name);
          if (e.isDirectory()) w(f, depth + 1);
          else if (e.isFile()) { try { mb += fs.statSync(f).size; } catch { } }
        }
      })(p, 0);
      return { dir: true, mb: Math.round(mb / 1048576), at: st.mtime };
    }
    return { dir: false, mb: Math.round(st.size / 1048576), at: st.mtime };
  } catch { return null; }
}

const bad = [];   // { tier, path, why, mb }
const warn = [];
const scanned = { roots: 0, entries: 0 };
/** WorkBuddy/pnpm 安装时的盘根暂存（_tmp_<pid>_<hex>）；2 小时内视为进行中，不报。 */
const PNPM_STAGING = /^_tmp_\d+_[0-9a-f]{32}$/i;

/** 扫一层（不递归进允许区/跳过区），把"临时特征"记下来 */
function scanLevel(dir, depth, maxDepth) {
  if (depth > maxDepth) return;
  if (isAllowed(dir) || isSkipped(dir)) return;
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  scanned.entries += ents.length;
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (isAllowed(p) || isSkipped(p)) continue;
    const st = statOf(p);
    if (!st) continue;
    if (lookTempy(e.name)) {
      bad.push({
        tier: st.dir ? 'dir' : 'file',
        path: p,
        why: TEMP_EXT.test(e.name) ? '后缀是临时文件' : TEMP_NAME.test(e.name) ? '名字像临时/副本/未命名' : 'Office 锁文件',
        mb: st.mb,
      });
      continue;   // 已判违规，不再往里钻
    }
    if (e.isDirectory() && depth < maxDepth) scanLevel(p, depth + 1, maxDepth);
  }
}

// ① <工作目录> 根层：不许丢文件；顶层目录要在白名单
if (fs.existsSync('<工作目录>')) {
  scanned.roots++;
  let ents = [];
  try { ents = fs.readdirSync('<工作目录>', { withFileTypes: true }); } catch { }
  for (const e of ents) {
    const p = path.join('<工作目录>', e.name);
    if (e.isFile()) {
      if (!DEEPSEEK_ROOT_OK_FILES.has(e.name.toLowerCase())) {
        const st = statOf(p);
        bad.push({ tier: 'rootfile', path: p, why: '<工作目录> 根层不许放文件（只有入口三件套允许）', mb: st ? st.mb : 0 });
      }
      continue;
    }
    if (!DEEPSEEK_TOP_OK.has(e.name.toLowerCase())) {
      warn.push({ path: p, why: '<工作目录> 顶层新目录（白名单外 ⇒ 要宿主批准后登记）' });
      continue;
    }
    // 白名单目录（含 _oa_tmp / _临时 这种"名字像临时但合法"的）不按临时名判
  }
  // _临时 以外，深两层找临时特征
  scanLevel('<工作目录>', 0, 2);
}

// ② <DSH根> 各顶层（工作区除外，它有自己的 _临时）
if (fs.existsSync('<DSH根>')) {
  scanned.roots++;
  let ents = [];
  try { ents = fs.readdirSync('<DSH根>', { withFileTypes: true }); } catch { }
  for (const e of ents) {
    const p = path.join('<DSH根>', e.name);
    if (isSkipped(p) || isAllowed(p)) continue;
    if (e.isFile()) {
      if (lookTempy(e.name)) {
        const st = statOf(p);
        bad.push({ tier: 'file', path: p, why: '<DSH根> 根层出现临时文件', mb: st ? st.mb : 0 });
      }
      continue;
    }
    // 工作区只扫它自己的顶层（_临时 在里面，会命中允许区）
    scanLevel(p, 1, 2);
  }
}

// ③ 盘根 + 桌面（最常见的"顺手丢"）
const SCAN_DRIVES = (process.env.DSH_SCAN_DRIVES || 'D,E,F').split(',').map((x) => x.trim() + ':\\');
for (const d of SCAN_DRIVES) {   // ⛔ 系统盘根不扫：DumpStack / WRP*.tmp / pagefile 都是系统的，扫了必误报
  if (!fs.existsSync(d)) continue;
  scanned.roots++;
  let ents = [];
  try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
  for (const e of ents) {
    const p = path.join(d, e.name);
    if (isAllowed(p) || isSkipped(p)) continue;
    // 2026-10-21：pnpm/WorkBuddy 安装会在 E:\ 根建 _tmp_<pid>_<hex>，安装中不误报；>2h 仍报。
    if (d === SCAN_DRIVES[1] && PNPM_STAGING.test(e.name)) {
      const st0 = statOf(p);
      if (st0 && (Date.now() - st0.at.getTime()) < 2 * 3600 * 1000) continue;
    }
    if (lookTempy(e.name)) {
      const st = statOf(p);
      bad.push({ tier: st && st.dir ? 'dir' : 'file', path: p, why: '盘根出现临时特征', mb: st ? st.mb : 0 });
    }
  }
}
const desktop = path.join(os.homedir(), 'Desktop');
if (fs.existsSync(desktop)) {
  scanned.roots++;
  let ents = [];
  try { ents = fs.readdirSync(desktop, { withFileTypes: true }); } catch { }
  for (const e of ents) {
    if (!lookTempy(e.name)) continue;
    const st = statOf(path.join(desktop, e.name));
    bad.push({ tier: st && st.dir ? 'dir' : 'file', path: path.join(desktop, e.name), why: '桌面出现临时特征', mb: st ? st.mb : 0 });
  }
}

// 2026-10-22：C 盘 %TEMP% 也不再是允许区。只扫“像场景/agent 留下的”顶层条目
// （不列系统缓存），作为 ⚠ 提醒，不让它把系统正常的 Temp 当成 ⛔。
const CTEMP = os.tmpdir();
const CTEMP_RE = /^(dsh-|batch-|lc-|HeadlessEdge|grid-profile|code-mem|assign-|create-|move-|archive-|fix-|scan-|boot-|jz-|wb-|node-compile-cache)/i;
if (fs.existsSync(CTEMP)) {
  scanned.roots++;
  let ents = [];
  try { ents = fs.readdirSync(CTEMP, { withFileTypes: true }); } catch { }
  scanned.entries += ents.length;
  const cTempItems = [];
  const cTempImgs = [];
  for (const e of ents) {
    const full = path.join(CTEMP, e.name);
    if (CTEMP_RE.test(e.name)) {
      const st = statOf(full);
      cTempItems.push({ name: e.name, mb: st ? st.mb : 0 });
    }
    if (e.isFile() && /\.(png|jpe?g)$/i.test(e.name)) {
      try {
        const st = fs.statSync(full);
        if (Date.now() - st.mtimeMs < 24 * 3600 * 1000) cTempImgs.push({ name: e.name, mb: st.size / 1048576 });
      } catch { /* skip */ }
    }
  }
  if (cTempItems.length || cTempImgs.length) {
    const cTempMb = cTempItems.reduce((n, x) => n + x.mb, 0);
    const top = cTempItems.slice(0, 3).map((x) => x.name).join(' / ') || '—';
    const imgMb = cTempImgs.reduce((n, x) => n + x.mb, 0);
    const imgNote = cTempImgs.length ? `；24h 新增截图 ${cTempImgs.length} 个 / ${imgMb.toFixed(1)} MB` : '';
    warn.push({ path: CTEMP, why: `C 盘 %TEMP% 场景残留 ${cTempItems.length} 项 / ${cTempMb} MB（如 ${top}）${imgNote}`, mb: cTempMb + imgMb });
  }
}

/* ─────────────────────────── 自测 ─────────────────────────── */

if (SELFTEST) {
  const cases = [
    ['临时特征名', 'aaa\\tmp', true],
    ['副本', '工作\\项目 - 副本', true],
    ['Office 锁', '~$报告.docx', true],
    ['.part', 'a\\b.iso.part', true],
    ['正常文件夹', '引擎\\项目信息.md', false],
    ['正常名含 temp 的合法词', 'template', false],
  ];
  let pass = 0;
  for (const [name, p, want] of cases) {
    const got = lookTempy(path.basename(p));
    const ok = got === want;
    if (ok) pass++;
    console.log('  ' + (ok ? '✓' : '✗') + ' ' + name.padEnd(14) + ' 期望 ' + want + ' 实际 ' + got);
  }
  // 允许区判定反例：允许区里的临时名**不该**算违规
  const allowedOk = isAllowed('<工作目录>\\_临时\\x\\a.tmp') && isAllowed('<DSH根>\\工作区\\_临时\\s-1\\a.tmp');
  console.log('  ' + (allowedOk ? '✓' : '✗') + ' 允许区判定（_临时 内不报）');
  if (allowedOk) pass++;
  console.log('  selftest: ' + (pass === cases.length + 1 ? 'PASS ' + pass + '/' + (cases.length + 1) : 'FAIL ' + pass + '/' + (cases.length + 1)));
  process.exit(pass === cases.length + 1 ? 0 : 1);
}

/* ─────────────────────────── 输出 ─────────────────────────── */

if (JSON_OUT) {
  console.log(JSON.stringify({
    ok: bad.length === 0,
    allowed: ALLOWED,
    scanned,
    bad: bad.map((b) => ({ ...b, mb: b.mb })),
    warn,
    at: new Date().toISOString(),
  }, null, 2));
  process.exit(bad.length ? 1 : 0);
}

console.log('临时哨兵：⛔ ' + bad.length + ' 条 · ⚠ ' + warn.length + ' 条');
console.log('  ✓ 允许区：<工作目录>\\_临时 · <DSH根>\\工作区\\_临时（⛔ C 盘 %TEMP% 不再允许）');
console.log('  扫了 ' + scanned.roots + ' 个根 · ' + scanned.entries + ' 个条目');
if (bad.length) {
  console.log('\n  ⛔ 违规（这些地方不该有临时文件）：');
  for (const b of bad.slice(0, 20)) {
    console.log('     ' + (b.mb >= 1 ? b.mb + ' MB  ' : '') + b.path);
    console.log('        理由：' + b.why);
  }
  if (bad.length > 20) console.log('     …共 ' + bad.length + ' 条（--json 看全部）');
  console.log('\n  处理：① 大体积移 <工作目录>\\_临时\\ ② 有价值的移 <DSH根>\\工作区\\_临时\\<会话>-<时间>\\ ③ 没用的删');
}
if (warn.length) {
  console.log('\n  ⚠ 提醒（C 盘 %TEMP% 残留 / <工作目录> 顶层白名单外新目录）：');
  for (const w of warn.slice(0, 12)) console.log('     ' + (w.mb >= 1 ? w.mb + ' MB  ' : '') + w.path + (w.why ? ' — ' + w.why : ''));
  if (warn.length > 12) console.log('     …共 ' + warn.length + ' 条（--json 看全部）');
}
if (!bad.length && !warn.length) console.log('  ✓ 合规：允许区外没发现临时文件');
process.exit(bad.length ? 1 : 0);
