# 13 安装 / 数据目录 / 迁移

`0.22.2+2364.g0b10b9f / <旧位置>\Hermes / install.ps1、hermes_cli\update_*.py（60+ 文件）、config_migrations.py、backups\config\`

## ① 结论

1. **安装是可被外部编排的"分阶段协议"**，不是一个长脚本：`install.ps1 -Manifest` 打印阶段列表 JSON，`-Stage NAME -Json` 单跑一阶段，`-ProtocolVersion` 报协议版本。GUI 安装器按阶段驱动并显示进度。
2. **数据目录由 `HERMES_HOME` 单点决定**（默认 `%LOCALAPPDATA%\hermes`，本机覆盖成 `<旧位置>\Hermes`），源码在 `<home>\hermes-agent`，可执行 shim 在 `<home>\bin`。**整个 home 可搬**（因为路径都从 env 推）。
3. **更新是"标记文件 + 内核锁"双保险**：`.hermes-update-in-progress`（内容 `<pid>\n<started_at>\nct:<创建时间>`）判"owner 是否真活着"，`hermes-update.lock`（flock/msvcrt）保证两个进程不会同时改同一个 checkout。
4. **配置迁移是表驱动 + 版本门**：`_migrate_to_N` 逐级升，低于地板版本（v12）**整份不动**、走"默认值深合并"，绝不猜。
5. **本地改动的处理是"三件套"**：写前快照（`backups/config/config.yaml.good.<ts>`，每种 reason 只留 5 份）+ git autostash/rescue ref + `dirty` 标记（`install-stamp.json` 里能读到 `"dirty": true`）。
6. **降级被显式拒绝**：目标版本早于 gateway 运行时而 `state.db` 已有 ledger 行 → 更新直接拒绝并指出回滚点，因为"旧代码 + 新 schema"会让会话永远删不掉。

## ② 证据

| # | 位置 | 原文（截断） | 说明 |
|---|---|---|---|
| 1 | `install.ps1:1-6` | `Hermes Agent bootstrap: git checkout + venv + hermes command on PATH.` `-Manifest print the stage list as JSON` `-Stage NAME [-Json] run one stage` | 阶段协议 |
| 2 | `install.ps1:8-11` | `-ProtocolVersion print the stage protocol version` | 协议版本 |
| 3 | `install.ps1:29-30` | `[string]$HermesHome = (if ($env:HERMES_HOME) ... else "$env:LOCALAPPDATA\hermes")` `[string]$InstallDir = ...\hermes-agent` | 目录推导 |
| 4 | `install.ps1:20-24` | `-Channel stable\|main` `stable (default): the latest published release` | 渠道 |
| 5 | `install.ps1:1306` | `skills and migrates config. Node, browsers and the frontend build tools` | 升级期会跑迁移 |
| 6 | `install.ps1:1135` | `$rescue = "refs/hermes-update-backups/$rescueKind-$Branch-$stamp-$prior"` | git rescue ref |
| 7 | `hermes-agent/install-stamp.json:2-10` | `"schemaVersion": 2` `"commit"` `"branch": "main"` `"source": "git"` `"updateMechanism": "self"` `"dirty": true` | 安装指纹 |
| 8 | `hermes-agent/install-stamp.json:11-13` | `"baseVersion": "0.22.2"` `"displayVersion": "0.22.2+2364.g0b10b9f.dirty"` `"distance": 2364` | 版本算法 |
| 9 | `hermes_cli/update_lock.py:3-14` | `The update marker <root hermes home>/.hermes-update-in-progress (contract C1, format v2)` `<pid>\n<started_at>\nct:<owner creation time, 3 decimals>` | 标记格式 |
| 10 | `hermes_cli/update_lock.py:17-21` | `The checkout lock <git common dir>/hermes-update.lock` `a kernel lock (flock / msvcrt)` | 内核锁 |
| 11 | `hermes_cli/update_lock.py:15-16` | `An owner is live while its pid is alive and its creation time still matches: never by age` | 存活判据 |
| 12 | `hermes_cli/config_backups.py:1-7` | `Every writer that wants a "before" copy ... goes through backup_config` `config.yaml.<reason>.<YYYYMMDD-HHMMSS>` | 快照命名 |
| 13 | `hermes_cli/config_backups.py:22` | `DEFAULT_KEEP = 5` | 保留份数 |
| 14 | `hermes_cli/config_backups.py:6-7` | `A copy identical to the newest one for the same reason is skipped` | 去重 |
| 15 | 实测 `backups/config/` | `config.yaml.good.20261020-131452` … `20261020-131706`（5 份） | 本机实际 |
| 16 | `hermes_cli/config_migrations.py:1-5` | `Table-driven config migration registry` `Each step is _migrate_to_N(results, quiet)` | 迁移形状 |
| 17 | `hermes_cli/config_migrations.py:20-23` | `Configs whose on-disk _config_version is below this are NOT auto-migrated (v12 predates ~two years of releases)` | 版本地板 |
| 18 | `hermes_cli/config_migrations.py:23-24` | `Below-floor configs are left byte-for-byte untouched` | 不动旧配置 |
| 19 | `hermes_cli/update_downgrade_guard.py:1-6` | `Refuse an update whose target predates the gateway runtime while a state.db already depends on it` | 拒绝降级 |
| 20 | `hermes_cli/update_downgrade_guard.py:9-10` | `Read-only throughout; a store or target it cannot read is never a reason to refuse` | 读不了不拦 |
| 21 | `hermes_cli/update_contract.py:1-5` | `Image-managed install refusal contract` `records a refused receipt ... and exits 2` | 不可自更新也要留痕 |
| 22 | `hermes_cli/update_contract.py:22-24` | `This build doesn't get updates. Ask the developer who gave it to you for a new build.` | commit-build 语义 |
| 23 | `hermes_cli/update_cmd_zip.py:25-29` | `.hermes-update-staging` / `.hermes-update-old` / `.hermes-update-zip-swap.lock` / `.update-incomplete` | ZIP 安装的原子替换产物 |
| 24 | 实测根目录 | `.hermes-update-in-progress.lock`（0 B）、`.install_id.lock`（1 B）、`install_id`（32 hex） | 锁与安装标识 |
| 25 | 实测 `gateway.lock` / `gateway.pid` | 205 B / 205 B | gateway 单例 |
| 26 | `state.db` 表 `schema_version` | `version=32` | schema 版本独立于 config 版本 |
| 27 | `config.yaml:6-7` | `Schema version of this file. The installers copy it to seed config.yaml` | config 版本 |
| 28 | `config.yaml:766-788` | `Auto-pruning is OFF by default ... VACUUM reclaims disk space only when ... more than 25% of the file's pages are reclaimable` | 会话留存策略 |

## ③ 契约

**数据目录布局（可迁移性评估）**

| 类别 | 路径 | 可搬 | 说明 |
|---|---|---|---|
| 配置 | `<home>/config.yaml` | ✅ | 纯文本 + `_config_version` |
| 密钥 | `<home>/.env`、`<home>/auth.json` | ✅（但需重授权） | **本次未读，`<REDACTED>`** |
| 会话库 | `<home>/state.db`（+ `-wal`/`-shm`） | ⚠️ | SQLite，须整组拷或先 checkpoint；`schema_version=32` |
| 任务库 | `<home>/kanban.db` | ⚠️ | 同上，另有 `.dispatch.lock`/`.init.lock` |
| 定时 | `<home>/cron/executions.db` | ⚠️ | 含 `pid`/`process_started_at`，跨机搬会留下死执行记录 |
| 记忆 | `<home>/memories/MEMORY.md`、`USER.md` | ✅ | 纯文本 |
| 身份 | `<home>/SOUL.md` | ✅ | 纯文本 |
| 技能 | `<home>/skills/**` | ✅ | 纯文本 + 脚本 |
| 备份 | `<home>/backups/config/` | ✅ | 只在写前生成 |
| 缓存 | `models_dev_cache.json`、`cache/`、`image_cache/`、`audio_cache/` | ❌ | 可重建，别搬 |
| 工具二进制 | `<home>/tools/*-win32-x64` | ❌ | 平台相关 |
| 进程态 | `spawn-ledger.json`、`gateway_state.json`、`*.pid`、`locks/`、`*.lock` | ❌ | **搬过去会指向不存在的 PID** |

**升级时对本地改动的处理（事实描述）**

```
1. 抢 update 标记（.hermes-update-in-progress，format v2：pid + 创建时间）+ checkout 锁
2. 写前快照 config.yaml → backups/config/config.yaml.good.<ts>（同 reason 去重，仅留 5 份）
3. git: autostash 本地改动；必要时打 rescue ref refs/hermes-update-backups/<kind>-<branch>-<stamp>-<prior>
4. 拉取目标 commit → 校验（update_cmd_validation）
5. 降级守卫：目标早于 runtime 且 state.db 有 ledger 行 → 拒绝，指出回滚点
6. 跑 config 迁移（表驱动，_config_version 逐级升；低于 v12 完全不动）
7. 跑 post_update（装依赖 / 迁移 skills / 重建前端）
8. 释放锁；写 receipt（成功/失败/refused 都写，fleet 可见）
```

**版本号算法**：`baseVersion + "+" + distance + ".g" + 短 commit [+ ".dirty"]` → `0.22.2+2364.g0b10b9f.dirty`。`distance` 是距最近 tag 的提交数，所以"2364"意味着**这是 main 分支上的一个很新的开发态构建**，不是 release tag。

## ④ 对 DSH 的适配

| 项 | 内容 |
|---|---|
| DSH 现状 | **半有**。DSH 是本地安装，但缺：①可被安装器编排的阶段协议；②更新互斥标记；③配置迁移的版本门；④降级守卫。 |
| 缺口 | ①改引擎要 build + 重启，没有"更新中"标记 → 用户在 build 到一半时启动第二个实例会拿到半成品；②配置结构一改，旧 `config.json` 只能靠"读时默认值合并"，没有逐级迁移；③用户手改的配置在升级时被覆盖（无快照）。 |
| 落点 | 引擎：`packages/engine/src/config/migrate.ts`（表驱动 + 地板版本）；外壳/安装器：`update-marker.ts`（pid + 创建时间）+ `update.lock`。 |
| 成本 | **S–M**。marker + lock S（~80 行），config 迁移 M（每加一个键写一步）。 |
| 失败模式 | ⚠️ **用"标记文件的 mtime"判断更新是否在进行** → 崩溃后留下永久标记，用户永远起不来；Hermes 用 `pid + 进程创建时间`（时间戳会被文件系统精度骗）。⚠️ **只加锁不加标记** → 第二个进程能启动，读到半写的 `config.yaml`/半编译的 `dist`。⚠️ **迁移里"顺手规范化用户配置"** → 会改掉用户手写的注释和缩进；Hermes 的迁移**只写与 schema 默认值不同的键**。⚠️ **降级不拦** → 旧代码读到新 schema 的表，最坏是静默丢数据。 |

## ⑤ 实证 / 推断分界

| 判定 | 条 | 依据 / 如何验证 |
|---|---|---|
| 【实证】 | `install.ps1` 的 `-Manifest`/`-Stage` 阶段协议、`.hermes-update-in-progress`(pid+创建时间)、`hermes-update.lock`、`config.yaml.good.<ts>` keep=5、表驱动 config 迁移、地板 v12、拒绝降级 | `install.ps1`、`update_lock.py`、`config_backups.py`、`config_migrations.py` 原文 |
| 【实证】 | 用 mtime 判“更新中”会留永久标记 | 注释明确提到这个坑，故改为 pid + 创建时间 |
| 【推断】 | 两实例同时启动只有一个拿到锁 | 由锁文件语义推断，未实测竞态。**验证**：并发起 10 个进程同时初始化，统计成功数 |
| 【推断】 | 阶段协议在非 PowerShell 环境可等价实现 | DSH 是 Node/Electron，需重写而非移植。**验证**：先实现 lock + marker 两个最小件，跑 UPD-01 的两个用例 |
| 【实证】 | 迁移阶梯共 **31 步**、地板 v12、当前 v51、版本号只捕获一次不推进 | `config_migrations.py` 的 `MIGRATIONS` 元组（ast 求值）与 `:874-884`；见 `08-附录/A11` |
| 【实证】 | 失败的步**仍然盖章**到 latest，故永久不再执行 | `config_migrations.py:886-898` + `config.py:1354-1357`；代码注释自承 the skipped step vanishes for good |
| 【实证】 | 版本号跨分支撞过号，才需要 `STAMP_INDEPENDENT_STEPS={46,50}` | `config_migrations.py:863-871` 注释 |
| 【推断】 | 真实失败率 | 失败**形态**已全量读出（F1-F4），失败**率**需要旧配置样本才能算；DSH 是全新项目无历史，实际不影响。见 A11 ④ |

## ⑥ 补：迁移阶梯的代码层结构（上一版只有流程，没有阶梯本身）

上一版写了"表驱动 + 地板 v12"，但没展开**表里有什么**。补上：

| 项 | 值 | 位置 |
|---|---|---|
| 注册步数 | 31（v44 两步） | `MIGRATIONS`，`:705-850` |
| 版本跨度 | v12 → v51（当前 `_config_version: 51`） | `config.yaml:10` |
| 门规则 | `current_ver` 开始前捕获一次，每步都判同一个值 | `:874-884` |
| 每步隔离 | 单步异常只记 warning，阶梯继续 | `:886-898` |
| 无版本号 | 只跑 `LEGACY_KEY_STEPS`（13 步） | `:861` |
| 无条件重跑 | `STAMP_INDEPENDENT_STEPS = {46, 50}` | `:871` |

**31 步的类型分布**：旧默认改写 11、删除/清理 10、语义/外部文件改写 4、补白名单/播种 3、搬移 2、结构重写 1。
也就是说**68% 的迁移不是"加功能"，是"收旧债"**——删掉没人读的键、翻转被写进盘的旧默认、修键名歧义。

**最有价值的一条不是任何单步，是那条不变量**：

> 迁移只持久化「与 schema 默认不同」的值（`config.py:1258-1267`）

只要默认值被播种到磁盘，"用户选的"和"模板抄的"就永久分不开，之后每次改默认值都只能写"猜测型迁移"。v30 就踩了这个坑（把 `verify_on_stop: true` 写进盘），逼出 v32 的一次性翻转。

完整的 31 步表格、四条不变量、四种失败形态（F1 静默跳过仍盖章 / F2 跨分支撞号 / F3 模板值当用户选择 / F4 键写了没人读）见 **`08-附录/A11-迁移阶梯全量.md`**；机器可读版 `03-契约/migration-ladder.json`；参考实现 `04-参考实现/migrate-ladder.mjs`（10 项自测，含 F1 复现与 safe 模式对照）。
