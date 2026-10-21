// MCP-站点薄壳.mjs —— 给「免费网页版 AI」加一个新站的薄壳骨架
//
// ⚠⚠ 这是**骨架**，不是能直接跑的实现：
//   · 每个站的选择器、登录态、等待策略都不一样，必须你自己按 F12 现量；
//   · 本机真实实现（含各站差异与坑）在 03 正文里，这里只保留**形状**；
//   · 接口名（bridge.*）是你的桥自己的约定 —— 按你 `03-MCP接免费AI/` 里那套改。
//
// 目标：把"网页版 AI"包装成本地 MCP 工具，**不花 API token**。
// 一次调用 = 在一个已登录的隐藏窗口里输入问题、等回答、取出文本。
//
// 用法：拷到你自己的站点目录，按 TODO 填 5 处，然后在站点表里注册。

/**
 * 一个站点的描述对象 —— 薄壳的全部"配置面"。
 * 加一个新站 = 加一个这个对象，不要复制整个流程。
 */
export const site = {
  // ── TODO 1：身份 ────────────────────────────────────────────────
  id: 'my-site',                 // 站点 id（小写连字符，会被当作工具名前缀）
  name: '某免费 AI',              // 显示名
  url: 'https://example.com/',   // 起始页（必须是已登录才能用的那个页）

  // ── TODO 2：登录态判定 ──────────────────────────────────────────
  // 拿什么判断"这个窗口已经登录"？最稳的是"只有登录后才存在的元素"。
  // ⛔ 别用 cookie 名字：各家天天改；⛔ 别用"页面标题含某词"：太脆。
  loggedIn: async (page) => {
    // 例：return (await page.$('textarea[placeholder]')) !== null;
    return true;                 // ← 占位，务必改
  },

  // ── TODO 3：三步操作的选择器 ───────────────────────────────────
  // ① 输入框：能接受多行文本的那个（不是搜索框！很多站有两个）
  inputSel: 'textarea',
  // ② 发送方式：优先"回车"（多数站支持），不支持就点按钮
  send: async (page) => { await page.keyboard.press('Enter'); },
  // ③ 回答容器：一次回答的最外层节点（等它出现 → 等它稳定不再变）
  answerSel: '[data-answer]',

  // ── TODO 4：等待策略（这一层决定稳不稳）─────────────────────────
  wait: {
    firstTokenMs: 20000,   // 第一段文字出现的最长等待
    stableMs: 1200,        // 文本"多久没变化"算说完（关键！不能只看"出现"）
    hardTimeoutMs: 180000, // 兜底上限，超时就报错，别无限等
  },

  // ── TODO 5：登录态怎么给（三种，按你自己的情况选一种）────────────
  //  a) 持久化 profile 目录（推荐）：第一次手动登录，之后复用
  //  b) 让用户每次扫码/登录（最稳但麻烦）
  //  c) 导入 cookie（最脆，站点一改就废）
  profileDir: null,        // 指向你自己的浏览器 profile 目录
};

/**
 * 一次问答。薄壳只做"输入 → 等稳定 → 取文本"，**别的都不做**。
 *
 * @param {object} bridge  你的桥（提供 openPage / text / waitStable 等能力）
 * @param {string} question 用户的问题（纯文本；⛔ 别把机密发出去）
 * @returns {Promise<string>} 回答正文
 */
export async function ask(bridge, question) {
  if (!question || !question.trim()) throw new Error('问题为空');

  const page = await bridge.openPage(site.id, site.url, { profileDir: site.profileDir });

  if (!(await site.loggedIn(page))) {
    // ⛔ 不要在这里尝试"自动登录"：几乎都会触发风控，也会让排查变复杂。
    throw new Error(`[${site.id}] 未登录：请先在 "${site.name}" 窗口里手动登录一次`);
  }

  // ① 输入：先清空再填（很多站是 contenteditable，直接赋值不触发事件）
  await bridge.fill(page, site.inputSel, question);

  // ② 发送
  await site.send(page);

  // ③ 等"第一段出现"，再等"不再变化" —— 这两步必须分开
  await bridge.waitFor(page, site.answerSel, site.wait.firstTokenMs);
  const text = await bridge.waitStable(page, site.answerSel, {
    stableMs: site.wait.stableMs,
    timeoutMs: site.wait.hardTimeoutMs,
  });

  if (!text || !text.trim()) throw new Error(`[${site.id}] 取到空回答（选择器可能过期）`);
  return text.trim();
}

/**
 * 注册成 MCP 工具时的最小形状（按你自己的 MCP 框架改）。
 * 工具名建议：`ask_<site.id>`，描述里写清"慢、只适合一次性纯文字活"。
 */
export const tool = {
  name: 'ask_' + site.id,
  description: '问「' + site.name + '」一个问题并取回回答。慢（几十秒），只适合一次性纯文字任务；⛔ 不要发密码/token/证件/手机号。',
  inputSchema: {
    type: 'object',
    properties: { question: { type: 'string', description: '要问的问题（纯文本）' } },
    required: ['question'],
  },
};

// ── 三条从踩坑里来的纪律（写在代码里，比写在文档里有用）────────────
// 1. ⛔ 机密闸：正文含 密码 / token / 密钥 / 身份证 / 银行卡 / 手机号 ⇒ 直接拒发，
//    这类判断要写在**调用前**，不能只写在文档里。
// 2. ⛔ 长任务别用它：网页版会超时、会掉登录、会弹验证 —— 它只适合"一问一答"。
// 3. ⛔ 别并发：同一个站点同时开两个页面问答，几乎必然互相串话。
