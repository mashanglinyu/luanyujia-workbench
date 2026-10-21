# 证据 E13 — 安装 / 数据目录 / 迁移

`0.22.2 / install.ps1, hermes_cli\update_*.py, config_migrations.py, backups\config\`

| # | 路径:行 | 原文（≤40 字） | 说明 |
|---|---|---|---|
| E13-01 | install.ps1:1 | `Hermes Agent bootstrap: git checkout + venv + hermes command on PATH.` | 安装职责 |
| E13-02 | install.ps1:4 | `-Manifest             print the stage list as JSON` | 阶段协议 |
| E13-03 | install.ps1:5 | `-Stage NAME [-Json]   run one stage` | 可编排 |
| E13-04 | install.ps1:29 | `[string]$HermesHome = ...` `$env:LOCALAPPDATA\hermes` | 目录推导 |
| E13-05 | install.ps1:20 | `-Channel stable|main` | 渠道 |
| E13-06 | install.ps1:1135 | `refs/hermes-update-backups/$rescueKind-$Branch-$stamp-$prior` | git 救援 ref |
| E13-07 | hermes-agent/install-stamp.json:9 | `"updateMechanism": "self"` | 自更新 |
| E13-08 | hermes-agent/install-stamp.json:7 | `"dirty": true` | 本地有改动 |
| E13-09 | hermes-agent/install-stamp.json:12 | `"displayVersion": "0.22.2+2364.g0b10b9f.dirty"` | 版本算法 |
| E13-10 | hermes_cli/update_lock.py:3 | `The update marker <root hermes home>/.hermes-update-in-progress (contract C1, format v2)` | 标记契约 |
| E13-11 | hermes_cli/update_lock.py:7 | `ct:<owner creation time, 3 decimals>` | 用创建时间不用 mtime |
| E13-12 | hermes_cli/update_lock.py:15 | `An owner is live while its pid is alive and its creation time still matches: never by age` | 存活判据 |
| E13-13 | hermes_cli/update_lock.py:18 | `a kernel lock (flock / msvcrt)` | checkout 锁 |
| E13-14 | hermes_cli/config_backups.py:22 | `DEFAULT_KEEP = 5` | 快照保留 |
| E13-15 | hermes_cli/config_backups.py:5 | `config.yaml.<reason>.<YYYYMMDD-HHMMSS>` | 命名 |
| E13-16 | backups/config/ 实测 | `config.yaml.good.20261020-131452` … `131706` | 5 份实际存在 |
| E13-17 | hermes_cli/config_migrations.py:1 | `Table-driven config migration registry.` | 迁移形状 |
| E13-18 | hermes_cli/config_migrations.py:22 | `v12 predates ~two years of releases` | 版本地板 |
| E13-19 | hermes_cli/config_migrations.py:24 | `Below-floor configs are left byte-for-byte untouched` | 不动旧配置 |
| E13-20 | hermes_cli/update_downgrade_guard.py:2 | `Refuse an update whose target predates the gateway runtime` | 拒降级 |
| E13-21 | hermes_cli/update_contract.py:4 | `records a "refused" receipt ... and exits 2` | 不可更新也留痕 |
| E13-22 | state.db / schema_version | `version = 32` | schema 独立版本 |
| E13-23 | config.yaml:6 | `Schema version of this file.` | config 独立版本 |
| E13-24 | hermes_cli/config_migrations.py:705-850 | `MIGRATIONS: tuple[tuple[int, Callable...` | 31 步注册表（ast 求值：12…51，v44 两步） |
| E13-25 | hermes_cli/config_migrations.py:24 | `SUPPORT_FLOOR_VERSION = 12` | 地板 |
| E13-26 | hermes_cli/config_migrations.py:880-884 | `current_ver is ... captured ONCE before any step runs and does not advance` | 单值门：v12 会连跑全部步 |
| E13-27 | hermes_cli/config_migrations.py:888-896 | `A malformed nested value in one step must not abort the rest of the ladder` | 每步隔离（代价见下条） |
| E13-28 | hermes_cli/config_migrations.py:893-895 | `the skipped step vanishes for good` | 失败步永久丢失（自承） |
| E13-29 | hermes_cli/config.py:1354-1357 | `config["_config_version"] = latest_ver` | 有失败也盖章 → F1 成立 |
| E13-30 | hermes_cli/config_migrations.py:861 | `LEGACY_KEY_STEPS = frozenset({12, 14, 16, 17, 29, 33, 38, 39, 42, 43, 46, 50, 51})` | 无版本号只跑这些 |
| E13-31 | hermes_cli/config_migrations.py:871 | `STAMP_INDEPENDENT_STEPS = frozenset({46, 50})` | 版本号过了也照跑 |
| E13-32 | hermes_cli/config_migrations.py:863-867 | `unreleased builds ... put their retired-cron-key step at 44, 45, 46, 47 and 50` | 跨分支撞号实证 |
| E13-33 | hermes_cli/config_migrations.py:103-106 | `match=lambda cur: cur == old` | 旧默认改写只看值相等 |
| E13-34 | hermes_cli/config.py:1259-1263 | `a migration may only persist values that DIFFER from the schema default` | 迁移写入不变量 I1 |
| E13-35 | hermes_cli/config_migrations.py:822-824 | `reads as a user choice and keeps capping 1M-window models at 256K` | 默认值落盘的代价（F3） |
| E13-36 | hermes_cli/config_migrations.py:609-611 | `a key no runtime reader consults, so the server kept running` | 写了没人读（F4） |
| E13-37 | hermes_cli/config.py:1403-1405 | `resolve_toolset() returns [] for an unknown name, silently disabling` | 未知名字解析成空 → 静默全关 |
| E13-38 | hermes_cli/config_migrations.py:538-540 | `the frozen SOUL copy taxed every other session (~600 tok)` | 冻结活数据双输（v41） |

复核：`cat hermes-agent/install-stamp.json; ls backups/config | tail -5`
阶梯复核：`python -c "import ast,io;t=ast.parse(io.open('hermes_cli/config_migrations.py',encoding='utf-8').read());print(len([n for n in t.body if getattr(getattr(n,'target',None),'id','')=='MIGRATIONS'][0].value.elts))"` → 31
