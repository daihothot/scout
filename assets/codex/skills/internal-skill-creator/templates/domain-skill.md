---
scout:
  resource:
    requirement: optional
    description: 创建 type 为 domain 的 Skill 时使用的责任模板。
---

# Domain Skill Type Template

## Selection

当 Skill 拥有一个 domain 中当前 role 的业务输入、判断、工作、输出和交接时，选择 `type: domain` 并使用本模板。

Domain Skill 不拥有跨 domain 规则、工具操作方法、Single 内部 contract 或通用 Skill 消费算法。

本模板只规定 Domain Skill 必须表达的内容和责任边界，不规定目标 `SKILL.md` 的章节名称、顺序或格式；正文结构由选定的 layout template 决定。

## Required Content

Domain Skill 必须表达：

- 当前 `<domain>` 的稳定业务边界。
- 当前 `<role>` 在该 domain 中拥有的判断和工作。
- 正式输入来自 `<task>`、`handoff`、`artifact`、Tool 结果或其它哪一个已声明来源，以及缺失或冲突时如何处理。
- 根据正式输入作出哪些业务判断，各判断成立所需的条件是什么。
- 当前 role 产生的正式输出、完成条件、失败边界和下游交接。
- 哪些事实可以交给下游，哪些限制必须随结果一起传递。

## Conditional Content

### Single Collections

- `general Single list` 是当前 Domain Skill 要求无条件完整读取的 Single Skill 入口列表。
- `capability` 是当前 domain 根据正式业务输入识别的一个条件工作范围。
- `capability Single list` 是选择某个 capability 后必须完整读取的 Single Skill 入口列表。

Domain Skill 需要 Single Skill 时，必须提供 `general Single list`、每个可选 capability 的选择条件、对应的 `capability Single list`，以及各列表中实际 Skill 入口的确定顺序。

规则：

- 开始依赖 Single contract 的领域工作前，完整处理 `general Single list` 的全部成员。
- capability 只能根据当前 Domain Skill 明确声明的正式输入和选择条件确定。
- 一个 capability 被选中后，完整处理对应 `capability Single list` 的全部成员，不能挑选其中看起来重要的部分。
- 每个成员分别作为 target Skill 执行 `internal-skill-consumption`；需要解析成员间 composition 时，由 Domain Skill 明确提供 related Skills。
- general/capability 集合属于当前 domain 和 role，不能写入 Single Skill 或 `internal-skill-consumption`。
- 不需要 Single Skill 时，不写 Single 集合内容。

### Tool Use

Domain Skill 使用 Tool 时，必须说明当前 domain 中的业务使用场景，并提供对应 Tool Skill 的实际入口。

- Dynamic Tool、Shell Tool、MCP Tool 和 plugin 的参数、权限、副作用、结果与失败处理属于对应 Tool Skill。
- Domain Skill 只说明为什么在当前 domain 工作中使用 Tool，以及如何解释其业务结果。
- 不需要 Tool 时，不写 Tool 使用内容。

## Ownership Rules

- 当前 domain 和 role 的业务判断、Single 集合、capability 选择、输出和交接由 Domain Skill 拥有。
- Single Skill 拥有自身 contract；Domain Skill 只引用并组合其结果，不复制内部规则。
- Tool Skill 拥有操作方法；Domain Skill 只拥有 Tool 的业务使用场景和结果解释。
- 跨 domain 或跨 role 的稳定规则由对应 AGENTS 拥有。

## Prohibited Content

- 禁止复制全局 AGENTS、其它 role 或其它 domain 的完整规则。
- 禁止实现 Tool 的操作方法。
- 禁止复制 Single Skill 的内部 contract 或 `internal-skill-consumption` 的通用算法。
- 禁止要求 role 扫描没有明确提供的 Single Skill 入口来扩大集合。

## Checklist

- 目标 Skill 的 type 是 `domain`，layout 已独立选择。
- domain、role、正式输入、业务判断、输出和交接边界明确。
- general Single 和 capability Single 的集合、顺序与选择条件由当前 Domain Skill 拥有。
- 选中 capability 后要求完整处理其全部 Single Skill。
- Tool 使用场景和 Tool Skill 入口明确，但没有复制工具操作方法。
- 没有跨 domain、跨 role 或通用 Skill 消费职责越界。
- 所有 required content 已映射到选定 layout，没有从本模板复制目标章节格式。
