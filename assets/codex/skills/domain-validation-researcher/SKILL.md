---
assetKind: scout.skill
name: domain-validation-researcher
description: Scout Researcher 在 Validation Domain 中接收 BDD 定位输入、调用适用研究方法，并形成可供 Research Pack Gate 检查的可追溯 handoff 时使用。
id: domain-validation-researcher
version: 0.5.9
type: domain
phase: [research]
family: [validation, workflow]
tags: [scout, validation, bdd, research, workflow]
devices: [any]
dependencies:
  skills:
    required: [domain-validation-research-pack, internal-skill-consumption, tool-scout-request-human-input, tool-scout-send-message, tool-scout-submit-task]
  shellTools:
    required: [find, sort]
summary: 规范 Validation Researcher 的输入收敛、方法委派和领域 handoff。
---

# Domain Validation Researcher

当 Researcher 在 Validation Domain 中需要把 BDD 定位输入收敛为可供下游消费的 Research handoff 时使用本技能。

本技能定义 Validation Research 的角色工作流；Research Pack 编排由 `domain-validation-research-pack` 所有，知识与代码采集方法分别由 `tool-guru-knowledge` 和 `tool-jarvis-codebase` 所有。

## Skill Type

- type: domain
- layout: workflow
- note: 本技能是领域入口 Skill，不复制专项研究 Skill 的模板、命令或证据结构。

## Core Use

使用本技能处理：

- 检查 Coordinator task 是否提供可定位的 BDD 输入和当前研究边界。
- 选择并执行当前 Validation task 所需的研究方法 Skill。
- 区分已确认输入、来源内容、研究归纳、候选和未确认项。
- 将专项研究产物整理成稳定 Research handoff。

不使用本技能处理：

- 自行扩展到未分配的 BDD、产品、版本或来源范围。
- 重复定义 `domain-validation-research-pack` 的 evidence pack、模板或验证手册字段。
- 执行运行时验证、判定 BDD 是否通过或执行最终 gate。
- 直接向用户请求输入。

## Signal Consumption

`Signal set` 是当前 Validation role 必须作为一个整体消费的 Signal Skill 集合。`general Signal set` 是每个 Validation Research task 都必须消费的通用集合；`capability Signal set` 是 BDD 已确认涉及某个 Capability 后必须消费的专项集合。`<capability>` 表示该 Capability 的实际目录名。

本领域当前 Signal 根目录为：

```text
.scout/skill/signal/local/unity/general/
```

### Freeze General Signal Set

在调用知识、代码或其它研究工具前，执行一次以下命令：

```bash
find -L .scout/skill/signal/local/unity/general -mindepth 2 -maxdepth 2 -type f -name 'SKILL.md' -print | sort
```

将排序后的完整输出冻结为当前 task 的 `general Signal list`。目录不可读、命令失败或列表为空时，不得开始依赖该集合的研究。

### Freeze Capability Signal Set

- 只根据 BDD fact 与已确认 Capability 选择 `<capability>`；尚未确认时不猜测、不预读。
- 每选择一个 `<capability>`，在形成相关 research claim 或 verification manual requirement 前执行一次以下命令：

  ```bash
  find -L .scout/skill/signal/local/unity/general/<capability> -mindepth 2 -maxdepth 2 -type f -name 'SKILL.md' -print | sort
  ```

- 将排序后的完整输出冻结为该 `<capability>` 的 `capability Signal list`。目录不可读、命令失败或列表为空时，不得开始依赖该集合的研究。

### Consume Frozen Sets

1. 按 `general Signal list` 的固定顺序，将每个入口分别作为 `<target-skill-path>`，完整执行 `internal-skill-consumption`。
2. 按每个 `capability Signal list` 的固定顺序执行同样处理。
3. 只有集合内每个成员都通过 `internal-skill-consumption` 的 readiness gate，才能开始依赖该集合的工作；不得因名称、摘要或预判不适用而跳过成员。

Researcher 使用已完成的集合理解 interface contract、derived contract 和可表达的 verification requirement，不选择 implementation candidate，也不执行 acquisition。通用集合完成不表示任意 Capability 已选择。完整消费失败时停止受影响研究范围并报告实际缺口；不生成 coverage 或 applicability 记录。

## Validation Research Model

- Coordinator 提供的是 BDD 定位输入；唯一 BDD fact 由 Researcher 使用专项研究方法确认。
- Research artifact 负责锁定待验证功能点、来源、证据、限制和需人工确认项，不是运行时验证结论。
- Guru Knowledge 与当前版本代码属于不同 producer 来源，必须分别遵守对应 Tool Skill。
- `domain-validation-research-pack` 是当前 Validation Research 的编排和聚合产物所有者，本技能只负责进入条件和领域 handoff。
- Research handoff 的 complete、partial 或 blocked 必须与实际专项产物状态一致。
- 同一 run/BDD 只维护一个 `<bdd-id>-research-pack/`；Gate 修正原地写入该 pack，并以新 digest 再次 handoff。

## Human Confirmation Gate

- 仅当适用专项 Research Skill 判定某项必需事实无法从当前输入、证据或可用能力确认，并阻止唯一 BDD、目标版本证据、研究范围或必需产物闭环时，进入本 Gate。
- 进入本 Gate 后立即停止当前研究，不继续处理后续阶段；已经形成的 artifact、evidence 和 limitation 保留当前状态。
- 通过正式人工请求入口提出一次最小问题并保持当前 task 为 `running`；Gate 未解除时不得进入 Phase 3，也不得提交任何 Research handoff。
- 可选未知项是否进入本 Gate 完全遵循专项 Research Skill。
- 只有与待确认事实、当前 task 和研究目标明确匹配的用户确认才能解除本 Gate；解除后从当前研究阶段继续。

## Native Subagent Strategy

- 本技能明确授权父 Researcher 自主决定是否使用 Codex native subagent 加速当前 Research task；是否派发、派发数量以及并行或串行方式由父 Researcher 根据实际效率判断，不形成新的 Scout task，也不改变当前 task 的生命周期。
- 只有子任务目标、输入和退出边界稳定，能够独立推进，并且预期节省的时间高于启动、等待和聚合成本时才派发。存在未解除的 `Human Confirmation Gate` 时不得派发依赖该事实的 child。
- Knowledge 与 Code 是可选的 producer 拆分；具体边界、输入和返回结构分别遵守 `tool-guru-knowledge` 与 `tool-jarvis-codebase`。父 Researcher 可以委派其中一个、多个或均不委派，不得为了满足形式而派发。
- 父 Researcher 独占 Human Confirmation Gate、Persona/Human evidence、evidence id 与 ref 分配、正式 artifact 写入、checker、digest 和 Research handoff。
- child 独占已委派范围；父 Researcher 不得重新执行完整 knowledge scan 或 code scan，只能抽查 child 返回的关键 locator、解决冲突和验证会进入正式 claim 的最小片段。
- Child 输出、只读边界和 artifact 权限由对应 Tool Skill 约束；任何 child 都不能形成最终 Research 状态。
- 每个依赖 child 结果的写入批次必须等待对应结果返回并被父 Researcher 消费；空结果、超时或 `closeAgent` 清理都不能替代正式结果。
- 父 Researcher 决定不派发时直接自行执行，不需要记录 fallback 原因；派发失败或结果不可用时，可以收回该范围并继续，但必须先停止或释放对应 child，且不得与仍在执行的 child 重复工作。

## Inputs

### I-001: Research Task
---

描述：

- Coordinator synthesis 后的 task id、验证目标、已确认用户意图、输入 refs、预期交付和禁止越权边界。

注意事项：

- 不读取或拼接未通过 task 提供的其它 Agent 上下文。
- task 不属于 Researcher 时停止并交回 Coordinator。

### I-002: BDD Locator
---

描述：

- BDD ID、Behavior 文件路径或可定位的 Guru SDK 场景描述。

注意事项：

- 多个候选、无候选或场景语义不完整时，不得自行选择。

### I-003: Product and Version Boundary
---

描述：

- 当前产品、版本、branch、commit、平台、用户画像线索和来源 refs。

注意事项：

- 当前版本代码证据所需边界缺失时，按专项 Skill 记录 partial、blocked 或需人工确认项。
- 不主动选择 latest 或扩大到其它 codebase。

## Validation Research Workflow

- Phase 1：确认 task、BDD locator 和研究边界。
- Phase 2：加载并执行适用研究方法 Skill。
- Phase 3：核对专项产物状态并提交领域 handoff。

## Research Handoff Output Layout

本技能不定义新的 canonical artifact 或模板。

输出要求：

- 正式 artifact 及字段结构由 `domain-validation-research-pack` 定义。
- Research handoff 必须使用下列固定十字段；英文 Markdown 标题和字段 key 保持原样，字段内容使用中文，字段不得增加、删除、改名或展开为额外摘要：

```markdown
# Research Handoff State

- task_id: <当前 Researcher task id>
- handoff_state: <complete | partial | blocked>
- research_pack_ref: <唯一 pack ref>
- digest_algorithm: scout-directory-sha256-v1
- digest: <当前 pack digest>
- evidence_registry_ref: <evidence-registry.md ref>
- verification_manual_ref: <verification-manual.md ref>
- issues_or_limitations: <问题 ids 或最小限制；没有时写 none>
- human_confirmation_state: <resolved | not_required>
- continuation_entry: <下一步消费入口>
```
- Research handoff 不得复制 evidence claim、源码定位、verification point 的 Given / When / Then、signals to collect、checker 完整输出或 artifact 文件清单；这些内容只能通过正式 artifact ref 消费。
- `complete` 只表示当前 Research 交付完整，不表示 BDD 已通过验证。

### Artifact Relationship Rules

- 摘要产物：Research handoff 只传递专项 Research pack 的状态、关键 refs、digest、问题或限制和继续入口，不复制 pack 内容。
- 明细产物：知识和代码 evidence 分别由对应 Tool Skill 所有；聚合、Persona 和 Human evidence 由 `domain-validation-research-pack` 所有。
- Registry / Pack state：沿用专项 Skill 生成的 evidence registry；Pack 状态由 checker 根据必需聚合 artifact 派生，本技能不创建第二套状态 artifact。
- Claim owner：BDD、knowledge 和 implementation claim 的所有权遵守专项 Skill。
- 下游引用规则：Research Validator 先从正式 handoff 获取唯一 pack ref、digest、evidence registry ref 和 verification manual ref；只有对应 Research Pack Gate accepted 后，Coordinator 才把 Gate ref、同一 pack ref / digest 和 manual ref 交给 Verifier。
- Ref 字段策略：本技能只传递已有 ref，不产生第二套 artifact_ref 或 evidence id。
- 修正关系：Validator Gate 只适用于其记录的 digest；Researcher 在同一 pack ref 内修正后提交新 digest，不创建 revision pack 或 Gate follow-up artifact。

## Phase 1: Confirm Research Boundary
---

本阶段确认任务属于 Validation Research，并检查 BDD 与版本边界。

注意事项：

- 保留 Coordinator 已确认内容、未确认内容和输入 refs。
- 判断 BDD 是否唯一定位需要实际研究，不以 Coordinator 推断替代。
- 缺少必要能力或产物写入位置时记录阻塞项。

Exit：

- 已确认可执行的 Research scope 和适用研究 Skill。

Blocked：

- task 职责不匹配、BDD 输入无法进入定位流程或 required Skill 不可见时停止。

Partial：

- BDD 可定位但版本或其它必填事实边界不完整时，按专项 Skill 判断是否进入 `Human Confirmation Gate`；进入 Gate 后停留在当前 Phase，不得把 partial artifact 状态解释为允许 handoff。

## Phase 2: Execute Research Method
---

本阶段加载并执行 `domain-validation-research-pack`，由它编排两个 producer Skill、Domain 模板和 Evidence Pack。

注意事项：

- 必须读取当前 mount 中实际 Skill 内容，不凭记忆执行。
- 不复制或弱化专项 Skill 的 evidence、provenance、状态和验证手册规则。
- 工具活动只有整理进正式 artifact 后才能成为 Research handoff 的引用对象。
- 收到 Gate 问题时只修改原 `<bdd-id>-research-pack/`，不得创建 `-vN` 目录或 pack 副本。

Exit：

- 专项 Skill 已形成 complete、partial 或 blocked 的正式 Research 产物，且不存在尚未解除的 `Human Confirmation Gate`。

Blocked：

- 专项 Skill 的 required 输入、能力、模板或写入目标缺失时按其规则停止。

Partial：

- 专项 Skill 允许部分产出时，保留 phase resume、缺口和继续条件；存在尚未解除的 `Human Confirmation Gate` 时不得退出本 Phase。

## Phase 3: Submit Research Handoff
---

本阶段检查 Research 产物状态和 handoff 摘要是否一致，并通过正式 task 入口提交。

注意事项：

- handoff 必须包含 Verification Manual ref；尚未形成时明确说明停留阶段和原因。
- 不得在 handoff 中复制 artifact 文件列表、证据正文、关键验证点详情或检查工具完整输出。
- complete、partial、blocked 必须来自实际产物，不由自然语言自评。
- 每次 handoff 前必须执行 `scout-artifact-digest <research-pack-dir>`，并提交其返回的 `scout-directory-sha256-v1` digest；不得使用自定义目录摘要算法或继续引用修正前 digest。

Exit：

- 正式 Research handoff 已提交，且状态与产物一致。

Blocked：

- 产物无法写入、refs 不闭环或 handoff 无法提交时不得结束 task。

Partial：

- 不存在待人工确认的必需事实，且专项 Skill 允许部分交接时，可以提交 partial，并明确剩余工作、缺失条件和继续入口。

## Workflow Exit Rules (Enforcement)

- XR-001：不得跳过专项研究 Skill 定义的前置 Phase、模板或验证工具。
- XR-002：专项产物为 partial 或 blocked 时，领域 handoff 必须使用对应状态。
- XR-003：Research complete handoff 必须包含可供下游消费的 evidence registry ref 和 Verification Manual ref；详细证据和验证点只存在于对应 artifact。
- XR-004：Gate 修正后的 handoff 必须保持原 pack ref，并携带修正后 digest 和已处理问题 refs。
- XR-005：`Human Confirmation Gate` 未解除时必须保持当前 task 为 `running`，不得进入 Phase 3 或提交任何状态的 handoff。

## Evidence Rules (Enforcement)

- ER-001：Research 来源、knowledge evidence 和 code evidence 的成立条件由专项 Skill 定义。
- ER-002：Research artifact 只锁定验证内容和证据事实，不证明运行时行为已发生。
- ER-003：普通 summary、工具调用和共享记忆不得替代正式 evidence ref。

## Failure Rules (Enforcement)

- FR-001：专项 Skill、模板、命令或 artifact 写入失败时，保留 failed command、影响范围和 limitation。
- FR-002：BDD 无法唯一定位时不得继续形成唯一 verification point。
- FR-003：handoff 失败时不得用普通自然语言冒充正式 handoff。

## Blocking Rules (Enforcement)

- BR-001：缺少 `domain-validation-research-pack` 或其 required capability 时必须停止依赖阶段。
- BR-002：BDD 无法唯一定位时必须停止，并按 `Human Confirmation Gate` 判断是否需要上游确认。
- BR-003：正式产物不可写或无法提交时不得报告完成。

## Retry Rules (Enforcement)

- RR-001：重试遵守专项 Skill 的只读和副作用边界，并写入其 retry log。
- RR-002：不得通过更换 BDD、版本、repo 或来源范围制造成功。
- RR-003：同一外部错误或不可读入口在一次有明确新输入、环境变化或实质修复后的复测仍失败时，提交 blocked 或 partial，不循环执行相同失败路径；仅重写文字、重算 digest 或再次调用同一失败命令不构成新输入。

## Prohibited Rules (Enforcement)

- PR-001：禁止把 Research 结果描述为 BDD 已验证或 gate 已通过。
- PR-002：禁止复制专项 Skill 的模板和业务规则形成第二套产物。
- PR-003：禁止直接面向用户请求输入或自行扩大研究范围。
- PR-004：禁止用 `-vN`、副本目录或 `gate-followup.md` 保存 Research 修订历史。
- PR-005：禁止把 Research handoff 的英文 Markdown 标题改成中文，或在标题下使用非中文自然语言内容；contract 字段和值除外。

## Example

输入：

```text
Coordinator 分配 account-anon-first-launch-signin 的 Research task，并提供目标 SDK 版本。
```

流程：

1. 确认 BDD locator、版本和 task 边界。
2. 加载 `domain-validation-research-pack` 形成正式 Research pack。
3. 按实际产物状态提交 Research handoff。

输出：

- 专项 Skill 产生的 artifact refs 和 evidence refs。
- Research handoff state、唯一 pack ref、digest、evidence registry ref、Verification Manual ref、问题或限制、人工确认状态和继续入口；标题使用英文，内容使用中文。
