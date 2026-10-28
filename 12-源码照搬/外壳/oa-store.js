// oa-store.js — OA 运维场景的本地持久化层（与股票 memory/chats/market 完全隔离）
// 数据文件：<工作台>\外壳\data\oa.db（SQLite，node:sqlite 零依赖）
// 设计：本模块只存 OA 运维数据（服务器状态/操作日志/网页站点/备份/文件/终端历史/配置），
//       绝不含任何股票数据。后续接入真实服务器时，SSH 采集器把真实数据写进这些表，
//       前端与 AI 上下文读到的就是真实数据（写入口不变，只换数据源）。
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'oa.db'));
db.exec('PRAGMA journal_mode = WAL;');

// ---------- 建表 ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS status_snapshot (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      TEXT NOT NULL,
    payload TEXT NOT NULL            -- JSON: { host, os, uptime, cpu, mem, disk, services: [...] }
  );
  CREATE TABLE IF NOT EXISTS op_log (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    ts     TEXT NOT NULL,
    level  TEXT NOT NULL DEFAULT 'info',   -- info | warn | err
    source TEXT NOT NULL DEFAULT 'system', -- system | action | shell | user
    msg    TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS web_sites (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    url        TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'unknown',  -- 正常 | 异常 | 维护中 | unknown
    note       TEXT DEFAULT '',
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS backups (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    path       TEXT NOT NULL,
    size       TEXT DEFAULT '',
    status     TEXT NOT NULL DEFAULT 'done',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS files_cache (
    base    TEXT PRIMARY KEY,
    payload TEXT NOT NULL,           -- JSON: [{ ic, name, size, type }]
    ts      TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS shell_history (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    ts     TEXT NOT NULL,
    cmd    TEXT NOT NULL,
    result TEXT DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_oplog_ts ON op_log(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_shell_ts ON shell_history(ts DESC);
`);

// ---------- 工具 ----------
function now() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
function ts(t) { return String(t || now()); }

// ---------- 演示种子数据（接入真实服务器后由采集器覆盖） ----------
function seedIfEmpty() {
  // 1) 服务器状态快照
  const snap = db.prepare('SELECT COUNT(*) AS n FROM status_snapshot').get();
  if (!snap || !snap.n) {
    const payload = {
      host: 'prod-oa-01 (<内网IP>)',
      os: 'Ubuntu 22.04 LTS',
      uptime: '36 天 4 小时',
      cpu: 23, mem: 41, disk: 58,
      services: [
        { name: 'nginx', state: 'running', ok: true },
        { name: 'oa-app (gunicorn)', state: 'running', ok: true },
        { name: 'postgresql', state: 'running', ok: true },
        { name: 'redis', state: 'running', ok: true },
        { name: 'celery-worker', state: 'down', ok: false }
      ]
    };
    db.prepare('INSERT INTO status_snapshot(ts, payload) VALUES(?, ?)').run(now(), JSON.stringify(payload));
  }
  // 2) 操作日志（演示）
  const logs = db.prepare('SELECT COUNT(*) AS n FROM op_log').get();
  if (!logs || !logs.n) {
    const today = now().slice(0, 10);
    const rows = [
      [today + ' 10:23:11', 'info', 'system', '服务 oa-app 健康检查通过 (200 OK)'],
      [today + ' 10:22:47', 'info', 'system', 'nginx reload 完成'],
      [today + ' 10:22:40', 'warn', 'system', 'celery-worker 心跳超时，正在重启'],
      [today + ' 10:20:05', 'info', 'action', '部署 release-2025.09.06 成功'],
      [today + ' 10:18:32', 'info', 'action', 'git pull origin master (3 files changed)'],
      [today + ' 10:15:00', 'err', 'system', '<内网IP> 连续 3 次登录失败（已锁定）'],
      [today + ' 10:12:19', 'info', 'system', '备份 /data/postgres 完成 (1.2GB)']
    ];
    const ins = db.prepare('INSERT INTO op_log(ts, level, source, msg) VALUES(?, ?, ?, ?)');
    rows.forEach(r => ins.run(r[0], r[1], r[2], r[3]));
  }
  // 3) 网页站点（网页管控清单）
  const sites = db.prepare('SELECT COUNT(*) AS n FROM web_sites').get();
  if (!sites || !sites.n) {
    const ins = db.prepare('INSERT INTO web_sites(name, url, status, note, updated_at) VALUES(?, ?, ?, ?, ?)');
    [['OA 门户', 'https://oa.example.local', '正常', '对外门户', now()],
     ['管理后台', 'https://oa.example.local/admin', '正常', '仅内网访问', now()],
     ['API 网关', 'https://api.oa.example.local', '正常', 'n8n / 对外接口', now()],
     ['健康检查', 'https://oa.example.local/healthz', '正常', '监控探针', now()]]
      .forEach(r => ins.run(r[0], r[1], r[2], r[3], r[4]));
  }
  // 4) 备份记录
  const bks = db.prepare('SELECT COUNT(*) AS n FROM backups').get();
  if (!bks || !bks.n) {
    const ins = db.prepare('INSERT INTO backups(name, path, size, status, created_at) VALUES(?, ?, ?, ?, ?)');
    ins.run('oa-20260906.dump', '/data/backups/oa-20260906.dump', '1.2 GB', 'done', '2026-09-06 10:12:00');
    ins.run('oa-20260905.dump', '/data/backups/oa-20260905.dump', '1.2 GB', 'done', '2026-09-05 10:12:00');
  }
  // 5) 文件浏览缓存（/opt/oa）
  const fc = db.prepare('SELECT COUNT(*) AS n FROM files_cache').get();
  if (!fc || !fc.n) {
    const payload = [
      { ic: '📁', name: 'config/', size: '—', type: '目录' },
      { ic: '📁', name: 'logs/', size: '—', type: '目录' },
      { ic: '📄', name: 'app.py', size: '28 KB', type: 'Python' },
      { ic: '📄', name: 'settings.py', size: '12 KB', type: 'Python' },
      { ic: '📄', name: 'requirements.txt', size: '1.2 KB', type: 'Text' },
      { ic: '📄', name: '.env', size: '0.8 KB', type: 'Config' },
      { ic: '📄', name: 'deploy.sh', size: '4 KB', type: 'Shell' }
    ];
    db.prepare('INSERT OR REPLACE INTO files_cache(base, payload, ts) VALUES(?, ?, ?)').run('/opt/oa', JSON.stringify(payload), now());
  }
  // 6) 配置占位（SSH 连接信息：明文存 D 盘，绝不落 C 盘）
  const cfg = db.prepare('SELECT COUNT(*) AS n FROM config').get();
  if (!cfg || !cfg.n) {
    const ins = db.prepare('INSERT OR REPLACE INTO config(key, value) VALUES(?, ?)');
    [['ssh.host', ''], ['ssh.port', '22'], ['ssh.user', ''], ['ssh.auth', 'password'], ['ssh.credential', ''],
     ['backup.strategy', '每日 02:00 全量 + 每小时 WAL 归档'],
     ['web.base', 'https://oa.example.local']]
      .forEach(r => ins.run(r[0], r[1]));
  }
}
seedIfEmpty();

// ---------- 内置一键操作清单（后续可扩展为从配置读取） ----------
const ACTIONS = [
  { id: 'restart-oa-app', name: '重启 oa-app', cmd: 'systemctl restart oa-app', danger: false },
  { id: 'reload-nginx', name: '重载 nginx', cmd: 'nginx -s reload', danger: false },
  { id: 'git-pull', name: '拉取最新代码', cmd: 'cd /opt/oa && git pull origin master', danger: false },
  { id: 'backup-db', name: '执行数据库备份', cmd: 'pg_dump -h localhost -U oa oa > /data/backups/oa-$(date +%F).dump', danger: false },
  { id: 'cleanup-logs', name: '清理日志 (>7d)', cmd: 'logrotate -f /etc/logrotate.d/oa', danger: true }
];

// ---------- 对外接口 ----------
module.exports = {
  // 状态快照
  getStatus() {
    const r = db.prepare('SELECT ts, payload FROM status_snapshot ORDER BY id DESC LIMIT 1').get();
    if (!r) return null;
    try { return Object.assign({ ts: r.ts }, JSON.parse(r.payload)); } catch (e) { return null; }
  },
  setStatus(payload) {
    db.prepare('INSERT INTO status_snapshot(ts, payload) VALUES(?, ?)').run(now(), JSON.stringify(payload || {}));
    return true;
  },
  // 操作日志
  getLogs(limit) {
    const n = Math.max(1, Math.min(500, Number(limit) || 50));
    return db.prepare('SELECT id, ts, level, source, msg FROM op_log ORDER BY id DESC LIMIT ?').all(n).reverse();
  },
  addLog(level, source, msg) {
    db.prepare('INSERT INTO op_log(ts, level, source, msg) VALUES(?, ?, ?, ?)').run(now(), level || 'info', source || 'system', String(msg || ''));
    return true;
  },
  // 网页站点（网页管控）
  listWebSites() {
    return db.prepare('SELECT id, name, url, status, note, updated_at FROM web_sites ORDER BY id').all();
  },
  setWebSiteStatus(id, status) {
    db.prepare('UPDATE web_sites SET status = ?, updated_at = ? WHERE id = ?').run(status || 'unknown', now(), id);
    return true;
  },
  // 按 URL 同步真实站点（存在则更新状态/备注，不存在则插入；用于真实探测结果回写）
  syncWebSites(list) {
    const t = now();
    const ins = db.prepare('INSERT OR IGNORE INTO web_sites(name, url, status, note, updated_at) VALUES(?, ?, ?, ?, ?)');
    const upd = db.prepare('UPDATE web_sites SET name = ?, status = ?, note = ?, updated_at = ? WHERE url = ?');
    (list || []).forEach(w => {
      if (!w || !w.url) return;
      const r = db.prepare('SELECT id FROM web_sites WHERE url = ?').get(w.url);
      if (r) upd.run(w.name || w.url, w.status || 'unknown', w.note || '', t, w.url);
      else ins.run(w.name || w.url, w.url, w.status || 'unknown', w.note || '', t);
    });
    return true;
  },
  // 备份
  listBackups(limit) {
    const n = Math.max(1, Math.min(100, Number(limit) || 10));
    return db.prepare('SELECT id, name, path, size, status, created_at FROM backups ORDER BY id DESC LIMIT ?').all(n);
  },
  // 文件浏览缓存
  getFiles(base) {
    const r = db.prepare('SELECT payload, ts FROM files_cache WHERE base = ?').get(String(base || '/opt/oa'));
    if (!r) return { base: String(base || '/opt/oa'), rows: [], ts: null };
    try { return { base: String(base || '/opt/oa'), rows: JSON.parse(r.payload), ts: r.ts }; } catch (e) { return { base: String(base || '/opt/oa'), rows: [], ts: r.ts }; }
  },
  setFiles(base, rows) {
    db.prepare('INSERT OR REPLACE INTO files_cache(base, payload, ts) VALUES(?, ?, ?)').run(String(base || '/opt/oa'), JSON.stringify(rows || []), now());
    return true;
  },
  // 终端历史
  getShellHistory(limit) {
    const n = Math.max(1, Math.min(200, Number(limit) || 30));
    return db.prepare('SELECT id, ts, cmd, result FROM shell_history ORDER BY id DESC LIMIT ?').all(n).reverse();
  },
  addShell(cmd, result) {
    db.prepare('INSERT INTO shell_history(ts, cmd, result) VALUES(?, ?, ?)').run(now(), String(cmd || ''), String(result || ''));
    return true;
  },
  // 配置（SSH 连接等，明文存 D 盘）
  getConfig(key) {
    const r = db.prepare('SELECT value FROM config WHERE key = ?').get(String(key || ''));
    return r ? r.value : null;
  },
  setConfig(key, value) {
    db.prepare('INSERT OR REPLACE INTO config(key, value) VALUES(?, ?)').run(String(key || ''), String(value == null ? '' : value));
    return true;
  },
  sshConnected() {
    const h = db.prepare('SELECT value FROM config WHERE key = ?').get('ssh.host');
    return !!(h && h.value);
  },
  // 一键操作
  listActions() {
    return ACTIONS.map(a => Object.assign({}, a));
  },
  getAction(id) {
    return ACTIONS.find(a => a.id === id) || null;
  }
};
