/**
 * 版本策略 / 强制更新 —— 官方 apps/desktop 的 mandatory-update-policy.ts + mandatory-update-window.ts 能力搬迁（2026-09-26 立 · ④ 的另一半）
 *
 * 官方语义（只读解剖自 apps\desktop\src）：策略独立于更新产物；命中后用 **shell 自有的模态窗**告知，
 * 动作有 refresh / download / install / later / page。官方策略来自远端 origin + 鉴权 —— 对本地工作台无意义，
 * 这里按**语义对齐**做本地版：策略来自 data\version-policy.json（可选 feed 里的 policy.json），界面用内联 HTML 模态窗（零构建）。
 *
 * ★ 与官方的一处**安全性偏离（刻意的）**：官方命中即阻塞。你的红线是"不能影响现有场景机制"，
 *   所以我默认 **soft**（模态提示 + 「稍后」，不锁工作台）；只有策略显式写 `hardBlock: true` 才不可关闭。
 *   理由写在代码里，也写进计划文档，免得以后有人以为是漏做。
 */
const fs = require('fs')
const path = require('path')

const DATA_DIR = path.join(__dirname, '..', 'data')
const POLICY_FILE = path.join(DATA_DIR, 'version-policy.json')   // 本地策略（优先级最高）
const STATE_FILE = path.join(DATA_DIR, 'version-policy-state.json')
const PRELOAD = path.join(__dirname, '强制更新-preload.js')
const CHECK_INTERVAL_MS = 30 * 60 * 1000

let log = function (m) { console.log(m) }
let noticeWin = null
let checkNow = null          // 由 main.js 传入：updater 的 checkNow（「立即检查更新」按钮用）
let lastVerdict = null

// ---------- 版本比较（与 crash.js 同规则：段数不等时短的补 0；预发布后缀按字符串比）----------
function compareVersion(a, b) {
  const pa = String(a || '0').split('.'), pb = String(b || '0').split('.')
  const n = Math.max(pa.length, pb.length)
  for (let i = 0; i < n; i++) {
    const x = parseInt(pa[i] || '0', 10), y = parseInt(pb[i] || '0', 10)
    if (isNaN(x) || isNaN(y)) { const s = String(pa[i] || '').localeCompare(String(pb[i] || '')); if (s) return s < 0 ? -1 : 1; continue }
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

function loadPolicy() {
  let p = {}
  try { if (fs.existsSync(POLICY_FILE)) p = JSON.parse(fs.readFileSync(POLICY_FILE, 'utf8').replace(/^\uFEFF/, '')) } catch (e) { log('[强制更新] 本地策略读不了（忽略）：' + e.message) }
  return {
    minVersion: p.minVersion || p.minimumVersion || null,
    mandatory: p.mandatory === true,
    hardBlock: p.hardBlock === true,
    title: p.title || '需要更新到新版本',
    detail: p.detail || '',
    page: p.page || '',
    deadline: p.deadline || null,
  }
}

function writeState(patch) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    let prev = {}
    try { if (fs.existsSync(STATE_FILE)) prev = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) } catch (e) {}
    fs.writeFileSync(STATE_FILE, JSON.stringify(Object.assign(prev, patch, { at: new Date().toISOString() }), null, 2), 'utf8')
  } catch (e) { /* 状态写不出去不致命 */ }
}

/** 判定：当前版本是否被策略拦下 */
function verdict(currentVersion) {
  const pol = loadPolicy()
  const hit = !!(pol.minVersion && compareVersion(currentVersion, pol.minVersion) < 0)
  const v = { current: currentVersion, policy: pol, blocking: hit && pol.mandatory, hardBlock: hit && pol.mandatory && pol.hardBlock, at: new Date().toISOString() }
  lastVerdict = v
  return v
}

function noticeHtml(v) {
  const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  const laterBtn = v.hardBlock ? '' : '<button id="later">稍后提醒</button>'
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>' + esc(v.policy.title) + '</title><style>'
    + 'body{margin:0;padding:26px 28px;background:#1b1d21;color:#e8e8ea;font:14px/1.7 "Microsoft YaHei",system-ui;user-select:none}'
    + 'h1{font-size:17px;margin:0 0 12px}p{margin:6px 0;color:#b8bcc4}code{color:#7fd1a8}'
    + '.ver{color:#f0c674;font-weight:600}.btns{margin-top:22px;display:flex;gap:10px}'
    + 'button{font:inherit;padding:8px 16px;border-radius:8px;border:1px solid #3a3f47;background:#2a2e35;color:#e8e8ea;cursor:pointer}'
    + 'button:hover{background:#343943}#now{background:#2d6cdf;border-color:#2d6cdf}'
    + '</style></head><body><h1>' + esc(v.policy.title) + '</h1>'
    + '<p>当前版本 <span class="ver">' + esc(v.current) + '</span>，要求至少 <span class="ver">' + esc(v.policy.minVersion) + '</span></p>'
    + (v.policy.detail ? '<p>' + esc(v.policy.detail) + '</p>' : '')
    + (v.policy.deadline ? '<p>截止：<code>' + esc(v.policy.deadline) + '</code></p>' : '')
    + '<div class="btns"><button id="now">立即检查更新</button>'
    + (v.policy.page ? '<button id="page">打开说明页</button>' : '') + laterBtn + '</div>'
    + '<script>'
    + 'document.getElementById("now").onclick=function(){dshPolicy.act("now")};'
    + 'var l=document.getElementById("later");if(l)l.onclick=function(){dshPolicy.act("later")};'
    + 'var p=document.getElementById("page");if(p)p.onclick=function(){dshPolicy.act("page")};'
    + '</script></body></html>'
}

/** 弹模态提示（官方是 shell 自有模态窗；这里是内联 HTML + 微型 preload，零构建） */
function showNotice(v) {
  let BrowserWindow = null
  try { BrowserWindow = require('electron').BrowserWindow } catch (e) { return { ok: false, err: 'no-electron' } }
  // ready 守卫（双保险）：没 ready 就等 ready 再弹，绝不抛（真机踩过一次）
  try {
    const a = require('electron').app
    if (a && typeof a.isReady === 'function' && !a.isReady() && typeof a.whenReady === 'function') {
      a.whenReady().then(function () { try { showNotice(v) } catch (e) {} })
      return { ok: true, deferred: true }
    }
  } catch (e) {}
  if (noticeWin && !noticeWin.isDestroyed()) { noticeWin.focus(); return { ok: true, reused: true } }
  const parent = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())[0] || undefined
  noticeWin = new BrowserWindow({
    width: 520, height: v.policy.detail ? 300 : 260,
    parent: parent, modal: false, resizable: false, minimizable: false, maximizable: false,
    title: v.policy.title, autoHideMenuBar: true, alwaysOnTop: v.hardBlock !== true ? false : true,
    closable: v.hardBlock !== true,      // 只有 hardBlock 才不允许关（默认 soft：能关，不锁工作台）
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
  })
  noticeWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(noticeHtml(v)))
  noticeWin.on('closed', function () { noticeWin = null })
  log('[强制更新] 已弹出版本策略提示窗（' + (v.hardBlock ? '硬拦 hardBlock' : '软提示，可稍后') + '）')
  return { ok: true }
}

function closeNotice() {
  try { if (noticeWin && !noticeWin.isDestroyed()) noticeWin.close() } catch (e) {}
  noticeWin = null
}

/** 跑一次判定：命中就弹窗 + 记状态 */
function evaluate(currentVersion, opts) {
  const v = verdict(currentVersion)
  writeState({ state: v.blocking ? 'blocking' : 'ok', verdict: { current: v.current, minVersion: v.policy.minVersion, mandatory: v.policy.mandatory, hardBlock: v.hardBlock } })
  if (v.blocking) {
    log('[强制更新] 命中策略：本机 ' + v.current + ' < 要求 ' + v.policy.minVersion + '（mandatory=' + v.policy.mandatory + '）')
    if (!(opts && opts.silent)) showNotice(v)
  }
  return v
}

function install(options) {
  const o = options || {}
  if (o.log) log = o.log
  if (typeof o.checkNow === 'function') checkNow = o.checkNow
  let app = null
  try { app = require('electron').app } catch (e) { app = null }
  if (!app || typeof app.getVersion !== 'function') { log('[强制更新] 不在 Electron 主进程里 ⇒ 只做纯函数');
    return { state: 'no-electron', selfTest: { verdict: verdict('1.0.0') } } }

  // 「立即检查更新」/「稍后」按钮的 IPC（渲染层在 data: 页面里，走微型 preload）
  try {
    const ipcMain = require('electron').ipcMain
    ipcMain.on('mandatory-update:action', function (e, action) {
      log('[强制更新] 用户动作：' + action)
      if (action === 'now') { try { if (checkNow) checkNow() } catch (err) { log('[强制更新] 触发检查失败：' + err.message) } ; closeNotice() }
      else if (action === 'later') { writeState({ state: 'deferred' }); closeNotice() }
      else if (action === 'page') { const p = (lastVerdict && lastVerdict.policy.page) || ''; if (p) { try { require('electron').shell.openExternal(p) } catch (err) {} } }
    })
  } catch (e) { log('[强制更新] IPC 注册失败（忽略）：' + e.message) }

  const cur = app.getVersion()
  // ⚠ 必须等 app ready 再判定/弹窗：main.js 的挂载点在 whenReady 之前，
  //   直接建窗会抛 "Cannot create BrowserWindow before app is ready"（2026-09-26 真机实测踩到）。
  let first = null
  const runFirst = function () { try { first = evaluate(app.getVersion()) } catch (e) { log('[强制更新] 首次判定失败（忽略）：' + e.message) } }
  if (typeof app.isReady === 'function' && app.isReady()) runFirst()
  else if (typeof app.whenReady === 'function') app.whenReady().then(runFirst)
  const timer = setInterval(function () { try { evaluate(app.getVersion()) } catch (e) {} }, CHECK_INTERVAL_MS)
  if (timer && timer.unref) timer.unref()
  log('[强制更新] 已挂载：本机 ' + cur + '，策略下限=' + ((first && first.policy.minVersion) || '（未设）') + (first && first.blocking ? ' ⇒ 已拦下' : ' ⇒ 放行/待判定'))
  return { state: 'mounted', verdict: first, evaluate: evaluate, showNotice: showNotice, closeNotice: closeNotice, compareVersion: compareVersion }
}

module.exports = { install: install, loadPolicy: loadPolicy, verdict: verdict, compareVersion: compareVersion, evaluate: evaluate, showNotice: showNotice, closeNotice: closeNotice, files: { POLICY_FILE: POLICY_FILE, STATE_FILE: STATE_FILE } }