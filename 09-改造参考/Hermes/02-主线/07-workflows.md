# 07 工作流

`0.22.2+2364.g0b10b9f / <旧位置>\Hermes / hermes_cli\kanban_workflow.py、goals.py、kanban_db.py、agent\moa_loop.py`

## ① 结论

1. **没有通用 DAG 工作流引擎**（没有 meta/phase/yaml 编排）。等价能力由三套正交机制拼成：**kanban**（任务图：列 + 依赖 + 步骤键）、**goals**（Ralph 式目标循环：判官 + 质量闸）、**MoA**（并行扇出 + 汇总 + 降级）。
2. **kanban 的 `workflow_template_id` / `current_step_key` 是"已建表未启用"**：DDL 注释明说 v1 只写不读、dispatcher 不据此路由。所以"phase 定义"目前等价物是 **8 个看板列 + 手动迁移矩阵**。
3. **对抗式验证没有 N 票制**。最接近的是：①`/review` 起一个独立全权限子代理给结论（1 票）；②goal loop 的辅助判官给 `done / blocked / continue / wait` **四值**（1 票，此前误记为三值），且**判官不能凭感觉判 done —— 必须先过确定性质量闸（shell 命令）**。

## ② 证据

### 看板 = 状态机 + 迁移矩阵

| # | 位置 | 原文（截断） |
|---|---|---|
| 1 | `hermes_cli/kanban_workflow.py:114-124` | `Column("triage","Triage","◇"), ("todo","Todo","◻"), ("scheduled",...,"⏱",drag_target=False), ("ready",...), ("running",...,drag_target=False), ("blocked",...), ("review",...,drag_target=False), ("done","Done","✓")` |
| 2 | `hermes_cli/kanban_workflow.py:125-137` | `"ready": ("triage","todo","scheduled","blocked","review","done")` … `"archived": ("triage","todo","ready")` |
| 3 | `hermes_cli/kanban_workflow.py:142` | `DEFAULT_STATUSES = frozenset(DEFAULT_WORKFLOW.keys()) \| {ARCHIVED}` |
| 4 | `hermes_cli/kanban_workflow.py:64-70` | `def can_move(self, src, dst)` `Allowed != guaranteed: verbs still apply their own gates` |
| 5 | `hermes_cli/kanban_workflow.py:16-19` | `Kernel semantics are deliberately NOT modelled here` |
| 6 | `kanban.db` DDL `tasks` | `workflow_template_id TEXT` `In v1 the kernel writes these ... the dispatcher doesn't consult them for routing yet` |
| 7 | `kanban.db` DDL `tasks` | `block_kind`, `block_recurrences`, `consecutive_failures`, `max_retries`, `completion_contract` |

### 目标循环（Ralph）+ 质量闸

| # | 位置 | 原文（截断） |
|---|---|---|
| 8 | `hermes_cli/goals.py:32` | `DEFAULT_MAX_TURNS = 20` |
| 9 | `hermes_cli/goals.py:1630-1646` | `Drive a kanban worker through a Ralph-style goal loop` `A WAIT verdict is treated as CONTINUE` |
| 10 | `hermes_cli/goals.py:46-49` | `Quality gates: deterministic shell commands that must pass before the judge may declare DONE. A failed gate short-circuits the judge — its output IS the continuation prompt` |
| 11 | `hermes_cli/goals.py:50-51` | `DEFAULT_GATE_TIMEOUT_SECONDS = 300` `DEFAULT_GATE_MAX_RETRIES = 3` |
| 12 | `hermes_cli/goals.py:118-123` | `DONE — the goal is fully satisfied` `DONE requires the deliverable to actually exist` |
| 13 | `hermes_cli/goals.py:139-157` | `WAIT — ... wait for async` `Picking WAIT parks the loop without burning a turn` |
| 14 | `hermes_cli/goals.py:44-45` | `DEFAULT_MAX_CONSECUTIVE_TRANSPORT_FAILURES = 5` |
| 15 | `hermes_cli/goals.py:55` | `_MAX_BARRIER_WAIT_S = 30 * 60` |
| 16 | `kanban.db` DDL `tasks` | `goal_mode INTEGER NOT NULL DEFAULT 0` `goal_max_turns` |

### 并行扇出 / 汇总 / 降级

| # | 位置 | 原文（截断） |
|---|---|---|
| 17 | `agent/moa_loop.py:1-4` | `Mixture-of-Agents runtime helpers for /moa turns` `gathers reference-model context before each model iteration` |
| 18 | `agent/moa_loop.py:497` | `Reference models may have a smaller context window than the aggregator` |
| 19 | `agent/moa_loop.py:852` | `Render numbered reference blocks for the aggregator, appending any degraded notice` |
| 20 | `agent/moa_loop.py:885-886` | `(advisor outputs for the aggregator, degraded notice, all_failed)` `Failed refs are filtered out first` |
| 21 | `agent/moa_loop.py:160-161` | `Cost is priced at the advisor's OWN rate and summed in dollars` |
| 22 | `tools/delegate_tool_config.py:93-97` | `max_concurrent_children > ... > 10` |
| 23 | `agent/review_engine.py:1-6` | `/review spawns an independent, full-privilege background subagent` `its result re-enters the spawning session` |
| 24 | `agent/review_engine.py:21-22` | `DEFAULT_CONTEXT_MESSAGES = 10` |
| 25 | `agent/verification_stop.py:1-3` | `turns the passive verification ledger into a bounded follow-up when the model tries to finish right after editing code without fresh evidence` |

## ③ 契约

**A. 看板任务图（真正的"工作流"承载物）**

```
tasks: id, title, body, assignee, status(8 列), priority, workspace_kind(scratch|worktree|dir),
       workspace_path, branch_name, project_id,
       claim_lock, claim_expires, worker_pid, worker_started_at,     ← 抢锁/防 PID 复用
       consecutive_failures, max_retries, last_failure_error,        ← 熔断
       block_kind(dependency|needs_input|capability|transient), block_recurrences,
       completion_contract,                                          ← 完成契约（文本）
       goal_mode, goal_max_turns, skills(JSON), model_override, provider_override, reasoning_effort,
       session_id, idempotency_key, current_run_id, workflow_template_id(未启用), current_step_key(未启用)
task_links: (parent_id, child_id)                                     ← 依赖图
task_runs:  status(running|done|blocked|crashed|timed_out|failed|released), outcome(completed|blocked|crashed|timed_out|spawn_failed|gave_up|reclaimed)
task_events:(task_id, run_id, kind, payload)                          ← 进度/审计流
```

**B. 目标循环的判定顺序（可直接照搬）**

```python
while turns_used < max_turns:
    if task_terminal(): break                         # 已 complete / block / 提交评审
    if gate := quality_gates():                       # 确定性 shell 命令
        if gate.failed:
            nudge = gate.output_tail[:3000]           # 闸失败 → 直接当作续跑指令
            continue
    v = judge(goal=title+body, response=last)         # 四值：done|blocked|continue|wait
    if v == "done":     finalize(); break
    if v == "blocked":  block_task(reason=v.reason)    # 第 4 个判定，此前漏记
    if v == "wait":     park_until(pid_exit | session_exit | deadline)  # 不烧 turn
    if v == "continue": last = run_turn(continuation_prompt)
```

`wait` 有 3 种载荷：`wait_on_session`（进程退出**或** watch_pattern 命中即释放）/ `wait_on_pid`（只在退出时释放）/ `wait_for_seconds`（委托子代理未回时用，取值 600–1800）。

**C. 超时与重试**

| 层 | 超时 | 重试 |
|---|---|---|
| 目标循环 | `max_turns=20`；barrier 最长 30 min | 判官 401/超时连续 5 次 → 自动暂停 |
| 质量闸 | 300 s | 3 次 |
| 子代理 | 默认**无**墙钟上限（只测无进展） | 由子代理自己重试 |
| bot 投递 | 单次 600 s | 2 次（首次 + 1 次瞬态重试） |
| MoA advisor | 每个 advisor 独立 timeout | 失败的 advisor 被过滤，不重试 |

**D. 最后一步失败的降级**

- MoA：`all_failed=True` → 不给聚合器任何参考，附 `degraded_notice`（loud 策略默认吵），**仍然产出聚合结果**而不是抛错。
- 目标循环：`max_turns` 用尽 → 返回 `{"outcome": ..., "turns_used", "reason"}`，任务**停在原列**（不假装成功）。
- `/review`：子代理失败 → 以 `async_delegation` 失败事件回到父会话，作为一条新消息。

## ④ 对 DSH 的适配

| 项 | 内容 |
|---|---|
| DSH 现状 | **有**（工作流），但 DSH 的工作流是"预先编排"的；Hermes 这套是"事后可恢复的任务图"。DSH **没有**跨会话任务实体（这是已知缺口）。 |
| 缺口 | ①DSH 工作流一旦失败，中间产物与进度不落库，重跑从零；②没有"完成契约"这一层——任务完成靠模型自称；③没有质量闸，模型说"我做完了"就是做完了。 |
| 落点 | 引擎：`packages/engine/src/task/graph.ts`（复用 kanban 的字段集）+ `task/gate.ts`（质量闸）；把 DSH 工作流的每个 phase 落成一行 task。 |
| 成本 | **L**（任务图 L，质量闸 S，判官复用现有 LLM 调用 M）。 |
| 失败模式 | ⚠️ **照抄 workflow_template_id 并以为能用** → 它在 Hermes 里是死字段；DSH 要么真实现，要么别抄这个字段。⚠️ **判官给 DONE 的权限太大** → 没有质量闸兜底时，判官会被"看起来很完整"的回复骗过；Hermes 的顺序是"闸先于判官"（`goals.py:47-49`），不能反。⚠️ **WAIT 当成 CONTINUE** → 会空转烧 turn（Hermes 反过来：WAIT 不烧 turn，但要能真 park）。⚠️ **扇出并发直接抄 10** → 每次扇出 10 个全量上下文的子代理，token 成本线性乘 10，Hermes 在 config 里专门写了警告。 |

## ⑤ 实证 / 推断分界

| 判定 | 条 | 依据 / 如何验证 |
|---|---|---|
| 【实证】 | kanban 8 列 + 手动迁移矩阵、`task_links`、goal loop 三值判定、质量闸先于判官 | `kanban_workflow.py:1-143`、`goals.py` 原文 |
| 【实证】 | `workflow_template_id` / `current_step_key` 只写不读 | 全仓只有写入与 schema 声明，无 dispatcher 读取点（穷举范围：`hermes_cli/` + `tools/`） |
| 【实证】 | 无 N 票制对抗验证 | 只找到单一判官路径 |
| 【推断】 | MoA 的 `degraded_notice` 表示扇出会降级 | 由字段名推断语义，未读到触发阈值原文。**验证**：grep 该字段赋值点 |
| 【推断】 | DSH 无质量闸 | 任务书自述。**验证**：查完成路径是否有 exit code 判断 |
