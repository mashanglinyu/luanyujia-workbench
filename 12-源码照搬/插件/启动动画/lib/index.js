/**
 * 启动动画插件 —— 主机侧。
 *
 * 只做一件事：读写「外壳启动动画」的配置契约文件
 *   <工作台>\外壳\data\boot-animation.json
 *     { "id": "classic", "available": [ {id, name, desc}, ... ] }
 *
 * 分工：**外壳管播放**（启动时读这个文件的 id）、**本插件管选择**（设置里的卡片）。
 * ⇒ available 由外壳写全，本插件只读；以后外壳加动画，这里自动多一张卡。
 *
 * 路由（前缀 /plugins/boot-anim）：
 *   GET  /list    当前选择 + 可选清单
 *   POST /select  {id}  写入选择（只保存，不预览）
 *   POST /preview {id?}  只写预览触发文件，不改选择（id 省略=当前选择）
 */

import fs from 'node:fs'
import path from 'node:path'

export const name = 'boot-anim-host'
export const inject = ['webServer']

const BASE = '/plugins/boot-anim'
const SHELL_DIR = process.env.DSH_SHELL_DIR || '<工作台>\\外壳'   // 2026-10-28 客户包：外壳装到别处时用 DSH_SHELL_DIR 覆盖
const CFG = path.join(SHELL_DIR, 'data', 'boot-animation.json')
/** 预览请求文件：外壳轮询它，发现 at 变新就播一遍（点切换即预览的通道）。 */
const PREVIEW = path.join(SHELL_DIR, 'data', 'boot-preview.json')

/** 兜底清单：外壳还没实现注册表时，也让设置面板有东西可显示。 */
const FALLBACK = [
  { id: 'classic', name: '线条睁眼鲸鱼', desc: '鲸鱼 logo + 标题 + 阶段文字 + 进度条（默认）' },
]

function readCfg() {
  try {
    const t = fs.readFileSync(CFG, 'utf8').replace(/^\uFEFF/, '')
    const j = JSON.parse(t)
    const avail = Array.isArray(j.available) && j.available.length ? j.available : FALLBACK
    const ids = avail.map((x) => x && x.id).filter(Boolean)
    const current = ids.indexOf(j.id) >= 0 ? j.id : (ids[0] || 'classic')
    return { ok: true, current, available: avail, source: CFG }
  } catch (e) {
    return { ok: true, current: 'classic', available: FALLBACK, source: CFG, fallback: String(e && e.message || e).slice(0, 120) }
  }
}

function writeCfg(id) {
  const cur = readCfg()
  const avail = cur.available
  const ids = avail.map((x) => x && x.id).filter(Boolean)
  if (ids.indexOf(id) < 0) return { ok: false, err: '不认识的动画 id：' + id, available: ids }
  const body = JSON.stringify({ id, available: avail }, null, 2) + '\n'
  fs.mkdirSync(path.dirname(CFG), { recursive: true })
  const tmp = CFG + '.tmp'
  fs.writeFileSync(tmp, body, 'utf8')
  fs.renameSync(tmp, CFG)   // 原子落盘
  return { ok: true, current: id }
}

/**
 * 只触发预览，不改选择。
 * 契约文件：外壳 renderers.js 轮询 `boot-preview.json`，发现 at 变新就播一遍 id。
 * 客户端 top「预览当前」走这里；卡片点选不再自动预览。
 */
function writePreview(id) {
  const cur = readCfg()
  const ids = cur.available.map((x) => x && x.id).filter(Boolean)
  const target = String(id || cur.current || '')
  if (!target || ids.indexOf(target) < 0) return { ok: false, err: '不认识的动画 id：' + (target || '(空)'), available: ids }
  const pv = { id: target, at: Date.now(), by: 'boot-anim-plugin' }
  fs.mkdirSync(path.dirname(PREVIEW), { recursive: true })
  const ptmp = PREVIEW + '.tmp'
  fs.writeFileSync(ptmp, JSON.stringify(pv) + '\n', 'utf8')
  fs.renameSync(ptmp, PREVIEW)
  return { ok: true, id: target, at: pv.at, path: PREVIEW }
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(obj))
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = ''
    req.on('data', (c) => { buf += c; if (buf.length > 100 * 1024) req.destroy() })
    req.on('end', () => resolve(buf))
    req.on('error', () => resolve(''))
  })
}

export function apply(ctx) {  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: BASE,
      handler: async (req, res) => {
        const pathname = new URL(req.url ?? '/', 'http://x').pathname
        const method = (req.method ?? 'GET').toUpperCase()

        if (pathname === BASE + '/list' && method === 'GET') {
          return sendJson(res, 200, readCfg())
        }

        if (pathname === BASE + '/select' && method === 'POST') {
          const raw = await readBody(req)
          let id = ''
          try { id = String(JSON.parse(raw || '{}').id || '') } catch (e) { id = '' }
          if (!id) return sendJson(res, 400, { ok: false, err: '缺少 id' })
          const r = writeCfg(id)
          return sendJson(res, r.ok ? 200 : 400, r)
        }

        if (pathname === BASE + '/preview' && method === 'POST') {
          const raw = await readBody(req)
          let id = ''
          try { id = String(JSON.parse(raw || '{}').id || '') } catch (e) { id = '' }
          const r = writePreview(id)
          return sendJson(res, r.ok ? 200 : 400, r)
        }

        return sendJson(res, 404, { ok: false, err: '未知路径：' + pathname })
      },
    }),
  )
}

// 给自测/打包校验用（不改变插件运行时行为）。
export { writeCfg, writePreview }

