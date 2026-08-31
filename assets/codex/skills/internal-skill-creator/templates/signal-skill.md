---
scout:
  resource:
    requirement: optional
    description: 创建 type 为 signal 的 Skill 时使用的责任模板。
---

# Signal Skill Type Template

## Selection

当 Skill 只拥有一个稳定、可组合的领域 contract 时，选择 `type: signal` 并使用本模板。

Signal Skill 不拥有所属 domain 的集合选择、完整集合读取、业务 workflow、Tool 操作方法或角色交接。

本模板只规定 Signal Skill 必须表达的内容和责任边界，不规定目标 `SKILL.md` 的章节名称、顺序或格式；正文结构由选定的 layout template 决定。

## Identity And Resource Metadata

Signal Skill 的 name 使用以下形式：

```text
signal-<signal-name>
```

- `<signal-name>` 是稳定的信号名称。
- Signal Skill 不得在 frontmatter 中定义 `phase`；它通过使用方 Skill 的 required 或 optional dependency 进入资源投影。
- Signal Skill 的 `family` 必须以 `signal` 开始，后续目录段表达来源、平台和稳定分类：

```text
[signal, <source>, <platform>, <signal-category>]
```

## Required Content

Signal Skill 必须表达：

- 当前 contract 定义的稳定结果。
- 结果成立所需的输入事实和最小前提。
- 输出结构、identity、顺序、时间、locator、ref 或 digest 中实际适用的字段语义。
- 结果能够支持和不能支持的解释。
- 缺失、部分可见、冲突或无法验证时的语义。
- 当前 contract 在 composition 中承担 `interface`、`derived` 或 `implementation` 中的哪一个角色。

一个 Signal Skill 只定义一个 contract。两个结果拥有不同输入、生命周期、实现或失败语义时，拆成两个 Signal Skill，并通过显式依赖建立关系。

composition 角色、identity 命名和 required dependency 遵守上级 `SKILL.md` 的 Composition Authoring Rules；完整读取和验证遵守 `internal-skill-consumption`。composition 角色不是 Skill type。

## Conditional Content

### Derived Role

当前 contract 承担 `derived` 角色时，必须表达：

- 说明当前 contract 基于哪个 interface contract 的基础结果。
- 说明新增或收窄的具体结果语义。
- 只解释已有基础结果时，使用 interface contract 的适用 implementation；需要额外输入、额外能力或不同实现过程时，声明自己的 implementation composition。
- identity 和 direct required dependency 必须符合上级 `SKILL.md` 的 Composition Authoring Rules。

### Implementation Role

当前 contract 承担 `implementation` 角色时，必须表达：

- 说明当前 implementation mechanism 产生哪个 contract 定义的结果。
- 说明该 mechanism 的环境前提、适用条件和不可用条件，使消费方能够根据当前环境和 consumer contract 判断是否选择它。
- `dependencies.skills.required` 必须包含被实现 contract；实现依赖 Tool Skill 时也必须显式 required 对应 Tool Skill。
- 当前 Signal Skill 只定义该机制如何满足结果 contract；命令、连接、权限、副作用和通用失败处理仍属于 Tool Skill。
- identity 和 direct required dependency 必须符合上级 `SKILL.md` 的 Composition Authoring Rules。

## Ownership Rules

- Signal Skill 只拥有一个稳定 contract 及当前 composition 角色所需的内容。
- 所属 Domain Skill 拥有 general/capability 集合、选择条件和业务交接。
- Tool Skill 拥有实际命令、连接、权限、副作用和通用失败处理。

## Prohibited Content

- 禁止写入所属 Domain Skill 的 general/capability 集合、选择条件或业务交接。
- 禁止复制 Tool Skill 的完整操作方法。
- 禁止用名称相似或相同 family 代替 required dependency 和 contract 语义。
- 禁止在一个 Signal Skill 中混合多个拥有不同输入、结果或失败语义的 contract。

## Checklist

- 目标 Skill 的 type 是 `signal`，layout 已独立选择。
- 当前 Skill 只拥有一个稳定 contract。
- contract role 明确，且没有被误写成 Skill type。
- interface、derived 或 implementation 的 identity 与 required dependency 符合上级 `SKILL.md` 的 Composition Authoring Rules。
- implementation contract 的环境前提、适用条件和不可用条件足以支持消费方选择。
- 没有 Domain Skill 的集合选择、业务 workflow、Tool 操作或角色交接职责。
- 所有 required content 和适用的 conditional content 已映射到选定 layout，没有从本模板复制目标章节格式。
