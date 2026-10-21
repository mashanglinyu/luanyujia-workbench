# 06 子代理与多智能体

`0.22.2+2364.g0b10b9f / <旧位置>\Hermes / tools\delegate_tool*.py、agent\subagent_lifecycle.py、tools\async_delegation*.py、tools\bot_relay.py`

## ① 结论

1. **spawn 契约是"不可变 dataclass + 显式上限"**：`SubagentLaunchRequest` 定字段、`SubagentHandle` 定身份（含 `depth`/`capability`）、`SubagentResult` 定返回；每项都有字符/字节上限（goal 16K、context 32K、result 32K）。
2. **能不能再派子代理不是参数，是深度推导**：`role = "orchestrator" if 开关开 and child_depth < max_spawn_depth else "leaf"`。默认 `max_spawn_depth=1`（扁平），调用方传的 `role` **被忽略**（旧参数保留兼容）。
3. **后台派发的返回不是"结果"，是"句柄 + 将来变成新 turn"**：`delegate_task(background=true)` 立刻返回，完成时把事件推进 `process_registry.completion_queue`，在**下一轮**开头成为新 turn。
4. **失败语义是"三态"而不是抛异常**：`SubagentResult.terminal_state ∈ {SUCCEEDED, FAILED, INTERRUPTED, CANCELLED}`，失败带 `error_classification` + `error_message`，**永远返回对象**。
5. **子代理返回只做"密钥脱敏"，不做"注入围栏"** —— 这是它的一个明确缺口（见④）。

## ② 证据

| # | 位置 | 原文（截断） | 说明 |
|---|---|---|---|
| 1 | `agent/subagent_lifecycle.py:23-28` | `_MAX_GOAL_CHARS = 16_000` `_MAX_CONTEXT_CHARS = 32_000` `_MAX_RESULT_CHARS = 32_000` `_TERMINAL_RETENTION_SECONDS = 3_600` | 四道闸 |
| 2 | `agent/subagent_lifecycle.py:36-45` | `PENDING/STARTING/RUNNING/SUCCEEDED/FAILED/INTERRUPTED/CANCEL_REQUESTED/CANCELLED/UNKNOWN` | 状态机 |
| 3 | `agent/subagent_lifecycle.py:44-57` | `SubagentLaunchRequest: goal, context, role="leaf", model, provider, allowed_toolsets, blocked_tools, working_directory, parent_session_id, correlation_id, metadata, timeout_seconds` | spawn 参数全集 |
| 4 | `agent/subagent_lifecycle.py:64-78` | `SubagentHandle: contract_version, subagent_id, parent_session_id, correlation_id, ..., role, depth, capability` | 句柄 |
| 5 | `agent/subagent_lifecycle.py:105-121` | `SubagentResult: terminal_state, ready, summary, structured_payload, error_classification, error_message, usage_metadata, tool_execution_summary, result_hash` | 返回形状 |
| 6 | `agent/subagent_lifecycle.py:225` | `role must be 'leaf' or 'orchestrator'.` | 枚举校验 |
| 7 | `tools/delegate_tool.py:233-234` | `child_depth = getattr(parent_agent, "_delegate_depth", 0) + 1` `effective_role = "orchestrator" if ... and child_depth < max_spawn else "leaf"` | 角色由深度定 |
| 8 | `tools/delegate_tool.py:229-231` | `Role is depth-derived ... The 'role' arg is ignored.` | 显式忽略入参 |
| 9 | `tools/delegate_tool_config.py:21` | `MAX_DEPTH = 1  # flat by default` | 默认扁平 |
| 10 | `tools/delegate_tool_config.py:151-153` | `delegation.max_spawn_depth floored at 1 ... Default 1 is flat. Each extra level multiplies API cost.` | 深度成本警告 |
| 11 | `tools/delegate_tool_config.py:93-97` | `delegation.max_concurrent_children > env > 10` `Floor of 1 is the only bound enforced` | 并发默认 10 |
| 12 | `tools/delegate_tool_config.py:139-145` | `Inactivity cap for one child ... Failures should come from what the child does, not a stopwatch` | 默认**无**墙钟超时 |
| 13 | `tools/delegate_tool_config.py:165-166` | `orchestrator_enabled kill switch (default True): False forces every child to leaf` | 一键降平 |
| 14 | `tools/delegate_tool_config.py:175-177` | `_get_inherit_mcp_toolsets()` `keep the parent's MCP toolsets` | 工具子集继承规则 |
| 15 | `tools/delegate_tool.py:241-243` | `child_toolsets, child_disabled_toolsets = _resolve_child_toolsets(...)` | 工具子集裁剪 |
| 16 | `tools/delegate_tool_config.py:182-195` | `Parent's endpoint-trust capability map ... DEFAULT-DENY` | 换端点不继承能力 |
| 17 | `tools/async_delegation.py:1-6` | `results surface as a NEW turn (never mid-turn)` | 后台回投 |
| 18 | `tools/async_delegation.py:94-95` | `_LIVE_STATES = {"running","stalling","finalizing"}` | 活跃态 |
| 19 | `state.db` 表 `async_delegations` | 列 `delegation_id, origin_session, parent_session_id, state, result_json, delivery_state, delivery_attempts, delivered_at, owner_pid, delivery_claim` | 后台台账（落库） |
| 20 | `tools/delegate_tool_results.py:10-12` | `redact_child_result, redact_child_text, redact_child_value, redact_summary` | 只脱敏 |
| 21 | `tools/delegation_redaction.py:1-5` | `Child output is scrubbed before it is shortened or handed to another consumer` | 脱敏时机 |
| 22 | `agent/tool_dispatch_helpers.py:484` | `_UNTRUSTED_TOOL_NAMES = frozenset({"web_extract", "web_search"})` | **不含 delegate_task** |
| 23 | `tools/bot_relay.py:1-6` | `roster.json ... outbox/ ... replies/ ... a waiter spawned at send time watches it` | 跨进程 bot 协作 |
| 24 | `tools/bot_relay.py:44-46` | `TURN_ATTEMPT_TIMEOUT_SECONDS = 600` `TURN_MAX_ATTEMPTS = 2` | 投递重试 |
| 25 | `tools/bot_relay.py:48` | `DEFAULT_ENVELOPE_TTL_SECONDS = 900` | 信封过期 |
| 26 | `hermes-agent/apps/desktop/…` + `bot_relay/roster.json` | `{"agents": []}` | 本机暂无外部 bot |

## ③ 契约

```python
@dataclass(frozen=True)
class Spawn:
    goal: str                 # ≤16_000 chars
    context: str | None       # ≤32_000 chars
    toolsets: list[str] | None   # None = 继承父（MCP 可配置是否继承）
    model/provider: str | None   # 覆盖必须显式，换端点则不继承父的 capability
    background: bool = False
    timeout_seconds: float | None  # 默认 None：不做墙钟杀，只靠心跳停滞

# 返回值有两种，不是一种：
# 同步:  SubagentResult(terminal_state, summary ≤32K, error_classification, usage_metadata)
# 异步:  Handle(subagent_id) → 完成时把事件推进 completion_queue → 下一轮变新 turn
```

**结束清理与会话保留**

| 项 | 值 |
|---|---|
| 终态保留 | 3,600 s（`_TERMINAL_RETENTION_SECONDS`），之后句柄不可查 |
| 子代理会话 | 独立 `sessions` 行，`parent_session_id` 指向父；父死子会话可被 startup orphan 清扫 |
| 历史 | 子代理的 message 只进子 session，**默认不回注父**；父只拿到 `summary` |
| 取消 | `CANCEL_REQUESTED → CANCELLED`，`SubagentCancelResult{accepted, already_terminal, unknown_handle, unsupported}` —— 永远返回对象，不抛 |

**团队/频道（Hermes 的"多 bot"）**
不是 agent 团队，是**文件信箱**：`bot_relay/roster.json` 登记对端 agent（Desktop 通过 `bot_relay.roster.sync` 推送），`outbox/` 投信封，`claimed/` 表示被认领，`replies/` 一回一 JSON；发送方在发信时起一个 waiter 盯 `replies/`，等价于"本地 DM 唤醒"。跨 gateway 的房间走 `hosted_rooms*`（13 张表）。

## ④ 对 DSH 的适配

| 项 | 内容 |
|---|---|
| DSH 现状 | **有**（子代理）。**缺**：①返回内容无注入清洗；②无"派发深度"概念（能无限套娃或完全不能套）；③无后台句柄 + 延迟回投这一档。 |
| 缺口 | ①子代理返回是**模型生成文本**，可能包含"忽略之前的指令"这类内容，直接进父上下文等于把注入面从"网页"扩大到"自己的子代理"；②无限嵌套会指数烧钱；③长任务只能阻塞等。 |
| 落点 | 引擎：`packages/engine/src/subagent/lifecycle.ts`（状态机 + 上限常量）+ `delegation/redact.ts` + `delegation/fence.ts`；引擎：`task/queue.ts` 复用给后台回投。 |
| 成本 | **M**（状态机 S，后台回投要接 DSH 的"下一条消息"入口 M）。 |
| 失败模式 | ⚠️ **照抄 Hermes 的 `role` 参数** → 它是被忽略的遗留参数，照抄会以为能控制嵌套，实际由 `max_spawn_depth` 决定。⚠️ **给子代理加墙钟超时** → Hermes 明确不加（`delegate_tool_config.py:139-145`），因为慢模型的合法长任务会被腰斩；要用"无进展"而非"总时长"。⚠️ **只抄了脱敏没抄围栏** → 这就是 Hermes 现在的状态，DSH 应补上：子代理返回也必须包 `<untrusted_tool_result source="subagent">`。⚠️ 把 `terminal_state` 抄成异常 → 父循环会被一个子代理失败打断，正确做法是返回对象由父决定重试。 |

## ⑤ 实证 / 推断分界

| 判定 | 条 | 依据 / 如何验证 |
|---|---|---|
| 【实证】 | `role` 参数被忽略、由 `child_depth < max_spawn_depth` 推导 | `delegate_tool.py` / `subagent_lifecycle.py` 里 role 无读取点 |
| 【实证】 | 默认扁平 `MAX_DEPTH=1`、并发默认 10、默认无墙钟超时 | 配置默认值 |
| 【实证】 | 子代理返回只做密钥脱敏、不做注入围栏 | `tool_dispatch_helpers.py:457-598` 的 `_UNTRUSTED_TOOL_NAMES` 不含 `delegate_task` |
| 【推断】 | 子代理返回被投毒的实际发生率不低 | 无数据。**验证**：让子代理读含 ignore previous instructions 的页面，看父代理是否照做 |
| 【推断】 | 后台结果 never mid-turn 是必要的 | 由实现约束推断（中途插入会破坏 tool_call/result 配对）。**验证**：故意中途插入，看历史是否出现孤立 tool_result |
| 【未验证】 | bot_relay 文件信箱在单机场景的必要性 | 为多平台网关设计，DSH 无此场景，故未深入 |

## ⑥ 补充：跨网关房间（上一版漏了这一整块）

上一版把 `hosted_room*` 的 13 张表记为“未解问题”，原因是我只在数据目录里找协议——协议其实完整写在 `gateway/hosted_room_*.py`（17 个模块、8512 行）。**这不是“未发现”，是“找错地方了”**，在此补正并只保留与本面相关的部分。

| 层 | 契约 | 与本面的关系 |
|---|---|---|
| 能力目录 | `GatewayRoomCatalog`（`hosted_room_peer.py:193-241`） | 声明“我能接什么”：协议版本、链接模式、是否常驻 |
| 执行策略 | `RoomExecutionPolicy`（`hosted_room_execution_policy.py:30-65`） | 目标侧签发的 `enabled_toolsets` + `approval_mode`，**`off` 直接拒** |
| 投递坐标 | `HostedMemberDispatch`（17 字段，`:356-392`） | 一次远程子代理调用的完整身份：房间/成员/任务/代次/取消域/摘要 |
| 承载令牌 | HMAC 双段令牌（`:407-487`） | 权限 `approve/dispatch/status/stop`，TTL 1h（上限 24h） |

**为什么这对 DSH 有用**：DSH 没有第二台网关，抄不了房间协议；但 `HostedMemberDispatch` 是“跨成员消息该带什么字段”的一份现成答案，而降维成 7 字段的 `PanelEnvelope` 正好补上 DSH“场景间消息无强制字段”这个缺口。完整字段表与降维理由见 `08-附录/A4-跨网关房间协议.md`，候选编号 `ENV-01`。

⚠️ 一条反直觉的实证：Desktop **不是**签发者也不是信使——`"The Desktop may bootstrap an invitation but is never the issuer or runtime courier"`（`:3-5`）。授权必须在接收侧本地校验，中间层只递令牌不递信任。
