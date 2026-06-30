---
assetKind: scout.skill
name: scout-bdd-verification
description: Scout worker 围绕 BDD 执行 ResearchArtifact、VerificationReport、ValidationResult 产物链路，保证验证过程可审计、可重放、可历史积累。
id: skills.scout.bdd-verification
version: 0.1.0
phase: [research, verify, validate]
tags: [scout, bdd, evidence, replay, audit, knowledge]
devices: [any]
summary: 以 BDD 为输入，按角色产出可追溯 ResearchArtifact、BDD VerificationReport 或 ValidationResult。
---

# Scout BDD Verification

当 Scout worker 接到 Coordinator 分配的 BDD 研究、证据验证或产物 gate 任务时使用本技能。

本技能服务于一个目标：把 BDD 验证做成可审计、可重放、可历史积累的状态转换链路。它不是聊天指南，也不是通用代码审查流程。

## 状态模型

- Activity State：工具调用、命令、日志、plan、progress、错误和 token 记录。它证明“发生过什么”，不能直接证明 BDD 成立。
- Validation State：ResearchArtifact、VerificationReport、ValidationResult、TaskResult、artifact refs、evidence refs、人工确认和阻塞原因。它才可以推动业务状态。
- Evidence Candidate：知识库命中、CodeGraph 结果、源码片段、配置、日志、历史记录和用户补充。候选证据必须被整理进正式 artifact 后才能支撑结论。
- Gate：Validator 对 artifact、schema、字段、证据引用、状态一致性和风险披露的校验结论。

所有 worker 都必须把当前角色结果写入 `SCOUT_ARTIFACT_ROOT`，再用 `TaskResult` 引用 artifact refs 与 evidence refs。

## 通用执行顺序

1. 用 `scout-assets list` 和 `scout-assets skills/tools/mcp/plugins` 确认可用能力。
2. 确认 Coordinator task 中的目标状态、输入 refs、角色职责和完成门槛。
3. 缺少当前角色必要输入时，调用 `RequestUserInput` 或用 `TaskResult` 报告需要 Coordinator 补充。
4. 收集证据候选，并记录收集方法、命令、路径、版本和不确定性。
5. 写入当前角色 artifact。
6. 用 `TaskResult` 提交状态、artifact refs、evidence refs、缺口和下一步建议。

禁止只输出自然语言总结。禁止把未写入 artifact 的临时观察作为正式结论。

## Researcher：ResearchArtifact

Researcher 负责把外部输入和知识库上下文清理为后续验证可用的内部输入。Researcher 不做 BDD pass/fail 判断。

输入可以是用户 BDD、issue、PR 描述、讨论记录、知识库路径、source refs 或已有 Scout Input。

Researcher 必须产出 `research-artifact.json` 或同等稳定路径，建议结构：

```json
{
  "artifact_type": "ResearchArtifact",
  "artifact_version": 1,
  "status": "complete | prompt_required | insufficient_evidence | blocked",
  "bdd": {
    "scenario_id": "",
    "given": [],
    "when": [],
    "then": [],
    "acceptance_criteria": []
  },
  "source_refs": [],
  "knowledge_refs": [],
  "implementation_hints": [],
  "uncertainty_items": [],
  "replay_context": {
    "knowledge_root": "",
    "collection_methods": [],
    "commands": [],
    "codebase_candidates": [],
    "asset_commit_id": "",
    "run_id": ""
  }
}
```

Researcher 规则：

- BDD 缺少 Given / When / Then、场景身份或验收语义时，必须请求补充。
- 知识库内容必须降噪，只保留当前 BDD 验证相关的 capability、约束、历史记录、实现触点和风险。
- `~/.guru/knowledge` 是知识库可信根；读取时必须记录具体文件、heading、段落、表格行或 locator。
- Jarvis codebase / CodeGraph 结果在 Researcher 阶段只能作为实现触点候选，不能作为最终验证结论。
- 不确定、冲突或来源不足的内容必须进入 `uncertainty_items`。

## Verifier：VerificationReport

Verifier 负责根据 ResearchArtifact / Scout Input 做 BDD 证据验证。Verifier 不清洗原始外部材料，不做最终 gate。

Verifier 必须产出 `verification-report.json` 或同等稳定路径，建议结构：

```json
{
  "artifact_type": "VerificationReport",
  "artifact_version": 1,
  "status": "verified | not_verified | insufficient_evidence | blocked",
  "bdd_ref": {},
  "research_artifact_refs": [],
  "evidence_matrix": [],
  "code_evidence": [],
  "knowledge_evidence": [],
  "activity_refs": [],
  "gaps_and_risks": [],
  "replay_context": {
    "codebase": [],
    "knowledge_root": "",
    "codegraph_status": [],
    "commands": [],
    "asset_commit_id": "",
    "run_id": ""
  }
}
```

Verifier 规则：

- 每条 Then / acceptance criterion 都必须有独立结论：`verified`、`not_verified`、`insufficient_evidence` 或 `blocked`。
- 每个结论必须引用 evidence refs，并解释证据如何支持或为什么不足。
- 对 Guru 托管代码库，先用 `jarvis codebase <repo> path` 解析路径，再用独立 `codegraph` CLI 检索语义。
- CodeGraph 定位到文件、符号或调用关系后，才读取源码片段做核验。
- `rg` 不能作为 Guru 托管代码库的首选源码语义检索。CodeGraph 失败时必须记录失败命令；只有 Coordinator 明确授权，才允许标记为 `rg-fallback` 的低置信度回退。
- `code_evidence` 必须记录 repo、version/branch、相对路径、locator、符号、收集命令和源码摘要。不要把本机绝对路径作为唯一证据。
- 工具调用输出属于 activity ref；它必须与源码、配置、日志或知识库解释性证据闭环后，才能支撑 BDD 结论。

## Validator：ValidationResult

Validator 负责 artifact / evidence / state consistency gate。Validator 不重跑业务验证，不补做 Verifier 工作。

Validator 必须产出 `validation-result.json` 或同等稳定路径，建议结构：

```json
{
  "artifact_type": "ValidationResult",
  "artifact_version": 1,
  "gate_status": "accepted | needs_fix | insufficient_evidence | blocked",
  "checked_artifact_refs": [],
  "field_findings": [],
  "evidence_findings": [],
  "state_consistency_findings": [],
  "replay_findings": [],
  "minimum_fixes": []
}
```

Validator 规则：

- 检查 artifact 类型、必填字段、状态枚举、artifact refs 和 evidence refs 是否闭环。
- 检查 Activity State 是否被误用为 BDD pass/fail 结论。
- 检查 `TaskResult(status="complete")` 是否与 artifact 内容一致。
- 检查是否具备可审计和可重放信息：输入 refs、知识库路径、codebase repo、版本/branch、相对路径、收集方法、命令和缺口。
- 不合格时只给最小修复项，不替其它 Agent 修改业务产物。

## 历史积累规则

可进入历史积累的内容必须满足：

- 来自已写入 artifact 的 Validation State。
- 有 evidence refs 支撑。
- 经过 Validator gate，或明确标记为未 gate / 候选。
- 同时保留结论、证据、缺口、风险、版本和决策原因。

禁止把聊天 summary、plan、progress、未验证工具结果或未 gate 推断写成历史事实。
