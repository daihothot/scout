---
assetKind: scout.skill
name: tool-guru-knowledge
description: Scout Agent 从 Guru Knowledge 定位 Behavior、Domain、Module、Capability、Availability、API 和 Platform 文档，记录可重放来源并形成知识证据时使用。
id: tool-guru-knowledge
version: 0.11.2
phase: [research, research-reviewer, verify-reviewer]
family: [tool, guru]
tags: [guru, knowledge, bdd, capability, evidence, source]
devices: [any]
dependencies:
  shellTools:
    required: [scoutAssets, git]
    optional: [rg, sed, find, cat]
summary: 只读检索 Guru Knowledge，并形成可追溯的 Capability、Availability 和 Platform 知识证据。
---

# Tool Guru Knowledge

当 Scout Agent 需要从 Guru Knowledge 定位 Behavior 候选、Capability 规格、版本可用性或平台差异，并把来源整理成可复查知识证据时使用本技能。

本技能只拥有 Guru Knowledge 的读取方法、来源语义、采集规则和知识明细证据模板。调用方拥有业务选择、Research Pack 聚合、人工确认和下游验证决策。

## Skill Type

- type: tool
- structure_level: full
- note: 本技能是 Guru Knowledge 只读采集工具 Skill，不是 Validation Domain 工作流。

## Core Use

使用本技能处理：

- 确认当前 mount 是否允许读取 Guru Knowledge 和使用只读文件工具。
- 在明确产品边界内定位 Behavior 候选、Domain、Module 和 Capability。
- 读取 Capability Specifications 的固定维度、Availability、API 和 Platform 文档。
- 记录 knowledge repository branch、commit、working tree state、来源文件和可重放 locator。
- 在调用方已确定 BDD、目标版本、目标平台、evidence id 和 artifact target 后，形成 `E-CAP-*`、`E-AVAIL-001` 和 `E-PLATFORM-001` 明细证据。
- 记录读取失败、来源冲突、缺失文档、重试结果和知识证据限制。

不使用本技能处理：

- 从多个 Behavior 候选中替调用方决定唯一 BDD。
- 创建或拥有 `bdd-evidence.md`、`knowledge-evidence.md`、`code-evidence.md`、`evidence-registry.md` 或 `verification-manual.md`。
- 分配 Research Pack 的 evidence id、决定 pack 状态或提交 Research handoff。
- 创建 `E-PERSONA-*`、`E-HUMAN-*`、`E-CODE-*` 或 runtime observation evidence。
- 判断 BDD 是否通过、当前版本是否实现目标行为或 runtime 是否观察到目标行为。
- 发起人工请求、解除 Human Confirmation Gate 或决定 Validation 流程下一阶段。
- 写回、修改、迁移或修复 Guru Knowledge。

## Knowledge Source Model

GuruSdk Knowledge 默认产品根：

```text
~/.guru/knowledge/Products/GuruSdk
```

核心区域：

- `index.md`：产品边界、Domain 地图和维护规则。
- `Behaviors/`：BDD 与行为定义；来源状态不等于本次验证结果。
- `Domains/`：Domain、Module、Capability、Specifications、Availability、API 和平台文档。

来源语义：

- Behavior 描述意图、场景前提、触发动作和预期行为。
- Domain、Module 和 Capability 描述职责、边界和上下游关系。
- Capability Specifications 描述能力规格，不证明当前版本代码已经实现。
- Availability 描述版本可用性，不替代当前版本源码核验。
- API Index 和 API 文档只作为 Capability 的来源，不单独形成 API evidence。
- Platform 文档描述共享契约和平台差异，不证明真机运行结果。

Capability Specifications 使用以下 11 个固定维度：

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

## Source And Provenance Rules

- Knowledge root 必须来自当前可读路径或调用方明确提供的 knowledge ref，不得根据示例路径假定其它产品结构相同。
- 所有 canonical source path 使用 knowledge root 下的产品相对路径。
- 标题、段落、表格行或 frontmatter 字段必须形成可重复定位的 locator。
- Knowledge repository provenance 必须记录 branch、完整 commit 和 working tree state。
- 本机绝对路径只允许作为当前 Scout run 的读取 provenance，不得写成 canonical knowledge ref。
- working tree 非 clean 时必须记录受影响来源；不得把未提交内容冒充 commit 可重放事实。
- draft、legacy、migration、deprecated、unresolved 或其它来源状态必须保留，不能被采集过程提升为稳定事实。

## Read-Only Operations

读取前先确认当前 mount 能力：

```bash
scout-assets tools
```

常用只读操作：

```bash
find "<knowledge-root>" -type f
rg -n "<behavior-or-capability-term>" "<knowledge-root>"
sed -n '<start>,<end>p' "<knowledge-file>"
git -C "<knowledge-repository>" branch --show-current
git -C "<knowledge-repository>" rev-parse HEAD
git -C "<knowledge-repository>" status --short
```

使用规则：

- 优先从产品 `index.md`、Behavior identity 和 Domain/Capability 导航收敛范围，再做正文搜索。
- `rg` 命中只用于候选定位；正式证据必须继续读取完整 frontmatter、所属章节和必要上下文。
- 不得用文件名相似、单个关键词或搜索摘要替代来源语义核验。
- 同一 claim 存在互相冲突的有效来源时必须保留冲突，不得自行选择更符合预期的一条。
- 命令失败时记录命令、错误摘要、影响范围和重试结果。

## Inputs

### I-001: Mount Capability

---

描述：

- 当前 mount 可见本技能、`scout-assets`、`git` 和完成只读定位所需的文件工具。

注意事项：

- 使用 `scout-assets tools` 确认能力可见性。
- 缺少 required capability 时停止，不得用未挂载入口绕过 profile。

### I-002: Knowledge Boundary

---

描述：

- 明确的产品、knowledge root 或调用方提供的 knowledge refs。

注意事项：

- 默认产品边界只适用于 GuruSdk。
- 其它产品必须由调用方明确提供根目录和来源约束。
- Knowledge ref 是待核验来源，不自动成为当前任务事实。

### I-003: Knowledge Query Target

---

描述：

- Behavior ID、场景描述、Capability、功能点、版本、平台或需要查证的知识 claim。
- 查询可以处于候选定位模式，也可以基于调用方已确认的唯一 BDD 收集明细证据。

注意事项：

- 候选定位模式只返回候选及来源，不写正式 evidence artifact。
- 正式知识证据模式必须包含调用方已经确认的唯一 BDD ref。

### I-004: Evidence Scope

---

描述：

- 调用方确认的目标版本、目标平台、相关 Capability 范围和分配的 evidence ids。

注意事项：

- 缺少目标版本时不能形成确定的 Availability claim。
- 缺少目标平台时不能形成确定的 Platform claim。
- 本技能不自行扩大 Capability 范围；发现必要上下游时作为候选返回调用方确认。

### I-005: Artifact Target

---

描述：

- 调用方指定的可写 artifact 目录及允许写入的 evidence 文件。

注意事项：

- 本技能不创建新的 canonical pack 目录。
- 只写调用方明确分配的 `E-CAP-*`、`E-AVAIL-001` 和 `E-PLATFORM-001`。
- 没有明确 artifact target 或 evidence id 时只返回只读结果。

## Knowledge Workflow

- Phase 1：确认 mount、产品边界和 knowledge repository provenance。
- Phase 2：定位 Behavior 候选并读取完整场景上下文。
- Phase 3：定位相关 Domain、Module、Capability 和 Specifications。
- Phase 4：逐项收集 Capability 的 11 个规格维度及来源。
- Phase 5：收集目标版本 Availability 和目标平台 Platform 来源。
- Phase 6：形成知识采集结果，或在调用方授权范围内写入知识明细 evidence。

## Phase 1: Confirm Boundary And Provenance

---

- 确认 `scout-assets`、knowledge root 和只读文件工具可用。
- 从 knowledge repository 读取 branch、完整 commit 和 working tree state。
- 确认目标产品位于调用方给定边界内，不跨产品搜索补齐缺失事实。

Exit：

- Knowledge root、产品边界、repository provenance 和查询目标均已确定。

Blocked：

- 路径不可读、repository identity 不可确认或产品边界不明确时停止。

## Phase 2: Locate Behavior Candidates

---

- 按 Behavior ID、ref 或场景语义定位候选，并读取每个候选的 identity、status、Given、When、Then、Expect 和可重放 locator。
- 返回所有仍然有效的候选、冲突和排除依据，不替调用方选择唯一 BDD。
- issue、PR、用户描述或关键词只作为定位线索，不能替代 Behavior 来源。

Exit：

- 已形成带完整来源和 locator 的候选集合。

Blocked：

- 没有可重放候选或来源结构无法解析时返回阻塞事实。

## Phase 3: Resolve Related Knowledge

---

- 基于调用方已确认的唯一 BDD，定位所属 Domain、Module、primary Capability 及必要上下游 Capability。
- 读取 Capability identity、scope、Specifications、Availability、API 和 Platform 来源。
- 发现范围外但可能相关的 Capability 时只返回 candidate，不自行扩大正式 evidence scope。

Exit：

- 已形成相关 Capability 候选、关系、来源和冲突。

## Phase 4: Collect Capability Evidence

---

- 使用调用方分配的 `E-CAP-*`，为每个已确认相关 Capability 填写独立 artifact。
- 逐项处理 11 个规格维度；每个维度记录 coverage state、claim、`CAPSRC-*` 和 gap 或 rationale。
- API Index 与 API 文档只能成为 `CAPSRC-*`，并进入“数据与接口”维度。

Exit：

- 每个正式 Capability 都有一份符合模板的独立 artifact。

Blocked：

- 必需来源缺失或冲突时对应 artifact 保持 `candidate` 或 `blocked`。

## Phase 5: Collect Availability And Platform Evidence

---

- 使用调用方提供的完整 `E-CAP-*` 范围和目标版本形成唯一 `E-AVAIL-001`。
- 使用相同 Capability 范围和目标平台形成唯一 `E-PLATFORM-001`。
- 两份聚合 evidence 都必须覆盖全部正式 `E-CAP-*`，并保留来源状态、缺口和限制。

Exit：

- Availability 与 Platform artifact refs 已形成并与 Capability 范围一致。

Blocked：

- 目标版本或目标平台缺失、来源冲突影响必需 claim，或者 Capability 覆盖不完整时不得标记为 `ready`。

## Phase 6: Return Result Or Write Evidence

---

- 候选模式只返回 `Guru Knowledge Result`，不写正式 artifact。
- 正式 evidence 模式只写调用方分配的文件，并返回 artifact refs、provenance、冲突、失败命令和限制。
- 不构建 knowledge aggregate、registry、manual、digest 或 handoff。

## Output Contract

候选定位或只读采集结果使用以下英文标题，内容使用中文：

```markdown
# Guru Knowledge Result

## Source Refs
## Candidate Evidence
## Conflicts
## Commands
## Failed Commands
## Limitations
```

正式 artifact 仅允许使用：

```text
templates/capability-evidence.md
templates/availability-evidence.md
templates/platform-evidence.md
```

模板关系：

- `capability-evidence.md`：每个相关 Capability 一份 `E-CAP-*`，登记身份、范围、来源和 11 个规格维度。
- `availability-evidence.md`：调用方当前证据范围内唯一的 `E-AVAIL-001`，跨相关 `E-CAP-*` 聚合目标版本可用性。
- `platform-evidence.md`：调用方当前证据范围内唯一的 `E-PLATFORM-001`，跨相关 `E-CAP-*` 聚合目标平台共享契约和差异。
- API Index 和 API 文档登记为对应 `E-CAP-*` 的 `CAPSRC-*`，并写入“数据与接口”维度；禁止创建 `E-API-*`。

## Artifact Relationship Rules

- 本技能拥有 `E-CAP-*`、`E-AVAIL-001` 和 `E-PLATFORM-001` 的知识明细模板与采集语义。
- 调用方拥有 evidence id 分配、artifact target、正式 Capability scope 和聚合关系。
- 本技能写出的 evidence 必须位于调用方授权目录，不能自行创建或命名 Research Pack。
- `E-CAP-*` 一条 artifact 只描述一个 Capability；不同 Capability 不得合并。
- `E-AVAIL-001` 和 `E-PLATFORM-001` 分别只形成一份，并引用调用方提供的全部 `E-CAP-*`。
- 本技能不拥有 `E-BDD-001` 或 `E-KB-001`；Behavior 候选和知识明细由调用方聚合。
- 本技能不创建 Persona、Human、Code 或 runtime evidence，也不修改其它 producer artifact。

## Native Subagent Strategy

- 父 Agent 自主判断只读知识范围是否适合委派；只有边界稳定、互不依赖且预期节省时间时才派发。
- 委派前必须由父 Agent 锁定 knowledge root、产品边界、查询目标和只读范围。
- Child 只读取 knowledge 并返回 `Source Refs`、`Candidate Evidence`、`Conflicts`、`Commands`、`Failed Commands`、`Limitations`。
- Child 不选择唯一 BDD、不分配 evidence id、不写正式 artifact、不发起人工请求，也不调用 Scout dynamic tools。
- 父 Agent 必须核验将进入正式 evidence 的关键 locator，并负责所有正式 artifact 写入。
- 父 Agent 不得与仍在执行的 child 重复进行同一完整检索；child 失败后可以停止对应 child 并收回该范围。

## Evidence Rules

- ER-001：Knowledge evidence 只能支撑 intent、spec、behavior、availability、API semantics 和 platform boundary。
- ER-002：Knowledge evidence 不能单独证明当前版本 implementation claim 或 runtime behavior observed claim。
- ER-003：每个 `E-CAP-*` 必须逐项登记 11 个规格维度；`covered` 必须包含具体 claim 和 `CAPSRC-*`。
- ER-004：`not_applicable`、`not_found` 和 `needs_confirmation` 必须记录 gap 或 rationale。
- ER-005：每个正式采集范围只允许一份 `E-AVAIL-001` 和一份 `E-PLATFORM-001`，并覆盖调用方提供的全部 `E-CAP-*`。
- ER-006：来源文档状态和限制必须进入 evidence，不得在摘要中丢失。
- ER-007：完整来源正文保留在 Guru Knowledge；artifact 只记录必要 claim、locator 和限制。

## Failure Rules

- FR-001：knowledge 文件不可读、frontmatter 无法解析或 locator 不可重放时，记录失败及受影响候选或 evidence id。
- FR-002：来源互相冲突时返回冲突和全部有效 refs，不得自行消解。
- FR-003：关键来源缺失时不得生成 `ready` evidence。
- FR-004：knowledge repository working tree 影响当前来源时必须披露，不能声称该事实仅由 commit 支撑。
- FR-005：Git provenance 查询、knowledge repository 状态或其它本技能声明的外部能力发生错误、空输出、权限失败、参数失败、超时或状态不确定时，必须立即停止当前依赖范围，并通过正式 `RequestHumanInput` 请求人工解决；请求必须说明失败命令、原始错误摘要、受影响 repository/path、已确认 provenance、缺失的解除条件和修复后需要重新执行的检查。

## Blocking Rules

- BR-001：knowledge root 不可读或产品边界不明确时停止。
- BR-002：正式 evidence 模式缺少唯一 BDD ref、目标版本、目标平台、evidence id 或 artifact target 时停止写入，只返回当前可确认结果。
- BR-003：Capability 的必要规格来源无法定位时，对应 evidence 保持 `candidate` 或 `blocked`，不得补写推断事实。

## Retry Rules

- RR-001：本技能声明的 Git provenance、knowledge repository 或其它外部能力首次失败后不得自动重试；必须立即停止当前依赖范围并请求人工。
- RR-002：不得自行修改、修复、替换或重新绑定 knowledge repository，也不得改用未由本技能声明的其它来源绕过失败。
- RR-003：人工修复并明确回复后，才能从失败阶段重新执行必要检查；重跑必须记录修复后的命令、输出和 provenance 差异。

## Prohibited Rules

- PR-001：禁止写回、修改、迁移或自动修复 Guru Knowledge。
- PR-002：禁止把 Behavior、Capability 或 Platform 文档的存在解释为本次验证通过。
- PR-003：禁止把 draft、legacy、migration、deprecated 或 unresolved 内容提升为稳定事实。
- PR-004：禁止创建 Research Pack 顶层文件、Evidence Registry、Verification Manual、用户画像或人工确认 evidence。
- PR-005：禁止创建 `E-API-*`，也禁止用 Knowledge evidence 替代 source code 或 runtime evidence。
- PR-006：禁止在没有调用方授权时选择唯一 BDD、扩大 evidence scope 或写正式 artifact。

## Workflow Exit Rules

- XR-001：候选模式返回可重放来源、冲突、失败命令和限制，不生成正式 evidence。
- XR-002：正式 evidence 模式只生成调用方分配的知识明细 evidence，并返回 artifact refs。
- XR-003：存在关键冲突或缺失时明确返回阻塞事实，由调用方决定人工确认或 Domain 流程状态。
- XR-004：本技能结束不代表 Research Pack 完成，也不代表任何 BDD 验证结论。

## Example

输入：

```text
调用方提供唯一 BDD ref、产品边界、目标版本、目标平台、Capability scope、evidence ids 和 artifact target。
```

流程：

1. 确认 knowledge repository provenance。
2. 核对 BDD 来源并收集相关 Capability knowledge。
3. 写入调用方分配的 Capability、Availability 和 Platform evidence。
4. 返回 artifact refs、冲突、失败命令和限制。

输出不包含 Research Pack 聚合、Registry、Manual、人工请求或验证结论。
