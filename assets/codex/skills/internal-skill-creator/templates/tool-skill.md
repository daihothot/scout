# Tool Skill Template

## Selection

当 Skill 主要定义工具、命令、连接、权限、副作用、失败和重试的操作方法时使用本模板。

## Frontmatter Rules

- 只有工具方法拥有明确有序阶段时才添加 `phase`。
- `type` 在正文 `Skill Type` 中固定为 `tool`。
- `structure_level` 根据真实操作复杂度使用 `compact` 或 `full`。

## Skill Type

- type: tool
- structure_level: <full | compact>
- note: <填写工具责任、操作边界和不会拥有的业务结论。>

## Tool Model

- <填写工具、命令、连接或接口的稳定模型。>
- <填写只读操作、副作用操作和外部状态的边界。>
- <填写动态能力、版本、权限和可用性如何从当前环境确认。>

## Inputs

Tool 确实消费上游信息时，必须定义 Inputs；不得把命令输出、运行时观察或操作结果写成初始输入。没有真实上游输入时删除整个 `Inputs` 段。

### I-001: <Input Name>
---

描述：

- <填写输入内容、来源和可推断条件。>

注意事项：

- <填写缺失、不唯一、冲突或不可验证时的处理方式。>
- <填写该输入不能被什么内容替代。>

## Command Rules

只读命令：

- <填写允许的只读操作及其输出用途。>

副作用命令：

- <填写副作用、授权条件和默认是否执行。>

结果处理：

- <填写工具输出如何转成 artifact、evidence ref、locator 或 limitation。>
- <填写哪些输出仍只是 Activity State。>

## Output Layout

- <填写正式输出、artifact ref 或 locator；没有持久产物时明确写 none。>
- <填写失败命令、retry log、limitations 和 provenance 的记录位置。>

### Artifact Relationship Rules

- <存在多个输出或下游引用时填写职责和 ref 规则；不适用时删除本节。>

## Failure Rules (Enforcement)

- FR-001：<填写命令失败、空输出、权限失败、解析失败和外部服务失败的处理方式。>
- FR-002：<填写失败时不得形成的业务结论。>

## Blocking Rules (Enforcement)

- BR-001：<填写缺少 required 工具、权限、目标或版本时的停止条件。>

## Retry Rules (Enforcement)

- RR-001：<填写只读、瞬时、可恢复失败的重试次数和记录要求。>
- RR-002：<填写副作用操作重试前的授权要求。>

## Prohibited Rules (Enforcement)

- PR-001：禁止 <填写绕过权限、结构、版本或证据边界的行为。>

## Checklist

- Inputs 只在实际消费上游信息时存在，且来源、缺失和冲突语义明确。
- 工具 identity、命令、连接、权限和版本均可从当前环境定位。
- 只读操作和副作用操作边界明确。
- 副作用操作具有明确授权条件和幂等性说明。
- 失败、空输出和解析限制不会被当作成功。
- 重试不会改变输入、目标、版本或证据语义来制造成功。
- 工具输出与正式 artifact、evidence 和业务 claim 的边界明确。
- 完成态正文和模板不残留填写说明。
