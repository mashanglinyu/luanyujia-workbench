# 证据 E05 — 提示词拼装

`0.22.2 / agent\system_prompt.py, prompt_builder.py, prompt_cach*.py`

| # | 路径:行 | 原文（≤40 字） | 说明 |
|---|---|---|---|
| E05-01 | agent/system_prompt.py:3 | `Built once per session and reused across turns` | 重建时机 |
| E05-02 | agent/system_prompt.py:5 | `Three tiers are joined with` | 三档 |
| E05-03 | agent/system_prompt.py:744 | `Never re-rendered mid-session.` | 稳定性契约 |
| E05-04 | agent/system_prompt.py:748 | `stable_parts, _soul_loaded = _identity_parts(agent, _ctx_len)` | stable 首位 |
| E05-05 | agent/system_prompt.py:752 | `_help_guidance_slot = len(stable_parts)` | 先占位后回填 |
| E05-06 | agent/system_prompt.py:785 | `volatile_parts: list[str] = [skills_prompt, *_memory_parts(agent)]` | 技能索引居 volatile 首 |
| E05-07 | agent/system_prompt.py:792 | `volatile_parts.append(_timestamp_line(agent))` | 每轮变的靠后 |
| E05-08 | agent/system_prompt.py:798 | `volatile_parts.append(f"{_pb.RUNTIME_ENVIRONMENT_HEADING}` | 环境块最后 |
| E05-09 | agent/system_prompt.py:811 | `return "\n\n".join(p for p in (parts["stable"], parts["context"], parts["volatile"]) if p)` | 拼接 |
| E05-10 | agent/system_prompt.py:807 | `agent._cached_system_prompt_static = parts["stable"]` | static 单独缓存 |
| E05-11 | agent/system_prompt.py:814 | `def invalidate_system_prompt(agent) -> None:` | 压缩后失效 |
| E05-12 | agent/prompt_caching.py:3 | `Default layout: 4 cache_control breakpoints` | 断点布局 |
| E05-13 | agent/prompt_cache_boundary.py:3 | `Only the builder knows where the tail begins` | 显式声明 |
| E05-14 | agent/prompt_builder.py:1045 | `CONTEXT_FILE_MAX_CHARS = 20_000` | 上下文文件上限 |
| E05-15 | agent/prompt_builder.py:41 | `_CONTEXT_FILE_READ_TIMEOUT_SECS = 5.0` | 读超时防卡启动 |
| E05-16 | agent/prompt_builder.py:365 | `TOOL_USE_ENFORCEMENT_MODELS = ("gpt", "codex", ...` | 按模型插 guidance |
| E05-17 | agent/prompt_builder.py:575 | `CONTROL_FRAME_OPENERS = (` | 控制帧清单 |
| E05-18 | agent/conversation_loop.py:1204 | `def _ensure_cached_system_prompt_static(agent, system_message=None)` | 每轮校验漂移 |

复核：`grep -n "stable_parts\|context_parts\|volatile_parts" agent/system_prompt.py`
