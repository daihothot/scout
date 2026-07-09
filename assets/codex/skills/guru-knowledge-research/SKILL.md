---
assetKind: scout.skill
name: guru-knowledge-research
description: Scout Researcher 使用 Guru knowledge、Behaviors、当前版本代码语义、Evidence Pack、evidence-registry 和 verification-manual.md 锁定 BDD 验证内容、证据编号与用户画像。
id: skills.guru.knowledge-research
version: 0.1.0
phase: [research]
tags: [guru, knowledge, codegraph, codebase, evidence, research]
devices: [any]
dependencies:
  skills:
    required: [jarvis-codebase]
  shellTools:
    required: [scoutAssets, jarvis, codegraph]
    optional: [rg, sed, find, cat]
summary: 基于 Guru knowledge 和当前版本代码证据形成 evidence pack 与 verification manual，不使用 synaptic。
---

# Guru Knowledge Research

当 Scout Researcher 需要从 Guru knowledge 和当前版本代码语义中锁定 BDD 验证内容、用户画像、证据编号和 verification manual 时使用本技能。

本技能的目标是产出 **Evidence Pack + Verification Manual**：把验证内容锁定、固化、去歧义，让后续 Verifier 不漂移。Research 不判断 pass / fail，不制定 runtime 执行策略，不采集运行信号。

## Skill Type

- type: workflow
- structure_level: full
- note: 本技能是多阶段 research workflow，必须使用完整 Inputs、Workflow、Output Layout、Artifact Relationship Rules、Phase 和规则分层。

## Core Use

使用本技能处理：

- 从 Guru knowledge 定位 BDD 行为事实、Domain / Module / Capability、Availability、API semantic index 和 Platform 差异知识。
- 从当前产品当前版本代码中定位实现相关证据，记录 CodeGraph / AST symbol、文件、行号、key lines 和 reason。
- 为所有证据分配稳定 evidence id。
- 将证据整理成 research artifact files。
- 生成 `verification-manual.md`，按 verification point 写清用户画像、Given / When / Then、支持证据编号和需要收集的信号。

不使用本技能处理：

- 读取、整理或依赖 `synaptic`。
- 写回、修改或迁移 Guru knowledge。
- 生成 Guru ingestion、proposal、implementation、release note 或 canonical specification。
- 判断 BDD 最终通过或失败。
- 制定 Verifier 的 ReAct 策略、工具顺序或 runtime 执行方案。
- 代替 `jarvis-codebase` 解析代码库路径、切换版本或执行 CodeGraph 检索规则。

## Evidence Model

knowledge 和 code 都是证据来源，不是单独事实。

- Guru knowledge 解释 intent、spec、behavior、availability、API semantics 和 platform boundary。
- 当前版本代码证明 implementation claim。
- runtime / log / UI / test / device signal 才能证明 behavior observed claim。
- Research 阶段只形成 candidate evidence、source-verified implementation evidence 和 verification manual。
- Research 产物不得写 `passed`、`failed`、`verified` 作为最终业务结论。

Evidence ID 使用稳定前缀：

- `E-BDD-*`：Behavior / BDD fact。
- `E-KB-*`：Guru canonical knowledge。
- `E-AVAIL-*`：Availability。
- `E-API-*`：API semantic index。
- `E-PLATFORM-*`：Platform difference knowledge。
- `E-CG-*`：CodeGraph query / node / relation result。
- `E-CODE-*`：current version source code symbol evidence。
- `E-RUNTIME-*`：runtime / device / build / test / log signal，占位时只能写入 verification manual 的 Signals To Collect。
- `E-HUMAN-*`：explicit human confirmation。

## Knowledge Map

Guru knowledge 默认根：

```text
~/.guru/knowledge/Products/GuruSdk
```

核心区域：

- `index.md`：产品边界、domain 地图和维护规则。
- `Behaviors/`：BDD / 行为事实，不等同于本次验证已通过。
- `Domains/`：Domain、Module、Capability、Specifications、Availability、APIs 和平台差异文档。

参考模板语义：

- Domain / Module / Capability：用于确定归属、职责、边界和上下游。
- Capability Specifications：使用 `~/.guru/knowledge/Templates/Capability Specifications Template.md` 和 `Platform Document Template.md` 定义的 11 个固定段落作为 research 维度来源；ResearchArtifact 不生成 canonical `Specifications.md`。
- Availability：用于版本可用性证据。
- API Index：用于 API 语义入口证据，不复制 API 签名、参数或 reference 正文。
- Platform Document：用于平台差异证据；平台 `Specifications.md` 的验收场景必须连接 product 级 Behavior。

Capability Specifications 的 11 个固定段落：

- `系统目标`
- `系统边界`
- `用户角色`
- `核心能力`
- `关键流程`
- `领域对象`
- `状态变化`
- `业务规则`
- `数据与接口`
- `非功能要求`
- `验收场景`

## Inputs

### I-001: Verification Target
---

描述：

- 上游提供的 BDD ID、Behavior 文件路径、Guru SDK 场景描述或明确验证目标。
- 可以包含 issue / PR / 用户描述，但这些只能作为定位线索。

注意事项：

- Research 必须收敛到唯一可定位 BDD fact 后再继续整理 knowledge 和代码证据。
- 无法唯一定位 BDD fact 时，记录为需人工确认项。

### I-002: Mount Capability
---

描述：

- 当前 mount 可见本技能、`jarvis-codebase`、`scout-assets`、`jarvis` 和 `codegraph`。

注意事项：

- 使用 `scout-assets` 查询当前可见能力。
- 缺少 required skill 或 shell tool 时，记录为阻塞项并向上游报告。

### I-003: Knowledge Boundary
---

描述：

- 当前环境允许读取 `~/.guru/knowledge/Products/GuruSdk`，或上游已提供明确 knowledge refs。
- 目标产品是 GuruSdk，或上游明确说明其它产品边界。

注意事项：

- 非 GuruSdk 产品边界不能默认套用 GuruSdk knowledge。
- knowledge ref 只能作为证据来源，不能直接写成本次验证事实。

### I-004: Product Version
---

描述：

- 需要研究的当前产品版本、SDK version、branch 或 commit。

注意事项：

- version / branch / commit 缺失时，记录为需人工确认项。
- 切换代码库版本或使用 `latest` 必须遵守 `jarvis-codebase` 的授权规则。

### I-005: Artifact Target
---

描述：

- 上游指定的 artifact 位置，或当前 role / task 的 artifact layout。

注意事项：

- 没有指定更具体位置时，按当前 role 产物目录写入；本技能不创建新的 canonical 目录约定。
- 需要写入前必须确认目标位置可写。

## Research Workflow

本节只列阶段顺序；具体命令、模板、注意事项和证据要求见各 Phase。

- Phase 1：确认边界、输入和当前 mount 能力。
- Phase 2：收敛到唯一 BDD fact。
- Phase 3：收集 Guru knowledge evidence。
- Phase 4：收集当前版本代码 evidence。
- Phase 5：构建 Evidence Registry。
- Phase 6：准备 Verification Manual。

## Research Output Layout

产物位置由上游、当前 role layout 或当前 task artifact layout 决定。

推荐 research artifact 形态：

```text
index.md
bdd-fact.md
knowledge-evidence.md
code-evidence.md
evidence-registry.md
verification-manual.md
evidence/
  E-BDD-001.md
  E-KB-001.md
  E-AVAIL-001.md
  E-API-001.md
  E-PLATFORM-001.md
  E-CG-001.md
  E-CODE-001.md
```

模板目录索引：

```text
templates/template-index.md
```

创建产物文件时优先复用本技能模板：

```text
templates/research-index.md
templates/bdd-fact.md
templates/bdd-evidence.md
templates/knowledge-evidence.md
templates/knowledge-evidence-block.md
templates/availability-evidence.md
templates/api-evidence.md
templates/platform-evidence.md
templates/code-evidence.md
templates/evidence-registry.md
templates/verification-manual.md
```

代码和 CodeGraph 证据模板不在本技能中定义，必须使用 `jarvis-codebase/templates/` 下的模板。

文件职责：

- `index.md`：总览，记录 research status、scope、artifact list、关键缺口和需人工确认项。
- `bdd-fact.md`：唯一收敛后的 BDD fact，记录 Behavior ref、Given / When / Then、status、匹配理由、排除候选。
- `knowledge-evidence.md`：摘要聚合 Guru knowledge evidence，按 BDD / Domain / Module / Capability / Specifications / Availability / API / Platform 分类；不嵌完整 evidence block；每条 evidence 必须引用独立 evidence artifact 的 `artifact_ref`。
- `code-evidence.md`：登记 implementation claim，并聚合当前版本代码证据，汇总 `jarvis-codebase` 产出的 `E-CG-*` 和 `E-CODE-*` artifact refs、locator、claim_supported 和 limitations。
- `evidence-registry.md`：所有证据编号的集中索引。
- `verification-manual.md`：验证手册，只引用 evidence id，不粘贴证据正文。
- `evidence/*.md`：每条 research evidence 的独立 artifact 文件，文件名必须和 evidence id 对齐。

### Artifact Relationship Rules

- `bdd-fact.md` 是主 BDD fact 文档，不是 `E-BDD-*` evidence block。
- 所有 research evidence 都必须是独立 evidence artifact 文件；`E-BDD-*`、`E-KB-*`、`E-AVAIL-*`、`E-API-*`、`E-PLATFORM-*`、`E-CG-*`、`E-CODE-*` 都不能只存在于聚合文件中。
- `E-BDD-*` 必须从 `bdd-fact.md` 派生，使用 `templates/bdd-evidence.md` 形成独立 evidence artifact；`knowledge-evidence.md` 只登记摘要行和 `artifact_ref`，并同步登记到 `evidence-registry.md`。
- `templates/bdd-evidence.md`、`knowledge-evidence-block.md`、`availability-evidence.md`、`api-evidence.md`、`platform-evidence.md` 是单条 evidence artifact 模板；`knowledge-evidence.md` 只聚合 evidence id、evidence_type、artifact_ref、source、locator、claim_supported、supports 和 limitations。
- `jarvis-codebase/templates/codegraph-evidence.md` 和 `source-code-evidence.md` 是单条代码 evidence artifact 模板；Phase 4 先生成或引用对应 `E-CG-*` / `E-CODE-*` artifact，Phase 5 再汇总进 `code-evidence.md` 和 `evidence-registry.md`。
- `implementation claim` 只登记在 `code-evidence.md`，不得登记在 `knowledge-evidence.md` 或 `verification-manual.md`。
- `evidence-registry.md` 只登记索引，不定义 claim 事实。
- `verification-manual.md` 只引用 evidence id，不定义 claim 事实。
- `knowledge-evidence.md` 的 ref field policy：`artifact_ref` 必填，用于指向独立 evidence artifact；`source` + `locator` 用于定位 Guru knowledge 原文。
- `code-evidence.md` 的 ref field policy：`E-CG-*` / `E-CODE-*` 来自 `jarvis-codebase` 产物，必须登记 `artifact_ref`。
- 聚合文件不复制大段来源正文或完整 evidence block；只记录摘要字段和必要 refs。

## Phase 1: Confirm Boundary and Inputs
---

本阶段确认上游输入、当前 mount 能力、knowledge 边界和代码证据依赖是否可用。

使用命令：

```bash
scout-assets skills
scout-assets tools
scout-assets list
```

注意事项：

- 从上游输入中提取 product、domain、capability、platform、app version / SDK version / branch / commit、BDD scenario、user persona clue、source refs 和 issue / PR 线索。
- `scout-assets` 输出只能证明当前 mount 能力可见，不能证明业务状态。
- 只有当前任务需要确认 MCP server、plugin 或 raw manifest 时，再执行 `scout-assets mcp`、`scout-assets plugins` 或 `scout-assets raw`。
- 缺少 required skill、tool 或 knowledge ref 时，记录为阻塞项或需人工确认项。

Exit：

- Required capabilities、knowledge boundary、artifact target 和输入 scope 已确认，或缺口已写入 `index.md`。

Blocked：

- 缺少 `jarvis-codebase`、`scoutAssets`、`jarvis`、`codegraph` 或 artifact target 不可写时停止。

Partial：

- 仅能确认输入和 mount 边界时，只写 `index.md`，不进入 BDD 收敛。

## Phase 2: Converge to One BDD Fact
---

本阶段把输入收敛为一个可定位的 BDD fact，再继续整理 knowledge 和代码证据。

输入处理：

- BDD ID：在 `~/.guru/knowledge/Products/GuruSdk/Behaviors` 中按 `<bdd-id>.md` 定位 Behavior 文件，并核对文档中的 `scenario_id`、标题、Given / When / Then 和 status。
- Behavior 文件路径：确认路径位于 GuruSdk Behaviors 语义下，读取 frontmatter、标题、Given / When / Then、Expect 和 Status。
- Guru SDK 场景描述：先抽取功能/领域、入口状态、触发动作、期望行为和用户画像线索，再在 `Behaviors/` 中查找候选 Behavior，并用 `Domains/` 术语和 capability 边界辅助降噪。
- issue / PR / 用户描述：只能作为定位线索；必须进一步匹配到唯一 Behavior，不能直接替代 BDD fact。

注意事项：

- 记录 Behavior 文件路径、`scenario_id`、Given / When / Then、用户画像线索、匹配理由、排除候选及原因。
- 冲突、不确定项和缺失用户画像必须记录为需人工确认项。
- 输出 `bdd-fact.md`，并从 `bdd-fact.md` 派生 `E-BDD-*` 独立 evidence artifact；`knowledge-evidence.md` 只登记摘要行、artifact_ref、source 和 locator。

Exit：

- 唯一 BDD fact 已定位，`bdd-fact.md` 已记录 selected fact、排除候选和 `E-BDD-*` 派生关系。

Blocked：

- 无法唯一定位 BDD fact 时停止；只写 `index.md` 和候选/需人工确认项，不生成 `evidence-registry.md` 或 `verification-manual.md`。

Partial：

- 已定位候选但缺用户画像或非关键字段时，可以写 `bdd-fact.md`，但必须在 `User Persona To Confirm` 或需人工确认项中保留缺口。

## Phase 3: Collect Guru Knowledge Evidence
---

本阶段在 `~/.guru/knowledge/Products/GuruSdk` 中定位相关 knowledge evidence。

按类别收集：

- Behavior evidence：BDD 行为文件、scenario id、Given / When / Then / Expect 摘要和 status。
- Domain evidence：Domain / Module / Capability 文件路径、职责、边界和上下游。
- Specification alignment evidence：按 Capability Specifications 模板定义的 11 个固定段落记录当前研究结论和 refs。
- Availability evidence：功能点、状态、起始版本、移除版本和相关 release note link。
- API semantic evidence：API 文档来源、共享 API 语义和平台 API 索引。
- Platform evidence：平台差异、共享契约、平台细节和验收场景链接。

注意事项：

- 每条 knowledge evidence 必须记录 evidence id、evidence type、file path、heading / paragraph / table row locator、source status、claim supported 和 limitations。
- knowledge evidence 只能支撑 intent / spec / behavior claim，不能单独证明当前版本实现或运行时行为。
- 单条 evidence 块按对应模板形成独立 evidence artifact；`knowledge-evidence.md` 只聚合摘要字段、artifact_ref、source 和 locator。

Exit：

- `knowledge-evidence.md` 已摘要登记所有相关 `E-BDD-*`、`E-KB-*`、`E-AVAIL-*`、`E-API-*` 和 `E-PLATFORM-*`，且每条都有 artifact_ref、source、locator 和 limitation。

Blocked：

- knowledge 文件不可读、locator 无法定位或关键模板不存在时停止并更新 `index.md`。

Partial：

- 只缺非关键 knowledge 分类时可继续，但必须在对应 evidence limitation 和 `index.md` 中记录缺口。

## Phase 4: Collect Current Version Code Evidence
---

本阶段把 BDD fact 和 knowledge evidence 转成 `jarvis-codebase` 的 Source Query Target，并委派 `jarvis-codebase` 收集当前版本代码证据。

必须加载并执行：

```text
jarvis-codebase
```

注意事项：

- 本技能只负责从 `bdd-fact.md`、`knowledge-evidence.md` 和 verification point draft 推导 `jarvis-codebase` 的 `I-004 Source Query Target`。
- `jarvis-codebase` 负责 repo 解析、版本确认、命令副作用、CodeGraph 查询、源码行号和 `E-CG-*` / `E-CODE-*` artifact。
- `E-CODE-*` 证据块必须使用 `jarvis-codebase/templates/source-code-evidence.md`。
- `E-CG-*` 证据块必须使用 `jarvis-codebase/templates/codegraph-evidence.md`。
- 本阶段把 `jarvis-codebase` 产出的 artifact refs 汇总到 `code-evidence.md`，并记录它们支持的 BDD fact、knowledge evidence 或 verification point。
- CodeGraph 或代码库能力不可用时，按 `jarvis-codebase` 规则记录阻塞项。

Exit：

- `code-evidence.md` 已汇总相关 `E-CG-*` / `E-CODE-*` artifact refs，且每个 implementation claim 至少有 `E-CODE-*` 支撑。

Blocked：

- 当前版本代码证据无法形成 `E-CODE-*` 时停止；不得把 knowledge evidence 写成 implementation fact。

Partial：

- 只形成 `E-CG-*` 候选但未形成 `E-CODE-*` 时，可以保留 `code-evidence.md` 候选区，但不能生成完成状态的 verification manual。

## Phase 5: Build Evidence Registry
---

本阶段把前面阶段收集到的 BDD、knowledge、availability、API、platform、CodeGraph 和 source code evidence 集中登记，形成后续 verification manual 可以引用的 evidence id 索引。

使用模板：

```text
templates/evidence-registry.md
```

注意事项：

- Evidence Registry 只记录 evidence id、source、locator、claim_supported、supports 和 limitations。
- 不复制证据正文；证据正文保存在对应 evidence artifact 中。
- 不写最终验证结论，不写 pass / fail，不把 evidence id 当作 fact id。
- `E-CODE-*` 和 `E-CG-*` 必须引用 `jarvis-codebase/templates/` 中生成的 code evidence artifact。

Exit：

- Registry 覆盖 `knowledge-evidence.md` 和 `code-evidence.md` 中全部 evidence id，且没有孤立 supports。

Blocked：

- 重复 evidence id、缺 locator、缺 source 或 supports 无法闭环时停止。

Partial：

- 存在需人工确认项时可保留 registry 草稿，但 verification manual 只能引用已闭环 evidence id。

## Phase 6: Prepare Verification Manual
---

本阶段把研究结果整理成 verification manual，锁定后续 Verifier 需要验证的功能点、用户画像、Given / When / Then、supporting evidence ids 和 signals to collect。

使用模板：

```text
templates/verification-manual.md
```

注意事项：

- verification point 只描述需要验证的功能点，不写 pass / fail 标准。
- `Supporting Evidence` 只引用 evidence id，不粘贴证据正文。
- `Signals To Collect` 只列建议采集的信号类型，不制定执行策略或成功标准。
- 用户画像不确定时，必须放入 `User Persona To Confirm` 或 `User Confirmation Needed`。
- Given / When / Then 是验证点语义，不是最终判定标准。
- 不包含 Flow；Flow 指 Verifier 的执行路径、ReAct 策略、工具顺序或交互步骤，由下游 Verifier 或验证类 Skill 负责。

Exit：

- 每个 verification point 都有用户画像字段、Given / When / Then、supporting evidence ids 和 signals to collect。

Blocked：

- 缺少唯一 BDD fact、缺少当前版本 `E-CODE-*` 或 evidence registry 不闭环时，不生成完成状态的 verification manual。

Partial：

- 用户画像不确定时可以生成 manual 草稿，但必须把缺口写入 `User Persona To Confirm` 和 `index.md`。

## Workflow Exit Rules (Enforcement)

- XR-001：不得跳过会影响 claim、evidence registry 或 verification manual 的前置 Phase。
- XR-002：任何阻塞项未关闭时，不得把 Research 输出标记为 `ready` 或 `complete`。
- XR-003：`partial` 状态只能用于交接已定位证据和缺口；不得把 `partial` 产物写成完整 verification manual。
- XR-004：Knowledge evidence、code evidence、registry 和 manual 必须遵守 `### Artifact Relationship Rules` 中的 claim owner 和 ref field policy。
- XR-005：最终 Research 输出必须包含闭环 evidence ids、source / locator、limitations、failed_commands、retry_log 和需人工确认项。
- XR-006：verification manual 只能引用 evidence id，不得重新定义 claim、复制证据正文或制定 runtime 执行策略。

## Evidence Rules (Enforcement)

- ER-001：knowledge 和 code 都是 evidence，不是单独事实。
- ER-002：knowledge evidence 只能支撑 intent / spec / behavior claim。
- ER-003：current version code evidence 才能支撑 implementation claim。
- ER-004：runtime evidence 才能支撑 behavior observed claim。
- ER-005：source ref 必须记录 repo、版本或 branch、commit、相对路径、符号和行定位。
- ER-006：API evidence 不能复制 API 签名、参数、返回值、异常或生成 reference 正文。
- ER-007：Availability evidence 不能替代当前有效业务规则。
- ER-008：Platform evidence 只能说明平台差异或共享契约，不能替代 runtime 观察。
- ER-009：工具命令和查询输出属于 Activity State；只有整理进 evidence registry 并和可定位来源闭环后，才能支撑 claim。
- ER-010：Research artifact 可以在 provenance 字段记录本地 source path 或命令输出摘要；evidence locator 必须优先使用 product-relative knowledge path、repo-relative code path、commit 和 symbol 行号。
- ER-011：本机绝对路径不得写入 canonical knowledge 或对外事实；codebase 绝对路径只允许作为本次 Scout runtime artifact provenance。

## Failure Rules (Enforcement)

- FR-001：knowledge 文件不可读、locator 不可定位、frontmatter 或表格无法解析时，必须记录 failed_commands 或 failed_reads、影响 evidence id 和 limitation。
- FR-002：BDD 候选多个、无候选、Given / When / Then 缺失或用户画像冲突时，不得继续写成唯一 verification point；必须记录需人工确认项。
- FR-003：`jarvis-codebase` 失败、CodeGraph 不可用、源码 symbol 无法定位或代码证据模板无法填充时，不得生成 implementation claim。
- FR-004：Evidence Registry 中出现孤立 evidence id、重复 id、缺 locator 或 supports 无法闭环时，不得生成完成状态的 verification manual。
- FR-005：artifact 写入失败、模板缺失或模板字段无法填充时，必须记录阻塞项并向上游报告。

## Blocking Rules (Enforcement)

- BR-001：缺少 `jarvis-codebase`、`scoutAssets`、`jarvis` 或 `codegraph` required capability 时必须停止。
- BR-002：无法唯一定位 BDD fact 时必须停止在 Phase 2，不得进入 Phase 3-6。
- BR-003：目标产品不是 GuruSdk 且上游没有明确产品边界时必须停止。
- BR-004：产品版本、branch 或 commit 缺失且当前任务需要 current version code evidence 时必须记录需人工确认项，不得主动选择 `latest`。
- BR-005：当前版本代码证据无法形成 `E-CG-*` / `E-CODE-*` 闭环时，不得把 knowledge evidence 写成 implementation fact。
- BR-006：artifact target 不可写时，不得进入完成状态。

## Retry Rules (Enforcement)

- RR-001：只读 knowledge 搜索、`scout-assets` 查询或 CodeGraph 只读查询出现瞬时失败时最多重试一次，并记录 retry_log。
- RR-002：涉及 `jarvis-codebase` 的有副作用命令必须遵守 `jarvis-codebase` 的授权和重试规则。
- RR-003：重试不得扩大 product、domain、BDD、repo、version 或 platform 范围来规避唯一性问题。
- RR-004：重试后仍无法唯一定位或证据仍不闭环时，必须固定为需人工确认项、阻塞项或 limitation。

## Prohibited Rules (Enforcement)

- PR-001：禁止读取、整理或依赖 `synaptic`。
- PR-002：禁止写回、修改或迁移 Guru knowledge。
- PR-003：禁止把 `Products/GuruSdk/Behaviors` 中 status 为 pending 或未验证的 BDD 事实写成本次验证通过。
- PR-004：禁止把 knowledge 中的 legacy、migration、draft 或 unresolved 内容写成稳定事实，除非文档状态和上下文明确允许。
- PR-005：禁止把 `rg` 作为 Guru managed codebase 的首选源码语义检索方式。
- PR-006：禁止把本机绝对路径写入 canonical knowledge 或对外事实；Research artifact provenance 例外必须标明为本次 run 的本地来源。
- PR-007：禁止把 Research 产物写成 pass / fail 结论或 runtime 执行策略。

## Example

输入：

```text
验证匿名登录首次启动兜底行为，用户画像可能是免费男性新用户。
```

流程：

1. 收敛到唯一 Behavior，并记录匹配理由和需人工确认项。
2. 收集 Guru knowledge evidence 和当前版本 code evidence。
3. 写入 evidence registry。
4. 使用 `templates/verification-manual.md` 生成 verification manual。

输出：

- `index.md`：记录 research status、artifact refs、phase resume、需人工确认项和阻塞项。
- `bdd-fact.md`：锁定 `account-anon-first-launch-signin` Behavior，记录 Given / When / Then。
- `knowledge-evidence.md`：记录 `E-BDD-*`、Account / AnonymousLogin capability、Availability、API 和 Platform evidence ids。
- `code-evidence.md`：记录当前版本匿名登录入口、fallback 逻辑和相关 symbol evidence。
- `evidence-registry.md`：集中列出 `E-BDD-*`、`E-KB-*`、`E-CG-*`、`E-CODE-*`。
- `verification-manual.md`：列出 VP-001，包含用户画像待确认项、Given / When / Then、supporting evidence ids 和 signals to collect。

边界示例：

- 多个 Behavior 候选：停在 Phase 2，只写 `index.md` 和候选排除信息，不生成完成状态的 `verification-manual.md`。
- CodeGraph 不可用：按 `jarvis-codebase` 规则记录 `code-evidence.md` 的阻塞项；不得把 `knowledge-evidence.md` 写成 implementation fact。
- 用户画像不确定：可以生成 manual 草稿，但必须把缺口写入 `User Persona To Confirm`，并在 `index.md` 的需人工确认项中重复登记。
