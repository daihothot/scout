---
assetKind: scout.skill
name: internal-skill-creator
description: 创建或修改 Scout Skill 时规范 identity、phase、family 文件系统分类、依赖、resources 和职责归属。
id: internal-skill-creator
version: 1.0.0
phase: []
family: [internal, skill-creator]
tags: [scout, skill, asset, template, governance]
devices: [any]
dependencies:
  shellTools:
    required: [scoutAssets]
    optional: [rg, find, sed, cat]
summary: 规范 Scout Skill 的文件系统投影、职责分类、依赖与资源结构。
---

# Internal Skill Creator

当任务要求创建、修改、评审或规范化 `assets/codex/skills/**/SKILL.md` 时使用本技能。

本技能拥有 Scout Skill 资产格式和职责治理。它不定义 Runtime 事件、领域业务事实、具体工具实现或当前 Run 状态。

## Skill Type

- type: internal
- structure_level: full
- note: 规范 Skill 源资产、phase 投影和 family 目录分类，不实现发现或读取协议。

## Source and Mount Model

Skill 源目录固定为：

```text
assets/codex/skills/<skill-name>/SKILL.md
```

Runtime 根据 profile `phase` 选择 Skill，并将 Skill 目录物化为：

```text
.scout/skill/<family...>/<skill-name>/SKILL.md
```

规则：

- `phase` 是顶层 process node 的环境投影条件，只决定哪些角色能看到 Skill。
- `family` 是必填的稳定类型路径，直接决定 mount 中的文件夹，不是交互式发现入口或授权状态。
- 当前 phase 声明的所有 Skill都会物化；它们的 `dependencies.skills.required` 递归加入同一投影，并按依赖关系验证。
- Agent 使用普通文件系统定位和读取 Skill；不存在 catalog、selection、receipt、reauthorization 或专用读取协议。
- Skill 不放入 `.agents/skills`，避免与 Codex 原生全局 Skill 混合；Scout Skill 只从 `.scout/skill` 使用。
- 物化路径可以是软链接；逻辑路径与 canonical target 必须同时符合当前权限。

## Responsibility Placement

- 全部角色、全部领域都适用的稳定规则放在全局 `AGENTS.md`。
- 同一 Worker 或同一角色跨领域适用的行为放在 Worker / Role AGENTS。
- 某领域中某角色的业务约束放在该 Role Domain Skill。
- 每个动态工具拥有独立 Tool Skill；跨领域动态工具由 Worker / Role AGENTS 带出，domain 注入工具也必须绑定独立 guidance Skill。
- shell tool、MCP 或 plugin 的完整操作方法放在对应 Tool Skill；动态工具 description 只保留工具是什么和主要用途。
- Signal 或其它 Single 只拥有一个稳定知识或实现 contract；完整集合消费规则放在通用 Internal Skill，何时消费和如何用于业务放在 Role Domain Skill。
- template 与 reference 只说明自己的适用范围和内容，不复制拥有者 Skill 的完整方法论。

## Directory Structure

新建 Skill 时，目录名、`name` 和 `id` 必须完全一致：

```text
assets/codex/skills/<skill-name>/
  SKILL.md
  templates/                 # 可选
  references/                # 可选
```

命名使用小写字母、数字和连字符，并以稳定责任为前缀：

- `domain-<domain>-<role-or-contract>`：Role Domain workflow 或领域产物 contract。
- `tool-<provider>-<capability>`：shell、MCP、plugin 或动态工具的操作 contract。
- `signal-<signal>[-<implementation>]`：Signal 接口或采集实现 Single。
- `internal-<capability>`：Scout 内部资产、边界和治理能力。

不要使用空格、下划线、版本号、issue id、run id、一次性任务名或 `helper`、`tools` 一类宽泛名称。

## Frontmatter Contract

所有 Skill 使用下列最小骨架：

```markdown
---
assetKind: scout.skill
name: <与目录名一致>
description: <做什么，以及什么场景使用>
id: <与目录名一致>
version: 0.1.0
phase: [<coordinate | research | verify | validate>]
family: [<稳定类型路径>]
tags: [<稳定特征>]
devices: [any]
summary: <简短职责摘要>
---
```

字段规则：

- `assetKind` 固定为 `scout.skill`。
- `name`、`id` 和目录名表达同一 canonical identity；重命名时同步修改全部显式引用，不保留 alias。
- `description` 说明触发场景和主要职责，不能塞入完整 workflow。
- `version` 使用语义版本；首次创建使用 `0.1.0`。
- `phase` 是必填 inline list，只允许 `coordinate`、`research`、`verify`、`validate`；`phase: []` 表示不进入任何 Runtime mount。
- `family` 是必填非空 inline list；每个 token 使用小写 kebab-case。
- `tags` 是必填非空 inline list，只表达稳定特征，不参与物化路径或筛选。
- `devices` 没有明确限制时使用 `[any]`。
- `summary` 是短职责摘要，不复制 description。

## Family Classification

使用 family 表达类型和归属，不表达执行顺序：

```text
[domain, <domain>, <platform-or-scope>, <role-or-contract>]
[domain, <domain>, <platform>, single, <availability>, general]
[domain, <domain>, <platform>, single, <availability>, <capability>]
[tool, <provider>, <capability>]
[internal, <capability>]
```

- Domain Skill 的路径必须能区分 domain、平台或稳定 scope，以及 role / contract。
- 通用 Single 与 capability Single 是同一 `single/<availability>/` 下的不同集合；具体 capability token 由所属 domain 定义。
- 同一 family 可以包含多个 Skill；它们物化为该目录下以 Skill identity 命名的兄弟目录。
- Tool 和 Internal Skill 使用自身责任分类，不伪装成 Domain Skill。
- 不在通用 Skill 中枚举具体 Single 名称、具体 capability 或某一领域的选择语义。

## Dependencies

只有真实依赖存在时才写 `dependencies`：

- `skills` 使用真实 Skill identity。
- `shellTools` 使用 `assets/codex/tools/shell-tools.json` 中的 tool id。
- `mcpServers` 使用 `assets/codex/mcp/servers.json` 中的 server id。
- `plugins` 使用 plugin manifest 中的 name。
- `required` 表示缺失时 contract 无法完整执行；`optional` 只表示条件能力或增强能力。
- required Skill 的 phase 必须覆盖消费方的全部 phase，依赖图必须无环。
- 依赖只表达“使用当前 Skill 必须同时具备什么”，不能用来偷渡其它层的方法论。

## Supplementary Resources

`templates/**/*.md` 与 `references/**/*.md` 必须在自己的 frontmatter 声明：

```yaml
scout:
  resource:
    requirement: required | optional
    description: <非空适用范围>
```

- required resource 是 Skill contract 的无条件组成部分。
- optional resource 只服务正文明确指出的条件分支；description 必须让读者无需打开正文即可判断用途。
- resource-level required / optional 与 Skill dependency 是不同层次，不得合并或移除。
- `scout.resource` 是资源控制 metadata，使用模板生成业务 artifact 时不得复制。
- `templates/` 超过一个文件时创建 `templates/template-index.md`；`references/` 存在文件时创建 `references/reference-index.md`。
- index 只做文件用途和读取顺序导航，不承载业务事实、运行状态或当前 task 判断。

## Single Rules

- Single 的 phase 决定哪个角色看到接口或实现；例如探索角色只看到接口 contract，采集和检查角色可同时看到接口与实现。
- 接口与实现通过 `dependencies.skills.required` 表达直接依赖，不用名称约定代替依赖。
- 通用 Single 与 capability Single 的完整读取机制只由 `internal-single-skill-reader` 定义。
- Role Domain Skill 负责给出 Single 根目录、何时必须完成 general、如何从业务输入选择 capability，以及该角色如何消费接口或实现。
- 通用读取规则不得包含具体 Single identity、具体 Signal 名称或 domain 特例。
- 当前不创建 coverage、applicability、selection 或专用 Single finder 协议。

## Authoring Workflow

1. 读取当前目录的 AGENTS 与同责任 Skill，确认内容归属和真实重复。
2. 确认目标应属于 AGENTS、Role Domain Skill、Tool Skill、Single、Internal Skill、template 还是 reference。
3. 读取 `templates/template-index.md`，按主要责任选择一个类型模板。
4. 创建或更新 Skill identity、phase、family、依赖与正文；只写当前对象拥有的职责。
5. 检查 supplementary resource metadata 和 index。
6. 运行 build 与相关 asset-store / materialization 测试，确认各 phase 的目录投影和权限。
7. 对 Agent 行为敏感的改动启动真实 Run，观察它是否从 AGENTS 进入 Domain / Tool Skill，并按 Domain 规则消费 Single。

## Validation Checklist

- `name`、`id`、目录名唯一且一致，所有引用均指向当前 identity。
- `phase` 合法并覆盖真实生产、消费和检查角色。
- `family` 必填、分类正确，生成路径符合 `.scout/skill/<family...>/<name>/SKILL.md`。
- required Skill 存在、覆盖 phase 且依赖无环。
- required / optional resource metadata 完整，正文适用条件与 metadata 一致。
- AGENTS、Domain、Tool、Single、Internal、template 和 reference 的责任没有交叉复制。
- 动态工具拥有独立 guidance Skill，Tool Skill 在该工具所有可用 phase 中可见。
- Role Domain Skill 只定义本领域本角色规则；Single 完整读取机制引用 Internal Skill，不复制其通用算法。
- 没有旧 catalog、Find/Read tool、selection、coverage、legacy alias、fallback 或迁移门禁。
- 当前 phase 的真实 mount 只包含应见 Skill，并且逻辑路径和 canonical target 权限都正确。

## Minimal Inspection

```sh
find assets/codex/skills -maxdepth 2 -name SKILL.md -print
sed -n '1,40p' assets/codex/skills/<skill-name>/SKILL.md
scout-assets skills
```

源码资产维护发生在 Scout checkout；Agent 运行时只使用当前 mount 的 `.scout/skill`。
