---
assetKind: scout.skill
name: internal-skill-consumption
description: 读取一个 Scout Skill 时，确定还必须读取的关联 Skill 和附属文件，并在全部规则就绪后开始执行。
id: internal-skill-consumption
version: 1.0.0
type: internal
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
- `consumer contract` 是当前直接要求使用 target Skill 的上游 contract；它提供当前使用目的和约束，不拥有 target Skill 的路径、contract 角色或 implementation 候选。
- consumer contract 不是独立 asset；递归处理 Skill dependency 时，它就是直接依赖 target Skill 的 Skill contract。
- `complete contract` 是使用一个 Skill 时必须共同读取并生效的全部规则。

Phase 说明：

- Phase 1：确认目标 Skill 的名称、路径、当前可见性和直接依赖关系。
- Phase 2：完整读取目标 Skill、它自己的附属文件和递归依赖的全部 Skill。
- Phase 3：组合每个 complete contract 内部的 required contracts，并处理冲突或缺失依赖。
- Phase 4：根据 `by-<source>` 或 `via-<mechanism>` 解析并验证 target Skill 的 composition。
- Phase 5：汇总前述阶段结果，执行最终读取门禁。

## Phase 1: Resolve Skill Relationship
---

本阶段确认 `<target-skill-name>` 的稳定身份、当前可见性和直接依赖。

### Identity And Visibility

- `frontmatter` 是 Markdown 文件顶部由两行 `---` 包围的 YAML metadata。
- 当前 role 可消费的 Skill 范围是当前 `.scout/skill/` 中存在且可读的入口；不从这个范围之外推断或补充 Skill。
- 读取 `<target-skill-path>` 时，确认它的 Skill identity 是 `<target-skill-name>`。
- `family` 只决定 Skill 在 `.scout/skill/` 下的分类路径；相同 `family` 或 `type` 不表示依赖或 composition 关系。

### Direct Skill Dependencies

- `direct required Skill` 是当前 Skill 在 `dependencies.skills.required` 中直接列出的 Skill。
- `direct optional Skill` 是当前 Skill 在 `dependencies.skills.optional` 中直接列出的候选 Skill。
- `required-skill-name` 表示其中一个 direct required Skill 的实际 Skill identity。
- `required-skill-path` 表示该 direct required Skill 的实际 `SKILL.md` 路径。
- `optional-skill-name` 表示其中一个 direct optional Skill 的实际 Skill identity。
- `optional-skill-path` 表示被当前工作选中后，该 direct optional Skill 的实际 `SKILL.md` 路径。

Skill 之间的 direct required 和 direct optional Skills 只由 `<target-skill-path>` frontmatter 中的以下结构表达：

```yaml
dependencies:
  skills:
    required: [<required-skill-name>]
    optional: [<optional-skill-name>]
```

- 每个 direct required Skill 可以继续拥有自己的 direct required Skills，因此不能只处理第一层。
- `required Skill closure` 是从 `<target-skill-name>` 出发，沿每一层 direct required Skill 递归得到的全部依赖 Skill，不包含 `<target-skill-name>` 自身。
- 已存在的 direct optional Skills 作为当前可见的候选能力；当前环境没有某个 optional 候选时不阻塞基础 contract。只有 consumer contract 或当前任务的正式输入明确需要某个候选时，才将它选入当前 contract，并完整读取它自己的 Skill closure；不能仅凭名称、family 或相似性选择。
- `<target-skill-path>` 没有 `dependencies.skills.required` 时，它没有 direct required Skill，它的 required Skill closure 在这一层结束。
- `<target-skill-path>` 没有 `dependencies.skills.optional` 时，它没有 direct optional Skill。
- `dependencies` 下的其它字段不建立 Skill 依赖关系。

### Required Skill Location

当 frontmatter 已给出 `<required-skill-name>` 但没有给出路径时，在当前 role 的 mount 根目录执行以下命令，在 `.scout/skill/` 中定位它的入口：

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

本阶段使用 Phase 1 确认的关系，完整读取 `<target-skill-name>` 及其 required Skill closure，形成它的 complete contract；optional Skill 只有被当前工作选中时才加入 complete contract。

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
3. 将直接依赖当前 required Skill 的 Skill contract 作为当前 consumer contract，对该 required Skill 依次执行 Phase 1 至 Phase 5；不携带更外层的使用约束。
4. 递归完成后，恢复上层的 `<target-skill-name>` 和 `<target-skill-path>`。

递归读取时分别记录正在读取和已经完成的 Skill identities：

- 下一个 direct required Skill 已经处于当前尚未完成的递归链中，表示依赖形成循环；停止读取并报告完整循环链。
- 下一个 direct required Skill 的文件及其 required Skill closure 已经在当前 `<role>` 上下文中完整读取，且 Scout Runtime 没有报告内容变化时，可以复用这些基础读取结果，不重复读取文件。
- optional Skill 的选择、consumer contract 的适用条件和 composition 结果属于当前消费上下文；即使文件内容没有变化，也必须根据当前 consumer contract 和当前任务重新判断，不能直接复用其它消费上下文的 complete contract。
- 无法确认是否完整读取或内容是否变化时，重新执行 Phase 2。

### Selected Optional Skills

按 `<target-skill-path>` frontmatter 中的声明顺序处理 direct optional Skills：

1. 根据 consumer contract 的使用约束和当前任务的正式输入判断 `<optional-skill-name>` 是否适用。
2. 不适用时不读取，也不加入当前 complete contract。
3. 适用时，在当前 `.scout/skill/` 中按 `<optional-skill-name>` 定位唯一 `<optional-skill-path>`。
4. 将当前 target Skill contract 作为该 optional Skill 的 consumer contract，对它执行 Phase 1 至 Phase 5。
5. 将已形成的 optional Skill complete contract 加入当前条件分支。

未被选中的 optional Skill 缺失不阻塞基础 contract。已被选中的 optional Skill 不可读或无法唯一定位时，只阻塞依赖该候选的条件分支。

两种 required 关系不能相互替代：

| 关系 | 所属边界 |
| --- | --- |
| `required supplementary resource` | 所属 Skill 的内部组成部分。 |
| `direct required Skill` | 独立 Skill 之间的依赖。 |

### Complete Contract

complete contract 由以下内容共同形成：

- `<target-skill-path>` 中的 contract。
- required Skill closure 中全部 `SKILL.md` 的 contract。
- 当前条件分支选中的 optional Skills 及其 required Skill closure 的 contract。
- 上述每个 Skill 的全部 required supplementary resources。
- 当前条件分支适用的 optional supplementary resources。

complete contract 不是一个新文件。以上内容全部读取完成后，把它们共同用于当前工作。

Exit：

- `<target-skill-path>`、required Skill closure、选中的 optional Skills、全部 required supplementary resources 和适用 optional supplementary resources 已完整读取。
- `<target-skill-name>` 的 complete contract 已形成。

Blocked：

- 任一 required Skill 或 required supplementary resource 不可读。
- required Skill closure 存在循环依赖。
- 当前条件分支选中的 optional Skill 不可读、无法唯一定位或其 complete contract 无法形成。

Partial：

- 缺失内容所影响的 contract 不得用于工作；不依赖该 contract 的其它范围可以继续。

## Phase 3: Compose Required Contracts
---

本阶段使用 Phase 2 形成的 complete contracts，组合每个 Skill 自己声明的 required Skill closure。

- `required composition` 表示一个 Skill 的 contract 与它的 required Skill closure 共同生效，不是从中选择一个。
- direct required 只建立 required composition；derived 或 implementation 关系必须在 Phase 4 中另外验证。
- direct optional Skill 未被选择时不参与 composition；被选择后，它的 complete contract 只在对应条件分支中共同生效。
- 同级 required Skills 没有隐含优先级。

按以下顺序处理 `<target-skill-name>`：

1. 将当前 Skill 自己的 contract、required Skill closure 和当前条件分支选中的 optional Skill complete contracts 组合为同时生效的规则集合。
2. 确认 required supplementary resources 和适用 optional supplementary resources 已包含在对应 complete contract 中。
3. 多个 contract 无法同时满足时，停止依赖冲突规则的工作，并指出发生冲突的 Skill identities 和规则。

Exit：

- `<target-skill-name>` 的 required composition 已完成，不存在未知缺口或未解决冲突。

Blocked：

- 任一 required Skill、required supplementary resource 或传递依赖缺失或不可读。
- required contracts 之间存在无法同时满足的规则。

Partial：

- 只停止依赖缺失或冲突 contract 的工作范围；不依赖该 contract 的其它范围可以继续。

## Phase 4: Resolve Declared Composition
---

- `contract owner` 是在自己的 `SKILL.md` 中声明某个 contract 的 Skill。
- target Skill 声明 derived 或 implementation 角色时，必须在本阶段验证对应 composition。
- target Skill 声明 interface 角色且当前工作需要实际产生该结果时，必须在本阶段解析适用的 implementation。
- `by-<source>` 和 `via-<mechanism>` 用于构造 composition 候选；候选 identity 不能替代真实 Skill、contract 角色和 required dependency 的验证。

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

- `by-<source>` 表示该 contract 基于 interface contract 的基础结果定义更具体的结果，并用于构造 source relationship 候选。
- `<derived-owner-id>` 必须 direct required `<interface-owner-id>`。
- 没有该依赖时，不能仅凭名称认定 derived composition。
- 读取 `<interface-owner-id>` 后，必须确认它的 contract 角色和 derived contract 声明的 source relationship 一致。
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

- `via-<mechanism>` 表示该 contract 通过一个具体机制产生 `<implemented-owner-id>` 所定义的结果，并用于构造 implementation 候选 identity。
- `<implementation-owner-id>` 必须 direct required `<implemented-owner-id>`。
- 实现过程存在其它 Skill 依赖时，这些依赖也必须在 required Skills 中。
- 没有 direct required `<implemented-owner-id>` 时，不能仅凭名称认定 implementation composition。

有效依赖方向：

```text
<derived-owner-id>
    └── required Skill ──> <interface-owner-id>

<implementation-owner-id>
    ├── required Skill ──> <implemented-owner-id>
    └── required Skill ──> <implementation-dependency-id>  【存在实际依赖时】
```

- target Skill 自身是 implementation contract 时，验证它的 identity、contract 角色和 required dependencies。
- interface contract 或 derived contract 需要 implementation mechanism 时，根据 consumer contract 的使用约束和当前可用能力确定 `<mechanism>`，再构造 `<implementation-owner-id>`。
- 在当前 `.scout/skill/` 中按 `<implementation-owner-id>` 定位唯一入口，并对该候选执行 Phase 1 至 Phase 3。
- 候选读取完成后，确认它声明 implementation 角色并 direct required `<implemented-owner-id>`；否则该候选无效。
- derived contract 只复用 source interface 的采集过程时，以 `<interface-owner-id>` 构造 implementation 候选；需要不同采集过程时，以 `<derived-owner-id>` 构造自己的 implementation 候选。
- 存在多个满足当前使用约束和可用能力的 mechanism，但无法唯一选择时，停止依赖该 implementation 的工作并报告候选差异。

Exit：

- target Skill 没有 composition，且当前工作不需要 implementation mechanism 时，已跳过本阶段；
- target Skill 声明的 derived 或 implementation composition 已验证；
- 当前工作需要 implementation mechanism 时，候选已按 `via-<mechanism>` 构造、完整读取并验证。

Blocked：

- target Skill 声明的 composition 缺少 contract、owner 或 required dependency。
- 构造出的 implementation 候选不存在、无法唯一定位、未声明 implementation 角色或没有 required `<implemented-owner-id>`。
- 当前工作需要 implementation mechanism，但无法根据 consumer contract 和当前可用能力唯一确定适用 mechanism。

Partial：

- 未完成的 composition 不得用于工作；不依赖该 composition 的其它范围可以继续。

## Phase 5: Apply Readiness Gate
---

本阶段汇总 Phase 1 至 Phase 4 的结果。只有以下条件全部成立，才开始依赖 `<target-skill-name>` 的工作：

- `<target-skill-path>` 已完整读取。
- `<target-skill-name>` 和 required Skill closure 中每个 Skill 的 required supplementary resources 已完整读取。
- 当前条件分支选中的 optional Skills 已形成 complete contracts。
- 当前条件分支适用的 optional supplementary resources 已完整读取。
- required Skill closure 已递归完成，没有未知、不可读或循环依赖。
- `<target-skill-name>` 和 required Skill closure 的 required composition 已完成，没有未解决冲突。
- target Skill 声明 composition 时，Phase 4 已完成对应关系验证。
- 当前工作需要 implementation mechanism 时，适用 implementation contract 已选中。

Exit：

- 全部条件成立，开始依赖对应 complete contracts 的当前工作。

Blocked：

- 任一条件不成立，停止依赖对应 contract 或 composition 的工作并报告实际缺口。

Partial：

- 未通过门禁的 contract 或 composition 不得用于工作；不依赖它们的其它范围可以继续。

## Workflow Exit Rules (Enforcement)

- XR-001：Phase 1 和 Phase 2 未完成时，不得声明 `<target-skill-name>` 的 complete contract 已形成。
- XR-002：Phase 3 存在未解决冲突或缺失依赖时，不得使用受影响 complete contract。
- XR-003：target Skill 声明的 composition 或当前工作需要的 implementation 未完成 Phase 4 时，不得使用对应结果。
- XR-004：只有 Phase 5 全部条件成立，才能开始依赖对应 complete contracts。

## Failure Rules (Enforcement)

- FR-001：文件输出被截断时，必须使用连续且不重叠的行区间继续读取到文件结尾。
- FR-002：路径不可读、identity 不一致、依赖循环或 contract 冲突时，必须报告实际 Skill identity、路径或循环链以及受影响范围。
- FR-003：声明的 composition 无法确认时，必须报告缺失的 owner、contract、dependency 或尚未完整读取的相关 Skill。

## Blocking Rules (Enforcement)

- BR-001：required Skill 没有唯一可读入口时，阻塞依赖它的工作。
- BR-002：required Skill closure 存在循环或 required supplementary resource 不可读时，阻塞受影响 complete contract。
- BR-003：target Skill 声明的 derived 或 implementation composition 缺少真实 contract 或 required dependency 时，阻塞对应 composition。
- BR-004：当前条件分支中同时生效的 contracts 存在未解决冲突时，阻塞受影响 complete contract。
- BR-005：当前工作需要 implementation mechanism，但候选不存在、验证失败或无法唯一选择时，阻塞依赖该实现的工作。
- BR-006：当前条件分支已经选择 optional Skill，但该 Skill 不可读或 complete contract 无法形成时，阻塞该条件分支。

## Retry Rules (Enforcement)

- RR-001：Skill 文件及其 required Skill closure 已在当前 `<role>` 上下文中完整读取，且 Scout Runtime 没有报告内容变化时，复用基础读取结果，不重复读取文件；当前消费上下文的 optional 选择和 composition 仍需重新判断。
- RR-002：无法确认是否完整读取或内容是否变化时，重新执行 Phase 2。

## Prohibited Rules (Enforcement)

- PR-001：禁止使用模型记忆、名称猜测、相似 contract 或未声明的工具能力补齐读取缺口。
- PR-002：禁止根据相同 `family` 或 `type` 推断 Skill 依赖、derived 或 implementation composition。
- PR-003：禁止把 `by` 或 `via` 构造出的候选 identity 直接当作已经确认的 composition。
- PR-004：禁止让 consumer contract 承担 target Skill 路径解析、contract 角色声明或 implementation 候选登记。

## Checklist

- `<target-skill-name>` 与 `<target-skill-path>` identity 一致且唯一可读。
- direct required Skills 与 required Skill closure 已按 frontmatter 顺序完整处理。
- direct optional Skills 已按 consumer contract 和当前任务的正式输入完成选择；选中的候选已形成 complete contract。
- required supplementary resources 和适用 optional supplementary resources 已完整读取。
- 每个 complete contract 的 required composition 已完成，且不存在未解决冲突。
- target Skill 声明 derived 或 implementation 角色时，identity、真实 contract 和 required dependency 已共同验证。
- 当前工作需要 implementation mechanism 时，候选已通过 `via-<mechanism>` 构造、完整读取并验证。
- Phase 5 的最终读取门禁与 Workflow Exit Rules 一致。
