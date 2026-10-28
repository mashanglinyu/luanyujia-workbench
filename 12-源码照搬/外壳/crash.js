/**
 * 崩溃 / 异常上报 + 版本策略 —— 官方 apps/desktop 的 crash-report.ts / mandatory-update-policy.ts 能力搬迁
 * （2026-09-26 立 · 官方能力搬迁 ④）
 *
 * 与官方的差异（诚实说明）：
 *  - 官方有**上报服务器**（`crashReporter.start({ uploadToServer: true, submitURL })`）；本机没有服务端，
 *    所以这里**只落本地**：Electron 崩溃转储（dumps 目录）+ 自己记的异常流水（data\crash-log.jsonl）。
 *    以后若自建收集端，把 `submitURL` 填上、`uploadToServer` 打开即可（一行）。
 *  - 官方的强制更新策略来自服务端下发；这里先做成**本地策略文件** `data\version-policy.json`
 *    （`{ "minVersion": "1.0.0", "mandatory": false, "message": "…" }`），接口留好，将来可从 feed 拉。
 *
 * 设计原则同 updater.js：**不改现有逻辑、不弹窗打扰、全部错误吞掉**，只落盘 + 打日志。
 */
const fs = require('fs')
const path = require('path')

const DATA_DIR = path.join(__dirname, 'data')
const LOG_FILE = path.join(DATA_DIR, 'crash-log.jsonl')
const STATE_FILE = path.join(DATA_DIR, 'crash-state.json')
const POLICY_FILE = path.join(DATA_DIR, 'version-policy.json')
const MAX_LOG_BYTES = 2 * 1024 * 1024 // 超过 2MB 自动轮转一份 .old，避免无限长大

function appendLine(obj) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    try {
      if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_LOG_BYTES) {
        fs.renameSync(LOG_FILE, LOG_FILE + '.old')
      }
    } catch (e) { /* 轮转失败就继续追加 */ }
    fs.appendFileSync(LOG_FILE, JSON.stringify(Object.assign({ at: new Date().toISOString() }, obj)) + '\n', 'utf8')
  } catch (e) { /* 记不下来也不能影响运行 */ }
}

function loadPolicy() {
  const fallback = { minVersion: null, mandatory: false, message: '' }
  try {
    if (!fs.existsSync(POLICY_FILE)) return fallback
    return Object.assign(fallback, JSON.parse(fs.readFileSync(POLICY_FILE, 'utf8')))
  } catch (e) { return fallback }
}

/** 比较 a b 两个点分版本：a<b 返回 -1，相等 0，a>b 返回 1（不引依赖，自己算） */
function compareVersion(a, b) {
  const pa = String(a || '0').split('.').map((x) => parseInt(x, 10) || 0)
  const pb = String(b || '0').split('.').map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

/** 当前版本是否低于策略里的最低版本（true = 应当提示/强制更新） */
function policyVerdict(currentVersion) {
  const p = loadPolicy()
  if (!p.minVersion) return { below: false, policy: p }
  return { below: compareVersion(currentVersion, p.minVersion) < 0, policy: p }
}

function install(options) {
  const log = (options && options.log) || function (m) { console.log(m) }
  const appendLog = (options && options.appendLog) || null // 可选：同时写进工作台自己的 server.log

  const say = (m) => { log(m); if (appendLog) { try { appendLog(m) } catch (e) {} } }

  let app = null
  // 注意：纯 node 里 `require('electron')` 返回的是**二进制路径字符串**，`.app` 是 undefined ⇒ 必须双重守卫，
  // 否则离线单测/误用时模块会抛（离线测试真踩过：app.on 不存在 → 抛进 uncaughtException）。
  try { app = require('electron').app } catch (e) { app = null }
  if (!app || typeof app.getVersion !== 'function' || typeof app.on !== 'function') {
    say('[crash] 当前不在 Electron 主进程里（纯 node 环境）⇒ 只做纯函数部分，不挂事件')
    return { state: 'no-electron', compareVersionSelfTest: compareVersion('1.0.0', '1.0.1') }
  }

  const version = (() => { try { return app.getVersion() } catch (e) { return '0.0.0' } })()

  // ① Electron 崩溃转储：只落本地，不上传
  try {
    const { crashReporter } = require('electron')
    crashReporter.start({
      productName: 'DSH 引擎 GUI',
      companyName: 'local',
      submitURL: '',              // 没有服务端 ⇒ 留空
      uploadToServer: false,      // 想上报时：填 submitURL + 改 true
      compress: true,
      extra: { version: version, packaged: String(app.isPackaged === true) },
    })
    say('[crash] 崩溃转储已启用（本地，不上传）：' + (() => { try { return crashReporter.getCrashesDirectory() } catch (e) { return '未知目录' } })())
  } catch (e) {
    say('[crash] 崩溃转储启用失败（忽略）：' + (e && e.message ? e.message : String(e)))
  }

  // ② 主进程异常流水（官方 crash-report 的本地版）
  process.on('uncaughtException', (err) => {
    appendLine({ kind: 'uncaughtException', message: err && err.message, stack: err && err.stack })
    say('[crash] 主进程未捕获异常（已记录，不崩界面）：' + (err && err.message ? err.message : String(err)))
  })
  process.on('unhandledRejection', (reason) => {
    appendLine({ kind: 'unhandledRejection', message: reason && reason.message ? reason.message : String(reason), stack: reason && reason.stack })
    say('[crash] 未处理的 Promise 拒绝（已记录）：' + (reason && reason.message ? reason.message : String(reason)))
  })
  app.on('render-process-gone', (event, contents, details) => {
    appendLine({ kind: 'render-process-gone', reason: details && details.reason, exitCode: details && details.exitCode, url: (() => { try { return contents.getURL() } catch (e) { return '' } })() })
    say('[crash] 渲染进程崩溃：' + JSON.stringify(details || {}))
  })
  app.on('child-process-gone', (event, details) => {
    appendLine({ kind: 'child-process-gone', details: details })
  })

  // ③ 版本策略
  const verdict = policyVerdict(version)
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      at: new Date().toISOString(), version: version, packaged: app.isPackaged === true,
      policy: verdict.policy, belowMinVersion: verdict.below, logFile: LOG_FILE,
    }, null, 2), 'utf8')
  } catch (e) { /* 无所谓 */ }
  if (verdict.below) say('[crash] ⚠ 当前版本 ' + version + ' 低于策略最低版本 ' + verdict.policy.minVersion + '：' + (verdict.policy.message || '建议更新'))

  say('[crash] 已挂载：异常日志=' + LOG_FILE + ' 版本策略=' + (verdict.policy.minVersion || '（未设）'))
  return { state: 'mounted', version: version, policy: verdict.policy, belowMinVersion: verdict.below }
}

module.exports = {
  install: install,
  loadPolicy: loadPolicy,
  policyVerdict: policyVerdict,
  compareVersion: compareVersion,
  files: { LOG_FILE: LOG_FILE, STATE_FILE: STATE_FILE, POLICY_FILE: POLICY_FILE },
}