# 03 上下文压缩

`0.22.2+2364.g0b10b9f / <旧位置>\Hermes / agent\context_compressor*.py、micro_compaction.py、compaction_events.py、config.yaml compression 段`

## ① 结论

1. **四级阶梯，从"零成本确定性"到"最贵的模型摘要"依次升级**：`proactive_prune`（纯确定性、无 LLM、默认关）→ `micro_summarize`（滚动逐交换摘要、**默认关**，因为每次都会打断 prompt cache）→ `summarize`（批量摘要，主路径）→ `provider_native`（OpenAI Responses 服务端压缩 / Codex 线程压缩）。
2. **触发不是单一 0.8×window**：`threshold=0.50` 起步，但**<512K 窗口强制抬到 0.75**（raise-only），再叠 `model_thresholds` 逐模型覆盖与可选绝对 `threshold_tokens`（取更小者）。这样避免"回收量 < 不可压缩地板"导致的每 1–2 轮压一次。
3. **压缩是"改写历史"而非"丢弃历史"**：留下一条 `[CONTEXT COMPACTION — REFERENCE ONLY]` 的摘要 marker（DB 里 `messages._compressed_summary=1`），并在其后强制保留 ≥1 条真实用户消息作为"当前任务锚点"。
4. **失败兜底 5 层**：重试（max_attempts=3）→ 超时冷却阶梯（60s/300s/900s）→ 连续 3 次 overload 后**改走确定性降级摘要**（不再无限损失）→ 会话被标 `compression_exhausted` → gateway 自动重置会话。
5. **留痕是 42 字段的封闭 schema**（`hermes.compaction v1`），含 `tokens_before/after/reclaimed`、`attempt_id`、`trigger`、`duration_ms`。

## ② 证据

### 触发与分级

| # | 位置 | 原文（截断） |
|---|---|---|
| 1 | `config.yaml:413` | `threshold: 0.50` |
| 2 | `config.yaml:409-412` | `Models with context windows below 512K are floored at 0.75 (raise-only)` |
| 3 | `agent/context_compressor.py:2763-2767` | `Raise-only small-context threshold floor: models under 512K trigger at >= 75%` |
| 4 | `agent/context_compressor.py:1150-1152` | `at 50% the incompressible floor eats the reclaimed headroom and compaction re-fires every 1-2 turns` |
| 5 | `config.yaml:425-429` | `When set, compression fires at the LOWER of the ratio-based threshold and this absolute token count` |
| 6 | `config.yaml:415-423` | `Per-model threshold overrides: keys are substring-matched ... (longest match wins)` |
| 7 | `agent/context_compressor.py:2040` | `def resolve_model_threshold(` `longest matching model_thresholds key wins` |
| 8 | `agent/micro_compaction.py:5-6` | `OFF by default: every pass rewrites the prompt prefix and breaks the provider prompt cache` |
| 9 | `config.yaml:521-535` | `Proactive tool-result prune (default: 0 = disabled)` |
| 10 | `agent/context_compressor_prune.py:26` | `def prune_tool_results_only(` `Deterministic, no-LLM tool-result prune` |
| 11 | `config.yaml:469-476` | `Native OpenAI Responses server-side compaction (default: false)` |
| 12 | `config.yaml:461-467` | `codex_app_server_auto: native \| hermes \| off` |

### 每级清什么 / 留什么

| # | 位置 | 原文（截断） | 说明 |
|---|---|---|---|
| 13 | `config.yaml:444` | `protect_last_n: 20` | 保最后 20 条 |
| 14 | `config.yaml:496` | `protect_first_n: 3` | 保最前 3 条（永不摘要） |
| 15 | `config.yaml:435-439` | `target_ratio: 0.20` `Range: 0.10 - 0.80` | 压缩后目标 = threshold × ratio |
| 16 | `config.yaml:446-453` | `min_tail_user_messages: 1` `the tail can exceed the token budget when this pulls the cut back` | 用户锚点优先于预算 |
| 17 | `agent/context_compressor.py:832` | `_PRUNED_TOOL_PLACEHOLDER = "[Old tool output cleared to save context space]"` | 工具结果占位 |
| 18 | `agent/context_compressor_prune.py:38-46` | `(1) dedup byte-identical tool results ... (2) summarize non-tail tool results ... (3) truncate oversized tool_call arguments ... (3.5) retire image payloads` | prune 四遍 |
| 19 | `agent/context_compressor.py:1146` | `_MAX_KEEP_TOOL_IMAGES = 3` | 只留最新 3 张图 |
| 20 | `agent/context_compressor.py:852` | `SKILL_PRUNED_MARKER_PREFIX = "[SKILL_PRUNED:"` | 技能正文被摘后留"重载指针" |
| 21 | `agent/context_compressor.py:857-862` | `content lost in compression; reload with skill_view(name='{skill_name}')` | 防"幽灵技能" |
| 22 | `agent/context_compressor.py:485` | `def _prune_stale_reasoning_replay(messages)` | 旧 reasoning replay 剥掉 |
| 23 | `agent/context_compressor.py:1161-1163` | `MEDIA:\S+` `must not reach the summarizer` | MEDIA 指令剥离（否则被当活指令重发） |
| 24 | `agent/context_compressor.py:328` | `_NO_USER_TASK_SENTINEL = "None. This session contains no user-authored turns."` | 无用户轮时的显式占位 |

### 摘要模板与校验

| # | 位置 | 原文（截断） |
|---|---|---|
| 25 | `agent/context_compressor.py:261` | `"[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted "` |
| 26 | `agent/context_compressor.py:264-268` | `Do NOT answer questions or fulfill requests mentioned in this summary; they were already addressed` |
| 27 | `agent/context_compressor.py:286-288` | `Your persistent memory (MEMORY.md, USER.md) in the system prompt is ALWAYS authoritative` |
| 28 | `agent/context_compressor.py:289-291` | `your tools remain fully active` |
| 29 | `agent/context_compressor.py:504` | `_SUMMARY_END_MARKER = "--- END OF CONTEXT SUMMARY — respond to the message below, not the summary above ---"` |
| 30 | `agent/context_compressor.py:251` | `HISTORICAL_TASK_HEADING = "## Historical Task Snapshot"` |
| 31 | `agent/context_compressor.py:164` | `_TRUNCATED_SUMMARY_MARKER = "finish_reason=length"` |
| 32 | `agent/context_compressor.py:904-914` | `def _reinject_pruned_skill_markers(` `Deterministically restore prune markers the summarizer dropped` |
| 33 | `agent/context_compressor.py:820-823` | `_MIN_SUMMARY_TOKENS = 2000` / `_SUMMARY_RATIO = 0.20` / `_SUMMARY_TOKENS_CEILING = 10_000` |
| 34 | `agent/context_compressor.py:830` | `_SUMMARY_INPUT_MAX_CHARS = 160_000` `NEVER add a max_tokens wire cap on the summary call` |

### 失败兜底 / 熔断

| # | 位置 | 原文（截断） |
|---|---|---|
| 35 | `config.yaml:459` | `max_attempts: 3` |
| 36 | `agent/context_compressor.py:795` | `_TIMEOUT_COOLDOWN_LADDER = (60, 300, 900)` |
| 37 | `agent/context_compressor.py:807` | `_CONSECUTIVE_OVERLOAD_ABORT_ESCALATION = 3` |
| 38 | `agent/context_compressor.py:800-802` | `compress() commits the deterministic fallback instead` |
| 39 | `agent/context_compressor.py:826` | `_MICRO_COMPACT_MAX_CONSECUTIVE_FAILURES = 3` |
| 40 | `agent/conversation_loop.py:1710-1713` | `if s._compression_timeout_exhausted: result.update(error=_COMPRESSION_TIMEOUT_FINAL_RESPONSE, partial=True, compression_exhausted=True)` |
| 41 | `agent/context_compressor.py:753` | `_TERMINAL_SUMMARY_FAILURES = (` |

### 留痕字段 / 续跑 / 并发

| # | 位置 | 原文（截断） |
|---|---|---|
| 42 | `agent/compaction_events.py:71-79` | `"kind","scope","official","method","trigger","trigger_class",...,"tokens_before","tokens_after","tokens_reclaimed",..."compression_count","in_place","session_rotated","split_status","cache_break"` |
| 43 | `agent/compaction_events.py:32-38` | `_KINDS{summarize,micro_summarize,prune_tool_results,provider_native}` |
| 44 | `agent/compaction_events.py:37-40` | `"manual","turn_start_threshold","pre_api","post_tool","idle","engine_preflight","overflow","gateway_hygiene","between_turns","proactive_prune"` |
| 45 | `agent/compaction_events.py:44` | `_OUTCOMES = frozenset({"committed", "aborted", "failed", "skipped", "blocked"})` |
| 46 | `agent/compaction_events.py:1-3` | `no field carries message, summary, focus-topic, error or path text` |
| 47 | `agent/context_compressor.py:329-332` | `COMPRESSION_CONTINUATION_USER_CONTENT = ("Continue from the compressed conversation context above. ...)` |
| 48 | `state.db` 表 `compression_locks` | 列 `session_id, holder, acquired_at, expires_at` |
| 49 | `state.db` 表 `messages` | 列 `_compressed_summary, active, compacted, api_content, absorbed_message_uids` |
| 50 | `agent/conversation_loop.py:1097` | `def _compression_deferred_result(agent, messages, api_call_count, reason="lock")` |

## ③ 契约（伪代码）

```python
def maybe_compress(agent, msgs, billed_tokens) -> Result:
    p = est(msgs)
    # L0：确定性 prune（无 LLM）
    if cfg.proactive_prune_tokens > 0 and p >= cfg.proactive_prune_tokens:
        out, reclaimed = prune_tool_results_only(msgs, billed_tokens)   # dedup/摘要/截参/退图
        if reclaimed >= cfg.proactive_prune_min_reclaim_tokens: commit(out)  # 换 cache break 值得才提交

    # L1：滚动 micro（默认关）
    if cfg.micro_compact and over_threshold: micro_absorb_one_exchange()

    # L2：批量摘要（主路径）
    if billed_tokens >= threshold_tokens:                     # min(ratio*ctx, threshold_tokens_abs)
        for attempt in range(cfg.max_attempts):                # 3
            try:
                summary = call_summary_model(build_summary_input(msgs))  # ≤160k chars, 无 max_tokens 线帽
                if finish_reason == "length": raise Truncated
                new = [system] + head[:protect_first_n] + [marker(summary)] + tail(protect_last_n, ≥1 user)
                commit(new); emit(hermes.compaction{v1, 42 字段}); hook("post_compaction")
                return Continue(COMPRESSION_CONTINUATION_USER_CONTENT)
            except Timeout:
                cooldown = ladder[streak]                      # 60/300/900
            except Overload:
                if ++overload_streak >= 3: return DeterministicFallback()   # 不再重试
        return Partial(compression_exhausted=True)
```

**关键不变量**
- 摘要 marker 必须在 system 之后、真实用户消息之前；且"若 marker 之后没有用户消息，模型必须什么都不做"（`SUMMARY_PREFIX` 明确写了 do nothing）。
- 摘要里被摘掉的 skill 正文，其 `[SKILL_PRUNED:...]` 标记要**确定性回填**，不能靠摘要模型记得。
- 压缩不打断正在跑的 run：先抢 `compression_locks`，抢不到返回 `_compression_deferred_result(reason="lock")`，这一轮**不带压缩继续**。

## ④ 对 DSH 的适配

| 项 | 内容 |
|---|---|
| DSH 现状 | **半有**：单级压缩、0.8×window 触发、无 prune/micro/native 分级、无 leave-trace 字段、无 small-ctx 地板、无失效熔断。 |
| 缺口 | ①0.8 对 128K 模型太晚（剩 25K 才压，压完立刻又满）；②只有"丢+摘要"，没有"确定性回收"，一次压缩就烧一次 LLM 调用 + 一次 cache 全失；③压完不知道为什么压、省了多少；④连续压缩失败会无限重试。 |
| 落点 | 引擎：`packages/engine/src/context/`（新增 `prune.ts` / `summarize.ts` / `policy.ts` / `trace.ts`）；配置：`threshold` 下沉到 per-model 表。 |
| 成本 | **L**。prune（确定性）S，只有 ~200 行；批量摘要 M；native/provider 分支 S 但依赖 provider 能力；trace 字段 S。建议按 `prune → threshold 地板 → trace` 顺序落地。 |
| 失败模式 | ⚠️ **抄 prune 抄成"删工具结果"** → 模型看到 `{}` 会重跑同一命令，陷入循环；必须换成带解释的占位 `[Old tool output cleared to save context space]`。⚠️ **抄 micro-compaction** → 它在 Hermes 里默认关，因为每轮改写前缀会把 prompt cache 打穿，KV 成本反升；DSH 若默认开，会看到"省钱功能让账单变贵"。⚠️ **摘要前缀写弱了** → Hermes 踩过：去掉"tools remain fully active"这句后，模型连续 7 轮只说不做（`context_compressor.py:255-258` 注释）。⚠️ 摘要里若出现 MEDIA/工具指令原文，会被下游当活指令重放。 |

## ⑤ 实证 / 推断分界

| 判定 | 条 | 依据 / 如何验证 |
|---|---|---|
| 【实证】 | 四级阶梯、各级默认值、0.75 raise-only 地板、42 字段留痕 schema、熔断阶梯 60/300/900 | `context_compressor*.py` 常量与函数原文 + `config.yaml:377-545` 注释 |
| 【实证】 | `micro_summarize` 默认关 | 配置默认值即 false，非推断 |
| 【推断】 | micro 默认开会打穿 prompt cache 导致账单反升 | 机制推断（改写前缀 ⇒ cache miss），Hermes 没有给出量化数据。**验证**：同会话开/关各 20 轮，比 cache_read 占比 |
| 【推断】 | DSH 只有一级压缩 | 任务书自述。**验证**：grep 引擎里 summarize 调用点数，看是否存在非 LLM 的前置剪枝 |
| 【未验证】 | provider_native 档在各厂商的实际行为差异 | 需真机调各厂商 API；本任务禁止联网 |

---

## ⑥ 图片在上下文里的生命周期（本轮补）

> ②证据第 18 行只写了 prune 的第 3.5 遍是 `retire image payloads`，一句话，没有展开。
> 实际这一块有 **1213 行**（`image_eviction_policy.py` 288 + `image_routing.py` 566 + `vision_message_prep.py` 359），
> 而且它是整个压缩面里**唯一一个"淘汰时机"比"淘汰多少"更重要的**地方。
> 参数全表见 `08-附录/A15`，机器可读契约见 `03-契约/image-eviction.json`，可跑实现在 `04-参考实现/image-evict.mjs`（34 项自测）。

### 6.1 两层，方向相反

| 层 | 何时 | 做什么 | 文件 |
|---|---|---|---|
| **入站路由** | 用户附图进来 | `native`（原图作为 `image_url` part）/ `text`（先跑 `vision_analyze`，只把有损描述插进去） | `image_routing.py` |
| **出站驱逐** | 每次请求前，在**请求副本**上 | 淘汰旧的工具结果图片 | `image_eviction_policy.py` |

入站模式的判定（`decide_image_input_mode`，每回合算一次）：

```
auto 模式下：
  配了 auxiliary.vision 后端        → text（即使主模型支持视觉，也强制走文字描述）
  否则看 supports_vision（配置覆盖或模型目录）
native 是绝对覆盖；text 永远安全但丢信息
vision_analyze 无论哪种模式都仍是工具
```

### 6.2 核心判断：淘汰触发器是 provider 硬限制，不是「保留最新 N 张」

这是整块里最反直觉、也最值得抄的一条。`image_eviction_policy.py:10-14` 的自述：

> `retiring an image edits a message the provider has already cached, and Anthropic matches its prompt cache on an exact byte prefix. A keep-newest-N window retires one more message on every new image, so every turn is a full-prefix miss.`

翻译成因果链：

```
淘汰一张图 = 改写一条 provider 已缓存的消息
          → 缓存按"精确字节前缀"匹配
          → keep-newest-N 策略下，每来一张新图就多淘汰一条
          → frontier 每轮前移一格
          → 每一轮都是全前缀 miss
```

正确做法是**攒着，直到请求真要撞上硬限制，再批量淘汰**：每批只付一次慢，限制以下零代价。

> 这和 `micro_summarize` 默认关（03 面已有记录）是**同一条原理**的两次体现：
> **任何"每轮改写前缀"的省 token 手段，都会用 cache miss 把钱还回去。**
> 区别只是 micro 改的是文本，图片驱逐改的是消息结构。

### 6.3 「20 张」是条件阈值，不是绝对阈值

Anthropic 的规则：一次请求里图片**超过 20 张**时，会对**所有**图片施加更严的单边 2000px 上限（含嵌套在 `tool_result` 里的）。

直觉结论是"到 20 就淘汰"。Hermes 的判断是**不一定**，因为：

1. Hermes 自己产生的工具图早就缩到 **1568px**（`vision_analyze` / 浏览器截图）、**1456px**（`computer_use`），远低于 2000；
2. 所以**第 21 张截图并不会触发任何 provider 约束**——在这里批量淘汰，纯粹是白付一次全前缀重写；
3. 在 preserved-thinking 模型上，重写还会**让之后所有 thinking block 失效**；
4. Anthropic 自己的 computer-use 指南也说：截图保持在 ≤2000px，**不要在客户端剪**。

于是阈值变成条件式：

| 条件 | 块上限 | 理由 |
|---|---|---|
| 请求里**存在**某张图超过 2000px | **20** | 严格上限确实生效，淘汰真的在保护请求 |
| 全部图片都 ≤2000px（或可读且合规） | **100** | 20 只是文档阈值，不触发约束；100 才是 200K 上下文的真实硬限制 |
| 尺寸**读不出来** | **20** | 未知 = 不安全，保持严格 |

另有字节维度：`OUTBOUND_IMAGE_BUDGET_BYTES = 24_000_000`（24MB），给文本留余量。
注释说 32MB 的请求体限制通常**先于**张数限制起作用。

### 6.4 淘汰数量必须是阶梯函数

这是最容易写错的一处。`outbound_image_retire_count` 的 docstring：

> `The retire count must be a STEP FUNCTION of the overshoot, because the pass is recomputed on every request: an exact count - limit target moves the frontier on every new image, and a fixed one-batch retire stops enforcing the limit after the first batch.`

两种天真的做法都错：

| 做法 | 错在哪 |
|---|---|
| 精确淘汰 `count - limit` 张 | 每来一张新图，目标就变 → frontier 每轮移动 → 又回到全前缀 miss |
| 固定淘汰「一批」后停手 | 第一批之后就再不执行限制 → 撞 provider 硬限制 |

正确做法：按**量子**（quantum）递进，直到装得下。

```
quantum = clamp(batch=8, 1, window - floor)
window  = 在 ceiling 下能容纳的最新 carrier 数
floor   = 3（可满足性下限）
```

`quantum` 为什么要被 `window - floor` 夹住：量子过宽会**每步都越过最新几帧**；而把每步砍到恰好 `total - floor` 又会让淘汰数重新跟着 `total` 走——也就是这个策略存在的目的（避免 per-image frontier）又回来了。

### 6.5 `floor = 3` 是可满足性下限，不是"至少留 3 张"

| 场景 | 行为 |
|---|---|
| 保留的上传**自己**就超了块上限 | 庇护最新 3 帧——淘汰也救不了，但**仍然按整量子推进** |
| 字节预算压力 | **不庇护**——请求体限制是硬的，provider 会直接回 413 |
| 其余 | 正常按量子淘汰 |

注释点出了一个坑（#133999）：在第一种场景里"淘汰到恰好 `total - floor`"会让 frontier 每张新图都移动；量子被**字节预算允许保留的数量**夹住，所以字节压力会收窄步长而不是塌回 floor。

### 6.6 每个 session 锁存已淘汰的 id

每次请求都从零决策，看不到历史。于是出现：

```
请求 A：上传还在重放窗口内 → 上限紧 → 淘汰了截图 1..8
请求 B：上传滑出重放窗口 → 上限放松 → 从零决策 → 判定"不必淘汰"
        → 截图 1..8 被恢复 → 缓存前缀又被改回去
```

所以按 `agent.session_id` 锁存 `_outbound_retired_image_ids`（tool_call id 集合），新会话或压缩轮转时清空。
`latched_retire_count` 会把淘汰数**加宽**到"至少覆盖上一次已淘汰的最新那张"，然后记录本次淘汰的 id。

### 6.7 只读 header，不解码全图

`_DIMENSION_PROBE_CHARS = 32 * 1024`——只解码 base64 的前 32KB 前缀。

| 格式 | 读法 |
|---|---|
| PNG | 检查 8 字节魔数 `\x89PNG\r\n\x1a\n`，直接取 IHDR（offset 16..24） |
| JPEG | 从 offset 2 走 segment，跳过 `0xFF` 填充，找到第一个 SOF 标记 |
| 其他 / 远程 URL | 返回 `None`（当作不安全） |

理由是成本：一个几十张图的请求，如果每张都全量解码 base64，光判定就要几秒。
**未知尺寸按不安全处理**，即保持严格触发——这个方向的失败是"多淘汰一次"，不是"撞限制"。

### 6.8 两个 pass 必须共用同一策略

同一次请求有两处驱逐：

```
agent.context_compressor.evict_stale_outbound_tool_images   （OpenAI 形状的列表）
agent.anthropic_message_convert._evict_old_screenshots      （Anthropic 线格式）
```

两者都在**每次请求的副本**上从零跑。如果策略不一致，第二个 pass 会在**另一个 frontier** 上再淘汰一次（#113517）。
所以策略被抽成 stdlib-only 的独立模块，让线格式转换器（一个叶子节点）能直接 import，而不用拖进整个压缩栈。

### 6.9 对 DSH 的适配

| 项 | 内容 |
|---|---|
| DSH 现状 | **没有**。DSH 若尚无多模态，这块可以先不做；一旦支持图片，就必须有。 |
| 缺口 | ①没有"入站 native/text"的路由（非视觉模型会被塞进它看不懂的 image part）；②没有出站驱逐，图片永久留在历史里；③如果按"保留最新 N 张"实现，会让 prompt cache 每轮全失效。 |
| 落点 | 引擎 `context/image_policy.ts`：`classifyRequest()`（读 header 判尺寸）+ `retireCount()`（阶梯函数）+ `latch`（按 session 锁存）。**放行前先确认 DSH 是否真的在用 provider 的 prompt cache**，否则第二条收益不存在。 |
| 成本 | **M**。纯函数约 250 行（PDG/JPEG 头解析 ~80 行、阶梯函数 ~60 行、latch ~30 行），无状态、无依赖。 |
| 抄的顺序 | ①只读 header 的尺寸判定（S，独立可用）②条件阈值（S）③阶梯函数（M）④latch（S）。**不要先做"保留最新 N 张"**——它看起来最自然，但正是要避免的那个。 |
| 失败模式 | ⚠️ 按 keep-newest-N 实现 → 每轮全前缀 miss，账单反升（与 micro-compaction 同一个坑）。⚠️ 把 20 当绝对阈值 → 在 1568px 的截图上白付一次前缀重写，并让 thinking block 失效。⚠️ 精确淘汰 `count - limit` → frontier 每轮移动。⚠️ 不做 latch → 上传滑出窗口后已淘汰的图被恢复。 |

### 6.10 这一节的实证边界

| 判定 | 内容 | 依据 |
|---|---|---|
| 【实证】 | 触发器是 provider 限制而非 keep-newest 计数 | `image_eviction_policy.py:10-14` 原文 |
| 【实证】 | 20 是条件阈值；有超 2000px 才严格 | `:16-33` 全文 + `outbound_image_block_limit()` |
| 【实证】 | 阶梯函数与 quantum 夹法 | `:168-186` docstring + `:281` |
| 【实证】 | floor=3 仅在可满足性场景庇护 | `:180-185` |
| 【实证】 | latch 按 session 锁存 | `:210-240` |
| 【实证】 | 只读 32KB header 前缀 | `:56-59`、`:92-117` |
| 【实证】 | 两个 pass 必须一致（#113517） | `:5-8` |
| 【推断】 | 24MB 字节预算通常先于张数限制生效 | 注释明说（`:31-32`），但未实测各 provider 的 413 阈值。**验证**：构造 25MB 请求看是否 413 |
| 【未验证】 | 「第 21 张截图不触发约束」在非 Anthropic provider 上是否成立 | 该判断针对 Anthropic 的多图规则；OpenAI/Gemini 的规则未读。**验证**：逐家查文档 + 构造 21 张图请求 |
