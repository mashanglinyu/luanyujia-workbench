# Hook 机制与审批闸门

> 这是 DSH 最该抄、也最容易抄错的一块。抄错的表现是：加了拦截，但某些路径静默放行了。

## 一、事件清单

【实证】从 bundle 里提取的事件常量（`mc.mb.*` 枚举 + 遥测常量）：

| 事件 | 触发时机 | 能不能拦 |
|---|---|---|
| `PreToolUse` | 工具执行前 | **能拦**，且能改参数 |
| `PostToolUse` | 工具成功返回后 | 不能拦，只能观察 |
| `PostToolUseFailure` | 工具抛异常 | 不能拦 |
| `PermissionRequest` | 需要用户授权时 | 能改授权文案 |
| `UserPromptSubmit` | 用户消息提交后、进模型前 | **能拦**，可改 prompt |
| `SessionStart` / `SessionEnd` | 会话生命周期 | 不能拦 |
| `Notification` | 需要提示用户 | — |
| `SubagentStart` / `SubagentStop` | 子代理生命周期 | — |
| `Stop` / `StopFailure` | 一轮结束 | — |
| `CompactStarted` / `CompactEnded` / `CompactFailed` / `PostCompact` | 上下文压缩前后 | — |

DSH 只需要前两个 + `UserPromptSubmit`。**别一上来就全铺**。

## 二、返回契约（【实证】反推自 executeToolWithHooks）

PreToolUse hook 的返回值结构：

```ts
{
  allowed: boolean,               // false → 直接拒绝，工具不会执行
  permissionDecision?: 'allow' | 'deny' | 'ask',
  message?: string,               // 拒绝时给模型看的话
  modifiedInput?: object,         // 改写后的参数（会覆盖原参数）
  preventContinuation?: boolean,  // true → 不光拒这一次，整轮终止
  hookSpecificOutput?: object     // 透传给宿主 UI（审批卡文案等）
}
```

调用签名：

```ts
ToolHookManager.executePreToolUseHooks(
  toolName, input, session, sessionFilePath, cwd, callId
): Promise<HookResult>
```

三个行为细节，都是踩过坑才会写进去的：

1. **结果按 `callId` 缓存**（`session.preToolUseHookResults`）。同一个 tool_call 被判过就不再判——因为 hook 可能是外部进程，很贵。
2. **`modifiedInput` 会覆盖原参数**。这意味着 hook 可以"消毒"命令（比如把 `rm -rf /` 改写成 `rm -rf /tmp/xxx`），也可以反过来被利用，所以后面还有一层最终授权。
3. **`preventContinuation` 是升级版拒绝**。普通拒绝只是让模型换个方法，`preventContinuation` 是"停下，别再试了"。

## 三、进程级 Hook 的硬约束（照抄这段，能省你三天）

`high-credit-gate.cjs` 的头注释是一份现成的设计规范，原文要点：

```
1. 零第三方依赖；内置模块 lazy require
   唯一允许的 require 是 node:fs / node:path

2. fail-closed
   任何异常/畸形输入/清单整体不可用 → 兜底 'ask'
   上游在 hook 抛错时会 fall-through 到常规权限检查，
   bypass 下等于静默放行、零审批 —— 宁可多弹一次窗，不能漏弹

3. stdout 必须是纯净单行 JSON
   上游对 stdout 整体做 JSON.parse，混入任何文本都会让解析失败
   诊断信息一律走 stderr，且不得打印 tool_input（含用户 prompt，属 PII）

4. 非目标工具只能返回 {"continue":true}，绝不能返回 'allow'
   'allow' 会让上游直接短路掉整个权限检查流程，绕过所有既有规则
   —— 那是安全事故

5. exit code 恒 0
   exit 2 等价于 deny，其它非 0 仅向用户提示，都不是本 hook 的语义

6. 幂等、无副作用
   只读清单与审批状态文件，不写文件、不发网络、不改环境
   读盘失败一律按「无状态」处理，绝不因此放行
```

还有两个工程细节值得抄：

- **stdin 看护**：`STDIN_TIMEOUT_MS = 1500`，加 `MAX_STDIN_BYTES = 1MB`。读超时/超限都转成安全决策，而不是挂死。
- **审批元数据**：命中时额外带 `hookSpecificOutput['codebuddy.ai/approval']`（policyId / category / kind），宿主浮层据此渲染不同的文案。**fallback 分支刻意不带 meta**，UI 退化成普通审批卡，仍然 fail-closed。

## 四、DSH 的落地改造

### 4.1 文件结构

```
<盘根>\...\dsh\
├── hooks/
│   ├── ssh-guard.cjs       危险命令拦截
│   ├── sql-guard.cjs       SQL 写操作拦截
│   └── audit.cjs           全量留痕（PostToolUse，只观察）
└── hooks.config.json       哪类工具挂哪个 hook
```

### 4.2 危险命令规则（先写这 12 条就够）

```js
const DANGER = [
  { id:'rm-root',      re:/\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(\/|\/\*|~|\$HOME)\s*$/ },
  { id:'rm-broad',     re:/\brm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+[^\n]*\*/ },
  { id:'dd-disk',      re:/\bdd\b[^\n]*of=\/dev\// },
  { id:'mkfs',         re:/\bmkfs(\.\w+)?\b/ },
  { id:'drop',         re:/\b(drop|truncate)\s+(table|database)\b/i },
  { id:'update-no-where', re:/\bupdate\s+\w+\s+set\b(?![\s\S]*\bwhere\b)/i },
  { id:'delete-no-where', re:/\bdelete\s+from\s+\w+(?![\s\S]*\bwhere\b)/i },
  { id:'svc-stop',     re:/\bsystemctl\s+(stop|disable|mask)\b/ },
  { id:'kill-all',     re:/\bkill(all)?\s+-9\s+-1\b/ },
  { id:'chmod-777',    re:/\bchmod\s+(-R\s+)?777\b/ },
  { id:'crontab-rm',   re:/\bcrontab\s+-r\b/ },
  { id:'git-force',    re:/\bgit\s+push\s+[^\n]*--force\b/ },
];
```

### 4.3 输出必须长这样

```js
// 命中
process.stdout.write(JSON.stringify({
  permissionDecision: 'ask',
  message: `高危命令：${hit.id}\n${cmd}\n确认要在 ${host} 上执行？`,
  hookSpecificOutput: { 'dsh/approval': { policyId: hit.id, category: 'danger' } }
}) + '\n');

// 放行（非本 hook 职责的工具）
process.stdout.write(JSON.stringify({ continue: true }) + '\n');

// 拒绝
process.stdout.write(JSON.stringify({
  permissionDecision: 'deny',
  message: '该操作被策略禁止，请换一种方式或联系管理员'
}) + '\n');
```

### 4.4 授权记忆

WorkBuddy 用 `agent-cli-approvals` 状态文件，按 **group** 记忆"这个会话内同类命令别再问"。
坑（注释里写了）：**跨插件组名不得重名**，否则 A 的授权会顺带放行 B 的同组工具。

DSH 里对应的坑是：如果你按"主机名"做记忆分组，那么 `47.108.x.x` 上的一切命令会互相放行。**按 (主机, 命令类型) 二维分组**。

### 4.5 三个必须自测的场景

| 场景 | 期望 |
|---|---|
| hook 脚本语法错误 / 路径不存在 | 弹审批（不是放行） |
| stdin 空 / 超 1MB / 非 JSON | 弹审批 |
| 工具走延迟加载通道 | **确认 hook 是否被调用**，没被调用就把该工具设成 `defer_loading: false` |

第三条最容易漏。WorkBuddy 专门为它改了 `.mcp.json`。

---

**证据**：`07-证据/raw/hooks-context.txt`、`07-证据/raw/hook-events.txt`
**原始资产**：`06-原始资产/2-Hook参考实现/high-credit-gate.cjs`（22KB，注释占三分之一，值得通读）
