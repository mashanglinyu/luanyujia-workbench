# 证据 E16 — 图片生命周期 / 出站驱逐

`0.22.2 / agent\{image_eviction_policy,image_routing,vision_message_prep}.py`

复现命令（在 `<旧位置>\Hermes\hermes-agent` 下）：

```bash
sed -n '1,60p' agent/image_eviction_policy.py
sed -n '63,120p;143,206p;210,241p;242,289p' agent/image_eviction_policy.py
sed -n '1,40p' agent/image_routing.py
grep -n "def decide_image_input_mode" -A 45 agent/image_routing.py
sed -n '1,20p' agent/vision_message_prep.py
grep -rn "evict_stale_outbound_tool_images\|_evict_old_screenshots" --include="*.py" agent/
```

| # | 路径:行 | 原文（≤40 字） | 说明 |
|---|---|---|---|
| E16-01 | agent/image_eviction_policy.py:1-2 | `Send-path image eviction policy shared by both stateless outbound passes` | 两个 pass 共用一个策略 |
| E16-02 | agent/image_eviction_policy.py:3-4 | `context_compressor.evict_stale_outbound_tool_images on the OpenAI-shaped list` | pass 1 |
| E16-03 | agent/image_eviction_policy.py:4-5 | `anthropic_message_convert._evict_old_screenshots on the Anthropic wire list` | pass 2 |
| E16-04 | agent/image_eviction_policy.py:5-6 | `Both run from scratch on a fresh clone every request` | 每请求从零跑 |
| E16-05 | agent/image_eviction_policy.py:6-7 | `they must agree on one policy or the second pass re-evicts on a different frontier (#113517)` | 不一致的后果 |
| E16-06 | agent/image_eviction_policy.py:7-8 | `stdlib-only so the wire converter, a leaf, can import it` | 为什么抽成独立模块 |
| E16-07 | agent/image_eviction_policy.py:10-11 | `retiring an image edits a message the provider has already cached` | 淘汰 = 改写已缓存消息 |
| E16-08 | agent/image_eviction_policy.py:11 | `Anthropic matches its prompt cache on an exact byte prefix` | 精确字节前缀匹配 |
| E16-09 | agent/image_eviction_policy.py:12-13 | `A keep-newest-N window retires one more message on every new image, so every turn is a full-prefix miss` | **本面核心结论** |
| E16-10 | agent/image_eviction_policy.py:13-14 | `Holding images until the request would cross a real API limit and then retiring a batch costs one slower turn per batch` | 正确做法 |
| E16-11 | agent/image_eviction_policy.py:16-18 | `20 is the documented threshold at which Anthropic applies a stricter per-image dimension cap (2000 px)` | 20 的来源 |
| E16-12 | agent/image_eviction_policy.py:18 | `Crossing it costs nothing by itself: it only matters when some image actually exceeds 2000 px` | **20 不是绝对阈值** |
| E16-13 | agent/image_eviction_policy.py:19-21 | `vision_analyze and browser screenshots embed at 1568 px, computer_use at 1456 px` | 自己的图早已缩过 |
| E16-14 | agent/image_eviction_policy.py:21-24 | `the 21st screenshot of a run trips no provider constraint` | 第 21 张不触发约束 |
| E16-15 | agent/image_eviction_policy.py:22-23 | `on the preserved-thinking models, invalidates every later thinking block` | 白淘汰的额外代价 |
| E16-16 | agent/image_eviction_policy.py:23-24 | `Anthropic's own computer-use guidance now says to keep screenshots at or under 2000 px and NOT to prune them client-side` | 官方指引佐证 |
| E16-17 | agent/image_eviction_policy.py:26-28 | `the strict 20 applies only when some image exceeds MANY_IMAGE_DIMENSION_LIMIT` | 条件阈值的定义 |
| E16-18 | agent/image_eviction_policy.py:29-31 | `100 images per request on 200K-context models, 600 otherwise` | 真实硬限制 |
| E16-19 | agent/image_eviction_policy.py:30-31 | `the 32 MB request-size limit usually binds first, which the byte budget guards with headroom for text` | 字节维度先起作用 |
| E16-20 | agent/image_eviction_policy.py:32-33 | `Classification reads image HEADERS only — never a full decode of every base64 payload` | 只读 header |
| E16-21 | agent/image_eviction_policy.py:33 | `treats unreadable or unknown dimensions as unsafe` | 未知 = 不安全 |
| E16-22 | agent/image_eviction_policy.py:42 | `OUTBOUND_IMAGE_LIMIT = 20` | 严格上限 |
| E16-23 | agent/image_eviction_policy.py:47 | `OUTBOUND_IMAGE_HARD_LIMIT = 100` | 硬上限（不是 600） |
| E16-24 | agent/image_eviction_policy.py:48 | `OUTBOUND_IMAGE_BUDGET_BYTES = 24_000_000` | 字节预算 |
| E16-25 | agent/image_eviction_policy.py:49 | `IMAGE_EVICTION_BATCH = 8` | 量子宽度 |
| E16-26 | agent/image_eviction_policy.py:51 | `OUTBOUND_IMAGE_FLOOR = 3` | 可满足性下限 |
| E16-27 | agent/image_eviction_policy.py:55 | `MANY_IMAGE_DIMENSION_LIMIT = 2000` | 单边上限 px |
| E16-28 | agent/image_eviction_policy.py:59 | `_DIMENSION_PROBE_CHARS = 32 * 1024` | 探测窗口 |
| E16-29 | agent/image_eviction_policy.py:68 | `width, height = struct.unpack(">II", raw[16:24])` | PNG IHDR 偏移 |
| E16-30 | agent/image_eviction_policy.py:86-87 | `return int.from_bytes(raw[i + 5:i + 7], "big"), int.from_bytes(raw[i + 3:i + 5], "big")` | JPEG：width 在 i+5，height 在 i+3 |
| E16-31 | agent/image_eviction_policy.py:109 | `prefix = prefix[: len(prefix) - (len(prefix) % 4)]` | base64 截断到 4 的倍数 |
| E16-32 | agent/image_eviction_policy.py:126-127 | `return longest is not None and longest <= MANY_IMAGE_DIMENSION_LIMIT` | 合规判定（含边界） |
| E16-33 | agent/image_eviction_policy.py:133-135 | `one oversized image holds every image in the request to the stricter cap` | per-request 语义 |
| E16-34 | agent/image_eviction_policy.py:145 | `return OUTBOUND_IMAGE_HARD_LIMIT if many_image_safe else OUTBOUND_IMAGE_LIMIT` | 上限选择 |
| E16-35 | agent/image_eviction_policy.py:168-170 | `The retire count must be a STEP FUNCTION of the overshoot, because the pass is recomputed on every request` | 阶梯函数的理由 |
| E16-36 | agent/image_eviction_policy.py:170-171 | `an exact count - limit target moves the frontier on every new image` | 精确淘汰的错 |
| E16-37 | agent/image_eviction_policy.py:171-172 | `a fixed one-batch retire stops enforcing the limit after the first batch` | 固定一批的错 |
| E16-38 | agent/image_eviction_policy.py:173 | `The quantum is batch capped at window - floor` | 量子夹法 |
| E16-39 | agent/image_eviction_policy.py:175-177 | `cutting each step back to exactly total - floor instead makes the retire count track total again` | 为什么不能砍到 floor |
| E16-40 | agent/image_eviction_policy.py:180-182 | `The floor is a SATISFIABILITY floor: it shelters the newest frames only when reserved uploads alone breach the block ceiling` | floor 语义 |
| E16-41 | agent/image_eviction_policy.py:182-183 | `never under byte pressure — the request-size limit is hard and the provider answers 413` | 字节压力下不庇护 |
| E16-42 | agent/image_eviction_policy.py:191-206 | `return max((_retire_count_for_request(...) for m in range(1, total + 1)), default=0)` | 外层取所有 m 的最大 |
| E16-43 | agent/image_eviction_policy.py:211-215 | `Keyed on agent.session_id so a new session (or a compaction rotation ...) starts clean` | latch 的 key |
| E16-44 | agent/image_eviction_policy.py:217-221 | `held = (session_id, set())` / `agent._outbound_retired_image_ids = held` | latch 的存储 |
| E16-45 | agent/image_eviction_policy.py:230-233 | `a request that drops an upload ... re-deciding from scratch would restore screenshots an earlier request already retired` | 要锁存的原因 |
| E16-46 | agent/image_eviction_policy.py:238 | `retire = max(retire, total - latched[0]) if latched else retire` | 加宽规则 |
| E16-47 | agent/image_eviction_policy.py:275-277 | `quantum = max(1, min(batch, byte_window - floor + 1))` | 字节压力收窄步长 |
| E16-48 | agent/image_eviction_policy.py:280-281 | `window = max(k for k in range(total + 1) if _fits(k)) if _fits(0) else 0` / `quantum = max(1, min(batch, window - floor))` | 普通分支 |
| E16-49 | agent/image_routing.py:1 | `Routing helpers for inbound user-attached images` | 入站路由定位 |
| E16-50 | agent/image_routing.py:3-5 | `native attaches images as OpenAI-style image_url parts; text runs vision_analyze up-front` | 两种模式 |
| E16-51 | agent/image_routing.py:6-7 | `in auto an explicit auxiliary.vision backend forces text even for vision-capable main models` | auto 的第一条规则 |
| E16-52 | agent/image_routing.py:8-9 | `else supports_vision (config override or catalog) decides` | auto 的第二条规则 |
| E16-53 | agent/image_routing.py:9 | `vision_analyze stays a tool regardless` | 工具始终保留 |
| E16-54 | agent/vision_message_prep.py:3-4 | `Vision capability probes, non-vision text fallbacks (cached vision_analyze descriptions), tool-result image stripping` | 还负责剥离与缓存 |
| E16-55 | agent/vision_message_prep.py:4 | `provider quirks (Anthropic dot preservation, Qwen portal message shaping)` | provider 怪癖 |
