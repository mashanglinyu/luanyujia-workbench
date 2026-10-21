# 05 提示词拼装

`0.22.2+2364.g0b10b9f / <旧位置>\Hermes / agent\system_prompt.py、prompt_builder.py、prompt_cach*.py`

## ① 结论

1. **不是"片段目录 + 模板引擎"，而是"Python 函数拼接 + 三档 tier 分区"**。没有 handlebars/jinja 式变量与 include，片段是常量字符串 + 运行期函数，顺序由代码显式 append 决定。
2. **整个提示词只为两件事服务：缓存前缀稳定、以及"每轮变的东西排在最后"**。tier 顺序 `stable → context → volatile`，用 `\n\n` 连接；`stable` 每 session 只构建一次（压缩后才重建）。
3. **技能索引被刻意放在 volatile 的**第一位**：因为技能是运行期可变的（模型能自己写技能），放最前面可以让"索引没变"时仍落在复用的前缀里，变了只从这一点开始重算。

## ② 证据

| # | 位置 | 原文（截断） | 说明 |
|---|---|---|---|
| 1 | `agent/system_prompt.py:1-8` | `Three tiers are joined with "\n\n": stable (identity, guidance, env hints, coding brief, platform hints), context (...), volatile (skills index, memory, USER.md, ...)` | 三档定义 |
| 2 | `agent/system_prompt.py:736` | `def build_system_prompt_parts(agent, system_message=None) -> dict[str, str]:` | 唯一入口 |
| 3 | `agent/system_prompt.py:743` | `Never re-rendered mid-session.` | 稳定性契约 |
| 4 | `agent/system_prompt.py:748` | `stable_parts, _soul_loaded = _identity_parts(agent, _ctx_len)` | 身份在 stable 首位 |
| 5 | `agent/system_prompt.py:752-753` | `_help_guidance_slot = len(stable_parts)` `stable_parts.append(HERMES_AGENT_HELP_GUIDANCE_NO_SKILLS)` | 先占位后回填（变体选择） |
| 6 | `agent/system_prompt.py:758-759` | `if "skill_view" in agent.valid_tool_names and "- hermes-agent:" in skills_prompt:` | 占位回填条件 |
| 7 | `agent/system_prompt.py:762` | `stable_parts.extend(_auto_load_parts(agent))` | 钉住的技能进 stable |
| 8 | `agent/system_prompt.py:773-775` | `if system_message is not None: context_parts.append(system_message)` `context_parts.extend(_context_files_part(...))` | 调用方 system 进 context |
| 9 | `agent/system_prompt.py:782-785` | `volatile tier ... [skills_prompt, *_memory_parts(agent)]` | 顺序 |
| 10 | `agent/system_prompt.py:788` | `_plugin_section_blocks(_frozen_plugin_prompt_sections(agent), "after_memory")` | 插件段落有固定锚点 |
| 11 | `agent/system_prompt.py:791-792` | `_active_profile_line(agent)` / `_timestamp_line(agent)` | 每轮变的最靠后 |
| 12 | `agent/system_prompt.py:795-798` | `RUNTIME_ENVIRONMENT_HEADING ... volatile_parts.append(...)` | 运行时环境块在 volatile 尾部 |
| 13 | `agent/system_prompt.py:802-811` | `def build_system_prompt(...)` `Only rebuilt after compression` | 重建时机 |
| 14 | `agent/system_prompt.py:814` | `def invalidate_system_prompt(agent)` `Force a rebuild on the next turn (after compression)` | 失效钩子 |
| 15 | `agent/prompt_caching.py:1-4` | `Default layout: 4 cache_control breakpoints — the static system prefix, the end of the system prompt, and the last 2 non-system messages` | 断点布局 |
| 16 | `agent/prompt_cache_boundary.py:1-6` | `Builder-declared stable prefixes ... Only the builder knows where the tail begins` | 手工声明稳定前缀 |
| 17 | `agent/system_prompt.py:807` | `agent._cached_system_prompt_static = parts["stable"]` | 单独缓存 static 部分 |
| 18 | `agent/conversation_loop.py:1204` | `def _ensure_cached_system_prompt_static(agent, system_message=None)` | 每轮校验 static 未漂移 |
| 19 | `agent/prompt_builder.py:1045` | `CONTEXT_FILE_MAX_CHARS = 20_000` | 上下文文件上限 |
| 20 | `agent/prompt_builder.py:1051-1052` | `_CONTEXT_FILE_WINDOW_FRACTION = 0.06` / `_CONTEXT_FILE_DYNAMIC_CEILING = 500_000` | 随窗口放大 |
| 21 | `agent/prompt_builder.py:83` | `def _scan_context_content(content, filename, *, user_authored=False) -> str:` | 上下文文件先扫描后拼接 |
| 22 | `agent/prompt_builder.py:36-40` | `Default read deadline for context files ... 5.0` `network-backed filesystems ... block a cold read indefinitely` | 读超时防启动卡死 |
| 23 | `agent/prompt_builder.py:159` | `DEFAULT_AGENT_IDENTITY = (` | 身份兜底串 |
| 24 | `agent/prompt_builder.py:365` | `TOOL_USE_ENFORCEMENT_MODELS = ("gpt","codex","gemini",...` | 按模型插不同 guidance |
| 25 | `agent/prompt_builder.py:565-569` | `STEER_MARKER_OPEN` / `[/OUT-OF-BAND USER MESSAGE]` | 带外消息也用固定定界符 |
| 26 | `agent/system_prompt.py:742` | `Worktree-dependent blocks follow project context so a shared context file can remain in the longest common prefix` | 缓存友好的排序理由 |

## ③ 契约

```ts
buildSystemPrompt(agent, systemMessage?): { stable: string, context: string, volatile: string }

stable = [
  identity(SoulMd),          // 身份槽 #1
  helpGuidance,              // 占位，稍后按 skills 索引决定变体
  guidance(agent),           // 各 posture 的 operating brief
  autoLoadSkills,            // 钉住的技能正文
  codingPrefix,              // 编码姿态前言
].join("\n\n")

context = [
  systemMessage,             // 调用方注入（不进缓存前缀）
  contextFiles,              // 05-协作与规矩/一-全局铁律.md / .hermes.md / SOUL.md，先扫描
  workspaceSnapshot,         // cwd / git / worktree
].join("\n\n")

volatile = [
  skillsIndex,               // 运行期可变，放 volatile 之首
  memoryBlock,               // MEMORY.md
  userProfile,               // USER.md
  pluginSections,            // 锚点 after_memory
  activeProfileLine,
  timestampLine,             // 每轮必变
  runtimeEnvironment,        // 定界符 `# Hermes runtime environment` / `<!-- End ... -->`
].join("\n\n")

full = [stable, context, volatile].filter(Boolean).join("\n\n")
```

**"按模式 include 的差异"实际是三个开关**：①`posture`（coding / 通用）决定 `_CODING_TOOLS` 与 operating brief；②`platform` 决定 `PLATFORM_HINTS`（telegram 富文本、WSL 提示…）；③`model` 决定 `TOOL_USE_ENFORCEMENT_GUIDANCE` / `GOOGLE_MODEL_OPERATIONAL_GUIDANCE` 是否插入。

**缓存稳定性规则（可直接照搬）**

| 规则 | 原因 |
|---|---|
| 每轮必变的东西（时间戳、profile、环境）放**最后** | 前缀复用 |
| 可变索引（技能）放 volatile **首位** | 索引不变时仍可复用 |
| 首次构建后缓存，只在压缩/失效时重建 | 见 `system_prompt.py:802` |
| 工具 schema 也参与缓存（`strip_anthropic_tool_cache_control`） | 工具列表变动同样打穿前缀 |
| 稳定前缀由 builder **显式声明**，不靠 marker 正则反解 | `prompt_cache_boundary.py:1-6`：marker 可能出现在正常正文里 |

## ④ 对 DSH 的适配

| 项 | 内容 |
|---|---|
| DSH 现状 | **有**（每轮目录注入 + 渐进披露）。但 DSH 的提示词组织是"技能/记忆/交接/待办/通知/健康/压力"七块**平铺**，没有 tier 分区与稳定性契约；压缩只有一档，所以每次压缩都全量重建。 |
| 缺口 | ①没有"哪块每轮变"的显式声明，导致缓存命中率靠运气；②没有 `stable` 的单独缓存与漂移校验（Hermes 的 `_cached_system_prompt_static` + `_stored_prompt_matches_runtime`）；③上下文文件读取无超时，OneDrive/NFS 上会卡死启动。 |
| 落点 | 引擎：`packages/engine/src/prompt/tiers.ts`（纯函数，输入 agent 状态输出三字符串）；外壳：设置页展示"本会话提示词 tier 分布 + 命中缓存的前缀长度"。 |
| 成本 | **M**。分区本身是纯重构 S，但要把七块注入重排到三个 tier 且保证语义不变，需要一次全量回归。 |
| 失败模式 | ⚠️ 把易变块（待办/健康/压力）放进 stable → 每轮缓存全失，账单涨 20–40%；Hermes 用"volatile 尾部"正是为这个。⚠️ 反过来说，把**技能索引**放 volatile 尾部 → 索引一变就连带后面全重算，Hermes 特意放 volatile 首位。⚠️ 用 marker 字符串反解稳定前缀 ✅ 会误判（技能正文里也可能出现同样 marker），必须 builder 自己声明。 |

## ⑤ 实证 / 推断分界

| 判定 | 条 | 依据 / 如何验证 |
|---|---|---|
| 【实证】 | 三 tier 顺序、`\n\n` 连接、技能索引在 volatile 首位、`CONTROL_FRAME_OPENERS` 防伪造、上下文文件上限 | `system_prompt.py:736-826`、`prompt_builder.py:565-600,1045-1063,1245-1270` 原文 |
| 【实证】 | builder 显式声明稳定前缀，不靠 marker 反解 | stable tier 是函数的独立返回项，不是切出来的 |
| 【推断】 | 稳定前缀能显著提升 cache 命中 | 通用机制，非 Hermes 实测。**验证**：连续两轮算 stable tier sha256 是否相等，再比账单 cache_read 占比 |
| 【推断】 | DSH 拼装顺序不稳定 | 任务书只说“每轮记忆注入”，未说顺序问题。**验证**：抓两轮 system prompt 做 diff，看变化是否只落在尾部 |
| 【未验证】 | DSH 用哪家厂商、最小可缓存前缀多少 token | 决定 stable 段要多大才有收益；需产品确认模型供应商 |
