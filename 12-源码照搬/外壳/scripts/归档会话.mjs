#!/usr/bin/env node
// 归档会话.mjs —— 从**外面**把一条会话真正归档（= 写进 workspace.json 的 global.archivedSessionIds，
// 侧边栏里不再显示；工作台设置页「取消归档」可恢复）。
//
// 为什么需要它（2026-09-27 用户报）：让**会话自己**归档自己永远只成功一半 ——
//   引擎的 `session/rename` 会成功（标题变成「已归档 · X · 日期」），
//   但 `workspace/archiveSession` 会被拒（会话自己还在跑，活动没停）⇒ 结果"只改了个名字"。
//   ⇒ 正解就是从**另一条会话/脚本**里归档它（本工具干这个；换会话.mjs / sessions.mjs --rotate 也是这么做的）。
//
// 用法：
//   node scripts\归档会话.mjs <会话id或标题>           只看计划（默认 dry-run）
//   node scripts\归档会话.mjs <会话id或标题> --go      真归档（带活动时自动 stopActivity 重试）
//   node scripts\归档会话.mjs --list                   列出：已归档 / 名字带「已归档」但没真归档的
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DSH_HOME = process.env.DSH_HOME || '<盘根>:\\software\\DSH全场景工作助手\\引擎\\.dsh';
const BASE = process.env.DSH_GUI_BASE || 'http://127.0.0.1:3080';
const WS = path.join(DSH_HOME, 'storages', 'workspace.json');
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const q = argv.filter((a) => !a.startsWith('--'))[0] || '';

const say = (s) => console.log(s);
const readWs = () => JSON.parse(fs.readFileSync(WS, 'utf8'));
const archivedIds = () => new Set((readWs().global || {}).archivedSessionIds || []);

// token：GUI 启动时会把带 token 的地址写进 server.log
function findToken() {
  for (const f of ['server.log']) {
    const p = path.join(root, f);
    if (!fs.existsSync(p)) continue;
    const m = [...fs.readFileSync(p, 'utf8').matchAll(/\?token=([A-Za-z0-9._-]{8,})/g)];
    if (m.length) return m[m.length - 1][1];
  }
  return '';
}

async function connect() {
  const t = findToken();
  if (!t) throw new Error('拿不到 token（GUI 没在跑？或者 server.log 里没有 ?token=）');
  const r = await fetch(BASE + '/?token=' + t, { redirect: 'manual' });
  const cookie = (r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')])
    .filter(Boolean).map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error('拿不到 cookie（token 过期？）');
  return async (method, args) => {
    const res = await fetch(BASE + '/api/' + method, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', cookie },
      body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method, payload: { args } }),
    });
    const txt = await res.text();
    let j = null; try { j = JSON.parse(txt); } catch (e) { /* 非 JSON */ }
    return { status: res.status, j, t: txt };
  };
}

// 会话清单（标题 + id）：借用 sessions.mjs 的输出，最省事也最准
async function listSessions() {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(process.execPath, [path.join(root, 'scripts', 'sessions.mjs')], { cwd: root, encoding: 'utf8' });
  return out.split('\n').map((line) => {
    // 2026-10-15 修：sessions.mjs 现在打的是 **[裸 uuid36]**（不带 session- 前缀），旧正则只认 `[session-…]`
    // ⇒ 解析恒为空 ⇒ 任何查询都回"找不到会话"（这个坑藏了挺久，因为平时都用 换会话.mjs）。两种形态都收，统一补前缀。
    const m = [line.match(/\[((?:session-)?[0-9a-f-]{36})\]/), line.match(/\](.*?)\[/)];
    if (!m[0]) return null;
    const raw = m[0][1];
    const id = raw.startsWith('session-') ? raw : 'session-' + raw;
    const title = line.split(/\s{2,}/).map((s) => s.trim()).filter(Boolean)[1] || '';
    return { id, title, line: line.trim() };
  }).filter(Boolean);
}

(async () => {
  const arch = archivedIds();
  const all = await listSessions();

  if (flags.has('--list') || !q) {
    const renamedNotArchived = all.filter((s) => /^已归档\s*·/.test(s.title) && !arch.has(s.id));
    say('真归档（侧边栏看不到）：' + arch.size + ' 条');
    say('名字带「已归档」但**没真归档**：' + renamedNotArchived.length + ' 条');
    renamedNotArchived.forEach((s) => say('  ✗ ' + s.id + '  ' + s.title));
    if (!q) say('\n用法：node scripts\\归档会话.mjs <会话id或标题> [--go]');
    return;
  }

  const hit = all.find((s) => s.id === q) || all.find((s) => (s.title || '').includes(q));
  if (!hit) { say('找不到会话：' + q); process.exit(2); }
  if (arch.has(hit.id)) { say('它已经是真归档状态 ✓ 不用动：' + hit.id); return; }
  say('目标：' + hit.id + '  「' + hit.title + '」');
  if (!flags.has('--go')) { say('\n（dry-run：加 --go 才归档）'); return; }

  const rpc = await connect();
  let r = await rpc('workspace/archiveSession', { request: { sessionId: hit.id } });
  if (r.status !== 200) {
    say('第一次没成（HTTP ' + r.status + '）⇒ 带 stopActivity 重试');
    r = await rpc('workspace/archiveSession', { request: { sessionId: hit.id, stopActivity: true } });
  }
  const ok = r.status === 200 && archivedIds().has(hit.id);
  say((ok ? '✓ 已真归档' : '✗ 归档失败（HTTP ' + r.status + '）') + '：' + hit.id + (ok ? '（设置页「取消归档」可恢复）' : ' ' + String(r.t).slice(0, 160)));
  process.exit(ok ? 0 : 1);
})().catch((e) => { say('出错：' + e.message); process.exit(1); });
