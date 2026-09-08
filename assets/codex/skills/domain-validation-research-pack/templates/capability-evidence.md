---
scout:
  resource:
    requirement: optional
    description: 相关 Capability 的知识事实明细模板。
evidence_id: E-CAP-001
evidence_type: capability
status: candidate
---

# E-CAP-001

## Artifact State

- status: `<candidate | ready | blocked>`
- blocking_items: `<没有阻塞时写 none>`
- failed_commands: `<没有失败命令时写 none>`
- retry_log: `<没有重试时写 none>`

## Capability Identity

| field | value |
|---|---|
| product | `<已确认的产品>` |
| domain | `<已确认的领域>` |
| capability | `<Capability 名称>` |
| capability_id | `<knowledge 中的稳定 id>` |
| source_file | `<knowledge 相对路径>` |
| source_locator | `<标题、段落或表格定位>` |
| relation_to_bdd | `<primary | upstream | downstream | supporting>` |

## Scope Claim

- responsibility: `<职责范围>`
- boundary: `<边界>`
- upstream: `<相关上游；没有时写 none>`
- downstream: `<相关下游；没有时写 none>`

## Specification Coverage Matrix

| dimension | coverage_state | claim | source_refs | gap_or_rationale |
|---|---|---|---|---|
| 系统目标 | `<covered | not_applicable | not_found | needs_confirmation>` | `<事实或 none>` | `<source ref 或 none>` | `<缺口或 none>` |
| 系统边界 | `<covered | not_applicable | not_found | needs_confirmation>` | `<事实或 none>` | `<source ref 或 none>` | `<缺口或 none>` |
| 用户角色 | `<covered | not_applicable | not_found | needs_confirmation>` | `<事实或 none>` | `<source ref 或 none>` | `<缺口或 none>` |
| 核心能力 | `<covered | not_applicable | not_found | needs_confirmation>` | `<事实或 none>` | `<source ref 或 none>` | `<缺口或 none>` |
| 关键流程 | `<covered | not_applicable | not_found | needs_confirmation>` | `<事实或 none>` | `<source ref 或 none>` | `<缺口或 none>` |
| 领域对象 | `<covered | not_applicable | not_found | needs_confirmation>` | `<事实或 none>` | `<source ref 或 none>` | `<缺口或 none>` |
| 状态变化 | `<covered | not_applicable | not_found | needs_confirmation>` | `<事实或 none>` | `<source ref 或 none>` | `<缺口或 none>` |
| 业务规则 | `<covered | not_applicable | not_found | needs_confirmation>` | `<事实或 none>` | `<source ref 或 none>` | `<缺口或 none>` |
| 数据与接口 | `<covered | not_applicable | not_found | needs_confirmation>` | `<事实或 none>` | `<source ref 或 none>` | `<缺口或 none>` |
| 非功能要求 | `<covered | not_applicable | not_found | needs_confirmation>` | `<事实或 none>` | `<source ref 或 none>` | `<缺口或 none>` |
| 验收场景 | `<covered | not_applicable | not_found | needs_confirmation>` | `<事实或 none>` | `<source ref 或 none>` | `<缺口或 none>` |

## Supports

- `<VP-* 或其它下游 claim ref>`

## Limitations

- `<当前知识证据的限制；没有时写 none>`
