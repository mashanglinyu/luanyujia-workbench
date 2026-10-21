# 证据 E14 — 失败分类 / 退避 / 冷却 / 截止

`0.22.2 / agent\{error_classifier,retry_utils,fallback_cooldown,credential_pool,credential_pool_model_cooldowns,deadline,turn_api_error,turn_recovery,chat_completion_helpers,chat_completion_local,reasoning_timeouts}.py`

复现命令（在 `<旧位置>\Hermes\hermes-agent` 下）：

```bash
grep -n "class FailoverReason" -A 35 agent/error_classifier.py
grep -n "_ROTATE_FALLBACK\|_ABORT_FALLBACK" agent/error_classifier.py
sed -n '121,200p' agent/retry_utils.py
sed -n '45,76p' agent/fallback_cooldown.py
sed -n '132,140p;371,398p' agent/credential_pool.py
sed -n '19,32p;92,104p' agent/credential_pool_model_cooldowns.py
sed -n '547,620p' agent/chat_completion_helpers.py
sed -n '34,60p' agent/chat_completion_local.py
sed -n '1348,1377p;1401,1460p' agent/turn_recovery.py
sed -n '1,60p;120,200p' agent/deadline.py
```

| # | 路径:行 | 原文（≤40 字） | 说明 |
|---|---|---|---|
| E14-01 | agent/error_classifier.py:34 | `class FailoverReason(enum.Enum):` | 29 值封闭枚举起点 |
| E14-02 | agent/error_classifier.py:39 | `429 or quota-based throttling — backoff then rotate` | 限流的两段恢复 |
| E14-03 | agent/error_classifier.py:40 | `Aggregator's upstream model 429 — fallback model, key is healthy` | 上游 429 不冷却凭据 |
| E14-04 | agent/error_classifier.py:41 | `403 from a WAF/CDN/proxy ... key is healthy, fallback` | 403 的 WAF 义 |
| E14-05 | agent/error_classifier.py:52 | `deterministic per-request, don't retry unchanged` | 内容策略拒绝 |
| E14-06 | agent/error_classifier.py:53 | `rotate credential (model-scoped), else fall back` | 无权限模型 |
| E14-07 | agent/error_classifier.py:66 | `Unclassifiable — retry with backoff` | unknown 也不放弃 |
| E14-08 | agent/error_classifier.py:80 | `Recovery hints — the retry loop checks these instead of re-classifying.` | 提示预计算 |
| E14-09 | agent/error_classifier.py:460 | `_ROTATE_FALLBACK = {"should_rotate_credential": True, ...}` | 轮换+降级组合 |
| E14-10 | agent/error_classifier.py:461 | `_ABORT_FALLBACK = {"retryable": False, "should_fallback": True}` | 终止+降级组合 |
| E14-11 | agent/error_classifier.py:486-489 | `no other provider can fix that output, so falling back only replays the same broken turn 4-5 times` `(20-60s per occurrence, #12770)` | 坏 JSON 不降级 |
| E14-12 | agent/error_classifier.py:477 | `_V_CONTEXT_OVERFLOW = _v(_R.context_overflow, should_compress=True)` | 超限走压缩 |
| E14-13 | agent/error_classifier.py:797-801 | `RETRYABLE_CLIENT_REASONS = frozenset({rate_limit, upstream_rate_limit, overloaded, context_overflow, payload_too_large, long_context_tier, thinking_signature})` | 7 个「退避后才降级」 |
| E14-14 | agent/error_classifier.py:783-784 | `if hints.get("should_fallback") and "retryable" not in hints and reason not in RETRYABLE_CLIENT_REASONS: hints["retryable"] = False` | 钩子默认值补全 |
| E14-15 | agent/error_classifier.py:965-973 | `phantom context-length error` `Reclassify as timeout.` | 推理模型超时要重归类 |
| E14-16 | agent/error_classifier.py:975-978 | `as unknown it would burn every retry instantly` `return _v(_R.timeout, **_ABORT_FALLBACK)` | 熔断后的 timeout 变体 |
| E14-17 | agent/error_classifier.py:987 | `_by_status(c)` `default = _V_FORMAT_ERROR if 400 <= status < 500 else _V_SERVER_ERROR` | 未列出码的兜底 |
| E14-18 | agent/reasoning_timeouts.py:18-19 | `_REASONING_STALE_TIMEOUT_FLOORS: dict[int, tuple[str, ...]] = {600: (` `"nemotron-3-ultra"` | 按模型抬高超时下限 |
| E14-19 | agent/reasoning_timeouts.py:76 | `qwen3-235b` 命中 `qwen3`，`some-other-qwen3` 不命中 | 前缀匹配的右锚点 |
| E14-20 | agent/retry_utils.py:1-4 | `Jittered delays (vs. fixed exponential) prevent thundering-herd retry spikes` | 抖动动机 |
| E14-21 | agent/retry_utils.py:69 | `quotaResetDelay[:\s\"]+(\d+(?:\.\d+)?)(ms|s)` | 语法 1 |
| E14-22 | agent/retry_utils.py:71-76 | `resets?\s+in\s+...(h...)...(m...)...(s...)` | 语法 4 |
| E14-23 | agent/retry_utils.py:93-95 | `An explicit "retry after N s" wins over "resets in ..." ... the shorter explicit wait is the one the provider actually asks for` | 优先级理由 |
| E14-24 | agent/retry_utils.py:121-134 | `min(base * 2^(attempt-1), max_delay) + uniform jitter` `seed = (time.time_ns() ^ (tick * 0x9E3779B9))` | 退避公式与种子 |
| E14-25 | agent/retry_utils.py:130 | `exponent >= 63 ... max_delay` | 溢出保护 |
| E14-26 | agent/retry_utils.py:179 | `LIVE_RETRY_WAIT_CAP_S = 60.0` | 有人在场上限 |
| E14-27 | agent/retry_utils.py:181-182 | `Anthropic Tier 1 input-token buckets reset in ~171s, so a 120s cap re-tripped the limit` `RETRY_AFTER_CAP_S = 600.0` | 上限为何是 600 |
| E14-28 | agent/retry_utils.py:185-195 | `None when absent, unparseable or zero: a zero or expired cooldown ... would hot-loop the provider` | 0 不等于立即可试 |
| E14-29 | agent/retry_utils.py:26-27 | `_ZAI_CODING_OVERLOAD_LONG_BACKOFF = (30.0, 60.0, 90.0, 120.0)` `_SHORT_ATTEMPTS = 3` | 单 provider 特例 |
| E14-30 | agent/retry_utils.py:157-167 | `adaptive_rate_limit_backoff(...)` | 短重试后拉长 |
| E14-31 | agent/retry_utils.py:170-174 | `the loop gives up when retry_count >= ceiling BEFORE computing the attempt's backoff` | 上限与循环的耦合坑 |
| E14-32 | agent/fallback_cooldown.py:11 | `_RATE_LIMIT_FAILOVER_REASONS = frozenset({rate_limit, billing, upstream_rate_limit})` | 武装冷却的三种原因 |
| E14-33 | agent/fallback_cooldown.py:50-52 | `reset_at is an absolute wall-clock timestamp while _rate_limited_until is monotonic; convert through a duration` | 时钟纪律 |
| E14-34 | agent/fallback_cooldown.py:69 | `backoff_seconds = min(60 * (2 ** backoff_count), 14400)` | 60s 起、4h 封顶 |
| E14-35 | agent/fallback_cooldown.py:60-61 | `Only arm when leaving the primary: chain-switching from an active fallback means the primary was not the failing source.` | 只在离开主模型时武装 |
| E14-36 | agent/fallback_cooldown.py:25-28 | `Opt-in fallback.min_switch_reset_seconds (default 0 = off, #117484): when the primary's rate limit reopens sooner than N seconds, switching model mid-task costs more than waiting` | 等待优于切换 |
| E14-37 | agent/fallback_cooldown.py:84-87 | `otherwise every turn re-fails on the primary, announces an unverified "Primary model restored", and oscillates forever (#106475)` | 振荡死循环 |
| E14-38 | agent/fallback_cooldown.py:100-101 | `another pool entry is still eligible for this model; rotation owns it` | 轮换优先于记死 |
| E14-39 | agent/credential_pool.py:132-138 | `EXHAUSTED_TTL_401_SECONDS = 5*60` `429 = 60*60` `DEFAULT = 60*60` `SOLE_CREDENTIAL = 60` | TTL 四档 |
| E14-40 | agent/credential_pool.py:383-385 | `an OpenRouter key limit exceeded and an xAI spending block both arrive as 403 but are billing` | 403 的账单义 |
| E14-41 | agent/credential_pool.py:396-397 | `if sole_credential and not is_billing: return min(base, SOLE_CREDENTIAL)` | 唯一凭据降 TTL |
| E14-42 | agent/credential_pool.py:387-388 | `Unverified billing (#82154) gets the short cooldown regardless of pool size` | 未验证账单走短冷却 |
| E14-43 | agent/credential_pool_model_cooldowns.py:3-7 | `Anthropic enforces its API rate limits ... per model, so a generic 429 for one Claude model says nothing about ... its sibling models` | 模型粒度理由 |
| E14-44 | agent/credential_pool_model_cooldowns.py:17-19 | `A Codex ChatGPT-account model entitlement 400 is a plan property, not a window` `MODEL_ENTITLEMENT_BENCH_SECONDS = 365*24*60*60` | 一年冷却 |
| E14-45 | agent/credential_pool_model_cooldowns.py:25-26 | `Callers that do not know the model stay conservative: any active model cooldown blocks them` | 保守读 |
| E14-46 | agent/credential_pool_model_cooldowns.py:84-88 | `Siblings matter because a model_config twin seeded from the same key would otherwise be re-selected for the very model that just failed.` | 兄弟传播理由 |
| E14-47 | agent/credential_pool_model_cooldowns.py:106-113 | `{"scope": "account", "resets_at": epoch}` / `{"scope": "models", ...}` | 选择器要看的状态 |
| E14-48 | agent/credential_pool_model_cooldowns.py:129 | `min(waits) - now < MODEL_ENTITLEMENT_BENCH_SECONDS / 2` | 过滤掉一年的「非窗口」 |
| E14-49 | agent/credential_pool_model_cooldowns.py:48-59 | `Tokens the pool does not know fail open: no row can attribute a cooldown to them.` | 未知 token 放行 |
| E14-50 | agent/chat_completion_helpers.py:547-556 | `A session wedged against an unresponsive provider would otherwise hit the stale detector on every call forever.` | 跨轮熔断动机 |
| E14-51 | agent/chat_completion_helpers.py:551-553 | `reset only when a call completes or the provider is swapped ... the streak measured the OLD provider` | 换 provider 清零 |
| E14-52 | agent/chat_completion_helpers.py:572-578 | `past the wait-notice interval an interrupt is evidence of an unresponsive attempt. Mid-response and early interrupts stay neutral.` | 中断计入的边界 |
| E14-53 | agent/chat_completion_helpers.py:583 | `_INTERRUPTED_WAIT_STALE_SECONDS = 30.0` | 中断计入阈值 |
| E14-54 | agent/chat_completion_helpers.py:610-619 | `no network attempt, no stale-timeout wait` | 熔断后短路 |
| E14-55 | agent/chat_completion_local.py:34-36 | `stale_giveup()` `return env_int("HERMES_STREAM_STALE_GIVEUP", 5)` | 默认 5，0 关闭 |
| E14-56 | agent/chat_completion_local.py:44-48 | `"localhost" can resolve to ::1 first and wait out a timeout on a server bound to IPv4` | 本地健康检查的坑 |
| E14-57 | agent/chat_completion_local.py:54-59 | `a local server that crashed or fell behind and has since recovered gets the user's next message instead of an instant error` | 断路器放行一次 |
| E14-58 | agent/deadline.py:3-5 | `timeouts: in config.yaml > legacy env var > default` `huge timeouts overflow time_t in Lock.acquire / Thread.join on macOS (#83220)` | 三层解析 + 夹紧 |
| E14-59 | agent/deadline.py:6-8 | `wall-clock deadlines driven by a daemon threading.Timer ... so a blocked event loop cannot disable them` | 守护定时器 |
| E14-60 | agent/deadline.py:10-12 | `a timeout here is OUR deadline, not the provider's (classify DeadlineExpired distinctly from transport timeouts)` | 两类超时必须分开 |
| E14-61 | agent/deadline.py:56-59 | `_WINDOWS_MAX_WAIT_S = (0xFFFFFFFF - 1000) / 1000.0` | Windows DWORD 上限 |
| E14-62 | agent/deadline.py:164-171 | `invalid config values FALL THROUGH to env/default instead of resolving as unbounded` `bool rejected ... NaN rejected` | 非法值向下穿透 |
| E14-63 | agent/deadline.py:187-192 | `the deadline is driven by a daemon threading.Timer ... a second timer dumps all thread stacks when the loop provably failed to process the expiry` | 卡死时能看到栈 |
| E14-64 | agent/turn_api_error.py:60-62 | `Every fallback activation must leave the retry loop with restart_with_rebuilt_messages armed ... so the pre-API preflight re-runs against the fallback's context window (#84733)` | 降级必须重建消息 |
| E14-65 | agent/turn_api_error.py:96-107 | `Process is exiting mid-flight: retries/rotation/fallbacks are futile` | 进程退出即放弃 |
| E14-66 | agent/turn_api_error.py:74-75 | `retry status is buffered and only flushed when every retry+fallback is exhausted` | 重试不吵用户 |
| E14-67 | agent/turn_recovery.py:1775-1780 | `compaction-disabled overflow → terminal` `eager fallback for rate-limit/billing (immediately) and transport failures (after 1 retry)` | 恢复顺序总述 |
| E14-68 | agent/turn_recovery.py:1778-1779 | `unless credential-pool rotation may still recover (upstream-aggregator 429s always fall back)` | 轮换优先 |
| E14-69 | agent/turn_recovery.py:1809-1812 | `compression.enabled: false forbids every automatic trigger ... Output-cap errors exempt.` | 关闭压缩时的例外 |
| E14-70 | agent/turn_recovery.py:1353-1354 | `Sleep wait_time in 200 ms slices so interrupts are honoured promptly, touching activity every ~30 s` | 可中断等待 |
| E14-71 | agent/turn_recovery.py:1374-1376 | `A long wait can outlive a short-lived credential (the free tier's JWT lives 15 minutes)` | 等完要重取凭据 |
| E14-72 | agent/turn_recovery.py:1363-1365 | `if _retry is not None and agent.clear_interrupt(preserve_redirect=True): _retry.restart_with_redirected_messages = True` | 中断保留改向 |
| E14-73 | agent/turn_recovery.py:1418-1421 | `Respect Retry-After on every retryable provider error, not just 429s ... ignoring either turns an origin outage into a retry storm` | 5xx 也读 Retry-After |
| E14-74 | agent/turn_recovery.py:1443-1444 | `A 5xx Retry-After can reach the cap; buffering it would leave the user silent for minutes.` | 长等必须播报 |
| E14-75 | agent/turn_recovery.py:1433-1435 | `The free model is busy` / `Provider overloaded` / `Rate limited` | 三种等待措辞 |
| E14-76 | agent/turn_api_error.py:111-117 | `classify_api_error(api_error, provider=..., model=..., approx_tokens=..., context_length=..., num_messages=..., base_url=..., api_key=...)` | 分类需要 7 个上下文 |
| E14-77 | agent/conversation_loop.py:1505-1534 | `while s.retry_count < s.max_retries:` `nous_rate_limit_guard → build_api_request → perform_api_call → check_api_response` | 分阶段重试循环 |
| E14-78 | agent/conversation_loop.py:1480-1481 | `_LATCHED_VERDICT_FIELDS = {"handle_api_error": frozenset({"_provider_overflow_recovery_pending"})}` | 标记只增不减 |
