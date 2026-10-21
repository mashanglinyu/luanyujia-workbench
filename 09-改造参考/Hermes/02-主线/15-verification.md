# 15 自我验证与证据台账

`0.22.2+2364.g0b10b9f / <旧位置>\Hermes / agent\verification_evidence.py(628 行)、verification_stop.py(230)、turn_stop_gates.py(220)、coding_context.py(592)、verify_hooks.py、verify/recipes.py(296)、hermes_cli/verify_cmd.py`

> 本面是第 15 面，补的是全部 14 面都没碰的一块：**Agent 说「我做完了」，谁信？**
> 01 面写了主循环怎么转、06 面写了子代理怎么分工、14 面写了失败之后怎么退——但**成功**这件事本身，
> 前 14 面一次都没定义过。Hermes 用一套「被动台账 + 四道停止闸门」把「做完」变成了**可查的证据**，
> 而不是一句自我声明。

---

## ① 结论

1. **「完成」不是一个状态，是一条证据链。** Hermes 不判断「模型说完成了算不算完成」，它只维护一张
   `verification_events` 表：每次可能构成验证的命令执行，都被归类、记下 `kind`（test/lint/typecheck/build/format/verify/ad_hoc）、
   `scope`（targeted/full）、`status`（passed/failed）、`exit_code` 和输出摘要。回合要结束时，看的是**表里有没有一条不早于最近一次编辑的 passed 记录**，而不是看模型怎么说。

2. **台账是被动的，闸门只出策略，两者都不跑检查。** 两段 docstring 把边界钉死了：
   `Deliberately passive — it never runs a suite, never blocks completion, and never upgrades targeted checks into "repo green"`（`verification_evidence.py:2-3`）、
   `Policy-only: it never runs checks itself`（`verification_stop.py:1`）。所以这套机制**不会**因为「觉得该测一下」就自己起测试进程——它只把「你还没证明」这件事变成一个**有界的追问**，跑不跑仍然是模型的工具调用。

3. **整层的地基是「退出码可归因」，不是「命令跑过了」。** 这是最容易抄漏、也最容易让台账开始撒谎的一处。
   shell 的退出码只属于**最后一条管道/最后一段**：`npm test | tee out.log` 的退出码是 `tee` 的（测试挂了也报 0），
   `npm test || true` 被抹成 0，`npm test &` 立即返回 0 而测试还在跑，`cd x && npm test` 只在成功时才能证明两个成员都成功。
   Hermes 用一个专门的判定函数把这三类写法全部拒掉（`_exit_status_is_attributable`，`verification_evidence.py:213`）——**没有这一步，整套台账记录的是一堆「进程启动成功」，而不是「检查通过」**。

4. **targeted ≠ full，且 ad-hoc 脚本永远不能冒充套件。** scope 由「命令后面有没有带具体目标」决定：
   `pytest tests/test_a.py` 是 `targeted`，`pytest` 是 `full`（`verification_evidence.py:443`）。这条位次决定它能不能证明「整仓绿了」。
   更狠的是 ad-hoc：临时脚本**只在项目完全没有 canonical 命令时才算数**，且 kind 强制为 `ad_hoc`、scope 强制为 `targeted`，
   命名字面写死 `ad-hoc verification script`，追问文案还要求模型「明确说这是 ad-hoc 验证，而不是套件通过」。
   三重限制的理由只有一条：**不许把「我试了一下那个函数」升级成「测试全过」**。

5. **编辑即作废，但同 root 更新的 full verify 可以跨会话复用。** `mark_workspace_edited` 一被调用，之前所有证据变 `stale`——
   这是「改完就跑」骗不过去的唯一原因（改了代码就得重跑）。反过来，如果另一个会话在**这次编辑之后**跑过同 root 的 full `hermes verify`，
   本会话也算通过：证据衡量的是**工作区状态**，不是会话归属。

6. **默认关，且「关」要关到底：闸门关掉时台账连数据库都不建。** `_ledger_enabled()` 直接返回闸门开关
   （`verification_evidence.py:122-124`），注释写的是 `an unconsumed ledger is pure disk churn`——没人读的台账只是磁盘噪音。
   默认值在 config 里是注释掉的 `# verify_on_stop: false`（`config.yaml:1004`）；`"auto"` 模式按 surface 分：
   交互式编码面（CLI/TUI/desktop）开，**消息面（Telegram/Discord）关**——在聊天窗口里报告「我跑了 3 个测试都过了」是噪声。

7. **闸门不否决回答，它把回答「暂存」。** 四道闸命中时做的是：把候选回答降级为一条 interim 行、`final_response = None`、
   把原回答放进 `pending_verification_response`、追加一条 user-role nudge、继续回合（`turn_stop_gates.py:141-156`）。
   预算耗尽时原回答还能被放出来。**这才是 `never blocks completion` 的真身**：它不阻止结束，它只是让「结束」等一轮。

---

## ② 证据

| # | 位置 | 原文（截断） | 说明 |
|---|---|---|---|
| 1 | `agent/verification_evidence.py:1-3` | `Deliberately passive — it never runs a suite, never blocks completion, and never upgrades targeted checks into "repo green"` | 三条边界一次说清 |
| 2 | `agent/verification_evidence.py:22` | `_MAX_OUTPUT_SUMMARY_CHARS = 2000` | 输出摘要上限 |
| 3 | `agent/verification_evidence.py:23` | `_MAX_EVIDENCE_AGE_DAYS = 30` | 证据 30 天过期 |
| 4 | `agent/verification_evidence.py:24` | `_MAX_EVENTS_PER_SESSION_ROOT = 100` | 每 (会话, 根) 上限 |
| 5 | `agent/verification_evidence.py:25` | `_MAX_TOTAL_UNREFERENCED_EVENTS = 10_000` | 未被引用的总量上限 |
| 6 | `agent/verification_evidence.py:26` | `_AD_HOC_SCRIPT_NAME_PREFIXES = ("hermes-verify-", "hermes-ad-hoc-")` | ad-hoc 的识别靠前缀 |
| 7 | `agent/verification_evidence.py:43-47` | `(("lint","eslint","ruff"),"lint"), (("typecheck","tsc","mypy","pyright","ty"),"typecheck")` | kind 归类表，顺序敏感 |
| 8 | `agent/verification_evidence.py:52-91` | `CREATE TABLE IF NOT EXISTS verification_events (...)` / `verification_state (...)` | 两表：事件 + 指针 |
| 9 | `agent/verification_evidence.py:65` | `scope TEXT NOT NULL` | scope 落库，不只在内存里 |
| 10 | `agent/verification_evidence.py:123-124` | `when that guard is off nothing may record, read, or even create the database` | 闸门关 = 连库都不建 |
| 11 | `agent/verification_evidence.py:214-218` | `Only the last ``;``-separated sequence reports its status; backgrounding, pipes and ``||`` hide it` | 归因规则原文 |
| 12 | `agent/verification_evidence.py:227-231` | `operators & {"|", "|&", "||"}` → `return False` | 管道/或全部拒 |
| 13 | `agent/verification_evidence.py:232` | `return not operators or (int(exit_code) == 0 and operators == {"&&"})` | `&&` 仅在成功时成立 |
| 14 | `agent/verification_evidence.py:238-240` | `return [re.sub(r"^(?:\./)+", "", t.strip()) for t in shlex.split(canonical) if t]` | canonical 规范化 |
| 15 | `agent/verification_evidence.py:242-250` | `Remove harmless command prefixes (env, VAR=x, command/time/noglob)` | 前缀剥离 |
| 16 | `agent/verification_evidence.py:424-431` | `Ad-hoc temp scripts only count when the project has no canonical verify commands at all, so they never shadow a real suite` | ad-hoc 的准入条件 |
| 17 | `agent/verification_evidence.py:443` | `scope = "targeted" if any(map(_looks_like_target, trailing_args)) else "full"` | targeted 判定唯一来源 |
| 18 | `agent/verification_evidence.py:285-288` | `any(m in arg for m in ("/", "\\", "::")) or arg.endswith(_TARGET_EXTENSIONS)` | 什么叫「带目标」 |
| 19 | `agent/verification_evidence.py:369-371` | `Order matters: per-(session, root) cap, expire stale state rows, then expire old events` | 清理顺序 load-bearing |
| 20 | `agent/verification_evidence.py:375-380` | `DELETE ... id NOT IN (SELECT id ... ORDER BY id DESC LIMIT ?)` | 每 (会话,根) 只留最近 100 |
| 21 | `agent/verification_evidence.py:530` | `Mark verification evidence stale after a successful file edit.` | 编辑即作废 |
| 22 | `agent/verification_evidence.py:551` | `merged = sorted(set(existing) \| set(changed_paths))[-200:]` | 变更路径只留 200 条 |
| 23 | `agent/verification_evidence.py:587-592` | `Evidence recorded before the latest edit is reported as ``stale``.` / `even if another session recorded it` | 跨会话复用语义 |
| 24 | `agent/verification_evidence.py:615` | `stale = bool(event is not None and last_edit_at and last_edit_at > event["created_at"])` | 严格大于 → 精度陷阱 |
| 25 | `agent/verification_stop.py:1-3` | `Policy-only: it never runs checks itself, it turns the passive verification ledger into a bounded follow-up` | 闸门不做执行 |
| 26 | `agent/verification_stop.py:15-16` | `_MAX_CHANGED_PATHS_IN_NUDGE = 8` / `_MAX_STATUS_SUMMARY_CHARS = 1200` | 追问有界 |
| 27 | `agent/verification_stop.py:19-20` | `a SKILL.md/README edit must never demand a /tmp verification script` | 为什么要排除文档 |
| 28 | `agent/verification_stop.py:21-26` | `.md .markdown .mdx .rst .txt .text .adoc .asciidoc .org .log .csv .tsv` + `license/licence/notice/authors/...` | 非代码白名单 |
| 29 | `agent/verification_stop.py:56-60` | `Precedence: HERMES_VERIFY_ON_STOP env var, then agent.verify_on_stop config; default OFF (opt-in)` | 优先级 + 默认关 |
| 30 | `agent/verification_stop.py:77-78` | `if token == "auto": return not _session_is_messaging_surface()` | auto 按面决定 |
| 31 | `agent/verification_stop.py:133-135` | `it only decorates the nudge text` | recipe 探测失败不影响判断 |
| 32 | `agent/verification_stop.py:161-163` | `changed_paths, attempts: int=0, max_attempts: int=2` | 最多催 2 次 |
| 33 | `agent/verification_stop.py:170` | `Prose-only turns (markdown, skills, README, LICENSE, ...) have nothing to verify.` | 文档直接返回 None |
| 34 | `agent/verification_stop.py:214-216` | `summarize it explicitly as ad-hoc verification rather than suite green` | 话术禁止升级 |
| 35 | `agent/verification_stop.py:224-225` | `If verification is not possible, explain the concrete blocker instead of claiming the work is fully verified` | 留一条诚实的出路 |
| 36 | `agent/turn_stop_gates.py:4-8` | `four gates may instead append the answer as an interim row plus a user-role nudge and continue the turn` | 四道闸 + 共同机制 |
| 37 | `agent/turn_stop_gates.py:7-8` | `Each keeps the candidate answer as a budget-exhaustion fallback` | 暂存的用途 |
| 38 | `agent/turn_stop_gates.py:95` | `_MAX_LSP_TURN_END_NOTES = 3` | LSP 判定最多补 3 次 |
| 39 | `agent/turn_stop_gates.py:136` | `Run verify-on-stop → pre_verify hook → kanban stop guard, in that order.` | 顺序写进 docstring |
| 40 | `agent/turn_stop_gates.py:145-147` | `clear final_response so the finalizer can tell this gate from error exits (#61631)` | 为什么要清空 |
| 41 | `agent/turn_stop_gates.py:161` | `final_msg["finish_reason"] = "verification_required"` | 可观测的结束原因 |
| 42 | `agent/turn_stop_gates.py:157-158` | `waits briefly for checks still running` / `settle_for_agent` | LSP 判定要等检查跑完 |
| 43 | `agent/turn_stop_gates.py:188-195` | `_pre_verify` 钩子：`has_hook("pre_verify") and attempt < max_verify_nudges()` | 钩子是可选档 |
| 44 | `agent/coding_context.py:57` | `_VERIFY_TARGETS = ("test","tests","lint","typecheck","check","build","fmt","format")` | 哪些脚本名算验证 |
| 45 | `agent/coding_context.py:58` | `_MAX_VERIFY_COMMANDS = 8` | 命令最多 8 条 |
| 46 | `agent/coding_context.py:486-487` | `if (root / "scripts" / "run_tests.sh").is_file(): verify.append("scripts/run_tests.sh")` | 探测优先级 1 |
| 47 | `agent/coding_context.py:492-496` | `js_pm = next((pm for lock, pm in _JS_LOCKFILES ...), "npm")` | 按锁文件推断包管理器 |
| 48 | `agent/coding_context.py:497-498` | `if (root / "pytest.ini").is_file() or "[tool.pytest" in ...` | pytest 探测 |
| 49 | `agent/coding_context.py:499-502` | `verify.extend(f"make {name}" for name in _VERIFY_TARGETS ...)` | Makefile 目标探测 |
| 50 | `agent/coding_context.py:504-509` | `verify.extend(f"{js_pm} run {name}" ...)` / `list(dict.fromkeys(verify))[:_MAX_VERIFY_COMMANDS]` | 去重 + 截断 |
| 51 | `agent/verify_hooks.py:16` | `DEFAULT_MAX_VERIFY_NUDGES = 3` | pre_verify 钩子上限 |
| 52 | `agent/verify_hooks.py:20-26` | `[Coding] Before you run tests/linters or call this done: if this is creative UI/visual work, hold off ...` | 可选引导文案 |
| 53 | `agent/verify_hooks.py:39` | `if not is_truthy_value(...get("verify_guidance", True), default=True)` | 引导可关 |
| 54 | `agent/verify/recipes.py:3-5` | `Ported nearly 1:1 from superagent-ai/grok-cli src/verify/recipes.ts` | 来源可溯（grok-cli） |
| 55 | `agent/verify/recipes.py:7-9` | `the deep runtime recipe (framework, bootstrap/build/test, start command, port, readiness path)` | recipe 的六个字段 |
| 56 | `hermes_cli/verify_cmd.py:83` | `def _record_evidence(root: Path, recipe, result, *, partial: bool)` | `hermes verify` 落证据 |
| 57 | `hermes_cli/verify_cmd.py:108` | `def _readiness_status(r) -> str` | 有 readiness 概念 |
| 58 | `config.yaml:1003-1004` | `# verify_on_stop: false` | 默认关，注释里写明三档 |
| 59 | `tools/file_tools_read_tracking.py:425` | `mark_workspace_edited(session_id=session_id or task_id, cwd=cwd, paths=paths)` | 编辑侧唯一入口 |
| 60 | `tools/terminal_tool_result.py:199` | `evidence = record_terminal_result(command=command, cwd=cwd, session_id=...,` | 终端侧唯一入口 |
| 61 | `tui_gateway/methods_session.py:604` | `return _ok(rid, {"verification": verification_status(` | 前端可查状态 |

---

## ③ 契约

### 3.1 状态机（闸门读的是这个，不是模型的话）

| 状态 | 何时出现 | 闸门行为 |
|---|---|---|
| `disabled` | 闸门开关关闭 | 不催、不记、连库都不建 |
| `not_applicable` | 工作区探测不到项目（无 `ProjectFacts`） | 不催 |
| `unverified` | 有 state 但没有任何证据 | **催** |
| `passed` | 最新证据 `status=passed` 且不早于最近编辑 | 放行 |
| `failed` | 最新证据 `status=failed` | **催**（失败本身是证据，不是通过） |
| `stale` | 证据早于最近一次编辑 | **催**（改完必须重跑） |

状态转移只有四条边：

```
（无 state）──edit──▶ unverified ──pass──▶ passed ──edit──▶ stale ──pass──▶ passed
                          │                        │
                          └──────fail──────▶ failed ┘
```

`stale` 的解除有两条路：自己重跑，**或**同 root 有更新的 `kind=verify, scope=full, status=passed` 事件（可来自别的会话）。

### 3.2 四道停止闸（顺序硬性，一次只放一道）

| # | 闸 | 触发条件 | finish_reason | 上限 | 备注 |
|---|---|---|---|---|---|
| 1 | late-LSP verdicts | 本轮编辑的 LSP 检查在工具返回后才出结果（编辑是最后一个工具调用） | `verification_required` | 3 次 | 结果作为**持久行**追加，不带脚手架标记 |
| 2 | verify-on-stop | 改了代码且无新鲜通过证据 | `verification_required` | 2 次 | 默认关；`auto` 按 surface |
| 3 | `pre_verify` 钩子 | 注册了 `pre_verify` 钩子且本轮有编辑 | `verify_hook_continue` | 3 次 | 插件可自定义继续语 |
| 4 | kanban 终态守卫 | kanban worker 未调用 `kanban_complete/request_review/block` 就要退出 | `kanban_terminal_required` | — | 唯一会 `logger.info` 的闸（其他都是 debug） |

共同动作（四道一致）：

```
append_interim_answer(候选回答)        # 回答降级为中间行，用户看得见
final_response = None                  # finalizer 才能区分「闸门拦下」和「错误退出」
pending_verification_response = 候选回答  # 预算耗尽时兜底
append_message({role:"user", content: nudge})  # 合成追问，保证角色交替
continue_turn = True
```

### 3.3 退出码归因真值表（这一格写错，整套台账失效）

| 命令写法 | 匹配段 | 可归因？ | 为什么 |
|---|---|---|---|
| `npm test` | 0 | ✅ | 唯一一段，无条件 |
| `cd app && npm test` | 1 | ✅ 仅 exit=0 | 成功时两个成员都成功；失败时不知是哪段 |
| `cd app && npm test` | 1 | ❌ exit≠0 | 同上 |
| `npm test ; echo done` | 0 | ❌ | 只有最后一个 `;` 序列代表自己 |
| `npm test ; echo done` | 1 | ✅ | 最后一段 |
| `npm test \| tee log` | 0 | ❌ | 退出码属于 `tee` |
| `npm test \| tee log` | 1 | ❌ | 管道整体不可分段归因 |
| `npm test \|& cat` | 0 | ❌ | `\|&` 同 `\|` |
| `npm test \|\| true` | 0 | ❌ | 退出码被抹成 0 |
| `npm test &` | 0 | ❌ | 后台，shell 立即返回 0 |
| `npm test &> out.log` | 0 | ✅ | `&>` 是重定向，不是后台 |

> 反直觉但正确：**`&&` 链在成功时是可信的**。因为「`A && B` 返回 0」逻辑上蕴含「A 返回 0 且 B 返回 0」。
> 而 `;` 链即使成功也不能证明前面的段——`false; true` 返回 0。

### 3.4 三层降级：什么时候允许「不那么正式」的验证

| 层 | 条件 | kind | scope | 话术约束 |
|---|---|---|---|---|
| canonical full | 命令命中 `verifyCommands` 且不带目标参数 | 按关键词归类 | `full` | 可直接说「通过」 |
| canonical targeted | 命中但带目标（`pytest tests/a.py`） | 按关键词归类 | `targeted` | 只能说「那个目标通过」 |
| ad-hoc | 项目**完全无** canonical 命令，且脚本名以 `hermes-verify-`/`hermes-ad-hoc-` 开头 | `ad_hoc` | 强制 `targeted` | 必须明说「ad-hoc verification rather than suite green」 |
| （无） | 有 canonical 命令时用 ad-hoc 脚本 | — | — | **不算证据**，防止遮蔽真实套件 |

### 3.5 常量表

| 常量 | 值 | 位置 | 作用 |
|---|---|---|---|
| `_MAX_OUTPUT_SUMMARY_CHARS` | 2000 | evidence:22 | 尾部保留，中间省略 |
| `_MAX_EVIDENCE_AGE_DAYS` | 30 | evidence:23 | 过期即清 |
| `_MAX_EVENTS_PER_SESSION_ROOT` | 100 | evidence:24 | 单会话单根 |
| `_MAX_TOTAL_UNREFERENCED_EVENTS` | 10000 | evidence:25 | 全局兜底 |
| 变更路径保留 | 200 | evidence:551 | 合并去重后取尾部 |
| `_MAX_CHANGED_PATHS_IN_NUDGE` | 8 | stop:15 | 追问里列几条 |
| `_MAX_STATUS_SUMMARY_CHARS` | 1200 | stop:16 | 追问里贴多少输出 |
| `max_attempts`（verify-on-stop） | 2 | stop:162 | 催几次 |
| `DEFAULT_MAX_VERIFY_NUDGES` | 3 | hooks:16 | pre_verify 钩子 |
| `_MAX_LSP_TURN_END_NOTES` | 3 | gates:95 | LSP 补几次 |
| `_MAX_VERIFY_COMMANDS` | 8 | coding_context:58 | 探测出几条命令 |
| 默认开关 | `false`（注释态） | config.yaml:1004 | opt-in |

### 3.6 `hermes verify` 的 recipe 六要素

```
framework · bootstrap · build · test · start · port · readiness_path
```

`detect_recipe()` 静态探测，`hermes verify --json` 按 `detect → build → test → boot → readiness poll` 执行。
它和 canonical 命令是**互补**关系：`verify_cmd._merge_project_facts_commands` 会把 canonical 命令并进 recipe 漏掉的部分。
这条线对 DSH 的意义不是「抄一个 verify 命令」，而是**「验证」可以包括「真的把服务起起来并探 readiness」**，而不只是跑测试。

---

## ④ 对 DSH 的适配

### DSH 现在有没有等价物

**没有，连雏形都没有。** DSH 现在的「完成」完全由模型自己声明：Agent 说做完了就结束，没有任何外部记录能回答三个问题——
「它到底跑了什么」「那个东西真的过了吗」「是通过还是只跑起来了」。

这不是理论风险，是**当前最贵的自伤**，因为它的形态是「看起来一切都好」：

| 现象 | DSH 现在 | 后果 |
|---|---|---|
| Agent 跑了 `npm test \| head -20` 看到前 20 行没报错 | 采信，报「测试通过」 | 真实结果在 head 之后，且退出码根本不是测试的 |
| Agent 改完 3 个文件，只测了其中 1 个 | 采信，报「全部通过」 | targeted 被当成 full |
| Agent 写了 `/tmp/check.py` 跑一下 | 采信，报「已验证」 | ad-hoc 被当成套件 |
| Agent 说「已修复」但一次都没跑 | 采信 | 无证据 = 无证据，但用户看不出来 |
| 改了 README 就要求跑测试 | —— | DSH 没有闸门，所以也不会犯这个错（但也享受不到好处） |

### 落点：四步，每步都能独立上线

| 步 | 做什么 | 成本 | 带来的改变 |
|---|---|---|---|
| **1** | **退出码归因**：采纳任何「验证类」命令结果前，先过 `exitStatusIsAttributable`。管道/后台/`\|\|` 一律不采信，`&&` 仅在 0 时采信 | **S**（一个纯函数，`04-参考实现/verify-ledger.mjs` 已实现并自测） | 立刻消掉「head/tee 导致的假通过」这一类 |
| **2** | **targeted/full 二分**：`scope` 落到记录里，报告时必须说清是哪一个 | **S** | 「跑了一个测试说全过」从结构上说不出口 |
| **3** | **被动台账**：SQLite 两表（events + state），编辑时 `markEdited` 让旧证据 stale | **M**（约 300 行） | 「改完就跑」骗不过去 |
| **4** | **停止闸门**：回合结束前查状态，未通过则追加一条 nudge（**不否决回答，暂存**），上限 2 次 | **M** | 模型被推着去证明，而不是被推着去撒谎 |

**顺序不能换**：1 是地基。先做 3/4 而不做 1，闸门会读到一堆假证据，然后**更自信地放行**——比没有闸门更糟。

### 三个必须移植的设计判断

1. **闸门只出策略，不跑检查。** 一旦闸门自己起测试进程，就变成第二个执行器：超时、并发、输出膨胀全部要再处理一遍，而且它会和模型的工具调用抢资源。DSH 的闸门应该只做「读状态 → 生成一句话」。
2. **留诚实的出路那半句。** `explain the concrete blocker instead of claiming the work is fully verified`（`verification_stop.py:224-225`）不是客套。闸门如果只堵不疏，模型的最优策略是**编一个通过的结果**——这比不验证更坏。给一条「说清卡在哪也算数」的路，模型的收益曲线才会转向诚实。
3. **纯文档不催。** 这条看着琐碎，实际决定了整个功能生死：如果改一次 `README.md` 就要求跑测试，用户会在第三天关掉它。白名单要够宽（`.md/.txt/.csv/.log` + `LICENSE/CHANGELOG/...`）。

### 明确不要抄的三处

| 不抄 | 原因 |
|---|---|
| `Precedence: env → config` 的三套并存 | Hermes 自己在 12 面/13 面已被记录为「三套相反优先级并存」，这里又新增一套（`HERMES_VERIFY_ON_STOP` > `agent.verify_on_stop`）。DSH 应该只有一处。 |
| 时间戳严格大于判 stale | `last_edit_at > event["created_at"]`（evidence:615）在**同一毫秒内编辑+验证**时判不出 stale。参考实现改成单调递增时间戳，把先后关系变成结构性的。 |
| `_prune_old_events` 第 ① 步 | docstring 写 `never dropping an event still referenced by verification_state.last_event_id`，但第 ① 步 SQL 并没有 `NOT IN last_event_id`。它不出事只因为指针总指向最新一条、必然落在最近 100 条内——**靠巧合成立的不变量不是不变量**。 |

---

## ⑤ 实证 / 推断分界

| 类型 | 内容 | 依据 / 验证方法 |
|---|---|---|
| 【实证】 | 台账三条边界（不跑套件/不阻塞/不升级 targeted） | `verification_evidence.py:2-3` 原文 |
| 【实证】 | 退出码归因的三类拒收规则 | `verification_evidence.py:213-233` 逐分支读到；`04-参考实现/verify-ledger.mjs` 12 条用例复现 |
| 【实证】 | scope 由「带不带目标参数」决定 | `verification_evidence.py:443` 单行 |
| 【实证】 | ad-hoc 三重限制 | `verification_evidence.py:424-431` + `kind/scope` 赋值 + 话术 `stop.py:214` |
| 【实证】 | 四道闸顺序与共同动作 | `turn_stop_gates.py:136-215` 全文 |
| 【实证】 | 默认关、`auto` 按 surface 分 | `config.yaml:1003-1004` + `stop.py:77-78` |
| 【实证】 | 所有常量值 | 逐个 grep 到定义行，见 3.5 |
| 【实证】 | 编辑侧/终端侧各只有一个入口 | `file_tools_read_tracking.py:425`、`terminal_tool_result.py:199`，全局搜索无第三处 |
| 【推断】 | `verification_required` 这个 finish_reason 会流向用户可见层 | 只在 `turn_stop_gates.py:161` 赋值。**验证**：grep 前端/TUI 对 `finish_reason` 的消费点 |
| 【推断】 | recipe 的 `readiness_path` 是 HTTP 探活而非端口探测 | 字段名 + `verify_cmd._readiness_status` 语境。**验证**：读 `agent/verify/environment.py` 的轮询实现 |
| 【未验证】 | 闸门开启后的真实误报率（改代码但确实无需验证的场景有多少） | 需在真实项目上开 `verify_on_stop: true` 采样。红线禁止运行目标程序，未做 |
| 【未验证】 | 跨会话复用在并发写入下的表现 | `_DB_LOCK` 是进程内 `threading.Lock`，多进程（gateway + CLI 同时跑）是否安全未验证。**验证**：读 `sqlite_util.open_db` 的 WAL/超时配置 |

---

## ⑥ 补充：这一面暴露的 Hermes 自身缺陷

| # | 缺陷 | 位置 | 后果 | DSH 怎么避开 |
|---|---|---|---|---|
| V1 | **docstring 比 SQL 严**：声称「绝不删除被引用的事件」，第 ① 步实际不排除 | `evidence.py:369` vs `375-380` | 现在靠「指针总指最新」巧合成立。一旦某处把 `last_event_id` 改成指向旧事件（比如回滚），被引用记录会被删 | 清理时**显式**排除所有 `last_event_id`，别依赖巧合 |
| V2 | **同毫秒编辑+验证判不出 stale** | `evidence.py:615` | `last_edit_at > created_at` 严格大于，同毫秒为 false | 用单调序号或 `>=` + 序号，不要用墙钟比先后 |
| V3 | **`_exit_status_is_attributable` 的 `&&` 语义只在成功时成立** | `evidence.py:232` | 正确，但**容易误解成「`&&` 链不可信」**；抄错方向就会把最常见的 `cd x && npm test` 也拒掉 | 保留这个非对称性，并在注释里写清「成功蕴含」的理由 |
| V4 | **`_MAX_EVENTS_PER_SESSION_ROOT = 100` 对长会话偏小** | `evidence.py:24` | 一个活跃会话跑 100 次测试就滚动，早期证据丢失（`_MAX_EVIDENCE_AGE_DAYS=30` 形同虚设） | 按「天」而不是「条数」封顶，或把上限提到 500+ |
| V5 | **`scope` 只看参数形状，不看语义** | `evidence.py:285-288` | `pytest --rootdir=tests` 的 `=` 被判为非目标 → 误判为 full | 对 `--xxx=` 形式单独判定：`=` 后的值是否像路径 |
| V6 | **ad-hoc 前缀可被伪造** | `evidence.py:26` | 模型可以故意命名 `hermes-verify-fake.py` 来触发 ad-hoc 通道 | 只在**无 canonical** 时开放（Hermes 已做），且 ad-hoc 的 `status` 不应参与 `passed` 放行，只能作为「有尝试」的弱证据 |
| V7 | **跨代理盲区：子代理的编辑不进父会话台账** | `turn_explainers.py:137-139`、`turn_stop_gates.py:45` | 父会话的 `_turn_file_mutation_paths` 只含**本实例**工具调用落地的路径。子代理（`delegate_task`）是独立 agent 实例，它改的代码不进父会话集合 ⇒ 父会话的闸门认为「本轮没改代码」⇒ **直接放行**。一个「自己没动手、只让子代理改」的回合，恰好绕过整套验证闸门 | 台账键要**向上合并**：子代理结束时把它改的路径与证据上交给父会话（或闸门改为查「本回合内工作区是否有任何变更」而非「本实例是否调用过文件工具」） |
| V8 | **键空间不一致：编辑侧 `session_id or task_id`，查询侧只用 `session_id`** | `file_tools_read_tracking.py:425` vs `turn_stop_gates.py:44` | 编辑标记可能写到 `subagent-N-xxxx`（task_id 形状，见 `client_lifecycle.py:130`）这一行，而查询读 `agent.session_id` 那一行。两者不一致时，**同一 agent 内**也会出现「改过但闸门看不见」 | 一个变量、一个来源。写入和读取必须用同一个 identity 函数，不允许任何一侧有 `or` 兜底 |

> **本面最大的价值不是「抄这个功能」，是这八个缺陷本身。** 前六个是「看起来在验证、实际没验证」的形态；
> V7/V8 更严重，是**「改了代码，闸门却不知道」**——它们不会报错，只会安静地放行。
> 这些正是 DSH 最该防的那一类。照抄结构、避开这八点，比从零设计更省。

---

## 附：与其他面的关系

| 面 | 关系 |
|---|---|
| 01 主循环 | 闸门挂在「模型吐出文本回答」那一刻，是本轮循环的出口 |
| 03 上下文压缩 | 追问文案要进上下文；`_MAX_STATUS_SUMMARY_CHARS` 是压缩前置的自觉 |
| 06 子代理 | **子代理的验证不进父会话台账**（见 V7）。`_turn_file_mutation_paths` 只由当前 agent 实例的工具调用填充（`turn_explainers.py:137-139` 的 `changed.update(landed_paths)`），子代理是独立 agent 实例，它改的文件不在父会话的集合里 |
| 10 任务模型 | kanban 终态守卫是第 4 道闸，和任务模型共用状态机 |
| 12 计费 | 验证命令消耗的 token 不在台账里，`hermes verify` 的计费未记录 |
| 14 失败恢复 | 14 面管「失败怎么退」，本面管「成功怎么证明」；两者都不跑检查，都只出策略 |
