# 10 任务与会话模型

`0.22.2+2364.g0b10b9f / <旧位置>\Hermes / kanban.db（tasks/task_runs/task_events）、state.db（sessions/messages）、hermes_cli\kanban_*.py`

## ① 结论

1. **"任务"和"会话"是两个独立实体，且方向是「任务指向会话」**：`tasks.session_id` 是**发起会话**（`kanban_db.py:655` 注释 `originating HERMES_SESSION_ID; NULL from CLI/dashboard`），可空、**非唯一索引**（`idx_tasks_session_id` unique=false）。所以一个会话可以派多个任务，任务也可以完全没有会话（CLI/看板创建）。**任务才是主实体，会话只是来源标注**。一个任务可被多个 run 反复执行，但 `task_runs` **没有** `session_id`——run 绑定的是 `profile`（工作身份），不是会话（`task_runs` DDL）。
2. **任务是"可被外部进程抢的可执行对象"**：`claim_lock`（含 host 前缀）+ `claim_expires`（默认 15 min）+ `worker_pid`/`worker_started_at`（重启稳定指纹，防 PID 复用误杀）。心跳靠 `_touch_activity` 从"正常 API 流量"里顺带刷新，不是单独定时器。
3. **熔断是双轨的**：`consecutive_failures`（派发失败/超时/崩溃，成功才清零）与 `block_recurrences`（同一原因 block→unblock→再 block 的次数 ≥2 就改道 `triage`）。**unblock 不清零**，因为"unblock 就清零"正是让循环跑不完的原因。
4. **状态机是 8 列 + archived 过滤器**，且"允许迁移 ≠ 保证成功"：动词（complete/block/request_review）各有自己的门（父任务是否开启、完成证据）。

## ② 证据

| # | 位置 | 原文（截断） | 说明 |
|---|---|---|---|
| 1 | `kanban.db` DDL `tasks` | `id TEXT PRIMARY KEY, title, body, assignee, status, priority, created_by, created_at, started_at, completed_at` | 基本字段 |
| 2 | 同上 | `workspace_kind TEXT NOT NULL DEFAULT 'scratch', workspace_path, branch_name, project_id` | 工作区（scratch/worktree/dir） |
| 3 | 同上 | `claim_lock TEXT, claim_expires INTEGER, worker_pid INTEGER, worker_started_at INTEGER` | 抢锁 |
| 4 | 同上 | `consecutive_failures INTEGER NOT NULL DEFAULT 0` `reset only on successful completion` | 失败计数 |
| 5 | 同上 | `block_kind`, `block_recurrences` `Reset to 0 only on a successful completion — NOT on unblock` | 循环熔断 |
| 6 | 同上 | `completion_contract TEXT` | 完成契约（自由文本，喂给判官） |
| 7 | 同上 | `result TEXT, idempotency_key TEXT, tenant TEXT, session_id TEXT` | 幂等 + 归属 |
| 8 | 同上 | `goal_mode INTEGER NOT NULL DEFAULT 0, goal_max_turns INTEGER` | 目标循环开关 |
| 9 | 同上 | `skills TEXT, model_override, provider_override, reasoning_effort, max_retries` | 每任务执行参数 |
| 10 | 同上 | `current_run_id INTEGER` `Denormalised for cheap reads` | 当前 run 指针 |
| 11 | `hermes_cli/kanban_db.py:279` | `DEFAULT_CLAIM_TTL_SECONDS = 15 * 60` | 锁窗口 |
| 12 | `hermes_cli/kanban_db.py:288` | `DEFAULT_CLAIM_HEARTBEAT_MAX_STALE_SECONDS = 60 * 60` | 心跳过期 |
| 13 | `hermes_cli/kanban_db.py:283-286` | `A live PID with a heartbeat older than this is wedged and reclaimed anyway` | PID 活着也可能被判死 |
| 14 | `hermes_cli/kanban_db.py:292` | `RECLAIM_DEFER_GRACE_SECONDS = 120` | 回收前宽限（防重复 spawn） |
| 15 | `hermes_cli/kanban_db.py:110` | `VALID_BLOCK_KINDS = {"dependency","needs_input","capability","transient"}` | 阻塞类型 |
| 16 | `hermes_cli/kanban_db.py:114` | `BLOCK_RECURRENCE_LIMIT = 2` | 改道阈值 |
| 17 | `kanban.db` DDL `task_runs` | `status: running \| done \| blocked \| crashed \| timed_out \| failed \| released` | run 状态机 |
| 18 | `kanban.db` DDL `task_runs` | `outcome: completed \| blocked \| crashed \| timed_out \| spawn_failed \| gave_up \| reclaimed` | 终局归因 |
| 19 | `kanban.db` DDL `task_events` | `task_id, run_id, kind, payload, created_at` | 进度/审计流 |
| 20 | `kanban.db` DDL `kanban_notify_subs` | `task_id, platform, chat_id, thread_id, delivery_mode, last_event_id` | 订阅式进度推送 |
| 21 | `config.yaml`（kanban 段） | `max_concurrent_sessions` / `group_sessions_per_user: true` | 会话隔离 |
| 22 | `state.db` 表 `sessions` | `id, session_key, chat_id, parent_session_id, message_count, tool_call_count, api_call_count, end_reason, last_activity_at, last_activity_description, handoff_state, compression_*` | 会话字段 |
| 23 | `state.db` 表 `sessions` | `tool_names TEXT, transcript_revision INTEGER, archived, pinned` | 会话级工具集快照 |
| 24 | `tools/session_search_tool.py:1-6` | `DISCOVERY / SCROLL / READ / BROWSE ... No LLM calls` | 跨会话续接的检索面 |
| 25 | `config.yaml:772-774` | `Stale automation sessions (cron/kanban/subagent/one-shot CLI) whose process died without closing them are first closed` | 僵尸会话清收 |
| 26 | `hermes_cli/kanban_db_dispatch.py:597-598` | `UPDATE tasks SET claim_expires = ? WHERE id = ? AND status = 'running' AND claim_lock IS ?` | 条件更新（乐观锁） |

## ③ 契约

```
任务状态机（列 = status）:
  triage ──→ todo ──→ scheduled
     │        │  └──→ ready ──→ running ──→ review ──→ done
     └────────┴────────────────→ blocked
  任意 → archived（过滤器，不是列）
  running 只能由 kernel 进入；review 需要 reviewer；scheduled 需要唤醒时间

手动迁移矩阵（人可请求的）：见 07-workflows.md；"允许"不等于"成功"
```

**字段语义表（DSH 可直接照搬的"任务对象"）**

| 字段 | 类型 | 作用 | 缺失后果 |
|---|---|---|---|
| `id` | TEXT | 稳定 id | — |
| `title` / `body` | TEXT | 目标（喂给判官） | 判官无法判定 |
| `status` | enum(8) | 位置 | — |
| `assignee` | TEXT | 谁做（profile/bot） | 无法派发 |
| `claim_lock` / `claim_expires` | TEXT / INT | 抢占 + 租约 | 两个 worker 同时干同一任务 |
| `worker_pid` / `worker_started_at` | INT | 进程身份 | 重启后误杀别人的同号 PID |
| `last_heartbeat_at` | INT | 进展信号 | 卡死任务永不被回收 |
| `consecutive_failures` / `max_retries` | INT | 失败熔断 | 无限重试烧钱 |
| `block_kind` / `block_recurrences` | enum / INT | 阻塞原因 + 循环检测 | 同一原因无限 block/unblock |
| `completion_contract` | TEXT | 完成判据 | 只能靠模型自称完成 |
| `idempotency_key` | TEXT | 去重建卡 | 重试建出重复任务 |
| `session_id` | TEXT | **发起会话**（可空、非唯一） | 任务与对话失联（注意：不是"归属"，CLI/看板建的任务为 NULL） |
| `skills` | JSON | 三态：NULL=用默认 / `[]`=显式不用 / 列表 | 空数组被当成"未设置"，反而继承默认技能 |
| `result` | TEXT | 产物摘要 | 完成后无交付物 |
| `workspace_kind/path/branch` | enum/TEXT | 工作区隔离 | 多任务互相污染 |

**UI 如何呈现进度（Hermes 的做法）**

1. `task_events` 追加事件（status 变更、comment、heartbeat）→ 看板通过 `last_event_id` 增量拉。
2. `kanban_notify_subs` 让"某个任务"订阅到 chat（`delivery_mode: notify`），只推 `blocked`/`triage` 这类需要人的事件（`gateway/kanban_watchers_notifier.py:59`）。
3. 卡片上有 `last_failure_error`、`current_run_id`、`goal_max_turns` → 用户直接看到"为什么卡"。

**完成 / 取消 / 失败语义**

| 动作 | 语义 | 是否可恢复 |
|---|---|---|
| `kanban_complete` | 写 `status=done` + `completed_at` + `result`；要求过 `completion_contract` 与父任务门 | 可 reopen |
| `kanban_block` | 写 `status=blocked` + `block_kind`；`dependency` 类走 `todo` 而非 `blocked`（由父任务门控） | 可 unblock（**不清零** `block_recurrences`） |
| `kanban_request_review` | → `review`，需要 reviewer | 可 `request_changes` 打回 |
| 崩溃 / 超时 | run `status=crashed/timed_out`，`outcome` 记录归因；`consecutive_failures++` | 下个 tick 重新派发 |
| 放弃 | `outcome=gave_up`，`consecutive_failures > limit` | 需人工改 `max_retries` |

## ④ 对 DSH 的适配

| 项 | 内容 |
|---|---|
| DSH 现状 | **没有**跨会话任务实体（已知缺口）。DSH 的"工作流 + 定时任务"都是单会话内的，会话结束任务就丢。 |
| 缺口 | ①重跑从零；②多面板并发时无法申领"这个任务归我"；③没有失败计数与循环熔断，坏任务会一直重试；④进度只能靠会话消息，无法把"某任务被 block 了"推给用户。 |
| 落点 | 引擎：`packages/engine/src/task/store.ts`（SQLite，字段照上表）+ `task/claim.ts`（租约）+ `task/events.ts`；外壳：把 `task_events` 接到现有的通知通道。 |
| 成本 | **L**。store S（建表），claim M（要处理"进程还活着但不干活"），事件流 + UI M，跨会话续接 M。 |
| 失败模式 | ⚠️ **只抄 `claim_lock` 不抄 `worker_started_at`** → 重启后 PID 复用，会误杀无关进程（DDL 注释专门写了这个）。⚠️ **unblock 时清零 `block_recurrences`** → 循环永远跑不完（这是 Hermes 明确修过的 bug）。⚠️ **心跳用定时器** → 进程卡在 IO 时定时器还在跑，会假装活着；Hermes 用"真实 API 流量顺带刷新"。⚠️ **认 pid 活就认为没卡** → 死循环进程也是活的，必须叠加"心跳超过 60 min 就判死"。⚠️ 没有 `idempotency_key` → 重试建出重复卡片。 |

## ⑤ 实证 / 推断分界

| 判定 | 条 | 依据 / 如何验证 |
|---|---|---|
| 【实证】 | 15 字段语义、状态机列、`claim_expires`(15min)、`last_heartbeat_at`(60min stale)、`block_recurrences` limit 2、`idempotency_key`、`task_events` | `kanban_db.py:110-115,275-300` + 只读 PRAGMA 得到的 DDL |
| 【实证】 | `unblock` 不清零 `block_recurrences` | 代码路径可读；这是 Hermes 修过的坑 |
| 【实证】 | `worker_pid` 必须配 `worker_started_at` | 注释明确提到重启后 PID 复用 |
| 【推断】 | 15min / 60min 这两个值适合 DSH | 由 Hermes 场景（多平台 bot、慢任务）推断。**验证**：压测 kill worker 后的重派延迟与心跳频率 |
| 【推断】 | TASK-01 是其它三条的地基 | 依赖关系推断。**验证**：先只做表 + claim，看 WORK-01 / BILL-01 是否真无法落地 |
| 【实证】 | `hosted_rooms*` 的协作协议 | 协议在 `gateway/hosted_room_*.py`（17 模块 8512 行），见 `08-附录/A4`；上一版误标为未解 |

## ⑥ U1 已解：Hermes 自己的"任务粒度"答案

上一版把"DSH 一个 task 对应什么"记为产品决策缺口。**Hermes 的答案可以直接读出来，不需要 DSH 先决策**——它是「任务为主实体，会话只是来源标注」：

| 证据 | 事实 | 推论 |
|---|---|---|
| `kanban_db.py:655` | `session_id: Optional[str] = None  # originating HERMES_SESSION_ID; NULL from CLI/dashboard` | 这是**发起**会话，不是归属会话；CLI / 看板建的任务根本没有会话 |
| `idx_tasks_session_id`（DDL） | `unique: false` | 一个会话可以派**多个**任务（N:1） |
| `task_runs` DDL | 字段里**没有** `session_id`，只有 `profile` | run 绑定的是工作身份，不是会话；重试/多步不会新建会话 |

**结论**：`claim_lock` 不需要带 `session_id`；`BILL-01` 的台账主键用 `task_id` 就够（要按会话看账时 join 回去即可）；面板间消息带 `task_id` 是对的（见 `08-附录/A4` 的 `PanelEnvelope`）。

**给 DSH 的落法**：先落 `one session = 一个「当前活跃任务」` 的产品约束，但**表结构按 N:1 建**（`tasks.session_id` 可空 + 非唯一）。这样以后放开并发不用改表——这正是 Hermes 的结构给出的余地。

⚠️ 一个反向的坑：`skills` 字段三态（`NULL` = 用默认 / `[]` = 显式不用 / 列表）。`[]` 与"未设置"在 JSON 里都是"空"，用 `if not skills` 判会把"显式不用"读成"用默认"。同一类错误在 v45 迁移里也出现过（`platform_toolsets` 显式列表里缺 `connections` 被当成"未勾选"）。
