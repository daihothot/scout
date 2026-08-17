---
scout:
  resource:
    requirement: optional
    description: 仅创建 workflow 类型 Skill 时使用的结构模板。
---

# Workflow Skill Template

## Selection

当 Skill 拥有有序执行流程、跨阶段状态、完成门禁或多产物交付时使用本模板。

## Frontmatter Rules

- 必须填写 `phase` 和 `family`。`family` 按 Domain、Tool 或 Internal 的真实责任分类，并决定 `.scout/skill` 下的物化目录。
- frontmatter `phase` 不表示本模板正文中的 Phase 顺序；正文阶段仍由 Workflow Overview 和 Exit Rules 定义。
- `tags` 只表达 Workflow 的稳定特征，不参与目录分类或 phase 投影。
- `type` 在正文 `Skill Type` 中固定为 `workflow`。
- `structure_level` 使用 `full`。

## Skill Type

- type: workflow
- structure_level: full
- note: <填写该流程拥有的生命周期、产物和最终交付边界。>

## Inputs

Workflow 确实消费上游信息时，必须定义 Inputs；不得保留空 Inputs，也不得把执行过程中产生的事实伪装成初始输入。没有真实上游输入时删除整个 `Inputs` 段。

### I-001: <Input Name>
---

描述：

- <填写输入内容、来源和可推断条件。>

注意事项：

- <填写输入缺失、不唯一、冲突或不可验证时的处理方式。>
- <填写该输入不能被什么内容替代。>

## Workflow Overview

本节只列阶段顺序，不重复命令、模板正文或证据细节。

- Phase 1：<填写阶段目标。>
- Phase 2：<填写阶段目标。>

## Output Layout

- <填写正式产物、artifact ref、文件名模式和模板引用。>
- <填写 complete、partial、blocked 时的输出差异。>
- <填写 status、completion_state、blocking_items、failed_commands、retry_log 和 limitations 的适用范围。>

### Artifact Relationship Rules

- 摘要产物：<填写职责；不存在时明确写 none。>
- 明细产物：<填写职责；不存在时明确写 none。>
- Registry / index：<填写是否仅做导航和 refs。>
- Claim owner：<填写最终 claim 由哪个 artifact 定义。>
- 下游引用规则：<填写允许引用的 id、ref 或 locator。>
- Ref 字段策略：<填写 required、optional 或不使用。>

## Phase 1: <Phase Name>
---

本阶段 <填写阶段目的>。

使用命令或模板：

- <填写当前阶段实际使用的命令或模板；没有时写 none。>

注意事项：

- <填写本阶段必须记录的 provenance、artifact ref 或 evidence ref。>

Exit：

- <填写进入下一阶段的确切条件。>

Blocked：

- <填写必须停止的条件。>

Partial：

- <填写允许部分完成的条件和记录位置。>

## Workflow Exit Rules (Enforcement)

- XR-001：<填写跨阶段前置条件和禁止跳过规则。>
- XR-002：<填写需人工确认项、阻塞项和部分完成如何影响最终交付。>
- XR-003：<填写最终输出何时可以声明完成。>

## Evidence Rules (Enforcement)

- ER-001：<填写证据成立条件。>
- ER-002：<填写 Activity State、工具输出、artifact 和业务 claim 的边界。>

## Failure Rules (Enforcement)

- FR-001：<填写命令失败、解析失败、写入失败或证据不闭环时的记录要求。>

## Blocking Rules (Enforcement)

- BR-001：<填写缺少 required 能力、输入、权限或证据时的停止条件。>

## Retry Rules (Enforcement)

- RR-001：<填写可重试失败、次数和 retry log 要求。>

## Prohibited Rules (Enforcement)

- PR-001：禁止 <填写跨阶段或最终交付中不允许的行为。>

## Checklist

- Inputs 只包含上游必须提供或可推断的信息，且每项来源和缺失语义明确。
- Workflow Overview、Phase 顺序和 Workflow Exit Rules 一致。
- frontmatter `phase` 表达 Runtime 适用阶段；`family` 必填且表达 Workflow 的稳定类型归属。
- `tags` 是非路由特征，不被正文阶段名称或 family path 机械复制。
- 每个 Phase 的 Exit、Blocked、Partial 可以被明确判断。
- 正式产物、claim owner、refs 和 artifact relationship 不互相重复或冲突。
- `status`、`completion_state`、阻塞和失败事实能够完整交接。
- 有副作用的命令具有明确授权条件，不会因自动重试重复执行。
- 完成态正文和模板不残留填写说明。
