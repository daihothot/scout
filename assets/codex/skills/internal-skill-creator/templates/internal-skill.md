---
scout:
  resource:
    requirement: optional
    description: 仅创建 internal 类型 Skill 时使用的结构模板。
---

# Internal Skill Template

## Selection

当 Skill 主要承担 Scout 内部治理时使用本模板，包括：

- 创建、维护或治理 Scout 自有资产、约定或开发边界。
- 查询或检查当前 mount、profile、memory、资产或其它内部可见边界，并输出中立快照。

## Frontmatter Rules

- `type` 在正文 `Skill Type` 中固定为 `internal`。
- 必须填写 `phase`。应由 Agent 直接导航的 Internal 入口使用 `[internal, <capability>]` family；只为其它入口服务时省略 `family` 并由 required dependency 带入。
- `phase` 只表示哪些 Agent phase 可以选择本 Skill，不表示维护或查询步骤具有正文阶段。
- `tags` 只表达内部治理对象和能力特征；不使用 `workflow` tag 表达普通的创建、维护或查询顺序。
- `structure_level` 根据治理范围选择 `compact` 或 `full`。

## Skill Type

- type: internal
- structure_level: <填写 compact 或 full>
- note: <填写该 Skill 拥有的 Scout 内部治理责任，以及明确不拥有的领域责任>

## Internal Governance Model

- <填写被创建、维护、治理、查询或检查的 Scout 内部对象。>
- <填写该对象的 canonical identity、权威来源、可见范围和运行时边界。>
- <填写 Agent、Asset Store、Runtime 或其它拥有者之间的责任分工。>
- <填写当前 Skill 对该对象是可修改治理还是只读检查。>

## Inputs

Internal Skill 实际消费目标、scope、ref 或筛选条件时，必须定义 Inputs。没有真实输入时删除整个 `Inputs` 段。

### I-001: <Input Name>
---

描述：

- <填写治理或查询目标、来源和可推断条件。>

注意事项：

- <填写缺失、不唯一或超出内部治理边界时的处理方式。>

## Maintenance Scope

创建或修改 Scout 内部对象时保留本节；只执行只读边界检查时删除整个 `Maintenance Scope` 段。

- <填写允许创建或修改的对象和入口。>
- <填写必须保持稳定的 identity、目录、引用或 contract。>
- <填写需要上游明确授权的范围扩张或删除动作。>

## Boundary Inspection Scope

查询或检查内部可见边界时保留本节；不执行边界检查时删除整个 `Boundary Inspection Scope` 段。

- <填写查询对象、可见范围和权威来源。>
- <填写快照代表的时间、版本或 mount 边界。>
- <填写查询结果不能替代的业务事实。>
- <填写只读要求，以及部分可见、不可见或来源冲突时的处理方式。>

## Output Layout

Internal Skill 产出治理记录、索引或边界快照时保留本节；没有正式输出产物时删除整个 `Output Layout` 段。

- <填写输出位置、结构、字段来源、locator 和 limitations。>
- <填写哪些字段来自显式输入、当前可见状态或运行时解析结果。>

### Artifact Relationship Rules

- <填写摘要、明细、索引和下游 ref 的关系；不存在时删除本节。>

## Validation Rules

- <填写用于确认资产结构、引用、挂载和内容一致性的检查。>
- <填写用于确认查询范围、字段来源、时间边界和中立性的检查。>
- <填写失败时必须保留的错误、影响范围和未完成项。>

## Limitation Rules

- <填写不可见内容、过期风险、时间边界和不能据此得出的结论；不存在时删除本节。>

## Failure Rules (Enforcement)

- FR-001：<填写治理失败、查询失败、部分可见、解析失败或来源冲突时的记录方式。>

## Blocking Rules (Enforcement)

- BR-001：<填写无法唯一定位目标、缺少 required 能力或无法确认权威来源时的停止条件。>

## Prohibited Rules (Enforcement)

- PR-001：禁止把领域业务判断、当前 run 状态或外部事实写成 Scout 内部治理规则。
- PR-002：禁止绕过 canonical 资产入口、profile、mount、preflight 或现有生成边界。
- PR-003：禁止以治理名义承担工具副作用、Signal 采集或领域 workflow 责任。
- PR-004：只读边界检查禁止修改被查询对象或用中立快照替代业务 evidence。
- PR-005：禁止根据不可见内容、旧快照或未经解析的来源推断当前事实。

## Checklist

- Skill 的主要责任确实是 Scout 内部治理，而不是领域 workflow、工具操作契约或 Signal contract。
- canonical identity、权威来源、拥有者、可见范围和运行时边界明确。
- 创建、修改、查询、挂载和验证入口与当前项目结构一致。
- 可修改治理与只读检查的边界明确，未保留不适用的可选段落。
- 没有把领域事实、当前 task 状态或工具输出固化为内部规则。
- 边界快照中的每个字段都能定位来源，并披露部分结果、不可见内容和过期风险。
- frontmatter `phase` 覆盖实际使用场景；`family` 的有无与该 Internal Skill 是直接入口还是 dependency-only 服务层一致。
- `tags` 是非路由特征；没有仅为普通维护或查询顺序添加 `workflow` tag。
- 完成态正文和模板不残留填写说明。
