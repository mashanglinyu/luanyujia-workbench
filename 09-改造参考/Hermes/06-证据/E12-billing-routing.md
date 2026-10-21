# 证据 E12 — 计费与模型路由

`0.22.2 / agent\usage_pricing.py, models_dev.py, config.yaml auxiliary 段`

| # | 路径:行 | 原文（≤40 字） | 说明 |
|---|---|---|---|
| E12-01 | agent/usage_pricing.py:58 | `CostStatus = Literal["actual", "estimated", "included", "unknown"]` | 四种可信度 |
| E12-02 | agent/usage_pricing.py:630 | `Normalize raw API response usage into canonical token buckets` | 归一化 |
| E12-03 | agent/usage_pricing.py:638 | `if mode == "anthropic_messages" or provider_name == "anthropic":` | 形状分支 |
| E12-04 | agent/usage_pricing.py:24 | `_MODELS_DEV_DIRECT_HOSTS = {` | 只认直连 |
| E12-05 | agent/usage_pricing.py:21 | `a proxy, relay or custom endpoint serving the same model id may bill differently` | 为什么不认中转 |
| E12-06 | agent/usage_pricing.py:32 | `_SUBCENT_THRESHOLD = Decimal("0.01")` | 分位显示 |
| E12-07 | agent/usage_pricing.py:37 | `_INCLUDED_NOTE = "subscription-included; no provider invoice` | included 语义 |
| E12-08 | agent/usage_pricing.py:15 | `_ZERO = Decimal(0)` | Decimal 不用 float |
| E12-09 | agent/usage_pricing.py:163 | `_OPUS = ("5.00", "25.00", "0.50", "6.25")` | 内置回退价 |
| E12-10 | agent/models_dev.py:4 | `disk cache (~/.hermes/models_dev_cache.json), any age` | 三级缓存 |
| E12-11 | agent/models_dev.py:7 | `A corrupt/empty disk cache is quarantined, never served as` | 坏缓存隔离 |
| E12-12 | models_dev_cache.json | 5,851,751 B（实测） | 本机快照 |
| E12-13 | state.db / session_model_usage | `model, billing_provider, billing_mode, task, cache_read_tokens, cost_status` | 台账字段 |
| E12-14 | state.db / session_model_usage | `task` 取值含 `background_review` / `moa_aggregator` / `title_generation` | 旁路任务拆行 |
| E12-15 | config.yaml:836 | `model_routes:` | 按客户端别名路由 |
| E12-16 | config.yaml:829 | `an explicit session /model override always wins over a route` | 优先级 |
| E12-17 | config.yaml:631 | `auxiliary:` | 旁路任务独立模型 |
| E12-18 | config.yaml:640 | `vision, web_extract, compression, title_generation, curator` | 可钉模型的 task |
| E12-19 | agent/agent_init_fallback.py:29 | `agent._fallback_chain = _fallback_entries(fallback_model)` | 降级链是列表 |
| E12-20 | agent/moa_loop.py:161 | `Cost is priced at the advisor's OWN rate and summed in dollars` | 扇出累加 |
| E12-21 | agent/agent_init.py:324 | `def _normalize_run_budget_seconds(value)` | 只有时长预算 |

复核：`grep -n "CostStatus\|format_cost_label\|normalize_usage" agent/usage_pricing.py`
