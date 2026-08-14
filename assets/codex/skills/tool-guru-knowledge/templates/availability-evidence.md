---
scout:
  resource:
    requirement: optional
    description: 仅在目标版本可用性需要聚合时使用的证据模板。
evidence_id: E-AVAIL-001
evidence_type: availability
status: candidate
---

# E-AVAIL-001

## Artifact State

- status: <填写 candidate、ready 或 blocked，并与 frontmatter 保持一致>
- blocking_items: <无阻塞项时填写 none，否则说明阻塞事实>
- failed_commands: <无失败命令时填写 none，否则记录命令及错误摘要>
- retry_log: <无重试时填写 none，否则记录重试命令和结果>

状态枚举：

- status: candidate | ready | blocked

## Claim

- <填写目标版本下所有相关 Capabilities 的版本可用性聚合 claim>

## Availability Scope

- product: <填写经当前证据确认的产品名称>
- target_version: <填写当前 Research 使用的产品版本>
- capability_refs: <填写本证据覆盖的 E-CAP-* 引用>

## Version Availability Matrix

| capability_ref | feature | source | locator | status | introduced_version | deprecated_version | removed_version | release_note | limitations |
|---|---|---|---|---|---|---|---|---|---|
| E-CAP-001 | <填写 Capability 中需要确认版本适用性的功能点> | <填写正式 Availability 来源；不存在时填写 none> | <填写功能点版本表定位；不存在时填写 none> | <填写 active、deprecated、removed、not_found 或 not_applicable> | <填写引入版本；Nice to Have，可不填写> | <填写废弃版本；Nice to Have，可不填写> | <填写移除版本；Nice to Have，可不填写> | <填写 Release Note；Nice to Have，可不填写> | <填写版本适用限制；Nice to Have，可不填写> |

## Supports

- VP-001

## Limitations

- Availability evidence 在整个 Research Pack 中只能有一份；它说明目标版本适用性，不能替代 Capability 规格、当前源码或运行时验证。
