# 证据 E06 — 子代理与多智能体

`0.22.2 / tools\delegate_tool*.py, agent\subagent_lifecycle.py, tools\async_delegation*.py`

| # | 路径:行 | 原文（≤40 字） | 说明 |
|---|---|---|---|
| E06-01 | agent/subagent_lifecycle.py:23 | `_MAX_GOAL_CHARS = 16_000` | goal 上限 |
| E06-02 | agent/subagent_lifecycle.py:24 | `_MAX_CONTEXT_CHARS = 32_000` | context 上限 |
| E06-03 | agent/subagent_lifecycle.py:26 | `_MAX_RESULT_CHARS = 32_000` | 返回上限 |
| E06-04 | agent/subagent_lifecycle.py:27 | `_TERMINAL_RETENTION_SECONDS = 3_600` | 终态保留 1h |
| E06-05 | agent/subagent_lifecycle.py:36 | `class SubagentState(str, enum.Enum):` | 状态机起点 |
| E06-06 | agent/subagent_lifecycle.py:225 | `role must be 'leaf' or 'orchestrator'.` | 角色校验 |
| E06-07 | tools/delegate_tool.py:234 | `effective_role = "orchestrator" if _get_orchestrator_enabled() and child_depth < max_spawn else "leaf"` | 深度推导 |
| E06-08 | tools/delegate_tool.py:230 | `The `role` arg is ignored.` | 入参被忽略 |
| E06-09 | tools/delegate_tool_config.py:21 | `MAX_DEPTH = 1  # flat by default` | 默认扁平 |
| E06-10 | tools/delegate_tool_config.py:153 | `Default 1 is flat. Each extra level multiplies API cost.` | 成本警告 |
| E06-11 | tools/delegate_tool_config.py:94 | `delegation.max_concurrent_children > ... > 10` | 并发默认 10 |
| E06-12 | tools/delegate_tool_config.py:141 | `Failures should come from what the child does (API/tool errors, iteration budget), not a stopwatch` | 无墙钟超时 |
| E06-13 | tools/delegate_tool_config.py:166 | `False forces every child to leaf` | 一键降平 |
| E06-14 | tools/delegate_tool_config.py:177 | `Whether narrowed child toolsets should keep the parent's MCP toolsets.` | 工具子集继承 |
| E06-15 | state.db 表 async_delegations | `delegation_id, state, result_json, delivery_state, delivery_attempts, owner_pid` | 后台台账 |
| E06-16 | tools/delegation_redaction.py:3 | `Child output is scrubbed before it is shortened` | 只脱敏 |
| E06-17 | agent/tool_dispatch_helpers.py:484 | `_UNTRUSTED_TOOL_NAMES = frozenset({"web_extract", "web_search"})` | 不含 delegate |
| E06-18 | tools/bot_relay.py:5 | `no network; the Desktop owns every socket` | 协作靠文件 |
| E06-19 | tools/bot_relay.py:44 | `TURN_ATTEMPT_TIMEOUT_SECONDS = 600` | 投递预算 |

复核：`grep -rn "max_spawn_depth\|_MAX_RESULT_CHARS\|SubagentState" tools/ agent/`
