---
assetKind: scout.skill
name: verifier-validation
description: Scout Verifier 在 Validation Domain 中消费 Research handoff 和 verification manual、采集代码或运行信号、逐项形成 BDD Verification Report 时使用。
id: skills.validation.verifier
version: 0.1.0
phase: [verify]
tags: [scout, validation, bdd, verification, evidence, workflow]
devices: [any]
dependencies:
  skills:
    required: [jarvis-codebase]
  shellTools:
    required: [scoutAssets, jarvis, codegraph, git]
    optional: [rg, sed, find, cat]
  mcpServers:
    optional: [scout_local_capability]
  plugins:
    optional: [scout-local-capability-plugin]
summary: 规范 Validation Verifier 的验证点消费、信号采集和 Verification Report。
---

# Verifier Validation

当 Verifier 已收到可信 Research handoff，需要围绕 verification points 采集证据并形成 BDD Verification Report 时使用本技能。

本技能定义 Validation 验证工作流；代码库检索方法由 `jarvis-codebase` 所有。

## Skill Type

- type: workflow
- structure_level: full
- note: 本技能拥有 Validation observed claim 和 Verification Report，不重新定义 Research claim。

## Core Use

使用本技能处理：

- 核对 Research handoff、verification manual 和验证点输入。
- 围绕每个 verification point 选择并采集可定位信号。
- 区分代码事实、配置事实、运行 observation、工具活动和人工确认。
- 为每个验证点形成独立结论与 evidence refs。
- 提交可供 Validator gate 的 Verification Report。

不使用本技能处理：

- 从原始外部资料重新定位或清洗 BDD。
- 修改代码、配置或 Research artifact。
- 代替 Validator 判断产物是否可交付。
- 在缺少证据时声明 BDD 已成立。

## Validation Verification Model

- Verification Manual 锁定验证点、用户画像、Given / When / Then、supporting evidence 和 signals to collect，不等于运行时已验证。
- Knowledge evidence 支撑意图和规格；当前版本代码证据支撑 implementation claim；真实运行信号支撑 observed claim。
- 工具调用本身属于 Activity State，只有被保存为可定位 evidence ref 后才能支撑 Verification Report。
- 每个 verification point 独立使用 `verified`、`not_verified`、`insufficient_evidence` 或 `blocked`。
- 总体状态不得掩盖单个 verification point 的失败、证据不足或阻塞。

## Inputs

### I-001: Research Handoff
---

描述：

- Research task id、handoff state、Research artifact refs、evidence refs、限制和需人工确认项。

注意事项：

- handoff 为 partial 或 blocked 且缺口影响验证点时，不得假定输入完整。
- 缺少正式 Research 输入时交回 Coordinator，不自行重做 Research。

### I-002: Verification Manual
---

描述：

- verification manual ref、verification points、用户画像、Given / When / Then、supporting evidence ids 和 signals to collect。

注意事项：

- 不修改 manual 的验证点或自行增加成功标准。
- manual refs 不闭环时记录阻塞并交由 Validator 或上游处理。

### I-003: Execution Boundary
---

描述：

- 当前版本、codebase、平台、设备、配置、可用工具和允许采集的信号范围。

注意事项：

- 使用能力前确认当前 mount 可见性和工具说明。
- 缺少某类运行能力时，只影响依赖该能力的验证点，不得伪造 observation。

## Validation Verification Workflow

- Phase 1：核对 Research handoff 和 verification points。
- Phase 2：按验证点采集、保存和关联信号。
- Phase 3：形成并提交 Verification Report。

## Verification Report Output Layout

产物位置由当前 task artifact layout 决定。

Verification Report 至少记录：

- report status 和 task / manual refs。
- 每个 verification point 的独立结论。
- evidence refs、采集方法、版本和环境 provenance。
- failed commands、retry log、limitations 和 blocking items。
- 未覆盖范围和需人工确认项。

### Artifact Relationship Rules

- 摘要产物：Verification Report 汇总每个验证点的 observed claim 和结论。
- 明细产物：日志、截图、命令输出、代码位置或运行 observation 作为独立 evidence ref 保存。
- Registry / index：沿用 Research evidence registry；新增运行 evidence 必须有稳定 ref，不改写原 registry claim。
- Claim owner：Research artifact 拥有待验证事实；Verification Report 拥有 observed claim；Validator 拥有 gate claim。
- 下游引用规则：Validator 引用 report、verification point id 和 evidence refs，不依赖未归档工具活动。
- Ref 字段策略：每个 verification point 的 evidence refs 必填；无法形成时必须使用 evidence 不足或 blocked 结论。

## Phase 1: Confirm Verification Inputs
---

本阶段核对 Research handoff、manual 和执行边界是否足以开始验证。

注意事项：

- 逐项提取 verification point、用户画像、Given / When / Then 和 signals to collect。
- 不把 Research complete 当作 Verification complete。
- 输入不一致时记录具体 artifact、字段和影响的验证点。

Exit：

- 可执行验证点及其输入、环境和信号范围已明确。

Blocked：

- 缺少 manual、验证点、关键输入或执行环境，导致所有目标均不可执行时停止。

Partial：

- 只有部分验证点可执行时，记录范围后继续这些验证点。

## Phase 2: Collect Verification Evidence
---

本阶段针对每个验证点使用适用工具采集并保存证据。

注意事项：

- 代码检索必须遵守 `jarvis-codebase` 的 provenance、symbol 和 source evidence 规则。
- MCP server 和 plugin 只按当前说明与授权使用。
- 每个信号记录采集方法、目标、结果、版本、环境和 artifact ref。
- 失败、空结果和无法执行也是验证事实，但不能记为成功证据。

Exit：

- 每个可执行验证点已有足够 evidence refs，或已形成明确的 evidence 不足、失败或阻塞记录。

Blocked：

- required capability、权限或目标环境不可用且没有其它合法信号来源时停止受影响验证点。

Partial：

- 部分信号已收集但不足以支持结论时保留 evidence refs，并标记 `insufficient_evidence`。

## Phase 3: Produce Verification Report
---

本阶段逐项解释证据与验证点的关系，并形成正式 report。

注意事项：

- 不能只给总体结论；每个 verification point 都必须有状态和依据。
- `verified` 必须由可定位证据支持；无证据、矛盾或未执行不能标记 verified。
- report 必须通过正式 task handoff 提交给 Coordinator 路由 Validator。

Exit：

- Verification Report 已写入授权位置并通过正式 task 入口提交。

Blocked：

- report 不可写、evidence refs 不可定位或 handoff 失败时不得报告完成。

Partial：

- report 可以包含不同验证点状态，但必须准确披露整体未完成范围。

## Workflow Exit Rules (Enforcement)

- XR-001：不得跳过 verification point 输入核对直接执行泛化验证。
- XR-002：任一验证点缺少足够证据时，不得用总体 verified 覆盖。
- XR-003：完成态 Verification Report 必须包含逐项状态、evidence refs、provenance 和限制。

## Evidence Rules (Enforcement)

- ER-001：工具调用、查询命令和过程消息不自动成为 evidence。
- ER-002：observed claim 必须引用可重放的日志、截图、命令输出或真实环境 observation。
- ER-003：代码 evidence 只证明当前版本实现；不能单独证明运行行为已经发生。
- ER-004：矛盾证据必须同时保留并解释，不能只选择支持预期的一侧。

## Failure Rules (Enforcement)

- FR-001：工具失败、空输出、权限拒绝或解析失败时记录命令、错误、影响验证点和 limitation。
- FR-002：evidence ref 无法保存或定位时不得用于 report 结论。
- FR-003：执行失败不得改写成 not_verified 之外的确定业务结论，除非证据本身直接支持。

## Blocking Rules (Enforcement)

- BR-001：缺少可信 Research handoff 或 verification manual 时必须停止。
- BR-002：required capability 对目标验证点不可用时将该点标记 blocked。
- BR-003：artifact target 不可写或正式 handoff 不可用时不得报告 task 完成。

## Retry Rules (Enforcement)

- RR-001：只对瞬时、只读或明确可恢复的采集失败进行有限重试，并记录 retry log。
- RR-002：有副作用的设备、配置或环境操作必须遵守工具授权，不能自动重复。
- RR-003：不得通过改变用户画像、Given / When / Then、版本或环境来制造预期结果。

## Prohibited Rules (Enforcement)

- PR-001：禁止修改代码或配置来使验证通过。
- PR-002：禁止重新定义 Research claim、verification point 或成功标准。
- PR-003：禁止代替 Validator 给出最终 gate。

## Example

输入：

```text
Research handoff 提供 VP-001、manual ref、当前版本代码证据和待采集 runtime signal。
```

流程：

1. 核对 VP-001 的 Given / When / Then 和执行边界。
2. 采集并保存代码与运行证据，关联稳定 evidence refs。
3. 为 VP-001 给出独立状态并写入 Verification Report。

输出：

- Verification Report ref。
- VP-001 状态、evidence refs、failed commands、limitations 和 blocking items。
