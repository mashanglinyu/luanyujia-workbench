# 证据 E10 — 任务与会话模型

`0.22.2 / kanban.db（只读 PRAGMA）, state.db, hermes_cli\kanban_*.py`

| # | 路径:位置 | 原文（≤40 字） | 说明 |
|---|---|---|---|
| E10-01 | kanban.db / tasks | `claim_lock TEXT, claim_expires INTEGER, worker_pid INTEGER` | 抢锁四件套 |
| E10-02 | kanban.db / tasks | `Restart-stable fingerprint of worker_pid ("<boot/instantiation epoch>|<start time>"` | 防 PID 复用 |
| E10-03 | kanban.db / tasks | `consecutive_failures INTEGER NOT NULL DEFAULT 0` | 失败计数 |
| E10-04 | kanban.db / tasks | `NOT on unblock (resetting on unblock is exactly the amnesia` | unblock 不清零 |
| E10-05 | kanban.db / tasks | `completion_contract TEXT` | 完成契约 |
| E10-06 | kanban.db / tasks | `idempotency_key TEXT` | 建卡幂等 |
| E10-07 | kanban.db / tasks | `session_id TEXT` | 与会话弱关联 |
| E10-08 | kanban.db / tasks | `current_run_id INTEGER` | 当前 run 指针 |
| E10-09 | kanban.db / task_runs | `status: running | done | blocked | crashed | timed_out | failed | released` | run 状态 |
| E10-10 | kanban.db / task_runs | `outcome: completed | blocked | crashed | timed_out | spawn_failed | gave_up | reclaimed` | 终局归因 |
| E10-11 | kanban.db / task_events | `task_id TEXT NOT NULL, run_id INTEGER, kind TEXT NOT NULL, payload TEXT` | 事件流 |
| E10-12 | kanban.db / kanban_notify_subs | `delivery_mode TEXT NOT NULL DEFAULT 'notify'` | 订阅推送 |
| E10-13 | hermes_cli/kanban_db.py:279 | `DEFAULT_CLAIM_TTL_SECONDS = 15 * 60` | 锁窗口 |
| E10-14 | hermes_cli/kanban_db.py:288 | `DEFAULT_CLAIM_HEARTBEAT_MAX_STALE_SECONDS = 60 * 60` | 心跳过期 |
| E10-15 | hermes_cli/kanban_db.py:283 | `A live PID with a heartbeat older than this is wedged` | 活着也可能卡死 |
| E10-16 | hermes_cli/kanban_db.py:292 | `RECLAIM_DEFER_GRACE_SECONDS = 120` | 回收宽限 |
| E10-17 | state.db / sessions | `last_activity_description, handoff_state, compression_ineffective_count` | 会话态字段 |
| E10-18 | state.db / sessions | `tool_names TEXT, transcript_revision INTEGER` | 工具集快照 |
| E10-19 | hermes_cli/kanban_db_dispatch.py:598 | `WHERE id = ? AND status = 'running' AND claim_lock IS ?` | 条件更新 |
| E10-20 | config.yaml:773 | `whose process died without closing them are first closed` | 僵尸会话清收 |
| E10-21 | tools/session_search_tool.py:5 | `No LLM calls — every shape returns actual DB messages.` | 跨会话检索 |
| E10-22 | hermes_cli/kanban_db.py:655 | `originating HERMES_SESSION_ID; NULL from CLI/dashboard` | session_id 是「发起」不是「归属」 |
| E10-23 | kanban.db DDL `tasks` 索引 | `idx_tasks_session_id ... unique: false` | 一个会话可派多任务（N:1） |
| E10-24 | kanban.db DDL `task_runs` | 字段无 `session_id`，只有 `profile` | run 绑工作身份，不绑会话 |
| E10-25 | hermes_cli/kanban_db.py:645 | `None = defaults only; [] = explicitly none` | 空数组 ≠ 未设置 |

复核：`python -c "import sqlite3;c=sqlite3.connect(r'file:<盘根>:/software/Hermes/kanban.db?mode=ro&immutable=1',uri=True);print(c.execute('select sql from sqlite_master where name=%s'%repr('tasks')).fetchone()[0])"`
