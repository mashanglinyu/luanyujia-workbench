# 14 失败分类与恢复

`0.22.2+2364.g0b10b9f / <旧位置>\Hermes / agent\error_classifier.py(1535 行)、retry_utils.py(195)、fallback_cooldown.py(129)、credential_pool_model_cooldowns.py(131)、deadline.py(481)、turn_api_error.py(426)、turn_recovery.py`

> 本面是第 14 面，补的是 12 面（计费与路由）写到「降级链是列表」就停住的那一段：**失败之后到底怎么退**。
> 12 面回答「失败降到哪个模型」，本面回答「这条错误是什么、该等多久、该换哪张票、什么时候该认输」。

---

## ① 结论

1. **失败不是一个错误，是 29 个原因，每个原因自带 4 个恢复提示。** 状态码根本不够用——同一条 403 在 Hermes 里会被分成 `auth`（真没权限）、`billing`（OpenRouter 的 key limit、xAI 的 spending block 都用 403 到）、`upstream_blocked`（provider 前面的 Cloudflare 拦了）、`content_policy_blocked`（安全过滤拒绝）。四种的恢复动作互斥：刷新 token / 换票 / 换 provider / 别重试。判错的代价不是「慢一点」，是**把可恢复的当不可恢复丢掉，或把不可恢复的当可恢复反复烧钱**。

2. **恢复提示在分类时一次算定，重试循环只读提示、不再二次分类。** 这是整个层的纪律。`ClassifiedError` 上挂着 `retryable / should_compress / should_rotate_credential / should_fallback` 四个布尔，注释写得直白：`the retry loop checks these instead of re-classifying`。原因是同一个错误对象在 6 个分支里被重新判定过之后，必然出现「A 分支认为该降级、B 分支认为该压缩」的撕裂。

3. **「等多久」有三个来源，优先级是硬性的：provider 声明 > 抖动指数退避 > 限流阶梯。** 而且上限 600 秒不是拍的：Anthropic Tier 1 的 input token 桶约 171 秒重置，早期用 120 秒上限导致**二次撞限流**（#26293）。同理「有人在场时超过 60 秒就结束本轮」——用户不该为一次重试干等五分钟。

4. **冷却的粒度是 (凭据, 模型)，不是凭据。** Anthropic 的 requests/tokens per minute 是**按模型计桶**的，所以「claude-opus 被 429」完全不能推断「同一个 key 的 claude-haiku 也不可用」。按凭据冷却会让一个健康的模型被冤枉一小时。反过来，「同一 key 派生出的另一条配置」必须一起冷却，否则它会立刻被选中、再失败一次。

5. **「连续无响应」是独立的一维失败，需要独立的闸。** 一个会话钉在不响应的 provider 上，不会触发 429/5xx——它只是**每一轮都超时几十秒**。默认连续 5 次就短路报错（`HERMES_STREAM_STALE_GIVEUP`，0 关闭）。用户中途打断也算一次——**超过 30 秒毫无输出**时被打断，本身就是这次尝试不响应的证据；但已经开始吐字后被打断不算。

6. **截止层是统一原语，且必须把「我们的超时」和「provider 的超时」分开归类。** `resolve_timeout`（配置 > 遗留 env > 默认）→ `clamp_timeout`（Windows 的 DWORD 毫秒上限约 49.7 天，macOS 的 `time_t` 溢出）→ `run_bounded_*`（守护 `threading.Timer` 驱动，**被阻塞的事件循环取消不了它**）。`DeadlineExpired` 是「我们不等了」，transport timeout 是「网络不通」——混成一个会让重试策略完全错位。

---

## ② 证据

| # | 位置 | 原文（截断） | 说明 |
|---|---|---|---|
| 1 | `agent/error_classifier.py:34` | `class FailoverReason(enum.Enum):` | 29 值封闭枚举 |
| 2 | `agent/error_classifier.py:39` | `429 or quota-based throttling — backoff then rotate` | 限流两段恢复 |
| 3 | `agent/error_classifier.py:40` | `Aggregator's upstream model 429 — fallback model, key is healthy` | 上游 429 不冷却凭据 |
| 4 | `agent/error_classifier.py:41` | `403 from a WAF/CDN/proxy ... key is healthy, fallback` | 403 的 WAF 义 |
| 5 | `agent/error_classifier.py:52` | `deterministic per-request, don't retry unchanged` | 内容策略拒绝 |
| 6 | `agent/error_classifier.py:53` | `rotate credential (model-scoped), else fall back` | 无权限模型 |
| 7 | `agent/error_classifier.py:66` | `Unclassifiable — retry with backoff` | unknown 也不放弃 |
| 8 | `agent/error_classifier.py:80` | `Recovery hints — the retry loop checks these instead of re-classifying.` | 提示预计算 |
| 9 | `agent/error_classifier.py:460-461` | `_ROTATE_FALLBACK = {rotate: True, fallback: True}` / `_ABORT_FALLBACK = {retryable: False, fallback: True}` | 两种组合 |
| 10 | `agent/error_classifier.py:486-489` | `no other provider can fix that output, so falling back only replays the same broken turn 4-5 times` `(20-60s per occurrence, #12770)` | 坏 JSON 不降级 |
| 11 | `agent/error_classifier.py:797-801` | `RETRYABLE_CLIENT_REASONS = frozenset({rate_limit, upstream_rate_limit, overloaded, context_overflow, payload_too_large, long_context_tier, thinking_signature})` | 退避后才降级的 7 类 |
| 12 | `agent/error_classifier.py:965-973` | `phantom context-length error` `Reclassify as timeout.` | 推理模型超时要重归类 |
| 13 | `agent/error_classifier.py:975-978` | `as unknown it would burn every retry instantly` | 熔断后的 timeout 变体 |
| 14 | `agent/reasoning_timeouts.py:18-22` | `_REASONING_STALE_TIMEOUT_FLOORS: dict[int, tuple[str, ...]] = {600: ("nemotron-3-ultra", ...` | 按模型抬高超时下限 |
| 15 | `agent/retry_utils.py:3-4` | `Jittered delays (vs. fixed exponential) prevent thundering-herd retry spikes` | 抖动动机 |
| 16 | `agent/retry_utils.py:69-79` | `quotaResetDelay` / `resets?\s+in\s+` / `retry\s+(?:after\s+)?` / `resets_in_seconds` | 4 套自由文本语法 |
| 17 | `agent/retry_utils.py:93-95` | `An explicit "retry after N s" wins over "resets in ..." ... the shorter explicit wait is the one the provider actually asks for` | 优先级理由 |
| 18 | `agent/retry_utils.py:130` | `exponent >= 63 or base_delay <= 0` | 2^n 溢出保护 |
| 19 | `agent/retry_utils.py:132-134` | `seed = (time.time_ns() ^ (tick * 0x9E3779B9))` | 种子含计数器 |
| 20 | `agent/retry_utils.py:179` | `LIVE_RETRY_WAIT_CAP_S = 60.0` | 有人在场上限 |
| 21 | `agent/retry_utils.py:181-182` | `Anthropic Tier 1 input-token buckets reset in ~171s, so a 120s cap re-tripped the limit` `RETRY_AFTER_CAP_S = 600.0` | 600 的由来 |
| 22 | `agent/retry_utils.py:187-188` | `None when absent, unparseable or zero: a zero or expired cooldown ... would hot-loop the provider` | 0 ≠ 立即可试 |
| 23 | `agent/retry_utils.py:170-174` | `the loop gives up when retry_count >= ceiling BEFORE computing the attempt's backoff` | 上限与循环的耦合坑 |
| 24 | `agent/fallback_cooldown.py:50-52` | `reset_at is an absolute wall-clock timestamp while _rate_limited_until is monotonic; convert through a duration` | 时钟纪律 |
| 25 | `agent/fallback_cooldown.py:69` | `backoff_seconds = min(60 * (2 ** backoff_count), 14400)` | 60s 起、4h 封顶 |
| 26 | `agent/fallback_cooldown.py:60-61` | `Only arm when leaving the primary: chain-switching from an active fallback means the primary was not the failing source.` | 只在离开主模型时武装 |
| 27 | `agent/fallback_cooldown.py:25-28` | `when the primary's rate limit reopens sooner than N seconds, switching model mid-task costs more than waiting` | 等待优于切换（#117484） |
| 28 | `agent/fallback_cooldown.py:84-87` | `every turn re-fails on the primary, announces an unverified "Primary model restored", and oscillates forever (#106475)` | 振荡死循环 |
| 29 | `agent/credential_pool.py:132-138` | `EXHAUSTED_TTL_401_SECONDS = 5*60` `429 = 60*60` `DEFAULT = 60*60` `SOLE_CREDENTIAL = 60` | TTL 四档 |
| 30 | `agent/credential_pool.py:383-385` | `an OpenRouter key limit exceeded and an xAI spending block both arrive as 403 but are billing` | 403 的账单义 |
| 31 | `agent/credential_pool.py:396-397` | `if sole_credential and not is_billing` | 唯一凭据降 TTL |
| 32 | `agent/credential_pool_model_cooldowns.py:3-7` | `Anthropic enforces its API rate limits ... per model, so a generic 429 for one Claude model says nothing about ... its sibling models` | 模型粒度理由 |
| 33 | `agent/credential_pool_model_cooldowns.py:17-19` | `A Codex ChatGPT-account model entitlement 400 is a plan property, not a window` `= 365*24*60*60` | 一年冷却 |
| 34 | `agent/credential_pool_model_cooldowns.py:25-26` | `Callers that do not know the model stay conservative: any active model cooldown blocks them` | 保守读 |
| 35 | `agent/credential_pool_model_cooldowns.py:84-88` | `Siblings matter because a model_config twin seeded from the same key would otherwise be re-selected for the very model that just failed.` | 兄弟传播 |
| 36 | `agent/credential_pool_model_cooldowns.py:129` | `min(waits) - now < MODEL_ENTITLEMENT_BENCH_SECONDS / 2` | 过滤掉一年的「非窗口」 |
| 37 | `agent/credential_pool_model_cooldowns.py:48-53` | `Tokens the pool does not know fail open: no row can attribute a cooldown to them.` | 未知 token 放行 |
| 38 | `agent/chat_completion_helpers.py:547-556` | `A session wedged against an unresponsive provider would otherwise hit the stale detector on every call forever.` | 跨轮熔断动机 |
| 39 | `agent/chat_completion_helpers.py:551-553` | `reset only when a call completes or the provider is swapped ... the streak measured the OLD provider` | 换 provider 清零 |
| 40 | `agent/chat_completion_helpers.py:572-578` | `past the wait-notice interval an interrupt is evidence of an unresponsive attempt` | 中断计入的边界 |
| 41 | `agent/chat_completion_local.py:34-36` | `return env_int("HERMES_STREAM_STALE_GIVEUP", 5)` | 默认 5，0 关闭 |
| 42 | `agent/chat_completion_local.py:54-59` | `a local server that crashed ... and has since recovered gets the user's next message instead of an instant error` | 断路器放行一次 |
| 43 | `agent/deadline.py:3-5` | `timeouts: in config.yaml > legacy env var > default` `huge timeouts overflow time_t ... (#83220)` | 三层解析 + 夹紧 |
| 44 | `agent/deadline.py:6-8` | `a daemon threading.Timer ... so a blocked event loop cannot disable them` | 守护定时器 |
| 45 | `agent/deadline.py:10-12` | `a timeout here is OUR deadline, not the provider's (classify DeadlineExpired distinctly from transport timeouts)` | 两类超时必须分开 |
| 46 | `agent/deadline.py:56-59` | `_WINDOWS_MAX_WAIT_S = (0xFFFFFFFF - 1000) / 1000.0` | Windows DWORD 上限 |
| 47 | `agent/deadline.py:164-171` | `invalid config values FALL THROUGH to env/default instead of resolving as unbounded` `bool rejected ... NaN rejected` | 非法值向下穿透 |
| 48 | `agent/turn_api_error.py:60-62` | `Every fallback activation must leave the retry loop with restart_with_rebuilt_messages armed ... so the pre-API preflight re-runs against the fallback's context window (#84733)` | 降级必须重建消息 |
| 49 | `agent/turn_api_error.py:74-75` | `retry status is buffered and only flushed when every retry+fallback is exhausted` | 重试不吵用户 |
| 50 | `agent/turn_recovery.py:1777-1779` | `eager fallback for rate-limit/billing (immediately) and transport failures (after 1 retry)` `unless credential-pool rotation may still recover` | 恢复顺序 |
| 51 | `agent/turn_recovery.py:1353-1354` | `Sleep wait_time in 200 ms slices so interrupts are honoured promptly, touching activity every ~30 s` | 可中断等待 |
| 52 | `agent/turn_recovery.py:1374-1376` | `A long wait can outlive a short-lived credential (the free tier's JWT lives 15 minutes)` | 等完要重取凭据 |
| 53 | `agent/turn_recovery.py:1418-1421` | `Respect Retry-After on every retryable provider error, not just 429s ... ignoring either turns an origin outage into a retry storm` | 5xx 也读 |
| 54 | `agent/turn_recovery.py:1809-1812` | `compression.enabled: false forbids every automatic trigger ... Output-cap errors exempt.` | 关闭压缩的例外 |

---

## ③ 契约

### 3.1 分类 → 恢复提示（按 reason，不是按状态码）

```
error ──┬─ status 已知 ──→ STATUS_MAP[status] 初判
        └─ status 未知 ──→ 文本匹配（timeout / EOF / TLS）

初判后再按 body 细化（只有一个 403 需要四义辨析，顺序重要）：
  403 ─┬─ 含 CF/WAF 标记 ─────→ upstream_blocked     （key 是好的，换 provider）
       ├─ 含 credit/quota ────→ billing              （换票，60s 重试必再失败）
       ├─ 含 safety/policy ───→ content_policy_blocked（别原样重试）
       └─ 其余 ───────────────→ auth                 （刷新/轮换）
  400 + "not entitled" ──────→ model_entitlement     （模型粒度轮换）

产出（4 个布尔，重试循环只读这些）：
  retryable          还要不要原地再试
  should_compress    该压缩而不是换模型
  should_rotate      该换一条凭据
  should_fallback    该换模型/provider
```

**关键的两个反直觉取值**：

| reason | retryable | fallback | 为什么 |
|---|---|---|---|
| `format_error`（坏工具参数 JSON） | ✗ | **✗** | 别的 provider 修不了模型的坏输出，降级只会把同一轮重放 4-5 次、每次 20-60 秒（#12770）。参数修复才是正解。 |
| `timeout`（熔断器触发后的 RuntimeError） | **✗** | ✓ | 判成 `unknown` 会「瞬间烧完全部重试」（注释原文 `burn every retry instantly`）——熔断的意义就是不再发请求。 |

`RETRYABLE_CLIENT_REASONS` 这个 7 元集合是另一种语义：这些原因**可以**降级，但降级发生在**退避预算耗尽之后**，不是立刻。

### 3.2 等多久

```js
// 1. provider 说了算（任何可重试错误都读，不只 429）
retryAfter = parseRetryAfter(headers) ?? body.retry_after ?? resetFromMessage(msg)
if (retryAfter != null && retryAfter > 0) wait = min(retryAfter, 600)

// 2. 自己算：通用退避
else wait = min(2 * 2^(attempt-1), 60) + jitter
//    attempt 很大时 2^n 溢出 → 直接取 max（Hermes 的 exponent>=63 保护）

// 3. 限流类换成阶梯（撞的是配额窗，不是瞬时抖动）
if (isRateLimited) wait = min(60 * 2^(attempt-1), 14400) + 轻抖动

// 4. 播报策略
announceNow = wait > 60      // 长等待必须立刻告诉用户，否则界面静默像卡死
```

三条容易写错的：
- **`Retry-After: 0` 不是「立刻可以试」**，是「没有可用等待」→ 返回 `null`，走自己的退避。否则会对 provider 热循环。
- **抖动种子必须含计数器**。纯 `Date.now()` 在同一毫秒内的并发调用会拿到同一个种子，等于没抖动（`time_ns ^ (tick * 0x9E3779B9)`）。
- **上限 600 而非 120**：见结论 3。

### 3.3 冷却表

| 失败 | TTL | 作用域 |
|---|---|---|
| 401 | 5 分钟 | 凭据级 |
| 429 | 1 小时 | **(凭据, 模型)** |
| 5xx / 未知 | 1 小时 | 凭据级 |
| 任意非账单失败，且池里只有 1 条 | **60 秒** | 凭据级（没有可换的，长冷却等于自锁） |
| 账单（402 或 reason=billing） | 1 小时，**不受唯一凭据优惠** | 凭据级 |
| `model_entitlement` | **一年**（视作永久，需 `auth reset`） | (凭据, 模型) |

```js
cool(credentialId, model, info):
  if reason == model_entitlement:  until = now + 365d          // 计划属性，不是时间窗
  else if provider_reset_at:       until = provider_reset_at    // provider 最准
  else:                            until = now + ttlFor(...)
  // 同 API key 的兄弟条目一起冷却
  for (id of keyGroup(credentialId)) set(id, model ?? "*", max(existing, until))

blockedUntil(credentialId, model = null):
  if (model == null) any(!expired)          // 保守：调用方不知道模型就全阻塞
  else               cooldowns[model]
```

### 3.4 熔断器（连续无响应）

| 项 | 值 | 说明 |
|---|---|---|
| 阈值 | 5（`HERMES_STREAM_STALE_GIVEUP`） | 0 关闭 |
| 计数来源 | 超时被杀 / 用户中断（>30s 且未开始输出） | 已开始输出后的中断**不计** |
| 清零条件 | 调用成功 / **切换 provider** | 计数衡量的是旧 provider |
| 触发后 | 立刻抛错，**不发请求、不等超时** | 把成本从「每轮 N 秒」降到「一次」 |
| 本地模型豁免 | turn-start 时 `/health` 通就放行一次 | 崩溃后已恢复的本地服务应收到下一条消息 |

### 3.5 恢复顺序（顺序是 load-bearing 的）

```
1. 分类前的就地修复（TLS 重试等）
2. 进程正在退出？        → 放弃本回合，一行日志
3. classify              → reason + 4 布尔
4. overflow 且压缩关闭？  → 终止 + 指引（output-cap 错误豁免）
5. long_context_tier 429 → 上下文封顶 200k 再压缩
6. eager fallback        → 限流/账单立刻；传输失败先重试 1 次；
                           凭据池还能轮换时不降级；聚合站上游 429 总是降级
7. 持久 401/403          → 降级链走一次
8. 真正的 Nous 429       → 跨会话断路器 + 恰好重入一次
9. 退避等待（200ms 切片，每 30s 触摸 activity）
```

**降级必须 `break` 出重试循环并重新构建消息**——否则前一次请求的 preflight（上下文窗口检查）还是按旧模型算的（#84733）。

### 3.6 截止层

```
resolve_timeout(key) = clamp( timeouts.<dotted> ?? ENV ?? default )
clamp(x)             = min(x, Windows ? 49.7d : 365d)      // DWORD ms / time_t
run_bounded_*        = 守护 Timer 驱动；事件循环卡死也取消得了
```

不变量：**操作异常原样传播，只有「超时」这个结果被物化**。`DeadlineExpired`（我们不等了）必须与 transport timeout（网络不通）分开归类——否则重试策略会错位（一个该换 provider，一个该重试）。

---

## ④ 对 DSH 的适配

| 项 | 内容 |
|---|---|
| **DSH 现在有没有等价物** | **没有。** DSH 是本地优先、单模型、失败即失败：一条错误上来只有「重试 / 不重试」，没有原因分类、没有冷却、没有退避阶梯、没有连续无响应熔断、没有统一截止层。任务书自述的 DSH 清单中不含此面。 |
| 缺口 | ①**429 后立刻重试**——这是最贵的一种自伤：在限流窗口内反复敲门，把 1 分钟的窗口拖成 10 分钟；②**一个 403 只有一种处理**，而它可能是四种完全不同的东西；③**没有「等待 vs 换模型」的取舍**，切模型丢 prompt cache 的代价没人算；④**会话钉在不响应的 provider 上**时，每轮重走几十秒超时，用户以为程序卡死；⑤**超时值没有夹紧**，用户/配置写个巨大值会让底层 wait 原语直接抛溢出。 |
| 落点 | `packages/engine/src/recovery/`：`classify.ts`（状态码 + body 关键词 → reason + 4 布尔）、`backoff.ts`（Retry-After 三形态 + 抖动指数 + 阶梯）、`cooldown.ts`（(credential, model) 表 + 兄弟传播）、`breaker.ts`（连续 stale）、`deadline.ts`（resolve/clamp/bounded）。外壳：等待时显示「原因 + 重置时间 + 第几次尝试」。 |
| 成本 | **M**。`classify.ts` + `backoff.ts` 约 200 行，能立刻消掉 ①②③；`cooldown.ts` 与 `breaker.ts` 各约 120 行；`deadline.ts` 约 100 行（主要在 clamp 的平台分支）。参考实现 `04-参考实现/retry-backoff.mjs` 已覆盖 5 个部件，79 项自测通过，可直接移植。 |
| 失败模式 | ⚠️ **只按状态码分类** → 403 会被当成 auth 去刷新 token，而它其实是账单，刷新一万次也没用；OpenRouter 的 `key limit exceeded` 和 xAI 的 spending block 都用 403 到。⚠️ **给坏 JSON 加 fallback** → 换 provider 只是把同一轮重放 4-5 次，每次 20-60 秒，用户看到的是「卡了 3 分钟然后报错」（#12770）。⚠️ **冷却按凭据不按模型** → Anthropic 的 per-model 桶会让一个完全健康的模型被冤枉一小时。⚠️ **`Retry-After: 0` 当成 0 秒** → 热循环打爆 provider。⚠️ **退避不带抖动** → 多会话同时撞同一 provider 时形成重试尖峰，把「限流」升级成「雪崩」。⚠️ **把 epoch 直接和单调时钟比较** → 表现为「限流永远不解除」或「冷却立刻失效」，且极难定位。⚠️ **熔断计数在换 provider 后不清零** → 新 provider 被旧账拖死（计数衡量的是旧 provider）。⚠️ **降级后不重建消息** → preflight 仍按旧模型的上下文窗口算，一直撞「超限」而实际没超。⚠️ **只显示「重试中」不给原因和重置时间** → 用户不知道该等还是该切模型，唯一选择是关掉程序。 |

---

## ⑤ 实证 / 推断分界

| 判定 | 条 | 依据 / 如何验证 |
|---|---|---|
| 【实证】 | 29 个 `FailoverReason`、4 个恢复布尔、`RETRYABLE_CLIENT_REASONS` 7 元 | `error_classifier.py:34-66, 460-489, 797-801` 原文 |
| 【实证】 | `Retry-After` 上限 600s / 有人在场 60s、60s 起 4h 封顶的限流阶梯、`min(60*2^n, 14400)` | `retry_utils.py:179-182`、`fallback_cooldown.py:69` 原文 |
| 【实证】 | 冷却 TTL 四档、唯一凭据降 60s、账单不受优惠、entitlement 一年 | `credential_pool.py:132-138,371-398`、`credential_pool_model_cooldowns.py:19,92-97` 原文 |
| 【实证】 | 熔断默认 5、换 provider 清零、中断 >30s 且未输出才计 | `chat_completion_local.py:34-36`、`chat_completion_helpers.py:551-578` 原文 |
| 【实证】 | 截止层三层解析、clamp 到 49.7 天 / 365 天、守护 Timer | `deadline.py:3-12,56-59,164-171` 原文 |
| 【实证】 | 恢复顺序 9 步（含「聚合站上游 429 总是降级」「轮换仍可恢复时不降级」） | `turn_recovery.py:1775-1780` docstring 逐条列出 |
| 【推断】 | 600s 上限对**所有** provider 都合适 | 该值是针对 Anthropic Tier 1 的 171s 桶定的（注释明说）。**验证**：对其他 provider 用 60/120/600 三档各跑 200 次 429，看「等待后成功率」曲线拐点在哪。 |
| 【推断】 | 熔断阈值 5 对交互场景合适 | 无公开数据支撑，是经验值。**验证**：统计本地历史会话里「连续 stale 次数」分布，看 P95 落在哪；若 P95=2 则 5 太松。 |
| 【推断】 | DSH 的 429 后立刻重试是真实行为 | 任务书自述 + 本面在档案中此前完全空白。**验证**：在 DSH 里构造一个恒返 429 的假 provider，统计 60 秒内发出的请求数；>10 次即证实。 |
| 【未验证】 | 各 provider 实际的 `Retry-After` 合规率与准确率 | 本任务禁止联网、禁止运行目标程序，无法实测。**验证**：抓 500 条真实 429 响应的 header，比对 `Retry-After` 与实际可用时间。 |

---

## ⑥ 补充：这一面暴露的 Hermes 自身缺陷

对 DSH 最有价值的部分——**照抄会连坑一起抄**：

1. **`_exhausted_ttl` 的「唯一凭据」优惠对未验证账单生效过宽。** 源码注释承认「未验证账单可能是内容过滤伪装」，于是给短冷却（`min(base, 60)`）——但这条路径同时把 5xx 未知错误也归进同一分支（`base` 用 `EXHAUSTED_TTL_DEFAULT_SECONDS`）。结果是**一个真正 500 的 provider 在单票场景下每 60 秒被打一次**，比 1 小时冷却制造更多无效请求。

2. **`_is_sole_credential()` 只看池内条目数，不看「池是否启用」。** 用户手动指定了单一 token（不走池）时，池里可能是 0 条，`sole` 判定会走「唯一凭据」短冷却路径——但此时根本不存在轮换的可能，短冷却纯粹是自伤。

3. **熔断计数是进程内状态，不进 DB。** 网关重启后 streak 归零，一个卡死的 provider 会重新获得 5 次机会。对常驻网关这是可接受的（重启本身就说明状态该重算），但**多进程共用一个 provider 时，每个进程各自攒 5 次**，实际放行量是 5×进程数。

4. **`retry_count` 与 `max_retries` 的耦合坑（`retry_utils.py:170-174` 注释自承）**：循环在**计算本次退避之前**就用 `retry_count >= ceiling` 判放弃，所以自定义更长阶梯时必须把 ceiling 设成「阶梯长度 + 1」而不是「阶梯长度」。这个 off-by-one 在 Z.AI 特例里被显式绕过了（`zai_coding_overload_retry_ceiling()` 直接 `+1`），但其他自定义阶梯没有等价函数。

5. **`retry status is buffered` 的代价**：重试过程对用户完全静默（只在全部失败后一次性 flush）。好处是不吵，坏处是**一次 3 分钟的重试看起来和卡死一模一样**。Hermes 只在「等待 > 60s」时才播报——阈值以下仍然静默。DSH 若抄这个策略，建议把首次播报阈值降到 10-15 秒（本地优先场景用户耐心更低）。

---

**关联**：12 面（降级链的顺序）→ 本面（每一条失败的具体处理）→ 03 面（`context_overflow` 触发压缩）→ 11 面（`content_policy_blocked` 与注入拦截的区别）。
**契约**：`03-契约/failure-recovery.json`（29 reason × 恢复提示矩阵 + 退避常量 + 冷却 TTL + 恢复顺序）。
**参考实现**：`04-参考实现/retry-backoff.mjs`（5 个部件 / 79 项自测）。
**全量表**：`08-附录/A13-错误分类与恢复矩阵.md`。
**证据**：`06-证据/E14-failure-recovery.md`（78 条 path:line）。
