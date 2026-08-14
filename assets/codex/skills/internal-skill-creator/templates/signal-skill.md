---
scout:
  resource:
    requirement: optional
    description: 仅创建 signal 类型 Skill 时使用的结构模板。
---

# Signal Skill Template

## Selection

当 Skill 只定义一种可观察信号的稳定知识、记录结构、实现无关的输出 contract、中立匹配语义和解释限制时使用本模板。

## Frontmatter Rules

- 必须填写 `phase`。需要 Agent 精确锁定的 Signal 入口必须声明有序 `family`；路径层数和 token 完全由所属 domain 的稳定导航语义决定，通用模板不预置具体 Single leaf。只作为其它入口服务层时省略 `family` 并由 required dependency 带入。
- `phase` 只表示哪些 Agent phase 可以选择或审计本 Signal contract，不在正文引入流程阶段。
- `tags` 只表达 Signal 的对象、介质、格式或能力特征，不参与信号族路由。
- `type` 在正文 `Skill Type` 中固定为 `signal`。
- `structure_level` 使用 `compact`。

## Skill Type

- type: signal
- structure_level: compact
- note: <填写该信号的稳定知识边界。>

## Source Signal

Derived Signal 必须保留本节并且只声明一个直接 Source Signal；直接对应原始观察输出的 Source Signal 删除整个 `Source Signal` 段。

- source_signal: <填写唯一直接 Source Signal 的 Skill identity>

规则：

- `source_signal` 只能有一个值，不使用列表或多个字段。
- frontmatter 的 `dependencies.skills.required` 必须包含同一个 Source Signal，用于保证 Skill 可见性。
- Derived Signal 只消费 Source Signal output，不覆盖其记录边界、顺序、时间精度、locator 或缺失语义。
- Derived Signal output 必须保留 source output ref、digest 和 locator。
- 需要关联多个 Signal 时由消费方 workflow 处理，不在 Signal Skill 中声明多个 Source Signal。

## Signal Model

- <填写信号是什么、由什么事实构成以及原生记录结构。>
- <填写字段语义、记录边界、顺序、identity 和 locator。>
- <填写信号能够和不能够支持的解释。>

## Signal Matching Contract

- <填写消费方如何引用此信号。>
- <填写匹配要求由消费方的哪些已确认事实提供。>
- <填写 match、non-match、correlation、ordering 或 observation window 等适用字段。>

## Signal Output Contract

- <填写所有实现共同返回的内容和一致性字段。>
- <填写权威原始内容、digest、ref、encoding、format 或时间边界等适用字段。>
- <填写消费视图如何回到权威原始内容。>

## Signal Contract Rules (Enforcement)

- SR-001：<填写 Signal contract、消费方匹配要求、Signal output、观察结果和下游结论不得互相替代的规则。>
- SR-002：<填写 contract 的内部一致性规则。>

## Interpretation Rules (Enforcement)

- IR-001：<填写观察到信号能够证明的最小事实。>
- IR-002：<填写缺失信号不能单独证明的结论。>

## Prohibited Rules (Enforcement)

- PR-001：禁止写入消费方特定条件、主体身份、环境状态或预期结论。
- PR-002：禁止包含具体工具、命令、连接、权限、环境矩阵、失败操作或重试流程。
- PR-003：禁止把 Signal contract、匹配候选或 Signal output 直接当作下游结论。

## Checklist

- 正文不存在 Inputs、Workflow Overview、编号 Phase 或 Workflow Exit Rules。
- frontmatter `phase` 覆盖实际选择或审计场景；`family` 的有无与该 Signal 是直接入口还是 dependency-only 服务层一致。
- `tags` 是非路由特征，不改变 Signal 的稳定知识边界。
- Signal Model、Signal Matching Contract 和 Signal Output Contract 的职责不重叠。
- contract 不包含任何具体实现的工具、命令、连接、权限或重试语义。
- 匹配条件由消费方的已确认事实提供，Signal 不发明消费方特定内容。
- Signal output 能够回到权威原始内容，并明确一致性字段。
- Derived Signal 只声明一个 `source_signal`，依赖和输出 provenance 与它一致；Source Signal 不保留空的 `Source Signal` 段。
- 观察到和未观察到信号的解释限制完整。
- 完成态正文不残留填写说明。
