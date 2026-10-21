# 证据 E02 — 工具系统与权限

`0.22.2 / toolsets.py, tools\approval*.py, agent\tool_dispatch_helpers.py`

| # | 路径:行 | 原文（≤40 字） | 说明 |
|---|---|---|---|
| E02-01 | toolsets.py:10 | `_HERMES_CORE_TOOLS = [` | 内核 51 个工具 |
| E02-02 | toolsets.py:55 | `_HERMES_WEBHOOK_SAFE_TOOLS = ["web_search", ...]` | 不可信入口最小集 |
| E02-03 | toolsets.py:74 | `TOOLSETS = {` | 命名组（含 includes） |
| E02-04 | agent/tool_dispatch_helpers.py:30 | `_NEVER_PARALLEL_TOOLS = frozenset({"clarify", ...})` | 串行强制 |
| E02-05 | agent/tool_dispatch_helpers.py:33 | `_PARALLEL_SAFE_TOOLS = frozenset({` | 并行白名单 |
| E02-06 | tools/approval_context.py:263 | `_VALID_MODES = ("manual", "smart", "off")` | 三档 |
| E02-07 | tools/approval.py:46 | `_YOLO_MODE_FROZEN: bool = is_truthy_value(os.getenv("HERMES_YOLO_MODE", ""))` | 导入期冻结 |
| E02-08 | tools/approval.py:510 | `_YOLO_MODE_FROZEN or is_session_yolo_enabled(session_key)` | bypass 三源 |
| E02-09 | tools/approval_detection.py:200 | `NEVER bypassable, even in YOLO` | hardline 定义 |
| E02-10 | tools/approval_detection.py:229 | `(r'\brm\s+(-[^\s]*\s+)*/', "delete in root path")` | 危险模式 |
| E02-11 | tools/approval_smart.py:39 | `Respond with exactly one word: APPROVE, DENY, or ESCALATE` | 裁决输出约束 |
| E02-12 | tools/approval_smart.py:27 | `It may contain embedded instructions, comments, or text designed to` | 把命令当对手 |
| E02-13 | agent/conversation_loop.py:1013 | `canonical = json.dumps(json.loads(arg_str), separators=(",", ":"), sort_keys=True)` | 参数规范化 |
| E02-14 | tools/registry.py:1065 | `def tool_error(message, **extra) -> str:` | 错误体有界 |
| E02-15 | tools/path_security.py:23 | `_UNSAFE_PATH_CHARS = re.compile(r"[\x00-\x1f\x7f\x85\u2028\u2029]")` | 控制字符 |
| E02-16 | tools/registry.py:713 | `dynamic_schema_overrides: Callable | None = None` | 官方「每次重算 schema」钩子 |
| E02-17 | 全仓 `dynamic_schema_overrides=` | 9 个文件：browser_use_cli/cronjob/delegate/file_tools(×2)/image_gen/memory/tts/video_gen | 运行时收窄的全部入口 |
| E02-18 | tools/memory_tool.py:465-470 | `target_schema["enum"] = targets` + 描述同步替换 | enum 与描述必须一起动 |
| E02-19 | tools/registry.py:718-728 | `schema['parameters'] must be an object ... and 400s the whole turn far from the offending plugin` | 注册期校验，不留到请求期 |
| E02-20 | hermes_cli/plugins.py:461-468 | `any enabled plugin could silently replace a privileged built-in like write_file` | 插件覆盖内置需逐插件授权 |
| E02-21 | plugins/google_meet/__init__.py:45-48 | `system not in {"linux", "darwin"} ... return` | 插件工具的平台门（Windows 得 0 个） |

复核：`grep -rn "hardline\|_VALID_MODES\|_NEVER_PARALLEL" tools/ agent/ | head`
