# 改造参考 · WorkBuddy 逆向工程档案

> 给 DSH（DSH 引擎）读的改造说明书。
> 目标：**不是抄代码，是抄架构决定**。WorkBuddy 的代码是 minify 过的打包产物，直接复制没有意义；有价值的是它的**模块切分、协议契约、以及踩过坑之后写进注释里的那些硬约束**。

## 一、这是什么机器

WorkBuddy 5.8.3，腾讯出的 Electron 桌面 Agent 工作台。安装位置 `<旧位置>\workbudy\WorkBuddy`。

```
WorkBuddy/
├── WorkBuddy.exe                    204MB，但只是壳
└── resources/
    ├── app.asar                      96MB，主进程 + 渲染层（打包）
    ├── app.asar.unpacked/
    │   ├── cli/dist/codebuddy-lite-wb.mjs    9.48MB ← Agent 运行时全部逻辑在这
    │   ├── cli/dist/lazy-lite-wb/            68 个按需分包
    │   ├── cli/product.json                  多环境产品配置（389KB）
    │   ├── main/preload/fork-preload.cjs     731KB 预加载桥
    │   ├── resources/plugins/workbuddy-builtin/   ★ 明文，最有价值
    │   └── wb-guest-sdk/wb.js                18KB guest SDK
    └── vendor/  PortableGit / python / node
```

**关键发现**：Agent 本体（`codebuddy-lite-wb.mjs`）是 rspack 打包 + 变量名压缩，但**字符串全保留**。所以工具名、错误信息、提示词、配置键都能 grep 出来——这也是本档案 07-证据 的来源。

而 `resources/plugins/workbuddy-builtin/` 是**完全明文**的：提示词片段是 markdown，hook 是带完整中文设计注释的 cjs。这一块可以直接拿去改。

## 二、怎么读这套资料

| 你想干什么 | 读这里 |
|---|---|
| 先知道整体架构 | `01-架构/01-进程与模块地图.md` |
| 看它到底有什么功能 | `01-架构/02-功能全景清单.md`（62 工具 / 20 智能体 / 88 开关实证） |
| 照着缺口清单动手 | `02-可照搬清单/README.md` ← **从这开始最省时间** |
| 让 DSH 直接开工 | `02-可照搬清单/开工提示词.md` ← 整段粘给它 |
| 改模式/权限/工具集 | `03-Agent运行时/01-工具系统与三种权限模式.md` |
| 做危险操作拦截 | `03-Agent运行时/02-Hook机制与审批闸门.md` |
| 改上下文压缩 | `03-Agent运行时/03-上下文压缩与记忆注入.md`（结构）＋`06-压缩与注入的完整机制.md`（**带参数与伪代码，先读这篇**） |
| 做多 Agent 协作 | `03-Agent运行时/04-多智能体与工作流.md` |
| 防提示词注入 | `03-Agent运行时/05-提示词工程与注入防护.md` |
| 加技能系统 | `04-能力层/01-技能系统.md` |
| 改掉「目录+索引」的生硬感 | `04-能力层/04-技能的根源性改造.md` ← 范式修正，先读这个 |
| 加连接器 | `04-能力层/02-MCP与连接器.md` |
| 做模型计费/成本展示 | `04-能力层/05-模型倍率与计费设计.md`（实证倍率表 + 倍率制设计） |
| 任务化 + 定时 | `04-能力层/03-任务与自动化.md` |
| 做结果区/产物预览 | `05-前端交互/01-结果区与产物.md` |
| 做变更 diff 与回滚 | `05-前端交互/02-变更diff与回滚.md` |
| 直接复用现成文件 | `06-原始资产/`（42 个明文文件，可直接拷进 DSH） |
| 查证我为什么这么说 | `07-证据/raw/`（原始 grep 上下文，带字节偏移） |
| **给自己的 DSH 做诊断** | `08-DSH诊断/01-结构诊断与改造建议.md`（机制错位在引擎外） |
| **接权限链 / 装自动审批** | `08-DSH诊断/02-权限链深查.md` ← **四层漏斗实证，修正了 01 的一条建议** |

## 三、三条最重要的结论

**1. 模式不是靠提示词约束的，是靠「工具集白名单」约束的。**
WorkBuddy 每个交互模式（ask / plan / craft / expert / quick）都有一个 `fragments/interaction.md`，文件头是 YAML frontmatter，直接列出这个模式下**允许调用的工具名单**。Ask 模式根本没有 Write/Edit/Bash——不是"要求模型别改"，是"模型拿不到这个工具"。
参考：`06-原始资产/1-交互模式/interactionmode/plan/fragments/interaction.md`

**2. Hook 是唯一能绕过 `bypassPermissions` 的强制闸门。**
它的计费审批 hook 注释里写得很清楚：`permissionDecision: 'ask'` 的判定发生在**所有权限规则和 bypass 判定之前**。而且要求 fail-closed——任何异常都必须兜底成"要审批"，宁可多弹一次窗。
参考：`06-原始资产/2-Hook参考实现/high-credit-gate.cjs`（这份注释本身就是一份设计文档）

**3. 提示词是「片段拼装」出来的，不是一整段。**
用 Jinja 风格模板：`{% if Flag %}`、`{% include "path.md" %}`、`{{ Variable }}`。同一个 `tool-use.md` 被多个模式 include，差异只在 mode 专属片段。想改行为就换片段，不用动代码。
参考：`06-原始资产/4-提示词片段/`、`07-证据/raw/skill-load.txt`

## 四、边界声明

- 本档案只做**结构与契约的转述**，不搬运 WorkBuddy 的业务代码。`06-原始资产` 里的文件都是安装包里明文分发的提示词/配置/参考实现，用于理解格式。
- 文档里凡是标注 **【实证】** 的，都有 `07-证据/raw/` 的 grep 原文可查；标注 **【推断】** 的是我根据现象反推的设计建议，DSH 读到不要当成 WorkBuddy 的真实实现。
- 版本号 5.8.3，升级后路径和枚举可能变。重新核对的方法见 `07-证据/README.md`。
