#!/usr/bin/env node
// 建会话.mjs —— 不开 GUI、不用点侧边栏，直接経引擎 RPC 建一条会话（给新场景的 AI 面板用）
//
// 为什么需要它：新场景的 AI 面板要写 `sessionId`（身份校验）/`sessionTitle`（逐字一致的标题），
//   而"在 GUI 里手建再抄 id"既慢又容易抄错。引擎有 `session/create` + `session/rename` 两个 RPC，
//   这里照 `sessions.mjs` 的实测配方调（token 从 server.log 取 → 换签名 cookie → POST /api/<method>）。
//
// ⚠ 两条实测铁律（抄自 sessions.mjs，别改）：
//   ① **必须传 workspaceId**：侧边栏按 workspace 分组，只传 cwd 建出来的会话会掉进「未分组」（2026-09-21 实测）；
//   ② **空会话不进侧边栏**：默认建完塞一条开场消息再打断（`--no-seed` 可关）。
//
// 用法：
//   node scripts\建会话.mjs --title "设计杂活"                       # 默认挂 <临时目录> 的工作区
//   node scripts\建会话.mjs --title "设计杂活" --cwd "<资料库>"        # 换工作区
//   node scripts\建会话.mjs --title "设计杂活" --no-seed --dry        # 空跑，不真建
//   输出最后一行就是 sessionId（可直接抄进 scenarios\*.json）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS_DIR = process.env.DSH_HARNESS_DIR || '<工作台>\\引擎';
const DSH_HOME = process.env.DSH_HOME || path.join(HARNESS_DIR, '.dsh');
const BASE = process.env.DSH_GUI_BASE || 'http://127.0.0.1:3080';

const argv = process.argv.slice(2);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const title = val('--title', '');
const cwd = val('--cwd', '<工作台>\\工作区');   // 2026-10-16 起默认新工作区（口径：说明\默认工作区.md）
const dry = argv.includes('--dry');
const seedIt = !argv.includes('--no-seed');

if (!title) { console.error('用法：node scripts\\建会话.mjs --title "会话名" [--cwd "<工作台>\\工作区"] [--no-seed] [--dry]'); process.exit(2); }
const say = (s) => console.log(s);
const die = (s) => { console.error('✗ ' + s); process.exit(1); };

// ── 找 workspace id（侧边栏分组靠它）──
let wsId = '', wsTitle = '';
try {
  const wf = path.join(DSH_HOME, 'storages', 'workspace.json');
  const tbl = (fs.existsSync(wf) ? JSON.parse(fs.readFileSync(wf, 'utf8')) : {}).tables || {};
  const norm = (s) => String(s || '').replace(/[\\/]+$/, '').toLowerCase();
  for (const [id, v] of Object.entries(tbl.workspaces || {})) {
    if (norm(v.path) === norm(cwd)) { wsId = id; wsTitle = v.title || ''; break; }
  }
} catch (e) { /* 读不到就退回 cwd */ }
say('工作区：' + (wsId ? '「' + wsTitle + '」 ' + wsId : '⚠ 没找到 ' + cwd + ' 对应的工作区（会落进「未分组」）'));

if (dry) { say('\n--dry：以上只是查了工作区，没有建会话。去掉 --dry 即真做。'); process.exit(0); }

// ── token → 签名 cookie（必须 redirect:'manual'，跟随后反而 401）──
const LOG = path.join(root, 'server.log');
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
if (!cookie) die('换不到 cookie（引擎没在跑或 token 失效）—— 工作台在跑时重试即可');

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

// ── 建会话 ──
const c = await rpc('session/create', { request: wsId ? { workspaceId: wsId } : { cwd } });
const newId = c.j && c.j.result && c.j.result.value && c.j.result.value.sessionId;
if (!newId) die('建会话失败：HTTP ' + c.status + ' ' + String(c.t).slice(0, 200));
say('✓ 新会话：' + newId);

const rn = await rpc('session/rename', { request: { sessionId: newId, title } });
if (rn.status !== 200) die('改名失败（HTTP ' + rn.status + '）⇒ 别把 id 写进 json');
say('✓ 已命名为「' + title + '」');

// ── 开场消息（空会话不进侧边栏）+ 立刻打断（这轮不许干活）──
if (seedIt) {
  const seedTxt = '你是「' + title + '」场景的 AI 助手。现在只回一句话「已读」即可 —— '
    + '不要读任何文件、不要调用任何工具、不要开始干活，等用户下一条指令。';
  const pr = await rpc('session/prompt', { request: {
    requestId: (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
    sessionId: newId, mode: 'queue', content: [{ type: 'text', text: seedTxt }],
  } });
  await new Promise((r) => setTimeout(r, 10000));   // 太早取消 = 这轮没真开始 = 会话仍是空 = 侧边栏看不到
  const cx = await rpc('session/cancel', { request: { sessionId: newId } });
  say((pr.status === 200 ? '✓' : '✗ HTTP ' + pr.status) + ' 开场消息   ' + (cx.status === 200 ? '✓' : '✗ HTTP ' + cx.status) + ' 已打断（这轮不会动任何东西）');
} else say('（--no-seed：没写开场消息，侧边栏可能要等它被打开过才显示）');

say('\nsessionId = ' + newId);
say('下一步：把下面两行写进 scenarios\\<场景id>.json 的 AI 面板：');
say('  "sessionTitle": "' + title + '",');
say('  "sessionId": "' + newId + '",');
