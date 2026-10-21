# 08 技能系统

`0.22.2+2364.g0b10b9f / <旧位置>\Hermes / skills\（58 个 SKILL.md）、agent\skill_utils.py、prompt_builder.py:1245、.skills_prompt_snapshot.json`

## ① 结论

1. **frontmatter 是"YAML 头 + `metadata.hermes` 命名空间"**，核心字段只有 `name/description/version/author/license/platforms`；真正的路由开关在 `metadata.hermes.{requires_tools,requires_toolsets,fallback_for_*,session_platforms,config}`。
2. **渐进披露是三级**：常驻 = **索引行**（58 条一行一条，只含 name+description）；按需 = `skill_view(name)` 拉正文；再按需 = `skill_view(name, file_path="references/…")` 拉支撑文件。支撑目录固定 4 个：`references/templates/assets/scripts`。
3. **同名冲突靠"tier 优先级 + 遮蔽 + 同级歧义拒绝"**：`project > local > create_dir > external`，低层被高层遮蔽（只警告一次），**同一层出现两个同名则直接报 `Ambiguous skill name`**，不猜。
4. **没有 `allowed-tools` 字段**。技能不带工具权限，工具可用性由 toolset/审批层控制——技能不能给自己提权（这是它的安全取舍）。

## ② 证据

| # | 位置 | 原文（截断） | 说明 |
|---|---|---|---|
| 1 | `skills/apple/apple-notes/SKILL.md:1-10` | `name: apple-notes` / `description: "Manage Apple Notes via memo CLI..."` / `platforms: [macos]` / `metadata: hermes: tags: [...] related_skills: [obsidian]` / `prerequisites: commands: [memo]` | 真实 frontmatter |
| 2 | `agent/skill_utils.py:721` | `_CONDITION_KEYS = ("fallback_for_toolsets","requires_toolsets","fallback_for_tools","requires_tools","session_platforms")` | 条件字段全集 |
| 3 | `agent/skill_utils.py:724-727` | `def extract_skill_conditions(frontmatter)` `absent = []` | 缺省语义 |
| 4 | `agent/skill_utils.py:730-748` | `def extract_skill_config_vars(frontmatter)` `key/description/default/prompt` | 技能自带配置项 |
| 5 | `agent/skill_utils.py:31` | `SKILL_SUPPORT_DIRS = frozenset(("references","templates","assets","scripts"))` | 支撑目录 |
| 6 | `agent/skill_utils.py:24-28` | `EXCLUDED_SKILL_DIRS = frozenset((".git",".archive",".venv","node_modules",...))` | 扫描排除 |
| 7 | `agent/skill_utils.py:36-38` | `never scanned as standalone skills` | 支撑文件不当技能 |
| 8 | `agent/skill_utils.py:389` | `TIER_PROJECT, TIER_LOCAL, TIER_CREATE_DIR, TIER_EXTERNAL = range(4)` | 四级优先级 |
| 9 | `agent/skill_utils.py:393` | `AMBIGUOUS_SKILL_PREFIX = "Ambiguous skill name "` | 同级歧义拒绝 |
| 10 | `agent/skill_utils.py:462` | `or shadowed (a higher tier owns the name: hidden, warned once)` | 遮蔽语义 |
| 11 | `agent/skill_utils.py:420` | `would let <root>/evil (name: github) shadow the real one` | 遮蔽攻击面 |
| 12 | `agent/prompt_builder.py:1249-1255` | `Compact skill index for the system prompt` `Same-named skills resolve like skill_view: project > local > create_dir > external_dirs` | 索引解析规则 |
| 13 | `agent/prompt_builder.py:1253` | `compact_categories (coding posture) demotes categories to a names-only line — nothing is ever hidden` | 模式限制 = 降级不隐藏 |
| 14 | `agent/system_prompt.py:301-314` | `def _skills_prompt(agent)` `empty without skills tools` | 无技能工具则索引为空 |
| 15 | `agent/system_prompt.py:783-784` | `Skills are runtime-mutable, so the index leads the volatile band` | 索引放 volatile 首位 |
| 16 | `.skills_prompt_snapshot.json:1` | `{"version": 4, "manifest": {"apple\\apple-notes\\SKILL.md": [mtime, size, inode, ctime], ...}, "skills": [...], "category_descriptions": {...}}` | 索引快照 + 文件签名 |
| 17 | `.skills_prompt_snapshot.json` skills[0] | `"conditions": {"fallback_for_toolsets": [], "requires_toolsets": [], ...}, "requires_apps": []` | 快照条目 |
| 18 | `agent/skill_utils.py:89-104` | `def skill_matches_platform_list(platforms)` | 平台过滤 |
| 19 | `agent/skill_utils.py:162` | `def skill_matches_environment(frontmatter)` | 环境过滤（kanban/docker 探测） |
| 20 | `agent/skill_utils.py:172` | `def skill_matches_apps(frontmatter)` | 依赖 app 是否存在 |
| 21 | `agent/skill_utils.py:266` | `def get_disabled_skill_names(platform)` | 按平台禁用的技能 |
| 22 | `agent/prompt_builder.py:317-331` | `_auto_load_parts` `resolved once per agent lifecycle ... so the prompt stays byte-stable` | 钉住技能只解析一次 |
| 23 | `agent/context_compressor.py:852-862` | `[SKILL_PRUNED: content lost in compression; reload with skill_view(name='X')]` | 技能正文被摘后的指针 |
| 24 | `agent/skill_bundles.py`（存在） | 技能包（bundle）机制 | 一组技能一起装 |

## ③ 契约

```yaml
# SKILL.md frontmatter（实测字段，全部可选除 name/description）
name: string                    # 唯一名，冲突按 tier 解析
description: string             # 索引行里唯一展示的文本，决定"要不要点开"
version: semver
author: string
license: string
platforms: [macos|linux|windows]     # 不匹配 → 不进索引
prerequisites:
  commands: [binary]                 # 缺命令 → 不推荐（软过滤）
metadata:
  hermes:
    tags: [..]
    related_skills: [..]
    # —— 路由条件（5 个键）——
    requires_tools: [tool_name]              # 缺工具则不出现
    requires_toolsets: [toolset]
    fallback_for_tools: [tool_name]          # 该工具存在时反而降权（"备胎"技能）
    fallback_for_toolsets: [toolset]
    session_platforms: [cli|telegram|desktop]  # 只在这些前端出现
    config:                                  # 技能自带配置项（key/description/default/prompt）
      - {key: api_endpoint, description: ..., default: ...}
```

**渐进披露的三次读**

| 级 | 内容 | 何时进上下文 | 成本 |
|---|---|---|---|
| 0 索引 | `- name: description`（58 行） | 每轮常驻（在 volatile 首位） | ~1.5K token |
| 1 正文 | `skill_view(name)` 返回 SKILL.md | 模型主动调用 | 2–4K token/次 |
| 2 支撑 | `skill_view(name, file_path="references/x.md")` | 再主动调用 | 任意 |

**索引缓存**：`.skills_prompt_snapshot.json` 存 `(mtime, size, inode, ctime)` 的 manifest，文件签名不变就复用整段索引字符串 → 索引字节稳定 → 提示词缓存不被技能改动打穿。

**冲突处理矩阵**

| 情形 | 行为 |
|---|---|
| 同名，不同 tier | 高 tier 胜，低 tier `status="shadowed"`，**只警告一次**（`_SHADOW_CHECKED` 去重） |
| 同名，同 tier | `Ambiguous skill name`，**拒绝加载**（不猜、不按路径字母序） |
| 同名但内容不同（可能是劫持） | 身份检查对两个 SKILL.md 都做 hash 比对，再判遮蔽 |
| 在 `.git`/`node_modules` 里 | 直接排除，不扫 |
| 模式不同（coding posture） | **降级为"只有名字"一行，绝不隐藏** |

## ④ 对 DSH 的适配

| 项 | 内容 |
|---|---|
| DSH 现状 | **有**（frontmatter + 每轮目录注入 + 渐进披露），这是 DSH 最接近 Hermes 的一块。 |
| 缺口 | ①**没有路由条件**：技能只能"按名字被想起"，不能声明"有 X 工具时才出现"/"有更好工具时让位"；②**没有冲突策略**：同名技能谁赢不确定；③**没有索引快照**：每轮可能重新扫目录，索引字节抖动导致缓存失效。 |
| 落点 | 引擎：`packages/engine/src/skills/`（`conditions.ts` + `resolve.ts` + `snapshot.ts`）。`resolve.ts` 就是 tier 优先级 + 歧义拒绝。 |
| 成本 | **S–M**。条件过滤 S（纯函数），快照 S（存 JSON 签名），tier 解析 M（要定 DSH 自己的 tier 顺序）。 |
| 失败模式 | ⚠️ **抄 `fallback_for_tools` 抄反** → 它表示"当这个工具**存在**时，本技能让位"（备胎语义），抄成"需要这个工具"会让技能永远不出现。⚠️ **同级歧义时按路径排序取第一** → 这就是 `skill_utils.py:420` 写的劫持路径（`<root>/evil` 抢名）。⚠️ **coding 模式直接隐藏非编码技能** → 模型会以为技能不存在；Hermes 的选择是"只留名字"（`prompt_builder.py:1253`）。⚠️ 每轮重扫目录 → 索引里只要有一行 description 变了，整段 volatile 前缀就重算。 |

## ⑤ 实证 / 推断分界

| 判定 | 条 | 依据 / 如何验证 |
|---|---|---|
| 【实证】 | `metadata.hermes` 5 个条件键、4 个 tier 优先级、同级歧义拒绝、签名四元组 (mtime,size,inode,ctime) | `prompt_builder.py:1245-1270` + `.skills_prompt_snapshot.json` 实体文件 |
| 【实证】 | 索引快照是磁盘文件，可跨进程复用 | 文件存在且含签名 |
| 【推断】 | 四元组比单看 mtime 更可靠 | 机制推断（mtime 精度 / inode 复用）。**验证**：touch 文件但内容不变，看是否重算 |
| 【推断】 | DSH 技能索引未缓存 | 任务书未明说；由“技能已存在但无快照机制”推断。**验证**：找 DSH 是否有同类 snapshot |
| 【未验证】 | 4 个 tier 的冲突解决顺序实测 | 只读到枚举与比较逻辑，未构造冲突用例 |
