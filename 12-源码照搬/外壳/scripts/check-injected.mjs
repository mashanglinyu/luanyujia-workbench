#!/usr/bin/env node
// 自检：renderers.js / main.js 里"注入到 AI 面板(webview)里执行的脚本字符串"能否正常解析。
// 背景（2026-09 事故）：这些脚本是模板字符串，宿主文件 node --check 通过 ≠ 注入脚本能跑。
// 一旦里面少了括号/引号，症状是"AI 面板钉不住会话"，且没有任何报错 —— 极难排查。
// 所以这里把它们抽出来，逐个 new Function() 解析一遍（只解析，不执行）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let bad = 0;

// 取 "const NAME = `...`;" 里的模板内容（首个未转义反引号即结束；注入脚本内部不使用反引号）
function pickLiteral(src, name) {
  const key = 'const ' + name + ' = `';
  const i = src.indexOf(key);
  if (i < 0) return null;
  const from = i + key.length;
  let out = '';
  for (let p = from; p < src.length; p++) {
    const ch = src[p];
    if (ch === '\\') { out += ch + (src[p + 1] || ''); p++; continue; }
    if (ch === '`') return out;
    out += ch;
  }
  return null;
}

// 把模板里的 ${xxx} 占位符换成合法字面量，再用 new Function 解析（等于浏览器注入后的代码）
function check(label, raw, subs) {
  if (raw == null) { console.log('✗ ' + label + '：未找到'); bad++; return; }
  let code = raw;
  for (const [k, v] of Object.entries(subs || {})) {
    code = code.split('${' + k + '}').join(v);
  }
  const left = code.match(/\$\{[^}]*\}/);
  if (left) { console.log('✗ ' + label + '：仍有未替换的占位符 ' + left[0]); bad++; return; }
  try {
    // eslint-disable-next-line no-new-func
    new Function(code);
    console.log('✓ ' + label + '：注入脚本可解析（' + code.length + ' 字符）');
  } catch (e) {
    console.log('✗ ' + label + '：注入脚本语法错误 → ' + (e && e.message));
    bad++;
  }
}

const rPath = path.join(root, 'renderer', 'renderers.js');
const mPath = path.join(root, 'main.js');
const r = fs.readFileSync(rPath, 'utf8');
const m = fs.readFileSync(mPath, 'utf8');

// renderers.js：每个 AI 面板注入的两段（外层 HARNESS_FIX_JS 里嵌了 ${HARNESS_PIN_JS}）
const pinRaw = pickLiteral(r, 'HARNESS_PIN_JS');
// 2026-09-20 第三波（会话列铺满）：布局修复脚本里又嵌了 ${HARNESS_WIDE_PIN_JS}，而那段自己内部还嵌了
// ${JSON.stringify(HARNESS_WIDE_COL/CARD)}。这里把两个常量从**同一份源码**里抠出来做同样的替换，
// 保证校验的是"注入后真正执行的那段代码"，而不是靠往白名单里塞一个跳过项糊过去。
function wideSubs(src) {
  // ⚠ 这里不能用上面那个 pickLiteral：它只认 `const NAME = \``，而 renderers.js 顶部的常量必须写 var ——
  //   ⟳ 热更新会在同一上下文里把整份脚本重新求值一次，用 const 会直接 "Identifier has already been declared"。
  const pick = (n) => {
    const m = new RegExp('(?:const|let|var)\\s+' + n + '\\s*=\\s*`').exec(src);
    if (!m) return null;
    let out = '';
    for (let p = m.index + m[0].length; p < src.length; p++) {
      const ch = src[p];
      if (ch === '\\') { out += ch + (src[p + 1] || ''); p++; continue; }
      if (ch === '`') return out;
      out += ch;
    }
    return null;
  };
  const lit = pick('HARNESS_WIDE_PIN_JS') || '';
  const col = (src.match(/HARNESS_WIDE_COL\s*=\s*'([^']*)'/) || [])[1] || '';
  const card = (src.match(/HARNESS_WIDE_CARD\s*=\s*'([^']*)'/) || [])[1] || '';
  return {
    HARNESS_WIDE_PIN_JS: lit
      .split('${JSON.stringify(HARNESS_WIDE_COL)}').join(JSON.stringify(col))
      .split('${JSON.stringify(HARNESS_WIDE_CARD)}').join(JSON.stringify(card)),
  };
}
const subs = {
  PIN_TARGETS_JS: '["会话A","会话B"]',
  PIN_SESSION_JS: '"会话A"',
  PIN_SESSION_ID_JS: '"session-aaaa"',
  PIN_PANEL_JS: '"panel-a"',
  HARNESS_PIN_JS: String(pinRaw || '')
    .split('${PIN_TARGETS_JS}').join('["会话A","会话B"]')
    .split('${PIN_SESSION_JS}').join('"会话A"')
    .split('${PIN_SESSION_ID_JS}').join('"session-aaaa"')
    .split('${PIN_PANEL_JS}').join('"panel-a"'),
  ...wideSubs(r),
};
check('renderers.js · HARNESS_PIN_JS（钉会话+绑定）', pinRaw, subs);
check('renderers.js · HARNESS_FIX_JS（布局修复，含钉会话）', pickLiteral(r, 'HARNESS_FIX_JS'), subs);

// main.js：主进程注入的布局修复脚本（__DSH_PIN_TARGET__ 已移交渲染层，这里仍保留替换逻辑，替换为 no-op）
check('main.js · HARNESS_FIX_JS', pickLiteral(m, 'HARNESS_FIX_JS'),
  Object.assign({ __DSH_PIN_TARGET__: '["会话A"]' }, wideSubs(m)));

// 关键逻辑存在性断言：根治项不允许被回退掉
const must = [
  [r, "(meta && meta.sessionTitle)", '渲染层：场景可指定会话完整标题'],
  [r, "(meta && meta.sessionId)", '渲染层：场景必须给会话 id（一板一分区 + 写键直达都靠它）'],
  [r, "'dsh.sessions.current'", '渲染层：会读写应用存储的当前会话键（在本面板分区里写目标 id，直达通道用）'],
  [r, 'app_pin_reloads', '渲染层：本面板分区里的重载预算计数（防无休止 reload）'],
  [r, 'const stripSuffix = (s) =>', '渲染层：当前会话名取自页面标题（"<会话名> — DSH 本地构建"）'],
  [r, 'const isTabLabel = (s) =>', '渲染层：过滤"对话"这类页签名（否则状态小字会误报"未切到 · 对话"）'],
  [r, "wv.setAttribute('partition', panelPartition(meta))", '渲染层：带 sessionId 的面板必须一板一分区（探针实测：全新分区 + 写键 + reload 能确定性进会话）'],
  [r, "'persist:harness-panel-' +", '渲染层：一板一分区的分区名（主窗口 = persist:harness-panel-<面板id>）'],
  [r, "replace(/\\\\s+/g, ' ').trim()", '渲染层：会话标题归一化必须保留空格（否则会把同名孪生会话当成同一个）'],
  // ↓ panelPartition 现在**是活的**（2026-09-19 三次定稿）：带 sessionId 的面板一板一分区。
  [r, "if (meta && meta.sessionId && key)", '渲染层：panelPartition 的"带 id 才独立分区"分支必须在'],
  [r, "if (!q.get('solo')) return 'persist:harness';", '渲染层：没带 sessionId 的面板退回共用 persist:harness（分离窗口按场景命名）'],
  [r, "'persist:harness-solo-' +", '渲染层：场景分离窗口用按场景命名的独立分区（否则两窗口抢当前会话键）'],
  [r, 'if (titlePinned()) {', '渲染层：钉住判定**只看本面板画面**（键写对了 ≠ 应用已经切过去）'],
  [r, 'const storedNow = (() =>', '渲染层：仍读当前会话键，用于状态小字与"要不要写键"的比较'],
  [r, "const rawPin = (meta && meta.pinTarget) || '';", '渲染层：没写 pinTarget 就是不钉（不能回退成历史默认「oa系统运维」）'],
  [r, "'app_pin_bind_v2:' + PANEL", '渲染层：绑定记忆按面板分键（换分区、换会话 id 都不串）'],
  [r, 'const inChat = (e) =>', '渲染层：排除聊天内容区（不点聊天记录里的同名字样）'],
  [r, 'const isGroupHead = (e) =>', '渲染层：不把分组头当会话点'],
  [r, 'const rowTitle = (row) =>', '渲染层：按行内标题节点取标题'],
  [r, 'const forceShow = () =>', '渲染层：列表没渲染时临时显示侧栏'],
  [m, '钉住会话：已移交渲染层', '主进程：不再重复点击抢会话'],
  // 2026-09-20 第三波：会话列铺满（用户："现在会话又变窄了…包括每个场景窗口里的 ai 会话"）——
  // 两条链路都要有，且都不能再退回"往 [data-phase] 写变量"那个空转写法（本版 [data-phase] 是状态小圆点）。
  [r, 'var HARNESS_WIDE_PIN_JS', '渲染层：会话列铺满脚本还在（盖 [data-chat-flow]/[data-composer-card] 的 max-width）'],
  [r, 'HARNESS_WIDE_COL', '渲染层：铺满宽度常量还在（改数字前先跑 probe-chat-width 拿 before/after）'],
  [m, 'const HARNESS_WIDE_PIN_JS', '主进程：会话列铺满脚本与渲染层保持一致'],
];
for (const [src, needle, why] of must) {
  if (src.includes(needle)) console.log('✓ ' + why);
  else { console.log('✗ 缺失：' + why + '（找不到 ' + needle.slice(0, 40) + '…）'); bad++; }
}
// 反向断言：这几条一旦复活，就是"一个会话都切不进去 / 会话错乱"复发
const GENERIC = 'document.querySelectorAll(\'div,button,span,a,li,p,[role="option"]';
const never = [
  [m, /const allEls = document\.querySelectorAll\('div,button,span,a,li/, 'main.js 不能有旧版扫全文档点击'],
  // 当天真实故障 ①：把搜索范围限定在某个"看起来像侧栏"的容器 → 候选恒为空 → 一个会话都点不到
  [r, /const scope = \(\) =>/, '渲染层不能把会话搜索限定在某个容器里（候选会恒为空）'],
  [r, /const SESS_SEL = /, '渲染层不能只认一种会话行选择器（真实页面可能不匹配）'],
  // 当天真实故障 ②：forceShow 改成 fixed/visibility 后虚拟列表不渲染 → 也切不进去
  [r, /visibility:hidden!important/, 'forceShow 规则不能改成 visibility/fixed（虚拟列表会不渲染）'],
  // 当天真实故障 ③（2026-09-14）：'persist:pin-*' 那种临时命名的分区 → 已废弃，分区一律走 panelPartition
  [r, /'persist:pin-'/, '不能再出现 persist:pin-* 临时分区名（分区一律走 panelPartition）'],
  // 2026-09-19 回归点 ④：把面板分区写死成共用 persist:harness → 多面板抢同一个 dsh.sessions.current，
  //   表现就是"两个面板一起卡在欢迎页、主标签被顶到别的会话"。
  [r, /setAttribute\('partition', 'persist:harness'\)/, '分区不能写死成 persist:harness（会退回"多面板抢同一个当前会话键"）'],
  [r, /replace\(\/\\\\s\+\/g, ''\)/, '标题归一化绝不能把空格全删（会把 "DSH 改造" 与 "DSH改造" 这类孪生会话混成一个 → 面板切到空会话）'],
  // 2026-09-19 回归点 ⑤（三次定稿后改成"限量断言"，见下面的 reloadHits 检查）：
  //   写键 + reload 本身是**对的**做法（一板一分区，各写各的键，探针实测能确定性进会话）；
  //   危险的是"无预算保护地反复重载"—— 那次「每隔一会跳一下刷新、一打字就断」就是这么来的。
  // 但"键写对了"仍然**不能**当成"我到位了"：判据只能是本面板画面。
  [r, /storedOk/, '不能用存储值判断"我到位了没有"（键对 ≠ 应用切过去了，判据只能是画面）'],
  // 2026-09-20 第三波：宽度修复绝不能退回"往 [data-phase] 写 --dsh-chat-content-width"那个空转写法 ——
  //   本版引擎里 [data-phase] 是连接状态小圆点，不是会话相位容器，写上去了变量也到不了会话列（实测列仍钉在 887px）。
  //   注意只匹配"真的写成 CSS 条目"的形式（前面是单引号）；文件注释里用反引号引用老写法不算。
  [r, /'\[data-phase\]\s*\{\s*--dsh-chat-content-width/, '渲染层不能退回"往 [data-phase] 写宽度变量"的空转写法'],
  [m, /'\[data-phase\]\s*\{\s*--dsh-chat-content-width/, '主进程不能退回"往 [data-phase] 写宽度变量"的空转写法'],
];
for (const [src, re, why] of never) {
  if (re.test(src)) { console.log('✗ 禁止项复活：' + why); bad++; }
  else console.log('✓ ' + why);
}
// 直达通道的"限量"断言（2026-09-19 三次定稿）：reload 只准一处，且必须带三道前置判断。
//   ① readReloads() < RELOAD_MAX  —— 有重载预算，用完退回点击侧栏；
//   ② curSel !== String(SESSION_ID) —— 键已经等于目标就不写、不重载（否则每次都刷）；
//   ③ markReloadAt()              —— 两次重载之间必须隔 reloadGap()，防秒级对刷。
// ★ 2026-09-26：只认**真代码**里的 reload —— 注释里提到 location.reload() 不算数。
//   起因：渲染层按规则删掉了多余那处（其注释里写明"不许再用 location.reload()"），
//   但旧逻辑把注释里的这个词也数上 ⇒ 报"3 处"是**误判**（本检查器别处都做了同类处理，这里漏了）。
const codeOnly = r
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split(/\r?\n/)
  .filter((line) => !/^\s*\/\//.test(line))
  .join('\n');
const reloadHits = (codeOnly.match(/location\.reload\(\)/g) || []).length;
if (reloadHits === 1) console.log('✓ 直达通道只保留 1 处 location.reload()（不会无限对刷；只数真代码，注释不算）');
else { console.log('✗ location.reload() 出现 ' + reloadHits + ' 处（必须恰好 1 处，且带重载预算；只数真代码）'); bad++; }
const guards = ['readReloads() < RELOAD_MAX', 'curSel !== String(SESSION_ID)', 'markReloadAt()'].filter((n) => codeOnly.includes(n));
if (guards.length === 3) console.log('✓ 写键 + reload 有预算 / 键比对 / 时间戳三道防护');
else { console.log('✗ 直达通道防护不全，缺：' + ['readReloads() < RELOAD_MAX', 'curSel !== String(SESSION_ID)', 'markReloadAt()'].filter((n) => !codeOnly.includes(n)).join('、')); bad++; }
if (r.includes(GENERIC)) console.log('✓ 全文档候选扫描在（排除聊天区 + 会话行优先 + 放宽回退）');
else { console.log('✗ 全文档候选扫描不见了 → 会退化成"找不到会话"'); bad++; }
if (r.includes('findBest(false) || findBest(true)')) console.log('✓ 严格找不到时还会放宽再找一遍');
else { console.log('✗ 缺少"放宽回退"，一旦严格匹配为空就一个都点不到'); bad++; }
// 幂等守卫（2026-09-19 三次定稿补）：宿主每 5 秒会"轻量重注入"一次本脚本，若每次都新装 setInterval，
//   几分钟就攒出几十个 4 秒循环 —— 表现为面板状态小字周期性乱跳 + 空转扫 DOM（用户实感「每隔一会跳一下」）。
//   要求：开头有同代守卫（window.__pinGen === GEN），末尾把 GEN 与轻量 tick 挂到 window 上。
const idleNeed = ['window.__pinGen === GEN', 'window.__pinGen = GEN', 'window.__pinTick = () =>'];
const idleMiss = idleNeed.filter((n) => !r.includes(n));
if (!idleMiss.length) console.log('✓ 注入脚本是幂等的（宿主 5 秒重注入只跑轻量 tick，不会攒定时器）');
else { console.log('✗ 幂等守卫缺失（重复注入会攒定时器 → 周期性跳动），缺：' + idleMiss.join('、')); bad++; }

console.log(bad ? ('\n检查未通过 ✗ 共 ' + bad + ' 项') : '\n注入脚本检查全部通过 ✓');
process.exit(bad ? 1 : 0);
