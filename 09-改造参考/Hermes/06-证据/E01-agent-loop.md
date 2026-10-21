# 证据 E01 — Agent 主循环

`0.22.2 / <盘根>://software//Hermes / agent\conversation_loop.py, turn_*.py, iteration_budget.py`

| # | 路径:行 | 原文（≤40 字） | 说明 |
|---|---|---|---|
| E01-01 | agent/conversation_loop.py:1656 | `while _prelude_action != "break" and (` | 主循环入口（行 1656） |
| E01-02 | agent/conversation_loop.py:1657 | `(s.api_call_count < agent.max_iterations and agent.iteration_budget.remaining > 0) or agent._budget_grace_call` | 三点与/或，grace 是布尔 |
| E01-03 | agent/conversation_loop.py:1659 | `if _run_phase(begin_iteration, agent, s).action == "break":` | 阶段返回 action 三态 |
| E01-04 | agent/conversation_loop.py:1674 | `s.api_request_id = agent._current_api_request_id = f"{s.turn_id}:api:{s.api_call_count}"` | 每次调用可追溯 |
| E01-05 | agent/conversation_loop.py:1706 | `result = finalize_turn(agent, **{` | 收尾独立 |
| E01-06 | agent/iteration_budget.py:3 | `the parent's cap is max_iterations (default 500)` | 父预算默认 500 |
| E01-07 | agent/iteration_budget.py:36 | `def refund(self) -> None:` | execute_code 退还 |
| E01-08 | agent/conversation_loop.py:71 | `RUN_BUDGET_WRAPUP_NOTICE = (` | 墙钟 80% 注入收尾 |
| E01-09 | agent/repetition_guard.py:14 | `MIN_FRAGMENT_LENGTH = 400` | 重复检测不扫短文本 |
| E01-10 | agent/repetition_guard.py:52 | `STOP_PATH_MIN_CHARS = 16_000` | stop 路径阈值更高 |
| E01-11 | agent/tool_guardrails.py:39 | `STALL_GUARD_IDENTICAL_CALL_THRESHOLD = 3` | 同调用阈值 |
| E01-12 | agent/tool_guardrails.py:123 | `no_progress_block_after: int = 5` | 无进展阻断 |
| E01-13 | agent/estop.py:1 | `Global emergency stop (ESTOP) — a resumable pause for NEW work only` | 只拦新工作 |
| E01-14 | agent/turn_truncation.py:3 | `text continuation nudges (up to 4, with the ceiling exit` | 续写上限 4 次 |
| E01-15 | tools/async_delegation.py:6 | `results surface as a NEW turn (never mid-turn)` | 后台回投时机 |
| E01-16 | agent/context_compressor.py:338 | `MAX_ITERATIONS_SUMMARY_REQUEST = (` | 预算打尽的最后指令 |

复核：`grep -n "budget_grace_call\|_run_phase\|RUN_BUDGET_WRAPUP" agent/conversation_loop.py`
