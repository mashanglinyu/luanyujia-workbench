#!/usr/bin/env node
/**
 * 刷新面板 —— 外部刷新通道的投递端（2026-09-26 立）
 *
 * 为什么存在：工作台是「零构建 + 单文件渲染器 + ⟳ 热更」，改完 renderer\*.js 需要面板重载才生效；
 * 以前只能人手点 ⟳，AI 会话改完没法自己让它生效。现在会话跑这个脚本就能自助刷新并展示效果。
 *
 * 用法：
 *   node scripts\刷新面板.mjs              # 刷新全部面板（等价 all）
 *   node scripts\刷新面板.mjs all
 *   node scripts\刷新面板.mjs dsh-gui      # 只刷新 URL 里含该场景 id 的面板
 *
 * 原理：写 data\reload-panels.cmd；工作台主进程每 500ms 轮询该文件，读到就重载匹配的 webview 并删掉它。
 * ⚠ 前提：工作台主进程已加载该通道（main.js 2026-09-26 及以后的版本）。GUI 没重启过就还读不到
 *   ⇒ 会看到「界面没变化」，此时重启一次 GUI 即长期有效（之后 renderer 改动都不用再重启、也不用你点 ⟳）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const guiDir = path.resolve(here, '..')
const cmdFile = path.join(guiDir, 'data', 'reload-panels.cmd')
const target = (process.argv[2] ?? 'all').trim() || 'all'

fs.mkdirSync(path.dirname(cmdFile), { recursive: true })
try { fs.rmSync(cmdFile, { force: true }) } catch { /* 删不掉不影响投递 */ }
fs.writeFileSync(cmdFile, target, 'utf8')

console.log(`已投递刷新命令「${target}」→ ${cmdFile}`)
console.log('工作台主进程 500ms 内执行（面板自刷新，无需手点 ⟳）。')
console.log('若 5 秒后界面无变化 ⇒ 主进程还没加载这条通道，重启一次 GUI 即长期有效。')