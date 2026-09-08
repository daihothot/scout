---
scout:
  resource:
    requirement: optional
    description: 目标版本下 Capability 可用性聚合模板。
evidence_id: E-AVAIL-001
evidence_type: availability
status: candidate
---

# E-AVAIL-001

## Artifact State

- status: `<candidate | ready | blocked>`
- blocking_items: `<没有阻塞时写 none>`
- failed_commands: `<没有失败命令时写 none>`
- retry_log: `<没有重试命令时写 none>`

## Availability Claim

- `<目标版本下相关 Capability 的可用性聚合事实>`

## Availability Scope

| field | value |
|---|---|
| product | `<已确认的产品>` |
| target_version | `<当前 Research 目标版本>` |
| capability_refs | `<E-CAP-* 列表>` |

## Version Availability Matrix

| capability_ref | feature | source | locator | status | introduced_version | deprecated_version | removed_version | release_note | limitations |
|---|---|---|---|---|---|---|---|---|---|
| `<E-CAP-*>` | `<功能点>` | `<来源或 none>` | `<定位或 none>` | `<active | deprecated | removed | not_found | not_applicable>` | `<版本或 none>` | `<版本或 none>` | `<版本或 none>` | `<说明或 none>` | `<限制或 none>` |

## Supports

- `<VP-* 或其它下游 claim ref>`

## Limitations

- `<版本适用性限制；没有时写 none>`
