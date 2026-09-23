---
scout:
  resource:
    requirement: optional
    description: 目标平台下 Capability 共享契约与差异模板。
evidence_id: E-PLATFORM-001
evidence_type: platform_knowledge
status: candidate
---

# E-PLATFORM-001

## Artifact State

- status: `<candidate | ready | blocked>`
- blocking_items: `<没有阻塞时写 none>`
- failed_commands: `<没有失败命令时写 none>`
- retry_log: `<没有重试命令时写 none>`

## Platform Claim

- `<目标平台相关的共享契约或差异事实>`

## Platform Scope

| field | value |
|---|---|
| product | `<已确认的产品>` |
| platform | `<当前 Research 目标平台>` |
| capability_refs | `<E-CAP-* 列表>` |

## Platform Evidence Matrix

| capability_ref | source | locator | document_type | shared_contract | difference | status | limitations |
|---|---|---|---|---|---|---|---|
| `<E-CAP-*>` | `<平台知识来源>` | `<定位>` | `<文档类型>` | `<共享契约>` | `<平台差异或 none>` | `<来源状态>` | `<限制或 none>` |

## Supports

- `<VP-* 或其它下游 claim ref>`

## Limitations

- `<平台知识限制；没有时写 none>`
