// ── 换会话.mjs —— 一条命令换会话（建新 + 旧归档 + 回写 + 自检）
// 摘自本机实现 `换会话.mjs` 的 全文。
// 脱敏：内部 API 名已去品牌化（kun → app）· 绝对路径 → <DSH根>/<工作区> · 个人名/客户名/站点 → 占位
// 面板 → 交接文件的映射表已把真实路径换成占位
// ⚠ 摘录/单文件：脱离这套工作台不能直接运行（依赖壳注入的 app.* 实例与页面上下文）。

// 「换会话」一键入口（2026-09-21 第 9 轮）——用户要的"一个固定命令，不用思考"。
//
// 用途：把某个场景面板的常驻会话**归档 + 新建一条同名的新会话顶上来**（= sessions.mjs --rotate 的傻瓜包装）。
//
//   node "<DSH根>\外壳\scripts\换会话.mjs"            列出 8 个面板 + 是否到线 + 交接是否够新鲜
//   node "<DSH根>\外壳\scripts\换会话.mjs" site-ai     空跑：打印计划，不动任何东西
//   node "<DSH根>\外壳\scripts\换会话.mjs" site-ai --go   真换（用户只要记到这一条）
//   可加 --force：交接文件超过 2 小时也照换（会有警告，仍要求文件存在）
//
// 零散会话（没有场景/面板的那些 · 2026-09-23 加）—— 走同一入口，加 --stray：
//   node "…\scripts\换会话.mjs" --stray                     列出所有零散会话（压力 + 交接文档有没有）
//   node "…\scripts\换会话.mjs" --stray 华为电脑管家升级        空跑：打印计划
//   node "…\scripts\换会话.mjs" --stray 华为电脑管家升级 --go    真换
//   可加 --adopt <会话id>：认领一条已经建好的会话顶替（不新建）；--handoff <文件> 指定交接文档。
//   零散会话的交接文档 = `<DSH根>\引擎\场景项目信息\其他会话临时项目信息交接文档\<会话名>-<YYYYMMDD-HHMM>.md`，
//   不给 --handoff 时按标题自动匹配；真换做全四步：建/认领新会话 → 旧会话改名+**真归档** → 给新会话写开场消息
//   （空会话不进侧边栏）→ 把交接文档里的旧会话 id 换成新的。真逻辑同样转交 sessions.mjs（--rotate … --stray）。
//
// 它替用户想好的事（所以不用思考）：
//   ① 自动找到这个面板的**项目信息文件**（= 交接文件），不用写路径；
//   ② 交接**没写或太旧**的时候**不硬来**：打印"要么去写 §〇，要么加 --force"一句话；
//   ③ 没到线（<80%）时只提醒"现在换是浪费"，除非加 --force；
//   ④ 干完把 sessions.mjs 的完整报告原样透出来（含轮换后的「同步点自检」）。
// 真逻辑一行都没重写：全部转交 `sessions.mjs --rotate <面板id> --handoff <文件>`。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));      // …\工作台外壳\scripts
const GUI = path.resolve(here, '..');                            // …\工作台外壳
const DSH_HOME = process.env.DSH_HOME || '<盘根>\\DSH\\引擎\\.dsh';
const SESSIONS = path.join(here, 'sessions.mjs');

// 面板 → 该场景的长期记忆（= 交接文件）。只有这些面板能自动交接。
const HANDOFF = {
  'dz-ai': '<盘根>\\DSH\\引擎\\场景项目信息\\设计杂活\\场景记忆',
  'pc-ai': '<盘根>\\DSH\\引擎\\场景项目信息\\本地电脑\\场景记忆',
  'dg-dsh': '<盘根>\\DSH\\引擎\\（本机维护笔记，未公开）.md',        // 引擎侧：§〇 当前交接
  'dg-gui': path.join(GUI, '场景记忆'),                            // 界面侧
  // ★2026-10-13★ 场景长期记忆已从 `<DSH根>\引擎\场景项目信息` 搬到 `<DSH根>\引擎\场景项目信息`
  //   （旧根已删）。这里原来是**转义写法**（`\\`），搬家的文本扫描匹配不到 ⇒ 漏改，换会话会把交接写到已删的旧路径去。
  //   路径要与 `scenarios\05-协作与规矩/四-身份索引-怎么建.md.md` §五 表一致；`sr-ai` 例外：自我复盘的记忆不在根下，在 `<盘根>\学习和自己\`。
  'bl-ai': '<盘根>\\DSH\\引擎\\场景项目信息\\blender\\场景记忆',
  'oa-ai': '<盘根>\\工作\\工程文件\\<客户>教育oa\\项目信息\\README.md',      // ⚠ 本场景自成一体的项目信息
  'site-ai': '<盘根>\\DSH\\引擎\\场景项目信息\\<个人站场景>\\场景记忆',
  'sr-ai': '<盘根>\\DSH\\自我复盘\\_场景记忆\\场景记忆',        // ⚠ 不在场景项目信息根下（索引 §五 表原文）
  'mk-chat': '<盘根>\\DSH\\引擎\\场景项目信息\\<分析场景>\\场景记忆',
  'vw-ai': '<盘根>\\DSH\\引擎\\场景项目信息\\视频工作流\\场景记忆',
};
const FRESH_MS = 2 * 60 * 60 * 1000;      // 与 sessions.mjs 的硬闸门一致：2 小时内改过才算"写好了"

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const args = argv.filter((a) => !a.startsWith('--'));
const say = (...a) => console.log(...a);

function panels() {
  const dir = path.join(GUI, 'scenarios');
  const out = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    let j; try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) } catch { continue }
    for (const p of (j.panels || [])) if (p.type === 'harness') out.push({ file: f, scen: j.id || f, p });
  }
  return out;
}
/** 面板当前的压力：读引擎 projcache。
 *  ⚠ 数字是**引擎上次落盘时**的：正在被使用的会话，这个文件可能落后好几分钟
 *  ⇒ 超过 10 分钟的一律标 stale，只显示"多旧"，不拿来当判据（判据只认 ctx.mjs 当场那一行）。 */
function pressures() {
  const map = {};
  const base = path.join(DSH_HOME, 'storages');
  for (const d of (fs.existsSync(base) ? fs.readdirSync(base) : [])) {
    const sd = path.join(base, d, 'sessions');
    if (!fs.existsSync(sd)) continue;
    for (const f of fs.readdirSync(sd)) {
      if (!f.endsWith('.json')) continue;
      const full = path.join(sd, f);
      let r; try { r = JSON.parse(fs.readFileSync(full, 'utf8')).record } catch { continue }
      const pv = r?.rows?.contextPressure?.val;
      if (!pv) continue;
      const line = Math.floor((pv.contextWindow || 160000) * 0.8);
      const projected = pv.pressureTokens > 0
        ? Math.round(pv.pressureTokens + (pv.surfaceTokens || 0) - (pv.sampledSurfaceTokens ?? pv.surfaceTokens ?? 0))
        : Math.round(pv.surfaceTokens || 0);
      let mtime = 0; try { mtime = fs.statSync(full).mtimeMs } catch { /* 读不到就当 0 */ }
      map[f.replace(/\.json$/, '')] = {
        pct: Math.round(projected / line * 100), turns: r.rows.sessionStats?.val?.turns ?? null,
        title: r.rows.title?.val || '', mtime, stale: Date.now() - mtime > 10 * 60 * 1000,
      };
    }
  }
  return map;
}
function fresh(file) { try { return fs.statSync(file).mtimeMs } catch { return 0 } }
function ago(ms) {
  if (!ms) return '（文件不存在）';
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 60 ? m + ' 分钟前' : (m < 2880 ? Math.round(m / 60) + ' 小时前' : Math.round(m / 1440) + ' 天前');
}

// ── 无参数：总览 ────────────────────────────────────────────────────────────
if (!args.length) {
  const P = pressures();
  say('8 个面板现状（压力数字后面带 "(旧)" = 引擎好几分钟没落盘，仅供参考）\n');
  say('  面板       会话        压力        交接文件（改于）');
  for (const { p } of panels()) {
    const st = P[p.sessionId] || null;
    const pct = st ? (st.stale ? st.pct + '%(旧)' : st.pct + '%') : '?';
    const h = HANDOFF[p.id] ? ago(fresh(HANDOFF[p.id])) : '（无交接文件）';
    say('  ' + String(p.id).padEnd(10) + String((p.sessionId || '').replace(/^session-/, '').slice(0, 8)).padEnd(11) +
      String(pct).padStart(11) + '        ' + h + (st && st.turns != null ? '   第' + st.turns + '轮' : ''));
  }
  say('\n换一个：node "…\\scripts\\换会话.mjs" <面板id> --go        只看计划就去掉 --go');
  say('零散会话（没场景的）：node "…\\scripts\\换会话.mjs" --stray        看清单；加 <名字|id> --go 换它');
  process.exit(0);
}

// ── 零散会话（--stray，2026-09-23 加）：没有面板可查 ⇒ 直接转交 sessions.mjs 的零散轮换 ────────
// 零散会话没有场景 json、没有交接文件登记表：交接文档由 sessions.mjs 按标题去
// `其他会话临时项目信息交接文档\` 里自动匹配（也可自己给 --handoff）。
if (flags.has('--stray')) {
  const q = args[0] || '';
  const pass = q ? ['--rotate', q, '--stray'] : ['--stray'];
  if (q && !flags.has('--go')) pass.push('--dry');
  if (flags.has('--force')) pass.push('--force');
  if (flags.has('--no-seed')) pass.push('--no-seed');
  const ai = argv.indexOf('--adopt');
  if (ai > -1) pass.push('--adopt', argv[ai + 1] || '');
  const hi = argv.indexOf('--handoff');
  if (hi > -1) pass.push('--handoff', argv[hi + 1] || '');
  if (q) say('零散会话（无场景）：' + q + (flags.has('--go') ? '  —— 真换' : '  —— 空跑（加 --go 才真换）') + '\n');
  try {
    const out = execFileSync(process.execPath, [SESSIONS, ...pass], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 << 20 });
    say(out);
  } catch (e) {
    if (e.stdout) say(String(e.stdout));
    if (e.stderr) console.error(String(e.stderr));
    say('✗ 没换成（上面是原样输出）' + (e.status != null ? '，退出码 ' + e.status : ''));
    process.exit(e.status || 1);
  }
  if (q && flags.has('--go')) say('\n✅ 已换。去左侧侧边栏找新会话（没立刻出现就点一下标题栏 ⟳ 刷新）。');
  process.exit(0);
}

// ── 带面板 id：检查 → 转交 sessions.mjs ─────────────────────────────────────
const id = args[0];
const hit = panels().find((x) => x.p.id === id) || null;
if (!hit) {
  say('✗ 没有这个面板：' + id + '（写面板 id，如 site-ai；不带参数可看全部）');
  process.exit(2);
}
const handoff = HANDOFF[id] || '';
const P = pressures();
const st = P[hit.p.sessionId] || null;

say('面板 ' + id + '（场景 ' + hit.scen + '）');
say('  现在这轮：' + (hit.p.sessionId || '(未绑定)') + '  「' + (hit.p.sessionTitle || hit.p.title || '') + '」');
say('  体积参考：' + (st
  ? (st.stale
    ? '引擎上次落盘是 ' + ago(st.mtime) + '（' + st.pct + '%(旧)）—— 这条会话可能刚活动过，数字没刷新，**不当判据**'
    : st.pct + '% · 第' + st.turns + '轮')
  : '读不到'));
say('  交接文件：' + (handoff || '（这个面板没登记交接文件，先去写它的项目信息 §〇）'));
if (handoff) say('  改于    ：' + ago(fresh(handoff)));

const problems = [];
if (!handoff) problems.push('这个面板没有登记"项目信息文件" —— 先写它的 §〇，或告诉我该用哪个文件');
else if (!fresh(handoff)) problems.push('交接文件不存在：' + handoff);
else if (Date.now() - fresh(handoff) > FRESH_MS && !flags.has('--force')) problems.push('交接文件超过 2 小时没更新 ⇒ 先把 §〇（进度/下一步/卡点）写好；确实不想写就加 --force');
// 刻意**不**拿压力当闸门：① 用户明确说要换就是要换；② projcache 的数字对活跃会话是滞后的，拿它拦人是误拦。
if (st && !st.stale && st.pct < 50) say('\n（提示：这条才 ' + st.pct + '%，换了会丢掉现在这段上下文 —— 你说了算）');

if (problems.length) {
  say('\n⚠ 先别急：');
  for (const x of problems) say('  · ' + x);
  say('\n（没真动任何东西）');
  process.exit(3);
}

const cmd = ['"' + SESSIONS + '"', '--rotate', id, '--handoff', '"' + handoff + '"', ...(flags.has('--force') ? ['--force'] : [])];
say('\n' + (flags.has('--go') ? '▶ 开始换会话（真执行）' : '▶ 空跑计划（去掉 --go 之外什么都没发生；真要换加 --go）') + '\n');
const line = 'node ' + cmd.join(' ');
say('  内部执行：' + line + '\n');
try {
  const out = execFileSync(process.execPath, [SESSIONS, '--rotate', id, '--handoff', handoff,
    ...(flags.has('--force') ? ['--force'] : []), ...(flags.has('--go') ? [] : ['--dry'])],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 << 20 });
  say(out);
} catch (e) {
  if (e.stdout) say(String(e.stdout));
  if (e.stderr) console.error(String(e.stderr));
  say('✗ 轮换失败（上面是原样输出）' + (e.status != null ? '，退出码 ' + e.status : ''));
  process.exit(1);
}
if (flags.has('--go')) say('\n✅ 已换。去那个面板点一次 ⟳（或刷新场景）就接上新会话。');
