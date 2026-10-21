# 证据 E08 — 技能系统

`0.22.2 / skills\（58 个 SKILL.md）, agent\skill_utils.py, agent\prompt_builder.py`

| # | 路径:行 | 原文（≤40 字） | 说明 |
|---|---|---|---|
| E08-01 | skills/apple/apple-notes/SKILL.md:2 | `name: apple-notes` | frontmatter 起 |
| E08-02 | skills/apple/apple-notes/SKILL.md:9 | `platforms: [macos]` | 平台过滤 |
| E08-03 | skills/apple/apple-notes/SKILL.md:14 | `prerequisites:` | 命令依赖 |
| E08-04 | agent/skill_utils.py:721 | `_CONDITION_KEYS = ("fallback_for_toolsets", "requires_toolsets",` | 5 个路由条件 |
| E08-05 | agent/skill_utils.py:31 | `SKILL_SUPPORT_DIRS = frozenset(("references", "templates", "assets", "scripts"))` | 支撑目录 |
| E08-06 | agent/skill_utils.py:37 | `never scanned as standalone skills` | 支撑文件不当技能 |
| E08-07 | agent/skill_utils.py:389 | `TIER_PROJECT, TIER_LOCAL, TIER_CREATE_DIR, TIER_EXTERNAL = range(4)` | 四级优先级 |
| E08-08 | agent/skill_utils.py:393 | `AMBIGUOUS_SKILL_PREFIX = "Ambiguous skill name "` | 同级歧义拒绝 |
| E08-09 | agent/skill_utils.py:462 | `shadowed (a higher tier owns the name: hidden, warned once)` | 遮蔽语义 |
| E08-10 | agent/skill_utils.py:420 | `would let <root>/evil (name: github) shadow the real one` | 劫持面 |
| E08-11 | agent/prompt_builder.py:1251 | `Same-named skills resolve like skill_view: project > local > create_dir > external_dirs` | 索引同规则 |
| E08-12 | agent/prompt_builder.py:1253 | `demotes categories to a names-only line — nothing is ever hidden` | 模式只降级 |
| E08-13 | agent/system_prompt.py:304 | `if not any(name in agent.valid_tool_names for name in ['skills_list',` | 无工具则无索引 |
| E08-14 | agent/system_prompt.py:783 | `Skills are runtime-mutable, so the index leads the volatile band` | 索引位置理由 |
| E08-15 | .skills_prompt_snapshot.json | `{"version": 4, "manifest": {"apple\\apple-notes\\SKILL.md": [mtime, size, inode, ctime]` | 索引快照签名 |
| E08-16 | agent/skill_utils.py:266 | `def get_disabled_skill_names(platform: str | None = None)` | 按平台禁用 |
| E08-17 | agent/skill_utils.py:162 | `def skill_matches_environment(frontmatter: dict[str, Any]) -> bool:` | 环境条件 |
| E08-18 | agent/context_compressor.py:860 | `content lost in compression; reload with skill_view(name='` | 被摘后指针 |
| E08-19 | agent/prompt_builder.py:319 | `resolved once per agent lifecycle` | 钉住技能只解析一次 |

复核：`grep -n "TIER_\|AMBIGUOUS\|_CONDITION_KEYS" agent/skill_utils.py`
