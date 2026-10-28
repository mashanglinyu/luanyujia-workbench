// 把指定会话改名（引擎 RPC session/rename，照 建会话.mjs 的实测配方）
// 用法：node 会话改名.mjs <sessionId> "<新标题>"
import fs from 'node:fs';
import path from 'node:path';

const [sid, title] = process.argv.slice(2);
if (!sid || !title) {
  console.log('用法：node 会话改名.mjs <sessionId> "新标题"');
  process.exit(2);
}
const BASE = process.env.DSH_GUI_BASE || 'http://127.0.0.1:3080';
const DSH_HOME = process.env.DSH_HOME || '<盘根>:/DSH/引擎/.dsh';
// token 在「外壳」的 server.log 里（不是 引擎 目录）；两个位置都试
const LOG = ['<盘根>:/DSH/外壳/server.log', path.join(path.dirname(DSH_HOME), 'server.log')]
  .find((p) => fs.existsSync(p)) || '';

const toks = fs.existsSync(LOG)
  ? [...fs.readFileSync(LOG, 'utf8').matchAll(/dsh web:\s*http:\/\/127\.0\.0\.1:3080\/\?token=([A-Za-z0-9_\-]{16,})/g)].map((m) => m[1]).reverse()
  : [];
let cookie = '';
for (const t of toks.slice(0, 3)) {
  try {
    const r = await fetch(BASE + '/?token=' + t, { redirect: 'manual' });
    const sc = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
    if (sc.length) { cookie = sc.map((c) => c.split(';')[0]).join('; '); break; }
  } catch (e) { /* next */ }
}
if (!cookie) { console.log('✗ 换不到 cookie（引擎没在跑？）'); process.exit(1); }

const rpc = async (method, args) => {
  const r = await fetch(BASE + '/api/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method, payload: { args } }),
  });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, j, t };
};

const r = await rpc('session/rename', { request: { sessionId: sid, title } });
if (r.status !== 200) {
  console.log('✗ 改名失败 HTTP ' + r.status + ' · ' + String(r.t).slice(0, 200));
  process.exit(1);
}
console.log('✓ 已改名：' + sid + ' → 「' + title + '」');
