# 证据 E09 — MCP / 连接器

`0.22.2 / tools\mcp_tool*.py, optional-mcps\（65 个 manifest）, tools\connectors\`

| # | 路径:行 | 原文（≤40 字） | 说明 |
|---|---|---|---|
| E09-01 | optional-mcps/airtable/manifest.yaml:2 | `# Presence in this directory = approval.` | 声明即审批 |
| E09-02 | optional-mcps/airtable/manifest.yaml:15 | `transport:` | 传输声明 |
| E09-03 | optional-mcps/airtable/manifest.yaml:17 | `url: https://mcp.airtable.com/mcp` | 远程 MCP |
| E09-04 | optional-mcps/airtable/manifest.yaml:20 | `auth:` | 鉴权声明 |
| E09-05 | optional-mcps/airtable/manifest.yaml:23 | `suggest:` | 触发词/域名 |
| E09-06 | tools/mcp_tool_schema.py:159 | `MCP_TOOL_NAME_PREFIX = "mcp__"` | 命名空间 |
| E09-07 | tools/mcp_tool_schema.py:175 | `full_name = f"{MCP_TOOL_NAME_PREFIX}{sanitize_mcp_name_component(server_name)}` | 命名契约 |
| E09-08 | tools/tool_search.py:3 | `replaced in the model-visible array by three bridge tools` | 渐进披露 |
| E09-09 | tools/tool_search.py:5 | `never defer unless named in` | 核心不延迟 |
| E09-10 | tools/tool_search.py:6 | `the catalog is stateless — rebuilt from the live tool-defs every assembly` | 目录不缓存 |
| E09-11 | tools/mcp_tool_config.py:158 | `${VAR_NAME} interpolation; any non-} chars allowed` | 插值语法 |
| E09-12 | tools/mcp_tool_config.py:186 | `missed: some env reference was unset` | 未命中要标记 |
| E09-13 | tools/mcp_tool_discovery.py:31 | `_DISCOVERY_CONNECT_CONCURRENCY = 4` | 发现并发 |
| E09-14 | tools/mcp_tool_health.py:17 | `_KEEPALIVE_RPC_TIMEOUT = 30.0` | 保活超时 |
| E09-15 | tools/mcp_tool_health.py:2 | `keepalive probes, suspect-mark / lazy-verify, in-flight call fail-fast` | 健康策略 |
| E09-16 | tools/connectors/__init__.py:1 | `Connector integration boundary for managed gateway accounts and local MCP servers` | 连接器上位概念 |
| E09-17 | tools/connectors/__init__.py:5 | `contract (states, actors, transition table), operation (the record)` | 状态机分层 |
| E09-18 | agent/tool_dispatch_helpers.py:485 | `_UNTRUSTED_TOOL_PREFIXES = ("browser_", "mcp_")` | MCP 输出不可信 |

复核：`grep -n "defer\|BRIDGE" tools/tool_search.py | head`
