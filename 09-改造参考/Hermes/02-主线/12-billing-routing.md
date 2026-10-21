# 12 计费与模型路由

`0.22.2+2364.g0b10b9f / <旧位置>\Hermes / agent\usage_pricing.py、billing_usage.py、models_dev.py、config.yaml auxiliary 段`

## ① 结论

1. **token 口径是"先归一化再计费"**：三套 usage 形状（Anthropic messages / Codex Responses / OpenAI Chat）统一成 `CanonicalUsage{prompt, output, cache_read, cache_write, reasoning}`，再按 provider+model 查价。
2. **成本有四种可信度**：`actual`（provider 回传真实账单）/ `estimated`（按 rate card 算）/ `included`（订阅内，无单价）/ `unknown`。**展示时必须带这个标签**，否则用户无法区分"真的花了"和"估的"。
3. **价目表来自 `models.dev` 的本地快照**（`models_dev_cache.json` 5.8 MB），只在**直连厂商域名**时才认它的价格；代理/中转/自定义端点一律不算，因为"同一个模型 id 换个网关就换账单"。
4. **路由有四层，优先级从高到低**：会话级 `/model` 覆盖 > API server 的 `model_routes`（按客户端发来的 model 字符串别名）> 全局 `model:` > provider 默认。
5. **没有成本上限**。只有墙钟预算（`run_budget_seconds`）与迭代预算（`max_iterations`）。**这是它最明显的缺失**。

## ② 证据

| # | 位置 | 原文（截断） | 说明 |
|---|---|---|---|
| 1 | `agent/usage_pricing.py:58` | `CostStatus = Literal["actual", "estimated", "included", "unknown"]` | 成本可信度 |
| 2 | `agent/usage_pricing.py:626-631` | `Normalize raw API response usage into canonical token buckets (Anthropic, Codex Responses, or OpenAI Chat Completions shape)` | 归一化 |
| 3 | `agent/usage_pricing.py:638-643` | `if mode == "anthropic_messages" or provider_name == "anthropic": shape = _ANTHROPIC_USAGE_SHAPE` | 形状选择 |
| 4 | `agent/usage_pricing.py:24-27` | `_MODELS_DEV_DIRECT_HOSTS = {"openai": "openai.com", "xai": "x.ai", "anthropic": "anthropic.com", ...}` | 只认直连 |
| 5 | `agent/usage_pricing.py:19-23` | `a proxy, relay or custom endpoint serving the same model id may bill differently` | 为什么不认中转 |
| 6 | `agent/usage_pricing.py:32` | `_SUBCENT_THRESHOLD = Decimal("0.01")` | 分位显示阈值 |
| 7 | `agent/usage_pricing.py:37` | `_INCLUDED_NOTE = "subscription-included; no provider invoice for usage"` | included 的含义 |
| 8 | `agent/usage_pricing.py:39-44` | `sub-cent → "~$0.0046" (4 dp, or "~$<0.0001" when it rounds to 0.0000 so the label never reads as zero)` | 展示规则 |
| 9 | `agent/usage_pricing.py:15-16` | `_ZERO = Decimal(0)` `_ONE_MILLION = Decimal(1000000)` | 用 Decimal 不用 float |
| 10 | `agent/usage_pricing.py:163-164` | `_OPUS = ("5.00","25.00","0.50","6.25")` `_SONNET = ("3.00","15.00","0.30","3.75")` | 内置回退价（in/out/cache_read/cache_write） |
| 11 | `agent/models_dev.py:1-8` | `in-memory cache → disk cache (~/.hermes/models_dev_cache.json) → network only when no cache exists` | 三级缓存策略 |
| 12 | `agent/models_dev.py:6-8` | `A corrupt/empty disk cache is quarantined, never served as {}` | 坏缓存不当地址空表 |
| 13 | `models_dev_cache.json` | 5,851,751 B，mtime 2026-10-20 13:15 | 本机实际快照 |
| 14 | `state.db` 表 `session_model_usage` | `session_id, model, billing_provider, billing_base_url, billing_mode, task, api_call_count, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, estimated_cost_usd, actual_cost_usd, cost_status, cost_source` | 用量台账（按 task 拆行） |
| 15 | `grep task="…"`（agent/*.py） | `background_review` / `moa_aggregator` / `moa_reference` / `title_generation` | 旁路任务单独计费 |
| 16 | `config.yaml:826-847` | `model_routes: minimax-m2: model: "minimax/minimax-m1" provider: "openrouter"` | 按客户端别名路由 |
| 17 | `config.yaml:826-830` | `Unmapped model values fall back to the global model ... an explicit session /model override always wins` | 优先级 |
| 18 | `config.yaml:631-643` | `auxiliary: vision: provider/model/timeout/reasoning_effort` | 旁路任务独立模型 |
| 19 | `config.yaml:640` | `Works on every auxiliary task block (vision, web_extract, compression, title_generation, curator, background_review, moa_reference, ...)` | 旁路任务清单 |
| 20 | `agent/agent_init_fallback.py:11` | `def _fallback_entries(fallback_model) -> list[dict]` | 降级链是**列表** |
| 21 | `agent/agent_init_fallback.py:29-34` | `agent._fallback_chain = _fallback_entries(fallback_model)` `agent._fallback_model = agent._fallback_chain[0]` | 链首为当前 |
| 22 | `agent/moa_loop.py:160-161` | `Cost is priced at the advisor's OWN rate and summed in dollars` | 扇出计费按各自费率累加 |
| 23 | `agent/agent_init.py:324` | `def _normalize_run_budget_seconds(value)` | 只有时长预算 |
| 24 | `agent/iteration_budget.py:36` | `def refund(self) -> None:` | `execute_code` 退还预算 |
| 25 | `agent/billing_view.py`（存在） | 计费视图模块 | 展示层 |

## ③ 契约

```
# 一次调用的计费流程
usage_raw  --normalize_usage(provider, api_mode)-->  CanonicalUsage
                                                      ├ prompt_tokens
                                                      ├ output_tokens
                                                      ├ cache_read_tokens      ← 便宜（~0.1x）
                                                      ├ cache_write_tokens     ← 贵（1.25x / 2x）
                                                      └ reasoning_tokens       ← 通常并入 output
rate_card  = models_dev.lookup(provider, model)  ── 仅当 base_url 是直连厂商域
cost       = Σ(tokens × unit_price)  -> Decimal, 4 位有效
cost_status ∈ {actual, estimated, included, unknown}
```

**模型路由优先级**

| 层 | 触发 | 例 |
|---|---|---|
| 1 | 会话 `/model` 覆盖 | 用户手动切 |
| 2 | API server `model_routes[<caller model string>]` | 客户端发 `model="minimax-m2"` → 映射到 openrouter |
| 3 | 全局 `model:` | 默认 |
| 4 | provider 默认 | 如 openrouter 缺省 `google/gemini-3-flash-preview` |

**旁路任务的模型映射**（这是 DSH 完全没有的一层）

`auxiliary.<task>.{provider, model, timeout, reasoning_effort}`，`<task> ∈ {vision, web_extract, compression, title_generation, curator, background_review, moa_reference, review, ...}`。目的：**压缩、起标题、抽网页这类"重活但不需要最强模型"的任务，钉到便宜模型上**。

**失败降级到哪个模型**

`_fallback_chain` 是**列表**（不是单个）：主模型失败 → 链首 → 链下一个 ……；切换时 `_arm_fallback_restart` 会重建请求并重新跑本轮的 API 调用（`conversation_loop.py:1193`）。降级是**按请求**发生的，不是按会话；失败原因进 `error_classifier.FailoverReason`。

> **本面到此为止。** 「失败原因具体是哪 29 类、每类该等多久、该换票还是换模型、什么时候该认输」在 `02-主线/14-failure-recovery.md`——本面只回答「降到哪个模型」。

## ④ 对 DSH 的适配

| 项 | 内容 |
|---|---|
| DSH 现状 | **没有**（DSH 的清单里没有计费/路由这一面）。DSH 是本地优先、单模型，token 统计口径与成本展示都缺。 |
| 缺口 | ①用户不知道一次会话花了多少；②压缩用的模型和主模型是同一个（贵模型干粗活）；③没有成本上限，跑飞了只能靠墙钟预算拦。 |
| 落点 | 引擎：`packages/engine/src/billing/`（`normalize.ts` + `pricing.ts` + `ledger.ts`，落 SQLite 按 `task` 拆行）；外壳：状态栏显示 `本次/本会话 成本 + cost_status`。 |
| 成本 | **M**。归一化 S，价目表 M（要自己维护一份本地 JSON，别联网），台账 S，旁路模型路由 S。 |
| 失败模式 | ⚠️ **用 float 算钱** → 累加误差让总额对不上账单；Hermes 全程 `Decimal`。⚠️ **把 cache_read / cache_write 当普通 input 计价** → 成本高估 5–10 倍（cache read 通常 0.1x，cache write 1.25x/2x）。⚠️ **中转端点套用官方价目** → Hermes 明确只认直连域名（`usage_pricing.py:19-27`）；DSH 本地优先，更该只对自己配置的端点用固定价。⚠️ **只显示 `$0.00`** → 便宜模型的单轮成本会被四舍五入成 0；Hermes 用 4 位小数并加 `~`。⚠️ **没有 cost_status** → 用户以为"估的"就是"实扣的"。 |

## ⑤ 实证 / 推断分界

| 判定 | 条 | 依据 / 如何验证 |
|---|---|---|
| 【实证】 | `CostStatus = actual/estimated/included/unknown`、`auxiliary.<task>` 旁路映射、`_fallback_chain` 是列表、路由优先级表 | `usage_pricing.py`、`config.yaml:631-660,826-847` 原文 |
| 【实证】 | `models_dev` 只在直连厂商域才认价 | 代码里有域名判定分支 |
| 【推断】 | 把聚合站价当厂商价会系统性偏离 | 由分支存在推断设计意图。**验证**：同模型分别用直连与聚合站报价，比单价差 |
| 【推断】 | DSH 无 task 维度用量 | 任务书自述。**验证**：查 DSH 用量表主键 |
| 【未验证】 | `models_dev` 价格的时效与准确性 | 本任务禁止联网，未拉取该数据源核对 |
