---
scout:
  resource:
    requirement: optional
    description: 创建 type 为 internal 的 Skill 时使用的责任模板。
---

# Internal Skill Type Template

## Selection

当 Skill 拥有 Scout 自有资产、运行边界或治理规则时，选择 `type: internal` 并使用本模板，包括：

- 创建、维护或治理 Scout 自有资产、约定或开发边界。
- 查询或检查当前 `mount`、运行配置、资产或其它内部可见边界，并输出中立快照。

被其它 Skill required 不改变当前 Skill 的 Internal type；layout 根据 contract 是否需要确定性阶段独立选择。

本模板只规定 Internal Skill 必须表达的内容和责任边界，不规定目标 `SKILL.md` 的章节名称、顺序或格式；正文结构由选定的 layout template 决定。

## Identity And Resource Metadata

Internal Skill 的 name 使用以下形式：

```text
internal-<internal-capability>
```

- `<internal-capability>` 是当前 Internal Skill 拥有的稳定治理能力。
- 需要进入 Runtime mount 的 Internal Skill 必须定义 `phase: [Startup]`。只服务 Scout 源码作者、不供 Runtime role 消费的 Internal Skill 不定义 `phase`。Internal Skill 不得绑定 `Synthesis` 或 Worker Phase。
- Internal Skill 的 `family` 必须以 `internal` 开始：

```text
[internal, <internal-category>]
```

## Required Content

Internal Skill 必须表达：

- 当前治理、维护或检查的 Scout 自有对象。
- 对象的 canonical identity、权威来源、拥有者和当前可见边界。
- 当前 Skill 可以修改、只可检查或完全不拥有的范围。
- 正确入口、运行环境、权限边界和验证方式。
- 目标缺失、来源冲突、部分可见、解析失败或超出边界时的处理方式。
- 结果可以支持和不能支持的结论。

## Conditional Content

- 实际消费目标、scope、ref 或筛选条件时，说明每项输入的正式来源，以及缺失、歧义或越界时的处理方式。
- 创建或修改 Scout 内部对象时，说明可修改对象、稳定 identity、入口、授权边界和删除边界。
- 执行只读边界检查时，说明检查目标、可见范围、快照时间或版本、部分可见语义和来源冲突规则。
- 产生治理记录、索引或边界快照时，说明输出位置、结构、字段来源、限制和多个输出之间的 ref 关系。

## Ownership Rules

- Internal Skill 只拥有 Scout 自有资产、Runtime 边界或治理规则。
- 当前 run 状态由 Runtime 事实拥有；Internal Skill 可以读取或检查，但不能重新定义。
- 领域业务判断属于 Domain Skill 或 Signal Skill，操作方法属于 Tool Skill。

## Prohibited Content

- 禁止把领域业务判断、当前 run 状态或外部事实写成 Scout 内部治理规则。
- 禁止绕过 canonical 资产入口、`mount`、运行配置或现有生成和验证边界。
- 禁止以治理名义承担 Tool Skill 的副作用操作、Signal Skill 的领域 contract 或 Domain Skill 的业务工作。
- 只读边界检查禁止修改被查询对象或用中立快照替代业务 evidence。
- 禁止根据不可见内容、旧快照或未经解析的来源推断当前事实。

## Checklist

- Skill 的主要责任确实是 Scout 内部治理，而不是 Domain Skill、Tool Skill 或 Signal Skill 的责任。
- 目标 Skill 的 type 是 `internal`，layout 已独立选择。
- canonical identity、权威来源、拥有者、可见范围和运行时边界明确。
- 创建、修改、查询、挂载和验证入口与当前项目结构一致。
- 可修改治理与只读检查的边界明确。
- 没有把领域事实、当前 task 状态或工具输出固化为内部规则。
- 边界快照中的每个字段都能定位来源，并披露部分结果、不可见内容和过期风险。
- 没有拥有 Domain Skill 的领域判断、Tool Skill 的操作 contract 或 Signal Skill 的领域 contract。
- 所有 required content 和适用的 conditional content 已映射到选定 layout，没有从本模板复制目标章节格式。
