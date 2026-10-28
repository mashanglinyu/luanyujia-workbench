/**
 * 工作台自动更新 —— 官方 apps/desktop 的 electron-updater 能力搬迁（2026-09-26 立）
 * 参考源：<工作台>\引擎\apps\desktop\src\update-coordinator.ts（provider: generic + latest.yml 通道）
 *
 * 设计原则（"不许影响现有场景机制"的落地）：
 *  1) **未打包（源码直跑）时完全静默**：不检查、不下载、不弹窗，只打一行日志 ⇒ 现在的日常使用零影响。
 *  2) **默认不自动安装**（autoInstallOnAppQuit: false）⇒ 不会在你退出时悄悄替换工作台；
 *     要官方同款"退出即装"，把 data/updater-config.json 里 autoInstallOnAppQuit 设 true 即可。
 *  3) 任何网络/磁盘/签名错误都吞掉并记日志，绝不冒泡到主流程。
 *  4) 不碰 createWindow / 场景循环 / 注入逻辑；只用 main.js 末尾两行挂载。
 *
 * 会话怎么驱它（不用点界面）：
 *   node scripts\检查更新.mjs check     ⇒ 写 data\updater-command.cmd，本模块 1s 内执行
 *   node scripts\检查更新.mjs install   ⇒ 已下载则退出并安装
 *   node scripts\检查更新.mjs state     ⇒ 读 data\updater-state.json 看结果
 */
const fs = require('fs')
const path = require('path')

const DATA_DIR = path.join(__dirname, 'data')
const CONFIG_FILE = path.join(DATA_DIR, 'updater-config.json')
const CMD_FILE = path.join(DATA_DIR, 'updater-command.cmd')
const STATE_FILE = path.join(DATA_DIR, 'updater-state.json')

// 本地目录 ⇒ file:/// URL：electron-updater 拿到裸路径会报 "Invalid URL"（2026-09-26 真机实测踩到）
function toFeedRootUrl(p) {
  const s = String(p || '').trim()
  if (!s) return s
  if (/^https?:\/\//i.test(s) || s.startsWith('file://')) return s.replace(/\/+$/, '')
  return 'file:///' + s.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
}

const DEFAULTS = {
  enabled: true,
  autoDownload: true,
  autoInstallOnAppQuit: false,
  channel: 'latest',
  // generic feed 根（本地目录或 http(s)://）；实际地址 = <feedRoot>/<平台>-<架构>/
  feedRoot: '<工作台>\\项目\\更新feed',
  checkIntervalMinutes: 240,
}

function loadConfig() {
  let fromFile = {}
  try {
    if (fs.existsSync(CONFIG_FILE)) fromFile = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
  } catch (e) { /* 配置坏了就用默认值 */ }
  const cfg = Object.assign({}, DEFAULTS, fromFile)
  if (process.env.DSH_UPDATE_FEED) cfg.feedRoot = process.env.DSH_UPDATE_FEED
  // ★ 本地路径必须转 URL，否则 electron-updater 报 Invalid URL（② 真机实测）
  cfg.feedRoot = toFeedRootUrl(cfg.feedRoot)
  return cfg
}

function platformFeedUrl(cfg) {
  const sub = process.platform === 'win32' ? (process.arch === 'x64' ? 'win-x64' : 'win-arm64')
    : process.platform === 'darwin' ? (process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64') : 'linux-x64'
  return String(cfg.feedRoot).replace(/[\\/]+$/, '') + '/' + sub
}

function install(options) {
  const log = (options && options.log) || function (m) { console.log(m) }
  const cfg = loadConfig()

  const writeState = (patch) => {
    try {
      let prev = {}
      try { if (fs.existsSync(STATE_FILE)) prev = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) } catch (e) {}
      fs.writeFileSync(STATE_FILE, JSON.stringify(Object.assign(prev, patch, { at: new Date().toISOString() }), null, 2), 'utf8')
    } catch (e) { /* 状态写不出去不致命 */ }
  }

  if (!cfg.enabled) { log('[updater] 配置里已关闭（enabled:false）⇒ 不挂载'); return { state: 'disabled' } }

  // 闸门：未打包（源码直跑）时静默待命；要强测可设 DSH_UPDATER_FORCE=1
  let isPackaged = false
  try { isPackaged = require('electron').app.isPackaged === true } catch (e) {}
  if (!isPackaged && process.env.DSH_UPDATER_FORCE !== '1') {
    log('[updater] 未打包运行（源码直跑）⇒ 更新器静默待命，不做任何网络请求')
    writeState({ state: 'idle-unpackaged', feed: platformFeedUrl(cfg) })
    return { state: 'idle-unpackaged' }
  }

  let autoUpdater = null
  try { autoUpdater = require('electron-updater').autoUpdater } catch (e) {
    log('[updater] electron-updater 加载失败：' + e.message + '（不影响使用）')
    return { state: 'missing-dependency' }
  }

  const feedUrl = platformFeedUrl(cfg)
  try {
    autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl, channel: cfg.channel })
    autoUpdater.autoDownload = cfg.autoDownload === true
    autoUpdater.autoInstallOnAppQuit = cfg.autoInstallOnAppQuit === true
    if (autoUpdater.logger && typeof autoUpdater.logger === 'object') autoUpdater.logger = null
  } catch (e) {
    log('[updater] 初始化失败：' + e.message + '（不影响使用）')
    return { state: 'init-failed' }
  }

  autoUpdater.on('checking-for-update', function () { log('[updater] 正在检查更新…'); writeState({ state: 'checking', feed: feedUrl }) })
  autoUpdater.on('update-available', function (info) {
    log('[updater] 发现新版本 ' + (info && info.version) + '（autoDownload=' + autoUpdater.autoDownload + '）')
    writeState({ state: 'available', version: info && info.version, feed: feedUrl })
  })
  autoUpdater.on('update-not-available', function () { log('[updater] 已是最新版本'); writeState({ state: 'latest' }) })
  autoUpdater.on('download-progress', function (p) {
    writeState({ state: 'downloading', percent: p && Math.round(p.percent || 0) })
  })
  autoUpdater.on('update-downloaded', function (info) {
    log('[updater] 新版本 ' + (info && info.version) + ' 已下载（' + (autoUpdater.autoInstallOnAppQuit ? '退出时自动安装' : '等你确认后安装') + '）')
    writeState({ state: 'downloaded', version: info && info.version })
  })
  autoUpdater.on('error', function (e) {
    log('[updater] 检查/下载出错（已忽略，不影响使用）：' + (e && e.message ? e.message : String(e)))
    writeState({ state: 'error', message: e && e.message ? e.message : String(e) })
  })

  const checkNow = function () {
    try { return autoUpdater.checkForUpdates().catch(function (e) { log('[updater] 检查失败：' + e.message) }) }
    catch (e) { log('[updater] 检查异常：' + e.message); return null }
  }

  // 命令文件通道（会话自助驱动，同 data\reload-panels.cmd 的思路）
  setInterval(function () {
    try {
      if (!fs.existsSync(CMD_FILE)) return
      const cmd = String(fs.readFileSync(CMD_FILE, 'utf8')).trim().toLowerCase()
      fs.unlinkSync(CMD_FILE)
      if (cmd === 'check') { log('[updater] 收到命令：检查更新'); checkNow() }
      else if (cmd === 'install') {
        log('[updater] 收到命令：退出并安装')
        try { autoUpdater.quitAndInstall(false, true) } catch (e) { log('[updater] 安装失败：' + e.message) }
      } else if (cmd === 'state') {
        writeState({ state: 'reported' })
      } else { log('[updater] 未知命令：' + cmd + '（可用 check / install / state）') }
    } catch (e) { /* 命令文件忙/坏都不致命 */ }
  }, 1000)

  // 定时检查（默认 4 小时）
  const every = Math.max(5, Number(cfg.checkIntervalMinutes) || DEFAULTS.checkIntervalMinutes) * 60 * 1000
  setTimeout(checkNow, 30 * 1000)
  setInterval(checkNow, every)

  log('[updater] 已挂载：feed=' + feedUrl + ' 通道=' + cfg.channel +
      ' autoDownload=' + autoUpdater.autoDownload + ' 退出即装=' + autoUpdater.autoInstallOnAppQuit)
  writeState({ state: 'mounted', feed: feedUrl, channel: cfg.channel })
  if (/^file:\/\//i.test(String(feedUrl))) {
    // 2026-09-26 真机实测：electron-updater 的 generic provider **只认 http(s)** ——
    // 裸本地路径报 "Invalid URL"，file:// 报 "ClientRequest only supports http: and https:"，两次都踩了。
    // 本地自测请用：node scripts\更新服务.mjs（起 http feed）然后 node scripts\检查更新.mjs check。
    log('[updater] ⚠ feed 是 file:// 本地路径 ⇒ electron-updater 不支持，检查必然失败；本地自测请用 node scripts\\更新服务.mjs')
  }
  return { state: 'mounted', checkNow: checkNow, updater: autoUpdater, config: cfg }
}

module.exports = { install: install, loadConfig: loadConfig, DEFAULTS: DEFAULTS, platformFeedUrl: platformFeedUrl, files: { CONFIG_FILE: CONFIG_FILE, CMD_FILE: CMD_FILE, STATE_FILE: STATE_FILE } }