// stock-store.js — 股票助手的本地持久化层
// 三个 SQLite 库（node:sqlite，零依赖）：
//   memory.db  —— 私人长期记忆（关注、偏好、持仓、计划、结论）
//   chats.db   —— AI 助手聊天记录（完整对话，分会话）
//   market.db  —— 自选股 / 行情 / K线 快照缓存
// 所有 IPC 均由 main.js 转发到本模块。

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function open(name) {
  const db = new DatabaseSync(path.join(DATA_DIR, name));
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  // 多进程并发（GUI 主进程 + 外部脚本/重置工具）时等锁而不是直接报 SQLITE_BUSY
  db.exec('PRAGMA busy_timeout = 5000;');
  return db;
}

// 列迁移：为已存在的表补充新列（SQLite 无 ADD COLUMN IF NOT EXISTS）
function ensureColumn(db, table, column, ddl) {
  const cols = db.prepare('PRAGMA table_info(' + table + ')').all();
  const has = Array.isArray(cols) && cols.some(c => c.name === column);
  if (!has) db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + ddl);
}

// ---------- 记忆库 ----------
function openMemory() {
  const db = open('memory.db');
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      scenario  TEXT NOT NULL DEFAULT 'stock',  -- 场景隔离：stock | oa-ops | ...
      kind      TEXT NOT NULL,            -- watch|pref|position|plan|insight
      title     TEXT NOT NULL,
      content   TEXT NOT NULL,
      tags      TEXT DEFAULT '',          -- 逗号分隔，便于检索
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mem_kind ON memories(kind);
    CREATE INDEX IF NOT EXISTS idx_mem_scenario ON memories(scenario, kind);
  `);
  // 迁移：老库补 scenario 列，历史记忆归入 'stock'
  ensureColumn(db, 'memories', 'scenario', "TEXT NOT NULL DEFAULT 'stock'");
  return db;
}

// ---------- 聊天记录库 ----------
function openChats() {
  const db = open('chats.db');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      scenario   TEXT NOT NULL DEFAULT 'stock',   -- 场景隔离：stock | oa-ops | ...
      title      TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role       TEXT NOT NULL,           -- user|assistant
      content    TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_msg_session ON messages(session_id, id);
    CREATE INDEX IF NOT EXISTS idx_session_scenario ON sessions(scenario, updated_at);
  `);
  // 迁移：老库的 sessions 表没有 scenario 列 → 补列，历史会话归入 'stock'
  ensureColumn(db, 'sessions', 'scenario', "TEXT NOT NULL DEFAULT 'stock'");
  return db;
}

// ---------- 行情缓存库 ----------
function openMarket() {
  const db = open('market.db');
  db.exec(`
    CREATE TABLE IF NOT EXISTS watchlist (
      code   TEXT PRIMARY KEY,
      name   TEXT NOT NULL,
      added_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS positions (
      code     TEXT PRIMARY KEY,
      name     TEXT NOT NULL,
      shares   REAL NOT NULL DEFAULT 0,    -- 持仓数量（总股数）
      avail    REAL NOT NULL DEFAULT 0,    -- 可用数量（T+1：当日买入次日才可卖）
      cost     REAL NOT NULL DEFAULT 0,    -- 摊薄成本价（同花顺口径：含费；卖出按 (原成本×原数量-净回款)/剩余 递推，可为负）
      added_at TEXT NOT NULL,
      opened_at TEXT
    );
    CREATE TABLE IF NOT EXISTS trades (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      code      TEXT NOT NULL,
      name      TEXT NOT NULL,
      side      TEXT NOT NULL,             -- 'buy' | 'sell'
      shares    REAL NOT NULL,             -- 本次成交数量
      price     REAL NOT NULL,             -- 成交价
      amount    REAL NOT NULL DEFAULT 0,   -- 成交金额 = 数量 × 价格
      commission REAL NOT NULL DEFAULT 0,  -- 佣金（双向，默认万2.5、最低5元）
      stamp     REAL NOT NULL DEFAULT 0,   -- 印花税（仅卖出，0.05%）
      transfer  REAL NOT NULL DEFAULT 0,   -- 过户费（双向，0.001%）
      fee       REAL NOT NULL DEFAULT 0,   -- 费用合计
      realized_pnl REAL NOT NULL DEFAULT 0,-- 本笔已实现盈亏（卖出按摊薄成本计）
      source    TEXT NOT NULL DEFAULT 'trade', -- 'trade' | 'open'（初始建仓）
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trades_code ON trades(code);
    -- 设置表：费率 / T+1 结算日 等（同花顺口径参数）
    CREATE TABLE IF NOT EXISTS config (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS account (
      id       INTEGER PRIMARY KEY CHECK (id = 1),
      cash     REAL NOT NULL DEFAULT 0,    -- 现金（派生：总资产 - 持仓市值）
      total_asset REAL,                    -- 总资产（主字段，用户可编辑；NULL=未初始化）
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS asset_snapshots (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ts         TEXT NOT NULL,            -- 快照时间
      cash       REAL NOT NULL DEFAULT 0,
      mkt_value  REAL NOT NULL DEFAULT 0,  -- 持仓市值
      total      REAL NOT NULL DEFAULT 0,  -- 总资产 = 现金 + 市值
      day_pnl    REAL NOT NULL DEFAULT 0,  -- 当日盈亏金额
      day_pct    REAL NOT NULL DEFAULT 0,  -- 当日盈亏百分比
      payload    TEXT NOT NULL DEFAULT '', -- 明细 JSON（可选）
      UNIQUE (ts)
    );
    CREATE INDEX IF NOT EXISTS idx_asset_ts ON asset_snapshots(ts);
    CREATE TABLE IF NOT EXISTS quote_cache (
      code     TEXT NOT NULL,
      ts       TEXT NOT NULL,
      payload  TEXT NOT NULL,             -- JSON 快照
      PRIMARY KEY (code, ts)
    );
    -- K线持久缓存：按 (代码, 周期) 存最近一次完整结果，重启后不用重新拉
    CREATE TABLE IF NOT EXISTS kline_cache (
      code    TEXT NOT NULL,
      period  TEXT NOT NULL DEFAULT 'day',
      ts      TEXT NOT NULL,
      payload TEXT NOT NULL,              -- JSON: { kline, minute, date, code }
      PRIMARY KEY (code, period)
    );
    -- 全市场排名缓存（选股器用）：按 type(up/down) 存最近一次结果
    CREATE TABLE IF NOT EXISTS rank_cache (
      type    TEXT NOT NULL,
      ts      TEXT NOT NULL,
      payload TEXT NOT NULL,              -- JSON: { list, ts }
      PRIMARY KEY (type)
    );
    -- 板块每日快照（趋势看板用）：按 (市场, 日期, 板块) 存当天该板块的行情概况，
    -- 打开板块雷达/趋势看板时先读当天数据 → 秒开、不再每次全量重拉；历史日期自然累积成趋势
    CREATE TABLE IF NOT EXISTS sector_daily (
      market    TEXT NOT NULL,
      date      TEXT NOT NULL,            -- YYYY-MM-DD（本地日期）
      sector_id TEXT NOT NULL,
      ts        TEXT NOT NULL,
      payload   TEXT NOT NULL,            -- JSON: { avg, up, down, quotes }
      PRIMARY KEY (market, date, sector_id)
    );
    CREATE INDEX IF NOT EXISTS idx_sector_daily_lookup ON sector_daily(market, date);
  `);
  // 迁移：老库补齐同花顺口径字段（SQLite 无 ADD COLUMN IF NOT EXISTS）
  ensureColumn(db, 'positions', 'avail', 'REAL NOT NULL DEFAULT 0');
  ensureColumn(db, 'positions', 'opened_at', 'TEXT');
  ['amount', 'commission', 'stamp', 'transfer', 'fee', 'realized_pnl']
    .forEach(c => ensureColumn(db, 'trades', c, 'REAL NOT NULL DEFAULT 0'));
  ensureColumn(db, 'trades', 'source', "TEXT NOT NULL DEFAULT 'trade'");
  // 迁移：早期版本的 kline_cache 建表时没有 period 列。CREATE TABLE IF NOT EXISTS 不会给已存在的表补列，
  // 缺列会让 K线缓存读写全部抛 "no such column: period" → 个股分析面板永远空白（IPC 直接 reject）。
  // 这是纯缓存表，重建最稳（同时修正复合主键 (code, period)）。
  try {
    const kcols = db.prepare('PRAGMA table_info(kline_cache)').all();
    if (Array.isArray(kcols) && kcols.length && !kcols.some(c => c.name === 'period')) {
      db.exec('DROP TABLE kline_cache');
      db.exec(`CREATE TABLE kline_cache (
        code    TEXT NOT NULL,
        period  TEXT NOT NULL DEFAULT 'day',
        ts      TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (code, period)
      )`);
    }
  } catch (e) { /* 迁移失败不阻塞启动，仅影响缓存 */ }
  // ★2026-10-15：`quote_cache` 天生会膨胀，启动时做一次"只留最新一行"的清理。
  //   为什么：表主键是 (code, ts) 而 ts 是毫秒时间戳 ⇒ `INSERT OR REPLACE` **永远是新插入**，
  //   而读取只取 `ORDER BY ts DESC LIMIT 1` ⇒ 旧行 100% 是垃圾。板块雷达每 3 分钟写 108 个板块键
  //   （每个 ~10.5KB）⇒ 实测 15 天攒到 13,276 行 / 132.6MB（占整个 market.db 的 80%）。
  //   现在写入端（见 cacheQuote）只保留最新一行，这里再兜一次历史遗留；文件体积不会自己缩，
  //   释放出来的页会被后续写入复用（要立刻腾出磁盘可跑 `VACUUM`，见 scripts\清理行情缓存.mjs）。
  try {
    const n = db.prepare(
      'DELETE FROM quote_cache WHERE EXISTS (' +
      '  SELECT 1 FROM quote_cache q2 WHERE q2.code = quote_cache.code AND q2.ts > quote_cache.ts)'
    ).run();
    if (n && n.changes) console.log('[stock-store] quote_cache 清理历史重复行:', n.changes, '行');
  } catch (e) { /* 清理失败不阻塞启动 */ }
  return db;
}

let mem = null, chats = null, mkt = null;

// 惰性打开 + 进程退出时关闭
function memDb()  { if (!mem)  mem  = openMemory(); return mem; }
function chatDb() { if (!chats) chats = openChats(); return chats; }
function mktDb()  { if (!mkt)  mkt  = openMarket(); return mkt; }
process.on('exit', () => { [mem, chats, mkt].forEach(d => d && d.close()); });

const now = () => new Date().toISOString();

// ================= 记忆 =================
function addMemory({ kind, title, content, tags, scenario }) {
  const db = memDb();
  const t = now();
  const sc = String(scenario || 'stock') || 'stock';
  const r = db.prepare(
    'INSERT INTO memories(scenario,kind,title,content,tags,created_at,updated_at) VALUES(?,?,?,?,?,?,?)'
  ).run(sc, kind, title, content, tags || '', t, t);
  return r.lastInsertRowid;
}

function listMemories(kind, scenario) {
  const db = memDb();
  const sc = String(scenario || 'stock') || 'stock';
  const rows = kind
    ? db.prepare('SELECT * FROM memories WHERE scenario=? AND kind=? ORDER BY id DESC').all(sc, kind)
    : db.prepare('SELECT * FROM memories WHERE scenario=? ORDER BY id DESC').all(sc);
  return rows;
}

function updateMemory(id, patch) {
  const db = memDb();
  const cur = db.prepare('SELECT * FROM memories WHERE id=?').get(id);
  if (!cur) return null;
  const merged = Object.assign({}, cur, patch, { updated_at: now() });
  db.prepare('UPDATE memories SET title=?, content=?, tags=?, kind=?, updated_at=? WHERE id=?')
    .run(merged.title, merged.content, merged.tags, merged.kind, merged.updated_at, id);
  return merged;
}

function deleteMemory(id) {
  return memDb().prepare('DELETE FROM memories WHERE id=?').run(id).changes;
}

// ================= 聊天 =================
function createSession(scenario, title) {
  const db = chatDb();
  const t = now();
  const sc = String(scenario || 'stock') || 'stock';
  const r = db.prepare('INSERT INTO sessions(scenario,title,created_at,updated_at) VALUES(?,?,?,?)')
    .run(sc, title || '新会话', t, t);
  return { id: Number(r.lastInsertRowid), scenario: sc, title: title || '新会话', created_at: t, updated_at: t };
}

function listSessions(scenario) {
  const sc = String(scenario || 'stock') || 'stock';
  return chatDb().prepare(
    'SELECT * FROM sessions WHERE scenario=? ORDER BY updated_at DESC'
  ).all(sc);
}

function getMessages(sessionId) {
  return chatDb().prepare(
    'SELECT id, role, content, created_at FROM messages WHERE session_id=? ORDER BY id'
  ).all(sessionId);
}

function addMessage(sessionId, role, content) {
  const db = chatDb();
  const t = now();
  const r = db.prepare('INSERT INTO messages(session_id,role,content,created_at) VALUES(?,?,?,?)')
    .run(sessionId, role, content, t);
  db.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run(t, sessionId);
  return { id: Number(r.lastInsertRowid), session_id: sessionId, role, content, created_at: t };
}

function deleteSession(id) {
  return chatDb().prepare('DELETE FROM sessions WHERE id=?').run(id).changes;
}

function renameSession(id, title) {
  const db = chatDb();
  db.prepare('UPDATE sessions SET title=?, updated_at=? WHERE id=?').run(title, now(), id);
  return db.prepare('SELECT * FROM sessions WHERE id=?').get(id);
}

// ================= 行情缓存 =================
function setWatch(code, name) {
  const db = mktDb();
  db.prepare('INSERT OR REPLACE INTO watchlist(code,name,added_at) VALUES(?,?,?)')
    .run(code, name, now());
  return listWatch();
}
function listWatch() {
  return mktDb().prepare('SELECT * FROM watchlist ORDER BY added_at').all();
}
function removeWatch(code) {
  return mktDb().prepare('DELETE FROM watchlist WHERE code=?').run(code).changes;
}
// ---- 持仓股 ----
function setPosition(code, name, shares, cost) {
  const db = mktDb();
  const sh = Number(shares) || 0;
  // 手工录入的持仓视为「已结算」：可用 = 持仓（否则会被 T+1 卡住不可卖）
  db.prepare('INSERT OR REPLACE INTO positions(code,name,shares,avail,cost,added_at,opened_at) VALUES(?,?,?,?,?,?,?)')
    .run(code, name, sh, sh, Number(cost) || 0, now(), now());
  return listPositions();
}
function listPositions() {
  settleT1();   // 先做 T+1 结算，保证 avail 是最新的可卖数量
  return mktDb().prepare('SELECT * FROM positions ORDER BY added_at').all();
}
function updatePosition(code, patch) {
  const db = mktDb();
  const cur = db.prepare('SELECT * FROM positions WHERE code=?').get(code);
  if (!cur) return null;
  const merged = Object.assign({}, cur, patch);
  db.prepare('UPDATE positions SET name=?, shares=?, cost=? WHERE code=?')
    .run(merged.name, Number(merged.shares) || 0, Number(merged.cost) || 0, code);
  return db.prepare('SELECT * FROM positions WHERE code=?').get(code);
}
function removePosition(code) {
  return mktDb().prepare('DELETE FROM positions WHERE code=?').run(code).changes;
}
// ================= 同花顺口径：费用 / 摊薄成本 / T+1 =================
// 默认费率：佣金万2.5（最低5元，双向）· 印花税 0.05%（仅卖出）· 过户费 0.001%（双向，沪深统一）
const FEE_DEFAULTS = { commissionRate: 0.00025, commissionMin: 5, stampRate: 0.0005, transferRate: 0.00001 };
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
function localDate() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function getConfig(key, dflt) {
  try {
    const r = mktDb().prepare('SELECT value FROM config WHERE key=?').get(key);
    return r == null ? dflt : r.value;
  } catch (e) { return dflt; }
}
function setConfig(key, value) {
  mktDb().prepare('INSERT OR REPLACE INTO config(key,value,updated_at) VALUES(?,?,?)')
    .run(key, String(value == null ? '' : value), now());
  return value;
}
// 读费率（同花顺「费率设置」对应项）
function getFeeConfig() {
  const out = {};
  Object.keys(FEE_DEFAULTS).forEach(k => {
    const v = Number(getConfig('fee.' + k, FEE_DEFAULTS[k]));
    out[k] = isFinite(v) && v >= 0 ? v : FEE_DEFAULTS[k];
  });
  return out;
}
function setFeeConfig(patch) {
  const cfg = Object.assign(getFeeConfig(), patch || {});
  Object.keys(FEE_DEFAULTS).forEach(k => {
    const v = Number(cfg[k]);
    setConfig('fee.' + k, isFinite(v) && v >= 0 ? v : FEE_DEFAULTS[k]);
  });
  return getFeeConfig();
}
// 计算一笔成交的费用（同花顺口径）
function calcFees(side, amount) {
  const cfg = getFeeConfig();
  const amt = Math.max(0, Number(amount) || 0);
  if (amt <= 0) return { commission: 0, stamp: 0, transfer: 0, total: 0 };
  const commission = r2(Math.max(amt * cfg.commissionRate, cfg.commissionMin));
  const transfer = r2(amt * cfg.transferRate);
  const stamp = side === 'sell' ? r2(amt * cfg.stampRate) : 0;
  return { commission, transfer, stamp, total: r2(commission + transfer + stamp) };
}
// T+1 结算：跨自然日把「持仓数量」全部转为「可用数量」（简化按自然日，不含节假日日历）
function settleT1() {
  const db = mktDb();
  const today = localDate();
  if (String(getConfig('trade.lastSettle', '') || '') === today) return false;
  db.prepare('UPDATE positions SET avail=shares').run();
  setConfig('trade.lastSettle', today);
  return true;
}
// ---- 交易（买入/卖出，AI 可读取 trades 表） ----
// 买入（同花顺）：摊薄成本含费；当日买入不增加可用数量（T+1）；费用从总资产扣除
function buyStock(code, name, shares, price) {
  const db = mktDb();
  const qty = Number(shares) || 0;
  const px = Number(price) || 0;
  if (qty <= 0 || px <= 0) return null;
  settleT1();
  const t = now();
  const amount = r2(qty * px);
  const fees = calcFees('buy', amount);
  const cur = db.prepare('SELECT * FROM positions WHERE code=?').get(code);
  if (cur) {
    // 摊薄成本 = (原成本×原数量 + 本次金额 + 本次费用) / 新数量
    const totalShares = Number(cur.shares) + qty;
    const newCost = (Number(cur.cost) * Number(cur.shares) + amount + fees.total) / totalShares;
    db.prepare('UPDATE positions SET name=?, shares=?, cost=? WHERE code=?')
      .run(name, totalShares, newCost, code);
  } else {
    db.prepare('INSERT INTO positions(code,name,shares,avail,cost,added_at,opened_at) VALUES(?,?,?,?,?,?,?)')
      .run(code, name, qty, 0, (amount + fees.total) / qty, t, t);
  }
  db.prepare('INSERT INTO trades(code,name,side,shares,price,amount,commission,stamp,transfer,fee,realized_pnl,source,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(code, name, 'buy', qty, px, amount, fees.commission, fees.stamp, fees.transfer, fees.total, 0, 'trade', t);
  adjustTotalAsset(-fees.total);   // 费用是真实支出 → 总资产减少
  return listPositions();
}
// 卖出（同花顺）：受 T+1 可用数量约束；摊薄成本递推；记录已实现盈亏
function sellStock(code, name, shares, price) {
  const db = mktDb();
  const qty = Number(shares) || 0;
  const px = Number(price) || 0;
  if (qty <= 0 || px <= 0) return { error: '卖出数量或价格无效' };
  settleT1();
  const cur = db.prepare('SELECT * FROM positions WHERE code=?').get(code);
  if (!cur) return { error: '未持有 ' + code + '，无法卖出' };
  const avail = Number(cur.avail) || 0;
  if (qty > avail + 1e-9) {
    return { error: 'T+1 限制：可用 ' + avail + ' 股（持仓 ' + cur.shares + ' 股，当日买入部分不可卖）' };
  }
  const t = now();
  const amount = r2(qty * px);
  const fees = calcFees('sell', amount);
  const net = amount - fees.total;                       // 净回款
  const costBasis = Number(cur.cost) || 0;
  const realized = net - costBasis * qty;                // 已实现盈亏 = 净回款 - 摊薄成本×数量
  const remaining = Number(cur.shares) - qty;
  if (remaining <= 1e-9) {
    db.prepare('DELETE FROM positions WHERE code=?').run(code);   // 清仓
  } else {
    // 摊薄成本递推 = (原成本×原数量 - 净回款) / 剩余数量（可为负）
    const newCost = (costBasis * Number(cur.shares) - net) / remaining;
    db.prepare('UPDATE positions SET shares=?, avail=?, cost=? WHERE code=?')
      .run(remaining, Math.max(0, avail - qty), newCost, code);
  }
  db.prepare('INSERT INTO trades(code,name,side,shares,price,amount,commission,stamp,transfer,fee,realized_pnl,source,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(code, cur.name || name, 'sell', qty, px, amount, fees.commission, fees.stamp, fees.transfer, fees.total, r2(realized), 'trade', t);
  adjustTotalAsset(-fees.total);
  return listPositions();
}
// 清仓：按现价卖出全部可用数量（写交易记录，不做无痕删除）
function closePosition(code, price) {
  settleT1();
  const p = mktDb().prepare('SELECT * FROM positions WHERE code=?').get(code);
  if (!p) return { error: '未持有 ' + code };
  const qty = Number(p.avail) || 0;
  if (qty <= 0) return { error: 'T+1：当前可用 0 股，无法卖出' };
  return sellStock(code, p.name, qty, Number(price) || 0);
}
function listTrades(limit) {
  return mktDb().prepare('SELECT * FROM trades ORDER BY id DESC LIMIT ?').all(Number(limit) || 100);
}
// 交易汇总（供 AI 分析）：累计已实现盈亏 / 累计费用 / 买卖金额
function tradeStats() {
  const r = mktDb().prepare(
    "SELECT COUNT(*) n, SUM(realized_pnl) realized, SUM(fee) fee," +
    " SUM(CASE WHEN side='buy' THEN amount ELSE 0 END) bought," +
    " SUM(CASE WHEN side='sell' THEN amount ELSE 0 END) sold FROM trades"
  ).get();
  return {
    count: Number(r.n) || 0,
    realized: r2(r.realized || 0),
    fee: r2(r.fee || 0),
    bought: r2(r.bought || 0),
    sold: r2(r.sold || 0)
  };
}
function cacheQuote(code, payload) {
  const db = mktDb();
  const t = now();
  // ★2026-10-15：写完立刻删掉同一 code 的旧行 —— 读取端只要"最新那一条"（latestQuote 是 ORDER BY ts DESC LIMIT 1），
  //   而主键含毫秒时间戳 ⇒ 不删就是只增不减（实测 15 天 132MB 垃圾）。这一行让 quote_cache 恒定 ≈ "有多少个 code"。
  db.prepare('INSERT OR REPLACE INTO quote_cache(code,ts,payload) VALUES(?,?,?)')
    .run(code, t, JSON.stringify(payload));
  try { db.prepare('DELETE FROM quote_cache WHERE code=? AND ts<?').run(code, t); } catch (e) { /* ignore */ }
}
// ---- K线持久缓存：按 (代码, 周期) 存最近一次，重启后直接用，不用重新拉 ----
function cacheKline(code, period, payload) {
  const db = mktDb();
  const p = period || 'day';
  db.prepare('INSERT OR REPLACE INTO kline_cache(code,period,ts,payload) VALUES(?,?,?,?)')
    .run(code, p, now(), JSON.stringify(payload));
}
function latestQuote(code) {
  const r = mktDb().prepare(
    'SELECT payload FROM quote_cache WHERE code=? ORDER BY ts DESC LIMIT 1'
  ).get(code);
  return r ? JSON.parse(r.payload) : null;
}
// 取某代码某周期的最近一次 K线缓存（返回解析后的对象或 null）
// ★2026-10-15：额外带上 `_ts`（这一行缓存的写入时间），供主进程判"是否已是最新交易日"——
//   原来只返回 payload，上层只能看"非空"⇒ 日K 一旦写过就永不回源（实测 660 行里 633 行早于当天）。
function latestKline(code, period) {
  const p = period || 'day';
  const r = mktDb().prepare(
    'SELECT payload, ts FROM kline_cache WHERE code=? AND period=? ORDER BY ts DESC LIMIT 1'
  ).get(code, p);
  if (!r) return null;
  const o = JSON.parse(r.payload);
  if (o && typeof o === 'object') o._ts = r.ts;
  return o;
}
// ---- 全市场排名缓存（选股器）：按 type(up/down) 存最近一次结果 ----//
function cacheRank(type, payload) {
  const db = mktDb();
  db.prepare('INSERT OR REPLACE INTO rank_cache(type,ts,payload) VALUES(?,?,?)')
    .run(String(type || 'down'), now(), JSON.stringify(payload));
}
// 取某方向的最近一次排名缓存（返回 { list, ts } 或 null）
// ★2026-10-15：加时效判定 —— 这张表没有 TTL，原来**一个月前的榜**也会被当缓存回放（下游只看到 fromCache 标记，
//   而"上一轮榜单"对当天信号几乎没用）。超过 12 小时视为不可用 ⇒ 返回 null，让上层去真取数。
function latestRank(type, maxAgeMs) {
  const r = mktDb().prepare(
    'SELECT payload, ts FROM rank_cache WHERE type=?'
  ).get(String(type || 'down'));
  if (!r) return null;
  const age = Date.now() - new Date(r.ts).getTime();
  const limit = Number(maxAgeMs) || 12 * 3600e3;
  if (isFinite(age) && age > limit) return null;   // 过期 ⇒ 当没有缓存
  return JSON.parse(r.payload);
}

// ---- 板块每日快照：存/取某市场某日某板块的行情概况（趋势看板历史） ----
function cacheSectorDaily(market, date, sectorId, payload) {
  const db = mktDb();
  db.prepare(
    'INSERT OR REPLACE INTO sector_daily(market,date,sector_id,ts,payload) VALUES(?,?,?,?,?)'
  ).run(String(market), String(date), String(sectorId), now(), JSON.stringify(payload));
}
// 取某市场某日所有板块快照 → { sector_id: payload, ... }（无数据返回空对象）
function getSectorDaily(market, date) {
  const rows = mktDb().prepare(
    'SELECT sector_id, payload FROM sector_daily WHERE market=? AND date=?'
  ).all(String(market), String(date));
  const out = {};
  rows.forEach(r => {
    try { out[r.sector_id] = JSON.parse(r.payload); } catch (e) { /* 坏数据跳过 */ }
  });
  return out;
}
// 取某市场某板块最近 N 天快照（按日期倒序，含今天），趋势看板画历史用
function listSectorDaily(market, sectorId, limit) {
  return mktDb().prepare(
    'SELECT date, payload FROM sector_daily WHERE market=? AND sector_id=? ORDER BY date DESC LIMIT ?'
  ).all(String(market), String(sectorId), Number(limit) || 20).map(r => {
    let p = null;
    try { p = JSON.parse(r.payload); } catch (e) { /* ignore */ }
    return { date: r.date, payload: p };
  });
}

// ================= 账户 / 总资产 =================
// 总资产为主字段（用户可编辑，如提现/入金）；现金 = 总资产 - 持仓市值（派生，由渲染层同步）
// 初始化：仅当账户不存在（或 total_asset 尚未设置）时写入初始总资产
function initCash(amount) {
  const db = mktDb();
  const cur = db.prepare('SELECT id, total_asset FROM account WHERE id=1').get();
  if (!cur) {
    db.prepare('INSERT INTO account(id,cash,total_asset,updated_at) VALUES(1,0,?,?)')
      .run(Number(amount) || 0, now());
  } else if (cur.total_asset == null) {
    // 旧账只有 cash，没有总资产：用传入值补一次总资产；cash 归 0（由渲染层派生回写）
    db.prepare('UPDATE account SET total_asset=?, cash=0, updated_at=? WHERE id=1')
      .run(Number(amount) || 0, now());
  }
  return getAccount();
}
// 读账户：返回 { cash, total_asset }（total_asset 可能为 null 表示未初始化）
function getAccount() {
  const r = mktDb().prepare('SELECT cash, total_asset FROM account WHERE id=1').get();
  if (!r) return { cash: 0, total_asset: null };
  return {
    cash: Number(r.cash) || 0,
    total_asset: r.total_asset == null ? null : Number(r.total_asset)
  };
}
// 设置总资产（渲染层会做 >= 市值 的校验；这里只存储）
function setTotalAsset(amount) {
  const db = mktDb();
  const v = Number(amount) || 0;
  if (db.prepare('SELECT id FROM account WHERE id=1').get()) {
    db.prepare('UPDATE account SET total_asset=?, updated_at=? WHERE id=1').run(v, now());
  } else {
    db.prepare('INSERT INTO account(id,cash,total_asset,updated_at) VALUES(1,0,?,?)').run(v, now());
  }
  return getAccount();
}
function getCash() {
  return getAccount().cash;
}
// 总资产增减（交易费用等真实支出），返回新总资产
function adjustTotalAsset(delta) {
  const db = mktDb();
  const a = getAccount();
  const base = a.total_asset != null ? a.total_asset : (Number(a.cash) || 0);
  const v = r2(base + (Number(delta) || 0));
  if (db.prepare('SELECT id FROM account WHERE id=1').get()) {
    db.prepare('UPDATE account SET total_asset=?, updated_at=? WHERE id=1').run(v, now());
  } else {
    db.prepare('INSERT INTO account(id,cash,total_asset,updated_at) VALUES(1,0,?,?)').run(v, now());
  }
  return v;
}
// 设置现金（买入扣款 / 卖出回款 / 手动调整），返回新现金
function setCash(amount) {
  const db = mktDb();
  const v = Number(amount) || 0;
  if (db.prepare('SELECT id FROM account WHERE id=1').get()) {
    db.prepare('UPDATE account SET cash=?, updated_at=? WHERE id=1').run(v, now());
  } else {
    db.prepare('INSERT INTO account(id,cash,updated_at) VALUES(1,?,?)').run(v, now());
  }
  return v;
}
// 现金变动（delta 可为负数），返回新现金
function adjustCash(delta) {
  const cur = getCash();
  return setCash(cur + (Number(delta) || 0));
}
// 记录资产快照（ts 唯一，重复写同秒会覆盖）
function addAssetSnapshot(snap) {
  const db = mktDb();
  const ts = snap.ts || now();
  db.prepare(
    'INSERT OR REPLACE INTO asset_snapshots(ts,cash,mkt_value,total,day_pnl,day_pct,payload) VALUES(?,?,?,?,?,?,?)'
  ).run(
    ts,
    Number(snap.cash) || 0,
    Number(snap.mkt_value) || 0,
    Number(snap.total) || 0,
    Number(snap.day_pnl) || 0,
    Number(snap.day_pct) || 0,
    snap.payload ? JSON.stringify(snap.payload) : ''
  );
  return listAssetSnapshots(1)[0] || null;
}
// 读取资产快照（按时间倒序，limit 条）
function listAssetSnapshots(limit) {
  return mktDb().prepare(
    'SELECT ts,cash,mkt_value,total,day_pnl,day_pct,payload FROM asset_snapshots ORDER BY ts DESC LIMIT ?'
  ).all(Number(limit) || 50).map(r => Object.assign({}, r, {
    payload: r.payload ? (() => { try { return JSON.parse(r.payload); } catch (e) { return null; } })() : null
  }));
}

module.exports = {
  // 记忆
  addMemory, listMemories, updateMemory, deleteMemory,
  // 聊天
  createSession, listSessions, getMessages, addMessage, deleteSession, renameSession,
  // 行情
  setWatch, listWatch, removeWatch, cacheQuote, cacheKline, latestQuote, latestKline,
  // 全市场排名缓存（选股器）
  cacheRank, latestRank,
  // 板块每日快照（趋势看板）
  cacheSectorDaily, getSectorDaily, listSectorDaily,
  // 持仓
  setPosition, listPositions, updatePosition, removePosition,
  // 交易（同花顺口径：含费用 / 摊薄成本 / T+1）
  buyStock, sellStock, closePosition, listTrades, tradeStats,
  // 费率与设置 / T+1 结算
  getFeeConfig, setFeeConfig, calcFees, settleT1, getConfig, setConfig,
  // 账户 / 总资产
  initCash, getCash, getAccount, setCash, setTotalAsset, adjustCash, adjustTotalAsset, addAssetSnapshot, listAssetSnapshots
};
