#!/usr/bin/env node
/**
 * 发布.mjs —— 两个"要上公网"的仓库，一条命令走完发布（2026-10-21 宿主：把发布流程变成机制）
 *
 * 为什么必须有它（血泪，全部真实发生）：
 *   · 2 次「git push 退出码 0，但远端根本没变」（管道/包装吃掉了退出码）
 *   · 1 次「其实已经推上去了，但 ls-remote 超时查不到 ⇒ 误判失败，白重推」
 *   · 1 次 commit 消息里带中文双引号 ⇒ PowerShell 字符串被截断 ⇒ 提交静默失败、只推了旧 HEAD
 *   · 1 次站点推上去了，但 Cloudflare 还在部署 ⇒ 立刻去看线上会以为没生效
 * ⇒ 判据只能是一条：**推送成功 = 远端 ref 的 hash == 本地 HEAD 的 hash**；站点还多一条：**线上 200 且内容命中**。
 *
 * 用法：
 *   node <DSH根>\工具\发布.mjs workbench -m "改了什么"      # 公开仓库（要脱敏检查）
 *   node <DSH根>\工具\发布.mjs site      -m "改了什么"      # 个人站（自动等部署 + 探活）
 *   node <DSH根>\工具\发布.mjs all       -m "改了什么"
 *   node <DSH根>\工具\发布.mjs site --dry                  # 只看有什么待推，不提交不推
 *   node <DSH根>\工具\发布.mjs site --probe                # 只探活（不碰 git）
 *   node <DSH根>\工具\发布.mjs site -m "..." --expect "2026.10.21"   # 额外校验线上含某段文字
 *
 * 换设备/换路径：**只改下面 TARGETS 的 repo**，其余不用动。
 * 退出码：0 成功 · 1 失败 · 2 用法/环境错误
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// ── 目标（换设备只改这里）──────────────────────────────────────────────────
const TARGETS = {
  workbench: {
    label: 'GitHub 公开仓库（<作者>的工作台）',
    repo: '<项目目录>\\<作者>的git hub仓库',
    remote: 'origin', branch: 'main',
    // 推之前要跑的"脱敏闸"（存在就执行，输出必须含"残留项 0"）
    gate: { tool: '<项目目录>\\我的官网\\项目信息\\工具\\公开仓库打包.mjs', arg: '--scan-only', must: '残留项 0' },
  },
  site: {
    label: '个人站（Cloudflare Pages）',
    repo: '<项目目录>\\我的官网',
    remote: 'origin', branch: 'main',
    live: { origin: 'https://<站点域名>', paths: ['/', '/dingzhi', '/privacy', '/robots.txt', '/sitemap.xml'] },
    deployWaitSec: 45,          // Cloudflare 部署通常 30~60 秒
  },
};

// ── 小工具 ────────────────────────────────────────────────────────────────
const arg = (n, d = null) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes(n);
const msg = arg('-m', arg('--msg', ''));
const DRY = has('--dry'), PROBE = has('--probe');
const EXPECT = arg('--expect', '');
const sleep = (s) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, s * 1000);
const log = (s) => console.log(s);
const die = (s) => { console.error('⛔ ' + s); process.exit(2); };

function git(repo, ...args) {
  try {
    return { ok: true, out: execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() };
  } catch (e) {
    return { ok: false, out: ((e.stdout || '') + (e.stderr || '')).trim() || String(e.message || e) };
  }
}
async function http(url, timeoutMs = 20000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal, redirect: 'follow' });
    const text = await r.text();
    return { status: r.status, text };
  } catch (e) {
    return { status: 0, text: '', err: String(e.message || e) };
  } finally { clearTimeout(t); }
}

// ── 单目标发布 ────────────────────────────────────────────────────────────
async function publish(name) {
  const T = TARGETS[name];
  if (!T) die('不认识的目标：' + name + '（可用：' + Object.keys(TARGETS).join(' / ') + '）');
  if (!fs.existsSync(T.repo)) die('仓库不存在：' + T.repo + '\n   ⇒ 换设备了？请改本文件顶部 TARGETS.' + name + '.repo');

  log('\n━━━━ ' + T.label + ' ━━━━');
  log('  仓库：' + T.repo);

  // ① 脱敏闸（只有公开仓库有）
  // ⛔ 红线（dg-dsh 2026-10-21 审出）：**闸门工具缺失 = 拒绝发布**，不许"跳过"。
  //   换设备时 TARGETS 的路径必然要改，一旦这里写成 skip，就会"静默放行"——比没有闸门更危险。
  if (T.gate) {
    if (!fs.existsSync(T.gate.tool)) {
      die('脱敏闸工具不存在 ⇒ 拒绝发布（不许在没闸门的情况下推公开仓库）\n'
        + '   缺的是：' + T.gate.tool + '\n'
        + '   ⇒ 换设备了？请改本文件顶部 TARGETS.' + name + '.gate.tool，或装回该工具后再发。');
    }
    log('  ① 脱敏闸：' + path.basename(T.gate.tool));
    // ⚠ 闸门失败时 execFileSync 会抛（exit 1）⇒ 必须接住，否则工具的结论变成一句堆栈
    let out = '';
    try {
      out = String(execFileSync('node', [T.gate.tool, T.gate.arg], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    } catch (e) {
      out = String((e.stdout || '') + (e.stderr || ''));
    }
    const last = out.trim().split('\n').filter(Boolean).slice(-1)[0] || '（无输出）';
    log('     ' + last);
    if (!out.includes(T.gate.must)) die('脱敏闸没通过（输出里没有「' + T.gate.must + '」）⇒ 不许推');
  } else log('  ① 脱敏闸：无（这个仓库不含个人信息，或已另有闸门）');

  // ② 待推内容
  const head = git(T.repo, 'rev-parse', 'HEAD');
  if (!head.ok) die('不是 git 仓库：' + T.repo);
  const dirty = git(T.repo, 'status', '--porcelain').out;
  const ahead0 = Number(git(T.repo, 'rev-list', '--count', T.remote + '/' + T.branch + '..HEAD').out || '0');

  if (dirty) {
    log('  ② 未提交改动 ' + dirty.split('\n').length + ' 项：');
    dirty.split('\n').slice(0, 8).forEach((l) => log('     ' + l));
    if (DRY) log('     （--dry：不提交）');
    else {
      if (!msg) die('有改动但没给提交说明 ⇒ 加 -m "改了什么"（别让工具替你编一句话）');
      git(T.repo, 'add', '-A');
      const c = git(T.repo, 'commit', '-m', msg);
      if (!c.ok) die('提交失败：' + c.out.slice(0, 200));
      log('     ✓ 已提交：' + git(T.repo, 'rev-parse', '--short', 'HEAD').out);
    }
  } else log('  ② 工作区干净，无需提交');

  const local = git(T.repo, 'rev-parse', '--short', 'HEAD').out;
  if (DRY) { log('  （--dry：本地 ' + local + '，待推 ' + ahead0 + ' 个提交，不推）'); return true; }

  // ③ 推 + 校验（判据 = hash）
  let pushed = false;
  for (let i = 1; i <= 10; i++) {
    const p = git(T.repo, 'push', T.remote, T.branch);
    git(T.repo, 'fetch', T.remote, T.branch);
    const remote = git(T.repo, 'rev-parse', T.remote + '/' + T.branch);
    if (remote.ok && remote.out === git(T.repo, 'rev-parse', 'HEAD').out) {
      log('  ③ 推送成功：' + T.remote + '/' + T.branch + ' = ' + local + '（第 ' + i + ' 次尝试）');
      pushed = true; break;
    }
    log('     第 ' + i + ' 次未成功（远端 ' + (remote.ok ? remote.out.slice(0, 7) : '查询失败') + '）'
      + (p.ok ? '' : '｜' + p.out.split('\n').slice(-1)[0].slice(0, 70)));
    if (i < 10) sleep(4);
  }
  if (!pushed) { log('  ⛔ 推不上去（10 次）。本地 ' + local + ' 仍在，网络恢复后再跑一次即可，别重做工作'); return false; }

  // ④ 线上探活（只有站点有）
  if (T.live) {
    log('  ④ 等 Cloudflare 部署 ' + T.deployWaitSec + ' 秒…');
    sleep(T.deployWaitSec);
    let allOk = true;
    for (const p of T.live.paths) {
      const u = T.live.origin + p;
      let r = await http(u);
      if (r.status !== 200) { sleep(15); r = await http(u); }      // 部署慢时再等一轮
      const ok = r.status === 200;
      allOk = allOk && ok;
      log('     ' + (ok ? '✓' : '⛔') + ' ' + p + ' → ' + (r.status || ('失败：' + (r.err || '').slice(0, 40))));
    }
    if (EXPECT) {
      const home = await http(T.live.origin + '/');
      const hit = home.text.includes(EXPECT);
      log('     ' + (hit ? '✓' : '⛔') + ' 首页含「' + EXPECT + '」：' + (hit ? '已上线' : '没找到（可能还在部署）'));
      allOk = allOk && hit;
    }
    return allOk;
  }
  return true;
}

// ── 入口 ──────────────────────────────────────────────────────────────────
const which = process.argv.slice(2).find((a) => !a.startsWith('--') && !a.startsWith('-') && TARGETS[a]) || '';
if (!which) die('用法：node 发布.mjs <workbench|site|all> [-m "提交说明"] [--dry] [--probe] [--expect 文本]');

if (PROBE) {
  const T = TARGETS[which];
  if (!T || !T.live) die(which + ' 没有线上地址可探');
  let ok = true;
  for (const p of T.live.paths) {
    const r = await http(T.live.origin + p);
    const good = r.status === 200;
    ok = ok && good;
    log((good ? '✓ ' : '⛔ ') + p + ' → ' + (r.status || r.err));
  }
  process.exit(ok ? 0 : 1);
}

const list = which === 'all' ? ['workbench', 'site'] : [which];
let allOk = true;
for (const n of list) allOk = (await publish(n)) && allOk;
log('\n' + (allOk ? '✅ 全部完成' : '⛔ 有步骤没通过（本地提交都在，别重做）'));
process.exit(allOk ? 0 : 1);
