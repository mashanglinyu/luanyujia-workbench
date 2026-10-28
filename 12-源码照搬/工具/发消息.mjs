#!/usr/bin/env node
/**
 * 发消息.mjs —— 给另一个场景留一条消息（纯文件，不调用任何接口）
 *
 * 用法：
 *   node 工具\发消息.mjs --to 命令 "内容"
 *   node 工具\发消息.mjs --list          # 看最近的消息
 *
 * 只做两件事：
 *   1. 目标场景的 场景私有记忆.md 追加一行 ## 〇-通知
 *   2. _共享记忆\_跨场景通知.md 追加一条
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.DSH_WORKBENCH_ROOT || path.resolve(HERE, '..')
const MEM = process.env.DSH_SCENE_MEMORY || path.join(ROOT, '引擎数据', '.dsh', '场景记忆')
const BOARD = path.join(MEM, '_共享记忆', '_跨场景通知.md')

const argv = process.argv.slice(2)
const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] || '') : '' }
const to = val('--to')
const text = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--to').join(' ').trim()

if (argv.includes('--list')) {
  const t = fs.existsSync(BOARD) ? fs.readFileSync(BOARD, 'utf8').split('\n').filter(l => l.trim().startsWith('-')) : []
  console.log(t.slice(-15).join('\n') || '（还没有消息）')
  process.exit(0)
}
if (!to || !text) { console.log('用法：node 工具\\发消息.mjs --to <场景目录> "内容"'); process.exit(1) }

const ts = new Date().toISOString().slice(0, 16).replace('T', ' ')
const line = '- [' + ts + '] → ' + to + '：' + text

fs.mkdirSync(path.dirname(BOARD), { recursive: true })
if (!fs.existsSync(BOARD)) fs.writeFileSync(BOARD, '# 跨场景通知\n\n', 'utf8')
fs.appendFileSync(BOARD, line + '\n', 'utf8')

const memFile = path.join(MEM, to, '场景私有记忆.md')
if (fs.existsSync(memFile)) {
  let t = fs.readFileSync(memFile, 'utf8')
  if (!t.includes('## 〇-通知')) t += '\n## 〇-通知\n'
  t += '\n' + line + '\n'
  fs.writeFileSync(memFile, t, 'utf8')
} else {
  console.log('! 目标场景没有记忆文件：' + memFile + '（只写进了看板）')
}
console.log('✓ 已发：' + to)
