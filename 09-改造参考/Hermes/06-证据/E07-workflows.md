# 证据 E07 — 工作流

`0.22.2 / hermes_cli\kanban_workflow.py, goals.py, kanban_db.py, agent\moa_loop.py`

| # | 路径:行 | 原文（≤40 字） | 说明 |
|---|---|---|---|
| E07-01 | hermes_cli/kanban_workflow.py:116 | `Column("triage", "Triage", "◇"),` | 8 列定义起点 |
| E07-02 | hermes_cli/kanban_workflow.py:120 | `Column("running", "Running", "●", drag_target=False),` | running 只能内核进 |
| E07-03 | hermes_cli/kanban_workflow.py:129 | `"ready": ("triage", "todo", "scheduled", "blocked", "review", "done"),` | 手动迁移矩阵 |
| E07-04 | hermes_cli/kanban_workflow.py:142 | `DEFAULT_STATUSES = frozenset(DEFAULT_WORKFLOW.keys()) \| {ARCHIVED}` | 状态全集 |
| E07-05 | hermes_cli/kanban_workflow.py:67 | `Allowed != guaranteed: verbs still apply their own gates` | 迁移不等于成功 |
| E07-06 | hermes_cli/kanban_workflow.py:16 | `Kernel semantics are deliberately NOT modelled here` | 只建模 UI 层 |
| E07-07 | kanban.db DDL tasks | `the dispatcher doesn't consult them for routing yet` | 模板字段未启用 |
| E07-08 | hermes_cli/goals.py:32 | `DEFAULT_MAX_TURNS = 20` | 目标循环上限 |
| E07-09 | hermes_cli/goals.py:1641 | `Drive a kanban worker through a Ralph-style goal loop.` | 循环形状 |
| E07-10 | hermes_cli/goals.py:47 | `deterministic shell commands that must pass before the judge may declare DONE` | 质量闸前置 |
| E07-11 | hermes_cli/goals.py:48 | `its output IS the continuation prompt` | 闸失败即续跑指令 |
| E07-12 | hermes_cli/goals.py:50 | `DEFAULT_GATE_TIMEOUT_SECONDS = 300` | 闸超时 |
| E07-13 | hermes_cli/goals.py:121 | `DONE requires the deliverable to actually exist.` | DONE 的定义 |
| E07-14 | hermes_cli/goals.py:156 | `Picking WAIT parks the loop without burning a turn` | WAIT 不烧 turn |
| E07-15 | hermes_cli/goals.py:45 | `DEFAULT_MAX_CONSECUTIVE_TRANSPORT_FAILURES = 5` | 判官熔断 |
| E07-16 | agent/moa_loop.py:4 | `gathers reference-model context before each model iteration` | 扇出时机 |
| E07-17 | agent/moa_loop.py:852 | `Render numbered reference blocks for the aggregator` | 汇总形状 |
| E07-18 | agent/moa_loop.py:885 | `(advisor outputs for the aggregator, degraded notice, all_failed)` | 三态返回 |
| E07-19 | agent/moa_loop.py:161 | `Cost is priced at the advisor's OWN rate` | 扇出计费 |
| E07-20 | agent/review_engine.py:2 | `/review spawns an independent, full-privilege background subagent` | 单票评审 |

复核：`grep -n "DONE\|WAIT\|quality_gates\|_MAX_BARRIER" hermes_cli/goals.py | head -20`
