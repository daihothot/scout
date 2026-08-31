---
scout:
  resource:
    requirement: optional
    description: 创建 type 为 tool 的 Skill 时使用的责任模板。
---

# Tool Skill Type Template

## Selection

当 Skill 拥有一种操作能力的调用方式、输入、结果、副作用和失败边界时，选择 `type: tool` 并使用本模板。

被 AGENTS、Domain Skill 或其它 Skill 引用不改变当前 Skill 的 Tool type；layout 根据 contract 是否需要确定性阶段独立选择。

本模板只规定 Tool Skill 必须表达的内容和责任边界，不规定目标 `SKILL.md` 的章节名称、顺序或格式；正文结构由选定的 layout template 决定。

## Identity And Resource Metadata

Tool Skill 的 name 使用以下形式：

```text
tool-<provider>-<tool-capability>
```

- `<provider>` 是提供该操作能力的实际来源。
- `<tool-capability>` 是该 Tool Skill 拥有的稳定操作能力。
- Tool Skill 不得在 frontmatter 中定义 `phase`；它通过使用方 Skill 的 required 或 optional dependency 进入资源投影。
- Tool Skill 的 `family` 必须以 `tool` 和 `<provider>` 开始；存在稳定子分类时追加 `<tool-category>`：

```text
[tool, <provider>]
[tool, <provider>, <tool-category>]
```

## Required Content

Tool Skill 必须表达：

- 操作能力的稳定 identity，以及实际命令、连接或接口从当前环境中的何处取得。
- 工具可用性、版本、目标、权限和运行环境的确认方式。
- 实际参数、参数来源、缺失或冲突时的处理方式。
- 只读操作与会改变文件、运行状态或外部状态的操作边界。
- 每种操作返回的结果、状态、locator、ref 或 artifact，以及结果不能支持的结论。
- 空输出、非零状态、权限拒绝、解析失败、服务失败和部分结果的语义。
- 可重试条件、次数或停止条件，以及副作用操作再次执行所需的授权和幂等条件。

实际命令、路径、参数结构和调用 schema 必须按选定 layout 的 fenced code block 规则书写。

## Conditional Content

- Tool 确实消费上游信息时，说明输入内容、正式来源和不可替代它的内容；不得把命令输出或运行时观察写成初始输入。
- Tool 产生多个输出或供下游引用的 artifact 时，说明每个输出的所有者及它们之间的 ref 关系。
- Dynamic Tool 的 Tool Skill 还必须说明调用场景、参数、结果和生命周期影响；Dynamic Tool description 只保留工具是什么和主要用途。
- Tool 没有持久产物时，仍需说明它返回的结果或状态，并明确不存在 artifact。

## Ownership Rules

- Tool Skill 拥有操作能力、调用条件、权限、副作用、结果和失败边界。
- Domain Skill 拥有调用该 Tool 的业务目的和业务结果解释。
- Signal Skill 拥有领域 contract，不由 Tool Skill 根据工具输出替代。
- Internal Skill 拥有 Scout 内部治理，不由 Tool Skill 扩展。

## Prohibited Content

- 禁止绕过权限、结构、版本、目标或 evidence 边界来制造成功。
- 禁止将失败、空输出、未经解析的内容或部分结果声明为完整结果。
- 禁止为了重试而改变输入、目标、版本或证据语义。
- 禁止写入 Domain Skill 的业务判断、Signal Skill 的领域 contract 或 Internal Skill 的治理规则。

## Checklist

- 目标 Skill 的 type 是 `tool`，layout 已独立选择。
- 输入只在实际消费上游信息时存在，且来源、缺失和冲突语义明确。
- 工具 identity、命令、连接、权限和版本均可从当前环境定位。
- 只读操作和副作用操作边界明确。
- 副作用操作具有明确授权条件和幂等性说明。
- 失败、空输出和解析限制不会被当作成功。
- 重试不会改变输入、目标、版本或证据语义来制造成功。
- 工具输出与正式 artifact、evidence 和业务 claim 的边界明确。
- 没有拥有 Domain Skill 的业务判断、Signal Skill 的领域 contract 或 Internal Skill 的治理责任。
- 所有 required content 已映射到选定 layout，没有从本模板复制目标章节格式。
