# 01 Agent 主循环

`0.22.2+2364.g0b10b9f / <旧位置>\Hermes / agent\conversation_loop.py、turn_*.py、iteration_budget.py`

## ① 结论

1. **一轮 = 11 个命名阶段（phase）的线性管线**，每阶段返回 `action ∈ {continue, break, return}`，不是 while 里塞 if。这样压缩、重试、中断、截断都能"从某一相重新进入"。
2. **双预算**：迭代预算（父 500 / 子 250）+ 墙钟 run budget（80% 处注入收尾通告）。预算耗尽不是抛错，而是注入一条"停止发现、交付已有成果"的系统通告后**再给一次机会**（`_budget_grace_call`）。
3. **死循环防四层**：重复内容守卫（输出侧）、stall guard（调用侧，同参数同结果 N 次）、工具失败熔断、子代理 spawn 上限。任一层命中都是"改道"而不是"硬杀"（先 warning 再 stub 再 halt）。

## ② 证据

| # | 位置 | 原文（截断） | 说明 |
|---|---|---|---|
| 1 | `agent/conversation_loop.py:1656` | `while _prelude_action != "break" and (` | 主循环入口条件 |
| 2 | `agent/conversation_loop.py:1657` | `(s.api_call_count < agent.max_iterations and agent.iteration_budget.remaining > 0) or agent._budget_grace_call` | 双条件 + grace |
| 3 | `agent/conversation_loop.py:1659-1700` | `begin_iteration → prepare_iteration → assemble_api_request → run_preflight_gate → announce_api_call → _run_api_retry_loop → apply_retry_restarts → normalize_model_response → run_tool_round/finish_text_response` | 阶段序列 |
| 4 | `agent/conversation_loop.py:1674` | `s.api_request_id = agent._current_api_request_id = f"{s.turn_id}:api:{s.api_call_count}"` | 每次调用有稳定 id |
| 5 | `agent/conversation_loop.py:1706` | `result = finalize_turn(agent, **{...})` | 收尾独立成函数 |
| 6 | `agent/iteration_budget.py:3-5` | `the parent's cap is max_iterations (default 500), each subagent's delegation.max_iterations (default 50)` | 预算口径 |
| 7 | `agent/iteration_budget.py:36` | `def refund(self) -> None:` | `execute_code` 不占预算 |
| 8 | `agent/conversation_loop.py:71` | `RUN_BUDGET_WRAPUP_NOTICE = (` … `Stop new discovery/verification work now` | 80% 收尾通告 |
| 9 | `agent/repetition_guard.py:14` | `MIN_FRAGMENT_LENGTH = 400` | 重复检测下限 |
| 10 | `agent/repetition_guard.py:26` | `REPETITION_LOOP_INTERRUPTED = "[the reply degenerated into a repetition loop and was interrupted]"` | 中断占位符 |
| 11 | `agent/tool_guardrails.py:39` | `STALL_GUARD_IDENTICAL_CALL_THRESHOLD = 3` | 同调用阈值 |
| 12 | `agent/tool_guardrails.py:123` | `no_progress_block_after: int = 5` | 无进展阻断 |
| 13 | `agent/estop.py:1-3` | `Global emergency stop (ESTOP) — a resumable pause for NEW work only` | 全局急停语义 |
| 14 | `agent/turn_truncation.py:1-3` | `text continuation nudges (up to 4, with the ceiling exit that drops the fragment trail)` | 截断续写 4 次上限 |
| 15 | `agent/conversation_loop.py:963` | `_DROPPED_TOOLCALL_NUDGE_CONTENT = (` `issue the actual tool call now` | 空 tool_calls 补救 |
| 16 | `tools/async_delegation.py:1-6` | `results surface as a NEW turn (never mid-turn)` | 后台结果回投时机 |
| 17 | `agent/context_compressor.py:338` | `MAX_ITERATIONS_SUMMARY_REQUEST = (` `provide a final response summarizing` | 预算打尽时的最后指令 |

## ③ 契约 / 伪代码

```python
def run_turn(agent, user_msg):
    s = LoopState(turn_id=uuid(), api_call_count=0, finish_reason="stop")
    while (s.api_call_count < agent.max_iterations
           and agent.iteration_budget.remaining > 0) or agent.budget_grace_call:
        act = begin_iteration(agent, s)            # 预算警告注入 / grace 消费
        if act == "break": break
        prepare_iteration(agent, s)                 # 裁剪、补 steer、徽标
        assemble_api_request(agent, s)
        gate = run_preflight_gate(agent, s)         # 压缩前的最后一道闸
        if gate in ("return", "break"): ...
        if gate == "continue": continue
        s.api_request_id = f"{s.turn_id}:api:{s.api_call_count}"
        early = api_retry_loop(agent, s)            # 指数退避 + 模型切换
        if early: return early
        normalize_model_response(agent, s)
        v = run_tool_round(agent, s) if s.tool_calls else finish_text_response(agent, s)
        if v == "return": return s.result
        if v in ("break", "continue"): ...
    return finalize_turn(agent, s)
```

**错误回给模型的三种形态**（都是 message，不是异常）：

| 形态 | 触发 | 形态 |
|---|---|---|
| `tool_error(msg)` | 工具内部失败 | `{"error": "<bounded msg>"}`（`tools/registry.py:1065`，正文截断防历史膨胀） |
| nudge | 空响应/空 tool_calls/只有 reasoning | 追加一条 `role=user` 的系统口吻提示，**不改历史** |
| guardrail stub | 重复调用 | 结果替换为"同名同参已调用 N 次"的桩 + notice |

**恢复语义**

- 中断：`_apply_active_turn_redirect` 放下一条 `[This response was interrupted by a user correction.]`，随后新用户消息覆盖旧任务（`conversation_loop.py:77`）。
- 截断：`finish_reason=length` → 最多 4 次续写；仍失败则**回滚掉碎片轨迹**（turn_truncation 的 ceiling exit），避免碎片被当成答案。
- 后台：`delegate_task(background=true)` 结果经 `process_registry.completion_queue` 在**下一轮开始时**变成新 turn，绝不插进当前 turn。
- 进程级：`ESTOP` 哨兵文件只拦**新**工作（cron/kanban/新 gateway turn），在跑的永不杀。

## ④ 对 DSH 的适配

| 项 | 内容 |
|---|---|
| DSH 现状 | **半有**。有 while 循环 + 步数上限，但没有命名阶段、没有 grace call、没有 stalled-call 检测（只有单级压缩）。 |
| 缺口 | ①步数到顶直接断，模型没机会交付"已有成果"；②工具反复空转无检测；③中断后无占位符，历史里留下半截 assistant；④无全局急停。 |
| 落点 | 引擎：`packages/engine/src/loop/`（新增 `phases.ts` + `budget.ts` + `stall-guard.ts`）；外壳：状态栏加 ESTOP 开关。 |
| 成本 | **M**（阶段拆分是纯重构，但 `_LoopState` 的字段会牵动压缩与工具执行两处）。grace call 与 stall guard 各 S。 |
| 失败模式 | ⚠️ 抄错 grace call → 变成无限循环（必须"只发一次 + 置位 latch"，Hermes 用 `_budget_grace_call` 布尔而非计数器）。⚠️ 抄错 repetition guard → 误杀"请重复 50 遍"这类合法请求（Hermes 加 `STOP_PATH_MIN_CHARS=16000` 下限）。⚠️ 把 stall guard 做成"直接报错"→ 用户看到莫名其妙的失败，正确做法是**先给 notice 让模型自己改**。 |

## ⑤ 实证 / 推断分界

| 判定 | 条 | 依据 / 如何验证 |
|---|---|---|
| 【实证】 | ② 表 17 行全部 | 每行均有 `path:line` + 原文，可直接复核 |
| 【实证】 | grace call 是布尔不是计数器 | `conversation_loop.py:1657` 条件里是 `or agent._budget_grace_call` |
| 【推断】 | DSH 无 stalled-call 检测 | 来源是任务书自述（未见 DSH 源码）。**验证**：在引擎里 grep 对 (toolName,argsHash,resultHash) 三元组的计数/比较 |
| 【推断】 | 阶段拆分对 DSH 是纯重构、成本 M | 由 `_LoopState` 字段被引用处数推断。**验证**：统计 `packages/engine/src` 里 loop_state 触点，>20 则升为 L |
| 【未验证】 | DSH 现有 while 循环的实际退出条件 | 红线禁止运行 DSH；需读源码确认是否已有“最后一次机会”逻辑 |
