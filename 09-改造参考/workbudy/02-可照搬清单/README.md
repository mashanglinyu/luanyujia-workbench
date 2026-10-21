# 可照搬清单（按 DSH 缺口排序）

> 每一项都是：**缺口是什么 → WorkBuddy 怎么解的 → 具体抄哪个文件 → 改造成 DSH 的动作**。
> 标 ★ 的是"今天就能动手、改动小收益大"。

---

## 优先级 0：产物与变更区 ★★★

**缺口**：DSH 的产出散在终端日志和文件树里，没有一个地方说"这次任务我给了你什么"。

**WorkBuddy 的解法**：
1. 右栏 `结果区` 双 Tab：`概览`（任务摘要）/ `产物`（本次任务聚合出的文件卡片）
2. 产物卡片点开走内置预览（html/md/图片/pdf/表格），不跳外部程序
3. 单独的 `archive-artifact-sweep.js` 定期清扫，防止产物目录无限膨胀
4. `present_files` 是一个**工具**，不是 UI 行为——模型自己决定"这些东西该给你看"，最后一轮强制调用

**抄什么**：
- 契约：`05-前端交互/01-结果区与产物.md`
- 提示词片段：`06-原始资产/1-交互模式/interactionmode/craft/fragments/result-presentation.md`（4KB，直接可改）

**改造动作**：
- 加一张表 `artifacts(task_id, path, kind, created_at, sha1)`，任务结束扫工作目录增量
- 在 Agent 系统提示里加一条："任务完成且有可查看产物时，**最后一步**必须调用 `present_artifact`"
- 前端右栏加 Tab，产物卡片式渲染

---

## 优先级 1：三种模式（Ask / Plan / Agent）★★★

**缺口**：DSH 只有一个"完全权限"开关，粒度太粗。生产环境最需要的是"能看不能动"。

**WorkBuddy 的解法（这点非常关键）**：
模式不是提示词里"请你不要写文件"，而是**工具集白名单**。每个模式一个 frontmatter，`tools:` 下列出该模式可用的工具。Ask 模式下 Write/Edit/Bash 根本不存在。

```yaml
# interactionmode/plan/fragments/interaction.md 头部
---
name: plan
tools:
  - Read
  - Glob
  - Grep
  - TaskCreate
  - AskUserQuestion
  - ExitPlanMode
  ...
---
```

权限模式枚举【实证】：`default` / `acceptEdits` / `bypassPermissions` / `plan` / `dontAsk` / `auto` / `ignore`
（来自 `parsePermissionMode()` 的映射表）

**抄什么**：
- 全套：`06-原始资产/1-交互模式/interactionmode/`（5 个模式 × fragments）
- 解析说明：`03-Agent运行时/01-工具系统与三种权限模式.md`

**改造动作**：
- DSH 现在那个"完全权限"下拉，扩成三档：`只读` / `计划` / `执行`
- **不要靠提示词约束，要在工具注册表层面过滤**：`getTools(mode)` 返回子集
- 只读档：只注册 read/grep/glob/查询类工具
- 计划档：可读可查，允许产出计划文档，禁止一切写操作
- 执行档：全开

---

## 优先级 2：危险操作审批闸门 ★★★

**缺口**：SSH 那条 `root@prod-oa-01:~$` 是真·无护栏。SQL 有审计（事后），命令没有拦截（事前）。

**WorkBuddy 的解法**：PreToolUse Hook + fail-closed。
最值钱的是 `high-credit-gate.cjs` 头部那 40 行中文注释，它把设计契约写死了：

- 命中 → 返回 `permissionDecision: 'ask'` → 宿主弹审批卡
- 这个判定发生在**所有权限规则和 bypassPermissions 之前**，所以绕过权限也没用
- **fail-closed**：脚本异常、输入畸形、清单读不到，一律兜底为 `ask`。宁可多弹一次窗，不能漏
- 非目标工具只能返回 `{"continue":true}`，**绝不能返回 `'allow'`**（`allow` 会短路整个权限检查）
- stdout 必须是纯净单行 JSON；诊断走 stderr；**不得打印 tool_input**（含用户 prompt，属 PII）
- exit code 恒 0（exit 2 等于 deny，语义不对）

**抄什么**：
- 完整实现 + 注释：`06-原始资产/2-Hook参考实现/high-credit-gate.cjs`
- 协议细节：`03-Agent运行时/02-Hook机制与审批闸门.md`

**改造动作**：
- 写 `dsh-hooks/ssh-guard.cjs`，匹配 `rm -rf` / `drop table` / `update` 无 where / `systemctl stop` / `truncate`
- 命中返回 ask，审批卡里显示**完整命令 + 目标主机 + 预计影响**
- 加"本次会话内同类命令不再询问"的授权记忆（WorkBuddy 用 `agent-cli-approvals` 状态文件，按 group 记忆）
- 特别注意：任何异常都要走 `ask`，不要因为脚本 bug 变成静默放行

---

## 优先级 3：变更 diff 与回滚 ★★

**缺口**：AI 改了 `/www/...` 下三个文件，你看不到改了哪几行，也没法回退。

**WorkBuddy 的解法（【推断】，基于行为反推）**：
结果区有"变更"分类，列本次任务触碰的文件与增删行数，可展开 diff。文件层面前置快照 + 可撤销。
（`doc_undo_ai_edit`、`doc_list_recent_ai_edits` 这套"AI 编辑记录 + 按 version 撤销"的结构可以参考，说明他们内部是**按 version 记录每次 AI 写操作**的）

**抄什么**：DSH 没有现成的能直接抄，看设计建议：`05-前端交互/02-变更diff与回滚.md`

**改造动作（最小实现）**：
1. 所有写操作前，把目标文件 copy 到 `.dsh/snapshots/<task_id>/<相对路径>.<rev>`
2. 记录 `(task_id, path, rev, ts, tool_call_id)`
3. UI 里跑 `diff -u` 出统一 diff，右栏渲染
4. 回滚 = 直接覆盖 + 留一条 rollback 记录
5. **别用 git 做这件事**——工作目录可能本来就在 git 里，会污染用户仓库

---

## 优先级 4：任务化与并行 ★★

**缺口**：DSH 按"面板"组织，不按"任务"。AI 干到一半切走，回来还在原地。没有并行。

**WorkBuddy 的解法**：
- 工具集：`TaskCreate` / `TaskGet` / `TaskUpdate` / `TaskList` / `TaskStop` / `TaskOutput`
- 提示词约束（`task-management.md`）：只在"≥3 个可独立验证的步骤"或"用户明确要求拆解"时才用；`TaskUpdate` 标记完成要**立刻**标，不许攒批
- 并行：`Agent()` 工具起子代理，`run_in_background: true`；`Promise.all` 批量派发；`TeamCreate` 建团队、`SendMessage` 互通
- 子代理提示词：`06-原始资产/1-交互模式/.../agent-loop.md`

**抄什么**：
- `06-原始资产/1-交互模式/interactionmode/plan/fragments/task-management.md`（838B，一整段就给清楚了）
- `03-Agent运行时/04-多智能体与工作流.md`

**改造动作**：
- 左栏从"面板列表"改成"任务列表"，按项目分组，每个任务有状态机（pending/running/done/failed）
- 任务 = 一个独立 session + 独立产物集 + 独立工作目录
- 并行先做一个就够：允许同时跑 2 个任务，用 `job-object`（Windows）隔离进程组

---

## 优先级 5：技能库 ★

**缺口**：DSH 已经有 SKILL.md 机制（你文案里讲的），但 UI 上没入口，用户不知道 AI 现在会什么。

**WorkBuddy 的解法**：
- 技能包 = 目录 + `SKILL.md`（YAML frontmatter: `name` / `description` / `allowed-tools` / `disable`）+ 附属脚本
- **渐进式加载**：只有 `name + description` 常驻上下文，正文按需读
- `skill-creator` 本身就是一个教模型"怎么写技能"的技能（元技能）

**抄什么**：`04-能力层/01-技能系统.md`、`06-原始资产/5-技能包样例/skill-creator/SKILL.md`

**改造动作**：先做只读面板——列出当前加载的技能、来源、描述、开关。成本半天。

---

## 优先级 6：连接器中心 ★

**缺口**：SSH / MySQL / 监控是硬编码的，加一个系统就要改代码。

**WorkBuddy 的解法**：插件目录约定 + `.mcp.json` 声明：
```json
{ "mcpServers": { "miora": {
    "type": "stdio", "command": "node",
    "args": ["${CODEBUDDY_PLUGIN_ROOT}/dist/cli.cjs"],
    "cwd": "${CODEBUDDY_PLUGIN_ROOT}",
    "env": { "MIORA_ENDPOINT": "${MIORA_ENDPOINT:-}" },
    "defer_loading": false
}}}
```
变量插值 + `defer_loading` 开关 + 目录即插件（丢进 `mcps/` 就生效）。

**抄什么**：`04-能力层/02-MCP与连接器.md`、`06-原始资产/3-MCP声明/`

**改造动作**：把 SSH/MySQL 包成 `connectors/<name>/connector.json`（命令、参数模板、健康检查、权限级别），启动时扫目录注册。

---

## 优先级 7：定时与自动化 ★

**缺口**：你已经手动做了"每周日跑 8 类体检"。应该自动跑。

**WorkBuddy 的解法**：`automation_update` 工具 + RRULE + `validFrom/validUntil`，一次性/周期两种。提示词里明确要求"prompt 要自包含，因为未来运行看不到当前对话"。

**抄什么**：`04-能力层/03-任务与自动化.md`

**改造动作**：cron → 起一个离线 session → 跑体检 → 结果作为产物推到会话列表顶部。

---

## 不用抄的

| 能力 | 为什么不抄 |
|---|---|
| 云端资料库 / 多端同步 | 你是本地优先，抄了变重 |
| 专家市场 / 插件市场 | 是分发机制，不是能力 |
| MCP Apps 宿主（83KB） | 让 MCP 返回可交互 UI，投入产出比低 |
| 6 套 IM 接入 | 你用不到 |
| 自动更新 / 崩溃上报 | Electron 生态现成的 |

---

## 如果只做一件事

**优先级 2（审批闸门）**。理由：它最小（一个 cjs 脚本 + 一个弹窗），但直接决定你敢不敢让 AI 在 prod 上自己跑。安全性是一切自动化的前置条件。

如果要做两件，加**优先级 0（产物区）**——它决定你每次任务结束后有没有"东西"可交付。
