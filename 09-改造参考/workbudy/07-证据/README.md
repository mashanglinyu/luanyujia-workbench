# 证据与复现方法

## 一、raw/ 目录里是什么

都是对 `cli/dist/codebuddy-lite-wb.mjs`（9.48MB，rspack 压缩）做关键词定位后，**保留前后文原文**的片段。文件名对应机制：

| 文件 | 内容 |
|---|---|
| `hooks-context.txt` | PreToolUse 的调用链、`executePreToolUseHooks` 签名、拒绝分支 |
| `hook-events.txt` | Hook 事件枚举（PRE_TOOL_USE / POST_TOOL_USE / POST_TOOL_USE_FAILURE…） |
| `permission-modes.txt` | `parsePermissionMode()` 映射表全量；提示词注入检测正则 `eR` / `eP` |
| `tool-permission.txt` | `canUseTool` / 授权判定路径 |
| `skill-load.txt` | 技能加载 + PTC/Code Mode 提示词原文（含"不要 Glob 技能目录"这类约束） |
| `compact.txt` / `autocompact.txt` | 压缩策略与常量 |
| `system-reminder.txt` | `<system-reminder>` 注入点 |
| `config-settings.txt` | settings.json 相关逻辑 |
| `todo-tool.txt` | TodoWrite 相关 |

**读法**：这些是压缩后的代码，变量名是 `t` `i` `n` `s` 这种。看**字符串字面量和属性名**就能还原语义——比如 `executePreToolUseHooks`、`permissionDecision`、`modifiedInput` 都没被压缩。

## 二、自己重新核对的命令

### 2.1 解 asar 清单（不装 asar 工具）

```python
import json
p = r"<盘根>:/software/workbudy/WorkBuddy/resources/app.asar"
# asar 头部：前 16 字节是 pickle 头，JSON 从偏移 16 开始
# 长度字段在偏移 8（此文件为 3808521）
f = open(p, "rb"); f.seek(16)
obj = json.loads(f.read(3808521).decode("utf-8"))
print(list(obj["files"].keys()))
```

> 注意：长度不是固定的。通用写法是先读 `struct.unpack('<IIII', f.read(16))` 拿到第三个字段（JSON 长度），但有 7 字节对齐填充，所以更稳的是 `raw_decode` 而不是 `loads`：
> ```python
> import struct, json
> f=open(p,'rb'); _,size,jlen,_ = struct.unpack('<IIII', f.read(16))
> f.seek(12)
> raw = f.read(jlen).decode('utf-8', errors='ignore')
> obj, end = json.JSONDecoder().raw_decode(raw.lstrip('\x00'))
> ```

### 2.2 定位关键机制

```bash
cd "<盘根>:/software/workbudy/WorkBuddy/resources/app.asar.unpacked/cli/dist"

# 先数命中次数，判断值不值得挖
for k in "PreToolUse" "permissionMode" "SKILL.md" "compact" "TeamCreate"; do
  echo "$k: $(grep -o "$k" codebuddy-lite-wb.mjs | wc -l)"
done
```

```python
# 带上下文导出（比 grep -C 好用的地方：可以精确控制窗口大小并落盘）
import re
d = open("codebuddy-lite-wb.mjs", encoding="utf-8", errors="ignore").read()
kw = "executePreToolUseHooks"
for i, m in enumerate(re.finditer(re.escape(kw), d)):
    if i >= 3: break
    print(f"=== #{i} @{m.start()} ===")
    print(d[max(0, m.start()-800): m.start()+1200])
```

### 2.3 提取大写常量枚举（找协议值特别有效）

```python
import re
d = open("codebuddy-lite-wb.mjs", encoding="utf-8", errors="ignore").read()
cands = {m.group(1) for m in re.finditer(r'\b([A-Z][A-Z0-9]{3,}(?:_[A-Z0-9]+)+)\s*[=:]', d)}
print(sorted(c for c in cands if "TOOL" in c or "SESSION" in c))
```

这一招能直接捞出 `AUTO_COMPACT_WINDOW_MIN`、`COMPACTION_HEADER`、`TOOL_INPUT_MAX_SIZE` 这类常量名，再去搜名字就能找到用法。

## 三、升级后怎么复核

WorkBuddy 升级会换版本号、可能改路径。复核顺序：

1. **先看明文部分**（改得最少，价值最高）
   ```
   app.asar.unpacked/resources/plugins/workbuddy-builtin/
   ├── interactionmode/*/fragments/     ← 模式与工具白名单
   ├── hooks/*.cjs                      ← 审批闸门
   ├── mcps/*/.mcp.json                 ← 连接器声明
   ├── prompt-common/fragments/         ← 通用提示词
   └── skills/*/SKILL.md                ← 技能规范
   ```
2. **再确认 bundle 还在不在**：`cli/dist/codebuddy-lite-wb.mjs` 大小变了但路径一般不变
3. **重跑 2.2 的 grep**，看关键机制名有没有变（比如 `permissionDecision` 改成别的）

## 四、没挖到的东西（别浪费时间找）

| 想找 | 为什么找不到 |
|---|---|
| 混淆后的函数实现细节 | 变量名全压缩，且大量是内联的，反编译成本高于重写 |
| 渲染层源码 | 在 `app.asar/renderer/assets/` 里，是另一个 bundle，且用了大量框架，可读性极差 |
| 服务端逻辑 | 不在本地（`endpoint: https://www.workbuddy.cn`） |
| 积分/计费规则 | 服务端下发，本地只有 UI 文案 |
| 数据库 schema | 用 better-sqlite3，库文件在用户数据目录，不在安装目录 |
