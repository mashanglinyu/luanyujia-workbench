# 证据 E15 — 自我验证 / 证据台账 / 停止闸门

`0.22.2 / agent\{verification_evidence,verification_stop,turn_stop_gates,coding_context,verify_hooks,turn_explainers,client_lifecycle}.py、agent\verify\recipes.py、hermes_cli\verify_cmd.py、tools\{terminal_tool_result,file_tools_read_tracking}.py`

复现命令（在 `<旧位置>\Hermes\hermes-agent` 下）：

```bash
sed -n '1,60p' agent/verification_evidence.py
sed -n '93,115p;122,136p;213,235p' agent/verification_evidence.py
sed -n '368,403p;424,470p;529,600p;586,628p' agent/verification_evidence.py
sed -n '1,40p;53,80p;160,230p' agent/verification_stop.py
sed -n '1,20p;95,180p;188,220p' agent/turn_stop_gates.py
sed -n '40,60p;480,512p' agent/coding_context.py
sed -n '14,42p' agent/verify_hooks.py
sed -n '1,15p' agent/verify/recipes.py
sed -n '80,115p' hermes_cli/verify_cmd.py
sed -n '405,432p' tools/file_tools_read_tracking.py
sed -n '190,205p' tools/terminal_tool_result.py
sed -n '128,140p' agent/client_lifecycle.py
grep -n "verify_on_stop" ../config.yaml
```

| # | 路径:行 | 原文（≤40 字） | 说明 |
|---|---|---|---|
| E15-01 | agent/verification_evidence.py:1-2 | `Coding verification evidence ledger: records what the agent actually proved` | 台账定位：只管「证明过的」 |
| E15-02 | agent/verification_evidence.py:2-3 | `Deliberately passive — it never runs a suite, never blocks completion` | 三条边界之一二 |
| E15-03 | agent/verification_evidence.py:3 | `never upgrades targeted checks into "repo green"` | 边界之三：不许升级 |
| E15-04 | agent/verification_evidence.py:22 | `_MAX_OUTPUT_SUMMARY_CHARS = 2000` | 输出摘要上限 |
| E15-05 | agent/verification_evidence.py:23 | `_MAX_EVIDENCE_AGE_DAYS = 30` | 证据 30 天过期 |
| E15-06 | agent/verification_evidence.py:24 | `_MAX_EVENTS_PER_SESSION_ROOT = 100` | 单会话单根上限 |
| E15-07 | agent/verification_evidence.py:25 | `_MAX_TOTAL_UNREFERENCED_EVENTS = 10_000` | 全局兜底上限 |
| E15-08 | agent/verification_evidence.py:26 | `_AD_HOC_SCRIPT_NAME_PREFIXES = ("hermes-verify-", "hermes-ad-hoc-")` | ad-hoc 靠前缀识别 |
| E15-09 | agent/verification_evidence.py:27 | `_VERIFY_SCHEMA_VERSION = 1` | schema 版本 |
| E15-10 | agent/verification_evidence.py:29 | `_INTERPRETERS = {"python", "python3", "py", "node", "bash", ...}` | 解释器白名单 |
| E15-11 | agent/verification_evidence.py:39 | `_TARGET_EXTENSIONS = (".py", ".js", ".jsx", ".ts", ".tsx", ".rs", ".go", ".java")` | 源码后缀 |
| E15-12 | agent/verification_evidence.py:40 | `_TARGET_PREFIXES = ("test_", "tests", "spec", "__tests__")` | 测试文件前缀 |
| E15-13 | agent/verification_evidence.py:43-47 | `(("lint","eslint","ruff"),"lint"), (("typecheck","tsc","mypy","pyright","ty"),"typecheck")` | kind 归类，顺序敏感 |
| E15-14 | agent/verification_evidence.py:48-51 | `_PYTEST_SPELLINGS = (["python","-m","pytest"], ["uv","run","pytest"], ...)` | pytest 的五种拼法 |
| E15-15 | agent/verification_evidence.py:53-75 | `CREATE TABLE IF NOT EXISTS meta` / `verification_events` / `verification_state` | 三表 DDL |
| E15-16 | agent/verification_evidence.py:65 | `scope TEXT NOT NULL` | scope 落库，不只在内存 |
| E15-17 | agent/verification_evidence.py:99 | `class VerificationEvidence:` | 冻结 dataclass |
| E15-18 | agent/verification_evidence.py:123-124 | `when that guard is off nothing may record, read, or even create the database` | 闸门关 = 连库都不建 |
| E15-19 | agent/verification_evidence.py:124 | `an unconsumed ledger is pure disk churn` | 理由：没人读的台账是磁盘噪音 |
| E15-20 | agent/verification_evidence.py:214-215 | `Whether the shell's status proves the matched segment's own status` | 归因函数的命题 |
| E15-21 | agent/verification_evidence.py:216-218 | `Only the last ;-separated sequence reports its status` | 规则一 |
| E15-22 | agent/verification_evidence.py:217 | `backgrounding, pipes and || hide it` | 规则二 |
| E15-23 | agent/verification_evidence.py:218 | `an && chain proves each member only on success` | 规则三（非对称） |
| E15-24 | agent/verification_evidence.py:220 | `any(s.following_operator == "&" for s in segments)` → `return False` | 有后台即整条不作证 |
| E15-25 | agent/verification_evidence.py:229-231 | `operators & {"|", "|&", "||"}` → `return False` | 管道/或一律拒 |
| E15-26 | agent/verification_evidence.py:232 | `return not operators or (int(exit_code) == 0 and operators == {"&&"})` | 收尾判定 |
| E15-27 | agent/verification_evidence.py:238-240 | `[re.sub(r"^(?:\./)+", "", t.strip()) for t in shlex.split(canonical) if t]` | canonical 规范化 |
| E15-28 | agent/verification_evidence.py:242-250 | `Remove harmless command prefixes (env, VAR=x, command/time/noglob)` | 前缀剥离 |
| E15-29 | agent/verification_evidence.py:285-288 | `any(m in arg for m in ("/", "\\", "::")) or arg.endswith(_TARGET_EXTENSIONS)` | 什么叫「带目标」 |
| E15-30 | agent/verification_evidence.py:424-431 | `Ad-hoc temp scripts only count when the project has no canonical verify commands at all` | ad-hoc 准入 |
| E15-31 | agent/verification_evidence.py:431 | `so they never shadow a real suite` | 目的：不许遮蔽 |
| E15-32 | agent/verification_evidence.py:443 | `scope = "targeted" if any(map(_looks_like_target, trailing_args)) else "full"` | scope 唯一来源 |
| E15-33 | agent/verification_evidence.py:447 | `canonical, kind, scope = "ad-hoc verification script", "ad_hoc", "targeted"` | ad-hoc 三重限定 |
| E15-34 | agent/verification_evidence.py:369-371 | `Order matters: per-(session, root) cap, expire stale state rows, then expire old events` | 清理顺序 load-bearing |
| E15-35 | agent/verification_evidence.py:375-380 | `DELETE FROM verification_events WHERE ... ORDER BY id DESC LIMIT ?` | 每 (会话,根) 只留最近 100 |
| E15-36 | agent/verification_evidence.py:369 | `Bound ledger growth without deleting the current state pointer` | docstring 的承诺 |
| E15-37 | agent/verification_evidence.py:392-400 | `DELETE FROM verification_events WHERE created_at < ? AND id NOT IN (SELECT last_event_id ...)` | 过期清理排除指针 |
| E15-38 | agent/verification_evidence.py:530 | `Mark verification evidence stale after a successful file edit.` | 编辑即作废 |
| E15-39 | agent/verification_evidence.py:551 | `merged = sorted(set(existing) | set(changed_paths))[-200:]` | 变更路径只留 200 |
| E15-40 | agent/verification_evidence.py:571-574 | `SELECT * FROM verification_events WHERE root = ? AND kind = 'verify' AND status = 'passed' AND scope = 'full'` | 跨会话只看 full verify |
| E15-41 | agent/verification_evidence.py:588-590 | `Evidence recorded before the latest edit is reported as stale` | stale 定义 |
| E15-42 | agent/verification_evidence.py:590-591 | `satisfies the guard even if another session recorded it` | 跨会话复用 |
| E15-43 | agent/verification_evidence.py:615 | `stale = bool(event is not None and last_edit_at and last_edit_at > event["created_at"])` | 严格大于 → 精度陷阱 |
| E15-44 | agent/verification_evidence.py:628 | `return {"status": "stale" if stale else evidence["status"], ...}` | 六态出口 |
| E15-45 | agent/verification_stop.py:1-2 | `Policy-only: it never runs checks itself` | 闸门不做执行 |
| E15-46 | agent/verification_stop.py:2-3 | `turns the passive verification ledger into a bounded follow-up` | 职责：变成有界追问 |
| E15-47 | agent/verification_stop.py:15 | `_MAX_CHANGED_PATHS_IN_NUDGE = 8` | 追问里列几条路径 |
| E15-48 | agent/verification_stop.py:16 | `_MAX_STATUS_SUMMARY_CHARS = 1200` | 追问里贴多少输出 |
| E15-49 | agent/verification_stop.py:19-20 | `a SKILL.md/README edit must never demand a /tmp verification script` | 为什么要白名单 |
| E15-50 | agent/verification_stop.py:21-23 | `{".md", ".markdown", ".mdx", ".rst", ".txt", ".text", ".adoc", ...}` | 非代码后缀 |
| E15-51 | agent/verification_stop.py:24-26 | `{"license", "licence", "notice", "authors", "contributors", "changelog", "codeowners"}` | 无后缀白名单 |
| E15-52 | agent/verification_stop.py:56-58 | `Precedence: HERMES_VERIFY_ON_STOP env var, then agent.verify_on_stop config` | env 优先 |
| E15-53 | agent/verification_stop.py:58 | `default OFF (opt-in)` | 默认关 |
| E15-54 | agent/verification_stop.py:59-60 | `OFF for messaging surfaces where the verification narrative is chat noise` | 消息面关的理由 |
| E15-55 | agent/verification_stop.py:77-78 | `if token == "auto": return not _session_is_messaging_surface()` | auto 的实现 |
| E15-56 | agent/verification_stop.py:43-44 | `An unreachable gateway package means no messaging channel (verify-on-stop stays on)` | 失败时偏保守（开） |
| E15-57 | agent/verification_stop.py:133-135 | `Fail-silent and cheap — it only decorates the nudge text` | recipe 探测失败不影响判断 |
| E15-58 | agent/verification_stop.py:161-163 | `changed_paths, attempts: int=0, max_attempts: int=2` | 最多催 2 次 |
| E15-59 | agent/verification_stop.py:164 | `Prose-only turns (markdown, skills, README, LICENSE, ...) have nothing to verify` | 文档直接 None |
| E15-60 | agent/verification_stop.py:189-193 | `Run the relevant verification command now` + `verify_commands[:3]` | 最多列 3 条命令 |
| E15-61 | agent/verification_stop.py:197-198 | `prefer hermes verify --json — a passing run records verification evidence` | 推荐全量 |
| E15-62 | agent/verification_stop.py:214-216 | `summarize it explicitly as ad-hoc verification rather than suite green` | 话术禁止升级 |
| E15-63 | agent/verification_stop.py:224-225 | `If verification is not possible, explain the concrete blocker instead of claiming the work is fully verified` | 留诚实的出路 |
| E15-64 | agent/turn_stop_gates.py:1-2 | `Text-response stop gates for the conversation turn loop` | 挂在文本回答那一刻 |
| E15-65 | agent/turn_stop_gates.py:4-8 | `four gates may instead append the answer as an interim row plus a user-role nudge` | 四道闸 + 共同机制 |
| E15-66 | agent/turn_stop_gates.py:7-8 | `Each keeps the candidate answer as a budget-exhaustion fallback` | 暂存的用途 |
| E15-67 | agent/turn_stop_gates.py:8-9 | `clears final_response so the finalizer can tell this gate from error exits (#61631)` | 为什么清空 |
| E15-68 | agent/turn_stop_gates.py:95 | `_MAX_LSP_TURN_END_NOTES = 3` | LSP 最多补 3 次 |
| E15-69 | agent/turn_stop_gates.py:136 | `Run verify-on-stop → pre_verify hook → kanban stop guard, in that order` | 顺序写进 docstring |
| E15-70 | agent/turn_stop_gates.py:137-138 | `Nudges are user-role rows appended only after the assistant answer row, so role alternation holds` | 保证角色交替 |
| E15-71 | agent/turn_stop_gates.py:145-147 | `Keep the answer only as a budget-exhaustion fallback; clear final_response` | 暂存实现 |
| E15-72 | agent/turn_stop_gates.py:161 | `final_msg["finish_reason"] = "verification_required"` | 可观测结束原因 |
| E15-73 | agent/turn_stop_gates.py:157-158 | `waits briefly for checks still running (agent.lsp.deferred.settle_for_agent)` | LSP 要等检查跑完 |
| E15-74 | agent/turn_stop_gates.py:165-166 | `A durable row (no scaffolding flag): it is never stripped` | LSP 行是持久的 |
| E15-75 | agent/turn_stop_gates.py:188 | `_verify_nudge2 = _pre_verify_nudge(agent, final_response, _attempt)` | 第三道闸 |
| E15-76 | agent/turn_stop_gates.py:202 | `final_msg["finish_reason"] = "kanban_terminal_required"` | 第四道闸 |
| E15-77 | agent/turn_stop_gates.py:211-213 | `⚠️ Kanban worker tried to exit without a terminal board call` | 唯一 info 级日志 |
| E15-78 | agent/turn_stop_gates.py:62 | `has_hook("pre_verify") and attempt < max_verify_nudges()` | 钩子是可选档 |
| E15-79 | agent/coding_context.py:57 | `_VERIFY_TARGETS = ("test","tests","lint","typecheck","check","build","fmt","format")` | 哪些脚本名算验证 |
| E15-80 | agent/coding_context.py:58 | `_MAX_VERIFY_COMMANDS = 8` | 命令最多 8 条 |
| E15-81 | agent/coding_context.py:484 | `Detect manifests, package manager(s), verify commands, context files (single source of truth)` | 单一事实源 |
| E15-82 | agent/coding_context.py:487-488 | `if (root / "scripts" / "run_tests.sh").is_file(): verify.append("scripts/run_tests.sh")` | 探测优先级 1 |
| E15-83 | agent/coding_context.py:494 | `js_pm = next((pm for lock, pm in _JS_LOCKFILES if (root / lock).is_file()), "npm")` | 按锁文件推包管理器 |
| E15-84 | agent/coding_context.py:496-497 | `if (root / "pytest.ini").is_file() or "[tool.pytest" in ...` | pytest 探测 |
| E15-85 | agent/coding_context.py:499-502 | `verify.extend(f"make {name}" for name in _VERIFY_TARGETS if ...)` | Makefile 目标 |
| E15-86 | agent/coding_context.py:508 | `verify_commands=list(dict.fromkeys(verify))[:_MAX_VERIFY_COMMANDS]` | 保序去重 + 截断 |
| E15-87 | agent/verify_hooks.py:16 | `DEFAULT_MAX_VERIFY_NUDGES = 3` | 钩子上限 |
| E15-88 | agent/verify_hooks.py:20-26 | `[Coding] Before you run tests/linters or call this done: if this is creative UI/visual work, hold off` | 可选引导 |
| E15-89 | agent/verify_hooks.py:39 | `if not is_truthy_value(...get("verify_guidance", True), default=True)` | 引导可关 |
| E15-90 | agent/verify/recipes.py:3-5 | `Ported nearly 1:1 from superagent-ai/grok-cli src/verify/recipes.ts` | 来源可溯 |
| E15-91 | agent/verify/recipes.py:7-9 | `the deep runtime recipe (framework, bootstrap/build/test, start command, port, readiness path)` | recipe 字段清单 |
| E15-92 | agent/verify/recipes.py:8-9 | `the CLI merges project-facts verify commands the recipe missed` | recipe 与 canonical 互补 |
| E15-93 | hermes_cli/verify_cmd.py:83 | `def _record_evidence(root: Path, recipe, result, *, partial: bool)` | hermes verify 落证据 |
| E15-94 | hermes_cli/verify_cmd.py:108 | `def _readiness_status(r) -> str` | 有 readiness 概念 |
| E15-95 | hermes_cli/verify_cmd.py:64 | `def _merge_project_facts_commands(root: Path, recipe) -> None` | 合并 canonical 命令 |
| E15-96 | tools/terminal_tool_result.py:196 | `def _verification_evidence(command, cwd, session_id, returncode, output)` | 终端侧唯一入口 |
| E15-97 | tools/terminal_tool_result.py:199-200 | `record_terminal_result(command=command, cwd=cwd, session_id=session_id, exit_code=returncode, output=output)` | 传参 |
| E15-98 | tools/file_tools_read_tracking.py:414 | `def _mark_verification_stale(task_id, resolved_paths, session_id=None)` | 编辑侧唯一入口 |
| E15-99 | tools/file_tools_read_tracking.py:425 | `mark_workspace_edited(session_id=session_id or task_id, cwd=cwd, paths=paths)` | **键空间隐患：or task_id** |
| E15-100 | tools/file_tools_read_tracking.py:423-424 | `cwd = (next((c for c in parents if project_facts_for(c)), None) or _authoritative_workspace_root(task_id) ...)` | cwd 三级回退 |
| E15-101 | agent/client_lifecycle.py:130-131 | `subagents: subagent-N-xxxx, which differs from session_id` | task_id 与 session_id 不同 |
| E15-102 | agent/delegate_tool_child_run.py:752 | `self.child_task_id = self.subagent_id or f"subagent-{self.task_index}-{...}"` | 子代理 task_id 形状 |
| E15-103 | agent/turn_explainers.py:137-139 | `changed = getattr(self, "_turn_file_mutation_paths", None)` / `changed.update(landed_paths)` | 路径只来自本实例 |
| E15-104 | agent/turn_explainers.py:125-126 | `if tool_name not in _FILE_MUTATING_TOOLS: return` | 只有文件变更工具才记 |
| E15-105 | agent/turn_stop_gates.py:45 | `changed_paths=getattr(agent, "_turn_file_mutation_paths", set())` | 闸门读本实例集合 |
| E15-106 | agent/tool_dispatch_helpers.py:390-391 | `Concrete file paths a successful mutation reports (files_modified / resolved_path)` | 落地路径语义 |
| E15-107 | agent/tool_dispatch_helpers.py:404 | `return landed or ([str(resolved)] if resolved else targets)` | 优先取工具自报的落地路径 |
| E15-108 | agent/turn_context.py:626 | `agent._turn_file_mutation_paths = set()` | 每回合重置 |
| E15-109 | agent/turn_stop_gates.py:44 | `session_id=getattr(agent, "session_id", None)` | **查询侧只用 session_id** |
| E15-110 | config.yaml:1003-1004 | `# verify_on_stop: false` | 默认关，注释态 |
| E15-111 | config.yaml:1005-1008 | `on for interactive coding surfaces (CLI, TUI, desktop) and programmatic callers, off on conversational messaging surfaces` | auto 模式说明 |
| E15-112 | config.yaml:1009 | `The HERMES_VERIFY_ON_STOP env var (1/0) takes precedence.` | env 优先，与 12/13 面的记录一致 |
| E15-113 | tui_gateway/methods_session.py:603-604 | `{"verification": verification_status(...)}` | 前端可查状态 |
| E15-114 | tui_gateway/contracts/config_free_tier_control.py:776 | `verification_status(): disabled / not_applicable / unverified / stale or the` | 六态在契约里登记 |
