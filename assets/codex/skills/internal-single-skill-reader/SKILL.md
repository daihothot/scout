---
assetKind: scout.skill
name: internal-single-skill-reader
description: 在领域 Skill 指定的 Single 根目录中完整读取通用 Single，并在选择某个 capability 后完整读取该 capability 的全部 Single 时使用。
id: internal-single-skill-reader
version: 1.0.0
phase: [research, verify, validate]
family: [internal, single-skill-reader]
tags: [scout, single, filesystem, completeness]
devices: [any]
dependencies:
  shellTools:
    optional: [find, sort, cat, sed, rg]
summary: 规定基于文件系统枚举的通用 Single 与已选 capability Single 完整读取规则。
---

# Internal Single Skill Reader

当领域 Skill 要求消费 Single 时，使用本技能完成目录枚举和完整读取。

本技能只拥有跨领域通用的读取机制。Single 根目录、capability 的业务含义、选择条件以及读取后的领域用途，均由调用它的领域 Skill 定义。

## Skill Type

- type: internal
- structure_level: compact
- note: 本技能保证一次 Single 集合消费的完整性，不判断 Single 是否适用于业务，也不记录 coverage。

## Filesystem Model

- 当前 phase 可见的 Skill 已物化在 `.scout/skill/<family...>/<skill-name>/SKILL.md`。
- 领域 Skill 必须给出本领域的 Single 根目录，以及其中哪一级表示通用集合、哪一级表示 capability。
- 一个集合以目录为边界；集合中的每个直接或递归 `SKILL.md` 都属于该集合。
- frontmatter `dependencies.skills.required` 指向的 Skill 与 required supplementary resources 仍是被选 Skill 的组成部分。

## Complete Read Procedure

1. 先读取调用方领域 Skill，取得 Single 根目录、环境分支和 capability 选择规则。
2. 在开始领域调查、采集或检查前，使用 `find -L <single-root> -type f -name SKILL.md -print | sort` 递归枚举通用集合中的全部 `SKILL.md`，固定本次文件清单；`-L` 必须保留，因为 mount 中的 Single 叶子可能是软链接。
3. 逐一完整读取清单中的 `SKILL.md`、其 required Skill 依赖和 required supplementary resources；不得因为名称、摘要或先验判断跳过其中任意项。
4. 根据领域输入选择 capability。没有选择 capability 时不得预读任意 capability 集合；一旦选择某个 capability，先使用同一 `find -L ... | sort` 递归枚举该目录并完整读取其中全部 Single，再执行依赖它的领域动作。
5. capability 改变或任务范围明确增加新的 capability 时，对新增 capability 重复完整枚举与读取；已经完整读取且文件未变化的集合无需重复读取。

## Completion Rules

- 完整性以开始读取前固定的目录清单为准，不依赖记忆、名称猜测或抽样。
- 读取顺序遵守每个 Skill 声明的 required Skill 依赖；无依赖关系的文件可以并行读取。
- optional resource 只在当前任务确实需要时读取，不影响集合的完整读取成立。
- 任一 `SKILL.md`、required Skill 或 required resource 不可读时，相关集合未完成；按调用方领域 Skill 报告阻塞或受影响范围。
- 本技能不要求生成 applicability、coverage、selection、receipt 或其它运行记录。
