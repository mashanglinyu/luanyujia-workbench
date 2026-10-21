# 09 MCP / 连接器

`0.22.2+2364.g0b10b9f / <旧位置>\Hermes / tools\mcp_tool*.py（26 个）、optional-mcps\（65 个 manifest.yaml）、tools\connectors\`

## ① 结论

1. **"连接器"在 Hermes 里是 MCP 的上位概念**：`tools/connectors/` 同时管"托管网关账号"和"本地 MCP server"，统一出 `contract`（状态/角色/迁移表）、`dispatch`、`live`（每会话一条活动记录）。
2. **声明格式是 `manifest.yaml`，而"在目录里 = 已审批"**：`optional-mcps/<slug>/manifest.yaml` 存在即白名单，经 PR 评审合入；不是运行时从网上拉目录。
3. **工具名带命名空间前缀** `mcp__<server>__<tool>`，并做了**名称净化**（`sanitize_mcp_name_component`），防工具名里塞控制字符伪造协议行。
4. **按需加载不是开关，而是"三层桥"**：`tool_search` / `tool_describe` / `tool_call` 三个桥工具替代被延迟的工具；核心工具（`_HERMES_CORE_TOOLS`）永不延迟，除非显式列进 `defer`。
5. **健康检查是"保活探针 + 可疑标记 + 惰性验证"**：30s 超时的 `list_tools`/`send_ping`，失败不立刻判死，先 mark suspect，下次调用再验。

## ② 证据

| # | 位置 | 原文（截断） | 说明 |
|---|---|---|---|
| 1 | `hermes-agent/optional-mcps/airtable/manifest.yaml:1-2` | `# Nous-approved MCP catalog entry.` `# Presence in this directory = approval.` | 白名单语义 |
| 2 | 同上 `:6-10` | `name: airtable` / `connector_slug: airtable` / `source: https://...` | 标识与来源 |
| 3 | 同上 `:14-20` | `transport: type: http; url: https://mcp.airtable.com/mcp` `auth: type: oauth` | 传输 + 鉴权 |
| 4 | 同上 `:22-27` | `suggest: keywords: [airtable] hosts: [airtable.com]` | 提示触发（品牌胶囊） |
| 5 | `tools/mcp_tool_config.py:1-2` | `${VAR}/Cursor-style interpolation, hidden-whitespace and suspicious-entry filtering` | 插值 + 过滤 |
| 6 | `tools/mcp_tool_config.py:158` | `${VAR_NAME} interpolation; any non-} chars allowed so MY-VAR / my.var work` | 插值语法 |
| 7 | `tools/mcp_tool_config.py:186` | `missed: some env reference was unset` | 未命中要显式标记（不猜） |
| 8 | `tools/mcp_tool_schema.py:159` | `MCP_TOOL_NAME_PREFIX = "mcp__"` | 前缀 |
| 9 | `tools/mcp_tool_schema.py:175` | `full_name = f"{MCP_TOOL_NAME_PREFIX}{sanitize_mcp_name_component(server_name)}__{sanitize_mcp_name_component(tool_name)}"` | 命名契约 |
| 10 | `tools/tool_search.py:1-6` | `MCP/plugin tools ... replaced in the model-visible array by three bridge tools — tool_search / tool_describe / tool_call` | 延迟机制 |
| 11 | `tools/tool_search.py:3-5` | `core tools ... and session-gated GUI toolsets never defer unless named in defer` | 例外规则 |
| 12 | `tools/tool_search.py:6` | `the catalog is stateless — rebuilt from the live tool-defs every assembly` | 目录不缓存（防漂移） |
| 13 | `tools/mcp_tool_discovery.py:31` | `_DISCOVERY_CONNECT_CONCURRENCY = 4` | 发现并发上限 |
| 14 | `tools/mcp_tool_health.py:17` | `_KEEPALIVE_RPC_TIMEOUT = 30.0` | 保活超时 |
| 15 | `tools/mcp_tool_health.py:171-179` | `await ... self.session.list_tools()` / `send_ping()` | 探针内容 |
| 16 | `tools/mcp_tool_health.py:2-3` | `keepalive probes, suspect-mark / lazy-verify, in-flight call fail-fast, stdio child liveness and stdio idle/lifetime recycling` | 健康策略 |
| 17 | `tools/mcp_tool_config.py:25-27` | `Shared append-mode handle for MCP subprocess stderr` | stderr 落 `logs/mcp-stderr.log` |
| 18 | `tools/connectors/__init__.py:1-2` | `Connector integration boundary for managed gateway accounts and local MCP servers` | 连接器 = 账号 + MCP |
| 19 | `tools/connectors/__init__.py:3-6` | `contract (states, actors, transition table), operation (the record), live (open operation per session), run` | 状态机分层 |
| 20 | `agent/tool_dispatch_helpers.py:485` | `_UNTRUSTED_TOOL_PREFIXES = ("browser_", "mcp_")` | MCP 输出一律当不可信 |
| 21 | `tools/mcp_tool_scope.py`（存在） | `_key_visible_in_scope` | 按 profile 隔离可见性 |
| 22 | `agent/compaction_events.py:52` | `"provider"` trigger | 服务端压缩也走同一遥测 |

## ③ 契约

```yaml
# optional-mcps/<slug>/manifest.yaml
manifest_version: 1
name: <slug>
connector_slug: <slug>
description: >-
  ...
source: <vendor docs url>
transport:
  type: http | stdio
  url: https://...           # http
  # command/args/env: ...    # stdio
auth:
  type: oauth | none | api_key
suggest:
  keywords: [..]             # 桌面端品牌胶囊触发词
  hosts: [..]                # URL 域名触发
post_install: |
  <安装后要告诉用户的话>
```

**运行期形状**

```
tool_name = "mcp__" + sanitize(server) + "__" + sanitize(tool)
toolset   = "mcp_<server>"           # 可按 toolset 整体启停
可见性    = _key_visible_in_scope(profile)  # 多 profile 隔离
输出      = 一律包 <untrusted_tool_result source="mcp__...">（见 11 注入防护）
```

**三层桥（渐进披露的工具版）**

| 模型看到 | 作用 |
|---|---|
| `tool_search(query)` | 在"被延迟的目录"里搜；只返回极小描述 |
| `tool_describe(name)` | 取完整 schema |
| `tool_call(name, args)` | 真正执行；路由回 `model_tools.handle_function_call` |

不变量：①核心工具不延迟；②**只要有一个可延迟工具，桥就激活**（列表规模按预算而不是按激活数）；③目录每次重新组装 —— 缓存的目录会静默丢工具。

**健康检查与权限级别**

| 项 | 值 |
|---|---|
| 保活 | `list_tools` 或 `send_ping`，30 s |
| 失败 | mark suspect → 下次调用惰性验证（**不立即杀进程**） |
| 发现并发 | 4（可配 `mcp.discovery_concurrency`，0=不限） |
| stdio 子进程 | 空闲/寿命回收；stderr 落 `logs/mcp-stderr.log` |
| 权限级别 | 与内置工具**同级**，一律走审批层；**没有**"MCP 免审批"的通道 |
| 危险操作 | MCP 工具名也进 `_DETECTIVE`/`_DESTRUCTIVE` 匹配范围，参数被规范化后送审 |

## ④ 对 DSH 的适配

| 项 | 内容 |
|---|---|
| DSH 现状 | **有**（MCP）。缺"渐进披露"和"连接器状态机"。DSH 把所有 MCP 工具平铺进工具列表，工具一多就吃满上下文。 |
| 缺口 | ①30 个 MCP 工具 ≈ 6–9K token 常驻；②没有"声明即审批"的白名单，用户随便加 server；③没有 health/保活，server 挂了每次调用都超时。 |
| 落点 | 引擎：`packages/engine/src/mcp/bridge.ts`（tool_search/describe/call 三件套）+ `mcp/health.ts`；外壳：连接器页复用 manifest 字段。 |
| 成本 | **M**。桥 M（要接工具注册表与 schema 缓存），health S，manifest S。 |
| 失败模式 | ⚠️ **缓存 tool_search 目录** → 会静默丢新装工具（`tool_search.py:6` 明说不缓存）。⚠️ **把桥做成"第二个工具命名空间"** → 模型会直接调 `mcp__x__y` 绕过桥；必须在组装时真的把它们从数组里移除。⚠️ **变量插值未命中时当空串** → token 变空串，server 用匿名身份连上；Hermes 用 `missed` 标记显式区分"未设"与"设成空"。⚠️ **对 MCP 输出不做围栏** → MCP server 是第三方代码，它的返回是最典型的不可信内容。 |

## ⑤ 实证 / 推断分界

| 判定 | 条 | 依据 / 如何验证 |
|---|---|---|
| 【实证】 | `manifest.yaml` 存在即审批、`${VAR}` 插值 + `missed` 标记、三层桥、保活 30s + suspect-mark + lazy-verify | `tools/mcp_tool.py`、`tool_search.py`、`optional-mcps/airtable/manifest.yaml` 原文 |
| 【实证】 | 工具命名 `mcp__{server}__{tool}` | 代码里的拼接点 |
| 【推断】 | 三层桥能省 schema 预算 | 按数量级推断（30 工具 → 3 桥），未实测 token 差。**验证**：直挂 vs 桥接，比 system prompt 字符数 |
| 【推断】 | 目录不缓存是刻意选择 | 代码无明显缓存层，也可能是未优化。**验证**：读 `tool_search.py` docstring 找设计说明 |
| 【未验证】 | 各 MCP 服务器实际握手行为 | 本任务禁止联网/启动服务器；只读到客户端代码 |
