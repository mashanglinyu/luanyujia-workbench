# 16 本地模型：接入、托管与物理约束

`0.22.2+2364.g0b10b9f / <旧位置>\Hermes / hermes_cli\local_runtime\(19 模块 4845 行)、agent\chat_completion_local.py(102)、agent_init_ollama.py(67)、lmstudio_reasoning.py(40)、model_metadata.py(2636) 中本地相关段`

> 本面是第 16 面，回答一个 DSH 迟早要面对的问题：**用户说「我用本地的」，这件事到底要做多少工作？**
> 前 15 面的模型全是云端 provider —— 换个 `base_url` 加个 key 就完了。本地模型不是这样：**没有人替你运维，
> 你要自己装引擎、探硬件、算显存、解窗口、拼启动参数、起进程、守进程、证明它真能出字、还得在它空闲时把显存还回去。**
> Hermes 为这件事写了 4845 行，并且明确写了一句话：`No context/VRAM knobs by design`（`config_defaults.py:2719`）——
> **没有窗口和显存旋钮，不是抠门，是因为这两个值用户填不对。**

---

## ① 结论

1. **本地模型的核心成本不是「调用」，是「托管」。** 云端 provider 的推理进程是别人的运维责任；本地模型的
   llama-server 是**你自己的子进程**，它会崩、会泄漏 VRAM、会被别的程序挤到页文件里、会在你不看的时候
   一直占着 20 GiB。Hermes 的 `local_runtime/` 19 个模块按职责切开：`binaries`（装哪个引擎）、`hardware`（有多少可用显存）、
   `estimator`（一个窗口要多少字节）、`context_policy`（该给多大窗口）、`presets`（拼成启动参数）、
   `supervisor`（守住这个进程）、`recovery`（上次的进程还是不是上次那个）、`bootstrap`（把上面这些串成一次启动）。
   **DSH 若只做「配置里填个 ollama 地址」，这 8 件事一件都不做，那不是「支持本地模型」，是「支持连一个已经有人在管的服务器」。**

2. **最要紧的一条判断是「不信设备查询」——而且要按设备类型分信。** 这是整层唯一的规则，写在文件头：
   `discrete cards may trust the device query (measured honest within rounding); unified-memory devices must budget
   from OS free physical memory minus headroom — their device queries have been observed off by 3x in both directions`
   （`hardware.py:3-6`）。**同一个 API、同一份代码，在独显上可信、在核显/统一内存上能差三倍**，而且方向不定。
   DSH 如果照抄「读 nvidia-smi 的 free」这一行到核显机器上，会得到一个既不安全也没意义的窗口。

3. **上下文窗口不是配置项，是解出来的。** 契约原文：
   `One contract: any model runs at any window up to its native max; hardware and session depth only change tokens/s.
   Constants, not knobs — nothing in this module reads config`（`context_policy.py:3-5`）。
   于是「窗口」变成一道有唯一答案的题：64K 地板 → ×1.5 阶梯 → native 封顶，取**最大的不溢出档**
   （`context_policy.py:40-48`、`:87-95`）。用户不需要懂 KV cache 怎么算 —— 他也确实算不对。

4. **`health` 返回 200 不等于能出字。** 这条被写在 supervisory 模块第一段：
   `health-200 is NOT readiness — every readiness claim requires a touch generation (temp-0, expected token,
   generous budget, reasoning_content scanned)`（`supervisor.py:5-6`）。实现是真发一次推理：
   `"Reply with exactly one word: the capital of France."` → 期望回答里出现 `paris`
   （`supervisor.py:33-34`、`:430-442`）。**且 `max_tokens` 必须给到 512** —— 给小预算会让推理模型假失败，
   因为它把第一批 token 全花在思考上（`:431-432`）。

5. **能同时驻留几个模型，是「价」出来的，不是「数」出来的。** `admitted_residency_count` 的 docstring 是整份档案里
   信息密度最高的一段之一：按计数放行会让第二个模型在已满的卡上被接纳，而
   `On Windows/WDDM that over-commit is not refused — the allocation is paged to host memory, and that child decodes
   at a third of its speed for the rest of its life: no error, no UI hint, and ejecting the incumbent afterwards does
   not repair it (only a clean reload does)`（`presets.py:326-331`）。所以规则是：**只有当最大的已驻留模型还装得下两份时，
   上限才升到 1 以上** —— 这样任何一对模型按构造都装得下，llama.cpp 就会在**新子进程分配之前**先做 LRU 淘汰。

6. **本地模型的所有失败模式都是静默的。** 这是它和云端最大的区别 —— 云端失败会给你 4xx/5xx，本地失败给你一个
   「看起来正常」的响应。已实测到的四种：
   - **WebP 图静默不被看见**：llama.cpp 用 stb_image 解码，`WebP NO — and a WebP part fails SILENTLY (no HTTP error,
     no log line; the model just never sees an image and confabulates)`；实测同一个红方块，PNG 答 `Red`，WebP 答 `Unseen`
     （`capabilities.py:18-22`）；
   - **超额分配静默变慢**：见上一条，慢 3 倍、无错误、无提示、eject 也修不好；
   - **Ollama 默认 `num_ctx` 是 2048**（`agent_init_ollama.py:10`），而压缩器的阈值若算在「探测出的模型窗口」上，
     会**永远不触发**（`:50-57`）；
   - **裸 provider 别名会回退到云端**：`With no server running the answer is "unavailable", never the generic
     custom/API-key discovery: that handed the local model slug to whatever cloud provider held a key (#119227)`
     （`auxiliary_local_runtime.py:6-7`）—— **用户以为在本地跑，数据其实出了机器。**

7. **「怎么问它」有三套互不兼容的接口，且探测顺序有硬性要求。** 探针瀑布：
   `lm-studio`（`/api/v1/models`，200 即认）→ `ollama`（`/api/tags`，且 body 必须含 `models`）→
   `llamacpp`（`/v1/props` 或 `/props`，且含 `default_generation_settings`）→ `vllm`（`/version`）
   （`model_metadata.py:745-750`）。顺序不能乱：`LM Studio answers /api/tags with {"error": ...} and 200`（`:743-744`），
   所以 Ollama 那条必须校验 body、且必须排在 LM Studio 之后。**更硬的一条：远程端点一律不探**
   —— `Remote endpoints must never be fingerprinted`，因为非 Ollama 的远程（sglang、vLLM、OpenAI 兼容）
   会暴露 Ollama 兼容端点导致误判，且无 key 时每一段都 401（`:40-42`、`:724-728`）。

---

## ② 证据

| # | 位置 | 原文（截断 ≤40 字） | 说明 |
|---|---|---|---|
| 1 | `hermes_cli/local_runtime/context_policy.py:3-5` | `One contract: any model runs at any window up to its native max` | 窗口契约的唯一表述 |
| 2 | `context_policy.py:4-5` | `Constants, not knobs — nothing in this module reads config` | 策略层不读配置 |
| 3 | `context_policy.py:16` | `FLOOR = 64 * 1024` | 地板 = 64K |
| 4 | `context_policy.py:17` | `_LADDER_GROWTH = 1.5` | 阶梯倍率 |
| 5 | `context_policy.py:22-26` | `66% complete uncompressed in 64K, 82% in 96K, 91% in 144K` | 161 个真实会话实测 |
| 6 | `context_policy.py:40-48` | `64K -> 96K -> 128K -> ... -> native` | `ladder()` 生成 |
| 7 | `context_policy.py:93-95` | `largest zero-spill rung` | 取最大不溢出档 |
| 8 | `context_policy.py:99` | `cap = int(budget.usable_vram_bytes * _EARLY_COST_CTX_FRACTION)` | 早成本上限 15% |
| 9 | `context_policy.py:108` | `floor held at {n}K; weights spill (deliberate price...)` | 宁可溢出权重也保地板 |
| 10 | `context_policy.py:223` | `One growth evaluation, END-OF-TURN ONLY` | 只在回合末增长 |
| 11 | `context_policy.py:226-229` | `occupancy (~85%) → native cap → idleness → speed floor` | 增长门序 |
| 12 | `context_policy.py:241-246` | `decode {x:.1f} tok/s below the ~6 tok/s floor` | 速度地板 |
| 13 | `context_policy.py:299` | `args = ["-c", str(decision.window)]` | 显式 `-c` |
| 14 | `context_policy.py:308` | `-ctk q8_0 -ctv q8_0 -fa on` | 有 FA 就 q8 KV |
| 15 | `context_policy.py:309-310` | `if decision.spilled and not uma:` | 溢出放置仅独显 |
| 16 | `hermes_cli/local_runtime/hardware.py:3-6` | `unified-memory devices must budget from OS free physical memory` | **预算来源规则** |
| 17 | `hardware.py:32-36` | `the 2 GiB floor is what a 512 MiB floor failed to cover` | 余量地板从 512M 提到 2G |
| 18 | `hardware.py:39` | `_LAUNCH_HEADROOM = 1 << 30` | 启动余量 1 GiB |
| 19 | `hardware.py:42` | `_UMA_HEADROOM_FRACTION = 0.20` | 统一内存留 20% |
| 20 | `hardware.py:51-52` | `discrete cards agree within ~2%; carve-out disagreement runs to whole multiples` | 判统一内存的两道闸 |
| 21 | `hardware.py:499-506` | `planning=False: LIVE ... planning=True: CAPACITY` | 两套预算 |
| 22 | `hardware.py:559-567` | `a 32 GiB card with 4.5-6.3 GiB held by other apps decoded at ~24 tok/s` | 满窗 vs 空闲窗实测 24→90 |
| 23 | `hermes_cli/local_runtime/estimator.py:191-204` | `ctx_bytes` 三条分支 | full 线性 / SWA 封顶 / recurrent 常数 |
| 24 | `estimator.py:208-210` | `The only true refusal: weights + floor-KV + state exceed` | 唯一拒绝条件 |
| 25 | `estimator.py:224-237` | `try a smaller model or a supported smaller quant` | 拒绝时的建议 |
| 26 | `estimator.py:15-16` | `_Q8_BYTES_PER_ELEM = 34 / 32` / `_F16 = 2.0` | q8 KV 是 f16 的 0.531 倍 |
| 27 | `estimator.py:144-157` | SWA 模式优先三级阶梯 | 文件自身模式 > 架构比例 > 全按 full（高估安全）|
| 28 | `hermes_cli/local_runtime/supervisor.py:5-6` | `health-200 is NOT readiness` | 就绪≠健康 |
| 29 | `supervisor.py:33-34` | `Reply with exactly one word: the capital of France.` | touch 探针 |
| 30 | `supervisor.py:431-432` | `small token budgets false-fail reasoning models` | 512 预算的原因 |
| 31 | `supervisor.py:438` | `blob = content + " " + reasoning_content` | 两处都扫 |
| 32 | `supervisor.py:35` | `_RESTART_BACKOFF_S = (1, 5, 15, 60)` | 退避序列 |
| 33 | `supervisor.py:42` | `_DEFAULT_PORT = 18434` | 故意不用 8080 |
| 34 | `supervisor.py:38-41` | `Deliberately NOT 8080 so we never collide` | 避免撞用户自己的栈 |
| 35 | `supervisor.py:118` | `IDLE_UNLOAD_S = 15 * 60` | 空闲 15 分钟卸载 |
| 36 | `supervisor.py:114-117` | `A constant, not a knob` | 又是「不是旋钮」|
| 37 | `supervisor.py:183-185` | `--models-autoload` | 驻留契约 |
| 38 | `supervisor.py:186-187` | `--metrics` / `--slots` 都是 opt-in | 默认关 |
| 39 | `supervisor.py:210-213` | `State goes down at SPAWN, not after health` | 状态先写再等健康 |
| 40 | `supervisor.py:303-310` | `Terminating only the router orphans them with the weights still resident` | 必须杀树 |
| 41 | `supervisor.py:337-342` | `Its VRAM must come back before the new router loads` | 崩溃后先收尸 |
| 42 | `supervisor.py:348-349` | `if sys.platform == "win32": return` | 孤儿回收仅 POSIX |
| 43 | `supervisor.py:461-465` | `True = confirmed idle, False = busy, None = probe failed` | 三态探测 |
| 44 | `supervisor.py:411-414` | `idle probe for %s failed; keeping idle clock` | 探测失败不重置时钟 |
| 45 | `supervisor.py:461-465` | `A model that isn't loaded is idle: the router answers 400` | 400 视为空闲 |
| 46 | `hermes_cli/local_runtime/endpoint.py:20-29` | `autoload=false makes the router answer 400` | 状态读不能把模型加载回来 |
| 47 | `endpoint.py:34-36` | `On Windows os.kill(pid, 0) TERMINATES the process` | **不能拿 0 号信号探活** |
| 48 | `endpoint.py:89-96` | `Managed-first, detection-second` | 端点解析顺序 |
| 49 | `endpoint.py:103-106` | `ports = ... detect_ports` | 额外探测端口 |
| 50 | `endpoint.py:108-116` | `Boot-race rung` | 引导竞态等待 8s |
| 51 | `hermes_cli/local_runtime/detect.py:1-5` | `Ollama and LM Studio answer /v1/models but not /props` | 指纹靠 /props |
| 52 | `detect.py:15` | `Always 127.0.0.1 — resolving localhost costs ~2s/request` | Windows IPv6 回退代价 |
| 53 | `detect.py:44-45` | `if status == 401: return ... auth_required=True` | 401 也算探到 |
| 54 | `detect.py:49-50` | `answers /props but isn't llama-server` | 无 build_info 即否 |
| 55 | `hermes_cli/local_runtime/devices.py:1-8` | `Loading a GPU driver can crash or hang the caller, hence a child` | 子进程 + `-I` 隔离 |
| 56 | `devices.py:20-21` | `GGML_DEVICE_GPU = 1` / `IGPU = 2` | 引擎自己的融合/独立判定 |
| 57 | `hermes_cli/local_runtime/presets.py:326-331` | `decodes at a third of its speed for the rest of its life` | 超额分配的余生代价 |
| 58 | `presets.py:333-335` | `cap rises above one only while the LARGEST staged model still fits TWICE` | 驻留数规则 |
| 59 | `presets.py:338-340` | `Capping the count instead has llama.cpp evict its LRU before` | 为什么按价而非按数 |
| 60 | `presets.py:233-236` | `Sampling deference ladder` | GGUF 元数据 > catalog > 引擎默认 |
| 61 | `presets.py:258-259` | `Unsloth's measured cliff: acceptance 83% at 2-3 drafts, collapses at 4` | 草稿深度 3 |
| 62 | `hermes_cli/local_runtime/processes.py:90` | `_CREDENTIAL_ENV_MARKERS = ("_API_KEY", "_TOKEN", ...)` | 凭据过滤 |
| 63 | `processes.py:96-99` | `the bundled OpenMP runtime died with STATUS_HEAP_CORRUPTION` | **有 key 时 libomp 崩** |
| 64 | `processes.py:122` | `CREATE_SUSPENDED` | 先挂起再入 Job |
| 65 | `processes.py:68` | `KILL_ON_JOB_CLOSE` (0x2000) | 拥有者死则整树死 |
| 66 | `hermes_cli/local_runtime/recovery.py:54` | `Match a modern process incarnation, never just its reusable PID` | PID 会复用 |
| 67 | `recovery.py:41-43` | `Linux derives psutil's create_time from /proc/stat's boot time` | WSL 调时钟即失配 |
| 68 | `recovery.py:15-16`（nt 分支）| `Windows retains the original parent PID; POSIX reparents orphans` | 双平台差异 |
| 69 | `hermes_cli/local_runtime/bootstrap.py:415-416` | `if not force and not section.get("enabled")` | 关=只探测 |
| 70 | `bootstrap.py:426-428` | `no staged models means nothing to serve` | 不启空服务器 |
| 71 | `bootstrap.py:436-438` | `two backends racing to boot (#116682)` | 跨进程启动锁 |
| 72 | `bootstrap.py:447-449` | `replacing it so every model launches with a policy` | 陈旧 preset 要替换 |
| 73 | `bootstrap.py:473-476` | `leaving it running unsupervised strands its VRAM` | 半启动要 stop |
| 74 | `hermes_cli/config_defaults.py:2719-2731` | `No context/VRAM knobs by design` | 设计声明 |
| 75 | `config_defaults.py:2723` | `Off = detection-only` | enabled 默认 False |
| 76 | `hermes_cli/local_runtime/capabilities.py:18-22` | `WebP NO — and a WebP part fails SILENTLY` | 图格式静默失败 |
| 77 | `capabilities.py:21` | `the same red square answered 'Red' as PNG, 'Unseen' as WebP` | 实测对照 |
| 78 | `capabilities.py:1-6` | `a vision-capable local model reads as text-only` | 能力倒查失败 |
| 79 | `capabilities.py:55-79` | 先问 `/props` 的 `modalities`，再回落 catalog | 活值优先 |
| 80 | `capabilities.py:71-78` | `Capability requires the projector to actually be on disk` | mmproj 必须在盘上 |
| 81 | `agent/model_metadata.py:677-708` | `is_local_endpoint` 六类本地地址 | 环回/容器内/无点主机/RFC1918/链路本地/Tailscale |
| 82 | `model_metadata.py:688-691` | `Unqualified hostnames (no dots) are local by definition` | Docker service 名算本地 |
| 83 | `model_metadata.py:695` | `addr in _TAILSCALE_CGNAT` | 100.64/10 也算 |
| 84 | `model_metadata.py:711-716` | `localhost -> 127.0.0.1 (Windows dual-stack ~2s)` | 统一改写 |
| 85 | `model_metadata.py:745-750` | 四段瀑布 | 顺序硬性 |
| 86 | `model_metadata.py:743-744` | `LM Studio answers /api/tags with {"error": ...} and 200` | 为什么 Ollama 要校验 body |
| 87 | `model_metadata.py:40-42`(helpers) | `Remote endpoints must never be fingerprinted` | 远程禁探 |
| 88 | `model_metadata.py:724-728` | `skip the waterfall so egress logs do not fill with 404s` | 顺便省日志 |
| 89 | `model_metadata.py:765-767` | `A connect timeout condemns the host` | 连接超时判黑洞 |
| 90 | `model_metadata.py:1427-1428` | `an unauthorized probe can never produce a positive verdict` | 探测必须带 key |
| 91 | `model_metadata.py:1434-1447` | `/api/show` 取 num_ctx，落盘缓存 | 探测结果持久化 |
| 92 | `model_metadata.py:1450-1465` | `capabilities`(0.6.0+) 否则 `vision.block_count` | 视觉能力双路径 |
| 93 | `agent/agent_init_ollama.py:10` | `Ollama defaults num_ctx to 2048` | **默认窗口坑** |
| 94 | `agent_init_ollama.py:28-29` | `GGUF metadata can advertise 256K+ and Ollama would allocate that much` | 为什么还要封顶 |
| 95 | `agent_init_ollama.py:50-57` | `the compaction trigger could sit several times ABOVE the real served window` | 压缩器夹窗 |
| 96 | `agent/lmstudio_reasoning.py:17-20` | `without this ceiling clamp they'd fall to the "medium" default` | max/ultra → xhigh |
| 97 | `lmstudio_reasoning.py:38-39` | `return None` | 不在允许集就省略字段 |
| 98 | `agent/chat_completion_local.py:22-31` | `These requests always stream and ask for prompt progress` | 本地必须流式 |
| 99 | `chat_completion_local.py:25-26` | `A non-streamed request can't be cancelled through the router` | 原因 |
| 100 | `chat_completion_local.py:39-51` | `/health` 3 秒 + 禁代理 | 探活实现 |
| 101 | `chat_completion_local.py:54-67` | `retry_recovered_local_server` | 跨回合给恢复的服务器一次机会 |
| 102 | `chat_completion_local.py:66` | `agent._consecutive_stale_streams = giveup - 1` | 只放一次 |
| 103 | `chat_completion_local.py:70-98` | 加载进度提示 | 冷加载不该看起来像卡死 |
| 104 | `chat_completion_local.py:96-98` | `Counter past the estimate ... no honest denominator, label-only` | 估算不够就不给百分比 |
| 105 | `agent/chat_completion_helpers.py:2911-2913` | `local providers prefill for minutes` | read 120s→1800s |
| 106 | `agent/local_prompt_progress.py:24-29` | `return_progress: True` | 要进度块 |
| 107 | `local_prompt_progress.py:5-6` | `the stall timers stay quiet while the server works` | 进度即心跳 |
| 108 | `local_prompt_progress.py:8-9` | `Compression also leaves the time ... out of its total time limit` | 压缩时限也扣掉 |
| 109 | `agent/model_metadata_llamacpp.py:19-23` | `the ``--ctx-size`` the router will launch it with` | 懒加载模型也要有窗口 |
| 110 | `model_metadata_llamacpp.py:42-63` | 从 `status.args` 里配对 `-c/--ctx-size` | 反解启动参数 |
| 111 | `hermes_cli/runtime_provider_custom.py:522-536` | 端点为空则按开关状态给两种文案 | 两种错误分开说 |
| 112 | `runtime_provider_custom.py:534-536` | `would surface "local server is off" as OpenRouter's "401` | 不 fall through 的原因 |
| 113 | `agent/auxiliary_local_runtime.py:6-7` | `handed the local model slug to whatever cloud provider held a key` | #119227 |
| 114 | `hermes_cli/local_runtime/gguf.py:31-36` | 只有 `per_layer_token_embd.weight` > 4 GiB 才懒读 | 懒加载范围极窄 |
| 115 | `gguf.py:20-21` | `SPLIT_PART_RE = -(\d{5})-of-(\d{5})` | 分片模型 id |
| 116 | `hermes_cli/local_runtime/growth.py:63-92` | 增长必须落成 preset 并 refresh 才算成功 | 不认「已申请」只认「已生效」|
| 117 | `growth.py:96-99` | `the next request rebuilds server state in the larger window` | 增长靠重载不是扩窗 |
| 118 | `hermes_cli/local_runtime/catalog.json` | 5 个模型，含 `n_ctx_train`/`mmproj`/`mtp`/`sampling` | 目录仅 5 条 |
| 119 | `hermes_cli/local_runtime/presets.py:21-25` | `_FLAG_TO_KEY` 9 个 flag → ini key | 参数翻译表 |
| 120 | `presets.py:213-216` | `Router discovery is preset-only` | 被拒的文件不许 autoload |

---

## ③ 契约

### 3.1 端点解析顺序（空位回退，最多三段）

```
provider ∈ {llamacpp, llama.cpp, llama-cpp} 且无显式 base_url
  ① managed   状态文件 server.json 存在且进程身份校验通过 → 用它（含 api_key）
  ② detected  探 127.0.0.1:8080 + config.detect_ports → 指纹是 llama-server 且 auth_required=false → 用它（key 为空）
  ③ boot-race enabled 且已装引擎，但状态文件还没写出来：
             非阻塞抢锁 → 后台 ensure_local_runtime() → 每 0.25s 轮询状态文件，最多 8s
  ④ 都没有   → 不落到 generic custom，直接报错（两种文案，看 enabled）
```

**①②的顺序不能反**：托管服务器是我们自己的（有 key、端口稳定、preset 有策略）；探测到的是别人的（没策略、
随时可能被用户关掉）。先探后查会让「我们自己刚起的服务器」被「用户同时开的另一个 llama-server」顶掉。

### 3.2 窗口决策（纯函数，无配置读取）

```
ladder(native):  64K, 96K, 144K, 216K, ... ，末尾一定是 native（不重复）
initial_window(profile, budget):
    if physics_refusal: 报错（建议换更小的量化，不是换更小的窗口）
    零溢出支路：从 ladder 里取 max{ rung : footprint(rung) ≤ usable_vram }
    ── 若该支路 ≥ min(FLOOR, native) → 采用，reason = "largest zero-spill rung"
    早成本支路：weights 本身就超显存（小卡跑陡峭模型）
                window ← min(FLOOR, native)
                对每个不被 cap 挡住的 rung：cap = usable_vram × 15%
                                          同时要求 footprint(rung) ≤ usable_vram + ram_available
                                          → 取最大的
                reason = "floor held at {n}K; weights spill"
```

`footprint(window) = weights + ctx_bytes(window) + overhead`
`ctx_bytes(window) = Σ_full(per_tok × f × window) + Σ_swa(per_tok × f × min(window, swa_window))
                     + Σ_recurrent(4 MiB) 全部乘 kv_scale，再加 window_compute_per_token × window`
`f = 34/32 ÷ 2 = 0.531`（有 FA 用 q8 KV），无 FA 时 `f = 1.0`

### 3.3 增长门序（顺序即语义，不能换）

| # | 门 | 条件不满足时的动作 | 为什么必须在这个位置 |
|---|---|---|---|
| 1 | 占用率 | `< current_window × 0.85` → hold | 没到阈值就涨，等于每次都付重载代价 |
| 2 | native 上限 | `current_window ≥ native` → compress-default | 已到顶，只剩压缩一条路 |
| 3 | 服务器空闲 | `not server_idle` → hold | 忙着重载 = 打断用户正在等的回答 |
| 4 | 速度地板 | `decode < 6 tok/s` → compress-default | 已经慢到不像话了，再涨窗只会更慢 |
| 5 | 物理可容 | `weights + kv(next) > usable_vram + ram_avail` → compress-default | 申请了也落不了地 |
| — | `occupancy_confirmed=True` | 跳过第 1 门 | 调用方（压缩闸门）自己就是占用信号；两个独立算的边会死锁成「先压缩再增长」 |

**第 1 门的 `occupancy_confirmed` 是一个死锁修复，不是一个开关。** 没有它，压缩闸门和增长闸门各自算自己的边，
可能在同一个回合同时判定「该压缩」和「该增长」，而两条路都要重载 —— 死锁。

### 3.4 就绪判定（三级，缺一不可）

| 级 | 判据 | 不足时会怎样 |
|---|---|---|
| 进程活着 | `poll() is None` | — |
| `/health` 200 | 3 秒超时、禁代理、`localhost`→`127.0.0.1` | 端口通但模型没加载，也会 200 |
| **touch 出字** | temp-0 问首都，`max_tokens=512`，扫 `content + reasoning_content` 找 `paris` | **只有这一级能证明 KV/权重/采样链全通** |

### 3.5 常量表（全部写死在代码里，无一个来自 config）

| 常量 | 值 | 位置 | 语义 |
|---|---|---|---|
| `FLOOR` | 64 K | `context_policy.py:16` | 窗口地板，也是保证 |
| `TARGET_WINDOW` | 144 K | `:26` | 压缩从常态变为例外的档位 |
| `_LADDER_GROWTH` | 1.5 | `:17` | 阶梯倍率 |
| `_GROW_AT_OCCUPANCY` | 0.85 | `:18` | 增长触发占用率 |
| `SPEED_FLOOR_TOK_S` | 6.0 | `:19` | 低于此不再增长 |
| `RUNTIME_OVERHEAD_BYTES` | 1.5 GiB | `:33` | 权重+KV 之外的运行时开销 |
| `DEFAULT_UBATCH`/`PREFILL_UBATCH` | 512 / 2048 | `:36-37` | 微批 |
| `_MARGIN_FLOOR` | 2 GiB | `hardware.py:35` | 显存预留地板 |
| `_MARGIN_FRACTION` | 0.09 | `:36` | 显存预留比例 |
| `_LAUNCH_HEADROOM` | 1 GiB | `:39` | 启动余量 |
| `_UMA_HEADROOM_FRACTION` | 0.20 | `:42` | 统一内存余量 |
| `_PROMPT_CACHE_MAX/MIN` | 8 GiB / 512 MiB | `:46-47` | prompt cache 上下限 |
| `_LAUNCH_HEADROOM` | 1 GiB | `:39` | 同上 |
| `IDLE_UNLOAD_S` | 900 s | `supervisor.py:118` | 空闲卸载 |
| `_RESTART_BACKOFF_S` | 1,5,15,60 | `:35` | 崩溃重启退避 |
| `_DEFAULT_PORT` | 18434 | `:42` | 稳定端口，避开 8080 |
| `TOUCH max_tokens` | 512 | `:436` | 小预算会假失败 |
| `_RECURRENT_STATE_PER_LAYER` | 4 MiB | `estimator.py:43` | 每 recurrent 层状态 |
| `_LAZY_READ_MIN_BYTES` | 4 GiB | `gguf.py:36` | 懒读阈值 |
| `services 探活超时` | 3 s | `chat_completion_local.py:48` | /health |
| 引导竞态等待 | 8 s | `endpoint.py:90` | boot-race |
| 本地 read 超时 | 120→1800 s | `chat_completion_helpers.py:2911` | 预填充要好几分钟 |

### 3.6 三套本地接口的能力查询对照

| 能力 | Ollama | LM Studio | llama.cpp | 通用做法 |
|---|---|---|---|---|
| 窗口 | `/api/show` → Modelfile `num_ctx` 否则 GGUF max | 无 | `/props` → `default_generation_settings.n_ctx`；未加载则 `/models` 的 `status.args` 里配对 `-c/--ctx-size` | 探不到就用家族兜底值，**不要用 2048** |
| 视觉 | `capabilities` 含 `vision`（0.6.0+），否则 `model_info.*.vision.block_count` | `capabilities.reasoning` 等字段 | `/props` 的 `modalities.vision`；回落 catalog 的 mmproj 是否在盘上 | 三者都可能返回 None，调用方必须继续往下走 |
| 推理档位 | `think` | `capabilities.reasoning.allowed_options` → 必须夹到允许集 | `--reasoning-format` / chat template | 不在允许集就**省略字段**，不要静默替换 |
| 是否就绪 | `/api/tags` 里有该模型 | `/api/v1/models` | `/health` + **touch** | touch 是唯一可靠的 |
| 是否我在跑 | — | — | `GET /models` 的 `status.value ∈ {loaded, ready}` | — |

### 3.7 配额与放置决策（`-ot` 只在独显上用）

| 模型形态 | spill 时的放置 | 理由 |
|---|---|---|
| MoE | `-ot "blk\.\d+\.ffn_.*_exps\.weight=CPU"` | expert 权重占绝大多数，移走它们保住注意力+KV |
| Hybrid（有 recurrent 层） | `-ot "blk\.(i|j|...).ffn_.*\.weight=CPU"`，只移够覆盖 `spill_bytes` 的那几个 recurrent 块 | recurrent 层 `n_head_kv == 0`，本来就没有值得保护的 KV |
| Dense | 不加 `-ot`，交给 fit 的「从后往前砍层」 | 没有更细的轴 |
| 统一内存（`uma=True`） | **一律不加 `-ot`** | UMA 上「主机内存」和「显存」是同一块，移过去没有意义 |

---

## ④ 对 DSH 的适配

### DSH 现在有没有等价物

**没有，而且不是「少一个功能」，是「少一层责任」。** DSH 目前的模型接入是「配置里填 `base_url` + `api_key`」，
这对云端 provider 是对的。用户的本地环境有两种，DSH 对两种都只有半个答案：

| 场景 | DSH 现状 | 缺什么 |
|---|---|---|
| 用户自己跑着 Ollama / LM Studio / llama-server | 填对 `base_url` 就能用 | ① 不知道它是什么（三套接口不同）；② 不知道真实窗口（`num_ctx` 被 Ollama 截到 2048 时压缩永不触发）；③ 预填充几分钟会被自己的 read 超时掐断 |
| 用户没有服务器，希望 DSH 帮着跑 | 完全做不到 | 装引擎、探硬件、解窗口、拼参数、守进程、证明就绪、空闲回收 —— 七件事一件没有 |

### 落点：分三档，每档都能独立上线

**第一档（必须做，S，约 400 行纯函数 + 一次探针）——「把本地服务器当本地服务器对待」**

只做「用户已经有服务器」这一档，但做对三件事：

1. **本地判定**：`isLocalEndpoint(baseUrl)`。判据照抄 Hermes 的六类：环回、`localhost`、无点主机名（Docker service 名）、
   `.local`（mDNS）、RFC-1918、链路本地、Tailscale 的 100.64/10（`model_metadata.py:677-708`）。
   **不要只判 `127.0.0.1`** —— 用户很可能在 WSL 里跑模型、用 Docker Compose 起服务、或者用一个 Tailscale 盒子当推理机。
   这些全都是「本地」，全都要走本地分支。
2. **超时与时序全换一套**：read 超时 120s → 1800s（`chat_completion_helpers.py:2911`）；stale 探测从「多久没字节」
   改成「多久没进度块」；`localhost` 一律改写成 `127.0.0.1`（Windows 上 IPv6 先解析会白等 2 秒，`model_metadata.py:711-716`）；
   必须流式（本地非流式请求无法中途取消，用户点「停止」后服务器还在算，`chat_completion_local.py:25-26`）。
3. **三套接口按顺序探，且远程绝不探**：`lm-studio → ollama → llamacpp → vllm`
   （`model_metadata.py:745-750`）。**顺序不能换**，LM Studio 会对 `/api/tags` 回 200 + `{"error":...}`，
   所以 Ollama 那段必须校验 body 里有 `models`。**远程端点一律不探** —— 不只是省日志，
   是「远程探测会误判」：sglang/vLLM 暴露 Ollama 兼容端点，会把远程当成 Ollama，然后拿一堆错误的默认值去发请求（`:40-42`）。

**第二档（强烈建议，M，约 500 行）——「就绪判定和静默失败兜底」**

1. **`health 200` 不算就绪**。DSH 必须有 touch generation：`max_tokens=512`、`temperature=0`、
   一个答案唯一的问句，**并且同时扫 `content` 和 `reasoning_content`**
   （`supervisor.py:430-442`）。少了 `reasoning_content` 这一半，所有推理模型都会「就绪失败」。
   少了 512 的预算，模型把 token 全花在思考上，同样假失败（`:431-432`）。
2. **静默失败的三个兜底**：
   - **WebP**：llama.cpp 的 stb_image 不支持 WebP，且**不报错**（`capabilities.py:18-22`）。DSH 发图前按
     目标端点类型检查 mime，`image/webp` 一律先转 PNG/JPEG。这一条不修，用户发截图给本地模型，
     模型会一本正经地描述一个它从没看见的图。
   - **Ollama `num_ctx`**：默认 2048。**只要探到 `num_ctx`，压缩器的窗口就必须夹到它**
     （`agent_init_ollama.py:50-66`）—— 否则压缩阈值算在「模型宣称的 128K」上，而服务器实际只收 2048，
     结果是**要么永远不压缩然后被服务器截断，要么压到一半就不够用**。
   - **裸别名不回退云端**：请求说「用本地」而本地没起来时，**必须报错**，不能让路由顺手挑一个云端 provider
     （`auxiliary_local_runtime.py:6-7`、#119227）。这是唯一一条「静默失败会变成数据外泄」的路径。

**第三档（可选，L，约 2500 行）——「自己托管」**

只有确定要做「DSH 帮用户跑模型」才做这一档。它需要引擎分发（下载 + 校验 + 版本锁定）、硬件探测
（独显 / 核显 / UMA 三支）、窗口求解、进程监督（Job Object / 进程组）、空闲卸载。**但这一档里有两件事
即使不做托管也要先记住**：

- **预算来源规则**（`hardware.py:3-6`）：以后真做显存预算时，独显可以信 `nvidia-smi`，**核显和 UMA 必须用
  OS 空闲物理内存减余量**。这条不能等做的时候再查 —— 它会决定整个 `HardwareBudget` 的数据结构。
- **驻留数按价不按数**（`presets.py:326-340`）：能同时装几个模型，是「最大那个装得下两份吗」算出来的，
  不是 `models_max: 4` 配出来的。

### 三个必须移植的设计判断

1. **「没有旋钮」是一个功能，不是省略。** `No context/VRAM knobs by design`（`config_defaults.py:2719`）。
   窗口是解出来的、余量是写死的、卸载是 15 分钟。**用户填不对这些数字**，给了旋钮只会得到「我调成 256K 之后
   OOM 了」这类工单。DSH 若要暴露，最多暴露一个「更快 / 更准」的二选一，不要暴露 token 数。
2. **拒绝时改量化，不改窗口。** `The only true refusal` 的补救是
   `try a smaller model or a supported smaller quant`（`estimator.py:208-237`）。窗口有地板，
   地板是**保证**不是建议 —— 破了地板之后模型能跑但会胡说，那比报错更糟。
3. **一切「成功」都以「能出字」为准。** 进程起来了不算、端口通了不算、`/health` 200 不算。这一条和第 15 面的
   「完成需要证据」是**同一条原则的两次体现**：都不信声明，只信可观测的结果。

### 明确不要抄的三处

| 项 | 为什么 |
|---|---|
| 4845 行完整托管栈 | 它的复杂度来自「一台机器上同时有 Electron、浏览器、别的推理服务」。DSH 若不托管引擎，这一整层是负债。 |
| `catalog.json` 的 5 条模型清单 | 硬编码的模型目录会立刻过期（Hermes 自己只有 5 条，且有 `schema_version: 3`）。DSH 要用就做成远程可更新。 |
| `_FLAG_TO_KEY` 这套 flag→ini 翻译 | llama.cpp 的参数名在版本间改过（`--load-mode` vs `-dio`，见 `supervisor.py:100-108` 的兼容探测）。抄一份固定的映射表，下一个版本就错。**要抄的是「先跑 `--help` 再决定参数」这个做法**。 |

---

## ⑤ 实证 / 推断分界

| 类型 | 内容 |
|---|---|
| **【实证】** | 端点解析三段顺序、窗口阶梯算法、`ctx_bytes` 三分支、增长五门、touch 就绪判定、`/health` 不算就绪、`_RESTART_BACKOFF_S`、`IDLE_UNLOAD_S`、`_DEFAULT_PORT=18434`、进程身份四元组校验、WebP 静默失败（含 `Red`/`Unseen` 实测对照）、Ollama `num_ctx` 默认 2048、LM Studio `allowed_options` 夹取、探针瀑布四段顺序、`localhost`→`127.0.0.1` 的 2 秒代价、`os.kill(pid,0)` 在 Windows 上会杀进程、凭据环境变量导致 libomp `STATUS_HEAP_CORRUPTION`、`models_max` 按价算法、`KILL_ON_JOB_CLOSE` + `CREATE_SUSPENDED`、SWA 三级判定优先序、`-ot` 三种放置、`_LAZY_READ_TENSORS` 仅两个架构 |
| **【推断】** | 「`_GROW_AT_OCCUPANCY=0.85` 这个具体数字在别的模型族上也合适」——它来自 llama.cpp + 独显 NVIDIA 的实测（`context_policy.py:4-5`），换后端可能偏；「144K 目标窗口对 DSH 同样最优」——161 个会话是 Hermes 自己的负载形状，DSH 的负载可能不同；「6 tok/s 速度地板」同理 |
| **【未验证】** | ① 各家引擎在 `q8_0` KV + FA 下的**实际**每 token 字节数（本面用的是公式推导，未跑真机比对 RSS）；② UMA 上「设备查询差 3 倍」是 Hermes 的实测结论，未见其原始数据，本面只转述；③ 不同 llama.cpp 构建版本对 `--models-autoload` / `/models` 的 `status.args` 字段是否一致 —— 若不一致，`router_launch_ctx` 会静默返回 None |

**验证方法**（若要转成实证）：
- ①：给定 GGUF 与窗口，读 `/metrics` 的 `llamacpp:kv_cache_usage_ratio` 反推，与公式对比（偏差应 < 5%）；
- ②：在 UMA 机器上同时读 `nvidia-smi` free 和 `GlobalMemoryStatusEx` 的 avail，记录两者差异方向与幅度；
- ③：拿三种构建（CUDA / Vulkan / CPU）各跑一次 `GET /models`，比对 `status.args` 结构。

---

## ⑥ 补充：这一面暴露的 Hermes 自身缺陷

| # | 缺陷 | 位置 | 后果 | DSH 怎么避 |
|---|---|---|---|---|
| L1 | **`/models` 状态读默认会加载模型** | `endpoint.py:20-29` | 任何「看一眼它加载了没」的调用，都会把刚 eject 的模型加回来 —— 一个只读操作变成了写操作 | 所有状态读都带 `autoload=false` 一类参数；**做状态查询前先问自己「这个 GET 会不会改状态」** |
| L2 | **孤儿回收在 Windows 上直接放弃** | `supervisor.py:348-349` | `if sys.platform == "win32": return` —— 崩溃后的模型子进程留在那儿占显存，只能靠 Job Object 兜（而 Job Object 只在拥有者活着时有效） | 用 Job Object 从第一天起就包含子进程，别指望事后回收 |
| L3 | **`_pid_alive` 在无 psutil 时「乐观返回 True」** | `endpoint.py:34-43` | 没有 psutil 的环境里，一个死掉的 PID 会被当成活的，端点解析会挂到一个死端口上 | 探活失败要**倾向否定**，不是倾向肯定 |
| L4 | **`_same_birth` 依赖 boot-relative 指纹，时钟跳变即失配** | `recovery.py:41-43` | WSL 里时钟被同步后，活着的进程被判成「不是上次那个」，于是重复启动第二个服务器 | 进程身份用「创建时间 + 可执行文件 inode/exe 路径 + 启动参数哈希」三元组，别只用一个 |
| L5 | **`admitted_residency_count` 的「装得下两份」是保守近似** | `presets.py:333-335` | 三个大小不一的模型可能实际两两都能装，但最大的装不下两份 → 上限被压到 1，容量浪费 | 若要做准，用贪心/背包而不是「最大 ×2」 |
| L6 | **`_managed_local_load_notice` 的异常全都吞掉** | `chat_completion_local.py:99-102` | `except Exception: return None` —— 进度提示失效时用户看到的是「卡死」，而日志里只有 debug | 提示层可以降级，但**降级本身要可见**（至少在 UI 上标「进度不可用」） |
| L7 | **窗口增长依赖「重载服务器」** | `growth.py:96-99` | 涨一个档位 = 一次冷启动。用户在第 100 轮对话里感受到的是「突然卡了 40 秒」 | 增长要在**空闲且用户没有未完成请求**时做，且要给出可见提示 |
| L8 | **`detect_server` 只探 8080 + 配置里的端口** | `detect.py:16,60-66` | 用户跑在 8081/11434 上就完全探不到，除非手动填 `detect_ports` | 默认端口表要包含各引擎的真实默认：8080(llama.cpp)、11434(Ollama)、1234(LM Studio)、8000(vLLM) |

> **本面最大的价值，是把「本地模型」从「一个 base_url」还原成「一整层运维」。**
> 如果只能带走一条：**本地模型的失败不报错，只降质** —— 少看见一张图、慢三倍、窗口被悄悄截到 2048、
> 请求被路由到云端。云端失败你会知道；本地失败要你自己去证明它没失败。

---

## 附：与其他面的关系

| 面 | 关系 |
|---|---|
| 03 压缩 | 窗口是压缩阈值的分母。本地窗口若被 `num_ctx` 截小而压缩器不知道，**压缩永不触发**（`agent_init_ollama.py:50-57`）—— 这是 03 面所有阈值的前提 |
| 12 路由 | 本面是 12 面的一个特例分支，但它的失败模式（静默降质）与云端（显式 4xx/5xx）完全不同，所以必须单独看 |
| 14 失败分类 | 两件事都在 14 面：①本地 read 超时必须单独放大（120→1800s，证据 E17-218），且「有进度块」要当作心跳替代「有字节」；②`timeout` 语义不同——慢 ≠ 坏，14 面的 `timeout` 类在本地要降级为「等待」而不是「重试」 |
| 15 验证 | 「不信声明，只信可观测结果」是同一条原则：15 面用它判「做完了」，本面用它判「服务器能用了」 |
| 附录 A17 | 本面的机制与 A16 的参数，**施工顺序与排错判据**在 `08-附录/A17-本地模型落地手册.md`——P0 判定 → P6 兜底，每阶段带可判定断言 |
