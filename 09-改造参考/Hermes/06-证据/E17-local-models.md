# 证据 E17 — 本地模型：接入、托管与物理约束

`0.22.2 / hermes_cli\local_runtime\*.py（19 模块 4845 行）+ agent\{chat_completion_local,agent_init_ollama,lmstudio_reasoning,model_metadata_llamacpp,local_prompt_progress,auxiliary_local_runtime}.py`

复现命令（在 `<旧位置>\Hermes\hermes-agent` 下）：

```bash
wc -l hermes_cli/local_runtime/*.py | sort -rn
sed -n '1,60p' hermes_cli/local_runtime/context_policy.py
sed -n '63,115p;184,210p;219,260p;293,324p' hermes_cli/local_runtime/context_policy.py
sed -n '1,10p;29,72p;499,591p' hermes_cli/local_runtime/hardware.py
sed -n '50,130p;138,190p;191,238p' hermes_cli/local_runtime/estimator.py
sed -n '1,60p;175,215p;258,300p;303,340p;395,487p' hermes_cli/local_runtime/supervisor.py
sed -n '1,120p;152,161p' hermes_cli/local_runtime/endpoint.py
sed -n '1,66p' hermes_cli/local_runtime/detect.py
sed -n '1,79p' hermes_cli/local_runtime/capabilities.py
sed -n '323,360p' hermes_cli/local_runtime/presets.py
sed -n '90,142p' hermes_cli/local_runtime/processes.py
sed -n '25,150p' hermes_cli/local_runtime/recovery.py
sed -n '409,495p' hermes_cli/local_runtime/bootstrap.py
sed -n '52,144p' hermes_cli/local_runtime/growth.py
sed -n '2719,2731p' hermes_cli/config_defaults.py
sed -n '677,716p;719,770p;1425,1465p' agent/model_metadata.py
sed -n '1,67p' agent/agent_init_ollama.py
sed -n '1,40p' agent/lmstudio_reasoning.py
sed -n '1,102p' agent/chat_completion_local.py
sed -n '1,35p' agent/auxiliary_local_runtime.py
sed -n '522,557p' hermes_cli/runtime_provider_custom.py
python -c "import json,pathlib;print(len(json.loads(pathlib.Path('hermes_cli/local_runtime/catalog.json').read_text(encoding='utf-8-sig'))['models']))"
```

| # | 路径:行 | 原文（≤40 字） | 说明 |
|---|---|---|---|
| E17-01 | hermes_cli/local_runtime/context_policy.py:3 | `One contract: any model runs at any window up to its native max` | 窗口契约 |
| E17-02 | context_policy.py:4-5 | `Constants, not knobs — nothing in this module reads config` | 策略层不读配置 |
| E17-03 | context_policy.py:5 | `behavior measured on real hardware (llama.cpp, discrete NVIDIA on Windows/WDDM, unified-memory)` | 常量的来源是被测真机 |
| E17-04 | context_policy.py:16 | `FLOOR = 64 * 1024` | 窗口地板 |
| E17-05 | context_policy.py:17 | `_LADDER_GROWTH = 1.5` | 阶梯倍率 |
| E17-06 | context_policy.py:18 | `_GROW_AT_OCCUPANCY = 0.85` | 增长触发占用率 |
| E17-07 | context_policy.py:19 | `SPEED_FLOOR_TOK_S = 6.0` | 速度地板 |
| E17-08 | context_policy.py:20 | `_EARLY_COST_CTX_FRACTION = 0.15` | 早成本上限 |
| E17-09 | context_policy.py:22-25 | `66% complete uncompressed in 64K, 82% in 96K, 91% in 144K` | 161 个真实会话 |
| E17-10 | context_policy.py:24-25 | `the marginal gain past 144K (+6 points for 216K) falls below the quality cost` | 为什么停在 144K |
| E17-11 | context_policy.py:26 | `TARGET_WINDOW = 144 * 1024` | 目标窗口 |
| E17-12 | context_policy.py:28-32 | `a model estimated at 29.3 GiB loaded at ~31.2 GiB resident` | 运行时开销实测 |
| E17-13 | context_policy.py:31-32 | `once packed a card 3.9 GiB past this constant` | logits buffer 单独计价的原因 |
| E17-14 | context_policy.py:33 | `RUNTIME_OVERHEAD_BYTES = int(1.5 * (1 << 30))` | 固定开销 |
| E17-15 | context_policy.py:40-48 | `64K -> 96K -> 128K -> ... -> native` | ladder 生成 |
| E17-16 | context_policy.py:67-70 | `largest cheap rung, never below the floor` | 决策目标 |
| E17-17 | context_policy.py:72-75 | `refusal = physics_check(...)` 后立即返回 | 拒绝优先于一切 |
| E17-18 | context_policy.py:87-91 | `for rung in rungs: if need(rung) > usable: break` | 零溢出扫描 |
| E17-19 | context_policy.py:95 | `largest zero-spill rung ({window // 1024}K)` | 支路标记 |
| E17-20 | context_policy.py:99 | `cap = int(budget.usable_vram_bytes * _EARLY_COST_CTX_FRACTION)` | 早成本支路的上限 |
| E17-21 | context_policy.py:104-107 | `if (kv(rung) > cap or need(rung) > usable + ram): break` | 双重上界 |
| E17-22 | context_policy.py:108 | `floor held at {n}K; weights spill (deliberate price of the guarantee)` | 宁可溢出也保地板 |
| E17-23 | context_policy.py:140-141 | `if mtp_capable and profile.kv_scale == 1.0: kv_scale=1.2` | MTP 草稿上下文加价 |
| E17-24 | context_policy.py:174-180 | `A previously granted window keeps its spill policy` | 恢复的窗口不轻易丢 |
| E17-25 | context_policy.py:187-192 | `moving weights to the CPU on a live reading is how a launch once pinned a fitting model to the CPU` | 实时读数会误判 |
| E17-26 | context_policy.py:195-196 | `if not isinstance(decision, WindowDecision) or decision.spilled: return plan` | 溢出计划不再缩 |
| E17-27 | context_policy.py:223 | `One growth evaluation, END-OF-TURN ONLY` | 只在回合末 |
| E17-28 | context_policy.py:223 | `recurrent state cannot rewind mid-sequence` | 原因 |
| E17-29 | context_policy.py:225-229 | `occupancy (~85%) -> native cap -> idleness -> speed floor -> re-fit` | 门序 |
| E17-30 | context_policy.py:227-229 | `so two edge definitions can't deadlock into compress-before-grow` | 死锁修复 |
| E17-31 | context_policy.py:241-246 | `decode {x} tok/s below the ~6 tok/s floor` | 速度门文案 |
| E17-32 | context_policy.py:250-251 | `allocation beyond residency is the slow path` | 门5 的理由 |
| E17-33 | context_policy.py:260-277 | `Takes the fewest blocks, lowest index first` | recurrent 块选择 |
| E17-34 | context_policy.py:280-290 | `MoE gets the expert pattern; hybrids push the FFNs of just enough recurrent blocks` | 三种放置 |
| E17-35 | context_policy.py:297-298 | `Explicit -c puts fit into spill-weights-and-hold-ctx` | 显式 -c 的语义 |
| E17-36 | context_policy.py:299 | `args = ["-c", str(decision.window)]` | 参数起点 |
| E17-37 | context_policy.py:308 | `-ctk q8_0 -ctv q8_0 -fa on` | KV 量化 |
| E17-38 | context_policy.py:309-310 | `if decision.spilled and not uma:` | 放置仅独显 |
| E17-39 | context_policy.py:314-323 | `priced from the model's own vocab and calibrated against measured server RSS` | logits 公式 |
| E17-40 | estimator.py:15-16 | `_Q8_BYTES_PER_ELEM = 34 / 32` / `_F16_BYTES_PER_ELEM = 2.0` | 字节常量 |
| E17-41 | estimator.py:43 | `_RECURRENT_STATE_PER_LAYER = 4 << 20` | 每层状态 |
| E17-42 | estimator.py:59-60 | `decoupled from GGUF parsing so decision-table tests can construct profiles` | 纯函数设计 |
| E17-43 | estimator.py:70 | `(kind, kv_bytes_per_token_f16)` | 层元组语义 |
| E17-44 | estimator.py:77-78 | `1.2 rounds up so the error stays on the safe side` | 安全方向取整 |
| E17-45 | estimator.py:108-111 | `Discrete cards may trust the device query; unified-memory devices must budget from OS free` | 预算来源规则 |
| E17-46 | estimator.py:120-123 | `llama.cpp's own default does so everywhere except integrated GPUs (b11370 #28160)` | 懒读差异 |
| E17-47 | estimator.py:124-127 | `Windows charges every GPU allocation to commit` | commit 上限 |
| E17-48 | estimator.py:130-135 | `on-demand tensors count as weights where the engine reads them up front` | as_loaded |
| E17-49 | estimator.py:144-152 | 三级优先：文件自身模式 > 架构比例 > 全按 full | SWA 判定 |
| E17-50 | estimator.py:176-182 | profile 组装 | 字段来源 |
| E17-51 | estimator.py:185-188 | `q8_0 with FA ... f16 on exotic non-FA fallbacks` | KV 因子 |
| E17-52 | estimator.py:191-204 | ctx_bytes 三分支 | 窗口成本 |
| E17-53 | estimator.py:207-213 | `The only true refusal` | 唯一拒绝 |
| E17-54 | estimator.py:224-237 | `try a smaller model or a supported smaller quant` | 补救方向 |
| E17-55 | hardware.py:3-6 | `unified-memory devices must budget from OS free physical memory minus headroom` | 规则原文 |
| E17-56 | hardware.py:6 | `device queries have been observed off by 3x in both directions` | 差三倍 |
| E17-57 | hardware.py:32 | `the 2 GiB floor is what a 512 MiB floor failed to cover` | 余量地板演化 |
| E17-58 | hardware.py:33 | `a 221K grant measured 31.9/32.6 GiB with the desktop running` | 实测 |
| E17-59 | hardware.py:37-38 | `a browser tab or a chat app can take another GiB between launch and the next request` | 启动余量 |
| E17-60 | hardware.py:43-46 | `The cache holds conversations the server switched away from` | prompt cache 作用 |
| E17-61 | hardware.py:50-51 | `BOTH must hold, and no discrete card can meet either` | 统一内存两道闸 |
| E17-62 | hardware.py:58 | `_CU_DEVICE_ATTRIBUTE_INTEGRATED = 18` | 驱动侧判定 |
| E17-63 | hardware.py:499-506 | `planning=False: LIVE ... planning=True: CAPACITY` | 两套预算 |
| E17-64 | hardware.py:505-507 | `pricing against live-free while a model was loaded made every row read as too large` | 为什么分两套 |
| E17-65 | hardware.py:513-517 | `carved-out memory is invisible to GlobalMemoryStatusEx` | 不能夹到 OS RAM |
| E17-66 | hardware.py:527-528 | `decode collapses ~3.5x when concurrent demand hits it` | 池边缘是软悬崖 |
| E17-67 | hardware.py:559-567 | `4.5-6.3 GiB held by other apps decoded at ~24 tok/s` | 满窗代价 |
| E17-68 | hardware.py:567 | `at ~90 tok/s at a window sized from free memory` | 空闲窗对照 |
| E17-69 | hardware.py:568-569 | `a stopped server's memory reads as free by the time its process has exited` | own_bytes 可当空闲 |
| E17-70 | supervisor.py:3-4 | `router children are its problem — child failures surface via GET /models exit_code` | 责任边界 |
| E17-71 | supervisor.py:5 | `health-200 is NOT readiness` | 就绪 ≠ 健康 |
| E17-72 | supervisor.py:5-6 | `temp-0, expected token, generous budget, reasoning_content scanned` | touch 四要素 |
| E17-73 | supervisor.py:6-7 | `resolving localhost adds ~2s per request on Windows via IPv6 fallback` | 2 秒代价 |
| E17-74 | supervisor.py:33-34 | `Reply with exactly one word: the capital of France.` | touch 探针 |
| E17-75 | supervisor.py:35 | `_RESTART_BACKOFF_S = (1, 5, 15, 60)` | 重启退避 |
| E17-76 | supervisor.py:36 | `_RESIDENT = ("loaded", "ready")` | 驻留态 |
| E17-77 | supervisor.py:38-42 | `Chosen once and reused across restarts` | 稳定端口 |
| E17-78 | supervisor.py:41-42 | `Deliberately NOT 8080 so we never collide` | 避开用户自己的栈 |
| E17-79 | supervisor.py:114-118 | `A constant, not a knob` / `IDLE_UNLOAD_S = 15 * 60` | 空闲卸载 |
| E17-80 | supervisor.py:116-117 | `frees ~20 GiB within the hour` | 收益量级 |
| E17-81 | supervisor.py:183-185 | `--models-autoload` 驻留契约 | 聊到就加载 |
| E17-82 | supervisor.py:186-187 | `--metrics` / `--slots` 都是 opt-in | 默认关 |
| E17-83 | supervisor.py:190-192 | `Direct I/O on model load bypasses the page cache` | 避免冲掉 OS 缓存 |
| E17-84 | supervisor.py:100-108 | `Select the loading option supported by this engine, including older pinned builds` | 参数名漂移 |
| E17-85 | supervisor.py:201-202 | `each restart would leak one fd` | fd 泄漏 |
| E17-86 | supervisor.py:206-208 | `list-args, never a shell` | 带空格路径 |
| E17-87 | supervisor.py:210-213 | `State goes down at SPAWN, not after health` | 状态先写 |
| E17-88 | supervisor.py:212 | `a readiness probe racing the boot doesn't throw the app back to onboarding` | 原因 |
| E17-89 | supervisor.py:243-256 | `_wait_health` 里先查进程是否已退出 | 早失败 |
| E17-90 | supervisor.py:258-285 | `_watch` 重启循环 | 路由器自愈 |
| E17-91 | supervisor.py:306-308 | `Terminating only the router orphans them with the weights still resident` | 必须杀树 |
| E17-92 | supervisor.py:308-309 | `the parent must be alive to walk them` | 先枚举后杀 |
| E17-93 | supervisor.py:341-342 | `Its VRAM must come back before the new router loads` | 崩溃先收尸 |
| E17-94 | supervisor.py:348-349 | `if sys.platform == "win32": return` | Windows 放弃回收 |
| E17-95 | supervisor.py:397-398 | `a failed telemetry probe is neither idle nor busy` | 失败不重置时钟 |
| E17-96 | supervisor.py:412-413 | `keeping idle clock` | 同上 |
| E17-97 | supervisor.py:430-442 | `touch_generate` 全文 | 就绪证明 |
| E17-98 | supervisor.py:431-432 | `small token budgets false-fail reasoning models` | 512 的原因 |
| E17-99 | supervisor.py:438 | `content + " " + reasoning_content` | 两处都扫 |
| E17-100 | supervisor.py:444-451 | `Load if needed, then prove readiness with a touch generation` | 两步合一 |
| E17-101 | supervisor.py:461-465 | `True = confirmed idle, False = busy, None = the probe itself failed` | 三态 |
| E17-102 | supervisor.py:456-458 | `/slots` 和 `/metrics` 是 per-child 且要 ?model= | 路由怪癖 |
| E17-103 | supervisor.py:473-474 | `if exc.code == 400: continue` | 未加载视为空闲 |
| E17-104 | endpoint.py:17 | `LLAMACPP_ALIASES` 三个写法 | 别名 |
| E17-105 | endpoint.py:20-29 | `autoload=false makes the router answer 400` | 状态读不能加载 |
| E17-106 | endpoint.py:34-36 | `On Windows os.kill(pid, 0) TERMINATES the process` | 不能拿 0 号信号探活 |
| E17-107 | endpoint.py:42-43 | `else True (optimistic)` | 无 psutil 时乐观 |
| E17-108 | endpoint.py:69-71 | `on the shared stable port a foreign install's server answers /health for anyone` | 必须做归属校验 |
| E17-109 | endpoint.py:89-96 | `Managed-first, detection-second` | 解析顺序 |
| E17-110 | endpoint.py:94-95 | `the desktop's readiness probe fires the moment the WebSocket connects` | 引导竞态 |
| E17-111 | endpoint.py:103-106 | `detect_ports` 参与探测 | 额外端口 |
| E17-112 | endpoint.py:108-116 | `wait_for_boot_s` 每 0.25 秒轮询 | 竞态等待 |
| E17-113 | endpoint.py:133-134 | `a kick is already in flight` | 非阻塞抢锁 |
| E17-114 | detect.py:1-5 | `Ollama and LM Studio answer /v1/models but not /props` | 指纹依据 |
| E17-115 | detect.py:15 | `Always 127.0.0.1 — resolving localhost costs ~2s/request` | 同上 |
| E17-116 | detect.py:16 | `DEFAULT_PROBE_PORTS = (8080,)` | 只探 8080 |
| E17-117 | detect.py:44-45 | `if status == 401: return ... auth_required=True` | 401 也算探到 |
| E17-118 | detect.py:48-50 | `if not build: return None` | 无 build_info 即否 |
| E17-119 | detect.py:56 | `router_mode=models_status == 200` | 路由器模式 |
| E17-120 | devices.py:1-5 | `Loading a GPU driver can crash or hang the caller, hence a child` | 子进程隔离 |
| E17-121 | devices.py:6-7 | `with a deadline that imports only the standard library (-I)` | 干净子进程 |
| E17-122 | devices.py:19-21 | `enum ggml_backend_dev_type: CPU, GPU, IGPU, ACCEL` | 引擎自己的融合判定 |
| E17-123 | devices.py:52-56 | `ggml_backend_load(os.fsencode(...))` | 动态加载 |
| E17-124 | devices.py:70 | `range(min(..., 64))` | 设备数上限 |
| E17-125 | capabilities.py:3-6 | `capability lookups consult cloud-shaped catalogs that have never heard of a local GGUF` | 能力倒查失效 |
| E17-126 | capabilities.py:5-6 | `a screenshot silently leaving the machine` | 双重失败 |
| E17-127 | capabilities.py:18-21 | `PNG/JPEG/GIF/BMP yes, WebP NO` | 支持集 |
| E17-128 | capabilities.py:19-21 | `a WebP part fails SILENTLY (no HTTP error, no log line)` | 静默失败 |
| E17-129 | capabilities.py:21 | `the same red square answered 'Red' as PNG, 'Unseen' as WebP` | 实测对照 |
| E17-130 | capabilities.py:22 | `ACCEPTED_IMAGE_MIMES = {"image/png", "image/jpeg"}` | 白名单 |
| E17-131 | capabilities.py:26-27 | `custom only counts when the base_url IS the managed endpoint` | 不认别人的服务器 |
| E17-132 | capabilities.py:55-57 | `Ground-truth vision capability ... or None when nothing is known` | 三态设计 |
| E17-133 | capabilities.py:65-67 | `Only answer for models actually staged with us` | 只答自己的 |
| E17-134 | capabilities.py:71-78 | `Capability requires the projector to actually be on disk` | mmproj 必须在盘 |
| E17-135 | presets.py:326-331 | `that child decodes at a third of its speed for the rest of its life` | 超额代价 |
| E17-136 | presets.py:330-331 | `ejecting the incumbent afterwards does not repair it` | 不可自愈 |
| E17-137 | presets.py:333-335 | `the cap rises above one only while the LARGEST staged model still fits TWICE` | 驻留规则 |
| E17-138 | presets.py:338-340 | `makes llama.cpp evict its LRU before the incoming child allocates` | 为什么按价 |
| E17-139 | presets.py:336-337 | `an unpriceable input ... keeps today's behaviour` | 退化路径 |
| E17-140 | presets.py:212-216 | `Router discovery is preset-only: refused files must never autoload with stock fit` | 被拒的文件 |
| E17-141 | presets.py:233-241 | `Sampling deference ladder` | 采样三级让步 |
| E17-142 | presets.py:258-259 | `acceptance 83% at 2-3 drafts, collapses at 4` | 草稿深度 |
| E17-143 | presets.py:21-28 | `_FLAG_TO_KEY` 九个 flag | 参数翻译 |
| E17-144 | presets.py:170-181 | `preset_for_model` docstring | 决策入口 |
| E17-145 | processes.py:90 | `_CREDENTIAL_ENV_MARKERS = ("_API_KEY", "_TOKEN", ...)` | 凭据过滤 |
| E17-146 | processes.py:96-99 | `the bundled OpenMP runtime died with STATUS_HEAP_CORRUPTION` | libomp 崩 |
| E17-147 | processes.py:99-101 | `confirmed on a model-free libomp.dll probe` | 已定位到变量 |
| E17-148 | processes.py:67-68 | `KILL_ON_JOB_CLOSE` (0x2000) | 拥有者死则整树死 |
| E17-149 | processes.py:122-125 | `CREATE_SUSPENDED` → assign → resume | 不让任何指令跑在 job 外 |
| E17-150 | processes.py:77-79 | `Popen retains the original process handle, avoiding a PID-reuse race` | 句柄而非 PID |
| E17-151 | recovery.py:54 | `Match a modern process incarnation, never just its reusable PID` | 身份规则 |
| E17-152 | recovery.py:41-43 | `create_time derived from /proc/stat's boot time, which moves whenever the clock is stepped` | WSL 陷阱 |
| E17-153 | recovery.py:67 | `Windows retains the original parent PID; POSIX reparents orphans` | 双平台差异 |
| E17-154 | recovery.py:94 | `A stepped clock (WSL) moves create_time, so inequality alone would bury a live owner` | 不能只看不等 |
| E17-155 | recovery.py:105 | `Legacy records lack process birth identity` | 旧记录更严 |
| E17-156 | recovery.py:113 | `A damaged new record must not fall back to weaker legacy evidence` | 不回退弱证据 |
| E17-157 | bootstrap.py:3-5 | `disabled or already-running -> no-op` | 幂等 |
| E17-158 | bootstrap.py:5-6 | `callers gate on config before importing` | 不付 import 代价 |
| E17-159 | bootstrap.py:415-416 | `if not force and not section.get("enabled")` | 关=只探测 |
| E17-160 | bootstrap.py:424-428 | `no staged models means nothing to serve` | 不启空服务器 |
| E17-161 | bootstrap.py:430-434 | `reuse via state, but ONLY while its launch policy still covers every staged model` | 复用前提 |
| E17-162 | bootstrap.py:436-438 | `two backends racing to boot (#116682)` | 跨进程锁 |
| E17-163 | bootstrap.py:444-449 | `replacing it so every model launches with a policy` | 陈旧即替换 |
| E17-164 | bootstrap.py:382-383 | `the loser waits here, then re-checks state and adopts the winner's server` | 锁后重查 |
| E17-165 | bootstrap.py:472-476 | `leaving it running unsupervised strands its VRAM` | 半启动要 stop |
| E17-166 | bootstrap.py:21-24 | `one router per Hermes process` | 进程级单例 |
| E17-167 | bootstrap.py:22-23 | `another profile's local_runtime.backend must not resize it` | 共享服务器 |
| E17-168 | config_defaults.py:2719 | `No context/VRAM knobs by design` | 设计声明 |
| E17-169 | config_defaults.py:2719-2720 | `official binaries, one supervised llama-server in router mode` | 形态 |
| E17-170 | config_defaults.py:2723 | `Off = detection-only (Hermes still finds an external llama-server you run)` | 关闭语义 |
| E17-171 | config_defaults.py:2724 | `Engine versions and every dependent library are pinned by pm/lock.json` | 版本锁 |
| E17-172 | config_defaults.py:2727 | `models_max: 4` | 只是天花板 |
| E17-173 | config_defaults.py:2728 | `0 = pick a free port at spawn` | 端口 |
| E17-174 | config_defaults.py:2729-2731 | `Extra ports detection probes` | 探测端口 |
| E17-175 | model_metadata.py:677-680 | `loopback, container-internal DNS, unqualified hosts, RFC-1918, link-local and Tailscale CGNAT` | 六类本地 |
| E17-176 | model_metadata.py:688-691 | `Unqualified hostnames (no dots) are local by definition` | Docker 服务名 |
| E17-177 | model_metadata.py:695 | `addr in _TAILSCALE_CGNAT` | 100.64/10 |
| E17-178 | model_metadata.py:699-708 | 点分四段兜底（WSL 的 172.26.x.x） | 双保险 |
| E17-179 | model_metadata.py:711-716 | `Windows dual-stack resolves ::1 first and pays a ~2s IPv6 connect timeout` | 改写依据 |
| E17-180 | model_metadata.py:719-720 | `Probe known endpoints: ollama, lm-studio, vllm, llamacpp, or None` | 四类 |
| E17-181 | model_metadata.py:724-728 | `A hosted provider never runs Ollama/LM Studio/llama.cpp/vLLM` | 远程不探 |
| E17-182 | model_metadata.py:726-727 | `ollama.com is the one hosted host that does speak Ollama's /api/tags` | 唯一例外 |
| E17-183 | model_metadata.py:728-729 | `if _infer_provider_from_url(...) not in (None, "ollama-cloud")` | 判据 |
| E17-184 | model_metadata.py:743-744 | `LM Studio answers /api/tags with {"error": ...} and 200` | 为什么顺序硬性 |
| E17-185 | model_metadata.py:744 | `older llama.cpp builds have no /v1 prefix` | 两条路径 |
| E17-186 | model_metadata.py:745-750 | 四段瀑布 | 探针表 |
| E17-187 | model_metadata.py:764-767 | `A connect timeout condemns the host` | 黑洞判定 |
| E17-188 | model_metadata.py:735-738 | `Deliberately NOT written to the hour-long verdict cache` | 黑洞不进长缓存 |
| E17-189 | model_metadata.py:1427-1428 | `an unauthorized probe can never produce a positive verdict` | 探测带 key |
| E17-190 | model_metadata.py:1434-1447 | `Ollama /api/show context ... the value to send as num_ctx` | 窗口探测 |
| E17-191 | model_metadata.py:1440-1442 | 磁盘缓存命中即返回 | 探测持久化 |
| E17-192 | model_metadata.py:1450-1465 | `capabilities on 0.6.0+, else model_info.*.vision.block_count` | 视觉双路径 |
| E17-193 | model_metadata.py:535-538 | `Probe root for a local server: IPv4-resolved, /v1 suffix stripped` | 根路径归一 |
| E17-194 | agent_init_ollama.py:10 | `Ollama defaults num_ctx to 2048, so detect the max window` | 默认 2048 |
| E17-195 | agent_init_ollama.py:28-29 | `GGUF metadata can advertise 256K+ and Ollama would allocate that much VRAM` | 为什么封顶 |
| E17-196 | agent_init_ollama.py:50-53 | `every request runs at num_ctx, so a trigger derived from the probed window could sit above it` | 夹窗理由 |
| E17-197 | agent_init_ollama.py:55-56 | `could sit several times ABOVE the real served window and never fire` | 后果 |
| E17-198 | agent_init_ollama.py:57 | `Overlaps #60103's silent-clamp dead zone` | 已知死区 |
| E17-199 | agent_init_ollama.py:41-47 | `Name the real source` | 两种来源分开报 |
| E17-200 | lmstudio_reasoning.py:2-6 | `capabilities.reasoning.allowed_options` 两种形态 | 允许集 |
| E17-201 | lmstudio_reasoning.py:17-19 | `without this ceiling clamp they'd fall to the medium default (more yields less than xhigh)` | 越界反降 |
| E17-202 | lmstudio_reasoning.py:20 | `_LM_EFFORT_CLAMP = {"max": "xhigh", "ultra": "xhigh"}` | 夹取表 |
| E17-203 | lmstudio_reasoning.py:38-39 | 不在允许集则 `return None` | 省略而非替换 |
| E17-204 | lmstudio_reasoning.py:26-27 | `the user picked a level the model can't honor` | 设计意图 |
| E17-205 | lmstudio_reasoning.py:19-20 | `Separate from _LM_EFFORT_ALIASES, which must not rewrite allowed_options` | 两张表不能混 |
| E17-206 | chat_completion_local.py:23-26 | `These requests always stream and ask for prompt progress` | 必流式 |
| E17-207 | chat_completion_local.py:25-26 | `A non-streamed request can't be cancelled through the router` | 取消不了 |
| E17-208 | chat_completion_local.py:26 | `it would keep the server busy after Hermes gives up on it` | 后果 |
| E17-209 | chat_completion_local.py:44-45 | `"localhost" can resolve to ::1 first and wait out a timeout` | 探活改写 |
| E17-210 | chat_completion_local.py:46 | `urllib.request.ProxyHandler({})` | 探活禁代理 |
| E17-211 | chat_completion_local.py:54-59 | `let one attempt through` | 跨回合放行一次 |
| E17-212 | chat_completion_local.py:58-59 | `The router answers /health even while its model is stuck` | 单次放行的边界 |
| E17-213 | chat_completion_local.py:66 | `agent._consecutive_stale_streams = giveup - 1` | 只放一次 |
| E17-214 | chat_completion_local.py:70-73 | `Otherwise a cold load reads as a generic stall` | 冷加载提示 |
| E17-215 | chat_completion_local.py:88-89 | `loading {model} into memory — N%` | 加载进度 |
| E17-216 | chat_completion_local.py:96-98 | `no honest denominator, label-only` | 不编百分比 |
| E17-217 | chat_completion_local.py:99-102 | `A status line must never break the stream it describes` | 兜底，但静默 |
| E17-218 | chat_completion_helpers.py:2911-2913 | `local providers prefill for minutes` | read 120→1800s |
| E17-219 | chat_completion_helpers.py:40-42 | `Remote endpoints must never be fingerprinted` | 远程禁探 |
| E17-220 | chat_completion_helpers.py:41-42 | `without an api_key, return 401 on every leg (issue #89863)` | 后果 |
| E17-221 | local_prompt_progress.py:24-29 | `extra_body.return_progress = True` | 要进度块 |
| E17-222 | local_prompt_progress.py:5-6 | `the stall timers stay quiet while the server works` | 进度即心跳 |
| E17-223 | local_prompt_progress.py:6-7 | `the router notices a client hang-up within seconds` | 取消可见 |
| E17-224 | local_prompt_progress.py:8-9 | `Compression also leaves the time ... out of its total time limit` | 压缩时限扣除 |
| E17-225 | local_prompt_progress.py:35-37 | `A progress chunk carries an empty assistant delta` | 进度块的判定 |
| E17-226 | model_metadata_llamacpp.py:21-22 | `a lazily-loaded model doesn't fall to a family catch-all` | 懒加载也要窗口 |
| E17-227 | model_metadata_llamacpp.py:22-23 | `a context probe must not undo an Eject or an idle unload` | autoload=false 又一次 |
| E17-228 | model_metadata_llamacpp.py:42-63 | 从 `status.args` 配对 `-c/--ctx-size` | 反解启动参数 |
| E17-229 | model_metadata_llamacpp.py:61-62 | `for flag, value in pairwise(args)` | 成对扫描 |
| E17-230 | auxiliary_local_runtime.py:3-5 | `A bare alias means "the local server Hermes manages for this profile"` | 别名语义 |
| E17-231 | auxiliary_local_runtime.py:6-7 | `handed the local model slug to whatever cloud provider held a key (#119227)` | 数据外泄 |
| E17-232 | auxiliary_local_runtime.py:7 | `or to the primary's own endpoint` | 第二种错法 |
| E17-233 | auxiliary_local_runtime.py:22-23 | `Read on every call so a restarted server's new port/key is picked up` | 不缓存端点 |
| E17-234 | runtime_provider_custom.py:523-526 | `No server => say so and stop` | 不 fall through |
| E17-235 | runtime_provider_custom.py:524-526 | `would surface "local server is off" as OpenRouter's baffling 401` | 文案错位 |
| E17-236 | runtime_provider_custom.py:537-547 | 按 enabled 分两种文案 | 两种错因分开说 |
| E17-237 | runtime_provider_custom.py:542-544 | `It may still be starting — try again in a moment` | 第一种不是错误 |
| E17-238 | growth.py:69-70 | `The caller sits at a request boundary by construction` | 增长位置 |
| E17-239 | growth.py:69-71 | `the next request rebuilds server state in the larger window — nothing rewinds` | 靠重载 |
| E17-240 | growth.py:103 | `Capacity budget, not live-free` | 增长用容量预算 |
| E17-241 | growth.py:104-105 | `it reads its own residency as unavailable and vetoes rungs that fit` | 自指偏差 |
| E17-242 | growth.py:120-121 | `the model's own memory counts as free, draft included` | own_bytes |
| E17-243 | growth.py:124-125 | `Other loaded models still count as held, which errs toward a smaller window` | 保守方向 |
| E17-244 | growth.py:131-132 | `the next rung does not fit beside other programs' GPU memory` | 二次校验 |
| E17-245 | growth.py:138-141 | `The override still lands at the next boot; report no growth NOW` | 失败即不报成功 |
| E17-246 | growth.py:141-142 | `refreshed preset did not grant the requested window` | 只认已生效 |
| E17-247 | gguf.py:28-33 | `only a marked tensor larger than 4 GiB is read this way` | 懒读范围 |
| E17-248 | gguf.py:31-34 | `_LAZY_READ_TENSORS` 仅 qwen4exp / gemma4 的 per_layer_token_embd | 极窄 |
| E17-249 | gguf.py:20-21 | `SPLIT_PART_RE = -(\d{5})-of-(\d{5})\.gguf$` | 分片 |
| E17-250 | gguf.py:80 | `exact sum over the tensor table` | 字节来自张量表 |
| E17-251 | gguf.py:83-84 | `so spill placement can move only as many blocks as it needs` | FFN 分块字节 |
| E17-252 | gguf.py:88-90 | `hybrids like Nemotron-H also have MoE-only blocks without KV heads` | recurrent 判定 |
| E17-253 | catalog.json | `schema_version: 3`，5 个模型 | 目录规模 |
| E17-254 | catalog.json（条目） | `n_ctx_train / mmproj / mtp / sampling / quality / draft` | 条目字段 |
| E17-255 | catalog.json（条目） | `qwen3.8-27b` ... `n_ctx_train: 262144` | 示例 |

---

## 附：本面用到的交叉引用

| 本面结论 | 依赖的其他面 |
|---|---|
| 窗口是压缩阈值的分母 | `02-主线/03-context-compaction.md` |
| 本地是路由的一个特例分支 | `02-主线/12-billing-routing.md` |
| 本地 read 超时必须单独放大（120→1800s），且「慢」≠「坏」，`timeout` 要降级为等待 | `02-主线/14-failure-recovery.md` |
| 「不信声明只信结果」的同一原则 | `02-主线/15-verification.md` |
