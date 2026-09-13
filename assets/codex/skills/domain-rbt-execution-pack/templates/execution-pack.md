---
scout:
  resource:
    requirement: required
    description: RBT Execution Pack identity、Agent 侧计划和 artifact refs 模板。
artifact_type: RBTExecutionPack
artifact_version: 1
pack_id: "<填写稳定 pack ID 原始值>"
target_version: "<填写目标版本原始值>"
status: draft
completion_state: partial
---

# RBT Execution Pack

## Pack State

- pack_id: <填写稳定 pack ID 原始值>
- status: <填写 draft、ready 或 blocked>
- completion_state: <填写 partial、complete 或 blocked>
- blocking_items: <无阻塞项时填写 none；否则说明阻塞事实>
- limitations: <无已知限制时填写 none；否则说明适用边界>

合法组合：

- `draft + partial`
- `ready + complete`
- `blocked + blocked`

Frontmatter 与本节中的 `pack_id`、`status`、`completion_state` 必须填写相同实际值。

## Execution Identity

- bdd_id: <填写唯一 BDD ID 原始值>
- bdd_source_ref: <填写可读 BDD source ref 原始值>
- capabilityId: <填写当前 BDD 或 Domain Skill 明确选择的 capability identity 原始值>
- bddScenarioId: <填写当前 BDD 明确声明或由 Domain Skill 明确映射的 scenario identity 原始值>
- target_version: <填写当前 managed codebase 的目标版本原始值>
- executor_role: executor

## Selected Behavioral Identities

- scenarioId: <填写稳定的 bddScenarioId；不加入 Scout run ID>
- campaignId: <填写 <scenarioId>/campaign/main；不加入 Scout run ID>
- rootId: <填写已确认的 root node ID；Runtime 尚未确认时填写待 Runtime 确认>
- hookNodeIds: <填写已确认的 Hook node IDs；Runtime 尚未确认时填写待 Runtime 确认>
- variantIds: <填写计划使用或检查的 variant IDs；没有时填写 none；Runtime 尚未确认时填写待 Runtime 确认>
- triggerCommandId: <填写已确认的 trigger command ID；Runtime 尚未确认时填写待 Runtime 确认>
- selection_basis: <说明每个 identity 的 BDD、Knowledge、代码或 schema 依据；identity 与 locator 保持原样>

### Required Given Hook Capability Mapping

把 `bdd-evidence.md` 中每条 required Given 拆成原子事实，并逐行登记。多个 Hook 共同建立一个事实时可以重复 `given_ref`；没有 Hook 能建立的事实也必须保留一行并写明 gap。

| given_ref | required_fact | nodeId | variantId | planned_params | runtime_effect | params_schema_support | capability_status | gap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| <填写 BDD Given locator 原始值> | <填写必须在 trigger 前成立的单一事实；技术值保持原样> | <填写当前 Runtime 返回的 node ID；没有时填写 none> | <填写当前 Runtime 返回的 variant ID；没有时填写 none> | <填写计划传入的实际参数；没有时填写 none> | <简述 Runtime descriptor 声明该 variant 能建立的事实；技术值保持原样> | <填写 supported 或 unsupported> | <填写 satisfied 或 missing> | <satisfied 时填写 none；missing 时填写尚不能建立的事实> |

- `capability_status: satisfied` 要求 node、variant、planned params、Runtime descriptor effect 与 `paramsSchema` 共同完整表达 `required_fact`。
- 同一个 Given 中任一原子事实为 `missing` 时，Pack 必须为 `blocked + blocked`，且不得调用 `behavior.campaign.start`。

### Capture Identities

没有 capture 时填写 `none`；否则逐行登记：

| captureId | observation | signal_refs |
| --- | --- | --- |
| <填写 before.<stable-name> 或 after.<stable-name>> | <填写该观察点> | <填写 SR-* IDs> |

本模板只记录已确认或待确认的 Behavioral identities；不在 Pack 或执行文件中记录 Command `correlationId`。

## Agent Execution Plan

- plan_summary: <填写 Executor 对执行策略的简要说明；技术值保持原样>
- activation_plan: <说明预期 activation、variant 和 params；技术值保持原样；没有时填写 none>
- trigger_plan: <说明预期 trigger 和 params；技术值保持原样>
- journal_requirement_refs: <填写 JR-* IDs>
- signal_requirement_refs: <填写 SR-* IDs>

## Artifact Refs

| artifact | ref | state |
| --- | --- | --- |
| BDD Evidence | `bdd-evidence.md` | <填写该文件实际 status + completion_state> |
| Code Evidence | `code-evidence.md` | <填写该文件实际 status + completion_state> |
| Journal Expected | `journal-expected.md` | <填写该文件实际 status + completion_state> |
| Signal Expected | `signal-expected.md` | <填写该文件实际 status + completion_state> |
| Human Input Evidence | `human-input-evidence.md` | <填写该文件实际 status + completion_state> |
| Evidence Registry | `evidence-registry.md` | <填写该文件实际 status + completion_state> |
| Execute File | `../execute-file.json` | <填写 ready + complete 或 blocked + blocked> |

`state` 填写该 artifact 的完整 `status + completion_state`，例如 `ready + complete` 或 `blocked + blocked`。

## Ownership

- writer: executor
- bdd_conclusion: not_defined_in_execution_pack
- reuse_key: <填写 bdd_id + target_version>

## Handoff

- pack_id: <填写稳定 pack ID 原始值>
- pack_ref: <填写当前 Pack 目录 ref 原始值>
- bdd_id: <填写唯一 BDD ID 原始值>
- status: <填写 ready、partial 或 blocked>
- blocking_items: <无阻塞项时填写 none；否则说明阻塞事实>
