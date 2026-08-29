---
assetKind: scout.skill
name: internal-skill-consumption
description: 读取一个 Scout Skill 时，确定还必须读取的关联 Skill 和附属文件，并在全部规则就绪后开始执行。
id: internal-skill-consumption
version: 1.0.0
phase: [Startup]
family: [internal, skill-consumption]
tags: [scout, skill, dependency, composition, contract]
devices: [any]
dependencies:
  shellTools:
    optional: [find, sort, cat, sed, rg]
summary: 确定 Skill 的完整读取范围、规则组合方式和开始执行条件。
---

# Internal Skill Consumption

使用本技能确定一个 Skill 必须读取哪些文件、这些文件如何共同约束当前工作，以及什么时候可以开始执行。

## Skill Type

- type: internal
- layout: workflow
- note: 本技能拥有 Scout Skill 读取、依赖展开、contract 组合和读取完成门禁，不拥有领域执行或产物交付责任。

## Workflow Overview

- `Skill identity` 是 Skill 使用的稳定名称；Skill 目录名以及入口文件顶部的 `name` 和 `id` 必须使用该名称。
- `target Skill` 是当前正在执行完整读取与 contract 组合的 Skill。
- `target-skill-name` 表示 target Skill 的实际 Skill identity。
- `target-skill-path` 表示 target Skill 的实际 `SKILL.md` 路径。
- `consumer contract` 是要求当前 `<role>` 读取并使用 target Skill 的 contract；它可以明确提供 related Skills 或额外 composition 要求。
- `related Skill` 是 consumer contract 明确要求与 `<target-skill-name>` 共同参与额外 composition 的 Skill。
- `related-skill-name` 和 `related-skill-path` 分别表示一个 related Skill 的实际 Skill identity 和实际 `SKILL.md` 路径。
- `complete contract` 是使用一个 Skill 时必须共同读取并生效的全部规则。

Phase 说明：

- Phase 1：确认目标 Skill 的名称、路径、当前可见性和直接依赖关系。
- Phase 2：完整读取目标 Skill、它自己的附属文件、递归依赖的全部 Skill，以及 consumer contract 明确提供的 related Skills。
- Phase 3：组合每个 complete contract 内部的 required contracts，并处理冲突或缺失依赖。
- Phase 4：按照 consumer contract 明确要求的关系，组合目标与 related contracts。
- Phase 5：汇总前述阶段结果，执行最终读取门禁。

## Phase 1: Resolve Skill Relationship
---

本阶段确认 `<target-skill-name>` 的稳定身份、当前可见性和直接依赖。

### Identity And Visibility

- `frontmatter` 是 Markdown 文件顶部由两行 `---` 包围的 YAML metadata。
- 读取 `<target-skill-path>` 时，确认它的 Skill identity 是 `<target-skill-name>`。
- Scout Runtime 只向当前 `<role>` 物化 frontmatter `phase` 包含当前 `phase` 的 Skill。
- 对于 Skill，frontmatter `phase` 只决定该 Skill 是否对当前 `<role>` 可见；`family` 只决定 Skill 在 `.scout/skill/` 下的分类路径。
- 两个 Skill 的 `phase` 或 `family` 相同，不表示它们存在依赖、继承或实现关系。

### Direct Required Skills

- `direct required Skill` 是当前 Skill 在 `dependencies.skills.required` 中直接列出的 Skill。
- `required-skill-name` 表示其中一个 direct required Skill 的实际 Skill identity。
- `required-skill-path` 表示该 direct required Skill 的实际 `SKILL.md` 路径。

Skill 之间的 direct required Skills 只由 `<target-skill-path>` frontmatter 中的以下结构表达：

```yaml
dependencies:
  skills:
    required: [<required-skill-name>]
```

- 每个 direct required Skill 可以继续拥有自己的 direct required Skills，因此不能只处理第一层。
- `required Skill closure` 是从 `<target-skill-name>` 出发，沿每一层 direct required Skill 递归得到的全部 Skill。
- `<target-skill-path>` 没有 `dependencies.skills.required` 时，它没有 direct required Skill，它的 required Skill closure 在这一层结束。
- `dependencies` 下的其它字段不建立 Skill 依赖关系。

### Required Skill Location

当 frontmatter 已给出 `<required-skill-name>` 但没有给出路径时，在当前 `.scout/skill/` 中定位它的入口：

```bash
find -L .scout/skill -type f -path '*/<required-skill-name>/SKILL.md' -print
```

`-L` 用于跟随 Scout Runtime mount 中的 Skill 软链接。后续 `find` 命令同样保留 `-L`。

| 命令结果 | 处理 |
| --- | --- |
| 一个入口 | 将实际入口路径记为 `<required-skill-path>`。 |
| 没有入口 | `<required-skill-name>` 不可读。 |
| 多个入口 | `<required-skill-name>` 无法唯一定位。 |

注意事项：

- 不能凭名称相似度从多个入口中选择文件。
- direct required Skills 按 `<target-skill-path>` frontmatter 中的声明顺序处理。

Exit：

- `<target-skill-path>` 的 Skill identity 已确认为 `<target-skill-name>`。
- 每个 `<required-skill-name>` 均已得到唯一 `<required-skill-path>`，或当前层没有 direct required Skill。

Blocked：

- `<target-skill-name>` 与 `<target-skill-path>` 的 identity 不一致。
- 任一 `<required-skill-name>` 没有入口或存在多个入口。

Partial：

- `none`；Skill relationship 不完整时不得进入 Phase 2。

## Phase 2: Read All Required Rules
---

本阶段使用 Phase 1 确认的关系，完整读取 `<target-skill-name>` 及其 required Skill closure，形成它的 complete contract。

### Complete File Read

- “完整读取一个文件”表示从第一行读取到文件结尾。
- `file-path` 表示当前要读取文件的实际路径。
- 只查看 frontmatter、标题、摘要、搜索命中行或文件开头不算完整读取。

读取整个文件：

```bash
cat <file-path>
```

如果一次输出被截断，`start-line` 和 `end-line` 分别表示当前连续读取区间的实际起止行号。使用连续且不重叠的行区间继续读取，直到文件结尾：

```bash
sed -n '<start-line>,<end-line>p' <file-path>
```

后续阶段中的“完整读取”都使用这个含义。

### Target Entry And Skill Directory

1. 完整读取 `<target-skill-path>`，取得它自己的 contract 和 direct required Skills。
2. 将包含该 Skill 的 `SKILL.md` 以及该 Skill 自有文件的目录作为 `Skill directory`。
3. `skill-directory` 表示 `<target-skill-path>` 所在目录的实际路径。

### Supplementary Resources

- `supplementary resource` 是位于 `<skill-directory>` 的 `templates/` 或 `references/` 中，并通过自己的 frontmatter 声明读取条件的 Markdown 文件。
- `supplementary-resource-directory` 表示其中一个实际存在的目录。

检查 `<skill-directory>` 中是否存在以下目录：

```text
<skill-directory>/templates/
<skill-directory>/references/
```

递归枚举每个 `<supplementary-resource-directory>` 中的 Markdown 文件：

```bash
find -L <supplementary-resource-directory> -type f -name '*.md' -print | sort
```

- `supplementary-resource-path` 表示命令返回的一个实际文件路径。
- `requirement` 表示该文件声明的实际读取要求。
- `resource-purpose` 表示该文件声明的实际用途和适用条件。

读取每个 `<supplementary-resource-path>` 的 frontmatter：

```yaml
scout:
  resource:
    requirement: <requirement>
    description: <resource-purpose>
```

`<requirement>` 只允许使用 `required` 或 `optional`：

| `<requirement>` | 文件关系 | 读取规则 |
| --- | --- | --- |
| `required` | `required supplementary resource` | 必须完整读取。 |
| `optional` | `optional supplementary resource` | 根据 `<resource-purpose>` 判断当前工作是否进入它服务的条件分支；进入时完整读取，不进入时不读取。 |

### Required Skill Closure

完成 `<skill-directory>` 的 supplementary resources 后：

1. 按 `<target-skill-path>` frontmatter 中的顺序处理每个 `<required-skill-name>`。
2. 将 `<target-skill-name>` 和 `<target-skill-path>` 分别替换为 `<required-skill-name>` 和 `<required-skill-path>`。
3. 递归层只形成当前 required Skill 的 complete contract，不携带外层 consumer contract 提供的 related Skills 或额外 composition；依次重新执行 Phase 1 和 Phase 2。
4. 递归完成后，恢复上层的 `<target-skill-name>` 和 `<target-skill-path>`。

递归读取时分别记录正在读取和已经完成的 Skill identities：

- 下一个 direct required Skill 已经处于当前尚未完成的递归链中，表示依赖形成循环；停止读取并报告完整循环链。
- 下一个 direct required Skill 已经在当前 `<role>` 上下文中完整读取，且 Scout Runtime 没有报告其内容变化时，复用已完成结果，不重复读取。
- 无法确认是否完整读取或内容是否变化时，重新执行 Phase 2。

两种 required 关系不能相互替代：

| 关系 | 所属边界 |
| --- | --- |
| `required supplementary resource` | 所属 Skill 的内部组成部分。 |
| `direct required Skill` | 独立 Skill 之间的依赖。 |

### Complete Contract

complete contract 由以下内容共同形成：

- `<target-skill-path>` 中的 contract。
- required Skill closure 中全部 `SKILL.md` 的 contract。
- 上述每个 Skill 的全部 required supplementary resources。
- 当前条件分支适用的 optional supplementary resources。

complete contract 不是一个新文件。以上内容全部读取完成后，把它们共同用于当前工作。

### Related Skill Contracts

- consumer contract 没有明确提供 related Skills 时，跳过本节。
- related Skills 必须由 consumer contract 明确提供；本阶段不扫描目录、family 或同类名称自行发现。
- 每个 `<related-skill-name>` 和 `<related-skill-path>` 必须指向同一个唯一可读 Skill。

consumer contract 明确提供 related Skills 时，按声明顺序处理每一个成员：

1. 将 `<target-skill-name>` 和 `<target-skill-path>` 分别替换为 `<related-skill-name>` 和 `<related-skill-path>`。
2. 只携带当前 related Skill 自己的 identity 和路径，依次执行 Phase 1 和 Phase 2；不能把外层 related Skills 自动传入内层。
3. 记录该 related Skill 的 complete contract。
4. 恢复上层的 `<target-skill-name>` 和 `<target-skill-path>`。

related Skill 已在当前 `<role>` 上下文中完整读取且内容未变化时，按照本阶段的复用规则使用已有 complete contract，不重复读取。

Exit：

- `<target-skill-path>`、required Skill closure、全部 required supplementary resources 和适用 optional supplementary resources 已完整读取。
- `<target-skill-name>` 的 complete contract 已形成。
- consumer contract 明确提供 related Skills 时，每个 related Skill 的 complete contract 已形成。

Blocked：

- 任一 required Skill 或 required supplementary resource 不可读。
- required Skill closure 存在循环依赖。
- 任一 related Skill 的 identity、路径或 complete contract 无法确认。

Partial：

- 缺失内容所影响的 contract 不得用于工作；不依赖该 contract 的其它范围可以继续。

## Phase 3: Compose Required Contracts
---

本阶段使用 Phase 2 形成的 complete contracts，组合每个 Skill 自己声明的 required Skill closure。

- `required composition` 表示一个 Skill 的 contract 与它的 required Skill closure 共同生效，不是从中选择一个。
- `extension` 或 `inheritance` 表示一个 contract 明确保留另一个 required contract，并在其基础上增加或收窄语义。
- direct required 只建立 required composition；没有明确的增加或收窄语义时，不得仅凭依赖方向认定 extension 或 inheritance。
- 同级 required Skills 没有隐含优先级。

按以下顺序处理 `<target-skill-name>` 和每个 related Skill：

1. 将当前 Skill 自己的 contract 与 required Skill closure 中的全部 contracts 组合为同时生效的规则集合。
2. 确认 required supplementary resources 和适用 optional supplementary resources 已包含在对应 complete contract 中。
3. 多个 contract 无法同时满足时，停止依赖冲突规则的工作，并指出发生冲突的 Skill identities 和规则。

Exit：

- `<target-skill-name>` 及每个 related Skill 的 required composition 已完成，不存在未知缺口或未解决冲突。

Blocked：

- 任一 required Skill、required supplementary resource 或传递依赖缺失或不可读。
- required contracts 之间存在无法同时满足的规则。

Partial：

- 只停止依赖缺失或冲突 contract 的工作范围；不依赖该 contract 的其它范围可以继续。

## Phase 4: Resolve Declared Composition
---

- `composition scope` 由 `<target-skill-name>`、consumer contract 明确提供的 related Skills，以及它们各自的 required Skill closure 组成；其中每个 Skill 都必须已经完成 Phase 1 至 Phase 3。
- `contract owner` 是在自己的 `SKILL.md` 中声明某个 contract 的 Skill。
- 本阶段只处理 consumer contract 明确要求解析的 composition；没有额外 composition 时跳过本阶段并进入 Phase 5。
- 本阶段不扫描目录、family 或相似名称扩大 composition scope。

### Contract Roles

| contract 角色 | 定义 |
| --- | --- |
| `interface contract` | 定义基础结果。 |
| `derived contract` | 基于 interface contract 的基础结果，定义更具体的结果。 |
| `implementation contract` | 规定通过什么机制产生另一个 contract 定义的结果。 |

以上名称表示 contract 在 composition 中承担的角色，不表示 Skill type。

### Derived Composition

- `derived-name` 表示 derived contract owner identity 中位于 `-by-<source>` 之前的实际名称。
- `source` 表示 derived contract 所依据来源的实际名称。
- `derived-owner-id` 表示 derived contract owner 的完整实际 Skill identity。
- `interface-owner-id` 表示 derived contract 所依据的 interface contract owner 的实际 Skill identity。

derived composition 的 owner identity 命名形式：

```text
<derived-name>-by-<source>
```

- `by-<source>` 表示该 contract 基于 interface contract 的基础结果定义更具体的结果。
- `<derived-owner-id>` 必须 direct required `<interface-owner-id>`。
- 没有该依赖时，不能仅凭名称认定 derived composition。
- `by` 只帮助识别可能存在的关系，不能替代 `dependencies.skills.required` 和 contract 语义。
- derived contract 只解释 interface contract 的结果，并且当前工作需要实际产生该结果时，使用该 interface contract 的 implementation contract。
- derived contract 需要额外输入、额外能力或不同实现过程时，必须拥有自己的 implementation composition。

### Implementation Composition

- `implementation mechanism` 是产生 contract 所定义结果时使用的具体方法或运行能力。
- `mechanism` 表示当前方法或能力的实际名称。
- `implemented-owner-id` 表示拥有待实现 contract 的实际 Skill identity。
- `implementation-owner-id` 表示 implementation contract owner 的实际 Skill identity。
- `implementation-dependency-id` 表示实现过程依赖的另一个实际 Skill identity。
- `implementation composition` 表示 implementation contract owner 通过 implementation mechanism 产生 `<implemented-owner-id>` 所定义的结果。

implementation composition 的 owner identity 命名形式：

```text
<implemented-owner-id>-via-<mechanism>
```

- `via-<mechanism>` 表示该 contract 通过一个具体机制产生 `<implemented-owner-id>` 所定义的结果。
- `<implementation-owner-id>` 必须 direct required `<implemented-owner-id>`。
- 实现过程存在其它 Skill 依赖时，这些依赖也必须在 required Skills 中。
- 没有 direct required `<implemented-owner-id>` 时，不能仅凭名称认定 implementation composition。
- `<implemented-owner-id>` 不反向 required 某个具体 implementation contract owner。

有效依赖方向：

```text
<derived-owner-id>
    └── required Skill ──> <interface-owner-id>

<implementation-owner-id>
    ├── required Skill ──> <implemented-owner-id>
    └── required Skill ──> <implementation-dependency-id>  【存在实际依赖时】
```

- 只从 composition scope 中选择已经完成 Phase 1 至 Phase 3 的 implementation contract。
- 根据 implementation contract 的环境前提和 consumer contract 选择适用实现；存在多个符合条件的 implementation contracts 时，不能仅凭名称或先验工具知识选择。
- implementation contract 不在 composition scope 中时，不得在本阶段补充读取。

Exit：

- consumer contract 没有要求额外 composition，已跳过本阶段；或
- consumer contract 要求的 derived composition 和 implementation composition 已确认。
- 当前工作需要 implementation mechanism 时，适用 implementation contract 已选中。

Blocked：

- 明确要求的 composition 缺少 contract、owner、required dependency，或者相关 Skill 尚未完整读取。
- 当前工作需要 implementation mechanism，但 composition scope 中没有满足环境和 consumer contract 要求的 implementation contract。

Partial：

- 未完成的 composition 不得用于工作；不依赖该 composition 的其它范围可以继续。

## Phase 5: Apply Readiness Gate
---

本阶段汇总 Phase 1 至 Phase 4 的结果。只有以下条件全部成立，才开始依赖 `<target-skill-name>` 的工作：

- `<target-skill-path>` 已完整读取。
- `<target-skill-name>` 和 required Skill closure 中每个 Skill 的 required supplementary resources 已完整读取。
- 当前条件分支适用的 optional supplementary resources 已完整读取。
- required Skill closure 已递归完成，没有未知、不可读或循环依赖。
- `<target-skill-name>` 和 required Skill closure 的 required composition 已完成，没有未解决冲突。
- consumer contract 明确提供 related Skills 时，每个 related Skill 已完成 Phase 1 至 Phase 3。
- consumer contract 要求额外 composition 时，Phase 4 已完成对应关系确认。
- 当前工作需要 implementation mechanism 时，适用 implementation contract 已选中。

Exit：

- 全部条件成立，开始依赖对应 complete contracts 的当前工作。

Blocked：

- 任一条件不成立，停止依赖对应 contract 或 composition 的工作并报告实际缺口。

Partial：

- 未通过门禁的 contract 或 composition 不得用于工作；不依赖它们的其它范围可以继续。

## Workflow Exit Rules (Enforcement)

- XR-001：Phase 1 和 Phase 2 未完成时，不得声明 `<target-skill-name>` 或 related Skill 的 complete contract 已形成。
- XR-002：Phase 3 存在未解决冲突或缺失依赖时，不得使用受影响 complete contract。
- XR-003：consumer contract 明确要求的 composition 未完成 Phase 4 时，不得使用该 composition。
- XR-004：只有 Phase 5 全部条件成立，才能开始依赖对应 complete contracts。

## Failure Rules (Enforcement)

- FR-001：文件输出被截断时，必须使用连续且不重叠的行区间继续读取到文件结尾。
- FR-002：路径不可读、identity 不一致、依赖循环或 contract 冲突时，必须报告实际 Skill identity、路径或循环链以及受影响范围。
- FR-003：声明的 composition 无法确认时，必须报告缺失的 owner、contract、dependency 或尚未完整读取的相关 Skill。

## Blocking Rules (Enforcement)

- BR-001：required Skill 没有唯一可读入口时，阻塞依赖它的工作。
- BR-002：required Skill closure 存在循环或 required supplementary resource 不可读时，阻塞受影响 complete contract。
- BR-003：related Skill 没有唯一可读 identity、路径或 complete contract 时，阻塞依赖它的 composition。
- BR-004：required contracts 存在未解决冲突时，阻塞受影响 complete contract。
- BR-005：当前工作需要 implementation mechanism，但没有满足当前环境和 consumer contract 要求的 implementation contract 时，阻塞依赖该实现的工作。

## Retry Rules (Enforcement)

- RR-001：Skill 已在当前 `<role>` 上下文中完整读取，且 Scout Runtime 没有报告内容变化时，复用已完成结果，不重复读取。
- RR-002：无法确认是否完整读取或内容是否变化时，重新执行 Phase 2。

## Prohibited Rules (Enforcement)

- PR-001：禁止使用模型记忆、名称猜测、相似 contract 或未声明的工具能力补齐读取缺口。
- PR-002：禁止根据相同 `phase` 或 `family` 推断 Skill 依赖、extension、inheritance、derived 或 implementation composition。
- PR-003：禁止仅凭 `by`、`via` 或名称相似度确认 composition。
- PR-004：禁止 `<implemented-owner-id>` 反向 required 某个具体 implementation contract owner。
- PR-005：禁止扫描或扩展 consumer contract 没有明确提供的 related Skills。

## Checklist

- `<target-skill-name>` 与 `<target-skill-path>` identity 一致且唯一可读。
- direct required Skills 与 required Skill closure 已按 frontmatter 顺序完整处理。
- required supplementary resources 和适用 optional supplementary resources 已完整读取。
- consumer contract 明确提供的 related Skills 均已形成 complete contract。
- 每个 complete contract 的 required composition 已完成，且不存在未解决冲突。
- consumer contract 明确要求的 derived 或 implementation composition 已确认真实 contract 和 required dependency。
- 当前工作需要 implementation mechanism 时，已从 composition scope 中选中适用 implementation contract。
- Phase 5 的最终读取门禁与 Workflow Exit Rules 一致。
