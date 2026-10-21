#!/usr/bin/env node
// ── sessions.mjs —— 会话与面板的绑定/轮换/归档（"多场景 AI"的心脏）
// 摘自本机实现 `sessions.mjs` 的 全文。
// 脱敏：内部 API 名已去品牌化（kun → app）· 绝对路径 → <DSH根>/<工作区> · 个人名/客户名/站点 → 占位
// 含：逐面板校验 sessionId、建/换会话、写回场景 json、RPC 认证（token→签名 cookie）
// ⚠ 摘录/单文件：脱离这套工作台不能直接运行（依赖壳注入的 app.* 实例与页面上下文）。

// 会话对照工具：把「引擎里真实存在的会话」列出来，用于把场景和对话一一对应上。
//
// 为什么要它：AI 面板要"固定显示某个会话"，只能靠**标题**去侧栏里点那条会话行
// （引擎的会话行 DOM 里没有 id 属性，实测 packages/client/ui-workspace/src/client/rows/Rows.tsx：
//   会话行 = div[role="treeitem"][aria-selected]，标题在 <span class*="title"> 里）。
// 所以场景 json 里的 sessionTitle / pinTarget 必须和真实标题**一字不差**，否则就会切错/切不过去。
// 本脚本从引擎会话索引里读出真实标题，并校验每个场景写的标题是否存在。
//
// 用法：
//   node scripts/sessions.mjs            列出全部会话（标题 · 所属目录 · 最后活动 · id）
//   node scripts/sessions.mjs --check    只校验四个场景里的 sessionTitle / pinTarget 是否命中真实会话
//   node scripts/sessions.mjs --json     输出 JSON（给别的脚本用）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS_DIR = process.env.DSH_HARNESS_DIR || '<盘根>\\DSH\\引擎';
const DSH_HOME = process.env.DSH_HOME || path.join(HARNESS_DIR, '.dsh');
// 2026-10-16：默认工作区改成真目录（口径：说明\默认工作区.md）。⛔ 必须放**模块顶层** ——
//   轮换(L257 附近)与 --stray(L544 附近)在**别的函数里**引用它们，放函数内会 ReferenceError（当天真踩过）。
const DEFAULT_CWD = '<盘根>\\DSH\\工作区';
const KEEP_CWD = process.argv.includes('--keep-cwd');

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

// 引擎有两处会话索引：项目缓存总表 + 每会话缓存（文件名就是会话 id）
function listSessions() {
  const out = new Map();
  const add = (id, title, cwd, at) => {
    if (!id) return;
    const prev = out.get(id);
    const rec = { id, title: String(title || '').trim(), cwd: cwd || '', at: at || 0 };
    if (!prev || (!prev.title && rec.title) || rec.at > prev.at) out.set(id, { ...prev, ...rec, at: Math.max(prev ? prev.at : 0, rec.at) });
  };
  const total = path.join(DSH_HOME, 'storages', 'session_projcache.json');
  const j = readJson(total);
  if (j && j.tables && j.tables.sessions) {
    for (const [id, v] of Object.entries(j.tables.sessions)) {
      const rows = v.rows || {};
      add(id, rows.title && rows.title.val, (v.identity || {}).cwd, (v.identity || {}).createdAt);
    }
  }
  const dir = path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions');
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const r = (readJson(path.join(dir, f)) || {}).record;
      if (!r) continue;
      const rows = r.rows || {};
      add(f.replace(/\.json$/, ''), rows.title && rows.title.val, (r.identity || {}).cwd, (r.identity || {}).createdAt);
      attachPressure(f.replace(/\.json$/, ''), rows);
    }
  }
  return [...out.values()].sort((a, b) => b.at - a.at);
}

// 上下文压力：**口径只有一个** —— 现成的真口径工具 `引擎\.dsh\skills\context-overflow\ctx.mjs`。
//   ★ 2026-10-16 更正（这处判据过期了两个多月，是这串虚警的根因）：
//     本脚本原来自算一套 —— 读 .dsh\settings.yaml 的 contextWindow、取最小值、按 160000×0.8＝128k 报警；
//     ① 那个 160000 是 2026-09-16 为"早点压缩"人为调小的、不是实测值（实测 79.2 万 token 的 prompt 真发出去过、
//        从未被拒）⇒ 内置 deepseek 适配器默认其实是 **1000000（线 80 万）**；
//     ② 而且用的是 surface 口径（不含工具定义），实测**低估 2~3 倍**；
//     两条叠加 ⇒ 把 139k/140k 的健康会话（实际 17%）标成 ⚠。**判据两处各算一套，就是虚警的来源。**
//   ⇒ 现在只读 ctx.mjs 算好的 pct / win / line / projected，自己**不再算一条线**；读不到就干脆不标（宁可不报，
//     也不用过期口径吓人）。
const CTX_JS = path.join('<盘根>\\DSH\\引擎', '.dsh', 'skills', 'context-overflow', 'ctx.mjs');
const CTX = (() => {
  try {
    const out = execFileSync(process.execPath, [CTX_JS, '--json', '--all'], { encoding: 'utf8', maxBuffer: 1 << 26, timeout: 60000 });
    const list = JSON.parse(out);
    const m = new Map();
    for (const x of (Array.isArray(list) ? list : [])) {
      if (!x) continue;
      if (x.fullId) m.set(String(x.fullId), x);
      if (x.id) m.set(String(x.id), x);
    }
    return m;
  } catch (e) { return new Map(); }
})();
const pressureOf = new Map();
function attachPressure(id, rows) {
  const c = CTX.get(String(id)) || null;
  const st = rows && rows.sessionStats && rows.sessionStats.val;
  if (!c && !st) return;
  pressureOf.set(id, {
    pct: c ? c.pct : null, win: c ? c.win : null, line: c ? c.line : null,
    projected: c ? c.projected : null, model: c ? c.model : null, winSrc: c ? c.winSrc : null,
    turns: (c && c.turns != null) ? c.turns : (st ? st.turns : null),
  });
}const fmtK = (n) => (n == null ? '?' : (n >= 1000 ? Math.round(n / 1000) + 'k' : String(n)));

const sessions = listSessions();
const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, '');

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(sessions, null, 2));
  process.exit(0);
}

const scenDir = path.join(root, 'scenarios');
const scenarios = fs.existsSync(scenDir)
  ? fs.readdirSync(scenDir).filter(f => f.endsWith('.json')).map(f => ({ file: f, ...(readJson(path.join(scenDir, f)) || {}) }))
  : [];

const checkOnly = process.argv.includes('--check');
// ★零散会话轮换（`--rotate <会话id|标题> --stray`；只给 `--stray` 就列零散会话清单，2026-09-23 加）：
//   零散会话没有场景 json 可回写，所以走文件末尾那条路（交接文档 + 真归档 + 可见的衔接会话）。
const STRAY = process.argv.includes('--stray');
// 轮换模式（--rotate <面板id>）：清单与校验都让位给文件末尾的轮换流程（它写完 json 会自己再跑一次 --check）
const ROTATE_ID = (() => { const i = process.argv.indexOf('--rotate'); return i > -1 ? String(process.argv[i + 1] || '') : ''; })();
const rotating = !!ROTATE_ID || STRAY;
if (!checkOnly && !rotating) {
  console.log('引擎会话索引：' + path.join(DSH_HOME, 'storages'));
  console.log('共 ' + sessions.length + ' 个会话（按最后活动倒序）：\n');
  const hot = [];
  for (const s of sessions) {
    const d = s.at ? new Date(s.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '            ';
    const p = pressureOf.get(s.id);
    let tag = '';
    if (p && p.pct != null) {
      if (p.pct >= 100) { tag = '  ⛔ 上下文 ' + fmtK(p.projected) + '（已超自动压缩线 ' + fmtK(p.line) + '，' + p.pct + '%，压缩没生效 → 413 随时来）'; hot.push({ t: s.title || s.id, hard: true }); }
      else if (p.pct >= 80) { tag = '  ⚠ 上下文 ' + fmtK(p.projected) + '（已达自动压缩线 ' + fmtK(p.line) + ' 的 ' + p.pct + '%，下轮会压缩）'; hot.push({ t: s.title || s.id, hard: false }); }
      else tag = '  上下文 ' + fmtK(p.projected) + ' / 线 ' + fmtK(p.line) + '（' + p.pct + '%）' + (p.turns ? ' · ' + p.turns + ' 轮' : '');
    }
    console.log('  ' + d + '  ' + (s.cwd || '?').padEnd(24) + '  ' + (s.title || '(无标题)') + '   [' + s.id + ']' + tag);
  }
  console.log('');
  if (hot.length) {
    const hard = hot.filter((h) => h.hard), soft = hot.filter((h) => !h.hard);
    console.log('⚠ 有 ' + hot.length + ' 个会话上下文偏大（口径＝ctx.mjs --json --all，本脚本不另算；线＝真窗口 × 0.8）：');
    if (soft.length) {
      console.log('  ○ 已达压缩线 80% 以上（正常，下轮会自动压缩）：');
      soft.forEach((h) => console.log('      · ' + h.t));
    }
    if (hard.length) {
      console.log('  ● 已超压缩线（压缩来不及，/compact 也会 413）：');
      hard.forEach((h) => console.log('      · ' + h.t + ' → 新开会话，或在会话里对较早的消息「分叉会话」'));
    }
    console.log('  换会话后：把 scenarios\\*.json 里该面板的 sessionId 指到新会话（本脚本 --check 可核对对应关系）。');
    console.log('  口径只有一处：node "' + CTX_JS + '"（加 --all 查全机）。⛔ 别在本脚本里另算一套 —— 两处各算一套就是虚警的来源。');
  }
}

// 校验场景 ↔ 会话对应关系（轮换模式跳过：轮换流程回写 json 后会以子进程再跑一次 --check）
if (!rotating) {
let bad = 0, checked = 0;
for (const sc of scenarios) {
  const panels = (sc.panels || []).filter(p => p.type === 'harness');
  for (const p of panels) {
    checked++;
    const wantTitle = String(p.sessionTitle || '').trim();
    const wantId = String(p.sessionId || '').trim();
    const targets = (Array.isArray(p.pinTarget) ? p.pinTarget : (p.pinTarget ? [p.pinTarget] : [])).map(t => String(t).trim()).filter(Boolean);
    const idHit = wantId ? sessions.find(s => s.id === wantId || s.id === wantId.replace(/^session-/, '')) : null;
    const exact = wantTitle ? sessions.find(s => s.title === wantTitle) : null;
    const fuzzy = targets.length
      ? sessions.filter(s => targets.some(t => norm(s.title).includes(norm(t))))
      : [];
    let verdict;
    const unbound = !wantId && !wantTitle && !targets.length;
    if (unbound) {
      // 解绑状态：场景里没写任何钉会话信息 → 面板自由选会话，这是**合法**状态，不算错 ✗
      verdict = '○ 未绑定（面板自由选会话，不会被自动切换）';
    } else if (wantId) {
      // 有 id = 能做身份校验：id 必须真实存在，且与写的标题一致（否则说明场景写错了人）
      if (!idHit) {
        verdict = '✗ 指定会话 id「' + wantId + '」在引擎里不存在 → 身份校验无法进行，只剩按标题认人（有认错风险）';
        bad++;
      } else if (wantTitle && idHit.title !== wantTitle) {
        verdict = '✗ 会话 id 与标题不一致：id 指向「' + idHit.title + '」，但 sessionTitle 写的是「' + wantTitle + '」→ 会切错会话';
        bad++;
      } else {
        verdict = '✓ id 命中「' + idHit.title + '」（身份校验通过）';
        if (fuzzy.length > 1) verdict += '（候选名还能匹配到 ' + (fuzzy.length - 1) + ' 个别的会话，但有 id 就不会选错）';
      }
    } else if (wantTitle && exact) {
      verdict = '✓ 指定标题命中真实会话（建议补 sessionId：本机有过只差一个空格的孪生会话，按标题认人有风险）';
      if (fuzzy.length > 1) verdict += '（候选名还能匹配到 ' + (fuzzy.length - 1) + ' 个别的会话，靠指定标题优先才选对）';
    } else if (wantTitle && !exact) {
      const near = sessions.filter(s => norm(s.title).includes(norm(wantTitle)) || norm(wantTitle).includes(norm(s.title)));
      verdict = '✗ 指定标题「' + wantTitle + '」在引擎里不存在' + (near.length ? '；相近的有：' + near.map(s => s.title).join(' / ') : '');
      bad++;
    } else if (fuzzy.length === 1) {
      verdict = '✓ 候选名唯一命中：' + fuzzy[0].title + '（建议补 sessionId 更稳）';
    } else if (fuzzy.length > 1) {
      verdict = '✗ 候选名匹配到 ' + fuzzy.length + ' 个会话：' + fuzzy.map(s => s.title).join(' / ') + ' → 必须补 sessionId';
      bad++;
    } else {
      verdict = '✗ 候选名没匹配到任何会话：' + targets.join(' / ');
      bad++;
    }
    // ★硬规则（2026-09-19，二次修正）：场景里的 harness 面板**必须**写 sessionId。
    //   理由**不是分区**（2026-09-19 上半场那条"按 id 一板一分区"已回退：新分区里应用不会自己进会话、
    //   面板会停在欢迎页），而是**认人**：本机真的存在过只差一个空格的孪生会话（「DSH 改造」/「DSH改造」），
    //   而会话行 DOM 里没有会话 id、只有标题 —— 没有 id 就只能按标题认，认错就切到空会话。
    //   有 id，本脚本才能在构建期核对"这条会话真的存在、且 sessionTitle 与它逐字一致"。
    if (!wantId) {
      bad++;
      verdict = '✗ 缺少 sessionId：' + verdict.replace(/^[✓○✗]\s*/, '')
        + '（缺 id 就只能按标题认人，本机有过只差一个空格的孪生会话 → 必须补 sessionId）';
    }
    console.log((sc.id || sc.file) + ' · ' + p.id + '  面板「' + (p.title || '') + '」');
    console.log('    ' + verdict);
  }
}
if (!checked) { console.log('没有找到任何 harness 面板（AI 面板）'); }
console.log('');
console.log(bad ? ('场景↔会话对照检查未通过 ✗ 共 ' + bad + ' 处') : ('场景↔会话对照检查通过 ✓ 共 ' + checked + ' 个 AI 面板'));
process.exit(bad ? 1 : 0);
}   // ← 结束 if (!rotating)

// ══════════════════════════════════════════════════════════════════════════
// 一键会话轮换（--rotate <面板id>，2026-09-21 实测落地）
//
// 用户要的：**同一工作区**新建一条与旧会话**同名**的会话顶替它，旧会话归档，面板 sessionId 重指向新会话。
// 引擎现状（2026-09-21 实测）：可用 RPC 只有 `session/create`、`session/rename`
//   （`session/archive|delete|remove|trash` 全是 404）⇒「归档」= 把旧会话改名成「已归档 · 原标题 · 日期」，
//   **数据零删除**（`.dsh\sessions\` 下的 zstd jsonl 原样留着，随时能在界面里找回来）。
// 认证：token 不在命令行里传，从 `server.log` 最后几条 `dsh web:` 行里取，GET `/?token=` 换签名 cookie
//   （必须 redirect:'manual' —— 跟随后反而 401）。脚本不打印 token。
// 硬规矩（用户定的）：**交接没写完不许轮换** ⇒ 必须给 `--handoff <文件>` 且它在 2 小时内改过（`--force` 可跳过但会警告）。
// 用法：
//   node scripts/sessions.mjs --rotate dg-dsh --dry --handoff "<盘根>\...\（本机维护笔记，未公开）.md"   只打印计划，不动任何东西
//   node scripts/sessions.mjs --rotate dg-dsh --handoff "<盘根>\...\（本机维护笔记，未公开）.md"        真轮换
//   --scenario <json路径> 可换成别的场景文件（用于不碰真面板的实测）
//   --adopt <会话id>      不自己新建，改用"工作台里手动新建的那条会话"顶替
//                         （⚠ 绕过 GUI、用 RPC 建的会话不会被工作台登记，会掉进侧边栏「未分组」）
// 轮换收尾（2026-09-21 加）：成功且 --check 通过后会跑一次「同步点自检」——扫索引/定位卡/两份项目信息/两个技能，
//   把还写着**旧 sessionId** 的文档点名出来（只提示、不改写、不算失败：里面"历史沿革/聊天记录"本就该留着旧 id）。
//   为什么要它：轮换只回写场景 json，而"我是谁"还要靠索引表 §二·§五、定位卡 §一、技能 §〇 身份行 —— 实测漏改过。
// ══════════════════════════════════════════════════════════════════════════
if (rotating && !STRAY) {
  const { execFileSync } = await import('node:child_process');
  const argv = process.argv.slice(2);
  const dry = argv.includes('--dry');
  const force = argv.includes('--force');
  const seedIt = !argv.includes('--no-seed');   // 默认：建完给新会话塞一条开场消息并立刻打断（空会话不进侧边栏）
  const valOf = (k) => { const i = argv.indexOf(k); return i > -1 ? String(argv[i + 1] || '') : ''; };
  const handoff = valOf('--handoff');
  const scenOverride = valOf('--scenario');
  const adopt = valOf('--adopt');   // 用"工作台自己建的"会话来顶替（绕过 GUI 用 RPC 建的会话会掉进「未分组」）
  const say = (...a) => console.log(...a);
  let failed = false;
  const die = (msg) => { console.error('✗ ' + msg); failed = true; };

  // ① 定位面板
  const realScenDir = path.join(root, 'scenarios');
  const cands = scenOverride
    ? [{ file: path.basename(scenOverride), ...(readJson(scenOverride) || {}), __path: scenOverride }]
    : fs.readdirSync(realScenDir).filter((f) => f.endsWith('.json'))
        .map((f) => ({ file: f, ...(readJson(path.join(realScenDir, f)) || {}), __path: path.join(realScenDir, f) }));
  let hit = null;
  for (const sc of cands) for (const p of (sc.panels || [])) {
    if (p.type === 'harness' && (p.id === ROTATE_ID || p.sessionId === ROTATE_ID)) hit = { sc, p };
  }
  if (!hit) die('没找到面板「' + ROTATE_ID + '」（写面板 id，如 dg-dsh，或直接写它的 sessionId）');
  else {
    const oldId = String(hit.p.sessionId || '').trim();
    const title = String(hit.p.sessionTitle || '').trim();
    const old = sessions.find((x) => x.id === oldId) || null;
    const cwd = (KEEP_CWD && old && old.cwd) ? old.cwd : DEFAULT_CWD;   // 默认新工作区；--keep-cwd 才沿用旧会话
    say('面板 ' + (hit.sc.id || hit.sc.file) + ' · ' + hit.p.id + '「' + (hit.p.title || '') + '」');
    say('  旧会话：' + (oldId || '(未绑定)') + '   标题「' + (old ? old.title : title) + '」   工作区 ' + cwd);

    if (!oldId) die('这个面板没绑 sessionId，无需轮换');
    else if (!title) die('面板没写 sessionTitle —— 轮换靠标题认人，先把标题补上');
    else {
      // ② 交接闸门
      say('\n交接闸门（硬规矩：交接没写完不许轮换）');
      if (handoff) {
        const st = fs.existsSync(handoff) ? fs.statSync(handoff) : null;
        const fresh = !!st && (Date.now() - st.mtimeMs) < 2 * 3600 * 1000;
        say('  --handoff ' + handoff);
        say('    ' + (!st ? '✗ 文件不存在'
          : fresh ? '✓ 2 小时内更新过（' + new Date(st.mtimeMs).toLocaleString('zh-CN') + '）'
                  : '✗ 最后更新 ' + new Date(st.mtimeMs).toLocaleString('zh-CN') + '，超过 2 小时'));
        if (!fresh && !force) die('交接文件不新鲜 ⇒ 先把 §〇（进度 / 下一步 / 卡点）写好再轮换；确实要跳过加 --force');
      } else if (!force) die('没给 --handoff。交接没写完不许轮换；确认写好了可加 --force 跳过检查。');
      else say('  ⚠ 没给 --handoff 却带了 --force：跳过交接检查（不建议）');

      const d0 = new Date();
      const stamp = d0.getFullYear() + '-' + ('0' + (d0.getMonth() + 1)).slice(-2) + '-' + ('0' + d0.getDate()).slice(-2);
      const archTitle = '已归档 · ' + title + ' · ' + stamp;
      say('\n计划：');
      say('  1) 在 ' + cwd + ' 新建会话，改名为「' + title + '」（与旧会话同名，界面/定位卡/索引都不用改）');
      say('  2) 旧会话 ' + oldId + ' 改名为「' + archTitle + '」（= 归档，数据零删除）');
      say('  3) 回写 ' + path.relative(root, hit.sc.__path) + ' 里面板 ' + hit.p.id + ' 的 sessionId');
      say('  4) 自动跑 --check 验收' + (scenOverride ? '（用了 --scenario，跳过）' : ''));

      if (dry) say('\n--dry：以上都没执行。去掉 --dry 即真做。');
      else {
        // ③ token → cookie
        const LOG = path.join(root, 'server.log');
        const BASE = process.env.DSH_GUI_BASE || 'http://127.0.0.1:3080';
        const toks = fs.existsSync(LOG)
          ? [...fs.readFileSync(LOG, 'utf8').matchAll(/dsh web:\s*http:\/\/127\.0\.0\.1:3080\/\?token=([A-Za-z0-9_\-]{16,})/g)].map((m) => m[1]).reverse()
          : [];
        let cookie = '';
        for (const t of toks.slice(0, 3)) {
          try {
            const r = await fetch(BASE + '/?token=' + t, { redirect: 'manual' });
            const sc = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
            if (sc.length) { cookie = sc.map((c) => c.split(';')[0]).join('; '); break; }
          } catch (e) { /* 换下一条 */ }
        }
        if (!cookie) die('换不到 cookie（engine 没在跑或 token 失效 ⇒ 让用户重启 GUI 后再试）');
        else {
          const rpc = async (method, a) => {
            const r = await fetch(BASE + '/api/' + method, {
              method: 'POST',
              headers: { 'content-type': 'application/json; charset=utf-8', cookie },
              body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method, payload: { args: a } }),
            });
            const t = await r.text();
            let j = null; try { j = JSON.parse(t); } catch (e) { }
            return { status: r.status, j, t };
          };
          // ④ 建新会话（或改用工作台自己建的那条：--adopt）
          let newId = '';
          if (adopt) {
            newId = adopt.trim();
            say('\n  · 用指定的会话顶替（--adopt，不再自己新建）：' + newId);
          } else {
            // ★ 必须传 workspaceId：侧边栏是按 workspace 分组的，只传 cwd 建出来的会话会掉进「未分组」（2026-09-21 实测）
            let wsId = '';
            try {
              const wf = path.join(DSH_HOME, 'storages', 'workspace.json');
              const tbl = (fs.existsSync(wf) ? (readJson(wf) || {}) : {}).tables || {};
              const norm = (s) => String(s || '').replace(/[\\/]+$/, '').toLowerCase();
              for (const [id, v] of Object.entries(tbl.workspaces || {})) if (norm(v.path) === norm(cwd)) { wsId = id; break; }
            } catch (e) { /* 读不到就退回 cwd */ }
            const c = await rpc('session/create', { request: wsId ? { workspaceId: wsId } : { cwd } });
            newId = c.j && c.j.result && c.j.result.value && c.j.result.value.sessionId;
            if (!newId) die('建会话失败：HTTP ' + c.status + ' ' + String(c.t).slice(0, 200));
            else say('\n  ✓ 新会话已建：' + newId + (wsId
              ? '（挂进 workspace ' + wsId.slice(0, 8) + '… =「' + ((readJson(path.join(DSH_HOME, 'storages', 'workspace.json')).tables.workspaces[wsId] || {}).title || '') + '」⇒ 会出现在侧边栏同一分组）'
              : '（⚠ 没找到 ' + cwd + ' 对应的 workspace ⇒ 可能落进「未分组」）'));
          }
          if (newId) {
            const rn = await rpc('session/rename', { request: { sessionId: newId, title } });
            say('  ' + (rn.status === 200 ? '✓' : '✗') + ' 新会话命名为「' + title + '」（HTTP ' + rn.status + '）');
            if (rn.status !== 200) die('新会话改名失败 ⇒ 别回写 json（否则面板会指到一条没名字的会话）');
            else {
              const ra = await rpc('session/rename', { request: { sessionId: oldId, title: archTitle } });
              say('  ' + (ra.status === 200 ? '✓' : '✗') + ' 旧会话已归档为「' + archTitle + '」（HTTP ' + ra.status + '，数据零删除）');
              // ★ 真归档：workspace/archiveSession 才会把它从侧边栏隐藏掉（只改名的话它照样列在那里，2026-09-21 用户实测）
              let arc = await rpc('workspace/archiveSession', { request: { sessionId: oldId } });
              if (arc.status !== 200) {
                // 旧会话还有活动（最典型的就是"会话自己归档自己"——它此刻正在跑这一轮）⇒ 带 stopActivity 再试一次。
                // 2026-09-28 补：原来这里只有一次调用、不重试，于是自归档只剩改名 ⛔ 用户反复报"已归档的不归档"。
                say('  ⚠ 第一次归档没成（HTTP ' + arc.status + '）⇒ 带 stopActivity 重试一次');
                arc = await rpc('workspace/archiveSession', { request: { sessionId: oldId, stopActivity: true } });
              }
              const archOk = arc.status === 200 && (((readJson(path.join(DSH_HOME, 'storages', 'workspace.json')) || {}).global || {}).archivedSessionIds || []).includes(oldId);
              say('  ' + (archOk ? '✓' : '⚠ HTTP ' + arc.status) + (archOk
                ? ' 旧会话已真归档（侧边栏里不再显示；工作台设置页「取消归档」可恢复）'
                : ' 归档没成 ⇒ 旧会话还会留在侧边栏里；补一次：node scripts\\归档会话.mjs ' + oldId + ' --go'));
              // ④ 塞一条开场消息再立刻打断：空会话不会出现在侧边栏（2026-09-21 用户实测），有内容才会
              if (seedIt && !adopt) {
                // 开场消息同时是"安全指令"：明确禁止读文件/调工具/开始干活 ⇒ 这轮即使跑完也只是回一句话，不会改任何东西
                const seedTxt = '交接已写好：' + (handoff || '该场景的项目信息') + ' 的 §〇（进度/下一步/卡点）。'
                  + '现在只回一句话「已读交接」即可 —— 不要读任何文件、不要调用任何工具、不要开始干活，等我下一条指令。';
                const pr = await rpc('session/prompt', { request: {
                  requestId: (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
                  sessionId: newId, mode: 'queue', content: [{ type: 'text', text: seedTxt }],
                } });
                await new Promise((r) => setTimeout(r, 10000));   // 取消太早 ⇒ 这轮没真正开始过 ⇒ 会话仍是 blank ⇒ 侧边栏照样不显示它（2026-09-21 实测）
                const cx = await rpc('session/cancel', { request: { sessionId: newId } });
                say('  ' + (pr.status === 200 ? '✓' : '✗ HTTP ' + pr.status) + ' 已给新会话写入开场消息（这样它才会出现在侧边栏）' + (pr.status === 200 ? '' : ' ' + String(pr.t).slice(0, 160)));
                say('  ' + (cx.status === 200 ? '✓' : '✗ HTTP ' + cx.status) + ' 已打断这轮（开场消息明令它别干活，所以这轮不会动任何东西）' + (cx.status === 200 && cx.j && cx.j.result && cx.j.result.value ? '（accepted=' + cx.j.result.value.accepted + '）' : ''));
              } else say('  （--no-seed：没写开场消息 ⇒ 新会话是空的，侧边栏可能要等它被打开过才显示）');
              // ⑤ 原子回写 json（先备份）
              const bdir = path.join(root, 'data', 'scenario-backup');
              fs.mkdirSync(bdir, { recursive: true });
              const bfile = path.join(bdir, path.basename(hit.sc.__path) + '.' + Date.now() + '.bak.json');
              fs.copyFileSync(hit.sc.__path, bfile);
              const obj = readJson(hit.sc.__path);
              let patched = 0;
              for (const p of (obj.panels || [])) {
                if (p.type === 'harness' && p.id === hit.p.id) { p.sessionId = newId; patched++; }
              }
              const tmp = hit.sc.__path + '.tmp';
              fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
              fs.renameSync(tmp, hit.sc.__path);
              say('  ✓ 已回写 ' + path.relative(root, hit.sc.__path) + '（改了 ' + patched + ' 处；备份 ' + path.relative(root, bfile) + '）');
              // 2026-10-16 补（dg-dsh 派单 · 轮换后名册漂移）：**名册也要跟着改** ——
              //   `scenarios\05-协作与规矩/四-身份索引-怎么建.md.md` §二 那行是"这个面板绑哪条会话"的权威记载；以前只改 scenarios\*.json，
              //   于是每次 --rotate 都留下"名册还写旧 id"的漂移（全量标准化体检因此报 2 条 ⛔：身份对不上 + 会话库里找不到）。
              //   只改"同一行里既有旧 id、又有这个面板 id"的那一行 —— 免得误伤历史记录里提到的旧 id。
              try {
                const rp = path.join(root, 'scenarios', '05-协作与规矩/四-身份索引-怎么建.md.md');
                if (fs.existsSync(rp)) {
                  const rl = fs.readFileSync(rp, 'utf8').split('\n');
                  let rn = 0;
                  const rl2 = rl.map((l) => {
                    if (l.indexOf(oldId) < 0) return l;
                    if (l.indexOf('`' + hit.p.id + '`') < 0) return l;
                    rn++;
                    return l.split(oldId).join(newId);
                  });
                  if (rn) { fs.writeFileSync(rp, rl2.join('\n'), 'utf8'); say('  ✓ 已同步名册 scenarios\\05-协作与规矩/四-身份索引-怎么建.md.md（' + oldId.slice(0, 20) + '… → ' + newId.slice(0, 20) + '…，改了 ' + rn + ' 行）'); }
                  else say('  （名册里这一行没写旧 id，无需同步）');
                }
              } catch (e) { say('  ⚠ 名册同步失败：' + ((e && e.message) || e)); }
              // ⑥ 自动验收
              if (scenOverride) say('\n（用了 --scenario，跳过 --check：真面板的 scenarios 一个字都没动）');
              else {
                // 引擎把新会话写进投影缓存有 1~3 秒延迟 ⇒ 刚建完立刻 --check 会假红（2026-09-21 实测踩到），这里重试
                let ok = false;
                for (let i = 1; i <= 6 && !ok; i++) {
                  say('\n自动验收 --check（第 ' + i + ' 次）：');
                  try {
                    execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--check'], { cwd: root, stdio: 'inherit' });
                    ok = true;
                  } catch (e) {
                    if (i < 6) { say('  （新会话刚建，引擎还没把它写进投影缓存 —— 3 秒后重试）'); await new Promise((r) => setTimeout(r, 3000)); }
                  }
                }
                if (ok) {
                  say('\n✓ 轮换完成。在 GUI 里刷新该面板（或点 ⟳）即接上新会话。');
                  // ⑦ 轮换后的同步点自检（2026-09-21 实测踩到：只回写 json ⇒ 索引/定位卡/技能里还写着旧 sessionId，
                  //    下次会话认身份就被带偏）。这些文件里有"历史沿革"是正常的，所以只提示、不改写、不算失败。
                  try {
                    const docs = [
                      ['场景身份索引', path.join(root, 'scenarios', '05-协作与规矩/四-身份索引-怎么建.md.md')],
                      ['场景定位卡', path.join(root, 'scenarios', 'dsh-gui-context.md')],
                      ['界面侧项目信息', path.join(root, '场景记忆')],
                      ['引擎侧维护须知', path.join(DSH_HOME, '..', '（本机维护笔记，未公开）.md')],
                      ['技能 harness-dev', path.join(DSH_HOME, 'skills', 'harness-dev', 'SKILL.md')],
                      ['技能 context-overflow', path.join(DSH_HOME, 'skills', 'context-overflow', 'SKILL.md')],
                    ];
                    const stale = [];
                    for (const [name, f] of docs) {
                      if (!fs.existsSync(f)) continue;
                      const n = fs.readFileSync(f, 'utf8').split(oldId).length - 1;   // 用 split 不用 RegExp：历史行里可能残留 `session-0000……` 这种带省略号的写法，当正则会炸
                      if (n) stale.push(name + ' ×' + n);
                    }
                    if (stale.length) {
                      say('\n⚠ 轮换后同步点自检：还有 ' + stale.length + ' 份文档写着旧会话 ' + oldId.slice(0, 24) + '…');
                      say('    ' + stale.join('｜'));
                      say('    里面"历史沿革 / 聊天记录"属正常，但**当前绑定**（索引表 §二·§五、定位卡 §一、技能 §〇 身份行）');
                      say('    要改成新会话 ' + newId.slice(0, 24) + '…；改完再跑一次 --check 即可。');
                    } else say('\n✓ 同步点自检：6 份文档里没有旧会话 ' + oldId.slice(0, 24) + '… 的残留。');
                  } catch (e) { say('\n（同步点自检跳过：' + e.message + '）'); }
                }
                else {
                  say('\n✗ 重试 6 次仍未通过 —— 先手工看一眼再决定：node scripts\\sessions.mjs --check');
                  say('   确认真错才回滚：copy "' + bfile + '" "' + hit.sc.__path + '"');
                  failed = true;
                }
              }
            }
          }
        }
      }
    }
  }
  process.exitCode = failed ? 1 : 0;
}

// ══════════════════════════════════════════════════════════════════════════
// 零散会话一键轮换（`--rotate <会话id|标题> --stray`，2026-09-23 加）
//
// 为什么单独一条路：上面那块面板轮换靠「场景 json 里的面板」定位要换谁、换完回写 json。
//   零散会话（不在 05-协作与规矩/四-身份索引-怎么建.md §二 表里 —— 没有面板 / 定位卡 / 场景项目信息）两样都没有，
//   于是过去只能手工四步（技能 context-overflow §6 原话）：写交接文件 → 界面新建会话 →
//   手工改名归档 → 新会话开场读文件。**实测的坑（用户 2026-09-23 报）**：手工做完只剩"名字改了"——
//   ① 没真归档 ⇒ 侧边栏里照样列着（归档不是改名，得走 `workspace/archiveSession`）；
//   ② 新建的会话是空的 ⇒ **空会话不进侧边栏**，用户根本看不到"衔接会话"。
// 这条路把四步做全：
//   ① 找交接文档（`--handoff` 指定；不给就按标题去 `其他会话临时项目信息交接文档\` 里匹配）
//   ② 建新会话（挂同 workspace，否则掉进「未分组」）或 `--adopt` 认领一条已建好的
//   ③ 旧会话改名「已归档 · X · 日期」+ **真归档**（带活动时自动 stopActivity 重试）
//   ④ 给新会话写开场消息再打断（空会话不进侧边栏）
//   ⑤ 把交接文档里的旧会话 id 换成新会话（新会话读到的就是它自己）
// 记忆落点（零散会话唯一）：`<DSH根>\引擎\场景项目信息\其他会话临时项目信息交接文档\<会话名>-<YYYYMMDD-HHMM>.md`
// 用法：
//   node scripts\sessions.mjs --stray                                    列出所有零散会话（压力 + 交接文档）
//   node scripts\sessions.mjs --rotate 华为电脑管家升级 --stray --dry      空跑看计划
//   node scripts\sessions.mjs --rotate 华为电脑管家升级 --stray            真换
//   node scripts\sessions.mjs --rotate <id> --stray --adopt <新会话id>     认领已建好的会话顶替
// ══════════════════════════════════════════════════════════════════════════
if (rotating && STRAY) {
  const argv = process.argv.slice(2);
  const dry = argv.includes('--dry');
  const force = argv.includes('--force');
  const seedIt = !argv.includes('--no-seed');
  const valOf = (k) => { const i = argv.indexOf(k); return i > -1 ? String(argv[i + 1] || '') : ''; };
  const adopt = valOf('--adopt');
  let handoff = valOf('--handoff');
  const say = (...a) => console.log(...a);
  let failed = false;
  const die = (msg) => { console.error('✗ ' + msg); failed = true; };

  // ★2026-10-13★ 旧根 `<DSH根>\引擎\场景项目信息` 已搬到 `<DSH根>\引擎\场景项目信息`（旧根已删）。
  //   这里是**转义写法**，搬家的文本扫描匹配不到 ⇒ 漏改；不改的话零散会话交接会写进已删的旧目录。
  const STRAY_DIR = '<盘根>\\DSH\\引擎\\场景项目信息\\其他会话临时项目信息交接文档';
  const baseOf = (t) => String(t || '')
    .replace(/^已归档\s*·\s*/, '')
    .replace(/\s*·\s*\d{4}-\d{2}-\d{2}\s*$/, '')
    .replace(/\s*[·・]\s*接手.*$/, '')
    .trim();
  const keyOf = (t) => baseOf(t).replace(/[\s\-_·・（）()【】\[\]]/g, '').toLowerCase();
  // 交接文档：目录里按标题归一化找（同一任务可能有多份历史 ⇒ 取最近改的那份）
  function findHandoff(title) {
    if (!fs.existsSync(STRAY_DIR)) return null;
    const k = keyOf(title);
    if (!k) return null;
    const rows = fs.readdirSync(STRAY_DIR)
      .filter((f) => f.endsWith('.md') && !f.startsWith('_'))
      .map((f) => ({ f, k: keyOf(f.replace(/-\d{8}-\d{4}\.md$/, '').replace(/\.md$/, '')) }))
      .filter((x) => x.k && (x.k === k || x.k.includes(k) || k.includes(x.k)))
      .map((x) => { let at = 0; try { at = fs.statSync(path.join(STRAY_DIR, x.f)).mtimeMs } catch (e) { /* ignore */ } return { ...x, at }; })
      .sort((a, b) => b.at - a.at);
    if (!rows.length) return null;
    return { file: path.join(STRAY_DIR, rows[0].f), more: rows.slice(1).map((x) => x.f) };
  }
  // 哪些会话是"零散"的：不在任何场景 harness 面板的 sessionId 里
  const boundIds = new Set();
  for (const sc of scenarios) for (const p of (sc.panels || [])) if (p.type === 'harness' && p.sessionId) boundIds.add(String(p.sessionId));
  const archivedIds = (() => {
    try { return new Set(((readJson(path.join(DSH_HOME, 'storages', 'workspace.json')) || {}).global || {}).archivedSessionIds || []); }
    catch (e) { return new Set(); }
  })();
  const strays = sessions.filter((s) => !boundIds.has(s.id));

  // 没给 --rotate 的值 ⇒ 只列清单
  if (!ROTATE_ID.trim()) {
    const live = strays.filter((s) => !archivedIds.has(s.id));
    say('零散会话（没有场景 / 面板 / 定位卡 —— 换它们用 --rotate <名字|id> --stray）\n');
    say('  共 ' + strays.length + ' 条（未归档 ' + live.length + ' 条）：\n');
    say('  未归档（侧边栏里列着的）：');
    for (const s of live) {
      const p = pressureOf.get(s.id);
      const h = findHandoff(s.title);
      const tag = p && p.pct != null
        ? (p.pct >= 100 ? '  ⛔ 上下文 ' + fmtK(p.projected) + '（' + p.pct + '%）' : p.pct >= 80 ? '  ⚠ 上下文 ' + fmtK(p.projected) + '（' + p.pct + '%）' : '  上下文 ' + fmtK(p.projected) + '（' + p.pct + '%）')
        : '';
      say('    ' + (s.title || '(无标题)').padEnd(34) + ' [' + s.id.replace(/^session-/, '').slice(0, 8) + ']' + tag
        + '   交接文档：' + (h ? path.basename(h.file) : '（没有）'));
    }
    const arc = strays.filter((s) => archivedIds.has(s.id));
    if (arc.length) {
      say('\n  已归档（侧边栏里看不到）：');
      for (const s of arc) say('    ' + (s.title || '(无标题)').padEnd(34) + ' [' + s.id.replace(/^session-/, '').slice(0, 8) + ']');
    }
    say('\n换一条：node scripts\\sessions.mjs --rotate <名字|id> --stray        先加 --dry 只看计划');
    say('（零散会话的交接文档放：' + STRAY_DIR + '\\<会话名>-<YYYYMMDD-HHMM>.md）');
    process.exitCode = 0;
  } else {
    // ① 找要轮换的那条：id（可写后 8 位）→ 完整标题 → 唯一模糊
    const q = ROTATE_ID.trim();
    const qn = norm(q);
    let old = sessions.find((s) => s.id === q || s.id === q.replace(/^session-/, '') || s.id.replace(/^session-/, '').startsWith(q)) || null;
    let how = '会话 id';
    if (!old) { const exact = sessions.filter((s) => s.title === q); if (exact.length === 1) { old = exact[0]; how = '完整标题'; } }
    if (!old) {
      const fuzzy = sessions.filter((s) => qn && norm(s.title).includes(qn));
      if (fuzzy.length === 1) { old = fuzzy[0]; how = '标题模糊匹配'; }
      else if (fuzzy.length > 1) die('「' + q + '」匹配到 ' + fuzzy.length + ' 条会话：' + fuzzy.map((s) => s.title).join(' / ') + ' → 写完整标题或会话 id');
    }
    if (!old) { if (!failed) die('找不到会话「' + q + '」；先 node scripts\\sessions.mjs --stray 看清单'); }
    else {
      const oldId = old.id;
      const oldTitle = String(old.title || oldId).trim();
      const base = baseOf(oldTitle) || oldTitle;
      const cwd = (KEEP_CWD && old.cwd) ? old.cwd : DEFAULT_CWD;   // 同上：默认新工作区
      say('零散会话轮换（无场景 · 没有面板/json 可回写）');
      say('  要换的：' + oldId);
      say('    标题「' + oldTitle + '」（' + how + '命中）   工作区 ' + cwd);
      say('    现在状态：' + (archivedIds.has(oldId) ? '已归档（侧边栏里看不到）' : '未归档（侧边栏里照常列着）'));
      if (boundIds.has(oldId)) say('    ⚠ 注意：这条其实是某个场景面板绑定的会话 —— 面板轮换请用 node scripts\\sessions.mjs --rotate <面板id>（不加 --stray）');

      // ② 交接文档（零散会话唯一的记忆落点）
      if (!handoff) {
        const hit = findHandoff(oldTitle);
        if (hit) { handoff = hit.file; if (hit.more.length) say('    （同主题还有 ' + hit.more.length + ' 份更旧的：' + hit.more.join(' / ') + '，取了最近改的这份）'); }
      }
      say('\n交接文档（零散会话的唯一记忆落点）');
      say('  ' + (handoff || '（没找到）'));
      if (handoff) { const st = fs.existsSync(handoff) ? fs.statSync(handoff) : null; say('    改于 ' + (st ? new Date(st.mtimeMs).toLocaleString('zh-CN') : '（文件不存在）')); }
      else say('    没给 --handoff，也没在 ' + STRAY_DIR + ' 里按标题找到 ⇒ 先用 _模板.md 写一份（或 --handoff 指路径）');

      // ③ 闸门：交接没写/太旧不许换（与面板轮换同一条硬规矩）
      let gateOk = true;
      if (!handoff || !fs.existsSync(handoff)) gateOk = false;
      else if (Date.now() - fs.statSync(handoff).mtimeMs > 2 * 3600 * 1000) { say('    ✗ 超过 2 小时没更新过'); gateOk = false; }
      else say('    ✓ 2 小时内更新过');
      if (!gateOk && !force) die('交接文档不存在或不新鲜 ⇒ 先把 §〇（进度/下一步/卡点）写好；确实要跳过加 --force');
      else if (!gateOk) say('    ⚠ 带了 --force：跳过交接检查（不建议）');

      const d0 = new Date();
      const stamp = d0.getFullYear() + '-' + ('0' + (d0.getMonth() + 1)).slice(-2) + '-' + ('0' + d0.getDate()).slice(-2);
      const archTitle = '已归档 · ' + base + ' · ' + stamp;
      say('\n计划：');
      say('  1) ' + (adopt ? '认领已建好的会话 ' + adopt + '（挂进同 workspace，让它出现在侧边栏）' : '在 ' + cwd + ' 新建会话，命名「' + base + '」'));
      say('  2) 旧会话 ' + oldId + ' 改名「' + archTitle + '」+ **真归档**（侧边栏里不再显示）');
      say('  3) 给新会话写一条开场消息（读交接文档）再立刻打断 —— 空会话不进侧边栏，有内容才看得见');
      say('  4) 把交接文档里的旧会话 id 改成新会话（这样新会话读到的就是它自己）');
      say('  （零散会话没有场景 json：不回写、不用跑 --check）');

      if (dry) say('\n--dry：以上都没执行。去掉 --dry 即真做。');
      else {
        const LOG = path.join(root, 'server.log');
        const BASE = process.env.DSH_GUI_BASE || 'http://127.0.0.1:3080';
        const toks = fs.existsSync(LOG)
          ? [...fs.readFileSync(LOG, 'utf8').matchAll(/dsh web:\s*http:\/\/127\.0\.0\.1:3080\/\?token=([A-Za-z0-9_\-]{16,})/g)].map((m) => m[1]).reverse()
          : [];
        let cookie = '';
        for (const t of toks.slice(0, 3)) {
          try {
            const r = await fetch(BASE + '/?token=' + t, { redirect: 'manual' });
            const sc = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
            if (sc.length) { cookie = sc.map((c) => c.split(';')[0]).join('; '); break; }
          } catch (e) { /* 换下一条 */ }
        }
        if (!cookie) die('换不到 cookie（engine 没在跑或 token 失效 ⇒ 让用户重启 GUI 后再试）');
        else {
          const rpc = async (method, a) => {
            const r = await fetch(BASE + '/api/' + method, {
              method: 'POST',
              headers: { 'content-type': 'application/json; charset=utf-8', cookie },
              body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method, payload: { args: a } }),
            });
            const t = await r.text();
            let j = null; try { j = JSON.parse(t); } catch (e) { /* 非 JSON 就别管 */ }
            return { status: r.status, j, t };
          };
          // 侧边栏按 workspace 分组：不挂 workspace 的会话会掉进「未分组」
          let wsId = '';
          try {
            const wf = path.join(DSH_HOME, 'storages', 'workspace.json');
            const tbl = (fs.existsSync(wf) ? (readJson(wf) || {}) : {}).tables || {};
            const nz = (s) => String(s || '').replace(/[\\/]+$/, '').toLowerCase();
            for (const [id, v] of Object.entries(tbl.workspaces || {})) if (nz(v.path) === nz(cwd)) { wsId = id; break; }
          } catch (e) { /* 读不到就退回 cwd */ }
          // ④ 新会话（或认领一条已建好的）
          let newId = '';
          if (adopt) {
            newId = adopt.trim();
            // session/create 支持 sessionId = "explicit-id adoption"：把已有会话认领进这个 workspace
            const c = await rpc('session/create', { request: { sessionId: newId, ...(wsId ? { workspaceId: wsId } : { cwd }) } });
            say('\n  ' + (c.status === 200 ? '✓' : '✗') + ' 已认领会话 ' + newId + '（挂进 ' + (wsId ? 'workspace ' + wsId.slice(0, 8) + '…' : '⚠ 没找到 workspace，可能落进「未分组」') + '；HTTP ' + c.status + '）');
            if (c.status !== 200) die('认领失败：' + String(c.t).slice(0, 200));
          } else {
            const c = await rpc('session/create', { request: wsId ? { workspaceId: wsId } : { cwd } });
            newId = c.j && c.j.result && c.j.result.value && c.j.result.value.sessionId;
            if (!newId) die('建会话失败：HTTP ' + c.status + ' ' + String(c.t).slice(0, 200));
            else {
              say('\n  ✓ 新会话已建：' + newId + (wsId ? '（挂进 workspace ' + wsId.slice(0, 8) + '… ⇒ 与旧会话同一分组）' : '（⚠ 没找到 workspace ⇒ 可能落进「未分组」）'));
              const rn = await rpc('session/rename', { request: { sessionId: newId, title: base } });
              say('  ' + (rn.status === 200 ? '✓' : '✗') + ' 新会话命名为「' + base + '」（HTTP ' + rn.status + '）');
              if (rn.status !== 200) die('新会话改名失败 ⇒ 先别动旧会话');
            }
          }
          if (newId && !failed) {
            // ⑤ 旧会话：改名 + **真归档**（只改名不算归档 —— 侧边栏照样列着）
            const ra = await rpc('session/rename', { request: { sessionId: oldId, title: archTitle } });
            say('  ' + (ra.status === 200 ? '✓' : '✗') + ' 旧会话改名为「' + archTitle + '」（HTTP ' + ra.status + '）');
            let arc = await rpc('workspace/archiveSession', { request: { sessionId: oldId } });
            if (arc.status !== 200 && /session-active/.test(String(arc.t))) {
              say('    （它还有活动在跑 ⇒ 带 stopActivity 重试一次）');
              arc = await rpc('workspace/archiveSession', { request: { sessionId: oldId, stopActivity: true } });
            }
            say('  ' + (arc.status === 200
              ? '✓ 旧会话已真归档（侧边栏里不再显示；工作台设置页「取消归档」可恢复）'
              : '⚠ 归档没成功（HTTP ' + arc.status + '）⇒ 旧会话还会留在侧边栏里 ' + String(arc.t).slice(0, 160)));
            // ⑥ 开场消息 + 打断：空会话不进侧边栏，有内容才看得见
            if (seedIt) {
              const seedTxt = '接手这条零散会话：先读交接文档 ' + (handoff || '（见 §〇）')
                + ' 的 §〇 当前交接 + §一 这件事是什么 + §二 资产与路径。'
                + '读完只回一句「已读交接」即可 —— 不要读别的文件、不要调用任何工具、不要开始干活，等我下一条指令。';
              const pr = await rpc('session/prompt', { request: {
                requestId: (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
                sessionId: newId, mode: 'queue', content: [{ type: 'text', text: seedTxt }],
              } });
              await new Promise((r) => setTimeout(r, 10000));   // 取消太早 ⇒ 这轮没真正开始 ⇒ 会话仍是空的 ⇒ 侧边栏照样不显示（2026-09-21 实测）
              const cx = await rpc('session/cancel', { request: { sessionId: newId } });
              say('  ' + (pr.status === 200 ? '✓' : '✗ HTTP ' + pr.status) + ' 已给新会话写入开场消息（它才会出现在侧边栏）');
              say('  ' + (cx.status === 200 ? '✓' : '✗ HTTP ' + cx.status) + ' 已打断这轮（开场消息明令它别干活，这轮不会动任何东西）');
            } else say('  （--no-seed：没写开场消息 ⇒ 新会话是空的，侧边栏可能看不到它）');
            // ⑦ 交接文档：旧会话 id → 新会话 id（新会话读到的就是它自己）
            if (handoff && fs.existsSync(handoff)) {
              let txt = fs.readFileSync(handoff, 'utf8');
              const n = txt.split(oldId).length - 1;
              if (n) {
                const nw = new Date(), p2 = (x) => ('0' + x).slice(-2);
                const fmtNow = nw.getFullYear() + '-' + p2(nw.getMonth() + 1) + '-' + p2(nw.getDate()) + ' ' + p2(nw.getHours()) + ':' + p2(nw.getMinutes());
                txt = txt.split(oldId).join(newId)
                  .replace(/(>\s*归档时间：)[^\n]*/g, '$1' + fmtNow);
                fs.writeFileSync(handoff, txt, 'utf8');
                say('  ✓ 交接文档已把旧会话 id 换成新会话（' + n + ' 处）：' + path.basename(handoff));
              } else say('  （交接文档里没出现旧会话 id ⇒ 跳过回写；建议在 §〇 身份行写上 ' + newId.slice(0, 20) + '…）');
            }
            say('\n✓ 零散会话轮换完成。新会话：' + newId);
            say('  标题「' + (adopt ? ((sessions.find((s) => s.id === newId) || {}).title || '（沿用它原来的标题）') : base) + '」');
            say('  去左侧侧边栏找它（若没立刻出现，点一下标题栏 ⟳ 刷新）。');
          }
        }
      }
    }
    process.exitCode = failed ? 1 : 0;
  }
}
