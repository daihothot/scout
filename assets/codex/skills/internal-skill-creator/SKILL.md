---
assetKind: scout.skill
name: internal-skill-creator
description: 创建或修改 Scout Skill 时规范 identity、type、layout、phase、family、依赖、resources 和职责归属。
id: internal-skill-creator
version: 1.0.0
phase: []
family: [internal, skill-creator]
tags: [scout, skill, asset, template, governance]
devices: [any]
dependencies:
  skills:
    required: [internal-skill-consumption]
  shellTools:
    required: [scoutAssets]
    optional: [rg, find, sed, cat]
summary: 规范 Scout Skill 的作者分类、正文布局、文件系统投影、依赖与资源结构。
---

# Internal Skill Creator

当任务要求创建、修改、评审或规范化 `assets/codex/skills/**/SKILL.md` 时使用本技能。

本技能拥有 Scout Skill 资产格式和职责治理。它不定义 Scout Runtime 事件、领域业务事实、具体工具实现或当前 `run` 状态。

- `Skill type` 表示一个 Skill 拥有的责任种类。
- `Skill layout` 表示 `SKILL.md` 正文组织规则的方式。

## Document Notation

以下记法适用于目标 `SKILL.md` 及其 supplementary resources：

- 反引号中的内容表示 Scout 正式术语、字面值或单一路径。
- `<name>` 表示创建 Skill 时必须使用当前上下文中的实际值替换的占位符。
- 定义一个名称时使用不带 `<>` 的名称；定义完成后，只有表示待替换值时才使用 `<name>`。
- 可执行命令、多行路径、目录结构、schema 和命名形式使用带语言标记的 fenced code block。

## Skill Type

- type: internal
- layout: workflow
- note: 规范 Skill 源资产、分类、布局和作者声明，不实现 Skill 消费协议。

## Core Use

使用本技能处理：

- 创建、修改、评审或规范化 Scout Skill 及其 supplementary resources。
- 判断内容应属于 AGENTS、Domain Skill、Tool Skill、Single Skill、Internal Skill、template 还是 reference。
- 为一个 Skill 独立选择 type 与 layout，并按当前资产和 Runtime 事实验证结果。

## Skill Authoring Model

- `type template` 规定一种 Skill type 必须表达的内容、责任归属和禁止越界的内容。
- `layout template` 规定一种 Skill layout 的正文结构、章节顺序和格式。

每个 Skill 必须选择一个 type：

| type | 拥有的责任 |
| --- | --- |
| `internal` | Scout 自有资产、运行边界和治理规则。 |
| `domain` | 当前 domain 中当前 role 的业务输入、判断、工作、输出和交接。 |
| `tool` | 一种操作能力的调用方式、输入、结果、副作用和失败边界。 |
| `single` | 一个稳定、可组合的领域 contract。 |

每个 Skill 必须选择一个 layout：

| layout | 使用条件 |
| --- | --- |
| `workflow` | contract 包含必须按顺序执行的阶段、状态转换或完成门禁。 |
| `compact` | contract 可以通过模型、规则和边界直接表达，不需要编号执行阶段。 |

type 与 layout 相互独立。同一种 type 可以根据自己的 contract 选择任一 layout；不能根据 type、family 或名称自动推断 layout。

## Source and Mount Model

Skill 源目录固定为：

```text
assets/codex/skills/<skill-name>/SKILL.md
```

Scout Runtime 根据当前 `phase` 选择 Skill，并将 Skill 目录物化为：

```text
<family-path>/<skill-name>/SKILL.md
```

规则：

- `phase` 是 Scout Runtime 的最小资源投影单位；Skill frontmatter 中的 `phase` 声明该 Skill 进入哪些资源投影。
- `family` 是必填的稳定分类路径，直接决定 `mount` 中的文件夹，不是交互式发现入口、执行顺序或授权状态。
- 当前 `phase` 声明的 Skill 会被物化；它们的 `dependencies.skills.required` 递归加入同一投影，并按依赖关系验证。
- 当前 `role` 使用普通文件系统定位和读取 Skill；Skill 的完整读取、依赖展开、composition 和开始执行条件由 `internal-skill-consumption` 定义。
- Skill 不放入 `.agents/skills`，避免与 Codex 原生全局 Skill 混合；Scout Skill 只从 `.scout/skill` 使用。
- 物化路径可以是软链接；逻辑路径与 canonical target 必须同时符合当前权限。

源码资产维护发生在 Scout checkout；`role` 运行时只使用当前 `mount` 的 `.scout/skill`。

## Responsibility Placement

- 全部 `role`、全部 domain 都适用的稳定规则放在全局 `AGENTS.md`。
- 一个 domain 中各 `role` 的业务约束放在对应 Domain Skill。
- 每个 Dynamic Tool 必须拥有独立 Tool Skill；Domain Skill 根据当前工作需要提供对应 Tool Skill 的入口。
- template 与 reference 只拥有自己服务的结构或资料，不复制所属 Skill 的完整方法论。

## Directory Structure

新建 Skill 时，目录名、`name` 和 `id` 必须完全一致：

```text
assets/codex/skills/<skill-name>/
  SKILL.md
  templates/                 # 可选
  references/                # 可选
```

`skill-name` 使用小写字母、数字和连字符，并表达稳定责任：

- `responsibility` 表示 Domain Skill 拥有的实际稳定责任。
- `provider` 表示提供 Tool 操作能力的实际来源。
- `tool-capability` 表示 Tool Skill 拥有的实际稳定操作能力。
- `internal-capability` 表示 Internal Skill 拥有的实际稳定治理能力。

```text
domain-<domain>-<responsibility>
tool-<provider>-<tool-capability>
internal-<internal-capability>
```

- 第一种命名形式用于 Domain Skill。
- 第二种命名形式用于 Tool Skill。
- 第三种命名形式用于 Internal Skill。
- Single Skill 使用所属 Domain Skill 定义的稳定领域命名；存在 composition 时，identity 命名和依赖方向必须遵守 `internal-skill-consumption`。

不要使用空格、下划线、版本号、issue id、run id、一次性任务名或 `helper`、`tools` 一类宽泛名称。

## Frontmatter Contract

所有 Skill 使用下列 frontmatter 骨架：

- `skill-description` 表示 Skill 的实际触发场景和主要职责。
- `family-segment` 表示 `family` 中一个实际目录名。
- `tag` 表示一个实际稳定特征。
- `skill-summary` 表示实际短职责摘要。

```markdown
---
assetKind: scout.skill
name: <skill-name>
description: <skill-description>
id: <skill-name>
version: 0.1.0
phase: [<phase>]
family: [<family-segment>]
tags: [<tag>]
devices: [any]
summary: <skill-summary>
---
```

字段规则：

- `assetKind` 固定为 `scout.skill`。
- `name`、`id` 和目录名表达同一 canonical identity；重命名时同步修改全部显式引用，不保留 alias。
- `description` 说明触发场景和主要职责，不能塞入完整 workflow。
- `version` 使用语义版本；首次创建使用 `0.1.0`。
- `phase` 是必填 inline list；每个值必须是当前 Scout Runtime 定义的实际 phase，不维护固定枚举。`phase: []` 表示该 Skill 不进入任何 Runtime mount。
- `family` 是必填非空 inline list；每个 token 使用小写 kebab-case。
- `tags` 是必填非空 inline list，只表达稳定特征，不参与物化路径或筛选。
- `devices` 没有明确限制时使用 `[any]`。
- `summary` 是短职责摘要，不复制 description。

正文必须声明当前 type、layout 和责任边界。type 只能是 `internal`、`domain`、`tool` 或 `single`；layout 只能是 `workflow` 或 `compact`。具体章节、位置和格式由选定的 layout template 定义。

## Family Classification

family 表达文件系统分类和归属，不表达依赖、执行顺序或 layout：

- `domain-category` 表示 Domain Skill 在所属 domain 中的实际稳定分类。
- `domain-defined-segment` 表示所属 Domain Skill 为 Single Skill 定义的一个实际后续目录名。
- `tool-category` 表示 provider 下一个稳定的 Tool 文件系统分类。
- `internal-category` 表示一个稳定的 Scout 内部治理分类。

```text
[<domain>, <domain-category>]
[<domain>, single]
[tool, <provider>]
[tool, <provider>, <tool-category>]
[internal, <internal-category>]
```

- Domain Skill 的 family 必须以 `<domain>` 开始，并使用所属 domain 定义的稳定分类路径。
- Single Skill 的 family 必须以 `[<domain>, single]` 开始；后续追加一个或多个 `<domain-defined-segment>`，其业务含义由所属 Domain Skill 定义。
- Tool Skill 的 family 必须以 `tool/<provider>` 开始；存在稳定子分类时追加 `<tool-category>`。
- Internal Skill 的 family 必须以 `internal` 开始。
- 同一 family 可以包含多个 Skill；它们物化为该目录下以 Skill identity 命名的兄弟目录。
- family 中的目录名恰好与某个 layout 同名时，也不建立自动推导关系。

## Dependencies

只有真实依赖存在时才写 `dependencies`：

- `skills` 使用真实 Skill identity。
- `shellTools` 使用 `assets/codex/tools/shell-tools.json` 中的 tool id。
- `mcpServers` 使用 `assets/codex/mcp/servers.json` 中的 server id。
- `plugins` 使用 plugin manifest 中的 name。
- `required` 表示缺失时 contract 无法完整执行；`optional` 只表示条件能力或增强能力。
- required Skill 的 phase 必须覆盖消费方的全部 phase，依赖图必须无环。
- 依赖只表达“使用当前 Skill 必须同时具备什么”，不能用来偷渡其它层的方法论。
- derived、implementation 或其它 composition 的 identity、required dependency 和消费规则遵守 `internal-skill-consumption`；本技能不复制第二套 composition 协议。

## Supplementary Resources

`templates/**/*.md` 与 `references/**/*.md` 必须在自己的 frontmatter 声明：

```yaml
scout:
  resource:
    requirement: <requirement>
    description: <resource-purpose>
```

- `<requirement>` 只允许使用 `required` 或 `optional`。
- required resource 是 Skill contract 的无条件组成部分。
- optional resource 只服务正文明确指出的条件分支；description 必须让读者无需打开正文即可判断用途。
- resource-level required / optional 与 Skill dependency 是不同层次，不得合并或移除。
- `scout.resource` 是资源控制 metadata，使用模板生成业务 artifact 时不得复制。
- `templates/` 超过一个文件时创建 `templates/template-index.md`；`references/` 存在文件时创建 `references/reference-index.md`。
- index 只做文件用途和读取顺序导航，不承载业务事实、运行状态或当前 `<task>` 判断。

index 自身必须是 required supplementary resource，并使用以下最小结构：

- `index-title` 表示实际索引标题，使用 `Template Index` 或 `Reference Index`。
- `index-purpose` 表示索引服务的实际 Skill 和资源范围。
- `resource-path` 表示一个实际 supplementary resource 路径。
- `resource-purpose` 表示该资源的实际用途。
- `read-condition` 表示 `required`，或一个能够判断 optional resource 是否适用的实际条件。
- `required-order-or-condition` 表示 required resources 的实际读取顺序，或 optional resource 的实际进入条件。
- `index-maintenance-rule` 表示资源新增、重命名或职责变化时必须同步执行的一项维护规则。

```markdown
# <index-title>

## Purpose

<index-purpose>

## Resource List

| resource | purpose | reading condition |
| --- | --- | --- |
| <resource-path> | <resource-purpose> | <read-condition> |

## Reading Order

<required-order-or-condition>

## Maintenance Rules

- <index-maintenance-rule>
```

没有跨资源顺序时删除 `Reading Order`；`Resource List` 必须登记 index 自身以及同目录全部 Markdown resources。

## Template Application

- `templates/template-index.md` 是 required supplementary resource，定义当前可用的 type templates、layout templates 和读取顺序。
- 创建或重写一个 Skill 时，必须读取一个匹配实际责任的 type template 和一个匹配正文组织方式的 layout template。
- type template 与 layout template 同时生效；不能只选一个，也不能用其中一个推断另一个。
- type template 提供必须写入的内容和责任边界；layout template 提供包括 `Skill Type` 在内的完整正文结构。
- 将 type template 要求的内容放入选定 layout 的对应位置；不能把两个模板当作两套章节骨架拼接。
- Skill 完成后必须删除 layout 中的填写说明、空章节和不适用的可选段落。

## Workflow Overview

- Phase 1：确认目标对象的责任归属，选择 Skill type 和 layout。
- Phase 2：读取对应模板并建立 Skill identity、frontmatter、依赖和正文结构。
- Phase 3：检查 supplementary resources、引用和职责边界。
- Phase 4：验证源码资产、Runtime 物化和必要的 role 行为。

## Phase 1: Classify Responsibility And Layout
---

1. 根据责任归属判断目标应是 AGENTS、Skill、template 还是 reference。
2. 确定为 Skill 后，根据实际责任选择一个 type。
3. 判断 contract 是否包含必须按顺序执行的阶段、状态转换或完成门禁，选择一个 layout。

Exit：

- 目标对象的所有者、type 和 layout 已唯一确定。

Blocked：

- 一段内容无法确定所有者，或同时需要两个 type 或两个 layout。

Partial：

- `none`；责任和布局没有收敛时不得开始写入。

## Phase 2: Author Skill Contract
---

1. 完整读取 `templates/template-index.md`、匹配的 type template 和 layout template。
2. 创建或更新 identity、frontmatter、依赖与正文。
3. 同时应用上级 Skill、type template 和 layout template，只写当前对象拥有的职责。

Exit：

- Skill 主文件符合选定 type 和 layout，所有作者占位符已替换。

Blocked：

- identity、phase、family、依赖或 contract 无法根据当前源码事实确认。

Partial：

- `none`；未确认内容不得用猜测或默认值补齐。

## Phase 3: Validate Resources And Boundaries
---

1. 检查 supplementary resource metadata、index 和正文引用。
2. 检查 AGENTS、各 Skill type、template 和 reference 之间是否存在职责复制或越界。
3. 检查 required dependencies、composition 声明和资源读取条件是否完整。

Exit：

- 所有资源可按声明读取，引用有效，职责边界没有冲突。

Blocked：

- required resource、required Skill、显式引用或责任所有者无法确认。

Partial：

- 不依赖缺失内容的独立范围可以保留；受影响 contract 不得声明完成。

## Phase 4: Verify Materialization And Behavior
---

1. 运行 build 与相关 asset-store 或 materialization 测试，确认各 phase 的目录投影和权限。
2. 对 role 行为敏感的改动启动真实 `run`，观察实际读取顺序和执行行为。

在 Scout checkout 中检查源码资产：

```sh
find assets/codex/skills -maxdepth 2 -name SKILL.md -print
sed -n '1,40p' assets/codex/skills/<skill-name>/SKILL.md
```

只有当前工作目录是 Runtime 为当前 `role` 生成的 `mount`，并且其中存在 `mount-manifest.json` 时，才检查当前物化结果：

```sh
scout-assets skills
```

Exit：

- 必需的源码、物化和行为验证均已通过，或不适用项已明确说明。

Blocked：

- build、资源物化、权限或真实行为与 contract 不一致。

Partial：

- 无法执行的验证必须说明原因和剩余风险，不能声明对应行为已经验证。

## Workflow Exit Rules (Enforcement)

- XR-001：Phase 1 未完成时不得创建或修改 Skill 内容。
- XR-002：Phase 2 和 Phase 3 未完成时不得声明作者 contract 完整。
- XR-003：Phase 4 发现源码、物化或行为不一致时，不得用文档结论覆盖运行事实。

## Failure Rules (Enforcement)

- FR-001：build、资源校验、物化测试或真实行为验证失败时，必须保留实际失败入口和受影响范围，不得声明对应 authoring contract 已验证。

## Blocking Rules (Enforcement)

- BR-001：内容所有者、Skill type 或 layout 无法唯一确定时，阻塞目标 Skill 写入。
- BR-002：identity、phase、family、required dependency 或 resource requirement 无法从当前事实确认时，阻塞受影响 contract。

## Retry Rules (Enforcement)

- RR-001：只有源码、资源、输入或环境发生能够影响失败结果的实际变化后，才重新执行对应验证；不得重复运行同一失败路径制造成功。

## Prohibited Rules (Enforcement)

- PR-001：禁止用名称、family、phase、旧文档或模型记忆猜测责任、依赖或 composition。
- PR-002：禁止在本技能或 type/layout template 中复制 `internal-skill-consumption` 的读取和 composition 算法。
- PR-003：禁止把 type template 和 layout template 拼成两套并列正文结构。

## Checklist

- `name`、`id`、目录名唯一且一致，所有引用均指向当前 identity。
- `type` 是四种合法值之一，`layout` 是两种合法值之一，且二者来自独立判断。
- `phase` 使用当前 Scout Runtime 的实际值并覆盖真实资源投影，不依赖固定枚举。
- `family` 必填、分类正确，生成路径符合 `<family-path>/<skill-name>/SKILL.md`。
- required Skill 存在、覆盖 phase 且依赖无环。
- required / optional resource metadata 完整，正文适用条件与 metadata 一致。
- AGENTS、Domain Skill、Tool Skill、Single Skill、Internal Skill、template 和 reference 的责任没有交叉复制。
- Dynamic Tool 拥有独立 Tool Skill，Tool Skill 在该工具所有可用 phase 中可见。
- Domain Skill 拥有所属 domain 和 role 的 Single Skill 集合与消费规则；Single Skill 不拥有集合选择。
- Skill 的读取与 composition 规则引用 `internal-skill-consumption`，不复制其通用算法。
- 当前 phase 的真实 mount 只包含应见 Skill，并且逻辑路径和 canonical target 权限都正确。
