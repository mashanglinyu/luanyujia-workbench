# 证据 E04 — 记忆分层

`0.22.2 / tools\memory_tool*.py, agent\memory_*.py, agent\system_prompt.py, config.yaml`

| # | 路径:行 | 原文（≤40 字） | 说明 |
|---|---|---|---|
| E04-01 | agent/system_prompt.py:6 | `volatile (skills index, memory, USER.md, external memory` | 记忆在 volatile |
| E04-02 | agent/prompt_builder.py:1542 | `SOUL.md from HERMES_HOME (identity slot #1), or None.` | 身份槽 1 |
| E04-03 | agent/context_file_sources.py:90 | `soul_path = home / "SOUL.md"` | 路径 |
| E04-04 | tools/memory_tool_store.py:301 | `return memory_tool.get_memory_dir() / ("USER.md" if target == "user" else "MEMORY.md")` | 两文件 |
| E04-05 | tools/memory_tool_store.py:25 | `ENTRY_DELIMITER = "\n§\n"` | 条目分隔 |
| E04-06 | tools/memory_tool_store.py:186 | `def __init__(self, memory_char_limit: int = 2200, user_char_limit: int = 1375` | 上限 |
| E04-07 | config.yaml:735 | `memory_char_limit: 2200   # ~800 tokens` | 上限注释 |
| E04-08 | tools/memory_tool_store.py:250 | `further additions are blocked until it is back under the limit` | 超限拒写 |
| E04-09 | tools/memory_tool_store.py:325 | `_error(message, "over_budget", current_entries=...` | 拒绝码 |
| E04-10 | tools/memory_tool_store.py:334 | `No operations were applied (batch is all-or-nothing).` | 批量原子 |
| E04-11 | tools/memory_tool_store.py:230 | `findings = scan_for_threats(entry, scope="strict")` | 载入期扫描 |
| E04-12 | tools/memory_tool_store.py:234 | `[BLOCKED: {filename} entry contained threat pattern(s)` | 占位形态 |
| E04-13 | tools/memory_tool.py:108 | `"add": (lambda store, target, content, old_text, entry=None` | 写动作表 |
| E04-14 | agent/prompt_builder.py:225 | `not instructions to yourself` | 声明式约束 |
| E04-15 | agent/prompt_builder.py:227 | `imperative phrasing gets re-read as` | 为什么禁祈使句 |
| E04-16 | agent/prompt_builder.py:213 | `record it in the skill you used or built` | 技能优先于记忆 |
| E04-17 | config.yaml:740 | `nudge_interval: 10        # Nudge every 10 user turns` | 蒸馏节奏 |
| E04-18 | agent/memory_context.py:179 | `"<memory-context>\n"` | 外部回忆围栏 |
| E04-19 | agent/memory_manager.py:4 | `only ONE external plugin provider may be registered at a time` | provider 单例 |
| E04-20 | agent/memory_caller_scope.py:2 | `a caller that names no profile is refused` | 作用域隔离 |

复核：`grep -n "char_limit\|over_budget\|scan_for_threats" tools/memory_tool_store.py`
