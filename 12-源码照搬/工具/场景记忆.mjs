#!/usr/bin/env node
/**
 * 场景记忆 v2 · 统一工具（2026-10-27 核心机制；例外场景清单＝工具同目录 `场景记忆-例外.json`）
 *
 * 每个场景的记忆文件夹固定四类：
 *   <场景>\
 *     场景私有记忆.md   ← 人写（交接 §〇 四小节 / 职责 / 决策 / 项目索引）
 *     身份卡.md         ← 工具写（身份/权限/定位卡指纹）⛔ 手改即校验失败
 *     场景画像.md       ← 工具写（布局/面板/渲染器/依赖）
 *     项目记忆\ + 归档\ + _文件索引.md
 *
 * 用法：
 *   node 场景记忆.mjs list                       # 一览：三文档/归档/项目记忆 缺什么
 *   node 场景记忆.mjs init    --场景 刷抖音       # 建目录骨架 + 三文档（已存在不覆盖）
 *   node 场景记忆.mjs stamp   --场景 刷抖音       # 重生成 身份卡 + 场景画像
 *   node 场景记忆.mjs 交接    --场景 刷抖音       # 归档旧版 + 补 §〇 四小节 + stamp + 登记索引
 *   node 场景记忆.mjs check   --场景 刷抖音       # 结构/指纹/§〇/项目/归档 全检（--all 全场景）
 *
 * --场景 可传目录名（刷抖音）或场景 id（douyin）。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'

// 公开模板：根 = --root 参数 > 脚本所在目录的上一级；记忆在 <根>\引擎数据\.dsh\场景记忆
import { fileURLToPath as __f2u } from 'node:url'
const __HERE = path.dirname(__f2u(import.meta.url))
const __ARGV_ROOT = (() => { const i = process.argv.indexOf('--root'); return i >= 0 ? process.argv[i + 1] : '' })()
const WORKBENCH_ROOT = __ARGV_ROOT || process.env.DSH_WORKBENCH_ROOT || path.resolve(__HERE, '..')
const MEMROOT = process.env.DSH_SCENE_MEMORY || path.join(WORKBENCH_ROOT, '引擎数据', '.dsh', '场景记忆')
// 公开模板：不写审计日志
function audit() {}
const GUI = process.env.DSH_GUI_DIR || path.join(WORKBENCH_ROOT, '外壳')
const SCEN = path.join(GUI, 'scenarios')
const IDX = path.join(SCEN, '_场景身份索引.md')
const NOW = () => new Date()
const stamp = () => { const d = NOW(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}` }; // 本地时间（原来是 UTC）
const sha = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : '')

const ALIAS = {
  'bilibili': 'B站', 'pc-cleanup': '本地电脑', 'personal-site': '<个人站场景>',
  'stock-analysis': '<机主>的分析助手', 'code-dev': '程序开发', 'design-misc': '设计杂活',
  'video-workflow': '视频工作流', 'self-review': '自我复盘', 'douyin': '刷抖音', 'command': '命令',
  'workbench-custom': '工作台定制', 'dsh-gui': null,
}

/* ------------------------------------------------------------ 读两个事实源 */

function readScenes() {
  const out = []
  for (const f of fs.existsSync(SCEN) ? fs.readdirSync(SCEN) : []) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue
    try {
      const j = JSON.parse(fs.readFileSync(path.join(SCEN, f), 'utf8'))
      if (j && j.id && Array.isArray(j.panels)) out.push(j)
    } catch { /* 跳过坏 json */ }
  }
  return out
}

/** 解析 `_场景身份索引.md` §二 表：场景id → {panel,title,session,sessionId,card,skill} */
function readIdentity() {
  const map = new Map()
  if (!fs.existsSync(IDX)) return map
  for (const line of fs.readFileSync(IDX, 'utf8').split(/\r?\n/)) {
    const t = line.trim()
    if (!t.startsWith('|')) continue
    const c = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((s) => s.trim().replace(/`/g, ''))
    if (c.length < 7) continue
    const id = c[0]
    if (!/^[a-z0-9-]+$/.test(id)) continue
    const cardRel = (c[5] || '').replace(/^scenarios\\/, '')
    map.set(id, {
      id, panel: c[1], title: c[2], session: c[3], sessionId: c[4],
      card: cardRel ? path.join(SCEN, cardRel) : '',
      skill: c[6] || '',
    })
  }
  return map
}

/** 目录名 ↔ 场景 json */
function findSceneDir(arg) {
  const dirs = fs.existsSync(MEMROOT) ? fs.readdirSync(MEMROOT, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('_')).map((e) => e.name) : []
  if (dirs.includes(arg)) return arg
  const alias = ALIAS[arg]
  if (alias && dirs.includes(alias)) return alias
  const scenes = readScenes()
  const byId = scenes.find((s) => s.id === arg)
  if (byId && dirs.includes(byId.name)) return byId.name
  return null
}

function sceneOf(dirName) {
  const scenes = readScenes()
  const SUB = { '视频全工作流': 'video-workflow' }   // 画布子项：无独立 json，用父场景 json
  return scenes.find((s) => s.name === dirName)
    || scenes.find((s) => s.id === dirName)
    || scenes.find((s) => (s.name || '').toLowerCase() === String(dirName).toLowerCase())
    || (SUB[dirName] ? scenes.find((s) => s.id === SUB[dirName]) : null)
    || null
}

/* ----------------------------------------------------- 记忆 v2 例外（集中清单） */
// 2026-10-27（命令台 cmd-chat 报）：例外场景没有 `引擎\场景记忆\<场景>\` ⇒ 以前 check 直接 ENOENT 抛错，
// 收工闸形同虚设。现在例外清单**只有一份**：工具同目录的 `场景记忆-例外.json`（别在代码里散落）。
const TOOL_DIR = path.dirname(path.resolve(process.argv[1] || '<工作台>\\工具\\场景记忆.mjs'))
const EXCEPTION_FILE = path.join(TOOL_DIR, '场景记忆-例外.json')
let _exceptions = null
function readExceptions() {
  if (_exceptions) return _exceptions
  const map = new Map()
  try {
    const j = JSON.parse(fs.readFileSync(EXCEPTION_FILE, 'utf8'))
    for (const [id, ex] of Object.entries((j && j.scenes) || {})) map.set(String(id), { id, ...ex })
  } catch (e) {
    if (fs.existsSync(EXCEPTION_FILE)) console.error('⚠ 例外清单读不动（' + EXCEPTION_FILE + '）：' + e.message + ' ⇒ 按"没有例外"处理')
  }
  _exceptions = map
  return map
}
/** arg 可以是场景 id / 目录名 / 面板 id / 场景标题 / 别名；命中返回例外条目。 */
function exceptionOf(arg) {
  if (!arg) return null
  const a = String(arg).trim()
  return [...readExceptions().values()].find((ex) =>
    ex.id === a || (ex.panels || []).includes(a) || ex.title === a || (ex.aliasNames || []).includes(a)) || null
}
/** §〇 字节数（与 cmdCheck 同口径：从 §〇 标题到下一个同级标题）。 */
function sec0Bytes(txt) {
  const h = txt.search(/^## (?:§〇|〇、|§0)/m)
  if (h < 0) return -1
  const rest = txt.slice(h)
  const next = rest.indexOf('\n## ', 5)
  return Buffer.byteLength(next >= 0 ? rest.slice(0, next) : rest)
}
/** 例外场景的 check：不按三文档校验，只验它声明的记忆根 + 定位卡。 */
function cmdCheckException(arg, ex) {
  if (ex.handler === 'oa') return cmdCheckOa()
  const problems = []
  const ok = []
  for (const r of ex.roots || []) {
    const p = r.path
    if (!fs.existsSync(p)) { problems.push('缺' + (r.kind === 'dir' ? '目录' : '文件') + ' ' + r.label + '：' + p); continue }
    if (r.kind === 'dir') { ok.push(r.label + '：' + p); continue }
    const b = sec0Bytes(fs.readFileSync(p, 'utf8'))
    if (b < 0) problems.push(r.label + ' 里没有 §〇 段：' + p)
    else if (b > 4096) problems.push(r.label + ' §〇 超 4 KB（' + b + ' B）：' + p)
    else ok.push(r.label + '：§〇 ' + b + ' B')
  }
  const card = ex.card ? path.join(GUI, ex.card) : ''
  if (card) { if (fs.existsSync(card)) ok.push('定位卡在（' + ex.card + '）'); else problems.push('缺定位卡：' + card) }
  console.log(`\n${ex.title || arg}（${ex.id}）：${problems.length ? '✗' : '✓'} 例外 —— 记忆在下面这些位置，跳过 v2 三文档校验`)
  for (const s of ok) console.log('  ✓ ' + s)
  for (const s of problems) console.log('  ✗ ' + s)
  if (ex.why) console.log('  · 依据：' + ex.why)
  console.log('  · 例外清单：' + EXCEPTION_FILE + '（改口径要宿主确认）')
  return problems.length ? 1 : 0
}

/* ---------------------------------------------------------------- 文档生成 */

function bindingBlock(id, ident, dirName, sceneJson) {
  const card = ident && ident.card ? ident.card : ''
  const fp = card ? sha(card) : ''
  const panels = (sceneJson?.panels || []).map((p) => `${p.id}:${p.type}${p.url ? '=' + p.url : p.sessionId ? '(会话)' : ''}`).join(' ｜ ')
  return `<!-- 场景绑定 BEGIN · 由 场景记忆.mjs 生成，⛔ 手改即校验失败 -->
> **场景** \`${id}\` ｜ **面板** \`${ident?.panel || '?'}\` ｜ **会话** \`${ident?.sessionId || '?'}\`
> **定位卡** \`${card ? path.relative('<工作台>', card) : '(缺)'}\` ｜ **卡指纹** \`sha256:${fp ? fp.slice(0, 16) : '(缺)'}…\` ｜ **盖章** ${stamp()}
> **地盘** \`${dirName}\`
> **权限** 只写自己的记忆文件夹与本人资产；⛔ 不改别的场景、不重启引擎、不关 GUI
> **专属技能** ${ident?.skill || '(无)'}
> **面板** ${panels || '(场景 json 里没有 panels)'}
<!-- 场景绑定 END -->`
}

function writeIdentityCard(dir, id, ident, sceneJson) {
  const name = dir
  const txt = `# ${name} · 身份卡（工具生成 · ⛔ 手改即校验失败）

${bindingBlock(id, ident, dir, sceneJson)}

## 怎么用
- 开场第一份读的是**这张卡**：我是谁、在哪个面板、会话是哪条、定位卡是哪张、能碰什么。
- 定位卡或场景 json 改了 ⇒ 立刻跑 \`node <工作台>\\工具\\场景记忆.mjs stamp --场景 ${name}\`，否则 \`场景记忆.mjs check\` 会报指纹过期。
- 本文件由工具全量重写；要补充说明请写进 \`场景私有记忆.md\`，别写这里。
`
  fs.writeFileSync(path.join(dir, '身份卡.md'), txt, 'utf8')
  return txt
}

function writePortrait(dir, id, sceneJson, ident) {
  const p = sceneJson || {}
  const rows = (p.panels || []).map((x) => `| \`${x.id}\` | ${x.title || ''} | \`${x.type}\` | ${x.url ? `\`${x.url}\`` : x.sessionId ? '会话' : ''} | ${x.col ?? ''},${x.row ?? ''} | ${x.w ?? ''}×${x.h ?? ''} |`).join('\n')
  const txt = `# ${dir} · 场景画像（工具生成 · 由场景 json 推导）

> 来源：\`scenarios\\${id}.json\` + \`renderers.js\` + 定位卡 ｜ 生成 ${stamp()}
> 一句话：${p.description || '(json 没写 description)'}

## 一、形态
- 布局 \`${p.layout || '?'}\` ｜ 主题 \`${p.theme || '?'}\` ｜ 列数 ${p.cols ?? '?'}
- 面板数：${(p.panels || []).length}

## 二、面板
| 面板 id | 标题 | 类型 | 内容 | 位置(col,row) | 尺寸 |
|---|---|---|---|---|---|
${rows || '| — | — | — | — | — | — |'}

## 三、运行时
- 绑定会话：\`${ident?.sessionId || '(见身份卡)'}\`
- 钉定：${(p.panels || []).flatMap((x) => x.pinTarget || []).join(' / ') || '(无)'}
- 渲染器：${[...new Set((p.panels || []).map((x) => x.type))].join(' / ') || '(无)'}

## 四、依赖与入口
- 定位卡：${ident?.card ? '`' + path.relative('<工作台>', ident.card) + '`' : '(缺)'}
- 专属技能：${ident?.skill || '(无)'}
- 记忆文件夹：\`${dir}\`

> 本文件由工具推导生成；场景 json 改了就 \`stamp\`。
`
  fs.writeFileSync(path.join(dir, '场景画像.md'), txt, 'utf8')
  return txt
}

const SEC0 = `## §〇 当前交接（≤4 KB，新会话先读这一节）

### 1) 上次交接
- （交接时由工具写入：旧版已归档 \`归档\\<文件名>\`）

### 2) 当前项目
| 项目 | 记忆文件 | 状态 | 下一步 |
|---|---|---|---|
| （暂无） | — | — | — |

### 3) 私有记忆变更
- （本轮改了什么，≤3 行）

### 4) 下一步 / 卡点
- （写给下一任）

`

function ensureSkeleton(dir, name) {
  const main = path.join(dir, '场景私有记忆.md')
  const legacyPrefixed = path.join(dir, name + '场景私有记忆.md')
  const legacyPlain = path.join(dir, '项目信息.md')
  const arch = path.join(dir, '归档')
  fs.mkdirSync(arch, { recursive: true })
  // 收敛内容源（最新修改者为准）；多个名字内容不同 ⇒ 副本进 归档\冲突副本-*，⛔ 绝不直接删正文
  const sizeOf = (p) => { try { return fs.statSync(p).size } catch { return 0 } }
  const cand = [main, legacyPlain, legacyPrefixed].filter((p) => { try { return fs.statSync(p).isFile() } catch { return false } })
  // ★ 安全收敛（2026-10-27 事故后加固）：
  //   1) 正本存在且 >200B ⇒ 绝不被别的名字覆盖（哪怕它 mtime 更新、哪怕是 0 字节）
  //   2) 正本缺失/空 ⇒ 从候选里选“最大且非空”的恢复
  //   3) 冲突副本只归档内容确实不同的非空文件
  if (sizeOf(main) <= 200) {
    const best = cand.filter((p) => sizeOf(p) > 200).sort((a, b) => sizeOf(b) - sizeOf(a))[0]
    if (best && best !== main) fs.copyFileSync(best, main)
  }
  for (const p of cand) {
    if (p === main) continue
    try {
      if (sizeOf(p) > 200 && sha(p) !== sha(main)) {
        const tag = path.basename(p).replace(/\.md$/, '')
        const bak = path.join(arch, `冲突副本-${tag}-${NOW().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.md`)
        fs.copyFileSync(p, bak)
      }
    } catch {}
  }
  // ★ 2026-10-27：`项目信息.md` 已淘汰 —— 正文并入 main 后删除，**不再重建**（旧前缀名暂留兼容）
  try { if (fs.existsSync(legacyPlain)) fs.rmSync(legacyPlain, { force: true }) } catch {}
  // 旧前缀名留硬链接（各场景技能/文档还引用它）
  try {
    if (fs.existsSync(legacyPrefixed) && sha(legacyPrefixed) !== sha(main)) fs.rmSync(legacyPrefixed, { force: true })
    if (!fs.existsSync(legacyPrefixed) && fs.existsSync(main)) fs.linkSync(main, legacyPrefixed)
  } catch {}
  if (!fs.existsSync(main)) {
    fs.writeFileSync(main, `# ${name} · 场景私有记忆

> 身份与形态见 \`身份卡.md\` / \`场景画像.md\`（工具生成，⛔ 手改）
> 规矩：这份记忆只有本场景能改写；别的场景发现错误只能提醒。

${SEC0}## §一 我管什么 / 不管什么

- 管：
- 不管：

## §二 干活入口

- 项目记忆：\`项目记忆\\<项目名>.md\`（当前项目索引表放上面 §〇 第 2 小节）
- 归档：\`归档\\\`
- 索引：\`_文件索引.md\`

## §五 决策与坑（只追加）
`, 'utf8')
  }
  fs.mkdirSync(path.join(dir, '项目记忆'), { recursive: true })
  fs.mkdirSync(path.join(dir, '归档'), { recursive: true })
  const fidx = path.join(dir, '_文件索引.md')
  if (!fs.existsSync(fidx)) {
    fs.writeFileSync(fidx, `# ${name} · 文件索引

> 状态四态：\`活 / 常备 / 留档 / 待清\`

| 文件 / 目录 | 是什么 | 状态 | 复核日期 |
|---|---|---|---|
| \`场景私有记忆.md\` | 场景私有记忆（人写：交接/职责/决策/项目索引） | 活 | ${NOW().toISOString().slice(0, 10)} |
| \`身份卡.md\` | 身份卡（工具生成：身份/权限/定位卡指纹） | 活 | ${NOW().toISOString().slice(0, 10)} |
| \`场景画像.md\` | 场景画像（工具生成：布局/面板/渲染器） | 活 | ${NOW().toISOString().slice(0, 10)} |
| \`项目记忆\\\` | 每个项目一份记忆 | 活 | ${NOW().toISOString().slice(0, 10)} |
| \`归档\\\` | 旧版本快照（只进不改） | 留档 | ${NOW().toISOString().slice(0, 10)} |
`, 'utf8')
  }
}

/* ------------------------------------------------------------------ 命令 */

function cmdStamp(name) {
  const dir = path.join(MEMROOT, name)
  if (!fs.existsSync(dir)) {
    const ex = exceptionOf(name)
    if (ex) {
      console.log(`\n${ex.title || name}（${ex.id}）：例外场景，没有三文档可盖（记忆在 ${(ex.roots || []).map((r) => r.path).join(' / ')}）⇒ stamp 跳过，改定位卡也不用重盖`)
      return 0
    }
  }
  const scene = sceneOf(name)
  const ident = scene ? readIdentity().get(scene.id) : null
  if (!scene) { console.error(`✗ 找不到场景 json（name=${name}），无法生成画像`); return 1 }
  if (!ident) { console.error(`✗ 身份索引 §二 里找不到场景 ${scene.id}`); return 1 }
  writeIdentityCard(dir, scene.id, ident, scene)
  writePortrait(dir, scene.id, scene, ident)
  console.log(`✓ ${name}：身份卡 + 场景画像 已重生成（卡指纹 ${sha(ident.card).slice(0, 12)}…）`)
  audit('stamp', name, { card: sha(ident.card).slice(0, 12) })
  return 0
}

function cmdInit(arg) {
  const name = findSceneDir(arg)
  const ex = !name ? exceptionOf(arg) : null
  if (!name && ex) { console.log(`\n${ex.title || arg}（${ex.id}）：例外场景，按设计不建 引擎\\场景记忆\\ 三文档 ⇒ init 跳过`); return 0 }
  if (!name) { console.error('✗ 找不到场景目录：' + arg); return 2 }
  const dir = path.join(MEMROOT, name)
  ensureSkeleton(dir, name)
  console.log(`✓ ${name}：目录骨架就绪（场景私有记忆/身份卡/场景画像/项目记忆/归档/_文件索引）`)
  audit('init', name)
  return cmdStamp(name)
}

function cmdHandover(arg) {
  const name = findSceneDir(arg)
  const ex = !name ? exceptionOf(arg) : null
  if (!name && ex) { console.log(`\n${ex.title || arg}（${ex.id}）：例外场景，没有标准三文档 ⇒ 交接请在它自己的记忆里写（${(ex.roots || []).map((r) => r.path).join(' / ')}）`); return 0 }
  if (!name) { console.error('✗ 找不到场景目录：' + arg); return 2 }
  const dir = path.join(MEMROOT, name)
  ensureSkeleton(dir, name)
  const main = path.join(dir, '场景私有记忆.md')
  let body = fs.readFileSync(main, 'utf8')
  const arch = path.join(dir, '归档')
  const sid6 = (readIdentity().get(sceneOf(name)?.id || '')?.sessionId || '').replace('session-', '').slice(0, 6) || 'nosid'
  const file = `场景私有记忆-${stamp().replace(/[-: ]/g, '').slice(0, 12)}-${sid6}.md`
  fs.writeFileSync(path.join(arch, file), body, 'utf8')
  console.log(`✓ 旧版已归档：归档\\${file}（${Buffer.byteLength(body)} B）`)
  // 补 §〇 四小节（缺哪个补哪个）
  const has = (s) => body.includes(s)
  const missing = []
  if (!has('### 1) 上次交接')) missing.push('### 1) 上次交接\n- 旧版已归档 `归档\\' + file + '`\n')
  if (!has('### 2) 当前项目')) missing.push('### 2) 当前项目\n| 项目 | 记忆文件 | 状态 | 下一步 |\n|---|---|---|---|\n| （暂无） | — | — | — |\n')
  if (!has('### 3) 私有记忆变更')) missing.push('### 3) 私有记忆变更\n- \n')
  const pmDir = path.join(main, '..', '项目记忆')
  const archDir = path.join(main, '..', '归档')
  const nProj = fs.existsSync(pmDir) ? fs.readdirSync(pmDir).filter((x) => x.endsWith('.md')).length : 0
  const nArch = fs.existsSync(archDir) ? fs.readdirSync(archDir).filter((x) => x.endsWith('.md')).length : 0
  if (!has('### 5) 全貌')) missing.push('### 5) 全貌（自动生成，别手改）\n- 项目记忆 ' + nProj + ' 个 · 归档 ' + nArch + ' 份 · 索引 _文件索引.md\n- 身份卡 / 场景画像 / 共享层 areas 已就位；全貌细节看 核职责 + §一 + §二\n- 卡点 / 等谁：见第 4 节\n')
  if (!has('### 4) 下一步 / 卡点')) missing.push('### 4) 下一步 / 卡点\n- \n')
  if (missing.length) {
    const h = body.indexOf('## §〇')
    if (h >= 0) {
      const lineEnd = body.indexOf('\n', h)
      const at = lineEnd >= 0 ? lineEnd + 1 : body.length
      body = body.slice(0, at) + '\n' + missing.join('\n') + body.slice(at)
    } else {
      body = '# 场景私有记忆\n\n## §〇 当前交接（≤4 KB）\n\n' + missing.join('\n') + '\n' + body
    }
    fs.writeFileSync(main, body, 'utf8')
  }
  console.log('✓ ' + name + '：§〇 四小节已补 ' + missing.length + ' 处 · 索引已登记')
  // 索引登记
  const fidx = path.join(dir, '_文件索引.md')
  if (fs.existsSync(fidx)) fs.appendFileSync(fidx, `| \`归档\\${file}\` | 交接前快照（只进不改） | 留档 | ${NOW().toISOString().slice(0, 10)} |\n`, 'utf8')
  audit('handover', name, { archive: file })
  cmdStamp(name)
  // 2026-10-28（宿主定）：「写入即索引」——交接完顺手把各场景 §〇 灌进记忆库（记了就能搜；失败不影响交接）
  try {
    const r = __MEMLIB_OK ? spawnSync(process.execPath, [path.join(TOOL_DIR, '记忆库.mjs'), '--import'], { encoding: 'utf8', windowsHide: true, timeout: 180000 }) : { status: 0, stdout: '(公开版无记忆库，跳过)' }
    const last = String(r.stdout || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(-1)[0] || ''
    console.log(r.status === 0 ? `✓ 记忆库已入库（写入即索引）：${last}` : `⚠ 记忆库入库失败（不影响交接，exit=${r.status}）`)
  } catch (e) {
    console.log('⚠ 记忆库入库异常（不影响交接）：' + String((e && e.message) || e).slice(0, 120))
  }
  return 0
}

/** <客户> OA：§2.4 例外，记忆是 E 盘目录里的多份文档，不按 `<场景>\场景私有记忆.md` 检查。 */
function cmdCheckOa() {
  const dir = '<盘根>:\\工作\\工程文件\\<客户>教育oa\\项目信息'
  const problems = []
  const ok = []
  for (const f of ['README.md', '31_会话接手锚点.md', '项目记忆-langchen-oa.md']) {
    if (fs.existsSync(path.join(dir, f))) ok.push(f)
    else problems.push('缺文件 ' + f)
  }
  const anchorPath = path.join(dir, '31_会话接手锚点.md')
  const anchor = fs.existsSync(anchorPath) ? fs.readFileSync(anchorPath, 'utf8') : ''
  if (!anchor) {
    problems.push('31_会话接手锚点.md 读不到')
  } else {
    const h = anchor.search(/^## (?:§〇|〇、)/m)
    if (h < 0) {
      problems.push('31 里没有 §〇/〇、当前交接 段')
    } else {
      const rest = anchor.slice(h)
      const next = rest.indexOf('\n## ', 5)
      const sec = next >= 0 ? rest.slice(0, next) : rest
      const bytes = Buffer.byteLength(sec)
      if (bytes > 4096) problems.push('§〇 超 4 KB（' + bytes + ' B）')
      else ok.push('§〇 ' + bytes + ' B')
    }
    const ci = anchor.search(/^## 核心职责/m)
    if (ci < 0) problems.push('31 里没有 ## 核心职责')
    else {
      const rest = anchor.slice(ci)
      const next = rest.indexOf('\n## ', 5)
      const sec = next >= 0 ? rest.slice(0, next) : rest
      const n = (sec.match(/^- /gm) || []).length
      if (n < 3) problems.push('核心职责只有 ' + n + ' 条（至少 3 条）')
      else ok.push('核心职责 ' + n + ' 条')
    }
  }
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(MEMROOT, '_共享记忆', '项目.json'), 'utf8'))
    const p = (pj.projects || []).find((x) => x.id === 'langchen-oa')
    const want = path.join(dir, '项目记忆-langchen-oa.md')
    if (!p) problems.push('项目.json 里没有 langchen-oa')
    else if (path.resolve(p.memory || '') !== path.resolve(want)) problems.push('项目.json memory 没指向 OA 项目记忆')
    else ok.push('项目.json 路由一致')
  } catch (e) {
    problems.push('项目.json 读不到：' + e.message)
  }
  console.log(`\n<客户> OA（oa-ops）：${problems.length ? '✗' : '✓'} OA 例外（E 盘自有布局）`)
  for (const s of ok) console.log('  ✓ ' + s)
  for (const s of problems) console.log('  ✗ ' + s)
  return problems.length ? 1 : 0
}

function cmdCheck(name) {
  const dir = path.join(MEMROOT, name)
  // 例外场景（清单见 场景记忆-例外.json）：没有标准目录时给明确状态，**不再 ENOENT 抛错**
  if (!fs.existsSync(dir)) {
    const ex = exceptionOf(name) || exceptionOf((sceneOf(name) || {}).id)
    if (ex) return cmdCheckException(name, ex)
    console.log(`\n${name}：✗ 没有这个场景目录（${dir}）；若不是例外场景就先 init，若是就登记到 ${EXCEPTION_FILE}`)
    return 1
  }
  const scene = sceneOf(name)
  const ident = scene ? readIdentity().get(scene.id) : null
  const problems = []
  const warns = []
  const ok = []
  const SESS = path.join(MEMROOT, '..', '.dsh', 'sessions')
  for (const f of ['场景私有记忆.md', '身份卡.md', '场景画像.md', '_文件索引.md']) {
    if (fs.existsSync(path.join(dir, f))) ok.push(f); else problems.push('缺文件 ' + f)
  }
  for (const d of ['项目记忆', '归档']) {
    if (fs.existsSync(path.join(dir, d))) ok.push(d + '\\'); else problems.push('缺目录 ' + d + '\\')
  }
  if (ident && ident.card) {
    const card = fs.readFileSync(path.join(dir, '身份卡.md'), 'utf8')
    const fp = (card.match(/卡指纹`\s*`?sha256:([0-9a-f]+)/) || card.match(/sha256:([0-9a-f]{8,64})/) || [])[1]
    const real = sha(ident.card).slice(0, fp ? fp.length : 16)
    if (!fp) problems.push('身份卡里没有卡指纹')
    else if (!sha(ident.card).startsWith(fp)) problems.push(`卡指纹过期（卡已改，跑 stamp）${fp}…≠${real}…`)
    else ok.push('卡指纹一致')
  } else problems.push('身份索引里没有这张场景卡')
  // 会话必须绑定到场景（2026-10-27 卡07 决定）
  if (scene && ident) {
    const panelSessions = (scene.panels || []).filter((p) => p && p.sessionId).map((p) => p.sessionId)
    if (!panelSessions.includes(ident.sessionId)) problems.push('会话未绑定场景 json（身份索引 ' + ident.sessionId + '，json 面板 ' + (panelSessions.join(',') || '无') + '）')
    else ok.push('会话已绑定场景')
    let found = false
    if (fs.existsSync(SESS)) {
      for (const ws of fs.readdirSync(SESS)) {
        if (fs.existsSync(path.join(SESS, ws, ident.sessionId, 'session.v4.jsonl.zstd')) || fs.existsSync(path.join(SESS, ws, ident.sessionId, 'session.v3.jsonl.zstd'))) { found = true; break }
      }
    }
    if (!found) warns.push('会话文件不在库（可能刚归档/换会话未回填）')
  }
  const mainPath = path.join(dir, '场景私有记忆.md')
  if (!fs.existsSync(mainPath)) { console.log('\n' + name + '：✗ 缺 场景私有记忆.md（跑 init）'); return 1 }
  const main = fs.readFileSync(mainPath, 'utf8')
  // 核心职责块（2026-10-27 宿主定：私有记忆必须包含核心职责）
  {
    const i = main.search(/^## 核心职责/m)
    if (i < 0) problems.push('缺「## 核心职责」块（私有记忆必填）')
    else {
      const rest = main.slice(i)
      const next = rest.indexOf('\n## ', 5)
      const sec = next >= 0 ? rest.slice(0, next) : rest
      const n = (sec.match(/^- /gm) || []).length
      if (n < 3) problems.push('核心职责只有 ' + n + ' 条（至少 3 条）')
      else ok.push('核心职责 ' + n + ' 条')
    }
  }
  for (const s of ['### 1) 上次交接', '### 2) 当前项目', '### 3) 私有记忆变更', '### 4) 下一步 / 卡点', '### 5) 全貌']) {
    if (!main.includes(s)) problems.push('§〇 缺小节 ' + s)
  }
  // 内容告警：项目表不能空、下一步/卡点不能空（卡08 决定：只告警不阻断）
  {
    const seg = (head) => {
      const i = main.indexOf(head)
      if (i < 0) return ''
      const e = main.indexOf('\n### ', i + head.length)
      return main.slice(i, e > i ? e : main.length)
    }
    const seg2 = seg('### 2) 当前项目')
    const rows = seg2.split(/\r?\n/).filter((l) => l.trim().startsWith('|') && !/^\|\s*-/.test(l.trim()))
    if (rows.length <= 1) warns.push('当前项目表是空的（没项目要写“无”）')
    const seg4 = seg('### 4) 下一步 / 卡点')
    const body4 = seg4.split(/\r?\n/).filter((l) => /^-\s*\S/.test(l.trim()))
    if (!body4.length) warns.push('第 4 节 下一步/卡点 为空')
  }
  // §〇 区段：从 '## §〇' 到下一个二级标题（不假设下一个一定叫 §一）
  const mNew = main.match(/^## §〇[^\n]*$/m)
  const mOld = main.match(/^## 〇、当前交接[^\n]*$/m)
  let h0 = mNew ? mNew.index : (mOld ? mOld.index : -1)
  const oldH0 = mOld ? mOld.index : -1
  const hasNew = !!mNew, hasOld = !!mOld
  let secEnd = main.length
  if (h0 >= 0) {
    const nxt = main.indexOf('\n## ', h0 + 5)
    if (nxt > h0) secEnd = nxt
  }
  const sec0Bytes = h0 >= 0 ? Buffer.byteLength(main.slice(h0, secEnd)) : 0
  // 2026-10-27 L2：新旧 §0 头/空骨架/项目表
  if (h0 < 0) problems.push('缺 §〇 交接头（## §〇 或旧 ## 〇、当前交接 都没有）')
  else {
    if (hasOld && !hasNew) warns.push('用的是旧 §0 头（## 〇、当前交接），建议改为 ## §〇 当前交接')
    if (hasOld && hasNew) warns.push('新旧两个 §0 头并存（旧头内容需并入/归档）')
    const seg0 = main.slice(h0, secEnd)
    let pmCount = 0
    try { const pm = path.join(dir, '项目记忆'); pmCount = fs.existsSync(pm) ? fs.readdirSync(pm).filter((x) => x.endsWith('.md')).length : 0 } catch {}
    if (pmCount > 0 && /\|\s*（暂无）\s*\|/.test(seg0)) warns.push('当前项目表写“暂无”，但项目记忆有 ' + pmCount + ' 份（表需更新）')
    if ((pmCount > 0 || hasOld) && /### 2\) 当前项目[\s\S]{0,120}?（暂无）/.test(seg0) && /### 3\)[\s\S]{0,40}?-\s*\n/.test(seg0)) warns.push('§〇 仍是空骨架（项目表暂无 + 变更/下一步为空）')
  }
  if (sec0Bytes > 4096) problems.push('§〇 ' + sec0Bytes + ' B 超 4 KB（红线 4096）')
  const mainBytes = Buffer.byteLength(main)
  if (mainBytes > 25600) warns.push('主文件 ' + (mainBytes / 1024).toFixed(1) + ' KB 超 25 KB（红线，搬旧内容进 归档\\ 并留指针）')
  console.log(`\n${name}：${problems.length ? '✗ ' + problems.length + ' 个问题' : '✓ 全部通过'}（§〇 ${sec0Bytes} B${warns.length ? ' · ⚠ ' + warns.length : ''}）`)
  problems.forEach((p) => console.log('   ✗ ' + p))
  warns.forEach((p) => console.log('   ⚠ ' + p))
  return problems.length ? 1 : 0
}

/* ------------------------------------------------------------------ 入口 */

const argv = process.argv.slice(2)
const cmd = argv[0]
if (cmd === 'audit') {
  if (!fs.existsSync(AUDIT)) { console.log('暂无写入日志'); process.exit(0) }
  const lines = fs.readFileSync(AUDIT, 'utf8').trim().split(/\r?\n/).slice(-30)
  lines.forEach((l) => { try { const x = JSON.parse(l); console.log(x.ts, x.by, x.action, x.scene, x.archive || x.card || '') } catch {} })
  process.exit(0)
}
const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : '' }
const arg = val('--场景') || val('--scene') || ''

if (cmd === 'list' || !cmd) {
  const dirs = fs.existsSync(MEMROOT) ? fs.readdirSync(MEMROOT, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('_')).map((e) => e.name) : []
  let bad = 0
  for (const d of dirs.sort()) {
    const has = (f) => fs.existsSync(path.join(MEMROOT, d, f))
    const flag = (b) => (b ? '✓' : '✗')
    const line = `  ${d}   私有${flag(has('场景私有记忆.md'))} 身份${flag(has('身份卡.md'))} 画像${flag(has('场景画像.md'))} 项目${flag(has('项目记忆'))} 归档${flag(has('归档'))}`
    if (!(has('身份卡.md') && has('场景画像.md'))) bad++
    console.log(line)
  }
  console.log(`\n共 ${dirs.length} 个场景；缺身份卡/画像 ${bad} 个`)
  // 例外场景（清单见 场景记忆-例外.json）：在标准根下没有目录，单列一行
  for (const ex of readExceptions().values()) {
    const miss = (ex.roots || []).filter((r) => !fs.existsSync(r.path))
    console.log(`  例外 ${ex.id}（${ex.title || ''}）  记忆根 ${(ex.roots || []).length} 个 ${miss.length ? '✗ 缺 ' + miss.length : '✓'}`)
  }
  process.exit(0)
}

if (cmd === 'check' && argv.includes('--all')) {
  let n = 0
  for (const d of fs.readdirSync(MEMROOT, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('_')).map((e) => e.name).sort()) {
    if (!sceneOf(d)) { console.log('\n' + d + '：跳过（不是场景目录，没有对应场景 json）'); continue }
    n += cmdCheck(d) ? 1 : 0
  }
  // 例外场景（清单见 场景记忆-例外.json）：标准根下没有目录，但一样要 check
  for (const ex of readExceptions().values()) n += cmdCheckException(ex.id, ex) ? 1 : 0
  process.exit(n ? 1 : 0)
}

if (!arg) { console.error('用法：node 场景记忆.mjs <init|stamp|交接|check|list> --场景 <目录名>'); process.exit(2) }

if (cmd === 'list') process.exit(0)
if (cmd === 'init') process.exit(cmdInit(arg))
if (cmd === 'stamp') process.exit(cmdStamp(findSceneDir(arg) || arg))
if (cmd === '交接' || cmd === 'handover') process.exit(cmdHandover(arg))
if (cmd === 'check') {
  const ex = exceptionOf(arg)
  if (ex && ex.handler === 'oa') process.exit(cmdCheckOa())
  process.exit(cmdCheck(findSceneDir(arg) || arg))
}
console.error('未知命令：' + cmd)
process.exit(2)
