# 证据 E03 — 上下文压缩

`0.22.2 / agent\context_compressor*.py, micro_compaction.py, compaction_events.py, config.yaml`

| # | 路径:行 | 原文（≤40 字） | 说明 |
|---|---|---|---|
| E03-01 | config.yaml:413 | `threshold: 0.50` | 默认触发比 |
| E03-02 | config.yaml:411 | `Models with context windows below 512K are floored at 0.75` | 小窗口地板 |
| E03-03 | agent/context_compressor.py:2764 | `Raise-only small-context threshold floor: models under 512K trigger at >= 75%.` | 地板实现 |
| E03-04 | agent/context_compressor.py:1151 | `at 50% the incompressible floor eats the reclaimed headroom` | 为什么要有地板 |
| E03-05 | config.yaml:425 | `an optional absolute token cap for the compression trigger` | threshold_tokens |
| E03-06 | agent/context_compressor.py:2043 | `Per-model threshold: longest matching model_thresholds key wins, else default.` | 逐模型 |
| E03-07 | agent/micro_compaction.py:5 | `OFF by default: every pass rewrites the prompt prefix` | micro 默认关 |
| E03-08 | config.yaml:535 | `proactive_prune_tokens: 0` | prune 默认关 |
| E03-09 | agent/context_compressor_prune.py:38 | `Deterministic, no-LLM tool-result prune gated on proactive_prune_tokens.` | 无 LLM |
| E03-10 | agent/context_compressor.py:832 | `_PRUNED_TOOL_PLACEHOLDER = "[Old tool output cleared to save context space]"` | 占位不是空串 |
| E03-11 | agent/context_compressor.py:852 | `SKILL_PRUNED_MARKER_PREFIX = "[SKILL_PRUNED:"` | 防幽灵技能 |
| E03-12 | agent/context_compressor.py:261 | `"[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted "` | 摘要前缀 |
| E03-13 | agent/context_compressor.py:289 | `your tools remain fully active` | 关键一句（踩过坑） |
| E03-14 | agent/context_compressor.py:504 | `_SUMMARY_END_MARKER = "--- END OF CONTEXT SUMMARY` | 结束定界符 |
| E03-15 | agent/context_compressor.py:795 | `_TIMEOUT_COOLDOWN_LADDER = (60, 300, 900)` | 冷却阶梯 |
| E03-16 | agent/context_compressor.py:807 | `_CONSECUTIVE_OVERLOAD_ABORT_ESCALATION = 3` | 过载升级 |
| E03-17 | agent/context_compressor.py:329 | `COMPRESSION_CONTINUATION_USER_CONTENT = (` | 压完自动继续 |
| E03-18 | agent/compaction_events.py:72 | `"harness", "kind", "scope", "official", "method", "trigger"` | 留痕字段起点 |
| E03-19 | agent/compaction_events.py:73 | `"tokens_before", "tokens_after", "tokens_reclaimed"` | 前后 token |
| E03-20 | agent/compaction_events.py:37 | `"manual", "turn_start_threshold", "pre_api", "post_tool"` | trigger 枚举 |
| E03-21 | state.db 表 compression_locks | `session_id, holder, acquired_at, expires_at` | 压缩互斥 |
| E03-22 | state.db 表 messages | `_compressed_summary, active, compacted, absorbed_message_uids` | 留痕落库字段 |
| E03-23 | agent/conversation_loop.py:1097 | `def _compression_deferred_result(agent, messages, api_call_count, reason="lock")` | 抢不到锁就跳过 |

复核：`grep -n "threshold_percent\|_PRUNED_TOOL_PLACEHOLDER\|_OUTCOMES" agent/context_compressor.py agent/compaction_events.py`
