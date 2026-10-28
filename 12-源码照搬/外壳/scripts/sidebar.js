/**
 * 原生浏览器侧栏 —— 官方 apps/desktop 的 platform-view.ts / browser-guests.ts 能力搬迁（2026-09-26 立 · 官方能力搬迁 ③）
 *
 * 官方怎么做的（解剖自 <工作台>\引擎\apps\desktop\src\platform-view.ts）：
 *   new WebContentsView({webPreferences}) → owner.contentView.addChildView(view) → view.setBounds(bounds)
 *   → 销毁时 removeChildView（owner 抽象成 Pick<View,'addChildView'|'removeChildView'>）
 *
 * 本文件放在 scripts/ 而不是顶层：scripts/ 已在契约清单与备份/打包清单里 ⇒ 不新增顶层条目、无需改契约。
 *
 * ★ 红线：本模块**不碰**场景 json / sessionId / 渲染层注入 / createWindow 逻辑。
 *   它只在主窗口的 contentView 上"贴"一个原生子视图；不启用时（没 attach）对工作台零影响。
 *
 * 两种驱动方式（渲染层面板类型还没做，先用命令行通道就能验证）：
 *   1) 命令行：node scripts\浏览器侧栏.mjs open [url] | close | url <url> | bounds x,y,w,h | state
 *      ⇒ 写 data\sidebar-command.cmd，本模块 1s 内执行，状态写 data\sidebar-state.json
 *   2) IPC（留给渲染层面板类型）：browser-sidebar:attach / detach / setBounds / navigate / back / forward / state
 *
 * 安全默认：contextIsolation=true、nodeIntegration=false、独立分区 persist:dsh-browser-sidebar（不与引擎会话串 cookie）。
 */
const fs = require('fs')
const path = require('path')

const DATA_DIR = path.join(__dirname, '..', 'data')
const CMD_FILE = path.join(DATA_DIR, 'sidebar-command.cmd')
const STATE_FILE = path.join(DATA_DIR, 'sidebar-state.json')
const PARTITION = 'persist:dsh-browser-sidebar'
const DEFAULT_URL = 'https://chat.deepseek.com/'

let view = null            // WebContentsView | null（detach 后仍保留，可复用）
let isAttached = false     // ★ 视图当前是否真的挂在窗口上：别把"有视图"当成"已附着"（2026-09-26 真机踩到状态一直报 true）
let owner = null           // 附着的主窗口
let lastBounds = { x: 0, y: 0, width: 420, height: 600 }
let log = function (m) { console.log(m) }

function writeState(patch) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    let prev = {}
    try { if (fs.existsSync(STATE_FILE)) prev = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) } catch (e) {}
    const next = Object.assign(prev, patch, {
      at: new Date().toISOString(),
      attached: isAttached,
      bounds: lastBounds,
      url: view && !view.webContents.isDestroyed() ? view.webContents.getURL() : (prev.url || null),
    })
    fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2), 'utf8')
  } catch (e) { /* 状态写不出去不致命 */ }
}

function pickWindow(explicit) {
  const { BrowserWindow } = require('electron')
  if (explicit && !explicit.isDestroyed()) return explicit
  return BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())[0] || null
}

function attach(explicitWindow) {
  const { WebContentsView } = require('electron')
  const target = pickWindow(explicitWindow)
  if (!target) { log('[sidebar] 没有可用窗口，放弃附着'); return { ok: false, err: 'no-window' } }
  if (view) { // 已存在：换 owner 时先摘下来
    try { if (owner && !owner.isDestroyed()) owner.contentView.removeChildView(view) } catch (e) {}
  } else {
    view = new WebContentsView({
      webPreferences: {
        partition: PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    try {
      view.webContents.setWindowOpenHandler(function (details) {
        try { view.webContents.loadURL(details.url) } catch (e) {}
        return { action: 'deny' }   // 不开新窗口，就在侧栏里继续走
      })
    } catch (e) {}
    view.webContents.on('did-navigate', function () { writeState({ event: 'did-navigate' }) })
    view.webContents.on('did-fail-load', function (e, code, desc) { log('[sidebar] 加载失败 ' + code + ' ' + desc); writeState({ event: 'did-fail-load', code: code, desc: desc }) })
  }
  owner = target
  try {
    owner.contentView.addChildView(view)
    view.setBounds(lastBounds)
    isAttached = true
  } catch (e) { log('[sidebar] 附着失败：' + e.message); return { ok: false, err: e.message } }
  log('[sidebar] 已附着到窗口「' + (target.getTitle() || '未命名') + '」 bounds=' + JSON.stringify(lastBounds))
  writeState({ event: 'attached' })
  return { ok: true }
}

function detach() {
  try {
    if (owner && !owner.isDestroyed() && view) owner.contentView.removeChildView(view)
  } catch (e) { log('[sidebar] 摘除失败（忽略）：' + e.message) }
  isAttached = false
  log('[sidebar] 已从窗口摘除（视图保留，可再 attach）')
  writeState({ event: 'detached' })
  return { ok: true }
}

function navigate(url) {
  if (!view) attach()
  if (!view) return { ok: false, err: 'no-view' }
  try { view.webContents.loadURL(String(url || DEFAULT_URL)); log('[sidebar] 导航 → ' + url); writeState({ event: 'navigate', url: url }) ; return { ok: true } }
  catch (e) { log('[sidebar] 导航失败：' + e.message); return { ok: false, err: e.message } }
}

function setBounds(b) {
  lastBounds = { x: b.x | 0, y: b.y | 0, width: Math.max(80, b.width | 0), height: Math.max(80, b.height | 0) }
  try { if (view) view.setBounds(lastBounds) } catch (e) {}
  writeState({ event: 'bounds' })
  return { ok: true, bounds: lastBounds }
}

function install(options) {
  if (options && options.log) log = options.log
  let ipcMain = null
  try { ipcMain = require('electron').ipcMain } catch (e) { ipcMain = null }
  if (!ipcMain) { log('[sidebar] 不在 Electron 主进程里 ⇒ 不挂 IPC（纯 node 自测）'); return { state: 'no-electron' } }

  // ① IPC（留给渲染层面的"浏览器侧栏"面板类型）
  // ⚠ 必须**显式逐条**注册，不能循环 + 对象键：check-gui.mjs 的「IPC 对齐」检查是**文本扫描**
  //   `ipcMain.handle(通道名)` —— 动态注册它扫不到，会误报"preload 声明了但 main 没实现"（2026-09-26 真踩过）。
  //   ⚠ 举例时**别写出带单引号的通道名**：那条检查是纯文本正则，会把注释里的例子当成真通道，
  //     于是报「main 实现了但 preload 未暴露（可能是内部事件）：名字」这种假告警（2026-10-13 踩到并改掉）。
  try { ipcMain.handle('browser-sidebar:attach', () => attach()) } catch (e) { log('[sidebar] IPC 注册失败 attach：' + e.message) }
  try { ipcMain.handle('browser-sidebar:detach', () => detach()) } catch (e) { log('[sidebar] IPC 注册失败 detach：' + e.message) }
  try { ipcMain.handle('browser-sidebar:setBounds', (e, b) => setBounds(b || {})) } catch (e) { log('[sidebar] IPC 注册失败 setBounds：' + e.message) }
  try { ipcMain.handle('browser-sidebar:navigate', (e, url) => navigate(url)) } catch (e) { log('[sidebar] IPC 注册失败 navigate：' + e.message) }
  try { ipcMain.handle('browser-sidebar:back', () => { try { if (view) view.webContents.navigationHistory.goBack() } catch (e2) {} ; return { ok: true } }) } catch (e) { log('[sidebar] IPC 注册失败 back：' + e.message) }
  try { ipcMain.handle('browser-sidebar:forward', () => { try { if (view) view.webContents.navigationHistory.goForward() } catch (e2) {} ; return { ok: true } }) } catch (e) { log('[sidebar] IPC 注册失败 forward：' + e.message) }
  try { ipcMain.handle('browser-sidebar:state', () => ({ attached: isAttached, bounds: lastBounds, url: view && !view.webContents.isDestroyed() ? view.webContents.getURL() : null })) } catch (e) { log('[sidebar] IPC 注册失败 state：' + e.message) }
  log('[sidebar] IPC 已注册 7 条（browser-sidebar:*）')

  // ② 命令行通道（现在就能验证；渲染层面板类型以后再接）
  setInterval(function () {
    try {
      if (!fs.existsSync(CMD_FILE)) return
      const raw = String(fs.readFileSync(CMD_FILE, 'utf8')).trim()
      fs.unlinkSync(CMD_FILE)
      const sp = raw.indexOf(' ')
      const cmd = (sp < 0 ? raw : raw.slice(0, sp)).toLowerCase()
      const arg = sp < 0 ? '' : raw.slice(sp + 1).trim()
      if (cmd === 'open') { attach(); navigate(arg || DEFAULT_URL) }
      else if (cmd === 'close') { detach() }
      else if (cmd === 'url') { navigate(arg) }
      else if (cmd === 'bounds') {
        const n = arg.split(',').map((x) => parseInt(x, 10))
        if (n.length === 4 && n.every((x) => !isNaN(x))) setBounds({ x: n[0], y: n[1], width: n[2], height: n[3] })
        else log('[sidebar] bounds 参数要 4 个整数：x,y,w,h')
      } else if (cmd === 'state') { writeState({ event: 'reported' }) }
      else log('[sidebar] 未知命令：' + cmd + '（可用 open/close/url/bounds/state）')
    } catch (e) { /* 命令文件忙/坏都不致命 */ }
  }, 1000)

  writeState({ event: 'installed' })
  log('[sidebar] 已就绪：命令文件 ' + CMD_FILE + '（未 attach 时对工作台零影响）')
  return { state: 'mounted', api: { attach: attach, detach: detach, navigate: navigate, setBounds: setBounds } }
}

module.exports = { install: install, attach: attach, detach: detach, navigate: navigate, setBounds: setBounds, DEFAULT_URL: DEFAULT_URL, files: { CMD_FILE: CMD_FILE, STATE_FILE: STATE_FILE } }