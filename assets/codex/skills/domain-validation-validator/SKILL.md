---
assetKind: scout.skill
name: domain-validation-validator
description: Scout Validator 对 Research Pack 或 Verification Report 执行独立 contract、证据语义、provenance 与引用闭环检查，并生成对应 Gate 报告时使用。
id: domain-validation-validator
version: 0.6.3
phase: [validate]
family: [validation, workflow]
tags: [scout, validation, research, verification, gate, evidence, audit, workflow]
devices: [any]
dependencies:
  skills:
    required: [domain-validation-research-pack, tool-guru-knowledge, tool-jarvis-codebase, internal-single-skill-reader]
  shellTools:
    required: [scoutAssets, scoutArtifactDigest]
    optional: [rg, sed, find, cat]
summary: 独立形成 Research Pack Gate 或 Verification Report Gate。
---

# Domain Validation Validator

当 Validator 收到正式 Research handoff 或 Verifier handoff，需要独立检查对应 artifact 是否能够进入后续流程时使用本技能。

当前版本定义两个互斥入口：Research Pack Gate 与 Verification Report Gate。它们必须由两个独立 Validator task 执行；本技能不定义运行验证或最终 BDD 结论。

## Skill Type

- type: workflow
- structure_level: full
- note: 本技能拥有 Gate claim，不拥有 BDD、knowledge、implementation 或 runtime observation claim。

## Core Use

使用本技能处理：

- 读取 task 明确引用的 Researcher 正式 Research pack。
- 依据当前挂载的 producer Skill 和模板检查结构、状态、引用关系和证据语义。
- 依据 Manual 实际引用的 Signal contract 检查信号 requirement 是否具体且可执行。
- 对 knowledge evidence 与当前版本 code evidence 执行独立核对。
- 将检查范围、内容摘要、Gate 和问题写入 Validator 私有 artifact。
- 在 Researcher 修正后，对新的 pack 内容重新执行同一 Gate。
- 读取 task 明确引用的 Verifier 正式 Verification Report。
- 核对 accepted Research Gate 入口、逐项 verification state、observation evidence、provenance 和 Manual requirement 的对应关系。
- 在 Verifier 修正同一 report 后创建新的 Verification Report Gate。

不使用本技能处理：

- 执行或重做 Research 生产流程。
- 运行 `scout-research-artifact-check` 或继承 Researcher 的生产工具依赖。
- 修改 Researcher artifact、补写 evidence、补全 claim 或重新编号 evidence id。
- 收集运行时验证信号、形成或修改 Verification Report，或判定 BDD pass / fail。
- 为上游 Worker 选择 Acquisition、采集信号或判断具体采集实现支持哪些环境。
- 把上游 Worker 的自检结果直接当作独立 Gate。
- 使用同一个 Validator task 先后执行 Research Pack Gate 和 Verification Report Gate。

## Single Consumption

- 本领域当前 Single 根目录为 `.scout/skill/validation/single/unity/local/`。
- 开始语义检查前，先按 `internal-single-skill-reader` 完整读取 `general/` 下当前 validate phase 可见的全部 Single，包括接口 contract 与相关实现 contract。
- 根据候选 artifact 明确引用的 Capability 选择 capability 目录；一旦选择，必须在检查相关内容前完整读取该 capability 目录下当前 phase 可见的全部 Single。
- 完整读取用于建立检查 contract；Validator 只检查候选 artifact 实际涉及的 requirement、Signal 与 Acquisition，不执行采集、不重做 Research，也不因已读而扩大 gate 范围。
- 任一集合未完整读取时，按受影响检查范围形成真实 gate 缺口；不生成 coverage 或 applicability 记录。

## Validation Gate Model

- 一个 run 只处理一个 BDD；Research Pack Gate 只检查当前 task 指向的一个 Research pack。
- Verification Report Gate 只检查另一个 Validator task 指向的一个 canonical `verification-report.md`。
- `domain-validation-research-pack` 定义 Research Pack、聚合产物、状态和引用关系；Validator 将其作为 Domain producer contract 读取，不执行其生产 workflow。
- `domain-validation-verifier` 定义 Verification Report、逐项状态和 Verifier handoff contract；Validator 将其作为 Verification producer contract 读取，不执行其采集 workflow。
- `tool-guru-knowledge` 定义 Guru Knowledge 来源、provenance，以及 Capability、Availability 和 Platform 明细 evidence contract。
- `tool-jarvis-codebase` 定义 CodeGraph 与 source-code evidence 的 provenance、symbol 和 locator 规则；Validator 将其作为代码证据 contract 读取。
- Manual 中每个 `signal_ref` 都指向对应 Signal contract；Validator 只读取实际引用的 contract，并按其规则检查 requirement 和 provenance。
- Validator 只读取上游正式 artifact，所有检查报告只写入 Validator 自己的 artifact root。
- 每次 Research Pack Gate 只绑定 `scout-artifact-digest` 返回的 `scout-directory-sha256-v1` digest；Research pack 内容改变后，旧 Gate 不再适用于新内容。
- 每次检查创建一份新的 `research-pack-gate-NNNN.md`；正式 handoff 后该 Gate 记录不可修改。
- 复查必须创建下一份 Gate 记录；旧 Gate 只证明其绑定 digest 当时的检查结果。
- Verification Report Gate 绑定 `scout-artifact-digest` 对 report 文件返回的 `sha256:<hex>`；report 内容改变后旧 Gate 不再适用。
- 每次 Verification Report 检查创建新的 `verification-report-gate-NNNN.md`；正式 handoff 后不可修改。

Gate 枚举：

- `accepted`：检查完整，适用 contract 均满足，引用闭环且没有未披露缺口。
- `needs_fix`：检查完整，存在可定位且应由上游 Worker 修正的结构、格式、状态、引用或内容一致性问题。
- `insufficient_evidence`：检查完整，但一个或多个必要 claim 缺少可定位或足以支持它的 evidence。
- `blocked`：Validator 无法继续或完成检查，例如检查对象、contract、digest 能力或报告写入位置不可用。

Gate 优先级：

```text
blocked > insufficient_evidence > needs_fix > accepted
```

问题严重性与 Gate 状态分离。`Critical` 问题可以得到 `needs_fix` 或 `insufficient_evidence`；只有检查本身无法继续时才使用 `blocked`。

对 Verification Report Gate 而言，`accepted` 表示 report 完整、逐项状态诚实且 evidence 链可定位。report 中存在被正确证明的 `not_verified`，或被准确披露的 `insufficient_evidence` / `blocked`，本身不阻止 Gate accepted；Validator 不重写 Verifier 的 observed claim。

## Native Subagent Strategy

- 本技能明确授权父 Validator 在预计能够提高当前检查效率时自主决定是否使用 Codex native subagent；是否派发、派发数量以及并行或串行方式由父 Validator 判断，不构成 Gate 检查的必需步骤。
- 每个 task 的 Phase 1 必须由父 Validator 锁定唯一检查对象、当前 inspection contracts、初始 digest 和下一 Gate id；锁定前不得派发内容检查。
- 只有检查范围边界稳定、能够独立推进，并且预期节省的时间高于启动、等待和聚合成本时才派发。Structure 与 Semantics 是可选的候选拆分：Structure child 可只检查文件结构、artifact 状态、模板字段和跨文件引用闭环；Semantics child 可只检查 BDD/knowledge 语义、implementation claim、代码 provenance、source locator、Signal requirement 和 verification point 支撑关系。父 Validator 可以委派其中一个、多个或均不委派，不得为了满足形式而派发。
- Verification Report Gate 的可选拆分只能围绕互不依赖的 verification point；逐项 observation/evidence 检查可委派，Gate 选择、跨点一致性和正式 artifact 仍由父 Validator 拥有。
- 多个 child 必须收到相同检查对象 ref、初始 digest 和适用 contract；范围必须互斥，不得任意重叠拆分，也不得执行对方范围。
- child 只按 `Checked Refs`、`Check Results`、`Issue Candidates`、`Commands`、`Failed Commands`、`Uninspected Scope` 六段返回不超过 4000 个中文字符的检查结果；不复制被检查 artifact 正文，不得写入上游检查对象、分配最终问题 id、选择 Gate 或创建 Gate artifact。
- 父 Validator 不重复执行 child 已完成的完整检查，只负责锁定输入、消费已派发范围的结果、抽查冲突 locator、合并和去重问题、分配问题 id、复核 digest、选择 Gate、写入不可变 Gate artifact 并正式 handoff。
- 所有已派发且会影响 Gate 的 child 结果返回并被消费前，不得复核最终 digest、写 Gate 或提交 handoff；空结果、超时和 `closeAgent` 清理都不能视为结果已返回。
- child 检查期间发现目标 digest 变化时，父 Validator 必须丢弃该批结果并按现有移动目标规则处理，不得把不同 digest 的检查结果合并。
- 父 Validator 决定不派发时直接自行检查，不需要记录 fallback 原因；派发失败或结果不可用时，可以在停止或释放对应 child 后收回该范围，不得与仍在执行的 child 重复检查。

## Inputs

### I-001: Research Handoff
---

描述：

- Coordinator 提供的 Researcher task id、正式 handoff state、Research pack ref、上游声明的 digest algorithm / digest、限制和当前检查目标。

注意事项：

- 普通 summary、progress、task activity 或文件名猜测不能替代正式 Research handoff。
- handoff 未提供唯一 Research pack ref 时停止，不扫描其它 Worker 目录猜测目标。
- 上游不能指定或覆盖 Validator 使用的 digest 算法；Validator 只接受并独立复算 `scout-directory-sha256-v1`。

### I-002: Research Pack
---

描述：

- task 明确引用、由 Researcher 拥有并只读访问的 Research pack 目录。

注意事项：

- pack 中应存在的产物、模板和关系以当前 `domain-validation-research-pack` 为准。
- Validator 禁止写入、移动、重命名或格式化该目录中的任何文件。

### I-003: Inspection Contracts
---

描述：

- 当前 mount 中的 `domain-validation-research-pack` 及其聚合模板、`tool-guru-knowledge` 的知识证据规则和模板、`tool-jarvis-codebase` 的代码证据规则和模板，以及 Manual 实际引用的 Signal contracts。

注意事项：

- 只读取当前挂载版本，不使用历史记忆或旧 schema 补充规则。
- producer Skill 的生产工具依赖不自动成为 Validator 的依赖。
- Signal contract 只用于检查 Manual requirement；Validator 不要求 Research 阶段预先选择 Acquisition。

### I-004: Verification Handoff
---

描述：

- Coordinator 提供的 Verifier task id、固定 Verifier handoff、Verification Report ref、accepted Research Gate ref、checked pack ref / digest、逐项状态摘要、限制和当前检查目标。

注意事项：

- 普通 summary、progress、task activity 或未写入的 observation 不能替代正式 Verifier handoff。
- handoff 必须指向唯一 canonical `verification-report.md`；不得扫描 Verifier artifact root 猜测目标或接受隐式版本文件。
- accepted Research Gate ref、pack ref 和 digest 必须与 report 的 Source Context 一致。

### I-005: Verification Report
---

描述：

- task 明确引用、由 Verifier 拥有并只读访问的 canonical `verification-report.md`。

注意事项：

- report 结构、逐项状态和 handoff contract 以当前 `domain-validation-verifier` 为准。
- Validator 禁止写入、移动、重命名或格式化 report 及其 evidence。

### I-006: Verification Inspection Contracts
---

描述：

- 当前 mount 中的 `domain-validation-verifier` 与 report 模板、Research Pack 中的 verification manual，以及 report 实际引用的 Signal 和 Acquisition contracts。

注意事项：

- 只读取当前挂载版本和 task 明确引用的上游 refs。
- Acquisition contract 只用于核对采集 provenance、目标支持和操作结果；Validator 不重新执行采集流程。
- Manual requirement、Signal contract 与 Acquisition output 的职责不能互相替代。

## Research Pack Gate Workflow

- Phase 1：锁定 Research pack、inspection contracts 和初始 digest。
- Phase 2：检查 pack 结构、状态、聚合与独立 evidence 引用关系。
- Phase 3：检查 BDD、knowledge、代码证据和验证点语义。
- Phase 4：确认 digest 未变化，写入并提交 Research Pack Gate。

Research Pack Gate 的 required contracts 是 `domain-validation-research-pack`、`tool-guru-knowledge`、`tool-jarvis-codebase` 和 `internal-single-skill-reader`。`domain-validation-verifier` 不属于 Research Pack Gate 的无条件输入；只有进入下方 Verification Report Gate 时，才读取并消费它定义的 report contract。

## Research Pack Gate Output Layout

每次检查生成一份新的报告：

```text
${SCOUT_ARTIFACT_ROOT}/research-pack-gate-0001.md
${SCOUT_ARTIFACT_ROOT}/research-pack-gate-0002.md
${SCOUT_ARTIFACT_ROOT}/research-pack-gate-0003.md
```

文件序号只用于创建新记录：列出 artifact root 第一层符合 `research-pack-gate-[0-9]{4}.md` 的文件，取最大序号加一；没有记录时从 `0001` 开始。Coordinator 不得用序号推断当前 Gate。

先读取模板索引：

```text
templates/template-index.md
```

使用模板：

```text
templates/research-pack-gate.md
```

每份报告必须完整遵循模板。未注明 `Nice to Have，可不填写` 的事实字段必须使用本次检查取得的确切信息；明确可不填写的字段缺失不阻塞 Gate。Markdown 标题使用英文，标题下的自然语言内容使用中文；字段 key、evidence id 和状态值保持 contract 原值。所有 `<填写...>` 说明必须替换。

报告状态：

- 检查完整时使用 `status: ready`、`completion_state: complete`；Gate 可以是 `accepted`、`needs_fix` 或 `insufficient_evidence`。
- 检查本身无法完成时使用 `status: blocked`、`completion_state: blocked`、`gate: blocked`。
- 最终报告不使用 `draft + partial` 冒充已完成 Gate。

### Artifact Relationship Rules

- 摘要产物：每个 `research-pack-gate-NNNN.md` 是对应检查的唯一 Gate 报告，不复制 Research evidence 正文。
- 明细产物：本技能不创建独立 check 文件；具体问题全部记录在同一报告的 `V-*` 条目中。
- Registry / Pack state：Validator 检查 Researcher 的 evidence registry 和 checker 派生的 Pack 状态，不创建第二套 registry、状态 artifact 或 evidence id。
- Claim owner：Research pack 保持 BDD、knowledge 和 implementation claim 所有权；Gate 报告只拥有检查范围与 Gate claim。
- 下游引用规则：Coordinator 引用 Gate 报告 ref、pack digest、Gate 和问题 id；不得把 Gate 摘要当作 Research evidence。
- Ref 字段策略：Research pack ref、每个已检查 artifact ref 和问题影响 ref 必填；不存在的目标必须按缺失 ref 明确记录。
- 历史关系：旧 Gate 不覆盖、不修改、不自动适用于新 digest；复查结果只能写入新的 Gate 文件。

## Phase 1: Resolve Pack and Contracts
---

本阶段确认唯一 Research pack、当前 inspection contracts 和检查起始内容摘要。

使用命令：

```bash
scout-artifact-digest <research-pack-dir>
```

注意事项：

- 读取 `domain-validation-research-pack/SKILL.md`、`templates/template-index.md` 和本次 pack 实际涉及的模板。
- 读取 `tool-guru-knowledge/SKILL.md` 及其知识 evidence 模板，用于 Phase 3 的 knowledge evidence 检查。
- 读取 `tool-jarvis-codebase/SKILL.md` 及其代码证据模板，用于 Phase 3 的代码 evidence 检查。
- 读取 Manual 中每个 `signal_ref` 对应的 Signal contract，以及该 contract 明确要求读取的来源。
- 记录初始 digest、文件数量和 Researcher handoff state。
- 独立计算的 digest algorithm 必须是 `scout-directory-sha256-v1`。
- 上游缺少 digest、声明其它算法或声明 digest 与独立计算结果不一致时继续完成可读范围检查，并将 Gate 至少判为 `needs_fix`；不得改用上游自定义算法复算。
- 不调用 Researcher 的 artifact checker，也不把 Researcher 的自检输出当作当前检查结果。

Exit：

- 唯一 pack、全部适用 contracts、输出位置和初始 digest 已确认。

Blocked：

- pack 不可读、contract 不可见、digest 失败或 Validator artifact root 不可写时停止。

Partial：

- 不适用；Phase 1 前置条件不完整时 Gate 为 blocked。

## Phase 2: Inspect Structure and Relationships
---

本阶段依据当前 Research 模板检查弱 Markdown 结构和跨 artifact 关系。

检查内容：

- `bdd-evidence.md`、`knowledge-evidence.md`、`code-evidence.md`、`evidence-registry.md` 和下游手册是否与 handoff 声明及当前 producer contract 一致。
- workflow artifact 的 `status`、`completion_state`、blocking items、failed commands、retry log 和 limitations 是否自洽。
- `E-BDD-001` 与 `E-KB-001` 是否分别由顶层聚合文件拥有，以及 `E-CAP-*`、`E-AVAIL-001`、`E-PLATFORM-001`、`E-PERSONA-*`、`E-HUMAN-*` 和 `E-CODE-*` 是否按 producer contract 独立保存。
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
- 每个 Signal requirement 是否引用可见 Signal contract，并完整定义 `match`、`non_match`、`required_fields`、`correlation`、`ordering` 和 `observation_window`。

注意事项：

- 当前代码是 implementation claim 的最终依据；knowledge 与 CodeGraph 只提供意图、索引或定位支持。
- 缺少必要当前版本代码证据、locator 不可重放或 claim 无足够 evidence 时使用 `insufficient_evidence`。
- claim 与实际来源不一致、字段错误或引用错配但可由 Researcher 修正时使用 `needs_fix`。
- Validator 只读来源，不刷新 codebase、不修改 worktree、不生成新的 Research evidence。
- Validator 不检查 Acquisition 可用性；Manual 中出现具体采集工具、命令或环境支持判断时记为 `needs_fix`。

Exit：

- 每个进入下游手册的 verification point 和关键 claim 都已核对 supporting evidence 与限制。

Blocked：

- task 引用的关键来源因权限或环境原因不可读，导致 Validator 无法执行必要核对时停止。

Partial：

- evidence 本身缺失属于 pack 的 `insufficient_evidence`，不是 Validator 检查 partial。

## Phase 4: Write and Submit Gate
---

本阶段确认目标内容稳定，形成一份新的不可变 Gate 报告并通过正式 task handoff 提交。

使用命令：

```bash
scout-artifact-digest <research-pack-dir>
```

使用模板：

```text
templates/research-pack-gate.md
```

注意事项：

- 本次实际派发且会影响 Gate 的 child 结果必须全部返回并被消费；任一所需结果缺失时不得进入 Gate 写入。父 Validator 未派发 child 时，由父 Validator 完成全部适用检查。
- 写报告前重新计算 digest；与 Phase 1 不一致时丢弃当前 Gate 判断，对新内容重新检查一次。
- 第二次检查期间 digest 再次变化时输出 blocked，禁止对移动目标给出 Gate。
- 报告中的 `checked_pack_digest` 必须写入第二次 `scout-artifact-digest` 返回值；禁止写入 Coordinator 或 Researcher 提供的其它摘要算法结果。
- 根据优先级选择唯一 Gate，不把问题严重性直接映射为 blocked。
- 按下一可用序号创建新 Gate；不得打开旧 Gate 原地更新 pack digest、检查范围、Gate 或问题列表。
- Gate 写入并正式 handoff 后不可修改；后续任何复查都创建下一序号文件。
- 正式 handoff 必须使用下列固定七字段；英文 Markdown 标题和字段 key 保持原样，字段内容使用中文，字段不得增加、删除、改名或展开为额外摘要：

```markdown
# Validator Handoff: Research Pack Gate

- validator_task_id: <当前 Validator task id>
- gate_ref: <本次不可变 Gate artifact ref>
- checked_pack_digest: sha256:<hex>
- gate: <accepted | needs_fix | insufficient_evidence | blocked>
- issue_ids: <V-*；没有时写 none>
- uninspected_scope_or_limitations: <未检查范围或限制；没有时写 none>
- continuation_entry: <下一步消费入口>
```
- 正式 handoff 不得复制 Checked Refs、检查过程、证据 claim、源码 locator、Gate 结论摘要或完整问题正文；这些内容只能通过不可变 Gate artifact ref 消费。

Exit：

- 新 `research-pack-gate-NNNN.md` 已写入 Validator artifact root，且正式 handoff 明确引用该报告并与其内容一致。

Blocked：

- digest 持续变化、报告不可写或正式 handoff 不可提交时不得宣称 Gate 完成。

Partial：

- 不适用；检查未完成时提交 blocked，不生成可被误解为完整 Gate 的 partial 报告。

## Verification Report Gate Workflow

- Verification Phase 1：锁定 canonical Verification Report、accepted Research Gate context、inspection contracts 和初始 digest。
- Verification Phase 2：检查 report 结构、逐项状态、observation evidence、provenance 和引用闭环。
- Verification Phase 3：确认 digest 未变化，写入并提交 Verification Report Gate。

## Verification Report Gate Output Layout

每次检查生成一份新的报告：

```text
${SCOUT_ARTIFACT_ROOT}/verification-report-gate-0001.md
${SCOUT_ARTIFACT_ROOT}/verification-report-gate-0002.md
${SCOUT_ARTIFACT_ROOT}/verification-report-gate-0003.md
```

文件序号只用于创建新记录：列出 artifact root 第一层符合 `verification-report-gate-[0-9]{4}.md` 的文件，取最大序号加一；没有记录时从 `0001` 开始。Coordinator 不得用序号推断当前 Gate。

先读取模板索引：

```text
templates/template-index.md
```

使用模板：

```text
templates/verification-report-gate.md
```

每份报告必须完整遵循模板。Markdown 标题使用英文，标题下的自然语言内容使用中文；字段 key、evidence id 和状态值保持 contract 原值。所有 `<填写...>` 说明必须替换。

报告状态与 Gate 枚举沿用 Research Pack Gate。Verification Report Gate 的 `accepted` 只表示 report contract 和 evidence 链可消费，不表示所有 verification point 都是 `verified`。

### Artifact Relationship Rules

- 摘要产物：每个 `verification-report-gate-NNNN.md` 是对应检查的唯一 Gate 报告，不复制 observation 或 evidence 正文。
- 明细产物：具体问题全部记录在同一 Gate 报告的 `V-*` 条目中；本技能不创建额外 check 文件。
- Claim owner：Verification Report 保持 observed claim 和 verification point state 所有权；Gate 报告只拥有检查范围与 Gate claim。
- 下游引用规则：Coordinator 引用 Gate ref、report digest、Gate 和问题 ids；最终 synthesis 仍从 Verification Report 读取逐项状态。
- Ref 字段策略：Verification Report ref、accepted Research Gate ref、Manual ref、每个已检查 evidence ref 和问题影响 ref 必须可定位。
- 历史关系：旧 Gate 不覆盖、不修改、不自动适用于新 report digest；复查只能创建新的 Gate 文件。

## Verification Gate Phase 1: Resolve Report and Contracts
---

本阶段确认唯一 canonical Verification Report、上游 Gate context、当前 inspection contracts 和检查起始摘要。

使用命令：

```bash
scout-artifact-digest <verification-report-file>
```

注意事项：

- 只接受 task handoff 明确引用且文件名为 `verification-report.md` 的 report；拒绝隐式版本文件。
- 读取 `domain-validation-verifier/SKILL.md` 和 `templates/verification-report.md`。
- 读取 report 引用的 accepted Research Pack Gate、Research pack、verification manual，以及实际涉及的 Signal / Acquisition contracts。
- 核对 accepted Research Gate ref、pack ref / digest、manual ref 与 report Source Context 一致。
- 记录 report 初始 `sha256:<hex>`、文件大小和 Verifier handoff 中的 verification point states。
- 不执行 Verifier 采集 workflow，不重新采集 signal，也不把 Verifier 自检或普通 summary 当作当前检查结果。

Exit：

- 唯一 report、accepted Research Gate context、全部适用 contracts、输出位置和初始 digest 已确认。

Blocked：

- report、accepted Research Gate、关键 contract 不可读，digest 失败或 Validator artifact root 不可写时停止。

Partial：

- 不适用；前置条件不完整时 Gate 为 blocked。

## Verification Gate Phase 2: Inspect Report and Evidence
---

本阶段核对 report 是否完整、逐项状态是否符合语义，以及 observation evidence 是否可以支撑对应判断。

检查内容：

- report 是否严格遵循当前模板，artifact state 是否自洽，是否完整覆盖 Manual 中的每个 verification point 且没有增加成功标准。
- `ready + complete` report 的 `human_confirmation_needed` 是否为 `none`。
- report、Verifier handoff、accepted Research Gate、pack digest、manual ref 和 verification point ids 是否一致。
- 每个 verification point 是否使用 `verified`、`not_verified`、`insufficient_evidence` 或 `blocked`，并保留独立 evidence refs、执行状态和限制。
- `verified` 是否由可定位 observation 直接满足 Manual requirement。
- `not_verified` 是否由可定位 observation 直接反证目标行为，而不是由命令失败、权限失败、解析失败、超时、空结果或未执行推导。
- `insufficient_evidence` 是否对应 `inconclusive`，`blocked` 是否对应 `not_executed`，并准确披露缺口或阻塞。
- 每个 runtime evidence 是否按对应 Signal contract 记录 Signal、Acquisition、原始来源、locator、版本、环境、时间、覆盖范围和限制。
- 采集与解释过程是否保持 Manual 的 match、non-match、correlation、ordering 和 observation window，没有静默改写 requirement。
- failed commands、retry log、blocking items 和 limitations 是否与逐项状态一致。

注意事项：

- `ready + complete` 只要求 report 完整披露每个 verification point 的真实状态，不要求所有点为 `verified`。
- report 准确记录 `not_verified`、`insufficient_evidence` 或 `blocked` 时，不能仅因该状态拒绝 Gate。
- report 声称 `verified` / `not_verified` 但缺少直接、可定位 evidence 时使用 `insufficient_evidence` Gate。
- 结构、状态映射、ref 或 provenance 可修正的问题使用 `needs_fix`。
- Validator 可以重放只读 locator 核对 report，不得重新执行有副作用的 Acquisition 或创造新的 observation。

Exit：

- 所有 verification point、evidence refs、状态映射和适用 contracts 已检查，问题均已定位到具体 ref 或缺失项。

Blocked：

- 关键 evidence 或 contract 因权限、环境或读取失败无法检查时停止。

Partial：

- report evidence 本身不足属于 Gate 的 `insufficient_evidence`，不是 Validator 检查 partial。

## Verification Gate Phase 3: Write and Submit Gate
---

本阶段确认 report 内容稳定，形成一份新的不可变 Gate 报告并通过正式 task handoff 提交。

使用命令：

```bash
scout-artifact-digest <verification-report-file>
```

使用模板：

```text
templates/verification-report-gate.md
```

注意事项：

- 本次实际派发且会影响 Gate 的 child 结果必须全部返回并被消费；未派发 child 时由父 Validator 完成全部检查。
- 写 Gate 前重新计算 report digest；与初始 digest 不一致时丢弃当前判断，对新内容重新检查一次。
- 第二次检查期间 digest 再次变化时输出 blocked，禁止对移动目标形成 Gate。
- 按下一可用序号创建新 Gate；不得打开旧 Gate 原地更新。
- Gate 写入并正式 handoff 后不可修改；后续复查必须创建下一序号文件。
- 正式 handoff 必须使用下列固定八字段；英文 Markdown 标题和字段 key 保持原样，字段内容使用中文，字段不得增加、删除、改名或展开为额外摘要：

```markdown
# Validator Handoff: Verification Report Gate

- validator_task_id: <当前 Verification Validator task id>
- gate_ref: <本次不可变 Gate artifact ref>
- checked_report_ref: <本次实际检查的 canonical Verification Report ref>
- checked_report_digest: sha256:<hex>
- gate: <accepted | needs_fix | insufficient_evidence | blocked>
- issue_ids: <V-*；没有时写 none>
- uninspected_scope_or_limitations: <未检查范围或限制；没有时写 none>
- continuation_entry: <下一步消费入口>
```

- handoff 不得复制 observation、evidence 正文、逐项判断理由、检查过程或完整问题正文；这些内容只能通过不可变 Gate artifact ref 消费。

Exit：

- 新 `verification-report-gate-NNNN.md` 已写入 Validator artifact root，且正式 handoff 明确引用该报告并与其内容一致。

Blocked：

- digest 持续变化、Gate 不可写或正式 handoff 不可提交时不得宣称检查完成。

Partial：

- 不适用；检查未完成时提交 blocked，不生成可被误解为完整 Gate 的 partial 报告。

## Workflow Exit Rules (Enforcement)

- XR-001：不得在没有唯一 Research pack ref、全部适用 inspection contracts 和稳定 pack digest 时形成 Gate。
- XR-002：不得运行 Researcher 生产 workflow、Research artifact checker 或修改被检查 pack。
- XR-003：`accepted` 必须满足全部适用检查、引用闭环、当前版本代码证据和未检查范围为空。
- XR-004：Researcher 修正 pack 后必须按新 digest 完整复查；旧 Gate 不自动延续。
- XR-005：每次检查只产生一份新的 Gate 记录；已正式 handoff 的记录禁止修改，复查必须创建下一份记录。
- XR-006：正式 handoff 必须明确引用本次 Gate ref，并只传递 Gate、pack digest、问题 ids、未检查范围或限制和继续入口；不得复制 Gate artifact 内容，也不得要求 Coordinator 扫描目录推断最新记录。
- XR-007：`accepted` 要求上游声明 `scout-directory-sha256-v1`，且其 digest 与 Validator 在检查前后独立计算的稳定 digest 完全一致。
- XR-008：没有唯一 canonical Verification Report ref、accepted Research Gate context、全部适用 inspection contracts 和稳定 report digest 时不得形成 Verification Report Gate。
- XR-009：Research Pack Gate 和 Verification Report Gate 必须由两个独立 Validator task 执行；一个 task 不得切换检查对象类型。
- XR-010：Verification Report Gate 的 `accepted` 要求 report 完整覆盖 Manual、逐项状态语义正确、evidence refs 可定位且未检查范围为空；不要求所有 verification point 为 `verified`。
- XR-011：每次 Verification Report 检查只产生一份新的 Gate 记录；report 修正后的复查必须创建下一份记录。
- XR-012：Verification Report Gate handoff 必须明确引用本次 Gate、checked report ref / digest、问题 ids、未检查范围或限制和继续入口，不得复制 Gate artifact 内容。

## Evidence Rules (Enforcement)

- ER-001：每个 Gate 判断必须引用实际 artifact ref、适用 contract、source locator 或明确缺失项。
- ER-002：上游 handoff、自检结果、progress 和普通 summary 不能替代 Validator 的独立检查。
- ER-003：knowledge evidence 不能单独证明当前 implementation claim；代码 claim 必须回到声明版本的 source symbol 和 key lines。
- ER-004：引用存在不等于支持 claim；必须核对 claim、evidence、supports、limitations 和 verification point 的关系。
- ER-005：Gate 报告只证明指定 digest 内容的检查结果；Research Pack Gate 不证明运行时行为，Verification Report Gate 不改变 report 中的逐项状态。
- ER-006：Signal contract 只证明 requirement 结构和解释语义可检查，不证明对应信号能够在目标环境被采集。
- ER-007：`verified` 和 `not_verified` 必须分别由直接满足或直接反证 requirement 的可定位 observation 支撑；失败、空结果和未执行不能支撑二者。

## Failure Rules (Enforcement)

- FR-001：读取、digest、解析或来源定位命令失败时，记录命令、错误、重试和受影响范围。
- FR-002：模板字段、状态组合、evidence id、locator 或引用不闭环时，不得通过自然语言解释覆盖失败。
- FR-003：报告写入或正式 handoff 失败时不得用普通消息冒充 Gate 已提交。
- FR-004：无法读取当前代码来源时不得把 knowledge 或 CodeGraph 候选提升为 source-verified evidence。
- FR-005：上游 digest algorithm 非 `scout-directory-sha256-v1`、digest 缺失或与独立计算结果不一致时必须记录 `V-*` 问题并使用 `needs_fix`，不得降级为 limitation 后输出 `accepted`。
- FR-006：Verification Report 用失败、空结果或未执行支持 `verified` / `not_verified` 时必须记录 `V-*` 问题，不得通过自然语言补足 observation。

## Blocking Rules (Enforcement)

- BR-001：缺少当前 task 唯一检查对象、适用 inspection contract、`scoutArtifactDigest` 能力或 Validator artifact 写权限时必须 blocked。
- BR-002：权限或环境导致关键输入不可读并阻止必要检查时必须 blocked。
- BR-003：检查对象在检查过程中持续变化时必须 blocked，不得绑定过期 digest。
- BR-004：检查对象可读但 evidence 本身不足时使用 `insufficient_evidence`，不得错误归类为 blocked。

## Retry Rules (Enforcement)

- RR-001：只对瞬时、只读失败进行一次有限重试，并记录 retry log。
- RR-002：目标 digest 首次变化时允许对新 digest 重新检查一次；再次变化后停止。
- RR-003：不得通过修改上游 artifact、contract、repo、版本或检查范围制造重试成功。
- RR-004：Researcher 或 Verifier 提交修正后属于新的内容检查，不沿用旧问题关闭状态，并写入新的 Gate 记录。

## Prohibited Rules (Enforcement)

- PR-001：禁止写入 Researcher / Verifier artifact、其它 Worker mount 或 logs。
- PR-002：禁止补写 Research / Verification evidence、重新编号 evidence id 或替上游 Worker 修复问题。
- PR-003：禁止把 Gate 描述为 Verification 已执行、BDD 已通过或全局 Validation 已完成。
- PR-004：禁止为使用 producer Skill 而继承或执行其生产命令和副作用能力。
- PR-005：禁止创建强 schema 状态投影或第二套 Gate registry。
- PR-006：禁止把 Gate artifact 和 handoff 的英文 Markdown 标题改成中文，或在标题下使用非中文自然语言内容；contract 字段和值除外。
- PR-007：禁止复用 Research Pack Gate task 检查 Verification Report，或在同一 Gate artifact 混合两类检查。
- PR-008：禁止因 Verification Report 如实包含 `not_verified`、`insufficient_evidence` 或 `blocked` 就改写其逐项状态。

## Example

输入：

```text
Researcher task researcher-task-0001 提交一个 Research pack，handoff state 为 complete。
```

流程：

1. 定位唯一 pack，读取 inspection contracts，并计算初始 digest。
2. 检查 pack 结构、独立 evidence、聚合关系、registry 和下游手册引用。
3. 核对 BDD、knowledge 与当前版本 source symbol 证据。
4. 重新确认 digest，写入下一份 `research-pack-gate-NNNN.md` 并提交明确引用该文件的正式 handoff。

输出：

- Validator 私有 artifact 中的一份新增、不可变 Research Pack Gate 报告。
- `accepted | needs_fix | insufficient_evidence | blocked` Gate、pack digest、问题 ids 和未检查范围。

Verification Report 输入：

```text
Verifier task verifier-task-0001 提交 canonical verification-report.md，并引用 accepted Research Pack Gate。
```

流程：

1. 在新的 Validator task 中定位唯一 report、accepted Research Gate context 和 inspection contracts，并计算初始 digest。
2. 核对 report 结构、Manual 覆盖、逐项状态语义、observation evidence 和 provenance。
3. 重新确认 digest，写入下一份 `verification-report-gate-NNNN.md` 并提交固定 handoff。

输出：

- Validator 私有 artifact 中的一份新增、不可变 Verification Report Gate 报告。
- `accepted | needs_fix | insufficient_evidence | blocked` Gate、report digest、问题 ids 和未检查范围。
