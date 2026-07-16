---
assetKind: scout.skill
name: validator-validation
description: Scout Validator 对 Researcher 提交的 Guru Research pack 执行独立结构、证据语义、代码 provenance 与引用闭环检查，并生成 Research Pack Gate 报告时使用。
id: skills.validation.validator
version: 0.2.0
phase: [validate]
tags: [scout, validation, research, gate, evidence, audit, workflow]
devices: [any]
dependencies:
  skills:
    required: [guru-knowledge-research, jarvis-codebase]
  shellTools:
    required: [scoutAssets, scoutArtifactDigest]
    optional: [rg, sed, find, cat]
summary: 独立检查 Research pack，并形成绑定内容摘要的 Research Pack Gate。
---

# Validator Validation

当 Validator 收到 Researcher 的正式 Research handoff，需要独立检查其 Research pack 是否能够进入后续流程时使用本技能。

当前版本只定义 Research Pack Gate；不定义 Verification pack、运行验证或最终 BDD 结论。

## Skill Type

- type: workflow
- structure_level: full
- note: 本技能拥有 Gate claim，不拥有 BDD、knowledge、implementation 或 runtime observation claim。

## Core Use

使用本技能处理：

- 读取 task 明确引用的 Researcher 正式 Research pack。
- 依据当前挂载的 producer Skill 和模板检查结构、状态、引用关系和证据语义。
- 对 knowledge evidence 与当前版本 code evidence 执行独立核对。
- 将检查范围、内容摘要、Gate 和问题写入 Validator 私有 artifact。
- 在 Researcher 修正后，对新的 pack 内容重新执行同一 Gate。

不使用本技能处理：

- 执行或重做 Research 生产流程。
- 运行 `scout-research-artifact-check` 或继承 Researcher 的生产工具依赖。
- 修改 Researcher artifact、补写 evidence、补全 claim 或重新编号 evidence id。
- 收集运行时验证信号、形成 Verification artifact 或判定 BDD pass / fail。
- 把 Researcher 自检结果直接当作独立 Gate。

## Research Pack Gate Model

- 一个 run 只处理一个 BDD；Research Pack Gate 只检查当前 task 指向的一个 Research pack。
- `guru-knowledge-research` 定义 Research pack、聚合产物、独立 evidence 和引用关系；Validator 将其作为 producer contract 读取，不执行其生产 workflow。
- `jarvis-codebase` 定义 CodeGraph 与 source-code evidence 的 provenance、symbol 和 locator 规则；Validator 将其作为代码证据 contract 读取。
- Validator 只读取 Researcher 正式 artifact，所有检查报告只写入 Validator 自己的 artifact root。
- 每次 Gate 绑定一个 `sha256` pack digest；Research pack 内容改变后，旧 Gate 不再适用于新内容。
- 复查覆盖当前 `research-pack-gate.md`，不创建 revision、历史副本或第二套状态存储。

Gate 枚举：

- `accepted`：检查完整，适用 contract 均满足，引用闭环且没有未披露缺口。
- `needs_fix`：检查完整，存在可定位且应由 Researcher 修正的结构、格式、状态、引用或内容一致性问题。
- `insufficient_evidence`：检查完整，但一个或多个必要 claim 缺少当前版本、可定位或足以支持它的 evidence。
- `blocked`：Validator 无法继续或完成检查，例如 pack、contract、digest 能力或报告写入位置不可用。

Gate 优先级：

```text
blocked > insufficient_evidence > needs_fix > accepted
```

问题严重性与 Gate 状态分离。`Critical` 问题可以得到 `needs_fix` 或 `insufficient_evidence`；只有检查本身无法继续时才使用 `blocked`。

## Inputs

### I-001: Research Handoff
---

描述：

- Coordinator 提供的 Researcher task id、正式 handoff state、Research pack ref、限制和当前检查目标。

注意事项：

- 普通 summary、progress、task activity 或文件名猜测不能替代正式 Research handoff。
- handoff 未提供唯一 Research pack ref 时停止，不扫描其它 Worker 目录猜测目标。

### I-002: Research Pack
---

描述：

- task 明确引用、由 Researcher 拥有并只读访问的 Research pack 目录。

注意事项：

- pack 中应存在的产物、模板和关系以当前 `guru-knowledge-research` 为准。
- Validator 禁止写入、移动、重命名或格式化该目录中的任何文件。

### I-003: Inspection Contracts
---

描述：

- 当前 mount 中的 `guru-knowledge-research`、其模板，以及 `jarvis-codebase` 的代码证据规则和模板。

注意事项：

- 只读取当前挂载版本，不使用历史记忆或旧 schema 补充规则。
- producer Skill 的生产工具依赖不自动成为 Validator 的依赖。

## Research Pack Gate Workflow

- Phase 1：锁定 Research pack、producer contracts 和初始 digest。
- Phase 2：检查 pack 结构、状态、聚合与独立 evidence 引用关系。
- Phase 3：检查 BDD、knowledge、代码证据和验证点语义。
- Phase 4：确认 digest 未变化，写入并提交 Research Pack Gate。

## Research Pack Gate Output Layout

每次检查只生成一个报告：

```text
${SCOUT_ARTIFACT_ROOT}/research-pack-gate.md
```

使用模板：

```text
templates/research-pack-gate.md
```

报告必须包含：

- Validator task、Researcher task、上游声明状态和唯一 Research pack ref。
- pack digest、digest algorithm、适用 contract refs。
- 已检查 refs、未检查范围和限制。
- Gate 状态、摘要和按 `V-001` 递增的问题列表。
- 每个问题的严重性、分类、受影响 refs、检查依据、影响和最小解除条件。
- failed commands、retry log 和报告自身的完成状态。

报告状态：

- 检查完整时使用 `status: ready`、`completion_state: complete`；Gate 可以是 `accepted`、`needs_fix` 或 `insufficient_evidence`。
- 检查本身无法完成时使用 `status: blocked`、`completion_state: blocked`、`gate: blocked`。
- 最终报告不使用 `draft + partial` 冒充已完成 Gate。

### Artifact Relationship Rules

- 摘要产物：`research-pack-gate.md` 是本次检查的唯一 Gate 报告，不复制 Research evidence 正文。
- 明细产物：本技能不创建独立 check 文件；具体问题全部记录在同一报告的 `V-*` 条目中。
- Registry / index：Validator 只检查 Researcher 的 registry 和 index，不创建第二套 registry 或 evidence id。
- Claim owner：Research pack 保持 BDD、knowledge 和 implementation claim 所有权；Gate 报告只拥有检查范围与 Gate claim。
- 下游引用规则：Coordinator 引用 Gate 报告 ref、pack digest、Gate 和问题 id；不得把 Gate 摘要当作 Research evidence。
- Ref 字段策略：Research pack ref、每个已检查 artifact ref 和问题影响 ref 必填；不存在的目标必须按缺失 ref 明确记录。

## Phase 1: Resolve Pack and Contracts
---

本阶段确认唯一 Research pack、当前 producer contracts 和检查起始内容摘要。

使用命令：

```bash
scout-artifact-digest <research-pack-dir>
```

注意事项：

- 读取 `guru-knowledge-research/SKILL.md`、`templates/template-index.md` 和本次 pack 实际涉及的模板。
- 读取 `jarvis-codebase/SKILL.md` 及其代码证据模板，用于 Phase 3 的代码 evidence 检查。
- 记录初始 digest、文件数量和 Researcher handoff state。
- 不调用 Researcher 的 artifact checker，也不把 Researcher 的自检输出当作当前检查结果。

Exit：

- 唯一 pack、两个 producer contracts、输出位置和初始 digest 已确认。

Blocked：

- pack 不可读、contract 不可见、digest 失败或 Validator artifact root 不可写时停止。

Partial：

- 不适用；Phase 1 前置条件不完整时 Gate 为 blocked。

## Phase 2: Inspect Structure and Relationships
---

本阶段依据当前 Research 模板检查弱 Markdown 结构和跨 artifact 关系。

检查内容：

- `index.md`、`bdd-fact.md`、`knowledge-evidence.md`、`code-evidence.md`、`evidence-registry.md` 和下游手册是否与 handoff 声明及当前 producer contract 一致。
- workflow artifact 的 `status`、`completion_state`、blocking items、failed commands、retry log 和 limitations 是否自洽。
- 每条 BDD、knowledge、availability、API、platform、CodeGraph 和 source-code evidence 是否为独立文件。
- 聚合文件是否只保存摘要和 `artifact_ref`，registry 是否登记全部 evidence id、locator、claim 和 supports。
- 下游手册中的 evidence ids、verification points、用户画像、Given / When / Then 和待采集 signals 是否与 registry 闭环。

注意事项：

- 使用当前模板逐项检查，不因字段为空、标题相似或自然语言看似合理而跳过。
- 格式、状态和引用错误归入 `needs_fix`，除非目标完全不可读导致检查无法继续。
- 上游声明为 partial 或 blocked 时不得输出 accepted，但仍应检查可读范围。

Exit：

- 所有适用结构、状态和引用关系已检查，问题均已定位到具体 ref 或缺失项。

Blocked：

- pack 内容在读取期间不可访问，导致无法确定检查对象时停止。

Partial：

- 个别内容缺失时继续检查其余文件，并在完整报告中形成 `needs_fix` 或 `insufficient_evidence`，不把 Gate 检查标成 partial。

## Phase 3: Inspect Evidence Semantics
---

本阶段核对 Research pack 中进入下游手册的证据是否支持其声明。

检查内容：

- BDD fact 是否唯一定位到 Behavior / scenario，Given、When、Then、Expect 和用户画像是否来自可定位来源。
- knowledge evidence 是否带当前 knowledge provenance、具体 locator、claim、supports 和 limitations，且没有把 knowledge 内容直接宣称为当前实现事实。
- implementation claim 是否同时具有当前版本 root/source repository provenance、CodeGraph locator 和 source-code evidence。
- source-code evidence 是否包含可重放的 source-relative file、commit、symbol name/type/signature、start/end line、key lines 与 reason。
- symbol、行号和 key lines 是否能在声明的当前版本代码中重新定位并支持对应 implementation claim。
- verification point 是否只引用 registry 中已登记 evidence id，不自行创造事实、运行策略或成功标准。

注意事项：

- 当前代码是 implementation claim 的最终依据；knowledge 与 CodeGraph 只提供意图、索引或定位支持。
- 缺少必要当前版本代码证据、locator 不可重放或 claim 无足够 evidence 时使用 `insufficient_evidence`。
- claim 与实际来源不一致、字段错误或引用错配但可由 Researcher 修正时使用 `needs_fix`。
- Validator 只读来源，不刷新 codebase、不修改 worktree、不生成新的 Research evidence。

Exit：

- 每个进入下游手册的 verification point 和关键 claim 都已核对 supporting evidence 与限制。

Blocked：

- task 引用的关键来源因权限或环境原因不可读，导致 Validator 无法执行必要核对时停止。

Partial：

- evidence 本身缺失属于 pack 的 `insufficient_evidence`，不是 Validator 检查 partial。

## Phase 4: Write and Submit Gate
---

本阶段确认目标内容稳定，形成唯一 Gate 报告并通过正式 task handoff 提交。

使用命令：

```bash
scout-artifact-digest <research-pack-dir>
```

使用模板：

```text
templates/research-pack-gate.md
```

注意事项：

- 写报告前重新计算 digest；与 Phase 1 不一致时丢弃当前 Gate 判断，对新内容重新检查一次。
- 第二次检查期间 digest 再次变化时输出 blocked，禁止对移动目标给出 Gate。
- 根据优先级选择唯一 Gate，不把问题严重性直接映射为 blocked。
- 复查时覆盖当前报告，并更新 pack digest、检查范围、Gate 和问题列表。
- 正式 handoff 必须包含 Gate 报告 ref、pack digest、Gate、问题 ids 和未检查范围。

Exit：

- `research-pack-gate.md` 已写入 Validator artifact root，且正式 handoff 与报告一致。

Blocked：

- digest 持续变化、报告不可写或正式 handoff 不可提交时不得宣称 Gate 完成。

Partial：

- 不适用；检查未完成时提交 blocked，不生成可被误解为完整 Gate 的 partial 报告。

## Workflow Exit Rules (Enforcement)

- XR-001：不得在没有唯一 Research pack ref、producer contracts 和稳定 pack digest 时形成 Gate。
- XR-002：不得运行 Researcher 生产 workflow、Research artifact checker 或修改被检查 pack。
- XR-003：`accepted` 必须满足全部适用检查、引用闭环、当前版本代码证据和未检查范围为空。
- XR-004：Researcher 修正 pack 后必须按新 digest 完整复查；旧 Gate 不自动延续。
- XR-005：每次检查只维护一个当前 Research Pack Gate 报告，不建立 revision 或平行状态文件。

## Evidence Rules (Enforcement)

- ER-001：每个 Gate 判断必须引用实际 artifact ref、producer contract、source locator 或明确缺失项。
- ER-002：Researcher handoff、自检结果、progress 和普通 summary 不能替代 Validator 的独立检查。
- ER-003：knowledge evidence 不能单独证明当前 implementation claim；代码 claim 必须回到声明版本的 source symbol 和 key lines。
- ER-004：引用存在不等于支持 claim；必须核对 claim、evidence、supports、limitations 和 verification point 的关系。
- ER-005：Gate 报告只证明指定 digest 内容的检查结果，不证明运行时行为或 BDD pass / fail。

## Failure Rules (Enforcement)

- FR-001：读取、digest、解析或来源定位命令失败时，记录命令、错误、重试和受影响范围。
- FR-002：模板字段、状态组合、evidence id、locator 或引用不闭环时，不得通过自然语言解释覆盖失败。
- FR-003：报告写入或正式 handoff 失败时不得用普通消息冒充 Gate 已提交。
- FR-004：无法读取当前代码来源时不得把 knowledge 或 CodeGraph 候选提升为 source-verified evidence。

## Blocking Rules (Enforcement)

- BR-001：缺少 Research pack、producer contract、digest 能力或 Validator artifact 写权限时必须 blocked。
- BR-002：权限或环境导致关键输入不可读并阻止必要检查时必须 blocked。
- BR-003：pack 在检查过程中持续变化时必须 blocked，不得绑定过期 digest。
- BR-004：pack 可读但 evidence 本身不足时使用 `insufficient_evidence`，不得错误归类为 blocked。

## Retry Rules (Enforcement)

- RR-001：只对瞬时、只读失败进行一次有限重试，并记录 retry log。
- RR-002：pack digest 首次变化时允许对新 digest 重新检查一次；再次变化后停止。
- RR-003：不得通过修改 pack、contract、repo、版本或检查范围制造重试成功。
- RR-004：Researcher 提交修正后属于新的内容检查，不沿用旧问题关闭状态。

## Prohibited Rules (Enforcement)

- PR-001：禁止写入 Researcher artifact、其它 Worker mount 或 logs。
- PR-002：禁止补写 Research evidence、重新编号 evidence id 或替 Researcher 修复问题。
- PR-003：禁止把 Gate 描述为 Verification 已执行、BDD 已通过或全局 Validation 已完成。
- PR-004：禁止为使用 producer Skill 而继承或执行其生产命令和副作用能力。
- PR-005：禁止创建强 schema 状态投影或第二套 Gate registry。

## Example

输入：

```text
Researcher task researcher-task-0001 提交一个 Research pack，handoff state 为 complete。
```

流程：

1. 定位唯一 pack，读取 producer contracts，并计算初始 digest。
2. 检查 pack 结构、独立 evidence、聚合关系、registry 和下游手册引用。
3. 核对 BDD、knowledge 与当前版本 source symbol 证据。
4. 重新确认 digest，写入 `research-pack-gate.md` 并提交正式 handoff。

输出：

- Validator 私有 artifact 中的一份 Research Pack Gate 报告。
- `accepted | needs_fix | insufficient_evidence | blocked` Gate、pack digest、问题 ids 和未检查范围。
