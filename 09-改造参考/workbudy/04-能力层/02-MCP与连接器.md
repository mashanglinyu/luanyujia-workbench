# MCP 与连接器

## 一、连接器的声明格式

【实证】`mcps/miora-mcp/.mcp.json` 全文：

```json
{
  "mcpServers": {
    "miora": {
      "type": "stdio",
      "command": "node",
      "args": ["${CODEBUDDY_PLUGIN_ROOT}/dist/cli.cjs"],
      "cwd": "${CODEBUDDY_PLUGIN_ROOT}",
      "env": {
        "MIORA_MCP_TRANSPORT": "stdio",
        "MIORA_DATA_DIR": "${CODEBUDDY_PLUGIN_DATA}",
        "MIORA_ENDPOINT": "${MIORA_ENDPOINT:-}"
      },
      "defer_loading": false
    }
  }
}
```

四个设计点：

1. **目录即连接器**：把 `mcps/<name>/` 丢进去就注册，不需要改任何代码
2. **变量插值**：`${CODEBUDDY_PLUGIN_ROOT}`、`${CODEBUDDY_PLUGIN_DATA}`、`${VAR:-默认值}` —— 最后这个 shell 风格的默认值语法很实用
3. **`defer_loading`**：控制工具 schema 是否进初始上下文（见下文）
4. **`type: stdio`**：本地进程；也支持 http/sse

## 二、声明式策略：单一事实源（这是最值得抄的一个模式）

`mcps/miora-mcp/high-credit-tools.json` 整个文件就是一份策略声明：

```json
{
  "version": 1,
  "tools": {
    "miora_text_to_image":   { "approvalKind": "imageGen", "group": "miora-image" },
    "miora_edit_image":      { "approvalKind": "imageGen", "group": "miora-image" },
    "miora_text_to_video":   { "approvalKind": "videoGen", "group": "miora-video" },
    "miora_frame_to_video":  { "approvalKind": "videoGen", "group": "miora-video" },
    "miora_reference_to_video": { "approvalKind": "videoGen", "group": "miora-video" }
  }
}
```

它的 `$comment` 里写了**三方消费**：

> 三方消费：① 共享闸门脚本 `hooks/high-credit-gate.cjs` 的审批触发白名单、approvalKind 文案与审批记忆分组推导；② daemon 扫描聚合出 hook matcher 与 `CODEBUDDY_APPROVAL_MEMORY_GROUPS` 分组值；③ 桌面构建期校验。
> **新增 / 改名生成类工具只改本文件，宿主各层无需改代码。**

**这个模式的价值**：把"哪些工具要审批、归哪个组、用什么文案"从代码里抽出来变成数据。新增一个高危工具，只改一个 JSON。

而且注释里还有两个真实踩坑记录：

> 写入白名单外的值比不声明更危险：浮层会静默不显示但工具照跑照扣积分，故 hook 侧对非法值按『已知高积分但声明不可信』fail-closed 弹窗（不带文案 meta）。

> 图片与视频刻意分组 —— 允许生成图片不应顺带授权更贵的视频。
> 跨插件 group 名禁止重名（构建期校验拦截）。

**"允许便宜的，不自动允许贵的"** —— 这条原则直接可以套到你的运维场景：允许 `SELECT`，不自动允许 `UPDATE`；允许 `systemctl status`，不自动允许 `restart`。

## 三、defer_loading 的取舍

| 取值 | 行为 | 代价 |
|---|---|---|
| `false`（直连） | 工具 schema 常驻上下文，模型直接能调 | 每个工具 300–800 token，**每轮都付** |
| `true`（默认，延迟） | 只给名字，schema 要用时现查（`ToolSearch` → `DeferExecuteTool`） | 省 token，但多一次往返；**且会绕过 PreToolUse Hook** |

第二条是坑，原文见 `high-credit-gate.cjs` 注释：

> 若插件走 defer 加载，工具调用会先经 `DeferExecuteTool`。bypass 模式下它的前置 `checkPermission` 返回 allow 并直接短路返回「无需审批」，本 hook 压根不会被执行。计费工具的插件必须在 `.mcp.json` 显式写 `defer_loading: false`（全局默认是 true）。

**推论**：受审批保护的工具，必须 `defer_loading: false`。
DSH 里就是：SSH 执行、SQL 写操作这类工具，不能走延迟加载通道。

## 四、插件清单（marketplace）

【实证】`.codebuddy-plugin/marketplace.json`：

```json
{
  "name": "workbuddy-builtin",
  "owner": { "name": "WorkBuddy", "email": "..." },
  "metadata": { "version": "1.0.0", "phase": "addon-context-orchestration" },
  "plugins": [
    {
      "name": "welcomemode-design",
      "source": "./welcomemode/design",
      "category": "welcomeMode",
      "dependencies": ["mcp-miora", "ardot"],
      "version": "5.8.3-..."
    }
  ]
}
```

有 `category` 和 `dependencies`。这意味着插件加载是有**拓扑顺序**的——`welcomemode-design` 依赖 `mcp-miora`，后者必须先起。

DSH 如果要做连接器依赖（比如"数据库连接器依赖 SSH 隧道"），这个字段是现成的设计。

## 五、DSH 的改造动作

### 5.1 把硬编码的连接改成声明

现在 SSH / MySQL 大概是写死在代码里的。改成：

```
.dsh/connectors/
├── prod-oa-ssh/
│   ├── connector.json
│   └── policy.json
├── prod-oa-mysql/
│   ├── connector.json
│   └── policy.json
└── monitor/
    └── connector.json
```

`connector.json`：
```json
{
  "name": "prod-oa-ssh",
  "type": "ssh",
  "host": "${OA_HOST}",
  "port": 22,
  "user": "${OA_USER}",
  "auth": { "keyFile": "${OA_KEY}" },
  "healthCheck": { "command": "uptime", "interval": 60 }
}
```

`policy.json`（对应 high-credit-tools.json 的角色）：
```json
{
  "version": 1,
  "tools": {
    "ssh_exec":  { "approvalKind": "danger", "group": "ssh-exec" },
    "ssh_read":  { "approvalKind": "none" },
    "sql_write": { "approvalKind": "danger", "group": "sql-write" },
    "sql_read":  { "approvalKind": "none" }
  }
}
```

### 5.2 状态可视化

你的左栏已经有 `backend online / nginx active / mysql active`。把它升级成连接器面板：

`连接器名 | 类型 | 状态 | 上次探测 | 权限级别 | 开关`

带开关很重要——某个连接器出问题要能一键停用，而不是整个工作台都别用了。

### 5.3 别做的

- 别做 MCP Apps 宿主（让 MCP 返回可交互 UI）。WorkBuddy 花了 83KB 在主进程做这个，投入产出比对你不划算
- 别支持三种 transport。先只做 `stdio`（本地进程）

---

**证据**：`06-原始资产/3-MCP声明/`（两个 JSON 全文，注释就是设计文档）
